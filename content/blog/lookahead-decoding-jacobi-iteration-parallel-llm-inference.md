---
title: "Lookahead Decoding: Breaking the Sequential Barrier Without a Draft Model"
date: 2026-07-24
tags: [llm-inference, parallel-decoding, jacobi-iteration, speculative-decoding, latency]
excerpt: "Autoregressive decoding forces one token per forward pass, leaving GPUs starved for work. Lookahead decoding reframes greedy generation as solving a nonlinear system by Jacobi iteration, mining n-grams from the iteration trajectory to collapse many steps into one, with no draft model and no training."
---

Every token an LLM emits costs one full forward pass. That single fact governs the latency of generation, and it is a brutal one: a 70B model reading a few hundred tokens of context still needs one memory-bandwidth-bound pass to produce token number 501, then another for 502, and so on. The arithmetic units on the GPU sit almost idle. During decode, the bottleneck is not FLOPs but the time it takes to stream the model weights from HBM into the compute units once per token.

Speculative decoding attacks this by using a small draft model to propose several tokens that the big model verifies in one pass. It works, but it demands a *second* model that is aligned with the target, plus the operational weight of serving and updating two models. **Lookahead decoding** (Fu et al., 2024) asks a sharper question: can we get parallel token generation from the target model *alone*, with no draft, no auxiliary data store, and no training? The answer turns out to be yes, and the mechanism is a clever repurposing of a classical numerical method.

## Greedy decoding is a nonlinear system

Start with the reframing. Suppose we want to generate tokens $y_1, \dots, y_m$ greedily from a prompt $x$. The standard view is sequential: $y_i = \arg\max p(\cdot \mid x, y_{1:i-1})$. But we can also write the *entire* completion as the fixed point of a system of equations:

$$
y_i = f(y_{1:i-1}, x) \quad \text{for } i = 1, \dots, m
$$

where $f$ is a single greedy step of the model. This is a system of $m$ nonlinear equations in $m$ unknowns. The sequential decode is just one way to solve it — substitute forward, one variable at a time. But there are others.

**Jacobi iteration** is the classic parallel solver for such systems. Guess all $m$ tokens at once (say, all padding), then update every position simultaneously from the current guess:

$$
y_i^{(t+1)} = f\big(y_{1:i-1}^{(t)}, x\big) \quad \text{for all } i \text{ in parallel}
$$

Each iteration is one forward pass over all $m$ positions — cheap, because decode is memory-bound and the weights are already streamed. The key property: after iteration $t$, the first $t$ tokens are *guaranteed correct*, because position $i$ conditions on the already-converged prefix. So plain Jacobi converges in at most $m$ steps, and occasionally several tokens "snap" into place at once.

In practice, plain Jacobi disappoints. Getting a token's *value* right and its *position* right at the same time almost never happens spontaneously, so most iterations advance the frontier by exactly one token — no better than sequential. The insight of lookahead decoding is that the *trajectory* of guesses across iterations is not wasted noise. It is a stream of n-grams, and some of them are correct.

## Mining n-grams from the trajectory

Track the history of guesses at each position across the last $N-1$ Jacobi steps. Reading down the trajectory gives you candidate $N$-grams — short token sequences the model kept proposing. Lookahead decoding runs two branches inside a *single* forward pass:

**The lookahead branch** advances the Jacobi frontier and generates fresh n-grams. It maintains a 2D window:
- $W$ — the **window size**, how many future positions are decoded in parallel each step.
- $N$ — the **n-gram size**, how many past Jacobi steps are stacked to assemble candidates.

With $N=4, W=5$, each step assembles 4-grams from tokens produced over the previous three iterations plus the current one. Older rows are evicted to keep the window fixed. (Note: at $N=2$, lookahead decoding degenerates back into plain Jacobi.) The harvested n-grams are stashed in a **pool** keyed by their first token.

