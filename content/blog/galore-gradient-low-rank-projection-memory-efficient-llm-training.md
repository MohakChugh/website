---
title: "GaLore: Training LLMs on Consumer GPUs via Gradient Low-Rank Projection"
date: 2026-07-09
tags: ["gradient-projection", "memory-efficient-training", "low-rank", "llm-training", "optimizer-states"]
excerpt: "How GaLore achieves up to 65.5% memory reduction during LLM training by projecting gradients into a slowly-changing low-rank subspace, enabling LLaMA 7B pre-training on a single 24GB GPU without approximation trade-offs of LoRA."
---

# GaLore: Training LLMs on Consumer GPUs via Gradient Low-Rank Projection

The memory bottleneck in large language model training is not the model weights themselves, but the optimizer states. For Adam, every parameter requires two additional fp32 buffers (first and second moments), tripling the memory footprint. A 7B parameter model needs ~28GB just for weights in fp32, but ~84GB total when including Adam states. This puts full-rank pre-training firmly out of reach for consumer hardware.

GaLore (Gradient Low-Rank Projection), introduced by Zhao et al. at ICML 2024, offers an elegant solution: project the gradient matrix into a low-rank subspace before the optimizer accumulates states, then periodically refresh that subspace. The result is full-rank training quality with memory costs proportional to the projection rank, not the parameter count.

## The Core Insight: Gradients Are Transiently Low-Rank

The key observation is that while the weight matrices in a trained LLM are typically full-rank, the *gradient* at any given training step occupies a low-dimensional subspace. Crucially, this subspace changes slowly over training, remaining approximately stable for hundreds of steps before drifting.

This is distinct from the assumption behind LoRA, which constrains the *weight update* to a fixed low-rank space throughout training. LoRA's constraint is permanent and limits expressiveness. GaLore's projection is temporary and refreshed, allowing the model to eventually explore the full parameter space.

## Algorithm

Given a weight matrix $W \in \mathbb{R}^{m \times n}$ with gradient $G \in \mathbb{R}^{m \times n}$:

1. **Compute projection matrix** $P \in \mathbb{R}^{m \times r}$ (or $Q \in \mathbb{R}^{n \times r}$) via SVD of the gradient, keeping the top-$r$ left (or right) singular vectors.

2. **Project the gradient** into the low-rank subspace:
   $$\tilde{G} = P^\top G \in \mathbb{R}^{r \times n}$$

3. **Run the optimizer** (Adam) on the compact representation $\tilde{G}$. The optimizer states (m, v) are now $r \times n$ instead of $m \times n$.

4. **Project back** to the full space for the weight update:
   $$\Delta W = P \cdot \text{Adam}(\tilde{G}, m, v)$$

5. **Periodically recompute** $P$ every $T$ steps (typically $T = 200$) by performing SVD on the current full gradient.

The choice of left vs. right projection depends on the matrix shape: project along the smaller dimension to minimize memory.

```python
import torch

class GaLoreProjector:
    def __init__(self, rank, update_freq=200, scale=1.0):
        self.rank = rank
        self.update_freq = update_freq
        self.scale = scale
        self.ortho_matrix = None
        self.step = 0

    def project(self, full_grad):
        if self.step % self.update_freq == 0:
            self.ortho_matrix = self._get_orthogonal_matrix(full_grad)
        self.step += 1

        m, n = full_grad.shape
        if m >= n:  # right projection (tall matrix)
            return full_grad @ self.ortho_matrix
        else:       # left projection (wide matrix)
            return self.ortho_matrix.T @ full_grad

    def project_back(self, low_rank_grad):
        m, n = low_rank_grad.shape
        if self.ortho_matrix.shape[0] >= self.ortho_matrix.shape[1]:
            # Was right-projected
            return low_rank_grad @ self.ortho_matrix.T * self.scale
        else:
            return self.ortho_matrix @ low_rank_grad * self.scale

    def _get_orthogonal_matrix(self, grad):
        m, n = grad.shape
        if m >= n:
            _, _, V = torch.linalg.svd(grad, full_matrices=False)
            return V[:self.rank, :].T  # n x r
        else:
            U, _, _ = torch.linalg.svd(grad, full_matrices=False)
            return U[:, :self.rank]    # m x r
```

