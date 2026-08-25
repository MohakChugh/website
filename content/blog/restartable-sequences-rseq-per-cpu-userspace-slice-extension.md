---
title: "Restartable Sequences: Per-CPU Data Structures Without Atomics"
date: 2026-08-25
tags: [linux-kernel, concurrency, lock-free, abi, allocators]
excerpt: "A per-CPU free list needs no atomics — but userspace cannot safely read \"which CPU am I on\" and then act on the answer, because the scheduler can migrate you between the two. rseq closes that gap by letting the kernel rewind your instruction pointer. Then Linux 6.19 made rseq 15% faster and instantly broke every TCMalloc binary on the planet."
---

The cheapest concurrent data structure is one that isn't concurrent. If a free list belongs to exactly one CPU, pushing onto it is two plain stores — no `lock cmpxchg`, no cache line ping-pong, no memory fence. This is why per-CPU allocation caches are the standard design in every serious malloc.

Inside the kernel this is trivial: disable preemption, read `smp_processor_id()`, touch your per-CPU data, re-enable. Userspace has no such button. And without it, the whole design collapses on a single race:

```c
int cpu = sched_getcpu();       // returns 3
// ---- scheduler migrates this thread to CPU 7 ----
freelist[cpu].push(ptr);        // corrupts CPU 3's list from CPU 7
```

You cannot fix this with a fence, a retry loop, or a seqlock, because there is no point at which userspace can *observe* the CPU number and *commit* an action atomically with respect to migration. The information is stale the instant you read it, and you can't tell.

**Restartable sequences** (`rseq()`, Mathieu Desnoyers, merged in Linux 4.18) solve it by inverting who is responsible. Userspace doesn't try to prevent migration. It declares a range of instructions to the kernel and says: *if you preempt, migrate, or signal me anywhere inside this range, throw away my work and send me to this other address instead.*

## The ABI

A thread registers a `struct rseq` in its own TLS. The kernel writes some of it; userspace writes the rest. The fields that matter (`include/uapi/linux/rseq.h`):

```c
struct rseq {
    __u32 cpu_id_start;  // kernel-written: always a plausible CPU number
    __u32 cpu_id;        // kernel-written: CPU, or a negative sentinel
    __u64 rseq_cs;       // user-written: pointer to the active descriptor, or NULL
    __u32 flags;         // kernel-written: feature advertisement
    __u32 node_id;       // kernel-written: current NUMA node
    __u32 mm_cid;        // kernel-written: concurrency ID, unique within the mm
    struct rseq_slice_ctrl slice_ctrl;
    __u8  __reserved;
    char  end[];
} __attribute__((aligned(32)));
```

`rseq_cs` points at a link-time-constant descriptor — cache-line aligned so the kernel can read it without a second fault:

```c
struct rseq_cs {
    __u32 version, flags;
    __u64 start_ip;            // first instruction of the critical section
    __u64 post_commit_offset;  // length; CS is [start_ip, start_ip + this)
    __u64 abort_ip;            // where to resume if interrupted
} __attribute__((aligned(4 * sizeof(__u64))));
```

The protocol, in x86-64 assembly, is roughly:

```asm
    /* Publish the descriptor. One store. Not atomic — it doesn't need to be,
       because only this thread and the kernel-on-this-CPU ever read it. */
    movq  $push_cs, %fs:__rseq_abi@tpoff+8      /* rseq->rseq_cs = &push_cs */
1:  movl  %fs:__rseq_abi@tpoff, %eax            /* cpu = rseq->cpu_id_start   */
    shlq  $SLAB_SHIFT, %rax
    addq  slab_base(%rip), %rax                 /* &slab[cpu]                 */
    movq  (%rax), %rcx                          /* head                       */
    movq  %rcx, (%rdi)                          /* obj->next = head           */
    movq  %rdi, (%rax)                          /* COMMIT: slab[cpu].head=obj */
2:  jmp   done

    .long RSEQ_SIG                              /* mandatory guard word */
3:  jmp   push_slowpath                         /* abort_ip */
```

Two details carry all the weight.

**The commit is the last instruction.** Everything before it is speculative scratch work. If the thread is descheduled at instruction 1, or 2, or anywhere between, the kernel clears `rseq_cs` and sets `regs->ip = abort_ip` on the way back to userspace. The commit store never executed, so there is nothing to undo. If the thread reaches the commit, it was demonstrably not migrated since it read `cpu_id_start` — the store landed on the right CPU's slab. This is optimistic concurrency control where the rollback log is *empty by construction*.

**`RSEQ_SIG` is a security control, not a formality.** `abort_ip` is an attacker-influenced jump target: anyone who can write your `struct rseq` can redirect the instruction pointer. The kernel therefore reads the four bytes immediately *preceding* `abort_ip` and refuses the jump unless they equal a per-architecture magic constant, chosen to be an invalid or trapping instruction. It's a coarse control-flow-integrity check that makes rseq useless as a general ROP primitive.

