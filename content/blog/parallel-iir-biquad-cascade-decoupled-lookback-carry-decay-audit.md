---
title: "Parallel IIR Filtering, Audited: Decoupled Look-Back on a Biquad Cascade, and Why the Carry Decays Before It Travels"
date: 2026-11-19
tags: [gpu, signal-processing, parallel-algorithms, numerical-analysis, simulation]
excerpt: "A July 2026 paper runs cascaded biquad IIR filters at 38.2 GS/s on an RTX 3060. It splits each group's output into a zero-state response plus a homogeneous correction, then chains the carries with decoupled look-back. I rebuilt the scheme in numpy and confirmed the paper's direct-form failure (a pole at radius 1.0057 at order 16). On the paper's benchmark filter, a look-back depth of 1 is already exact. The samples needed for the carry to fall below float32 precision follow W ≈ 16.6/(1 − r_max), and depth only matters for narrowband filters. That is roughly where float32 itself starts failing the paper's accuracy gate."
---

A recursive (IIR) filter is a loop-carried dependency: `y[n]` needs `y[n−1]` and `y[n−2]`. It can still be parallelized because the recurrence is linear. Zhai and Paris, *Parallel Cascaded Recursive Filtering on Multi-Core CPUs and GPUs* (arXiv:2607.23763, July 2026), runs a cascade of second-order sections, the form IIR filters are deployed in, as one GPU kernel. It reaches 38.2 GS/s on an RTX 3060 (85% of the bandwidth roof) and 15.8 GS/s at order 16.

I reimplemented the algebra, checked the numerical claims, and then measured something the paper doesn't: how much work the state-propagation protocol does on the filters it benchmarks.

## The algebra: superposition plus an affine carry

Each biquad computes `y[n] = x[n] + b1·x[n−1] + b2·x[n−2] − a1·y[n−1] − a2·y[n−2]`. Split the signal into groups of C samples. Because the filter is linear, a group's output is the sum of two parts:

- **zero-state response**: the group filtered from a zero initial state. It needs nothing from other groups and can run immediately.
- **homogeneous correction**: `H · z_in`, where `z_in` is the 2-element state carried in from the previous group and H is a fixed C×2 matrix that depends only on the coefficients.

The state leaving a group is affine in the state entering it: `z_out = Φ · z_in + z_local`. Here Φ is the 2×2 transition matrix over C samples and `z_local` is the group's zero-state terminal state. Affine maps compose associatively, which is the same property a prefix scan relies on. That makes Merrill and Garland's decoupled look-back from single-pass GPU scans applicable here.

Each thread block takes a ticket from an atomic counter and publishes its `z_local`. It then walks back through its predecessors, composing their local carries through Φ, until it finds one that has published a resolved carry. Then it applies the correction and moves to the next section. All K sections stay in registers.

Here is the scheme in numpy, with a cap on look-back depth so its effect can be measured:

```python
import numpy as np, scipy.signal as ss

def cascade_superposition(sos, x, C, depth):
    G = len(x) // C
    sig = x.reshape(G, C)
    for b0, b1, b2, _, a1, a2 in sos:
        b, a = [b0, b1, b2], [1, a1, a2]
        y0, zl = np.empty_like(sig), np.empty((G, 2))
        for c in range(G):                      # parallel across groups
            y0[c], zl[c] = ss.lfilter(b, a, sig[c], zi=np.zeros(2))
        H, Phi = np.empty((C, 2)), np.empty((2, 2))
        for k in range(2):                      # homogeneous basis + transition
            e = np.eye(2)[k]
            H[:, k], Phi[:, k] = ss.lfilter(b, a, np.zeros(C), zi=e)
        z = np.zeros((G, 2))
        for c in range(1, G):                   # look-back, capped at `depth`
            P = np.eye(2)
            for j in range(1, min(depth, c) + 1):
                z[c] += P @ zl[c - j]
                P = P @ Phi
        sig = y0 + z @ H.T                      # homogeneous correction
    return sig.reshape(-1)
```

With full depth this matches `scipy.signal.sosfilt` to a relative error of 2e-15. In float32 it matches a sequential float32 cascade to the printed digits (6.2e-7 against 6.2e-7 at order 16), so the reordering costs no accuracy.

## The paper's numerical claims check out

The benchmarks use Butterworth low-pass filters at cutoff 0.2π, orders 2 to 16, in float32, with an accuracy gate of 1e-4 relative error against a float64 reference. The baseline is a parallel linear-recurrence engine that works in direct form. The paper says direct form is rounding-limited at order 8 and diverges at order 16. Rounding the direct-form coefficients to float32 and filtering in float64 shows the same thing:

| order @ 0.2π | max pole radius, exact | max pole radius, float32 direct form | direct-form error | cascade (float32 coefficients) error |
|---|---|---|---|---|
| 4 | 0.795449 | 0.795449 | 3.8e-7 | 2.1e-7 |
| 8 | 0.891208 | 0.891229 | **1.29e-4** | 9.2e-8 |
| 16 | 0.943955 | **1.005653** | diverges | 1.3e-7 |

