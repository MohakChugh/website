---
title: "DAMON: Monitoring Terabytes of Memory for the Price of 1,000 PTE Checks"
date: 2026-08-18
tags: ["linux", "memory-management", "kernel", "observability", "performance"]
excerpt: "Linux's DAMON answers 'which memory is cold and for how long' at an overhead set by a region count, not by memory size. I simulated its adaptive region sampler and found the case where its own auto-tuner reports healthy while the access map is noise."
---

Every memory optimization worth doing starts with the same question: which pages are hot, which are cold, and for how long. Answering it the obvious way costs O(memory). Idle page tracking makes you clear and re-read the Accessed bit of every PFN through `/sys/kernel/mm/page_idle/bitmap`, and reclaim's own `rmap` walks scale with resident set size. Multi-Gen LRU fixed the aging path, but MGLRU is a reclaim policy, not an observability tool: you cannot ask it "how many gigabytes in this container have been untouched for two minutes."

DAMON, the Data Access MONitor merged into Linux 5.15 and heavily extended through the 2025 kernels, answers that question at an overhead you choose in advance, independent of how much memory you are watching. The mechanism is worth understanding precisely, because its accuracy guarantee is statistical and the failure mode is silent.

## Region-based sampling

DAMON's core insight is to stop treating pages as the unit of observation. A `kdamond` kernel thread maintains a list of **regions**, contiguous address ranges presumed to share an access frequency. Once per **sampling interval** (default 5 ms) it picks *one random page per region*, checks and clears its Accessed bit, and re-checks it one period later. Once per **aggregation interval** (default 100 ms) it publishes each region's `nr_accesses`, resets the counters, and reshapes the region list.

The cost model falls out of that. With `A = aggregation / sampling` samples per interval and `R` regions, one aggregation costs `R * A` page table checks. Region count is bounded by user-set `min_nr_regions` and `max_nr_regions` (commonly 10 and 1000), so overhead is capped by configuration, not capacity. Watching 4 GiB and watching 4 TiB cost the same.

That bound buys you a noisy estimator. If a fraction `p` of a region's pages are touched within one sampling interval, `nr_accesses` is approximately `Binomial(A, p)`, so its relative standard error is `sqrt((1 - p) / (A * p))`. At the default `A = 20`:

| true `p` | rel. std. error of `nr_accesses` |
|---|---|
| 0.9 | 7.5% |
| 0.5 | 22.4% |
| 0.1 | 67.1% |

Cold regions are where the estimator is worst, which is precisely where proactive reclaim wants to act. So comparisons between regions need headroom, thresholds like "age above 30 s" beat "nr_accesses of 3 versus 4", and regions must be *homogeneous*, because a region mixing hot and cold pages returns the mixture's mean and nothing else.

## Adaptive region adjustment as online segmentation

Homogeneity is searched for, not given. Every aggregation interval DAMON runs a merge and split pass:

1. Merge two adjacent regions if their `nr_accesses` differ by no more than a threshold *and* their combined size is below `total_size / min_nr_regions`, so merging cannot produce one giant blind region.
2. If the count still exceeds `max_nr_regions`, repeat with a rising threshold, up to the maximum possible value `A`.
3. Split each surviving region into two or three, budget permitting.

Split explores, merge exploits. The system hill-climbs toward a partition whose boundaries coincide with the workload's access boundaries. Each region also carries an `age` counter, incremented per aggregation and reset whenever size or `nr_accesses` changes significantly, which is what makes "untouched for 120 seconds" expressible at all.

I implemented the loop against a synthetic 4 GiB space of 4 KiB pages, 205 MiB of hot working set in 8 contiguous blocks, `p_hot = 0.9`, `p_cold = 0.002`, defaults of 5 ms / 100 ms, `min/max` regions 10 and 1000. Classifying a region as hot when `nr_accesses >= A/2`, scored against ground truth:

| aggregation | regions | flagged | precision | recall |
|---|---|---|---|---|
| 1 | 10 | 0.0 MiB | 0% | 0% |
| 5 | 54 | 199.5 MiB | 75.9% | 73.9% |
| 20 | 942 | 204.5 MiB | 99.9% | 99.8% |
| 60 | 677 | 204.5 MiB | 99.9% | 99.8% |

Convergence is not instant: the first snapshot is useless, because ten 400 MiB regions each sample one page out of 5 percent hot content. It takes roughly 20 aggregations, 2 seconds at defaults, to resolve the boundaries, after which the estimate is essentially exact. The price is at worst 20,000 PTE checks per aggregation against 1,048,576 pages for one full idle-page-tracking sweep, 53 times fewer, and that ratio is linear in capacity: on a 4 TiB host the same configuration is roughly 54,000 times cheaper than a full scan.

## Where the auto-tuner cannot help you

