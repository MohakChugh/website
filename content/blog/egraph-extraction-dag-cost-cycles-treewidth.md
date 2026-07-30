---
title: "E-Graph Extraction: The NP-Hard Step Everyone Skips With a Greedy Loop"
date: 2026-07-30
tags: [compilers, program-optimization, e-graphs, np-hard, treewidth]
excerpt: "Equality saturation gets all the attention for how elegantly it dodges phase ordering, but the elegant part ends the moment you have to pull one program back out of the e-graph. Under a cost model that accounts for shared subexpressions, extraction is NP-hard and inapproximable to any constant factor, and most production systems quietly run a greedy loop that is wrong in exactly the case you built the e-graph for."
---

Equality saturation has a clean pitch. Instead of applying rewrites destructively and living with whatever phase ordering you picked, you grow an e-graph, a structure representing exponentially many equivalent programs in polynomial space, apply every rewrite everywhere until saturation, and then pick the best program out of the result. The `egg` library (POPL 2021) made this practical with rebuilding, a deferred congruence-invariant restoration scheme, and `egglog` (PLDI 2023) later fused the whole thing with Datalog.

The pitch has a hole in it, and it is in the last clause. "Then pick the best program out of the result" is doing enormous work.

That step is called extraction, and it is where the theory stops being friendly. Under the cost model you actually want, extraction is NP-hard and hard to approximate to within any constant factor. What most systems ship instead is a greedy fixpoint loop that is provably optimal under a cost model nobody wants.

## Two cost models, separated by a complexity cliff

An e-graph is a set of e-classes, each containing e-nodes. An e-node is an operator plus a list of child e-classes. Extraction means choosing exactly one e-node per reachable e-class such that the induced selection is acyclic. That choice function defines a program.

The question is how you score it. There are two answers, and the gap between them is the entire subject.

**Tree cost** treats the extracted program as a term. If a subexpression is used twice, you pay for it twice. This is what the reference `bottom_up.rs` extractor in `extraction-gym` computes, and it is a straightforward fixpoint:

```rust
loop {
    for class in egraph.classes().values() {
        for node in &class.nodes {
            // node.cost + sum of children's *class* costs
            let cost = result.node_sum_cost(egraph, &egraph[node], &costs);
            if &cost < costs.get(&class.id).unwrap_or(&INFINITY) {
                result.choose(class.id.clone(), node.clone());
                costs.insert(class.id.clone(), cost);
                did_something = true;
            }
        }
    }
    if !did_something { break }
    did_something = false;
}
```

This is optimal, and it runs in polynomial time. The reason it is easy is that each e-class has a single scalar cost that is independent of what happens elsewhere in the graph. Optimal substructure holds, so local greedy relaxation converges to the global optimum.

**DAG cost** treats the program as what it actually is after common subexpression elimination: a DAG. You pay for each selected e-node once, no matter how many parents reference it. This is the cost model that matters, because sharing is the entire reason you are compiling to a DAG in the first place.

And it destroys optimal substructure. The cheapest way to compute e-class `A` now depends on what e-class `B` chose, because if `B` already paid for a shared subexpression, `A` gets it free. The cost of a choice is no longer a scalar, it is a set. You can see the consequence directly in the greedy DAG extractor, which is forced to carry a whole map of contributing classes per candidate:

```rust
struct CostSet {
    costs: FxHashMap<ClassId, Cost>,  // which classes this selection pays for
    total: Cost,
    choice: NodeId,
}
```

`total` is then the sum over *distinct* classes, which is what makes sharing free. That single change from a scalar to a set is the complexity cliff. DAG-cost extraction was shown NP-hard in Stepp's 2011 dissertation, and Goharshady, Lam and Parreaux (OOPSLA 2024) sharpened this considerably: it is hard to approximate to any constant factor. There is no polynomial-time algorithm that gets you within 2x, or 100x, of optimal.

The greedy DAG extractor is not merely theoretically suboptimal, it degrades on exactly the structure e-graphs exist to represent. Its inner loop bails out of a candidate entirely whenever a child's cost set already contains the current class, discarding the candidate rather than reasoning about it. High sharing is precisely the regime where greedy has the most to lose.

## Cycles are a correctness constraint, not an optimization

The second problem is subtler and catches people. E-graphs are cyclic. Saturating `x * 2 → x + x` alongside `x → x * 1` will happily produce an e-class that reaches itself. That is fine as a *representation*, since the cycle just encodes infinitely many equivalent terms.

