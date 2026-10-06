---
title: "Compact Object Headers in JDK 25: 22-Bit Class Pointers, a Monitor Table, and the 39% of Classes That Save Nothing"
date: 2026-10-07
tags: ["jvm", "garbage-collection", "memory-layout", "java", "performance"]
excerpt: "JEP 519 made compact object headers a product feature in JDK 25. They fold a 22-bit class pointer into the mark word and shrink headers from 12 bytes to 8. I read the header bits directly on JDK 25.0.4. HashMap<Long,Long> drops from 96.8 to 72.8 bytes per entry and runs 8.9% faster with 19% fewer GCs. ArrayList<Integer> saves exactly nothing, and 39% of java.base classes don't shrink at all. A parity rule on field payload predicts which ones."
---

# Compact Object Headers in JDK 25: 22-Bit Class Pointers, a Monitor Table, and the 39% of Classes That Save Nothing

Every HotSpot object starts with a header. On 64-bit JVMs with compressed class pointers that header is 12 bytes: an 8-byte *mark word* (lock state, GC age, identity hash) plus a 4-byte *class word*. Project Lilliput's measurements put typical average object sizes at 32–64 bytes, so headers can be more than 20% of live data.

JEP 450 (experimental in JDK 24) and JEP 519 (product in JDK 25) merge the two words into a single 64-bit header. You enable it with `-XX:+UseCompactObjectHeaders`, and it is still off by default. The JEP reports 22% less heap and 8% less CPU on SPECjbb2015.

I ran a Temurin 25.0.4.1 build on an M3 Pro, read headers with `Unsafe.getLong(o, 0)`, and measured layouts, footprint and GC behaviour in both modes. The headline number holds up, but it hides a sharp quantization effect.

## The layout

JEP 450 specifies the compact header like this:

```text
64                    42                             11   7   3  0
 [CCCCCCCCCCCCCCCCCCCCCCHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHVVVVAAAASTT]
  class ptr (22 bits)    identity hash (31 bits)     Valhalla age  tag
                                                              self-fwd
```

To make this fit, four mechanisms had to change.

1. **The class pointer shrinks from 32 to 22 bits.** You can see it in `-Xlog:gc+metaspace`:

   ```text
   legacy : Narrow klass pointer bits 32, Max shift 3   ... Narrow klass shift: 0
   compact: Narrow klass pointer bits 22, Max shift 10  ... Narrow klass shift: 10
   ```

   With a shift of 10, every `Klass` must start on a 1 KiB boundary, and 2^22 × 1 KiB = 4 GiB of addressable class space. That caps the JVM at about 4M loaded classes.

2. **Locking must never overwrite the header.** The old stack-locking scheme copied the mark word onto the thread's stack and replaced it with a pointer, which would destroy the class pointer. Lightweight locking (`LockingMode=2`, now the default in both modes) only flips the two tag bits and records ownership in a per-thread lock stack. Inflated monitors go one step further: with compact headers, the JVM switches on the diagnostic flag `UseObjectMonitorTable` (it stays `false` in legacy mode). The monitor is then found through a side hash table instead of a pointer in the header.

3. **GC forwarding needs a self-forward bit.** When copying an object fails during evacuation, the old code installed a forwarding pointer back to the object itself. That would erase the class. Bit 2 now marks "self-forwarded" instead.

4. **Sliding (full) GCs encode forwarding in the low 42 bits**, reaching 8 TB. Bigger heaps without ZGC silently disable compact headers.

## Watching the bits

The probe decodes the raw header at each lifecycle step:

```java
long m = U.getLong(o, 0L);
String.format("klass=%06x hash=%08x age=%d sf=%d tag=%d%d",
    m >>> 42, (m >>> 11) & 0x7fffffffL, (m >>> 3) & 0xf,
    (m >>> 2) & 1, (m >>> 1) & 1, m & 1);
```

Compact mode:

```text
fresh     raw=0017600000000001 klass=0005d8 hash=00000000 tag=01
hashed    raw=0017629828345001 klass=0005d8 hash=5305068a tag=01
locked    raw=0017629828345000 klass=0005d8 hash=5305068a tag=00   # lightweight
inflated  raw=0017629828345002 klass=0005d8 hash=5305068a tag=10   # monitor, via table
```

The class and hash bits survive every transition, and only the tag changes. Legacy mode looks different:

```text
hashed    raw=0000017c9707a001                                     # idHash 0x2f92e0f4
locked    raw=0000017c9707a000                                     tag=00
inflated  raw=00000008d90e3802                                     # ObjectMonitor* | 10
```

Two things stand out. First, inflating a legacy monitor still overwrites the whole mark word with an `ObjectMonitor*`, and the hash is displaced into the monitor. Second, `0x2f92e0f4 << 11 | 1 = 0x17c9707a001`. So in JDK 25 the *legacy* identity hash also sits at bit 11, not bit 8 as the "current layout" diagram in JEP 450 shows. The low 42 bits now use the same layout in both modes. That diagram describes pre-JDK 24 HotSpot.

## Where the 8 bytes actually go

HotSpot rounds every object up to 8 bytes (`ObjectAlignmentInBytes=8`). Let p be the size of the packed fields. The two sizes are:

```text
legacy  = roundup8(12 + p)
compact = roundup8( 8 + p)
```

