---
title: "Gated Attention: A Sigmoid After SDPA, the Low-Rank W_V·W_O Bottleneck, and Attention-Sink-Free LLMs"
date: 2026-10-04
tags: ["transformers", "attention", "llm-architecture", "attention-sink", "training-stability"]
excerpt: "The Qwen team's NeurIPS 2025 best paper found that one head-specific sigmoid gate on the SDPA output lowers perplexity, removes loss spikes, and cuts first-token attention from 46.7% to 4.8%. I went through the paper's tables. Across six gated variants, the mean gate score ranks sink mass and massive activations exactly (Spearman 1.0, n=6). The RULER gain is mostly a context-extension effect: +0.3 to +1.7 points inside the trained length, +35 points at 32k after YaRN. A simple length model shows why a learned sink can't stay calibrated when the context grows."
---

# Gated Attention: A Sigmoid After SDPA, the Low-Rank W_V·W_O Bottleneck, and Attention-Sink-Free LLMs

Softmax attention weights are non-negative and sum to 1, so a head can't output "nothing". It has to put its attention somewhere. Trained models solve this by dumping the extra attention onto a token whose value vector is close to zero, usually the first token. This is the **attention sink**.

*Gated Attention for Large Language Models: Non-linearity, Sparsity, and Attention-Sink-Free* (Qiu et al., Qwen team, arXiv:2505.06708, NeurIPS 2025 best paper) tested more than 30 gating variants on 15B-A2B MoE and 1.7B dense models, with up to 3.5T training tokens. The change that won is small. Multiply each head's SDPA output by a sigmoid computed from the current token's hidden state, before the output projection.

## The change

```python
# x: pre-norm hidden states (B, n, d_model); h heads of size dk
q, k, v = split_heads(x @ Wq), split_heads(x @ Wk), split_heads(x @ Wv)
y = sdpa(q, k, v, causal=True)                  # (B, h, n, dk)
g = torch.sigmoid(x @ Wg).view(B, n, h, dk)     # G1: elementwise, head-specific
y = y * g.transpose(1, 2)                       # gate depends on the *query* token only
out = merge_heads(y) @ Wo
```

The paper labels five gate positions: after Q (G4), K (G3), V (G2), after SDPA (G1), and after the output projection (G5). In the 15B MoE at 400B tokens (Table 1), the elementwise G1 gate cut average perplexity from 6.026 to 5.761 and raised MMLU from 58.79 to 60.82. The G5 gate did almost nothing (PPL 6.017). Spending similar parameters on 48 query heads or 4 extra experts only reached 5.95–5.98. A headwise G1 gate, one scalar per head, adds only 1.6M parameters and gets most of the gain (5.792).

## Why position matters: W_V·W_O is one low-rank matrix

Write out one head's contribution to token i:

```
o_i = Σ_j S_ij · x_j · (W_V · W_O)
```

The value and output projections are back-to-back linear maps, so they merge into a single d_model × d_model matrix of rank at most dk. With dk = 128 and d_model = 2048, each head's read-write path is a rank-128 linear map. GQA shares W_V across query heads, which shrinks it further. Adding a nonlinearity anywhere between W_V and W_O breaks the merge. That covers G2 (gate on the values) and G1 (gate on the mixed output). G5 sits after W_O, so it can't break the merge, which matches its null result. Ablations agree: a parameter-free per-head RMSNorm at G1 also lowers PPL.

Nonlinearity alone doesn't account for the G1 vs G2 gap, though. G2 is also nonlinear and has fewer parameters (25M), but reaches only 5.820. The rest of the gap comes from sparsity.

## Sparsity, and where the sink goes

At G1 the gate is a function of the query token. At G2 it's a function of each key token. A query-dependent gate can shut a head off for a particular query. That is the "output nothing" option softmax lacks. And trained G1 gates do shut: the mean elementwise gate score is 0.116, and the distribution is concentrated near zero. Once a head can turn itself off through the gate, it doesn't need a sink. First-token attention averaged over layers drops from 46.7% to 4.8%. In the baseline's worst layer (layer 21) it goes from 83% to 4%.

Table 4 is the most useful table in the paper. Here it is with the six gated variants sorted by mean gate score:

| Variant | Mean gate | Max activation | First-token attn | PPL |
|---|---|---|---|---|
| Baseline (no gate) | – | 1053 | 0.467 | 6.026 |
| SDPA elementwise | 0.116 | 94 | 0.048 | 5.761 |
| SDPA headwise | 0.172 | 98 | 0.073 | 5.792 |
| Value elementwise (G2) | 0.221 | 125 | 0.297 | 5.820 |
| SDPA head-shared | 0.271 | 286 | 0.301 | 5.801 |
| SDPA input-independent | 0.335 | 471 | 0.364 | 5.917 |
| SDPA NS-sigmoid (range [0.5, 1]) | 0.653 | 892 | 0.451 | 5.900 |

