---
title: "Diffusion Language Models: Generating Text Without Left-to-Right"
date: 2026-07-20
tags: [diffusion-models, llm-architecture, generative-models, inference, language-models]
excerpt: "Every large language model you have used generates one token at a time, left to right. LLaDA throws that away: it masks a whole sequence, then denoises it in parallel over a handful of steps — a diffusion process over discrete tokens that matches LLaMA3 8B, beats it on math, and quietly solves the reversal curse GPT-4o still fails."
---

The autoregressive factorization is so deeply baked into how we think about language models that it is easy to forget it is a *choice*. Every GPT-style model computes `p(x) = ∏ p(xᵢ | x₁…xᵢ₋₁)` — it predicts token *i* from everything to its left, and generates strictly left to right. That choice buys teacher-forced training and clean KV-cache decoding, but it also imposes a rigid causal ordering on a problem that is not inherently sequential.

[LLaDA](https://arxiv.org/abs/2502.09992) (Nie et al., 2025) asks the heretical question: what if language modeling does not require autoregression at all? It trains an 8B-parameter **masked diffusion model** from scratch, under the ordinary pretrain-then-SFT recipe, and shows it is competitive with LLaMA3 8B across knowledge, math, and code — while structurally sidestepping failure modes that autoregressive models cannot escape.

## The forward process: dissolving text into masks

Diffusion models define a *forward* process that gradually destroys data, and learn to *reverse* it. In continuous image diffusion you add Gaussian noise. Tokens are discrete, so LLaDA uses masking as its corruption operator.

Introduce a continuous time `t ∈ [0, 1]`. At time `t`, each token is *independently* replaced by a special `[MASK]` symbol with probability `t`, and left untouched with probability `1 − t`:

```
q(xₜⁱ | x₀ⁱ) = { 1 − t   if xₜⁱ = x₀ⁱ   (unchanged)
                {   t     if xₜⁱ = M      (masked)
```

At `t = 0` the sequence is fully intact; at `t = 1` it is entirely masked. The masking is fully factorized across positions — there is no fixed 15% ratio like BERT; every training example is corrupted at a *random* level `t ∼ U[0,1]`, from barely touched to almost fully erased. That single change — a continuously varying, uniformly sampled mask ratio instead of a fixed one — is what turns a masked *language* model into a masked *diffusion* model.

## The training objective

The model `p_θ(· | xₜ)` is a plain Transformer — importantly, one **without a causal mask**, so every position attends to every other. It receives the partially masked sequence and predicts the original token at each masked position. The loss is cross-entropy on the masked positions only, weighted by `1/t`:

```
                    ┌  1    L                              ┐
L(θ) = − E_{t,x₀,xₜ}│ ───  Σ  𝟙[xₜⁱ = M] · log p_θ(x₀ⁱ | xₜ) │
                    └  t   i=1                             ┘
```

Two details make this more than "BERT with random mask ratios":

- **The `1/t` weight is not a heuristic.** It is exactly the factor that makes `L(θ)` an *upper bound on the negative log-likelihood* of the data. This is the bridge from a denoising objective to a principled generative model — you are optimizing a genuine likelihood bound, so the model defines a proper distribution you can sample from and score. Earlier masked-token generators like MaskGIT dropped this term and lost the maximum-likelihood interpretation.
- Lightly masked examples (small `t`) are easy — most context is visible — so they contribute little gradient but get up-weighted; heavily masked examples (large `t`) are the hard, information-poor cases. The weighting balances the signal across corruption levels.

For supervised fine-tuning the objective is identical, except only the *response* tokens are ever masked; the prompt is always fully visible and conditioned on.

`★ Insight ─────────────────────────────────────`
Because the predictor is bidirectional and every training step masks a random subset, the model learns `p(any subset | any other subset)` — not just `p(next | prefix)`. That is a strictly richer conditional family than autoregression, and it is the root cause of the reversal-curse result below.
`─────────────────────────────────────────────────`

## Sampling: denoising in parallel

Generation runs the process backwards. Start at `t = 1` with a fully masked sequence of the desired length, then walk `t` down toward `0` over `N` discrete steps. At each step from `t` to `s` (with `s < t`):

1. Feed the current partially masked sequence to the Transformer. It predicts **all** masked tokens *simultaneously* in one forward pass.
2. Fill in the predictions, but then **remask** a fraction to stay consistent with the forward process. In expectation you keep the tokens that should be revealed by time `s` and re-hide the rest.

The naive rule remasks each freshly predicted token with probability `s/t`. LLaDA's better rule is **low-confidence remasking**: keep the `⌊L(1−s)⌋` highest-confidence predictions and remask the lowest-confidence ones. Confident tokens get committed early; uncertain positions get more denoising iterations — an annealing schedule over the sequence.

A minimal sketch of the loop:

```python
def generate(model, length, steps, mask_id):
    x = torch.full((1, length), mask_id)          # t = 1: all masked
    for i in range(steps):
        t = 1.0 - i / steps
        s = 1.0 - (i + 1) / steps
        masked = (x == mask_id)
        logits = model(x)                          # predict ALL positions at once
        probs = logits.softmax(-1)
        conf, pred = probs.max(-1)                 # per-token best guess + confidence
        x = torch.where(masked, pred, x)           # fill masked slots
        # remask the lowest-confidence predictions to align with time s
        n_keep = int(length * (1 - s))
        conf_masked = conf.masked_fill(~masked, float('inf'))
        remask_idx = conf_masked.argsort(dim=-1)[:, : length - n_keep]
        x[0, remask_idx[0]] = mask_id
    return x
```

`N` is a compute-versus-quality knob: more steps mean better samples but more forward passes. Unlike autoregressive decoding, `N` is *decoupled from sequence length* — you can denoise a 512-token block in 32 or 128 steps regardless of how long it is.

### Semi-autoregressive block decoding

Pure diffusion generates the entire block at once, which struggles with variable-length outputs (padding tokens make the model terminate early). LLaDA supports **block diffusion** with no retraining: split the output into blocks, generate them left to right, but denoise *within* each block in parallel. This hybrid recovers the length-control benefits of autoregression while keeping intra-block parallelism, and it materially helps on structured tasks — GSM8K jumped from 69.4 to 78.6 and MATH from 31.9 to 42.2 just by switching to block sampling.

## Does it actually work?

Trained on 2.3T tokens (versus LLaMA3's 15T), the base model holds its own:

| Benchmark | LLaDA 8B | LLaMA3 8B |
|-----------|----------|-----------|
| MMLU (5-shot) | 65.9 | 65.4 |
| GSM8K (4-shot) | **70.3** | 48.7 |
| HumanEval (0-shot) | 35.4 | 34.8 |

Competitive on knowledge and code, and notably stronger on grade-school math — on roughly a seventh of the training data. This is the load-bearing result: it is the first demonstration that a from-scratch diffusion model can reach autoregressive-LLM quality at the 8B scale, not just on toy corpora.

## The reversal curse

The most telling experiment is the smallest. Autoregressive models suffer the **reversal curse**: a model trained on "A is B" often cannot answer "what is B?" because it only ever saw the tokens flow one direction. On a set of 496 Chinese poem pairs, tested on completing the *next* line versus the *previous* line:

| Model | Forward | Reversal |
|-------|---------|----------|
| GPT-4o | 82.7 | 34.3 |
| Qwen2.5-7B | 75.9 | 38.0 |
| LLaDA-8B | 51.8 | **45.6** |

GPT-4o collapses by 48 points going backwards. LLaDA is nearly *symmetric*. It is weaker forward, but it does not have a preferred direction at all — because it was never trained to have one. When your training objective is "predict any masked subset from any visible subset," directionality is simply not a property the model has.

## Why this matters

Diffusion language models are not going to displace autoregressive LLMs tomorrow — the ecosystem, the KV-cache tooling, and RLHF pipelines are all built for causal decoding, and LLaDA's instruct model still trails on some benchmarks. But the architecture unlocks properties that are genuinely hard to bolt onto autoregression:

- **Parallel token generation** decoupled from sequence length, with a tunable steps-vs-quality dial.
- **Bidirectional conditioning** — infilling, editing, and constraint satisfaction are native, not hacks.
- **No causal ordering bias**, which dissolves the reversal curse and related directional pathologies.

The deeper lesson is a reminder that a foundational assumption — "language models generate left to right" — was an engineering convenience, not a law. Diffusion over discrete tokens is a second viable path to the same capabilities, and it comes with a different, complementary set of tradeoffs. That is exactly the kind of branch in the design space worth watching.
