---
title: "Rational Levels: The Quantization Tax Hiding in Every RNS-CKKS Modulus Chain"
date: 2026-08-18
tags: ["homomorphic-encryption", "cryptography", "ckks", "performance", "ntt"]
excerpt: "In RNS-CKKS the scarce resource is modulus bits, and a rescale spends a whole prime whether or not the operation needed one. I built the key-switch cost model, reproduced Grafting's measured 1.83x speedup from pure limb counting, and found the case where finer-grained levels make things 4x worse."
---

Every discussion of fully homomorphic encryption performance starts in the wrong units. People count seconds, or NTTs, or bootstrapping latency. The resource that actually binds is narrower and stranger: **modulus bits**. At a fixed ring dimension `N`, lattice security caps the total ciphertext modulus. The Homomorphic Encryption Standard v1.1's table, under the BKZ.sieve cost model with a ternary secret, gives `log q <= 881` at `n = 32768` for 128-bit security. That number is your entire budget. Every multiplication you will ever perform without bootstrapping is funded out of 881 bits.

Two unrelated concerns then fight over that budget, and RNS-CKKS has historically forced them to be the same number.

## Two jobs, one parameter

The first concern is **precision**. CKKS encodes a real number by scaling it by `Δ` and rounding. A ciphertext-ciphertext multiplication squares the scale to `Δ²`, so you rescale by dividing out one modulus factor `q_i`. For the scale to stay near `Δ`, you need `q_i ≈ Δ`. Precision therefore dictates prime size.

The second concern is **machine efficiency**. RNS arithmetic represents a big-integer coefficient as one residue per prime, and each residue gets its own NTT. The cost of that NTT is `O(N log N)` modular multiplications, and the cost of a modular multiplication on a 64-bit word is *identical* for a 40-bit and a 60-bit prime: same Shoup or Barrett sequence, same butterfly count. The only ceiling is lazy reduction overflow, which is why Lattigo hard-caps `MaxModuliSize = 60`.

So the efficiency metric that matters is **bits of budget delivered per NTT**, and a 60-bit prime delivers 50% more of it than a 40-bit prime at identical cost. Coupling scale to modulus pins you at `log Δ` bits per NTT and throws the rest away. This is precisely the limitation that *Grafting: Decoupled Scale Factors and Modulus in RNS-CKKS* (Cheon, Choe, Kang, Kim, Kim, Mono, and Noh; ePrint 2024/1014, CCS 2025) attacks with reusable "sprout" factors that permit rescaling by arbitrary bit-lengths.

## Pricing a key-switch

To quantify the tax you need a cost model. Key-switching dominates FHE runtime, and hybrid key-switching decomposes as follows. A ciphertext at `k` RNS limbs, special modulus `P` of `K` limbs, digits of `α` limbs each, `dnum = ceil(k/α)`:

- **ModUp**, per digit: `α` inverse NTTs to lift out of the digit's own moduli, then `k + K - α` forward NTTs into the rest. That is `k + K` NTT-equivalents per digit, `dnum(k+K)` in total.
- **Inner product** with the evaluation key: modular multiply-accumulate only, no transforms.
- **ModDown**, per output component: `K` inverse NTTs plus `k` forward, so `2(k+K)` across both components.

```python
import math

def ks_ntt(k, alpha, K):
    """Hybrid key-switch cost in NTT-equivalents for a k-limb ciphertext."""
    return (math.ceil(k / alpha) + 2) * (k + K)
```

Two properties of `(dnum + 2)(k + K)` matter. It is superlinear in `k`, because carrying more limbs both widens every transform and adds digits. And it is a *step function*, because `dnum` is a ceiling.

## The word-size tax, derived

Fix the budget. At `N = 2^15` with `α = K = 2` and 60-bit special primes, `log Q = 881 - 120 = 761`, call it a 701-bit `Q` after reserving a base prime. Now compare a chain of 40-bit limbs against 60-bit limbs holding `log Q` constant:

| `α = K` | 40-bit limbs | 60-bit limbs | top-of-chain ratio | chain-mean ratio |
|---|---|---|---|---|
| 2 | 17 limbs, 209 NTTs | 11 limbs, 104 NTTs | 2.01x | 1.83x |
| 3 | 17 limbs, 160 NTTs | 11 limbs, 84 NTTs | 1.90x | 1.70x |
| 4 | 17 limbs, 147 NTTs | 11 limbs, 75 NTTs | 1.96x | 1.60x |
| 5 | 17 limbs, 132 NTTs | 11 limbs, 80 NTTs | 1.65x | 1.53x |

