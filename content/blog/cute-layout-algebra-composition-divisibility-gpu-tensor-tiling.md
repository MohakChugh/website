---
title: "Tiling Is Function Composition: The Partial Algebra Behind Every Tensor Core Kernel"
date: 2026-08-22
tags: ["gpu", "cutlass", "compilers", "linear-algebra", "kernel-optimization"]
excerpt: "CUTLASS turns tiling, swizzling and thread assignment into a single algebraic operation on shape/stride tuples. I implemented the algebra from scratch to check it, and found the interesting part is where it breaks: composition is a partial operation, and I measured how partial. For a 4x4 row-major layout only 76% of candidate composands are legal — which is exactly why these conditions are static_asserts."
---

Writing a fast matmul kernel is mostly bookkeeping. A tensor core instruction wants its operands in a specific, non-obvious register arrangement. Shared memory wants a swizzle so that 32 lanes don't collide on 32 banks. Global loads want vectorized, coalesced access. Each of these is a map from a logical coordinate `(m, n, k)` to a physical offset, and a kernel is correct only if every one of those maps agrees with the others at every stage of the pipeline. Traditionally you keep these straight with index arithmetic, comments, and hope.

CuTe — the layout layer under NVIDIA's CUTLASS, described formally by Cris Cecka in [arXiv:2603.02298](https://arxiv.org/abs/2603.02298) (March 2026) — replaces the hope with an algebra. Two papers in the last eight months have put that algebra on a formal footing, and a third uses it as the basis for compile-time kernel verification. It's worth understanding what the objects actually are, because the useful insight is not in the operations but in the conditions under which they're defined.

## A layout is a function, not a descriptor

A layout is a pair of congruent, possibly nested integer tuples: a *shape* and a *stride*. Written `(6,2):(8,2)`. The shape defines a mixed-radix decomposition of a 1-D domain; the stride is the linear map applied to the digits:

```python
class L:
    def __init__(self, shape, stride):
        self.S, self.D = flatten(shape), flatten(stride)
    def __call__(self, i):
        off = 0
        for s, d in zip(self.S, self.D):
            off += (i % s) * d
            i //= s
        return off
```

That's the whole semantics. `(6,2):(8,2)` maps `0..11` to `0,8,16,24,32,40,2,10,...`. Nesting is what makes the representation strictly more expressive than a flat strided descriptor: `(2,(1,6)):(1,(6,2))` has depth 2, and hardware layouts genuinely need that depth — a tensor core fragment is "each of 32 lanes holds 4 values, at these strides, repeated over these tiles," which is a hierarchy, not a matrix.

Because a layout is a function, layouts that print differently can be equal. `coalesce` finds a canonical shallow form by folding adjacent modes under three rules — drop static-1 modes, and merge `s0:d0 ++ s1:(s0*d0)` into `(s0*s1):d0`. The invariant it must preserve is `size`, not `cosize`. Verifying: `(2,(1,6)):(1,(6,2))` coalesces to `12:1`, and both tabulate to `[0..11]`. ✓

## Composition is the whole toolkit

`R = A ∘ B` means `R(c) = A(B(c))`, and `B` supplies the domain, so `R` is shape-compatible with `B`. This single operation expresses slicing, tiling, transposition and vectorization: `B` is a *description of an access pattern*, `A` is where the data lives, and the composite is the physical pattern.

The canonical example from the CuTe docs is `A = (6,2):(8,2)`, `B = (4,3):(3,1)`, giving `R = ((2,2),3):((24,2),8)`. I checked it by tabulating both sides rather than trusting the algebra:

```
A∘B  = [0, 24, 2, 26, 8, 32, 10, 34, 16, 40, 18, 42]
R    = [0, 24, 2, 26, 8, 32, 10, 34, 16, 40, 18, 42]   ✓
```

The implementation is a divide-then-mod on `A`'s shape. When `B` is injective, composition left-distributes over concatenation, so a multimodal `B` decomposes into `(A ∘ B_0, A ∘ B_1, ...)` and each piece is an integral `s:d`: divide `A`'s shape by the stride `d`, then mod by the shape `s`. Concretely `(3,6,2,8) / 72 → (1,1,1,4)` and `(3,6,2,8) % 9 → (3,3,1,1)`.

## The interesting part: the algebra is partial

Both of those steps carry divisibility conditions, and CuTe checks them statically where it can. It would be easy to read those as an implementation restriction. They aren't — they're forced, and here's the demonstration I find most convincing.

Take `A = (3,2):(1,4)` and `B = 4:1`. The composite function is well-defined as a function: `A(B(i))` for `i in 0..3` is `[0, 1, 2, 4]`. Now ask whether *any* shape/stride layout of size 4 produces that table. I searched exhaustively over all shapes of rank ≤ 3 with product 4 and all strides in `[0, 5]`:

```
A=(3,2):(1,4) ∘ 4:1 -> [0, 1, 2, 4]   representable as a layout: None
A=(2,2):(1,4) ∘ 4:1 -> [0, 1, 4, 5]   representable: ((2,2),(1,4))
```

The layout class is **not closed under composition**. `[0,1,2,4]` is a perfectly good access pattern that no shape/stride pair can name, because the jump structure isn't a product of arithmetic progressions. Change the shape from 3 to 2 and it becomes representable. So the divisibility conditions are not conservatism; they are precisely the conditions under which the composite stays inside the class the type system can represent — which is why they belong in `static_assert` rather than in a runtime check.

How restrictive is that in practice? I ran a census over all integral composands `B = s:d` whose codomain fits inside a given `A`, counting how many yield a representable composite:

```
A=(8,):(1,)        admissible B: 31/31 = 100%
A=(6,2):(8,2)      admissible B: 42/52 =  81%
A=(3,5):(5,1)      admissible B: 54/70 =  77%
A=(4,4):(4,1)      admissible B: 58/76 =  76%
```

A contiguous 1-D layout composes with everything. A plain row-major 4×4 rejects roughly a quarter of candidate access patterns. This is the tax you pay for a representation the compiler can reason about, and it's the reason kernel authors who fight CuTe usually lost the fight at the point where they chose a tile shape that doesn't divide.

`★` A useful mental model: the divisibility conditions are the layout equivalent of a type error. `[0,1,2,4]` isn't *illegal*, it's *unnameable* — and an unnameable intermediate would defeat the static analysis that makes the rest of the design pay off.

## Complement, and tiling in one line

The second primitive is `complement(A, cotarget)`: the layout of everything `A` doesn't touch. It's pinned down by three requirements — disjoint codomain from `A`, strides positive and *increasing*, and enough cosize to cover the target. The ordering requirement is what makes it unique. I brute-forced it as a search over ordered, collision-free layouts whose concatenation with `A` covers `[0, 24)`, and recovered the documented answers without being given them:

```
complement(4:1,        24) -> 6:4        ✓
complement(6:4,        24) -> 4:1        ✓
complement(4:2,        24) -> (2,3):(1,8) ✓
complement((2,4):(1,6),24) -> 3:2        ✓
```

Note `complement(4:2, 24) = (2,3):(1,8)`: the `2:1` fills the gap left by stride 2, and the `3:8` repeats it. The complement is *the layout of the repetition* — which is the observation that makes the next definition work.

Tiling then collapses to a one-liner:

```cpp
// A ⊘ B := A ∘ (B, B*)
logical_divide(layout, tiler) {
  return composition(layout, make_layout(tiler, complement(tiler, size(layout))));
}
```

If `B` selects the elements of one tile, `B*` is necessarily the layout *of the tiles*, so `A ∘ (B, B*)` returns a rank-2 layout whose mode 0 is a tile and mode 1 indexes tiles. Checked: `A = (4,2,3):(2,1,8)` with `B = 4:2` gives `B* = (2,3):(1,8)` and `((2,2),(2,3)):((4,1),(2,8))` — six tiles of four elements, and the tabulated composite matches. ✓ The dual, `logical_product(A, B) := (A, A* ∘ B)`, replicates `A` according to `B`; interleaving the replication instead of blocking it gives you a cyclic (raked) distribution, which is exactly how you assign values to threads.

The identity worth memorizing is `layout<0>(zipped_divide(a, b)) == composition(a, b)`. Partitioning a tensor across threads and asking "what does thread `t` see" are the same operation, viewed from different modes.

## Why this is suddenly load-bearing

The algebra has been in CUTLASS for years, but 2026 is when it became infrastructure rather than an implementation detail. FlashAttention-4 ([arXiv:2603.05451](https://arxiv.org/abs/2603.05451)) is written in the Python-embedded CuTe DSL. Carlisle, Shah, Stern and VanKoughnett gave the algebra a categorical semantics in [arXiv:2601.05972](https://arxiv.org/abs/2601.05972) — two categories whose morphisms are layouts, a proof that the categorical operations agree with CUTLASS's, and a complete characterization of which layouts their construction yields, with a Python implementation tested against the library. That is 174 pages spent proving that a shipping C++ template library means what it appears to mean, and the payoff is that tools can now trust it.

ARGUS ([arXiv:2604.18616](https://arxiv.org/abs/2604.18616)) is the payoff. It verifies GPU kernels at compile time by abstract interpretation *over the layout algebra*, combined with an SMT solver, checking "data-flow invariants" — specifications of how data must be choreographed across the pipeline. When an invariant fails, it emits a counterexample naming the offending thread, element and program point, turning pass/fail signals into localized feedback for an LLM agent. Reported: 99–104% of hand-written assembly throughput on GEMM, flash attention and MoE kernels on MI300X, and 100% of KernelBench Level 1.

None of that is possible if layouts are index arithmetic in a comment. It's possible because the representation is small, closed under the operations you're allowed to use, and *decidably* not closed under the ones you aren't.
