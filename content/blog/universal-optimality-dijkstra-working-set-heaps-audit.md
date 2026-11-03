---
title: "Universally Optimal Dijkstra, Audited: Working-Set Heaps Win 29× on the Paper's Graph and 0.8–5% on Grids and Random Graphs"
date: 2026-11-04
tags: ["algorithms", "data-structures", "shortest-paths", "heaps", "graphs"]
excerpt: "Haeupler, Hladík, Rozhoň, Tarjan and Tětek (FOCS 2024 best paper) prove that Dijkstra with a working-set heap is universally optimal for ordering vertices by distance. I implemented their outer heap of doubly-exponentially sized inner heaps and counted comparisons. On the paper's star-plus-path graph a binary heap does 28.8× more work, and the ratio grows at about 2.9 per bit of log₂ t. On grids and random digraphs Σlog W is within 0.8–5% of Σlog |heap|, so the theory has almost no headroom. A naive find-min scan adds 3× the outer heap's own comparisons unless you use the bit-vector trick. On a path, even the optimal heap is 52× above the information-theoretic bound until bottleneck lookahead removes the additive n."
---

# Universally Optimal Dijkstra, Audited: Working-Set Heaps Win 29× on the Paper's Graph and 0.8–5% on Grids and Random Graphs

Dijkstra with a Fibonacci heap runs in O(m + n log n), which is tight over all graphs. Some graphs are easy for every choice of weights, and a worst-case-optimal algorithm can still waste a log factor on them.

