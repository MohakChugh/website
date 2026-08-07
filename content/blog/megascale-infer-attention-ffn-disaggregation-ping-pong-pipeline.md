---
title: "MoE Decoding Is Two Different Workloads: Attention-FFN Disaggregation and the Ping-Pong Pipeline"
date: 2026-08-07
tags: [mixture-of-experts, llm-inference, gpu-utilization, roofline, rdma]
excerpt: "Sparse activation turns MoE feed-forward layers from compute-bound into memory-bound, and no amount of batching fixes it while attention and FFN share a GPU. MegaScale-Infer splits them onto separate nodes and shuttles micro-batches between them. I re-derived its roofline math, built my own balance model, and found the paper's heterogeneous hardware choice is provable from the price sheet alone, while one sentence in its ablation contradicts its own constraint."
---

Here is a number that indicts a whole generation of MoE serving stacks. Serve Mixtral 8x22B on an A100-SXM-80GB in bfloat16, batch 156 requests — exactly the batch size the roofline says you need to become compute-bound — and your feed-forward layers run at **25% of peak FLOPs**. Not because the batch is too small. Because top-2 routing over 8 experts means each expert sees 156 × 2/8 = 39 tokens, and 39 tokens cannot saturate a GEMM.

That is the argument in "MegaScale-Infer: Serving Mixture-of-Experts at Scale with Disaggregated Expert Parallelism" (Zhu, Jiang, Jin et al., ByteDance Seed and Peking University, arXiv:2504.02263v4). The headline is up to 1.90× higher per-GPU decode throughput, but the interesting part is the diagnosis, which generalizes past this one system.

## The sparsity tax, stated as an inequality

Start from the roofline. A `b × h` by `h × n` GEMM in bf16 does `2bhn` FLOPs while reading `2hn` bytes of weights. Compute time exceeds memory time when `2bhn/F ≥ 2hn/B`, which collapses to a result independent of the matrix shape entirely:

```
b ≥ F / B
```

For an A100 (312 TFLOPS, 2 TB/s) that is 156 tokens. Every dense-model serving intuition you have is built on this threshold. MoE breaks it, because only `topk/E` of the batch reaches any given expert:

```python
def ffn_utilization(b, topk, n_experts, F, B):
    """Fraction of peak FLOPs the FFN achieves at decode batch size b."""
    return min((topk / n_experts) * (B / F) * b, 1.0)

# The inversion is the part that matters:
def batch_needed(topk, n_experts, F, B):
    return (n_experts / topk) * (F / B)
```

Invert it and the tax becomes concrete. For the three models the paper evaluates, on an A100:

| Model | Experts | top-k | Batch for full FFN utilization |
|---|---|---|---|
| Mixtral 8x22B (141B) | 8 | 2 | 624 tokens |
| DBRX (132B) | 16 | 4 | 624 tokens |
| Scaled-MoE (317B) | 32 | 4 | **1248 tokens** |

Scaled-MoE needs a single decode batch of 1248 tokens to stop wasting the GPU. That is precisely the batch size KV-cache memory will not give you — and the bigger the MoE, the scarcer the memory, so the constraint tightens exactly where you need it to loosen. Raising tensor parallelism to free memory buys batch at the cost of communication. This is a closed trap as long as attention and FFN live on the same device.

## Two workloads wearing one trench coat

The escape is to notice that attention and FFN have opposite roofline signatures during decode. Attention reads a *per-request* KV cache, so its byte count scales with batch size and no reuse exists. FFN reads *shared* weights, so batching amortizes them perfectly. Colocating them makes every deployment decision a compromise between a memory-bound tenant and a compute-bound one.

MegaScale-Infer splits each layer across two node types. Attention nodes hold the QKV and output projections plus the KV cache, replicated `n_a` ways. Expert nodes each hold one expert's parameters. Tensor parallelism operates *within* a node to exploit NVLink; the fan-in across nodes manufactures the batch. With `n_a` attention replicas each carrying micro-batch `b_a`, each expert receives

```
b_e = b_a · n_a · K / E
```

which is the whole trick: you reach the 624-or-1248-token threshold by adding attention replicas, not by growing any single request batch.

The second payoff is heterogeneity, and I wanted to check whether the hardware choice was principled or fitted. Attention is memory-bound, so it wants maximum bandwidth per dollar. Batched FFN is compute-bound, so it wants maximum FLOPS per dollar. Those are different columns of the price sheet. Running the paper's own Table 3 through an argmax:

| Accelerator | GB/s per unit cost | TFLOPS per unit cost |
|---|---|---|
| H20 | **2214** | 80 |
| A800 | 902 | 138 |
| L20 | 864 | 120 |
| L40S | 800 | **335** |
| H800 | 650 | 187 |

The optimum is H20 for attention and L40S for experts, exactly what the paper deploys — no search required, it drops out of the ratios. More usefully, the best *homogeneous* SKU (A800) reaches only 41% of both ceilings at once; H20 alone hits 100% of the bandwidth ceiling but 24% of the compute one. That ~2.4× headroom bounds what disaggregation can win, and the paper measures 3.24× over vLLM and 1.86× over TensorRT-LLM on H20, bracketing my estimate.

## Ping-pong pipelining, and its exact bound

