---
title: "SOAR, Audited: Orthogonality-Amplified Spilling Is Exact on the Sphere, Wrong About the Queries, and Worth ~4% Without Anisotropic VQ"
date: 2026-11-02
tags: [vector-search, ann, ivf, quantization, information-retrieval]
excerpt: "Google's SOAR gives each vector a second IVF partition, chosen by a loss that penalizes residuals parallel to the first. I checked its theorem by Monte Carlo, and it is exact in every dimension. I then rebuilt SOAR on GloVe-1M with plain k-means. Spilling naively costs 9% more scanning at 95% recall. SOAR at λ=1 reads 14% less than naive spilling and 4% less than no spilling at all. The gain shrinks to below 1× at 100k points. The isotropic-query assumption the loss is derived from is far off: for true neighbors, cos θ averages 0.30, not 0."
---

# SOAR, Audited: Orthogonality-Amplified Spilling for IVF Indexes

Inverted-file (IVF) indexes are the workhorse of billion-scale vector search. You run k-means, store each vector in the bucket of its nearest centroid, and at query time scan only the buckets whose centroids score best. Their failure mode is well known: a true nearest neighbor sits in a bucket whose centroid scores poorly for this query, so you either scan many buckets or miss it.

**SOAR** (Sun, Simcha, Dopson, Guo, Kumar; Google Research, NeurIPS 2023, arXiv 2404.00774) is the indexing change behind ScaNN's recent big-ann-benchmarks results. It stores each vector in a *second* bucket, and picks that bucket with a loss designed to cover the cases where the first bucket fails. I re-derived the math and rebuilt it in numpy on the full 1.18M-vector GloVe-100 set.

## The mechanism: score error lives in the residual

Write x's primary centroid as c and its residual as `r = x − c`. For a query q, the centroid's score understates the true score by exactly the residual's projection:

```
<q, x> − <q, c> = <q, r> = ‖q‖·‖r‖·cos θ
```

A neighbor is hard to find when `<q, r>` is large and positive: its centroid ranks low even though x itself ranks high. K-means already minimizes ‖r‖, so the lever left is cos θ, the angle between the query and the residual.

Naive spilling stores x in its *second-nearest* centroid. That fails geometrically. If c₁, c₂ and x are nearly collinear, then r₂ ≈ (1+ε)·r₁, so the second copy fails on exactly the same queries as the first. SOAR's fix is to weight the second assignment's squared score error by `|cos θ|^λ`, so the loss counts mainly the queries where the *first* assignment does badly:

```
L(r′) = E_q[ |cos θ|^λ · <q, r′>² ]   ∝   ‖r′‖² + λ·‖proj_r(r′)‖²     (Theorem 3.1)
```

The right-hand side is plain squared distance plus a penalty on the part of the new residual that is parallel to the old one. Assignment costs one extra GEMM:

```python
def soar_assign(X, C, primary, lam=1.0):
    R = X - C[primary]
    Rh = R / np.linalg.norm(R, axis=1, keepdims=True)
    d2 = (C * C).sum(1) - 2 * X @ C.T                    # ||x-c||^2 up to a per-row constant
    par = (Rh * X).sum(1, keepdims=True) - Rh @ C.T      # <r_hat, x - c>
    L = d2 + lam * par**2
    L[np.arange(len(X)), primary] = np.inf               # must pick a different bucket
    return L.argmin(1)
```

λ=0 gives naive second-nearest spilling. Larger λ pushes the new residual toward orthogonality with the old one.

## Check 1: the theorem is exact, in every dimension

The proof in Appendix A.1 uses an integration-by-parts recurrence, `(d+λ)·I_d = (d−1)·I_{d−2}`. I re-derived it a second way: with s = cos²θ ~ Beta(1/2, (d−1)/2), the ratio of the parallel to the orthogonal weight is `(λ+1)(d−1)/(d−1)`, and the d cancels. I then checked it by Monte Carlo with 2M uniform unit queries, comparing the loss for a unit r′ parallel to r against a unit r′ orthogonal to it. The theorem predicts a ratio of 1+λ:

| d | λ=0.5 | λ=1 | λ=2 |
|---|---|---|---|
| 3 | 1.497 | 1.997 | 2.995 |
| 25 | 1.497 | 1.994 | 2.990 |
| 100 | 1.500 | 2.000 | 3.000 |

The result is exact and dimension-free.

## Check 2: the premise is not

The theorem assumes q is uniform on the hypersphere. The queries that matter, though, are the ones for which x *is* a neighbor. On GloVe-1M (2,000 test queries × 100 true neighbors, k-means with 2,000 buckets), I measured cos θ between each query and its neighbors' residuals:

| pairs | mean cos θ | std |
|---|---|---|
| (query, true neighbor) | **0.302** | 0.077 |
| (random query, same residual) | 0.018 | 0.107 |
| isotropic theory, d=100 | 0 | 0.100 |

