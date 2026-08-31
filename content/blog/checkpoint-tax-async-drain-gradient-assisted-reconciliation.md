---
title: "The Checkpoint Tax at 16k GPUs: Daly's Formula Stopped Working"
date: 2026-08-31
tags: [distributed-training, fault-tolerance, checkpointing, gpu, systems]
excerpt: "Every systems course teaches the Young/Daly optimal checkpoint interval. A wave of 2025-2026 LLM training papers quietly ignores it and checkpoints far more often than the formula allows. I simulated why, then verified the trick that makes it safe — torn snapshots repaired by replaying the optimizer on the host — and found a 1.9x traffic reduction the papers leave on the table."
---

The standard answer to "how often should I checkpoint?" is Young/Daly: with a blocking checkpoint that costs `C` seconds and a mean time between failures `M`, checkpoint every `sqrt(2CM)` seconds. It is a lovely first-order result. It is also the wrong tool for a 16,000-GPU training job, and the recent fault-tolerance literature — GoCkpt (arXiv:2511.07035), TierCheck (arXiv:2605.17821), PHOENIX (arXiv:2607.01646), ETC (arXiv:2607.04749) — has quietly stopped obeying it. They checkpoint every step, or every few steps, which Daly says is absurd.

I wanted to know whether the formula is merely imprecise here or structurally inapplicable. It's structurally inapplicable.

## What Daly assumes

Daly minimises wasted time per unit of work as the sum of the amortised checkpoint cost `C/T` (one blocking save per interval `T`) and the expected rework `T/(2M)` (on average you lose half an interval). Differentiate, set to zero, get `T* = sqrt(2CM)`. Three assumptions are load-bearing:

1. **The save cost is paid per checkpoint.** Total overhead scales with the *number* of checkpoints.
2. **Recovery cost is rework.** Everything else about a restart is negligible.
3. **Failures are independent and exponential.**

Modern async checkpointing breaks (1). Cluster-scale restarts break (2).

## Simulating the actual objective

I wrote an event-driven simulation: 7 s/step, 1.2 TB shard-parallel state, per-GPU MTBF calibrated so 16k GPUs fail roughly every three hours (matching published large-run interruption rates), 90 s of hang detection and 300 s to relaunch, re-init collectives, reload state and warm the dataloader. Async saves are a per-step throughput tax `α` while a drain is in flight, spanning 30 steps.

```
     N    MTBF  Daly k |  blk k*  blk gp |  asy k*  asy gp  rework  restart    tax
   512  97.66h    1736 |    2000  96.42% |     500  99.17%   0.54%    0.11%  0.18%
  2048  24.41h     868 |    1200  92.82% |     200  98.07%   1.02%    0.46%  0.45%
  8192   6.10h     434 |     500  85.55% |     <10  94.70%   0.50%    1.93%  2.86%
 16384   3.05h     307 |     300  78.22% |     <10  92.45%   0.98%    3.73%  2.80%
 65536   0.76h     153 |     120  57.32% |     <10  81.69%   3.23%   12.43%  2.55%
```

For blocking checkpoints Daly is excellent — its predicted interval lands within one grid step of the simulated optimum at every scale, which is a nice independent confirmation of a 1970s result. For async checkpoints it is off by more than an order of magnitude. At 16k GPUs Daly says 307 steps; the simulated optimum is at the *floor* of the feasible range, and running at Daly's interval costs 8 points of goodput (84.4% vs 92.5%).

You cannot fix this by feeding Daly the async cost instead. Plugging in the amortised async cost (`α · 30 steps · 7 s` = 6.3 s) gives `k = 53` and 90.9% — still 1.6 points short.

## The cost saturates

Here is the structural break, visible when you sweep below the drain length:

```
  k=  3  goodput= 93.13%  rework= 0.27%  tax= 2.80%
  k=  5  goodput= 92.93%  rework= 0.47%  tax= 2.80%
  k= 10  goodput= 92.45%  rework= 0.98%  tax= 2.80%
  k= 20  goodput= 91.40%  rework= 2.00%  tax= 2.80%
  k= 30  goodput= 90.39%  rework= 3.02%  tax= 2.80%
  k= 40  goodput= 90.74%  rework= 3.34%  tax= 2.12%
  k= 60  goodput= 90.77%  rework= 4.00%  tax= 1.42%
```

Once the checkpoint interval drops below the drain window, the tax pins at 2.80% and stops responding to `k`. The copy engine is simply busy all the time; making checkpoints more frequent adds no traffic because there was never any idle drain bandwidth to begin with. Meanwhile rework keeps falling linearly. So the objective becomes monotone decreasing in `k`, and the optimum is a boundary solution: **checkpoint as often as the drain bandwidth permits.** Daly's `C/T` term cannot express a cost that is bandwidth-bound rather than count-bound, so no choice of `C` recovers the right answer.

