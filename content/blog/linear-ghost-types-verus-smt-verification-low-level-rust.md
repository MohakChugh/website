---
title: "Linear Ghost Types: How Verus Proves Raw-Pointer Rust Without Drowning the Solver"
date: 2026-08-25
tags: [formal-verification, rust, smt-solvers, systems-programming, proof-engineering]
excerpt: "Verifying pointer-manipulating systems code means proving two very different things: that aliasing is sound, and that the arithmetic is right. Verus's central design bet is to refuse to send the first problem to the SMT solver at all — aliasing is discharged by a linear type checker, leaving Z3 a purely functional program to reason about. That split is why a verified hypervisor security module and a verified concurrent page-table subsystem now exist, and why the remaining engineering cost has moved somewhere surprising: quantifier triggers."
---

# Linear Ghost Types: How Verus Proves Raw-Pointer Rust Without Drowning the Solver

Program verification has a scaling problem that is not about theory. The theory has been settled since separation logic; what fails in practice is the solver. Push a whole systems program into an SMT encoding and verification conditions grow superlinearly in the number of heap operations, because every write potentially aliases every prior read and the solver must consider that. Verification times go from seconds to hours, then to timeouts that reproduce nondeterministically depending on which lemma you edited last. Anyone who has maintained a large Dafny or F\* development knows the failure mode.

