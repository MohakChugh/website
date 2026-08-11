---
title: "Tree Borrows: How Adding a State Made Rust's Aliasing Model Both Weaker and Stronger"
date: 2026-08-11
tags: ["rust", "compilers", "semantics", "undefined-behavior", "optimization"]
excerpt: "Rust's old aliasing model rejected half the unsafe code people actually write, and it silently forbade reordering two adjacent reads. Tree Borrows fixes both at once, which should be impossible: less undefined behavior normally means fewer optimizations."
---

Every compiler that exploits aliasing needs a contract with the programmer, and in Rust that contract is unusually load-bearing. `&mut T` is passed to LLVM as `noalias`, licensing the backend to assume nothing else touches that memory for the duration of a call. Safe Rust upholds this by construction. `unsafe` Rust does not, so someone must write down precisely which unsafe programs are still allowed to exist.

The first serious attempt was **Stacked Borrows** (Jung et al., POPL 2020): each location carries a stack of tags, and using a pointer pops everything above its tag. It was mechanized, it justified real optimizations, and it had two problems bad enough to warrant a replacement.

**Tree Borrows** (Villani, Hostert, Dreyer, Jung; PLDI 2025, Distinguished Paper) is the replacement, and its headline result shouldn't be possible: it declares *less* code to be undefined behavior while licensing *more* optimizations.

## The two failures of a stack

The first failure is structural. Consider what `v.push(v.len())` compiles to: the `&mut v` for `push` is created first, then `v.len()` takes a shared reference, and only afterward does `push` write. Both are children of the same local. A stack has no way to say "these two are siblings, one merely reserved"; all it can express is that one buried the other.

The second failure is worse. Using a tag pops the tags above it, so a read is destructive:

```rust
let a = *ref2;   // pops ref1 off the stack
let b = *ref1;   // ref1's tag is gone -> UB
```

Swapping those two reads changes whether the program has UB. **Reordering adjacent reads is unsound under Stacked Borrows** — a basic transformation every optimizer performs, forbidden by accident. Both failures have the same root cause: a stack records *nesting*, but reborrowing produces a *tree*.

## The state machine

Tree Borrows keeps the reborrow tree explicitly. Each node is a tag carrying a per-location permission. An access to tag `t_acc` is **local** to node `t_sm` if `t_acc` is `t_sm` or a descendant, and **foreign** if `t_acc` is a parent or cousin. Crossed with read/write that gives the alphabet `↓R, ↓W, ↑R, ↑W`.

The default state machine, with `E` meaning UB:

| State | Entry point | `↓R` | `↓W` | `↑R` | `↑W` |
|---|---|---|---|---|---|
| `Reserved` | `&mut T` | stay | → `Unique` | stay | → `Disabled` |
| `ReservedIM` | `&mut Cell<T>` | stay | → `Unique` | stay | stay |
| `Unique` | — | stay | stay | → `Frozen` | → `Disabled` |
| `Frozen` | `&T` | stay | **`E`** | stay | → `Disabled` |
| `Disabled` | — | `E` | `E` | stay | stay |

Three design choices carry the paper.

**`Reserved` gives delayed uniqueness.** A mutable reference no longer starts out unique; it starts reserved and tolerates foreign reads, becoming `Unique` only on the first local write. Two-phase borrows now work natively rather than by exemption — *all* `&mut` are treated this way, deliberately more permissive than the borrow checker.

**`ReservedIM` handles interior mutability.** A `&mut Cell<T>` in its reservation phase must tolerate foreign *writes* too, since `Cell::replace` through an aliasing `&Cell<T>` is legal. So `&mut T`'s rules now depend on whether the type contains `UnsafeCell`.

**`Frozen` is the load-bearing addition.** Instead of a foreign read killing a `Unique`, it demotes it to read-only. This buys back read reordering: after either interleaving of "read parent, read child", the child lands in `Frozen` and still permits reads. The foreign read became order-insensitive. `Frozen` is also where `&T` *starts* — the state a mutable reference decays into is exactly the state a shared reference is born in.

## Checking it against Miri

Miri implements both models, so these claims are executable: Stacked Borrows is the default, Tree Borrows is `-Zmiri-tree-borrows`. I ran the following on nightly `1.99.0` under both.

Read-read, the motivating case — raw pointers, to put the aliasing model rather than the borrow checker in charge:

```rust
let p = &mut root as *mut i32;
let x = unsafe { &mut *p };
*x = 7;                    // local write: x becomes Unique
let a = unsafe { *p };     // FOREIGN read through the parent tag
let b = *x;                // read x again
```

