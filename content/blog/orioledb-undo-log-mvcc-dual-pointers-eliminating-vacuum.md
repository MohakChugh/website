---
title: "OrioleDB: Undo-Log MVCC, Dual Pointers, and the End of VACUUM"
date: 2026-09-27
tags: ["postgresql", "mvcc", "storage-engines", "btree", "databases"]
excerpt: "OrioleDB is a PostgreSQL storage engine (now in public beta) that replaces the heap with index-organized B+-trees and rebuilds the three mechanisms everyone complains about: MVCC keeps old versions in an undo log instead of bloating the table, in-memory pages point directly at children so there's no buffer mapping table to serialize on, and WAL is logical row-level records that can be applied in parallel. On a bloat-inducing upsert benchmark the result is 5x the TPS at 22x fewer IOPS per transaction — but the trade-offs (no persistent rightlinks, fuzzy copy-on-write checkpoints, a patched Postgres) are just as instructive as the wins."
---

# OrioleDB: Undo-Log MVCC, Dual Pointers, and the End of VACUUM

PostgreSQL's storage layer carries three well-known taxes. MVCC keeps dead row versions inside the table itself, so every update is physically an insert and VACUUM must come along later to reclaim the garbage. Every page access goes through a shared buffer mapping table — a hash from `(relation, block)` to buffer slot — that becomes an atomic-operation hotspot on many-core machines. And WAL is block-level and physical, which makes replay strictly sequential.

OrioleDB, an open-source storage engine that plugs into PostgreSQL's table access method API (`CREATE TABLE ... USING orioledb`), rebuilds all three at once. It reached public beta on PostgreSQL 16 and 17, and its design reads like a checklist of what you'd do differently if you could redesign the bottom half of Postgres in the SSD era. The headline benchmark — a bloat-inducing upsert workload at 100 connections on a 72-vCPU box — shows 5x the transactions per second of heap storage, at 2.3x less CPU and 22x fewer IOPS per transaction. The mechanisms behind those numbers are worth pulling apart.

## Index-organized tables: the primary key *is* the table

OrioleDB has no heap. Rows live in the leaf pages of the primary key B+-tree, and secondary indexes store `(secondary key, primary key)` pairs — logical values, not physical pointers. If a table has no primary key, the engine synthesizes one on a virtual `ctid` column.

This is the classic index-organized layout (InnoDB does the same), and it has a second-order effect on write amplification. In heap Postgres, an update that touches any indexed column disables HOT (heap-only tuples), and *every* index on the table gets a new entry pointing at the new heap tuple. In OrioleDB, only the index whose key actually changed is touched, because nothing references a physical row location that just moved.

## Undo-log MVCC: versions leave the table instead of accumulating in it

Instead of leaving old versions in place, OrioleDB keeps the newest version on the data page and pushes older ones into an undo log, linked as a version chain:

```
data page:   [row v3] ──► undo: [v2 header+body] ──► [v1 header+body]
```

Update records carry a header plus the old row body; deletes and row locks need only headers. Undo records are also chained per-transaction, which is what makes `ROLLBACK` cheap to reason about: abort replays the transaction's chain backwards. `ROLLBACK TO SAVEPOINT` replays undo to a point, and special *branch* records let crash recovery walk chains that were already partially replayed.

Undo operates at two granularities. Row-level undo enables in-place updates. Block-level undo lets the engine evict tuples that are deleted-but-still-visible out of primary storage entirely — there are three page-image record types (compact: one page to one undo image; split: two to one; merge: one to two). Combined with background page merging, which consolidates sparse pages after heavy deletes, this is what actually eliminates VACUUM rather than just deferring it: garbage never accumulates in the tree, so there's nothing to scan for later. Transaction IDs are 64-bit, so wraparound — the other reason autovacuum must run — disappears too. Crucially, undo stays in shared memory and is written to disk only at checkpoint or on memory pressure; short transactions never pay disk I/O for their version chains.

## Dual pointers: deleting the buffer mapping table