Grafting reports up to **1.83x** faster key-switching and **2.01x** faster multiplication. The `α = K = 2` row of a model that counts nothing but limbs and transforms lands on 1.83x for the chain mean and 2.01x at the top of the chain. I do not want to oversell a two-significant-figure coincidence, and my model ignores modmul counts, NTT/INTT asymmetry, and memory traffic entirely. But the mechanism is confirmed: essentially all of Grafting's evaluation speedup is limb count, and limb count is what you get back by refusing to let `Δ` choose your prime size.

## The residual: depth is still an integer

Decoupling the *scale* does not decouple the *depth*. A rescale still discards one entire modulus factor. If an operation needs 20 bits of headroom and your limbs are 60 bits, you pay 60. `Trimming: Decoupling Multiplicative Depth from Modulus Chains in RNS-CKKS via Rational Levels` (John Chiang, arXiv:2608.00375, 1 August 2026) proposes exactly this next step: an auxiliary chain of smaller NTT-friendly factors enabling partial modulus transitions, so that a level becomes a rational rather than integral quantity. It is a position paper. The author states plainly that the framework awaits implementation, and reports no measurements.

So let me supply some. First, invert Grafting's own aggregate. They report up to 204 bits (27%) fewer modulus bits consumed on homomorphic comparison, which puts the baseline at `204 / 0.27 = 756` bits. In a 60-bit chain that is 12.6 levels, and the 204-bit saving is 3.40 levels. Their adaptive scaling therefore behaves like an **effective level cost of 43.8 bits inside a 60-bit chain** — a per-level number their paper does not state, and a useful calibration for how much residual quantization Trimming is aiming at. At a 701-bit `Q`, moving the effective level cost from 60 to 44 bits raises depth from 10 to 14.

Second, the waste is far larger for heterogeneous circuits. Take 12 squarings needing 30 bits each interleaved with 12 plaintext multiplications by small constants needing 12 bits each, 504 bits of genuine requirement:

| scheme | bits consumed | vs. required | fits in 701 bits? |
|---|---|---|---|
| integral 60-bit levels | 1440 | 2.86x (65% waste) | no |
| integral 40-bit levels | 960 | 1.90x (48% waste) | no |
| integral 30-bit levels | 720 | 1.43x (30% waste) | no |
| rational levels | 504 | 1.00x | yes |

The interesting column is the last one. Because the budget is a hard wall, quantization waste does not degrade you smoothly, it flips you from "fits" to "needs a bootstrap."

## Where rational levels backfire

Here is the part the Trimming abstract cannot address without an implementation, and it is the reason to be careful. Finer levels stretch depth by *adding limbs*, and NTT cost scales with limbs. Running that same 701-bit `Q` to exhaustion at `α = K = 3`:

| chain | limbs | depth | total NTTs | depth per 1000 NTTs |
|---|---|---|---|---|
| integral, 60 bits/level | 11 | 10 | 468 | 21.4 |
| rational, 21 bits/level | 33 | 32 | 6270 | 5.1 |

Rational levels buy 3.2x the depth for 13.4x the transforms. Measured as depth per unit of work, fine-grained levels are **4.2x worse**. They are not a free lunch and they are not even a good trade in isolation.

They are only a good trade when they cross the wall. The extra 5802 NTTs cost the equivalent of 12.4 top-of-chain key-switches on the rational chain, and a full-slot CKKS bootstrap runs to the order of `10²` key-switches. So the rule is sharp: **spend modulus bits finely if and only if doing so eliminates a bootstrap.** Stretching a chain that was already going to bootstrap anyway is pure loss.

One more scheduling consequence, from the step function in `dnum`. At `α = K = 3`, the marginal cost of carrying one extra limb is not uniform:

| `k` | NTTs | marginal |
|---|---|---|
| 11 | 84 | +7.7% |
| 12 | 90 | +7.1% |
| 13 | 112 | **+24.4%** |
| 14 | 119 | +6.2% |
| 15 | 126 | +5.9% |
| 16 | 152 | **+20.6%** |

Crossing a digit boundary costs three to four times what staying inside one does. A rational-level scheduler that greedily minimizes bits consumed will therefore sometimes make things slower than one that spends a few extra bits to land just below a `dnum` boundary. Any future implementation of Trimming needs its level allocator to be `α`-aware, not bit-greedy, and that is a property no amount of cryptographic elegance supplies for free.

The broader lesson generalizes past FHE. When a system's scarce resource is quantized, the quantum, not the total, is what your cost model has to be written in.
