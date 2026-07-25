---
title: "Gated DeltaNet: Householder Transitions and the Arithmetic of Forgetting"
date: 2026-07-25
tags: [linear-attention, sequence-models, llm-architecture, gpu, long-context]
excerpt: "Mamba2 forgets everything a little; DeltaNet forgets one thing precisely. Gated DeltaNet does both by replacing the scalar decay in a linear RNN with a scaled Householder matrix, then recovers tensor-core throughput with a WY representation that turns 64 sequential rank-1 updates into three matmuls."
---

Every linear-attention architecture is a bet about what a fixed-size memory should throw away. The state is a matrix `S ∈ R^(d_v × d_k)` acting as an outer-product associative memory: writing a key-value pair means adding `v k^T`, reading means computing `S q`. Because the state is finite, the number of near-orthogonal pairs it can hold is bounded by `d_k`. Past that, writes superimpose and retrieval degrades — Schlag et al. called this *memory collision*.

The interesting design question is therefore not how to write, but how to make room. [Gated DeltaNet](https://arxiv.org/abs/2412.06464) (Yang, Kautz, Hatamizadeh; ICLR 2025) answers it by combining two mechanisms that were previously developed in isolation, and — the part that actually matters for shipping — showing the combination is still expressible as matrix multiplications on tensor cores.

## Two ways to make room

Mamba2's recurrence attaches a data-dependent scalar decay `α_t ∈ (0,1)`:

```
S_t = α_t · S_{t-1} + v_t k_t^T
```

This is *global* forgetting. Every stored association fades by the same factor each step. If the model wants to drop one stale fact, it must fade all of them — and if it wants to preserve one fact for 8K tokens, it must refuse to fade anything.

DeltaNet takes the opposite approach. It applies the delta rule (Widrow-Hoff, 1960): before writing, subtract whatever the memory currently predicts for this key.

```
S_t = S_{t-1} - (S_{t-1} k_t) k_t^T + (β_t v_t + (1-β_t) S_{t-1} k_t) k_t^T
    = S_{t-1} (I - β_t k_t k_t^T) + β_t v_t k_t^T
```

The transition matrix is now `I - β_t k_t k_t^T` — a **generalized Householder matrix**, a rank-1 perturbation of the identity that projects out the `k_t` direction with strength `β_t`. This is surgical: it overwrites the slot addressed by `k_t` and leaves everything orthogonal to it untouched. It is also, viewed from another angle, one step of SGD on the online regression loss `L(S) = ½‖S k_t − v_t‖²`, with `β_t` as the learning rate:

```
S_t = S_{t-1} − β_t ∇L(S_{t-1}) = S_{t-1}(I − β_t k_t k_t^T) + β_t v_t k_t^T
```

Surgical precision has a cost: no bulk erase. At a context switch — new document, new topic — DeltaNet has no way to clear the slate, so old associations linger and collide.

## The gated delta rule

The fix is one multiplication:

```
S_t = S_{t-1} · α_t (I − β_t k_t k_t^T) + β_t v_t k_t^T
```

The transition matrix is a *scaled* Householder. Two limits recover the parents: `β_t → 0` gives Mamba2's uniform decay, `α_t → 1` gives pure DeltaNet. In between, the model chooses per token whether to erase broadly or edit narrowly. In the online-learning view this is just weight decay added to the test-time SGD step — the same trick everyone already uses when training the outer model, applied to the inner one.

The paper's needle-in-a-haystack table makes the trade-off unusually legible. On S-NIAH-1 (a synthetic repeated context, so the task is pure retention) at 8K tokens, DeltaNet scores 98.8 and Mamba2 collapses to 30.4 — decay destroys what it was supposed to keep. On S-NIAH-2 (real essay context, so the task is filtering) at 4K, DeltaNet drops to 18.6 while Mamba2 holds 56.2 — no erase means collision. Gated DeltaNet gets 91.8 and 92.2. Neither failure mode is intrinsic to linear attention; each is a consequence of picking only one mechanism.

## The part that could have killed it

An expressive transition matrix is worthless if you can't train it fast. Softmax attention wins on hardware because `QK^T` is one big matmul; a linear RNN with per-token matrix transitions is 4096 sequential rank-1 updates, which on an H100 leaves the tensor cores idle.

The escape is the **chunkwise parallel form**: split the sequence into chunks of size `C` (64 in practice), carry state across chunks recurrently, and compute everything inside a chunk with matmuls. For Mamba2 this is easy because scalar decay factors out — you rescale `q`, `k`, and `S` by cumulative products `γ` and reuse the vanilla algorithm with a decay-aware mask.

For Householder transitions it is not easy, because the product `∏(I − β_i k_i k_i^T)` doesn't factor. DeltaNet's solution, extended here, is the **WY representation** from numerical linear algebra (Bischof & Van Loan, 1985): a product of `C` Householder matrices can be written as a single `I − W^T K` with `W` computed by a triangular solve. The UT transform gives that solve in closed form, and Gated DeltaNet's contribution is folding the decay ratios into it:

```
# Per chunk t, C = 64. Gamma = intra-chunk cumulative decay ratios.
# gamma[i] = prod(alpha[tC+1 .. tC+i])

A = (Gamma * (K @ K.T))                       # decay-weighted key Gram matrix
T = inverse(I + strict_lower(diag(beta) @ A)) @ diag(beta)   # C x C, unit lower-triangular
W = T @ K                                     # pseudo-keys   (C x d_k)
U = T @ V                                     # pseudo-values (C x d_v)

# state carry and output, both matmul-only
S_next = decay_to_end(S) + (U_dec - W_dec @ S.T).T @ K_dec
O      = Q_dec @ S.T + ((Q_dec @ K.T) * M) @ (U - W_dec @ S.T)
```

The inverse is of a `64×64` unit lower-triangular matrix — cheap, numerically benign, and computed once per chunk. Everything else is a matmul. Cost per chunk is `O(C² d + C d²)`, linear in sequence length overall, and the measured training throughput of Gated DeltaNet is essentially identical to plain DeltaNet: the gating is free. Both sit 2–3K tokens/sec behind Mamba2 at 1.3B on one H100, the price of the more expressive transition.

This is the reusable lesson. The reason DeltaNet sat ignored from 2021 to 2024 was not that the delta rule was a bad idea; it was that nobody had a chunkwise formulation for it. Architectural search in this space is bounded less by what recurrences are expressive than by which recurrences admit a matmul-shaped associative reformulation.

## What the numbers say

At 1.3B parameters trained on 100B FineWeb-Edu tokens, all baselines under identical conditions:

| Model | Wiki ppl ↓ | LMB ppl ↓ | Avg. commonsense acc ↑ | Recall-intensive avg ↑ |
|---|---|---|---|---|
| Transformer++ | 18.53 | 18.32 | 52.25 | 37.0 |
| Mamba2 | 16.56 | 12.56 | 54.89 | 29.8 |
| DeltaNet | 17.71 | 16.88 | 52.14 | 26.2 |
| Gated DeltaNet | 16.42 | 12.17 | 55.32 | 30.6 |
| Samba (Mamba+SWA) | 16.13 | 13.29 | 54.00 | 37.3 |
| GatedDeltaNet-H2 | 15.91 | 12.55 | 56.18 | 40.1 |

Two things stand out. First, the pure recurrent model beats Mamba2 and DeltaNet on both perplexity and downstream accuracy, but remains far behind the Transformer on recall-intensive tasks (30.6 vs 37.0) — a fixed-size state is still a fixed-size state, and better forgetting only postpones the wall.

Second, the hybrid closes and reverses that gap. **GatedDeltaNet-H2** interleaves Mamba2, Gated DeltaNet, and 2K sliding-window attention layers, reaching 40.1 on retrieval, above the full Transformer, at higher training throughput than either pure recurrent variant (SWA over 2K windows is cheap, and Flash-Attention-2 is very well optimized). Layer order is not incidental: the ablation shows Mamba2 → GatedDeltaNet → SWA beating the other three permutations of the same three layers.

The engineering ablations are worth internalizing if you build these blocks. L2-normalizing `q` and `k` is essential rather than cosmetic (L1 + ReLU costs ~3.4 perplexity at 400M). Short convolutions on the qkv paths and the output gate each buy ~1.6–1.8 perplexity; output normalization buys almost nothing. Head dimension 128 is the knee — 64 is materially worse, 256 barely better for the extra compute.

## Why this line matters

The trajectory here is a steady enrichment of what a linear RNN's transition matrix is allowed to be: scalar (RetNet), data-dependent scalar (Mamba2), diagonal (GLA), identity-minus-rank-one (DeltaNet), scaled identity-minus-rank-one (Gated DeltaNet). Each step buys expressivity and each step required a new chunkwise algorithm to be usable. The unlock is always the same shape — find the associative-scan or WY-style reformulation that turns sequential dependence into block matmuls.

Practically, the conclusion the paper lands on is not "replace attention." It is that a well-chosen minority of exact-attention layers plus a majority of layers with good forgetting beats either extreme on quality *and* throughput. That is now the mainstream position: hybrid stacks mixing gated-delta-style recurrent layers with periodic full or sliding-window attention are what recent long-context production models actually ship. If you are evaluating a linear-attention architecture, the two questions to ask are what its transition matrix can represent, and whether its chunkwise form is matmul-bound. Gated DeltaNet is instructive because it answers both crisply.
