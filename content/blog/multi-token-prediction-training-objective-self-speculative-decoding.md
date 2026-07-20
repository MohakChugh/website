---
title: "Multi-Token Prediction: Training LLMs to See Further Than One Token"
date: 2026-07-20
tags: [llm-training, multi-token-prediction, speculative-decoding, transformers, inference]
excerpt: "Next-token prediction is a strangely myopic objective: at every position the model is graded on exactly one token and told nothing about the future it is steering toward. Multi-token prediction asks the model to forecast several tokens at once. It costs almost nothing at training time, makes larger models measurably better at code and reasoning, and hands you a 3x inference speedup for free through self-speculative decoding — which is why DeepSeek-V3 bakes it into pretraining."
---

Every autoregressive language model is trained on the same loss: given the tokens so far, predict the next one. `p(x) = ∏ p(xₜ | x₁…xₜ₋₁)`. It is elegant, it is what makes teacher forcing work, and it has one quietly strange property — at each position the model is optimized against exactly **one** future token. The signal about where the sentence is *going* three or four tokens out never enters the gradient directly. The model has to infer long-range structure purely as a side effect of getting each single step right.

[Multi-token prediction](https://arxiv.org/abs/2404.19737) (Gloeckle et al., ICML 2024) proposes a small change with outsized consequences: at every position, predict the next **n** tokens at once, using n output heads that share a single transformer trunk. The training cost is nearly free, the quality gains grow with model size, and the extra heads turn out to be a built-in drafting model — giving you self-speculative decoding without a second network. DeepSeek-V3 adopted a causal variant of the idea into its pretraining, which is the clearest signal that this is production technique, not a curiosity.

## The objective

Standard training minimizes the cross-entropy of the next token given a shared latent `zₜ = f_trunk(x₁…xₜ)`:

```
L₁ = − Σₜ log P(xₜ₊₁ | zₜ)
```

Multi-token prediction extends the target from one token to a window of n:

```
Lₙ = − Σₜ Σₖ₌₁ⁿ log Pₖ(xₜ₊ₖ | zₜ)
```

The key architectural constraint is that all n predictions are conditioned on the **same** trunk output `zₜ`. You do not run the model n times. A single forward pass produces `zₜ`, and then n independent heads `h₁…hₙ` each map that shared representation to a distribution over a different future position:

```
Pₖ(xₜ₊ₖ | zₜ) = softmax(Wᵤ · hₖ(zₜ))
```

Each head `hₖ` is typically a single transformer block (or even just an unembedding matrix); the shared unembedding `Wᵤ` is reused across heads. Because the heads are independent given `zₜ`, they factorize the joint over the window — they do **not** model `p(xₜ₊₂ | xₜ₊₁)`. That independence is exactly what makes parallel training cheap, and it is also the assumption DeepSeek-V3 later relaxes.

## Why it helps at all

The intuition the authors offer is about *choice points*. In a long generation, most tokens are locally determined — once you have written "for the" the next token is nearly forced. But a handful of tokens are pivotal: the variable name, the branch condition, the theorem you are about to invoke. Next-token loss weights every position equally, so it spends most of its gradient budget on tokens that were never in doubt. By forcing the model to also commit to tokens two, three, and four steps out, MTP concentrates learning pressure on getting the *trajectory* right, not just the next character. It is a form of implicit look-ahead baked into the objective.

Empirically the effect is strongly scale-dependent. On small models MTP can slightly hurt; the extra heads compete for a trunk that is too small to serve them. But the gains grow with parameter count — the 13B models in the paper solve several percent more problems on MBPP and HumanEval than next-token baselines trained on identical data. Coding benefits most, which fits the choice-point story: code has sharp, unforgiving structure where a single wrong token derails the rest of the line.

## The memory problem, and the trick that solves it

Here is the part that matters if you ever implement it. The naive way to compute `Lₙ` is: run the trunk, then for each head produce its logits, stack them, and backpropagate. The trouble is the logit tensor. For sequence length `s`, batch `b`, and vocabulary `V`, one head's logits are `b × s × V` floats. With `V ≈ 100k`, that single tensor dwarfs everything else in the model. Materializing **n** of them at once multiplies your peak activation memory by n and blows up the GPU.

The fix is to never hold more than one head's logits in memory at a time. Order the forward and backward passes carefully:

```python
# z: shared trunk output, [b, s, d]. Requires grad so head grads flow back into the trunk.
z = trunk(x)                      # one forward pass, kept in memory
z.retain_grad()

total_loss = 0.0
for k in range(1, n + 1):
    logits_k = unembed(heads[k](z))          # [b, s, V] — the memory hog
    loss_k = cross_entropy(logits_k, shift(x, k))
    loss_k.backward(retain_graph=True)       # grad accumulates into z.grad, then...
    # logits_k and head_k's activation graph are freed here, before the next head
    total_loss += loss_k.detach()

# z.grad now holds the summed gradient from all n heads; finish the trunk backward once.
z.backward(gradient=z.grad)
```

The trick is `loss_k.backward()` inside the loop with `retain_graph=True` on the *trunk* only. Each head's giant logit tensor is allocated, contributes its gradient to `z.grad`, and is immediately freed before the next head runs. Peak memory is one head's logits, not n. The trunk's own (expensive) backward pass runs exactly once, after all heads have deposited their gradients into `z.grad`. This is what lets you set n = 4 with essentially the same GPU footprint as ordinary training — the whole scheme is free precisely because the heads are cheap and their memory is transient.

## The free lunch: self-speculative decoding

The reason to care about MTP even if you do not believe the quality story is inference speed. A model trained with MTP already has heads that predict tokens `t+1, t+2, t+3, t+4` from a single forward pass. That is exactly the shape of a [speculative decoding](https://arxiv.org/abs/2211.17192) draft — except you do not need a separate draft model. The model drafts against itself.

The loop:

1. One forward pass produces the shared `zₜ`. Head 1 gives the committed next token; heads 2…n propose the following n−1 tokens as a draft.
2. Feed the drafted continuation back through the model in a single batched forward pass and check, position by position, whether head 1 would have produced the same tokens.
3. Accept the longest correct prefix of the draft; on the first mismatch, take head 1's token there and discard the rest.

Because acceptance is verified by the model's own primary head, the output distribution is **identical** to plain greedy/sampled next-token decoding — this is exact speculation, not an approximation. Every accepted draft token is a forward pass you did not have to run sequentially. The paper reports roughly **3x** faster generation with n = 4 on code, where the drafts are easy to predict and acceptance rates are high.

## DeepSeek-V3's causal variant

The parallel-heads formulation has one theoretical weakness: the heads are conditionally independent given `zₜ`, so they cannot model dependencies *within* the predicted window. If head 2 and head 3 disagree about a name they both just introduced, nothing in the objective couples them.

DeepSeek-V3 keeps the causal chain instead. Rather than n independent heads reading the same trunk output, it stacks MTP **modules** sequentially: module k takes the representation from module k−1, combines it with the embedding of the (already predicted) token at that depth, and predicts the next one — preserving the causal ordering `p(xₜ₊₂ | xₜ₊₁, zₜ)` the parallel version threw away. In pretraining DeepSeek used a modest depth (one extra predicted token) as an auxiliary loss that improved the main model, then reused the MTP module at inference for speculative decoding. The V3 report notes a token acceptance rate around 85–90% for the second token — high enough to make the speculative path a real latency win.

## When to reach for it

MTP is a pretraining-time decision, so it is not something you bolt onto an existing checkpoint. It earns its place when: you are training a model large enough (billions of parameters) that the extra heads do not starve the trunk; your workload is generation-heavy and latency-sensitive, so the self-speculative payoff compounds; and code or other sharply structured output is a first-class target. The cost is a handful of extra parameters and the memory-ordering discipline above. The return is a model that is both a little smarter about where it is going and several times faster at getting there — which is a rare direction for a tradeoff to point.
