---
title: "L4S and DualPI2: Buying Sub-Millisecond Queues with a Squared Probability"
date: 2026-08-08
tags: [networking, congestion-control, linux-kernel, latency, aqm]
excerpt: "Bufferbloat has a fix nobody could deploy: mark congestion aggressively enough that queues stay under a millisecond. The problem is that any queue tuned that way starves every Reno and CUBIC flow sharing it. L4S solves the deployment problem with one algebraic trick, two queues fed by one controller whose output is squared for the legacy queue and scaled linearly for the new one. This post derives the coupling, then checks the RFC's reference parameters against the qdisc that actually shipped in Linux."
---

Bufferbloat has had a known cure for over a decade, and the cure has been undeployable. If you want a queue that stays under a millisecond under load, you have to signal congestion far more often than a Classic congestion control can tolerate. CUBIC needs a standing queue roughly proportional to its bandwidth-delay product to keep the pipe full, because it only learns about congestion once per loss event and then spends hundreds of round trips climbing back. Mark it every millisecond and it collapses. So AQMs like CoDel and PIE target 5 to 20 ms instead, and the tail latency you actually experience on a loaded link stays in the tens of milliseconds.

Data centres solved this years ago with DCTCP, which reacts proportionally to the *fraction* of packets marked rather than treating one mark as one loss, and holds queues under a millisecond. It is also unsafe on the public internet: put a DCTCP flow and a CUBIC flow in the same ECN-marking queue and DCTCP takes the link, with measured throughput imbalance reaching 25:1 in DCTCP's favour.

L4S, standardised in 2022 across RFC 9330 (architecture), RFC 9331 (the ECN identifier), and RFC 9332 (the DualQ Coupled AQM), is the answer to that deployment problem. Linux got a DualPI2 qdisc in 2025 (`net/sched/sch_dualpi2.c`, contributed by Nokia). The mechanism is worth understanding because the central idea is a single line of algebra doing a surprising amount of work.

## Two queues, one controller

The naive fix is per-flow queuing, FQ-CoDel style. L4S deliberately rejects it: per-flow queuing requires reading transport headers, which breaks under IPsec and any VPN, and is unavailable to link-layer schedulers such as those in 5G radio stacks. RFC 9331's identifier requirements demand something visible at the IP layer, transport-agnostic, and readable through outer encapsulation.

So the classifier is the ECN field's low bit. In the Linux enqueue path this is literally:

```c
/* dualpi2_skb_classify() */
cb->classified = DUALPI2_C_CLASSIC;          /* pessimistic default */
...
if (cb->ect & q->ecn_mask)                    /* ECT(1) or CE */
        cb->classified = DUALPI2_C_L4S;
```

ECT(1) and CE go to the low-latency **L queue**. Not-ECT and ECT(0) go to the **C queue**. A sender setting ECT(1) is making a claim: *my congestion control is Scalable, mark me as hard as you like.* Crucially, ECT(1) is not a request for better service that a selfish sender benefits from lying about, which is what makes an unprotected bit safe to trust. Lie about it and you get a queue that marks you at every millisecond of delay, and a Classic congestion control will back off to nearly nothing.

