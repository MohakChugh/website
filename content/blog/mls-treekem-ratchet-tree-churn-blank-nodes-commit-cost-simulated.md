---
title: "MLS TreeKEM Under Churn, Simulated: Fresh Groups Start at (2N−1)/3 Ciphertexts, Admin-Committed Removes Decay to N−2, and Letting the Neighbour Commit Keeps It at log N"
date: 2026-11-10
tags: ["cryptography", "mls", "group-messaging", "distributed-systems", "simulation"]
excerpt: "RFC 9420 says TreeKEM can encrypt to everyone but one member with log(N) ciphertexts. That holds only for a ratchet tree with no blank nodes. I wrote a ratchet-tree simulator from the RFC's rules (it reproduces Figures 10 and 11) and measured commit sizes. A freshly created group's first commit averages exactly (2N−1)/3 ciphertexts, 682 at N=1024. Under steady remove/add churn with random committers, parent nodes settle at about 50% blank, which matches a closed form of (1−q)/(2−q) per node, and commits cost about 124 ciphertexts instead of 10. If one admin commits every remove, the tree drops to 99% blank and every commit costs N−2. If the removed member's nearest neighbour commits instead, the tree stays fully populated at log2(N)−1."
---

# MLS TreeKEM Under Churn, Simulated: Fresh Groups Start at (2N−1)/3 Ciphertexts, Admin-Committed Removes Decay to N−2, and Letting the Neighbour Commit Keeps It at log N

Messaging Layer Security (RFC 9420, July 2023) is now shipping: RFC 9750 (architecture) followed in April 2025, and GSMA's RCS Universal Profile 3.0 chose MLS for end-to-end encrypted RCS. Its headline property, from RFC 9420 §2: a ratchet tree lets a member *"encrypt to all but one member of the group"* with *"log(N) encryptions to subtrees, instead of the N−1 encryptions"* of pairwise encryption. §16.2 repeats it.

That bound assumes every parent node holds a key. The RFC also defines **blank** nodes and **unmerged leaves**, which inflate it. I built a simulator from the RFC's rules to measure by how much.

## The four rules that set the cost

A commit's `UpdatePath` re-keys the sender's **filtered direct path**, encrypting each node's path secret once per key in the **resolution** of its copath child (§7.5–7.6). Cost is the sum of those resolution sizes:

1. **Resolution** (§4.1.1). A non-blank node resolves to itself plus its unmerged leaves. A blank parent resolves to the concatenation of its children's resolutions. A blank level-k parent can cost up to 2^k ciphertexts.
2. **Remove** (§12.1.3) blanks the removed leaf *and every node on its direct path*, about log N nodes.
3. **Add** (§12.1.1) appends the new leaf to `unmerged_leaves` of every non-blank ancestor. Add-only commits may omit the path (§12.4).
4. **New leaves are excluded from ciphertexts** (§7.6). They still count when filtering the direct path; they get secrets via Welcome.

## The simulator

Array layout per the RFC: leaf i is node 2i, parents are odd, level = trailing 1 bits. The core:

```python
def resolution(self, x):
    if not self.blank[x]:
        return [x] + [2 * l for l in sorted(self.unmerged.get(x, ()))]
    if level(x) == 0: return []
    return self.resolution(self.left(x)) + self.resolution(self.right(x))

def commit_path(self, s, new_leaves=()):        # returns #HPKE ciphertexts
    x, cts, filtered = 2 * s, 0, []
    for p in self.direct_path(2 * s):
        full = self.resolution(self.sibling(x))   # filtering counts new leaves
        res = [r for r in full if not (r % 2 == 0 and r // 2 in new_leaves)]
        if full: filtered.append(p); cts += len(res)
        x = p
    self.blank_path(s)                            # §7.5 step 1
    for p in filtered: self.blank[p] = False      # fresh keys, no unmerged leaves
    return cts
```

Add, remove (with truncation) and extend follow §7.7 and §12.1. The simulator reproduces Figure 10's resolution (`[X, B, Y, H]`) and all five filtered direct paths under Figure 11. My first version also dropped new leaves from the filtering step, which made a new group's first commit cost N−1; §12.4.1 corrected it.

## Finding 1: a new group starts nearly unprotected by the tree

A creator typically adds N−1 members in one commit. By rule 4 that path keys only the creator's ~log N direct-path nodes; every other parent stays blank. When member s first commits, one copath subtree holds the creator (1 ciphertext) and the rest are fully blank: if the paths meet at level d, cost is N − 2^d. Averaged over senders:

```
E[first commit] = Σ_d 2^d (N − 2^d) / (N − 1) = (2N − 1) / 3
```

Exhaustive enumeration at N=1024 gives 682.33 = 2047/3 (min 512, max 1023). Recovery as random members commit:

| N | first commit, exact (2N−1)/3 | mean, commits 0–N/4 | mean, N/4–N/2 | mean, 3N–4N | commits until rolling mean < 1.5·log2N |
|---|---|---|---|---|---|
| 256 | 170 | 26.7 | 9.5 | 8.0 | 0.14N |
| 1,024 | 682 | 35.0 | 11.6 | 10.0 | 0.12N |
| 4,096 | 2,730 | 46.7 | 13.7 | 12.0 | 0.11N |

log N arrives only after ~N/8 commits; the first N/4 average 3.3–3.9× steady state. A bot-created group whose members rarely commit can stay there indefinitely.

## Finding 2: churn keeps half of the parents blank

From a healed N=1024 tree, each epoch is a *swap* (remove a random member, add a newcomer, one commit, path required) or a *self-update* (empty commit by a random member). The variable is who commits swaps.

| swap share | random committer: cost | blank parents | single admin: cost | blank parents |
|---|---|---|---|---|
| 10% | 15.6 | 8.7% | 15.8 | 7.8% |
| 25% | 25.8 | 21.1% | 32.3 | 24.3% |
| 50% | 51.0 | 31.6% | 109.0 | 48.4% |
| 75% | 81.4 | 41.7% | 358.2 | 74.7% |
| 100% | 123.7 | 52.2% | **1,022.0** | **99.0%** |

Under pure churn with random committers, a node covering fraction q of members is blanked when the victim is beneath it and refilled when the committer is (the commit runs after the remove). The two-state chain's stationary blank probability:

```
π(q) = (1 − q) / (2 − q)       → 1/2 for low nodes, 1/3 one level under the root
```

The simulator matches at every level within 0.02 (level 1: 0.516 vs 0.500; level 9: 0.323 vs 0.333). The *rate* is predictable; the *cost* isn't. Treating nodes as independently blank predicts 29 ciphertexts at N=1024; measured is 124 (p99 220). A remove blanks an entire root-ward path, so blank nodes have blank children and resolutions blow up together. Cost grows 52 → 124 → 278 (p99 544) from N=256 to 4096, roughly N^0.6; at 4096 the independent model (40) is 6.9× low even though per-level rates match π(q) within 0.01.

The single admin is the worst case: its commits only ever refresh its own path, while every remove blanks a path only someone else can fix. With no self-updates, every parent off the admin's path goes blank and each commit costs N−2 (everyone but the admin and the Welcomed newcomer). TreeKEM has degenerated into pairwise encryption.

## Finding 3: who commits matters more than how often

The fix follows from rule 2. The victim's sibling has *the same* direct path, so if it commits the removal it re-keys every node the remove just blanked:

| N | random committer | single admin | nearest neighbour commits | admin removes, neighbour self-updates next |
|---|---|---|---|---|
| 256 | 52.3 (53% blank) | 254.0 (97%) | **7.0** (0%) | 10.5 per commit (0%) |
| 1,024 | 123.8 (50%) | 1,022.0 (99%) | **9.0** (0%) | 13.5 per commit (0%) |

The neighbour policy holds the tree full at log2N − 1 (the newcomer lands in the victim's slot beside the committer and is excluded). Where an admin must authorise removes, have the admin commit and the victim's neighbour send an empty commit immediately after: 27 ciphertexts total per removal at N=1024 instead of 1,022, still 0% blank.

## What it costs on the wire

With `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`, an `HPKECiphertext` is a 32-byte KEM output plus a 32-byte path secret and 16-byte tag, ~80 B, so a 1,022-ciphertext commit is ~82 KB before fan-out to 1,023 recipients. A hybrid post-quantum KEM like X-Wing (1,120-byte encapsulation) makes each ~1,168 B: the degraded admin commit becomes **~1.19 MB** versus ~10.5 KB under the neighbour policy. Moving to PQ KEMs multiplies existing blank-node overhead by 14.6×.

## Practical takeaways

- **Monitor ciphertexts per commit against log2N.** A persistent ratio far above 1 is a commit-policy problem, not a crypto one.
- **Route removals to the victim's neighbour**, or follow an admin removal with that neighbour's self-update.
- **Heal new groups deliberately**: empty commits from ~N/8 members take cost from (2N−1)/3 to near log N.
- **Never let a bot be the only committer.**

## Limits

One commit per epoch; no concurrent commits or forks, which real deployments add as retry cost. Victims are uniform, whereas real churn clusters in recently added right-edge leaves. Add-only commits weren't modelled, so `unmerged_leaves` stays empty; including them only raises every number above. The policy table stops at N=1,024 because the O(N) neighbour search made the 4,096 run impractical. All figures come from my RFC-derived simulator, validated against the RFC's figures, not from a production MLS stack.
