---
title: "How CPython Actually Removed the GIL: Biased Reference Counting, Deferred RC, and QSBR"
date: 2026-09-15
tags: ["python", "concurrency", "memory-management", "interpreters", "runtime-systems"]
excerpt: "Free-threaded CPython went from an experiment with ~40% single-threaded overhead in 3.13 to officially supported (PEP 779) at 5-10% in 3.14. The interesting part is how: a split local/shared refcount that keeps the owner thread's path non-atomic, deferred counting for hot shared objects, mimalloc as a GC substrate, and a FreeBSD GUS-style quiescent-state scheme that makes lock-free dict and list reads safe."
---

# How CPython Actually Removed the GIL: Biased Reference Counting, Deferred RC, and QSBR

Python 3.14 shipped with free-threading officially supported (PEP 779). The 3.13 free-threaded build was an experiment that cost about 40% on the pyperformance suite; in 3.14 the penalty is roughly 5–10%, with the specializing adaptive interpreter (PEP 659) re-enabled in a thread-safe form. Getting there was not a matter of "replace the GIL with a big lock per object." The GIL was load-bearing for three separate subsystems — reference counting, the cycle collector, and every mutating container operation — and PEP 703 replaces each with a different mechanism. Those mechanisms are the interesting part, because they are the same tricks that show up in kernels and databases: biased locking, deferred reclamation, and epoch-based memory safety.

## Why reference counting is the hard part

CPython increments and decrements refcounts constantly — every stack push in the interpreter loop touches `ob_refcnt`. Under the GIL those are plain non-atomic ops. The naive fix, making every `Py_INCREF` an atomic RMW, fails twice: it slows single-threaded code substantially, and it destroys multi-threaded scaling anyway, because threads sharing any hot object (a module, a class, `None` before PEP 683) serialize on its cache line.

PEP 703 attacks this with three tiers, ordered by how shared an object is.

**Tier 1: biased reference counting** (from Choi, Shull, and Torrellas, 2018) splits the count in two. The object header gains an owning thread id (`ob_tid`), a 32-bit local count (`ob_ref_local`), and a shared count (`ob_ref_shared`):

```c
// Fast path: only the thread that created the object takes it.
if (op->ob_tid == _Py_ThreadId()) {
    op->ob_ref_local += 1;              // plain, non-atomic write
} else {
    // Cross-thread: atomic on the shared field. Low 2 bits are state.
    atomic_add(&op->ob_ref_shared, 1 << _Py_SHARED_SHIFT);  // shift = 2
}
```

The bet is that most objects are only ever touched by their creating thread, so the common case stays as cheap as the GIL build's. The two low bits of `ob_ref_shared` encode a state machine — `default`, `weakrefs`, `queued`, `merged` — that only moves upward. If a non-owning thread drives the shared count negative (it decref'd more than it incref'd, meaning it dropped references the owner handed over), the object enters `queued` and the owning thread is poked via the eval breaker to merge the two counts. Deallocation is only legal from `default` (the owner sees both counts and the shared state is untouched) or `merged`. It's biased locking transplanted to refcounts: pay atomics only when sharing is proven, not assumed.

**Tier 2: immortalization.** `True`, `None`, small ints, interned strings, and static type objects get `ob_ref_local = UINT32_MAX`, and `Py_INCREF`/`Py_DECREF` become no-ops on them. No count, no contention.

**Tier 3: deferred reference counting**, for the awkward middle: top-level functions, code objects, modules, classes. These are hot and shared across threads but don't live forever, so immortalizing them leaks. The 3.13 build actually did leak — it immortalized module-level functions, code objects, and classes the moment a second thread started, and the HOWTO warned that memory usage would grow. 3.14 replaced that stopgap with the real design: two bits in the local refcount field mark the object as deferred, and the interpreter simply skips refcount operations for stack pushes and pops of such objects. The cost is that their true count is only known during a stop-the-world pause, so they can only be freed by the cycle collector — which is why every deferred object must be GC-tracked, and why the free-threaded GC became single-generation (fewer, more meaningful pauses).

## mimalloc as a GC substrate, not just an allocator

