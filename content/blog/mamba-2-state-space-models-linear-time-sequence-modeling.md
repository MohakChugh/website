---
title: "Mamba-2: State Space Models and Linear-Time Sequence Modeling Without Attention"
date: 2026-07-08
tags: [state-space-models, transformers, mamba, sequence-modeling, gpu-optimization]
excerpt: "How Mamba-2's structured state space duality (SSD) framework unifies SSMs with attention, achieving Transformer-quality language modeling at linear time complexity through hardware-aware block decomposition on modern GPUs."
---

## The Quadratic Wall

Transformers dominate sequence modeling, but their self-attention mechanism computes pairwise interactions across all tokens, yielding O(n²) time and memory complexity in sequence length n. For a 128K-token context, this means 16 billion attention computations per layer. Flash Attention optimizes the constant factor through tiling, but the quadratic asymptotic remains. This is the wall that State Space Models (SSMs) aim to break.

## State Space Models: The Core Abstraction

An SSM defines a linear dynamical system that maps an input sequence x(t) to an output y(t) through a latent state h(t):

```
h'(t) = A·h(t) + B·x(t)
y(t)  = C·h(t) + D·x(t)
```

After discretization with step size Δ, this becomes:

```
h[k] = Ā·h[k-1] + B̄·x[k]
y[k] = C·h[k]
```

where Ā = exp(ΔA) and B̄ = (ΔA)⁻¹(exp(ΔA) − I)·ΔB.

The key insight: this recurrence processes sequences in O(n) time with O(1) memory per step. But naively, it cannot be parallelized across the sequence dimension, unlike attention which is embarrassingly parallel.

## Mamba-1: Selective State Spaces

The original Mamba (Gu & Dao, 2023) introduced **input-dependent selection** — making the matrices B, C, and Δ functions of the input:

```python
# Simplified Mamba selection mechanism
B = linear_B(x)        # (batch, seq_len, state_dim)
C = linear_C(x)        # (batch, seq_len, state_dim)
delta = softplus(linear_delta(x))  # (batch, seq_len, d_model)
```

This selectivity allows the model to decide what to remember and what to forget at each timestep, analogous to gating in LSTMs but without the quadratic attention cost. The hardware challenge: input-dependent parameters prevent the use of convolution-mode computation (which requires time-invariant parameters).

Mamba-1 solved this with a **parallel selective scan** — a GPU kernel that computes the recurrence using a work-efficient parallel prefix sum over the state transitions, achieving O(n) work with O(log n) span.

## Mamba-2: Structured State Space Duality

Mamba-2 (Dao & Gu, 2024) makes a surprising theoretical connection: under specific structural constraints, **SSMs and attention are duals of each other**.

### The Duality

Consider a scalar SSM (state dimension N=1) with diagonal structure matrix A = diag(a₁, ..., aₙ). The output can be written as:

```
y[i] = Σⱼ≤ᵢ  Cᵢ · (Πₖ₌ⱼ₊₁ⁱ aₖ) · Bⱼ · xⱼ
```

This is equivalent to a **masked linear attention** with a specific structured mask M where:

```
M[i,j] = Cᵢ · (Πₖ₌ⱼ₊₁ⁱ aₖ) · Bⱼ    for j ≤ i
M[i,j] = 0                              for j > i
```

This is the **State Space Duality (SSD)**: the SSM recurrence and a semiseparable matrix multiplication compute the same function. The matrix M has semiseparable structure (every submatrix of the lower triangle has rank at most N, the state dimension).

### Why This Matters for Hardware

The duality gives two computation paths:

1. **Linear (recurrent) mode**: O(n·N) total work, sequential across time — good for autoregressive generation
2. **Quadratic (attention) mode**: O(n²·N) work but fully parallel — good for training on GPUs

Mamba-2 exploits both simultaneously through **block decomposition**.

## Block Decomposition: The Hardware-Aware Algorithm

The key algorithmic innovation is chunking the sequence into blocks of size Q (typically 64-256):

```
Sequence: [───Block 1───][───Block 2───][───Block 3───]...
           chunk_size=Q    chunk_size=Q    chunk_size=Q
```

**Within each block**: use the quadratic (attention-like) form. Since Q is small (64-256), the Q² operations fit entirely in SRAM/registers.

**Across blocks**: use the linear (recurrent) form. Propagate the state vector h between blocks sequentially.

```python
def ssd_block_decomposition(x, A, B, C, chunk_size=64):
    chunks = x.reshape(-1, chunk_size, d_model)
    states = []
    h = zeros(state_dim)
    
    for chunk in chunks:
        # Intra-chunk: quadratic attention-like matmul (in SRAM)
        # Compute the Q×Q semiseparable matrix for this chunk
        M_intra = compute_ssm_mask(A_chunk, B_chunk, C_chunk)
        y_intra = M_intra @ chunk  # O(Q² · N)
        
        # Inter-chunk: linear state propagation
        # Contribution from previous chunks via state h
        y_cross = C_chunk @ h  # O(Q · N)
        
        # Update state for next chunk
        h = decay_state(A_chunk, h) + scan_chunk(A_chunk, B_chunk, chunk)
        
        y_chunk = y_intra + y_cross
        states.append(y_chunk)
    
    return concatenate(states)
```

