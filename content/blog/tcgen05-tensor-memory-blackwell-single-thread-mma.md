---
title: "Tensor Memory: Why Blackwell's MMA Is Issued by One Thread"
date: 2026-08-16
tags: [gpu, cuda, blackwell, kernels, performance]
excerpt: "Blackwell's tcgen05 instructions break two rules that every GPU matrix-multiply kernel has been built around: accumulators no longer live in registers, and the MMA is no longer collective. I worked through the PTX ISA's Tensor Memory chapter and derived the arithmetic that forced both changes — accumulator traffic per FLOP scales as K/4, and every new tcgen05 kind lands at exactly 2x Hopper's per-SM accumulator bandwidth. That number is the whole design."
---

Every generation of NVIDIA tensor core has changed the shape of the MMA instruction. Volta's `mma.sync` was a quad-pair affair; Ampere widened it; Hopper's `wgmma.mma_async` made it warpgroup-collective and let the A operand come straight from shared memory. Through all of that, one thing held: the accumulator lived in registers, distributed across the threads that issued the instruction.

Blackwell's 5th-generation tensor core breaks that. The `tcgen05` instruction family (PTX ISA 8.6+) introduces **Tensor Memory** — a separate on-chip address space that exists solely to hold accumulators and operands — and along with it an MMA instruction that, per the PTX spec, "has single thread semantics, unlike the collective instructions `mma.sync` or `wgmma.mma_async`."

One thread issues the matrix multiply. That reads like a simplification. It is actually the consequence of an arithmetic problem that had run out of room.

## The accumulator was always the bottleneck, and it got worse

Count the traffic. An M×N×K MMA does 2·M·N·K FLOP and touches the accumulator tile once for read and once for write: 2·M·N·4 bytes for fp32. So

```
accumulator traffic intensity = 2·M·N·K / (2·M·N·4) = K/4 FLOP per accumulator byte
```

