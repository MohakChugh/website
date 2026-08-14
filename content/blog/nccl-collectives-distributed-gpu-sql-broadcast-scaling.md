---
title: "Running TPC-H on NCCL: The Broadcast That Refuses to Scale"
date: 2026-08-14
tags: [gpu, databases, query-processing, distributed-systems, interconnects]
excerpt: "A distributed SQL engine built on the collective communication library used for ML training runs all 22 TPC-H queries at 1TB in 0.53 seconds on 40 H100s. The abstract leads with that. Their own breakdown figure leads somewhere else: 8 GPUs in one machine do it in 1.13 seconds, so 5x the hardware bought 2.13x. This post derives why, verifies the paper's shuffle-vs-broadcast crossover condition, finds a non-monotonicity in it the paper doesn't mention, and computes the cost-per-query that makes scaling out the worse deal."
---

The premise of "Terabyte-Scale Analytics in the Blink of an Eye" (Wu, Cui, Curino, Interlandi, Sen; arXiv:2506.09226v2, August 2025) is that the DB community spent twenty years learning to scale analytics across cheap commodity machines, and meanwhile the AI buildout quietly deployed a completely different kind of cluster: eight GPUs per node with 450 GB/s of NVLink between them, 640 GiB to 1.5 TiB of HBM per machine, eight 400 Gbit/s NICs per node. Nobody designed that for SQL. The question is what happens if you run SQL on it anyway.

The answer is 0.53 seconds for all 22 TPC-H queries at a 1 TB scale factor on 40 H100s, and 1.3 seconds at 3 TB. DuckDB on one of the same machines' CPUs takes 121 seconds at 1 TB. That is the headline, and it is real. The more useful content is in the breakdown figures, which say something the abstract does not.

## The exchange layer is NCCL, not a shuffle service

The engine is a distributed build of Tensor Query Processor: relational operators expressed entirely against PyTorch's tensor API, so a Spark Catalyst physical plan compiles down into a tensor program. The contribution here is bolting data exchange onto that program using NCCL (and RCCL on MI300X) as the transport, which means the SQL engine inherits the vendors' topology-aware ring algorithms, their NVLink/InfiniBand/Infinity Fabric backends, and their years of tuning for allreduce.

There is an obvious mismatch. NCCL's primitives assume every rank contributes an equal-size buffer, because that is what gradient synchronization looks like. Shuffle partitions are not equal-size, and in TPC-H they are wildly unequal. NCCL also has no AllToAll. So the shuffle is built by hand out of point-to-point sends inside a single group, which lets NCCL schedule all `N²` transfers together rather than serializing them:

```c
// Shuffle at rank i: N^2 transfers fused into one NCCL group.
ncclGroupStart();
for (int j = 0; j < N; ++j) {
  ncclSend(sendbuf[j], sendcount[j], type, j, comm, stream);
  ncclRecv(recvbuf[j], recvcount[j], type, j, comm, stream);
}
ncclGroupEnd();
```

`recvcount[j]` is the problem: rank `i` cannot size its receive buffers without knowing what everyone intends to send it. That is solved with a metadata exchange first — every GPU sends `N` integers describing its partition sizes, then allocates exactly, then does the real transfer into contiguous per-column tensors so the result needs no post-shuffle copy. Two round trips instead of one, but the second one lands in place.

Broadcast looks like it could use the same loop, and that is the trap. Written as `N−1` point-to-point sends from the owner, a broadcast pushes the same bytes across the machine boundary once per remote GPU — eight times, on an 8-GPU node. The collective does not:

```c
// Broadcast at rank i: every rank's data goes to every other rank.
ncclGroupStart();
for (int j = 0; j < N; ++j)
  ncclBroadcast(sendbuf, recvbuf[j], count, type, /*root=*/j, comm, stream);
ncclGroupEnd();
```

NCCL builds rings that span both intra- and inter-node links, so each byte crosses each network hop once and is pipelined through. The rings are most efficient exactly when the inter-node bandwidth `Bn` equals the intra-node bandwidth `Bg`, which is to say the ring algorithm papers over interconnect heterogeneity right up to the point where the slow link is the bottleneck.

## Two models with opposite signs

Ring broadcast takes `N−1` steps moving `S/N` bytes per hop, so:

```
Thpt_broadcast = N/(N-1) * min(Bn, Bg)        for V > 1
Thpt_shuffle   = V^2/(V-1) * Bn               for V > 1
```

where `V` is machines, `k = 8` GPUs each, `N = kV`. Read the `V` dependence. Broadcast throughput is *invariant in the number of machines* — adding a machine adds a hop to every ring and buys nothing. Shuffle throughput grows roughly linearly in `V`, because more machines means more NICs pushing a fixed total volume. At `V = 1` both fall back to `Bg` and there is no network at all.

