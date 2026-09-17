---
title: "Grafite: Range Filters That Survive Adversarial Queries"
date: 2026-09-17
tags: ["data-structures", "filters", "hashing", "storage", "databases"]
excerpt: "Range filters answer 'does any key fall in [a,b]?' with one-sided error — and almost every practical design (SuRF, SNARF, Proteus) collapses to a 100% false-positive rate when queries land near keys. Grafite (SIGMOD '24) fixes this with a locality-preserving hash into a reduced universe plus an Elias-Fano predecessor structure: log(L/ε)+2 bits per key, O(1) queries, and an FPR bound of ℓ/2^(B−2) that holds for any workload. A from-scratch reimplementation reproduces the paper's worked example, confirms the bound within sampling noise, and shows the true FPR is 1−e^(−ℓ/2^(B−2)) — the union bound's saturation at 1.0 hides a measurable 0.632."
---

# Grafite: Range Filters That Survive Adversarial Queries

A Bloom filter answers "is key x in the set?" with no false negatives and a tunable false-positive rate. LSM-based key-value stores lean on this to skip SSTables during point lookups. But range scans — `SELECT ... WHERE ts BETWEEN a AND b` — get no help: a Bloom filter over keys can't tell you whether *any* key lands in `[a, b]` without probing every point in the range. That's the **approximate range emptiness problem**: given n keys from universe [u], answer "[a,b] ∩ S ≠ ∅?" with one-sided error at most ε.

