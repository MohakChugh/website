---
title: "Range as a Key: Why Cloud Block Store Indexes Are a Memory Problem"
date: 2026-09-02
tags: [storage, indexing, systems, memory-optimization, cloud]
excerpt: "A cloud block store has to answer one question on every I/O: where does logical block N physically live? Answering it per-block costs gigabytes of DRAM per terabyte of attached capacity, and that DRAM is the real cost center of the storage fleet. RASK argues the fix is to stop indexing blocks and index ranges instead, which sounds trivial until you hit overlapping writes and fragmentation. Here is the design, plus my own simulation of where the memory actually goes."
---

Every cloud block store — the thing that backs a network-attached virtual disk — has an indirection layer. The guest writes to logical block address 91,203,584 of its volume; the storage node has to translate that into "chunk 71 on drive 4 of node B, offset 1.2 MiB." That mapping is not derivable, because writes land wherever the log-structured or append-only backend put them, so it has to be stored. And because it sits on the critical path of every single read and write, it has to be resident in DRAM.

The scale problem falls straight out of arithmetic. One terabyte of logical capacity at 4 KiB granularity is 268,435,456 blocks. Even the most aggressively packed representation — a flat array indexed by LBA, storing nothing but an 8-byte physical pointer — is 2 GiB of DRAM per TiB of volume. A storage node fronting 100 TiB of attached volumes needs 200 GiB of RAM before it has cached a single byte of user data. Use an actual tree or hash table, where you pay for a key and pointers and node headers, and 24–32 bytes per entry is realistic: 6–8 GiB per TiB. The index, not the data cache, becomes the thing that determines how much capacity a node can serve.

