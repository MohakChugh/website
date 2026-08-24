---
title: "Why Your Learning Rate Doesn't Transfer: μP, Unit Scaling, and the abc-Symmetry"
date: 2026-08-24
tags: [machine-learning, llm-training, optimization, numerical-precision, scaling-laws]
excerpt: "Every time you widen a transformer, your tuned learning rate becomes wrong. Not slightly wrong: the optimum drifts as 1/width, which is why teams re-sweep hyperparameters at every scale and burn compute discovering the same curve shifted left. The Maximal Update Parametrization fixes this, and a 2024 refinement called u-μP fixes μP's own residual problem: the constants are all wrong for FP8."
---

Here is an experiment you can run in thirty lines of numpy. Take a three-layer MLP: a fixed-size input projection, one square hidden layer of width *n*, and a scalar readout. Initialize everything the standard way (variance 1/fan_in), train four Adam steps at the same learning rate, and measure the mean absolute value of the network output at widths 128 through 8192.

```
standard parametrization   |output| after 4 Adam steps
  width  128 :   0.87
  width  512 :   2.64
  width 2048 :   7.40
  width 8192 : 341.78
```

At initialization all four widths produce outputs of the same magnitude, around 0.15–0.6. The divergence appears only *after* updates. That is the whole problem: the learning rate that was stable at 128 is catastrophic at 8192, so you re-tune at every scale, forever.

Now change three things — the hidden layer's learning rate, the readout's initialization variance, and a forward multiplier on the readout — and re-run:

```
maximal update parametrization
  width  128 :   0.87
  width  512 :   0.88
  width 2048 :   0.87
  width 8192 :   0.90
```

Flat. That is μP, the Maximal Update Parametrization from Greg Yang and Edward Hu's *Tensor Programs V* (NeurIPS 2021), and the reason it works comes down to one asymmetry that is easy to state and easy to miss.

## Θ(n) versus Θ(√n)

Consider a preactivation coordinate: a sum of *n* terms, each a weight times an incoming activation. How big is that sum?

If the weight matrix has iid entries — which is exactly what your initializer produces — the terms are uncorrelated and the sum grows like √n. That is why init variance 1/fan_in (i.e. entries of scale 1/√n) gives you Θ(1) preactivations. Everybody knows this part.

But the weight matrix *after* an update is not iid. A gradient is an outer product of activations and backpropagated errors, so its entries are correlated with the very activations they will multiply on the next forward pass. For a correlated matrix, the sum of *n* terms grows like **n**, not √n. And Adam makes this worse in the cleanest possible way: because it normalizes by the gradient's second moment, every entry of the update has magnitude ≈ η regardless of gradient scale. So an Adam step writes a Θ(η)-magnitude, activation-correlated matrix into your weights, and the resulting preactivation drift is Θ(nη).

Two regimes, two scaling laws. That is the whole story: **initialization wants 1/√fan_in, and Adam learning rates want 1/fan_in.** Standard parametrization applies the first rule and forgets the second, which is why the table above explodes.

## The abc-parametrization

μP is expressed in a three-multiplier form. Every weight tensor *W* gets a forward multiplier *A*, an init scale *B*, and an LR scale *C*:

```
w₀ ~ 𝒩(0, B²)                             # initialization
W_t = A · w_t                               # what the forward pass actually uses
w_{t+1} = w_t + C · Φ(∇ℒ₀ … ∇ℒ_t)         # Φ = the optimizer (Adam here)
```

Weights are then classified by how their fans depend on width. *Hidden* weights have both fan-in and fan-out scaling with width; *input* weights (embeddings) only fan-out; *output* weights (the readout) only fan-in. μP's width-dependent factors:

| factor | input | hidden | output |
|---|---|---|---|
| forward *a* | 1 | 1 | 1 / fan_in |
| init *b* | 1 | 1 / √fan_in | 1 |
| Adam LR *c* | 1 | 1 / fan_in | 1 |

Read the hidden column against the Θ(n) argument above and it is just the two scaling laws side by side. Read the output column and note something subtle: the readout's *init* is width-independent (b = 1), because its job is to keep the output O(1) while every hidden coordinate is already Θ(1) — and the 1/fan_in forward multiplier does that. In practice most implementations zero-initialize the readout instead, which is cleaner.

Three desiderata uniquely pin this down: preactivation coordinates stay Θ(1), the output stays O(1), and every parameter is updated as aggressively as possible without divergence. That last clause is where "maximal" comes from — μP is not merely *a* stable parametrization, it is the stable one that doesn't waste any layer's capacity to learn.

## The coordinate check

μP has a diagnostic as mechanical as gradient checking, and you should treat it as a required unit test. Log `x.abs().mean()` for every activation tensor across several widths and a handful of steps, then plot against width. Correct μP gives horizontal lines. Incorrect μP gives curves that blow up or collapse.

