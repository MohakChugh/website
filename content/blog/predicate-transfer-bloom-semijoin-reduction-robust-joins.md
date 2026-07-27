---
title: "Predicate Transfer: Yannakakis's 1981 Algorithm, Rebuilt Out of Bloom Filters"
date: 2026-07-27
tags: [databases, query-optimization, joins, bloom-filters, duckdb]
excerpt: "There is a 1981 algorithm that provably evaluates any acyclic join in time proportional to input plus output, and essentially no production database uses it, because its constant factor makes queries 2.4x slower on average. Predicate transfer resurrects it by replacing exact semi-joins with Bloom filters, and the 2025 follow-up work shows that the interesting part was never the filters, it was the schedule."
---

Every analytics engine spends enormous effort on join ordering, and it spends that effort on top of cardinality estimates that are known to be wrong by orders of magnitude on real schemas. The standard response is to make the estimates better. The more interesting response, which is where the research has actually gone, is to make the plan's runtime stop caring.

There has been a provably good answer sitting in the literature since 1981. Almost nobody ships it. The story of why, and of what finally made it practical, is one of the cleaner examples I know of theory and systems engineering meeting in the middle.

## The algorithm nobody runs

Yannakakis's algorithm (VLDB '81, concurrently Bernstein and Chiu in JACM 28(1)) evaluates any α-acyclic conjunctive query in `O(N + OUT)` time. That bound is instance optimal, since you cannot beat reading the input and writing the output.

The mechanism is semi-join reduction over a join tree. Take a chain query:

```sql
SELECT *
FROM R JOIN S USING (j)
     JOIN T USING (k)
     JOIN U USING (l);
```

with join tree `R → S → T → U`. Yannakakis runs three phases:

1. **Bottom-up semi-joins.** `T' = T ⋉ U`, then `S' = S ⋉ T'`, then `R* = R ⋉ S'`.
2. **Top-down semi-joins.** `S* = S' ⋉ R*`, `T* = T' ⋉ S*`, `U* = U ⋉ T*`.
3. **Join.** Any order now works.

After the two waves every relation is *fully reduced*: no tuple survives that fails to contribute to the final output. Dangling tuples are the entire reason intermediate results explode, so eliminating them bounds every intermediate result by `OUT`, and join ordering stops mattering.

The reason this is not in your database is measurement, not skepticism. Recent experiments on the Gottlob et al. implementation show semi-join reduction *increasing* average query runtime by **2.4x** (see the ICDT 2026 retrospective, arXiv:2601.00098); Birler, Kemper and Neumann independently measured the same implementation at roughly **5x slower** on the cyclic-and-acyclic CE benchmark (PVLDB 17(11)). Each semi-join is a full hash build plus probe over a base relation. On a selective query that would have finished in 200ms anyway, you have paid for six hash tables to learn nothing. The three-pass structure also does not fit neatly into a cost-based optimizer that plans in one pass.

So: a guarantee worth having, wrapped in a constant factor nobody will pay.

## Approximating the semi-join

