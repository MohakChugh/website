---
title: "Treeline: Rethinking Key-Value Stores for NVMe SSDs with Page Grouping and Insert Forecasting"
date: 2026-07-09
tags: ["storage-engines", "nvme", "key-value-stores", "b-trees", "database-internals"]
excerpt: "How Treeline from CMU redesigns update-in-place storage for modern NVMe SSDs, using page grouping to exploit device parallelism and insert forecasting to minimize write amplification — achieving 2x throughput over RocksDB on write-heavy workloads."
---

# Treeline: Rethinking Key-Value Stores for NVMe SSDs with Page Grouping and Insert Forecasting

The storage engine landscape has been dominated by two paradigms: B-trees (update-in-place, read-optimized) and LSM-trees (append-only, write-optimized). LSM-trees became the default for modern key-value stores because they convert random writes into sequential ones — a critical optimization when storage was backed by HDDs or early SATA SSDs with limited parallelism.

But modern NVMe SSDs have fundamentally changed the I/O landscape. A single Samsung PM9A3 can sustain 900K random 4KB reads per second and 180K random writes per second across 128 internal channels. The "sequential is always better" assumption no longer holds unconditionally. **Treeline**, a research system from Carnegie Mellon's DBMS Group (VLDB 2023), exploits this shift to build an update-in-place key-value store that outperforms LSM-trees on write-heavy workloads while maintaining competitive read performance.

## The Core Insight: Page Grouping

Traditional B-trees suffer on SSDs because a single key insertion can trigger a page split, which writes two pages to arbitrary locations. On an HDD, this is catastrophic. On NVMe, the random write itself is fast — but the *device-internal parallelism* is wasted because both pages likely map to the same flash channel.

NVMe SSDs internally stripe data across many channels (typically 8–128). When you write to sequential LBAs, the device's Flash Translation Layer (FTL) distributes those writes across channels. But B-tree splits produce small, scattered writes that may all hit the same die.

Treeline introduces **page grouping**: a mechanism that co-locates logically related pages on contiguous physical blocks, ensuring that write bursts are spread across the device's internal parallelism:

```
Traditional B-tree on NVMe:
  Page Split → Write page A to LBA 1042 → Channel 3
             → Write page B to LBA 7891 → Channel 3 (same die!)
             → Serialized at device level

Treeline Page Grouping:
  Page Split → Write page A to LBA 2048 → Channel 0
             → Write page B to LBA 2049 → Channel 1
             → Parallelized across dies
```

Pages are allocated in **segments** (contiguous LBA ranges, typically 512KB–2MB). Each segment maps to a subtree of the logical B-tree. When a leaf page splits, both the original and new page remain within the same segment, preserving locality for range scans while ensuring the FTL distributes the I/O.

## Insert Forecasting

The second key innovation is **insert forecasting**: Treeline predicts where future inserts will land and pre-structures pages to minimize splits. This is not learned indexing in the PGM/ALEX sense — instead, it uses a lightweight linear model per segment that estimates the insert distribution:

```cpp
struct SegmentModel {
    double slope;
    double intercept;
    uint64_t base_key;
    size_t num_pages;

    size_t predict_page(uint64_t key) const {
        double pos = slope * (key - base_key) + intercept;
        return std::clamp<size_t>(pos, 0, num_pages - 1);
    }
};
```

When Treeline creates a new segment (either at initialization or after a segment fills up), it samples recent inserts to fit this model. Pages within the segment are then allocated with **fill factors** proportional to the predicted insert density:

- If the model predicts keys 1000–2000 will receive 3x the inserts of keys 2000–3000, the pages covering the first range start at 50% full, while the latter start at 85%.
- This dramatically reduces split frequency without wasting overall space.

The model is rebuilt lazily — only when a segment's actual split rate exceeds a threshold, indicating the distribution has shifted.

## Architecture Overview

Treeline's architecture combines these ideas into a complete storage engine:

```
┌─────────────────────────────────────────────────────┐
│                  Write Buffer (DRAM)                 │
│  Sorted in-memory buffer, ~64MB, absorbs bursts     │
├─────────────────────────────────────────────────────┤
│              Segment Directory (DRAM)                │
│  Maps key ranges → segment metadata + models        │
├─────────────────────────────────────────────────────┤
│           Page Cache (DRAM, clock-based)             │
│  Caches hot B-tree pages from NVMe                  │
├─────────────────────────────────────────────────────┤
│                  NVMe SSD Layer                      │
│  Segments: contiguous LBA ranges                    │
│  Each segment: sorted pages forming B-tree subtree  │
│  WAL: sequential log for crash recovery             │
└─────────────────────────────────────────────────────┘
```

