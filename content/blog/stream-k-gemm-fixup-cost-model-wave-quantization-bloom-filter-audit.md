---
title: "Stream-K Re-derived: Its Own Fixup Model Caps the 14.7× at ~3×, and Stream-K++'s Bloom Filters Are a 546-Byte Table"
date: 2026-10-28
tags: ["gpu", "gemm", "load-balancing", "cuda", "performance"]
excerpt: "Stream-K splits GEMM work by MAC-loop iteration instead of by output tile, which removes wave quantization. I inverted the paper's grid-size model against its own Fig. 8. Reading one peer's partial sums costs 7–9.9 MAC iterations, and at that cost the model can't produce more than ~3.1× over data-parallel on the paper's test domain, against a reported 14.7×. The 2024 follow-up, Stream-K++, describes an MI250X with 104 CUs (the MI250X has 110 per die), benchmarks 923 of a 1,456-cell grid, and attributes atomics to an algorithm that never used them. It also selects policies with Bloom filters that need ~82 KiB to do what an exact 546-byte lookup table does with no false positives."
---

# Stream-K Re-derived

A data-parallel GEMM gives each output tile to one CTA, and those CTAs dispatch across the GPU in waves. If the tile count isn't a multiple of the core count, the last wave runs partly empty and the idle SMs wait. This is *wave quantization*, and on a power-of-two problem grid it follows a fixed pattern:

```
tiles   eff@104  eff@108(A100)  eff@110  eff@132(H100)
   64    0.615       0.593       0.582      0.485
  128    0.615       0.593       0.582      0.970
  256    0.821       0.790       0.776      0.970
  512    0.985       0.948       0.931      0.970
 2048    0.985       0.998       0.980      0.970
```

Efficiency is `t / (⌈t/p⌉·p)`. On an H100, 128 tiles is 97% efficient and 64 tiles is 48%: a 2× swing from one power-of-two step in M or N.

## The algorithm

