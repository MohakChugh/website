---
title: "FROST (RFC 9591): Why Threshold Schnorr Needs Two Nonces and a Binding Factor"
date: 2026-10-29
tags: [cryptography, threshold-signatures, schnorr, distributed-systems, security]
excerpt: "RFC 9591 standardizes FROST, a two-round t-of-n Schnorr threshold signature whose output is an ordinary Schnorr signature. The core design choice is that each signer commits to two nonces, and the binding factor ρ_i ties every signer's nonce to the message and to everyone else's commitments. I implemented the secp256k1 ciphersuite from the spec and matched every Appendix E.5 test vector byte for byte. Below I walk through why the second nonce exists, what the hedged nonce function does and doesn't protect against, and why per-signer cost grows linearly with signer count."
---

# FROST (RFC 9591): Why Threshold Schnorr Needs Two Nonces and a Binding Factor

In June 2024 the IRTF CFRG published **RFC 9591**, "The Flexible Round-Optimized Schnorr Threshold (FROST) Protocol for Two-Round Schnorr Signatures." It turns Komlo and Goldberg's FROST paper (SAC 2020) into an interoperable spec with five ciphersuites: Ed25519, ristretto255, Ed448, P-256 and secp256k1.

The pitch: any `t` of `n` key-share holders can jointly produce a signature in two rounds, and **the result is a plain Schnorr signature**. A verifier can't tell that a threshold produced it. With the Ed25519 ciphersuite it verifies under RFC 8032. Threshold keys can be adopted without changing a single verifier.

The interesting part isn't the Shamir sharing. It's one easy-to-miss function, `compute_binding_factors`. Below I explain why it has to exist, using a from-scratch implementation checked against the RFC's test vectors.

## The protocol in one screen

Each participant `i` holds a share `sk_i = f(i)` of a degree-`(t−1)` polynomial with `f(0) = sk`, and the group key is `PK = sk·G`.

**Round one.** Each signer samples two nonces, a *hiding* nonce `d_i` and a *binding* nonce `e_i`, and publishes the commitments `(D_i, E_i) = (d_i·G, e_i·G)`.

**Round two.** The coordinator sends the message and the sorted commitment list `B` to the chosen signers. Each signer then computes:

```
ρ_j   = H1(PK || H4(msg) || H5(encode(B)) || j)      for every j in B
R     = Σ_j ( D_j + ρ_j · E_j )
c     = H2(R || PK || msg)
λ_i   = Lagrange coefficient of i over the signer set
z_i   = d_i + e_i·ρ_i + λ_i · sk_i · c
```

The coordinator sums `z = Σ z_i`, and `(R, z)` is a standard Schnorr signature: `z·G = R + c·PK`.

Here is the part of my Python implementation that does the work, written against §4.4–4.6 of the RFC:

```python
def binding_factors(PK, clist, msg):
    enc = b''.join(sc(i) + ser(D) + ser(E) for i, D, E in clist)
    pre = ser(PK) + H4(msg) + H5(enc)          # fixed-length prefix
    return {i: H1(pre + sc(i)) for i, _, _ in clist}

def group_commitment(clist, rho):
    R = None                                    # identity
    for i, D, E in clist:
        R = jadd(R, jadd(D, mul(E, rho[i])))
    return R

def sign(i, sk_i, PK, nonce, msg, clist):
    rho = binding_factors(PK, clist, msg)
    R   = group_commitment(clist, rho)
    lam = lagrange([j for j, _, _ in clist], i)
    c   = challenge(R, PK, msg)
    d, e = nonce
    return (d + e * rho[i] + lam * sk_i * c) % Q
```

For secp256k1, `H1`, `H2` and `H3` are `hash_to_field` with `expand_message_xmd(SHA-256)`, `L = 48`, and the domain-separation tags `"FROST-secp256k1-SHA256-v1" || "rho" | "chal" | "nonce"`. `H4` and `H5` are plain SHA-256 with the same context prefix. With about 120 lines of pure-Python Jacobian arithmetic, my implementation reproduces **every value in Appendix E.5**: hiding and binding nonces from the given randomness, both binding-factor inputs and outputs, both signature shares, and the final 65-byte signature `0205b6d0…dd97324`. The intermediate `binding_factor_input` bytes in the vectors catch serialization-order bugs early.

## Why one nonce isn't enough

The obvious "threshold Schnorr" has each signer publish one nonce commitment `R_i`, sets `R = Σ R_i`, and has each signer return `r_i + λ_i·sk_i·c`. That works when every signer is honest and runs one session at a time. It breaks when signers run many sessions concurrently, which any real signing service does.

The issue is ordering. Someone has to see the other commitments before sending their own, and a malicious participant or coordinator can choose its contribution *after* seeing the honest ones. That gives it control over the aggregate `R`, and therefore over the challenge `c` in each session. Drijvers et al. (IEEE S&P 2019) showed this breaks the security proofs of several two-round multi-signature schemes. Benhamouda, Lepoint, Loss, Orrù and Raykova (Eurocrypt 2021) then showed that the underlying problem, **ROS** (Random inhomogeneities in an Overdetermined Solvable system of linear equations), can be solved in *polynomial time* once the number of concurrent sessions exceeds roughly the bit-length of the group order. In practice that means a few hundred sessions for 256-bit curves. An adversary with enough concurrent sessions can combine the honest signer's responses into a valid signature on a message the honest signer never approved.

