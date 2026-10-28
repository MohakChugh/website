---
title: "ML-DSA's Signing Loop, Simulated: FIPS 204's 4.25 / 5.1 / 3.85 Repetitions Are a Floor, and the Hint Check Is Why"
date: 2026-10-28
tags: ["post-quantum", "cryptography", "lattice-signatures", "rejection-sampling", "tail-latency"]
excerpt: "FIPS 204 says ML-DSA's signing loop runs 4.25, 5.1 and 3.85 times on average. Those figures come from the exponential approximation of two of the four rejection checks. I ran Algorithm 7's acceptance tests on real keys, 300,000 candidates per parameter set. The true means are 4.37, 5.13 and 3.91. The hint-weight check ω alone rejects 1.5% of otherwise-valid ML-DSA-44 candidates. With the corrected mean, ML-DSA-65's 814-iteration limit gives a 2^-254.6 failure probability, not 2^-256. The bigger operational number is the geometric tail: p99.9 signing takes 6 to 7 times the mean."
---

# ML-DSA's Signing Loop, Simulated: FIPS 204's 4.25 / 5.1 / 3.85 Repetitions Are a Floor, and the Hint Check Is Why

ML-DSA (FIPS 204, the standardized form of CRYSTALS-Dilithium) is the lattice signature that will sign most post-quantum certificates, firmware images and TLS handshakes. Unlike ECDSA, its signing time is a random variable. The signer runs *Fiat–Shamir with aborts*: it draws a masking vector, computes a candidate signature, and discards the candidate if it could leak anything about the secret key. Table 1 of the standard gives the expected number of loop iterations as **4.25, 5.1 and 3.85** for ML-DSA-44, -65 and -87. Appendix C uses those numbers to derive an 814-iteration safety limit.

To see how exact those numbers are, and what distribution sits behind them, I ran Algorithm 7's acceptance tests on real key material.

## The four ways a candidate dies

The loop in `ML-DSA.Sign_internal` (lines 10–32 of Algorithm 7) does this on each iteration:

1. Sample **y** with coefficients in [−γ₁+1, γ₁], compute **w** = **Ay**, hash HighBits(**w**) to the challenge c (τ coefficients equal to ±1, the rest 0).
2. **z** = **y** + c**s₁**. Reject if ‖**z**‖∞ ≥ γ₁ − β, where β = τη. Otherwise **z** would carry the shape of c**s₁**.
3. **r₀** = LowBits(**w** − c**s₂**). Reject if ‖**r₀**‖∞ ≥ γ₂ − β. Otherwise the verifier's recomputed high bits could differ from the signer's.
4. Reject if ‖c**t₀**‖∞ ≥ γ₂, or if the hint vector **h** has more than ω ones. Then the signature would not encode or verify.

Checks 2 and 3 have closed forms if you treat **y** and **w** as uniform. Each of the 256ℓ coefficients of **z** survives with probability (2(γ₁−β)−1)/(2γ₁−1), and each of the 256k coefficients of **r₀** with roughly (2(γ₂−β)−1)/(2γ₂). The Dilithium paper approximates the product as exp(256·β·(ℓ/γ₁ + k/γ₂)). FIPS 204 cites that as "eq. 5 in [5]". Evaluating it with Table 1's parameters reproduces the published column exactly:

| Set | (k, ℓ) | τ, η, β | γ₁ | γ₂ | ω | exp approx | exact closed form |
|---|---|---|---|---|---|---|---|
| ML-DSA-44 | (4,4) | 39, 2, 78 | 2¹⁷ | (q−1)/88 | 80 | **4.255** | 4.280 |
| ML-DSA-65 | (6,5) | 49, 4, 196 | 2¹⁹ | (q−1)/32 | 55 | **5.094** | 5.112 |
| ML-DSA-87 | (8,7) | 60, 2, 120 | 2¹⁹ | (q−1)/32 | 75 | **3.850** | 3.868 |

So the table is the first-order approximation, 0.3–0.6% below its own closed form, and it ignores check 4. The standard says as much ("from eq. 5"), but Appendix C's 814 limit treats 5.1 as an upper bound for every set.

