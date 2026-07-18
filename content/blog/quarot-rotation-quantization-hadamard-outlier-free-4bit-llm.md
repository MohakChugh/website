---
title: "QuaRot: Rotating Away the Outliers That Make 4-Bit LLMs Impossible"
date: 2026-07-18
tags: [quantization, llm-inference, hadamard-transform, gpu, efficiency]
excerpt: The reason you cannot naively quantize an LLM to 4 bits is a handful of activation channels with values 100x larger than the rest. QuaRot (2024) makes those outliers disappear by multiplying the network with random orthogonal rotations that leave the output identical but flatten the value distribution. Here is why an orthogonal matrix is free, why Hadamard matrices make it fast, and how the whole forward pass ends up in INT4.
---

## The outlier problem, stated precisely

Uniform integer quantization is brutally simple. To store a tensor `X` in `b` bits, you compute a scale `s = max(|X|) / (2^(b-1) - 1)`, then round `X/s` to the nearest integer. Dequantize by multiplying back by `s`. Everything hinges on that `max(|X|)` term: it sets the size of every quantization bucket. If the largest magnitude in the tensor is 100 and you have 15 representable levels (INT4, signed), each bucket spans ~6.7 units. A value of 0.3 and a value of 6.9 land in the same bucket.

Weights in a trained transformer are well-behaved — roughly Gaussian, no dramatic outliers. **Activations are not.** Since the discovery documented in LLM.int8() and SmoothQuant, we have known that transformer activations contain *systematic outlier channels*: specific feature dimensions where values are 10–100x larger than the median, appearing consistently across tokens and correlated with the most important features. A 4096-dimensional hidden state might have four or five channels dominating the dynamic range.

Those channels poison quantization. The scale `s` is set by the outliers, so the other 4091 channels get crushed into a handful of buckets and lose almost all their information. This is why the standard playbook was *mixed precision*: keep outlier channels in FP16, quantize the rest to INT8, and eat the overhead of the split. Getting to a clean, uniform INT4 — where every matmul, every activation, and the KV cache are 4-bit — was considered out of reach without expensive calibration or quantization-aware training.

QuaRot's move is to attack the coordinate system instead of the numbers.

## Computational invariance: rotation is free

Consider a linear layer `Y = XW`. Insert an orthogonal matrix `Q` (meaning `QQᵀ = I`) and its transpose:

```
Y = X W = X (Q Qᵀ) W = (X Q)(Qᵀ W)
```

The output is *bit-for-bit identical*. But the tensors you actually quantize have changed. Instead of quantizing `X`, you quantize `X' = XQ`. Instead of `W`, you quantize `W' = QᵀW`. If `Q` is a well-chosen rotation, `X'` has no outliers even though `X` did.

This is what the paper calls **computational invariance**: you can rotate the representation inside the network without changing what the network computes, as long as you counter-rotate on the other side of each matmul. The rotated weights `QᵀW` are computed *once, offline*, and stored. There is no runtime cost to the weight side at all.

Why does rotation kill outliers? An outlier is energy concentrated in one coordinate. A random rotation spreads that energy across all coordinates — the same reason a random projection makes a spiky vector look Gaussian (Johnson–Lindenstrauss intuition). Formally, quantization difficulty is governed by *incoherence*: the ratio of the max absolute entry to the Frobenius norm. Rotating by a random orthogonal matrix drives the expected maximum entry down toward `‖X‖_F · sqrt(log n / n)`, so the peak-to-average ratio collapses and a uniform grid suddenly fits.

## Where the rotations go in a transformer

A transformer is not a single matmul, so QuaRot places rotations at two kinds of boundaries.

**Residual-stream rotations (fused into weights).** The residual stream is the highway that every block reads from and writes to. QuaRot picks one global rotation `Q` and applies it to the entire residual path. Because `Q` and `Qᵀ` can be absorbed into the input projections (`W_q`, `W_k`, `W_v`, the MLP up-projection) and output projections (attention out-proj, MLP down-projection) of every block, plus the embedding matrix and the final LM head, the rotation *never appears at runtime*. It is baked into the weights. RMSNorm's scale parameter has to be folded into the adjacent linear first so the normalization commutes with the rotation, but that is a standard algebraic rewrite.

**Online rotations (applied at inference).** Some tensors sit *between* two operations you cannot fuse across — most importantly the input to the MLP down-projection (after the nonlinearity) and the value/output path inside attention. Here QuaRot inserts a rotation that must actually run during the forward pass. This is where the choice of matrix matters enormously.

## Hadamard matrices: orthogonal *and* fast

