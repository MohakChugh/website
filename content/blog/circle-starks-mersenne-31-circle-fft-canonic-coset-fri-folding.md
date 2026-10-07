---
title: "Circle STARKs: Getting a 2³¹-Point FFT Out of a Field Whose Multiplicative Group Has 2-Adicity 1"
date: 2026-10-07
tags: ["cryptography", "zero-knowledge", "stark", "finite-fields", "fft"]
excerpt: "The Mersenne prime 2³¹−1 has the cheapest reduction of any 31-bit field, but p−1 has exactly one factor of 2, so radix-2 NTTs are impossible. Circle STARKs (Haböck, Levit, Papini, 2024) use the circle x²+y²=1 instead, whose group has order p+1 = 2³¹. I built the circle FFT, its vanishing polynomial and circle FRI in Python. All checks pass: the FFT round-trips at 8–256 points, the evaluation map on N points has rank N out of N+1, a subgroup domain breaks the first fold at y=0, and one corrupted symbol fails FRI. I also benchmarked M31 against BabyBear multiplication on arm64: 1.23× scalar throughput, 1.61× latency, and 3.2× once the compiler vectorizes."
---

# Circle STARKs: Getting a 2³¹-Point FFT Out of a Field Whose Multiplicative Group Has 2-Adicity 1

STARK provers spend most of their time on field multiplications and power-of-two FFTs, and the two pull in opposite directions. The cheapest 31-bit field to multiply in is the Mersenne prime `p = 2³¹ − 1`, where reduction is a shift and an add. But a radix-2 NTT of size `2^k` needs a multiplicative subgroup of order `2^k`, so `2^k` must divide `p − 1`. For M31, `p − 1 = 2 · (2³⁰ − 1)`, which allows a size-2 NTT and nothing bigger.

*Circle STARKs* (Haböck, Levit, Papini; IACR ePrint 2024/278, revised Feb 2025) takes the FFT domain from the circle curve `x² + y² = 1` over `F_p`. That group has `p + 1 = 2³¹` points. The authors report a preliminary 1.4× prover speedup over a BabyBear STARK, and the construction underlies StarkWare's Stwo prover. I built the pipeline from scratch to see which parts are load-bearing.

## The field arithmetic

Here are the four 31/64-bit fields in common use, and how many factors of 2 each side of `p` has:

```text
field        v2(p−1)  v2(p+1)
M31             1        31
BabyBear       27         1
KoalaBear      24         1
Goldilocks     32         1
```

Classical STARK fields make `p − 1` smooth. M31 is the mirror image: all its 2-adicity sits in `p + 1`, and the circle supplies a group of that order.

## The circle group

Points on `x² + y² = 1` compose like unit complex numbers, `(x, y) ≅ x + iy`:

```text
(x₀, y₀) · (x₁, y₁) = (x₀x₁ − y₀y₁,  x₀y₁ + y₀x₁)
squaring:   (x, y)² = (2x² − 1, 2xy)
inverse/conjugate J: (x, y) ↦ (x, −y)
```

Because `−1` is a non-residue mod M31 (`p ≡ 3 mod 4`), this group is cyclic of order `p + 1`. Stwo's generator is `G = (2, 1268011823)`. I checked numerically that `G^(2^30) = (−1, 0)` and `G^(2^31) = (1, 0)`, so `G` has order exactly 2³¹.

The key fact is that doubling acts on `x` alone: `π(x) = 2x² − 1`, the Chebyshev polynomial `T₂` (`cos 2θ = 2cos²θ − 1`). It is 2-to-1, sending `x` and `−x` to the same value, so it plays the role of `x ↦ x²` in a classical FFT.

## The domain must be a coset, not a subgroup

The first FFT layer splits a function by the involution `J`:

```text
F(x, y) = f₀(x) + y · f₁(x)
f₀(x) = (F(x,y) + F(x,−y)) / 2
f₁(x) = (F(x,y) − F(x,−y)) / (2y)
```

That divides by `y`. The subgroup of order `N` contains `(1, 0)` and `(−1, 0)`, where `y = 0`, and my run on the 16-element subgroup hit exactly those two points. So the evaluation domain is the **canonic coset** `{ g_{2N} · g_N^k }`, the odd powers of a generator of order `2N`. It is closed under `J`, contains no points with `y = 0`, and its x-projection stays closed under `x ↦ −x` through every later layer.

After the first layer, each half is a function of `x` alone, and the recursion uses `π`:

```text
f(x) = g₀(π(x)) + x · g₁(π(x))
g₀(π(x)) = (f(x) + f(−x)) / 2
g₁(π(x)) = (f(x) − f(−x)) / (2x)
```

Unrolling the recursion gives the circle-FFT basis. For index `j` with bits `j₀ j₁ … j_{n−1}`:

```text
b_j(x, y) = y^{j₀} · x^{j₁} · π(x)^{j₂} · π²(x)^{j₃} ··· π^{n−2}(x)^{j_{n−1}}
```

Here is the inverse FFT, which goes from evaluations to coefficients. The first layer splits on `y`, every later layer on `x`:

```python
def ifft_line(vals, xs):                       # layers 2..n: split on ±x
    if len(vals) == 1:
        return vals
    by_x = dict(zip(xs, vals)); f0 = []; f1 = []; nxt = []
    for x in {min(x, -x % P) for x in xs}:
        a, b = by_x[x], by_x[-x % P]
        f0.append((a + b) * inv(2) % P)
        f1.append((a - b) * inv(2 * x) % P)
        nxt.append((2 * x * x - 1) % P)        # π(x)
    c0, c1 = ifft_line(f0, nxt), ifft_line(f1, nxt)
    return [c for pair in zip(c0, c1) for c in pair]
```

