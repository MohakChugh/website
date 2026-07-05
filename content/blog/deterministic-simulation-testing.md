---
title: "Deterministic Simulation Testing: Finding Distributed Systems Bugs Before They Exist"
date: 2026-07-05
tags: [distributed-systems, testing, reliability, simulation, fault-injection]
excerpt: FoundationDB shipped a distributed database with essentially zero customer-reported bugs by running its entire cluster inside a single-threaded simulation driven by one random seed. TigerBeetle and Antithesis have since pushed the idea further. Here is how deterministic simulation testing works, why a seed is worth a thousand log files, and where the technique's real limits are.
---

## The bug you cannot reproduce

Every engineer who has operated a distributed system knows the shape of the worst bug class: a consistency violation that appears once a month in production, depends on a precise interleaving of packet arrivals, leader elections, and disk flushes across five machines, and vanishes the moment you attach a debugger. Jepsen-style black-box testing can *detect* these bugs, but detection is only half the battle. If you cannot replay the failure, you are debugging from tea leaves.

Deterministic Simulation Testing (DST) attacks the reproduction problem head-on. The idea, pioneered at FoundationDB around 2010 and now central to TigerBeetle's VOPR simulator and Antithesis's deterministic hypervisor (which came out of stealth in 2024), is this: **run the entire cluster — every node, every network hop, every disk — inside a single-threaded, single-process simulation whose only source of nondeterminism is one seeded PRNG.** Then fuzz that seed.

The payoff is brutal in its simplicity. When the simulator finds a violation, the entire failure — the exact packet drops, the exact crash timings, the exact interleaving across "machines" — is reproduced by re-running with the same 64-bit integer. A month-long production heisenbug becomes `./simulator --seed=0x9E3779B97F4A7C15`, replayable in seconds, forever.

## The architecture: swap the world, keep the code

DST is not model checking. You run your *real production code* — the actual consensus implementation, the actual storage engine — but you swap out every interface where nondeterminism leaks in:

1. **Concurrency.** No OS threads. All nodes run as cooperatively-scheduled tasks in one process, and the simulator decides who runs next. Every possible interleaving is reachable by some seed.
2. **Time.** No wall clock. The simulator owns a virtual clock and advances it in discrete ticks. A 30-second election timeout costs zero real time, which is how TigerBeetle runs simulated clusters at roughly 1000x wall-clock speed, continuously, on 1024 cores fuzzing different seeds.
3. **Network.** Messages go into a simulated network that can delay, reorder, duplicate, drop, or partition them — each decision a PRNG draw.
4. **Storage.** Disk I/O goes through a simulated disk that can tear writes, corrupt sectors, or lie about durability across a simulated power loss.

A minimal harness makes the structure obvious:

```rust
struct Simulator {
    prng: ChaCha8Rng,          // the ONLY entropy source, seeded once
    clock: u64,                // virtual time, in ticks
    nodes: Vec<Node>,          // real production code, simulated deps
    network: SimNetwork,       // in-flight messages, ordered by delivery tick
}

impl Simulator {
    fn tick(&mut self) {
        self.clock += 1;

        // Roll the dice: inject faults with configured probabilities.
        if self.prng.gen_bool(P_CRASH)   { self.crash_random_node(); }
        if self.prng.gen_bool(P_RESTART) { self.restart_random_node(); }
        if self.prng.gen_bool(P_PARTITION) { self.partition_random_link(); }

        // Deliver messages whose (randomized) delivery tick has arrived.
        for msg in self.network.due(self.clock) {
            self.nodes[msg.dst].receive(msg, &mut self.prng);
        }

        // Step each live node's state machine one unit of virtual time.
        for node in self.nodes.iter_mut().filter(|n| n.alive) {
            node.step(self.clock);
        }

        // The whole point: check invariants after EVERY tick.
        assert!(self.check_strict_serializability());
    }
}
```

Note what is absent: no `std::thread`, no `Instant::now()`, no real sockets. If any code path sneaks a call to the OS clock or an unseeded random number, determinism is broken and replay silently stops working. This is why DST is famously a *whole-architecture commitment* — FoundationDB's team built the simulation harness before the database, and TigerBeetle's style guide (static allocation, single-core control loop, explicit storage fault model) is largely a list of decisions that keep the code simulable.

