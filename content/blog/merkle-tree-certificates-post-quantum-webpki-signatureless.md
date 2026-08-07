---
title: "Merkle Tree Certificates: Making Post-Quantum WebPKI Fit in the Initial Congestion Window"
date: 2026-08-08
tags: [cryptography, tls, post-quantum, webpki, protocols]
excerpt: "Post-quantum key agreement shipped quietly and now covers most of the web. Post-quantum certificates have not shipped at all, because swapping ECDSA for ML-DSA in a WebPKI handshake adds about 13 kB and drives the server's first flight straight through the initial congestion window. Merkle Tree Certificates replace every signature except the handshake one with a 736-byte inclusion proof, and in the best case with no signature at all. The mechanism is a careful argument about which facts a proof already pins down."
---

Post-quantum key agreement was the easy half, and it is essentially done. Over 50% of human-initiated traffic to Cloudflare used X25519MLKEM768 by the end of October 2025, Chrome and Firefox and OpenSSL and Apple's OSes all default to it, and 39% of the top 100k domains support it. It cost about 1.1 kB down and 1.2 kB up, roughly a 4% handshake latency regression by Chrome's measurement, and everyone decided to eat that.

Post-quantum *authentication* has shipped to precisely nobody. Not one publicly trusted post-quantum certificate is in production. The reason is arithmetic.

## The 13 kB problem

Count what a first-visit WebPKI handshake authenticates. The leaf certificate carries the site's public key plus a signature from the intermediate. The intermediate carries its public key plus a signature from the root, whose key is predistributed. `CertificateVerify` carries a handshake signature. Two Signed Certificate Timestamps carry two more signatures against predistributed log keys. That is **five signatures and two public keys**.

Today, with an RSA intermediate and an ECDSA leaf, that is 512 + 256 + 256 + 32 + 64 + 64 + 64 = **1,248 bytes**. Substitute ML-DSA-44 (1,312-byte keys, 2,420-byte signatures) throughout:

```
5 × 2420  +  2 × 1312  =  14,724 bytes
```

An increase of 13,476 bytes, better than 10×. One ML-DSA-44 public key alone outweighs every signature and key in the current handshake combined.

This is fatal rather than merely unpleasant because of TCP's initial congestion window. Cloudflare's 2021 experiment with artificially inflated chains found a steep latency cliff right around 10 kB, where the server's first flight no longer fits in the initial window and the handshake buys an extra round trip. Nine extra kilobytes cost about a 15% handshake slowdown; crossing the cliff can exceed 60%, erasing everything TLS 1.3 won over 1.2. Chrome's stated ceiling is a 10% regression, and PQ key agreement alone already spent 4% of it.

Take the median compressed chain today at 3.2 kB, add the 1,088-byte ML-KEM-768 server key share, and swap in ML-DSA-44 everywhere:

| Configuration | Auth bytes | Est. server flight | Over 10 kB? |
|---|---|---|---|
| Classical (RSA int + ECDSA leaf) | 1,248 | ~4,400 | no |
| All ML-DSA-44 | 14,724 | ~17,900 | **yes** |

There is no tuning your way out of that, which is why Chrome's position has been to fix the size problem *before* shipping PQ certificates rather than after.

## Stop signing, start proving