## Running Algorithm 7's checks on real keys

To measure the real rate, the simulator generates a key exactly as KeyGen structures one: uniform **A** over Z_q, **s₁** and **s₂** with coefficients in [−η, η], **t** = **As₁** + **s₂**, and **t₀** from Power2Round with d = 13. It then evaluates every rejection condition with the standard's own Decompose and MakeHint. The only modeling shortcut is the random oracle: c is drawn uniformly from the τ-sparse ±1 ball rather than by hashing w₁, and **A** is uniform rather than expanded from a seed. Both are the assumptions the security analysis already makes.

Negacyclic multiplication in Z_q[X]/(X²⁵⁶+1) is a product with a 256×256 "rotate and negate" matrix. Stacking every block of **A** into one matrix turns **Ay** for 1,000 candidates into a single BLAS call. With centered coefficients, every sum stays below 2⁵³, so float64 arithmetic is exact:

```python
def negacyclic(a):            # M @ b == a*b mod X^256 + 1
    M = np.empty((n, n), dtype=np.int64)
    for j in range(n):
        col = np.roll(a, j); col[:j] *= -1; M[:, j] = col
    return M

def decompose(r, g2):         # FIPS 204 Algorithm 36, vectorized
    rp = np.mod(r, q); r0 = modpm(rp, 2 * g2)
    edge = (rp - r0) == q - 1
    r1 = np.where(edge, 0, (rp - r0) // (2 * g2))
    return r1, np.where(edge, r0 - 1, r0)

# one batch of B candidates against a fixed key
W   = np.mod((BigA @ Y.astype(np.float64)).astype(np.int64), q)  # exact
Z   = Y + S1 @ C
WmC = W - S2 @ C
ct0 = T0 @ C
zok  = np.abs(Z).max(axis=0) < g1 - beta
rok  = np.abs(decompose(WmC, g2)[1]).max(axis=0) < g2 - beta
t0ok = np.abs(ct0).max(axis=0) < g2
hw   = (decompose(WmC, g2)[0] != decompose(WmC + ct0, g2)[0]).sum(axis=0)
accept = zok & rok & t0ok & (hw <= omega)
```

Five keys per parameter set, 300,000 candidates each:

| Set | P[z ok] | P[r₀ ok] | reps (z, r₀ only) | P[hint > ω \| z, r₀ ok] | hint weight μ ± σ | **full reps** | vs Table 1 |
|---|---|---|---|---|---|---|---|
| ML-DSA-44 | 0.542 | 0.429 | 4.31 | **1.50%** | 63.3 ± 7.7 | **4.37 ± 0.015** | +2.9% |
| ML-DSA-65 | 0.619 | 0.316 | 5.11 | 0.38% | 38.5 ± 6.1 | **5.13 ± 0.019** | +0.6% |
| ML-DSA-87 | 0.663 | 0.390 | 3.87 | 0.93% | 57.3 ± 7.4 | **3.91 ± 0.012** | +1.5% |

Three things stand out.

**The z/r₀ rates match the closed form.** The simulated rates agree with the uniform model to within sampling noise, so treating **Ay** as uniform is sound in practice.

**The ‖c**t₀**‖∞ check never fired** in 900,000 candidates. Each coefficient of c**t₀** is a sum of τ values bounded by 2¹², with σ ≈ √τ·4096/√3, or about 14,800 for ML-DSA-44. γ₂ = 95,232 sits about 6.4σ out, and the other sets have even more margin.

**The hint check is the missing term, and ω sets its size.** The hint has a one wherever adding c**t₀** pushes a coefficient across a high-bits boundary. Per coefficient, that happens with probability around E|ct₀|/2γ₂. ML-DSA-44 has the narrowest rounding range (γ₂ = (q−1)/88), so it produces the most hints: 63 on average against a cap of 80. That cap is only **2.2σ** above the mean, which is why 1.5% of otherwise-good candidates die there. ML-DSA-65's ω = 55 sits 2.7σ above a mean of 38.5, and it loses only 0.38%.

