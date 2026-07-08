---
title: "Swiss Tables: How SIMD Rewrote the Rules of Hash Map Design"
date: "2026-07-08"
tags: ["data-structures", "performance", "simd", "systems", "cpu-architecture"]
excerpt: "Flat hash maps based on Swiss Table design now dominate C++, Rust, Go, and Zig standard libraries. The key insight is not a better hash function or collision strategy, it is using SIMD to probe 16 slots in a single instruction, turning the control byte array into a hardware-accelerated Bloom filter."
---

The most-used data structure in systems programming got a quiet revolution. Between 2017 and 2024, nearly every major language's default hash map was replaced by a variant of the same design: Google's **Swiss Table** (open-sourced as `absl::flat_hash_map`). Rust's `HashMap` switched to `hashbrown` (a Swiss Table port) in 2019. Go rewrote its map internals around Swiss Table principles in Go 1.24 (2025). Zig's `std.HashMap` uses the same metadata layout. F14 at Meta is a cousin with the same SIMD-probing DNA.

Why did one design win everywhere? Because it exploits a hardware capability, SIMD comparison, that older hash tables couldn't leverage, and in doing so collapses the gap between theoretical O(1) and actual wall-clock performance.

## The problem with traditional open addressing

Classic open-addressing tables (Robin Hood, linear probing, quadratic probing) share a structural problem: to determine if a slot matches your key, you must **load the key itself** from memory. For a table of 64-byte structs, that means touching a full cache line per probe. At high load factors (70%+), you probe 2-3 slots on average, which means 2-3 cache line loads before finding your entry.

Chaining (separate lists) is worse: each node is a pointer chase, and pointer chases are the single most expensive operation on modern CPUs due to dependent loads defeating prefetching.

The core question Swiss Tables answer: *can we determine which slots are worth examining without loading the keys?*

## The metadata array: a parallel Bloom filter

A Swiss Table splits storage into two arrays:

1. **Control bytes** (`ctrl[]`): one byte per slot, containing either a 7-bit hash fragment (H2), or a sentinel (`EMPTY = 0x80`, `DELETED = 0xFE`).
2. **Slot array** (`slots[]`): the actual key-value pairs, densely packed.

When looking up a key with hash `h`:

```
group_index = H1(h) % num_groups   // which 16-slot group to start in
h2 = H2(h)                         // top 7 bits of hash, stored in ctrl byte
```

The lookup loads 16 control bytes (one "group") into a 128-bit SIMD register, then performs a single `_mm_cmpeq_epi8` comparing all 16 bytes against `h2` simultaneously. The result is a bitmask of matching positions:

```c
// SSE2 probe - finds all slots whose H2 matches in one instruction
__m128i group = _mm_loadu_si128(ctrl + group_index * 16);
__m128i match = _mm_cmpeq_epi8(group, _mm_set1_epi8(h2));
uint32_t mask = _mm_movemask_epi8(match);

while (mask) {
    int pos = __builtin_ctz(mask);  // lowest set bit
    if (slots[group_index * 16 + pos].key == key)
        return &slots[group_index * 16 + pos];
    mask &= mask - 1;  // clear lowest bit
}
// If EMPTY found in group, key is absent. Otherwise, probe next group.
```

This is the critical insight: **16 slots are filtered using a single SIMD instruction**. Only slots whose 7-bit hash fragment matches require a full key comparison. Since H2 has 128 possible values, the false-positive rate is ~1/128 per occupied slot, meaning on average you compare fewer than 1.12 keys for a successful lookup at 87.5% load factor.

## Why 16 bytes and why SSE2

The group size of 16 is not arbitrary. SSE2 registers are 128 bits (16 bytes), and `_mm_cmpeq_epi8` + `_mm_movemask_epi8` is the cheapest parallel comparison available on every x86 CPU made since 2001. On ARM (NEON), the equivalent uses `vceqq_u8` with a slightly different bitmask extraction. The design deliberately targets the **lowest common denominator** of SIMD, not AVX2 or AVX-512, ensuring the fast path works everywhere without runtime dispatch.

Each group of 16 control bytes fits in exactly one cache line fetch (alongside neighboring groups in practice), so the entire probe sequence for a successful lookup at reasonable load factors is: **one cache line for metadata, one cache line for the matching slot**. Compare this to Robin Hood hashing, which needs 2-3 cache lines for keys alone.

## The load factor sweet spot

