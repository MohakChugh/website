---
title: "Two Slots and a Square Root: Optimal Weak Isolation Testing"
date: 2026-08-20
tags: [databases, transactions, isolation-levels, testing, complexity]
excerpt: "Checking whether a database actually delivered Read Committed is polynomial time, which sounds like the end of the story until you notice the state of the art was degree six. AWDIT (PLDI 2025) gets Read Committed and Read Atomic to n^1.5 and Causal Consistency to n*k, and proves you cannot do better without fast matrix multiplication. I reimplemented the core pass and fuzzed 20,000 histories to find out where the cleverness actually lives."
---

Your database advertises Read Committed. You ran a workload. Did you get Read Committed?

That question is a graph problem, and for weak isolation levels it is a polynomial time graph problem, which has been known since Biswas and Enea's POPL 2019 work. So the problem was considered solved, and then nobody could run the solution. The best prior checker with an explicit complexity bound, Plume (OOPSLA 2024), is `O(n^3 * l^2 * k)`. Degree six is not a checker, it is a way of testing histories with a few thousand operations and then quietly capping your workload generator.

"AWDIT: An Optimal Weak Database Isolation Tester" (Møldrup and Pavlogiannis, PLDI 2025, arXiv:2504.06975) closes this out. Read Committed and Read Atomic in `O(n^1.5)`, Causal Consistency in `O(n*k)` for `k` sessions, plus a conditional lower bound proving the first two are optimal. Reported speedups on the largest fifth of their histories: 245x, 193x, 62x, exceeding 1000x in extreme cases.

The interesting part is not the constant factors. It is that the entire speedup comes from inferring *fewer* edges.

## Histories, and the one relation you do not observe

A history is `H = (T, so, wr)`. `T` is the transactions, split into committed and aborted. `so` is session order, a union of disjoint total orders, one per client session. `wr` is the write read relation, which maps each read to the transaction it read from. A black box tester recovers `wr` for free by writing globally unique values, the standard data independence assumption, so `wr` is observable.

What you never observe is the **commit order** `co`, a strict total order over committed transactions. Every weak isolation level is defined as: the history satisfies five basic read consistency axioms (no thin air reads, no aborted reads, no future reads, observe own writes, observe latest write), *and* there exists a `co` extending `so ∪ wr` that satisfies one additional axiom. Testing is therefore an existential question over total orders, which is exactly why the strong levels are NP complete.

The three weak levels are one template with the premise widened:

```python
# t1 --wr[x]--> the read r_x in t3.  t2 also writes x.  When is t2 forced before t1?
RC:  t2 --wr--> r --po--> r_x        # t3 already saw a co-later writer of x
RA:  t2 --(so ∪ wr)--> t3           # all-or-nothing: no partial transaction visibility
CC:  t2 --(so ∪ wr)+--> t3          # t1 must be co-latest among t3's causal past
```

`CC ⊑ RA ⊑ RC`. Instead of searching for a `co`, you build a partial relation `co'`, seed it with `so ∪ wr`, close it under the relevant rule, and check acyclicity. A cycle is a witness of violation; any linearization of an acyclic `co'` is a valid `co`.

## Minimality is the entire optimization

Here is the definition that does the work. `co'` must be **saturated**, meaning every ordering the axiom implies holds *transitively* in `co'`, so `t2 --co'+--> t1` suffices. It does not need to hold as a direct edge. And `co'` should be **minimal**.

So you are allowed to skip any edge already implied by reachability. Every clever pass in the paper is an application of that license.

The clearest case is Read Committed. Transcribed literally, the axiom is a nested loop over ordered pairs of reads in each transaction, quadratic in transaction size. AWDIT instead does one forward pass recording the `po`-first read from each distinct source `t2`, then one reverse pass maintaining, for each key, the two `po`-earliest distinct transactions read below the cursor. Edges get emitted only at the `po`-first read from each source, because that position dominates every later read from the same source.

Why *two* slots? Because the earliest source below the cursor may be `t2` itself, and the axiom requires `t1 ≠ t2`. One slot is not enough and the second is not optional. I wanted to know how not optional, so I implemented both against a literal transcription of the axiom and fuzzed randomly generated histories, using a deliberately permissive store that lets readers pick any prior version so anomalies are common:

```
histories                        : 20000
RC violations                    : 16288 (81%)
AWDIT emits strictly fewer edges : 3781 (19%)
2-slot verdict mismatches        : 0
1-slot verdict mismatches        : 237
```