Both queues are driven by **one** PI2 controller measuring the *Classic* queue's delay, producing a base probability `p'`:

```
p' += alpha * (qdelay - target) + beta * (qdelay - qdelay_prev)
```

The integral term drags the queue toward `target`, the proportional term damps the approach. What makes DualPI2 interesting is not the controller but the two different functions applied to its single output.

## The squaring

RFC 9332's equation (1) is the whole architecture:

```
p_C = (p_CL / k)^2        with k = 2 RECOMMENDED
```

The Classic queue drops (or ECN-marks) at the *square* of the probability used to mark the L queue, divided by a coupling factor. Implemented as two stages: `p_C = (p')²` and `p_CL = k·p'`.

Why squaring? Because it cancels a square root that has been in the way since 1997. Reno's steady-state window is inversely proportional to the square root of drop probability. A Scalable control like DCTCP or TCP Prague holds an invariant number of marks per round trip, so its window is inversely proportional to `p` itself, not `sqrt(p)`. Write both out and couple them:

```
w_C ≈ sqrt(3/2) / sqrt(p_C)     Reno
w_L ≈ 2 / p_L                    Scalable, 2 marks per RTT
p_C = (p_L / k)^2  ⟹  sqrt(p_C) = p_L / k
⟹ w_C ≈ sqrt(3/2) · k / p_L
```

The `p_L` now appears to the first power on both sides. The square root is gone, and the window ratio is a constant independent of load:

```
w_C / w_L = sqrt(3/2) · k / 2
```

That is the trick in full. One AQM, two transfer functions, and the fairness ratio becomes load-invariant.

It is worth computing what that constant actually is, because the RFC only says `k = 2` makes the rates "roughly equal." Setting the ratio to 1 gives the window-fair coupling factor:

```
k_fair = 2 / sqrt(3/2) = 1.633
```

So the recommended `k = 2` is not the window-fair value. At `k = 2` the ratio is `sqrt(3/2) = 1.225`, meaning a Reno flow holds roughly a **22.5% larger window** than a Prague flow sharing the link at equal RTT. That is the size of "roughly" here, and the bias points toward the legacy traffic, the safe direction to err for an incrementally deployed mechanism. Both figures are only as good as their assumptions, the `sqrt(3/2)` Reno constant and DCTCP's two-marks-per-RTT invariant, but the direction and order of magnitude are solid. Linux's own source comments the `coupling_factor = 2` default with `/* window fairness for equal RTTs */`.

The implementation of the squaring is the nicest detail in the file. There is no multiply at all:

```c
static bool dualpi2_roll(u32 prob)
{
        return get_random_u32() <= prob;
}

/* dualpi2_classic_marking() */
if (dualpi2_roll(prob) && dualpi2_roll(prob)) {
        ...
}
```

Two independent Bernoulli trials at probability `p` fire together with probability exactly `p²`. No 64-bit multiply, no fixed-point rounding, exact per-packet Bernoulli(p²). It costs one extra RNG call. (Pedantically, `get_random_u32() <= prob` over `[0, 2³²-1]` gives `(prob+1)/2³²`, so `prob = 0` still fires once per four billion packets. At line rate that is irrelevant.)

Note also *where* the cap lives. RFC 9332 sets `p_Cmax = min(1/k², 1)`, which is 0.25 for `k = 2`. Linux enforces this on the base probability instead, `min_t(u32, new_prob, MAX_PROB / q->coupling_factor)`, capping `p'` at 0.5 so that `p_C = 0.25` and the coupled `p_L = k·p' = 1.0` simultaneously hit their ceilings. One clamp, both invariants.

## Where the shipped code diverges from the RFC

Reading RFC 9332's reference pseudocode next to the qdisc that shipped turns up three deliberate divergences.

**The L queue AQM is a step, not a ramp.** The RFC defaults to a ramp from `minTh = 800 us` over `range = 400 us`, so marking rises linearly to certainty at 1200 µs. Linux implements only a threshold, `q->step_thresh = 1 * NSEC_PER_MSEC` and a bare `qdelay > q->step_thresh` in `do_step_aqm()`. No ramp parameters exist. The RFC permits this ("can also be configured as a step function"), and a step is what DCTCP's original data-centre deployment used.

**The gains are hotter than the RFC's.** The RFC derives `alpha = 0.1·Tupdate/RTT_max²` and `beta = 0.3/RTT_max`, giving 0.15 Hz and 3.0 Hz at `Tupdate = 15 ms`, `RTT_max = 100 ms`. Linux picks `Tupdate = 16 ms` and encodes `alpha = 41/256 = 0.1602 Hz`, `beta = 819/256 = 3.199 Hz`. The alpha matches the RFC formula exactly for a 16 ms update period. The beta does not: `0.3/RTT_max` is 3.0 Hz regardless of `Tupdate`, so Linux's 3.2 Hz is the RFC value scaled by 16/15. Combined with the longer update period, the per-update proportional gain `beta·Tupdate` is 0.0512 versus the RFC's 0.045, about 14% higher. Slightly faster response, slightly less damping margin.

**Classic protection is 10%, not 1/16.** The RFC suggests a WRR weight around 1/16 for the C queue. Linux uses `dualpi2_calculate_c_protection(sch, q, 10)`, 10% for Classic and 90% for L4S, implemented as a signed credit whose sign selects the queue and which only moves when both queues are backlogged. The C queue's worst-case extra delay is bounded by the serialisation time of a handful of MTUs rather than by any timer.

## What you actually need to run it

The AQM is the easy half. The sender side needs a Scalable congestion control (TCP Prague, or BBRv3 in an L4S-capable mode) plus fine-grained ECN feedback, because original TCP ECN reported at most one mark per round trip, which cannot express a marking *fraction*. TCP needs Accurate ECN. QUIC already carries sufficient ECN counters in RFC 9000, which makes QUIC the far shorter path to deployment. RFC 9331 also requires, in uncontrolled environments, that a Scalable sender actively detect a non-L4S ECN bottleneck it might be sharing and fall back to Classic behaviour — the safety valve for the case where a single-queue ECN AQM sits somewhere on the path and the coupling does not exist.

That last requirement is the honest measure of the design. The queue math is clean and the target it achieves is real: sub-millisecond mean queuing delay with 1 to 2 ms at the 99th percentile, at full link utilisation, which is one to two orders of magnitude better than a CUBIC-tuned AQM. But the safety of the whole scheme rests on ECT(1) meaning what it claims on every bottleneck along the path, and the internet has a great many bottlenecks that have never heard of it.
