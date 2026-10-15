---
title: "AE Chunking, Solved Exactly: A 256-State Recursion, e^γ Instead of e−1, and Why Real Text Overshoots by 16%"
date: 2026-10-16
tags: ["deduplication", "content-defined-chunking", "storage", "probability", "algorithms"]
excerpt: "A new ICDE 2027 benchmark of content-defined chunking finds that the standard horizon formula for Asymmetric Extremum (AE), h = µ/(e−1), produces chunks 13–39% smaller than intended. The authors call exact analysis impractical and calibrate by simulation. I show a 256-state backward recursion that gives the exact mean in microseconds and reproduces their simulated horizons (348 and 793). Its continuum limit says the formula is wrong even on continuous values: the constant is e^γ ≈ 1.781, not e−1. On this blog's own markdown, AE overshoots by 16% for a reason the byte histogram cannot explain."
---

# AE Chunking, Solved Exactly: A 256-State Recursion, e^γ Instead of e−1, and Why Real Text Overshoots by 16%

Deduplicating storage splits byte streams at content-defined cut points, so an insertion only disturbs nearby chunks. Rolling hashes (Rabin, Buzhash, Gear) cut where the low `b` hash bits are zero. *Hashless* algorithms compare raw bytes instead, and the best known of them is **Asymmetric Extremum (AE)**.

A paper posted last week, Gregoriadis, Balduf, Scheuermann and Pouwelse, *Benchmarking Content-Defined Chunking Algorithms for Data Deduplication* (arXiv 2610.13704, accepted at ICDE 2027), benchmarks eight base algorithms with the add-ons stripped away. Their headline finding is a **parameterization bug that has spread widely**. AE's horizon is usually set from the target mean as `h = µ/(e−1)`, and that rule produces chunks 13–39% smaller than the target. The rule came from the original paper and spread through Destor and DedupBench (now fixed). Smaller chunks dedupe better, so published AE comparisons were partly comparing chunk sizes.

The authors call exact analysis impractical: their expansion "accumulates six hierarchies of sum-loops", and they stopped evaluating it after two hours. Instead they calibrate small targets by simulation and use `h ≈ µ − 256` above 2 KiB. I found that AE's mean has an exact 256-state recursion, and its continuum limit shows `e−1` was the wrong constant all along.

## The algorithm

AE scans forward from the chunk start and tracks the running maximum. It cuts once that maximum has stood unbeaten for `h` bytes. This is the reference loop:

```c
/* returns cut index: the chunk is p[0 .. i-1] */
long ae_chunk(const uint8_t *p, long n, long h) {
    uint8_t max = p[0]; long max_pos = 0;
    for (long i = 1; i < n; i++) {
        if (p[i] <= max) {                  /* ties do NOT reset the record */
            if (i == max_pos + h) return i;
        } else { max = p[i]; max_pos = i; }
    }
    return n;
}
```

Chunk length is `max_pos + h`, where `max_pos` is the position of the first record that survives `h` bytes. There's no hashing and only one compare per byte, which is why AE runs at Gear speed. On the paper's Xeon Gold 6154 at a 2 KiB target, AE reaches 650 MiB/s against Gear's 652 and Rabin's 195.

## Why the analysis is tractable

The paper's expansion treats each candidate position's horizon as overlapping with its neighbours', so every probability depends on all earlier ones. The loop above doesn't work that way. Its entire state is *(current record value m, bytes since the record)*, which makes it a Markov chain. Seen from a fresh record `m`, only two things can happen next:

- the next `h` bytes are all `≤ m`, with probability `q^h` where `q = (m+1)/256`, and we cut; or
- some byte exceeds `m` first, and a new record starts with a value uniform on `m+1..255`.

The number of bytes consumed before one of these happens is `min(Geometric(1−q), h)`, which has mean `(1−q^h)/(1−q)`. Let `E[m]` be the expected remaining length from a fresh record `m`. Then

```text
E[255] = h
E[m]   = (1 − q^h)/(1 − q)  +  (1 − q^h) · mean(E[m+1 .. 255])
mean chunk length = mean over m of E[m]      (the first byte is the first record)
```

This is a backward pass over 256 values with a running suffix sum, so it costs 256 multiply-adds:

```python
def ae_mean(h, A=256):
    E = [0.0] * A
    E[A-1] = float(h); suffix = E[A-1]
    for m in range(A-2, -1, -1):
        q = (m + 1) / A; qh = q ** h
        E[m] = (1 - qh) / (1 - q) + (1 - qh) * suffix / (A - 1 - m)
        suffix += E[m]
    return sum(E) / A
```

It matches simulation. Over 2^26 random bytes, h = 298 gives 446.8 simulated against 447.2 exact, and h = 4768 gives 5025 against 5023. Here are all five targets:

| target µ | h = µ/(e−1) | exact mean | shortfall | exact-calibrated h | paper's Table IV |
|---|---|---|---|---|---|
| 512 | 298 | 447 | 12.7% | 348 | 348 (simulated) |
| 1024 | 596 | 807 | 21.2% | 793 | 793 (simulated) |
| 2048 | 1192 | 1440 | 29.7% | 1794 | 1792 (µ−256) |
| 4096 | 2384 | 2639 | 35.6% | 3841 | 3840 |
| 8192 | 4768 | 5023 | 38.7% | 7937 | 7936 |

The 13% and 39% endpoints are the paper's numbers, and both horizons the authors had to find by simulation fall out exactly. `µ − 256` comes out one byte short: with the cut before byte `i`, the first `0xFF` sits at mean offset 255. The exact means at 1792, 3840 and 7936 (2047.1, 4095.0, 8191.0) are the AE RAND entries in the paper's Table VIII, so the model and their measurements count the same quantity.

This also explains AE's standard deviation of exactly 255 at every target ≥ 4 KiB. Past h ≈ 1800 the record is almost surely `0xFF` (`1 − (255/256)^1792 ≈ 0.999`), so a chunk is "offset of the first `0xFF`" plus `h`: a shifted geometric with p = 1/256 and standard deviation 255.5. At large targets AE behaves like fixed-size chunking that each `0xFF` re-phases.

## The constant was never e−1

The paper blames byte discreteness: the maximum saturates at 255. That's right, but the recursion can test the other half, which is whether AE approaches `(e−1)·h` on effectively continuous values. Increasing the alphabet `A`:

```text
A = 256       mean/h = 1.243   (h = 1000)
A = 4096      mean/h = 1.705
A = 65536     mean/h = 1.777
A = 2^23      mean/h = 1.782
e − 1                = 1.718
```

A direct simulation of the reference loop on 32-bit values, with no recursion involved, gives 1.7829 at h = 1000 and 1.7751 at h = 4768. The ratio settles above `e−1`.

The limit has a closed form. Write the record as `x = 1 − t/h`, so that surviving `h` bytes has probability `e^(−t)`. Take `ε(t)` as the expected remaining length divided by `h`, and let `I(t)` be its integral from 0 to `t`. The recursion becomes the ODE `I′(t) = (1 − e^(−t))/t · (1 + I(t))`, whose solution is

```text
1 + I(t) = exp( Ein(t) ),   Ein(t) = ∫₀ᵗ (1 − e^(−s))/s ds = ln t + γ + E₁(t)
mean chunk length = I(h) ≈ e^γ · h − 1 ≈ 1.781 · h
```

`γ` is the Euler–Mascheroni constant. The exact discrete chain at h = 1000 with 2^23 values gives 1780.9, against `e^γ·h − 1 = 1780.1`. So even the "continuous AE" that the original formula assumes produces chunks 3.7% larger than `(e−1)·h`. I couldn't reconstruct where `e−1` came from, but it doesn't describe the reference loop. On real bytes the two errors pull in opposite directions, and discreteness dominates.

## Real text: the histogram is not the story

I ran AE on this blog's own 2.1 MB of markdown and compared it with an i.i.d. model built from the corpus histogram. The recursion accepts any byte distribution: swap `(m+1)/256` for the empirical CDF.

| h | real corpus mean / sd | same bytes shuffled | i.i.d. model |
|---|---|---|---|
| 298 | 441 / 131 | 458 / 137 | 459 |
| 4768 | 6012 / 1776 | 5020 / 325 | 5022 |
| 7936 | 9534 / 2440 | 8211 / 334 | 8209 |

The shuffled corpus lands exactly on the model, so the histogram alone predicts near-target behaviour. The real ordering overshoots the 8 KiB target by 16%, with 7× the spread. The paper sees the same overshoot: 9332 B on CODE, 9542 B on VM backups and 8406 B on WEB, each at an 8 KiB target. The cause is **burstiness**. This corpus's highest bytes are UTF-8 lead bytes (em-dashes, symbols), which cluster in some posts and never appear in code blocks. In ASCII-only stretches the record stalls low, at something like `}`, and every later high byte restarts the `h`-byte clock. A marginal-distribution calibration can't see this, so calibrate on a sample of your own workload.

## What to take away

- **If you run AE, re-derive `h`.** Use `h = µ − 255` for µ ≥ 2 KiB and the recursion below that. No simulation needed.
- **Read old AE results as measured at smaller chunks.** "8 KiB" AE was really about 5 KiB AE. The paper rightly stops short of claiming ranking reversals, but comparisons that didn't control for empirical mean chunk size remain unresolved.
- **"Intractable" often means "wrong state space."** Model the loop as it executes (a record value and a counter) rather than the sliding-window picture of it. Here that turned six nested sums into a 256-entry array and exposed the `e^γ` constant.
- **Calibrate on your own bytes.** The paper finds AE the most balanced base algorithm overall, while RAM blows up to hundreds of kilobytes on zero-padded archives. Either way, what separates random-data results from real ones is how the bytes are ordered, not which byte values occur.
