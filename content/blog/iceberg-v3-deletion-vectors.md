---
title: "Iceberg v3 Deletion Vectors: Fixing Merge-on-Read With One Bitmap Per File"
date: 2026-07-07
tags: [data-engineering, iceberg, file-formats, databases, lakehouse]
excerpt: Apache Iceberg v2 made row-level deletes possible with position delete files, and large deployments have regretted the details ever since. Format version 3 deprecates them in favor of deletion vectors, Roaring bitmaps stored in Puffin files with a hard invariant of at most one vector per data file. Here is what was broken, how the new binary format works down to the byte level, and why the length field is big-endian on purpose.
---

## The v2 problem nobody designed for

Iceberg format version 2 introduced merge-on-read row-level deletes. Instead of rewriting a 512 MB Parquet file to delete one row (copy-on-write), a writer emits a small *position delete file*: a Parquet file of `(file_path, pos)` pairs saying "row 41,237 of that data file is deleted." Readers apply these as an anti-join at scan time.

The design was flexible, and that flexibility is exactly what went wrong at scale:

1. **One delete file can reference many data files, and one data file can be referenced by many delete files.** A streaming pipeline running frequent upserts produces a new position delete file per commit. After a day, a single hot data file might have hundreds of delete files that all must be opened, decoded, and unioned before a single data row can be returned.
2. **Position deletes are full Parquet files.** Deleting one row costs a footer, column metadata, and dictionary overhead, kilobytes of ceremony around 16 bytes of information. Small-file explosion, but for deletes.
3. **The `file_path` column is repeated per row.** A delete file covering rows across many data files stores the full URI string for every deleted position. Sorting by `file_path` then `pos` mitigates scan cost but not storage or planning cost.

The operational symptom is familiar to anyone running CDC ingestion into Iceberg: read amplification grows unboundedly between compactions, and query planning slows down because the engine must reason about a many-to-many join between data files and delete files.

## The v3 fix: deletion vectors

Format version 3 (finalized in the spec during 2024-2025, shipped in Iceberg 1.8+ and now supported by Spark, Trino, and the major managed platforms) deprecates position delete files outright. The spec is blunt: *"Position delete files must not be added to v3 tables."* Their replacement is the **deletion vector** (DV): a bitmap where a set bit at position P means row P of one specific data file is deleted.

Two rules do most of the work:

**Rule 1: at most one deletion vector per data file per snapshot.** Writers must merge new deletes into the existing DV rather than stacking a new delete file on top. The many-to-many relationship of v2 collapses into an optional one-to-one. A reader needs to consult exactly zero or one bitmaps per data file, and membership testing in a bitmap is O(1)-ish instead of a merge join over sorted Parquet rows.

**Rule 2: a DV supersedes all prior position deletes for its file.** When a v2 table is upgraded and a writer first touches a file's deletes, it must fold every existing position delete for that file into the new DV. From then on, readers seeing a DV can ignore matching position delete files entirely. This gives a clean, incremental migration path: old position delete files stay valid until first touch, then disappear from the read path.

## The binary format, byte by byte

DVs are not stored in Parquet. They live in **Puffin** files, Iceberg's container format for binary blobs (previously used mostly for Theta sketches). A Puffin file is a sequence of blobs plus a footer that indexes them; many DVs for many different data files can share one Puffin file, so a commit that updates deletes across 200 data files still writes one physical file.

Each blob uses the `deletion-vector-v1` type:

```
+--------------------------------------------------+
| length of magic + vector      (4 bytes, big-endian)
| magic: D1 D3 39 64            (4 bytes)
| serialized bitmap             (variable)
| CRC-32 of magic + bitmap      (4 bytes, big-endian)
+--------------------------------------------------+
```

