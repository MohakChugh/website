---
title: "Nobody Should Hand-Write Page Table Code: Synthesizing MMU Configuration From a Hardware Spec"
date: 2026-09-04
tags: [operating-systems, program-synthesis, virtual-memory, formal-verification, smt]
excerpt: "Every OS port re-implements the same thing: the bit patterns that program the MMU. Velosiraptor generates that code from a behavioral spec of the hardware, verified against it with Z3. I rebuilt its synthesizer for an x86_64 page-directory entry — it recovers the paper's generated code from a 10^15.6 candidate space in 14 checks — then derived the closed form the paper's search-space argument is missing, and found the spec weakening that silently makes read-only mappings writable."
---

The code that programs an MMU is short, boring, and one of the highest-consequence things in a kernel. A 2 MiB mapping on x86_64 means writing a page-directory entry with the frame address shifted right by 21, the page-size bit set, the present bit set, and the read/write bit derived from the requested permissions. Get the shift wrong and you map the wrong frame. Get the R/W bit wrong and every read-only mapping in the system is writable — and no test reliably catches that one, because the mapping still *works*.

And you write it again for every mapping unit on the platform: the system MMU, the IOMMU, per-device protection units, the co-processor's page table. Each with its own layout, registers, and quirks. [Velosiraptor](https://arxiv.org/abs/2608.07966) (Achermann, Chu, Mehri, Karimalis, and Seltzer, ASPLOS '25) argues this should not be hand-written at all: describe what the hardware *does*, and let a synthesizer find the code that configures it.

## One building block, two composition rules

The abstraction is a *mapping unit*, modeled as a partial function:

```text
map :: inaddr -> mode -> state ⇀ outaddr
```

`state` is every bit that influences translation — registers, in-memory descriptors. The unit produces an output iff `(inaddr, mode, state) ∈ dom(map)`, and membership is a conjunction of boolean predicates in CNF. The OS cannot touch `state` directly; it drives a *control interface* of atomic transitions (`transition :: Seq<arg> -> state -> state`): register writes, memory stores, or instructions like MIPS `tlbwr`.

The surprising empirical claim: after analyzing more than 12 memory hardware units, the authors needed exactly **one** basic building block and **two** composition rules. The block is a *segment* mapping a contiguous input range to a contiguous output range, base and size either hardwired or state-derived. The rules are *enumeration* (a C-union-like choice between variants over the same state bits, disambiguated by state — a PDE is either a table pointer or a large frame, per the PS bit) and *staticmap* (a table of entries covering disjoint ranges). x86_64's four-level radix tree decomposes into segments for CR3 and each entry type, enumerations for the level-selecting bit, and staticmaps for the tables.

The spec that falls out is readable — the large-frame variant of a page-directory entry, trimmed:

```rust
segment PDirEntryFrame (base: paddr) {
  state (base: paddr) {
    mem entry [base, 0, 8] {
       0..1  present,   1..2  writable,
       7..8  pagesize, 21..48 address,
  } }
  interface (base: paddr) {
    mem entry [base, 0, 8] {
      Layout { /* same as state */ }
      WriteActions { interface.entry -> state.entry; }
      ReadActions  { state.entry -> interface.entry; }
  } }
  #[pred] fn valid() -> bool { state.entry.present == 1 }
  #[pred] fn is_writable(flgs: flags) -> bool
    { flgs.writable ==> state.entry.writable }
  fn translate(va: vaddr) -> paddr
    requires state.entry.pagesize == 1
    { va + (state.entry.address << LARGE_PAGE_BITS) }
  synth fn addmap(va: vaddr, sz: size, flgs: flags, pa: paddr)
    requires va == 0 && sz == LARGE_PAGE_SIZE
    requires pa & (LARGE_PAGE_SIZE - 1) == 0
}
```

`synth fn` marks a synthesis target. There are three — `addmap`, `setperms`, `delmap` — and their post-conditions are fixed, not per-unit. Synthesis is then reachability over the control-interface state machine: find a transition sequence `op` such that for all valid start states and arguments, `assms(s0, args) ⇒ goal(op(s0, args), args)`. The grammar of candidate programs *is* the control interface: each invocation zeroes or reads a value, assigns expressions to bit slices, then writes.

## The search space, and how far reduction gets you

I rebuilt the synthesizer for that unit — same ten bit slices, concrete bounded verification instead of Z3. With no reduction, a candidate program of at most two interface writes assigning any of six expressions to any of ten slices spans **10^15.6** programs. Unreachable.

The paper's reductions, in order: decompose into building blocks (one PTE at a time, not the whole MMU); restrict state to slices the current goal mentions; back-project the interface through its `WriteActions` to only the fields that can change those slices; prune expressions by type (a 1-bit slice cannot be assigned `pa >> 21`). Applied per subgoal:

```text
brute force (<=2 interface ops): 10^15.6 programs
after state+API+expression reduction:
  valid      3 candidates -> 1 survives
  writable   3            -> 2 survive
  pagesize   3            -> 1
  translate  3            -> 1
merged candidates verified: 2, satisfying full goal: 1
SYNTHESIZED: present=1  rw=flgs.writable  ps=1  address=pa>>21
```

Fourteen checks total, and the result is character-for-character the code in the paper's Listing 3:

```c
size_t PDirEntryFrame_do_map(PDirEntryFrame_t *unit, vaddr_t va,
                             size_t sz, flags_t flgs, paddr_t pa) {
  if (!(((pa & 0x1fffff) == 0x0))) { return 0x0; }
  PDirEntryFrame_entry_t v = PDirEntryFrame_entry_new(0);
  v = PDirEntryFrame_entry_address_set(v, ((pa >> 0x15) & 0x7ffffff));
  v = PDirEntryFrame_entry_ps_set(v, 0x1);
  v = PDirEntryFrame_entry_present_set(v, 0x1);
  v = PDirEntryFrame_entry_rw_set(v, flgs.writable);
  PDirEntryFrame_entry__wr(unit, v);
  return LARGE_PAGE_SIZE;
}
```

## The interesting subgoal is `writable`

It was the only subgoal with two survivors. The second is `rw := 1` — unconditionally grant write. It satisfies `flgs.writable ==> state.entry.writable` for every input, because the implication is vacuous when the flag is clear. A synthesizer has no reason to prefer the correct program; both verify.

What kills it is the *direction* of the post-condition, which is an equivalence:

```text
allows(f, m) <==> (v, m, s') in dom(map)
```

I ran both readings against both candidates:

```text
{present=1, rw=flgs.w, ps=1, address=pa>>21}  implication-only: True   iff: True
{present=1, rw=1,      ps=1, address=pa>>21}  implication-only: True   iff: False
```

Weaken that one `<==>` to `==>` and the toolchain emits, verifies, and ships a page-table writer that makes every read-only mapping writable. That is the honest cost: synthesis does not eliminate the security-critical bug, it relocates it from a bit pattern you can review to a quantifier direction in a spec you probably won't. The upside is that the relocation is one-time and global — one `<==>` audited once covers every mapping unit ever specified.

## What the divide-and-conquer buy actually is

The headline reduction is a *tree*: rather than solving all conjuncts then merging, merge pairwise up a balanced binary tree so unsatisfying partial programs are filtered early. The worked example takes k=4 conjuncts, n=10 candidates each, 50% per-subgoal survival, and reports 665 flat versus 263 tree.

Recomputing: flat is `4×10 + 5^4 = 665`, correct. The tree's leaf level is `4×10` individual checks plus `2 × 5² = 50` pairwise merges, so 90 — the paper prints `2 × (4 × 10 + 5²)`, which evaluates to 130, not the 94 stated. With their rounding of survivors (12.5 → 13) the middle level is `13² = 169`, giving **259**, not 263. The conclusion is unaffected; the ratio is what matters.

And the ratio has a clean closed form the paper never states. Let survivors per conjunct be `s₀ = pn`. Each merge level squares and filters: `s_{i+1} = p·s_i²`, so after L levels `s_L = p^(2^L − 1)·s₀^(2^L)`. The dominant cost is the root merge, `s_{L−1}²`; dividing by the flat cost `s₀^k`:

```text
top_merge / flat = p^(k-2)
```

Verified exactly across k ∈ {4, 8, 16} and (n, p) ∈ {(10, 0.5), (100, 0.2), (10, 0.9)} — ratio 1.000000 in every cell. So the tree's entire advantage is `p^(k−2)`: purchased *only* by the per-subgoal rejection rate, and compounding in the number of conjuncts, not the number of candidates. At k=16, n=10, p=0.5 that is 1.5×10^11 checks down to 9.3×10^6, a 1.6×10^4 speedup — exactly 1/2^14. At p = 1.0, where no subgoal rejects anything, tree and flat costs coincide to three decimals. So the reduction to look at first in a slow synthesis run is not the tree; it is whatever makes subgoals *selective*. The paper's own ablation agrees: interface plus state reduction moves x86_64 from 10^38 to 10^21 candidates, expressions to 10^13, and the tree does not reduce the maximum at all.

## Does it hold up in a kernel

Synthesis for the full x86_64 four-level page table takes 1.14 s median; the Ubuntu 6.2 kernel it compiles into takes 154 s. It is free, in build-time terms. Generated code was dropped into Barrelfish in three environments — monolithic, µkernel supervisor, and µkernel userspace where updates go through capability invocations — and booted on x86_64 KVM with the hardware walking the synthesized tables. Latency for map/protect/unmap matches hand-written code to the nanosecond (13 ns vs Linux's 13 ns on the four-level structure; 8 ns vs Barrelfish on the leaf). The same spec also generates an Arm Fast Models hardware module, so a proposed translation mechanism can be evaluated before it exists in silicon.

The residual friction is where you would expect. Store visibility is handled by a second synthesis phase that inserts barriers and cache maintenance into an already-correct program, rather than searching for them jointly. Exception *classes* are not modeled. And the barrier for Linux is not the synthesizer but the kernel's habit of using translation entries as storage: swap entries in non-present PTEs, NUMA-balancing state, `pmd_t` values threaded through subsystems that never call a high-level map function.

The idea worth stealing, even if you never touch an MMU: this synthesis is tractable because the *hardware's own interface* supplies the grammar. There is no search over arbitrary C — only over sequences of writes the documentation already enumerates, against a post-condition that says what a mapping means. Most low-level configuration code has that shape: device drivers, DMA descriptor rings, interrupt controllers.
