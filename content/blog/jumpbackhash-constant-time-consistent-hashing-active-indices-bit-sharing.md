---
title: "JumpBackHash: Constant-Time Consistent Hashing by Walking Active Indices Backwards"
date: 2026-10-05
tags: ["consistent-hashing", "distributed-systems", "sharding", "algorithms", "performance"]
excerpt: "JumpBackHash (Ertl, arXiv:2403.18682) replaces JumpHash's O(log n) floating-point loop with an integer-only walk over power-of-two intervals, consuming under 5/3 PRG outputs on average. I ported it and every formula reproduced. On an M3 Pro (n ≥ 100) it runs at 7.5–20 ns versus JumpHash's 59–221 ns. But its bit-sharing optimizations break something the paper never tests: on multi-node resizes, each departing shard's keys spread to survivors with χ²/dof up to 1035, versus 1.0 for JumpHash."
---

# JumpBackHash: Constant-Time Consistent Hashing by Walking Active Indices Backwards

Resizing `hash(key) % n` from n to n+1 buckets moves n/(n+1) of all keys. A *consistent* hash `ch(k, n)` moves only the 1/(n+1) that must land on the new bucket. JumpHash (Lamping & Veach, 2014) did this in five lines and now ships in Guava, ClickHouse and RabbitMQ. But it loops O(ln n) times, with a floating-point divide on every iteration.

*JumpBackHash* (Otmar Ertl, arXiv:2403.18682, v3 Nov 2025; in Hash4j since 0.17.0) uses only integer operations and a standard PRG, and runs in expected constant time. I ported it to Python and C, reproduced the analysis, benchmarked it on arm64, and tested one property the paper doesn't. That property fails.

## Active indices

Seed a PRG with the key, draw i.i.d. values R_0, R_1, …, and define `ch(k, n) = argmin_{b<n} R_b`. This is uniform. It is also monotone: going to n+1 changes the answer only when R_n is the new minimum, and then the answer is n. The catch is that it costs O(n).

Call b an **active index** if R_b is smaller than every R_b' with b' < b. Then `ch(k, n)` is the largest active index below n. JumpHash generates active indices *upward* (`next = floor((A+1)/U)`), which takes H_n ≈ ln n steps. Ertl goes *downward* instead: below any active index A, the next one is uniform on [0, A). To make that cheap he splits the range into intervals I_m = [2^m, 2^(m+1)):

1. I_m contains an active index with probability exactly 1/2, which costs one random bit X_m.
2. Its largest active index is uniform on I_m, which costs m random bits.
3. Smaller active indices inside I_m come from rejection sampling on [0, 2^(m+1)), which is just a mask.

Only two intervals ever matter: the one containing n−1, and the next populated one below it. The cost is therefore constant in expectation.

The speed comes from sharing bits. All the X_m bits come from one word U. The two Y draws come from V_0 or V_1, chosen by the parity of the set bits seen so far (eq. 18). U is set to V_0 ⊕ V_1 (eq. 19), and one rejection stream W serves every interval (eq. 17). Algorithm 6 ("JumpBackHash\*") packs V_0 and V_1 into a single 64-bit PRG output:

```python
def jump_back_hash(k: int, n: int) -> int:
    if n <= 1: return 0
    r = SplitMix64(k)
    v = r.next()                                   # V0 = low 32 bits, V1 = high 32
    u = ((v ^ (v >> 32)) & 0xFFFFFFFF) & ((1 << (n - 1).bit_length()) - 1)
    while u:                                       # at most 2 iterations
        q = 1 << (u.bit_length() - 1)              # interval I_m = [q, 2q)
        b = q + ((v >> ((bin(u).count("1") & 1) * 32)) & (q - 1))   # Y_m via parity
        while True:
            if b < n: return b
            w = r.next()                           # two W draws per 64-bit word
            b = w & (2 * q - 1)
            if b < q: break
            if b < n: return b
            b = (w >> 32) & (2 * q - 1)
            if b < q: break
        u ^= q
    return 0
```

## Reproduction

With α_n = 2^ceil(log2 n) / n ∈ [1, 2), eq. 25 predicts E[calls] = 1 + (α−1)α/(2α−1) < 5/3. Results from 20,000 keys per n:

| n | measured | eq. 25 | JumpHash | H_n |
|---|---|---|---|---|
| 129 | 1.658 | 1.658 | 5.38 | 5.44 |
| 65,537 | 1.665 | 1.667 | 11.71 | 11.67 |
| 1,000,000 | 1.046 | 1.046 | 14.46 | 14.39 |

Variances matched eq. 26 to within ±0.02. Monotonicity held with zero violations across 2,000 keys × n = 1…3000. Per-n uniformity also held: χ² = 87.9 on 99 dof at n = 100.

C port, clang -O2, Apple M3 Pro, 20M lookups, SplitMix64 everywhere:

