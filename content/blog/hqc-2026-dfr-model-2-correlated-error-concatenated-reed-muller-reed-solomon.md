---
title: "HQC's 2026 Parameter Bump Was Paid For by a Better Failure Model, Not a Better Code"
date: 2026-11-01
tags: [cryptography, post-quantum, hqc, coding-theory, kem]
excerpt: "The October 2026 HQC spec raised ω and ωr and still claims DFR targets of 2^-127.9, 2^-196.4 and 2^-257. I rebuilt the analysis from the spec. Under the old independence model (Model 1), the new parameters miss all three targets: 2^-117.8, 2^-185.8 and 2^-242.9. They pass only under the new correlated model (Model 2), which I reproduced to 2^-128.3. In 1.2M real HQC-1 error vectors the gain is invisible. Real errors and a binary symmetric channel fail the same number of inner blocks per ciphertext (dispersion 0.998 vs 1.000). The ~10 bits come entirely from weight tails near +7σ that no simulation can reach."
---

# HQC's 2026 Parameter Bump Was Paid For by a Better Failure Model, Not a Better Code

In March 2025 NIST picked HQC as its code-based backup to ML-KEM. The changelog of the 12 October 2026 spec raises ω by 1 on every level and ωr by 1 on HQC-1 and HQC-5. Heavier secrets resist key recovery but make decryption fail more often, and a new decryption-failure-rate (DFR) analysis covers the difference. I rebuilt it from the PDF in about 300 lines of numpy and scipy. The arithmetic holds up; what it depends on is the interesting part.

## Where HQC decryption can fail

Decryption sees a codeword plus noise:

```
e' = x·r2 − r1·y + e      (in F2[X]/(X^n − 1))
```

x and y are secret with weight ω. r1, r2 (weight ωr) and e (weight ωe) are per-encryption randomness. For HQC-1, n = 17,669 and ω = 67, ωr = ωe = 76. The outer code is a shortened Reed–Solomon code sRS[46,16,31] over F_256 that corrects t1 = 15 symbol errors. The inner code is RM(1,7), [128,8,64], repeated 3 times to give a [384,8,192] duplicated-RM (dRM) code. That's 46 blocks covering 17,664 bits, with the last 5 bits of n truncated. Decryption fails when more than 15 blocks decode wrong.

The inner decoder is maximum-likelihood via the fast Hadamard transform. Vectorised:

```python
H = np.array([[1]], np.float32)
while H.shape[0] < 128:                      # Sylvester Hadamard, 128x128
    H = np.block([[H, H], [H, -H]])

def drm_fails(blocks, rng, mult=3):
    """blocks: (K, 384) error bits on the all-zero codeword."""
    v = (1 - 2*blocks.astype(np.int8)).reshape(-1, mult, 128).sum(1)
    s = v.astype(np.float32) @ H              # 256 codeword scores = ±s
    M = np.abs(s).max(1)
    ties = (s == M[:, None]).sum(1) + (-s == M[:, None]).sum(1)
    ok = (s[:, 0] == M) & (rng.random(len(M)) < 1/ties)   # random tie-break
    return ~ok
```

## Step 1: the marginal error rate p*

Propositions 6.1.1–6.1.2 give the per-coordinate rate p* exactly through a hypergeometric sum over odd overlaps. Mine match Tables 12 and 14 to four digits: **0.3449, 0.3636 and 0.3750** for HQC-1, -3 and -5. A third of the received bits are flipped, and decoding still has to fail less than once in 2^128 tries.

## Step 2: the inner code, bound vs measurement

Proposition 6.1.4 is a union bound over the 255 nonzero RM codewords, with half credit for two-way ties. I evaluated it with exact integer binomials and simulated 55.2M inner blocks under each error model:

| | Prop. 6.1.4 (spec) | Prop. 6.1.4 (mine) | Observed (spec) | Observed (mine, real e′) | Observed (mine, BSC) |
|---|---|---|---|---|---|
| HQC-1 dRM[384] | −9.82 | −9.85 | −10.05 | −10.043 | −10.037 |

Values are log2 of the inner failure rate. HQC-3 and HQC-5 agree just as closely (−13.67 vs −13.65, −10.73 vs −10.72). The bound is 0.2 bits loose per block. Mine is 0.03 bits tighter than the spec's for a reason I couldn't find, which matters later.

## Step 3: Model 1 says the new parameters fail

The original analysis, Model 1, treats e′ as i.i.d. Bernoulli(p*). The inner blocks are then independent, and the DFR is a binomial tail:

```python
DFR = sum(comb(46, l) * pi**l * (1 - pi)**(46 - l) for l in range(16, 47))
```

with pi from Prop. 6.1.4. For both parameter vintages:

| Instance | Target | 2025/08 (ω, ωr) | Model 1 | 2026/10 (ω, ωr) | Model 1 | Model 2 (spec) |
|---|---|---|---|---|---|---|
| HQC-1 | 2^-128 | 66, 75 | **−133.3** | 67, 76 | **−117.8** | −127.9 |
| HQC-3 | 2^-192 | 100, 114 | **−194.1** | 101, 114 | **−185.8** | −196.4 |
| HQC-5 | 2^-256 | 131, 149 | **−261.1** | 132, 150 | **−242.9** | −257.0 |

