---
title: "Morsel-Driven Parallelism: How Modern Query Engines Achieve Linear Scalability on Many-Core NUMA Systems"
date: 2026-07-09
tags: ["database-internals", "query-execution", "numa", "parallelism", "olap"]
excerpt: "The morsel-driven execution model replaces the traditional Volcano exchange operator with fine-grained, NUMA-aware task scheduling that achieves near-linear scalability on 100+ core machines, powering systems like DuckDB, Umbra, and DataFusion."
---

The Volcano/Exchange model dominated parallel query execution for three decades. Its elegance is undeniable: insert an Exchange operator at any point in the plan tree, and data flows partition across threads via demand-driven iteration. But this elegance collapses on modern NUMA hardware, where the cost of a cross-socket memory access is 3-4x a local one, and core counts routinely exceed 100.

In 2014, Leis et al. introduced **morsel-driven parallelism** at SIGMOD, fundamentally rethinking how database engines schedule parallel work. The key insight: instead of partitioning data statically and pulling through Exchange operators, divide input relations into small, fixed-size chunks (morsels) and let a global dispatcher assign them dynamically to worker threads bound to NUMA-local storage.

## The Volcano Model's Failure Modes

The traditional approach uses Exchange operators to partition data across threads:

```
         HashJoin
        /        \
  Exchange      Exchange
     |              |
   Scan(R)      Scan(S)
```

This suffers from three critical problems on modern hardware:

1. **Static partitioning** — work is divided equally at plan time, but runtime skew (hash collisions, predicate selectivity variance) creates stragglers that dominate wall-clock time.
2. **NUMA blindness** — the Exchange operator shuffles tuples across sockets with no awareness of memory topology, triggering expensive remote DRAM accesses on every cross-partition probe.
3. **Inelasticity** — once threads are assigned to a query, resources cannot be reallocated to other concurrent queries without tearing down and rebuilding exchange state.

## Morsels: The Unit of Parallel Work

A **morsel** is a contiguous chunk of tuples from a base relation, typically 10,000 rows. This size is carefully chosen: large enough to amortize scheduling overhead (the dispatcher cost per morsel assignment is ~100ns), but small enough to enable fine-grained load balancing and rapid response to skew.

The execution model restructures query plans into **pipelines**, maximal sequences of operators that can process tuples without materializing intermediate results:

```
Pipeline 1: Scan(R) → Filter → Build Hash Table
Pipeline 2: Scan(S) → Probe Hash Table → Aggregate
```

Each pipeline's source operator produces morsels. Worker threads request morsels from the dispatcher, process them through the full pipeline, and write results to thread-local storage.

## The Dispatcher: Elastic, NUMA-Aware Scheduling

The dispatcher is the central coordinator that assigns morsels to threads:

```c
struct Dispatcher {
    atomic<uint64_t> morsel_cursor;  // next unprocessed morsel
    uint32_t         numa_node;      // NUMA node of source data
    Pipeline*        pipeline;       // current pipeline being executed
};

// Worker thread main loop
void worker_thread(int thread_id, int numa_node) {
    while (true) {
        Task task = dispatcher.get_next_task(numa_node);
        if (task.type == DONE) break;
        
        // Process morsel through pipeline
        Morsel morsel = task.pipeline->source->get_morsel(
            task.morsel_start, MORSEL_SIZE);
        task.pipeline->execute(morsel, thread_local_state[thread_id]);
    }
}
```

The dispatcher enforces **NUMA locality** by preferentially assigning morsels from data stored on the worker's local NUMA node. When a node's morsels are exhausted, workers can steal from remote nodes, but only after a configurable delay that gives local workers priority.

**Elasticity** emerges naturally: if a long-running analytical query is consuming all cores and a latency-sensitive short query arrives, the dispatcher simply stops assigning morsels of the analytical query to some workers. Those workers pick up the short query's morsels instead. No state teardown, no Exchange operator reconfiguration, just a change in assignment policy.

## NUMA-Aware Hash Join: The Flagship Use Case

The hash join demonstrates morsel-driven parallelism's full power. The build phase works as follows:

1. Each thread processes morsels from the build relation and inserts into **thread-local pre-partitioned buffers**, grouped by NUMA node.
2. Once all build morsels are consumed, a global hash table is allocated with pages interleaved across NUMA nodes proportionally to the number of matching tuples.
3. Each thread populates the hash table entries from its local buffer, writing to the section of the table that resides on its NUMA node.