Linux 6.15 added monitoring-interval auto-tuning. You give DAMON `access_bp`, a target ratio of observed access events to the theoretical maximum, and it scales both intervals to hit it. Observed events for a region are `size * nr_accesses`; the theoretical maximum substitutes `A` for `nr_accesses`. The recommended target is 4 percent, justified as Pareto applied twice: 20 percent of 20 percent of the budget should capture 80 percent of 80 percent, or 64 percent, of real accesses.

I reran the simulation with one change: the same 5 percent hot set scattered uniformly at page granularity instead of in blocks.

| aggregation | regions | flagged | precision | recall | samples ratio |
|---|---|---|---|---|---|
| 5 | 70 | 0.0 MiB | 0% | 0% | 4.18% |
| 20 | 988 | 0.1 MiB | 58.1% | 0.0% | 3.67% |
| 60 | 870 | 0.9 MiB | 63.7% | 0.3% | 5.35% |

After 6 seconds, recall is 0.3 percent. The access map is worthless, because no contiguous region is homogeneous and merging cannot find a boundary that does not exist. Meanwhile the samples ratio that interval auto-tuning optimizes straddles the recommended 4 percent target the entire time. **`access_bp` measures access volume, not region homogeneity, so a perfectly tuned interval is compatible with a completely uninformative region map**, and nothing in that control loop can detect it.

The tell is cheap to check: if `nr_regions` pins to `max_nr_regions` while the total size of hot-classified regions is on the order of `nr_regions * PAGE_SIZE`, DAMON is reporting sampling noise, not a working set. Workloads with 2 MiB THP mappings or slab-backed arenas are homogeneous by construction; pointer-chasing over a fragmented malloc heap is the adversarial case.

## DAMOS: the policy engine on top

DAMOS attaches schemes of the form "for regions matching this access pattern, apply this action," with actions including `pageout`, `hugepage`, `collapse`, `lru_prio`, `lru_deprio`, `migrate_hot`, `migrate_cold`, and `stat`. Every action except `stat` resets the region's age, which prevents thrashing the same region every interval.

The parts that make this production-safe are the throttles. A **quota** bounds both the time and the bytes a scheme may spend per reset window. When a quota binds, **prioritization** ranks colder regions first for `pageout` and warmer ones first for `migrate_hot`. **Watermarks** deactivate schemes outside a band, and if every scheme is deactivated the thread stops monitoring and only polls watermarks, at near-zero overhead.

The built-in proactive reclaim module wires all of this to boot parameters or sysfs:

```sh
cd /sys/module/damon_reclaim/parameters
echo 30000000 > min_age                       # 30 s idle counts as cold
echo $((1 * 1024 * 1024 * 1024)) > quota_sz   # at most 1 GiB per window
echo 1000 > quota_reset_interval_ms
echo 500  > wmarks_high                       # idle above 50% free
echo 400  > wmarks_mid                        # active below 40% free
echo 200  > wmarks_low                        # below 20%, let LRU reclaim own it
echo Y    > enabled
```

Defaults are conservative: `min_age` 120 s, `quota_ms` 10 ms, `quota_sz` 128 MiB per 1 s window.

The most interesting recent addition is **quota auto-tuning**: instead of a fixed budget you declare a target metric and value, and DAMOS raises the quota while under-achieving and lowers it while over-achieving. Setting `quota_mem_pressure_us` makes the loop self-referential in a useful way, since DAMOS measures system-wide `some` memory PSI stall time per reset window and reclaims harder only while the system is not stalling. Other goal metrics include `node_mem_used_bp`, `node_memcg_free_bp` and `active_mem_bp`, all in basis points, plus `user_input` for feeding your own SLO signal such as p99 latency. The `consist` algorithm seeks a steady optimum, while `temporal` drives the maximum allowed quota until the goal is met and then drops to zero. This is the control problem userspace PSI-driven reclaimers solve by binary-searching a reclaim rate, with one advantage: DAMON already knows *which* memory is coldest, so the quota only decides how much to act on.

## Practical sequence

Start with the `stat` action and read `nr_tried` and `sz_tried` to learn how much of your footprint is genuinely idle at your candidate `min_age`. Sanity-check region count and hot-region sizes against the noise signature above before trusting any of it. Only then attach `pageout` behind a quota, preferring a PSI goal over a fixed byte budget so the loop backs off when refaults start costing more than the reclaimed pages save.

The deeper lesson generalizes past the kernel. DAMON converts an O(memory) measurement problem into an O(regions) one by assuming spatial locality, then spends its entire design budget on adaptively validating that assumption. When the assumption holds, you get a 4 TiB access map for the cost of a thousand PTE reads. When it does not, the machinery keeps reporting healthy numbers, and only ground truth you collect yourself will tell you.
