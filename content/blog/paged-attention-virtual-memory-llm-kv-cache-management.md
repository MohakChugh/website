---
title: "PagedAttention: Virtual Memory for LLM KV Caches"
date: 2026-07-09
tags: ["paged-attention", "vllm", "kv-cache", "virtual-memory", "llm-serving"]
excerpt: "How borrowing virtual memory concepts from operating systems, specifically non-contiguous paging and demand allocation, eliminated 60-80% memory waste in LLM inference and became the universal standard for production serving."
---

# PagedAttention: Virtual Memory for LLM KV Caches

Every LLM inference request generates a KV (key-value) cache that grows token by token. In a 13B parameter model with 40 attention heads and 128-dimensional head embeddings, each token occupies roughly 800KB across all layers. A single 2048-token sequence consumes 1.6GB of KV cache alone. Multiply that by the dozens or hundreds of concurrent requests a production system handles, and KV cache memory becomes the binding constraint on throughput.

Before PagedAttention, the dominant approach was to pre-allocate a contiguous memory block for each sequence at its maximum possible length. This is the equivalent of an operating system that requires every process to declare its peak memory usage upfront and reserves a contiguous physical address range for it. The waste is enormous.

## The Fragmentation Problem

Consider a serving system with 24GB of GPU memory available for KV cache, handling requests with a maximum sequence length of 2048 tokens. The naive approach:

1. A request arrives. We allocate a contiguous 1.6GB block (2048 tokens × 800KB/token).
2. The request generates 347 tokens and finishes. We used 277MB. The other 1.3GB was reserved but never touched.
3. With 24GB total, we can serve at most 15 concurrent sequences. But actual utilization averages 20-30%.

This is external fragmentation (gaps between allocations) combined with internal fragmentation (allocated-but-unused space within each block). Measurements from the original vLLM paper show that existing systems waste 60-80% of KV cache memory to these two forms of fragmentation.

## The OS Analogy

Operating systems solved this exact problem in the 1960s with virtual memory and paging. The key insight: decouple the logical (virtual) address space from the physical memory layout.

A process sees a contiguous virtual address space. The OS maps virtual pages to arbitrary physical frames through a page table. Pages are allocated on demand (demand paging), never pre-allocated. Physical frames need not be contiguous.

PagedAttention applies this directly:

| OS Concept | PagedAttention Equivalent |
|---|---|
| Virtual address space | Logical KV cache of a sequence |
| Physical memory frames | Fixed-size GPU memory blocks |
| Page table | Block table mapping logical→physical |
| Demand paging | Allocate blocks only as tokens generate |
| Page size | Block size (typically 16 tokens) |

## Architecture

The system divides GPU memory into fixed-size **blocks**, each holding the KV vectors for a fixed number of tokens (the block size, typically 16). A **block table** per sequence maps logical block indices to physical block locations.

```
Sequence "Tell me about..."
Logical blocks:  [0] [1] [2] [3] ...
                  |   |   |   |
Block table:      7  13   2  41  ...
                  |   |   |   |
Physical blocks: [7] [13] [2] [41] (non-contiguous in GPU memory)
```

When a new token generates, we check the last logical block. If it has capacity (fewer than block_size tokens), we append there. Otherwise, we allocate a new physical block from a free list and extend the block table. No copying. No reallocation.

```python
class PagedKVCache:
    def __init__(self, num_blocks: int, block_size: int, 
                 num_heads: int, head_dim: int, num_layers: int):
        self.block_size = block_size
        # Pre-allocate the physical block pool
        # Shape: [num_layers, num_blocks, 2, num_heads, block_size, head_dim]
        # The '2' is for K and V tensors
        self.gpu_blocks = torch.zeros(
            num_layers, num_blocks, 2, num_heads, block_size, head_dim,
            dtype=torch.float16, device='cuda'
        )
        self.free_blocks = list(range(num_blocks))
    
    def allocate_block(self) -> int:
        return self.free_blocks.pop()
    
    def free_block(self, block_id: int):
        self.free_blocks.append(block_id)
```

The block table is a simple integer tensor on GPU:

```python
class BlockTable:
    def __init__(self, max_blocks_per_seq: int):
        # Maps logical block index -> physical block id
        self.table = torch.zeros(max_blocks_per_seq, dtype=torch.int32, 
                                 device='cuda')
        self.num_blocks = 0
    
    def append_block(self, physical_block_id: int):
        self.table[self.num_blocks] = physical_block_id
        self.num_blocks += 1
```

## The Attention Kernel

The attention computation must now handle non-contiguous memory. Instead of a single `torch.nn.functional.scaled_dot_product_attention` call over a contiguous KV tensor, the kernel receives the block table and gathers KV vectors from scattered physical locations.

