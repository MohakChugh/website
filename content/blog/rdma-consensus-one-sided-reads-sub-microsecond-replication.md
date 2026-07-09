---
title: "RDMA Consensus: One-Sided Reads and Sub-Microsecond Replication"
date: 2026-07-09
tags: ["rdma", "consensus", "distributed-systems", "paxos", "kernel-bypass"]
excerpt: "How DARE, Hermes, and Mu exploit one-sided RDMA verbs to achieve consensus in under 2 microseconds, eliminating CPU involvement on followers and redefining the latency floor for replicated state machines."
---

Traditional consensus protocols like Raft and Multi-Paxos assume a symmetric network model: every replica actively participates in the protocol by receiving messages, processing them, and sending responses. This assumption made sense in the era of kernel-mediated TCP/IP, where network latency dwarfed processing time. But with RDMA (Remote Direct Memory Access) delivering sub-microsecond network round-trips, the CPU processing at each replica has become the dominant bottleneck.

A new generation of consensus protocols exploits RDMA's one-sided verbs, operations that read from or write to remote memory without involving the remote CPU, to fundamentally restructure how agreement is reached in distributed systems.

## The RDMA Primitive Advantage

RDMA NICs (RNICs) expose three classes of operations:

```
Two-sided (traditional):  SEND/RECV  — both sides involve CPU
One-sided (asymmetric):   READ/WRITE — only initiator CPU involved
Atomic:                   CAS/FAA    — remote atomic without remote CPU
```

One-sided RDMA WRITE posts data directly into a pre-registered memory region on the remote machine. The remote CPU never executes a single instruction. This is not a minor optimization; it eliminates context switches, interrupt handling, protocol parsing, and application-level processing on the follower path.

On modern CX-7 InfiniBand hardware, a one-sided RDMA WRITE completes in roughly 0.6 microseconds end-to-end within a rack. Compare this to kernel TCP at ~20 microseconds or even DPDK-based userspace networking at ~2-5 microseconds.

## DARE: Consensus Without Remote CPU

DARE (Direct Access REplication), published at HPDC 2015, was the first protocol to build complete Paxos-style consensus using exclusively one-sided RDMA operations. The key insight: if the leader can write log entries directly into follower memory and verify they landed via RDMA READs, followers never need to "participate" in the normal-case protocol.

### The Log Structure

Each replica exposes a circular buffer in registered RDMA memory:

```c
struct dare_log {
    uint64_t tail;           // leader advances this
    uint64_t commit_index;   // leader publishes committed offset
    log_entry entries[LOG_SIZE];
};

struct log_entry {
    uint64_t term;
    uint64_t index;
    uint32_t data_len;
    uint8_t  data[MAX_ENTRY];
};
```

The leader holds RDMA WRITE permissions to all follower logs. On a new client request:

1. **Leader appends** the entry to its local log
2. **Leader issues parallel RDMA WRITEs** to all follower log buffers (writing both the entry and the updated tail)
3. **Leader waits for WRITE completions** from a majority of followers (the RNIC confirms the write landed in remote RAM)
4. **Leader updates commit_index** on all replicas via another RDMA WRITE

The followers do nothing. Their CPUs are free for serving reads or other work. The replication latency equals one RDMA WRITE round-trip (~0.6us) plus local queuing.

### The Leader Election Problem

The asymmetry of DARE creates a challenge: how do you elect a new leader when the current one fails, given that followers weren't actively tracking progress? DARE solves this with RDMA atomic Compare-and-Swap (CAS) operations on a shared "leader permission" word:

```c
// Candidate attempts to claim leadership
uint64_t expected = LEADER_NONE;
uint64_t desired  = my_node_id | (new_term << 32);
rdma_cas(permission_addr, expected, desired);
```

If the CAS succeeds, the new leader reads all follower logs (via one-sided RDMA READs) to reconstruct the latest state, then resumes normal operation.

## Hermes: Invalidation-Based Replication

Hermes (ASPLOS 2020) takes a different approach optimized for replicated key-value stores. Rather than replicating an ordered log, it provides per-key linearizability using an invalidate-then-validate protocol:

1. **Writer broadcasts invalidations** via RDMA WRITEs to all replicas, marking the key as INVALID with a new timestamp
2. **Writer applies the update locally** and broadcasts the new value
3. **Writer sends validations** that flip the state from INVALID to VALID

