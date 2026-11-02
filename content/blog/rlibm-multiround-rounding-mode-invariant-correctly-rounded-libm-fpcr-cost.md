---
title: "RLibm-MultiRound on Apple Silicon: Correct Under Every Rounding Mode, and What a Mode Switch Really Costs"
date: 2026-11-03
tags: [floating-point, numerical-computing, math-libraries, performance, arm64]
excerpt: "A correctly rounded libm is only correct in the rounding mode it was built for. RLibm-MultiRound (arXiv:2504.07409) removes the fesetround calls RLibm needed for non-default modes, using either round-to-zero emulation or interval bounds baked into the polynomial generator. I fuzzed its RZ-emulation algorithms on an M3 Pro: 0 mismatches in 200M pairs per mode. A rounding-mode change costs ~17 ns per FPCR write there, but only when the mode actually changes. RZ emulation runs ~11× a plain polynomial, which flips the paper's AMD ranking. I also swept all 2^32 floats through Apple's libm in all four modes: sinf misrounds 2.28 billion inputs under directed rounding."
---

# RLibm-MultiRound on Apple Silicon

A correctly rounded math library returns the exact result rounded to the target format, but only in the rounding mode it was built for. IEEE 754 defines four binary rounding modes: round-to-nearest-even (RN), toward zero (RZ), up (RU) and down (RD). Interval arithmetic, geometric predicates and some accelerators use the non-default ones. If the library's internal arithmetic runs in the caller's mode, every intermediate rounding shifts, and so can the answer.

The RLibm project builds correctly rounded float32 functions by approximating the *correctly rounded result* rather than the real function. **RLibm-MultiRound** (Park, Kim and Nagarakatte, arXiv:2504.07409, 2025) makes those functions correct under the caller's rounding mode without ever touching it. I re-checked its building blocks on an M3 Pro, and measured what the paper only reports for x86: the cost of a mode switch.

## How RLibm works, in one paragraph

For an input x, an oracle (MPFR) gives f(x) rounded to a 34-bit format with *round-to-odd* (RO). RO keeps the closest truncation and ORs a sticky bit into the last place. Around that 34-bit result there is an interval [l, h] of doubles that all round to it. Finding a polynomial P with `l ≤ P(x') ≤ h` for every reduced input x' is then a linear program. Each interval is about 2^19 double ulps wide, far looser than a minimax error bound, so the polynomials stay low-degree. Rounding an RO result with p+2 bits to any p-bit format, in any mode, matches rounding the real value directly, so one implementation serves every format up to float32.

I tested that claim with 80-bit integers standing in for real values, placed adversarially within a few units of p-bit midpoints and p-bit values:

```text
intermediate      target p    double-rounding errors (4 modes)
34-bit RO         16..32      0 / 80000 for every p
33-bit RO         31          0 / 80000
33-bit RO         32          8570 / 80000   (all in RN; RZ/RU/RD: 0)
34-bit RN         32          16971 / 80000
34-bit RZ         32          6300 / 80000
```

The second guard bit exists only for round-to-nearest. The directed modes need just one.

## The problem the paper fixes

RLibm's polynomials are proven correct only when evaluated in RN. So the published library wraps every call:

```c
int rnd = fegetround();
fesetround(FE_TONEAREST);
double res = rlibm_sinf(x);
fesetround(rnd);
float out = (float)res;     // final rounding in the caller's mode
```

The paper puts this at roughly 40 cycles per `fesetround` on x86. Without the wrapper, about 100 inputs come out wrong. MultiRound offers two ways to drop it.

**Rounding-invariant outputs.** Generate everything in RZ instead of RN, then *emulate* RZ inside the library whatever mode the caller is in. Every add and multiply becomes an error-free transformation plus a bit-level fix-up:

```c
double rza(double a, double b) {                 // a +RZ b, in any mode
  if ((bits(a) ^ bits(b)) == 0x8000000000000000) return +0.0; // a == -b
  double s = a + b;
  if (fabs(b) > fabs(a)) swap(&a, &b);
  double z = s - a, t = b - z;                   // FastTwoSum error proxy
  if ((bits(t) << 1) != 0 && ((bits(t) ^ bits(s)) >> 63))
    s = from_bits(bits(s) - 1);                  // rounded away from zero: step back
  return s;
}
double rzm(double a, double b) {                 // a *RZ b, in any mode
  double m = a * b, c1 = fma(a, b, -m), c2 = fma(-a, b, m);
  if (bits(c1) != bits(c2) && ((bits(c1) ^ bits(m)) >> 63))
    m = from_bits(bits(m) - 1);
  return m;
}
```

The trick is that t (or c1) is only a *faithful* rounding of the true error outside RN, yet faithful rounding preserves the sign and nonzeroness of the error. That's all the fix-up needs. RZM compares c1 against c2 bitwise rather than testing c1 for zero. When the error underflows, the two still differ in the sign of zero.

**Rounding-invariant input bounds.** Leave the runtime code alone. Evaluate each candidate polynomial and its output compensation in interval arithmetic, with RD for lower bounds and RU for upper bounds, and require the whole interval to fit in [l, h]. Every faithful rounding mode lands between RD and RU, so the result is correct in all of them, including modes that don't exist yet. The cost moves entirely into the generator.

