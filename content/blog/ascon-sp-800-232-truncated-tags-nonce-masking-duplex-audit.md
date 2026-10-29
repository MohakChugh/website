---
title: "Ascon in NIST SP 800-232: What the Lightweight AEAD Standard Actually Promises"
date: 2026-10-29
tags: [cryptography, ascon, aead, nist, embedded]
excerpt: "NIST finalized SP 800-232 in August 2025, making Ascon the US lightweight-crypto standard. I implemented Ascon-AEAD128, Hash256 and XOF128 from the spec and passed all 3,139 reference KATs. Then I checked the fine print. The decryption-failure rule R5 works out to a fixed 2^-32 forgery budget per key, and it stops being the binding limit above 81-bit tags. With the 32-bit tags the standard allows, two keys that open the same ciphertext fell out of a birthday search after 102,725 trials. Nonce reuse leaks only up to the first differing block. On an M3 Pro, portable Ascon runs about 10× slower than AES-GCM."
---

# Ascon in NIST SP 800-232: What the Lightweight AEAD Standard Actually Promises

In August 2025 NIST published **SP 800-232**, "Ascon-Based Lightweight Cryptography Standards for Constrained Devices". That closed out the lightweight-cryptography competition Ascon won in 2023. The document specifies four algorithms on one 320-bit permutation: **Ascon-AEAD128**, **Ascon-Hash256**, **Ascon-XOF128** and **Ascon-CXOF128** (a customizable XOF).

It isn't a copy of the Ascon v1.2 submission. Byte order is now little-endian. AEAD128 takes the old Ascon-128a parameters with a new IV. Two implementation options were added, tag truncation and nonce masking, and both come with explicit numeric rules. I wrote the algorithms in 66 lines of Python straight from the spec. All 3,139 known-answer tests in the designers' reference repo pass: 1,089 AEAD, 1,025 Hash256 and 1,025 XOF128. With that implementation I checked what the rules actually guarantee.

## The permutation, measured

The state is five 64-bit words. Each round adds a constant, applies a 5-bit S-box across all 64 columns in bitsliced form, and then diffuses each word with its own pair of rotations:

```python
def perm(s, rounds):
    for c in RC[12 - rounds:]:          # RC = 0xf0, 0xe1, ..., 0x4b
        x0, x1, x2, x3, x4 = s
        x2 ^= c
        x0 ^= x4; x4 ^= x3; x2 ^= x1
        t0 = x0 ^ (~x1 & x2); t1 = x1 ^ (~x2 & x3); t2 = x2 ^ (~x3 & x4)
        t3 = x3 ^ (~x4 & x0); t4 = x4 ^ (~x0 & x1)      # Keccak's chi
        t1 ^= t0; t0 ^= t4; t3 ^= t2; t2 = ~t2 & M
        s = [t ^ ror(t, a) ^ ror(t, b) for t, (a, b) in
             zip((t0, t1, t2, t3, t4), [(19,28),(61,39),(1,6),(10,17),(7,41)])]
    return s
```

I computed the standard design metrics exhaustively instead of copying them from the paper:

| Component | Property | Value |
|---|---|---|
| S-box | max differential probability | 8/32 = 2^-2 |
| S-box | max absolute linear correlation | 16/32 = 2^-1 |
| S-box | differential branch number | 3 |
| each Σ_i | branch number (all inputs of weight ≤ 3) | 4 |
| each Σ_i^-1 | taps per output bit | 31–35 of 64 |

The last row is the useful one. Each Σ_i XORs three taps, but its inverse needs roughly half of all 64 input bits for every output bit. Ascon only ever runs the permutation forward, because duplex decryption doesn't need the inverse. Implementers get the cheap direction, and anyone trying to peel rounds off backwards gets the dense one.

## The mode: a keyed duplex with key XORs at both ends

AEAD128 initializes with `p^12(IV ‖ K ‖ N)` and XORs the key into the capacity afterwards. It then absorbs AD and plaintext in 128-bit blocks with `p^8` between blocks, and finalizes by XORing K in, running `p^12`, and XORing K into the tag. Cost in rounds:

```
rounds(AEAD128) = 24 + 8 * (AD blocks) + 8 * floor(|P| / 16)
rounds(Hash256) = 12 * (1 + ceil((|M|+1) / 8) + 3)      # init, absorb, 3 extra squeezes
```

At 0.5 rounds per byte against 1.5, Hash256 should cost 3× AEAD per byte. My C benchmark measured 7.55 against 2.52 ns/byte at 64 KiB, a ratio of 3.0. For a 16-byte message the 24 fixed rounds dominate: 32 rounds in total, so 2 rounds per byte. Small IoT payloads pay for initialization and finalization, not for data. The double key XOR also means recovering the mid-stream state doesn't hand over the key.

## Nonce reuse: the leak stops at the first differing block

SP 800-232 says nonce reuse "can" compromise confidentiality but claims "some resilience". I encrypted two-block message pairs under one key and nonce:

