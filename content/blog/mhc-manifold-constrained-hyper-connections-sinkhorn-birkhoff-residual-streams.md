---
title: "mHC: Sinkhorn-Projected Residual Streams, Where the 20-Iteration Error Actually Lands, and Why Fig. 8's 1.50 Column Sum Is a Correlation Effect"
date: 2026-10-07
tags: ["transformers", "llm-architecture", "residual-connections", "training-stability", "sinkhorn"]
excerpt: "DeepSeek's mHC widens the residual stream to n=4 lanes and projects each lane-mixing matrix onto the Birkhoff polytope with 20 Sinkhorn iterations. The paper reports a peak composite gain of 3000 under plain HC, and 1.6 under mHC. I simulated the projection. Because row normalization runs last, the forward gain is exact to 1e-15 and all the leftover error goes to the backward (column) side. Independent random layers only drift to 1.14. Layers with shared structure reproduce the paper's 1.50 / 0.41 column sums. The paper's max-only metric hides the 0.41."
---

# mHC: Sinkhorn-Projected Residual Streams, Where the 20-Iteration Error Actually Lands, and Why Fig. 8's 1.50 Column Sum Is a Correlation Effect

A residual connection works because the identity term passes signal through unchanged: `x_L = x_l + Σ F(x_i)`. **Hyper-Connections** (HC, Zhu et al., 2024) widen the stream to `n` parallel lanes of width `C`. They add three small learned maps: `H_pre` (1×n) reads the lanes into one layer input, `H_post` (1×n) writes the layer output back to the lanes, and `H_res` (n×n) mixes the lanes:

```text
x_{l+1} = H_res_l · x_l  +  H_post_lᵀ · F(H_pre_l · x_l)        x_l ∈ R^{n×C}
```

FLOPs barely change because `n = 4` is tiny compared with `C`. In the paper's ablation, `H_res` alone gives most of the gain (−0.022 of the −0.027 loss gap). The catch shows up when you unroll over depth. The identity term becomes `Π H_res`, a product of 60 unconstrained 4×4 matrices. *mHC: Manifold-Constrained Hyper-Connections* (DeepSeek-AI, arXiv:2512.24880) measured this product inside a 27B MoE trained with HC. The largest absolute row or column sum hit **~3000**, and the run had a loss spike around step 12k.

mHC's fix fits in one line: force every `H_res` to be **doubly stochastic**.

## Why the Birkhoff polytope

If a matrix has non-negative entries and every row and column sums to 1, three properties follow. The paper uses all three:

1. **Mean conservation.** Row sums of 1 mean each output lane is a convex combination of the input lanes. Column sums of 1 mean the total over lanes is preserved, in both the forward and backward directions.
2. **Non-expansive.** `‖A‖₂ ≤ sqrt(‖A‖₁·‖A‖_∞) = 1`.
3. **Closed under multiplication.** A product of doubly stochastic matrices is doubly stochastic, so the 60-layer composite keeps the guarantee.

With `n = 1` this reduces to the scalar 1, which is the ordinary residual. The paper also passes `H_pre` through a sigmoid and `H_post` through `2·sigmoid`, so the read and write gains are non-negative and can't cancel each other.

The projection uses entropic Sinkhorn–Knopp. Exponentiate the raw logits, then alternate column and row normalization:

```python
def sinkhorn(logits, t_max=20):
    M = np.exp(logits - logits.max())
    for _ in range(t_max):
        M = M / M.sum(axis=0, keepdims=True)   # T_c: columns -> 1
        M = M / M.sum(axis=1, keepdims=True)   # T_r: rows    -> 1  (runs last)
    return M
```

The paper's Eq. 9 is `M(t) = T_r(T_c(M(t−1)))`, and it uses `t_max = 20`. The order of these two operations matters more than the paper says.

## Where the truncation error goes

Since `T_r` runs last, every output row sums to exactly 1, and so does every product of such matrices: a product of row-stochastic matrices is row-stochastic. The forward signal gain is therefore exact by construction. Only the column sums carry the leftover error, and column sums are the backward gradient gain. The paper notes in §5.4 that "the backward gradient gain deviates slightly from 1" but doesn't explain why. The operation order is the reason. Swap the order and the error moves to the forward pass. Twenty iterations can't make both sides exact.

I measured how large the column error is. Logits are `s · N(0,1)`, `n = 4`, with 5,000 draws per scale:

| logit scale s | median col error | p99 | max |
|---|---|---|---|
| 1 | 4e-13 | 1.5e-6 | 1.5e-4 |
| 2 | 8e-7 | 1.2e-2 | 3.2e-2 |
| 4 | 2.9e-3 | 4.3e-2 | 6.7e-2 |
| 6 | 1.7e-2 | 6.2e-2 | 0.107 |

Sinkhorn converges geometrically, but the rate gets worse as the matrix approaches a permutation. Trained mHC matrices sit in exactly that regime. In the paper's Fig. 8, layer 30 has diagonal entries of 0.96–1.00, which corresponds to logit gaps of about 4–5 nats. At that scale, 20 iterations leave column sums off by a few percent.

## Composites: the iid case can't reproduce the paper

