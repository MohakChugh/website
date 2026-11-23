---
title: "AdEMAMix, Audited: The Slow EMA Is a 9× Learning Rate Below ηh = 1−β3, a 1× One Above It, and a 4.8× Spike When Gradients Shrink"
date: 2026-11-23
tags: [optimizers, llm-training, momentum, adam, deep-learning]
excerpt: "AdEMAMix adds a second, very slow momentum buffer to Adam (β3 = 0.9999, weighted by α = 8). I checked its formulas and modeled it as a linear filter. The half-life numbers and the β3-scheduler derivation are exact. The update noise rises only 4.5% while the step on persistent gradients grows 9×. On a quadratic, AdEMAMix converges 9.9× faster in low-curvature directions. The advantage is exactly 1.00× at ηh = 1−β3 and turns into a small slow tail above it. The noise floor matches Adam at 9× the learning rate in flat directions but rises only 2–9% in stiff ones. The stability edge barely moves (38 → 37.7). The failure mode is different: a 10× drop in gradient scale makes the normalized update spike to 4.8× its steady value, about 6,000 steps later."
---

Adam's first moment is an exponential moving average (EMA) of gradients, and β1 sets one trade-off: how much weight the recent past gets versus the distant past. *The AdEMAMix Optimizer: Better, Faster, Older* (Pagliardini, Ablin, Grangier, arXiv:2409.03137) argues that no single β handles both, and it adds a second EMA:

```python
# AdEMAMix step (per parameter), following Alg. 1 of the paper
m1 = b1 * m1 + (1 - b1) * g          # fast EMA, b1 = 0.9, bias-corrected
m2 = b3 * m2 + (1 - b3) * g          # slow EMA, b3 = 0.9999, NOT bias-corrected
v  = b2 * v  + (1 - b2) * g * g      # b2 = 0.999
update = (m1 / (1 - b1**t) + alpha * m2) / (sqrt(v / (1 - b2**t)) + eps)
theta -= lr * (update + wd * theta)
```

The headline result: a 1.3B model trained on 101B tokens matches AdamW trained on 197B tokens, because "gradients can stay relevant for tens of thousands of steps." I didn't reproduce the LLM runs. I checked the arithmetic, then modeled AdEMAMix as a linear filter on a noisy quadratic. All numbers come from ~150 lines of numpy/scipy.

## The formulas check out

- **Half-life.** The paper defines t_half = ln(0.5)/ln(β) − 1, the number of past gradients that carry half the EMA's weight. For β = 0.9999 that gives **6,930.1**, matching the paper's "≈ 6,930". The 90%-mass window is **23,025 steps**, so "tens of thousands" is fair.
- **Sensitivity.** 0.999 → 0.9991 adds **77.02** steps of half-life (paper: 77); the same δβ at 0.9 adds 0.007, hence no linear β3 ramp.
- **The β3 scheduler.** Appendix A.1 interpolates the half-life linearly; the "−1" in f(β) cancels exactly, leaving `β(μ) = exp(ln βs · ln βe / ((1−μ) ln βe + μ ln βs))`. That is the paper's formula, and it is linear in 1/ln β. Evaluated at μ = 0, ¼, ½, ¾, 1 with βs = 0.9 and βe = 0.9999, the half-lives are 5.6, 1,736.7, 3,467.9, 5,199.0 and 6,930.1, which is linear to the decimal.

## Why adding α·m2 is almost free in noise

Split a gradient coordinate into a persistent part μ and white noise of variance σ². In steady state, an EMA with parameter β has variance σ²(1−β)/(1+β), and two EMAs of the same noise have covariance σ²(1−β1)(1−β3)/(1−β1β3):

```
Var(m1)            = 0.05263 σ²
Var(m2)            = 0.00005 σ²
Cov(m1, m2)        = 0.00010 σ²
Var(m1 + 8·m2)     = 0.05743 σ²     → noise std up 4.5%
Mean(m1 + 8·m2)    = 9 μ            → signal up 9×
```

The slow buffer averages ~20,000 samples, so its noise nearly vanishes while its DC gain stays 1. Scaling it by α = 8 raises the persistent part of the step 9× and the noise 4.5%. "Old gradients stay relevant" and "persistent directions get a much larger learning rate" describe the same filter.

## The quadratic model: a learning rate that depends on curvature

Take one eigendirection of a quadratic, freeze √v̂, and write k = η·h. Each step is a 3×3 linear map on (x, m1, m2); its spectral radius gives the convergence rate and a discrete Lyapunov solve the noise floor:

```python
def A_mat(k, alpha, b1=0.9, b3=0.9999):
    A = np.zeros((3, 3))
    A[1] = [1 - b1, b1, 0]           # m1' = b1 m1 + (1-b1) g,  g = h x
    A[2] = [1 - b3, 0, b3]           # m2' = b3 m2 + (1-b3) g
    A[0] = [1, 0, 0] - k * (A[1] + alpha * A[2])
    return A
```

With ε = 1 − β3 = 10⁻⁴, α = 8, baseline Adam β1 = 0.9:

| k / ε | Adam rate | AdEMAMix rate | ratio | oscillatory? |
|---|---|---|---|---|
| 0.01 | 1.0e-6 | 9.9e-6 | **9.88×** | no |
| 0.03 | 3.0e-6 | 5.2e-5 | **17.2×** | yes (≈ critical damping) |
| 0.3 | 3.0e-5 | 6.5e-5 | 2.17× | yes |
| 1 | 1.0e-4 | 1.0e-4 | **1.00×** | yes |
| 10 | 1.0e-3 | 5.5e-4 | 0.55× | yes |
| 1000 | 5.3e-2 | 9.0e-4 | 0.02× | no |

