---
title: "Stochastic Rounding for Pure-BF16 Training, Audited: Weight Decay Is a No-Op Without It, Adam's β2 = 0.999 Becomes a Ratchet, and a Convergence Floor That Ignores β2"
date: 2026-11-22
tags: [low-precision-training, bf16, stochastic-rounding, optimizers, llm-training]
excerpt: "Ozkara, Yu and Park (AISTATS 2025) train GPT-Neo up to 6.7B with every tensor in BF16 and stochastic rounding. They beat FP32-master mixed precision on perplexity, with up to 1.54× throughput. I reimplemented BF16 rounding at the bit level and checked the mechanics. Under round-to-nearest, decoupled weight decay at lr·λ = 7e-5 changes 100.000% of weights by exactly nothing. 69–85% of N(0, 0.02) weights freeze at the end of a cosine schedule with the paper's default learning rates. For any β2 above 1 − 2⁻⁹ = 0.99805, Adam's second moment can never decrease, which leaves it 16.6× too high after a gradient-scale drop. The paper's Adam bound has a quantization floor of about R·d·L·Δ for every β2."
---

Mixed precision keeps an FP32 master copy of every weight because BF16 has 8 significant bits. A weight near 0.05 sits on a grid spaced 2⁻¹² ≈ 2.4e-4, so round-to-nearest (RNE) discards an Adam step of 1e-4.

*Stochastic Rounding for LLM Training: Theory and Practice* (Ozkara, Yu, Park; arXiv:2502.20566, AISTATS 2025) keeps weights, gradients, m and v all in BF16 and applies stochastic rounding (SR) to the update: round up with probability equal to the fractional distance to the upper neighbour, so E[Q(x)] = x. Table 1 (validation perplexity):

| Model | SR | MP (FP32 master) | BF16 RNE |
|---|---|---|---|
| GPT-2 350M | 14.07 | 14.45 | 16.38 |
| GPT-2 770M | 12.63 | 12.83 | 15.28 |
| GPT-Neo 1.3B | 10.46 | 10.48 | 11.81 |
| GPT-Neo 2.7B | 10.22 | 10.31 | 11.67 |
| GPT-Neo 6.7B | 10.05 | 10.11 | 11.64 |

Throughput gains grow from 1.07× (350M) to 1.54× (6.7B). I implemented BF16 RNE and SR at the bit level and tested each mechanism.

## Stochastic rounding is a 16-bit dither

The paper implements SR the standard way: upcast to FP32, add uniform noise to the 16 mantissa bits that BF16 discards, then truncate. In NumPy:

```python
def rne(x):  # FP32 -> BF16, round-to-nearest-even
    b = np.asarray(x, np.float32).view(np.uint32).copy()
    b = b + np.uint32(0x7FFF) + ((b >> 16) & np.uint32(1))
    return (b & np.uint32(0xFFFF0000)).view(np.float32)

def sr(x):   # FP32 -> BF16, stochastic
    b = np.asarray(x, np.float32).view(np.uint32).copy()
    b = b + rng.integers(0, 1 << 16, b.shape, dtype=np.uint32)
    return (b & np.uint32(0xFFFF0000)).view(np.float32)
```

Sign-magnitude encoding makes this unbiased for negatives too, and an exponent carry lands on the correct neighbour. The variance is p(1−p)·Δ² ≤ Δ²/4, where Δ is the local BF16 spacing.

## Finding 1: under RNE, weight decay does literally nothing

Decoupled weight decay multiplies each weight by (1 − lr·λ). The paper uses λ = 0.1 with tuned learning rates up to 7e-4, so lr·λ ≤ 7e-5 relative. Half a BF16 ulp is between 2⁻⁹ and 2⁻⁸ relative (0.2–0.4%), about 28× larger. On 2M weights drawn from N(0, 0.02):

| lr·λ | RNE: weights unchanged | SR: mean of w′/w | exact |
|---|---|---|---|
| 5.5e-5 | 100.000% | 0.9999448 | 0.9999450 |
| 7.0e-5 | 100.000% | 0.9999300 | 0.9999300 |
| 1.4e-4 | 100.000% | 0.9998599 | 0.9998600 |

Any multiplicative change smaller than 2⁻⁹ is a no-op under RNE, whatever the weight's magnitude. In a fused update the decay shifts the pre-rounding value by ~1/28 of a gap, so it almost never changes the outcome: pure-BF16 RNE trains with effectively zero weight decay, whatever the config says. SR applies it exactly in expectation.

## Finding 2: RNE freezing is a staircase, and the defaults sit on its worst steps

RNE drops an update δ when |δ| is less than half the gap toward the target. Gaps are powers of two, so the frozen set is {|w| ≥ 2ᵏ} for some k, and the frozen fraction is piecewise constant in δ. Adam's per-coordinate step is lr·|m̂/√v̂|, which is usually below lr. Using δ = lr therefore gives a lower bound on freezing:

| Peak lr (paper) | Frozen at peak | Frozen at 10% of peak (cosine floor) |
|---|---|---|
| 1.2e-4 (6.7B default) | 11.8% | 84.5% |
| 2.0e-4 (770M/1.3B default) | 0.2% | 69.5% |
| 3.0e-4 | 0.0% | 69.5% |
| 5.5e-4 (6.7B, SR-tuned) | 0.0% | 43.4% |
| 7.0e-4 (350M/770M, SR-tuned) | 0.0% | 11.8% |

Repeated values are the staircase: 7e-5 and 1.2e-4 fall between the same powers of two. At default learning rates, BF16-RNE anneals with 70–85% of weights unable to move.

