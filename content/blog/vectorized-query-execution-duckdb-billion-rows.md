---
title: "Vectorized Execution: How DuckDB Processes a Billion Rows Per Second on a Laptop"
date: 2026-07-08
tags: [databases, query-execution, simd, duckdb, performance]
excerpt: "Push-based pipelines, morsel-driven parallelism, and selection vectors: the three architectural bets that let an in-process database saturate modern hardware without a cluster."
---

# Vectorized Execution: How DuckDB Processes a Billion Rows Per Second on a Laptop

The analytical database world spent two decades scaling *out*: more nodes, more shuffles, more network hops. DuckDB took the opposite bet. By combining vectorized execution, morsel-driven parallelism, and a push-based pipeline model, it processes TPC-H SF100 (100GB) on a single laptop faster than many distributed engines process it on a cluster. The core insight: modern CPUs are so fast that the bottleneck is usually the execution engine's inability to keep them fed, not raw compute.

## The Volcano Tax

Traditional query engines follow the Volcano (iterator) model: each operator implements `next()`, pulling one tuple at a time from its child. The appeal is composability, every operator is a black box. The cost is catastrophic:

```
// Classic Volcano: one virtual call per tuple per operator
while (tuple = child->next()) {
    if (predicate(tuple)) emit(tuple);
}
```

For a three-operator pipeline processing 100M rows, that's 300M virtual function calls, 300M branch predictions, and zero opportunity for SIMD. Worse, each tuple might be a pointer chase through a heap-allocated row. On a modern CPU doing 5 billion operations/second, the overhead of *driving* the engine dominates the actual computation.

## Vectors as the Unit of Work

Vectorized execution (pioneered by MonetDB/X100 and refined in systems like Hyper and DuckDB) replaces the single-tuple pull with batched processing. The fundamental unit becomes a **vector**, typically 2048 values of a single column:

```cpp
struct Vector {
    data_ptr_t data;         // contiguous column values
    ValidityMask validity;   // null bitmap, 1 bit per value
    SelectionVector sel;     // which indices are "active"
    idx_t count;             // how many active values
};
```

Operators process vectors, not tuples. A filter becomes a tight loop over a flat array:

```cpp
// Vectorized filter: no virtual calls, SIMD-friendly
idx_t select_gt(Vector &col, int threshold, SelectionVector &result) {
    idx_t count = 0;
    auto data = (int32_t *)col.data;
    for (idx_t i = 0; i < col.count; i++) {
        result[count] = i;
        count += (data[i] > threshold);  // branchless
    }
    return count;
}
```

That branchless increment (`count += predicate`) compiles to a conditional move. No branch mispredictions. The compiler auto-vectorizes the inner loop, processing 8 int32 comparisons per AVX2 instruction. A single core can evaluate 4 billion predicates per second this way.

## Selection Vectors: The Key Abstraction

The `SelectionVector` is what makes the entire architecture work without materializing intermediate results. When a filter passes 30% of rows, a tuple-at-a-time engine physically copies survivors into a new buffer. A vectorized engine simply records *which indices* passed:

```
Input vector:    [10, 3, 7, 15, 2, 9, 11, 4]
Filter: x > 6
Selection vec:   [0, 2, 3, 5, 6]  // indices that passed
Count: 5
```

Downstream operators read through the selection vector, skipping eliminated rows without touching memory. This is late materialization at the operator level: the physical data never moves until it absolutely must (e.g., a hash table build or final output).

The elegance compounds. A second filter on the same chunk simply narrows the selection vector further. No intermediate allocations, no copies, and the L1 cache stays warm because the same 2048-value vector is reused across multiple operators.

## Push-Based Pipelines

DuckDB uses a **push-based** model rather than pull-based. Instead of leaf operators waiting to be asked for data, the source *pushes* vectors through a pipeline of operators:

```
Pipeline 1: Scan → Filter → Projection → Hash Build (pipeline breaker)
Pipeline 2: Scan → Filter → Hash Probe → Aggregation
```

