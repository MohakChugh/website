---
title: "QTIP: Trellis-Coded Quantization Puts 2-Bit LLM Weights 10% Above the Rate-Distortion Bound, and a Monotone Codebook Loses to Scalar Rounding"
date: 2026-10-08
tags: ["quantization", "llm-inference", "information-theory", "compression", "gpu"]
excerpt: "Vector quantizers for LLM weights stop at 8 dimensions because the codebook has to fit in cache. QTIP (NeurIPS 2024) uses trellis-coded quantization instead: a 256-dimensional quantizer whose decoder is a bit shift plus three ALU instructions. I wrote a bitshift-trellis Viterbi quantizer from scratch. It reproduces the paper's 2-bit Gaussian MSEs to within 0.001 (0.0697 vs 0.069, and 0.0723 vs 0.0733 for the tail-biting table). It also shows the failure the paper only plots: a codebook that is monotone in the state index gets 0.143 MSE, worse than the 0.118 of a plain 4-level scalar quantizer, at every trellis size."
---

# QTIP: Trellis-Coded Quantization Puts 2-Bit LLM Weights 10% Above the Rate-Distortion Bound, and a Monotone Codebook Loses to Scalar Rounding

Batch-1 LLM decoding is bandwidth-bound, so weight-only quantization speeds it up roughly in proportion to how much it shrinks the weights. The best 2-bit methods, QuIP# and AQLM, use **vector quantization**: round d weights at once to the nearest of 2^(k·d) codewords. Higher d gives better shaping, but the codebook grows exponentially. At k=2, d=8 that's 65,536 vectors; AQLM's 1 MiB codebook misses L1, and QuIP#'s E8 lattice only fits because it compresses 256×.