## The part that isn't about CPU numbers

Two fields are pure ride-alongs, and they're arguably more used than the restart machinery. `node_id` turns NUMA-aware allocation into a TLS load. And `mm_cid` — *concurrency ID* — is subtler: it's a dense integer unique among the currently-running threads of the process, bounded by `min(nr_threads, nr_cpus)` rather than by the machine's CPU count. On a 512-core box running a 4-thread process, per-CPU arrays waste 508 slots; `mm_cid` gives you 4. It is the right index for anything you were tempted to size by `nr_cpus`.

## Time slice extension: asking the scheduler to wait

Merged for Linux 7.0, this is the newest piece and it attacks a different problem: **lock-holder preemption**. A thread takes a contended userspace lock, gets descheduled 200ns later, and every waiter now blocks for a full scheduling quantum. No amount of clever lock design fixes this; the holder simply isn't running.

The new mechanism lets a thread ask for a few extra microseconds. It is not a syscall — it's two bytes in the shared struct:

```c
rseq->slice_ctrl.request = 1;
barrier();
critical_section();               /* holds the contended lock */
barrier();
rseq->slice_ctrl.request = 0;
if (rseq->slice_ctrl.granted)
    rseq_slice_yield();          /* pay back the borrowed time */
```

If a timer interrupt raises a reschedule request while `request` is set, the kernel may clear `request`, set `granted = 1`, and return to userspace instead of switching away. All of this is CPU-local, so no atomics and no fences are required — and the `granted` test is deliberately racy, since a revocation landing between the test and the yield is harmless.

The guardrails are what make it shippable. The extension is 5µs by default and capped at 50µs (`debugfs:rseq/slice_ext_nsec`), because the ceiling *is* your minimum scheduling latency. A kernel timer is armed so a thread that never yields loses the CPU anyway. Any syscall other than `rseq_slice_yield()` during the granted window revokes the grant immediately on kernel entry — otherwise, under `PREEMPT_NONE`, a single `read()` could stretch a 5µs favor into milliseconds. And inconsistent flag state gets you a `SIGSEGV`.

## Hyrum's Law, in production, at kernel scale

Now the interesting failure. Before Linux 6.19, the kernel wrote `cpu_id_start` on *every* return to userspace, migration or not. Writing to userspace memory means toggling SMAP-style protections off and back on, which is expensive. Skipping redundant stores bought roughly **15%** on many workloads, and violated no documented guarantee: the field is specified as read-only to userspace and merely "always a valid CPU number."

TCMalloc had built a load-bearing signal out of the redundant store. It overlays its own structures on `struct rseq` such that `cpu_id_start` occupies the upper four bytes of an internal cached-slab pointer, and it *writes* that field — setting the high bit, so the aliased value is not a plausible CPU number. Any kernel store clears that bit. TCMalloc therefore reads one word and learns "was I descheduled at all since I cached this pointer?" — a strictly stronger signal than "was I migrated," and one the ABI never offered. On 6.19 the signal stopped arriving and applications collapsed.

This was known to be fragile: TCMalloc's own docs admit the trick "makes `__rseq_abi.cpu_id_start` unusable for its original purpose," which is why TCMalloc binaries must disable glibc's rseq use (glibc has registered since 2.35) via an environment variable. It was reported as a bug in 2022. A kernel extension to let TCMalloc stop clobbering the field was proposed and never adopted.

Thomas Gleixner argued this wasn't a regression — the documented contract held. Linus Torvalds: *"This is not some kind of gray area. It clearly violates our regression rules."* Gleixner accepted, warning the precedent means "a single abuser can then rightfully own a general shared interface of the kernel forever."

The fix is the most interesting artifact in the whole story. `rseq()` takes a pointer *and a size*, so the size becomes a version negotiation channel. The required feature size was bumped from 32 to **33 bytes** — the sole purpose of that `__u8 __reserved` field — which in turn forces 64-byte alignment. Register with 32 bytes, or misaligned, and you get pre-6.19 semantics: unconditional writes, no read-only enforcement, and no time slice extension. Register 33-plus bytes aligned to 64 and you get the fast path. TCMalloc's overlay makes 64-byte alignment impossible, so it lands on the legacy path automatically, with no changes to TCMalloc or glibc. Callers that query `getauxval(AT_RSEQ_FEATURE_SIZE)` and `AT_RSEQ_ALIGN` — glibc 2.41+ — get full speed for free.

That is a genuinely elegant escape: opt in to the new semantics by proving you understand the new layout. It's also a warning worth internalizing. The behavior TCMalloc depended on was undocumented, un-promised, and obviously accidental — and it still won, because *working binaries outrank clean interfaces*. If you ship a shared ABI, every observable side effect is part of it whether you wrote it down or not.
