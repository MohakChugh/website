---
title: "KyberSlash and Clangover: When the Compiler Writes Your ML-KEM Side Channel"
date: 2026-11-01
tags: [post-quantum, ml-kem, side-channels, compilers, cryptography]
excerpt: "In 2024 the ML-KEM reference code had two timing leaks, neither visible in the C source: a division by q (KyberSlash) and a bit mask that clang turned back into a branch (Clangover). I re-checked both with Apple clang 21. The multiply-shift fix constants match division on all 3,329 inputs, and the d=4 and d=5 variants overflow uint32 on purpose. Clang keeps the real divide at -O0 and -Oz, and on Cortex-M0 it calls __aeabi_uidiv at every optimization level. Clangover still reproduces on x86-64 at -O1, -Os and -Oz. On an M3 Pro, udiv latency grows with the dividend's bit length. Kyber's d=1 operands come out flat, so testing on a Mac would wrongly clear KyberSlash1. ML-KEM-1024's du=11 compression is 10% slower for coefficients ≥ 2048."
---

# KyberSlash and Clangover: When the Compiler Writes Your ML-KEM Side Channel

"Constant-time" describes the instructions a CPU executes, not the C that produced them. In 2024 the ML-KEM (Kyber) reference implementation shipped two timing leaks that you could not see by reading the source:

- **KyberSlash** (Bernstein et al., TCHES 2025): `x / KYBER_Q` on secret-derived values. Division is variable-time on many CPUs. The authors recovered secret keys within minutes (KyberSlash2) and within a few hours (KyberSlash1) on a Raspberry Pi 2 (Cortex-A7) and a Cortex-M4.
- **Clangover** (Antoon Purnal, 2024): a textbook branchless mask in `poly_frommsg` that clang 15–18 compiled into a secret-dependent branch on x86 at `-Os`, `-O1` and `-O2/-O3 -fno-vectorize`. End-to-end ML-KEM-512 key recovery took 5–10 minutes on a Core i7-13700H.

Both are patched upstream, but vulnerable copies get re-flagged and cross-compiled. I re-ran both bugs with Apple clang 21 and measured what the division actually costs on an Apple M3 Pro.

## KyberSlash: rounding by division

ML-KEM compresses a coefficient `x ∈ [0, q)` with `q = 3329` to `d` bits as `round(2^d · x / q) mod 2^d`. The reference implementation wrote that literally:

```c
/* poly_tomsg, before the fix: d = 1, decrypting the secret message */
t = (((t << 1) + KYBER_Q/2) / KYBER_Q) & 1;
```

`poly_tomsg` (d = 1) runs on the decrypted message. That call site is KyberSlash1. `poly_compress` and `polyvec_compress` (d = 4, 5, 10, 11) run during the re-encryption step of the Fujisaki–Okamoto decapsulation. That is KyberSlash2. Both process values that depend on the secret key, and an attacker who controls ciphertexts can turn division latency into a plaintext-checking oracle.

The fix replaces each division with a multiply by a precomputed reciprocal and a shift:

```c
/* poly_tomsg, after the fix */
t <<= 1;  t += 1665;  t *= 80635;  t >>= 28;  t &= 1;
```

I checked every variant exhaustively against the division over all 3,329 inputs:

| d | offset | multiplier | shift | mismatches | other offsets that work | max product bits |
|---|---|---|---|---|---|---|
| 1 | 1665 | 80635 | 28 | 0 | none | 30 |
| 4 | 1665 | 80635 | 28 | 0 | none | **33** |
| 5 | 1664 | 40318 | 27 | 0 | none | **33** |
| 10 | 1665 | 1290167 | 32 | 0 | none | 43 (uint64) |
| 11 | 1664 | 645084 | 31 | 0 | 1663 | 42 (uint64) |

Two details stand out. First, the rounding offset is not always `q/2 = 1664`. For d = 1, 4 and 10 the reciprocal is rounded down (80635 < 2^28/q ≈ 80635.4), and only `1665` compensates. For d = 5 and 11 it is rounded up, and `1664` is correct. Neither offset is a typo.

Second, `poly_compress` declares `d0` as `uint32_t`. The d = 4 product overflows on 104 inputs and the d = 5 product on 52. Both are deliberate. They are exactly the inputs that round to `2^d` (`x ≥ 3225` and `x ≥ 3277`), which `mod 2^d` maps to 0 anyway. The result needs only bits 28–31 of the product, so wrapping modulo 2^32 loses nothing the mask would keep. Porting this to a narrower type breaks it.

## Does the compiler keep the divide?

Compilers usually do this rewrite themselves, which is why KyberSlash was easy to miss. I compiled the pre-fix code with Apple clang 21 and counted the divide instructions or division library calls left in each function:

| target | -O0 | -O1 | -O2 | -O3 | -Os | -Oz |
|---|---|---|---|---|---|---|
| arm64 | div | – | – | – | – | **div** |
| x86-64 | div | – | – | – | – | **div** |
| Cortex-M3 (thumbv7m) | – | – | – | – | – | **div** |
| Cortex-M0 (thumbv6m) | **call** | **call** | **call** | **call** | **call** | **call** |

`-Oz` optimizes for size, and one `udiv` is shorter than a multiply-high sequence. Cortex-M0 has no 32×32→64 multiply (`UMULL`), so clang emits 24 calls to the software divide `__aeabi_uidiv`, whose loop count depends on the data. There, the vulnerable source leaks at **every** optimization level. The fixed d = 10/11 code becomes calls to `__aeabi_lmul`, so check that your runtime's 64-bit multiply helper is also fixed-time.

