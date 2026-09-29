---
title: "FlexAttention: Ending the Attention Software Lottery with Compiler-Generated Kernels"
date: 2026-09-29
tags: ["gpu", "compilers", "attention", "pytorch", "performance"]
excerpt: "FlexAttention (Dong, Feng, Guessous, Liang & He, arXiv 2412.05496) turns attention variants from a kernel-engineering problem into a four-argument Python function: torch.compile inlines a user-written score_mod/mask_mod into handwritten Triton templates and derives block sparsity from a BlockMask. The result covers alibi, sliding window, PagedAttention and their combinations at 0.68x–1.43x of FlashAttention-2 — and 5.37x faster where FlashAttention's fallback loses the lottery. I reproduced the BlockMask classification locally: causal at 4k computes 528/1024 blocks, 93.9% of them mask-free, and the mask shrinks from 16 MiB dense to 4.1 KiB."
---

# FlexAttention: Ending the Attention Software Lottery with Compiler-Generated Kernels

FlashAttention won by fusing: instead of materializing the S×S score matrix, it streams KV tiles through on-chip SRAM with online softmax, turning attention from memory-bound to compute-bound. But the fusion is also the trap. The kernel is monolithic — every attention *variant* (alibi bias, sliding windows, document masking, softcapping, paged KV) needs its masking or bias logic woven into the inner loop by hand, in CUDA, twice (forward and backward). The FlexAttention paper (Juechu Dong, Boyuan Feng, Driss Guessous, Yanbo Liang, Horace He — the PyTorch team, arXiv 2412.05496) calls the consequence a **software lottery**: research ideas succeed or die based on whether someone bothered to write them a fused kernel. FlashAttention-3 ships without alibi, prefix-LM, or softcap support; combinations (GQA *and* alibi, sliding window *and* document packing) are combinatorially hopeless.

FlexAttention's bet is that the entire variant space factors into two tiny functions, and that a compiler can inline them into a handwritten kernel skeleton without giving up FlashAttention-class performance.

## The whole API is four indices

Every attention variant the paper surveys is expressible as a per-score rewrite:

```python
def score_mod(score, b, h, q_idx, kv_idx):   # runs on every (q, kv) pair
    return score + alibi_bias[h] * (q_idx - kv_idx)   # e.g. alibi

def mask_mod(b, h, q_idx, kv_idx) -> bool:   # True = keep, False = -inf
    return q_idx >= kv_idx                    # e.g. causal
```

That's it. Sliding window is `q_idx - kv_idx <= W`, document masking is `doc_id[q_idx] == doc_id[kv_idx]`, softcapping is `tanh(score / cap) * cap`. Variants compose: `and_masks`/`or_masks` combine masks logically, and score_mods nest. The paper implements prefix-LM as `or_mask(prefix_mask, causal_mask)` and neighborhood attention — including the tiled and Morton-curve variants — in under 10 lines of PyTorch each.

A mask is technically a score_mod (multiply by a 0/1 tensor and add -inf), and the API could have been just one function. Keeping `mask_mod` separate is a semantic decision, not a convenience: a mask carries the information that computation can be *skipped*, while a score_mod only says it can be *modified*. That distinction is what the whole performance story hangs on.

## BlockMask: sparsity as data, not control flow

At `create_block_mask` time, FlexAttention evaluates the user's mask_mod over the full index space (vectorized via `torch.vmap`) and classifies every BS×BS tile (BS=128 default) into three kinds:

- **empty** — every position masked: the tile never enters the kernel loop;
- **partial** — mixed: the kernel loads the tile and applies mask_mod elementwise;
- **full** — nothing masked: the tile is computed with score_mod only, *skipping the mask evaluation entirely*.

The result is stored as two tensors — `kv_num_blocks` (B×H×NumRows) and `kv_indices` (B×H×NumRows×NumCols) — which the kernel consumes as an indirect access list: for each query tile, iterate exactly the listed KV tiles, in whatever order the indices say. Sparsity becomes data the kernel walks, not branches the kernel takes, so the tile-prefetch pipeline (load next KV tile while computing the current one) survives intact.

I reproduced the classification logic in numpy to see the ratios concretely, at S=4096, BS=128 (32×32 tiles):