ω is a size parameter (the hint costs ω + k bytes), so this is a trade of signing time for bytes that the published counts leave out.

## What it does to the 814-iteration limit

Appendix C allows implementations to cap the loop, as long as the cap is at least 814. It derives that number from ((5.1−1)/5.1)ⁿ ≤ 2⁻²⁵⁶ and applies it to all three sets. Redoing the calculation with the measured means:

| Set | mean | minimal limit for 2⁻²⁵⁶ | P[exceed 814] |
|---|---|---|---|
| ML-DSA-44 | 4.37 | 684 | 2⁻³⁰⁵ |
| ML-DSA-65 | 5.13 | **819** | **2⁻²⁵⁴·⁶** |
| ML-DSA-87 | 3.91 | 601 | 2⁻³⁴⁷ |

For ML-DSA-65, Appendix C's inequality "probability ≤ ((5.1−1)/5.1)ⁿ" does not hold. The real mean exceeds 5.1, so 814 iterations buys 2⁻²⁵⁴·⁶, not 2⁻²⁵⁶. The text does hedge with "approximately", and nobody will ever observe either probability. An implementer who wants a strict 2⁻²⁵⁶ needs 819 or more. The standard notes there is "essentially no performance penalty" for a larger limit.

## The operational number: the tail

The mean is the wrong statistic for anyone with a latency budget. Iterations are independent Bernoulli trials, so the count is geometric with p = 1/mean. Its standard deviation is √(mean·(mean−1)), about 4.6 iterations for ML-DSA-65: the coefficient of variation is roughly 0.9.

| Set | p50 | p99 | p99.9 | p99.99 |
|---|---|---|---|---|
| ML-DSA-44 | 3 | 18 | 27 | 36 |
| ML-DSA-65 | 4 | 22 | 32 | 43 |
| ML-DSA-87 | 3 | 16 | 24 | 32 |

One in a thousand ML-DSA-65 signatures runs **32 iterations, 6.2× the mean**. Each iteration costs ℓ forward NTTs for **y**, k·ℓ pointwise products, k inverse NTTs, a SHAKE call and SampleInBall, plus k + ℓ more inverse NTTs when it gets as far as computing c**s₁** and c**s₂**. Only the fixed setup (key decoding, ExpandA, which is often cached, and μ) is amortized. Three consequences for systems that sign on the request path:

- **Benchmark with percentiles, not means.** A "median sign time" from a microbenchmark understates the p99.9 handshake cost of a TLS terminator or a signing service by a factor of 6 or more. Signing-HSM capacity plans built on mean ops/sec need headroom for the tail.
- **Deterministic mode freezes the tail per message.** With rnd = 0, the iteration count is a deterministic function of (key, message). The same certificate re-signed in a retry loop takes the same slow path every time. Hedged mode, the default, redraws the count.
- **You can reorder the checks.** Acceptance is a deterministic predicate, so evaluation order does not change the output. r₀ rejects more often than z in every set (P[r₀ ok] is 0.32–0.43, against 0.54–0.66 for z). Computing c**s₂** and testing r₀ before forming c**s₁** cuts the expected inverse NTTs spent on those checks from ℓ + P[z]·k to k + P[r₀]·ℓ: from 8.7 to 7.6 for ML-DSA-65, and from 12.3 to 10.7 for ML-DSA-87. Early exit inside each infinity-norm scan is the cheaper half of the same idea. One caution: keep the decision itself free of secret-dependent timing beyond what the rejection count already reveals.

## Takeaways

FIPS 204's repetition column approximates two of the four rejection conditions. Measured on real keys, the full loop runs 4.37, 5.13 and 3.91 times on average, 0.6–2.9% above the table. Most of the gap comes from the hint-weight cap ω, which was tuned for signature size and sits only 2.2–2.7σ above the mean hint count. The correction changes no security claim. What matters for engineers is the geometric tail behind the mean: p99.9 sits at 24–32 iterations, so plan capacity and SLOs around that.
