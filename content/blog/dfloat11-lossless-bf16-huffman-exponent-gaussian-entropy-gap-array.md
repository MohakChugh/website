---
title: "DFloat11, Audited: The 2.6-Bit Exponent Is a Gaussian Constant, and the Parallel-Decode Index Costs 6× the Huffman Loss"
date: 2026-10-21
tags: ["llm-inference", "compression", "entropy-coding", "gpu", "bfloat16"]
excerpt: "DFloat11 (NeurIPS '25) Huffman-codes the exponent of BF16 weights and decompresses on the GPU, giving bit-identical outputs at ~70% of the size. I reproduce its compression ratio on Qwen2.5-0.5B to within a few hundredths of a bit (10.87 bits/weight). The '2.6 bits of exponent entropy' turns out to be a property of the Gaussian, 2.54 bits at any scale, which is why every model lands at 68%. Of the 0.32 bits that separate DF11 from the memoryless floor, 0.21 are the gap array that makes parallel decoding possible. At batch 1 the format is 2.2× slower than BF16 when the model fits."
---

# DFloat11, Audited: The 2.6-Bit Exponent Is a Gaussian Constant, and the Parallel-Decode Index Costs 6× the Huffman Loss

Quantization makes models smaller by changing their outputs. **DFloat11** (Zhang et al., *70% Size, 100% Accuracy*, NeurIPS '25, arXiv 2504.11651) keeps the outputs bit-for-bit identical. A BF16 weight is 1 sign bit, 8 exponent bits and 7 mantissa bits, and in trained LLMs the exponent carries only about 2.6 bits of information. Huffman-code the exponent, store sign and mantissa raw, and a weight costs about 11 bits. The paper reports 67.6–69.5% of original size across a dozen LLMs and diffusion models, enough to put Llama 3.1 405B on one 8×80 GB node.

The hard part is that Huffman decoding is sequential, and the weights must be expanded back to BF16 on the GPU before every matmul. I read the released code (`LeanModels/DFloat11`, commit `4577338`), rebuilt its size accounting, and ran it on the BF16 checkpoint of Qwen2.5-0.5B to find out where the bits go, why the ratio barely moves across models, and what the format costs at inference time.

## The format

One Huffman codec is built per transformer block, over the exponents of all its linear layers. The embedding gets its own codec. The weights become three streams:

- **PackedSignMantissa**: one raw byte per weight (sign plus 7 mantissa bits).
- **EncodedExponent**: Huffman codes, tightly bit-packed.
- **Decode metadata**: a 5-bit **gap** for every GPU thread, plus one 32-bit **output position** for every thread block.

Each thread owns 8 bytes (64 bits) of the exponent stream and decodes every code that *starts* inside them. The gap is the bit offset of the first code that starts in the thread's window. This is why the encoder caps code length at 32 bits: the offset then fits in 5 bits. A block of 512 threads makes two passes: count symbols, Blelloch-scan the counts into output offsets in shared memory, then decode again into a shared-memory buffer that is flushed to HBM in one coalesced write.

Decoding a code is one table lookup per byte. The Huffman tree is cut into subtrees of height 8, each with a 256-entry LUT. Exponent values 240–255 (magnitudes around 2¹¹³ and above, which never occur in weights) are reused as pointers to the next LUT. `decode.cu` walks at most four LUT levels (a root lookup plus three nested `decoded >= 240` checks), a second reason for the 32-bit cap. The cap is enforced by a heuristic: if the tree is deeper than 32, set the counts of the k rarest exponents to 1 and rebuild, increasing k until it fits. Equal counts collapse the long tail into a balanced subtree.

## Reproducing the ratio

I counted exponents per block, built Huffman codes with the repo's rules (including the EOF symbol `dahuffman` adds and the 32-bit cap), and added up the bytes exactly as `encode()` writes them:

```python
def account(w, L):                          # w: uint16 BF16 bits, L: code lengths
    n = w.size; c = np.bincount((w >> 7) & 0xFF, minlength=256)
    bits = sum(int(c[s]) * L[s] for s in range(256) if c[s]) + L['eof']
    enc = ceil(bits / 8); T = 512; blocks = ceil(enc / (T * 8))
    gaps = ceil(5 * T * blocks / 8)         # 5 bits per thread, packed
    pos = (blocks + 1) * 4                  # uint32 per thread block
    return (enc + n + gaps + pos) * 8 / n   # n = sign/mantissa bytes
```

Over all 25 groups (24 blocks plus the 136M-parameter embedding):

```text
component                        bits/weight
sign + mantissa (raw)               8.000
Huffman exponent                    2.658   (per-block entropy 2.625: 0.033 coder loss)
gap array (5 bits / 64 bits)        0.208
block output positions              0.003
total                              10.868   = 67.92% of BF16
```

The paper's Table 1 reports 10.81–10.91 bits. Each block here uses 26–29 distinct exponents (about 40 in the paper's larger models), codes reach 21–24 bits, LUTs go 3–4 levels deep, and the cap heuristic never fired. A single whole-model codec would cost only 0.014 bits/weight more.

## Why it is always ~2.6 bits

