---
title: "Software-Defined Prefetching: Steering the Hardware Prefetcher With One PTE Bit"
date: 2026-08-27
tags: [microarchitecture, prefetching, operating-systems, performance, memory]
excerpt: "On datacenter workloads, hardware prefetchers run at 24% accuracy — the useless prefetches are 44% of all DRAM traffic. Themis fixes this not with a smarter predictor but with a page-table bit: profile which 4KB pages are prefetch-hostile, mark them in the PTE, and let the prefetcher read the hint off the TLB. I checked the paper's arithmetic, derived where its magic constant comes from, and found the failure mode it never mentions — huge pages."
---

Hardware prefetchers are one of the few microarchitectural structures that can make your program slower. On SPEC2017 they look excellent: 53% coverage, 77% accuracy, 28.5% mean speedup. On real datacenter traces the same seven prefetchers deliver 25.1% coverage at **24.0% accuracy** — three out of four prefetched lines are fetched from DRAM, never touched, and evicted.

That is not a rounding error. Normalize to the number of LLC misses with prefetching off: 100 misses still happen (25.1 covered, 74.9 not), and the prefetcher adds 79.3 useless line fills on top. Every one of those is a DRAM transfer.

```python
covered, uncovered, useless = 25.1, 74.9, 79.3   # normalized to no-prefetch misses
traffic = covered + uncovered + useless          # 179.3 lines from DRAM
useless / traffic                                # 0.442
```

**44% of DRAM traffic in the baseline is prefetches nobody reads.** In a single-tenant benchmark that is free — the bandwidth was idle. Under multi-tenancy it is the thing eating your neighbor's tail latency, which is why some fleets have measured a net win from switching hardware prefetching off entirely.

## Why the fix cannot live in hardware

Prefetchers already ship throttlers, and the state of the art throttles per load PC. CLIP indexes a buffer by instruction address and blocks prefetches from loads that are both inaccurate and non-critical. On datacenter traces it *loses* 4.9% IPC across seven prefetchers — because these workloads have instruction footprints over 4× larger than the biggest SPEC binary, so **over 67% of prefetches are blocked merely because their triggering PC missed in the throttling buffer.** The mechanism degenerates into indiscriminate throttling.

