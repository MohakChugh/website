---
title: "Breaking the Sorting Barrier for SSSP: A Working BMSSP, Pivots That Almost Never Fire, and the Tie-Break That Prevents a Livelock"
date: 2026-10-11
tags: ["algorithms", "graphs", "shortest-paths", "data-structures"]
excerpt: "Duan, Mao, Mao, Shu and Yin's O(m log^(2/3) n) directed SSSP algorithm (STOC 2025 best paper) is the first to beat Dijkstra in the comparison-addition model. I implemented it in Python and checked it against Dijkstra. It gets every distance right on graphs up to 384k vertices, using 6.6× Dijkstra's edge relaxations. FindPivots took its early exit in 849 of 850 calls on random graphs and in all 1,263 on grids. Removing FindPivots entirely cuts relaxations by 21% without any wrong answers. Dropping the paper's tie-breaking order livelocks the algorithm on the zero-weight cycles that its own constant-degree transform creates."
---

# Breaking the Sorting Barrier for SSSP: A Working BMSSP, Pivots That Almost Never Fire, and the Tie-Break That Prevents a Livelock

Dijkstra's O(m + n log n) was the best bound for directed real-weighted SSSP for 65 years. The `n log n` comes from emitting vertices in distance order, which is sorting. Haeupler et al. (FOCS 2024) proved Dijkstra universally optimal if you require that order.

Duan, Mao, Mao, Shu and Yin's [*Breaking the Sorting Barrier for Directed Single-Source Shortest Paths*](https://arxiv.org/abs/2504.17033) (STOC 2025 best paper) never produces the order. It is deterministic, works in the comparison-addition model, and runs in **O(m log^(2/3) n)**. I implemented it in about 150 lines of Python and checked it against Dijkstra. It is correct. The parts that carry the asymptotic argument just aren't the parts doing the work at any size you can run.

## The idea: shrink the frontier, don't sort it

At any point in Dijkstra, the heap holds a frontier S. Every incomplete vertex's shortest path passes through some complete vertex in S. The cost comes from keeping a total order on S when S can be Θ(n).

BMSSP ("bounded multi-source shortest path") takes a frontier S and a bound B and returns every vertex below some B' ≤ B whose shortest path passes through S. It shrinks the frontier with k Bellman-Ford rounds from S. Vertices fewer than k hops past S are then complete. The rest hang off shortest-path trees with at least k vertices, and only those trees' roots, the **pivots**, go to the recursive calls (at most |W|/k, Lemma 3.2).

The recursion has ⌈log n / t⌉ levels. Level l uses a partial-sorting structure (Lemma 3.3) to pull batches of 2^((l−1)t) closest frontier vertices and pass them down. The parameters are `k = ⌊log^(1/3) n⌋` and `t = ⌊log^(2/3) n⌋`:

```python
def run(s, l, B, S):                       # Algorithm 3
    if l == 0: return s.base_case(B, S[0])  # mini-Dijkstra, stops after k+1 vertices
    P, W = s.find_pivots(B, S)              # k Bellman-Ford rounds, keep big-tree roots
    D = DS(M=2 ** ((l - 1) * s.t), B=B)
    for x in P: D.insert(x, s.key(x))
    Bp = min((s.key(x) for x in P), default=B); U = set()
    while len(U) < s.k * 2 ** (l * s.t) and len(D):
        Bi, Si = D.pull()                    # <= M smallest, plus a separating bound
        Bp, Ui = s.run(l - 1, Bi, Si)
        U |= Ui; K = []
        for u in Ui:
            for v, w in s.adj[u]:
                if s.relax(u, v, w):         # note: <=, not <
                    kv = s.key(v)
                    if Bi <= kv < B:    D.insert(v, kv)
                    elif Bp <= kv < Bi: K.append((v, kv))
        K += [(x, s.key(x)) for x in Si if Bp <= s.key(x) < Bi]
        D.batch_prepend(K)
    Bp = min(Bp, B)
    return Bp, U | {x for x in W if s.key(x) < Bp}
```

One shortcut: my `D` keeps Lemma 3.3's semantics (Insert, BatchPrepend, and Pull returning at most M keys plus a separating bound) on a lazy-deletion heap instead of the paper's block lists. That changes D's costs but not the control flow, so the relaxation counts below are exact. I don't report comparison counts for D.

## Correctness: exact on every run

The algorithm needs constant degree, so each vertex becomes a zero-weight cycle with one node per incident edge (about 2m vertices and 3m edges). I checked every distance against binary-heap Dijkstra on the transformed graph:

| graph | n' | k | t | levels | wrong | relaxations / Dijkstra's |
|---|---|---|---|---|---|---|
| random, deg 3, n=1k | 5,998 | 2 | 5 | 3 | 0 | 5.89× |
| random, n=4k | 23,998 | 2 | 5 | 3 | 0 | 6.60× |
| random, n=16k | 95,998 | 2 | 6 | 3 | 0 | 6.57× |
| random, n=64k | 383,998 | 2 | 7 | 3 | 0 | 6.56× |
| grid 126×126 | 126,000 | 2 | 6 | 3 | 0 | 6.32× |

