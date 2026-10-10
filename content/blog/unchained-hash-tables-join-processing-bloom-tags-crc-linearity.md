---
title: "Unchained Hash Tables for Joins: The 1/169 Bloom Tag Checks Out, Except on Dense Keys, Where CRC Linearity Doubles It"
date: 2026-10-10
tags: ["databases", "hash-joins", "bloom-filters", "hashing", "performance"]
excerpt: "Umbra's unchained join hash table (DaMoN 2024) stores tuples in a prefix-summed adjacency array and puts a 16-bit, 4-bits-per-tuple Bloom tag in the unused upper bits of every directory pointer. I reproduced the paper's false-positive model exactly (1/168.8 against the stated 1/169), though only at fill 2/3, not the stated ≈65%. I then ran the paper's CRC32C hash, checked against the M3's hardware crc32cw instruction. With dense primary keys 0..n−1 probed by the keys just past them, the filter's false-positive rate is 1/88. Each probe is 18× more likely than chance to have a build-side twin with the same slot and the same tag."
---

# Unchained Hash Tables for Joins: The 1/169 Bloom Tag Checks Out, Except on Dense Keys, Where CRC Linearity Doubles It

Birler, Schmidt, Fent and Neumann's DaMoN 2024 paper *Simple, Efficient, and Robust Hash Tables for Join Processing* describes the join hash table in Umbra and CedarDB. The authors report 2× over Robin Hood open addressing on relational benchmarks and up to 20× over chaining and open addressing on graph queries with heavy duplicates. The design:

1. **Directory plus adjacency array.** The directory has 2^k slots, indexed by the top bits of a 64-bit hash. Build tuples sit in one contiguous buffer, sorted by slot. Slot `i` points to the *end* of its range, and slot `i−1` gives the start. There are no chains, which is why the table is "unchained".
2. **A Bloom filter in the pointer.** Addresses fit in 48 bits, so each 64-bit entry stores the pointer shifted left by 16, and the free low 16 bits hold a filter. Each tuple ORs a 4-of-16-bit tag into it.
3. **A lock-free parallel build.** Tuples are hash-partitioned into thread-local bump allocators. Each partition then counts tuples per slot in the directory words, runs an exclusive prefix sum, and scatters the tuples. Every thread owns a disjoint range of slots.