Traditional hash tables run at 50-70% load to keep probe chains short. Swiss Tables run comfortably at **87.5%** (7/8 slots filled) because the SIMD probe makes chain length almost irrelevant, the cost is dominated by whether you hit in the first group or overflow to the next.

At 87.5% load, the expected number of groups probed is approximately 1.56 for a successful lookup and 2.0 for a failed lookup. Each group probe costs one SIMD compare (one cycle throughput, three cycles latency) plus the cache line load for the metadata (which is often already in L1 for hot tables since the entire ctrl array is compact).

The memory savings from a higher load factor compound: a table with 1M entries at 87.5% load uses 1.14M slots. At 50% load, the same table needs 2M slots, nearly doubling memory footprint and halving cache efficiency.

## Deletion without tombstone graveyards

Open-addressing tables traditionally suffer from tombstone accumulation. Swiss Tables use a clever trick: the `DELETED` sentinel (`0xFE`) participates in the SIMD probe but is distinguishable from `EMPTY` (`0x80`). The key insight is in how empty detection works:

```c
// Check for EMPTY slots using the high bit pattern
__m128i empty = _mm_cmpeq_epi8(
    _mm_and_si128(group, _mm_set1_epi8(0x80)),
    _mm_set1_epi8(0x80)
);
```

Both `EMPTY` and `DELETED` have their high bit set (values >= 0x80), while valid H2 values are 0-127 (7-bit hash). This means "stop probing" checks are cheap. During resize, all `DELETED` markers are eliminated, preventing the degradation that plagues simpler schemes.

The rehash threshold is separate from the load factor: Swiss Tables rehash when the **combined** occupied + deleted count exceeds 87.5%, not when occupied alone does. This bounds the worst-case probe length even under adversarial insert/delete workloads.

## Practical impact: benchmarks that matter

Raw throughput numbers vary by workload, but the directional results are consistent across independent benchmarks:

| Scenario | `std::unordered_map` | `absl::flat_hash_map` | Speedup |
|----------|---------------------|----------------------|---------|
| Random lookup (8B key, 8B value) | 95 ns | 22 ns | 4.3x |
| Insert 1M integers | 142 ns/op | 48 ns/op | 3.0x |
| Iteration over full table | 8.2 ns/elem | 2.1 ns/elem | 3.9x |
| Memory per entry (8+8B KV) | ~72 bytes | ~18.3 bytes | 3.9x less |

The iteration speedup deserves emphasis: because slots are stored contiguously (no pointer chasing, no node allocation), iterating a Swiss Table is essentially a sequential memory scan, limited only by prefetch bandwidth. This makes operations like "serialize all entries" dramatically faster.

## The Rust story: hashbrown and predictable performance

Rust adopted `hashbrown` as its standard `HashMap` in 2019 (stabilized in Rust 1.36). The implementation adds one refinement: **SipHash-1-3** as the default hasher for DoS resistance, with the option to swap in `ahash` (an AES-NI-based hasher) for performance-critical paths where HashDoS is not a concern.

The `hashbrown` implementation also uses a **growth factor of 2** with an "exponential growth then linear" pattern for very large tables, and employs a SIMD-aware allocation strategy that ensures control byte arrays are always 16-byte aligned without over-allocating.

## When Swiss Tables lose

No design wins everywhere. Swiss Tables are suboptimal for:

- **Very large values (>256B)**: The flat layout means unused slots waste proportionally more memory. Separate allocation (like `absl::node_hash_map`) wins here.
- **Stable references**: Moving entries on resize invalidates pointers. If you hold references into the map, you need a node-based variant.
- **Extremely small tables (<16 entries)**: The SIMD machinery has a fixed overhead that a simple linear scan over 4-8 entries can beat.
- **High collision rates with expensive equality**: If your keys are 1KB strings that frequently share H2 values, the false-positive cost dominates.

## The design principle

Swiss Tables succeed because they are designed **for the hardware**, not just for the algorithmic model. The traditional analysis of hash tables counts comparisons and assumes memory access is uniform. The Swiss Table design counts **cache lines and SIMD instructions**, which maps directly to wall-clock time on real CPUs.

This is the broader lesson: any data structure designed in the 1970s-90s is worth revisiting with the question, "what if we assumed 128-bit SIMD, 64-byte cache lines, and a 200:1 ratio between memory latency and ALU throughput?" The answer is often a radically different design that happens to have the same O(1) complexity but 4-5x better constant factors.

Swiss Tables are not exotic. They are the hash map your code probably already uses. Understanding their internals helps you make better decisions about load factors, key design, and when to reach for alternatives.
