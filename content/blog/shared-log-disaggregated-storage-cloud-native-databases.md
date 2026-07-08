---
title: "Shared Log Architecture: How Cloud-Native Databases Disaggregate Storage from Compute"
date: 2026-07-09
tags: ["distributed-systems", "databases", "cloud-architecture", "consensus", "storage-disaggregation"]
excerpt: "The shared log pattern decouples compute from storage by treating a replicated, append-only log as the single source of truth. This deep dive explores how systems like Aurora DSQL, Neon, and FoundationDB leverage this architecture to achieve independent scaling, instant recovery, and strong consistency without distributed two-phase commit."
---

# Shared Log Architecture: How Cloud-Native Databases Disaggregate Storage from Compute

The monolithic database is dead in the cloud. Modern cloud-native databases — Aurora DSQL, Neon, CockroachDB's replication layer, FoundationDB — share a radical architectural insight: **the log is the database**. By disaggregating a durable, replicated append-only log from the compute nodes that interpret it, these systems achieve independent scaling, sub-second failover, and strong consistency without the coordination overhead of traditional distributed commits.

## The Core Insight: Log as the Ground Truth

Pat Helland's 2015 paper "Immutability Changes Everything" crystallized what systems builders were already discovering: if you make the log the authoritative record, everything else becomes a materialized view. The shared log architecture takes this literally.

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  Compute 1   │   │  Compute 2   │   │  Compute 3   │
│  (read/write)│   │  (read-only) │   │  (read/write)│
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │                   │                   │
       ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────┐
│              Shared Log Service                      │
│  (replicated, linearizable, append-only)            │
└─────────────────────────────────────────────────────┘
       │                   │                   │
       ▼                   ▼                   ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  Page Store  │   │  Page Store  │   │  Page Store  │
│  (LSN-indexed)│  │  (LSN-indexed)│  │  (LSN-indexed)│
└──────────────┘   └──────────────┘   └──────────────┘
```

The architecture has three layers: compute nodes that execute queries and generate log records, a shared log service that durably sequences these records with consensus, and page stores that materialize the log into indexed pages on demand.

## Why Not Just Replicate the Whole Database?

Traditional primary-replica replication ships the WAL from a single writer to followers. This has three fundamental limitations:

1. **Failover requires replay.** The new primary must apply un-materialized log records before accepting writes. Aurora's original design reduced this from minutes to seconds, but it is still non-zero.

2. **Write scalability is vertical.** A single writer must sequence all transactions, becoming the bottleneck.

3. **Storage is coupled to compute.** Each replica maintains a full copy of the data, wasting resources when read and write demands diverge.

The shared log architecture addresses all three. Because the log service is the source of truth (not any individual node's local state), any compute node can become a writer by appending to the log. Failover is instant because there is no local state to recover — the new node simply resumes reading from the last consumed log position.

## The Log Service: Consensus Without Coordination

The shared log service must provide three guarantees: **durability** (acknowledged writes survive failures), **total order** (all consumers see the same sequence), and **high throughput** (millions of appends per second).

Modern implementations achieve this through a variant of Multi-Paxos or Raft optimized for append-only workloads. The key optimization is **batching and pipelining**: rather than running a full consensus round per record, the log service batches hundreds of records into a single proposal.

```rust
// Simplified log service append path
struct LogBatch {
    records: Vec<LogRecord>,
    term: u64,
    prev_lsn: LSN,
}

