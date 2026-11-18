---
title: "Signal's SPQR Ratchet, Simulated: Erasure-Coded ML-KEM Chunks, 87 Messages per Epoch, and Where the Incremental Braid Stops Paying"
date: 2026-11-18
tags: [cryptography, post-quantum, erasure-coding, protocols, simulation]
excerpt: "Signal's Triple Ratchet adds a post-quantum ratchet by slicing ML-KEM-768 keys and ciphertexts into 32-byte erasure-coded chunks, one per message. I checked the spec's arithmetic: 74 chunks per epoch (4.2% over a raw KEM), and an attacker must drop 99.947% of messages to stall it, versus 2.8% for naive chunking. I also simulated the scheduling. Under strict turn-taking an epoch costs exactly 2(3+36+5)−1 = 87 messages, against 141 without the incremental split. The advantage shrinks as messages come in runs and reverses at a mean run length of about 20."
---

The Double Ratchet heals after a compromise by doing a fresh Diffie-Hellman exchange on every turn of the conversation. Each DH public key is 32 bytes, so it rides in every message header for free. ML-KEM-768 doesn't fit that way: the encapsulation key is 1184 bytes and the ciphertext 1088.

Signal's answer is the **Sparse Post-Quantum Ratchet (SPQR)**. It ships as half of a "Triple Ratchet": the message key is a KDF over both the Double Ratchet output and the SPQR output, so an attacker has to break both X25519 and ML-KEM. Sources: [eprint 2025/078](https://eprint.iacr.org/2025/078) (Eurocrypt 2025), [USENIX Security 2025](https://www.usenix.org/system/files/usenixsecurity25-auerbach.pdf), the [ML-KEM Braid spec](https://signal.org/docs/specifications/mlkembraid/), and the [announcement](https://signal.org/blog/spqr/). Two ideas:

1. **Incremental KEM.** ML-KEM's ciphertext splits into a part that needs only the key's 32-byte seed and a part that needs the full key. Encapsulation can therefore start before the key has fully arrived.
2. **Erasure-coded chunks.** Each message carries one 32-byte codeword of whatever is in flight. Any N distinct codewords rebuild an N-chunk object, whatever their order and whichever ones were lost.

I re-derived the spec's constants, then simulated the braid's state machine to measure what an epoch costs under different conversation shapes.

## Why ML-KEM splits cleanly

In ML-KEM the public key is `ek = (t, ρ)`. Here t is a vector of k polynomials (1152 bytes for k=3) and ρ is a 32-byte seed that expands to the public matrix A. Encryption computes:

```text
(K, r) = G(m || H(ek))          # shared secret and coins
u = Compress(Aᵀ·r + e1)         # needs ρ (to expand A) and r
v = Compress(tᵀ·r + e2 + ⌈q/2⌋·m)  # needs t
ct = (u, v)
```

`u` needs only ρ and H(ek). That is why the braid's **header** is `ek_seed || hek`, 64 bytes, plus a 32-byte HMAC, for 96 bytes total. Once the header lands, the other side can sample its coins, compute **ct1 = u**, and even derive the shared secret, while the 1152-byte **ek_vector** is still on its way. **ct2 = v** has to wait for t. The spec's size table matches FIPS 203's compression parameters at every level:

| | ML-KEM-512 | ML-KEM-768 | ML-KEM-1024 |
|---|---|---|---|
| ek_vector (384·k) | 768 | 1152 | 1536 |
| ct1 = u (k·256·du/8) | 640 (du=10) | 960 (du=10) | 1408 (du=11) |
| ct2 = v (256·dv/8) | 128 (dv=4) | 128 (dv=4) | 160 (dv=5) |

For ML-KEM-768 with 32-byte codewords, the spec's counts are header 3, ek 36, ct1 30, and ct2 5 (128 bytes plus the MAC). That totals 74 chunks, or 2368 bytes, against 2272 bytes (71 chunks) for a raw ek plus ct. **The incremental split costs 96 bytes, about 4.2%**: one hash and two MACs.

This also explains an inconsistency in the announcement post. It gives the full EK as 37 chunks but EK1 + EK2 as 2 + 36 = 38. The extra chunk is `hek`. Splitting the key means sending its hash, and the hash costs exactly one codeword.

## The erasure code's real job is adversarial

Signal's transport is reliable. The threat is an adversary who drops *chosen* messages so the ratchet never advances and a stolen state stays valid.

Consider naive chunking that cycles indices 0..N−1. Dropping every message that carries one index stalls the decoder forever. The spec instead recommends a systematic Reed-Solomon code over GF(2^16), with RaptorQ as a fallback. The sender emits fresh evaluation points, and indices don't repeat for 2^16 messages. To stall decoding, the attacker can let through at most N−1 distinct codewords per 2^16 messages sent:

```python
pieces = {'hdr': 3, 'ct1': 30, 'ek': 36, 'ct2': 5}
for name, F in [('GF(2^8)', 256), ('GF(2^16)', 65536)]:
    print(name, {k: f'{100*(1-(n-1)/F):.3f}%' for k, n in pieces.items()})
print('naive', {k: f'{100/n:.1f}%' for k, n in pieces.items()})
```

```text
GF(2^8)  {'hdr': '99.219%', 'ct1': '88.672%', 'ek': '86.328%', 'ct2': '98.438%'}
GF(2^16) {'hdr': '99.997%', 'ct1': '99.956%', 'ek': '99.947%', 'ct2': '99.994%'}
naive    {'hdr': '33.3%',  'ct1': '3.3%',    'ek': '2.8%',    'ct2': '20.0%'}
```

