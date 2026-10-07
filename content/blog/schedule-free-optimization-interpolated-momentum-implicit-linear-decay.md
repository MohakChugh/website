---
title: "Schedule-Free Optimization: The Uniform Average Is a Linear-Decay Schedule in Disguise, and Why the Learning Rate Still Knows Your Horizon"
date: 2026-10-07
tags: ["optimization", "deep-learning", "llm-training", "sgd", "learning-rate-schedules"]
excerpt: "Schedule-Free SGD/AdamW (Defazio et al., NeurIPS 2024) won the AlgoPerf self-tuning track with no learning-rate schedule. I prove in four lines, and check numerically to 4e-15, that its averaged iterate is exactly a linear-decay-to-zero run whose gradients are sampled at an interpolated point. That reframes β as 'where on the decay curve you take gradients'. My sims: on a noisy quadratic, β=0 is the only setting whose tuned LR is the same at every horizon. On a nonconvex MLP, β=0.9 beats Polyak averaging but a tuned linear decay still wins by about 10%, and every method's best LR shrinks about 4x per 4x more steps."
---

# Schedule-Free Optimization: The Uniform Average Is a Linear-Decay Schedule in Disguise

Every cosine or linear-decay schedule hard-codes the horizon `T`: stop early and you never decayed; train longer and you need a new run. *The Road Less Scheduled* (Defazio, Yang, Mehta, Mishchenko, Khaled, Cutkosky; arXiv:2405.15682, NeurIPS 2024) removes the schedule entirely. Schedule-Free AdamW won the MLCommons 2024 AlgoPerf self-tuning track. Here is what it actually computes (a schedule, after all) and what my simulations say about the "free" part.

## Three sequences

Schedule-Free SGD keeps a base iterate `z`, an average `x`, and a gradient point `y`:

```text
y_t     = (1 − β) z_t + β x_t            # where gradients are evaluated
z_{t+1} = z_t − γ ∇f(y_t, ζ_t)           # plain SGD, constant step
x_{t+1} = (1 − c_{t+1}) x_t + c_{t+1} z_{t+1},   c_{t+1} = 1/(t+1)
```

With `c = 1/(t+1)`, `x` is the equal-weight running mean of every `z`. You evaluate and ship `x`. β interpolates between two classical methods. At β = 0 it is **Polyak–Ruppert averaging**: gradients are taken at `z`, and `x` is a passive post-hoc mean. At β = 1 it is **primal averaging**: gradients are taken at the average itself. On IWSLT14 (LSTM) neither endpoint suffices: test loss 4.35 Polyak, 4.44 primal, 4.23 tuned cosine, 4.18 Schedule-Free at β = 0.9.

## The average is a linear-decay schedule

Unroll `z`: `z_t = z_1 − γ Σ_{s<t} g_s`. Average `T` of them:

```text
x_T = (1/T) Σ_{t=1..T} z_t = z_1 − γ Σ_{s=1..T−1} ((T − s)/T) · g_s
```

That is exactly the final iterate of SGD with a **linear-decay-to-zero schedule** `γ·(1 − s/T)`, and it holds for every `T` at once. Uniform averaging doesn't replace the schedule. It applies the schedule retroactively at whatever horizon you stop. I checked the identity numerically on 500 noisy steps (with the indexing shifted by one for `c = 1/(t+1)`):

```python
z = x = x0.copy(); acc = np.zeros(d)
for t in range(1, T + 1):
    y = (1 - b) * z + b * x
    g = grad(y, rng)
    acc += (T + 1 - t) / (T + 1) * g     # linear-decay weight
    z = z - lr * g
    c = 1 / (t + 1); x = (1 - c) * x + c * z
assert np.max(np.abs(x - (x0 - lr * acc))) < 1e-12   # observed: 3.8e-15
```

The one thing averaging can't fake is *where the gradients were taken*. A real linear-decay run with horizon `T` takes gradient `s` at an iterate that has only been decayed by `(1 − r/T)`, which is barely decayed early in training. Under that lens, β picks the evaluation point:

- **β = 0** samples gradients at `z`, a constant-LR iterate that is never decayed. It is aggressive and noisy, which is fine for convex problems but loose for nonconvex ones.
- **β = 1** samples at `x`, which is already "decayed to horizon `t`" at every step. It is too conservative, which is why primal averaging is slow.
- **β = 0.9** samples in between. The paper describes it as momentum: a gradient enters `y` immediately with weight `1 − β = 0.1`, and the remaining 0.9 is added slowly through `x`. An EMA with β = 0.9 instead incorporates most of the gradient within about 10 steps.

## The guarantee and its fine print

Theorem 1 holds for convex, G-Lipschitz `f`, `D = ‖x_1 − x*‖`, and **any β ∈ [0, 1]**: `E[F(x_T) − F*] ≤ DG/√T`. That is the optimal worst-case non-smooth rate, including constants. EMA momentum, by contrast, can *worsen* the worst-case non-smooth rate. The proof is an online-to-batch conversion (Theorem 2): any online learner with regret `R_T` driving `z` yields `F(x_T) − F* ≤ R_T / Σw`, which is why the wrapper works around Adam. Read the step size in the theorem carefully, though: `γ = D/(G√T)`. **The horizon has moved from the schedule into the learning rate.** The paper acknowledges this ("a similar mild time-horizon dependency for the baseline learning rate value as schedule-based approaches"), and my numbers below show how much of it remains.

## Schedule-Free AdamW in practice

Algorithm 1 of the paper, written as a single PyTorch-style step:

```python
@torch.no_grad()
def sf_adamw_step(p, z, v, state, lr, b1=0.9, b2=0.999, wd=0.0, warmup=2000, eps=1e-8):
    # p.data holds y during training; z is the extra buffer (same memory as SGD+momentum)
    t = state["t"] = state["t"] + 1
    g = p.grad
    v.mul_(b2).addcmul_(g, g, value=1 - b2)
    lr_t = lr * math.sqrt(1 - b2**t) * min(1.0, t / warmup)  # warmup + Adam bias-correction
    state["w_sum"] += lr_t**2
    c = lr_t**2 / state["w_sum"]                    # c_{t+1} = γ_t² / Σ γ_i²
    y = p.data
    x = (y - (1 - b1) * z) / b1                     # recover x from y and z
    z.addcdiv_(g, v.sqrt().add_(eps), value=-lr_t).sub_(y, alpha=lr_t * wd)  # decay at y
    x.lerp_(z, c)                                   # x_{t+1}
    p.data.copy_((1 - b1) * z + b1 * x)             # next gradient point y_{t+1}
```

Practical details:

- **Warmup is still required.** During warmup, the average is weighted by `γ_t²`, so tiny-LR early iterates don't anchor `x`. After warmup this decays like 1/t.
- **Memory.** You store `z` and either `y` or `x` in the parameter buffer and recover the third (`x = (y − (1−β)z)/β`). The reference implementation flips the buffer between `y` and `x` with `optimizer.train()` / `optimizer.eval()`. Forgetting `eval()` before validation or checkpointing silently evaluates `y`.
- **BatchNorm** statistics were collected at `y`; recompute them at `x` with a few forward passes before eval. LayerNorm/RMSNorm are unaffected.
- **Weight decay at `y`** beat decay at `z` on ImageNet and NanoGPT.
- On ResNet-50, the best β stayed at 0.9 across training lengths, with 77.78% accuracy at β = 0.9 versus 75.37% at β = 0.98. The best LR is larger than for SGD: 1.5 versus about 0.1.

A NeurIPS 2025 follow-up (Song et al., arXiv:2507.09846) analyzes SF-AdamW through the "river valley" view of LLM loss landscapes and proposes a variant more robust to momentum and large batches, the original's two known weak spots.

## What my simulations show

Two numpy testbeds, LR grid-tuned per method per horizon: a noisy quadratic (d = 100, eigenvalues log-spaced 1e-3 to 1, additive gradient noise, 5 seeds) and a nonconvex teacher-student tanh MLP (20→32→1, batch 32, label noise σ = 0.3, held-out test loss, 3 seeds).

**Noisy quadratic, final loss (best LR):**

| T | linear decay | cosine | SF β=0 (Polyak) | SF β=0.5 | SF β=0.9 | SF β=1 |
|---|---|---|---|---|---|---|
| 1k | 0.0155 | 0.0159 | **0.0134** | **0.0130** | 0.0166 | 0.0281 |
| 4k | 0.0053 | 0.0059 | **0.0036** | 0.0040 | 0.0066 | 0.0131 |
| 16k | 0.0017 | 0.0017 | **0.0009** | 0.0012 | 0.0020 | 0.0051 |

On a convex quadratic, Polyak averaging is already near-optimal, and the β = 0.9 "momentum" only costs accuracy. The bigger result concerns horizon independence. **β = 0 at a single LR (1.0) reproduced its per-horizon tuned optimum at every checkpoint of one 16k run** (0.0134 / 0.0036 / 0.0009). β = 0.9's best LR drifted from 0.5 to 0.25 to 0.125 as T grew. Running β = 0.9 with the LR tuned for 16k and reading it at 1k gave 0.0471. A linear-decay run planned for 16k and interrupted at 1k gave 0.0288. So with β = 0.9, an early checkpoint was worse than simply interrupting a schedule.

**Nonconvex MLP, test loss (best LR):**

| T | linear decay | SF β=0 | SF β=0.9 | SF β=0.98 |
|---|---|---|---|---|
| 2k | **0.0136** @1 | 0.0181 @1 | 0.0160 @2 | 0.0229 @2 |
| 8k | **0.0102** @0.25 | 0.0125 @0.25 | 0.0114 @0.5 | 0.0131 @0.5 |
| 32k | **0.0096** @0.06 | 0.0109 @0.125 | 0.0107 @0.125 | 0.0116 @0.125 |

Here the paper's ordering appears: once the problem is nonconvex, β = 0.9 beats Polyak averaging at every horizon. A tuned linear-decay schedule still wins by about 10%. Every method's optimal LR also falls about 4× for each 4× increase in steps, which is the `γ ∝ 1/√T`-or-steeper dependence the theorem already contains.

One correction to my own first pass: with an LR grid floored at 0.5, SF β = 0.98 appeared to win at 32k (0.0131 vs 0.0172). That was entirely an artifact of the grid floor. Extending the grid down to 0.03 erased it. Any "SF beats the schedule" result where the schedule's best LR sits on the edge of the grid deserves the same check.

## When to reach for it

Schedule-Free is genuinely useful when the horizon is unknown (continual pretraining, open-ended runs): a usable `x` at every step, no extra memory, no decay branches. But "schedule-free" is not "horizon-free". Averaging builds the linear decay in, and the remaining horizon dependence sits in the learning rate. Sweep LR per budget as you would with a schedule, call `optimizer.eval()` before every checkpoint, and expect a tuned WSD or linear-decay baseline to stay competitive.