Independent of M and N. The only lever is K — the instruction's own reduction depth. A Hopper `wgmma` with K=16 gives 4 FLOP per accumulator byte. Now walk the tcgen05 kinds, using the per-kind throughput multipliers from CUTLASS's Blackwell functionality docs (`tf32`/`f16`/`i8`/`f8f6f4` at 2x Hopper, `mxf4` and `mxf4nvf4` at 4x Hopper's FP8 rate) and each kind's MMA-K:

| kind | math rate | MMA-K | FLOP/accum byte | accum bandwidth needed |
|---|---|---|---|---|
| Hopper `wgmma` f16 | 1x | 16 | 4 | 1.00x |
| `tcgen05` f16 | 2x | 16 | 4 | **2.00x** |
| `tcgen05` f8f6f4 | 4x | 32 | 8 | **2.00x** |
| `tcgen05` mxf4 | 8x | 64 | 16 | **2.00x** |

Every kind converges on exactly 2x Hopper's per-SM accumulator bandwidth. That is not a coincidence — it is the design constraint. Narrow precision buys math throughput, and MMA-K grows in lockstep to keep accumulator traffic per FLOP from exploding. What remains after that cancellation is a flat 2x, and 2x is what has to be fed.

Now look at where the accumulator used to live. An SM has 65,536 32-bit registers — 256 KiB. A 128×256 fp32 accumulator tile is 131,072 bytes: **exactly half the register file**, before A-fragments, descriptors, predicates, or a single epilogue temporary. Push to 256×256 and it does not fit at all. The register file was not going to supply 2x the bandwidth for a structure already consuming half of it while also serving as the only scratch space for the epilogue.

Tensor Memory is the answer, and its capacity is not an accident either: 512 columns × 128 lanes × 32 bits = 262,144 bytes = **256 KiB per CTA**, the same size as the register file. Blackwell did not enlarge the accumulator budget. It gave accumulators their own tier with its own port, and handed the register file back to the epilogue.

## What TMEM actually is

Not a cache, not a scratchpad you can index freely. A 2-D array, addressed by a 32-bit value where bits 31:16 are the lane index and bits 15:0 the column index. Allocation is dynamic but coarse:

```
// one warp performs the allocation; result lands in shared memory
tcgen05.alloc.cta_group::1.sync.aligned.shared::cta.b32 [dst_smem], nCols;
// ... use it ...
tcgen05.dealloc.cta_group::1.sync.aligned.b32 taddr, nCols;
tcgen05.relinquish_alloc_permit.cta_group::1.sync.aligned;
```

The unit of allocation is 32 columns, `nCols` must be a power of two, and it is bounded by [32, 512]. So the budget is a small integer partition problem, and the numbers get tight fast. A 128×256 fp32 accumulator is 256 columns — half of TMEM. Double-buffer it to overlap the epilogue with the next MMA and you are at 512: **the entire allocation**, with nothing left for the A operand, block scale factors, or sparsity metadata, all of which can also be TMEM-resident. This is the real reason CUTLASS's SM100 tile shape tables read like a hardware datasheet rather than a menu.

## The issue model

Because `tcgen05.mma` is single-threaded, the instruction takes descriptors rather than register fragments: a TMEM address for D, a shared-memory matrix descriptor for A (or a TMEM address), one for B, and an instruction descriptor encoding shapes and types. Completion is not tracked by the issuing thread — it is committed to an mbarrier:

```
// dense tf32, accumulator in TMEM at taddr0, A and B from SMEM descriptors
tcgen05.mma.cta_group::1.kind::tf32 [taddr0], adesc, bdesc, idesc, {m0, m1, m2, m3}, p;

// block-scaled mxf8f6f4: A from TMEM, per-block scale factors also in TMEM
tcgen05.mma.cta_group::1.kind::mxf8f6f4 [taddr2], [taddr1], bdesc, idesc,
                                        [tmem_scaleA], [tmem_scaleB], p;

tcgen05.commit.cta_group::1.mbarrier::arrive::one.b64 [mbarObj0];
loop:
mbarrier.try_wait.parity.b64 p, [mbarObj0], 0;
@!p bra loop;
```

That `{m0, m1, m2, m3}` operand is a `disable-output-lane` mask — a 128-bit predicate letting the instruction skip writing chosen lanes of D, which is how you handle ragged tiles without a separate cleanup kernel.

The structural consequence: a Blackwell GEMM is no longer "N warpgroups each doing math and its own epilogue." It becomes three asymmetric roles — a TMA producer staging tiles into SMEM, **one elected thread** issuing the entire MMA chain, and a consumer warpgroup draining TMEM. The math no longer occupies the warps. It occupies one instruction stream and a mailbox.

## The epilogue constraint everyone hits first

TMEM is not uniformly accessible. Reading it back is per-warp restricted: warp 0 can only access lanes 0–31, warp 1 lanes 32–63, warp 2 lanes 64–95, warp 3 lanes 96–127. Since the natural accumulator tile is 128 lanes tall, **draining one requires a full warpgroup by construction** — a single warp physically cannot see three quarters of its own result.

```
// each warp reads its own 32-lane slice; .x64 = 64 columns per instruction
tcgen05.ld.sync.aligned.32x32b.x64.b32 {r0, ..., r63}, [taddr];
tcgen05.wait::ld.sync.aligned;
```

So the warp specialization is not a performance choice bolted on by CUTLASS. It is dictated by the access rules: one thread must issue, and a warpgroup must consume.

Two more pieces round out the model. `cta_group::2` pairs peer CTAs whose `%cluster_ctarank` differs only in the last bit, letting a single MMA span two SMs — that is how M=256 tiles exist at all. And `tcgen05.cp` copies SMEM to TMEM with optional 4-bit→8-bit or 6-bit→8-bit decompression on the fly, so FP4 weights can be staged densely and expanded at the last hop.

## Where this lands in practice

At the CUTLASS level all of it collapses into a dispatch policy and a tile shape — `KernelTmaWarpSpecialized2SmSm100` with `MmaTileShape` drawn from the sanctioned 128x{64,128,192,256} / 256x{64,128,192,256} grid. The abstraction is good enough that most people will never write `tcgen05.alloc`.

But the tile-shape table is not arbitrary, and knowing why saves real time. When a configuration is rejected or an occupancy target is unreachable, the cause is usually the 512-column budget, not registers: your accumulator, its double buffer, your TMEM-resident A operand, and your scale factors are competing for a 16-slot partition in units of 32 columns. That is a different resource model from every GPU GEMM written in the last decade, and the old intuition — "spill less, use fewer registers" — now points at the wrong wall.

The deeper lesson is the K/4 identity. Accumulator traffic per FLOP is set entirely by the instruction's reduction depth, so any architecture that multiplies math throughput without deepening K must multiply accumulator bandwidth by the same factor. Blackwell deepened K, absorbed the residual 2x with a dedicated 256 KiB memory, and paid for it by making the accumulator an addressable, explicitly allocated, non-uniformly-visible resource. Single-thread MMA is what falls out the other end.
