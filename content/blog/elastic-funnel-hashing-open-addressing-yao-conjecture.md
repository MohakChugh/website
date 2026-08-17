---
title: "Breaking Yao's Conjecture: Elastic and Funnel Hashing at 99.98% Load"
date: 2026-08-17
tags: ["algorithms", "data-structures", "hash-tables", "performance"]
excerpt: "Uniform probing was proven optimal for open addressing in 1985, and conjectured optimal in the worst case too. A 2025 paper broke the conjecture with two constructions that never move an element after inserting it. I implemented both against uniform probing and found where the crossover actually is: 99.9% load, not sooner."
---

Insert keys one at a time into an array of size `n`. Each key gets an infinite probe sequence `h₁(x), h₂(x), …`; an insertion must place the key in some unoccupied slot from that sequence, and it may never move a key afterward. If `x` lands in `h_j(x)`, then a lookup costs `j` probes. Stop when the table has `n − δn` keys, so `δ` is the fraction of slots left free.

The textbook answer is uniform probing: give each key a random permutation of the slots and greedily take the first free one. Its amortized expected probe complexity is `Θ(log δ⁻¹)`, and its worst-case expected probe complexity — the cost of the *last* insertion, when the table is at its fullest — is `Θ(δ⁻¹)`.

Ullman conjectured in 1972 that `Θ(log δ⁻¹)` amortized was optimal for any greedy scheme. Yao proved it in 1985 in a paper called, unambiguously, *Uniform Hashing is Optimal*. He left behind a second conjecture: that no greedy scheme can beat `(1−o(1))δ⁻¹` in the worst case either. That one stood for forty years.

