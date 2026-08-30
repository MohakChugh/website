---
title: "OpenZL: Shipping the Compressor Inside the Compressed File"
date: 2026-08-30
tags: [compression, data-engineering, systems, file-formats, performance]
excerpt: "Format-aware compressors win big and then rot, because every reader needs the matching decoder. OpenZL embeds the resolved transform graph in each frame so one universal decoder handles all of them. I rebuilt its core thesis on a 10MB record table: structure-aware transforms at zstd -3 hit 2.84x, beating xz -9 on the raw bytes (2.35x) at roughly 60x the throughput — and once the structure is exposed, the entropy backend stops mattering."
---

Every team with a large binary corpus eventually discovers the same thing: a compressor that understands your records beats a general-purpose one by a wide margin. Split the array-of-structs into per-field columns, delta the monotonic clock, tokenize the enum, and a cheap LZ pass suddenly outperforms an expensive one. This is not subtle — the numbers below are 20–50%.

Then the bill arrives. That compressor is now a format, and the format needs a decoder, and the decoder has to exist in every language and every service that will ever read a byte you wrote today. Change the transform pipeline to exploit a new column and you have forked your own archive. Most teams pay this once, get burned, and retreat to `zstd` for everything.

[OpenZL](https://openzl.org), which Meta open-sourced in October 2025, is an attempt to keep the ratio without the format proliferation. The mechanism is worth understanding independently of the library: **the compressed frame carries a description of the transform graph that produced it, and a single universal decoder executes that description.**

## Codecs as nodes, data as edges

An OpenZL compressor is a DAG. Nodes are *codecs* — reversible transforms obeying `decode(encode(x)) == x`. Edges are the data flowing between them. Every path terminates in the `Store` graph, which writes bytes into the output.

The codecs are mostly unglamorous and exactly what you would write by hand: `transpose` (byte *i* of every fixed-width element becomes contiguous), `delta`, `tokenize` (emit a dictionary plus an index stream), `field_lz`, plus entropy backends — Huffman, FSE, bitpacking.

What makes it a framework rather than a pipeline is that routing can be dynamic. Four graph flavours matter:

- **Static graph** — fixed routing, decided when you build the compressor.
- **Selector graph** — a user function inspects one input and picks a successor graph. Sorted integers go one way, unsorted another.
- **Function graph** — the general case. Your function holds a working set of unterminated edges, may run codecs directly, and must assign a successor graph to every edge before it returns.
- **Store graph** — the terminus.

Wiring a static graph in the C API is explicit:

```c
ZL_Compressor* c = ZL_Compressor_create();
ZL_Compressor_setParameter(c, ZL_CParam_formatVersion, ZL_MAX_FORMAT_VERSION);

/* delta the input, hand the residuals to the generic numeric graph */
ZL_GraphID g = ZL_Compressor_registerStaticGraph_fromNode1o(
        c, ZL_NODE_DELTA_INT, ZL_GRAPH_COMPRESS_GENERIC);
ZL_Compressor_selectStartingGraphID(c, g);

ZL_CCtx* cctx = ZL_CCtx_create();
ZL_CCtx_refCompressor(cctx, c);
ZL_TypedRef* in = ZL_TypedRef_createNumeric(data, /*width*/ 8, nbElts);
ZL_Report r = ZL_CCtx_compressTypedRef(cctx, dst, ZL_compressBound(len), in);
```

Note `ZL_TypedRef_createNumeric`: inputs are *typed* (serial, struct, numeric, string), and the type is what lets a numeric codec assume element boundaries instead of guessing them.

## The part worth stealing: the frame is the recipe

At encode time the plan resolves to a concrete graph, and that resolved graph is serialized **into the frame chunk**. Decompression takes no compressor object and no out-of-band schema:

```c
ZL_DCtx* dctx = ZL_DCtx_create();
ZL_TypedBuffer* out = ZL_TypedBuffer_createWrapNumeric(dst, 8, nbElts);
ZL_DCtx_decompressTBuffer(dctx, out, src, srcSize);   /* no compressor needed */
```

The consequences are the interesting bit. Dynamic decisions — a selector that branched on histogram skew, a function graph that noticed a run-length pattern — are *recorded*, not re-derived. The decoder never re-runs your heuristics, so decode is deterministic and coordination-free even if you deploy a new plan tomorrow. Old frames keep decoding under the same binary. You get per-dataset compressors with one decoder to maintain, which is the whole point.

Two caveats that adopters should internalise. First, this guarantee holds **only for standard codecs**. Register a custom codec and you are back to shipping a bespoke decoder everywhere — you have re-created the problem the design exists to solve, with extra steps. Second, the decoder is now an interpreter for a recipe supplied by whoever wrote the file. OpenZL's docs are explicit that the decoder validates the graph and enforces limits before executing it; if you embed this in a service that ingests untrusted archives, that validation is your trust boundary, and resource limits are not optional.

## Measuring the thesis

Meta's headline benchmark (the SAO star catalogue) reports 2.06x versus 1.31x for `zstd -3` and 1.64x for `xz -9`. I wanted to know how much of that is the *structure* and how much is OpenZL's tuned backends, so I rebuilt the pipeline by hand on a synthetic telemetry table — 500,000 rows × 20 bytes: `uint64` monotonic ns clock with jittered gaps, zipf-distributed `uint32` id, skewed `uint16` status enum, lognormal `float32` latency, `uint8` region, sparse `uint8` flags. Three variants, each fed to three off-the-shelf codecs:

| variant | zstd -3 | zstd -19 | xz -9 |
|---|---|---|---|
| A — raw array-of-structs | 1.82x | 1.96x | 2.35x |
| B — struct-of-arrays split | 2.40x | 2.51x | 2.62x |
| C — B + delta / tokenize / transpose | **2.84x** | 2.96x | 2.97x |

Three things fall out.

**Splitting the record beats upgrading the codec.** Variant B at `zstd -3` (2.40x) already edges out `xz -9` on the raw bytes (2.35x), and `xz -9` took 8.8s to `zstd -3`'s 100ms on this machine — a ~90x gap in compression time for a *worse* result. The per-field transforms in C then add another 18%.

**Structure absorbs the work the entropy stage was doing.** On raw AoS, moving from `zstd -3` to `xz -9` buys 22.8% smaller output. On variant C it buys 4.4%. Once each stream is homogeneous, there is little left for a stronger backend to find; this is precisely why OpenZL can post *both* a better ratio and higher throughput rather than trading one for the other. The transforms themselves cost 6.7ms in NumPy — noise against either codec.

**Plans are data-specific, and a wrong transform is expensive.** The delta-then-transpose that shrinks the clock column by 21% makes the id column 66% *larger* than transpose alone (836,208 vs 502,294 bytes), because differencing a non-monotonic sequence destroys the byte-plane redundancy it had. There is no universally good graph, which is the entire justification for the trainer.

## The trainer, and where this stops paying

Since the right graph depends on the data, OpenZL ships an offline trainer: give it samples plus a shape description, and it does a budgeted search over transform choices and parameters, clustering similarly-behaved fields and exploring candidate subgraphs. Output is a serialized compressor you version like any other artifact.

```bash
zli train --profile csv samples/ -o trained_csv.zli
zli compress --compressor trained_csv.zli today.csv -o today.zl
```

Shape can come from a parser you write, or from SDDL, a small declarative layout language:

```
record Sample() {
  timestamp: UInt64LE,
  user_id:   UInt32LE,
  status:    UInt16LE,
  latency:   Float32LE,
  region:    UInt8,
  flags:     UInt8
}
samples: Sample[]
```

SDDL only describes layout — it does not choose codecs. And it is not free: Meta's own CSV numbers cap around 64 MB/s because parsing dominates. On genuinely unstructured text there is no structure to exploit and OpenZL degrades to roughly zstd-equivalent behaviour, which is the correct outcome but not a reason to adopt it.

The honest summary: this pays when you own a high-volume corpus with stable, exploitable record structure — telemetry, columnar exports, numeric arrays, Parquet and protobuf payloads — and it pays mostly because splitting records into homogeneous streams is where the compression lives. The architectural idea worth carrying into your own systems is narrower and more durable than the library: if you must ship a data-specific transform pipeline, ship its description *inside the artifact* and write one interpreter, rather than versioning a decoder per pipeline and discovering in three years that nothing can read 2026.
