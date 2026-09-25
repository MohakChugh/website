---
title: "Per-VMA Locks, Take Two: Replacing a Semaphore With a Refcount and Letting VMAs Be Reused Under RCU"
date: 2026-09-25
tags: ["linux", "kernel", "concurrency", "rcu", "memory-management"]
excerpt: "Linux 6.4 broke mmap_lock's stranglehold on page faults with per-VMA locks built on rw_semaphores and sequence counts. Linux 6.15 threw the semaphore away. Because VMA readers never block and only one writer can exist, the lock collapses into a single atomic refcount with a writer bit — and marking the VMA slab SLAB_TYPESAFE_BY_RCU lets freed VMAs be reused before the grace period ends, turning the fault path into a lock-free lookup plus two atomic ops. Fault throughput at 21 threads improved 14.76%."
---

# Per-VMA Locks, Take Two: Replacing a Semaphore With a Refcount and Letting VMAs Be Reused Under RCU

Every address-space operation in Linux used to funnel through one lock. `mmap_lock` (né `mmap_sem`) is a per-process reader-writer semaphore: page faults take it for read, and `mmap()`, `munmap()`, `mprotect()` take it for write. For a single-threaded process this is invisible. For a process with a hundred threads faulting in its working set while other threads create thread stacks and TLS mappings, it's a pileup: every writer stalls every faulting thread, even when the fault and the mapping change touch completely unrelated address ranges.

This is not a synthetic concern. Android measured app launches — thread creation and demand faulting running concurrently — improving up to 20% once faults stopped contending with mapping changes. Speculative page faults (SPF) attacked this for years by retrying faults optimistically, but the patches were invasive and never merged. What did merge, in Linux 6.4 (2023), was Suren Baghdasaryan's per-VMA locks: a lock in each `vm_area_struct`, so a fault only synchronizes with writers of the *one* VMA it touches.

The 6.4 design was deliberately conservative. In Linux 6.15 (2025), the same author tore out its central component — a 40-byte `rw_semaphore` per VMA — and replaced it with a single atomic integer. The replacement is a nice case study in how two workload asymmetries let you shrink a general-purpose lock into something much cheaper, and in what it actually takes to make object reuse safe under RCU.

## The 6.4 design: sequence counts and a bulk unlock

The fault path since 6.4 looks like this: walk the maple tree under RCU to find the VMA covering the faulting address, try to read-lock that VMA, and if the trylock fails, fall back to the old world — take `mmap_lock` for read and redo the lookup.

Write-locking is where it gets clever. An operation like `vma_merge()` or `split_vma()` touches several VMAs, and tracking which ones to unlock, in what order, without recursion bugs, would be a mess. So there is no per-VMA write *unlock* at all. Two sequence numbers do the job:

- Writers already hold `mmap_lock` for write (that requirement never went away — per-VMA locks protect readers from writers, not writers from each other). To write-lock a VMA, the writer sets the VMA's `vm_lock_seq` equal to the mm's `mm_lock_seq`.
- A reader that sees `vm_lock_seq == mm_lock_seq` knows a writer owns this VMA and backs off.
- When the writer finally drops `mmap_lock`, one increment of `mm_lock_seq` implicitly write-unlocks every VMA it marked. Bulk unlock, O(1).

The actual reader exclusion — making a writer wait until in-flight faults drain out of a VMA — was handled by a per-VMA `rw_semaphore`. And that semaphore is what the 6.15 series killed.

## Two asymmetries collapse the lock

A general rw_semaphore supports blocking readers, multiple queued writers, fairness, optimistic spinning. The VMA lock needs almost none of that, because of two properties of how it's used:

1. **Readers never wait.** A fault that fails the trylock doesn't spin or sleep on the VMA lock — it falls back to `mmap_lock`. Reader-side blocking: unnecessary.
2. **There is only ever one writer.** Writers serialize on `mmap_lock` first. Writer-writer contention: impossible.

Given those, the lock plus the separate `detached` flag (tracking whether the VMA is still in the tree) collapse into one refcount, `vm_refcnt`:

- `0` — detached: not in the VMA tree, nobody may lock it.
- `1` — attached, no readers.
- `1 + n` — attached, `n` faults in flight.
- Bit `0x40000000` (`VMA_LOCK_OFFSET`) — a writer has claimed the VMA.

The state machine in pseudo-C:

```c
/* reader (page fault) */
static bool vma_start_read(struct vm_area_struct *vma)
{
    int old = atomic_read(&vma->vm_refcnt);

    /* detached, writer present, or about-to-overflow: fall back */
    if (old == 0 || (old & VMA_LOCK_OFFSET))
        return false;
    return atomic_try_cmpxchg_acquire(&vma->vm_refcnt, &old, old + 1);
}

/* writer (already holds mmap_lock for write) */
static void vma_start_write(struct vm_area_struct *vma)
{
    atomic_add(VMA_LOCK_OFFSET, &vma->vm_refcnt);
    /* wait until refcnt == VMA_LOCK_OFFSET + 1: attached, zero readers */
    rcuwait_wait_event(&vma->vm_mm->vma_writer_wait, ...);
    vma->vm_lock_seq = mm->mm_lock_seq;   /* seq scheme still does bulk unlock */
}
```

