---
title: "Mixture of Depths: Dynamic Token Routing for 50% Faster Transformer Inference"
date: 2026-07-08
tags: ["transformers", "conditional-compute", "inference-optimization", "token-routing"]
excerpt: "How Google DeepMind's Mixture of Depths achieves equivalent language model quality at a fraction of the FLOPs by learning which tokens can skip entire transformer layers, yielding up to 50% faster inference with a static computation graph."
---

# Mixture of Depths: Dynamic Token Routing for 50% Faster Transformer Inference

Standard transformer architectures apply every layer to every token uniformly. A 70B parameter model computes the same self-attention and MLP operations for the word "the" as it does for a complex reasoning token that determines the entire output's correctness. This uniformity is wasteful. Google DeepMind's *Mixture of Depths* (MoD) paper (Raposo et al., 2024) introduces a mechanism where the network itself learns which tokens require deep computation and which can safely skip layers, achieving equivalent quality at up to 50% fewer FLOPs during inference.

## The Core Insight: Not All Tokens Need All Layers

The central observation is that token difficulty varies enormously within a sequence. Function words, punctuation, and tokens whose identity is highly predictable from context carry little uncertainty and need minimal processing. Tokens at decision boundaries (where the model must commit to a factual claim, a logical inference, or a syntactic disambiguation) benefit from full-depth computation.

MoD operationalizes this insight with a learned router at each transformer layer that scores every token, then applies a hard top-k selection to determine which tokens receive computation and which pass through via a residual connection only.

## Architecture: The Per-Layer Router

At each MoD-enabled layer $l$, a lightweight linear router $R_l$ produces a scalar score for each token:

$$s_i^{(l)} = R_l(x_i^{(l)}) = w_l^T x_i^{(l)}$$

where $x_i^{(l)}$ is the hidden state of token $i$ at layer $l$. The router is a single linear projection, no activation function, no additional parameters beyond a vector $w_l \in \mathbb{R}^d$.

Given a capacity factor $C \in (0, 1]$ and sequence length $N$, exactly $k = \lfloor C \cdot N \rfloor$ tokens are selected for computation:

```python
def mixture_of_depths_forward(x, router, layer, capacity_ratio):
    """
    x: [batch, seq_len, d_model] - input hidden states
    router: Linear(d_model, 1) - per-layer router
    layer: transformer block (attention + MLP)
    capacity_ratio: float in (0, 1] - fraction of tokens to process
    """
    batch, seq_len, d_model = x.shape
    k = int(capacity_ratio * seq_len)
    
    # Score all tokens
    scores = router(x).squeeze(-1)  # [batch, seq_len]
    
    # Select top-k token indices
    top_k_indices = scores.topk(k, dim=-1).indices  # [batch, k]
    top_k_indices_sorted = top_k_indices.sort(dim=-1).values
    
    # Gather selected tokens (preserving causal order)
    x_selected = x.gather(1, top_k_indices_sorted.unsqueeze(-1).expand(-1, -1, d_model))
    
    # Apply full transformer computation only to selected tokens
    x_processed = layer(x_selected)  # attention + MLP on k tokens only
    
    # Scatter results back, unselected tokens keep residual
    output = x.clone()
    output.scatter_(1, top_k_indices_sorted.unsqueeze(-1).expand(-1, -1, d_model), x_processed)
    
    return output
```

## Why Top-k and Not a Threshold?

A natural alternative would be to route tokens whose score exceeds a learned threshold. MoD deliberately avoids this because threshold-based routing creates a *dynamic* computation graph: the number of tokens processed varies per input, making batched inference on accelerators inefficient (you either pad to worst-case or use complex ragged-tensor operations).

Top-k guarantees a *static* computation graph. Every forward pass processes exactly $k$ tokens per layer, regardless of input content. This means:

1. **Tensor shapes are known at compile time** — compatible with XLA, torch.compile, and TensorRT graph optimization
2. **Memory allocation is deterministic** — no fragmentation from variable-length intermediate activations
3. **Hardware utilization is predictable** — fixed FLOP counts enable precise throughput planning

This is the critical distinction from Mixture of Experts (MoE), where expert capacity factors often require auxiliary load-balancing losses and still suffer from token-dropping or padding inefficiencies.

## FLOPs Analysis: Where the Savings Come From

For a standard transformer layer with hidden dimension $d$, the dominant costs are:

- Self-attention: $O(N^2 \cdot d)$ for the attention matrix, $O(N \cdot d^2)$ for QKV projections
- MLP: $O(N \cdot d \cdot 4d)$ (two linear layers with 4x expansion)

