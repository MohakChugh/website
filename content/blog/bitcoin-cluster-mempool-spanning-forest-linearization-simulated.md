---
title: "Bitcoin Core's Cluster Mempool, Simulated: Spanning-Forest Linearization Hits the Brute-Force Optimum on 3,300/3,300 Clusters, Ancestor-Set Sort Misses on up to 6%, and Most Dense-Cluster Splits Are Wasted Self-Merges"
date: 2026-11-12
tags: ["bitcoin", "graph-algorithms", "mempool", "linearization", "simulation"]
excerpt: "Bitcoin Core 31.0 replaced ancestor/descendant limits with 64-transaction clusters, each kept in a linearized order that the new spanning-forest linearization (SFL) algorithm computes. I wrote a brute-force optimal linearizer, the old ancestor-set sort, and SFL from the rules in cluster_linearize.h. SFL matched the optimum on all 3,300 test clusters and its convexified diagram area never decreased. Ancestor-set sort was suboptimal on 0.5–6% of clusters and lost up to 14.8% of fees at its worst prefix. At n=64, SFL needs a mean of 21–31 splits from scratch, but in dense clusters 68–86% of them are self-merges that change nothing. Warm-starting from ancestor sort cuts split counts 5× on sparse clusters but only 1.5× on dense ones."
---

# Bitcoin Core's Cluster Mempool, Simulated: Spanning-Forest Linearization Hits the Brute-Force Optimum on 3,300/3,300 Clusters, Ancestor-Set Sort Misses on up to 6%, and Most Dense-Cluster Splits Are Wasted Self-Merges

Bitcoin Core 31.0 reimplemented the mempool. The release notes say it *"no longer enforces ancestor or descendant size/count limits"*. Instead it limits connected components (clusters) to 64 transactions and 101 kvB (`DEFAULT_CLUSTER_LIMIT{64}`, `DEFAULT_CLUSTER_SIZE_LIMIT_KVB{101}` in `policy.h`). Each cluster is kept in a **linearization**, a topological order of its transactions, and that order is cut into **chunks**. Block building, eviction, relay ordering and RBF all read these chunks.

The 31.x branch computes the linearization with **spanning-forest linearization** (SFL), designed by Pieter Wuille in early 2025 and merged to master in February 2026. The 30.x `cluster_linearize.h` has no `SpanningForestState`. SFL has no proven polynomial bound: the Delving Bitcoin thread on it records a 15-transaction cycle of 24 steps and says *"it's entirely possible that the worst case is exponential."*

I implemented three linearizers from the header's definitions and compared them.

## Chunks, diagrams, and what "optimal" means

Chunking is greedy: append each transaction, then merge backwards while that raises the feerate.

```python
def chunk(lin, fee, size):
    ch = []                                    # [fee, size, txmask]
    for t in lin:
        cur = [fee[t], size[t], 1 << t]
        while ch and cur[0]*ch[-1][1] > ch[-1][0]*cur[1]:   # cur beats previous chunk
            f, s, m = ch.pop(); cur = [cur[0]+f, cur[1]+s, cur[2] | m]
        ch.append(cur)
    return ch
```

The cumulative (size, fee) points at chunk boundaries form a concave **feerate diagram** (fees collected per block-space budget). A linearization is at least as good as another if its diagram is never below it. That is a partial order, since diagrams can cross.

An **optimal** linearization dominates all others and always exists: repeatedly remove the highest-feerate topologically closed subset. My brute-force reference does exactly that for n ≤ 14, enumerating all 2^n masks in numpy.

The old miner used **ancestor-set sort**: repeatedly include the highest-feerate remaining ancestor set. It is CPFP-aware but not optimal.

## How SFL works

The header documents the whole state machine. Each dependency (parent→child edge) is either *active* or *inactive*. Chunks are the connected components of the active edges, and the algorithm keeps them acyclic, so each chunk is a spanning tree.

- **Merge** (activate an edge): a chunk merges *upwards* with the lowest-feerate parent chunk whose feerate is ≤ its own, or *downwards* with the highest-feerate child chunk whose feerate is ≥ its own. Merging until no such pairs remain makes the state *topological*.
- **Split** (deactivate an edge): removing an active edge cuts its chunk into a top part T (holding the parent) and a bottom part B. If T has a strictly higher feerate than B, that edge is a violation, and splitting there improves the result. After the split, T merges upwards and B merges downwards until both are stable.
- **Stop** when no active edge is a violation. The header says this state is provably optimal.

The header makes a testable claim: if T and B don't re-join after a split, the area under the convexified diagram rises by at least gain/2. If they do re-join (a **self-merge**), the area is unchanged. Either way it should never go down.

## Result 1: SFL is exact, and its area never goes down

Clusters are connected random DAGs: one random earlier parent per transaction, extra parents with probability *d*, 100–1,000 vB sizes, and lognormal or bimodal feerates. Bimodal means half pay 0.5–2 sat/vB, like CPFP parents, and the rest pay about 12 sat/vB.

