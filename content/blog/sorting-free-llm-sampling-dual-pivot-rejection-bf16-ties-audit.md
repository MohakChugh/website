---
title: "Sorting-Free LLM Sampling, Audited: Single-Pivot Rejection Already Averages ≤ 1 + ln(1/P) Rounds, Dual-Pivot Changes Nothing on Real Logits, and bf16 Ties Make top_k=50 Keep 58 Tokens"
date: 2026-11-25
tags: [llm-inference, sampling, gpu-kernels, algorithms, numerics]
excerpt: "FlashInfer replaced sort-then-cumsum top-k/top-p sampling with rejection sampling, then added a dual-pivot version that bounds the worst-case number of rounds. I re-implemented both and ran them on 1,536 real next-token distributions from Qwen2.5-0.5B. Both are exact: 0 invalid tokens in 4M draws. Their round counts are the same on every metric I measured, including the max over a 64-row batch. I derive the expected round count for the single-pivot sampler in closed form, E = 1 + Σ m(v)/M(≥v) ≤ 1 + ln(1/Z), which caps top-p=0.9 at 1.105 rounds. The bigger surprise is semantic: a bf16 row has only about 2,860 distinct logits across 151,665 tokens, so threshold-based top_k=50 keeps more than 50 tokens at 60.7% of positions."
---

Sampling is the last kernel of every decode step, and the obvious implementation sorts: order the vocabulary by probability, take a cumulative sum, mask past the cutoff, renormalise, draw. With a 150k vocabulary, that sort is a measurable share of inter-token latency.

FlashInfer's [sorting-free sampling kernels](https://flashinfer.ai/2025/03/10/sampling.html) (March 2025, now used in vLLM, SGLang and MLC-LLM) remove the sort. The key observation is that top-k, top-p and min-p each define a **monotone predicate on probability values**. Call it `f(τ)`, which is 1 when a token with probability τ belongs in the truncated set. You never need the set itself. Draw a token by inverse-transform sampling, test it, and if it fails, raise a pivot and draw again from the tokens above the pivot.

The post claims the single-pivot loop has "no guaranteed round count", hurting tail latency, and that a dual-pivot variant fixes it by halving the search interval each rejected round, for O(log(1/ε)) rounds. I tested both on real distributions.

## Setup

I took 1,536 next-token distributions from Qwen2.5-0.5B. The model ran in bf16 over six posts from this blog, and I took every other position. The vocabulary has 151,936 rows, of which 151,665 are real tokens. I tested temperatures 1.0 and 0.7, with top-p ∈ {0.9, 0.95, 0.99} and top-k ∈ {50, 1000}. The samplers below transcribe the published loops. They sort only so that `S(τ)`, the mass strictly above τ, is a binary search; the GPU kernel computes it with a block reduction.

```python
def S(t):     n = count_gt(t); return C[n-1] if n else 0.0  # mass with p > t
def f_topp(t): return S(t) < P            # token is in the nucleus
def f_topk(t): return count_gt(t) < k     # fewer than k tokens beat it

def single_pivot(f):
    low = 0.0
    while True:
        j = draw_proportional(p > low)    # inverse transform, ignore p <= low
        if f(p[j]): return j
        low = p[j]

def dual_pivot(f):
    low, high = 0.0, 1.0                  # f(low)=0, f(high)=1
    while True:
        j = draw_proportional(p > low)
        p1 = p[j]
        if f(p1): return j
        p2 = (p1 + high) / 2
        if f(p2): low, high = p1, p2      # threshold in (p1, p2]
        else:     low = p2                # threshold above p2
```

## Exactness holds

Both loops are exact: each round draws proportional to `p` over `{p > low}`, every valid token is always above `low`, so an accepted token is proportional to `p` over the valid set whatever `low` is.

Empirically, 1M draws per sampler on one row gave a total-variation distance to the target of 0.0113 for dual-pivot (top-p 0.9), against 0.0114 for 1M direct draws from the target. For top-k 50 the figures were 0.0023 against 0.0020. Across 4M draws, no invalid token was ever returned.

## A closed form for the single-pivot sampler

The FlashInfer post gives no expected round count for the single-pivot loop. One falls out of the recursion. Let `E(τ)` be the expected number of remaining rounds when the pivot is at τ:

```
E(τ) = 1 + Σ_{invalid w > τ} (m(w) / S(τ)) · E(w)
```

Here `m(w)` is the total mass of tokens whose probability equals the distinct value `w`. Walk the invalid values from largest to smallest. Each step multiplies the accumulator by `S_next/S`, so the product telescopes and leaves a sum:

```
E[rounds] = 1 + Σ_{invalid distinct v}  m(v) / M(≥v)
          ≤ 1 + ln(1/Z)        using x/(1+x) ≤ ln(1+x)
```

`M(≥v)` is the mass of tokens with probability at least `v`, and `Z` is the mass of the valid set. For top-p, `Z ≥ P` by definition, so **single-pivot top-p averages at most 1 + ln(1/P) rounds**: 1.105 at P=0.9, 1.051 at 0.95 and 1.010 at 0.99, on any distribution. The bound is nearly tight on real rows, because the rejected mass is spread across a long tail of small values. On the test row the exact value was 1.1043, and Monte Carlo gave 1.1047. Across all rows and configurations the bound was never exceeded; the largest excess was 2.6e-13, which is float error.