The Themis paper (Kamahori et al., [arXiv:2608.00259](https://arxiv.org/abs/2608.00259), Google/UW/Cornell/UCSC) starts from a different discriminator: not the PC, but the *page*. Per-4KB-page prefetch accuracy is strongly bimodal — 50–75% of touched pages have accuracy below 20%. This is intuitive once stated: prefetchability is a property of the data structure living on the page, and a page holding a hash table's node arena does not become array-like later. The same load PC will be prefetchable on one page and hopeless on another, which is exactly why PC-indexed filtering cannot see the signal.

Tracking usefulness per page in hardware is hopeless at these footprints — a hardware-only table needs ~128 KB to approach Themis's IPC. So push the metadata to software and keep only the *decision* in hardware.

## The interface: a performance hint in the page table

Themis stores one bit per page in the PTE, using Arm's page-based hardware attributes (PBHA) — a 4-bit software-managed field already architected into PTEs and TLB entries, already propagated through the memory subsystem with each load/store packet. The prefetcher reads the bit and gates its training *and* prediction logic for that page.

The properties that make this a good channel are worth spelling out:

- **No ISA change, no recompile, no restart.** Hints are injected into a running process's page table from a kernel module. Contrast with compiler-inserted software prefetches, which need the source and a rebuild.
- **No TLB shootdown.** This is the load-bearing trick. Shootdowns are required for *correctness*-relevant PTE changes; a performance hint can be stale indefinitely. Themis lets hints percolate lazily, whenever the hardware walker next refills that TLB entry.
- **Cheap telemetry.** The cache PMU gets a small FIFO recording physical addresses of prefetched lines evicted without reuse — structurally the same trick as LBR-based sampling. The kernel reverse-maps those to virtual pages and aggregates.

The decision rule is one inequality, evaluated per page, where λ is a "usefulness factor" tuned to 4:

```python
def disable_prefetch(useful, useless, lam=4.0):
    return lam * useful < useless        # Themis Eq. 1
```

Costs are small and easy to reason about: ~1 µs per PTE attribute update including the software walk, ~33k updates per profiling window → 33 ms, amortized over a 15 s profiling cadence → **0.2% overhead**. The cadence is justified by measured profile stability: per-page decisions taken from ten different trace segments spanning tens of billions of instructions agree almost perfectly.

Results: 40.6% fewer useless prefetches, 18.0% less DRAM bandwidth, and IPC gains on *all* seven prefetchers (0.2%–13.8%; 4.1% BOP, 3.1% SPP+PPF, 1.4% Pythia) where CLIP regressed.

## Checking the arithmetic

The two headline numbers should be redundant, so I checked them against each other. Removing 40.6% of 79.3 useless fills cuts 32.2 lines from 179.3: `32.2/179.3 = 17.96%`. Reported: 18.0%. The traffic and prefetch-quality numbers are consistent, which is more than you can say for a lot of prefetching papers.

Next I wanted to know where λ = 4 comes from, since the paper reports it as empirical. Disabling prefetch on a page saves `u` useless transfers but exposes `g` covered misses as demand misses (the transfer still happens — only its latency stops being hidden). With `L(ρ) = L₀/(1−ρ)` for a memory system at utilization ρ, the marginal latency saved by removing one line of traffic is `L₀/(1−ρ)² · 1/C`, applied across all `N = ρC` memory accesses in the window:

```
benefit = u · L₀ · ρ/(1−ρ)²        cost = g · k · L₀/(1−ρ)
disable iff  u/g > k(1−ρ)/ρ   ⟹   λ* = k(1−ρ)/ρ
```

So λ* falls as utilization rises — which is exactly the trend the paper measures: the optimal λ drops 4 → 3 → 2 → 1.5 → 0.5 as DRAM bandwidth is scaled 25.6 → 1.6 GB/s. Direction confirmed. Magnitude, not: with offered traffic fixed, ρ ∝ 1/BW, and a 16× bandwidth cut should swing λ* by orders of magnitude, not 8×. Two effects flatten it. Throttling is self-limiting — cutting prefetch traffic lowers ρ, which raises λ*, a negative feedback loop. And the u/g distribution is bimodal enough that λ barely selects a different page set. Calibrating a page model to the paper's own statistics (aggregate accuracy 0.239, 58% of pages under 0.2 accuracy), the Jaccard overlap between the pages disabled at λ=0.5 and λ=4 is 0.62, and the pages that differ carry little traffic. The IPC-vs-λ curve is flat near the optimum because the mechanism is not really choosing a threshold, it is separating two populations.

## The result that does not fit a filter model

An oracle per-page filter at λ=4 on my calibrated distribution removes ~72% of useless prefetches but sacrifices ~15% of coverage. Themis removes 40.6% and coverage goes **up 5.7%**. A static filter cannot do that.

The explanation is a capacity effect, and the ablation pins it down: a Themis variant that suppresses prediction but keeps *training* enabled captures only 1.9% of the 3.5% mean gain. **Roughly half the benefit is not bandwidth at all — it is that the prefetcher stops spending its limited pattern tables on pages it was going to be wrong about.** The sensitivity study makes the same point from the other side: with Themis, prefetchers reach baseline IPC at a fraction of their original table sizes. Filtering the input to a fixed-size predictor is equivalent to enlarging it.

## What the paper does not mention: huge pages

The hint's granularity is the page table's granularity. Datacenter workloads run with 2 MB transparent huge pages precisely because their footprints thrash the TLB — and a PBHA bit on a THP covers 512 4KB pages at once. Whether Themis survives that depends on how homogeneous prefetchability is *within* a 2 MB region, which is an allocator question: a slab carving one THP into arenas for different structures will mix labels.

I simulated it, varying within-region homogeneity `h` and comparing a per-4KB decision against one aggregated per 2 MB region:

```python
off_4k  = useless > lam * useful                        # per-4KB page
off_2mb = useless.sum(1) > lam * useful.sum(1)          # one bit per THP
```

| homogeneity | 4KB: useless removed / cov. lost | 2MB: useless removed / cov. lost |
|---|---|---|
| h = 1.00 | 71.6% / 15.0% | 76.1% / 21.0% |
| h = 0.90 | 68.8% / 13.2% | 72.3% / 29.6% |
| h = 0.75 | 66.4% / 11.9% | 49.9% / 29.1% |
| h = 0.50 | 61.8% / 9.8% | 0.0% / 0.0% |

At h = 0.75 the coarse hint keeps most of the coverage loss while giving up a third of the benefit. At h = 0.5 it disables nothing — every region's aggregate `u/g` sits under the threshold and the mechanism silently becomes a no-op. That is the dangerous case: no regression, no signal, no win. Anyone deploying this needs the profiler to report per-region label entropy, and probably wants hints at both PTE levels, splitting THPs whose contents disagree.

The reusable idea here is broader than prefetching. A PTE bit that is explicitly *not* correctness-relevant is a nearly free software→hardware channel: no ISA surface, no shootdown, no recompile, sub-microsecond to set, and it addresses data rather than code. Cache replacement hints, DRAM page-policy hints, and NUMA migration hints all want the same channel. The prefetcher just happened to be the structure that was wrong 76% of the time.
