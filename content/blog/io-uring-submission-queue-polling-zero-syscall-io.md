---
title: "io_uring and Submission Queue Polling: The Path to Zero-Syscall I/O"
date: "2026-07-08"
tags: ["io_uring", "linux-kernel", "systems-programming", "async-io", "performance"]
excerpt: "How io_uring eliminated the system call overhead that plagued Linux I/O for decades, and why submission queue polling lets the kernel do I/O without ever context-switching."
---

For thirty years, every I/O operation on Linux required at least one system call. `read()`, `write()`, `epoll_wait()` — each crossed the user/kernel boundary, flushed TLB entries on Meltdown-mitigated hardware, and serialized through the VFS layer. io_uring, merged in Linux 5.1 (2019) and maturing through 6.x, fundamentally broke this constraint by introducing shared memory ring buffers between userspace and the kernel. But the real revolution came with **submission queue polling (SQPOLL)** — a mode where a dedicated kernel thread continuously harvests I/O requests from the submission ring, eliminating system calls entirely from the hot path.

## The Architecture: Two Rings, One Shared Region

io_uring uses two lock-free single-producer/single-consumer rings mapped into both user and kernel address space:

```
┌─────────────────────────────────────────────┐
│  Userspace Process                          │
│                                             │
│   SQ (Submission Queue)    CQ (Completion)  │
│   ┌──┬──┬──┬──┬──┐       ┌──┬──┬──┬──┐    │
│   │op│op│op│  │  │       │ce│ce│  │  │    │
│   └──┴──┴──┴──┴──┘       └──┴──┴──┴──┘    │
│        │ tail              head │           │
│────────┼──── mmap'd ───────────┼───────────│
│        ▼ shared memory         ▼           │
│   ┌──┬──┬──┬──┬──┐       ┌──┬──┬──┬──┐    │
│   │op│op│op│  │  │       │ce│ce│  │  │    │
│   └──┴──┴──┴──┴──┘       └──┴──┴──┴──┘    │
│        head │              │ tail          │
│  Kernel                                     │
└─────────────────────────────────────────────┘
```

The submission queue entries (SQEs) are 64 bytes each, packed with the operation type, file descriptor, buffer address, offset, and flags. The completion queue entries (CQEs) are 16 bytes: a user_data tag and a result code. Both rings use memory-ordered atomic loads/stores on head and tail pointers — no locks, no futexes on the fast path.

The critical insight: userspace writes SQEs and advances the tail pointer. The kernel reads from the head pointer. This is a textbook SPSC queue, and on x86-64 with TSO memory ordering, it requires only a single `smp_store_release` on the producer side.

## From io_uring_enter() to Zero Syscalls

In the default mode, after filling SQEs, userspace calls `io_uring_enter(IORING_ENTER_SUBMIT)` to notify the kernel. This is already better than per-operation syscalls (you batch N operations in one call), but you still pay the syscall tax once per batch.

SQPOLL eliminates this entirely. When you create the ring with `IORING_SETUP_SQPOLL`, the kernel spawns a dedicated thread that spins on the submission queue tail pointer:

```c
// Kernel side (simplified from fs/io_uring.c)
static int io_sq_thread(void *data) {
    struct io_ring_ctx *ctx = data;
    
    while (!kthread_should_stop()) {
        if (io_sqring_entries(ctx)) {
            // Work available — submit it
            io_submit_sqes(ctx);
            ctx->sq_thread_idle = false;
        } else if (time_after(jiffies, timeout)) {
            // No work for sq_thread_idle_ms — go to sleep
            ctx->sq_thread_idle = true;
            schedule();
        } else {
            cpu_relax();
        }
    }
}
```

The kernel thread polls the shared ring. When userspace writes an SQE and bumps the tail, the kernel thread picks it up within microseconds — no syscall, no interrupt, no context switch. Userspace similarly polls the CQ ring for completions without calling `io_uring_enter()`.

## The Performance Implications

The numbers from Jens Axboe's original benchmarks (and confirmed by subsequent work) show the magnitude:

| Mode | IOPS (NVMe, 4K randread, QD=128) | Syscalls/sec |
|------|-----------------------------------|--------------|
| libaio | ~800K | ~800K |
| io_uring (default) | ~1.2M | ~10K (batched) |
| io_uring (SQPOLL) | ~1.7M | 0 (steady state) |

The gap widens on machines with Meltdown/Spectre mitigations, where each syscall now costs 1–5μs instead of the historical ~200ns. SQPOLL completely sidesteps this tax.

## Registered Buffers and Fixed Files

Two complementary features eliminate per-operation overhead inside the kernel:

**Fixed files** (`IORING_REGISTER_FILES`): Pre-registers file descriptors so the kernel skips `fget()`/`fput()` atomic refcounting on every operation. For a server handling 100K ops/sec on the same set of fds, this removes 200K atomic operations per second.

**Registered buffers** (`IORING_REGISTER_BUFFERS`): Pre-maps userspace buffers into the kernel's address space, eliminating `get_user_pages()` on every I/O. This avoids page pinning overhead and TLB shootdowns.

```c
struct io_uring_params params = {
    .flags = IORING_SETUP_SQPOLL,
    .sq_thread_idle = 2000, // ms before kernel thread sleeps
};

int ring_fd = io_uring_setup(256, &params);

// Register fixed files
int fds[N_FILES] = { /* pre-opened fds */ };
io_uring_register(ring_fd, IORING_REGISTER_FILES, fds, N_FILES);

// Now SQEs use fixed_file index instead of raw fd
sqe->flags |= IOSQE_FIXED_FILE;
sqe->fd = file_index; // index into registered array
```

## The SQPOLL CPU Trade-off

SQPOLL is not free. The kernel thread consumes a full CPU core while spinning. This is the same trade-off DPDK and SPDK make: dedicate a core to polling to eliminate interrupt/syscall latency. For high-throughput storage servers already saturating NVMe devices at millions of IOPS, dedicating one core to the SQ thread is trivially worthwhile — the alternative is losing 30–40% throughput to syscall overhead.

The `sq_thread_idle` parameter provides a compromise: after N milliseconds of inactivity, the kernel thread sleeps. The next `io_uring_enter()` call wakes it. This gives you zero-syscall I/O during bursts while reclaiming the core during idle periods.

## Multishot Operations and Buffer Rings (Linux 6.x)

Recent kernels added **multishot** accept and receive operations. A single SQE generates multiple CQEs — one per incoming connection or one per received packet. Combined with **provided buffer rings** (where the kernel picks buffers from a userspace-supplied pool), this enables a network server that:

1. Posts one multishot accept SQE
2. Posts one multishot recv SQE per connection
3. Never re-arms anything
4. Consumes completions from the CQ ring in a tight loop

The entire network I/O path becomes: write to shared memory, read from shared memory. No syscalls. The kernel thread does all the heavy lifting asynchronously.

## Where This Matters

The systems benefiting most from io_uring SQPOLL share a profile: high operation rates on fast devices where syscall overhead is the bottleneck, not the device itself.

**Storage engines**: RocksDB, ScyllaDB, and TiKV have io_uring backends. ScyllaDB reported 2.5x improvement in P99 latency for mixed workloads because io_uring eliminated head-of-line blocking in their reactor loop.

**Proxy/gateway servers**: Envoy and NGINX are integrating io_uring for connection handling. When proxying 100K concurrent connections, the reduction in epoll_wait() syscalls alone frees 10–15% CPU.

**Database buffer pools**: PostgreSQL 16 added io_uring support for read-ahead in sequential scans. The batching eliminates the per-page pread() overhead that dominated scan performance on fast NVMe.

## The Broader Lesson

io_uring represents a philosophical shift in OS interface design: instead of the kernel providing operations (syscalls) that userspace invokes, the kernel provides shared data structures that both sides mutate concurrently. The ring buffer is the interface, not the function call. This pattern — shared memory queues replacing RPC-style interfaces — appears wherever the per-call overhead dominates: virtio uses it for VM I/O, NVMe uses it for device I/O, and now Linux uses it for application I/O.

The system call, once considered the fundamental kernel interface primitive, is becoming an optional slow path.
