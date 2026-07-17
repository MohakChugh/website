---
title: "GRPO: Critic-Free Reinforcement Learning for Reasoning Models"
date: "2026-07-17"
tags: ["reinforcement-learning", "llm-training", "reasoning", "rlhf", "post-training"]
excerpt: "Group Relative Policy Optimization deletes PPO's value network and estimates the advantage baseline from a group of sampled completions. This is the algorithm behind DeepSeek-R1's reasoning. Here is the math, the memory argument, and the sharp edges."
---

Reinforcement learning from human feedback made the critic network the quiet cost center of LLM post-training. PPO, the workhorse of RLHF since InstructGPT, keeps two large models resident and training simultaneously: the policy you actually want, and a value network of comparable size whose only job is to predict expected return so you can compute an advantage. For a 70B policy, that critic is another 70B of parameters, optimizer state, and gradients competing for the same GPUs.

Group Relative Policy Optimization (GRPO), introduced in DeepSeekMath and made famous as the engine behind DeepSeek-R1's reasoning, asks a blunt question: do we need the critic at all? For tasks with a checkable answer — math, code, formal proofs — the answer turns out to be no. You can estimate the advantage baseline empirically by sampling a *group* of completions for the same prompt and comparing each against the group's own average. The critic disappears, and with it roughly half the training-time memory footprint.

This is not a minor tweak. It reframes advantage estimation from a *learned* quantity to a *Monte Carlo* one, and that reframing is what made pure-RL reasoning training practical at scale.

## Why PPO needs a critic, and why that hurts

PPO maximizes a clipped surrogate objective driven by an advantage estimate `Â_t` — how much better action `a_t` was than the policy's average behavior in that state. The standard way to get `Â_t` is Generalized Advantage Estimation, which needs a value function `V_ψ(s_t)` predicting expected future reward from state `s_t`.

Two problems compound in the LLM setting:

1. **The critic is expensive.** `V_ψ` is typically a separate transformer of comparable size to the policy. You pay for its forward pass, backward pass, optimizer state, and the engineering to keep it stable.
2. **The reward is terminal.** In RLHF the reward model usually scores only the *final* token of a completion. Training a per-token value function that has to bootstrap a credit signal backward across thousands of tokens from a single terminal reward is genuinely hard, and a bad critic injects bias into every gradient step.

So you are paying full price for a second large model that is structurally difficult to fit well. GRPO's insight is that if you are going to sample from the policy anyway, the samples themselves contain a baseline.

## The group-relative baseline

For each prompt `q`, GRPO samples a group of `G` completions `{o_1, ..., o_G}` from the current policy `π_θ_old`. Each completion gets a scalar reward `r_i`. The advantage for a completion is simply how far its reward sits from the group mean, in units of the group's standard deviation:

```
Â_i = (r_i - mean(r_1..r_G)) / std(r_1..r_G)
```

Every token in completion `o_i` receives this same normalized advantage `Â_{i,t} = Â_i` (for outcome supervision). That is the whole baseline. No value network, no GAE, no bootstrapping. The group average *is* the baseline, and the group standard deviation gives you free reward whitening — which stabilizes the gradient scale across prompts of wildly different difficulty.

The intuition maps cleanly onto how reward models are actually trained: they learn from *comparisons* among outputs to the same prompt, so comparing outputs to the same prompt at RL time is a natural fit rather than an approximation.

## The objective

The full GRPO objective keeps PPO's clipped importance-sampling ratio but averages over the group and moves the KL penalty out of the reward and directly into the loss:

```
J_GRPO(θ) = E[ q ~ P(Q), {o_i} ~ π_θ_old(·|q) ]

  (1/G) Σ_i (1/|o_i|) Σ_t {
     min[ ρ_{i,t} Â_{i,t},  clip(ρ_{i,t}, 1-ε, 1+ε) Â_{i,t} ]
     - β · D_KL[π_θ || π_ref]
  }

where  ρ_{i,t} = π_θ(o_{i,t} | q, o_{i,<t}) / π_θ_old(o_{i,t} | q, o_{i,<t})
```

Two details matter for anyone implementing this:

- **The KL term is in the loss, not the reward.** Classic RLHF folds a per-token KL-to-reference penalty into the reward signal, which then flows through the advantage. GRPO adds `β·D_KL` directly as a loss term. This keeps the advantage a pure task signal and makes the regularization gradient explicit and separable.
- **The KL uses the k3 estimator, not the naive log-ratio.** GRPO uses an unbiased, always-positive estimator (Schulman's k3):

```
D_KL[π_θ || π_ref] ≈ (π_ref/π_θ) - log(π_ref/π_θ) - 1
```

Because `x - log(x) - 1 ≥ 0` for all `x > 0`, this estimator is guaranteed non-negative — unlike the raw `log(π_θ/π_ref)` sample, which has high variance and can flip sign, destabilizing training. It costs one extra forward pass through the frozen reference model per token, which you were already paying for RLHF anyway.

## A minimal implementation sketch

The loss, once you have sampled completions and their rewards, is compact. This is the core of a training step in PyTorch-flavored pseudocode:

```python
def grpo_loss(logp_new, logp_old, logp_ref, rewards, group_sizes,
              eps=0.2, beta=0.04):
    # logp_*: [total_tokens] token log-probs under new / old / ref policies
    # rewards: [num_completions] one scalar per sampled completion
    # group_sizes: how many completions belong to each prompt

    # 1. Group-relative advantage: normalize rewards within each prompt group
    advantages = torch.empty_like(rewards)
    start = 0
    for g in group_sizes:
        r = rewards[start:start + g]
        advantages[start:start + g] = (r - r.mean()) / (r.std() + 1e-8)
        start += g
    # broadcast each completion's advantage to all of its tokens
    adv_tok = advantages.repeat_interleave(tokens_per_completion)  # [total_tokens]

    # 2. Clipped surrogate (importance ratio in log space for stability)
    ratio = torch.exp(logp_new - logp_old)
    unclipped = ratio * adv_tok
    clipped = torch.clamp(ratio, 1 - eps, 1 + eps) * adv_tok
    policy_term = torch.min(unclipped, clipped)

    # 3. Unbiased, non-negative KL to reference (k3 estimator)
    log_r = logp_ref - logp_new
    kl = torch.exp(log_r) - log_r - 1.0

    # 4. Maximize surrogate, minimize KL  ->  minimize the negative
    return -(policy_term - beta * kl).mean()
```

The striking part is what is *absent*: no value network forward pass, no GAE recursion over discounted returns, no separate critic optimizer. The "baseline" is three lines of reward normalization.

## Pure RL reasoning: what R1-Zero showed

The reason this matters beyond a memory saving is that GRPO made *pure* RL reasoning viable. DeepSeek-R1-Zero was trained with GRPO directly on a base model with no supervised fine-tuning demonstrations at all. The rewards were deliberately simple and *rule-based* rather than learned:

- **Accuracy reward** — for math, does the boxed final answer match ground truth? For code, does it pass the unit tests? This is a deterministic checker, not a neural reward model, so there is nothing to reward-hack.
- **Format reward** — did the model wrap its reasoning in the expected `<think>...</think>` tags before answering?

From that spartan signal, long chain-of-thought, self-verification, and backtracking *emerged* — the model learned to spend more tokens reasoning because longer, self-checking traces scored higher on the accuracy reward. No one supervised the reasoning format into existence; GRPO's group comparison rewarded whatever completions happened to be correct, and the correct ones increasingly looked like careful reasoning.

Using a rule-based checker as the reward is what closes the loop. A learned reward model is itself a large network *and* a hackable target; a deterministic verifier is free to run and impossible to fool. GRPO's critic-free design plus verifiable rewards means the *only* large model in the training loop is the policy and its frozen reference.

## Sharp edges

GRPO is not free of trade-offs, and later work has poked at each:

- **Group size is a variance knob.** Small `G` (say 4-8) makes the mean/std estimates noisy, and the std normalization can blow up when all completions in a group get identical rewards (every answer wrong, or every answer right — the `1e-8` epsilon is load-bearing). Larger `G` reduces variance but multiplies sampling cost linearly.
- **Length bias.** Because the objective averages per-token then per-completion, and advantages are constant across a completion's tokens, several groups have reported subtle biases toward longer or shorter outputs depending on how the length normalization is arranged. Variants like Dr. GRPO adjust the normalization to remove it.
- **All-correct / all-wrong groups contribute no signal.** If every completion in a group ties, the advantages are all zero and that prompt wastes a sampling budget. Curriculum and difficulty-filtering the prompt distribution helps keep groups informative.

None of these undo the central bargain. By replacing a learned value function with a Monte Carlo baseline computed from samples you were already drawing, GRPO removes the single most expensive and finickiest component of PPO-style RLHF. For any task where correctness is checkable, that is close to a free lunch — and it is why critic-free, group-relative RL is now the default recipe for training reasoning models.
