---
title: "Batched Dice Rolls Audited: Six Fisher–Yates Indices From One 64-bit Word, and Where the 2× Goes"
date: 2026-11-03
tags: [algorithms, random-numbers, performance, shuffling, arm64]
excerpt: "Brackett-Rozinsky and Lemire extend the nearly-divisionless bounded-random method to draw several dice from one 64-bit word with one multiply each. I checked their theorem exhaustively: 0 biased cases out of 122,695 dice tuples at 8–12-bit word sizes. Two plausible-looking acceptance rules are biased in 92–94% of tuples. Their Table 2 cost model reproduces to the integer. On an M3 Pro the shuffle speedup with an inlined Lehmer generator is 1.38–1.45×, not 1.5–2.3×. Calling the generator out of line gives 2.2–2.8×. A system CSPRNG gives up to 5.3×, within 2–11% of the call-count ceiling. Out of cache, the Lehmer gain disappears (1.0×)."
---

# Batched Dice Rolls Audited

Lemire's "nearly divisionless" bounded-random method ships in libstdc++, the MSVC STL, Linux, Go, Swift, Julia, C# and Zig. It does one full-width multiply `b ⊗ r = (hi, lo)`, returns `hi`, and rejects only if `lo < 2^64 mod b`. That threshold needs a division only when `lo < b`, which is rare.

*Batched Ranged Random Integer Generation* (Brackett-Rozinsky & Lemire, *Software: Practice and Experience* 55(1), arXiv:2408.06213) takes this one step further. If `b₁·b₂·…·b_k ≤ 2^64`, one 64-bit word can produce all k dice, each with one multiply and no division. Fisher–Yates needs one die per element, so a shuffle needs up to k× fewer generator calls. The paper reports "more than double" shuffle speed.

I checked the theorem exhaustively, recomputed the batch-size model, and benchmarked on an Apple M3 Pro, including out-of-cache sizes.

## The trick

Multiply the leftover low word by the next die size, over and over:

```c
// (a_i, r_i) = b_i ⊗ r_{i-1};  accept iff r_k >= 2^64 mod (b_1⋯b_k)
uint64_t r = rng();
for (int i = 0; i < k; i++) {
    __uint128_t x = (__uint128_t)b[i] * r;
    a[i] = (uint64_t)(x >> 64);   // die i, in [0, b[i])
    r    = (uint64_t)x;           // fractional bits carried forward
}
if (r < bound) { /* rare: compute exact product B, t = -B % B, reroll while r < t */ }
```

The proof works by induction: `(b₁⋯b_i) ⊗ r₀ = (c_i, r_i)`, where `c_i` is the mixed-radix number with digits `(a₁,…,a_i)`. After k steps, the sequence of multiplies has computed **one** Lemire draw against the product `B = ∏b_i`, without ever forming `B`. Lemire's criterion on the final `r_k` makes `c_k` uniform on `[0, B)`. The digits of a uniform mixed-radix number are independent and uniform. You only need `B` itself, and one division, when `r_k` falls below an upper bound `u ≥ B`.

## Exhaustive check, and two plausible wrong rules

The theorem holds for any word width L, so small L can be tested exhaustively. At L = 8, 10 and 12, I enumerated every 2- and 3-die tuple with `b_i ≥ 2` and `∏b_i ≤ 2^L`, ran all `2^L` words through the multiply chain, and checked that each accepted outcome appears equally often. I also tested two rules a hurried implementer might write:

- **last-die**: reject iff `r_k < 2^L mod b_k`. This copies the single-die code and uses the last die's size.
- **per-step**: apply Lemire's criterion after every multiply, `r_i ≥ 2^L mod b_i`. It looks strictly more cautious.

| L | tuples | paper rule biased | last-die biased | per-step biased |
|---|---|---|---|---|
| 8 | 2,460 | 0 | 1,957 | 2,051 |
| 10 | 16,843 | 0 | 14,841 | 15,401 |
| 12 | 103,392 | 0 | 96,098 | 97,524 |
| **all** | **122,695** | **0** | **112,896 (92.0%)** | **114,976 (93.7%)** |

The per-step rule matters most. Checking every intermediate remainder feels safe, but it is wrong in 94% of cases. Each step's remainder isn't uniform given the earlier accepts, so per-die thresholds don't compose. The only valid threshold is the one for the product. The tuples that survive the wrong rules are mostly powers of two, where every threshold is 0.

## The cost model reproduces to the integer

To choose batch sizes, the paper models the cost per die with an RNG call costing 2 multiplies and a division costing 16:

```
c_avg(k, n) = (1/k) · [ (c_rng + k)/(1 − p₂) + (c_div + k − 1)·p₁ ]
p₁ = n^(k falling)/2^L,   p₂ = (2^L mod n^(k falling))/2^L
```

n_k is the largest n for which batches of k beat batches of k−1 at every size up to n. I scanned every n with the exact `p₂`, which jitters because it is a modulus:

| k | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|
| L=64 (mine = paper) | 1,358,187,913 | 929,104 | 26,573 | 3,225 | 815 | 305 | 146 |
| L=32 (mine = paper) | 20,724 | 581 | 109 | — | — | — | — |

