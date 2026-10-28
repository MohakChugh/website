---
title: "Scalable-Softmax, Audited: Log-n Attention Is a Temperature Schedule, and Past a Point It Freezes on Noise"
date: 2026-10-29
tags: [attention, transformers, long-context, length-generalization, softmax]
excerpt: "Scalable-Softmax (SSMax) multiplies each query by s·log n so attention stays sharp as context grows. Llama 4 now ships a variant of it. I worked through its claims in closed form and simulated it against Gaussian distractors. The paper's s = 0.168 initialization checks out, but it also makes attention flatter than plain softmax for every query position below 378. The '1/s gap, regardless of n' rule only holds when all distractor logits are equal. With realistic spread, the needle still has to beat a noise maximum that grows as √(2 ln n). The real cost: once s·σ is above √(2/ln n), attention on a context with no needle collapses onto 8–16 noise tokens at any length. Llama 4's schedule matches SSMax to within 5% out to 10M tokens."
---

# Scalable-Softmax, Audited: Log-n Attention Is a Temperature Schedule, and Past a Point It Freezes on Noise

Scalable-Softmax (Nakanishi, arXiv 2501.19399, January 2025) starts from a simple observation. Softmax's numerator `e^{z_i}` does not depend on the context length n, but its denominator sums n terms. As n grows, every attention weight shrinks. The paper calls this *attention fading* and replaces softmax with

```
SSMax(z)_i = n^(s·z_i) / Σ_j n^(s·z_j)  =  softmax((s · ln n) · z)_i
```

Here s is one learned scalar per head, 144 extra parameters in the paper's 162M model. The second form is the useful one. SSMax is softmax at inverse temperature `s·ln n`, so it amounts to a single multiply on the query:

```python
def ssmax_attention(q, k, v, s):           # q: [B,H,T,D], s: [H]
    n = torch.arange(1, q.shape[2] + 1, device=q.device)  # causal: query t sees t keys
    q = q * (s[:, None] * torch.log(n))[None, :, :, None]
    return F.scaled_dot_product_attention(q, k, v, is_causal=True)
```

FlashAttention kernels need no changes. Hugging Face's Llama 4 implementation scales queries in its NoPE layers and cites 2501.19399 on that line. I checked the closed-form claims, then simulated what the analysis skips: distractor logits that are not all equal.

## The idea predates the paper

Qwen-7B's `modeling_qwen.py` (2023) builds `logn_list = [math.log(i, seq_length) if i > seq_length else 1 ...]` and multiplies the query by it at inference. That is SSMax with `s = 1/ln N`, clamped to 1 inside the training window. Chiang & Cholak (ACL 2022) proposed log-n attention scaling to fix length generalization on formal languages. The v1 reference list cites neither. What the paper adds is the empirical case for log specifically. It trained free per-length multipliers `p_n` for n = 1…1024, found they fit `a1·log n + a2` (its Figure 2), and showed that learning s from step 0 beats retrofitting it.

## Closed-form checks

**The retrofit initialization is right, and it explains variant (e).** For swapping SSMax into an already-trained model, the paper sets s to `1024 / Σ ln n ≈ 0.168`. I get 0.16847. That choice makes the multiplier equal 1 at `n = e^(1/0.168) ≈ 378`, not across the whole window:

| query position n | 2 | 16 | 64 | 378 | 1,024 | 8,000 | 20,000 |
|---|---|---|---|---|---|---|---|
| `0.168 · ln n` | 0.117 | 0.467 | 0.701 | 1.00 | 1.168 | 1.514 | 1.668 |

Every query before position 378 gets attention up to 8.5× flatter than the network was trained with. Every query after it gets sharper attention. The paper reports that variant (e) "exhibits higher loss at shorter context sizes" without a mechanism; this table is one. Qwen's clamp, `max(1, log_N n)`, avoids it, as does Llama 4.

**Figure 1 has a crossover the caption doesn't mention.** The input is all −2 except one +3 (gap Δ = 5), with s = 0.43. Both maxima have exact forms: softmax gives `1/(1 + (n−1)e^{−5})` and SSMax gives `1/(1 + (n−1)n^{−2.15})`.

| n | 2 | 10 | 149 | 1,000 | 10⁴ |
|---|---|---|---|---|---|
| softmax max | 0.993 | 0.943 | 0.501 | 0.129 | 0.015 |
| SSMax max | 0.816 | 0.940 | 0.997 | 0.9996 | 1.000 |

SSMax is the less focused of the two until `n = e^(5/2.15) ≈ 10.2`.

**"Approaches 1" can be very slow.** With every distractor at the same logit, the SSMax maximum is `1/(1 + (n−1)·n^(−sΔ))`, which converges as `n^(1−sΔ)`. At exactly `sΔ = 1` it stays at 0.5 for every n. At `sΔ = 1.1` it is 0.67 at n = 10³, 0.80 at 10⁶ and 0.89 at 10⁹. The gap needed for 90% of the attention mass is `(1 + ln 9 / ln n)/s`: 1.317/s at n = 1,024 and 1.222/s at 20,000. Weakly n-dependent; softmax needs `ln(9(n−1))`, which goes from 9.1 to 12.1 over the same range.

## The case the analysis leaves out: distractors with spread

