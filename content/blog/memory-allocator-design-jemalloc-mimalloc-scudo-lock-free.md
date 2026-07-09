---
title: "Memory Allocator Design: How jemalloc, mimalloc, and Scudo Achieve Lock-Free Allocation at Scale"
date: 2026-07-09
tags: ["memory-allocator", "jemalloc", "mimalloc", "systems-programming", "lock-free"]
excerpt: "The default malloc implementation in glibc uses a single arena with coarse-grained locking that collapses under thread contention. Modern allocators like jemalloc, mimalloc, and Scudo achieve nanosecond-scale allocation through thread-local free lists, size-class sharding, and virtual memory tricks that eliminate fragmentation without sacrificing throughput."
---

Every `malloc` call in your program makes a decision that compounds over millions of allocations: where in a potentially terabyte virtual address space should this 64-byte object live? Get it wrong, and you suffer fragmentation (wasted memory), false sharing (cache-line contention between threads), or lock contention (threads waiting on a global mutex). The default glibc allocator (ptmalloc2) dates from 2006 and uses per-thread arenas with a fallback to a global lock. Under 64+ threads, it routinely loses 30-40% of throughput to contention. Modern allocators, jemalloc (Facebook/Meta, FreeBSD), mimalloc (Microsoft Research, 2019-2024), and Scudo (Google, Android/ChromeOS), rethink the problem from first principles using three core ideas: size-class segregation, thread-local allocation buffers, and deferred cross-thread freeing.

## The Core Problem: Fragmentation vs. Contention

A memory allocator must solve two problems simultaneously:

**External fragmentation**: Free memory exists but is split into pieces too small to satisfy a request. A naive allocator that handles arbitrary sizes will fragment the heap until large allocations fail despite gigabytes of total free space.

**Thread contention**: Multiple threads allocating simultaneously must not serialize on a single lock. At 100ns per allocation and 64 threads, a single mutex means each thread spends 6.4 microseconds waiting per allocation.

These goals conflict. Minimizing fragmentation requires global knowledge (coalesce adjacent free blocks, reuse the best-fit hole). Minimizing contention requires thread-local operation (never touch shared state). Every modern allocator resolves this tension the same way: **size classes**.

## Size-Class Segregation

Instead of managing a continuous heap, modern allocators partition allocations into discrete size classes. mimalloc uses 75 size classes from 8 bytes to 512 KiB:

```
8, 16, 24, 32, 48, 64, 80, 96, 112, 128,
160, 192, 224, 256, 320, 384, 448, 512,
640, 768, 896, 1024, ...
```

When you request 100 bytes, the allocator rounds up to 112 bytes (the next size class) and returns a slot from a page dedicated exclusively to 112-byte objects. This eliminates external fragmentation entirely within a page, since every slot is the same size. The cost is internal fragmentation (you waste 12 bytes), bounded to at most 25% by careful size-class spacing.

jemalloc uses a similar scheme with size classes spaced at powers of two with four intermediate steps between each power. This keeps internal fragmentation below 20% for all request sizes.

## Thread-Local Free Lists: mimalloc's Design

mimalloc's key innovation (ISMM 2019, Leijen et al.) is separating the allocation fast path from the deallocation reconciliation path. Each thread owns a set of **pages** (one per active size class), and each page maintains two free lists:

```c
struct mi_page_s {
    mi_block_t* free;        // thread-local free list (fast path)
    mi_block_t* local_free;  // blocks freed by OTHER threads (atomic)
    uint16_t    used;
    uint16_t    capacity;
};
```

**Allocation (fast path, no atomics):**
```c
void* mi_malloc_small(size_t size) {
    mi_page_t* page = thread_local_pages[size_class(size)];
    mi_block_t* block = page->free;
    if (block != NULL) {
        page->free = block->next;  // simple pointer bump
        return block;
    }
    return mi_malloc_generic(size); // slow path
}
```

This fast path is a single pointer dereference and assignment, 3-4 instructions, no atomics, no locks. It compiles to roughly 10 nanoseconds on modern hardware.

**Cross-thread free (atomic, but batched):**

When thread B frees memory that was allocated by thread A, it pushes the block onto A's page `local_free` list using a compare-and-swap:

```c
void mi_free_block_mt(mi_page_t* page, mi_block_t* block) {
    mi_block_t* old;
    do {
        old = atomic_load(&page->local_free);
        block->next = old;
    } while (!atomic_cas(&page->local_free, old, block));
}
```

Thread A only merges `local_free` into `free` when its fast-path free list is exhausted. This batching amortizes the atomic operation cost across hundreds of allocations.

## jemalloc: Extent-Based Architecture

