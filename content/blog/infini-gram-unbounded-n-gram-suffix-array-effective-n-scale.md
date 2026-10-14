---
title: "Infini-gram on 360k Tokens: The ∞-gram Ties the 5-gram Exactly, Long Matches Are a Symptom Rather Than a Cause, and Backoff Costs 1.95 Counts per Token"
date: 2026-10-14
tags: ["language-models", "suffix-arrays", "n-gram", "information-retrieval", "nlp"]
excerpt: "Infini-gram (COLM 2024) turns a suffix array into an n-gram LM with unbounded n. On trillion-token corpora it agrees with human text on 47% of tokens, against 29% for a 5-gram. I rebuilt it from scratch on this blog's own posts. At 360k tokens the ∞-gram and the 5-gram score exactly the same 16.9%, because the effective n is at most 5 for 91.5% of tokens. Even where long matches exist, the 5-gram is right just as often. The incremental backoff costs a measured 1.95 counts per token, and a two-line argument bounds it at 2."
---

# Infini-gram on 360k Tokens: The ∞-gram Ties the 5-gram Exactly, Long Matches Are a Symptom Rather Than a Cause, and Backoff Costs 1.95 Counts per Token

The usual n-gram LM has a fixed n, and its count table grows almost exponentially with n. The paper's own example is a 28 TB 5-gram table for a 1.4T-token corpus. **Infini-gram** (Liu, Min, Zettlemoyer, Choi, Hajishirzi, COLM 2024, arXiv:2401.17377) drops the table. It builds a suffix array over the tokenized corpus and answers any count query with two binary searches. That makes **n = ∞** affordable:

```
P∞(w_i | w_<i) = cnt(w_{i-n+1..i-1} w_i) / cnt(w_{i-n+1..i-1})
n = max{ n' : cnt(w_{i-n'+1..i-1}) > 0 }
```

Backoff happens only when the *denominator* is zero. The effective n therefore depends only on the context, so the result is a valid distribution without discounting. An estimate is **sparse** when exactly one next token has non-zero probability.

The headline numbers come from the Pile (about 380B tokens). The ∞-gram agrees with human-written text on 47% of tokens, against 29% for a 5-gram. The median effective n is 7 and the mean is 9.1, and more than 90% of tokens have effective n ≥ 5. Sparse estimates cover more than half of all tokens and agree 75% of the time. Interpolated with neural LMs, the ∞-gram reduces perplexity by up to 73%.

To separate the method from the corpus size, I rebuilt it on a deliberately tiny corpus: this blog's own posts, word-level tokens, with the 214 documents 171/21/22 into train/val/test with a fixed seed. That gives N = 360,109 training tokens, a 19,573-word vocabulary, and 46,956 test tokens.

## The engine is two binary searches

All suffixes that start with a pattern sit in one contiguous range of the suffix array, so a count is just `hi − lo`:

```python
import bisect

def count_range(sa, toks, q):
    """[lo, hi) of suffixes starting with q. O(|q| log N) compares."""
    m, q = len(q), tuple(q)
    key = lambda p: tuple(toks[p:p + m])
    return (bisect.bisect_left(sa, q, key=key),
            bisect.bisect_right(sa, q, key=key))
```

The next-token distribution is a histogram of `toks[sa[lo:hi] + l]`. A separator token between documents stops matches from crossing them. Prefix doubling in numpy built my suffix array in 0.7 s. RedPajama took the paper about 48 hours on 128 CPUs.

The index stores 2-byte token IDs plus `⌈log₂(2N)/8⌉`-byte pointers: 5 bytes "for 2B–500B tokens", hence 7 bytes/token. Strictly, the 5-byte range is N ∈ (2.15B, 549.7B]. At 2B tokens, 2N < 2³² and 4 bytes suffice.

## Backoff is matching statistics, and costs at most 2 counts per token

The paper notes that the effective n grows by at most one per step, so it never has to be re-derived from the full prefix. This is the matching-statistics recurrence:

```python
l = 0
for i in range(len(x)):
    l = min(l + 1, i)
    while l > 0 and empty(count_range(sa, toks, x[i - l:i])):
        l -= 1                      # each failed count shrinks l by one
    # effective n at position i is l + 1
```

The paper calls this amortized O(log N) per token. The constant is easy to pin down. Each position makes one successful count, and every failed count decrements l. l rises by at most 1 per position and never goes below 0, so there are at most L failures. **The loop does at most 2L counts.** Measured:

| strategy | counts per token |
|---|---|
| restart from full prefix, linear backoff | 1,081 |
| binary-lifting search over n | 11.1 |
| incremental (above) | **1.95** |

It stayed between 1.87 and 1.95 at every corpus size I tried.

## Result 1: at 360k tokens, the ∞-gram *is* the 5-gram

I scored agreement by argmax, which the paper says is slightly stricter than its P > 0.5 criterion.

