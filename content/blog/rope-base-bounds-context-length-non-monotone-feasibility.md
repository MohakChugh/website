---
title: "The RoPE Base Lower Bound Isn't a Threshold: Re-solving 'Base of RoPE Bounds Context Length'"
date: 2026-10-28
tags: ["llm", "rope", "long-context", "position-embeddings", "transformers"]
excerpt: "Men et al. (2024) derive a minimum RoPE base for each target context length, defined as the smallest base where the sum of cosines B_m = Σcos(mθ_i) stays non-negative out to L. I re-solved it for head dimension 128 and matched 3 of the 11 table entries to two significant figures. The bigger issue is that feasibility is not monotone in base: it flips on and off 21–93 times on a 0.46% grid. Seven of the paper's 11 rounded bases fail the paper's own criterion, a base that is safe for every larger value is 1.4–8× higher, and Mistral's 1e6 at 32K goes negative at m=27,115. The scaling law, base ∝ L^1.7, holds up. The threshold doesn't."
---

# The RoPE Base Lower Bound Isn't a Threshold

Every long-context recipe eventually picks a RoPE base. Llama 2 used 10,000 at 4K. Llama 3 used 500,000 at 8K. Mistral-7B-v0.2 and Qwen2 used 1,000,000 at 32K. The usual justification comes from extrapolation folklore: NTK-aware scaling sets `b_new = b · s^(d/(d−2))`, which grows the base roughly linearly with the extension factor `s`. Then practitioners pick something much larger anyway.

*Base of RoPE Bounds Context Length* (Men, Xu, Zhang, Lin, Chen, arXiv:2405.14591) gives the most principled answer I know of for why "much larger" is right. Its Table 2 reads like a lookup table: 32K needs a base of at least 6.4e5, and 1M needs at least 5.1e8. I re-solved the paper's criterion from scratch to see whether the table can be used that way. The scaling law holds up. The table can't be used as a threshold, because the set of valid bases is not an interval.

## The criterion

RoPE rotates each 2-D slice `i` of the query and key by `mθ_i` with `θ_i = base^(−2i/d)`. Theorem 1 assumes i.i.d. query/key components with standard deviation σ, and a "similar" key `k* = q + ε`. Under those assumptions, the expected attention advantage of a similar token over a random one at relative distance `m` is:

```
(1/2σ²) · ( E[qᵀ R_m k*] − E[qᵀ R_m k] ) = Σ_{i=0}^{d/2−1} cos(m θ_i) =: B_m
```

If `B_m < 0`, a random token outscores a near-copy of the query at that distance. The paper defines the usable context as the largest `L` with `B_m ≥ 0` for all `m ≤ L`, and the base lower bound as

```
base_L = inf{ base | B_m ≥ 0  ∀ m ∈ [0, L] }        (Eq. 11)
```

They solve it numerically, since there's no closed form for a sum of 64 cosines.

## Reproducing it

The computation is small enough to brute-force. For each candidate base, I compute `B_m` for every integer `m` and record the first negative:

```python
import numpy as np
d = 128

def first_neg(base, mmax=1_100_000, chunk=1 << 16):
    th = base ** (-np.arange(0, d, 2) / d)          # 64 frequencies
    for s in range(0, mmax, chunk):
        m = np.arange(s, min(s + chunk, mmax), dtype=np.float64)
        B = np.cos(np.outer(m, th)).sum(1)          # B_m for this chunk
        idx = np.nonzero(B < 0)[0]
        if idx.size:
            return s + idx[0]
    return mmax

grid = np.logspace(3.3, 9.3, 3000)                  # 0.46% steps, 2e3 .. 2e9
fn = np.array([first_neg(b) for b in grid])         # ~2 min on 10 cores
```

