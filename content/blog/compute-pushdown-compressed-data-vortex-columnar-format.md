---
title: "Compute on Compressed Data: What Vortex Gets Right, and What Its Benchmarks Don't"
date: 2026-07-26
tags: [columnar-formats, compression, query-execution, parquet, databases]
excerpt: "Parquet's fatal architectural choice is the opaque second compression layer. Once ZSTD touches a page, you cannot read one value without decompressing all of them, and you certainly cannot evaluate a predicate against the bytes as they sit. Vortex removes that layer and pushes comparisons into the encoded domain instead: compare an ALP-encoded float column as bit-packed integers, run a LIKE against FSST codes via a DFA over compressed symbols. The mechanism is genuinely elegant. The '100x faster random access' claim built on top of it does not survive reading the benchmark harness."
---

There is a line in a columnar format's design where a good idea becomes an irreversible mistake, and Parquet crosses it in the same place every time: the second compression layer. A page is first lightweight-encoded (dictionary, RLE, delta), then handed wholesale to ZSTD or Snappy. That second step is opaque. Once it lands the page is an undifferentiated blob — you cannot read row 40,000 without decompressing the 39,999 before it, and you certainly cannot evaluate `l_discount < 0.05` against the bytes as they sit on disk.

Everything downstream inherits that. Random access degrades from O(1) to O(rows per page). Late materialization stops working: you must decompress every column the query touches before computing the row mask that would have told you which rows to skip. The pushdown Parquet does support is purely statistical — min/max footer stats let you skip a row group.

