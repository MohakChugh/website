---
title: "Roaring Bitmaps: Compressed Set Operations in Constant Time Per Container"
date: 2026-07-08
tags: ["data-structures", "databases", "indexing", "performance", "simd"]
excerpt: "How Roaring Bitmaps achieve intersection, union, and cardinality on billion-element sets in microseconds by partitioning integers into typed containers, each optimized for its density regime, and accelerated with SIMD vectorization."
---

# Roaring Bitmaps: Compressed Set Operations in Constant Time Per Container

Every analytics engine, search index, and columnar store eventually faces the same problem: given two sets of row IDs (potentially billions of elements each), compute their intersection, union, or difference faster than the query deadline allows. Sorted arrays are compact but intersection is O(n+m). Hash sets give O(1) lookup but consume 40+ bytes per element. Traditional bitmaps offer bitwise AND/OR in cache-friendly sequential scans but explode in memory for sparse, high-cardinality universes.

Roaring Bitmaps, introduced by Lemire et al. (2016) and continuously refined through 2024, solve this with a partitioned hybrid structure: integers are grouped into 16-bit chunks, and each chunk independently selects the most efficient container type for its density. The result is a data structure that adapts to local density variation within a single bitmap, achieves compression ratios competitive with run-length encoding, and executes set operations at speeds approaching raw memory bandwidth via SIMD vectorization.

## Architecture: The Two-Level Partition

A Roaring Bitmap stores 32-bit unsigned integers. Each integer `x` is decomposed into a 16-bit **high key** (`x >> 16`) and a 16-bit **low value** (`x & 0xFFFF`). The high keys form a sorted top-level index (typically stored as a sorted array for binary search), and each high key maps to exactly one **container** holding the corresponding low values.

```
Integer: 0x0003_A7F2
         ├─── high key: 0x0003  (chunk index)
         └─── low value: 0xA7F2  (offset within chunk)

Top-level index:
  [0x0000] → Container_0
  [0x0003] → Container_3
  [0x0041] → Container_65
  ...
```

This partition bounds the universe of each container to 65,536 elements (2^16), making it feasible to switch representation strategies per-container without global coordination.

## Three Container Types

Each container independently selects one of three representations based on cardinality:

### Array Container

For sparse chunks (cardinality ≤ 4096), store low values as a sorted `uint16_t` array. Memory usage is exactly `2 * cardinality` bytes. Intersection between two array containers uses a galloping merge (binary search within the longer array guided by the shorter), achieving sub-linear performance when cardinalities differ significantly.

```c
// Galloping intersection: O(min(a,b) * log(max(a,b)))
uint16_t* intersect_gallop(uint16_t* A, int lenA,
                           uint16_t* B, int lenB,
                           uint16_t* out) {
    if (lenA > lenB) { swap(&A, &B); swap(&lenA, &lenB); }
    int k = 0;
    for (int i = 0; i < lenA; i++) {
        // Binary search for A[i] in B[k..lenB)
        int lo = k, hi = lenB;
        while (lo < hi) {
            int mid = (lo + hi) >> 1;
            if (B[mid] < A[i]) lo = mid + 1;
            else hi = mid;
        }
        if (lo < lenB && B[lo] == A[i]) {
            *out++ = A[i];
            k = lo + 1;
        }
    }
    return out;
}
```

### Bitmap Container

For dense chunks (cardinality > 4096), store a fixed 8 KB bitmap (1024 × 64-bit words). The crossover at 4096 is exact: an array container with 4096 elements uses `4096 * 2 = 8192` bytes, matching the bitmap's fixed cost. Above this threshold, the bitmap is always more compact.

Set operations on bitmap containers reduce to word-parallel bitwise operations:

```c
// Union: 1024 OR operations, ~128 ns on modern hardware
void bitmap_union(uint64_t* a, const uint64_t* b) {
    for (int i = 0; i < 1024; i++)
        a[i] |= b[i];
}

// Cardinality via popcount
int bitmap_card(const uint64_t* bm) {
    int count = 0;
    for (int i = 0; i < 1024; i++)
        count += __builtin_popcountll(bm[i]);
    return count;
}
```

### Run Container

For clustered data (consecutive sequences), a run-length encoded container stores sorted `(start, length)` pairs as packed `uint16_t` tuples. A container holding the range [0, 65535] compresses to just 4 bytes (one run), versus 8 KB for a bitmap or 128 KB for an array.

Run containers are particularly effective for time-series data, range predicates, and columnar scans where selected row IDs form long consecutive stretches.

## SIMD Acceleration

Modern Roaring implementations exploit SIMD at multiple levels:

**Bitmap operations**: AVX-512 processes 512 bits (8 words) per instruction, reducing a bitmap union to 128 operations instead of 1024. With `VPOPCNTQ` (available since Ice Lake), cardinality computation processes 8 words per cycle.

