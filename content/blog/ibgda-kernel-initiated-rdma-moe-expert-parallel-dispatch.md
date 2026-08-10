---
title: "Kernel-Initiated RDMA: Why Large-Scale MoE Decode Broke the CPU Proxy"
date: 2026-08-10
tags: [rdma, mixture-of-experts, gpu, distributed-systems, networking]
excerpt: "Every GPU that sends a network message has to get a work request into a NIC queue, and for years a CPU thread did that on the GPU's behalf. Large-scale expert parallelism broke that arrangement, but not for the reason usually given. The proxy round trip is only 2.3% of a decode layer's budget. This post derives the number that actually matters, checks DeepEP's published latency table against its own bandwidth column, and finds that one of the DeepSeek-V3 hardware paper's design justifications compares against a baseline that never occurs."
---

Every internode transfer from a GPU ends the same way: something must build a work queue entry, place it in a queue the NIC can read, and write a doorbell register to tell the NIC to go look. Intranode, over NVLink, an SM can just issue load/store instructions against peer memory and be done. Internode, there is a device in the way, and that device is programmed through a mailbox protocol.

For most of the history of GPU networking, a CPU thread did that programming. NVSHMEM's InfiniBand Reliable Connection transport (IBRC) runs a proxy thread: the kernel writes a work descriptor into a buffer in *host* memory, the proxy builds the WQE, updates the doorbell record, rings the NIC's doorbell, then polls a completion queue and signals the GPU. GPUDirect RDMA means the payload never touches the host — but the control plane does, every time.

InfiniBand GPUDirect Async, Kernel-Initiated (IBGDA) moves all of that onto the SM. The WQ and DBR buffers move into GPU memory; an SM builds the descriptor, updates the DBR, and writes the NIC's doorbell MMIO address itself. The CPU leaves the critical path.

