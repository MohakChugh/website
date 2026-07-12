---
title: "Muon: Orthogonalized Momentum and Why It Trains LLMs 2x Cheaper"
date: 2026-07-12
tags: [optimization, deep-learning, llm-training, linear-algebra, gpu]
excerpt: "AdamW treats every weight as a bag of scalars. Muon treats a weight matrix as a matrix, orthogonalizing the momentum update with a bf16 Newton-Schulz iteration. The result: roughly 2x the compute efficiency at scale, proven on a 16B-parameter MoE trained on 5.7T tokens."
---

For a decade, Adam and AdamW have been the default optimizer for essentially everything in deep learning. They are element-wise methods: each scalar parameter gets its own adaptive learning rate derived from the running first and second moments of its gradient. That framing quietly throws away structure. A transformer's hidden weights are not a bag of scalars, they are a matrix, and matrices have geometry, singular values, rank, condition number, that element-wise optimizers cannot see.

Muon (MomentUm Orthogonalized by Newton-Schulz), introduced by Keller Jordan in late 2024 and scaled to production LLMs by Moonshot AI in early 2025, exploits exactly that geometry. It is not an incremental Adam variant. It replaces the per-scalar adaptivity with a per-matrix operation: orthogonalize the momentum update before applying it. On the NanoGPT speedrun it cut training time 35 percent, and at scale it delivers roughly 2x the compute efficiency of AdamW.

## The problem: momentum updates are nearly low-rank

Consider a hidden weight matrix `W` of shape `(d_out, d_in)`. Under SGD with momentum, the update is a smoothed gradient matrix `M`. If you take the SVD `M = U Σ Vᵀ` and inspect the singular values, you find they decay fast. A handful of dominant directions carry almost all the Frobenius norm, and the update is effectively low-rank.

That is a problem. The dominant directions get updated aggressively while the "rare" directions, small in magnitude but often carrying genuinely new learning signal, are drowned out. Element-wise Adam does not fix this, because normalizing coordinate by coordinate has nothing to do with the *spectral* structure of the matrix.

Muon's answer is blunt: flatten the spectrum. Replace `M = U Σ Vᵀ` with `U Vᵀ`, i.e. set every non-zero singular value to 1. This is the nearest semi-orthogonal matrix to `M` (the solution to the orthogonal Procrustes problem). Every direction now contributes equally, and the geometry of the update no longer collapses onto a few axes.

## Doing an SVD without an SVD

Computing an SVD every step for every matrix in a large model would be catastrophically slow and numerically awkward on GPUs. Muon never computes one. It approximates `U Vᵀ` with a **Newton-Schulz iteration**: a fixed-point scheme that drives all singular values toward 1 while leaving the singular *vectors* untouched.

The iteration applies an odd matrix polynomial repeatedly. Because it is odd, `φ(M) = a·M + b·(MMᵀ)M + c·(MMᵀ)²M` acts on `M`'s singular values exactly as the scalar polynomial `φ(x) = ax + bx³ + cx⁵` acts on each `σᵢ`, without disturbing `U` and `V`. Pick coefficients so `φ` has a stable fixed point at 1, normalize the input so all singular values start inside the basin of attraction, and iterate.

```python
def newton_schulz(M, steps=5, eps=1e-7):
    # Coefficients tuned so the quintic has an attracting fixed point at 1
    # and converges fast even for tiny singular values.
    a, b, c = 3.4445, -4.7750, 2.0315
    X = M.bfloat16()
    X = X / (X.norm() + eps)          # scale so max singular value <= 1

    transpose = X.size(0) > X.size(1)  # iterate on the smaller side
    if transpose:
        X = X.T
    for _ in range(steps):
        A = X @ X.T
        B = b * A + c * (A @ A)
        X = a * X + B @ X
    if transpose:
        X = X.T
    return X
```

Two details make this practical. First, it runs in **bf16** without diverging, so it costs almost nothing on tensor cores. Second, the tuned coefficients `(3.4445, -4.7750, 2.0315)` deliberately over-shoot near zero (large `a`) so that small singular values are pulled up quickly. The output is not perfectly orthogonal, singular values land somewhere in roughly `[0.7, 1.3]`, but that tolerance is fine; the loss curve is insensitive to it. Five iterations is the standard budget.

The full Muon step for a 2D parameter:

```python
def muon_step(W, grad, momentum_buf, lr, mu=0.95):
    momentum_buf.mul_(mu).add_(grad)              # heavy-ball momentum
    update = grad.add(momentum_buf, alpha=mu)     # Nesterov-style lookahead
    O = newton_schulz(update, steps=5)            # orthogonalize
    scale = 0.2 * (max(W.size(0), W.size(1)) ** 0.5)  # match AdamW update RMS
    W.sub_(O, alpha=lr * scale)
```

The FLOP overhead of the Newton-Schulz iterations is tiny: bounded by `T·m/B` where `T` is the iteration count, `m` the model dimension, and `B` the batch size in tokens. In practice under 1 percent, about 0.7 percent for NanoGPT and an estimated 0.5 percent for a 405B model.

## What Muon does *not* touch

Muon is a matrix optimizer, so it only applies to 2D hidden weights (convolutional filters are flattened to 2D). Everything that is not a hidden matrix stays on AdamW:

- **Embeddings** and the **final classifier head**. These behave more like lookup tables / logits than linear maps; orthogonalizing them empirically hurts.
- **Scalars and vectors**: biases, LayerNorm gains, RMSNorm weights.

A subtlety worth knowing: for attention, apply Muon to Q, K, V **separately** rather than to a fused QKV matrix. The fused matrix's block structure makes a single orthogonalization the wrong operation.

## Making it scale: the two fixes from Moonlight

Muon looked great on 100M-scale models, but two things had to be added before it worked "out of the box" on billion-parameter LLMs. Moonshot's *Muon is Scalable for LLM Training* paper identified both.

**1. Weight decay.** Plain Muon lets weight and update norms grow unbounded over a long run, eventually pushing activations past the bf16 range. Standard decoupled weight decay (AdamW-style) fixes it:

```python
W.mul_(1 - lr * weight_decay)   # decoupled decay, applied before the update
W.sub_(O, alpha=lr * scale)
```

**2. Per-parameter update-scale matching.** An orthogonalized matrix has a fixed RMS (its Frobenius norm is `sqrt(rank)`), which is unrelated to what AdamW would have produced for that same tensor. Without correction, different-shaped matrices get wildly inconsistent effective learning rates, and you cannot reuse AdamW-tuned hyperparameters. The fix scales each update by roughly `0.2 · sqrt(max(d_in, d_out))` so its RMS matches the update AdamW would have applied. That is the single line that makes Muon's learning rate and weight decay transferable, no per-model tuning.

With those two additions, Moonshot trained **Moonlight**, a Mixture-of-Experts model with **3B activated / 16B total parameters** on **5.7 trillion tokens**, entirely with Muon. Their scaling-law study shows Muon reaching a given loss with about **half the training FLOPs** of AdamW under compute-optimal conditions, and Moonlight pushes the performance-per-FLOP Pareto frontier ahead of comparable AdamW-trained models.

## Distributed Muon

There is one genuine systems wrinkle. AdamW is embarrassingly parallel: its state is element-wise, so under ZeRO/FSDP sharding each device just updates its own slice. Muon is not, because Newton-Schulz needs the **whole matrix** to compute `M Mᵀ`. A naive implementation would gather every sharded weight to one device, orthogonalize, and scatter, blowing up both memory and communication.

Moonshot's distributed Muon keeps the optimizer state sharded like ZeRO-1 but gathers only the momentum of one matrix at a time to perform the iteration, then redistributes. They describe it as memory-optimal and communication-efficient: the extra all-gather traffic is a small constant relative to the gradient all-reduce already happening, and no single device ever has to hold the full model's optimizer state.

## Why this matters

Muon is a reminder that the abstractions we optimize over are a choice. Treating a weight matrix as `d_in · d_out` independent scalars was always a convenient fiction; the matrix has spectral structure, and an optimizer that respects it can extract signal element-wise methods discard. The Newton-Schulz trick is what makes the idea cheap enough to be free, five bf16 matmuls hidden under 1 percent of step time.

The practical takeaway for anyone training models: Muon is not exotic anymore. It is roughly 20 lines on top of an SGD-momentum loop, it reuses AdamW's learning rate and weight decay once you add the RMS-matching scale, and at scale it is close to a 2x efficiency win. The main gotchas are remembering to keep embeddings, the head, and all 1D parameters on AdamW, and using a distributed implementation that orthogonalizes one matrix at a time rather than gathering the whole model. For a change this small, halving your training bill is an unusually good trade.
