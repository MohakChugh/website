---
title: "Go's Swiss-Table Maps Under Churn, Audited: Pruning Stopped the Doubling, but Tables Above ~62% Load Still Double and Misses Run 2× Slower"
date: 2026-11-04
tags: ["go", "hash-tables", "swiss-tables", "runtime", "performance"]
excerpt: "Go 1.24 replaced its bucket maps with Swiss tables split into 1024-slot tables under an extendible-hashing directory. It can't rehash in place, so delete/insert churn at constant size doubled maps (issue #70886). Go 1.25 added tombstone pruning. I read the code and churned maps of 1k to 1M keys on 1.24.0 and 1.27.3. Pruning keeps memory flat for maps that start below about 62% table load. At 64% and above, a table doubles anyway (6/6 seeds), which covers about half of all map sizes. Tombstones still hold 20–31% of slots, miss lookups probe 2.4–2.5 groups instead of 1.1–1.7 and take 1.7–2.2× as long, and since 1.25 maps.Clone copies the tombstones over unchanged."
---

# Go's Swiss-Table Maps Under Churn, Audited: Pruning Stopped the Doubling, but Tables Above ~62% Load Still Double and Misses Run 2× Slower

Go 1.24 (February 2025) replaced the runtime's bucket maps with a Swiss table: 8-slot groups, an 8-byte control word holding 7 hash bits (H2) per slot, and quadratic probing over groups driven by the other 57 bits (H1). Go adds one layer. A table never exceeds **1024 slots**; above that, the top hash bits pick a table from an **extendible-hashing directory**, so a grow rehashes at most 896 entries.

Go's iteration rules (mutation allowed during `range`, no entry returned twice) rule out the standard Swiss-table **rehash in place**, which reorders slots to clear tombstones. The runtime says so (`table.go`, `rehash`): *"it is unclear how to make rehash in place work with iteration."* This post measures what that costs a long-lived map with constant size and constant churn: a session table, an LRU index, a dedup window.

## The mechanism: tombstones spend the growth budget

Lookups stop at the first group that has an empty slot. So a delete from a full group can't leave an empty slot behind:

```go
// internal/runtime/maps/table.go, (*table).Delete
if g.ctrls().matchEmpty() != 0 {
    g.ctrls().set(i, ctrlEmpty)   // group had a hole: probe chains already end here
    t.growthLeft++
} else {
    g.ctrls().set(i, ctrlDeleted) // full group: leave a tombstone, budget NOT refunded
}
```

A full group stays full until the table is rebuilt, and `growthLeft` (starting at 7/8 of capacity) counts tombstones as occupied. An insert reclaims a tombstone only if one sits on its own probe path, so under churn `growthLeft` eventually reaches 0.

