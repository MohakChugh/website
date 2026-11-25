---
title: "Exact BPE in Linear Time, Audited: Pair Compatibility Holds on cl100k, 97% of Token Pairs Are Compatible (Not 5%), and Each Position Is Scanned At Most Once"
date: 2026-11-25
tags: [tokenization, bpe, llm-inference, algorithms, string-algorithms]
excerpt: "GitHub's bpe crate encodes text into byte-pair tokens exactly, in linear time, by checking only whether each new token is compatible with the one before it. I re-implemented the backtracking encoder against the real cl100k vocabulary. It matched reference BPE on every sample, and 0 of 8,000 random pairwise-compatible token chains failed to round-trip. Two of the README's numbers do not survive. 96.97% ± 0.03% of cl100k's 10 billion token pairs are compatible, about 9.75B, against the stated 'roughly 500 million'. Overlapping matches are 2.84 per byte on my corpus, against 3.5. I also prove a bound the README does not state: each input position is scanned at most once, so the worst case is O(n·L)."
---

BPE is easy to define and awkward to compute: start from bytes and repeatedly merge the adjacent pair whose concatenation has the lowest rank. Done naively, that is O(n²). tiktoken splits input with a regex first, but each chunk is still quadratic, and the split changes the output.

GitHub's [`bpe` crate](https://github.com/github/rust-gems/tree/main/crates/bpe) encodes in linear time, produces exactly the tokens of unsplit BPE, and counts tokens incrementally while text is appended. I tested its README's structural claims and numbers against the real cl100k vocabulary (100,256 tokens, the longest 128 bytes) and against a 4,096-token BPE I trained on 1.2 MB of this blog.

## The structural idea: validity is a property of adjacent pairs

Call a token sequence **valid** if decoding it to bytes and re-encoding with BPE gives the same sequence. The README's corollaries:

- Every byte string has exactly one valid encoding.
- Every contiguous subsequence of a valid sequence is valid.
- Appending a token to a valid sequence yields a valid sequence **iff** the new token is *compatible* with the last one, meaning `bpe(a ‖ b) == [a, b]`.

The third claim is what makes the encoder possible. Pairwise checks between neighbors are enough to prove the whole sequence valid; you never re-encode it. A pair can be incompatible because some lower-ranked token straddles the boundary. In cl100k, `ixin` + `g` is incompatible: BPE merges `ing` early, so `ixing` encodes as `ix|ing`.

## The backtracking encoder

Take the longest token that matches at the current position. If it is compatible with the previous token, and its end position has not been marked as a dead end, accept it. Otherwise try the next-shorter matching token. When no candidates remain, mark the position dead and pop the previous token, resuming with *its* remaining shorter alternatives.

```python
def encode_backtrack(self, data):
    n = len(data)
    dead = bytearray(n + 1)            # positions proven to have no valid continuation
    toks, alts = [], []                # alts[i]: untried shorter candidates for toks[i]
    pos, cands = 0, self.prefixes(data, 0)   # all tokens matching at pos, longest first
    while pos < n:
        last = toks[-1] if toks else None
        while cands:
            t = cands.pop(0)
            end = pos + len(t)
            if not dead[end] and (last is None or self.compatible(last, t)):
                toks.append(t); alts.append(cands); pos = end
                cands = self.prefixes(data, pos)
                break
        else:                           # nothing fits: this position is a dead end
            dead[pos] = 1
            t = toks.pop(); cands = alts.pop(); pos -= len(t)
    return toks

def compatible(self, a, b):           # cached; the crate does this in <=14 lookups
    return self.encode_ref(a + b) == [a, b]
```

