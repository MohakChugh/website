---
title: "Proxy Execution: How Linux Lets a Blocked Task Lend Its CPU Time to the Lock Owner"
date: 2026-10-04
tags: ["linux-kernel", "scheduling", "priority-inversion", "locking", "concurrency"]
excerpt: "Kernel mutexes have no priority inheritance, so a high-priority waiter can stall behind a nice-19 lock holder for hundreds of milliseconds. Proxy execution fixes this by splitting the scheduler's idea of 'current' into a donor (whose priority and budget get used) and an execution context (whose code actually runs). I went through the v6.17, v7.1 and v7.2 sources to follow it from same-CPU proxying to cross-CPU donor migration to donor-directed mutex handoff, and wrote a small simulator. With four nice-0 hogs, the waiter's latency drops from ~469 ms to ~6 ms."
---

# Proxy Execution: How Linux Lets a Blocked Task Lend Its CPU Time to the Lock Owner

Here is the classic case. A low-priority task L takes a kernel `struct mutex`. A high-priority task H tries to take the same mutex and blocks. Meanwhile some medium-priority tasks keep the CPU busy, so L hardly ever gets scheduled, and H waits on all of them. This is priority inversion. Linux has handled it for `rt_mutex` (which backs PI futexes) for a long time. The ordinary `struct mutex`, used far more widely, has never had any priority inheritance.

**Proxy execution**, landing upstream in stages since 6.17, doesn't copy a priority number between tasks. It splits the scheduler's "current task" into two roles. Everything below is from the v6.17, v7.1 and v7.2 source.

## Why classic priority inheritance falls short

`rt_mutex` priority inheritance raises the owner's `p->prio` to the waiter's. That's enough for SCHED_FIFO/RR, where priority is the whole policy. The fair class doesn't use `p->prio` to decide shares. It uses a weight, and that weight comes from `static_prio`:

```c
void set_load_weight(struct task_struct *p, bool update_load)
{
	int prio = p->static_prio - MAX_RT_PRIO;   /* not p->prio */
	...
	lw.weight = scale_load(sched_prio_to_weight[prio]);
```

So a nice -10 fair task (weight 9548) can't hand its share to a nice 19 owner (weight 15) through PI, and SCHED_DEADLINE's "priority" is really a runtime/period budget. The real fix is to run the owner *using the waiter's entire scheduling context*: class, weight, deadline and bandwidth.

## The core idea: donor vs. execution context

Proxy execution adds a second pointer to the runqueue. `rq->curr` is still the task whose code is on the CPU. The new `rq->donor` is the task whose scheduling parameters the class code charges and preempts against. Usually they are the same task. When they differ, the donor is blocked on a mutex and is lending its turn to the owner.

The first change is that mutex-blocked tasks **stay on the runqueue**. In `__schedule()`:

```c
} else if (!preempt && prev_state) {
	/* keep mutex-blocked tasks on the rq for proxy-exec */
	try_to_block_task(rq, prev, &prev_state, !task_is_blocked(prev));
```

Since `should_block` is false for a task with `blocked_on` set, it isn't dequeued. The scheduling class can still pick it like any other runnable task. When it gets picked, the scheduler follows the chain:

```c
pick_again:
	next = pick_next_task(rq, &rf);
	rq_set_donor(rq, next);
	if (unlikely(next->is_blocked)) {
		next = find_proxy_task(rq, next, &rf);  /* walk to a runnable owner */
		if (!next)
			goto pick_again;
		...
	}
	RCU_INIT_POINTER(rq->curr, next);
```

`find_proxy_task()` follows `task->blocked_on -> mutex->owner -> task->blocked_on -> ...`, taking each `mutex->wait_lock` along the way so the owner can't go away underneath it. It stops at the first owner that is runnable. Chains like H → L₁ → L₂ are handled transitively, at pick time rather than propagated when a task blocks as `rt_mutex` PI does.

## Who pays for the CPU time

The accounting is the subtle part. In `fair.c` (v7.2), `update_curr()` operates on `&rq->donor->se`, and `update_se()` splits the charge:

```c
	struct task_struct *donor = task_of(se);
	struct task_struct *running = rq->curr;
	/* account the time against the running task */
	running->se.sum_exec_runtime += delta_exec;
	account_group_exec_runtime(running, delta_exec);
	/* cgroup time is always accounted against the donor */
	cgroup_account_cputime(donor, delta_exec);
```

Wall-clock CPU time (`sum_exec_runtime`, what `top` and `getrusage` report) goes to the owner, because the owner really did execute. Vruntime and cgroup time go to the donor, so the boost comes entirely out of H's own entitlement and the medium tasks lose nothing they wouldn't have lost to H running directly. The weights make this matter: a 2 ms critical section costs 136,533 µs of vruntime if L is charged at weight 15, but only 214 µs if H is charged at weight 9548. That's a 636× difference.

## v6.17: same-CPU only

The first merged version was deliberately limited. In v6.17, `find_proxy_task()` gives up whenever the chain leaves the local runqueue:

```c
		if (!READ_ONCE(owner->on_rq) || owner->se.sched_delayed) {
			/* XXX Don't handle blocked owners/delayed dequeue yet */
			return proxy_deactivate(rq, donor);
		}
		if (task_cpu(owner) != this_cpu) {
			/* XXX Don't handle migrations yet */
			return proxy_deactivate(rq, donor);
		}
```