[*Universal Optimality of Dijkstra via Beyond-Worst-Case Heaps*](https://arxiv.org/abs/2311.11793) by Haeupler, Hladík, Rozhoň, Tarjan and Tětek (FOCS 2024 best paper; journal version v4, May 2025) closes that gap for the **distance order problem**: output the vertices sorted by distance from s. *Universally optimal* means that on every fixed graph G, under worst-case weights, it is within a constant of the best algorithm for G.

Their result: Dijkstra is universally optimal in time, O(m + log D), as long as its heap has the **working-set bound**. Here D is the number of possible distance orders of G. Two extensions, bottleneck lookahead and a recursive Dijkstra, also make it optimal in comparisons. I built the paper's heap, ran it next to a binary heap and a pairing heap on 10 graphs, and counted every key comparison.

## The working-set bound

The paper defines the working set of an item x as the items inserted from x's insertion until x's deletion, x included. A heap has the working-set bound if insert and decrease-key are O(1) amortized and delete-min of x costs O(log W(x)). Items inserted before x don't count.

The paper's Figure 1 shows why. Take a source s, t leaves u₁…u_t hung off s with heavy arcs, and a light path v₁…v_r. The whole path is deleted while the t leaves sit in the heap, so each v_j costs Θ(log t) in a Fibonacci or binary heap, although v_j's working set is just {v_j}. The optimal cost is O(r + t log t), so with r = t² any size-based heap loses a log factor.

The proof chain is short:

1. **Lower bound.** Any comparison algorithm needs ⌈log₂ D⌉ comparisons (Lemma 6.2, a decision-tree argument). Every topological order of any spanning tree rooted at s is a distance order (Lemma 3.1).
2. **Upper bound.** Record each vertex's heap-residency interval [insert index, last index inserted before its deletion]. A Dijkstra tree arc u→v means u was deleted before v was inserted, so these intervals form a DAG. A lemma of van der Hoog et al. gives Σ log(interval length) = O(log #topological orders), and that count is at most D.

So Σ log W(v) = O(log D).

## The heap: inner heaps of size 2^(2^i)

Pairing heaps have the working-set bound only without decrease-key (Iacono 2000), and Dijkstra needs decrease-key. The paper's construction (§10) is black-box. It keeps a list H₁, H₂, … of meldable "fast" inner heaps, newest items first, with |H_i| ≤ 2^(2^i). Insert creates a singleton H₀, then melds the first adjacent pair that fits and shifts everything before it down one slot:

```python
def insert(self, x, k):
    h0 = Inner(PNode(x, k))               # new singleton inner heap H_0
    L = [h0] + self.H                     # L[j] is H_j
    for j in range(len(L) - 1):
        if L[j].size + L[j+1].size <= 2 ** (2 ** (j + 1)):
            L[j+1].meld(L[j])              # one comparison; union-find records the move
            L = L[:j] + L[j+1:]            # H_0..H_{j-1} get index +1
            break
    self.H = L                             # no fit: everything just shifts by one
```

Since every item in H_{i−1} was inserted after every item in H_i, an item deleted from H_i has W > 2^(2^(i−2)) − 2^(2^(i−3)) (Corollary 10.5). The delete-min costs log |H_i| ≤ 2^i. Their ratio is the constant: log 2^(2^(i−3)) = 2^i/8, so the bound has 8× slack built in. There are at most 1 + log log n inner heaps: H₄ already holds 65,536 items and H₅ 2³². Decrease-key finds an item's inner heap with union-find. Find-min uses a suffix-minimum bit vector over the ≤ 5 inner-heap roots.

My inner heaps are two-pass pairing heaps. Strictly, the paper wants O(1) amortized decrease-key, which pairing heaps aren't proven to have. An assert checks Lemma 10.2's size invariant after every insert, and it never fired. (My first version deleted empty inner heaps. That shifts large heaps into small slots and silently breaks the invariant; the paper keeps them in place.) The find-min scan's comparisons are counted separately as `+scan`, because the paper's bit vector does that step without key comparisons.

## Results: the paper's graph

Counts include the decrease-or-not test per relaxed arc. log₂ D(T) is computed exactly with the tree hook formula n!/∏ subtree sizes, which gives a lower bound on log₂ D(G).

| Fig. 1 graph, r = t² | n | log₂D(T) ≥ | Σlog₂W | binary | pairing | outer (+scan) | binary/outer |
|---|---:|---:|---:|---:|---:|---:|---:|
| t = 64 | 4,161 | 769 | 775 | 70,213 | 4,525 | 4,401 (+8,295) | 16.0× |
| t = 256 | 65,793 | 4,097 | 4,105 | 1,510,729 | 67,971 | 67,469 (+131,509) | 22.4× |
| t = 1024 | 1,049,601 | 20,481 | 20,491 | 30,426,351 | 1,061,026 | 1,058,089 (+3,147,957) | 28.8× |
| t = 1024, leaves interleaved | 1,049,601 | 20,481 | 19,067 | 23,842,906 | 1,061,290 | 351,357 (+3,014,930) | 67.9× |

The binary heap spends 29 comparisons per path vertex at t = 1024, about 2.9·log₂ t: one sift-down after the root is replaced and one sift-up for the new path vertex. Its ratio to the outer heap grows as 16.0/6, 22.4/8, 28.8/10 ≈ 2.7–2.9 per bit of log t, exactly the Ω(r log t) the paper predicts.

What the paper doesn't spell out:

- **Pairing heaps already get it here.** Fig. 1 has no decrease-keys, so Iacono's theorem applies and pairing (1.061M) matches the outer heap (1.058M). The new heap only pays off when decrease-keys are frequent.
- **The scan dominates.** A linear find-min over ~5 inner roots costs 3.0 comparisons per delete-min, which is 3× the outer heap's own work. Without the bit-vector trick, the working-set heap loses its constant to its own bookkeeping.
- **Σlog₂W tracks log₂D(T) almost exactly** (20,491 vs 20,481). Even so, the outer heap's 1.06M comparisons are **52× above** the 20,481-comparison lower bound. That is the additive Θ(n) term in Theorem 7.4: every insert links once. Section 8 fixes this exactly. Here v₂…v_r are bottlenecks (each is alone on its BFS level), lookahead never puts them in the heap, and their distances are summed instead of compared.

## Results: graphs that look like workloads

| Graph | n | Σlog₂\|H\| | Σlog₂W | gap | binary | pairing | outer (+scan) |
|---|---:|---:|---:|---:|---:|---:|---:|
| grid 316², U(0,1) | 99,856 | 850,880 | 808,672 | 5.0% | 1,796,917 | 1,477,216 | 1,149,873 (+280,345) |
| random digraph, deg 4 | 97,994 | 1,404,548 | 1,369,973 | 2.5% | 2,941,132 | 2,268,675 | 2,018,594 (+293,752) |
| random digraph, deg 16 | 50,000 | 700,394 | 694,622 | 0.8% | 1,877,524 | 1,586,789 | 1,489,215 (+148,106) |

Σlog₂|H| is what a size-bounded heap pays per delete-min, and Σlog₂W is what a working-set heap pays. On grids and random graphs they're within 0.8–5% of each other. The frontier turns over: items leave the heap at about the rate they enter, so heap size ≈ working set and there's nothing for the theory to exploit. The outer heap still beats the binary heap by 1.26–1.56×. Most of that is pairing-style linking against binary sift-down, not the working-set property: pairing alone is already 1.18–1.30× better.

To see how quickly the Fig. 1 effect shows up, I added heavy arcs (weight U(100, 200); the grid's maximum distance is 144.5) from s to random grid vertices. Their endpoints are inserted early with stale keys and then decrease-keyed or left waiting:

| Heavy source arcs | Σlog₂\|H\| / Σlog₂W | binary / outer |
|---:|---:|---:|
| 0 | 1.05 | 1.56× |
| 1,000 | 1.17 | 1.69× |
| 10,000 | 1.33 | 1.80× |
| 50,000 | 1.27 | 2.00× |

The gap peaks and then shrinks: once half the vertices arrive early from s, their own working sets cover most of the run.

## What to take away

- **The theorem targets one pattern:** items parked in the heap long before they're deleted. Heavy early fan-out from the source, hub vertices, and multi-source searches seeded with far targets all produce it. Frontiers that turn over, like road grids and random sparse graphs, don't, and there the gain is ≤ 5%.
- **On those graphs, binary-heap Dijkstra already does 1.4–2.9× log₂D(T) comparisons.** Universal optimality certifies that it's near-optimal rather than improving on it.
- **The constants live in the plumbing:** the find-min bit vector, keeping empty inner heaps in place, and the 8× slack in Theorem 10.6. The working-set win comes from the 2^(2^i) size schedule, not from the inner heap.
- **If you need distances but not their order,** the log D bound doesn't apply. Duan et al.'s O(m log^(2/3) n) algorithm (STOC 2025) beats Dijkstra's worst case on sparse graphs, though not at runnable sizes.

*Method: a ~200-line Python simulator counting every key comparison. I didn't measure wall-clock time: comparisons are the paper's cost model, and Python timings would mostly measure the interpreter. The paper's numbers are from the arXiv v4 PDF.*
