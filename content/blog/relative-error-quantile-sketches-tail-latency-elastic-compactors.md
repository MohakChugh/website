---
title: "Your p99.9 Has an Error Bar the Width of the Entire Tail"
date: 2026-08-22
tags: ["sketches", "quantiles", "observability", "streaming", "algorithms"]
excerpt: "Every metrics pipeline stores a quantile sketch with an additive rank guarantee of ±εn, then asks it for p99.9 — where only εn·(1/ε(1-q)) items even exist. I measured the resulting value error at 52%, derived why the fix needs a different guarantee shape, and traced the space bound from ReqSketch's log^1.5 down to the SODA 2025 elastic-compactor result."
---

Your dashboard says p99.9 latency is 412ms. The sketch behind it was configured with ε = 0.001 over n = 2×10⁶ requests. Its guarantee is that the reported rank is within ±εn = ±2000 of the truth. But only 2000 requests are slower than p99.9 in the first place. The error bar is exactly as wide as the tail it is measuring: the number the sketch returned is, within its own stated guarantee, permitted to be anything from p99.8 to the global maximum.

This is not a bug in the sketch. KLL is optimal for what it promises. The problem is that what it promises has the wrong *shape*, and almost every metrics pipeline in production is built on it.

## The compactor, the one primitive underneath all of them

Every modern quantile sketch is built from the same atomic operation. A *compactor* is a buffer of `k` items at weight `w`. When it fills, sort it, keep every other item, and promote the survivors to a buffer at weight `2w`:

```python
buf = sorted(self.levels[h])
self.levels[h] = []
self.levels[h + 1].extend(buf[random.randint(0, 1)::2])   # keep every other, weight ×2
```

The random offset is the entire error analysis. Dropping every other item from a sorted run perturbs the rank of any query landing *inside* that run by ±w, and choosing the odd or even half by a coin flip makes that perturbation zero-mean. Errors from independent compactions add in variance rather than in magnitude, which is where the `√` in every bound comes from.

The decisive design question is therefore not how compaction works. It is **which items a compactor is allowed to compact.** That single choice determines the shape of your guarantee, and everything else is bookkeeping.

KLL lets every compactor compact its whole buffer. Every rank is equally exposed, so the error is uniform across the distribution — additive, ±εn. That is the right answer if you want the median. It is the wrong answer if you want the tail, because the tail's *interesting scale* shrinks as you go out while the error bar does not.

## Why additive error costs you four orders of magnitude

Suppose you want 10% relative accuracy on the rank at quantile q. The tail above q holds n(1−q) items, so you need εn ≤ 0.1·n(1−q), i.e. ε ≤ 0.1(1−q). Since additive sketches cost Θ(1/ε) items, the price of a fixed *relative* accuracy under an *additive* guarantee is 1/(0.1(1−q)) — it grows without bound as you push into the tail. At n = 10⁷:

| q | items in tail | required ε | KLL items ≈ 1/ε |
|---|---|---|---|
| 0.9 | 1,000,000 | 1.0×10⁻² | 100 |
| 0.99 | 100,000 | 1.0×10⁻³ | 1,000 |
| 0.999 | 10,000 | 1.0×10⁻⁴ | 10,000 |
| 0.9999 | 1,000 | 1.0×10⁻⁵ | 100,000 |

Pushing from p99 to p99.99 costs 100× the memory — *per time series*. Multiply by a few million series and the additive guarantee is why nobody trusts their p99.9.

## The measurement: 52% error on the value that matters

Rank error is the sketch's internal currency, but nobody pages on a rank. They page on a *value*: "p99.9 latency in milliseconds." So I measured that directly — the relative error of the returned value — over a lognormal(0, 1.4) latency stream, n = 2×10⁶, 3 trials, against an exactly-computed ground truth. KLL at k = 800 (1529 stored items) versus a from-scratch DDSketch at α = 0.01 (629 buckets, *less* memory):

| quantile | KLL rel err | (worst) | DDSketch rel err | (worst) |
|---|---|---|---|---|
| 0.5 | 0.0013 | 0.0024 | 0.0089 | 0.0092 |
| 0.9 | 0.0090 | 0.0150 | 0.0047 | 0.0066 |
| 0.99 | 0.0559 | 0.1012 | 0.0045 | 0.0055 |
| 0.999 | 0.0571 | 0.1399 | 0.0060 | 0.0078 |
| 0.9999 | **0.5197** | **0.5802** | 0.0060 | 0.0095 |