Then for each `L`, I take the smallest grid base with `fn > L` (the paper's `inf`), and separately the smallest base above which every grid base is feasible:

| L | Paper | First feasible (mine) | Feasible for all larger bases | Paper's base: first B<0 |
|---|---|---|---|---|
| 1K | 4.3e3 | 4.31e3 | 6.03e3 | 1,077 ✓ |
| 2K | 1.6e4 | 1.16e4 | 2.28e4 | 2,724 ✓ |
| 4K | 2.7e4 | 2.87e4 | 5.90e4 | **4,079 ✗** |
| 8K | 8.4e4 | 8.41e4 | 3.95e5 | 8,592 ✓ |
| 16K | 3.1e5 | 2.35e5 | 1.22e6 | **12,223 ✗** |
| 32K | 6.4e5 | 6.32e5 | 2.80e6 | **27,685 ✗** |
| 64K | 2.1e6 | 2.10e6 | 8.77e6 | 77,306 ✓ |
| 128K | 7.8e6 | 8.26e6 | 3.42e7 | **128,915 ✗** |
| 256K | 3.6e7 | 3.31e7 | 1.30e8 | **207,455 ✗** |
| 512K | 6.4e7 | 6.33e7 | 5.10e8 | **511,210 ✗** |
| 1M | 5.1e8 | 3.83e8 | 1.17e9 | **874,868 ✗** |

(L uses powers of two: 1K = 1,024.)

At 1K, 8K and 64K, my values match the paper's to two significant figures, and 32K and 512K are within 1.5%, so the setup (d = 128, geometric θ) is the same. The other entries differ by up to 28% in both directions. The last column is the more useful one. I plugged each published base back into the paper's own criterion, and **7 of the 11 fail**. Reading "1K" as 1,000 instead of 1,024 cuts that to 5 of 11, with 16K, 32K, 256K, 512K and 1M still failing. The 512K entry, 6.4e7, goes negative at m=511,210, which is 13,078 positions short of its target.

## Why: feasibility flickers

Eq. 11 is defined with an `inf`, which assumes that once a base works, every larger base also works. That assumption is false. On the 0.46% grid, feasibility for L = 4K flips between valid and invalid 21 times. For 32K it flips 57 times, and for 128K it flips 93 times. Between the first feasible base and the always-feasible one, 19–96% of bases are infeasible.

The mechanism shows up when you print the worst-case margin `min_{m≤L} B_m` for L = 32,768 as the base rises:

```
base 6.00e5   min B = -3.835 at m=32467
base 7.50e5   min B = -0.572 at m=29873
base 1.00e6   min B = -0.775 at m=28259
base 1.25e6   min B = -2.939 at m=30967
base 1.40e6   min B = -3.406 at m=32147
base 1.45e6   min B = +0.174 at m=32551
base 1.50e6   min B = +0.722 at m=26707
```

`B_m` has a maximum of 64. Past its first zero crossing, it drifts down through a field of local minima, made by the low-frequency dimensions beating against each other. As the base grows, the whole pattern stretches outward, but each local minimum's depth also oscillates, because the frequencies don't scale together relative to each other. The binding constraint is whichever local minimum happens to dip below zero inside `[0, L]`. Its depth wobbles by a few units around zero, about 1–5% of the peak. The "lower bound" is the first base where that wobble lands on the positive side. Rounding to two significant figures can easily push it back to the negative side, which is what happened to seven table entries.

## Checking real configs

The same check on shipped configurations:

| Model config | L | First B<0 | min B on [0, L] |
|---|---|---|---|
| Llama 2, base 1e4 | 4,096 | 1,707 | −8.36 |
| Llama 3, base 5e5 | 8,192 | none | +5.97 |
| Mistral-7B-v0.2 / Qwen2, base 1e6 | 32,768 | 27,115 | −0.78 |
| Llama 3.1, base 5e5, no scaling | 131,072 | 18,438 | −14.53 |
| Llama 3.1 with its rope_scaling | 131,072 | 85,133 | −1.48 |

Llama 3.1's scaling (factor 8, low/high frequency factors 1 and 4, original length 8,192) keeps 29 of the 64 frequencies unchanged, divides 29 by 8, and interpolates the 6 in between. That pushes the first violation from 18K out to 85K, but not to 128K. Mistral's 1e6 is above the paper's 6.4e5 for 32K, yet it still violates the criterion, by a margin of 0.78 out of 64.

Both models still work at their advertised lengths; Meta reports strong needle-in-a-haystack retrieval at 128K for Llama 3.1. The paper concedes the bound "is not very strict" because stacked layers extend reach. A −0.78 margin under an i.i.d. assumption is inside the model's error: trained queries and keys are anisotropic, which changes which local minimum binds.

## What holds up

Fitting the bounds across three decades of L gives a power law:

- Paper's table: `base ∝ L^1.69`
- Always-feasible column: `base ∝ L^1.76`

That is the result worth keeping. NTK-aware scaling grows the base about linearly with `s`; the criterion asks for nearly the 1.7th power, so doubling the context multiplies the base by about 3.3, not 2. It matches the paper's real empirical finding (Figure 6): fine-tuning Llama2-7B to 32K, perplexity stays flat across bases while Long-eval retrieval collapses below the bound. Perplexity can't see the failure; retrieval can. The paper calls this "superficial long-context capability."

## Using the bound in practice

1. **Treat `base_L` as an order of magnitude, not a cutoff.** Margins are a few percent of the peak, and the assumptions don't hold for trained models.
2. **If you use it, use the always-feasible column**, 1.4–8× above the paper's values. Only there is "pick something bigger" actually safe.
3. **Measure B on your own model.** Theorem 1 generalizes directly: replace `cos(mθ_i)` with `(σ²_{2i} + σ²_{2i+1}) cos(mθ_i)` (the paper's Eq. 12) using per-dimension variances measured from real queries and keys. Weighting moves the local minima, so this is the check that matches your model.
4. **Validate with retrieval, never perplexity.** If a 2% change in base can flip the criterion, only a task that must look far back tells you which side you're on.

The theory is sound: there's a real discrimination budget, and the base controls its reach. But it runs out through cosines dipping in and out of negative territory, so the boundary is a noisy level set, not a number. Plan with the power law; validate with retrieval.
