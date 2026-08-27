---
title: "EEVDF: Linux Turned Latency Into a Scheduling Parameter"
date: 2026-08-28
tags: [linux-kernel, scheduling, latency, performance, systems]
excerpt: "CFS could tell you how much CPU a task got, never how soon. EEVDF splits those into two orthogonal knobs — weight sets the share, request size sets the deadline. I simulated it: dropping one task's request from 700us to 100us cut its worst-case wait 4x while its share moved 0.20 percentage points."
---

The Completely Fair Scheduler had exactly one dial. `nice` set a weight, the weight set a share of CPU, and the share was all you could ask for. If a media thread needed to run *soon* rather than *often*, your options were to renice it — buying throughput you didn't want in order to get latency you did — or to escalate to `SCHED_FIFO` and hope it never spun.

EEVDF, merged in Linux 6.6 and finished off across 6.10–6.12, separates the two. Weight still sets the share. A second per-task quantity, the **request size**, sets how finely that share is delivered. The claim is that these are orthogonal: shrinking a task's request improves its latency and does not change its bandwidth. That claim is strong enough to be worth checking, so I built a single-CPU simulator mirroring the virtual-time bookkeeping in `kernel/sched/fair.c` and measured it.

## Lag, eligibility, deadline

Let `V` be virtual time — the weighted average of every runnable task's `vruntime`. Task *i* deserves service `S = V·w_i` and has received `s_i`, so its **lag** is

```
lag_i = S - s_i = w_i * (V - v_i)
```

Positive lag means the task is owed CPU. The kernel stores the unweighted form, `vlag = V - v_i`, and keeps it clamped to ±`max(2·slice, TICK_NSEC)` in virtual units.

EEVDF then applies two rules. First, only **eligible** tasks — those with `lag ≥ 0`, equivalently `v_i ≤ V` — may be picked. Second, among eligible tasks, run the one with the earliest **virtual deadline**:

```
vd_i = ve_i + r_i / w_i
```

where `r_i` is the request size. The deadline is not refreshed every tick; it advances only when the previous request has been fully consumed. That single detail is what makes request size a latency knob rather than a fairness bug: a task with a small `r_i` gets a near deadline, wins the pick, runs briefly, and immediately gets another near deadline. It cycles more often for the same total service.

The eligibility test looks like it needs a division to compute `V`, and the kernel refuses to pay it:

```c
/*
 * lag_i >= 0 -> V >= v_i
 *
 *     \Sum (v_i - v)*w_i
 * V = ------------------ + v
 *          \Sum w_i
 *
 * lag_i >= 0 -> \Sum (v_i - v)*w_i >= (v_i - v)*(\Sum w_i)
 */
static int vruntime_eligible(struct cfs_rq *cfs_rq, u64 vruntime)
{
	struct sched_entity *curr = cfs_rq->curr;
	s64 avg = cfs_rq->avg_vruntime;
	long load = cfs_rq->avg_load;

	if (curr && curr->on_rq) {
		unsigned long weight = scale_load_down(curr->load.weight);

		avg += entity_key(cfs_rq, curr) * weight;
		load += weight;
	}

	return avg >= (s64)(vruntime - cfs_rq->min_vruntime) * load;
}
```

`cfs_rq->avg_vruntime` is the running sum `Σ w_j·(v_j − min_vruntime)`, maintained incrementally on every enqueue and dequeue. Cross-multiplying turns `V ≥ v_i` into one comparison of two products, and the comment is explicit that using the divided form would be *inaccurate*, not merely slower — truncating `V` can flip the verdict for a task sitting within a rounding error of the zero-lag point.

Selection is `O(log n)`. The run queue is an rbtree sorted by deadline, augmented so each node caches `min_vruntime` over its subtree. `pick_eevdf()` descends left whenever the left subtree contains any eligible entity, which prunes whole ineligible subtrees while preserving deadline order.

## Measuring the orthogonality claim

Five CPU-bound tasks, all nice 0, on one CPU, 200 ms of simulated time. Everything is identical except task 0's request size:

| task 0's `r` | task 0 share | task 0 max wait | task 0 turns | others' share |
|---|---|---|---|---|
| 700 µs | 20.20 % | 2800 µs | 58 | 19.95 % |
| 300 µs | 20.10 % | 1400 µs | 134 | 19.95–20.05 % |
| 100 µs | 20.00 % | 700 µs | 400 | 19.95–20.15 % |

A 7× smaller request buys a 4× lower worst-case wait, and the bandwidth moves by 0.20 percentage points — noise from where the 200 ms window cuts. The cost is the thing nobody advertises: **7× the context switches**, 58 turns to 400. Latency here is bought with TLB and L1 pollution, not with someone else's CPU time.

