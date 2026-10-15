---
title: "PostgreSQL 18 Skip Scan, Measured: Skip Arrays, a Missing Increment That Doubles Descents, and Two Cliffs at One Value per Leaf Page"
date: 2026-10-15
tags: ["postgresql", "databases", "btree", "query-optimization", "indexing"]
excerpt: "PostgreSQL 18 lets a B-tree on (a, b) answer WHERE b = 7700 by skipping through every distinct a. I read the nbtree source and measured PG 18.6 on 4M-row tables across 10 to 1M distinct leading values. Descents come out at exactly ndistinct + 2. Types without skip support pay 2·ndistinct + 1. The planner and the executor both give up at about one distinct value per leaf page. At that point a skip scan that kept descending would still have been 1.7× faster."
---

# PostgreSQL 18 Skip Scan, Measured: Skip Arrays, a Missing Increment That Doubles Descents, and Two Cliffs at One Value per Leaf Page

Before PostgreSQL 18, a B-tree on `(a, b)` was mostly useless for `WHERE b = 7700`. With no constraint on `a`, nbtree had nowhere to start a search. Peter Geoghegan's commit `92fe23d9` (shipped in PG 18) fixes that. In the docs' words, skip scan "works by generating a dynamic equality constraint internally, that matches every possible value in an index column." I read the REL_18_STABLE source and measured PostgreSQL 18.6 on an Apple M3 Pro. I wanted to see how that constraint is generated, and where the planner and the executor each decide that skipping stops paying.

## Skip arrays: a ScalarArrayOp with no array

PG 17 had already reworked how nbtree runs `= ANY(array)` (ScalarArrayOp, or SAOP). One scan carries a set of array keys and advances them as it reads leaf pages. It starts a new *primitive index scan*, a fresh descent from the root, only when the next key can't be on the pages ahead. Skip scan reuses this. For each leading column with no `=` qual, preprocessing adds a **skip array**: an SAOP array whose elements are generated on demand.

So `WHERE b = 7700` runs as `WHERE a = ANY(<every a>) AND b = 7700`. The array starts at a −∞ sentinel. The first descent for `(−∞, 7700)` lands on the first real tuple, say `a = 0`. The array advances to 0, and the scan repositions to `(0, 7700)`. If the column's operator class provides **skip support** (support function 6), the next element is computed rather than looked up. From `nbtcompare.c`:

```c
static Datum
int4_increment(Relation rel, Datum existing, bool *overflow)
{
	int32		iexisting = DatumGetInt32(existing);

	if (iexisting == PG_INT32_MAX)
	{
		/* return value is undefined */
		*overflow = true;
		return (Datum) 0;
	}

	*overflow = false;
	return Int32GetDatum(iexisting + 1);
}
```

Without skip support, "the value after 0" can't be computed. The key gets a `NEXT` sentinel flag, and the scan must *find* the next stored value with a probe before it can search for `(a′, 7700)`. A catalog query on PG 18.6 lists the types with support function 6: `int2/4/8`, `oid`, `bool`, `"char"`, `date`, `timestamp`, `timestamptz`, `uuid`. There is no `text`, `numeric`, or `float8`.

## The experiment

Each table has 4M rows `(a int, b int)` with `a = i % nd`, `b` hashed over 0–16383, and an index on `(a, b)`. The query is `SELECT count(*) … WHERE b = 7700`, which matches 259 rows. Every scan is index-only: tables were vacuumed and the cache was warm. Parallelism was off, and each figure is the median of 7 runs of `EXPLAIN (ANALYZE, BUFFERS)`. In PG 18 that output also reports `Index Searches`. I compared three plans:

- the forced skip scan;
- the same index walk with the predicate written as `b + 0 = 7700`, which nbtree can't use, so the executor filters every tuple;
- a sequential scan.

| distinct `a` | descents | buffers | skip scan | full idx, executor filter | seq scan | planner picks |
|---:|---:|---:|---:|---:|---:|---|
| 10 | 12 | 43 | **0.38 ms** | 229 ms | 256 ms | index |
| 100 | 102 | 313 | **1.25 ms** | 268 ms | 254 ms | index |
| 1,000 | 1,002 | 3,013 | **6.46 ms** | 296 ms | 254 ms | index |
| 10,000 | 9,837 | 29,709 | **56.2 ms** | 293 ms | 259 ms | index |
| 10,500 | 10,016 | 30,541 | 58.9 ms | 289 ms | 260 ms | index |
| 11,500 | 3,042 | 16,999 | 98.3 ms | 298 ms | 263 ms | **seq** |
| 12,000 | 288 | 11,496 | 110.7 ms | 298 ms | 262 ms | **seq** |
| 100,000 | 1 | 10,938 | 112.9 ms | 292 ms | 261 ms | **seq** |
| 1,000,000 | 1 | 10,938 | 110.1 ms | 290 ms | 255 ms | **seq** |

For 1,000 or more distinct values the index is about 10,950 pages. At 10 and 100 values, deduplication shrinks it to 3,773 and 7,681 pages.

### 1. Descents are exactly ndistinct + 2

There are 12, 102, and 1,002 descents: one from −∞, one per value, and a final search for the value after the last one, which finds nothing. Each costs 3 buffer hits on this 3-level tree. At 10 distinct values the skip scan is **670× faster** than the seq scan. That is the intended case: a low-cardinality prefix such as `tenant_id` or `status` in front of the column you actually filter on.

