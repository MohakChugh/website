---
title: "bcachefs: Copy-on-Write B-Trees and the Future of Crash-Consistent Filesystem Design"
date: 2026-07-08
tags: [filesystems, btrees, copy-on-write, linux-kernel, crash-consistency]
excerpt: "How bcachefs uses copy-on-write B-trees with six-point journal entries to achieve crash consistency without the write amplification of traditional journaling, and why this design changes the calculus for next-generation storage engines."
---

# bcachefs: Copy-on-Write B-Trees and the Future of Crash-Consistent Filesystem Design

Linux 6.7 (December 2023) merged bcachefs, the first new general-purpose filesystem to enter the kernel in over a decade. While headlines focused on the politics of its inclusion, the technically interesting story is its storage engine: a copy-on-write B-tree that achieves crash consistency without the double-write penalty of ext4's journaling or the fragmentation pathologies of btrfs's extent-based CoW. This post dissects the data structure, the consistency protocol, and the performance implications.

## The Problem with Traditional Approaches

Filesystems must survive power loss mid-write. Two dominant strategies exist:

**Write-Ahead Journaling (ext4, XFS):** Write metadata changes to a sequential log first, then apply them in-place. Safe, but every metadata write happens twice — once to the journal, once to its final location. For metadata-heavy workloads (mail servers, build systems), this 2x write amplification is painful.

**Full Copy-on-Write (btrfs, ZFS):** Never overwrite data in place. Writes go to new locations; old versions remain until explicitly freed. Eliminates journaling overhead, but creates a cascading problem: modifying a leaf node requires writing a new leaf, a new parent, a new grandparent — all the way to the root. This "wandering tree" pattern fragments the B-tree over time.

bcachefs takes a third path: CoW B-trees with bounded cascading via journal pinning.

## The bcachefs B-Tree Structure

bcachefs uses a single B-tree keyspace to store all filesystem metadata — inodes, dirents, extents, xattrs, and internal allocator state. Keys are 20-byte tuples:

```c
struct bpos {
    __u64 inode;
    __u64 offset;
    __u32 snapshot;
};
```

The snapshot field enables native snapshot support without reflink overhead. Nodes are 256 KiB by default (tunable), significantly larger than traditional 4 KiB filesystem blocks. This amortizes the cost of CoW: rewriting 256 KiB per modification sounds expensive, but modern NVMe devices sustain 256 KiB writes at near-peak bandwidth while paying heavy latency penalties for small random writes.

### Interior Node Compaction

Interior nodes use a packed format with variable-length keys:

```c
struct bkey_packed {
    __u8  format;      // compression format selector
    __u8  nr_key_bits; // how many bits of key are stored
    // ... packed key data follows
};
```

Keys that share high-order bits with their predecessors are delta-encoded, reducing interior node fan-out by 2-3x compared to naive fixed-width keys. A 256 KiB interior node typically holds 4000-8000 children, keeping tree height at 2-3 levels for most workloads.

## Bounded Copy-on-Write with Journal Pinning

Here's the core innovation. bcachefs does NOT propagate CoW all the way to the root on every write. Instead:

1. When a leaf node is modified, it's written to a new location (CoW).
2. The parent's pointer to this leaf is updated **in memory only**.
3. A journal entry records the new leaf's location and its logical position in the tree.
4. The parent node is only rewritten when it accumulates enough dirty child pointers to justify a full 256 KiB write.

The journal acts as a "pinning" mechanism — it holds references to the new leaf locations until the parent is itself CoW'd. On recovery, the filesystem replays journal entries to reconstruct any interior node updates that hadn't been flushed.

```
Normal write path:
  modify leaf → CoW leaf to new location → journal(leaf_ptr_update) → done

Periodic flush (or when interior node is "full dirty"):
  CoW interior node with accumulated updates → journal(interior_ptr_update) → done

Recovery:
  read root → replay journal → reconstruct interior pointer updates
```

This bounds write amplification to approximately 1x for leaves plus an amortized fractional cost for interior nodes. In practice, interior nodes absorb hundreds of leaf pointer updates before being rewritten.

## Six-Point Journal Entries

bcachefs journal entries are more structured than traditional filesystem logs. Each entry contains:

```c
struct jset_entry {
    __u16 type;       // key update, btree root, usage counter, etc.
    __u16 btree_id;   // which btree this applies to
    __u8  level;      // btree level (0 = leaf)
    struct bpos start_pos;
    // ... key/value data
};
```

