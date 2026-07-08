---
title: "simdjson: Parsing Gigabytes of JSON Per Second with SIMD Vectorization"
date: 2026-07-08
tags: ["simd", "json", "parsing", "performance", "data-processing"]
excerpt: "How simdjson exploits branch-free SIMD instructions to parse JSON at hardware speeds, achieving multi-gigabyte throughput by treating structural character discovery as a bitwise parallel classification problem."
---

# simdjson: Parsing Gigabytes of JSON Per Second with SIMD Vectorization

Traditional JSON parsers process input one byte at a time, branching on every character to determine its role. This serial approach leaves enormous bandwidth on the table. simdjson, developed by Daniel Lemire and Geoff Langdale (2019), reframes JSON parsing as a **branchless, data-parallel classification problem** using SIMD (Single Instruction, Multiple Data) vector instructions. The result: parsing throughput exceeding 3 GB/s on modern hardware, often limited only by memory bandwidth rather than CPU compute.

## The Two-Stage Architecture

simdjson splits parsing into two distinct stages, each designed for different parallelism characteristics.

**Stage 1: Structural Character Indexing** operates on 64-byte chunks (matching a cache line and AVX-512 register width). It identifies all structurally significant characters (`{`, `}`, `[`, `]`, `:`, `,`, `"`) and produces a compressed index of their positions.

**Stage 2: Tape Construction** walks the structural index sequentially, validating nesting, extracting values, and building an output "tape" representing the document structure.

The insight is that Stage 1, which dominates runtime in conventional parsers due to branching, becomes embarrassingly parallel with SIMD.

## Stage 1: Branchless Structural Discovery

The core innovation is processing 64 bytes simultaneously. For each chunk, simdjson answers several classification questions in parallel using bitwise operations:

### Step 1: Quote Detection and String Masking

Before identifying structural characters, simdjson must determine which bytes are inside strings (where `{` is just a character, not a structural delimiter). This requires tracking quote state across the entire input.

```cpp
// Classify which bytes are quote characters (")
uint64_t quote_bits = cmp_eq_mask(input_chunk, '"');

// Handle escaped quotes: find backslashes, compute odd-length runs
uint64_t backslash = cmp_eq_mask(input_chunk, '\\');
uint64_t escaped = compute_odd_length_prefix(backslash);
uint64_t unescaped_quotes = quote_bits & ~escaped;

// Compute in-string mask via prefix-XOR (carryless multiply by 0xFF...)
uint64_t in_string = prefix_xor(unescaped_quotes);
```

The `prefix_xor` operation is the key trick: XOR-scanning the quote bits produces a bitmask where bit `i` is 1 if an odd number of unescaped quotes appear before position `i`, meaning that position is inside a string. On x86, this maps to a single `CLMUL` (carryless multiply) instruction.

### Step 2: Structural Character Classification

With the string mask computed, structural characters are identified via SIMD comparison and masked:

```cpp
// Parallel equality comparisons (each produces 64-bit mask)
uint64_t open_brace  = cmp_eq_mask(chunk, '{') & ~in_string;
uint64_t close_brace = cmp_eq_mask(chunk, '}') & ~in_string;
uint64_t open_bracket  = cmp_eq_mask(chunk, '[') & ~in_string;
uint64_t close_bracket = cmp_eq_mask(chunk, ']') & ~in_string;
uint64_t colon = cmp_eq_mask(chunk, ':') & ~in_string;
uint64_t comma = cmp_eq_mask(chunk, ',') & ~in_string;

uint64_t structurals = open_brace | close_brace | open_bracket
                     | close_bracket | colon | comma;
```

Each `cmp_eq_mask` compiles to a `VPCMPEQB` + `VPMOVMSKB` (AVX2) or `VPCMPB` (AVX-512) sequence, comparing all 64 bytes simultaneously.

### Step 3: Index Extraction via Bit Manipulation

The structural bitmask is converted to an array of positions using `TZCNT` (trailing zero count) in a tight loop:

```cpp
while (structurals != 0) {
    index_buffer[idx++] = base_offset + __builtin_ctzll(structurals);
    structurals &= structurals - 1; // Clear lowest set bit
}
```

This loop has no data-dependent branches, the iteration count depends only on the population count of structural characters, which is predictable for typical JSON.

## The Prefix-XOR Trick: Why It Works

The quote-state computation deserves special attention. Consider the sequence:

```
Input:  He said "hello" and "bye"
Quotes: 00000000100000010000010000100000  (bit positions of ")
XOR:    00000000111111110000011111100000  (prefix XOR result)
```

