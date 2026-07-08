---
title: "Memory Tagging Extensions: Hardware-Assisted Memory Safety Without the Performance Tax"
date: 2026-07-09
tags: ["memory-safety", "arm", "mte", "security", "systems"]
excerpt: "ARM's Memory Tagging Extensions (MTE) catch use-after-free and buffer overflows in hardware with 3-5% overhead, compared to 100%+ for software sanitizers. How tag coloring, lock-and-key validation, and probabilistic detection achieve what decades of software-only approaches could not."
---

For thirty years, memory safety vulnerabilities have dominated security advisories. Use-after-free, heap buffer overflow, and stack corruption account for roughly 70% of high-severity CVEs in systems code. Software sanitizers like AddressSanitizer (ASan) detect these at 2x slowdown, making them unusable in production. Hardware Memory Tagging Extensions (MTE), introduced in ARMv8.5-A and shipping in production silicon since 2023, fundamentally change this equation: probabilistic detection of memory safety violations at 3-5% overhead, running in production workloads.

## The Lock-and-Key Model

MTE implements a conceptually simple "lock and key" scheme. Every 16-byte aligned granule of memory gets a 4-bit tag (the "lock"), and every pointer carries a 4-bit tag in its top byte (the "key"). On every memory access, the hardware compares the pointer's tag against the memory's tag. A mismatch means the pointer shouldn't be accessing that memory.

```
Pointer layout (AArch64 with MTE):
┌────────┬────┬──────────────────────────────────┐
│ 63..60 │59:56│        55:0 (virtual address)     │
│ (sign) │ TAG │                                    │
└────────┴────┴──────────────────────────────────┘

Memory tags: stored in a separate metadata space
  Every 16-byte granule → 4-bit tag
  Tag storage overhead: 3.125% of physical memory
```

The 4-bit tag space gives 16 possible values (0x0-0xF). When an allocator hands out memory, it assigns a random tag different from the previous allocation at that address. With 15 possible non-matching values, each use-after-free has a 93.75% probability of immediate detection on first access.

## Hardware Implementation

MTE introduces five new instructions that the memory allocator and runtime use:

```c
// IRG: Insert Random Tag - generate a random tag in a register
// ADDG: Add with Tag - compute tagged pointer with offset
// STG: Store Tag - set the memory tag for a 16-byte granule
// LDG: Load Tag - read the memory tag for a granule
// SUBP: Subtract Pointer - compute distance ignoring tags

// Setting up a tagged allocation (what malloc does internally):
void *tagged_alloc(size_t size) {
    void *ptr = internal_alloc(round_up(size, 16));
    
    // Generate random tag, excluding the previous tag at this address
    // IRG instruction: Xd = random_tag(Xn, exclude_mask)
    ptr = __arm_mte_create_random_tag(ptr, 0);
    
    // Color the memory granules with the chosen tag
    // STG instruction: store tag to [Xn + offset]
    __arm_mte_set_tag(ptr);
    for (size_t i = 16; i < size; i += 16) {
        __arm_mte_set_tag(ptr + i);
    }
    
    return ptr;  // Returns pointer with tag embedded in bits [59:56]
}
```

The critical insight: tag checking happens in the memory controller, not as an extra pipeline stage. Load and store operations that already go to the L1 cache simply compare tags as part of the existing access. This is why overhead is so low, the check is essentially free when data is cache-resident.

## Detecting Use-After-Free

When `free()` is called, the allocator changes the memory's tag to a different random value. Any dangling pointer still carries the old tag:

```c
char *ptr = tagged_malloc(64);    // ptr tag = 0x7
// Memory granules at ptr are tagged 0x7
strcpy(ptr, "hello");             // tag check: 0x7 == 0x7 ✓

tagged_free(ptr);                 // Memory re-tagged to 0xB
// ptr still has tag 0x7 in bits [59:56]

printf("%s\n", ptr);              // tag check: 0x7 != 0xB ✗ FAULT
```

The re-tagging on free is what makes this work. Even if the memory is immediately reused by a subsequent allocation, the new allocation gets a fresh random tag. The dangling pointer's stale tag won't match.

## Detecting Buffer Overflows

Adjacent allocations receive different tags. Overflowing one buffer crosses into a differently-tagged granule:

```c
char *buf_a = tagged_malloc(32);  // tag = 0x3, covers granules [0..1]
char *buf_b = tagged_malloc(32);  // tag = 0xA, covers granules [2..3]

// Linear overflow from buf_a into buf_b:
memcpy(buf_a, data, 48);
// First 32 bytes: tag 0x3 == 0x3 ✓
// Byte 32 onward: tag 0x3 != 0xA ✗ FAULT
```

The 16-byte granularity means MTE catches overflows that cross a 16-byte boundary. A 1-byte overflow within the same granule won't be detected, but this is acceptable in practice because exploitable overflows almost always cross granule boundaries.

## Synchronous vs. Asynchronous Modes

MTE supports two enforcement modes, selected via system registers:

**Synchronous mode (PSTATE.TCO=0, SCTLR_EL1.TCF=0b01):** A tag mismatch generates an immediate synchronous exception. The faulting instruction is identified precisely. This mode is ideal for testing and debugging but costs more because speculative execution past a potential fault is limited.

