---
title: "Fair Queueing for LLM Serving: Why the Virtual Token Counter Needs a Lift Rule"
date: 2026-08-27
tags: [llm-inference, scheduling, fairness, systems, gpu]
excerpt: "Requests-per-minute limits are the industry's fairness mechanism, and they are terrible: to get a tighter fairness gap than a proper fair scheduler, my simulation had to throw away 78% of the GPU. VTC (OSDI '24) ports weighted fair queueing to continuous batching, and the part that matters is not the counter — it is the one line that erases a returning client's banked credit. Without it, an idle client comes back and takes 83.5% of the machine."
---

Every inference API meters you in requests per minute. It is a strange choice. RPM limits are a fairness mechanism — they exist so one client cannot drown the queue — but they are enforced against a quota rather than against contention, so a client hits its limit while the GPU sits half empty. You pay for accelerators you are contractually forbidden from using.

Networking solved this in the nineties: don't cap senders, order the queue. Weighted fair queueing gives every backlogged flow an equal share of whatever capacity exists and hands the leftovers to whoever wants them. Nobody shipped WFQ for LLM serving because three of its assumptions break at once.

**Cost is unknown at admission.** A packet's length is in its header; a request's cost is `input_len + output_len`, and output length is not known until generation stops. Start-time fair queueing and deficit round robin both need the cost of the item they are about to schedule.

**Capacity is not a constant.** A continuous-batching engine's token rate depends on how many sequences are resident and how long their contexts are, so "1/n of capacity" has no fixed value to divide.

**The quantum is a batch, not an item.** You are choosing a set of requests that co-reside in a KV budget, and once admitted they decode together for hundreds of steps.

