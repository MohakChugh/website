---
title: "Bf-Tree: Decoupling Cache Pages from Disk Pages with Variable-Length Mini-Pages"
date: 2026-10-01
tags: ["databases", "storage-engines", "b-trees", "caching", "nvme"]
excerpt: "Bf-Tree (Hao & Chandramouli, VLDB 2024) keeps B-Tree pages at 4 KB on disk but drops the rule that a cached page must mirror one. Its buffer pool holds mini-pages: sorted, variable-length slices of a leaf that cache hot records, buffer writes, record negative lookups as phantoms, and grow into full-page mirrors when a range gets scanned. They live in a circular buffer with a 10% second-chance region. I simulated the caching claim: at the paper's memory ratio, record-granular caching hits 76% where page LRU hits 41%. I also found that the 1% admission default is a trade-off with warm-up time, not a free lunch."
---

# Bf-Tree: Decoupling Cache Pages from Disk Pages with Variable-Length Mini-Pages

Every larger-than-memory B-Tree inherits one quiet assumption from the 1970s: **a page in the buffer pool is a copy of a page on disk**. That assumption causes both of the B-Tree's well-known problems. Records are ~32–100 bytes and pages are 4–64 KB, so:

- **Caching is coarse.** One hot record pins 4 KB of memory, and most of that is cold neighbours.
- **Writes are amplified.** Updating 16 bytes dirties a whole page, which is eventually written back in full.

The usual fixes add more parts. LSM-trees pay for cheap writes in reads and compaction. Delta chains (Bw-Tree) make lookups chase pointers. Record caches don't help scans, so a page cache has to sit next to them, which is how RocksDB ends up with memory split by hand across memtable, block cache and row cache.

Bf-Tree (Xiangpeng Hao and Badrish Chandramouli, *PVLDB 17(11)*, 2024) drops the mirror assumption instead. The disk side stays a normal B-Tree with 4 KB leaves. The memory side caches **mini-pages**: variable-length, sorted subsets of a leaf that hold only what is worth keeping in memory. The paper's headline numbers, measured against baselines that share all its other optimizations: 2.5× RocksDB on scans, 6× a conventional B-Tree on writes, and 2× both on point lookups.

## One structure, four record types

A mini-page uses the leaf-page layout at variable length: 8-byte KV metadata entries grow forward, key/value bytes grow backward, and each entry carries a reference bit plus two **look-ahead bytes** of the (prefix-compressed) key that usually settle a comparison without loading the key. One structure does several jobs because of a two-bit record type:

| Type | Dirty? | Exists? | Created by |
|---|---|---|---|
| Insert | yes | yes | a write |
| Cache | no | yes | a read that went to disk (with probability 1%) |
| Tombstone | yes | no | a delete |
| Phantom | no | no | a read that found nothing on disk |

A write buffer is a mini-page full of Insert and Tombstone records; a record cache is one full of Cache records. **Phantom** is what other record caches lack: a cache of existing keys can't tell "not cached" from "doesn't exist", so every lookup of a missing key costs an I/O.

The read path is the obvious one:

```python
def get(key):
    mini, leaf = traverse(key)           # inner nodes pinned in memory, optimistic latch coupling
    if mini and (r := mini.binary_search(key)):
        return r                         # Insert/Cache -> value, Tombstone/Phantom -> not found
    r = leaf.binary_search(key)          # one 4 KB I/O via io_uring
    if random() < 0.01:                  # admission filter: don't flood memory with one-hit wonders
        mini.insert_or_create(r if r else Phantom(key))
    return r
```

Writes never touch disk directly. An insert creates a 64-byte mini-page if needed and grows it by doubling (allocate, copy, free). Past 2 KB, sorted insertion gets expensive, so the mini-page is merged into its leaf and becomes a 4 KB mirror of it. That is also how scans are handled: a scan must read the leaf anyway, since cached records can't prove a range complete, so a frequently scanned leaf grows a full mirror. Nobody partitions memory between point and range caching.

## A buffer pool that is a circular log

Variable-length entries are an allocator's problem, and this one also needs a hard memory cap, hot/cold tracking and concurrent write-back. The answer borrows from FASTER's hybrid log: **all mini-pages live in one fixed-size circular buffer**.

```text
 head ──────── second-chance ──────────────────────────────── tail ─▶ (alloc)
   │ copy-on-access (10%) │        in-place update (90%)          │
   ▼                      │                                       │
 evict: merge dirty records into leaf, repoint mapping table, advance head
```

