---
title: "Aegaeon: Token-Level Auto-Scaling for GPU Pooling Across Many LLMs"
date: 2026-09-15
tags: ["llm-serving", "gpu", "scheduling", "auto-scaling", "systems"]
excerpt: "Aegaeon (SOSP '25) preempts models between decode steps instead of between requests, packing up to seven LLMs per GPU. A queueing argument shows why request-level auto-scaling caps out below three models per GPU, and a full-stack teardown of engine re-initialization — component reuse, bump-allocated VRAM, slab-allocated KV caches, CUDA-event-synchronized swaps — cuts preemptive scaling from 26.9 seconds to under one. Production deployment dropped a serving fleet from 1,192 GPUs to 213."
---

# Aegaeon: Token-Level Auto-Scaling for GPU Pooling Across Many LLMs

A model marketplace has a workload shape that inference-serving papers mostly ignore: not one hot model at high QPS, but thousands of models where more than 90% are invoked sporadically. The Aegaeon paper from Peking University and Alibaba (SOSP '25, DOI [10.1145/3731569.3764815](https://doi.org/10.1145/3731569.3764815)) opens with production statistics from a marketplace cluster: 94.1% of 779 models account for 1.35% of 167.6M requests, yet consume 17.7% of 30K GPUs — under 0.2 requests per second per dedicated GPU, against a typical achievable rate of several per second. That's an order of magnitude of stranded capacity, and the obvious fix — pack many models onto each GPU — runs into two walls.

The first wall is memory. Static multiplexing (MPS-style spatial sharing, or co-locating engines) is bounded by VRAM: at an average of 25.1 GB of weights per model in this workload, an 80 GB GPU holds two, maybe three models. The second wall is subtler and is the paper's core insight: serverless-style auto-scaling — swap models in from host memory or SSD on demand, as in ServerlessLLM — *also* caps out below three models per GPU, for a reason that has nothing to do with load speed.

## Why request-level scaling can't work: the active-model bound

Existing auto-scalers make placement decisions at request boundaries. A GPU is only freed when the request running on it completes. So the number of GPUs you need is not set by aggregate throughput but by the number of *concurrently active* models — models with at least one in-flight request. Model each model's arrivals as Poisson with rate λ and mean service time T; a model is busy with probability 1 − e^(−λT) (the M/G/∞ busy probability — it depends only on the mean, not the service distribution), so:

```
E[active models] = M · (1 − e^(−λT))
```

LLM requests are *long*: the paper's production trace has T = 16.79 s and λ = 0.037 req/s per model. Plug in M = 100 and you get λT ≈ 0.62, so ~46 of 100 models are active at any instant despite an aggregate load of only 3.7 req/s. I verified this with a quick M/D/∞ union-of-intervals simulation — closed form gives 46.27, my simulation 46.30; the paper's own simulated figure of 46.55 runs about 0.6% high, but the story is the same. One hundred models over forty-six mandatory GPU instances is fewer than three models per GPU — request-level auto-scaling buys you nothing over static multiplexing, and any attempt to reserve fewer instances than active models produces head-of-line blocking measured in tens of seconds of TTFT.

The exponent is the killer: cutting cold-start time (the entire focus of prior serverless-LLM work) doesn't touch λT. What does is changing the preemption granularity. If you can suspend a model *mid-request* — between decode steps — a GPU no longer belongs to a model for the full 16.79 s. Aegaeon schedules auto-scaling at the token level, and with it the same hardware sustains up to seven models per GPU.

## Scheduling tokens, not requests

Token-level preemption creates a scheduling problem where every decision trades token deadlines against multi-second scaling penalties. Aegaeon's SLO metric is per-token: each request has a TTFT deadline for its first token and a TBT (time-between-tokens) deadline for the rest, and attainment is the fraction of tokens that land on time. A late token deep in a stream can be masked by client-side buffering of earlier tokens; a late first token cannot. That asymmetry drives the design: prefill and decode get separate GPU partitions (prefill/decode disaggregation) and completely different schedulers.

**Prefill: grouped FCFS.** Scaling up a 13B BF16 model over PCIe 4.0 costs at least 26 GB / 32 GB/s ≈ 0.81 s — comparable to executing an entire prefill batch. Naive FCFS across models would thrash: every queue position that switches models pays a scale-up. Aegaeon groups queued jobs by model (up to 8 per group, found by grid search), appends new groups to the least-loaded queue where load includes estimated scaling time, and runs prefills at batch size 1 — prefill time grows roughly linearly in tokens anyway, and small batches hand requests to the decode tier sooner.

**Decode: weighted round-robin with earned slack.** A decode step takes t ≈ tens of milliseconds against a TBT deadline d ≈ 100 ms, so every n consecutive steps earn n(d − t) of slack that can be spent swapped out. Each decode instance keeps a rotating work list of per-model batches and gives batch i a time quota:

```python
n_i   = d / t_i                      # steps affordable per deadline
alpha = max(c / (min(n) * Q_MAX) + sum(1/n_k for k in batches), 0.5)
q_i   = c / (n_i * (alpha - sum(1/n_k for k in batches)))
```

where c is the total auto-scaling overhead for the round and Q_MAX caps quotas at 4 s. The construction makes every batch's stall exactly the buffered window its own decoding earned, so round SLO attainment is min(1, 1/α). The paper's worked example checks out: three batches, d = 0.1 s, t = 0.025 s, c = 3 s gives n = 4, α = 1, q = 3 s each — a 12 s round emitting 120 tokens per batch, precisely the 12 s the client needs to drain them at 10 tokens/s. Nothing is late, yet the GPU changed models three times.

## Making preemption cost less than a second

None of this matters if a model switch takes tens of seconds — and unoptimized, it does: KV-cache swap-out, garbage collection, engine re-initialization, weight load, KV swap-in totals 26.9 s for a 13B model on vLLM. The breakdown is damning — most of it isn't weight loading. Ray/NCCL distributed-executor setup takes tens of seconds, KV-cache host-memory pinning several more, profiling several more, and the weight copy itself crawls at 2.83 GB/s against a 32 GB/s bus. Aegaeon attacks every stage:

**Component reuse.** The executor, communication groups, scheduler, and profiling results are model-agnostic or precomputable; only weights and KV cache actually change. Initializing the engine once per instance and caching everything else removes over 80% of the latency by itself.

**Explicit memory management.** PyTorch's caching allocator forces a multi-second `gc.collect()` + `empty_cache()` pass between back-to-back model loads. Aegaeon claims ~90% of VRAM at startup as one self-managed buffer and monkey-patches `torch.nn.Parameter` at import time so weight tensors come from a bump allocator — deallocation is a pointer reset, and GC disappears. On the host side, offloaded KV caches have per-model shapes (128 KB/token for InternLM2.5-7B's GQA layout up to 2,560 KB/token for Qwen-72B), so a unified cache uses slab allocation: fixed-size slabs each dedicated to one shape, keeping measured fragmentation under 20%. Weight loading goes through a shared host-memory model cache and a pinned per-GPU stage buffer, chunked and pipelined to under a second — plus an optional prefetch stream that loads the *next* scheduled model into spare buffer space during the current turn, making about half of all scale-ups effectively free.

