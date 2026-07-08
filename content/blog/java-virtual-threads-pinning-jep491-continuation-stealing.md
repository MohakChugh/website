---
title: "Virtual Thread Pinning: How JEP 491 Finally Solved Java's Last Concurrency Bottleneck"
date: 2026-07-09
tags: [java, concurrency, virtual-threads, jvm, performance]
excerpt: "Project Loom promised millions of concurrent tasks on a handful of OS threads. Synchronized blocks broke that promise by pinning continuations to carriers. JEP 491 in Java 24 eliminates pinning entirely through object monitor reimplementation, closing the last major gap in virtual thread adoption."
---

# Virtual Thread Pinning: How JEP 491 Finally Solved Java's Last Concurrency Bottleneck

Project Loom shipped in Java 21 with a bold promise: replace the one-thread-per-request model with lightweight virtual threads that park and resume without blocking OS threads. The JVM would multiplex millions of virtual threads onto a small pool of carrier (platform) threads, making blocking I/O as scalable as async code while keeping the synchronous programming model.

It worked, with one critical exception. Any virtual thread that entered a `synchronized` block while performing a blocking operation became **pinned** to its carrier thread. The carrier couldn't be reused by other virtual threads, and the throughput advantage vanished. JEP 491, delivered in Java 24 (March 2025), eliminates this problem entirely by reimplementing object monitors at the VM level.

## The Continuation Model

Virtual threads are implemented as **delimited continuations** scheduled by a `ForkJoinPool`. When a virtual thread blocks on I/O (socket read, `Thread.sleep`, `LockSupport.park`), the runtime:

1. Saves the virtual thread's stack frames into a heap-allocated continuation object
2. Unmounts the continuation from the carrier thread
3. Returns the carrier to the fork-join pool for other work
4. When the I/O completes, remounts the continuation onto any available carrier

```java
// Conceptual model of virtual thread scheduling
class VirtualThread {
    Continuation continuation; // heap-allocated stack frames
    
    void run() {
        continuation.run(); // mounts on current carrier
    }
    
    void park() {
        Continuation.yield(); // unmounts, frees carrier
    }
}
```

The key insight: yielding a continuation is purely a userspace operation. No kernel context switch, no thread destruction. The JVM copies a few stack frames to the heap (typically 1-10 KB) and the carrier immediately picks up another virtual thread. This enables throughput of hundreds of thousands of concurrent blocking operations on a pool of `Runtime.availableProcessors()` carriers.

## Why Synchronized Caused Pinning

Java's `synchronized` keyword compiles to `monitorenter`/`monitorexit` bytecodes. Before JEP 491, the JVM implemented these using the carrier thread's identity. The object monitor's owner was recorded as the OS thread, not the virtual thread. This created an inescapable constraint: if a virtual thread held a monitor and attempted to yield its continuation, the monitor's ownership invariant would break.

The JVM's solution was simple and brutal: **don't yield**. When a virtual thread blocked inside a synchronized region, the runtime refused to unmount the continuation. The carrier thread blocked directly, pinned in place:

```java
// This pattern caused pinning in Java 21-23
synchronized (lock) {
    // Any blocking call here pins the carrier
    socket.read(buffer);  // carrier thread blocks on OS read()
    // No other virtual thread can use this carrier until read completes
}
```

With the default `ForkJoinPool` parallelism equal to CPU cores, pinning a single carrier on a 16-core machine immediately reduced effective concurrency by 6.25%. Pin all 16 carriers and the system deadlocks: no carrier is available to run any virtual thread, even those not contending on the lock.

## Detecting Pinning in Production

The JVM provides a system property for diagnosis:

```bash
java -Djdk.tracePinnedThreads=short MyApp
```

This prints stack traces when pinning occurs. A more production-friendly approach uses JFR (Java Flight Recorder) events:

```java
// JFR event: jdk.VirtualThreadPinned
// Available since Java 21
// Fields: duration, carrier thread, stack trace
```

The `jdk.VirtualThreadPinned` event fires whenever a virtual thread blocks while pinned. In Java 21-23, any significant count of these events indicates a throughput problem. Common sources:

- JDBC drivers using `synchronized` internally
- `java.io` stream classes (e.g., `BufferedInputStream.read()`)
- Logging frameworks holding monitors during I/O
- Any third-party library written before virtual threads existed

## The Mitigation: ReentrantLock (Java 21-23)

The recommended workaround was replacing `synchronized` with `java.util.concurrent.locks.ReentrantLock`, which virtual threads can yield while holding:

```java
// Before: causes pinning
synchronized (this) {
    return connection.query(sql);
}

// After: allows unmounting
private final ReentrantLock lock = new ReentrantLock();

lock.lock();
try {
    return connection.query(sql);
} finally {
    lock.unlock();
}
```

This works because `ReentrantLock` uses `LockSupport.park()` internally, which the virtual thread scheduler understands. The lock's owner is tracked as the virtual thread, not the carrier. However, this approach has severe practical limitations:

1. **Third-party code**: You cannot rewrite JDBC drivers, logging frameworks, or the JDK's own `java.io` classes
2. **Semantic differences**: `ReentrantLock` doesn't support `wait()`/`notify()` (you need `Condition` objects)
3. **Migration cost**: Large codebases have thousands of `synchronized` blocks; identifying which ones are on hot paths requires profiling

## JEP 491: Monitor Reimplementation

JEP 491 (Java 24, March 2025) solves the problem at its root. Object monitors are reimplemented so that:

1. Monitor ownership is tracked by **virtual thread identity**, not carrier thread identity
2. When a virtual thread blocks while holding a monitor, the continuation **can still yield**
3. The monitor remains logically held by the virtual thread even after unmounting

The implementation required deep changes to the HotSpot VM:

### Lightweight Locking Path

For uncontended monitors (the fast path, ~95% of cases in typical workloads), the object header's mark word still uses CAS-based thin locking. The change: the owner recorded is a pointer to the virtual thread's `JavaThread` structure, not the carrier's:

```
// Object header mark word layout (simplified)
// Before JEP 491: [carrier_thread_ptr | 00] (thin lock, carrier identity)
// After JEP 491:  [virtual_thread_ptr | 00] (thin lock, virtual thread identity)
```

### Contended Path with Yield

When a virtual thread holding a monitor blocks on I/O, the runtime now:

1. Records the monitor as "held by virtual thread V, currently unmounted"
2. Yields the continuation, freeing the carrier
3. If another virtual thread attempts to enter the same monitor, it sees it's held and parks (also yielding its own carrier)
4. When V's I/O completes, V is rescheduled on any carrier and resumes inside the synchronized block

```java
// This is now safe in Java 24+: no pinning
synchronized (lock) {
    byte[] data = socket.read(buffer); // continuation yields, carrier freed
    process(data);
} // monitor released normally on exit
```

### wait()/notify() Without Pinning

The `Object.wait()` method, which releases the monitor and suspends the thread, also benefits. Before JEP 491, `wait()` inside a `synchronized` block doubly pinned: the thread was both holding a monitor and waiting. Now, `wait()` properly unmounts the continuation after releasing the monitor, and re-acquires it on `notify()` without requiring the same carrier.

## Performance Impact

Benchmarks from the JEP and independent testing show:

| Scenario | Java 23 (pinning) | Java 24 (JEP 491) | Improvement |
|----------|-------------------|--------------------|----|
| 10K concurrent JDBC queries (synchronized driver) | ~200 carriers pinned, throughput collapse | Full virtual thread scaling | 5-50x throughput |
| BufferedInputStream over network socket | 1 carrier pinned per stream | No pinning | Linear with carrier count |
| Mixed workload, 1% synchronized I/O | ~15% carrier starvation | 0% starvation | Eliminates tail latency spikes |

The critical observation: even a small fraction of synchronized blocking I/O could cascade into throughput collapse under load, because pinned carriers create a feedback loop (fewer carriers → more queueing → more virtual threads blocked waiting → longer pin durations).

## What This Means for Adoption

JEP 491 removes the last major caveat in virtual thread migration guidance. Before Java 24, adopting virtual threads required:

- Auditing every dependency for `synchronized` blocks on I/O paths
- Replacing `synchronized` with `ReentrantLock` where possible
- Accepting that some libraries would silently degrade performance
- Monitoring `jdk.VirtualThreadPinned` events as a production concern

After Java 24, `synchronized` and `ReentrantLock` are equivalent from the virtual thread scheduler's perspective. The migration story becomes: replace `new Thread()` or thread pool submissions with `Thread.startVirtualThread()` or `Executors.newVirtualThreadPerTaskExecutor()`, and the runtime handles the rest.

```java
// The entire server migration, post-Java 24
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    while (true) {
        Socket client = serverSocket.accept();
        executor.submit(() -> handleRequest(client)); // millions of these, no tuning
    }
}
```

No pool sizing, no carrier math, no pinning audits. The JVM's continuation machinery handles multiplexing transparently, regardless of how the application's synchronization is structured. For teams running high-concurrency services, Java 24 is the version where virtual threads deliver on their original promise without footnotes.
