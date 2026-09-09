---
title: "Skyloft: Preemptive Scheduling Every 5 Microseconds, Entirely in User Space"
date: 2026-09-09
tags: [operating-systems, scheduling, tail-latency, x86, low-latency]
excerpt: "Skyloft (SOSP 2024) uses Intel's user interrupts to build a user-space scheduler that preempts tasks every 5µs — a quantum 200x finer than a Linux tick. I pulled the paper's raw result files from the artifact repo and recomputed the headline: 5µs preemption lifts RocksDB goodput at a fixed tail-latency SLO from 20.1 to 37.4 kRPS, and a cross-thread POSIX signal on my own machine costs 5.4µs median — more than the entire quantum."
---

A RocksDB GET served from memory takes a few microseconds. A scan over a range of keys takes hundreds. If both request types share worker cores, the scans stall the GETs and your 99.9th-percentile latency explodes — unless the scheduler can interrupt a scan mid-flight and hand the core to a queued GET. That requires preemption at microsecond granularity, and nothing in a stock OS provides it: the Linux scheduler tick fires every 1–4 ms, and delivering a POSIX signal — the only portable way to interrupt a running user thread — costs several microseconds by itself.

[Skyloft](https://dl.acm.org/doi/10.1145/3694715.3695973) (Jia, Tian, You, Chen, and Chen, SOSP 2024) is the first general user-space scheduling framework built on x86 *user interrupts* (UINTR), the hardware feature Intel shipped in 4th-gen Xeon Scalable (Sapphire Rapids). With user interrupts, one core can interrupt another core's user-mode execution without the kernel touching the delivery path. Skyloft uses that to run a full preemptive scheduler — CFS, EEVDF, round-robin, and centralized single-queue policies are all implemented in its [artifact repo](https://github.com/yhtzd/skyloft) — with quanta as small as 5µs.

## Why signals can't do this

Every prior user-level scheduler hits the same wall. Non-preemptive runtimes (Go pre-1.14, most green-thread libraries) rely on tasks yielding at function calls or allocations; a tight loop or a long RocksDB scan never yields. Shinjuku got microsecond preemption by dedicating hardware to it — posted IPIs from inside a Dune/VT-x sandbox. Shenango and Caladan preempt with kernel signals and pay for it, so they keep quanta coarse. ghOSt moves policy to user space but leaves the preemption mechanism (kernel IPIs) in the kernel, with tens-of-microseconds round trips.

The cost of the signal path is easy to reproduce. The Skyloft repo has a microbenchmark (`microbench/signal_delivery.c`) that measures cross-thread send-to-handler latency; I ported it to my own machine (Apple M-series, macOS — different ISA, same POSIX machinery):

```
signal send+delivery: avg 6735 ns, p50 5375 ns, p99 28708 ns
```

A median of 5.4µs and a p99 of ~29µs. If your scheduling quantum is 5µs, the *mechanism* for enforcing the quantum costs more than the quantum itself, before the handler runs a single instruction of scheduler code. Intel's own numbers for the uintr kernel patches claim roughly 9x cheaper delivery than a signal, because the hardware does everything: no trap into the kernel on the sender, no signal-frame setup by the kernel on the receiver.

## What the hardware gives you

UINTR is a small, sharp primitive. A receiver thread registers a handler; the kernel (via a one-time syscall) points a per-thread *User Posted Interrupt Descriptor* (UPID) at it. A sender with permission executes one instruction:

```c
_senduipi(uintr_index);   // post user interrupt; hardware delivers it
```

If the target thread is running in user mode on any core, the CPU vectors it directly to the handler — no kernel involvement. The handler is ordinary user code with an interrupt ABI:

```c
static void __attribute__((interrupt))
__attribute__((target("general-regs-only")))
uintr_handler(struct __uintr_frame *frame, unsigned long long vector)
{
    /* Skyloft: save context, jump into the user-space scheduler */
}
```

(Both snippets are from Skyloft's microbenchmarks, verbatim.) If the target isn't currently running, the interrupt stays posted in the UPID and is delivered when the thread next runs — which is exactly the semantics a scheduler wants.

## The architecture

Skyloft is a libOS-plus-kernel-module design. Worker threads run application tasks inside per-CPU run queues; scheduling policy is a plugin (`libos/sched/policy/` contains `cfs.c`, `eevdf.c`, `fifo.c`, `rr.c`, and two single-queue variants). Preemption arrives as a user interrupt, and the handler performs the context switch in user space — save registers, pick next task, swap stacks.

Who sends the interrupt? Two designs, both in the repo. In the centralized policies, the dispatcher core tracks each worker's quantum and fires `_senduipi` on expiry. The alternative is `utimer`: a dedicated timekeeper core that spins over per-CPU deadlines:

```c
while (true) {
    for (i = 0; i < proc->nr_ks; i++) {
        if (now_ns() > utimer.deadline[i]) {
            _senduipi(utimer.uintr_index[i]);
            utimer.deadline[i] = now_ns() + NSEC_PER_TICK;
        }
    }
}
```

This is the DPDK trade: burn one core polling so that N cores get microsecond-precision preemption with zero kernel transitions. Skyloft's evaluation isolates 24 cores (`isolcpus`, `nohz_full`), runs its own DPDK network stack, and treats the machine like an appliance — this is not a general-purpose desktop scheduler.

## Recomputing the results from the raw data

The artifact repo ships the paper's raw result files under `paper_results/`, so instead of quoting figures I recomputed them.

**schbench (Figure 4/5 data).** The wakeup-latency experiment shows why user-space scheduling matters even without preemption. On 24 isolated cores, Linux CFS keeps p99 wakeup latency at 8–20µs while runnable threads fit in the cores — then cliffs the moment they don't: 17µs at 24 threads, **2,340µs at 32**, growing to 25.6ms at 256. Skyloft's user-space CFS at the same points: 4µs, 34µs, and ~120µs at 96 threads (58x below Linux's 7,048µs there), at within ~6% of Linux's throughput. The cliff is the cost of the kernel's wakeup path and tick-granularity load balancing; a scheduler that lives where the tasks live just doesn't have it.

**RocksDB quantum sweep (Figure 7b data).** The server runs 50% GETs (~6µs) and 50% SCANs (~600µs); the metric is 99.9th-percentile *slowdown* (latency ÷ ideal service time), and the paper draws its SLO line at 50. I computed the maximum load each variant sustains under that line:

| Configuration | Goodput @ p99.9 slowdown ≤ 50 |
|---|---|
| Shenango | 17.5 kRPS |
| Skyloft, no preemption | 20.1 kRPS |
| Skyloft, 100µs quantum | 20.0 kRPS |
| Skyloft, 20µs quantum | 27.6 kRPS |
| Skyloft, 10µs quantum | 32.6 kRPS |
| Skyloft, 5µs quantum | **37.4 kRPS** |
| Skyloft, 5µs via utimer | 30.0 kRPS |

Two things the summary numbers hide. First, a 100µs quantum is worth nothing here — it matches no-preemption, because a 600µs scan blocking a 6µs GET for "only" 100µs still blows a slowdown-of-50 budget for the GET. The quantum has to be commensurate with the *short* request's service time, not the long one's. Second, preemption isn't free at low load: at ~2.5 kRPS the 5µs config shows a p99.9 slowdown of 34.9 versus 24.9 for 10µs — every 5µs tick spends handler cycles that pure FCFS wouldn't. The 5µs quantum only wins where it matters, at the high-load end, where it buys 15% more goodput than 10µs and 86% more than no preemption.

## Caveats

The delivery path has real limits. User interrupts only deliver while the target is in user mode; a task blocked in a syscall gets the interrupt on return, so Skyloft pairs UINTR with kernel-bypass I/O to keep workers out of the kernel. It's Intel-only for now (Sapphire Rapids onward; AMD has no equivalent), the uintr Linux patches remain out-of-tree — Skyloft runs on a patched 6.0 kernel — and the design spends dedicated cores (dispatcher, timekeeper, I/O) that only pencil out on machines serving one latency-critical application. And the utimer row in the table shows delivery topology matters: routing all preemptions through one spinning timekeeper core costs ~20% goodput versus dispatcher-driven sends.

The interesting general lesson is the division of labor. Twenty years of research moved scheduling *policy* to user space; the mechanism — forcing a core to stop what it's doing — stayed privileged, and its cost dictated every design above it. UINTR makes the mechanism a one-instruction user-space primitive, and Skyloft shows the whole stack that becomes buildable once it is: per-CPU schedulers with 5µs quanta, microsecond-scale LC/BE core reallocation, and a fair-share policy that matches CFS semantics at 1/200th the tick.
