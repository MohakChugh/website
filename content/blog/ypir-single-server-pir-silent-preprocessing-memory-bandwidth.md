---
title: "The Hint Was the Problem: Silent Preprocessing in Single-Server PIR"
date: 2026-08-16
tags: ["cryptography", "lattices", "performance", "privacy", "systems"]
excerpt: "SimplePIR made private database queries fast by turning the database itself into an LWE matrix, then charged every client a 400 MB download for the privilege. YPIR deletes that download entirely. I re-derived the hint arithmetic, then benchmarked the online kernel and found the memory-bandwidth story only holds on wide-vector cores."
---

Private Information Retrieval is the primitive that sounds impossible when you first hear it: a client fetches record *i* from a server's database, and the server learns nothing about *i*. Not statistically nothing, cryptographically nothing. The trivial solution is to download the whole database, and for twenty years the non-trivial solutions were slower than that in practice.

Single-server PIR became practical in 2022 with SimplePIR (Henzinger et al.), which reported throughput in the gigabytes-per-second range on one core. The catch was a *hint*: a query-independent blob every client had to download before it could ask anything. For an 8 GB database that hint is hundreds of megabytes. YPIR (Menon and Wu, USENIX Security 2024, [eprint 2024/270](https://eprint.iacr.org/2024/270)) removes it completely while keeping the throughput. The interesting part is not the cryptography, which is a careful assembly of known pieces, but where the performance ceiling actually sits once you do.

## The database *is* the LWE matrix

Learning With Errors encryption of a message μ under secret **s** is a pair (**a**, b) where **a** is uniform and

```
b = ⟨s, a⟩ + e + Δ·μ,    Δ = ⌊q/p⌋
```

Decryption computes b − ⟨s, a⟩ = e + Δμ and rounds; it succeeds whenever |e| < Δ/2. The scheme is additively homomorphic essentially for free, because adding ciphertexts adds both messages and errors.

SimplePIR's observation is that a matrix-vector product against a *plaintext* matrix is just a lot of additions. Arrange the database as **D** ∈ Z_p^{ℓ₁×ℓ₂}. To fetch **D**[i][j], the client LWE-encrypts the indicator vector **u**_j:

```python
# ct = A·s + e + Delta * u_j,  A in Z_q^{l2 x n}
c = (A @ s + e + delta * u_j) % q          # client -> server, length l2
ans = (D @ c) % q                          # server -> client, length l1
# D @ c = (D @ A) @ s + D @ e + delta * D[:, j]
```

The client can strip the noise term if it knows **H** = **D·A** ∈ Z_q^{ℓ₁×n}. That matrix depends only on the database and the public **A**, never on the query, so it can be precomputed and shipped once. That is the hint. The server's online work per query is a single pass over **D** with one multiply-accumulate per plaintext entry, which is why the throughput is measured in GB/s rather than queries/s.

## Sizing the hint

The hint is Θ(√N), which sounds benign and is not. With log p = 8 (each Z_p entry holds one byte), an 8 GB database of 1-bit records has ℓ' = 2³³ plaintext entries, so a balanced split gives ℓ₁ = ℓ₂ = 2^16.5 ≈ 92,682. With LWE dimension n = 1024 and log q = 32:

```
hint = l1 * n * log q = 92682 * 1024 * 4 B = 362 MiB (380 MB)
```

The paper describes this as "over 200 MB"; the arithmetic says the balanced split is closer to 380 MB, and at 32 GB it lands at 724 MiB. Two things make this worse than a one-time cost. First, it is per-client, so it is egress. Second, and fatally, **H** is a function of **D** — every database update invalidates every client's hint.

That is not a hypothetical. The motivating applications are things like Certificate Transparency auditing (is this SCT in the log?), breached-password lookup, and private DNS. CT logs grow continuously. If clients refresh a 380 MB hint daily, at $0.09/GB egress you are paying

```
0.3796 GB * $0.09 = $0.0342 per client-refresh
1e6 clients * 7 refreshes/week = $239,000/week
```

for one 8 GB database, before a single query is served. DoublePIR shrinks the hint to a fixed size independent of N by recursively applying the same trick to **H** itself, but "fixed" still means tens of megabytes of churn, and it costs a second pass over the intermediate matrix.

## Silent preprocessing

YPIR's move is to keep DoublePIR's two-level structure but make the client's final decryption step happen *server-side*, homomorphically, so nothing query-independent needs to be downloaded at all. The server holds the client's LWE secret only in encrypted form, as key-switching material, and performs the hint subtraction itself.

The enabling primitive is LWE-to-RLWE packing (Chen, Dai, Kim, Song, CCS 2021). Take d separate LWE ciphertexts, each (n+1) elements of Z_q, and produce one RLWE ciphertext over a degree-d ring that encrypts Σμᵢx^{i−1} — two ring elements, i.e. 2d elements of Z_q. With n = d = 1024 that is 1024 × 1025 = 1,049,600 elements collapsed into 2048. In rate terms the ciphertext expansion drops from

```
(n+1)·log q / log p = 1025 * 32 / 8 = 4100x
2·log q / log p     =    2 * 32 / 8 = 8x
```

and it needs only O(log d) key-switching matrices, not d of them. For the 8 GB instance the resulting shape is a ~724 KB query (I get exactly 2 · 2^16.5 · 4 B = 724 KiB, matching the paper) and a ~12 KB response, against roughly 300 KB of response for plain SimplePIR. Upload got worse; the offline download went to zero.

## Preprocessing, and why not to go all-in on rings

Computing **D·A** naively is ℓ₁ℓ₂n work, which for a large database is hours. YPIR picks **A** to be a *negacyclic* structured matrix generated from a single vector, so the product becomes a negacyclic convolution computable with an NTT in O(ℓ₁ℓ₂ log d) — a d/log d asymptotic win, reported as roughly two hours down to eleven minutes.

The obvious next question is why not move the entire scheme into rings, as Spiral and OnionPIR do. Remark 4.1 in the paper answers it with a number: doing so drops online throughput from ~11.5 GB/s to ~3.2 GB/s. Ring-based schemes need an NTT-friendly modulus, and encoding a database into plaintext slots of such a ring wastes bits relative to the raw log q available. The plaintext-space efficiency loss shows up directly as bytes-scanned-per-second. The hybrid is not aesthetic weakness; it is where the arithmetic intensity actually is.

## What actually limits the online phase

The paper frames the online kernel as memory-bandwidth-bound and reports hitting ~83% of its server's bandwidth. That is a claim about a specific microarchitecture, so I wrote the kernel and measured it on an arm64 laptop core (128-bit NEON): a 1 GiB database, ℓ₁ = 8192 rows × ℓ₂ = 131072 columns of `uint8_t`, u32 accumulators, deferred modular reduction.

First result: a clean 4-way-unrolled read loop over the same 1 GiB sustains **17.35 GB/s** peak. The naive PIR kernel reached 6.0 GB/s. The gap is accumulator traffic — one 4-byte load and one 4-byte store per single database byte — plus a 512 KB `out[]` working set re-streamed on every row. Tiling the columns so accumulators stay L1-resident while **D** streams once fixes the second half:

```
for (j0 = 0; j0 < L2C; j0 += TILE)
  for (i = 0; i < L1R; i++) {
    const uint8_t *row = D + i*L2C + j0;
    uint32_t a = q[0][i], b = q[1][i], c = q[2][i], d = q[3][i];
    for (j = 0; j < TILE; j++) {
      uint32_t v = row[j];
      o0[j] += a*v; o1[j] += b*v; o2[j] += c*v; o3[j] += d*v;
    }
  }
```

Effective GB/s of database scanned, k = number of client queries batched into the same pass:

```
tile      k=1    k=2    k=4    k=8
 4096    3.19   5.00   6.08   3.93
16384    5.49   6.58   7.09   4.33
32768    6.28   7.22   7.49   4.21
65536    6.63   7.41   7.51   4.27
```

Three findings. **The bandwidth framing is microarchitecture-dependent.** My best single-query number, 6.75 GB/s, is 39% of the measured read ceiling, not 83%. A 512-bit widening multiply-accumulate makes the scan nearly free, so DRAM binds; a 128-bit core binds on MAC and store ports first, and never reaches the memory wall at all.

**Cross-client batching is arithmetic-intensity raising, and I reproduce the paper's multiplier.** Turning a matrix-vector product into a matrix-matrix product amortizes the database read across k queries. At k=4 I measure 1.38× over k=1 (5.15 → 7.12 GB/s in the run I checked most carefully), against the paper's reported ~1.4×.

**The gain is strongly coupled to the tile width, which the paper does not discuss.** At tile 4096 batching buys 1.91×; at tile 65536 it buys 1.10×, because the single-query case is already near the port limit. And k=8 regresses everywhere: k × tile × 4 B of accumulators exceeds L1d, so the tiling that made k=4 work is exactly what breaks k=8. Batch size and tile width are one tuning decision, not two.

## The part worth keeping

Strip the lattices and the result is a systems lesson. SimplePIR's hint was not a communication inefficiency to be optimized; it was a *state synchronization* requirement smuggled into a stateless protocol, and its true cost was proportional to database update rate, a variable that appears nowhere in the asymptotics. YPIR pays 2× in upload to delete it. If you are evaluating this class of scheme, the number to ask for is not throughput. It is the hint's invalidation rate — and then whether your cores are wide enough for the throughput figure to be about memory at all.
