---
title: "ACORN: Why Filtered Vector Search Breaks HNSW, and the Two-Hop Fix"
date: 2026-07-27
tags: [vector-search, hnsw, ann, databases, retrieval]
excerpt: "Every production vector search is really a filtered vector search: find similar documents, but only for this tenant, only from last quarter, only in these languages. HNSW handles this badly, and not for the reason most people assume. The problem is that HNSW's edge pruning rule is provably wrong once you restrict the graph to a subset of nodes. ACORN fixes it by making pruning predicate-agnostic and recovering the deleted edges at query time through two-hop expansion, reaching 2x to 1,000x higher throughput at fixed recall."
---

Nobody runs pure nearest-neighbor search in production. Real queries look like "the 10 passages most similar to this embedding, from documents this user can read, published after January, in English." The vector part is a similarity search over a graph index. The rest is a predicate over structured columns. Making those two things cooperate is the hybrid search problem, and it is where most vector database benchmarks quietly stop being relevant.

The folklore answer is that you pick one of two bad options. **Pre-filtering** materializes the set of rows passing the predicate and brute-forces the distance computation over it: perfect recall, terrible latency once the surviving set is large. **Post-filtering** searches the unfiltered HNSW index, collects far more than `k` candidates, and discards the ones that fail the predicate. Fast when the predicate is permissive, catastrophic when it is not.

ACORN, from Liana Patel, Peter Kraft, Carlos Guestrin, and Matei Zaharia (arXiv:2403.04871), reframes the problem. The paper's claim is that post-filtering is not merely wasteful, it is **structurally broken**, because HNSW's index construction destroys information that filtered search needs. Fix the construction and the search strategy follows.

## The oracle you cannot afford

Start with the ideal. If you knew every predicate that would ever be issued, you would build one HNSW index per predicate, over exactly the nodes that pass it. Call this the *oracle partition index*. Every node search touches passes the filter, and complexity depends on the size of the filtered set rather than the whole dataset.

This is impossible for arbitrary predicates: the count is exponential in the number of attributes, and range and regex predicates make it infinite. `FilteredDiskANN` takes the pragmatic route of restricting which predicates you may ask about, which works for a handful of low-cardinality equality checks and fails for date ranges over a hundred million distinct values.

ACORN's goal is to make the **predicate subgraph** of a single graph index behave like the oracle partition index for that predicate, without ever building one. Define $G(X_p)$ as the induced subgraph over the nodes passing predicate $p$. If $G(X_p)$ happens to be hierarchical, connected, and have bounded degree, then greedy search over it inherits HNSW's complexity guarantees. So the question becomes: what does HNSW do that breaks those properties?

## HNSW's pruning rule is predicate-blind

HNSW does not keep all `M` candidate neighbors it finds for a newly inserted node. It applies a relative-neighborhood-graph approximation: iterating candidates from nearest to farthest, it prunes candidate `b` if some already-selected neighbor `a` is closer to `b` than `v` is. Geometrically, take the triangle formed by `v`, `a`, `b` and delete its longest edge. This is a good idea. It prevents a dense cluster of redundant short edges, and it works because search can still reach `b` from `v` by hopping through `a`.

Now filter. Suppose `v` and `b` both pass the query predicate but `a` does not. In the predicate subgraph, `a` does not exist, so `v`, `a`, `b` never formed a triangle. The detour that justified deleting edge `v→b` is gone. HNSW has severed a connection between two nodes that both belong in the answer, and no cleverness at query time recovers it, because the edge is not in the index.

This is the actual reason post-filtering degrades under low selectivity. It is not just wasted distance computations. The filtered subgraph is *disconnected*, so greedy search cannot reach whole regions of qualifying vectors. That is why post-filtering plateaus at low recall rather than merely getting slower, and why the effect is worst when the predicate anti-correlates with the query vector.

## Expand, then prune predicate-agnostically

ACORN-γ makes two changes to construction.

**Neighbor list expansion.** Instead of collecting `M` candidate edges per node, collect `M · γ`, where γ is a neighbor expansion factor. The intuition is a direct probabilistic argument. With no predicate clustering, the expected filtered degree of a node is:

$$\mathbb{E}\left[|N_p^l(v)|\right] = |N^l(v)| \cdot s = \gamma \cdot M \cdot s$$

For that to stay above `M`, the degree bound that makes greedy search work, you need $s > 1/\gamma$. So γ is not a tuning knob you guess at, it is derived from the minimum selectivity you intend to serve: set $\gamma = 1/s_{min}$. Queries estimated below $s_{min}$ fall back to pre-filtering, which is genuinely the right algorithm in that regime. A selectivity misestimate costs throughput, never correctness.

Crucially, during construction ACORN traverses using only the first `M` entries of each expanded list. The extra edges exist to survive filtering, not to be walked during indexing, so build cost does not scale with the full `M · γ` fanout.

