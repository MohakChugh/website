---
title: "Zero-Copy Deserialization: How rkyv, FlatBuffers, and Cap'n Proto Eliminate Parsing Overhead"
date: 2026-07-08
tags: [serialization, systems, performance, rust, memory]
excerpt: "Traditional deserialization copies bytes into heap-allocated objects, burning CPU and memory bandwidth. Zero-copy formats flip this model: the serialized bytes ARE the in-memory data structure, accessed directly through pointer arithmetic and alignment guarantees."
---

## The cost of traditional deserialization

Every time your service reads a protobuf message, deserializes JSON, or decodes a Thrift struct, it performs a ritual: allocate heap objects, copy bytes from the wire buffer into those objects, chase pointers to build nested structures, and eventually free everything. For a 1KB protobuf message with nested repeated fields, this can mean 20+ heap allocations, each a potential cache miss.

Profile any RPC-heavy service and you'll find 10-30% of CPU time spent in serialization/deserialization. At tail latencies (p99), GC pauses from deserialization-produced garbage dominate. The question becomes: what if we could skip all of it?

## The zero-copy insight

Zero-copy deserialization eliminates the parse step entirely. The serialized byte buffer IS the data structure. You cast a pointer to the buffer and access fields through offset arithmetic, with the format guaranteeing correct alignment and layout.

```
Traditional:  wire bytes → parse → heap objects → access fields
Zero-copy:    wire bytes → access fields (directly from buffer)
```

This isn't merely "fast parsing" — it's the absence of parsing. Access time is O(1) regardless of message size: reading the 10,000th field in a table costs the same as reading the first.

## How it works: the vtable pattern (FlatBuffers)

FlatBuffers, designed at Google for game engines, uses a vtable indirection scheme. Every table has a pointer to a vtable (shared across instances with the same schema), and the vtable stores field offsets:

```
Buffer layout:
┌────────────────────────────────────────────────┐
│ vtable: [field0_offset, field1_offset, ...]    │
├────────────────────────────────────────────────┤
│ object: [vtable_ptr | inline data...]          │
├────────────────────────────────────────────────┤
│ child objects, strings, vectors...             │
└────────────────────────────────────────────────┘
```

Field access compiles to:

```c
// Reading field 'name' from a FlatBuffer Monster table
inline const flatbuffers::String *name() const {
  // 1. Read vtable offset for this field (2 bytes)
  // 2. Add offset to object base pointer
  // 3. Read the relative offset to the string
  // 4. Return pointer into the SAME buffer
  return GetPointer<const flatbuffers::String *>(VT_NAME);
}
```

No allocation. No copy. The returned pointer points directly into the original byte buffer. The entire "deserialization" is two integer additions and a pointer dereference.

## rkyv: zero-copy in Rust with archived types

rkyv (Rust Archive) takes a different approach by generating a parallel "archived" type for each struct. The archived type has the same field layout but uses relative pointers (`RelPtr`) instead of absolute pointers, making the buffer position-independent:

```rust
#[derive(Archive, Serialize, Deserialize)]
struct GameState {
    players: Vec<Player>,
    tick: u64,
    map_seed: u32,
}

// Generated archived type (simplified):
#[repr(C)]
struct ArchivedGameState {
    players: ArchivedVec<ArchivedPlayer>,  // relative pointer + length
    tick: u64,                              // primitives are identity-archived
    map_seed: u32,
}
```

The critical innovation is `RelPtr` — a relative pointer stored as an offset from its own position:

```rust
#[repr(C)]
struct RelPtr<T> {
    offset: i32,  // byte offset from &self to target
    _phantom: PhantomData<T>,
}

impl<T> RelPtr<T> {
    fn as_ptr(&self) -> *const T {
        // Target address = self address + stored offset
        (self as *const Self as *const u8)
            .offset(self.offset as isize) as *const T
    }
}
```

This means the entire archive can be `mmap`'d from disk and accessed instantly:

```rust
// Memory-map a 2GB game save file
let mmap = unsafe { MmapOptions::new().map(&file)? };

// "Deserialize" in O(1) — just validate the root pointer
let state = unsafe { rkyv::archived_root::<GameState>(&mmap) };

// Access the 50,000th player with zero parsing
println!("Player: {}", state.players[49_999].name);
```

## Cap'n Proto: the pointer discipline

Cap'n Proto (from the creator of Protocol Buffers) uses a fat-pointer scheme where every pointer encodes its type, offset, and size in a single 64-bit word:

```
Struct pointer (64 bits):
├─ bits 0-1:   type tag (0 = struct)
├─ bits 2-31:  offset to struct data (signed, in words)
├─ bits 32-47: data section size (in words)
└─ bits 48-63: pointer section size (in pointers)

List pointer (64 bits):
├─ bits 0-1:   type tag (1 = list)
├─ bits 2-31:  offset to first element
├─ bits 32-34: element size category
└─ bits 35-63: element count
```

This encoding enables a security property absent from FlatBuffers: **traversal limits**. Cap'n Proto tracks how many bytes have been read during traversal and aborts if a message tries to trick the reader into reading excessive data (e.g., through circular pointer references in a malicious buffer).

## Alignment: the hidden constraint

Zero-copy formats must guarantee that every field is naturally aligned in the buffer. A `u64` must start at an 8-byte boundary, a `u32` at 4 bytes, etc. Misaligned access on ARM is a fault; on x86 it's a silent 2x penalty.

FlatBuffers solves this with padding during serialization — the builder tracks current alignment and inserts padding bytes. rkyv uses `#[repr(C)]` structs and computes alignment requirements at compile time via its `Archive` trait:

```rust
// rkyv alignment computation (compile-time)
unsafe impl Archive for MyStruct {
    const ALIGNMENT: usize = max(
        align_of::<u64>(),     // largest field alignment
        align_of::<RelPtr>(),  // pointer alignment
    );
}
```

## The tradeoffs

**Write amplification.** Zero-copy formats are optimized for reads. Writing requires building the buffer bottom-up (leaves before parents) because you need to know child offsets before writing parent pointers. FlatBuffers requires explicit `Finish()` calls; rkyv serializes recursively.

**Schema evolution.** Adding fields is safe (old readers skip unknown vtable entries). Removing fields or changing types is not — the on-disk layout is the API. This is stricter than protobuf, where you can freely deprecate fields.

**No lazy decoding of primitives.** Every field is stored in host byte order. On big-endian systems reading little-endian archives, you pay a byte-swap per access. In practice this is negligible since virtually all modern hardware is little-endian.

**Validation cost.** Accessing an arbitrary buffer as a typed struct is `unsafe` without validation. rkyv offers `check_archived_root()` which walks the buffer verifying pointer bounds and alignment — this costs O(n) but only needs to happen once per buffer, not per access.

## Benchmarks: the gap is enormous

Comparing deserialization of a 1000-element vector of structs (each with 5 fields):

| Format | Deserialize (ns) | Access 1 field (ns) | Heap allocs |
|--------|----------------:|--------------------:|------------:|
| JSON (serde) | 45,000 | 0 (post-parse) | ~3,000 |
| Protobuf | 8,200 | 0 (post-parse) | ~1,000 |
| FlatBuffers | 0 | 2-4 | 0 |
| rkyv | 0 | 2-4 | 0 |
| Cap'n Proto | 0 | 3-6 | 0 |

The "0 ns deserialize" is literal — there is no deserialization step. The buffer is ready on receipt.

## Real-world deployment patterns

**Memory-mapped databases.** DuckDB's storage format uses a similar principle: pages are read from disk via `mmap` and column data is accessed through offset arithmetic without copying into heap buffers. This is why analytical queries over larger-than-memory datasets remain fast.

**Network protocol buffers.** Game servers using FlatBuffers can broadcast 60-tick-per-second state updates to thousands of clients. The server serializes once; each client reads fields directly from the receive buffer without per-client deserialization overhead.

**Configuration hot-reload.** Systems that memory-map configuration files can atomically swap to new configs by remapping the file, with zero parsing latency regardless of config size.

**IPC between processes.** Shared memory segments containing rkyv archives allow processes to share complex data structures without serialization — one process writes, another reads the same bytes as typed data.

## When NOT to use zero-copy

If your data is small (<100 bytes), the overhead of protobuf/JSON parsing is negligible and the developer ergonomics of traditional formats win. If your schema evolves rapidly with field removals, the stricter evolution rules of zero-copy formats become painful. If you need to mutate deserialized data extensively, you'll end up copying into mutable structs anyway.

## The future: hardware convergence

CXL (Compute Express Link) memory pooling and persistent memory (CXL Type 3 devices) make zero-copy formats even more compelling. When your "network buffer" is actually a memory-mapped region of disaggregated memory attached over CXL, the distinction between "serialized data on the wire" and "in-memory data structure" disappears entirely. The format IS the memory layout, accessed at DRAM latency across the fabric.

Zero-copy deserialization is not a micro-optimization — it's an architectural decision that eliminates an entire class of overhead. For any system where read throughput matters more than schema flexibility, it's the correct default choice.