**Fine-grained KV synchronization.** Swap-in, swap-out, and compute run on separate CUDA streams, which invites races: decode can't start before its KV lands, transfers can't reuse blocks another transfer still touches — across processes, since prefill and decode instances are distinct. Aegaeon tracks each transfer with CUDA events, shared over IPC handles, using `cudaStreamWaitEvent` to encode the dependency graph on-device instead of blocking the data plane. Net effect: 97% of auto-scaling overhead gone, sub-second preemptive scaling even when prefetch misses.

## Does it hold up?

On a 16×H800 testbed against ServerlessLLM and MuxServe, Aegaeon sustains 2–2.5× higher arrival rates at equal SLO attainment, or 1.5–9× higher goodput. The deployment numbers are the striking part: in beta in a production model marketplace for three months, serving 28 models of 1.8–7B (TP=1) and 19 of 32–72B (TP=4), Aegaeon replaced 1,192 H20 GPUs with 213 — an 82% reduction — while average utilization rose from 13.3–33.9% to 48.1% with no observed SLO violations. The honest caveat is in §7.2: under very tight TBT budgets the scaling cost can't hide in slack, and static multiplexing still wins. Token-level pooling is a scheme for the long tail — which, at 90%+ of a marketplace's catalog, is where the money was being burned.