The orthogonality survives mixing in weights. With nice values −5, 0, 0, +5 (weights 3121, 1024, 1024, 335) and one task's request cut to 100 µs, measured shares were 56.70 / 18.62 / 18.60 / 6.08 % against ideals of 56.70 / 18.60 / 18.60 / 6.09 %. Request size does not leak into share.

I also checked the bound `fair.c` states for itself — `-r_max < lag < max(r_max, q)`:

| request sizes (µs) | `r_max` | max lag | min lag |
|---|---|---|---|
| 700 ×5 | 700 | +560 µs | −560 µs |
| 100, 700, 700, 4000, 4000 | 4000 | +2360 µs | −3140 µs |
| 100 ×4, 12000 | 12000 | +2440 µs | −9520 µs |

Lag stays strictly inside ±`r_max` in every configuration, and the interesting asymmetry is that the *large* request is what widens the envelope for everyone. One batch task asking for a 12 ms request degrades the fairness envelope of the four 100 µs tasks sharing its CPU — which is the real argument against `sysctl_sched_base_slice` tuning as a global fix.

## Why preserving lag needed DELAY_DEQUEUE

Lag has to survive sleep, or the scheduler is trivially gamed: overrun your slice, sleep 100 µs, wake with the debt forgiven. So `PLACE_LAG` stores `vlag` at dequeue and restores it at wake-up, inflating it by `(W + w_i)/W` first because adding the entity back drags the weighted average toward it.

Preserving negative lag exactly turns out to punish honest periodic tasks. Same simulator, three CPU hogs plus one task doing 500 µs of work every 2 ms:

| wake-up policy | sleeper's share | wake→run p99 |
|---|---|---|
| reset lag to 0 at wake | 19.25 % | 600 µs |
| `PLACE_LAG`, lag preserved | 15.50 % | 2700 µs |
| `PLACE_LAG` + `DELAY_DEQUEUE` | 19.25 % | 600 µs |

Honest bookkeeping alone costs the periodic task 19 % of its throughput and 4.5× its tail wake-up latency, because it goes to sleep mid-request holding negative lag and that debt is still sitting there whenever it wakes.

`DELAY_DEQUEUE` (Linux 6.12, on by default) resolves it without forgiving anything. A task that blocks while ineligible is **not** removed from the run queue; it is flagged `sched_delayed` and left there, still counted in the load, until it becomes eligible. Its negative lag burns off against wall-clock competition instead of being erased by fiat, and `DELAY_ZERO` clips the residue to zero at the real dequeue. The features file states the invariant plainly: "when they get selected they'll have positive lag by definition."

There's a second-order win. If the task wakes before its delayed dequeue completes — the common case for a task sleeping less than a slice — it is already enqueued, so the wake-up path skips placement entirely. No `V` recomputation, no lag inflation, no rbtree churn.

## Using it

```c
/* __setparam_fair(): attr.sched_runtime is a request-size hint */
if (attr->sched_runtime) {
	se->custom_slice = 1;
	se->slice = clamp_t(u64, attr->sched_runtime,
			      NSEC_PER_MSEC/10,   /* 100 us  */
			      NSEC_PER_MSEC*100); /* 100 ms  */
}
```

`sched_setattr()` with a nonzero `sched_runtime` under `SCHED_OTHER` sets the request size, clamped to [100 µs, 100 ms]. The default is `sysctl_sched_base_slice`, 750 µs in 6.12 and 700 µs by 7.2.

Two footguns. Group scheduling propagates the *minimum* request upward — a cgroup entity inherits `cfs_rq_min_slice()` of its children, so one 100 µs thread makes its whole cgroup preemptible at 100 µs granularity, deliberately, so the group can service that thread in time. And a sub-tick request is only real if the high-resolution tick is armed: `hrtick_start_fair()` converts the remaining virtual deadline back to physical time, `delta = w · (deadline − vruntime) / NICE_0_LOAD`, then inflates it to compensate for IRQ time. As of 7.2 `HRTICK` finally defaults to true, but only under `CONFIG_HRTIMER_REARM_DEFERRED`. Without it, your 200 µs request is a suggestion rounded up to `1/HZ`.

The pattern generalizes past the scheduler. Fair queueing has always conflated "how much" with "how soon" because both were derived from one weight; EEVDF's move is to keep the fairness invariant on weights and hang latency off a separate request size that provably cannot perturb it. Any admission-controlled queue — disk, network, an inference server's batch scheduler — has the same two questions and usually the same one dial.
