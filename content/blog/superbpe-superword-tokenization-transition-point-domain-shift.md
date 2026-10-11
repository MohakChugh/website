---
title: "SuperBPE on a 1.3 MB Corpus: Superword Tokens Cut 21% of Tokens In-Domain, Half That Out of Domain, and My Section Headings Became Vocabulary"
date: 2026-10-12
tags: ["tokenization", "llm", "nlp", "bpe", "compression"]
excerpt: "SuperBPE (COLM 2025) trains BPE in two stages: subwords first, then merges that are allowed to cross whitespace. I reimplemented it and trained it on this blog's own posts. At a 16k vocabulary it needs 20.9% fewer tokens than BPE on held-out posts, but only 10.9% fewer on npm READMEs. The transition point that is best in-domain is close to the worst out of domain. The paper's 4-word cap had no effect on encoding efficiency, and it also failed to stop the tokenizer from learning my post template ('.\\n\\n## What the') and markdown table rules as tokens."
---

# SuperBPE on a 1.3 MB Corpus: Superword Tokens Cut 21% of Tokens In-Domain, Half That Out of Domain, and My Section Headings Became Vocabulary

Every mainstream tokenizer pretokenizes on whitespace before running BPE, so no token can span two words. Liu, Hayase, Hofmann, Oh, Smith and Choi's [*SuperBPE: Space Travel for Language Models*](https://arxiv.org/abs/2503.13423) (COLM 2025) drops that rule halfway through training. With a 200k vocabulary, the resulting tokenizer encodes text in up to 33% fewer tokens. An 8B model trained on it gains +4.0% on average across 30 tasks (+8.2% on MMLU) while spending 27% less compute per byte at inference.

I reimplemented SuperBPE in about 200 lines of Python and trained it on this site's 210 posts. The paper's main claims held up. Two things it doesn't measure turned out to matter: superword gains roughly halve on out-of-domain text, and the data-leakage guardrail doesn't catch structural boilerplate.

## The algorithm is one changed predicate

Standard BPE splits text into pretokens, here with the GPT-2-style regex ` ?\p{L}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+`. It then repeatedly merges the most frequent adjacent token pair, never across a pretoken boundary. SuperBPE trains normal BPE until the vocabulary reaches a **transition point** `t`. It then keeps training from that vocabulary with the whitespace boundaries removed, until it reaches the target size `T`.

Three appendix rules stay in force in stage 2: digits are split into groups of three (counted from the right), no token may contain `": "`, and no token may span more than 4 words. The cap guards against memorized boilerplate like the Project Gutenberg license and the merge-list leakage described by Hayase et al. `t = T` is plain BPE; `t = 0` is BPE with no pretokenization.

I mark each byte with the boundary before it: 0 for none, 1 for a soft whitespace boundary, 2 for a hard one (document edge or digit group). Each stage uses a different threshold:

```python
def eligible(kind_of_right_token, stage):
    # stage 1: only merge inside a pretoken; stage 2: cross whitespace, never hard edges
    return kind_of_right_token <= (0 if stage == 1 else 1)

def allowed(merged: bytes, stage):
    return stage == 1 or (len(merged.split()) <= 4 and b": " not in merged)
```

The trainer counts pairs incrementally, with a dict of pair → positions and a lazily invalidated max-heap. It agrees with a naive recount-everything implementation on all 144 merges of a small run. That check caught a bug in my first version: when a pair's count went *down*, its heap entry went stale and the pair was dropped forever. Plain BPE never learned `te`, `or` or ` d`, which then leaked into stage 2 and looked like a SuperBPE effect. All numbers below come from the fixed trainer.

**Data.** With frontmatter and fenced code removed, 168 posts (1.30 MB) are for training and every fifth post (42, 332 KB) is held out. For out-of-domain (OOD) text I used 402 KB of npm READMEs from this repo's `node_modules`, code stripped. The paper finds tokenizer quality saturates around 10 MB of training data, so 1.3 MB is small but not absurd.

## Encoding efficiency: the paper's shape reproduces

All figures are bytes per token on the held-out data; higher is better. SuperBPE uses `t = 0.4T`, the ratio of the paper's most efficient setting (80k of 200k).

| Vocab T | BPE | SuperBPE | No pretok (t=0) | Fewer tokens, held-out | Fewer tokens, OOD |
|---|---|---|---|---|---|
| 1k | 2.34 | 2.44 | 2.42 | 4.4% | 2.9% |
| 2k | 2.80 | 3.02 | 2.97 | 7.1% | 5.3% |
| 4k | 3.25 | 3.67 | 3.59 | 11.5% | 7.3% |
| 8k | 3.63 | 4.34 | 4.23 | 16.4% | 9.1% |
| 16k | 3.89 | 4.91 | 4.82 | 20.9% | 10.9% |

Four of the paper's claims hold on my data:

- **The advantage grows with vocabulary size.** BPE runs out of whole words; SuperBPE keeps finding frequent word sequences.
- **SuperBPE beats the BPE ceiling.** With every test-set word as its own token, BPE would reach 4.26 bytes/token. SuperBPE passes that at 8k (4.34); at 16k BPE is at 91% of its ceiling.
- **The curriculum beats no pretokenization at every size.** Without stage 1, early merges are tokens like `"them "` and `"records "`, a word plus a dangling space, the greedy failure the paper describes.
- **The 4-word cap is free.** Removing it left held-out efficiency identical to four significant figures at 8k and 16k, though the uncapped tokenizer learned tokens of up to 7 "words".

## What the superwords are

At T = 8k and t = 3.2k, 1,112 of the 4,800 stage-2 merges cross a word boundary. The first ones match the paper's POS table: `, and`, `. The`, ` is the`, ` of the`, `, which`, ` rather than`. The 4-word tokens include `, which is why`, `. There is no` and `, and it is`. This is function-word glue, the easy, low-loss tokens the paper says superwords absorb. They are 11.2% of held-out tokens.

Most stage-2 merges contain at most one word: `.\n\n`, `'s`, `-bit`, `2^`, ` O(`. These are punctuation and whitespace joins the stage-1 regex forbade, consistent with the paper's Figure 9a for early transition points.

## Finding 1: the gains are the most domain-specific part of the vocabulary

The table's last two columns are the main result. At 16k, SuperBPE saves 20.9% of tokens on held-out posts but 10.9% on READMEs. BPE also does worse on READMEs (3.89 → 2.95 bytes/token), but SuperBPE's *relative* advantage roughly halves at every size.

The train/test ratios point the same way. At 16k, SuperBPE encodes its own training set 12.4% more efficiently than the held-out posts; BPE's gap is 7.3%. Superwords such as ` the paper's` and `. The paper` are phrases from one domain, not general English.

The transition-point sweep at T = 8k shows the same thing from another angle:

| t | 256 | 1k | 2k | 3.2k | 5k | 6k | 7.2k | 7.5k |
|---|---|---|---|---|---|---|---|---|
| Held-out | 4.232 | 4.331 | **4.340** | 4.339 | 4.332 | 4.321 | 4.256 | 4.196 |
| OOD | **3.028** | 2.997 | 2.985 | 2.982 | 3.011 | 3.018 | 2.988 | 2.960 |

In-domain, the curve is smooth with a broad peak at `t/T ≈ 0.25–0.4`, which matches the paper's 0.4. Out of domain, the curve is flat (2.96–3.03) and noisy. The in-domain optimum (2k–3.2k) is close to the *worst* OOD setting.

This fits the paper's model results: its most efficient tokenizer (t = 80k) did *worse* downstream than t = 180k (+3.1% versus +4.0%). One plausible reason is that a tokenizer tuned for compression on its training mix spends vocabulary on that mix's phrases. The paper's 33% was measured on held-out data from the same OLMo mix, so it is an in-distribution number. Train SuperBPE on text that looks like deployment traffic, and choose `t` on that text.

## Finding 2: the 4-word cap doesn't catch boilerplate made of punctuation

The cap exists so the vocabulary can't reproduce memorized text. Counting words with whitespace splits misses boilerplate built from punctuation. The longest tokens in my 8k vocabulary are:

- `────────────────`
- ` |\n|---|---|---|---|---|---|`: a markdown table rule, crossing a newline
- `](https://arxiv.org/abs/2`: the prefix of every arXiv link I write

182 stage-2 tokens contain markdown or URL syntax: table pipes, `- **`, `.\n\n## The`, `:\n\n1. **`. My post generator's section template is also in the vocabulary as `.\n\n## What the`, `.\n\n## Why this` and `.\n\n## When to`.

From the merge list alone, you could tell this corpus is table-heavy markdown that cites post-2020 arXiv papers and comes from a heading template. That is exactly the leakage the cap is meant to limit. The paper's other mitigation, truncating the longest 1% of documents, can't help either, because the repetition is spread across 168 short documents. A byte limit or a cap on non-alphanumeric characters per token would catch it, as would n-gram-level deduplication before training.

## A small implementation trap: encode by stage

The obvious encoder replays every merge in rank order, enforcing only hard boundaries. On the training set it produced 280,948 tokens, not the 280,403 training ended with. All 5,216 extra cross-boundary applications were the stage-1 `\n\n` merge: the GPT-2 regex splits `\n\n` before a non-space character into two pretokens, and a one-stage encoder ignores that split. Running stage-1 merges within pretokens and dropping boundaries only at the transition reproduces training exactly, and does slightly better on held-out data (4.344 versus 4.339). The gap is tiny, but the merge list alone doesn't fully define the tokenizer; the encoder also has to know where stage 1 ended.

## Takeaways

- SuperBPE is a cheap, real win: 16–21% fewer tokens in-domain at 8k–16k vocabularies from 1.3 MB of training text, with no model changes.
- About half of that disappears on other text, and the best in-domain transition point is near the worst out of domain. Pick `t` on deployment-like data.
- The 4-word cap costs nothing and stops nothing made of punctuation: templates, table rules and URL prefixes go straight into the vocabulary.
- Test any incremental BPE trainer against a naive one. A stale-heap bug quietly turned my baseline into a different algorithm.
