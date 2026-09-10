---
title: "Junction: Kernel Bypass at 3,500 Instances Per Machine, No Porting Required"
date: 2026-09-10
tags: [kernel-bypass, operating-systems, networking, tail-latency, cloud-infrastructure]
excerpt: "Kernel bypass has always bought its order-of-magnitude latency wins with two things clouds can't afford: dedicated spinning cores and rewritten applications. Junction (NSDI '24) drops both — running unmodified Linux binaries, including Go, Java, Node, and Python runtimes, behind an 11-syscall host interface, and packing 3,500 active instances on one 128GB machine. The trick is a library OS built almost entirely out of NIC and CPU hardware features. The paper's 19–62x density claim reconciles exactly: 3500/180 against Caladan's scheduler ceiling, 3500/56 against one-core-per-instance designs."
---

Kernel bypass systems like eRPC, Demikernel, and Caladan have shown order-of-magnitude improvements in tail latency and throughput by mapping NIC queues into userspace and cutting the kernel out of the datapath. Almost nobody runs them in production clouds. The reasons are structural, not incidental: they busy-spin on dedicated cores and pin large buffer pools (so you can pack at most a few hundred instances on a machine, often only as many as you have cores), they require porting applications to new APIs (the entire ported-application universe across three state-of-the-art systems is a handful of C/C++ key-value stores), and they provide no isolation of their own, so you have to wrap them in VMs and give back much of what you gained.

