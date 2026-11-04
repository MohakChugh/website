---
title: "Falcon's Signature Compressor, Audited: FN-DSA-1024 Restarts 1 in 1,055 Signings on Encoding Overflow, 6.8 Million Times Its Norm Check"
date: 2026-11-04
tags: ["post-quantum", "cryptography", "lattice-signatures", "entropy-coding", "rejection-sampling"]
excerpt: "Falcon (NIST's FN-DSA) signs with two restart loops. One rejects samples whose norm is too large, and the spec bounds it. The other rejects samples whose compressed encoding overflows the fixed signature size, and the spec never quantifies it. I harvested 30,000 real preimage samples from the reference implementation and computed the exact length distribution by convolution. Falcon-512 overflows 1 time in 5.3 million. Falcon-1024 overflows 1 time in 1,055 (12 hits in 10,000 samples, against 9.5 predicted). That is 6.8 million times its norm-restart rate. Seven more bytes would bring it level with Falcon-512."
---

# Falcon's Signature Compressor, Audited: FN-DSA-1024 Restarts 1 in 1,055 Signings on Encoding Overflow, 6.8 Million Times Its Norm Check

Falcon is the compact lattice signature that NIST is standardizing as **FN-DSA** (FIPS 206). It is the outlier among the post-quantum signatures. A Falcon-512 signature is 666 bytes, against 2,420 for ML-DSA-44. It gets there with an NTRU trapdoor, a fast-Fourier Gaussian sampler, and a step that gets far less attention: a hand-designed **entropy coder** for the signature vector.

That coder sits inside a restart loop. Algorithm 10 of the round-3 specification (v1.2) looks like this:

```text
do
    do
        z ← ffSampling(t, T)
        s = (t − z)·B̂
    while ‖s‖² > ⌊β²⌋                     ← restart #1: norm too large
    (s1, s2) ← invFFT(s)
    s ← Compress(s2, 8·sbytelen − 328)
while s = ⊥                               ← restart #2: encoding too long
```

The spec analyses restart #1 in detail. Equation 2.15 bounds its probability using Lyubashevsky's tail lemma. Restart #2 gets one comment, `▷ Abort if str is too long`, and no number. The Python reference implementation is a little franker: `# Check that the encoding is valid (sometimes it fails)`.

So how often is "sometimes"? I measured it.

## The coder

Each coefficient of s2 is a centered discrete Gaussian with standard deviation σ ≈ 166. Algorithm 17 encodes each one as:

```python
def compress_coef(c: int) -> str:
    sign = "1" if c < 0 else "0"
    low7 = format(abs(c) & 0x7F, "07b")      # 7 low bits, sent raw
    high = "0" * (abs(c) >> 7) + "1"        # remaining bits in unary
    return sign + low7 + high               # 9 + floor(|c|/128) bits
```

This is a Golomb–Rice code with parameter 2^7. The spec gives the reasoning: the low bits of a wide Gaussian are almost uniform, so compressing them gains nothing. And the Huffman code for the high part of a geometric-like magnitude is unary. The concatenated bits are then **padded to a fixed `slen`**. That is 8·666 − 328 = 5,000 bits for n = 512 and 8·1280 − 328 = 9,912 bits for n = 1024. The 328 bits are the header byte plus the 40-byte salt. If the encoding is longer than `slen`, the signer throws the sample away and runs ffSampling again.

Note the per-coefficient budgets: **9.766 bits** at n = 512 and **9.680 bits** at n = 1024. Falcon-1024 has a slightly *wider* Gaussian (σ = 168.39 vs 165.74) and a *tighter* per-coefficient budget. Both push it toward overflow.

## Exact overflow probabilities

Code length is an integer per coefficient, and the coefficients are independent to a very good approximation. So the total length distribution is the per-coefficient length distribution convolved with itself n times. Repeated squaring computes this exactly in milliseconds:

```python
import numpy as np

def length_pmf(sigma, L=7, M=4000):
    x = np.arange(-M, M + 1)
    w = np.exp(-x**2 / (2 * sigma**2)); w /= w.sum()
    ln = 1 + L + 1 + (np.abs(x) >> L)          # sign + L low bits + unary
    pmf = np.zeros(ln.max() + 1); np.add.at(pmf, ln, w)
    return pmf

def nfold(p, n):                               # n-fold convolution
    r, b = np.array([1.0]), p.copy()
    while n:
        if n & 1: r = np.convolve(r, b)
        b = np.convolve(b, b); n >>= 1
    return r

tail = nfold(length_pmf(168.38857144654395), 1024)[9912 + 1:].sum()
# 9.478e-04
```

| | Falcon-512 | Falcon-1024 |
|---|---|---|
| σ | 165.737 | 168.389 |
| `slen` (bits) | 5,000 | 9,912 |
| Mean code length per coefficient | 9.5877 bits | 9.6034 bits |
| Headroom above mean, in sd | 5.27 | 3.14 |
| **P[overflow]**, exact | **1.88 × 10⁻⁷** (1 in 5.3 M) | **9.48 × 10⁻⁴** (1 in 1,055) |
| P[norm restart], exact χ² | 3.93 × 10⁻⁶ | 1.39 × 10⁻¹⁰ |
| P[norm restart], spec bound (2.15) | 4.9 × 10⁻⁵ | 2.4 × 10⁻⁹ |

