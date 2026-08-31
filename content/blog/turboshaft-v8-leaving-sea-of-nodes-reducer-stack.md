---
title: "Turboshaft: V8 Walked Away From the Sea of Nodes"
date: 2026-08-31
tags: [compilers, jit, javascript, performance, ir]
excerpt: "For twenty years the sea of nodes was the received wisdom for optimizing compilers. V8 finished replacing it with a CFG-based IR and halved compile time. I tried to reproduce the two mechanical arguments — traversal order and memory locality — and only one of them survives in isolation."
---

HotSpot's C2 made the sea of nodes (SoN) the prestige IR for optimizing compilers in 1999. V8 followed it into Turbofan in 2014. In 2024 V8 finished undoing that decision: Turboshaft, a plain CFG-based IR, now owns the JavaScript optimizing backend and the entire WebAssembly pipeline, and V8 reports compile time cut roughly in half against the SoN pipeline it replaced.

That is an unusual direction of travel. The interesting part is *why*, because the reasons are mechanical rather than aesthetic — and two of them are measurable, so I measured them.

## What the sea of nodes promised

In a CFG, position is meaning: if `t = a + b` is the third instruction of block 4, that is where it executes, whether or not anything depends on ordering it there.

SoN drops that. A node is a single operation; edges are *uses*. Ordering is expressed only where it is real: control edges sequence branches and returns, and a separate **effect chain** sequences side-effecting operations so a store cannot drift past a load of the same memory. Everything else — pure arithmetic, comparisons, allocations of known-immutable values — floats, with no schedule until a dedicated phase invents one. The pitch: you never encode an ordering constraint you did not mean, so GVN and code motion fall out of the representation instead of being separate analyses.

## Where it breaks

V8's own postmortem is blunt about the first problem: in a dynamically typed language nearly every operation either has side effects or carries a guard — type checks, bounds checks, map checks — so nearly every node ends up pinned to the effect or control chain anyway. Their conclusion, quoted verbatim: *"SoN is just CFG where pure nodes are floating."* You pay the representation's whole cost and float a minority of your nodes.

The pinning also lies. Effect chains are built sequentially during graph construction, so a load used in only one arm of an `if` is still chained before the branch splits; recovering the fact that it could sink requires exactly the dataflow analysis a CFG compiler would have written. `JSNativeContextSpecialization::ReduceNamedAccess` had to juggle three separate effect chains by hand, and V8 shipped a bug from mixing them up.

Then the scheduler starts fighting the optimizer. Take a `switch` where two arms compute the same division. Redundancy elimination merges them into one node — correct, and now that node's only legal schedule is *before* the switch, so it executes on every path including the ones that never needed it. The scheduler's job becomes re-duplicating the division to undo the optimization.

And control-flow-sensitive typing barely works. Given `if (x < 42) return x + 1;`, a CFG trivially knows the add cannot overflow int32 inside the taken branch. In SoN the `CheckedAdd` is a floating pure node with no branch context, so you cannot drop the check until scheduling — at which point, as V8 puts it, you are back to a CFG.

## Experiment 1: does traversal order actually cost that much?

The compile-time argument I found most suspicious is the traversal one. A CFG lets peepholes run front-to-back in one sweep. SoN has no schedule, so passes walk backward from `return` nodes through inputs and re-enqueue users on change. V8 measured *nodes are changed only once every 20 visits*.

I built the isolated version: a 200k-node DAG, inputs drawn from a 64-node sliding window, 15% constants, one forward-flowing rule set (constant folding, `x*1 → x`, `x+0 → x`). Same rules, same graph, only the order differs — demand-driven worklist from the return versus repeated program-order sweeps.

```
demand-driven : 411,164 visits, 184,791 changes -> 2.2 visits/change
program order : 400,000 visits, 170,089 changes -> 2.4 visits/change
reachable from return: 138,422 of 200,000
```

The headline metric refuses to reproduce: 2.2 versus 2.4 visits per change, and the *worse* number belongs to the CFG. The real difference is hiding in the ratios. Program order converged in one effective sweep plus one confirming sweep, so every node was rewritten at most once — 170k changes over 200k nodes. The demand-driven order rewrote its 138,422 reachable nodes 184,791 times: **1.34 mutations per node, ~34% churn**, work performed because a node was folded before its inputs had settled.

The demand order gets one thing free that the sweep does not: it never looked at the 61,578 nodes (31%) unreachable from the return, while program order folded all of them and discarded the results. Net visits still favored program order — 400k against 411k while processing 44% more nodes.

