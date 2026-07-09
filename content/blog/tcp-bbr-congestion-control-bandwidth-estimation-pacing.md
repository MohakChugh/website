---
title: "TCP BBR: How Google's Congestion Control Algorithm Replaced 30 Years of Loss-Based Assumptions"
date: 2026-07-09
tags: ["tcp", "congestion-control", "networking", "bbr", "bandwidth-estimation"]
excerpt: "Loss-based TCP congestion control conflates packet loss with congestion, destroying throughput on modern networks. BBR (Bottleneck Bandwidth and Round-trip propagation time) measures the actual network path to achieve near-optimal throughput, representing the most significant change to TCP in three decades."
---

For thirty years, TCP congestion control operated on a single assumption: packet loss means congestion. Algorithms like Reno, NewReno, and CUBIC halve their sending rate when they detect a lost packet. This worked when buffers were small and loss genuinely indicated a saturated link. On modern networks with deep buffers, loss-based algorithms either bloat queues to hundreds of milliseconds (bufferbloat) or underutilize expensive links by backing off prematurely. Google's BBR (Bottleneck Bandwidth and Round-trip propagation time) discards the loss signal entirely and instead directly measures two quantities: the maximum available bandwidth and the minimum round-trip time. The result is a congestion control algorithm that operates at the theoretical optimum, first deployed internally at Google in 2016, standardized in BBRv2/v3 (2022-2024), and now running across YouTube, Google Cloud, and the majority of Google's WAN traffic.

## The Fundamental Problem with Loss-Based Control

Consider a network path with a bottleneck link of 100 Mbps and a round-trip time of 50ms. The bandwidth-delay product (BDP) is:

```
BDP = 100 Mbps × 50ms = 625 KB
```

This means 625 KB of data can be "in flight" on the network simultaneously. The optimal operating point is sending exactly at the BDP, keeping the pipe full without queuing.

Loss-based algorithms like CUBIC probe for bandwidth by continuously increasing their congestion window until they observe loss. On a path with a 1 MB buffer at the bottleneck, CUBIC will fill the entire buffer before seeing loss, adding 80ms of queuing delay. The algorithm then halves its window, drains the queue, and repeats, oscillating between bufferbloat and underutilization.

```
CUBIC behavior on buffered link:
    ┌─── Buffer full (loss!) ──────────┐
    │                                    │
    │    ****                    ****    │
    │   *    *                  *    *   │  ← Queue oscillation
    │  *      *                *      *  │
    │ *        *              *        * │
    │*          *            *          *│
    └────────────**********─────────────┘
         Drain      Underutilized    Probe
```

The deeper the buffer, the worse the latency spikes. The shallower the buffer, the more throughput loss-based algorithms sacrifice by interpreting random loss as congestion.

## BBR's Model: Measuring the Path

BBR maintains a model of the network path using two independently measured parameters:

- **BtlBw** (Bottleneck Bandwidth): the maximum delivery rate observed over a sliding window (typically 10 round-trips)
- **RTprop** (Round-trip propagation time): the minimum RTT observed over a longer window (typically 10 seconds)

The product `BtlBw × RTprop` gives the BDP, the optimal amount of data in flight. BBR's pacing rate and congestion window are derived directly from these measurements:

```
pacing_rate = pacing_gain × BtlBw
cwnd = cwnd_gain × BtlBw × RTprop
```

The `pacing_gain` and `cwnd_gain` multipliers depend on which state BBR is currently in.

## The BBR State Machine

BBR cycles through four states:

### 1. Startup

BBR doubles its sending rate each round-trip (similar to slow start) until it detects that delivery rate has plateaued. Specifically, when the delivery rate grows by less than 25% over a round-trip, BBR concludes it has filled the pipe:

```c
// Simplified BBR startup exit condition
if (bw_sample < 1.25 * btl_bw) {
    filled_pipe = true;
    transition_to(DRAIN);
}
```

### 2. Drain

Startup overshoots by approximately `ln(2) × BDP` bytes queued in buffers. Drain uses an inverse pacing gain to quickly empty the queue:

```
Startup pacing_gain: 2.89 (= 2/ln(2))
Drain pacing_gain:   0.35 (= 1/2.89)
```

BBR exits Drain when inflight data drops to the estimated BDP.

### 3. ProbeBW

The steady-state phase. BBR cycles through pacing gains to maintain accurate BtlBw estimates while avoiding persistent queuing:

```
BBRv1 ProbeBW cycle: [1.25, 0.75, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]
                       ↑      ↑
                    Probe   Drain
                    for BW  queue
```

One round-trip at 1.25× probes for increased bandwidth. One round-trip at 0.75× drains any queue created. Six round-trips at 1.0× cruise at the estimated rate. This cycling ensures BBR detects bandwidth increases within 8 RTTs while keeping average queuing minimal.

### 4. ProbeRTT

Every 10 seconds, if BBR hasn't observed a new RTprop minimum, it enters ProbeRTT: reducing cwnd to 4 packets for 200ms to drain all queues and measure the true propagation delay.

## Pacing: The Critical Mechanism

