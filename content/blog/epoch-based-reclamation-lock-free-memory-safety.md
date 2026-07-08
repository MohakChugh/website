---
title: "Epoch-Based Reclamation: How Lock-Free Data Structures Safely Free Memory"
date: 2026-07-08
tags: ["concurrency", "memory-management", "lock-free", "systems-programming"]
excerpt: "Exploring epoch-based reclamation (EBR), the technique that lets lock-free data structures deallocate memory without garbage collection, from the foundational quiescent-state mechanism through Crossbeam's production implementation to recent advances like PEBR and Hyaline."
---

# Epoch-Based Reclamation: How Lock-Free Data Structures Safely Free Memory

Lock-free data structures promise scalable concurrency without mutex contention. But they introduce a deceptively hard problem: **when can you free memory?** In a lock-based world, a thread holding a write lock knows no one else is reading. In a lock-free world, any number of threads might hold a pointer to a node you just logically removed. Free it too early and you corrupt another thread's stack. Free it too late (or never) and you leak memory until the process dies.

This is the **safe memory reclamation** (SMR) problem, and epoch-based reclamation (EBR) is the most widely deployed solution in production systems today.

## The Problem: Use-After-Free in Concurrent Code

Consider a lock-free linked list. Thread A traverses the list, reading node N's `next` pointer. Between that read and A's subsequent dereference, thread B unlinks N and calls `free(N)`. Thread A now dereferences freed memory.

```c
// Thread A                        // Thread B
node_t *curr = head;               //
node_t *next = curr->next;         // CAS unlinks curr from list
                                   // free(curr);  <-- UNSAFE!
int val = next->value;             // Use-after-free: next may be curr
```

Garbage-collected languages sidestep this entirely, but systems languages (C, C++, Rust) need explicit solutions. The three major approaches are **hazard pointers**, **epoch-based reclamation**, and **reference counting**. EBR wins on read-side overhead: zero per-access cost versus one atomic store per pointer load for hazard pointers.

## Epoch-Based Reclamation: Core Mechanism

EBR divides time into **epochs** (typically three: 0, 1, 2 cycling). The protocol has four rules:

1. **Pin on entry**: Before accessing shared data, a thread announces it has entered the current global epoch by writing to its thread-local epoch slot.
2. **Defer on removal**: When a thread unlinks a node, it doesn't free immediately. Instead it places the node on a thread-local **garbage list** tagged with the current epoch.
3. **Try to advance**: Periodically, a thread checks if all active threads have observed the current epoch. If so, it advances the global epoch.
4. **Reclaim safely**: After the epoch advances twice, any garbage tagged with epoch `(global - 2)` is guaranteed unreachable. All pinned threads have moved past that era.

```
Global epoch: 2

Thread A: pinned at epoch 2  ──> can see nodes from epoch 2, maybe 1
Thread B: pinned at epoch 2  ──> same
Thread C: pinned at epoch 1  ──> still traversing old-epoch data

Garbage tagged epoch 0: SAFE to free (all threads have advanced past 0)
Garbage tagged epoch 1: NOT safe (Thread C might still reference it)
Garbage tagged epoch 2: NOT safe (current epoch)
```

The beauty is **zero overhead on the read path** beyond the initial pin. No memory fences per pointer load, no registration per hazardous reference. Just one atomic store at entry, one at exit.

## Production Implementation: Crossbeam-Epoch

Rust's `crossbeam-epoch` crate is the canonical production EBR implementation, used by DashMap, Flurry (concurrent HashMap), and numerous lock-free data structures. Its API distills EBR into three primitives:

```rust
use crossbeam_epoch::{self as epoch, Atomic, Owned, Shared};
use std::sync::atomic::Ordering;

struct Node {
    key: u64,
    next: Atomic<Node>,
}

fn remove(head: &Atomic<Node>, target_key: u64) {
    // Pin the current thread to this epoch
    let guard = epoch::pin();

    let mut prev = head;
    let mut curr = head.load(Ordering::Acquire, &guard);

    while let Some(node) = unsafe { curr.as_ref() } {
        let next = node.next.load(Ordering::Acquire, &guard);

        if node.key == target_key {
            // CAS to unlink
            if prev.compare_exchange(
                curr, next, Ordering::Release, Ordering::Relaxed, &guard
            ).is_ok() {
                // Defer deallocation until safe
                unsafe { guard.defer_destroy(curr); }
            }
            return;
        }
        prev = &node.next;
        curr = next;
    }
}
```

The `guard` returned by `epoch::pin()` serves dual purpose: it announces the thread's presence in the current epoch, and it provides a lifetime token that prevents the compiler from letting `Shared` references escape beyond the critical section. When `guard` drops, the thread unpins and may trigger garbage collection.

### Internal Architecture

