---
title: "TurboQuant: Random Rotation, Lloyd-Max Codebooks, and the QJL Residual Trick for KV-Cache Quantization"
date: 2026-10-05
tags: ["quantization", "kv-cache", "llm-inference", "vector-search", "information-theory"]
excerpt: "TurboQuant (Google Research, arXiv:2504.19874) quantizes vectors online with no calibration: rotate randomly, then apply one fixed Lloyd-Max scalar codebook to every coordinate. Its MSE comes within 1.44–2.7× of the Shannon lower bound. I reimplemented it at head dimension 128. The MSE numbers reproduce exactly. The b=4 inner-product constant in Theorem 2 is understated by 12%. And the paper's unbiased 'prod' variant loses to a simpler fix, multiplying by one scalar, at every bit width I tested. In a needle-in-softmax test it had up to 2× the attention-output error."
---

# TurboQuant: Random Rotation, Lloyd-Max Codebooks, and the QJL Residual Trick for KV-Cache Quantization

KV-cache quantization usually means one of two things. Product quantization needs k-means over tokens you haven't decoded yet. KIVI-style per-channel scalar quantization is fast, but outlier channels break it and nothing bounds its distance from optimal.

*TurboQuant: Online Vector Quantization with Near-optimal Distortion Rate* (Zandieh, Daliri, Hadian, Mirrokni; arXiv:2504.19874) needs no calibration and no per-block scales, and its distortion is provably within a constant factor of Shannon's limit.

I implemented it in numpy at d = 128, the usual head dimension, and checked each constant. Most hold. One doesn't. And the paper's fix for inner-product bias isn't the best fix.

## Rotate once, then quantize each coordinate the same way

Take a unit vector x in R^d and multiply it by a random orthogonal matrix Π. The result is uniform on the sphere whatever x was. Each coordinate of Πx then follows a known distribution:

```
f(t) = Γ(d/2) / (√π · Γ((d−1)/2)) · (1 − t²)^((d−3)/2),   t ∈ [−1, 1]
```

For large d this is close to N(0, 1/d). Distinct coordinates are also nearly *independent*, which is a stronger property than being uncorrelated. Quantizing each coordinate on its own therefore loses little compared with full vector quantization. So the right codebook is the Lloyd-Max quantizer for f, and it only has to be computed once per (d, b) pair:

```python
import numpy as np

def haar(d, rng):                         # random orthogonal matrix
    q, r = np.linalg.qr(rng.standard_normal((d, d)))
    return q * np.sign(np.diag(r))

def quant_mse(X, Pi, c):                  # X: (n, d) unit rows; c: 2^b centroids
    idx = np.abs((X @ Pi.T)[..., None] - c).argmin(-1)   # b-bit codes
    return idx

def dequant_mse(idx, Pi, c):
    return c[idx] @ Pi                    # look up centroids, rotate back
```

That is the whole MSE quantizer, plus one float for the vector's norm. There are no per-group scales. The rotation spreads outlier energy across all 128 coordinates, the same reason QuaRot rotates before quantizing.

I solved the continuous 1-D k-means problem by numerical integration over the exact distribution at d = 128, then compared the results with Theorem 1:

| bits b | d·C(f,b), mine | paper | lower bound 4^−b | ratio |
|---|---|---|---|---|
| 1 | 0.3609 | 0.36 | 0.2500 | 1.44 |
| 2 | 0.1160 | 0.117 | 0.0625 | 1.86 |
| 3 | 0.0340 | 0.03 | 0.0156 | 2.17 |
| 4 | 0.0093 | 0.009 | 0.0039 | 2.39 |

Empirical MSE over 20,000 (rotation, vector) pairs matched the integral to four decimals, and the b = 2 centroids match the paper's ±0.453/√d and ±1.51/√d. The ratio climbs toward the Panter–Dite constant √3·π/2 ≈ 2.72, the abstract's "within 2.7×".

## MSE-optimal is biased for inner products

Attention doesn't need x̃ to be close to x. It needs ⟨q, x̃⟩ to be close to ⟨q, x⟩. An MSE-optimal quantizer shrinks its output. At b = 1 the codebook is ±√(2/(πd)), so the dequantized vector is a scaled sign pattern and E⟨y, x̃⟩ = (2/π)·⟨y, x⟩. The paper's fix is TurboQuant_prod. It spends b−1 bits on the MSE quantizer. The last bit goes to a 1-bit Quantized Johnson–Lindenstrauss sketch (QJL) of the residual, plus the residual's norm γ:

```python
def quant_prod(X, Pi, c_bm1, S):          # S: (d, d) iid N(0,1)
    xm = dequant_mse(quant_mse(X, Pi, c_bm1), Pi, c_bm1)
    r = X - xm
    return xm, np.sign(r @ S.T), np.linalg.norm(r, axis=1, keepdims=True)

def dequant_prod(xm, signs, gamma, S):
    d = S.shape[0]
    return xm + np.sqrt(np.pi / 2) / d * gamma * (signs @ S)
```

E[⟨y, sign(Sr)ᵀS⟩] = √(2/π)·d·⟨y, r̂⟩, so the QJL term is an unbiased estimate of ⟨y, r⟩. That makes the whole estimator unbiased. Theorem 2 bounds its error as D_prod ≤ (π/2d)·‖y‖²·D_mse(b−1) and lists the constants 1.57, 0.56, 0.18, 0.047 over d for b = 1–4.