[Merkle Tree Certificates](https://datatracker.ietf.org/doc/draft-ietf-plants-merkle-tree-certs/) (draft-ietf-plants-merkle-tree-certs-01, February 2026, adopted by the IETF PLANTS working group) start from an observation about what those five signatures are *for*. Four of the five prove membership and logging, not liveness: the SCTs prove the certificate was logged, the CA signatures prove the CA issued it. Only `CertificateVerify` proves possession of the leaf key against a fresh nonce, and only that one genuinely needs a signature.

So MTC merges the certificate and its transparency log into one structure. The CA maintains an append-only RFC 9162 Merkle tree whose leaves are log entries, and a certificate's "signature" becomes an inclusion proof into that tree:

```c
struct {
    TrustAnchorID cosigner_id;
    opaque signature<0..2^16-1>;
} MTCSignature;

struct {
    uint64 start;
    uint64 end;
    HashValue inclusion_proof<0..2^16-1>;
    MTCSignature signatures<0..2^16-1>;
} MTCProof;
```

This `MTCProof` goes directly into the X.509 `signatureValue` BIT STRING with no extra ASN.1 wrapping, with `signatureAlgorithm` set to `id-alg-mtcProof`. The result is still an X.509 certificate, still validated by RFC 5280 path validation — MTC replaces only step (a)(1), signature verification, leaving expiry and name checks untouched. That is the deployment story: you are not asking the ecosystem for a new certificate format.

The `[start, end)` pair identifies a **subtree** rather than the whole tree. A subtree is valid when `0 <= start < end <= n` and `start` is a multiple of `BIT_CEIL(end - start)`. Full (power-of-two-sized) subtrees appear inside `MTH(D_n)` for every `n >= end`, so their hashes are stable forever once the tree grows past them; partial ones only exist at exactly `n = end`.

## The size argument, checked

The draft's proof sizes fall out of the CA's issuance rate. Assuming 7-day lifetimes with renewal at 75% of life, a Let's Encrypt-scale CA reissues about 4,400,000 certificates per hour. I recomputed both figures rather than take them:

```python
import math
H = 32                                    # SHA-256
rate = 4_400_000                          # certs/hour, one CA

span = rate / (3600/2)                    # checkpoint every 2s
print(math.ceil(math.log2(span)) * H)     # 384  (12 hashes)
print(math.ceil(math.log2(rate)) * H)     # 736  (23 hashes)
```

384 bytes for a full certificate's proof, 736 bytes for a subtree spanning a whole hour. Both match the draft exactly. Proof size grows logarithmically, so 32 hashes (1,024 bytes) covers subtrees up to 2^32 entries — enormous headroom.

736 bytes is already smaller than a *single* ML-DSA-44 signature, and 9.86× smaller than the three such signatures a post-quantum SCT setup needs. But a full certificate must still carry cosignatures to convince a relying party that the subtree root is authentic, and if those are ML-DSA-44 you have bought back 2,420 bytes.

## The signatureless mode

Here is the part worth stealing. If the relying party *already knows* the subtree root hash, the cosignature over it is redundant — the client can check the proof against state it holds. So the CA publishes **landmarks**: periodic checkpoints whose covering subtree hashes get predistributed to clients as trusted subtrees. Each landmark's trust anchor ID is `base_id` with the landmark number appended (`32473.1.42`), and clients fetch the active list from a `landmark_url`.

A certificate issued against a landmark subtree carries an inclusion proof and **zero signatures**. Verification is: evaluate the proof, compare the resulting root against the trusted subtree hash, done. No post-quantum signature verification anywhere in the certificate chain.

Adding it up for a signatureless leaf, including the `MTCProof` framing overhead the draft's headline figure omits:

```
MTCProof on wire:  8 + 8 + 2 + 736 + 2 + 2   =    758
leaf ML-DSA-44 key + CertificateVerify sig   =  3,732
                                              -------
total authentication                              4,490   (vs 14,724)
```

A 69.5% reduction, and an estimated server flight around 7.7 kB — back under the congestion-window cliff. The remaining 3,732 bytes is irreducible: the leaf's own key and the one signature that actually proves liveness.

The trade is issuance latency and client state. A signatureless certificate cannot exist until a landmark covering its entry is allocated, so hourly landmarks mean up to an hour's delay; CAs are expected to issue a full certificate alongside and serve whichever the peer supports. Client state is bounded at `2 * max_landmarks` hashes per CA.

## Three things I would flag to the authors

**The client-state worked example is off by one.** Section 6.3.2 says to set `max_landmarks = ceil(max_cert_lifetime / time_between_landmarks) + 1`. For the draft's own example — 7-day maximum lifetime, hourly landmarks — that gives `ceil(168/1) + 1 = 169`, so 338 hashes and 10,816 bytes. Section 6.3.1 states 168, 336 hashes, and 10,752 bytes, dropping the `+ 1`. Sixty-four bytes, so the consequence is nil, but the two sections disagree and the draft warns that an inaccurate `max_landmarks` means "some older certificates may fail to validate."

**`find_subtrees` holds up under exhaustive test.** The claim that one or two subtrees always cover any interval is load-bearing and non-obvious, so I ran all 35,999,900 intervals for trees up to 600 entries, checking every stated invariant: at most two subtrees, both structurally valid, contiguous (`left.end == right.start`), left always full, right no larger than the requested span, union covering the request. Zero violations. Worth noting that 89.8% of intervals need the covering subtrees to *overshoot* on the left — by design, but it means the "subtree" in a certificate is not the interval the CA had in mind.

**The single-pass verification recipe skips a step.** Section 7.2 offers a neat optimization: because `tbs_cert_entry_data` holds the *contents octets* of the DER `TBSCertificateLogEntry` with identifier and length stripped, you can hash the received `TBSCertificate` in one streaming pass, substituting the SPKI hash inline, without materializing the log entry. But `TBSCertificateLogEntry` omits two fields that `TBSCertificate` contains: `serialNumber` (authenticated instead by being the proof index) and the redundant `signature` AlgorithmIdentifier (checked for an exact value in step 1). The procedure's step 3 says to write "the TBSCertificate contents octets to the hash, up to the subjectPublicKeyInfo field" — sweeping both omitted fields in. On a real certificate:

```
$ openssl s_client -connect example.com:443 | openssl x509 -outform der \
    | openssl asn1parse -inform der -i

  version[0]              5 bytes
  serialNumber           18 bytes   <-- omitted from the log entry
  signature (AlgId)      12 bytes   <-- omitted from the log entry
  issuer                 83 bytes
  ...
```

A literal implementation folds 30 extra bytes into the hash and validates nothing. The prose elsewhere in the draft is unambiguous about both fields being omitted, so this is an editorial gap in one procedure rather than a design flaw — but it is exactly the kind of gap that yields two implementations that disagree.

## The transferable idea

MTC's central move is deciding which facts a proof *already pins down*, then refusing to spend bytes restating them. `serialNumber` is not hashed into the log entry because the serial number *is* the leaf index, and the inclusion proof cannot succeed at a different index. The `signature` field is not hashed because verification checks it for one exact value, so no other value is reachable. The subtree hash is not signed, in the best case, because the client already holds it.

That last one is the general pattern, the same shape as removing explicit certificates from BFT consensus: when a layer exists to *transmit* a fact the recipient can already *derive*, the layer is an encoding choice rather than a requirement. What you owe in exchange is a precise argument that derivation yields the same guarantee under an adversary — here, collision resistance plus the log's append-only property. Make that argument once and 10,234 bytes per handshake disappear.

Cloudflare and Chrome planned to trial MTC by the end of 2025. If it lands, post-quantum authentication ends up *smaller* on the wire than the RSA chains we ship today.
