---
title: "Worst-Case Optimal Joins on a GPU: Flattening Skew Into a Prefix Sum"
date: 2026-08-18
tags: [databases, gpu, query-processing, datalog, parallelism]
excerpt: "Worst-case optimal joins fix the asymptotic blowup that kills binary join plans on cyclic queries, but their attribute-at-a-time intersections are a disaster on SIMT hardware: one high-degree hub key and a single warp holds up the whole device. SRDatalog's answer is to stop scheduling keys and start scheduling work units, flattening a skewed multi-level search space into a prefix-summed 1-D array that thread blocks slice at kernel launch. I re-derived the AGM bounds behind their rule rewriting and simulated their scheduler, and the numbers say the residual bottleneck is not where the paper says it is."
---

Every engine that decomposes a multi-way join into a chain of pairwise joins is betting that no intermediate result blows up. On cyclic queries that bet is provably lost. The AGM bound says the triangle query `Triangle(x,y,z) ← R(x,y), S(y,z), T(z,x)` has at most `O(|E|^1.5)` results — the fractional edge cover number of the query is exactly 1.5 — yet any binary plan must first materialize all two-hop paths, which is `Θ(|E|²)` when `R` and `S` share a high-degree vertex. No join order escapes it; the blowup is a property of the plan *shape*.

That is an annoyance in analytics and a wall in Datalog, where program-analysis suites like DOOP and ddisasm contain hundreds of cyclic rules with six to eight body atoms and run to a fixpoint, paying the blowup every iteration. Worst-case optimal joins (WCOJ) dodge it by evaluating one *variable* at a time rather than one *relation* at a time, intersecting every relation that constrains the current variable under the current partial binding, so no branch is materialized unless it can complete into an output tuple.

The catch is that WCOJ's natural unit of parallelism is "one outermost key per thread group," and on power-law data that unit is worthless. [SRDatalog](https://arxiv.org/abs/2604.20073) (Sun et al., April 2026) is the first GPU Datalog engine built on WCOJ, and its central idea is a scheduling change: stop assigning keys to thread blocks, assign *work units* instead.

## Why LFTJ resists SIMT

Leapfrog Triejoin is defined over an interface, not a layout: each relation constraining the current variable exposes a sorted unary iterator with `seek`, and laggards jump to the frontier until all iterators agree.

```python
def leapfrog(iters):
    """Intersect k sorted iterators; seek(x) -> first key >= x, or None."""
    keys = [it.next() for it in iters]
    if any(k is None for k in keys):
        return
    p = 0
    while True:
        hi = max(keys)
        if all(k == hi for k in keys):       # all agree -> emit, step one
            yield hi
            keys[p] = iters[p].seek(hi + 1)
        else:
            keys[p] = iters[p].seek(hi)      # laggard jumps to frontier
        if keys[p] is None:
            return
        p = (p + 1) % len(iters)
```

Two properties make this hostile to a GPU. The loop's trip count is data-dependent per branch, so warps diverge; and far worse, the work under one outermost key is unbounded — when an inner variable binds to a ubiquitous hub like `java.lang.Object`, one thread group is trapped in a huge localized intersection while the other 141 SMs idle.

Existing systems each relax something Datalog cannot give up. Binary-join GPU engines (GDlog, VFLog) materialize every intermediate to keep threads balanced, and OOM on 6-way rules. Static WCOJ engines (cuMatch, HoneyComb) precompute hierarchical grids or tries that fracture hot keys, but those structures are immutable and semi-naive evaluation injects a delta *every iteration* — the paper measures index rebuild at up to 93% of merge time. Dynamic WCOJ engines push hot sub-ranges into work-stealing queues, serializing atomics precisely during the write-heavy phase.

## Flattening the search space

SRDatalog's answer is to make the schedule a prefix sum. A histogram kernel sweeps the outermost join column and records each root key's fan-out; a prefix sum over that array turns the join into a 1-D space of `T` work units, where key `k` owns the range `[C[k-1], C[k])`. Blocks then take a flat contiguous slice of size `⌈T/p⌉` regardless of how many keys fall in it — one heavy key gets split across three blocks instead of monopolizing one — and each thread decodes its global index back into a tuple address by binary searching the prefix array:

```python
def decode(g, C, U, d2):
    """Global work unit -> (root key, outer index, inner index). No auxiliary index."""
    k = bisect_right(C, g)               # owning root key by binary search
    local = g - (C[k - 1] if k else 0)
    return U[k], local // d2[k], local % d2[k]
```

Its virtues are structural rather than clever: no cross-warp coordination, adjacent lanes decode adjacent positions of the inner relation so writes stay coalesced, and the histogram is maintained incrementally over the delta rather than recomputed across hundreds of iterations.

