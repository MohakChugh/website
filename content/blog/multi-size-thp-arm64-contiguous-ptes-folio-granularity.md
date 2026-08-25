---
title: "Multi-Size THP: Escaping the 4K-or-2M Cliff in Linux Memory Management"
date: 2026-08-26
tags: [linux-kernel, memory-management, arm64, performance, tlb]
excerpt: "For twenty years Linux gave you two page sizes: 4K, or a 2M hugepage that inflates a lightly-touched heap by up to 100x. Multi-size THP fills in the orders between them — and on arm64, the contiguous PTE bit turns 16 page table entries into one TLB entry. The interesting engineering is in the access/dirty bits."
---

A 1024-entry L2 dTLB backed by 4K pages covers 4 MiB. That is the entire translation reach available to a process whose heap is 40 GiB. Every miss beyond it is a page-table walk: up to four dependent memory accesses, each of which can itself miss in cache.

The classic fix is a 2 MiB PMD-mapped hugepage, which lifts reach to 2 GiB. But the granularity is brutal. Touch one byte of a fresh 2 MiB region and you have committed 2 MiB of physical memory, zeroed all of it in the fault handler, and put a 2 MiB object in front of the reclaim subsystem that can only be swapped as a unit. For a workload that touches 1% of its address space at random, the resident-set amplification is bounded by 1/p — and it gets there:

```python
def amplification(p, pages_per_folio):
    """RSS multiplier vs 4K granularity when a fraction p of 4K pages is touched
    uniformly at random. A folio is resident if any of its pages is touched."""
    occupied = 1 - (1 - p) ** pages_per_folio
    return occupied / p

# p=0.01 →  16K: 3.94x   64K: 14.85x   2M: 99.42x
# p=0.05 →  16K: 3.71x   64K: 11.20x   2M: 20.00x
# p=0.25 →  16K: 2.73x   64K:  3.96x   2M:  4.00x
```

So the useful sizes are the ones nobody could allocate: 16K, 32K, 64K. **Multi-size THP** (mTHP), merged in Linux 6.8, allocates them.

## Folios made intermediate orders expressible

The precondition was Matthew Wilcox's folio conversion. Before it, "a compound page of order 4" was something the page cache understood but the anonymous fault path did not; `do_anonymous_page()` allocated one `struct page` and installed one PTE. The 6.8 series (commits `19eaf44954df`, `3485b88390b0` and friends) taught the fault path to allocate an order-*k* folio and map all 2^*k* pages in one shot, via the batched `set_ptes(mm, addr, ptep, pte, nr)` interface that replaced repeated `set_pte_at()` calls.

Order selection at fault time is deliberately conservative. The kernel walks enabled orders from largest to smallest and takes the first that satisfies:

1. The naturally-aligned range of 2^*k* pages containing the faulting address lies entirely inside the VMA.
2. Every PTE in that range is empty — no partial overlap with existing mappings.
3. The order is enabled for this VMA's mode (`always`, or `madvise` with `MADV_HUGEPAGE`).

Condition 1 is why mTHP does nothing for a program that `mmap()`s in 8 KiB chunks: no aligned 64K window fits. Condition 2 is why it degrades over a process's lifetime as the address space gets pockmarked — the fallback is silent, and you have to go looking for it.

These are not PMD entries. A 64K mTHP folio is still sixteen ordinary PTEs pointing at sixteen consecutive PFNs. The win, on x86-64, is entirely in software: one fault instead of sixteen, one `folio_add_new_anon_rmap()` instead of sixteen rmap insertions, one refcount, and — after the 6.9 "optimize fork() with PTE-mapped THP" and "optimize unmap/zap" series — batched copy and teardown that touches the folio's mapcount once per range rather than once per page. Populating 1 GiB drops from 262,144 faults to 16,384.

What it does *not* buy on x86 is TLB reach. Sixteen PTEs are sixteen translations.

## The arm64 contiguous bit, and why it's hard

arm64 page table entries have a *contiguous* bit. Set it on all sixteen PTEs of an aligned 64K block whose PFNs are consecutive and whose attributes are identical, and the MMU is permitted to cache the whole block in a single TLB entry. Reach goes from 4 MiB to 64 MiB on the same 1024-entry TLB — a 16× improvement with no change to the page table format the kernel already maintains.