[Stream-K](https://arxiv.org/abs/2301.03598) (Osama, Merrill, Cecka, Garland, Owens; PPoPP '23) changes the unit of work. It launches a fixed grid of `g ≈ p` CTAs and divides the *total* count of MAC-loop iterations evenly among them. One iteration is a `BLK_M×BLK_N×BLK_K` volume. A CTA's range is allowed to cross tile boundaries:

```python
import math
def stream_k(M, N, K, BM=128, BN=128, BK=32, g=108):
    ipt   = math.ceil(K / BK)                                  # iters per tile
    total = math.ceil(M / BM) * math.ceil(N / BN) * ipt
    ipc   = math.ceil(total / g)                               # iters per CTA
    for x in range(g):
        it, end = x * ipc, min((x + 1) * ipc, total)
        while it < end:
            tile = it // ipt; t0 = tile * ipt
            stop = min(end, t0 + ipt)
            yield x, tile, it - t0, stop - t0   # CTA x does k-iters [lo,hi) of tile
            it = stop
```

A CTA that ends partway through a tile writes its partial sums to scratch and sets a flag. The CTA that started the tile (`k = 0`) waits on its peers' flags, adds their partials **in CTA order**, and stores the tile. The production schedule, "two-tile SK + DP", runs one fewer full data-parallel wave and gives each Stream-K CTA one to two tiles' worth of iterations, so each tile has at most two contributors. Atomics appear nowhere in this design, which matters later.

## Inverting the cost model

Appendix A.1 chooses `g` by minimizing a four-constant model:

```
time(g) = a + b·[peers > 1] + c·⌈total/g⌉ + d·(peers − 1),   peers = ⌈ipt / ⌈total/g⌉⌉
```

Here `c` is the cost of one MAC iteration, `d` is the serial cost of reading one peer's partials, and `b` is the cost of being a seam CTA at all. The paper doesn't publish the constants. It does publish three optimal grid sizes on an A100 with 128×128×32 FP16 tiles (Fig. 8): `g=108` for 256×3584×8192, `g=64` for 1024³, and `g=8` for 128×128×16384. So I swept `d/c` and `b/c` and kept every pair that reproduces all three optima:

```
d/c ∈ [7.0, 9.9]     b/c ∈ [4, 115]     (a cancels)
```

The tightest constraint comes from the single-tile case (c). The optimum sits at `g ≈ √(ipt·c/d)`, and `g = 8` with 512 iterations forces `d ≈ 8c`. Merging one partial tile costs about as much as eight MAC iterations, which is plausible: an FP32 128×128 partial is 64 KiB, and one iteration reads 16 KiB of FP16 operands.

The problem is that this constant also caps strong scaling. When a tile is split `g` ways, its owner pays `d·(g−1)` serially, so the best achievable time for one tile is about `2√(d·ipt) − d`. On the paper's own test domain (k ≤ 8192, so `ipt ≤ 256`) I maximized the modeled SK/DP ratio over tile counts and grid sizes:

```
d=7.0  b=5  → 3.08× max     (1 tile, 256 iters, g=6)
d=8.0  b=5  → 2.91×
d=9.9  b=5  → 2.65×
any d, a=b=20 → 2.1–2.3×
```

Table 2 reports a **14.7×** peak over the same-blocking CUTLASS data-parallel kernel, for FP16, in the "m×n small, k large" regime. That is the regime where the model tops out near 3×. Either the fixup at high peer counts is far cheaper than Fig. 8 implies, or the baseline loses more than load balance on these shapes. A plausible mechanism is a lone CTA streaming 4 MB of operands without enough memory-level parallelism, while `c` was calibrated with every SM busy. The paper doesn't decompose the 14.7×, and I can't reconcile it from the published model. If the measurement is right, the grid-size heuristic, which would pick `g ≈ 6`, leaves most of that speedup on the table.

## Determinism

The FlashInfer paper explains its deterministic scheduler by contrasting it with Stream-K's atomic aggregation, and I repeated that in [an earlier post](/blog/flashinfer-block-sparse-attention-engine-kv-cache-scheduling). That description doesn't match Algorithm 5. The original Stream-K uses flag-wait and accumulates in a fixed order, so for a fixed `g` it is bitwise deterministic. It is not batch-invariant, because `g` and the seams move with the shape. The atomics come from implementations, Composable Kernel among them, and from the follow-up paper.

## Stream-K++ audit

[Stream-K++](https://arxiv.org/abs/2408.11417) (Sadasivan et al., 2024) extends the schedule to "zero to six" Stream-K batches ahead of data-parallel. It reports up to 43% gains on AMD hardware, plus a Bloom-filter selector that "eliminates up to ~95.8% of unsuitable configurations while maintaining a 100% true-negative rate." Checked against itself:

1. **The CU count.** The paper uses "AMD Instinct MI250X … all 104 CUs on a single chiplet." An MI250X has 220 CUs, which is 110 per die. 104 per die is the MI250. This isn't a rounding detail: on the paper's grid with 256×128 tiles, 5.4% of shapes hit ≥95% wave efficiency at 104 CUs and 0.9% do at 110.
2. **The grid.** The grid is defined as powers of two with M ∈ [1, 8192], N ∈ [64, 8192], and K ∈ [16, 65536]. That's 14·8·13 = **1,456** cells, but the paper reports 923 "unique" sizes without saying which 533 it dropped.
3. **Attribution.** Algorithm 1 is labeled as Osama et al.'s Stream-K "using atomic adds" and is cited to [23]. As shown above, [23] uses partials and flags. The paper's critique of the original, that atomic adds "can take thousands of clock cycles" and that large K remains a problem, describes its own implementation, not [23].
4. **The abstract's headline.** The abstract says Stream-K++ is "within 20% of optimal for ~60–97.6% of problem sizes." In the body, 60% is the share within a 5% tolerance and 97.6% is the share within 20%.
5. **The Bloom filters.** "100% true-negative rate" is a misnomer for the no-false-negatives property. True-negative rate is specificity, `1 − FPR`, and a Bloom filter does not guarantee that. The sizing parameters (7 hashes, room for 10,000 entries per filter, "~1 byte per problem size") are, read charitably, textbook 1%-FPR parameters: `k = 7` at 9.6 bits ≈ 1.2 bytes per *capacity* slot.

```
7 filters × 10k capacity @1% FPR : 82 KiB  (≈91 B per benchmarked size, holding ~20 each)
exact table, 1,456 cells × 3 bits: 546 B   (no false positives, O(1) index by log2 M,N,K)
```

The key universe is finite, enumerable, and known at build time: the textbook case for a direct-indexed array, not a probabilistic set. The deeper problem is that a membership filter can't generalize. For an M that isn't a power of two, every filter correctly answers "absent" and the selector falls back to data-parallel. That is where Osama's analytical model, which knows *why* a shape quantizes badly, would actually help.

## What the grid says about the 87%

Stream-K++ finds data-parallel optimal on ~87% of its sizes. My quantization pass over the full grid seemed to contradict that. With 256×128 tiles at 104 CUs, **74%** of shapes have data-parallel wave efficiency below 50%. With 128×128 tiles the figure is 68%. The grid also collapses to just 12 distinct tile counts and 144 distinct `(tiles, iters)` pairs. Most of it has M ≤ 128: latency- and bandwidth-bound slivers where filling waves doesn't matter. And ckProfiler's data-parallel baseline is an ensemble of tile shapes, which is the classic fix for quantization. So the 87% isn't evidence that Stream-K is weak. It shows that on a power-of-two grid measured against a tuned ensemble, quantization is rarely the bottleneck. The original paper says as much about memory-bound shapes, where Stream-K "is attempting to make memory-bound computations run faster by adding more memory workload."

## Takeaways

- Stream-K's real contribution is making the split point independent of tile boundaries, which lets one kernel replace an ensemble on compute-bound shapes. The numbers to believe are 1.12× average against an oracle-selected CUTLASS ensemble (worst case 0.61×) and 1.15× average against cuBLAS on compute-bound shapes (worst case 0.98×). The 14.7× peak is not one of them.
- Fit a serial fixup cost before trusting strong-scaling claims. At `d ≈ 8c`, splitting one tile more than 6–8 ways loses time.
- For determinism, keep Algorithm 5's ordered flag-wait fixup. Atomics are an implementation choice that costs reproducibility.
- When the configuration space is enumerable, use a table. When it isn't, use a model. A Bloom filter fits neither case.
