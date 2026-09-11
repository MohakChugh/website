---
title: "AutoUVM: Tensor-Level Prefetching When Your LLM Doesn't Fit in GPU Memory"
date: 2026-09-11
tags: [gpu, memory-management, llm-inference, uvm, systems]
excerpt: "CUDA Unified Virtual Memory lets an oversized model run on a small GPU — at fault-driven migration speeds that make it nearly useless. AutoUVM (arXiv:2609.06172) closes the semantic gap between PyTorch and the UVM driver: it learns the kernel-to-tensor access sequence offline, classifies each kernel against a three-roof roofline, and issues cudaMemPrefetchAsync only where the CPU–GPU interconnect is the binding roof. Result: 3.1x over stock UVM at 2x oversubscription. Inverting a two-roof cost model against the paper's own sensitivity numbers implies stock UVM's redundant migration grows superlinearly — roughly 1.1x, 2.2x, 2.8x the minimum overflow bytes at 1.5x, 1.75x, 2x oversubscription."
---

There are two ways to run an 11GB model on an 8GB GPU. The one every inference framework ships is explicit offloading: partition the weights, `memcpy` layer groups in and out on a schedule the framework controls. The one almost nobody ships is CUDA Unified Virtual Memory: allocate everything with `cudaMallocManaged`, let the driver page data in on demand, and change zero lines of model code. UVM loses because page-fault-driven migration is brutally slow — and it gets slower the more you oversubscribe, exactly when you need it most.

