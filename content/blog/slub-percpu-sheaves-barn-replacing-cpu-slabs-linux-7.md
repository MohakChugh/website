---
title: "SLUB Sheaves: How Linux 7.0 Replaced Per-CPU Slabs with Arrays of Pointers"
date: 2026-10-03
tags: ["linux-kernel", "memory-allocators", "slab", "concurrency", "numa"]
excerpt: "Linux 6.18 added per-CPU 'sheaves' to the SLUB allocator as an opt-in layer. In 7.0 they became the default for every cache, and the per-CPU (partial) slab, with its cmpxchg128 lockless fast path, was deleted. I read the 7.3-rc5 source to cover the main/spare/rcu_free sheaves, the per-node barn with its 10-full/10-empty limits, the capacity formula sized to kmalloc buckets, and the prefill API built for the maple tree. A small simulation shows where the design pays and where a burst spills over."
---

# SLUB Sheaves: How Linux 7.0 Replaced Per-CPU Slabs with Arrays of Pointers

For about fifteen years, each CPU in SLUB owned one *slab*, a page of objects threaded on an embedded freelist. An allocation popped the head of that freelist with a `this_cpu_cmpxchg` on a `(freelist, tid)` pair, with no lock and no IRQ disable. It was clever, but **a free was fast only if the object belonged to this CPU's current slab**. Producer/consumer patterns, where one CPU allocates and another frees (network buffers, VMAs), missed that fast path almost every time. The cmpxchg128 machinery also made PREEMPT_RT, `kmalloc_nolock()` for BPF, and debugging harder to support.

Vlastimil Babka's *sheaves* series fixes this by putting back what SLAB had and SLUB dropped: **a per-CPU array of object pointers**. Sheaves arrived opt-in in Linux 6.18. The 7.0 merge `815c8e35511d` ("slab: replace cpu (partial) slabs with sheaves") made them universal and deleted `struct kmem_cache_cpu`. In the 7.3-rc5 tree I read for this post, `grep -c kmem_cache_cpu mm/slub.c` returns 0.

## The data structures

These are taken directly from `mm/slub.c`:

```c
#define MAX_FULL_SHEAVES	10
#define MAX_EMPTY_SHEAVES	10

struct node_barn {
	spinlock_t lock;
	struct list_head sheaves_full;
	struct list_head sheaves_empty;
	unsigned int nr_full;
	unsigned int nr_empty;
};

struct slab_sheaf {
	union {
		struct rcu_head rcu_head;
		struct list_head barn_list;
		struct llist_node llnode;
		struct { unsigned int capacity; bool pfmemalloc; };
	};
	struct kmem_cache *cache;
	unsigned int size;
	int node; /* only used for rcu_sheaf */
	void *objects[];
};

struct slub_percpu_sheaves {
	local_trylock_t lock;
	struct slab_sheaf *main;     /* never NULL when unlocked */
	struct slab_sheaf *spare;    /* empty or full, may be NULL */
	struct slab_sheaf *rcu_free; /* for batching kfree_rcu() */
};
```

There are three levels. First come the **per-CPU sheaves**: `main` serves every operation, and `spare` gets swapped in when `main` runs empty (on allocation) or full (on free). `rcu_free` batches `kfree_rcu()` objects and goes to `call_rcu()` as a unit, so there is one callback per sheaf instead of one per object. Second is the **barn**, one per NUMA node: a spinlocked exchange of whole sheaves, holding at most 10 full and 10 empty. Last are the **slab pages**, which are touched only by bulk refill and bulk flush.

## The fast path is just an array index

The free path is shown here with stats and hooks removed:

```c
bool free_to_pcs(struct kmem_cache *s, void *object, bool allow_spin)
{
	struct slub_percpu_sheaves *pcs;

	if (!local_trylock(&s->cpu_sheaves->lock))
		return false;
	pcs = this_cpu_ptr(s->cpu_sheaves);

	if (unlikely(pcs->main->size == s->sheaf_capacity)) {
		pcs = __pcs_replace_full_main(s, pcs, allow_spin);
		if (unlikely(!pcs))
			return false;
	}
	pcs->main->objects[pcs->main->size++] = object;
	local_unlock(&s->cpu_sheaves->lock);
	return true;
}
```

`alloc_from_pcs()` is the mirror image: it reads `objects[size - 1]` and decrements `size`. A `local_trylock_t` is a per-CPU lock (on non-RT kernels, a preempt-disable plus an `acquired` byte), so no cache line ever moves to another CPU. The key change is that **any object from the local NUMA node can take the fast path**, whichever slab it came from. The only check is `can_free_to_pcs()`, which compares `slab_nid(slab)` against the CPU's node and rejects pfmemalloc pages. Objects reach their slab's freelist only when a sheaf is flushed. That flush still uses the lockless `try_cmpxchg128` update of the slab's `(freelist, counters)`, which the merge message calls "crucial for freeing remote NUMA objects and to allow flushing objects from sheaves to slabs mostly without the node list_lock."

## Slow paths: swap, exchange, refill

When `main` is empty on allocation, `__pcs_replace_empty_main()` tries three things in order. First, if `spare` has objects, it swaps them with no lock. Second, `barn_replace_empty_sheaf()` trades the empty sheaf for a full one under the barn spinlock. Third, it drops the local lock, bulk-refills from slab pages, retakes the lock, and fixes up any changes caused by migrating to another CPU. Frees work the same way in reverse. One detail matters: if both per-CPU sheaves are full and the barn already holds `MAX_FULL_SHEAVES`, `barn_replace_full_sheaf()` returns `-E2BIG`. The CPU then flushes its *spare* to slab pages and reuses it as the new empty sheaf. This keeps sheaf-held memory bounded per node.

