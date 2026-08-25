---
title: "Fil-C: Memory-Safe C With 64-Bit Pointers and a Concurrent GC"
date: 2026-08-25
tags: [memory-safety, compilers, garbage-collection, capabilities, systems]
excerpt: "Every serious attempt at memory-safe C has broken the ABI: fat pointers grow to 128 or 256 bits, structs change layout, and nothing links against anything. Fil-C keeps pointers at 64 bits by storing the capability in an invisible parallel allocation the C program cannot address, then pays for the resulting dangling-capability problem with a concurrent on-the-fly garbage collector. The result compiles CPython, OpenSSH, and Emacs unmodified at roughly 1.5x to 4x native speed."
---

There are two accepted answers to "how do we stop C from being exploitable." Rewrite it in Rust, which works but costs years per codebase. Or add hardware capabilities — CHERI, which works but requires a CPU you probably do not have and pointers that are 128 bits wide. Fil-C, Filip Pizlo's memory-safe implementation of C and C++, takes a third path: keep the pointer 64 bits, keep struct layout intact, check every access, and accept that this forces a garbage collector into your C program.

The version numbering (0.684 as of August 2026) undersells how far it has gotten. Pizlix, a Linux userland built entirely with it, runs a GUI. CPython, OpenSSH, GNU Emacs, and Wayland compile and run. Overhead is roughly 1.5x in good cases and about 4x in bad ones.

## Why fat pointers keep failing

To bounds-check `p[i]` you need the bounds, and every scheme that carried them alongside the pointer has died on ABI compatibility. Fil-C's own lineage is a useful graveyard:

| Scheme | Pointer size | Why it died |
|---|---|---|
| PLUT | 256 bits | Type needed at allocation; no unions; not thread-safe; use-after-free undetected |
| SideCaps | 256 bits | Thread-safe, but ~200x slowdown |
| MonoCaps | 128 bits | ~10x overhead; required a GC; types revealed only monotonically |
| InvisiCaps | **64 bits** | Current design; ~4x worst case, full union support |

The problem is not just `sizeof(void*)`. A wider pointer changes every struct layout, every serialized format that ever saw a pointer, and every calling convention. CHERI takes that hit deliberately and compensates with hardware; Fil-C refuses it entirely.

## InvisiCaps: the capability nobody can address

The trick is that a pointer means two different things depending on where it lives.

**In flight** — in a register, a local, a spill slot — a pointer is two values:

- the **intval**: the raw 64-bit integer the C program sees, does arithmetic on, casts, prints, compares. Fully program-controlled and *completely untrusted* by the runtime.
- the **lower**: the object's base, handed out by the allocator and inherited by every pointer derived from that allocation. The program cannot modify it, so it is trusted.

The upper bound is not in the register pair. `lower` points just above a 16-byte `filc_object` header holding the upper bound and an `aux` word, so the runtime reaches it by subtracting backwards. A non-pointer access lowers to roughly:

```c
// p = (intval, lower); accessing sizeof(T) bytes
filc_object *hdr = (filc_object *)lower - 1;   // header sits below the base
if (!lower || intval < lower || intval + sizeof(T) > hdr->upper)
    filc_panic("cannot access pointer outside bounds");
// ...then the real load/store
```

Two compares and a load. Note what *isn't* there: no tag extraction, no shadow-memory lookup, no probabilistic check.

**At rest** — stored in the heap — the pointer splits. The intval stays in the payload exactly where C put it. The lower goes into an **aux allocation**: a parallel buffer, created lazily the first time any pointer is stored into the object, sized to the payload, and pointed to by the header's `aux` word. Crucially, *no capability's bounds ever cover an aux allocation*. The metadata is not merely conventionally private; it is unaddressable from the program's point of view. Hence "invisible." The invariant is inductive: every flight pointer's `lower` points above a header whose `aux` word yields the lowers for every pointer inside that payload.

The consequences are the elegant part:

- **Int/pointer unions just work.** A slot can hold a pointer today and an `int` tomorrow. Write an integer over a pointer and you have clobbered the intval; the stale lower in the aux allocation is still a *valid* lower, just not one that authorizes the address you now hold, so the access traps.
- **Capabilities cannot be forged.** Load an integer as a pointer and you get a null or stale lower — never an attacker-chosen one. Cast a pointer to `uintptr_t` and you get the intval, with no capability attached.
- **Races stay safe.** Torn reads across the payload/aux split yield *some* valid lower, not a synthesized one — precisely the hole SoftBound left open, and the reason SideCaps needed 256-bit atomics to close it.

Atomic pointers are the exception. The aux entry's low bit tags its meaning: 0 for a plain lower, 1 for an **atomic box** — a 16-byte, 16-byte-aligned cell holding the whole flight pointer, mutated with the 128-bit atomics x86-64 and ARM64 both provide. Lock-free pointer algorithms stay genuinely lock-free, and this is the only place the 128-bit figure survives.

