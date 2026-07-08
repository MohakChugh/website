---
title: "Bw-Tree: Lock-Free B+ Trees for Multi-Core Database Scalability"
date: 2026-07-08
tags: ["data-structures", "databases", "concurrency", "lock-free", "performance"]
excerpt: "How the Bw-Tree achieves latch-free concurrent access to B+ tree indexes through delta chains, an indirection mapping table, and epoch-based garbage collection, enabling linear scalability on modern many-core hardware."
---

# Bw-Tree: Lock-Free B+ Trees for Multi-Core Database Scalability

Traditional B+ trees guard structural modifications with latches (lightweight locks). On a 4-core machine this is acceptable. On a 64-core server executing millions of index operations per second, latch contention becomes the dominant bottleneck. Cache-line bouncing from shared latch words alone can reduce throughput by 40-60% under high concurrency, even with optimistic read-latch protocols.

The Bw-Tree (Buzzword-Tree), introduced by Levandoski et al. at Microsoft Research (VLDB 2013) and refined through 2024 with the OpenBw-Tree project, eliminates all latches from the B+ tree by combining three architectural innovations: an indirection mapping table that decouples logical page identifiers from physical memory locations, prepended delta chains that express modifications without in-place mutation, and epoch-based garbage collection that safely reclaims unreachable state. The result is a fully lock-free index structure that scales linearly to 72+ cores.

## The Latch Problem in Classical B+ Trees

In a conventional B+ tree, concurrent access requires latch coupling (also called lock coupling or crabbing): a thread acquires a latch on the parent node before descending to a child, releasing the parent once the child is latched. Structural Modification Operations (SMOs) like splits and merges require exclusive latches on multiple nodes simultaneously.

The performance impact is severe:

```
Threads:    1     4     8    16    32    64
Latch B+:  5.2M  12M   14M  15M  13M   9M   ops/sec (contention collapse)
Bw-Tree:   4.8M  18M   35M  64M  115M  210M ops/sec (linear scaling)
```

Even read-only workloads suffer because shared-mode latches still require atomic compare-and-swap (CAS) on the latch word, invalidating the cache line on every core that held it.

## Architecture: The Mapping Table

The first key insight is introducing a level of indirection. Every logical page in the Bw-Tree is identified by a **Page ID (PID)**. A central **mapping table** maps each PID to the current physical memory address of that page's state:

```
Mapping Table (array indexed by PID)
┌───────┬──────────────────────┐
│ PID 0 │ 0x7f3a_0000_1000     │ ──→ [Page 0 state]
│ PID 1 │ 0x7f3a_0000_2800     │ ──→ [Delta → Delta → Base Page]
│ PID 2 │ 0x7f3a_0000_3400     │ ──→ [Base Page]
│  ...  │         ...          │
└───────┴──────────────────────┘
```

Node pointers within the tree store PIDs, not raw addresses. To follow a child pointer, a thread reads `mapping_table[child_pid]` to obtain the current physical address. This single indirection enables atomic structural changes: replacing a page's entire state is a single CAS on the mapping table entry.

```c
// Atomic page replacement via CAS on mapping table
bool install_page(pid_t pid, void* expected, void* new_state) {
    return __atomic_compare_exchange_n(
        &mapping_table[pid],
        &expected,
        new_state,
        false,
        __ATOMIC_SEQ_CST,
        __ATOMIC_SEQ_CST
    );
}
```

If the CAS fails, another thread modified the page concurrently. The failing thread simply re-reads the mapping table entry and retries its operation against the new state. No blocking occurs.

## Delta Chains: Append-Only Modifications

The second innovation avoids in-place page modification entirely. Instead of mutating a base page (which would require latching), modifications are expressed as **delta records** prepended to the page's state chain:

```
mapping_table[PID 1] ──→ [Insert(key=42, val=X)]
                              │
                              ▼
                         [Delete(key=17)]
                              │
                              ▼
                         [Base Page: sorted array of (key,val) pairs]
```

To install a new delta record, a thread:
1. Allocates a delta record on the heap
2. Sets the delta's `next` pointer to the current mapping table entry for that PID
3. CAS the mapping table entry from the old address to the new delta address

```c
typedef struct delta_record {
    enum { INSERT, DELETE, SPLIT, MERGE } type;
    uint64_t key;
    void*    value;
    void*    next;  // points to previous delta or base page
} delta_record_t;

void bw_insert(pid_t pid, uint64_t key, void* value) {
    delta_record_t* delta = alloc_delta(INSERT, key, value);
    void* expected;
    do {
        expected = mapping_table[pid];
        delta->next = expected;
    } while (!install_page(pid, expected, delta));
}
```

