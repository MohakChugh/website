---
title: "Semantic Operators: Putting a Statistical Contract on 6 Million LLM Calls"
date: 2026-08-13
tags: ["query-optimization", "llm-inference", "data-engineering", "databases", "statistics"]
excerpt: "A semantic join over 250 documents and 24,370 labels costs 6,092,500 LLM calls and 25 days. Getting that to 5,290 calls is the easy part. The interesting part is what the accuracy guarantee actually covers, and what it quietly does not."
---

Every team that has bolted an LLM into a data pipeline has written the same UDF: a function that takes a row, formats a prompt, and returns a label. It works fine at row scale. It falls apart the moment your operator is not row-wise.

Consider a real one. The BioDEX task takes biomedical case reports and assigns drug reaction labels drawn from a controlled vocabulary. Sample 250 articles against 24,370 candidate labels and the naive nested-loop semantic join is 250 × 24,370 = **6,092,500 LLM calls**. In *Semantic Operators: A Declarative Model for Rich, AI-based Data Processing* (Patel, Jha, Pan, Gupta, Asawa, Guestrin, Zaharia; arXiv:2407.11418v3, March 2025) that plan is measured at **2,144,560 seconds**, which is 24.8 days on four A100s with Llama-3-70B behind vLLM. The optimized plan does the same job in 2,116 seconds and 5,290 calls: 1,152× fewer calls, 1,013× less wall clock.

Every LLM data system claims a number like that. What makes this paper worth reading is that it attaches a *contract* to the number, and the contract is more instructive than the speedup.

## Correctness relative to a reference, not to truth

The formalism's central move is defining each operator against a **gold algorithm** rather than against ground truth. `sem_filter`, `sem_join`, `sem_topk`, `sem_agg`, and `sem_group_by` each get a designated reference implementation, chosen from the AI literature to sidestep known failure modes. The filter's gold algorithm evaluates one tuple per prompt, deliberately refusing to batch rows into a single context, because packing many rows per prompt walks straight into long-context degradation. The top-k gold algorithm uses pairwise comparisons rather than pointwise scoring or listwise reranking, both of which are known to be less stable.

This is the same trick relational optimizers use, and it is why the guarantees are provable. An optimizer cannot promise its plan is *true*. It can promise its plan matches a designated reference plan to a stated tolerance. Accuracy against ground truth stays the gold algorithm's problem, which is a prompt engineering and model selection question, not a query planning one.

## The cascade, and its two thresholds

The optimized filter is a proxy/oracle cascade. A small model scores every tuple; an expensive oracle model adjudicates only the uncertain middle. The proxy score comes from log-probabilities of the `True`/`False` output tokens, requantized to quantiles over the relation, so absolute calibration of the small model does not matter, only its ranking.

The subtlety is that the algorithm learns **two** thresholds, not one:

```python
def sem_filter(T, langex, oracle, proxy, recall_target, precision_target, delta):
    S  = importance_sample(T, proxy, sample_size)     # mixed with a uniform sample
    MS = {t: oracle(t, langex) for t in S}            # label the sample with the oracle
    AS = {t: proxy(t, langex)  for t in S}

    # split the error budget: two targets means two hypothesis tests
    tau_hi = pt_threshold(S, MS, AS, precision_target, delta / 2)
    tau_lo = rt_threshold(S, MS, AS, recall_target,    delta / 2)
    tau_hi = max(tau_hi, tau_lo)                      # degenerate-proxy clamp

    out = []
    for t in T:
        a = proxy(t, langex)
        if   a >= tau_hi: out.append(t)               # accept, no oracle call
        elif a >= tau_lo:                             # the band: pay for the oracle
            if oracle(t, langex): out.append(t)
        # else: reject, no oracle call
    return out
```

Two things in that sketch are load-bearing.

First, `delta / 2`. Estimating a precision threshold and a recall threshold from the same sample is multiple hypothesis testing, and the thresholds are picked to be the extreme value satisfying a normal-approximation confidence bound. Reusing the full δ on both tests would silently double the real failure rate. The paper inherits this correction from the SUPG line of work on approximate selection over expensive predicates and applies it to the two-sided case.

Second, `max(tau_hi, tau_lo)`. When the proxy is genuinely bad, the recall threshold can land *above* the precision threshold and the band inverts. Clamping τ⁺ upward instead of clamping τ⁻ downward is the safe direction: it shrinks the auto-accept region and widens the oracle band, so a useless proxy degrades the plan back toward the gold algorithm rather than toward garbage. That is exactly the behavior the ablation shows, where swapping a Llama-8B proxy for TinyLlama-1B at a fixed accuracy target buys nothing but a larger oracle bill.

## The join, and the plan that looks backwards

Joins get the same treatment but cannot use an LLM proxy, because even a small model at O(N₁·N₂) is unaffordable. The proxy is embedding similarity, and the optimizer chooses between two plan shapes:

- **sim-filter**: embed both join keys, score pairs by cosine similarity, cascade on that.
- **project-sim-filter**: first run an *ungrounded* `sem_map` over the left table, asking the model to hallucinate the right join key from the left tuple alone, then score similarity between the predicted key and the actual right keys.

