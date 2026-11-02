---
title: "DPconv, Reproduced: Join Ordering Below 3^n via Fast Subset Convolution, and Where the Crossover Really Is"
date: 2026-11-02
tags: [query-optimization, join-ordering, dynamic-programming, algorithms, databases]
excerpt: "Every exact bushy join-ordering DP since Selinger evaluates a subset convolution term by term, which costs O(3^n). DPconv (SIGMOD 2025) gets C_max in O(2^n n^3): binary-search the bottleneck, then answer each feasibility question with a counting convolution in the (+,·) ring. I rebuilt DPsub[max] and DPconv[max] in C. They agree on 200/200 random cliques. On an M3 Pro the crossover is n=19, not 17, and the speedup at n=24 is 7.2×, not 29×. Uniform-random benchmark cardinalities also hide something: under an independence model, the C_out-optimal and C_max-optimal plans were identical in 600 of 600 cliques."
---

# DPconv, Reproduced: Join Ordering Below 3^n

Every exact bushy join-ordering algorithm a production optimizer ships (DPsize, DPsub, DPccp) solves the same recurrence:

```text
DP[S] = c(S) ⊗ min over ∅ ⊂ T ⊂ S of ( DP[T] ⊗ DP[S \ T] )
```

⊗ is `+` for C_out (sum of intermediate sizes) and `max` for C_max (largest intermediate). Over all S, the inner loop touches `Σ_k C(n,k)·2^k = 3^n` pairs. DPccp skips disconnected pairs, which is optimal for sparse graphs, but on a clique it degenerates to DPsub. O(3^n) has stood as the barrier.

Mihail Stoian and Andreas Kipf's [DPconv](https://arxiv.org/abs/2409.08013) (SIGMOD 2025) starts from the observation that this recurrence *is a subset convolution*, the object that Björklund et al.'s fast subset convolution (FSC) evaluates in O(2^n n^2) in the (+,·) ring. Their exact C_max optimizer runs in O(2^n n^3), a super-polynomial improvement, since 3^n / (2^n n^3) = 1.5^n / n^3. They report it beats DPsub from 17 relations and runs 29× faster at 24.

I reimplemented both sides in C to check that claim.

## Why min-plus is the hard part

FSC is FFT-shaped. It maps each set function through the *zeta transform* (ζf)(X) = Σ_{T⊆X} f(T), multiplies pointwise, and maps back with the Möbius transform, which is an inclusion-exclusion with subtractions. To stop T and S\T from overlapping, it "ranks" the functions by |T| and convolves the rank slices. The cost is n zetas, n² pointwise products and n Möbius passes over 2^n entries.

The inverse step requires subtraction, and `min` has no inverse: knowing min{2,3,5} = 2 tells you nothing about min{3,5}. The standard workaround embeds a value v as the monomial x^v, so `+` becomes polynomial multiplication and `min` becomes "lowest nonzero exponent". For C_out the exponents reach W^n, where W is the largest cardinality. The paper itself calls the resulting O(2^n n^2 · W^n log W^n) bound impractical. For C_out, the only sub-3^n result is a (1+ε)-approximation in Õ(2^{3n/2}/√ε). That is a theorem with no implementation.

## The C_max trick: binary search, then count

C_max never creates new values. The optimum is one of the 2^n cardinalities c(S). So DPconv[max] binary-searches over γ and asks one yes/no question per γ: is there a bushy plan in which every intermediate is at most γ?

Write that question as a 0/1 DP. F(S) = 1 for singletons. For larger S, F(S) = [c(S) ≤ γ] · [h(S) > 0], where h(S) = Σ_T F(T)·F(S\T) *counts* the feasible splits. Counting happens in the (+,·) ring, so FSC applies directly. You compute it layer by layer, because layer k only needs ranked zetas of layers below k. One check costs O(2^n n^2) and the binary search adds a factor of log(2^n) = n. The core of my implementation:

```c
// One feasibility check for threshold g. z[d] = zeta of the rank-d slice of F.
for (int k = 2; k <= n; k++) {
  memset(acc, 0, N * 4);
  for (int d = 1; 2 * d <= k; d++) {              // ranked convolution, symmetric
    u32 *A = z[d], *B = z[k - d], f = (2 * d == k) ? 1 : 2;
    for (u64 X = 0; X < N; X++) acc[X] += f * A[X] * B[X];
  }
  zeta(acc, n, -1);                                // Moebius: acc[S] = #feasible splits
  if (k == n) return acc[N - 1] && c[N - 1] <= g;
  memset(z[k], 0, N * 4);
  for (u64 S = (1ull << k) - 1; S < N; ) {         // Gosper's hack: only |S| == k
    z[k][S] = acc[S] && c[S] <= g;
    u64 t = S & -S, r = S + t; S = (((r ^ S) >> 2) / t) | r;
  }
  zeta(z[k], n, +1);
}
```

