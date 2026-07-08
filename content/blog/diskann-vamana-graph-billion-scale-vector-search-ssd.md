---
title: "DiskANN: Billion-Scale Vector Search on a Single Machine with Vamana Graphs"
date: 2026-07-09
tags: ["vector-search", "approximate-nearest-neighbor", "graph-algorithms", "disk-based-indexing", "information-retrieval"]
excerpt: "How Microsoft Research's DiskANN system uses the Vamana graph algorithm, SSD-optimized layout, and PQ-based beam search to serve billion-scale approximate nearest neighbor queries from a single commodity machine, eliminating the need for distributed in-memory indices."
---

# DiskANN: Billion-Scale Vector Search on a Single Machine with Vamana Graphs

Approximate Nearest Neighbor (ANN) search has become the backbone of modern retrieval systems: recommendation engines, RAG pipelines, image search, and anomaly detection all depend on finding the closest vectors in high-dimensional space. The conventional wisdom is that billion-scale ANN requires either massive RAM (HNSW indices for 1B 128-d vectors need ~200GB) or distributed clusters. DiskANN, introduced by Subramanya et al. at NeurIPS 2019, shattered this assumption by serving billion-point indices from a single machine using SSDs, achieving 95%+ recall at sub-millisecond latencies.

## The Core Insight: Graph Search with SSD-Aware Layout

DiskANN's architecture rests on three pillars:

1. **Vamana** — a new graph construction algorithm that produces better navigability than HNSW for disk-resident data
2. **SSD-optimized data layout** — vectors and graph edges co-located in aligned pages
3. **PQ-compressed in-memory beam search** — product quantization codes in RAM guide disk reads, eliminating random I/O

### The Vamana Graph Algorithm

HNSW builds a multi-layer skip-list-like graph where upper layers provide coarse routing. This works brilliantly in RAM but causes random seeks on disk — jumping between layers means reading non-adjacent pages. Vamana takes a different approach: a single, flat graph with a carefully chosen medoid as the navigational entry point.

Construction proceeds as follows:

```
Algorithm: VamanaIndex(P, R, L, α)
Input: point set P, max degree R, search list size L, pruning factor α
Output: directed graph G

1. Initialize G as random R-regular graph
2. Compute medoid s of P (entry point)
3. For each point p in random permutation of P:
   a. Run GreedySearch(s, p, L) → visited set V
   b. Run RobustPrune(p, V, α, R) → new neighbors N(p)
   c. For each n ∈ N(p):
      If |N(n)| ≥ R: RobustPrune(n, N(n) ∪ {p}, α, R)
      Else: N(n) ← N(n) ∪ {p}
```

The key innovation is **RobustPrune** with the α parameter:

```
Algorithm: RobustPrune(p, candidates V, α, R)
1. Sort V by distance to p
2. N(p) ← ∅
3. While V ≠ ∅ and |N(p)| < R:
   a. p* ← argmin_{v ∈ V} dist(p, v)
   b. N(p) ← N(p) ∪ {p*}
   c. Remove from V all v where:
      α · dist(p*, v) ≤ dist(p, v)
```

When α = 1, this is equivalent to the Relative Neighborhood Graph (RNG) pruning used in HNSW. When α > 1 (typically 1.2), edges are allowed that would normally be pruned — creating "long-range" shortcuts that reduce the graph diameter. This is critical for disk: fewer hops means fewer page reads.

**Why a flat graph beats hierarchical on disk:** HNSW's upper layers contain few points spread across many pages. A search traverses 4–6 layers, and each layer transition is a random seek. Vamana's flat graph with α > 1 achieves comparable diameter (~20 hops for 1B points) but all edges are stored contiguously with their source vertex.

### SSD-Optimized Data Layout

Each "sector" on disk (aligned to 4KB pages) stores:

```
┌─────────────────────────────────────────────────┐
│ Node ID (8B) │ Full Vector (512B for 128-d fp32) │
│ Neighbor List: [n₁, n₂, ..., nR] (R × 4B)      │
│ Padding to 4KB alignment                         │
└─────────────────────────────────────────────────┘
```

A single sector read retrieves both the full-precision vector (for distance recomputation) and all outgoing edges. No second read is needed to discover the next hop. For R=64 and 128-dimensional float32 vectors, each node fits in exactly one 4KB page.

### PQ-Compressed Beam Search

The search algorithm uses a two-tier strategy:

**In memory:** Product quantization (PQ) compressed representations of all vectors (~32 bytes per point for 128-d vectors → ~32GB for 1B points). This fits in RAM on a commodity 64GB machine.

**On SSD:** Full-precision vectors and graph structure.

```python
def diskann_search(query, K, W, entry_point, pq_table, ssd_index):
    """
    W: beam width (controls accuracy/latency tradeoff)
    """
    # Priority queue ordered by PQ-approximate distance
    candidates = MinHeap()
    candidates.push((pq_distance(query, entry_point, pq_table), entry_point))
    visited = set()
    result = MaxHeap(capacity=K)  # top-K by exact distance

    while candidates and len(visited) < W:
        _, current = candidates.pop()
        if current in visited:
            continue
        visited.add(current)

        # SINGLE SSD read: gets exact vector + all neighbors
        node_data = ssd_index.read_sector(current)

        exact_dist = l2_distance(query, node_data.vector)
        result.push_if_closer(exact_dist, current)

        # Expand neighbors using PQ distances (no disk read needed)
        for neighbor in node_data.neighbors:
            if neighbor not in visited:
                approx_dist = pq_distance(query, neighbor, pq_table)
                candidates.push((approx_dist, neighbor))

    return result.top_k()
```

The critical performance insight: **PQ distances are computed in RAM to decide which nodes to fetch from SSD.** Only the most promising candidates trigger disk I/O. With W=50, a typical search issues ~50 sequential/batched SSD reads — achievable in <1ms on modern NVMe drives.

## Performance at Scale

On the BIGANN-1B dataset (1 billion 128-dimensional vectors):

| System | Hardware | Recall@10 | QPS | Cost |
|--------|----------|-----------|-----|------|
| HNSW (in-memory) | 256GB RAM | 0.99 | 5,000 | $$$$ |
| IVF-PQ (Faiss) | 64GB RAM | 0.85 | 10,000 | $$ |
| DiskANN | 64GB RAM + NVMe SSD | 0.95+ | 5,000 | $ |

DiskANN achieves 5× lower cost than in-memory HNSW with only a marginal recall reduction. For latency-sensitive applications at 99.5% recall, DiskANN serves queries in ~1–5ms (p99) compared to the infeasibility of fitting the full index in RAM.

## Fresh Vectors and Filtered Search (2024 Extensions)

The original DiskANN required a full offline build. Recent work addresses two critical production needs:

**FreshDiskANN** supports concurrent inserts, deletes, and searches. New vectors are inserted into an in-memory "fresh index" (a small Vamana graph in RAM). Periodically, the fresh index is merged into the SSD-resident index via a background compaction process — conceptually similar to LSM-tree compaction.

**Filtered DiskANN** (ICDE 2024) enables predicate-filtered vector search (e.g., "find similar images where category = 'electronics' AND price < $100"). The approach builds label-specific entry points and prunes the graph traversal using per-node filter metadata stored alongside the vector:

```
Sector Layout (filtered):
┌──────────────────────────────────────────────────────┐
│ Node ID │ Full Vector │ Filter Bitmap (64B)           │
│ Neighbor List │ Per-neighbor filter hints (R × 8B)   │
└──────────────────────────────────────────────────────┘
```

During search, edges to nodes that definitely fail the predicate (according to the bitmap) are skipped without issuing a disk read — maintaining the "few reads" property.

## When to Use DiskANN vs. Alternatives

**Choose DiskANN when:**
- Dataset exceeds available RAM (billions of vectors on commodity hardware)
- Cost efficiency matters more than absolute maximum throughput
- You need high recall (>95%) without distributed infrastructure
- Filtered search is required alongside vector similarity

**Choose HNSW when:**
- Dataset fits in RAM and you need maximum QPS
- Ultra-low latency (<100μs) is required

**Choose IVF-PQ/ScaNN when:**
- You can tolerate lower recall (80–90%) for much higher throughput
- Batch processing workloads dominate

## Implementation Availability

DiskANN is open-source (MIT license) and has influenced production systems including Microsoft Bing's vector search backend. The algorithm is available as a standalone C++ library with Python bindings, and its core ideas have been adopted by Pinecone, Weaviate, and Milvus for their disk-resident index tiers.

The Vamana graph construction with α-pruning has become particularly influential — it demonstrates that a well-engineered flat graph can match or exceed hierarchical structures when the access pattern (sequential SSD reads vs. random RAM access) is the primary constraint. This insight generalizes: the optimal index structure depends not just on the data distribution but on the storage hierarchy it will be queried against.
