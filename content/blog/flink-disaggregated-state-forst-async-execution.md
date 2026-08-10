---
title: "Disaggregated State in Flink 2.0: Making 23ms Object Storage Behave Like a 68µs Disk"
date: 2026-08-10
tags: ["stream-processing", "distributed-systems", "state-management", "storage", "lsm-trees"]
excerpt: "Streaming engines have kept state on local disk because remote storage is two orders of magnitude slower. Flink 2.0 moves state to DFS anyway, and the trick that makes it work is not caching, it is Little's Law."
---

Every production stream processor has the same architectural bruise. State lives in an embedded key-value store on local disk, which means the unit you scale for compute is also the unit you scale for capacity. Need to retain 60 days of join state? You are now paying for cores you do not use, because the only way to buy more disk is to buy more workers.

The VLDB 2025 paper *Disaggregated State Management in Apache Flink 2.0* (Mei et al., PVLDB 18(12):4846-4859) reports the shape of that bruise from a real deployment: across several hundred logistics jobs, **35% were disk-bound** rather than CPU-bound, hitting a provisioning threshold of roughly 20 GB of state per core. The obvious fix, moving state to DFS or object storage, has been dismissed for years for an equally obvious reason. Here are the measured single-access latencies from the paper:

| Medium | Latency |
|---|---|
| Local NVMe SSD | 68 µs |
| Cloud block store (ESSD PL1) | 199 µs |
| HDFS on NVMe | 1.5 ms |
| Object storage (OSS/S3-class) | 23 ms |

Object storage is **338× slower** than local NVMe. Naively swapping the storage layer under a synchronous state API would be a throughput apocalypse. Flink 2.0 does the swap anyway, and the interesting part is that the fix is not a cache.

## The argument the paper doesn't write down

Put Little's Law on it. Sustainable throughput is concurrency divided by latency. A synchronous state access blocks the task thread, so concurrency is pinned at 1:

```
sync + local NVMe :  1 / 68µs   ≈  14,700 state ops/sec/task
sync + object store: 1 / 23ms   ≈       43 state ops/sec/task
```

Forty-three operations per second. That is the real reason nobody did this. But latency is only half the equation, and it is the half that storage vendors control. Concurrency is the half *we* control. Flink 2.0's Asynchronous Execution Controller (AEC) allows a default of 6000 in-flight state requests per task:

```
async + object store: 6000 / 23ms ≈ 261,000 state ops/sec/task
```

That is 17× *more* throughput than a synchronous local-NVMe engine, over storage that is 338× slower per access. The entire design follows from this: if you can hold enough requests in flight, per-access latency stops being the binding constraint and aggregate bandwidth takes over. Disaggregation is not a caching problem, it is a concurrency problem, and the API was the thing standing in the way.

## Splitting the record lifecycle

Flink 2.0 adds a parallel state API (`org.apache.flink.api.common.state.v2`) where every access returns a `StateFuture` instead of a value. Processing one record now decomposes into three parts: stateless transformation on the task thread, state access on a pool of I/O threads, and post-state continuations back on the task thread.

```java
// enable async state on the keyed stream first:
//   stream.keyBy(Event::getOrderId).enableAsyncState()

public void processElement(Order order, Collector<Enriched> out) {
    // Independent accesses issue concurrently — no dependency, no chaining.
    StateFuture<Void> w = orderState.asyncUpdate(order);
    StateFuture<StateIterator<Shipment>> r = shipmentState.asyncGet();

    // Dependent work is chained; the continuation runs on the task thread.
    r.thenAccept(shipments ->
        shipments.onNext(s -> out.collect(join(order, s))));
}
```

There is deliberately no blocking `get()` on `StateFuture` — the docs note it would risk recursive blocking of the very thread that must drain callbacks. You get `thenApply`, `thenAccept`, `thenCompose`, `thenCombine`, and conditional variants. This is the same continuation-passing bargain as async I/O anywhere else, and it buys concurrency at the cost of three correctness properties that a synchronous engine gets for free.

**Per-key ordering.** Records for the same key must observe each other's writes in arrival order. The AEC's Key Accounting Unit enforces exactly one in-flight computation per key per task; a second record for an occupied key parks in a blocking buffer until its predecessor's continuations complete. Different keys proceed freely, which is where the concurrency comes from — the guarantee is per-key serialization, not global.