The crossover sits at **k = 0.998ε**. The continuous-time characteristic polynomial λ² + (k+ε)λ + kε(1+α) predicts every regime:

- **k ≪ ε (flat directions):** one root is ≈ −k(1+α), a straight **9× speedup**.
- **Oscillation band:** complex roots when k/ε ∈ [(√(1+α)−√α)², (√(1+α)+√α)²] = **[0.029, 34.0]**. The numerical eigenvalues switch at exactly those limits.
- **k ≫ ε (stiff directions):** the fast mode still decays at ≈ k, as in Adam. A second mode decays at ε(1+α) = 9×10⁻⁴ per step. That is the 0.02× row.

The stiff-direction "slowdown" is real but small: the slow mode carries a stale-momentum offset of about αε/k of the initial error, 0.8% at k = 1000ε. Reaching |x| < 10⁻³ from x₀ = 1 takes 2,310 steps instead of 123 because that tail sits just above the tolerance, but in loss terms it's a 6×10⁻⁵ residual. Flat directions limit time-to-loss in ill-conditioned training, and those get the 9×.

The noise floor, E[x²]/σ² at stationarity:

| k / ε | AdEMAMix vs Adam | Adam at 9× LR vs Adam |
|---|---|---|
| 0.01 | 8.92× | 9.00× |
| 1 | 5.01× | 9.00× |
| 100 | **1.09×** | 9.02× |
| 10⁴ | **1.02×** | 11.5× |

This is the real argument over "just raise the learning rate": flat directions behave like Adam at 9× LR (same speed, same noise), stiff ones like Adam at 1×. **The learning rate is frequency-selective, with 1−β3 as the cutoff.** The linear stability edge barely moves: the largest stable k is 38.0 for Adam and 37.7 for α = 8.

## What the schedulers actually do

The paper fixes early divergence with linear warmups of α and of β3's half-life over the full run (Tα,β3 = T). The linear model can't explain the divergence, since the stability edge doesn't move. Two other effects can.

**1. Without schedulers, the missing bias correction acts as a 9× learning-rate warmup.** Because m2 is not bias-corrected, its mass after t steps is 1 − β3ᵗ: **9.5%** at 1k steps, **39%** at 5k, **90%** at 23k. On a persistent gradient the update magnitude is 1.76× at 1k steps, 6.06× at 10k, 8.20× at 23k and 8.85× at 40k. The paper describes the missing correction as letting the buffer "fill itself slowly." Read that way, it is an implicit 23k-step warmup of the effective learning rate on flat directions, from 1× to 9×.

**2. With schedulers, the effective schedule is no longer cosine.** When β3 starts at β1 = 0.9, m2 is fully filled almost at once (mass 0.9999 by step 100), so α(t) = αt/T sets the boost. With cosine decay to 10⁻⁵ from a peak of 3×10⁻⁴, the DC learning rate η(t)·(1 + α(t)) **peaks at 2.81× Adam's peak, 37.5% of the way through training**. Integrated over the run it is **3.48×** Adam's. In persistent directions, a scheduled AdEMAMix run is effectively a different learning-rate schedule: warmup, then decay, peaking near ⅜ of the run. The authors tuned η for both optimizers and the gap persists under a constant LR (their Fig. 3b), so the comparison stands, but "same η" is not "same step size."

## The failure mode: β3 ≫ β2

The denominator √v̂ uses β2 = 0.999, a half-life of 693 steps. The slow numerator has a half-life of 6,930. When the gradient scale drops, v̂ adapts ten times faster than m2, so the normalized slow term grows. I simulated a persistent gradient whose magnitude drops 10× at step 30,000:

```
Adam (α=0):  update stays ≤ 1.00
AdEMAMix:    steady 8.60 → peak 41.6 at +6,247 steps → 12.4 at +30k
```

That is a **4.8× overshoot**, peaking ~6k steps after the event. Gradient scale drops 10×+ in the first few thousand steps of LLM training, exactly where the paper saw divergence; the schedulers dodge it by keeping β3 near β1 early. The same mismatch can return on a data-mixture switch or after a loss spike. The paper's finding that schedulers are unneeded when AdEMAMix starts mid-run (Fig. 5) fits: by then gradient scale has settled.

## Practical reading

- **α is a flat-direction LR multiplier; 1−β3 defines "flat."** Directions with η·h/√v̂ below 1−β3 get (1+α)×; above it, ~1× plus a small tail.
- **Fair AdamW baselines must sweep past the effective DC rate** (~3.5× at equal η when scheduled). AdEMAMix needing a lower η (3–5×10⁻⁴) at 1.3B is consistent with this.
- **Watch the β3/β2 gap.** For late instability, look for a gradient-scale shift first; update clipping or raising β2 toward β3 targets the mechanism.
- **β1 = 0 recovers AdamW's memory** but leaves the fast branch unsmoothed: noise 0.053σ² → 1σ², ~4.4× update std, hence "potentially less stable."

**Caveats.** A frozen-preconditioner quadratic explains mechanics, not nonconvex wins; I didn't test the 95% token claim, and the scheduler/drop runs use one stylized coordinate.
