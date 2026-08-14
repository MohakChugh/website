---
title: "Copy-and-Patch Compilation: Machine Code at 2 Nanoseconds per Instruction"
date: 2026-08-15
tags: ["compilers", "jit", "python", "code-generation", "performance"]
excerpt: "A JIT that emits code faster than it can parse its own input sounds like cheating. Copy-and-patch gets there by refusing to compile at all: it precompiles every operation with holes in it at build time, then memcpy's the pieces together and patches the holes. It is the whole reason CPython now ships a JIT, and I measured it at 2.2 nanoseconds per micro-op."
---

Every runtime compiler faces the same unpleasant curve. Interpreters start instantly and run slowly. LLVM produces good code and takes milliseconds per function, which is fatal if you are compiling a SQL query that will run for four milliseconds, or a JavaScript function that may never be called twice. The usual answer is tiering: a fast baseline compiler that emits mediocre code, then an optimizing tier for the hot subset. But writing a baseline compiler is still writing a compiler, once per target architecture, including register allocation and instruction selection.

Copy-and-patch, introduced by Haoran Xu and Fredrik Kjolstad (OOPSLA 2021, arXiv:2011.13127), takes the tradeoff off the table by moving all of the compilation to build time. The idea: for each operation in your IR, precompile the machine code once, ahead of time, leaving *holes* where the runtime-specific values go. The paper calls these fragments **stencils**, "because they have holes where missing values must be inserted during code generation." Code generation degenerates into `memcpy` plus a handful of stores.

The claimed results are aggressive: for an SQL query compiler built on their metaprogramming layer, codegen is "two orders of magnitude faster than LLVM -O0 and three orders of magnitude faster than higher optimization levels," while the emitted code runs 14% *faster* than LLVM -O0 output. Their WebAssembly compiler beats Liftoff, Chrome's baseline Wasm compiler, by 4.9x to 6.5x on compile time and 39% to 63% on generated code quality.

This is also, as of Python 3.14, shipping in the Windows and macOS binary releases of CPython. So the mechanism is worth understanding precisely.

## A stencil is just a relocatable object file

Here is the trick that makes the whole technique feel obvious in retrospect: the compiler already emits code with holes in it. We call the holes **relocations**.

Take a single micro-op, "add a constant to the accumulator, then continue to the next micro-op," written in the style CPython uses:

```c
#include <stdint.h>
extern int64_t _JIT_CONTINUE(int64_t acc);

static inline int64_t operand(void) {
    int64_t v;   // two 16-bit immediate slots to be patched later
    __asm__ volatile("movz %0, #0xbeef\n\tmovk %0, #0xdead, lsl #16" : "=r"(v));
    return v;
}

int64_t _JIT_ENTRY(int64_t acc) {
    acc += operand();
    __attribute__((musttail)) return _JIT_CONTINUE(acc);
}
```

Compiled with `clang -c -O2` on arm64, that is sixteen bytes:

```
__JIT_ENTRY:
   0: mov   x8, #0xbeef
   4: movk  x8, #0xdead, lsl #16
   8: add   x0, x8, x0
   c: b     0xc                 <- ARM64_RELOC_BRANCH26, extern, _JIT_CONTINUE
```

One relocation record, at offset `0xc`, saying "this branch target is unknown; the linker will fill it in." Copy-and-patch simply declines to invoke a linker at build time and does the fill-in at runtime instead, once the addresses are known. The `movz`/`movk` pair is the second kind of hole: a 32-bit constant materialized in two 16-bit immediate fields, which the emitter overwrites with the actual operand.

CPython formalizes this in `Tools/jit/_stencils.py`, whose docstrings are refreshingly blunt. `Hole` is "analogous to relocation records in an object file," `Stencil` is "analogous to a section or segment in an object file," and `StencilGroup`, the code plus data for one micro-op, is "analogous to an entire object file." The build step compiles `Tools/jit/template.c` once per micro-opcode, parses the resulting COFF/ELF/Mach-O with `llvm-readobj`, and emits a `jit_stencils.h` of byte arrays and patch calls. LLVM is a build-time dependency only; nothing ships to users.