[RASK](https://arxiv.org/abs/2601.14129) (Haoru Zhao, Mingkai Dong, Erci Xu, Zhongyu Wang, Haibo Chen; arXiv:2601.14129, January 2026) attacks this with an observation from production traces: **writes overwhelmingly target contiguous block ranges**, not scattered individual blocks. So stop making the block the unit of indexing. Make the *range* the key. The paper reports up to a 98.9% reduction in memory footprint and up to 31.0× higher throughput against ten state-of-the-art index baselines across four production traces.

The insight is one sentence. The engineering is not, and that gap is the interesting part.

## Why per-block indexing survived this long

Range-based mapping is not a new idea — filesystem extent maps (ext4, XFS, Btrfs) have done it for decades, and SSD FTLs have a well-known hybrid page/block mapping literature. So why do block stores keep reaching for per-block tables?

Because a block store cannot refuse a 4 KiB overwrite in the middle of a 1 MiB range. Extent maps in a filesystem enjoy allocation control: the filesystem decides layout and can defragment on its own schedule. A block store is handed an arbitrary LBA stream by a guest kernel it does not control, and the semantics are absolute — the newest write to a block wins, forever, at 4 KiB granularity. Per-block mapping is *uniform*: every operation is O(1), memory is predictable, and no write pattern can degrade it. Range mapping trades that uniformity for a data-dependent memory footprint. Get the data dependency wrong and you have built something that works beautifully on a benchmark and falls over on a real customer's volume.

Two specific problems bite.

**Overlap.** Once keys are ranges, a write can partially cover an existing key. Insert `[1000, 1256)` and then `[1100, 1108)` and your index now holds two entries whose key spaces intersect. A B+tree's core invariant — keys are totally ordered and disjoint, so a search descends to exactly one leaf slot — is gone. You cannot look up LBA 1102 with an ordinary predecessor search and trust the answer, because the predecessor by start address is `[1000, 1256)`, which is stale for that block.

**Fragmentation.** The natural way to preserve disjointness is to split on overwrite: `[1000, 1256)` becomes `[1000, 1100)`, `[1100, 1108)`, `[1108, 1256)`. Now a single 32 KiB overwrite has turned one entry into three. Sustained small random overwrites turn your compact range index back into a per-block index, but with worse constants.

`★ Insight ─────────────────────────────────────`
The unit-of-indexing choice is really a choice about *who absorbs variance*. Per-block indexing pushes a fixed, large cost onto every deployment. Range indexing makes the average case dramatically cheaper and pushes the cost onto pathological write patterns — which is the right trade only if you have a mechanism that bounds the pathological case.
`─────────────────────────────────────────────────`

## The log-structured leaf

RASK's answer to overlap is to stop fighting it at insert time. Instead of splitting eagerly, a leaf is a **log**: writes append their range descriptors in arrival order, overlaps and all. Newest wins is resolved at *search* time by scanning the leaf from newest to oldest and taking the first descriptor that covers the target block. Garbage collection later compacts the log, dropping descriptors that have been fully shadowed by newer ones.

This is the same trade every log-structured design makes, applied at a much smaller granularity than usual: constant-time writes, deferred reclamation, and read cost proportional to how much un-collected garbage sits in the leaf. Concretely, a descriptor and a resolver look roughly like this:

```rust
const GC_THRESHOLD: usize = 64;

/// One range descriptor. 24 bytes; `len` in 4 KiB blocks caps a range at 16 TiB.
#[repr(C)]
#[derive(Clone, Copy)]
struct Extent {
    lba: u64,   // logical start block
    pa:  u64,   // physical start (device id packed into high bits)
    len: u32,   // length in blocks
    seq: u32,   // monotonic sequence number; higher wins
}

/// A leaf owns a bounded logical key span and an append-only extent log.
struct Leaf {
    span: (u64, u64),      // half-open [lo, hi) that this leaf is responsible for
    log: Vec<Extent>,      // append order == sequence order
    live_bytes: u32,       // maintained incrementally for GC policy
}

impl Leaf {
    /// Newest-wins resolution: scan backwards, first cover wins.
    fn lookup(&self, blk: u64) -> Option<u64> {
        for e in self.log.iter().rev() {
            if blk >= e.lba && blk < e.lba + e.len as u64 {
                return Some(e.pa + (blk - e.lba));
            }
        }
        None
    }

    fn append(&mut self, e: Extent) {
        self.log.push(e);
        if self.log.len() > GC_THRESHOLD {
            self.gc();
        }
    }

    /// Compact: replay oldest→newest into a disjoint interval set, drop dead extents.
    fn gc(&mut self) {
        let mut live: Vec<Extent> = Vec::with_capacity(self.log.len());
        for e in &self.log {
            let (s, t) = (e.lba, e.lba + e.len as u64);
            let mut next = Vec::with_capacity(live.len() + 2);
            for &p in &live {
                let (ps, pt) = (p.lba, p.lba + p.len as u64);
                if pt <= s || ps >= t { next.push(p); continue; }
                if ps < s { next.push(Extent { len: (s - ps) as u32, ..p }); }
                if pt > t {
                    next.push(Extent { lba: t, pa: p.pa + (t - ps), len: (pt - t) as u32, ..p });
                }
            }
            next.push(*e);
            live = next;
        }
        live.sort_unstable_by_key(|e| e.lba);
        self.log = live;
    }
}
```

Note what GC does *not* do: it does not merge logically adjacent extents. `[1000, 1100)` and `[1100, 1256)` can only collapse into one entry if their physical extents are also adjacent. Usually they are not, because they were written at different times to different places. That is the crux of the fragmentation problem, and it is why "range-aware merge" in RASK is a separate mechanism from GC — merging generally requires *relocating data* so the physical extent becomes contiguous, which costs real I/O.

## Measuring where the memory goes

I wrote a simulator to check the two claims that matter: that range indexing is a large win under realistic write-size mixes, and that fragmentation is the thing that can take the win away. A 64 GiB volume at 4 KiB blocks, 200,000 writes drawn from a size mix of 55% 4–64 KiB, 30% 64–512 KiB, 15% 512 KiB–4 MiB, with a tunable fraction of writes appended by one of 16 sequential streams and the rest uniformly random. Per-block cost is charged at the theoretical floor of 8 bytes per touched block; range cost at the 24-byte descriptor above.

| Write locality | Blocks written | Range entries | Per-block index | Range index | Reduction | Blocks/entry |
|---|---|---|---|---|---|---|
| 90% sequential | 12,048,406 | 107,238 | 91.9 MiB | 2.5 MiB | 97.3% | 112.4 |
| 70% sequential | 12,219,664 | 122,131 | 93.2 MiB | 2.8 MiB | 97.0% | 100.1 |
| 30% sequential | 12,429,943 | 149,652 | 94.8 MiB | 3.4 MiB | 96.4% | 83.1 |
| Fully random | 12,419,608 | 167,107 | 94.8 MiB | 3.8 MiB | 96.0% | 74.3 |

96–97% reduction, in the same ballpark as the paper's 98.9%, and — importantly — **locality barely matters**. Randomizing offsets entirely only degrades the win from 97.3% to 96.0%, because what drives entry count is write *size*, not write *position*. Random large writes are still one entry each.

So the real adversary is not randomness. It is small overwrites landing inside large ranges. Second experiment: fill the volume with 1 MiB sequential ranges (65,536 entries, 1.5 MiB), then hammer it with 4–16 KiB random overwrites.

```
fill                                          65,536 entries (  1.5 MiB)
+ 10,000 small random overwrites  ->          85,301 entries (  2.0 MiB)   1.30x
+ 50,000                          ->         164,014 entries (  3.8 MiB)   2.50x
+200,000                          ->         453,498 entries ( 10.4 MiB)   6.92x
+800,000                          ->       1,524,711 entries ( 34.9 MiB)  23.27x
```

Net entry growth is **1.82–1.98 per overwrite** — essentially the +2 the split-into-three analysis predicts, decaying slowly as overwrites start hitting already-fragmented regions. Eight hundred thousand small overwrites, roughly 6 GiB of write traffic against a 64 GiB volume, inflate the index 23×. Extrapolate and you reach per-block parity: a range index degenerates into a worse-than-per-block index after enough small-overwrite traffic. In the same simulator, allowing merges of logically adjacent extents holds the index flat at exactly 65,536 entries indefinitely — but that upper bound is only reachable if you also rewrite the merged region so its physical extent is contiguous, which is a 1 MiB read-modify-write per merge. That is the actual price of the fragmentation defense, and it is why "merge" is a background defragmenter, not a bookkeeping step.

## What to take from this

The generalizable lesson is not "use extents." It is that **the granularity of your metadata should track the granularity of your workload's access pattern, and you need a mechanism that survives when it does not.** RASK's three mechanisms map cleanly onto that: a log-structured leaf so the common case (append a descriptor) is O(1) and correctness under overlap is a search-time concern; GC so shadowed metadata does not accumulate unboundedly; range-aware split/merge so the pathological small-overwrite workload has a bounded, amortized cost instead of an unbounded one.

The corollary is the honest caveat. If your volumes genuinely see sustained small random overwrites — a busy OLTP data file, a heavily updated LSM WAL device — range indexing buys you less, and the defragmenter you now need is write amplification you did not have before. The trade is excellent for the median volume and merely acceptable for the worst one, which is exactly the shape of trade a fleet operator should want, since fleet DRAM is provisioned against the median and the worst case can be given a slower node.
