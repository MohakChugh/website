---
title: "Chorba CRC32: Every Fast Polynomial Is an Error CRC-32 Can't Detect"
date: 2026-10-27
tags: ["crc", "checksums", "performance", "zlib", "error-detection"]
excerpt: "Chorba computes CRC32 without lookup tables or carry-less multiply by XORing each word forward along a sparse multiple of the generator. I re-derived its polynomials, checked them against stock zlib, and benchmarked zlib-ng's implementation on an M3 Pro. The paper's search table is CRC-32's published Hamming-distance profile shifted by 32. Five of its six polynomials are written in bit-reflected form, and the sixth isn't. The 'densest' polynomial is a 1-in-200 outlier, and a denser one exists inside the paper's own 2^20 search bound. In zlib-ng, the large variant is 2.2× faster than braiding. Its doc comment understates the minimum input by half, and the size thresholds leave 21–51% throughput unused."
---

# Chorba CRC32: Every Fast Polynomial Is an Error CRC-32 Can't Detect

Sam Russell's *Chorba: A novel CRC32 implementation* (arXiv 2412.16398, Dec 2024) computes CRC32 with only XORs and shifts: no lookup table, no carry-less multiply. It claims 2× the throughput of the best table-based ("braided") code, and parity with hardware CRC on x86-64 and ARMv8. zlib-ng now ships it as its generic fallback. I re-derived every polynomial, tested them against stock zlib, and benchmarked zlib-ng's code.

## The trick

A CRC is `M(x) mod G(x)` over GF(2). Adding any multiple of G leaves it unchanged. Russell calls such multiples **zero polynomials**. Take `x^300 + x^211 + x^183 + x^145 + 1`, which is a multiple of the (reflected) CRC-32 polynomial. Read as stream offsets: a bit at position p can be cleared by flipping bits p+145, p+183, p+211 and p+300. Squaring in GF(2) doubles every exponent, so the same holds at 64-bit word granularity. A word at index k can be XORed into words k+145, k+183, k+211 and k+300 and then dropped. Only the short tail needs a conventional CRC:

```python
import zlib

OFFSETS = (145, 183, 211, 300)   # x^300 + x^211 + x^183 + x^145 + 1, scaled to words

def crc32_chorba(data: bytes) -> int:
    n = len(data) // 8
    w = [int.from_bytes(data[8*i:8*i+8], "little") for i in range(n)]
    if n: w[0] ^= 0xFFFFFFFF            # fold zlib's ~0 initial value into the data
    k = 0
    while k + OFFSETS[-1] < n:          # push each word forward, then forget it
        for o in OFFSETS:
            w[k + o] ^= w[k]
        k += 1
    if k == 0:
        return zlib.crc32(data)
    tail = b"".join(x.to_bytes(8, "little") for x in w[k:]) + data[8*n:]
    return zlib.crc32(tail, 0xFFFFFFFF) # zero words are a no-op on a zero register
```

This matches `zlib.crc32` from 0 bytes to 1 MB. Because the smallest offset is 145, 145 consecutive words are independent, which gives braiding's instruction-level parallelism without its table lookups. The paper's "scaled by 8" means 8 *bytes* per term, so `chorba_118960` uses `x^14870 + x^22 + x^11 + x^7 + 1` with offsets in words. Its farthest write lands 118,960 bytes ahead.

## Finding 1: the search table is CRC-32's Hamming-distance profile

The paper tabulates the lowest-degree zero polynomial for each term count. I recomputed all 15 rows (direct search for 3–5 terms, meet-in-the-middle for 6–9, all 2^21 multiples `G·Q` for 10+), and every one matches. They also match something the paper doesn't mention.

A zero polynomial with w terms is exactly a w-bit error pattern that CRC-32 can't detect. So the lowest degree for w terms, minus 32, is the longest data word for which CRC-32 still has Hamming distance w+1. Koopman's published table for CRC-32 (0x82608EDB) agrees row for row:

| Terms | Min degree (paper = mine) | Koopman HD | Max data bits for that HD |
|---|---|---|---|
| 2 | 2^32 − 1 | 3 | 4,294,967,263 |
| 3 | 91,639 | 4 | 91,607 |
| 4 | 3,006 | 5 | 2,974 |
| 5 | 300 | 6 | 268 |
| 11 | 44 | 12 | 12 |

So the trade-off Chorba tunes is the code's minimum distance. CRC-32 detects every 5-bit error in short messages, which is the same fact as "no 5-term zero polynomial below degree 300". A generator with better short-message HD (Castagnoli's CRC-32C, say) necessarily has fewer cheap Chorba polynomials.

## Finding 2: the polynomials mix two bit orders

Under the paper's own stated generator, `0x104C11DB7`, five of its six example polynomials don't reduce to zero. They're zero polynomials of the *reciprocal* generator, the form a reflected (LSB-first) CRC like gzip's needs. The dense 4-term polynomial `x^5869 + x^5835 + x^5821 + 1` goes the other way: it's a multiple of G itself. A direct test with stock zlib shows the difference:

```python
def undetected(offsets, p=1000):          # flip bits at p+o; does zlib notice?
    b = bytearray(buf)
    for o in offsets:
        j = p + o; b[j // 8] ^= 1 << (j % 8)
    return zlib.crc32(b) == zlib.crc32(buf)

undetected([0, 7, 11, 22, 14870])   # True
undetected([0, 145, 183, 211, 300]) # True
undetected([0, 5821, 5835, 5869])   # False  (as printed)
undetected([0, 34, 48, 5869])       # True   (its reciprocal)
```

In the paper's notation it should read `x^5869 + x^48 + x^34 + 1`. That's consistent with the text, which says the terms span "48 words". zlib-ng isn't affected, since it uses offsets {7, 11, 22, 14870} and {145, 183, 211, 300}, but anyone porting the paper's polynomials needs to check which bit order each one is in.

## Finding 3: "the densest" is an outlier, and not quite the densest

The paper calls `x^14870 + x^22 + x^11 + x^7 + 1` "the densest 5-term zero polynomial". What makes it fast is the low cluster's span: 22 words of state, which fit in ARMv8's registers. Any three low terms have a partner degree a, because x generates the whole multiplicative group, so a is just a discrete logarithm. I computed it exactly with Pohlig–Hellman (2^32 − 1 = 3·5·17·257·65537) and took the minimum over every cluster:

| Low-cluster span | Smallest top degree a |
|---|---|
| 3 | 3,164,505,774 |
| 10 | 33,053,880 |
| 20 | 2,122,832 |
| **21** | **951,835** |
| **22** | **14,870** |
| 23 | 954,453 |
| 44 | 29,740 (next best below 60) |

Two things stand out. First, `x^951835 + x^21 + x^16 + x^14 + 1` is denser and still fits inside the 2^20 table the paper searched. "Densest" only holds under an unstated degree limit (951,835 words is 7.6 MB of lookahead). Second, 14,870 is extraordinarily low. If the logarithms behave like uniform draws from [0, 2^32), the chance that any of the 1,540 clusters with span ≤ 22 lands at or below 14,870 is about 0.5%. The 4-term polynomial is just as lucky. At span 48 it sits at 5,869, while every span below 48 needs a degree of at least 8.4 million. Chorba's best variant depends on a rare property of this particular generator.

## Finding 4: zlib-ng's thresholds

zlib-ng (Oct 2026 tree) dispatches between three variants by length. I linked its static library on an Apple M3 Pro and checked every function against system zlib. Best-of-15 throughput in GB/s:

| Bytes | braid | Chorba (dispatched) | ARMv8 `crc32` loop | PMULL + EOR3 fold |
|---|---|---|---|---|
| 4,096 | 3.34 | 3.75 | 7.19 | 18.2 |
| 32,768 | 3.68 | **6.10** | 7.22 | 29.2 |
| 32,776 | 3.70 | **4.35** | 7.21 | 29.0 |
| 524,288 | 3.71 | **4.47** | 7.24 | 33.5 |
| 524,352 | 3.71 | **6.68** | 7.24 | 33.1 |
| 128 MiB | 3.71 | 8.28 | 7.15 | 17.8 |

On large inputs Chorba runs at 2.2× braiding and slightly beats the one-instruction-per-word hardware CRC loop the paper compared against. Carry-less-multiply folding is still 2.1–7.5× faster. Per-byte cost isn't monotonic in length: adding 8 bytes past 32 KiB costs 29% of throughput, and adding 64 bytes past 512 KiB gains 49%. Calling each variant directly shows the cut-offs are misplaced:

| Bytes | small | 32 KiB variant | 118,960 variant |
|---|---|---|---|
| 8,200 | 4.07 | 3.43 (braid: 3.63) | — |
| 12,288 | 4.22 | 4.37 | — |
| 240,000 | 4.47 | — | 5.41 (+21%) |
| 400,000 | 4.48 | — | 6.39 (+43%) |

The medium variant zeroes a 32 KiB stack buffer on every call. At 8,200 bytes that makes it slower than braiding, so its lower bound belongs nearer 12 KiB. The large variant would be 21–51% faster than the small one between 238 KB and 512 KiB. But you can't simply lower its threshold. Its doc comment says it requires "118960 + 512 bytes", yet it returned the wrong CRC for all 14,816 lengths I tested from 119,472 to 237,992 bytes. It's correct from 238,000 = (14,880 + 14,870) × 8 bytes onward, because the warm-up passes write that far ahead. The 512 KiB cut-off hides this today, but retuning to the documented minimum would produce silently wrong checksums. One caveat: an M3 never runs the generic path in production. The targets that do (CPUs without CRC or carry-less-multiply instructions, WebAssembly, RISC-V without Zbc) need their own sweep, though the correctness boundary is the same on any CPU.

## Takeaways

Chorba's fast polynomials are exactly CRC-32's low-weight codewords, so Koopman's Hamming-distance tables give their degrees for free. Check each published polynomial's bit order before porting it, and don't expect one as dense for other generators: the flagship is a roughly 0.5% outlier. In zlib-ng the cliffs at 32 KiB and 512 KiB are real, and the large variant's documented minimum length needs to double before anyone moves its threshold.
