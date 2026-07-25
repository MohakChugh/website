---
title: "NanoFlow: LLM Serving Is Compute Bound, and Your GPU Is Half Idle"
date: 2026-07-26
tags: [llm-inference, gpu, systems, performance, scheduling]
excerpt: "Everyone repeats that LLM inference is memory bound. Run the arithmetic on a batched 70B serving workload and the opposite falls out: compute is the binding constraint, and yet aggregate GPU utilization sits near 40 percent. The gap is not kernel quality, it is that compute, memory, and NVLink operations execute one after another inside a single device. NanoFlow splits each batch into nano-batches so those three resources run at once, and lands 1.91x over TensorRT-LLM."
---

"LLM inference is memory bound" is one of those claims that is true of a single decode step with batch size one and then gets applied, incorrectly, to everything else. NanoFlow (Zhu et al., arXiv:2408.12757, revised May 2025) does the unglamorous work of actually costing out a production serving iteration, and the answer inverts the folklore. For LLaMA-2-70B on 8xA100 with a dense batch of 2048 tokens, the per-iteration cost decomposes as roughly **114 ms of compute, 45 ms of memory traffic, and 31 ms of network**. Compute dominates by more than 2x.

That reframing matters because it changes what "optimal" means. If you are compute bound, the throughput ceiling is purely arithmetic:

```
optimal_tokens_per_sec_per_gpu = peak_flops / (2 * n_params)
```

With CUTLASS-profiled 280 TFLOPS of FP16 on an A100 and 70B parameters, that is **1857 tokens/s/GPU**. Now measure the engines people actually deploy. vLLM hits 22.0% of that bound. DeepSpeed-FastGen 22.9%. TensorRT-LLM, the best of them, 37.8%. Nobody is close.

The tempting conclusion is that the kernels are bad. They are not — profile them individually and each achieves around 80% of *its own* bottleneck resource. The loss is structural, and it lives between the kernels.

## Four resource classes, one serialized queue

Sort the operators in a transformer layer by what actually constrains them:

| Class | Operators | Bottleneck |
|---|---|---|
| Dense | KQV projection, O-proj, Up, Gate, Down | Compute — batching amortizes the weight load |
| Attention | Prefill attention (compute), decode attention (memory) | Mixed |
| Network | AllGather / AllReduce for tensor parallelism | NVLink bandwidth |
| Other | LayerNorm, RoPE | Negligible |

A conventional engine issues these in dependency order on a single stream. While the Up projection saturates the tensor cores, HBM bandwidth is mostly idle. While decode attention streams per-request KV vectors out of HBM, the tensor cores are mostly idle. While the AllReduce moves activations across NVLink, both are idle. Three expensive resources, each used in its own turn, each waiting on the others. Aggregate compute utilization lands near 40% even though every individual kernel is near-optimal, because the utilization is a *time-weighted average across phases where compute is not the active resource*.

This is the insight behind warp specialization inside a kernel and pipeline parallelism across devices, applied at a level nobody had systematically attacked: **operator-level overlap within one GPU**.

## Nano-batching: manufacturing independence

You cannot overlap two operators that have a data dependency. Up projection needs the LayerNorm output; the AllReduce needs the O-projection result. Within one batch, the dependency chain is total.

The trick is to break the batch. Split the 2048-token dense batch into nano-batches and duplicate each operator into nano-operations over one nano-batch each. A single Up projection over tokens 0-2048 becomes `UP1` over tokens 0-768 and `UP2` over tokens 768-2048. Crucially, `UP2` has no dependency on `UP1` — different rows of the activation matrix are independent — so `UP1` can co-run with a *different* nano-op from a *different* resource class, say the decode attention or the AllGather belonging to the previous nano-batch.

```
Conventional (serialized):
  [KQV ][ AG ][  ATTN  ][ O ][ AR ][ UP ][ GATE ][ DOWN ]
  compute  net   memory   cmp  net   compute...

Nano-batched (overlapped):
  [KQV1][KQV2][KQV3][KQV4][ O1 ][ O2 ][UP1][UP2][GATE1]...
        [ AG1 ][ AG2 ][ AG3 ]       [ AR1 ][ AR2 ]
              [ ATTN1  ][ ATTN2  ][  ATTN3  ]
  three resource classes live simultaneously
```

The cost is real: each nano-op reloads the same weight tile, so you pay extra HBM traffic. That is exactly the trade you want when the workload is compute bound as a whole — you are spending an underused resource to buy back the scarce one.

## The part that is harder than it looks: allocating a GPU you cannot partition

Here is where most "just overlap it" proposals die. NVIDIA GPUs give you no explicit knob for splitting compute, memory bandwidth, and network bandwidth between concurrent kernels. Stream priorities are advisory. MPS and MIG partition SMs, not bandwidth. Launch two kernels concurrently and the hardware decides, based on occupancy and memory pressure, who gets what.

