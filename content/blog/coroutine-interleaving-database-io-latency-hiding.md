---
title: "Coroutine Interleaving: How Database Engines Use Stackless Coroutines to Hide Storage Latency"
date: 2026-07-09
tags: ["coroutines", "databases", "io-latency", "query-execution", "buffer-management"]
excerpt: "Modern analytical databases lose 40-60% of query time waiting on storage I/O. Coroutine interleaving transforms synchronous buffer pool accesses into cooperative multitasking, letting the CPU process other tuples while pages load from SSD. We explore the LeanStore and Umbra approaches, C++20 coroutine mechanics, and why this outperforms both blocking I/O and pure async callback models."
---

# Coroutine Interleaving: How Database Engines Use Stackless Coroutines to Hide Storage Latency

Traditional query engines follow a simple model: for each tuple, walk the operator tree, access the required pages from the buffer pool, and proceed. When a page isn't resident in memory, the thread blocks on I/O. In an SSD-backed analytical database processing a hash join probe where the hash table exceeds DRAM, this blocking pattern is catastrophic. The CPU stalls for 10-100 microseconds per page fault while the SSD's queue depth stays at 1.

The insight behind coroutine interleaving is deceptively simple: instead of blocking a thread when a page is missing, **suspend the current tuple's coroutine and switch to processing the next tuple**. By the time we cycle back, the page has likely arrived. This transforms a latency-bound workload into a throughput-bound one without callbacks, thread pools, or io_uring complexity.

## The Problem: Buffer Pool Misses Kill Throughput

Consider a hash join where the probe side scans a large table and looks up keys in a hash table that doesn't fit in the buffer pool. Each probe does:

```cpp
// Traditional blocking access
void probe(uint64_t key) {
    Page* page = buffer_pool.fix(hash(key));  // May block 10-100us on SSD
    Slot* slot = page->lookup(key);
    emit(slot->payload);
    buffer_pool.unfix(page);
}
```

If 20% of accesses miss the buffer pool and each miss costs 50 microseconds on NVMe, the effective throughput drops to ~200K tuples/second per thread regardless of CPU speed. The SSD can serve 500K+ random 4KB reads per second at full queue depth, but our single-threaded sequential access pattern only achieves queue depth 1.

## Coroutine Interleaving: The Core Mechanism

The fundamental transformation replaces each blocking `fix()` call with a coroutine suspension point. A **driver loop** maintains a batch of in-flight coroutines and round-robins between them:

```cpp
// Coroutine-based page access
task<void> probe_coro(uint64_t key, BufferPool& bp) {
    PageRef ref = bp.start_fix(hash(key));
    if (!ref.is_resident()) {
        bp.submit_io(ref);       // Submit async read to SSD
        co_await suspend{};       // Yield to driver, come back when page is ready
    }
    Page* page = ref.get_page();
    Slot* slot = page->lookup(key);
    emit(slot->payload);
    bp.unfix(ref);
}
```

The driver loop manages a ring of coroutines:

```cpp
void interleaved_probe(span<uint64_t> keys, BufferPool& bp) {
    constexpr size_t BATCH = 64;  // Coroutine batch size
    circular_buffer<coroutine_handle<>> active;

    // Seed the pipeline
    size_t next_key = 0;
    while (active.size() < BATCH && next_key < keys.size()) {
        active.push_back(probe_coro(keys[next_key++], bp).handle());
    }

    // Drive to completion
    while (!active.empty()) {
        auto h = active.pop_front();
        h.resume();  // Resume suspended coroutine

        if (h.done()) {
            h.destroy();
            // Feed new work
            if (next_key < keys.size()) {
                active.push_back(probe_coro(keys[next_key++], bp).handle());
            }
        } else {
            // Not done yet (suspended on I/O), re-enqueue
            active.push_back(h);
        }
    }
}
```

With a batch of 64 coroutines in flight, the effective SSD queue depth reaches 12-16 (assuming ~20% miss rate), pushing NVMe utilization past 80%. The CPU switches between coroutines in ~20 nanoseconds (a single indirect jump), while an SSD page fetch costs 10-50 microseconds. This 500-2500x ratio between switch cost and I/O latency makes interleaving nearly free.

## Why C++20 Stackless Coroutines

The choice of stackless coroutines over alternatives is deliberate:

**vs. Threads**: Spawning 64 OS threads per operator per query is impractical. Context switches cost 1-5 microseconds (vs. 20ns for a coroutine resume), and the memory overhead of 64 thread stacks (each 2-8 MB) dwarfs the working set.

**vs. Fibers/Stackful Coroutines**: Each fiber requires a pre-allocated stack (typically 64KB-1MB). With 64 fibers per operator across 10+ concurrent operators across 100+ threads, memory pressure becomes a bottleneck. Stackless coroutines store only the live local variables at the suspension point, typically 64-256 bytes.

**vs. io_uring with callbacks**: While io_uring provides excellent async I/O, callback-based designs fragment the query execution logic across multiple functions, making compiler optimizations (loop unrolling, vectorization) nearly impossible. Coroutines preserve the linear control flow that compilers optimize well.

The C++20 coroutine frame for a typical buffer pool access stores:

```cpp
// Compiler-generated frame (conceptual)
struct probe_coro_frame {
    // Suspend point index
    uint8_t suspend_point;
    // Live variables at suspension
    uint64_t key;
    PageRef ref;
    // Promise object
    task_promise promise;
    // Total: ~80 bytes
};
```