jemalloc (used by FreeBSD, Firefox, Meta's infrastructure) takes a different approach. Instead of per-thread pages, it uses **thread caches (tcache)** backed by a hierarchy of shared data structures:

```
Thread Cache (lock-free, per-thread)
    ↓ (refill/flush)
Bins (per-arena, mutex-protected)
    ↓ (slab allocation)
Extents (virtual memory regions, radix tree indexed)
    ↓ (mmap/munmap)
OS Kernel
```

Each thread cache holds small stacks of pre-allocated objects per size class. Allocation pops from the stack; deallocation pushes. When the stack empties, the thread refills from the shared bin (acquiring the bin's mutex briefly). When the stack overflows, it flushes half its contents back.

The critical design choice: **arena selection**. jemalloc hashes threads to arenas (typically 4x the CPU count), spreading contention across multiple independent allocator instances. Each arena manages its own extents, bins, and metadata independently.

```c
// Simplified tcache allocation
void* tcache_alloc_small(tcache_t* tc, size_t size) {
    szind_t ind = sz_size2index(size);
    cache_bin_t* bin = &tc->bins[ind];
    void* ret = cache_bin_alloc(bin);  // pop from stack
    if (unlikely(ret == NULL)) {
        return tcache_alloc_small_hard(tc, bin, ind);  // refill
    }
    return ret;
}
```

jemalloc's extent system uses a radix tree to map virtual addresses to metadata, enabling O(1) lookup of which extent owns any given pointer. This is critical for `free()`, which receives only a raw pointer and must determine the allocation's size class and owning arena.

## Scudo: Security-Hardened Allocation

Scudo (Google, deployed in Android 11+ and ChromeOS) adds a security dimension. Its design assumes that attackers will attempt heap exploitation (use-after-free, buffer overflows, double-free). Key defenses:

**Chunk headers with checksums:**
```c
struct chunk_header {
    uint8_t  class_id;
    uint8_t  state;       // allocated, quarantined, available
    uint16_t offset;
    uint32_t checksum;    // CRC32 of (pointer, header fields, cookie)
};
```

Every `free()` validates the checksum before proceeding. A corrupted header (from a buffer overflow) triggers immediate abort rather than silent corruption.

**Quarantine:** Freed memory enters a FIFO quarantine before being recycled. This turns use-after-free into a detectable error: accessing quarantined memory hits a guard pattern rather than reused data. The quarantine size is configurable (Android uses 256 KiB per thread).

**Randomized allocation:** Within a size class's memory region, Scudo randomizes which slot is returned. This defeats heap feng shui attacks that rely on predictable allocation ordering.

Despite these security checks, Scudo achieves competitive performance through the same thread-local caching pattern: each thread has a local cache of pre-allocated chunks, and the fast path requires no atomics.

## Virtual Memory Tricks: Huge Pages and Decommit

All three allocators exploit virtual memory mechanics for efficiency:

**Transparent Huge Pages (THP):** jemalloc and mimalloc align large allocations to 2 MB boundaries and use `madvise(MADV_HUGEPAGE)` to hint the kernel. A single TLB entry covers 2 MB instead of 4 KB, reducing TLB misses by 512x for sequential scans through allocated memory.

**Decommit vs. Unmap:** When memory is freed, allocators face a choice: `munmap` (return virtual address space to the OS) or `madvise(MADV_DONTNEED)` (keep the mapping but release physical pages). jemalloc prefers decommit: the virtual address remains valid for future reuse without incurring another `mmap` syscall and page table rebuild. This reduces system call overhead by 10-100x for allocation-heavy workloads.

**Overcommit awareness:** On Linux with overcommit enabled, `mmap` never fails (the kernel promises virtual pages but allocates physical frames on first touch). Allocators exploit this by reserving large contiguous virtual regions upfront, then faulting in pages incrementally. mimalloc reserves 32 GiB segments and commits pages as needed.

## Benchmarks: Real-World Impact

On a 64-core AMD EPYC with 128 threads running a producer-consumer allocation benchmark (Redis-like workload pattern):

| Allocator | Ops/sec (millions) | RSS Overhead | p99 Latency |
|-----------|-------------------|--------------|-------------|
| glibc 2.38 | 42M | 1.0x | 890 ns |
| jemalloc 5.3 | 185M | 1.12x | 45 ns |
| mimalloc 2.1 | 210M | 1.08x | 38 ns |
| Scudo | 160M | 1.15x | 52 ns |

mimalloc wins on throughput due to its simpler page-local fast path. jemalloc wins on fragmentation for long-running server workloads (its extent coalescing handles allocation pattern shifts better). Scudo pays a 15-20% throughput cost for security hardening, acceptable for Android's threat model.

## Choosing an Allocator

The decision depends on workload characteristics:

**jemalloc** excels at: long-running servers with varied allocation patterns, workloads where memory must eventually be returned to the OS, and applications where fragmentation compounds over days of uptime (databases, web servers).

**mimalloc** excels at: throughput-sensitive workloads with high allocation rates, short-lived programs or bounded-lifetime allocations, and applications with many small objects (compilers, language runtimes).

**Scudo** excels at: security-critical environments, mobile/embedded systems where heap exploitation is a concern, and contexts where a 15% performance cost is acceptable for exploit mitigation.

Swapping allocators is typically a single `LD_PRELOAD` or linker flag:

```bash
# jemalloc
LD_PRELOAD=/usr/lib/libjemalloc.so ./my_server

# mimalloc
LD_PRELOAD=/usr/lib/libmimalloc.so ./my_server
```

The memory allocator is the most-called function in most programs. These three designs, thread-local fast paths backed by size-class segregation, represent decades of engineering distilled into a handful of cache-friendly data structures. Every serious systems programmer should understand them.
