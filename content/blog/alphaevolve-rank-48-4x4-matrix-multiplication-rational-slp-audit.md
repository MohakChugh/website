---
title: "AlphaEvolve's 48-Multiplication 4×4 Matmul, Audited: Exact, Dense, and Only Worth It as One Level in a Hybrid"
date: 2026-11-02
tags: [algorithms, matrix-multiplication, numerical-analysis, alphaevolve, linear-algebra]
excerpt: "I verified AlphaEvolve's rank-48 decomposition of 4×4 complex matmul exactly, plus six rational rank-48 variants published by Dumas, Pernet and Sedoglavic. My own straight-line-program count reproduces their 347/32 leading constant, and their 201-op variant gets it down to 233/32. Under full recursion, that constant only beats Strassen–Winograd above n ≈ 450,000. Used as one level in a hybrid, it saves flops from n = 128 (3.0% at 1024, 6.0% at 8192). The cheapest variant is 8× less accurate than Strassen² in float32. In numpy on an M3 Pro, its additions eat the saved GEMM: 0.92× of plain GEMM at n = 8192, against 1.20× for Strassen²."
---

# AlphaEvolve's 48-Multiplication 4×4 Matmul, Audited

In May 2025, DeepMind's AlphaEvolve report claimed a way to multiply two 4×4 **complex** matrices using 48 scalar multiplications. That is one fewer than the 49 you get by applying Strassen's 2×2 algorithm twice, and the first improvement in that setting since 1969. On 16 June 2025, the day the report reached arXiv (2506.13131), Dumas, Pernet and Sedoglavic (arXiv 2506.13242) posted a **rational** version. It drops the complex numbers, works over any ring where 2 is invertible, and comes with optimized straight-line programs.

Headlines stop at "48 < 49". I downloaded the published coefficients and checked what matters to kernel writers: exactness, addition cost, flop crossover, float accuracy, and wall clock.

## Background: a matmul algorithm is a tensor decomposition

Multiplying 4×4 matrices is a fixed tensor T of shape (16, 16, 16). A rank-R decomposition writes T as a sum of R outer products u_r ⊗ v_r ⊗ w_r. Each term is one multiplication: combine A's entries with u_r, combine B's entries with v_r, multiply, and scatter into C with weights w_r. Entries can be blocks, so it recurses at cost O(n^(log₄ R)): log₄ 49 = 2.8074 (= log₂ 7) and log₄ 48 = 2.7925.

AlphaEvolve's factors only use {0, ±½, ±½i, ±½±½i}, so doubling them gives Gaussian integers and an exact int64 check:

```python
# U, V, W: (16, 48) complex factors from the AlphaEvolve notebook
T = np.zeros((16, 16, 16), dtype=np.int64)
for i, j, k in itertools.product(range(4), repeat=3):
    T[i*4+j, j*4+k, k*4+i] = 1          # C is indexed transposed: (k, i)

Ui, Vi, Wi = (np.round(2*X) for X in (U, V, W))   # Gaussian integers
e = lambda a, b, c: np.einsum('ir,jr,kr->ijk', a, b, c)
re = e(Ui.real, Vi.real, Wi.real) - e(Ui.real, Vi.imag, Wi.imag) \
   - e(Ui.imag, Vi.real, Wi.imag) - e(Ui.imag, Vi.imag, Wi.real)
assert (re == 8*T).all()                  # 2·2·2 = 8; imaginary part checks to 0
```

The check passes. I also checked six rational variants from the authors' PLinOpt repository (`rational`, `accurate`, `sparse`, `canonical`, `201`, `201-balanced`). Each one rebuilds the 4×4×4 tensor exactly in `Fraction` arithmetic. The `rational` variant uses coefficients {0, ±1, ±½, ±¼, ±⅛}. The others use {0, ±½, ±1, ±2}, and `accurate` adds ±¾.

## The hidden cost: the decomposition is dense