Multiple threads can concurrently prepend deltas to the same page. Only one CAS succeeds per contention window; the losers retry with minimal cost (re-read the pointer, update their delta's `next` field, retry CAS). No thread ever blocks.

## Page Search with Delta Traversal

Reading a key requires traversing the delta chain from newest to oldest until the key is found or the base page is reached:

```c
void* bw_search(pid_t pid, uint64_t key) {
    void* current = mapping_table[pid];
    while (is_delta(current)) {
        delta_record_t* d = (delta_record_t*)current;
        if (d->key == key) {
            return (d->type == INSERT) ? d->value : NOT_FOUND;
        }
        current = d->next;
    }
    // Reached base page: binary search the sorted array
    return base_page_search((base_page_t*)current, key);
}
```

Long delta chains degrade read performance. When a chain exceeds a threshold (typically 8-16 deltas), a thread triggers **consolidation**: it creates a new base page incorporating all pending deltas, then CAS-installs it to replace the entire chain. Failed consolidation attempts are harmless (another thread consolidated first).

## Structural Modifications Without Locks

Splits and merges in classical B+ trees are the hardest operations to make concurrent because they modify multiple nodes atomically. The Bw-Tree decomposes each SMO into a sequence of single-CAS steps, each independently visible and recoverable:

### Split Protocol (half-split then parent update)

**Step 1 — Logical split:** Allocate new page Q with the upper half of page P's keys. Prepend a **split delta** to P's chain indicating "keys > separator have moved to PID Q":

```
mapping_table[PID_P] ──→ [SplitDelta(sep=50, sibling=PID_Q)]
                              │
                              ▼
                         [Base Page P: keys 10..90]

mapping_table[PID_Q] ──→ [Base Page Q: keys 51..90]
```

**Step 2 — Parent update:** Insert `(separator=50, child=PID_Q)` into the parent page as a regular index-entry delta.

Between steps 1 and 2, the tree is in a valid but "pending split" state. Any thread encountering the split delta on P while searching for key > 50 simply follows the sibling pointer to Q. Other threads can complete the pending split if the initiator crashes.

### Merge Protocol (similar two-phase approach)

Merging uses a **merge delta** on the smaller sibling and a **remove-entry delta** on the parent. The mapping table pointer for the removed PID is tombstoned and recycled after garbage collection confirms no thread holds a reference.

## Epoch-Based Garbage Collection

Delta records and old base pages cannot be freed immediately; concurrent readers may still be traversing them. The Bw-Tree uses **epoch-based reclamation** (conceptually similar to RCU in the Linux kernel):

1. A global epoch counter advances periodically (every ~40ms)
2. Each thread registers its current epoch when entering the index
3. Retired memory (replaced deltas, old base pages) is tagged with the epoch at retirement
4. Memory is freed only when all threads have advanced past the retirement epoch

```
Global epoch: 42
Thread A: entered at epoch 41, still reading old delta chain
Thread B: entered at epoch 42, sees consolidated page
Retired memory tagged epoch 40: safe to free (all threads past 40)
Retired memory tagged epoch 41: NOT safe (Thread A still in epoch 41)
```

This is the same technique used in crossbeam-epoch (Rust) and Linux kernel RCU. The Bw-Tree's contribution is integrating it with delta chain consolidation and SMO cleanup to form a complete lock-free lifecycle.

## Performance Characteristics

Benchmarks from the OpenBw-Tree project (2024) on a dual-socket 72-core Intel Xeon demonstrate:

| Workload | Bw-Tree | Masstree | ART+RWLock | std::map+mutex |
|----------|---------|----------|------------|----------------|
| 100% Read, 72 threads | 210M ops/s | 180M ops/s | 95M ops/s | 8M ops/s |
| 50% Read / 50% Write | 145M ops/s | 120M ops/s | 42M ops/s | 5M ops/s |
| 100% Write (insert) | 98M ops/s | 75M ops/s | 28M ops/s | 3M ops/s |
| Scan (range query) | 850 MB/s | 920 MB/s | 1.1 GB/s | 780 MB/s |

The Bw-Tree excels at mixed read-write workloads due to zero contention between readers and writers. Its weakness is sequential scan performance: delta chain traversal and mapping table indirection add latency per record compared to a flat sorted array. ART with read-write locks wins scans because its node layout is cache-line-dense.

## Practical Trade-offs

**Delta chain length vs. read latency:** Longer chains amortize CAS operations but increase search cost. Production systems tune the consolidation threshold (8-16 deltas) based on read-to-write ratio.

**Mapping table size:** The table must be pre-allocated to the maximum number of pages. Dynamic resizing requires a stop-the-world phase or a secondary indirection layer (adding latency).

**Memory overhead:** Each delta record is a separate heap allocation (24-40 bytes of metadata plus the payload). Cache-unfriendly pointer chasing during chain traversal is the primary performance tax. Modern implementations use arena allocation to keep delta chains physically contiguous.

**GC pause sensitivity:** Epoch advancement stalls if any thread enters a long-running operation without advancing its local epoch. Production deployments cap operation duration and force epoch re-registration on long scans.

## Production Deployments

The Bw-Tree architecture powers several production systems: Microsoft's Hekaton in-memory OLTP engine (SQL Server), Azure Cosmos DB's internal indexing layer, and the FASTER key-value store. The OpenBw-Tree project (CMU Database Group, 2024) provides an open-source implementation that addresses several performance issues in the original design, including cache-line-aware delta allocation and NUMA-aware mapping table partitioning.

For workloads dominated by point lookups and inserts on many-core hardware (OLTP, real-time analytics ingestion, session stores), the Bw-Tree offers a compelling alternative to latch-based indexes. For scan-heavy analytical queries, the overhead of delta chain traversal and indirection makes traditional B+ trees with optimistic lock coupling (as in Umbra or DuckDB) the better choice. The decision hinges on your contention profile: if latch acquisition appears in your CPU profiles, the Bw-Tree eliminates it entirely.
