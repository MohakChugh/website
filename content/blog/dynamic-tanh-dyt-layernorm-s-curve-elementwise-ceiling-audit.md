---
title: "Dynamic Tanh, Audited: Where LayerNorm's S-Curve Comes From, the Ceiling on Any Element-wise Replacement, and Why the 52% Speedup Is a Kernel Count"
date: 2026-11-21
tags: [transformers, normalization, deep-learning, numerical-analysis, gpu]
excerpt: "DyT (CVPR 2025) replaces LayerNorm with γ·tanh(αx), arguing from scatter plots that trained LN layers already look like tanh. I derived where that S-curve comes from and simulated how much of LayerNorm any element-wise function can reproduce. A single outlier in a C-wide token is normalized to exactly v/√(1+v²/C), which is within 0.074 of √C·tanh(v/√C). With rare outliers, tanh fits LN with R² 0.990, the same as the best element-wise function. With token-scale spread or common outliers, every element-wise map tops out around 0.85, and tanh is never more than 0.016 below that ceiling. The 52% layer speedup in the paper matches eager-mode memory traffic (36 vs 16 bytes per element) and disappears once the kernels are fused, as the paper's own Table 15 shows."
---

*Transformers without Normalization* (Zhu, Chen, He, LeCun, Liu; arXiv:2503.10622, CVPR 2025) proposes swapping every LayerNorm or RMSNorm for

```text
DyT(x) = γ ⊙ tanh(α·x) + β        α: one learnable scalar per layer; γ, β: per-channel
```

The argument rests on an observation. If you plot each input element of a trained LN layer against its output, deeper layers trace "tanh-like, S-shaped curves", and DyT is meant to copy that curve directly without computing any statistics. The paper reports that ViT, ConvNeXt, MAE, DINO, DiT, wav2vec 2.0 and LLaMA 7B–70B models with DyT match their normalized counterparts.

I did not reproduce the training runs. I checked where the S-curve comes from, how much of LayerNorm any element-wise function can reproduce, and what the latency tables measure, using numpy and scipy scripts with C = 768 (ViT-B).

## The S-curve has a closed form

The paper's Figure 4 shows that each token's points lie on a straight line, since LN is linear within a token, and that the lines for different tokens have different slopes. Together they form the S. Here is why the envelope looks like tanh.

Take a token with C − 1 roughly unit-variance channels and one channel at value v. The outlier inflates the statistic it is then divided by:

```text
σ² ≈ 1 + v²/C              (the outlier's share of the variance)
LN(v) ≈ v / √(1 + v²/C)    → saturates at √C as v → ∞
```

This is an algebraic sigmoid with slope 1 at the origin and an asymptote at √C. By Cauchy–Schwarz, no LN output can exceed √(C−1) in magnitude. Simulation agrees with the closed form to three digits:

| outlier v | LN output (sim) | closed form | √C·tanh(v/√C) |
|---:|---:|---:|---:|
| 20 | 16.22 | 16.21 | 17.13 |
| 50 | 24.23 | 24.22 | 26.25 |
| 100 | 26.69 | 26.69 | 27.67 |
| 1000 | 27.68 | 27.68 | 27.71 |

The largest gap between x/√(1+x²) and tanh(x) is **0.074**, at x = 1.62. So "LN looks like tanh" has a precise meaning: an outlier that normalizes itself follows a sigmoid that tanh with matched slope and asymptote approximates to within 7.4% of full scale. It also explains why ViT squashes values above about 50: with C = 768 the knee sits near √C ≈ 28 times the typical channel scale.

## How much of LayerNorm is element-wise at all?

An S-shaped envelope does not mean the function is element-wise. LN divides each element by a statistic of its whole token, and an element-wise map cannot see that statistic. To separate tanh's fitting error from that structural limit, I compared three fits to the LN output on synthetic activations: the best linear map, the best γ·tanh(αx) (multi-start least squares), and the best possible element-wise function, which is the conditional mean E[y | x] estimated over about 6,000 bins. No element-wise replacement, whatever its shape, can score above that third column.

```python
def ln(x):                                    # per-token, no affine
    mu, sd = x.mean(-1, keepdims=True), x.std(-1, keepdims=True)
    return (x - mu) / np.sqrt(sd**2 + 1e-6)

def make(N, sig_tok, m, p, k=4):              # token-scale spread + k outlier channels
    s = np.exp(sig_tok * rng.standard_normal((N, 1)))
    x = rng.standard_normal((N, C)) * s
    hot = rng.random((N, k)) < p
    x[:, :k] += np.where(hot, m * (0.5 + rng.random((N, k))), 0.0)
    return x
```

6,000 tokens per case, C = 768:

| activation regime | linear R² | tanh R² | element-wise ceiling | fitted γ |
|---|---:|---:|---:|---:|
| same-scale tokens, no outliers | 0.998 | 0.998 | 0.998 | (degenerate) |
| token-scale spread, σ_log = 0.3 | 0.910 | 0.936 | 0.936 | 2.45 |
| token-scale spread, σ_log = 0.6 | 0.691 | 0.846 | 0.853 | 1.60 |
| 4 outlier channels (m = 100) on 1.6% of tokens | 0.888 | **0.990** | 0.990 | 26.3 |
| same, on 76% of tokens | 0.779 | 0.848 | 0.861 | 22.4 |
| σ_log = 0.3 spread + rare outliers | 0.808 | 0.913 | 0.929 | 2.47 |