The ratio is suspiciously stable across architectures, sizes and even diffusion models, which suggests it reflects the *shape* of the weight distribution rather than anything learned. If w ~ N(0, σ²), then P(exponent = e) = P(2ᵉ ≤ |w| < 2ᵉ⁺¹). Multiplying σ by 2 shifts that distribution by one exponent and leaves its entropy unchanged, so the entropy depends on σ only through the fractional part of log₂σ:

```python
def gauss_exp_entropy(s):
    cdf = lambda x: erf(x / (s * sqrt(2)))          # P(|w| < x)
    p = [cdf(2.0**(e+1)) - cdf(2.0**e) for e in range(-140, 20)]
    return H(p)
# over s in [1, 2):  2.5422 .. 2.5463 bits
# Laplace:           2.8320 bits
```

**A Gaussian has 2.54 bits of exponent entropy at every scale**, varying by ±0.002. Qwen's blocks measure 2.58–2.69 bits, which is the Gaussian value plus a little extra from heavier tails and from mixing matrices with different σ in one codebook. The embedding is the most Gaussian at 2.58. The mantissa result matches too: a Gaussian sample has 6.97 bits of mantissa entropy and Qwen has 6.957, because density falls slightly across each binade.

So DF11's "~70%" is closer to a law than a finding. Any model whose weights are roughly bell-shaped will land at 8 + ~2.6 + 0.21 ≈ 10.8–10.9 bits.

## Where the remaining bits go

The real floor for any coder that treats weights as independent is the entropy of the full 16-bit value. On Qwen2.5-0.5B that is **10.552 bits**. DF11 is at 10.868, so 0.316 bits/weight are left. They split up as follows:

```text
coding sign/mantissa jointly with exponent   0.085
Huffman vs whole-model exponent entropy      0.021
gap array                                    0.208
block output positions                       0.003
```

**Two-thirds of DF11's distance from the memoryless floor is its own parallel-decode index, not the entropy coder.** The gap array costs 5 bits per 64-bit window, or 5·H/64 ≈ 0.21 bits/weight, which is about 6× the 0.033-bit Huffman loss. The 8-byte window is a parallelism choice:

```text
bytes/thread   gap bits/weight   total    vs BF16
     8             0.208         10.868   67.9%
    16             0.104         10.764   67.3%
    32             0.052         10.712   66.9%
```

Doubling the window halves the index cost but also halves the number of threads, and each thread's serial decode loop gets twice as long. Swapping Huffman for ANS or arithmetic coding would recover at most the ~0.03-bit coder loss. A 65,536-symbol joint code would add the 0.085, at the cost of LUTs that no longer fit in shared memory. Beating ~66% losslessly needs correlation *between* weights, and a memoryless coder can't use it.

## What it costs at inference time

DF11 never computes on compressed data. Before each transformer block's forward pass, every matrix in the block is expanded to a BF16 scratch buffer in HBM, used, and thrown away. At batch 1, where decoding is bandwidth-bound, here is the HBM traffic per weight:

```text
BF16:   read 2 B                                       = 2.00 B
DF11:   read 1.36 B  +  write 2 B  +  matmul reads 2 B  = 5.36 B   (2.68×)
```

The paper's Figure 6 (Llama 3.1 8B, one A100-40GB, values read off the bars) agrees. Batch 1 takes about **86 ms/token for DF11 against 39 ms for BF16, 2.2× slower**. Decompressing 16 GB of BF16 in the extra ~47 ms implies roughly 340 GB/s, about a fifth of the A100's 1.56 TB/s. Decompression is a fixed cost per forward pass, so it shrinks as the batch grows: about +30% at 2,048 tokens and about +4% at 16,384. Compute-bound diffusion models see only +4–6%.

Every headline speedup in the paper (2.3–46×) is measured against **BF16 with CPU offloading**, the right baseline when the model doesn't fit. The appendix concedes the overhead "may impact latency-sensitive applications with small batches"; the traffic model says by how much.

The obvious fix is to decode inside the GEMV, into registers or shared memory, and skip the scratch round-trip. Traffic would then drop to 0.68× of BF16, which could make DF11 up to 1.47× *faster* than BF16 at batch 1. Decoding would then have to keep up with HBM: about 1.15 trillion weights per second on an A100, against roughly 170 billion for the standalone kernel. With a chain of dependent LUT lookups per element, closing that 6–7× gap is an open problem.

## What to take away

- **The ratio reproduces.** 10.868 bits/weight (67.92%) on Qwen2.5-0.5B, against 10.81–10.91 in the paper.
- **"2.6 bits" is mostly Gaussian.** The exponent entropy of a normal distribution is 2.54 bits at any scale, so the ~68% result carries over to any model with bell-shaped weights.
- **The coder is not the bottleneck.** Huffman is 0.03 bits from entropy. The 5-bit gap array costs 0.21, two-thirds of the distance to the 10.55-bit memoryless floor.
- **Use it to fit, not to speed up.** DF11 beats offloading by a wide margin, and costs about 2.2× at batch 1 when BF16 already fits.

DF11's engineering is in the decoder. The compression ratio comes almost for free from the shape of the weight distribution.
