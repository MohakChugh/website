---
title: "Ribbon Filters: How RocksDB Achieved Near-Optimal Space with Gaussian Elimination"
date: 2026-07-08
tags: ["data-structures", "databases", "probabilistic", "storage-engines", "performance"]
excerpt: "Inside Ribbon Filters, the Gaussian elimination based probabilistic data structure that replaced Bloom filters in RocksDB, achieving information-theoretic space optimality at the cost of a linear algebra construction step."
---

# Ribbon Filters: How RocksDB Achieved Near-Optimal Space with Gaussian Elimination

Bloom filters have been the default probabilistic membership structure for four decades. Every LSM-tree storage engine, network router, and distributed cache uses them to answer "is this key possibly in this set?" without touching disk. But Bloom filters waste space: at a 1% false positive rate (FPR), they consume ~10 bits per key, while the information-theoretic lower bound is -log₂(0.01) ≈ 6.64 bits. That 34% overhead compounds when you store billions of keys across thousands of SSTable files.

Ribbon filters, introduced by Peter Dillinger and Stefan Walzer in 2021 and deployed in production RocksDB since version 6.15, close this gap. They achieve configurable space efficiency approaching the theoretical minimum, using a construction algorithm rooted in solving sparse systems of linear equations over GF(2).

## The Core Insight: Membership as Linear Algebra

A Ribbon filter encodes set membership as a solution to a system of linear equations over GF(2) (the field with elements {0, 1} and XOR as addition). For each key k in the set S:

```
hash_coefficients(k) · solution_vector = fingerprint(k)
```

Each key produces a row of "ribbon width" w coefficients (bits), positioned at a starting column determined by a hash. The solution vector is what gets stored. To query a key, you recompute its coefficient row and fingerprint, then check if the dot product (over GF(2)) matches.

The name "Ribbon" comes from the banded structure of the coefficient matrix. Each row's non-zero entries span at most w consecutive columns, forming a ribbon-like band pattern. This structure enables O(n) construction via banded Gaussian elimination rather than the O(n²) cost of general systems.

## Construction: Banded Gaussian Elimination

Building a Ribbon filter proceeds in three phases:

**Phase 1: Hashing.** For each key kᵢ, compute:
- A starting column position `start(kᵢ) ∈ [0, m-w]` where m is the number of columns (slots)
- A coefficient row: w random bits determining which of the w columns participate
- A fingerprint: r bits that encode the desired result

**Phase 2: Row sorting.** Sort rows by starting position. This produces a nearly lower-triangular banded matrix that Gaussian elimination can process in a single left-to-right pass.

**Phase 3: Elimination and back-substitution.** Process rows from top to bottom. For each row, if the leading coefficient is already "taken" by a previous row, XOR with that row to eliminate. If no pivot is available, the construction fails (bump the table size and retry). After elimination, back-substitute to find the solution vector.

```python
def construct_ribbon(keys, num_slots, ribbon_width, fp_bits):
    # Each slot stores `fp_bits` bits of solution
    solution = [0] * num_slots
    
    # Sort rows by start position for banded elimination
    rows = []
    for key in keys:
        start = hash_start(key, num_slots - ribbon_width + 1)
        coeffs = hash_coefficients(key, ribbon_width)  # w random bits
        fingerprint = hash_fingerprint(key, fp_bits)
        rows.append((start, coeffs, fingerprint))
    
    rows.sort(key=lambda r: r[0])
    
    # Forward elimination (banded, so O(n * w) total)
    pivot_rows = [None] * num_slots
    for (start, coeffs, fp) in rows:
        for j in range(ribbon_width):
            col = start + j
            if coeffs & (1 << j):
                if pivot_rows[col] is None:
                    pivot_rows[col] = (start, coeffs, fp)
                    break
                else:
                    # XOR with existing pivot to eliminate
                    _, p_coeffs, p_fp = pivot_rows[col]
                    coeffs ^= p_coeffs
                    fp ^= p_fp
    
    # Back-substitution to compute solution
    for col in reversed(range(num_slots)):
        if pivot_rows[col] is not None:
            start, coeffs, fp = pivot_rows[col]
            result = fp
            for j in range(ribbon_width):
                c = start + j
                if c != col and (coeffs & (1 << j)):
                    result ^= solution[c]
            solution[col] = result
    
    return solution
```

**Query** is trivially fast: compute the key's start position, coefficients, and expected fingerprint, then XOR the relevant solution slots together and compare:

```python
def query_ribbon(key, solution, num_slots, ribbon_width, fp_bits):
    start = hash_start(key, num_slots - ribbon_width + 1)
    coeffs = hash_coefficients(key, ribbon_width)
    fingerprint = hash_fingerprint(key, fp_bits)
    
    result = 0
    for j in range(ribbon_width):
        if coeffs & (1 << j):
            result ^= solution[start + j]
    
    return result == fingerprint  # True = "probably in set"
```

## Space Efficiency: Approaching the Limit

The false positive rate of a Ribbon filter with r-bit fingerprints is 2⁻ʳ. The space consumed is approximately `m × r` bits total, where m is slightly larger than n (the number of keys) to ensure construction succeeds with high probability.

