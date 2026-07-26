---
title: "Megakernels: Deleting the Kernel Boundary to Win Back Microseconds"
date: 2026-07-26
tags: [gpu, cuda, llm-inference, performance, systems]
excerpt: "A single-token forward pass through a 1B parameter model should take 740 microseconds on an H100. Production engines take two to three times that, and the reason is not arithmetic, not memory bandwidth, and not the model. It is the roughly one hundred kernel launches per forward pass, each of which drains the memory pipeline dry. Two 2025 projects independently arrived at the same fix: collapse the entire model into one kernel launch and build a scheduler inside it."
---

Batch-size-one decoding is the purest memory-bandwidth benchmark in machine learning. You read every weight exactly once, do a trivial amount of arithmetic per byte, and emit a token. So the performance ceiling is arithmetic you can do on a napkin: Llama-3.2-1B in bf16 is about 2.48 GB of weights, an H100 SXM streams roughly 3.35 TB/s, so the floor is around 740 microseconds per forward pass, about 1350 tokens per second. A B200 should manage close to 3,000.

Measure vLLM or SGLang on that workload and you will find them at or below 50 percent of peak bandwidth. The gap is not a kernel-quality problem. Every individual kernel in those stacks is excellent. The gap is the *boundaries between them*.

## Where the microseconds go

A conventional engine decomposes one forward pass into something like a hundred kernels: RMS norm, QKV projection, RoPE, attention, output projection, residual add, another norm, up and gate projections, SiLU, down projection, residual, repeat, then the LM head. Every one of those launches costs you in three distinct ways.

**Strict kernel ordering.** CUDA guarantees that no block of kernel *N+1* begins until every block of kernel *N* has retired. That is a full-device barrier. If your down projection launches 512 blocks on a 148-SM B200, the last wave occupies 512 mod 148 = 68 SMs and leaves 80 idle until the stragglers finish. You pay that tail on every kernel.

**Launch and teardown.** Timing a do-nothing kernel on an H100 gives roughly 2.1 microseconds per launch on a stream, dropping only to about 1.3 microseconds with CUDA graphs. That is per launch, and it does not overlap with anything useful.

**Post-launch load latency.** Even after a kernel starts, its first warps stall for thousands of cycles waiting for weights and activations to arrive from HBM. The memory pipeline was empty at launch and has to be refilled from scratch.

Do the pessimistic arithmetic the Stanford Hazy Research group did: seven launches per layer, sixteen layers, five microseconds of stall each. That alone caps you around 770 forward passes per second, roughly half the roofline, before any real work happens. The pipeline is not slow. It is repeatedly drained.

NVIDIA's Programmatic Dependent Launch (PDL) helps by letting a kernel begin its prologue while its predecessor drains, but its synchronization primitive, `cudaGridDependencySynchronize`, is all-or-nothing. You want to start attention on head 0 as soon as Q, K, and V for head 0 land. PDL makes you wait for all of Q, K, and V.

## One launch, one interpreter

The megakernel answer is blunt: launch one persistent kernel that occupies every SM for the whole forward pass, and move scheduling *inside* the GPU. Hazy Research's implementation (built on ThunderKittens) does this with an on-device interpreter. Each SM runs a loop pulling opcoded **instructions** off its own queue:

```cpp
// One persistent block per SM. The schedule is computed in Python
// ahead of time and amortized over hundreds of forward passes.
__global__ void megakernel(const Globals g) {
    int sm = blockIdx.x;
    for (int pc = 0; ; pc++) {
        Instruction inst = g.schedule[sm][pc];
        if (inst.opcode == OP_HALT) break;
        switch (inst.opcode) {
            case OP_RMS_QKV_ROPE: run<RmsQkvRope>(g, inst); break;
            case OP_ATTENTION:    run<Attention>(g, inst);  break;
            case OP_ATTN_REDUCE:  run<AttnReduce>(g, inst); break;
            case OP_O_PROJ_RES:   run<OProjResidual>(g, inst); break;
            case OP_RMS_UP_GATE:  run<RmsUpGateSiLU>(g, inst); break;
            case OP_DOWN_RES:     run<DownProjResidual>(g, inst); break;
            case OP_RMS_LM_HEAD:  run<RmsLmHead>(g, inst); break;
        }
    }
}
```

Every instruction type implements one shared template with load, compute, store, and finish hooks, so the interpreter can overlap the tail of one instruction with the head of the next. That is the entire point.

## Correctness without the free barrier

Deleting kernel boundaries deletes the dependency guarantees they gave you for free. You have to rebuild them, and this is where megakernels get interesting.

