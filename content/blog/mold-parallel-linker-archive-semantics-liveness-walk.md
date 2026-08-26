---
title: "mold: What It Takes to Parallelize a Linker (and Why Nobody Did)"
date: 2026-08-27
tags: [compilers, linkers, parallelism, systems, performance]
excerpt: "Linking is the last stage of the build that refuses to use your machine. lld sits on roughly one core for four of the five seconds it takes to link Firefox. The reason is not that the work is inherently sequential — it is that archive semantics are defined as a left-to-right scan, so parallelizing symbol resolution changes which object files end up in your binary. mold's answer is to replace the scan with a reachability walk, and I reproduced both the win and the corner-case divergence it causes."
---

Every other stage of a C++ build is embarrassingly parallel. You compile 40,000 translation units across 64 cores, then hand the results to a single process that walks them mostly one at a time. Rui Ueyama's mold paper (ASPLOS 2027) makes the indictment concrete: lld links Firefox's debug build in 4.43 s, and a CPU trace shows it pinned near one core for most of that. mold does the same link in 0.90 s.

The interesting question is not how mold got 4.9× faster, but why a problem this obviously parallel stayed sequential through three generations of production linkers.

## The real obstacle is a specification, not a data dependency

Linking is defined as one left-to-right pass over the command line. When the scan reaches an archive (`libfoo.a`), it extracts only members defining symbols currently *undefined*, and each extracted member can introduce new undefined references, so the scan iterates within the archive. Cross-archive cycles break the model — hence `--start-group`/`--end-group`: rescan this set until nothing new appears.

That definition is load-bearing: which member of which archive supplies a duplicated symbol falls out of scan order, and parallelizing resolution shifts those outcomes. The ELF specification says nothing about it — it defines a file format, not a linking process — so GNU ld is the de facto reference for behavior nobody wrote down, and every observable difference arrives as a bug report.

mold discards the scan. All inputs are parsed eagerly and in parallel, *including every archive member*. Each file then tries to become the **owner** of each symbol it defines, via an atomic compare-and-swap on the symbol's owner field, using a precedence ladder (strong defined > weak defined > strong in archive > … > common > undefined) with ties broken by command-line position. Then liveness runs: non-archive files are live unconditionally, and each newly live file marks the owners of symbols it references.

I implemented both to see where they diverge:

```python
def liveness_walk(files, pos):        # files: every input incl. archive members
    owner = {}
    for f in files:                   # "CAS on the owner field"
        for s in f.defines:
            if s not in owner or pos[f] < pos[owner[s]]:
                owner[s] = f
    live = [f for f in files if f.archive is None]
    q, seen = deque(live), set(live)
    while q:                          # parallel mark phase with a feeder
        for s in q.popleft().refs:
            o = owner.get(s)
            if o is not None and o not in seen:
                seen.add(o); live.append(o); q.append(o)
    return live
```

Two results. First, a circular dependency — `libA/a1.o` defines `A_f` and calls `B_g`; `libB/b1.o` defines `B_g` and calls `A_h`; `libA/a2.o` defines `A_h`:

```
case 1: circular deps, libA before libB
  sequential : extracted=['a1.o', 'b1.o'] undefined=['A_h']
  liveness   : extracted=['a1.o', 'a2.o', 'b1.o'] undefined=[]
  sequential + --start-group: undefined=[] after 2 rescans of the group
```

The walk reaches a member appearing *before* its referrer and follows the cycle without rescanning, so `-l` ordering and `--start-group` become irrelevant (mold accepts and ignores those flags). Swap the two archives and the sequential model fails at a *different* symbol; the walk is order-invariant.

Second, the corner case that keeps this out of GNU ld. Define `dup` in a member of `libC` and also in a member of `libD`, where `dup` only becomes undefined after `libD`'s own member is pulled in:

```
  -> definition of 'dup' comes from: sequential=['d2.o']  liveness=['c1.o']
```

Same command line, different binary. The sequential scan had passed `libC` before `dup` was undefined, so it takes `libD`'s copy; ownership-by-position takes `libC`'s. Not hypothetical: the paper's Gentoo run (19,422 packages, mold as the system linker) found 74 failures, of which exactly **2** trace to parallel resolution picking a different archive member. Two in nineteen thousand is a rounding error to a new linker and an unacceptable regression to an incumbent.

## Data parallelism, not task parallelism

The second structural choice: mold runs passes strictly serially with a parallel-for inside each, so exactly one pass is in flight and invariants stay trivial. gold tried the opposite — a work queue with dependency tokens — and got negligible or negative gains because tasks serialize on dependency chains; it still ships with threading off by default.

Within that frame, the passes get genuinely nice algorithms.