Linux 6.9 landed "Transparent Contiguous PTEs for User Mappings" (16 commits from `311a6cf29690`), which sets that bit opportunistically in `arch/arm64/mm/contpte.c` without exposing it to generic MM at all. Generic code still believes it is manipulating sixteen independent PTEs. arm64 maintains a *folded* representation underneath and unfolds it whenever the illusion is about to break:

```c
/* Semantics maintained by the arm64 contpte layer. CONT_PTES == 16 at 4K base. */

set_ptes(mm, addr, ptep, pte, 16);   /* aligned, contiguous PFNs, same prot
                                        → fold: install 16 PTEs with PTE_CONT set */

ptep_set_wrprotect(mm, addr, ptep + 3);
/* One entry in the block must diverge. The contiguous bit now describes a lie,
 * so: unfold first — clear PTE_CONT across all 16, TLB-invalidate the range,
 * then apply the single-entry change. */
```

The genuinely subtle part is access and dirty state. Hardware is allowed to record a young or dirty event *anywhere* in a contiguous block — the architecture says the bits apply to the block, not the entry. So a naive `ptep_get()` on entry 7 can return "not young" while entry 0 carries the young bit the hardware set on behalf of a store to entry 7. Reclaim would then conclude that a hot page is cold and evict it.

`contpte_ptep_get()` therefore aggregates: it reads all sixteen entries and ORs their access and dirty bits into the value it returns for any one of them. `contpte_ptep_test_and_clear_young()` and `contpte_ptep_get_and_clear_full()` do the mirror-image work on the write side, clearing state across the block and returning the union. This is why `ptep_get()` — previously a plain pointer dereference — became a real function call on arm64, and why the series had to convert the tree's open-coded `*ptep` reads first. It also means a young-bit sweep over a contpte-mapped range does 16× the loads it used to, which is a cost the aggregate TLB win has to cover.

The contiguous bit is also purely a hint. Some implementations coalesce, some ignore it; there is no way to ask, and no correctness dependency either way.

## Fragmentation is the real cost

The table at the top is not hypothetical. The kernel's own documentation warns that a large `mmap()` touched at one byte can consume the whole hugepage "for no good," and this is precisely why PMD-size defaults to `enabled="inherit"` while **every other order defaults to `never`**. mTHP is opt-in per size:

```bash
# Enable only 64K — the size the arm64 contiguous bit can actually coalesce
echo madvise > /sys/kernel/mm/transparent_hugepage/hugepages-64kB/enabled
echo never   > /sys/kernel/mm/transparent_hugepage/hugepages-32kB/enabled

# Or at boot, with range syntax:
#   thp_anon=16K-64K:always;128K,512K:inherit;256K:madvise;1M-2M:never
```

Any size absent from `thp_anon=` becomes `never`, and a valid setting overrides the PMD default. Settings apply only to future faults — including regions already registered with khugepaged — so a rollout means restarting the workload, not just writing sysfs.

Then instrument it. Every size exports counters:

```bash
S=/sys/kernel/mm/transparent_hugepage/hugepages-64kB/stats
grep . $S/{anon_fault_alloc,anon_fault_fallback,split_deferred,nr_anon,nr_anon_partially_mapped}
```

The two that matter for tuning are `anon_fault_fallback` — the fault wanted this order and had to drop to a smaller one, meaning either address-space fragmentation or physical-page fragmentation (cross-check `compact_stall` / `compact_fail` in `/proc/vmstat`) — and `nr_anon_partially_mapped`, which counts folios the kernel believes are wasting memory. Those land on the deferred-split list; with `shrink_underused` enabled, a folio whose zero-filled pages exceed `max_ptes_none` gets split under memory pressure, and `thp_underused_split_page` in `/proc/vmstat` tracks how often that fires. Per-process attribution comes from `tools/mm/thpmaps`, added in 6.9.

One caveat on swap: `swpout` counts folios written out whole, `swpout_fallback` counts folios split first. A large folio that must be split to swap gives back most of what it earned.

## What changed conceptually

Page size stopped being a binary. It is now a per-VMA, per-order policy decision with a measurable cost function: TLB reach and fault-count savings on one side, `amplification(p, 2^k)` on the other, where *p* is your workload's access density — something you can actually measure with `thpmaps` before you pick an order. The reason 64K is the interesting default on arm64 and 16K is often the right answer on x86-64 is not folklore; it falls out of that trade, with the contiguous bit adding a 16× reach term to only one side of it.