Under the analysis HQC has used since 2017, the old parameters met every target and the new ones miss every target, by 10.2, 6.2 and 13.1 bits. On HQC-1, one extra unit each of ω and ωr costs 15.5 bits of DFR, because p* rises from 0.3398 to 0.3449 and that shift is raised to the 16th power in the binomial tail. Model 2 earns back 10 to 14 bits, and the update spends nearly all of it.

The scheme isn't broken, but the 2026 parameters rest entirely on Model 2.

## Step 4: what Model 2 fixes, and checking it

Model 1 ignores that the integer product Z(x)·Z(r2) has coefficients summing to exactly ω·ωr = 5,092. Each coefficient is a hypergeometric draw tied to that total, so they're slightly negatively correlated and the parity of ω(x·r2) is fixed. (My first run crashed here: odd weights have probability zero, and the FFT returned −2·10^-18.) Model 2 (Definition 6.1.2) keeps the constraint. I evaluated its Eq. 8 by exponential tilting with one FFT per weight, then combined t1 + t2 + e through hypergeometric support intersections and applied the truncation.

I checked both models against 1.2M Monte Carlo samples of real HQC-1 error vectors (sparse cyclic products via `bincount`):

| Statistic | Model 1 | Model 2 (mine) | Spec sim | Mine sim |
|---|---|---|---|---|
| Var ω(x·r2) | 3,035.4 | 1,403.26 | 1,403.7 | 1,404.6 |
| Mean ω(trunc e′) | 6,092.9 | 6,093.11 | 6,092.9 | 6,092.9 |
| Var ω(trunc e′) | 3,991.3 | 2,980.87 | 2,980.9 | 2,982.5 |
| 99.9% / 99.99% quantile | 6,289 / 6,328 | — | 6,261 / 6,295 | 6,262 / 6,296 |

Model 2 matches the simulation and Model 1 doesn't: the real weight variance is 25% smaller than Model 1 predicts. Next I fed Model 2's weights into the fundamental-domain bound (Eq. 9). That needs a per-weight failure function F(u) = Pr[more than 15 blocks fail | ω(e′) = u]. I got it by tilting the block generating function over 700 BSC parameters and keeping the best-conditioned FFT for each u. The check: the binomial through the same code must reproduce Theorem 6.1, and it gives −117.776. Then:

- **Model 2 DFR, HQC-1: 2^-128.29** (spec Table 16: 2^-127.9).

I haven't fully reconciled the 0.4-bit gap. The likely cause is the 0.03-bit inner-bound gap from Step 2, compounded over 16 failing blocks, which is about the right size.

## Step 5: why a simulation can't confirm the gain

In my runs, real error vectors and a BSC at p* behaved identically at the block level:

| Failed inner blocks per ciphertext | 0 | 1 | 2 | 3 | Var/mean |
|---|---|---|---|---|---|
| Real HQC-1 e′ (1.2M) | 1,148,759 | 50,176 | 1,048 | 17 | 0.998 |
| BSC(p*) (1.2M) | 1,148,591 | 50,290 | 1,102 | 17 | 1.000 |
| Binomial(46, pᵢ), expected | 1,148,777 | 50,137 | 1,070 | 15 | 0.999 |

Up to three failures the correlation can't be detected (1,048 vs 1,102 is about 1.2σ). The ~10-bit gain only shows up when 16 blocks fail at once, which needs an extreme total weight. So which weight dominates the DFR sum, Σ P(u)·F(u)?

| u (weight of trunc e′) | log2 F(u) | log2 P(u), Model 1 | log2 P(u), Model 2 |
|---|---|---|---|
| 6,093 (mean) | −167.5 | −7.3 | −7.1 |
| 6,300 | −125.0 | −15.0 | −17.5 |
| 6,500 | −88.6 | −37.0 | −47.3 |
| 6,700 | −57.1 | −73.0 | −96.8 |

The sum peaks at **u = 6,553 under Model 1 (+7.3σ)** and at **u = 6,454 under Model 2 (+6.6σ of its own, narrower σ)**. Those weights occur with probability 2^-45 to 2^-39. The DFR gain is a claim about how fast the weight tail falls near seven standard deviations. Eq. 8 controls that exactly, and Monte Carlo can't reach it. The spec validates Model 2 "on the whole range of weights that can be observed", which is the bulk, not this tail.

## Practical takeaways

1. **The DFR is a security parameter.** HQC gets IND-CCA from a Fujisaki–Okamoto-style transform, and decryption failures leak information about the secret key. That budget now depends on Model 2 (reference [11] in the spec), not on the i.i.d. argument used since 2017.
2. **HQC-1 is now just above 2^-128.** Its DFR is 2^-127.9, and Table 8 says "< 2^-127". An earlier changelog entry says the team removed all parameter sets with DFR above 2^-128. Nobody will collect 2^127 failures, but the target has quietly moved.
3. **Some slack remains.** The inner union bound is 0.2 bits loose per block, roughly 3 bits over 16 blocks, and Model 2 doesn't claim it. The model assumes a translation-invariant decoder, and Section 6.1.5 argues the deterministic tie-break fits.
4. **Sizes don't move.** They depend only on n and n1·n2. HQC-1 keeps a 2,241-byte encapsulation key and a 4,433-byte ciphertext, against 800 and 768 bytes for ML-KEM-512.

The October 2026 arithmetic checks out. The bump is safe only because of the new failure model, and 6–13 bits on each level now rest on a tail argument no simulation can check.
