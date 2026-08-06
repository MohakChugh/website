---
title: "Processing-in-Memory Has the Bandwidth. It Was Wasting 85 Percent of It on Command Stalls"
date: 2026-08-06
tags: [processing-in-memory, llm-inference, computer-architecture, dram, kv-cache]
excerpt: "DRAM-PIM puts MAC units inside every bank, so attention decode should stop being memory-bound. Measured MAC utilization at a head dimension of 128 is 14.7 percent. PIMphony (HPCA 2026) shows all three causes live in the control path, not the datapath: head-first channel partitioning that starves channels, static command scheduling that serializes I/O against compute, and physical addresses baked into precompiled instructions that force worst-case KV allocation. Fixing them costs under 5 percent area and yields up to 11.3x."
---

Attention decode is the canonical memory-bound kernel: each step reads the entire KV cache and does almost nothing with it. Processing-in-Memory is the canonical answer, putting vector MAC units inside every DRAM bank so the arithmetic happens where the bytes already are, at internal bank bandwidth rather than across the pins.

The mechanism is sound and the silicon is real, so sit with the number PIMphony (HPCA 2026) reports for a commercial-class DRAM-PIM running attention at head dimension 128: **MAC utilization of 14.7 percent** — not of some idealized roofline, but of the MAC units physically wired into the banks, on the kernel PIM was built for. The bandwidth was delivered. Six sevenths of the compute sat idle waiting for a command scheduler.

## Attention decode is memory-bound at every context length

The usual framing says long context makes attention memory-bound. Compute the arithmetic intensity per decode step, one head, KV cache of `T` tokens, head dimension `dh`, GQA group size `g`:

```python
def intensity(T, dh, g):
    kv_bytes = 2 * (2 * T * dh)      # K and V, FP16
    flops    = 2 * (2 * g * T * dh)  # QK^T and SV, multiply + add
    return flops / kv_bytes

# T=32768, dh=128
# g=1 -> 1.0 OPs/byte    g=4 -> 4.0
# g=2 -> 2.0 OPs/byte    g=8 -> 8.0
```

Both `T` and `dh` cancel. Arithmetic intensity is exactly `g`, the GQA group size, and nothing else. Multi-head attention decode runs at **1 OP per byte** at 512 tokens and at 1M tokens alike.

So long context does not make attention memory-bound; attention decode always was. What long context changes is attention's *share* of the step, since FFN cost is fixed per token while attention's grows linearly in `T`, and capacity, since the KV cache grows until it, not the weights, dominates the footprint. Both argue for PIM, and both are why the failures below are costly, hitting the one operation with no compute headroom to hide them.

## Where the bandwidth goes

A PIM module in this class (AiM-family GDDR6-PIM, 16 banks per channel) executes GEMV through three controller-issued primitives:

| Command | Effect | Granularity |
|---|---|---|
| `WR-INP` | GPR to Global Buffer entry | 32 B tile (16 FP16 values) |
| `MAC` | dot product over one DRAM row, accumulate into per-bank OutReg | one row |
| `RD-OUT` | drain OutRegs to GPR | 2 B from each of 16 banks = 32 B |

Every dot product is a `WR-INP` to `MAC` to `RD-OUT` pipeline, and the buffers are tiny: 2 KB of input per channel, 4 bytes of output per bank. Count commands per channel for attention against a feed-forward projection:

```python
TILE, BANKS = 32, 16
ELEMS = TILE // 2                      # FP16 values per tile

def cmd_mix(din, dout):
    wr_inp  = din // ELEMS
    mac     = (din // ELEMS) * (dout // BANKS)
    rd_out  = max(1, dout // BANKS)
    return (wr_inp + rd_out) / mac     # I/O commands per MAC command

cmd_mix(128,   32768)  # QK^T, T=32K -> 0.13
cmd_mix(32768, 128)    # SV,   T=32K -> 0.13
cmd_mix(4096,  11008)  # FFN gate proj -> 0.01
cmd_mix(4096,  4096)   # QKV / out proj -> 0.01
```

Attention issues **13 times more I/O commands per MAC** than an FFN projection. The cause is structural and symmetric: `QK^T` has `din = dh = 128`, so output reuse is poor; `SV` has `dout = dh = 128`, so input reuse is poor. Attention always has one small dimension, because `dh` is a small constant by design, and tiling cannot remove it.

That ratio need not cost anything, if I/O overlaps compute. Under static scheduling it does not. Three failures follow, all in the control path.

## Static scheduling: correct, conservative, and catastrophic

A conventional PIM controller issues commands strictly in the compiled order with fixed inter-command timing. It does not track which buffer entry each command touches, so it must assume every adjacent pair conflicts and insert the worst-case gap. That is where the missing 85 percent went: not to bandwidth limits, refresh, or activate/precharge, but to a scheduler enforcing dependencies that mostly do not exist, on the kernel issuing 13x more I/O than any other.

Dynamic Command Scheduling fixes it with two tables any out-of-order CPU designer will recognize: a **Dependency Table**, recording for each buffer entry the most recent command that touched it, and a **Status Table**, holding per entry the last accessing command ID plus an *expiration cycle*. A command issues only when the S-Table ID matches its dependency ID and the cycle has passed that expiration. Commands split into I/O and compute queues, in order within each, out of order across them.

