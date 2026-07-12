---
title: "DBSP: Turning Any SQL Query Into an Incremental Stream Processor"
date: 2026-07-12
tags: ["incremental-computation", "stream-processing", "databases", "dataflow", "materialized-views"]
excerpt: "DBSP is a small, complete algebra that mechanically converts any relational query into an incremental one that updates materialized views in time proportional to the change, not the data. Here is how the circuit model, Z-sets, and the differentiation identity make it work."
---

Materialized views are the eternal temptation of data systems: precompute an expensive query once, then serve reads instantly. The catch is maintenance. When the base tables change, the view is stale, and recomputing it from scratch defeats the purpose. Incremental view maintenance (IVM) has been studied for three decades, but the classical results were a patchwork: one hand-derived delta rule for joins, another for aggregation, special cases for `DISTINCT`, and nothing coherent for recursion. Every new operator meant a new proof.

DBSP, introduced by Budiu et al. and now the engine underneath Feldera, replaces that patchwork with a single theory. The claim is strong and precise: **any query expressible as a composition of a small set of operators can be incrementalized mechanically, and the incremental version runs in time proportional to the size of the change rather than the size of the data.** This post walks through why that works.

## Streams and the Z-set foundation

DBSP models computation over *streams*. A stream `s` is an infinite sequence of values `s[0], s[1], s[2], …`, one per logical timestep. Timesteps correspond to transactions or micro-batches: each step delivers a new increment of input and produces a new increment of output.

The values flowing through the streams are not raw tables. They are **Z-sets** (also called Z-relations). A Z-set is a map from rows to integer weights:

```
{ (Alice, 30): 1,    ← one copy of this row
  (Bob,   25): 1,
  (Carol, 40): 3 }   ← three copies
```

Positive weights mean "these rows are present"; a batch of changes uses negative weights to mean deletion. Inserting a row is `+1`, deleting it is `-1`, updating is a `-1` on the old value plus a `+1` on the new. Because weights are integers, Z-sets form an *abelian group*: they can be added element-wise, and every Z-set has an inverse (negate all weights). That algebraic structure is the whole trick. A "change" and a "state" live in the same type, and applying a change is just addition.

```
state  = { (Alice,30): 1, (Bob,25): 1 }
change = { (Bob,25): -1, (Carol,40): 1 }   ← delete Bob, insert Carol
state + change = { (Alice,30): 1, (Carol,40): 1 }
```

Relational operators lift naturally onto Z-sets. Selection filters rows and keeps weights. Projection sums weights of rows that collapse together. Union is Z-set addition. Join multiplies weights of matching pairs. `SELECT COUNT(*)` becomes "sum the weights." The important property is that these lifted operators are **linear** or built from linear pieces, which is what makes the next step possible.

## The circuit model: three operators

DBSP expresses a computation as a *circuit*: a dataflow graph of operators connected by streams. Beyond the relational operators, only three structural operators matter, and they are what encode time.

**Delay** `z⁻¹` shifts a stream by one timestep, outputting `0` at time 0 and `s[t-1]` thereafter. It is the only stateful primitive; everything else is memoryless.

**Integration** `I` computes running totals: `I(s)[t] = s[0] + s[1] + … + s[t]`. It turns a stream of *changes* into a stream of *snapshots*. Integration is definable purely from delay and addition — it is a feedback loop that adds each input to the accumulated delayed output:

```
        ┌──────────────┐
  s ───▶(+)────┬──────────▶ I(s)
         ▲     │
         │   ┌───┐
         └───│z⁻¹│◀──┘
             └───┘
```

**Differentiation** `D` is the inverse: `D(s)[t] = s[t] - s[t-1]`. It turns a stream of snapshots into a stream of changes. By construction `D ∘ I = I ∘ D = identity`.

That inverse relationship is the entire foundation of incremental computation, and it collapses into one line.

## The incrementalization theorem

Let `Q` be any query, lifted to operate on a stream of complete database snapshots. Its **incremental version** `Q^Δ` is defined to take a stream of *changes* and produce a stream of *changes*:

```
Q^Δ  =  D ∘ Q ∘ I
```

Read it right to left: integrate the incoming changes to reconstruct the full input snapshot, run the ordinary query, then differentiate the output to get just the change. This is provably correct for *any* `Q` — no per-operator cleverness required. It is the chain rule of stream computation.

