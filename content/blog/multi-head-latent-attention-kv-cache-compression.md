---
title: "Multi-Head Latent Attention: Compressing KV Cache by 93% Without Losing Quality"
date: 2026-07-09
tags: [transformers, attention, inference, memory-optimization, llm-architecture]
excerpt: DeepSeek-V2 introduced Multi-head Latent Attention (MLA), which replaces per-head KV storage with a shared low-rank latent vector. By jointly compressing keys and values into a bottleneck representation and absorbing the up-projection into attention weights, MLA cuts KV cache memory by over 93% while matching or exceeding standard multi-head attention quality. Here is how the linear algebra works and why this changes the economics of long-context serving.
---

## The KV cache wall

Every autoregressive transformer pays a memory tax at inference time: the KV cache. For each token generated, the model must store the key and value projections of every previous token across every layer and every attention head. In a standard multi-head attention (MHA) model with `n_h` heads, head dimension `d_h`, `L` layers, and sequence length `T`, the KV cache consumes:

```
Memory = 2 * L * n_h * d_h * T * sizeof(dtype)
```

For a 236B parameter model like DeepSeek-V2 with 60 layers, 128 heads, head dimension 128, and 128K context in FP16, that is:

```
2 * 60 * 128 * 128 * 131072 * 2 bytes = ~500 GB per sequence
```

This is absurd. No single accelerator holds that. Even with Grouped Query Attention (GQA), which shares KV heads across groups of query heads (reducing cache by the group factor, typically 4-8x), the KV cache remains the dominant memory bottleneck for long-context serving. The question is: can we compress KV representations further without degrading attention quality?

## Low-rank joint compression: the MLA insight

Multi-head Latent Attention, introduced in the DeepSeek-V2 paper (May 2024), answers yes. The core observation: keys and values across all heads are highly correlated. Rather than storing `n_h` independent key vectors and `n_h` independent value vectors per token, MLA compresses all KV information into a single low-rank latent vector.

### Standard MHA recap

In conventional multi-head attention, for input token embedding `h_t`:

```
K_t = [W_K^1 h_t, W_K^2 h_t, ..., W_K^{n_h} h_t]   # n_h key vectors of dim d_h
V_t = [W_V^1 h_t, W_V^2 h_t, ..., W_V^{n_h} h_t]   # n_h value vectors of dim d_h
```

KV cache per token: `2 * n_h * d_h` elements.

### MLA formulation

MLA introduces a **compression matrix** `W_DKV` that projects the token embedding into a latent vector `c_t` of dimension `d_c`, where `d_c << 2 * n_h * d_h`:

```
c_t = W_DKV * h_t        # shape: (d_c,) — this is ALL you cache
```

Then at attention time, keys and values are recovered via up-projection:

```
K_t = W_UK * c_t          # W_UK is (n_h * d_h, d_c) — keys for all heads
V_t = W_UV * c_t          # W_UV is (n_h * d_h, d_c) — values for all heads
```

KV cache per token: just `d_c` elements. In DeepSeek-V2, `d_c = 512` while `2 * n_h * d_h = 2 * 128 * 128 = 32768`. That is a **64x reduction**, or equivalently, 93.75% less memory.

## The absorption trick: eliminating the up-projection at decode time

A naive implementation would decompress `c_t` back to full keys and values at every attention step, losing the computational savings. MLA avoids this through **weight absorption**: the up-projection matrices are absorbed into the query projection and output projection during a pre-computation step.

Consider the attention score computation for head `i`:

```
score = q_t^i · k_j^i = (W_Q^i h_t)^T (W_UK^i c_j)
      = h_t^T (W_Q^i)^T W_UK^i c_j
      = h_t^T W_absorbed_Q^i c_j
```

By pre-computing `W_absorbed_Q^i = (W_Q^i)^T W_UK^i`, the attention score is computed directly between the query and the latent vector `c_j` — no decompression needed. The same logic applies to value aggregation:

```
output^i = sum_j (softmax(score_j) * W_UV^i c_j)
         = W_UV^i * sum_j (softmax(score_j) * c_j)
```

The output projection absorbs `W_UV`, so the entire attention computation operates on `c_j` directly. During generation, you never materialize the full key or value tensors.

## Handling positional encoding: the decoupled rope keys

There is one subtlety. Rotary Position Embeddings (RoPE) apply a position-dependent rotation to keys and queries. If you absorb `W_UK` into the query weight, the position-dependent rotation can no longer be applied to the key independently (it would need to be applied to `c_j`, but `c_j` has different dimensionality and semantics).

MLA solves this by **decoupling** a small set of RoPE-carrying key components. Alongside the latent `c_t`, a separate small projection produces position-aware keys:

```
c_t   = W_DKV * h_t                    # latent (d_c dims, no position info)
k_R_t = RoPE(W_KR * h_t)              # RoPE keys (d_R dims, carries position)
```