**The verification branch** does guess-and-verify. It looks up n-grams in the pool whose first token equals the *last confirmed token*, appends up to $G$ of them to the input, and lets the same forward pass check them. A candidate n-gram is accepted up to the longest prefix that matches what the model would have generated greedily — exactly the speculative-decoding acceptance rule, but the "draft" came from the model's own iteration history rather than a separate network. Setting $G = W$ is a common default.

Because it is exact-match verification against the target's own greedy output, **the result is bit-identical to sequential greedy decoding.** No approximation, no distribution drift.

## One pass, one attention mask

The elegance is that both branches run in the same forward pass, fused by a custom attention mask. Two rules define it:

1. Lookahead-branch tokens and verification-branch tokens cannot attend to each other.
2. Within each branch, standard causal masking — a token sees only itself and earlier tokens.

```python
# Sketch of the fused lookahead + verify step (greedy).
# pool: dict mapping first_token -> list of candidate n-grams (each length N)
def lookahead_step(model, kv_cache, confirmed, la_window, pool, W, N, G):
    # 1) Assemble verification candidates from the n-gram pool.
    last = confirmed[-1]
    guesses = pool.get(last, [])[:G]          # up to G candidate n-grams

    # 2) Pack lookahead window + guesses into one input; build the block mask.
    inp, mask, la_slice, guess_slices = pack_branches(la_window, guesses)

    # 3) ONE forward pass covers advancing Jacobi AND verifying guesses.
    logits = model(inp, attention_mask=mask, past_key_values=kv_cache)
    preds  = logits.argmax(-1)

    # 4) Verify: accept the longest guess prefix matching greedy preds.
    accepted = [last]
    for gs in guess_slices:
        n = matching_prefix_len(guesses, preds, gs)   # exact-match rule
        if n > len(accepted) - 1:
            accepted = [last] + guesses_tokens(gs)[:n]

    # 5) Harvest new n-grams from the advanced lookahead trajectory.
    update_pool(pool, la_slice, preds, N)
    la_window = roll_window(la_window, preds, W, N)   # evict oldest row
    return accepted, la_window, pool
```

The whole thing composes with FlashAttention and works with a standard KV cache — the branches simply occupy extra positions that get discarded after verification.

## The scaling law that makes it pay

Per-step cost is proportional to the extra input tokens processed:

$$
\text{tokens/step} \;\propto\; W\cdot(N-1) \;+\; G\cdot(N-1)
$$

The payoff is a genuine scaling law: **for sufficiently large $N$, exponentially increasing $W$ linearly reduces the number of decoding steps.** You are trading $\log(\text{FLOPs})$ for a linear cut in sequential steps. That sounds like a terrible bargain until you remember decode is memory-bound — the extra FLOPs ride along on weight loads you were already paying for. The paper reports 7B/13B/33B models spending roughly 120×/80×/56× the FLOPs per step yet still netting 1.5×–2.3× wall-clock speedup, up to ~1.8× on MT-bench and ~4× on code completion with multi-GPU strong scaling.

The catch is balance. Inflating $W$ or $N$ alone eventually makes each step so wide that the extra tokens stop being free — you cross from memory-bound into compute-bound and the speedup collapses. The sweet spot depends on model size, GPU, and how repetitive the workload is. Code, with its boilerplate and predictable structure, produces high-quality n-grams and benefits most; open-ended chat benefits least.

## Where it fits

Lookahead decoding stakes out a distinct point in the design space. Draft-model speculation (and trained variants like EAGLE or Medusa) achieves higher acceptance rates because the draft is *learned* to match the target — but you pay in training and serving complexity. Lookahead decoding is training-free, single-model, and exact, at the cost of leaning on n-gram repetition that a learned drafter would capture more precisely.

The deeper lesson is worth internalizing: **autoregressive decoding is not inherently sequential — it is a fixed-point problem we have habitually solved sequentially.** Once you see greedy generation as a nonlinear system, the whole toolbox of parallel numerical solvers opens up, and the "wasted" intermediate iterates become a free source of speculative candidates. That reframing, more than any single speedup number, is why the idea matters.