The fewer nonzeros a factor has, the fewer block additions each multiplication needs. AlphaEvolve's factors are dense:

| Scheme | nnz(U) / nnz(V) / nnz(W) | avg nnz per column of U |
|---|---|---|
| Strassen² (rank 49) | 144 / 144 / 144 | 2.9 |
| AlphaEvolve (rank 48, complex) | 512 / 384 / 480 | 10.7 |
| DPS `sparse` (rank 48, rational) | 202 / 202 / 220 | 4.2 |

Evaluated naively (one add per extra nonzero, one extra add for each ±1±i coefficient once the ½ is factored out), AlphaEvolve's scheme needs **1,544 complex block operations per level**. Strassen² needs 318 naively and 165 with Winograd's shared subexpressions.

AlphaEvolve's scheme is also only useful when the inputs are already complex. On real inputs, every linear combination becomes complex, and each of the 48 products costs 3 real multiplications even with Gauss's trick. That is 144, which is worse than 49.

Even for complex inputs the gain is small: the 3M method plus Strassen² needs 3 × 49 = 147 real block products, against 48 × 3 = 144. The rational DPS scheme also gets 144, with no complex coefficients.

## Reproducing the 347/32 constant, and finding 201

Leading constants for recursive algorithms come from the number of block additions per level, call it a. For a 4×4 scheme with R products, recursing all the way down to 1×1:

```
T(n) = R·T(n/4) + a·(n/4)²   ⇒   T(n) ≈ (1 + a/(R − 16)) · n^(log₄ R)
```

As a sanity check, Strassen–Winograd applied twice is R = 49 and a = 7·15 + 4·15 = 165, which gives the known 6·n^2.807.

I parsed the authors' `.slp` files, counted every add, subtract and scaling, and evaluated each program symbolically to confirm it matches its `.sms` matrices.

| Variant | L + R + P ops | Leading constant |
|---|---|---|
| `rational` | 108 + 76 + 131 = **315** | **347/32** = 10.84 |
| `accurate` | 84 + 76 + 124 = 284 | 79/8 = 9.88 |
| `sparse` | 65 + 65 + 100 = 230 | 131/16 = 8.19 |
| `201` | 55 + 57 + 89 = **201** | **233/32** = 7.28 |

The `rational` row matches the 347/32 in the paper's abstract exactly. The repository also contains a newer 201-operation program that lowers the constant to 7.28. That is still worse than Strassen–Winograd's 6.

So the asymptotic comparison is close. The exponent gap is only log₄49 − log₄48 = **0.01487**. At that slope:

- the 201-op variant overtakes 6·n^2.807 at **n ≈ 4.5 × 10⁵**
- the 315-op variant overtakes it at **n ≈ 1.9 × 10¹⁷**

Read that way, the result looks useless.

## The constant is the wrong lens: use it as one level in a hybrid

Real implementations switch to classical GEMM at a cutoff. So I wrote a flop dynamic program that, at every power of two, picks the cheapest of: classical, one Strassen–Winograd step, or one DPS step. Then I ran it with and without DPS allowed:

```python
@lru_cache(None)
def f(n, allow_dps, a=201):
    best = 2*n**3 - n**2
    if n % 2 == 0: best = min(best, 7*f(n//2, allow_dps) + 15*(n//2)**2)
    if allow_dps and n % 4 == 0:
        best = min(best, 48*f(n//4, allow_dps) + a*(n//4)**2)
    return best
```

| n | savings, `201` | savings, `rational` (315) |
|---|---|---|
| first n where DPS helps | **128** | 512 |
| 1,024 | 3.04% | 1.08% |
| 8,192 | 6.02% | 3.66% |
| 65,536 | 8.72% | 6.58% |
| 2²⁰ | 12.41% | 10.34% |

The reason is simple. One DPS step replaces two Strassen–Winograd steps:

- DPS: 48·f(m) + 201·m²
- Strassen–Winograd twice: 49·f(m) + 165·m²

