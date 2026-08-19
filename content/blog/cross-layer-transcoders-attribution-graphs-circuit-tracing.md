---
title: "One Nonlinearity Left: Cross-Layer Transcoders and the Mechanics of Attribution Graphs"
date: 2026-08-19
tags: ["interpretability", "machine-learning", "transformers", "linear-algebra"]
excerpt: "Sparse autoencoders give you a dictionary of features but no mechanism. Cross-layer transcoders plus frozen attention collapse a transformer into a network with exactly one nonlinearity left, which makes a circuit an exact linear decomposition rather than a gradient approximation. I rebuilt the construction in numpy, confirmed the decomposition is exact to 1e-15, and localized where its faithfulness actually breaks."
---

Sparse autoencoders solved a labeling problem. Train one on a layer's residual stream, get a dictionary of monosemantic directions, and you can say what a model is representing at layer 14. What you still cannot say is why. A dictionary is a list of nouns with no verbs. The mechanism, the part an engineer actually wants when a model does something surprising, lives in the weights between those features, and SAEs are trained per layer with no reason for a layer 14 feature to have any legible relationship to a layer 15 one.

Anthropic's [circuit tracing methods paper](https://transformer-circuits.pub/2025/attribution-graphs/methods.html) (2025) attacks this with two ideas that compose better than either does alone: a *cross-layer transcoder* that makes features span layers by construction, and a *local replacement model* engineered so that only one nonlinearity survives. The second is the load-bearing one, and it is the reason an attribution graph is an exact decomposition rather than a first-order approximation. I rebuilt both in numpy to check that claim, and to find out where it stops holding.

## Cross-layer transcoders

A transcoder does not reconstruct its input. It reads the residual stream and predicts the *MLP output* at that layer, so its features sit in the position of a computation rather than a representation. A cross-layer transcoder (CLT) goes further: a feature encoded at layer `ℓ` writes into every MLP output at layer `ℓ` and above.

```
a^ℓ  = JumpReLU(W_enc^ℓ · x^ℓ)                    encode from residual stream at ℓ
ŷ^ℓ  = Σ_{ℓ'=1..ℓ} W_dec^{ℓ'→ℓ} · a^{ℓ'}          layer ℓ's MLP output, written by all earlier features
```

The loss is reconstruction plus a sparsity term with a specific shape:

```
L = Σ_ℓ ||ŷ^ℓ − y^ℓ||²  +  λ Σ_ℓ Σ_i tanh(c · ||W_dec,i^ℓ|| · a_i^ℓ)
```

Two details matter. The penalty is weighted by the norm of the concatenated decoder vectors, which kills the degenerate escape where the model shrinks activations and inflates decoders to keep the same output at lower nominal L0. And it is a `tanh` rather than an L1, so the marginal cost of an already large activation goes to zero, which penalizes *having* a feature on rather than having it on strongly.

The payoff is measured, not aesthetic. On an 18 layer model with 10M features the CLT reaches 11.5% normalized reconstruction error at L0 = 88; on Claude 3.5 Haiku with 30M features, 21.7% at L0 = 235. More interesting is graph shape: mean path length drops from 3.7 for per-layer transcoders to 2.3, and the replacement score, the strength-weighted fraction of embedding to logit paths that stay entirely inside features, goes from 0.37 to 0.61. Same feature budget, mechanisms half as deep and two thirds more likely to be fully explained.

The cost is quadratic and worth stating plainly, because the paper does not: a feature at layer `ℓ` needs `L − ℓ + 1` decoder vectors, so total decoder parameters scale as `L(L+1)/2` against a per-layer transcoder's `L`. That is a factor of `(L+1)/2`, which is 9x at 17 layers, 16.5x at 32, and 32.5x at 64. Cross-layer features are not free lunch, they are a decoder parameter budget traded for shallower graphs, and the trade gets worse linearly with depth.

## Removing every nonlinearity but one

Here is the part I wanted to verify. The *local replacement model* is built per prompt and does three things: substitute CLT outputs for MLP outputs, reuse the base model's attention patterns and normalization denominators as constants, and add a per (token, layer) *error node* holding exactly whatever the CLT failed to reconstruct.

With attention frozen there are no QK nonlinearities, with denominators frozen no normalization nonlinearity, and with error nodes the reconstruction gap becomes a constant bias rather than an approximation. The only nonlinearity left in the entire network is the JumpReLU on feature preactivations. Everything else is one big linear map across token positions.

That makes the virtual weight between two features computable in closed form: sum the source feature's decoder vectors over every layer between the two, then dot into the target's encoder, with the frozen normalization scale folded in.

