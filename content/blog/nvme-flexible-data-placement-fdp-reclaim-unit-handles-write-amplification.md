---
title: "NVMe Flexible Data Placement: Why WAF 1.0 Is a Best Effort, Not a Guarantee"
date: 2026-07-26
tags: [storage, nvme, ssd, write-amplification, systems]
excerpt: "FDP gives the host eight tags to steer writes into physically separate NAND regions, and the pitch is write amplification approaching 1.0 with no application rewrite. The FAST '26 characterization of two shipping FDP drives found the same workload hitting 1.03 on one device and 3.12 on another, both advertising FDP support. The failures are structural: a noisy handle propagates GC pressure to its neighbors, long sequential streams get reclaimed prematurely, and F2FS tags 99% of user data with a single hint that collapses the whole interface back to a conventional SSD."
---

Every flash device lies to you about how much you wrote. You issue 1 TB of host writes, the FTL relocates valid pages during garbage collection, and the NAND absorbs 2 or 3 TB. That ratio is the write amplification factor, and it sets SSD endurance, replacement cost, and the embodied carbon of a fleet. At hyperscale, moving WAF from 1.8 to 1.1 is worth millions in deferred replacement.

The root cause is a mismatch the block interface makes unfixable: the device groups logical blocks into erase units by arrival order, while the host knows which blocks share a lifetime. A cache index rewritten every ten seconds lands in the same superblock as an immutable segment file, and when the index dies the device relocates the segment to free the space.

