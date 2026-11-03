---
title: "LeaseGuard Audited: Raft Leases Where the Log Is the Lease, and a Limbo Region That's One Entry Short"
date: 2026-11-03
tags: [distributed-systems, raft, consensus, linearizability, leases]
excerpt: "LeaseGuard (SIGMOD 2026) gets zero-round-trip linearizable reads in Raft by treating the newest committed log entry as the lease, and adds two failover optimizations: deferred-commit writes and inherited-lease reads. I re-derived its numbers and read both reference implementations. The 55k ops/s write spike reproduces exactly from 10 ms chart buckets. The authors' own closed form predicts ~661 blocked reads for the LogCabin failover run, against the 70 reported, and I could not reconcile that 10× gap. The C++ limbo-region loop also stops one entry early: an exhaustive check finds stale reads in 12–22% of small configurations, where the paper's inclusive bound finds none."
---

# LeaseGuard Audited: The Log Is the Lease

A deposed Raft leader on the minority side of a partition doesn't know it has been deposed. If it keeps answering reads while the new leader commits writes, it breaks linearizability. Raft's standard fix is a **quorum check per read**, which costs one round trip and competes with replication for I/O.

**Leader leases** are the alternative, but folklore versions are vague and buggy. The LeaseGuard paper (Davis, Demirbas, Deng, SIGMOD 2026, arXiv:2512.15659) cites HashiCorp and etcd lease bugs that are still open. Classic leases also block a new leader until the old lease expires; TiDB's version causes a 10-second outage after each election.

LeaseGuard's idea: **the log is the lease.** Below I explain why that works, re-derive the paper's numbers, and report two bugs in the reference C++.

## Why Raft (and not Paxos) makes this easy

LeaseGuard relies on **Leader Completeness**: any entry committed in term *t* is in the log of every later-term leader. MultiPaxos lacks this, since a new leader may have to fetch entries. Each entry carries its creator's bounded-uncertainty clock reading, `intervalNow() = [earliest, latest]`, and the rules follow:

1. **Read rule.** A leader may serve a local read if its newest *committed* entry is less than Δ old. Leader Completeness means every future leader has that entry, so every future leader knows the lease exists.
2. **Commit rule.** A leader in term *t* may not advance `commitIndex` while it holds any entry from a term below *t* that is less than Δ old. That entry might be the deposed leader's lease.
3. **Age test under uncertainty.** Entry time `t1` counts as more than Δ old only if `t1.latest + Δ < now.earliest`.

No new messages and no election changes. Every committed write extends the lease, and a "faux leader" that can't write can't renew it.

```python
def client_read(self, k):
    if self.state != "leader":              return "not leader"
    if self.log[self.commit_index].age > DELTA: return "no lease"
    if self.term != self.log[self.commit_index].term:   # inherited lease
        if k in self.limbo_keys:            return "key affected by limbo region"
    return self.data[k]

def commit_entry(self, i):
    if not majority_acked(self.log[i]):     return
    if self.last_prior_term_entry.age < DELTA: return  # deferred commit
    self.commit_index = max(self.commit_index, i)
```

## The two failover optimizations

**Deferred-commit writes.** The new leader replicates writes immediately but doesn't commit or acknowledge them until the old lease expires. Then the whole durable backlog is acknowledged at once, with no extra round trip.

**Inherited-lease reads.** While the old leader L0's lease is live, the new leader L1 knows two things. First, no one can commit anything new, because L1's own commit rule blocks it and L0 lost its majority when L1 raised the term. Second, L1 holds every entry L0 committed. So L1 can serve reads too, except for one gap. L1 doesn't know where L0's `commitIndex` sits among the entries after L1's own `commitIndex`. That span is the **limbo region**. Reading at L1's `commitIndex` might return state older than what L0 already acknowledged. Applying the whole log might return writes L0 never committed. Both violate linearizability. So L1 rejects any read whose key was touched by a limbo entry.

The paper defines the region as entries after `commitIndex` "up to and including the last entry L had when it was elected." Hold on to "including."

## Reproducing the failover arithmetic

The availability simulation (Figure 7) issues one operation every 300 µs, one third of them writes. It uses ET = 500 ms and Δ = 1 s, crashes the leader at 500 ms, elects a new one at 1000 ms, and the old lease expires at 1500 ms. Deferred commit therefore buffers 500 ms × 1111 writes/s ≈ **556 writes** and acknowledges them together. The paper labels the spike "off chart, 55k ops/sec." I checked their `make_charts.py`, which resamples into **10 ms buckets**: 556 writes per 10 ms = 55.6k ops/s. It matches to the digit, and it shows the spike is a pure batch artifact, not real throughput.

(§5.2 recommends Δ = ET in production; the 2·ET runs stress-test the no-lease window.)

## Limbo-region availability: the paper's own formula vs. the paper's result

