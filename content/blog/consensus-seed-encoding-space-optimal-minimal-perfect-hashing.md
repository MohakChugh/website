---
title: "The Smallest Seed That Works Is the Wrong Seed to Store"
date: 2026-08-22
tags: ["perfect-hashing", "data-structures", "compression", "algorithms", "randomization"]
excerpt: "Every randomised data structure that retries until it succeeds stores the index of the first attempt that worked. A 2025 result shows that convention is provably wasteful. I computed the exact waste — log2(e) = 1.4427 bits per seed, 44% more than the paper's own bound — and derived why that single constant is what kept minimal perfect hash functions stuck above 1.5 bits per key."
---

Huge classes of data structures are built by guessing. You pick a hash seed, check whether it does something you need — splits a bucket evenly, places every key without collision — and if it fails you try seed 1, then 2, then 3. When you find one that works you write down which one it was. Then you do that `n` times, once per bucket, and the resulting list of seeds *is* your data structure. In minimal perfect hash functions (MPHFs) the seeds are essentially the entire payload.

Everyone stores the *smallest* successful seed. Lehmann, Sanders, Walzer and Ziegler ([arXiv:2502.05613](https://arxiv.org/abs/2502.05613), revised July 2025) show this is not space-optimal, and that the gap is Ω(n) bits. Their fix, CONSENSUS, dropped the state of the art in MPHF construction throughput by more than two orders of magnitude at equal space. Below I work out exactly how many bits the old convention burns, and why that one number is the whole story.

## Two bad strategies

Formally: for each `i ∈ [n]` you have an infinite stream of i.i.d. Bernoulli(`p_i`) outcomes telling you which seeds work. Produce a bitstring `M` from which seed `S_i` can be decoded in constant time. The optima are

```
|M|_OPT = Σ log2(1/p_i)        T_i_OPT = 1/p_i  (seeds inspected)
```

`log₂(1/p)` bits is the information content of "a specific one of the roughly `1/p` candidates works." Strategy **MIN** — store the first success — hits `T_OPT` exactly, and the paper proves it costs at least `|M|_OPT + Σ(1 − p_i)` bits. Strategy **UNI** — find one seed that works for *all* `n` processes simultaneously — is space-optimal to within O(1) bits and takes `∏ 1/p_i` time, i.e. never finishes.

The paper's bound on MIN is loose. The seed under MIN is `Geom(p)`, so the real cost is its entropy:

```python
def H_geom(p):                       # bits, support {0,1,2,...}
    q = 1 - p
    return (-p*log2(p) - q*log2(q)) / p

for p in [0.5, 0.25, 0.1, 0.01, 1e-4, 1e-6]:
    print(p, H_geom(p) - log2(1/p))
```

```
p         gap (bits)     paper's bound (1-p)
0.5         1.0000            0.5000
0.25        1.2451            0.7500
0.1         1.3680            0.9000
0.01        1.4355            0.9900
1e-4        1.4426            0.9999
1e-6        1.4427            1.0000
```

The gap converges to **log₂(e) = 1.442695 bits per seed** — 44% above the `1 − p` the paper states, and it saturates by `p ≈ 10⁻³`. (Their Lemma 3 gives the matching upper bound `H ≤ log₂(1/p) + log₂ e`, so the constant is exactly log₂ e; they just never spend it as a headline number.)

Is that an artifact of needing random access? No — the waste is inherent to the *sequence*, not the code. I sampled 10⁶ geometric seeds and Rice-coded them at the best parameter `b`:

```
p        log2(1/p)   entropy   Rice(b*)   Rice gap
0.5        1.0000     2.0000    1.9998     1.000
0.2734     1.8709     3.0955    3.1197     1.249
0.09934    3.3315     4.7000    4.7630     1.432
0.01       6.6439     8.0793    8.1095     1.466
```

Rice coding — what RecSplit actually uses — lands within 0.03 bits of the entropy. There is no cleverer coder waiting to rescue MIN.

## Why 1.4427 bits per seed is the whole MPHF story

The MPHF space lower bound is `n·log₂(e) ≈ 1.4427` bits per key. Recursive splitting (RecSplit) builds an MPHF as a balanced binary tree of `n − 1` two-way splitting hash functions, each seed chosen so it halves its subset exactly. A random 2-way hash splits `m` keys evenly with probability `p(m) = C(m, m/2)·2^-m ≈ √(2/πm)`.

So what does the tree *cost* in information? Level with `m` keys per node has `n/m` nodes:

```
d=12   Σ log2(1/p) / n = 1.440907
d=16                     1.442553
d=20                     1.442684
d=30                     1.442695
d=40                     1.442695
log2(e)                = 1.442695
```

The sum converges to the MPHF lower bound to six decimals. Binary recursive splitting is information-theoretically *tight* — it asks for exactly the number of bits an MPHF must contain, no more. Which means every bit above 1.4427 in a shipped RecSplit is seed-encoding overhead, and MIN charges ~1 extra bit on each of the `n − 1` seeds: **≈ 2.443 bits per key** for the naive construction. That is why real RecSplit doesn't do this. It uses `ℓ`-way leaf splits with `ℓ = 8…16` and bucketing — fewer seeds each doing more work, sliding toward UNI — and pays for it in construction time that explodes as `ℓ` grows: `ℓ=8` costs 961 ns/key at 1.710 bits, `ℓ=12` costs 25,667 ns/key at 1.613. The exponential `exp(Ω(1/ε))` wall.

## CONSENSUS: spend a fixed budget, then backtrack

CONSENSUS refuses to store a variable-length quantity. Give seed `i` a **fixed-width slot** of `log₂(k_i)` bits where `k_i = 2^ε/p_i`, so the slot is `log₂(1/p_i) + ε` bits — optimal plus ε, by construction, with the seed at a computable offset. In expectation `2^ε > 1` of the `k_i` candidates work, but "in expectation" isn't "always," and some slots will have zero winners.

The trick: the value in slot `i` is not the seed, it's a *fragment*. The actual seed is the concatenation of all fragments up to and including `i`. So when slot `i` has no winner, you back up and change slot `i−1` — which re-randomises every candidate downstream and gives slot `i` a fresh draw. It's a DFS over a tree whose root has infinite fan-out (so a solution exists with probability 1) and whose layer-`i` nodes have `k_i` children:

```python
def dfs(layer, node):                    # simplified CONSENSUS
    if layer == n + 1: return True
    fanout = k[layer] if layer >= 1 else INF   # root: unbounded retries
    for frag in range(fanout):
        child = node * fanout + frag
        if bernoulli(p[layer], child) and dfs(layer + 1, child):
            return True                  # fragment accepted
    return False                         # exhausted -> caller re-picks its fragment
```

Two engineering details make it real. Fragments concatenate to `Ω(n)`-bit seeds, so the full algorithm keeps only the `w`-bit suffix as the seed passed to the hash function, proving collisions among visited suffixes are unlikely enough that the search still sees fresh randomness. And `k_i` is rounded to a power of two, so concatenation is just bit-packing.

The success probability of a fresh subtree obeys `q_i = 1 − (1 − p_i·q_{i+1})^{k_i}`, backward from `q_{n+1} = 1`, giving `E[T_i] = 1/(p_i·q_{i+1})`. I ran the DFS against that recursion, `k = 64`, chain of 60 seeds, 1500 trials, averaging layers 20–40:

```
eps(bits)     p    T_opt=1/p   predicted   measured   ratio
   2.0     0.06250     16.00       16.28      16.32    1.002
   1.0     0.03125     32.00       39.82      39.73    0.998
   0.5     0.02210     45.25       85.63      86.30    1.008
   0.25    0.01858     53.82      175.91     176.68    1.004
   0.1     0.01675     59.71      401.13     399.39    0.996
   0.05    0.01618     61.82      611.64     614.53    1.005
```

Monte Carlo matches the analytic recursion to within 0.8% everywhere. The probe multiplier over `T_OPT` runs 1.02 → 9.90 as ε goes 2 → 0.05 bits: empirically about `0.5/ε` in this range, i.e. the O(1/ε) constant is *below one*. Buying the last twentieth of a bit costs 10× the probes, not 400×.

## Does the linear scaling hold in the implementation?

Their table (100M string keys, single-threaded i7-11700) times CONSENSUS-RecSplit at five ε. If construction is genuinely `O(n/ε)`, then `ε × ns/key` should be flat. Auditing it:

```
config                        bits/key  overhead  ovh/eps  ns/key  eps*ns
k=256    eps=0.1                1.578    0.1353     1.35     248    24.8
k=512    eps=0.06               1.530    0.0873     1.46     353    21.2
k=512    eps=0.03               1.494    0.0513     1.71     584    17.5
k=32768  eps=0.006              1.452    0.0093     1.55    2815    16.9
k=32768  eps=0.0005             1.444    0.0013     2.61   30245    15.1
```

`ε × ns/key` moves from 24.8 to 15.1 across a 200× range of ε — flat to within 1.6×, and *decreasing*, so the asymptotic is if anything conservative. Space overhead tracks `≈1.5ε` bits/key throughout. For comparison, bipartite ShockHash-RS reaches 1.489 bits/key at 183,691 ns/key; CONSENSUS reaches 1.494 at 584. That is 315× from the table (the paper's "more than 350×" reads off its Pareto front at exactly equal space). At 1.444 bits/key — 0.0013 bits above the information-theoretic floor — nothing else in the literature is in the room.

## When you should care

Queries are the catch: 150–250 ns versus ~100 ns for compact RecSplit, because a query walks `log₂ k` splits and the seeds for one key are scattered across per-level structures. The authors' preliminary fix (one CONSENSUS structure laid out bucket-by-bucket rather than layer-by-layer) buys 30% and is not in the released numbers. Construction is also still single-threaded.

So this is for build-once, query-forever indexes where the table is too big to keep in RAM twice — genomic k-mer sets, URL and term dictionaries, the interior of static function and AMQ-filter constructions. At 10¹⁰ keys, dropping 1.578 → 1.444 bits/key saves 167 MB of resident memory, and unlike the previous route to that space you don't wait three hours per 100M keys to get it.

The transferable lesson is smaller and better than the MPHF result: any time your code loops `while not ok(seed): seed += 1` and persists `seed`, you are paying about 1.44 bits over the information content of "a seed that works." A fixed-width slot plus the willingness to revise an earlier choice buys most of it back.
