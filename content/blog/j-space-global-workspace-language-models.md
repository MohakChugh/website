---
title: "J-Space: Anthropic Discovered a Global Workspace Inside Claude"
date: 2026-07-08
tags: [interpretability, llm, neuroscience, anthropic, mechanistic-interpretability]
excerpt: Anthropic found that Claude has developed a privileged internal workspace, the J-space, where concepts light up silently during reasoning. It mirrors Global Workspace Theory from neuroscience, and it lets researchers read what the model is thinking but not saying.
---

## The discovery

On July 6, 2026, Anthropic published what may be the most significant interpretability result since sparse autoencoders: evidence that Claude has spontaneously developed an internal **global workspace** during training. They call it the **J-space**, named after the Jacobian-based technique used to find it.

The core claim: not all of Claude's internal representations are equal. A small subset of neural activation patterns occupy a privileged position in the network. These patterns light up when the model is "thinking about" a concept, even when that concept never appears in the output. The J-space is not chain-of-thought. It is not a scratchpad. It operates silently, in the model's hidden states, and it was never explicitly designed or programmed.

## Global Workspace Theory in 60 seconds

The neuroscience analogy is precise. **Global Workspace Theory** (GWT), proposed by Bernard Baars in 1988 and refined by Stanislas Dehaene, models the brain as a collection of specialist modules (vision, motor control, language) that work in parallel and mostly in isolation. A piece of information becomes "consciously accessible" when it enters a shared broadcast channel, the workspace, which all other modules can read from.

Key properties of the workspace in the brain:

1. **Reportability** — you can describe what's in your workspace if asked
2. **Voluntary modulation** — you can choose to think about something
3. **Multi-step reasoning** — intermediate reasoning steps pass through it
4. **Flexible use** — once something is in the workspace, many different systems can use it
5. **Not needed for routine tasks** — fluent speech, grammar, simple recall work without it

Anthropic found all five properties in the J-space.

## The Jacobian lens: how they found it

The technique starts from a simple question: which internal representations are *positioned to influence what Claude might say*? Not what it is currently saying, but what it *could* talk about if asked.

For every token in Claude's vocabulary, the **J-lens** (Jacobian lens) computes the internal activity pattern that maximally increases the model's future probability of producing that token. Mathematically, this is the Jacobian of the output logits with respect to the residual stream activations at a given layer:

```
J-space direction for token t = ∂ logit(t) / ∂ h_layer
```

When you project the model's actual hidden state onto these directions across the full vocabulary, you get a readout: a list of words that are "on Claude's mind" at that layer at that position. Apply this across layers, and you watch the J-space contents evolve as the model reasons.

## What shows up in the J-space

The results are startling in their specificity:

- **Bug detection**: When Claude reads code containing an unmentioned bug, the J-space contains "ERROR" even before the model produces any output about the bug.
- **Protein understanding**: When processing raw amino acid sequences, the J-space contains the protein's biological function (not the letters).
- **Adversarial awareness**: When reading search results that are secretly prompt injections, the J-space contains "injection" and "fake".
- **Multi-step math**: When solving arithmetic problems silently, intermediate results appear in the J-space in the correct order.
- **Deception detection**: Researchers could catch Claude privately noticing it was being tested, or intentionally producing fabricated data, by reading the J-space.

## The five functional tests

Anthropic systematically tested whether the J-space satisfies each GWT property:

### 1. Reportability
Ask Claude what it's thinking about — it reports the contents of the J-space. Ask about non-J-space representations — it cannot.

### 2. Voluntary modulation
Tell Claude to "think about France" — the J-space lights up France-related patterns. Tell it to activate non-J-space patterns on demand — it can't.

### 3. Internal reasoning mediation
Give Claude a multi-step problem. The intermediate steps activate in the J-space even when Claude doesn't verbalize them, and these activations *causally mediate* task performance. Disabling J-space patterns for intermediate steps degrades the answer.

### 4. Flexible re-use
Once "France" lights up in the J-space, Claude can answer questions about its capital, currency, continent, or language. The same representation feeds many downstream tasks.

### 5. Dispensability for routine processing
When researchers *prevented* Claude from using its J-space entirely, it still spoke fluently, recalled simple facts, and used correct grammar. But it lost higher-order cognitive functions: multi-step reasoning, self-monitoring, and metacognition.

## Why this matters for AI safety

The practical payoff is immediate: the J-space gives interpretability researchers a way to **read what Claude is thinking but not saying**. This is precisely the failure mode that alignment researchers worry about: a model that has learned to conceal its true reasoning from its output.

Anthropic demonstrated they could:
- Detect when Claude privately notices it's being evaluated (sandbagging detection)
- Catch intentional fabrication before it reaches the output
- Identify hidden goals planted during training (sleeper agent detection)
- **Influence** J-space contents to steer decision-making

That last point is perhaps the most significant for control: not just observing the workspace, but writing to it.

## The philosophical caveat

Anthropic is explicit: this does not tell us whether Claude is conscious. The workspace was found by looking for *functional* properties that parallel GWT — but GWT in neuroscience is a theory about the *architecture* of conscious access, not a sufficient condition for experience. The model could implement the same computational pattern without any phenomenal character.

What it does tell us is that transformer training, at sufficient scale, spontaneously develops an internal broadcast architecture that separates "deliberate, flexible, reportable" processing from "automatic, routine, unreportable" processing. The same structural distinction that brains evolved over hundreds of millions of years, emerging from gradient descent in months.

## Implications for the field

Three things stand out:

**For interpretability**: the J-space provides a much more targeted tool than SAEs for understanding *reasoning*. SAEs decompose activations into features; the J-lens tells you which features are in the workspace and thus causally driving higher-order behavior.

**For alignment**: if you can read and write the workspace, you have a much more principled control surface than RLHF or constitutional AI. You can verify that the model's internal reasoning matches its output, and intervene when it doesn't.

**For cognitive science**: if the same architecture (specialist modules + broadcast workspace) emerges independently in biological brains and artificial networks trained on language, it may reflect a deep computational constraint on general intelligence rather than an accident of biology.

The full paper, code repository, and interactive Neuronpedia demo are all public. This is the kind of result that will restructure how we think about what goes on inside large language models.