The six critical entry types form a complete consistency protocol:

1. **BTREE_KEYS**: Leaf key insertions/deletions
2. **BTREE_ROOT**: Root pointer update (written on clean shutdown)
3. **ALLOC**: Allocator bucket state transitions
4. **USAGE**: Space accounting counters
5. **DATA_USAGE**: Per-device utilization
6. **CLOCK**: Logical timestamp for LRU eviction ordering

By recording allocator state transitions in the journal, bcachefs avoids the "space leak" problem that plagues btrfs — where a crash between data write and metadata update can permanently lose track of allocated blocks.

## Write Path: From Syscall to Disk

A typical `write()` to a bcachefs file:

```
1. Allocate new data blocks from the bucket allocator
2. Write data blocks (no CoW needed — these are fresh allocations)
3. Insert extent key (inode, offset, snapshot) → (device, block, length)
4. Key insertion triggers leaf CoW:
   a. Read current leaf (may be cached)
   b. Insert key into sorted leaf
   c. If leaf overflows: split into two leaves
   d. Write new leaf(s) to freshly allocated locations
   e. Journal: record new leaf pointer(s) in parent
5. Update inode size/mtime (another key update, same mechanism)
6. Journal commit: fsync() barrier makes entries durable
```

The critical insight: steps 4d and 4e are decoupled. The leaf write and the journal write can be issued concurrently. The journal entry is small (tens of bytes), so it piggybacks on the next journal commit — which happens either on fsync() or when the journal write buffer fills.

## Copygc: Garbage Collection Without Stop-the-World

Dead leaves (overwritten by CoW) are reclaimed by `copygc`, bcachefs's background garbage collector. Unlike btrfs's balance operation (which can stall the entire filesystem), copygc operates at the bucket level:

1. Score buckets by fragmentation ratio (live bytes / bucket size)
2. Select the most fragmented buckets as evacuation candidates
3. For each live extent in a candidate bucket, CoW it to a new location
4. Mark the fully-evacuated bucket as free

This is essentially log-structured merge compaction applied to a B-tree filesystem. The scoring function prioritizes buckets where a single CoW read-modify-write reclaims the most space, bounding write amplification to:

```
WA_gc = 1 / (1 - space_utilization)
```

At 80% utilization, garbage collection adds approximately 5x write amplification — identical to the theoretical bound for log-structured stores. At 50% utilization, it's just 2x.

## Benchmarks: Where bcachefs Wins

On metadata-intensive workloads (file creation, deletion, renames), bcachefs outperforms ext4 by 30-60% due to eliminating journal double-writes. Against btrfs, the advantage is more nuanced:

- **Random 4K overwrites (high utilization):** bcachefs wins due to bounded CoW cascading
- **Sequential large writes:** Comparable performance, both limited by device bandwidth
- **Snapshot-heavy workloads:** bcachefs's snapshot-aware keyspace avoids btrfs's refcount bottleneck
- **Sustained random writes at >90% capacity:** bcachefs degrades gracefully; btrfs enters ENOSPC pathology

The weak spot: workloads that write to many files once and never overwrite. Here, btrfs's extent-based allocation produces less internal fragmentation than bcachefs's B-tree leaf nodes with partially-filled slots.

## Implications for Storage Engine Design

bcachefs's design validates several principles that apply beyond filesystems:

1. **Large node sizes + CoW > small nodes + in-place journaling** when storage devices penalize small random writes (all flash devices).

2. **Decoupling structural consistency from pointer propagation** via a small auxiliary log eliminates the wandering tree problem without sacrificing crash safety.

3. **Unified keyspace designs** (one B-tree for everything) simplify atomicity — multi-key transactions within a single tree are naturally atomic with a single journal commit.

4. **Background compaction with economic scoring** prevents the tail-latency spikes that plague systems relying on synchronous space reclamation.

These patterns are directly applicable to embedded key-value stores, database buffer managers, and distributed storage systems where crash consistency and write amplification are competing constraints.

## Looking Forward

bcachefs is still stabilizing (it remains marked experimental in 6.9+), but the architecture is sound. The combination of snapshot-aware CoW B-trees, journal-pinned interior nodes, and bucket-level copygc represents a genuine advance over the 2005-era designs of btrfs and ZFS. For anyone building storage engines — whether filesystems, databases, or object stores — bcachefs offers a blueprint for achieving crash consistency with minimal write amplification on modern NVMe hardware.