Key design choices:

1. **Write buffer with deferred flush**: Inserts accumulate in DRAM and flush as a batch to the appropriate segment. The batch size is tuned to saturate the device's write bandwidth across multiple channels.

2. **Segment-level WAL**: Rather than a global WAL, each segment maintains its own log entries in a dedicated LBA range adjacent to the data pages. This avoids the WAL becoming a sequential bottleneck.

3. **Reorganization in background**: When a segment's pages become too fragmented (high split ratio, degraded scan performance), a background thread rewrites the segment with updated fill factors from the refreshed model.

## Concurrency with Optimistic Latching

Treeline uses optimistic lock coupling for concurrent access, similar to modern B-tree implementations:

```cpp
bool try_insert(PageRef page, Key key, Value val) {
    uint64_t version = page->version.load(std::memory_order_acquire);
    if (page->is_locked(version)) return false;  // retry

    // Optimistic read of page contents
    auto slot = page->find_slot(key);
    
    // Validate no concurrent modification
    if (page->version.load(std::memory_order_acquire) != version)
        return false;  // retry

    // Acquire write lock
    if (!page->try_lock(version)) return false;
    
    page->insert_at(slot, key, val);
    page->unlock_and_increment();
    return true;
}
```

This avoids reader-writer locks entirely — readers never block, and writers only CAS on the specific page's version counter.

## Performance: Why This Beats LSM-Trees on NVMe

The paper reports benchmarks on a 4-core machine with a Samsung 980 Pro (7 NVMe channels):

| Workload | RocksDB | Treeline | Speedup |
|----------|---------|----------|---------|
| Write-heavy (YCSB-A) | 142K ops/s | 289K ops/s | 2.03x |
| Read-heavy (YCSB-B) | 485K ops/s | 461K ops/s | 0.95x |
| Scan-heavy (YCSB-E) | 38K ops/s | 52K ops/s | 1.37x |
| Write-only (YCSB-F) | 128K ops/s | 301K ops/s | 2.35x |

The write advantage comes from eliminating compaction. RocksDB's compaction reads and rewrites entire SST files (write amplification 10–30x). Treeline's update-in-place approach has write amplification of 2–4x (the page write plus WAL entry), and page grouping ensures these writes hit multiple channels simultaneously.

The slight read disadvantage on YCSB-B is due to RocksDB's bloom filters, which allow it to skip levels entirely. Treeline compensates with cache-friendly page layouts and the forecasting model's ability to direct lookups to the exact segment.

## When to Use This Pattern

Treeline's approach is most beneficial when:

- **NVMe with high internal parallelism** (4+ channels). On SATA SSDs, the parallelism advantage vanishes.
- **Write-heavy or mixed workloads**. For purely read-dominant workloads, a well-tuned LSM with bloom filters still wins.
- **Uniform-to-moderate skew in key distribution**. Extreme hotspots (all writes to one key range) defeat page grouping since all I/O targets one segment.
- **Latency-sensitive applications**. LSM compaction creates tail-latency spikes; update-in-place has more predictable P99.

## Implications for Production Systems

Several production systems are moving in this direction:

- **WiredTiger** (MongoDB's storage engine) already uses B-tree variants with hazard pointers and page-level concurrency, though without explicit NVMe-awareness.
- **BtrDB** uses a copy-on-write tree optimized for time-series that naturally produces sequential writes.
- **SplinterDB** from VMware Research uses a similar "exploit device parallelism" philosophy with its trunk/branch architecture.

The broader lesson: as storage hardware evolves, the decades-old assumption that "sequential >> random" is becoming a spectrum. Modern storage engines must be *device-topology-aware* — understanding channel counts, zone sizes (for ZNS SSDs), and write unit alignment to extract maximum performance.

Treeline demonstrates that the B-tree — often dismissed as legacy — can outperform LSM-trees when you redesign it from first principles for modern hardware. The key is not choosing between paradigms but understanding which hardware assumptions each paradigm was optimized for, and adapting when those assumptions change.