After each opening quote, the XOR flips all subsequent bits to 1. After the closing quote, they flip back to 0. This correctly identifies in-string regions with zero branches and constant-time execution via `PCLMULQDQ`:

```cpp
uint64_t prefix_xor(uint64_t bits) {
    // Carryless multiply by all-ones computes running XOR
    return _mm_cvtsi128_si64(
        _mm_clmulepi64_si128(_mm_set_epi64x(0, bits),
                             _mm_set1_epi8(0xFF), 0));
}
```

This single instruction replaces what would otherwise be a 64-iteration carry-dependent loop.

## Stage 2: Tape Construction

Stage 2 walks the structural index, validating JSON grammar and building a flat "tape" representation:

```
tape[0]: root (object, pointing to matching close)
tape[1]: key "name" (string, offset into string buffer)
tape[2]: value "Alice" (string)
tape[3]: key "age" (string)
tape[4]: value 30 (integer, inline)
tape[5]: close object (pointing back to open)
```

The tape uses **type-punned 64-bit words**: the high 8 bits encode type (string, int, float, bool, null, object-open, object-close, array-open, array-close), and the low 56 bits encode either an inline value or an offset.

This representation enables zero-copy access: no intermediate tree allocation, no hash maps for objects during the parse phase.

## Whitespace and Validation

Whitespace handling is also vectorized. Rather than skipping whitespace byte-by-byte, simdjson uses a lookup table via `VPSHUFB` to classify all 64 bytes as whitespace or non-whitespace in one instruction:

```cpp
// PSHUFB-based classification: whitespace = {0x09, 0x0A, 0x0D, 0x20}
const __m256i lut = _mm256_setr_epi8(
    0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0, // 0x00-0x0F
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0  // 0x10-0x1F
);
// Low nibble shuffle + high nibble check gives O(1) classification
```

Number validation similarly avoids per-digit branching by using SIMD to find the span of digit characters, then dispatching to optimized conversion routines.

## Performance Characteristics

On an Intel Cascade Lake processor with AVX-512, simdjson achieves:

| Document Type | Throughput | Cycles/Byte |
|---|---|---|
| twitter.json (632 KB) | 3.4 GB/s | 0.85 |
| Large array of floats | 2.1 GB/s | 1.37 |
| Deeply nested objects | 2.8 GB/s | 1.03 |
| Minified (no whitespace) | 2.5 GB/s | 1.15 |

For comparison, RapidJSON achieves ~0.6 GB/s and nlohmann/json ~0.1 GB/s on the same workload. The 5-30x speedup comes entirely from eliminating branches in Stage 1.

## On-Demand Parsing: Paying Only for What You Access

simdjson 2.0 introduced an **on-demand API** that lazily evaluates the tape. Instead of fully parsing the document upfront, it builds only the structural index (Stage 1) eagerly, then navigates the structure on access:

```cpp
ondemand::parser parser;
auto doc = parser.iterate(json_bytes);

// Only parses the path to "results[0].score"
double score = doc["results"].at(0)["score"].get_double();
```

For large documents where only a subset of fields are needed, this reduces effective parsing cost to near-zero for untouched subtrees while maintaining the same Stage 1 throughput.

## Design Lessons

**Reframe the problem for hardware.** The byte-at-a-time parsing model is a software artifact, not an inherent constraint of JSON grammar. By asking "which bytes are structural?" instead of "what does this byte mean in context?", the problem becomes amenable to SIMD.

**Separate concerns by parallelism granularity.** Stage 1 (data-parallel, no dependencies between bytes within a chunk) and Stage 2 (sequential, grammar-driven) have fundamentally different characteristics. Mixing them forces the entire parser to run at Stage 2's serial speed.

**Use carry-bit tricks for state propagation.** The prefix-XOR via CLMUL technique elegantly handles the inherently sequential quote-state problem without sacrificing throughput. This pattern, using hardware-accelerated binary operations to simulate serial state machines, appears across high-performance parsers, regex engines, and even UTF-8 validation (see simdutf).

**Flat output representations beat trees.** The tape avoids allocation overhead and enables cache-friendly sequential access. This design principle appears in FlatBuffers, Cap'n Proto, and Arrow, all preferring flat, type-tagged buffers over pointer-chasing tree structures.

simdjson demonstrates that "parsing" need not be synonymous with "branching." When you reconsider what operations are truly serial versus merely implemented serially, order-of-magnitude speedups become systematic rather than heroic.