A decade of practical range filters attacked this heuristically — SuRF (truncated tries), SNARF (learned CDF models over a bitvector), Rosetta (per-prefix-length Bloom filters), Proteus (trie + prefix Bloom hybrid, auto-tuned on a query sample), REncoder (encoded binary trees in a bit array). **Grafite** (Costa, Ferragina, Vinciguerra, SIGMOD 2024, [arXiv:2311.15380](https://arxiv.org/abs/2311.15380)) makes an uncomfortable observation about all of them: none bounds the false-positive probability without assumptions on the data and query distribution. And the assumption that breaks in practice is *correlation* — queries whose endpoints land near existing keys.

## Why correlation kills heuristic filters

Correlated queries aren't exotic. Time-series workloads ask "any events just after this one?"; secondary-index probes cluster near real values; and an adversary who knows a subset of your keys can manufacture them at will, driving your filter's FPR toward 1 and turning it into a disk-access amplifier — the exact failure it was deployed to prevent.

The mechanism is structural. SuRF stores each key's shortest distinguishing prefix: a query range adjacent to a stored key shares that prefix, so the trie can't rule it out. SNARF maps keys through a monotonic CDF estimate into a sparse bitvector: a query just past key k lands on or next to k's 1-bit. In the paper's correlation sweep (uniform 64-bit keys, query start drawn from [k, k + 2^30(1−D)] for correlation degree D), SuRF, SNARF, and REncoderSS reach FPR ≈ 1 beyond D = 0.4. Proteus degrades more gracefully only because it's auto-tuned — overfitted — to a workload sample, which buys nothing after a shift. Rosetta stays robust but pays with queries up to three orders of magnitude slower.

## The construction: hash, then Elias-Fano

Grafite is disarmingly simple, building on a theoretical result of Goswami et al. that also proved the space floor: any range filter for max range size L needs about n·log₂(L/ε) bits. The trivial solution — a point filter with FPR ε/L, probed at all ℓ points of the query — already matches that space but costs O(L) per query. Grafite keeps the space and fixes the time.

**Step 1: reduce the universe with a locality-preserving hash.** Set r = nL/ε and pick q from a pairwise-independent family (the textbook `((c₁x + c₂) mod p) mod r`). Define:

```
h(x) = (q(⌊x/r⌋) + x) mod r
```

Within a block of r consecutive integers, h is just a shifted identity — it preserves order and gaps exactly. Distinct blocks get independently random shifts. So a query range [a,b] (with ℓ ≤ L ≪ r) maps to a range in the reduced universe [r]: check whether any hash code lands in [h(a), h(b)], with a wrap-around case when the modulo splits the interval:

```
not_empty([a,b]):
  ha, hb = h(a), h(b)
  if ha <= hb: return predecessor(hb) >= ha
  else:        return min_code <= hb or max_code >= ha
```

A false positive requires some stored key's hash to collide into the query's hashed range, which by pairwise independence happens with probability ≤ 1/r per (key, point) pair. Union bound over n keys and ℓ points: **FPR ≤ nℓ/r = ℓε/L**. No assumption anywhere about how keys or queries are distributed — the randomness lives entirely in the hash seed.

**Step 2: store the hash codes in Elias-Fano.** The sorted, deduplicated codes z₁…zₙ ∈ [r] split into low parts (the ⌊log₂(L/ε)⌋ low bits, stored flat) and high parts (unary-coded in a bitvector of n + zₙ/2^l bits). Total: **n·log₂(L/ε) + 2n + o(n) bits** — matching the lower bound's leading term with a +2 constant. `predecessor(y)` runs a select on the high bitvector to find the O(L/ε)-sized bucket sharing y's high bits, then binary-searches the low parts: O(log(L/ε)) time, independent of n and u. Fix the space budget at B bits per key and everything collapses to one clean statement: **queries cost O(B) and FPR ≤ min{1, ℓ/2^(B−2)}** for whatever range size ℓ the application throws at it.

## Reimplementing it: the bound holds, and it's a union bound

I reimplemented Grafite in ~40 lines of Python (hash + sorted codes + `bisect` as the predecessor structure, including the paper's footnote-2 block-boundary split). First sanity check: the paper's worked example (10 keys, r = 100, c₁ = 10, c₂ = 5, p = 2³¹−1) reproduces exactly — h(S) = {14, 53, 55, 6, 51, 94, 70, 91, 32, 66}, and the query [44, 47] returns the same false positive the authors trace through their Figure 2.

Then the bound, with n = 50,000 keys uniform in 2^40 and 200k *empty* queries per cell — half uncorrelated, half adversarial (start just past a random stored key, offset < 64):

| B | ℓ | uncorrelated FPR | adversarial FPR | bound ℓ/2^(B−2) |
|---|------|--------|--------|--------|
| 12 | 1 | 9.9e-4 | 1.1e-3 | 9.8e-4 |
| 12 | 32 | 3.1e-2 | 3.2e-2 | 3.1e-2 |
| 12 | 1024 | 0.632 | 0.634 | 1.0 (saturated) |
| 16 | 32 | 2.1e-3 | 2.0e-3 | 2.0e-3 |
| 16 | 1024 | 6.1e-2 | 5.9e-2 | 6.3e-2 |

Two things worth reading off. First, the adversarial column equals the uncorrelated column everywhere — the robustness claim isn't asymptotic hand-waving; correlation simply doesn't appear in the failure analysis. (A Bucketing-style heuristic at the same 16 bits/key measured 0.000 uncorrelated and **0.976** adversarial on the same queries.) A few cells sit a hair above the bound; at these query counts that's Poisson noise on a dozen expected positives, and the bound is an expectation over hash seeds besides.

Second, the saturated row is more informative than it looks. The paper's bound is a union bound over nℓ collision events, each with probability 1/r. Treating them as independent gives the sharper estimate **FPR ≈ 1 − e^(−nℓ/r) = 1 − e^(−ℓ/2^(B−2))**. At B = 12, ℓ = 1024 that predicts 1 − e^(−1) = 0.6321 — the measured 0.632 to three digits. At B = 16, ℓ = 1024 it predicts 0.0606 against a measured 0.0605. So when you're sizing a filter near its operating limit, the union bound overstates the damage: exceeding the "FPR = 1" regime by a factor of two still filters ~13% of empty queries, and the exponential model tells you exactly what you keep.

## Where this sits in a system

The trade Grafite makes is honest and worth naming. The space cost scales as log₂(L/ε): guarding large ranges cheaply is impossible — for anyone, by the lower bound — so at 16 bits/key you get ε = 2^-14 for point-ish queries but only ~6% filtering at ℓ = 1024. Heuristic filters *can* beat that on friendly workloads: SNARF spends log₂K + 2.4 bits with FPR ≈ 1/K independent of L — under uniform-and-uncorrelated assumptions that an adversary, or an innocent time-series dashboard, will violate. Grafite is also static: Elias-Fano doesn't absorb inserts, which suits LSM levels (rebuilt on compaction anyway) but not write-hot memtables.

The authors' own experiments (200M-key datasets, the largest range-filter comparison to date) show the design costs little even where it has no structural advantage: among robust filters it wins FPR by up to five orders of magnitude with 9–92× faster queries than Rosetta and REncoder, and its construction — hash, sort, encode — beats every competitor's. The deeper lesson generalizes past range filters: a data structure whose guarantee is conditioned on the workload is a latent incident, and here the unconditional version costs two bits per key over the information-theoretic floor. That's a cheap price to never think about query distribution again.
