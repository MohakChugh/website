---
title: "Prequal: The Load Balancer That Wins by Not Balancing Load"
date: 2026-08-03
tags: [load-balancing, distributed-systems, tail-latency, rpc, scheduling]
excerpt: "Weighted round-robin can hold every replica's CPU inside its allocation on a one minute chart and still time out a quarter of your queries. Prequal (NSDI '24) replaces load equalization with a probe pool and a two signal lexicographic rule, cutting YouTube tail latency 2x and driving errors at 1.74x allocation from 25 percent to exactly zero. The interesting part is why the near perfect load balancer is the loser."
---

Here is a result that should bother you. In a controlled 100 replica experiment, weighted round-robin and Prequal ran identical load ramps. At 1.74x of CPU allocation, WRR was erroring on **more than a quarter of all queries**. Prequal returned **zero errors at every load level**. And in that same experiment, WRR had the *tighter* CPU distribution. It was doing a superb job of the thing it was designed to do.

That is the argument in "Load is not what you should balance: Introducing Prequal" (Wydrowski, Kleinberg, Rumble, Archer, NSDI '24, arXiv:2312.10172), a system running 20+ large scale services at Google for over two years. The paper's own framing:

> The real goal of a load balancer is not to balance load, it is to direct load where capacity is available.

Those are different objectives, and conflating them is why so many production load balancers have a tail latency cliff.

## Why equalizing load is the wrong target

Take 100 replicas, each allocated 40% of its machine's CPU. On machines 1 and 2, noisy neighbors soak the entire remaining 60%. The other 98 have ample headroom. A traffic spike pushes you to 1.1x aggregate allocation, and a load equalizer sends 1.1x to every replica uniformly. The arithmetic on what that costs:

```
problematic load = 10% excess on 2% of replicas
                 = 0.02 x 0.10 / 1.1
                 ~ 0.18% of total load
```

An 0.18% sliver of misplaced load, but it lands on 2% of your queries, because those two replicas keep serving their full share. **p99 spikes.** The load was balanced; the capacity was not.

Two structural problems compound this. First, CPU utilization is a *trailing* signal: it must be averaged over a window to mean anything, which puts a floor on its staleness, and it misses lock contention, memory bandwidth, and every other shared resource contributing to latency. Second, and more insidious, is the timescale illusion. The paper shows WRR keeping every replica under its usage limit across all one minute intervals, while at one second resolution the same trace violates the limit at peak **sometimes by more than a factor of two**:

> Overload is not really a special case; at sufficiently small timescales, there is nearly always some replica in overload, even if our aggregate load fits within our job allocation.

Least-loaded does not save you either. A client tracking its own in flight requests is blind to a replica saturated by *other* clients, and if that happens more than 1% of the time, p99 is already compromised.

## Two signals, probed not piggybacked

Prequal (Probing to Reduce Queuing and Latency) is a policy inside Google's Stubby RPC framework. Each replica reports two things on demand:

- **RIF**, requests in flight, read straight off a counter.
- **Estimated latency**, the median of recent completion times tagged with the RIF value that was current when each query *arrived*. At moderate to high arrival rates the samples are fresh enough that estimates rest entirely on queries finishing in the last 1 to 10 milliseconds.

Latency is measured from when application logic receives the RPC to when it hands the response back, so application level queueing is included. Network latency is excluded, since all replicas sit in one datacenter.

These arrive via **dedicated probe RPCs**, not piggybacked on responses, a real divergence from Netflix Zuul (piggybacks RIF, skips latency entirely) and RackSched (treats piggybacked signals as implicit probes). The paper argues both would likely improve by *adding* active probing.

The cost is bounded and honestly stated. At YouTube, 5 probes per query multiplies total RPC count by 6, with a 3ms probe timeout, though intra datacenter responses land well under 1ms and Google runs 1ms timeouts elsewhere: "the probes are so light compared to the queries themselves that the probing overhead is negligible. Unfortunately, this is not true for all applications."

## The probe pool, and why it is asynchronous

Probing must add nothing to the critical path, so the probes a query triggers are **not used by that query**. Each client keeps a pool of at most `m = 16` probe results (gains beyond 16 are modest), and every query routes on responses from *earlier* queries.

That buys latency but creates three pathologies the pool machinery exists to fight: **staleness**, **depletion**, and **degradation** (selection bias toward replicas that looked good once and are now loaded). Probes leave the pool four ways: evicted as oldest at capacity, reuse budget exhausted, age past a 1 second timeout, or removed by an explicit remove-worst mechanism. Reuse is budgeted by a formula tying pool inflow to outflow:

```python
def b_reuse(r_probe, r_remove, m=16, n=100, delta=1):
    """Per-probe reuse limit. delta = net probe accumulation rate."""
    return max(1.0, (1 + delta) / ((1 - m / n) * r_probe - r_remove))

b_reuse(3, 1.00)   # 1.32  testbed baseline
b_reuse(1, 0.25)   # 3.39  one probe per query
b_reuse(0.5, 0.25) # 11.76 each probe reused ~12x
```

This makes a measured result mechanical rather than mysterious. The paper reports Prequal is insensitive to probing rate until it drops below one probe per query, at which point tail RIF jumps visibly, "always around 1 probe per query." The formula shows why: below 1x, the same stale observation gets reused an order of magnitude more often. There is also a floor, when pool occupancy drops below 2, Prequal falls back to a uniformly random replica rather than trusting one observation.

## HCL: lexicographic, not a weighted sum

Now the selection rule, which is where the design earns its keep. Classify each pooled probe as **hot** if its RIF strictly exceeds a quantile `Q_RIF` of the estimated RIF distribution, else **cold**.

```python
def select(pool, theta_rif):
    """Hot-Cold Lexicographic. theta_rif = RIF threshold at quantile Q_RIF."""
    if len(pool) < 2:
        return random_replica()          # pool too thin to trust

    cold = [p for p in pool if p.rif <= theta_rif]
    if not cold:
        return min(pool, key=lambda p: p.rif)      # all hot: relieve pressure
    return min(cold, key=lambda p: p.latency)      # else: chase speed
```

Removal is this ranking reversed, alternating with removal by age: if any probe is hot, drop the hot one with highest RIF, otherwise the cold one with highest latency.

Two signals, but **no weighted combination of them**. That is deliberate, and the paper closes the argument by transitivity: across 13 linear combinations `(1-λ)·latency + λ·α·RIF` (with `α` = 75ms, median response time at RIF 1), every latency and RIF quantile improved monotonically as λ rose, so pure RIF control dominated all of them. And HCL in turn beats pure RIF. A linear function of RIF does not penalize high RIF hard enough, compared to C3's cubic term or HCL's strict priority of cold over hot.

HCL gets both properties at once, and the reason is combinatorial. At `Q_RIF = 0.59` the vast majority of queries route on latency, yet all three RIF quantiles stay as good as pure RIF control. If pooled probes were independent, the chance all 16 are hot is roughly `2^-16 ≈ 1.5e-5`. The hot branch almost never fires, so it is not doing its work through frequency. It is a **backstop**: latency optimization runs free until genuine congestion appears, at which point the rule switches objectives entirely.

Sweeping `Q_RIF` from 0 (pure RIF) to 1 (pure latency) shows both endpoints are wrong. Moving from pure RIF to 0.99 drops p99 from ~162ms to ~142ms and p90 from 93ms to 75ms. Then pure latency control blows up: p99 jumps ~20% and p99.9 fluctuates chaotically between 337 and 502ms, 1.6x to 2.4x worse. Recommended range is `Q_RIF ∈ [0.6, 0.9]`; the testbed baseline was `2^-0.25 ≈ 0.84`.

Note also what does *not* need a damping mechanism. Every probe based scheme invites the thundering herd question, and Prequal's answer is structural: each client's pool holds a small random subset of replicas, and symmetrically each replica appears in the pools of only a small random subset of clients. There is no shared view to stampede toward. The remove-worst rule is itself a knowing relaxation of textbook power-of-d-choices, "avoid using the worst of d" instead of "use only the best of d," which the authors argue qualitatively preserves the guarantees while being far more permissive.

## What it actually bought

The nine rule comparison, latency in ms, TO = 5s timeout:

| Rule | 70% p90 | 70% p99 | 90% p90 | 90% p99 |
|---|---|---|---|---|
| RoundRobin | 4984 | TO | TO | TO |
| WeightedRR | 173 | 314 | 1667 | TO |
| LeastLoaded | 343 | 1804 | 940 | 2654 |
| YARP-Po2C | 210 | 2642 | 213 | 1169 |
| C3 | 161 | 299 | 164 | 304 |
| **Prequal** | **149** | **281** | **152** | **286** |

Watch WRR specifically: fine at 70% of allocation, catastrophic at 90%. That crossover is the cliff. C3 is the only real competitor, and Prequal's edge over it is a modest 5.9 to 7.5%.

In production on YouTube's Homepage service, cutting over from WRR: **2x reduction in tail latency, 5-10x in tail RIF** (~225 down to ~50), **10-20% in tail memory**, **2x in tail CPU**, and error spikes of 0.01-0.1% driven to nearly zero. Two caveats if you cite this. The body says median latency improved 10-20% while the figure caption says 5-10%, both in the camera-ready; the tail figure (40-50%) is consistent. And resist quoting a utilization number, the paper only says targets could be "significantly raised" and that CPU "usually dips slightly."

The most counterintuitive artifact: after cutover, p99 and p99.9 degrade *less* at peak than p50 does, multiplicatively. That is backwards from every queueing intuition and the opposite of what WRR shows. Prequal pulls the tail in so hard that the tail becomes the well behaved part of the distribution.

If you take one thing: a load balancer's job is finding headroom, the signal that reveals headroom is latency, and load is the guardrail that stops latency chasing from eating you. Not the other way around.