These differ only when `p mod 8 ∈ {0, 5, 6, 7}`. With compressed oops, references and ints are both 4 bytes, so most payloads are a multiple of 4. That turns the saving into a coin flip on whether a class has an even or odd number of 4-byte slots:

| Class | Payload | Legacy | Compact |
|---|---|---|---|
| `Object` | 0 | 16 | **8** |
| `Integer` | 4 | 16 | 16 |
| `Long` | 8 | 24 | **16** |
| `String` | 10 | 24 | 24 |
| `HashMap.Node` | 16 | 32 | **24** |
| `LinkedList.Node` | 12 | 24 | 24 |
| `BigInteger` | — | 40 | **32** |

I then computed instance sizes from `Unsafe.objectFieldOffset` for every concrete class in `java.base`. That is 5,756 classes, after excluding three reflection-filtered `java.lang.invoke` classes whose injected fields the probe cannot see. **60.8% save exactly 8 bytes and 39.2% save nothing.** The unweighted mean instance size falls from 30.9 to 26.0 bytes, or 15.7%.

With `-XX:-UseCompressedOops` (8-byte references, as on heaps above 32 GB), the split moves to 68%/32%. But some hot classes lose their saving entirely. `HashMap.Node` becomes 40 bytes in both modes, because 8 + 4 + 3×8 = 36 still rounds up to 40.

Arrays follow the same rule with a twist. The 4-byte length now sits right after the 8-byte header, so the element base offset drops from 16 to 12:

```text
base byte[]=12  int[]=12  Object[]=12  long[]=16
```

A `long[]` or `double[]` still needs 8-byte-aligned elements, so it starts at 16 in both modes and saves nothing. A `byte[n]` saves 8 bytes only when `n mod 8 ∈ {1..4}`.

## Real footprint

I measured live heap per element after a forced full GC (`-XX:+UseSerialGC`, 2M elements):

| Workload | Legacy B/elem | Compact B/elem | Δ |
|---|---|---|---|
| `HashMap<Long,Long>` | 96.8 | 72.8 | **−24.8%** |
| `TreeMap<String,Integer>` (per entry) | 112 | 96 | −14.3% |
| 10-char `String[]` | 60.1 | 52.0 | −13.5% |
| `ArrayList<Integer>` | 20.0 | 20.0 | **0%** |
| `long[4][]` | 52.0 | 52.0 | **0%** |

Every row matches the layout arithmetic to the byte. For `HashMap`, the Node goes 32→24 and both `Long`s go 24→16; the rest is the 16.8-byte table slot share. For `String`, the String itself stays at 24 while its `byte[10]` drops 32→24. So the 10–20% live-data reduction JEP 450 cites from early adopters depends heavily on the mix of types in a workload, not just on object count.

## Throughput

Next I built and iterated a 3M-entry `HashMap<Long,Long>` 12 times under G1 with a fixed 1 GB heap. I dropped the first two rounds as warmup, took the median of the remaining ten, and repeated the whole run three times:

```text
legacy : median 1617–1644 ms, 33–37 GCs, 2.54–2.72 s GC time
compact: median 1463–1527 ms, 27–28 GCs, 2.36–2.38 s GC time
```

That is **8.9% faster, with 19% fewer collections and 9.4% less GC time**. Smaller objects mean fewer allocation-triggered GCs and more entries per cache line, which lines up with the JEP's SPECjbb numbers (8% less CPU, 15% fewer GCs).

The cost side is harder to measure. Inflated-monitor lookups now go through `ObjectMonitorTable`, and I tried to price that. But HotSpot's async deflater kept collapsing my inflated monitors (73k deflated in 32 ms in one run), so the benchmark measured a mix of lightweight and inflated paths. I'm not reporting those numbers. If your hot path waits and notifies on many distinct objects, benchmark it yourself.

## One surprise in class space

The 1 KiB `Klass` alignment looks wasteful, so I defined 20,000 hidden classes per mode and diffed consecutive narrow class IDs:

```text
legacy : klass-id delta 1024 (shift 0)  -> 1024-byte stride, committed 1022 B/class
compact: klass-id delta 1    (shift 10) -> 1024-byte stride, committed 1022 B/class
```

In JDK 25, Klasses are on a 1 KiB stride **in both modes**, so compact headers add no class-space cost. Separately, the `Compressed Class Space` memory pool reports 528 B/class as "used" while committed memory grows at about 1,022 B/class. For small classes, monitoring class-space "used" understates the real footprint by roughly 2×.

## Practical guidance

- **Turn it on for allocation-heavy services on JDK 25+:** `-XX:+UseCompactObjectHeaders`, no unlock flag needed. Workloads full of `Long`/`Double` boxes, small value objects and map nodes gain the most.
- **Run JOL or an offset census on your hot types before projecting savings.** Odd-slot classes get nothing, and reordering fields can't help.
- **Check the limits.** More than 8 TB of heap without ZGC turns the feature off. JEP 450 also disabled the feature when JVMCI is enabled on x64. And the 22-bit class pointer caps the JVM at about 4M classes, which matters only for extreme class generation.
- **Next: 4-byte headers.** Lilliput's end goal needs side storage for identity hashes. When it lands, the parity rule flips, and today's odd-slot classes become the ones that save.
