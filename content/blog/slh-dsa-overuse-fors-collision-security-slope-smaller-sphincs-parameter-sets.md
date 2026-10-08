---
title: "SLH-DSA Under Overuse: Security Falls 1 Bit per Doubling, Then k Bits, and Retuning Gets Signatures Down to 3.4 KB"
date: 2026-10-08
tags: ["post-quantum", "cryptography", "hash-based-signatures", "security-engineering"]
excerpt: "FIPS 205 sizes SLH-DSA for 2^64 signatures per key, which is why its smallest signature is 7,856 bytes. Fluhrer and Dang (ePrint 2024/018) retune SPHINCS+ for 2^20–2^50 signatures. I reimplemented their security formula and hash-count model. It reproduces all six FIPS sizes and signing costs and every overuse figure I checked; one verify count, 192f, is off by 30 hashes. The new result is the slope: each doubling of the signature count costs about g*−λ bits, where g* is the reuse count of the attacker's best-case FORS instance. That rises from 1 bit per doubling to k bits, and the hypertree height decides which regime you are in."
---

# SLH-DSA Under Overuse: Security Falls 1 Bit per Doubling, Then k Bits, and Retuning Gets Signatures Down to 3.4 KB

SLH-DSA (FIPS 205, the standardized SPHINCS+) is the conservative post-quantum signature: its only assumption is that the hash behaves like a hash. The price is size. The *smallest* level-1 set produces 7,856-byte signatures at ~2.2M hash calls each, because NIST's original call required full security after **2^64 signatures per key**.