[Vortex](https://github.com/vortex-data/vortex) (Spiral, donated to LF AI & Data in August 2025) never crosses that line. It has no general-purpose compression layer at all: it cascades lightweight encodings, up to three deep, keeping every layer semantically transparent so compute can reach into it.

## The throughput argument for dropping ZSTD

ZSTD decompresses at roughly 1 to 2 GB/s. FastLanes bit-unpacking — a fixed sequence of shifts and masks over a 1024-element chunk — runs at over 100 billion integers per second. Two orders of magnitude. So the question is whether cascades approach ZSTD's *ratio*. On TPC-H SF10, Vortex reports 2,776 MB total against Parquet+ZSTD's 4,465 MB, or 2,016 MB with its compact encoding set. The cascade for a real column, `l_discount`, 8.4M doubles:

```
root: vortex.alp(f64, len=8388608) nbytes=4.19 MB
  metadata: ALPMetadata { exponents: Exponents { e: 14, f: 12 } }
  encoded: fastlanes.bitpacked(i64, len=8388608) nbytes=4.19 MB
    metadata: BitPackedMetadata { bit_width: 4, offset: 0, patches: None }
```

Two layers, ~15x compression, full random access at every level. ALP (Adaptive Lossless floating-Point) discovers these doubles are all `value * 10^-2` and rewrites them as small integers; FastLanes sees those integers need 4 bits each and packs them. Neither step destroys addressability.

## Pushdown into the encoded domain

Because the encodings are transparent, Vortex can rewrite a predicate to operate on the *encoded* representation rather than decoding first. The canonical case is dictionary encoding, where the rewrite is almost trivially correct:

```python
def add(array: DictArray, rhs: Scalar) -> DictArray:
    return DictArray(values=array.values().add(rhs), codes=array.codes())
```

Apply the function to the N unique values, keep the M codes untouched: work becomes proportional to cardinality, not row count. Filter and take are the same shape in reverse — filter the codes, share the values by reference.

ALP is the more surprising one. To evaluate `a < 1.567` against an ALP column, encode the *constant* into the ALP domain. If it round-trips cleanly the predicate becomes `a_encoded < 1567_i64`, running against bit-packed integers and never touching a float. The edge cases are where the engineering lives. If the constant is unrepresentable the operator shifts: for `Gt`, Vortex computes `encode_above(value)` and switches to `Gte`, because for unencodable `v` with representable neighbour `v_a` above it, `v > u ⟺ v_a >= u` for all encodable `u`. And `Eq` against an unencodable constant returns all-false without reading a byte.

FSST strings get the most aggressive treatment. Equality is compressed-domain: compress the RHS literal with the column's own symbol table, then compare raw codes. `LIKE 'prefix%'` and `LIKE '%needle%'` build a DFA whose transitions are defined over FSST *symbol* bytes rather than decompressed characters — the KMP failure function lifted to a byte-level table, then fused into a 256-wide symbol-level table indexed as `transitions[state * 256 + byte]`. Scanning becomes a flat table walk over compressed bytes.

## The safety conditions are the hard part

Pushing a function into a dictionary's values array is sound only under conditions easy to state and easy to get wrong. Vortex's rule declines in six cases; the interesting two hang off these predicates:

```rust
fn is_fallible(&self, options: &Self::Options) -> bool;      // default true
fn is_null_sensitive(&self, options: &Self::Options) -> bool; // default true
```

If the function can error and not every dictionary value is referenced by some code — routine after a slice — evaluating it over the values array can raise on a value the query would never have seen. The rule also bails when `values().len() > codes().len()`, since a sliced dictionary can hold more unique values than remaining rows, making pushdown a pessimization.

Execution is a four-layer loop over a deferred array tree, where `FilterArray` and `ScalarFnArray` are themselves arrays representing work not yet done:

| Layer | Hook | Cost | Example |
|---|---|---|---|
| 1 | `reduce` | metadata | all-true `FilterArray` reduces to its child |
| 2 | `reduce_parent` | metadata | `DictArray` under `ScalarFnArray` pushes into values |
| 3 | `execute_parent` | may read buffers | `RunEndArray` under `SliceArray` binary-searches run ends |
| 4 | `execute` | decode | encoding materializes canonical output |

Layers 1 and 2 run to fixpoint between execution steps, enabling cross-step optimization: once a child decodes, `reduce_parent` rules previously blocked may now match.

Zone pruning is symbolic rather than hardcoded: `falsify` rewrites a filter into a proof expression over `stat(input, aggregate_fn)` placeholders (for `Eq`, the skip proof is `or(gt(min(lhs), max(rhs)), gt(min(rhs), max(lhs)))`), then `bind_stats` lowers those against whatever statistics exist. Missing ones bind to typed nulls, so three-valued logic holds and only a non-null `true` proves skippability. Because statistics are keyed by aggregate function rather than a fixed `Stat` enum, a new encoding can contribute a prunable statistic without a spec change.

## Now the benchmarks

The Vortex README claims "100x faster random access reads (vs. modern Apache Parquet)", "10-20x faster scans", "similar compression ratios." No hardware, no dataset. Worth auditing.

**Independent evidence.** The strongest third-party measurement is AnyBlox (Gienieczko et al., PVLDB 18(11), 2025), which wraps Vortex as one of several formats and discloses its hardware. They measure **greater than 2x lower scan latency** than Parquet on TPC-H under DataFusion, and in DuckDB at SF20 report 33.67 M tuples/s against Snappy Parquet's 16.47 single-threaded, narrowing to 1.5x at 32 threads. The breakdown is more illuminating: the Vortex reader spends ~80% of its time in relational operators, the Parquet reader nearly half its time decoding. Polar Signals independently reports a 70% average query improvement on a production profiling workload, with files 3% *larger*.

**"10-20x faster scans" does not mean queries.** That figure is an inverse geomean of raw decompression throughput ratios (15.87x). Query-level, Vortex's own harness shows ClickBench totals of 13.53s for DuckDB+Vortex against 17.50s for DuckDB+Parquet, about 1.3x. TPC-H on NVMe runs 1.7x at SF10 and 1.17x at SF100 — the advantage narrows with both scale factor and thread count. Over S3 at SF1, Parquet wins outright.

**"Similar compression ratios" is generous.** The same harness reports a geomean size ratio of 1.07x against Parquet, up to 1.38x — Vortex files average 7% *larger*. Defensible given the decode-speed and pushdown wins, but not what the README says. Azim Afroozeh, first author of FastLanes, has criticized exactly this, arguing Vortex looks "worse than Parquet in both storage size and decompression speed" on ClickBench; the vendor's reply blamed a DuckDB version skew across a published comparison.

**"100x faster random access" is a benchmark artifact.** In `vortex-bench/src/random_access/take.rs`, the Parquet accessor never constructs a `RowFilter` or `RowSelection`. It narrows to the touched row groups, forces `with_batch_size(10_000_000)` — with an in-source `FIXME` admitting the indices code assumes batch size equals row group size — decodes every row of those groups in full, then calls `take_record_batch` to throw almost all of it away. It requests the page index with `PageIndexPolicy::Required` and never uses it to skip pages — the single most important Parquet feature here. It reopens the file on every call while Vortex reuses a cached layout reader. Only 100 lookups, local NVMe only. And the vendor's own chart reports ~2600x while showing Lance 8.6x *faster than Vortex* on the same axis.

The underlying claim is directionally real: lightweight encodings give near-O(1) random access where block compression gives O(rows per block), a property of the format rather than the benchmark. But a Parquet reader using `RowSelection` and page-index skipping would close much of the measured gap.

## What to take from it

The architectural thesis holds up: an opaque compression layer forecloses random access and compute pushdown at once, and cascaded lightweight encodings can approach its ratio while preserving both. Two independent sources measure roughly 2x on real scans, and the mechanism — comparing in the encoded domain, DFA matching over compressed symbols, symbolic statistics proofs — is a genuine advance over anything the Parquet spec can express, because Vortex's encoding set is extensible where Parquet's needs a spec change coordinated across sixteen-plus readers.

Two-x on scans plus better pruning is a strong result. It is a shame it is marketed as 100x, because the audit that invites does more damage than the honest number would have.

**References:** [Vortex](https://github.com/vortex-data/vortex) · AnyBlox, PVLDB 18(11):4017-4031, [doi:10.14778/3749646.3749672](https://doi.org/10.14778/3749646.3749672) · BtrBlocks, [doi:10.1145/3589263](https://doi.org/10.1145/3589263) · [FSST](https://www.vldb.org/pvldb/vol13/p2649-boncz.pdf), PVLDB 13(12)