SR fixes the bias but not the signal-to-noise ratio. I applied 5,000 updates of 2e-6 to w = 1/32 across 4,000 trials. RNE stayed at exactly 0.031250. SR averaged 0.021228 against a target of 0.021250, with a standard deviation of 1.07e-3. That matches the random-walk prediction √(N·δ·Δ) = 1.10e-3, which is 11% of the total movement. The relative noise scales as √(Δ/(N·δ)), so larger steps help. This is the mechanism behind the paper's recommendation of 2–4× higher learning rates, and the tuned values in its Table 2 (7e-4 vs 2–3e-4 on GPT-2) show the same.

## Finding 3: the implicit regularizer lives only in the stagnation regime

Theorem 1 says gradient descent with SR implicitly minimizes F + (α/4)‖∇F‖² + (α/4)E‖ξ‖². As α → 0, the last term tends to (1/4)·Σᵢ Δᵢ·|∂ᵢF|. I checked the limit directly with g = 0.3 at w = 1/32 (Δ = 2⁻¹³):

| α | (α/4)·E[ξ²] | Δ·g/4 (the limit) |
|---|---|---|
| 1e-7 | 8.94e-6 | 9.16e-6 |
| 1e-5 | 9.07e-6 | 9.16e-6 |
| 1e-3 | 9.25e-7 | 9.16e-6 |

The limit holds while α·|g| < Δ. Once the step exceeds one ulp, the penalty falls by 10×. Since Δᵢ ∝ |wᵢ|, the penalty is roughly 2⁻⁸·Σ|wᵢ|·|∂ᵢF|, a scale-dependent L1 term. And the regularizer exists only in the stagnation regime: you get it only on coordinates whose steps are below one ulp.

## Finding 4: the Adam bound's β2 dependence cancels out

Theorem 2 (β1 = 0) has a quantization term

(R·d·Δ·L / (T·√(1−β2))) · (√(T·ln(1 + R²/(ε(1−β2)))) + T·√(ln(1/β2)))

The second piece doesn't decay with T. It is a constant floor R·d·L·Δ·√(ln(1/β2)/(1−β2)). Corollary 1's "negligible" condition carries the same factor. Since ln(1/β2) ≈ 1 − β2, the factor is essentially 1:

| β2 | √(ln(1/β2)/(1−β2)) |
|---|---|
| 0.9 | 1.0265 |
| 0.95 | 1.0129 |
| 0.99 | 1.0025 |
| 0.999 | 1.0003 |

So the floor is about R·d·L·Δ for every β2, and the condition reduces to Δ ≪ α: the ulp must be much smaller than the learning rate. The paper notes the term can dominate "when β2 → 1 with α = O(1/√T)". The β2 part of that statement is cosmetic; the decaying α does the damage. It is the same Δ-versus-lr comparison as Finding 2.

## Finding 5: with RNE optimizer states, β2 = 0.999 turns v into a ratchet

The paper keeps m and v in BF16 and uses β2 = 0.95. That choice matters more than it looks. When g = 0, the EMA update v ← β2·v + (1−β2)·g² shrinks v by a relative (1−β2). If that is below 2⁻⁹, RNE rounds the decrease away, and no gradient can make v smaller. I checked one million BF16 values of v:

| β2 | 1 − β2 | v values able to decrease (g = 0) |
|---|---|---|
| 0.998 | 0.00200 | 4.70% |
| 0.99805 | 0.00195 | 0.00% |
| 0.999 (PyTorch default) | 0.00100 | 0.00% |

The cutoff is exactly β2 = 1 − 2⁻⁹. I then ran 6,000 steps where the gradient standard deviation drops from 1.0 to 0.25 at step 2,000, so the true E[g²] is 0.0625. Final v:

| β2 | FP32 | BF16 RNE | BF16 SR |
|---|---|---|---|
| 0.95 | 0.0623 | 0.0623 | 0.0623 |
| 0.99 | 0.0625 | 0.0653 (+4.5%) | 0.0625 |
| 0.999 | 0.0772 | 1.0406 (16.6×) | 0.0771 |

With β2 = 0.999, RNE keeps v at its pre-drop peak. That cuts the effective step on those coordinates by √16.6 ≈ 4.1× for the rest of training, and every later gradient spike ratchets it higher. (The FP32 value of 0.0772 is just the EMA's own 1,000-step memory.) Below the cutoff, RNE still biases v upward, because increases need g² several times above v to survive rounding. If you port this recipe to pure BF16 with the default betas, either keep β2 ≤ 0.99 or apply SR to v as well.

## Finding 6: data-parallel replicas need a shared random seed

Algorithm 1 seeds the rounding RNG identically across replicas. Two replicas with identical gradients but independent SR draws disagreed on 33.4% of weights after one step, 77.9% after 10, and 97.8% after 1,000 (RMS gap 2.2e-3, ~11% of weight scale). Nothing pulls them back together, so seed management is a correctness requirement.

## Where the memory goes

Per parameter, FP32-master mixed precision with AdamW stores 2 (BF16 weights) + 4 (master) + 4 + 4 (m, v) + 2–4 (gradients) = 16–18 bytes. Pure BF16 with SR stores 8. Model state shrinks 2–2.25×, but the paper reports 11–30% per-node savings because activations dominate without ZeRO. Table 6's 1,572 vs 1,371 GB for 2.7B, which looks inconsistent with Table 4, is exactly 8× Table 4's per-node 197 vs 171 GB: a total over 8 nodes.

## Takeaways

- **The BF16-RNE baseline loses more than precision**: no effective weight decay, and most weights frozen during annealing.
- **SR's real constraint is ulp ≪ step size.** Stagnation, the regularizer and the convergence floor all reduce to it; 2–4× higher learning rates meet it.
- **Any EMA with 1 − β < 2⁻⁹ cannot decrease under BF16 RNE.** Use β2 ≤ 0.99 or SR the states.
- **Share the rounding RNG** across data-parallel replicas.