Disaggregation creates a new problem: attention idles while experts compute, and both idle during the two network hops per layer. The fix is to split the global batch into `m` micro-batches and shuttle them so every node always has work. The conditions for full overlap:

```
(1)  T_a ≈ T_e            balance, or the slower side sets the pace
(2)  T_c < T_f            a hop must fit inside a compute step
(3)  m · T_f ≥ 2(T_f + T_c)    where T_f = max(T_a, T_e)
```

Constraint 3 rearranges to a deployment rule worth memorizing:

```python
import math
def min_micro_batches(Tc_over_Tf):      # constraint 2 forces 0 < ratio < 1
    return math.ceil(2 * (1 + Tc_over_Tf))

# ratio 0.10 -> 3     ratio 0.49 -> 3
# ratio 0.75 -> 4     ratio 0.99 -> 4
```

So `m` is always 3 or 4, which is why their planning algorithm caps `N_m` at 4 — beyond that, micro-batches get small enough that expert GEMM efficiency degrades and you have re-created the original problem one level down. Full-batch latency is `T_total = (T_a + T_e + 2T_c) + T_f(mL − 1)`: the additive prologue is paid once, not per layer, which is the entire value of the pipeline.

**One sentence in the ablation contradicts this.** Discussing Figure 14, the paper writes that "m = 2 is ideally sufficient to achieve high GPU utilization." But constraint 3 with any `T_c > 0` gives `m > 2` strictly; `m = 2` is feasible only in the limit of free communication. The measurements side with the constraint, not the sentence — m=2 to m=3 still gains 1.10×, 1.28×, and 1.38× on the three models, scaling with model size because bigger models mean more GPUs mean more `T_c`.

## Where the balance point actually sits

Constraint 1 says pick `n_a` so `T_a ≈ T_e`. The paper derives `n_a = k₁E/(k₃K)` from profiled linear fits, and Figure 15 reports DBRX peaking at attention DP = 8. I built an independent per-layer roofline model to see whether that is derivable, modelling GQA KV traffic as `b_a · s · 2 · (h/g) · 2 / tp_a` bytes with `g = 6` for DBRX's 48-query / 8-KV-head grouping, at mid-generation sequence length `s ≈ 650`:

```
 n_a     b_e   T_a(us)  T_e(us)  T_e/T_a   FFN MFU
   1      32     129.2    132.1     1.02       21%
   4     128     129.2    132.1     1.02       82%
   6     192     129.2    162.6     1.26      100%
   8     256     129.2    216.8     1.68      100%
```

At `tp_a=2, tp_e=1, b_a=128` my crossing lands near `n_a ≈ 5`, not 8. Sweeping the space, `n_a ≈ 8` appears at `tp_e = 2` with `b_a = 256` — so the figure is consistent with 2-GPU expert nodes, not a contradiction, just an unstated parameter. The takeaway is that **the balance point is a function of `tp_e` and sequence length, not a constant**. My breakdown shows attention at `b_a=128` spending 36µs of compute against 129µs of memory traffic, of which KV cache is 66% of the bytes. Longer contexts push `T_a` up and the balance point down; a system tuned for 650-token sequences is misprovisioned for 8k.

## The communication layer nobody budgets for

Disaggregation converts each layer's All-to-All into M2N and N2M transfers between `M` attention GPUs and `N` expert GPUs. The payloads are small: Mixtral 8x22B at micro-batch 128 with `tp_a=2` sends `128 × 2/8 × 6144 × 2 / 2` = 196,608 bytes per pair. At that size NCCL's fixed costs dominate — GPU-to-CPU staging copies through the CPU proxy, peer-to-peer group operations batched at most 8 at a time (degrading precisely as `N` grows), and general-purpose group setup.

Their replacement blocks the CUDA stream via driver operations, does RDMA write-with-immediate from a single CPU thread, polls the completion queue, and unblocks via a shared-memory flag — no GPU synchronization primitives, no staging copies. That yields up to 80.8% lower median latency, 54.7–96.9% lower tail latency, and 3.3–5.8× throughput over NCCL. The tail numbers matter more than the medians: with `m=3`, one slow hop stalls the pipeline, so `T_c` in constraint 2 is really a p99, not a mean.

An honest tradeoff is noted against DeepEP's GPU-driven approach: a CPU issues doorbells faster from one queue pair thanks to clock speed, while GPU SMs manage many queue pairs in parallel. At hundreds of KB per pair a single CPU thread saturates the NIC; push expert counts high enough that per-pair volume collapses and the GPU-driven design wins. That crossover is a property of your expert count, not a verdict.

## What to take from this

The transferable idea is not disaggregation. It is that **sparse activation makes a single serving-level roofline meaningless**, because the two halves of a layer sit on opposite sides of the ridge point. Accept that and the consequences cascade: fan-in replaces batch size as the tuning knob; hardware selection becomes two independent argmaxes over a price sheet; pipeline depth becomes a closed form in your network-to-compute ratio; and your collective library, sized for training's multi-megabyte transfers, turns out wrong for 200KB messages. The production result — roughly 10,000 GPUs, serving cost down 1.5–2.0× — is downstream of noticing that one GPU was being asked to do two incompatible jobs.