The y-layer is identical but pairs `(x, y)` with `(x, −y)` and divides by `2y`. I evaluated random coefficient vectors against the explicit basis `b_j` on canonic cosets of size 8, 32 and 256, and the inverse FFT recovered them exactly every time. With precomputed twiddles `1/(2x)` and `1/(2y)`, each butterfly costs the same as a classical radix-2 butterfly.

## The dimension discrepancy

Most explanations skip this. The natural space on the circle is `L_N`: bivariate polynomials of total degree `≤ N/2` modulo `x² + y² − 1`. Reduce away every `y²`, and its monomial basis is `{xⁱ : i ≤ N/2} ∪ {y·xⁱ : i < N/2}`. That is `N + 1` functions, but the domain has only `N` points.

I built the 16×17 evaluation matrix on the 16-point canonic coset over `F_p`, and its rank is 16. The one-dimensional kernel is the domain's vanishing polynomial:

```text
v_n(x) = π^{n−1}(x),   degree 2^{n−1} = N/2
```

Its values on all 16 points were 0, as they must be: every canonic-coset point maps to `x = 0` after `n − 1` doublings. The FFT basis can't contain `v_n`, because its pure-x elements reach degree only `1 + 2 + … + 2^{n−2} = N/2 − 1`. So the FFT space is a codimension-1 subspace of `L_N`, and `L_N = FFT-space ⊕ span(v_n)`.

The paper deals with this explicitly, which is why circle-STARK quotients need extra care at the top degree. Two functions in `L_N` can agree on every domain point and still differ by a multiple of `v_n`. Code that treats "N evaluations" and "an element of `L_N`" as the same thing will be wrong by exactly one dimension.

## Circle FRI

The low-degree test reuses the FFT layers, combining halves with a verifier challenge `α`:

```text
layer 0:   F'(x)    = f₀(x) + α₀ · f₁(x)          (pairs P, J(P))
layer k:   F'(π(x)) = g₀(π(x)) + α_k · g₁(π(x))   (pairs x, −x)
```

On a 256-point canonic coset, a rate-1/4 codeword (64 nonzero FFT coefficients) folds down to a constant on the final 4 points. Changing one of the 256 symbols by +1 makes the final layer non-constant. That is the gap FRI's queries sample.

## Out-of-domain sampling needs two points

DEEP-ALI proves the trace's value at a random out-of-domain point `ζ` with a quotient. On a line you divide by `(X − ζ)`, but no line meets a conic at exactly one point (tangents count twice). So circle STARKs open `ζ` and its conjugate together: subtract an interpolant through both values and divide by the line through the two points. Challenges live in the degree-4 extension QM31 (`i² = −1`, `u² = 2 + i`; 5 is a non-residue mod p, so this is irreducible), so the 2³¹-element base field never limits soundness.

## The speed side: how much does M31 buy?

The 1.4× figure is end-to-end. Here is the arithmetic underneath it. I wrote both reductions in C:

```c
static inline uint32_t m31_mul(uint32_t a, uint32_t b) {
    uint64_t t = (uint64_t)a * b;
    uint32_t r = (uint32_t)(t & 0x7fffffff) + (uint32_t)(t >> 31);
    return r >= 0x7fffffff ? r - 0x7fffffff : r;
}
static inline uint32_t bb_mont(uint32_t a, uint32_t b) {     // BabyBear, R = 2^32
    uint64_t t = (uint64_t)a * b;
    uint32_t m = (uint32_t)t * 2013265919u;                   // −p⁻¹ mod 2³²
    uint32_t r = (uint32_t)((t + (uint64_t)m * 2013265921u) >> 32);
    return r >= 2013265921u ? r - 2013265921u : r;
}
```

Both matched a `%`-based reference on 10⁷ random pairs. I timed them on an arm64 laptop (clang `-O3 -mcpu=native`, 2¹⁶-element arrays, 2,000 passes):

```text
                          M31     BabyBear   ratio
throughput, scalar*      1.55 ns   1.90 ns   1.23×
latency (dep. chain)     2.94 ns   4.74 ns   1.61×
throughput, autovec      0.51 ns   1.68 ns   3.2×
* -fno-vectorize -fno-slp-vectorize
```

The 3.2× is a compiler artifact: clang vectorizes the shift-and-add M31 reduction for free but leaves Montgomery mostly scalar, since NEON has no direct 32×32→high-32 multiply. Hand-written NEON Montgomery (Plonky3 uses `vqdmulh`) closes much of that gap. The honest numbers are the scalar 1.2–1.6×. They bracket the paper's 1.4×, which fits a prover that mixes throughput-bound butterflies with latency-bound chains. The win isn't the circle itself. It's that the circle lets you use the cheapest-reduction field at all.

## What to take away

- **2-adicity can come from `p + 1`.** Any such prime gets a full radix-2 FFT through the circle group, with `π(x) = 2x² − 1` in place of squaring.
- **The domain must be a coset.** The subgroup contains the `y = 0` points, and the first fold divides by `y`.
- **The FFT space is `N`-dimensional inside an `(N+1)`-dimensional `L_N`.** The missing direction is `π^{n−1}(x)`, and degree bookkeeping must account for it.
- **The speedup is field arithmetic.** It's 1.2–1.6× per multiply when both fields are compiled the same way, consistent with the end-to-end 1.4×, and well below what autovectorized microbenchmarks suggest.
