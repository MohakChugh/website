---
title: "Asynchronous RL for Reasoning Models: How Decoupling Rollout from Training Breaks PPO's Math"
date: 2026-08-04
tags: [reinforcement-learning, llm-training, distributed-systems, gpu-scheduling, ml-systems]
excerpt: "Synchronous RL post-training wastes most of its inference fleet waiting on the single longest reasoning trace in each batch. Decoupling generation from training recovers that idle time, but it quietly invalidates the assumption PPO's importance ratio is built on, and naive async training drops AIME24 accuracy from 42.0 to 23.3. AReaL fixes the schedule and the objective together."
---

Reinforcement learning on reasoning traces has an ugly scheduling property that nobody designed and everybody inherits: the wall-clock cost of a training step is set by the single longest sample in the batch.

That falls straight out of how synchronous RL post-training works. Generate a batch of rollouts, score them, compute advantages, update the policy, push new weights, repeat. Every rollout must come from the same policy version, because that is what the PPO objective assumes, so the step blocks until the last trace finishes decoding.

For instruction tuning, where responses run a few hundred tokens, this is a rounding error. For reasoning models emitting chains of thought up to a 32k cap, it dominates everything.

## Measuring the straggler

Reasoning-trace lengths are heavy-tailed: most problems resolve in a few hundred tokens, a minority spiral until they hit the cap. Sampling that as a truncated lognormal and packing rollouts onto decode slots:

```python
CAP = 32768
def sample_len():
    return min(CAP, int(random.lognormvariate(7.4, 1.15)))   # median ~1.6k tokens

def sync_epoch(batch, n_slots):
    lens = [sample_len() for _ in range(batch)]
    slots = [0] * n_slots
    for L in sorted(lens, reverse=True):          # LPT packing, generous to the baseline
        i = slots.index(min(slots)); slots[i] += L
    return max(slots), sum(lens)                  # wall time is the slowest slot
```

Over 400 epochs of 512 rollouts on 128 decode slots:

```
median trace length      :     1638 tok
mean longest-in-batch    :    32437 tok  (19.8x the median)
P(batch contains a 32k trace) = 92%
slot utilization         :    38.1%      (idle 61.9%)
headroom from decoupling :     2.62x
```

This is the *optimistic* baseline: I gave the scheduler longest-processing-time-first packing and advance knowledge of trace lengths, which no real system has, since you cannot know a trace's length until you have generated it. Even so, 62 percent of decode capacity sits idle and nearly every batch contains a trace running to the cap. Remove the barrier and roughly 2.6× is on the table.

## The obvious fix, and the non-obvious cost