## Is `udiv` variable-time on an M3 Pro?

To see what an Apple core does, I timed a dependent chain of `udiv`. Each dividend depends on the previous quotient through a shift that always yields zero, which forces the chain to measure latency. The thread ran at `QOS_CLASS_USER_INTERACTIVE`, and I took the minimum over 40 interleaved trials of 20M iterations:

```c
__asm__ volatile("udiv %w0, %w1, %w2\n\t"
                 "add  %w1, %w3, %w0, lsr #31"   /* x = base + 0, but serialized */
                 : "=&r"(q), "+r"(x) : "r"(div), "r"(base));
```

Latency is flat up to a threshold, then rises by about 10% per step. With divisor 3329 the steps fall at dividends of 2^22, 2^26 and 2^30 (+10%, +20%, +30%). With divisor 3 they start at 2^16, and with a 20-bit divisor the only step is at 2^30. The steps track the dividend's bit length relative to the divisor's, about one step per 4 extra bits. For divisors of 12 and 20 bits, the first step comes when the dividend is 11 bits longer than the divisor. That fits an early-terminating divider that retires a few quotient bits per cycle. It is a model fitted to my measurements, not anything Apple documents. For Kyber, what matters is where each compression level's operands fall relative to that first step. I timed the real operands:

| call site | dividend range | dividend bits | time vs. baseline |
|---|---|---|---|
| d = 1 (`poly_tomsg`, KyberSlash1) | 1664 – 8320 | ≤ 14 | 1.000 |
| d = 10 (ML-KEM-512/768 `du`) | ≤ 3,409,537 | ≤ 22 | 1.000 |
| d = 11, u = 2047 | 4,193,920 | 22 | 1.001 |
| d = 11, u = 2048 | 4,195,968 | 23 | **1.10** (+0.36 ns) |

On this core, KyberSlash1's division takes the same time for every secret. A constant-time test run on a Mac would pass the vulnerable `poly_tomsg`, yet the same code leaks on a Cortex-A7. ML-KEM-1024's `du = 11` compression, however, splits coefficients into two timing classes at u = 2048, because `2048 · 2^11 = 2^22` is exactly where the dividend gains its 23rd bit. That puts 38.5% of the coefficient range in the slow class. I did not attempt an end-to-end attack. The point is that "is division constant-time on my CPU?" has no global answer. It depends on the operand range at each call site, so a clean result on one microarchitecture does not carry over to another.

## Clangover: a mask that becomes a branch

`poly_frommsg` expands each message bit into 0 or `(q+1)/2`. The pre-fix code uses the standard mask trick:

```c
int16_t mask = -(int16_t)((msg[i] >> j) & 1);
r->coeffs[8*i+j] = mask & ((KYBER_Q + 1) / 2);
```

The optimizer can see that the mask is either all zeros or all ones, so it may rewrite the expression as a select, and on x86 a select may be lowered to a branch. I scanned the assembly for conditional jumps whose flags come from a `test`/`bt` of the message byte. On arm64, I also checked for `tbz`/`tbnz` and inspected every `b.cond` by hand. Apple clang 21 still reproduces the bug on x86-64:

| x86-64 flags | secret-dependent `jcc` (pre-fix) | with value barrier |
|---|---|---|
| -O0 | 0 | 0 |
| -O1 / -Os / -Oz | 1 per bit (inside the 8-bit loop) | 0 |
| -O2 -fno-vectorize | 8 per byte (unrolled) | 0 |
| -O2 / -O3 (vectorized) | 9 / 16, in the scalar alias-fallback path | 0 |

The `-Os` output is exactly the leak Purnal described:

```asm
    btl   %ecx, %r8d        ; test message bit j
    jae   LBB1_4            ; secret-dependent branch
    movl  $1665, %edx
LBB1_4:
    movw  %dx, (%rdi,%rcx,2)
```

With vectorization on, the main path at -O2/-O3 is branchless SIMD, but the scalar fallback that handles overlapping buffers still contains the branches. You are safe only because the vectorizer happened to run, which is not a property anyone should depend on. arm64, Cortex-M3 and Cortex-M0 produced no secret-dependent branch at any level. They use `sbfx`/`and`, `csel`, or IT-predicated `movgt`.

Context matters too. The same loop over a single byte compiles to `cmov` at -O1, while the full two-level loop compiles to `jae`. Checking a snippet in isolation tells you little about the function it ends up in.

The upstream fix hides the 0/1 range from the optimizer with an empty inline-asm barrier, and the result had zero branches across every target and level I tried:

```c
__asm__("" : "+r"(b));   /* compiler can no longer prove b ∈ {0,1} */
b = -b;
*r ^= b & ((*r) ^ v);
```

## What to take from this

1. **Audit the binary for every target × flag combination you ship.** The same source was safe at -O2 and leaky at -Oz, safe on arm64 and leaky on x86-64, and leaky at every level on Cortex-M0.
2. **A timing test on one microarchitecture does not clear another.** My M3 Pro would have passed KyberSlash1. Instruction-level checks are the right tool, such as the KyberSlash paper's patched Valgrind (which flags variable-time instructions on secret data) or an assembly scanner in CI.
3. **Check reciprocal constants exhaustively.** There are only 3,329 inputs, and the overflow behavior and the 1664/1665 offsets are easy to "correct" into bugs.
4. **Prefer implementations whose constant-time property is checked by a machine**, such as formally verified ML-KEM code. C that is constant-time only by convention depends on an optimizer that does not follow the convention.
