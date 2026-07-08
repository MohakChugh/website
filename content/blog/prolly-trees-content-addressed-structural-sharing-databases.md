---
title: "Prolly Trees: Content-Addressed Structural Sharing for Version-Controlled Databases"
date: 2026-07-08
tags: [data-structures, databases, version-control, content-addressing, merkle-trees]
excerpt: "How probabilistic B-trees use rolling hash chunk boundaries to enable O(log n) structural diffs between database snapshots, bringing Git-like branching and merging semantics to multi-gigabyte relational datasets with minimal storage overhead."
---

## The Structural Diff Problem

Git works because tree objects are content-addressed: change one file and only the nodes along the path from root to that leaf change. But Git's tree structure is a simple directory hierarchy. Databases need ordered indexes — B-trees — and traditional B-trees are hostile to structural sharing. Insert a single row and cascading page splits can rewrite half the tree, destroying any hope of efficient diffing between versions.

The question is: can we build an ordered index that preserves Git's property — that small logical changes produce small structural changes — while maintaining B-tree query performance?

Prolly trees (probabilistic B-trees) answer yes, using a content-defined chunking strategy borrowed from deduplication systems like rsync.

## Content-Defined Chunk Boundaries

A traditional B-tree splits pages based on a fixed capacity threshold (e.g., split when a page exceeds 4KB). This means insertions at different positions produce entirely different tree structures, even for identical data. Two trees containing the same million rows but built in different insertion orders will share zero nodes.

Prolly trees replace fixed-size splitting with **content-defined splitting**. The boundary decision for each node depends only on the content of the items at that boundary, not on the node's current size or the insertion history.

The mechanism uses a rolling hash over each key-value pair:

```python
def should_split(key: bytes, value: bytes, level: int) -> bool:
    h = rolling_hash(key + value)
    pattern = (1 << (PATTERN_BITS + level * LEVEL_FACTOR)) - 1
    return (h & pattern) == pattern
```

A chunk boundary occurs wherever the hash of an item's content matches a bit pattern. The `level` parameter increases the expected chunk size at higher tree levels, maintaining the logarithmic height invariant.

The critical insight: because boundary decisions depend only on item content, two trees containing the same data will always produce the **same structure**, regardless of insertion order. And changing a single item only affects the chunk containing that item — neighboring chunks remain identical.

## The Structural Sharing Guarantee

Consider two database snapshots V1 and V2 where V2 differs by k row modifications. In a prolly tree:

1. Each modification affects exactly one leaf chunk (expected size ~4KB)
2. The modified leaf gets a new content-address (hash)
3. The parent node containing that leaf's reference changes
4. Changes propagate up to the root — O(log n) nodes total

All other nodes in the tree remain byte-identical between V1 and V2. Since nodes are identified by their content hash, identical nodes are stored once and referenced from both versions. For a 10GB table with 1000 row changes, the storage delta might be 50KB of actual new data.

```
V1 Root: hash_A          V2 Root: hash_B
    ├── hash_X (shared)      ├── hash_X (shared)  ← identical
    ├── hash_Y (shared)      ├── hash_Y (shared)  ← identical
    └── hash_Z               └── hash_Z'          ← modified subtree
         ├── chunk_1              ├── chunk_1      ← shared
         ├── chunk_2              ├── chunk_2'     ← 1 row changed
         └── chunk_3              └── chunk_3      ← shared
```

## Diff Algorithm: O(k log n) Not O(n)

The structural sharing property enables efficient three-way diffs. Given two roots, a parallel descent identifies differing subtrees:

```go
func Diff(left, right Node) []Change {
    if left.Hash() == right.Hash() {
        return nil // entire subtrees identical
    }
    if left.IsLeaf() && right.IsLeaf() {
        return diffLeafChunks(left, right)
    }
    // Align children by key ranges, recurse only into differing pairs
    pairs := alignChildren(left.Children(), right.Children())
    var changes []Change
    for _, p := range pairs {
        if p.left == nil {
            changes = append(changes, Added{p.right})
        } else if p.right == nil {
            changes = append(changes, Removed{p.left})
        } else {
            changes = append(changes, Diff(p.left, p.right)...)
        }
    }
    return changes
}
```

When two subtree hashes match, the entire subtree is skipped — no descent needed. For k modifications in an n-row table, the diff touches O(k log n) nodes rather than scanning all n rows. Diffing a 100-million-row table with 50 changes completes in microseconds.

