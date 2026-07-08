---
title: "LSM-Tree Write Amplification: From Leveled Compaction to Key-Value Separation"
date: 2026-07-09
tags: ["lsm-tree", "write-amplification", "rocksdb", "storage-engines", "compaction"]
excerpt: "Why LSM-trees suffer from 10-50x write amplification, how leveled and tiered compaction trade space for bandwidth, and how WiscKey's key-value separation eliminates the problem at the cost of scan performance."
---

# LSM-Tree Write Amplification: From Leveled Compaction to Key-Value Separation

Log-Structured Merge Trees (LSM-trees) power nearly every write-intensive storage system built in the last decade: RocksDB, LevelDB, Cassandra, HBase, CockroachDB, TiKV, ScyllaDB. The design is elegant — buffer writes in memory, flush sorted runs to disk, and merge them periodically. But this simplicity hides a brutal cost: every byte written by the application may be rewritten 10 to 50 times on disk before it reaches its final resting place.

This phenomenon — **write amplification** — is the central tension in LSM-tree design, and the last decade of storage engine research has been a sustained assault on reducing it without sacrificing read performance.

## The Anatomy of Write Amplification

An LSM-tree organizes data into levels. Level 0 (L0) holds recently flushed memtables. Each subsequent level is typically 10x larger (the **size ratio**, T). When a level exceeds its capacity, **compaction** merges its sorted runs with the next level.

In classic **leveled compaction** (as in LevelDB/RocksDB), each level from L1 onward contains exactly one sorted run. Compaction picks overlapping key ranges and merge-sorts them into the next level.

The write amplification for leveled compaction is:

```
WA_leveled = T * (L - 1)
```

Where T is the size ratio and L is the number of levels. With T=10 and 4 levels (covering ~10TB of data), a single byte written by the application gets rewritten roughly **30 times**. On an SSD with 1 DWPD (Drive Write Per Day) endurance, this means your effective application write throughput is 1/30th of the device bandwidth.

```
Device bandwidth:    500 MB/s sequential write
Write amplification: 30x
Effective app write: ~16 MB/s
```

This is the fundamental problem.

## Tiered Compaction: Trading Reads for Writes