NanoFlow's answer is to stop trying to control allocation directly and instead *measure* it. Define `R` as a nano-op's effective share of physical resources, inferred behaviorally: co-run a GEMM with something else, and if the GEMM retains 40% of its solo throughput, then `R_gemm = 0.4` and the partner implicitly holds `R = 0.6`. Profile a table mapping `R` to normalized performance `P` per operator type — for GEMV, `R = 0.2` yields `P = 0.3`, because a memory-bound op needs relatively few SMs to saturate bandwidth. That table is stable to within a 5% standard deviation, which is what makes the whole approach viable as a planning input.

Scheduling then becomes a two-stage MILP:

- **Stage I** picks the number, size, and order of nano-ops while ignoring interference. It starts at two nano-ops per operator and adds more only where the schedule shows a compute bubble, overlaps only operators with *differing* bottlenecks, and is allowed to rewrite collectives (swapping AllGather for AllReduce under a different weight partitioning) to change where network traffic lands.
- **Stage II** re-solves for the `R` allocations subject to `sum(R) <= 1.0` at every instant, with each nano-op's duration modelled as `D_best / P(R)`.

Profiling sweeps batch sizes from 128 up in steps of 128 to stay GEMM-tiling-friendly, caps GEMV and network thread blocks at 8-128 in steps of 8, and only profiles pairwise interference (compute-memory and compute-network). Total search time for a usable schedule: about ten minutes. That is a one-time offline cost per model and topology, which is the right place to put an expensive optimizer.

The resulting schedules are model-specific in ways that make sense. LLaMA-2-70B uses four nano-ops at KQV, because that is the one point where all three resource classes have work available, and runs decode attention at `R = 0.4` where it still reaches 80% of peak attention throughput. An 8B model has no tensor-parallel network ops at all, so it uses two nano-ops and simply overlaps decode attention against Up/Gate/Down. MoE models use grouped GEMM plus gate routing under the same framework.

## Runtime details that keep the pipeline fed

An overlap schedule tuned for a fixed dense batch size falls apart if batch shapes fluctuate, so the scheduler works to keep them constant. It prefers unfinished decode requests, then chunks prefill at token granularity (following SarathiServe) to top the batch up to exactly the target size. Stable shapes mean the profiled schedule stays valid and tail latency stays predictable.

Batch formation for iteration `i+1` happens before iteration `i` finishes, which means an EOS token is detected one iteration late. With decode lengths above roughly 100 tokens that wastes under 1% of work — a good trade for removing a synchronization point from the critical path.

KV cache offloading gets a similarly hardware-aware treatment. KV vectors are copied to the host immediately after KQV generation, while they are still contiguous, and that copy is deliberately scheduled to overlap the compute-bound FFN ops. Host threads are NUMA-bound; the CPU-memory-plus-SSD hierarchy is LRU managed. On reload, data lands in a contiguous GPU buffer and is only then scattered into fragmented PagedAttention pages, which is worth **7-10x** the host-to-device bandwidth of scattering across the PCIe transfer itself. Requests that exceed predicted peak memory are offloaded and later reloaded with no recomputation.

## What it buys

On 8xA100 80GB over NVLink, FP16, TP=8, against vLLM v0.5.3, DeepSpeed-FastGen v0.2.3, and TensorRT-LLM v0.8.0:

- Offline throughput on real length distributions (Splitwise, LMSYS-Chat-1M, ShareGPT): **4.18x** vLLM, **3.45x** DeepSpeed-FastGen, **1.91x** TensorRT-LLM.
- Constant-length offline: 2.62x / 2.78x / 1.73x.
- **68.5% of the theoretical compute bound** in the best case, versus 37.8% for the strongest baseline. Across LLaMA-3-70B/8B, Qwen2-72B, Deepseek-67B, and Mixtral 8x7B: 50-72% of optimal, averaging 2.66x over vLLM.
- Online serving: **1.64x** the sustainable request rate of TensorRT-LLM under a 200 ms normalized-latency SLO, with p99 at 1.07x the mean near peak throughput. Note the honest caveat — at *low* request rates NanoFlow shows slightly worse normalized latency, because the large dense batch it wants is itself a latency cost.

Implementation is roughly 10K lines of CUDA and 6K of Python, with CUDA events enforcing nano-op ordering.

## The transferable lesson

The interesting claim here is not the 1.91x. It is that a system can be built from near-optimal components and still leave half its capacity unused, because *utilization is a property of the schedule, not of the kernels*. Every engineer profiling a serving stack has looked at 80%-of-roofline kernels and concluded there was nothing left. The bubble was between them the whole time.

The generalization: any time a system has multiple heterogeneous resources and a serialized dependency chain, ask whether you can manufacture independence by splitting the work unit. Warp specialization is that move one level down, pipeline parallelism one level up. Same idea at three scales, and the middle one was sitting unexploited.