It is not fine as an *extraction*. If your choice function selects an e-node in class `A` whose operand chain leads back to `A`, the extracted program has an operand that depends on the operator computing it. There is no evaluation order. You have emitted a program that either does not terminate or does not have a meaning.

So acyclicity is a hard constraint, and it is annoying to encode. The exact ILP extractor uses binary `active` variables per class and per node with two structural constraints (a class is active iff exactly one of its nodes is, and an active node forces its children's classes active), then blocks cycles with a topological-ordering encoding: a real-valued `level` per e-class, plus a big-M term that switches the constraint off when the node is not selected.

```
// for active node n in class c, with child class cc:
//   -level[c] + level[cc] + (|C|+1) * not_selected[n]  >=  1
```

When `n` is selected, `not_selected[n]` is 0 and the constraint bites: `level[c] < level[cc]`. Levels must strictly increase toward children, so no cycle can survive. When `n` is not selected, the big-M term dominates and the row is vacuous. Self-loops get special-cased and pinned to zero.

This is exact, and it is also why exact extraction has a reputation for not scaling: you have handed a MILP solver a level variable per e-class and a big-M row per node-child edge, on graphs whose average size in the `extraction-gym` corpus runs to 20,000 to 58,000 nodes for sources like `eggcc-bril`, `flexc` and `tensat`.

## Three ways out, all from the last two years

Extraction has stopped being a footnote and become its own research area, with three genuinely different attacks.

**Parameterize on treewidth.** Sun, Zhang and Ni observed that an e-graph *is* a monotone Boolean circuit: convert every e-class to an OR gate, every e-node to an AND gate, and flip every edge. Extraction is then exactly weighted monotone circuit satisfiability, with the single caveat that the circuit may be cyclic. That reduction lets them import an existing treewidth-parameterized algorithm of Kanj, Thilikos and Xia (2017) essentially wholesale, yielding optimal extraction in `2^O(w²) · poly(w, n)` time for treewidth `w`.

The payoff is not only the algorithm, it is that circuit minimization is a mature field with decades of tooling. Their simplification rules reduced `|V|` by 60% or more on all but one benchmark collection, and on `eggcc-bril` by 97% with a 65% treewidth reduction. Notably, `babble` and `flexc` saw negligible treewidth improvement, and the authors are careful to note that the low treewidth in this corpus is likely explained by sparsity alone rather than anything structural about e-graphs. Goharshady, Lam and Parreaux arrived at treewidth parameterization independently, without the circuit framing.

**Relax to a continuous problem and run it on a GPU.** SmoothE (ASPLOS 2025) reframes extraction probabilistically: instead of binary selections, learn a distribution over e-nodes per e-class via softmax, making the objective differentiable and solvable by gradient descent. The clever part is acyclicity. They borrow the NOTEARS trick from causal structure learning, building a transition matrix `A_z` of inter-class dependency probabilities and adding `tr(e^{A_z}) - n` as a penalty, which is zero exactly when the graph is acyclic. Matrix exponentials are expensive, so they decompose into strongly connected components, since cycles can only live inside an SCC, and sum per-SCC penalties. Implemented in PyTorch with seed batching, it reports 8x to 37x speedup over ILP solvers at comparable or better quality on four of five datasets.

Because the relaxation is differentiable, it also accepts nonlinear cost models, which ILP structurally cannot. That is arguably more durable than the speedup.

**Prune, then warm-start an exact solver.** e-boost (ICCAD 2025) is the least exotic and reports the largest numbers: parallelize heuristic DAG-cost computation by exploiting weak data dependence, use a threshold to keep only promising candidates, then hand the shrunken problem to an ILP solver with a warm start. It claims a 558x runtime speedup over conventional exact ILP and a 19% quality improvement over SmoothE.

## What to take from this

If you are building on an e-graph, the operational point is that your extractor is probably the weakest link in your pipeline, and its failure mode is invisible. A greedy DAG extractor returns a valid program. It does not tell you that it discarded the sharing structure you saturated for hours to discover.

The checklist is short. Know which cost model your extractor actually optimizes, since tree cost and DAG cost are different problems and only one of them is easy. Verify acyclicity of the result explicitly rather than trusting it. And measure how far your heuristic sits from exact on small instances, because the inapproximability result means there is no bound you can assume in place of measurement.

The deeper lesson is a familiar one in disguise. Equality saturation dissolved phase ordering by refusing to commit to a rewrite until the end. That was a real advance. But the commitment did not disappear, it got deferred into a single combinatorial decision, and deferring a hard choice concentrates it rather than eliminating it. The last few years of extraction research are the bill arriving.
