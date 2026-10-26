---
title: "Metastable Failures as Markov Chains: The Orbit Cap Is Load-Bearing"
date: 2026-10-26
tags: ["distributed-systems", "queueing-theory", "markov-chains", "reliability", "retries"]
excerpt: "A 2025 paper models retry storms as a two-dimensional CTMC and defines metastability by escape probabilities and eigenvalues. I rebuilt the chain and a discrete-event simulator of the same system. The paper's bistability depends on capping the retry orbit at 20. With a cap of 400, recovery goes from 577 s to 1.6×10⁹ s and throttling stops working. The simulator recovers in 570 s on average because a retry that hits a full queue ends the request, which the generator doesn't model and the cap happens to stand in for. The eigenvalue proxy measures the wrong crossing, and dropping expired work at dequeue brings recovery down to 163 s."
---

# Metastable Failures as Markov Chains: The Orbit Cap Is Load-Bearing

A **metastable failure** happens when a short trigger, such as a load spike, pushes a system into a degraded state that keeps itself going after the trigger is gone. Retry storms are the textbook case. Queues grow until requests time out. The timed-out requests retry, and the extra load keeps the queues full.

Alvaro, Isaacs, Majumdar et al., *Formal Analysis of Metastable Failures in Software Systems* (arXiv 2510.03551, Oct 2025), give this a mathematical footing. They model a server as a continuous-time Markov chain (CTMC), visualize its drift field, and define metastability through escape probabilities and the eigenvalues of the CTMC. Their running example has one server at μ = 10 RPS, Poisson clients at λ = 9.5 RPS, a 9 s timeout, 3 retries and a 100-slot queue.

I rebuilt the CTMC with `scipy.sparse` and wrote a discrete-event simulator (DES) that follows the paper's asyncio listing (Fig. 7).

## The model

The state is (u, v): u requests in the system, v requests in the **orbit**, waiting to retry. An arrival that sees u requests ahead of it times out if fewer than u+1 services finish within τ, so r(u) = P(Poisson(μτ) ≤ u). Retries leave the orbit at rate αv/τ with α = ρ/(ρ+1). Abandonments leave at (1−α)v/τ.

```python
def build(lam=9.5, mu=10.0, tau=9.0, rho=3, N=100, V=20):
    a = rho / (rho + 1)
    r = poisson.cdf(np.arange(N + 1), mu * tau)
    for u in range(N + 1):
        for v in range(V + 1):
            if u < N:
                if v < V: add((u, v), (u+1, v+1), lam * r[u])      # arrival, will time out
                add((u, v), (u+1, v),   lam * (1 - r[u]))
                add((u, v), (u+1, v),   a * v * r[u] / tau)        # retry, fails again
                if v: add((u, v), (u+1, v-1), a * v * (1 - r[u]) / tau)
            if u: add((u, v), (u-1, v), mu)
            if v: add((u, v), (u, v-1), (1 - a) * v / tau)
```

Expected recovery time is the solution of a sparse linear system, Q_TT·h = −1 over the non-target states. Every solve below has a residual under 2×10⁻⁴.

The cliff is sharp. r(u) first reaches 0.5 at u = 90 = μτ. The paper places the transition at "about 100" (§1), "around 65" (§2), "around 75" (Fig. 5 text) and "greater than 90" (§6.2). The exact value is 90.

## Finding 1: the orbit truncation decides the answer

Remark 2 of the paper justifies a finite orbit: the unbounded chain is positive recurrent, so truncating it is safe. The §6 experiments use an orbit of length 20. In the fully stuck state, though, the orbit settles near λτ(ρ+1) = 342. Here is recovery time (from a full queue and full orbit down to u ≤ 10) as the cap V moves:

| Orbit cap V | E[recovery], λ=9.5 | Stationary P(u ≥ 90) | E[recovery], throttled λ=8 |
|---|---|---|---|
| 0 (no retries) | 142 s | — | 43 s |
| 20 (paper) | **577 s** | 0.097 | **68 s** |
| 50 | 3.8×10⁴ s | — | — |
| 100 | 2.0×10⁸ s | 0.998 | 1.2×10⁵ s |
| 400 | **1.6×10⁹ s** | 0.999 | **2.5×10⁵ s** |

At V = 20 the chain is bistable: it recovers in about ten minutes and spends 10% of its time saturated. At V ≥ 100 the full-queue state is effectively absorbing. It recovers in about 50 years and holds 99.9% of the stationary mass. The paper's headline mitigation also stops working: throttling to 8 RPS goes from 68 s to 69 hours. Positive recurrence is true but tells you nothing about time scales, and the truncation level is a modeling choice that changes the result.

## Finding 2: the simulator recovers, because drops end requests

