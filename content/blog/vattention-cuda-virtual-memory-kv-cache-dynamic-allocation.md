---
title: "vAttention: Dynamic KV Cache Allocation Without Breaking Virtual Contiguity"
date: 2026-08-15
tags: [llm-inference, gpu, virtual-memory, kv-cache, systems]
excerpt: "PagedAttention solved KV cache fragmentation by making the cache non-contiguous in virtual memory, and every attention kernel since has paid for that decision in rewrites, register spills, and block-table bookkeeping. vAttention points out that the fragmentation was always a physical-memory problem, and fixes it with CUDA's virtual memory APIs instead. I re-derived the paper's page-size tables and its batch-size result from first principles; both hold, and the arithmetic reveals why they had to patch NVIDIA's driver to ship it."
---

PagedAttention is the most successfully copied idea in LLM serving. vLLM introduced it, and TensorRT-LLM, TGI, and LightLLM all followed: split the KV cache into fixed-size blocks, allocate a block at a time as a sequence grows, and keep a per-request block table mapping logical block index to physical block. Fragmentation drops from catastrophic (reserve 200K tokens per request when the mean output is 415) to near-zero, batch sizes go up, throughput follows.

The `vAttention` paper (Prabhu, Nayak, Mohan, Ramjee, and Panwar, Microsoft Research India, ASPLOS '25) makes an argument that is obvious in retrospect and was apparently invisible for two years: **fragmentation is a physical memory problem, and PagedAttention solves it by mutating the virtual memory layout.** Those are not the same thing, and conflating them is what makes every downstream cost unavoidable.

## What the layout change actually charges you

Conventional attention kernels assume `K` and `V` are contiguous tensors. Once blocks are scattered, every kernel must dereference through a block table. The paper's measurements of that tax:

- FlashAttention-2's paged prefill kernel is up to **37% slower** than its own non-paged kernel; FlashInfer's is up to **42% slower**. Cause: 7-13% more instructions, plus cached page indices raising register pressure until registers spill.
- vLLM's own paged decode kernel runs up to **2.8x slower** than FlashAttention-2's, because keeping a hand-written paged kernel current with FlashDecoding-class optimizations is a permanent maintenance obligation that an actively maintained repo still lost.
- Kernel latency becomes *sensitive to block size*: vLLM's paged decode kernel varies by up to **1.9x** across block sizes, apparently an L1 hit-rate effect.
- On the CPU side, vLLM materializes the block table as a padded 2D tensor, so preparation cost scales with `max_num_blocks × batch_size` — a batch of one long request and many short ones pays for the padding. Measured at **30% of decode iteration latency**, still ~10% after a fix.

The structural point is sharper than any of these numbers. PagedAttention implements demand paging *in user space*, atop an OS and GPU driver that already do it. You maintain two translation layers, and the inner one must be re-implemented inside every new attention kernel.

## The inversion

`cudaMalloc` commits virtual and physical memory together — the actual constraint everyone was routing around. CUDA has exposed lower-level VMM APIs that split them for years:

```c
// Reserve virtual address space. No physical memory committed.
cuMemAddressReserve(&ptr, size, 0, 0, 0);

// Later, on demand: create a physical handle and map it into a sub-range.
cuMemCreate(&handle, page_bytes, &prop, 0);
cuMemMap(ptr + offset, page_bytes, 0, handle, 0);
cuMemSetAccess(ptr + offset, page_bytes, &desc, 1);
```

So vAttention flips the allocation policies: **reserve virtual memory eagerly and abundantly, commit physical memory lazily.** Each worker reserves `2N` virtual tensors (K and V per layer), each sized for the maximum batch size `B` times the maximum per-request KV size `S = L × H × D × P`. For Yi-34B at TP-2, `S = 200K × 4 × 128 × 2 = 200 MB`, so with `B = 500` each buffer is 100 GB and the 60 layers need 12 TB of virtual address space. That sounds absurd until you remember a 64-bit process gets 128 TB of user VA. Virtual memory is free; waste it lavishly.

Request `i` lives at offset `reqId × S` in every buffer. The attention kernel sees an ordinary contiguous tensor. There is no block table, so there is nothing to look up, pad, or port.

## Why the allocation rate works out

Two workload properties make this viable.

**Demand is predictable per iteration.** Autoregressive decode grows each sequence by exactly one token per step, so the serving loop knows before dispatching iteration `i` whether it will need another page.

**Demand is tiny.** Per-token KV footprint across all layers is 64 KB (Yi-6B), 128 KB (Llama-3-8B), 240 KB (Yi-34B) — I recomputed each as `2 × N × H × D × P` and they match exactly. Decode throughput saturates past a certain batch size, so the allocation rate saturates too, peaking at **750 MB/s**.

Compare that against what the API layer can sustain. From the paper's measured per-call latencies, a serial create-then-map cycle gives a lower bound:

| page-group | derived (create+map) | paper's measured |
|---|---|---|
| 64 KB | 6.76 GB/s | 7.59 GB/s |
| 2 MB | 30.4 GB/s | 35.2 GB/s |

The measured values sit 12-16% above my serial bound, which tells you something the prose never says: they are not doing one `cuMemCreate` per page-group. Handle creation is being amortized across a larger allocation. Either way, the headroom over 750 MB/s is roughly an order of magnitude. The mechanism is not remotely bandwidth-bound.

## The 2 MB problem, and why it forced a driver patch

`cuMemCreate` only allocates in multiples of 2 MB. That is why this paper needed a kernel-level hack, not just a library.

Internal fragmentation here is not one partial page per request. It is one partial page per *tensor*, and there are `2N` of them. For Yi-34B (60 layers) that is 120 partial pages per request:

```python
def mean_waste_mb(layers, page_kb):
    return 2 * layers * (page_kb / 1024) / 2   # half a page-group per tensor

mean_waste_mb(60, 2048)   # 2MB pages -> 120.0 MB per request
mean_waste_mb(60, 64)     # 64KB      ->   3.8 MB per request
```

120 MB of waste per request, at batch 56, is 6.6 GB evaporated on a GPU with maybe 42 GB of KV budget after weights. So the authors reimplemented the VMM API surface inside NVIDIA's *open-source* unified-memory driver, adding 64 KB, 128 KB, and 256 KB page-groups, because the real `cuMemCreate` lives in the closed-source blob.

Does the fragmentation model actually explain the reported batch sizes? The paper reports Yi-34B serving batch 56 with 2 MB pages and 68 with 64 KB pages on the same trace. Working backwards with a 42 GB KV budget:

- 2 MB: `42 - 56 × 0.117 GB = 35.4 GB` usable, i.e. **648 MB** of real KV per request
- 64 KB: `42 - 68 × 0.0037 GB = 41.7 GB` usable, i.e. **629 MB** per request

Within 3%: the entire 21% batch-size gain is fragmentation recovery, with per-request KV demand held constant. The model checks out.

The pleasant surprise: small pages cost nothing. Conventional wisdom says 64 KB pages invite TLB thrashing, but attention kernels are hand-tuned for regular, sequential access and show no measurable degradation.

## Hiding the syscall

Mapping is not free. Each `cuMemMap` + `cuMemSetAccess` pair costs ~40 µs at 2 MB, and growing one Yi-34B request touches 120 tensors:

```
120 × 40 µs = 4.8 ms added to that iteration
```

The paper measures spikes of 5-15 ms when allocating synchronously. Three fixes, all exploiting predictability:

1. **Overlap with compute.** Because iteration `i`'s demand is known during iteration `i-1`, a background thread maps pages for `i` while `i-1` runs. Iterations take 10s-100s of ms; 5 ms hides completely.
2. **Deferred reclamation.** When a request finishes, do not unmap. Hand its `reqId` — and its already-backed physical pages — to the next arriving request. Prefill then needs zero new mappings unless the new context is longer.
3. **Eager allocation.** Keep one spare `reqId` pre-backed so an arriving request never blocks on the driver.

Without these, prefill pays up to 1.15x with 64 KB pages. With them, the cost disappears from the critical path.

The resulting framework contract is four calls:

```python
kv_tensors = vattention.init(N, B, L, H, D, P, page_group_size)

idx = vattention.alloc_reqid()              # on admission
cache_seq_len[idx] = prompt_len(req)

vattention.step(cache_seq_len)              # ensure backing, then:
model.forward()                             # unmodified attention kernel

vattention.free_reqid(idx)                  # on completion
```

## Where it does not win

Decode throughput comes out *on par* with the best paged kernel, not better. Decode attention is memory-bound, so the extra indexing work hides behind memory stalls. All the gains are in prefill, which is compute-bound and cannot absorb them — hence up to 1.24-1.26x prefill throughput at 192K context, 1.13-1.23x end-to-end offline, and up to 42% lower median latency online where faster prefill drains the queue.

The more interesting limitation is prefix sharing. Cross-request dedup needs one physical page mapped into two virtual sub-tensors. That works here: the driver extension supports aliasing, and a *prefix* sits at offset 0 of both requests' regions, so the shared span is identically page-aligned in both. But arbitrary block-level reuse — RadixAttention-style sharing of a mid-sequence span, or non-prefix reuse as in CacheBlend — needs one physical page at *different* offsets in different requests. Page granularity cannot express that. PagedAttention's indirection can. That is a real capability the contiguous layout gives up, and not a small one.

## The lesson, and the aftermath

The current FlashAttention-3 Hopper source now carries a `page_table` argument, so the ecosystem eventually paid the porting cost: vAttention's portability claim describes a *lag*, not a permanent gap. The lag was real and expensive, though — state-of-the-art kernels shipped without paging and stayed unusable in paged stacks until someone redid the work, per kernel.

That same interface exposes `kv_batch_idx`, which is what makes vAttention's continuous batching work: when a request mid-batch exits it leaves a hole in the virtual tensor, and `kv_batch_idx` lets `Q` and the KV cache carry different batch orderings. The escape hatch saving the contiguous design is a kernel feature that exists for unrelated reasons.

The generalizable idea: when you find yourself reimplementing an OS abstraction in user space, check whether the platform will sell you the primitive directly. Demand paging was not missing from the GPU stack. It was just behind an API nobody in the serving community had looked at, and the entire cost of PagedAttention — the kernel rewrites, the register spills, the padded block tables, the two years of porting — was the price of not looking.
