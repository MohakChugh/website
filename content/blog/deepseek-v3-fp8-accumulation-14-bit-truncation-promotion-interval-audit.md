---
title: "FP8 Accumulation on Hopper, Audited: What DeepSeek-V3's '14 Bits' Actually Costs, and Why N_C = 128 Is Pinned From Both Sides"
date: 2026-11-20
tags: [gpu, fp8, floating-point, numerical-analysis, llm-training]
excerpt: "The DeepSeek-V3 report says Hopper FP8 tensor cores keep only about 14 bits when they accumulate, that this gives a maximum relative error of 'nearly 2%' at K = 4096, and that copying partial sums to FP32 every 128 products fixes it. I built a bit-level simulator of the mechanism the report describes. With truncation in the register alone, the error is a data-independent shrink toward zero, close to K·7×10⁻⁷ (0.28% at K = 4096). If the accumulator also takes part in the exponent alignment, the error runs from 0.13% to 7% depending on the sign structure of the inputs. Promoting every 128 products brings every case down to 1–5×10⁻⁴. The 128 is also squeezed from both sides: quantization groups cap it from above, and CUDA-core throughput sets a floor from below."
---

Section 3.3.2 of the *DeepSeek-V3 Technical Report* (arXiv:2412.19437) is about how many bits survive the *addition* in an FP8 GEMM. Its claims, quoted from the PDF:

- "the accumulation precision of FP8 GEMM on NVIDIA H800 GPUs is limited to retaining around 14 bits"
- for K = 4096 random matrices, this "results in a maximum relative error of nearly 2%"
- the fix: every N_C elements, partial results are "copied to FP32 registers on CUDA Cores", and "setting N_C = 128 elements, equivalent to 4 WGMMAs, represents the minimal accumulation interval that can significantly improve precision without introducing substantial overhead."

Section 3.5.2 gives the mechanism: "After aligning 32 mantissa products by right-shifting based on the maximum exponent, the Tensor Core only uses the highest 14 bits of each mantissa product for addition, and truncates bits exceeding this range. The accumulation of addition results into registers also employs 14-bit precision."

That is precise enough to simulate, so I did.

## A bit-level model of the accumulator

Two FP8 E4M3 values have 4-bit significands, so their product is exact in 8 significant bits. One FP8 WGMMA k-step consumes 32 products per output element. The report describes two places where bits are lost:

1. **Alignment truncation.** The 32 products are right-shifted to the largest exponent, and only the top 14 bits, counting the leading bit, are kept. The quantum is `2^(e_max − 13)`. Anything finer is cut.
2. **Register truncation.** The running sum is stored with 14-bit precision.

The text leaves one detail open: whether the running accumulator takes part in step 1's alignment. I simulated both. "Sep" aligns only the 32 products and rounds the register separately. "Joint" puts the accumulator into the max-exponent alignment as a 33rd addend.

```python
def trunc(x, q):  # round toward zero to a multiple of q
    return np.sign(x) * np.floor(np.abs(x) / q) * q

def ulpq(x, p):   # quantum of a p-bit significand at x's binade
    a = np.abs(x)
    return 2.0 ** (np.floor(np.log2(np.where(a > 0, a, 1.0))) - (p - 1))

def gemm(A, B, p=14, NC=128, mode="sep"):
    M, K = A.shape; N = B.shape[1]
    out = np.zeros((M, N), np.float32); acc = np.zeros((M, N))
    for k0 in range(0, K, 32):
        P = A[:, None, k0:k0+32] * B.T[None, :, k0:k0+32]   # exact FP8 products
        if mode == "sep":
            q = ulpq(np.abs(P).max(-1), p)[..., None]
            t = acc + trunc(P, q).sum(-1)
        else:  # accumulator joins the alignment
            q = ulpq(np.maximum(np.abs(P).max(-1), np.abs(acc)), p)
            t = trunc(P, q[..., None]).sum(-1) + trunc(acc, q)
        acc = trunc(t, ulpq(t, p))                           # 14-bit register
        if (k0 + 32) % NC == 0:                              # promotion to FP32
            out = (out + acc.astype(np.float32)).astype(np.float32); acc[:] = 0
    return out + acc.astype(np.float32)
```

