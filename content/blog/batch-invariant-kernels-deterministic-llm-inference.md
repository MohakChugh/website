---
title: "Batch-Invariant Kernels: Why LLM Inference Is Nondeterministic and How to Fix It"
date: 2026-07-29
tags: ["llm-inference", "gpu-kernels", "determinism", "numerical-computing", "reinforcement-learning"]
excerpt: "Temperature-zero LLM endpoints still return different completions run to run. The usual explanation, floating point plus concurrency, is wrong. The real cause is that reduction kernels change their arithmetic order with batch size, and fixing it turns RL policy divergence from 0.001 into exactly zero."
---

# Batch-Invariant Kernels: Why LLM Inference Is Nondeterministic and How to Fix It

Set `temperature=0`, pin your seed, send the same prompt twice to a production inference endpoint, and you will often get two different completions. The folk explanation is that GPU floating point arithmetic is nondeterministic because concurrent threads accumulate in arbitrary order. That explanation is comforting, widely repeated, and mostly wrong.

Thinking Machines' 2025 analysis of this problem ("Defeating Nondeterminism in LLM Inference") makes the sharper claim: a well-implemented LLM forward pass is already run-to-run deterministic. There is usually not a single atomic add in it. Feed the server identical requests in an identical batch and you get bit-identical logits every time. The nondeterminism you observe as a user comes from somewhere else entirely, and it is worth understanding precisely because the fix unlocks something RL practitioners have wanted for years.

## Floating point non-associativity is the original sin, not the cause

Floating point addition is not associative. `(a + b) + c` and `a + (b + c)` differ whenever the intermediate rounding differs, which is most of the time once operands span different magnitudes. Here is the effect on a thousand-element float32 vector:

```python
import numpy as np
rng = np.random.default_rng(0)
v = rng.standard_normal(1000).astype(np.float32)

def split_sum(v, k):
    """Reduce in chunks of k, then combine partials. This is what a GPU kernel does."""
    return np.float32(sum(np.float32(v[i:i+k].sum(dtype=np.float32))
                          for i in range(0, len(v), k)))

split_sum(v, 256)   # -48.028275
split_sum(v, 250)   # -48.028282
```

Two reductions, same input data, same total operation count, different chunk size. The results differ by 7.6e-06. Sweeping the chunk size across values a scheduler might plausibly pick (64 to 512 in steps of 8) yields **five distinct sums** spanning 1.5e-05.

Non-associativity explains why different orders give different answers. It does not explain why the order would change between two runs of the same server. That requires a mechanism that varies the reduction order, and the mechanism is batch size.

## The real culprit: kernels are not batch-invariant

A kernel is *batch-invariant* if the value computed for a given element does not depend on how many other elements were in the batch. Nearly no production kernel satisfies this, because batch size is exactly what kernel authors tune reduction strategy against.

The consequence is a subtle inversion of where the nondeterminism lives. Your request does not carry its own numerics. It gets batched with whatever else arrived in the same window, and *that* batch size selects a reduction order. Server load varies nondeterministically, so batch size varies, so your logits vary. The server is deterministic; your view of it is not.

That 7.6e-06 discrepancy sounds harmless. It is not, because autoregressive decoding is a feedback loop. A perturbation below the threshold of the argmax is invisible until two logits are close, at which point the sampled token flips and the two trajectories diverge permanently. In the reported experiment on Qwen3-235B-A22B-Instruct-2507, 1000 samples at temperature 0 produced **80 unique completions**, with the most common appearing 78 times. All 1000 agreed on the first 102 tokens. At token 103, 992 continued with "Queens, New York" and 8 with "New York City."

Only reduction operations can break invariance; pointwise ops are trivially invariant. In a transformer that leaves three suspects.

## RMSNorm: easy, if you resist the tiny-batch temptation

The default RMSNorm strategy is data-parallel: assign one row to one core, do the whole feature-dimension reduction inside that core. Add more rows and each core just loops over more of them sequentially. Reduction order per element never changes. This is already batch-invariant.

Invariance breaks precisely when engineers optimize the small-batch case. With fewer rows than cores, a data-parallel kernel idles most of the GPU, so the natural move is to split each row's reduction across cores and combine partials. That changes the reduction order as a function of batch size. The fix is to refuse the optimization: commit to one strategy with enough parallelism for the smallest shape you care about, and accept below-peak throughput elsewhere. Small batches are fast anyway.

## Matmul: kill Split-K, pin one tile configuration

Matmul follows the same logic with 2D output tiles instead of single elements, because tensor cores and arithmetic intensity demand tiling. Two things break invariance:

1. **Split-K.** When M and N are both small, there is not enough output-tile parallelism to fill the GPU, so libraries split the reduction dimension K across cores and combine partials. Different batch size, different split, different order.
2. **Instruction-shape switching.** Libraries swap tensor-core instruction sizes across shapes, or abandon tensor cores entirely at batch size 1. Each variant has its own internal accumulation order.

```python
# Illustrative: one row through a matmul, vs the same row inside a batch.
import torch
B = torch.randn(2048, 4096, device="cuda", dtype=torch.bfloat16)
a = torch.randn(1, 4096, device="cuda", dtype=torch.bfloat16)
batched = torch.randn(512, 4096, device="cuda", dtype=torch.bfloat16)
batched[0] = a[0]

alone = a @ B.T                  # library picks a small-M config, maybe Split-K
in_batch = (batched @ B.T)[0:1]  # library picks a different config entirely
(alone - in_batch).abs().max()   # nonzero
```

The fix is unglamorous: compile a single kernel configuration and use it for every shape. Split-K only pays off when M *and* N are both small, and N is the model dimension, which is never small. The reported cost is roughly 20% below cuBLAS with an unoptimized Triton kernel lacking TMA, concentrated at very small batch sizes. Note in passing that stream-K is worse than Split-K here: it is not even batch-*position*-invariant, whereas most matmul libraries at least manage that much.

## Attention: fixed split size, not fixed split count

Attention is the hard one. It reduces over both the feature and sequence dimensions, and it has to survive chunked prefill, prefix caching, and paged KV layouts. The invariance requirement is strict: the reduction order for a token must not depend on how many tokens of its own sequence are being processed concurrently. Query token 1000 must reduce identically whether the KV cache holds 0 or 999 tokens.

Two distinct bugs live here.

**Inconsistent KV layout.** Reducing cached K/V separately from freshly computed K/V, as vLLM's Triton prefix-prefill kernel does, makes block boundaries depend on the prefill/decode split. With block size 32, 80 cached elements plus 48 new ones need five blocks instead of the four they would occupy if laid out contiguously. Fix: update the KV cache and page table *before* invoking attention, so the kernel always sees one consistent layout.

**Split-KV with a load-dependent split.** Decoding has query length 1, so without splitting the KV dimension the kernel cannot fill the GPU. FlashDecoding is genuinely necessary. But fixing the *number* of splits is not sufficient, and it is the intuitive thing to do:

```
KV length 1000, fixed split COUNT of 4  -> 4 splits of 250
KV length 1024, fixed split COUNT of 4  -> 4 splits of 256   # different order!

KV length 1000, fixed split SIZE of 256 -> 256, 256, 256, 232
KV length 1024, fixed split SIZE of 256 -> 256, 256, 256, 256  # same order per element
```

Fixed count makes split size a function of sequence length. Fixed size makes the split *count* vary instead, which is fine, because each element's position within its own split is now stable. Schedulers that choose split size by core saturation, as FlashInfer's balanced scheduler does, break invariance by construction. This is the one change that required unreleased FlexAttention work.

## What it costs and what it buys

With batch-invariant kernels, all 1000 Qwen3-235B completions were bit-identical. Throughput on one GPU with Qwen3-8B, 1000 sequences of 90 to 110 output tokens: 26s for default vLLM, 55s unoptimized deterministic, 42s with the improved attention kernel. Much of that gap is an unoptimized FlexAttention integration rather than an inherent cost of determinism.

Upstream, vLLM now ships this behind `VLLM_BATCH_INVARIANT=1` (beta, tracking issue #27433), requiring compute capability 8.0 or higher, validated across DeepSeek-V3/R1, Qwen3 dense and MoE, Llama 3.x, GPT-OSS, Mistral and Phi. Notably it disables custom all-reduce under tensor parallelism, since that is another order-varying reduction.

The payoff that justifies the tax is on-policy RL. Trainer and sampler are different numerical stacks, so "on-policy" training is quietly off-policy, and you pay for that with importance-weighting machinery to stay stable. In the reported RLVR run on Bigmath from a Qwen 2.5-VL 8B init, no correction meant reward collapse with a loss spike near step 318; off-policy correction held KL near 0.001 with occasional spikes. With a bitwise-identical sampler and trainer, KL divergence was a flat line at exactly zero. Truly on-policy, with the correction term deleted rather than tuned.

The broader lesson generalizes past GPUs and past transformers. Determinism is not a property of hardware, it is a property of whether your reduction order is a function of your input alone or also of your scheduler's opinion about load. Anywhere a kernel adapts its strategy to shape, you have traded reproducibility for throughput, usually without writing it down.
