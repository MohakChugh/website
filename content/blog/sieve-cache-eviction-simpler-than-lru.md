---
title: "SIEVE: The Cache Eviction Algorithm That Beats LRU by Doing Less"
date: 2026-07-05
tags: [caching, algorithms, systems, performance, data-structures]
excerpt: A 2024 NSDI paper showed that a FIFO queue, one bit per object, and a lazy hand pointer can out-perform LRU, ARC, and friends on web workloads, while removing the lock that makes LRU a scalability bottleneck. Here is how SIEVE works and why its simplicity is the whole point.
---

## The problem with the algorithm everyone uses

Ask an engineer to sketch a cache and they will draw LRU: a doubly-linked list plus a hash map, move an entry to the head on every hit, evict from the tail. It is the default in Redis-style caches, in-process memoization libraries, and half the interview questions ever asked.

LRU has two costs that only show up at scale:

1. **Per-hit metadata writes.** Every hit mutates the list. That is two pointer updates on a hot path that should be read-only, and each update dirties cache lines that other cores want.
2. **A global lock.** Because hits reorder a shared structure, concurrent readers must synchronize. High-throughput caches end up sharding the LRU, batching promotions, or approximating it (Redis famously samples random keys instead of maintaining a true LRU) just to escape the lock.

The academic response for thirty years was to add machinery: ARC keeps four lists and a tuning parameter, LIRS tracks reuse distance with two stacks, TinyLFU bolts a frequency sketch onto an admission filter. Each wins a few points of miss ratio and costs you a page of state-machine code that is miserable to debug.

SIEVE, published at NSDI '24 ("SIEVE is Simpler than LRU"), goes the other direction. It removes machinery and still wins.

## The whole algorithm

SIEVE keeps a FIFO-ordered queue, one `visited` bit per object, and a single **hand** pointer that starts at the tail.

- **On a hit:** set `visited = true`. Nothing else. No list surgery, no lock.
- **On a miss:** insert the new object at the head. If the cache is full, evict first.
- **On eviction:** the hand walks from its current position toward the head. Every object it passes with `visited = true` gets the bit cleared and is *left in place*. The first object with `visited = false` is evicted. The hand stays where it stopped and resumes from there next time, wrapping to the tail after reaching the head.

That is the entire policy. A reference implementation is small enough to read in one sitting:

```python
class Node:
    __slots__ = ("key", "value", "visited", "prev", "next")

class Sieve:
    def __init__(self, capacity: int):
        self.capacity = capacity
        self.table: dict = {}          # key -> Node
        self.head = self.tail = None   # doubly-linked FIFO queue
        self.hand = None               # eviction pointer

    def get(self, key):
        node = self.table.get(key)
        if node is None:
            return None
        node.visited = True            # the only write on a hit
        return node.value

    def put(self, key, value):
        if key in self.table:
            node = self.table[key]
            node.value = value
            node.visited = True
            return
        if len(self.table) >= self.capacity:
            self._evict()
        node = Node()
        node.key, node.value, node.visited = key, value, False
        self._push_head(node)
        self.table[key] = node

    def _evict(self):
        node = self.hand or self.tail
        while node.visited:            # spare survivors, clear their bit
            node.visited = False
            node = node.prev or self.tail
        self.hand = node.prev          # resume here next eviction
        self._unlink(node)
        del self.table[node.key]
```

The authors report that swapping LRU for SIEVE in production libraries (groupcache in Go, lru-rs in Rust, mnemonist in JavaScript) took **12 to 21 changed lines each**. This is not a rhetorical flourish; it is the paper's core claim. An eviction algorithm you can adopt in an afternoon gets adopted. One that needs four lists and a PhD does not.

## Why it works: lazy promotion and quick demotion

Two mechanisms carry all the weight.