## Group Prefetching: The Optimization Layer

Raw coroutine interleaving leaves performance on the table because it doesn't exploit the CPU's prefetch machinery. The **group prefetching** optimization (introduced by LeanStore, VLDB 2023) issues software prefetches before checking residency:

```cpp
task<void> probe_with_prefetch(uint64_t key, BufferPool& bp) {
    size_t slot_idx = hash(key) % bp.directory_size();

    // Issue prefetch for the page directory entry
    __builtin_prefetch(&bp.directory[slot_idx], 0, 1);
    co_await suspend{};  // Let prefetch land while other coroutines run

    PageRef ref = bp.directory[slot_idx];
    if (ref.is_resident()) {
        // Prefetch the actual page data
        __builtin_prefetch(ref.page_ptr(), 0, 1);
        co_await suspend{};  // Let data prefetch land
        // Now access is L1/L2 cache hit
        process(ref.get_page(), key);
    } else {
        bp.submit_io(ref);
        co_await suspend{};  // Wait for SSD I/O
        process(ref.get_page(), key);
    }
    bp.unfix(ref);
}
```

This two-phase prefetch strategy eliminates not just I/O stalls but also **TLB and cache misses** on the page directory and page data. Measurements from LeanStore show that group prefetching adds 15-25% throughput on top of basic coroutine interleaving, even for in-memory workloads where all pages are resident.

## Batch Size Selection

The optimal batch size balances three forces:

1. **I/O concurrency**: Larger batches increase effective queue depth, improving SSD utilization up to the device's optimal depth (typically 32-128 for NVMe).
2. **Cache pollution**: Each active coroutine's working set competes for L1/L2 cache. Beyond ~128 coroutines, cache thrashing dominates.
3. **Latency**: Larger batches increase per-tuple latency (time from first access to result emission), which matters for interactive queries.

Empirically, the sweet spot is:

| Workload | Optimal Batch | Reasoning |
|----------|--------------|-----------|
| In-memory (prefetch only) | 16-32 | Enough to hide L3 latency (~40ns) |
| NVMe SSD, 10% miss rate | 64-128 | Achieves queue depth 6-12 |
| HDD, 20% miss rate | 256-512 | Hides 5-10ms seek time |

## Integration with Compiled Query Engines

The elegance of coroutine interleaving emerges when combined with query compilation (produce/consume model). Each pipeline breaker that might touch the buffer pool becomes a coroutine boundary:

```cpp
// Compiled hash join probe pipeline
task<void> pipeline_3(TupleBuffer& input, HashTable& ht, BufferPool& bp) {
    for (auto& tuple : input) {
        // Hash join probe - may need I/O for hash table pages
        auto bucket = ht.bucket_for(tuple.join_key);
        PageRef ref = bp.start_fix(bucket.page_id);
        if (!ref.is_resident()) {
            bp.submit_io(ref);
            co_await suspend{};
        }
        // Continue with matched tuples
        for (auto& match : bucket.scan(ref.get_page(), tuple.join_key)) {
            // Downstream operators run synchronously (no I/O)
            auto result = project(tuple, match);
            output.emit(result);
        }
        bp.unfix(ref);
    }
}
```

Umbra's implementation demonstrates that the overhead of coroutine suspension points in compiled pipelines is below 3% for in-memory workloads, while achieving 2-5x speedup when the working set exceeds DRAM.

## Measurements and Tradeoffs

Published results from LeanStore (VLDB 2023) and Umbra (CIDR 2024) on TPC-H SF=300 with a 64GB buffer pool (dataset ~150GB on NVMe):

| Approach | Query 9 Runtime | SSD Queue Depth | CPU Utilization |
|----------|----------------|-----------------|-----------------|
| Blocking (traditional) | 47.2s | 1.0 | 23% |
| io_uring (async callbacks) | 19.8s | 8.4 | 61% |
| Coroutine interleaving | 15.1s | 14.2 | 78% |
| Coroutine + group prefetch | 12.7s | 14.8 | 89% |

The key insight: coroutine interleaving matches or exceeds io_uring throughput while maintaining the simple linear control flow that enables compiler optimizations. The ~20% improvement over io_uring callbacks comes from better instruction cache behavior (the hot loop stays in a single function) and reduced kernel crossing overhead.

## When Not to Use Coroutines

Coroutine interleaving adds complexity and isn't universally beneficial:

**Skip when**: the working set fits in DRAM (no I/O stalls to hide), the operator is already CPU-bound (compression, complex expressions), or the query touches sequential pages (full table scans where readahead handles prefetching).

**Prefer io_uring when**: you need to overlap I/O across different operators or queries (coroutine interleaving works within a single operator's batch), or when you're already using an async runtime that manages the event loop.

The future likely combines both: coroutine interleaving within operators for latency hiding, with io_uring as the underlying I/O submission mechanism for its superior kernel-side batching and polling capabilities.

## Conclusion

Coroutine interleaving represents a shift in database I/O philosophy: instead of making I/O faster (better SSDs, more DRAM), make the **CPU's perception of I/O cheaper** by never letting it wait. The 20 nanosecond cost of a coroutine switch buys you 10-100 microseconds of hidden I/O latency, a 500-5000x leverage ratio that fundamentally changes the economics of out-of-core query processing.

As NVMe SSDs get faster (approaching 1 microsecond with Intel Optane-class devices) and datasets grow past DRAM capacity (especially for vector indexes and large analytical tables), expect coroutine-based buffer management to become standard in the next generation of storage engines.
