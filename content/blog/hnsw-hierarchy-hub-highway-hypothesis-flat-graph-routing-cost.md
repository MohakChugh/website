---
title: "Do You Need the 'H' in HNSW? Flat Graphs, Hub Highways, and Where the Distance Computations Actually Go"
date: 2026-10-12
tags: [vector-search, hnsw, approximate-nearest-neighbor, high-dimensional-data, graph-indexes]
excerpt: "An ICML 2025 workshop paper finds that a flat navigable small-world graph matches HNSW on 13 high-dimensional benchmarks, and argues that hub nodes form a 'highway' that does the hierarchy's job. In my own 50k-point simulation the flat graph matches HNSW to within 2% at every d ≥ 8, including on the uniform sphere, which has no hubs at all. The upper layers account for just 6–9% of distance computations there, so the hierarchy has little left to save."
---

HNSW is the default index in nearly every vector database. Its "H" is a skip-list-style stack of sparser graphs that a query greedily descends before beam-searching the dense base layer. The original pitch was complexity: flat navigable graphs route in polylogarithmic hops, while the hierarchy promises a constant number of distance computations per layer.

[Munyampirwa, Lakshman & Coleman](https://arxiv.org/abs/2412.01940) (ICML 2025 Workshop on Vector Databases) test this at scale. They build hnswlib indexes on 13 datasets from 1M to 100M vectors, extract the base layer, and search it flat with identical code ([FlatNav](https://github.com/BlaiseMuhirwa/flatnav)). Across BigANN-100M (SpaceV, DEEP, Text-to-Image, BigANN), GIST, SIFT, NYTimes and GloVe, p50 and p99 latency-vs-recall curves overlap. On high-dimensional data, the hierarchy can go.

The second half explains why with the **Hub Highway Hypothesis**: in high dimensions a few *hub* points appear in many k-NN lists, and these hubs form a well-connected subgraph that queries ride early in search, doing the hierarchy's routing job for free.

I rebuilt both halves in about 150 lines of numpy. The benchmark half reproduced cleanly. The explanation half didn't hold up as well.

## The setup

Each graph layer takes exact top-48 candidates, applies the HNSW/Arya–Mount pruning heuristic, and adds reverse edges capped at 2M (M = 16). Upper layers use geometric levels with `mL = 1/ln M` and greedy descent (ef = 1). Cost is the **number of distance computations** in a standard two-heap beam search.

```python
def prune(X, u, cands, M):
    # keep c only if it is closer to u than to every neighbour already kept
    d = ((X[cands] - X[u]) ** 2).sum(1)
    kept = []
    for i in np.argsort(d):
        c = cands[i]
        if not kept or (((X[kept] - X[c]) ** 2).sum(1) > d[i]).all():
            kept.append(c)
            if len(kept) == M:
                break
    return kept

# HNSW query: greedy descent through upper layers, then beam on the base
ep = top_entry
for L in range(num_layers, 0, -1):
    ep = beam(X, layers[L], q, ep, ef=1, counter)[0]
result = beam(X, base, q, ep, ef, counter)          # flat: ep = random node
```

## Result 1: the hierarchy stops mattering by d ≈ 8

n = 50,000 i.i.d. Gaussian points under L2, 300 queries, recall@10. Distance computations at matched ef = 128; recall is identical in every row to ±0.003.

| d | HNSW | Flat (random entry) | Flat / HNSW |
|---|---|---|---|
| 2 | 202 | 488 | **2.42** |
| 4 | 411 | 442 | 1.08 |
| 8 | 974 | 969 | 0.99 |
| 16 | 1,997 | 1,971 | 0.99 |
| 32 | 2,884 | 2,845 | 0.99 |
| 64 | 3,306 | 3,248 | 0.98 |
| 128 | 3,442 | 3,379 | 0.98 |

At d = 2 and ef = 10 the gap reaches **6.1×** (58 vs 350 computations). At d ≥ 8 the flat graph is marginally *cheaper*, because it doesn't pay for the upper-layer descent. A fixed entry point and a random one are indistinguishable. That matches the paper and Lin & Zhao's 2019 "helps only below d ≈ 32" finding. In my runs the crossover is earlier still, between d = 4 and d = 8.

## Result 2: parity holds where there are no hubs

The hypothesis predicts that the flat graph matches HNSW *because* hubs supply the routing. So remove the hubs. Normalize the same Gaussians onto the unit sphere. The uniform sphere is rotation-invariant, so no point is special. The k-occurrence skewness S(N₁₀), the paper's own hubness metric, collapses:

| Data (n = 20k) | S(N₁₀) | max N₁₀ | Visit share of top-1% nodes |
|---|---|---|---|
| Gaussian L2, d = 128 | 10.5 | 1,021 | 26.6% |
| Gaussian L2, d = 512 | 16.9 | 1,986 | 37.4% |
| Sphere, d = 128 | 0.31 | 26 | 4.3% |
| Sphere, d = 512 | 0.29 | 28 | 4.9% |

Yet on the sphere at n = 50k, flat/HNSW is **0.98 at d = 16, 0.98 at d = 64 and 0.99 at d = 256**. The hierarchy is just as useless without any highway. Hubs exist, but they aren't *necessary* for the flat graph to match HNSW.

## Result 3: where the distance computations go

I split each HNSW query's cost into upper-layer and base-layer work. For the flat search I also recorded how far into the visit trace the first true top-10 neighbor appears (n = 20k, ef = 40):

| Data | Upper-layer share of HNSW cost | First true NN, HNSW | First true NN, flat | Flat / HNSW |
|---|---|---|---|---|
| Gaussian d = 2 | **30%** | 3% of trace | **60%** of trace | 2.82 |
| Gaussian d = 4 | 21% | 2% | 22% | 1.13 |
| Sphere d = 16 | 9% | 4% | 10% | 0.98 |
| Gaussian d = 128 | 6% | 10% | 13% | 0.97 |
| Sphere d = 128 | 7% | 29% | 34% | 0.98 |

This is the mechanism. A query has two phases: **routing** (getting to the right neighborhood) and **refinement** (the ef-wide beam that grinds out recall). The hierarchy can only shorten the first phase.

- In low dimensions, greedy routing on a flat graph needs roughly n^(1/d) hops. At d = 2 the flat search spends 60% of its trace just getting there, so the hierarchy has a lot to save. The gap also grows with n: 2.8× at 20k versus 6.1× at 50k (ef = 10).
- In high dimensions every point is a few hops from every other, *with or without hubs*. Routing shrinks to a few percent of the work. Meanwhile refinement explodes, because distances concentrate and the beam has to sift many near-equidistant candidates. Even a perfect hierarchy could save at most the 6–9% that routing costs, and it spends roughly that much traversing its own upper layers.

Since routing cost is fixed while refinement grows with ef, the benefit also shrinks as you push recall: at d = 2 it falls from 6.1× (ef = 10) to 2.4× (ef = 128).

## What the synthetic hub highway actually is

The paper's synthetic evidence uses i.i.d. Gaussians and contrasts L2 (strong hub effects) with angular distance (weak ones). It attributes the difference to cosine's "anti-hub properties". On isotropic Gaussian data there's a simpler reading. For ‖q − x‖² = ‖q‖² + ‖x‖² − 2⟨q, x⟩, the ‖x‖² term has spread ~√(2d) and is shared by *every* query. Low-norm points are closer to everyone. They are the hubs:

```python
norm = np.linalg.norm(X, axis=1)
hub  = visits >= np.quantile(visits, 0.99)          # top-1% most-visited
low  = norm  <= np.quantile(norm, 0.01)             # 1% closest to origin
print((hub & low).sum() / low.sum())                # chance level = 0.01
```

At d = 128 that prints **0.93**. Ninety-three percent of the most-visited 1% are the 1% of points nearest the origin. Spearman ρ between N₁₀ and −‖x‖ is 0.90. The "highway" is the dense core of the Gaussian ball, and the "angular" condition removes it by giving every vector the same norm. That's a norm effect, not a property of cosine. Real cosine datasets *do* show hubness, from anisotropy and clustering (GloVe and NYTimes in the paper's own tables). The real-data results stand. The synthetic L2-vs-angular contrast just doesn't isolate the metric.

