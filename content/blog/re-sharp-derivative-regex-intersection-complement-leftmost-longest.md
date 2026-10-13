---
title: "RE#: Intersection and Complement in a Linear-Time Regex Engine, Rebuilt From Brzozowski Derivatives"
date: 2026-10-13
tags: [regex, automata, brzozowski-derivatives, string-matching, formal-languages]
excerpt: "RE# (POPL 2025) adds & and ~ to a non-backtracking regex engine and still comes first on the rebar benchmark suite. I rebuilt its core in about 200 lines of Python and checked it against an independent span-semantics oracle (9,000/9,000 agree). Three things stood out. Encoding a password filter as a union of permutations gives exactly the same 2^k+1 DFA states as encoding it with intersection, but each state is up to 190× larger. Without the loop-subsumption rewrite, the automaton grows exponentially. And all-matches search still costs n²/2 steps on a three-character regex."
---

Mainstream regex engines stop at union. You can write `a|b`, but not "contains a digit **and** an uppercase letter **and** not `admin`". Backtracking engines fake it with stacked lookaheads (hello, ReDoS); RE2, Rust `regex` and Hyperscan simply refuse.

[RE#](https://arxiv.org/abs/2407.20479) (Varatalu, Veanes & Ernits, POPL 2025) adds intersection `&`, complement `~` and unbounded lookarounds to a non-backtracking engine built on .NET's derivative-based matcher. On the curated [rebar](https://github.com/BurntSushi/rebar) suite it has the best geometric-mean slowdown, **1.48× vs 2.54×** for Rust `regex` (the paper's "71% faster"). On its own extended suite it scores 1.09× against Hyperscan's 3.77×.

The trick is from 1964: Brzozowski derivatives handle Boolean operators for free. I rebuilt the core to see which parts carry the weight.

## Derivatives, and why `&` and `~` cost nothing

The derivative δ_c(R) is the regex matching whatever can follow the character `c` in a match of R. Matching means taking repeated derivatives and checking whether the result accepts the empty string (is "nullable"). The rules for the Boolean operators are trivial:

```python
def d(r, c):                       # hash-consed tuples; memoised
    t = r[0]
    if t == 'p': return EPS if c in r[1] else BOT          # character class
    if t == 'c':                                            # concatenation
        x = cat(d(r[1], c), r[2])
        return alt(x, d(r[2], c)) if null(r[1]) else x
    if t == 'o': return alt(*(d(x, c) for x in r[1]))       # R | S
    if t == 'a': return conj(*(d(x, c) for x in r[1]))      # R & S
    if t == 'n': return neg(d(r[1], c))                      # ~R
    if t == 'l':                                            # R{lo,hi}
        _, b, lo, hi = r
        return cat(d(b, c), loop(b, max(lo-1, 0), None if hi is None else hi-1))
```

Nullability is just as direct: `null(R&S) = null(R) and null(S)`, `null(~R) = not null(R)`. Complementing a Thompson NFA requires determinising it first, which is why NFA-based engines leave `~` out.

Each distinct derivative becomes a lazily created DFA state. The state set stays finite only because `|` and `&` are stored as sets (associative, commutative, idempotent: "ACI"). Character classes are split into minterms, so `\w` is one transition, not tens of thousands. The paper cites the size of `\w` as part of why it is >7× faster than the next engine on `\b\w{12,}\b`.

## Leftmost-longest needs two passes, one of them backwards

With `&` there's no sensible notion of "which alternative wins", so RE# uses POSIX leftmost-longest semantics. Its matcher (Theorem 3) runs the **reversed** regex over the **reversed** input to find the leftmost start, then runs forward from there to find the longest end:

```python
def ll_match(s, R):
    k = max_end(s[::-1], 0, cat(TOPSTAR, rev(R)))   # latest end in reverse = earliest start
    if k < 0: return None
    i = len(s) - k
    return (i, max_end(s, i, R))                     # longest end from that start
```

Reversal commutes with every operator, including `~` and `&` (Theorem 2, verified in Lean). For all matches, the backward pass collects every valid start in one sweep, and the forward pass runs once per non-overlapping match.

To check my version I wrote a separate oracle. It applies the paper's span semantics directly (§4.3): it computes the set of (i, j) pairs that match each subterm, with `~R` defined as all spans minus M(R). I compared both on 3,000 random regexes over `{a,b,c}`, nesting `&`, `~`, loops and stars four deep, with three random strings each. **9,000/9,000** results matched for first match and for all matches, with the rewrite rules on and off.

## Finding 1: the password filter blows up the regex, not the DFA

The paper's motivating example is a password filter: at least one lowercase letter, one uppercase letter, one digit and one symbol. With intersection it is `(_*[a-z]_*)&(_*[A-Z]_*)&(_*\d_*)&(_*[!-/]_*)&\S*`. Without intersection you need one alternative per ordering of the k classes, so k! of them. I built the full DFA over minterms for both encodings:

| k classes | size with `&` | DFA states | size as permutation union | DFA states | largest state, `&` vs union |
|---|---|---|---|---|---|
| 3 | 24 | 9 | 103 | 9 | 24 vs 198 |
| 4 | 31 | 17 | 529 | 17 | 31 vs 1,111 |
| 5 | 38 | 33 | 3,241 | 33 | 38 vs 7,178 |

The state counts are identical: 2^k+1 (one per subset of classes seen, plus dead). That's expected, since the minimal DFA is a property of the language, and canonicalised derivatives reach it from either encoding. The difference is that each union-form state is an expression **190× larger** at k = 5, and building a state costs time proportional to its size.

Adding an exact length L makes it worse. Without `&`, each ordering has to spell out every split of the L−k free characters, giving k!·C(L,k) alternatives: **3,024** for k = 4, L = 9 and **32,760** at L = 15. The paper's benchmark has RE2 and Rust "hitting a wall at 9 characters" and Hyperscan rejecting the pattern at 10. My guess is that this is expression and NFA size rather than DFA states. The intersection-form DFA in my build grows only linearly: 113 states at L = 8, 145 at L = 10, 305 at L = 20.

## Finding 2: the loop-subsumption rule turns exponential into polynomial

Figure 4 of the paper lists the rewrites applied at construction time. One of them merges repeat ranges over a shared tail: `X{l,m}T | X{k,n}T → X{l,max(m,n)}T` whenever the count ranges overlap. Without it, each new `\s` that a window like `\s+_{0,k}` absorbs adds another counter copy to the union. I ablated it on a scaled-down version of rebar's `context` benchmark, `[A-Za-z]{2}\s+_{0,k}Res_{0,k}\s+[A-Za-z]{2}`:

| k | states, rule on | states, rule off |
|---|---|---|
| 5 | 69 | 115 |
| 10 | 314 | 1,259 |
| 14 | — | 6,845 |
| 20 | 1,479 | >50,000 |
| 100 | 43,199 | — |

With the rule off, the count grows about 1.5× per unit of k. With it on, growth is roughly quadratic, approaching 4.3k² at large k, because two bounded windows need two counters. States also stay small (at most 39 nodes). The paper credits this rule for RE# being >8× faster than other automata engines on the full `context` pattern; the ablation shows it decides whether the automaton is polynomial at all.

## Finding 3: all-matches is still quadratic, and the paper says so

Theorem 4 promises linear time for a *single* match. For all matches, the paper admits the procedure "may in the worst case be quadratic". The smallest case I found was `a*b|a` on aⁿ:

| n | matches | derivative steps | steps / n² |
|---|---|---|---|
| 100 | 100 | 5,150 | 0.515 |
| 400 | 400 | 80,600 | 0.504 |
| 1,600 | 1,600 | 1,282,400 | 0.501 |

From each start, the forward pass scans to the end of input to rule out `a*b`, then reports a one-character match. With a `b` every 50 characters the cost drops to a flat 2.02 steps per character: the quadratic term is how far the forward pass travels before its state dies. Rebar's `quadratic` benchmarks target this behaviour. The paper says RE# looks near-linear on them because it spots the pattern algebraically and resolves each match in a fixed number of input-parallel steps. Hyperscan sidesteps it with earliest-match semantics. If you need leftmost-longest all-matches, budget for quadratic on adversarial input.

## A semantic trap: `~` applies to the span

The paper's Table 1 reads `~(_*R_*)` as "does not contain R". That holds only for the matched substring itself. Run `~(_*and_*)` alone over `"bandana and"` and you get four matches: `ban`, `dana an`, `d` and an empty match at the end. The engine cut the word around the forbidden substring, because each piece, taken alone, lacks `and`. Requiring word letters at both ends removes the junk but still yields `ban` and `dana an`. That's why the paper's author-search example also needs `\b…\b` lookarounds. Complement constrains what is inside the span; the context around the span is the job of lookarounds.

## What carries the weight

- **The algebra is free.** `&` and `~` are a few lines in the derivative function, and reversal commutes with both. A from-scratch build matches the formal semantics on every case of a 9,000-case differential test.
- **Canonicalisation is the engine.** ACI forms make encodings converge on the minimal DFA; loop subsumption keeps counters polynomial.
- **Intersection makes states smaller, not fewer.** On the password filter, `&` doesn't reduce the number of DFA states (no encoding can go below the minimal DFA), but it keeps each state about 190× smaller as an expression.
- **The cost model is unchanged.** Single match is linear and all-matches can be quadratic, as in RE2 and Rust `regex` today.

The pitch, writing `(.*[a-z].*)&(.*[A-Z].*)&(.*\d.*)&\S*` instead of a factorial union, holds up: in every test I ran, the extended syntax cost nothing in correctness or asymptotics.