At order 8 the coefficients alone exceed the gate, and at order 16 a pole leaves the unit circle, exactly as the paper says.

The cost-model figures also hold. The roofs are 256/8 = 32 GS/s and 360/8 = 45 GS/s, so 38.2 GS/s is 84.9% of the RTX 3060 roof. The hiding floor `⌈I·λ/ILP⌉` gives 8 warps on Pascal and 6 on Ampere. The order-16 GPU rate is 15.8/2.4 = 6.6× the CPU rate.

## What the look-back actually propagates

Φ is a power of each section's companion matrix, so its magnitude is roughly r^C, where r is the pole radius. At 0.2π and order 16, r_max = 0.944, which makes r^4096 about 1e-103. Even for the smallest group size, C = 1024, r^C is about 1e-26. Composing a carry through any intervening group therefore multiplies it by a number far below float32 precision.

Capping the depth shows this directly. At order 16 and 0.2π, depths of 1, 2, 4 and 23 all give about 2e-15, for C = 1024 and C = 4096. **On every filter the paper benchmarks, a group's incoming state equals its predecessor's local carry to machine precision.** The walk is correct, but everything past the immediate predecessor has already decayed.

How quickly does it decay? I measured W, the overlap a group needs so that the influence of earlier state falls below 2⁻²⁴ of the output peak, using white-noise input. W turns out to depend almost entirely on the pole closest to the unit circle:

```
W ≈ 24·ln 2 / (−ln r_max) ≈ 16.6 / (1 − r_max)
```

At order 16 it predicts 288 samples at 0.2π (measured 288) and 5,403 at 0.01π (measured 5,344). Across the grid it is within ±3%. The depth required is roughly ⌈W/C⌉, which a capped-depth sweep confirms:

| order | cutoff | W (2⁻²⁴) | depth @ C=1024 | depth @ C=4096 | float32 cascade error | passes 1e-4 gate? |
|---|---|---|---|---|---|---|
| 16 | 0.2π | 288 | 1 | 1 | 5.7e-7 | yes |
| 16 | 0.05π | 1,080 | 2 | 1 | 7.6e-6 | yes |
| 16 | 0.02π | 2,736 | 3 | 1 | 2.8e-5 | yes |
| 8 | 0.01π | 2,712 | 3 | 1 | 5.7e-5 | yes |
| 16 | 0.01π | 5,344 | 6 | 2 | 1.1e-4 | **no** |
| 2 | 0.005π | 1,536 | 2 | 1 | 2.0e-4 | **no** |
| 16 | 0.005π | 10,976 | 11 | 3 | 6.5e-4 | **no** |

The last column is the catch. That error is from a plain sequential float32 cascade. As the cutoff narrows, poles approach the unit circle, which raises the look-back depth and also amplifies float32 rounding. In the full 20-filter grid at C = 4096, every filter that passes the gate needs a depth of only 1. Every filter needing a depth of 2 or more has already failed in float32. Deep look-back does become necessary, but mainly in the same narrowband regime where you would move to float64 or an error-feedback biquad structure anyway. At C = 1024 the window is wider: depths up to 3 still pass.

## The alternative this suggests: overlap warm-up

If the state has decayed after W samples, a group can skip the protocol altogether. Start each group W samples early, filter from zero state, and discard the warm-up output. Groups then share no flags or tickets, and nothing spins on a predecessor. That matters on GPU APIs that don't guarantee forward progress between workgroups, where such a spin can deadlock.

The cost is W/C of extra work: at C = 4096 and 0.2π, 1.0% at order 2 and 7.0% at order 16. At order 2 the kernel is memory-bound, so 1% is in the noise. At order 16 it runs at 35% of the roof, limited by latency rather than bandwidth, so 7% more arithmetic costs about 7%. That is more than look-back's few operations per predecessor. At 0.01π the overlap reaches 130% and stops making sense.

My reading is that the paper made the right engineering choice: look-back is cheap, exact for any filter, and has no cliff. But in its benchmark regime two simpler designs give the same results. One is depth-1 look-back, which waits only on the predecessor's local carry. The other is a 1–7% overlap. A library could pick between them per filter from one number, r_max, known at design time.

## Takeaways

- **Superposition is exact.** In float32 it matches a sequential cascade.
- **The direct-form failure has a precise cause.** Float32 coefficients move the largest order-16 pole from 0.944 to 1.0057.
- **The carry decays in about 16.6/(1 − r_max) samples.** When that is shorter than a group, depth-1 look-back is exact, which covers every configuration the paper benchmarks.
- **Deep look-back and float32 failure arrive together**, because both come from poles approaching the unit circle.

All tables come from scripts run with scipy 1.17 and numpy 2.4. The GPU throughput figures are as the paper reports them.