| model | agreement |
|---|---|
| 2-gram | 14.7% |
| 3-gram | 16.8% |
| 5-gram | 16.9% |
| ∞-gram | **16.9%** |

The difference was +0.0000 on the full split and between −0.0002 and 0.0000 on every subsample. The cause is not a bug. The median effective n is 3 (mean 3.15), and only 8.5% of tokens reach n ≥ 5, against more than 90% in the paper. Whenever effective n ≤ 5, the 5-gram uses the same context and is the same model. That covers 91.5% of my test tokens.

Scaling the training set shows which way it is moving:

| train tokens | mean eff. n | eff. n > 5 | sparse | ∞-gram agreement |
|---|---|---|---|---|
| 43.8k | 2.63 | 2.0% | 18.9% | 13.8% |
| 86.3k | 2.79 | 2.4% | 20.3% | 14.7% |
| 178.6k | 2.97 | 3.0% | 20.6% | 15.9% |
| 360.1k | 3.15 | 3.7% | 21.7% | 16.9% |

Mean effective n grows by about 0.17 per doubling. The Pile is about 20 doublings beyond my corpus, and its mean of 9.1 implies about 0.30 per doubling, counted in subword tokens, which are shorter than my words. The two slopes are the same order of magnitude. That is a sanity check, not a scaling law, but it supports one reading: **the "∞" is a data-scale knob, not an algorithmic one.** Without the scale you pay for a suffix array and get a 5-gram.

## Result 2: long matches predict well, but not *because* they are long

The paper's middle plot of Figure 3 shows agreement rising with effective n, to more than 75% at n ≥ 16. My corpus reproduces that shape:

| eff. n | share | ∞-gram agrees | sparse share | agrees given sparse |
|---|---|---|---|---|
| 2 | 33.9% | 12.8% | 4.2% | 19.8% |
| 3 | 37.1% | 17.6% | 23.7% | 20.0% |
| 4 | 15.9% | 18.0% | 41.1% | 25.0% |
| 5–6 | 6.5% | 24.3% | 53.8% | 31.8% |
| 7–9 | 0.8% | 42.7% | 72.7% | 49.0% |
| 10–15 | 0.4% | 84.1% | 65.2% | 90.1% |
| 16–31 | 0.5% | 79.7% | 70.5% | 91.0% |
| ≥32 | 0.3% | 89.8% | 85.9% | 90.0% |

The tempting reading is that the long context does the predicting. So I scored the 5-gram on exactly the same tokens:

| eff. n | tokens | ∞-gram | 5-gram | only ∞ right | only 5-gram right |
|---|---|---|---|---|---|
| 6–9 | 1,185 | 30.1% | 30.5% | 1.7% | 2.1% |
| 10–15 | 201 | 84.1% | 84.6% | 1.0% | 1.5% |
| ≥16 | 365 | 83.3% | 81.1% | 5.2% | 3.0% |

Up to n = 15 the 5-gram is right just as often, because the last four tokens already settle the continuation. A long match means you are inside text the corpus has seen before, like boilerplate, a code idiom, or my post template, and that text is predictable from short context too. Only at n ≥ 16 does the extra context win, by a net 2.2 points on 365 tokens.

My single-author, templated corpus overstates how often copying happens, and the paper's 47% vs 29% gap on the Pile is real. Still, read the n-vs-agreement curve as *conditional on being in copyable text*, not *as a function of how much context was used*. The control that separates the two is the 5-gram scored inside each ∞-gram effective-n bin.

## Result 3: zeros make interpolation necessary, and the λ split did nothing here

58% of test tokens get P∞ = 0, and 73% of sparse estimates are wrong, against 25% in the paper. That is why the paper always mixes the ∞-gram with a neural LM, using separate weights for sparse and non-sparse estimates. With no neural LM here, I used an absolute-discount bigram as the base and tuned on validation. Test perplexity fell from 449.7 to 424.4 (−5.6%) with a single λ = 0.10. Split weights (0.15 sparse, 0.08 dense) also gave 424.4. At 27% sparse agreement, sparse estimates have not yet earned extra trust.

## Takeaways

- **The engine is the durable part.** Counting is O(|q| log N) with no table, documents can be retrieved from the same index, and backoff costs at most 2 counts per token. Infini-gram mini (Xu et al., 2025, arXiv:2506.12229) moves it to an FM-index at about 44% of corpus size.
- **The modeling gain needs scale.** Until most tokens have effective n > 5, the ∞-gram is a 5-gram by construction. Measure your effective-n distribution first.
- **Effective n is a copy signal, not a context dial.** That is how follow-ups use it, for example infini-gram mini's finding of up to 74.2% GSM8K contamination.

Every number here comes from a from-scratch Python reimplementation on this blog's posts. The tokenizer, corpus, and base model are far weaker than the paper's, so these results describe the method's mechanics, not its large-scale accuracy.
