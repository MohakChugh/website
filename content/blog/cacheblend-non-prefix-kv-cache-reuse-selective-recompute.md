---
title: "CacheBlend: Reusing KV Caches When Your Text Isn't a Prefix"
date: 2026-08-05
tags: ["llm-serving", "kv-cache", "rag", "inference-optimization", "attention"]
excerpt: "Prefix caching only works when reused text sits at position zero. CacheBlend reuses KV caches from arbitrary positions and repairs the missing cross-attention by recomputing just 15% of tokens, chosen by a layer-cascading greedy filter."
---

# CacheBlend: Reusing KV Caches When Your Text Isn't a Prefix

Prefix caching is one of the most effective optimizations in LLM serving, and one of the most structurally limited. Systems like SGLang's RadixAttention key cached KV tensors on token sequences starting at position zero. Reuse requires an exact match from the beginning of the input. That works beautifully for a shared system prompt or a growing chat transcript.

It fails completely for retrieval-augmented generation, which is where most of the redundancy actually lives.

A RAG request concatenates several retrieved passages plus a user query. Any individual passage may have been retrieved thousands of times, so its KV cache is eminently reusable — but it almost never appears at the same position twice, since retrieval returns it second this time and fifth the next. Under prefix caching, only the passages before the first divergence hit; everything after is recomputed. On a five-chunk input where chunk three changed, you throw away 60% of a cache you already have.