The attention score becomes:

```
score = [q_content^i; q_rope^i] · [W_UK^i c_j; k_R_j]
```

The content portion uses the absorbed weight trick on `c_j`. The positional portion uses a small `d_R`-dimensional RoPE key that is cached alongside `c_t`. Total cache per token: `d_c + d_R`. In DeepSeek-V2: `512 + 64 = 576` elements vs. `32768` for MHA. Still a 57x reduction.

## Implementation in PyTorch-like pseudocode

```python
class MLAttention(nn.Module):
    def __init__(self, d_model, n_heads, d_head, d_c, d_rope):
        self.W_DKV = nn.Linear(d_model, d_c, bias=False)      # down-project
        self.W_UK  = nn.Linear(d_c, n_heads * d_head, bias=False)  # up-project K
        self.W_UV  = nn.Linear(d_c, n_heads * d_head, bias=False)  # up-project V
        self.W_Q   = nn.Linear(d_model, n_heads * d_head, bias=False)
        self.W_KR  = nn.Linear(d_model, d_rope, bias=False)   # RoPE keys
        self.W_QR  = nn.Linear(d_model, n_heads * d_rope, bias=False)  # RoPE queries

    def forward(self, h, kv_cache=None):
        # Compress KV into latent
        c = self.W_DKV(h)                    # (B, T, d_c)
        k_rope = apply_rope(self.W_KR(h))    # (B, T, d_rope)

        # Cache only c and k_rope — NOT full K, V
        if kv_cache is not None:
            c = torch.cat([kv_cache['c'], c], dim=1)
            k_rope = torch.cat([kv_cache['k_rope'], k_rope], dim=1)

        # Decompress for attention (or use absorbed weights)
        K = self.W_UK(c)                     # (B, T_full, n_h * d_h)
        V = self.W_UV(c)                     # (B, T_full, n_h * d_h)
        Q = self.W_Q(h)                      # (B, T_new, n_h * d_h)
        q_rope = apply_rope(self.W_QR(h))    # (B, T_new, n_h * d_rope)

        # Attention with concatenated content + position scores
        # (simplified; production uses absorbed weights at decode)
        scores = content_attention(Q, K) + rope_attention(q_rope, k_rope)
        output = softmax(scores) @ V
        return output, {'c': c, 'k_rope': k_rope}
```

In production, the absorbed-weight path is used during autoregressive decoding (one token at a time), while the explicit decompress path is used during prefill (batch processing of the prompt) where the compute cost of up-projection is amortized across many tokens.

## Quantitative results

DeepSeek-V2 (236B total, 21B active with MoE) benchmarked MLA against:

| Method | KV Cache / Token | Relative to MHA | Quality (avg benchmark) |
|--------|-----------------|-----------------|------------------------|
| MHA    | 32768 elements  | 1.0x            | baseline               |
| GQA    | 4096 elements   | 8x reduction    | slight degradation     |
| MQA    | 256 elements    | 128x reduction  | notable degradation    |
| MLA    | 576 elements    | 57x reduction   | matches or exceeds MHA |

The key result: MLA achieves compression between MQA and GQA in cache size, but matches full MHA quality. This breaks the previously assumed tradeoff between cache size and attention expressiveness.

## Why this matters for serving economics

At 128K context with batch size 64, the KV cache difference between MHA and MLA is the difference between needing 8 H100s and needing 1. For serving providers charging per-token, this translates directly to cost:

1. **Higher throughput**: Smaller KV cache means more sequences fit in GPU memory simultaneously, increasing batch size and GPU utilization.
2. **Longer context**: The memory saved on KV cache can be allocated to longer sequences without adding hardware.
3. **Cheaper disaggregation**: Systems that shard KV cache across nodes (like prefill/decode split architectures) transfer 57x less data over the network.

DeepSeek-V3 (December 2024) and DeepSeek-R1 (January 2025) both adopted MLA as a core architectural choice, demonstrating that the technique scales to frontier model quality.

## Limitations and open questions

MLA is not free. The absorbed weight matrices are larger than standard attention weights (since they fold in the up-projection), increasing parameter count slightly. The prefill phase still requires the full up-projection computation, so MLA primarily benefits decode-heavy workloads (which is most real serving).

There are also open questions about composability: can MLA be combined with sparse attention patterns, or does the latent compression interact poorly with local windowed attention? Early results from DeepSeek-V3's native sparse attention suggest the answer is "combinable with care," but the design space remains under-explored.

The deeper implication is architectural: if keys and values are compressible to 1.7% of their original size without quality loss, the transformer's KV computation was always massively over-parameterized. MLA hints that the true information content of attention state is far lower-dimensional than the representation space, suggesting further compression techniques, perhaps learned or adaptive, are waiting to be discovered.
