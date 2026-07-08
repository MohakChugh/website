---
title: "MVCC Garbage Collection: Why Long Transactions Kill Throughput and How Modern Engines Fight Back"
date: 2026-07-08
tags: [databases, mvcc, garbage-collection, concurrency, oltp]
excerpt: "Multi-version concurrency control trades write amplification for read isolation, but version chain bloat from deferred garbage collection silently degrades scan performance by 10-100x. This post dissects the GC problem, examines PostgreSQL's vacuum pathology, and explores the epoch-based truncation and steam-cleaning techniques from LeanStore and Umbra that achieve O(1) amortized cleanup."
---

# MVCC Garbage Collection: Why Long Transactions Kill Throughput and How Modern Engines Fight Back

Every serious OLTP database ships with multi-version concurrency control. The pitch is simple: readers never block writers, writers never block readers. Each transaction sees a consistent snapshot without acquiring shared locks. The cost? Every update creates a new version of the tuple, and *something* must eventually reclaim the old ones. That something — garbage collection of dead versions — is the single largest source of unpredictable performance degradation in production MVCC systems.

This post dissects why MVCC garbage collection is fundamentally hard, examines the pathological failure mode that plagues PostgreSQL at scale, and explores the epoch-based truncation and cooperative steam-cleaning approaches from recent database research (LeanStore, Umbra, and the 2024 VLDB paper "Scalable and Robust Garbage Collection for Main-Memory MVCC") that achieve amortized O(1) reclamation without stop-the-world pauses.

## The Version Chain Problem

In an MVCC system, a logical tuple exists as a chain of physical versions:

```
Tuple "user_42":
  v3 (xid=500, active)   ← current
  v2 (xid=300, committed) ← visible to snapshots [300..499]
  v1 (xid=100, committed) ← visible to snapshots [100..299]
  v0 (xid=50,  committed) ← visible to snapshots [50..99]
```

A version `vi` is *garbage* when no active transaction can ever need it — meaning no running snapshot has a start timestamp in the range where `vi` was the visible version. The minimum active snapshot timestamp across all transactions is called the **low-water mark** (LWM). Any version invisible to the LWM snapshot (superseded before the LWM) is reclaimable.

The problem: a single long-running analytical query with start timestamp 100 pins the LWM at 100, preventing reclamation of *every* version created after timestamp 100 — even if 99.99% of transactions are short OLTP operations that committed milliseconds ago.

## PostgreSQL's Vacuum: A Cautionary Tale

PostgreSQL stores old versions in-place (heap-only tuples with visibility metadata). Dead tuples accumulate until VACUUM runs — an asynchronous background process that:

1. Scans all pages of a table
2. Identifies tuples invisible to all running snapshots
3. Marks those tuple slots as reusable
4. Updates the visibility map and free space map

The pathology is well-documented. A single `pg_dump`, a forgotten `IDLE IN TRANSACTION` connection, or a long-running reporting query holds the LWM back. VACUUM runs but cannot reclaim anything. The table bloats. Sequential scans slow down because they traverse dead tuples. Index bloat follows. The system enters a degradation spiral where even after the long transaction completes, VACUUM must scan gigabytes of accumulated garbage.

```sql
-- This single query pins the LWM for its entire duration
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SELECT * FROM large_table WHERE complex_predicate; -- runs 30 minutes
-- Every VACUUM during those 30 minutes is effectively a no-op
```

The `old_snapshot_threshold` parameter (PostgreSQL 9.6+) can force-expire ancient snapshots, but it causes snapshot-too-old errors for the long transaction — trading correctness for recoverability.

## Approach 1: Epoch-Based Truncation (LeanStore)

LeanStore (TUM, 2018-2024) uses an approach borrowed from concurrent memory reclamation. The system maintains a global epoch counter incremented periodically (e.g., every 10ms). Each transaction records its start epoch. The GC only needs to track the *minimum active epoch* — versions from epochs before this minimum are safe to reclaim.

The key insight: instead of scanning version chains looking for garbage, the system maintains **epoch-indexed garbage queues**. When a transaction creates a new version, it pushes the old version's pointer onto the garbage queue tagged with the current epoch. Reclamation becomes:

```cpp
// Simplified epoch-based GC
void gc_thread() {
    uint64_t safe_epoch = compute_min_active_epoch();
    while (!garbage_queue.empty() && 
           garbage_queue.front().epoch < safe_epoch) {
        VersionPtr old = garbage_queue.pop_front();
        deallocate(old);  // O(1) per version
    }
}
```

This is O(1) amortized per reclaimed version — no scanning of live data. The garbage queues are per-worker-thread to avoid contention. Each worker maintains a thread-local garbage buffer; when the buffer fills or the epoch advances, it is batch-appended to a shared reclamation list.

