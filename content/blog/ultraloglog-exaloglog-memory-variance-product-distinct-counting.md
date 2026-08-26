---
title: "What Comes After HyperLogLog: Registers That Stop Throwing Information Away"
date: 2026-08-26
tags: ["sketches", "cardinality-estimation", "data-structures", "databases", "information-theory"]
excerpt: "HyperLogLog's 6-bit register keeps one number and discards everything else the hash told you. UltraLogLog spends two more bits per register to remember what it used to forget, and ExaLogLog generalizes the base to fractional leading-zero resolution. I re-derived both papers' space-efficiency numbers from the closed form to check the 43% claim."
---

`APPROX_COUNT_DISTINCT` is HyperLogLog in essentially every column store you can name — Presto, BigQuery, Redshift, ClickHouse, Druid, Snowflake. It has been the default for fifteen years, and not because it's optimal: it's *mergeable, idempotent, commutative, constant-time to insert, and reducible to lower precision*, the five properties a sketch needs to be computed per-partition and unioned in a shuffle.

The recent result is that you can keep all five and cut the space by 43%. Two papers by Otmar Ertl do it: **UltraLogLog** (VLDB 2024) and **ExaLogLog** (EDBT 2025). Both are drop-in replacements, and both come down to one observation about what HLL's register discards.

## The currency: memory–variance product

Comparing sketches by bytes or by error rate alone is meaningless — you can always trade one for the other. The invariant is the **memory–variance product**:

```
MVP = Var(n̂ / n) × (storage size in bits)
```

Relative variance falls as `1/m` and storage grows as `m`, so the product is a constant of the *design*, not the tuning — the exchange rate for bits per unit of squared relative error.

For sketches whose registers store a maximum over geometrically-distributed update values with base `b`, plus `d` extra bits of side information, the asymptotic MVP under a maximum-likelihood estimator is

```
MVP ≈ (q + d) · ln b / ζ(2, 1 + b^(−d)/(b − 1))
```

where `q` is the bits holding the maximum and `ζ(2, a)` is the Hurwitz zeta function. HLL is the `b = 2, q = 6, d = 0` corner of this family. Plug it in:

```python
from math import log, pi

def hurwitz_zeta2(a, terms=2_000_000):
    s = sum(1.0 / (a + k) ** 2 for k in range(terms))
    return s + 1.0 / (a + terms)          # integral tail correction

def mvp(q, d, b=2.0):
    return (q + d) * log(b) / hurwitz_zeta2(1.0 + b ** -d / (b - 1.0))

def mvp_martingale(q, d, b=2.0):
    return (q + d) * log(b) / 2.0 * (1.0 + b ** -d / (b - 1.0))

assert abs(hurwitz_zeta2(2.0) - (pi * pi / 6 - 1)) < 1e-12   # zeta(2,2) sanity check
print(mvp(6, 0))    # 6.4485  <- HyperLogLog, 6-bit registers
```

HLL sits at **6.4485**. The conjectured lower bound for any mergeable, reproducible sketch is **1.98** — HLL leaves a factor of 3.3 on the table, in a very specific place.

## The information HLL throws away

HLL's update is four lines: take a 64-bit hash, use the top `p` bits as a register index, count leading zeros of the rest, keep the max.

```python
i = h >> (64 - p)                      # register index
a = h & ((1 << (64 - p)) - 1)          # residual bits
k = nlz(a) - p + 1                     # update value, geometric with base 2
reg[i] = max(reg[i], k)                # 6 bits is enough for k <= 65 - p
```

A register holding `k = 6` says some element hashed into bucket `i` with five leading zeros. It says *nothing* about whether `k = 5`, `k = 4`, `k = 3` also landed there — events that are far more likely and carry real information about `n`. HLL observes them and drops them on the floor, once per insert, forever.

**UltraLogLog keeps two of them.** Registers become 8 bits: the top 6 hold the maximum update value `u`, the bottom `d = 2` are occurrence flags for `u − 1` and `u − 2`:

```
r = 4·u + ⟨l₁ l₂⟩₂

⟨00011010⟩₂  →  u = 6, l₁ = 1, l₂ = 0
                "max is 6; a 5 has occurred; a 4 has not (yet)"
```

Inserting a value of 8 slides the flag window with the maximum: the state becomes `⟨00100001⟩₂` — `u = 8`, no 7 seen, a 6 seen (the old maximum). Because `u ≤ d` leaves fewer meaningful flag bits, some encodings are unreachable; the four smallest legal states are `{0, 4, 8, 10}`.

That costs 2 bits per register and buys `MVP = 4.6313` — **28% less space for the same error** — and it is barely a cost, because HLL's 6-bit registers are not free: packing them densely into a byte array means shifts, masks, and a branch for registers straddling a byte boundary. UltraLogLog's registers *are* bytes. Inserts are branch-free and direct-indexed; equal-precision merges are a byte-wise fold that vectorizes cleanly.