With MoD at capacity $C = 0.5$, the MLP cost is halved immediately. For attention, the selected $k$ tokens attend only among themselves (not the full sequence), reducing the attention matrix from $N^2$ to $k^2 = (N/2)^2 = N^2/4$, a 4x reduction in attention compute.

Across a 12-layer model with MoD applied to 8 layers at $C = 0.5$:

```
Standard FLOPs:  12 layers × (attn_cost + mlp_cost)
MoD FLOPs:       4 layers × full_cost + 8 layers × (0.25 × attn + 0.5 × mlp)

Effective savings: ~40-50% total FLOPs per forward pass
```

The key result: MoD models trained with equivalent total training FLOPs match isoFLOP-optimal baseline transformers in perplexity, while being substantially faster at inference time.

## The Router Learns Token Importance

What does the router actually learn? Analysis of trained MoD models reveals interpretable patterns:

1. **Content words** (nouns, verbs carrying semantic load) consistently score high and receive full computation
2. **Function words and punctuation** (articles, commas, whitespace tokens) are frequently routed around layers
3. **Context-dependent selection**: the same token type may be routed differently depending on its role. A pronoun in an ambiguous reference scores higher than one with an obvious antecedent
4. **Layer specialization**: early layers tend to route syntactic signals; deeper layers route based on semantic difficulty

This emergent behavior means MoD implements a form of *learned adaptive computation time* without the complexity of ACT's halting mechanisms.

## Comparison with Mixture of Experts

| Property | Mixture of Experts | Mixture of Depths |
|---|---|---|
| What varies | Which *parameters* process a token | Which *tokens* receive computation |
| Compute graph | Dynamic (load imbalance) | Static (fixed k) |
| Parameter count | Scales with # experts | Same as baseline |
| Routing | Token → expert assignment | Token → compute/skip binary |
| Auxiliary loss | Load balancing required | Simple capacity constraint |
| Inference memory | All experts must be loaded | Same as baseline model |

MoD is orthogonal to MoE and the two can be combined: use MoE to vary which parameters process a token AND MoD to vary whether a token is processed at all. The paper demonstrates this composition achieves further gains.

## Implementation Considerations for Production

Deploying MoD in a serving stack (vLLM, TensorRT-LLM) requires handling several subtleties:

**KV-cache management**: Tokens that skip a layer don't produce new key-value entries for that layer's cache. This means the KV-cache becomes *sparse* across layers, with different tokens present at different depths. Paged attention implementations must track per-layer token presence masks.

**Causal masking**: Selected tokens must only attend to other selected tokens that precede them in sequence order. The `top_k_indices_sorted` step above is critical: it preserves autoregressive ordering within the subset.

**Speculative decoding compatibility**: Draft models in speculative decoding assume uniform per-layer computation. Integrating MoD requires either (a) the draft model also uses MoD with aligned routing, or (b) verification accounts for routing disagreements between draft and target.

**Batch heterogeneity**: In continuous batching, different sequences in the same batch may route different tokens. The implementation must either route per-sequence (losing some batch efficiency) or use a union of routed positions (over-computing slightly but maintaining batched matmuls).

## Training: The Auxiliary Routing Loss

To prevent the router from collapsing to trivial solutions (always selecting the first $k$ positions, or always selecting the same token types regardless of content), training includes a lightweight auxiliary loss:

```python
# Encourage router to use full score range (prevent collapse)
router_entropy_loss = -torch.mean(
    torch.distributions.Bernoulli(logits=scores).entropy()
)

total_loss = language_model_loss + alpha * router_entropy_loss
```

The entropy term encourages the router to make confident decisions (high or low scores) rather than assigning near-uniform scores that make top-k selection essentially random.

## Results and Practical Impact

On standard language modeling benchmarks:

- **IsoFLOP comparison**: MoD models match baseline perplexity when given the same total training compute budget
- **Inference speedup**: 50% faster token generation at equivalent quality, because each forward pass uses substantially fewer FLOPs
- **No quality degradation**: unlike post-hoc pruning or distillation, MoD trains the routing end-to-end, so the model learns to compensate

The technique is particularly valuable for long-context inference, where attention's quadratic cost dominates. At 128K context length with $C = 0.5$, the attention compute reduction from $N^2$ to $(N/2)^2$ saves 75% of the attention FLOPs per MoD layer.

## Looking Forward

Mixture of Depths represents a broader shift toward *adaptive computation* in production LLMs. Rather than building one monolithic model that applies maximum compute to every token, next-generation architectures will dynamically allocate resources based on token difficulty, sequence position, and task requirements. Combined with speculative decoding (which already skips compute for easy tokens via draft models) and MoE (which routes across parameter subsets), MoD adds a third axis of conditional computation that could make 100B+ parameter models practical for real-time serving without quality compromise.