The bitmap itself is a **64-bit Roaring bitmap** in the standard "portable" serialization: an 8-byte little-endian count of 32-bit Roaring bitmaps, then for each one a 4-byte little-endian key followed by a standard 32-bit Roaring bitmap. A 64-bit row position splits into a 32-bit key (high 4 bytes) and a 32-bit sub-position (low 4 bytes):

```java
boolean isDeleted(long pos) {
  int key = (int) (pos >>> 32);
  int sub = (int) pos;              // low 32 bits
  RoaringBitmap bm = bitmaps.get(key);
  return bm != null && bm.contains(sub);
}
```

In practice almost every real file has fewer than 2^32 rows, so the structure degenerates to a single 32-bit Roaring bitmap with key 0, and you get Roaring's usual adaptive behavior: sparse deletes stored as sorted 16-bit arrays, dense ranges as bitsets or run-length containers. Deleting rows 0-999,999 of a million-row file costs a handful of bytes.

Notice the endianness split: the outer length and CRC are big-endian while the Roaring payload is little-endian. That is not an accident or an oversight. The spec chose big-endian framing *"for compatibility with existing deletion vectors in Delta tables."* Delta Lake has used this exact Roaring-in-a-checksummed-envelope encoding for its own DVs since 2022, and making the bytes identical means engines like Spark and unified catalogs can share one DV code path across both table formats. Two competing lakehouse formats quietly converged at the byte level.

## How readers find them: no extra file opens

The elegant part is in the manifest layer. In v2, applying deletes meant opening delete *files*, with all the footer-parsing overhead that implies. In v3, delete manifests track each DV individually with three fields:

- `file_path`: the Puffin file containing the blob
- `content_offset`: byte offset of the DV blob, required to exactly match the Puffin footer's offset
- `content_size_in_bytes`: blob length

So a scan task arrives at the executor already knowing the precise byte range of the one bitmap it needs. One ranged GET against object storage, a CRC check, one Roaring deserialization, done. No footer parse, no Parquet decode, no unioning. The manifest also carries `referenced_data_file` (required for DVs), so scan planning can bind DVs to data files using metadata alone, applying the usual rules: the paths match, the DV's sequence number is greater than or equal to the data file's, and the partitions agree.

The `record_count` field of a DV's manifest entry stores the bitmap's cardinality, which lets planners compute live row counts (`file rows - DV cardinality`) without touching a single data byte, something v2 could only approximate.

## What this costs writers

Merge-on-read did not become free; the cost moved. Because there can be only one DV per data file, every delete-producing commit must **read-modify-write** the affected DVs: fetch the old bitmap, OR in the new positions, write a fresh blob, and update the delete manifest to point at it. Under concurrent writers, two transactions deleting from the same data file now conflict where in v2 they could both blindly append delete files. Iceberg's optimistic concurrency handles this with a retry, but hot-file contention is real, and it is the deliberate trade: v2 optimized blind write throughput and drowned readers; v3 makes writers do a small merge so readers do none.

One subtlety in the spec rewards careful reading: when a data file is removed, writers must drop its DV from the delete manifests but *are not required to rewrite the Puffin file*. Dead bitmap bytes linger inside shared Puffin files until maintenance rewrites them. Orphan cleanup therefore has to reason at the blob level, not the file level, a detail that table-maintenance tooling is still catching up on.

## Takeaways

- If you run CDC or frequent upserts on Iceberg, v3 DVs are the single biggest read-path improvement since v2 shipped; the bounded one-DV-per-file invariant is what makes delete application O(1) per data file.
- The format is a lesson in fixing mistakes at the right layer: the row-identification model (file + position) was fine, the *packaging* (many small Parquet files, many-to-many references) was the failure. v3 changed only the packaging.
- Byte-level compatibility with Delta's DVs is a pragmatic signal: the lakehouse format war is increasingly settled by converging on shared primitives rather than by one format winning.

The spec text for all of this is in the Iceberg table spec (Delete Formats, Deletion Vectors) and the Puffin spec (`deletion-vector-v1` blob type), both short and worth reading in full.