The weakest link is always the largest object, the 36-chunk ek. The spec's figures ("about 99.9%" for GF(2^16), "about 86%" for GF(2^8)) are exactly `1 − 35/F`. Naive chunking can be stalled by dropping 1 in 36 of one side's messages during the ek phase. That passes for flaky connectivity; 99.947% is a visible denial of service. The spec's RaptorQ caveat also checks out: four decodes per epoch, each succeeding at N codewords with probability ≥ 0.99, fail together at most `1 − 0.99⁴ = 3.94%` of the time. That is the "about 4%" the spec mentions.

## Simulating epoch cost

K samples a keypair and streams header chunks, switching to ek once it hears ct1. E waits for the full header, then streams ct1. Once K holds all of ct1, its ek chunks carry an ack, and E switches to ct2 only with **both** the full ek and the ack. K decapsulates and the roles swap. Each message carries one chunk or nothing.

I modelled the conversation as a two-state Markov chain: the next message comes from the same sender with probability `s`, giving a mean run length of `1/(1−s)`. On top of that I added iid loss `p`. Each cell is 300k–400k messages:

| mean run | loss | braid (spec) | naive chunking | non-incremental KEM |
|---|---|---|---|---|
| 1 (strict alternation) | 0 | **87.0** | 87.0 | 141.0 |
| 1 | 0.3 | 126.1 | 308.9 | 201.8 |
| 2 | 0 | 92.2 | 92.2 | 142.3 |
| 5 | 0 | 106.6 | 106.6 | 146.0 |
| 10 | 0 | 126.8 | 126.8 | 149.1 |
| 20 | 0 | 166.1 | 166.1 | **160.6** |
| 50 | 0 | 265.4 | 265.4 | **190.3** |
| 50 | 0.3 | 313.5 | 497.5 | 251.6 |

The "non-incremental" column is a baseline I built for comparison: K streams the whole 37-chunk ek, and E waits for all of it before streaming 34 ciphertext chunks.

Three things stand out.

**Strict alternation has a closed form.** 87 = 2·(3 + 36 + 5) − 1. ct1 (30) finishes before ek (36), so K's chain (header, ek, ct2) sets the length and E's surplus ct1 codewords are padding. The baseline obeys the same law: 2·(37 + 34) − 1 = 141. **The incremental split saves 38% of messages per epoch, 1.62×**; 3.4% of messages carry nothing while E waits for the header.

**Erasure coding only matters under loss.** With p = 0 a systematic code and cyclic chunking behave identically, because every received index is new either way. At p = 0.3 the coupon-collector tail makes naive chunking 2.45× worse under alternation. On a reliable transport the adversarial case is the real argument.

**The incremental advantage reverses for bursty conversations.** The braid needs four dependent handoffs per epoch: header (K→E), ct1 (E→K), ack (K→E, which needs all of ct1), and ct2 (E→K). The monolithic exchange needs two. Under alternation a handoff costs one message; with runs of 20 or 50, each waits about a run length, while K sits in `KeysSampled` re-sending header codewords it no longer needs. Crossover is at a mean run of about 20 (166.1 vs 160.6). At a mean run of 50 the braid is 1.4× *slower* per epoch (265 vs 190 messages).

## Two scheduling tweaks, measured

Two cheap changes to the sending rules target the burst case:

- **Eager ek.** After three header codewords, K mixes in ek chunks (1 header : 3 ek) instead of waiting for ct1. ek is public and bound by `hek`, so sending it early leaks nothing new.
- **Interleaved ct2.** Once E has the full ek, it alternates ct1 and ct2 codewords instead of waiting for the ack.

| mean run | spec | eager | interleave | both |
|---|---|---|---|---|
| 1 | 87.0 | 87.0 | 87.0 | 87.0 |
| 10 | 126.5 | 120.0 | 125.9 | 119.9 |
| 20 | 165.8 | 150.6 | 160.1 | 144.9 |
| 50 | 267.4 | 235.5 | 247.1 | **203.0** |
| 50, p=0.3 | 314.5 | 279.9 | 290.7 | 250.0 |

Under alternation neither tweak changes anything; 87 is a hard floor set by K's chain. At a mean run of 50, combining both tweaks cuts epoch cost by 24%. That still isn't enough to beat the monolithic baseline's 190. The remaining gap is structural: four dependent phases, plus 3 extra chunks of overhead, plus the codewords wasted on interleaving.

The simulation can't price the spec's reasons for stricter ordering, such as a smaller state machine to verify in ProVerif and hax/F\*. Read these numbers as the cost of that simplicity, not a defect: for turn-taking chats the spec already sits at the floor.

## Healing time

Post-compromise security returns once an epoch whose keypair was sampled *after* the compromise completes: one to two epochs. That is 87–174 messages with strict turn-taking and about 265–530 at mean run 50, against one round trip for the classical Double Ratchet. That gap is the real price of post-quantum key sizes.

## Reproducing

About 120 lines of Python: decoders count distinct codeword indices (exact for a systematic MDS code), plus the Markov traffic model and baselines. No real cryptography, since message counts don't depend on bytes. The closed forms 2(H + EK + CT2) − 1 and 2(EK + CT) − 1 match the zero-loss runs exactly, and two independently written spec-schedule simulators agree within 1% in every cell. The tweak table comes from the second.
