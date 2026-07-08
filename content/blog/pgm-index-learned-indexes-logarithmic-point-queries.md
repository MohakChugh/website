---
title: "PGM-Index: How Piecewise Linear Models Replace B-Trees with O(log log n) Lookups"
date: 2026-07-08
tags: ["learned-indexes", "data-structures", "databases", "performance"]
excerpt: "The Piecewise Geometric Model index uses linear regression segments to predict key positions, achieving O(log log n) point queries with orders-of-magnitude less space than B-trees. Here's the theory, the recursive structure, and why production systems are starting to care."
---

B-trees have been the default index structure for sorted data since 1970. They work, they're cache-friendly with high fanout, and they give O(log_B n) lookups where B is the page size. But they treat every dataset identically: a uniformly distributed key set gets the same structure as a heavily skewed one. **Learned indexes** exploit the observation that a sorted array's cumulative distribution function (CDF) is itself an index — if you can approximate the CDF with a model, you can predict a key's position directly.

The PGM-index (Piecewise Geometric Model), introduced by Ferragina and Vinciguerra in 2020 and refined through 2024, is the first learned index to achieve **optimal space-time tradeoffs** with worst-case guarantees. Unlike the original Learned Index (Kraska et al. 2018) which used neural networks and offered no worst-case bounds, the PGM-index uses piecewise linear approximation with provable error guarantees, recursive structure for O(log log n) height, and dynamic variants supporting insertions and deletions.

## The Core Idea: CDF as Index

Given n sorted keys, consider the rank function `rank(x) = |{k ∈ S : k ≤ x}|`. This is the CDF scaled by n. If we could evaluate `rank(x)` exactly, lookups would be O(1): just access `array[rank(x)]`.

We can't evaluate it exactly without storing all keys, but we can *approximate* it. If our approximation has maximum error ε, then given a query key x, we compute `pos = model(x)` and binary search within `[pos - ε, pos + ε]`. The lookup cost is O(log ε) — independent of n.

```
Sorted Array:  [3, 7, 12, 15, 23, 31, 42, 55, 67, 89]
Positions:      0  1   2   3   4   5   6   7   8   9

CDF approximation: f(x) ≈ 0.11x - 0.2
Query: x = 42
  predicted position = f(42) = 4.42 → round to 4
  actual position = 6
  error = 2, so binary search [4, 8] → found at 6
```

## Piecewise Linear Approximation with Optimal Segments

The key insight: approximate the CDF with the **minimum number of linear segments** such that each segment has error at most ε. This is the optimal piecewise linear approximation (PLA) problem.

Ferragina and Vinciguerra showed this can be solved in O(n) time using a streaming algorithm. The algorithm maintains a "cone" of valid slopes: for each new point, it intersects the cone with the constraints imposed by the ε-error bound. When the cone becomes empty, a new segment must start.

```python
def optimal_pla(keys, epsilon):
    """Compute minimum segments with error <= epsilon. O(n) time."""
    segments = []
    start = 0
    slope_lo, slope_hi = -float('inf'), float('inf')
    
    for i in range(1, len(keys)):
        # New point must satisfy: |start_pos + slope * (keys[i] - keys[start]) - i| <= epsilon
        new_slope_lo = (i - epsilon - 0) / (keys[i] - keys[start])  # simplified
        new_slope_hi = (i + epsilon - 0) / (keys[i] - keys[start])
        
        slope_lo = max(slope_lo, new_slope_lo)
        slope_hi = min(slope_hi, new_slope_hi)
        
        if slope_lo > slope_hi:
            # Cone is empty; emit segment and restart
            segments.append((keys[start], (slope_lo + slope_hi) / 2))
            start = i
            slope_lo, slope_hi = -float('inf'), float('inf')
    
    segments.append((keys[start], (slope_lo + slope_hi) / 2))
    return segments
```

The number of segments produced is provably **optimal**: no piecewise linear function with fewer segments can achieve error ≤ ε on the same data. For uniformly distributed data, you get O(n/ε) segments. For real datasets with structure, far fewer.

## The Recursive Structure: O(log log n) Height

Here's where PGM-index gets clever. Given m segments at level 0, we need a way to find which segment covers a query key. Naively, binary search over segment start-keys costs O(log m). But the segment start-keys are themselves sorted — so we can build *another* PGM on top of them.

```
Level 2:  [1 segment, ε₂=4]           ← 1 model predicts position in level 1
Level 1:  [~√m segments, ε₁=4]        ← models predict position in level 0
Level 0:  [m segments, ε₀=chosen]      ← models predict position in data
Data:     [n sorted keys]
```

Each level reduces the number of segments by roughly a square root (because the optimal number of segments for m keys with error ε is O(m/ε), and with constant ε this recursive structure converges in O(log log n) levels). The total height of the index is **Θ(log log n)** — far shallower than a B-tree's Θ(log n).

The lookup procedure is elegant:

```cpp
template<typename K>
size_t PGMIndex<K>::search(K key) const {
    // Start from the root (topmost level)
    size_t approx_pos = root.predict(key);
    
    // Walk down levels, each time refining the position
    for (int level = height - 1; level >= 0; --level) {
        size_t lo = approx_pos > epsilon ? approx_pos - epsilon : 0;
        size_t hi = min(approx_pos + epsilon, levels[level].size() - 1);
        
        // Binary search for the correct segment in [lo, hi]
        auto seg = binary_search(levels[level], lo, hi, key);
        approx_pos = seg.predict(key);
    }
    
    // Final binary search in the data array within [approx_pos ± ε₀]
    return binary_search(data, approx_pos - epsilon_0, approx_pos + epsilon_0, key);
}
```

Each level does O(log ε) work (binary search within the error bound). With O(log log n) levels and constant ε, total lookup cost is **O(log log n)** — matching the theoretical lower bound for comparison-based predecessor search with linear space.

## Space Efficiency

Each segment stores two values: a slope and an intercept (or equivalently, a starting key and slope). That's 16 bytes per segment. Compare to B-trees where each internal node stores B keys and B+1 pointers.

For a dataset of 200M keys (1.6 GB of 64-bit integers):
- B-tree: ~800 MB internal nodes (fanout 128)
- PGM-index (ε=64): ~1.2 MB total index size
- PGM-index (ε=256): ~300 KB total index size

That's a **600x space reduction** while maintaining comparable or better lookup latency on modern hardware. The entire index fits in L2 cache.

## The Dynamic PGM-Index

Real systems need insertions and deletions. The Dynamic PGM-index (2020, updated 2024) adapts the structure using a technique inspired by logarithmic method merging:

1. Maintain a small buffer for recent insertions (size O(ε log n))
2. When the buffer fills, merge it into the main structure
3. Use a hierarchy of "levels" similar to LSM-trees, where level i holds up to 2^i elements
4. Each level has its own PGM-index
5. Lookups check all levels (O(log n) levels, each with O(log log n_i) cost)

The amortized insertion cost is O(log²n / ε) and lookup cost becomes O(log n · log log n) in the dynamic case — still competitive with B-trees while using far less space.

## Benchmarks: When PGM Wins

From the SOSD benchmark (2024 updated results) on real datasets:

| Dataset | B-tree (ns) | PGM ε=32 (ns) | PGM ε=256 (ns) | PGM size |
|---------|-------------|----------------|-----------------|----------|
| fb_200M (Facebook user IDs) | 312 | 198 | 287 | 0.8 MB |
| wiki_200M (Wikipedia timestamps) | 298 | 156 | 201 | 0.4 MB |
| osm_200M (OpenStreetMap cell IDs) | 334 | 445 | 389 | 12 MB |
| uniform_200M | 285 | 142 | 168 | 0.3 MB |

PGM excels on data with structure (monotonic trends, clusters, low entropy). It struggles on adversarial distributions where the CDF has many inflection points, requiring more segments. The `osm` dataset shows this: geospatial cell IDs have complex distribution patterns that resist linear approximation.

## Integration: LevelDB + PGM

Google's LevelDB uses Bloom filters to skip SSTables that don't contain a key, and binary search within the SSTable's index block for positioning. Both can be replaced:

```cpp
// Traditional SSTable lookup:
// 1. Check Bloom filter (false positive rate p) — O(k) hash computations
// 2. Binary search index block — O(log(n/block_size))
// 3. Binary search within data block — O(log block_size)

// PGM-enhanced SSTable lookup:
// 1. PGM predicts position — O(log log n)
// 2. Binary search within [pos-ε, pos+ε] — O(log ε)
// No Bloom filter needed: PGM returns "not found" if key not in range
```

The Bourbon system (Harvard DASlab, 2024) demonstrated that replacing LevelDB's index blocks with learned models reduces read amplification by 30-50% on production-like workloads, with the index consuming 8x less memory.

## Practical Considerations

**Build time:** The PGM-index construction is O(n) — a single pass over sorted data. Rebuilding after bulk loads is cheaper than maintaining a B-tree through sequential insertions.

**Concurrency:** The static PGM-index is naturally read-concurrent (immutable after construction). The dynamic variant needs careful synchronization at buffer and level boundaries, similar to LSM compaction locking.

**SIMD acceleration:** The final binary search within the ε-bounded range is short enough (typically 64-512 elements) to benefit from SIMD linear scan, eliminating branch mispredictions entirely.

**Compression interaction:** Because PGM predicts positions rather than storing keys, it composes well with key compression (prefix truncation, delta encoding). The model operates on the logical key space; physical layout is independent.

## What's Next

The 2024-2025 wave of work focuses on multi-dimensional learned indexes (Flood, Tsunami), updatable learned indexes with MVCC (ALEX, LIPP), and GPU-resident learned indexes for analytical workloads. The PGM-index remains the cleanest theoretical result: optimal segments, provable bounds, and a recursive structure that's both beautiful and practical. For read-heavy workloads over semi-static sorted data — time-series databases, log archives, immutable analytics tables — it's already the right choice over traditional B-trees.
