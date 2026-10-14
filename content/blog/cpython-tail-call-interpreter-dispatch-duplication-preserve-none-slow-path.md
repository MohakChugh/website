---
title: "CPython's Tail-Call Interpreter on an M3 Pro: Collapsing 212 Dispatch Branches to 8 Costs Nothing, and preserve_none Only Shows Up on the Slow Path"
date: 2026-10-14
tags: ["interpreters", "compilers", "cpython", "llvm", "performance"]
excerpt: "Python 3.14 added an interpreter built from tail-calling C functions. The first benchmarks claimed 10-15%. Later work traced most of that to an LLVM 19 regression that merged computed-goto dispatch, which put the real gain at 1-5%. I built a 214-opcode toy VM in three dispatch styles and ran it on an Apple M3 Pro. Forcing the dispatch from 212 indirect branches down to 8 changed nothing, while switch dispatch lost about one cycle per opcode. preserve_none left the fast path byte-for-byte identical and only made the slow path cheaper."
---

# CPython's Tail-Call Interpreter on an M3 Pro: Collapsing 212 Dispatch Branches to 8 Costs Nothing, and preserve_none Only Shows Up on the Slow Path

Python 3.14 ships an opt-in interpreter (`--with-tail-call-interp`, from gh-128563). In it, every bytecode is a small C function that ends by tail-calling the next one. The release notes promise a 3-5% geometric-mean gain on pyperformance, "depending on platform and architecture". They note the baseline is CPython built with Clang 19, and that only Clang 19+ on x86-64 and AArch64 is supported. The first numbers in the PR were 10-15%.

