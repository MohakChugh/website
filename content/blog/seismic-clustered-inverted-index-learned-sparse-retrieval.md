---
title: "Seismic: Why WAND Fails on Learned Sparse Embeddings, and What Replaces It"
date: 2026-07-29
tags: [information-retrieval, sparse-retrieval, inverted-index, splade, ann]
excerpt: "Learned sparse models like SPLADE produce vectors that look like inverted-index input but behave nothing like it. Exact retrieval with a state-of-the-art WAND implementation takes 100 milliseconds per query on MS MARCO, worse than brute-force dense search. Seismic fixes this by throwing out document-ID ordering entirely: statically prune each list, cluster it into geometrically cohesive blocks, attach a quantized upper-bound summary to each block, and skip blocks whose summary cannot beat the current heap. The result is 187 microseconds at 90% recall, single threaded."
---

Learned sparse retrieval is the awkward middle child of neural search. A model like SPLADE encodes a passage into a vector over the 30,000-term BERT WordPiece vocabulary, where each nonzero is a learned importance weight rather than a term frequency. The appeal is obvious: interpretable by construction, better out-of-domain generalization than many dense encoders, and an apparently direct fit for the inverted index, the most heavily optimized structure in all of information retrieval.

That last assumption is where things fall apart. On MS MARCO passage with SPLADE embeddings, PISA, a tuned C++ implementation of blocked WAND, needs roughly **100,325 microseconds per query** single threaded. That is 100 milliseconds to retrieve ten documents from 8.8 million, from a structure whose entire purpose is to make this fast.

