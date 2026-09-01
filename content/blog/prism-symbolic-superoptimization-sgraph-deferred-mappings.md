---
title: "Prism: Symbolic Superoptimization, or How to Not Decide Things Yet"
date: 2026-09-01
tags: [compilers, gpu, superoptimization, e-graphs, llm-inference]
excerpt: "Tensor-program superoptimizers die on a product search space: graph structures × tensor-partition mappings × tile sizes. Prism symbolizes the last two factors so the generator never enumerates them. I rebuilt the mapping space by brute force to see where the win actually comes from — and it is a very large constant, not a smaller exponent."
---

A superoptimizer for tensor programs is a compiler that gives up on rewrite rules. Instead of applying a curated list of transformations, it enumerates candidate programs, checks each for semantic equivalence against the input, and profiles the survivors. Mirage (OSDI '25) did this across the whole GPU hierarchy at once, and it works — it beats hand-tuned kernels by discovering fusions no human wrote down.

It also falls over, because the search space is a product and one factor is enormous.

[Prism](https://arxiv.org/abs/2604.15272) (Wu, Jiang, Padon, Jia — April 2026) is the follow-up, and its central move is refusing to commit. Two of the three factors get replaced by symbolic variables so the generator never enumerates them at all. The result is a superoptimizer that finds strictly more kernels — 14 unique graphs for attention where Mirage found 3–4 — while cutting search time on the workload where Mirage times out from >3600s to 871s.

## The product that kills you

Mirage's representation is the μGraph: a three-level graph spanning the kernel, thread-block, and thread levels of the GPU execution hierarchy. When a kernel-level operator expands into a block graph, three mappings say how data moves:

- `imap` — how input tensors are partitioned across grid dimensions
- `fmap` — how loop bodies iterate over reduction dimensions
- `omap` — how outputs are reassembled

In Mirage these are concrete during search. So is every grid dimension, block dimension, and for-loop count. A candidate is `(structure, mappings, parameters)`, and the generator enumerates the Cartesian product:

```
O(G * M * D)
```

where `G` is the number of graph structures, `M` the mapping assignments, `D` the parameter points. Every one of those gets built, verified, compiled, and possibly profiled.

## What sGraph symbolizes

An sGraph is a μGraph with the last two factors left as variables. Grid and loop dimension sizes become symbolic integers `d_x, d_i, ...`. Mappings become Boolean variables:

```
m[T,d,p] = 1  iff  data dimension d of tensor T is partitioned
                   along parallelization dimension p
```

with `m[T,d,p] = 0` meaning `T` is replicated along `p`. Output tensors only carry grid dimensions, since reductions along loop dimensions are already implied.

One sGraph therefore denotes a *family* of μGraphs. Two definitions make this precise. A **correct mapping** is an assignment `m̂` such that for *every* assignment `d̂` of the parallelization parameters, the instantiated graph computes the input program's function. A **feasible sGraph** has at least one correct mapping. Note the quantifier order: correctness is established once, for all tile sizes, before any tile size is chosen. That is the whole trick.

## Symbolic dimension matching

The generator still builds graphs incrementally, and still has to reject an operator whose shapes don't line up. With symbolic sizes it can't compare integers, so it compares expressions.

Adding a `Matmul` requires the contracting dimensions to agree. The left input's column dimension carries symbolic size `sigma(X,c)`, containing terms `m[X,c,x] * d_x` and `m[X,c,i] * d_i`; the right input's row dimension carries `sigma(W,r)` with `m[W,r,x] * d_x` and `m[W,r,i] * d_i`. These must be equal *as functions of* `d`, which by coefficient matching gives:

```
m[X,c,x] == m[W,r,x]
m[X,c,i] == m[W,r,i]
```

Two constraints, recorded and deferred — not a filter applied to 3000 enumerated assignments. If the resulting dimension expressions are not symbolically equivalent under `+ - * /`, the partial sGraph is pruned immediately.

The second pruning technique evaluates the partial graph at `d̂ = 1`, which makes all shapes independent of the mappings, then reuses Mirage's abstract subexpression check. The authors are careful to note this is *under-pruning*: it never discards a partial graph that could lead to a feasible sGraph, but it does retain infeasible candidates that get filtered later. That asymmetry is the right one — a search that over-prunes silently loses kernels.

## Verifying a family, not a program

Equivalence checking happens once mappings are concrete but parameters are still symbolic. Prism encodes both the input program and the candidate as expressions over four parallelization operators — `part` (split a data dimension across a parallel dimension), `comb` (its inverse, concatenate), `red` (reduce across a parallel dimension), `repl` (replicate) — plus the compute operators. The Figure 1 example becomes:

```
E_input = div(matmul(exp(v_X), v_W), sum(exp(v_X)))
E_cand  = comb(div(matmul(exp(part(v_X, r, x)), part(v_W, c, x)),
                   red(exp(part(v_X, r, x)), x)), r, x)
```

Then ~70 equivalence axioms are thrown at an e-graph (implemented in ~550 lines of Rust over `egg` 0.10.0). The axioms are the algebra you'd expect — `matmul` associativity and distributivity, `comb(part(t,d,p),d,p) = t`, commutation of every parallelization operator past every elementwise op — plus eight distinct "compound parallelized sum" forms, which exist because nested partition/reduce combinations don't factor into the simple cases.

There's a genuinely subtle engineering problem here. E-graph rewrite rules `l -> r` may only introduce variables already bound in `l`. So a bidirectional axiom is only usable in the direction that satisfies the subset constraint, and this breaks on consecutive parallelized matmuls:

```
comb(comb(matmul(matmul(repl(part(A,r,x),y), repl(repl(B,x),y)),
                 part(C,c,y)), r, x), c, y)
  = matmul(matmul(A, B), C)
```

The single-matmul axioms all fire left-to-right, peeling one parallelization operator at a time — and the nested operators here can't be peeled one at a time. Prism's fix is to add an *inverse* rule for every axiom of the form `op2(matmul(op0(t0), op1(t1))) = matmul(t0, t1)`:

```
matmul(op0(t0), op1(t1))  ->  inverse(op2)(matmul(t0, t1))
```

pushing parallelization operators *outward* instead of cancelling them. That direction introduces no new variables, and it lets the e-graph close the nested case.

Soundness rests on manual review of the axiom set plus random equivalence testing of every discovered kernel. Completeness is explicitly not claimed — `T + T = 2·T` isn't covered, and whether a recursively enumerable complete axiomatization exists is left open. Worth knowing if you were about to trust this in a build pipeline.

## Where the win actually comes from

The paper frames the improvement as `O(G * M * D)` collapsing to `O(G)` for structure search. I wanted to know whether that reshapes the exponent or just shrinks a constant, so I rebuilt the mapping space by brute force for the Figure 1 graph — tensors `X[r,c]`, `W[r,c]`, `O[r,c]`, grid dims `{x,y}`, loop dim `{i}` — and applied the constraints in the paper's order:

```python
VARS = [(T,d,p) for T in ["X","W"] for d in ["r","c"] for p in ["x","y","i"]] + \
       [("O",d,p) for d in ["r","c"] for p in ["x","y"]]   # 16 booleans

# (1) each parallelization dim partitions <= 1 data dim of T
# (2) each data dim is partitioned by <= 1 grid dim
# (3) symbolic dim-match: m[X,c,p] == m[W,r,p] for all p
# (4) grid dims are interchangeable -> keep lexicographically smallest
```

Exhaustive enumeration over all 2^16 assignments:

| stage | surviving assignments |
|---|---|
| raw | 65,536 |
| + well-formedness | 3,087 |
| + symbolic dim-match equalities | 595 |
| + grid symmetry breaking | 300 |

So `M` drops 10.3× from constraints Prism gets to record symbolically rather than test. Then the cost model. With `f` the fraction of structures that are feasible, `v` the fraction of (structure, mapping) pairs that verify, and `D = 64`:

| structures `G` | feasible `f` | concrete | Prism | ratio |
|---|---|---|---|---|
| 20 | 0.05 | 3,951,360 | 2,240 | 1764× |
| 200 | 0.05 | 39,513,600 | 22,400 | 1764× |
| 2000 | 0.30 | 395,136,000 | 1,334,000 | 296× |

The ratio is *constant in* `G`. Deferring mappings does not lower the order of the search in the number of graph structures — it strips the `M * D` factor off the per-node work of the generator and multiplies those factors only against survivors. That is a two-to-three-order-of-magnitude constant, which is why RMSNorm-MLP goes from timeout to 871s and RMSNorm's search drops 11.6s → 0.3s (39×). But if you were hoping symbolic search makes the structural blowup tractable at larger operator counts, it doesn't; it buys headroom, not asymptotics.

One place my model fails: the paper's ablation shows search time of 20.5s / 5.5s / 2.5s when `imap` / `fmap` / `omap` alone are concretized. Variable counting gives imap 8, fmap 4, omap 4 — predicting fmap ≈ omap, where the measurement shows a 2.2× gap. Counting isn't the whole story; `omap` carries only grid dimensions, so concretizing it constrains the graph earlier and prunes harder per variable. The combinatorial size of a decision isn't the same as its pruning power.

## The transferable idea

Prism's headline numbers are 2.2× over Mirage and 4.9× over `torch.compile` on five LLM kernels, measured on A100s. Those will age. What won't is the structure of the move: when your search space is a product of decisions, find the ones whose *correctness* doesn't depend on the others, settle correctness at that level, and push the rest into a later phase where they multiply only against survivors. Type inference does this with unification variables; query planners do it by separating join order from access method. Prism does it by noticing that whether a partitioning is correct never depended on how big the tiles were.

The cost is needing an equivalence checker that works on families of programs rather than programs — which is why the interesting engineering here is in the e-graph rules, not the search loop.
