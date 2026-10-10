---
title: "Aleph Filter: Growing a Quotient Filter Forever in O(1), and the Generation-Zero Term Its FPR Bounds Miss"
date: 2026-10-11
tags: ["filters", "data-structures", "hashing", "probabilistic", "databases"]
excerpt: "Aleph Filter (VLDB 2024) lets a quotient filter double indefinitely without the original keys and keeps every query to one hash table by duplicating fingerprints that have run out of bits. I rebuilt its expansion logic as an exact bucket simulator. The fixed-width FPR matches Eq. 2 to two decimals. The widening and predictive bounds come in 1.3× and 1.4–1.7× too optimistic because the initial generation is twice as large as the model assumes and three generations around the target size get the same fingerprint length. One extra bit fixes the first. The longest-match delete rule holds: 0 false negatives against 536 for the shortest-match rule."
---

# Aleph Filter: Growing a Quotient Filter Forever in O(1), and the Generation-Zero Term Its FPR Bounds Miss

Bloom filters can't grow without rereading the keys, which is exactly the I/O a filter exists to avoid. Quotient filters can. Each entry stores the high bits of a hash (the fingerprint) in the slot named by the low bits (the canonical address). To double the table, you move the fingerprint's lowest bit into the address. Every expansion costs one fingerprint bit, so after k expansions the FPR has risen 2^k-fold, and after F expansions the fingerprints are gone.

Dayan, Bercea and Pagh's [*Aleph Filter: To Infinity in Constant Time*](https://arxiv.org/abs/2404.04703) (PVLDB 17(11), 2024) is the third step in fixing this. I rebuilt its expansion, query and delete logic in about 80 lines of Python and checked the paper's FPR equations against it.

## Three ideas stacked

**Variable-length fingerprints (InfiniFilter, SIGMOD '23).** A self-delimiting unary pad lets one table hold fingerprints of different lengths, so old entries shrink but new ones start at full length. The table doubles at each expansion, so generation *j* (keys inserted between expansions *j* and *j+1*) makes up about 2^(j−X−1) of the keys after X expansions. Its fingerprints have shrunk by X−j bits. These cancel: each generation adds α·2^(−F−1) to the FPR. In this **Fixed-Width Regime** the FPR grows with log N rather than with N.

**Void duplication (Aleph).** A fingerprint with zero bits left is *void*: it matches any query that reaches its run, and you can't tell which half of the doubled table it belongs in. InfiniFilter moves them into a chain of smaller tables that queries must search. Aleph copies each void entry into *both* child slots on expansion. Every key that reached the void entry still reaches a copy, so all queries end after one table probe. The copies are cheap. Generation *j*'s void entries double in number each expansion while that generation's share of the keys halves, so their space and FPR cost stays fixed at α·2^(−F−1) per void generation.

**Deferred deletes.** A void entry may have 2^(k−b) copies, where 2^k is the slot count and *b* is the length of its mother hash (address plus fingerprint bits) when it went void. Rather than delete them all at once, Aleph turns the matching copy into a tombstone, logs its address, and cleans up just before the next expansion. Mother hashes of void entries live once each in a secondary table about 2^−F the main one's size. The cleanup looks up the **longest** matching mother hash and removes its copies from every slot whose address ends in those *b* bits. Choosing the longest match keeps every other key that might own a shorter match covered.

## The simulator

One list per canonical slot. Robin Hood shifting is left out because it affects speed, not which entries match.

```python
def expand(s):
    nt = defaultdict(list); bit = 1 << s.k; used = 0
    for a, run in s.t.items():
        for fp, L in run:
            if L == 0:                      # void: duplicate to both children
                nt[a].append((0, 0)); nt[a | bit].append((0, 0)); used += 2
            else:                           # sacrifice fingerprint LSB to address
                nt[a | ((fp & 1) * bit)].append((fp >> 1, L - 1)); used += 1
    s.t, s.used, s.k, s.gen = nt, used, s.k + 1, s.gen + 1

def query(s, h):
    run = s.t.get(h & ((1 << s.k) - 1))
    q = h >> s.k
    return bool(run) and any(L == 0 or fp == (q & ((1 << L) - 1)) for fp, L in run)
```

A regime is a function ℓ(j) giving new entries' fingerprint length. I used F = 8, started with 256 slots, expanded at 80% occupancy (the paper's threshold), and measured FPR just before each expansion with 400k random negative queries. The table reports FPR divided by α·2^−F, so 1.0 means a static F-bit filter at the same load:

| X | Sacrifice ℓ=F−j | Fixed ℓ=F | Widening ℓ=F+⌈2·lg(j+1)⌉ | Predictive (X_est=10) |
|---|---|---|---|---|
| 0 | 1.02 | 1.02 | 1.02 | 0.01 |
| 4 | 15.6 | 2.95 | 1.21 | 0.04 |
| 8 | 176 (all void) | 5.04 | 1.25 | 0.74 |
| 10 | 176 | 5.97 | 1.22 | **1.73** |
| 12 | 176 | 7.02 | 1.31 | 1.88 |

