---
title: "Rateless IBLTs: Set Reconciliation Without Knowing the Difference Size"
date: 2026-08-22
tags: [distributed-systems, coding-theory, networking, anti-entropy, algorithms]
excerpt: "Every set reconciliation scheme in production makes you guess the answer before you compute it. Invertible Bloom Lookup Tables need the difference size up front; guess low and decoding fails outright, guess high and you burn bandwidth. Rateless IBLTs (SIGCOMM 2024) remove the guess entirely by turning the sketch into an infinite stream of coded symbols with a 1/(1+αi) mapping density. I re-derived the closed-form index generator and simulated the peeling decoder to check the 1.35x overhead claim."
---

Two nodes each hold a set of fixed-length items and want to learn what the other is missing, in as few bytes as possible. This is *set reconciliation*: Dynamo-style anti-entropy repair, blockchain mempool and state sync, CRDT replicas catching up after a partition, transparency-log gossip, deduplicated backup indexes.

The information-theoretic floor is comfortable. If the symmetric difference has `d` items of `ℓ` bits each, you cannot beat `dℓ − d log₂ d` bits, essentially `dℓ` when `d ≪ 2^ℓ`. Crucially that bound does not depend on the set sizes — reconciling 3 differences between two million-item sets should cost three items' worth of traffic, not a million.

The awkward part is that every practical scheme demands you know `d` before you start.

## The sizing problem that makes IBLTs fragile

An Invertible Bloom Lookup Table is a fixed array of `m` cells. Each item is hashed into `k` of them (typically 3–4), and each cell accumulates an XOR sum, an XOR of item hashes as a checksum, and a count. Because every field is a linear (XOR / additive) function of its inputs, sketches subtract:

```
IBLT(A) ⊖ IBLT(B) = IBLT(A △ B)
```

Items present in both sets get XOR-ed in twice and vanish. You then run a *peeling* decoder: find a cell where exactly one item remains — detectable because its checksum equals the hash of its sum — recover that item, strip it from the other `k−1` cells it touches, and repeat.

This works beautifully when `m` is right, and not at all when it isn't. Size `m` for `d = 100`, hand it a difference of 400, and peeling stalls immediately: **you recover nothing**, not a partial answer. Size it for 400 and use it on a difference of 3, and you shipped a mostly-empty table. So deployments bolt on a difference-size estimator (Eppstein et al.'s strata estimator, min-wise sketches) costing a fixed ~15 KB regardless of how tiny the difference turns out to be — frequently more than the difference itself — and then oversize `m` anyway to push failure probability down.