Zero disagreements for the two slot version across 20,000 histories, while emitting a strictly smaller edge set on 19% of them. Minimality is real and it is verdict preserving. The one slot version silently reports "no violation" on 237 histories that genuinely violate RC.

The smallest counterexample my fuzzer found has 12 transactions and 33 operations, and the interesting transaction is this one:

```
session 1  T7: [w x2, w x0]
session 2  T8: [w x1, r x0 <- T7, w x0, w x0]
session 0  T9: [r x2 <- T7, r x0 <- T8, r x0 <- T8, r x0 <- T7]
```

`T9` reads `x0` from `T8` twice, then reads `x0` from `T7`. At the `po`-first read from `T8` (index 1), the earliest source below the cursor for key `x0` is index 2, which is `T8` again, so a one slot cache finds nothing to pair with. The second slot holds index 3, source `T7`, yielding the edge `T8 --co--> T7`. Combined with `T7 --wr--> T8`, that is a two cycle. The one slot checker returns clean; the two slot checker reports the violation.

The `n^1.5` bound then comes from a threshold argument. Split transactions at `sqrt(n)`. At most `sqrt(n)` transactions are large, each costing `O(n)` because sources are unique per entry and the written key sets sum to `O(n)`. Small transactions cost `O(reads^2)`, bounded by `sqrt(n)` reads each. Both branches land at `O(n^1.5)`, and with `O(1)`-size transactions the whole thing degrades to linear.

The asymptotic gap is not subtle in practice. One wide reader transaction over eight small writers, quadratic transcription versus the reverse pass, same verdict at every size:

```
  reads  naive ms  awdit ms   ratio  |E| naive  |E| awdit
    250      17.3      0.31      57x         56         25
   1000     239.5      0.75     321x         56         25
   4000    4075.2      2.59    1573x         56         25
```

## Causal Consistency: vector clocks plus a monotone cursor

CC widens the premise to the transitive closure `(so ∪ wr)+`, so you need happens-before. AWDIT topologically sorts `so ∪ wr` (verifying acyclicity on the way) and computes `HB_t` as a vector clock indexed by session, where `HB_t[s]` is the `so`-latest transaction of session `s` that happens-before `t`. Joins are pointwise maxima, `O(k)` per event.

The main loop then keeps, per source session and per key, a cursor into the list of that session's writers of that key in `so` order, and advances it while the writer is within `HB_t3`. The trick is that happens-before predecessor sets grow monotonically along `so`, so cursors are never rewound: each array is scanned once per transaction of the current session rather than restarted. That gives `O(n)` per session plus `O(k)` per `wr` edge, hence `O(n*k)`. And again minimality: only the last writer per (session, key) needs an edge, since its `so` predecessors are ordered transitively behind it.

## The lower bound, and one genuinely strange corollary

The optimality proof reduces triangle freeness to isolation testing. For any level `I` with `CC ⊑ I ⊑ RC`, there is no combinatorial `O(n^(1.5 - e))` algorithm under the combinatorial BMM hypothesis, and no `O(n^(w/2 - e))` algorithm at all. The construction is a range reduction: the built history satisfies CC when the graph is triangle free, and satisfies RC only if the graph is triangle free, so any tester in that range decides triangles. Each node contributes a read transaction and a write transaction, each in its own session.

Two corollaries are worth internalizing. The `n^1.5` barrier holds for RA with only **two sessions**, and for RC with a **single session**, which is genuinely counterintuitive given that analogous single threaded consistency problems for concurrent programs are linear time. Yet RA with `k = 1` is `O(n)`. The hardness sits in an oddly specific place.

The practical reading: truly linear time weak isolation testing is ruled out, near linear would require fast matrix multiplication with its unusable constants, so `n^1.5` for RC and RA is where this stops.

## What to change in your harness

The constraints fall out of the model, not the implementation. Write globally unique values, always, since that is what makes `wr` recoverable and every polynomial time result depends on it. Log session identity and per transaction program order, because `so` and `po` are inputs, not inferences. Do not check serializability when your contract is RA, you will pay NP completeness for a guarantee you never promised. And prefer cycle witnesses containing the fewest `so ∪ wr` edges, since those indicate anomalies at the weakest levels and therefore the more serious bugs.

The lesson generalizes past databases. The proof obligation was "there exists a total order", the standard move is to build the order, and the fast algorithm builds a deliberately incomplete relation instead, adding only the edges that reachability does not already give you for free. Minimality was worth two orders of magnitude.
