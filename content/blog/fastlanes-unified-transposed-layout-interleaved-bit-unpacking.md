---
title: "The 04261537 Order: FastLanes and the Layout That Makes Decoding Data-Parallel"
date: 2026-09-07
tags: [compression, data-engineering, simd, performance, file-formats]
excerpt: "Bit-packing decoders are slow not because the arithmetic is hard but because the layout serializes it. FastLanes reorders values against a virtual 1024-bit register so that plain scalar C auto-vectorizes into something fast. I brute-forced its uniqueness proof (the paper has a typo), then measured it on an M3 Pro: 22-26x over a conventional bit-unpacker, and the compiler beating my hand-written quasi-SIMD by 2.2x."
---

Every columnar format bit-packs integers. Store 3-bit values in 3 bits, not 32, and you cut scan bandwidth by 10x. The decoder is then on the critical path of every query, and this is where most formats quietly lose: Parquet's dictionary codes live in variable-length runs of bit-packed or RLE data, and that adaptivity means a decoder cannot know in advance where value *i* begins. It ends up extracting one value at a time.

The interesting claim in [FastLanes](https://github.com/cwida/FastLanes) (Afroozeh and Boncz, PVLDB 16(9), CWI) is that the arithmetic was never the problem. Bit-unpacking is a handful of shifts and masks per value; a modern core should retire dozens of values per cycle. What stops it is the *order in which values sit in memory*, which serializes work that is logically independent. Fix the layout and the same shifts and masks — written in plain scalar C, with no intrinsics — go 20x faster.

The paper's headline is >100 billion integers per second. The part worth internalizing is the layout, and specifically a permutation of eight tile indices: `04261537`.

## Targeting a register that does not exist

SIMD-friendly bit-packing layouts have existed for years, and they all bake in a register width. The 4-way interleaved layout spreads packed values over four 32-bit lanes so no cross-lane `PERMUTE` is needed — exactly right for 128-bit SSE, and it leaves half of AVX2 idle. So an 8-way layout was proposed, then a 16-way one. Each is a different on-disk format, which is intolerable for a format meant to outlive the CPU generation that wrote it.

FastLanes interleaves against a **virtual 1024-bit register**, `FLMM1024`, that no CPU implements. A 1024-value vector of *W*-bit codes occupies exactly *W* of these words. The instruction set is deliberately anaemic — load, store, and/or/xor, add, shift, broadcast, all defined per lane width *T* ∈ {8,16,32,64} — because those are the operations every SIMD dialect has had since 1999. A 128-bit NEON backend implements `FLMM1024` as eight registers; AVX512 uses two; and a *scalar* backend uses sixteen `uint64`s.

That scalar backend is not a fallback, it's the point. Since one `uint64` holds eight 8-bit lanes, scalar code can process eight values per instruction — as long as bits never cross lane boundaries. They won't, if you mask before you shift:

```c
#define BC(x) (0x0101010101010101ULL * (x))   /* broadcast to 8 lanes */
static void unpack_w3_t8(const uint8_t *in, uint8_t *out) {
  const uint64_t M3 = BC(7), M2 = BC(3), M1 = BC(1);
  for (int l = 0; l < 128; l += 8) {         /* 128 lanes, 8 at a time */
    uint64_t r0, r1, hi;
    memcpy(&r0, in + l, 8);
    r1 = r0 & M3;              memcpy(out + 0*128 + l, &r1, 8);
    r1 = (r0 >> 3) & M3;       memcpy(out + 1*128 + l, &r1, 8);
    hi = (r0 >> 6) & M2;                     /* code straddles two words */
    memcpy(&r0, in + 128 + l, 8);
    r1 = hi | ((r0 & M1) << 2); memcpy(out + 2*128 + l, &r1, 8);
    r1 = (r0 >> 1) & M3;       memcpy(out + 3*128 + l, &r1, 8);
    /* ... 4 more, then the third word ... */
  }
}
```

Ten `FLMM1024` operations unpack 384 3-bit codes. Notice what the interleaving bought: every shift amount is a compile-time constant, no code straddles a *lane*, and the outputs land contiguously. On AVX512 the paper measures 70 values per cycle — 140 billion values/s on one 2 GHz core, which at 3 bits per value means consuming packed input at ~52 GB/s, i.e. RAM-bandwidth-bound. Decompression stops being a cost you budget for.

## The dependency problem, and why the tile order is forced

Bit-unpacking has no data dependencies. DELTA does: value *i* needs value *i−1*. In the default layout, adjacent values land in adjacent lanes, so the additions are cross-lane and SIMD is useless.

The fix is to **transpose**: cut the 1024-value vector into register-width chunks and stack them, so that memory-adjacent values belong to *different* delta chains. With *S* = 1024/*T* lanes, you get *S* independent chains of length *T*, each seeded by a base in the block header. Prefix-sum decoding becomes *T* fully parallel vector adds.

The catch is that the transposition depends on *T*, and a table has columns of different widths. A scan must deliver all columns in the *same* tuple order, so a layout tuned for 32-bit values leaves half the lanes idle on a 16-bit column. FastLanes resolves this with a single order that works for every width: eight transposed 8x16 tiles, arranged in the order `04261537`. For *T*=64 you process one tile per register, for *T*=32 two, and so on down to all eight for *T*=8 — and at every level, successive vector operations touch tile *n* and tile *n+1* in the same lane position.

The paper asserts this order is the *only* one with those properties. That's checkable, so I checked it — eight tiles is 5040 permutations starting at 0:

```python
def ok(o):
    for g in (2, 4):            # tiles per 1024-bit register for T=32, T=16
        blocks = [tuple(o[k*g:(k+1)*g]) for k in range(8 // g)]
        if blocks[0][0] != 0:   # bases live in tile 0, so decoding starts there
            return False
        cur, seen = blocks[0], {blocks[0]}
        for _ in range(len(blocks) - 1):
            nxt = tuple(t + 1 for t in cur)     # next op = same lanes, next tile
            if nxt not in blocks or nxt in seen:
                return False
            cur = nxt; seen.add(nxt)
    return True

# -> ['04261537'], unique among all 5040 orderings
```

The uniqueness claim holds exactly, and the implied processing schedules match the paper's: `bases → 04 → 15 → 26 → 37` for *T*=32, `bases → 0426 → 1537` for *T*=16. One wrinkle: §2.4 of the paper writes the order as `04261357`, which my checker rejects — after `04 → 15`, the pair `26` is not a block of that layout. The abstract, the proof two paragraphs later, and the figures all say `04261537`. It's a typo, but it's the kind that gets copied into an implementation.

## What it does on hardware I own

I implemented three unpackers for *W*=3 into `uint8` — a conventional "horizontal" one (value *i* at bit *i*·3, one 16-bit load and a variable shift per value), the interleaved kernel above, and the interleaved kernel written one `uint8` lane at a time — plus DELTA decoding in sequential and transposed order for *T*=32. Apple M3 Pro, clang 21, 1024-value vectors, L1-resident, 2M repetitions, best of three:

| kernel | values/ns | vs. horizontal |
|---|---|---|
| horizontal, scalar | 1.85 | 1.0x |
| interleaved, one lane at a time, auto-vectorized | **41.96** | 22.7x |
| interleaved, hand-written `uint64` quasi-SIMD | 19.04 | 10.3x |
| DELTA sequential (*T*=32) | 1.94 | — |
| DELTA transposed (*T*=32) | **7.25** | 3.7x |

Two things stand out. First, with auto-vectorization *disabled*, the `uint64` quasi-SIMD kernel is 8.6x the plain scalar one — the paper reports 8x for 8-bit values, and that reproduces almost exactly. Second, and more usefully: with the vectorizer on, the *simple* per-lane kernel beats my hand-rolled `uint64` version by 2.2x. The `memcpy`-based 8-byte lane groups pin the compiler to 64-bit granularity, while the naive loop is free to fill 128-bit NEON registers. That is the paper's software-engineering argument landing in the most concrete way possible: the layout is what creates the parallelism, and hand-written intrinsics are technical debt that actively costs you.

One divergence worth naming. The paper reports scalar decoding as *equally* fast on horizontal and interleaved layouts (interleaving costs nothing, and only unlocks upside). I measured interleaved scalar at 2.5x horizontal with the vectorizer off. My horizontal kernel pays a two-byte load plus a variable shift per value, where the interleaved schedule amortizes three loads over eight values with constant shifts — on a wide out-of-order ARM core that difference is real, so I'd treat "interleaving is free" as platform-dependent rather than universal.

## The bill

The cost is that tuple order within a 1024-value vector is permuted. FastLanes argues this is acceptable because relational algebra is set-based: operators generally don't care what order tuples arrive in, and where order matters it can be restored or carried in a selection vector. True for a scan feeding aggregations and joins; less true if you hand pointers into a format that promised insertion order. The permutation stays inside each vector, so min/max zone maps and predicate pushdown are unaffected.

The design also composes downward: FastLanes-RLE maps run-length encoding onto DELTA via a monotonically increasing index vector, delta-encoded at 1 bit per value, which beats classic RLE on space up to average run lengths of about 12 while decoding in the same order as every other column.

None of this needs new hardware, a new ISA, or intrinsics. It's a permutation, chosen so that the code a compiler already knows how to vectorize turns out to be the fast code.
