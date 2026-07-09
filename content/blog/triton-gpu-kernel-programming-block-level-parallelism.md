---
title: "Triton: Block-Level GPU Programming Without CUDA"
date: "2026-07-09"
tags: ["gpu", "triton", "kernel-fusion", "compiler", "ml-inference"]
excerpt: "How OpenAI's Triton compiler enables writing fused GPU kernels through block-level programming, automatic memory coalescing, and tile-based execution, eliminating CUDA boilerplate while matching hand-tuned performance."
---

# Triton: Block-Level GPU Programming Without CUDA

Writing high-performance GPU kernels has historically required deep CUDA expertise: managing shared memory, warp-level primitives, memory coalescing, occupancy tuning, and register pressure. OpenAI's Triton compiler collapses this complexity into a block-level programming model where developers think in tiles rather than threads, and the compiler handles the low-level scheduling decisions that consume 80% of a CUDA programmer's time.

Triton powers Flash Attention, PyTorch's `torch.compile` inductor backend, and most state-of-the-art inference engines. Understanding its execution model reveals why fused kernels dominate modern ML systems.

## The Problem: Memory Bandwidth is the Bottleneck

Consider a simple elementwise operation: `y = relu(x + bias)`. In a naive PyTorch implementation, this launches two kernels (addition, then ReLU), each reading from and writing to global memory. On an A100 with 2 TB/s HBM bandwidth but 312 TFLOPS of compute, the operation is entirely memory-bound. The data moves through HBM twice unnecessarily.

Kernel fusion solves this: a single kernel reads `x` and `bias`, computes `x + bias`, applies ReLU, and writes the result once. But writing fused CUDA kernels requires handling thread indexing, shared memory allocation, bank conflicts, and synchronization barriers manually. A 10-line PyTorch operation becomes 80 lines of CUDA.

## Triton's Programming Model: Tiles, Not Threads

Triton operates at the **block level**. Instead of programming individual threads (CUDA) or warps, you program over tiles of data. The compiler maps these tiles to the GPU's execution hierarchy.

```python
import triton
import triton.language as tl

@triton.jit
def fused_add_relu_kernel(
    x_ptr, bias_ptr, out_ptr,
    n_elements,
    BLOCK_SIZE: tl.constexpr,
):
    pid = tl.program_id(axis=0)
    block_start = pid * BLOCK_SIZE
    offsets = block_start + tl.arange(0, BLOCK_SIZE)
    mask = offsets < n_elements

    x = tl.load(x_ptr + offsets, mask=mask)
    bias = tl.load(bias_ptr + offsets, mask=mask)

    result = tl.maximum(x + bias, 0.0)

    tl.store(out_ptr + offsets, result, mask=mask)
```

Key observations:

1. **`tl.program_id`** identifies the current block (analogous to CUDA's `blockIdx`), but there is no `threadIdx`. The compiler decides how to partition work within a block across warps and threads.
2. **`tl.arange(0, BLOCK_SIZE)`** creates a vector of offsets. This entire vector is the unit of computation, a tile.
3. **`tl.load` and `tl.store`** with masks handle boundary conditions. The compiler generates predicated loads that avoid out-of-bounds access.
4. **`BLOCK_SIZE: tl.constexpr`** is a compile-time constant that enables auto-tuning.

## Compiler Passes: What Triton Does Automatically

The Triton compiler performs several optimizations that a CUDA programmer would implement manually:

### Memory Coalescing
When a block loads `tl.arange(0, 1024)` consecutive elements, Triton recognizes the access pattern and generates coalesced 128-byte transactions. For strided access patterns, it automatically inserts shared memory staging with proper bank-conflict avoidance.

### Shared Memory Allocation
For operations like matrix multiplication where tiles are reused, Triton automatically allocates shared memory for tile staging:

```python
@triton.jit
def matmul_kernel(
    a_ptr, b_ptr, c_ptr,
    M, N, K,
    BLOCK_M: tl.constexpr,
    BLOCK_N: tl.constexpr,
    BLOCK_K: tl.constexpr,
):
    pid_m = tl.program_id(0)
    pid_n = tl.program_id(1)

    offs_m = pid_m * BLOCK_M + tl.arange(0, BLOCK_M)
    offs_n = pid_n * BLOCK_N + tl.arange(0, BLOCK_N)

    accumulator = tl.zeros((BLOCK_M, BLOCK_N), dtype=tl.float32)

    for k in range(0, K, BLOCK_K):
        offs_k = k + tl.arange(0, BLOCK_K)
        a = tl.load(a_ptr + offs_m[:, None] * K + offs_k[None, :])
        b = tl.load(b_ptr + offs_k[:, None] * N + offs_n[None, :])
        accumulator += tl.dot(a, b)

    tl.store(c_ptr + offs_m[:, None] * N + offs_n[None, :], accumulator)
```

The compiler sees that `a` and `b` tiles are loaded inside a loop, determines they should be staged in shared memory, inserts `__syncthreads()` barriers, and manages double-buffering to overlap computation with the next tile's load.

### Automatic Pipelining
Triton 3.0 introduced software pipelining for the K-loop in GEMM kernels. While one tile is being computed via tensor cores, the next tile's global memory load is issued asynchronously via `cp.async`. This hides memory latency without explicit programmer intervention.

## Auto-Tuning: The Missing Piece

The `BLOCK_SIZE` parameters are not arbitrary. Optimal values depend on the specific GPU (SM count, shared memory size, register file capacity) and problem dimensions. Triton provides a declarative auto-tuning mechanism:

```python
@triton.autotune(
    configs=[
        triton.Config({'BLOCK_M': 128, 'BLOCK_N': 128, 'BLOCK_K': 32}, num_warps=4),
        triton.Config({'BLOCK_M': 64, 'BLOCK_N': 256, 'BLOCK_K': 32}, num_warps=8),
        triton.Config({'BLOCK_M': 256, 'BLOCK_N': 64, 'BLOCK_K': 64}, num_warps=4),
    ],
    key=['M', 'N', 'K'],
)
@triton.jit
def matmul_kernel(...):
    ...
```

The `key` parameter specifies which runtime values affect the optimal configuration. Triton benchmarks all configurations on first invocation and caches the winner. The `num_warps` parameter controls how many warps execute each block, directly affecting occupancy and register pressure.

## How Flash Attention Uses Triton

Flash Attention's core insight is computing softmax in tiles without materializing the full attention matrix. In Triton, this translates naturally:

```python
# Simplified Flash Attention forward pass structure
for j in range(0, seqlen_k, BLOCK_N):
    k_block = tl.load(K + ...)  # Load K tile
    qk = tl.dot(q_block, tl.trans(k_block))  # Q @ K^T tile

    # Online softmax: track running max and denominator
    m_new = tl.maximum(m_prev, tl.max(qk, axis=1))
    alpha = tl.exp(m_prev - m_new)
    p = tl.exp(qk - m_new[:, None])

    # Rescale accumulator and add new contribution
    acc = acc * alpha[:, None]
    v_block = tl.load(V + ...)
    acc += tl.dot(p, v_block)

    l_prev = l_prev * alpha + tl.sum(p, axis=1)
    m_prev = m_new
```

The tiled softmax with running statistics (the online softmax trick from Milakov and Gimelshein, 2018) maps perfectly to Triton's block model. Each program instance processes one query tile against all key/value tiles, accumulating in registers without writing intermediate attention weights to HBM.

## Performance Characteristics

On an H100, Triton-generated kernels typically achieve:

- **Elementwise fusions**: 95-100% of peak memory bandwidth (matching hand-written CUDA)
- **GEMM**: 85-95% of cuBLAS for large matrices, sometimes exceeding it for non-standard shapes
- **Attention**: Within 5% of hand-tuned CUTLASS kernels for standard configurations

The gap appears in three scenarios: (1) very small problem sizes where launch overhead dominates, (2) operations requiring warp-level primitives like warp shuffle that Triton's block model cannot express directly, and (3) kernels needing persistent-kernel techniques where a single block processes multiple tiles in sequence without returning to the scheduler.

## Triton IR and the Compilation Pipeline

Triton compiles through multiple intermediate representations:

```
Python AST → Triton IR (MLIR dialect) → Triton GPU IR → LLVM IR → PTX → SASS
```

The Triton GPU IR stage is where hardware-specific decisions are made: tile layout in shared memory, warp assignment, and instruction scheduling. Since Triton 3.0, this stage targets NVIDIA's Hopper architecture natively, emitting `wgmma` (Warp Group Matrix Multiply Accumulate) instructions that use the new Tensor Memory Accelerator (TMA) for asynchronous tile copies.

## When Not to Use Triton

Triton excels at structured, data-parallel computations with regular memory access patterns. It struggles with:

- **Irregular control flow**: Sparse operations where different elements take radically different code paths
- **Inter-block communication**: Algorithms requiring global synchronization (use multi-kernel approaches instead)
- **Sub-warp operations**: Bit manipulation, ballot operations, or warp-level reductions with non-power-of-2 sizes

For these cases, raw CUDA (or CUTLASS for GEMM variants) remains necessary. Triton's value proposition is eliminating the 90% of kernels that are structured but tedious.

## The Broader Implication

Triton represents a shift in GPU programming philosophy: from "the programmer controls everything" to "the programmer specifies the algorithm's structure, the compiler maps it to hardware." This is the same transition that happened with SQL (declarative) versus manual B-tree traversal, or with vectorized query engines versus hand-coded iterators.

As GPU architectures grow more complex (Hopper's TMA, Blackwell's fifth-generation Tensor Cores, AMD's CDNA matrix cores), the value of a portable block-level abstraction increases. Code written in Triton today can target new hardware with a compiler update rather than a rewrite. PyTorch's inductor backend bets on this: every `torch.compile` call generates Triton kernels, making Triton the de facto standard for ML kernel authoring in 2025.
