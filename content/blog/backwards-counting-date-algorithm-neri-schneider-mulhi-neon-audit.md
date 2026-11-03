---
title: "Counting Days Backwards: Auditing the Fastest 64-Bit Date Algorithm on Apple Silicon"
date: 2026-11-03
tags: [algorithms, performance, integer-arithmetic, arm64, simd]
excerpt: "Ben Joffe's 2025 date algorithm turns a day count into year/month/day with 4 multiplications instead of Neri–Schneider's 7, by counting backwards from a leap day. I checked it against a 128-bit reference on an M3 Pro. Both 64-bit range boundaries reproduce to the exact day, with 0 misses in 1.2 billion random inputs. The repo's 32-bit form misses the bottom 7,172 days of int32 because of a uint32 wrap, and no ERAS constant can fix that. Scalar code runs 1.27–1.36× faster than Neri–Schneider. Batch code is different: Neri–Schneider's 32-bit arithmetic auto-vectorizes on NEON and wins by 2.3×."
---

# Counting Days Backwards

Converting a day count to a calendar date shows up everywhere: `DATE` columns in every columnar engine, log timestamp formatting, `std::chrono::year_month_day`. In 2021 Cassio Neri and Lorenz Schneider rebuilt this conversion on *Euclidean affine functions* (EAFs). An EAF is `f(n) = (a·n + b) / d`, and you evaluate it as a multiply plus a shift instead of a division. Their algorithm is now in libstdc++ and other standard libraries. In 2025 Ben Joffe published a [64-bit variant](https://www.benjoffe.com/fast-date-64) that he says is 38–44% faster on Intel and Apple M4 Pro. It uses 4 multiplications to Neri–Schneider's 7.

I took the reference code from his [benchmark repo](https://github.com/benjoffe/fast-date-benchmarks) and checked three things on an M3 Pro: correctness against an independent 128-bit reference, the multiply count in the compiled code, and speed under two different workloads.

## The trick: put the leap day first

In the forward direction, the leap day falls at the end of each 4-year cycle (March-based years), and the long century falls at the end of each 400-year era. So the classic formulas carry offsets, like `(4n + 3) / 1461` for the year inside a cycle. The `+3` stops you from merging the `·4` and the `/1461` into one multiply-shift.

Joffe moves the epoch to a February 29 that starts a 400-year era, then counts *down* from it. Seen from that epoch, the 366-day year and the 36,525-day century are the first ones you hit, so the offsets go away. Each step becomes a single `umulh` by a precomputed reciprocal:

```c
// Joffe fast64, ARM path; input = days since 1970-01-01
uint64_t rev = D_SHIFT - dn;                         // count backwards
uint64_t cen = ((u128)505054698555331u * rev) >> 64; // ≈ rev / 36524.25
uint64_t jul = rev + cen - cen / 4;                  // Gregorian -> Julian map
u128     num = (u128)50504432782230121u * jul;       // ≈ jul / 365.25
uint64_t yrs = Y_SHIFT - (uint64_t)(num >> 64);      // year, forward again
uint32_t ypt = ((u128)24451 * (uint64_t)num) >> 64;  // year fraction -> "year-part"
uint32_t N   = (yrs % 4) * 16 + 30556 - ypt;         // re-phase for leap years
uint32_t M   = N / 2048;                             // month (Mar=3 .. Feb=14)
uint32_t D   = ((u128)(C3) * (N % 2048)) >> 64;      // C3 = 32·floor(2^64/2140)
uint32_t bump = M > 12;                              // Jan/Feb belong to next year
```

Two more ideas make it work. The Julian map `rev + cen − cen/4` puts the 100/400-year rule back in, so the rest of the pipeline only has to handle the simple 365.25-day Julian year. Then the low 64 bits of `num`, which hold the fractional year, are scaled directly into a value `N` whose top bits are the month and whose low 11 bits give the day. Month lengths vary between 30 and 31 days, and `(yrs % 4) * 16` corrects the drift that variation causes. Neri–Schneider instead compute the exact day-of-year and then run a second EAF (`2141·n + 197913`) to split it into month and day. Joffe folds both steps into one.

## Correctness: an independent oracle

The repo's own range test compares Joffe against Neri–Schneider. That shows the two agree, not that either one is correct. I used Howard Hinnant's `civil_from_days` instead, written with `__int128` floor division. It is a direct derivation with no reciprocal constants, so it has no shared failure mode with the other two. Results:

| Test | Inputs | Mismatches |
|---|---|---|
| Joffe 64-bit (`ERAS = 4726498270`), every int32 day | 2^32 | **0** |
| Joffe 64-bit, uniform random over its claimed range | 1.2 × 10^9 | **0** |
| Joffe 64-bit, 2^26-day windows at both claimed edges | 1.3 × 10^8 | first failure exactly at the claimed boundaries |
| Repo `benjoffe_fast64::to_date(int32_t)` (`ERAS = 14704`) | 2^32 | **7,172** |
| Neri–Schneider 32-bit (`s = 82`) | 2^32 | 3,221,225,472 (75.00%, by design) |

The 64-bit range claims hold to the exact day. Day 690,527,217,032,721 (+1,890,599,308,000-02-29) is correct, and one day later the output jumps to year 853,526,005,011. At the bottom the last correct day is −690,527,216,974,164, and one day earlier the function returns February 29 of a non-leap year, which is the failure mode the article describes. The full int64 range of Unix *seconds* is ±1.07 × 10^14 days, so it sits well inside.

The 7,172 failures are in the 32-bit-input function, whose comment says *"Supports full 32-bit input range."* Every failure is at the very bottom of int32: day numbers from −2,147,483,648 to −2,147,476,477, or −5,877,641-06-23 to −5,877,621-02-09. `INT32_MIN` comes back as **+5,881,580-07-12**. I reproduced this with the unmodified header compiled as C++20. The cause is ordinary C promotion:

```c
static uint32_t constexpr D_SHIFT = 146097 * 14704 - 719469; // 2,147,490,819
uint64_t const rev = D_SHIFT - dayNumber;  // computed in uint32, THEN widened
```

`D_SHIFT` is 7,171 above 2^31, so `D_SHIFT + 2^31` wraps. You can't fix this by picking a different `ERAS`. With a 32-bit `rev`, covering all of int32 requires `D_SHIFT = 2^31 − 1` exactly. That means `ERAS = 14,703.95`, and `ERAS` has to be an integer so the epoch lands on an era boundary. The fix is one cast, `uint64_t rev = (uint64_t)D_SHIFT - (int64_t)dayNumber`. With it the function has 0 mismatches over all 2^32 inputs. The repo's test probably missed this because it scans outward from zero and reports a coverage *percentage*. 99.9998% looks like a pass.

In practice this costs nothing: nobody stores dates in the year −5.8 million. It's still worth knowing if you fuzz against `INT32_MIN`, or if you build a "proleptic, full-range" API on top of this function.

## Counting multiplies in the compiled code

Apple clang 21, `-O3 -mcpu=apple-m3`, functions marked `noinline`:

| Function | Instructions | Multiply instructions | Divides |
|---|---|---|---|
| Neri–Schneider 32-bit | 43 | 7 | 0 |
| Joffe (32-bit in, ARM path) | 40 | **5** | 0 |
| Joffe wide (int64 in) | 46 | 5 | 0 |

The "4 multiplications" turn into 5 instructions on AArch64. The year step needs both halves of the 64×64→128 product (`mul` for the fraction, `umulh` for the year), and AArch64 computes each half with its own instruction. The critical path is still 4 multiplies long: `umulh → add/sub → umulh → umulh → umulh`.

## Speed: two workloads, opposite winners

Inputs were 4,096 random day numbers within ±2,738 years of 1970. I took the best of 15 runs. *Latency* is a dependent chain where each output feeds the next input, close to the article's sequential scan. *Throughput* converts an independent array, which is the shape of a columnar `EXTRACT(YEAR FROM d)`.

| ns per date (M3 Pro) | Latency | Throughput, scalar | Throughput, default `-O3` |
|---|---|---|---|
| Hinnant (libc++-style) | 18.82 | 11.79 | 5.86 |
| Neri–Schneider | 11.00 | 6.12 | **2.13** |
| Joffe, ARM path | **8.10** | 5.02 | 6.48 |
| Joffe, x64 path on ARM | 8.78 | 4.89 | 6.41 |
| Joffe wide (int64) | 8.48 | **4.81** | 4.81 |
| Joffe fast32 v2 (±284k years) | 8.78 | 5.06 | 5.06 |

Scalar results agree with the article's ranking, though the margins are smaller. Joffe beats Neri–Schneider by **1.36×** on latency and **1.27×** on scalar throughput. Joffe reports 1.62× on M4 Pro. The difference could be the chip or his benchmark harness, and I haven't separated the two. His note that the x64 `shift`/`bump` trick hurts Apple cores also holds on M3: 8.78 ns against 8.10 ns.

The last column changes the conclusion. With the vectorizer on, which is the default at `-O3`, clang turns Neri–Schneider into 4-wide NEON (the `-Rpass` remark reports width 4, interleave 2). Every intermediate there fits in 32 bits, and multiply-by-reciprocal becomes vector multiply-high. Joffe's core is a 64×64→128 high multiply, and **NEON has no 64-bit `mulhi`**. Clang vectorized the 32-bit-input Joffe loop anyway, and the emulated multiplies made it *slower* than its own scalar version: 6.48 ns against 5.02 ns. The int64 variant stayed scalar.

So for batch conversion the best Joffe result (4.81 ns) is **2.3× slower** than vectorized Neri–Schneider (2.13 ns). A 7-multiply algorithm beats a 4-multiply one because its multiplies are narrow.

## What to take from it

- **Multiply count is a scalar-latency metric.** It predicts the dependent-chain result well (1.36×). It says nothing about SIMD, where operand *width* matters more than how many multiplies there are. AVX-512 also has no native 64×64→128 high multiply, so I'd expect the same direction on x86 batch kernels, though I haven't measured it there.
- **Choose by workload.** Formatting one timestamp per log line, or `chrono` calls in a hot path, is latency-bound, and Joffe wins there. Bulk conversion of columns in vectorized query engines goes to Neri–Schneider, or to any variant whose intermediates fit in 32 bits.
- **Test against an independent oracle and with raw counts.** The 64-bit range was exactly as advertised. The 32-bit edge case only showed up by testing every input against an implementation that shares no constants, and counting mismatches rather than computing a coverage ratio.

One open question: can a 32-bit-intermediate version of the backward count, with fast32 v2's constants but a ≤32-bit `mulhi` at every step, keep Joffe's shorter chain *and* vectorize? If so it would win on both workloads. Its ±284k-year range is already plenty for every real `DATE` column.

*Harness: C, Apple clang 21.0, `-O3 -mcpu=apple-m3`, 12 threads for the exhaustive sweeps (~34 s per 2^32 pass). Reference code: [fast-date-benchmarks @ e35f46b](https://github.com/benjoffe/fast-date-benchmarks).*
