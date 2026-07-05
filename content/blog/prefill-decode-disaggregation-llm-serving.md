---
title: "Two Workloads in a Trench Coat: Prefill/Decode Disaggregation in LLM Serving"
date: 2026-07-05
tags: [llm-inference, kv-cache, distributed-systems, gpu, performance]
excerpt: Prefill and decode have opposite hardware profiles, and serving them on the same GPUs wastes both. A practical tour of DistServe and Mooncake, the two papers behind the biggest architecture shift in LLM inference.
---

## One request, two very different programs

Profile an LLM inference server and you will find two programs pretending to be one. **Prefill** ingests the entire prompt in a single forward pass: big matrix multiplies over thousands of tokens, easily compute-bound, capable of saturating an H100 with a single long request. **Decode** then generates one token per step per sequence: every step must stream all model weights plus a growing KV cache through HBM to produce a handful of FLOPs, which makes it memory-bandwidth-bound unless you batch aggressively.

The numbers make the mismatch concrete. A 70B model in fp16 holds roughly 140 GB of weights. At batch size 1, every decode step reads all of them to emit one token, so an H100 with 3.35 TB/s of HBM bandwidth is floor-limited to ~40 ms per token while its ~990 TFLOPS of BF16 compute sits nearly idle. Prefill has the opposite profile: a 32k-token prompt gives the tensor cores thousands of tokens of work per weight read.

