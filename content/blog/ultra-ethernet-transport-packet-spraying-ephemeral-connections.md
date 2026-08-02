---
title: "Ultra Ethernet Transport: Packet Spraying, Ephemeral Connections, and the End of Ordered Delivery"
date: 2026-08-02
tags: ["networking", "distributed-training", "transport-protocol", "rdma", "congestion-control"]
excerpt: "RoCEv2 forces AI collectives through a transport built on per-peer connection state and strictly ordered delivery, and both assumptions break at cluster scale. The Ultra Ethernet Consortium's 1.0 specification replaces them with connectionless ephemeral contexts and per-packet spraying across hundreds of paths. A balls-into-bins simulation shows why the ordering guarantee, not the wire speed, is what caps utilization at 25%."
---

The interconnect, not the accelerator, is the binding constraint on large training runs. A single all-reduce moves the full gradient tensor across the fabric, and every rank blocks until the slowest transfer lands. Collective completion time is therefore a function of the *worst* path in the network — exactly the metric conventional Ethernet load balancing is worst at optimizing.

The Ultra Ethernet Consortium's 1.0 specification, published under the Linux Foundation, attacks this directly. It "sets out to address the shortcomings of RoCEv2, specifically its semantics, transport layer, wire operations, implementation complexities, and scale limits." The current version is 1.0.3, dated July 16, 2026, running 573 pages. Two of its decisions invert assumptions RDMA transports have treated as load-bearing for two decades: connections are ephemeral, and packets are deliberately delivered out of order.

## Why ECMP Flow Hashing Fails Collectives

Standard Ethernet multipathing hashes each packet's 5-tuple to pick an egress port. All packets in a flow hash identically, so a flow follows one path and ordering is preserved for free. This works for the internet's traffic mix, where flows are numerous, small, and statistically independent.

Collective communication violates every one of those properties. Its flows are few, enormous, simultaneous, and synchronized. When two elephant flows hash to the same uplink they share its bandwidth while a parallel uplink sits idle — and because the collective waits for the slowest transfer, that collision penalty is not averaged away. It is the result.

This is the balls-into-bins max-load problem. I hashed *n* equal flows onto *n* equal-cost paths and measured the hottest path's load over 20,000 trials:

```python
import random

def sim(nflows, npaths, trials=20000):
    rng = random.Random(42)
    worst = 0.0
    for _ in range(trials):
        bins = [0] * npaths
        for _ in range(nflows):
            bins[rng.randrange(npaths)] += 1      # ECMP: whole flow, one path
        worst += max(bins)
    return worst / trials

for n in (8, 16, 32, 64):
    hottest = sim(n, n)
    print(f"{n:3d} flows / {n:3d} paths: hottest={hottest:.2f} "
          f"-> {hottest:.2f}x slower, util {100/hottest:.0f}%")
```

```
  8 flows /   8 paths: hottest=2.59 -> 2.59x slower, util 39%
 16 flows /  16 paths: hottest=3.08 -> 3.08x slower, util 33%
 32 flows /  32 paths: hottest=3.53 -> 3.53x slower, util 28%
 64 flows /  64 paths: hottest=3.96 -> 3.96x slower, util 25%
```

Note the trend's direction. Utilization gets *worse* as you add paths, because the expected maximum bin load grows as Θ(log n / log log n) while ideal load stays flat at one. More fabric does not fix a flow-hashing collision problem; it slowly deepens it.

Now change one thing — randomize per packet instead of per flow, holding bytes and path count identical:

```
per-packet spray, 64 flows x 1000 pkts over 64 paths:
    hottest=1075 (ideal 1000) -> 1.075x slower, util 93%
```

Same topology, same bytes, 25% utilization to 93%. The improvement is pure statistics: with a thousand times more balls, the hottest bin's relative deviation shrinks as roughly 1/√k. Fine-grained randomization concentrates the distribution around its mean, and it is that tail the collective waits on.

## Spraying Means Abandoning In-Order Delivery

The reason ECMP hashes flows rather than packets is not ignorance. Per-flow hashing delivers packets in order, and RoCEv2 requires that: it inherits InfiniBand's go-back-N semantics, where a sequence gap means loss and recovery discards everything after it. Feed a go-back-N receiver deliberately reordered packets and it collapses into permanent spurious retransmission.

So spraying is not a switch feature you enable. It is a transport redesign, and UET's Packet Delivery Sublayer (PDS) "adopts multipath packet transmission at its core," placing each packet on a pseudo-randomly chosen path via a header entropy value positioned "in the same packet location as the UDP source port," letting unmodified switches hash on it. A context round-robins among "a configurable and typically large number of entropies (e.g., 64-256)," reducing the share sent to any entropy whose feedback shows congestion. That range is a deliberate rejection of MPTCP-style per-path state, which "permits better loss detection per sub-flow but requires more state" and caps usable paths by window size.

Because a sequence gap no longer implies loss, PDS defines four delivery modes rather than one:

- **RUD** — reliable unordered delivery, the workhorse for bulk payload. Reordering is tolerated; duplicates are suppressed so each packet reaches the semantic layer exactly once.
- **ROD** — reliable ordered delivery, for MPI match ordering or `put-with-signal`.
- **RUDI** — reliable unordered delivery of idempotent operations. Connectionless, establishing no context at all, since idempotent operations need no duplicate suppression.
- **UUD** — unreliable unordered delivery, datagram semantics.