[Farach-Colton, Krapivin, and Kuszmaul (arXiv:2501.02305)](https://arxiv.org/abs/2501.02305) settle both open questions, with matching lower bounds. Two constructions do the work.

## Funnel hashing: greedy, and still beats Yao's bound

Funnel hashing is the simpler of the two, and it is fully greedy — each key takes the first free slot it sees — so it lives squarely inside the setting Yao's conjecture was about.

Split the array into `α = ⌈4 log δ⁻¹⌉ + 10` levels whose sizes shrink geometrically by 3/4, plus a small special array holding about `δn/2` slots. Subdivide each level into buckets of exactly `β = ⌈2 log δ⁻¹⌉` slots. To insert, hash to one bucket per level and scan it:

```python
def insert(key):
    for level in levels:                     # α = O(log 1/δ) levels
        bucket = levels[level].bucket_for(key)
        for slot in bucket:                   # β = O(log 1/δ) slots
            if slot.empty:
                slot.put(key); return
    special_array.insert(key)                 # kept at load ≤ 1/4
```

Worst case: `α` levels × `β` slots = `O(log² δ⁻¹)` probes, which is `o(δ⁻¹)`. Yao's conjectured bound is false.

The analysis hinges on a counting argument that is easy to state. A level of size `|A_i|` receives at least `2|A_i|` insertion attempts before the levels above it fill, so each of its `|A_i|/β` buckets expects `2β` attempts. By Chernoff, a bucket sees fewer than `β` attempts — the only way it can end up with a free slot — with probability exponentially small in `β`, which is to say polynomially small in `δ`. So each level ends up all but `δ|A_i|/64`-full, the overflow into the next level is small, and the special array almost never gets touched. Notice what the level does *not* guarantee: nothing about any individual insertion succeeding. Only the aggregate matters.

Engineers will recognize the inner loop. A bucket of `β` contiguous slots scanned for an empty entry is exactly the group probe that SwissTable-style hash maps already do with SIMD over a cache line. Funnel hashing is a handful of those group probes down a funnel of shrinking levels.

## Elastic hashing: probe far ahead, then snap back

To beat `log δ⁻¹` *amortized*, you have to leave the greedy world — Yao's theorem is airtight there. Elastic hashing splits the array into levels `A₁, A₂, …` with `|A_{i+1}| = |A_i|/2`, and uses a two-dimensional probe sequence `h_{i,j}(x)`: probe `j` into level `i`. Insertions happen in batches; batch `B_i` fills `A_i` to `1 − δ/2` while bringing `A_{i+1}` to 75%. Inside a batch, with `A_i` at free fraction `ε₁` and `A_{i+1}` at `ε₂`:

```python
f = lambda eps: c * min(log2(1/eps)**2, log2(1/delta))

if eps1 > delta/2 and eps2 > 0.25:
    # try a bounded budget in A_i, else fall through to A_{i+1}
    j = first_free(A[i], probes=f(eps1))
    place(i, j) if j else place(i+1, first_free(A[i+1], probes=INF))
elif eps1 <= delta/2:  place(i+1, first_free(A[i+1], probes=INF))
else:                  place(i,   first_free(A[i],   probes=INF))
```

The non-greedy move is the bounded budget `f(ε₁)`. A key may skip over free slots deep in `A_{i+1}`'s probe sequence while it burns up to `f(ε₁)` probes looking for a cheaper home in `A_i`. That is what dodges the coupon-collector lower bound: uniform probing needs `Ω(n log δ⁻¹)` probes to collect `1−δ` of the coupons, but elastic hashing decouples *insertion* probe count from *search* probe count. Insertions stay expensive; searches get cheap. The result is `O(1)` amortized and `O(log δ⁻¹)` worst-case expected probes, both optimal.

One wrinkle deserves attention because it dominates the constants. The 2-D sequence has to be flattened into the 1-D sequence the model demands, via an injection `φ(i,j) = O(i·j²)` built by interleaving `j`'s bits with 1s, a 0 separator, then `i`'s bits. It is injective, and that is all it needs to be: `φ(1,1) = 13`, `φ(1,2) = 57`, `φ(1,16) = 3753`. An `O(1)` whose leading constant is in the hundreds is still `O(1)`, but a real implementation would search level-by-level and skip the indices `φ` never produces.

## Measuring it

I implemented all three schemes and measured probe counts directly. For elastic hashing I report the *rank* of `φ(i,j)` among all reachable `φ` values, i.e. the number of real slots an implementation that skips unreachable indices would touch. The special array in funnel hashing is uniform probing rather than the paper's two-level construction; at load ≤ 1/4 it never mattered — the spill rate was 0.00% at every `δ` I tried.

First, a calibration check. Uniform probing's classical amortized cost is `(1−δ)⁻¹ ln δ⁻¹`: 6.94 at `δ = 2⁻¹⁰` and 8.32 at `2⁻¹²`. Measured: 6.98 and 8.37. Its tail cost should approach `δ⁻¹`; measured 254 at `δ = 2⁻⁸` against a predicted 256.

At `n = 2²⁰`, mean probes over the last 300 insertions (the table at its fullest), and mean over all insertions:

| δ | 1/δ | uniform tail | funnel tail | elastic tail | uniform avg | funnel avg | elastic avg |
|---|---|---|---|---|---|---|---|
| 2⁻⁸ | 256 | 254 | 346 | 297 | 5.6 | 55.8 | 39.1 |
| 2⁻¹⁰ | 1024 | 988 | 549 | 170 | 7.0 | 70.4 | 43.5 |
| 2⁻¹² | 4096 | 2760 | 1123 | 137 | 8.4 | 84.9 | 46.3 |

Three things fall out of this, and only one of them is in the paper.

**The crossover is at 99.9% load.** Funnel hashing's worst case is roughly `αβ ≈ 8 log² δ⁻¹ + 20 log δ⁻¹`, which crosses `δ⁻¹` at `log δ⁻¹ ≈ 10`. The measurement lands exactly there: uniform probing wins at `δ = 2⁻⁸`, funnel wins by 1.8× at `2⁻¹⁰` and 2.5× at `2⁻¹²`. Below 99.9% load, Yao's "suboptimal" scheme is the faster one. Elastic hashing crosses earlier, and by `δ = 2⁻¹²` it is 20× better in the tail.

**The amortized win is asymptotic, not practical.** Uniform probing's amortized cost is 5.6–8.4 probes; elastic hashing's is 39–46, and 39 of those are a constant, not a function of `δ` (median rank was 8 at every `δ`). `O(1)` beats `O(log δ⁻¹)` eventually, but `log δ⁻¹` would have to exceed ~40 — that is `δ < 2⁻⁴⁰` — for the asymptotics to show up in a table you could build.

**Elastic's tail is not monotone in δ.** It falls from 297 to 137 as the table gets tighter, which no `O(log δ⁻¹)` bound predicts. The histogram of the last 300 placements explains it: at `δ = 2⁻⁸` the insert sequence happens to end mid-batch with level 9 nearly full, so tail keys need up to `j = 31` probes inside it; at `2⁻¹²` it ends with level 12–13 barely started and `j ≤ 5` suffices. Where the sequence stops relative to a batch boundary matters more than `δ` does. The honest statistic over the whole run is the p99 rank, which grows from 407 to 553 while `δ⁻¹` grows 16× — slow growth, consistent with `O(log δ⁻¹)`.

## When this matters

Almost never at 90% load, which is where production hash tables live and where uniform probing or a SwissTable is unambiguously better. It matters when the table is sized to be nearly exactly full: fixed-capacity directories, in-memory indexes provisioned to the byte, embedded tables where the array cannot grow. There the tail insertion is the one that shows up as a latency spike, and `δ⁻¹` versus `log² δ⁻¹` is the difference between 4096 probes and 1123.

The paper also closes off the obvious extension: with deletions over an infinite horizon, the optimal amortized probe complexity is `δ^{−Ω(1)}`, so neither construction survives contact with a workload that removes keys. These are results about tables that fill up once — which, for a 40-year-old conjecture, is a perfectly good place to break it.