The buffer mapping table exists because heap Postgres pages reference each other by block number, so every traversal must translate block number → buffer. OrioleDB's non-leaf pages instead hold *dual pointers*: a downlink is either a direct in-memory pointer to the child page or a reference to its on-disk location. Following a disk downlink loads the page and swaps the downlink to the in-memory form. Tree descent touches no shared hash table and, on the read path, no atomics for pinning.

Page-level concurrency is a single `state` word per page combining an exclusive lock, an upgradeable read-blocking flag, and a change counter. Readers don't lock at all — they do an optimistic copy and validate the counter:

```c
/* optimistic partial read, simplified */
do {
    s1 = atomic_read(&page->state);
    copy_high_keys_and_chunk(page, target_key, &local);   /* only the needed chunk */
    s2 = atomic_read(&page->state);
} while (changed(s1, s2));   /* writer intervened: retry */
```

Tuples are grouped into chunks with per-chunk high keys, so a reader copies only the high-key area plus one chunk, not the whole 8KB page.

The price of dual pointers is that persistent *rightlinks* — the sibling pointers that Lehman-Yao B-link trees use to survive concurrent splits — are gone. Rightlinks exist only transiently between a split and the parent downlink insertion. A traversal that races a split retries from the parent, and lateral stepping (e.g., range scans crossing page boundaries) goes through the parent rather than a sibling pointer. That's a deliberate bet: retries are rare, and removing the mapping table wins on every access.

## Row-level WAL and parallel replay

OrioleDB's WAL contains logical records — insert/update/delete with row images, transaction begin/commit — rather than physical page deltas. Two consequences:

1. **Less WAL volume.** A one-column update logs a row-level record, not full-page writes and block images. On the upsert benchmark this is a large share of the 22x IOPS reduction.
2. **Parallel recovery.** Physical WAL must apply sequentially because records target overlapping pages. Logical records can be partitioned: each of `orioledb.recovery_pool_size` workers owns a hash partition of primary-key space, and a transaction becomes visible only when every worker has finished its part.

Only the primary key tree and TOAST trees are logged at all. Secondary indexes are reconstructed during replay from primary-key changes, relying on idempotent application — necessary because checkpoints are fuzzy, so a secondary index on disk may already be *newer* than the primary tree image being recovered.

## Copy-on-write checkpoints

Checkpoints never overwrite pages. Modified pages are written to free space, parents are rewritten to point at the new locations, and old images are freed only after the checkpoint completes — so a structurally consistent tree image exists on disk at every instant, which is also what makes the S3-backed decoupled storage mode possible. Checkpointing runs concurrently with writes (fuzzy), and non-leaf pages may be reconstructed from children on the fly, meaning the checkpointer can write page images that never existed in RAM. Free space becomes a real problem at this point — consecutive checkpoints share most of their blocks — so the engine tracks extents in two system B-trees, one sorted by offset (for coalescing adjacent free extents) and one by `(length, offset)` (for best-fit allocation). The same machinery gives block-level `zstd` compression for free: compressed pages are variable-length, and the extent trees don't care.

## The catch

You don't get any of this by installing an extension into stock Postgres. OrioleDB requires a patched PostgreSQL — the table access method API, even in PG17, doesn't expose enough hooks for a custom MVCC implementation, undo, or WAL, so the project pins exact patched commits of PG16/17. It's explicitly beta: recommended for benchmarking, not production. And the benchmark that produces "5x" is chosen to maximize heap pain — random upserts with a sparsely-updated timestamp index, the exact pattern where HOT breaks down and autovacuum can't keep up. Read-heavy workloads with well-behaved HOT updates will see far less.

Still, the design matters beyond this one project. The undo-log-plus-page-merge combination is an existence proof that Postgres-compatible MVCC doesn't need VACUUM, and the dual-pointer trick — spending sibling links to buy back the buffer mapping table — is one of the cleaner examples of trading a rarely-used invariant for a hot-path win. Watch which of these patches make it upstream.