## You need a different estimator

HLL's harmonic-mean estimator has no idea what to do with flag bits. The replacement is the **FGRA** (further generalized remaining area) estimator, which sums over registers a weight for the update values the state *proves did not occur*:

```
n̂ = m^(1 + 1/τ) · (Σ g(rᵢ))^(−1/τ) · (1 + ((1+τ)/2)(v/m))^(−1)

g(r) = 2^(−τ⌊r/4⌋) · η_(r mod 4)
```

The trick is that `η₀…η₃` are not derived from `τ` — they're four free parameters, and you numerically minimize variance over all five. The optimum is `τ ≈ 0.8195`, `v ≈ 0.6119`, `η ≈ (4.6631, 2.1379, 2.7811, 0.9824)`, giving `MVP = 8v ≈ 4.8951` — 94.6% of what full maximum likelihood extracts, at HLL-comparable speed. In practice `g` is a 256-entry lookup table indexed by the register byte, one `pow` at the end, and closed-form ML corrections for the two extreme ranges (replacing HLL's linear counting) that splice in smoothly instead of switching estimators at a threshold.

## ExaLogLog: fractional leading-zero resolution

ExaLogLog generalizes the *base*: `b = 2^(2^−t)` instead of `2`, so update values advance in fractional powers of two. You consume `t` extra hash bits as a sub-step offset, giving the leading-zero count `2^t` times finer granularity, and `q = 6 + t` keeps the range at `2^64`. Registers are `6 + t + d` bits, with `d` flags covering `[u − d, u − 1]`. The insert is still allocation-free straight-line code:

```python
i = (h >> t) & (m - 1)                            # register index
a = (h >> (p + t)) << (p + t) | ((1 << (p+t)) - 1)
k = nlz(a) * (1 << t) + (h & ((1 << t) - 1)) + 1  # fractional-base update value
u, lo = reg[i] >> d, reg[i] & ((1 << d) - 1)
delta = k - u
if delta > 0:
    reg[i] = (k << d) | (((1 << d) | lo) >> delta)   # slide the flag window
elif delta < 0 and d + delta >= 0:
    reg[i] |= 1 << (d + delta)                        # backfill a flag
```

The flag window slides by a *shift*, and flags falling off the end are lost — bounded, analyzable lossiness. Merging is a bitwise fold; reducing `d` is a right shift; reducing `p` folds `2^(p−p′)` registers.

Run the closed form across the family:

| Configuration | bits/reg | MVP (ML) | MVP (martingale) |
|---|---|---|---|
| HLL | 6 | 6.4485 | 4.1589 |
| HLL, byte-aligned | 8 | 8.5981 | 5.5452 |
| UltraLogLog `d=2` | 8 | **4.6313** | **3.4657** |
| UltraLogLog `d=3` | 9 | 4.4940 | 3.5091 |
| ExaLogLog `t=1,d=9` | 16 | 3.9025 | 3.0684 |
| ExaLogLog `t=2,d=16` | 24 | 3.7843 | **2.7663** |
| ExaLogLog `t=2,d=20` | 28 | **3.6732** | 2.8267 |
| conjectured floor | — | 1.98 | 1.63 |

`3.6732 / 6.4485 = 0.5696` — the 43% claim, reproduced rather than taken on trust. (`t=2, d=20` is 28 bits, packing as two registers per 7 bytes; `t=2, d=24` at 32 bits costs 3% more MVP and buys word-aligned atomic CAS updates, usually the better trade for a concurrent sketch.)

## The martingale column is a different problem

If you never merge, you can use the **martingale/HIP** estimator, which accumulates `1/μ` on every state-changing update instead of estimating from the final state. Its MVP obeys a different closed form, `((q+d)·ln b / 2)(1 + b^(−d)/(b−1))`, and ranks configurations differently: at `b = 2`, `d = 2` is optimal and `d = 3` is *worse* (3.4657 vs 3.5091) even though `d = 3` wins under ML. Extra flag bits help a state-based estimator and merely dilute a martingale one.

That asymmetry is the decision point. Mergeability is not free — it costs the gap between 1.63 and 1.98 in the bound, and roughly 0.9 MVP in real configurations. If your sketches are per-shard artifacts that get unioned, pay it. If they're single-writer counters behind a metrics endpoint, don't.

The other axis is entropy. UltraLogLog's register distribution is *lower*-entropy than HLL's despite being wider, so generic compressors do better on it: under ideal lossless compression it reaches 2.3122 against HLL's 3.0437. This is why serialized-size comparisons flip some rankings — CPC's compressed footprint is excellent and its in-memory footprint is not.

None of this changes your query plan. It changes a constant in front of your sketch storage by a factor of ~1.75, on a structure that large fleets keep billions of copies of, with a reference implementation in Dynatrace's `hash4j`. Cheap win for a fifteen-year-old default.
