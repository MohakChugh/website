---
title: "Quake's Recall Estimator Works Because Its Geometry Is Off: Caps in d/2, a 1/e Ceiling, and a Split Example That Needs α < 0.51"
date: 2026-10-16
tags: ["vector-search", "ann", "ivf", "databases", "probability"]
excerpt: "Quake (OSDI '25) chooses nprobe per query by estimating recall from hyperspherical cap volumes, with no offline tuning. On SIFT1M I reproduce its Table 5 to within a point of recall. The released code computes cap volumes with sqrt(1−t²) where the textbook formula has 1−t², which is exactly the volume in 64 dimensions instead of 128. That error is what makes the estimator calibrated: the textbook formula delivers 78% recall at a 90% target. The same audit finds a 1/e ceiling on the first-partition estimate and a split example that only commits when α < 0.509. Measured α is 0.67–0.83."
---

# Quake's Recall Estimator Works Because Its Geometry Is Off: Caps in d/2, a 1/e Ceiling, and a Split Example That Needs α < 0.51

Partitioned (IVF) vector indexes have one query-time knob that matters: **nprobe**, the number of partitions scanned per query. The usual practice is to binary-search one global nprobe offline against ground truth, and that breaks as soon as the data or the partitioning changes.

**Quake** (Mohoney et al., *Quake: Adaptive Indexing for Vector Search*, OSDI '25, arXiv 2506.03437) adds a cost model that splits hot partitions and merges cold ones. It also adds **Adaptive Partition Scanning (APS)**, which estimates each query's recall *while it runs* and stops at the target, with "no offline tuning." The paper reports 1.5–38× lower query latency than HNSW, DiskANN, SVS and ScaNN on dynamic workloads.

I rebuilt APS from the paper and the released code (`marius-team/quake`, commit `0651c88`), ran it against SIFT1M ground truth, and measured the cost model's key assumption.

## The estimator

Once a few partitions have been scanned, let ρ be the distance to the current k-th best result. The true k nearest neighbours lie inside the ball B(q, ρ). APS assumes uniform density, so the probability that partition Pᵢ holds a neighbour is the fraction of that ball's volume inside Pᵢ. Exact Voronoi intersections are intractable, so each neighbouring cell is replaced by the half-space beyond the bisector of q's nearest centroid c₀ and cᵢ. The intersection becomes a **hyperspherical cap**, with a closed form in the regularized incomplete beta function. At distance δ from q to the bisector, with t = δ/ρ, the textbook formula is:

```text
cap fraction  v(t) = ½ · I_{1−t²}((d+1)/2, ½)          for t < 1, else 0
```

Then the paper normalizes the caps of the M−1 candidate neighbours so they sum to 1:

```text
p₀ = ∏ⱼ (1 − v̂ⱼ)            probability nothing lies outside P₀
pᵢ = (1 − p₀) · v̂ᵢ           estimated recall = p₀ + Σ_{scanned i} pᵢ
```

APS scans in order, recomputes when ρ moves by more than τρ, and stops at τR.

## Reproduction

Setup, matching the paper's Table 5: SIFT1M, a 1000-partition faiss k-means, k = 100, the code's 10% candidate fraction, 2000 test queries.

```text
target  method            paper recall@nprobe   mine
0.80    oracle            83.3% @ 11.5          83.1% @ 10.8
        fixed nprobe      81.7% @ 11            81.0% @ 10
        APS               82.1% @ 11.8          82.3% @ 11.3
0.90    oracle            92.4% @ 19.3          91.6% @ 17.4
        fixed nprobe      90.3% @ 19            90.2% @ 18
        APS               91.2% @ 20.2          91.3% @ 19.3
0.99    oracle            99.2% @ 42.0          99.1% @ 38.7
        fixed nprobe      99.0% @ 65            99.0% @ 61
        APS               98.9% @ 50.1          99.0% @ 49.4
```

"Oracle" is the per-query minimum nprobe; "fixed" is the smallest global nprobe whose *mean* recall reaches the target. APS lands within a point of the paper everywhere. It also wins on the tail: at the 90% target its p10 recall is 0.84, against 0.76 for fixed nprobe at similar mean cost.

## The cap formula in the code is not the textbook one

```c
// src/cpp/include/geometry.h, hyperspherical_cap_volume()
double x = sqrt(1.0 - (boundary_distance / radius) * (boundary_distance / radius));
double a = 0.5 * (d + 1.0), b = 0.5;
double I = use_precomputed ? incomplete_beta_lookup(x, d) : incomplete_beta(a, b, x);
return std::clamp(0.5 * I, 0.0, 0.5);
```

The argument should be 1 − t², not √(1 − t²). A 2M-sample Monte Carlo in a 128-ball:

```text
 t      Monte Carlo   ½·I(1−t²)  [textbook]   ½·I(√(1−t²))  [code]
0.05    0.2851        0.2853                  0.3442
0.10    0.1281        0.1279                  0.2108
0.20    0.0111        0.0110                  0.0527
```

The code overstates leakage by 1.2× at t = 0.05 and 4.8× at 0.2. Since Iₓ(a, ½) behaves like xᵃ, the square root halves the exponent: at every t I checked, the code's value equals the *textbook* cap volume at **d = 64**. The shipped estimator effectively treats SIFT as a 64-dimensional space.

Fixing the formula makes the estimator much worse:

```text
target   APS (code, √)     APS (textbook, normalized)   textbook, unnormalized 1−Σv_unscanned
0.80     82.3% @ 11.3      68.6% @  5.9                 69.3% @  9.5
0.90     91.3% @ 19.3      78.3% @  9.2                 76.9% @ 13.1
0.99     99.0% @ 49.4      93.6% @ 24.3                 90.7% @ 27.5
```

With correct geometry, APS misses every target by 6–12 points. The model's assumptions err in the optimistic direction: SIFT's intrinsic dimension is far below 128, so neighbours sit on a low-dimensional sheet that crosses bisectors far more often than a full-dimensional uniform ball predicts. Inflating the caps cancels that bias.

Sweeping the dimension passed to the textbook formula (600 queries) confirms it:

```text
d_eff   0.80 target     0.90 target     0.99 target
  16    98.1% @ 35.8    99.4% @ 55.0    99.8% @ 86.4
  32    94.1% @ 22.1    98.2% @ 37.2    99.7% @ 73.7
  48    88.4% @ 15.1    95.3% @ 26.2    99.5% @ 60.8
  64    82.8% @ 11.3    91.8% @ 19.4    99.1% @ 49.9
 128    68.9% @  6.0    78.9% @  9.3    94.0% @ 24.5
```

The dimension is a monotone calibration knob, and d/2 happens to sit on target for SIFT1M. So "no offline tuning" is true only narrowly: nobody runs a binary search, but a calibration constant is baked into a square root. I haven't tested whether d/2 transfers to CLIP or text embeddings, and that is the first thing I'd check on a new corpus. k moves it too. At **k = 10** the same code overshoots: 87.2% at the 80% target and 94.0% at 90%, using a mean nprobe of 15.4. That is *more* than a fixed nprobe needs (12, for 90.7%).

A principled fix would replace `d` with an intrinsic-dimension estimate (e.g. the MLE over the k-NN distances APS already holds), or fit d_eff online from occasional exact queries.

## A 1/e ceiling on the first partition

The normalization has a side effect. If the v̂ⱼ sum to 1 over n neighbours, AM–GM gives

```text
p₀ = ∏(1 − v̂ⱼ) ≤ (1 − 1/n)ⁿ < 1/e ≈ 0.368
```

no matter how deep inside P₀ the query sits. The only exception is when every cap is zero and the code sets P₀ = 1 (0.05% of SIFT queries). So APS cannot stop after the nearest partition for any target above 36.8%. On SIFT this costs little, since only 2.1% of queries reach 90% recall from P₀ alone (8.3% at k = 10). On a well-clustered corpus with small k, it puts a floor of 2 on nprobe.

Smaller gaps: the paper describes a 1024-point beta table and τρ = 1%, while the code uses 1001 points and a 0.1% default. The table is also a static built for whichever `d` calls it first, so a process serving two indexes of different dimension silently uses the wrong table for the second.

## The split rule and α

Quake costs partition j as Aⱼ·λ(sⱼ), access frequency times profiled scan latency. Post-split frequencies are unknown, so each child is assumed to get a fraction **α** of the parent's traffic:

```text
Δ′_split = ΔO⁺ − A·λ(s) + 2·α·A·λ(s/2)        commit if Δ < −τ
```

The paper's worked example has A = 0.10, λ(500) = 1200 µs, λ(250) = 550 µs, ΔO⁺ = 60 µs, τ = 4 µs and α = 0.5. That gives Δ′ = −5 µs, so the split commits. But Δ′ = −60 + 110α, which means the example commits only for **α < 0.509**. §8.1 says the evaluation uses **α = 0.9**, which gives Δ′ = +39 µs, and the same split would be rejected. The verify stage recomputes sizes but "retain[s] the original frequency assumptions," so its monotone-decrease guarantee covers the model, not measured latency.

I measured α by splitting 60 random partitions with 2-means and counting how often each child is probed by the 10k queries that probed the parent:

```text
nprobe   α (child/parent access)   parent's queries hitting BOTH children
   1     0.48                      0%
   5     0.67                      38%
  10     0.74                      51%
  20     0.78                      59%
  50     0.83                      67%
```

α = 0.5 holds only at nprobe = 1. At the nprobe a 90% target needs (about 19), most of the parent's queries touch both children, because the two children are usually each other's nearest centroids. For linear λ a split pays when (1 − α)·A·λ(s) > ΔO⁺: 10× the centroid overhead at α = 0.9, 4.5× at the measured 0.78. So the shipped default under-splits, which is safe, and the worked example describes a regime the system never operates in.

## What to take away

- **APS reproduces on SIFT1M** to within a point of Table 5, with better tail recall than a fixed nprobe.
- **Its calibration comes from a non-textbook cap formula** equal to using d/2 dimensions. Treat d_eff as a parameter and re-check it per corpus and per k.
- **Cap normalization keeps p₀ below 1/e**, so APS always scans at least two partitions.
- **α decides splits.** Measured α is 0.67–0.83. The example's 0.5 matches no realistic nprobe, and the shipped 0.9 under-splits.

The design holds up. What carries it, though, is one constant hidden inside a square root.
