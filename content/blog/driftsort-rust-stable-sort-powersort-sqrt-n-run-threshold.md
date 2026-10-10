---
title: "Driftsort: Rust's Stable Sort Ignores Runs Shorter Than √n, and Gets 45% Slower Just Above It"
date: 2026-10-10
tags: ["sorting", "rust", "algorithms", "performance", "mergesort"]
excerpt: "Since Rust 1.81, slice::sort is driftsort: powersort's merge policy, glidesort's lazy runs, and a branchless stable quicksort, with a √n entry threshold for pre-sorted runs. I ported its top-level loop to Python and measured the real std sort on an M3 Pro. Comparison counts match the port exactly (10.00, 9.00, 7.00 per element). But at n = 2^18, input made of sorted runs of 512 elements takes 31.0 ns/element, while runs of 511 take 21.3. Detecting the runs halves the comparisons and adds 45% to the time. I also found a counterexample to the source comment claiming its integer merge-depth trick reproduces the exact powersort tree for n < 2^30."
---

# Driftsort: Rust's Stable Sort Ignores Runs Shorter Than √n, and Gets 45% Slower Just Above It

Rust 1.81 (September 2024) replaced both standard-library sorts. `sort_unstable` became **ipnsort**, and `sort` (stable) became **driftsort**, by Orson Peters and Lukas Bergdoll. Driftsort is a hybrid built from three pieces:

- **Powersort's merge policy** (Munro & Wild, ESA 2018; also used by CPython since 3.11) decides which adjacent runs to merge.
- **Glidesort's lazy logical runs** let unsorted stretches sit in the merge stack without being sorted until they have to be.
- A **branchless stable quicksort** sorts those unsorted stretches. It partitions into a scratch buffer, writing elements less than the pivot forwards and the rest backwards.

It adapts to existing runs like Timsort and runs as fast as quicksort on random data. It also has a sharp edge.

## The top-level loop

Below is the core of `library/core/src/slice/sort/stable/drift.rs`, trimmed:

```rust
let min_good_run_len = if len <= 64 * 64 {
    cmp::min(len - len / 2, 64)
} else {
    sqrt_approx(len)            // entry barrier for pre-sorted runs
};
loop {
    next_run = create_run(&mut v[scan_idx..], scratch, min_good_run_len, eager_sort, is_less);
    desired_depth = merge_tree_depth(scan_idx - prev_run.len(), scan_idx,
                                     scan_idx + next_run.len(), scale_factor);
    while stack_len > 1 && desired_depths[stack_len - 1] >= desired_depth {
        prev_run = logical_merge(/* runs[stack_len-1], prev_run */);
        stack_len -= 1;
    }
    // push prev_run with desired_depth, advance
}
```

`create_run` looks for an ascending (or strictly descending) run at the scan position. Runs of at least `min_good_run_len` become **sorted** runs. Anything shorter is ignored, and the next `min_good_run_len` elements become an **unsorted** logical run. `logical_merge` concatenates two unsorted runs for free, as long as the result still fits in scratch. Only when an unsorted run meets a sorted one does it get quicksorted and physically merged. Random input never merges: it becomes one unsorted run, quicksorted once.

The source comment explains the √n threshold: "the presence of a single such run will force on average several merge operations and shrink the maximum quicksort size a lot." Keep that sentence in mind.

## Powersort depth as one XOR and one CLZ

Powersort treats the array as the interval [0, 1). For adjacent runs [a, b) and [b, c), it takes their midpoints and finds the dyadic fraction j/2^k with the smallest k between them. That k is the node's "desired depth" in the merge tree, and nodes are merged in stack order whenever the depth on top of the stack is at least as large as the incoming one. The merge cost is within O(n) of the n·H(run lengths) lower bound.

Driftsort computes k without division:

```rust
fn merge_tree_scale_factor(n: usize) -> u64 { (1u64 << 62).div_ceil(n as u64) }

fn merge_tree_depth(left: usize, mid: usize, right: usize, scale_factor: u64) -> u8 {
    let x = left as u64 + mid as u64;   // 2 × midpoint of the left run
    let y = mid as u64 + right as u64;  // 2 × midpoint of the right run
    ((scale_factor * x) ^ (scale_factor * y)).leading_zeros() as u8
}
```

Scaling [0, 1) to [0, 2^63) turns "first dyadic level where the midpoints differ" into "highest bit where the scaled midpoints differ". The comment says the rounding in `div_ceil` is harmless: "when n < 2^30 the resulting tree is equivalent as the approximation errors stay entirely in the lower order bits."

### Auditing the n < 2^30 claim

The ceiling makes `f·x` overshoot the exact value `x·2^62/n` by up to `x < 2n` units. Midpoints are multiples of 1/(2n), so a midpoint can sit as close as 2^62/(n·2^k) units *below* a depth-k dyadic point. Overshooting it moves the midpoint across that point, which changes bit k. Real runs are at least √n long, so relevant depths are about log2(√n). The overshoot can win once 2n > 2^62/n^1.5, i.e. n > 2^24.4.

Random partitions showed zero mismatches against exact arithmetic up to 2^31. An adversarial search for boundaries placed just below a dyadic point, comparing:

```python
def exact(a, b, c, n):          # smallest k with a depth-k dyadic in (m1, m2]
    k = 0
    while True:
        k += 1
        if ((a + b) << k) // (2 * n) != ((b + c) << k) // (2 * n): return k

def approx(a, b, c, n):
    f = -(-(1 << 62) // n)
    return 64 - ((f * (a + b)) ^ (f * (b + c))).bit_length()
```

The first hit I found is at n = 37,379,699 (about 2^25.2), using 5,861 runs, all at least `sqrt_approx(n)` = 6,377 long. At the boundary b = 34,416,969, the left midpoint is 0.920654296868, which is 6.5×10⁻¹² below 3771/4096. The scaled value rounds up to exactly 3771/4096, so `exact` says depth 12 and `approx` says 13. The merge order changes (similar constructions exist at 2^26 through 2^31).

Total merge cost moved by −0.00006% to +0.0002%. The comment is technically wrong and practically harmless: correctness never depends on the tree.

## The √n cliff

To check my port, I generated n = 2^18 random u64 values and sorted every chunk of L elements, so the input is n/L ascending runs. Here `sqrt_approx(2^18)` = 512. The Python port uses Rust's pivot selection, ancestor-pivot equal partitioning and merge loop, plus a stand-in small-sort. The Rust columns use std on rustc 1.94 with a counting closure:

| run length L | port cmp/n | Rust `sort` cmp/n | CPython `list.sort` cmp/n | `sort_unstable` cmp/n |
|---|---|---|---|---|
| 128 | 19.84 | 19.29 | 11.99 | 18.77 |
| 511 | 19.98 | 19.40 | 10.00 | 18.65 |
| **512** | **10.00** | **10.00** | 10.00 | 18.67 |
| 1024 | 9.00 | 9.00 | 9.00 | 18.85 |
| 4096 | 7.00 | 7.00 | 7.00 | 18.69 |
| random | 19.47 | 18.90 | 16.74 | 18.62 |

Above the threshold, the port and std agree exactly: n − 1 comparisons to detect the runs, plus one per element per merge level (log2(n/L)). Below it, the runs are invisible, and 511-element runs cost the same as random data. CPython's powersort uses a minrun of 32–64 and exploits them, at about 2× fewer comparisons.

Now wall-clock time for std `sort` (best of many runs, Apple M3 Pro, `-C target-cpu=native`, ns per element; T = threshold):

| n | L = T−1 | **L = T** | 2T | 4T | 8T | 16T | random |
|---|---|---|---|---|---|---|---|
| 2^16 (T=256) | 19.6 | **27.5** | 24.1 | 20.7 | 17.4 | 14.0 | 19.2 |
| 2^18 (T=512) | 21.3 | **31.0** | 27.6 | 24.2 | 20.8 | 17.4 | 20.9 |
| 2^20 (T=1024) | 26.0 | **34.7** | 31.3 | 27.8 | 24.4 | 21.0 | 25.6 |
| 2^22 (T=2048) | 28.9 | **38.6** | 34.8 | 31.4 | 28.1 | 24.7 | 27.6 |

At every size, adding one element per run, which moves L from T−1 to T, makes the sort 33–46% *slower*, even though it halves the comparisons. Each doubling of L removes one merge level and saves about 3.4 ns/element. The quicksort handles random data in about 1.2–1.3 ns per element per partition level (total time divided by log2 n). One merge level costs nearly as much as three quicksort levels. Run-detected input only breaks even with random input between 4T and 8T, i.e. runs of 4–8×√n.

My hypothesis (not verified with counters): the branchless merge is a serial dependency chain.

```rust
let consume_left = !is_less(&*right, &**left);
let src = if consume_left { *left } else { right };
ptr::copy_nonoverlapping(src, *out, 1);
*left = left.add(consume_left as usize);
right = right.add(!consume_left as usize);
```

Each comparison decides which pointer advances, and so which address the next iteration loads. The partition loop has no such chain: each element's comparison against the pivot is independent, so the out-of-order core can overlap many of them.

The √n barrier is the authors' defence against this cost. Without it, the cliff would sit at small L, where most "partially sorted" data lives. With it, the cliff moves to a band between √n and roughly 8√n.

## What to do with this

- **Chunk-sorted data in the √n–8√n band is the slow case.** Examples are concatenated sorted batches, per-shard sorted results, and time-bucketed logs. If you don't need stability, `sort_unstable` was flat at 19.4–19.9 ns/element over the whole n = 2^18 sweep. It beat `sort`'s 31.0 at L = 512 by 37%.
- **Fully sorted and reversed inputs are still optimal:** exactly n − 1 comparisons, which I confirmed in the port.
- **Since 1.81, both sorts may panic if `Ord` is not a total order.** The release notes were explicit about this. A comparator built from `partial_cmp(...).unwrap_or(Equal)` on floats with NaN used to give a garbage order, and can now panic instead. Use `f64::total_cmp`.

Driftsort is an excellent default: within 10% of `sort_unstable` on random data, while stable and adaptive. But "adaptive" is a promise about comparisons, not time. On this hardware a merge level is the expensive operation.
