---
title: "DiLoCo: Training LLMs Across Slow Links With 500x Less Communication"
date: 2026-07-23
tags: [distributed-training, llm-training, optimization, federated-learning, systems]
excerpt: "Data-parallel training assumes a fat, low-latency fabric between every GPU. DiLoCo throws that assumption out: workers train independently for hundreds of steps, then exchange a single pseudo-gradient through an outer optimizer. Streaming DiLoCo pushes it further, cutting peak bandwidth another two orders of magnitude so you can train a frontier model over ordinary internet links."
---

Standard large-model training has a hidden prerequisite that rarely gets stated out loud: every accelerator must sit on a fat, low-latency interconnect. Fully-synchronized data parallelism does an all-reduce of the *entire* gradient after *every* microbatch. For a 10B-parameter model in bf16, that is roughly 20 GB moved per step, and the step cannot finish until the slowest link does. This is why training clusters are built as single monolithic pods wired with NVLink and InfiniBand, and why you cannot simply glue together two datacenters on opposite sides of a continent and call it a bigger cluster. The moment a step depends on a 50 ms, 10 Gbps link, throughput collapses.

DiLoCo (Distributed Low-Communication training), introduced by a DeepMind team in late 2023, removes that prerequisite. It lets loosely-connected "islands" of compute, each island well-connected internally but poorly connected to the others, train a single model while communicating **500 times less** than fully-synchronous SGD. Its 2025 successor, Streaming DiLoCo, cuts the remaining *peak* bandwidth by another ~100x. Together they are the reason projects like Prime Intellect's INTELLECT-1 could train a 10B model across machines scattered over three continents.

## The core idea: an outer optimizer over pseudo-gradients

DiLoCo is, structurally, a variant of federated averaging where the number of local steps is unusually large. There are two nested optimizers.

- The **inner optimizer** is AdamW. Each worker `k` trains on its own data shard for `H` local steps (in the paper, `H = 500`) with no communication at all.
- The **outer optimizer** is SGD with Nesterov momentum. It runs once per `H` inner steps and operates not on real gradients but on *pseudo-gradients*.

The pseudo-gradient is the trick. After a worker completes its `H` inner steps, define its contribution as the total displacement of the parameters:

```
Δ_k = θ_global − θ_k_local
```

That is, "how far did local training pull the weights away from where they started?" This delta behaves like a gradient of a smoother, coarser loss. The outer optimizer averages the deltas across all `N` workers and applies a momentum update:

```python
# One DiLoCo outer round. inner_train() runs H steps of AdamW locally.
def diloco_round(theta_global, workers, outer_opt):
    deltas = []
    for k in workers:
        theta_k = inner_train(copy(theta_global), k.data, H=500)  # no comms
        deltas.append(theta_global - theta_k)                    # pseudo-gradient

    pseudo_grad = mean(deltas)          # <-- the ONLY cross-worker communication
    theta_global = outer_opt.step(theta_global, pseudo_grad)  # Nesterov momentum
    return theta_global
```

The only network traffic is that one `mean(deltas)` all-reduce, once every 500 steps. Everything else is local. The communication reduction is almost exactly the ratio you would expect: sync every 500 steps instead of every step gives you roughly 500x fewer bytes on the wire over the course of training.

Why does treating displacement as a gradient work at all? Because after 500 AdamW steps the parameters have settled into a locally good basin for that worker's data. The vector pointing from the global start to that basin is a low-noise estimate of the descent direction that data shard wants. Momentum on the outer loop then accumulates these coarse directions across rounds, smoothing out the disagreements between workers. The outer learning rate is large (around 0.7) with momentum 0.9, because each pseudo-gradient already represents 500 real steps of progress, not one.

## Why this maps onto real hardware

The practical payoff is that the internal fabric of an island can be fast and the fabric *between* islands can be terrible, and it barely matters. During the 500 inner steps, the cross-island link sits idle. It only lights up briefly at each sync. A 10 Gbps internet link that would throttle synchronous training to uselessness is perfectly adequate when you touch it 0.2% of the time.

DiLoCo is also robust to islands joining and leaving, and to differing hardware per island, because the outer loop only ever sees deltas. It does not care how those deltas were produced. This is what makes decentralized, volunteer, or multi-cloud training feasible.

## The remaining problem: peak bandwidth

Vanilla DiLoCo reduces *total* communication, but each sync still moves the entire model at once. For a large model that is a bandwidth spike: every worker must upload and download all 20 GB in a single burst before training can resume. Peak bandwidth, not average, is what determines whether your link is fast enough. Streaming DiLoCo (2025) attacks this with three changes.

**1. Streaming partial synchronization.** Instead of syncing all parameters in one shot, split the model into fragments (say, groups of a few transformer layers) and synchronize them on a staggered schedule. Fragment 0 syncs at outer step `t`, fragment 1 at `t + offset`, and so on. At any instant only a slice of the model is in flight, so the peak bandwidth requirement drops by the number of fragments. Total bytes are unchanged; the *spike* is flattened into a series of smaller ripples.

```python
# Each fragment has its own phase offset, so syncs never all land at once.
def should_sync(fragment_id, outer_step, num_fragments, H_outer):
    phase = (fragment_id * H_outer) // num_fragments
    return (outer_step % H_outer) == phase
```

**2. Overlapping communication with computation.** In vanilla DiLoCo, workers stall during the all-reduce. Streaming DiLoCo lets a fragment keep training locally for a few extra steps while its pseudo-gradient is still in transit, then applies the outer update when it lands. The communication of fragment `i` overlaps the computation of fragment `i+1`. As long as the sync completes within that overlap window, the network cost is almost entirely hidden behind compute, and wall-clock time approaches that of a non-communicating run.

**3. Quantizing the exchanged data.** The pseudo-gradients are compressed from bf16 to low-precision (down to 4 bits) before transmission. Because the outer optimizer already tolerates coarse, noisy directions, this aggressive quantization costs essentially nothing in final quality while cutting the bytes-on-wire by another 4x.

Stacked together, these let you train a billion-scale model at the same loss as a fully-synchronous baseline while reducing the bandwidth needed by **two orders of magnitude** relative to DiLoCo, and by roughly four orders of magnitude relative to naive data parallelism.

## What it costs you

DiLoCo is not free lunch. The 500 inner steps mean workers drift apart before each reconciliation, and on some tasks the outer-loop averaging leaves a small quality gap versus a perfectly synchronous run, though the gap is remarkably small and often within noise at scale. Choosing `H` is a genuine tradeoff: larger `H` means less communication but more drift, and drift eventually destabilizes training. There is also a subtle interaction with the inner AdamW state, which is typically kept local per worker rather than synchronized, so each island carries its own second-moment estimates.

The deeper lesson is about the shape of the optimization problem. Synchronous SGD implicitly assumes gradients are so noisy that you must average them constantly. DiLoCo's bet, borne out empirically, is that for large models a coarse pseudo-gradient computed over hundreds of steps is a *good enough* descent direction, and that momentum on the outer loop repairs the disagreements. That reframing, from "communicate every step" to "communicate a summary occasionally," is what turns a rack of tightly-coupled accelerators into an optional detail rather than a hard requirement. It is the algorithmic groundwork for training frontier models on infrastructure that does not look like a supercomputer at all.
