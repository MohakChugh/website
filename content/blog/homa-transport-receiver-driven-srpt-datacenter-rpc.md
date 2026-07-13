---
title: "Homa: Why Datacenter RPC Doesn't Need TCP, Connections, or Packet Ordering"
date: 2026-07-13
tags: ["networking", "datacenter", "transport-protocol", "tail-latency", "linux-kernel"]
excerpt: "TCP was designed for the wide-area internet, yet it carries the overwhelming majority of datacenter RPC traffic, where its byte-stream abstraction, connection state, and loss-based recovery actively destroy tail latency. Homa is a message-based, connectionless transport that uses receiver-driven flow control and shortest-remaining-processing-time scheduling to cut 99th-percentile latency by an order of magnitude, and it is now being upstreamed into the Linux kernel."
---

Almost all datacenter communication is remote procedure calls: small request messages and small response messages, millions of them per second, between thousands of machines inside a single building. And almost all of it runs over TCP, a protocol designed in the early 1980s for a wide-area network of unreliable links and unknown topology. TCP's assumptions are wrong for the datacenter in nearly every dimension, and the price is paid where it hurts most: the tail. A service that fans a request out to 100 leaf nodes waits for the slowest of 100 responses, so the 99th-percentile latency of one RPC becomes the *median* latency of the aggregate. Homa, a transport protocol from John Ousterhout's group at Stanford, is a ground-up redesign for exactly this workload. Its Linux kernel implementation has been under active upstreaming review through 2024–2025, and the measured results are dramatic: 99th-percentile latency for short messages reduced by 7–83x versus TCP under load.

## Everything TCP Gets Wrong in the Datacenter

Start with the abstraction. TCP is a **byte stream**: it delivers an ordered sequence of bytes with no notion of message boundaries. But RPC is inherently message-oriented. Applications must frame their own messages on top of the stream, and the transport cannot reason about message sizes because it does not know they exist. This matters enormously, because message size is the single most useful piece of scheduling information available.

TCP is **connection-oriented**. Each connection holds socket state, congestion-control state, and buffers. A machine talking to thousands of peers needs thousands of connections, and the kernel memory and cache footprint becomes a bottleneck. Worse, connections force *ordering*: a single lost packet head-of-line blocks every subsequent byte on that connection, even bytes belonging to a completely unrelated later RPC that happens to be multiplexed onto the same connection.

TCP uses **fair-share, sender-driven congestion control**. When N flows share a link, TCP tries to give each 1/N of the bandwidth. This is the worst possible policy for latency. If a 10 MB background transfer and a 1 KB RPC share a link, fair sharing makes the tiny RPC wait behind half the elephant. Queueing theory has known the right answer for decades: to minimize average completion time, run **Shortest Remaining Processing Time (SRPT)** — always service the flow with the least work left. TCP cannot do this because it does not know message sizes and has no priority mechanism.

## Homa's Design

Homa discards all four assumptions. It is **message-based**, **connectionless**, **receiver-driven**, and it approximates **SRPT** using the priority queues that already exist in every modern datacenter switch.

### Connectionless and unordered

Homa exposes a request/response message API, not a stream. There is no connection setup, no per-peer state that must be maintained across RPCs, and no ordering guarantee between messages. Each RPC is independent, so a dropped packet in one message never blocks another. The transport is identified by a `(client-id, RPC-id)` tuple carried in each packet, so a single socket handles communication with any number of peers. This alone eliminates the connection-table scaling problem and the multiplexing head-of-line blocking.

```text
Application API (simplified):
  homa_send(sock, dest, request_buf, len)   -> rpc_id
  homa_recv(sock, response_buf, &len)        -> rpc_id     (server side)
  homa_reply(sock, rpc_id, response_buf, len)
```

### Receiver-driven flow control