Fingerprint Sacrifice is fully void by X = 8, with 55% false positives. Fixed-width matches Eq. 2's α·(X+2)·2^(−F−1) closely: X = 12 predicts 7.0 and the sim gives 7.02. Void copies take 0.94% of slots at X = 12, which is the small overhead the paper promised.

## Widening: Eq. 3 drops a factor of two

The **Widening Regime** gives generation *j* fingerprints of F + 2·log₂(j+1) bits. Its contributions then scale as 1/(j+1)², which sum to π²/6. Eq. 3 bounds the FPR by α·2^(−F−1)·π²/6 ≈ 0.82·α·2^−F and states the result as "≲ α·2^−F". The sim settles at 1.21–1.31, above that bound.

The cause is Eq. 1, which sets f(j) ≈ 2^(−X+j−1). That holds for j ≥ 1 but not for generation 0. The first table fills to 0.8·2^k₀ keys. After doubling it sits at 40% and takes the same number of keys again before the next expansion. Generation 0 is therefore as large as generation 1, f(0) = 2^−X, and that is twice the formula's value. Eq. 2's extra (X+2)th term absorbs this. In the widening sum, generation 0 has the largest weight (1/1²), so doubling its weight raises the total from about 1.5 to 2.5 units of α·2^(−F−1):

```python
# FPR / (alpha * 2^-F); widening -> 1.238 at X=10, 1.261 at X=40 (sim 1.22-1.31)
f = lambda j, X: 2.0**-X if j == 0 else 2.0**(j - 1 - X)
model = lambda ell, X: 2**F * sum(f(j, X) * 2.0**(X - j - ell(j)) for j in range(X + 1))
```

The same correction takes the fixed-width void-fraction formula from 0.78% to 0.94% at X = 12, which matches the sim.

The fix is one bit, used once. Give generation 0 F+1 bits and the widening FPR falls to 0.74 in the model and 0.70–0.74 in the sim, back under the paper's bound. Generation 0 lives in the smallest table, so the bit is nearly free.

## Predictive: "at most 2^−F" at the target is really about 1.7·α·2^−F

The **Predictive Regime** (Eq. 4) is the paper's most practical idea. Given an estimate of X_est expansions, start with *long* fingerprints and shorten them:

ℓ(j) = F + 2·⌈log₂ max(|X_est − 1 − j|, 1)⌉

With F = 8 and X_est = 10, generation 0 starts at 16 bits. At X = X_est the effective lengths across generations are `[6, 5, 6, 7, 8, 7, 8, 7, 6, 7, 8]`. None exceeds F, so the slot width is the same as a static F-bit filter's, as the paper claims. Widening is giving new entries 15 bits by then.

The FPR claim is the one that's off. The paper says that at X_est the FPR "turns out to be at most 2^−F by the same analysis" as the widening regime. That analysis doesn't carry over. The `max(·, 1)` clamp maps |X_est − 1 − j| ∈ {0, 1} to the same value, so **three** generations (X_est−2, X_est−1, X_est) all get exactly F bits. Each adds a full α·2^(−F−1), compared with one such term in the widening sum. The result is about 3.5 units, or 1.72·α·2^−F. The sim measured 1.73: an FPR of 0.0054 against 2^−8 = 0.0039, 38% over the stated bound at α = 0.8. That is 0.8 bits worse than a static filter, so "on par" is fair in spirit. Past the estimate, the model converges to 1.97·α·2^−F, which stays below the paper's limit of 2^(−F+1) for any α < 1. That claim holds.

Also, Eq. 5 as printed flips the exponent's sign: 2^(ℓ(j)−(X−j)) should be 2^(−ℓ(j)+(X−j)).

## The delete rule holds up

I stressed the longest-match rule on a tiny filter (F = 3, 16 initial slots, 9 expansions, 2,256 keys) full of void entries, deleted a random half of the keys, and queried every survivor, over 20 seeds:

| Victim selection | False negatives on live keys | Deletes that found nothing |
|---|---|---|
| Longest matching fingerprint / mother hash | **0 / 22,560** | 0 |
| Shortest matching | 536 / 22,560 (2.4%) | 238 |

The shortest-match rule sometimes removes the entry covering a different key, whose own delete later finds nothing. That accounts for the 238 failed deletes.

## What to take from it

- **Aleph's real gain is one hash table per query** at InfiniFilter's FPR. Figure 13(D) of the paper shows it on queries to the oldest keys, where InfiniFilter's latency climbs.
- **Model generation 0 separately.** With a fixed expansion threshold, the initial fill equals the first post-expansion generation, so a pure geometric series understates the heaviest term by 2×.
- **For the predictive regime, budget about 1.7·α·2^−F at the target size, not 2^−F**, or add one bit. You still get static-filter slot widths at the planned size and graceful growth past it, without rereading a key.