Dijkstra scans each edge once; BMSSP about 6.6 times. At n=64k, in units of m': 1.71 in FindPivots, 1.54 in base cases, 3.31 in the per-level loop. The last term is by design: each vertex lands in some U_x once per level (Σ|U_x| = O(n log n / t)) and its edges are relaxed each time.

## Finding 1: FindPivots almost never shrinks anything

FindPivots has two exits. If W grows past k·|S| during the k Bellman-Ford rounds, it returns `P = S` immediately, with no reduction. Otherwise it builds the forest F and keeps the roots of large trees. The second exit is the frontier reduction the abstract describes. I counted which exit each call took:

| graph | k | FindPivots calls | early exit (P = S) | partial executions |
|---|---|---|---|---|
| random n=16k | 2 | 850 | **849** | 847 |
| random n=64k | 2 | 1,686 | **1,686** | 1,683 |
| grid 126×126 | 2 | 1,263 | **1,263** | 1,260 |
| random n=16k, k forced to 6 | 6 | 248 | 66 | 68 |

With k = 2 and up to two out-edges per vertex, two Bellman-Ford rounds easily find more than 2|S| vertices below B. The proof still holds through the partial-execution branch: the call then hits its size cap, |U| ≥ k·2^(lt) ≥ k|S|, so |P| = |S| ≤ |U|/k anyway. At practical sizes, the frontier reduction comes from that accounting, not from pivot trees. And k stays at 2 for every n' from 2^8 to 2^27 (134M transformed vertices). It reaches 4 only at 2^64.

So I replaced FindPivots with `return S, set(S)`:

| n=16k random | wrong | relaxations / m' |
|---|---|---|
| with FindPivots | 0 | 6.57 |
| FindPivots → identity | 0 | **5.18** |

Same at n=64k (6.56 → 5.16): still exact, 21% fewer relaxations. Removing it voids the worst-case bound, but on these inputs it is pure overhead.

## Finding 2: the bound doesn't beat log n until n ≈ 2^38

Lemma 3.1 bounds the top-level cost by O((kL + tL/k + t)·n), so `kL + tL/k + t` plays the role of Dijkstra's `log n`. With the paper's floors and all constants set to 1:

| log₂ n | k | t | L | kL + tL/k + t | vs log₂ n |
|---|---|---|---|---|---|
| 20 | 2 | 7 | 3 | 23.5 | worse |
| 27 | 3 | 8 | 4 | 30.7 | worse |
| 36 | 3 | 10 | 4 | 35.3 | first dip below (37 is back above) |
| 100 | 4 | 21 | 5 | 67.2 | 0.67× |

It stays below only from log₂ n = 38, about 2.7×10^11 vertices. That's not a runtime prediction, but even the paper's own cost expression only wins past that point. The result proves Dijkstra isn't optimal for distances. It isn't a faster routing engine.

## Finding 3: the tie-break is load-bearing, and the transform is why

Assumption 2.1 makes all path lengths distinct by comparing paths as ⟨length, hops, v_α, v_(α−1), …⟩, which takes O(1): length, then hops, then predecessor. My `relax` tests `(d[u]+w, hop[u]+1, u) <= (d[v], hop[v], pred[v])`. Remark 3.4 requires `≤`, not `<`, so lower-level relaxations count at upper levels.

The assumption looks like a presentation detail, since random real weights rarely tie. But the transform adds about 2m **zero-weight** cycle edges, so ties are everywhere. I switched to plain length comparison (keeping `≤`, breaking key ties by vertex id) and capped work at 200× m':

| n | finished? | wrong distances |
|---|---|---|
| 200 | capped at 200× m' | 1,174 / 1,198 |
| 1,000 | capped | 5,968 / 5,998 |
| 4,000 | capped | 23,975 / 23,998 |

Every run gets stuck in the first level-1 call, issuing hundreds of thousands of level-0 calls. With lengths alone, `0 + 0 ≤ 0` holds both ways around a zero-weight cycle. Pred[] gets a cycle, which Assumption 2.1 forbids, and `≤` keeps re-inserting completed vertices into D. With hops, going around a cycle strictly increases α. The `≤` rule and the transform's zero cycles are each harmless alone. Together, without the tuple order, the algorithm doesn't terminate. The tie-break is part of the algorithm, not a footnote.

## What to take from it

- **Theory:** sorting isn't inherent to SSSP. BMSSP only ever orders batches of 2^((l−1)t), never the whole frontier.
- **Practice:** use Dijkstra, or a bucket queue for integer weights. BMSSP relaxed 6.6× as many edges at every size I ran, and pivot trees fired in 1 of 3,799 calls.
- **If you port it:** keep the ⟨length, hops, predecessor⟩ order together with `≤`, and expect FindPivots' early exit to dominate until k > 2.
