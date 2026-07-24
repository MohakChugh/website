---
title: "Microscaling Formats: Why One Shared Exponent per 32 Numbers Changes 4-Bit Training"
date: 2026-07-24
tags: [quantization, low-precision-training, block-floating-point, gpu, llm-training]
excerpt: A single FP32 scale per tensor cannot survive 4-bit quantization, and a scale per element costs as much as the data. Microscaling (MX) formats split the difference — 32 elements share one 8-bit power-of-2 exponent — and that is now silicon in NVIDIA Blackwell tensor cores. The subtle part is not the format. It is that rounding the shared exponent the obvious way silently diverges an 8-billion-parameter pre-training run, and the fix is one direction of a rounding rule.
---

## The granularity dilemma

Every quantization scheme is a negotiation between two failures. Store one scale factor for a whole tensor and a few outlier values stretch the scale until the rest of the tensor collapses into a handful of buckets — the outlier problem that motivates rotation tricks like QuaRot. Store one scale per element and you have not compressed anything: a 4-bit value with a 32-bit scale is worse than FP32.

The interesting design point is in between. What if a small **block** of contiguous elements shared a single scale? Big enough that the scale amortizes to near-zero overhead, small enough that a local outlier only poisons its own block instead of the entire tensor. This is not a new idea — DSP hardware has used *block floating point* for decades, assigning one shared exponent to a group of significands rather than one exponent per number. What is new is that the AI industry standardized a specific variant, put it in an Open Compute Project spec, and NVIDIA shipped it in Blackwell tensor cores.

That variant is **Microscaling (MX)**.

## The anatomy of an MX block

An MX block is boring by design, which is what makes it implementable in hardware:

- **32 elements** per block (this is fixed in the OCP MX v1.0 spec).
- Each element is a narrow float or int: FP8, FP6, FP4, or INT8.
- **One shared scale** of 8 bits, in **E8M0** format.