| n | `k % n` | JumpHash | JumpBackHash\* |
|---|---|---|---|
| 128 | 7.5 ns | 61.8 | **7.5** |
| 129 | 7.7 | 60.4 | 20.1 |
| 1,000,000 | 6.4 | 150.1 | 8.0 |
| 2^30 | 5.9 | 220.7 | 8.4 |

At n = 2^i, JumpBackHash\* matches a hardware divide (7.5 vs 7.5 ns at 128; 7.9 vs 7.9 at 1024). At n = 2^i + 1 it is 2.6× slower than modulo, because half the keys take the inner loop and its branches mispredict. JumpHash is 5–26× slower than JumpBackHash\* for n ≥ 100.

## Untested: where do the moved keys go?

The paper only checks consistency for n → n+1, where every moved key goes to bucket n. Real clusters also resize by several nodes at once, say 16 → 4. Monotonicity guarantees that only keys on removed shards move. It says nothing about how each removed shard's keys spread across the survivors.

Under the ideal argmin construction they spread uniformly. If the minimum over [0, 16) is at index 12, the values R_0…R_3 are still exchangeable. JumpHash is equivalent to the argmin construction. JumpBackHash, by the paper's own admission (§2.5), is "no longer statistically equivalent to (4)". I measured the χ² of each removed shard's destination histogram against uniform over 600,000 random keys:

| resize | JumpBackHash χ²/dof | JumpHash χ²/dof | JBH destination share range |
|---|---|---|---|
| 16 → 4 | **1035** | 1.09 | 0.49×–1.51× |
| 32 → 8 | **791** | 0.88 | 0.46×–2.54× |
| 256 → 64 | **127** | 1.00 | one cell at 18× |
| 300 → 100 | **32.5** | 1.00 | one cell at 17× |

You can trace 16 → 4 by hand. For a key on shard 8–15, the bucket at n = 16 is 8 + (V_s & 7). At n = 4, if the key lands in I_1, its bucket is 2 + (V_s' & 1). The parities s and s' agree exactly when bit X_2 of U is set. When they do, the low bit of the old shard number *is* the new bucket. So shard 12 sends 37.5% of its keys to node 2 and 12.5% to node 3, instead of 25% each. Totals across all sources still balance; individual source→destination flows don't.

Two places this bites:

- **Migration bandwidth.** Bandwidth is consumed per sender-receiver pair. A drain of eight nodes makes particular receivers ingest 1.5–2.5× their share from particular senders.
- **Two-level routing with one key**, e.g. `shard = ch(k, 16)` then `replica = ch(k, 4)`. This is already broken for *any* consistent hash: monotonicity sends every key on shards 0–3 to sub-bucket = shard id. With JumpBackHash, shards 8–15 skew as well. Salting the second level (`ch(mix(k ^ SALT), 4)`) fixes it.

## The fix: independent streams per interval

The skew comes entirely from eqs. 17–19 sharing bits across intervals. Giving each interval its own stream restores independence:

```c
static inline int32_t jbh_indep(uint64_t k, int32_t n) {
    if (n <= 1) return 0;
    uint64_t s = k, X = splitmix(&s);              // one bit per interval
    for (int m = 31 - __builtin_clz((uint32_t)(n - 1)); m >= 0; m--) {
        if (!((X >> m) & 1)) continue;
        uint64_t t = k ^ ((uint64_t)(m + 1) * 0x9E3779B97F4A7C15ULL);  // per-interval stream
        uint32_t q = 1u << m, b = q + ((uint32_t)splitmix(&t) & (q - 1));
        for (;;) {
            if (b < (uint32_t)n) return b;
            b = (uint32_t)splitmix(&t) & ((q << 1) - 1);
            if (b < q) break;
        }
    }
    return 0;
}
```

The independent version passes the same checks: zero monotonicity violations, per-n χ²/dof = 0.95, and **χ²/dof of 1.00–1.02 on every resize above**. It runs at 14–25 ns, which is 1.2–2.2× the cost of JumpBackHash\* and still 2.4–15× faster than JumpHash for n ≥ 100.

## Practical notes

- **Switching algorithms reshuffles everything.** JumpHash and JumpBackHash agree on 0.99% of keys at n = 100, which is just the 1/n you'd expect by chance.
- **Be careful with the paper's "future work" shortcut** of using the key itself as V. With unhashed sequential IDs it put 25× the mean load on one of 100 buckets and left 26 buckets empty. Even with hashed keys, bucket 3 saw only 128 of 256 low-byte values, which hurts any node-local table indexed by `k & 0xFF`.
- **Removal is LIFO only.** To handle arbitrary node failures, wrap it in MementoHash's replacement table.

## Verdict

JumpBackHash is the right replacement for a resizable modulo. It is integer-only, uses a stock PRG, averages under 1.67 PRG calls per lookup, and costs about as much as a divide. Every claim in the paper reproduced. Its bit-sharing is safe for single-step resizes, which is all the paper's definition of consistency covers. If you resize by several nodes at once and care about per-pair transfer balance, or you reuse one key across routing levels, pay the extra 5–9 ns for independent per-interval streams.
