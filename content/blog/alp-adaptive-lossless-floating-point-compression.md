---
title: "ALP: How to Compress Floating-Point Data Twice as Well and Decode It 2-4x Faster"
date: 2026-07-14
tags: ["compression", "columnar-databases", "floating-point", "vectorization", "data-engineering"]
excerpt: "Floating-point columns are the last frontier of columnar compression: general-purpose byte compressors barely dent them, and bit-level predictors like Gorilla trade speed for ratio. ALP wins on both axes by recognizing that most 'doubles' in the wild are actually decimals in disguise, and encoding them as small integers a vectorized bit-packer can crush."
---

# ALP: How to Compress Floating-Point Data Twice as Well and Decode It 2-4x Faster

Floating-point columns are where columnar compression goes to die. Integers get run-length encoding, frame-of-reference, delta, and bit-packing. Strings get dictionaries and FSST. But a column of `DOUBLE` values, `[1.05, 2.30, 0.99, 42.10, ...]`, resists all of them. The IEEE 754 bit layout scatters entropy across the mantissa in a way that byte-oriented compressors like LZ4 and Zstd cannot exploit, and the classic scientific-data predictors (Gorilla, Chimp, Patas) buy their ratios with slow, branchy, value-at-a-time bit twiddling that stalls modern CPUs.

ALP (Adaptive Lossless floating-Point compression), from Afroozeh, Kuffó, and Boncz at CWI, published at SIGMOD 2024 and now the default float codec in DuckDB, breaks the trade-off. It compresses **~2x better than Patas while decoding 2-4x faster**, winning simultaneously on compression ratio, compression speed, and decompression speed. It does this with an observation that sounds almost too simple: most floating-point data in analytical systems was never really floating-point. It was decimals, typed as doubles because that is the default.

## Why doubles are hard, and why they secretly aren't

Consider the value `1.05`. As a decimal it needs three digits. As an IEEE 754 double it is:

```
0 01111111111 0000110011001100110011001100110011001100110011001101
```

That trailing `...11001100` is not noise. It is the infinite binary expansion of `0.05` truncated to 52 mantissa bits. `1.05` cannot be represented exactly in binary, so the double is the *nearest representable value*. Every general-purpose compressor sees a high-entropy mantissa and gives up. Gorilla-family codecs XOR consecutive values and encode the leading/trailing zero runs of the result, which helps for slowly-varying sensor streams but collapses on the interleaved, jumpy floats typical of analytics.

The key insight: a value like `1.05` originated as a decimal with **two digits after the point**. If we multiply by `10^2` we get `105`, an integer. Integers are exactly what columnar engines already compress superbly. So the entire game is: recover the decimal representation, encode the small integer, and store just enough metadata to reconstruct the exact original double.

## The ALP scheme: doubles as integers

ALP encodes each value `d` with two small integer parameters shared across a block: an exponent `e` and a factor `f`, both indices into a lookup table of powers of ten, with `e >= f`. The encoded integer is:

```
I = round( d * 10^e * 10^(-f) )
```

and the value is reconstructed as:

```
d' = I * 10^(f - e)      // i.e. I * 10^f / 10^e
```

The `10^e` shifts the significant decimal digits to the left of the point so rounding recovers them; the `10^-f` divides out a common trailing-zero factor so the stored integer stays as small as possible. For a column of currency values like `[1.05, 2.30, 0.99]`, picking `e = 2, f = 0` yields `[105, 230, 99]`, three small integers with a tight value range.

Crucially, ALP is **lossless**, so it cannot just trust that the round-trip works. For every value it re-encodes and compares:

```python
def alp_try_encode(d, e, f):
    I = round(d * POW10[e] / POW10[f])   # to int64
    d_prime = I * POW10[f] / POW10[e]
    return I, (d_prime == d)             # exact bit-for-bit?
```

Values that fail the equality check, genuinely high-precision numbers, irrationals, results of transcendental functions, are recorded as **exceptions**: their original 64-bit pattern is stored verbatim in a side array, and a position vector marks where they go. The bet ALP makes is that in real analytical data, exceptions are rare. When they are not, ALP does not use this scheme at all (more below).

The resulting integer stream `I` is then handed to a **Frame-of-Reference + bit-packing** encoder: subtract the block minimum, then bit-pack the residuals to exactly the number of bits the max residual requires. This is the same machinery integer columns use, and it is where the speed comes from.

