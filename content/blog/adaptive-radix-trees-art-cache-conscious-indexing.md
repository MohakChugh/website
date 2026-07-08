---
title: "Adaptive Radix Trees: How Modern Databases Achieve Sub-Microsecond Lookups"
date: 2026-07-08
tags: ["data-structures", "databases", "indexing", "memory-optimization"]
excerpt: "Dissecting ART (Adaptive Radix Tree), the cache-conscious indexing structure that outperforms B-trees for in-memory workloads by collapsing node sizes, eliminating key comparisons, and exploiting CPU cache hierarchies."
---

# Adaptive Radix Trees: How Modern Databases Achieve Sub-Microsecond Lookups

B-trees have dominated database indexing for fifty years. Their design assumes disk-resident data where minimizing I/O is paramount. But modern analytical databases like DuckDB, Umbra, and HyPer operate entirely in memory, where the bottleneck shifts from disk seeks to **cache misses**. Enter the Adaptive Radix Tree (ART): a trie variant that achieves O(k) lookup complexity (where k is key length, not dataset size) while fitting snugly into L1/L2 cache lines.

## The Trie Problem and ART's Solution

A naive 256-way trie wastes catastrophic amounts of memory. Each inner node allocates space for 256 child pointers regardless of how many are populated. For sparse keys (the common case), occupancy is often below 5%, meaning 95%+ of each node is empty. A trie indexing 1 million 8-byte keys would consume roughly 150 GB of pointer arrays.

ART solves this with **adaptive node types**. Rather than a fixed fan-out, each node dynamically selects among four representations based on the number of populated children:

```
Node4:   up to 4 children   — 4-element key[] + 4 child pointers (52 bytes)
Node16:  up to 16 children  — 16-element key[] + 16 child pointers (160 bytes)
Node48:  up to 48 children  — 256-byte index + 48 child pointers (656 bytes)
Node256: up to 256 children — 256 child pointers directly indexed (2048 bytes)
```

The critical insight: **most inner nodes are sparse**. Empirical analysis of real workloads shows that over 90% of nodes contain fewer than 16 children. Node4 and Node16 together handle the vast majority of the tree structure while consuming only one or two cache lines each.

## Cache-Line Arithmetic

Modern CPUs fetch memory in 64-byte cache lines. Node4 fits entirely within a single cache line. Node16 spans 2-3 cache lines but enables a crucial optimization: the 16-byte key array aligns perfectly with a single SSE register, allowing the CPU to perform **SIMD comparison** of all 16 keys in a single instruction:

```c
// Node16 lookup using SSE2 SIMD
__m128i key_vec = _mm_set1_epi8(key_byte);
__m128i cmp = _mm_cmpeq_epi8(key_vec, node->keys);
int mask = _mm_movemask_epi8(cmp);  // bitmask of matches
if (mask) {
    int idx = __builtin_ctz(mask);   // first matching position
    return node->children[idx];
}
```

This eliminates branch mispredictions entirely. Instead of a binary search with log2(16) = 4 comparisons and 4 branch prediction opportunities, we get a single comparison with deterministic control flow.

Node48 uses an indirection trick: a 256-byte array maps each possible byte value to a slot index (0-47) in the child pointer array, or marks it empty. Lookup is two cache-line reads total: one for the index byte, one for the child pointer. No searching, no branching.

## Path Compression: Eliminating Redundant Nodes

Real keys share long common prefixes. The path from root to leaf for keys like `"user:12345"` and `"user:12346"` shares 10 bytes before diverging. Without optimization, this creates 10 single-child nodes that each burn a cache miss for zero discriminating power.

ART uses two compression techniques:

**Lazy expansion**: Single-child nodes are eliminated entirely. The tree stores the diverging suffix directly, only creating inner nodes where keys actually branch.

**Pessimistic path compression**: Each node stores a variable-length prefix that represents the collapsed path. During lookup, we compare the stored prefix against the search key:

