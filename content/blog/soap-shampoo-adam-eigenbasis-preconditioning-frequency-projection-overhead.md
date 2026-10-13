---
title: "SOAP: Adam in Shampoo's Eigenbasis — Rebuilt, Measured, and One Redundant Rotation Per Step"
date: 2026-10-14
tags: [optimization, deep-learning, second-order-methods, shampoo, adam]
excerpt: "SOAP (ICLR 2025) runs Adam inside the eigenbasis of Shampoo's Kronecker preconditioner. I rebuilt it in NumPy and PyTorch. The paper's Shampoo/Adafactor equivalence checks out to 1.2e-12. On a rotated quadratic, Adam's loss gets 7.6× worse and SOAP recovers almost all of it. On a char-level LM trained on this blog, SOAP beats Adam by 0.07 nats but sits within seed noise of grafted Shampoo, and neither degrades from f=1 to f=100. The paper's per-step overhead formula charges m³ where the work is m²n. The reference code rotates the first moment out of the eigenbasis and back every step, which is 2 of its 5 per-step matmul blocks; skipping that makes the optimizer step 1.65× faster."
---

Shampoo keeps one m×m and one n×n statistic per weight matrix and preconditions with their inverse roots. That makes it a Kronecker-factored approximation of full-matrix Adagrad. It has won optimizer benchmarks, but it costs eigendecompositions and brings its own hyperparameters (exponent, epsilon, grafting). [SOAP](https://arxiv.org/abs/2409.11321) (Vyas, Morwani et al., ICLR 2025) makes a simple observation: run Adam in Shampoo's eigenbasis. On 360M and 660M language models at a 2M-token batch, the paper reports **≥40% fewer iterations and ≥35% less wall-clock than AdamW**, and about 20% less than Shampoo. The only hyperparameter it adds over AdamW is the preconditioning frequency f.

I rebuilt it to see which parts hold up.

## The equivalence that motivates it

Claim 1 in the paper: idealized Shampoo with power ½ produces the same update as Adafactor run in Shampoo's eigenbasis. Here "idealized" means L = E[GGᵀ] and R = E[GᵀG] are dataset averages, and the update is `L^-½ G R^-½ · √tr(L)`.

The proof fits in a line. Rotate by Q_L and Q_R (the eigenvectors of L and R). The row sums of E[G′⊙G′] are then exactly L's eigenvalues λᵢ, and the column sums are R's eigenvalues μⱼ. So Adafactor's rank-1 second moment becomes λμᵀ/Σλ, which is precisely Shampoo's scaling of each coordinate. Checked numerically:

```python
_, QL = np.linalg.eigh(L); _, QR = np.linalg.eigh(R)
Gp = np.einsum('ij,bjk,kl->bil', QL.T, Gs, QR)        # rotate every sample
A, C = (Gp**2).mean(0).sum(1), (Gp**2).mean(0).sum(0)  # Adafactor row/col stats
u_adafactor = QL @ ((QL.T @ G @ QR) / np.sqrt(np.outer(A, C) / A.sum())) @ QR.T
u_shampoo   = inv_sqrt(L) @ G @ inv_sqrt(R) * np.sqrt(np.trace(L))
# max relative difference: 1.19e-12
```

SOAP takes this one step further. Shampoo freezes the *whole* preconditioner between refreshes, magnitudes included. SOAP freezes only the *basis* and updates a full Adam second moment V in that basis every step:

```python
Gp = QL.T @ G @ QR; Mp = QL.T @ M @ QR            # M stays in the original space
V = b2*V + (1-b2)*Gp*Gp
W -= lr * QL @ ((Mp/c1) / (np.sqrt(V/c2) + eps)) @ QR.T
L = b2*L + (1-b2)*G@G.T;  R = b2*R + (1-b2)*G.T@G
if t % f == 0:                                     # one power step + QR, not eigh
    QL = np.linalg.qr(L @ QL)[0]; QR = np.linalg.qr(R @ QR)[0]
```

## Experiment 1: Adam depends on the basis, SOAP doesn't

The setup is a 48×48 matrix quadratic `½·tr(DᵀADB)` with noisy gradients. A and B each have condition number 10³, so the Hessian B⊗A has condition number 10⁶. I ran it twice: once with A and B diagonal, and once with random rotations applied. The rotation leaves the spectrum unchanged and only changes the coordinates Adam sees. Each cell is the best learning rate from a 5-point grid, median of 3 seeds, after 3,000 steps (initial loss 29.1):

| optimizer | f | final loss |
|---|---|---|
| Adam, axis-aligned problem | — | 0.0042 |
| Adam, rotated problem | — | 0.0321 |
| SOAP, rotated | 1 / 10 / 100 / 300 | 0.0077 / 0.0070 / 0.0054 / 0.0054 |
| Shampoo-½ + Adam grafting, rotated | 1 / 10 / 100 / 300 | 0.0122 / 0.0120 / 0.0123 / 0.0122 |

Rotation makes Adam **7.6×** worse. SOAP gets back to within 1.3× of axis-aligned Adam because it learns the axes. Grafted Shampoo lands in between: its direction is right, but it gets only one adaptive scalar per layer.

Two caveats from this run. First, f made no difference here, and that is expected: the basis of a stationary quadratic never moves, so nothing goes stale. Second, my first Shampoo baseline had no grafting, and it diverged at every f > 1. Power-½ Shampoo is not a usable baseline without grafting, which is why the paper uses DistributedShampoo with grafting.

## Experiment 2: a char-level LM trained on this blog

The frequency effect needs gradient statistics that drift. So I trained a 3-layer MLP language model (8-character context, 512 hidden units, 96-symbol vocabulary) on the 2.0 MB of markdown in this blog's `content/blog/`. Each run was 2,000 steps at batch 512 with warmup plus cosine decay and β₂=0.95. The table shows validation cross-entropy at the best learning rate from {1e-3, 3e-3, 1e-2, 3e-2}, averaged over 2 seeds:

| optimizer | f=1 | f=10 | f=100 |
|---|---|---|---|
| AdamW | 1.811 | | |
| Shampoo-½ + grafting | 1.756 | 1.752 | 1.757 |
| SOAP | 1.744 | 1.744 | 1.743 |

SOAP beats Adam by about 0.07 nats. Going from f=1 to f=100 did not hurt SOAP or Shampoo. SOAP's lead over grafted Shampoo (0.01) is smaller than the gap between seeds (up to 0.016). So at this scale I can confirm "rotated Adam beats Adam", but not the paper's Figure 1 (right), where Shampoo degrades faster than SOAP as f grows. My guess is that grafting recomputes Shampoo's step size every step, and in a short run on a small model that is enough to hide a stale basis. The paper's separation comes from 360M-parameter runs over billions of tokens. Treat that claim as scale-dependent until you've measured it on your own model.

## The overhead accounting is off in two places

§7.3 gives SOAP's per-step overhead for an m×n layer as

> m³ (updating L) + n³ (updating R) + (2m²n + 2mn²) (projecting and projecting back)

But `L ← β·L + G·Gᵀ` costs **m²n** multiply-adds, not m³ (and R costs mn²). The m³ and n³ terms belong to the refresh every f steps. For square layers the two counts agree. For a 4096×14336 MLP projection at a 256k-token batch, the formula predicts 11.2% of forward+backward compute where the correct count is 7.0%.

The second discrepancy is in the [reference implementation](https://github.com/nikhilvyas/SOAP). Algorithm 3 keeps M in the original space. The code keeps `exp_avg` in the rotated space instead, which is fine by linearity. But `update_preconditioner` then does this **on every step**:

```python
if state["Q"] is not None:
    state["exp_avg"] = self.project_back(state["exp_avg"], ...)   # out of the eigenbasis
# ... update GG, maybe refresh Q every f steps ...
if state["step"] > 0:
    state["exp_avg"] = self.project(state["exp_avg"], ...)        # and straight back in
```

On f−1 of every f steps, Q hasn't changed, so this round trip is the identity (max error 2.1e-5 in fp32). Per step, the code therefore does five m²n+mn² blocks: project G, project back the update, the round trip on `exp_avg` (two), and the L/R outer products. Two of the five are redundant. I timed it on a 1024×4096 layer with two CPU threads:

| per-step op | time |
|---|---|
| AdamW | 11 ms |
| SOAP, reference op order | 1,227 ms |
| SOAP, round trip only when Q changes | 742 ms |
| one QR refresh (both sides) | 3,412 ms |
| fwd+bwd of that layer, 8k tokens | 1,763 ms |

The predicted ratio was 5/3 = 1.67×. **Measured: 1.65×.** Relative to forward+backward, SOAP's per-step matmul overhead is about `5(m+n)/(3B)` as shipped and `(m+n)/B` with the patch, where B is tokens per step. At the paper's 2M-token batch that is under 1% either way. At 256k tokens and 4096×14336 it is 11.7% versus 7.0%. The paper notes that its overhead "approaches an asymptote greater than zero" as f grows. In the reference code, 40% of that asymptote is this round trip.

The refresh is the other overhead term. One QR pass costs QR1.65× a forward+backward over 8k tokens, so an f around 10 to 100 is what keeps it affordable. SOAP's tolerance for large f is what lets you set it there.

## What to take from it

- **SOAP is Adam with a learned basis.** That's the whole idea, and Claim 1 is exact. If your weight gradients have strong correlations across rows or columns, Adam's diagonal is in the wrong coordinates, and SOAP fixes that for O(m²+n²) memory per layer.
- **Run your own f sweep.** On the char-LM, neither SOAP nor grafted Shampoo got worse from f=1 to f=100, so the paper's robustness gap may only appear at scale.
- **Patch the round trip before you benchmark.** If you are measuring SOAP's wall-clock at small batches, rotate the first moment only when Q changes. At 256k tokens, that removes 40% of the per-step overhead in the reference code at no cost.
