---
title: "Sarathi-Serve's Chunked Prefill, Audited: KV Re-Reads Cost 0.4%, the 25% Overhead Is Wave Quantization, and 'Stall-Free' Means ~200 Free Tokens"
date: 2026-11-22
tags: [llm-inference, scheduling, gpu-performance, roofline, chunked-prefill]
excerpt: "Sarathi-Serve (OSDI '24) splits prompts into chunks and runs them alongside ongoing decodes under a fixed per-iteration token budget. I rebuilt its cost structure as an A100 roofline plus a tile-and-wave model and checked the paper's numbers. Re-reading prior chunks' KV costs 0.37% of an 8K Yi-34B prefill at chunk 512, so the paper is right that it doesn't matter. Launches and re-reads cannot explain the measured ~25% chunking overhead. GEMM and attention grids that leave the A100's 108 SMs partly idle predict +21–32%. Only 157–335 prefill tokens ride along with a decode batch for free; at the strict budget of 512, an iteration costs 1.7–2.4× a decode-only one."
---

LLM serving alternates two very different workloads. **Prefill** pushes thousands of prompt tokens through every weight matrix at once and is compute-bound. **Decode** pushes one token per request and is bound by memory bandwidth: every iteration reads all the weights to do roughly one FLOP per byte. Batching decodes is nearly free, but under vLLM's prefill-first policy one 8K-token prompt freezes every running decode for its whole duration. *Taming Throughput-Latency Tradeoff in LLM Inference with Sarathi-Serve* (Agrawal et al., OSDI 2024, arXiv:2403.02310) calls these freezes *generation stalls*.

Sarathi-Serve fixes this with two pieces:

- **Chunked prefill.** A prompt is split into chunks that run over several iterations. Each chunk attends to the KV cache of the chunks before it.
- **Stall-free batching.** Every iteration has a fixed **token budget**. All running decodes go in first, and prefill chunks fill whatever budget is left.

Reported results: up to 2.6× serving capacity on Mistral-7B (1×A100) and 3.7× on Yi-34B (2×A100, TP2) versus vLLM, plus 5.6× on Falcon-180B with pipeline parallelism. The paper also states three cost facts that I checked: the KV re-reads don't matter, chunking costs "at most ~25%" at chunk 512, and chunk 257 can be 32% slower than chunk 256. My tools were an A100-80GB roofline (312 TFLOP/s BF16 dense, 2.039 TB/s) and a wave-quantization model of the actual GEMM and attention grids.

## The model

```python
PEAK, BW, SMS = 312e12, 2.039e12, 108
M = {'Mistral-7B': dict(L=32, hq=32, hk=8, dh=128, P=7.24e9, tp=1),
     'Yi-34B':     dict(L=60, hq=56, hk=8, dh=128, P=34.4e9, tp=2)}
kv_tok = lambda m: 2 * m['L'] * m['hk'] * m['dh'] * 2         # bytes/token
attn_flops = lambda m, q, ctx: 4 * m['L'] * m['hq'] * m['dh'] * q * (ctx + q / 2)

def iteration(m, T, B, ctx):          # T total tokens, B decodes at context ctx
    comp = 2 * m['P'] * T / m['tp'] / PEAK                     # + attention FLOPs
    mem  = (2 * m['P'] + B * ctx * kv_tok(m)) / m['tp'] / BW   # weights + decode KV
    return max(comp, mem)
```

Sanity check against the paper's own numbers: Table 3 sets the strict P99 TBT SLO (TBT is time between tokens) at 5× "a decode iteration with batch 32 at 4K context". That works out to 0.1 s → 20 ms for Mistral-7B and 0.2 s → 40 ms for Yi-34B. The roofline gives 15.5 ms (7.1 ms weights + 8.4 ms KV) and 24.8 ms. So the measured decode iterations ran at 77% and 62% of roofline, which is plausible, and the model is in the right range.

## Claim 1: re-reading KV for every chunk is harmless. Confirmed

With N chunks, chunk 1's KV is read N−1 times, chunk 2's N−2 times, and so on. The extra traffic grows as N²/2c. It sounds bad, but compare it with the work done per byte read. A chunk of c queries attending to P cached tokens does 4·c·P·h_q·d_h FLOPs and reads 4·P·h_kv·d_h bytes of KV, so its arithmetic intensity is about c · (h_q/h_kv) FLOP per byte. That number doesn't depend on P. The A100's ridge point (where kernels flip from memory-bound to compute-bound) is 153 FLOP/B. Yi-34B's GQA group size is 7, so chunk attention is compute-bound from about **c ≈ 22** up.

In absolute terms, for an 8,192-token Yi-34B prompt:

| chunk | chunks | extra KV read | time (2 GPUs) | share of ideal prefill (996 ms) |
|---|---|---|---|---|
| 512 | 16 | 15.1 GB | 3.7 ms | 0.37% |
| 1024 | 8 | 7.0 GB | 1.7 ms | 0.17% |
| 2048 | 4 | 3.0 GB | 0.7 ms | 0.07% |

Even with zero overlap between these reads and compute, the cost is in the noise.

