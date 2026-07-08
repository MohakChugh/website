---
title: "Thread-Per-Core: Shared-Nothing Architecture for Predictable Microsecond Latency"
date: 2026-07-09
tags: [systems-architecture, performance, concurrency, latency, shared-nothing]
excerpt: "Modern databases like ScyllaDB and Redpanda abandon thread pools entirely, pinning one thread to each CPU core with zero shared mutable state between them. The result is predictable tail latency at microsecond scale, but the programming model demands rethinking everything from memory allocation to request routing."
---

## The thread pool ceiling

The conventional wisdom for high-performance servers is straightforward: create a pool of worker threads, protect shared state with mutexes, and let the OS scheduler distribute work. This model served us well from Apache httpd through early databases. It scales to thousands of requests per second without much thought.

But it hits a wall at the microsecond scale. When your storage latency drops from milliseconds (spinning disks) to single-digit microseconds (NVMe SSDs, persistent memory, CXL-attached DRAM), the overhead of the threading model itself starts dominating. A single `pthread_mutex_lock` on a contended lock costs 100-500ns. A cache line bouncing between cores via MESI protocol coherence traffic costs 40-80ns per hop. A context switch costs 1-5μs. When your actual I/O completes in 3μs, spending 2μs on lock acquisition is absurd.

The thread-per-core (TPC) model, pioneered by the Seastar framework and deployed at scale in ScyllaDB, Redpanda, and Glommio, offers a radical alternative: **one application thread per physical CPU core, with zero shared mutable state between them.** Each thread owns a shard of data, a shard of memory, and a shard of I/O, communicating only through explicit message passing.

## Architecture: one core, one world

In a TPC system, at startup the application spawns exactly `N` threads for `N` available cores. Each thread is pinned to its core via `sched_setaffinity` and never migrates. From that point forward, each "shard" operates as an independent single-threaded reactor:

```cpp
// Simplified Seastar-style reactor loop (one per core)
void shard::run() {
    pin_to_core(this->core_id);
    
    while (running) {
        // Poll completions from io_uring / epoll
        io_completions = poll_io();
        
        // Execute ready continuations
        for (auto& task : ready_queue) {
            task.resume();
        }
        
        // Drain cross-shard message queue
        while (auto msg = inbox.try_dequeue()) {
            dispatch(msg);
        }
        
        // Submit new I/O
        flush_io_submissions();
    }
}
```

There are no mutexes anywhere in the hot path. There is no `std::shared_mutex`, no `std::atomic<>` on data structures, no compare-and-swap loops. The shard owns its data exclusively, so all access is inherently thread-safe through isolation, not synchronization.

### Memory allocation per shard

Standard allocators like `jemalloc` or `tcmalloc` use thread-local caches but still require global coordination for large allocations or cross-thread frees. In TPC, each shard gets its own memory pool allocated from its local NUMA node:

```cpp
// Each shard pre-allocates its memory region at startup
struct shard_allocator {
    void* base;           // mmap'd region with NUMA affinity
    size_t capacity;
    free_list local_pool; // No locks needed: single-threaded access
    
    void* allocate(size_t n) {
        return local_pool.pop(n); // Never contended
    }
    
    void deallocate(void* p) {
        // Object might come from another shard's memory
        if (owns(p)) {
            local_pool.push(p);
        } else {
            // Send back to owning shard via message
            owning_shard(p)->inbox.enqueue(free_msg{p});
        }
    }
};
```

This eliminates NUMA cross-socket traffic for allocations. On a dual-socket system with 64 cores, this alone can reduce p99 allocation latency from ~2μs (global allocator contention) to <50ns (local free-list pop).

## Request routing: the partitioning problem

If each shard owns a partition of data, incoming requests must be routed to the correct shard. The networking layer itself is sharded, each core runs its own `io_uring` instance or `epoll` fd set, and the kernel distributes connections via RSS (Receive Side Scaling) or SO_REUSEPORT.

For key-value workloads, the routing is straightforward:

```cpp
uint32_t target_shard(const key& k) {
    return murmur3(k) % num_shards;
}
```

When a request arrives on shard 3 but targets data on shard 7, it must be forwarded:

```cpp
future<response> handle_request(request req) {
    uint32_t owner = target_shard(req.key);
    
    if (owner == this_shard()) {
        // Fast path: local execution, no message passing
        return execute_locally(req);
    }
    
    // Slow path: cross-shard RPC via lockless SPSC queue
    return submit_to_shard(owner, std::move(req));
}
```

The cross-shard communication uses single-producer single-consumer (SPSC) queues, which are inherently lock-free since only one thread writes and one thread reads. Seastar implements this as a per-pair queue: shard `i` has a dedicated outbox for each shard `j`, yielding `N*(N-1)` queues for `N` shards. This avoids any contention even on the messaging infrastructure.

## The tail latency payoff

The measurable benefit of TPC is in tail latency, not throughput. Thread-pool architectures often show excellent p50 latency but catastrophic p99.9 due to:

1. **Lock convoys**: one slow lock holder blocks dozens of waiters
2. **Priority inversion**: OS scheduler preempts a lock-holder for a non-critical thread
3. **Cache pollution**: context switches evict hot data from L1/L2
4. **NUMA penalties**: thread migration moves execution away from data

TPC eliminates all four. ScyllaDB published benchmarks showing p99.9 read latency of 1.2ms versus Cassandra's 15ms on identical hardware, a 12x improvement concentrated entirely in the tail. Redpanda achieves p99 produce latency under 5ms at 1GB/s throughput, where Kafka's p99 climbs to 30ms+ under the same load due to JVM GC pauses and lock contention in the partition layer.

## The programming tax

This architecture is not free. The programming model requires:

**No blocking calls, ever.** A single `sleep()`, synchronous DNS lookup, or page fault stalls the entire shard. All I/O must be asynchronous. All computation must be broken into cooperatively-scheduled tasks.

**Explicit data partitioning.** You must decide upfront how data maps to shards. Cross-shard operations (scatter-gather queries, transactions spanning partitions) require coordination protocols.

**No work stealing.** If shard 5 is overloaded and shard 6 is idle, the system cannot rebalance dynamically without moving data ownership. This makes load skew handling harder. Seastar mitigates this with adaptive request routing at the network layer, but fundamental hot-partition problems remain.

**Continuations and futures everywhere.** Since nothing can block:

```cpp
// Every operation returns a future, chained explicitly
future<> handle_write(key k, value v) {
    return get_shard_for(k).invoke_on([k, v] (database& db) {
        return db.memtable.put(k, v).then([&db] {
            if (db.memtable.size() > threshold) {
                return db.flush_to_disk(); // Also async
            }
            return make_ready_future<>();
        });
    });
}
```

Rust's `async/await` syntax (used by Glommio and Monoio) makes this considerably more ergonomic than raw continuation-passing, but the conceptual burden remains: every function boundary is a potential suspension point, and you must reason about shard affinity across `await`s.

## When to use thread-per-core

TPC shines when:
- **Latency SLOs are in microseconds**, not milliseconds
- **Data is naturally partitionable** (key-value stores, log segments, time-series shards)
- **Hardware is fast** (NVMe, RDMA, CXL), so software overhead dominates
- **GC pauses are unacceptable** (hence C++ and Rust dominate TPC implementations)

TPC is wrong when:
- Work is inherently serial and CPU-bound (e.g., a single large ML inference)
- Data access patterns are random and unpredictable across partitions
- Development speed matters more than tail latency (the programming model is harder)
- Your storage is still millisecond-scale HDDs (latency floor is too high for the overhead to matter)

## The ecosystem in 2025

Seastar (C++, Apache-2.0) remains the most mature TPC framework, powering ScyllaDB and Redpanda in production at thousands of deployments. Glommio (Rust, Apache-2.0) brings the model to Rust with `io_uring`-native I/O. Monoio (Rust, MIT) from ByteDance takes a similar approach optimized for their proxy workloads. In the JVM world, Project Loom's virtual threads move in a different direction (millions of cheap threads rather than few fat ones), but cannot achieve the same cache and NUMA predictability.

The pattern is converging with hardware trends. CXL-attached memory pools, microsecond-scale storage, and 100Gbps+ networking all push the bottleneck away from I/O wait and toward software overhead. As this trend accelerates, the "run fewer threads, own more data per thread" philosophy of TPC becomes not just an optimization, but a necessity for systems that need to keep up with their own hardware.