**The catch:** the LWM problem persists. A long transaction still pins the safe epoch, and garbage queues grow unboundedly until it commits. LeanStore addresses this with *cooperative throttling*: if garbage queues exceed a threshold, new short transactions are briefly delayed (backpressure) to signal the system is overloaded.

## Approach 2: Steam Cleaning (Umbra / TUM 2024)

The 2024 VLDB paper from Umbra introduces **steam cleaning** — a technique that decouples version visibility from version storage location. The core idea:

1. **Inline short chains:** For tuples with ≤ 2 old versions, store the version chain directly in the tuple's storage slot (avoiding pointer chasing).
2. **Overflow to cold storage:** Longer chains spill to a separate "version buffer" — a log-structured append-only region.
3. **Cooperative truncation:** Every transaction, upon commit, truncates version chains it touched if it can prove no active snapshot needs the old versions. This distributes GC work across all transactions proportional to their write set.

```
Before cooperative truncation:
  [v5] → [v4] → [v3] → [v2] → [v1]
  LWM = 450 (v4 created at ts=400, v5 at ts=500)
  
After (v1, v2, v3 are below LWM):
  [v5] → [v4] → ∅
  v1, v2, v3 freed immediately
```

The critical optimization: **speculative truncation**. When a committing transaction observes that the LWM is within 1 epoch of the current timestamp (meaning all active transactions are recent), it speculatively truncates chains to length 1 — betting that by the time anyone reads this tuple again, no snapshot will need the intermediate versions. If the speculation is wrong (a new transaction starts with an old snapshot), the system falls back to the undo log for reconstruction.

Benchmarks from the paper show steam cleaning achieving 95% of peak throughput under mixed OLTP/analytics workloads where traditional approaches degrade to 30-40%.

## Approach 3: Hybrid GC with Interval Tracking

A third approach, explored in the "Scalable GC for Main-Memory MVCC" paper (VLDB 2024), replaces the single scalar LWM with an **interval set** tracking exactly which timestamp ranges have active readers:

```
Active snapshots: {ts=100, ts=450, ts=480, ts=495}
Interval set: [100,100] ∪ [450,495]
Reclaimable: any version superseded before ts=100,
             AND versions superseded in (100, 450) — the gap!
```

This allows reclaiming versions in timestamp "gaps" between active snapshots. A long-running transaction at ts=100 only pins versions visible at exactly ts=100 — the vast majority of versions created between ts=101 and ts=449 are still reclaimable by short transactions.

The interval set is maintained as a concurrent skip list, updated on transaction begin/commit. The overhead is log(n) per transaction start and commit (where n is the number of concurrent transactions), but the reclamation improvement is dramatic for the mixed workload case.

## Practical Implications

| System | GC Strategy | Long-Txn Tolerance |
|--------|-------------|-------------------|
| PostgreSQL | Background VACUUM | Poor — full table bloat |
| MySQL/InnoDB | Purge thread + undo logs | Moderate — undo log growth |
| Oracle | Undo tablespace | Moderate — ORA-01555 errors |
| LeanStore | Epoch queues + backpressure | Good — bounded queue growth |
| Umbra | Steam cleaning + speculation | Excellent — distributed truncation |

For practitioners building on existing systems, the key takeaways are:

1. **Monitor your LWM obsessively.** In PostgreSQL, track `xmin` horizon via `pg_stat_activity`. In MySQL, watch `trx_oldest_active` from `INFORMATION_SCHEMA.INNODB_TRX`. A LWM that drifts more than a few seconds behind the current timestamp is a ticking bomb.

2. **Separate OLTP and analytics at the snapshot level.** Use logical replication, read replicas, or snapshot export rather than running analytical queries on the primary with a long-held snapshot.

3. **Bound transaction duration architecturally.** Set `idle_in_transaction_session_timeout` in PostgreSQL. Use `innodb_rollback_on_timeout` in MySQL. Design application connection pools to abort connections holding transactions beyond a threshold.

## Conclusion

MVCC garbage collection is a systems design problem masquerading as a data structure problem. The version chain itself is trivial — the hard part is coordinating reclamation across thousands of concurrent transactions with minimal synchronization overhead. The trajectory from PostgreSQL's batch-scan VACUUM through epoch-based queuing to cooperative steam cleaning shows a clear progression: move GC work from dedicated background threads into the transaction commit path itself, amortize it across all participants, and use fine-grained interval tracking instead of a single scalar watermark. The next generation of OLTP engines will make the "long transaction kills the database" failure mode a relic of the past.