The inputs are 64×64 output tiles with E4M3-quantized operands, round-to-nearest-even with saturation at 448. The reference is the exact float64 product *of the quantized operands*, so this measures accumulation error only, not quantization error. There are two input distributions: zero-mean Gaussian (`randn`) and all-positive uniform (`rand`).

## Result 1: register truncation is a multiplicative leak

In the "sep" model, the error barely depends on the data. Relative Frobenius error, no promotion:

| K | randn | rand | closed form K·6.9×10⁻⁷ |
|---|---|---|---|
| 512 | 3.7×10⁻⁴ | 3.9×10⁻⁴ | 3.5×10⁻⁴ |
| 4096 | 3.1×10⁻³ | 2.9×10⁻³ | 2.8×10⁻³ |
| 16384 | 1.25×10⁻² | 1.15×10⁻² | 1.13×10⁻² |

The closed form follows from the rounding rule. Each register write truncates toward zero. For a value `m·2^e` with significand m in [1, 2), the expected loss is half a quantum, `2^(e−14)`. Relative to the value that is `2^-14/m`. With significands spread log-uniformly, `E[1/m] = 1/(2 ln 2) = 0.721`, so each write leaks about 4.4×10⁻⁵ of the accumulator's magnitude. There are K/32 writes, and for a growing sum the average write happens at half the final magnitude. The total relative loss is `(K/32)/2 · 4.4×10⁻⁵ ≈ K · 6.9×10⁻⁷`, which matches the simulation within 10% for both distributions.

Truncation toward zero always shrinks the accumulator, so the error has a sign as well as a size. On all-positive inputs, 100% of outputs come out smaller than the reference. On zero-mean inputs it is 84%, with a mean signed error of −1.4×10⁻³. This is a bias, not noise that averages out: every large-K output is pulled toward zero by a K-proportional fraction.

## Result 2: alignment truncation depends on how far the sum outgrows its addends

The "joint" model behaves differently:

| K = 4096, no promotion | randn | rand |
|---|---|---|
| sep | 3.1×10⁻³ | 2.9×10⁻³ |
| joint | 1.3×10⁻³ | **6.9×10⁻²** |

When the accumulator sets the alignment exponent, each product is shifted right by about log₂(|acc|/|product|). A product carries 8 significant bits, so a 14-bit window holds it exactly until the accumulator is 2^(14−8) = 64× larger than a typical addend. Past that point every product loses low bits, always toward zero. Zero-mean sums grow like √K, and at K = 4096 they only just reach the 64× limit. All-positive sums grow like K and blow straight through it. At K = 4096 the sum is about 4096× a typical addend, about 6 bits past the limit, and 7% of the result is lost.

Sweeping the window width confirms the 2× per bit you would expect: 23% at 12 bits, 13% at 13, 7.0% at 14, 3.3% at 15, 1.5% at 16.

## So where does "nearly 2%" come from?

Neither model produces 2% at K = 4096 under a well-defined metric. The register-only model gives 0.28%, and would need K ≈ 29k to reach 2%. The joint model gives 0.13% on zero-mean data and 7% on positive data, so 2% sits inside that range, but nothing in the report says where. The word "maximum" doesn't help either. On zero-mean matrices the largest *element-wise* relative error was 820% in my runs, because some outputs land near zero. The 99th percentile was 2.9% (joint) and 7.4% (sep).

My reading: "nearly 2%" depends on a metric and input distribution the report doesn't state, and the §3.5.2 mechanism spans 0.1–7% at that K. The scaling holds in every case: error is linear in the number of truncating writes and doubles for every bit the window loses.

## Result 3: promotion turns K-dependence into N_C-dependence

Promotion resets the 14-bit accumulator every N_C products, so growth only ever spans N_C, not K. Relative Frobenius error at K = 4096:

| N_C | 32 | 64 | 128 | 256 | 512 | 4096 (none) |
|---|---|---|---|---|---|---|
| sep, randn | 5.0×10⁻⁵ | 6.6×10⁻⁵ | 1.0×10⁻⁴ | 1.9×10⁻⁴ | 3.7×10⁻⁴ | 3.1×10⁻³ |
| sep, rand | 4.4×10⁻⁵ | 6.9×10⁻⁵ | 1.1×10⁻⁴ | 2.0×10⁻⁴ | 3.8×10⁻⁴ | 2.9×10⁻³ |
| joint, randn | 5.0×10⁻⁵ | 7.8×10⁻⁵ | 1.3×10⁻⁴ | 2.1×10⁻⁴ | 3.4×10⁻⁴ | 1.4×10⁻³ |
| joint, rand | 4.4×10⁻⁵ | 1.4×10⁻⁴ | 4.8×10⁻⁴ | 1.8×10⁻³ | 5.4×10⁻³ | 6.9×10⁻² |

At N_C = 128, every case lands between 1×10⁻⁴ and 5×10⁻⁴, a 10–140× improvement. The error no longer depends on K at all. Sep at N_C = 128 measured 1.02×10⁻⁴ at K = 512, 4096 and 16384 alike. The worst case is still joint on positive data. Four k-steps is 128 products, one bit past the 64× limit, which is why that row rises fastest. N_C = 64 would sit right at the limit.

## Why 128, and not 64 or 256

The report calls 128 "minimal" without overhead. Two separate constraints back that up.

**The upper bound is the quantization layout.** DeepSeek-V3 scales activations per 1×128 tile and weights per 128×128 block, so the scale factor changes every 128 elements along K. The hardware accumulator has no per-element scale, so products from two scale groups can't share one partial sum. The scales are "multiplied on the CUDA Cores as the dequantization process" at promotion time. N_C > 128 would mean changing the quantization granularity, so N_C ≤ 128 follows directly.

**The lower bound is CUDA-core throughput.** Each promotion costs every output element about 1–2 FP32 instructions: a fused multiply-add of the partial sum by the combined scale, plus an amortized scale product. In between, the tensor cores do N_C multiply-accumulates for that element. Using H800 dense peaks (about 1,979 TFLOPS FP8, 67 TFLOPS FP32), the CUDA-core time divided by the tensor-core time is:

| N_C | 32 | 64 | 128 | 256 |
|---|---|---|---|---|
| 1 FP32 instr/elem | 0.92 | 0.46 | 0.23 | 0.12 |
| 2 FP32 instr/elem | 1.85 | 0.92 | 0.46 | 0.23 |

At N_C = 32, the promotion alone takes about as long as the matmul, or longer. At 64 it is within 10% of parity under the 2-instruction count. 128 is the first power of two where the epilogue fits in less than half the tensor-core time, and that headroom is what the report's two-warpgroup ping-pong needs to hide it ("while one warpgroup performs the promotion operation, the other is able to execute the MMA operation"). These are peak-rate ratios; register moves and issue contention only make small N_C worse.

So the quantization layout caps N_C at 128, and the throughput ratio rules out anything much below it. N_C = 128 is the only power of two that satisfies both.

## Takeaways for anyone writing FP8 GEMMs

- **Count truncating writes, not K.** With truncate-toward-zero accumulation, the error is about (writes/2)·0.72·2^-p and biased toward zero. Promotion bounds the number of writes.
- **Test with same-sign data.** Zero-mean random matrices hide alignment truncation almost completely (0.13% vs 7% here). Post-activation tensors and gradient sums with a non-zero mean are the cases that hit it.
- **Headroom is the window minus the product width.** A 14-bit window over 8-bit FP8 products gives 6 bits, or 64× growth, before same-sign addends start losing bits. That number, not "14 bits vs FP32's 24", is what limits the interval.
- **Make the promotion interval equal the scale-group size.** Dequantization and promotion then happen in one step, as in DeepSeek's open-source DeepGEMM kernels.

Everything above is about 60 lines of numpy that run in under ten seconds, which is a cheap way to bound accumulation error before committing to a training run.
