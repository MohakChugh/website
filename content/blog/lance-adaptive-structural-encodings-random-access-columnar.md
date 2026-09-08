---
title: "Lance: Random Access in Columnar Storage Without Giving Up Scans"
date: 2026-09-09
tags: [columnar-storage, data-engineering, file-formats, nvme, vector-search]
excerpt: "Columnar formats are supposedly bad at point lookups. Lance (arXiv 2504.15247) shows the real culprit is how formats encode structure — validity and repetition — not columnar layout itself. Two adaptive encodings, mini-block and full-zip, cap any random access at 2 IOPS regardless of nesting depth. The numbers check out: default Parquet manages ~5.5K rows/sec where tuned layouts hit 350K, a 63.6x gap my own arithmetic reproduces."
---

The conventional wisdom about columnar formats goes: great for scans, terrible for point lookups. If your workload fetches individual rows — secondary-index lookups, vector search result hydration, training-data shuffles — you're told to put the data in a row store or a key-value cache and accept the copy.

[Lance](https://arxiv.org/abs/2504.15247) (Pace, She, Xu, Jones, Lockett, Wang, and Shah, 2025) argues the conventional wisdom misdiagnoses the problem. On NVMe, columnar random access is not slow because the layout is columnar. It's slow because of how formats encode *structure* — the validity bitmaps, offsets, and repetition levels that describe nulls and nesting. Fix the structural encoding and a columnar file can serve hundreds of thousands of point lookups per second while still scanning at close to full disk bandwidth.

The paper is the design rationale for Lance 2.1, the format underlying LanceDB, and it's one of the more carefully reasoned pieces of file-format engineering published recently. The motivating workload is AI infrastructure: multimodal datasets where one table mixes 8-byte timestamps, 3 KiB embeddings, and 5 MiB images, accessed both by full scans (training epochs) and by random access (search, sampling, point retrieval) against NVMe-backed caches over object storage.

## Why random access dies in existing formats

Consider fetching element `i` of a nullable `List<String>` column.

**Arrow's** disk layout has no repetition/definition levels. Each nesting layer contributes an offsets array and a validity bitmap. To read one value you need the list validity, list offsets, string validity, string offsets, and finally the string bytes — 5 IOPS, and worse, they're *sequential in 3 phases*: you can't know where the string offsets live until the list offsets return. Each additional nesting level adds two more reads. My back-of-envelope model: 5, 7, 9, 11 IOPS at depths 1–4. On a disk that does ~850K random 4 KiB reads/sec, chained dependent reads are the difference between 100µs and 400µs lookups.

**Parquet** has the opposite problem. Pages are opaque, indivisible units — to read one value you decompress the whole page. With default settings (1 MiB pages, dictionary encoding, Snappy), the paper measures parquet-rs at roughly **5,500 rows/sec** of random access on small scalars. Tune it — 8 KiB pages, page offset index enabled, no compression, no dictionary — and the same library hits **~350,000 rows/sec**. That's the "over 60x" claim in the abstract, and the arithmetic checks: 350,000 / 5,500 = 63.6x. But the tuning has costs. Dictionary encoding alone drops random access to 2% of ideal, so you give it up, along with compression ratio; and tiny pages explode the in-memory page index.

That last cost is the hidden one. parquet-rs keeps ~20 bytes per page of index in RAM. For large values (one value per 8 KiB page), a billion rows costs **20 GB of page index** — for *one column*. The paper's stated budget for this "search cache" is ~0.1% of data size. Tuned Parquet blows through it.

## The two encodings

Lance's answer is to admit that no single structural encoding works across a 6-orders-of-magnitude range of value widths, and to pick per column chunk based on measured value width, with a crossover at **128 bytes per value**.

**Mini-block**, for narrow values, looks like a Parquet page shrunk to the disk's natural grain. The array is chopped into chunks targeting 1–2 disk sectors (4–8 KiB) of compressed data, at most 4,096 values, power-of-two counts, 8-byte aligned. Within a chunk, repetition levels, definition levels, and data live in separate buffers — untransposed — so encoding stays vectorized, nulls stay sparse, and opaque block compression still works. Reading one value decodes one chunk, but a 4 KiB decode is nearly free when the alternative was a 1 MiB one. The metadata is brutally small: 2 bytes per chunk — 12 bits of length in 8-byte words, 4 bits of log2(value count).

**Full-zip**, for wide values, transposes to row-major *within the column*. Each value is laid out as:

```text
[control word: 1-4 B][length, if variable width][value bytes]
```

The control word bit-packs the repetition and definition levels for that value. This is where the design gets clever about Dremel-style shredding: a `Struct<List<String>>` needs 3 definition bits (valid / null item / empty list / null list / null struct) plus 1 repetition bit — one byte covers it, and the paper notes exceeding one byte is rare. On a 3 KiB embedding, a 1-byte-per-value overhead is a 1.0003x cost for structure that Parquet spreads across separate level buffers.

The compression ordering matters: values are compressed *before* zipping, so columnar tricks like FSST on strings survive, with the symbol table hoisted into page metadata. The constraint is that compression must be **transparent** — no inter-value dependencies. Bit-packing, FSST, and dictionary qualify; Snappy and delta encoding don't, so very large values instead get per-value LZ4 frames that decompress independently.

## The repetition index: 2 IOPS, flat in nesting depth

Structural encoding solves decode amplification; the **repetition index** solves *finding* row `i` at all, since variable-width and nested rows land at unpredictable byte offsets.

For full-zip, it's a bit-packed array of byte offsets, one per top-level row, stored ahead of the zipped buffer. A point lookup is one read into the index plus one read of the value; a range is at most 2 parallel IOPS (start and end offsets). Crucially this holds *regardless of nesting depth* — where Arrow's layout costs 2 extra dependent IOPS per level, Lance stays at 2, and they're parallel, not chained. Scans skip the index entirely.

For mini-block, the index is per-chunk: N+1 integers for N addressable nesting levels, counting complete rows since chunk start, then lists completed since the last row, down to flattened items. This exists because rows may span chunk boundaries — a deliberate departure from Parquet, where pages start at record boundaries.

The RAM story closes the loop. Mini-block metadata is 24 bytes/chunk (41 with a repetition index) at ≥32 values per chunk: for a billion rows that's **0.75–1.28 GB** of search cache versus tuned Parquet's 20 GB — a ~15.6x reduction, inside the 0.1% budget. Full-zip needs *zero* search cache: the repetition index lives on disk and costs one of your two IOPS.

## Does it give anything up?

Less than I expected. On scans, Parquet itself only reached about half the NVMe's 3,400 MiB/s peak (the authors blame I/O scheduling, not CPU), and Lance's normalized scan throughput came out 1.3–2x better on most of their column types, roughly at parity on the worst. On random access, Lance 2.1 matches or beats tuned Parquet everywhere; the one regression is against Lance 2.0's Arrow-style layout on flat scalars, where whole-chunk decode loses slightly to direct offset arithmetic — the price of the chunk abstraction, and it disappears the moment strings or nesting show up.

The honest caveats: the 128-byte crossover is an empirical constant for one NVMe device, the shipping reader supports only one list level of repetition-index addressing, and the RLE-compatible index variant is designed but unimplemented. And none of this helps on S3 directly — at tens of thousands of IOPS with ~100 KB minimum efficient reads, object storage still needs the NVMe cache tier in front.

The transferable insight is bigger than one format. We've spent two decades optimizing the *values* in columnar files — bit-packing, FSST, ALP, dictionary — while treating structure as bookkeeping. Lance shows structure encoding dominates random-access cost, and that it deserves the same adaptive, width-aware treatment values get. If your system hydrates rows by ID out of columnar storage — every vector database does — the page-size/index-size/IOPS triangle here is the design space you're actually in.