*Fairness in Serving Large Language Models* (Sheng et al., OSDI '24) gives up on predicting cost and accounts for it as it is incurred, one decode step at a time.

## The counter, and the line that actually matters

Define service as a weighted token count: `W = w_p·n_p + w_q·n_q` over input and output tokens, mirroring how APIs price prefill below decode. Each client `i` gets a virtual counter `c_i`. Admission always picks the queued client with the smallest counter, charges `w_p·input_len` immediately at admission, and charges `w_q` per client per decode step:

```python
# admission: fill the batch from the least-served backlogged client
occupancy = sum(r.prompt + r.generated for r in running)
while queue:
    k = min({r.cid for r in queue}, key=lambda i: c[i])   # least-served client
    r = next(r for r in queue if r.cid == k)
    if occupancy + r.prompt > M:                          # KV budget exhausted
        break
    queue.remove(r); running.append(r)
    occupancy += r.prompt
    c[k] += WP * r.prompt          # charge prefill at admission, not completion

for r in running:                  # one decode iteration
    r.generated += 1
    c[r.cid] += WQ                 # charge decode as it happens
```

Charging prefill at admission rather than at completion is deliberate: if you waited, the same client would win every iteration of the fill loop and take the whole minibatch.

That much is just least-served-first, and it is *wrong*. A client that goes idle stops accruing charges while everyone else's counter climbs. When it returns, its stale low counter is a bank of credit and it monopolizes the server until it catches up. VTC's fix is a **counter lift**: when a client with nothing in the queue enqueues a request, its counter jumps up to the current floor.

```python
if r.cid not in {x.cid for x in queue}:              # client was not backlogged
    active = {x.cid for x in queue}
    c[r.cid] = max(c[r.cid], min(c[i] for i in active) if active else c[last_left])
```

Credits are use-it-or-lose-it; deficits are preserved, because `max` never lowers a counter. Note it lifts to the *minimum* active counter, not the maximum — a returning client is put at the front of the active pack, not the back.

I simulated all of this: continuous batching with a KV budget of `M = 8192` tokens, one decode step per iteration, `w_p = 1`, `w_q = 2`, prompts uniform in [64, 512] and outputs in [32, 384]. Two clients, both permanently over their share, drift measured as `max_t |W_f(0,t) − W_g(0,t)|`:

| scheduler | max drift | drift ÷ 2U | throughput |
|---|---|---|---|
| FCFS | 248,796 | 7.59 | 66.4 tok/step |
| least-counter-first (no lift) | 5,606 | 0.17 | 66.3 tok/step |
| VTC | 6,782 | 0.21 | 66.6 tok/step |

FCFS's number is meaningless as a bound: it grows for as long as you run. Both counter schemes hold a gap, at identical throughput. So why bother with the lift? Because the second experiment is the real one. Client 0 sends under its share, goes silent for 2000 steps, then comes back overloaded, while client 1 stays overloaded throughout. Measuring the 600 steps after the return:

| scheduler | returning client's share of service | service delivered to the steady client |
|---|---|---|
| FCFS | 1.9% | 38,390 |
| least-counter-first | 83.5% | 6,662 |
| VTC | 50.2% | 20,400 |

Without the lift, the returning client takes 83.5% of the machine and the well-behaved client gets a third of what VTC would have given it. Idleness becomes an exploit: stay quiet for ten minutes and buy yourself a monopoly. "Quiet then bursty" is what real traffic looks like.

## What the bound costs

The paper's guarantee is that for any interval in which `f` and `g` are both backlogged,

```
|W_f(t1,t2) − W_g(t1,t2)| ≤ 2·max(w_p·L_input, w_q·M)
```

with `L_input` the largest prompt and `M` the KV budget in tokens. The bound is independent of interval length — that is the whole point — and it is tight to within 2×: for *any* work-conserving, non-preemptive schedule there exists an arrival sequence forcing a gap of at least `w_q·M`.

That lower bound deserves attention, because `M` is a knob you turn for throughput. Fairness granularity and batch size are in direct conflict: admitting a request commits the machine to it for its entire output, so the bigger the batch you commit, the coarser the quantum you are allocating. Sweeping `M` with everything else fixed:

| KV budget M | max drift | 2·w_q·M | drift ÷ total service |
|---|---|---|---|
| 2,048 | 2,299 | 8,192 | 0.023 |
| 4,096 | 3,268 | 16,384 | 0.017 |
| 8,192 | 6,782 | 32,768 | 0.017 |
| 16,384 | 17,753 | 65,536 | 0.022 |
| 32,768 | 36,014 | 131,072 | 0.023 |

Absolute drift tracks `M` almost linearly across a 16× sweep, always inside the bound; relative drift stays flat near 2%. Operationally: doubling your KV pool doubles the tokens by which one client can be ahead, so an SLO expressed in absolute terms gets harder to hold on the bigger box. You can tighten it by capping per-client memory in the running batch, but that means declining to fill a batch you could have filled — buying fairness with utilization, which is precisely RPM's sin.

And RPM commits it badly. Sweeping the limit in my simulator (a "minute" being 2000 decode steps):

| RPM limit | max drift | throughput |
|---|---|---|
| 5 | 3,144 | 3.8 tok/step |
| 20 | 6,782 | 14.8 tok/step |
| 40 | 23,375 | 28.8 tok/step |
| 80 | 44,588 | 57.4 tok/step |
| unlimited (= FCFS) | 248,796 | 66.4 tok/step |

To beat VTC's drift you must set the limit at 20, which leaves 78% of the GPU idle. Set it near the fair share (40) and you get a *worse* gap than VTC at 43% of the throughput. No setting wins on both axes, because a static quota cannot know how many clients are contending right now. The paper measures the same dilemma on hardware — Llama-2-7B on an A10G over a chat trace — where VTC sustains 779 tokens/s against FCFS's 777 while cutting average service difference from 433 to 252, and a 5-RPM cap collapses throughput to 340.

## Where token fairness stops being resource fairness

The accounting has a blind spot, and it is worth knowing before you deploy it. Service is counted in tokens; the GPU is spent on bytes moved. For Llama-2-7B in fp16, one token of KV cache costs 2 × 32 layers × 4096 × 2 bytes = 512 KiB, so a decode step reads roughly `13.5 GB + Σ_sequences (context × 512 KiB)`. A client decoding at a 4096-token context drags 2 GiB through HBM per token of service; a client at 256 tokens drags 128 MiB. Sixteen-to-one, for identical credit. The long-context client also pins half the KV pool while it does it.

VTC's own generalization hook is the fix: any monotone cost function `h(n_p, n_q)` works if you charge the increment `h(n_p, n_q) − h(n_p, n_q − 1)` per step. Charge `w_q + β·context_len` and you are metering bandwidth-seconds instead of tokens. It is not free — the invariant that bounds counter spread now scales with the largest context you admit, so the fairness gap loosens for exactly the reason it should.

The same blind spot runs the other way with prefix caching. VTC charges `w_p·input_len` for every admitted prompt, whether or not those tokens were computed. A client whose requests share a cached system prompt pays full prefill price for a prefill that never happened, and gets under-served relative to a client that always misses. If your serving stack does prefix reuse, charge the tokens you actually computed, not the tokens the client sent.

None of this is exotic to implement — the paper reports about 100 lines on top of an existing continuous-batching engine, and my simulator agrees that the mechanism is small. What is easy to get wrong is the one line that decides what a returning client owes you.
