---
title: "PeerDAS Samples the Same Columns Every Slot: Auditing Fusaka's Custody Sampling Against an Adversary Who Reads the Spec"
date: 2026-11-18
tags: [data-availability, erasure-coding, ethereum, distributed-systems, security]
excerpt: "Ethereum's Fusaka fork replaced 'everyone downloads every blob' with PeerDAS. Each node fetches 8 of 128 erasure-coded columns. Those columns are a public SHA-256 function of the node ID, and they don't rotate. I reimplemented the spec's custody function for 10,000 nodes. A random withholding pattern fools 0.27% of them. An optimised one fools about 1%, only 3.5–3.8× more. The real cost of determinism is targeting: an attacker can deterministically fool any 8 chosen nodes every slot, with no selective serving needed."
---

Data availability sampling (DAS) rests on one probabilistic argument. Erasure-code a block so that any half of it reconstructs the whole. Then an attacker who wants the data gone must withhold more than half. A sampler that fetches a few random pieces will hit a missing one with overwhelming probability. Ethereum's Fusaka upgrade went live on mainnet on 3 December 2025 (epoch 411392). It shipped the first production version of this argument, PeerDAS ([EIP-7594](https://eips.ethereum.org/EIPS/eip-7594)), and two blob-parameter-only forks then raised the blob cap from 9 to 15 and later to 21.

The argument assumes the sampler's choices are random and private. I read the Fulu consensus specs (`das-core.md`, `validator.md`, `p2p-interface.md` on `ethereum/consensus-specs` master). In the deployed design the choices are neither. This post checks how much that matters, using the spec's own custody function and an attacker who optimises against it.

## The construction

PeerDAS uses a **one-dimensional** extension. Each blob is 4096 BLS12-381 field elements, read as the evaluations of a polynomial of degree below 4096. The extension evaluates that polynomial at 8192 points, so any 4096 of them determine it. The 8192 points are cut into 128 **cells** of 64 field elements, 2048 bytes each, and each cell carries its own KZG proof against the blob's commitment. Stack a block's blobs as rows, and column `j` holds cell `j` of every blob. That column, bundled with the commitments and per-cell proofs, is a `DataColumnSidecar`, gossiped on subnet `j`.

The spec's constants:

| Constant | Value | Meaning |
|---|---|---|
| `NUMBER_OF_COLUMNS` | 128 | cells per extended blob |
| `NUMBER_OF_CUSTODY_GROUPS` | 128 | so one column per group |
| `CUSTODY_REQUIREMENT` | 4 | groups a plain node stores and serves |
| `SAMPLES_PER_SLOT` | 8 | minimum groups a node downloads per slot |
| `VALIDATOR_CUSTODY_REQUIREMENT` | 8 | floor for nodes with validators |
| `BALANCE_PER_ADDITIONAL_CUSTODY_GROUP` | 32 ETH | +1 group per 32 ETH attached |

Any node holding 64 or more columns can run `recover_matrix` and re-gossip the rest. Supernodes, which advertise all 128 groups, act as the network's reconstruction backbone.

The bandwidth result is real. At 21 blobs, a node sampling 8 columns pulls 8 × 21 × (2048 + 48 + 48) bytes = 360,192 bytes per slot (cell, proof, and a repeated commitment). That is 13.1% of the 2.75 MB of raw blob data a pre-Fusaka node would have downloaded. A supernode pays 2.09× raw, because it fetches the whole 2× extension.

## The sampler isn't random

This is the spec's custody function. My reimplementation is byte-for-byte the same loop:

```python
def get_custody_groups(node_id, cgc):
    if cgc == 128: return list(range(128))
    cur, out = node_id, []
    while len(out) < cgc:
        g = int.from_bytes(sha256(cur.to_bytes(32, 'little')).digest()[:8], 'little') % 128
        if g not in out: out.append(g)
        cur = 0 if cur == 2**256 - 1 else cur + 1
    return sorted(out)
```

The "Custody sampling" section then says that each slot a node downloads `max(SAMPLES_PER_SLOT, custody_group_count)` groups, chosen by this same function. So sampling **is** custody. The spec says this directly: "the particular columns/groups that a node custodies are selected pseudo-randomly as a function of the node-id and custody size — importantly this function can be run by any party as the inputs are all public." The FAQ adds that custody does not rotate "for now". A node ID is a public key in its ENR, which is discoverable. So anyone can compute which 8 columns any node will check, in every slot, until the node changes identity.

That changes the threat model. Under fresh private sampling, a proposer who publishes 63 columns, one short of recoverable, fools each sampler independently with probability `C(63,8)/C(128,8)`. Under deterministic sampling, the proposer picks which 63 columns to publish, and it knows exactly who will pass.

## Simulation 1: how many nodes can one withholding pattern fool?

