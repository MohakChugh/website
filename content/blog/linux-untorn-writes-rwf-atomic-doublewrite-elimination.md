---
title: "Untorn Writes: How RWF_ATOMIC Lets Databases Finally Delete the Doublewrite Buffer"
date: 2026-09-21
tags: ["linux", "storage", "databases", "nvme", "filesystems"]
excerpt: "Every serious database pays a tax for one hardware lie: a 16 KB page write can tear in the middle of a power failure, so InnoDB writes every page twice and PostgreSQL stuffs full page images into its WAL. Between Linux 6.11 and 6.16, the kernel grew a real answer — RWF_ATOMIC, a per-write torn-write guarantee negotiated through statx, backed by NVMe/SCSI atomicity limits, XFS forced extent alignment, ext4 bigalloc, and a copy-on-write software fallback when the hardware can't promise enough. This is how the whole stack fits together, and why the constraints (power-of-two, naturally aligned, direct I/O) are exactly what they are."
---

# Untorn Writes: How RWF_ATOMIC Lets Databases Finally Delete the Doublewrite Buffer

Databases have spent two decades paying protection money for a guarantee storage never gave them. A database page is 8 KB (PostgreSQL) or 16 KB (InnoDB), but the unit the disk actually promises to write atomically is a logical block — often 512 bytes or 4 KB. Lose power mid-write and you can get a *torn page*: the first 4 KB is new, the rest is old, and the page checksum fails on recovery. The WAL can't fix it, because WAL recovery assumes it can read a self-consistent copy of the page to replay records against.

The two classic workarounds are both expensive:

- **InnoDB's doublewrite buffer**: every page is written twice — first sequentially into a doublewrite area, fsynced, then to its real location. Crash mid-write to either place and recovery can find one intact copy. Cost: ~2× the page-write bandwidth.
- **PostgreSQL's full-page writes (FPW)**: the first time a page is modified after each checkpoint, the entire page image is stuffed into the WAL. In write-heavy workloads, full-page images can dominate WAL volume — which inflates not just local I/O but replication and archiving traffic too.

The irony is that flash devices usually *can* write 16 KB atomically — the flash program unit is larger than that, and vendors have shipped "atomic write" side channels for years (Fusion-io's custom API in the 2010s doubled MySQL throughput; cloud providers quietly ship storage tuned so 16 KB direct writes don't tear). But those were ad-hoc arrangements with, as Ted Ts'o put it at LSFMM 2024, "lots of sharp edges" — nothing in the kernel API ever *promised* untorn writes, so a database enabling `innodb_doublewrite=0` was gambling on undocumented behavior surviving the next firmware, kernel, or migration.

Between Linux 6.11 (September 2024) and 6.16 (July 2025), that changed. The kernel now has an actual contract.

## The contract: statx tells you, RWF_ATOMIC holds you to it

The design has two halves: discovery and request. You first ask `statx()` what the file can guarantee:

```c
struct statx stx;
statx(fd, "", AT_EMPTY_PATH, STATX_WRITE_ATOMIC, &stx);

// stx.stx_atomic_write_unit_min   e.g. 4096
// stx.stx_atomic_write_unit_max   e.g. 16384 or 65536
// stx.stx_atomic_write_segments_max  max iovecs per atomic write
```

These values are the *composed* minimum across the whole stack — device, block layer, and filesystem each clamp them. Then you issue the write with the new flag (`pwritev2()` or the equivalent io_uring flag):

```c
struct iovec iov = { .iov_base = page, .iov_len = 16384 };
ssize_t n = pwritev2(fd, &iov, 1, offset, RWF_ATOMIC);
```

The kernel guarantees the write is *untorn*: after a crash, a reader sees either all 16 KB new or all 16 KB old. Note what it does **not** guarantee — durability. `RWF_ATOMIC` says nothing about when data reaches stable media; you still pair it with `RWF_DSYNC` or a later `fdatasync()`. Atomicity and persistence are deliberately orthogonal.

The constraints fall out of how hardware atomicity works:

- **Power-of-two length** between the min and max units.
- **Naturally aligned**: a 16 KB atomic write must start on a 16 KB boundary of the file. That's what lets the filesystem map it onto device-level atomic boundaries without splitting.
- **Direct I/O only**, in practice. Buffered atomic writes are an open problem: once data sits in the page cache, writeback happens whenever the kernel likes, and nothing stops it from writing back half a logical update. The database crowd this targets (InnoDB with `O_DIRECT`) doesn't care; PostgreSQL, still buffered, has to wait for its direct-I/O future.

## What the hardware actually promises

The block layer maps `RWF_ATOMIC` onto two very different device models:

**NVMe** has no atomic-write command at all. Instead, the spec says any write of up to `AWUPF`/`NAWUPF` (Atomic Write Unit, Power Fail) logical blocks that doesn't cross an atomic boundary is *implicitly* untorn. That's elegant and slightly terrifying: the kernel can't tell the device "fail if you can't do this atomically" — it can only refuse to submit writes that exceed the advertised limits. If firmware misreports `AWUPF`, no error will ever surface. Many consumer devices report an `AWUPF` of a single logical block (512 bytes), so this whole feature is realistically an enterprise/cloud-storage play.

**SCSI** goes the other way: an explicit `WRITE ATOMIC (16)` command, with the device rejecting anything that violates its limits. Stricter, chattier, and the reason the kernel abstraction is "ask statx, obey the numbers" rather than "try it and see."

## The filesystem's job: never split the bio

A device-level guarantee is useless if the filesystem fragments your 16 KB file range into two extents 500 GB apart — the single atomic write becomes two bios and the guarantee evaporates. So each filesystem had to grow allocation discipline:

- **XFS (6.13)** shipped initial support, limited to one filesystem block per atomic write, riding on the large-block-size work from 6.12. To get 16 KB atomic writes you formatted with 16 KB blocks. A `FORCEALIGN` inode flag forces extent alignment so a file's blocks never straddle an atomic boundary.
- **ext4 (6.14)** followed with the same single-fsblock model.
- **Linux 6.16** made it real for normal configurations: XFS gained *large atomic writes* (multiple filesystem blocks per atomic write), and ext4 gained multi-fsblock atomic writes on **bigalloc** filesystems, where allocation happens in aligned multi-block clusters — bigalloc, ironically a 2011 feature almost nobody used, turns out to be exactly the allocation-alignment machinery untorn writes need.

The most interesting piece is XFS's **software fallback**. If a file's extents are laid out such that a requested atomic write *can't* be issued as one hardware-atomic bio (misaligned, discontiguous, or larger than the device unit), XFS doesn't fail the write — it falls back to an out-of-place copy-on-write: write the new data to freshly allocated blocks, then commit the extent remap in the journal. The remap commit is itself atomic, so the userspace guarantee holds even when the hardware one doesn't. You get a bimodal latency profile — fast path when alignment cooperates, CoW path when it doesn't — which is why `statx` reporting and careful file preallocation still matter. The guarantee is constant; the cost isn't.

## Why this is worth a senior engineer's attention

The performance argument is blunt: cloud vendors' ad-hoc torn-write-safe setups yielded 60–100% database throughput improvements just from dropping doublewrite, per numbers cited at LSFMM. For PostgreSQL, full-page images are frequently the *majority* of WAL bytes; eliminating them (once direct I/O lands) shrinks WAL, replication, and archive volume in one move.

But the design lesson generalizes beyond databases. This is a textbook case of turning folklore into API:

1. **Capability discovery over configuration** — statx reports a negotiated property of the entire stack, not a device datasheet number.
2. **Constrain the API to what composes** — power-of-two, natural alignment, and segment limits look restrictive, but they're precisely the invariants every layer (page cache folios, extent allocators, NVMe boundaries) can maintain without coordination.
3. **Guarantee at the top, fall back below** — the CoW path means the contract userspace sees is unconditional, while the fast path remains opportunistic.

For fifteen years the answer to torn pages was "write everything twice and hope." As of 6.16, on XFS or bigalloc ext4 with a device that reports honest atomic limits, the answer is a flag.
