---
title: "sched_ext: BPF-Pluggable CPU Schedulers and the End of One-Size-Fits-All Scheduling"
date: 2026-07-08
tags: ["linux-kernel", "ebpf", "scheduling", "systems-programming", "performance"]
excerpt: "Linux 6.12 merged sched_ext, a framework that lets you write CPU scheduler policies as BPF programs, load them at runtime, and swap them without rebooting. Here's how it works, why it matters, and what Meta learned running it in production."
---

For sixteen years, Linux had one general-purpose CPU scheduler: CFS (Completely Fair Scheduler), replaced in 6.6 by EEVDF. Both are monolithic policies baked into the kernel. If your workload doesn't match their assumptions, you either patch the kernel or tolerate suboptimal scheduling. With Linux 6.12 (December 2024), that constraint evaporated. **sched_ext** allows user-space BPF programs to define scheduling policy, loaded and unloaded at runtime with zero downtime.

This isn't academic. Meta runs `scx_lavd` (Latency Aware Virtual Deadline) in production across their fleet. Google contributed core patches. The framework ships with a dozen reference schedulers covering everything from gaming latency optimization to NUMA-aware placement.

## The Architecture

sched_ext is implemented as a new scheduling class (`SCX`) that sits between the real-time class (`RT`) and the fair class (`FAIR`) in priority. When a BPF scheduler is loaded, tasks in the `SCHED_EXT` policy are governed entirely by user-defined logic.

The kernel exposes a set of **ops** (operations) that a BPF scheduler implements:

```c
struct sched_ext_ops {
    s32 (*select_cpu)(struct task_struct *p, s32 prev_cpu, u64 wake_flags);
    void (*enqueue)(struct task_struct *p, u64 enq_flags);
    void (*dequeue)(struct task_struct *p, u64 deq_flags);
    void (*dispatch)(s32 cpu, struct task_struct *prev);
    void (*running)(struct task_struct *p);
    void (*stopping)(struct task_struct *p, bool runnable);
    void (*enable)(struct task_struct *p);
    void (*init_task)(struct task_struct *p, struct scx_init_task_args *args);
    // ... 30+ hooks total
};
```

The critical path is: `select_cpu` → `enqueue` → `dispatch`. When a task wakes up, `select_cpu` picks a CPU. `enqueue` places the task into a dispatch queue (DSQ). `dispatch` pulls tasks from DSQs onto CPUs when they go idle.

### Dispatch Queues (DSQs)

DSQs are the fundamental data structure. Each CPU has a local DSQ, and schedulers can create arbitrary shared DSQs for global or grouped scheduling:

```c
// In BPF scheduler initialization
scx_bpf_create_dsq(SHARED_DSQ_ID, -1);  // NUMA-node = -1 means any

// In enqueue: place task in shared DSQ
void BPF_STRUCT_OPS(my_enqueue, struct task_struct *p, u64 enq_flags)
{
    u64 vtime = p->scx.dsq_vtime;
    scx_bpf_dispatch_vtime(p, SHARED_DSQ_ID, SCX_SLICE_DFL, vtime, enq_flags);
}

// In dispatch: consume from shared DSQ when CPU is idle
void BPF_STRUCT_OPS(my_dispatch, s32 cpu, struct task_struct *prev)
{
    scx_bpf_consume(SHARED_DSQ_ID);
}
```

This two-level dispatch (local DSQ per-CPU + shared global DSQs) gives schedulers the building blocks for work-stealing, priority lanes, or NUMA-partitioned scheduling without touching kernel internals.

## Safety Model

A valid concern: won't a buggy BPF scheduler deadlock the system? sched_ext has three safety mechanisms:

1. **Watchdog timer.** If a runnable task isn't scheduled within a configurable timeout (default 30 seconds), the kernel forcibly unloads the BPF scheduler and falls back to the built-in EEVDF scheduler. No reboot required.

2. **BPF verifier.** The standard BPF verifier ensures no infinite loops, no out-of-bounds memory access, and bounded execution time per hook invocation.

3. **Graceful fallback.** If the BPF program returns an error or calls `scx_bpf_error()`, the scheduler is unloaded atomically. All tasks migrate back to the default scheduling class within one scheduling tick.

This means you can develop schedulers iteratively: load, test under production traffic, unload if latency regresses, iterate. The feedback loop is seconds, not kernel-compile-reboot cycles.

## Case Study: scx_lavd (Meta)

Meta's `scx_lavd` (Latency Aware Virtual Deadline) scheduler targets their mixed-workload fleet where latency-sensitive services coexist with batch jobs on shared hardware. The key insight: instead of the kernel guessing which tasks are latency-sensitive, **let the scheduler observe and classify dynamically**.