The overhead ratio `m/n` is controlled by the ribbon width w. With w = 128 (the default in RocksDB), the overhead ratio is approximately 1.002, meaning less than 0.2% wasted slots. The total space per key approaches:

```
bits_per_key ≈ (1 + ε) × r = (1 + ε) × (-log₂(FPR))
```

For a 1% FPR: ~6.65 bits/key versus Bloom's ~10 bits/key. That is a **33% space reduction** with identical false positive guarantees.

| Filter Type | Bits/Key @ 1% FPR | Overhead vs. Optimal | Query Cost |
|---|---|---|---|
| Bloom (k=7) | 9.58 | 44% | 7 memory probes |
| Blocked Bloom | 10.08 | 52% | 1 cache line |
| Cuckoo | 8.0 | 20% | 2 cache lines |
| Xor | 9.84* | 48% | 3 cache lines |
| Ribbon (w=128) | 6.66 | 0.3% | 2 cache lines |

*Xor filters achieve better practical compression with Xor+ and Binary Fuse variants, but Ribbon still dominates on raw space.

## The Tradeoffs: Construction Cost and Dynamism

Ribbon filters are **static**: you cannot insert new keys after construction. This is acceptable for LSM-tree use cases where filters are built once per SSTable during compaction and never modified.

Construction is more expensive than Bloom: O(n × w) with a larger constant due to the elimination pass. In RocksDB benchmarks, Ribbon construction is 1.5-2× slower than Bloom for equivalent FPR. However, construction happens during compaction (a background operation), while queries happen on the read path. The space savings directly reduce memory pressure and improve cache hit rates, which dominate real-world performance.

The ribbon width w controls a three-way tradeoff:
- **Larger w** → lower overhead ratio (more space-efficient), but slower construction and higher construction failure probability
- **Smaller w** → faster construction, but more wasted slots
- w = 64 or w = 128 are practical sweet spots

## Homogeneous Ribbon: The Production Variant

RocksDB deploys a variant called **Homogeneous Ribbon** that simplifies the coefficient generation. Instead of w arbitrary random bits per row, each row uses a coefficient pattern derived from a single hash with a fixed Hamming weight. This enables SIMD-friendly query evaluation and reduces the metadata stored per row.

The key optimization: coefficient generation uses a "bumped" scheme where the raw hash is processed to guarantee at least one set bit in the first few positions, ensuring the matrix is never rank-deficient in practice. This eliminates the need for retries during construction.

```cpp
// Simplified RocksDB Ribbon query (actual production code pattern)
inline bool MayMatch(const Slice& key) {
    uint64_t h = Hash(key);
    uint32_t start = fastrange32(h >> 32, num_starts_);
    uint64_t coeffs = CoeffRow(h);  // Derived from lower hash bits
    
    uint64_t result = 0;
    for (int i = 0; i < kCoeffBits; i++) {
        if (coeffs & (uint64_t{1} << i)) {
            result ^= solution_[start + i];
        }
    }
    return (result & fp_mask_) == (h & fp_mask_);
}
```

## Impact on Real Workloads

In RocksDB production deployments at scale, switching from Bloom to Ribbon filters with equivalent FPR yields:

1. **30-35% reduction in filter block memory** across all levels of the LSM-tree
2. **Improved block cache hit rates** because smaller filters leave more cache capacity for data blocks
3. **Negligible query latency difference** because the 2 cache-line access pattern is comparable to blocked Bloom
4. **Compaction CPU increase of ~3-5%** which is acceptable given compaction is I/O-bound in most deployments

For workloads with millions of SSTable files (common in time-series and event-logging systems), the cumulative memory savings reach multiple gigabytes, directly reducing infrastructure costs.

## Beyond Ribbon: The Filter Design Space in 2024-2025

The Ribbon paper sparked a wave of follow-up work:

- **Binary Fuse Filters** (Lemire et al., 2022): achieve similar space efficiency to Ribbon with faster construction via XOR-based fingerprint storage across three arrays, but require ~9 bits/key at 1% FPR
- **Vacuum Filters** (Wang et al., 2024): dynamic filters that support deletion while approaching Bloom-level space
- **Prefix Ribbon** (Dillinger, 2023): extends Ribbon to prefix queries for range-partitioned data, enabling efficient "is any key with this prefix present?" checks

The broader lesson: when your workload is static (build once, query many times), you can trade construction complexity for near-optimal query structures. Ribbon filters are the existence proof that the Bloom filter's 44% space overhead was never fundamental, just a consequence of its simplicity-first design from 1970.

## When to Choose Ribbon Over Bloom

Use Ribbon when:
- Filters are built once and queried millions of times (SSTable files, static dictionaries)
- Memory is constrained and you need maximum keys per byte
- You can tolerate 1.5-2× construction overhead during background operations
- Your false positive rate target is ≤ 1% (Ribbon's advantage grows at lower FPR)

Stick with Bloom when:
- Filters must support dynamic insertion
- Construction latency is on the critical path
- Implementation simplicity is paramount
- Space is not a binding constraint

The shift from Bloom to Ribbon in RocksDB demonstrates a recurring pattern in systems engineering: techniques that appear theoretically superior but "too complex for practice" eventually become practical once the right implementation insight (here: banded structure enabling O(n) elimination) bridges the gap.
