---
title: "Fitting 192 Bits of Bounds Into 128: CHERI Concentrate and the 0.39% Tax It Charges Your Allocator"
date: 2026-08-19
tags: ["cheri", "memory-safety", "hardware", "risc-v", "systems"]
excerpt: "A CHERI capability needs a base, a top, and an address, but only gets 128 bits. I reimplemented the CHERI Concentrate encoder from the ISAv9 spec, derived the exact worst-case padding a malloc pays (1/256), and found where the ratifying RISC-V spec quietly moved a constant that changes how far out-of-bounds your pointers may legally roam."
---

A CHERI capability is a pointer that carries its own bounds. On a 64-bit machine that means an address, a base, and a top: 192 bits of arithmetic state, plus permissions, plus an object type, plus a validity tag. The shipping format is 128 bits and one out-of-band tag bit.

That compression leaks upward: into your allocator's alignment rules, into how much slop a `CSetBounds` on a struct field silently leaves covering its neighbour, and into whether `p - 257` keeps its tag. As of 2026-08-10 the RISC-V CHERI specification hit v0.9.9 and landed in the RISC-V ISA release a week later, so these edges are becoming a ratified ABI rather than a research artifact. I reimplemented the encoder from the normative spec and measured them.

## The encoding

CHERI Concentrate (Woodruff et al., IEEE ToC 2019) stores bounds as a floating-point-style pair relative to the address. For the 128-bit format the mantissa width is `MW = 14`. Both `B` (base) and `T` (top) are 14-bit mantissas substituted into the address at bit position `E`:

```
p'16 | f | otype'18 | IE | T[11:3] | TE'3 | B[13:3] | BE'3     +     a'64
```

Note the accounting: `T` is 14 bits wide but only 9 of them are stored. When `IE = 1` the low 3 bits of `T` and `B` are stolen to hold the 6-bit exponent, and the top two bits of `T` are not stored at all — they are *reconstituted* from the identity `T = B + L`:

```python
def _derive_top_bits(B, T_low, IE):
    """T[13:12] = B[13:12] + Lcarry_out + Lmsb."""
    if IE == 0:
        carry = 1 if (T_low & 0xFFF) < (B & 0xFFF) else 0
        lmsb = 0
    else:
        carry = 1 if ((T_low >> 3) & 0x1FF) < ((B >> 3) & 0x1FF) else 0
        lmsb = 1
    return (((B >> 12) + carry + lmsb) & 3) << 12
```

`Lmsb` is free because `E` is *chosen* so the most significant set bit of the length lands exactly on `T[12]`. `Lcarry_out` is free because the top is always above the base, so the carry is implied by a magnitude comparison on the stored low bits. Two bits recovered from invariants.

The encoder side:

```python
def set_bounds(base, length):
    t_req = base + length
    E = (length >> 13).bit_length()          # 52 - CLZ(l[64:13])
    IE = 0 if (E == 0 and ((length >> 12) & 1) == 0) else 1
    if IE == 0:                              # < 4 KiB: byte-exact, no exponent
        B = base & MASK14
        T_low = t_req & 0xFFF
        return 0, 0, B, T_low | _derive_top_bits(B, T_low, 0)
    for _ in range(2):                       # at most one E bump
        gran = 1 << (E + 3)
        b_al = base & ~(gran - 1)            # round base down
        t_al = (t_req + gran - 1) & ~(gran - 1)   # round top up
        if (t_al - b_al) >= (1 << (E + 13)): # rounding carried into L's msb
            E += 1
            continue
        B, T_low = (b_al >> E) & MASK14, (t_al >> E) & 0xFFF
        return E, 1, B, T_low | _derive_top_bits(B, T_low, 1)
```

That `E += 1` retry is the subtle part. My first version masked `T` to 9 bits before adding the round-up increment, so a carry out of the length's MSB went undetected: 375 of 300,000 random requests decoded to bounds *narrower* than requested, which in a real core is a silent memory-safety hole rather than a bug. Computing the aligned base and top explicitly and bumping `E` when `t_al - b_al` reaches `2^(E+13)` fixes it. After the fix, 0 containment violations in 300,000 random `(base, length)` pairs, and an assertion that the inferred `T[13:12]` equals the true top bits holds throughout.

## The alignment cliff

Below 4 KiB, bounds are byte-exact: `IE = 0`, no exponent, every base and length representable. At exactly 4096 the exponent turns on and granularity jumps discontinuously from 1 byte to 8. Measured by searching for the smallest alignment that makes a length exactly representable at arbitrary bases:

| length | required alignment | E | granule 2^(E+3) |
|---|---|---|---|
| 4095 | 1 | 0 | — (IE=0) |
| 4096 | 8 | 0 | 8 |
| 4097 | never exact | 0 | 8 |
| 8192 | 16 | 1 | 16 |
| 65536 | 128 | 4 | 128 |
| 1048576 | 2048 | 8 | 2048 |
| 2^30 + 8 | never exact | 18 | 2097152 |

"Never exact" is not an anomaly, it is the rule restated: a length that is not a multiple of `2^(E+3)` cannot be represented precisely at *any* base. A 1 GiB + 4 KiB `mmap` is not a rounding hazard, it is unrepresentable, and CheriBSD handles it by rounding the mapping up and inserting guard pages that fault on access.

## The padding ceiling is 1/256

How much memory does an allocator lose to this? Bound it analytically: padding is at most two granules, `2·2^(E+3) = 2^(E+4)`, while the length that selected that `E` is at least `2^(E+12)`. Ratio: `2^(E+4)/2^(E+12) = 1/256 = 0.3906%`. When the `E += 1` retry fires the granule doubles, but a retry only happens when the length is already near the top of its exponent range (`L ≥ 2^(E+13)`), so the ratio is unchanged. The ceiling holds in both cases.

Measured against the real encoder over 100,000 requests with lengths from 4 KiB to 1 TiB and arbitrary bases: worst observed ratio **0.3856%**, mean **0.1356%**, with the `E` bump firing on 277 requests. The derived ceiling is tight and never crossed. So CHERI's bounds-compression memory overhead is under 0.4% worst case, about 0.14% in expectation, and paid only by allocations over 4 KiB.

Software should not hard-code any of this, since Morello and 32-bit CHERI-RISC-V use different constants. The C API exposes the query instructions:

```c
size_t required_alignment(size_t len) {
    return ~cheri_representable_alignment_mask(len) + 1;
}
void *allocate_next(struct Buffer *buf, size_t len) {
    char *result = buf->data + buf->allocated;
    result = __builtin_align_up(result, required_alignment(len));
    size_t rounded_len = cheri_representable_length(len);
    buf->allocated = (result + rounded_len) - (char *)buf->data;
    return cheri_bounds_set_exact(result, rounded_len);
}
```

## What the imprecision actually costs you, in security

`CSetBounds` rounds *outward*. That is the right default for a heap allocator that padded the allocation, and the wrong default for subobject bounds. Narrowing a capability to a field inside a large object yields bounds that cover the field plus the rounding slop, and that slop is adjacent live data. Over 20,000 random subobject requests on objects up to 64 MiB, the worst case I measured was **246,741 bytes of over-approximation on a 66,993,195-byte object** — 0.368% of the object, exposed on both sides of a field you thought you had fenced off. The mitigation is `CSetBoundsExact`, which clears the tag instead of over-approximating, and then dealing with the failure.

## The one constant the two specs disagree on

Compressed bounds are decoded relative to the current address, so if the address wanders too far the bounds decode differently and the hardware clears the tag. This must tolerate real C. The CHERI Concentrate paper's motivating case is zlib's `inftrees.c`, which does `base = lbase; base -= 257;` on a 62-byte `unsigned short` array — 514 bytes below the object's base — then only ever dereferences it back inside. Both specs handle it: 5000/5000 random placements still decode.

The tolerance comes from a pivot `R` marking the bottom of the representable space. ISAv9 puts it at `R = B[13:11] − 1`, i.e. `2^11` below the base, one eighth of the representable space `s = 2^(E+14)`. RISC-V CHERI v0.9.9 puts it at `R = B − 2^(MW−2)`, i.e. `2^12`, one quarter. Same mantissa width, same correction-factor truth table, one constant moved. I implemented both decoders and measured:

| object size | spec | min room below base | min room above top |
|---|---|---|---|
| 16 B – 4 KiB | ISAv9 | 2,057 B | 8,228 B |
| 16 B – 4 KiB | RV v0.9.9 | 4,096 B | 8,195 B |
| 1 – 16 MiB | ISAv9 | 553,943 B | 1,182,077 B |
| 1 – 16 MiB | RV v0.9.9 | 1,048,639 B | 1,084,406 B |

Across 300,000 in-bounds addresses the two decoders never disagree on a single bound — as they must not, since they are the same encoding. The change is invisible to correctness and visible only in the out-of-bounds tail: RISC-V doubles the guaranteed backwards headroom from `s/8` to `s/4`, funded out of the forwards headroom. For a small object that is 2,048 bytes before the base becoming 4,096.

No idiom I tested breaks under either. But it means "how far below an object may a pointer legally roam" is a per-architecture constant that just changed in the spec heading for ratification, and code that computes negative offsets and expects the tag to survive is depending on it. Bounds compression is not an implementation detail. It is an ABI.