### 2. No skip support means 2·ndistinct + 1 descents

The same 1,000-value table, with `a` stored as each type:

| type of `a` | skip support | descents | buffers | time |
|---|---|---:|---:|---:|
| int8 | yes | 1,002 | 3,016 | 6.5 ms |
| float8 | no | 2,001 | 6,015 | 10.9 ms |
| numeric | no | 2,001 | 6,017 | 13.6 ms |
| text | no | 2,001 | 6,016 | 19.9 ms |

Each value costs a `NEXT` probe followed by the real search. The source hopes a probe often lands on a leaf page that already covers the later keys. That fails here: each group spans about 15 leaf pages, so the probe lands at the group's start and `b = 7700` is pages away.

### 3. It beats the recursive-CTE workaround by 2.6×

The old workaround is a "loose index scan": a recursive CTE that walks distinct `a` values with `ORDER BY a LIMIT 1`, plus a lateral `a = $1 AND b = 7700` lookup:

```sql
WITH RECURSIVE d(a) AS (
  (SELECT a FROM t ORDER BY a LIMIT 1)
  UNION ALL
  SELECT (SELECT t.a FROM t WHERE t.a > d.a ORDER BY t.a LIMIT 1)
  FROM d WHERE d.a IS NOT NULL)
SELECT count(*) FROM d, LATERAL (SELECT 1 FROM t WHERE t.a = d.a AND t.b = 7700) x;
```

It took 6,008 buffer hits and 17.0 ms, against 3,013 hits and 6.46 ms for the native scan. That is the no-skip-support algorithm, two descents per value, plus executor overhead. On `int` prefixes, delete those CTEs. On `text` prefixes the upgrade mostly buys readability.

### 4. Buffer counts are the wrong metric

At 10,000 distinct values the skip scan touches **29,709 buffers, 2.7× the entire index**. It is still 2× faster than one in-order pass over that index (112 ms). Each descent re-reads two upper-level pages that are always cached, binary-searches one leaf, and checks a few tuples, while the linear walk compares all 4M. `btcostestimate`'s own comment says CPU savings "can greatly exceed any savings in I/O costs."

### 5. The planner cliff: ndistinct + 1 > index pages

`btcostestimate` multiplies the estimated primitive scans by `ndistinct + 1`. Once that product exceeds the index's page count, it abandons skip costing:

```c
num_sa_scans *= ndistinct;          /* ndistinct includes +1 for the -inf sentinel */
if (index->pages < num_sa_scans) {  /* "sharp discontinuity in cost" -- by design */
    num_sa_scans = num_sa_scans_prev_cols;
    break;
}
```

With 10,951 pages, that predicts a flip between 10,500 values (estimate 10,507) and 11,500 (11,504). The plan flipped exactly there.

### 6. The executor cliff is in the same place, and it gives up too early

`_bt_advance_array_keys` (nbtutils.c) schedules a new primitive scan only when the next key lies past the current page's high key. Even then, it doesn't if the primitive scan has already left its first leaf page, or if the skip array advanced more than `NSKIPADVANCES_THRESHOLD = 3` times on that page. In those cases the scan keeps walking right and never descends again.

I had guessed that would kick in at about four values per page. The data says one. When a group is bigger than a leaf page, the next key is always past the high key, so the scan descends again. Once groups are smaller than a page, the scan crosses a page boundary, stops being on its first page, and goes linear. That gives 10,016 descents at 10,500 values, 3,042 at 11,500, and 288 at 12,000.

Is that the right moment to give up? At 10k values a descent costs 56.2 ms / 9,837 ≈ **5.7 µs**, and the linear walk costs about 110 ms. Descending stays cheaper up to about **19k values**. At 12,000 values, continued skipping would take about 68 ms, against the 111 ms measured. So the executor switches 1.7× too early in that band, on a warm cache. I didn't measure cold storage. There, every descent and every linear page becomes a random read, because PG 18 doesn't prefetch B-tree leaves.

## The fallback still beats a seq scan, and the planner misses it

After the executor stops skipping, the plan is still a full index walk, but with `b = 7700` evaluated *inside* nbtree. PG 18 also skips re-checking keys that every tuple on the page is known to satisfy (`pstate.startikey`). That walk takes 110 ms, compared with 290 ms when the executor does the filtering and about 260 ms for the seq scan, which reads 21,632 heap pages. Yet above 11,500 values the planner picks the 2.3× slower seq scan. Once it abandons skip costing, it charges the index path as a plain full scan at the default `random_page_cost = 4`. With hot caches and SSDs, that setting deserves a second look.

## What to take from this

1. **Prefixes with fewer distinct values than leaf pages are now nearly free.** `(tenant_id, created_at)` can serve `WHERE created_at > …`. Confirm that `Index Searches` comes out close to ndistinct.
2. **Use a skip-supported type for the leading column.** `int`/`uuid`/`date` costs one descent per value. `text`/`numeric` costs two.
3. **The cliff sits at one distinct value per leaf page**, about rows / 365 for these 8-byte keys. Both the planner and the executor give up there, and the executor gives up somewhat too early.
4. **Don't judge skip scans by buffer counts.** The fastest plan in the table touched 2.7× more buffers than the whole index.

Caveats: one machine, a warm cache, uniform uncorrelated synthetic data, and integer keys. A skewed prefix, with a few huge groups among many small ones, would put different parts of one scan on opposite sides of the cliff. I didn't test that.
