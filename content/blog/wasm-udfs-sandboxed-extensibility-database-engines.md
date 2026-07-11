---
title: "WebAssembly UDFs: Sandboxed Extensibility in Modern Database Engines"
date: 2026-07-11
tags: ["webassembly", "databases", "query-engines", "sandboxing", "performance"]
excerpt: "How database engines use WebAssembly to run user-defined functions with near-native speed while maintaining memory safety, deterministic execution, and zero-trust isolation within the query pipeline."
---

# WebAssembly UDFs: Sandboxed Extensibility in Modern Database Engines

User-defined functions have always been the escape hatch for query engines. When SQL's built-in operators cannot express your domain logic, you write a UDF. Historically this meant either interpreted execution (Python/JavaScript UDFs with 10-100x overhead) or native plugins (C/C++ shared libraries with zero isolation guarantees). WebAssembly closes this gap: near-native performance, memory-safe sandboxing, and deterministic execution, all within the query engine's address space.

## The Problem with Traditional UDF Approaches

**Interpreted UDFs** (e.g., PL/Python, JavaScript V8 in PostgreSQL extensions) impose per-row function call overhead that dominates execution time on analytical workloads. Crossing the language boundary for each of 100 million rows means serialization, type conversion, and GIL contention. Benchmarks consistently show 50-200x slowdowns versus equivalent native SQL expressions.

**Native UDFs** (shared objects loaded via `dlopen`) eliminate the overhead but introduce catastrophic risk. A segfault in user code crashes the entire database process. A buffer overflow becomes a privilege escalation vector. Memory leaks accumulate without bound. Production databases cannot accept this attack surface.

**Process-isolated UDFs** (separate process per UDF invocation) solve safety but reintroduce latency through IPC, context switches, and serialization. This is what PostgreSQL's `PL/Container` and some Spark configurations do, with 5-20x overhead versus in-process execution.

## Why WebAssembly Fits

WebAssembly provides a unique combination of properties that align with database engine requirements:

1. **Linear memory isolation**: Each Wasm module operates on its own contiguous memory region. Out-of-bounds access traps deterministically rather than corrupting engine state.

2. **Ahead-of-time compilation**: Wasm bytecode compiles to native machine code once at registration time. Subsequent invocations execute at near-native speed with no JIT warmup during query execution.

3. **Deterministic execution**: No system calls, no filesystem access, no network IO unless explicitly granted through imported functions. This guarantees reproducible results across replicas.

4. **Fuel metering**: Runtimes like Wasmtime and Wasmer support instruction counting (fuel), enabling the engine to abort runaway UDFs without relying on signals or threads.

5. **Component model**: The emerging Wasm Component Model provides structured type interfaces, eliminating the need for manual serialization of complex types between host and guest.

## Architecture: Wasm UDFs in the Query Pipeline

The integration point matters enormously. A Wasm UDF can be invoked at three levels:

```
┌─────────────────────────────────────────────┐
│  Query Plan                                  │
│  ┌───────────┐    ┌──────────────────────┐  │
│  │ Scan Node │───▶│ Filter (Wasm UDF)    │  │
│  └───────────┘    │  ┌────────────────┐  │  │
│                   │  │ Vectorized Call │  │  │
│                   │  │ (batch of 1024) │  │  │
│                   │  └────────────────┘  │  │
│                   └──────────────────────┘  │
│                              │               │
│                   ┌──────────▼───────────┐  │
│                   │ Project (Wasm UDF)   │  │
│                   └──────────────────────┘  │
└─────────────────────────────────────────────┘
```

The key optimization is **vectorized invocation**. Rather than calling the Wasm function once per row, the engine passes a pointer to a batch of values in the Wasm module's linear memory, processes the entire batch in a single host-to-guest transition, and reads results back. This amortizes the call overhead across typically 1024-4096 rows.

## Implementation: A Vectorized Wasm UDF

Here is how a scalar UDF looks from the Wasm module's perspective, written in Rust and compiled to `wasm32-wasi`:

```rust
// UDF: haversine distance between two lat/lng pairs
// Operates on columnar batches for vectorized execution

#[no_mangle]
pub extern "C" fn haversine_batch(
    lat1_ptr: *const f64,
    lng1_ptr: *const f64,
    lat2_ptr: *const f64,
    lng2_ptr: *const f64,
    out_ptr: *mut f64,
    len: u32,
) {
    let len = len as usize;
    let (lat1s, lng1s, lat2s, lng2s, outs) = unsafe {
        (
            std::slice::from_raw_parts(lat1_ptr, len),
            std::slice::from_raw_parts(lng1_ptr, len),
            std::slice::from_raw_parts(lat2_ptr, len),
            std::slice::from_raw_parts(lng2_ptr, len),
            std::slice::from_raw_parts_mut(out_ptr, len),
        )
    };

    for i in 0..len {
        let dlat = (lat2s[i] - lat1s[i]).to_radians();
        let dlng = (lng2s[i] - lng1s[i]).to_radians();
        let a = (dlat / 2.0).sin().powi(2)
            + lat1s[i].to_radians().cos()
                * lat2s[i].to_radians().cos()
                * (dlng / 2.0).sin().powi(2);
        outs[i] = 6371.0 * 2.0 * a.sqrt().asin();
    }
}

#[no_mangle]
pub extern "C" fn alloc(size: u32) -> *mut u8 {
    let layout = std::alloc::Layout::from_size_align(size as usize, 8).unwrap();
    unsafe { std::alloc::alloc(layout) }
}
```

