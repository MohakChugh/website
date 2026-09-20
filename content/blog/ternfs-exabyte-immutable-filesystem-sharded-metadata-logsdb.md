---
title: "TernFS: An Exabyte Filesystem Built on 256 Shards That Never Talk to Each Other"
date: 2026-09-20
tags: ["distributed-systems", "storage", "filesystems", "erasure-coding", "metadata"]
excerpt: "XTX Markets open-sourced TernFS in September 2025: a distributed filesystem running at 500+ PB across 30,000 disks with zero bytes lost. Its core bet is aggressive simplification — files are immutable, metadata lives in 256 RocksDB shards that never communicate, cross-directory renames funnel through a single serial coordinator, and durability comes from Reed-Solomon (10,4) with 4 KiB CRC32-C interleaving. The math behind the design holds up: 1.4× storage overhead vs 3× for mirroring, per-source reads of ~0.67 GB to evacuate a 20 TB drive, and CRC linearity over XOR that lets checksums compose with parity."
---

# TernFS: An Exabyte Filesystem Built on 256 Shards That Never Talk to Each Other

In September 2025, XTX Markets — a quant trading firm with an ML pipeline that eats petabytes — open-sourced [TernFS](https://github.com/XTXMarkets/ternfs), the distributed filesystem it built after outgrowing everything off the shelf. The numbers are serious: 500+ PB deployed across 30,000 hard disks and 10,000 flash drives in three data centres, multiple TB/s of peak throughput, a design ceiling of 10 EB and one trillion files, and — the claim that matters most for a filesystem — zero bytes lost since it entered production.

What makes TernFS worth studying isn't scale per se. It's how much *distributed-systems machinery it refuses to build*, and how each refusal is paid for by a workload constraint the designers decided they could live with.

## The workload contract

TernFS targets one workload: large immutable files, written once, read many times. The median file in XTX's deployment is 2 MB; the design assumes most bytes live in files of at least a few MB. From this contract, three simplifications fall out:

1. **Files are immutable.** A file is written completely, *then* linked into the namespace. Readers can never observe a half-written file — it's either fully there or not visible. This breaks strict POSIX semantics, but any program that writes files left-to-right and closes them works unmodified; `rsync` reportedly worked out of the box.
2. **No distributed transactions across metadata shards.** Because a file's data placement never changes after creation, the metadata layer doesn't need cross-shard coordination for the hot path.
3. **No permissions in the filesystem.** Access control is someone else's job (network layer, gateways).

Every large-scale filesystem — Colossus, Tectonic, HDFS federation — wrestles with metadata scaling. TernFS's answer is the bluntest I've seen work.

## 256 shards, zero shard-to-shard communication

All metadata — file attributes, directory listings, file-to-block mappings — lives in **256 logical metadata shards**. Each directory is assigned to a shard round-robin at creation, and every file in that directory lives on the same shard. The design's load-bearing sentence: *shards never communicate with each other*.

Operations inside one directory (create file, list, stat, unlink) hit exactly one shard. The only operations needing two shards — `mkdir`, `rmdir`, and cross-directory `mv` — funnel through a single **Cross-Directory Coordinator (CDC)** that executes transactions *serially*. The CDC tops out around 10,000 req/s while the shards collectively serve millions. That's an explicit bet: namespace mutation is rare relative to file traffic in an ML pipeline, so a serial coordinator is fine. If your workload is `mkdir`-heavy, TernFS is the wrong tool, and the authors say so.

Each shard is 5 physical instances — one leader, four followers — replicated by **LogsDB**, a purpose-built Raft-like consensus engine layered over RocksDB (the CDC and the registry, which tracks service locations and drive health, reuse the same stack). Reads and writes currently go through leaders only. The deployment arithmetic checks out neatly: ~10 metadata servers per data centre, each hosting ~25 shard leaders and ~100 followers → 10 × 25 ≈ 256 leaders, 10 × 100 ≈ 1,024 followers = 4 × 256. Ten machines per DC serving metadata for 100,000+ compute nodes.

The protocol layer is equally spartan: metadata requests ride UDP with a custom stateless serialization ("bincode"), block data rides TCP. Servers are C++; the block layer and tooling are Go; the preferred client is a Linux kernel module in C (not FUSE — though a Go FUSE client exists, needing a BPF hook to detect file closes).

## Durability: Reed-Solomon (10,4) with interleaved CRCs

Files are chopped into **spans** of at most 100 MiB, each span erasure-coded into D data + P parity blocks (policy-configurable per directory subtree; D=1 gives mirroring). XTX runs **RS(10,4)**: any 4 of the 14 blocks can vanish and the span reconstructs.

The overhead math is the standard argument for erasure coding at scale, but worth stating: RS(10,4) stores 14 blocks for 10 blocks of data — **1.4× raw overhead** versus 3.0× for triple mirroring, while tolerating four failures instead of two. At 500 PB logical, that difference is ~800 PB of drives you don't buy.

Each of the 14 blocks lands on a separate failure domain (a distinct server), placed **randomly** — TernFS deliberately skips copyset placement. Random placement is usually criticized because with enough spans, *some* span will have all its blocks on any given failing drive combination. I ran the numbers: with 30,000 drives, the probability that a specific span's 14 blocks include all of 5 simultaneously failed drives is C(14,5)/C(30000,5) ≈ 9.9 × 10⁻¹⁸. Even with 10¹¹ spans (the trillion-file ceiling), the expected number of spans lost to a 5-drive simultaneous failure is ~10⁻⁶ — the RS(10,4) margin is wide enough that copysets buy little.

What random placement *does* buy is evacuation speed. When a drive fails, its blocks' reconstruction partners are scattered uniformly across the fleet, so rebuild parallelizes over all 30,000 drives instead of a small copyset. Evacuating a 20 TB drive means each surviving drive contributes ~20 TB / 29,999 ≈ **0.67 GB of reads** — seconds of I/O per drive, minutes end-to-end, exactly what XTX reports. Copyset placement would concentrate that rebuild on a handful of drives and turn minutes into hours, with a wide window for a second failure.

Integrity is handled below the erasure code: blocks are stored as 4 KiB pages interleaved with 4-byte **CRC32-C** checksums, so partial reads verify without fetching whole blocks and drives can scrub locally. The blog notes CRCs have "useful mathematical compatibility" with Reed-Solomon — this is CRC linearity over GF(2). Concretely, for any CRC:

```python
crc(a ^ b) == crc(a) ^ crc(b) ^ crc(zeros)
```

(I verified this identity on random 4 KiB pages.) Since RS parity over GF(2⁸) is built from XORs of scaled data words, the CRC of a parity page is computable from the CRCs of the data pages — you can verify reconstruction without re-checksumming from scratch. One more nice trick: **block proofs**, AES-signed write/erase authorizations, so a buggy client can't silently corrupt or delete blocks it shouldn't.

## Deletion as a policy, not an operation

`unlink` in TernFS doesn't delete anything. It converts the directory entry into a weak "snapshot" entry; an offline Go garbage collector purges snapshots according to per-directory retention policies (which inherit down the tree, like the redundancy and drive-type policies). Fat-fingered `rm -rf` is recoverable by default, and the destructive path is a background daemon you can throttle, audit, or pause. For a firm whose files are training data that took real money to produce, making deletion asynchronous-and-reversible is arguably the highest-value feature in the system.

The same policy layer routes blocks by size: large sequential blocks (~2.5 MB+) to hard disks, small random-access blocks to flash (~5× the cost per byte as of mid-2025), with XFS's realtime facility keeping filesystem metadata itself on flash.

## What you give up

TernFS is refreshingly explicit about its non-goals, and they're the mirror image of its simplifications: no mutable files (no databases on top), no small-file workloads, no fast namespace mutation (the serial CDC), no strict POSIX, no built-in permissions, leader-only reads, and multi-region with a single metadata primary (multi-master is planned; remote writes eat a cross-region commit latency that's masked by data-write time in practice).

That list is the actual lesson. GFS made the same move in 2003 — relaxed semantics for one workload class — and a generation of systems inherited its assumptions. TernFS is what the move looks like in 2025: consensus is a commodity you layer over RocksDB, erasure coding math is table stakes, and the remaining design freedom is *choosing which operations deserve to be slow*. XTX chose `mkdir` and `mv`. For an ML data plane, that's the right sacrifice — and now the code is GPL/Apache on GitHub, kernel module included, so you can check their homework.