Each phase also has its own latency SLO. Prefill determines **TTFT** (time to first token, what makes a chatbot feel responsive). Decode determines **TPOT** (time per output token, what makes streaming feel smooth). Two workloads, two bottlenecks, two SLOs. For years we ran both on the same GPUs with the same parallelism configuration. Two papers, DistServe (OSDI '24) and Mooncake (the system behind Moonshot AI's Kimi, later a FAST '25 paper), made a strong case that this is an anti-pattern, and by 2025 the industry largely agreed.

## Why colocation hurts

Modern engines use continuous batching (introduced by Orca): new requests join the running batch at any iteration. The problem is interference. When a 30k-token prefill enters a batch, every decoding sequence in flight stalls behind that iteration, and p99 TPOT spikes. Chunked prefill (Sarathi-Serve) softens this by slicing prompts into chunks and piggybacking decode steps alongside each chunk, but every chunk still taxes decode latency, and it does nothing about the deeper coupling: both phases are forced to share one parallelism strategy. A tensor-parallel degree of 8 might be exactly right to hit your TTFT target on long prompts and simultaneously be a waste of interconnect bandwidth for decode, which would rather run wider batches on fewer shards.

DistServe reframes the objective around **goodput**: requests per second per GPU that meet *both* the TTFT and TPOT SLOs. Optimizing raw throughput lets one metric silently eat the other; colocated systems routinely over-provision GPUs just to keep both SLOs green at once.

## DistServe: split the phases, tune each one

DistServe's move is structural: dedicated prefill instances and dedicated decode instances, with the KV cache handed off between them. Once separated, each pool gets its own independently optimized configuration. Prefill instances pick a parallelism strategy that minimizes TTFT for the observed prompt-length distribution. Decode instances pick one that maximizes batched token throughput under the TPOT ceiling. A placement algorithm assigns instances to physical nodes based on measured interconnect bandwidth, because disaggregation's new cost is moving the KV cache.

The payoff reported in the paper: up to **7.4x more requests** served, or **12.6x tighter SLOs**, versus state-of-the-art colocated serving, while keeping over 90% of requests within their latency targets.

## The KV cache transfer tax

Skeptics' first question: isn't shipping the KV cache between machines ruinous? Work out the size:

```python
def kv_bytes_per_token(n_layers=80, n_kv_heads=8, head_dim=128, dtype_bytes=2):
    # K and V, per layer, per KV head (GQA means 8 KV heads, not 64)
    return 2 * n_layers * n_kv_heads * head_dim * dtype_bytes

per_token = kv_bytes_per_token()      # 327,680 bytes = 320 KiB (Llama-3.1-70B-ish)
prompt_32k = per_token * 32_768       # ~10.7 GB for one long prompt

rdma_400g = prompt_32k / 50e9         # ~215 ms over 400 Gbps RDMA
nvlink    = prompt_32k / 900e9        # ~12 ms over NVLink
```

A fifth of a second sounds bad until you notice two things. First, prefilling 32k tokens on a 70B model takes seconds of GPU time, so the transfer is a minority cost. Second, you can stream the cache layer by layer: transfer layer *i*'s KV while computing layer *i+1*, overlapping nearly all of it and exposing only the final layer's worth of latency. With RDMA or NVLink and this pipelining, the tax is small; without a fast interconnect, it is the reason disaggregation may not be for you.

## Mooncake: make the KV cache the center of the system

Mooncake, which serves Kimi in production, pushes the idea further: the KV cache is not a payload to move between phases, it is the **first-class resource the whole cluster is scheduled around**. Beyond separate prefill and decode clusters, Mooncake pools the idle DRAM, SSD, and NIC capacity of every GPU node into a distributed KV cache. The paper's subtitle is literal: trade more storage for less computation.

The lever is prefix reuse. Real traffic is full of shared prefixes: system prompts, multi-turn conversation history, documents being interrogated repeatedly. Mooncake's scheduler (called Conductor) routes each request toward the node holding the longest cached prefix, so prefill computes only the uncached suffix. Storage is cheap; recomputing attention over the same 20k-token document on every turn is not. Conductor constantly balances cache-hit maximization against hotspot load, because always routing to the cache holder would melt it.

The second production lesson is overload handling. Academic serving systems assume every arriving request gets served; a real product at peak cannot. Mooncake uses **prediction-based early rejection**: at admission it predicts whether a request can meet both TTFT and TPOT given current pool states, and if not, rejects it *before* burning prefill GPU-seconds on work whose decode would miss SLO anyway. A rough sketch of the admission logic:

```python
def admit(req, prefill_pool, decode_pool, slo):
    p = max(prefill_pool, key=lambda n: n.cached_prefix_len(req))   # reuse first
    d = min(decode_pool, key=lambda n: n.load)
    ttft_est = p.queue_delay() + p.prefill_time(req.uncached_tokens) \
             + transfer_time(req.kv_bytes)
    tpot_est = d.predicted_tpot(d.active_seqs + 1)
    if ttft_est > slo.ttft or tpot_est > slo.tpot:
        return Reject(early=True)   # shed load now, not after wasting prefill
    return Schedule(prefill=p, decode=d)
```

Reported results: up to **525% higher throughput** in long-context simulated scenarios, and **75% more requests** handled in production under real SLOs.

## When you should not disaggregate

Disaggregation is not free lunch. If your prompts are short, prefill is a rounding error and splitting pools just fragments capacity. If your interconnect is slow (PCIe-only boxes, plain Ethernet without RDMA), the transfer tax stops hiding. And a static split has a provisioning problem: the right prefill-to-decode ratio shifts with traffic mix, so small fleets can end up with one pool idle while the other queues. Production frameworks answer this with dynamic role reassignment, flipping GPUs between pools as the mix changes.

That is exactly where the ecosystem went in 2025: NVIDIA's Dynamo framework is built around disaggregated serving with a planner that rebalances workers between pools, vLLM ships experimental disaggregated prefill, SGLang's PD-disaggregation mode integrates Mooncake's transfer engine, and the Kubernetes-native llm-d project treats the split as a founding assumption.

## Takeaways

- Prefill and decode are different programs: compute-bound vs bandwidth-bound, TTFT vs TPOT. One GPU pool with one parallelism config cannot be optimal for both.
- The KV cache transfer cost that makes disaggregation look scary is largely hideable with layer-wise streaming over RDMA or NVLink; do the bytes-per-token math for your model before dismissing it.
- Mooncake's production lessons generalize: treat the KV cache as a schedulable cluster-wide resource, exploit prefix reuse ruthlessly, and reject doomed requests at admission instead of after prefill.

If you are running LLM inference at scale on a colocated engine, measure your goodput, not your throughput. The gap between them is the size of the opportunity.
