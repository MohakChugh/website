---
title: "Binary Tower Fields: How Binius Stopped Paying the 254x Tax on Every Committed Bit"
date: 2026-08-12
tags: ["cryptography", "zero-knowledge", "snarks", "finite-fields", "simd"]
excerpt: "A SNARK prover's real cost is bits committed, not gates executed. Committing a single boolean into a 254-bit field wastes 253 of those bits. Binius removes the waste by replacing prime fields with a tower of binary fields, where a bit and a 128-bit word share one arithmetic."
---

The dominant cost in a modern SNARK prover is not multiplication. It is commitment: hashing the witness into a Merkle tree, or MSM-ing it into a curve group. The cost of that step scales with the number of *field elements* committed, and this creates a pricing failure that everyone has quietly tolerated for a decade.

A Keccak circuit is almost entirely boolean. Its witness is bits. But a Groth16 or PLONK prover over BN254 stores each of those bits as a full 254-bit scalar, then commits it. You pay for 254 bits of entropy to carry one bit of information. Diamond and Posen call this the **embedding overhead**, and their work on binary tower fields — *Succinct Arguments over Towers of Binary Fields* (EUROCRYPT 2025) and *Polylogarithmic Proofs for Multilinears over Binary Towers* (EUROCRYPT 2026) — is an attempt to drive it to exactly 1.

Here is the tax on a single Keccak-f[1600] permutation, whose Binius constraint system commits about 12 KiB of witness data (98,304 bits, roughly 2.56 state-widths per round across 24 rounds):

| Field | Bits/element | Committed |
|---|---|---|
| BN254 / BLS12-381 | 254 | 3048 KiB |
| Goldilocks (Plonky2) | 64 | 768 KiB |
| BabyBear (Plonky3) | 31 | 372 KiB |
| Binary tower | 1 | **12 KiB** |

The 64-bit and 31-bit "small field" SNARKs of the last three years were an attack on precisely this row. They got the factor from 254 down to 31. Binius argues the right target is 1.

## Wiedemann's tower

The construction is not new — it is Wiedemann's 1988 iterated quadratic extension. Start at `F_2` and build upward, each level a degree-2 extension of the one below:

$$\tau_0 = \mathbb{F}_2, \qquad \tau_{k+1} = \tau_k[X_k]/(X_k^2 + X_{k-1}X_k + 1), \qquad X_{-1} = 1$$

So $\tau_1 = \mathbb{F}_4$, $\tau_2 = \mathbb{F}_{16}$, $\tau_3 = \mathbb{F}_{256}$, up to $\tau_7 = \mathbb{F}_{2^{128}}$. An element of $\tau_k$ is a $2^k$-bit string. Addition is XOR — no carries, no modular reduction, no conditional subtraction.

Multiplication is where the recurrence pays off. Split $a = a_hi X_k + a_lo$, reduce $X_k^2 = X_{k-1}X_k + 1$, and apply Karatsuba:

```python
def mul(a, b, k):
    """Multiply in tau_k. Elements are ints of 2^k bits."""
    if k == 0:
        return a & b                       # F_2 multiplication is one AND
    h = 1 << (k - 1)
    mask = (1 << h) - 1
    alo, ahi = a & mask, a >> h
    blo, bhi = b & mask, b >> h
    m0 = mul(alo, blo, k - 1)
    m2 = mul(ahi, bhi, k - 1)
    m1 = mul(alo ^ ahi, blo ^ bhi, k - 1)  # Karatsuba: 3 mults, not 4
    lo = m0 ^ m2                           # from X_k^2 = ... + 1
    hi = m1 ^ m0 ^ m2 ^ mul_by_gen(m2, k - 1)
    return lo | (hi << h)

def mul_by_gen(c, k):
    """Multiply c in tau_k by X_{k-1}. Linear: XOR and shift only."""
    if k == 0:
        return c                           # X_{-1} = 1
    h = 1 << (k - 1)
    clo, chi = c & ((1 << h) - 1), c >> h
    return chi | ((mul_by_gen(chi, k - 1) ^ clo) << h)
```

I instrumented this to count gates rather than trust the asymptotics. The AND count is exactly $3^k$ at every level, which is $n^{\log_2 3} = n^{1.585}$ in the bit-width $n$:

| Level | Field | AND gates | XOR gates | Schoolbook ANDs |
|---|---|---|---|---|
| 3 | $\mathbb{F}_{2^8}$ | 27 | 120 | 64 |
| 5 | $\mathbb{F}_{2^{32}}$ | 243 | 1356 | 1024 |
| 7 | $\mathbb{F}_{2^{128}}$ | **2187** | 13320 | 16384 |

I also verified the axioms directly at $\tau_3$: commutativity over all 65,536 pairs, associativity and distributivity on 20,000 random triples, and that all 255 nonzero elements are invertible with 128 primitive elements — as $\varphi(255)$ demands.

