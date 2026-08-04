---
title: "German Strings: Why Arrow's StringView Never Saves Memory, and Wins Anyway"
date: 2026-08-04
tags: [databases, arrow, data-engineering, memory-layout, query-execution]
excerpt: "Arrow's Utf8View layout, lifted from TU Munich's Umbra, replaces offsets with a 16-byte struct that inlines short strings and a 4-byte prefix. The pitch is usually framed as saving memory. Do the algebra and the memory delta is 12n minus the inlined bytes, which is non-negative for every possible dataset. The real wins are elsewhere: one memory access instead of two, prefix-decisive comparisons at 99.97 percent on a real corpus, and a filter that copies pointers instead of bytes. The cost is a garbage collector you now own."
---

Apache Arrow 1.4 added a new physical layout for variable-length data, `BinaryView` and `Utf8View`, adapted from TU Munich's Umbra. The community calls the idea *German strings*. DataFusion ships it behind a flag and reports ClickBench string-heavy queries running up to 2x faster. Polars, Velox, and DuckDB all use a variant.

The usual explanation is that the layout is more compact. That explanation is wrong, and provably so. Once you see why, the actual mechanism becomes much clearer, and so does the one operational hazard the layout introduces.

## The layout

Classic Arrow `Utf8` is two buffers: an `n+1` array of 32-bit offsets, plus one contiguous byte buffer. Value `i` is `data[offsets[i]..offsets[i+1]]`. Simple, and it forces two dependent loads to read one string, plus strict contiguity.

`Utf8View` replaces the offset array with an array of 16-byte view structs, and allows *many* data buffers:

```
length <= 12 (inline):
  bytes 0..3   length (i32)
  bytes 4..15  the bytes themselves, zero padded

length > 12 (out of line):
  bytes 0..3   length (i32)
  bytes 4..7   prefix: first 4 bytes of the string
  bytes 8..11  buffer index (i32)
  bytes 12..15 offset within that buffer (i32)
```

All three integers are signed, and `[offset, offset + length)` must lie entirely inside the indicated buffer. Because the buffer count varies per array, every Arrow record batch carries a `variadicBufferCounts` entry per view field so a reader knows how many data buffers to consume.

Umbra's original 16-byte header, from the CIDR 2020 paper, is the same shape with one addition that Arrow drops. Umbra encodes a *storage class* in two bits of the offset or pointer field, distinguishing persistent strings (query constants, valid for database uptime), transient strings (originating from a relation whose page may be evicted, so they must be copied when materialized), and temporary strings (produced by expressions like `UPPER`, garbage collected when their lifetime ends). Arrow has no buffer manager, so it keeps buffers alive by reference count and inherits the garbage collection problem without inheriting the classification that made it tractable.

## The memory claim, checked

Take an array of `n` non-null values with total byte length `S`, and let `S_short` be the bytes belonging to values of length 12 or less. Ignore validity, which is identical in both layouts.

```
Utf8      = 4(n+1) + S
Utf8View  = 16n + (S - S_short)          # inlined bytes need no buffer space
delta     = Utf8View - Utf8 = 12n - 4 - S_short
```

Since a short value contributes at most 12 bytes, `S_short <= 12n`, so `delta >= -4`. A `Utf8View` array is never more than four bytes smaller than the equivalent `Utf8` array, for any dataset, and equals that bound only in the degenerate case where every single value is exactly 12 bytes long. Every other distribution loses.

On `/usr/share/dict/words`, 235,976 entries, mean length 9.57 bytes, 84.1 percent at or under 12 bytes:

```
Utf8     = 3,201,817 bytes
Utf8View = 4,310,742 bytes      ratio 1.346
```

35 percent *worse*. On a corpus of 15,732 filesystem paths, mean length 41 bytes and effectively nothing inlinable, the ratio is 1.266. There is no crossover point. The 16-byte fixed cost per element is simply larger than the 4-byte offset it replaces, and inlining recovers at most 12 of those bytes.

So any memory win attributed to this layout is a win from *sharing*, not from layout: two equal values can point at the same buffer bytes. arrow-rs exposes that as `with_deduplicate_strings`, and leaves it off by default, because it costs a hash of every string plus a hash table. Absent dedup, budget for more memory, not less.

