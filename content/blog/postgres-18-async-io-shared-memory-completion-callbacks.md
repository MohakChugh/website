---
title: "PostgreSQL 18's Async I/O: Completion Callbacks That Live in Shared Memory"
date: 2026-09-24
tags: ["postgresql", "io-uring", "databases", "storage", "linux"]
excerpt: "PostgreSQL 18 shipped the largest storage-layer change in decades: reads now go through a real asynchronous I/O subsystem instead of posix_fadvise hints and kernel readahead. The interesting part isn't the io_uring integration — it's the design constraints. Any backend must be able to complete any other backend's I/O (to avoid a distributed deadlock through shared buffers), so completion callbacks live in shared memory, are addressed by one-byte IDs instead of function pointers, and are forbidden from raising errors. Cold-cache sequential scans get 2–3x faster, and EXPLAIN ANALYZE starts lying to you in a new way."
---

# PostgreSQL 18's Async I/O: Completion Callbacks That Live in Shared Memory

For its entire life, PostgreSQL has read data pages with blocking `pread()` calls and hoped the OS would hide the latency — kernel readahead for sequential scans, `posix_fadvise(POSIX_FADV_WILLNEED)` hints for bitmap scans. PostgreSQL 18 (September 2025) replaces that with a genuine asynchronous I/O subsystem, built by Andres Freund over several release cycles. Sequential scans, bitmap heap scans, and vacuum now issue reads that complete in the background, into shared buffers, while the executor keeps working.

The headline numbers are respectable — 2–3x on cold-cache scans — but the architecture is the interesting part. Retrofitting AIO into a multi-process database that shares a buffer pool creates a deadlock problem that most AIO writeups never mention, and PostgreSQL's solution shapes every API decision in the subsystem.

## The deadlock nobody talks about

In a single-process server (or a thread-per-core one), AIO is straightforward: the process that issued the I/O eventually polls its completion queue. PostgreSQL is a process-per-connection system with a shared buffer pool, and that combination breaks the naive design.

Consider: backend A starts asynchronous reads into shared buffers, marking those buffers I/O-in-progress, then blocks on a lock held by backend B. Backend B, meanwhile, tries to read one of the pages A's I/O is targeting — it finds the buffer marked in-progress and waits for the I/O to finish. But the I/O is complete only when someone *processes the completion*, and the only backend that can do that in a caller-completes design is A — which is blocked on B. Undetected deadlock, through the buffer pool, with no lock cycle the deadlock detector can see.

The AIO subsystem's core invariant follows directly: **every I/O method must guarantee completions get processed even if the issuing backend never runs again**. The two real methods satisfy it differently:

- `io_method = worker` (the default): dedicated I/O worker processes (`io_workers = 3`) execute the reads and run completion processing themselves. The issuer can block forever; workers make progress.
- `io_method = io_uring`: each backend has a ring, but *any* backend waiting on an I/O can drain the issuer's completion queue and run the completion work. Completion is a shared responsibility, not the issuer's.

## Consequences: callbacks without function pointers

If any backend can complete any other backend's I/O, all I/O state must live in shared memory. That sounds mundane until you hit `EXEC_BACKEND` builds (Windows), where each process has its own ASLR layout — you cannot store a function pointer in shared memory because it means something different in every process. So completion callbacks are registered by ID:

```c
PgAioReturn  ioret;
PgAioHandle *ioh = pgaio_io_acquire(CurrentResourceOwner, &ioret);

PgAioWaitRef iow;
pgaio_io_get_wref(ioh, &iow);

/* callback is a one-byte enum, not a pointer */
pgaio_io_register_callbacks(ioh, PGAIO_HCB_SHARED_BUFFER_READV, 0);
pgaio_io_set_handle_data_32(ioh, (uint32 *) &buffer, 1);

smgrstartreadv(ioh, operation->smgr, forknum, blkno, &page, 1);
/* ioh may not be touched past this point — it may already be recycled */

perform_other_work();
pgaio_wref_wait(&iow);
```

Three details here reward attention:

1. **Handles are recycled immediately after completion**, so you never wait on a handle — you wait on a `PgAioWaitRef`, which captures the handle *plus a generation number*. This is the classic tagged-pointer solution to ABA, applied to I/O descriptors.
2. **`pgaio_io_acquire()` must always succeed**, which forces the rule that a backend may hold only one undefined handle at a time. Otherwise a backend could exhaust the handle pool and deadlock against itself.
3. **Callbacks are layered by subsystem**: md.c registers one that detects short reads, bufmgr.c registers one that verifies the page and updates the buffer descriptor. Callbacks also run at *stage* time — pinning buffers on behalf of the AIO subsystem, so the I/O stays valid even if the issuing query errors out mid-flight.

