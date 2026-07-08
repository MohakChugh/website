---
title: "CXL 3.1 Memory Pooling: Disaggregated Memory and the End of Stranded DRAM"
date: 2026-07-08
tags: ["cxl", "memory-pooling", "disaggregated-memory", "datacenter-architecture", "hardware"]
excerpt: "How CXL 3.1 fabric-attached memory eliminates stranded DRAM across server fleets, enabling dynamic memory composition with sub-200ns additional latency through hardware-coherent interconnects."
---

# CXL 3.1 Memory Pooling: Disaggregated Memory and the End of Stranded DRAM

Modern datacenters waste 25–40% of provisioned DRAM. Servers are configured for peak memory demand, but most workloads exhibit diurnal or bursty memory patterns. The result: billions of dollars in stranded memory sitting idle across hyperscale fleets. Compute Express Link (CXL) 3.1, ratified in late 2024, introduces hardware-coherent memory pooling that fundamentally restructures how we think about memory allocation at the rack and pod level.

## The Stranded Memory Problem

Consider a fleet of 1000 servers, each provisioned with 512 GB of DDR5. At any given moment, average utilization across the fleet hovers around 60%. That's 200 TB of DRAM purchased but idle — roughly $10M in hardware cost producing zero value. Traditional solutions (memory overcommit, swap-to-NVMe, balloon drivers) trade correctness or latency for utilization. CXL offers a third path: make memory a pooled, composable resource at the hardware level.

## CXL Protocol Layers

CXL operates over the PCIe 5.0/6.0 physical layer but defines three sub-protocols:

| Protocol | Function | Use Case |
|----------|----------|----------|
| CXL.io | PCIe-equivalent I/O | Device discovery, config, DMA |
| CXL.cache | Device-to-host cache coherence | Accelerators caching host memory |
| CXL.mem | Host-to-device memory access | Expanding/pooling memory |

For memory pooling, **CXL.mem Type 3** devices are the critical building block. A Type 3 device exposes a region of memory (HDM — Host-managed Device Memory) that the host CPU can access with load/store semantics, coherently, without software intervention on the data path.

## CXL 3.1 Fabric Topology

CXL 3.1 extends beyond point-to-point links. It introduces:

1. **Multi-headed devices**: A single memory device accessible by multiple hosts simultaneously
2. **Fabric switches**: CXL switches that route memory transactions across a fabric
3. **Global Fabric Attached Memory (GFAM)**: Memory pools accessible by any host in the fabric
4. **Back-Invalidate (BI)**: Hardware protocol for maintaining coherence across multiple hosts sharing a memory region

The topology looks like this:

```
┌─────────┐  ┌─────────┐  ┌─────────┐
│  Host 0 │  │  Host 1 │  │  Host 2 │
└────┬────┘  └────┬────┘  └────┬────┘
     │            │            │
     └────────────┼────────────┘
                  │
          ┌───────┴───────┐
          │  CXL Switch   │
          └───────┬───────┘
                  │
     ┌────────────┼────────────┐
     │            │            │
┌────┴────┐ ┌────┴────┐ ┌────┴────┐
│ Pool 0  │ │ Pool 1  │ │ Pool 2  │
│ 2 TB    │ │ 2 TB    │ │ 2 TB    │
└─────────┘ └─────────┘ └─────────┘
```

Any host can be dynamically assigned capacity from any pool. The switch handles routing, and the BI protocol handles coherence when multiple hosts share regions.

## Latency Characteristics

The critical question: what does CXL add to memory access latency? Measured on production CXL 1.1/2.0 hardware (Samsung CMM-D, Micron CZ120):

- **Local DDR5**: ~80–100 ns
- **CXL-attached (direct)**: ~170–250 ns (add ~80–150 ns)
- **CXL-switched (1 hop)**: ~250–350 ns (add ~170–250 ns)

This 2–3× latency penalty sounds severe, but the NUMA analogy is instructive. Cross-socket NUMA accesses on a 2P server already cost 1.5–2× local latency. CXL pooled memory slots into the memory hierarchy as a "far NUMA" tier:

```
L1 (1ns) → L2 (4ns) → L3 (12ns) → Local DDR (90ns)
  → Remote NUMA (150ns) → CXL Direct (200ns) → CXL Switched (300ns)
```

For workloads with large working sets but moderate access frequency on the tail (databases, in-memory caches, ML feature stores), this tradeoff is favorable.

## Linux Kernel Integration

The Linux kernel (6.8+) treats CXL memory as a separate NUMA node with explicit tiering support. The key components:

```c
// CXL region creation exposes memory as a DAX device
// which can be onlined as a NUMA node
struct cxl_region {
    struct cxl_decoder *cxld;
    struct range        hpa_range;  // Host Physical Address range
    int                 interleave_ways;
    int                 interleave_granularity;
};
```

Memory tiering with CXL uses the kernel's **memory-tiering** framework (transparent page placement):

```bash
# Check CXL NUMA topology
$ numactl --hardware
available: 3 nodes (0-2)
node 0 cpus: 0-63
node 0 size: 512000 MB
node 1 cpus: 64-127
node 1 size: 512000 MB
node 2 cpus:            # <-- no CPUs: this is CXL-attached memory
node 2 size: 2048000 MB

# Memory tiering demotion path
$ cat /sys/devices/system/node/node0/memtier
1
$ cat /sys/devices/system/node/node2/memtier
2
```

The **Multi-Gen LRU** (MGLRU) page reclaim algorithm integrates with CXL tiering: cold pages on node 0/1 are demoted to node 2 (CXL) rather than evicted to swap. Hot pages on CXL are promoted back to local DRAM. This is fully transparent to applications.

## Dynamic Capacity Devices (DCD)

CXL 3.1 introduces **Dynamic Capacity Devices** — memory pool devices that can dynamically assign and reclaim capacity to hosts without requiring device reset or host reboot:

```
Host requests 64GB → Fabric Manager allocates from Pool
                   → DCD adds extent to host's HDM range
                   → Host onlines new memory pages
                   → Application can malloc() into it

Host releases 64GB → Fabric Manager reclaims extent
                   → DCD removes from host's HDM range
                   → Pages offlined and freed
```

This is elastic memory at the hardware level. A workload spike on Host 0 can borrow capacity from the pool (freed by Host 2 whose workload subsided), with the fabric manager orchestrating assignments in microseconds.

## Hardware Coherence vs Software Coherence

The BI (Back-Invalidate) protocol in CXL 3.1 enables multiple hosts to share the same physical memory region with hardware-maintained coherence. When Host 0 writes to a cacheline that Host 1 has cached, the CXL device issues a back-invalidate snoop to Host 1:

```
Host 0: STORE addr → CXL Device
CXL Device: BI snoop → Host 1 (if cacheline present)
Host 1: invalidate cacheline, ACK → CXL Device
CXL Device: complete STORE, ACK → Host 0
```

This is a fundamentally different model from RDMA-based shared memory (which requires explicit flush/invalidate at the software level). CXL shared memory behaves like coherent SMP memory — `std::atomic` operations work correctly across hosts without any annotation.

## Implications for System Design

**Database buffer pools**: Instead of each database instance managing its own buffer pool sized for peak, a shared CXL pool allows dynamic buffer pool expansion. PostgreSQL and MySQL prototype patches already demonstrate this — the buffer pool grows into CXL memory under pressure and releases capacity when idle.

**ML training**: Gradient accumulation buffers and optimizer state (which can be 4× model size in Adam) can overflow into CXL memory. Since these are accessed less frequently than activations, the latency penalty is masked by compute.

**In-memory caches**: A Memcached/Redis cluster can pool CXL memory to handle flash crowds without pre-provisioning for peak. Cold keys naturally tier to CXL via MGLRU demotion.

## The Economics

At hyperscale, CXL memory pooling targets 15–25% fleet memory reduction while maintaining the same effective capacity:

| Metric | Without CXL | With CXL Pooling |
|--------|-------------|-------------------|
| Provisioned per host | 512 GB | 256 GB local + pool access |
| Effective available | 512 GB | 256 GB + elastic pool (up to 2 TB) |
| Fleet utilization | 60% | 85%+ |
| Stranded memory | 40% | <15% |
| Cost per effective GB | $3.50 | $2.40 |

The CXL switch and pooling hardware add cost, but the savings from reduced total DRAM provisioning dominate at scale.

## Current State and What's Next

Samsung, Micron, and SK Hynix are shipping CXL 2.0 memory expanders today. CXL 3.1 pooling hardware enters production validation in 2025–2026. The software stack (Linux CXL subsystem, fabric managers, orchestrators) is maturing rapidly — Linux 6.10 added DCD support, and the CXL Consortium published the Fabric Manager API specification.

The trajectory is clear: memory becomes a first-class composable resource, allocated and released as dynamically as compute cores. For systems architects, the design implications cascade through every layer — from memory allocators that are topology-aware, to schedulers that co-locate workloads by memory affinity, to capacity planners who model memory as a shared elastic pool rather than a per-host fixed resource.