The root cause is linearity. Each honest response is affine in the challenge, with a nonce **fixed before the adversary picks anything**, and such responses can be recombined.

## What the binding factor changes

FROST breaks this in two steps.

1. **The binding factor depends on the whole commitment list and the message.** `ρ_i = H1(PK || H4(msg) || H5(B) || i)`. If any participant changes its own commitment, everyone's `ρ` changes in a way nobody can predict.
2. **The second nonce gives `ρ` something to multiply.** Signer `i`'s effective nonce is `d_i + ρ_i·e_i`, and its commitment is `D_i + ρ_i·E_i`. Since `ρ_i` is a hash output, an adversary who varies its own commitment to steer the challenge also moves the honest signer's effective nonce. That breaks the fixed-coefficient linearity ROS needs.

The original FROST paper argued security in a model that ruled out these concurrency attacks. Bellare, Crites, Komlo, Maller, Tessaro and Zhu (CRYPTO 2022, cited by the RFC as `[StrongerSec22]`) later gave a tighter treatment showing FROST is EUF-CMA secure under concurrent sessions, given the algebraic one-more discrete log assumption in the random oracle model. It's also why §7.2 rejects a single shared binding factor: it saves scalar multiplications but no longer binds the round-one signer set to the round-two set.

Two practical consequences for implementers:

- **Encode all of `B`, in canonical order.** The RFC requires the commitment list to be sorted by identifier and fully encoded (`identifier || D || E` per signer) under `H5`. Hashing only your own commitment, or only the message, gives up the property that makes FROST safe under concurrency.
- **Each signer must recompute `ρ`, `R` and `c` itself** from the list it received. A signer that trusts a coordinator-supplied `R` or `c` has reintroduced the problem.

## Nonce handling: what hedging buys

§4.1 generates each nonce as `H3(random_bytes(32) || SerializeScalar(sk_i))`. This is a hedge. If the RNG is *predictable* (biased, low-entropy, observable by an attacker), the nonce still depends on the secret share, so an outsider can't compute it.

Hedging does **not** cover an RNG that *repeats*, such as a VM snapshot restored twice. Then `nonce_generate` returns the same nonce pair every time, and §7.3 warns that nonce reuse enables key recovery. Two nonces don't make reuse safe:

- Never persist or restore round-one state. Signers **MUST** delete the nonce after `sign`.
- Treat snapshot/restore as an RNG reseed event.
- Optionally (the RFC's MAY), have the coordinator refuse duplicate commitments per group key.

## Cost: linear in signers, unless you batch

`compute_group_commitment` performs one variable-base scalar multiplication (`ρ_j·E_j`) per signer, and **every signer** computes it. My pure-Python timings (one core; absolute numbers are slow, the shape is what matters):

| signers (t) | per-signer `sign` | coordinator share checks | per share |
|---:|---:|---:|---:|
| 2 | 6.9 ms | 26 ms | 13.2 ms |
| 5 | 19.6 ms | 85 ms | 16.9 ms |
| 10 | 47.7 ms | 166 ms | 16.6 ms |
| 20 | 83.7 ms | 316 ms | 15.8 ms |
| 40 | 133 ms | 594 ms | 14.8 ms |

Per-signer signing grows linearly with `t`, so total work across the group is quadratic. The coordinator's per-share check from §5.4 (identifiable abort: `z_i·G == D_i + ρ_i·E_i + c·λ_i·PK_i`) is constant per share, so it's linear overall. Two things follow:

- **Use multi-scalar multiplication.** The RFC points at Pippenger-style multi-exponentiation for `Σ ρ_j·E_j`. Only the `E_j` terms carry scalars, so this is one MSM of size `t`.
- **Verify the aggregate first, shares only on failure.** One full signature check covers the happy path. Fall back to per-share checks only if it fails, to find the misbehaving signer. That's the identifiable-abort property FROST gives you in place of robustness.

## What FROST deliberately doesn't do

FROST has no **robustness**: one faulty signer aborts the session. **ROAST** (Ruffing et al., CCS 2022) wraps it to fix this. **Key generation** is left to a DKG or trusted dealer. FROST is not **post-quantum**. And its signatures are **not deterministic** like EdDSA's. The RFC notes that deterministic nonce derivation enables key recovery in multi-party discrete-log signatures, so don't "fix" this by reusing RFC 8032's nonce derivation.

## Takeaways

- The threshold is invisible to verifiers. That's why FROST is cheap to adopt.
- The second nonce and `ρ_i` are what make two-round threshold Schnorr safe under **concurrent** sessions. Have every signer recompute `ρ`, `R` and `c` itself.
- Hedged nonces guard against a predictable RNG, not a repeating one. Never restore round-one state.
- Batch the commitment sum with MSM, and check the aggregate signature before individual shares.
