---
title: "Who Ran While You Waited? Culprit-Attributed CPU Contention on Stock Kernels"
date: 2026-09-03
tags: [linux, ebpf, scheduling, observability, containers]
excerpt: "Every CPU contention signal Linux exposes is victim-side: PSI, schedstat wait_sum, runqlat. They tell you a container waited; none of them names who it waited for. SchedBlame inverts the accounting and squeezes an entire row of a competitor x victim blame matrix into one 16-byte record. I checked its arithmetic, then simulated the one approximation it accepts — and the error is not symmetric the way the paper argues."
---

You collocate containers to recover the utilization that strict isolation wastes. One day a service's p99 doubles, and the only question that matters is about a *different* container: who took my CPU?

Linux will not tell you. `cpu.pressure` gives the time a cgroup's tasks were stalled on CPU; `schedstat`'s `wait_sum` accumulates run-queue wait per entity; `cpu.stat` reports quota throttling; `runqlat` renders wait as a histogram. Every one of them measures the victim. The identity of whoever occupied the CPU was available at that instant — it is `rq->curr` — but no accounting path records it, because recording it means recording a *relationship*, and a relationship has no natural home in a per-cgroup counter file.

[SchedBlame](https://arxiv.org/abs/2609.02052) (Li, Zhang, and Wang, Sept 2026) closes that gap on unmodified 4.18 and 5.10 kernels, continuously, for about 1% of Redis throughput. It is worth studying even if you never run it, because it is a small masterclass in getting a cross product off a hot path.

## Blame the runner

The reframing is one sentence: contention is a property of the CPU, not of the waiting task. If a container is runnable on CPU *k* and is not running, somebody else is, and that somebody is responsible. For competitor cgroup `c` and measured cgroup ("target") `t`, blame is the time integral of their coincidence:

```
B(c, t) = sum over CPUs k of  integral [ rho_k(tau) == c ] * w_kt(tau) dtau,   c != t

  rho_k(tau)  = cgroup running on CPU k at time tau
  w_kt(tau)   = 1 if t has a runnable task on CPU k that is not running
```

Units are CPU-nanoseconds and it reads directly: how much CPU `c` consumed while `t` was waiting for a CPU it could have used. Sum over competitors for external contention `E_t`; the individual terms rank the culprits. The same integral with `c == t` is something else entirely — the target running on one CPU while another of its own tasks queues there — so it is kept separately as internal contention `I_t`. Nobody should be paged for their own parallelism.

That yields a four-way decomposition of each target's per-second demand, where every unit falls in exactly one bucket:

```
D_t = R_t + I_t + E_t + T_t        r_t = E_t / D_t
      ran   self   others  throttled
```

`r_t` is the reportable number: the fraction of wanted CPU that external competition took. Unlike a raw wait time or a preemption count it has a denominator, so it is comparable across a 2-core batch job and a 32-core service.

## Getting the cross product off the hot path

Enumerating a cross product is exactly what a scheduler hook must not do. Two observations make `B(c, t)` constant-cost.

**The two sides are asymmetric.** Anything can be a culprit, so the competitor space must be large — SchedBlame names competitors by the kernel's sparse CSS ID, 12 bits, 4096 concurrent task groups. But *which* cgroups you measure is a monitoring choice, so that set can be small and densely numbered. Make each target's dense ID literally a bit position and "which targets are waiting on CPU k" becomes one or two machine words.

**Blame is a property of the ending boundary.** The inner integral is piecewise constant, because `rho_k` changes only at a context switch. So a switch delimits a *slice*: one cgroup, one CPU, one interval. Stamp the slice with that CPU's waiting bitmap as it ends, and a single record charges one competitor against every victim behind it — an entire row of the blame matrix, with no per-pair state in the kernel:

```
bits    field                          width
0-11    competitor CSS ID                12
12-31   waiting targets 0..19             20
32-63   slice duration (ns)               32
        + extra * 64 bits: targets 20..M-1
```

One 64-bit word for identity, duration and the first 20 targets; one extension word for the next 64. Default `extra = 1` gives `M = 84` targets in 16 bytes. The 32-bit duration saturates at 4.295 s rather than wrapping, and since the dense ID is a byte, `extra <= 3` caps the design at 212 targets.

Three properties fall out, and they are what make this deployable rather than merely correct.

**Slices are self-describing.** Each record carries the snapshot it should be attributed against, so userspace holds no waiting state and never replays a transition stream. A dropped perf record costs exactly the CPU time in those slices; the next one arrives with a fresh snapshot and attribution is immediately correct again. No design that *reconstructs* waiting from an event stream can say that.

**Reconfiguration is a constant-time publication.** Each cached `css_id -> dense` entry is one aligned 64-bit word, `(epoch << 32) | dense_id`, valid only if its epoch matches the current global. Bumping that global invalidates every cache entry and every per-CPU bitmap at once — no scan, no drain, no pausing hooks that run inside the scheduler's critical section. That works only because the waiting state is *derived*, not accumulated: SchedBlame never counts enqueues and dequeues, it re-reads `h_nr_running`, the kernel's own per-cgroup runnable count, which still includes the entity the scheduler picked — so `n >= 2` on a CPU you own means a sibling is queued behind you. A lost update is repaired by the next observation instead of corrupting an accumulator.

**Sampling cannot buy cost with correctness.** The keep/discard decision happens *before* the snapshot copy and gates no state update; bitmap maintenance is unconditional. Userspace divides each retained duration by `p` — Horvitz-Thompson: unbiased, `Var = ((1-p)/p) * sum(d_i^2)`, so for equal-duration slices the relative standard error is `sqrt((1-p)/(p*n))`, 9.5% at `p = 0.1`, `n = 1000`. Precision scales with slice count, so it peaks exactly during contention. Where the sampled stream *is* the state stream, dropping corrupts the model and forces load-correlated dropping; here it stays uniform.

Every figure reproduces: the bitfield sums to 64, the charge matrix is 2.625 MiB at `4096 x 84 x 8`, and `C=64, f=2000, p=1` gives 128K slices/s = 2.048 MB/s in 1000 perf records/s. One nit: §4.7 calls a full batch 2072 bytes, §6.2 budgets a 2056-byte slot.

## The approximation I do not think is symmetric

The paper is unusually honest — it ships a taxonomy of every approximation it accepts — and the one worth testing is A2: a slice is attributed using the waiting state at its **end**, applied to its full duration. The claim is that "a target that wakes mid-slice is charged for the whole slice; one that stops waiting mid-slice is charged for none of it," so the error is bounded by one slice per transition and "unbiased in direction over many transitions."

That cancellation requires waits to *begin* and *end* mid-slice with equal frequency. They don't. A wait begins on a wakeup or a migration, which lands anywhere inside a slice. A wait ends when the scheduler picks the victim — and that **is** a context switch, a slice boundary, by construction. Over-charges have nothing to cancel against.

I simulated one CPU (60 s, exponential sleep/run, victim woken ~450x/s) three ways, against the true integral of the waiting indicator:

| regime | slice | true E | reported E | ratio |
|---|---|---|---|---|
| waiting independent of switch grid (control) | 1–12 ms | — | — | 0.991–1.000 |
| wakeup waits out the current slice | 1 ms | 196 ms/s | 363 ms/s | 1.86 |
| wakeup waits out the current slice | 12 ms | 818 ms/s | 981 ms/s | 1.20 |
| wakeup preempts immediately (20 us latency) | 3 ms | 8.9 ms/s | 514 ms/s | 58x |
| long-waiting batch victim | 6 ms | 947 ms/s | 987 ms/s | 1.04 |

The control confirms the paper's intuition where it applies: decouple the waiting indicator from the switch grid and the estimator is unbiased, variance growing with slice length. Couple them the way CFS does and the inflation follows a closed form the paper never states:

```
reported / true  =  1 + E[slice age at bit-set] / E[true wait]
```

At 1 ms slices the simulator measured `E[age] = 461 us` against `E[residual wait] = 539 us`, predicting 1.855 versus a measured 1.855; the 3/6/12 ms rows match to three digits too. Everything follows from that ratio. A batch victim waiting tens of milliseconds per episode has `age << wait` and gets the 1–4% error the paper describes. A latency-sensitive victim whose wakeup preempts immediately waits only the wakeup latency, so `age >> wait` and essentially every co-tenant slice on that CPU is charged to it — 58x here, asymptotically "all co-tenant runtime." Fidelity degrades precisely against the interactive containers the tool exists to protect.

Two things soften it. The alert rule compares `r` against `K * P99(r)` over a rolling 600-sample history, and a *constant* multiplicative bias cancels on both sides — detection survives what absolute interpretation does not. But the factor is not constant: it moves with wakeup rate and slice length, both of which move with load, so a load shift alone can trip the rule. And cross-container comparison, the whole point of a normalized ratio, is unprotected.

The fix lives inside the design's own idiom. If blame is a property of the ending boundary, a bitmap *transition* should be a boundary too: have the wakeup hook close and stamp the in-progress slice before setting the bit. That costs one extra record per wakeup-preemption — the case where the scheduler is about to switch anyway — and bounds A2's error by mid-slice *ends* alone, the rare direction.

## When to believe the number

Real-time and deadline tasks consume CPU a victim waits for and are invisible here. Shared-cache, memory-bandwidth and SMT interference are outside the model by design — those need hardware counters. And the sharpest scoping condition is the authors' own H1: throttling applied to an *ancestor* cgroup is not propagated, so time your parent's quota forbade you is reported as external contention, blaming neighbors for your own configuration.

None of which diminishes the core trick. A 16-byte record that fills a matrix row, an epoch bump that invalidates a fleet of per-CPU caches without touching them, and a sampling knob that trades variance for cost and nothing else — that is what "continuously on" has to mean, and it needs no kernel patch at all.
