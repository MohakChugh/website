---
title: "Marconi: Prefix Caching When Your Model Can't Roll Back Its Own State"
date: 2026-09-10
tags: [llm-inference, caching, state-space-models, gpu, serving-systems]
excerpt: "Hybrid SSM/attention models break the core assumption of prefix caching: recurrent states update in place, so a cached state for tokens 1..q is useless for a request that shares only 1..p. Marconi (MLSys 2025 Best Paper) fixes this with speculative radix-tree admission and FLOP-aware eviction, lifting token hit rates up to 34.4x over per-block checkpointing. My own eviction sim reproduces the win on an agentic trace (+10 hit-rate points) — and shows the same policy halving the hit rate on a chat trace, which is exactly why Marconi auto-tunes its eviction knob."
---

Prefix caching is the workhorse optimization of LLM serving: if two requests share a prefix — a system prompt, a conversation history, an agent scaffold — the second request skips prefill for the shared tokens by reusing cached KV entries. SGLang's radix tree and vLLM's block-level hashing both exploit a property so basic it's easy to forget it's a property at all: **attention KV caches grow token by token, so any prefix of a cached sequence is itself a valid cache entry.** Matching 1,000 tokens of a 10,000-token cached sequence works fine; you reuse the first 1,000 tokens' KVs and prefill the rest.