So the traversal-order argument is real but small in isolation: ~34% redundant rewrites, not 10×. V8's 20:1 figure has to come from the parts I did not model — many interacting rules, effect-chain patching, and state-tracking analyses whose cost explodes when visit order is unpredictable. That matches their strongest single number: Load Elimination, which in Turbofan bailed out entirely on large graphs, benchmarked **up to 190× faster** once rewritten against a CFG it could walk in order.

## Experiment 2: the layout argument

The other quantitative claim is locality. In-place graph mutation plus lowering allocates replacement nodes far from the originals, so use edges become long pointer chases; V8 measured ~3× the L1 dcache misses of Turboshaft (7× in some phases), worth up to 5% of compile time.

I rebuilt both layouts in C on arm64: identical graph shape, 3 inputs per node. Version A is one `malloc` per node, then a simulated lowering pass that replaces 40% of nodes with fresh allocations interleaved with unrelated allocations. Version B stores operations in a contiguous buffer with inputs as `uint32` indices, and "lowers" by re-emitting into a fresh buffer in order. Then walk every node and read every input.

```
       ops    ptr ns/edge    buf ns/edge    ratio
      1000          1.543          1.792     0.86x
     10000          2.339          1.669     1.40x
     50000          3.348          1.944     1.72x
    200000         13.722          6.556     2.09x
   1000000         28.320         20.958     1.35x
```

Below L1 the pointer graph is fine — marginally faster, since indices cost an extra add. The gap opens between 10k and 200k operations and peaks at 2.1×, then *collapses* at 1M where both layouts are DRAM-bound on random input reads and the shared access pattern dominates. The win is real but it is a mid-size-working-set effect, which is exactly the regime a JIT graph occupies. It is also consistent with "up to 5% of compile time" — this is not why you rewrite your compiler.

## What Turboshaft actually is

The design reads like a deliberate inversion of every SoN property. Operations live in an append-only `OperationBuffer` of 8-byte slots; an `OpIndex` is a byte offset into it, not a pointer, so edges are half the width and stay valid across buffer growth. Each operation's slot count is stamped at both its first and last slot id, which is what makes the buffer iterable in either direction. A `Block` stores no instructions — just `begin_`/`end_` `OpIndex` values delimiting its span, with kinds `kMerge`, `kLoopHeader`, `kBranchTarget`, predecessors as an intrusive singly-linked list, and dominator queries via Myers' random-access stack. Between phases a graph swaps buffers with a lazily-created companion graph, so the output of phase *N* becomes the input of *N+1* with no reallocation.

The pass architecture is where the compile time went. Passes are **reducers**: templated mixins stacked at compile time, each intercepting the operations it cares about and forwarding the rest.

```cpp
template <class Next>
class MyPeepholeReducer : public Next {
 public:
  TURBOSHAFT_REDUCER_BOILERPLATE(MyPeephole)

  V<Word32> REDUCE(WordBinop)(V<Word32> left, V<Word32> right,
                              WordBinopOp::Kind kind, WordRepresentation rep) {
    LABEL_BLOCK(no_change) {
      return Next::ReduceWordBinop(left, right, kind, rep);   // not my business
    }
    if (kind == WordBinopOp::Kind::kMul) {
      int32_t c;
      if (matcher().MatchIntegralWord32Constant(right, &c) && c == 1) {
        return left;                       // x * 1 -> x, emits nothing at all
      }
    }
    goto no_change;
  }
};

using MyStack = TSAssembler<MachineOptimizationReducer, ValueNumberingReducer>;
```

A `REDUCE` that returns an existing `OpIndex` deletes the operation by never emitting it. One that calls `Asm().Word32Add(...)` re-enters the *top* of the stack, so a rewrite is immediately visible to every other reducer. Stacking N reducers fuses N passes into one traversal of the graph, with `ReducerBase` at the bottom maintaining split-edge form and predecessor lists so that a reducer can introduce entirely new control flow mid-pipeline — the thing Turbofan had to defer to a scheduling phase.

## The takeaway

The lesson is not "CFGs won." Maglev and V8's builtins pipeline are still SoN, and C2 still ships in every JDK. It is that IR expressiveness and IR traversability trade against each other, and which matters depends on what your passes are. A suite of local algebraic rewrites loves a floating graph. A suite dominated by state-tracking analyses — load elimination, escape analysis, control-flow-sensitive typing — needs a total order to walk, and if the representation refuses to give it one, every one of those passes reconstructs a schedule privately, badly, and repeatedly. An explicit schedule is a constraint if you are moving code and an asset if you are proving things about it.
