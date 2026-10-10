---
title: "SynthID-Text's Tournament Watermark: 2^30 Candidates Become One Line per Layer, and the 10→1 Weights Are 99% Optimal"
date: 2026-10-10
tags: ["llm", "watermarking", "sampling", "statistics", "ai-safety"]
excerpt: "SynthID-Text (Nature, 2024) watermarks LLM output with a 30-layer knockout tournament over sampled tokens, but the reference code never samples a candidate. Each layer is the closed-form tilt p·(1 + g − G). I verified the tilt against a literal tournament, derived how it concentrates the distribution, and ran the watermark end to end on Qwen2.5-0.5B. Per-layer signal falls 6× from layer 1 to layer 30. The default 10→1 weights capture 99.1% of the optimal signal-to-noise ratio, and the plain mean needs 25% more tokens."
---

# SynthID-Text's Tournament Watermark: 2^30 Candidates Become One Line per Layer, and the 10→1 Weights Are 99% Optimal

Dathathri et al.'s *Scalable watermarking for identifying large language model outputs* (Nature 634, 2024) describes SynthID-Text, the generation-time watermark deployed in Gemini. A keyed hash of the last H = 4 tokens plus a candidate token gives that candidate m = 30 pseudorandom bits, g₁..g₃₀. Sampling becomes a knockout tournament. You draw 2^m candidates, pair them up, and at layer ℓ keep whichever of each pair has the larger g_ℓ, breaking ties at random. The last candidate standing is emitted. A detector holding the key recomputes the g-values. Watermarked text has a mean g above ½, and human text sits at ½.

