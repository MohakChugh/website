---
title: "Memory-Mapped I/O Considered Harmful: Why Modern Databases Avoid mmap for Buffer Management"
date: 2026-07-09
tags: [databases, memory-management, operating-systems, storage-engines, performance]
excerpt: "mmap() seems like the perfect database buffer pool: let the OS handle page caching, avoid copies, and get a simple pointer interface. In practice, it introduces catastrophic stalls, uncontrollable eviction, and subtle corruption. Here is why every serious DBMS builds its own buffer manager, and the systems-level reasons mmap fails at scale."
---

## The seductive promise

Every database needs a buffer pool: a cache that holds hot pages in memory and evicts cold ones to disk. The operating system already provides exactly this via `mmap()`. Map a file into your address space, access it through pointers, and the kernel handles page faults, eviction, and writeback transparently. No `read()` / `write()` syscalls, no double-buffering, no manual bookkeeping.

Early MongoDB used mmap as its storage engine. SQLite still defaults to mmap for read-only workloads. LevelDB memory-maps its SSTable files. The approach works beautifully on a laptop with a 2 GB database. Then you hit 64 GB of data on a 16 GB machine, and everything falls apart in ways the kernel cannot fix.

The 2022 CMU paper *"Are You Sure You Want to Use MMAP in Your Database Management System?"* (Crotty et al.) systematically catalogued mmap's failures. Since then, RocksDB, DuckDB, ScyllaDB, and WiredTiger have all converged on the same conclusion: serious databases must manage their own pages.

## Problem 1: Uncontrollable eviction

When the OS needs memory, it evicts pages from the page cache using a global LRU (or Multi-Gen LRU on recent Linux kernels). The kernel has no idea which pages are *query-hot*. It sees undifferentiated anonymous mappings.

A database knows that its B-tree root page is accessed on every query. A hash index's directory pages must remain pinned. The kernel will happily evict both to make room for a background `cp` operation. The result: random 5 ms stalls as critical pages fault back in from NVMe.

Worse, the kernel evicts pages *synchronously* on the fault path. If the page was dirty, the fault handler must first write it back before reassigning the frame. This creates **latency spikes that are architecturally impossible to eliminate** without a userspace buffer pool:

```c
// Userspace buffer pool: pin semantics guarantee no eviction
page_t *page = buffer_pool_fix(page_id, PIN_SHARED);
// Access page->data safely — no fault possible
uint64_t key = page->data[slot].key;
buffer_pool_unfix(page);
```

With mmap, every pointer dereference is a potential page fault. You cannot prefetch deterministically, you cannot pin, and you cannot prioritize which pages survive memory pressure.

## Problem 2: The TLB shootdown storm

When the kernel unmaps or remaps pages, it must invalidate Translation Lookaside Buffer (TLB) entries on *all* cores that accessed the mapping. This requires an Inter-Processor Interrupt (IPI) to every core, which stalls the remote core's pipeline until the TLB flush completes.

On a 128-core server running an analytical query that touches thousands of pages, `munmap()` or `mremap()` triggers a TLB shootdown storm. Each IPI costs 1–5 microseconds of remote core stall time. With dozens of concurrent shootdowns per second, aggregate throughput drops 10–30% compared to userspace page management that never touches the TLB.

```
// perf output during mmap-heavy workload:
//   tlb:tlb_flush          842,391 events/sec
//   irq_vectors:call_function_single_entry  791,204/sec
```

A userspace buffer pool maps a fixed region at startup (one TLB entry per huge page) and never remaps it. All page replacement happens *within* that region by copying or pointer-swapping, invisible to the TLB.

## Problem 3: Error handling is impossible

When a read from an mmap'd file encounters an I/O error (bad sector, detached NFS mount, corrupted SSD page), the kernel delivers a `SIGBUS` signal. There is no structured error handling. You cannot retry the read, attempt a secondary replica, or log a diagnostic — you get a signal that, by default, kills your process.

You can install a SIGBUS handler, but recovering from an arbitrary instruction that triggered the fault is extraordinarily brittle. You don't know *which* query caused the fault, which transaction to abort, or which page is corrupt:

```c
void sigbus_handler(int sig, siginfo_t *info, void *ctx) {
    // info->si_addr tells us the faulting address, but:
    // - Which query was running?
    // - Which transaction should abort?
    // - How do we retry with a fallback page?
    // Answer: we can't. The process is in an undefined state.
    _exit(1); // The only safe option
}
```