## Chunk Size Distribution and Tuning

The rolling hash approach produces chunks following a geometric distribution with expected size `E[chunk] = 2^PATTERN_BITS`. The variance matters: too-small chunks waste space on pointers; too-large chunks reduce sharing granularity.

Production systems use a bounded distribution with minimum and maximum chunk sizes:

```rust
struct ChunkConfig {
    min_size: usize,      // 512 bytes — never split below this
    target_size: usize,   // 4096 bytes — expected average
    max_size: usize,      // 16384 bytes — force split above this
    pattern_bits: u32,    // log2(target_size) = 12
}

fn find_boundary(items: &[Item], config: &ChunkConfig) -> usize {
    let mut size = 0;
    for (i, item) in items.iter().enumerate() {
        size += item.encoded_size();
        if size < config.min_size {
            continue;
        }
        if size >= config.max_size {
            return i;
        }
        if rolling_hash(&item.key) & ((1 << config.pattern_bits) - 1) == 0 {
            return i;
        }
    }
    items.len() - 1
}
```

The min/max bounds trade a small amount of structural determinism for practical chunk size guarantees. Items within the min window cannot trigger boundaries, so adjacent insertions within min_size bytes of each other may cause a one-chunk shift — but this is bounded and does not cascade.

## Three-Way Merge Semantics

With efficient diffs, prolly trees enable database-level merge operations. Given a common ancestor and two diverged branches:

1. Compute `diff(ancestor, left)` → set of changes CL
2. Compute `diff(ancestor, right)` → set of changes CR
3. Partition changes by key ranges into non-overlapping and conflicting sets
4. Apply non-conflicting changes automatically
5. Surface conflicts (same row modified differently) for resolution

This gives relational databases Git-like branching. A team can fork a production schema, make experimental migrations on a branch, and merge back — with row-level conflict detection and sub-second merge times on multi-gigabyte datasets.

## Performance Characteristics

Benchmarks from production implementations on a 50M-row table (8GB data):

| Operation | Prolly Tree | Traditional B-tree |
|-----------|-------------|-------------------|
| Point lookup | 1.2μs | 0.9μs |
| Range scan (1000 rows) | 340μs | 280μs |
| Insert (single row) | 4.1μs | 2.8μs |
| Diff (100 changes) | 89μs | N/A (full scan: 12s) |
| Branch creation | 1 pointer write | Full copy: 8GB |
| Storage for 1000 versions | 9.2GB | 8TB (naive) |

The read path pays ~30% overhead from content-addressing (hash lookups, slightly larger nodes from hash pointers). The write path pays ~45% overhead from hashing and write amplification of path-copying. But the version management operations — diff, branch, merge — go from impossible or O(n) to O(k log n).

## Compaction and Garbage Collection

Content-addressed storage accumulates unreachable nodes as old versions are pruned. A reference-counting GC tracks which roots are live:

1. Each commit pins its root hash
2. Reachable nodes are those transitively referenced from any pinned root
3. Unreachable nodes are candidates for collection

Since nodes are immutable and identified by content hash, GC is safe to run concurrently — no node currently referenced can be collected, and newly written nodes are always reachable from the in-progress transaction root.

The deduplication property means GC must track reference counts carefully: a node shared between 100 versions is only collectible when all 100 versions are pruned.

## Real-World Adoption

Dolt (MySQL-compatible database with Git semantics) uses prolly trees as its primary storage layer, serving production workloads with full branch/merge/diff capabilities. Noms (the research prototype that originated the data structure) demonstrated the concept on append-heavy analytics workloads. IPLD (InterPlanetary Linked Data) uses similar content-addressed tree structures for distributed data synchronization.

The key insight that makes prolly trees practical: by making tree structure deterministic from content, you get structural sharing for free — and structural sharing is the foundation that makes versioning, diffing, and merging tractable on datasets that would otherwise require full copies or O(n) scans.

## When to Choose Prolly Trees

Use prolly trees when your workload needs:
- **Versioned datasets** with cheap branching and O(k log n) diffs
- **Structural deduplication** across many similar snapshots
- **Concurrent readers on historical versions** without blocking writers
- **Merge-based collaboration** on shared mutable datasets

The 30-45% single-version overhead is the price for these capabilities. For workloads that never need version comparison — pure OLTP with no audit trail — a traditional B-tree remains faster. But for any system where "what changed between version A and B" is a first-class operation, prolly trees eliminate an entire class of expensive full-table scans.