The paper's bounds, Eqs. 6–9, are written in terms of `z_max`, `z_2nd` and `z_min`. Its "focus whenever the gap exceeds ≈1/s" rule effectively assumes all non-key logits are equal. The simplest model with spread: n−1 distractor logits drawn i.i.d. from N(0, σ²), plus one needle at Δ. This is Derrida's random energy model, and its key fact applies directly. At inverse temperature β, the partition function is *frozen*, meaning a handful of terms dominate it, when

```
β·σ > √(2 ln n)
```

Softmax uses a fixed β, so it unfreezes as n grows. That is attention fading. SSMax sets `β = s·ln n`, which grows faster than `√(2 ln n)`. So **any head with s > 0 eventually freezes, even on pure noise**. The crossover length is

```
n_freeze = exp(2 / (s·σ)²)
```

| s·σ | 0.2 | 0.3 | 0.38 | 0.5 | 0.6 | 0.8 |
|---|---|---|---|---|---|---|
| n_freeze | 5×10²¹ | 4.5×10⁹ | 1.0×10⁶ | 2,980 | 259 | 23 |

Heads with small s, the ones that average over their context, never get there in practice. Retrieval heads with s·σ around 0.5 freeze within a few thousand tokens.

I simulated it. I calibrated every scheme to be identical at a training length N = 8,192, at the freezing point (`β_N = √(2 ln N) = 4.25`, equivalent to s = 0.471 with σ = 1), then extended the context. "Needle" is the attention weight on a token 5σ above the distractors. On contexts with no needle at all, "eff" is `exp(entropy)`, the effective number of attended tokens, and "top" is the weight on the single largest distractor. Each cell is a median over 12–30 draws.

| n | softmax needle / eff / top | SSMax (=Qwen) | Llama 4 | √(ln n) schedule |
|---|---|---|---|---|
| 2¹⁵ | 0.923 / 58 / 0.23 | 0.968 / 22 / 0.30 | 0.969 / 22 / 0.30 | 0.950 / 36 / 0.26 |
| 2¹⁷ | 0.690 / 110 / 0.16 | 0.903 / 20 / 0.32 | 0.894 / 22 / 0.31 | 0.823 / 45 / 0.23 |
| 2²⁰ | 0.185 / 403 / 0.14 | 0.497 / 13 / 0.47 | 0.472 / 16 / 0.43 | 0.337 / 61 / 0.29 |

There are three takeaways:

1. **SSMax beats softmax at retrieval, but not "regardless of n".** At 2²⁰ even SSMax puts only half its mass on a 5σ needle. The reason is that the largest of a million Gaussians sits near 4.9σ. Temperature cannot lower that ranking requirement. In my 1,024-token-calibrated run, the gap needed for 50% needle mass rose from 3.51σ to 4.86σ between 2¹⁰ and 2²⁰ under SSMax, and to 5.56σ under softmax. SSMax narrows the drift. It does not remove it.

2. **Frozen heads hallucinate focus.** With no needle present, SSMax attends to 8–16 effective tokens at every length from 2¹⁰ to 2²⁰, and 35–51% of its weight lands on one random distractor. Softmax at 2²⁰ spreads over roughly 400–1,900 tokens, depending on calibration. A frozen head always reports *something* with confidence. That helps needle-in-a-haystack tests, which always contain a needle. It hurts heads whose job is to average, count or summarize.

3. **I tried a √(ln n) schedule hoping for a middle ground, and the simulation ruled it out.** I expected it to be optimal, because the noise maximum grows as √(2 ln n). In fact `(1/β)·log Σ e^{βz}` decreases monotonically in β toward the hard max, so for needle mass, sharper always wins. Slower sharpening keeps the averaging behaviour (eff 61 at 2²⁰) and gives up retrieval (0.337). Neither schedule is free. That supports learning s per head rather than fixing it, which matches the paper's own result that dropping s (variant c) hurts needle retrieval.

## What Llama 4 actually ships

The Llama 4 query multiplier is

```python
attn_scales = torch.log1p(torch.floor((positions + 1.0) / 8192)) * 0.1 + 1.0  # NoPE layers only
```

For n much larger than 8,192 this is about `1 + 0.1·ln(n/8192)`. Clamped SSMax normalized at N = 8,192 is `ln n / ln 8192 = 1 + 0.111·ln(n/8192)`. So Llama 4 is Qwen-style clamped SSMax with a slope about 10% shallower. It is exactly 1 below 8K, which avoids variant (e)'s short-context flattening. The two multipliers are 1.283 vs 1.308 at 128K, 1.486 vs 1.538 at 1M and 1.711 vs 1.789 at 10M, never more than 5% apart, and they are indistinguishable in simulation (0.472 vs 0.497 needle mass at 2²⁰).

## Takeaways

- SSMax is a **temperature schedule**: one multiply on Q.
- When retrofitting, **clamp to 1 inside the training window** (Qwen, Llama 4) rather than using s = 0.168, which flattens every position below 378.
- No temperature removes the √(2 ln n) noise floor. The needle has to beat the largest distractor.
- Log attention entropy on needle-free contexts at your target length. If it stays flat in n, the head is frozen.

*Method: Python closed forms; Monte Carlo over 2¹⁰–2²⁰ i.i.d. N(0,1) distractors, 12–40 draws per cell. The Llama 4 and Qwen-7B formulas are verbatim from the public Hugging Face code. Real logits are correlated and heavy-tailed, so this model isolates the temperature effect and does not predict trained-model accuracy.*
