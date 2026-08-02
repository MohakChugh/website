---
title: "TokenWeave: Why Hiding Tensor-Parallel Communication Needs Wave Arithmetic, Not Finer Tiles"
date: 2026-08-03
tags: [llm-inference, tensor-parallelism, gpu-kernels, distributed-systems, nvlink]
excerpt: "Tensor-parallel LLM inference burns up to 20% of its latency in AllReduce, and every framework ships with compute-communication overlap turned off by default. The reason is not laziness: splitting work finer to create overlap costs more than the communication it hides. TokenWeave (MLSys 2026) fixes this with two unglamorous ideas, an unequal split sized to GPU wave boundaries and a fused AllReduce-RMSNorm kernel that runs on 8 SMs out of 132."
---

Run a 70B model with tensor parallelism across 8 GPUs and roughly 9 to 23 percent of your end-to-end latency is AllReduce, even over NVLink with NVSwitch in the middle. That number has been public for years, the fix has been published several times over, and yet if you check vLLM, SGLang, or TensorRT-LLM today, compute-communication overlap for tensor parallelism is **off by default in all three**.

That is a strange state of affairs, and it is the observation TokenWeave (Gond, Kwatra, Ramjee; arXiv:2505.11329, accepted at MLSys 2026) starts from. The frameworks are not being lazy. The existing techniques genuinely lose, and understanding *why* they lose turns out to be a lesson in GPU scheduling arithmetic that applies well beyond LLM serving.

## The overlap trap

The standard recipe for hiding a collective is to break the work into smaller pieces so that piece *i*'s communication overlaps piece *i+1*'s compute. Flux and TileLink do this at tile granularity inside fused GEMM kernels. NanoFlow does it at whole-kernel granularity with nano-batches pinned to SM subsets.

The problem is **wave quantization**. A GEMM launches some number of CTAs, each occupying roughly one SM, and the GPU runs them in waves of `num_SMs`. On an H100 with 132 SMs, a GEMM needing 300 CTAs runs as 132 + 132 + 36: three waves, the last one only 27% occupied. Split that evenly into two 150-CTA halves and each half runs as 132 + 18. Two waves each, **four waves total**. You have made the kernel measurably slower before communication enters the picture.

```
132 SMs, 300 CTAs

unsplit:      [====132====][====132====][=36=]        3 waves
split 150/150:[====132====][=18=] [====132====][=18=] 4 waves
```

Now recall the budget. The thing you are trying to hide is 9 to 23 percent of runtime. A decomposition penalty of one extra wave in every GEMM easily exceeds that. Worse, the usual rewrite of AllReduce into ReduceScatter plus AllGather adds up to 50% overhead on its own, and small ReduceScatter tensors achieve poor NVLink bandwidth, so tile-granular transfers are inefficient in exactly the regime you need them.

This is why the technique *does* work for DeepSeek-style expert-parallel all-to-all, where communication is over 50% of runtime. There the slack is large enough that decomposition overhead does not matter. Tensor parallelism has no such slack.

Then there is the SM tax. Communication kernels consume SMs that compute wanted. Prior overlap systems reserve 16 to 20+ SMs purely for communication. On 132 SMs that is a 12 to 15 percent haircut on your compute throughput, taken to save a 20 percent communication cost.

## Fix one: split at wave boundaries, unequally

TokenWeave splits the token batch exactly **twice** (two pieces are the minimum to form a pipeline; more only adds decomposition overhead) and, critically, splits *unevenly*. The objective is stated as a constraint: total waves across both halves must not exceed the unsplit wave count.

For the 300-CTA example, that means 132 and 168, not 150 and 150. The first half is exactly one full wave. The second runs 132 + 36. Three waves total, same as unsplit, and now you have a pipeline.

```
split 132/168:[====132====] [====132====][=36=]       3 waves
```

Mechanically the prefix half gets `half_tokens + offset` and the suffix `half_tokens - offset`. Since cuBLAS kernels are closed source you cannot compute the right offset analytically, so TokenWeave sweeps `offset ∈ {0, 64, 128, 192, 256, 512}` offline for each (batch size, sequence length) pair and stores the winner in a lookup table:

```python
for B, L in shapes:                      # num_tokens = B * L <= MAX_TOKENS
    half = (B * L) // 2
    best = min(
        (time_forward(B, L, half + off, half - off), off)
        for off in (0, 64, 128, 192, 256, 512) if off < half
    )
    optimal_split[B, L] = best[1]
```

If the unsplit kernel is already only one wave, the offset sends all tokens to the prefix half, which quietly disables splitting. There is also a token-count threshold checked every iteration (1K tokens for dense Llama/Qwen, 4K for Mixtral MoE); below it, splitting is skipped entirely and only the fused kernel runs. Ablating the smart split away and using equal halves reintroduces visible **jitter** across sequence lengths as wave quantization bites unevenly, which smart-splitting removes almost completely.

Splitting tokens is safe for every transformer op except attention, since suffix tokens must attend to prefix tokens. TokenWeave inherits chunked attention from Sarathi-Serve and orders prefix ops before suffix ops.