The two parameter sets behave in opposite ways. At n = 512 the norm check fires about 21× more often than the overflow check. At n = 1024 the overflow check fires **6.8 million times** more often than the norm check. Equation 2.15 is a loose bound, 12–17× above the exact χ² tail. Even so, it is 394,000× smaller than the overflow rate that nobody wrote down.

One more detail: the Gaussian (CLT) approximation *underestimates* this tail. At z = 5.27 a normal tail gives 6.8 × 10⁻⁸, but the exact value is 2.8× higher. The unary part gives the length distribution a long right tail. If you size a fixed-length buffer with mean + k·sd, check the real distribution.

## Checking against the reference implementation

The convolution assumes each coefficient of s2 is an independent discrete Gaussian with standard deviation σ. That should hold for a well-behaved trapdoor sampler, but it is worth confirming. I ran the reference `falcon.py` (commit `5145a81`). For each of two fresh keys per parameter set, I called its internal `__sample_preimage__` directly: 10,000 times per key for n = 512 and 5,000 times per key for n = 1024. Each call used a fresh salt and message. I recorded ‖(s1, s2)‖² and the exact Algorithm 17 bit length of s2.

| | Falcon-512 (20,000 samples) | Falcon-1024 (10,000 samples) |
|---|---|---|
| coefficient sd / σ | 0.9998 | 1.0001 |
| mean bits / coefficient | 9.5875 (pred. 9.5877) | 9.6033 (pred. 9.6034) |
| sd of total length | 17.18 (pred. 17.29) | 25.19 (pred. 24.86) |
| max length / `slen` | 4,977 / 5,000 | 9,937 / 9,912 |
| **overflows** | **0** (pred. 0.004) | **12** (pred. 9.5) |
| norm rejections | 0 | 0 |

Twelve overflows against 9.5 expected is well inside the Poisson 95% interval. Real Falcon-1024 signers hit restart #2 about once per thousand signatures and never hit restart #1. All keys also signed and verified normally through the public API.

## Does it matter?

**Throughput: no.** A restart reruns ffSampling, which is most of the signing cost, so Falcon-1024 loses about 0.095% of throughput. Nobody will notice.

**Testing: yes, a little.** The overflow branch is a real code path that a test suite almost never reaches. A 100-vector known-answer file at n = 1024 exercises it with only about 9% probability. A port that mishandles the retry could pass every KAT and still fail about one live signature in a thousand. Force this branch in tests: shrink `slen` or inject a large s2.

**Side channels: no new problem.** Restart #2 depends on the length of a *discarded* Gaussian sample, which in the ideal model does not depend on the key. The compressed format isn't constant-time anyway; that is what the 12-bit uncompressed encoding (809 / 1,577 bytes) is for.

## Is 2^7 the right Rice parameter?

Yes. I swept the parameter for both n:

| low bits L | mean bits/coef (n=512) | headroom (sd) n=512 | headroom (sd) n=1024 |
|---|---|---|---|
| 5 | 10.660 | −6.5 | −10.6 |
| 6 | 9.599 | +2.4 | +1.0 |
| **7** | **9.588** | **+5.3** | **+3.1** |
| 8 | 10.125 | −24.1 | −41.9 |

L = 7 minimises the mean and has 2–3× the tail headroom of L = 6, because its shorter unary part has less variance. Its mean is 0.168 bits per coefficient above the Gaussian's Shannon entropy (9.420 bits), or 10.7 bytes per Falcon-512 signature.

An ideal entropy coder (say rANS) shortens the mean but makes the length *more* variable: 1.02 bits sd per coefficient against 0.76. Padded for a 10⁻⁶ overflow rate, that is 658 / 1,270 bytes against Rice's 666 / 1,286: 8–16 bytes for a much harder-to-audit decoder. Rice is the right call.

## What a standard could do

The fix for Falcon-1024 is cheap. The exact length distribution says **1,287 bytes** would give it Falcon-512's 1-in-5.3-million overflow rate, and 1,286 would give one in a million. That is six or seven bytes on a 1,280-byte signature. The alternative is to keep 1,280 and *document* the 9.5 × 10⁻⁴ rate next to Equation 2.15, so implementers know the branch is live.

The general lesson: **when a fixed-size wire format wraps a variable-length code, the overflow probability is a protocol parameter.** Compute it exactly (the tail isn't Gaussian), write it in the spec, and make tests reach the branch.

## Notes on the data

- **Parameters.** n, q = 12289, σ, ⌊β²⌋ (34,034,726 / 70,265,242) and sbytelen (666 / 1,280) come from Falcon spec v1.2, Table 3.3. I recomputed β² as ⌊(1.1·σ·√(2n))²⌋ and both values match. These numbers assume FIPS 206 keeps the round-3 sizes.
- **σ/√q.** §3.11.2 describes the signature Gaussian as σ ≈ 1.55·√q. The actual ratios are 1.495 (n = 512) and 1.519 (n = 1024). The prose is slightly stale; the table is what matters.