The interesting question is *why this suddenly mattered*, and the usual answer — "it removes GPU–CPU latency" — turns out to be nearly irrelevant. The DeepSeek-V3 hardware co-design paper (ISCA '25) frames it that way too: IBGDA "eliminates the significant latency overhead associated with GPU-CPU communication." Check that against their own measurements.

## The latency budget says the round trip is noise

The paper derives an idealized decode budget for a 256-expert MoE with top-8 routing plus one shared expert, 32 tokens per device, hidden size ~7K, over 400 Gb/s CX7 NICs at 50 GB/s:

```
(1 B + 2 B) × 32 tokens × 9 experts × 7168 / 50 GB/s
```

Dispatch is FP8 (1 byte), combine is BF16 (2 bytes). I get 123.86 µs with the true V3 hidden size of 7168, and exactly the paper's 120.96 µs if you read "7K" as 7000 — so that is the number they used. Under dual micro-batch overlap the layer costs twice that, 241.92 µs; 61 layers gives 14.76 ms TPOT, ~67 tokens/s. Their GB200 NVL72 comparison at 900 GB/s reproduces exactly too: 6.72 µs per step, 0.820 ms, ~1220 tokens/s.

Now put a proxy round trip against that budget. The paper's own Table 5 measures CPU-side end-to-end latency for a 64 B transfer at 2.8 µs on InfiniBand within a leaf, 3.7 µs across leaves, 5.6 µs on RoCE. Two all-to-alls per layer:

```
2 × 2.8 µs = 5.6 µs  =  2.3% of the 241.92 µs layer budget
61 layers × 2 × 2.8 µs = 0.34 ms  on a 14.76 ms TPOT  =  2.3%
```

Even the RoCE number is 4.6%. If the CPU proxy's cost were one round trip per all-to-all, IBGDA would be a rounding error and nobody would have bothered. The round-trip framing is the wrong model.

## What actually breaks is message rate

The proxy is not one round trip. It is a *serialization point* for every operation the device issues, and it has a throughput ceiling. NVIDIA's own microbenchmarks on ConnectX-6 put IBRC's message rate at roughly **1.7 MOPS regardless of how many CTAs or QPs you throw at it** — the proxy loop is the limit. IBGDA on the same hardware climbs with CTA count, approaches the NIC's own 215 MOPS limit with eight CTAs, and lands near 180 MOPS.

That is a factor of ~100, and it matters because expert parallelism generates enormous numbers of *small* messages. Each dispatch is a scatter: every rank sends a distinct slice to every peer, so the per-peer payload shrinks linearly in EP size:

| EP size | tokens/rank | FP8 payload per peer |
|---|---|---|
| 8 | 128 | 896 KiB |
| 64 | 128 | 112 KiB |
| 256 | 128 | 28 KiB |
| 256 | 32 | **7 KiB** |

The last row is the paper's own compute-optimal operating point — 32 tokens per device, chosen to balance arithmetic intensity against communication latency. It lands at 7 KiB per peer, and that is precisely the regime where NVIDIA measures IBRC all-to-all latency swinging between 128 and 256 µs while IBGDA holds flat near 64 µs. Two independent sources converge on the same threshold: below ~8 KiB the proxy stops being a courier and becomes the bottleneck.

The aggregate rate demand makes it concrete. At EP=256 with 58 MoE layers and two all-to-alls each, a GPU issuing one message per peer per collective needs:

```
256 peers × 116 collectives / 0.020 s  =  1.48 M msg/s
```

against a 1.7 MOPS proxy ceiling — 87% of it, from a single GPU, at a modest 20 ms TPOT. There is no headroom left for anything else, and the ceiling is per-proxy, not per-QP. This, not the 2.8 µs round trip, is why kernel-initiated networking became mandatory rather than nice to have.

## Checking DeepEP's published table

DeepEP is the open-source EP communication library built on this. Its V1 low-latency kernels use pure RDMA with no NVLink forwarding step, and publish both latency and bandwidth for a decode configuration: 128 tokens/rank, hidden 7168, top-8, FP8 dispatch, BF16 combine, H800 + CX7.

Their bandwidth column is derivable from their latency column, which is a useful consistency check. Payload per rank is `tokens × topk × hidden × dtype_bytes`:

```python
tok, h, topk = 128, 7168, 8
for ep, (d_us, d_bw, c_us, c_bw) in table.items():
    mine_d = tok * topk * h * 1 / (d_us * 1e-6) / 1e9   # FP8
    mine_c = tok * topk * h * 2 / (c_us * 1e-6) / 1e9   # BF16
```

| EP | dispatch | published | mine | combine | published | mine |
|---|---|---|---|---|---|---|
| 8 | 77 µs | 98 GB/s | 95.3 | 114 µs | 127 GB/s | 128.8 |
| 32 | 155 µs | 48 GB/s | 47.4 | 273 µs | 53 GB/s | 53.8 |
| 128 | 192 µs | 39 GB/s | 38.2 | 369 µs | 39 GB/s | 39.8 |
| 256 | 194 µs | 39 GB/s | 37.8 | 360 µs | 40 GB/s | 40.8 |

Everything agrees within 1–3%, so the bandwidth figures are honest payload-over-wall-clock, not a derated theoretical number. Two things stand out. First, latency *flattens* between EP=128 and EP=256 (192→194 µs dispatch) — the kernels are bandwidth-bound by then, and adding peers costs nothing. Second, against the paper's stated 40 GB/s effective NIC bandwidth, combine at EP=256 needs 367 µs and measures 360 µs, i.e. **102% of the supposed bound**. That "effective" figure is conservative; the kernels run at the wire.

Getting there without stealing the GPU is the other half. V1 exposes `return_recv_hook=True`, which launches the transfer and hands back a callable — you run compute for micro-batch A, then invoke the hook to land micro-batch B, and the transfer occupies *no SMs* in between. That is only possible because the NIC was programmed from the device and needs nobody to babysit it. It matters because the SM tax is real: the paper reports up to 20 of the H800's 132 SMs allocated to communication during training, 15% of the GPU acting as a network card. DeepEP V2 has since replaced NVSHMEM with a header-only NCCL backend and cut training SM usage from 24 to 4–6, about 3.8% of the die.

## One justification that doesn't hold

While verifying, one adjacent claim did not survive. The paper motivates node-limited routing — capping each token to at most 4 nodes so IB traffic can be deduplicated and NVLink-forwarded — by saying that if a token's 8 experts "are distributed across all 8 nodes, the communication time over IB would be 8t."

That baseline essentially never occurs. With 256 experts spread 32-per-node across 8 nodes and unconstrained top-8 selection, the expected number of distinct nodes touched is:

```python
E_nodes = N * (1 - comb(E - E//N, K) / comb(E, K))   # 256, 8, 8 -> 5.295
```

5.295, not 8. The probability that all 8 experts land on 8 distinct nodes is 0.0027. So the `M≤4` cap buys about **1.32×** in expected IB traffic, not the 2× the comparison implies. The mechanism is real and the cap is still worth having — it converts a distribution with a bad tail into a hard bound, which is what you want when the slowest rank sets the collective's latency. But the headline ratio is a worst-case-versus-bound comparison, not an expected-case one. The tail control is the argument; the 8t figure is not.

The broader pattern here is worth keeping: as a collective scales out, its message *size* shrinks while its message *count* grows quadratically, and systems tuned for bandwidth quietly become systems limited by control-plane operation rate. The fix was to stop treating the NIC as a device the host owns.