```python
if param == "mup":
    W3 = rng.standard_normal((n, 1)) / np.sqrt(base)   # width-independent readout init
    out_mult = base / n                                # a_W = 1/fan_in
    lrs = [lr, lr * base / n, lr]                      # c_W = 1/fan_in, hidden only
else:
    W3 = rng.standard_normal((n, 1)) / np.sqrt(n)
    out_mult, lrs = 1.0, [lr, lr, lr]
```

Two practical notes. Use a *larger* learning rate than usual — exploding coordinates show up sooner. And expect one benign exception: the readout output legitimately shrinks like 1/√width *at initialization* (my run: 0.26 → 0.14 → 0.15 → 0.057), flattening after the first few steps. Attention logits do the same. Zero-init the readout and the query projection and the exception disappears.

A free smell test: if a wider model ever has *worse* training loss than a narrower one at the same step, your parametrization is wrong. Correct μP improves monotonically in width.

The payoff is μTransfer — tune a small proxy, transfer zero-shot. The original paper tuned a 40M proxy and beat published 6.7B GPT-3 numbers for 7% of pretraining cost.

## u-μP: μP has the right exponents and the wrong constants

μP fixes how things scale. It says nothing about *absolute* magnitudes — and once you train in FP8, absolute magnitudes are the whole game. E4M3 has roughly ±240 dynamic range on one side and denormals on the other; a tensor sitting at scale 2⁻⁵ or 2⁶ is silently throwing away mantissa bits.

*u-μP: The Unit-Scaled Maximal Update Parametrization* (Blake et al., arXiv:2407.17465, latest revision January 2025) merges μP with Unit Scaling, whose goal is that activations, weights, and gradients all begin training at scale 1. The two turn out to be complementary, and the mechanism for combining them is elegant.

μP has an **abc-symmetry**: for any θ > 0, the transformation

```
A ← A·θ,   B ← B/θ,   C ← C/θ
```

leaves the network's Adam behavior unchanged. So you can move scale between the forward multiplier and the weights for free. Take μP's hidden rule (A = 1, B = 1/√fan_in, C = η/fan_in) and shift by θ = √fan_in:

```
A = 1/√fan_in,   B = 1,   C = η/√fan_in
```

Identical training dynamics — but now every weight tensor is initialized at unit scale, and the 1/√fan_in factor lives in the matmul, which is precisely where Unit Scaling wants it. That single symmetry argument is the paper's central move.

The rest is hyperparameter hygiene. μP leaves you with σ_init, α_attn, α_out, base_width, and base_depth on top of the LR. u-μP eliminates base-shape hyperparameters entirely (there is no base width when everything is unit-scaled) and replaces the weight-attached multipliers with a small set attached to *operations*: α_attn_softmax (the inverse softmax temperature for unit-scale inputs), α_ffn_act, α_res, α_res_attn_ratio (the attention-versus-FFN branch balance), α_loss_softmax. Every one has an interpretable meaning, and every non-LR default is **1**.

That last fact is the practical headline. Because the defaults are near-optimal, sweeping the learning rate alone — nine runs — lands you at near-optimal loss, against the low hundreds of runs typical in the literature. Transfer quality also improves: μP shows a transfer error of 0.03 across the width sweep, u-μP 0.005. Their 2048-width u-μP model matches a 4096-width μP model.

For FP8 they classify tensors: Q/K/V and FFN input matmuls run natively (E4M3 forward, E5M2 for output gradients), while *critical* tensors — attention dense-projection inputs, the final FFN matmul, the decoder head weights — stay high-precision, with optimizer state in FP32. About 70% of transformer-block matmul FLOPs end up native FP8. At 7B on 300B tokens, u-μP in BF16 and FP8 both hold or beat a standard-parametrization BF16 baseline on zero-shot evals (HellaSwag 53.4 vs 52.4; PIQA 77.1/77.6 vs 76.5).

## What to actually do

Three gotchas that bite people. Transfer breaks unless your norms are parameter-free (drop the learnable gain in RMSNorm) and your AdamW weight decay is *independent* of the learning rate — coupled decay silently reintroduces width dependence. Attention should use 1/d logit scaling, not 1/√d, once queries and keys are μP-scaled. And u-μP found empirically that embedding LR wants c = 1/√fan_out rather than constant, for which the authors honestly offer no theory.

The deeper lesson generalizes past width. A parametrization is a claim about which quantities stay invariant as you scale, and the coordinate check is how you falsify that claim in five minutes instead of five thousand GPU-hours. If you are scaling any axis — width, depth, batch size, precision — write down the invariant first, then measure whether it holds.