CacheBlend (Yao et al., arXiv:2405.16444, shipped as [LMCache](https://github.com/LMCache/LMCache)) attacks this directly: reuse the precomputed KV cache "regardless prefix or not," then repair the damage. It reports 2.2–3.3× lower time-to-first-token and 2.8–5× higher throughput than full recompute, with F1 and Rouge-L within 0.02.

## Why You Can't Just Concatenate

The obvious move is to precompute each chunk's KV cache independently and concatenate at request time. This is wrong, and it's worth being precise about why, because the failure isn't positional encoding.

Positional encoding is the easy half. With RoPE, position enters as a rotation applied to keys and queries, so a cached chunk can be re-positioned by composing rotations, no attention required. Earlier systems like PromptCache handle exactly this.

The hard half is **cross-attention**. When chunk $C_3$ is prefilled standing alone, its tokens attend only to each other. Prefilled in situ after $C_1$ and $C_2$, its tokens attend to everything before them, and those attention outputs feed the next layer's input, producing different keys and values, which changes the layer after that. The precomputed cache doesn't just have the wrong positions — it encodes a token that never read its context, and the error compounds with depth. The paper measures the resulting collapse: on Musique with full KV reuse, F1 lands around 0.15 where full prefill reaches 0.35.

So the design space isn't "reuse or recompute." It's: given a cache that is wrong, how cheaply can you make it right enough?

## Quantifying the Damage

CacheBlend defines two error measures. For a KV cache $KV_i$ at layer $i$ and token $j$, the **KV deviation** is the absolute difference against the fully-prefilled reference:

$$\Delta_{kv}(KV_i, KV_i^{full})[j] = \left| KV_i[j] - KV_i^{full}[j] \right|$$

And for the forward attention matrix $A_i$ that this cache produces, the **attention deviation** is the L2 norm of the difference:

$$\Delta_{attn}(A_i, A_i^{full}) = \left\| A_i - A_i^{full} \right\|_2$$

Attention deviation is what propagates into the output; KV deviation is the per-token handle used to reduce it. The objective is to update $KV^{pre}$ into some $KV^{new}$ minimizing $\Delta_{attn}(A_i^{new}, A_i^{full})$ at every layer, while touching as few tokens as possible.

What makes this tractable is that **KV deviation is heavily skewed**. Tokens whose meaning is largely self-contained (low genuine cross-attention with other chunks) barely move when context is added; tokens that depend on preceding chunks move a lot. Recomputing the top-$r\%$ by deviation drops attention deviation sharply, with the largest gains from the first few tokens. The paper calls these **HKVD** (high-KV-deviation) tokens, and finds 10–20% suffices.

This is a sparsity claim about the *error*, not about attention itself, which is why it's independent of sparse-attention work.

## Selective Recompute Without Skipping

A standard prefill kernel has no notion of skipping positions, so CacheBlend restructures the per-layer forward pass:

```python
def blend_layer(layer, hidden, kv_pre, hkvd_idx):
    """One layer of selective KV recompute.
    hidden:   [seq, d]        full-length layer input
    kv_pre:   (K, V) each [seq, kv_heads, head_dim]  precomputed
    hkvd_idx: [n_sel]         tokens to recompute on this layer
    """
    # 1. Mask the input down to selected tokens only.
    h_sel = hidden[hkvd_idx]                       # [n_sel, d]

    # 2. Q/K/V projections run on the reduced set -> this is the saving.
    q, k_new, v_new = layer.qkv(h_sel)             # [n_sel, ...]

    # 3. Expand: scatter fresh K/V over the reused cache.
    K, V = kv_pre[0].clone(), kv_pre[1].clone()
    K[hkvd_idx], V[hkvd_idx] = k_new, v_new        # [seq, ...]

    # 4. Selected queries attend over the FULL blended K/V.
    #    n_sel queries x seq keys, not seq x seq.
    attn = layer.attn(q, K, V)

    # 5. Only selected rows of the layer output change.
    hidden = hidden.clone()
    hidden[hkvd_idx] = layer.mlp(attn)
    return hidden, (K, V)
```

Two steps are load-bearing. Step 3 means recomputed tokens attend over the *blended* cache, so they pick up the cross-attention that was missing. Step 4 makes attention cost $O(n_{sel} \cdot L)$ rather than $O(L^2)$, which is where the savings come from at long context. Un-selected tokens keep their stale KV, which is fine precisely because their deviation was measured to be small.

## The Chicken-and-Egg Problem

Selecting HKVD tokens requires knowing the deviation, which requires the fully-recomputed KV, which is the thing we're avoiding. The escape is a second empirical observation:

> **Insight 2.** Tokens with the highest KV deviations on one layer are likely to have the highest KV deviations on the next layer.

The paper validates this with Spearman rank correlation between per-token KV deviation on adjacent layers, reporting consistently high similarity across Mistral-7B, Yi-34B, and Llama-70B. The mechanism: token embeddings change slowly between transformer layers, and KV is a linear projection of the embedding, so KV inherits that smoothness.

The naive exploitation is to fully prefill layer 1, pick its HKVD tokens, and reuse that set for all remaining layers. With 30+ layers this already saves most of the compute, but a single layer's ranking is statistically noisy for deep layers.

Instead CacheBlend uses **gradual filtering**: pick $r_1\%$ of tokens on layer 1 with $r_1$ slightly above the target $r$, recompute those on layer 2, re-rank by attention deviation, keep $r_2\% < r_1\%$ for layer 3, and so on. Each layer's candidate set is a subset of the previous layer's, so the set monotonically narrows while the ranking accumulates evidence from multiple layers rather than one.

```python
def select_hkvd(deviation, prev_idx, keep_frac):
    """Narrow the candidate set. Only tokens recomputed on the previous
    layer have a measurable deviation, so the set can only shrink."""
    k = max(1, int(len(prev_idx) * keep_frac))
    scores = deviation[prev_idx]
    return prev_idx[scores.topk(k).indices]
```

Note the memory discipline: layer $i$'s selection holds both updated and precomputed KV, but the extra copy is dropped the moment inference moves to layer $i+1$, keeping overhead negligible.

## Hiding Recompute Behind I/O

The system-level insight is that selective recompute doesn't have to be free in absolute terms, only cheaper than the I/O it overlaps with:

> If the delay for selective KV recompute is faster than the loading of KV into GPU memory, then properly pipelining the selective KV recompute and KV loading makes the extra delay of KV recompute negligible.

This works because HKVD selection at layer $i+1$ depends only on layer $i$'s deviations, so layer $i$'s recompute can run concurrently with layer $i+1$'s cache fetch. Both stages are per-layer, so the pipeline fills cleanly.

The consequences are counterintuitive. The paper's numbers, for a 4K context on an NVMe SSD measured at 4.8 GB/s:

| Model | 15% recompute | KV load / layer | Hidden? |
|---|---|---|---|
| Llama-7B | 3 ms | 16 ms | fully |
| Llama-70B | 7 ms | 4 ms | no |

The *bigger* model hides recompute worse. Checking the arithmetic explains why — the load times are just the KV footprint divided by disk bandwidth:

```python
GBs, L = 4.8e9, 4096
kv_per_layer = lambda kv_heads, hd: 2 * L * kv_heads * hd * 2  # K+V, fp16

for name, kv_heads in [("Llama-7B  (MHA, 32 kv heads)", 32),
                       ("Llama-70B (GQA,  8 kv heads)",  8)]:
    b = kv_per_layer(kv_heads, 128)
    print(f"{name}: {b/1e6:5.1f} MB -> {b/GBs*1e3:4.1f} ms")

# Llama-7B  (MHA, 32 kv heads):  67.1 MB -> 14.0 ms
# Llama-70B (GQA,  8 kv heads):  16.8 MB ->  3.5 ms
```

14.0 and 3.5 ms against the paper's 16 and 4, close enough that the gap is measurement overhead. The mechanism is now obvious: Llama-70B uses grouped-query attention with 8 KV heads against the 7B's 32, so its per-layer KV cache is **4× smaller** even though the model is 10× larger. Compute per token went up; bytes to load went down. GQA, an optimization for decode-time memory bandwidth, actively shrinks the I/O window available to hide prefill recompute behind.

So the recompute ratio can't be a constant. CacheBlend's loading controller estimates $T_{load}$ from measured device bandwidth and picks $r$ such that $T_{recompute}(r) = T_{load}$, then clamps from below: $r = \max(r, r^*)$ with $r^* = 15\%$ the empirical floor for negligible quality loss. Fast storage doesn't let you skip the quality floor; it just means recompute is no longer free.

Run the logic backwards and it becomes a provisioning tool: fix $r$ at 15%, then pick the *cheapest* storage tier where $T_{load} \le T_{recompute}$. Anything faster is bandwidth you paid for and cannot use — on the 7B above, a 16 ms per-layer budget masks even fairly slow storage, so RAM-resident cache buys nothing.

## Results and Limits

Across four datasets (2WikiMQA, Musique, MultiNews, SAMSum) and three models, TTFT drops 2.2–3.3× versus full recompute with F1/Rouge-L loss within 0.02; on Yi-34B the loss is at most 0.002 at 5–18% recompute. Against full KV reuse, CacheBlend gains 0.1–0.2 absolute F1 on QA and 0.03–0.25 Rouge-L on summarization — that is the cross-attention repair, quantified. Throughput improves 2.8–5×.

Two honest limits. $r^* = 15\%$ is empirical, tuned on these models and datasets, with no bound guaranteeing it transfers — and the failure mode is silent quality degradation, not an error. And chunking is application-specific: CacheBlend assumes the input decomposes into stable, independently cacheable spans, which holds for retrieved passages and not for arbitrary prose.

The point generalizes past RAG. Agent scaffolds re-send tool definitions and state in shifting orders; few-shot pipelines permute exemplars. Anywhere reuse is *semantically* present but *positionally* scrambled, the prefix-tree abstraction leaves most of the win on the table. The fix is to stop treating cache reuse as an exact-match lookup and treat it as numerical repair with a tunable error budget. [EPIC](https://arxiv.org/abs/2410.15332) reaches the same view from another angle, formalizing position-independent caching and counteracting a spurious attention-sink effect at each document boundary.

A cache you can only use at position zero is a cache you mostly cannot use.
