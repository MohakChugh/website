---
title: "Titans: Neural Memory That Learns to Memorize at Test Time"
date: 2026-07-19
tags: [transformers, long-context, sequence-models, attention, llm-architecture]
excerpt: "Attention is precise but quadratic; recurrent state is cheap but forgetful. Titans adds a third component — a neural memory module that runs gradient descent on itself during inference, storing what surprises it and forgetting the rest — and scales past 2M-token context windows."
---

Every long-context architecture is a compromise between two failure modes. Softmax attention keeps a perfect, lossless record of every token it has seen, but paying for it costs quadratic compute and a KV cache that grows without bound. Linear recurrences — Mamba, RWKV, linear attention — compress the past into a fixed-size state, so they run in linear time with constant memory, but that fixed state is a bottleneck: information from 100K tokens ago has to survive being repeatedly overwritten by everything since.

[Titans](https://arxiv.org/abs/2501.00663) (Behrouz, Zhong, Mirrokni; Google Research, Dec 2024) proposes a third thing entirely. Instead of storing the past as a KV cache (attention) or as a compressed vector state (recurrence), it stores the past **in the weights of a small neural network** — and it trains those weights *during inference*, one token at a time. The memory literally learns as it reads.

## Memory as an associative loss

The core object is a neural long-term memory module `M`, typically a small MLP. It maps keys to values, exactly like an associative dictionary, except the mapping lives in learned parameters rather than a lookup table.

For each incoming token `x_t`, the model forms a key and value by linear projection:

```
k_t = x_t · W_K
v_t = x_t · W_V
```

Memorizing this token means making `M` reproduce the association — given `k_t`, output `v_t`. That is just a regression loss:

```
ℓ(M_{t-1}; x_t) = || M_{t-1}(k_t) − v_t ||²
```

Here is the pivotal move: `W_K` and `W_V` are ordinary model parameters learned at training time (the "outer loop"), but the parameters *inside* `M` are updated at **test time** by descending this loss (the "inner loop"). The forward pass of the sequence model *is* a training loop for the memory network. Each token is one gradient step.

## Surprise as the gradient

What should the memory bother to store? Titans borrows the intuition from human memory that we remember what violates our expectations. It makes this literal: the **surprise** of a token is the gradient of the associative loss with respect to the memory.

```
M_t = M_{t-1} − θ_t · ∇ℓ(M_{t-1}; x_t)
                     └──── surprise ────┘
```

A token the memory already predicts well produces a near-zero gradient — no surprise, no update. A token that violates the current associations produces a large gradient and shifts the weights hard. The memory spends its capacity on what it did not already know.

But pure gradient descent has a well-known pathology: after one big surprising event, the gradient at the next few tokens can go flat, and the model stops absorbing the tokens that immediately follow — precisely the ones that explain the surprise. Titans fixes this the same way optimizers do, with **momentum**. It splits surprise into a decaying memory of *past* surprise plus the *momentary* surprise of the current token:

```
S_t = η_t · S_{t-1}  −  θ_t · ∇ℓ(M_{t-1}; x_t)
      └ past surprise ┘   └ momentary surprise ┘
M_t = M_{t-1} + S_t
```

`S_t` is a momentum term. `η_t` is a data-dependent decay controlling how long a surprising event keeps influencing subsequent updates — `η_t → 0` forgets the last surprise immediately, `η_t → 1` lets it flow forward. Both `η_t` and the learning rate `θ_t` are produced from the input, so the memory decides *per token* how fast to learn and how long to stay surprised.

## Forgetting is weight decay

A fixed-size neural memory will eventually saturate. It needs to forget. Titans adds an adaptive gate `α_t ∈ [0, 1]` that decays the existing weights before applying the update:

```
M_t = (1 − α_t) · M_{t-1}  +  S_t
```

When `α_t → 0` the memory is preserved and simply updated; when `α_t → 1` it is wiped clean. The paper points out this is exactly the **forgetting gate** of a modern gated recurrent model — but applied to the *weights of a network* rather than to a state vector. That reframing is the whole trick: gating, momentum, and learning rate are the familiar machinery of optimization, repurposed as a sequence-modeling mechanism.

Retrieval, by contrast, involves no learning at all. To read from memory you just run a forward pass with a query and take the output — no gradient step:

```
q_t = x_t · W_Q
y_t = M*(q_t)
```

## Won't test-time gradient descent be hopelessly slow?

This is the objection everyone raises. If every token requires a backward pass through `M`, the whole appeal of a linear-time model seems to evaporate.

The answer is that the inner updates are computed in **parallel over a chunk**, not sequentially per token. Titans reformulates the mini-batch gradient descent over a segment of tokens as a sequence of matrix multiplications plus a parallel associative scan (the same primitive that makes linear-attention and SSM training fast). Within a chunk the updates become matmul-friendly; across chunks the recurrence carries the memory state forward. You get training-time parallelism with inference-time recurrence — the property that made Mamba practical, now wrapped around a memory that does gradient descent on itself.

## Three ways to wire it in

A memory module is useless in isolation; it has to cooperate with attention. Titans is a family of three architectures, all combining three branches — a **core** (short-term memory via attention), the **long-term neural memory** above, and a set of **persistent** input-independent parameters `P = [p_1, …, p_Np]` that act as learned, always-present task knowledge.

**Memory as Context (MAC).** Chunk the sequence into segments. For each segment, first *query* the long-term memory to retrieve relevant history, then prepend that retrieval (plus persistent tokens) to the segment and feed the whole thing to attention:

```
h_t = M*_{t-1}(q_t)                        # retrieve history
S̃ = [p_1 … p_Np] ‖ h_t ‖ S               # persistent ‖ history ‖ current
y_t = Attn(S̃)                             # attention over the assembled context
M_t = M_{t-1}(y_t)                         # write attention output back to memory
```

Attention gets to decide what is worth writing to long-term memory. This variant is the strongest on long-dependency, needle-in-a-haystack tasks.

**Memory as Gate (MAG).** No segmentation. Run sliding-window attention as a precise short-term memory over the recent window, run the neural memory as a "fading" long-term memory over everything, and combine them with a gate:

```
y = SW-Attn*(x̃)
o = y ⊗ M(x̃)          # ⊗ is nonlinear gating
```

**Memory as Layer (MAL).** The simplest: stack the memory as a layer that compresses context, then apply attention on its output.

```
y = M(x̃)
o = SW-Attn(y)
```

MAL is easiest to implement but weakest — sequential stacking means attention and memory can't complement each other; each is capped by what the other produced. In the paper's ablations MAC and MAG both beat MAL, with MAC best on long dependencies. The ablations also rank the contributions of the mechanism itself: weight decay (forgetting) matters most, followed by momentum, convolution, and persistent memory.

## Why this matters

The headline result is that Titans scales effectively to context windows **larger than 2M tokens** with higher needle-in-a-haystack retrieval accuracy than Transformers and modern linear recurrent baselines, while keeping linear-time inference. But the more durable idea is architectural. For a decade "learning" and "inference" have been separate phases — you train, you freeze the weights, you deploy. Titans dissolves that boundary for one submodule: a slice of the network keeps doing gradient descent forever, treating the input stream as an endless training set and its own weights as the place memories live.

Deep memory helps here — the paper finds an MLP with two or more layers is meaningfully more expressive than a linear memory, because a linear associative memory is mathematically equivalent to plain linear attention, and the whole point was to escape that ceiling. The cost is real: you are running an optimizer inside your forward pass, and the chunked-parallel reformulation is what keeps it from being intractable. Whether test-time learning becomes a standard building block or stays a research curiosity, it is a clean demonstration that the line between an optimizer and a sequence model is thinner than it looks.