On its own, `D ∘ Q ∘ I` is useless: it rebuilds the entire input and recomputes from scratch every step, which is exactly what we wanted to avoid. The value comes from a set of algebraic rewrite rules that push the `D` and `I` *through* `Q` until they cancel:

- **Linear operators** (selection, projection, union): `Q^Δ = Q`. A linear operator applied to a change already produces the corresponding output change. Filtering a delta and filtering a full table give consistent results, so selection needs *no state at all* to incrementalize.
- **Bilinear operators** (join): the classic delta rule falls out of the algebra. For streams `a` and `b`, `(a ⋈ b)^Δ = Δa ⋈ I(b) + I(a) ⋈ Δb + Δa ⋈ Δb`. The incremental join keeps integrated copies of both inputs (the join indexes) and combines each new delta against the other side's accumulated state.
- **Composition**: `(Q₁ ∘ Q₂)^Δ = Q₁^Δ ∘ Q₂^Δ`. Incrementalization distributes over composition, so you incrementalize a query operator by operator and wire the results together. This is why the method scales to arbitrary query plans.

Because the rules are purely syntactic transformations on the circuit, a compiler can apply them automatically. Feldera's SQL compiler does exactly this: it parses SQL, builds the DBSP circuit, applies the `^Δ` rewrites, and emits an incremental dataflow program. The developer writes an ordinary `CREATE VIEW`; the system delivers a maintained one.

## Recursion, and why the algebra is closed

The genuinely hard case in classical IVM is recursion: transitive closure, graph reachability, `WITH RECURSIVE`. DBSP handles it because recursion is just a feedback loop in the circuit, and the algebra is *closed* under the fixed-point operator. A recursive query becomes a nested circuit that iterates to a fixed point at each timestep, and the same `D ∘ Q ∘ I` identity applies to the whole nested block.

The practical consequence is dramatic. Consider maintaining the set of nodes reachable from a source in a graph, under a stream of edge insertions and deletions:

```sql
CREATE VIEW reachable AS
WITH RECURSIVE r(node) AS (
    SELECT source FROM roots
    UNION
    SELECT e.dst FROM r JOIN edges e ON r.node = e.src
)
SELECT node FROM r;
```

A from-scratch recomputation is `O(V·E)` per change. The DBSP-incrementalized version does work proportional to the number of reachability facts that actually change when an edge is added or removed, which for most updates is a tiny fraction of the graph. The same query text, same semantics, radically different cost profile — and the developer changed nothing.

## What the runtime actually stores

The theory says incremental operators keep integrated state (the `I` boxes that did not cancel). In practice this state is the set of *indexes* the query needs: join indexes keyed by join column, aggregation state keyed by group. DBSP runtimes store these as persistent, sharded key-value structures (Feldera layers them on RocksDB-style storage) and checkpoint them for fault tolerance. Two engineering properties fall out of the algebra:

1. **Bounded work per step.** Each operator touches only the keys mentioned in the incoming delta. A one-row insert into a billion-row table joins against exactly the matching keys on the other side, not the whole table.
2. **Deterministic replay.** Because the circuit is a pure function of its input stream, reprocessing the same change stream reproduces the same state. Recovery is replaying deltas from the last checkpoint — no separate reconciliation logic.

A subtle cost worth naming: incremental joins must retain both integrated inputs as indexes. State grows with the *base data*, not just the change rate. For an unbounded stream joined against itself, you need retention policies or windowing, exactly as you would in any stateful stream processor. DBSP does not make state free; it makes the *computation* proportional to change while being explicit about what must be remembered.

## Why this matters

The older streaming systems — those built on hand-written delta rules or on operator-specific incremental logic — could never guarantee that an arbitrary query would incrementalize correctly. You wrote streaming code and batch code separately and hoped they agreed. DBSP's contribution is that **batch and streaming become the same program**. You write the query once as if over a static database; the `D ∘ Q ∘ I` machinery mechanically produces the streaming version, with a proof that the two compute identical results.

That is the quiet revolution here. Not a faster join or a cleverer index, but a closed algebra in which incrementality is a *theorem* rather than an implementation detail. The materialized view stops being a maintenance liability and becomes what it always should have been: a query you wrote once, kept fresh for free, in time proportional to the change.
