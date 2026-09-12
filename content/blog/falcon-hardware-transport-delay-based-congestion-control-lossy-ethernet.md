---
title: "Falcon: Moving the Transport State Machine into Hardware Without Making Ethernet Lossless"
date: 2026-09-13
tags: [networking, congestion-control, rdma, datacenter, hardware-offload]
excerpt: "RoCE bought hardware-speed RDMA by demanding a lossless fabric, and a decade of PFC storms, deadlocks, and head-of-line blocking followed. Falcon — Google's hardware transport, contributed to the Open Compute Project and first shipping in Intel's IPU E2000 — takes the opposite bet: keep Ethernet lossy, and move RTT measurement, Swift-style delay-based congestion control, per-flow pacing, and retransmission into the NIC. My 32-flow simulation of the core mechanism shows why the delay target matters: loss-based AIMD pins the bottleneck queue at the full 50µs buffer, while a Swift-style target holds it at 6µs average, 8.8µs p99 — an 8x cut from the congestion-control algorithm alone, before any hardware assist."
---

There are two ways to get reliable, microsecond-scale transport on a datacenter Ethernet fabric. The first is to make the fabric pretend to be lossless: RoCEv2 runs InfiniBand's transport logic over Ethernet and leans on Priority Flow Control (PFC) to guarantee that its simple go-back-N reliability logic almost never triggers. A decade of production experience has documented what that costs — PFC pause storms, cyclic buffer dependencies that deadlock the fabric, head-of-line blocking where one congested flow stalls every flow sharing its priority class, and victim flows several hops away from the actual congestion.

The second way is to accept that the fabric drops packets and build a transport that handles loss gracefully at hardware speed. That is [Falcon](https://cloud.google.com/blog/topics/systems/introducing-falcon-a-reliable-low-latency-hardware-transport), Google's hardware-assisted transport layer, [contributed to the Open Compute Project](https://cloud.google.com/blog/topics/systems/introducing-falcon-a-reliable-low-latency-hardware-transport) at the 2023 OCP Global Summit and first available in Intel's IPU E2000. It is the hardware distillation of a stack Google ran in software for years: Swift congestion control, Carousel traffic shaping, PLB load balancing, CSIG signaling, and PSP encryption, composed into one NIC-resident state machine.

I've written before about [Homa's receiver-driven grants](/blog/homa-transport-receiver-driven-srpt-datacenter-rpc) and [Ultra Ethernet's packet spraying](/blog/ultra-ethernet-transport-packet-spraying-ephemeral-connections) as answers to the same problem. Falcon is the third design point, and the most conservative: sender-driven, connection-oriented, delay-based — but with every latency-critical loop moved into silicon.

## Why the transport had to leave the kernel (and then leave the CPU)

The arithmetic is unforgiving. A 200 Gbps NIC moving 4 KiB messages must sustain roughly 6 million messages per second. A software transport spending even 500ns of CPU per packet on the datapath needs multiple dedicated cores just to keep up, and its congestion-control reaction time is bounded by scheduling jitter — tens of microseconds on a loaded host, which is longer than the entire fabric RTT it's supposed to be measuring. Google's own Snap/Pony Express work showed software transports topping out well below NIC line rate on small messages.

Hardware changes both constants. Falcon's design leans on three primitives the blog post calls out explicitly:

1. **Fine-grained hardware RTT measurement.** Timestamps are taken at the NIC, not in a kernel interrupt handler, so a delay signal is credible at single-microsecond granularity. This is what makes delay-based congestion control viable at all: Swift's whole premise is that RTT *is* the congestion signal, and a signal with 20µs of host-side noise cannot steer a 25µs fabric.
2. **Per-flow hardware-enforced traffic shaping.** This is Carousel's timing-wheel pacing moved into the NIC: every flow's packets are released on a schedule, so a congestion-control decision ("this flow may send at 40 Gbps") is enforced precisely rather than approximated by batching.
3. **Fast and accurate retransmission.** Selective retransmission in hardware, so a single drop costs one RTT for one packet — not a go-back-N replay of the window, and not a software interrupt.

On top of these, Falcon connections are **multipath-capable** and **PSP-encrypted** by default — path diversity to route around localized congestion (the PLB lineage), and line-rate encryption without a CPU tax.

## The part worth simulating: what the delay target buys

Strip away the offload machinery and Falcon's congestion philosophy is Swift's: hold end-to-end delay at a small target above the base RTT, decrease multiplicatively in proportion to overshoot. The contrast with loss-based AIMD is stark enough that it's worth quantifying, so I wrote a small fluid simulation: 32 flows sharing a 100 Gbps bottleneck, 4 KiB packets, 25µs base RTT, and a 2-BDP drop-tail buffer for the loss-based case.

```python
# Swift-style: RTT is the signal, decrease proportional to overshoot
if delay < TARGET_US:                # additive increase
    cwnd += 1.0
else:
    overshoot = (delay - TARGET_US) / delay
    cwnd = max(1.0, cwnd * (1 - BETA * overshoot))   # BETA = 0.8

# Loss-based AIMD: only a full buffer says anything
if dropped:
    cwnd = max(1.0, cwnd / 2)
else:
    cwnd += 1.0
```

With a 5µs queueing-delay target, the results over 4,000 RTTs (after warmup):

| Congestion control | avg queueing delay | p50 | p99 |
|---|---|---|---|
| Loss-based AIMD, 2-BDP buffer | 49.8µs | 50.0µs | 50.0µs |
| Swift-style delay target (5µs) | 6.2µs | 8.8µs | 8.8µs |

The loss-based numbers are the interesting ones: avg = p50 = p99 = exactly the buffer size. That's not a bug in the sim — it's the mechanism. Loss-based control gets no signal until the buffer is full, so with 32 flows additively increasing, the queue *lives* at capacity and every packet of every flow pays the full 50µs standing-queue tax, doubling the effective RTT of a 25µs fabric. The delay-based controller converges to its target and stays there: an **8x average, 6x p99 reduction in queueing delay from the algorithm alone**, with the link still saturated. Deeper buffers make loss-based strictly worse (the tax scales with the buffer), while the delay target is buffer-independent — which is why delay-based control is also what lets you build shallow-buffer, cheap-commodity-switch fabrics without drowning in drops.

This is the loop Falcon runs in hardware per connection, with hardware timestamps feeding it and hardware pacing enforcing its output. The offload doesn't change the steady state my simulation finds; it changes how fast you get there and how tight the target can be — a controller with microsecond-accurate signal and reaction can hold a 5µs target that a software controller with 20µs jitter simply cannot.

## Multi-protocol by construction: the ULP mapping layer

The second architectural decision is that Falcon is not an RDMA transport with other uses bolted on — it's a reliability/congestion substrate with **Upper Layer Protocols** mapped onto it. The contributed spec ships two mappings, InfiniBand Verbs RDMA and NVMe, with the layer explicitly designed for more.

Two features of that layer matter for anyone who has operated RDMA at scale:

- **Flexible ordering semantics.** IB Verbs' strict in-order guarantee is the enemy of multipathing: if packets must arrive in order, you can't spray them across paths without a reorder buffer, and one slow path head-of-line blocks the connection. Letting a ULP opt into relaxed ordering is what makes Falcon's multipath capability usable for RDMA traffic — the same insight that drives [UET's out-of-order delivery](/blog/ultra-ethernet-transport-packet-spraying-ephemeral-connections) and [IBGDA-style MoE dispatch](/blog/ibgda-kernel-initiated-rdma-moe-expert-parallel-dispatch), where the application genuinely doesn't care which token buffer lands first.
- **Graceful error handling.** In classic RoCE, errors tear down queue pairs and surface as application-visible connection failures; at warehouse scale, with millions of QPs, something is always failing. Treating error recovery as a first-class transport function rather than an exceptional path is a production-scars feature — the spec-level acknowledgment that at scale, the error path *is* a hot path.