Error handling inherits the same constraint. A completion callback may run inside another backend, inside a critical section — it cannot `ereport(ERROR)` on someone else's behalf. Failures are encoded compactly into the `PgAioReturn` (full `ErrorData` would require unbounded shared memory), and the *issuer* raises the error later via `pgaio_result_report(ioret.result, &ioret.target_data, ERROR)`. Partial reads are not retried transparently; the caller re-issues.

Almost no PostgreSQL code touches this raw API. The intended consumer is the **read stream** abstraction (`read_stream.h`, introduced in PG 17): a scan declares a callback that yields upcoming block numbers, and the stream keeps up to `effective_io_concurrency` reads in flight, combining adjacent blocks into vectored reads up to `io_combine_limit` (default 128kB). PG 17 used read streams to drive `posix_fadvise`; PG 18 swapped the engine underneath for real AIO without touching the scan code. That two-release staging — first unify the read pattern, then replace the mechanism — is the retrofit playbook worth stealing.

## What the numbers say

pganalyze benchmarked a cold-cache `SELECT count(*)` over a 3.5GB, 100M-row table on EBS (io2, 20k IOPS, parallel query disabled):

| Configuration | Time |
|---|---|
| PG 17 (fadvise + readahead) | 15,830 ms |
| PG 18, `io_method = sync` | 15,071 ms |
| PG 18, `io_method = worker` | 10,051 ms |
| PG 18, `io_method = io_uring` | 5,723 ms |

`sync` mode exists as the compatibility fallback — it executes AIO-eligible operations synchronously, mirroring PG 17. `worker` is the default because it's portable and safe everywhere; `io_uring` requires a build flag (`--with-liburing`), Linux 5.1+, and kernels/containers that don't disable io_uring (many seccomp profiles still do — the reason it isn't default). `effective_io_concurrency`'s default jumped from 1 to 16 in the same release, since it now controls actual in-flight I/O depth rather than advisory hints.

Two operational caveats. First, **EXPLAIN ANALYZE's I/O timings now under-report**: the same 442k buffer reads showed 14.8s of I/O time on PG 17 but 7.2s on PG 18 worker mode — the counter measures *wait* time, and I/O workers' effort isn't attributed back the way parallel query workers' is. Second, wait-event monitoring changes shape: backends show a new `AioIoCompletion` wait while the `DataFileRead` events migrate to the I/O workers, and under io_uring much of the I/O never surfaces as a wait event at all. The new `pg_aios` view (in-flight I/Os with state, target, and byte counts) is the replacement lens.

## Why reads only

Writes are still synchronous in PG 18, and that's deliberate sequencing rather than difficulty dodging: checkpointer and bgwriter already batch and pace writes, so the latency win is smaller, while the correctness surface (WAL-before-data ordering across async completions) is larger. The README is explicit about where this is headed: async `fdatasync()` for WAL, eager WAL writes using a single FUA write under `O_DIRECT | O_DSYNC`, and — the real prize — production-viable direct I/O. `debug_io_direct` exists today but performs poorly without asynchrony, because direct I/O forfeits the kernel readahead and page cache that currently paper over synchronous reads. AIO is the prerequisite that makes bypassing the page cache — and its double-buffering tax — a serious option.

The broader lesson generalizes past PostgreSQL. Most AIO adoption stories (io_uring in particular) are told from single-address-space runtimes where the issuer owns its completions. The moment completions touch shared state that other actors block on, "who processes the completion" becomes a liveness question, and the answer — anyone must be able to — cascades into every representation choice: IDs instead of pointers, generations instead of handles, deferred errors instead of exceptions. PostgreSQL 18 is the rare production system that wrote that reasoning down.

## References

- [PostgreSQL AIO subsystem README](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/storage/aio/README.md)
- [PostgreSQL 18 docs: resource consumption / async I/O settings](https://www.postgresql.org/docs/18/runtime-config-resource.html)
- [pganalyze: Postgres 18 asynchronous I/O benchmarks](https://pganalyze.com/blog/postgres-18-async-io)