**Asynchronous mode (SCTLR_EL1.TCF=0b10):** Tag mismatches are accumulated in TFSR_EL1 (Tag Fault Status Register) and delivered asynchronously, typically at the next kernel entry point. The faulting instruction is not precisely identified, but overhead drops to under 3% because the pipeline never stalls on tag checks.

```c
// Linux kernel interface for setting MTE mode per-thread:
#include <sys/prctl.h>

// Enable async MTE for heap allocations
prctl(PR_SET_TAGGED_ADDR_CTRL,
      PR_TAGGED_ADDR_ENABLE |
      PR_MTE_TCF_ASYNC |          // Async mode (low overhead)
      (0xfffe << PR_MTE_TAG_SHIFT), // Exclude tag 0 from randomization
      0, 0, 0);
```

Production deployments typically use async mode. The trade-off: you know *that* corruption happened but not the exact instruction. Combined with core dumps and tag metadata, this is sufficient for post-mortem analysis.

## Allocator Integration: Scudo

The Scudo hardened allocator (default in Android and Fuchsia) integrates MTE natively. Its design is instructive:

```
Scudo chunk layout with MTE:
┌──────────────────┬─────────────────────┬──────────────┐
│  Header (16B)    │    User data         │  Padding     │
│  tag = 0x0       │    tag = random      │  tag = diff  │
└──────────────────┴─────────────────────┴──────────────┘
         ▲                                       ▲
    Header gets tag 0        Padding gets a different tag
    (never user-accessible)  (catches right-side overflow)
```

Key design decisions in Scudo's MTE integration:

1. **Tag 0 is reserved** for chunk headers and free memory, so accessing freed memory or corrupting headers is always caught.
2. **Odd/even quarantine alternation:** freed chunks cycle between two tag "colors" so that immediate reuse of a virtual address still differs from the previous tag.
3. **Size class alignment:** all size classes are multiples of 16 bytes, guaranteeing every allocation starts on a granule boundary.

## Performance Characteristics

Measured overhead on real workloads (Cortex-X3 silicon, Android 14):

| Mode | Overhead (CPU) | Memory | Detection probability |
|------|---------------|--------|----------------------|
| Off | 0% | 0% | 0% |
| Async | 1-3% | 3.125% | 93.75% per access |
| Sync | 5-15% | 3.125% | 93.75% per access |
| ASan (software) | 100-200% | 200-300% | ~100% deterministic |

The 3.125% memory overhead comes from tag storage: 4 bits per 16 bytes = 0.5 bytes per 16 bytes. Modern ARM SoCs dedicate physical memory for this tag store, accessible only to the memory controller.

## Stack Tagging

MTE isn't limited to heap allocations. The compiler can instrument stack frames:

```c
// Compiled with -fsanitize=memtag-stack
void vulnerable() {
    char buf[16];     // Gets random tag at function entry
    int secret = 42;  // Gets different random tag
    
    // Stack overflow from buf into secret:
    gets(buf);        // Crossing into secret's granule → FAULT
}
// Tags are reset on function return (STG with tag 0)
```

Stack tagging adds per-function prologue/epilogue cost for the STG instructions that color and uncolor the stack granules. In practice this adds 2-5% overhead for stack-heavy code, which is why it's typically opt-in per compilation unit.

## Comparison with Intel's Approach

Intel's Linear Address Masking (LAM) provides the top-byte-ignore (TBI) capability that enables software tagging schemes, but without hardware tag checking. The comparison illustrates why hardware enforcement matters:

| Feature | ARM MTE | Intel LAM + Software |
|---------|---------|---------------------|
| Tag storage | Dedicated HW memory | Shadow memory (software) |
| Check cost | Free (in cache logic) | Extra load per access |
| Granularity | 16 bytes | Configurable |
| Tag bits | 4 | Up to 7 (LAM57) |
| Overhead | 3-5% | 15-30% |

## Limitations and the Path Forward

MTE is probabilistic, not deterministic. With 4-bit tags, each mismatch has a 1/16 chance of going undetected. For security-critical contexts, two mitigations exist:

1. **Double-checking:** access the same memory with two differently-derived pointers, reducing miss probability to 1/256.
2. **Asymmetric mode (MTE3):** proposed extensions that use 8-bit tags for heap metadata, reducing evasion probability to 1/256 per access.

The 16-byte granularity means intra-granule overflows (1-15 bytes within the same aligned block) are invisible. Hardware-based bounds checking (like CHERI capabilities) solves this completely but at much higher silicon cost.

## Practical Deployment

As of 2025, MTE is enabled by default in Android's native allocator for system processes. Google reports that MTE-enabled Pixel devices detect memory corruption that would otherwise become exploitable vulnerabilities, with no user-perceptible performance impact in async mode.

For server workloads, ARM Neoverse V2 and N3 cores support MTE, enabling cloud providers to offer hardware-assisted memory safety for C/C++ services. The key enablement path: recompile with `-fsanitize=memtag-heap`, link against an MTE-aware allocator, and set the process-level prctl flags.

Memory safety has long been framed as a binary choice: accept C/C++'s dangers or rewrite in Rust. MTE offers a third path, not as complete as a safe language, but deployable today on existing codebases with minimal engineering effort and negligible runtime cost. For the billions of lines of C/C++ that won't be rewritten, that's a significant shift in the security landscape.
