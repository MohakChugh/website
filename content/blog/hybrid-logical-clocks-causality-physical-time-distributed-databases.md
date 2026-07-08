---
title: "Hybrid Logical Clocks: Bridging Physical Time and Causality in Distributed Databases"
date: 2026-07-09
tags: ["distributed-systems", "clocks", "causality", "databases", "consistency"]
excerpt: "How Hybrid Logical Clocks combine NTP-synchronized physical time with Lamport causality to provide globally meaningful timestamps without coordination, enabling snapshot isolation and serializable transactions across geo-distributed databases."
---

# Hybrid Logical Clocks: Bridging Physical Time and Causality in Distributed Databases

Every distributed database must answer a deceptively simple question: *in what order did things happen?* Physical clocks drift. Logical clocks have no relationship to wall time. Google solved this with atomic clocks and GPS receivers (TrueTime), but that requires custom hardware in every datacenter. Hybrid Logical Clocks (HLC), introduced by Kulkarni et al. in 2014, achieve something remarkable: they provide causally consistent, globally meaningful timestamps using nothing more than commodity NTP synchronization.

## The Ordering Problem

Consider two transactions in a geo-distributed database:

```
Node A (us-east): UPDATE accounts SET balance = 500 WHERE id = 42  -- T1
Node B (eu-west): SELECT balance FROM accounts WHERE id = 42       -- T2
```

If T1 causally precedes T2 (the user transferred money then checked their balance), the system must guarantee T2 sees T1's write. This requires a total ordering that respects causality.

**Lamport clocks** provide causal ordering but timestamps are arbitrary integers with no relationship to physical time. You cannot answer "give me all events from the last 5 minutes."

**Physical clocks** (NTP) provide wall-time meaning but violate causality. NTP guarantees clock skew within a bound ε (typically 10-250ms), but within that window, events can appear out of order.

**TrueTime** (Google Spanner) returns an interval `[earliest, latest]` and waits out the uncertainty. This guarantees if `TT.now().earliest > TT.after(commit_time)`, then the commit is visible. The cost: commit latency includes the uncertainty window (typically 7ms with atomic clocks).

## The HLC Construction

An HLC timestamp is a pair `(l, c)` where:
- `l` captures the maximum physical time known to the node
- `c` is a bounded logical counter that breaks ties when physical clocks collide

The algorithm operates on three events:

### Local or Send Event

```go
type HLC struct {
    l int64 // physical component
    c int64 // logical component
}

func (hlc *HLC) Now() HLC {
    pt := physicalTime() // wall clock
    if pt > hlc.l {
        hlc.l = pt
        hlc.c = 0
    } else {
        hlc.c++
    }
    return *hlc
}
```

### Receive Event

```go
func (hlc *HLC) Receive(msg HLC) HLC {
    pt := physicalTime()
    if pt > hlc.l && pt > msg.l {
        hlc.l = pt
        hlc.c = 0
    } else if hlc.l == msg.l {
        hlc.c = max(hlc.c, msg.c) + 1
    } else if msg.l > hlc.l {
        hlc.l = msg.l
        hlc.c = msg.c + 1
    } else {
        hlc.c++
    }
    return *hlc
}
```

### The Key Invariants

1. **Causality**: If event `e` happens-before event `f`, then `hlc(e) < hlc(f)` (comparing `l` first, then `c`)
2. **Boundedness**: `l - pt ≤ ε` at all times, where ε is the maximum clock skew
3. **Monotonicity**: A node's HLC never decreases
4. **Size**: The counter `c` is bounded by the number of events within an ε window, which in practice fits in 16-20 bits

The critical insight: because `l` always advances to the maximum of the local physical clock and any received timestamps, the logical component `c` only increments when physical time has not advanced. The moment the physical clock catches up (which it must, within ε), the counter resets to zero. This bounds `c` without any coordination.

## Encoding: 64-bit Timestamps

In practice, HLC timestamps pack into a single 64-bit integer:

```
|---- 48 bits (physical ms) ----|-- 16 bits (counter) --|
```

The 48-bit physical component gives ~8900 years of millisecond-precision wall time. The 16-bit counter allows 65,536 causally ordered events within the same millisecond on a single node. CockroachDB uses this exact encoding, with nanosecond physical time in the upper bits and a 32-bit logical counter in the lower 32 bits of a 128-bit timestamp:

```go
// CockroachDB's hlc.Timestamp
type Timestamp struct {
    WallTime int64  // nanoseconds since Unix epoch
    Logical  int32  // logical counter
}
```

## Why This Matters: Snapshot Isolation Without Coordination

The primary application of HLC is providing **multi-version concurrency control (MVCC) timestamps** for distributed snapshot isolation.

When a transaction starts at timestamp `T_start`:
1. It reads the latest version of each key with timestamp ≤ `T_start`
2. It writes all mutations with a commit timestamp `T_commit > T_start`
3. Conflict detection checks for writes in the interval `(T_start, T_commit]`

Because HLC timestamps are globally meaningful and causally consistent, this works across nodes without a centralized timestamp oracle. The error bound ε introduces a small uncertainty window where the database might need to wait or restart a transaction, but this is far cheaper than Spanner's approach because:

1. No specialized hardware required
2. The common case (no contention) requires zero waiting
3. Only conflicting transactions within the ε window pay a retry cost

## Clock Skew and the Uncertainty Window

HLC does not eliminate clock skew; it makes skew manageable. When a node reads a key, it must account for the possibility that a write committed on another node within the last ε milliseconds might not yet be visible. CockroachDB handles this with **read uncertainty intervals**:

```
Read at timestamp T on node N:
  - If a value exists with timestamp in (T, T + max_offset]:
    - If the writing node's timestamp is provably before T (via HLC causality): safe to read
    - Otherwise: restart the transaction at the observed timestamp
```

In practice, with well-configured NTP (clock skew < 50ms), transaction restarts due to uncertainty are rare, on the order of 0.01% of reads in typical workloads. Systems like YugabyteDB reduce this further by using a hybrid approach: a single-node timestamp oracle for single-region deployments (zero uncertainty), falling back to HLC-based uncertainty for geo-distributed reads.

## Comparison with Other Approaches

| Property | Lamport Clock | Vector Clock | TrueTime | HLC |
|----------|--------------|--------------|----------|-----|
| Captures causality | Yes | Yes | No* | Yes |
| Wall-time meaning | No | No | Yes | Yes |
| Space complexity | O(1) | O(n) | O(1) | O(1) |
| Special hardware | No | No | Yes | No |
| Wait-free | Yes | Yes | No | Yes |

*TrueTime captures causality indirectly through its wait protocol

## Real-World Implementations

**CockroachDB** uses HLC as the backbone of its serializable isolation. Every key-value pair is versioned with an HLC timestamp. The `max_offset` parameter (default 500ms) bounds the uncertainty window. Nodes that drift beyond this are removed from the cluster.

**YugabyteDB** uses HLC with a configurable `max_clock_skew_usec` (default 500ms). Their "safe time" concept ensures reads at a given HLC timestamp only proceed after enough physical time has elapsed to guarantee no future writes can appear below that timestamp.

**TiDB** takes a hybrid approach: a centralized Timestamp Oracle (TSO) provides monotonic timestamps for single-region deployments, with HLC used for cross-region follower reads where strict serializability can be relaxed to causal consistency.

**MongoDB** uses a variant called the Cluster Time: a `(timestamp, increment)` pair gossipped across the cluster. The `increment` plays the role of the logical counter, allowing causal ordering of operations across shards without waiting.

## Limitations and Open Problems

HLC inherits NTP's weaknesses. A node with a fast clock will advance the entire cluster's `l` component to its inflated value. While the counter `c` remains bounded, the physical component can jump forward, making previously valid MVCC snapshots appear stale. This is why CockroachDB ejects nodes exceeding `max_offset` and why all production deployments require NTP monitoring with alerting on skew > 100ms.

The 2024 refinement from Ailijiang et al. ("Dissecting the Performance of HLC in Geo-Distributed Databases") showed that under realistic WAN latencies, HLC-based systems achieve within 3% of the throughput of an idealized zero-skew system. The dominant cost is not the clock protocol itself but the read uncertainty restarts, which can be reduced through **commit-wait avoidance**: if a transaction's read set is entirely local, no uncertainty window applies.

## The Elegance

What makes HLC remarkable is its simplicity. Three cases in the send/receive logic. A bounded counter that resets naturally. No coordination protocol, no leader election, no hardware requirements. Yet it provides the two properties that matter most for distributed databases: causal ordering (correctness) and physical time meaning (usability). For systems that cannot justify atomic clocks in every rack, HLC remains the gold standard for globally meaningful, causally consistent timestamps.