[QTIP](https://arxiv.org/abs/2406.11235) (Tseng, Sun, Hou, De Sa; NeurIPS 2024) avoids the exponential with **trellis-coded quantization (TCQ)**, an idea from 1990s signal coding: 256 weights quantized jointly, each decoded with a shift and a few integer instructions. I reimplemented the core in numpy to check the numbers.

## The trellis: a stateful codebook

A (L, k, V) trellis has 2^L states, each holding a value. Quantizing a sequence means picking a **walk**; each step goes to one of 2^k successors, so it costs k bits regardless of L, and the reconstruction is the state values along the walk. The min-MSE walk is a shortest path: Viterbi finds it in O(2^L · T), versus 2^(kT) for brute force over a T-dimensional codebook.

Classic TCQ needs the transition graph and a 2^L-entry codebook in memory, and decodes serially, since state t depends on every earlier bit. QTIP fixes both with the **bitshift trellis** (from Mao and Gray's random-permutation trellis coder). State j follows state i exactly when the top L−k bits of j equal the bottom L−k bits of i. In other words, the state is a sliding L-bit window over the bitstream:

```python
def decode(bits: int, nbits: int, t: int, L: int, k: int, code) -> float:
    # stream read MSB-first; weight t sees only bits [t*k, t*k + L) -- no graph, no serial walk
    window = (bits >> (nbits - L - t * k)) & ((1 << L) - 1)
    return code(window)
```

Every weight is an independent window, so decode is parallel and graph-free. Encoding is a Viterbi pass whose predecessor set is computed with shifts:

```python
import numpy as np

def viterbi_bitshift(s, C, L, k):
    N, T = 2**L, len(s)
    j = np.arange(N)
    # predecessors of j: shift j's top bits down, try every value of the k evicted bits
    preds = (j[:, None] >> k) | (np.arange(2**k)[None, :] << (L - k))
    cost, back = (C - s[0])**2, np.empty((T, N), dtype=np.int32)
    for t in range(1, T):
        pc = cost[preds]; a = pc.argmin(1)
        back[t] = preds[j, a]
        cost = pc[j, a] + (C - s[t])**2
    st = np.empty(T, dtype=np.int64); st[-1] = cost.argmin()
    for t in range(T - 1, 0, -1):
        st[t - 1] = back[t, st[t]]
    return cost.min() / T, st
```

First, QTIP applies QuIP#'s **random Hadamard transform** (random signs, then a Hadamard matrix, on both sides of W), making weights approximately i.i.d. Gaussian. The codebook is then designed once for N(0,1), not per layer.

## The codebook is computed

A 2^16-entry fp16 codebook is 128 KiB, too big for fast decode, so QTIP hashes the L-bit window into a pseudo-Gaussian value. "1MAD" runs an LCG, sums the four bytes of the result (Irwin–Hall with n=4, close to Gaussian), and rescales:

```python
def code_1mad(x):                      # x: L-bit state, vectorized
    x = (34038481 * x + 76625530) & 0xFFFFFFFF
    s = (x & 255) + ((x >> 8) & 255) + ((x >> 16) & 255) + ((x >> 24) & 255)
    return (s - 510) / 147.8           # 510 = 4 * 127.5, 147.8 = sqrt(4 * (256^2 - 1) / 12)
```

On a GPU this is a MAD, a mask, `vabsdiff4` for the byte sum, and a final MAD. "3INST" XORs LCG bits into the sign, mantissa, and low exponent bits of a magic fp16 constant (0.922) and adds the two halves: a sum of mirrored exponentials, roughly Gaussian. "HYB" hashes x² + x into a 2 KiB 2^9 × 2 fp16 table, which fits L1 even duplicated 32× against bank conflicts, and can be fine-tuned.

Running them: 1MAD at L=16 yields only **908 distinct values** over 65,536 states (the paper's bound is 2^10), and 3INST's raw output has σ = 1.244, so a scale is folded in somewhere. Neither hurts quality.

## Reproducing Table 1

I used 2 bits per weight, 256-weight i.i.d. Gaussian sequences, and each codebook normalized to unit variance:

| Quantizer | MSE (paper) | MSE (mine) |
|---|---|---|
| Lloyd–Max scalar, 4 levels | 0.118 | 0.1177 |
| QuIP# E8P, 8D | 0.089 | — |
| TCQ L=16, 1MAD, tail-biting | 0.069 | **0.0697** |
| TCQ L=16, 3INST, tail-biting | 0.069 | **0.0696** |
| TCQ L=16, random Gaussian codebook | 0.068 | **0.0686** |
| Rate-distortion bound D(R) = 2^(−2R) | 0.0625 | 0.0625 |

All three agree with the paper to within 0.001, and the computed codes are within 1.6% of a truly random codebook: three ALU instructions suffice. TCQ sits 10–11% above the Shannon bound, versus 42% for the 8D lattice and 88% for scalar rounding.

Trellis size matters: free-start MSE goes 0.085 → 0.072 → 0.065 for L = 8, 12, 16 (±0.002 run-to-run), like constraint length in convolutional codes. Encoding is linear in 2^L, about 0.5 s per sequence at L=16 in numpy.

## The failure mode: correlated neighbors

Consecutive states share L−k bits, so a bad code correlates neighboring weights; the paper shows reachable (ŵ_t, ŵ_t+1) pairs collapsing onto curves. I measured the simplest bad code: a value that is **monotone in the state index** (Gaussian quantiles of j/2^L).

| Code | L=8 | L=12 | L=16 |
|---|---|---|---|
| Monotone (quantile of state) | 0.142 | 0.143 | 0.143 |
| 1MAD | 0.085 | 0.072 | 0.065 |

It's **worse than Lloyd–Max scalar rounding** (0.118), and a bigger trellis doesn't help. In a monotone code the window's top bits set the value, and in a bitshift trellis those are the *oldest* bits, chosen L/k − 1 steps earlier for a different weight; the newest bits only refine. Hashing (LCG, or x² + x) spreads every window bit across the value. That decorrelation is the one step the bitshift trellis can't skip.

## Tail-biting is worth its complexity

A plain trellis also stores its start state: L−k = 14 extra bits per 256 weights (0.055 bits/weight), breaking 32-bit word alignment. QTIP makes the trellis **tail-biting**: the last state's low bits equal the first state's high bits, so a sequence costs exactly kT bits. Exact solving needs 2^(L−k) Viterbi runs; Algorithm 4 uses two: rotate by T/2, run Viterbi, read the overlap off the seam, re-run with the ends pinned.

At L=12, k=2, Algorithm 4 gives 0.0723 (paper: 0.0733) and matched the exact 1,024-run optimum on the 3 sequences I checked. At L=16, tail-biting moves MSE from 0.0663 (free start) to 0.0697.

Is the free start worth 0.055 bits? At D ≈ 0.069 the rate-distortion slope is 2·ln2·D ≈ 0.096 MSE per bit, so those bits should ideally buy 0.0052; the free start buys 0.0034, two-thirds of that, and costs alignment. Spend bits on k or L instead.

## What it buys end to end

QTIP plugs into QuIP#'s BlockLDLQ (Hessian-aware feedback rounding), treating each 16×16 tile as one 256-long sequence that decodes straight into an MMA fragment. Without fine-tuning, the computed codes beat fine-tuned QuIP# and AQLM on almost every Llama 2 size; 2-bit Llama 2 70B gets 3.87–3.90 Wikitext2 perplexity (fp16: 3.12). With the HYB code and fine-tuning, the 3- and 4-bit results roughly halve the perplexity gap to fp16 that QuIP# and AQLM leave.

At batch 1 on an RTX 6000 Ada (960 GB/s), 2-bit QTIP runs Llama 2 70B at 23.5 tok/s vs 22.2 for QuIP# and 8.78 for AQLM, which pays for its L1-missing codebook. The roofline for 17.5 GB of 2-bit weights is ~55 tok/s, so QTIP reaches ~43%. My reading: at 2 bits, decode ALU work and per-layer fixed costs stop being negligible, which is why a sub-4-instruction code matters as much as the bit count.

## Takeaways

- **Dimension stops being a cache problem.** Decode cost depends on L, not on the 256-wide quantization dimension.
- **A bitshift trellis is a sliding window**, parallel and graph-free, but only if the code hashes the window; a monotone codebook loses to scalar rounding.
- **Gaussianize first.** The Hadamard rotation lets one data-independent code serve every layer.
- **Don't spend bits on start states.** Two-pass tail-biting is near-optimal and word-aligned.