```c
// Build phase: thread-local partitioning
void build_phase(Morsel& morsel, ThreadState& state) {
    for (auto& tuple : morsel) {
        uint64_t hash = hash_function(tuple.key);
        int target_numa = hash % num_numa_nodes;
        state.partition_buffers[target_numa].append(tuple, hash);
    }
}

// After synchronization barrier: populate global hash table
void populate_hash_table(ThreadState& state, GlobalHashTable& ht) {
    // Each thread writes entries destined for its local NUMA node
    for (auto& entry : state.partition_buffers[my_numa_node]) {
        ht.insert(entry.hash, entry.tuple);
    }
}
```

The probe phase is simpler: each thread processes probe-side morsels and looks up the global hash table. Since the table's NUMA-interleaved layout matches the hash distribution, most probes hit local memory.

## Handling Skew: Adaptive Morsel Sizing

Real data is skewed. Consider a GROUP BY on a column where 80% of rows share the same key. Static partitioning would route 80% of work to one thread. Morsel-driven execution handles this naturally through two mechanisms:

**Fine-grained scheduling** — since morsels are small (10K rows), even heavily skewed data distributes across many morsels. No single morsel assignment dominates execution time.

**Adaptive parallelism for blocking operators** — when a hash table's partitions become unbalanced, the dispatcher can assign additional workers to process the overloaded partition. This is impossible in the Exchange model, where partition-to-thread assignment is fixed.

## Performance: Near-Linear Scalability

The original paper measured TPC-H on a 4-socket, 32-core (64 HT) Intel system. Key results:

- **Linear speedup** up to the physical core count on most queries
- **3-5x improvement** over the Volcano/Exchange model on NUMA systems due to locality
- **< 1% scheduling overhead** — the dispatcher's atomic fetch-and-add on the morsel cursor is the only synchronization point in the critical path
- **Elastic reallocation** in < 1ms when priorities change between concurrent queries

Modern systems push further. Umbra (the successor to HyPer) uses morsel-driven execution with compiled pipelines on 224-core ARM systems. DuckDB implements a simplified morsel-driven model (without full NUMA-awareness) that still achieves near-linear scaling to 128 threads on analytical workloads.

## Evolution: From Morsels to Pipelines-as-Tasks

The 2024 evolution of this model (seen in systems like Apache DataFusion and Velox) treats entire pipeline fragments as schedulable tasks rather than individual morsels:

```rust
// Modern task-based evolution (DataFusion-style)
struct PipelineTask {
    pipeline: Arc<Pipeline>,
    partition: usize,
    morsel_range: Range<usize>,
    output: Arc<Mutex<OutputBuffer>>,
}

impl PipelineTask {
    fn execute(&self) -> Result<()> {
        let batch = self.pipeline.source
            .get_batch(self.partition, self.morsel_range)?;
        let result = self.pipeline.operators
            .iter()
            .fold(batch, |b, op| op.execute(b));
        self.output.lock().push(result);
        Ok(())
    }
}
```

This coarser granularity reduces scheduling overhead while maintaining load-balancing properties. The key tradeoff: fewer, larger tasks mean less dispatcher contention but slower adaptation to skew.

## Why This Matters Now

With ARM server chips (Graviton4: 96 cores, Ampere Altra Max: 128 cores, Grace: 144 cores) and AMD EPYC (up to 192 cores across 12 CCDs, each a NUMA domain), the difference between NUMA-aware and NUMA-blind execution is no longer a percentage improvement, it is the difference between linear and sublinear scaling. Systems that ignore memory topology see throughput plateau at 32-48 threads as cross-socket traffic saturates the interconnect.

Morsel-driven parallelism solved this a decade ago, and its principles now underpin every serious analytical engine: DuckDB, Velox (Meta), DataFusion (Apache Arrow), Umbra, and Photon (Databricks). Understanding the model is understanding how modern OLAP systems achieve their headline performance numbers.

The paper that started it all — Leis, Boncz, Kemper, and Neumann, "Morsel-Driven Parallelism: A NUMA-Aware Query Evaluation Framework for the Many-Core Age" (SIGMOD 2014) — remains one of the most practically influential database research contributions of the last decade.