The second one looks like a strictly worse idea. It adds N₁ LLM calls up front and asks the model to guess a value from a domain it has never seen. It wins anyway, because the similarity that matters is not "is this abstract similar to this label" but "is this label similar to the label this abstract implies". The paper's own numbers, with γ_R = γ_P = 0.9 and δ = 0.2:

| Plan | RP@5 | RP@10 | Time (s) | LLM calls |
|---|---|---|---|---|
| sim-filter | 0.1541 | 0.170 | 12,563 | 27,687 |
| project-sim-filter (chosen) | 0.212 | 0.213 | 2,116 | 5,290 |
| gold (nested loop) | n/a | n/a | 2,144,560 | 6,092,500 |

Note where the budget goes. The default sampling rate is 0.01% of the data, so on a 6.09M pair space the calibration sample alone is roughly 609 oracle calls, about **12% of the total 5,290 call budget**. The cascade band accounts for the other 4,681, which is 0.08% of the pair space. Calibration is not a rounding error at this selectivity, and it is charged per query, since thresholds are learned against this proxy, this predicate, and this data.

## The part the contract does not cover

Now the thing worth internalizing. Both join plans were calibrated to the same targets: 90% precision and 90% recall relative to the gold algorithm, with failure probability 0.2. Both satisfy that contract. And they differ by **37.6% in RP@5** and 25.3% in RP@10.

There is no contradiction here, and that is the point. The guarantee is on set membership of the operator's output relative to the reference operator. It says nothing about which 10% of the gold positives you dropped, and downstream metrics care enormously. On a join this selective, with roughly 3.7 × 10⁻⁴ base rate, the pairs the proxy prunes are systematically the low-similarity ones, which for a controlled vocabulary means the rare and specific reaction labels, precisely the ones that determine rank precision at 5.

The optimizer picked the better plan, but it picked it on estimated oracle call count, not on quality. Cheaper happened to be better here because a stronger proxy signal both narrows the band and orders the survivors well. Nothing in the framework guarantees those two things move together, and a per-operator statistical bound does not compose into an end-to-end quality bound. If you build on this, your integration test still has to measure the metric you actually ship.

The bound is also loose by construction. Across repeated trials at γ = 0.9, observed failure rates sit below the configured δ and observed precision and recall sit above their targets: a correct conservative estimator leaving cost on the table.

## Top-k: check the combinatorics yourself

The ranking operator is the cleanest result in the paper, and it is verifiable without a GPU. Pairwise-comparison ranking is quadratic: C(100,2) = 4,950 and C(200,2) = 19,900, which are exactly the LLM call counts reported for the quadratic baseline on 100-document SciFact and 200-document HellaSwag-bench. Replacing full sorting with quick-select top-k means each round picks a pivot, compares all remaining tuples against it in one fully parallel batch, and recurses into the side containing rank k.

I simulated random-pivot quick-select for k = 10 to check the reported counts:

```python
def quickselect_topk_comparisons(n, k, rng):
    items = list(range(n)); rng.shuffle(items); comps = 0
    while True:
        m = len(items)
        if m <= 1 or k <= 0 or k >= m: return comps
        pivot = items.pop(rng.randrange(m))
        comps += len(items)                          # one batched round of comparisons
        left = [x for x in items if x > pivot]       # ranked above the pivot
        r = len(left)
        if r == k: return comps
        if r > k: items = left
        else: items, k = [x for x in items if x < pivot], k - r - 1
```

Over 200,000 trials: **234.2** mean comparisons at n = 100 and **445.3** at n = 200, against 237.0 and 448.1 measured in the paper. Within 1.2%, which confirms the reported row is plain random-pivot quick-select and that the 21× to 45× call reduction over quadratic ranking is pure combinatorics, no model behavior involved.

The additional embedding-based pivot optimization, which seeds the first pivot at the (k+ε)-th item by similarity rank, is more conditional than the framing suggests. On SciFact, where relevance correlates with embedding distance, it saves about 9% of comparisons against random pivots. On HellaSwag-bench, where the ranking criterion is a numeric accuracy claim buried in prose and embeddings carry no signal for it, it runs **506.4 calls against my simulated 445.3**, roughly 14% more, with 15% higher execution time. That is the "one extra pivot round" worst case the paper explicitly allows for, and it is lossless in quality, just not free in cost.

## What to take from this

The engineering lesson is not the 1,000×. It is that the useful unit of abstraction for LLM data processing is an operator with a declared reference implementation and a declared tolerance, because that is the smallest thing you can put a bound on. Cascades, proxy scoring, and pivot seeding are all old ideas from approximate query processing over expensive predicates; what is new is pinning them to a reference semantics so the optimizer has something to be correct *about*.

Three things to carry into your own pipeline. Calibration is a real line item, and at high selectivity it can dominate the sample-versus-band split. A per-operator bound is not a pipeline bound, so two plans that both satisfy your contract can differ by 37% on the metric your users see. And when your proxy carries no signal for the predicate, a well-designed system should get quietly more expensive rather than quietly wrong, which is what the threshold clamp buys and what any cascade you build yourself needs to reproduce.