For top-k there is no floor on `Z`, so the cost is `ln(1/Z)`, where `Z` is the top-k mass. Real rows keep that small, but a flat distribution does not.

## Dual-pivot vs single-pivot on real logits

| T=1.0 | mean rounds (both) | p99.9 single / dual | max single / dual | E[max over 64 rows] single / dual |
|---|---|---|---|---|
| top-p 0.9 | 1.089 | 3 / 3 | 6 / 6 | 2.23 / 2.23 |
| top-p 0.95 | 1.045 | 3 / 3 | 5 / 5 | 2.01 / 2.01 |
| top-p 0.99 | 1.009 | 2 / 2 | 3 / 4 | 1.45 / 1.45 |
| top-k 50 | 1.193 | 4 / 4 | 8 / 8 | 3.18 / 3.19 |
| top-k 1000 | 1.036 | 3 / 3 | 5 / 5 | 2.00 / 2.00 |

I used 2,000 draws per row, which is 3.07M per configuration. The batch column models one GPU block per row, where the kernel finishes when its slowest row does. At T=0.7 every number is lower, and the two samplers still match to two decimals.

The reason is in the update rule. Dual-pivot differs from single-pivot only when `f(p2) = 0`, which means the threshold lies above the midpoint between the rejected value and `high`. `high` starts at 1 and halves at most once per rejected round. The median threshold on these rows is about 1e-3 (5th percentile: 6e-5 for top-p 0.9, 4e-6 for top-k 50), and rejections rarely run past three, so `high` never gets close. The bisection branch fired in **3,219 of 207,911 rejected rounds (1.5%)**, and it moved no statistic.

The guarantee does show up on distributions built to be flat. These are not LLM outputs:

| synthetic, 151,665 tokens | E[rounds] | p99.9 single / dual | max single / dual |
|---|---|---|---|
| logits ~ N(0, 0.1), top-k 1 | 12.1 | 23 / 22 | 26 / 22 |
| logits ~ N(0, 1), top-k 1 | 8.8 | 18 / 15 | 21 / 15 |
| logits ~ N(0, 1), top-k 50 | 5.9 | 14 / 14 | 17 / 16 |

Even here the means are equal and match the closed form (12.06 exact, 12.10 measured). Dual-pivot trims the worst case by a few full-vocabulary passes: a cheap guard for high temperature with small k, not the source of the speedup.

## bf16 ties change what top-k and top-p mean

This is the finding that matters in production. `f` looks only at probability *values*, so tied tokens are all in or all out; sort-based code breaks ties by sort position. With bf16 logits, ties are not an edge case:

- A row has a **median of 2,860 distinct logit values across 151,665 tokens** (range 2,470–2,976). Near a logit of 16–32, bf16 can only represent steps of 0.125.
- **Threshold-based top_k=50 kept more than 50 tokens at 60.7% of positions**, averaging 2 extra and peaking at 58. Temperature preserves ties, so the figure is the same at T=0.7.
- **The threshold-based nucleus was larger than the sorted one** at 54.4% of positions (top-p 0.9, T=1), with 10.2 extra tokens on average and up to 97. At top-p 0.99 the figure was 79.4%.

The worst position came from a post's numbered list. Seven digits, '2' through '7' and '9', all had a logit of exactly 17.5 (p = 0.0961), and three tokens were tied at p = 0.1089 above them. Sorted top-p 0.9 stops at 9 tokens (mass 0.903) and **silently drops one digit**, and which digit depends on how the sort breaks ties, so it can change with the sort implementation. The threshold-based version keeps all 10 (mass 0.999), a 9.6% difference in kept mass.

Neither behaviour is a bug. The value-based version does not depend on token order, which is arguably the more defensible definition. But "top_k=50" now means "at least 50", and engine-vs-engine output comparisons drift unless the reference uses the same tie rule.

## One floating-point hazard to guard

The draw target `u · S(low)` comes from a reduction; the token is found by a tiled prefix scan. In fp32 they sum in different orders. I modelled 1,024-wide tiles, summed pairwise within each tile and carried sequentially across tiles. The reduction exceeded the scan total at 46.7% of rows, and the chance that a draw lands past the end of the scan averaged **1.1e-7** (max 9.5e-7). At a billion sampled tokens a day, that is roughly 100 draws daily that find no token. A kernel that falls back to "the last index" in that case will emit a padding row. It should clamp to the last token with `p > low`.

## What I'd take away

1. Replace sorting with rejection sampling. Its cost is predictable from `E ≤ 1 + ln(1/Z)`, which for top-p is close to one pass.
2. Dual-pivot is worth keeping because it costs nothing. Just don't credit it with the speedup on real distributions.
3. Choose a tie rule and document it, especially for top-k under bf16.
4. Clamp the scan.

The scripts (Qwen2.5-0.5B, numpy, ~10 minutes on a laptop CPU) are about 150 lines.