The gap between those two figures was found by Nelson Elhage. LLVM 19 added size limits to the tail-duplication pass (llvm/llvm-project#78582). For CPython, those limits stopped Clang from copying the computed-goto dispatch into each handler. `_PyEval_EvalFrameDefault` went from 332 indirect jumps under Clang 18 to 3 under Clang 19. So the "baseline" was a regressed build, about 9% slower than Clang 18 on a Raptor Lake machine and about 12% slower on an M1. A fix (llvm/llvm-project#114990) landed soon after. Measured against a sound baseline, the tail-call interpreter is worth roughly 1-5%. Elhage also wrote that only about 2% of the regression came from dispatch duplication, and that he could not explain the rest.

That leaves two questions worth testing outside CPython. How much is per-handler dispatch actually worth on a modern core? And what does `preserve_none` buy? I wrote a toy VM to measure both.

## Three ways to dispatch

All three variants share the same opcode bodies and differ only in how control reaches the next handler:

```c
/* 1. switch: one shared jump table, one indirect branch */
for (;;) switch (ip->op) { case ADD: BIN(+) break; /* ... */ }

/* 2. computed goto: each handler ends with its own `goto *` */
static void *T[] = { &&l_PUSH, &&l_LOAD, /* ... */ };
#define NEXT goto *T[ip->op]
l_ADD: BIN(+) NEXT;

/* 3. tail calls: one function per opcode, guaranteed jump, never a call */
#define PN __attribute__((preserve_none))
typedef PN int64_t (*H)(const Instr *, int64_t *, int64_t *);
#define NEXT __attribute__((musttail)) return TT[ip->op](ip, sp, L)
static PN int64_t h_ADD(const Instr *ip, int64_t *sp, int64_t *L) { BIN(+) NEXT; }
```

`musttail` makes the compiler emit a jump, or else fail to compile. `preserve_none` declares that the callee saves no registers. That makes the interpreter state (`ip`, `sp`, locals) free to sit in whichever registers the convention picks.

The workload counts primes below 1,000,000 by trial division in a stack bytecode. It runs 819,669,814 dispatches and gives the right answer (78,498) in every variant. The table holds 14 live opcodes plus 200 distinct filler handlers, which puts it at 214 entries. That is close to CPython's opcode count, where per-opcode tail duplication gets expensive. Build: Apple clang 21, `-O2`, best of 7 runs, two interleaved rounds per binary.

| Variant | Indirect branches in loop | Time (s) | ns / dispatch |
|---|---|---|---|
| switch | 1 | 1.262-1.283 | 1.55 |
| computed goto (duplicated) | 212 | 1.064-1.080 | 1.31 |
| computed goto, collapsed (`-mllvm -disable-tail-duplicate`) | 8 | 1.052-1.067 | 1.29 |
| tail calls + `preserve_none` | 1 per handler | 1.057-1.063 | 1.29 |
| tail calls, no `preserve_none` | 1 per handler | 1.062-1.081 | 1.31 |

## Finding 1: collapsing the dispatch doesn't hurt here

First I tried to reproduce the LLVM 19 shape. I couldn't: Apple clang 21 duplicates the dispatch at every table size I tried. At 14 opcodes it emits 16 `br xN`, at 78 opcodes 77, and at 214 opcodes 212. Raising or lowering `-tail-dup-pred-size` and `-tail-dup-indirect-size` changed nothing, which fits a toolchain that already contains the #114990 fix. To get the collapsed shape I had to disable the pass entirely. That leaves 8 indirect branches, close to the 3 that Elhage counted.

Even so, the collapsed binary was no slower. It was marginally faster in both rounds, within noise. Per-handler indirect branches exist for the reason Ertl and Gregg gave in 2003. A single shared `br` gives the predictor one site, which can only remember one target. Replicated branches give each predecessor opcode its own history. Predictors with indirect-target tagging and global history, such as ITTAGE, already use the path that led to the branch, so the replicated sites carry information the predictor mostly has. Rohou, Swamy and Seznec made this argument in 2015 ("Branch Prediction and the Performance of Interpreters: Don't Trust Folklore"), and Elhage cites recent work putting the gain at 2-4%. On an M3 Pro and this workload, I measured about 0%.

So whatever cost CPython the rest of its 9-12% is something a 214-opcode toy lacks. Candidates are large handlers, register pressure in a single function with hundreds of labels, and code layout after the merge. My toy cannot separate those, and I won't claim it can.

## Finding 2: the switch's cost is about one cycle of decode

The switch variant is the slow one at 19%, which works out to 0.24 ns per dispatch. At the P-core's roughly 4 GHz, that is about one cycle. The number of indirect branches cannot explain it, because the collapsed goto build has almost as few and runs at full speed. The assembly suggests a cause:

```text
; switch dispatch (compressed jump table)   ; goto / tail-call dispatch
ldr   w12, [x11]          ; opcode          ldrsw x8, [x20, #8]!   ; opcode
adr   x13, LBB0_1                           ldr   x0, [x9, x8, lsl #3]
ldrb  w14, [x10, x12]     ; byte offset     br    x0
add   x13, x13, x14, lsl #2
br    x13
```

For a dense switch, LLVM's AArch64 backend emits a byte-offset jump table: load the opcode, load an offset byte, add it to a base, then branch. The goto and tail-call paths load a full pointer and branch. The switch path has one extra dependent add between the opcode load and the branch. Each switch handler also ends with an unconditional `b` back to the loop header. That is consistent with one cycle per dispatch. I haven't measured it with counters, though, since macOS doesn't expose `perf`.

## Finding 3: preserve_none changes nothing on the fast path

Removing `preserve_none` cost 0-2%, inside the run-to-run spread. To see why, I gave `STORE` a refcount-style slow path: if the overwritten slot holds a sentinel, call a `noinline dealloc()`. That is the C shape of `Py_DECREF`. Here is the handler under each convention, with the shared fast path elided:

```text
; with preserve_none: state in x20/x21/x22     ; without: state in x0/x1/x2
fast path: 12 instructions, br x0              fast path: 12 instructions, br x3
slow path:                                     slow path:
  stp  x29, x30, [sp, #-16]!                     stp  x22, x21, [sp, #-48]!
  mov  x0, x22                                   stp  x20, x19, [sp, #16]
  bl   _dealloc                                  stp  x29, x30, [sp, #32]
  ldrsw x1, [x20, #4]                            mov x19,x0 / mov x20,x1 / mov x21,x2 ...
  ldp  x29, x30, [sp], #16                       bl   _dealloc
                                                 mov x0,x19 / mov x1,x20 / mov x2,x21
                                                 ldp ... ×3
```

The fast paths are identical apart from register names. Shrink-wrapping already keeps the prologue off the fast path in both builds. On AArch64, `preserve_none` passes its leading arguments in x20 and up, which are callee-saved under the standard ABI. So when a handler calls ordinary C code, the interpreter state survives the call without being touched. Without `preserve_none`, the state sits in caller-saved x0-x2. The slow path then has to save three register pairs and shuffle six moves, all to keep values that were never at risk.

That is the real argument for `preserve_none`, and an AArch64 interpreter with a fast path that makes no calls cannot measure it. In CPython the slow paths are everywhere: deallocation, error raising, eval-breaker checks, calls into the object model. On x86-64 the System V ABI has only six argument registers, so pinning more state than that needs a custom convention. I measured neither case. These listings show the mechanism, not its size.

## What to take from this

1. **The performance of computed goto depends on a pass heuristic you don't control.** CPython lost about 10% for months because a tail-duplication threshold changed, and the source still compiled fine. `musttail` reverses this: if the compiler can't emit a jump, the build fails. Elhage made the same point, and it is the strongest case for the design. Haberman's 2021 protobuf parser and wasm3 adopted tail calls for the same reason.
2. **Check your baseline's assembly before reporting a speedup.** Counting `br`/`jmp *` in the hot function costs one `grep`. Here that check takes the claim from "10-15%" to "1-5%".
3. **Don't assume "one branch per opcode" is what makes threaded code fast.** On this core the dispatch decode chain mattered (about one cycle), and branch replication didn't.
4. **Judge `preserve_none` by its slow paths.** If your handlers never call out, you won't see it. If they call out often, as every real interpreter does, the fast path stays the same and the expensive part gets cheaper.

Caveats: this is a toy, on one machine and one compiler, without PGO. The CPython documentation says PGO is the only configuration validated for the tail-call speedup. Treat the table as a statement about dispatch mechanics, not a prediction for pyperformance.