The last reader to decrement wakes the (single, known) writer through an `rcuwait` on the mm — no wait queues, no lock-internal spinlock. Refcount overflow from a stampede of readers is handled the same way as any other trylock failure: the reader gives up and takes `mmap_lock`. When your readers are allowed to fail, an entire class of lock machinery evaporates.

There's a satisfying epilogue to the layout story too. The semaphore had originally been moved *out* of `vm_area_struct` into its own cache because embedding it regressed benchmarks through false cacheline sharing. Re-investigation found the regression was specific to an aging Broadwell microarchitecture and its adjacent-cacheline prefetcher. So the lock moved back inline — deleting a pointer dereference from every fault — and with the semaphore gone, the struct's members were regrouped from 256 bytes into three cachelines, under 192 bytes.

## SLAB_TYPESAFE_BY_RCU: reuse before the grace period

The refcount unlocked the more consequential change. The VMA slab cache is now `SLAB_TYPESAFE_BY_RCU`, which weakens the usual RCU-freeing contract: a freed object's *memory* won't return to the page allocator while readers are in RCU critical sections, but the slab may **reuse it as a new VMA immediately**, before any grace period. No `call_rcu()` per VMA, no grace-period latency between free and reuse, better slab locality.

The cost is that a lock-free reader can no longer trust identity. `lock_vma_under_rcu()` might find a VMA in the maple tree, get preempted conceptually for a moment, and by the time it takes the reference, that memory is a different VMA in a different process. Type-stable reuse is safe only if readers validate after acquiring:

```c
vma = mas_walk(&mas);                  /* RCU lookup in the maple tree */
if (!vma_start_read(vma))              /* refcount acquire, or bail */
    goto fallback;
/* memory may have been reused: is this still the VMA we looked up? */
if (vma->vm_mm != mm ||
    address < vma->vm_start || address >= vma->vm_end) {
    vma_end_read(vma);
    goto fallback;
}
```

Making that validation sound required closing genuinely subtle holes:

- **Detach before free, always.** A reader can only acquire a VMA whose `vm_refcnt` is nonzero. If every VMA is marked detached (refcnt 0) before freeing, a racing reader that finds stale memory simply fails the acquire. One path violated this: `exit_mmap()` skipped detaching, reasoning that nobody could reach those VMAs anymore. Under reuse-before-grace-period, somebody can. Fixed.
- **Don't copy the refcount.** `vm_area_dup()` used to `memcpy` the whole struct — including `vm_refcnt`, momentarily making a fresh, not-yet-inserted VMA look attached. A racing reader that had found the old object could acquire the new one by accident. A new `vm_area_init_from()` copies everything *except* the refcount, which stays 0 until the VMA actually enters the tree.
- **Publish with a release fence.** `vma_mark_attached()` sets the refcount with release semantics, so a reader's acquire on `vm_refcnt` observes fully initialized fields. The refcount is the publication point, exactly like the classic RCU pointer-publish pattern — just with a counter instead of a pointer.

This is the same discipline `struct file` has used with `SLAB_TYPESAFE_BY_RCU` for two decades: lookup, speculative refcount acquire, revalidate identity, retry. The VMA work is a textbook modern application of it.

## What it bought

The `pft` page-fault microbenchmark, before vs. after the 6.15 series:

| threads | faults/cpu delta | faults/sec delta |
|---|---|---|
| 4 | +0.46% | +0.34% |
| 21 | **+14.76%** | +14.77% |
| 30 | +13.05% | +10.26% |
| 56 | +11.89% | +10.85% |

Flat at low thread counts, double-digit gains once contention matters — which is the honest shape for a synchronization change: it removes queueing, not work.

Three transferable lessons. First, audit your lock against how it's *actually* used: "readers may fail" and "writers are externally serialized" turned a 40-byte semaphore into 4 bytes and made the uncontended fault path two atomic operations. Second, sequence-count bulk-unlock is a beautiful trick whenever one writer marks many objects — release them all with one increment. Third, `SLAB_TYPESAFE_BY_RCU` is the high-performance end of the RCU spectrum, but its contract is unforgiving: every free must be preceded by an observable "dead" state, every copy must avoid resurrecting liveness bits, and every reader must revalidate identity after acquire. The kernel got all three wrong on the first pass in at least one code path each — in a subsystem maintained by people who do this for a living. Budget review time accordingly.