[Junction](https://www.usenix.org/conference/nsdi24/presentation/fried) (Fried et al., NSDI 2024, from MIT CSAIL and Azure Research) is the first system to demonstrate that none of these compromises is inherent. It runs **unmodified Linux binaries** — including full language runtimes like Go, Java, Node.js, and Python that no prior kernel-bypass system could touch — while packing **3,500 active instances** on a 128GB machine with p99 latency under 350µs, a 35x tail-latency improvement over native Linux at the same density. Against Linux across seven applications it improves throughput 1.6–7.0x while using 1.2–3.8x fewer cores.

The headline density multiplier ("19–62x more instances than existing kernel bypass systems") reconciles cleanly if you do the division: Caladan's centralized scheduler saturates around 180 instances in the paper's setup, and 3500/180 ≈ 19.4x; eRPC and Demikernel dedicate at least one core per instance, and on the 28-core (56-hyperthread) evaluation host 3500/56 = 62.5x. Junction's own footprint model from Table 1 — 29MB base plus 0.47MB per instance-core — predicts 29 + 8×0.47 ≈ 32.8MB for the 8-thread instances in the density experiment, matching the measured 33MB.

## The architecture: a library OS with an 11-syscall diet

Each Junction instance is an ordinary Linux process (a *kProc*) with a statically-created set of kernel threads (*kThreads*). Inside the process, a copy of the Junction kernel — a library OS sharing the address space with the application — implements the Linux system call interface in userspace: threading, TCP/IP, signals, filesystems, epoll, timers. A centralized scheduler on one dedicated core allocates physical cores to instances, which can hold zero cores when idle.

The host kernel is nearly written out of the story. A seccomp filter restricts each instance to **11 system calls**: `yield_core()` (a custom kernel-module call for core allocation), five memory calls (`mmap`, `munmap`, `mprotect`, `mremap`, `madvise`), four for loading binaries from a read-only chroot jail (`open`, `close`, `pread64`, plus `write` for logging), and `exit_group`. At steady state running a Rust web server at 10K RPS, 99% of host syscalls are `yield_core()` on idle. Compare gVisor's Sentry at 64 allowed syscalls or Drawbridge at 36 — a 3.2–7.6x smaller attack surface, achieved not by proxying syscalls but by *not needing* the kernel, because the hardware provides the primitives directly:

| OS feature | Hardware replacement | Kernel call avoided |
|---|---|---|
| Networking | NIC queues | `socket()`, `recv()`, `send()` |
| Randomness | `RDRAND`/`RDSEED` | `getrandom()` |
| Thread-local storage | `WRFSBASE` | `arch_prctl()` |
| Signals/preemption | `SENDUIPI`, `XSAVEC`, `UIRET` | `tgkill()`, `rt_sigreturn()` |

The isolation argument is fate-sharing: the library OS is untrusted and lives inside the instance, so corrupting it only hurts yourself. That also unlocks optimizations Linux can never take — no TOCTOU mitigation, no argument copying, no transient-execution mitigations on the syscall path, and permission to resolve POSIX undefined behavior (like closing an fd mid-`select()`) in whatever way is fastest, lock-free.

## Density: two NIC features nobody was using this way

Kernel-bypass memory bloat comes from per-core receive queues. RSS hashes flows across queues unpredictably, so *every* queue must post enough MTU-sized pinned buffers to absorb a worst-case burst — buffer memory scales linearly with cores, and small packets waste most of each buffer. Caladan pays 648MB for the first core and 9MB per instance-core.

Junction attacks this with two features already present in ConnectX-5+ NICs:

1. **Shared buffer queues.** One per-instance pool of 16KB buffers feeds all of that instance's receive queues, so buffer provisioning no longer scales with core count. Coordination is software-only — per-core reference counters per slot (no shared cachelines) plus a high-priority refill thread — where the earlier ShRing work argued NIC hardware changes were needed. Ablation: −35% footprint.
2. **Multi-packet receive buffers.** Many packets land consecutively in one buffer, cutting minimum per-packet memory from MTU size (1500–9000B) to 256B. Ablation: another −48%, landing at the 33MB per-instance figure.

The second density wall is the scheduler. Caladan-style centralized schedulers busy-poll every instance's queues; past a few hundred instances the polling pass itself pollutes the cache and collapses. Junction's fix is again a repurposed NIC feature: a single **event queue** on the scheduler core. When the scheduler sees an empty receive queue it *arms* it; the NIC writes one event on the next arrival and disarms. Idle instances cost the scheduler nothing until a packet actually shows up (4x more instances), and a 16µs hierarchical timer wheel removes timer polling for instances with no imminent deadline (another 1.69x).

Density also comes from admitting the host kernel is good at one thing: the page cache. Instances get read-only jail access precisely so identical binaries and shared libraries map to shared disk blocks — something VMs can't do. With 1,500 identical instances, sharing the application binary cut total CPU 65%→36%, mostly from i-cache sharing. The authors' pointed corollary: static linking, standard practice in many fleets, actively squanders performance at high density.

## Compatibility: syscalls as function calls, signals as user interrupts

Junction's ELF loader transparently swaps in a modified glibc whose syscall sites jump straight into the library OS through an ASLR-aware trampoline. Because a "syscall" is now a plain function call under the standard calling convention, vector and FP registers are caller-clobbered — no register save/restore, and the OS itself compiles with full vectorization. seccomp traps remain as a fallback for raw `SYSCALL` instructions (Go, which bypasses libc, either runs via the trap path unmodified or via a new Go compiler OS target).

Signals — which real cloud software uses constantly (Go preempts goroutines with them; HotSpot implicit-null-checks with them) — are rebuilt on Intel's **user interrupts (UIPIs)**: `SENDUIPI` delivers an IPI userspace-to-userspace, `UIRET` returns atomically without `rt_sigreturn()`. The authors' measurements show UIPIs cut preemption overhead 2.35x versus Linux signals, which is what makes microsecond-granularity timeslicing of user threads affordable — the same lever Shinjuku pulled for tail latency, now without a custom kernel. One honest caveat from their appendix: for *core reallocation* (rare), UIPIs barely mattered; the win is confined to fine-grained timeslicing.

## Why this matters

The interesting reading of Junction isn't "kernel bypass got faster" — it's that the OS/hardware boundary quietly moved. Every abstraction in the table above used to require a privileged kernel; now commodity NICs and CPUs expose enough capability that a *deprivileged, per-tenant* OS can be built from them, with the host kernel reduced to a core-and-memory multiplexer behind 11 syscalls. That's simultaneously a performance story (1.6–7x over Linux for unmodified Node/Go/Java servers), a density story (37MB of RAM per instance at 3,500 instances), and a security story (a smaller trusted interface than gVisor, without VM exits). The main deployment frictions are real but narrowing: UIPIs ship only on Sapphire Rapids and later (there's a signal-based fallback), and the buffer tricks are mlx5-specific today. If serverless platforms — which already keep thousands of warm instances resident per machine precisely to dodge cold starts — adopt this shape, the kernel's remaining role in the datapath is essentially zero.
