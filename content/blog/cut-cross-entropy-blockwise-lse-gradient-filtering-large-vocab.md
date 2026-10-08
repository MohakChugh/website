---
title: "Cut Cross-Entropy: Training Loss Without the Logit Matrix, and Why 0.1% Element Sparsity Becomes 50% Block Sparsity"
date: 2026-10-08
tags: ["llm-training", "gpu", "memory", "kernels", "numerics"]
excerpt: "Cut Cross-Entropy (Apple, ICLR 2025) computes the LM loss and its gradient without ever writing the N×|V| logit matrix to HBM, cutting Gemma 2 2B's loss memory from 24 GB to 1 MB. Its 1,161 MB 'lower bound' row is exactly the size of the bf16 gradients for C and E. The speed comes from skipping softmax blocks below 2⁻¹². I measured that on Qwen2.5-0.5B: 0.125% of softmax entries clear the threshold, yet 49% of 128×128 blocks still have to be computed (99% under a random vocab order). At the paper's sparsity level my model keeps 21% of blocks, which matches the ~20% implied by the paper's own timings. Filtering also zeroes the classifier gradient for 10% of the vocabulary, which is why pretraining needs the FullC variant."
---

# Cut Cross-Entropy: Training Loss Without the Logit Matrix, and Why 0.1% Element Sparsity Becomes 50% Block Sparsity

