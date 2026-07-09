---
title: "DPDK Kernel Bypass: Moving Network Packets at 100 Gbps Without the Operating System"
date: 2026-07-09
tags: ["dpdk", "kernel-bypass", "networking", "low-latency", "systems"]
excerpt: "How DPDK eliminates syscall overhead, interrupt storms, and kernel scheduling jitter to process 100+ million packets per second on commodity hardware, and why the kernel's networking stack becomes the bottleneck at scale."
---

# DPDK Kernel Bypass: Moving Network Packets at 100 Gbps Without the Operating System

At 100 Gbps line rate, a NIC must deliver roughly 148 million minimum-sized (64-byte) packets per second. The Linux kernel's networking stack — with its interrupt-driven model, socket buffer allocations, context switches, and protocol processing — introduces approximately 2–5 microseconds of per-packet latency. At 148 Mpps, that overhead makes full line-rate processing physically impossible in kernelspace. DPDK (Data Plane Development Kit) solves this by moving the entire packet I/O path into userspace, eliminating syscalls entirely.

## Why the Kernel is the Bottleneck

The traditional Linux networking path for a received packet involves:

1. **Hardware interrupt** → NIC signals the CPU
2. **Softirq scheduling** → kernel defers processing via NET_RX_SOFTIRQ
3. **SKB allocation** → `sk_buff` struct allocated per packet (cache-hostile, ~240 bytes of metadata)
4. **Protocol stack traversal** → L2/L3/L4 parsing, netfilter hooks, routing lookup
5. **Socket buffer copy** → data copied from kernel to userspace via `recvmsg()`
6. **Context switch** → scheduler resumes the application

Each step adds latency and jitter. NAPI (New API) polling amortizes interrupt costs but cannot eliminate the fundamental overhead of kernel memory management and the copy between address spaces. At 10 Gbps these costs are manageable; at 100 Gbps they consume the entire CPU budget.

## DPDK's Architecture

DPDK replaces this entire path with three core mechanisms:

### 1. UIO/VFIO Device Binding

DPDK unbinds the NIC from the kernel driver and rebinds it to either `igb_uio` or `vfio-pci`. The VFIO (Virtual Function I/O) driver maps the NIC's BAR (Base Address Register) regions directly into userspace virtual memory via IOMMU. The application can now read/write NIC registers and DMA descriptor rings without any syscall:

```c
// Simplified: NIC RX descriptor ring mapped into userspace
struct rte_mbuf *pkts_burst[MAX_PKT_BURST];
uint16_t nb_rx = rte_eth_rx_burst(port_id, queue_id, 
                                   pkts_burst, MAX_PKT_BURST);
// nb_rx packets are now in userspace — zero copies, zero syscalls
for (uint16_t i = 0; i < nb_rx; i++) {
    struct rte_ether_hdr *eth = rte_pktmbuf_mtod(pkts_burst[i], 
                                                  struct rte_ether_hdr *);
    // Direct pointer arithmetic on packet data in hugepage memory
    process_packet(eth, pkts_burst[i]->data_len);
}
```

### 2. Poll-Mode Drivers (PMDs)

Instead of interrupts, DPDK uses dedicated CPU cores that spin in a tight `while(1)` loop calling `rte_eth_rx_burst()`. This eliminates:

- Interrupt latency (1–3 μs per interrupt)
- Softirq scheduling delays
- Cache pollution from interrupt handlers running on the same core

The tradeoff is explicit: one or more CPU cores are dedicated entirely to packet processing and will show 100% utilization regardless of traffic load. This is acceptable in environments where latency matters more than CPU efficiency — high-frequency trading, 5G UPFs (User Plane Functions), and software-defined networking.

### 3. Hugepage-Backed Memory Pools

DPDK pre-allocates all packet buffers from hugepage-backed mempools at startup:

```c
struct rte_mempool *mbuf_pool = rte_pktmbuf_pool_create(
    "MBUF_POOL",
    NUM_MBUFS,        // e.g., 8192 buffers
    MBUF_CACHE_SIZE,  // per-core cache (typically 256)
    0,                // priv_size
    RTE_MBUF_DEFAULT_BUF_SIZE,
    rte_socket_id()   // NUMA-aware allocation
);
```

Hugepages (2 MB or 1 GB) eliminate TLB misses during DMA operations. The per-core cache layer avoids contention on the shared ring — each core has a local 256-buffer cache that refills from the lockless ring in bulk, amortizing the atomic operations.

## The Lockless Ring Buffer: `rte_ring`

DPDK's inter-core communication primitive is a fixed-size, multi-producer/multi-consumer lockless FIFO implemented with compare-and-swap:

```c
// Producer side (simplified CAS loop)
do {
    prod_head = ring->prod.head;
    prod_next = prod_head + n;
    success = __atomic_compare_exchange_n(&ring->prod.head,
                                           &prod_head, prod_next,
                                           0, __ATOMIC_ACQUIRE,
                                           __ATOMIC_RELAXED);
} while (!success);
// Write entries, then update prod.tail
```

