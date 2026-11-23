---
title: "WSD Cooldowns vs. Convex Theory, Audited: The Exact Limit Is a One-Line Formula, a 20% Cooldown Costs 8% (Not 33%), and the Tuned LR Wants a 42% Cooldown"
date: 2026-11-24
tags: [optimization, learning-rate-schedules, llm-training, convex-optimization, deep-learning]
excerpt: "Schaipp et al. (ICML 2025) show that a last-iterate SGD bound from non-smooth convex optimization reproduces the loss curves of LLM learning-rate schedules, including the sudden drop during a WSD cooldown. I re-implemented the bound in O(T) and derived its exact large-T limit for WSD: sqrt(2(2+ln((1+β)/(1−β)))/(1+β)) · DG/√T. At 20% cooldown that is 2.160, against 2.666 from the paper's Theorem G.1, so the theorem overstates the cost relative to linear decay by about 4× (33% vs 8%). The same algebra gives a closed form for the best cooldown fraction at a fixed LR, 2γ'²/(1+γ'²). At the LR tuned for 20% cooldown, that is 42%."
---

Warmup-stable-decay (WSD) holds the learning rate constant, then decays it linearly to zero over the last ~20% of steps, where the loss drops sharply. *The Surprising Agreement Between Convex Optimization Theory and Learning-Rate Scheduling for Large Model Training* (Schaipp, Hägele, Taylor, Şimşekli, Bach; arXiv:2501.18965, ICML 2025) argues that this drop is not specific to deep learning. A last-iterate bound for SGD on convex Lipschitz problems produces the same curve, and the authors use it to transfer learning rates between schedules.

I implemented the bound and derived its continuous limit, which the paper does not state. The qualitative claims hold. The quantitative WSD theorem is loose enough to change the practical conclusion.

## The bound, in code

Theorem 3.1 (from Defazio et al., 2023) bounds the last iterate of `x_{t+1} = x_t − γ·η_t·g_t`. Here γ is the base LR and η_t is the schedule shape, with η_{T+1} = 0. Under E‖g_t‖² ≤ G² the bound takes the form `Ω = T1/γ + γ·T2`. The optimal base LR is `γ* = sqrt(T1/T2)` and the optimal bound is `Ω* = 2·sqrt(T1·T2)`. With suffix sums, the whole computation is O(T):

```python
import numpy as np

def sched(kind, T, c=0.2):                 # c = cooldown fraction
    t = np.arange(1, T + 2, dtype=float)   # t = 1..T+1, eta_{T+1} = 0
    if kind == "const": return np.ones(T)
    if kind == "cos":   return (0.5 * (1 + np.cos((t - 1) / T * np.pi)))[:T]
    T0 = int(round((1 - c) * T)) if c < 1 else 1
    r = np.clip((t - T0) / (T + 1 - T0), 0, None)
    e = np.where(t < T0, 1.0, 1 - r if kind == "wsd" else 1 - np.sqrt(r))
    return e[:T]

def omega(eta, gamma=None, D=1.0, G=1.0):
    S = np.cumsum(eta[::-1])[::-1]                    # sum_{t>=k} eta_t
    Q = np.cumsum((eta**2 * G**2)[::-1])[::-1]        # sum_{t>=k} eta_t^2 G^2
    T1 = D**2 / (2 * S[0])
    T2 = Q[0] / (2 * S[0]) + 0.5 * np.sum(eta[:-1] / S[1:] * Q[:-1] / S[:-1])
    gamma = np.sqrt(T1 / T2) if gamma is None else gamma
    return T1 / gamma + gamma * T2, gamma
```

As a check, the constant schedule reproduces the paper's closed form `DG·sqrt(1 + H_{T−1})/√T` exactly. Linear decay gives 2.0001·DG/√T at T = 10⁵, which matches the appendix's `(2 + H_{T−1}^{−2/3}/(T+1))` figure.

## The exact limit the paper doesn't state

Treat the schedule as a function η(s) on s ∈ [0, 1], and write a(s) = ∫ₛ¹η and q(s) = ∫ₛ¹η². Let A = ∫η and B = ∫η². The second sum in T2 then becomes a Riemann integral, J = ∫₀¹ η·q/a² ds. With γ = γ'·D/(G√T), the bound becomes:

```text
√T · Ω / (DG)  =  1/(2A·γ')  +  γ'·N/2,      N = B/A + J
optimal:  γ'* = 1/sqrt(A·N),    √T · Ω* / (DG) = sqrt(N/A)
```

For the constant schedule, J diverges like ln T, which is the familiar log factor. For WSD with stable fraction β (cooldown fraction c = 1 − β), each piece is elementary. The cooldown contributes exactly 4/3. The stable phase contributes ln((1+β)/(1−β)) − 1/3 + (1−β)/(3(1+β)). Together with B/A, everything except the log collapses to a constant:

```text
A = (1+β)/2,    N = 2 + ln((1+β)/(1−β))

√T · Ω*_wsd / (DG)  =  sqrt( 2·(2 + ln((1+β)/(1−β))) / (1+β) )
```

At β = 0 this is linear decay, and the formula gives 2. At β = 0.8 it gives sqrt(2·(2 + ln 9)/1.8) = **2.1596**. The exact O(T) evaluation converges to that value:

| T | linear decay | WSD 20% | WSD 20%, 1−sqrt | cosine | constant |
|---|---|---|---|---|---|
| 400 | 2.0126 | 2.1842 | 2.1437 | 2.0677 | 2.7509 |
| 6,400 | 2.0012 | 2.1622 | 2.1276 | 2.0606 | 3.2158 |
| 102,400 | 2.0001 | 2.1598 | 2.1261 | 2.0602 | 3.6213 |
| limit | 2 | 2.1596 | — | ≈2.060 | ∞ (√ln T) |

