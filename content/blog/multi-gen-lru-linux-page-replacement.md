---
title: "Multi-Gen LRU: How Linux Reinvented Page Replacement After Two Decades"
date: 2026-07-08
tags: ["linux", "memory-management", "kernel", "performance"]
excerpt: "Linux's legacy page reclaim scanned the entire active list to find cold pages. Multi-Gen LRU replaces that O(n) scan with generation-based aging — cutting memory-pressure stalls by 40% in real workloads."
---

For twenty years, Linux used the same page replacement algorithm: a two-list LRU with active and inactive lists, periodically scanning page table access bits to demote pages. It worked — until memory pressure under containerized, multi-tenant workloads exposed its fundamental scaling problem. In 2022, Yu Zhao's Multi-Gen LRU (MGLRU) framework landed in Linux 6.1, and by kernel 6.6–6.12 it matured into the default reclaim path for several major distributions. This post explains why the legacy approach broke, how MGLRU fixes it, and what the performance implications look like in production.

## The Legacy Two-List LRU and Its Costs

Classic Linux page reclaim maintains two LRU lists per memory cgroup and zone: **active** and **inactive**. When memory pressure rises, `kswapd` scans the active list, checks each page's access bit via `page_referenced()`, and demotes cold pages to the inactive list. Pages at the tail of the inactive list get evicted.

The problem is the scan itself. Checking access bits requires walking page table entries (PTEs) for every mapped page — a reverse-mapping walk through `rmap`. For a 64GB machine under moderate pressure, the kernel might scan millions of PTEs just to find a few thousand cold pages. This creates three concrete issues:

**O(memory) scanning cost.** The legacy algorithm's CPU consumption scales linearly with resident set size, not with the number of pages actually reclaimable. Under 80% memory utilization, `kswapd` can consume 10–15% of a CPU core just scanning.

**False demotion from access bit granularity.** The PTE access bit is binary: touched or not since last clear. A page accessed once in the last scan interval looks identical to a page accessed a thousand times. The kernel compensates with a second-chance mechanism, but it still demotes hot pages under sustained pressure.

**Lock contention on the LRU lists.** Every promotion from inactive→active or demotion from active→inactive takes the per-node `lruvec` lock. Under multi-core pressure, this lock becomes a bottleneck, serializing what should be a concurrent operation.

## MGLRU's Generation-Based Design

MGLRU replaces the two-list model with a configurable number of **generations** (typically four). Each generation represents an age cohort: generation 0 is the youngest (most recently referenced), and generation `max_seq - min_seq` is the oldest (eviction candidates). The key insight is that aging and eviction become separate, decoupled operations.

### Aging: Page Table Walks Done Right

Instead of scanning per-page rmaps, MGLRU walks **page tables directly** in a top-down fashion. The kernel iterates each mm_struct's page tables, reads access bits in bulk, and promotes pages to generation 0 if their access bit is set. This is fundamentally cheaper: a single page table walk touches the PTE once per page, while rmap-based scanning may visit the same PTE multiple times (once per VMA that maps it).

The walk is also incremental. MGLRU tracks a per-mm `walk_seq` — it doesn't re-walk a process's page tables unless the generation has advanced since the last walk. Processes that haven't been scheduled (and thus haven't accessed pages) are skipped entirely.

```c
// Simplified view of MGLRU's aging logic (mm/vmscan.c)
static void walk_mm(struct lruvec *lruvec, struct mm_struct *mm) {
    struct lru_gen_mm_walk walk = {
        .lruvec = lruvec,
        .seq = lruvec->lrugen.max_seq,  // current youngest gen
    };
    // Walk page tables top-down: PGD → PUD → PMD → PTE
    walk_page_range(mm, 0, ULONG_MAX, &lru_gen_ops, &walk);
}
```

### Eviction: Youngest Generation, Cheapest Decision

When the kernel needs to reclaim pages, it evicts from the **oldest generation** — the one whose pages have survived the most aging cycles without being re-referenced. There's no scanning decision: if a page is in the oldest generation, it's cold by definition. The eviction path becomes O(pages_to_reclaim), not O(total_resident_set).

### Generation Advancement

