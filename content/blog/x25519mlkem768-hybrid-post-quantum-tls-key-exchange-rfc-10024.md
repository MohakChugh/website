---
title: "X25519MLKEM768: What Hybrid Post-Quantum Key Exchange Actually Puts on the Wire"
date: 2026-10-03
tags: ["cryptography", "tls", "post-quantum", "ml-kem", "networking"]
excerpt: "RFC 10024 standardizes the hybrid group most TLS 1.3 traffic already negotiates. I ran OpenSSL 3.6 locally to measure the 279→1457-byte ClientHello, test the FIPS 203 encapsulation-key check at its exact q boundary, watch implicit rejection return a valid-looking wrong secret, and confirm the 'reversed' share order with a parser that needs no private key."
---

# X25519MLKEM768: What Hybrid Post-Quantum Key Exchange Actually Puts on the Wire

Under "harvest now, decrypt later," a TLS session recorded today can be decrypted once a quantum computer can break its ECDH exchange. Forging a signature needs that machine at handshake time, so signatures can wait. Key exchange can't, which is why post-quantum key agreement shipped years before post-quantum certificates.

The deployed answer is a **hybrid**: run X25519 and ML-KEM-768 (FIPS 203, formerly Kyber) side by side and feed both secrets into the key schedule. The connection is safe if *either* primitive holds. Chrome turned on a draft Kyber hybrid by default in 2024 and moved to the final `X25519MLKEM768` codepoint later that year. Firefox, Go 1.24's `crypto/tls`, and OpenSSL 3.5+ followed. This year the IETF published it as **RFC 10024**, *Post-Quantum Traditional (PQ/T) Hybrid Key Agreement Mechanisms for TLS 1.3*.

This post skips the lattice math. It covers what the hybrid does to bytes, round trips, and failure modes, measured with OpenSSL 3.6.3 on an Apple M3 Pro against a local `s_server`.

## The three groups

RFC 10024 defines three `NamedGroup`s:

| Group | Codepoint | Client share | Server share | Shared secret |
|---|---|---|---|---|
| X25519MLKEM768 | 0x11EC | ek(1184) ‖ x25519(32) = 1216 B | ct(1088) ‖ x25519(32) = 1120 B | ss_mlkem ‖ ss_x25519 = 64 B |
| SecP256r1MLKEM768 | 0x11EB | P-256(65) ‖ ek(1184) = 1249 B | P-256(65) ‖ ct(1088) = 1153 B | ss_ecdh ‖ ss_mlkem = 64 B |
| SecP384r1MLKEM1024 | 0x11ED | P-384(97) ‖ ek(1568) = 1665 B | P-384(97) ‖ ct(1568) = 1665 B | ss_ecdh ‖ ss_mlkem = 80 B |

Only X25519MLKEM768 is marked Recommended. The draft-era Kyber codepoints (25497, 25498) are marked "D", meaning deprecated.

X25519MLKEM768 puts ML-KEM **first**, while the NIST-curve groups put ECDH first. The RFC says the reversal is "due to historical reasons". In practice the reason is FIPS. NIST SP 800-56C allows a hybrid secret `Z ‖ T` only when `Z`, the leading part, comes from an approved key-establishment scheme. P-256 ECDH is approved. X25519 is not, so ML-KEM has to lead. Byte order inside an HKDF input does nothing for security, but it decides whether a FIPS-validated module may use the group.

### Verifying the order without a private key

The order can be checked from a passive capture. An ML-KEM encapsulation key is 1152 bytes of packed 12-bit coefficients followed by a 32-byte seed. Every coefficient must be below q = 3329. A random 12-bit value is below q with probability 3329/4096 ≈ 0.813, so a misaligned 1152-byte window passes with probability about 0.813⁷⁶⁸ ≈ 10⁻⁶⁹:

```python
Q = 3329
def coeffs(b):                      # FIPS 203 ByteDecode_12: 3 bytes -> two 12-bit ints
    for i in range(0, len(b), 3):
        yield b[i] | (b[i+1] & 0x0F) << 8
        yield b[i+1] >> 4 | b[i+2] << 4

def ek_ok(ek):                      # FIPS 203 §7.2 type + modulus check, k = 3
    return len(ek) == 1184 and all(c < Q for c in coeffs(ek[:1152]))

share = bytes.fromhex(open("share.hex").read().strip())   # from s_client -trace
print(ek_ok(share[:1184]))   # ML-KEM first  -> True
print(ek_ok(share[32:]))     # X25519 first  -> False
```

On a real 1216-byte share from `s_client -trace`, the ML-KEM-first slice passes. The shifted slice has **156 of 768** coefficients ≥ q, close to the expected 768 × 0.187 ≈ 144.

## Cost 1: bytes

Here are the handshake message sizes from `s_client -trace`. The server is pinned to one group, and the client offers one key share:

| | ClientHello | ServerHello |
|---|---|---|
| X25519 | 279 B | 118 B |
| X25519MLKEM768 | 1457 B | 1206 B |

That is roughly 1.2 KB extra in each direction. Compute is cheap by comparison. `openssl speed` on the same machine:

```text
ML-KEM-768   keygen 65 µs   encaps 48 µs   decaps 74 µs
X25519       one ECDH op ~63 µs   (15.8k ops/s)
P-256        one ECDH op ~72 µs   (13.8k ops/s)
```

The server adds one 48 µs encapsulation to its two X25519 operations, and the client adds a keygen and a decapsulation. This is OpenSSL's portable C ML-KEM, and SIMD implementations are faster. CPU is not the cost that matters.

