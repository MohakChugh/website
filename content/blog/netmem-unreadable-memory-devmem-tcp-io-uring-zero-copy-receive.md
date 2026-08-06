---
title: "Unreadable Memory: netmem, devmem TCP, and io_uring Zero-Copy Receive"
date: 2026-08-06
tags: [linux-kernel, networking, io-uring, zero-copy, performance]
excerpt: "Linux 6.12 and 6.15 shipped two features that look unrelated: TCP receive directly into GPU memory, and io_uring zero-copy receive into userspace pages. Both rest on one abstraction that inverts a thirty-year assumption in the network stack, that a packet buffer is a struct page the kernel can dereference. The consequence is a receive path where the payload is unreadable to the kernel that routes it, and header/data split stops being an optimization and becomes a correctness requirement."
---

The transmit side of Linux networking solved zero-copy years ago. `MSG_ZEROCOPY` pins user pages, hands the DMA addresses to the NIC, and reports completion through `MSG_ERRQUEUE`. It works because on transmit, userspace already knows where the data is.

Receive is harder, and the reason is scheduling. When a packet arrives, the NIC must already have posted a buffer to write it into, and at that moment nobody knows which socket the packet belongs to. The classic answer is that the driver posts kernel-owned buffers from a `page_pool`, the stack parses headers, finds the socket, and then `recvmsg()` copies the payload into the user's buffer. That copy is the entire cost. At 200 Gbps you are moving 25 GB/s of payload, and a copy touches it twice, so it generates 50 GB/s of DRAM traffic. On an 8-channel DDR5-4800 socket with a theoretical 307 GB/s and a realistic achievable ceiling nearer 200 GB/s, one direction of one NIC is consuming roughly a quarter of the memory system just to move bytes from one address to another.

Linux 6.12 shipped Device Memory TCP and Linux 6.15 shipped io_uring zero-copy receive. They target different consumers, but they are the same mechanism, and understanding the shared abstraction is more useful than understanding either feature.

## The abstraction: one bit of pointer tagging

For thirty years the network stack assumed a packet buffer is a `struct page`. `skb_frag_t` holds a page pointer. Drivers call `page_pool_alloc()`, get a page, and `dma_map` it. Everything from GRO to checksum offload fallback to `tcpdump` is written against that assumption.

You cannot receive into a GPU's HBM under that assumption, because there is no `struct page` for it. The dmabuf exported by the GPU driver is a set of DMA addresses that the CPU may have no mapping for at all.

The kernel's answer, from Mina Almasry, is deliberately cheap. From `include/net/netmem.h`:

```c
/*  We overload the LSB of the struct page pointer to indicate whether it's
 *  a page or net_iov.
 */
#define NET_IOV 0x01UL

typedef unsigned long __bitwise netmem_ref;

static inline bool netmem_is_net_iov(const netmem_ref netmem)
{
	return (__force unsigned long)netmem & NET_IOV;
}
```

`struct page` is at least 8-byte aligned, so the low bit of any page pointer is always zero and is free real estate. A `netmem_ref` is either a page pointer or a `net_iov` pointer with the LSB set. The `__bitwise` annotation makes `sparse` reject any code that treats a `netmem_ref` as a plain pointer without going through an accessor, which is how a change this invasive gets made across dozens of drivers without silent breakage.

The important accessor is the one that reports failure:

```c
static inline void *netmem_address(netmem_ref netmem)
{
	if (netmem_is_net_iov(netmem))
		return NULL;

	return __netmem_address(netmem);
}
```

This is the whole idea. `netmem_address()` returning NULL means *the CPU cannot dereference this buffer*. The kernel documentation calls such memory **unreadable netmem**, and the rule for drivers is that they must not assume netmem is readable or page-backed. A driver ported to netmem swaps `page_pool_alloc` for `page_pool_alloc_netmem`, `page_pool_get_dma_addr` for `page_pool_get_dma_addr_netmem`, `page_pool_put_page` for `page_pool_put_netmem`, and crucially stops doing its own recycling, because holding a `struct page` to recycle later is meaningless when there is no page. Pinning goes through `page_pool_ref_netmem()` instead.

The cost of the tag check is measurable and small. The cover letter's `page_pool` fast-path microbenchmark reports 8 cycles per element on the net-next baseline, 10 cycles in an early revision, and 9 cycles once tuned, against roughly 1 cycle of run-to-run noise. Call it one cycle for the branch, and note the author found the fast path returned to baseline with `CONFIG_DMA_SHARED_BUFFER` disabled.

## Why header/data split is load-bearing

Here is the consequence that makes this interesting as a design problem rather than a plumbing change.

The kernel still has to run TCP. It must parse the sequence number, update the receive window, handle retransmits, and reassemble out-of-order segments. It cannot do any of that if the packet is unreadable.

So the NIC must split each packet at the L4 boundary: headers into ordinary host memory the stack can parse, payload into unreadable memory it will only ever pass along as an `skb` frag. This is what `ethtool -G eth1 tcp-data-split on` enables, and it is why `PP_FLAG_ALLOW_UNREADABLE_NETMEM` is documented as settable *if and only if* tcp-data-split is on. Header/data split is not a throughput optimization here. It is the precondition that keeps TCP implementable.