`prefixes` walks a byte trie, and `encode_ref` is textbook rank-ordered BPE. On the 4,096-token vocabulary, splitting merges by training pair and splitting by concatenation rank (tiktoken's rule) gave identical output on all 1,500 samples. As a check on the reference itself, my regex-split version of `encode_ref` matched `tiktoken.encode` on all 591 test strings.

## Correctness: no counterexample found

| Check | 4,096-token BPE | cl100k |
|---|---|---|
| Backtracking == reference BPE (held-out text, 1–400 B) | 1,500 / 1,500 | 591 / 591 |
| Random token chains, each step compatible, that **fail** to round-trip | 0 / 6,000 | 0 / 2,000 |
| Tokens whose own bytes don't encode to themselves | — | 0 |

The chain test targets the corollary directly. It builds 3–21-token sequences from random vocabulary entries, extending each only through compatible pairs. Half use only tokens of three bytes or fewer, to maximize cross-boundary interaction. Every sequence re-encoded to itself. This is evidence, not proof, but of exactly the property the encoder relies on.

## Two README numbers that don't reproduce

**Compatible pairs.** The README says that to precompute a compatibility table, "already 10 billion possible pairs have to be tested to find the roughly 500 million valid pairings." I sampled 1,000,000 uniformly random cl100k pairs:

| | Value |
|---|---|
| Compatible fraction | 96.97% ± 0.03% (95% CI) |
| Implied compatible pairs, of 1.005 × 10¹⁰ | **9.75 × 10⁹** |
| Implied incompatible pairs | **3.05 × 10⁸** |

The README's ~500 million is closer to the *incompatible* count, which suggests "valid" and "invalid" were swapped. The 1.2 GB figure is unaffected, since a dense bitfield over 10¹⁰ pairs costs 1.25 GB however its bits are set. But a sparse table should store the ~300M exceptions, and a random check succeeds about 97% of the time. My 4,096-token vocabulary gives 97.06%.

**Overlapping matches.** The README reports "about 3.5 overlapping tokens per input position" for cl100k. On this blog's markdown I measure 2.84, against 2.23 for the 4,096-token vocabulary. This depends on the corpus, but Aho-Corasick-based designs scale with it.

The candidate counts do agree. The README says the dynamic-programming encoder evaluates "about 1.3 candidates for each position". My backtracking encoder averages 1.21 tries per emitted token on cl100k, 0.30 compatibility checks per byte, and 0.018 backtracks per byte, at 3.85 bytes per token.

## A bound the README doesn't state: each position is entered once

The README warns that the backtracking encoder may rescan at every byte in the worst case. Candidate tries can repeat, but `prefixes()`, the trie walk, runs at most once per input position:

1. The token list only grows by compatible appends. By the corollary, it is always *the* valid encoding of `data[:pos]`.
2. Reaching `p` by an append therefore always reaches it with the same, unique token list.
3. After reaching `p`, the encoder either moves forward or pops the token ending at `p`. It pops only after marking `p` dead, and a dead position never accepts another token ending there. Returning to `p` by popping a *later* token resumes that token's stored alternatives without rescanning.

So trie scans per byte are ≤ 1, backtracks are ≤ n because each one sets a distinct dead bit, and candidate tries are bounded by the total number of overlapping matches, ≤ n·L. That gives O(n·L) with L = 128 for cl100k, which is linear with an explicit constant. Measured against adversarial inputs:

| Input (cl100k) | tries/B | backtracks/B | trie scans/B |
|---|---|---|---|
| Blog markdown | 0.304 | 0.016 | 0.270 |
| `1234567890` repeated | 1.198 | 0.200 | 0.600 |
| `ab` repeated | 2.498 | 0.500 | **1.000** |
| Hill-climbed 48-byte unit, ×20 / ×80 / ×320 | 2.675 / 2.684 / 2.687 | 0.52 | 0.98 |
| `=` × 4000 | 4.941 | 0.248 | 0.264 |

The `ab` row hits the scan bound exactly, with a backtrack every other byte. I hill-climbed a 48-byte unit over the bytes `aeinrst .` (3,000 mutations) to maximize tries per byte. The resulting cost stays flat from 960 to 15,360 bytes, so the work is linear. The `=` row is the most expensive: cl100k has 20 tokens made only of `=` (lengths 1–16, 32, 48, 64, 80). Every position in a run therefore matches up to 20 candidates, and the encoder tries about 313 per emitted token. That is the L-factor in practice, and it is why the crate's constant-time compatibility check matters.

## Why "close enough" encoders aren't

**Greedy longest-match** is the obvious shortcut. On cl100k it disagreed with BPE on 438 of 600 samples (73%), yet its total token count differed by exactly one token out of 30,154. As a chunk-size estimate it is excellent. As an encoder for a model trained on BPE it is wrong almost every time. Examples: `ixing` → BPE `ix|ing`, greedy `ixin|g`; `wenty` → `w|enty` against `went|y`.

**Regex pre-tokenization**, tiktoken's own split, changed the token sequence on 179 of 591 samples (30%) and added 0.12% tokens. The crate's no-split encoder and tiktoken therefore legitimately disagree.

## Appending text: counts go down, and rewrites stay shallow

Streaming token counts are non-monotone. Over 17,940 single-byte appends on cl100k, the count *fell* 7.85% of the time, by up to 3 tokens. The more useful statistic for incremental encoders is how many previously emitted tokens an append rewrites:

| Old tokens rewritten | 0 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| Share of appends | 28.69% | 62.24% | 8.35% | 0.68% | 0.039% |

Most rewrites just extend the last token (`' to'` → `' tok'`), and no append reached back more than four tokens. The crate's appendable encoder needs no rewrites at all: it stores only the last token per prefix, which by uniqueness determines the whole encoding.

## Takeaways

- The compatibility argument holds: no counterexample in 8,000 chains or 2,091 encodings across two vocabularies.
- The README's pair count is inverted: 97% of cl100k pairs are compatible, and about 305M are not.
- Worst case is O(n·L): trie scans ≤ 1 per byte, and 2.7–4.9 candidate tries per byte on adversarial input.
- Greedy is within 0.003% on *counts*, but if you need the actual *tokens*, use exact BPE, which this algorithm makes about as cheap as the shortcut.
