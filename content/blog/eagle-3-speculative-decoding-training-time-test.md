---
title: "EAGLE-3: Why the Best Draft Models Stopped Predicting Features"
date: "2026-07-06"
tags: ["llm-inference", "speculative-decoding", "performance", "ml-systems"]
excerpt: "EAGLE-3 gets up to 6.5x decoding speedup by abandoning the feature-prediction objective that defined its predecessors. The interesting part is why feature prediction became the bottleneck, and how a trick called training-time test fixes the train/inference mismatch it leaves behind."
---

Speculative decoding is the closest thing LLM inference has to a free lunch: a small draft model proposes several tokens cheaply, the large target model verifies them in a single forward pass, and rejection sampling guarantees the output distribution is exactly what the target model would have produced alone. No quality loss, just fewer sequential passes through the big model.

The EAGLE family has been the strongest open lineage of draft models for two years. EAGLE-3 ([arXiv:2503.01840](https://arxiv.org/abs/2503.01840), Li et al.) is worth studying not because it is faster, though it is, up to 6.5x over vanilla decoding and about 1.4x over EAGLE-2, but because it *reverses* the core design decision of EAGLE-1 and EAGLE-2. The story of why is a nice case study in how a training objective that helps at small scale can become a ceiling at large scale.

## The feature-prediction era

EAGLE-1's insight was that autoregressing in *feature space* is easier than autoregressing in token space. Instead of training a tiny transformer to predict the next token directly, EAGLE trained it to predict the target model's top-layer hidden state (the feature vector just before the LM head), then reused the target model's own LM head to turn that predicted feature into a token distribution.

```text
EAGLE-1/2 draft step:
  input:  target's top-layer feature f_t  +  sampled token t_t
  output: predicted feature f̂_{t+1}
  token:  softmax(LM_head(f̂_{t+1}))

loss = L_feature(f̂, f)  +  L_token(p̂, p)
```

This worked because top-layer features are less noisy than sampled tokens; regressing them gives the draft model a dense supervision signal. With a draft model that is roughly 1% of the target's parameters, EAGLE-2 hit 3 to 4x speedups.

But the authors noticed something uncomfortable when they scaled training data: EAGLE's acceptance rate barely improved. More data, flat curve. The feature-regression loss was acting as a straitjacket. The draft model was spending capacity trying to reconstruct the target's exact hidden states, a much harder and stricter task than "predict a token the target would accept." A distribution can be right while the feature vector is off in a hundred irrelevant dimensions, and the L1 feature loss punishes that anyway.

## What EAGLE-3 changes

Two coupled changes, each of which forces the other.

**1. Drop feature prediction, predict tokens directly.** The draft model is now trained with only the token-level cross-entropy against the target's distribution. Freed from feature reconstruction, the draft model's loss keeps improving as training data scales. This is the headline result: EAGLE-3 exhibits the data-scaling behavior that EAGLE-1/2 lacked.

**2. Fuse features from multiple target layers.** If you no longer force the draft's hidden state to imitate the target's top layer, you can stop feeding it only the top layer. EAGLE-3 concatenates hidden states from low, middle, and high layers of the target model and projects them down:

```python
# Conceptually, per position:
g_t = W_proj @ concat(h_low[t], h_mid[t], h_high[t])  # fused feature
# draft input at position t: [g_t ; embed(token_t)]
```

This matters because the top layer of an LLM is specialized for predicting *the next token*, and it discards information useful for predicting the token after that. Middle layers carry more general semantics. A draft model that has to propose 4 to 8 tokens ahead benefits from that broader signal. Prior work on early-exit and layer-probing had already hinted that next-next-token information lives in intermediate layers; EAGLE-3 operationalizes it.

## The problem this creates, and training-time test

Here is the subtle part. During inference, the draft model runs autoregressively for several steps *between* target-model calls. At draft step 1, it consumes the fused feature `g_t` computed from the target's real forward pass. But at draft step 2, there is no target forward pass, and no fresh fused feature. The draft must consume *its own previous hidden state* instead.

EAGLE-1/2 dodged this by construction: the draft was trained to predict target features, so its own output was (approximately) the same kind of object as its input. Once EAGLE-3 stops predicting features, the draft's hidden state at step k is a different beast from the fused feature it saw at step 1. Train it only on step-1-style inputs and it faces out-of-distribution inputs at every subsequent draft step. This is textbook exposure bias.

The fix, which the authors call **training-time test**, is to simulate the multi-step drafting procedure inside the training loop:

```python
# Simplified training-time test loop
g = fuse(target_layers(x))          # step 1 input: real fused features
state = g
for k in range(draft_depth):
    out, state = draft_model(state, tokens[k])   # reuse own state, like inference
    loss += cross_entropy(out, target_dist[k+1])
    # Requires a specialized attention mask so position t at draft
    # step k attends to the right mix of real and self-generated states
```

Instead of teacher-forcing every step with ground-truth features, the draft model is unrolled during training exactly as it will be unrolled at inference, consuming its own hidden states for steps 2 through k. The specialized attention mask lets this happen in parallel across positions rather than as a slow sequential loop, which keeps training cost manageable. If you have seen scheduled sampling or DAgger in the imitation-learning literature, this is the same medicine applied to draft models: close the train/inference distribution gap by training on the states the policy actually visits.

## Why the batch-size result matters most

The 6.5x single-request speedup gets the headline, but the more operationally interesting number is the **1.38x throughput improvement at batch size 64** in SGLang.

Conventional wisdom said speculative decoding is a low-batch trick. Verification of k draft tokens costs roughly k times the FLOPs of decoding one token, and at high batch sizes the GPU is already compute-bound, so those extra FLOPs displace real work. Most production serving stacks therefore disabled speculation beyond small batch sizes.

EAGLE-3 shifts that tradeoff by raising the acceptance length. If the target model accepts, say, 5 tokens per verification pass instead of 3, the FLOP overhead per *accepted* token drops enough that speculation stays profitable even when compute-bound. Higher acceptance rates do not just reduce latency; they move the batch-size threshold where speculation stops paying for itself. That is what turns speculative decoding from a chatbot-latency optimization into something you can leave enabled on a saturated inference fleet.

## Takeaways for systems people

- **Auxiliary losses that help at small scale can cap large-scale performance.** Feature regression was scaffolding; EAGLE-3's gain came from knowing when to remove it.
- **Exposure bias appears anywhere a model consumes its own outputs.** If your inference procedure unrolls a model on self-generated state, your training procedure should too. Training-time test is a general pattern, not an EAGLE-specific hack.
- **Read intermediate layers.** The top layer of a transformer is an interface optimized for one task. If your downstream consumer needs different information, tap the residual stream earlier.
- **Evaluate speculation at your real batch sizes.** Acceptance rate, not raw draft speed, determines whether speculation survives contact with a compute-bound serving fleet.

EAGLE-3 ships in vLLM and SGLang, and the reference implementation is at [SafeAILab/EAGLE](https://github.com/SafeAILab/EAGLE). If you run open-weight models in production and have not benchmarked it against your traffic, it is one of the cheaper 30 to 40% throughput wins currently available.