One detail the paper doesn't spell out: you can use **uint32 wraparound** for everything. Zeta products overflow, and Möbius subtracts. But the true value h(S) counts ordered splits of S, so it is below 2^|S| ≤ 2^31. Arithmetic mod 2^32 then recovers it exactly, with no bignums and no modular primes, and NEON processes four lanes per instruction. I also restrict the binary search to candidates ≥ c(V), since the root is in every plan.

## Reproduction

Both optimizers ran single-threaded on an M3 Pro (clang 21, `-O3`), on cliques with c(S) uniform in [1, 10^8], matching the paper's synthetic setup. DPconv returned the same optimum as DPsub on **200/200** instances for n = 3..12 and on every timed instance.

| n | DPsub[max] | DPconv[max] | speedup | binary-search iters |
|---|---|---|---|---|
| 16 | 0.036 s | 0.101 s | 0.35× | 16 |
| 18 | 0.35 s | 0.71 s | 0.50× | 16 |
| 19 | 1.53 s | 1.55 s | 0.99× | 14 |
| 20 | 4.67 s | 3.92 s | 1.19× | 18 |
| 21 | 14.2 s | 8.76 s | 1.62× | 17 |
| 22 | 56.3 s | 24.7 s | 2.28× | 22 |
| 23 | 208 s | 53.5 s | 3.90× | 23 |
| 24 | 776 s | 108 s | **7.19×** | 22 |

The algorithm is correct and wins inside the range where exact optimization still matters, but the magnitude depends on the hardware. On this machine the break-even is **n = 19** (paper: 17), and at n = 24 the speedup is **7.2×** (paper: 29×).

Per-operation costs explain the gap. DPsub does exactly (3^n − 2^{n+1} + 1)/2 split evaluations (21,457,825 at n = 16, and my counter matches to the unit). Each one is two dependent random loads into a 2^n-entry table. As that table outgrows the caches, a split goes from 1.7 ns (n = 16) to 2.7 ns (n = 21) to 5.5 ns (n = 24). DPconv's streaming butterflies cost a flat **0.42–0.49 ns per element-op** at every n, but it does about n·(1.5n + n²/4)·2^n of them. The 1.5^n/n^3 asymptotic win has to repay that constant ratio. Getting 29× at n = 24 with my DPconv would require DPsub at about 22 ns per split. So either the paper's machine has a slower memory system or a slower DPsub, or its FSC is about 4× faster than mine. Without their binaries I can't separate those. The speedup grows 1.4–1.8× per extra relation, so the qualitative claim holds everywhere. The break-even point is specific to the hardware.

## What it costs, and where it doesn't help

- **Memory.** DPsub needs one 2^n table. DPconv keeps n ranked-zeta slices plus an accumulator, about (n+1)·2^n·4 bytes, or ~1.7 GB at n = 24 versus 128 MB for DPsub. Measured peak RSS at n = 22 was 414 MB.
- **Sparsity buys nothing.** DPconv handles disconnected subgraphs by setting c(S) = ∞, so its cost is identical for a chain and a clique. DPccp on a chain enumerates O(n^3) connected-complement pairs. Real workloads like JOB are sparse, and the paper's own Figure 5 shows DPccp sufficing there. DPconv belongs in the large, dense tail: cyclic analytic joins, generated queries, or cross-product-enabled search, where DPccp falls back toward 3^n anyway.
- **Plan quality is a different question from speed.** C_max is a good proxy for spill risk and memory pressure. It is not the usual objective. The paper's answer is C_cap: run DPconv[max] first, then a C_out DP pruned to subsets with c(S) ≤ C_max*. On CEB, 2,873 of 13,644 queries had a C_out-optimal plan whose peak intermediate exceeded the C_max optimum by 6.8%. Pure C_max loses 22.8% in C_out there, and C_cap brings that to 9.5%. With the first pass accelerated, C_cap beats vanilla DPsub[out] past n = 21.

That last point surfaced an issue with the synthetic benchmark. I computed both optima on 10-relation cliques in Python. With the paper's i.i.d. uniform cardinalities, the C_out-optimal plan had a larger peak intermediate in **63/100** instances (median 1.19×, max 2.11×). With cardinalities from a textbook independence model instead (base sizes 10^2–10^7, pairwise selectivities 10^-6–1), the two optima coincided in **300/300** instances. So did a narrower spread (another 300/300). When cardinalities span orders of magnitude, sums are dominated by their largest term, so minimizing C_out mostly minimizes C_max too. Uniform-random c(S) is fine for *timing*, since the work doesn't depend on the values, but it overstates how often C_max and C_out disagree. CEB's 21% divergence rate is the number to trust, and it comes from correlations an independence model can't express.

## Takeaways

1. Join enumeration is a subset convolution, and naming it that way imports two decades of exponential-algorithms machinery. The C_max instantiation is about 150 lines of C and genuinely practical.
2. "Practical" depends on the machine. The constant-factor gap between random lookups and streaming butterflies decides the crossover, so measure on your own hardware.
3. C_out remains the open problem. The exact algorithm is pseudo-polynomial in W^n, and the (1+ε) one exists only as a bound. Until one of them is practical, DPconv speeds up the first pass of C_cap, not the cost function most optimizers actually minimize.