KLL is 4× more accurate than DDSketch at the median and then degrades monotonically until, at p99.99, it reports a latency off by 52% — while using 2.4× more memory. DDSketch honors its α = 0.01 bound at every quantile, including the ones you actually alert on. Both are behaving exactly as specified. One specification matches the query pattern and the other doesn't.

## Two different things called "relative error"

Here is the distinction that gets lost, and it is the one worth internalizing:

**DDSketch** (Masson, Rim & Lee, PVLDB 2019) buckets values logarithmically: index `i = ⌈log_γ x⌉` with γ = (1+α)/(1−α), reporting the bucket midpoint `2γⁱ/(γ+1)`. Its guarantee is relative in the **value**: |x̂ − x| ≤ αx. It answers *"how slow is p99.9?"* to within 1%.

**ReqSketch** (Cormode, Karnin, Liberty, Thaler & Veselý, JACM) is relative in the **rank**: |R̂(x) − R(x)| ≤ ε·R(x). It answers *"what fraction of requests were slower than my 200ms SLO?"* to within 1% *of that fraction* — so 0.05% comes back as 0.05%, not as 0 ± 0.1%.

These are not interchangeable, and neither implies the other. A value-relative sketch has no rank guarantee in the tail; a rank-relative sketch has no value guarantee. DDSketch also pays a structural cost the asymptotics hide: its bucket count scales with the *dynamic range* log_γ(max/min), which is unbounded for unbounded input — hence the collapsing variants and UDDSketch's fix, which restores the guarantee across the full range that plain collapse breaks. Pick based on which question you page on.

## Where the theory landed, and why it took so long

Rank-relative sketching has a live and recently-moving space bound. ReqSketch needs Õ(ε⁻¹log^1.5(εn)) stored items. At SODA 2025, Gribelyuk, Sawettamalya, Wu and Yu got it to Õ(ε⁻¹log(εn)) — matching the trivial Ω(ε⁻¹log(εn)) lower bound up to lower-order factors — via an **elastic compactor** that can be *resized mid-stream*, plus a scheme that allocates space across compactors according to the observed hardness of the stream, so not every compactor must be provisioned for its worst case at once. The saving is the √log factor: at εn = 10⁶ that's ~890 items versus ~199, a 4.5× reduction. (A November 2025 follow-up by Domes and Veselý recovers most of the practical benefit with *adaptive* compactors while keeping ReqSketch's simpler mergeability proof.)

I tried to build a tail-accurate compactor from scratch before reading closely, on the obvious intuition: protect the largest items, compact only a bottom prefix, so tail queries fall inside a compacted region only rarely. It doesn't work. My first version silently violated its own invariant — a "must free space" fallback that compacted the entire buffer, destroying the protected section — and fixing that made the deep tail *worse*, not better: relative error at p99.99 went from 3.7 to 6.5. The reason is instructive. Protecting a fixed top-k per event is not an invariant at all, because the buffer keeps receiving new items; the largest values still migrate upward through the levels and acquire large weights. What you need is a *schedule* — a rule for how deep to compact on the j-th compaction such that an item at rank-distance d from the top is only ever compacted O(log) times at bounded weight. The schedule **is** the algorithm. That is why a near-optimal bound was a SODA paper and not an afternoon.

## What to do on Monday

Check what your metrics backend actually stores. If it is a `t-digest`, note that Cormode, Mishra, Ross and Veselý (KDD 2021) constructed adversarial inputs on which its accuracy breaks outright — it has no worst-case guarantee, only empirical good behavior. If it is KLL or GK, your medians are excellent and your published tail percentiles carry an error bar the size of the tail. If you alert on latency thresholds, you want value-relative (DDSketch, or a log-linear histogram like circllhist). If you alert on *fractions* — error budgets, SLO burn rates — you want rank-relative (ReqSketch), and it must be configured for the correct end: implementations expose the choice explicitly, because a sketch tuned for low-rank accuracy is precisely the wrong one for your tail.

The sketch is not lying to you. It is answering a different question than the one on the dashboard.