pymalloc isn't thread-safe without the GIL, so a new allocator was needed regardless — but mimalloc was chosen for two structural reasons beyond speed. First, the cycle collector can enumerate every live object by walking mimalloc's page metadata, which let CPython delete the `_gc_prev`/`_gc_next` doubly-linked list threaded through every GC object's header. Second, mimalloc's size-class-segregated pages are what make the lock-free read paths below sound: objects are allocated from distinct heaps (non-GC, GC-with-managed-dict, GC-without), so a freed slot is only ever reused by an object whose refcount field sits at the same offset — a dangling read sees a zero or valid count, never garbage interpreted as a count.

## Containers: per-object locks, but reads don't take them

Every mutable container carries a 1-byte `PyMutex`. Mutations lock the object (`list.append`, `dict.__setitem__`); operations on two containers (`list.extend(other)`) lock both in address order via `Py_BEGIN_CRITICAL_SECTION2`. Critical sections have a property borrowed from the GIL's semantics: anywhere the old runtime would have released the GIL to block, held critical sections are suspended and reacquired afterward, which quietly avoids most lock-ordering deadlocks that hand-written per-object locking would hit.

The performance-critical decision is that reads don't lock at all. `dict[k]`, `list[i]`, and iteration use optimistic concurrency:

```c
// Sketch of the lock-free list read path
item = atomic_load(&ob_item[i]);
if (!_Py_TRY_INCREF(item))         goto retry_locked;  // conditional incref
if (item != atomic_load(&ob_item[i])) goto retry_locked;  // slot changed?
if (ob_item != atomic_load(&list->ob_item)) goto retry_locked;  // resized?
return item;
```

The incref is conditional because the item may be mid-deallocation; the re-checks detect a concurrent overwrite or resize and fall back to the locked path. But there's a hole: what if the backing array itself was freed and its memory reused between the load and the checks? That's where QSBR comes in. Free-threaded CPython defers reuse of mimalloc pages using a scheme modeled on FreeBSD's GUS (a relative of RCU and Linux's `SLAB_TYPESAFE_BY_RCU`): a global write sequence number tags each emptied page, each thread publishes a read sequence number at quiescent points, and a page is only recycled once the minimum across all threads passes its tag. Any thread still inside an optimistic read holds an older sequence number, so the memory it might dereference cannot be repurposed under it. This is the same reasoning as epoch-based reclamation in lock-free data structure libraries — applied to an interpreter's core types.

## What it costs, honestly

PEP 703's reference implementation (against 3.12) measured 5–6% single-threaded overhead on pyperformance (Skylake/Zen 3), with biased refcounting the largest contributor, then per-object locking. The shipped 3.13 build was far worse — about 40% — mostly because the specializing adaptive interpreter had to be disabled until specialization could be made thread-safe. 3.14 re-enabled it and landed in the 5–10% band, which is why PEP 779 declared the build officially supported rather than experimental.

Detecting what you're running (verified on CPython 3.14.7):

```python
import sys, sysconfig
sysconfig.get_config_var("Py_GIL_DISABLED")  # 1 = free-threaded build
sys._is_gil_enabled()   # False only if the GIL is actually off at runtime
```

The second check matters because the GIL can come back at runtime: `PYTHON_GIL=1`, or importing a C extension that doesn't declare `Py_mod_gil = Py_MOD_GIL_NOT_USED`, re-enables it in 3.13/3.14 rather than crashing.

## When to care

The trade PEP 703 offers: threads start in ~100 µs and share memory directly, versus ~50 ms and serialization overhead for a `multiprocessing` worker. For workloads that are parallel over shared, mutable Python state — agent frameworks fanning out over a shared cache, feature pipelines over a large in-memory dict, anything currently contorted around `multiprocessing.shared_memory` — free-threading removes an architecture tax, at 5–10% straight-line cost. The mechanisms are worth knowing even if you never ship a `python3.14t` binary, because the pattern — bias the common case to be non-atomic, defer the shared case to a pause, and let epochs make optimistic readers safe — is the standard recipe for retrofitting concurrency onto a refcounted runtime, and CPython is now the largest deployed proof that it works.

Numbers and mechanisms above are drawn from PEP 703, the CPython 3.13 free-threading HOWTO (40% figure, 3.13 immortalization stopgap), and the 3.14 release notes (PEP 779, 5–10%, PEP 659 re-enablement); the detection snippet was run locally on 3.14.7.
