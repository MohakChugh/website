---
title: "Shuffled DP-SGD Is Not Poisson DP-SGD: Re-running the Accountants on the Batch-Sampler Gap"
date: 2026-10-30
tags: [differential-privacy, dp-sgd, privacy-accounting, machine-learning, security]
excerpt: "Most DP-SGD pipelines shuffle the data and chop it into fixed batches, then report ε from an accountant that assumes Poisson subsampling. Chua et al. (ICML 2024) showed the two can be far apart. I reproduced their numbers with Google's dp_accounting library. At σ=0.5 and 10,000 steps, Poisson PLD reports ε=1.95, while shuffling is provably at least 10.99, essentially no amplification at all. Sweeping σ, the gap peaks at 61× near σ=0.8. A 4M-sample Monte Carlo shows the paper's cheap max-coordinate lower bound is tight to within MC noise. To hit the same ε, shuffling needs about 2× the noise multiplier. Balls-and-Bins sampling came out at or below Poisson in every setting I ran."
---

# Shuffled DP-SGD Is Not Poisson DP-SGD: Re-running the Accountants on the Batch-Sampler Gap

DP-SGD has carried a quiet inconsistency since Abadi et al. (2016). The privacy proof assumes **Poisson subsampling**: each example joins each batch independently with probability q. That gives batches of random size and needs random access to the dataset. Real pipelines **shuffle** once per epoch and cut the permutation into fixed-size batches, because that fits streaming data loaders and fixed tensor shapes. Then they report ε from a Poisson accountant anyway. The 2023 DP-ML survey by Ponomareva et al. calls this "common, though inaccurate".

Chua et al. put numbers on it in **How Private are DP-SGD Implementations?** (ICML 2024), then extended it to multiple epochs (NeurIPS 2024) and proposed a fix, **Balls-and-Bins sampling** (2025). I reproduced the headline numbers and ran experiments the papers don't report.

## The mechanism, stripped down

The papers analyze **ABLQ** (adaptive batch linear queries). It runs T steps over n = b·T examples. At step t it releases the sum of a bounded query (the clipped gradient) over batch S_t plus N(0, σ²) noise. Adjacency is "zero-out": one record is replaced with a ghost ⊥ that always contributes 0. The batch sampler is the only thing that changes:

| Sampler | Batches | Tightly dominating pair (P vs Q) |
|---|---|---|
| D: deterministic | fixed partition | N(1, σ²) vs N(0, σ²) |
| P: Poisson | each record in each step w.p. q = 1/T | ((1−q)·N(0,σ²) + q·N(1,σ²)) vs N(0,σ²), composed T times |
| S: shuffle | random permutation, then chunk | mix_t N(2e_t, σ²I) vs mix_t N(e_t, σ²I), a lower bound conjectured tight |
| B: balls-and-bins | each record to one uniform random batch | mix_t N(e_t, σ²I) vs N(0, σ²I), proven tight |

The shuffle row carries the main idea. Take a one-dimensional query ψ(x) = x and let every non-differing record equal **−1**. The target record is +1 in one dataset and ⊥ in the other. Every batch without the target sums to exactly −b. The batch that holds the target sums to −b+2 (or −b+1 with the ghost). Shift by b and you get Gaussians centered at 2e_t versus e_t, where t is the unknown slot. That slot is still random, but the *other* records now act as a contrasting background. All T coordinates get observed, and the target's coordinate is the one that sticks out.

Under Poisson, membership is independent across records, so the others reveal nothing about where the target sits. Balls-and-bins keeps that independence and still places each record exactly once per epoch.

## The lower bound in eight lines

The hockey-stick divergence over any event E gives δ(ε) ≥ P(E) − e^ε·Q(E). Chua et al. use the event "the maximum coordinate is at least C". For an isotropic Gaussian, that probability is one minus a product of T normal CDFs, so it costs O(1) per C:

```python
from scipy.special import log_ndtr
import numpy as np

Cs = np.arange(0, 100, 0.01)
def delta_S_lb(eps, s, T):
    lP = log_ndtr((Cs - 2) / s) + (T - 1) * log_ndtr(Cs / s)   # P_S(max < C)
    lQ = log_ndtr((Cs - 1) / s) + (T - 1) * log_ndtr(Cs / s)   # Q_S(max < C)
    return np.max(-np.expm1(lP) - np.exp(eps) * -np.expm1(lQ))
```

Stay in log space: Φ(C/σ)^9999 rounds to 1 or 0 in plain floats long before C reaches the range that matters for δ = 10⁻⁶.

## Reproduction

I computed ε_P with `dp_accounting` 0.6: the PLD accountant with connect-the-dots discretization, plus the RDP accountant. ε_D comes from the closed-form Gaussian of Balle & Wang. ε_S comes from the bound above. Setting: T = 10,000 steps (one epoch), δ = 10⁻⁶.

| σ | Paper | Mine |
|---|---|---|
| 0.5 | ε_P < 1.96 (PLD), < 3.43 (RDP); ε_S > 10.994; ε_D ≈ 10.997 | 1.953, 3.422; 10.995; 10.997 |
| 1.3 | ε_P < 0.031 (PLD); ε_S > 0.26 | 0.0307 (0.034 at 10⁻⁴ discretization); 0.262 |
| 0.4, ε = 4 | δ_S ≥ 0.226, δ_D ≈ 0.244 | 0.2260, 0.2438 |
| 0.4, ε = 12 | δ_S ≥ 7.5·10⁻⁵ | 7.47·10⁻⁵ |

