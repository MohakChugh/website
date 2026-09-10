---
title: "3FS: CRAQ Without the Tail Bottleneck, and Why Recovery Traffic Is a Block Design Problem"
date: 2026-09-10
tags: [distributed-storage, rdma, chain-replication, filesystems, ai-infrastructure]
excerpt: "DeepSeek's Fire-Flyer File System hits 6.6 TiB/s aggregate reads from 180 storage nodes — 81% of NIC line rate by my arithmetic — by combining CRAQ chain replication with a version-status twist that removes the tail's read involvement, RDMA-Read data pulls that make writes receiver-paced, and chunk placement solved as a balanced incomplete block design. My own placement sim shows why that last part matters: spreading chain membership rebuilds a failed SSD ~37x faster than fixed triples."
---

Most distributed file systems are built for one of two regimes: POSIX generality (Ceph, Lustre) or scan-heavy analytics (HDFS). AI training is neither. It's thousands of clients doing random reads over petabytes of immutable samples, checkpoint bursts that are almost purely sequential writes, and — increasingly — KV-cache offload traffic that looks like a key-value store grafted onto a file namespace. [3FS](https://github.com/deepseek-ai/3FS) (Fire-Flyer File System), open-sourced by DeepSeek in early 2025, is a from-scratch design for exactly this profile, and its headline number is startling: **~6.6 TiB/s of aggregate read throughput from 180 storage nodes, with background training traffic running concurrently**.

Before dissecting the design, it's worth checking whether that number is impressive or just big. Each storage node has 2×200 Gbps InfiniBand NICs and sixteen 14 TiB NVMe SSDs. Running the arithmetic: 180 nodes × 400 Gbps = 8.19 TiB/s of storage-side network ceiling, so 6.6 TiB/s is **81% of line rate** — the SSDs (2,880 of them, each serving ~2.35 GiB/s, roughly a third of what PCIe 4 NVMe can do on reads) are loafing, and the ~500 client nodes' NICs (11.4 TiB/s ceiling) aren't the constraint either. The system is network-bound at the storage NICs, which is where you want a storage system to be. Everything interesting in 3FS is about getting to that point and staying there.

## CRAQ, minus the tail's read job

3FS replicates chunks with [CRAQ](https://www.usenix.org/legacy/event/usenix09/tech/full_papers/terrace/terrace.pdf) (Chain Replication with Apportioned Queries), the 2009 refinement of chain replication where *any* replica can serve reads, not just the tail. The write path is classic chain replication with an RDMA twist:

1. The client sends a write to the **head** of the chain. Crucially, it sends only the request; the storage service pulls the payload itself via **RDMA Read** when it's ready. This makes writes receiver-paced — a busy target admits data at its own rate instead of getting buried by incast.
2. The head verifies the chain version, acquires a per-chunk lock (writes to one chunk serialize at the head), and stores the update as a **pending version** `u = v + 1` alongside the committed version `v`.
3. The write propagates down the chain; the **tail** commits and acks, and the ack flows back up, committing at each hop.

Standard CRAQ handles reads of a chunk with a pending version by querying the tail for the latest committed version number — the tail is the linearization point, and that version query is the price of reading from non-tail replicas. Under write-heavy load, those queries make the tail a hot spot again, which is exactly what CRAQ was trying to avoid.

3FS deletes the query. If a replica holds both a committed and a pending version when a read arrives, it returns a special status, and the client chooses: **retry** (wait for the commit) or issue a **relaxed read** that returns the pending version. That's a real semantic weakening — a relaxed read can observe data that a subsequent failure could roll back — but it's the right trade for this workload. Training samples are write-once; checkpoint files are written by one writer and read after close. The workload almost never reads a chunk that's concurrently being written, so 3FS pays for the common case (zero extra hops on reads) and pushes the rare case's complexity to the client.

## Metadata is somebody else's problem

The metadata service is stateless. All file system state lives in FoundationDB, which supplies serializable transactions, so `rename` with loop detection and `create`/`link`/`unlink` are just read-write transactions with automatic retry on conflict. Two key schemas do the work:

```text
"INOD" + inode_id (64-bit, little-endian)   -> inode attributes
"DENT" + parent_inode_id + entry_name        -> directory entry
```

Little-endian inode keys scatter adjacent inode IDs across FoundationDB's key space, spreading load; directory entries sort by parent, so `listdir` is a single range scan. Because meta services hold no state, clients connect to any of them, and the cluster manager's own configuration lives in the same key-value store — one consensus system in the entire design, and it's outsourced.

The subtle part is file length. POSIX wants `st_size` to be current, but tracking every write position through a transaction would put FoundationDB on the data path. 3FS declines: clients report max write positions every 5 seconds, lengths are eventually consistent in between, and the precise length is computed at `close`/`fsync`. Read-only opens aren't tracked at all; only write sessions are, so that deletion of an open-for-write file can be deferred to close.

## Placement: recovery traffic as a block design

Chunk placement is deterministic — chunk ID is inode ID plus chunk index, striped round-robin over a chain table and shuffled with a per-file seed — so clients compute locations locally after one layout fetch. The interesting decision is which SSDs form chains together.

The naive layout groups SSDs into fixed triples: SSD A always chains with B and C. Then when A dies, **every** rebuild read for A's data comes from B and C, and those two disks (and their nodes' NICs) are saturated for the entire multi-hour rebuild while serving foreground traffic. 3FS instead constructs the chain table so each SSD co-occurs in chains with many peers — the docs formulate it as a **balanced incomplete block design** solved with integer programming, the same combinatorial object behind experiment design and Steiner systems.