The size is what matters. A 1457-byte ClientHello sits in a 1461-byte handshake message inside a 1466-byte TLS record. Add 20 bytes of IPv4, 20 of TCP, and 12 of timestamps, and you get 1518 bytes: **it no longer fits in one 1500-byte-MTU segment.** Browser ClientHellos carry ALPN, GREASE, and often ECH, so they cross the boundary by a wider margin. For the first time, the ClientHello reliably spans two TCP packets. That exposed middleboxes that parse only the first packet, see a truncated ClientHello, and drop or reset the flow. These bugs were tracked at tldr.fail.

## Cost 2: round trips, and why OpenSSL sends two shares

TLS 1.3 clients guess which groups the server will pick and send shares for them. A wrong guess triggers a HelloRetryRequest, which costs an extra RTT and, with hybrids, 1.2 KB of wasted upload. With the server pinned to X25519 and only an ML-KEM share offered:

```text
ClientHello, Length=1465      # ML-KEM share, rejected
ServerHello, Length=84        # HelloRetryRequest
ClientHello, Length=281       # retry with X25519
ServerHello, Length=118
```

OpenSSL 3.5+ avoids this by default. Its default ClientHello (1513 B here) carries **two** key shares, X25519MLKEM768 and plain X25519, in a 1258-byte `key_share` extension. Against an X25519-only server it connects in one round trip. Hedging costs 36 bytes, while an HRR costs a full RTT. Browsers make the same trade.

## Cost 3: failure semantics you have to get right

ML-KEM brings two behaviors ECDH implementers haven't dealt with.

**The encapsulation-key check.** RFC 10024 requires the server to run FIPS 203 §7.2 on the client's key: re-encode the decoded coefficients and require a byte-for-byte match. That holds exactly when every coefficient is below q. On failure the server sends `illegal_parameter`. Without the check, a coefficient of 3329 + x and one of x would decode to the same polynomial, so two distinct wire encodings would be the same key, a quiet malleability that higher-level protocols may not expect. I patched the first coefficient of a real key and tried to load it:

```bash
$ openssl pkey -pubin -inform DER -in pk_3328.der -noout; echo $?
0
$ openssl pkey -pubin -inform DER -in pk_3329.der -noout; echo $?
1
```

The check is exact: q − 1 is accepted and q is rejected. OpenSSL enforces it at decode time, before encapsulation can run.

**Implicit rejection.** This one surprises people. ML-KEM decapsulation of a corrupted ciphertext **does not fail**. FIPS 203's Fujisaki–Okamoto transform decrypts to m′, re-encrypts, and compares. On mismatch it returns `K̄ = J(z ‖ c)`, a PRF of a secret seed `z` and the ciphertext. There is no error branch, and so no decryption-failure oracle, provided the final selection is constant-time:

```text
Decaps(dk, c):
    m'      = K-PKE.Decrypt(dk_pke, c)
    (K', r) = G(m' ‖ H(ek))
    K_bar   = J(z ‖ c)
    c'      = K-PKE.Encrypt(ek_pke, m', r)
    return  c == c' ? K' : K_bar     # must be a constant-time select
```

I flipped one bit of a 1088-byte ciphertext:

```bash
$ openssl pkeyutl -decap -inkey sk.pem -in ct_bad.bin -secret ss_bad.bin; echo $?
0
$ xxd -p ss_enc.bin  # 060a35eb2ee469b2...
$ xxd -p ss_bad.bin  # e118719de0c69d0a...   (identical on every rerun)
```

The exit code is 0, and the secret is wrong, plausible-looking, and deterministic. In TLS, the client simply derives a different handshake secret, and the failure shows up a few messages later as a `Finished` MAC mismatch (`decrypt_error`), not at the key share. Anyone debugging "handshake fails at Finished, only with PQ enabled" should keep this in mind. A hand-rolled implementation that returns early on `c != c'` reintroduces the oracle FO was designed to remove. Compilers have been caught turning "constant-time" selects back into branches, so audit the assembly.

## Why plain concatenation is a safe combiner here

The hybrid secret is just `ss_mlkem ‖ ss_x25519`. It goes in as the IKM of `HKDF-Extract` at the Handshake Secret stage, with no ciphertext or public key mixed in. Standalone hybrid KEMs such as X-Wing also hash in the X25519 ciphertext, public key, and a label, because a generic combiner can't assume the caller binds them.

TLS 1.3 already binds them: every traffic secret is `Derive-Secret(HS, label, transcript)`, and the transcript covers both full `key_share` blobs, so swapping the ML-KEM ciphertext changes every derived key. Concatenation is safe *inside TLS 1.3*. Reusing it in a protocol without transcript binding is a different, unproven construction.

## Takeaways for operators

- **The compute cost is noise; the byte cost is real.** Budget about 1.2 KB extra each way. Check that every L4/L7 device in the path reassembles a ClientHello split across two TCP segments, and test with a real hybrid ClientHello, not a synthetic one.
- **Send a fallback share.** A classical X25519 share costs 36 bytes and avoids an HRR round trip against servers that haven't upgraded.
- **Expect PQ failures to show up late.** A corrupted ML-KEM ciphertext fails at `Finished`, not at `ServerHello`. A rejected encapsulation key fails early with `illegal_parameter`.

The migration is mostly done. What remains are the operational edges: packet boundaries, HRR guesses, and a decapsulation designed never to fail loudly.