## Where the speed actually comes from

Three distinct mechanisms, and they are worth separating because they degrade differently.

**One load instead of two.** Reading a `Utf8` value means loading `offsets[i]`, then using that value as an address into `data`. The second load depends on the first, so the memory subsystem cannot overlap them. A view is self-describing: for the 84 percent of the dictionary corpus that is inlined, the string arrives in the same cache line as its length, and there is no second access at all.

**Prefix-decisive comparison.** Comparing two long strings usually resolves inside the first few bytes, which is exactly what the 4-byte prefix is for. I measured this on 200,000 random word pairs: **99.97 percent** were decided without touching a data buffer, with 70.8 percent of pairs having both operands fully inlined. That number is corpus dependent, an array of URLs sharing `https://www.` will do far worse on the prefix path while still winning on the inline path, but the shape holds: `cmp`, `min`/`max`, and `like` become view-local operations. The catch is that each kernel must be specialized to exploit the prefix. A generic kernel that calls `as_str()` and compares byte slices gets none of this.

**Copy-free `filter` and `take`.** This is the big one, and it is the reason the layout exists rather than a nicer offset encoding. `Utf8` requires contiguity, so filtering must compact surviving bytes into a fresh buffer. `Utf8View` builds a new view array whose entries point back into the original buffers, so a filter moves 16 bytes per surviving row regardless of string length. The same relaxation lets a Parquet reader hand out views into already-decoded page buffers instead of memcpy-compacting them into a new one, which matters because in a typical scan most rows are discarded moments later. DataFusion measured ClickBench Q22's `FilterExec` dropping from 7.17 s to 4.86 s, a 32 percent cut, with the query end to end down 17 percent.

## The hazard you now own

Pointing into old buffers means you cannot free them. Filter a 10M row array down to 1M rows and the surviving views still pin every buffer the original array allocated.

Same path corpus, same measurement, sampling uniformly at three selectivities:

```
selectivity 0.5  live bytes 324,460  pinned 646,475  waste 49.8%
selectivity 0.1  live bytes  63,761  pinned 646,475  waste 90.1%
selectivity 0.01 live bytes   6,697  pinned 646,475  waste 99.0%
```

At one percent selectivity you are holding 100x the memory you can address. This is not a leak, the accounting is correct, it is deferred compaction. The remedy is `GenericByteViewArray::gc()`, which copies live bytes into a fresh buffer and drops the sparse ones, and the timing is a genuine tradeoff: too early and you have paid the copy that the layout existed to avoid, too late and you have blown your memory budget and your cache. arrow-rs provides the mechanism and deliberately leaves the policy to the caller. DataFusion hooks it into `CoalesceBatchesExec`, on the reasoning that this is where cardinality is already expected to shrink, and applies a sparsity heuristic rather than a fixed rule.

Buffer count is its own trap. The original 8 KB default block size means 4 GB of strings becomes roughly half a million buffers, and operations that iterate buffers, `get_array_memory_size` among them, become the bottleneck; repeated `concat_batches` produced arrays with millions of buffers. The fix that shipped is exponential: start at 8 KB, double per new buffer, cap at 2 MB.

## When not to use it

Three cases where the layout is the wrong choice, and all three follow directly from the algebra above.

1. **Values under 8 bytes.** You pay 16 bytes per element minimum. `Utf8` pays 4 plus the bytes. Strictly more memory and strictly more cache pressure for no compensating mechanism, since short comparisons were already cheap.
2. **Low-cardinality repeated strings.** `DictionaryArray` wins outright. Views can only share bytes above the 12-byte inline threshold, and the buffer index and offset are always 32-bit even when the data would fit in 8.
3. **Highly selective filters without a GC policy.** See the table. Either you wire up compaction or you accept the bloat, and if you always compact immediately you have re-implemented `Utf8` with a bigger header.

The honest framing for German strings is not compactness. It is a deliberate trade of roughly 12 bytes per element, plus a garbage collection obligation, for the removal of a dependent load, a prefix fast path in comparison kernels, and, above all, the right to build a string array without owning its bytes contiguously. On string-heavy scan and filter workloads that trade pays for itself several times over. On a table of country codes it is a straight loss, and no amount of tuning will fix that.