Next I chained 60 independently drawn 20-iteration matrices. Forward deviation stayed at 1e-15 every time. Column sums drifted only a little: at `s = 4`, the max was 1.075 and the min 0.934. At `s = 6` they were 1.136 and 0.890. With independent errors, the per-layer deviations partly cancel, like a random walk.

The paper's Fig. 8 is much worse than that. The composite over layers 31–60 has column sums of **0.41, 1.50, 1.50, 0.60**. Independent noise can't produce that, but correlated layers can. I gave all 30 layers the same base logits (`s = 4`) plus a small per-layer perturbation σ:

| per-layer σ | composite max col (p99) | composite min col (p1) |
|---|---|---|
| 0 (identical layers) | 1.49 | 0.38 |
| 0.3 | 1.56 | 0.38 |
| 1.0 | 1.40 | 0.55 |
| 4.0 (≈ iid) | 1.10 | 0.89 |

At σ ≈ 0.3, the simulation lands on the paper's figure: 1.56 / 0.38 against 1.50 / 0.41. My reading: deep mHC layers learn similar near-permutation mixers, the leftover Sinkhorn error has the same sign in every layer, and it compounds like `(1+δ)^depth` rather than `sqrt(depth)·δ`. This is a hypothesis that matches the published numbers, not a measurement of DeepSeek's weights. It does make a testable prediction: more iterations should fix it.

| t_max (σ = 0.3) | max col p99 | min col p1 |
|---|---|---|
| 20 | 1.51 | 0.41 |
| 50 | 1.19 | 0.74 |
| 100 | 1.05 | 0.93 |

Sinkhorn on a 4×4 matrix costs almost nothing next to the layer itself, so extra iterations are cheap insurance.

## The metric only measures one side

Fig. 3 and Fig. 7 plot the **Amax Gain Magnitude**, the maximum absolute row or column sum. That captures explosion, and the 3000 → 1.6 drop is real and is the paper's main result. But a max can't show attenuation. In the same Fig. 8 matrix, one column sums to 0.41. That's a 2.4× drop in gradient flow into one lane over 30 layers, and Fig. 7's "bounded, max ≈ 1.6" can't show it. For a doubly stochastic target, the honest summary is the pair (max, min) of column sums, or `max |log colsum|`. That metric treats 1.5 and 0.67 as equally bad. On that metric, the paper's own composite scores |log 0.41| = 0.89. The attenuated lane dominates, not the amplified one (log 1.50 = 0.41).

## Mixing is front-loaded

The paper says repeated doubly stochastic products "increase mixing monotonically". That's true: a product of primitive doubly stochastic matrices converges to the uniform matrix `J/n`. Every lane then just receives the lane mean, and only the mean survives. The rate is `|λ₂|^depth`. I took the three mHC matrices printed in Fig. 8 and computed their second eigenvalues:

| matrix | \|λ₂\| | layers until the differential mode is 1% |
|---|---|---|
| H_1 | 0.673 | 12 |
| H_30 | 0.970 | 151 |
| H_60 | 0.962 | 119 |

The first layer mixes hard. Deep layers are close to the identity and barely mix at all. That explains both composite panels in Fig. 8. The product over layers 1–30 is almost uniform (entries 0.17–0.34) because the early layers scramble the lanes. The product over layers 31–60 still has structure (diagonal 0.35, 0.62, 0.80, 0.31) because those layers mostly keep each lane separate. In practice, the network uses the extra lanes as near-independent residual streams through the deep half, and only the early layers actually mix them.

## Systems cost

Widening the stream costs memory traffic, not FLOPs. The paper's Table 2 adds up correctly: at `n = 4`, HC reads 21C and writes 13C per token per layer, against 2C and C for a plain residual. mHC gets the overhead down to **6.7%** in three ways. It fuses `H_post`, `H_res`, and the residual merge into one kernel, cutting reads from `(3n+1)C` to `(n+1)C`. It recomputes in blocks of `L_r` layers, storing only each block's input. Minimizing `nC·L/L_r + (n+2)C·L_r` gives Eq. 20, `L_r* = sqrt(nL/(n+2))`, which works out to 6.3 for 60 sublayers: 75.9C per token instead of 240C. And it schedules the `n×` larger pipeline sends inside DualPipe, with the MLP `F_post,res` kernels on a high-priority stream.

## Takeaways

- The constraint works. The peak gain drops from 3000 to 1.6, and the 27B model beats both HC and the baseline (BBH 51.0 vs 48.9 vs 43.8) with no loss spike.
- Because `T_r` runs last, all of Sinkhorn's truncation error lands in the backward gradients. Measure column sums and report `max |log colsum|`, not Amax.
- Twenty iterations is too few for stacks of correlated near-permutation layers. Going to 100 brings composite drift from 1.51 / 0.41 down to 1.05 / 0.93.

The idea that will outlast this paper is to pick a manifold that is closed under multiplication, so the depth-wise guarantee comes for free. An exact parameterization would remove the truncation question entirely. At `n = 4`, a softmax over the 24 permutation matrices is exactly doubly stochastic by Birkhoff–von Neumann, with no iterations needed.
