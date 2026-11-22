---
title: "UUIDv7 in PostgreSQL 18, Audited: The 245 ns Step, a Collision Trade That Is Exactly Neutral, and the Out-of-Order Cliff That Halves Index Fill"
date: 2026-11-22
tags: [postgresql, databases, b-trees, uuid, write-ahead-logging]
excerpt: "PostgreSQL 18 ships a native uuidv7() built on RFC 9562's Method 3: 12 bits of sub-millisecond clock replace random bits. I read uuid.c and nbtsplitloc.c, then checked them with my own code. The 245 ns minimum step is exactly the smallest value that guarantees per-backend monotonicity (244 ns fails 1,728 times per 3 ms). Giving up 12 random bits for clock bits costs nothing in collision odds when arrivals are uniform, and at most 4096× when they cluster. A leaf-level simulation using PostgreSQL's split rules finds a cliff. Out-of-order inserts are harmless up to about 2.5× the fillfactor slack. Beyond that, fill drops to 54%, worse than random v4. And fillfactor=100 on a v7 index sits at 51% with almost any reordering."
---

PostgreSQL 18 added `uuidv7()`: UUIDs that sort by time, so a primary-key B-tree gets append-style inserts instead of random scatter. To see what the implementation guarantees and where that stops, I read `uuid.c` and `nbtsplitloc.c` from `REL_18_STABLE` plus RFC 9562, then checked each claim with my own code: an exhaustive monotonicity check, a collision model, and a leaf-level B-tree simulation using PostgreSQL's split rules.

## The layout PostgreSQL actually emits

RFC 9562's UUIDv7 is a 48-bit Unix millisecond timestamp, 4 version bits, 12 bits of `rand_a`, 2 variant bits and 62 bits of `rand_b`: 74 bits that can be random. Section 6.2 offers three optional monotonicity schemes: a dedicated counter (Method 1), a randomly incremented counter (Method 2), or replacing up to 12 random bits with extra clock precision (Method 3).

PostgreSQL uses Method 3:

```c
increased_clock_precision = (sub_ms * (1 << SUBMS_BITS)) / NS_PER_MS;  /* 12 bits */
uuid->data[6] = (unsigned char) (increased_clock_precision >> 8);
uuid->data[7] = (unsigned char) (increased_clock_precision);
pg_strong_random(&uuid->data[8], UUID_LEN - 8);                         /* rand_b */
```

On Linux this means `rand_a` holds no randomness at all. It is time, quantized to 1/4096 ms, which is about 244 ns. Uniqueness rests entirely on the 62 bits of `rand_b`.

## The 245 ns step is exactly minimal

The clock alone can't guarantee monotonicity, because two calls can land in the same 244 ns bucket. `get_real_time_ns_ascending()` keeps a `static int64 previous_ns` per backend and forces every call to advance by at least `SUBMS_MINIMAL_STEP_NS = 1_000_000/4096 + 1 = 245` ns:

```c
if (previous_ns + SUBMS_MINIMAL_STEP_NS >= ns)
    ns = previous_ns + SUBMS_MINIMAL_STEP_NS;
```

I checked every nanosecond offset across three milliseconds, comparing the full (millisecond, sub-millisecond) key at x and at x + step:

```python
def key(x): return (x // 10**6, ((x % 10**6) * 4096 // 10**6) >> shift)
bad = sum(key(x + step) <= key(x) for x in range(3 * 10**6))
```

| clock precision | step | violations | violations at step − 1 | per-backend ceiling |
|---|---|---|---|---|
| ns (Linux), 12 bits | 245 ns | 0 | 1,728 | 4.08 M UUID/s |
| µs (macOS, MSVC), 10 bits | 977 ns | 0 | 1,728 | 1.02 M UUID/s |

The constant is tight: 244 ns would break ordering 1,728 times per 3 ms. The macOS path is neat too. A microsecond clock gives only 10 meaningful bits, so the code XORs the low 2 bits of `rand_a` with `data[8] >> 6`, random bits that `uuid_set_version()` then overwrites with the variant. A 977 ns step moves the 12-bit field by at least 4, so the top 10 bits always increase and the randomized bottom 2 can't reorder anything, and no visible random bit is reused.

Two limits follow from that `static`:

- **Monotonicity is per backend, not per database.** Across backends you get wall-clock order, until the clock steps backward: a long-lived backend keeps counting from `previous_ns`, while a new one uses the regressed clock and sorts *before* IDs created a moment ago. Under transaction-mode pooling, an application "session" hops backends and has no guarantee at all.
- **After a backward step of Δ, the timestamp lies.** The backend steps forward from `previous_ns` until real time catches up, so `uuid_extract_timestamp()` can be off by up to Δ, one concrete reason the docs say it "is not necessarily exactly equal to the time the UUID was generated."

## The collision trade is exactly neutral, then capped at 4096×

Swapping 12 random bits for clock bits sounds costly. Under uniform arrivals it costs nothing. Two IDs collide only if they share a 244 ns bucket and all 62 random bits. Expected colliding pairs are Σ_tick n²/2 · 2⁻⁶². Plain 74-bit-random v7 gives Σ_ms n²/2 · 2⁻⁷⁴. Since 4096 · 2⁻⁷⁴ = 2⁻⁶², the two match exactly when arrivals are spread evenly within each millisecond. By Cauchy–Schwarz, Σ_tick n² ≥ (Σ_ms n²)/4096, so Method 3 is never better than pure random, and at worst 4096× worse, when every ID in a millisecond lands in one 244 ns bucket. One effect works the other way: pairs from the same backend can never collide, because they are strictly ordered.