AReaL (Fu, Gao, Shen et al., [arXiv:2505.24298](https://arxiv.org/abs/2505.24298), last revised March 2026) takes the direct route: decouple generation from training onto separate GPU pools. Rollout workers generate continuously and never wait. Trainer workers pull from a replay buffer and update as soon as a batch has accumulated. A rollout controller brokers between them; a parameter service ships new weights. Two design details matter more than the architecture diagram.

**Rollout workers are interruptible.** When new weights arrive, the worker does not finish its in-flight sequences. It halts them, discards KV cache computed under the old weights, recomputes the prefix under the new weights, and resumes decoding. Discarding KV cache sounds wasteful, but the alternative is a long trace pinning a worker to stale parameters for minutes.

**The device split is lopsided** — three quarters of GPUs to inference, one quarter to training, chosen empirically over 50/50. The scaling reason matters: synchronous systems spread generation across *all* devices, shrinking the per-GPU decode batch and pushing decoding into the memory-bandwidth-bound regime where adding GPUs stops helping. A dedicated generation pool keeps batches large enough to stay compute-bound.

Now the cost. Standard PPO maximizes

```
J(θ) = E[ min( r_t(θ) · Â_t,  clip(r_t(θ), 1-ε, 1+ε) · Â_t ) ]
       where r_t(θ) = π_θ(a_t|s_t) / π_old(a_t|s_t)
```

That ratio has a single `π_old` in the denominator: every token in the batch is assumed to come from one behavior policy. Asynchronous execution violates this twice over. **Across trajectories**, a batch holds rollouts from several past policy versions. **Within a single trajectory**, interruptible generation means tokens 1–400 came from version *i*, tokens 401–900 from version *i+1*, and so on.

You cannot paper over the second one. It is not that the estimator gets noisier; the denominator does not refer to anything.

## What ignoring it costs

The ablation is unusually clean because there is a natural oracle: staleness η = 0 reduces exactly to synchronous RL. Training a 1.5B reasoning model on math, varying maximum permitted staleness η, with and without the objective fix:

| Max staleness η | AIME24 (naive PPO) | AIME24 (decoupled) |
|---|---|---|
| 0 (oracle) | 42.0 | 42.0 |
| 1 | 41.8 | 42.1 |
| 2 | 40.0 | 41.8 |
| 4 | **23.3** | 42.2 |
| 8 | 35.7 | 41.0 |
| 16 | 35.8 | 38.7 |
| ∞ | 34.0 | 36.9 |

At η = 4, naive PPO loses 19 points of AIME24 accuracy — a collapse, not a degradation. The non-monotonicity between η = 4 and η = 8 is the tell: with the objective broken, the failure is unstable rather than a smooth staleness penalty, which is what you expect from a badly-centered trust region rather than a distribution-shift effect. With the decoupled objective, η ≤ 8 costs about a point.

## The fix: two policies, not one

AReaL adopts a decoupled objective (from Hilton et al.'s earlier work on batch-level RL) that splits the single `π_old` into the two roles it was overloading: **π_behav**, the policy that actually sampled the tokens, used for importance correction; and **π_prox**, a recent high-quality policy, used as the trust-region center. Applying importance sampling with respect to `π_prox` gives

```
J(θ) = E[ (π_prox/π_behav) · min( u_t(θ)·Â_t, clip(u_t(θ), 1-ε, 1+ε)·Â_t ) ]
       where u_t(θ) = π_θ(a_t|s_t) / π_prox(a_t|s_t)
```

The `π_prox/π_behav` prefactor corrects the distribution mismatch; the clipping is centered on `π_prox`. That separation is the whole point. Under naive PPO, clipping is centered on the *old* policy, so the update is regularized toward stale, lower-quality parameters — pulling the model backward toward whatever it was several versions ago. Centering the trust region on a recent policy lets the correction handle staleness while the regularization still points somewhere good.

The implementation is deliberately cheap: rather than an EMA of parameters for `π_prox`, AReaL uses the weights from immediately before the current update, recomputing token log-probabilities once when the global batch arrives.

The formal payoff is Proposition 1: for a sequence whose segments were produced by policies π_θ … π_{θ+k}, there exists a single behavior policy π_behav under which the interrupted generation is equivalent to sampling end-to-end. Mixed-version trajectories become legal inputs rather than a violated precondition. The algorithm change is what *licenses* the systems change.

Staleness is still bounded. The rollout controller rate-limits generation to enforce

```
floor((N_r - 1) / B) <= i + η
```

for policy version *i*, total generated trajectories *N_r*, and batch size *B*, rejecting violating requests and prioritizing older trajectories when assembling batches. Note the direction of the recommendation: the paper argues for a *large* η, because a tight bound throttles generation whenever a few very long traces are in flight. Bound staleness loosely and let the objective absorb it.

Throughput confirms the trade. Effective throughput climbs from 128.7k tokens/s at η = 0 to 269.3k at η = 1 (2.09×) and 356.6k at η = 2 (2.77×), then flattens — 382.4k at η = 16 is only 2.97×. Nearly all the win is in the first two steps away from synchronous. Combined with the accuracy table, η between 2 and 8 is where both curves are flat.

## End to end

On an H800 cluster, against synchronous baselines at matched GPU count and PPO step count:

| Model | Sync hours | AReaL hours | Speedup | Score (sync → async) |
|---|---|---|---|---|
| 1.5B (math) | 41.0 | 14.8 | 2.77× | 42.0 → 42.2 |
| 7B (math) | 57.7 | 25.4 | 2.27× | 63.0 → 63.1 |
| 14B (code) | 48.8 | 21.9 | 2.23× | 56.7 → 58.1 |
| 32B (code) | 51.1 | 31.1 | 1.64× | 61.2 → 61.0 |

The headline 2.77× is the best case, not the typical one; the speedup decays with scale to 1.64× at 32B. Two supporting optimizations contribute independently: dynamic micro-batch allocation under a token budget (33.7 percent mean throughput gain, ranging from 17 to 43 percent) and interruptible generation itself (12 percent at 1.5B, 17 percent at 7B). Strong scaling is roughly linear where the synchronous baseline flattens or OOMs outright at 32k context.

## The transferable part

The technique is narrow. The pattern is not. The barrier in synchronous RL was never about correctness of the *data*; it enforced an undocumented invariant of the loss function. The scheduler and the objective were coupled through an assumption neither side had written down, and the coupling only became visible when the scheduler changed.

If you are pipelining, batching asynchronously, or replaying anywhere near a policy-gradient update, the question is not "how stale is my data" but "what does my objective assume about *where* the data came from, and does my execution model still guarantee it?" Staleness you can bound with a counter. A denominator that no longer refers to anything is a different class of bug — and as the 42.0 → 23.3 drop shows, it does not announce itself as a crash. It announces itself as a model that trains fine and is quietly much worse.