[AutoUVM](https://arxiv.org/abs/2609.06172) (Lin et al., arXiv:2609.06172) is a serious attempt to fix the second path without giving up its main virtue: transparency. It is a PyTorch extension that requires no model changes, learns tensor-level access behavior in an offline profiling pass, and drives the UVM driver with `cudaMemPrefetchAsync` and `cudaMemAdvise` calls placed by a roofline-derived policy. Across ten LLMs at 2x oversubscription it averages **3.1x over stock UVM** and **1.9x over DeepUM**, the best prior UVM prefetcher — while object-level prefetchers (SUV, Forest) often land *below* the unmodified baseline.

## Why fault-driven migration loses

With managed memory, a GPU thread touching a non-resident page traps into the UVM driver and GPU MMU, which allocate device space, copy the page across the CPU–GPU interconnect (CGI), and replay the access. Three costs stack up:

1. **Fault handling latency.** Each fault group pays a fixed driver/GMMU round trip before a single byte moves. The driver's tree-based prefetch engine amortizes this by promoting faults into larger block migrations, but it only sees address-range locality — it has no idea a matmul is about to stream an entire weight tensor.
2. **Eviction under oversubscription.** Once device memory fills, the driver evicts LRU pages to the host. An LLM decode pass touches weights cyclically — the access pattern that maximally defeats LRU. Pages evicted early in the layer stack are exactly the ones needed first next iteration.
3. **The interconnect roof.** On an H100 NVL, HBM delivers roughly 4TB/s while the host link manages ~900GB/s at best — and over PCIe on commodity cards, ~20GB/s. Any byte that crosses the CGI redundantly is 1–2 orders of magnitude more expensive than a byte served from HBM.

Prior UVM prefetchers attacked this at *managed-object* granularity — prefetch whole allocations when any part is touched. The paper's motivating measurement is damning: a naive object-level prefetcher moved on average **6x more useless than useful data** (up to 23x), wasting CGI bandwidth and *causing* the thrashing it meant to prevent. PyTorch's caching allocator makes this worse: allocations are recycled slabs, so object identity tells you almost nothing about which tensor lives there now.

## The design: profile tensors, classify kernels, prefetch selectively

AutoUVM has three parts — an offline profiler, an execution profile database, and an online executor — connected by one idea: recover *tensor-level* semantics that the driver can't see, then spend CGI bandwidth only where the roofline says it pays.

**Stable tensor identity.** The profiler hooks PyTorch's CUDA caching allocator (switched from `cudaMalloc` to `cudaMallocManaged`) and records, for every tensor, a two-level identifier: a hash of its creation-site call stack plus a monotonic allocation counter. Kernels get the same treatment — launch-site call stack hash plus launch counter. This survives address randomization and allocator recycling across runs. At runtime, if an identifier fails to match the recorded profile, prefetching for the affected tensors is disabled rather than risked — a correctness-first fallback, since a wrong prefetch is only a performance bug but the paper treats profile drift conservatively.

**One profiling pass, not a computation graph.** Instead of tracing the dynamic graph, the profiler records the observed kernel→tensor access sequence directly (NVBit for FLOP and load counts, Compute Sanitizer APIs for instrumentation). One pass costs on average 41.5x a single inference iteration — a one-time price per (model, config) pair stored in the profile database.

**The roofline gate.** Here is the part most prefetchers get wrong. For each kernel, the analyzer computes where it sits against three roofs: the compute roof, the GPU memory-bandwidth roof, and the far lower CGI roof. Only kernels bottlenecked on the CGI roof get prefetches; compute-bound and HBM-bound kernels are left to fault, because prefetching for them burns bandwidth and device memory that CGI-bound kernels need. The skew justifying this is extreme — in Qwen1.5 on an RTX 3060, the top 20 kernels contribute over 90% of runtime, with elementwise kernels HBM-bound and GEMV/GEMM near the compute roof.

**Affinity pinning.** A look-ahead pass finds tensors reused across consecutive kernels and pins them for their reuse window via `cudaMemAdvise`, so LRU can't evict a tensor mid-reuse. A runtime monitor re-times kernels as eviction pressure shifts and re-classifies them against the roofs.

The executor's inner loop is conceptually just:

```python
def before_launch(kernel, resident_budget):
    profile = db.lookup(kernel.stack_hash, kernel.launch_counter)
    if profile is None:
        return                      # unknown kernel: fall back to faulting
    if profile.bound != CGI_BOUND:
        return                      # compute/HBM-bound: prefetch wouldn't help
    for t in profile.tensors:
        if t.reuse_distance <= AFFINITY_WINDOW:
            cuda.mem_advise(t.ptr, t.size, PREFERRED_LOCATION_GPU)
        cuda.mem_prefetch_async(t.ptr, t.size, device, stream)
```

The ablation confirms each layer earns its keep: tensor-level prefetching alone is 2.0x, adding affinity pinning 2.5x, adding the roofline gate 3.1x.

## What the sensitivity numbers imply about stock UVM

The paper reports speedups of **1.4x, 2.2x, 3.1x** at oversubscription factors 1.5, 1.75, 2.0. I tried to reproduce that curve with a two-roof cost model before writing this post — one decode iteration streaming a working set `W = f·C` over a 20GB/s link, 25µs per fault group, compute normalized to 1s.

The naive version — LRU fully thrashing on a cyclic scan, per-64KB fault overhead, migrations serialized with compute — predicts 8.8–11.4x, three times the measured gains. The model only fits if you credit the stock driver's tree prefetcher with batching faults into ~2MB migrations (cutting fault overhead ~30x). So the interesting exercise is the inversion: fix that batched-fault model, plug in the paper's measured speedups, and solve for how many bytes the baseline must actually be migrating per iteration:

```text
f=1.50: implied baseline migration =  6.5 GB   minimum overflow =  6 GB   → 1.08x
f=1.75: implied baseline migration = 19.4 GB   minimum overflow =  9 GB   → 2.15x
f=2.00: implied baseline migration = 33.9 GB   minimum overflow = 12 GB   → 2.83x
```

At 1.5x oversubscription, stock UVM is already near-optimal in *bytes moved* — it migrates roughly the minimum overflow, and AutoUVM's win there is mostly overlap and fault elimination. By 2x, the implied redundant-migration factor has climbed to ~2.8x: eviction pressure makes the driver re-fetch pages it just evicted, and the degradation is superlinear in the oversubscription factor. That inversion is my model, not the paper's claim — but it explains why the speedup curve steepens (1.4 → 2.2 → 3.1) rather than flattening: AutoUVM's advantage grows precisely as fast as the baseline's thrashing compounds.

## Where this sits

The results hold up across hardware generations better than I expected — 3.1x on RTX 3060, 2.9x on A100, 2.7x on H100 NVL — because the ratio between HBM and CGI bandwidth, which is what the roofline gate exploits, hasn't narrowed. It also survives kernel fusion: with `torch.compile`/Inductor fused kernels, where tensor access boundaries blur, AutoUVM still delivers 2.3x. Energy drops 31% on average versus stock UVM, since the GPU spends less time stalled at near-idle power draw.

The honest caveats: the offline profile assumes a stable (model, shape) configuration, dynamic control flow degrades to fault-driven behavior by design, and the 41.5x-of-one-iteration profiling cost means this targets steady-state serving, not one-off runs. And explicit offloading frameworks will still beat UVM when you can afford to integrate them — AutoUVM's bet is that *transparent* oversubscription with 3x of the pain removed is the right default for everyone who can't.

The broader lesson generalizes past UVM: paging systems fail on accelerators not because demand paging is inherently slow, but because the paging layer is blind to the semantics one layer up. Expose the tensor access sequence — even approximately, even from an offline profile — and a 25-year-old mechanism becomes competitive. The semantic gap, not the page fault, was the bottleneck.
