---
title: "PRAC: DRAM Finally Counts Every Activation, and the Counting Is the Attack Surface"
date: 2026-08-05
tags: [dram, rowhammer, hardware-security, computer-architecture, memory-systems]
excerpt: "DDR5's Per-Row Activation Counting gives every DRAM row an exact activation counter, ending two decades of probabilistic RowHammer guessing. Then the mitigation became the vulnerability: an availability attack that eats 94 percent of DRAM throughput, a timing channel that leaks AES keys through the back-off protocol, and a model-checked counter-reset flaw that consumes all but one activation of MOAT's safety margin."
---

For twenty years, DRAM read-disturbance defenses were built on not knowing. Target Row Refresh sampled. Probabilistic schemes rolled dice. Counter-based mitigations tracked a few thousand rows out of millions and hoped the aggressor was among them. Every one was eventually broken by a pattern exploiting what the defense did not track.

JEDEC's April 2024 DDR5 specification update ended the guessing. **Per-Row Activation Counting** gives every DRAM row an exact activation counter, maintained inside the DRAM die. No sampling, no hashing, no aliasing. If a row is activated 71 times, its counter reads 71.

This should have closed RowHammer. Instead it relocated it. The last two years of literature demonstrate that *exact counting is necessary but nowhere near sufficient*, and that the machinery of counting is itself an attack surface. Three classes of attack now target PRAC specifically: availability, timing, and counter-state.

## The mechanism, and why the direction of the signal matters

PRAC has two halves. The counting half: on every row activation, the DRAM reads the row's counter, increments it, and writes it back, in extra cells alongside the data. The enforcement half is the **Alert Back-Off** protocol, and its direction is the novel part.

Prior in-DRAM mitigations were invisible to the memory controller; DRAM stole time and hoped nobody noticed. Under ABO the DRAM *raises a signal to the controller*. When a counter crosses an internal threshold, the DRAM asserts ALERT. The controller must halt traffic and issue Refresh Management commands, giving the DRAM the window to refresh the endangered victim rows. Mitigation is no longer periodic and speculative; it is on demand and precise.

How much counter state does exactness require? The bound follows from the refresh window and row cycle time:

```python
tREFW = 32e-3    # DDR5 refresh window, seconds
tRC   = 48e-9    # tRAS 32ns + tRP 16ns, DDR5-4800

acts_per_bank = tREFW / tRC     # 666,667
```

About 666k activations per bank per window is the physical ceiling, so a counter needs roughly 20 bits and cannot overflow within a window. Counter storage was never the hard problem. ABO making mitigation *externally observable and externally triggerable* is.

## Attack one: the ALERT itself is a denial of service

If an attacker can trigger ALERTs, the attacker can force the controller to stop serving memory. This is the availability attack from the DRAMSec 2024 analysis of PRAC (arXiv:2406.19094).

Its magnitude is easy to derive. Take MOAT's configuration (arXiv:2407.09995), which triggers back-off at an ALERT threshold of 64:

```python
alerts = acts_per_bank / 64          # 10,417 ALERTs per bank per 32ms window

for service_ns in (195, 275, 350):   # forced RFM service cost
    stalled = alerts * service_ns * 1e-9
    print(f"{100*stalled/tREFW:.1f}% of the window stalled")
# 6.3% / 9.0% / 11.4%
```

An adversary hammering a single row trips roughly ten thousand ALERTs per bank per window. At a few hundred nanoseconds of forced RFM service each, that is 6 to 11 percent of the bank's time surrendered to mitigation from one row of pressure. The DRAMSec authors, running full adversarial patterns in Ramulator 2.0 rather than my single-row approximation, measured an attack that **hogs up to 94 percent of DRAM throughput and costs up to 95 percent of system throughput**. My arithmetic is a floor, not their result.

The defense's own precision is what makes this work: because ABO fires exactly when needed, an attacker who knows the threshold knows how to make it fire continuously. On a shared host, a co-tenant needs no bitflip and no secret.

## Attack two: the back-off protocol leaks secrets

ABO changes memory latency in a way the attacker can measure. That is a timing channel, and "When Mitigations Backfire" (ISCA 2025, arXiv:2505.10111) turns it into a working extraction primitive. Whether an access is slow now depends on whether *some row's counter crossed a threshold*, which depends on the victim's access pattern. **PRACLeak** observes access latencies and recovers secrets, including keys from vulnerable AES implementations. A defense reacting to data-dependent access patterns necessarily signals something about those patterns.

The fix is instructive because it deliberately gives back the efficiency ABO was designed to deliver. **TPRAC** issues Timing-Based RFMs periodically and *independently of memory activity*, removing the channel by discarding the demand-driven property PRAC introduced. It costs 3.4 percent at an RH threshold of 1024 and needs no changes to the standard.