```c
typedef struct {
    uint8_t prefix[MAX_PREFIX_LEN];
    uint32_t prefix_len;
    // ... node type fields
} art_node;

static bool check_prefix(art_node *node, uint8_t *key, int depth) {
    for (int i = 0; i < min(node->prefix_len, MAX_PREFIX_LEN); i++) {
        if (node->prefix[i] != key[depth + i])
            return false;
    }
    return true;
}
```

When the stored prefix exceeds MAX_PREFIX_LEN (typically 10 bytes), the remaining bytes are verified by comparing against the actual stored key at the leaf. This bounds node size while still collapsing arbitrarily long shared prefixes.

## Concurrency: Optimistic Lock Coupling (OLC)

ART's original design was single-threaded. The ART-OLC extension (Leis et al., 2016) adds lock-free reads through optimistic validation. Each node carries a version counter:

```c
typedef struct {
    uint64_t version;  // even = unlocked, odd = write-locked
    // ... node fields
} art_node_concurrent;

static inline uint64_t read_lock(art_node_concurrent *node) {
    uint64_t v = atomic_load(&node->version);
    while (v & 1) {  // spin while write-locked
        _mm_pause();
        v = atomic_load(&node->version);
    }
    return v;
}

static inline bool read_unlock(art_node_concurrent *node, uint64_t expected) {
    __atomic_thread_fence(__ATOMIC_ACQUIRE);
    return atomic_load(&node->version) == expected;
}
```

Readers never acquire locks. They record the version before reading, then validate it afterwards. If a concurrent writer modified the node, the version changes and the reader simply restarts from the parent. Writers use traditional exclusive locking but only on the specific nodes being modified.

This achieves remarkable read scalability: on a 64-core machine, ART-OLC delivers near-linear throughput scaling for read-heavy workloads because readers never contend with each other.

## Height Optimized Tries (HOT): The Next Generation

The HOT (Binna et al., 2018) extension pushes cache efficiency further by **merging multiple trie levels into compound nodes**. Rather than processing one byte per level, HOT dynamically combines 2-8 discriminating bits from different key positions into a single node lookup.

The key observation: not all bit positions in a byte are discriminating. If your keys only differ in 3 bit positions across a span of 4 bytes, HOT creates a single node with a 3-bit fan-out (8 children) instead of 4 separate nodes. This reduces tree height from 8 (one per byte for 64-bit keys) to as few as 2-3 levels for realistic distributions.

## Performance Profile

Benchmarks from the original ART paper (Leis et al., ICDE 2013) and subsequent work show:

| Operation | B-tree (in-memory) | ART | Speedup |
|-----------|-------------------|-----|---------|
| Point lookup | ~400ns | ~180ns | 2.2x |
| Range scan (1000 keys) | ~12μs | ~8μs | 1.5x |
| Insert | ~500ns | ~220ns | 2.3x |
| Space (1M int keys) | ~32 MB | ~18 MB | 1.8x |

The space advantage comes from path compression eliminating redundant nodes. The speed advantage comes from eliminating key comparisons (ART never compares full keys during traversal, only individual bytes) and from cache-friendly node sizes.

## Where ART Wins and Loses

ART dominates when:
- Keys are variable-length strings with shared prefixes (URLs, file paths, identifiers)
- Workloads are read-heavy with point lookups
- The dataset fits in memory
- Key distribution is skewed (realistic, not uniform random)

B-trees remain competitive when:
- Range scans dominate (B-tree leaf chains are sequential in memory)
- Keys are fixed-width integers with no shared structure
- The dataset exceeds memory (B-trees' high fan-out minimizes page faults)

## Adoption in Production Systems

DuckDB uses ART as its primary index structure for Aggregation Hash Tables and string dictionaries. The HyPer/Umbra lineage of research databases uses ART as the default in-memory index. MemSQL (now SingleStore) employs a skip-list/trie hybrid for its lock-free indexes. The Linux kernel's page cache uses a radix tree variant (the XArray) for mapping file offsets to page frames.

The pattern is clear: when your data lives in RAM, the fifty-year reign of B-trees yields to structures designed from cache lines up rather than disk blocks down. ART represents a new generation of indexing where the fundamental unit of design is not the page, but the 64-byte cache line.