Open-Channel SSDs and ZNS fixed this by handing control to the host, one exposing raw channels and dies, the other replacing the namespace with append-only zones. Both work, and both require rewriting your storage engine, which is why neither shipped broadly. [Flexible Data Placement](https://nvmexpress.org/nvmeflexible-data-placement-fdp-blog/), ratified as NVMe TP4146 and pushed by Google and Meta, takes the opposite bet: keep the block interface, keep GC device-managed, add nothing but a tag on the write command. That compatibility is why FDP has traction, and the source of every problem below.

## The three abstractions

A **Reclaim Unit (RU)** is the GC granularity, typically one NAND superblock, shipped at 128 MB to 512 MB. A **Reclaim Group (RG)** is a set of RUs managed together, usually by die. A **Reclaim Unit Handle (RUH)** is an identifier the host puts in the write command's directive field; same-handle writes land in the same RU. Both drives below expose exactly eight. That is the entire interface: eight buckets with physical locality inside each.

```bash
nvme fdp configs /dev/nvme0 --endgrp-id 1     # geometry: RU size, RUH count, II or PI
nvme fdp status  /dev/nvme0 --namespace-id 1  # per-handle host bytes
```

The critical subtlety is what happens to the tag during GC, and the spec allows two answers. **Initially Isolated (II)** handles honor the tag for host writes only: GC copies go into one shared GC handle and the identity is discarded. **Persistently Isolated (PI)** handles keep a per-RUH GC write pointer, so relocated data stays in its source handle.

```
II:  host write(tag=γ) → RUH γ;  GC copy → GC-RUH  # tag dropped, pool shared
PI:  host write(tag=γ) → RUH γ;  GC copy → RUH γ   # tag kept, pool partitioned
```

II is nearly free to bolt onto a legacy FTL, which is why every shipping device implements it. Note what neither mode gives you: a guarantee. FDP is a hint. GC policy, victim selection, RU sizing, and OP ratio are fixed at manufacturing time and invisible to the host.

## What two shipping drives actually do

Song et al. at FAST '26 ([Characterizing and Emulating FDP SSDs with WARP](https://www.usenix.org/system/files/fast26-song.pdf)) ran the first cross-device study: a 7.68 TB U.3 drive and a 3.84 TB E1.S drive, both PCIe Gen5, NVMe 2.1, eight RUHs, roughly 5 GB/s sequential write. A single stream of 128 KB random writes into one RUH, just conventional SSD behavior, plateaus at WAF 2.0 on Device A and 3.5 on Device B. Same workload, same interface, 75% apart, entirely from undisclosed geometry.

Now the case FDP was built for. Three streams, sequential plus random plus a Zipfian-skewed overwrite, each on its own handle:

| Workload | Device A, no FDP | Device A, FDP | Device A, misclassified | Device B, FDP |
|---|---|---|---|---|
| Zipf α=2.2 | 1.60 | **1.03** | 1.03 | 1.29 |
| Zipf α=1.2 | 1.81 | **1.04** | 1.67 | 1.45 |
| 80/20 | 2.09 | **1.69** | 2.08 | **3.12** |

The Zipfian columns are the marketing case, and they are real: 1.60 down to 1.03. The other two are the story. The misclassified column maps the sequential and overwrite streams to one handle, modeling a static assignment that does not track temperature. Under strong skew it costs nothing, because the overwrite stream self-invalidates in place. Under α=1.2 it costs the entire benefit: 1.04 becomes 1.67, back to baseline. FDP's gain is bounded by your classifier's accuracy, and nothing tells you the classifier is wrong.

The 80/20 column is worse, because nothing there is misclassified. But 80% of accesses over 20% of the LBA space produces invalidations broad enough that GC cannot find a cheap victim, and Device B reaches 3.12. Replace the overwrite stream with uniform random invalidation and the interface stops mattering: 2.58 on A, 4.49 on B, correctly configured.

## Noisy RUH: isolation is not isolation

The per-handle breakdown, only visible through the paper's emulator, is where the mental model breaks. In the three-stream workload, RUH 0 carries the sequential overwrite stream and absorbs 88% of host writes, while RUH 1 (random) and RUH 2 (invalidation) each take 5 to 6%. Under Zipfian skew, amplification tracks volume. Under 80/20, it appears in handles whose traffic never changed: RUH 1 jumps to 26% of total amplified bytes and RUH 2 to 14%. RUH 2's invalidation pattern forces more aggressive global GC, and that pressure raises the WAF of an unrelated handle. The authors name this **Noisy RUH**, and it reproduces on both drives. Handles share a spare pool, a channel budget, and a GC scheduler, so a tenant can degrade its neighbors without touching their address space. FDP isolates placement, not consequences.

The second undocumented behavior is **Save Sequential**: the capacity-dominant sequential handle contributed the largest single share of amplification despite writing data that should self-invalidate cleanly. Limited OP plus greedy victim selection make the device reclaim those RUs before the overwrite that would have freed them lands. The long sequential stream every engine assumes is safe is not.

## The II/PI crossover

Intuition says PI dominates: strict isolation should beat dropping the tag. The emulator sweep says otherwise, and the deciding variable is over-provisioning. Under 80/20 with 256 MB RUs, II wins at 3% OP (2.92 vs 3.81) and 5% (2.19 vs 2.37), then loses at 10% (1.34 vs 1.18) and 14% (1.09 vs 1.06).

PI partitions the spare pool per handle. Under a tight OP budget that starves every handle at once and triggers constant GC, so PI's fragmentation penalty exceeds its isolation benefit; II pools spare capacity in the shared GC handle. The crossover sits at 7 to 9% OP for 256 MB RUs and 5 to 7% for 128 MB RUs. PI's floor is lower, but it only gets there with slack and accurate classification.

## The F2FS null result

F2FS already classifies data by type and temperature and maps those classes onto six write hints, which the kernel patches translate into RUH IDs. It looks like the ideal FDP consumer. Filebench Fileserver, 200 threads, 10 hours, 28 TB written: WAF 2.3 to 2.5 on both drives, FDP enabled and disabled. Zero improvement.

An eBPF trace of the hint distribution explains it. F2FS labels 99% of user data WARM, which maps to `WRITE_LIFE_NOT_SET`, funnelling nearly every user write into one handle. Node and metadata segments get separate handles, but that is not where the amplification lives. The interface was wired up correctly; the outcome was a conventional SSD.

```c
/* Plumbing that compiles and does nothing: every object, same hint */
fcntl(fd, F_SET_RW_HINT, &(uint64_t){RWH_WRITE_LIFE_NOT_SET});

/* What FDP needs instead: a lifetime estimate with real spread */
static int ruh_for(const struct object *o) {
    if (o->size < SMALL_OBJ)      return RUH_SMALL;
    if (o->overwrite_rate > HOT)  return RUH_HOT;
    if (o->immutable)             return RUH_SEALED;
    return RUH_WARM;
}
```

Contrast CacheLib, which splits small objects (BigHash, 4 KB buckets rewritten wholesale) from large ones (BlockCache, 16 MB log-structured appends) architecturally, and maps those engines to two handles. At 40% of capacity given to the small-object cache, WAF drops from 1.85 to 1.27 and hit ratio rises from 61% to 82%, so the usual endurance-versus-hit-rate tradeoff disappears. That is not FDP being clever. It is FDP finally being told something true, by an engine that had already separated lifetimes for its own reasons.

## What this means if you are building on it

FDP's value is real and bounded. Benign workloads do not regress when you enable it, and under co-located traffic it held a noisy-neighbor scenario to 2.6 where the baseline hit 3.0. But near-1.0 is an upper bound conditional on three things you must verify yourself: your classifier spreads objects across handles with genuinely distinct lifetimes, your OP budget matches the device's isolation mode, and your access pattern is skewed rather than uniformly invalidating. Host bytes versus media bytes is the only ground truth. The paper's emulator is upstreamed into [FEMU](https://github.com/MoatLab/FEMU), currently the only way to see per-handle GC dynamics or evaluate PI mode at all.

The lesson generalizes past flash. FDP moved a policy decision, lifetime classification, from device to host without moving the mechanism, garbage collection, with it. The host holds authority it cannot verify and the device keeps control it cannot explain. Every hint-based interface has this shape, and two failure modes: a hint that is silently wrong, and a hint that is correct but insufficient.