The [reference implementation](https://github.com/google-deepmind/synthid-text) shows the tournament is really 30 cheap reweightings of a 40-entry vector. That view also explains the detector's weighting scheme.

## The tournament is a tilt

Take one layer with input distribution p and a fixed assignment of g-bits. Two independent draws x and y produce x when both draws are x, or when the draws differ and x wins. Token x wins outright when g(x) > g(y) and half the time when the bits tie. Summing over y collapses to

```
p'(x) = p(x) · (1 + g(x) − G),     where G = Σ_y p(y)·g(y)
```

G is the probability mass currently on tokens with g = 1. Tokens with g = 1 are scaled up by 2 − G and tokens with g = 0 are scaled down by 1 − G. This is the line in `logits_processing.py:update_scores`:

```python
for i in range(depth):
    g_values_at_depth = g_values[:, :, i]
    g_mass_at_depth = (g_values_at_depth * probs).sum(axis=1, keepdims=True)
    probs = probs * (1 + g_values_at_depth - g_mass_at_depth)
```

The winners of layer ℓ are independent draws from that layer's tilted distribution, so iterating the tilt is exact and the 2^30 candidates never exist. I checked this against a literal tournament (16 candidates, 4 layers, 200,000 trials). The largest per-token gap was 0.0016, at Monte Carlo noise (≈ 0.0011).

**Non-distortion.** Over random keys, E[1 + g − G] = 1 because E[g(x)] = E[G] = ½, so the expected output distribution is exactly p. Over 20,000 random keys my iterated tilt matched p to within 0.002.

**Per-layer lift.** The expected g of the layer winner is Σ p(x)·g(x)·(1 + g(x) − G) = 2G − G². Its average over keys is

```
E[g_winner] = 1/2 + (1/4)·(1 − q),      q = Σ p(x)²   (collision probability)
```

This matches Corollary 27 of the paper's supplement, which the repo's `expected_mean_g_value` encodes as `0.5 + 0.25 * (1 - 1/vocab_size)` for a uniform distribution. A layer adds at most ¼, and nothing for a point mass, since two identical candidates can't be told apart.

## Deeper layers carry less signal

Each layer's output is the next layer's input, and the tilt concentrates mass. Expanding the variance of 1 + g(x) − G over random bits gives the expected collision probability after one layer:

```
E[q'] = q·(1 + (1 + q)/4) − (1/2)·Σ p(x)³
```

For a broad distribution (q small) that is roughly 1.25·q, so collisions grow about 25% per layer. For a point mass (q = 1, Σp³ = 1) it is a fixed point. Against 400,000 random keys on Dirichlet distributions with q from 0.03 to 0.44, it agreed to the fourth decimal (0.4619 measured vs 0.4622 predicted).

Lift is (1 − q)/4, so rising q means falling lift. Because the later layers are unbiased, this per-layer lift is also the emitted token's expected g_ℓ. The reference configuration samples from the top 40 tokens, so q starts at least at 1/40. Iterating 30 layers from a uniform top-40 distribution:

| layer | 1 | 10 | 20 | 30 |
|---|---|---|---|---|
| lift, uniform over 40 | 0.244 | 0.215 | 0.156 | 0.102 |
| lift, uniform over 1,000 | 0.250 | 0.248 | 0.237 | 0.207 |

Even in this best case the 30th layer gives 40% of the first layer's lift. The −½Σp³ term keeps growth well below 1.25× per layer once q is large, so the curve declines without collapsing.

## End to end on a real model

I implemented the scheme on Qwen2.5-0.5B with the reference configuration: depth 30, H = 4, top-k 40, and skipping any 4-token context already seen in the response. Temperature was 0.7, and the g-bits come from a keyed BLAKE2b hash of (context, token). I generated 32 prompts × 200 tokens with and without the watermark. Real distributions are narrow: mean entropy is 1.17 bits, 22% of steps have under 0.1 bit, and 4.9% of steps were masked as repeats.

Per-layer lift, measured as the mean g_ℓ of emitted tokens minus ½, and computed analytically by iterating the tilt over 600 recorded top-40 distributions:

| layer | 1 | 5 | 10 | 15 | 20 | 25 | 30 |
|---|---|---|---|---|---|---|---|
| measured | 0.088 | 0.068 | 0.049 | 0.059 | 0.023 | 0.010 | 0.015 |
| analytic | 0.087 | 0.071 | 0.050 | 0.039 | 0.029 | 0.020 | 0.014 |

The analytic curve tracks the noisy measurement. Both start at a third of the theoretical maximum, because low-entropy distributions begin with heavy collision mass, and both decay about 6× across the stack. Layers 1–10 carry 54% of the total signal and layers 21–30 carry 16%.

## Why 10→1 is the right weighting

The default `weighted_mean_score` weights layers linearly from 10 down to 1:

```python
if weights is None:
    weights = jnp.linspace(start=10, stop=1, num=watermarking_depth)
```

Under the null hypothesis every g is an independent fair coin, so a linear score Σ w_ℓ·g_ℓ has signal Σ w_ℓ·δ_ℓ (δ_ℓ is the per-layer lift) and noise variance ¼·Σ w_ℓ². The matched filter, w ∝ δ, maximizes the ratio, so decaying lift calls for decaying weights. Here are the alternatives on the analytic Qwen lift curve, with token budgets for 80% detection at 1% false positives (z ≥ 2.326 + 0.842):

| weighting | efficiency vs optimal | tokens for 80% TPR at 1% FPR |
|---|---|---|
| matched filter (w ∝ δ) | 1.000 | 37.0 |
| linear 10→1 (default) | 0.991 | 37.3 |
| uniform mean | 0.796 | 46.5 |
| layer 1 only (depth-1 watermark) | 0.112 | 331.5 |

A fixed, model-agnostic line recovers 99.1% of the matched-filter signal-to-noise ratio. The plain mean throws away a fifth of it and needs 25% more text. The last row is the case for depth. A one-layer tournament gets only the 0.087 lift, and 30 layers cut the text needed for detection by about 9×.

Measured detection rates on held-out windows (weights fitted on 16 texts, tested on the other 16) give the same ranking:

| window T | mean | linear 10→1 | fitted to measured lift |
|---|---|---|---|
| 10 | 0.209 | 0.228 | 0.241 |
| 25 | 0.469 | 0.508 | 0.516 |
| 50 | 0.672 | 0.766 | 0.750 |
| 100 | 0.906 | 0.969 | 0.969 |

One caveat on absolute numbers. From average lift, the model predicts 91% TPR at T = 50 for the 10→1 score, and I measured 77%. Entropy comes in clumps. A recipe's ingredient list or a numbered set of chess rules lowers lift across a whole window, so z spreads more across windows than average lift implies. Treat a token budget computed from average lift as a lower bound.

## The null hypothesis, and one unlucky key

The unwatermarked control did not look clean at first. Under my demo key, the 32 unwatermarked texts averaged a per-text z of 0.49, and about 2% of 25-token windows crossed the 1% threshold. My first suspect was common 5-grams, which get the same g-bits in every document. But only 0.4% of tokens shared a 5-gram with another text, and dropping them changed nothing. So I re-scored the same tokens under 20 fresh keys. The mean per-text z was 0.025 with a standard deviation of 0.176, against the 1/√32 = 0.177 a fair coin predicts, and the pooled false-positive rate was 1.04%. The detector is calibrated. My demo key paired with this corpus was simply a 2.8σ draw. The practical lesson is about calibration sets. A 32-text check under a single key can misstate the false-positive rate by 2×, so validate thresholds on more text or across several keys.

## What to take away

- **The tournament costs 30 multiplies over a 40-vector per token.** Hashing the g-bits costs more than the tilt does.
- **Collision probability sets the lift, and each tilt raises it.** Every layer weakens the next one, and the model's sampling entropy sets the ceiling. Depth 30 still beats depth 1 by 9× in tokens.
- **Weight layers by expected lift.** For a 1-bit-entropy model, linear 10→1 is within 1% of optimal. Even for uniform top-40, the matched filter beats it by under 4%.
- **Budget tokens from per-window entropy, not average entropy.** The 91% vs 77% gap comes from clumpy text, not from the hash.