| model | n | ancestor-sort suboptimal | worst-prefix fee loss when suboptimal (median / max) | SFL = optimum | mean / max splits |
|---|---|---|---|---|---|
| sparse, lognormal | 6–10 | 0.7–2.0% | 0.8–1.4% / 2.2% | 900/900 | 0.3–0.7 / 6 |
| d=0.1, lognormal | 14 | 4.0% | 0.45% / 2.1% | 200/200 | 1.8 / 8 |
| d=0.1, bimodal | 14 | 5.5% | 1.6% / 12.4% | 200/200 | 1.7 / 10 |
| d=0.3, lognormal | 14 | 6.0% | 1.5% / 2.9% | 200/200 | 2.5 / 13 |
| d=0.3, bimodal | 14 | 5.5% | 2.2% / 14.8% | 200/200 | 2.5 / 11 |

Across 3,300 clusters in 15 configurations (table shows a subset), SFL's diagram equalled the brute-force optimum every time, and the area never decreased between steps. A safety-net `make_topological()` for states left non-topological after a split never fired, so upward merges of T plus downward merges of B were always enough.

Ancestor-set sort missed on a few percent of clusters, more often as n grows. When it misses, it typically loses 1–2% of fees at the worst cut. With cheap-parent, rich-child fees, the tail reaches 12–15%.

## Result 2: the failure ancestor-set sort can't see

Random graphs understate the failure that matters most. Take one parent P paying 100 sat for 1,000 vB and ten children paying 2,000 sat / 200 vB each:

```text
optimal chunks:          [(20100 sat, 3000 vB, 6.70 sat/vB)]
ancestor set {P, Ci}:    2100 / 1200 = 1.75 sat/vB
```

Every candidate in this family scores 1.75 sat/vB. With enough unrelated 2 sat/vB transactions around, the old selector fills the block with those and never touches the family, even though the family pays 6.7 sat/vB, 3.35× the marginal rate. In 3,000 vB the miner gets 6,000 sat instead of 20,100. Selecting by chunk feerate takes the family first. My per-cluster sweep can't show this loss, because it comes from ranking *across* clusters by ancestor score.

## Result 3: RBF needs the diagram because diagrams cross

The new RBF rule requires a *strictly better* diagram. Here is a replacement the old BIP125 rules accept:

```text
before: A (100 sat, 100 vB) <- D (10,900 sat, 100 vB)    chunk {A,D} = 55 sat/vB
after:  R conflicts with A: 21,100 sat, 10,000 vB         2.11 sat/vB

BIP125 rule 3 (pays ≥ replaced fees):        21100 ≥ 11000   ✓
rule 4 (pays for own relay at 1 sat/vB):    10100 ≥ 10000   ✓
rule 6 (feerate ≥ A's individual feerate):  2.11 > 1.00     ✓
diagram at 200 vB: before 11,000 sat, after 422 sat
diagram comparison: neither dominates
```

R's feerate beats A's individual feerate, but A's mining score came from its child D. The diagram check sees the top 200 vB get 26× worse and rejects R.

## Result 4: in dense clusters most SFL work is self-merges

SFL's step count has no proven bound, so I measured it up to the n=64 limit (60 clusters per row, bimodal fees):

| n | deps/cluster | splits from scratch: mean / max | self-merge share | splits from ancestor-sort start: mean / max |
|---|---|---|---|---|
| 16 | 21 | 1.3 / 5 | 22% | 0.2 / 3 |
| 32 | 54 | 5.6 / 15 | 32% | 0.9 / 11 |
| 32 | 100 | 8.8 / 25 | 68% | 3.6 / 15 |
| 64 | 160 | 21.4 / 71 | 56% | 4.4 / 15 |
| 64 | 356 | 31.3 / 79 | **86%** | 21.1 / 81 |

Two things stand out:

1. **Self-merges dominate on dense graphs.** The split's halves find another edge and re-join, and the diagram doesn't move. At 356 dependencies, 86% of splits are self-merges, so only about one in seven improves the diagram. Wasted steps are also what make the Delving 15-transaction loop possible, which is one reason the implementation picks violating dependencies at random.
2. **Warm starts help least where steps are most expensive.** `Linearize()` can load an old linearization with upward merges only. Starting from ancestor-set sort cuts mean splits about 5× on sparse 64-transaction clusters (21.4 → 4.4), but only 1.5× on dense ones (31.3 → 21.1), where the worst case was actually *larger* (81 vs 79).

## Caveats

- My SFL omits the equal-feerate minimization phase. Random fees produce no ties, so the diagrams are unaffected.
- n=64 results are checked only by the SFL optimality condition. Brute force stops at n=14.
- The graphs are synthetic. Real hard clusters come from structures random DAGs don't produce. One is the 77-transaction example in Wuille's February 2025 benchmark, which took 371,678 µs with the old algorithm and 24.1 µs with SFL.
- Split counts are not wall time. Core meters work with `SFLDefaultCostModel` and stops at `max_cost`, still returning a linearization at least as good as its input.

## Takeaways

The cluster mempool rests on two ideas: linearize small components, and compare states by feerate diagrams. Diagram dominance lets RBF reject replacements that pass BIP125 but are worse for miners. SFL reached the optimum on all 3,300 brute-force-checked clusters. Its cost is driven by dense graphs, where most splits are self-merges and where a warm start from ancestor-set sort helps least.