The total complexity is O(n·Q·N + n·N) ≈ O(n·N) since Q is constant. The quadratic term is hidden inside chunks small enough to fit in GPU SRAM, so it runs at register/shared-memory speed rather than HBM bandwidth.

## The Tensor Core Connection

Mamba-2 reformulates the intra-chunk computation as a matrix multiplication, enabling the use of GPU Tensor Cores (which provide 16x throughput over standard CUDA cores for matmuls). The structured mask M within each chunk is materialized as a dense Q×Q matrix and multiplied against the input chunk:

```python
# On GPU: leverages Tensor Core matmul
# Q=64, head_dim=64 → 64×64 @ 64×D matmul
intra_output = torch.matmul(ssm_mask, value_chunk)
```

This is why Mamba-2 is 2-8x faster than Mamba-1 despite computing the same function — it converts irregular selective scan operations into dense matmuls that saturate Tensor Core throughput.

## Architecture: Multi-Head SSM

Mamba-2 introduces a multi-head pattern analogous to multi-head attention:

```python
class Mamba2Block(nn.Module):
    def __init__(self, d_model, n_heads, state_dim, chunk_size=64):
        self.n_heads = n_heads
        self.head_dim = d_model // n_heads
        self.state_dim = state_dim
        self.chunk_size = chunk_size
        
        # Input projections (like Q, K, V in attention)
        self.in_proj = nn.Linear(d_model, 2 * d_model + n_heads)
        self.out_proj = nn.Linear(d_model, d_model)
        
        # Learnable decay (log-space for stability)
        self.A_log = nn.Parameter(torch.randn(n_heads))
    
    def forward(self, x):
        # Project to (B, C) pairs and delta
        z, x_bc, dt = self.in_proj(x).split(
            [self.d_model, self.d_model, self.n_heads], dim=-1
        )
        
        # Input-dependent B and C
        B, C = x_bc.chunk(2, dim=-1)
        
        # Discretized decay
        A = -torch.exp(self.A_log)
        
        # SSD computation (block-decomposed)
        y = ssd(x * dt.unsqueeze(-1), A, B, C, self.chunk_size)
        
        # Gated output (SiLU activation)
        return self.out_proj(y * F.silu(z))
```

Each head maintains an independent state of dimension N, and heads can specialize in different temporal patterns — short-range syntax vs. long-range reasoning.

## Empirical Results

On standard language modeling benchmarks (The Pile, SlimPajama), Mamba-2 matches Transformer++ (with Flash Attention 2, RMSNorm, SwiGLU) at equivalent model size and training FLOPs:

| Model (2.7B params) | Pile ppl ↓ | Train throughput (tok/s) |
|---------------------|-----------|--------------------------|
| Transformer++       | 7.21      | 24,400                   |
| Mamba-1             | 7.33      | 31,200                   |
| Mamba-2 (SSD)       | 7.19      | 42,800                   |

Mamba-2 achieves 75% higher training throughput than a Transformer at the same perplexity. At inference time, autoregressive generation uses the recurrent form: constant memory per step regardless of context length, with 5x lower latency than FlashAttention-2 at 64K tokens.

## Hybrid Architectures: The Pragmatic Path

Pure SSMs still lag Transformers on tasks requiring precise retrieval from long contexts (the "needle in a haystack" problem). The emerging consensus is **hybrid architectures** — interleaving SSM layers with sparse attention layers:

```
Layer 1-4:   Mamba-2 (linear complexity, general sequence modeling)
Layer 5:     Sliding Window Attention (local retrieval)
Layer 6-9:   Mamba-2
Layer 10:    Full Attention (global retrieval, sparse)
...
```

Jamba (AI21, 2024) demonstrated this hybrid approach at 52B parameters, achieving Transformer-quality with 3x lower KV-cache memory during inference. The SSM layers handle the bulk of sequence processing at linear cost, while sparse attention layers provide the exact retrieval capability where needed.

## Why This Matters

The Mamba-2 SSD framework suggests that the attention mechanism is not a fundamental requirement for sequence modeling — it is one instantiation of a broader family of structured matrix computations. As context lengths push toward millions of tokens for agentic applications, the linear-time property becomes not just a theoretical nicety but a hard engineering requirement. The duality framework provides a principled bridge: existing attention-based systems can incrementally adopt SSM layers where quadratic cost is prohibitive, without sacrificing model quality.

The broader implication is architectural: the "right" sequence model may not be a single mechanism but a heterogeneous stack where different layers use different members of the SSM-attention family, optimized for their position in the network and the computational budget available at that layer.
