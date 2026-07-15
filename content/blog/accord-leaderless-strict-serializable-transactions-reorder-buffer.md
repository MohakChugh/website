---
title: "Accord: Leaderless Strict-Serializable Transactions in One Round Trip"
date: 2026-07-15
tags: [distributed-systems, consensus, databases, transactions, cassandra]
excerpt: "Every distributed transaction protocol you have used pays a latency tax: either a leader that funnels all writes through one node, or two round trips to order operations. Accord, the protocol behind Apache Cassandra's general-purpose transactions, delivers strict serializability with no leader and one wide-area round trip on the happy path. The trick is a reorder buffer that turns bounded clock skew into a consensus guarantee."
---

Distributed transactions force a choice that has felt unavoidable for a decade. You can run a leader-based protocol like Raft or Multi-Paxos, which orders everything through one node, so a client on the far side of the planet from the leader eats a cross-region round trip on every write, and the leader is a throughput bottleneck and a failure-recovery liability. Or you can run a leaderless protocol like EPaxos, where any replica can coordinate, but establishing the order of two conflicting operations costs a second round trip whenever they actually conflict. Google Spanner sidesteps some of this with tightly synchronized clocks and Paxos groups, but it still has per-shard leaders and commit-wait.

Accord, designed by Benedict Elliott Smith and Blake Eggleston and shipped as the engine behind Apache Cassandra's general-purpose transactions (CEP-15), refuses the trade-off. It is leaderless: any node can coordinate any transaction. And it commits in a single wide-area round trip on the fast path, while still guaranteeing **strict serializability**, the strongest correctness model, where the transaction order respects real time. This post is about the one idea that makes that possible: the reorder buffer.

## The problem with agreeing on order

Strict serializability means there is a single total order of transactions, and if transaction A finishes before B starts in real time, A comes before B in that order. Leaderless protocols assign each transaction a timestamp from a hybrid logical clock (physical time in the high bits, a logical counter and a globally unique node id in the low bits, so every timestamp is distinct and comparable). Execute transactions in timestamp order and you get serializability almost for free.

The catch is the word "almost." A coordinator picks a proposed timestamp `t0` and asks replicas to accept it. A replica can only accept `t0` if it has not already seen a *conflicting* transaction with a higher timestamp that it already promised to order first. If it has, it must reject `t0` and hand back a larger timestamp, forcing the coordinator into a second round of agreement, the slow path. This is exactly the EPaxos/Caesar behavior: conflicts cost a round trip. Under contention, the fast path rarely fires, and your "one round trip" protocol quietly becomes a two round trip protocol.

The reorder buffer attacks this directly. What if you could guarantee that the coordinator's proposed timestamp is always the largest any replica has seen for a conflicting transaction? Then the fast path always succeeds.

## The reorder buffer: buying order with a small delay

Here is the insight. Messages arrive at a replica out of order because of network jitter, not because timestamps are fundamentally unorderable. If two transactions were proposed at nearly the same physical time, whichever message happens to arrive first wins the ordering race, even though its timestamp might be lower. That race is the sole source of unnecessary fast-path rejections.

So Accord makes each replica **wait before processing a proposal**. The cluster continuously measures two quantities: the maximum clock skew between nodes, and the point-to-point network latencies. A replica holds an incoming timestamp proposal in a buffer for a duration equal to:

```
delay = max_clock_skew + max_point_to_point_latency - coordinator_to_this_replica_latency
```

and processes buffered proposals strictly in timestamp order. The subtraction matters: a proposal that already took a long time to arrive waits less, because the wall clock has already advanced. By the time a replica actually acts on a proposal with timestamp `t0`, it is guaranteed that no proposal with a timestamp lower than `t0` is still in flight toward it. Any conflicting transaction the replica has not yet seen must carry a *higher* timestamp. Therefore the replica can safely accept `t0`, and the fast path is guaranteed to succeed under normal operation.