scx_lavd tracks per-task metrics:
- **Voluntary context switch frequency** (high = likely interactive/latency-sensitive)
- **CPU burst length** (short bursts = likely waiting on I/O or network)
- **Wait time before wakeup** (long waits = likely event-driven)

From these signals, it computes a "latency criticality" score and assigns virtual deadlines accordingly. Latency-critical tasks get tighter deadlines and preempt batch work, but without starving throughput tasks because deadlines are recomputed every scheduling epoch.

```c
static u64 compute_deadline(struct task_struct *p, struct task_ctx *taskc)
{
    u64 lat_cri = calc_latency_criticality(taskc);
    u64 slice = calc_time_slice(lat_cri);
    u64 deadline = bpf_ktime_get_ns() + slice;

    // Greedy ratio: allow limited unfairness for latency-critical tasks
    if (lat_cri > GREEDY_THRESHOLD)
        deadline -= (lat_cri - GREEDY_THRESHOLD) * GREEDY_WEIGHT;

    return deadline;
}
```

In Meta's production measurements, scx_lavd reduced p99 latency for latency-sensitive services by 10-20% while maintaining equivalent throughput for batch workloads, compared to EEVDF with manual cgroup priority tuning.

## scx_rusty: Rust-Based NUMA Scheduling

Another reference scheduler, `scx_rusty`, demonstrates a hybrid architecture: the hot-path BPF enqueue/dispatch runs in-kernel, but a user-space Rust daemon makes periodic load-balancing decisions.

The Rust daemon:
1. Reads per-CPU and per-NUMA-node utilization via BPF maps
2. Computes optimal task-to-node assignments using a constraint solver
3. Writes migration decisions back to BPF maps
4. The BPF dispatch path reads these maps and steers tasks accordingly

This split allows complex algorithms (integer linear programming for placement) that would be impossible within BPF's instruction limits, while keeping the scheduling hot path (nanosecond-budget dispatch decisions) in BPF.

```rust
// User-space Rust load balancer (simplified)
fn rebalance(domains: &mut [Domain], tasks: &[TaskStat]) {
    for task in tasks.iter().filter(|t| t.migration_eligible()) {
        let current_node = task.numa_node;
        let target_node = domains.iter()
            .enumerate()
            .min_by_key(|(_, d)| d.load_avg)
            .map(|(i, _)| i)
            .unwrap_or(current_node);

        if target_node != current_node {
            bpf_map_update(&TASK_DOMAIN_MAP, &task.pid, &target_node);
        }
    }
}
```

## Writing Your Own: The Minimal Scheduler

A complete (if naive) sched_ext scheduler fits in under 50 lines:

```c
#include <scx/common.bpf.h>

char _license[] SEC("license") = "GPL";

UEI_DEFINE(uei);  // User Exit Info for error reporting

s32 BPF_STRUCT_OPS(simple_select_cpu, struct task_struct *p,
                   s32 prev_cpu, u64 wake_flags)
{
    return prev_cpu;  // Always run on the same CPU (cache-affine)
}

void BPF_STRUCT_OPS(simple_enqueue, struct task_struct *p, u64 enq_flags)
{
    // Dispatch directly to the local CPU's DSQ with default time slice
    scx_bpf_dispatch(p, SCX_DSQ_LOCAL, SCX_SLICE_DFL, enq_flags);
}

void BPF_STRUCT_OPS(simple_exit, struct scx_exit_info *ei)
{
    UEI_RECORD(uei, ei);
}

SCX_OPS_DEFINE(simple_ops,
    .select_cpu = (void *)simple_select_cpu,
    .enqueue    = (void *)simple_enqueue,
    .exit       = (void *)simple_exit,
    .name       = "simple",
);
```

Load it with `scx_loader` or directly via `bpf()` syscall. Unload by terminating the loader process. The system seamlessly transitions between BPF-scheduled and kernel-scheduled states.

## Why This Matters Beyond Linux

sched_ext represents a broader trend: **moving policy out of kernels and into verifiably-safe user-space programs**. The same pattern is appearing in:

- **Network scheduling**: XDP/TC BPF programs already define packet queueing policy
- **Memory management**: BPF-based page reclaim hints (experimental)
- **I/O scheduling**: BPF-based block I/O schedulers (proposed)

The key enabler is the BPF verifier's guarantee: bounded execution, memory safety, and no kernel panics. This lets kernel developers expose mechanism (dispatch queues, CPU selection hooks, timer callbacks) while delegating policy to rapidly-iterating user-space teams.

For workloads where scheduling matters, like databases, game servers, real-time audio, or ML training, sched_ext transforms the scheduler from a fixed constraint into a tunable parameter. The 30-second watchdog means experimentation is safe. The BPF toolchain means iteration is fast. And the production deployments at Meta mean this isn't speculative: it works at scale, today.