Two details do the real work. **Timing relaxation:** a MAC depending on `W0` issues as soon as `W0` retires, even with later writes in flight, because it never touches their entries. **Consecutive-MAC bypass:** an `is-MAC` flag marks back-to-back MACs accumulating into the *same* OBuf location; these form a serial reduction chain but can be pipelined, so the controller collapses the `tMAC` gap to the minimum bus interval `tCCDS`. The example command stack drops from 34 cycles to 22, a 1.55x local speedup.

The comparison against ping-pong buffering is the sharpest part of the design. Ping-pong splits a buffer in halves so I/O works one side while MAC works the other, the standard static answer. But switching sides requires both halves to drain, a hand-off stall that smaller per-region buffers make more frequent. DCS keeps one undivided buffer and overlaps *within* a region: same SRAM, up to **1.4x higher compute utilization**, for a 576-byte table and 0.5 percent area.

## Partitioning along the axis that is actually plentiful

Prior PIM systems shard the KV cache across channels by **head and batch** dimension. Both are scarce exactly when you need them: long context forces batch size down via KV capacity, and mixed context lengths imbalance the channels, since one holding a 4K request finishes long before one holding 128K.

Token-Centric Partitioning shards a single head's *token* dimension across all channels instead. The token axis is the one dimension guaranteed to be large in the regime that hurts, and it decouples channel utilization from batch size. Each channel returns a partial result requiring reduction, so TCP partitions tokens only within a module.

What head-first partitioning leaves behind shows up at 1M tokens on a fixed 512 GB system: the PIM-only baseline collapses to **2 percent utilization**, where PIMphony reports 46.6x. Those are consistent, since 2 percent times 46.6 is 93 percent, a check that the speedup is recovered idleness rather than anything exotic.

## Physical addresses compiled into instructions

The third failure is an artifact of the programming model. GPU serving solved variable-length KV allocation with paged attention. PIM cannot copy that, because conventional PIM instructions are **precompiled with fixed loop counts and fixed physical addresses**. The stream has the addresses baked in, so a running system cannot repurpose memory it did not statically reserve.

The consequence is worst-case allocation: reserve `Tmax` per request, forever. Measured capacity utilization runs 31.0 to 40.5 percent, averaging 36.2. Roughly two thirds of an expensive PIM module holds nothing, which caps batch size, which feeds straight back into the channel underutilization above. The three failures are one failure wearing three hats.

Dynamic PIM Access adds an on-module dispatcher with virtual-to-physical translation and instructions carrying *symbolic* operands resolved at dispatch, buying lazy allocation of non-contiguous chunks with fragmentation bounded to each request's final chunk. Utilization goes from 36.2 to **75.6 percent**, a 2.09x improvement, for 4 percent area and under 200 KB of dispatcher buffers against the 512 KB GPR already present.

## Reading the results honestly

Reported speedups: 2.1 to 4.5x on non-GQA models at 32K, up to 11.3x on GQA models at 128K for PIM-only, up to 8.4x for hybrid xPU+PIM, 46.6x at 1M tokens. The headline 11.3x is a long-context GQA number. The more informative figure is buried in the scalability discussion: **2.1x even at 256 tokens.** If the gains were purely about long context that would be near 1.0. Static scheduling and worst-case allocation are wrong at every context length; long context only makes them expensive enough to notice.

One claim deserves scrutiny. The energy result credits background power: at baseline, low utilization leaves the module powered and idle, so background energy is 71.5 percent of attention energy. Accelerating attention shrinks runtime and background energy with it, down to a 13.0 percent share for up to 3.46x reduction. Model background energy as proportional to runtime and dynamic energy as fixed work:

```python
B0, D0 = 0.715, 0.285          # baseline background / dynamic split
for S in (10, 19, 30):         # attention speedup
    total = B0/S + D0
    print(f"{S}x -> bg share {B0/S/total*100:.1f}%, energy {1/total:.2f}x")
# 10x -> 20.1%, 2.81x    19x -> 11.7%, 3.10x    30x -> 7.7%, 3.24x
```

The 13.0 percent share and the paper's stated 19x attention speedup line up well; my model gives 11.7 percent. But that model caps total energy reduction at **1/0.285 = 3.51x** no matter how fast attention gets, and the reported 3.46x sits within a percent and a half of that asymptote. So 3.46x is not a technique with headroom left, it is the ceiling of eliminating idle-power waste entirely. Worth knowing before extrapolating.

## The actual lesson

All three mechanisms are control-path fixes. Dependency tables in a command scheduler. A choice of which tensor axis to shard. An address translation layer. Under 5 percent area total, with no new datapath, no new bank structure, and no bandwidth increase.

That generalizes past PIM. When a specialized accelerator underdelivers on the kernel it was purpose-built for, the instinct is to suspect the datapath and add bandwidth or MACs. Here the datapath was fine. What was missing was the boring machinery general-purpose processors spent forty years acquiring: dependency tracking, out-of-order issue, virtual memory. Near-memory architectures skipped it on the reasonable theory that their kernels were simple and static. Attention decode over variable-length KV caches is neither.

**References.** Kwon et al., "PIMphony: Overcoming Bandwidth and Capacity Inefficiency in PIM-based Long-Context LLM Inference System," HPCA 2026 ([arXiv:2412.20166](https://arxiv.org/abs/2412.20166)). Baselines: Heo et al., "NeuPIMs," ASPLOS 2024 ([arXiv:2403.00579](https://arxiv.org/abs/2403.00579)), and CENT. The arithmetic-intensity, command-ratio, and energy-ceiling derivations above are my own and were run before publishing.