## Fix two: RMSNorm was never insignificant

The second idea is the one I find genuinely surprising, because it identifies redundant work that has been sitting in production inference stacks in plain sight.

vLLM runs RMSNorm *after* AllReduce. After AllReduce, **every GPU holds an identical copy of the full activation tensor**, and then every GPU normalizes all of it. Eight GPUs do the same normalization eight times. RMSNorm is 4 to 9 percent of end-to-end latency, and it has generally been dismissed as noise.

Reorder it. Decompose AllReduce into ReduceScatter then AllGather. After ReduceScatter, each GPU owns the final values for its 1/N shard, so each GPU normalizes only its shard: an O(N) reduction in per-GPU normalization work. Then AllGather redistributes the already-normalized values. Because RMSNorm operates per token, the ReduceScatter must split only at token boundaries so each GPU holds complete token embeddings.

Done naively this loses, because splitting AllReduce into RS + AG costs more than the RMSNorm savings. Even writing RS + RMSNorm + AG as one fused kernel loses: measured at **0.92 to 1.00×**, a slowdown from 512 to 8K tokens, because the optimal parallelization for the collectives differs from the optimal one for normalization, and naive fusion does not reduce HBM traffic.

The version that wins eliminates HBM traffic. Standard RMSNorm reads the full tensor twice (once for variance, once to scale) and writes it once. TokenWeave's kernel:

1. issues `multimem_ld_reduce_add` so the **NVSwitch's SHARP engine performs the reduction** in-network for this GPU's shard,
2. computes the sum of squares directly on the register-resident result, eliminating the first HBM read,
3. fuses the residual add into the same pass,
4. writes normalized values straight to multicast addresses via `multimem_st`, letting the switch perform the AllGather and eliminating an HBM write.

```cuda
// per-CTA sketch: tokens_per_cta = ceil(num_tokens / gridDim.x)
sync_remote_blocks<MemOpSem::Relaxed>(...);
vec = multimem_ld_reduce_add(mc_ptr + off);   // switch reduces; result in registers
vec += residual[off];                          // fused residual add, no extra pass
variance = blockReduceSum(dot(vec, vec));      // no HBM re-read
s_var = rsqrtf(variance / hidden_size + eps);
multimem_st(mc_ptr + off, vec * s_var * w);    // switch broadcasts; no HBM write
sync_remote_blocks<MemOpSem::AcqRel>(...);
```

Multimem PTX against NVSwitch multicast addresses is reachable from ordinary CUDA or Triton via PyTorch 2.6's `SymmetricMemory`: `symm_mem.empty()` allocates peer buffers and a collective `symm_mem.rendezvous()` maps them into every GPU's address space, after which remote pointers work with normal memory operations and no explicit NCCL calls.

## What it buys

On 8×H100 (hidden 8192, bf16), the fused kernel beats standalone AllReduce plus standalone RMSNorm by **1.36 to 1.39×** across 64 to 32K tokens. The number worth extracting yourself: at 4K tokens the fused kernel takes 258.34 µs against 257.47 µs for AllReduce *alone*. RMSNorm has become 0.3% overhead instead of 27% of the combined block.

That is what makes the whole thing overlappable. Communication bandwidth saturates at 6 to 8 percent of SMs, so the fused AllReduce-plus-RMSNorm runs near-optimally on about **8 SMs, and is deployed on 2 to 8** — against 16 to 20+ for communication alone in prior work. Compute is no longer starved.

End to end on Llama-3.3-70B: up to **1.28× lower latency**, 1.2× at 1K tokens, and about **1.19× throughput** on ShareGPT (1.15× on arXiv), consistent 1.14 to 1.26× across chunk sizes 1024 to 8192. Fuse-only, with no splitting at all, is already 1.04 to 1.09×. Against TileLink on a single layer, TokenWeave is 1.20× at 1K rising to 1.35×, while TileLink shows *net overhead* below 2K and only reaches ~1.2× at 8K+.

The most telling result is that at sequence lengths ≥4K, TokenWeave beats `vLLM-nocomm`, a deliberately incorrect build with all communication deleted. It recovers the entire communication cost and then goes further, because it also deleted redundant normalization work that the no-communication baseline still performs.

## Caveats worth knowing

MoE models get much less. Mixtral-8x22B spreads tokens across 8 experts, making the FFN memory-bound, so even a two-way split costs more than it saves; TokenWeave shows *net overhead* at 1K and 2K tokens there and falls back to fuse-only. The gains are O(N) in TP degree, so 4 GPUs see less than 8. The kernel is bf16 only. And the full splitting path **does not support CUDA graphs**, so B200 prefill experiments run in eager mode, while `torch.compile` is incompatible outright because it does not support symmetric memory allocation.

The broader lesson generalizes past LLM serving. When the cost you are attacking is only 20% of runtime, the decomposition you use to attack it has to be nearly free, and on a GPU "nearly free" means respecting wave boundaries. The counterintuitive move is that the correct split of work in half is not into halves.