## Attack three: the framework is not the implementation

The subtlest class targets counter state, and it is where the specification leaves the most room. JEDEC standardized PRAC as a *framework*: exact counters plus ABO. It did not standardize which row to mitigate, how counters reset, or how many activations may occur between ALERTs. Security lives entirely in those unspecified choices.

MOAT's authors demonstrated the point by breaking Panopticon with a **Jailbreak** pattern producing 1150 activations on an attack row at a threshold of 128 — a nine-fold overshoot against a design built on exact counts. QPRAC (HPCA 2025, arXiv:2501.18861) sharpened it: Panopticon becomes insecure when built to JEDEC's actual spec, while UPRAC is secure only given "oracular knowledge of the top-N activated rows," which no real DRAM has. Exact counters do not tell you which pending mitigation to service first, and that scheduling decision is the whole game. QPRAC answers with a priority queue ordering mitigations by activation count, reaching a threshold of 71 at 0.8 percent slowdown.

Chronus (HPCA 2025, arXiv:2502.12650) found a second gap: PRAC issues a *fixed* number of preventive refreshes, enabling a **wave attack** that keeps a moving front of rows just under the mitigation bar. Chronus varies the refresh count dynamically and moves counters off the data path.

Then the 2026 result that should worry anyone treating this as settled. **AutoPRAC** (arXiv:2606.23905) models PRAC implementations as bounded state machines and hands them to a model checker with a worst-case oracle attacker. It found an unreported **counter-reset flaw in MOAT** permitting up to 34 activations above the RowHammer threshold to go undetected. Put that against MOAT's own safety budget:

```python
ATH, RH = 64, 99      # MOAT at ATH=64 tolerates RH threshold 99
print(RH - ATH - 34)  # 35 activations of margin, minus the leak => 1
```

MOAT's entire margin at ATH=64 is 35 activations. The flaw consumes 34 of them. **The proof of security survives by one activation.** Neither paper states it that way — the collision only appears when you put MOAT's threshold pair next to AutoPRAC's leak count — and it is the strongest available argument that hand-analysis of these protocols is at the end of its useful life. MOAT was not sloppy work. It was a careful, provably-secure design that shipped an adversarial analysis of its own ALERT behavior, and a model checker still found a state its authors had not enumerated.

## What the overheads actually are

One methodological note, because the simulator numbers have been misleading. The DRAMSec analysis reported under 13 percent overhead on current chips and up to 94 percent for future, more vulnerable ones. The first real-machine study (IEEE CAL, arXiv:2507.05556) measured SPEC CPU2017 overheads of **1.06 percent average and 3.28 percent maximum**, up to 9.15x below simulator-based reports. Working backward, `1.06 × 9.15 ≈ 9.7%` and `3.28 × 9.15 ≈ 30%`, consistent with the simulator range rather than contradicting it.

The mechanism matters more than the ratio: a **close page policy** keeps PRAC's lengthened precharge off the critical path. The counter read-modify-write happens during precharge, and if you were closing the row anyway, it hides. Simulators modeling open-page behavior charge you every time. The cost is set by a policy decision one level up, which is why CnC-PRAC (arXiv:2506.11970) coalesces accesses to counters in the same physical row, reporting 75 to 83 percent fewer counter activations than Chronus.

## The transferable lesson

PRAC is the rare case where a security community got exactly the primitive it spent two decades asking for: perfect information, in hardware, at no prohibitive storage cost.

Exact detection converted RowHammer from a *detection* problem into a *scheduling and observability* problem. Once you know which row is dangerous, you must still decide what to service first under a bounded budget (QPRAC), how much to service (Chronus), how to reset state without opening a window (AutoPRAC vs MOAT), and how to keep the reaction from becoming a signal (TPRAC) or a lever (the availability attack). None of those is a counting problem. Every one is a problem PRAC's exactness created or exposed.

The defense that knows everything is also the defense that reacts legibly, and legible reactions are exploitable. If your mitigation is triggered by attacker-influenced state and observable in attacker-visible timing, you have not eliminated the vulnerability. You have moved it into the mitigation, where it is harder to see, because that is the part everyone assumes is the fix.

Worth watching: PVAC (ISCA 2026, arXiv:2604.20576) argues the framing was wrong all along, since "PRAC tracks the aggressor but aims to protect the victim," and counts victim rows instead. Loaded Dice (ISCA 2026, arXiv:2605.17358) goes the other way, reporting 0.2 percent average slowdown at threshold 500 against PRAC's 14 percent by returning to sampling done properly. Two years in, the field still argues about what to count.