This is a genuinely different bargain from Spanner's commit-wait. Spanner waits at commit to make timestamps safe against clock uncertainty. Accord waits at proposal to make *ordering* deterministic, which is what removes the second round trip. The delay is small (single-digit to low-tens of milliseconds, dominated by intra-region latency plus a skew budget), and it is overlapped with useful work, not added on top of a round trip.

## Dependencies without agreement

The second clever move is what Accord does *not* agree on. EPaxos and Caesar work hard to agree on a precise set of dependencies (which earlier conflicting transactions this one must execute after). Reaching consensus on that set is expensive.

Accord relaxes this. Each replica returns whatever conflicting transactions *it* happens to know about with a lower `t0`, and the coordinator unions them. Different replicas may report different dependency sets, and that is fine. The only invariant Accord maintains is:

> Any committed dependency set for a transaction at timestamp `t` is a superset of any set that could be committed at a lower timestamp.

That monotonicity is enough to guarantee correct execution order without paying for exact agreement. A neat consequence: commutative operations, most importantly reads, never need to depend on each other, so read-heavy workloads scale cleanly.

## Fast-path electorates: keeping quorums small

A fast-path quorum in a leaderless protocol has to be large. It must intersect every other fast-path quorum *and* every recovery (simple-majority) quorum, so that a recovery coordinator after a crash can reconstruct what was decided. Naively this pushes the fast-path quorum toward 3/4 of all replicas, which gets expensive as replication factor grows.

Accord introduces **fast-path electorates**: the set of replicas eligible to vote on the fast path can be a strict subset of all replicas. The rule is "for every two nodes removed from the electorate, one fewer vote is needed." Shrinking the electorate shrinks the quorum you must collect, so a wide-area deployment with a high replication factor still commits by talking to a small, nearby set of replicas. Under maximal failure the electorate can collapse to contain exactly one reachable simple-majority quorum, so Accord never sacrifices its failure tolerance to get the latency win, it degrades gracefully to the slow path.

## Putting the phases together

The full happy path, in pseudocode from the coordinator's perspective:

```python
def execute(txn):
    t0 = hlc.now()                      # unique, monotonic timestamp
    replies = send_preaccept(txn, t0,   # to a fast-path electorate quorum
                             electorate)

    if all(r.accepted for r in replies):
        deps = union(r.deps for r in replies)
        # FAST PATH: committed in one round trip
        send_commit(txn, t0, deps)
        return read_and_apply(txn, t0, deps)

    # SLOW PATH: someone saw a conflict
    t = max(r.timestamp for r in replies)   # highest witnessed, a valid Lamport value
    deps = union(r.deps for r in replies)
    accept_replies = send_accept(txn, t, deps,  # to a simple majority
                                 simple_majority)
    deps = union(r.deps for r in accept_replies)
    send_commit(txn, t, deps)
    return read_and_apply(txn, t, deps)
```

Execution issues reads to one replica per shard, waits for its dependencies with a lower timestamp to apply, combines the results, and disseminates the writes via an `Apply` message. Recovery, after a coordinator crash, contacts a simple quorum and picks up whichever is the furthest-along recorded step (Apply, Execute, Commit, or a slow-path Accept), then decides whether `t0` is still safe or a fresh `t` must be proposed. Because the slow path durably records the chosen timestamp, every recovery coordinator converges on the same decision.

## Why this matters

The headline number is latency: a globally distributed, multi-key, strictly-serializable transaction that commits in one round trip, from *any* node, with no leader to route around and no leader election to stall on during failures. For a database like Cassandra, whose entire identity is leaderless masterless availability, bolting on a leader-based transaction layer would have betrayed the architecture. Accord keeps the symmetry: every node is equal, writes go to the nearest quorum, and there is no special node whose failure triggers a availability gap.

The deeper lesson is the reorder buffer itself. It is a reminder that in distributed systems, a small, bounded, *deliberate* delay can be worth far more than the time it costs, if it converts a probabilistic race into a deterministic guarantee. Accord spends a few milliseconds of buffering to eliminate an entire cross-region round trip under contention. That is the kind of trade that only looks obvious in hindsight.