The probe path (the paper's Figures 4 and 6):

```c
u16 tags[1 << 11];                       // 1820 4-bit patterns, padded to 2048
u64 entry = directory[hash >> shift];
u16 tag   = tags[(u32)hash >> 21];
if (tag & ~entry) return;                // andn; also rejects empty slots
for (T* t = directory[slot-1] >> 16; t != entry >> 16; ++t)
    if (t->key == key) produce(t);
```

Rejecting a non-matching probe takes five instructions and a branch. That matters because the probe side is orders of magnitude larger than the build side, and in a selective join most probe tuples have no partner.

Duplicates are where the layout pays off. Open addressing stores 10,000 copies of a key in 10,000 neighbouring slots. Chaining keeps them in one slot but makes the scan a series of dependent pointer loads. The adjacency array keeps them in one slot as a sequential scan. Duplicates also share a tag, so that slot's filter has only 4 bits set. This is where the 20× on LDBC and CE graph queries comes from.

## Reproducing the 1/169

The paper sizes the directory at `m = 2^⌈log2(1.125n)⌉` slots, models slot occupancy as Poisson with λ = n/m ≈ 65%, and states that 4 bits per tuple is optimal at that fill, with a false-positive rate of **1/169** (1/168 with the padded table). I computed this exactly. For a slot holding k tuples, the false-positive probability is `E[C(|U_k|, b)] / C(16, b)`, where `|U_k|` is the popcount of the union of k random tags:

```python
from math import comb, exp, factorial
def fpr(lam, b, W=16, kmax=40):
    dist, total = [1.0] + [0.0]*W, 0.0          # P(|union| = u) after k tags
    for k in range(kmax + 1):
        pk = exp(-lam) * lam**k / factorial(k)
        total += pk * sum(p * comb(u, b) / comb(W, b) for u, p in enumerate(dist))
        nxt = [0.0]*(W+1)
        for u, p in enumerate(dist):
            for j in range(min(b, W-u) + 1):    # j new bits outside the union
                nxt[u+j] += p * comb(W-u, j) * comb(u, b-j) / comb(W, b)
        dist = nxt
    return total
```

At λ = 0.65 this gives **1/178**. Getting 1/169 needs λ ≈ 0.666, and that is in fact the mean fill. Within one octave of n, `1.125n` is uniform in (m/2, m], so `E[n/m] = 0.75/1.125 = 2/3`. At λ = 2/3 the model gives **1/168.8**. For the padded table (228 of the 1820 patterns appear twice), Monte Carlo gives 1/167 to 1/169. Both of the paper's numbers reproduce. "≈65%" is a rounded 66.7%.

The paper doesn't mention how much the fill rate moves. Because m is a power of two, λ ranges from 0.444 to 0.889 within each octave:

| λ = n/m | 1 bit | 2 bits | 3 bits | **4 bits** | 5 bits | 6 bits |
|---|---|---|---|---|---|---|
| 0.444 | 1/37 | 1/160 | 1/320 | **1/387** | 1/353 | 1/277 |
| 0.667 (mean) | 1/25 | 1/90 | 1/154 | **1/169** | 1/147 | 1/113 |
| 0.889 | 1/19 | 1/59 | 1/90 | **1/93** | 1/78 | 1/60 |

Four bits is optimal at every fill a power-of-two directory can reach, which justifies the fixed tag table. But the false-positive rate a join actually gets **varies 4.2× with build-side cardinality**. Without a filter, 48.7% of non-matching probes would land in a non-empty slot.

## Running the paper's actual hash

The Poisson model assumes slot bits and tag bits are independent and uniform. The 4-byte hash in the paper's Figure 8:

```c
u64 hash32(u32 key, u32 seed) {
    u64 k = 0x8648DBDB;
    u32 crc = crc32(seed, key);          // x86 crc32 = CRC-32C
    return crc * ((k << 32) + 1);
}
```

Multiplying by `(k << 32) + 1` gives `crc + ((crc·k mod 2^32) << 32)`. **The low 32 bits are the raw CRC**, so the tag index `(u32)hash >> 21` is the CRC's top 11 bits, unmixed. CRC-32C is affine over GF(2): `crc(s, x) ⊕ crc(s, y)` depends only on `x ⊕ y`.

I implemented CRC-32C in NumPy and checked it against `__crc32cw` on an Apple M3 (ARMv8's CRC32C has the same semantics as x86's). I then built the directory exactly as described: n = 1,398,101, m = 2^21 (λ = 2/3), padded tag table, and 2M non-member probes:

| build keys | probe keys | empty slots | FPR |
|---|---|---|---|
| Poisson model | n/a | 0.513 | 1/169 |
| random u32 | random u32 | 0.513 | 1/161 |
| dense 0..n−1 | random u32 | 0.515 | 1/163 |
| dense 0..n−1 | 2^31 + i | 0.515 | 1/182 |
| `i << 11` | `(i << 11) + 1024` | 0.514 | 1/177 |
| **dense 0..n−1** | **n, n+1, …** | 0.515 | **1/88** |

Slot occupancy is Poisson in every case. The filter is not. With a dense build side (surrogate keys, auto-increment IDs, a range-filtered dimension table) probed from the *neighbouring* key range, the false-positive rate is **1.9× the model's**.

The cause is linearity. The most frequent XOR between keys that share a slot and a tag is `0x1320E6`, and every key pair at that distance has CRCs that differ by exactly `0x322D`:

```python
d = crc32c(SEED, x) ^ crc32c(SEED, x ^ 0x1320E6)   # 100,000 random x
assert (d == 0x322D).all()                          # bits 0..13 only
```

`0x322D` sets no bit at or above 21, so such pairs **always share a tag index**, and the `·k` multiply puts them in the same slot about 1% of the time. Both keys lie inside a dense range, so the twin is usually present. The next most common XOR is `2·0x1320E6`, which gives a CRC difference of `0x645A`. Counted directly, **0.58% of probes have a build key with an identical slot and tag index**, against 0.033% for random hashing (18×). A twin is a guaranteed false positive, and twins account for almost all of the gap between 1/169 and 1/88.

Mixing the bits the tag reads removes the problem:

| hash | dense/neighbour FPR |
|---|---|
| paper `hash32` (raw CRC in low half) | 1/88 |
| `crc32c(key) * 0x2545F4914F6CDD1D` (one imul) | 1/159 |
| paper `hash64` on 8-byte keys | 1/164 |
| murmur3 `fmix64`, no CRC | 1/169 |

The paper's `hash64` already multiplies the combined CRC by a full 64-bit constant. Only the 4-byte path leaves the raw CRC where the tag reads it. I tested the code as printed in the paper; production Umbra/CedarDB may differ. The general rule still holds: when one hash supplies both slot and filter bits, the filter is only as good as the mixing applied to the bits it reads.

This matters most in exactly the case the tag is designed for: very selective probes against a small dense build side. There, a false positive is a wasted cache miss into tuple storage, and dense neighbouring keys double how often that happens.

## Takeaways

- **The unchained layout is the main contribution.** A prefix-summed adjacency array keeps chaining's resistance to duplicates and adds sequential scans. The build is a lock-free count, prefix sum and scatter.
- **A 4-of-16 tag is optimal at every reachable fill.** The paper's 1/169 is exact at the octave-mean fill of 2/3, but expect anything from 1/387 to 1/93 depending on n.
- **Don't take filter bits straight from a CRC.** It is a fast, well-spread slot hash, but its bits are affine in the key. One extra `imul` restores the model's false-positive rate.
