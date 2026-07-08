---
title: "Query Compilation: The Produce/Consume Model and LLVM Code Generation"
date: 2026-07-09
tags: ["query-compilation", "llvm", "database-internals", "code-generation", "query-execution"]
excerpt: "How modern analytical databases eliminate interpretation overhead by compiling SQL queries into tight native code loops using the produce/consume pipeline model and LLVM IR, achieving order-of-magnitude speedups over traditional Volcano-style iterators."
---

# Query Compilation: The Produce/Consume Model and LLVM Code Generation

The traditional Volcano iterator model has powered relational databases for decades. Each operator implements `open()`, `next()`, and `close()` — tuples flow one at a time through a tree of iterators. It's elegant, composable, and catastrophically slow on modern hardware.

The problem isn't algorithmic complexity — it's microarchitectural. Every `next()` call is a virtual function dispatch. Every tuple crosses multiple operator boundaries. Instruction caches thrash. Branch predictors fail. The CPU spends more time navigating the execution framework than doing actual computation.

Query compilation flips this model entirely: instead of interpreting a query plan at runtime, compile the plan into native machine code where data flows through tight loops with no abstraction overhead.

## The Volcano Problem, Quantified

Consider a simple scan with a filter and projection:

```sql
SELECT price * quantity AS total
FROM orders
WHERE status = 'shipped'
```