## Choosing e and f: two-stage sampling

The compression ratio hinges entirely on picking good `(e, f)` per block. Trying all `~19 x 19` combinations on every value would be prohibitively slow. ALP uses a two-stage sampling strategy that keeps compression fast:

1. **Row-group stage.** Sample a handful of vectors from the row group. For each sampled vector, sweep candidate `(e, f)` pairs and score them by estimated compressed size (bit-width of the FOR residuals plus the exception penalty). Keep the best few combinations as the row-group's shortlist.
2. **Vector stage.** For each vector of values, evaluate only the shortlisted combinations rather than the full grid, and pick the winner for that vector.

This narrows an expensive global search to a cheap per-vector lookup, so encoding throughput stays high while ratios stay near-optimal. ALP operates on fixed vectors of **1024 values**, which is what makes the whole pipeline vectorization-friendly: parameters are constant within a vector, so the inner loops are branch-free and auto-vectorize to SIMD.

## ALPrd: when the data really is high-precision

Not all floating-point data descends from decimals. Scientific measurements, ML embeddings, and computed statistics are genuinely high-precision, and forcing them through the decimal scheme would produce mostly exceptions, a disaster. ALP detects this during sampling and switches to a second scheme, **ALPrd** ("real doubles").

ALPrd splits each 64-bit value into a **left part** (the leading bits: sign, exponent, and the top mantissa bits) and a **right part** (the trailing mantissa bits):

```
[  left: front bits  ][  right: trailing mantissa bits  ]
        ~16 bits                  ~48 bits
```

The observation is that within a column, the front bits vary across only a small number of distinct patterns, values tend to share magnitude and sign, while the trailing mantissa bits are effectively random and incompressible. So ALPrd:

- **Dictionary-encodes the left parts.** A small dictionary (a handful of entries) captures the common front-bit patterns; each value stores a tiny dictionary index plus any left-part bits not covered. Left parts that miss the dictionary become exceptions.
- **Stores the right parts bit-packed and uncompressed.** There is no point trying to compress randomness; ALP just packs them densely.

The split point is chosen to maximize dictionary hit rate on the left while keeping the incompressible right as small as possible. ALPrd will not match ALP's ratios on decimal data, but on genuine high-precision data it still beats Gorilla and friends, and it decodes fast because both halves reassemble with cheap shifts and ORs.

## Why it decodes so fast

The speed story is entirely about **avoiding value-at-a-time branching**. Gorilla/Chimp/Patas decode each value by reading a variable number of control bits, branching on them, and reconstructing via XOR against the previous value, a serial dependency chain that defeats instruction-level parallelism. ALP decode is, per vector:

1. Bit-unpack 1024 residuals (SIMD, no branches).
2. Add back the frame-of-reference base (SIMD).
3. Multiply by `10^(f-e)` to get doubles (SIMD).
4. Patch in the handful of exceptions by position (a short scattered write).

Steps 1-3 are dense, uniform, vectorizable arithmetic over the whole vector. The only data-dependent work is patching exceptions, and there are few of them. This is why ALP hits multi-GB/s decode rates where the bit-predictors stall.

## What it means in practice

Concretely, DuckDB reported replacing Patas with ALP on a floating-point workload: storage dropped from **275 MB to 184 MB** (about 1.5x smaller on that dataset, with 2x+ common elsewhere), load time fell from 0.60s to 0.43s, and query time dropped from 0.080s to 0.020s, faster on all three axes at once. Because the codec is transparent, applied automatically to `FLOAT`/`DOUBLE` columns at checkpoint time, application code changes nothing.

The broader lesson is a recurring theme in systems design: **the biggest wins come from recognizing hidden structure, not from working harder on the raw bits**. For a decade, float compression research chased ever-cleverer ways to squeeze the mantissa. ALP's leap was noticing that the mantissa was the wrong thing to look at, because the data was decimals all along. Once you encode them as the integers they always were, a boring, fast, well-understood integer bit-packer does the rest. The novelty is not a new entropy coder; it is asking where the entropy actually lives.

If you maintain a columnar engine, a time-series store, or a Parquet-adjacent format and you are still shipping floats through a byte-level compressor or a Gorilla variant, ALP is the rare upgrade that costs you nothing on either the ratio or the latency axis. That is unusual enough to be worth a benchmark.