**Array intersection**: SSE4.2/AVX2 shuffles enable comparing 8 elements simultaneously. The key insight is that sorted `uint16_t` arrays fit naturally into 128-bit registers (8 elements each), and a merge network can produce intersection results without scalar branching:

```c
// SSE4.1 sorted array intersection (simplified)
__m128i intersect_sse(uint16_t* A, uint16_t* B) {
    __m128i va = _mm_loadu_si128((__m128i*)A);
    __m128i vb = _mm_loadu_si128((__m128i*)B);
    // Compare all pairs: 8x8 = 64 comparisons in one instruction
    // using shuffle + cmpeq pattern
    __m128i cmp = _mm_cmpestrm(va, 8, vb, 8,
        _SIDD_UWORD_OPS | _SIDD_CMP_EQUAL_ANY | _SIDD_BIT_MASK);
    return cmp;
}
```

**Top-level search**: The sorted high-key array supports SIMD binary search, comparing 8 or 16 keys per iteration instead of one.

Benchmarks on Ice Lake processors show 2-4x throughput improvement from AVX-512 bitmap operations and 3-6x from vectorized array intersections compared to scalar code.

## Cross-Container Operations

The critical complexity in Roaring lies in operations between containers of *different* types. An intersection of an array container against a bitmap container doesn't require converting either: simply iterate the array elements and test each bit in the bitmap. This runs in O(|array|) time with excellent branch prediction (bitmap lookups are unconditional).

The full operation matrix:

| Op \ Types     | Array × Array | Array × Bitmap | Bitmap × Bitmap | Run × Any    |
|---------------|---------------|----------------|-----------------|--------------|
| **Union**     | Merge → Array/Bitmap | Set bits → Bitmap | OR → Bitmap | Decompose + merge |
| **Intersect** | Galloping merge | Bit-test loop | AND → Bitmap/Array | Range clip |
| **Difference**| Scan + skip   | Bit-clear loop | ANDNOT → Bitmap | Range subtract |

After every operation, the result container checks whether it should convert: a bitmap with cardinality below 4096 converts to an array, and an array exceeding 4096 converts to a bitmap. This lazy conversion ensures optimal representation without requiring global analysis.

## Performance Characteristics

On a 2024 benchmark (Lemire's CRoaring library, AMD Zen 4):

- **Union of two bitmaps** (1M elements each, 50% overlap): 0.8 µs
- **Intersection** (same setup): 0.6 µs  
- **Cardinality**: 0.2 µs per bitmap container (with VPOPCNTQ)
- **Memory**: 2-10x compression vs. uncompressed bitsets for typical workloads
- **Serialization**: Zero-copy mmap-friendly layout enables memory-mapped access without deserialization

For comparison, a sorted vector intersection via `std::set_intersection` on the same 1M-element sets takes 12-15 ms, three orders of magnitude slower.

## Adoption and Impact

Roaring Bitmaps have become the de facto standard for compressed bitmap indexing:

- **Apache Lucene/Elasticsearch**: Posting list intersections during query evaluation
- **Apache Druid**: Bitmap indexes on dimension columns for sub-second OLAP queries
- **Apache Spark**: Optimized column pruning in Parquet reads
- **Redis (RedisRoaring)**: Server-side set operations at millions of ops/second
- **Pilosa/FeatureBase**: Entire query engine built around Roaring operations
- **ClickHouse**: Bitmap aggregate functions for user analytics

The key insight that makes Roaring successful isn't any single container type (arrays, bitmaps, and RLE are all decades old) but the *partitioned adaptive* approach: by bounding containers to 2^16 elements, the crossover points between representations become exact and predictable. There's no tuning parameter, no density estimation, no global analysis required. Each 65K-element chunk independently picks the best encoding, and the math guarantees it's optimal within that partition.

## Beyond 32 Bits: Roaring64

For 64-bit integers (common in distributed systems using UUIDs or composite keys), Roaring64 extends the two-level hierarchy to three levels: the top 32 bits index into a tree (ART or sorted array), and each leaf is a standard 32-bit Roaring Bitmap. This preserves all container-level optimizations while supporting the full 64-bit universe without materializing 2^48 empty high-key slots.

The cost is one additional indirection per operation, but since the inner structure remains unchanged, SIMD-accelerated container operations dominate runtime for any non-trivial dataset.

## When Not to Use Roaring

Roaring is not universally optimal. For extremely dense bitmaps (>90% fill rate) where the universe is bounded and known, a plain bitset is simpler and equally fast. For tiny sets (<100 elements), the two-level indirection adds overhead compared to a sorted array with linear scan. And for sets where elements cluster within a single 65K chunk, a single RLE container offers better compression than Roaring's partitioning overhead.

The sweet spot is medium-density, high-cardinality sets with mixed clustering patterns, which describes the vast majority of real-world indexing workloads: posting lists, bitmap indexes, column filter masks, and set-valued attributes.