Reads at any replica proceed locally if the key state is VALID. If INVALID, the read stalls until validation arrives. This achieves sub-microsecond writes for the common case while guaranteeing linearizability without any global ordering.

The protocol's cleverness lies in handling concurrent writers: timestamp comparison using Lamport clocks determines which write "wins," and RDMA CAS operations resolve conflicts without distributed locks.

## Mu: Microsecond Consensus at Scale

Mu (SOSP 2023) advances the state of the art by addressing DARE's two limitations: (1) leader bottleneck at high throughput, and (2) scalability beyond a single RDMA-connected rack.

Mu separates **sequencing** from **replication**:

```
Client Request
     │
     ▼
┌─────────────┐     RDMA WRITE      ┌──────────────┐
│  Sequencer  │ ──────────────────►  │   Replica 1  │
│  (assigns   │ ──────────────────►  │   Replica 2  │
│   sequence  │ ──────────────────►  │   Replica 3  │
│   numbers)  │                      │   ...        │
└─────────────┘                      └──────────────┘
     │                                      │
     │◄──── RDMA READ (confirm) ────────────┘
     ▼
  Commit ACK to client
```

The sequencer assigns monotonically increasing sequence numbers but delegates the actual data broadcast. Replicas receive writes into per-sequence-number slots in their RDMA-registered buffers. The sequencer confirms replication by reading back slot metadata via one-sided RDMA READs.

Mu achieves **1.4 microsecond** median commit latency and **5.6 million operations per second** with 5 replicas, all while maintaining linearizability.

### Handling Multi-Rack Deployments

For cross-rack communication where RDMA latency increases to ~2-4 microseconds, Mu introduces **relay nodes** that act as local RDMA proxies:

```
┌─────── Rack 1 ───────┐     ┌─────── Rack 2 ───────┐
│ Sequencer ──► Replica │     │ Relay ──► Replica     │
│            ──► Relay  │────►│       ──► Replica     │
└───────────────────────┘     └───────────────────────┘
```

The relay receives entries via RDMA WRITE from the sequencer and redistributes within its rack using local RDMA WRITEs, keeping the critical path to a single cross-rack hop plus one local hop.

## Failure Detection Without Heartbeats

A subtle challenge with one-sided RDMA consensus: traditional heartbeat-based failure detection requires the remote CPU to respond. If followers never process messages, how do you know they're alive?

Modern RDMA consensus protocols use three techniques:

1. **RNIC-level timeouts**: RDMA connections have transport-layer retransmission. If a WRITE fails to complete within a threshold (typically 8-64 retries at ~8us each), the RNIC reports a connection error.

2. **Lease-based leadership**: The leader periodically refreshes a lease timestamp in its own memory. Followers (when they do wake up for reads or other work) check the lease staleness.

3. **Dedicated failure detector threads**: A small background thread on each replica sends two-sided RDMA SEND/RECV pings. This thread consumes negligible CPU but provides positive liveness confirmation.

## When RDMA Consensus Makes Sense

RDMA consensus protocols excel in specific deployment scenarios:

**Good fit:**
- Replicated state machines within a datacenter (metadata services, lock managers, configuration stores)
- Latency-critical coordination (transaction commit protocols, leader election)
- High-throughput replication where follower CPU is a bottleneck

**Poor fit:**
- Wide-area replication (RDMA doesn't work over the internet)
- Deployments without RDMA hardware (though RoCEv2 over commodity Ethernet is increasingly common)
- Protocols requiring complex follower-side logic (conflict resolution, merge operations)

## The Broader Implications

RDMA consensus protocols reveal a deeper architectural principle: **when the network becomes faster than the CPU, push computation to the initiator and treat remote nodes as intelligent memory.** This principle is now influencing:

- **Disaggregated memory systems** (CXL memory pools where compute nodes access remote DRAM without involving remote CPUs)
- **Smart NIC offloads** (NetFPGAs that perform consensus operations entirely in hardware)
- **Persistent memory replication** (using RDMA to replicate directly to remote NVM, achieving durability and replication in one operation)

The sub-microsecond consensus floor established by these protocols isn't merely an academic curiosity. It's the foundation for a new class of distributed systems where replication overhead becomes negligible compared to application logic, enabling architectures that were previously impractical due to coordination costs.