Since FlashAttention removed the N×N attention matrix from HBM, the largest tensor in many LLM training steps is the N×|V| logit matrix the loss creates. For Gemma 2 2B (|V| = 256,128), Wijmans et al. ([*Cut Your Losses in Large-Vocabulary Language Models*](https://arxiv.org/abs/2411.09009), Apple, ICLR 2025) report that log-probabilities take 89% of training memory.

Their kernel, Cut Cross-Entropy (CCE), computes the loss and its gradient without writing that matrix to global memory. I read the [Triton source](https://github.com/apple/ml-cross-entropy) and reproduced the forward pass in NumPy. I also measured the part the speed depends on, gradient filtering, on real hidden states from Qwen2.5-0.5B (|V| = 151,936, D = 896, 4,096 tokens).

## The memory numbers hold up

The paper's Table 1 benchmarks Gemma 2 2B at N = 8,192 tokens, |V| = 256,000 and D = 2,304. The numbers reconcile exactly if "MB" means MiB:

```
fp32 logits      8192 × 256000 × 4 B   = 8000 MiB
Baseline peak    24,000 MB             = three fp32 N×|V| buffers
                                         (logits, log-softmax, grad)
∇C (bf16)        256000 × 2304 × 2 B   = 1125 MiB
∇E (bf16)        8192 × 2304 × 2 B     =   36 MiB
"Lower bound"    1,161 MB              = ∇C + ∇E exactly
CCE loss+grad    1,164 MB              = lower bound + 3 MiB
```

The abstract's "28 GB to 1 GB" for the classifier head means CCE sits 3 MiB above the output gradient any method must allocate.

## The decomposition

Per token, cross-entropy splits into two terms that never need the full row of logits at once:

```
loss_i = LSE_i − C[x_i] · E_i        where LSE_i = log Σ_v exp(C[v] · E_i)
```

The second term is an **indexed dot product**: gather the target's classifier row, then do one D-length dot product per token. That is N scalars of output. The first term is a **linear-log-sum-exp**: a matmul whose output is reduced right away. Each tile of logits is computed in SRAM, reduced to one partial LSE per row, and folded into a global accumulator:

```python
def cce_forward(E, C, x, NB=128, VB=512):
    """E: (N, D) embeddings, C: (V, D) classifier, x: (N,) targets."""
    N, V = E.shape[0], C.shape[0]
    tgt = np.einsum('nd,nd->n', E, C[x])            # indexed dot: N scalars
    lse = np.full(N, -np.inf)
    for n0 in range(0, N, NB):                       # each (n, v) tile lives in "SRAM"
        for v0 in range(0, V, VB):
            A = E[n0:n0+NB] @ C[v0:v0+VB].T          # (NB, VB) logits tile
            m = A.max(1)
            blk = m + np.log(np.exp(A - m[:, None]).sum(1))
            lse[n0:n0+NB] = np.logaddexp(lse[n0:n0+NB], blk)  # kernel: locked log-add-exp
    return lse - tgt, lse                            # per-token loss, LSE saved for backward
```

On random inputs this matches a dense reference to 7×10⁻¹⁵. On the GPU, each (n-block, v-block) pair is its own CTA, and CTAs that share `LSE[n]` serialize through a spin-lock on a global atomic.

The backward pass needs no extra normalizer pass. The forward pass already produced LSE, so `S = exp(A − LSE)` can be computed independently for each tile. The kernel recomputes `A` tile by tile and forms `G = S − onehot(x)`, the gradient with respect to the logits. It then does two matmuls with locked atomic adds: `∇E += G·C` and `∇C += Gᵀ·E`.

## Gradient filtering: the part that makes it fast

Done naively, every tile runs two extra matmuls plus locked read-modify-writes to HBM. In Table 1, CCE without filtering takes 314 ms for the gradient, against 92 ms for `torch.compile`.

The fix: a softmax row sums to 1, and bf16 carries 7 fraction bits. So entries below ε = 2⁻¹² barely change any sum they are added to. By pigeonhole, at most 1/ε = 4,096 entries per row can clear ε. The source sets `filter_eps = torch.finfo(bf16).eps / 32`, which is 2⁻⁷/2⁵ = 2⁻¹². A tile is skipped when every entry satisfies `|G| < ε`:

```python
d_accum = tl.exp(accum - lse[:, None])
d_accum += tl.where(is_target, -1.0, 0.0)        # G = S − onehot
if _block_is_filtered(tl.abs(d_accum), filter_eps):
    return                                        # no matmuls, no atomics
```

The test runs on `|S − onehot|`, not on `S`. A tile that contains any token's target column therefore always survives, unless the model gave that target more than 1 − 2⁻¹² probability.

The paper says fewer than 0.02% of softmax entries are non-trivial in the frontier models it tested. But the kernel skips **tiles**, not elements. A 128×128 tile survives if any of its 16,384 entries is non-trivial. Here is what I measured on Qwen2.5-0.5B, using bf16 logits, technical prose from this blog, and a mean loss of 3.52 nats:

```
entries with p ≥ 2⁻¹²:       0.125%   (mean 190 per row, max 757; the cap is 4,096)
rank where mean p < 2⁻¹²:    187      (paper: ~50 for Gemma 2)

128×128 tiles that must be computed:
  natural vocab order         60.9%   (tiles forced by a target alone: 4.7%)
  sorted by average logit     49.3%   (3.5%)
  random vocab permutation    99.1%   (7.5%)
```

The random-permutation row shows why order matters. Spread uniformly, a 128-token block's ~24,000 non-trivial entries would hit nearly all 1,187 vocab tiles. Filtering works only because tokens share most of their high-probability support: punctuation, whitespace, common subwords.

The natural order already gets most of that benefit. BPE assigns ids in roughly merge order, so frequent tokens sit together at low ids. That explains why the paper's "no vocab sorting" ablation is only 15% slower. Sorting by average logit (`torch.argsort(logit_avg)` in `cce.py`) takes my keep rate from 61% to 49%.

## How the speedup depends on model confidence

A model that is more confident has fewer non-trivial entries. I emulated that by scaling my logits down with a temperature (sorted order, 128×128 tiles):

```
temperature   element density   tiles kept
1.0           0.125%            49.3%
0.75          0.055%            36.0%
0.5           0.017%            21.0%
0.35          0.007%            13.0%
```

The paper's Table 1 timings let me back out its keep rate. Assume the backward pass always pays for recomputing the logits (about the 46 ms forward time), plus a fraction *k* of the unfiltered remainder (314 − 46 = 268 ms):

```
sorted:    100 ms = 46 + k·268  →  k ≈ 20%
unsorted:  115 ms = 46 + k·268  →  k ≈ 26%    (ratio 0.78; mine: 49.3/60.9 = 0.81)
```

The cost model is rough, but it agrees from two directions. At the paper's stated density (<0.02%), my temperature-0.5 row keeps 21% of tiles, against the ~20% the timings imply, and the sorted/unsorted ratios match (0.78 vs 0.81).

It also gives a prediction the paper doesn't spell out. At my untempered 49% keep rate, the same model puts the CCE gradient near 46 + 0.49·268 ≈ 177 ms. That is slower than `torch.compile`'s 92 ms. The memory win doesn't depend on the data. The speed advantage depends on how peaked the model's predictions are: an instruct model fine-tuned on Alpaca is close to the best case, and a small base model reading unfamiliar text is not.

## What filtering costs in accuracy

On the same 4,096 tokens, I compared filtered and exact fp32 gradients, using sorted order and 128×128 tiles:

```
∇E relative error from filtering:      3.1e-3
∇E error from rounding G to bf16:      1.35e-3   (reference point)
∇C relative error from filtering:      7.7e-4
vocab rows whose ∇C is exactly zero:   10.0%    (<0.001% of ‖∇C‖², median row norm 100× smaller)
```

The error on ∇E is the same order as bf16 rounding, though about 2.3× larger. That fits the paper's result that fine-tuning loss curves can't be told apart from the baseline.

The ∇C numbers explain the paper's pretraining result. On every step, filtering silently zeroes the gradient for the long tail of the vocabulary. Each of those dropped gradients is tiny, but it always does the same thing: it pushes down the logits of tokens the model wrongly gives a little probability. If those updates never arrive, rare-token rows of C go unregularized for the whole run. The authors saw validation perplexity get worse in pretraining. They fixed it with **CCE-Kahan-FullC**: no filtering on ∇C, and Kahan-compensated summation for the bf16 atomics. In Table 1 that costs 313 ms against 145 ms for loss plus gradient. It still uses 2.3 GB instead of 28 GB.

## Takeaways

- **Memory is the reliable win.** CCE lands within 3 MiB of the unavoidable gradient buffers and grows as O(N + |V|).
- **Element sparsity says little about the speedup; tile sparsity decides it.** Measure the tile keep rate on your own model and data before counting on the 3.5× backward speedup. Under 25% kept is the paper's regime. Around 50% kept means CCE is roughly break-even with or slower than a fused `torch.compile` loss.
- **Vocabulary order is a performance parameter.** A randomly permuted vocabulary (from hashing or merged tokenizers) gives up nearly all of the filtering benefit.
- **Filter ∇E, not ∇C, when pretraining.** Zeroing 10% of classifier rows every step is harmless for a short fine-tune and harmful over a trillion tokens.