Put the hardware in. Per GPU, the H100 cluster has `Bg = 450` GB/s of NVLink and `Bn = 50` GB/s of InfiniBand (one 400 Gbit/s NIC each). So broadcast across machines runs at `40/39 × 50 ≈ 51` GB/s no matter how many machines you buy, against `8/7 × 450 ≈ 514` GB/s inside one. A 10× cliff at the chassis boundary. On the Ethernet-only A100 cluster, one 50 Gbit/s NIC shared by eight GPUs gives `Bn ≈ 0.78` GB/s per GPU, a ~575× cliff, which is why those runs are 15.5 seconds instead of 0.53.

This inverts the CPU-cluster instinct. Broadcasting the small side of a join is the cheap move when your interconnect is uniform and your node count is modest. Here, broadcast is the operation that structurally cannot benefit from the cluster you just paid for.

## Verifying the crossover

The paper derives when broadcasting `R` beats shuffling both sides. I re-derived it to check. With `Tb = (N−1)|R|/(N·Bn)` and `Ts = (V−1)(|R|+|S|)/(V²·Bn)`, the condition `Tb < Ts` gives

```
|S|/|R| > (N-1)*V^2 / (N*(V-1)) - 1
```

and substituting `N = kV` so that `N − k = k(V−1)` turns the first term into `(N−1)V/(N−k)`, reproducing the paper's Equation 3 exactly. The model is internally consistent.

Evaluating it is more interesting than deriving it. At `k = 8`: `V = 2` gives a threshold of 2.75, `V = 3` gives 3.31, `V = 4` gives 4.17, `V = 5` gives 5.09. Shuffle gets more attractive as you scale out, as the paper says. But the `V = 1` case, which uses `Bg` instead of `Bn`, has threshold `N − 1 = 7`. So the sequence is 7, 2.75, 3.31, 4.17, 5.09 — the crossover is *not monotone*. Crossing the first machine boundary makes broadcast dramatically more attractive (7 → 2.75) because shuffle's throughput collapses from NVLink to network speed, and only then does the trend reverse. An optimizer that fits a smooth curve through `V ≥ 2` and extrapolates to a single machine will pick the wrong join strategy for exactly the configuration most people run.

## The number the abstract omits

Figure 11(c), H100 with InfiniBand at 1 TB, total time for all 22 queries as machines go 1 → 5: **1.13, 0.73, 0.59, 0.54, 0.53 seconds.** Five times the hardware for 2.13× the speed — 43% scaling efficiency.

Decompose it with the paper's own percentages. At `V = 5` it reports shuffle at 11.3% and broadcast at 38.7% of runtime. (Elsewhere in the same subsection it puts total exchange for that configuration at 55.1%, not 50.0%; the two statements disagree slightly and I could not reconcile them from the text.) Taking either, compute is 0.238–0.265 s, against 1.13 s of pure compute at `V = 1`. **Compute scales 4.3–4.75× on 5× the GPUs — 85% to 95% efficiency.** The tensorized operators are fine. The 43% comes almost entirely from broadcast, which by its own model was never going to improve, and which grows from 16.5% of runtime at `V = 2` to 38.7% at `V = 5` purely by refusing to shrink.

At list price this is decisive. One H100 VM is $98.32/hr, so the `V = 1` run costs $0.031 of compute; five VMs at $491.60/hr for 0.53 s costs $0.072. **Scaling out makes each full TPC-H pass 2.3× more expensive.** You do it because 3 TB does not fit in 8 GPUs' HBM, not because it is faster per dollar.

## What the result is measured on

Worth stating plainly, since the "blink of an eye" framing invites misreading. All headline numbers are warm: input columns already resident in HBM, each query pre-run twice. Cold, over PCIe Gen5 at an aggregate 440 GB/s, the single-machine 1 TB run goes from 1.13 s to **11.4 s** — a 10× penalty that a plan cache does not fix, though it is a worst case and real workloads re-touch columns. There is no spilling: if peak working set exceeds HBM, the query fails, which is why 3 TB requires four or more machines. And under JCC-H skew the shuffle time is set by the busiest *node* (the PXN optimization borrows a local peer's NIC, so skew is node-granular rather than GPU-granular), with memory imbalance killing queries outright at low machine counts.

So: an upper bound, honestly labeled as one, on a cluster whose economics were decided by transformer training. The transferable part is not the 0.53 seconds. It is that the ML computational model — SPMD via `mpirun`, one process per GPU, no coordinator, fault tolerance by re-execution — turns out to be a workable substrate for analytical SQL, and that once you adopt it, the operator whose cost model has no `V` in it becomes your ceiling.