In a Volcano executor, processing one tuple requires:
- 3 virtual function calls (one per operator's `next()`)
- 3 tuple format checks and attribute extractions
- Multiple branch mispredictions at each operator boundary
- Zero data locality — each operator touches different instruction cache lines

Thomas Neumann's measurements on HyPer showed that Volcano-style execution spends **only 10% of CPU cycles on actual computation**. The remaining 90% is framework overhead: function calls, tuple routing, and memory stalls.

## The Produce/Consume Pipeline Model

The key insight from Neumann's 2011 VLDB paper is to invert the control flow. Instead of operators pulling tuples from children (demand-driven), operators push tuples to parents (data-driven). This enables fusing multiple operators into a single tight loop.

Each operator implements two functions:

- **`produce()`**: Asks the operator to generate tuples. The operator calls `produce()` on its children, eventually reaching a scan that iterates over data.
- **`consume(tuple, source)`**: Called by a child to push a tuple up. The parent processes it immediately — no buffering, no virtual dispatch.

The critical concept is a **pipeline breaker**: an operator that must materialize all input before producing output (e.g., hash join build side, sort, aggregation). Pipelines between breakers fuse into a single code fragment.

For our example query, the compiled code looks like:

```c
// Fused pipeline: Scan → Filter → Projection → Result
for (int i = 0; i < num_tuples; i++) {
    if (orders[i].status == SHIPPED) {
        result[j++] = orders[i].price * orders[i].quantity;
    }
}
```

No virtual calls. No tuple-at-a-time overhead. The filter predicate is inlined. The projection is a single arithmetic operation. The CPU's branch predictor and prefetcher handle this beautifully.

## Compilation to LLVM IR

Generating C code and invoking `gcc` takes seconds — unacceptable for interactive queries. Instead, systems like HyPer and Umbra generate LLVM Intermediate Representation directly and invoke LLVM's JIT compiler (via ORC or MCJIT), producing native code in **milliseconds**.

The LLVM IR for the fused pipeline above:

```llvm
define void @query_pipeline(%struct.Order* %orders, i64 %n, i64* %result) {
entry:
  br label %loop

loop:
  %i = phi i64 [0, %entry], [%i.next, %loop.end]
  %j = phi i64 [0, %entry], [%j.next, %loop.end]
  %ptr = getelementptr %struct.Order, %struct.Order* %orders, i64 %i
  %status = load i8, i8* %ptr.status
  %cmp = icmp eq i8 %status, 3  ; SHIPPED enum value
  br i1 %cmp, label %match, label %loop.end

match:
  %price = load i64, i64* %ptr.price
  %qty = load i64, i64* %ptr.qty
  %total = mul i64 %price, %qty
  %rptr = getelementptr i64, i64* %result, i64 %j
  store i64 %total, i64* %rptr
  %j.next = add i64 %j, 1
  br label %loop.end

loop.end:
  %i.next = add i64 %i, 1
  %done = icmp uge i64 %i.next, %n
  br i1 %done, label %exit, label %loop

exit:
  ret void
}
```

LLVM then applies its full optimization pipeline: loop unrolling, vectorization, constant propagation, dead code elimination. The resulting x86-64 code is competitive with hand-tuned C.

## Handling Complex Operators

Pipeline breakers (hash joins, sorts, aggregations) split compilation into multiple code fragments connected by materialization points.

A hash join compiles into two pipelines:

```
Pipeline 1 (build): Scan build table → hash → insert into hash table
Pipeline 2 (probe): Scan probe table → hash → probe hash table → emit matches
```

Each pipeline is a single fused loop. The hash table is the materialization boundary between them. Within each pipeline, all operators fuse into one code fragment — the hash computation, any filters, and the insert/probe logic are all inlined.

For aggregation with grouping:

```c
// Pipeline: Scan → Group-By Aggregation (fused)
for (int i = 0; i < n; i++) {
    uint64_t hash = hash_fn(orders[i].customer_id);
    Entry* e = ht_lookup_or_insert(ht, hash, orders[i].customer_id);
    e->sum_total += orders[i].price * orders[i].quantity;
    e->count++;
}
```

The aggregation function itself is inlined into the scan loop — no separate operator boundary.

## Adaptive Compilation: The Umbra Approach

Pure compilation has a problem: LLVM's optimization pipeline takes 5-50ms depending on query complexity. For simple OLTP queries completing in microseconds, compilation latency dominates.

Umbra (the successor to HyPer) solves this with **adaptive execution**: queries begin executing in a bytecode interpreter immediately, while LLVM compiles the native version in a background thread. Once compilation finishes, execution transparently switches to the compiled code mid-query.

The system maintains three execution tiers:

1. **Bytecode interpreter**: Starts immediately. ~5x slower than native but zero startup cost.
2. **Unoptimized native** (LLVM -O0): Ready in ~2ms. ~2x slower than optimized.
3. **Optimized native** (LLVM -O2): Ready in ~20ms. Maximum throughput.

For short queries, the interpreter finishes before compilation completes — no wasted work. For long-running analytical queries, the system transitions to optimized native code and amortizes compilation cost over billions of tuples processed.

## Compilation vs. Vectorization: A False Dichotomy

DuckDB uses vectorized execution (processing 1024-tuple batches through operators). Query compilation generates per-query native code. Which is better?

The answer is nuanced:

| Dimension | Compilation | Vectorization |
|-----------|-------------|---------------|
| Startup latency | Higher (ms for LLVM) | Near-zero |
| Steady-state throughput | Higher (no interpretation) | Slightly lower |
| Code complexity | Very high (IR generation) | Moderate |
| Debugging | Difficult (generated code) | Straightforward |
| SIMD utilization | Implicit (via LLVM autovectorizer) | Explicit (hand-tuned kernels) |

Modern systems increasingly combine both. Umbra uses compilation for the overall pipeline structure but calls vectorized primitives for specific operations (hashing, string comparisons) where hand-tuned SIMD kernels outperform what LLVM autovectorizes.

## Practical Impact

The performance difference is dramatic. On TPC-H at scale factor 100:

- Volcano interpretation: **baseline**
- Vectorized (DuckDB-style): **5-10x faster**
- Compiled (HyPer/Umbra-style): **10-50x faster** on computation-bound queries

The gap narrows on memory-bound queries where execution speed is limited by DRAM bandwidth regardless of interpretation overhead. It widens on computation-heavy queries with complex expressions, many predicates, or string operations.

## Implementation Considerations

Building a compiling query engine requires solving several engineering challenges:

**Error handling**: Generated code must handle NULL propagation, overflow, division by zero, and type coercion without the safety net of an interpreter framework.

**Memory management**: Pipeline-fused code must coordinate buffer allocation for intermediate results at materialization points.

**Profiling**: When generated code is a single monolithic function, standard profilers give limited insight. Systems instrument the IR with counters before compilation.

**Reproducibility**: The same SQL query may compile to different native code depending on schema statistics, available memory, or parallelism degree — making bug reproduction harder.

Despite these challenges, query compilation has become the performance frontier for analytical databases. The produce/consume model with LLVM code generation represents a fundamental shift: treating each query not as a data structure to interpret, but as a program to compile.