Scott Fluhrer (Cisco) and Quynh Dang (NIST), in [Smaller Sphincs+](https://eprint.iacr.org/2024/018) (revised January 2025), point out that 2^64 signatures takes 500,000 years at one per microsecond. A firmware key signs thousands of times. They derive a simple security formula as a function of signature count and exhaustively search for parameter sets tuned to 2^20–2^50 signatures. I rebuilt their model to check it, and found that the shape of the degradation curve has a closed form that gives a design rule.

## Size and cost are closed-form

A signature has three parts: a randomizer R, a FORS few-time signature (k Merkle trees of t = 2^a leaves, one leaf revealed per tree), and d WOTS+ signatures with authentication paths through a hypertree of total height h. With n-byte hashes and w = 2^lgw:

```python
def lens(n, lgw):
    w = 1 << lgw
    len1 = math.ceil(8 * n / lgw)                                   # message digits
    len2 = math.floor(math.log2(len1 * (w - 1)) / lgw) + 1          # checksum digits
    return len1, len2

def sig_bytes(n, h, d, a, k, lgw):
    l1, l2 = lens(n, lgw)
    return n * (1 + k * (a + 1) + h + d * (l1 + l2))

def sign_hashes(n, h, d, a, k, lgw):
    w = 1 << lgw; L = sum(lens(n, lgw)); hp = h // d; t = 1 << a
    fors  = 2 * k * t + k * (t - 1) + 1                       # PRF+F per leaf, H per node
    layer = (1 << hp) * (L + L * (w - 1) + 1) + ((1 << hp) - 1)   # WOTS keygens + tree
    return 2 + fors + d * layer
```

This reproduces all six FIPS 205 sizes (7,856 to 49,856 bytes) and the paper's signing counts exactly: **2,186,222** hashes for 128s and 105,196 for 128f. Verification matches when each chain is charged w/2 steps (2,214 for 128s), for five of the six sets. For 192f I get 9,363 against the table's 9,393, and no counting convention that fits the other five explains the gap.

For 128s, **92%** of signing (2,014,201 hashes) goes to rebuilding seven height-9 XMSS trees. FORS is under 8%.

## The only thing that wears out

Each WOTS+ key in the hypertree signs one fixed value (a FORS root or subtree root), so the hypertree never weakens. FORS does. Each signature picks a pseudo-random instance out of 2^h and reveals k leaves. A forger holding 2^m signatures hashes candidate messages until one lands on an instance where every needed leaf is already public. The number of signatures per instance is Poisson with λ = 2^(m−h), which gives the paper's Equation 1:

```python
def log2_p(m, h, a, k):
    lam, t = 2.0 ** (m - h), 2.0 ** a
    lo, hi = max(1, int(lam - 40 * lam**0.5)), int(lam + 40 * lam**0.5 + 200)
    terms = [g * math.log(lam) - lam - math.lgamma(g + 1)          # Poisson(g)
             + k * math.log(-math.expm1(g * math.log1p(-1 / t)))   # all k trees hit
             for g in range(lo, hi)]
    mx = max(terms)
    return (mx + math.log(sum(math.exp(x - mx) for x in terms))) / math.log(2)
```

Security bits = min(8n, −log2 p):

| set  | 2^64  | 2^68  | 2^72  | 2^74 | 2^76 |
|------|-------|-------|-------|------|------|
| 128s | 133.7 | 94.8  | 43.0  | 18.8 | 2.9  |
| 128f | 131.4 | 86.2  | 18.8  | 0.9  | 0.0  |
| 192f | 195.2 | 147.2 | 64.7  | 20.9 | 0.9  |
| 256s | 256.0 | 207.3 | 131.0 | 88.7 | 47.8 |
| 256f | 255.9 | 217.8 | 149.3 | 99.1 | 45.3 |

These numbers back the paper's claims: 256f keeps "about 100 bits" at 2^74, 128s and 192f are about equal there, and 256s overtakes 256f by 2^76. 128s has h = 63, so λ = 2 at the design point. **The standard is tuned so that each FORS instance is used twice on average.**

## The slope: about g* − λ bits per doubling

The paper calls degradation "gradual", but it isn't uniform. 128s loses 39 bits from 2^64 to 2^68 and 52 bits from 2^68 to 2^72. One term g* dominates the sum: the reuse count that best balances Poisson rarity against tree coverage. By the envelope theorem, d(ln p)/d(ln λ) = g* − λ:

> **Security lost per doubling of signatures ≈ g* − λ**, the number of extra reuses the attacker's best-case instance has above the mean.

Measured for 128s:

| log2 q | bits  | slope | λ     | g*  | g*−λ |
|--------|-------|-------|-------|-----|------|
| 40     | 191.0 | 1.00  | 1e-7  | 1   | 1.0  |
| 60     | 155.5 | 4.00  | 0.125 | 4   | 3.9  |
| 64     | 133.7 | 7.30  | 2     | 9   | 7    |
| 68     | 94.8  | 12.03 | 32    | 44  | 12   |
| 72     | 43.0  | 12.97 | 512   | 524 | 12   |

The slope has two regimes. While λ < 2^(1−k), a once-used instance is the attacker's best target, and the loss is 1 bit per doubling. Once λ ≫ 1 (but λ ≪ t), p ≈ (λ/t)^k and the loss approaches **k bits per doubling**: 14 for 128s, 35 for 256f. The switch happens around q ≈ 2^h.

So **overuse safety comes from the gap between h and log2 of your budget**. Here are two of Fluhrer–Dang's level-1 sets tuned for 2^20 signatures, both at ~90k signing hashes, which I recomputed:

| overuse ×   | 1     | 4     | 16    | 64    | 256   | 1024  |
|-------------|-------|-------|-------|-------|-------|-------|
| A-1 (h=20)  | 129.3 | 108.3 | 80.3  | 46.4  | 14.8  | 0.6   |
| A-12 (h=32) | 144.7 | 140.8 | 136.3 | 131.1 | 124.5 | 116.0 |

A-1 (5,888 bytes) puts its budget at λ = 1, already on the steep part, and 64× overuse costs it 83 bits. A-12 (7,408 bytes) puts it at λ = 2^−12 and still holds 116 bits at 1024×. My model matches the paper's "log2 signatures at 112 bits" column on every row I checked: A-1 21.69, A-2 23.25, A-12 30.79, B-1 22.92, B-23 32.24, C-1 24.90.

Signing time is the other variable. At 2^20 signatures and level 1, a ~1M-hash budget (≈1 s at the paper's HSM estimate of 10^6 hashes/s) gets **3,968 bytes** (B-1: h=21, d=3, a=13, k=11, w=64). That is half the size of 128s at 39% of its signing cost. A ~5M-hash budget gets 3,440 bytes (C-1, w=256). Larger w costs verification time: B-3 at w=256 verifies in 11,692 hashes, against 2,484 for B-1.

## Grinding, which the paper sets aside

Fluhrer–Dang change only parameters. [SPHINCS+C](https://eprint.iacr.org/2022/778) (Hülsing, Kudinov, Ronen, Yogev) changes the encoding: the signer grinds a counter until the digest meets a constraint the verifier checks for free. I computed the exact costs.

**WOTS+C** forces the message digits to a fixed sum S, which makes the checksum redundant and removes its len2 chains. The best S is the mode of the digit sum. For n=16 and w=16 that is S=240, hit with probability 1.52%, so 65.7 expected hashes per layer. Each layer saves 3 chains (48 bytes), and the verifier always walks exactly 240 steps. Forcing one more chain to zero costs 1,051 tries, and two costs 16,813, both small next to the 287k hashes of one 128s layer.

**FORS+C** grinds until the last tree's index is 0 and drops that tree. For 128s, ~4,096 expected digest hashes save 12,287 hashes of tree construction and 208 bytes of authentication path. The paper says grinding "saves back" its 2^b hashes. By my count it saves about 3× that. With retuning, level-1 "small" goes from 7,856 to 6,304 bytes at about the same signing time.

## Engineering takeaways

1. **A budget is not state.** LMS and XMSS break outright if you reuse a leaf. Exceeding an SLH-DSA budget costs bits at a rate you can compute. A coarse counter that refuses to sign past the budget is enough, and losing it is a gradual risk.
2. **Choose h, not size.** If overuse is plausible, put h well above log2 of your budget. The smallest signature can sit at the edge of the steep regime.
3. **Most signing time is in the hypertree.** Caching upper layers in the private key, as in Gravity-SPHINCS's precomputed top tree, targets the 92%. FORS tuning targets the remaining 8%.
4. **Run the model before you ship a parameter set.** It is about 40 lines. Run it at your real signature budget and at 100× that budget.