Crossbeam-epoch maintains per-thread state in a **participant list** (an intrusive linked list of thread slots). Each slot contains:

- A local epoch counter (atomic `u64`, using the two low bits for epoch and high bits for an "active" flag)
- A thread-local garbage bag (a `Vec<Deferred>` of pending deallocations)

When a bag fills (default: 64 entries), it's sealed and moved to a **global garbage queue** partitioned by epoch. The advancement logic iterates the participant list; if every active participant's local epoch matches the global epoch, the global epoch increments and the two-epochs-ago garbage queue is drained.

## The Stalled-Thread Problem

EBR's Achilles' heel: a single thread pinned for a long time blocks epoch advancement for everyone. If thread C pins at epoch 1 and then sleeps (or runs a long computation), no garbage from epoch 1 or 2 can ever be freed until C unpins. In the worst case, memory grows unboundedly.

This isn't theoretical. Workloads with mixed short-read and long-scan operations routinely trigger this. A thread performing a full table scan holds its pin for milliseconds while thousands of concurrent mutations accumulate unreclaimable garbage.

## Modern Solutions: PEBR, Hyaline, and NBR

Recent research addresses EBR's limitations while preserving its low read-side cost:

**PEBR (Process-wide Epoch-Based Reclamation, 2024)** extends the epoch mechanism with per-node **birth epochs**. Instead of three global epochs, PEBR tracks fine-grained reachability: a node is safe to free when no thread's pin predates the node's retirement. This allows partial reclamation even when one thread is stalled, recovering memory for nodes retired after the stalled thread pinned.

**Hyaline (Nikolaev & Ravindran, 2020)** eliminates the participant-list scan entirely. It uses a **reference-counting chain** among retiring threads: each retired node embeds a next pointer into a retirement list. The last thread to leave an era decrements a shared counter; when it reaches zero, the entire batch is freed in one sweep. This achieves O(1) reclamation without scanning all threads.

**NBR (Neutralization-Based Reclamation, 2021)** takes a radical approach: if a thread is stalled, NBR **neutralizes** it by signaling it (via `SIGUSR1` or similar) to restart its operation. The stalled thread's traversal is aborted and retried, allowing the epoch to advance. This bounds memory to O(P * R) where P is thread count and R is nodes retired per epoch.

## Performance Characteristics

Benchmarks on a 128-core AMD EPYC with a concurrent skip list show the tradeoffs clearly:

| Scheme | Read overhead (ns/op) | Write overhead (ns/op) | Memory bound |
|--------|----------------------|----------------------|--------------|
| Hazard Pointers | ~15 (atomic store/load per ptr) | ~5 | O(P * K) tight |
| EBR (Crossbeam) | ~2 (pin/unpin amortized) | ~8 (defer + bag) | Unbounded (stall) |
| PEBR | ~3 | ~12 | O(P * R) |
| Hyaline | ~2 | ~10 | O(P * R) |

EBR dominates read-heavy workloads (95%+ reads) where stalls are unlikely. For write-heavy or mixed workloads with long operations, PEBR or Hyaline provide bounded memory without sacrificing the fast read path.

## When to Use What

**Use EBR** (Crossbeam-epoch, `rcu_read_lock` in Linux) when:
- Read operations vastly outnumber writes
- Critical sections are short and predictable
- Memory growth during transient stalls is acceptable

**Use Hazard Pointers** (C++26 `std::hazard_pointer`) when:
- Strict memory bounds are required
- The number of concurrent traversal pointers per thread is small and fixed
- You can tolerate higher read-side latency

**Use PEBR/Hyaline** when:
- Mixed read/write workloads with occasional long operations
- Bounded memory is required but read-side overhead must stay minimal
- The system cannot tolerate unbounded growth from stalled threads

## The Linux Kernel Connection: RCU

Read-Copy-Update (RCU) in the Linux kernel is essentially EBR adapted for kernel context. Grace periods correspond to epoch advancement; `rcu_read_lock()` is the pin; `call_rcu()` is deferred reclamation. The kernel's advantage is that context switches serve as implicit quiescent states, the scheduler itself drives epoch advancement. This is why RCU is practically free on the read side in kernel code: the pin is a preemption disable, not even an atomic operation.

## Conclusion

Epoch-based reclamation solves the fundamental tension in lock-free programming: achieving zero-cost reads while guaranteeing memory safety. Its elegance lies in amortization, rather than tracking individual pointers (hazard pointers) or individual objects (reference counting), EBR tracks *time*. By dividing execution into epochs and waiting for all threads to advance, it converts the per-object question "is anyone looking at this?" into the global question "has everyone moved on?" The answer costs nothing to check on the read path and everything to answer on the reclamation path, exactly the tradeoff that read-dominated concurrent systems need.