## Claim 2: "at most ~25%" overhead at chunk 512. The cause is grid shape, not bytes

Figure 14 measures up to ~25% extra prefill time for Yi-34B at chunk 512 and "almost negligible" overhead at 2048. Converted to absolute time, 25% of a ~1 s prefill spread over 16 iterations is **15.6 ms of excess per iteration**. KV re-reads explain 0.23 ms of that. A generous launch budget of 60 layers × 10 kernels × 5 µs explains 3 ms. That leaves about 12 ms per iteration that no byte count accounts for.

The likely cause is how chunk size maps onto thread blocks (CTAs, the units a kernel's grid is divided into). Take Yi-34B under TP2 at M = 512 rows. With 128×128 output tiles, the QKV projection (N = 4608) launches 4 × 36 = **144 CTAs on 108 SMs**. That takes two waves, and the second wave is a third full, so utilization is 67%. The output and down projections (N = 7168) launch 224 CTAs, which fill 3 waves at 69%. Attention in a FlashAttention-2-style grid (⌈c/128⌉ query tiles × 28 heads per GPU) launches 112 CTAs: 108 in the first wave and 4 alone in the second, so 52% utilization. Without chunking, M = 8192, the grids run to thousands of CTAs and the partial last wave stops mattering.

I summed this per chunk: wave-quantized GEMMs, wave-quantized attention over the growing prefix, the KV re-reads, and 3 ms of launches per iteration. The model predicts:

| prompt | c = 512 | c = 1024 | c = 2048 |
|---|---|---|---|
| 2K | +21% | +6% | 0% |
| 4K | +28% | +11% | +4% |
| 8K | +32% | +13% | +6% |

That's the paper's shape and roughly its size: ~25% at 512 and near-negligible at 2048. The naive model slightly overshoots at 8K. This is a model, not a profile, and I have no A100 trace to compare it with. What it does show is where the overhead can come from. It can't come from memory traffic, and it can come from the grid.

## Claim 3: chunk 257 vs 256 costs 32%. Reproduced, and it applies to the whole batch

With 128-row tiles, M = 257 needs a third row of tiles, so every GEMM's CTA count grows by 50%. In my wave model the GEMM time goes up **+25%**. The paper measured up to +32%, and the gap is easy to cover with tile shapes that have coarser M granularity or extra attention tiles. The less obvious part is that **the quantity being tiled is the total tokens in the iteration (decodes plus chunk), not the chunk size**. With a 512 budget and 32 running decodes, a 480-token chunk is the one that keeps M at 512. Any scheduler logic that rounds the *chunk* to a multiple of 128 misses this.

Multiples of 128 aren't all equal either, because 108 SMs isn't a power of two. Modeled GEMM utilization for Yi-34B TP2:

| M | 128 | 256 | 384 | 512 | 640 | 768 | 1024 |
|---|---|---|---|---|---|---|---|
| util | 57% | 72% | **86%** | 82% | 89% | 90% | 91% |

In this model, 384 uses the GEMMs better than 512. The ranking depends on the hardware and the library, which is why the paper picks budgets with a profiler-driven simulator (Vidur) instead of a rule of thumb.

## Claim 4: "stall-free". Bounded, not free

Prefill tokens are only truly free while the iteration stays memory-bound, that is, while 2·P·T/PEAK ≤ (weight bytes + decode KV bytes)/BW. Solving for T gives the break-even token count T*:

| model | 32 decodes @ 4K | 32 @ 1K | 8 @ 1K |
|---|---|---|---|
| Mistral-7B | 335 | 198 | 164 |
| Yi-34B | 225 | 171 | 157 |

The free region *grows with the decode load*, because a heavier decode batch reads more KV. And the paper's budgets sit past the break-even point. At the strict budget of 512, a hybrid iteration costs 25.8 ms on Mistral-7B and 59.8 ms on Yi-34B, which is **1.7× and 2.4×** a decode-only iteration. At 2048 the roofline gives 105.6 ms for Mistral-7B, already over the 100 ms strict SLO before any inefficiency. That's why 2048 is only used under the relaxed 500 ms SLO. The paper's wording is accurate: chunking "provides a much tighter bound" on TBT. The budget turns an unbounded stall into a fixed TBT cost, roughly doubling decode latency in exchange for keeping the GPU compute-saturated.

## What to take from this

1. **Don't fear the quadratic re-read.** With GQA, chunked attention is compute-bound from ~22 tokens up. The chunking tax is GPU occupancy.
2. **Tile the iteration, not the chunk.** Pad or trim the prefill chunk so that *total* tokens land on a good tile and wave boundary for your SM count. That boundary isn't always the largest multiple of 128 that fits.
3. **Know your T*.** Below the break-even token count, piggybacked prefill costs nothing. Above it, every token costs 2·P/PEAK seconds of TBT, so set the budget from the TBT SLO, as the paper does, not from "free".
4. **Re-profile on new hardware.** The 108-SM wave pattern is A100-specific; an H100 SXM has 132 SMs, which reshuffles the good and bad M values.
