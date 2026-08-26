---
title: "Polonius Alpha: Location-Sensitive Borrow Checking and the Loan-Reachability Graph"
date: 2026-08-26
tags: [rust, compilers, static-analysis, type-systems, program-analysis]
excerpt: "Rust's borrow checker rejects a whole class of programs that are obviously sound, and it has done so since 2018 by design. The reason is not the ownership rules; it is that NLL's constraint graph forgets where each constraint came from. Polonius alpha puts that coordinate back by making loan liveness a reachability question over a combined subset-plus-CFG graph — and it is now on nightly with a stabilization goal for 2026."
---

Every Rust programmer has hit this: code that is plainly sound, rejected with `cannot borrow *map as mutable more than once at a time`. You rewrite it with an extra `contains_key` lookup, or an index instead of a reference, or you reach for `RefCell` and trade a static guarantee for a runtime panic. The frustrating part is that the borrow checker is not wrong about the rule. Rust enforces *mutation xor sharing*, and your program obeys it. The checker is simply too imprecise to see that.

This gap has a name and a history. NLL RFC 2094 enumerated three problem cases; case #3, "conditional control flow across functions," was cut from the deliverable in 2018 and has been open ever since. The fix — Polonius — went through a Datalog prototype that was precise but did not scale, and has now been reborn as a deliberately scoped subset called **polonius alpha**, which landed on nightly in August 2025 (rust-lang/rust#143093) and is a 2026 Rust project goal to stabilize. What follows is the algorithmic core: why NLL loses information, and what "location-sensitive" buys you.

## What NLL actually computes

