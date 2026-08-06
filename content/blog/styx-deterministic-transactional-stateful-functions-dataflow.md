---
title: "Styx: Serializable Stateful Functions Without a Single Two-Phase Commit"
date: 2026-08-06
tags: [distributed-transactions, serverless, dataflow, deterministic-databases, serializability]
excerpt: "Every serializable stateful-FaaS runtime pays for 2PC: a coordinator log flush, a prepare round trip, and a rollback path. Styx (SIGMOD 2025) deletes all three by making the runtime deterministic, then bills the ack protocol in fractions instead of floats. I recomputed its runtime breakdown, simulated its two-phase commit split, and found the paper's stated reason for using fractions is provably wrong even though the decision is right."
---

Here is the number that should make you suspicious of your own stack. In Styx's runtime breakdown on YCSB-T, **95.6% of the median transaction latency is networking** and only 2.1% is state access. In Beldi, the same benchmark spends **60.9% of a 147ms median in state access alone**. Same workload, same 112 CPUs, same serializability guarantee. One system is bound by the speed of light between machines; the other is bound by round trips to a database it does not own.

That gap is the argument in "Styx: Transactional Stateful Functions on Streaming Dataflows" (Psarakis, Christodoulou, Siachamis, Fragkoulis, Katsifodimos, arXiv:2312.06893v4, SIGMOD 2025 / DOI 10.1145/3725363). The claim is an order of magnitude throughput improvement over prior serializable SFaaS systems, and the mechanism is not a faster 2PC. It is the removal of 2PC.

## The tax you are paying

Stateful Functions-as-a-Service means functions that own persistent state and call each other, forming a call graph the runtime does not know in advance. Give that end-to-end serializability and you land on two-phase commit almost by default. That is what Beldi and Boki do (over DynamoDB), and what T-Statefun does (coordinating 2PC inside a Flink cluster, shipping state out to stateless functions).

2PC costs you three things, and only the first is famous: a prepare round trip; a durable coordinator log flush on the critical path, since you cannot reply until the WAL is fsynced and replicated; and a rollback path, which means every function needs undo semantics and contention becomes aborts rather than waiting.

Table 2 shows what that last one does under pressure. Beldi and Boki use no-wait-die, and at their maximum sustainable throughput they abort **40 to 70% of transactions** as Zipfian contention rises — Beldi's committed rate collapses from 359 TPS to 179. Those aborts are not a tuning problem, they are the concurrency control working as designed.

## Determinism as the enabling trick

Deterministic databases (Calvin and descendants) sidestep 2PC by agreeing on a transaction *order* up front. If every partition knows the global sequence and executes it, no partition can independently decide to abort, so there is nothing to roll back and nothing to vote on. Styx's insight is that the natural home for such a protocol is a **streaming dataflow runtime**, because dataflow already gives you partitioned local state co-located with the operator that reads it, plus a replayable input log.

Sequencing is where the first cost normally hides. Calvin's partitioned sequencer does a deterministic round robin costing O(n²) messages. Styx borrows from Mencius and assigns transaction IDs with **zero inter-sequencer communication**:

```python
# Each sequencer independently mints globally unique, gap-free TIDs.
#   sid   : sequencer id (1..n_seq), assigned at registration
#   lc    : this sequencer's local counter
#   n_seq : total sequencers in the cluster
def next_tid(sid: int, lc: int, n_seq: int) -> int:
    return sid + lc * n_seq
```

The global sequence is the union of the partitioned ones, at O(1) coordination. But there is a subtle failure mode the paper is careful about: because lower TID means higher priority in the commit protocol, a *hot* sequencer advances its `lc` faster, so its transactions systematically get *worse* priority than those arriving at idle sequencers. Styx fixes this by having the coordinator broadcast `max(lc₁..lcₙ)` at each epoch boundary so every sequencer levels up. This is a one-line rebalance that exists purely to protect p99.

## The ack-share protocol, and why the paper's own justification is wrong

Deterministic protocols need the read/write set before committing. In SFaaS you cannot have it: the call graph is unknown until the functions run, and the functions are written by different teams. So Styx runs the epoch speculatively on a state snapshot to *discover* the RW sets — and now needs to know when a transaction is finished.

Naive acking fails because the root does not know how many acks to expect. Styx's answer is elegant: give the root an `ack_share` of 1, and have every function split its share equally among the calls it makes. Terminal calls return their shares upward. When the root's received shares sum to exactly 1, the whole call graph has completed.

The paper justifies using exact fractions over floats like this: with three calls each contributing 0.33, "the sum of all shares would not equal 1, but 0.99." **That specific argument does not hold.** It describes decimal rounding to two places, not IEEE-754. I checked:

```python
>>> 1/3 + 1/3 + 1/3 == 1.0
True
>>> sum([1/3, 1/3, 1/6, 1/6]) == 1.0   # the paper's own Figure 6 tree
True
```