**Lazy promotion.** LRU pays for popularity tracking on every hit. SIEVE defers that work to eviction time: the visited bit is a one-bit vote, and the vote is only counted when the hand comes around. Popular objects survive sweep after sweep. Crucially, a survivor is *not moved* — it keeps its queue position, so surviving objects sift toward a stable "old" region near the tail-side of the hand while the head-side churns. That sifting behavior (hence the name) means the hand spends most of its time examining new arrivals, exactly where the one-hit wonders live.

**Quick demotion.** Web cache traces are brutal to newcomers: in the paper's measurements across large CDN and web trace collections, a large fraction of objects are requested exactly once. LRU gives every one of those objects a full trip through the entire queue before eviction, evicting genuinely useful objects to make room. SIEVE inserts new objects at the head, but the hand sweeps that region continuously, so an object that fails to earn its visited bit before the hand arrives is gone quickly. The cache's effective capacity is spent on objects with demonstrated reuse.

If this sounds like CLOCK, it almost is. The difference is subtle but decisive: CLOCK's hand moves through a circular buffer where new pages are inserted *at the hand*, mixing new and surviving objects. SIEVE decouples insertion (always at the head) from eviction (wherever the hand is), which is what creates the sifting separation between proven and unproven objects. On the paper's 1559 traces from five workload collections, that one design change lets SIEVE beat CLOCK, LRU, and even tuned adaptive policies: up to 63% miss-ratio reduction versus optimally-sized LRU on some traces, and better mean miss ratio than ARC, LIRS, and TinyLFU on most web workloads, while beating or matching S3-FIFO (the same group's earlier queue-based design) with less state.

## The concurrency dividend

The miss-ratio numbers get the headlines, but the throughput story matters more for practitioners. Because a SIEVE hit performs a single relaxed write to a bit that no other operation reads concurrently until eviction, **reads need no lock at all**. The queue structure only mutates on miss (insert) and eviction (unlink), both of which already sit on the slow path where a lock is affordable.

The paper measures 16-thread throughput at roughly **2× LRU** on skewed workloads. But the deeper point is architectural: LRU's lock forces you to choose between correctness and speed, which is why real systems ship approximated LRU. SIEVE gives you the real policy at approximately the cost of the approximation. TiDB, DragonflyDB, Pelikan, and dnscrypt-proxy adopted it within a year of publication, which for a cache paper is warp speed.

## Where SIEVE loses

The paper is candid about this, and you should be too before deploying it: **SIEVE is not scan-resistant.** A one-pass scan over a large dataset — a backup job, an analytics query, a table scan — inserts a flood of objects at the head, none of which will be revisited. Each gets one chance via the visited bit, fails it, and is evicted; but while the flood is in the queue it displaces the working set. Block storage and database buffer-pool workloads are full of scans, and on those traces SIEVE loses to ARC and LIRS, sometimes badly.

The decision rule is workload-shaped:

- **Zipfian, request-driven, object-cache workloads** (CDN edges, API response caches, key-value lookaside caches, DNS): SIEVE is close to a free win — better miss ratio, better throughput, less code.
- **Scan-heavy block workloads** (database buffer pools, filesystem page caches): keep ARC/LIRS/2Q, or use SIEVE as a building block behind an admission filter that absorbs scans.

That last option is the paper's second thesis: SIEVE as a *primitive*. Because it is cheap and stateless-per-hit, you can compose it — a small SIEVE probation queue in front of a main cache gives you TinyLFU-style admission with far less machinery.

## The meta-lesson

There is a genuinely uncomfortable question buried in this paper: LRU-and-friends were designed in an era of page caches and spinning disks, then inherited by web caching without re-examination. It took until 2024 for someone to demonstrate that for the workloads most caches actually serve, the right algorithm is *simpler* than the default, not more complex. The queue was FIFO all along; we just needed one bit and the discipline to do nothing on the hot path.

When you next reach for `LinkedHashMap(accessOrder=true)` or an `lru_cache` decorator on a hot service path, it is worth asking which side of the scan-resistance line your workload sits on. There is a decent chance the answer is 20 lines away from being both faster and better.