The connectivity claim does reproduce. At d = 128 a hub's out-neighbor is a hub 16.4% of the time, versus 6.8% for a non-hub (2.4×). Hubs also appear slightly front-loaded in traces: 28.2% of the first 10% of steps versus 22.2% of the second half. That 1.27× tilt is real but mild. The paper's Figure 8 suggests clustered real datasets show more.

## What this means in practice

1. **If your embeddings have d ≥ 32 and nontrivial intrinsic dimension, the hierarchy is overhead you can drop.** It costs a few percent of compute, plus complexity in updates, deletes and sharding.
2. **Don't expect the memory win to come from the hierarchy's edges.** With `mL = 1/ln M`, the expected number of upper-layer nodes is n/(M−1), about 6.7% at M = 16. Each stores M links against the base's 2M, so upper-layer links are about **3.3%** of link storage. The paper's 38–39% *peak construction* memory saving versus hnswlib (its Table 6) mostly reflects implementation differences, not the "H" itself.
3. **Spend your optimization budget on refinement.** That's where 90%+ of the distance computations go at high d: quantized distance estimates (RaBitQ, PQ), better pruning, early termination, cache-friendly layouts. The paper reaches the same conclusion.
4. **Keep the hierarchy for genuinely low-dimensional data** such as geo points or low-intrinsic-dimension manifolds. There it's worth 1.1–6×, and the gap grows with n.

The headline result is solid. The causal story needs one adjustment: hubs and near-free routing are both symptoms of high-dimensional geometry, and near-free routing alone is enough to make the hierarchy redundant.
