---
title: "WaferLLM: The PLMR Model, Interleaved Cannon Shifts, and LLM Inference on 850,000 Cores"
date: 2026-09-28
tags: ["wafer-scale", "llm-inference", "gemm", "hardware", "distributed-systems"]
excerpt: "WaferLLM (OSDI '25) is the first LLM inference system built for wafer-scale chips like the Cerebras WSE-2: 850,000 cores, 48 KB of SRAM each, arranged in a 2D mesh with no shared memory. The paper's PLMR device model explains why GPU-style allgather, SUMMA, and even Cannon's algorithm all break on this hardware, and the fixes — an interleaved cyclic shift that bounds every communication step to two physical hops, a K-tree allreduce for GEMV, and shift-based KV cache placement — deliver 606x faster GEMV than an A100 and 10-20x end-to-end speedups over multi-GPU SGLang. The constraints are as interesting as the wins."
---

# WaferLLM: The PLMR Model, Interleaved Cannon Shifts, and LLM Inference on 850,000 Cores

A Cerebras WSE-2 is a single chip the size of a dinner plate: 850,000 cores at 1.1 GHz, 40 GB of on-chip SRAM, and 22 PB/s of aggregate memory bandwidth — roughly 7,000x an A100, on the same 7 nm process. On paper that bandwidth should demolish the memory-bound decode phase of LLM inference. In practice, before WaferLLM (OSDI '25, from Edinburgh and Microsoft Research), nobody could get an LLM to run well on one, because every piece of the standard inference stack assumes a shared-memory device. The wafer is not that. It is 850,000 tiny distributed machines on a 2D mesh, and the paper's core contribution is taking that seriously.

## PLMR: why your mental model of an accelerator fails

The authors formalize the hardware as a device model they call PLMR ("Plummer"), and it is worth internalizing because each letter kills a different standard algorithm:

- **P — massive Parallelism.** Hundreds of thousands to millions of cores, each with a hardware pipeline that overlaps ingress, compute, and egress at cycle granularity. Work must be partitioned at a scale no GPU kernel ever contemplates.
- **L — non-uniform Latency.** Cores talk to physical neighbors in one cycle. A message crossing an `Nw x Nh` mesh pays `α(Nw + Nh) + βr` — per-hop forwarding cost `α` plus per-routing-stage cost `β` (software header parsing, with `β > α`). At mesh scale that is a ~1000x gap between local and remote access.
- **M — constrained Memory.** 48 KB of SRAM per core on WSE-2. Not per SM — per core. Every tensor must shatter into tiles that fit.
- **R — restricted Routing.** A WSE-2 core decodes 5-bit address headers: at most 32 distinct routing paths per core. Need more fan-out and you relay through intermediate cores, paying `β` each time.

The model also describes Tesla Dojo and Tenstorrent Blackhole with different constants, which is what makes this a systems paper rather than a Cerebras manual.

## MeshGEMM: Cannon's algorithm, fixed with a two-hop interleave

Run the standard candidates through PLMR and each fails on exactly one axis:

- **Allgather GEMM** (the GPU/TPU pattern): every core needs `N` routing paths (violates R), the critical path is `O((α+β)N)` (violates L), and replicated buffers blow the 48 KB budget (violates M).
- **SUMMA** (Cerebras's own default): row/column broadcasts have the same R and L problems.
- **Cannon's algorithm** (the classic 2D-mesh GEMM): optimal `O(1/N²)` memory and only two neighbors per core — but the wraparound shift at the end of each step sends a tile from the head of a row back to the tail, an `N`-hop trip. `O(αN)` critical path; violates L.

Cannon is one remapping away from correct. WaferLLM's **MeshGEMM** keeps the cyclic compute-shift loop — `C_sub += A_sub @ B_sub`, shift A along X, shift B along Y, repeat N times — but *interleaves* the logical ring onto the physical row so that consecutive logical neighbors are never more than two physical hops apart:

```text
physical row:   c0  c1  c2  c3  c4  c5
logical ring:   c0 -> c2 -> c4 -> c5 -> c3 -> c1 -> c0

every logical edge spans <= 2 physical hops, so each of the
N shift steps costs O(2a) instead of the O(aN) wraparound
```

Each shift now passes through at most one intermediate core, bounding every step's communication to a constant. The authors prove two hops is optimal: a circular arrangement of a physical line where all logical neighbors are one hop apart is impossible (the endpoints have degree 1). Non-square meshes are handled by logical tiling on `lcm(Nw, Nh)`, and a transposed variant computes `A @ B^T` in place — which matters because `Q @ K^T` would otherwise need a physical transpose, and diagonal communication across a mesh is exactly the long-range traffic L punishes. The result: 2-3x faster than SUMMA and Cannon on-wafer, with >70% compute efficiency at 720x720 cores where the baselines drop under 50%.

## MeshGEMV: K-tree allreduce

Decode is GEMV, and GEMV on a mesh is a local partial product plus an allreduce. Ring allreduce (the GPU standard) and Cerebras's pipelined reduce both have `O(N)` critical paths — L again. WaferLLM's K-tree allreduce trades a little R for a lot of L: organize the reduction as a balanced K-ary tree over the mesh, giving `K` phases of parallel grouped reductions. Routing paths per core grow to `O(K)` — fine, the budget is 32 — while the number of `β`-cost routing stages collapses from `N` to roughly `K * N^(1/K) / 2`. They pick `K = 2`.

This is where the wafer's bandwidth finally shows up: MeshGEMV runs **280-606x faster than an A100** at 7.5-16x better energy efficiency. Notably, 606x is still well short of the theoretical 7,000x bandwidth ratio, and the paper is honest about why: incomplete compute/memory overlap inside each core, idle edge cores, and residual long-range NoC traffic.

## Placement is the whole game

The rest of the system is an exercise in never moving data further than necessary:

**Prefill vs. decode get different geometries.** Prefill partitions both the sequence and embedding dimensions 2D across the mesh and runs MeshGEMM. Decode has a sequence length of 1, so there is nothing to partition on that axis — instead activations are *replicated* along one mesh axis and the embedding dimension is partitioned along the other, keeping every allreduce local to a row. An offline autotuner picks the core grid per phase: LLaMA3-8B uses 660x660 cores for prefill but only 360x360 for decode, and the prefill-to-decode reshuffle rides the NoC's aggregate hundreds of Pbit/s.

**KV cache grows by shifting, not appending.** Naive concatenation makes the row of cores holding the newest tokens a memory hotspot (M) and a load imbalance (P). WaferLLM instead shifts the oldest KV entries one row upward whenever a row fills — purely adjacent-neighbor traffic. Against concatenation-style placement, this sustains ~360x longer decode sequences (137,548 tokens vs. 382 for LLaMA3-8B before hitting a wall).

## The numbers, and the caveats

End to end on WSE-2, WaferLLM runs LLaMA3-8B and LLaMA2-13B **10-20x faster than SGLang on an optimally-sized multi-GPU A100 cluster** (NVLink + InfiniBand), at ~2.5x better energy efficiency, with per-request decode throughput reaching 2,459 tokens/s vs. 256 for 8xA100. Against prior wafer-scale compilers (T10, Ladder) the gap is 36-677x, which mostly tells you how unmapped this territory was.

The limitations are instructive. 48 KB per core is too small for full tensor parallelism, forcing pipeline parallelism across layers and up to 5x underutilization from bubbles — the authors estimate 5-6x more per-core SRAM would fix it, which is presumably a message to Cerebras. CodeLLaMA-34B and QWen2-72B don't fit in 40 GB, so those results use scaled layer subsets. And the whole evaluation is per-request latency, where the wafer's bandwidth dominance shines; batch-heavy throughput serving is a different fight.

The deeper lesson generalizes: the wafer is best understood not as a big GPU but as a datacenter network etched into silicon, where "remote memory" is a thousand times further than local and the routing table has 32 entries. Every technique in this paper — interleaving a logical ring to bound physical hops, tree reductions tuned to a fan-out budget, shifting state instead of appending it — is a distributed-systems idea, applied at nanometer scale. As models and wafers both grow, that framing is likely to outlive the specific kernels.

**Paper:** [WaferLLM: Large Language Model Inference at Wafer Scale](https://arxiv.org/abs/2502.04563) (OSDI '25). Code: [MeshInfra/WaferLLM](https://github.com/MeshInfra/WaferLLM).
