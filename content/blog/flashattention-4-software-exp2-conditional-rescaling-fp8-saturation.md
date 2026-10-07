---
title: "FlashAttention-4's Softmax Tricks: A Degree-3 exp2 on the FMA Pipe, and a Lagging Max That Saturated FP8"
date: 2026-10-08
tags: ["gpu", "attention", "numerics", "cuda", "llm-inference"]
excerpt: "On a B200 the tensor cores do 8192 FLOPs per clock per SM, while the exp2 unit does 16. FlashAttention-4 (arXiv:2603.05451) shifts some exponentials onto FMA units with a degree-3 polynomial, and skips output rescaling unless the row max grows by more than 2⁸. I rebuilt both in NumPy. The polynomial matches the paper's Table 2 to three digits. It is bit-identical to correctly rounded bf16 on 99.0% of inputs and within 1 ULP on 100%. Without the threshold, 6–95% of row-blocks rescale in my runs; with it, 0–16% do. But its exactness argument assumes P can hold up to 2⁸ without loss. An FP8 E4M3 P can't, and FA4's own issue #2716 hit exactly that."
---

# FlashAttention-4's Softmax Tricks: A Degree-3 exp2 on the FMA Pipe, and a Lagging Max That Saturated FP8

From Hopper to Blackwell, BF16 tensor-core throughput doubled. The unit that computes `exp2` did not. FlashAttention-4 (Zadouri, Hoehnerbach, Shah, Liu, Thakkar, Dao; [arXiv:2603.05451](https://arxiv.org/abs/2603.05451), March 2026) treats that gap as the design problem. It reports up to 1613 TFLOPs/s on a B200 (71% of peak). Beyond the pipelining work, two changes to the forward softmax can be checked on a laptop:

1. A software `exp2` that runs on the FMA pipe, built from Cody–Waite range reduction and a degree-3 polynomial.
2. Conditional rescaling: the output is rescaled only when the row max grows by more than τ = 8 (in log2 units).

I rebuilt both in NumPy, using the coefficients and control flow from the [current CuTe-DSL source](https://github.com/Dao-AILab/flash-attention/tree/main/flash_attn/cute).

## Why exp is the bottleneck: the ratio is 128/d

The paper's roofline uses per-SM, per-clock B200 throughputs: 8192 BF16 MMA FLOPs, 16 MUFU (`exp2`) ops, and 128 bytes of shared-memory reads. For a tile of M queries × N keys with head dimension d, the forward pass costs

```
T_mma = 4·M·N·d / 8192      (QKᵀ and PV)
T_exp = M·N / 16            (one exp per score)
T_exp / T_mma = 128 / d
```

The tile size cancels. At d = 128 the two are tied at 1024 cycles per 128³ tile (Table 1). At d = 64, exp takes **twice** as long as the matmuls, so half of all exponentials would have to leave the MUFU just to tie. A 32/clk MUFU (the paper credits B300 with this) halves every ratio, and the kernel disables emulation on SM103 ("fast native exp2").

The introduction says shared memory and exp "exceed MMA compute by 25–60%", but the paper's own tables give 0% (forward), +30% and +5% (backward, 1-CTA and 2-CTA). I couldn't derive the 60%.

## The emulated exp2

The split is `2^x = 2^⌊x⌋ · 2^frac(x)`. Adding `2²³ + 2²²` in round-down mode leaves ⌊x⌋ in the low mantissa bits. A polynomial evaluates `2^frac` on [0, 1), and an integer shift-and-add places ⌊x⌋ into the exponent field. Here is a transcription of `ex2_emulation` from `utils.py`:

```python
import numpy as np
f32, f64 = np.float32, np.float64
P3 = (1.0, 0.695146143436431884765625, 0.227564394474029541015625,
      0.077119089663028717041015625)          # Sollya fpminimax, relative error, p0 = 1

def fma(a, b, c):  # a*b is exact in f64 for f32 inputs; then round once to f32
    return (a.astype(f64) * b + c).astype(f32)

def ex2_emulated(x):
    x = np.maximum(x.astype(f32), f32(-127.0))
    magic = f32(2**23 + 2**22)
    x_rounded = (np.floor(x.astype(f64)) + f64(magic)).astype(f32)  # add.rm.ftz.f32
    x_frac = x - (x_rounded - magic)                                 # exact, in [0, 1)
    out = np.full_like(x_frac, f32(P3[3]))
    for c in (P3[2], P3[1], P3[0]):
        out = fma(out, x_frac, f32(c))                               # 3 FMAs (Horner)
    bits = (x_rounded.view(np.int32) << 23) + out.view(np.int32)     # shl + add.s32
    return bits.view(f32)
```

Shifting `x_rounded` left by 23 keeps only ⌊x⌋ mod 512, which raises the polynomial's exponent by ⌊x⌋. A source comment notes the add is `add.s32` because it compiles to `LEA` on the ALU pipe; `add.u32` would compile to `IMAD` on the FMA pipe the trick is trying to relieve.

Here are 4M inputs measured against a float64 reference:

| degree | FP32 max rel | FP32 mean rel | bf16 bit-identical | bf16 within 1 ULP |
|---|---|---|---|---|
| 3 | 8.77e-5 | 5.43e-5 | 99.000% | 100% |
| 4 | 3.05e-6 | 1.84e-6 | 99.967% | 100% |
| 5 | 1.44e-7 | 5.48e-8 | 99.999% | 100% |

The FP32 columns match the paper's Table 2 to all printed digits, and nothing changes over the softmax range [−20, 8].

The paper says degree 3 "matches hardware to within 1 BF16 ULP on 99% of inputs". By my measurement, it is **bit-identical** on 99%, and within 1 ULP on every input. That has to hold: a relative error of 8.8e-5 is 22–45× smaller than half a bf16 ULP (2⁻⁹ to 2⁻⁸ relative), so it can only change the rounding of values that sit very close to a rounding boundary. Changing the rounding moves the result by exactly one ULP.

Only some elements are emulated, because of register pressure. From `apply_exp2_convert` and the tuning table, a 128-wide row emulates 18.75% (2-CTA non-causal d = 128), 12.5% (causal d = 128), 6.25% (causal d = 192) or 25% (FP8 causal). At d = 128 the roofline is already tied, so this buys slack for imperfect overlap rather than fixing a deficit.

## Conditional rescaling, and when it's exact

The online softmax keeps a running max `m` and rescales the accumulator `O` by `2^(m_old − m_new)` whenever the max grows. FA4 (Eq. 6) skips the rescale unless `m_new − m_old > τ`. The final `O / ℓ` doesn't depend on the reference value, because the numerator and denominator are both measured against the same stale `m`. The reference only has to keep `P = 2^(s − m)` from overflowing. In the kernel, `SoftmaxSm100.update_row_max` is the whole mechanism:

```python
acc_scale_ = (row_max_old - row_max_new) * scale_log2
if acc_scale_ >= -rescale_threshold:   # max grew by <= tau: keep the stale max
    row_max_new = row_max_old; acc_scale = 1.0
```

I simulated 256 rows × 8192 keys with 128-key blocks, using the kernel's rule. ℓ is summed from FP32 P, and P is cast to the MMA input type before `P @ V`. Each row of the table is a different score distribution. "Rows" counts per-row rescales; "warps" counts how often any of a warp's 32 rows rescales, which is the granularity the paper says it uses to avoid divergence:

| scores (log2 units) | τ=0 rows | τ=0 warps | τ=8 rows | τ=8 warps |
|---|---|---|---|---|
| iid N(0, 1.5²) | 6.2% | 67% | 0% | 0% |
| iid N(0, 6²) | 6.1% | 67% | 0.7% | 19% |
| noise + rise of 24 across keys | 54% | 100% | 3.3% | 35% |
| noise + rise of 96 across keys | 95% | 100% | 16% | 83% |

Under iid scores the running max sets a new record about 1/j of the time at block j, so per-row rescales are already rare. The warp-level "any" rule turns that 6% into 67%, though, so even benign rows pay for rescales without τ. If relevance rises across the key order, τ = 8 saves the most.

In bf16 the output error barely moves: rel-L2 is 0.0016 → 0.0017 for N(0, 1.5²), and 0.0005 → 0.0013 for peaked rows. The peaked increase has a mechanism I didn't expect. With τ = 0, the row's dominant key gets `P = 2⁰ = 1.0` exactly, which bf16 represents with no rounding error. With a lagging max, the dominant P becomes `2^δ` with fractional δ and picks up up to half a ULP of error. A one-shot softmax confirms this: shifting the top P from 1.0 to `2^u`, with u uniform on [0, 1), raises the error from 0.00065 to 0.00159.

## Where "exact" breaks: P in FP8

The exactness argument assumes the cast of P to the MMA dtype can hold values up to `2^τ` without loss. The FP8 path also multiplies P by `2^max_offset` (max_offset = 8) to use the format's upper code points. E4M3 tops out at 448 ≈ 2^8.81, so a stale max lets P saturate. The FP32 denominator still counts the unclamped value, so the output shrinks. That was [issue #2716](https://github.com/Dao-AILab/flash-attention/issues/2716) (July 2026): E4M3 forward error was 2–3× what a quantization model predicted, while E5M2 matched the model. A comment in the fix thread says the FP8 path had been running a rescale threshold of 4. My simulation (rel-L2, P quantized, max_offset = 8) reproduces the pattern:

| scores | E4M3 τ=0 | E4M3 τ=4 | E5M2 τ=0 | E5M2 τ=4 |
|---|---|---|---|---|
| N(0, 1.5²) | 0.025 | **0.188** | 0.050 | 0.053 |
| N(0, 6²) | 0.008 | **0.393** | 0.016 | 0.037 |

E5M2 (max 57344 ≈ 2^15.8) has headroom for 8 + 4 and stays close to its τ = 0 error. Its peaked-row increase is the same dominant-term effect as in bf16, made larger by the 2-bit mantissa. E4M3 saturates. The fix (PR #2717) made the parameters dtype-aware. Current `main` uses τ = 8 only for 16-bit inputs and τ = 0 for FP8, and asserts `max_offset + rescale_threshold < log2(dtype_max)`.

## Takeaways

- **`T_exp/T_mma = 128/d` on B200.** d = 128 is balanced and d = 64 is exp-bound by 2×. Check this ratio before porting the emulation trick.
- **Degree 3 is enough when the result is rounded to bf16:** bit-identical on 99%, never more than 1 ULP off.
- **Lazy rescaling is exact only if the downstream dtype can hold `2^(offset+τ)`.** Turning P's headroom into skipped rescales is safe in bf16 and fp16. Combined with FP8's `max_offset`, that headroom was already used up.
- **A lagging max costs a little in bf16:** the dominant probability is no longer exactly 1.0, giving 2.5× more error on peaked rows.