Dependencies become an explicit counter array in global memory, zeroed before launch. A producer bumps a counter when it finishes; a consumer spins until the counter reaches its target.

```cpp
// Producer: publish, then signal. Order matters.
__device__ void finish(const Globals& g, int event_id) {
    __threadfence();                          // make stores visible device-wide
    if (threadIdx.x == 0)
        atomicAdd(&g.counters[event_id], 1);
}

// Consumer: block until the specific inputs I need are ready.
__device__ void await(const Globals& g, int event_id, int target) {
    if (threadIdx.x == 0)
        while (atomicAdd(&g.counters[event_id], 0) < target) __nanosleep(20);
    __syncthreads();
}
```

The `__threadfence()` before the increment is not optional. Without it, a consumer on another SM can observe the counter update while the data it guards is still sitting in a store buffer, and you get silent numerical garbage that looks like a bad quantization bug.

The payoff for this bookkeeping is *finer* granularity than a kernel boundary could ever express. Instead of waiting on the whole MLP hidden state before the down projection, split the intermediate into four chunks with four counters. Each down-projection instruction blocks only on its own chunk:

```cpp
// Chunked pipelining: 4x more overlap than a whole-tensor dependency.
constexpr int CHUNKS = 4;
await(g, EVENT_UPGATE_BASE + inst.chunk_id, /*target=*/g.blocks_per_chunk);
matvec(g.down_w + inst.chunk_id * chunk_bytes, g.hidden + ..., out);
```

The second constraint is shared memory. An instruction can only prefetch weights if it has somewhere to put them, so shared memory is **paged**: on H100 the first 213 KB is carved into thirteen 16 KiB pages, with the remainder reserved for instruction parameters. Instructions explicitly acquire and release pages, and the interpreter hands a released page to the next instruction immediately. The next instruction's loads therefore begin *while its predecessor is still writing its results out*. That overlap is what fills the bubble.

## What it buys, and where the time still goes

Hazy Research's megakernel hits 78 percent of H100 memory bandwidth, sub-millisecond per forward pass on H100 for a 16-bit 1B+ model, and under 680 microseconds on B200. Roughly 2.5x versus vLLM and over 1.5x versus SGLang on H100; over 3.5x and over 1.5x respectively on B200.

The remaining B200 breakdown is the honest part, and it is a good lesson in what "memory bound" actually means at this scale. Of about 600 microseconds: 250 go to storing, making consistent, and reloading *activations* (two load and two store latencies per instruction at roughly 500 ns each); 200 to RMS norm plus matrix-vector work; only 30 to waiting on weights, and 40 percent of that is the LM head; 40 to warp-level synchronization (a CUDA async barrier costs about 60 ns even when it is already satisfied); 80 to setup and miscellany. The weights, ostensibly the whole problem, are now a rounding error. The bottleneck moved to activation round-trips and synchronization overhead.

## The same idea, compiled

Mirage Persistent Kernel (MPK), from a CMU/UW/Berkeley/NVIDIA/Tsinghua group, reaches the same destination from the compiler side. It lowers a PyTorch graph into a fine-grained **task graph** where a task is a compute or communication unit sized to one SM, and an **event** is a synchronization point with a triggering side and a dependent side. SMs are statically partitioned at launch into *workers* (one per SM, each with a task queue: fetch, execute, notify) and *schedulers* (one warp each, so up to four co-resident per SM, dequeuing activated events and launching dependents). Inter-task overhead lands around 1 to 2 microseconds.

The interesting extra win is communication. Because an allreduce task can depend on the specific matmul task that produced its input chunk, MPK overlaps collectives with partial matmul results, something a kernel-per-operator model structurally cannot do. On a single A100 40GB decoding 512 tokens, per-token latency drops from 14.5 ms for tuned vLLM/SGLang to 12.5 ms against a ~10 ms floor (16 GB at 1.6 TB/s), and the authors report 1.2-6.7x end-to-end across configurations, with the margin widening as GPU count grows.

## The catch

Megakernels are not free lunch, and both groups say so. The schedule is computed ahead of time and static, which makes mixture-of-experts routing and other data-dependent control flow awkward. Register pressure is set by the *worst* instruction in the kernel, so one greedy op taxes everything. Occupancy is fixed at one block per SM, so you lose the latency hiding that oversubscription normally provides. Reconciling the model with Blackwell-style warp specialization is an open question. And debugging a hand-rolled global-memory dependency graph is exactly as pleasant as it sounds.

The generalizable lesson is not "fuse everything." It is that the abstraction boundaries a platform gives you for free are still boundaries, and at microsecond scale their cost stops being noise. Once your compute per byte drops low enough, the *scheduler* becomes the workload.