The hole *values* are a small enum: `CODE` and `DATA` (the bases of this micro-op's code and data), `OPARG`, `OPERAND0`, `OPERAND1`, `TARGET`, `JUMP_TARGET`, `ERROR_TARGET`. The hole *kinds* are literally relocation type names, one set per target: `R_AARCH64_CALL26`, `R_X86_64_GOTPCRELX`, `ARM64_RELOC_PAGE21`, `IMAGE_REL_AMD64_REL32`. Each maps to a tiny C patch function, named by width and behavior: `patch_64`, `patch_32r` for PC-relative, `patch_x86_64_32rx` where the `x` means *relaxing* (a GOT load that can be rewritten into an immediate add when the target is close enough), `patch_aarch64_16a` through `16d` for the four `MOVW` immediate slots, and `patch_aarch64_trampoline` when a branch cannot reach its target in 26 bits.

## Patching, and why the pieces stay glued

The emitter side is arithmetic on instruction encodings. For arm64:

```python
def patch_26r(buf, off, target):        # b/bl: imm26 = (target - pc) / 4
    imm = ((target - off) >> 2) & 0x03FFFFFF
    w = struct.unpack_from("<I", buf, off)[0]
    struct.pack_into("<I", buf, off, (w & ~0x03FFFFFF) | imm)

def patch_16(buf, off, imm16):          # movz/movk: imm16 sits at bits 5..20
    w = struct.unpack_from("<I", buf, off)[0]
    struct.pack_into("<I", buf, off, (w & ~(0xFFFF << 5)) | ((imm16 & 0xFFFF) << 5))

def emit(trace):                        # trace: [(stencil, operand), ...]
    buf, starts = bytearray(), []
    for s, _ in trace:
        starts.append(len(buf)); buf += s.body          # copy
    for i, (s, operand) in enumerate(trace):            # patch
        for h in s.jump_holes:
            patch_26r(buf, starts[i] + h, starts[i + 1])
        if s.const_holes:
            patch_16(buf, starts[i] + s.const_holes["lo"], operand & 0xFFFF)
            patch_16(buf, starts[i] + s.const_holes["hi"], operand >> 16)
    return bytes(buf)
```

That is the entire backend. I built three stencils (`add`, `mul`, `ret`), emitted the trace `[(add,5), (mul,3), (add,100), ret]` into an `mmap`ed page, flipped it to `PROT_READ|PROT_EXEC`, and called it through `ctypes`: it returned 115, which is `(0 + 5) * 3 + 100`. A 1001 micro-op trace, checked against a Python model of the same arithmetic, matched exactly including 64-bit wraparound.

The reason a chain of independently compiled stencils works at all is the `musttail` attribute. CPython's template ends every micro-op with

```c
#define PATCH_JUMP(ALIAS)                                          \
do {                                                               \
    DECLARE_TARGET(ALIAS);                                         \
    __attribute__((musttail)) return ALIAS(current_executor, frame, \
        stack_pointer, tstate, _tos_cache0, _tos_cache1, _tos_cache2); \
} while (0)
```

used three ways: `_JIT_CONTINUE` for fall-through, `_JIT_JUMP_TARGET` for a failed guard, `_JIT_ERROR_TARGET` for an exception. Guaranteed tail calls mean an arbitrarily long trace becomes a chain of unconditional branches with no stack growth, which is why Clang is a hard requirement (GCC has no `musttail`). The signature carries `__attribute__((preserve_none))`, telling the compiler it need not preserve callee-saved registers, so the frame pointer, stack pointer, thread state, and three top-of-stack cache slots stay pinned in registers across the entire trace. Dispatch overhead does not get optimized away, it stops existing.

## The numbers

I implemented the emitter in C to measure it honestly: `memcpy` of a 16-byte stencil plus three patches, repeated for a 1001 micro-op trace, 2000 times.

```
1001 uops x 2000 reps: 4.38 ms total, 2.2 ns/uop, 2.19 us per 1001-uop trace
```

**2.2 nanoseconds per micro-op**, or 16 KB of machine code in 2.2 microseconds. For a rough contrast, I compiled a C function containing the equivalent straight-line arithmetic and measured clang's marginal cost by differencing 1000-op and 5000-op inputs, which cancels the ~70 ms process startup: **8.7 µs per operation pair at -O0**, 7.5 µs at -O2. That specific ratio flatters copy-and-patch, since clang is also parsing C and building IR, but the shape is the point. Codegen stops being a cost you budget for. The paper's cleaner version of this claim is that their compiler emits code from an AST faster than the AST itself can be built.

The other half of the ledger is what you give up. Every stencil boundary is an ABI boundary, so there is no cross-micro-op register allocation, no constant folding across operations, no dead store elimination. This is why PEP 744 reported CPython's JIT as merely "about as fast as the existing specializing interpreter," with 10 to 20% more memory. All the headroom has to come from the tier 2 micro-op optimizer that runs *before* codegen, narrowing types and removing redundant guards, plus the "burning in" of oparg and operand values that the interpreter would otherwise re-read from memory. A template JIT does not make your compiler smarter, it makes your IR the only place where smartness can live.

Which is exactly the tradeoff worth internalizing. If you generate your interpreter from a specification, as CPython does from `Python/bytecodes.c`, you get a code generator for every supported architecture nearly free, because the compiler you already trust does the instruction selection at build time and relocations do the rest. The same trick is why Python 3.14 also ships an optional tail-call *interpreter* (3 to 5% faster on pyperformance, from the same `musttail` insight applied with no codegen at all), and why database engines with sub-millisecond query budgets keep rediscovering it. When compile time is on the critical path, the fastest compiler is one that has already finished compiling.