The other branch of the family, PinSketch (shipped in Bitcoin Core's `minisketch`), uses BCH syndromes and hits overhead exactly 1.0. Its decoder finds roots of a degree-`d` polynomial over `GF(2^ℓ)`: `O(d²ℓ²)` work. Beautiful for `d` in the tens; unusable at 10⁵.

## Coded symbols, made infinite

*Rateless Invertible Bloom Lookup Tables*, from Lei Yang, Yossi Gilad and Mohammad Alizadeh (SIGCOMM 2024, arXiv:2402.02668), take the borrowed idea from rateless erasure codes like LT and Raptor: don't pick a code rate, emit symbols forever and let the receiver stop when it has enough.

A coded symbol keeps the same three fields, and the same linearity:

```python
class CodedSymbol:
    __slots__ = ("sum", "checksum", "count")

    def add(self, item):            # encode: fold a source symbol in
        self.sum      ^= item
        self.checksum ^= keyed_hash(item)
        self.count    += 1

    def __xor__(self, other):       # A's symbol minus B's symbol
        return CodedSymbol(self.sum ^ other.sum,
                           self.checksum ^ other.checksum,
                           self.count - other.count)
```

Alice streams `a₀, a₁, a₂, …`; Bob generates his own `b₀, b₁, …` over his own set and forms `aᵢ ⊕ bᵢ`, the coded symbol sequence for `A △ B`. `count` is signed, so a recovered item with `count = +1` is Alice's and `−1` is Bob's — provenance comes free. The peeling decoder never reads `count`; only the application does.

The interesting design question is: which coded symbols does an item map to, when there are infinitely many of them?

## The 1/(1+αi) mapping, and generating indices in constant time

Let `ρ(i)` be the probability that a random item maps to coded symbol `i`. The paper proves this is boxed in from both sides: `ρ(i)` cannot decay slower than `1/i^(1−ε)` (or early symbols get too dense to ever peel) and cannot decay faster than `1/i` (or later symbols get too sparse to carry new information). So `ρ` must be `Θ(1/i)`, and they pick

```
ρ(i) = 1 / (1 + α i)
```

Note `ρ(0) = 1`: *every* item maps to symbol 0. That is a deliberate termination trick — symbol 0 has degree `d`, so it becomes peelable only once the other `d−1` items are already recovered. Bob knows he is done when symbol 0 decodes. No explicit length field, no round trip to ask "was that everything?".

Naively sampling this means flipping a biased coin per index, which is `O(m)` work per item. Instead, sample the *gap* to the next mapped index. If `G = j − i`, its cumulative mass function telescopes into gamma functions, and at `α = 0.5` it collapses to something elementary:

```
C(x)    = x(2i + x + 3) / ((i + x + 1)(i + x + 2))
C⁻¹(r)  = √( ((3 + 2i)² − r) / (4(1 − r)) ) − (3 + 2i)/2
```

That lone `− r` in the numerator looks like a typo. It isn't. Setting `C(x) = r` and clearing denominators gives `x² + (2i+3)x − r(i+1)(i+2)/(1−r) = 0`, whose positive root has discriminant `(3+2i)²(1−r) + 4r(i+1)(i+2)`, and the `4i²+12i+9` terms cancel against `4i²+12i+8` to leave exactly `(3+2i)² − r`. I checked it symbolically: `C(C⁻¹(r)) − r` simplifies to 0. The whole generator is then eight lines:

```python
def mapped_indices(item, m_max, alpha=0.5):
    rng, idx, out = seeded_prng(item), 0, [0]   # rho(0) = 1
    while True:
        u = rng.random()
        g = (math.sqrt(((3 + 2*idx)**2 - u) / (4*(1 - u))) - (3 + 2*idx)/2
             if alpha == 0.5 else (idx + 1) * ((1 - u)**(-alpha) - 1))
        idx += max(1, math.ceil(g))
        if idx >= m_max:
            return out
        out.append(idx)
```

Two things make this deployable. The PRNG is seeded from the item itself, so the mapping is *universal* — Alice and Bob derive identical index sets with zero coordination, and a node can extend its own symbol stream lazily. And `α = 0.5` was chosen over the theoretically better `α = 0.64` for one banal reason: `α = 0.5` needs only a square root, while other values need a non-integer power, which was measurably slower on the CPUs they targeted.

Sampling 200,000 items over the first 40 indices reproduces the density exactly — empirical `ρ(1) = 0.6682` against `1/1.5 = 0.6667`, `ρ(20) = 0.0903` against `0.0909`. Expected degree over `m` symbols is `Σρ(i) = O(log m)`, which is where the `O(ℓ log d)` per-item encode cost comes from.

## What the overhead actually costs

Density evolution predicts overhead `η → 1.35` as `d → ∞`. I implemented the peeling decoder and measured symbols-consumed-until-complete directly (idealizing away hash collisions, as the analysis does):

| d | mean η | p95 η | (item, symbol) pairs per item |
|---|---|---|---|
| 1 | 1.000 | 1.000 | 1.00 |
| 4 | 1.776 | 3.000 | 3.39 |
| 16 | 1.653 | 2.188 | 5.75 |
| 64 | 1.490 | 1.750 | 8.30 |
| 128 | 1.430 | 1.578 | 9.60 |
| 512 | 1.390 | 1.469 | 12.34 |
| 2048 | 1.363 | 1.398 | 15.08 |
| 8192 | 1.355 | 1.375 | 17.78 |

The worst case is a *small* difference, peaking near `d = 4`, then it decays monotonically to 1.355 — matching the paper's 1.72–1.35 range and its claim that `d > 128` stays under 1.40. The right-hand column is the log growth in the flesh: 17.78 pairs per item at `d = 8192` against `2 ln(1.355 × 8192) ≈ 18.6`.

## The α knob has a cliff, not a slope

The paper reports that `α = 0.64` is optimal at `η* = 1.31` versus 1.35 for `α = 0.5`, and frames that 3% as negligible. That framing invites you to think `α` is a soft dial. It isn't. Sweeping it at `d = 512`:

| α | mean η | worst trial |
|---|---|---|
| 0.50 | 1.394 | 1.498 |
| 0.64 | 1.357 | 1.477 |
| 0.82 | 1.643 | 3.287 |
| 0.95 | 2.596 | 6.154 |
| 1.20 | 7.102 | 27.838 |

Past roughly 0.8 the mean degrades and the tail detonates — a single trial at `α = 1.2` needed 28× the difference size. That is the `ρ(i)` decays-too-fast bound asserting itself: thin out the later symbols and peeling runs out of pure symbols to chew on, so the decoder limps forward one lucky symbol at a time. If you implement this, `α` is a correctness-adjacent constant, not a tuning parameter.

## Where this belongs in your stack

The paper states the trade honestly: PinSketch's overhead of 1.0 is 37–60% better, and if bandwidth is your only scarce resource and `d` is small and known, it still wins. Rateless IBLT's case is everything else — 2–2000× higher encode and 10–10⁷× higher decode throughput at comparable communication, ~120 MB/s of items on a single 2016-era core, and no estimator, no sizing, no failure cliff. Their Ethereum state-sync prototype finished 4.8–13.6× faster than production state heal, largely because state heal needs 11+ rounds of interactivity while this needs half of one.

One footnote worth internalizing before shipping it: hash collisions are an *adversarial* concern, not merely a probabilistic one. An attacker who injects an item whose hash collides with one the peer holds cancels the checksum but corrupts the sum, and reconciliation never converges. Use a keyed hash (they use SipHash-64) under a key the two peers agree on. The reference library is 353 lines of Go — unusually small for a scheme sitting this close to an information-theoretic bound.
