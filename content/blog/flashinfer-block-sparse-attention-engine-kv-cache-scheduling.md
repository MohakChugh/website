---
title: "FlashInfer: Every KV Cache Layout Is Just a Block-Sparse Matrix"
date: 2026-08-05
tags: ["llm-serving", "gpu-kernels", "attention", "sparsity", "scheduling"]
excerpt: "Paged, ragged, shared-prefix, tree-decoded, and pruned KV caches look like five different kernels. FlashInfer collapses them into one block-sparse format with a tunable block size, then adds a load-balancing scheduler that survives CUDAGraph capture."
---

# FlashInfer: Every KV Cache Layout Is Just a Block-Sparse Matrix

Attention kernels have a combinatorial explosion problem, and it isn't in the math.

The math is FlashAttention, and it has been stable for years. The explosion is in the *layouts and variants* around it. A serving engine needs a ragged prefill kernel, a paged decode kernel, a shared-prefix kernel, a tree-decode kernel for speculation, and a fine-grained gather kernel for KV pruning. Multiply by variants — ALiBi, sliding window, logit soft-cap, FlashSigmoid, FP8 KV with FP16 query. Multiply again by architectures, since Hopper's TMA cannot express non-affine access patterns and you fall back to Ampere-style async copies. The result is that every serving framework grows its own drawer of near-duplicate CUDA, and each one has slightly different bugs.