(Units are DG/√T, each schedule at its own γ*.) The log in T is gone, as the paper says. In its place is a log in the cooldown fraction, which costs only 8% at the usual 20%.

## Where Theorem 3.4 / G.1 goes loose

The paper's WSD result (Theorem 3.4, with the full version in Theorem G.1) has the form `DG·sqrt(4/(T+T0)·[Λ1 + Λ2 − Λ3 + o(1)])`, where Λ2 = H_{T+T0−2} − H_{T−T0+1} is the log term. Two things show up when you evaluate it.

1. **The log coefficient is doubled.** Asymptotically the theorem is sqrt(4·(1 + ln((1+β)/(1−β)))/(1+β)). The exact limit is sqrt(2·(2 + ln(...))/(1+β)). Both agree at β = 0, but the theorem puts 4/(1+β) on the log where the exact limit has 2/(1+β). At T = 10⁵ and 20% cooldown, the G.1 formula gives **2.6657** against the exact 2.1598, which is 23% loose. It is still a valid upper bound, but it is a poor guide to how WSD ranks against other schedules.
2. **The appendix arithmetic doesn't reproduce.** The Λ1 − Λ3 constants simplify. The paper's Λ4 = (1+2β)/(3(1+β)) − β/(3(1+β)) is exactly 1/3, so the non-log terms sum to exactly 1. The appendix plugs in β = 0.8 and writes `0.9 + 2.2·(H_{1.8T−2} − H_{0.2T+1})`. The constant should be 4/1.8 × 1 = 2.22. And at T = 10⁵ the log term is 2.2 × ln 9 ≈ **4.83**, not the 4.39 printed. The appendix then concludes that WSD's constant is "roughly twice" linear decay's and "1/3" of the constant schedule's. The G.1 formula itself gives 1.33× and 0.74×. The exact bound gives **1.08×** and **0.60×**.

Corrected, a 20% WSD cooldown is within 8% of linear decay and 5% of cosine. That fits Hägele et al.'s finding that WSD matches cosine better than "twice as bad" does.

## The LR-transfer claims check out

With D = G = 1, γ*·√T is 1.000 for linear decay, 0.9708 for cosine and 0.5145 for 20% WSD, which is exactly 2/((1+β)·Ω*). Cosine wants 1.89× WSD's LR (the paper's small-T fit: 0.92/0.47 ≈ 1.96). From 20% WSD to linear decay, ln(1/0.5145) = 0.665, consistent with the paper's γ*(1) ≈ e^0.7·γ*(0.2).

## A closed form for the best cooldown at a fixed LR

The paper's Fig. 4 shows that if you fix γ and sweep the cooldown fraction, the bound forms a parabola, and for large γ it becomes monotone. The limit formula makes this explicit. Minimize `1/((1+β)γ') + γ'(2 + ln((1+β)/(1−β)))/2` over β. Setting the derivative to zero gives γ'²(1+β) = 1−β, so:

```python
def best_cooldown_fraction(gamma_prime):  # gamma' = gamma * G * sqrt(T) / D
    return min(1.0, 2 * gamma_prime**2 / (1 + gamma_prime**2))
```

A grid search over the exact O(T) bound at T = 20,000 agrees to within 0.005 at every γ' I tried: 0.077 vs 0.080 at γ' = 0.2, 0.400 vs 0.400 at 0.5, 0.780 vs 0.780 at 0.8. At γ' ≥ 1 the answer is linear decay, which is the monotone regime.

The part with practical consequences: γ*(c) and c*(γ) are not mutually consistent, except at linear decay. Take the LR tuned for a 20% cooldown (γ' = 0.5145) and the bound prefers a **42% cooldown** at that same LR. Moving there lowers the bound from 2.1595 to 2.0855. That recovers 46% of the gap to linear decay without retuning anything.

## The "sudden drop" quantified

At fixed γ*, with T = 20,000:

| t/T | 0.25 | 0.50 | 0.80 | 0.85 | 0.90 | 0.95 | 1.00 |
|---|---|---|---|---|---|---|---|
| WSD 20% | 6.48 | 4.72 | 4.11 | 3.65 | 3.13 | 2.61 | 2.16 |
| cosine | 6.50 | 4.39 | 2.49 | 2.30 | 2.17 | 2.09 | 2.06 |

WSD loses **47%** of its bound in the last 20% of steps, almost linearly across the cooldown. Cosine has mostly decayed by then and drops 17%. The mechanism is clear. During the stable phase, the γ·(1+H_t)/2 noise term dominates. The cooldown removes it by averaging over shrinking steps, which is how the log factor disappears.

## Practical reading

- **20% WSD is not a theoretical compromise.** It is about 8% from the convex optimum, and the paper's own theorem overstates that gap roughly 4×. The exact formula is cheap enough to check any cooldown fraction before you run it.
- **If you inherit an LR tuned for 20% cooldown,** the bound recommends one of two things. Either lengthen the cooldown to about 2γ'²/(1+γ'²), which is ~40% here, or switch to linear decay at about 1.94× the LR. Both rest on G_t staying roughly constant over training. Gradient norms in LLM training often don't, so verify with a short sweep.
- **1−sqrt cooldown beats linear by 1.6% in the bound** (2.1261 vs 2.1598 at 20%). That is the same direction Hägele et al. observed empirically, and a smaller margin.
- **Know the limits.** This is SGD on a convex Lipschitz objective with constant G. It says nothing about the optimizer itself (Adam vs. SGD), loss spikes, or warmup. What it predicts well is the curve's shape, the LR scaling and, with the exact limit, the size of the cooldown benefit.
