---
title: "Green Tea GC: Why Go's Collector Stopped Chasing Pointers"
date: 2026-08-24
tags: [garbage-collection, go, runtime, memory-locality, simd]
excerpt: "Tricolor mark-sweep is a graph flood, and a graph flood is a microarchitectural disaster: Go's collector spent over a third of its marking cycles stalled on memory it could not predict. Green Tea, default in Go 1.26, changes the unit of work from the object to the 8 KiB span. The entire performance case rests on one empirical bet about queue discipline, and it is possible to measure whether that bet pays off."
---

Every tracing garbage collector you have used is a graph flood. Heap objects are nodes, pointers are edges, and marking is a parallel breadth-or-depth-first traversal that colors reachable nodes. The algorithm is correct, well-understood, and has been refined for thirty years. It is also, in Michael Knyszek and Austin Clements' words, "a microarchitectural disaster."

The numbers are stark. In Go's collector, roughly 90% of GC cost is marking. The scan loop — the core of the flood — accounts for ~85% of GC time, and **over 35% of its cycles are spent purely stalled on heap memory access**. Some Go programs burn north of 20% of total CPU inside the collector. A main-memory access can be 100× the cost of an L1 hit, and a graph flood is structurally incapable of hiding that latency: each work unit is tiny, the next address depends on the current load, and the traversal order has no relationship whatsoever to memory layout.

Green Tea, shipped as `GOEXPERIMENT=greenteagc` in Go 1.25 and the default in Go 1.26, is Go's answer. Its guiding principle is four words: **work with pages, not objects**.

## The unit-of-work change

Go's heap is divided into 8 KiB pages (independent of hardware page size), and critically, *each page holds objects of exactly one size class*. That uniformity is what makes the whole design possible: a page of 128-byte objects holds 64 of them at known offsets, and the allocator already maintains a pointer/scalar bitmap at one bit per 8-byte word.

Classic mark-sweep keeps one bit per object: *seen*. Green Tea keeps two — *seen* (grey: queued) and *scanned* (black). White objects have neither, grey has seen only, black has both. The work queue no longer holds objects; it holds **spans**.

Greying is cheap. When the scanner discovers a pointer, it sets the target's seen bit; if that bit was previously clear and the span is not already queued, the span is enqueued. A per-span flag guarantees a span is queued at most once *at a time*. Dispatching to the right path is a bitmap lookup with one bit per 8 KiB heap page — small enough to stay cached even for enormous heaps, and because spans are 8 KiB-sized *and* 8 KiB-aligned, locating metadata is plain address arithmetic with no dependent loads.

The scan step is where the payoff lives:

```
dequeue span s
todo   = seen[s] & ~scanned[s]     // bitmap difference: what still needs work
scanned[s] |= seen[s]              // promote grey -> black in one operation
for each object in todo (in address order):
    scan it, greying its referents
```

Two bitmap ops replace a per-object work-list pop, and the objects are then walked *in address order within a single 8 KiB region*. Note also that a span may be enqueued many times per mark phase, whereas an object in the old scheme was queued at most once. The bet is that this trade — more enqueues, vastly better locality — comes out ahead.

## The bet: density

The whole design hinges on a hypothesis about accumulation. While a span sits in the queue, other scanners keep discovering pointers into it and setting more seen bits. By the time it is dequeued, the `seen & ~scanned` difference should contain *many* objects, not one. Locality improves and per-scan overhead amortizes.

That hypothesis is about graph topology crossed with queue discipline — which means it can be tested without a GC at all. I built a simulator: a live tree of 200,000 nodes with a tunable fanout, scattered at random over a heap of 64-objects-per-span, running the exact grey/black bitmap algorithm above, and measured objects scanned per dequeue.

The first result is the most important one, and it concerns the choice the design documents state but do not really justify — that the work list is a **FIFO queue** rather than the LIFO stack the old collector used:

| live fraction | fanout | FIFO objs/dequeue | FIFO single-object | LIFO objs/dequeue | LIFO single-object |
|---|---|---|---|---|---|
| 1.00 | 2 | 12.11 | 13.8% | 1.01 | 99.7% |
| 1.00 | 16 | 29.72 | 3.6% | 1.01 | 99.3% |
| 0.25 | 16 | 9.39 | 6.7% | 1.00 | 99.8% |
| 0.05 | 16 | 2.92 | 20.7% | 1.00 | 100.0% |

