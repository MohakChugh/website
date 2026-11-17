---
title: "Bucketed Approximate Top-k, Audited: XLA's approx_max_k Allocates 2.1–3.5× the Bins It Needs, Error at b·kb = k Is a Poisson PMF, and Interleaved Buckets Keep 128 of 7,380 Outlier Activations"
date: 2026-11-17
tags: ["top-k", "gpu", "probability", "llm-inference", "simulation"]
excerpt: "Bucketed approximate top-k splits a vector into b buckets, keeps the top kb of each, and optionally runs an exact top-k on the survivors. I checked Key et al.'s recall model (arXiv:2412.04358) by Monte Carlo and audited XLA's bin-sizing code. XLA sizes bins with a model that overstates the error by about 2×, so for N = 2^20 it allocates 2.1–3.5× the bins needed and delivers 0.29–0.47× the requested error. When b·kb = k the expected error is exactly the Poisson(kb) PMF at its mean, about 1/√(2π·kb), so raising kb with no slack in the candidate budget improves recall slowly. Interleaved buckets, the paper's recommended assignment, alias with power-of-two row strides. On a 1024×4096 activation matrix with 8 outlier channels they keep 128 of 7,380 top-k outlier elements and capture 60% of the top-k mass, against 95% for a random assignment. A one-line skewed interleave fixes it."
---

# Bucketed Approximate Top-k, Audited: XLA's approx_max_k Allocates 2.1–3.5× the Bins It Needs, Error at b·kb = k Is a Poisson PMF, and Interleaved Buckets Keep 128 of 7,380 Outlier Activations

Exact top-k parallelizes badly: the k winners must be agreed across the whole vector via radix passes, shared queues or merge trees. Approximate top-k removes that cooperation. **Key, Ribar, Cattaneo, Hudlass-Galley and Orr** (UCL / Graphcore, *Approximate Top-k for Increased Parallelism*, arXiv:2412.04358, NeurIPS ENLSP 2024) study the family that all bucketed approaches belong to:

1. **Stage 1:** split the n inputs into b *interleaved* buckets (`bucket(i) = i mod b`) and keep the top kb of each bucket.
2. **Stage 2:** if b·kb > k, run an exact top-k over the b·kb survivors.

TPU-KNN (`jax.lax.approx_max_k`) uses kb = 1 and finishes with a bitonic sort. The FAISS variant sets b·kb = k and has no Stage 2. The paper's CUDA kernel caps kb ≤ 4 so that each bucket's priority queue fits in registers. It reports >4× faster top-k inside SparQ Attention with little or no accuracy loss.

## The recall model holds and is conservative

Let Z be the number of true top-k values that survive Stage 1. Stage 2 can't lose any of them, because they're in the global top-k. Take the top values in descending order. The i-th one (0-indexed) is lost only if its bucket already holds kb larger winners. Treating bucket choice as uniform and independent gives the paper's Eq. (1):

```python
from scipy.stats import binom
import numpy as np

def eq1_err(k, b, kb):                       # 1 - E[recall]
    i = np.arange(kb, k)
    return 1 - (kb + binom.cdf(kb - 1, i, 1 / b).sum()) / k
```

Monte Carlo of Stage 1 on uniform data (n = 2^16 with 2,000 trials; n = 2^20 with 10 trials):

| k | b | kb | b·kb/k | bucket size | Eq. (1) error | measured |
|---|---|---|---|---|---|---|
| 256 | 256 | 1 | 1 | 256 | 0.3672 | 0.3663 ± 0.0004 |
| 256 | 1024 | 1 | 4 | 64 | 0.1148 | 0.1127 ± 0.0004 |
| 256 | 128 | 2 | 1 | 512 | 0.2696 | 0.2693 ± 0.0004 |
| 2^17 | 2^16 | 2 | 1 | 16 | 0.2707 | 0.2534 |
| 2^17 | 2^15 | 4 | 1 | 32 | 0.1954 | 0.1829 |
| 2^17 | 2^16 | 4 | 2 | 16 | 0.0376 | 0.0264 |

When k ≪ n the model is within 0.002 of the measurement. In the sparsity regime (k = n/8) the buckets hold only 16–64 elements. A bucket with many winners then has fewer slots left for the next one, so the measured error falls below Eq. (1), by up to 30% at b·kb/k = 2. The paper says Eq. (1) becomes an upper bound when kb ≪ n/b no longer holds, and the data agrees.

## XLA sizes its bins with the pessimistic model

The paper notes that TPU-KNN's recall formula is "overly pessimistic", and that formula is the one XLA uses. In `xla/hlo/builder/lib/approx_topk_shape.cc`, `ApproxTopKReductionOutputSize` says:

```cpp
//   recall = (1 - 1/M)^{K - 1}   ~=  EXP((1 - K) / M)
//   => M = (1 - K)/LOG(recall)
uint64_t m = std::min<uint64_t>(std::max(
    static_cast<uint64_t>((1.0 - top_k) / std::log(recall_target)),
    tpu_tiling), logical_input_size);
uint32_t log2_reduction = log2_floor(logical_input_size / m);
```

`(1 - 1/M)^(K-1)` is the probability that a winner has its bucket to itself. With kb = 1, though, a bucket holding two winners still returns one of them. Recall is really the expected number of *distinct occupied buckets* divided by K, which is (M/K)(1 − (1 − 1/M)^K). Expand both for K ≪ M:

- XLA's model: error ≈ (K − 1)/M
- actual: error ≈ (K − 1)/(2M)

The formula overstates error 2×, so it allocates 2× the bins; `log2_floor` then rounds the reduction to a power of two, with a 128-lane floor. I ported the code to Python, computed exact recall for fixed-size buckets (without replacement), and searched for the smallest M that reaches the target:

| K | target | XLA's M | actual recall | M needed | over-provisioning |
|---|---|---|---|---|---|
| 10 | 0.95 | 256 | 0.9826 | 88 | 2.91× |
| 100 | 0.95 | 2,048 | 0.9763 | 958 | 2.14× |
| 100 | 0.99 | 16,384 | 0.9970 | 4,918 | 3.33× |
| 1,000 | 0.95 | 32,768 | 0.9854 | 9,655 | 3.39× |

(N = 2^20, rank-2 operand. M is the Stage-1 output width.)

Over nine (K, target) pairs, the model's continuous M is 1.99–2.04× the M actually needed, and power-of-two rounding brings the total to 2.1–3.5×. The delivered error is 29–47% of the request. The caller always gets better recall than asked for, so nothing breaks, but every extra bin is another Stage-2 candidate written to HBM. Halving `m` would make the formula match the algorithm; the power-of-two tiling would stay.

## At b·kb = k, the error is a Poisson PMF

In the sparsity regime (k ∝ n) Stage 2 is expensive, so the paper recommends holding b·kb = k and raising kb. Eq. (1) then has a closed form. The number of winners per bucket X is approximately Poisson(λ) with λ = k/b = kb. Each bucket loses (X − kb)⁺ of them, so

```
error = (b/k) · E[(X − kb)⁺]
      = (1/kb) · kb · P(X = kb − 1)      # E[(X−c)⁺] = λ·P(X ≥ c−1) − c·P(X ≥ c), λ = c
      = P(X = kb) = e^(−kb) · kb^kb / kb!  ≈ 1/√(2π·kb)
```

The last step uses P(c − 1) = P(c) for Poisson(c). The closed form matches Eq. (1) to four decimal places at k = 2^17:

| kb | 1 | 2 | 4 | 8 | 16 |
|---|---|---|---|---|---|
| e^(−kb)·kb^kb/kb! | 0.3679 | 0.2707 | 0.1954 | 0.1396 | 0.0992 |
| 1/√(2π·kb) | 0.3989 | 0.2821 | 0.1995 | 0.1410 | 0.0997 |

So with no slack, the error falls only as kb^(−1/2). Going from kb = 1 to the register-friendly cap of 4 halves it, to 19.5%, and reaching 5% would take kb ≈ 64. Slack is much cheaper: kb = 4 with b·kb = 2k measures 2.6%. That k ∝ n tasks tolerate b·kb = k at all fits the paper's framing: SparQ's top-k is already a heuristic.

## Where interleaving breaks: strides that share a factor with b

The paper's Appendix A.1 shows interleaving fixes the recall that contiguous buckets lose on sequence-correlated data. It doesn't test interleaving's own failure mode. Take a row-major matrix of shape [T, d] and flatten it. Element (t, c) lands in bucket (t·d + c) mod b. If gcd(b, d) is large, as it is whenever both are powers of two, column c only ever reaches b/gcd(b, d) buckets. LLM activations with massive-activation channels have exactly this shape, as do weight matrices with outlier columns.

I built a 1024×4096 matrix of |N(0, 1)| values, scaled 8 random channels by 20, and ran top-k over the flattened matrix, measuring recall and the share of true top-k mass captured:

| assignment | k = n/64, kb = 1 | k = n/64, kb = 2 | k = n/8, kb = 4 |
|---|---|---|---|
| interleaved `i % b` | recall 0.590, **mass 0.605**, outliers kept 128 | 0.681, **0.622**, 128 | 0.812, **0.906**, 1,024 |
| contiguous | 0.637, 0.962, 7,337 | 0.733, 0.979, 7,344 | 0.817, 0.976, 7,667 |
| `i % p`, p prime ≤ b | 0.634, 0.946, 6,809 | 0.732, 0.979, 7,341 | 0.817, 0.976, 7,675 |
| random permutation | 0.634, 0.949, 6,947 | 0.730, 0.978, 7,304 | 0.818, 0.976, 7,657 |

The top-k at k = n/64 holds 7,380 outlier elements. Interleaving keeps exactly 8·kb·b/gcd(b, d) = 128 of them. Recall drops only 4–5 points, since near-threshold values fill the freed slots, but *mass* drops about 35 points, because the lost winners are the largest values in the matrix. For magnitude pruning or activation sparsity, mass is what counts.

Two cheap remappings, tested on a fresh draw of the same setup:

```python
(i * 0x9E3779B1) % b        # mass 0.602, kept 128: low bits of i*odd depend only on low bits of i
(i + 977 * (i // b)) % b    # mass 0.962, kept 7,361: every bucket still gets exactly n/b elements
```

Multiplicative hashing fails when b is a power of two. The *skewed interleave*, which cyclically shifts each pass of b elements by an odd stride, works. Bucket sizes stay exactly equal, each pass still reads one contiguous span of b elements, and a column now reaches up to T buckets instead of 16. Any bucketed top-k whose bucket count shares a large factor with the inner dimension has this problem, and on GPUs that is the usual case.
