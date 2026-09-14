---
title: "LazyLog: Deferring Total Order to Read Time for 1-RTT Shared Log Appends"
date: 2026-09-14
tags: ["distributed-systems", "shared-logs", "linearizability", "low-latency", "storage"]
excerpt: "LazyLog (SOSP '24) observes that shared-log applications need linearizable total order at read time, not append time. By binding records to global positions lazily — after acknowledging appends but before reads arrive — its Erwin implementations cut append latency 3.8x versus Corfu and two orders of magnitude versus Scalog, while keeping reads on a fast path whenever readers lag writers by even one ordering interval."
---

# LazyLog: Deferring Total Order to Read Time for 1-RTT Shared Log Appends

Every multi-shard shared log — Corfu, Scalog, Delos-style systems — pays for its headline guarantee, a linearizable total order across shards, in the append path. Before an append is acknowledged, the record must be bound to a global log position, and that binding requires cross-shard coordination. Scalog batches records inside each shard, then has shards coordinate with a Paxos-based ordering layer to cut a global order; the paper reports 1–2 ms append latencies even at low throughput. Corfu goes the other way — a client fetches a position from a central sequencer, then runs a client-driven chain write across replicas — which costs 4 RTTs with three replicas.

LazyLog, from UIUC and VMware Research (SOSP '24, DOI [10.1145/3694715.3695983](https://doi.org/10.1145/3694715.3695983)), attacks the assumption underneath all of this: that the order must exist *before* the append returns. Its observation is that in most shared-log workloads — event sourcing, activity logging, message queues, high-availability journaling, log aggregation — linearizable order is consumed at **read** time, and readers are naturally decoupled in time from writers. A Samza-style journal is only read on failover. Analytics readers trail activity logs by design. So the abstraction changes by one word: records are bound to global positions *lazily*, in the background, with the only hard requirement being that the binding is finalized before that position can be read.

## Erwin-blackbox: append = write to f+1 memories

The authors build two systems on the abstraction. The first, Erwin-blackbox, works with unmodified storage shards (primary-backup replicas, or even off-the-shelf Kafka). The architecture splits the log into two physical regions:

```
append (critical path, 1 RTT):
  client ──parallel──▶ sequencing replicas (f+1, in-memory ring buffers)
                        ack after ALL replicas respond — no coordination

ordering (background):
  leader's log order ──▶ deterministic position-to-shard map ──▶ shards
  advance last-ordered-gp, then stable-gp; GC sequencing buffers

read:
  p ≤ stable-gp  → fast path, served from shard
  p > stable-gp  → slow path, wait for background ordering to catch up
```

The sequencing layer is coordination-free: clients write each record to all f+1 sequencing replicas in parallel, and each replica appends to a local in-memory log and responds immediately. One round trip, and the record is durable across f+1 memories — the same durability posture as other 1-RTT replicated systems that stage in memory and drain to disk later.

The subtle part is that the replicas' local logs can *disagree on order*, because there is no coordination. Why is that safe? A real-time argument: if `append(b)` starts after `append(a)` completed, then `a` was already present on **all** replica logs when `b` arrived, so every replica log places `a` before `b`. Only *concurrent* appends can appear in different orders across replicas — and linearizability lets the system order concurrent operations arbitrarily. So **any single replica's log is a valid linearization** of the unordered suffix. In normal operation, the leader's log defines the order; a background process assigns global positions from `last-ordered-gp + 1`, pushes records to shards via the deterministic map, and garbage-collects the ring buffers. In the implementation this ordering process runs on a separate machine and uses one-sided RDMA reads against the leader's ring buffer (and RDMA writes to bump GC head pointers), so ordering steals no CPU from the append path.

Failures are where lazy ordering usually gets scary, and the protocol is careful: a ZooKeeper-backed controller **seals** the current view (Delos/Boki-style) so no new append can commit — clients require acks from all replicas *in the same view*, so one sealed replica blocks commits. The controller then picks *any* surviving replica as the recovery replica and flushes its log to the shards starting at `last-ordered-gp + 1`. The real-time argument above is exactly what makes "any replica" correct: every survivor's log respects all real-time dependencies among acknowledged records. The invariant maintained throughout is that order up to `stable-gp` never changes — which is precisely what readers were promised.

## Erwin-st: sequence metadata, not data

Erwin-blackbox funnels record *bodies* through the sequencing layer, which is fine at ~100-byte records (≈1M appends/s) but flattens at 4 KB. Erwin-st splits each record into data and a `<record-id, shard-id>` metadata tuple. The client writes data directly to the shard replicas *in parallel* (Erwin-st modifies shards to accept uncoordinated writes, since ordering now comes from the metadata log) and, in the same RTT, writes the metadata to the sequencing replicas. The sequencing layer now moves only tuples — it sustains 1.34M metadata-appends/s — so throughput scales with shards like Corfu: 4 KB records across 10 shards reach ~700K appends/s at 29 µs append latency. The cost is a position-to-shard lookup on reads (clients batch-fetch and cache the mapping) and orphan scrubbing when a client dies between its data and metadata writes.

## What the evaluation actually shows

At matched throughput, Erwin-blackbox cuts append latency by up to 3.8× versus a from-scratch Corfu (which pays 4 RTTs) and by two orders of magnitude versus the open-source Scalog artifact — with the authors noting Scalog's shards in isolation perform nearly identically to theirs (693 µs vs. 772 µs), so the gap is eager ordering, not implementation quality. Layered over unmodified Kafka shards, Erwin-blackbox delivers a linearizable total order across three Kafka shards while *reducing* latency versus stand-alone (acks=all) Kafka by three orders of magnitude, because clients no longer wait on Kafka's internal replication in the critical path.

The honest question is read latency: lazy ordering doesn't delete the coordination cost, it moves it. With readers trailing writers by just 3 ms, Erwin's reads match Corfu's (all fast-path). With zero lag and low append rates, reads eat the full ordering cost — the debt comes due on the other side.

I wanted to know how sharp that cliff is, so I ran a small simulation: Poisson appends at 5–45K/s, background ordering flushing on a fixed tick `T = 200 µs`, readers trailing each record by lag `L`. The slow-path fraction came out **independent of append rate**: 100% at `L = 0`, ~50% at `L = 100 µs`, 0% at `L ≥ 200 µs`. Under a fixed tick, a record appended uniformly within an interval waits `T − x` for its flush, so the slow-path fraction is just `max(0, (T − L)/T)` — one ordering interval of reader lag is *sufficient*, at any rate. The rate-dependence in the paper's Figure 11 (worse reads at 5K than 45K appends/s) is therefore not fundamental to lazy ordering; it's because their background ordering is tuned for large batches, which the authors themselves note could be re-tuned for latency. The abstraction's real requirement is only: reader lag ≥ ordering pipeline depth.

## Trade-offs to carry away

Three limits matter before you reach for this. First, scalability: Erwin-st scales like Corfu (bounded by the sequencing layer's metadata rate), not like Scalog — Scalog's batched shard-to-orderer protocol is *fundamentally* what LazyLog removes from the critical path, so you can't have both. Second, appends don't learn their positions; writers that need `append → position` immediately need an eager `appendSync` escape hatch. Third, writing to *all* f+1 sequencing replicas makes the append path straggler-sensitive — one slow replica sets your tail latency, and the mitigation (supermajority quorums with more complex recovery) is left as future work.

The deeper lesson generalizes past shared logs: "linearizable" constrains *what readers may observe*, not *when the system must decide*. Any system that acknowledges writes before totally ordering them — as long as it can reconstruct a real-time-respecting order and gate reads on it — gets to move consensus off the critical path and pay for it during the natural silence between write and read. LazyLog is the cleanest statement of that idea I've seen.
