---
title: "eBPF Continuous Profiling: Always-On Production Observability at <1% Overhead"
date: 2026-07-09
tags: ["ebpf", "profiling", "observability", "linux", "performance"]
excerpt: "How eBPF-based continuous profilers achieve always-on stack trace collection in production with sub-1% CPU overhead using frame pointer unwinding, BPF ring buffers, and adaptive sampling — replacing the traditional trade-off between observability and performance."
---

# eBPF Continuous Profiling: Always-On Production Observability at <1% Overhead

Traditional profiling has always forced a binary choice: either instrument your production systems and accept 5-15% overhead from agents like async-profiler or perf, or fly blind until an incident forces you to attach a profiler after the fact. eBPF-based continuous profiling eliminates this trade-off entirely, enabling always-on stack trace collection across entire fleets at sustained overhead below 1%.

## The Architecture: Kernel-Space Stack Walking

The fundamental insight is that eBPF programs execute inside the kernel, avoiding the context-switch overhead of user-space profiling agents. A continuous profiler attaches a BPF program to `perf_event` hardware counters, firing at a configurable frequency (typically 19Hz or 97Hz — prime numbers to avoid aliasing with periodic workloads):

```c
SEC("perf_event")
int profile_cpu(struct bpf_perf_event_data *ctx) {
    u64 id = bpf_get_current_pid_tgid();
    u32 pid = id >> 32;
    u32 tid = id;

    struct stack_trace_t *trace = bpf_ringbuf_reserve(&rb, sizeof(*trace), 0);
    if (!trace) return 0;

    trace->pid = pid;
    trace->tid = tid;
    trace->kernel_stack_id = bpf_get_stackid(ctx, &stack_map, 0);
    trace->user_stack_id = bpf_get_stackid(ctx, &stack_map, BPF_F_USER_STACK);
    trace->timestamp = bpf_ktime_get_ns();

    bpf_ringbuf_submit(trace, 0);
    return 0;
}
```

This program fires on every CPU at the configured frequency, capturing both kernel and user-space stack traces. The critical operation — `bpf_get_stackid()` — performs frame pointer-based stack unwinding entirely in kernel space.

## Frame Pointer Unwinding vs. DWARF

The choice of unwinding mechanism is the single largest determinant of profiling overhead:

| Method | Overhead per sample | Accuracy | Requirements |
|--------|-------------------|----------|--------------|
| Frame pointers (FP) | ~200ns | High | `-fno-omit-frame-pointer` compilation |
| DWARF (.eh_frame) | ~5-50μs | Complete | Debug info available |
| ORC (kernel) | ~500ns | Complete | Kernel 4.14+ (auto-generated) |
| LBR (hardware) | ~100ns | Partial | Intel Haswell+ / AMD Zen 4+ |

Frame pointer unwinding walks the `rbp` chain — each frame's base pointer contains the address of the caller's frame. At 97Hz across 128 cores, FP unwinding adds roughly 2.5μs of CPU time per second per core — genuinely negligible.

The 2024 push by major Linux distributions (Fedora 38+, Ubuntu 24.04) to compile all packages with `-fno-omit-frame-pointer` was directly motivated by this profiling use case. The gcc/clang optimization that omits frame pointers saves one register (rbp) but makes production profiling either impossible or 100x more expensive.

## BPF Ring Buffer: Zero-Copy Sample Delivery

Pre-5.8 kernels required `BPF_MAP_TYPE_PERF_EVENT_ARRAY` for delivering samples to user space — one ring per CPU, requiring epoll multiplexing and per-CPU memory allocation. The BPF ring buffer (Linux 5.8+) provides a single shared buffer with lock-free multi-producer semantics:

```c
struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 24); // 16MB
} rb SEC(".maps");
```

The ring buffer eliminates the per-CPU fragmentation problem where lightly-loaded CPUs waste memory while hot CPUs overflow. Benchmarks from the Parca project show 40% memory reduction and 15% fewer dropped samples under bursty workloads compared to perf event arrays.

## Adaptive Sampling: Information-Theoretic Rate Control

Naive fixed-rate sampling wastes budget on idle periods and undersamples during bursts. Modern continuous profilers implement adaptive sampling inspired by control theory:

```python
class AdaptiveProfiler:
    def __init__(self, target_overhead_pct=0.5, min_hz=19, max_hz=997):
        self.target_overhead = target_overhead_pct / 100
        self.current_hz = 97
        self.ewma_cost = 0.0
        self.alpha = 0.1

    def adjust_rate(self, sample_cost_ns, cpu_busy_pct):
        self.ewma_cost = self.alpha * sample_cost_ns + (1 - self.alpha) * self.ewma_cost
        overhead = (self.ewma_cost * self.current_hz) / 1e9
        
        if overhead > self.target_overhead:
            self.current_hz = max(self.min_hz, int(self.current_hz * 0.8))
        elif overhead < self.target_overhead * 0.5 and cpu_busy_pct > 0.3:
            self.current_hz = min(self.max_hz, int(self.current_hz * 1.2))
        
        return self.current_hz
```

This maintains the overhead budget invariant while concentrating samples where they provide the most information — during high-CPU periods where optimization opportunities actually exist.

## Stack Trace Deduplication and Symbolization

Raw stack traces are sequences of instruction pointers. In production, the same hot path generates millions of identical traces. The profiler deduplicates in-kernel using `BPF_MAP_TYPE_STACK_TRACE` — a hash map keyed on the full stack, returning a 32-bit stack ID:

```
Hot path:  main → serve_request → parse_json → simd_validate
Samples:   47,832 (23% of total)
Stack ID:  0x7f3a2b1c
```

Symbolization happens asynchronously in user space by reading `/proc/<pid>/maps` for shared library offsets and parsing ELF symbol tables. For JIT-compiled languages (JVM, V8, Python), profilers read perf maps (`/tmp/perf-<pid>.map`) that runtimes emit mapping JIT addresses to function names.

## The pprof Wire Format and Storage

Continuous profilers emit samples in the pprof protobuf format (originally from Google's internal profiling infrastructure). The format is columnar by design — string tables are deduplicated, and location IDs reference shared function/file metadata:

```protobuf
message Profile {
    repeated Sample sample = 1;
    repeated Location location = 4;
    repeated Function function = 5;
    StringTable string_table = 6;
    int64 duration_nanos = 9;
}
```

At fleet scale (thousands of machines, 97Hz), this generates approximately 50MB/hour/machine of compressed profile data. Storage backends use columnar formats (Parquet) with time-series partitioning, enabling queries like "show me all stack traces containing `malloc` that appeared after Tuesday's deploy."

## Differential Profiling: Detecting Regressions

The most powerful application of continuous profiling is automated regression detection. By comparing flame graphs across deployment boundaries:

```
Δ(cpu_samples, function=parse_json, version=v2.3.1 vs v2.3.0)
  Before: 12.3% of samples
  After:  18.7% of samples
  Change: +52% relative increase
```

This catches performance regressions that unit benchmarks miss — the kind that only manifest under production traffic patterns, with production data sizes, under production concurrency. Systems like Google-internal ContinuousProfiler and Polar Signals' Parca have demonstrated catching regressions within minutes of deployment, before latency SLOs are breached.

## Overhead Measurement: The Numbers

Rigorous overhead measurement from the Parca project (2024 benchmarks on Linux 6.6, AMD EPYC 9654):

| Sampling rate | CPU overhead | Memory (agent) | Dropped samples |
|--------------|-------------|----------------|-----------------|
| 19 Hz | 0.1% | 42 MB | 0% |
| 97 Hz | 0.4% | 68 MB | 0% |
| 997 Hz | 2.8% | 210 MB | 0.3% |

The sweet spot is 97Hz — sufficient statistical significance after 30 seconds of collection while remaining invisible to application performance.

## Looking Forward: Hardware-Assisted Profiling

Intel's Processor Trace (PT) and ARM's Statistical Profiling Extension (SPE) push sampling into hardware, eliminating even the minimal interrupt overhead of perf_event-based sampling. Combined with eBPF for filtering and aggregation, these enable microsecond-granularity profiling at effectively zero software overhead.

The trajectory is clear: production systems will be continuously profiled by default, with the overhead indistinguishable from measurement noise. The era of "attach a profiler when something goes wrong" is ending — replaced by always-on observability where performance regressions are caught before customers notice them.