- **GOT/PLT scanning.** Whether a symbol needs a GOT or PLT slot depends on resolution outcome, not relocation type (`R_X86_64_PLT32` *permits* a PLT entry rather than demanding one). Because these flags are **monotonic** — never cleared — a relaxed atomic bitwise-OR suffices, no locks or fences: `flags.fetch_or(NEEDS_GOT, std::memory_order_relaxed)`.
- **String merging.** Firefox debug has ~21 M mergeable strings, ~75% duplicates. The cost of a concurrent hash map here is resizing, so mold estimates cardinality with **HyperLogLog** first and sizes the table to never grow; all files then insert in parallel via CAS.
- **Identical code folding.** Section identity is recursive (two functions match if their relocation targets match), i.e. **bisimulation equivalence**. Instead of Hopcroft-style partition refinement, mold uses hash-based **color refinement** (1-dimensional Weisfeiler-Leman): iteration 1 hashes contents and relocation types, each later iteration folds in the targets' previous hashes, so iteration *N* summarizes all walks of length ≤ *N*. Convergence is "distinct-hash count stopped growing," and each iteration needs zero synchronization.
- **Layout.** Assigning output offsets is a prefix sum, made awkward by per-section alignment: padding depends on the running offset, so the operator isn't a plain sum. mold uses a two-level Blelloch scan — chunk each output section's inputs into groups of ~10,000, compute each group's size *and max alignment* in parallel, serially scan the few groups, then assign within groups in parallel. I checked the cost: in 2,000 random section mixes, aligning each group's base to its max alignment made group-relative offsets valid at any landing address in all 2,000, but the total came out *larger* than a serial pass in 86% of them (mean 4% padding on a pathological mix of tiny sections). Parallel layout is not offset-identical to sequential layout; it trades padding for associativity, and real sections are large enough relative to their alignment that the trade is invisible.
- **Range-extension thunks.** ARM64's `BL` reaches ±128 MiB, and existing linkers place thunks with a sequential fixed-point loop, since inserting one shifts later code and can break already-accepted branches. mold uses a single linear scan with two cursors — a leading cursor at the highest assigned address, a trailing cursor where relocations are being scanned, separated by one branch reach minus a thunk margin — so no earlier decision can be invalidated. On ARM64 Firefox: 19,080 thunk entries vs lld's 18,896, for 0.07 s instead of 1.01 s.

## The Amdahl consequences, audited

Once the passes are parallel, system-level costs dominate. `madvise(MADV_HUGEPAGE)` on the output mapping makes the copy pass 3.1× faster; `fallocate` on the sparse 2.5 GiB output (ext4 serializes block reservation on a per-file lock) makes it 3.5× faster for ~5 ms of setup. Neither moves lld much — such tricks pay in proportion to how little other work remains.

I re-derived the scaling numbers, because "13.5× at 32 threads, nothing at 64" wants a mechanism:

```
  p   S(p)  KarpFlatt e  work infl.  avg cores  floor CPU/p
  1   1.00        0.000        1.00        1.0        12.20
  8   6.42        0.035        1.17        7.5         1.79
 16  10.17        0.038        1.31       13.3         1.00
 32  13.56        0.044        1.73       23.4         0.66
 64  13.56        0.059        3.13       42.4         0.60
```

Reading the 32-thread speedup through Amdahl implies a 4.4% serial fraction and a 22.8× ceiling — which the measured plateau of 13.6× never approaches. The reason is that the serial-fraction model assumes constant total work, and mold's does not: CPU time inflates 1.73× by 32 threads and 3.13× by 64. Karp–Flatt makes it explicit, since *e* rises (0.035 → 0.059) instead of staying flat, the signature of contention rather than a sequential tail. The paper's counters name the culprit: from 32 to 64 threads mold retires 9% more instructions but takes 37% more DRAM loads, and sampled DRAM latency inflates 1.9× to ~1,070 cycles as the working set outgrows cache. The remaining headroom is memory, not scheduling.

The per-pass ablation reconstructs cleanly too: forcing each pass single-threaded yields speedups of 5× (relocation scanning) to 29× (build ID, a BLAKE3 Merkle tree over 4 MiB blocks — 23 ms for 2.5 GiB), and every predicted total lands within 0.03 s of the reported figure. Those seven passes sum to 9.57 s of the 12.2 s single-threaded run, so **22% of the sequential work lives in passes the table never lists** (layout, ICF, local symbols, thunks). Which supports the paper's own conclusion: the largest line item in the 3.53 s gap against lld is parse-plus-resolve at 1.12 s, only 32% of it. There is no one trick.

The transferable lesson is where the sequential constraint actually lived. Not in the dependency structure of linking — a reachability walk over an ownership map parallelizes fine — but in an unwritten behavioral specification a decade of tools had been bug-compatible with. Getting the 4.9× meant being willing to differ in two cases out of nineteen thousand, and having the number to point at.