**Predicate Transfer**, from Yifei Yang, Hangdong Zhao, Xiangyao Yu and Paraschos Koutris (CIDR '24, arXiv:2307.15255), makes the obvious substitution and then does the non-obvious work of making it general. Replace each exact semi-join with a Bloom filter probe. A semi-join costs a hash table; a blocked Bloom filter probe costs a few cache-resident bit tests.

Two pieces make this more than "Bloom joins, but more of them."

**The Predicate Transfer Graph.** Orient every edge of the join graph from the smaller to the larger relation, using cardinality after local predicates. Because the orientation follows a total order on sizes, the result is a DAG, which is what makes a schedule well defined. Then run a **forward pass** in topological order: at each node, apply local predicates and all incoming filters, build a Bloom filter on the outgoing join key, push it to successors. Then reverse every edge and run a **backward pass**. Only after both passes does any join execute.

**Filter transformation.** This is the part that distinguishes predicate transfer from ordinary runtime filter pushdown. When a node receives a filter keyed on column `a` but its outgoing edge joins on column `b`, a single scan re-keys the survivors into a fresh filter on `b`. That is what lets information propagate *multiple hops* across the join graph rather than one build-to-probe step:

```python
# Forward pass over the predicate transfer graph.
# Each node emits filters keyed on its OUTGOING join columns,
# which is generally not the column it was filtered on.
for node in topological_order(ptg):
    rows = scan(node.table, node.local_predicates)
    for f in node.incoming_filters:          # arrived from predecessors
        rows = [r for r in rows if f.maybe_contains(r[f.key])]
    for edge in node.outgoing_edges:          # re-key: the transformation step
        bf = BloomFilter(bits_per_key=12)     # ~2% FPR
        for r in rows:
            bf.insert(r[edge.key])
        edge.target.incoming_filters.append(bf)

# ...then the identical loop over reverse(ptg), then the join phase.
```

False positives are safe, and the reason is structural rather than probabilistic: a Bloom filter has no false negatives, so no qualifying tuple is ever discarded, and any surviving non-qualifying tuple fails the real equality predicate in the join phase. Correctness never depends on the filter being right. This breaks in exactly one place, which the ICDT retrospective names: if the filter must carry *payloads* rather than answer yes/no, false positives become wrong answers. That is why exact structures (IN-lists, hash tables) remain necessary for anything that returns values.

On TPC-H at SF1 and SF10, the CIDR prototype reports **3.3x** average speedup over Bloom join and roughly **4x** over no pre-filtering, with a best case of 63x on Q2, a nine-table join where the transfer phase removes over 99% of the input rows. Against Yannakakis itself: 4.2x and 4.8x. The robustness number is the one that matters most: join order changed runtime by **at most 12%** under predicate transfer, versus up to **45x** without it.

Two caveats worth carrying. Those are TPC-H numbers on a research prototype, one core, not DuckDB and not the Join Order Benchmark. And the paper is explicit that it gives up the theory: "predicate transfer does not provide theoretical optimality, but it is more versatile."

## The schedule was the hard part

That admission is where the follow-up work starts. **Robust Predicate Transfer** (Junyi Zhao et al., "Debunking the Myth of Join Ordering", PACMMOD 3(3), SIGMOD '25) identifies why the guarantee was lost, and it is not the false positives. It is that the smaller-to-larger heuristic can produce transfer schedules yielding **incomplete** semi-join reductions. Dangling tuples survive, so intermediate results are unbounded again.

RPT replaces the heuristic with two mechanisms. **LargestRoot** builds a maximum spanning tree over the weighted join graph, rooted at the largest table. **SafeSubjoin** only executes subjoins that provably cannot produce dangling tuples, resting on a clean structural result (Theorem 3.6): every Cartesian-product-free subjoin of a natural join query is safe **if and only if the query is γ-acyclic**.

The payoff is measured against the pathology directly. On a diamond query, the worst join order produces **179x** more intermediate tuples than the best; with RPT that spread collapses to **1.2x**. End to end on DuckDB, roughly **1.5x** geometric mean in memory, with 94% of benchmark queries acyclic and the worst best-versus-worst gap across them only 2.8x. Notably, plain Bloom join "does not improve join-order robustness" at all. The 2026 follow-up, RPT+ with dynamic execution (PVLDB 19(6)), adds asymmetric transfer plans and reports 1.47x on JOB, 1.28x on SQLStorm, 1.17x on TPC-H, while removing RPT's regressions.

## What actually shipped, and how it differs

DuckDB's own sideways information passing arrived incrementally and is worth distinguishing from predicate transfer, because the two are easy to conflate:

- **1.1.0** (Sep 2024): min/max range filters from the hash build pushed into the probe scan, reported around 10x on favorable queries.
- **1.2.0** (Feb 2025): exact IN-list filters when the build side has few distinct keys (`dynamic_or_filter_threshold`, default 50).
- **1.5.0** (Mar 2026): genuine Bloom filters, PR #19502, "Sideways Information Passing for Joins using Bloom Filters" — 12 bits per key, ~2% FPR, 13-17% on IMDB and 3-8% on TPC-H SF10.

Those are real wins, and they are a different thing. DuckDB's filters flow one direction (build to probe, along the chosen join order), one hop, constructed *during* execution, and only when the build side is itself filtered. Predicate transfer runs both directions, chains arbitrarily many hops by re-keying, and completes as a pre-pass before any join starts. The single-digit percentage gains versus 1.5x geomean is roughly the price of that difference.

The practical read: if your workload is star-schema queries with selective dimension filters, standard runtime filter pushdown captures most of the value and you already have it. If your queries are ten-table snowflakes where estimation error compounds and your p99 is dominated by a handful of plans that went wrong, the robustness argument is the one to take seriously. You are not buying average-case speed. You are buying a much narrower distribution, which for a query engine is usually the more valuable purchase.