I ran the correlations. Across these six rows, mean gate score ranks first-token attention exactly (Spearman 1.0, Pearson 0.84). It also ranks max activation exactly (Spearman 1.0, Pearson 0.98). For perplexity, Spearman is 0.89. Six points is a small sample, but it's a clean dose-response. Two rows act as controls:

- **NS-sigmoid**, defined as 0.5 + 0.5·sigmoid(x), keeps the nonlinearity but can't go below 0.5. The sink comes back almost completely (0.451 vs 0.467). So nonlinearity alone doesn't remove the sink. Sparsity does.
- **The G2 value gate** brings max activations down to 125, close to the best rows. Its sink stays at 0.297. So massive activations aren't required for a sink, which contradicts the usual story that the two go together. The gate needs to depend on the query to take over the sink's job.

The practical link to training stability goes through the max-activation column. The baseline's residual-stream outliers above 1000 are where BF16 rounding error builds up. Over the 3.5T-token dense run, the gated model shows almost no loss spikes. That let the authors raise the learning rate and batch size in settings where the baseline diverged.

## The long-context result is mostly about context extension

The abstract says gating gains "over 10 points on RULER." Table 5 shows where that comes from:

| | 4k | 8k | 16k | 32k | 64k | 128k |
|---|---|---|---|---|---|---|
| Gate − baseline, native 32k model | +1.67 | +1.23 | +1.46 | +0.27 | – | – |
| Gate − baseline, after YaRN to 128k | +5.23 | +8.49 | +15.51 | **+34.94** | +29.09 | +27.17 |

Inside the trained length, gating barely helps. The paper says so too: the sink "may not hurt" there. The large difference shows up only after YaRN changes the RoPE frequencies without retraining. The baseline drops from 79.50 to 37.94 at 32k, a length it used to handle. The gated model drops only from 79.77 to 72.88. The paper's hypothesis is that sink-based attention patterns don't survive changes to RoPE. A minimal model shows why a learned sink is fragile when length changes.

Model a sink as a fixed logit gap Δ between the sink token and an average non-sink token. The sink then gets 1/(1 + (n−1)·e^(−Δ)) of the attention mass, and the rest "leaks" onto real tokens:

```python
import math
gap = math.log(32767 * 0.95 / 0.05)        # calibrated: 5% leak at n = 32k  -> Δ ≈ 13.34
for n in (4096, 32768, 131072, 1 << 20):
    print(n, 1 - 1 / (1 + (n - 1) * math.exp(-gap)))
# 4096 0.0065   32768 0.05   131072 0.174   1048576 0.628
```

Under a fixed gap, a head tuned to leak 5% at 32k leaks 17% at 128k and 63% at 1M. In this model, keeping the leak at 5% would need the gap to grow from 11.3 nats at 4k to 14.7 at 128k. The model has no reason to learn that dependence on length. A gate doesn't have this problem. Its value is σ(x_i·W_g), computed from the query token alone, so it doesn't depend on n or on RoPE. This is my toy model, not the paper's, and it ignores YaRN's temperature scaling of Δ. But it gives the hypothesis a mechanism: a sink is a softmax-normalized off switch, so it weakens as competing tokens are added.

## A caveat from a failed toy

I tried to reproduce sink formation and gate closing in a one-layer PyTorch model on synthetic recall tasks. It didn't work. The gate stayed near 0.5, the baseline sink was weak (3–29% BOS mass), and accuracy was 100% everywhere, so nothing pushed a head toward a null output. There was also a structural flaw: a G1 gate sees only the query's own hidden state, which in one layer is just its embedding. It can turn a head off only based on what the query state already knows. In a deep model, earlier layers have contextualized that state. Don't expect a one-layer synthetic setup to show the effect.

## Using it

- **Use the elementwise, head-specific G1 gate.** Sharing it across heads brings the sink back (0.301). The headwise version costs 1.6M parameters instead of 201M and recovers about 88% of the PPL gain. Never gate after W_O.
- **Re-check sink workarounds.** StreamingLLM-style first-token retention in KV-cache eviction and outlier-aware quantization assume a sink exists.
- **Evaluate after RoPE rescaling.** That's where the benefit is. At native length, expect about 0.25 PPL and stable training, not better retrieval.

The underlying idea goes back to the LSTM: give each unit a multiplicative path to zero. Softmax attention lost that when it required weights to sum to 1. The sink was the model's workaround, and a query-dependent gate makes it unnecessary.