I generated 10,000 random 256-bit node IDs and computed each node's 8-group sample set with the function above. Then I attacked them. The adversary chooses a set `S` of 63 published columns, and a node is fooled if its whole sample set lies inside `S`. That is the worst case, because no honest node can reconstruct from 63 columns, so the block really is unavailable. The score is a bitmask test:

```python
def fooled(node_lo, node_hi, S_lo, S_hi):          # 128-bit masks as two uint64 arrays
    return (((node_lo & ~S_lo) == 0) & ((node_hi & ~S_hi) == 0)).sum()
```

I optimised `S` two ways: greedy absorption (repeatedly add the node whose set costs the fewest new columns) followed by swap hill-climbing, and 40,000 steps of simulated annealing over single-column swaps.

| N nodes | random 63 columns | greedy + hill-climb | annealing | gain |
|---|---|---|---|---|
| 1,000 | 2.7 (0.27%) | 32 (3.2%) | n/a | 12× |
| 5,000 | 13.7 (0.27%) | 69 (1.4%) | n/a | 5.0× |
| 10,000 | 26.8 (0.27%) | 94 (0.94%) | 103 (1.03%) | 3.5–3.8× |

The random column matches theory: `C(63,8)/C(128,8) = 0.00271`. The optimised attack is **less dramatic than I expected**. With 10,000 nodes there are far more distinct 8-subsets in play than 63 columns can cover. An `S` built for one cluster of nodes misses almost everyone else, and the gain over random shrinks as N grows. So determinism doesn't let a proposer convince a large share of the network that a withheld block is available. With mixed custody it is weaker still. A node with 16 groups, which takes 512 ETH of attached validators, is fooled by random withholding with probability 3.9 × 10⁻⁶, and supernodes are never fooled. The stake-weighted fraction of attesters fooled sits well below the 1% node count.

On aggregate, then, deterministic custody costs a small constant factor. That isn't where its cost shows up.

## Simulation 2: targeting

The question that matters is whether the attacker can fool a *particular* set of nodes. A bridge relayer, an RPC provider, or a rollup sequencer's beacon node are the ones whose view of availability other systems trust. Pick `k` victims uniformly from the 10,000. They can all be fooled at once if the union of their sample sets fits in 63 columns:

| victims k | P(union ≤ 63 columns) |
|---|---|
| 4 | 1.000 |
| 6 | 1.000 |
| 8 | 1.000 |
| 10 | 0.825 |
| 12 | 0.040 |
| 14 | 0.000 |

The expected union of `k` random 8-sets is `128·(1 − (120/128)^k)`. That is 51.6 columns at k = 8, so the bound is easy to meet. Set this against private random sampling, where fooling one named node takes a 0.27% per-slot lottery and fooling it two slots running takes 7 × 10⁻⁶. Under the deployed rule, any 8 chosen nodes are fooled with certainty in every slot the attacker proposes. Nothing has to be selectively served, either. The attacker gossips 63 columns publicly, and the victims' sample checks pass because they ask only for columns that exist.

A fooled node imports the block and lets its validators attest. Anything downstream that treats "my node accepted it" as "the data exists" now holds a claim nobody can back, such as a light client served by the node or a bridge waiting on blob data for a fraud-proof window. The fooled node's view is corrected only once the rest of the network refuses to build on the block.

## What the spec authors knew, and the fixes

None of this is hidden. The FAQ calls non-rotation a choice "to start with a simple, stable backbone" and suggests adding an `epoch` argument to `get_custody_groups`. Determinism has real benefits: peers' custody is known without a handshake, the function is prefix-stable, and gossip subnets form stable meshes. The numbers above show what was given up for them.

- **Epoch rotation** of custody limits a target list's useful life to one rotation period. It does not change any single slot.
- **Decoupling sampling from custody** is the real fix. That means keeping deterministic custody for serving and adding a few *private*, per-slot random column queries over request/response. Two extra private samples per slot would multiply a targeted victim's pass probability by about `(63/128)·(62/127) ≈ 0.24`. Eight extra would bring it down to roughly the 0.27% lottery.
- **Larger sample sets**, through validator custody, shrink the target list. Rerunning simulation 2 with 16 groups per victim, 4 victims are fooled with certainty, 5 with probability 0.65, and 6 with probability 0.01. At 8 groups the limit is 8–10.

## What I'd take away

PeerDAS works on its headline promise. It cuts per-node blob bandwidth to about 13% of raw at 21 blobs, and a randomly chosen withholding pattern fools 0.27% of 8-group samplers, as theory says. An attacker who reads the spec and optimises over every node's public custody does only 3.5–3.8× better on aggregate at 10,000 nodes. Even so, "the sampler is random" is no longer a safe premise. With deterministic, non-rotating custody sampling, any 8 nodes the attacker chooses are guaranteed to pass on an unavailable block, slot after slot. Treat a single PeerDAS node's availability verdict as a soft signal, not as the probabilistic guarantee the DAS literature promises. Systems that rely on one node's verdict, such as bridges or fraud-proof watchers, should add their own random column queries before they act on it.