| mask | full | partial | empty | computed | full share of computed |
|---|---|---|---|---|---|
| causal | 496 | 32 | 496 | 51.6% | 93.9% |
| sliding window (256) | 31 | 62 | 931 | 9.1% | 33.3% |
| document (8×512) | 128 | 0 | 896 | 12.5% | 100.0% |

Two things fall out. First, for causal masks nearly all surviving work (93.9%) is full blocks — only the 32 diagonal tiles ever evaluate the mask. That's the mechanism behind the paper's "~15% improvement for common patterns such as causal masks" from the full-block optimization alone. Second, document packing is the *best* case, not an awkward one: with block-aligned documents every computed tile is full, which is why the paper's torchtune comparison shows SDPA's boolean-mask path losing 25% throughput going from 2k to 8k packed sequences while FlexAttention's BlockMask holds steady.

The memory story is just as lopsided: a dense boolean mask at 4096 is 16 MiB; the BlockMask is 4.1 KiB (~4,000×). At 128k context the dense mask would be 16 GiB — larger than the KV cache it's masking — versus 4 MiB.

## Compilation: inject, don't generate

FlexAttention does not synthesize attention kernels from scratch — that's the "traditional compiler approaches don't work here" lesson the paper draws from FlashAttention's failure to emerge from any autotuner. Instead there are **three handwritten Triton templates** (forward, backward, decode) embodying the hard-won structure: online softmax, occupancy tuning, GQA-aware memory partitioning. TorchDynamo captures the score_mod/mask_mod graph, TorchInductor lowers it to a Triton code fragment, and that fragment is spliced into the template's inner loop at the marked injection points. The backward pass rides `torch.autograd`: the mod function's backward graph is derived automatically and injected into the backward template, so a researcher writing `tanh(score/cap)*cap` never writes its gradient.

The captured-buffer trick matters more than it looks: because score_mod can close over arbitrary tensors (`alibi_bias[h]`, `doc_id[q_idx]`), variants that need per-head or per-token side data are just... indexing. No kernel signature changes, no new arguments threaded through C++.

## PagedAttention for free

The most elegant consequence: paged KV caches need **no new kernel**. PagedAttention's page-table indirection is the same shape as BlockMask's `kv_indices` indirection, so FlexAttention merges them — remap logical block indices to physical ones inside `kv_indices`, keep `kv_num_blocks` unchanged, and maintain a physical→logical vector so the user's mask_mod still sees logical `kv_idx`. Measured overhead: **under 1% on average**, against the 20–26% attention-kernel overhead the vLLM paper reported for its hand-integrated paging; at long sequence lengths, paged FlexAttention actually beat unpaged FlashAttention-2.

## The numbers

On H100/A100 (bf16, head dim 64): 1.00×–1.22× FlashAttention-2 forward on causal, 0.86×–1.05× backward; across seven variants, 0.68×–1.43× of FAv2 *where FAv2 has native support*. Where it doesn't — and SDPA falls back to itemized masks — FlexAttention is 5.49×–8.00× faster. Decoding runs 0.93×–1.45× of FlashDecoding, with one telling outlier: GQA+alibi, a combination nobody hand-wrote, where FlexAttention is **5.37×** faster because FlashDecoding's fallback path delivers a fifth of achievable performance. End-to-end: 2.04× inference throughput in gpt-fast at 16k context, 2.4× training in torchtune.

The 0.68× floor is honest and worth staring at: a compiler splicing user code into a template still loses up to a third to the best handwritten kernel on some variants. The claim isn't supremacy; it's that ~0.7–1.4× of hand-tuned, for *every* variant and every composition of variants, beats 1.0× for the five variants someone happened to implement and 0.15× for everything else. That's the lottery ending — not because everyone wins big, but because nobody draws a losing ticket.

The pattern generalizes beyond attention: keep the schedule (tiling, pipelining, softmax) as a human artifact, and compile only the pointwise semantics into it. It's the inverse of Halide's compute/schedule split — here the schedule is fixed and expert-written, and the *algorithm* is the pluggable part. For kernels where the schedule is the entire game, that division of labor looks like the durable one.