Everything matches to the reported precision. At σ = 0.5, the shuffled pipeline gets essentially **no amplification**: its ε is within 0.002 of releasing every batch with no sampling at all. A team that reports ε ≈ 2 is shipping a model whose provable worst case is ε ≈ 11.

## Where the gap peaks

I swept σ at the same T and δ:

| σ | ε_P (PLD) | ε_P (RDP) | ε_S lower bound | ε_D | ε_S / ε_P |
|---|---|---|---|---|---|
| 0.5 | 1.953 | 3.422 | 10.995 | 10.997 | 5.6× |
| 0.6 | 0.533 | 2.077 | 8.772 | 8.841 | 16.5× |
| 0.7 | 0.160 | 1.396 | 6.880 | 7.373 | 43× |
| 0.8 | 0.081 | 1.049 | 4.940 | 6.312 | **61×** |
| 1.0 | 0.049 | 0.589 | 1.896 | 4.887 | 38× |
| 1.3 | 0.034 | 0.325 | 0.262 | 3.634 | 7.7× |
| 2.0 | 0.022 | 0.141 | 0.012 | 2.254 | 0.5× |

The ratio isn't monotone. At small σ, Poisson amplification itself fades, so both numbers are large. At large σ, the max-coordinate event loses power: one coordinate shifted by 1 is hard to spot among 10,000 when σ = 2. That is a statement about the *lower bound*, not a proof that shuffling beats Poisson there. The worst region is σ ≈ 0.7–1.0, which is where many published DP fine-tuning runs sit.

One side effect: the slack in RDP's Poisson bound exceeds the shuffle lower bound once σ > 1.255 (both ≈ 0.353). Above that, RDP-reported shuffled runs aren't contradicted by a known attack, though no proof covers them either. Below it, even RDP under-reports.

## Is the max-coordinate bound leaving anything on the table?

The max event is one cheap test. The full hockey-stick divergence between P_S and Q_S is a T-dimensional integral over a log-ratio of two mixtures:

```
L(w) = logsumexp((2w − 2)/σ²) − logsumexp((w − 1/2)/σ²)
δ(ε) = E_{w~P_S}[ max(0, 1 − e^(ε − L(w))) ]       (and the reverse direction)
```

I estimated it with 4M Monte Carlo samples per direction at T ∈ {10, 100}. I ran balls-and-bins the same way, with L(w) = logsumexp((w − 1/2)/σ²) − log T.

| T | σ | δ | ε_D | ε_S max-event | ε_S full MC | ε_BB MC | ε_P PLD |
|---|---|---|---|---|---|---|---|
| 10 | 0.5 | 10⁻³ | 7.581 | 7.581 | 7.574 | 5.276 | 7.484 |
| 10 | 0.5 | 10⁻⁴ | 8.877 | 8.877 | 8.881 | 6.618 | 9.940 |
| 10 | 1.0 | 10⁻³ | 3.139 | 3.036 | 3.039 | 1.214 | 1.572 |
| 100 | 1.0 | 10⁻³ | 3.139 | 2.399 | 2.408 | 0.298 | 0.341 |
| 100 | 1.0 | 10⁻⁴ | 3.804 | 3.320 | 3.311 | 0.443 | 0.519 |

Three things stand out:

1. **The max event is essentially optimal** for the conjectured pair. The full divergence differs by at most 0.01, which is within MC error. So the shuffle numbers above are effectively *exact* for the worst-case dataset, if Conjecture 3.2 holds, and not just loose floors.
2. **Poisson can lose to no sampling at all.** At T = 10, σ = 0.5, δ = 10⁻⁴, Poisson gives 9.94 against 8.88 for fixed batches. This is the large-ε crossover in the paper's Theorem 4.2. Poisson lets the target land in several steps instead of exactly one, and at large ε those multi-hit runs cost more than amplification saves.
3. **Balls-and-bins came out at or below Poisson in every row**, often well below at small T (5.28 vs 7.48). The 2025 paper proves it beats D and S everywhere and P at large ε. In my runs it also won at moderate ε.

## What it costs to be honest

The useful practitioner number is how much more noise shuffling needs to *provably* meet the ε you planned to report. At T = 10,000 and δ = 10⁻⁶ I solved for σ:

| target ε | σ (Poisson PLD) | σ (shuffle, necessary) | ratio |
|---|---|---|---|
| 1 | 0.553 | ≥ 1.102 | 1.99× |
| 3 | 0.461 | ≥ 0.915 | 1.98× |
| 8 | 0.355 | ≥ 0.641 | 1.80× |

The shuffle σ is a *necessary* condition, since it comes from a lower bound. The real requirement may be higher. Doubling σ quadruples gradient-noise variance, so for a fixed utility it roughly means 4× larger batches.

## Takeaways

- **Pick the accountant to match the sampler.** If the loader shuffles, the Poisson ε is not a guarantee, and in the σ ≈ 0.6–1.0 range it can understate the worst case by 15–60×.
- **Balls-and-bins is the cheap fix.** `batch_of = rng.integers(0, T, n)` plus a group-by is the whole sampler, and pad-and-truncate keeps kernel shapes fixed. Accounting needs Monte Carlo (the 2025 paper adds importance and order-statistics sampling for small δ), but it lands at or below Poisson.
- **Real loaders are worse than the model.** Buffered `tf.data`-style shuffles aren't uniform permutations, and multi-epoch training compounds the gap. If the accountant doesn't model your sampler, the defensible number is the deterministic-batch ε, which shuffling can come within 0.002 of.

All numbers come from about 90 lines of Python on `dp_accounting` 0.6 and SciPy, run on a laptop. The Monte Carlo table took 6.5 minutes.