This is the core idea. In TCP the *sender* decides when to transmit, guided by a congestion window it grows until it sees loss. Loss in a datacenter means a switch buffer overflowed — the sender has already caused the harm it is trying to detect. Homa inverts control. A sender may transmit a small **unscheduled** portion of a message immediately (typically one RTT's worth, so short messages finish in a single round trip with zero handshake). Everything beyond that is **scheduled**: the *receiver* issues explicit `GRANT` packets telling the sender it may now send bytes up to a given offset.

The receiver is the natural control point because it is the convergence point — every packet destined for a host funnels through its single downlink (the top-of-rack-to-host link), which is where datacenter congestion actually occurs. By granting only as fast as it can drain, the receiver keeps switch buffers nearly empty, and empty buffers mean low latency.

```text
Sender                                     Receiver
  |  DATA[0..RTTbytes]  (unscheduled)  ---->  |  buffers arrive, schedule sender
  |                                           |
  |  <---- GRANT(offset = RTTbytes + G)       |  "you may send up to here"
  |  DATA[RTTbytes .. RTTbytes+G] --------->   |
  |  <---- GRANT(offset = ...)                 |
```

### SRPT via switch priorities

The receiver knows the length of every incoming message (Homa puts it in the first packet). So it can implement SRPT directly: among all senders currently transmitting to it, grant most aggressively to the one with the fewest remaining bytes, and assign that message the highest hardware priority. Homa maps message "shortness" onto the 8 priority levels that commodity switches expose (the `PCP`/`DSCP` fields drive strict-priority egress queues). Short messages ride the high-priority queues and jump ahead of the bulk data sitting in low-priority queues. The result is a distributed approximation of SRPT with no central coordinator: each receiver independently prioritizes its own incoming traffic, and the switches enforce it in hardware.

Because Homa deliberately allows a controlled amount of buffer occupancy (a small number of senders "overcommitted" so the downlink never idles), it tolerates the packet drops that occasionally result, recovering per-packet rather than per-stream — there is no ordering to preserve, so a retransmitted packet slots straight back in.

## Why This Crushes Tail Latency

Consider the pathological case: a link shared by one 1 MB message and one 1 KB message.

- **TCP (fair share):** both get ~50% of bandwidth; the 1 KB RPC's completion time is dominated by waiting behind the elephant. Its latency is inflated by orders of magnitude.
- **Homa (SRPT):** the receiver grants the 1 KB message at top priority; it completes in ~1 RTT while the 1 MB transfer is briefly paused. The short message sees an almost idle network.

The measured effect from the Homa Linux paper (SIGCOMM 2021) is that under high load, short-message P99 latency is close to the hardware minimum, while TCP's P99 balloons because short messages are constantly stuck behind larger ones and in overfull switch buffers. Homa also sustains higher aggregate throughput because keeping buffers shallow avoids the loss-and-retransmit collapse TCP suffers under incast — the classic "many senders reply to one requester simultaneously" pattern that is endemic to fan-out RPC.

## The Practical Catch, and the Path Forward

Homa is not a drop-in replacement. It is a new IP protocol number, not layered on TCP, so it needs kernel support (or a userspace/DPDK stack) at both ends and priority-queue configuration on the switches. It offers no ordering and no stream semantics, so applications built around TCP sockets need a different, message-oriented API — though gRPC-over-Homa bindings exist precisely to bridge this. And its priority scheme assumes a relatively homogeneous datacenter fabric; it is not meant for the open internet, where TCP's conservatism is correct.

What makes Homa more than an academic curiosity is the upstreaming effort. A production-quality Linux kernel module (`net/homa`) has been developed and submitted for mainline review, exposing Homa through the standard socket family mechanism so that it can coexist with TCP on the same hosts. If it lands, datacenter operators get an in-kernel, message-based, SRPT transport without the deployment friction of a bespoke userspace stack.

The deeper lesson is architectural. TCP's byte-stream, connection, and fairness abstractions were the right engineering choices for the network it was built for. Inside a datacenter — known topology, tiny RTTs, message-shaped workloads, and switches with hardware priority queues — nearly every one of those choices inverts. Homa is what you get when you take the workload seriously and let the receiver, which sits at the true point of congestion and knows the sizes of the messages competing for its downlink, make the scheduling decisions. Latency is not something you recover after loss; it is something you never lose in the first place by keeping the queues empty.
