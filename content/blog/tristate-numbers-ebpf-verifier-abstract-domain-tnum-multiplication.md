---
title: "Tristate Numbers: The Abstract Domain That Decides Whether Your eBPF Program Loads"
date: 2026-08-26
tags: ["ebpf", "static-analysis", "abstract-interpretation", "linux-kernel", "verification"]
excerpt: "The eBPF verifier tracks your registers bit by bit in a domain called tnums. Multiplication in that domain was replaced upstream in August 2025, and the commit message quietly admits the new version is sometimes less precise. I enumerated all 43 million 8-bit operand pairs to find out where."
---

When the kernel rejects an eBPF program with `math between map_value pointer and register with unbounded min value is not allowed`, the program is usually fine. What failed is a *precision* argument: the verifier's abstract interpreter could not prove your offset was in range, because somewhere upstream it lost track of which bits of a register were known.

The domain doing that tracking is a **tnum** — a tristate number, introduced by Edward Cree in 2017's value-tracking rework. It is 200 lines of `kernel/bpf/tnum.c`, and it is the single most load-bearing static analysis in the Linux kernel by number of programs gated on it.

It also changed materially in August 2025, in a way the commit message hedges about. That hedge is checkable.

## The domain

A tnum assigns each bit one of three states: known-0, known-1, or unknown. The kernel encodes this as two words with a disjointness invariant:

```c
struct tnum {
	u64 value;   /* known bits, at positions where mask is 0 */
	u64 mask;    /* 1 = this bit is unknown */
};
/* invariant: value & mask == 0 */
```

The concretization is `γ(t) = { x : x & ~t.mask == t.value }` — a set of size `2^popcount(mask)`. This is the bitwise-known-bits domain that LLVM calls `KnownBits`, and it is deliberately *not* an interval domain: it captures alignment and low-bit structure (`ptr + (idx & 0xff)` stays 8-bit bounded; `x << 3` is 8-byte aligned) that intervals cannot express, and it is closed under bitwise ops that intervals mangle.

The verifier runs it alongside signed and unsigned interval domains, and the two exchange information. That exchange got a new operator in February 2026 — `tnum_step(t, z)`, which returns the smallest member of `t` greater than `z`:

```c
static void __update_reg64_bounds(struct bpf_reg_state *reg)
{
	cnum64_intersect_with(&reg->r64, cnum64_from_tnum(reg->var_off));

	/* Check if u64 and tnum overlap in a single value */
	tnum_next = tnum_step(reg->var_off, reg_umin(reg));
	...
	if (umin_in_tnum && tnum_next > reg_umax(reg))
		___mark_reg_known(reg, reg_umin(reg));
```

This is a textbook *reduced product*: if the interval `[umin, umax]` and the tnum lattice intersect in exactly one value, the register becomes a constant — a refinement neither domain can reach alone. Hao Sun's March 2026 follow-up compressed the ten-variable original into a straight line of bit tricks, shipping a CBMC equivalence check and a Lean 4 correctness proof in the commit message. Kernel abstract interpretation now arrives with machine-checked proofs attached.

## Addition is solved

`tnum_add` is five lines and looks like nothing:

```c
	sm = a.mask + b.mask;
	sv = a.value + b.value;
	sigma = sm + sv;
	chi = sigma ^ sv;
	mu = chi | a.mask | b.mask;
	return TNUM(sv & ~mu, mu);
```

The trick is that adding the masks *as if they were values* forces a carry into every bit position that any concrete choice of unknown bits could reach; `chi` then marks exactly those positions. Vishwanathan, Shachnai, Narayana and Nagarakatte proved this sound **and optimal** — no tnum tighter than `mu` contains every concrete sum — in *Sound, Precise, and Fast Abstract Interpretation with Tristate Numbers* (CGO 2022, distinguished paper).

I reimplemented the domain at `N` bits and checked that claim by brute force. At 4, 6 and 8 bits, over every ordered pair of tnums and every pair of concrete members, `tnum_add` produced zero unsound results and was bit-for-bit equal to the optimal abstraction in **every** pair. The theorem holds up.

Multiplication is where it gets interesting, because multiplication in this domain has no known optimal algorithm at all.

## Three generations of tnum_mul

Both shipped algorithms are long multiplication over the multiplier's bits. They differ in how they accumulate.

The version that shipped from 2021 to v6.15 — the CGO'22 algorithm — decomposes each partial product into a value part and a mask part, computes the value part *exactly* with one machine multiply, and accumulates only the uncertainty:

```python
def mul2021(a, b, M):
    acc_v, acc_m = (a.v * b.v) & M, Tn(0, 0, M)     # exact value product
    while a.v or a.m:
        if a.v & 1:      acc_m = add(acc_m, Tn(0, b.m, M), M)
        elif a.m & 1:    acc_m = add(acc_m, Tn(0, b.v | b.m, M), M)
        a, b = rshift(a, 1), lshift(b, 1)
    return add(Tn(acc_v, 0, M), acc_m, M)
```