## Safety is easy; liveness needed a trick

Asserting safety invariants (strict serializability, no committed data loss) after every tick is straightforward once you have the harness. Liveness bugs — livelocks, stuck view changes — are harder, and a 2023 TigerBeetle writeup explains why: naive random fault injection carries two hidden guarantees. Partitions eventually heal and crashed replicas eventually restart, because the same dice that broke things will unbreak them. Any bug that requires a *permanent* fault is invisible.

Their fix is a two-phase run. Phase one is standard fault chaos, which drives the cluster into some arbitrary reachable state. Then the simulator switches to **liveness mode**: it selects a quorum of replicas as the "core," heals all partitions among core members, restarts any downed core replica — and makes every fault touching non-core replicas *permanent*. It then asserts, under a timeout, that the core processes all remaining transactions.

This models exactly the scenarios operators fear, like a permanent asymmetric partition where one replica can send but never receive. That precise scenario had previously caused a view-change livelock in TigerBeetle that only a human had caught; after liveness mode landed, the simulator could find it — and its whole family — automatically.

## Antithesis: determinism without the rewrite

The obvious objection to DST is that it only works for systems designed for it from day one. Your existing service spawns threads, calls `gettimeofday`, reads `/dev/urandom`, and talks to Postgres. You are not rewriting all of that behind simulated interfaces.

Antithesis — founded by FoundationDB alumni, in stealth from 2018 until early 2024 — moves the determinism boundary from the application down to the machine. Instead of simulating dependencies inside your process, they built a **deterministic hypervisor**: a virtual machine in which every instruction, interrupt, and I/O completion is reproducible, implemented against low-level Intel virtualization features like extended page tables. Anything running inside — threads, kernels, whole multi-service Docker topologies — becomes replayable, because the *computer itself* has one timeline.

On top of that substrate they run autonomous fault-injecting exploration, and every bug found comes with perfect reproduction across all networked services. MongoDB uses it against the core server and WiredTiger; the Ethereum Foundation used it to test the Merge. The FoundationDB pedigree matters here: Wilson Snyder's crew claims the original simulator found essentially *all* of the database's bugs pre-release — famously, Kyle Kingsbury declined to Jepsen-test FoundationDB on the grounds that he did not expect to find anything.

## The honest limits

DST is not a free lunch, and it is worth being precise about the boundaries:

- **You find bugs in logic, not in the environment.** The simulator's network and disk are models. If your real NIC firmware reorders packets in a way your model cannot express, DST will not see it. FoundationDB still ran real-cluster tests alongside simulation for exactly this reason.
- **Coverage is probabilistic, not exhaustive.** Unlike TLA+-style model checking, fuzzing seeds gives no guarantee you explored the dangerous interleaving. The mitigation is raw volume — TigerBeetle's 24/7 fuzzing fleet — plus techniques like swarm testing that vary fault-probability profiles per run.
- **Determinism is fragile.** One stray `HashMap` iteration order, one `time.Now()` in a hot path, and replays diverge. Teams that succeed with DST enforce it with linting and CI checks that run every seed twice and diff the traces.
- **There is a theoretical ceiling.** Checking arbitrary temporal properties over an arbitrary program's state space is not even semi-decidable in general; Antithesis's own writing cheerfully notes some properties stay uncomputable even with a halting oracle. DST narrows the gap between "tested" and "correct"; it cannot close it.

## Why this matters now

The economics have flipped. In 2010, building a deterministic simulator before your product was a heroic bet. In 2026, the pattern is documented, TigerBeetle's simulator is open source and even playable in a browser at sim.tigerbeetle.com, and Antithesis sells the hypervisor variant as a service. Meanwhile, the second-order effect FoundationDB reported may be the real prize: with a simulator that catches interleaving bugs automatically, they deleted ZooKeeper, wrote a custom Paxos, and rebuilt their transaction subsystem — risky rewrites executed without fear, because the safety net was faster than any reviewer.

If you are starting a stateful distributed system today and your plan for concurrency bugs is "integration tests plus vigilance," you are choosing the 2010 difficulty setting on purpose. Write the simulator first.