Suppose the limbo region holds *L* writes, and reads and writes both draw keys from the same Zipf(*a*) distribution over *N* keys. The fraction of reads blocked is then

```
blocked(a, L) = Σ_k  p_k · (1 − (1 − p_k)^L)
```

The authors' `skewness_experiment.py` computes exactly this expression, and my Monte Carlo agrees to 0.2 percentage points. Evaluating it at the paper's Figure 8 setting (L = 100, N = 1000, 3,333 attempted reads/s):

| Zipf a | hottest key | blocked | successful reads/s |
|---|---|---|---|
| 0 | 0.1% | 9.5% | 3016 |
| 0.5 | 1.6% | 15.6% | 2813 |
| 1.0 | 13.4% | 49.9% | 1669 |
| 2.0 | 60.8% | 93.2% | 228 |

Inherited-lease reads fade quickly under skew: at a = 1, half of all reads still wait for the lease.

Now the LogCabin failover run (§7.3). The paper reports Zipf a = 0.5 over 1000 keys, a 37-entry limbo region, and "the client attempts 10,000 reads … but only 9,930 succeed." That's 0.7% blocked. The same formula with L = 37 gives **6.6%, or about 661 failed reads**, roughly 10× more. Matching 0.7% would take about **3.6 effective limbo writes**. The code rules out the obvious explanations. Rejected reads fail fast (`rejectInvalidRequest`), and reads and writes share one Zipf CDF walk, as the formula assumes. One possibility remains: `setLimboRegion` records only tree commands, so if most of the 37 entries were session or no-op entries, the counts would agree. I couldn't confirm that without their EC2 setup, so the gap stays unreconciled.

## The C++ limbo loop stops one entry early

In the LogCabin `leaseguard` branch, `RaftConsensus::becomeLeader()` builds the limbo region like this:

```cpp
// The limbo region extends from commitIndex+1 to our last entry.
for (auto i = commitIndex + 1; i < log->getLastLogIndex(); ++i) { ... }
// ... then append the new term's no-op
```

`Log::getLastLogIndex()` is documented as "the index of the most recent entry in the log." The no-op is appended *after* this loop. So `<` leaves out the newest prior-term entry, the one the paper explicitly includes. The Python simulator gets it right: it iterates `self.log[self.commit_index:]` through the end of the log.

Does one entry matter? L0 commits its last entry, a write to key k, and acknowledges the client. The client then reads k from L1, which wasn't told k is in limbo and returns the previous value. That's a stale read. To measure how often this can happen, I enumerated every assignment of writes to keys over prior-term logs of length *n*, every L1 `commitIndex` *c*, and every possible L0 commit point *c₀* ∈ [c, n−1]. I counted read configurations that the guard admits but whose answer depends on *c₀*:

| n entries | keys | paper bound (inclusive) | C++ bound (`<`) |
|---|---|---|---|
| 3 | 2 | 0 / 64 | 14 / 64 |
| 5 | 3 | 0 / 4,374 | 633 / 4,374 |
| 7 | 3 | 0 / 52,488 | 6,177 / 52,488 |

The inclusive bound is exactly safe. The exclusive bound leaks in 12–22% of configurations. The fix is one character (`<=`). The bug fires only when the final prior-term entry is a client write that L0 committed and acknowledged, which is the common case under load. I found it by reading the code, not by running LogCabin. The paper's linearizability checker runs only on the Python simulator.

A second, harmless one in `StateMachine::setLimboRegion`: `limboPaths.empty();` *asks* whether the set is empty and discards the answer. The intended call is `clear()`. The check only runs while `lastAppliedTerm < currentTerm`, so stale keys do nothing within a term. But they pile up across elections, and each later inherited-lease window rejects every key that was ever in limbo. Safe, but the availability cost grows with every election.

## What still needs clocks

Deferred-commit writes work with plain drift-bounded timers (Δ ± ε). **Inherited-lease reads do not** (§5.3). Two concurrent leaders that replicated the old leader's entries at different local times can disagree about when its lease ends, so one commits while the other still serves inherited reads. Only a time interval stamped *in the entry* resolves that. With the authors' clock error under 50 µs, the age test adds at most ~100 µs to Δ. Without such clocks, turn off inherited reads.

## Takeaways

- "The log is the lease" gives zero-RTT reads with no election changes. LogCabin write throughput rises from ~1k to ~10k/s once quorum reads stop competing for I/O.
- Inherited-read availability is `Σ p_k(1−(1−p_k)^L)` and collapses under skew; don't count on it for hot keys.
- If you port LeaseGuard, test the limbo bound exhaustively. The spec says inclusive; the reference C++ is exclusive.

*Data, scripts, and sources: arXiv:2512.15659v2; `muratdem/RaftLeaderLeases` (Python simulator); `mongodb-labs/logcabin@leaseguard` (C++). Limbo closed form, Monte Carlo, and exhaustive bound check run locally in Python.*