Stacked Borrows: `that tag does not exist in the borrow stack`. Tree Borrows: accepted — the foreign read demoted `x` to `Frozen` rather than evicting it.

The demotion is real, not a loophole — append `*x = 100;` and Tree Borrows rejects it, printing the trajectory `Reserved → Unique → Frozen` and noting the foreign read "corresponds to a loss of write permissions." Exactly the table.

Then the range behavior. A reference's permission is initialized across the **whole allocation**, not just the bytes its type covers:

```rust
let mut v = [0u8; 8];
let x = &mut v[0];
let y = (x as *mut u8).wrapping_add(1);
unsafe { *y = 1; }        // writes OUTSIDE x's type range
```

Stacked Borrows rejects this. Tree Borrows accepts it, because offset 1 is also `Reserved` — permissions are *lazily initialized*, so an out-of-range access is granted if some ancestor had it. This legitimizes `container_of`-style code where a prefix describes the shape of what follows. Casting `&i32` to `&Cell<i32>` and only reading is likewise SB-UB and TB-fine, since raw pointers and interior-mutable shared references inherit the parent's tag.

## Protectors, and where Tree Borrows is stricter

The model so far is too weak to justify what rustc already does. Given `fn f(x: &mut i32, opaque: impl Fn())` whose body is `*x = 13; opaque(); *x = 20;`, deleting the dead first write looks safe: `opaque` can only reach that memory through a tag foreign to `x`, which would invalidate `x` and make `*x = 20` UB. The hole is that `opaque` might never return — have it `process::exit` after reading through a foreign raw pointer and the second write never runs, so nothing is ever UB, yet the optimization changed what got observed.

**Protectors** close this. Every reference in argument position is retagged with a protected tag for the call's duration, and a protected tag hits UB *immediately* instead of transitioning to `Disabled`. A protected `Unique` also traps on foreign reads. The net rule: for a `&mut` argument, encountering both a foreign read and a local write is UB **in either order**.

Protectors also justify inserting *spurious* reads — hoisting `*x` out of a loop that might run zero times. That requires the read to be safe even when the original program never performed it, so Tree Borrows makes every retag *implicitly execute a read* sized by the reference's type. Hence `&mut v[0]` above gets `Reserved` on all 8 bytes but an implicit read on only the first: that byte is always "used", anything beyond is dynamic.

The honest cost: Tree Borrows rejects a pattern Stacked Borrows allows — writing through a raw pointer *before* deriving a shared reference:

```rust
let to = &mut root as *mut u8;
unsafe { *to = 1; }              // activates -> Unique
let from = &root as *const u8;   // foreign read demotes `to` to Frozen
unsafe { *to = 2; }              // UB under TB, fine under SB
```

Miri confirms both verdicts. The practical guidance: **set up all raw pointers before the first write.**

## Does it hold up at ecosystem scale

The evaluation ran the test suites of the 30,000 most-downloaded crates under Miri three times — once with both models off to filter unrelated failures, then once per model. Of 674,748 tests, ~68% survived filtering.

| | Stacked Borrows | Tree Borrows |
|---|---|---|
| Tests failing with aliasing UB | 6,568 | 3,023 |

That is a 53.97% reduction, and the paper's "54% fewer" checks out. The asymmetry matters more: only **31** tests newly break under Tree Borrows. More than half the code Stacked Borrows wrongly condemned is now legal, at a cost of three dozen regressions — and the comparison is *biased against* Tree Borrows, since crate authors spent years being coached by Miri to write Stacked-Borrows-compliant code.

The optimization side is mechanized in Rocq. Almost every Stacked Borrows optimization survives; the exceptions insert new writes before the first write. Read-read reordering is newly proven sound.

## Why this generalizes

Aliasing models look like a scalar tradeoff — declare more UB, get more optimizations — and under that framing Tree Borrows should be strictly worse at optimizing, since it accepts twice as much code.

It isn't, because the tradeoff was never scalar. What an optimizer needs is not *maximal* UB but UB with the right algebraic structure: transformations are sound when the state transition function commutes with reordering. Stacked Borrows had plenty of UB and the wrong structure — its reads were destructive, so read-read didn't commute. Adding `Frozen` made foreign reads idempotent and order-insensitive, buying a real optimization while *shrinking* the UB surface.

If you are designing an effect system, a capability model, or a permission lattice for a database, the lesson transfers: enumerate the transformations you need to be sound, then check whether your states make them commute. Restrictiveness is not the resource you are spending. Structure is.

If you maintain a crate with unsafe code, running your suite under both models costs one CI job and tells you which side of those 31 tests you are on.