**Go 1.24.0** always calls `rehash` at that point. Below 1024 slots that doubles the table; at 1024 it splits the table in two. Issue [#70886](https://github.com/golang/go/issues/70886) showed a 14-key map growing from 128 slots to 1024. My rerun on go1.24.0 grew a 56-key, 128-slot map to 512 slots within 100k cycles; go1.27.3 kept it at 128. The maintainers expected the growth to be logarithmic, since each doubling makes the next one harder to reach.

**Go 1.25.0** added `pruneTombstones`, which runs before any rehash. It walks every live key's probe sequence and marks each tombstone group the key passes through before reaching its home group. It then clears the tombstones in all unmarked groups. There are two 10% gates:

```go
if t.tombstones()*10 < t.capacity { return } // < 10% tombstones: grow instead
...
if cnt*10 < int(t.capacity) { return }       // < 10% removable: grow instead
```

## Measurement

Setup: Apple M3 Pro, official go1.24.0 and go1.27.3 darwin/arm64 toolchains, `map[uint64]uint64`, random keys. Each cycle deletes a random live key and inserts a fresh one, so `len(m)` never changes. I read the runtime's `Map` and `table` structs via `unsafe` (same prefix layout in both versions) for exact per-table `capacity`, `used` and tombstones (`7/8·capacity − used − growthLeft`), and computed from the control words the exact mean groups a miss probes:

```go
for st := 0; st < ng; st++ {            // every possible H1 start group
    off, n := st, 1
    for idx := 1; full[off]; idx++ {    // a group with no ctrlEmpty byte doesn't stop a probe
        off = (off + idx) & (ng - 1)    // Go's triangular probe sequence
        n++
    }
    sum += float64(n)
}
```

Here are 100·n churn cycles, with stats averaged over the second half. Latency is the best of 7 rounds of about 2M random lookups, run twice, compared against a map freshly built from the same keys:

| live keys | fresh cap | 1.24.0 cap | 1.27.3 cap | 1.27.3 tombstones | miss probe (groups), churned vs fresh | miss ns, churned vs fresh |
|---|---|---|---|---|---|---|
| 1,000 | 2,048 | 4,096 (2.0×) | 2,048 (1.0×) | 23.9% | 2.44 vs 1.07 | 30.1 vs 13.8 |
| 10,000 | 16,384 | 34,816 (2.1×) | 20,480 (1.25×) | 19.5% | 2.50 vs 1.17 | 34.8 vs 17.7 |
| 100,000 | 131,072 | 524,288 (4.0×) | 262,144 (2.0×) | 31.3% | 2.47 vs 1.65 | 85 vs 40 |
| 1,000,000 | ≈2.09M | 4,194,304 (2.0×) | 2,097,152 (1.0×) | 24.8% | 2.44 vs 1.05 | 157–210 vs 94 |

Pruning works as a memory fix. Go 1.24.0 ended at 2–4× the fresh footprint at every size; 1.27.3 stayed at 1.0× for 1k and 1M keys. A 100M-cycle 10k-key run reached 32 tables within 10M cycles and stayed there.

What pruning does not do is keep the map *clean*. On 1.27.3, tombstones held a steady 20–31% of all slots. A miss probes about 2.45 groups, against 1.05–1.65 for a fresh map, and takes 1.7–2.2× as long. Hits barely change (16.2 vs 15.4 ns at 1k keys), because a hit stops as soon as it finds its key instead of walking to an empty slot. Inserting a *new* key is a miss followed by a store, so the churn workload pays this cost on every insert. At 1k keys the bloated 1.24.0 map served misses faster than 1.27.3 (19.3 vs 30.1 ns): one spends memory, the other probe length.

A sawtooth explains the level. Logged prune events at n=1000 fired with tombstones at 38.3% of capacity and cut them to 2.8%. The ceiling is 7/8 − load, so a table with *fewer* live keys holds *more* tombstones before cleanup, and the average lands near the midpoint.

## The cliff the 10% gates create

The first gate yields a hard bound. At exhaustion a table holds `0.875·cap − used` tombstones, so the first gate can only pass if `used ≤ 0.775·cap`. Any table above 77.5% live load will grow under churn every time.

The real cliff is lower. Pruning only removes tombstones that sit on no other key's probe path. As load rises, more keys are displaced from their home groups, so more tombstones become load-bearing and the second gate fails. I swept a single 1024-slot table across live loads on 1.27.3:

| live load | grew within 1000·n cycles | grew within 10,000·n cycles |
|---|---|---|
| 0.45–0.59 | 0 / 6 seeds | 0 / 4 at 0.55 and 0.59 |
| 0.60–0.61 | — | 0 / 4 |
| 0.62 | 0 / 6 | 1 / 3 |
| 0.625 | 2 / 6 | — |
| 0.630 | 1 / 6 | — |
| 0.635 | 5 / 6 | — |
| 0.64–0.65 | 6 / 6 | — |
| 0.66–0.85 | 3 / 3 (within ~250·n) | — |

Smaller tables flip slightly earlier: a 256-slot table didn't grow at 0.59 (0/6) and always grew at 0.62 (6/6). The transition is noisy (0.630 grew less often than 0.625), but narrow. If n is uniform, a freshly grown table's load is uniform in (7/16, 7/8]. That puts **58% of map sizes** (uniform in n), or 50% (log-uniform), above 0.62. For those sizes churn still doubles the table once. After that the load drops to 0.31–0.44 and the table stays put. This matches the scale table. The fresh 100k-key map sits at load 0.763, so it doubled on both versions. The 1k and 1M maps sit near 0.48 and stayed flat. The 10k map's tables straddle the line, so only some of them split.

## Two smaller findings

**`maps.Clone` stopped compacting in 1.25.** On go1.24.0, cloning the churned 1k map gave capacity 2048 and 0 tombstones, because it re-inserted every entry. Go 1.25 made Clone 95% faster ([#70836](https://github.com/golang/go/issues/70836)) by copying groups as-is. On 1.27.3 the clone kept every one of the 576 tombstones and the 2.30-group miss probe. Since 1.25, `clear(m)` also wipes tombstones, but it drops the data with them.

**Small-map updates no longer grow the map.** A full 8-entry map lives in a single group with no directory. On go1.24.0, overwriting an *existing* key in such a map promoted it to a table (`dirLen` 0 → 1). Issue [#78853](https://github.com/golang/go/issues/78853) fixed this in May 2026, and on 1.27.3 the map stays small.

## What to do about it

On Go ≥ 1.25, a long-lived churning map should expect about 2× slower misses and inserts (tombstones never show in `len()` or a heap profile), and one doubling if its tables sit above about 62% load. To get a clean map, rebuild rather than clone; range-copying is the only user-level operation that resets probe chains and keeps the data:

```go
fresh := make(map[K]V, len(m)) // a hint isn't needed; the copy is what drops the tombstones
for k, v := range m {
    fresh[k] = v
}
m = fresh
```

The runtime already lists the real fix as a TODO in `rehash`: a same-size "resize" into a new allocation. That would clear every tombstone, not just the unmarked ones, and existing iterators would keep working because they hold a reference to the old table. Until it lands, Go's tables follow the Swiss-table rule that tombstones count against capacity, without the in-place rehash that normally clears them.
