---
title: "DeepSeek Sparse Attention: A Lightning Indexer, Top-k Token Selection, and Retrofitting Sparsity onto a Trained Model"
date: 2026-09-27
tags: ["llm-inference", "sparse-attention", "attention", "long-context", "ml-systems"]
excerpt: "DeepSeek-V3.2-Exp swaps dense attention for fine-grained sparsity — not by training from scratch, but by bolting a tiny FP8 'lightning indexer' onto V3.1-Terminus and distilling the model's own attention distribution into it via KL loss. Each query attends to only the top-2048 of 128K tokens (1.6% density), core attention drops from O(L²) to O(Lk), and decode cost at 128K goes nearly flat. The interesting part is the training recipe: 2.1B tokens of frozen-model warm-up, then 943.7B tokens of sparse adaptation with the indexer detached from the main gradient graph."
---

# DeepSeek Sparse Attention: A Lightning Indexer, Top-k Token Selection, and Retrofitting Sparsity onto a Trained Model

Every sparse-attention paper faces the same objection: you changed the architecture, so you had to pretrain from scratch, so nobody with an existing frontier model can use your result. Native Sparse Attention (NSA), covered here previously, trained sparsity in from token one. DeepSeek-V3.2-Exp ([technical report](https://github.com/deepseek-ai/DeepSeek-V3.2-Exp)) answers the objection directly: it takes DeepSeek-V3.1-Terminus — an already-trained, 128K-context MoE model — and converts it to fine-grained sparse attention through continued training. The only architectural change is DeepSeek Sparse Attention (DSA), and the conversion costs about 946B tokens, roughly 6% of a modern pretraining run.

The design has two pieces: a **lightning indexer** that scores every history token per query, and a **fine-grained token selector** that keeps only the top-k. Nothing else about the model changes.

## The lightning indexer

For query token `h_t` and each preceding token `h_s`, the indexer computes a scalar relevance score:

```
I[t,s] = sum_{j=1..H_I}  w[t,j] * relu( q_I[t,j] · k_I[s] )
```

where `q_I[t,j]` and the per-head weight `w[t,j]` are projected from `h_t`, and `k_I[s]` is projected from `h_s`. In the released config this is 64 indexer heads of dimension 128, computed in FP8, with ReLU chosen over softmax explicitly for throughput — no row-wise normalization means no second pass over the sequence and a trivially parallel kernel.

Note what the indexer is *not*: it is not a retrieval structure. There is no HNSW graph, no clustering, no block summaries. It is a brute-force O(L²) scan — but a deliberately tiny one. Back-of-envelope from the released dimensions: MLA's core attention in MQA mode pays 128 query heads × (576-dim QK + 512-dim V) ≈ 139K MACs per (query, key) pair in BF16, while the indexer pays 64 × 128 = 8K MACs in FP8 — about 1/17th the work per pair at half the bytes per operand. At 128K context, dense attention costs ~1.8e10 MACs per query token; DSA pays ~1.1e9 for the full indexer sweep plus ~2.9e8 for real attention over the selected 2048 tokens — roughly 13× fewer MAC-equivalents, more like 20× once FP8 throughput is priced in. The quadratic term survives, but with a constant small enough that it stops being the bill.

## Fine-grained selection under MLA

Given scores `I[t,:]`, the selector takes the top-k key-value entries (k = 2048 in both training and the released config) and runs ordinary attention against just those:

```python
def dsa_attention(h_t, history, indexer, attn, k=2048):
    scores = indexer(h_t, history)            # FP8, 64 heads, ReLU — O(L)
    idx = topk(scores, k)                     # fine-grained: individual tokens
    selected = history.kv_latent[idx]         # gather MLA latent vectors (576-dim)
    return attn(h_t, selected)                # dense attention, but L -> k
```

"Fine-grained" is the load-bearing word. NSA selects *blocks* of tokens because its selection scores are shared across GQA groups and blockwise gathers keep tensor cores fed. DSA selects individual tokens — and gets away with it because of how MLA works in its MQA mode: every key-value entry is a single 576-dim latent vector (512 compressed + 64 RoPE) shared across *all 128 query heads*. One gathered latent serves 128 queries' worth of arithmetic, so the kernel still has enough reuse per loaded byte to be compute-dense even with a fully irregular gather. The report is explicit that this sharing requirement is why DSA is instantiated on MLA's MQA mode rather than its MHA mode. Sparsity granularity, it turns out, is downstream of your KV sharing factor.

## The training recipe is the contribution

Retrofit sparsity naively — bolt on a random indexer and start masking — and you destroy the model. DeepSeek's recipe treats the indexer's job as a *distillation* problem: learn to predict what full attention would have attended to.

**Stage 1 — dense warm-up (2.1B tokens).** Everything is frozen except the indexer; attention stays dense. The target distribution `p[t,:]` is the model's own attention: sum the main attention scores across all 128 heads, L1-normalize along the sequence. The indexer minimizes `KL(p[t,:] || softmax(I[t,:]))` at learning rate 1e-3 for 1000 steps of 16 × 128K-token sequences. (The arithmetic checks out: 1000 × 16 × 131072 = 2.1B.)

**Stage 2 — sparse adaptation (943.7B tokens).** Top-k selection switches on and all parameters train — but with a gradient firewall. The indexer's input is detached from the computational graph: the main model optimizes only the language-modeling loss, and the indexer optimizes only the KL loss, now restricted to the selected set `S_t`. Neither can lean on the other. This runs 15000 steps of 480 × 128K sequences (= 943.7B tokens) at LR 7.3e-6.

The detachment is the subtle design choice. If indexer gradients flowed into the trunk, the model could contort its representations to make tokens easy to *index* rather than easy to *predict* — the classic failure mode of jointly trained routing. Keeping the indexer a pure observer means the main model never learns to game its own retrieval. The trade-off: the indexer is forever chasing a moving target, which is presumably why stage 2 keeps the KL loss active for the full 943.7B tokens rather than freezing the indexer after warm-up.

## What it costs and what it buys

At 128K context with k = 2048, each query attends to 1.56% of its history. Core attention drops from O(L²) to O(Lk); the indexer keeps an O(L²) term with a small constant. On H800s at $2/GPU-hour, the report's measured serving costs show dense MLA's per-token decode cost growing roughly linearly with position toward ~$2.2 per million tokens at 128K, while DSA's stays nearly flat — the decode curve is the difference between paying for `L` latent reads per token and paying for 2048 plus a cheap FP8 scan. Prefill shows a smaller but still multiple-fold gap. One honest wrinkle: for short-sequence prefill they don't run DSA at all, but simulate it with a masked MHA mode, because below some length the dense kernel simply wins.

Quality held up under an unusually clean ablation: post-training pipeline, RL algorithm (GRPO with specialist distillation), and data were kept identical to V3.1-Terminus, so the deltas isolate DSA. MMLU-Pro ties at 85.0, AIME 2025 goes 88.4 → 89.3, GPQA-Diamond dips 80.7 → 79.9, and Humanity's Last Exam drops 21.7 → 19.8 — with the report noting the regressions track fewer generated reasoning tokens rather than sparsity-induced capability loss, and vanish at token-matched intermediate checkpoints. RL training curves for the sparse and dense models sit nearly on top of each other, which is the more important signal: the sparse model remains trainable.

## Sharp edges

Two details worth stealing, and one worth fearing. Steal the KL-against-your-own-attention trick: it needs no labels and turns any trained dense model into supervision for a retrieval module. Steal the sharing analysis: before choosing token-level vs. block-level sparsity, count how many queries amortize each gathered KV byte. Fear the layout bugs: a post-release fix documented that the indexer's RoPE expects a *non-interleaved* layout while MLA's RoPE expects an *interleaved* one — a mismatch in the demo code that silently degraded output quality. Two rotary embeddings, one model, different memory layouts: exactly the kind of correctness bug that no unit test on logits will localize for you.

DSA's bet is that attention sparsity should be learned, per token, by a model small enough to run everywhere — and cheap enough that its quadratic cost is a rounding error. The one-year production record since its September 2025 release, and DeepSeek's own framing of it as a stepping stone to their next architecture, suggest the bet paid.