DPS wins whenever a subproblem costs more than 36·m² flops. For a classical base case that means m > 18. The asymptotic constant hides this because full recursion spends most of its additions on tiny blocks, where removing one multiplication saves almost nothing. **In flop terms, the rank-48 scheme is a top-level step you can use from moderate sizes, not a replacement for the whole recursion.**

## Numerical accuracy: fewer operations, more error

Fast matmul only guarantees normwise bounds, with a constant per variant. Float32, n = 256, recursion depth L over classical blocks, float64 reference; median ‖E‖/(‖A‖‖B‖) over 8 seeds of N(0,1) inputs:

| Scheme | L = 1 | L = 3 |
|---|---|---|
| classical | 1.81e-8 | — |
| DPS `accurate` | 3.01e-8 | **1.46e-7** |
| Strassen² | 3.86e-8 | 2.71e-7 |
| DPS `rational` | 4.22e-8 | 3.97e-7 |
| DPS `201` | 7.63e-8 | **2.23e-6** |
| DPS `sparse` | 8.06e-8 | 2.58e-6 |

The fewest-ops variant, `201`, is **8.2× less accurate than Strassen²** at three levels and 15× worse than `accurate`, which beats Strassen² at the cost of 83 more operations per level.

On complex64, AlphaEvolve's original scheme lands at 4.63e-7 at L = 3 (one seed). That is between Strassen² (2.97e-7) and DPS `sparse`.

Badly scaled inputs are worse. Scaling A's columns over 10⁻³–10³ and B's rows by the inverses leaves the product well-behaved, but componentwise error max|E|/(|A||B|) jumps from 2.5e-7 (classical) to **≥ 6e-3** for every fast scheme at one level. At three levels it reaches 0.070 (`accurate`), 0.35 (Strassen²) and **1.89** (`sparse`: over 100% error in some entries). That's the usual Strassen-family weakness, but it decides which variant you ship.

## Wall clock: the additions still decide it

My benchmark was float32 on an M3 Pro with Apple Accelerate as the BLAS. I executed the `201` program directly in numpy for one level, then ran BLAS on the 48 sub-products. For comparison I ran two levels of Strassen–Winograd over BLAS, and plain GEMM. Each number is the best of 3 runs:

| n | GEMM | Strassen–Winograd² | DPS-201, one level | 48 bare sub-GEMMs |
|---|---|---|---|---|
| 2,048 | 116 ms | 113 ms (1.02×) | 146 ms (0.79×) | 73 ms |
| 4,096 | 915 ms | 922 ms (0.99×) | 996 ms (0.92×) | 861 ms |
| 8,192 | 7,367 ms | 6,152 ms (**1.20×**) | 8,040 ms (0.92×) | 5,626 ms |

At n = 8,192 the DPS run spends about 2.4 s beyond its 48 GEMMs; Strassen–Winograd² spends about 0.4 s beyond its 49. Memory is the main reason: a flat 48-product schedule keeps 96 combined operand blocks and 48 products live at the same time: 144 × 2048² × 4 B ≈ 2.4 GB at n = 8,192. Strassen recursion is depth-first and holds only a few temporaries.

This unfused numpy version is a lower bound. Fusing each linear combination into GEMM packing would remove most of the overhead, but the DPS step still has to save more bandwidth than its 201 additions cost.

## Takeaways

- **Exact, but prefer the rational versions.** They work on real matrices and match the complex scheme's 144 real multiplications on complex inputs.
- **Under full recursion, 48 < 49 needs n ≈ 450,000** even with the 201-op program.
- **As one hybrid level, it saves 3–9% of flops** for n from 1K to 64K.
- **Pick the variant by accuracy.** The fewest-ops program is 15× worse than `accurate` in float32.
- **Bandwidth decides.** Unfused, 201 additions over 48 live blocks cost more than the saved GEMM; Strassen's 1969 algorithm still wins on this machine.