The scheduling change is also what lets the pipeline stay allocation-free. Because the space is partitioned deterministically at launch, a **count kernel** runs the identical intersection logic without materializing, a prefix sum over per-thread counts yields exact write offsets, and a **materialize kernel** re-executes and writes. Two passes, zero atomics. Storage is flat structure-of-arrays in radix order, each relation split into a small head buffer that absorbs deltas cheaply and a large sorted body flushed by a single-pass merge only when the head crosses a threshold; the iterators treat both as a logical union. Rule-level parallelism then falls out of monotonicity: within a stratum the [CALM theorem](/blog/calm-theorem-monotone-coordination-free-distributed-computing) says execution order cannot change the fixpoint, so independent rules are dispatched phase-aligned across CUDA streams to overlap register-starved kernels.

## What the AGM bounds actually say about their rewriting

For very deep rules one level of balancing is not enough, so SRDatalog splits rules: it factors the sub-tree responsible for inner skew into a helper relation, promoting buried skew keys to root columns where the histogram can flatten them. The paper never quantifies the cost of that rewrite, so I solved the fractional edge cover LPs myself for micro-DOOP's `CallGraphEdge` rule (six atoms over eight variables `j,i,b,sn,dsc,h,t,m`):

| Query | ρ* (fractional edge cover) | AGM bound at N tuples per relation |
|---|---|---|
| Full CGE body | 3.0 | N³ |
| `HelpNT` helper (MethodLookup ⋈ HeapAllocation_Type) | 2.0 | N² |
| Consumer rule after the split | 3.0 | N³ |

So the split is asymptotically free: the materialized boundary is bounded by N², strictly below the N³ bound of the rule it is carved out of, and the consumer's ρ* is unchanged. That is the difference between this rewriting and ordinary binary decomposition, which pushes the intermediate above the query's own bound.

The LP exposes a limit too. `CallGraphEdge(i,m)` projects eight variables down to two, so the *output* is at most N² while WCOJ's guarantee is against the full-join bound of N³. Worst-case optimal is not output-optimal for projected heads, and closing that gap needs submodular-width machinery (PANDA), not a better variable order.

## Where the load balancer actually runs out

The skew ablation reports speedups from 1.1× to 35.8× across six micro-DOOP kernels. I modelled that directly: 20,000 root keys with Zipf fan-outs, 1024 blocks, greedy longest-first key assignment as the baseline, and a flattened schedule whose makespan is `max(T/p, largest_atomic_unit)` — because 1-D flattening subdivides only the top two levels, a subtree below that is indivisible.

| Skew location | Predicted speedup | Hot key share of T | Largest atomic unit |
|---|---|---|---|
| Root only (inner levels uniform) | 33.8× | 3.3% | < 0.01% |
| Root and inner | 1.0× | 30.9% | 30.9% |
| Deep inner only | 1.0× | 31.6% | 31.6% |

The model reproduces the paper's entire measured band from one variable — where the skew sits — with no fitting. It also contradicts their explanation of one data point. For `CastTo` they report a single key holding 75.5% of the workload and a 1.8× speedup, explained as a ceiling imposed by "modest absolute data volume (35.8M tuples, 160 ms baseline)". If that hot key were genuinely split, 0.755·T against a `T/p` makespan would be ~773× at p = 1024, and still 107× at one block per SM. Inverting the measured 1.8× instead implies an indivisible unit carrying **≈42% of total work**. The binding constraint is not data volume; it is that the histogram flattens two levels of a deeper intersection tree and `CastTo`'s hot key is hot *below* the flattened boundary — the same failure the authors correctly diagnose for the virtual-dispatch rules (3.1×–3.3×) and `VPT_LoadField` (1.1×). That argues for applying helper-relation splitting more aggressively, not for accepting a volume ceiling.

## Results, and the caveat

Across 17 datasets, SRDatalog on one RTX 6000 Ada beats three mature parallel CPU engines by geometric means of 21× (Ascent), 14× (FlowLog) and 26× (Soufflé), on hardware matched by cloud rental cost rather than by silicon. The GPU-to-GPU comparisons are tighter and more informative: 2.1×–4.0× over cuMatch on LSQB pattern matching, where the win is flat columnar arrays versus grid-partitioned pointer chasing, and 2.3×–7.1× over binary-join VFLog on Same Generation, which is the intermediate-materialization bandwidth tax. Stream multiplexing adds 1.23×–1.66× on rule-rich strata and nothing (±3%) where one recursive rule already saturates the device.

The honest caveat: the headline geomeans put the CPU baselines on a different machine, exclude data loading, and use reduced benchmark artifacts rather than ddisasm's full 3,000 rules. The GPU-to-GPU numbers and the skew ablation are the load-bearing evidence, and they support a narrower but more durable claim — on SIMT hardware a deterministic launch-time schedule derived from a cheap incremental histogram beats runtime work stealing, because it buys balance *and* pre-computed write offsets at once. That pattern generalizes to any irregular GPU kernel whose output size you currently discover with an atomic counter.