- **Alloc** tries a size-class free list, then bumps `tail`. Allocations are packed at 8-byte alignment with an 8-byte header; huge pages keep boundary-straddling mini-pages from costing extra TLB misses.
- **Free** (after a grow or shrink) pushes the chunk onto a free list.
- **Evict** starts at `head`: merge dirty records into the leaf, point the mapping table at the leaf, advance `head`. Evictions run in parallel, but `head` only advances when every earlier eviction has finished. That keeps the log contiguous while still issuing enough concurrent I/O to fill an NVMe queue.

The **second-chance region** prevents FIFO from evicting hot data. A mini-page accessed in the oldest 10% is copied to `tail` instead of being updated in place. During that copy, Bf-Tree also evicts records *inside* the page: records whose reference bit is clear are dropped (clean ones are discarded, dirty ones trigger a merge), and the surviving bits are reset. The result is two-level CLOCK. Records that go untouched for a lap of the in-place region leave the mini-page. Mini-pages that go untouched in the second-chance region leave memory.

Inner nodes (under 1% of the tree) are pinned and use direct pointers with optimistic version locks. A mini-page shares its leaf's page ID, and each mapping entry is a 64-bit word holding a 48-bit address and a 16-bit reader-writer lock, so locking one locks both.

## Checking the caching claim

The paper's key claim is about caching efficiency. In its single-threaded latency experiment, Bf-Tree serves almost 75% of reads from memory while the page-caching systems serve about 50%. That gives Bf-Tree a median latency of 1.18 µs against 58.7 µs for the plain B-Tree, which is the gap between a memory hit and an SSD read. I wanted to check whether record granularity alone explains that, so I simulated the paper's setup at smaller scale. The scale was 1M records and 12M requests, with hit ratios measured over the final 25% of requests. The workload was scrambled Zipf 0.9, because YCSB hashes keys and so spreads hot records evenly across pages. Records were 32 bytes plus 8 bytes of metadata, leaves were 70% full, and cache memory was 31% of raw data size (2 GB for 6.4 GB in the paper).

```text
policy                     warm hit ratio
page LRU (4 KB)                 41.3%
record LRU, admit 100%          76.4%
record LRU, admit 10%           78.1%
record LRU, admit 1%            56.5%   (cache still not full after 12M requests)
```

An upper bound gives the same picture. With a static-optimal hottest-first placement at the same memory, records reach 84.3% and pages reach 55.6%. The page cache loses because, after scrambling, each page holds about 71 records and only a few of them are hot. So yes: record granularity alone roughly accounts for the paper's 75%-versus-50% split.

The rows I didn't expect are the admission rows. **The 1% default is a steady-state setting with a real warm-up cost.** Filling a cache of C records from reads alone takes about C/q misses. With q = 0.01 that is 100 misses per cached record. My run had 12 requests per key and never filled the cache. Moderate filtering does help: 10% admission beats 100%, because it keeps one-hit wonders out of LRU. In the paper's mixed 50/50 workload, writes always land in mini-pages and hide the slow warm-up. A read-heavy service restarting with a cold cache would see it. If you build something like this, consider adaptive admission, starting at q = 1 and lowering it as the cache fills.

One small discrepancy: the paper describes Zipf 0.9 as "80% of requests access 33% of records." By my count over 200M keys, that skew sends 80% of requests to the top **15.1%** of records. The 33% figure matches s ≈ 0.8. It doesn't change any conclusion, but if you reproduce the benchmark, set the skew by its parameter, not by that description.

## Where it lands

On a PCIe 4.0 SSD, Bf-Tree saturates the disk at 31 threads (19.2× scaling) and has a p99 read latency of 70 µs against RocksDB's 131 µs, helped by io_uring SQ polling with direct I/O. In memory it reduces to an ordinary B-Tree and keeps up with LeanStore. Even under uniform load it caches more: leaves are about 70% full, so a page mirror wastes about 30% of its bytes and a right-sized mini-page doesn't.

The costs: sorted mini-pages cap out around 2 KB, so one leaf buffers fewer writes than an LSM memtable absorbs. Scans read leaves until a range earns a full mirror. Recovery is plain ARIES-style logging, switched off for every system in the benchmarks. Phantoms only help negative keys that repeat, since there are no Bloom filters.

The idea carries beyond B-Trees. Mirroring disk pages was a convenience from an era of expensive I/O and simple memory management. Separate the cache unit from the I/O unit and one budget serves as write buffer, row cache, negative cache and page cache, with the workload deciding the split.

*Paper: Xiangpeng Hao and Badrish Chandramouli, "Bf-Tree: A Modern Read-Write-Optimized Concurrent Larger-Than-Memory Range Index," PVLDB 17(11): 3442–3455, 2024. Simulation numbers are my own (Python, 1M-key scaled model) and approximate the circular buffer's two-level CLOCK with LRU.*