## The space bill

Lazy aux allocation makes overhead wildly shape-dependent. Modelling it as `16 + payload + (payload if any pointer stored else 0)`:

```
char buf[4096]                       payload= 4096  →  4112   1.004x
struct { double x, y; }              payload=   16  →    32   2.00x
struct { void *next; int v; }        payload=   16  →    48   3.00x
struct { void *a, *b, *c, *d; }      payload=   32  →    80   2.50x
```

String buffers and framebuffers — the bulk of most heaps by bytes — pay essentially nothing, because they never get an aux allocation at all. Small pointer-dense nodes are the worst case at 3x, which is where the 4x time figure comes from too.

## Why this forces a garbage collector

Here is what makes Fil-C a systems story rather than a compiler story. A stale lower must remain *safe to dereference as metadata*. If `free()` returned the header to the allocator and something else reused it, a stale lower would read an attacker-influenced upper bound, and the trust model collapses.

So Fil-C redefines `free()` without rewriting a single call site: freeing sets `upper = lower`, producing an object that permits zero accesses, so every subsequent read or write traps deterministically. `free()` becomes advisory; the collector reclaims the memory whether you call it or not, and repoints pointers to freed objects at a "free singleton." Use-after-free stops being a probabilistic exploit primitive and becomes a reproducible crash.

The collector is **FUGC**: parallel, concurrent, on-the-fly, grey-stack, Dijkstra, accurate, non-moving. Three of those adjectives matter:

**On-the-fly** means no stop-the-world. FUGC uses *soft handshakes* (ragged safepoints): each thread runs a callback on its own schedule. The only pause a thread sees is that callback, bounded by its own stack height — typically shorter than a slow path through `malloc`. For threads blocked in syscalls, the collector runs the callback itself.

**Grey stack** means stacks are rescanned to a fixpoint rather than once: handshake to scan stacks, mark until the mark stacks drain, handshake again, repeat. Objects allocated during a cycle are pre-marked (black allocation), so it converges in a couple of iterations.

**Store barrier only.** This is the payoff of the grey stack. Classic Dijkstra collectors need a load barrier; FUGC does not, so pulling a heap pointer into a local is completely uninstrumented — which matters enormously when the collected language is C:

```c
// heap pointer store, when marking is active
static inline void filc_store_barrier(filc_object *target) {
    if (!__atomic_load_n(&fugc_marking, __ATOMIC_RELAXED)) return;  // fast path
    if (filc_is_marked(target)) return;
    filc_mark_relaxed_cas(target);   // slowest path: relaxed CAS + push to mark stack
}

// pollcheck, emitted often enough to bound progress
if (__builtin_expect(thread->poll_flag, 0)) filc_pollcheck_slow(thread);
```

The barrier's slow path — GC running *and* target unmarked — is a relaxed CAS. The pollcheck fast path is a load and a branch. Sweeping is SIMD over bitvectors on top of libpas's Verse heap config, and reportedly consumes under 5% of collector time.

The same handshake machinery supports true stop-the-world, used for `fork(2)` and, cleverly, for debugging — `FUGC_STW=1` makes store-barrier bugs vanish, so a bug that survives it isn't a barrier bug.

## Where it sits

Against [CHERI](/blog/cheri-concentrate-compressed-capability-bounds-allocator-alignment), Fil-C gives up near-native speed to avoid needing the silicon. Against [ARM MTE](/blog/memory-tagging-extensions-hardware-memory-safety-arm), whose 4-bit tags leave a 1-in-16 chance a wrong pointer's tag matches, Fil-C is deterministic rather than probabilistic. Against a Rust rewrite — see [Tree Borrows](/blog/tree-borrows-rust-aliasing-model-frozen-state-read-reordering) for how hard the aliasing model alone is — it gives up compile-time guarantees and steady-state performance to avoid the rewrite, and has no `unsafe` at all.

The honest limitations: violations surface as runtime panics, not compile errors, so you trade exploitability for availability. FFI to non-Fil-C libraries is heavily restricted, so your whole dependency graph has to come along — the reason Pizlix exists at all. The compiler is pinned to a specific clang. And a chunk of current overhead isn't fundamental: Pizlo attributes much of it to a calling-convention and dynamic-linking scheme layered on the existing C ABI, which roughly doubles call and link cost. The stated target is ~1.5x worst case, many programs near 1.2x.

The shape of the trade is the interesting part. Fil-C says the price of memory-safe C is not a wider pointer and not new silicon — it is a garbage collector, a store barrier, and pollchecks in your hot loops. Most C programmers would have declared that bill unpayable on principle. But 1.5x with a collector that never stops your threads, in exchange for deleting an entire vulnerability class from a codebase you do not have to rewrite, is a much closer call than it sounds.
