---
title: "DuckLake: What Happens When Lakehouse Metadata Stops Pretending It Isn't a Database"
date: 2026-09-21
tags: ["lakehouse", "data-engineering", "metadata", "parquet", "databases"]
excerpt: "Iceberg and Delta were designed so table metadata could live as files on object storage — then both quietly bolted a database-backed catalog on top to get atomic commits. DuckLake (DuckDB Labs, 2025) follows that concession to its logical end: put ALL metadata — snapshots, schemas, file lists, statistics — in ordinary SQL tables, keep only Parquet data and delete files on the object store. Query planning collapses from a chain of sequential S3 GETs over JSON and Avro manifests into one SQL query; commits become row inserts in an ACID transaction, which makes multi-table transactions and million-snapshot histories free."
---

# DuckLake: What Happens When Lakehouse Metadata Stops Pretending It Isn't a Database

Open table formats won. Parquet files on object storage, plus a metadata layer that turns "a pile of files" into a table with snapshots, schema evolution, and ACID-ish commits — that architecture now underpins most serious analytics stacks. But the metadata layer itself is where the bodies are buried, and in May 2025 DuckDB Labs published [DuckLake](https://ducklake.select/), a format whose entire thesis is that the incumbent designs are built on a premise everyone has already abandoned.

## The catalog contradiction

Apache Iceberg's metadata is a tree of files on the object store. A table's root metadata JSON holds the schema history and the full snapshot list. Each snapshot points to a *manifest list* (Avro), which points to *manifest files* (Avro), which finally enumerate the Parquet data files with per-column statistics. Reading a table cold means walking that chain: fetch the root JSON, fetch the manifest list, fetch the relevant manifests, prune, then start on actual data. Each hop is a sequential object-store round trip — tens to hundreds of milliseconds of latency before the first data byte — because you can't know which file to fetch next until you've parsed the previous one.

Writing is worse. A commit means writing new manifests and a new root metadata file, then atomically swapping the pointer to the current root. Object stores historically couldn't do that swap safely (S3 only got compare-and-swap via conditional writes in late 2024), and even where they can, the formats only version *single tables* — there is no atomic commit across two tables. So Iceberg grew a *catalog service*: a REST endpoint, backed by a transactional database, whose job is to hold that one pointer per table and swap it atomically.

This is what the DuckLake authors call the format's central contradiction: Iceberg and Delta were explicitly designed to avoid requiring a database, conceded that they need one anyway for correctness, and then never revisited the rest of the design in light of that concession. The database is already in the architecture — it's just being used to store a single pointer, while megabytes of snapshot lists, schema history, and file statistics get re-serialized into Avro on every commit and re-fetched over HTTP on every read.

## The DuckLake bet: it's all just rows

DuckLake keeps exactly two kinds of state:

1. **Data and delete files** — immutable Parquet on any storage (S3, GCS, Azure, NAS, local disk). These stay byte-compatible with what Iceberg writes, which permits metadata-only migration.
2. **Everything else** — in ordinary SQL tables, in any ACID database with primary-key support. A DuckDB file for a laptop-scale lake, PostgreSQL for a team, Spanner-class systems if you must.

The catalog schema is small and readable. Snapshots live in `ducklake_snapshot` and `ducklake_snapshot_changes`; schema objects in `ducklake_schema`, `ducklake_table`, `ducklake_column`; the file inventory in `ducklake_data_file` and `ducklake_delete_file`; statistics in `ducklake_table_stats` and `ducklake_file_column_stats`; partition metadata in `ducklake_partition_info` and `ducklake_file_partition_value`. Rows that describe schema objects carry `begin_snapshot`/`end_snapshot` validity ranges, so schema evolution and time travel are the same mechanism: a query at snapshot *S* filters every metadata table to rows valid at *S*.

That turns query planning into one round trip. Conceptually:

```sql
-- "which files do I scan for table T at snapshot S,
--  given predicate col3 > 100?"
SELECT f.path, f.file_size_bytes, d.path AS delete_file
FROM ducklake_data_file f
LEFT JOIN ducklake_delete_file d
       ON d.data_file_id = f.data_file_id
      AND d.begin_snapshot <= :S AND coalesce(d.end_snapshot, 1e18) > :S
JOIN ducklake_file_column_stats s
       ON s.data_file_id = f.data_file_id AND s.column_id = :col3
WHERE f.table_id = :T
  AND f.begin_snapshot <= :S AND coalesce(f.end_snapshot, 1e18) > :S
  AND s.max_value > 100;          -- stats-based pruning in the catalog
```

Schema resolution, partition pruning, and min/max pruning all happen inside that single query, executed by a database that has indexes, a buffer pool, and forty years of optimization behind it — instead of by the client re-implementing pruning over freshly downloaded Avro. For low-latency workloads the difference isn't marginal: it's one ~millisecond SQL round trip versus a dependent chain of object-store GETs.

## Commits are transactions, so transactions come free

A DuckLake write does the slow part first and the coordinated part last: stage the new Parquet files to the object store (no coordination needed — they're invisible until referenced), then run one SQL transaction that inserts rows into `ducklake_data_file`, updates table and column statistics, and appends a row to `ducklake_snapshot`.

Everything that's painful in file-based formats falls out of this:

- **Multi-table atomic commits.** One database transaction can add a snapshot to ten tables. Iceberg's single-table version chain simply cannot express this; DuckLake gets it from the catalog's own ACID guarantees.
- **Cheap snapshots.** A snapshot is "a few rows," not a rewritten root file carrying the full history. Millions of retained snapshots are fine; there's no compulsory metadata compaction treadmill.
- **Sane concurrency.** Conflicting writers are arbitrated by the database at row granularity, rather than by optimistic swap-and-retry on a single table pointer where every commit conflicts with every other commit on that table.
- **Small writes without small-file hell.** *Data inlining* stores tiny inserts as rows in catalog-side tables (`ducklake_inlined_data_tables`), giving sub-millisecond appends; the data spills to Parquet later, in sensible file sizes. This is a streaming-ingest answer that file-based formats structurally can't give — their minimum write is a file plus a metadata commit.

There's a quieter capability hiding in the same design: because the catalog knows every file and can hold per-file encryption keys, DuckLake supports encrypting all Parquet files, with keys living only in the catalog — the object store becomes untrusted bulk storage ("zero-trust data hosting").

## Doesn't this just reinvent the database?

Yes — deliberately, and only for metadata. The standard objection is that a SQL catalog is a scaling bottleneck and a single point of coordination. The counterargument in the manifesto is empirical: metadata is *tiny* relative to data. A lake with a million data files needs a few million metadata rows — a workload a single PostgreSQL instance dispatches without noticing, and this is precisely the architecture the closed systems that predate the lakehouse converged on internally: BigQuery keeps its table metadata in Spanner, Snowflake in FoundationDB. The lakehouse movement rebuilt those systems' storage layer in the open but replaced their metadata layer with files, mostly because "no database required" sounded operationally attractive in 2017 — right up until the catalog service reintroduced the database anyway.

The honest trade-offs sit elsewhere. First, availability: the catalog database is now on the read path, so it must be as available as the data (in Iceberg, a down catalog at least theoretically leaves metadata files readable). Second, interoperability: Iceberg's REST catalog is a wire protocol any engine can implement once, whereas DuckLake asks every engine to speak SQL against a shared schema — a much lower implementation bar (the spec is a set of table definitions and queries, not a Thrift/Avro/JSON parsing stack), but one with far less ecosystem gravity behind it today. The Iceberg-compatible file layout is the hedge: keep the expensive part (petabytes of Parquet) portable, treat the cheap part (metadata) as convertible in either direction.

The interesting thing about DuckLake isn't whether it displaces Iceberg — with Iceberg v3 absorbing ideas like deletion vectors and the catalogs growing ever more database-shaped, convergence seems likelier. It's that it names the design smell precisely: once you accept a transactional database into your architecture for one pointer swap, refusing to use it for the other 99% of your metadata isn't purity. It's just latency.