A **pipeline breaker** is any operator that must consume its entire input before producing output (hash join build side, sort, aggregation). Between breakers, operators fuse into a single tight loop:

```cpp
void Pipeline::execute(DataChunk &chunk) {
    // Source pushes a chunk, each operator transforms in place
    for (auto &op : operators) {
        op.execute(chunk);
        if (chunk.size() == 0) return; // filter eliminated everything
    }
    sink->sink(chunk); // pipeline breaker consumes
}
```

Push-based execution eliminates the call-stack overhead of Volcano's recursive `next()` calls. The entire pipeline is a flat loop, and the compiler can reason about it as a single unit for register allocation and instruction scheduling.

## Morsel-Driven Parallelism

The parallelism model is where DuckDB diverges most sharply from both Volcano (exchange operators, static partitioning) and the MapReduce lineage (shuffle-everything). Instead, it uses **morsel-driven parallelism** from the HyPer database:

1. The table is divided into **morsels** (typically 100K-200K rows)
2. Worker threads pull morsels from a shared work queue
3. Each thread processes an entire pipeline fragment on its morsel independently
4. Pipeline breakers use concurrent data structures (partitioned hash tables, lock-free aggregation)

```
Table (100M rows)
  ├── Morsel 0..100K   → Thread 0 → Pipeline → Local HT partition
  ├── Morsel 100K..200K → Thread 1 → Pipeline → Local HT partition
  ├── Morsel 200K..300K → Thread 2 → Pipeline → Local HT partition
  ...
  └── Final merge of partitioned hash tables
```

The key property: there are no exchange operators, no repartitioning, no network shuffles. Each thread processes data that's (mostly) already in its L3 cache region. The hash table is pre-partitioned by thread, so the build phase is entirely lock-free. Only the final merge requires coordination, and it's a simple concatenation of disjoint partitions.

This scales nearly linearly with core count. On a 16-core laptop, DuckDB achieves 14-15x speedup on TPC-H queries: almost zero coordination overhead.

## Adaptive Operators

Static vectorized execution leaves performance on the table when data distributions vary within a query. DuckDB employs several adaptive techniques:

**Adaptive aggregation** switches between sorted and hash-based grouping based on the observed number of groups. Few groups (< 256)? Use a perfect hash array. Many groups? Fall back to a partitioned hash table with Robin Hood probing.

**Zonemap pruning** tracks min/max per row group (typically 122K rows). A filter on `date > '2024-01-01'` can skip entire row groups without reading them, combining the benefits of columnar storage with runtime elimination.

**Compression-aware scanning** reads Constant, Dictionary, RLE, or BitPacking encoded segments directly into vectors, often executing filters *on the compressed representation*. A dictionary-encoded string column can evaluate `WHERE name = 'Alice'` by finding Alice's dictionary code once, then scanning 1-byte codes instead of variable-length strings.

## Why This Matters Beyond DuckDB

The vectorized execution model is now the consensus architecture for analytical engines. Velox (Meta's execution library), DataFusion (Apache Arrow's Rust engine), Polars, and ClickHouse all use variants of this approach. The principles transfer directly:

1. **Batch your work.** Whether it's database vectors, network packet batches, or ML tensor operations, amortizing per-item overhead across thousands of items is the single highest-leverage optimization on modern hardware.

2. **Defer materialization.** Selection vectors, validity masks, and lazy evaluation all share a principle: don't copy data until you must. Memory bandwidth is the real bottleneck at scale.

3. **Make parallelism data-driven, not operator-driven.** Morsel-driven execution avoids static partitioning's load imbalance and exchange operators' synchronization overhead. The same principle applies to any work-stealing parallel system.

4. **Align with hardware.** Sequential memory access, branchless code, and SIMD all yield 10-50x improvements over naive implementations. The gap between "correct" and "fast" code has never been wider.

The era of "just add more machines" is giving way to "first, use the machine you have." Vectorized execution is how.