The kernel processes one block at a time per sequence position:

```python
# Simplified PagedAttention kernel logic (actual impl is in CUDA)
def paged_attention(query, kv_cache, block_table, context_len, block_size):
    num_blocks = (context_len + block_size - 1) // block_size
    output = torch.zeros_like(query)
    
    for block_idx in range(num_blocks):
        physical_block = block_table[block_idx]
        # Gather K, V from the physical block
        k_block = kv_cache[physical_block, 0]  # [num_heads, block_size, head_dim]
        v_block = kv_cache[physical_block, 1]
        
        # Standard attention within this block
        attn_weights = torch.matmul(query, k_block.transpose(-1, -2))
        attn_weights = attn_weights / math.sqrt(head_dim)
        # Accumulate with numerically stable online softmax
        output = online_softmax_update(output, attn_weights, v_block)
    
    return output
```

The actual CUDA implementation uses a reduction across thread blocks, where each thread block processes one physical KV block. This maps naturally to GPU execution: each warp handles a block independently, and the final reduction combines partial softmax results using the log-sum-exp trick for numerical stability.

## Copy-on-Write for Parallel Sampling

The paging abstraction enables an elegant optimization for parallel sampling (beam search, best-of-n). When multiple output sequences share a common prefix, their block tables can point to the same physical blocks. Only when a sequence diverges does it need its own copy.

```
Prompt: "Write a poem about"
  Sequence A block table: [7, 13, 2, ...]  (blocks 7,13 = shared prefix)
  Sequence B block table: [7, 13, 5, ...]  (diverges at block 2)
  Sequence C block table: [7, 13, 9, ...]
```

Physical blocks 7 and 13 store the prefix KV cache once. A reference count tracks sharing. When a shared block needs modification, copy-on-write allocates a new physical block, copies the contents, and updates only that sequence's block table. This is identical to how fork() works in Unix: parent and child share pages until one writes.

For beam search with beam width 4 on a 1024-token prefix, this saves 3× the prefix memory (3 copies eliminated). In practice, parallel sampling throughput improves 2-4× with copy-on-write.

## Preemption and Swapping

With fine-grained block allocation, the system can implement preemption. When GPU memory pressure is high, the scheduler can:

1. **Evict** a low-priority sequence's blocks to CPU memory (swap out)
2. **Resume** it later by copying blocks back (swap in)

This is direct demand paging with a backing store. The block table abstraction means swapping is per-block, not per-sequence. A partially-generated sequence can have some blocks on GPU and others on CPU, with the scheduler fetching blocks just-in-time.

## Quantitative Impact

The original vLLM paper (Kwon et al., SOSP 2023) demonstrates:

- **Memory waste reduction**: From 60-80% waste to <4% (only the last block per sequence has internal fragmentation, bounded by block_size tokens)
- **Throughput improvement**: 2-4× over HuggingFace Transformers, 2.2× over FasterTransformer on OPT-13B
- **Batch size scaling**: Serving 5× more concurrent sequences in the same memory budget
- **Near-zero overhead**: Block table lookup adds <1% to attention kernel latency

The block size creates a tradeoff: smaller blocks reduce internal fragmentation but increase block table overhead and reduce memory access coalescing. Empirically, 16 tokens per block balances these concerns.

## The Ecosystem Impact

PagedAttention became the default memory management strategy across the LLM serving ecosystem within 18 months of publication:

- **vLLM** (the reference implementation) became the most widely deployed open-source serving engine
- **TensorRT-LLM** adopted paged KV cache as its memory backend  
- **SGLang** uses a radix tree of paged blocks (combining PagedAttention with prefix caching)
- **DeepSpeed-FastGen** implements SplitFuse, built on paged memory
- **Ollama, LMDeploy, MLC-LLM** all use paged KV cache variants

The universality of adoption reflects how fundamental the insight is: KV cache is a memory management problem, and OS designers solved memory management problems decades ago. The innovation was recognizing the mapping and implementing it efficiently on GPU hardware.

## Beyond Paging: What's Next

Recent work extends the virtual memory analogy further:

- **Hierarchical paging** with multiple block sizes for different attention patterns (local vs. global)
- **Compression within blocks** (quantizing KV values in cold blocks to 4-bit, analogous to memory compression in modern OSes)
- **Distributed paging** across multiple GPUs with RDMA-based block migration (disaggregated KV cache)
- **Speculative block allocation** for predicted generation lengths, reducing allocation overhead

The lesson generalizes beyond LLMs: whenever a system must manage growing, variable-length, concurrent memory regions on constrained hardware, the OS memory management playbook, paging, demand allocation, copy-on-write, and swapping, is likely the right abstraction. PagedAttention proved that this principle transfers directly to GPU-resident ML workloads.