`proxy_deactivate()` falls back to ordinary blocking, first switching `rq->donor` to the idle task, because once `on_rq` is cleared `ttwu()` on another CPU can wake the donor immediately. The Kconfig is restrictive too: `depends on !PREEMPT_RT`, `!SCHED_CLASS_EXT` ("need to investigate how to inform sched_ext of split contexts"), and `EXPERT`, with the comment "Not particularly useful until we get to multi-rq proxying". Once built in, it defaults on; `sched_proxy_exec=0` disables it.

## v7.1: proxy migration

The `XXX Don't handle migrations yet` branch is gone in v7.1. When the owner is on another CPU, the donor is moved there:

```c
/*
 * This is because we must respect the CPU affinity of execution
 * contexts (owner) but we can ignore affinity for scheduling
 * contexts (@p). So we have to move scheduling contexts towards
 * potential execution contexts.
 */
static void proxy_migrate_task(struct rq *rq, struct rq_flags *rf,
			       struct task_struct *p, int target_cpu)
{
	proxy_resched_idle(rq);
	deactivate_task(rq, p, DEQUEUE_NOCLOCK);
	proxy_set_task_cpu(p, target_cpu);   /* preserves p->wake_cpu */
	...
	attach_one_task(target_rq, p);
```

A blocked donor never executes, so it can sit on a runqueue outside its `cpus_ptr` as long as it only gets picked and redirected. `proxy_set_task_cpu()` saves the original `wake_cpu`; on release, `proxy_needs_return()` in the wakeup path notices that `task_cpu(p) != p->wake_cpu` and dequeues the task with `TASK_WAKING`, so `try_to_wake_up()` puts it back on a CPU it is actually allowed to use.

## v7.2: the donor gets the lock

Boosting fixes half the problem. On unlock, a plain mutex wakes the FIFO-first waiter, perhaps a medium task M queued before H, so H, having paid for L's critical section, waits through M's too. In v7.2, `find_proxy_task()` records `owner->blocked_donor = p` for each link it walks, and `__mutex_unlock_slowpath()` checks that field:

```c
	if (sched_proxy_exec() && current->blocked_donor) {
		/* force handoff if we have a blocked_donor */
		owner = MUTEX_FLAG_HANDOFF;
		break;
	}
	...
	/* simplified from the locked sequence */
	donor = current->blocked_donor;
	if (donor && __get_task_blocked_on(donor) == lock)
		next = get_task_struct(donor);   /* skip the FIFO waiter */
```

The scheduler already chose the waiter that matters most by picking it; the lock follows. FIFO is only the fallback.

## Simulating it

To check the scale, I wrote a small simulator: minimum-vruntime picking, 700 µs slices (v7.2's `sysctl_sched_base_slice`), real `sched_prio_to_weight` values. It's a CFS-style approximation; EEVDF's eligibility and deadline rules change slice ordering, not long-run weight shares. The setup: L (nice 19) holds the mutex and needs 2 ms more of CPU. H (nice -10) blocks on it and then needs 1 ms after acquiring. There are *n* nice-0 hogs on L's CPU. Results average 40 random starting vruntime phases for L. "Fluid" is the closed-form share model: without proxy, H waits `C·(w_L+n·w_M)/w_L`. With proxy, H and L share `(w_H+w_L)` of the CPU.

| hogs | no proxy, fluid | no proxy, sim | proxy, fluid | proxy, sim | 2 CPUs, v6.17 | 2 CPUs, v7.1 |
|---|---|---|---|---|---|---|
| 1 | 139.6 ms | 119.6 ms | 3.3 ms | 3.8 ms | 119.6 ms | 3.8 ms |
| 4 | 549.6 ms | 469.1 ms | 4.3 ms | 5.9 ms | 469.1 ms | 5.9 ms |
| 8 | 1096 ms | 935 ms | 5.6 ms | 8.7 ms | 935 ms | 8.7 ms |
| 16 | 2189 ms | 1867 ms | 8.1 ms | 14.3 ms | 1867 ms | 14.3 ms |

Three observations:

1. **Inversion grows linearly with background load, and proxy flattens it.** With 16 hogs, proxy cuts H's latency by about 130×. Sim-vs-fluid gaps are slice quantization (whole 700 µs hog slices; L's first slice sometimes landing early) and don't change the conclusion.
2. **v6.17 does nothing for cross-CPU chains.** With H on an idle CPU0 and L on a busy CPU1, the v6.17 column matches no-proxy exactly, because `proxy_deactivate()` just turns proxying back into blocking. On multicore machines that's the common case, hence the "not particularly useful" Kconfig comment.
3. **v7.1 makes the cross-CPU case match the same-CPU case.** Once H's scheduling context is migrated onto CPU1's runqueue, the results equal the single-CPU proxy column. The Kconfig comment is still there in v7.2, even though v7.1 already added multi-rq proxying.

## What's still missing

As of v7.2 (and 7.3-rc5), proxy execution only covers `struct mutex`. `blocked_on` is typed `struct mutex *`, so rwsems, semaphores and userspace futexes are still uncovered. If an owner is itself blocked on I/O or in delayed dequeue, the donor gets deactivated (`XXX Don't handle blocked owners/delayed dequeue yet`). sched_ext and PREEMPT_RT are excluded, the latter ironically the configuration that cares most about inversion, though there `rt_mutex` PI already covers most locks.

The lesson generalizes to any system with priority and blocking (thread pools, async runtimes, lock managers): separate whose budget is spent from whose code runs, and bill the waiter. Accounting stays honest, fairness is preserved, and the boost lands exactly where the waiter needed it.
