---
title: "Uncertified DAGs: How Mysticeti Cut BFT Consensus Latency by Deleting the Certificates"
date: 2026-08-07
tags: [distributed-systems, consensus, byzantine-fault-tolerance, dag, latency]
excerpt: "DAG-based Byzantine consensus bought throughput by paying for it in latency: every block gets explicitly certified by a supermajority before it can even be considered for ordering, which costs three message delays before the three-delay consensus starts. Mysticeti removes the certification round entirely and recovers the same guarantee by reading patterns in the DAG structure. The result went to production on a 106-validator network and cut median latency 4.75x."
---

DAG-based Byzantine consensus was supposed to answer the throughput problem. Instead of funnelling every decision through a leader that broadcasts, collects votes, and broadcasts again, validators keep proposing blocks that reference each other, forming a directed acyclic graph. Ordering becomes local: every validator applies the same deterministic commit rule to the same DAG, no extra messages required. Narwhal-Tusk and Bullshark showed this works, hitting 100k+ transactions per second.

Then people deployed it and discovered the latency was 2 to 3 seconds.

That is a strange number, because Byzantine consensus has a known lower bound of three message delays, and on a wide-area network a message delay is tens of milliseconds. Something in the DAG construction cost an order of magnitude more than the consensus it enabled. [Mysticeti](https://arxiv.org/abs/2310.14821) (NDSS 2025) identifies the culprit and removes it — and the results are unusually credible, because the protocol replaced Bullshark in production on a 106-validator network.

## Where the latency actually goes

The problem is that certified DAGs certify. In Narwhal and its descendants, a vertex is not a block a validator broadcast; it is a block delivered through **consistent broadcast**. The author proposes, a supermajority signs a vote, the author aggregates those votes into a certificate, and the certificate gets disseminated. Only certified blocks are legal vertices. This buys a real property: a certified block is guaranteed available, and no two conflicting blocks can both be certified for the same (author, round) slot, so equivocation is handled before ordering begins.

The cost is that consistent broadcast is itself a three-message-delay protocol:

```
Certified DAG, one round:
  delay 1: author broadcasts block
  delay 2: validators sign and return votes
  delay 3: author aggregates 2f+1 votes into a certificate, disseminates
  -> 3 message delays to produce ONE DAG round
```

And Bullshark's commit rule needs two rounds: an anchor round, then a following round whose blocks vote for the anchor. Two DAG rounds at three delays each is six message delays to commit, against a floor of three. The paper's framing is blunt: DAG protocols implement consensus, which needs at least three message delays, *on top of* a certification layer costing a further three.

A second cost matters more in practice than the round count. Per round, each validator signs its own block plus a vote on each other block, and verifies `n` block signatures plus the `2f+1` aggregated votes inside each of `n` certificates. That last term is the killer:

```python
def verifications_per_round(n):
    f = (n - 1) // 3
    certified   = n + n * (2*f + 1)   # block sigs + votes inside each certificate
    uncertified = n                   # one signature per received block
    return certified, uncertified, certified / uncertified

for n in (10, 31, 106, 137):
    c, u, ratio = verifications_per_round(n)
    print(f"n={n:4d}  certified={c:6d}  uncertified={u:4d}  ratio={ratio:.0f}x")
# n=  10  certified=    80  uncertified=  10  ratio=8x
# n=  31  certified=   682  uncertified=  31  ratio=22x
# n= 106  certified=  7632  uncertified= 106  ratio=72x
# n= 137  certified= 12604  uncertified= 137  ratio=92x
```

The ratio is exactly `2f+2`, growing linearly with committee size. The paper notes the CPU burden qualitatively; the closed form shows why it is not an implementation detail you can optimize away. At 137 validators you do 92× the verification work per round, and that CPU time lands in the latency path.

## Certificates you never send

Mysticeti's move: keep the safety properties of certification, stop paying for it. A block is signed by its author and multicast, and that is the entire message protocol. One message type, one signature per block. No votes, no aggregation, no certificate dissemination.

The certificates still exist, but they are **implicit** — recovered by reading the DAG's shape rather than transmitted. Two definitions do the work. First, support: `B'` *supports* `B ≡ (A, r, h)` if a depth-first walk from `B'` through its referenced ancestors reaches `B` as the first block it finds for validator `A` at round `r`. Then the patterns:

- **Certificate pattern.** At least `2f+1` blocks in round `r+1` support `B`. Then `B` is certified, and any later block whose causal history contains that pattern *is* a certificate for `B`.
- **Skip pattern.** At least `2f+1` blocks in round `r+1` support no proposal for slot `(A, r)`. That slot can be safely skipped.

The guarantees match certified DAGs exactly, by standard quorum intersection. Two sets of size `2f+1` drawn from `n = 3f+1` overlap in `2(2f+1) − n = f+1` validators, at least one honest — and an honest validator will not support two conflicting blocks for the same slot. So at most one block per slot can accumulate `2f+1` support, even if its author equivocated. The paper's observation here is nicely counterintuitive: if an equivocating validator gets one of its blocks certified anyway, you *process that block as correct*. Self-evident misbehaviour, but harmless, since only the implicitly certified DAG is ever committed. Symmetrically, a skip pattern proves a certificate can never form, so skipping is safe rather than merely convenient.

A DAG round now costs one message delay instead of three, and the three that remain are the irreducible consensus delays.

## Every block is a leader

Removing certification is necessary but not sufficient. Bullshark has one proposer every two rounds, so even at one delay per round you would not reach the bound. Mysticeti generalizes to **proposer slots**: a `(validator, round)` tuple, with up to `n` instantiated per round so every block has a shot at committing in three delays.

The obstacle is that Bullshark's rule depends on every proposer slot linking to every other one, impossible with more than one proposer per round. Mysticeti's answer is a third slot state. Instead of just committed and skipped, each slot is `to-commit`, `to-skip`, or `undecided`, and two rules run over a fixed total order of slots:

**Direct rule.** Walking backwards from the newest slot: mark `to-commit` on observing `2f+1` implicit certificates, `to-skip` on observing a skip pattern. This is the fast path and where the three-delay commit happens — proposal, supporting blocks, certifying blocks. Prompt skipping is what makes crash faults nearly free: a dead validator's slots get marked `to-skip` immediately rather than stalling the slots behind them.

**Indirect rule.** If the direct rule decides nothing, find the slot's *anchor*: the first slot at round `r' > r+2` already marked `undecided` or `to-commit`. An undecided anchor leaves the slot undecided. A `to-commit` anchor makes the slot `to-commit` if it causally references a certificate pattern over the slot, `to-skip` otherwise. Then emit the decided prefix in slot order.

The `undecided` state is load-bearing. Prior designs inserted a buffer round to keep asynchrony from producing non-deterministic commits. Mysticeti instead lets an undecided slot exert backpressure: every later slot in the total order waits behind it. That preserves determinism without a buffer round, and costs nothing in practice because those slots would not have been commit candidates under a single-proposer rule anyway. Decisions propagate recursively through the ordering, so a validator never needs a direct happened-before edge between two proposers to agree with its peers.

Liveness needs one concession. Without randomization you need timeouts, and guaranteeing liveness for all `n` slots would let a Byzantine validator drag every round down to timeout speed. So Mysticeti guarantees liveness after GST for one **primary** block per round: validators at `r+1` wait Δ for it before proposing. Slot count is a tuning knob — `n` slots minimizes latency normally, but under sustained asynchrony more slots means more direct-rule failures.

## What it measured

On a 10-validator committee with 3 crash faults (the maximum tolerable), Narwhal-HotStuff and Bullshark sustain roughly 70k TPS at 8 to 10 seconds; Mysticeti-C carries the same load sub-second, a 15 to 20× improvement, because a crashed validator's slot is skipped rather than waited on. Fault-free, it sustains 300k to 400k TPS.

The production numbers are harder to argue with, being a before-and-after on one network rather than a comparison across codebases. On a 137-validator benchmark at 5,000 TPS, Bullshark ran p50 2,890 ms / p95 4,600 ms against Mysticeti-C's 650 ms / 975 ms — 4.45× and 4.72×. At the cutover on the 106-validator network, median latency went from 1.9 s to 400 ms: 4.75×, a 78.9% cut. All three ratios land in the same narrow band, a good sign the mechanism rather than the benchmark setup is doing the work.

One caveat on the framing. The paper calls three message rounds *the* lower bound, citing Abraham et al.'s [categorization of good-case Byzantine broadcast latency](https://arxiv.org/abs/2102.07240). That result says 2-round partially synchronous Byzantine broadcast is possible **iff** `n ≥ 5f−1`. At the BFT minimum `n = 3f+1` this fails for every `f ≥ 2` — but at `f = 1` it gives `n = 4` and `5f−1 = 4`, so the bound does not exclude a 2-round commit on a 4-validator committee. The optimality claim holds for any committee anyone would deploy; "optimal at `f ≥ 2`" is just the precise statement.

## The transferable idea

The thing worth extracting has nothing to do with blockchains. Mysticeti's certificates never carried information the recipients lacked — a validator holding the DAG can *see* that `2f+1` blocks support a block. The certification round existed to make that fact explicit, and the protocol paid three message delays and `O(nf)` verifications per round for explicitness it did not need.

The general pattern: when a layer's job is to establish a fact, check whether the fact is already derivable from data every participant holds. If it is, the layer is an encoding choice rather than a requirement, and transmitted evidence can become inferred evidence. What you must prove is that inference yields the same guarantee under adversarial conditions — for Mysticeti, one quorum-intersection argument. That proof is the whole protocol. The rest you get to delete.