All 10 values match. The shipped thresholds round down to powers of two (2^30, 2^19, 2^14, 2^11, 2^9), and the initial bounds 2^60, 2^57, 2^56, 2^55, 2^54 are exactly `(threshold)^k`, so the fast path is never unsound. One small issue: the paper's Appendix A declares `void batched(...)` but ends with `return bound;`. That won't compile as printed. The repository version returns `uint64_t`.

## Benchmarks on an M3 Pro

I implemented the paper's four variants: unbatched, division-based `naive_2`, `shuffle_2` and `shuffle_6`. Generators were Lehmer-128, PCG64 and macOS `arc4random_buf`. Each figure is the best of 7 runs of 20 ms each, and every resulting permutation was checked.

One caveat: a dependent-add loop measured only **~2.5 GHz** effective clock during these runs. That held even at user-interactive QoS, with other load on the machine. Absolute nanoseconds are therefore not comparable to the paper's M2 figures, so I report ratios.

**Speedup of `shuffle_6` over unbatched, n = 2^8…2^16:**

| generator | paper (M2) | M3 Pro, RNG inlined | M3 Pro, RNG out-of-line |
|---|---|---|---|
| Lehmer | 1.5–2.3× | **1.38–1.45×** | 2.25–2.60× |
| PCG64 | 1.9–2.6× | **1.53–1.73×** | 2.18–2.79× |
| ChaCha / arc4random | 2.6–3.9× | 3.16–5.28× | — |

The inlined column is the fair one for a generator compiled into the same translation unit. The paper's published `m2.data` shows 1.23 vs 0.54 ns per element at 13k elements. I see 1.88 vs 1.32 ns at 16k: batching saves 0.56 ns per element, not 0.69. I can't tell how much of that gap comes from the core and how much from the clock.

Marking the generator `noinline` changes the result. That models a generator behind a library boundary, function pointer, `dyn Rng` or virtual call. The unbatched baseline slows from 1.9 to 4.1 ns per element, while `shuffle_6` only goes from 1.3 to 1.7 ns. Batching removes calls, so it gains more as each call gets more expensive. The paper's "more than double" holds comfortably in that setting.

## The call-count ceiling explains the slow-generator numbers

If the generator dominates, the speedup can't exceed (generator calls unbatched) / (generator calls batched). I instrumented `shuffle_6` and counted:

| n | words/shuffle | ceiling | arc4random measured | % of ceiling | divisions / rerolls per shuffle |
|---|---|---|---|---|---|
| 2^8 | 43.0 | 5.93× | 5.28× | 89% | 0.05 / 0 |
| 2^10 | 188.0 | 5.44× | 4.95× | 91% | 0.34 / 0 |
| 2^12 | 905.1 | 4.52× | 4.23× | 94% | 1.4 / 0.06 |
| 2^14 | 3,978.6 | 4.12× | 3.79× | 92% | 5.1 / 1.6 |
| 2^16 | 20,362.8 | 3.22× | 3.16× | 98% | 6.7 / 1.8 |

With a slow cryptographic generator, the batched shuffle reaches 89–98% of the theoretical limit. The slow path is negligible: about 7 divisions and 2 rerolls per 65,536-element shuffle. The paper's ChaCha speedups are lower than mine. That fits its portable ChaCha being far cheaper per call: 7.7 ns per element unbatched in its `m2.data`, against about 58 ns for `arc4random_buf` here.

Entropy use is still loose: the shuffle draws 1.24–1.63× `log₂(n!)` bits. Packing tighter would push `∏b_i` toward `2^64` and make the slow path common.

## Out of cache: memory latency hides the multiplies

The paper stops at 2^16 elements, all in cache, and lists large arrays as future work. I ran 2^16–2^24 with medians of 15 interleaved runs:

| n (8-byte elements) | Lehmer sh6× | PCG64 sh6× |
|---|---|---|
| 2^16 (512 KiB) | 1.34 | 1.57 |
| 2^18 (2 MiB) | 1.34 | 1.51 |
| 2^20 (8 MiB) | 1.07 | 1.32 |
| 2^22 (32 MiB) | 0.96 | 1.27 |
| 2^24 (128 MiB) | 1.00 | 1.22 |

Once every swap misses cache, the cost is about 18 ns per element, and the saved multiplies vanish into that. With Lehmer, batching gives no gain at all. PCG behaves differently: its unbatched shuffle is 27.0 ns per element at 2^24, compared with 17.8 ns for Lehmer, a much larger gap than the 0.8 ns seen in cache. Batching recovers most of that gap.

My hypothesis is memory-level parallelism. Each swap address depends on the generator output. A longer generator dependency chain means fewer cache misses can be in flight before the reorder buffer fills. Batching computes up to six addresses from a single generator step, so more misses get issued in parallel. I haven't measured this with performance counters. It is consistent with the data but not proven.

## Takeaways

- **Use exactly one threshold:** `2^64 mod ∏b_i`, tested on the final remainder. Per-die thresholds are biased in more than 92% of small configurations.
- **The batch schedule is reproducible.** It falls straight out of the cost model, and its initial bounds are exact k-th powers.
- **The speedup depends on what a generator call costs.** Inlined Lehmer or PCG gives 1.4–1.7×. A call boundary gives 2.2–2.8×. A system CSPRNG gives 3–5×, close to the call-count ceiling. Standard-library shuffles often have call boundaries and CSPRNG defaults.
- **Past the last-level cache, it depends on the generator:** no gain for Lehmer, 1.2–1.3× for PCG.