LIFO collapses to **1.00 objects per dequeue and essentially 100% single-object scans, in every regime**. This is not a mild degradation. A stack pops the span it just pushed, so nothing accumulates, and Green Tea degenerates into precisely the old graph flood plus the cost of maintaining two bitmaps. FIFO is not a tuning knob bolted onto the design — it *is* the design. The Go team reports having tried FIFO, LIFO, sparsest-first, densest-first, random, and address-ordered; FIFO produced the highest average density. The simulation shows why the gap between first and second place is not close.

## Where it regresses, and why that is irreducible

Go's own benchmarks are honest about a bad case. `tile38`, whose heap is largely a high-fanout tree, sees a 35% cut in GC overhead. `bleve-index` — described as a low-fanout, rapidly-rotated binary tree over a 100+ MiB heap — is a wash, with a ~2% regression on 16-core amd64. The stated cause: *half of all span scans only scan a single object.*

My simulation reproduces that number from first principles. At fanout 2 with a 5% live fraction — a binary tree whose nodes are constantly rotated, leaving each span sparsely populated with survivors — FIFO yields **1.77 objects per dequeue and 51.1% single-object scans**. Low fanout alone is not sufficient (fanout 2 at full occupancy still gets 12.1 objects/dequeue); it is low fanout *combined with* a sparse live set that starves accumulation.

The deeper question is whether better queueing could rescue that case. Comparing achieved density against the ceiling — the mean number of live objects actually resident per occupied span, which no algorithm can exceed — gives a counterintuitive answer:

| live fraction | fanout | achieved | ceiling | captured |
|---|---|---|---|---|
| 0.50 | 2 | 7.13 | 32.00 | 22.3% |
| 0.50 | 16 | 16.06 | 32.00 | 50.2% |
| 0.10 | 16 | 4.91 | 6.41 | 76.6% |
| 0.05 | 16 | 2.92 | 3.33 | 87.7% |
| 0.02 | 16 | 1.69 | 1.76 | 95.6% |

FIFO captures a *minority* of the available density on dense heaps (22–50%) and *nearly all* of it on sparse ones (76–96%). Both halves are informative. The headroom on dense heaps is exactly why Clements' original "concentrator network" — a sorting network that raises pointer density before scanning — remains planned future work rather than a dead end. And the saturation on sparse heaps says the `bleve-index` regression is not a queueing bug: the heap has no density left to extract, so no scheduling policy can recover it. Go mitigates rather than fixes it, recording a **representative** object at enqueue time plus a **hit** flag noting whether anything else got marked while queued; if the flag is clear, the scanner scans the representative directly instead of processing the whole span.

Two scoping details matter. Only small-object spans (objects ≤512 bytes) take the new path, since that is where per-object scan cost is hardest to amortize; large objects keep the old algorithm. And work distribution moved to distributed work-stealing queues modeled on Go's goroutine scheduler, replacing per-scanner stacks that "aggressively checked and populated global lists" — a serious contention source as core counts climb.

## The part you cannot do with objects

Uniform layout within a span unlocks something a graph flood can never use: SIMD. Clements' AVX-512 kernel computes a page's entire pointer work set almost branchlessly:

1. Load the seen and scanned bitmaps; union → new scanned, difference → active objects.
2. **Expand** the difference from one bit per object to one bit per word (a 6-word object expands each bit to 6 bits).
3. Intersect with the allocator's pointer/scalar bitmap → every unscanned live pointer in the page.
4. Sweep the page collecting pointers, 64 bytes per vector operation.

Step 2 is the clever one. It uses `VGF2P8AFFINEQB`, a Galois-field instruction that applies a bitwise affine transform over GF(2) — AND for multiply, XOR for add — with a per-size-class 8×8 bit matrix performing 1:n bit expansion. Per-size-class expanders are generated by `mkasm.go` into `expand_amd64.s`, with the kernel in `scan_amd64.s`; it requires Zen 4 or Ice Lake and newer. At 512 bits, an entire page's metadata fits in two registers.

Overall: 10–40% reduction in GC CPU cost without vectors (~10% is the modal result), L1 and L2 misses roughly halved on GC-heavy benchmarks, and another ~10–20% from the vector kernels where object density clears a minimum threshold. For a service spending 10% of CPU in GC, that is 1–4% of total CPU — modest as a percentage, substantial as a fleet.

The most quotable finding from the Go team is also the most surprising, and my numbers support it: **scanning a mere 2% of a page at a time can still beat the graph flood.** The bar for "enough locality to win" is far lower than intuition suggests, which is ultimately a statement about how badly pointer chasing serializes a modern out-of-order core.