## Capacity: halve the old partial budget, then round up to fill the bucket

`calculate_sheaf_capacity()` explains its own reasoning in a comment:

```c
	/*
	 * For now we use roughly similar formula (divided by two as there are
	 * two percpu sheaves) as what was used for percpu partial slabs...
	 */
	if (s->size >= PAGE_SIZE)      capacity = 4;
	else if (s->size >= 1024)      capacity = 12;
	else if (s->size >= 256)       capacity = 26;
	else                           capacity = 60;

	size = kmalloc_size_roundup(struct_size_t(struct slab_sheaf, objects, capacity));
	capacity = (size - struct_size_t(struct slab_sheaf, objects, 0)) / sizeof(void *);
	return max(capacity, args->sheaf_capacity);
```

v6.17's `set_cpu_partial()` used 6/24/52/120 objects. The three smaller classes are exactly halved, and the page-size class rounds 3 up to 4. Sheaves are kmalloc'd, and the 64-bit header is 32 bytes (a 16-byte union plus `cache`, `size`, and `node`), so the round-up works out to:

| Object size | Base | Bytes (32 + 8n) | kmalloc bucket | Final capacity |
|---|---|---|---|---|
| < 256 B | 60 | 512 | 512 | **60** |
| 256 B – 1 KiB | 26 | 240 | 256 | **28** |
| 1 KiB – 4 KiB | 12 | 128 | 128 | **12** |
| ≥ 4 KiB | 4 | 64 | 64 | **4** |

Only the 256-byte class gains anything from rounding (two slots); the other three already fill their buckets exactly. Sheaves are disabled by `SLAB_DEBUG_FLAGS`, `CONFIG_SLUB_TINY`, `SLAB_NO_SHEAVES` (the two bootstrap caches), and `SLAB_NOLEAKTRACE`, which keeps kmemleak from recursing. kmalloc caches get their sheaves late, via `bootstrap_kmalloc_sheaves()`.

## Prefilled sheaves: a short-lived mempool

The first opt-in user was the maple tree, which cannot fail an allocation halfway through a tree rewrite. It now uses:

```c
struct slab_sheaf *kmem_cache_prefill_sheaf(struct kmem_cache *s, gfp_t gfp, unsigned int size);
int  kmem_cache_refill_sheaf(struct kmem_cache *s, gfp_t gfp, struct slab_sheaf **sheafp, unsigned int size);
void *kmem_cache_alloc_from_sheaf(struct kmem_cache *s, gfp_t gfp, struct slab_sheaf *sheaf);
void kmem_cache_return_sheaf(struct kmem_cache *s, gfp_t gfp, struct slab_sheaf *sheaf);
unsigned int kmem_cache_sheaf_size(struct slab_sheaf *sheaf);
```

`lib/maple_tree.c` prefills while it can still sleep, then calls `kmem_cache_alloc_from_sheaf(..., GFP_NOWAIT, mas->sheaf)` under the tree lock, which cannot fail. Prefilling is usually cheap because a full sheaf is often already in the barn. A request larger than `sheaf_capacity` gets a one-off "oversize" sheaf that is flushed on return, which is why an explicit higher `args->sheaf_capacity` overrides the default.

## A simulation: where the barn earns its lock

I modeled a capacity-60 cache (main, spare, and a 10/10 barn, using the replacement rules above) and counted how many of 2M operations leave the lock-free path. "Barn" means a spinlocked exchange; "slab" means a bulk refill or flush.

| Workload | Fast path | Barn | Slab |
|---|---|---|---|
| Random alloc/free walk, 1 CPU | 99.97% | 0.02% | 0.00% |
| Burst of 100 allocs then 100 frees | 100.00% | 0.00% | 0.00% |
| Burst of 200 | 99.00% | 1.00% | 0.00% |
| Burst of 1000 | 98.25% | 1.25% | **0.50%** |
| Alloc on CPU 0, free on CPU 1 | 98.33% | **1.67%** | 0.00% |

**Producer/consumer becomes cheap.** The cross-CPU pattern now takes the barn lock exactly once per 60 operations on each side (1/60 = 1.67%). The consumer hands over full sheaves and the producer takes them, so nothing returns to slab pages. In the old design, each of those frees was a remote-slab cmpxchg.

**There is a fixed spill horizon.** One CPU's two sheaves plus the barn's full list hold 2×60 + 10×60 = 720 free objects. A 1000-object burst goes past that and triggers `-E2BIG` flushes, which get refilled on the next burst. The 10-sheaf limit is a compile-time constant shared by every CPU on the node, so it does not grow with the core count. On a wide node with bursty frees, expect `barn_put_fail` and `barn_get_fail` (exposed via `CONFIG_SLUB_STATS`) to show it.

## What it costs

- **NUMA placement gets weaker.** `kmem_cache_alloc_node()` with an explicit node, and frees of remote-node objects, both bypass the sheaves. Most callers pass `NUMA_NO_NODE` and are unaffected.
- **Free memory is hidden from slabs.** Objects sitting in sheaves don't count as free on their slabs, so shrinking and cache destruction have to flush first. Most of the 2026 follow-up commits deal with flush ordering, memoryless nodes, and pfmemalloc objects leaking into the barn.
- **It looks like SLAB again.** At LSFMM+BPF 2025, Babka worried aloud (in LWN's paraphrase) that universal sheaves might make SLUB resemble the allocator it replaced. The difference is that sheaves keep SLUB's lockless slab freelist for remote frees and add only a small, bounded exchange layer on top.

The general lesson: a lock-free fast path that covers only some operations can lose to a simple per-CPU array that covers almost all of them. In every pattern I simulated, a 60-entry pointer array with a spinlocked overflow exchange handled 98–100% of operations.