At a sustained 1 M UUID/s across all backends:

| scheme | expected collisions |
|---|---|
| PG18 v7, uniform arrivals | 8.4 × 10⁻⁷ per year |
| pure-random v7 (74 bits) | 8.4 × 10⁻⁷ per year (identical) |
| PG18 v7, worst-case clustering | 3.4 × 10⁻³ per year |
| v4 (122 bits), first year | 9.4 × 10⁻¹¹ |

v7 risk grows linearly with time (only near-simultaneous IDs can collide); v4 risk grows quadratically (every stored ID against every other). They cross at tick·2⁶⁰ ≈ 8,900 years, so v4 is safer for any table you will ever own, though both are negligible unless generators synchronize below a microsecond.

## The B-tree: what "time-ordered" buys, and where it stops

The locality argument depends on how nbtree splits pages, so I read `_bt_findsplitloc`:

- **Rightmost leaf:** the left half is left `fillfactor`% full (default 90). Pure appends therefore pack pages to about 90%.
- **Any other leaf:** the new item goes in and the page splits 50:50. `_bt_afternewitemoff()`, which detects "localized ascending" patterns, returns early with `/* Single key indexes not considered here */`. A plain `uuid` primary key never gets that optimization.

A `uuid` index tuple is 24 bytes plus a 4-byte line pointer, so a leaf holds (8192 − 24 − 16)/28 = 291. At fillfactor 90 the rightmost split closes a page with 261 tuples and **30 slots of slack**, which is where every insert that falls behind the moving right edge lands.

I modeled lateness as key *i* reaching the index at *i* + Exp(mean *j*), in units of inserts. By Little's law *j* ≈ keys generated but not yet inserted (insert rate × generation-to-insert delay). Applying the split rules to 200k–400k inserts:

| workload (fillfactor 90 unless noted) | leaf fill |
|---|---|
| v7, perfectly ordered | 0.897 |
| v7, mean lateness 30 | 0.913 |
| v7, mean lateness 60 | 0.955 |
| v7, mean lateness 80 | 0.762 |
| **v7, mean lateness 100** | **0.538** |
| v7, mean lateness 300 | 0.680 |
| v4 random | 0.62–0.67 |
| v7, 1% of keys late by Exp(5000) | 0.905 |
| **v7, fillfactor 100, mean lateness 5** | **0.51** |
| v7, fillfactor 70, mean lateness 300 | 0.88 |

The curve is not monotone. A little lateness *improves* fill: stragglers use up the slack. Once in-flight keys pass about 2.5× the slack, the closed page overflows and splits 50:50 into two half-empty pages covering a key range nothing will insert into again. Fill drops to 54%, below random v4, which at least keeps refilling its half-empty pages. (v4 itself oscillates between 0.62 and 0.67 with N, splitting in synchronized waves rather than settling at Yao's ln 2.) A sparse tail of very late keys is harmless; what matters is how many keys are in flight. Two seeds agreed within 0.02 everywhere.

The cliff scales with slack: near 70–80 in-flight keys at fillfactor 90, 120–200 at 80, past 300 at 70. **Fillfactor 100, the "obvious" choice for an append-only v7 key, is the worst setting**: with no slack, one straggler forces a 50:50 split of a full page.

`DEFAULT uuidv7()` is evaluated inside `ExecInsert`, microseconds before the index insert, so in-flight keys are bounded by concurrently inserting backends. Application-generated IDs are different: at 20k inserts/s, a 5 ms generate-to-insert delay (one round trip, or a batching buffer) puts 100 in flight, past the fillfactor-90 cliff.

## Where the real win is: full-page images

The biggest difference is WAL volume, not fill. With `full_page_writes` on, the first change to a page after a checkpoint logs the whole page (minus its free-space hole). v7 touches about one old leaf per checkpoint; v4 touches L·(1 − e^(−C/L)) distinct leaves for L leaves and C inserts per checkpoint, so cost depends only on rows ÷ C. Index-only WAL bytes per insert, assuming a ~70 B insert record:

| rows ÷ inserts per checkpoint | v4 | v7 |
|---|---|---|
| 3 | 164 | 70 |
| 33 | 1,008 | 70 |
| 333 | 4,323 | 70 |

It also feeds back. If checkpoints are WAL-triggered (modeled as a fixed 1 GiB budget, simplifying `max_wal_size`), v4's page images cause more checkpoints, which cause more page images. At 100M rows the fixed point is a checkpoint every 225k inserts for v4 versus 4.9M for v7: 4.6 KB versus 70 B of index WAL per insert, about 66×. `wal_compression` shrinks the images but does not avoid them.

## What I'd actually do

```sql
CREATE TABLE events (
  id uuid DEFAULT uuidv7()                   -- generate in-server: few keys in flight
     PRIMARY KEY WITH (fillfactor = 90)      -- the default; keep the slack, never 100
);
```

- Generate IDs in the database when you can. Otherwise keep insert rate × generate-to-insert delay under ~2.5× the slack, or lower fillfactor until it is.
- Don't rely on cross-session ordering: the guarantee is per backend and only while the clock never steps back.
- Treat the embedded timestamp as public, at 244 ns precision.
- Prefer v4 when lifetime collision margin matters more than WAL.

All numbers come from my own scripts against the PG18 source and RFC text. The simulation models leaves only, splits by tuple count rather than bytes, and ignores internal pages, deduplication and right-edge buffer-lock contention.
