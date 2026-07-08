---
title: "Contextual Sparsity: Activation-Aware LLM Inference and the Deja Vu Paradigm"
date: 2026-07-09
tags: ["llm-inference", "sparsity", "transformer-optimization", "gpu-efficiency", "neural-architecture"]
excerpt: "Modern LLMs waste 95% of computation on neurons that produce near-zero activations. Contextual sparsity exploits input-dependent activation patterns to skip irrelevant neurons at inference time, achieving 2-6x speedups with negligible quality loss."
---

# Contextual Sparsity: Activation-Aware LLM Inference and the Deja Vu Paradigm

A 175B parameter model processes your prompt. Inside each transformer layer, the MLP block projects through 12,288 hidden neurons. But here's the revelation: for any given input token, fewer than 5% of those neurons produce activations above a meaningful threshold. The other 95% contribute effectively nothing to the output, yet consume identical compute and memory bandwidth.

This observation, formalized as **contextual sparsity**, has become one of the most impactful optimization techniques in LLM inference. Unlike pruning (which permanently removes parameters) or quantization (which reduces precision), contextual sparsity dynamically skips computation per-token based on input-dependent activation patterns.

## The Empirical Foundation

The phenomenon was first rigorously characterized in the Deja Vu paper (Liu et al., ICML 2023). Their key findings across OPT-175B and similar architectures:

1. **MLP sparsity**: In layers using ReLU activations, 85-95% of neurons produce zero or near-zero outputs for any given input
2. **Attention head sparsity**: For each token, only 20-30% of attention heads contribute meaningfully to the output
3. **Contextual dependence**: The set of "active" neurons varies dramatically between inputs, ruling out static pruning
4. **Predictability**: Despite being input-dependent, active neuron sets can be predicted from earlier-layer activations with >90% accuracy

```python
# Measuring activation sparsity in a transformer MLP
def measure_mlp_sparsity(hidden_states, mlp_layer, threshold=0.1):
    """
    For a typical OPT-175B layer with 12288 intermediate neurons,
    expect sparsity_ratio > 0.90 for most inputs.
    """
    intermediate = mlp_layer.gate_proj(hidden_states)
    activations = F.relu(intermediate)  # or SiLU for LLaMA-style

    active_mask = activations.abs() > threshold
    sparsity_ratio = 1.0 - active_mask.float().mean().item()
    return sparsity_ratio, active_mask
```

The critical insight is that this sparsity is not an artifact of ReLU (which trivially zeros negative inputs). Models using SiLU/GELU activations (LLaMA, Mistral) exhibit **functional sparsity**: neurons whose outputs, while non-zero, are so small they contribute negligibly to the layer output when multiplied by the down-projection weights.

## The Prediction Problem

Knowing that sparsity exists is insufficient. You need to know *which* neurons will be active *before* computing them. Deja Vu solves this with a lightweight predictor network trained on activation traces:

```python
class SparsityPredictor(nn.Module):
    """
    Trained offline on activation traces from calibration data.
    Input: hidden state from layer N-1
    Output: binary mask predicting active neurons in layer N's MLP
    """
    def __init__(self, hidden_dim, intermediate_dim, bottleneck=256):
        super().__init__()
        self.down = nn.Linear(hidden_dim, bottleneck, bias=False)
        self.up = nn.Linear(bottleneck, intermediate_dim, bias=False)

    def forward(self, x):
        # Low-rank projection keeps predictor cost < 1% of MLP cost
        return torch.sigmoid(self.up(F.relu(self.down(x))))

# At inference time:
def sparse_mlp_forward(hidden_states, mlp, predictor, top_k_ratio=0.05):
    # Predict which neurons will fire (cost: ~0.5% of full MLP)
    scores = predictor(hidden_states)

    # Select top-k neurons (e.g., top 5% of 12288 = 614 neurons)
    k = int(scores.shape[-1] * top_k_ratio)
    _, indices = scores.topk(k, dim=-1)

    # Compute only selected columns of gate_proj and rows of down_proj
    gate_weights = mlp.gate_proj.weight[indices]  # [k, hidden_dim]
    down_weights = mlp.down_proj.weight[:, indices]  # [hidden_dim, k]

    intermediate = F.silu(hidden_states @ gate_weights.T)
    output = intermediate @ down_weights.T
    return output
```

The predictor is a tiny two-layer network (256 hidden units) that adds <1% overhead while achieving >90% recall on the truly active neuron set.

## From Research to Production: PowerInfer and GPU-CPU Heterogeneity

PowerInfer (SJTU, 2024) extended contextual sparsity to consumer hardware by observing a power-law distribution in neuron activation frequencies:

- **Hot neurons** (~10%): activated for >50% of inputs, always needed
- **Cold neurons** (~90%): activated rarely, only needed for specific inputs

This motivates a heterogeneous execution strategy:

```
┌─────────────────────────────────────────────┐
│              GPU VRAM (Limited)              │
│  ┌─────────────────────────────────────┐    │
│  │  Hot neurons (10% of params)         │    │
│  │  Always loaded, always computed      │    │
│  └─────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
              ▲ Selective load on cache miss
┌─────────────────────────────────────────────┐
│              CPU RAM (Abundant)              │
│  ┌─────────────────────────────────────┐    │
│  │  Cold neurons (90% of params)        │    │
│  │  Loaded on-demand per token          │    │
│  └─────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
```

By keeping hot neurons permanently in GPU VRAM and loading cold neurons on-demand (only when the predictor indicates they'll fire), PowerInfer runs a 70B model on a single RTX 4090 at 11 tokens/second, competitive with offloading approaches that achieve 2-3 tokens/second.

## The SiLU/GELU Challenge: TurboSparse

The original Deja Vu work was most effective on ReLU models where sparsity is exact (zero activations). Modern architectures (LLaMA, Mistral, Qwen) use SiLU, which never exactly zeros. TurboSparse (2024) addresses this with **ReLUfication**: replacing SiLU activations with ReLU in pre-trained models, then recovering quality through targeted fine-tuning:

```python
# ReLUfication: swap SiLU for ReLU + short fine-tune
# Original LLaMA-style MLP:
# output = down_proj(silu(gate_proj(x)) * up_proj(x))

# After ReLUfication:
# output = down_proj(relu(gate_proj(x)) * up_proj(x))
# + 2B tokens of continued pre-training to recover quality

# Result: activation sparsity jumps from ~50% (functional) to ~90% (exact)
# Quality loss: <0.5% on standard benchmarks after fine-tuning
```

The fine-tuning cost is 2-5B tokens (a fraction of pre-training), but the inference benefit is permanent: exact zeros enable hardware-level sparse matrix operations and eliminate the predictor network entirely.

## Kernel-Level Implementation

Exploiting contextual sparsity requires custom CUDA kernels. The naive approach (indexing into weight matrices) destroys memory coalescing. Production implementations use:

```cuda
// Gather-scatter sparse MLP kernel (simplified)
__global__ void sparse_mlp_kernel(
    const half* __restrict__ input,       // [batch, hidden_dim]
    const half* __restrict__ gate_weight,  // [intermediate_dim, hidden_dim]
    const int* __restrict__ indices,       // [batch, top_k]
    half* __restrict__ output,            // [batch, hidden_dim]
    int hidden_dim, int top_k
) {
    int batch_idx = blockIdx.x;
    int neuron_local = threadIdx.x;  // Which of the top_k neurons this thread handles

    if (neuron_local >= top_k) return;

    int neuron_global = indices[batch_idx * top_k + neuron_local];

    // Compute dot product for this specific neuron
    float acc = 0.0f;
    const half* row = gate_weight + neuron_global * hidden_dim;
    const half* inp = input + batch_idx * hidden_dim;

    for (int i = 0; i < hidden_dim; i += 8) {
        // Vectorized load + FMA
        float4 w = __half2float4(*(half4*)(row + i));
        float4 x = __half2float4(*(half4*)(inp + i));
        acc += w.x*x.x + w.y*x.y + w.z*x.z + w.w*x.w;
    }

    // ReLU + store to shared buffer for down_proj
    acc = fmaxf(acc, 0.0f);
    // ... down_proj scatter-accumulate follows
}
```

Production systems (vLLM with Deja Vu integration, MLC-LLM) use more sophisticated approaches: pre-sorting neurons by activation frequency to improve cache locality, and batching the sparse computation across tokens that share similar active sets.

## Quantitative Results

Across publicly reported benchmarks:

| Method | Model | Sparsity | Speedup | Quality Loss |
|--------|-------|----------|---------|--------------|
| Deja Vu | OPT-175B | 95% MLP, 80% attn | 2.2x | <1% perplexity |
| PowerInfer | LLaMA-70B | 90% MLP | 4.5x (vs offload) | <0.5% |
| TurboSparse | Mistral-47B | 90% MLP (ReLU) | 2.8x | 0.3% average |
| ProSparse | LLaMA2-13B | 88% MLP | 1.8x | 0.2% |

## Implications for System Design

Contextual sparsity fundamentally changes the compute profile of LLM inference:

**Memory bandwidth becomes less dominant.** Traditional LLM inference is memory-bound (loading weights >> compute). With 90% sparsity, effective weight-load volume drops 10x, shifting the bottleneck toward predictor overhead and irregular memory access patterns.

**Batch size sweet spots change.** Dense inference benefits monotonically from larger batches (amortizing weight loads). Sparse inference has a crossover point where predictor overhead per-token becomes the bottleneck, and active sets across the batch diverge enough to reduce sparsity benefits.

**KV-cache is the next frontier.** Current work focuses on MLP sparsity. But attention head sparsity (selecting which heads to compute per token) promises similar gains in the attention computation and, critically, in KV-cache memory consumption.

The trajectory is clear: models are growing sparser at inference time even as they grow larger at training time. The 95% of "sleeping" neurons are not wasted parameters; they encode specialized knowledge that activates precisely when needed. The engineering challenge is making the hardware execute only the computation that matters.