A message may mix modes: an MPI implementation "might use an ordered mode to ensure header ordering together with an unordered delivery mode for the payload." Ordering becomes a per-operation cost, not a transport-wide tax.

Loss detection is rebuilt to match. ACK extension headers carry a 64-bit selective-ACK bitmap (`pds.sack_bitmap`), accumulated with an OR so bitmaps need not be monotonic — a cleared bit explicitly "MUST NOT be interpreted that the corresponding PSN has not been received." Optional **packet trimming** closes the gap: a switch about to drop a trimmable packet instead truncates it to `MIN_TRIM_SIZE`, fixes the IP length and checksum so it stays a valid datagram, and remarks the DSCP to `DSCP_TRIMMED`. The receiver gets an immediate loss notification with the original headers instead of waiting on a timeout — necessary because spraying "complicates loss detection, as the simple arrival of a higher sequence number cannot be used to infer loss."

## Ephemeral Connections and the State Wall

The second inversion targets scale. UET aims to support "up to millions of endpoints (NIC ports) with the ability to address up to billions of processes," and identifies the blocker precisely:

> Achieving a scalable reliability solution requires that the state retained in the NIC be based on the number of simultaneously active (concurrent) communications — not the total number of endpoints in the application.

RoCEv2 gets this backwards. A queue pair is established by handshake and persists, so a rank talking to *N* peers holds *N* QPs whether or not they are active. On-chip memory is finite, so the connection table becomes the scale ceiling — and SRAM area is the real currency on an integrated NIC.

UET's answer is the **packet delivery context** (PDC), established on demand with no prior handshake and torn down when traffic stops: "dynamically established ephemeral connections." State scales with concurrency, not cluster size.

But a fresh context cannot reject a delayed duplicate from a previous incarnation of the same peer pair. The fix is a narrow exception — one value survives teardown:

> PDC connections are ephemeral with all state cleared on close except the last PSN used, which is saved for use in selecting a new starting PSN for unencrypted PDCs.

A new context's starting PSN must be random and "at least 2^16 distance from the last PSN used on that PDC" within a 32-bit space — one scalar per context rather than a full connection record, the minimum state that makes forgetting everything else safe.

## Congestion Control Without Per-Path State

Multipathing avoids collisions but cannot fix incast, where many senders converge on one receiver's last hop and no path selection helps. UET specifies two algorithms, both mandatory in all three profiles (AI Base, AI Full, HPC).

**NSCC** (network-signal-based congestion control), derived from the published SMaRTT-REPS and STrack algorithms, is sender-driven and window-based, maintaining a single `cwnd` across all sprayed paths — "in effect it tracks the available capacity in the network across the aggregate of paths." Its ACK clock is driven by a `Rcvd_Bytes` field reporting bytes that actually arrived, inherently robust to reordering. One telling detail: because that field is rounded to 256-byte units and ACKs themselves reorder, `inflight` can go transiently negative, so it must be signed.

ECN is set at dequeue, making it a *leading* single-bit signal; queueing delay, approximated as `RTT - base_RTT`, is *lagging* and multi-bit. Their cross product gives four states:

| ECN | Delay | Meaning | Action |
|---|---|---|---|
| clear | below target | uncongested | `proportional_increase()` |
| clear | at/above | draining | `fair_increase()` |
| set | below target | incipient | hold |
| set | at/above | congested | `multiplicative_decrease()` |

`fair_increase()` is additive, so all contexts seeing the same signal add the same absolute amount — a proportionally larger boost for smaller windows, converging toward fairness. `multiplicative_decrease()` scales `cwnd` by the measured queueing excess, draining to target in just over one RTT:

```
ccc.cwnd *= max(1 - gamma * (avg_delay - target_qdelay) / avg_delay, max_md_jump)
```

The ECN-set-but-low-delay quadrant deliberately does nothing. Since ECN may also feed load balancing, mild marking "is often a symptom of imperfect load balancing," and reacting would fight the path selector rather than the congestion. The complementary algorithm, **RCCC**, is receiver-driven and credit-based: it handles incast natively but "needs an additional mechanism to deal with core congestion."

## What This Actually Changes

Each inversion only works because the others are present. Spraying requires unordered delivery, which requires SACK bitmaps and trimming for loss detection. Ephemeral contexts require surrendering per-path congestion state, which requires one aggregate window robust to reordering. Pull any one out and the rest stop functioning.

That coupling is also the caveat. UET is a specification with silicon still arriving, and the 93% figure above is a statistical bound on load balancing, not an end-to-end benchmark — real deployments will be gated by switch trimming support, host-side bottlenecks the spec itself acknowledges (receiver memory, the accelerator-to-NIC PCIe link), and implementation maturity. What is no longer arguable is the diagnosis. In-order delivery was never free. On a synchronized collective it costs roughly three quarters of the fabric you paid for, and the bill grows with every path you add.

**References.** Ultra Ethernet Specification v1.0.3 (July 2026, CC BY-ND 4.0); Bonato et al., "SMaRTT-REPS"; Le et al., "STrack."
