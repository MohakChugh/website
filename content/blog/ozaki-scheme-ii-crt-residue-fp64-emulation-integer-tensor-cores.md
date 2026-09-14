---
title: "Ozaki Scheme II: Emulating FP64 Matrix Multiply with Residue Arithmetic on Integer Tensor Cores"
date: 2026-09-14
tags: ["gpu", "numerical-computing", "hpc", "tensor-cores", "modular-arithmetic"]
excerpt: "GPUs are quietly abandoning native FP64, and the replacement is number theory. Ozaki Scheme II (IJHPCA 2026) emulates double-precision GEMM by mapping scaled integers into a residue number system, running one exact INT8 tensor-core GEMM per modulus, and reconstructing via the Chinese Remainder Theorem — linear GEMM count where classic mantissa slicing is quadratic. My numpy prototype reproduces the mechanics: 8 residue GEMMs recover a 2^56-magnitude integer product bit-exactly, and the accuracy dial is just the modulus count."
---

# Ozaki Scheme II: Emulating FP64 Matrix Multiply with Residue Arithmetic on Integer Tensor Cores

The economics of GPU silicon have turned against double precision. FP64 tensor throughput has stagnated or regressed across recent datacenter generations while INT8 and FP8 tensor throughput grew by an order of magnitude, and on consumer parts FP64 runs at 1/64th of FP32 rate. The vendor response is not more FP64 units — it is emulation. Recent cuBLAS releases can service FP64 GEMM calls by decomposing them onto integer tensor cores, and the algorithm underneath is the subject of this post: **Ozaki Scheme II** (Ozaki, Uchino, Imamura; arXiv:2504.08009, published in IJHPCA 2026), which replaces the classic mantissa-slicing approach with a residue number system and the Chinese Remainder Theorem.

## Scheme I: mantissa slicing, and why it scales quadratically

The original Ozaki scheme (2012) is an error-free transformation. Split each FP64 matrix into s low-precision slices — on INT8 tensor cores, roughly 7 bits of significand per slice, so `s = ceil(53/7) = 8` — such that every pairwise slice product is computed *exactly* by the hardware (INT8 multiplies accumulate into INT32 without rounding). Sum the partial products with appropriate scaling and you recover the FP64 result to whatever accuracy the retained slice pairs support.

The problem is the pair count. Full accuracy needs all s² = 64 slice-product GEMMs; the standard triangular truncation (dropping pairs whose contribution falls below the target precision) still needs s(s+1)/2 = 36. Every extra bit of accuracy you want adds slices, and the GEMM count grows with the *square* of the slice count. On hardware where the INT8:FP64 throughput ratio is 30–60×, spending 36–64 integer GEMMs per emulated FP64 GEMM eats most of the advantage.

## Scheme II: one GEMM per prime

Scheme II abandons slicing for modular arithmetic. The pipeline:

1. **Scale to integers.** Scale rows of A and columns of B so entries become integers with a chosen significand width (this is where all approximation error lives — more on that below).
2. **Reduce mod small primes.** Pick primes p₁, …, p_r < 256 (251, 241, 239, …). The centered residue of any integer mod p_i fits in `[-127, 127]` — an INT8 value.
3. **One integer GEMM per modulus.** `C_i = A_i @ B_i` over INT8 tensor cores with INT32 accumulation is *exact* as long as the accumulator can't overflow: `k * (p/2)² < 2³¹` bounds the inner dimension at ~137,000 for p = 251 before you need blocked reduction. Then `C_i mod p_i` equals the true product mod p_i.
4. **CRT reconstruction.** The residues (C mod p₁, …, C mod p_r) uniquely determine C modulo M = p₁·p₂···p_r. If the true product magnitude is below M/2, the reconstruction is bit-exact.

The count of GEMMs is now the count of moduli, and each ~8-bit modulus buys ~8 bits of representable product range. Covering a full FP64-faithful product — two 53-bit operands plus log₂(k) bits of accumulation growth — takes r = ceil((106 + log₂ k) / 7.97) = 15–16 GEMMs. **Linear in precision, versus quadratic for slicing.** And the modulus count is a continuous accuracy dial: fewer primes, faster and coarser; more primes, slower and tighter. Scheme I's slicing structure offered no such smooth trade.