## Memory Analysis

For a linear layer with weight $W \in \mathbb{R}^{m \times n}$:

| Component | Standard Adam | GaLore (rank r) |
|-----------|-------------|-----------------|
| Weights | $mn$ | $mn$ |
| First moment | $mn$ | $r \cdot \min(m,n)$ |
| Second moment | $mn$ | $r \cdot \min(m,n)$ |
| Projection matrix | 0 | $r \cdot \max(m,n)$ |
| **Total optimizer** | $2mn$ | $r(\min(m,n) + \max(m,n))$ |

For a 4096 x 4096 matrix with rank 256: standard Adam needs 134M bytes for optimizer states, GaLore needs ~8.4M bytes, a **16x reduction** in optimizer memory for that layer.

The periodic SVD cost is amortized across $T$ steps. With $T = 200$, SVD adds roughly 0.5% wall-clock overhead.

## Why Not Just LoRA?

LoRA constrains the weight update $\Delta W = BA$ where $B \in \mathbb{R}^{m \times r}$, $A \in \mathbb{R}^{r \times n}$ are *fixed-rank* throughout training. This creates a permanent information bottleneck: the model can never update weights outside the column space of $B$.

GaLore sidesteps this by:
1. Allowing the projection subspace to change every $T$ steps
2. Accumulating updates across different subspaces over training
3. The effective weight update after $K$ subspace changes spans a space of rank up to $K \cdot r$, eventually covering the full rank

Empirically, GaLore matches full-rank pre-training perplexity on LLaMA architectures (60M to 7B parameters), while LoRA applied at initialization (without a pre-trained checkpoint) degrades significantly.

## Performance Results

On LLaMA 7B pre-training (C4 dataset, 150K steps):

- **Full-rank Adam (BF16)**: Requires 8x A100 80GB GPUs. Perplexity: baseline.
- **GaLore (rank 1024)**: Single RTX 4090 24GB GPU. Perplexity: matches baseline within 0.2 points.
- **Memory reduction**: 65.5% optimizer state reduction. Total training memory drops from ~58GB to ~22GB per replica.
- **Throughput**: 89% of full-rank speed (SVD overhead is negligible with $T=200$).

On LLaMA 1B pre-training, GaLore with rank 512 matches full-rank training exactly while reducing peak memory from 24GB to 10GB.

## Combining with Quantization: Q-GaLore

GaLore composes naturally with 8-bit optimizer quantization. By quantizing the already-compact optimizer states to INT8:

$$\text{Memory} = mn_{\text{weights}} + \frac{r \cdot \min(m,n)}{4}_{\text{INT8 states}}$$

This pushes LLaMA 7B pre-training to under 16GB, within reach of a single RTX 4060 Ti.

## The Subspace Update Schedule

The projection refresh interval $T$ controls a trade-off:
- **Small $T$ (frequent updates)**: Better subspace tracking, higher SVD cost
- **Large $T$ (infrequent updates)**: Lower overhead, risk of stale projections

The authors find $T = 200$ is robust across model sizes. The gradient subspace rotates slowly enough that 200-step intervals capture >95% of the gradient energy within the projected subspace. They also introduce a cosine-schedule variant where $T$ increases over training (the subspace stabilizes as the model converges).

## Implications for the Training Stack

GaLore represents a shift in how we think about optimizer memory. Traditional approaches attack the problem from the weight side (quantization, mixed precision) or the optimizer side (Adafactor, 8-bit Adam). GaLore attacks the *geometry* of the gradient itself, orthogonal to both strategies.

For practitioners, the key takeaway: if you are pre-training or doing full fine-tuning of models in the 1B-13B range, GaLore lets you do it on hardware that previously required LoRA approximations. You get full-rank training quality without full-rank memory costs, at minimal speed overhead.

The technique has been integrated into the Hugging Face `galore_torch` package and works as a drop-in optimizer replacement, requiring only the rank and update frequency as hyperparameters.