[FlashInfer](https://arxiv.org/abs/2501.01005) (Ye et al., MLSys 2025) makes the argument that this is one problem, not five: **every one of those KV cache layouts is a block-sparse matrix with a different block size.** It now backs SGLang, vLLM, and MLC-Engine. I pulled the paper and re-derived its numbers, and one of them turns out to be badly undersold by its own authors.

## The Unification

Block Compressed Sparse Row groups non-zeros into $(B_r, B_c)$ tiles. Set the block size and the layouts fall out:

- **Paged KV cache** — $B_r$ = query tile, $B_c$ = page size. The `indices` array *is* the page table. PagedAttention isn't a separate abstraction; it's BSR with $B_c = 16$.
- **Ragged/variable-length** — $B_c = 1$, dense within a request.
- **Shared prefix** — a large $B_r$ so multiple queries share one shared-memory load of the prefix.
- **Tree decoding** — an arbitrary mask expressed as block occupancy.
- **KV pruning** (Quest, H2O) — vector-sparse, $B_c = 1$, scattered rows.

The catch is that tensor core `mma` instructions have a minimum tile dimension of 16 (larger on Hopper's WGMMA, multiples of 64). So most block-sparse kernels round block sizes up to multiples of (16, 16), and most attention libraries go further and use (128, 128). That rounding is exactly what destroys fine-grained sparsity.

FlashInfer's escape is to decouple storage granularity from compute granularity. Blocks are gathered from scattered global memory into *contiguous shared memory* first, then handed to dense tensor cores:

```
// sparse path: address computed through the BSR indices array
j = indices[(offset + i) / b_c] + (offset + i) % b_c
// dense path: plain affine transform
j = offset + i
```

Both paths issue the same 128-byte `LDGSTS` async copy, because the head dimension ($d$ = 128 or 256) stays contiguous and supplies the coalescing. After the copy lands in shared memory the sparse and dense implementations *converge* — same FlashAttention microkernel, differing only in the load module. The measured cost of this indirection is under 1% for decode and about 10% for prefill (where TMA is available on the dense path but not the sparse one).

## The Number the Paper Undersells

Appendix G.5 benchmarks fine-grained sparsity against Quest's access pattern (block size 16, 32 heads, $d$=128, H100 SXM5), comparing FlashInfer to PyTorch SDPA and FlexAttention. The paper reports "up to a 20x speedup." I recomputed every cell:

```
seq_len  budget  vs SDPA  vs Flex
   4096      64    14.2x    54.2x
  32768      64    76.5x    52.3x
  32768     512    25.0x    17.2x
                 max 76.5x  max 54.2x
```

The actual maximum is **76.5x versus SDPA and 54.2x versus FlexAttention** — the "20x" claim is roughly the geometric middle of the table, not its ceiling. Understating your own result is an unusual failure mode, so it's worth checking what generates it. Fit latency against page budget at the longest sequence:

$$T \approx 16.3\,\mu s + 103.6\,\mu s \text{ per } 1000 \text{ pages}$$

That predicts 22.9 / 29.5 / 42.8 / 69.3 µs against measured 22.4 / 28.7 / 45.0 / 68.5 µs. FlashInfer's cost is affine in *retrieved* pages and nearly independent of sequence length — coefficient of variation across `seq_len` at fixed budget is 6.1%. That is what real sparsity looks like.

The baselines have the opposite signature. SDPA varies 65.7% across `seq_len` and is *perfectly flat* across budget (1.00x for 8x more work): it reads the whole cache and the mask is decoration. FlexAttention is flat in **both** directions (3.5% across sequence, 0.98x across budget) — its large-block template cost dominates regardless of how little data the algorithm actually wants. A quick read-amplification model shows why the block size is decisive:

```
block  budget  needed  read   amplification
   16      64    1024  1024      1.0x
  128      64    1024  8192      8.0x
```

At $B$=128 a scattered 16-token page drags in an entire 128-wide block. Eight-fold read amplification, before any fixed overhead. FlashInfer's speedup grows with sequence length because the baselines scale with the cache and it scales with the budget — so the ratio is unbounded, and any single "up to Nx" figure is the wrong summary statistic.

## Composability and the Determinism Constraint

A single block size forces a bad tradeoff: large $B_r$ improves shared-memory reuse but fragments, and requests in different blocks can't share each other's shared memory. So FlashInfer *composes* formats — store a shared prefix as BSR with $B_r$=3 and the per-request suffixes as $B_r$=1, then merge the results. No data movement; you recompute index arrays over the same buffer.

The merge is legal because attention state composes. Carry the output *and* its log-sum-exp, and there's an operator $\oplus$ that folds partial states:

```python
def merge(a, b):
    (Oa, la), (Ob, lb) = a, b
    m = max(la, lb)
    wa, wb = np.exp(la - m), np.exp(lb - m)
    return ((wa * Oa + wb * Ob) / (wa + wb), m + np.log(wa + wb))
```

I checked this against monolithic attention over 4096 keys split into seven uneven chunks: max output error 1.6e-16, LSE error exactly zero. Bit-clean.

But fold *order* is not free. Shuffling the seven partial states 200 times produced **12 distinct results**. Floating-point addition isn't associative, and this is precisely why the paper's scheduler departs from [Stream-K](https://arxiv.org/abs/2301.03598), which it otherwise takes inspiration from: Stream-K aggregates with atomics, whose completion order is nondeterministic. LLM serving needs reproducible outputs, so FlashInfer drops atomic aggregation and guarantees a deterministic aggregation order for identical sequence-length inputs. A 1e-16 discrepancy is irrelevant numerically and fatal to a cache key or a regression test.

Table 5 quantifies what composition buys: 1.03x at a 1k prefix with batch 16, up to **16.1x** at a 32k prefix with batch 64. The paper is careful to note real-world prefixes are shorter, so end-to-end gains are smaller than kernel gains — the right caveat to make.

## Scheduling: Where the Dynamism Actually Lives

The kernels are only half of it. Sequence lengths change every generation step, but CUDAGraph demands a static launch configuration. FlashInfer resolves this with an inspector-executor split: a CPU-side `plan` (not captured) computes a work assignment, and a captured `run` executes it via a persistent kernel with fixed grid size and fixed workspace offsets, so every pointer is identical across steps. Plan cost amortizes across all layers, since one step's sequence lengths serve them all.

Algorithm 1 is longest-processing-time-first greedy with KV chunking. I implemented it directly — chunk each query tile's KV to $L_{kv} = \sum \lceil l_{qo}/T_q \rceil \cdot l_{kv} / \#\text{CTA}$, sort descending, assign to the least-loaded CTA via a priority queue — and compared makespan against round-robin one-CTA-per-request on 132 SMs:

```
workload                   median   min    max
uniform kv=2048             1.00x  1.00x  1.00x
U(512, 2048)                1.48x  1.35x  1.58x
U(4096, 16384)              1.52x  1.38x  1.62x
lognormal (ShareGPT-ish)    3.31x  2.10x  9.44x
U(4096, 16384) batch=32     5.43x  4.33x  6.38x
```

Uniform lengths give exactly 1.00x — the scheduler is worth nothing when there's nothing to balance. That matches the paper's own ablation shape: 1.02x ITL improvement on ShareGPT at RR=16, but **1.61x** at U(4096, 16384) with RR=1, where few long requests can't fill 132 SMs. My simulated 1.52x at batch 256 and 5.43x at batch 32 bracket that measured 1.61x, which is decent corroboration that makespan is the mechanism rather than something incidental to the kernel.

Note where the win concentrates: low request rate, long and variable inputs, small batches. That is the tail-latency regime, not the throughput regime — and the paper's vLLM integration table shows the honest flip side, with a minor bf16 ITL regression (10.42 → 10.63 ms) attributed to host-side Python overhead swamping a kernel gain.

## What Generalizes

The reusable idea is not the CUDA. It's that **five layouts people treat as five kernels are one kernel with a parameter**, and the parameter was being rounded off by a hardware constraint that a shared-memory gather can absorb. FlexAttention reached for the same generality through a compiler and lost the fine-grained case to its 128-wide block template; FlashInfer kept arbitrary $B_c$ and won that case by 17–54x.

The scheduler carries a second, broader lesson. Once work is chunked and rebalanced, the aggregation order becomes part of your API contract — and if you took Stream-K's atomics along with its load balancing, you'd have silently traded reproducibility for a makespan win nobody asked you to make.

Sparsity you round up to a tile boundary is sparsity you don't have.
