---
title: "Helix Parallelism: Why Tensor Parallelism Hits a Wall at Million-Token Context"
date: 2026-07-27
tags: [llm-inference, gpu, distributed-systems, attention, performance]
excerpt: "Tensor parallelism has a hard ceiling that most people never hit, because you only hit it when your KV cache is measured in millions of tokens. Once TP width exceeds the number of KV heads, adding GPUs stops reducing per-GPU KV traffic entirely, and the arithmetic says so plainly. Helix Parallelism breaks the ceiling by using a different sharding strategy for attention than for the FFN, in the same layer, on the same GPUs, microseconds apart."
---

Everyone knows decode is memory-bound. The usual framing is that you read the whole weight matrix to emit one token, so batch-size-one decoding is a pure bandwidth benchmark. That framing quietly assumes weights are the thing you are reading. At million-token context, they are not. The KV cache is, by more than an order of magnitude, and the standard fix, wider tensor parallelism, provably does not help.

The paper that makes this precise is [Helix Parallelism](https://arxiv.org/abs/2507.07120) (Bhatia et al., NVIDIA, July 2025). Its most useful contribution is not the technique but the roofline model in the appendix, because that model contains a `ceil` that explains an entire class of scaling failure.

## The ceiling, in algebra

Helix gives the per-layer time to read the KV cache as:

```
t_kv = (B · 2 · ceil(K / TPA) · Hsz · (S / KVP) · bytes_param) / MemBW
```

where `B` is batch, `K` is the number of KV heads, `Hsz` the attention head size, `S` the KV sequence length, `TPA` the tensor-parallel width used in attention, and `KVP` the KV-parallel width (1 for conventional TP). And the per-layer FFN plus projection weight read as:

```
t_w = ((2·H·(Q/TPA)·Hsz) + (2·H·ceil(K/TPA)·Hsz) + (3·H·F/TPF)) · bytes_param / MemBW
```

Stare at `ceil(K / TPA)`. Modern attention variants exist specifically to shrink `K`: grouped-query attention collapses 128 query heads onto 8 KV heads, and multi-head latent attention as used in DeepSeek-V2/V3 keeps a *single* latent representation shared across all query heads. So `K` is 8, or effectively 1.

That means `ceil(K/TPA)` reaches 1 at `TPA = K` and then stays at 1 forever. Past that point, each additional TP rank must hold a **full copy** of the KV cache to serve its assigned query heads. Computation still splits; the memory traffic does not. Take the paper's Figure 1 configuration, a dense model with `B=8`, `Q=128`, `K=8`, `Hsz=128`, `F=65536`, FP4 weights and KV, `MemBW = 8000 GB/s`, at `S = 1M`:

| Config | `ceil(K/TPA)` | KV read / layer | FFN+proj read / layer |
|---|---|---|---|
| `TPA=8, TPF=8, KVP=1` | 1 | ~128 µs | ~30 µs |
| `TPA=64, TPF=64, KVP=1` | 1 | **~128 µs** | ~4 µs |
| `TPA=8, TPF=64, KVP=8` | 1 | **~16 µs** | ~8 µs |

Going from 8-way to 64-way TP cuts weight-read time by about 7.6x and cuts KV-read time by exactly nothing. Attention is now consuming ~33x the DRAM time of the FFN, and the lever everyone reaches for is bolted to the floor. Worse, because TP must be capped at `K` shards to avoid duplication, only `K` GPUs can shard the FFN, which is roughly two-thirds of the parameters, so those `K` devices both monopolize memory that could have held more KV cache and become the new latency bottleneck.

`★ Insight ─────────────────────────────────────`
- The `ceil()` is the whole story. GQA and MLA were designed to reduce KV *capacity*, and they succeeded so well that they inadvertently capped the useful width of tensor parallelism at `K`.
- Note the two costs move in opposite directions with batch size: weight reads amortize as `B` grows, KV reads scale linearly with `B`. There is no single batch size that makes both cheap.
`─────────────────────────────────────────────────`

## Sharding the sequence instead

The alternative is KV parallelism (KVP): shard the KV cache along the *sequence* dimension across `KVP` GPUs, so each holds `S/KVP` tokens. That divides both per-GPU KV footprint and per-GPU KV read time by `KVP`, which is exactly the term the `ceil` was blocking. Prior work (Medha) did this. Helix's contribution is what happens next.

The naive implementation of KVP requires an all-gather of queries before attention, because each rank needs the full query to attend against its shard. Helix avoids it: every KVP rank keeps the full input `[B, H]` and independently computes the **full QKV projection** locally. Duplicating a small projection is cheaper than gathering across the interconnect every step. Each rank then runs FlashAttention over its own KV shard in complete isolation.

Isolated shards produce partial results, and this is where exactness comes in. Each GPU emits a partial attention output plus a **log-sum-exp scalar** per token, the same trick Flash-Decoding uses for split-K attention. Softmax is decomposable given the running normalizer, so a single `All-to-All` over the query-head axis lets each GPU rescale and sum the fragments into the mathematically exact softmax-normalized result. One communication round, no extra synchronization, no approximation. Conceptually:

```python
# each KVP rank, per token
o_local, lse_local = flash_attn(q_full, k_shard, v_shard)   # partial out + logsumexp

frags = all_to_all(o_local, lse_local, axis="query_heads")   # single round

# exact softmax merge: rescale each fragment by its share of the normalizer
m   = max(f.lse for f in frags)
den = sum(exp(f.lse - m) for f in frags)
o   = sum(f.o * exp(f.lse - m) for f in frags) / den
```

The critical property: **communication volume is independent of `S`**. Each GPU ships `B × H/(KVP×TPA)` partial results. Whether context is 128K or 4M, the per-token exchange is the same constant. That is what makes the scheme viable at multi-million-token scale, where anything proportional to sequence length is fatal.

## Then reconfigure the same GPUs

Medha-style KVP fans attention out over `N` GPUs but then hands the FFN to a fixed TP group of, say, 8, leaving the rest idle for the weight-heavy stage. Helix instead treats `N = KVP × TPA` as a pool and re-provisions it mid-layer, a temporal pipeline inside each transformer block:

- **Attention phase**: `KVP × TPA` with `TPA ≤ K`, so no cache duplication anywhere.
- **Post-attention projection**: `TP = N` (the All-to-All has already realigned the data partitions for TP execution, which is a genuinely elegant piece of co-design).
- **FFN phase**: dense models keep `TPF = N`; MoE models repartition into a `TPF × EP` grid sized to expert count.

FFN TP width is now free to exceed `K`, because attention already finished and no longer cares. Two different parallelism strategies, one GPU pool, microseconds apart.

One more detail worth stealing: **staggered KV concatenation**. New tokens append to KVP rank 0 for 16 decode steps, then rank 1 for the next 16, round-robin. Every rank contributes storage regardless of batch or sequence length, so cache growth stays balanced instead of hot-spotting one device.

## Hiding the All-to-All

A single communication round is still exposed latency in the critical path. **Helix HOP-B** (Overlap Pipeline, Batch-wise) pipelines it across the batch: as soon as token 1's attention output is ready, its All-to-All launches while token 2's attention compute begins. The paper's worked example, 8 requests at 2 time units compute and 1.2 units communication each, goes from `8×2 + 8×1.2 = 25.6` units in lockstep to about 17 units pipelined, since only the final request's communication remains exposed.

The ablation is the interesting part. Disabling HOP-B costs Llama-405B about **12%** of tokens/s/user, but DeepSeek-R1 only about **1%** — for MLA models the latent projections, shared-expert computation, and multi-expert GEMMs so dominate the step that the exchange is noise. Communication overlap matters in proportion to how thin the rest of your attention block is.

## What the numbers actually are

Be precise about the evidence: these results come from an **in-house high-fidelity simulator** of GB200 NVL72 modeling NVLink transfers, DRAM bandwidth, and FLOP throughput, not from measured hardware, and all figures are normalized to baseline rather than absolute. The search swept over 100,000 configurations across TP, PP, EP, and KVP on 1–64 GPUs at FP4, with 1M-token KV caches on models that do not natively support that context.

Within those bounds, on the throughput-versus-interactivity Pareto frontier:

- **DeepSeek-R1** (671B MoE, MLA): up to **1.5x** better interactivity, or up to **32x** more concurrent users at fixed latency. MLA is where TP is most crippled, since a single shared latent means any `TPA > 1` duplicates.
- **Llama-405B** (dense, GQA `K=8`): **1.13x** interactivity and **4x** throughput and batch capacity. Real, but far more modest, and the honest read is that GQA with `K=8` leaves less on the table than MLA does.

The generalization is clean, and the authors note it themselves: below roughly 4K context, Helix degenerates to data-parallel attention plus tensor-parallel FFN, which TensorRT-LLM and SGLang already do. Helix is that pattern's long-context limit, which is a good sign the abstraction is the right one rather than a point solution.

The transferable lesson has nothing to do with Blackwell. It is that a transformer layer is two workloads with opposite resource profiles wearing one costume, and once the ratio between them shifts far enough, forcing a single sharding strategy across both means one of them is always misconfigured. Write down your roofline. If a `ceil` in it has bottomed out at 1, adding GPUs along that axis is buying you nothing.