impl LogService {
    async fn append(&self, batch: LogBatch) -> Result<LSN, Error> {
        // Phase 1: Leader assigns LSN range
        let base_lsn = self.next_lsn.fetch_add(
            batch.records.len() as u64, Ordering::SeqCst
        );

        // Phase 2: Replicate to f+1 of 2f+1 nodes
        let ack_count = self.replicate_parallel(&batch, base_lsn).await?;

        if ack_count >= self.quorum_size() {
            // Phase 3: Advance commit LSN (visible to consumers)
            self.commit_lsn.store(
                base_lsn + batch.records.len() as u64 - 1,
                Ordering::Release,
            );
            Ok(base_lsn)
        } else {
            Err(Error::QuorumNotReached)
        }
    }
}
```

The critical performance trick: the leader does not wait for disk fsync on the majority before acknowledging. Instead, it uses **cross-node durability** — if the record is in memory on three nodes, the probability of simultaneous failure is negligible for most SLAs. Systems requiring stronger guarantees (financial transactions) add a synchronous fsync option at the cost of latency.

## Page Stores: Log-Structured Merge on Demand

Page stores consume the log and materialize it into B-tree or LSM pages indexed by Log Sequence Number (LSN). This is where the "log is the database" insight becomes concrete:

```
Page Store internal structure:
┌─────────────────────────────────────────┐
│  Base Page (LSN 0-1000)                 │
│  + Delta Chain: [LSN 1001, 1042, 1099]  │
│  = Materialized Page @ LSN 1099         │
└─────────────────────────────────────────┘
```

When a compute node requests a page at a specific LSN, the page store applies the delta chain up to that LSN. This enables **time-travel queries** trivially — reading at an older LSN returns the page as it existed at that point.

The page store periodically **coalesces** delta chains into new base pages (similar to LSM compaction). The critical insight from the Neon architecture (2024 VLDB paper "Neon: Serverless PostgreSQL") is that coalescing is decoupled from the serving path — it runs as a background job, never blocking reads.

## Multi-Writer Coordination: The Sequencer Pattern

Single-writer systems are simple but limit write throughput to one machine. Multi-writer shared-log systems use a **sequencer** pattern:

1. Compute nodes generate **tentative log records** with provisional timestamps.
2. The sequencer (embedded in the log service leader) assigns a final total order.
3. Compute nodes detect conflicts post-sequencing using optimistic concurrency control.

```
Writer A: INSERT INTO orders (id=1, total=100)  → LSN 5001
Writer B: UPDATE orders SET total=200 WHERE id=1 → LSN 5002

Conflict detection at LSN 5002:
  - Read-set of B includes orders.id=1 at LSN < 5001
  - Write at LSN 5001 invalidates B's read
  - B aborts and retries with fresh read at LSN 5001
```

This is essentially **serializable snapshot isolation** (SSI) implemented over a shared log. The 2024 paper "Is the Log the Database?" (Stoica et al.) proved that this approach achieves equivalent throughput to traditional 2PL for OLTP workloads with skew < 5%, while providing dramatically better tail latency because lock waits are eliminated.

## Instant Recovery and Elastic Scaling

The most operationally significant benefit of shared-log architecture is recovery time. In a traditional database:

```
Crash → Replay WAL from checkpoint → Rebuild in-memory state → Accept traffic
         (seconds to minutes)
```

In a shared-log database:

```
Crash → Start new compute node → Read from committed LSN → Accept traffic
         (sub-second: no local state to recover)
```

The new compute node has no local state to rebuild. It reads pages from the page store (which is already materialized up to the commit LSN) and resumes consuming the log. This enables **serverless scaling** — spinning compute up and down based on query load without data movement.

## The Cost: Tail Latency and Network Amplification

This architecture is not free. Every write requires:
1. Network hop to the log service (adds ~0.5ms intra-AZ, ~2ms cross-AZ)
2. Consensus replication (parallel, but adds P99 variance)
3. Acknowledgment back to compute

For latency-sensitive OLTP (sub-millisecond requirement), this overhead matters. The mitigation is **log-local caching** at the compute layer — recent log records are buffered locally and served from memory. The invariant is that the cached records are always a prefix of the committed log, so consistency is preserved.

Network amplification is also significant: a 100-byte write generates ~300 bytes of network traffic (record + metadata replicated 3x). At millions of writes per second, this saturates network links before CPU or disk become bottlenecks. Modern deployments use RDMA or DPDK to push network throughput beyond 100 Gbps per node.

## Production Systems Using This Pattern

| System | Log Implementation | Notable Design Choice |
|--------|-------------------|----------------------|
| Aurora DSQL | Custom Paxos-based | Cross-region log for global transactions |
| Neon | Custom WAL service (Safekeeper) | On-demand page reconstruction from S3 |
| FoundationDB | Paxos log + resolver | Deterministic simulation testing |
| Taurus (Huawei) | Shared log over RDMA | Sub-100μs write latency |
| Socrates (Microsoft) | XLOG service | Decoupled from SQL Server compute |

## When to Use (and When Not To)

The shared-log architecture excels when:
- Read/write ratios are highly variable (serverless workloads)
- Fast failover is non-negotiable (five-nines SLA)
- Multi-region consistency is required
- Storage and compute need independent scaling

It is a poor fit when:
- Ultra-low latency (< 1ms P99) is the primary requirement
- Workloads are write-heavy with high contention (> 10% conflict rate)
- Network bandwidth is constrained or expensive

The shared log is not a silver bullet, but it is the dominant architecture for the next generation of cloud databases. Understanding its trade-offs — the serialization bottleneck at the sequencer, the network amplification, the tail latency from consensus — is essential for anyone building or operating data-intensive systems at scale.
