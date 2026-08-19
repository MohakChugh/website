---
title: "Reusable Subrings: Scheduling Collectives When Rewiring Costs Milliseconds"
date: 2026-08-19
tags: [networking, distributed-systems, hpc, optical, performance]
excerpt: "Optical circuit switches let you rewire a cluster mid-collective, but a 3D MEMS crossbar takes 15 ms to settle — a lifetime next to a 1.7 µs step. I worked through Bridge (arXiv:2605.12766), verified its subring structure in Python, and derived the closed-form condition it never states: the optimal number of reconfigurations depends on exactly two things, ln n and the dimensionless ratio δ/c. Solve (x−1)e^x + 1 = δ/c and you have it."
---

Optical circuit switches are the cheapest bandwidth in a datacenter and the most expensive latency. A silicon-photonic switch settles in about **7 µs**; a 3D MEMS crossbar takes **15 ms**; piezoelectric beam-steering, **25 ms**. Against a Bruck step that costs 1.7 µs of software latency, that reconfiguration delay δ is not a tax, it is the entire budget.

So the interesting question about reconfigurable topologies is not "what is the best topology for this traffic matrix." It is: *given that you can afford exactly R rewirings across a whole collective, where do you spend them?* The greedy answer — Birkhoff-von Neumann decompose each step's demand and rewire to match — pays δ every step and loses badly. **Bridge** ([arXiv:2605.12766](https://arxiv.org/abs/2605.12766), Juerss and Schmid, May 2026) answers it properly, and the answer is more structured than I expected.

## Bruck's hidden ring

Bruck's algorithm for All-to-All and Reduce-Scatter is a fixture of MPI implementations. At step k of s = ⌈log₂ n⌉, node u communicates with u + 2^k mod n. The pattern is usually presented as a sequence of unrelated permutations. It is not. Each step's demand is a **union of disjoint rings**:

$$S_i^{(k)} := \{\, u \mid u \equiv i \pmod{2^k} \,\}$$

giving 2^k subrings of size n/2^k. And because 2^(k+1) = 2^k + 2^k, a link installed for step k is *still a useful link* for step k+1 — you just traverse it twice. Reconfigurations are not consumed by the step that motivates them. That transitivity is the whole result.

I did not want to take the hop-count claim on faith, so I routed it:

```python
def hops_and_congestion(n, a, k):
    """Topology has directed links u -> u+2^a. Every node sends to u+2^k.
       Route forward along links; return distinct hop counts and per-link load."""
    nxt = {u: (u + (1 << a)) % n for u in range(n)}
    load, hopcounts = {}, set()
    for u in range(n):
        dst, cur, h = (u + (1 << k)) % n, u, 0
        while cur != dst:
            v = nxt[cur]
            load[(cur, v)] = load.get((cur, v), 0) + 1
            cur, h = v, h + 1
        hopcounts.add(h)
    return hopcounts, load
```

For n ∈ {16, 64, 256} and every valid (a, k) with a ≤ k, this returns a **single** hop count h_k = 2^(k−a), and the per-link load is *uniformly* equal to h_k — every link carries exactly the same traffic, no hot edges. That uniformity is why the congestion factor c_k in the cost model can be an exact 2^(k−a) rather than an average papering over a hotspot.

## The algebra of a segment

Partition the s steps into R+1 contiguous segments, one reconfiguration at each boundary. Within a segment of length r starting at step a, the cost is a geometric series:

$$C_{\text{seg}}(r) = \sum_{i=0}^{r-1}\left(\alpha_s + (\alpha_h + \beta m/2)\,2^i\right) = r\alpha_s + c\,(2^r - 1), \quad c := \alpha_h + \tfrac{\beta m}{2}$$

Because 2^r − 1 is convex, balanced segments win — optimal All-to-All segment lengths differ by at most 1. That collapses to a clean bound:

$$C^*_{\text{A2A}}(R) = s\,\alpha_s + (R+1)\,c\left(n^{1/(R+1)} - 1\right) + R\delta$$

A single well-placed reconfiguration turns Ω(n) into O(R·n^(1/(R+1))). One rewiring on 64 nodes cuts the hop term from 63 to 14 units.

## Reduce-Scatter goes early, AllGather goes late