The alternative is **tiered compaction** (used in Cassandra's STCS and Universal Compaction in RocksDB). Instead of maintaining one sorted run per level, tiered compaction allows multiple sorted runs to accumulate before merging them all at once.

```
WA_tiered = O(L)  ≈ L (number of levels, independent of T)
```

With the same 4-level tree, write amplification drops to ~4x. The catch: point reads now require checking multiple sorted runs per level, and range scans must merge T runs at each level, degrading read performance from O(L) to O(T * L) in the worst case.

The trade-off is captured by the **RUM Conjecture** (Athanassoulis et al., 2016): you cannot simultaneously optimize for **R**eads, **U**pdates, and **M**emory. Any two can be optimized at the expense of the third.

## Dostoevsky: Lazy Leveling

The Dostoevsky paper (Dayan and Idreos, SIGMOD 2018) showed that the optimal compaction strategy depends on the workload. It introduced **Lazy Leveling**, a hybrid:

- The largest level (which dominates write cost) uses tiered compaction (multiple runs)
- All smaller levels use leveled compaction (one run)

This achieves the best of both worlds for the common case of workloads dominated by zero-result point lookups:

```
WA_lazy = O(T + L - 1)   // vs O(T * L) for leveled
Point reads:  O(L)        // same as leveled (with Bloom filters)
Range scans:  O(T)        // bounded by largest level's run count
```

The key insight: since the largest level contains ~90% of the data, applying tiered compaction only there captures most of the write amplification savings while keeping smaller levels sorted for fast reads.

## WiscKey: Separating Keys from Values

WiscKey (Lu et al., FAST 2016) took a radically different approach: rather than optimizing compaction within the LSM-tree, it removes the primary source of amplification entirely.

The observation: compaction rewrites both keys and values, but keys are typically small (8-128 bytes) while values can be large (1KB-1MB). If we store values separately in an append-only log (the **vLog**) and only keep keys with value pointers in the LSM-tree, compaction now only rewrites tiny key-pointer pairs.

```
// Traditional LSM-tree entry (compacted repeatedly):
[key: 16B][value: 4KB] = 4112 bytes rewritten per compaction

// WiscKey LSM-tree entry (compacted repeatedly):  
[key: 16B][value_offset: 8B] = 24 bytes rewritten per compaction

// WiscKey value log (written once, never compacted):
[value: 4KB] = written exactly once
```

The write amplification reduction is dramatic:

```python
def write_amplification_comparison(key_size, value_size, size_ratio, levels):
    # Leveled compaction (traditional)
    wa_leveled = size_ratio * (levels - 1)
    
    # WiscKey with leveled compaction on key-pointer LSM
    entry_size_traditional = key_size + value_size
    entry_size_wisckey = key_size + 8  # 8-byte pointer
    
    # WiscKey WA = (LSM WA for small entries) + 1 (value written once)
    wa_wisckey_lsm = wa_leveled * (entry_size_wisckey / entry_size_traditional)
    wa_wisckey_total = wa_wisckey_lsm + 1
    
    return wa_leveled, wa_wisckey_total

# Example: 16B keys, 4KB values, size_ratio=10, 4 levels
wa_trad, wa_wk = write_amplification_comparison(16, 4096, 10, 4)
# wa_trad = 30.0
# wa_wk   ≈ 1.17  (nearly 1.0!)
```

For 4KB values with 16-byte keys, WiscKey reduces write amplification from 30x to approximately 1.2x.

## The Costs of Key-Value Separation

WiscKey's write amplification savings come with three significant costs:

**1. Random reads for value retrieval.** Point lookups now require two I/O operations: one to the LSM-tree (for the pointer) and one random read to the vLog. On HDDs this is fatal. On modern NVMe SSDs with ~10μs random read latency and 500K+ IOPS, it's acceptable.

**2. Degraded range scan performance.** Sequential scans in a traditional LSM-tree read contiguous sorted data. In WiscKey, a range scan returns sorted keys but must issue random reads to the vLog for each value. WiscKey mitigates this with **parallel prefetching** — issuing multiple asynchronous reads using the SSD's internal parallelism:

```c
// Simplified parallel value prefetch during range scan
void prefetch_values(Iterator* iter, int prefetch_depth) {
    int pending = 0;
    struct io_uring ring;
    io_uring_queue_init(prefetch_depth, &ring, 0);
    
    while (iter->Valid() && pending < prefetch_depth) {
        ValuePointer vptr = decode_pointer(iter->value());
        
        struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
        io_uring_prep_read(sqe, vlog_fd, 
                          buffers[pending], vptr.size, vptr.offset);
        
        pending++;
        iter->Next();
    }
    io_uring_submit(&ring);
}
```

**3. Garbage collection of the value log.** Deleted or overwritten values leave garbage in the vLog. A background GC process must scan the log, check which values are still live (by probing the LSM-tree), and rewrite live values to the log tail. This introduces its own write amplification, though typically much lower than compaction.

## Production Implementations

The key-value separation idea has made it into production:

**RocksDB BlobDB** (integrated since RocksDB 6.18, 2021): Values exceeding `min_blob_size` are stored in separate blob files. Blob GC is triggered during compaction — when a blob file's garbage ratio exceeds a threshold, live blobs are relocated. This piggybacking on compaction avoids a separate GC thread.

**TiKV Titan** (production at PingCAP since 2019): Fork of RocksDB with key-value separation. Titan stores large values in "blob files" with a configurable threshold (default 1KB). It introduced **level merge** — when compaction processes an SST, it simultaneously merges the associated blob files, maintaining some locality for range scans.

**BadgerDB** (Dgraph): A Go implementation of WiscKey principles. Values go to a separate value log, with GC managed by tracking the discard statistics per log file.

## When to Use Key-Value Separation

Key-value separation is not universally beneficial. The decision depends on your value size distribution:

| Value Size | KV Separation Benefit | Reason |
|---|---|---|
| < 256B | Negative | Pointer overhead dominates; random reads hurt |
| 256B - 1KB | Marginal | Trade-offs roughly balance |
| 1KB - 64KB | Strong | Write amplification savings dominate |
| > 64KB | Massive | Traditional LSM compaction becomes untenable |

The crossover point depends on your SSD's random vs sequential read ratio. Modern NVMe drives with ~3:1 sequential-to-random bandwidth ratios push the crossover lower than SATA SSDs.

## The Broader Design Space

Recent work continues to push the boundaries:

**SILK** (ATC 2019) manages I/O bandwidth allocation between client writes and internal compaction, preventing compaction from starving foreground operations — a practical concern regardless of the compaction strategy chosen.

**SpanDB** (FAST 2021) uses a small NVMe Optane device for the WAL and upper LSM levels while keeping the bulk data on cheaper QLC NAND, exploiting the storage hierarchy.

**Lethe** (SIGMOD 2020) adds delete-awareness to compaction, ensuring that tombstones propagate quickly for GDPR compliance without amplifying writes for non-deleted data.

The write amplification problem in LSM-trees is not solved — it is managed through increasingly sophisticated trade-offs between write cost, read cost, space cost, and implementation complexity. Understanding where your workload sits in this space determines which compaction strategy and whether key-value separation will yield the best performance for your specific access patterns.