Generations advance when the oldest generation's population drops below a watermark or when memory pressure rises. This is where the "multi-gen" name earns its keep: with four generations instead of two lists, a page must survive multiple aging cycles before becoming an eviction candidate. A page accessed once per cycle bounces back to generation 0 each time — it never reaches the oldest generation. This provides significantly better temporal resolution than the binary active/inactive split.

```
Generation:   0 (youngest)    1              2              3 (oldest → evict)
              ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
              │ Hot pages│    │ Warm    │    │ Cooling │    │ Cold    │
              │ (recent) │    │ pages   │    │ pages   │    │ (evict) │
              └─────────┘    └─────────┘    └─────────┘    └─────────┘
                    ↑              │              │              │
                    └──────────────┴──────────────┘    aging     │
                         access bit set → promote               ↓ reclaim
```

## The Type System: Anon vs File, and Tiers Within Generations

MGLRU further subdivides each generation by **type** (anonymous pages vs file-backed pages) and by **tier** (access frequency within a generation). Tiers use the existing PTE access and dirty bits to estimate reference frequency: a page whose access bit is set every aging cycle is tier 1+, while a page caught referenced only once is tier 0.

This matters for eviction ordering. Under memory pressure, the kernel prefers evicting file-backed pages (they can be re-read from disk) over anonymous pages (they require swap writes). Within a type, lower tiers evict first. The result is a multi-dimensional priority that's far more nuanced than "bottom of the inactive list."

## Measured Impact

Google's internal benchmarks (published with the patchset) showed:

- **Chrome OS (low-memory devices):** 40% fewer out-of-memory kills and 85% fewer low-memory events under multi-tab browsing workloads.
- **Server workloads (MySQL, memcached):** 10–18% throughput improvement under memory pressure that previously triggered aggressive reclaim.
- **CPU overhead:** kswapd CPU consumption dropped by 50–70% under the same memory pressure scenarios, because the scan cost collapsed from O(resident_set) to O(reclaimed_pages).

Independent benchmarks from Phoronix (kernel 6.1–6.6) confirmed 15–30% improvement in memory-constrained workloads, with no measurable regression in memory-abundant scenarios.

## Enabling and Tuning MGLRU

MGLRU is compiled in by default since Linux 6.1 (`CONFIG_LRU_GEN=y`). Runtime control lives in debugfs:

```bash
# Check if MGLRU is enabled
cat /sys/kernel/mm/lru_gen/enabled
# Output: 0x0007 (bitmap: bit 0 = base, bit 1 = page table walks, bit 2 = working set tracking)

# Enable fully (all three features)
echo 7 > /sys/kernel/mm/lru_gen/enabled

# Tune minimum and maximum number of generations
# Higher min_ttl_ms means pages survive longer before becoming eviction candidates
echo 1000 > /sys/kernel/mm/lru_gen/min_ttl_ms
```

The `min_ttl_ms` parameter sets a floor on how long a page must be unreferenced before it can be evicted. For latency-sensitive workloads (databases, trading systems), setting this to 1000–5000ms prevents premature eviction of warm pages during burst allocations.

## Why This Matters for Containerized Workloads

Kubernetes pods with memory limits create exactly the scenario where legacy LRU thrashes. A container at 95% of its cgroup memory limit triggers constant `kswapd` scanning within that cgroup — scanning the entire resident set to find the 5% worth evicting. MGLRU's generation-based approach means the scan cost is proportional to what's actually evictable, not what's resident.

For operators running heterogeneous workloads (a JVM service next to a Redis cache next to a batch job), MGLRU's per-cgroup generation tracking means each container's memory ages independently. A Redis instance with a stable working set won't have its pages aged out just because an adjacent batch job is allocating aggressively.

## The Broader Pattern: From Scanning to Tracking

MGLRU represents a broader shift in OS design: moving from **reactive scanning** (walk the world when pressure hits) to **proactive tracking** (maintain metadata continuously so decisions are cheap when needed). The same pattern appears in modern garbage collectors (generational GC with write barriers vs stop-the-world mark-sweep) and in database buffer managers (clock-sweep with frequency counters vs pure LRU).

The Linux memory subsystem spent two decades optimizing the wrong thing — making scans faster with parallelism and batching — before MGLRU asked the right question: what if we didn't need to scan at all? The answer was 4,000 lines of code, four generations, and a page table walk that does in one pass what rmap scanning did in thousands.
