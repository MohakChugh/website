---
title: "Constrained Decoding: How to Force an LLM to Speak Valid JSON Without Slowing It Down"
date: "2026-07-17"
tags: ["llm", "inference", "structured-output", "automata", "systems"]
excerpt: "Prompting a model to 'return valid JSON' is a wish, not a guarantee. Constrained decoding turns it into an invariant by masking logits against a finite-state machine or pushdown automaton. The hard part is doing it without adding latency to every single token, which is where compiled indices and context-token classification come in."
---

If you have shipped anything that parses LLM output, you know the failure mode: the model returns JSON that is 99% correct, with a trailing comma, an unescaped quote, or a chatty `Sure, here's your JSON:` prefix. Retry loops and `try/except json.loads` are the industry's duct tape. They work until they don't, and they waste tokens and latency doing it.

**Constrained decoding** removes the guesswork by making malformed output *impossible to sample*. Instead of asking the model to behave, you intersect its output distribution with a formal language at every decoding step. If a token would break the grammar, its probability is set to zero before sampling. The model literally cannot emit an invalid character.

The idea is old — it's just masking logits. The interesting engineering is doing it at production throughput, because a naive implementation adds work proportional to your vocabulary size on *every generated token*. This post walks from the naive version to what systems like Outlines and XGrammar actually do.

## The decoding loop, and where the constraint lives

Autoregressive generation is a loop. At each step the model produces a logit vector over the vocabulary `V` (typically 32k–150k entries), you apply softmax, and you sample:

```python
for _ in range(max_tokens):
    logits = model(tokens)          # shape [vocab_size]
    probs = softmax(logits)
    next_tok = sample(probs)
    tokens.append(next_tok)
```

Constrained decoding inserts exactly one line: a **mask** that zeroes out every token not permitted by the constraint in the current state.

```python
for _ in range(max_tokens):
    logits = model(tokens)
    mask = allowed_token_mask(state)     # boolean [vocab_size]
    logits[~mask] = float("-inf")        # forbidden tokens can't be sampled
    next_tok = sample(softmax(logits))
    tokens.append(next_tok)
    state = advance(state, next_tok)
```

Everything hard about this technique is hidden in `allowed_token_mask(state)` and `advance(state, ...)`. The naive implementation of `allowed_token_mask` loops over all of `V`, appends each token's string to the output-so-far, and re-parses. That is `O(|V| × parse_cost)` per step — hundreds of thousands of parses per token. Completely unusable in serving.

## Regular constraints: compile the regex to an FSM

The first real technique, introduced by Willard and Louf in *Efficient Guided Generation for Large Language Models* (arXiv:2307.09702, the basis of the **Outlines** library), handles any constraint expressible as a regular expression — which covers a surprising amount: number formats, enums, dates, phone numbers, and (with care) a large JSON subset.

A regex describes a regular language, and every regular language has an equivalent **deterministic finite automaton** (DFA). The DFA is a set of states with labeled transitions; a string matches the regex iff it walks a path from the start state to an accepting state. So the constraint state is just "which DFA state am I in," and `advance` is a single table lookup.

The clever part is `allowed_token_mask`. The DFA transitions on *characters*, but the model emits *tokens* — multi-character byte strings from BPE. The key insight is to **precompute, for every DFA state, the set of vocabulary tokens that keep you inside the machine**, once, before generation starts:

```python
# Preprocessing (once per schema, ~milliseconds to seconds)
# For each FSM state, which whole tokens can we consume from here?
index = {}                                  # state -> {token_id: next_state}
for state in fsm.states:
    for token_id, token_str in vocab.items():
        s = state
        ok = True
        for ch in token_str:                # walk the token char by char
            s = fsm.step(s, ch)
            if s is None:                    # token would break the pattern
                ok = False
                break
        if ok:
            index[state].setdefault(token_id, s)
```

At runtime the whole mask computation collapses to a dictionary lookup: `index[state]` gives you both the allowed token IDs *and* the state each one leads to. That is the `O(1)`-per-step claim — the per-token cost during generation is independent of vocabulary size. All the expense is paid once, at compile time, and amortized across every request that reuses the schema.

Two subtleties bite in practice:

- **Tokenization ambiguity.** A token may partially match — it walks halfway through the pattern and lands mid-transition. You have to track those partial states, not just accepting ones, or you'll wrongly forbid legal continuations.
- **Byte-level vs character-level.** Modern tokenizers operate on UTF-8 bytes. A single Unicode character can span multiple tokens, and a single token can straddle a character boundary. The FSM has to be defined over bytes to be correct, which complicates the transition alphabet.

