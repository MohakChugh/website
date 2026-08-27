---
title: "The Move Structure: What Actually Makes a BWT-Runs Index Fast"
date: 2026-08-27
tags: [data-structures, compression, indexing, cache-efficiency, bioinformatics]
excerpt: "Nishimoto and Tabei's move structure turns LF mapping on a run-length BWT from a predecessor search into a pointer dereference plus a short local scan, and the theory is about bounding that scan. I built the whole thing and measured it: the balancing that bounds the scan cost 4.5% more intervals and improved throughput by nothing. The pointer is the entire win — 1.05 cache lines per LF step versus 4.01 and climbing."
---

The FM-index has a problem with repetitive collections. Index a thousand near-identical genomes and the suffix array grows linearly in total length while the *information* stays roughly constant. The fix has been known since 2018: the Burrows–Wheeler transform of a repetitive text is itself extremely runny, so store it run-length encoded and bound everything by `r`, the number of equal-letter runs. Gagie, Navarro and Prezza's r-index (SODA '18, later JACM 67(1)) gives you `count` and `locate` in O(r) words.

The catch is what a single step costs. Backward search is a loop of LF mappings, and on an r-index each LF is a rank query over sparse bitvectors plus a predecessor search over run boundaries — O(log log n) time, and more to the point, several dependent random accesses. You cannot start step *i+1* before step *i* resolves. So the index is compressed, asymptotically fine, and memory-latency-bound in the worst way.

Nishimoto and Tabei's *Optimal-Time Queries on BWT-runs Compressed Indexes* (ICALP 2021, arXiv:2006.05104) removes the log log. Their **move structure** computes LF and φ⁻¹ in constant time in O(r) words. That result is what the current generation of pangenome indexes is built on — Movi (iScience, 2024; Movi 2 and Movi Color as 2025 preprints), b-move (WABI 2024), and an adaptation for long-match queries (arXiv:2505.15698, May 2025) that also gets constant-time PLCP out of it.

I implemented it to find out where the speed actually comes from. The answer was not the part the papers prove.

## LF as a piecewise-linear permutation

Take the BWT and cut it into its `r` runs. Run `k` starts at BWT position `heads[k]` and has a single character `ch[k]`. Because LF maps row `i` to `C[c] + rank_c(i)`, every position in run `k` maps to `dest[k] + offset` — the run's image is *contiguous*. LF is therefore a permutation of `[0, n)` that is piecewise-linear on `r` pieces, and the images of those pieces tile `[0, n)` exactly.

So represent a row not as an integer but as a pair `(interval, offset)`. LF is then arithmetic:

```python
def lf(self, k, off):
    pos = self.dest[k] + off        # where the row lands, as an absolute position
    j = self.dref[k]                # precomputed: interval containing dest[k]
    while j + 1 < len(self.heads) and self.heads[j + 1] <= pos:
        j += 1                      # "fast-forward" to the interval holding pos
    return j, pos - self.heads[j]
```

`dref[k]` is the trick. Without it you would binary-search the heads array on every step to find which interval contains `pos`. With it you start at the interval containing the *image start* and walk forward. One record per run — `(head, char, dest, dref)` — which Movi 2 packs into 8 bytes per row in its default mode, 6 in blocked mode, and 3-plus in sampled mode.

## The unbounded scan, and the cascade that fixes it

Nothing bounds that `while` loop. Interval `k`'s image can span arbitrarily many intervals, so a single LF can degrade into a linear scan. Nishimoto and Tabei bound it by *splitting*: pick a threshold `d`, and enforce the invariant that no interval's image contains more than `d` interval heads. Then the scan visits at most `d + 1` intervals.

Enforcing it is where it gets interesting. Splitting a source interval creates a new head, and that new head lands inside exactly one other interval's image (the images tile `[0, n)`, so exactly one) — which may now exceed `d` and need splitting itself. The repair cascades. Their contribution is that it terminates with O(r) intervals for fixed `d ≥ 2`.

```python
def check(self, d):
    """Invariant: no interval's image contains more than d interval heads."""
    worst = 0
    for k in range(len(self.heads)):
        lo, hi = self.dest[k], self.dest[k] + self.length(k)
        a = bisect.bisect_right(self.heads, lo)
        b = bisect.bisect_left(self.heads, hi)
        worst = max(worst, b - a)
    assert worst <= d
    return worst
```

One bug worth naming, because it is the kind that survives testing: my first cascade queued *interval indices*, and every split shifts every index above the insertion point. The structure still answered every query correctly — it was merely under-balanced, capping `d = 2` at 3 fast-forward steps instead of 2. Correctness tests will never catch that. Queue head positions, which are stable, and assert the invariant directly.

