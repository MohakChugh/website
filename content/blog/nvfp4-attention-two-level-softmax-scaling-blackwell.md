---
title: "Microscaling FP4 Attention: Why the Softmax Operand Needs Two Scale Factors"
date: 2026-08-23
tags: ["gpu", "quantization", "attention", "blackwell", "inference"]
excerpt: "SageAttention3 runs both attention matmuls in NVFP4 on Blackwell tensor cores at 1038 TOPS. The interesting part isn't the format — it's that post-softmax probabilities live in [0,1], which collapses an E4M3 scale factor to 35 usable codes. A from-scratch reimplementation shows the two-level fix is worth 30 cosine-similarity points, but only for high-entropy attention."
---

# Microscaling FP4 Attention: Why the Softmax Operand Needs Two Scale Factors

Quantizing a linear layer is a solved engineering problem: both operands are static weights or activations you can calibrate offline. Attention is not that. Its second matmul, `P @ V`, consumes an operand *produced by the kernel itself*, one row-block at a time, inside an online-softmax loop. You cannot calibrate `P`. You get one pass, in registers, with the row maximum still moving.

[SageAttention3](https://arxiv.org/abs/2505.11594) (Zhang et al., ICLR-cycle 2025, revised Jan 2026) pushes both attention matmuls onto Blackwell's FP4 tensor cores and reports 1038 TOPS on an RTX 5090 — roughly 5× the fastest FlashAttention available on that part. The headline is the format. The engineering lesson is a scale-factor dynamic-range bug that only exists because the operand is a probability.

## NVFP4, not MXFP4

Both microscaling FP4 formats store elements as E2M1 — magnitudes drawn from `{0, 0.5, 1, 1.5, 2, 3, 4, 6}` — and attach a shared scale to each contiguous block:

| Format | Block | Scale type |
|---|---|---|
| MXFP4 | 1×32 | E8M0 (power of two) |
| NVFP4 | 1×16 | E4M3 (FP8) |

Quantization is `s = max|X_block| / 6`, then round each element of `X/s` onto the E2M1 grid. Halving the block and giving the scale a mantissa matters more than it sounds like it should. Reimplementing both from scratch — full E2M1 grid, exact OCP E4M3 code enumeration, applied to `Q`, `K`, `P` and `V` on 1024×128 synthetic tensors with a deliberate per-channel mean in `K`:

```
NVFP4 (1x16, E4M3)   CosSim 98.093%   rel-L1 0.1946
MXFP4 (1x32, E8M0)   CosSim 96.540%   rel-L1 0.2625
```

Same ordering and same margin direction as the paper's CogVideoX ablation (99.52% vs 98.37%); my absolute numbers are worse throughout because i.i.d. Gaussian `Q`/`K` produce near-uniform attention, which is the harshest case — more on that below.

## The probability squeeze

Here is the part worth internalizing. Every entry of a post-softmax block lies in `[0, 1]`, so its microscaling factor is `max(P_block)/6 ∈ [0, 0.167]`. NVFP4 requires that scale be stored in **E4M3**, not FP32. E4M3 spends its 4 exponent bits covering magnitudes up to 448 — so how much of it lands in a window that ends at 0.167?

Enumerating all 256 E4M3 codes (subnormals included, `S1111111` reserved for NaN):

```
E4M3 distinct non-negative magnitudes:  127   (max 448.0)
  ... in [0, 0.167]:                     35
```

Exactly 35, matching the paper's appendix — and 127 over the format's full range, also matching. So a direct FP4 quantization of `P` throws away 73% of the scale codebook before a single element is rounded. Multiply by the 8 E2M1 magnitudes and you get the paper's 280-value upper bound on distinct dequantized probabilities.

That bound is loose in the direction that hurts. Measuring the *actual* number of distinct magnitudes on real softmax rows, the row sums force scales into a narrow band and only **11** distinct values survive:

```
distinct |P| magnitudes, direct scale:      11
distinct |P| magnitudes, two-level scale:  4454
```

Eleven levels for an entire attention distribution.

## Two-level scaling

The fix is to strip the `[0,1]` constraint before the scale is ever computed. Normalize per token in FP32 first, so the block-level scale sees a range that actually exercises E4M3:

```python
def quant_p(P, block=16):
    # level 1: per-token FP32 pre-scale into [0, 448*6]
    s_p1 = P.max(-1, keepdims=True) / (448.0 * 6.0)
    P2   = P / s_p1
    # level 2: microscaling FP4 with an E4M3 block scale
    s_p2 = q_e4m3(blockmax(P2, block) / 6.0)
    P_hat = q_e2m1(P2 / s_p2)
    return P_hat, s_p2, s_p1          # O = FP4MM(P_hat, s_p2, V_hat, s_v) * s_p1
```

`s_p1` is FP32 and never touches the tensor core; it is folded into the accumulator after the matmul, so it costs one row-broadcast multiply. `s_p2` now spans `[0, 448]` — 127 codes instead of 35. In my harness that single change is the largest accuracy lever in the whole design:

```
NVFP4, two-level P scale          CosSim 98.093%
NVFP4, direct P scale             CosSim 67.472%
```

The paper reports 99.52% vs 93.32% for the same swap. Two implementation details make it nearly free: `s_p1` reuses the row maximum the online softmax already computed, and the block max over 16 elements — which live across four threads — is fused into that same reduction, worth about 10% of total kernel time by the authors' measurement.

## Smooth-K is the smaller lever

The SageAttention lineage is named for its outlier smoothing: `K` carries a large per-channel mean, which eats the quantization range of every block it appears in, so you subtract it and add the correction back as a rank-1 GEMV.

```python
km = K.mean(0)                          # per-channel mean, [D]
S  = fp4mm(quant(Q), quant(K - km))     # tensor core, FP4
S += (Q @ km)[:, None]                  # exact rank-1 correction, GEMV
```

This is mathematically exact — `Q(K-km)ᵀ + Q·kmᵀ = QKᵀ` — and it does work: on the score matrix alone, relative L1 error drops from 0.1340 to 0.0465, a 2.9× improvement. But at the end-to-end output it is worth about 3 cosine points (94.9% → 98.1%) against the two-level scaling's 30. If you are porting this design and can only implement one trick, the ordering is unambiguous, and it is not the one in the paper's title.

## Where FP4 attention actually breaks

The paper validates on video diffusion models. That choice does more work than it appears to. Sweeping a temperature on the logits to move attention from diffuse to near-one-hot, holding everything else fixed:

```
                          two-level   direct scale
norm-entropy 0.928         98.093%      67.472%
norm-entropy 0.343         95.158%      95.081%
norm-entropy 0.131         92.184%      92.191%
norm-entropy 0.055         87.853%      87.936%
```

Two findings the paper does not report. First, **the entire benefit of two-level scaling is confined to high-entropy attention.** Once rows become peaked, the row max is close to 1, `[0, 0.167]` is fully occupied, and the two schemes are indistinguishable. Diffusion-video attention is famously diffuse — the ablation is measured exactly where the trick pays.

Second, accuracy gets *worse* as attention sharpens, and the binding error source flips. Quantizing only `P` and `V` and leaving scores exact, error is flat across the sweep (99.5% at both ends). Quantizing only `Q`/`K` and leaving `P`,`V` exact:

```
              max|S|   mean|dS|   P rel-L1   O CosSim
t=1            12.37     0.107      0.107     98.998%
t=16          197.87     1.704      0.431     88.267%
```

FP4 is a *relative*-error format, so `|dS|` grows with `|S|`, and softmax exponentiates that absolute error: a logit perturbation of ±1.7 is a ~5.5× multiplicative distortion of a probability. The `QKᵀ` matmul, not `PV`, is what limits FP4 attention on sharply-peaked distributions. That is a deployment rule, not a curiosity: models with large logit scales — long-context retrieval heads, induction heads, anything with near-argmax attention — are exactly where you should keep scores in INT8. For reference, INT8 `QKᵀ` with smooth-K and an FP16 `PV` scores 99.992% in the same harness.

## Decomposing the 5×

The paper's own throughput table invites one more audit. FA2 measures 214 TOPS on the RTX 5090, SageAttention3 1038 TOPS — 4.85×. The 5090's dense peaks are 419 TFLOPS for FP16 with FP16 accumulate and 1676 TOPS for FP4:

```
measured speedup       4.85x
peak format ratio      4.00x   (1676 / 419)
FA2 utilisation        51.0%    SA3 utilisation 61.9%   ->  1.21x
```

So roughly 4× of the win is the format and 1.21× is kernel engineering — the transpose fused into the quantization kernel, the `K`-column permutation that avoids reconciling accumulator and operand register layouts, the producer-warp ping-pong. Worth noting the accumulate convention: 214 TOPS exceeds the 5090's ~210 TFLOPS FP16-with-FP32-accumulate peak, so that baseline has to be counted against the FP16-accumulate path. Attention TOPS numbers are only comparable within one accumulator mode.

## The training half, honestly

The same paper's INT8 training variant (SageBwd) quantizes six of seven forward+backward matmuls per-block, with two deliberate exceptions. `P` uses a *per-token* scale `exp(rowmax(S) − m)/127` — reusing the online-softmax maxima, so no extra pass — because a static `1/127` block scale is inaccurate for probabilities, the same lesson as inference. And `dO Vᵀ` stays in FP16, because it determines `dP` and thus `dS`, whose error compounds through FlashAttention's sequence-length recurrence (measured on `dQ`: 97.47% CosSim in INT8 vs 99.77% in FP16).

The result is 1.67× on forward+backward, ~1.15× end-to-end, lossless on fine-tuning (GSM8K 0.520 vs 0.521 for BF16) — and slower convergence in pretraining, which the authors state plainly. Low-bit attention is production-ready for inference and for fine-tuning. Pretraining is still open.