**The b = 4 constant is wrong.** Plug in the paper's own b = 3 MSE. With the true value, (π/2)·0.0340 = 0.0534. You only get 0.047 from the *rounded* 0.03: (π/2)·0.03 = 0.0471. My simulation measured d·E[err²] = 0.0534 for prod at b = 4, so the published constant understates the error by 12%. The bound in the theorem is still correct. Only the table of constants is off.

## One scalar removes the bias, and it beats QJL

This is the finding that matters for practitioners. The Lloyd-Max centroid condition makes the quantization error orthogonal to the reconstruction on average: E⟨x − x̃, x̃⟩ = 0. Expand ‖x − x̃‖² and you get E⟨x, x̃⟩ = 1 − D_mse. Because Π is Haar-random, E_Π[x̃] has to be parallel to x. So

```
E[x̃] = (1 − D_mse) · x     ⇒     x̃ / (1 − D_mse) is unbiased.
```

No extra bits, no QJL matrix. The scalar comes from the codebook, and unbiasedness rests on the same global randomness as prod's (fixed Π versus fixed S). I measured all three estimators at d = 128 with ‖y‖ = 1 and the true ⟨y, x⟩ set to 0, 0.5, or 0.9. The table shows d·E[error²], with 20,000 samples per cell:

| b | MSE (biased) | MSE ÷ (1−D) | prod (paper) |
|---|---|---|---|
| 1 | 0.24 / 4.33 / 13.6 | 0.58 / 0.45 / 0.16 | 1.57 / 1.33 / 0.76 |
| 2 | 0.10 / 0.54 / 1.53 | 0.13 / 0.15 / 0.18 | 0.56 / 0.53 / 0.46 |
| 3 | 0.033 / 0.080 / 0.19 | 0.035 / 0.046 / 0.070 | 0.18 / 0.18 / 0.17 |
| 4 | 0.009 / 0.016 / 0.031 | 0.009 / 0.013 / 0.022 | 0.053 / 0.053 / 0.052 |

Debiased bias stays ≤ 0.0006 in magnitude, like prod's, and its error is 2.3–5.8× lower in every cell. Prod gives up one MSE bit, which roughly quadruples residual energy, then adds QJL noise with a π/2 penalty. Debiasing keeps all b bits and costs only a 1/(1 − D) variance inflation, 1.13× at b = 2.

Biased MSE wins only when ⟨y, x⟩ ≈ 0, which describes keys the query ignores anyway.

## What happens inside softmax

Inner-product error doesn't map one-to-one onto attention error, because softmax is not linear. To check, I placed one needle key with cosine 0.5 to the query among 4,096 random unit keys at d = 128. Logits were 2√d·⟨q, k⟩, which gives the exact needle weight ≈ 0.74. Only the keys were quantized. Each cell below averages 40 trials and reports the needle's weight, then the relative error of the attention output:

| b | MSE (biased) | MSE ÷ (1−D) | prod |
|---|---|---|---|
| 2 | 0.47 / 0.37 | 0.66 / 0.18 | 0.55 / 0.35 |
| 3 | 0.66 / 0.13 | 0.71 / 0.094 | 0.67 / 0.15 |
| 4 | 0.72 / 0.046 | 0.74 / 0.044 | 0.71 / 0.093 |

At b = 4, prod has twice the output error of the *plain biased* quantizer. Unbiased logits are not enough, because softmax turns logit variance into bias. Noise of variance σ² on the 4,095 distractor logits inflates their total mass by about e^(σ²/2). At b = 2, prod's logit variance is (2√d)²·0.56/d ≈ 2.2. That multiplies distractor mass by about 3 and predicts a needle weight of 1/(1 + 3·0.35) ≈ 0.48. The measured value was 0.55. Bias shrinks every logit by (1 − D), which flattens the softmax temperature. Variance pushes probability mass away from the peak. Of the three estimators, only the rescaled MSE keeps both effects small.

This doesn't contradict the paper's LongBench results, and the paper doesn't say which variant its KV experiments used. On Llama-3.1-8B-Instruct, 3.5 bits matches the full cache's 50.06. At 2.5 bits (32 outlier channels at 3 bits, 96 at 2) it scores 49.44, with summarization dropping from 26.55 to 24.80. My test suggests prod is the wrong choice for keys. It fits where constant error variance across ⟨y, x⟩ is the real requirement, as in their Figure 2.

## Practical takeaways

- **It's simple.** One rotation (a randomized Hadamard transform works in practice, in O(d log d)) plus a 16-entry table at 4 bits. Decoded tokens get the same treatment as the prefill. Indexing takes 0.0013 s at d = 1536, against 240 s for PQ.
- **Use Lloyd-Max centroids for the Beta distribution**, not uniform levels. Precompute them.
- **For attention keys, rescale MSE output by 1/(1 − D_b)** before reaching for QJL.
- **Check constants.** Theorem 2's b = 4 entry is off by 12%.

The paper's main contribution holds up: a data-oblivious vector quantizer whose distortion is within 1.44–2.7× of the information-theoretic limit, and that is cheap enough to run on every decoded token. The inner-product variant is the weaker part, and a one-line rescale does better.
