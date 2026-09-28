---
title: "ThunderKittens: 16x16 Tiles, the Load-Compute-Store-Finish Template, and Why 40 Lines Can Match cuBLAS"
date: 2026-09-28
tags: ["gpu", "cuda", "kernels", "performance", "llm-inference"]
excerpt: "ThunderKittens (Spector et al., arXiv 2410.20399) bets that three abstractions — 16x16 register/shared tiles with compile-time swizzled layouts, a producer-consumer thread-block template, and a persistent grid with cache-aware block ordering — cover almost everything an H100 AI kernel needs. The receipts: a 40-line GEMM that matches cuBLAS, attention backward 10-40% faster than FlashAttention-3, and 8-14x speedups on linear attention and SSMs. I re-derived the bank-conflict claim at the center of its layout system with a 30-line simulator: naive row-major really is 8-way conflicted, and the 128-byte XOR swizzle really is conflict-free."
---

# ThunderKittens: 16x16 Tiles, the Load-Compute-Store-Finish Template, and Why 40 Lines Can Match cuBLAS

The uncomfortable fact about GPU kernel engineering is that the hand-written stuff is often slow. The ThunderKittens paper (Spector, Arora, Singhal, Fu, Ré — arXiv 2410.20399, October 2024) opens with an NCU profile showing FlashAttention-3, written by experts in CUTLASS/CuTe, suffering up to 9.6-way shared-memory bank conflicts in its backward pass. Their framework's version of the same kernel has zero, and runs 10-40% faster. The claim isn't that the FA3 authors made a mistake; it's that the prevailing abstractions make this class of mistake nearly unavoidable, and that a much smaller set of opinionated abstractions can make it nearly impossible.

ThunderKittens (TK) is an embedded C++ library, not a compiler. It offers exactly three things, one per level of the GPU execution hierarchy: tiles at the warp level, a pipeline template at the thread-block level, and a persistent scheduler at the grid level.

## Warp level: tiles are the only data structure

TK's basic unit is a 16x16 matrix tile — sized to match tensor core operand shapes — declared at each level of the memory hierarchy:

```cpp
rt_bf<16, 64>  q_reg;   // register tile: bf16, 16 rows, 64 cols
rt_fl<16, 64>  o_acc;   // fp32 accumulator tile
st_bf<64, 64>  k_smem;  // shared-memory tile
gl<bf16, -1, -1, -1, 64> Qg;  // global layout: 4D HBM tensor (batch, head, len, embed)
```

Operations over tiles look like PyTorch: `zero(o_acc)`, `exp(att)`, `sub_row(att, max_vec)`, `mma_AB(o_acc, att, v_reg)`. The important design decision is what's *in the type*. Register tiles carry a layout (row-major or column-major), and tensor-core ops constrain it: `mma_AB` requires A row-major and B column-major, enforced at compile time. If your data is in the wrong layout you must call `swap_layout_inplace(...)` explicitly — the cost is visible in the source instead of silently materializing as conversion instructions.

The payoff is the shared-memory layout system. H100 shared memory has 32 banks of 4 bytes; when multiple threads in the same phase of a memory instruction touch the same bank, the accesses serialize. A row-major 64-wide bf16 tile has a 128-byte row stride — exactly one full sweep of the banks — so every row starts at bank 0, and the row-per-thread address pattern of an `ldmatrix` load collides catastrophically. The standard fix is an XOR swizzle that scatters row starts across banks. TK supports exactly three swizzled layouts (32-, 64-, and 128-byte strides) and picks the widest one the tile's width supports, at compile time. The programmer never sees it.

I wanted to check the arithmetic rather than take it on faith, so I modeled the load: 32 threads each supply a 16-byte row address, executed in four phases of eight threads, four consecutive banks touched per access.

```python
BANKS = 32
def bank(addr): return (addr // 4) % BANKS

def swizzle_128B(addr):          # XOR the 16B chunk index by row bits
    return addr ^ (((addr >> 7) & 7) << 4)

def max_conflict(row_stride, xform=lambda a: a):
    worst = 0
    for phase in range(4):                       # 8 threads per phase
        counts = {}
        for t in range(phase * 8, phase * 8 + 8):
            addr = xform(t * row_stride)
            for w in range(4):                   # 16B touches 4 banks
                b = bank(addr + 4 * w)
                counts[b] = counts.get(b, 0) + 1
        worst = max(worst, max(counts.values()))
    return worst

print(max_conflict(128))               # -> 8   (naive row-major)
print(max_conflict(128, swizzle_128B)) # -> 1   (conflict-free)
```