Two more hardware requirements follow. **Flow steering** ensures only the flows you intend land on the queue bound to unreadable memory, and **RSS reconfiguration** pushes everything else away from it, because a stray flow arriving on that queue would produce payloads that no ordinary socket can read. Setup is explicitly out-of-band:

```sh
ethtool -G eth1 tcp-data-split on          # split at the L4 boundary
ethtool -X eth1 equal 1                    # steer normal traffic away
ethtool -N eth1 flow-type tcp6 ... action 1 # pin the target flow to queue 1
```

And the losses are real, not theoretical. The devmem documentation is blunt that loopback is not functional, software checksum calculation fails, and `tcpdump` and BPF cannot access devmem payloads. You have traded observability for bandwidth. Debugging a production issue on this path means you can see every header and none of the data.

## Two consumers, one mechanism

**Devmem TCP** binds a dmabuf to an RX queue over netlink and gets back a `dmabuf_id`. Received fragments are reported through `recvmsg()` with `MSG_SOCK_DEVMEM`, which is mandatory; omit it and the kernel returns `EFAULT` rather than silently handing you a pointer you cannot read. Each fragment arrives as a control message, either `SCM_DEVMEM_DMABUF` carrying a `struct dmabuf_cmsg` with `dmabuf_id`, `frag_offset`, `frag_size`, and `frag_token`, or `SCM_DEVMEM_LINEAR` when the NIC could not split at the header boundary and the data landed in host memory after all. Robust code must handle both. Buffers are pinned until returned:

```c
setsockopt(fd, SOL_SOCKET, SO_DEVMEM_DONTNEED, &token, sizeof(token));
```

with a cap of 128 tokens and 1024 outstanding frags, and the documentation warns that returning tokens late will exhaust the dmabuf and cause drops. There is no page cache to fall back on. Flow control is now your application's problem.

Because the binding lives on a netlink socket, closing that socket unbinds, so a crashed process cannot leave a queue permanently wired to a dead dmabuf.

**io_uring zcrx** targets the ordinary case where the destination is host memory but you still want the copy gone. You register an area and a refill ring:

```c
struct io_uring_zcrx_area_reg area = {
	.addr = (__u64)(unsigned long)area_ptr,   /* mmap'd MAP_ANONYMOUS */
	.len  = area_size,
	.flags = 0,
};
struct io_uring_zcrx_ifq_reg reg = {
	.if_idx      = if_nametoindex("eth0"),
	.if_rxq      = 1,          /* the queue the flow was steered to */
	.rq_entries  = 4096,
	.area_ptr    = (__u64)(unsigned long)&area,
	.region_ptr  = (__u64)(unsigned long)&region,
};
io_uring_register_ifq(ring, &reg);
```

The ring must be set up with `IORING_SETUP_SINGLE_ISSUER`, `IORING_SETUP_DEFER_TASKRUN`, and 32-byte CQEs, because each completion carries a trailing `struct io_uring_zcrx_cqe`. A multishot `IORING_OP_RECV_ZC` then produces completions whose payload location is recovered by masking an offset into the registered area:

```c
struct io_uring_zcrx_cqe *rcqe = (struct io_uring_zcrx_cqe *)(cqe + 1);
__u64 mask = (1ULL << IORING_ZCRX_AREA_SHIFT) - 1;
void *data = (char *)area_ptr + (rcqe->off & mask);
```

Recycling mirrors devmem's token return, but through a shared ring rather than a syscall. You write an entry tagged with `rq_area_token` and publish the tail:

```c
struct io_uring_zcrx_rqe *rqe = &rq.rqes[rq.rq_tail & mask];
rqe->off = (rcqe->off & ~IORING_ZCRX_AREA_MASK) | area.rq_area_token;
rqe->len = cqe->res;
IO_URING_WRITE_ONCE(*rq.ktail, ++rq.rq_tail);
```

Note the asymmetry with `TCP_ZEROCOPY_RECEIVE`, the older mechanism that mapped kernel pages into the process: zcrx has no alignment requirements and no `mmap`/`munmap` churn per batch, because the destination memory is registered once and reused. And unlike a DPDK-style bypass, the documentation is explicit that packet headers are still processed by the kernel TCP stack, so you keep the congestion control, the socket API, and the firewall.

## What it buys, and what to check first

The devmem cover letter reports 189 of 200 Gbps bidirectional, about 95% of line rate, with devmem TCP on receive and ordinary TCP on transmit, measured on cloud VMs with a NIC supporting header split, RSS, and flow steering. The framing to keep is that the win is not CPU cycles saved in `copy_to_user`, it is DRAM and PCIe bandwidth not consumed. For a GPU training job pulling checkpoints or activations off the network, the payload never enters host memory, so it never crosses the PCIe root complex twice.

Before reaching for either, check three things in order. Does your NIC actually do header/data split, since without it every packet arrives as `SCM_DEVMEM_LINEAR` and you have built complexity for nothing. Can you steer exactly the flows you want, because partial steering means silent correctness problems on the shared queue. And can you give up `tcpdump` on the data path, because you are choosing to make your payloads invisible to the kernel and to yourself.

The bandwidth saving is real and the API is well-shaped. The thing being traded away is that the kernel no longer knows what it is carrying.
