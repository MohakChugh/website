---
title: "The Byte Latent Transformer: Deleting the Tokenizer and Spending Compute Where Entropy Lives"
date: 2026-07-17
tags: [llm-architecture, tokenization, byte-level-models, inference-efficiency, deep-learning]
excerpt: "Every LLM you use starts by chopping text into a fixed vocabulary of BPE tokens, a brittle preprocessing step that has nothing to do with learning. Meta's Byte Latent Transformer throws it away, feeds raw bytes to the model, and dynamically groups them into patches sized by next-byte entropy so that compute flows to the hard parts of the stream. It matches Llama 3 at 8B parameters and 4T bytes while cutting inference FLOPs up to 50%."
---

Every large language model in production shares one component that was never learned: the tokenizer. Before a single matrix multiply happens, your text is run through byte-pair encoding (BPE), a greedy merge algorithm that compresses characters into a fixed vocabulary of 100k-ish subword tokens. That vocabulary is frozen at training time and it leaks everywhere. It is why models struggle to spell, to reverse strings, to do arithmetic on digits, to handle code indentation, and why a language with poor tokenizer coverage costs 3-4x more per sentence. The tokenizer is a static, heuristic bottleneck bolted onto an otherwise end-to-end differentiable system.

The Byte Latent Transformer (BLT), introduced by Pagnoni et al. at Meta in December 2024, deletes it. BLT operates directly on raw UTF-8 bytes and learns, dynamically, how to group them into units of computation. It is the first byte-level architecture to match tokenizer-based models in a FLOP-controlled scaling study, reaching 8B parameters trained on 4T bytes, while simultaneously improving inference efficiency and robustness to noisy input.

## Why not just feed bytes to a transformer?

The naive answer to "get rid of the tokenizer" is to run the transformer over bytes directly. This fails on cost. A BPE token averages ~4 bytes of English text, so a byte-level sequence is roughly 4x longer than the tokenized one. Self-attention is quadratic in sequence length and the feed-forward blocks run once per position, so a byte-level model burns ~4x the compute for the same document while learning to model trivially predictable bytes (the `u` after `q`, the closing `>` of an HTML tag) with the full weight of a 8B-parameter network. You spend your most expensive resource, the global transformer, on the least informative positions.

BLT's insight is that the amount of compute a stretch of bytes deserves is not fixed, it is proportional to how surprising the bytes are. Predictable spans should be cheap. Genuinely novel spans, a rare word, the first token of a new entity, should get the full model. This is dynamic compute allocation driven by information content, and it is implemented through *patching*.

## Entropy patching: let a small model decide where the hard parts are

A patch is a variable-length group of consecutive bytes, the analog of a token but decided at runtime. BLT segments the byte stream using a small, separately-trained byte-level language model (a lightweight transformer). At each position it computes the next-byte distribution and its Shannon entropy. When entropy exceeds a global threshold, meaning the model is uncertain about what comes next, a new patch boundary opens.

```python
import torch, torch.nn.functional as F

def entropy_patch_boundaries(byte_logits, threshold):
    """byte_logits: [seq_len, 256] from the small entropy LM.
    Returns indices where a new patch begins."""
    probs = F.softmax(byte_logits, dim=-1)
    # Shannon entropy in bits at each position
    H = -(probs * torch.log2(probs + 1e-12)).sum(dim=-1)
    # A boundary opens where predicting the next byte is hard.
    boundaries = (H[:-1] > threshold).nonzero().squeeze(-1) + 1
    return boundaries
```

The consequences are intuitive once you watch it run. In the phrase `the cat sat on the m`, the bytes of `the` and `sat` are low-entropy and get swept into long patches. But at the `m` that begins `mat`, the model is genuinely uncertain (mat? man? moon?), so a boundary opens and the following bytes get their own patch. Structured, predictable data like repeated whitespace or boilerplate collapses into very long patches; high-entropy content like a novel proper noun or a random hex string fragments into short ones. Average patch size becomes a direct knob on compute: BLT typically targets ~4.5 bytes per patch, matching Llama 3's tokenizer, but you can crank it to 6, 8, or higher and the global transformer processes proportionally fewer steps.

Critically, this is *not* just a smarter tokenizer. BPE decides boundaries by frequency statistics computed once on a corpus; BLT decides them by a running model's uncertainty, per input, at inference time, with no fixed vocabulary at all.

## The three-part architecture

BLT routes bytes and patches through three modules so that the expensive part sees only patches.

**1. Local Encoder.** A small, shallow transformer over raw bytes. It augments each byte embedding with *hash n-gram embeddings*, hashing the trailing 3-8 byte contexts into embedding tables so a byte carries information about its immediate neighborhood. It then pools the byte representations within each patch into a single patch vector using a cross-attention layer, where each patch's boundary byte attends over its constituent bytes as queries against the byte sequence.

**2. Latent Global Transformer.** A large, deep transformer, this is where the parameters and FLOPs live, operating purely on the sequence of patch vectors. Because there are ~4.5x fewer patches than bytes, this dominant cost is paid once per patch, not per byte. This is the module you scale.

**3. Local Decoder.** A small transformer that takes the global transformer's output patch representations and, via cross-attention in the reverse direction, un-pools them back to per-byte hidden states to predict the actual next bytes autoregressively.

```
raw bytes ──► Local Encoder ──► patch vectors ──► Latent Global Transformer
   ▲              (+ hash n-grams,                        │
   │               cross-attn pooling)                    ▼
   └────────────── Local Decoder ◄──────────── output patch vectors
                   (cross-attn un-pooling, predicts bytes)
```

The encoder and decoder are deliberately tiny relative to the global model. The design keeps byte-level bookkeeping cheap and concentrates capacity in the latent transformer, exactly where information-dense patches need it.

## Why patches scale better than tokens

The headline result of the FLOP-controlled scaling study is a genuinely new scaling axis. In a tokenizer model, vocabulary size is fixed; to spend more compute you grow the model. In BLT, for a *fixed* inference budget you can grow the model **and** grow the patch size at the same time. Larger patches mean fewer steps through the global transformer, which frees FLOPs that you reinvest into more parameters, all while holding the per-step cost constant. Tokenizer models cannot do this because their sequence length is pinned by the vocabulary.

The empirical payoff:

- **Parity with Llama 3** at the 8B / 4T-byte scale on standard benchmarks, the first time a byte-level model has done so in a controlled comparison.
- **Up to 50% fewer inference FLOPs** at matched performance, by trading model size against patch size.
- **Robustness wins** that tokenizer models structurally cannot match: on character-manipulation, spelling, noised-input, and low-resource-language tasks, BLT is substantially stronger because it never destroys sub-token information. A BPE model literally cannot see the letters inside a token; BLT always can.

## The practical trade-offs

BLT is not free lunch. The entropy model is an extra network to train and run during inference, though it is small. Patch boundaries are data-dependent, which complicates batching: sequences in a batch produce different numbers of patches, so efficient implementations need careful padding or packing. And the cross-attention pooling adds architectural complexity that a plain decoder-only stack avoids. For most teams, a frozen BPE tokenizer remains the pragmatic default.

But the direction is important. BLT is the strongest evidence yet that the tokenizer, the last major hand-engineered, non-learned component in the LLM pipeline, is removable without a performance penalty, and that removing it buys robustness and a new efficiency dimension for free. The pattern generalizes: whenever a fixed preprocessing heuristic gates a learned system, there is usually a way to let the model decide dynamically, and to spend compute where the entropy actually is.