The second thing the table says is that at 16k GPUs the loss breakdown is 3.73% restart against 0.98% rework. Checkpoint frequency is no longer the dominant lever — the fixed per-failure cost is, and because it is `k`-independent it drops out of Daly's derivative entirely. That is precisely why PHOENIX hot-swaps a spare node into a live job and ETC migrates model state GPU-to-GPU instead of through storage: they are attacking the term the formula is blind to.

## Making a continuous drain legal

Draining continuously means copying a shard while the optimizer is mutating it. You get a torn snapshot: shard `i` captured at version `v_i`, different shards at different versions. GoCkpt's answer is to ship the gradients alongside and reconcile on the host.

I checked whether that actually works. AdamW's update is a pure function of `(θ, m, v, g, t)`, so version skew should be exactly repairable:

```python
def adamw_fwd(p, m, v, g, t):
    m = B1*m + (1 - B1)*g
    v = B2*v + (1 - B2)*g*g
    mh, vh = m/(1 - B1**t), v/(1 - B2**t)
    return p - LR*(mh/(np.sqrt(vh) + EPS) + WD*p), m, v
```

With 8 shards captured across 8 consecutive steps, the unreconciled torn state has 5.9e-2 relative L2 parameter error, and resuming from it diverges from the reference trajectory by 1.2e-1 after 60 steps on identical data. So torn states are not "close enough" — they are a silent corruption. Replaying the optimizer on the host with the shipped gradients, however, reproduces the synchronous snapshot **bitwise**: relative L2 of exactly 0.0 for parameters, `exp_avg` and `exp_avg_sq`, and zero trajectory divergence. Version skew is fully repairable, not approximately repairable.

## Reconcile to the median, not the newest

The papers reconcile forward to the newest captured version. That is the expensive choice. The gradient replay traffic is `sum_i |v_i - T|` shard-slices, which is minimised at the *median* captured version — but reaching a median target requires rolling some shards *backwards*, which needs an inverse:

```python
def adamw_back(p, m, v, g, t):
    mh, vh = m/(1 - B1**t), v/(1 - B2**t)
    return ((p + LR*mh/(np.sqrt(vh) + EPS)) / (1 - LR*WD),
            (m - (1 - B1)*g) / B1,
            (v - (1 - B2)*g*g) / B2)
```

For a 16-step drain window over 16 shards:

| target | gradient traffic | param rel L2 | m rel L2 | v rel L2 |
|---|---|---|---|---|
| newest | 7.50x | 0.0 | 0.0 | 0.0 |
| median | 4.00x | 8.5e-8 | 9.3e-8 | 1.4e-8 |
| oldest | 7.50x | 1.9e-7 | 2.5e-7 | 2.7e-8 |

Traffic ratio 0.533, converging to 0.5 as the window grows. The cost is that rollback is no longer bitwise exact — but the error is at fp32 epsilon (1.2e-7), which is below the noise floor of a bf16 training step. A 1.9x reduction in reconciliation traffic for free.

With one guard. The rollback of `v` computes `(v - (1-β₂)g²)/β₂`, which cancels catastrophically when `(1-β₂)g²` approaches `v` — exactly the gradient-spike regime:

```
  spike x   1:  (1-b2)g^2/v = 2.0e-02   rel err v = 0.0
  spike x  10:  (1-b2)g^2/v = 6.8e-01   rel err v = 1.2e-07
  spike x 100:  (1-b2)g^2/v = 9.9e-01   rel err v = 7.7e-06
  spike x1000:  (1-b2)g^2/v = 1.0e+00   rel err v = 3.2e-04
```

So gate it: if `(1-β₂)g²/v > 0.9` for any shard in the window, fall back to forward-only replay for that shard. Cheap test, and it triggers precisely during loss spikes, when you least want your recovery state quietly wrong.

## The wall this puts on smoothing

Replay traffic scales quadratically in the drain window `S`: 3.50x the checkpointed parameter bytes at `S = 8`, 7.50x at 16, 31.50x at 64 (median targeting halves each). That bounds the whole approach. You want a long drain window to flatten the bandwidth tax, and a short one to keep replay traffic sane — the two pull against each other, and past roughly 16 steps the gradient traffic exceeds what you saved by not blocking. Tiering (cheap local/peer tier at high frequency, remote tier asynchronously behind it) escapes the tradeoff by shrinking the bytes rather than stretching the window, which is why I'd expect TierCheck's shape to outlive GoCkpt's.

Caveats on my numbers: the failure model is independent exponential, which understates correlated rack- and switch-level failures and ignores stragglers entirely; `α` and the 30-step drain length are assumed, not measured; and the reconciliation experiments are single-node NumPy against a synthetic gradient stream, so they establish the *algebra* is sound, not that the plumbing is.

The practical takeaway is smaller than the formula it replaces. Stop solving for an interval. Measure your drain bandwidth, checkpoint as fast as it allows, repair the tears with replay, and then spend your remaining effort on detection and restart latency — because past about 8k GPUs, that is where the goodput is actually going.
