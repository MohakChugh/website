---
title: "Log-Linear Attention, Audited: Fenwick-Tree States, Aliased Scales, and Where the Log Factor Goes"
date: 2026-10-28
tags: [attention, linear-attention, state-space-models, llm-architecture, fenwick-tree]
excerpt: "Log-linear attention gives Mamba-2 and Gated DeltaNet a logarithmically growing set of hidden states instead of one. I re-implemented both forms (they agree to 4e-14), found that a token's level is just bit_length(t XOR s), and measured what the paper doesn't: the token one step back shares its level weight with up to 8,191 others, the decode state equals a Transformer's KV cache at ~1.9K tokens, the 8K speed crossover implies a 7–11× FLOP-efficiency gap to FlashAttention-2, and the released config cannot exceed 16,384 tokens."
---

Linear attention and SSMs compress the whole prefix into one fixed-size matrix. Softmax attention keeps every token. [Log-Linear Attention](https://arxiv.org/abs/2506.04761) (Guo, Yang, Goel, Xing, Dao, Kim — ICLR 2026) sits in between. It keeps O(log T) matrix-valued states, one per power-of-two segment of the past, and lets each query weight those segments separately. Applied to Mamba-2 and Gated DeltaNet, it trains in O(T log T) and decodes in O(log T) memory.

I rebuilt it in numpy, read the reference repo, and checked four things the paper states only asymptotically or not at all.

## The mechanism in one equation

Every model in this family can be written as `O = (A ⊙ M) V`. `A` is an attention-like matrix (`QKᵀ` for Mamba-2, a Householder-transformed version for DeltaNet). `M` is a causal mask. In Mamba-2, `M[t,s] = ∏ α` over the gates between `s` and `t`: a rank-1 semiseparable matrix, which is why one state is enough.

Log-linear attention multiplies that mask elementwise by a hierarchical one:

```
M_H[t, s] = λ_t^(ℓ(t,s))
```

Here `ℓ(t,s)` is the Fenwick-tree level of source token `s` as seen from query `t`. The prefix `[0, t)` is split into aligned dyadic blocks, one for each set bit of `t`. The level-ℓ block holds 2^(ℓ−1) tokens, and level 0 is the current token. Each `λ_t^(ℓ) ≥ 0` is a per-head, per-level scalar projected from `x_t` (the repo uses `softplus(L · dl)`).

The paper defines the level recursively, via least-significant-set-bit (lssb) bookkeeping. The repo's `get_level_index_weak` peels off the highest bit instead. Both reduce to one line:

```python
level = lambda t, s: (t ^ s).bit_length()   # 0 when s == t
```

The highest bit where `t` and `s` differ is exactly the dyadic block that separates them. I checked this against the repo's recursive function for every pair `s < t < 2048`, and they agree on all of them.

## Recurrent and parallel forms agree

Here is the decode recurrence from §3.2, with the Mamba-2 gate added. When token `t` arrives, levels `0..lssb(t)` merge and are promoted one level up, and the new `k vᵀ` goes into level 0:

```python
for t in range(T):
    S *= a[t]                                   # Mamba-2 scalar decay, all levels
    if t > 0:
        z = (t & -t).bit_length() - 1           # lssb(t)
        S[z+1] += S[:z+1].sum(0); S[:z+1] = 0   # merge and promote
    S[0] = np.outer(k[t], v[t])
    o[t] = sum(lam[t, l] * q[t] @ S[l] for l in range(L))
```

Against the dense parallel form `((QKᵀ) ⊙ M_S ⊙ M_H) V`, with random data at T=256, the maximum absolute difference is **4.4×10⁻¹⁴**. The number of nonzero states after step `t` is always `popcount(t) + 1`. That is the paper's appendix remark that "roughly half of them are zero," stated exactly.

## The hierarchy is aligned to absolute position, not distance

The paper says the Fenwick partition gives "recent tokens… fine-grained memory." That holds on average. It does not hold for any particular token, because the blocks are aligned to absolute positions. At `t = 8192`, token 8191 (one step back) is in the same level-14 block as token 0. Both get the same `λ`.

What the hierarchy adds is the λ reweighting. The gate decay `∏α` stays exact per token, and if every λ is equal the model collapses back to Mamba-2. So the question is how coarsely the λ weights are shared. I took the bucket that holds token `t − δ` and measured its size over every `t` in a 16K window:

| distance δ | own bucket | median size | mean size | min | max |
|---|---|---|---|---|---|
| 1 | 50% | 1 | 7.0 | 1 | 8,192 |
| 16 | 0% | 16 | 80 | 16 | 8,192 |
| 100 | 0% | 128 | 366 | 64 | 8,192 |
| 1,000 | 0% | 1,024 | 2,143 | 512 | 8,192 |

For δ=1, the bucket size is `2^lssb(t)`. Its mean is exactly log₂T / 2. The worst case is half the context. Mamba-2's width-4 causal conv covers δ ≤ 3, which softens the δ=1 row. Beyond that, a λ that wants "the last ~100 tokens" gets anywhere from 64 to 8,192 tokens, depending on where `t` falls relative to a power of two.

This is the price of O(log T) memory, not a bug. Fenwick blocks only ever merge, so a state never has to give tokens back. A partition that slides with `t` would have to move each token's contribution from one bucket to the next, and that requires keeping the token itself, which is the KV cache again. The appendix says the authors tried a strongly admissible (finer) partition and got "up to a 4× slowdown, with only marginal improvements." The aliasing is the trade they chose.

## Decode memory, in the paper's own configuration

"O(log T)" hides a large constant. The released model inherits Mamba-2 defaults: 48 heads, head dim 64, state size 128. That is 393,216 state elements per layer per level. The paper's Transformer baseline (16 MHA heads, hidden size 1536) stores 3,072 KV elements per token per layer. **One level-state therefore holds as many elements as 128 tokens of KV cache.**

The repo's decode cache (`HState`) is a dense array with `MAX_NUM_LEVELS = 15` slots:

- **15 slots ≈ 1,920 tokens of KV.** At a 2K context the log-linear state is about the same size as the Transformer's full cache (1.1×). It is 8.5× smaller at 16K.
- Only `popcount(t)+1` slots are nonzero, 8 on average and 15 at most. A sparse cache would average about 1,024 token-equivalents.
- Compared with plain Mamba-2 it is 15× larger as allocated, and 8× larger with a sparse cache.

So the memory advantage over attention appears only at long context, which is where the next limit applies.

## The released config stops at 16,384 tokens

The λ projection outputs exactly `MAX_NUM_LEVELS` values per head. The repo computes this as `ceil(log₂ 16384) + 1 = 15`, and it is baked into `in_proj`'s output size. Levels 0–14 cover positions up to 16,383, and position 16,384 would need level 15. In code:

- `make_levels_matrix` raises `ValueError` for any length above its 16,384 cache.
- The decode cache is a fixed array of 15 levels.

The repo also contains a `LambdaLevelMLP` that computes λ as a function of the level index (a RoPE-rotated 16-dim code). That is the kind of parameterization that could extrapolate to new levels. But it also raises an error when `num_levels > max_num_levels`, it is disabled by default (`LAMBDA_LEVEL_FIXED = True`), and the paper doesn't evaluate length extrapolation. As released, a checkpoint has a hard context limit equal to its training length. For this architecture, that is a bigger deployment constraint than the log factor.

## Where the training-time log factor goes

Per head, the chunkwise algorithm (chunk C=64, N=128, P=64) has three parts:

- **Intra-chunk:** dense, with per-level λ, costing `T·C·(N+P)` FLOPs.
- **Chunk states:** `2TNP`, the same as Mamba-2.
- **Inter-chunk:** one `q·S^(ℓ)` readout per level, `2TNP` each, over `log₂(T/C)` levels.

Summed over these parts, the forward pass costs 3.2× Mamba-2's FLOPs at 8K, 3.6× at 16K, and 4.6× at 128K. Against causal FlashAttention-2 (`T²(d_qk + d_v)`, with d_qk = 64–128):

| T | inter levels | FA2 FLOPs / log-linear FLOPs |
|---|---|---|
| 2K | 5 | 2.4–3.6× |
| 8K | 7 | 7.3–11× |
| 32K | 9 | 24–36× |

The FLOP crossover is around 400–650 tokens. The paper's H100 measurement (Fig. 4) has the custom Triton kernel beating FlashAttention-2 only "beyond 8K." If 8K is roughly the parity point, the log-linear kernel delivers 7–11× fewer useful FLOPs per second than FA2 there.

The authors' own account fits this. Intra-chunk work needs "bespoke implementations," levels are fused four at a time because of SRAM limits, and λ gradients are written by hand. At practical lengths, the remaining gap is kernel engineering.

## Reading the results carefully

The gains are real but uneven, and each language model was trained only once (footnote 13).

- **Perplexity (50B tokens, ~800M params):** Gated DeltaNet improves from 21.73 to 21.45 WikiText ppl, and from 19.71 to 18.09 on LAMBADA. Mamba-2 improves from 22.44 to 22.11. The 21-layer Transformer scores 21.56.
- **Single-needle NIAH:** log-linear Mamba-2 jumps from 56.8 to 99.8 on S-NIAH-1 at 8K, but drops from 18.6 to 12.8 on S-NIAH-2 at 16K. For Gated DeltaNet, the paper reports "improvements in 3 metrics, with 3 remaining unchanged." The other three got worse, including S-NIAH-3 at 4K (66.2 → 48.8). On multi-needle tasks, both variants improve on 8–9 of 9 metrics.
- **MQAR:** gains are a few points (Mamba-2, dim 16: 46.9 → 55.9) with ±9.1 seed spread.

## Takeaways

One extra elementwise mask turns any chunkwise-parallel linear RNN into a multi-resolution one, and the whole construction rests on `bit_length(t ^ s)`. Before adopting it, check three things. Which tokens share a λ is fixed by absolute position, not by distance. The constant in O(log T) is about 1,900 tokens of KV in the paper's configuration. And in the released configuration, the number of λ levels is the context limit.