With explicit `pread()`, every I/O operation returns an error code that propagates through the query execution stack, allowing graceful degradation.

## Problem 4: Write amplification via double-writes

A database that modifies mmap'd pages faces a dilemma: the kernel can write back dirty pages *at any time*, in *any order*. If the system crashes mid-writeback, the on-disk file contains a mix of old and new page versions — a torn write that corrupts the database.

The classic fix is a write-ahead log (WAL) with full page images on first modification. But if the kernel flushes a dirty page before the WAL reaches disk, the WAL no longer protects against that page's corruption. Ensuring ordering between the WAL and mmap'd page writeback requires `msync()` barriers that serialize I/O and negate mmap's throughput advantage.

PostgreSQL solves this with full-page writes after each checkpoint. WiredTiger (MongoDB's engine) initially used mmap but switched to `pwrite()` with its own eviction thread precisely because mmap made crash consistency intractable at scale.

## Problem 5: No control over I/O scheduling

Modern NVMe devices can handle 64+ concurrent I/O operations per core via io_uring or direct submission. A userspace buffer pool batches reads, issues them as scatter-gather lists, and overlaps I/O with computation:

```c
// Prefetch upcoming pages while processing current batch
for (int i = 0; i < batch_size; i++) {
    io_uring_prep_read(sqe, fd, buf[i], PAGE_SIZE, offsets[i]);
}
io_uring_submit(&ring);

// Process already-loaded pages while I/O completes
process_batch(current_pages);

// Reap completions
io_uring_wait_cqe_nr(&ring, &cqes, batch_size);
```

With mmap, the kernel issues one 4 KB read per page fault, synchronously, on the thread that faulted. There is no batching, no overlap with computation, and no way to hint at access patterns beyond `madvise()`, which the kernel is free to ignore.

## Problem 6: NUMA unawareness

On multi-socket servers, the physical location of a page in memory matters. Accessing DRAM on the remote socket costs 1.7× the local access latency. A userspace buffer pool can allocate pages on the NUMA node where the accessing thread runs.

The kernel's page cache has no concept of query affinity. It places pages wherever free frames exist, potentially stranding hot pages on remote NUMA nodes. `mbind()` can constrain allocations, but only at mapping granularity — useless when different queries from different sockets access the same file.

## The pattern: what modern engines actually do

Every high-performance storage engine converges on the same architecture:

1. **Open files with `O_DIRECT`** to bypass the kernel page cache entirely
2. **Allocate a fixed buffer pool** at startup using huge pages (`mmap` with `MAP_ANONYMOUS | MAP_HUGETLB`)
3. **Manage pages explicitly** with clock/LRU-K eviction, pin counts, and dirty tracking
4. **Issue I/O through io_uring** or `pread()`/`pwrite()` with explicit scheduling
5. **Handle errors structurally** through return codes on every I/O path

RocksDB uses `pread()` with configurable readahead. DuckDB maintains its own buffer manager with explicit eviction. ScyllaDB uses Seastar's userspace I/O scheduler with `O_DIRECT`. WiredTiger replaced its mmap path with explicit page management in 2019.

## When mmap still works

mmap remains appropriate in narrow scenarios:

- **Read-only, memory-resident data** where the working set fits in RAM (no eviction pressure)
- **Memory-mapped WAL segments** that are append-only and sequentially consumed
- **Embedded databases with small datasets** (SQLite on mobile, LMDB for configuration stores under 1 GB)

The common thread: situations where eviction never happens, writes are structured, and the TLB is stable.

## The deeper lesson

mmap embodies a philosophical disagreement between operating systems and databases. The OS assumes all applications are equal participants in a shared resource pool. A database *is* the resource pool — it knows which pages are hot, which are being scanned, which will be needed in 50 ms, and which can be evicted without cost. Delegating these decisions to a general-purpose kernel algorithm that optimizes for `cat` and `grep` is an architectural mismatch that no amount of `madvise()` hints can fix.

The kernel is not wrong — it solves the general case well. But databases are not the general case. They are adversarial workloads that demand deterministic latency, explicit resource control, and structured error recovery. Every production database that tried mmap eventually built its own buffer pool. The only question is how many latency spikes it takes to get there.