Nandakumar Edamana's August 2025 rewrite (commit `1df7dad4d5c4`) throws that away and does the obvious thing instead — with one addition. When the multiplier bit is *unknown*, compute both partial accumulators and join them:

```python
def mul2025(a, b, M):
    acc = Tn(0, 0, M)
    while a.v or a.m:
        if a.v & 1:      acc = add(acc, b, M)
        elif a.m & 1:    acc = union(acc, add(acc, b, M), M)   # the twist
        a, b = rshift(a, 1), lshift(b, 1)
    return acc
```

`tnum_union` is the join: it keeps agreeing known bits and marks every disagreement unknown. The commit message is candid about the tradeoff: precision improves "in a significant number of cases (at the cost of losing precision in a relatively lower number of cases)." No numbers are given.

## Enumerating all of them

At 8 bits there are `3^8 = 6,561` tnums and 43,046,721 ordered pairs — small enough to enumerate exhaustively, computing for each pair both algorithms and the *optimal* tnum (the union over all concrete products). 25 seconds in C:

| | mul2021 | mul2025 |
|---|---|---|
| unsound results | 0 | 0 |
| optimal | 38,749,471 (90.02%) | 39,500,176 (91.76%) |
| mean unknown bits | 6.2213 | 6.1966 |
| tighter than the other | 206,501 (0.48%) | 978,716 (2.27%) |

So the rewrite is a real net win: strictly tighter 4.7× more often than it is looser, and optimal on 1.7 points more of the space. On the 2021 commit's own showcase example — `000000x1 * 0010011x` — the new algorithm returns `0x1x0xxx`, one bit tighter than its predecessor's `0x1xxxxx`, and provably optimal.

But the losses are not noise, and they are not uniformly distributed. Here is the smallest one:

```text
a = 00000111   (constant 7)
b = 0000101x   ({10, 11})
mul2021 = 0100xxxx   (4 unknown bits)
mul2025 = 0xxxxxxx   (7 unknown bits)
optimal = 0100x1xx   (3 unknown bits)
```

The mechanism is visible in the two listings. When the multiplier is fully known, `mul2025` never takes the union branch at all — it degenerates into a chain of `tnum_add`s of the *whole* multiplicand, and each of those additions conservatively smears carries across every bit an unknown could reach. `mul2021` never does that: it computes `a.value * b.value` with a single exact machine multiply, so all carries among known bits are preserved, and only the mask contribution is over-approximated.

That predicts a specific regressed subclass, and the data confirms it. Splitting the 43M pairs by whether the first operand is a constant:

- **constant first** (1,679,616 pairs): 2025 is looser on 39,238 and tighter on only 3,808 — a **10.3× net regression**, with mean unknown bits rising from 4.5176 to 4.5412.
- **uncertain first** (41.4M pairs): 2025 is tighter on 974,908 and looser on 167,263 — a 5.8× net win.

There is a second-order consequence. `tnum_mul` iterates over the *first* operand, so precision is order-dependent, and the verifier does not normalize:

```c
	case BPF_MUL:
		dst_reg->var_off = tnum_mul(dst_reg->var_off, src_reg.var_off);
```

Under the 2021 algorithm the two orders disagreed on 631 of 21.5M unordered pairs (0.003%). Under the 2025 algorithm they disagree on 1,114,952 (5.18%) — the union-based accumulator made multiplication substantially non-commutative *in precision*. For the const-first pairs, simply swapping the operands yields a strictly tighter result 13.5% of the time, and picking the better of the two orders on every pair would cut the mean unknown-bit count from 6.1966 to 6.1625 for the cost of one extra call.

The saving grace is that BPF's most common multiply, `dst *= imm`, loads the immediate into `src_reg` — so the constant lands in the *second* position, the orientation the new algorithm handles well. The regressed shape is a known-constant destination times an uncertain source, which is rarer but entirely legal.

## What this means if you write BPF

Verifier rejections are precision failures, and precision is lost at identifiable operations. Multiplying two registers whose masks are both dirty is the fastest way to reach `xxxxxxxx`; `&`-masking a value *before* using it in arithmetic, rather than after, gives the domain something to hold onto; shifts and adds are nearly free precision-wise, and additions are provably optimal.

The research direction here is worth watching: the Rutgers group's *Agni* line has moved from proving individual operators (CGO'22) to finding latent unsound ones (SAS 2024) to *synthesizing* abstract operators and comparing their precision by differential synthesis (SAS 2025, eBPF'25). Combined with an empirical 2026 study of 235 verifier rejections finding that programmers cannot tell which operation lost the proof, the shape of the fix is clear — the verifier should be able to tell you which instruction turned your bits to `x`. Until then, `bpftool prog dump xlated` and the log's `(id;mask)` pairs are what you have.

*Kernel sources quoted from `torvalds/linux` master and `v6.15`. Measurement code: an N-bit reimplementation of `tnum.c` in C, cross-validated against a Python mirror at 4 bits (identical optimality counts, 6262/6334 of 6561).*