What the table shows:

1. **tanh is close to the best shape an element-wise map can have.** In every case it is within 0.016 R² of the ceiling, so the paper's hardtanh and sigmoid ablations were testing a factor with little room to improve. Their result (tanh best, the others close) is what you would expect from this.
2. **The ceiling is what binds.** With rare outliers (the "massive activations" pattern, confined to a few tokens), tanh reproduces LN almost exactly. The fitted γ = 26.3 lands on the √C = 27.7 asymptote derived above. When token scales vary by about e^±0.6, or when outlier channels fire on most tokens, every element-wise map tops out around 0.85.
3. **Two different mechanisms produce an S-curve.** Self-normalizing outliers give γ ≈ √C. Token-scale spread gives γ ≈ 2. A scatter plot cannot distinguish them, but the fitted γ can. That gives a cheap diagnostic for any trained LN model you are thinking of converting.

What gets lost is the cross-channel effect. In a token with one outlier at v = 100, LN scales every other channel by 1/√(1 + v²/C) = **0.267** (simulated: 0.267). An element-wise map leaves those channels at gain 1. In the 76%-outlier case this is why the fitted curve gets the clean tokens wrong (R² 0.650 on those tokens alone): its slope is a compromise between gain 1 and gain 0.27.

This does not contradict the paper's training results, because the network can learn to keep its token scales uniform without LN's help. What it shows is the job a DyT network has to take over: equalizing scale across tokens.

## "α tracks 1/std" is guaranteed by LN's scale invariance

Section 6.2 reports that the learned α "closely tracks the 1/std of activations". Any DyT that mimics LN must do this: LN(k·x) = LN(x), and tanh(α′·k·x) = tanh(α·x) exactly when α′ = α/k. The correlation shows α absorbing residual-stream growth with depth, not anything about tanh.

## The width table follows no simple scaling rule

The one setting where DyT needs tuning is α₀ for LLMs, and Table 11 gives optimal (attention / other) values against width:

```text
width   1024     2048     4096     8192
α0      1.0/1.0  1.0/0.5  0.8/0.2  0.2/0.05      depth 8–64: no effect
```

The "other" column falls by 2×, 2.5× and then 4× per width doubling. That is not a power law. The outlier-knee derivation above puts the knee at √C, which would mean α ∝ 1/√d and predict 0.35 at d = 8192. The table's 0.05 is 7× smaller. Whatever drives the width sensitivity, it is not DyT matching LN's geometry. The paper's guess, "excessively large widths", is the most that can be said. In practice, sweep α₀ on any new width instead of extrapolating from this table. (Erratum: Table 10 lists the 34B/70B widths as "8196"; the hidden size is 8192.)

## The 52% speedup is a kernel count

Appendix C Table 14 reports DyT layers as 52.4% faster than RMSNorm in inference on LLaMA 7B, H100, BF16. Table 15 shows the gap goes to zero under `torch.compile`, and §9 says plainly that DyT "offers no speedup … when properly compiled". The eager-mode gap is accounted for by bytes moved. Hugging Face's `LlamaRMSNorm` runs as separate kernels: upcast to fp32 (6 B per element), `pow` (8), `mean` (4), multiply by rsqrt (8), downcast (6), multiply by weight (4), for **36 B/element**. DyT's four eager ops (`α·x`, `tanh`, `γ·`, `+β`) move **16 B/element**. Fused, either one is a single read plus a single write: **4 B/element**.

```python
calls, elems = 100 * (32*2 + 1), 4096 * 4096     # 100 passes × 65 norm layers × 4096² activations
for name, bpe, measured in [("RMSNorm eager", 36, 2.1), ("DyT eager", 16, 1.0), ("fused", 4, 0.3)]:
    t = calls * elems * bpe / 3.35e12            # H100 SXM HBM3 peak
    print(f"{name:14s} roofline {t:.2f}s  measured {measured}s  ({measured/t:.1f}x)")
```

```text
RMSNorm eager  roofline 1.17s  measured 2.1s  (1.8x)
DyT eager      roofline 0.52s  measured 1.0s  (1.9x)
fused          roofline 0.13s  measured 0.3s  (2.3x)
```

The predicted eager reduction is 1 − 16/36 = **55.6%**, against 52.4% measured. All three rows run at about the same fraction of peak bandwidth. Both layers are memory-bound, and RMSNorm's reduction over 4,096 channels fits within one row's read, so the per-token reduction costs nothing once fused.

## Takeaways

- LayerNorm's S-curve is an outlier divided by a standard deviation it inflated itself: v/√(1+v²/C). tanh matches it to within 0.074 of full scale, and the fitted γ (about √C for outliers, about 2 for scale spread) shows which regime a model is in.
- What limits DyT is being element-wise, not the choice of tanh. The ceiling is R² 0.99 with rare outliers and about 0.85 when token scales vary, because LN's per-token gain cannot be expressed element-wise.
- Sweep α₀ at each new width, and compare speed only against a fused norm.