The host engine's integration:

```cpp
// Host-side: invoke the Wasm UDF on a vector batch
void execute_wasm_udf(WasmInstance& instance, DataChunk& input, Vector& result) {
    auto batch_size = input.size();

    // Allocate space in Wasm linear memory for inputs + output
    auto lat1_wasm = instance.call<uint32_t>("alloc", batch_size * 8);
    auto lng1_wasm = instance.call<uint32_t>("alloc", batch_size * 8);
    auto lat2_wasm = instance.call<uint32_t>("alloc", batch_size * 8);
    auto lng2_wasm = instance.call<uint32_t>("alloc", batch_size * 8);
    auto out_wasm  = instance.call<uint32_t>("alloc", batch_size * 8);

    // Copy input vectors into Wasm memory
    auto memory = instance.linear_memory();
    memcpy(memory + lat1_wasm, input[0].data(), batch_size * 8);
    memcpy(memory + lng1_wasm, input[1].data(), batch_size * 8);
    memcpy(memory + lat2_wasm, input[2].data(), batch_size * 8);
    memcpy(memory + lng2_wasm, input[3].data(), batch_size * 8);

    // Single cross-boundary call for entire batch
    instance.call<void>("haversine_batch",
        lat1_wasm, lng1_wasm, lat2_wasm, lng2_wasm, out_wasm, batch_size);

    // Copy results back
    memcpy(result.data(), memory + out_wasm, batch_size * 8);
}
```

## Performance Characteristics

Empirical measurements from production systems show consistent patterns:

| Approach | Overhead vs. Native | Isolation |
|----------|-------------------|-----------|
| Native C UDF (dlopen) | 1.0x (baseline) | None |
| Wasm UDF (AOT compiled) | 1.05-1.3x | Full memory safety |
| Wasm UDF (interpreter) | 5-15x | Full memory safety |
| Python UDF (per-row) | 50-200x | Process boundary |
| Python UDF (Arrow batch) | 3-8x | Process boundary |

The 5-30% overhead of AOT-compiled Wasm comes from three sources: bounds checking on linear memory access (often elided by the compiler via guard pages), indirect call validation for function tables, and the absence of SIMD auto-vectorization in some Wasm compilers (though Wasm SIMD 128-bit intrinsics are now stable).

## Security Model: Defense in Depth

The Wasm sandbox provides the first layer, but production deployments add more:

**Fuel limits**: Each UDF invocation gets a fuel budget proportional to input size. A UDF computing O(n²) on its input exhausts fuel and is terminated, preventing denial-of-service against the query engine.

**Memory caps**: Linear memory growth is bounded. A `memory.grow` instruction beyond the cap traps immediately. Typical limits are 64-256 MB per UDF instance.

**Instance pooling**: Rather than instantiating a fresh Wasm module per query, engines maintain a pool of pre-compiled instances with copy-on-write memory snapshots. This reduces instantiation from milliseconds to microseconds.

**Capability-based imports**: The UDF declares which host functions it needs (e.g., logging, random number generation). The engine grants only those capabilities. A UDF that claims to compute haversine but imports filesystem functions is rejected at registration.

## State of the Art (2024-2025)

Several systems now ship Wasm UDF support in production:

DuckDB's extension system compiles extensions to Wasm for browser deployment, demonstrating that complex analytical operations (window functions, aggregates) run efficiently within the Wasm sandbox. SingleStore's `CREATE FUNCTION ... LANGUAGE WASM` allows users to upload `.wasm` modules that execute inline with vectorized query processing. Redpanda uses Wasm transforms for inline stream processing, applying user logic to each record without leaving the broker's address space.

The VLDB 2024 paper "Wasm in the Wild" characterized Wasm performance across database workloads, finding that the primary remaining gap versus native is SIMD utilization: Wasm's 128-bit SIMD cannot express AVX-512 operations, leaving 2-4x on the table for string processing and compression kernels.

## The Component Model: Eliminating Serialization

The next evolution is the Wasm Component Model (currently in preview). Instead of passing raw pointers and manually managing memory layout, components declare typed interfaces:

```wit
// WIT (Wasm Interface Types) definition
package analytics:udf;

interface geospatial {
    record point {
        lat: f64,
        lng: f64,
    }

    haversine: func(from: point, to: point) -> f64;
    haversine-batch: func(from: list<point>, to: list<point>) -> list<f64>;
}
```

The host generates bindings that handle memory layout, ABI compatibility, and zero-copy sharing of read-only columnar data. This eliminates an entire class of bugs (misaligned pointers, incorrect length encoding) while enabling the runtime to optimize data transfer paths.

## When to Use Wasm UDFs

Wasm UDFs are the right choice when: your logic cannot be expressed in SQL or the engine's built-in function library; you need sub-millisecond per-batch latency that rules out process isolation; you are deploying to multi-tenant environments where native code is unacceptable; or you want portable UDFs that run identically across different database engines (the same `.wasm` binary works in any Wasm-capable engine).

They are not yet ideal for: UDFs requiring >256 MB working memory, operations needing AVX-512 width SIMD, or functions that must perform external IO (network calls, filesystem access) during execution, though WASI preview 2 is expanding these boundaries.

The trajectory is clear: WebAssembly is becoming the universal extension interface for data systems, offering the first practical resolution to the decades-old tradeoff between UDF performance and UDF safety.