E8M0 is the key. It is 8 exponent bits, zero mantissa bits — it can only represent powers of two, from roughly 2⁻¹²⁷ to 2¹²⁷, with one code reserved for NaN. Because it has no mantissa, applying the scale is a pure exponent addition (a bit shift on the element's exponent field), not a multiply. The whole format is a lookup plus an add.

The zoo of MX element formats, all sharing the 32-element block and E8M0 scale:

| Format   | Element | Element bits | Bits/block | Amortized bits/element |
|----------|---------|-------------|-----------|------------------------|
| MXFP8    | E4M3 / E5M2 | 8 | 8 + 32·8 = 264 | 8.25 |
| MXFP6    | E2M3 / E3M2 | 6 | 8 + 32·6 = 200 | 6.25 |
| MXFP4    | E2M1    | 4 | 8 + 32·4 = 136 | **4.25** |
| MXINT8   | INT8    | 8 | 264 | 8.25 |

The `E<x>M<y>` naming is exponent bits then mantissa bits. MXFP4's element is **E2M1**: 1 sign bit, 2 exponent bits, 1 mantissa bit. That gives exactly these magnitudes: `{0, 0.5, 1, 1.5, 2, 3, 4, 6}` and their negatives — 15 distinct values plus a signed zero. Sixteen buckets total. You are quantizing a whole hidden dimension into that, one 32-wide block at a time, with only a shared power-of-two to reposition the range.

The amortized cost is what sells it. A per-element FP32 scale would double an FP4 tensor's footprint. The E8M0 scale over 32 elements adds a quarter of a bit. You get most of the dynamic-range benefit of per-element scaling for almost none of the storage.

## Computing the scale (and where it goes wrong)

Encoding a block is mechanical. Take the 32 real values, find the one with the largest magnitude, and choose the shared exponent so that value fits in the element format's range. Concretely, for MXFP8 with an E4M3 element (max representable magnitude 448):

```python
import numpy as np

def to_mxfp8_scale_exponent(block):
    """block: 32 real values. Returns the E8M0 shared exponent (an int)."""
    amax = np.max(np.abs(block))
    if amax == 0:
        return 0
    # We want amax / 2**scale_exp to land within the element format's range.
    # E4M3 largest finite magnitude is 448 = 2**8.807...
    E4M3_MAX_EXP = np.floor(np.log2(448.0))   # = 8
    # Exponent of the block's largest element:
    amax_exp = np.floor(np.log2(amax))
    scale_exp = amax_exp - E4M3_MAX_EXP
    return int(scale_exp)                       # <-- the rounding choice hides here
```

That last subtraction looks innocuous. It is the single most consequential line in the whole scheme, and it is the reason NVIDIA's MXFP8 pre-training recipe (2025) devotes an appendix to *UE8M0 rounding*.

Here is the trap. The true scale you want is `amax / element_max`, a real number. You must round its log₂ to an integer to store it in E8M0. If you round that exponent **down** (floor, i.e. truncate toward `-inf`), the resulting scale `2**scale_exp` can be *smaller* than the exact `amax / element_max`. A scale that is too small means `amax / scale` overshoots the element format's maximum — the largest values in the block **overflow and clamp** to the format max. You are silently destroying exactly the values that determined the scale in the first place.

Conversely, rounding the exponent **up** guarantees the scale is large enough that no element overflows, at the cost of pushing the smallest elements slightly deeper into the low-precision or zero region.

For inference this is a minor accuracy wobble. For **training**, where the same tensors are quantized millions of times and errors compound through gradients, NVIDIA found that the naive choice diverges. Their reported result: with a careful conversion algorithm — the right scale-rounding direction plus round-to-nearest on the elements — MXFP8-E4M3 pre-training **matches the BF16 baseline** on models up to 8B parameters over 15T tokens. With the naive scale computation, loss curves separate. Same format, same hardware, same data. The only difference is which way you round a shared exponent.

The lesson generalizes beyond MX: in block-scaled formats the scale is not a free parameter you set to "roughly right." It sits on the boundary between clamping the largest element and starving the smallest, and the format gives you exactly one integer of control.

## Why 32, and why hardware cares

The block size of 32 is not arbitrary. It matches the granularity that GPU tensor cores can apply a per-block scale *inside* the matmul accumulation without stalling. On Blackwell, the tensor core reads MX operands, applies each block's E8M0 scale as an exponent adjustment during the multiply, and accumulates in higher precision. The scale never becomes a separate FP32 multiply in the critical path — it folds into the existing floating-point datapath as an exponent add. That is why 32 elements sharing one power-of-two scale is a *hardware* decision, not just a numerics one.

It also explains why the finer-grained variants exist. NVIDIA's **NVFP4** groups only 16 elements and uses an E4M3 scale (with mantissa bits) rather than E8M0. Smaller blocks and a scale that can represent non-powers-of-two give more precision per block — useful when 4-bit inference accuracy needs another push — but cost more silicon and more scale storage per element. The MX family is a set of points on the same curve: block size and scale precision traded against overhead.

## When to reach for it

MX formats are a drop-in numeric substrate, not an algorithm you bolt on. The practical decision tree:

- **MXFP8 for training.** This is the current sweet spot on Blackwell-class hardware: roughly half the memory and bandwidth of BF16, matching accuracy *if* you get the scale conversion right. The dominant risk is the rounding subtlety above, so lean on a validated kernel rather than rolling your own encoder.
- **MXFP6 / MXFP4 for inference.** MXFP6 tracks FP32 closely after quantization-aware fine-tuning; MXFP4 trains and infers with a small but real accuracy cost that is closing fast. If you need every bit of 4-bit accuracy, evaluate NVFP4's 16-element blocks against MXFP4's 32.
- **Reach for rotation methods (QuaRot) when your hardware lacks MX support.** Block scaling and rotation attack the same outlier problem from different angles. MX localizes an outlier's damage to its 32-element block; rotation redistributes the outlier's energy across all channels so no single scale is stretched. On MX-native silicon, the format does much of the work the rotation used to.

The deeper shift is that low-precision is no longer a post-hoc compression pass over a model trained in FP32 or BF16. With MX baked into the tensor cores, the narrow format *is* the training format — and the humble, mantissa-free shared exponent, rounded the correct direction, is what makes that safe.