NLL runs in two phases. First, a MIR type check walks the control-flow graph and emits *outlives constraints* between region variables. Second, region inference solves them, and a dataflow pass computes which *loans* (roughly: which `&` expression's borrow) are in scope at each program point; an access that conflicts with an in-scope loan is an error.

It is clarifying to reframe phase one the way Polonius does. Instead of treating a region as a set of program points, treat an **origin** as a set of **loans**: the set of borrows a reference might have come from. A subtyping obligation `&'1 u32 <: &'0 u32` becomes the subset edge `'1 ⊆ '0` — loans flow from `'1` into `'0`. (This is the dual of the points-set view; the two carry the same information.) Liveness is then `LiveOrigins(P) = { O | O appears in the type of a variable live at P }`.

Here is the whole problem in one line: **that subset graph is built once for the entire function.** An edge `'1 ⊆ '0` records *that* the flow can happen, never *where*. Consider Niko Matsakis's example:

```rust
let mut x = 22;
let mut y = 44;
let mut p: &'0 u32 = &x;   // loan L0, borrowing x
let mut q: &'1 u32 = &y;   // loan L1, borrowing y
if something() {
    p = q;                 // emits '1 ⊆ '0
    x += 1;                // (B) ok: only q is live, so L0 is dead here
} else {
    y += 1;                // (C) rejected today — but sound
}
read_value(p);
```

In the `else` arm, `p` can only ever hold `L0`; `p = q` is on the other branch. But the single global graph says `'0 ⊇ {L0, L1}`, and `'0` is live in the `else` arm because `p` is used afterward, so `L1` is considered in scope and `y += 1` is an error. NLL claws some flow sensitivity back through the loans-in-scope dataflow — `kill` on reassignment of the borrowed place, and the fact that at (B) only `'1` is live so `L0` drops out — but the alias graph itself remains location-insensitive, and (C) is a false positive.

Problem case #3 is the same defect in its most painful form:

```rust
fn get_or_insert<'r, K: Hash + Eq + Copy, V: Default>(
    map: &'r mut HashMap<K, V>,
    key: K,
) -> &'r mut V {
    match map.get_mut(&key) {
        Some(value) => value,
        None => {
            map.insert(key, V::default()); // ERROR: *map still borrowed
            map.get_mut(&key).unwrap()
        }
    }
}
```

`map.get_mut(&key)` issues a loan of `*map` whose origin flows into `'r`. But `'r` is a *universal* region — it is live at every point in the body, because the caller may use the result after the function returns. Flow-insensitively, the loan is therefore in scope everywhere, including the `None` arm where the `Some` value provably does not exist. The same mechanism makes lending iterators (rust-lang/rust#92985) not merely awkward but inexpressible:

```rust
fn next(&mut self) -> Option<Self::Item<'_>> {
    loop {
        let item = self.inner.next()?;      // loan of *self flows into the return origin
        if (self.pred)(&item) { return Some(item); }
        // item is dead here — but the loan is "in scope", so the next
        // iteration's reborrow of *self conflicts with it
    }
}
```

## Localizing the constraint graph

Polonius alpha's change is to stop having one graph per function and instead have one node per *(origin, program point)* pair. Two kinds of edge:

- **Typeck edges.** A constraint `'1 ⊆ '0` arising at point `P` becomes `('1, P) → ('0, P)`. It exists only at the point that produced it.
- **Flow edges.** For every CFG edge `P → Q` and origin `'o`, an edge `('o, P) → ('o, Q)`, carrying an origin's contents forward along control flow.

Loan liveness becomes graph reachability. Starting from the node where a loan is issued, walk the graph; whenever the traversal reaches a node `('x, Q)` where `'x` is live at `Q`, the loan is live at `Q`:

```python
def live_loans(graph, live_origins):
    live = defaultdict(set)                       # point -> set of loans
    for loan, (origin, point) in issued_loans:
        for (o, q) in reachable_from(graph, (origin, point)):
            if o in live_origins[q]:              # reached a live origin
                live[q].add(loan)
    return live
# Everything downstream — invalidation, error reporting — is NLL's, unchanged.
```

Now walk problem case #3 again. The loan of `*map` enters `'r` only via the typeck edge emitted inside the `Some` arm. From the loan's issuing node, the `None` arm is reachable only through nodes for origins that are dead there — the traversal never lands on a live origin at the `map.insert` point. The loan is not live, the conflict evaporates, and the function compiles. The `else`-branch false positive above disappears for exactly the same reason.

## What the alpha deliberately does not do

Alpha is a subset of the old Datalog Polonius, chosen because it is stabilizable rather than because it is maximal:

- **Reachability approximates liveness.** Full flow-sensitivity is not implemented, so patterns like linked-list traversal with conditional reborrowing still fail, exactly as under NLL.
- **Kill handling during traversal was removed** (it was incomplete) and is planned to be reintroduced incrementally.
- **The loans-in-scope computation is NLL's**, untouched.

The critical property is that alpha is a **strict superset** of NLL: everything that compiles today still compiles, so this is purely additive and the diagnostics surface barely moves. Cost is the real question — one node per (origin, point) is a much bigger graph — and the team has been explicit about its budget: a 10–20% borrow-check overhead is acceptable. A lazy constraint-graph rewrite (#150551) already cut the overhead substantially, and the contingency list is instructive if you have ever tuned a dataflow analysis: limit propagation to affected blocks, unify invariant lifetimes, restrict invalidations to two-phase-borrow activations. One soundness hole remains, involving dead regions outlived by opaque types, blocked on the trait-solver rework. Separately, the analysis is being modeled in a-mir-formality to serve as an oracle against the rustc implementation and, eventually, as a borrow-checking spec in the Rust reference.

You can try it today on nightly with `-Zpolonius=next` (the historical Datalog engine is still reachable as `-Zpolonius=legacy`).

## The transferable lesson

The interesting thing here has little to do with Rust. NLL is a sound analysis whose precision ceiling was set years earlier by one modeling decision: the abstract domain recorded *which* origins could flow into which, and discarded *where*. Every false positive users have papered over with `RefCell` for eight years is a consequence of that projection. Recovering the coordinate did not require a smarter solver or a new logic — it required indexing the domain by program point and turning the query into reachability, then accepting a bounded constant-factor cost. When your own static analysis is rejecting things it should not, the productive question is usually not "how do I make the solver stronger" but "what did I project away, and what would it cost to put it back?"