I ran a small simulation to size the effect: 96 SSDs, 10,000 chunks on the failed disk, chains of size 3. With fixed triples, each of the 2 chain-mates serves 5,000 rebuild reads. With chain membership spread randomly across peers, the *most loaded* survivor serves 136 reads — a hotspot ratio of 1.29× over the 105-read average, versus 47.5× for fixed triples, and a **~37× reduction in rebuild bottleneck time**. A true BIBD does better than my random spread: it makes co-occurrence counts exactly equal, driving the hotspot ratio to 1.0. That's the difference between "rebuild degrades two nodes for hours" and "rebuild is a rounding error on every node for minutes."

Failure handling itself stays simple because chains make it simple: the cluster manager bumps the chain version, moves the dead target to the end of the chain, and the predecessor re-forwards writes. Recovery compares chunk metadata (chain versions, committed vs. pending version numbers) and does full-chunk writes from the predecessor for anything that diverged.

## The client: io_uring's ideas, user space only

FUSE tops out around 400K 4 KiB reads/sec per node — memory copies plus lock contention on its shared request queue — which is nowhere near a 200 Gbps NIC's worth of small reads. Instead of a kernel module, 3FS embeds a native API *inside* the FUSE daemon, shaped like io_uring:

- **Iov**: a shared-memory region registered with the InfiniBand NIC, so storage services RDMA-write read results directly into client buffers. Zero copies end to end.
- **Ior**: a shared ring buffer for submissions and completions, batched by `io_depth`, with multiple rings per multi-threaded process to avoid recreating FUSE's lock contention.

Ordinary tools get POSIX through FUSE; the training data loader gets the ring. Same daemon, two doors.

## The storage engine underneath

Each SSD runs a chunk engine: fixed-size physical blocks in 11 power-of-two size classes from 64 KiB to 64 MiB, 256 pre-`fallocate`d files per class, bitmap allocation, and a RocksDB instance holding chunk metadata with an O(1) in-memory cache in front. Updates are copy-on-write into a fresh block with the metadata switch committed atomically through a RocksDB write batch — except appends, which are common enough (checkpoints, logs) to earn an in-place fast path at the block's tail.

## What generalizes

Stepping back, 3FS makes three bets that transfer beyond its own codebase. First, **strong consistency is cheap if you place its cost off the hot path**: CRAQ's write chain is fully linearizable, but the read path — the 99% path — touches exactly one replica and zero coordination, because the rare read-during-write case was demoted to a client-visible status code. Second, **receiver-paced data movement (RDMA Read pulls, request-to-send) beats sender-push under incast**, a lesson congestion-control people learned years ago that storage systems keep relearning. Third, **placement is a solved combinatorial problem if you bother to solve it** — the gap between "random-ish chains" and an integer-programmed block design is invisible on the happy path and a ~40× difference on the day an SSD dies. The GraySort result (110.5 TiB sorted in 30m14s through the file system, no shuffle service) suggests the bets compose: when the storage layer genuinely delivers line rate, layers above it can shed their own complexity.