Paper's results, on an AMD EPYC 7313P: input bounds give 2.3× over RLibm-with-fesetround, RZ emulation 1.6×. The ranking is input bounds, then RZ emulation, then fesetround.

## Check 1: does RZ emulation hold up?

I compiled both functions with `-ffp-model=strict` and compared them bit-for-bit against hardware RZ (`fesetround(FE_TOWARDZERO)`). There were 200 million operand pairs, mixing full-range normals, subnormals, short-mantissa (exact) cases, near-cancellations, `a == -b`, signed zeros and underflowing products:

```text
mode   RZA mismatches   native a+b ≠ RZ     RZM mismatches   native a*b ≠ RZ
RN     0                56,279,604          0                56,379,869
RU     0                56,275,651          0                58,981,988
RD     0                79,767,217          0                117,553,212
```

The fix-up fired tens of millions of times per mode and never missed. I also checked how much slack the input-bounds method uses up. For a degree-5 Horner on [0, 1/64), the RU result minus the RD result is at most 2 double ulps, against an interval about 2^19 ulps wide. So the method costs essentially nothing except on hard-to-round inputs whose true value sits near an interval edge.

## Check 2: what a mode switch costs on arm64

On AArch64 the rounding mode lives in FPCR bits 23:22. I timed a degree-5 Horner kernel, best of 5 runs over 20M calls, in five variants:

```text
                         app in RN    app in RU     (ns/call, throughput)
plain (= input bounds)   4.08         4.08
fesetround wrapper       11.57        43.39
raw msr fpcr             8.07         38.24
lazy: write only if ≠RN  4.26         38.26
RZ emulation (branchy)   59.06        36.12
RZ emulation (non-strict)44.22        45.44
```

An FPCR write that actually changes the mode costs about 17 ns, roughly 70 cycles. That is (38.24 − 4.08)/2, worse than the paper's x86 numbers. Writing the value FPCR already holds costs about 2 ns. Almost all callers run in RN, and a one-branch "skip if already RN" check brings that case down to 4% overhead. RZ emulation turns every flop into about six FP ops plus GPR round-trips on a serial Horner chain, and lands near 11× the plain kernel. On this core it's *slower* than `fesetround` for RN callers and only 1.2× faster for RU callers. That reverses the paper's AMD ranking. Caveat: my kernel is polynomial-only; real functions send many inputs down constant paths, which the paper notes shrinks the emulation penalty. Input bounds win either way, at zero runtime cost in every mode.

## Check 3: how does a mainstream libm behave off RN?

For contrast, I ran every finite float32 input (4,278,190,080 of them) through macOS's `expf`, `exp2f`, `logf`, `log2f`, `sinf` and `cosf` under each mode. The reference was the double-precision function, rounded to float in the target mode. Any case within 2^-50 relative of a rounding boundary was flagged and resolved with mpmath at 300 bits. Before trusting it, I cross-checked the reference path against mpmath on 18,000 random input/mode pairs: 0 disagreements.

```text
function   RN              RZ              RU              RD
expf       2,041,856       60,763,997      36,379,604      60,763,997
exp2f      2,035,531       58,305,278      34,994,185      58,305,278
logf       13,542          13,472          13,467          13,473
log2f      606             512             512             512
sinf       346,516,415     2,275,978,528   2,275,978,529   2,275,978,528
cosf       295,141,874     295,272,612     295,272,620     295,272,612
```

Every miss is within 1 ulp: faithful everywhere, which is all Apple promises. The profile is still telling. The log family barely notices the mode, consistent with a result computed with slack and rounded once at the end. The exp family misrounds 17–30× more inputs under RZ/RD than under RN. In RN, `sinf` misrounds about 17% of inputs with |x| ≥ 2^12; I confirmed 18 of 18 sampled cases against mpmath. Under any directed mode it gets 53% of the entire domain wrong. That's the tiny-argument path. sin(x) is slightly smaller in magnitude than x, so `RU(sin(2^-20))` should be 2^-20. Apple returns `0x1.000002p-20`, and in RD it returns 2^-20 instead of the float below it. A fast path like `return x` only works in RN.

That is the gap MultiRound closes: accuracy in RN doesn't carry over, and the common shortcuts break first.

## Takeaways

- **Round-to-odd at p+2 bits is exact for any target format and mode**; I found 0 errors in 80k adversarial cases per width. Drop to p+1 and only RN breaks.
- **RZ emulation is provably sound**: 0 mismatches in 800M checks. On Apple silicon it costs ~11× a plain polynomial, more than the mode switch it replaces for RN callers.
- **Mode switches on arm64 are cheap until the mode actually changes**: about 2 ns to rewrite the same FPCR value, about 17 ns to change it. A lazy check fixes the common case. For everything else, move correctness into the generator, which is what the input-bounds method does.
- **Test libms in every rounding mode.** A function can be within 1 ulp everywhere and still misround half the domain under RU.