| Plaintext pair | block 1 leaks P⊕P′? | block 2 leaks P⊕P′? |
|---|---|---|
| same block 1, different block 2 | yes (C1 identical) | **yes** |
| different block 1, same block 2 | yes | no |
| different in both blocks | yes | no |

In a duplex the ciphertext block is fed back into the state, so the keystream depends on everything encrypted so far. A repeated nonce exposes the common prefix plus the XOR of the first block that differs. AES-GCM leaks every block under a repeated nonce, and one repeat also leaks the GHASH key, which enables universal forgery. Ascon's integrity claims survive limited misuse instead. Table 8 of the spec keeps min{128 − log2 u, λ} bits of integrity as long as each (N, A) pair repeats at most 2^8 times.

## Truncated tags: R5 is a fixed forgery budget

R4 allows tags as short as λ = 32 bits, and below 64 bits only "after a careful risk analysis". R5 caps decryption failures per key at 2^(λ−32). If you multiply out, every forgery attempt succeeds with probability 2^-λ, so at the cap:

```
P[any forgery] <= 2^(λ-32) * 2^-λ = 2^-32      for every λ
```

The rule is one invariant written as a family. Each key gets a 2^-32 total forgery budget, whatever tag length you pick. Even the relaxed λ = 32 case allows 2^0 = 1 failure, which is the same 2^-32.

R6 then caps total data per key, nonces included, at 2^54 bytes. Each decryption attempt carries a 16-byte nonce, so a key can see at most 2^50 attempts of any kind. That puts the crossover at λ − 32 = 50: **R5 is the binding limit only for tags of 81 bits or fewer**. At 82 bits they tie; above that, the data limit retires the key before the failure counter can fill.

### Commitment collapses with the tag

Ascon-AEAD128 was never designed to be key-committing. Two keys can open the same ciphertext as soon as their tags collide, and that's a generic birthday search over the tag. With full 128-bit tags it costs about 2^64. With the 32-bit tags R4 permits:

```python
seen, i = {}, 0
while True:
    K = i.to_bytes(16, 'big')
    _, tag = aead_enc(K, N, b'', None, taglen=4, dec_ct=C)   # decrypt-side tag
    if tag in seen: break
    seen[tag] = K; i += 1
```

On a fixed nonce and a fixed 16-byte ciphertext it found a collision after **102,725 keys in 16 seconds of pure Python** (the birthday expectation is about 82,000). Both keys accept `(N, C, tag=afba3979)` and decrypt it to different plaintexts. That's the building block of partitioning-oracle attacks (Len, Grubbs and Ristenpart, USENIX Security 2021). At 64 bits the search needs about 2^32 decryptions, roughly nine single-core minutes at my measured round cost with a memoryless rho search. If an attacker can influence key choice, add explicit key commitment.

## Multi-key and nonce masking

Across u independent keys, AEAD128 drops to 128 − log2 u bits. A fleet of 2^32 devices that ever share a nonce gives a 2^96 key-search target. Nonce masking fixes that: it takes a 256-bit key `K1 ‖ K2` and encrypts with `(K1, N ⊕ K2)`, which restores 128-bit multi-key security. The price: `(K ‖ K′, N)` and `(K ‖ K″, N′)` produce identical output whenever N ⊕ K′ = N′ ⊕ K″ (my implementation confirms it), so context commitment is gone by construction. R2 also makes the masked nonce a secret, so it can't be logged like a plain nonce.

## Where it sits on a server CPU

On an Apple M3 Pro I ran a straightforward portable C implementation built with `clang -O3`, which validates against the first KAT, against OpenSSL 4.0.3 on the same machine:

| 16 KiB messages | throughput | vs Ascon-AEAD128 |
|---|---:|---:|
| Ascon-AEAD128 (portable C) | ~370–397 MB/s | 1× |
| ChaCha20-Poly1305 (OpenSSL) | 960 MB/s | ~2.5× |
| AES-128-GCM (OpenSSL, AES/PMULL instructions) | 3,681 MB/s | ~10× |
| Ascon-Hash256 (portable C) | 130 MB/s | — |
| SHA-256 (OpenSSL, SHA instructions) | 1,964 MB/s | 15× Hash256 |

A single `p^12` took 62 ns, about 5.1 ns per round. Optimized builds will beat my code but are unlikely to close a 10× gap to dedicated AES hardware. That's expected. Ascon targets hardware without AES instructions: microcontrollers, RFID tags and small ASICs. There, a bitsliced, table-free round is fast, small in silicon, and easier to mask against side channels.

## Takeaways

- **Treat R5 as a 2^-32 per-key forgery budget.** Count decryption failures per key. Above 81-bit tags, the 2^54-byte data limit retires the key first.
- **Don't pair short tags with attacker-influenced keys.** At 32 bits, two keys that open the same ciphertext cost about 10^5 trials.
- **Nonce reuse leaks the common prefix plus one block XOR, not the whole stream.** Still never plan for it.
- **Nonce masking is for multi-key deployments that don't need commitment.** It costs 128 extra key bits and turns the nonce into a secret.
- **On servers with AES instructions, use AES-GCM or ChaCha20-Poly1305.** Ascon's case rests on cost per gate, not cost per byte.