Output: the naive layout is 8-way conflicted — every load runs at 1/8th bandwidth — and the 128-byte swizzle is fully conflict-free. That matches the paper exactly, and it makes the FA3 anecdote legible: 9.6-way average conflicts means some access patterns in that kernel are hitting close to the worst case my simulator produces. Encoding the swizzle in the type system is how TK's attention backward gets its 85% reduction in shared-memory stall cycles (0.92 → 0.14 cycles/instruction in the paper's NCU profile).

## Block level: the LCSF template

Modern Hopper kernels are producer-consumer machines: some warps drive the Tensor Memory Accelerator (TMA) to stream tiles from HBM while others run tensor cores on tiles that already arrived. Getting this right by hand means juggling mbarriers, buffer rotation, and register budgets. TK freezes the structure into a template with four holes — **load, compute, store, finish** — and workers (warps or 128-thread warpgroups) are assigned producer or consumer roles:

```cpp
// producer
tma::expect(inputs_arrived, k_smem, v_smem);
tma::load_async(k_smem, Kg, {batch, head, iter, 0}, inputs_arrived);

// consumer
warpgroup::mma_AB(o_acc, att, v_smem);
warpgroup::mma_async_wait();
```

Everything else is a template parameter. Pipeline depth is a single integer, `INPUT_PIPE_STAGES`, and it matters enormously: the paper's 4096-cubed GEMM goes 260 → 484 → 683 → 760 TFLOPS as stages go 1 → 2 → 3 → 4. Register pressure is handled with explicit warpgroup calls — producers drop to 40 registers per thread, consumers claim 232 — because Hopper caps threads at 255 registers and spills the rest to L1. These numbers live in the template, not scattered across a 2,000-line kernel.

This is the part of TK that reads as a genuine thesis about the hardware: an SM runs up to 64 warps against four execution units, so peak performance is a scheduling problem — overlap enough work to hide latency without so much contention for registers, shared memory, and issue slots that everything stalls. The template makes occupancy-vs-contention a tunable rather than an emergent property.

## Grid level: persistence and block order

Two grid-scale mechanisms round it out. First, a **persistent grid**: launch exactly 132 blocks (one per H100 SM) once, and feed work chunks into living blocks, overlapping one chunk's `load` with the previous chunk's `finish`. For skinny GEMMs where setup dominates, this is decisive — at M=N=4096, K=64, TK hits 108 TFLOPS persistent vs 93 non-persistent vs 69 for cuBLAS. (It also sidesteps the tail-effect cliff: 133 blocks on 132 SMs means a second wave running at under 1% efficiency.)

Second, **block launch order as an L2 policy**. Blocks that share operand tiles should be resident together so the 50 MB L2 (12 TB/s) absorbs their overlapping reads instead of HBM (3 TB/s). On a 16384-cubed GEMM, reordering the grid into supergroups of 8 rows cuts HBM traffic from 3,070 GB/s to 982 GB/s and lifts throughput from 392 to 805 TFLOPS — a 2x swing from changing nothing but the iteration order of blockIdx. The same trick applied to attention (iterating sequence-first rather than batch-first) is worth 100 TFLOPS.

## What the numbers say

On an H100 with CUDA 12.6: TK's 40-line GEMM matches cuBLAS (a >600 MB binary); attention forward matches FA3; attention backward beats it by 40% at short sequences, 10% at long ones. The blowouts are on the newer architectures where no NVIDIA team has spent years tuning: 14x over Flash Linear Attention, 4.7-8.7x on long convolutions, 3x on Mamba-2 — largely because the baselines leave tensor cores idle (FlashFFTConv: 13.4% utilization; TK: 54.8%).

My read: the interesting result isn't that TK wins, it's *where* it wins. Against cuBLAS and FA3 — thousands of expert-hours of tuning — it draws or ekes out 10-40%. Against everything else, it wins by integer multiples. That's the strongest form of the paper's argument: the ceiling on GPU performance is set by physics, but the floor is set by abstractions, and for any workload that hasn't received a dedicated engineering team, the abstraction *is* the performance. Whether three swizzles and one template stay sufficient on Blackwell — where tensor memory and single-thread MMA rewrite the warpgroup assumptions — is the question the next version has to answer.
