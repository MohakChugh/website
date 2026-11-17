---
title: "Sequoia's Token Trees: The DP Is a Heap, and the Scaling Law Is an Entropy"
date: 2026-11-18
tags: [speculative-decoding, llm-inference, algorithms, gpu, performance]
excerpt: "Sequoia picks speculative-decoding token trees with an O(N²B) dynamic program and proves expected accepted tokens grow as Ω(b·log n / log log n). I reimplemented both. For a non-increasing acceptance vector, a 15-line heap gives the same trees to 3e-15. The real growth rate is ln(n)/H, where H is the entropy of the rank at which the target accepts a draft token. That constant tells you what each doubling of the tree buys, and the best tree size lands on the verifier's roofline knee."
---

Speculative decoding lets a cheap draft model propose tokens that the target checks in one forward pass. A single chain saturates fast: if each token is accepted with probability `p1`, the expected yield is capped at `1/(1 − p1)` however long the chain. Trees fix this, since the verifier only needs one of a node's candidate children to match.

[Sequoia](https://arxiv.org/abs/2402.12374) (Chen et al., CMU/Meta/Yandex, NeurIPS 2024) asks which tree shape you should verify. It reports 4.04× on an A100 for Llama2-7B and 9.5× for Llama3-70B with offloading on an L40. It has three parts: an acceptance model, a dynamic program that picks the optimal tree under it, and a theorem that yield grows without bound. I reimplemented all three. The model holds up, the DP is more machinery than needed, and the theorem undersells the real result.

## The positional acceptance model

Sequoia samples a node's children from the draft **without replacement**. The k-th child is the k-th distinct token drawn. The verifier then walks the children in order. The key assumption is that the probability the k-th child is the one accepted depends only on `k`. That gives an acceptance vector `p = (p1, p2, …)`, where siblings are mutually exclusive and `Σ p_k ≤ 1`. The rejection rate after `k` children is `r_k = 1 − (p1 + … + pk)`.

Under that model a node's chance of lying on the accepted path is the product of `p` values along its path from the root. Proposition 3.4 says the expected number of generated tokens is just the sum of those products over the tree:

```
F(T) = Σ_{v ∈ T} f(v),   f(v) = Π_{i ∈ Path(v)} p_i,   f(root) = 1
```

Sequoia maximizes `F` over trees of size `n` with a 2-D table. `T[n][b]` is the best tree of `n` nodes whose root has exactly `b` children. Its recurrence splits off the last child's subtree:

```python
def sequoia_dp(P, N, B):                     # Algorithm 1, verbatim
    T = [[-inf] * (B + 1) for _ in range(N + 1)]; Tmax = [-inf] * (N + 1)
    T[1][0] = Tmax[1] = 1
    for n in range(2, N + 1):
        for b in range(1, B + 1):
            T[n][b] = max(T[n - m][b - 1] + P[b - 1] * Tmax[m] for m in range(1, n))
        Tmax[n] = max(T[n])
    return Tmax
```

That's `O(N²B)`, offline, and milliseconds at `N = 128`. Speed isn't the issue. The structure is just simpler than this.

## The optimal tree is the top-n nodes

`F(T)` is a sum of node scores over a set of nodes that must be closed under "parent of" and "left sibling of". You can't verify child 3 without children 1 and 2, because sampling without replacement produces them in order. If `p` is non-increasing, every node scores no higher than its parent (multiplying by `p ≤ 1`) and no higher than its left sibling (`p_{k+1} ≤ p_k`). So the `n` highest-scoring nodes of the infinite tree already form a closed set, and no closed set of size `n` can have a larger sum. The optimal tree is the top-n nodes, and a frontier heap finds them:

```python
def sequoia_greedy(P, N, B):
    G, curve, heap = 0.0, [], [(-1.0, 0, 1.0)]       # (-score, sibling index, parent score)
    while heap and len(curve) < N:
        s, k, ps = heapq.heappop(heap); s = -s
        G += s; curve.append(G)
        heapq.heappush(heap, (-(s * P[0]), 1, s))     # first child
        if 1 <= k < B:                                # next sibling
            heapq.heappush(heap, (-(ps * P[k]), k + 1, ps))
    return curve                                      # curve[n-1] = best F for size n
```

On 300 random non-increasing vectors (B from 1 to 8, N up to 40), the heap and Algorithm 1 agree on every prefix size to within **3.1e-15**. The same argument covers Sequoia's two extensions. A depth bound just means you stop pushing first children past depth `D`. A depth-dependent acceptance matrix (for Medusa/EAGLE-style self-speculation) works as long as each row is non-increasing.

The DP only matters when the measured `p` isn't monotone (noisy estimates, odd calibration). My worst random case, `p = (0.19, 0.217, 0.002, 0.535)`, gives 2.92 tokens via DP versus 2.18 via greedy at `n = 17`. But a draft whose 4th-ranked token is accepted 250× more often than its 3rd is broken, and the fix belongs in the draft. Sort-check `p` and use the heap. It also yields the whole `G(n)` curve to `n = 10⁶` in seconds, which the next section needs.

## The scaling law, sharpened

Theorem 3.6 assumes a "b power-law" verifier, `r_k ≤ k^(−b)`, and proves the yield `G(n)` is `Ω(b·log n / log log n)`. That is a lower bound, and the `log log n` is slack. Write each node's cost as `x = −ln f(v)`. The number of nodes with cost at most `x` satisfies a renewal equation, `N(x) = 1 + Σ_k N(x + ln p_k)`. When `Σ p_k = 1`, the weights `p_k` are a probability distribution, and the renewal theorem gives `N(x) ~ eˣ/H` with

```
H = −Σ_k p_k ln p_k
```

H is the Shannon entropy of the rank at which the target accepts a draft token. The yield obeys the companion equation `G(x) = 1 + Σ_k p_k G(x + ln p_k)`, so `G ~ x/H`. Eliminating `x` gives

```
G(n) ≈ ln(n) / H + const
```

I checked this with the heap, taking `r_k = (k+1)^(−b)`, so `p_k = k^(−b) − (k+1)^(−b)`, and growing trees to about a million nodes:

| b | p1 | H (nats) | 1/H | measured dG/d(ln n), n = 32 → 10⁶ | G(128) | G(10⁶) |
|---|---|---|---|---|---|---|
| 0.5 | 0.293 | 3.691 | 0.271 | 0.267–0.275 | 2.48 | 4.91 |
| 1 | 0.500 | 2.046 | 0.489 | 0.489–0.498 | 3.67 | 8.08 |
| 2 | 0.750 | 0.948 | 1.055 | 1.054–1.081 | 6.58 | 16.09 |

The slope converges to `1/H` to three digits by `n ≈ 2,000` in every case. So the yield is Θ(log n) with an explicit constant. **Each doubling of the tree adds `ln 2 / H` tokens.** With b = 1 that's 0.34 tokens per doubling. Going from 128 to 256 nodes buys a third of a token. The paper's empirical statement, "roughly logarithmic", was more accurate than its theorem.

It also explains why temperature hurts: spreading the target's choices across more draft ranks raises `H` and flattens the curve. `H` is the cleanest single number for comparing drafts, and you can estimate it from acceptance logs without building trees.

## Is "unbounded" doing the work?

Sequoia contrasts its unbounded growth with the caps of fixed structures. Chains are capped at `1/(1 − p1)`. The paper says an infinite binary tree is capped at "`1/(1 − P2)`", but with `P2` defined as the position-2 acceptance probability, the cap is `1/(1 − p1 − p2) = 1/r_2`. My B = 2 runs approach exactly that (9.0 for b = 2). In general, limiting branching to `B` caps the yield at `1/r_B`. But at realistic sizes the caps don't bind (b = 2):

| max branching B | cap 1/r_B | n = 16 | n = 128 | n = 1024 |
|---|---|---|---|---|
| 1 (chain) | 4 | 3.96 | 4.00 | 4.00 |
| 2 | 9 | 4.36 | 6.20 | 7.33 |
| 4 | 25 | 4.36 | 6.57 | 8.58 |
| ∞ | ∞ | 4.36 | 6.58 | 8.78 |

At n = 128 an *optimally shaped* binary tree gets 94% of the unbounded tree, while a *full* binary tree of 127 nodes (depth 6) yields only 5.05. Most of Sequoia's win over k-ary baselines comes from **shape**: a long first-child spine with thin side branches wherever path products stay high. Unbounded fan-out contributes little, so capping B at 4 costs almost nothing below a thousand nodes.

## Picking n: put it on the roofline knee

The hardware-aware step maximizes `G(n, d) / (t(n) + d·c)`, where `t(n)` is the cost of verifying `n` tokens relative to one token and `c` is the cost of one draft step. The paper's tables are self-consistent. In the A100 Llama2-7B row, 24.2 ms / 6.0 ms gives 4.03×. Multiplying time-between-tokens by tokens per step gives 30.5 ms per step. Taking out ten 0.5 ms draft steps leaves verification of 128 tokens at **1.05×** the cost of one. Verification at that size is still memory-bound.

So model `t(n) = max(1, n/knee)` with `c = 0.021` (0.5/24.2) and search over sizes and depths:

| verifier knee | best n | best depth | speedup |
|---|---|---|---|
| 32 | 32 | 7 | 4.32× |
| 128 | 128 | 9 | 5.38× |
| 1024 | 1024 | 11 | 6.86× |

The optimum sits exactly at the knee every time, with depths matching the paper's 7–10. The `ln n / H` law explains why: past the knee, doubling `n` doubles cost but adds only `ln 2 / H` tokens; below it, nodes are free. Offloading pushes the knee out because weight transfer dominates, hence the L40's 768-node, depth-18 trees at 10–11 tokens per step.

## Takeaways

- **The scoring model is sound, and simple.** For a non-increasing `p`, the optimal tree is the top-n nodes, found by a heap in `O(n log n)`. A non-monotone estimate is a draft bug, not a DP use case.
- **The yield is `ln(n)/H`.** H is the entropy of the accepted draft rank. It predicts the marginal value of a bigger tree (`ln 2/H` per doubling) and is the right metric for comparing drafts and temperatures.
- **Shape beats fan-out.** Bounded-branching caps (`1/r_B`) exist but don't bind below about 10³ nodes for B ≥ 4.
- **Size the tree to the hardware, not the algorithm.** Measure where verification stops being free and put `n` there. Logarithmic yield can't pay for linear cost.