All-to-All moves a constant m per step, so only hop count matters and balanced cuts are right. Reduce-Scatter does not: its message halves each step, so a step's transmission cost is βm·h_k/2^k = βm/2^(a+1) — **constant within a segment, set entirely by where the segment starts**. Minimizing Σ (b−a+1)/2^a over segments [a,b] pushes cuts toward *low* k. AllGather, the mirror image, pushes them toward high k. Rabenseifner's decomposition of AllReduce therefore wants an asymmetric schedule: reconfigure early in the Reduce-Scatter half, late in the AllGather half.

I reproduced the paper's schedule table by exhaustive search over all cut sets at n = 64, and it matches exactly:

| R | All-to-All cuts | Reduce-Scatter cuts | AllGather cuts |
|---|---|---|---|
| 1 | (3) | (2) | (4) |
| 2 | (2, 4) | (1, 3) | (3, 5) |

## The condition the paper doesn't write down

Minimizing p·c·(n^(1/p) − 1) + (p−1)δ over p = R+1, with x := ln n / p, the first-order condition reduces to something that surprised me by how little it contains:

$$(x-1)e^{x} + 1 = \frac{\delta}{c}, \qquad R^* + 1 \approx \frac{\ln n}{x^*(\delta/c)}$$

The optimal reconfiguration count depends on the scale only through ln n, and on all the hardware — switch latency, per-hop latency, link bandwidth, message size — only through the single dimensionless ratio **δ/c**. Everything else cancels.

```python
def solve_x(ratio):                      # bisect (x-1)e^x + 1 = ratio
    f = lambda x: (x - 1) * math.exp(x) + 1 - ratio
    lo, hi = 1e-12, 100.0
    for _ in range(200):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if f(mid) < 0 else (lo, mid)
    return (lo + hi) / 2
```

Tested against integer-exact brute force over 1368 configurations (n from 32 to 4096, m from 1 KB to 256 MB, δ from 1 µs to 5 ms), the rule picks the exact optimal R **94.3%** of the time, with a mean cost penalty of **0.092%** and a worst case of **3.81%**. It is a rule of thumb, not a theorem, and I would rather report the miss rate than pretend otherwise.

The sensitivity d(R*)/d(log₂ n) = ln2/x* is the practically useful part:

| δ/c | x* | extra reconfigurations per doubling of n |
|---|---|---|
| 0.10 | 0.39 | +1.77 |
| 1.00 | 1.00 | +0.69 |
| 6.23 | 1.83 | +0.38 |
| 100 | 3.63 | +0.19 |

Cheap switches want R to grow nearly twice as fast as scale. Expensive ones want it nearly frozen.

## Where this stops working

Bridge's ceiling is worth stating plainly, because the paper's speedup numbers (up to 10.4× over static Bruck) invite the wrong conclusion. Bruck is *latency*-optimal, not bandwidth-optimal, and reconfiguration closes that gap asymptotically without ever crossing it. Measuring Reduce-Scatter transmission volume against Ring's (n−1)/n optimum:

| R | n=64 (× ring) | n=256 (× ring) |
|---|---|---|
| 0 | 3.048 | 4.016 |
| 1 | 1.524 | 1.757 |
| 2 | 1.206 | 1.318 |
| 3 | 1.079 | 1.129 |
| 4 | 1.016 | 1.051 |

Each reconfiguration buys roughly half the remaining gap, for the price of one δ. So Ring must win once messages get large enough, and computing the break-even at 800 Gbps with α_h = 1 µs puts it at **4.8 MB per rank for n=64 at δ=150 µs** — which independently reproduces the paper's own observation that Ring reclaims large messages right around δ = 0.15 ms. At n=1024 the break-even is 172 MB, so the interesting regime widens with scale.

Two further caveats. The model charges δ once per reconfiguration for the whole fabric and does not overlap rewiring with communication — defensible, since Bruck's steps are globally synchronized, but it means a switch that can reconfigure partially is undermodelled. And with fewer than 2n ports, blocks of ⌈2n/z⌉ nodes must share a port pair, which lifts the effective minimum distance from 1 to 2n/z; the structure survives, the constants do not.

What I take from this is narrower and more durable than a speedup number. The reconfiguration schedule is not a property of the traffic matrix. It is a property of log n and one dimensionless ratio. If you are building a control plane for an optical fabric, that is the difference between solving an assignment problem every step and evaluating a closed-form expression once.