A generic `n × n` rotation costs `O(n²)` — as expensive as the matmul you were trying to make cheap. QuaRot instead uses **Hadamard matrices**, which are orthogonal matrices whose entries are all `±1/sqrt(n)`. The Walsh–Hadamard transform has a recursive butterfly structure identical to the FFT:

```
H_1 = [1]

H_2n = (1/sqrt 2) * [ H_n   H_n ]
                    [ H_n  -H_n ]
```

That structure means you can apply `H` to a vector in `O(n log n)` time with no multiplies — only additions and subtractions and one final scale. For a 4096-dim hidden state that is ~12 add/sub passes instead of 16.7 million multiply-accumulates. The online rotation becomes a rounding error in the latency budget, and it can be written as a single fused CUDA kernel.

Here is the fast Walsh–Hadamard transform that the online rotation reduces to, in plain terms:

```python
import numpy as np

def fwht(x):
    """In-place fast Walsh-Hadamard transform. len(x) must be a power of 2."""
    x = x.astype(np.float64).copy()
    n = len(x)
    h = 1
    while h < n:
        for i in range(0, n, h * 2):
            for j in range(i, i + h):
                a, b = x[j], x[j + h]
                x[j], x[j + h] = a + b, a - b   # butterfly: only +/-
        h *= 2
    return x / np.sqrt(n)   # orthonormal scaling

# Demonstrate outlier suppression
rng = np.random.default_rng(0)
v = rng.standard_normal(1024)
v[7] = 60.0                       # inject a massive outlier channel
before = np.abs(v).max() / np.linalg.norm(v)
after  = np.abs(fwht(v)).max() / np.linalg.norm(v)
print(f"incoherence before: {before:.3f}")   # ~0.86 dominated by one channel
print(f"incoherence after:  {after:.3f}")    # ~0.09 spread out, quantizable
```

The incoherence ratio drops by roughly an order of magnitude, which is exactly the peak-to-average reduction that lets a uniform INT4 grid represent the tensor without destroying the small values.

When `n` is not a clean power of two, QuaRot uses a *randomized* Hadamard — a Hadamard matrix times a random diagonal sign matrix `diag(±1)` — or Kronecker-factorizes it so the transform still runs in near-linear time. The random signs matter: a plain Hadamard has a fixed pattern that an adversarial activation distribution could align with, whereas the random diagonal guarantees the incoherence bound in expectation regardless of the input.

## Quantizing the KV cache

The KV cache is the other place 4-bit matters, because it dominates memory at long context lengths. QuaRot rotates the keys and values with a Hadamard transform *before* they are written to the cache. Since the query–key dot product `q·k` is invariant under a shared rotation (`(qH)·(kH) = q·(HHᵀ)·k = q·k`), attention scores are unchanged, and the cache entries themselves become outlier-free and quantize cleanly to INT4. This is what turns "4-bit weights and activations" into genuinely *end-to-end* 4-bit inference: the cache, historically the hardest tensor to compress because it is written incrementally and read every step, gets the same treatment for free.

## What it buys, and what it costs

The headline result: LLaMA-2-70B quantized fully to 4 bits — weights, activations, and KV cache — loses at most **0.47 perplexity** on WikiText-2 and retains ~99% of zero-shot accuracy, with *no calibration data and no retraining*, using plain round-to-nearest. Because every matmul input is genuinely INT4, the model can run on INT4 tensor-core paths, roughly halving memory bandwidth versus INT8 and cutting it 4x versus FP16. At 6 and 8 bits QuaRot is effectively lossless.

The honest caveats:

- **The online Hadamard is not literally free.** It adds a kernel per rotated boundary. On memory-bound decode it hides well; on compute-bound prefill it is measurable, though small.
- **Layout constraints.** Hadamard sizes want powers of two; head dimensions and intermediate sizes that are not clean powers of two require the Kronecker/randomized construction, which complicates the kernel.
- **RMSNorm folding assumes a specific normalization placement.** Architectures that deviate (some norm variants, certain positional schemes) need the algebra reworked before the residual rotation can be fused.

The deeper lesson is worth internalizing beyond quantization. Outliers were never a property of the *information* in the activations — they were a property of the *basis* the network happened to learn in. The values that looked un-quantizable were one orthogonal change of coordinates away from being trivial. QuaRot, and the SpinQuant line of work that learns the rotation instead of fixing it, are really saying: before you throw precision at a hard tensor, check whether you are just looking at it in the wrong coordinate system. A rotation that costs `O(n log n)` and changes nothing about what the model computes can be the difference between INT4 being a research curiosity and being the default.
