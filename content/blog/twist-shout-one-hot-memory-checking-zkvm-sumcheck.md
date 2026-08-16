---
title: "One Multiplication Per Cycle: How Twist and Shout Rebuilt zkVM Memory Checking"
date: 2026-08-17
tags: ["cryptography", "snarks", "zkvm", "performance", "algorithms"]
excerpt: "Every zkVM has to prove that its reads return the last thing written. For a decade that meant permutation checks and grand products. Twist and Shout replace both with one-hot addresses and increments. I implemented the core sum-checks, counted the prover's multiplications, and found the locality optimization pays off in RAM, not registers."
---

A zkVM proves that a program ran correctly on a CPU, cycle by cycle. Proofs are small and verification is fast; the entire cost sits on the prover, which runs five to six orders of magnitude slower than native execution. A surprisingly large fraction of that cost is not arithmetic on the program's data. It is bookkeeping: proving that when the CPU read register `x5`, the value it claims to have read really was the last value written there.

That is the memory checking problem, and it has had roughly the same shape since Blum et al. in 1991. Twist and Shout ([Setty and Thaler, eprint 2025/105](https://eprint.iacr.org/2025/105)) changes the shape. The protocols are the memory-checking layer of the Jolt zkVM, claiming well over 10× cheaper prover work at comparable proof length. What makes them interesting to read as a systems engineer is that the win comes from a data-layout decision, not from cryptography.

## The old shape: reduce to a permutation, then multiply

Offline memory checking (Spice, and everything descended from it) works by timestamping. Attach a counter to every memory cell, log every read as `(address, value, timestamp)`, log the matching write the same way, and observe that a correct execution makes the read multiset equal the write multiset plus the final state. Proving two vectors **a**, **b** ∈ F^ℓ are permutations then reduces to Lipton's trick: pick a random *r* and check

```text
∏(a_i − r) = ∏(b_i − r)
```

which fails with probability at most ℓ/|F| when they differ. The problem is the ∏. A SNARK for a product of ℓ committed values is a *grand product argument*, and grand products force the prover to commit to intermediate values it does not otherwise need: timestamps, per-operation counters, fingerprints. Spice in Jolt commits roughly 7 small values per read and 8 per write. None of those bytes are the program's data.

## Shout: make the address the indicator vector

Shout targets read-only memory, the same thing as an indexed lookup argument. The trick is to stop encoding an address as a number and encode it as its own one-hot indicator. For a table `Val` of size *K* and *T* reads, let `ra(k, j) = 1` exactly when cycle *j* reads cell *k*. Correctness of every read is then one line of linear algebra:

```text
Σ_k ra(k, j) · Val(k) = rv(j)      for every cycle j
```

Fix the cycle variables at a random point and this becomes a single sum-check instance:

```text
rv~(r_cycle) = Σ_{k ∈ {0,1}^log K}  ra~(k, r_cycle) · Val~(k)
```

No products of length *T*. No timestamps. The prover commits only to `ra`, not even to the read values, because `rv~` is a *virtual* polynomial: fully determined by the addresses and the table, so the verifier obtains `rv~(r_cycle)` as the sum-check's output rather than from a commitment.

I implemented this over a 61-bit prime field to see where the prover's work goes. The interesting quantity is not the asymptotic O(K + T); it is the per-cycle constant.

```python
eqc = eq_table(r_cycle)                    # T multiplications, one per cycle
A = [0] * K
for j in range(T):
    A[addr[j]] = (A[addr[j]] + eqc[j]) % P # one-hot scatter: additions only
# then log K sum-check rounds over A~ * Val~, degree 2 per variable
```

Instrumenting the multiply counter across sizes:

```text
K=  32 T=1024:  eq-table=1023 (1.00/cycle)  scatter=0 mults  rounds=93  = 3(K-1)
K=  32 T=4096:  eq-table=4095 (1.00/cycle)  scatter=0 mults  rounds=93  = 3(K-1)
K= 256 T=4096:  eq-table=4095 (1.00/cycle)  scatter=0 mults  rounds=765 = 3(K-1)
```

That reproduces the paper's "*T* field multiplications" for the *d*=1 core prover, and says something sharper than the formula does. Every multiplication that scales with trace length comes from building the `eq(r_cycle, ·)` table — a generic sum-check preliminary. The part that is actually about *looking things up* costs zero multiplications, because a one-hot row degenerates the sparse matrix-vector product into a scatter-add. The rounds cost 3(*K*−1) and do not grow with *T* at all. My tamper test, perturbing a single claimed read value, fails the very first round check.

## Twist: commit the deltas, not the state

Read/write memory is harder, because the table changes. The naive fix is committing `Val(k, j)` for every cell at every cycle: *K* values per cycle, worse than Spice even for 32 registers. Twist commits the *increments* instead:

```text
Inc(k, j) := Val(k, j+1) − Val(k, j) = wa(k, j) · (wv(j) − Val(k, j))
```

Because exactly one cell is written per cycle, `Inc` has one non-zero entry per cycle — density 1/*K*, confirmed empirically — and that entry is a 32-bit difference, cheap to commit. `Val` becomes virtual, recovered by a prefix sum expressed as a sum-check against the less-than function:

```text
Val~(r_addr, r_cycle) = Σ_{j' ∈ {0,1}^log T} Inc~(r_addr, j') · LT~(j', r_cycle)
```

`LT~` is the multilinear extension of "j' < j", which the verifier evaluates itself in O(log *T*). I checked the identity by materializing `Val` and `Inc` for random write traces and evaluating both sides off the Boolean hypercube:

```text
K=  8 T=  8   Eq.11 holds=True   non-zero Inc entries=8    density=0.1250
K= 32 T= 64   Eq.11 holds=True   non-zero Inc entries=64   density=0.0312
K= 32 T=256   Eq.11 holds=True   non-zero Inc entries=256  density=0.0312
```

So: reads are checked against a virtual `Val`, `Val` is evaluated from committed increments, and the increments are checked against the committed write address and value by a third sum-check. Three sum-checks, no grand product, no timestamps.

## Auditing the cost tables

The paper's headline comparisons are analytic, so they can be re-derived. For 32 RISC-V registers with *d*=1, committed data should be one-hot `ra` (32 bits) + one-hot `wa` (32) + `wv` (32) + `Inc` (32) = **128*T* bits**, matching Figure 4, against 421*T* for Spice — a 3.3× reduction. The field-work formula (5·log *K* + 2*d*² + 4*d* + 4)·*T* gives exactly **35*T*** for *K*=32, *d*=1, also matching.

Two things did not reconcile. Section 2.4.2 says that for gigantic structured tables with *C*=4 and *d*=2 the formula "translates to 40*T* multiplications"; evaluating (7*C* + *d*² + 3*d* + *c* + 2) with *c* = *C*/*d* = 2 gives 28 + 4 + 6 + 2 + 2 = **42*T***, which is what Figure 3 reports. The prose is a slip, not the table. And Figure 3's *d*=8 row (112*T*) cannot come from that formula either — it gives 118.5*T* — but the Appendix C variant with a linear rather than quadratic dependence on *d* gives 111*T*. The rows of that table are computed with different prover algorithms, which is defensible but worth knowing before you use it as a menu. The *d*=4 row (65*T*) sits between both formulas (59*T* and 67.5*T*) and I could not reproduce it.

## The locality optimization is aimed at the wrong memory

One clause deserves more attention than it gets. For *d*=1, Twist's worst-case 5·log *K* term "falls to just 7*i*" when accesses are 2^*i*-local, meaning a cell is reused within 2^*i* cycles. That is an inequality, so it has a break-even at 7*i* < 5·log *K*.

```text
K=32        : worst case 25T ; local variant wins only for i < 3.57  (reuse < 12 cycles)
K=1024      : worst case 50T ; local variant wins only for i < 7.14  (reuse < 141 cycles)
K=2^20 (RAM): worst case 100T; local variant wins only for i < 14.29 (reuse < 19,972 cycles)
```

For registers — which are the definition of hot storage — the margin is about twelve cycles. Is real code that tight? I measured static register reuse distances by disassembling three arm64 binaries (31 GPRs, close enough to RISC-V's 32), recording for every register read the distance to the most recent write of that register: 54.1% of 94,076 reads are within 8 instructions, 65.4% within 16. This is a proxy, using straight-line disassembly order with no control flow, but the shape is clear. Roughly half of register reads clear a 12-cycle bar, making the optimization a partial win there.

For RAM the same arithmetic gives a break-even near 20,000 cycles, and essentially every data access in a cache-resident working set is reused far sooner. The locality clause is worth much more on large memories than on the small ones it reads like it was written for, purely because the term it competes against grows with log *K* while its own cost is tied to reuse distance, not memory size.

None of this touches the real ceiling, which is commitment cost: with hashing-based schemes, bits committed dominates prover time, not field multiplications. That is why Twist's 3× reduction in committed bits matters more than its 2× in multiplications. The lesson generalizes past cryptography. The win came from choosing a redundant, sparse representation of an address — *K* bits where log *K* would do — because it turned a product into a scatter-add. Blowing up the representation to collapse the operation is a trade systems engineers make constantly. It is nice to see it pay off in a proof system.
