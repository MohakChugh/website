---
title: "Aria: Deterministic Database Scheduling and the End of Two-Phase Locking"
date: 2026-07-09
tags: ["deterministic-databases", "concurrency-control", "distributed-transactions", "calvin", "aria"]
excerpt: "How deterministic database scheduling eliminates coordination overhead by pre-ordering transactions before execution, enabling coordination-free distributed commits without two-phase locking or two-phase commit."
---

# Aria: Deterministic Database Scheduling and the End of Two-Phase Locking

Every distributed database faces the same fundamental tension: transactions must appear serializable, but achieving serializability requires coordination, and coordination destroys throughput at scale. Two-phase locking (2PL) blocks readers behind writers. Optimistic concurrency control (OCC) aborts and retries under contention. Two-phase commit (2PC) adds a network round-trip per cross-shard transaction. These coordination mechanisms are the single largest bottleneck in modern distributed OLTP systems.

What if you could eliminate all three?

## The Key Insight: Pre-Ordered Execution

Deterministic database scheduling inverts the traditional approach. Instead of executing transactions first and then determining their serialization order (via locks or validation), you **fix the serialization order before execution begins**. Once the order is determined, every replica can independently execute transactions and arrive at the same final state, no coordination required.

The seminal system is Calvin (Thomson et al., SIGMOD 2012), which introduced a "sequencer" layer that batches incoming transactions into 10ms epochs, assigns a global order, and distributes the ordered log to all replicas. Each replica then executes transactions in that exact order using a deterministic lock manager:

```
Client → Sequencer (batch + order) → Ordered Log → Executor (deterministic)
                                                          ↓
                                               Same state on every replica
```

The catch: Calvin requires **all read/write sets to be declared upfront** before execution. This is a severe restriction, ruling out dependent reads, interactive transactions, and any workload where the write set depends on data read during the transaction.

## Aria: Removing the Upfront Declaration

Aria (Lu et al., VLDB 2020, with follow-up optimizations through 2024) solves Calvin's fundamental limitation. It achieves deterministic execution **without requiring pre-declared read/write sets**, making deterministic scheduling practical for real workloads.

### The Two-Phase Execution Model

Aria operates in batched epochs, like Calvin, but with a radically different execution strategy:

**Phase 1: Speculative Execution (Embarrassingly Parallel)**

