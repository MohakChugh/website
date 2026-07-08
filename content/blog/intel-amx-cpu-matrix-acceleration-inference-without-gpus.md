---
title: "Intel AMX: Hardware Matrix Multiplication on CPUs and the Death of GPU-Only Inference"
date: 2026-07-09
tags: ["amx", "cpu-inference", "matrix-multiplication", "bfloat16", "hardware-acceleration"]
excerpt: "Intel's Advanced Matrix Extensions (AMX) bring dedicated matrix multiply-accumulate hardware to server CPUs, enabling BFloat16 and INT8 inference workloads at throughputs that challenge discrete accelerators for small-batch serving."
---

# Intel AMX: Hardware Matrix Multiplication on CPUs and the Death of GPU-Only Inference

The assumption that neural network inference requires GPUs is increasingly wrong. Intel's Advanced Matrix Extensions (AMX), shipping since Sapphire Rapids (4th Gen Xeon, 2023) and refined in Emerald Rapids and Granite Rapids, embed dedicated matrix multiply-accumulate (MMA) units directly into server CPUs. For small-batch inference, latency-sensitive serving, and cost-constrained deployments, AMX fundamentally changes the hardware calculus.

## Architecture: Tiles and TMUL

AMX introduces two new architectural concepts: **tile registers** and a **tile matrix multiply unit (TMUL)**.

### Tile Registers

AMX adds eight 1KB tile registers (`tmm0`–`tmm7`) to the CPU core. Each tile is a 2D register configurable up to 16 rows × 64 bytes. The actual dimensions depend on the data type:

- **BFloat16 (BF16):** 16 rows × 32 columns (16×32 matrix of 2-byte elements)
- **INT8:** 16 rows × 64 columns (16×64 matrix of 1-byte elements)

A `TILECFG` register stores the configured dimensions for all eight tiles, set via the `LDTILECFG` instruction.

### TMUL: The Matrix Engine

The TMUL unit performs a fused multiply-accumulate on entire tiles in a single instruction:

```
TDPBF16PS tmm0, tmm1, tmm2   ; tmm0 += tmm1 × tmm2 (BF16 inputs, FP32 accumulator)
TDPBSSD   tmm0, tmm1, tmm2   ; tmm0 += tmm1 × tmm2 (INT8 inputs, INT32 accumulator)
```

A single `TDPBF16PS` computes a 16×32 × 32×32 matrix multiplication, producing 16×32 = 512 FP32 results with 32×32 = 1024 multiply-accumulate operations per element pair. That is **16,384 BF16 MAC operations per instruction**.

At 1 GHz (conservative for modern Xeons), one core sustains **16.4 TFLOPS** in BF16 — and a 64-core Granite Rapids chip theoretically peaks over **1 PFLOPS** in AMX BF16 throughput.

## The Memory Wall: Why Tiles Matter

Matrix multiplication is memory-bound at small batch sizes. The genius of tile registers is data reuse. Consider a standard GEMM: C[M×N] += A[M×K] × B[K×N].

Without AMX, vectorized FMA (AVX-512) processes one row at a time. Each FMA instruction consumes one row of A and one column of B, producing one element of C. The ratio of arithmetic to memory traffic is low.

With AMX tiles:

```
; Load A tile (16×32 BF16 = 1KB)
TILELOADD tmm1, [rsi + stride_a]

; Load B tile (32×32 BF16 = 2KB, but stored as 16×64 bytes)
TILELOADD tmm2, [rdi + stride_b]

; Multiply-accumulate: 16K ops from 3KB of loads
TDPBF16PS tmm0, tmm1, tmm2
```

Three 1KB loads drive 16,384 operations. That is **5.46 ops/byte**, compared to ~2 ops/byte for well-tuned AVX-512 GEMM. The tile registers act as a software-managed scratchpad that keeps operands resident across multiple multiply-accumulate steps when you tile your loops.

## Practical Tiling for Transformer Inference

A transformer's feedforward layer computes `Y = X @ W + b` where X is [batch × d_model] and W is [d_model × d_ff]. For LLaMA-7B: d_model=4096, d_ff=11008.

The tiling strategy for AMX:

```c
// Pseudocode: AMX-tiled GEMM for FFN layer
// M=batch, K=4096, N=11008
// Tile dimensions: Mr=16, Kr=32 (BF16), Nr=32

for (int n = 0; n < N; n += Nr) {         // 344 iterations
    tile_zero(tmm0);                        // Clear accumulator
    for (int k = 0; k < K; k += Kr) {      // 128 iterations
        tileload(tmm1, &X[m][k], stride);  // 16×32 of X
        tileload(tmm2, &W[k][n], stride);  // 32×32 of W (transposed)
        tdpbf16ps(tmm0, tmm1, tmm2);       // Accumulate
    }
    tilestore(tmm0, &Y[m][n], stride);     // Write 16×32 of Y
}
```