## Where Falcon sits in the 2024–2026 transport landscape

Falcon and Ultra Ethernet are answers to the same indictment of RoCE, and Google explicitly framed the OCP contribution as complementary to UEC — the consortium's chair blurbed the announcement, and Intel (which builds Falcon into the E2000) is a UEC steering member planning to converge on the standards. The designs still differ where their heritages differ: Falcon is connection-oriented with long-lived hardware connection state and delay-based control, reflecting a decade of Swift in production; UET leans toward ephemeral connection state and packet spraying, reflecting a clean-slate AI/HPC focus. Homa, the academic third pole, abandons sender-driven control entirely.

The honest caveats: the public architectural sources are the OCP contribution and Google's announcement — Google has not published production performance numbers for the hardware implementation, so my simulation grounds the *algorithmic* claim (delay targets vs. loss), not a silicon benchmark. And Falcon's bet on per-connection hardware state has a known failure mode — NIC connection caches thrash at high connection counts, the very problem UET's ephemeral design targets. Which bet wins likely depends on whether your workload looks like storage (long-lived, moderate fan-out) or all-to-all AI training (massive fan-out, bursty).

The larger lesson generalizes past networking: when a control loop's reaction time must undercut the timescale of the thing it controls, the loop has to move down the stack. Congestion control chased its signal from the kernel (jitter ≫ RTT) into the NIC (jitter ≪ RTT). The same migration logic gave us [sched_ext for schedulers](/blog/sched-ext-bpf-pluggable-cpu-schedulers-linux) and [user interrupts for preemption](/blog/skyloft-user-interrupts-microsecond-preemptive-scheduling). Falcon is what it looks like when that argument is carried all the way to silicon — without repeating RoCE's mistake of making the network promise something it can't keep.