**Predicate-agnostic pruning.** The expansion inflates the index, so ACORN compresses it, but with a rule that is safe under arbitrary filtering. Retain the nearest $M_\beta$ candidates unconditionally. For the remaining candidates, maintain a set $H$ of two-hop neighbors already covered; prune candidate `c` if `c ∈ H`, otherwise keep `c` and add all of its neighbors to `H`. Stop when `|H|` plus the kept edges exceeds `M · γ`.

The invariant this buys is the whole trick:

> Any node `x` pruned from `v`'s neighbor list is present in `N(y)` for some kept neighbor `y` of `v` with list index greater than $M_\beta$.

Pruned edges are *recoverable*, and recoverable without knowing the predicate. Compression targets level 0 only, since HNSW's exponentially decaying level assignment puts nearly all edges there. Average per-node memory becomes $O(M_\beta + M + m_L \cdot M \cdot \gamma)$ versus HNSW's $O(M + m_L \cdot M)$, and construction complexity goes from $O(n \log n)$ to $O(n \cdot \gamma \log n \log \gamma)$.

## Search: filter, expand, truncate

The search loop is HNSW's, with one line changed, the neighbor lookup:

```python
def get_neighbors(v, level, predicate, M, M_beta):
    raw = neighbor_list(v, level)
    out = []
    # Phase 1: the M_beta exactly-retained edges. Plain filter.
    for u in raw[:M_beta]:
        if predicate(u):
            out.append(u)
    # Phase 2: pruned region. Expand to two-hop to recover deleted edges.
    for u in raw[M_beta:]:
        if predicate(u):
            out.append(u)
        for w in neighbor_list(u, level):   # recovers pruned nodes
            if predicate(w):
                out.append(w)
    return out[:M]      # degree bound enforced at SEARCH time, not build time
```

Note that the degree bound moves from construction to search: HNSW caps out-degree at `M` when building, ACORN caps the *filtered* neighborhood at `M` when querying, keeping distance computations per visited node constant. And the two-hop expansion is exactly the inverse of the pruning rule, which is why it recovers what compression removed.

**ACORN-1** pushes this further: build a plain HNSW index with no pruning at all (γ = 1, $M_\beta = M$), and do the full one-hop plus two-hop expansion entirely at query time. It approximates ACORN-γ's dense graph without paying to store it, at 1.5x to 5x lower QPS but 9x to 53x lower time-to-index.

## What the numbers say

On low-cardinality benchmarks (SIFT1M, Paper), ACORN-γ beats the specialized indexes `NHQ` and `FilteredDiskANN` by 2x to 10x QPS at fixed recall, while staying predicate-agnostic. On high-cardinality workloads (TripClick with date and keyword predicates, LAION-1M with regex), the margin widens to 30x to 50x at 0.9 recall. On LAION-25M, ACORN-γ hits over three orders of magnitude higher QPS than the next best baseline at 0.9 recall, because baselines degrade with dataset size while ACORN degrades with filtered-set size.

The instructive comparison is the distance-computation count at 0.8 recall. The oracle partition index wins, ACORN-γ is next, ACORN-1 follows, and HNSW post-filtering is last by a wide margin. ACORN-γ does not fully close the gap to the oracle, and the paper is honest about why: predicate-agnostic pruning precludes RNG-based pruning, so each ACORN level approximates a KNN graph rather than an RNG graph, which is empirically less efficient to search. That is the price of generality, and it is a small one. Construction cost is modest too: TTI at most 11x HNSW's and 2.15x `StitchedVamana`'s, index at most 1.3x HNSW's size and 25% smaller than `StitchedVamana`'s.

## The production version disagrees on one thing

Weaviate shipped ACORN in 1.27 as an opt-in filter strategy, and its deviations are as interesting as the paper. It implements **ACORN-1** and deliberately does not change indexing at all, which means ACORN can be switched on without reindexing existing data, a deployment constraint no paper optimizes for. It applies two-hop expansion *conditionally*, only when the connecting node fails the filter, so traversal behaves like plain HNSW in filter-dense regions. And it seeds extra layer-zero entry points that match the filter, handling the case where the natural entry point lands somewhere with almost nothing passing.

Their measurements also sharpen when this matters. At roughly 20% selectivity with low correlation, the older sweeping strategy gets about half of ACORN's QPS at equal recall. At 50% selectivity, sweeping is *faster*. Under high correlation, sweeping wins too, since the filtered and unfiltered results largely coincide.

That inversion is the real engineering lesson. ACORN is not a strictly better algorithm, it is the correct algorithm for a specific and very common region of the workload space: moderate selectivity, weak or negative correlation between the predicate and the query vector. Which is precisely what multi-tenant RAG looks like. The remaining hard part is not the graph traversal, it is the selectivity estimator that picks between pre-filter, ACORN, and post-filter, and if that sounds like a query optimizer problem, it is because it is one.
