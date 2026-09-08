---
title: "Colloid: Why Tiered Memory Should Balance Latencies, Not Chase Hot Pages"
date: 2026-09-08
tags: [memory-tiering, cxl, operating-systems, performance, queueing-theory]
excerpt: "Every tiered-memory system packs the hottest pages into the fastest tier. Colloid (SOSP 2024) shows this is wrong under contention: loaded latency on the 'fast' tier can exceed the slow tier's, and the fix is a binary search that balances per-tier latencies measured with Little's Law. My own queueing model reproduces the effect — placement gains nothing until the default tier congests, then latency balancing wins up to 2.16x."
---

Every tiered-memory system built in the last decade — TPP in the Linux kernel, HeMem, MEMTIS, and essentially every CXL-memory management proposal — shares one placement algorithm: track page hotness, then pack the hottest pages into the tier with the lowest hardware-specified latency until it's full. The mechanisms differ (PEBS sampling, PTE scanning, hugepage-aware histograms), but the policy is identical.

[Colloid](https://doi.org/10.1145/3694715.3695968) (SOSP 2024, Vuppalapati and Agarwal, Cornell) argues that policy is built on a false assumption: that the "fast" tier is actually fast when you're using it. The paper's fix is a page placement algorithm that ignores hardware-specified latencies entirely and instead balances *measured, loaded* latencies across tiers. It's a small idea with an elegant control loop, and it composes with the existing systems rather than replacing them — the authors integrated it into HeMem, TPP, and MEMTIS with the access tracking and migration machinery untouched.

## Unloaded latency is a spec-sheet number

The hardware-specified latency of DDR-attached DRAM (~70ns) versus cross-socket or CXL memory (~135–180ns) is an *unloaded* latency: one request in flight, empty queues. Real memory subsystems run with dozens of outstanding requests per core, and latency under load is unloaded latency plus queueing delay. The paper measures that recent CPU generations have made this dramatically worse — per-socket core counts grew faster than memory bandwidth, so Intel Sapphire Rapids can generate 4.5× more traffic than its channels service, and AMD Genoa 9.37×.

The consequence: under contention, the default tier's loaded latency can inflate 5× over its unloaded value. Given real CXL device latencies, that means the "fast" tier can be **2.5× slower than the slow tier** while every tiering system continues stuffing the hottest pages into it — actively concentrating load on the most congested resource. The paper measures HeMem, TPP, and MEMTIS landing 2.3×, 2.36×, and 2.46× below best-case throughput in this regime.

If you've done networking or load balancing, the failure mode is familiar: it's the same reason routing every request to the server with the fastest CPU stops working the moment that server saturates. Hotness-based placement is static routing; what's needed is load-aware routing.

## The principle: equalize loaded latencies

Colloid's placement rule is one sentence: move pages between tiers until the average loaded access latency of the default tier equals that of the alternate tier. Let `p` be the fraction of memory accesses served by the default tier. If `L_D < L_A`, promoting hot pages (raising `p`) shifts traffic onto the cheaper tier and lowers average latency. If `L_D > L_A`, demoting hot pages does. Average latency is minimized at the equilibrium `p*` where the two loaded latencies cross — which may be `p* = 1` (the classic policy) when the default tier has headroom, or well below 1 when it doesn't.

Two problems remain: measuring per-tier loaded latency cheaply, and finding `p*` without oscillating.

## Measurement: Little's Law at the CHA

There is no hardware counter that reports "current DRAM latency." Colloid derives it. On Intel servers, every L3 miss is queued at the Caching and Home Agent (CHA) until the target tier services it. The CHA exposes counters for queue occupancy and request arrivals, per request type and per tier — covering local DDR, cross-socket, CXL, and HBM. Sample occupancy `O` and arrival rate `R` over a quantum and Little's Law gives loaded latency with no assumptions about arrival or service distributions:

```
L_D = O_D / R_D        L_A = O_A / R_A
p   = R_D / (R_D + R_A)   # observed split, free from the same counters
```

This misses only the CPU-to-CHA hop (~5ns of a ~70ns unloaded path, and a shrinking fraction as load grows), can be sampled at microsecond granularity, and gets an EWMA for noise. Note the same trick also yields `p` directly — the control variable is observed, not estimated from page-hotness metadata.

## Control: binary search with escape hatches

Finding `p*` is a root-finding problem on a monotone-ish function you can only evaluate by actually migrating pages and waiting a quantum. Colloid runs a watermark-based binary search. `p_lo` tracks the highest `p` at which the default tier was still faster; `p_hi` the lowest at which it was slower; each quantum shifts placement toward the midpoint:

```python
p_lo, p_hi = 0.0, 1.0

def compute_shift(p, L_D, L_A, delta=0.05, eps=0.01):
    global p_lo, p_hi
    if abs(L_D - L_A) < delta * L_D:
        return 0.0                    # balanced: don't churn pages
    if L_D < L_A: p_lo = p            # promote side of p*
    else:         p_hi = p            # demote side of p*
    if p_hi < p_lo + eps:             # watermarks collapsed but still
        if L_D < L_A: p_hi = 1.0      # unbalanced: p* moved (contention
        else:         p_lo = 0.0      # changed) -- reset and re-search
    return (p_lo + p_hi) / 2 - p
```

The returned `Δp` is a *probability mass*, not a page count: the page finder then selects hot pages whose access probabilities sum to at most `Δp` (respecting a migration byte limit), reusing whatever tracking the host system already has. The `delta` deadband stops migration churn at equilibrium; the watermark reset handles the genuinely hard case — an external contention change moves `p*` outside `[p_lo, p_hi]`, which a plain binary search can never recover from. The reset re-widens the interval only on the side the latency comparison indicates, so convergence restarts from evidence rather than from scratch. Colloid detects workload-driven jumps in `p` for free, since `p` is re-measured every quantum before the watermarks update.

## Checking the shape with a queueing model

The claim worth verifying is the *regime structure*: latency balancing should be a strict no-op until the default tier congests, then win big. I modeled the paper's testbed as a closed-loop system — N outstanding requests, M/M/1-style loaded latency per tier (70ns default at 205GB/s, 135ns alternate at 75GB/s), an antagonist stream sharing the default tier — and ran both policies, with Colloid's algorithm operating on the model:

| Antagonist load | Hottest-first | Colloid `p*` | Gain |
|---|---|---|---|
| 0 GB/s | 45.5 GB/s | 1.00 | 1.00× |
| 60 GB/s | 32.2 GB/s | 1.00 | 1.00× |
| 120 GB/s | 18.9 GB/s | 0.25 | 1.23× |
| 160 GB/s | 10.0 GB/s | 0.00 | 2.16× |

Three things match the paper. Below the knee, Colloid converges to `p* = 1` — identical to the classic policy, which is why it's safe to deploy: it only deviates when deviating pays. Past the knee, `p*` collapses quickly (0.25 at 120GB/s of interference). And the worst-case gain, 2.16× in my model, sits right against the paper's measured 2.3× ceiling. The paper's full evaluation shows the same on real hardware: GUPS steady-state improvements of 1.2–2.35× across the three host systems under contention, within 3–13% of best-case placement everywhere, convergence in ~10 seconds after a contention step, and 1.05–2.12× on real applications (graph processing, Silo in-memory transactions, ML inference embedding lookups).

One subtlety my model surfaced: at extreme interference the latencies never balance — even `p = 0` leaves the default tier slower, because the antagonist alone congests it. Colloid handles this correctly by pegging at the boundary; equilibrium is a target, not an invariant.

## Why this generalizes

The deeper point is that "fast tier" is not a property of hardware; it's a property of hardware *under the current load*, and the load is partly your own placement decisions feeding back. Any system that routes work to resources using nameplate numbers — NUMA-aware allocators, HBM/DRAM splits on accelerators, storage tiering between NVMe classes — has the same failure lurking once the fast resource's queue grows. Colloid's recipe transfers directly: find a vantage point where queue occupancy and arrival rate are cheap to read, get latency from Little's Law, and drive placement with a deadbanded search that can re-open its interval when the world shifts under it. That the whole policy is ~15 lines wrapped around existing tiering systems, rather than a new tiering system, is the best part of the design.