Each inner loop iteration: 16×32×32 = 16,384 MACs. The full K-dimension reduction: 128 × 16,384 = 2,097,152 MACs per 16×32 output tile. Total for one batch of 16 tokens: ~2.1M × 344 ≈ 721M MACs = 1.44 GFLOPS of useful work per output row set.

## Benchmark Reality: AMX vs. AVX-512 vs. GPU

On a dual-socket Sapphire Rapids 8480+ (2×56 cores, 2.0 GHz base):

| Workload | AVX-512 BF16 | AMX BF16 | A10G GPU |
|----------|-------------|----------|----------|
| BERT-Base (batch=1) | 1.8ms | 0.4ms | 0.9ms* |
| LLaMA-7B decode (batch=1) | 68ms/tok | 22ms/tok | 14ms/tok |
| LLaMA-7B decode (batch=8) | 71ms/tok | 24ms/tok | 5ms/tok |

*Includes PCIe transfer overhead for batch=1

The critical insight: at batch=1, AMX on CPU **beats** an A10G GPU because there is no PCIe round-trip, no kernel launch overhead, and no underutilization of GPU SMs. The GPU wins decisively at higher batch sizes where it can saturate its memory bandwidth and compute.

## Software Stack: oneDNN and Compiler Integration

AMX is exposed through Intel's oneDNN (oneAPI Deep Neural Network Library), which PyTorch and TensorFlow call via their backend dispatchers:

```python
import torch
# PyTorch automatically dispatches to AMX on capable hardware
model = torch.load("llama-7b-bf16.pt")
model = model.to(dtype=torch.bfloat16)

# Intel Extension for PyTorch optimizes AMX dispatch
import intel_extension_for_pytorch as ipex
model = ipex.optimize(model, dtype=torch.bfloat16)

# Inference now uses AMX TMUL under the hood
with torch.no_grad():
    output = model(input_ids)
```

The `ipex.optimize()` call rewrites linear layers to use oneDNN's AMX-aware GEMM kernels, fuses bias additions and activations, and reorders weight tensors into tile-friendly memory layouts (blocking factor 32 along the K dimension).

## OS and Scheduler Implications

AMX tiles are lazily initialized. The `XSAVE`/`XRSTOR` state for eight 1KB tiles adds **8KB** to the thread context-switch cost. Linux handles this via `INIT_OPTIMIZATION`: tile registers are marked as "init state" (zeroed) and are not saved/restored until a thread actually executes a tile instruction.

The kernel must also manage the `XFD` (Extended Feature Disable) mechanism:

1. Thread calls `TILELOADD` for the first time
2. CPU raises #NM (device-not-available) fault
3. Kernel allocates 8KB XSAVE buffer, enables AMX for that thread
4. Thread resumes and the instruction succeeds

This means the first AMX instruction per thread has a ~microsecond penalty, but subsequent context switches amortize the 8KB save/restore across the tile's actual usage.

## When AMX Beats GPUs: The Economics

Consider a serving scenario: 10,000 requests/second, each requiring one forward pass of a 7B-parameter model at batch=1 (real-time chat, latency-sensitive).

**GPU approach:** 3× A10G GPUs ($1.50/hr each) to handle the throughput at 14ms/inference. Cost: $4.50/hr.

**CPU approach:** 1× dual-socket Sapphire Rapids (c7i.metal-48xl equivalent, ~$4.80/hr) with 112 cores. At 22ms/inference and 112 cores available, parallel throughput = 112/0.022 ≈ 5,090 inferences/second per socket. Two sockets: ~10,000/sec. Cost: $4.80/hr — comparable, but with the CPU also handling all other application logic, networking, and preprocessing without PCIe hops.

The real win is **co-location**: the inference runs in the same address space as the application, eliminating serialization, network calls to a GPU serving tier, and cold-start latency.

## The Granite Rapids Generation

5th Gen Xeon (Granite Rapids, 2024) doubles AMX throughput by widening the TMUL pipeline and adding FP16 support alongside BF16. Early benchmarks show 1.8-2.1× improvement over Sapphire Rapids on the same workloads, bringing batch=1 LLaMA-7B decode under 12ms/token on a single socket.

More significantly, Granite Rapids introduces **AMX-FP16** (`TDPFP16PS`), enabling direct FP16 accumulation without the BF16 mantissa truncation. This matters for long attention sequences where BF16's 7-bit mantissa accumulates rounding errors across thousands of tokens.

## Implications

AMX does not replace GPUs for training or high-batch serving. But it eliminates the assumption that inference requires a discrete accelerator. For latency-sensitive, small-batch workloads — which describes most real-time serving — CPU-resident inference with AMX is already competitive and improving with each generation.

The hardware matrix multiply unit is becoming as standard on server CPUs as SIMD was a decade ago. Within two generations, the question will not be "do you need a GPU?" but "at what batch size does a GPU become worth the complexity?"