[Verus](https://github.com/verus-lang/verus) — a verifier for Rust aimed squarely at "low-level systems code" — makes a specific architectural bet about this. Its design goals state the intent plainly: emit "small, simple verification conditions" that an SMT solver can dispatch quickly, and use "lightweight linear type checking, rather than SMT solving" for memory and aliasing questions. The consequence is worth stating precisely, because it is the whole idea:

**Memory safety is not a solver obligation in Verus. It is a type error.**

The payoff is not hypothetical. VeriSMo, a verified security module for confidential VMs, and Anvil, which proves *liveness* of Kubernetes-style cluster controllers, both took Best Paper at OSDI 2024. CortenMM — verified memory management, including the parts that touch page tables — took Best Paper at SOSP 2025, alongside the Atmosphere verified kernel. This is not a toy.

## Three Modes and a Calling Discipline

Verus partitions all code into `spec`, `proof`, and `exec`. The first two are ghost code; only `exec` compiles and runs.

```rust
spec fn f1(x: int) -> int {
    x / 2
}

proof fn f2(x: int) -> int {
    x / 2
}

// "exec" is optional, and is usually omitted
exec fn f3(x: u64) -> u64 {
    x / 2
}
```

Note the types. Ghost code gets `int` and `nat` — unbounded mathematical integers, where `x / 2` cannot overflow because there is nothing to overflow. Executable code gets `u64`, where overflow is a real proof obligation that Verus will make you discharge.

The calling rules are strictly one-directional: `spec` can call only `spec`; `proof` can call `spec` and `proof`; `exec` can call all three. Specifications are visible everywhere, proofs are available to runnable code, and nothing ghost can ever call something executable. That last restriction is what makes erasure sound — ghost code cannot observe or influence the running program, so deleting it changes nothing. Verus adds **no run-time checks**. The proof cost is paid entirely at build time.

## Permissions as Values You Can Move

Here is where the linear-types bet becomes concrete. Consider `vstd`'s permissioned pointer:

```rust
pub struct PPtr<V>(pub usize, pub PhantomData<V>);
```

That is just an address, and it is `Copy` — you can duplicate it freely, which is exactly what you would expect of a raw pointer and exactly why it is useless on its own. Dereferencing requires a second thing: a `PointsTo<V>` token, a proof-only value that is nonetheless *borrow-checked* like real data. The token carries ghost state — which pointer it governs (`perm.pptr()`) and whether the memory is initialized (`perm.mem_contents()`, either `MemContents::Uninit` or `MemContents::Init(v)`).

The API encodes the access discipline in ordinary Rust ownership:

```rust
// Allocate: you receive the address AND the permission token.
pub exec fn new(v: V) -> (pt: (PPtr<V>, Tracked<PointsTo<V>>))
    ensures
        pt.1@.pptr() == pt.0,
        pt.1@.mem_contents() == MemContents::Init(v),

// Read: shared borrow of the permission.
pub exec fn read(self, Tracked(perm): Tracked<&PointsTo<V>>) -> (out_v: V)
    where V: Copy,
    requires
        perm.pptr() == self,
        perm.is_init(),
    ensures
        out_v == perm.value(),

// Write: mutable borrow.
pub exec fn write(self, Tracked(perm): Tracked<&mut PointsTo<V>>, in_v: V)
    where V: Copy,
    requires
        old(perm).pptr() == self,
    ensures
        perm.mem_contents() == MemContents::Init(in_v),

// Free: consumes the token outright.
pub exec fn free(self, Tracked(perm): Tracked<PointsTo<V>>)
    requires
        perm.pptr() == self,
        perm.is_uninit(),
```

Read the ownership annotations as a safety proof and the classic bug classes evaporate without the solver being consulted:

- **Use-after-free** requires using a `PointsTo` after passing it to `free`. `free` takes it by value, so that is a move-after-move — rejected by the borrow checker.
- **Double-free** is the same violation, twice.
- **Reading uninitialized memory** fails the `perm.is_init()` precondition, which is a local, cheap check.
- **Aliasing the wrong pointer** fails `perm.pptr() == self`. You cannot fabricate a token for an address you do not own, because tokens are only created by allocation.

Note also that `free` demands `is_uninit()` — you must first move the value out, leaving the token uninitialized, before releasing the memory. Leaks of a `Drop` type are structurally impossible to hide.

The economic point: none of the above costs Z3 anything. The solver never enumerates alias sets, because the type checker already proved there is at most one mutable token per location. Z3 sees a program that behaves as though it were purely functional.

## Where the Effort Actually Goes: Triggers

Having removed aliasing from the solver's plate, the dominant cost becomes quantifier instantiation — and this is the part that surprises engineers new to SMT-based verification. A `forall|i: int|` covers infinitely many values, so the solver cannot expand it. It instead matches syntactic patterns called *triggers*:

```rust
forall|i: int| 0 <= i < s.len() ==> #[trigger] is_even(s[i]),
```

The solver now watches for terms shaped like `is_even(s[...])`. Proving `assert(is_even(s[3]))` produces exactly that shape, instantiates at `i = 3`, and succeeds. Change the goal slightly and the same quantifier becomes inert:

```rust
assert(s[3] % 2 == 0); // FAILS: nothing here mentions is_even
```

The fact is a one-step unfolding away, and the solver will not take that step, because nothing triggered the instantiation. You fix it either by asserting `is_even(s[3])` first, or by widening the pattern:

```rust
forall|i: int| 0 <= i < s.len() ==> is_even(#[trigger] s[i]),
```

The trade-off is symmetric and unavoidable. Broader triggers make relevant instantiations more likely — and irrelevant ones more likely too, each one more junk in the solver's context. Narrow triggers keep verification fast right up until the proof mysteriously stops going through. Triggers must also mention every bound variable and cannot be built from equality, arithmetic, or boolean operators; `#[trigger](0 <= i)` is rejected outright, because a pattern that matches every nonnegative integer in the program is not a pattern.

This is the real skill in proof engineering, and it is a genuinely new one: reasoning about *why the solver did not think of something*, which is closer to query-plan debugging than to programming.

## Induction Without an Induction Tactic

Verus deliberately has no separate proof language — specs and proofs are Rust syntax, checked by Rust's own type checker. So how do you prove something an SMT solver structurally cannot, like an inductive fact? You write a recursive function whose `ensures` clause *is* the induction hypothesis:

```rust
spec fn sum_to(n: nat) -> nat
    decreases n
{
    if n == 0 { 0 } else { n + sum_to((n - 1) as nat) }
}

proof fn lemma_sum_to_monotone(i: nat, n: nat)
    requires i <= n,
    ensures sum_to(i) <= sum_to(n),
    decreases n
{
    if i < n {
        lemma_sum_to_monotone(i, (n - 1) as nat);  // the inductive step
    }
}
```

The recursive call *is* the appeal to the hypothesis; `decreases n` is the termination argument that makes the induction well-founded rather than circular. This lemma is not academic — a loop accumulating `sum_to` into a `u32` needs exactly this monotonicity fact to discharge its overflow check, since knowing the final sum fits tells you nothing about the intermediates unless you know the sequence is nondecreasing.

## The Honest Read

Verus supports a *subset* of Rust, and explicitly does not verify itself, `rustc`, or LLVM. Your proof is conditional on a large trusted computing base. It is also, as the project says, under active development.

But the architecture has been vindicated by things shipping: verified crash consistency for persistent-memory stores (PoWER, OSDI 2025), formally verified X.509 validators and parser/serializer generators (Verdict and Vest, USENIX Security 2025), a verified mimalloc derivative, verified NUMA-aware node replication. The transferable lesson is not "verify everything." It is that the way to make verification tractable is to find the sub-problems that a cheap, syntactic, local analysis can kill — and refuse to let them reach the solver at all. Rust's borrow checker turned out to be exactly that analysis, sitting in a language people already write kernels in.