```python
def virtual_weight(ls, i, lt, it):
    """Weight from feature i at layer ls into feature it at layer lt (lt > ls)."""
    v = sum(W_dec[ls, l, i] for l in range(ls, lt))   # decoders writing before lt
    return float(v @ (norm_scale[lt] * W_enc[lt, it]))  # frozen scale folded into encoder

def forward(scales=None):
    a, h, x = np.zeros((L, N)), np.zeros((L, N)), emb.copy()
    for l in range(L):
        s = np.sqrt(d) / np.linalg.norm(x)              # live RMSNorm scale
        h[l] = W_enc[l] @ ((scales[l] if scales is not None else s) * x)
        a[l] = np.where(h[l] > theta, h[l], 0.0)        # JumpReLU
        x = x + sum(W_dec[ls, l].T @ a[ls] for ls in range(l + 1))
    return a, h
```

I built an 8 layer, 96 feature per layer toy CLT and checked the two claims that the whole method rests on. First, that freezing the normalization denominators at their observed values reproduces the base run exactly: `max|Δh| = 0.00e+00`, as it must, since the frozen constants are the ones the live pass computed. Second, and less obviously, that every preactivation decomposes *exactly* into its incoming edges, `h_t = Σ_s a_s · w(s→t)` plus the embedding edge. Across the graph the worst residual was `1.11e-15`, which is float64 rounding. This is the property that separates attribution graphs from gradient saliency: there is no linearization error to bound, because within the local replacement model the decomposition is an identity.

## Pruning, and why the influence series is exact

A prompt lights up roughly 100 features per position and yields millions of edges, so graphs are pruned by indirect logit influence. Take the adjacency `A` with edge weights made unsigned and each node's input edges normalized to sum to 1, then total influence over all path lengths is the Neumann series `B = A + A² + A³ + … = (I − A)^{-1} − I`.

That inverse is usually where you start worrying about spectral radius. You do not need to. Edges only ever run from earlier layers to later ones, so `A` is strictly lower triangular under a topological order, which makes it nilpotent. In my toy graph of 306 active nodes, `ρ(A) = 0` and `A^k = 0` at exactly `k = L`. The series is a finite sum with `L` terms, the inverse is exact, and truncating at path length `k` is a deliberate choice about mechanism depth, not a numerical compromise. The published pruning tradeoff is steep but usable: dropping the influence threshold from 0.95 to the default 0.8 takes a graph from 236 nodes to 55 while completeness falls from 0.87 to 0.70.

## Where faithfulness actually breaks

The exactness above holds for the *unperturbed* prompt. The moment you intervene, suppressing a feature by flipping its activation sign, the graph's prediction and the model's behavior diverge, and the paper reports roughly 0.8 cosine similarity one layer downstream degrading further out. I wanted to know which of the three approximations is responsible, so I suppressed a layer 1 feature and compared the graph's predicted change in downstream preactivations against ground truth, once with live normalization and once with it frozen.

```
layers downstream    cos(pred, true)   nMSE      cos(pred, frozen-norm)   nMSE
        +1                0.997        0.006             1.000            0.000
        +2                0.796        0.370             0.808            0.350
        +4                0.647        0.644             0.670            0.601
        +6                0.483        0.772             0.517            0.736
```

At one layer downstream the prediction is exact under frozen normalization, and the entire 0.006 error is denominator drift. From two layers out the two columns are nearly identical: 0.350 against 0.370 nMSE, so about 95% of the error is *not* the frozen normalization. It is JumpReLU gate flips. Roughly 20 of 96 features per layer crossed their threshold under the intervention, and each flip is a discontinuity the linear graph cannot express by construction.

That reframes the limitation usefully. The frozen normalization denominators are cheap and nearly harmless. The freezing that costs you is the one you cannot avoid: the gates themselves. A circuit is a valid explanation of the model's behavior on the prompt you traced, and its predictive power under intervention decays with the number of intervening gates, not with the number of frozen constants. My toy has no attention, so it cannot see the third error source, frozen QK circuits, which the paper flags separately: attribution graphs capture OV circuits and therefore show what information moved between positions, never why the model chose to move it.

Read this way, the method is less an interpretability curiosity and more a familiar systems pattern. Replace a component with a cheaper model, keep an explicit residual term for the part you failed to capture, and report a completeness score, the fraction of influence flowing through features rather than error nodes, so consumers know how much of the trace is real. That last habit is the transferable one. An explanation that reports its own unexplained fraction is worth more than one that does not, in circuits and in production.