Seismic, from Sebastian Bruch, Franco Maria Nardini, Cosimo Rulli, and Rossano Venturini (SIGIR '24, arXiv:2404.18812), reaches 90% recall@10 on the same data in **187 microseconds**, and 97% in 531. The interesting part is not the speedup multiple, it is the diagnosis of why the classical machinery fails.

## Two distributional violations

Dynamic pruning algorithms like WAND and MaxScore are rank-safe: they return the exact top-k while skipping postings that provably cannot enter the result set. Each inverted list carries an upper bound on the contribution any document in it can make, and the sum of per-list bounds is compared against the current k-th best score. Skip when the sum cannot win.

This works spectacularly for BM25 and fails for learned sparse vectors, for two compounding reasons.

**Queries are no longer short.** A keyword query has a handful of terms. SPLADE expands queries, so an MS MARCO query averages **43 nonzero coordinates** and its documents 119. Every extra query term is another list to traverse and another term in the upper-bound sum, loosening that sum and making the skip condition harder to satisfy. PISA is far faster on the two sparser models in the same evaluation, 7,947 microseconds on Efficient SPLADE (5.9 query nonzeros) and 9,214 on uniCoil-T5 (6). Query density dominates, not collection size.

**Impact distributions are flatter than term frequencies.** With BM25, a few documents per list score dramatically higher than the rest, so the max-score bound is informative. Learned weights are smoother, the bound becomes a weak predictor of the list's contents, and rank-safe pruning degenerates toward full traversal.

Seismic starts from an empirical property the authors call **concentration of importance**. Sort a SPLADE vector's entries by magnitude and measure the L1 mass the prefix retains: the top 10 query coordinates carry 75% of the query's mass, the top 50 document coordinates (about 30% of nonzeros) carry 75% of the document's. More usefully, the property survives into the inner product. Keeping only the top 9 query and top 20 document coordinates preserves **85% of the full inner product** on average; 12 and 25 preserves 90%.

That is the license to be approximate. WAND's inefficiency here is not an implementation problem, it is a mismatch between a rank-safe bound and a distribution in which that bound is uninformative. Relaxing correctness from exact top-k to 97% recall of exact top-k moves achievable latency by two orders of magnitude.

## Three knobs, three structures

Seismic keeps the inverted index, abandons document-ID ordering, and pairs it with a forward index of complete vectors. Indexing takes exactly three hyperparameters.

**λ, static list truncation.** For coordinate `i`, gather every document with a nonzero at `i`, sort by that coordinate's value descending, keep the first λ. Everything past λ is deleted permanently. On MS MARCO the tuned value is λ = 6,000, out of lists that can hold millions of postings.

**β, blocks per list.** Partition each truncated list into at most β blocks by clustering the documents' full vectors, so a block groups geometrically similar documents rather than adjacent IDs. The clustering is deliberately cheap: sample β documents uniformly at random as representatives, then assign each document to the representative maximizing the inner product. One pass, no Lloyd iterations. Tuned to β = 400.

**α, summary mass.** Each block gets a summary vector whose `i`-th coordinate is the coordinate-wise maximum over the block, precisely a vectorized version of WAND's scalar upper bound:

```python
def summary(block, alpha):
    # Conservative upper bound: <q, phi(B)> >= <q, x> for every x in B
    phi = elementwise_max(x for x in block)

    # alpha-mass subvector: smallest prefix by magnitude holding alpha * ||phi||_1
    entries = sorted(phi.nonzero_items(), key=lambda kv: -abs(kv[1]))
    budget, kept = alpha * l1_norm(phi), []
    for coord, value in entries:
        if budget <= 0:
            break
        kept.append((coord, value))
        budget -= abs(value)

    return quantize_u8(kept)  # 256 uniform buckets over [min, max]
```

The full coordinate-wise max is conservative and therefore rank-safe, but it is dense: a block of 15 documents with 119 nonzeros each spans a union of hundreds of coordinates. Truncating to the α-mass subvector (α = 0.4) breaks conservatism, which is the intended trade. Then 8-bit scalar quantization shrinks summaries 4x with, per the ablation, no measurable cost in latency or recall.

## Query processing

Coordinate-at-a-time over the top `cut` query coordinates, summary as admission test:

```python
def search(q, k, cut, heap_factor):
    heap = MinHeap()                      # (score, doc_id), size <= k
    for i in top_entries(q, cut):
        for block in lists[i]:
            r = dot(q, block.summary)     # over quantized u8 summary
            if len(heap) == k and r < heap.min() / heap_factor:
                continue                  # skip the whole block
            for doc in block.postings:
                p = dot(q, forward_index[doc])   # exact, fp16 vector
                if len(heap) < k or p > heap.min():
                    heap.push(p, doc)
                    if len(heap) > k:
                        heap.pop_min()
    return heap
```

The threshold deserves attention. Rank-safety would require visiting any block whose summary score `r` beats `heap.min()`. But the summary is a maximum over the block, so it systematically overestimates the block's contents and that test almost never prunes. Dividing by `heap_factor ∈ (0,1)` raises the bar: at `heap_factor = 0.7`, a block must summarize to 1.43x the current k-th best score to be worth opening. It is an explicit correction for the summary's optimism, and the most direct recall-versus-latency dial at query time.

The forward index stores complete vectors in fp16 (4,113 MiB) and supplies every exact score, which is what lets the inverted side be aggressive. Its weakness is locality: a document belongs to many lists and therefore many blocks, so it cannot be laid out contiguously per block, and scoring is a pointer chase. The implementation leans on explicit prefetch instructions, plus matrix multiplication of the query against all quantized summaries of a list at once.

## What it buys

Single threaded on an Intel i9-9900K, MS MARCO passage with SPLADE, recall@10 measured against exact search:

| Recall | Seismic | PyAnn (graph) | SparseIvf | Ioqp |
|---|---|---|---|---|
| 90% | 187 µs | 489 µs (2.6x) | 4,169 µs (22x) | 17,423 µs (93x) |
| 95% | 303 µs | 1,016 µs (3.4x) | 10,254 µs (34x) | 31,843 µs (105x) |
| 97% | 531 µs | 1,878 µs (3.5x) | 15,840 µs (30x) | 51,522 µs (97x) |

PyAnn and GrassRMA are the winning entries of the sparse track at the 2023 NeurIPS BigANN Challenge, so 2.6x to 3.5x over them is the meaningful comparison. On Efficient SPLADE, where queries are very sparse, the gap widens to 21.6x, and the mechanism shows up in the work done: to hit 97% recall PyAnn scores roughly 40,000 documents while Seismic scores 2,198. Greedy graph traversal degrades when query and document overlap is small, because the inner products it navigates by become uninformative.

The ablations are clean. Geometric blocking beats chunking the impact-sorted list into fixed-size groups across the entire parameter sweep, so the win comes from cluster cohesion rather than blocking per se. Importance-based summaries beat fixed-length ones at equal space: 128 top entries costs 2,687 MiB, while α = 0.4 costs 2,303 MiB and is more accurate. Build cost is 5 minutes against 137 for PyAnn and 267 for GrassRMA, at 6,416 MiB versus GrassRMA's 10,489.

One result reframes a standing design choice. Efficient SPLADE exists because full SPLADE was considered too slow to serve, trading expansion for sparsity. With Seismic underneath, full SPLADE reaches a higher MRR@10 at a tight latency budget. The retrieval engine was the bottleneck, and model-side efficiency work was compensating for it.

The follow-up, SeismicWave (arXiv:2408.04443), adds two orthogonal ideas: visit blocks in order of summary score so the heap threshold rises earlier and prunes harder downstream, and expand the candidate set from an offline k-nearest-neighbor graph before re-ranking. That reaches near-exact accuracy up to 2.2x faster than Seismic, evidence that the clustered inverted index and the proximity graph are complementary rather than competing.

The transferable lesson is narrower than "inverted indexes are back." A data structure's performance is a claim about a distribution. The inverted index plus WAND encodes assumptions about query length and score skew that held for two decades of term-frequency scoring and stopped holding the moment a transformer started assigning the weights. Seismic keeps the container and replaces every assumption inside it.