Unlike CUBIC which sends bursts of packets, BBR spaces packets evenly using a pacing mechanism. If the target rate is 100 Mbps and packets are 1500 bytes:

```
inter-packet gap = 1500 bytes × 8 / 100 Mbps = 120 μs
```

Pacing prevents the micro-bursts that cause transient queuing even when average throughput is correct. Linux implements this via `fq` (Fair Queue) qdisc, which timestamps each packet with its scheduled departure time:

```c
// Linux kernel: net/sched/sch_fq.c
static void fq_flow_add_tail(struct fq_flow *flow, struct sk_buff *skb)
{
    skb->tstamp = max(skb->tstamp, flow->time_next_packet);
    flow->time_next_packet = skb->tstamp + 
        div64_ul((u64)skb->len * NSEC_PER_SEC, flow->pacing_rate);
}
```

## BBRv2 and v3: Fixing Fairness

BBRv1 had a significant flaw: it was unfair to loss-based flows. Because BBR ignores loss, when competing with CUBIC flows on a shared bottleneck, BBR would consume disproportionate bandwidth. BBRv2 (2019-2022) and BBRv3 (2023-2024) address this by incorporating loss as a secondary signal:

```
BBRv3 key changes:
1. Loss threshold (inflight_lo): if loss rate > 2%, reduce inflight target
2. ECN (Explicit Congestion Notification) responsiveness
3. Probe bandwidth more cautiously (slower ramp in ProbeBW_UP)
4. Improved fairness convergence time: ~100 RTTs → ~30 RTTs
```

BBRv3's `inflight_lo` acts as a learned ceiling. When loss exceeds 2% at a given inflight level, BBR remembers that level and avoids exceeding it in subsequent ProbeBW cycles:

```c
// BBRv3 loss response (simplified)
if (rs->lost > 0 && rs->tx_in_flight >= bbr->inflight_lo) {
    bbr->inflight_lo = max(bbr->inflight_lo * (1.0 - beta), BDP);
    // beta = 0.3 by default
}
```

This gives BBR "memory" of loss events without the sawtooth behavior of CUBIC.

## Deployment Results

Google published results from deploying BBR on their B4 WAN (connecting data centers globally) and YouTube:

| Metric | CUBIC → BBR improvement |
|--------|------------------------|
| YouTube rebuffer rate | -53% (desktop), -11% (mobile) |
| B4 WAN throughput | +2700% on lossy paths |
| RTT at bottleneck | Reduced from 100ms+ to ~10ms |
| Throughput on 1% loss path | 100× improvement |

The throughput improvement on lossy paths is the most dramatic. A path with 1% random loss limits CUBIC to approximately `1.22 × MSS / (RTT × √loss)`, which for a 100ms path yields ~1.5 Mbps regardless of actual link capacity. BBR, measuring actual delivery rate rather than reacting to loss, achieves near-link-rate on the same path.

## Enabling BBR on Linux

BBR has been in the Linux kernel since 4.9. Enabling it:

```bash
# Load the BBR module
modprobe tcp_bbr

# Set as default congestion control
sysctl -w net.ipv4.tcp_congestion_control=bbr

# Verify
sysctl net.ipv4.tcp_congestion_control
# → net.ipv4.tcp_congestion_control = bbr

# Use fq qdisc for pacing (critical for BBR performance)
tc qdisc replace dev eth0 root fq
```

For BBRv3 (Linux 6.x):

```bash
sysctl -w net.ipv4.tcp_congestion_control=bbr
sysctl -w net.ipv4.tcp_ecn=1  # Enable ECN for BBRv3 benefits
```

## When BBR Is Not the Answer

BBR assumes it can accurately measure BtlBw and RTprop. This breaks down in specific scenarios:

**Shallow buffers < 1 BDP**: BBR's ProbeBW phase intentionally sends at 1.25× estimated bandwidth. If the buffer holds less than 0.25 BDP, this causes loss every probe cycle. On short, low-latency paths within a datacenter, DCTCP (which uses ECN marking at very shallow thresholds) often outperforms BBR.

**Highly multiplexed short flows**: BBR's Startup phase takes ~log2(BDP/MSS) RTTs to fill the pipe. For flows lasting fewer than 10 packets on a datacenter fabric, the startup overhead dominates and simple initial-window strategies win.

**Policers and token buckets**: Many ISPs rate-limit using token bucket policers that drop packets when the bucket empties. BBR interprets the resulting loss as noise (below 2% threshold) and continues sending at the policer's burst rate, causing persistent loss. BBRv3's `inflight_lo` mechanism partially addresses this.

## The Paradigm Shift

BBR represents a fundamental philosophical change in congestion control. Loss-based algorithms treat the network as a black box and react to symptoms. BBR actively measures the path and operates at the computed optimum. This model-based approach, using delivery rate as the primary signal rather than loss, has proven that the decades-old assumption equating loss with congestion was never necessary. It was merely the simplest signal available when TCP was designed in 1988.

The trade-off is complexity: BBR requires accurate RTT measurement, delivery rate estimation, and careful state machine tuning. But on modern networks where deep buffers, wireless links, and long-fat pipes dominate, that complexity buys throughput and latency improvements that no amount of loss-based tuning can achieve.
