---
title: "Eg-walker: Replaying Event Graphs Instead of Choosing Between OT and CRDTs"
date: 2026-09-29
tags: ["crdt", "distributed-systems", "collaborative-editing", "algorithms", "performance"]
excerpt: "Eg-walker (Gentle & Kleppmann, EuroSys 2025 best paper, arXiv 2409.14252) stores collaborative text edits as an immutable event graph and builds CRDT state only transiently, during merges — then throws it away. The result: OT-style steady-state memory (just the text), CRDT-style merge complexity O((k+m) log(k+m)), and a trace where OT needs an hour and eg-walker needs 24 ms. I built a miniature walker with prepare/effect versions and retreat/advance, and verified convergence over every valid replay order — after my first, naive concurrency tie-break diverged, which is itself the lesson: the walker's inner ordering logic must be a real CRDT."
---

# Eg-walker: Replaying Event Graphs Instead of Choosing Between OT and CRDTs

Collaborative text editing has spent twenty years stuck in a two-party system. Operational Transformation (OT) keeps documents as plain text and rewrites concurrent operations' indexes against each other — cheap while everyone is online, but merging two branches of n operations each costs at least O(n²), and popular variants are cubic or worse. CRDTs (Yjs, Automerge) assign every character a permanent unique ID so concurrent inserts commute — merges are cheap, but every replica carries the full ID metadata forever: loading a document means reconstructing that structure, and steady-state memory is a large multiple of the text itself.

Eg-walker ("event graph walker", Joseph Gentle and Martin Kleppmann, arXiv 2409.14252, EuroSys 2025 best paper) refuses the choice. The persistent data structure is neither transformed operations nor CRDT state — it's an **event graph**, and CRDT state is built *transiently*, only while merging, then discarded.

## The event graph

Every keystroke is an event: an operation (insert one character at index i, or delete at index i), a unique ID (replica, sequence number), and a set of **parent** event IDs — the graph frontier at the moment the event was generated. That makes the history a DAG, exactly like a Git commit graph at character granularity. Events are immutable, replication is causal broadcast plus set union, and there is no central server in the model.

Crucially, an event's index is interpreted **in the document state its parents describe** — not in whatever state the receiving replica happens to be in. That's the whole problem: to apply a remote event you must figure out what its index means in your document. OT answers by transforming indexes pairwise. CRDTs answer by never using indexes at all. Eg-walker answers by *replaying*.

## Replay: one state, two versions

To merge, eg-walker topologically sorts events and walks them, maintaining an internal state that tracks **two versions of the document at once**:

- the **prepare version** — the state the *next event's author* saw, which must move both forward and backward as the walk jumps between branches;
- the **effect version** — the state with everything applied so far, which only moves forward.

The state is a sequence of records, one per character *ever inserted* (tombstones included), and each record carries two independent status fields:

```text
s_p ∈ { NotInsertedYet, Ins, Del 1, Del 2, ... }   # prepare version
s_e ∈ { Ins, Del }                                  # effect version
```

`Del n` counts concurrent deletions of the same character, so a retreat can decrement without losing information. Three operations drive the walk:

```text
retreat(e):  remove e from the prepare version
             (insert -> mark its record NotInsertedYet;
              delete -> decrement Del n on its target)
advance(e):  the inverse; e must already be applied
apply(e):    with prepare version == e.parents, translate e's index
             through s_p, update both versions, and emit a
             TRANSFORMED operation valid in the effect version
```

Before applying event e, the walker diffs the current prepare version against `e.parents` (a priority-queue sweep over topological indexes), retreats what's extra, advances what's missing, then applies. An insert's prepare index is resolved by counting records with `s_p = Ins`; its effect index by counting `s_e = Ins` records to its left; both lookups run in O(log n) via an order-statistic B-tree keeping subtree counts for *both* status fields, with a second B-tree mapping event IDs to records for retreat/advance. Concurrent inserts at the same position are ordered by an embedded ordering CRDT — a YATA/Yjs variant the authors conjecture is maximally non-interleaving. The output is a stream of transformed operations you can apply to a plain string — which is also exactly what you feed to unaware subscribers, so eg-walker doubles as a server-side OT replacement.