**Exactly-once checkpoints.** A checkpoint barrier is a snapshot of a consistent prefix of the stream, but now there are thousands of half-finished records straddling that prefix. Flink 2.0 handles it by *draining*: on receiving a barrier, the operator stops admitting new records and lets in-flight callbacks complete before snapshotting. Cheap, because in-flight state is bounded by the 6000-record cap — a few MB per operator — not by state size.

**Watermark completeness.** This is the subtle one. A watermark asserts "no earlier event time will arrive," which is only true if every earlier record has finished. Out-of-order completion breaks that. The Epoch Manager groups records into event-time epochs (`OPEN` → `CLOSED` → `FINISHED`) and holds them in a queue: an epoch spanning `[30,40]` cannot release its watermark while a preceding `[20,30]` still has pending records, even if `[30,40]` finished first. Reordering is permitted; *observable* reordering across a watermark is not.

## ForSt and the hard-link trick

The state backend, ForSt ("For Streaming"), is an LSM tree that treats DFS as primary storage and local disk/memory as secondary cache. The genuinely clever piece is the Unified File System layer, which papers over the fact that POSIX, HDFS, and eventually-consistent object stores disagree about what a file even is — most notably by emulating hard links with reference counting.

That emulation is what collapses checkpointing. In Flink 1.x, an incremental checkpoint uploads new SST files to remote storage; the paper measured an average incremental size of **1.89 GB**. In Flink 2.0, the SST files are *already* in remote storage, so a checkpoint is a metadata operation: bump refcounts on the live file set and write a manifest. Restore inverts it — no bulk download, just pointer installation. The measured consequence over 300 checkpoints in 5 hours:

- Flink 2.0: **every checkpoint ≤3 s** on HDFS (≤4 s on object storage)
- Flink 1.20: **>19.7% exceeded 30 s**, >1.5% exceeded 50 s

The abstract's "up to 94% reduction" reproduces exactly as `1 − 3/50`, so note what it is measured against: the *tail*, not the mean. The tail is the honest comparison for an operator, since checkpoint duration is what bounds recovery lag, but it is worth knowing which end of the distribution a headline number came from.

Recovery improves for the same reason — 16× faster failure recovery, 12× faster scale-in, and 49× faster scale-out on 290 GB of state. The asymmetry is arithmetic, not magic: scaling 16→32 means every child task pulls its parent's full state, so 1.x moves ~2× the bytes on scale-out that it does on scale-in, and 2.0 moves none of them.

## What it costs

Two prices, both real.

**CPU.** Asynchronous execution adds roughly **30% CPU on stateful operators** — context switching (~30% of the delta), AEC scheduling (~20%), I/O batching (~20%), and garbage collection of `Future` objects (~30%). That last item is a reminder that continuation-passing in a JVM is not free.

**Cache sensitivity.** On Nexmark, ForSt-on-local-disk is a drop-in match for RocksDB, but with state on HDFS and *no* cache, the I/O-heavy queries lose 48% on average. Add a 1 GB disk cache and the suite lands ~4% *above* the local baseline. That inversion deserves scrutiny, because the five heavy queries all have state larger than the cache (1.05 GB to 4.48 GB), so the cache cannot be doing the work through hit rate alone — and indeed among those five, async alone is ~2× over synchronous HDFS and async-plus-cache reaches 3.7×, which still lands slightly *below* their local baseline. The +4% average is a suite-wide figure carried by light-I/O queries. Concurrency does the heavy lifting; the cache trims the tail.

The economics is what actually settles it. The logistics job needed 16 compute units on Flink 1.20 (~$688/month) purely to get enough attached disk for 290 GB. On Flink 2.0 it runs on 8 (~$344/month), with state on DFS priced separately and far cheaper. Note that 290 GB ÷ 20 GB-per-unit is 15, so the disk bound alone nearly dictated that 16 — the cores were an accident of provisioning for capacity. Decoupling them is the whole point.

Two operational caveats: state is **not** compatible between Flink 1.x and 2.x, so this is a migration and not an upgrade; and async state is opt-in per keyed stream (`enableAsyncState()`, or `table.exec.async-state.enabled` for SQL, where seven stateful operators have been rewritten on the new APIs). Mixing synchronous and asynchronous access in one function is explicitly discouraged.

The broader lesson generalizes past Flink. Systems folklore says remote storage is too slow for the critical path, and MillWheel's synchronous remote state largely confirmed it. But "too slow" conflated latency with throughput. Once the programming model admits enough concurrency, a 23 ms medium can sustain a quarter-million operations per second per task — and the constraint that shaped a decade of streaming architecture turns out to have been the API, not the disk.