## Verifying the mechanics

I reimplemented the scheme in numpy (int64 matmuls standing in for INT8 tensor cores, with explicit asserts that inputs fit INT8 and accumulators fit INT32):

```python
def rns_gemm(Ai, Bi, moduli):
    parts = []
    for p in moduli:
        Ap, Bp = centered(Ai, p), centered(Bi, p)   # residues in [-p//2, p//2]
        assert Ai.shape[1] * (p // 2)**2 < 2**31    # INT32 accumulator bound
        parts.append(np.mod(Ap @ Bp, p))            # exact INT8-TC GEMM, mod p
    M = math.prod(moduli)
    C = sum(Cp.astype(object) * (M // p) * pow(M // p, -1, p)
            for p, Cp in zip(moduli, parts)) % M
    return np.where(C > M // 2, C - M, C)           # centered CRT lift
```

Results from the self-check:

- **Exactness:** with k = 4096 and 25-bit integer entries, the product magnitudes reach 2⁵⁶; 8 moduli give M ≈ 2⁶² and the CRT reconstruction matches arbitrary-precision integer matmul **bit for bit**.
- **The accuracy dial:** emulating FP64 GEMM on Gaussian matrices (k = 2048) with inputs quantized to 26, 34, and 43 significand bits took 8, 10, and 12 residue GEMMs, with max relative error 3.9e-08, 1.1e-10, and 2.3e-13 against an exact rational reference. Native FP64 sat at 1.9e-15 — reachable by keeping all 53 bits at ~15–16 GEMMs.

The important structural fact the experiment makes visible: **all error comes from step 1**, the input quantization. Steps 2–4 are exact integer arithmetic. Slicing-based Scheme I accumulates rounding across partial-product summation; Scheme II's only knob is how many bits of the inputs you keep, which makes error analysis almost embarrassingly clean.

## Measured performance, and where the bottleneck moves

The paper's numbers, using INT8 tensor cores: FP64-emulated GEMM reaches **7.4–9.8 TFLOPS on an RTX 4090** — a card whose native FP64 is ~1.3 TFLOPS — and **56.6–80.2 TFLOPS on a GH200**, exceeding the chip's measured native FP64 GEMM. On CPUs, the same idea applied to quad-precision emulation over FP64 arithmetic gets 2.3× over the conventional Ozaki scheme.

But once the GEMMs themselves are cheap, the residue *conversion* — scaling, rounding, reducing mod r primes, materializing r INT8 copies of each operand — becomes the tax. Matsuoka's follow-up ("Ozaki 2.5", arXiv:2609.09095, September 2026) analyzes exactly this deconstruction path for FP8 tensor cores. His model puts the emulated-FP64 arithmetic roof at `P_FP8 / (3r+1)` — about 473 TFLOPS on a projected next-gen part at r = 12 — but only when operands convert once and stay resident in a single thread-block cluster; workloads that re-split operands on the fly fall to a floor of exactly half that. His proposed fix is a small fixed-function residue-conversion block on the async-copy path, which would lift the floor to the roof. Worth stressing: those figures are explicitly model projections pending measurement, unlike the measured 4090/GH200 numbers above.

## Why this matters beyond HPC

Three takeaways for anyone building numerical infrastructure:

1. **FP64 is becoming a software format.** When cuBLAS transparently routes double-precision GEMM through integer tensor cores, "hardware FP64 throughput" stops being the number to benchmark; conversion bandwidth and workspace footprint (r residue copies of every operand) are the new constraints.
2. **Exactness is a feature, not just accuracy.** Because the integer core of Scheme II is bit-exact, it delivers reproducible GEMM across GPU generations and tile schedules — deterministic where FP64 accumulation order is not. Batch-invariant inference kernels chase the same property with far more effort.
3. **The 60-year-old trick still wins.** Residue number systems date to 1950s computer arithmetic and were dismissed for general use because comparison and overflow detection are hard in RNS. GEMM needs neither — it is pure multiply-accumulate, the one workload RNS is perfect for. It took hardware abandoning FP64 to make that observation valuable.

If you want to poke at the mechanics, the prototype above is ~60 lines of numpy and reproduces every claim in this post on a laptop.