Hybrid models break this. Architectures like Jamba, Zamba, and Hymba interleave a few attention layers with many state space model (SSM) layers — Jamba-1.5-Mini runs 12B active parameters with attention in only a fraction of its layers — because SSM layers give O(1) per-token state and linear-time prefill for long contexts. But that fixed-size state is exactly the problem for caching. [Marconi](https://arxiv.org/abs/2411.19379) (Pan et al., MLSys 2025 Best Paper) is the first system to make prefix caching work for these models, and its core insight is that the problem isn't lookup — it's deciding **what deserves to be a cache entry at all**.

## Why SSM states are all-or-nothing

An SSM layer's state has three properties that are individually benign and jointly hostile to caching:

1. **Constant size.** The state is a d_model x d_state matrix regardless of how many tokens it has absorbed — 2·D·N bytes in FP16.
2. **In-place updates.** Each token overwrites the state. There is no per-token history, so a state representing tokens 1..q **cannot be rolled back** to represent tokens 1..p for any p < q.
3. **It's big.** For a 7B hybrid (D=4096, N=128), one SSM layer's state equals the KV footprint of N/2 = 64 tokens of one attention layer. A state is worth 10–100x the KVs of a single token.

Property 2 is the killer. A cache hit for a hybrid model requires *every* layer to have reusable state for the *exact same* prefix boundary — attention layers need the prefix's KVs, and every SSM layer needs a state checkpointed at precisely that token. Reuse is bottlenecked by the least-flexible layer, and the SSM layers only match exactly. Partial overlap, the bread and butter of transformer prefix caching, yields nothing.

The naive fix — checkpoint SSM states at fine granularity so more boundaries exist — drowns in memory. The authors extended vLLM to checkpoint one state per 32-token block and measured the damage: at block size 16, a single SSM layer's checkpoint is 4x larger than the attention KVs of the entire block it covers (the ratio is N / (2·block_size)). A single 10K-token sequence on the 7B hybrid consumes **17.4 GB** of cache under per-block checkpointing — 3.3x the equivalent transformer. I redid the arithmetic: 10,240 tokens / 32 per block = 320 checkpoints x 24 SSM layers x 1 MiB per state ≈ 7.5 GiB of SSM states alone before KVs and conv1d states, so the order of magnitude is right and the waste is structural. And it buys almost nothing: in their trace, 25% of token blocks' KVs got reused but only **0.4% of the checkpointed SSM states** did — a 65x utilization gap. You pay for a checkpoint at every block boundary; requests only ever branch at a few of them.

## Admission: checkpoint where sequences actually diverge

Marconi's answer is to be selective on the way *in*, not just the way out. It bookkeeps all requests in a single radix tree holding KVs and SSM states together, and admits at most about **two SSM checkpoints per sequence**, chosen by a taxonomy of how prefixes actually get reused:

- **Purely-input prefixes** (system prompts, few-shot examples, shared documents) are shared across many requests. Where they end is visible in the tree structure: a node with multiple children is a branch point. Before prefill, Marconi **speculatively inserts** the incoming request into the radix tree; if the insertion would create a new intermediate node — a new branch point — it checkpoints the SSM state at exactly that token during the prefill pass.
- **Input+output prefixes** (conversation history, agent trajectories) grow by appending at the end. The only state worth keeping is the one at the **last decoded token**, which Marconi always checkpoints.

Everything between those points is dead weight and never gets a checkpoint. The cost of this parsimony is that a shared prefix only produces hits from its *third* occurrence (the second occurrence is what reveals the branch point) — a negligible loss for prefixes that recur dozens of times.

One subtlety: the branch point usually falls mid-sequence, and you need the state *at that token*, not at the end. For models with chunked state passing (Mamba-2 and friends), Marconi materializes the state at the nearest preceding chunk boundary essentially for free during prefill; otherwise it falls back to a two-pass prefill split at the checkpoint.

## Eviction: FLOPs per byte, not recency

LRU asks "when was this used?" Marconi also asks "what does a hit on this actually save?" — and for hybrids the two questions diverge sharply. Work out the FLOPs a cache hit avoids, per byte of state held:

```text
attention: (8LD^2 + 4L^2D) FLOPs / 4LD bytes  = L + 2D          per byte
SSM:       (12LD^2 + 16LDN + 10L) / 2DN bytes = L(6D/N + 8 + …) per byte
```

For the 7B hybrid, attention saves L + 8192 FLOPs per cached byte — nearly flat in sequence length — while an SSM state saves **200·L** FLOPs per byte, growing linearly. A long-prefix SSM checkpoint is a small object that shields an enormous amount of recomputation; classic size-aware policies like GDSF get this exactly backwards because SSM state size is decoupled from the compute it represents. Marconi scores each radix node as

```text
S(n) = recency(n) + α · flop_efficiency(n)
```

with both terms min-max normalized, and evicts the minimum. α is not a config constant: Marconi runs pure LRU until the first eviction, then replays the bootstrap window in an asynchronous CPU-side grid search (a few seconds) and adopts whatever α maximizes hit rate.

## Checking the eviction policy myself

The α auto-tuning looked like the kind of detail papers include defensively, so I tested whether it's load-bearing. I wrote a small simulator: cache entries carry the real byte/FLOP formulas above (4 attention + 24 SSM layers, D=4096, N=128), a 6 GiB budget forces eviction, and I ran two traces. Trace A is agentic — 15 long prefixes (4K–12K tokens) each reused ~20 times, plus 40 hot short prefixes. Trace B is chat-like — the same short prefixes but the long entries appear once or twice and die.

| trace | α=0 (LRU) | α=1 | α=4 |
|---|---|---|---|
| A: agentic, long prefixes reused | 68.1% hit / 43.1 PF saved | 74.2% / 47.1 PF | **78.0% / 49.6 PF** |
| B: chat, long prefixes one-shot | **28.9% / 7.3 PF** | 15.0% / 3.9 PF | 18.2% / 4.8 PF |

On the agentic trace, FLOP-aware eviction is worth ten hit-rate points over LRU — the policy correctly shields long, expensive-to-recompute prefixes that LRU would age out. On the chat trace the *same* policy **halves the hit rate**, because it protects large entries that will never be touched again, starving the short hot set. That's not a bug in the idea; it's the reason the system has two halves. Judicious admission is supposed to keep one-shot long prefixes from being checkpointed in the first place, and α-tuning exists precisely because the right recency/efficiency blend is a property of the workload, not the model. A fixed α shipped as a default would be wrong somewhere.

## Does it matter end to end?

Against a favorably extended vLLM (per-block checkpointing, block size 32), Marconi's token hit rates are 4.5x higher on LMSys, 7.3x on ShareGPT, and **34.4x** on SWE-Bench agent traces — the gap widening exactly where inputs are long and branchy. Against an SGLang-style baseline given Marconi's own admission policy but LRU eviction, the eviction policy alone adds 19–220% at P95, worth up to 617 ms of P95 time-to-first-token on Jamba-1.5-Mini across 4x A100s. Two trends in the ablations are worth noting: the advantage grows as the attention:SSM ratio falls (1:8 hybrids benefit 2.6x more than 1:2) and as state dimension grows (Mamba-1's N=16 → Mamba-2's N=128 moves the win from 5.7x to 35.4x). Architecture is drifting in both directions — more SSM layers, bigger states — so the caching problem Marconi solves is getting worse, not better.

The general lesson travels beyond hybrids: when cache entries stop being prefix-decomposable, the interesting policy question moves from *lookup* to *admission*, and "bytes held" stops being a proxy for "value held." Any system caching monolithic derived state — materialized views, compiled artifacts, RAG chunk embeddings — eventually rediscovers Marconi's score function: recency plus what-it-costs-to-rebuild, per byte.