## Structured constraints need more than a DFA

Regular languages can't count nesting. JSON, code, and most agent-command formats are **context-free**: `{"a": {"b": {"c": 1}}}` requires matching an arbitrary number of open braces to close braces, and no finite-state machine can do that — it has no memory of how deep it is.

The right abstraction is a **pushdown automaton (PDA)**: an FSM plus a stack. You push when you open a structure, pop when you close it, and acceptance requires an empty stack at the end. A context-free grammar (CFG) compiles to a PDA the way a regex compiles to a DFA.

```
# A CFG fragment for JSON objects (EBNF-ish)
object  ::= "{" (pair ("," pair)*)? "}"
pair    ::= string ":" value
value   ::= object | array | string | number | "true" | "false" | "null"
```

The problem: the precomputed index trick breaks. Whether a token like `}` is legal now depends on the **stack contents**, not just the current state. You can't fully precompute `allowed_token_mask` because the number of reachable stack configurations is unbounded. This is exactly why generic CFG-constrained decoding was historically slow — you're back to per-token stack traversal across the vocabulary.

## XGrammar: split the vocabulary into two kinds of tokens

*XGrammar* (arXiv:2411.15100, MLSys 2025) is the current state of the art for fast CFG-constrained generation, and its central move is a clean observation: **most tokens don't care about the stack.**

It classifies every vocabulary token, per grammar, into two buckets:

- **Context-independent tokens** — tokens whose validity depends only on the current PDA *state*, not on what's below it on the stack. Whether the literal characters of a string body or a number are legal usually doesn't depend on nesting depth. These can be resolved with the exact same precomputed-index approach as the regex case. Empirically this is the large majority of the vocabulary.
- **Context-dependent tokens** — a small set (things like closing brackets, or tokens that could end one structure and continue another) whose legality genuinely requires inspecting the stack. These are the only tokens checked at runtime.

So the per-step mask is: look up the context-independent verdict from the cache (free), then run the actual PDA only for the handful of context-dependent tokens (cheap). XGrammar accelerates that residual check with a **persistent stack** — a structure that shares common prefixes across the many stack states you explore during a step, so branching is cheap and you avoid deep copies.

The other half of the win is systems co-design. Grammar mask computation runs on the CPU; token generation runs on the GPU. XGrammar overlaps the two: while the GPU computes logits for step *t*, the CPU is already preparing the mask for step *t+1*. Done right, the grammar work disappears entirely behind GPU execution.

The reported result is up to **100× faster** mask generation than prior CFG-constrained approaches, and when integrated into an inference engine, **near-zero end-to-end overhead** — structured output for roughly the price of unstructured.

```python
# The two-tier check, conceptually
def allowed_token_mask(state, stack):
    mask = context_independent_cache[state]      # precomputed, O(1)
    for tok in context_dependent_tokens[state]:  # small set, runtime check
        if pda_accepts(state, stack, tok):
            mask.add(tok)
    return mask
```

## What this does and does not buy you

Constrained decoding guarantees **syntactic** validity: the output will parse, will match your JSON Schema's shape, will be a member of your enum. That is a real, hard guarantee — no retry loop achieves it.

It does **not** guarantee **semantic** correctness. If you constrain a field to an integer, you get *an* integer, not the *right* integer. Worse, aggressive constraints can degrade quality: by zeroing out tokens the model wanted, you can push it onto a low-probability path and get confidently wrong content, or interact badly with reasoning that "wants" to emit prose before the structured answer. The pragmatic pattern is to let the model reason freely, then constrain only the final structured span.

There's also a subtle interaction with the tokenizer worth internalizing: the constraint operates on the model's *token* boundaries, but your schema is defined over *characters*. When a single legal character is only reachable via a token that also contains illegal characters, correctness depends entirely on getting the byte-level partial-match logic right. This is the class of bug that makes a constrained decoder "mostly work" and then mangle emoji, or non-ASCII names, or floats in scientific notation.

The takeaway for anyone building on LLMs: "return valid JSON" should not be a prompt. It should be a property of your decoding loop, enforced by an automaton, compiled once, and masked in for free on every token. The research has made it cheap enough that there's little reason left to parse-and-pray.