My DES implements Fig. 7 as written. The worker keeps serving attempts whose client has already timed out. A timed-out client retries immediately. An attempt that finds the queue full gets `set_result("Dropped")`, and the client returns without retrying.

```python
def enqueue(t, k):
    if len(q) >= Q: return False                 # Dropped: the request ends here
    a = new_attempt(k); live[a] = True
    q.append(a); push(t + tau, 'timeout', a)
...
elif kind == 'timeout' and live.get(a):
    live[a] = False
    if att_no[a] < attempts: enqueue(t, att_no[a] + 1)
```

I ran 100 seeds with a 20 RPS spike from 200 s to 400 s, timing recovery from 400 s to ≤ 10 in system:

| Configuration | Mean | Median | p90 |
|---|---|---|---|
| No retries | 141 s | 124 s | 233 s |
| **4 attempts (paper's setting)** | **570 s** | 382 s | 1,206 s |
| 3 attempts (Fig. 7's `range(1, retries+1)`) | 497 s | 324 s | 1,068 s |
| 4 attempts, dropped attempts retried after τ | stuck at 20,000 s in 20/20 runs | | |

While stuck, goodput falls from 9.9 to about 2 RPS, and a third of runs are still saturated 600 s after the spike, which matches the paper's Fig. 1(a). But every run escapes. The simulator's mean of 570 s sits within 1% of the V = 20 chain's 577 s, which I take to be a coincidence. The cap isn't derived from anything; it just does the job of a mechanism the generator lacks. In the simulator a full queue *removes* retry pressure, because each blocked retry ends its request. In the CTMC, retry transitions at u = N are disabled, so blocked retries wait in the orbit. Change one line so that dropped attempts retry, and the simulator behaves like the untruncated chain: stuck in every run.

The two queue-full semantics, "drop ends the request" and "drop is a retryable error", are the difference between a ten-minute brownout and an outage that never ends. Many RPC stacks treat overload rejections (503, UNAVAILABLE) as retryable by default.

The paper's calibrated parameters (λ* = 9.43, τ* = 10.54 s) go the other way. With τ* > N/μ, a full queue times out only r(N) = 32% of its arrivals. Recovery comes out at 179–259 s for any cap, close to the 129 s you get with no retries. Calibration closed the trajectory gap by removing most of the effect being studied.

## Finding 3: λ₂ measures the faster crossing

The paper proposes the spectral gap as a numerically stable stand-in for recovery time, since τ_mix ≥ log(1/2ε)/|λ₂|. In a two-well chain, λ₂ ≈ k(good→bad) + k(bad→good), so it reports whichever crossing is *faster*:

| V | good→bad | bad→good | 1/λ₂ |
|---|---|---|---|
| 20 | 2,890 s | 577 s | 394 s |
| 400 | 2,890 s | 1.6×10⁹ s | 2,920 s |

At V = 400, 1/λ₂ underestimates recovery by a factor of 5×10⁵. Theorem 5.2 agrees, since it ranks wells by escape probability, but a dashboard that reads "mixing time ≈ 49 minutes" will miss a failure that never ends. The §6.4 multi-server analysis relies on this proxy.

## Finding 4: the multi-server bound moves the cliff

For K > 1, §3.5 replaces the exact r(u) with a Chebyshev bound, using variance Σ(u_l/μ̄_l)². With one server that is (u/μ)², the variance of an exponential with mean u/μ. The actual sojourn time is Erlang, with variance u/μ². The bound reaches 1 at u = μτ/2 = 45, against 90 for the exact formula (82 with Erlang variance). At u = 30 it predicts a 25% timeout rate where the true rate is 1.9×10⁻¹³. The single-server and multi-server constructions therefore disagree for K = 1, and the multi-server one reports overload at half the real threshold.

## What fixes it

Two server-side changes, each tested over 100 seeds in the DES:

- **Drop expired work at dequeue.** Skip attempts whose client has already given up. Mean recovery falls to 163 s, near the no-retry baseline, and post-spike goodput goes from 4.8 to 9.6 RPS. The stuck state needs the server to spend capacity on zombies, so removing them removes it.
- **Keep the queue's latency under the timeout.** With N = 80 < μτ, no admitted request can time out, and mean recovery is 113 s.

Throttling to 8 RPS helps in the simulator (198 s), but only because of the drop semantics; the untruncated chain says it shouldn't.

## Takeaways

The framework (state = queue × orbit, visualize the drift, compute escape times) is a good tool, and the visualization does find the cliff. But the quantitative answers depend on choices the paper treats as details. The orbit cap moves recovery by six orders of magnitude. Whether a queue-full rejection can be retried is the one-line difference between 570 s and never. A spectral gap reports the faster crossing, so solve the hitting-time system instead. The fixes that work don't depend on the model: drop expired work, and size queues so the wait stays under the timeout.