## Measurements

Corpus: a synthetic pangenome — a random 5 kbp DNA sequence, 40 copies at 0.5% substitution and 0.05% indel rate, n = 200,005. That gives r = 10,373 runs, 19.3 characters per run, `r` at 5.19% of `n`. Two correctness gates before any timing: the LF walk reconstructs the text, and backward-search counts for 200 sampled 12-mers match a suffix-array ground truth — re-checked after every balancing run.

Fast-forward steps over a full n-step LF walk, and cache lines touched per step assuming 8-byte records (8 per 64-byte line):

| variant | intervals | r'/r | mean steps | p99 | p99.9 | max | lines/LF |
|---|---|---|---|---|---|---|---|
| unbalanced | 10,373 | 1.000 | 0.437 | 4 | 6 | 9 | 1.053 |
| balanced d=8 | 10,374 | 1.000 | 0.437 | 4 | 6 | 8 | 1.053 |
| balanced d=4 | 10,427 | 1.005 | 0.414 | 3 | 4 | 4 | 1.049 |
| balanced d=3 | 10,532 | 1.015 | 0.388 | 3 | 3 | 3 | 1.047 |
| balanced d=2 | 10,839 | 1.045 | 0.330 | 2 | 2 | 2 | 1.040 |

Three things fall out. **Balancing is cheap** — `d = 2` cost 4.5% more intervals here, nowhere near the factor-of-two you might budget for. **Mean steps go down, not up**: splitting shortens images, so the average query fast-forwards *less* after balancing (0.437 → 0.330). And **the mean was already below one** — most LF steps land in the first candidate interval with no scan at all.

The last column is the one that reframes the whole exercise. Cache lines touched per LF barely move: 1.053 unbalanced, 1.040 at `d = 2`. The fast-forward scan is *sequential in memory* — it walks `j, j+1, j+2` through a flat array — so a 9-step tail costs about one extra line, and the hardware prefetcher sees it coming. Balancing buys a worst-case bound. It does not buy throughput.

## So what is the pointer worth?

If balancing is not the win, the `dref` pointer has to be. I removed it and modelled the alternative: find the target interval by binary search over the heads array, counting only *cold* lines — the top eight levels of the search tree are touched by every query, so I treat those 255 lines as resident and count the rest.

| n | r | heads array | predecessor cold lines/LF | move structure lines/LF | d=2 r'/r |
|---|---|---|---|---|---|
| 50,010 | 3,262 | 25 KB | 0.60 | 1.05 | 1.036 |
| 199,990 | 9,981 | 78 KB | 2.22 | 1.06 | 1.044 |
| 839,980 | 33,157 | 259 KB | 4.01 | 1.09 | 1.076 |

At 25 KB the whole heads array is cache-resident and predecessor search *wins* — 0.60 cold lines against 1.05. It loses by 2× at 78 KB and by nearly 4× at 259 KB, and it keeps losing, because its cost grows with `log r` minus whatever stays resident while the move structure's stays pinned at one line. Real pangenome indexes run `r` in the 10⁸–10⁹ range, where the heads array is gigabytes and every level below the first few is a DRAM round trip on the critical path of a serially dependent loop.

That is the whole mechanism behind the reported numbers: b-move measures character extensions and φ/φ⁻¹ up to 7× faster than the bidirectional r-index while keeping br-index-class memory (3,000-plus complete *E. coli* genomes in a laptop's RAM), and Movi is explicitly pitched at Nanopore adaptive sampling, where what matters is not mean throughput but a *predictable* per-query latency you can commit to inside a sequencing run's real-time budget.

## Caveats, honestly

My corpus is synthetic with uniform mutation rates, which is friendly: adversarial inputs are what make the O(r) balancing bound worth proving, and I did not construct any. The cache column is a model — line counts under a stated residency assumption, not misses from a hardware counter, and Python says nothing about instruction-level parallelism or prefetch distance. None of it addresses construction, the real deployment wall: b-move reports 512 human chr19 haplotypes at roughly 2 hours and 520 GB in memory, versus 7 hours and 84 GB with prefix-free parsing.

The transferable pattern: any time a query is a search for "which piece of a piecewise-linear map contains this point," and the pieces are static, precompute the answer for one point per piece and bound the local walk from there. The theory then goes into bounding the walk — but check whether the walk was ever the cost. Here it was not. "Constant time" and "cache-efficient" are two different claims bought by two different mechanisms, and only one of them showed up in my measurements.