For true neighbors, the angle is shifted almost four standard deviations off zero. That follows from geometry: q ≈ x̂ and r = x − c, so `<x̂, r> = 1 − <x̂, c> > 0`. Almost every centroid *underestimates* its own members' neighbor scores. The loss is therefore derived over the wrong distribution. It still works because its *shape* is right: the penalty on the parallel component carries over to the shifted distribution, but the "optimal" λ does not. That is consistent with the authors using λ=1 on GloVe and λ=1.5 at billion scale. λ is a tuned knob, not a derived constant.

## Check 3: rebuilding it on GloVe-1M

My setup: 1,183,514 unit-normalized GloVe-100 vectors, 15 Lloyd iterations to 2,000 centroids (the paper's partition count), and recall@100 against brute-force MIPS ground truth. I report datapoints scanned at a recall target, counting spilled copies, which is the paper's KMR metric. One difference matters: the paper trains VQ with ScaNN's **anisotropic loss**, and I used plain k-means.

Datapoints scanned to reach each recall@100 target (lower is better):

| target | no spill | naive (λ=0) | SOAR λ=0.5 | SOAR λ=1 | SOAR λ=1.5 |
|---|---|---|---|---|---|
| 80% | 25,670 | 25,882 | **24,390** | 24,907 | 25,726 |
| 85% | 42,363 | 43,102 | **40,370** | 40,595 | 41,611 |
| 90% | 76,814 | 80,426 | 73,994 | **73,360** | 74,362 |
| 95% | 163,299 | 178,269 | 160,568 | **156,574** | 156,974 |

Three findings:

- **Naive spilling is a net loss.** At 95% recall it scans 9% *more* than not spilling. The paper's own Table 2 shows the same on GloVe (135,612 vs 127,819). Doubling the bucket sizes costs more than the correlated second copy recovers.
- **SOAR's gain over no spilling is small here: 1.03–1.05×.** The paper reports 1.09–1.14× on GloVe. Part of the gap is the anisotropic VQ: their no-spill baseline needs 19,983 points at 80%, against my 25,670.
- **The best λ rises with the recall target**: 0.5 at 80–85%, and 1–1.5 at 95%. High-recall operation is dominated by the doubly hard tail, where decorrelation matters most.

The λ sweep shows the trade-off the paper describes in Figure 9. Here is the correlation of cos θ and cos θ′ over true-neighbor pairs, against the second assignment's distortion:

| λ | 0 | 0.5 | 1 | 1.5 | 2 | 4 |
|---|---|---|---|---|---|---|
| corr(cos θ, cos θ′) | 0.380 | 0.261 | 0.179 | 0.117 | 0.070 | −0.035 |
| E‖r′‖² / E‖r‖² | 1.13 | 1.14 | 1.16 | 1.19 | 1.22 | 1.33 |

Driving the correlation to zero (λ≈4) costs 33% more distortion and is worse than not spilling at 80% recall (0.86×).

## Check 4: it scales with N, which is the real claim

Keeping the paper's ratio of 400 points per bucket, here is SOAR's gain over no spilling:

| N | λ=1 @ 90% | λ=1 @ 95% | best λ @ 95% |
|---|---|---|---|
| 100k | 0.98× | 0.95× | 0.96× (λ=1.5) |
| 300k | 1.04× | 1.00× | 1.01× (λ=1.5) |
| 1.18M | 1.05× | 1.04× | 1.04× (λ=1) |

Below roughly 300k points, SOAR does not pay for its doubled buckets. The trend matches the paper's Figure 10 and its billion-scale numbers (2.06–4.32× over no spilling at 90–95%). The claim that matters is the slope with N, not the GloVe point.

Re-anchoring the paper's own Table 2 onto the fairer baseline, *naive spilling*, isolates what the loss itself buys. At 95% recall that is 1.21× on GloVe, 2.29× on SPACEV-1B, and 2.43× on Turing-1B. In my run it is 1.14× (178,269 → 156,574).

## Check 5: the memory arithmetic

Only the PQ code and a 4-byte row id are duplicated, not the full-precision vector. With d-dimensional float32 vectors and s dimensions per 4-bit PQ subspace, the overhead is `(4 + d/2s) / (4d + 4 + d/2s)`. For GloVe (d=100, s=2) that is 29/429 = **6.8%**. The paper quotes the approximation 1/(8s+1) = 5.9% against a measured 7.7%. The exact formula is closer.

There is a small internal inconsistency. Appendix A.3 says "16 subspaces and s = 2 dimensions per subspace", but 16×2 = 32 ≠ 100. The measured Table 1 delta (488.4 − 453.5 MB over 1,183,514 points ≈ 29.5 B/point) matches 4 + 100/4 = 29 bytes, which means **50** subspaces. With 16 subspaces, the duplicate would be 12 B/point, about 3%.

## What to take away

- SOAR's loss is a principled-looking **heuristic**. The theorem is exact, but neighbor queries are not isotropic (mean cos θ = 0.30), so λ has to be tuned per dataset and per recall target.
- **Never spill naively.** Second-nearest assignment made my index worse at every recall target.
- **Expect small gains on small indexes.** At ≤1M vectors with plain k-means, expect about 4%. The case for SOAR is billion-scale, high-recall serving, where the paper's 2–4× is plausible and the memory cost is 15–20%.