Compare 2187 AND gates and some XOR fan-out against a 256-bit Montgomery multiplication: sixteen 64×64→128 integer multiplies, carry propagation across a 512-bit accumulator, then a reduction pass. In silicon, XOR trees and shifts are nearly free; wide integer multipliers with carry chains dominate area and limit clock frequency. That asymmetry is the hardware argument for binary fields, and it is why Irreducible pitches Grøstl (AES-based) over Poseidon as the circuit-friendly hash.

## The property that actually removes the overhead

Karatsuba is a nice constant. The structural win is subtler, and it is the reason a *tower* is used rather than one flat $\mathbb{F}_{2^{128}}$.

Each $\tau_k$ sits inside $\tau_{k+1}$ with an **identical bit representation**. A byte in $\tau_3$ is the low 8 bits of a $\tau_7$ element, and multiplying two of them at level 7 yields the same result as multiplying them at level 3. I checked this exhaustively for both $\tau_2 \subset \tau_3$ and $\tau_3 \subset \tau_7$: zero mismatches across all pairs. No conversion, no re-encoding, no tag.

That is what makes a single arithmetization able to mix bits, bytes, and 128-bit words in the same constraint system for free. In a prime-field circuit, a "boolean" is a 254-bit element plus a range constraint proving it is 0 or 1. Here a boolean is a boolean and it lives in a subfield of the field the protocol runs in.

Squaring is also structurally cheap: in characteristic 2, $(a+b)^2 = a^2 + b^2$, so Frobenius is $\mathbb{F}_2$-linear — an 8×8 bit matrix at $\tau_3$, not 27 ANDs. I confirmed linearity over all 65,536 pairs and extracted the matrix.

## Your CPU already has the instruction

$\mathbb{F}_{256}$ is $\mathbb{F}_{256}$ — the Wiedemann tower's third level is isomorphic to AES's $\mathbb{F}_2[y]/(y^8+y^4+y^3+y+1)$, and x86 has shipped a hardware multiplier for the latter since Ice Lake (`VGF2P8MULB`, part of GFNI) plus a bit-matrix transform (`VGF2P8AFFINEQB`) to change basis.

Making that concrete: search $\tau_3$ for an element satisfying the AES minimal polynomial, then express everything in its power basis. Exactly 8 candidates exist — the Frobenius conjugates of a root, as expected. Taking $\alpha = \mathtt{0x30}$ and building the map $\phi$, I verified $\phi(a \cdot_\tau b) = \phi(a) \cdot_{\text{AES}} \phi(b)$ across all 65,536 pairs with zero mismatches, with $\phi$ $\mathbb{F}_2$-linear. So the basis change is a single affine byte transform, and a 64-lane batch of tower $\mathbb{F}_{256}$ multiplications becomes three SIMD instructions: affine, multiply, affine back. Higher tower levels then recurse onto that primitive.

## The part that was actually hard

None of the above solves the commitment problem, because Merkle-hashing and proximity testing want *large* field elements. Committing bit-valued polynomials through a large-field scheme reintroduces the tax you just removed, and small-field soundness for proximity testing is genuinely delicate.

The EUROCRYPT 2026 paper's answer is **ring-switching**: a sumcheck-based compiler that turns any multilinear PCS over a large extension field into one over its ground field, with commitment cost matching the large-field scheme on an input of the same *bit-size* — not the same element count. Prover overhead is linear, verifier overhead logarithmic. Instantiated over a characteristic-2 variant of BaseFold, this gives polylogarithmic proofs for bit-valued multilinears. Practically: pack 128 bits into one $\tau_7$ element, commit those, and use the sumcheck to prove the packed commitment is consistent with the bit-level evaluation claim.

## Where the numbers land, honestly

Irreducible reports roughly 50× better commitment throughput than Plonky2 on 1-bit elements. Plonky2 uses Goldilocks, so my table puts the *pure embedding* ceiling at 64×. They are realizing about 78% of it — the residual goes to hashing and per-element overheads that no field choice eliminates. The claim is consistent with the mechanism rather than exceeding it, which is the right sanity check to run on a vendor benchmark.

Two costs are real and worth naming. First, $|\mathbb{F}_{2^k}^*| = 2^k - 1$ is odd, so there is no smooth multiplicative subgroup and the classical radix-2 FFT is simply unavailable; you need additive NTTs over $\mathbb{F}_2$-linear subspaces (Lin–Chung–Han), which are less tuned than a decade of Montgomery-plus-FFT engineering. Second, elliptic-curve-based commitment is off the table, so binary-field SNARKs are hash-based and inherit larger proofs than pairing-based systems — fine for recursion and aggregation layers, less so where a 200-byte proof is the requirement.

The broader lesson generalizes past cryptography. The industry spent years optimizing multiplication inside a data type chosen for reasons unrelated to the workload, when the workload was boolean and the real cost was bits moved. Getting the representation right beat getting the arithmetic fast.