Binary floating point happens to round thirds and sixths so the errors cancel. The paper's illustrative example is the case that *works*. But the design decision is still correct, and here is the honest reason. I exhaustively enumerated split trees (arities 2 through 7, depth ≤ 4), summing every terminal share in both `float` and `fractions.Fraction`:

```
exhaustive search over split trees (arities 2-7, depth<=4):
  total float-sum failures found: 367
  shallowest failing depth: 2
   depth 2 leaves ['1/7' x6, '1/49' x7] -> sum 0.9999999999999999
```

Fractions were exact in every tree; floats broke as early as depth 2, with sevenths. So the vulnerability is real and shallow — a function fanning out to 7 children, one of which fans out to 7, is enough. It just is not the arithmetic the paper describes. And an `== 1.0` completion test on floats fails as a **hung transaction that blocks the epoch**, far worse than an abort. `Fraction` costs a GCD per addition and buys unconditional correctness.

## Two commit phases, and how much work each really does

With RW sets known, Styx commits in two passes:

- **Phase 3, lock-free.** A transaction commits iff no other transaction in the epoch touched any of its keys. On conflict, lowest TID wins. Workers exchange local conflicts via the coordinator in `2·|W|` messages, so each worker can decide locally.
- **Phase 4, lock-based.** Losers acquire locks in TID order and re-run. If a re-run changes the RW set, it is rescheduled to the next epoch.

Phase 4 is the expensive one, so the split matters. The paper does not report it, so I simulated it with Styx's own defaults (10,000 keys, 1000 transactions per epoch, uniform debtor + Zipfian creditor, per §8.1):

```
  theta   phase-3 lock-free commit   phase-4 rerun share
  0.0       67.1%                     32.9%
  0.8       46.7%                     53.3%
  0.999     31.7%                     68.3%
```

The uniform case has a clean closed form. With 1000 transactions of 2 keys each, any given transaction faces 1998 competing key draws, so it survives phase 3 with probability `(1 − 1/10⁴)^1998` per key, squared:

```python
>>> ((1 - 1/10_000)**1998) ** 2   # ≈ e^-0.4
0.6705748285746242                # simulated: 0.671
```

Two consequences. First, **even at zero skew a third of the epoch falls through to the lock-based phase** — which is why the call-graph caching optimization (§6.3) is load-bearing rather than a nice-to-have. When call parameters and RW sets are unchanged, Styx re-invokes the whole graph concurrently instead of walking `F1→F2→F4→F6` sequentially, collapsing a chain of depth *d* into one round.

Second, the phase-3 hit rate is dominated by **epoch size**, not skew:

```
    epoch=  100  lock-free= 95.8%
    epoch= 1000  lock-free= 67.1%
    epoch= 2000  lock-free= 45.0%
```

Styx's default epoch is 1ms *or* 1000 transactions, whichever comes first. Under that default, the epoch-size knob is silently a contention knob: batching harder raises throughput and simultaneously pushes more work into the slower commit path. That tradeoff is not discussed in the paper and is the first thing I would instrument in a deployment.

## Early commit replies: the payoff

The real dividend of determinism is at the client boundary. A conventional system replies only after the commit is durable — snapshot persisted to blob storage, or WAL flushed and replicated. Styx replies **before persistence**.

The reasoning: after a crash, replaying the same input offsets through the same deterministic sequencer produces bit-identical state transitions. The reply was not a lie about durability; it was a claim that the input is durable and the computation is a pure function of it. Durability of the *log* substitutes for durability of the *state*.

That moves the fsync off the critical path entirely, and it is why the 95.6%-networking breakdown is possible at all: there is no storage round trip left to measure. Snapshots then piggyback on structure that already exists — Styx injects no Chandy-Lamport barriers, because **the end of a transaction epoch is already a consistent global cut**. Delta maps are written asynchronously and compacted in the background at O(N) per merge.

The catch, stated plainly: this holds only while the input queue replays in identical order, and only while every function is genuinely deterministic. Reading `time()`, calling an external API, or iterating a set with randomized hashing silently voids the recovery argument. Styx's fault tolerance is therefore not free — it is **paid for in a language-level restriction on user code**, enforced by convention rather than by the type system.

## What to take from this

The result generalizes past SFaaS. When Table 3 shows 60.9% of your latency in state access, the fix is architectural, not a faster client library: co-locate state with compute so access is a local hashmap hit and networking becomes the only real cost. And once execution is deterministic, durability stops being something you wait for and becomes something you derive — which is the single largest latency win in the entire paper, and it comes from a proof rather than a faster disk.

**Reported figures** are from arXiv:2312.06893v4 Tables 2–3 and §8.2. **The float/fraction analysis, the exhaustive split-tree search, the phase-3/phase-4 simulation, and the closed form** are my own; the epoch-size sensitivity result is not in the paper. Note also a small internal inconsistency: recomputing Table 3's Styx row gives 2.3%/95.6%/2.1% against the printed 2.2%/95.6%/2.2%, while the other three rows reproduce exactly.