Merging branches of k and m events touches only those events: **O((k+m) log(k+m))**, with at most 2(k+m)+1 tree entries. Correctness is proven against Attiya et al.'s strong list specification — any topological order converges.

## The trick that makes it cheap: throwing state away

If the walker rebuilt state from the epoch on every merge, it would just be a slow CRDT. Two observations fix that:

**Critical versions.** A version that cleanly splits the graph — everything before happened-before everything after — means no future event can be concurrent with the past. At such points the entire internal state (both B-trees, every `s_p`/`s_e`) is garbage. For an event whose version *and* parents are both critical, the transformed operation *is* the original operation, emitted with no index manipulation at all. A purely sequential editing session (most real sessions) never materializes CRDT state.

**Partial replay with placeholders.** To merge new remote events, find the last critical version dominating both branches and start the walk there — representing the entire untouched prefix of the document as a single placeholder record spanning `[0, ∞)`, split lazily only where edits actually land. You never load or reconstruct per-character state for text nobody touched.

Consequence: steady-state memory is the plain text, full stop. The event graph lives on disk in a column-oriented format (run-length-encoded event runs, parents stored only at branch points, LZ4-compressed content) costing between 20% and 3x the final text size — less than Automerge's format across the board.

## I built one, and my shortcut diverged

Following this site's convention, I implemented a miniature walker — records with `s_p`/`s_e`, retreat/advance via ancestor-set diffing, transformed-op emission — and brute-force checked it: for each test event graph, run **every** valid topological order and assert (1) all orders produce the identical document and (2) the transformed-op stream, applied to a plain list, reproduces the effect state exactly.

My first version cut a corner on concurrent-insert ordering: "at the insertion point, skip adjacent concurrent records with a larger ID." On a graph where two branches each type a two-character word at the same position, the six valid replay orders produced **six different documents** (`abcdX`, `acbdX`, `cabdX`, ...). The rule fails because skipping must apply to entire subtrees of the insertion tree, not individual records. Replacing it with a real RGA tree — children of each origin ordered by descending ID — made all checks pass:

```text
test1: 'i!!'   over 3 replay orders   (append vs concurrent delete)
test2: 'cdabX' over 6 replay orders   (no interleaving of concurrent words)
test3: 'y'     over 2 replay orders   (double delete -> transformed no-op)
test4: 'Zac'   over 2 replay orders   (delete vs concurrent prepend)
```

That failure is the paper's architecture in miniature: the *walk* handles time (which events are visible), but position under concurrency needs a genuine ordering CRDT inside the state. Eg-walker doesn't eliminate CRDTs — it confines their lifetime.

## The numbers

On the paper's traces (sequential S1–S3, concurrent C1–C2, and A1–A2 derived from Git histories, normalized to ~500k inserted characters): the A2 trace that takes TTF-based OT roughly **an hour** to merge takes eg-walker **24 ms** — about 160,000x — because OT pays quadratically for long-diverged branches. Against CRDTs, replay runs 7–10x faster than a reference CRDT on sequential traces (Yjs and Automerge slower still), steady-state memory sits one to two orders of magnitude below the best CRDT, and loading a document is just reading cached text, while OT peaks at 6.8 GiB on A2. One caveat the authors quantify: traversal order matters — a poor topological sort that ping-pongs between branches re-triggers retreat/advance churn and can make A2 merges up to 8x slower, which is why the sort keeps runs from one branch consecutive.

## Why this matters beyond text

The deeper idea generalizes: **store the causal history; make replica state a cache.** Git got the storage half right but bolted on a merge algorithm (line-based three-way diff) with no convergence guarantee. CRDTs got merging right but made the metadata permanent. Eg-walker shows the metadata can be a *scratch structure* — rebuilt from a compact immutable log exactly when concurrency exists, at CRDT prices, and free when it doesn't. Since real editing histories are overwhelmingly sequential with occasional bursts of concurrency, the common case costs nothing and the rare case costs O((k+m) log(k+m)). That is the right asymmetry, and it's arguably the first genuinely new point on the OT/CRDT trade-off curve in a decade.