All transactions in a batch execute concurrently against a consistent snapshot (the state after the previous batch committed). Each transaction:
1. Reads from the snapshot (never seeing other transactions' writes)
2. Buffers all writes locally in a private write set
3. Records its complete read set

No locks. No coordination. Pure parallel execution.

```rust
struct TransactionState {
    read_set: Vec<(Key, Version)>,
    write_set: HashMap<Key, Value>,
    batch_id: u64,
    txn_index: u32, // position within batch = serialization order
}

fn execute_phase1(txn: &mut Transaction, snapshot: &Snapshot) {
    // All reads go to the batch-start snapshot
    for op in txn.operations() {
        match op {
            Read(key) => {
                let (val, ver) = snapshot.get(key);
                txn.read_set.push((key, ver));
                txn.local_state.insert(key, val);
            }
            Write(key, val) => {
                txn.write_set.insert(key, val);
            }
        }
    }
}
```

**Phase 2: Deterministic Conflict Resolution**

After all transactions complete Phase 1, Aria performs conflict detection. Two transactions conflict if one writes a key that the other reads or writes. The resolution rule is simple and deterministic: **the transaction with the lower batch index (earlier in the pre-determined order) wins**.

```rust
fn resolve_conflicts(batch: &[TransactionState]) -> Vec<bool> {
    let mut committed = vec![true; batch.len()];
    
    // For each key, find the first writer (lowest index)
    let mut first_writer: HashMap<Key, u32> = HashMap::new();
    for txn in batch.iter() {
        for key in txn.write_set.keys() {
            first_writer.entry(*key)
                .and_modify(|existing| *existing = (*existing).min(txn.txn_index))
                .or_insert(txn.txn_index);
        }
    }
    
    // A transaction aborts if it read a key that was written
    // by a lower-indexed transaction in the same batch
    for txn in batch.iter() {
        for (key, _version) in &txn.read_set {
            if let Some(&writer_idx) = first_writer.get(key) {
                if writer_idx < txn.txn_index {
                    committed[txn.txn_index as usize] = false;
                    break;
                }
            }
        }
    }
    
    committed
}
```

This is the critical insight: conflict resolution is a **pure function** of the read/write sets and transaction indices. Every replica computes the same abort/commit decisions independently, no voting protocol needed.

## Why This Eliminates 2PC

In a traditional distributed database, a cross-shard transaction requires 2PC to ensure atomicity: a coordinator collects "prepare" votes from all participants, then broadcasts commit/abort. This adds latency and creates a single point of failure.

In Aria's model, cross-partition transactions are handled identically to single-partition ones. Because the serialization order is fixed before execution, and conflict resolution is deterministic, every node independently arrives at the same commit/abort decision for every transaction. The ordered batch log IS the coordination mechanism.

```
Traditional:  Execute → Lock → Prepare → Vote → Commit (4 network round trips)
Aria:         Batch → Execute-All → Resolve-Locally → Apply (1 round trip for batch distribution)
```

## The Reordering Optimization

Pure Aria has one weakness: high-contention workloads produce many aborts (transactions that read keys written by earlier transactions in the same batch). The 2024 refinements introduce **deterministic reordering**: after Phase 1, instead of simply aborting conflicted transactions, the system reorders them into a dependency-respecting sequence.

If transaction T7 reads key K that T3 writes, T7 is re-executed after T3's writes are applied. This is still deterministic because the reordering algorithm is a fixed function of the conflict graph:

```
Batch: [T1, T2, T3, T4, T5, T6, T7]
Conflicts: T7 reads K, T3 writes K
                                    
Without reordering: T7 aborts, retried in next batch
With reordering: Execute T3 first, apply writes, re-execute T7 with T3's writes visible
```

The reordering transforms the abort rate from O(contention × batch_size) to nearly zero, at the cost of sequential re-execution for conflicting transactions within a batch.

## Performance Characteristics

Benchmarks from the VLDB paper and subsequent evaluations show:

| Workload | Aria vs 2PL Throughput | Aria vs OCC Throughput |
|----------|----------------------|----------------------|
| YCSB (low contention) | 2.4x | 1.8x |
| YCSB (high contention) | 3.1x | 4.2x |
| TPC-C (standard mix) | 1.9x | 2.1x |
| Cross-partition (50%) | 5.7x | 3.8x |

The cross-partition improvement is dramatic because Aria completely eliminates 2PC overhead. Under high contention, OCC suffers cascading aborts while Aria's deterministic resolution handles conflicts in a single pass.

Latency characteristics differ: Aria adds batch-interval latency (typically 5-10ms per epoch), making it unsuitable for single-digit-millisecond SLA workloads. The tradeoff is throughput for tail latency.

## Systems Using Deterministic Scheduling

The deterministic scheduling family now includes:

- **Calvin** (2012): Original sequencer-based approach, requires pre-declared read/write sets
- **BOHM** (2014): Multi-version deterministic with better read-only transaction handling
- **Aria** (2020-2024): No upfront declaration, speculative execution with deterministic abort
- **Epoxy** (2023): Extends deterministic scheduling to heterogeneous data stores
- **FaunaDB/Fauna** (production): Commercial database built on Calvin-style deterministic execution
- **FoundationDB** (production): Uses deterministic simulation with ordered transaction batches

## The Fundamental Tradeoff

Deterministic scheduling trades **latency** for **throughput scalability**. By batching transactions into epochs, you add 5-10ms of latency per batch. In exchange, you get:

1. Zero coordination for cross-shard transactions
2. Free replication (ship the ordered log, replicas execute independently)
3. Trivial recovery (replay the log from any point)
4. Linear throughput scaling with partitions (no 2PC overhead)

For workloads where p99 latency of 20ms is acceptable but throughput of millions of transactions per second is required, deterministic scheduling is the only architecture that scales without fundamental coordination bottlenecks. The question is no longer whether deterministic databases can handle real workloads, but rather which workloads still justify the complexity of non-deterministic alternatives.