This avoids mutex overhead entirely. The ring operates on cache-line-aligned slots, and the head/tail split (separate cache lines for producer and consumer metadata) prevents false sharing. Throughput: >100 million operations per second on modern hardware.

## Real-World Performance Numbers

Benchmarks on a dual-socket system with Intel E810 100GbE NICs (Ice Lake, 32 cores):

| Configuration | Throughput (Mpps) | Latency (p99) |
|---|---|---|
| Linux kernel (AF_PACKET) | ~2.1 | 45 μs |
| Linux kernel (XDP native) | ~24 | 8 μs |
| DPDK poll-mode (1 core) | ~35 | 1.2 μs |
| DPDK poll-mode (4 cores) | ~148 | 0.9 μs |

DPDK achieves line-rate (148 Mpps at 64B) with 4 cores. The kernel path maxes out around 2 Mpps per core. XDP (eXpress Data Path), which runs eBPF programs at the driver level, bridges the gap but still operates within the kernel's memory model.

## When NOT to Use DPDK

DPDK is not universally appropriate. The costs are real:

- **Dedicated cores**: Those CPUs cannot run other workloads. On a 16-core machine, dedicating 4 to DPDK leaves 12 for everything else.
- **No kernel protection**: A bug in your packet processing code can corrupt memory, crash the process, or cause security vulnerabilities. There's no MMU isolation between your code and the NIC's DMA buffers.
- **No standard socket API**: Applications must be rewritten. You cannot use `bind()`, `listen()`, `accept()`. TCP/IP stacks must be reimplemented in userspace (e.g., F-Stack, mTCP, Seastar).
- **Operational complexity**: Hugepage configuration, IOMMU setup, CPU isolation (`isolcpus`), NUMA pinning — all must be configured correctly.

## The XDP Middle Ground

Linux XDP provides a halfway point: eBPF programs attached at the driver's `ndo_xdp` hook can process packets before SKB allocation. XDP operates in kernel context but avoids most of the stack's overhead:

```c
SEC("xdp")
int xdp_filter(struct xdp_md *ctx) {
    void *data = (void *)(long)ctx->data;
    void *data_end = (void *)(long)ctx->data_end;
    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_DROP;
    if (eth->h_proto == htons(ETH_P_IP)) {
        // Fast-path: forward without full stack traversal
        return XDP_TX;  // Bounce back out same NIC
    }
    return XDP_PASS;  // Fall through to normal stack
}
```

XDP achieves ~24 Mpps per core (vs. DPDK's ~35 Mpps) but retains kernel safety guarantees, works with standard tooling, and doesn't require dedicated cores.

## DPDK in Production: Architecture Patterns

### Service Function Chaining (NFV)

Telecom network functions (firewalls, NATs, load balancers) chain DPDK-based VNFs using SR-IOV virtual functions or `virtio-user` interfaces. Each function processes packets at line rate, passing them via shared hugepage memory regions rather than kernel sockets.

### Run-to-Completion vs. Pipeline Model

**Run-to-completion**: Each core handles the full packet lifecycle (RX → parse → lookup → modify → TX). Maximizes cache locality. Used when processing per packet is uniform.

**Pipeline model**: Different cores handle different stages. Core 0 handles RX and classification, Core 1 handles crypto, Core 2 handles TX. Better when stages have vastly different computational costs (e.g., inline IPsec encryption).

### Flow Director and RSS

Modern NICs support hardware-level flow classification via RSS (Receive Side Scaling) or Flow Director. DPDK configures these via `rte_flow` APIs to distribute packets across RX queues by 5-tuple hash, ensuring each core processes a disjoint subset of flows without software synchronization:

```c
struct rte_flow_attr attr = { .ingress = 1 };
struct rte_flow_item pattern[] = {
    { .type = RTE_FLOW_ITEM_TYPE_IPV4 },
    { .type = RTE_FLOW_ITEM_TYPE_UDP,
      .spec = &(struct rte_flow_item_udp){ .hdr.dst_port = rte_cpu_to_be_16(4789) }},
    { .type = RTE_FLOW_ITEM_TYPE_END }
};
struct rte_flow_action actions[] = {
    { .type = RTE_FLOW_ACTION_TYPE_QUEUE,
      .conf = &(struct rte_flow_action_queue){ .index = 3 }},
    { .type = RTE_FLOW_ACTION_TYPE_END }
};
rte_flow_create(port_id, &attr, pattern, actions, &error);
```

## The Emerging Landscape: AF_XDP as DPDK Alternative

Linux 4.18 introduced AF_XDP — a raw socket type that uses XDP to deliver packets directly to userspace via a shared UMEM region, bypassing the kernel stack while retaining the standard socket lifecycle (`bind`, `poll`). AF_XDP achieves ~80% of DPDK's throughput with significantly less operational complexity, making it attractive for applications that need high performance but cannot justify the full DPDK deployment model.

The networking stack is evolving toward a spectrum: kernel sockets for compatibility, XDP for moderate acceleration, AF_XDP for high-performance userspace with kernel integration, and DPDK for absolute maximum throughput where no compromise is acceptable.
