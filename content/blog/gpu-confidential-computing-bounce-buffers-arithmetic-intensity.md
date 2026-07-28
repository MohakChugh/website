---
title: "GPU Confidential Computing: Why the Same Hardware Costs 7% or 41x"
date: 2026-07-28
tags: [gpu, confidential-computing, tee, llm-inference, security]
excerpt: "Two measurement studies on Hopper-class GPU TEEs report overheads of under 7% and up to 41.6x. Both are correct. The entire gap is explained by one number in NVIDIA's own documentation: the encrypted CPU-GPU path moves about 4 GB/s, against a device that does roughly 990 TFLOP/s. That ratio gives you a break-even arithmetic intensity, and it tells you in advance which workloads survive encryption and which ones fall off a cliff."
---

Confidential computing on GPUs is the rare security feature that ships with a plausible claim of near-zero cost. NVIDIA's H100 documentation states that in CC-On mode, raw compute throughput and HBM bandwidth are unchanged from normal operation. A 2024 benchmark study of LLM inference on Hopper found the overhead "remains below 7%" for most requests, with larger models and longer sequences approaching zero. That is a remarkable result for a feature that encrypts everything crossing the device boundary.

Then a 2025 characterization of distributed data-parallel training on the same class of hardware measured runtime per iteration increasing "by an average of 8x and up to a maximum of 41.6x" with four GPU TEEs.

Both numbers are real. Neither paper is wrong. Understanding why they diverge by three orders of magnitude is the difference between deploying GPU TEEs successfully and discovering the problem in production.

## What is actually inside the trust boundary

The design decision that governs everything: the trusted region is the GPU package itself, chip plus on-package HBM. NVIDIA's rationale for leaving HBM in the clear is explicitly a threat-model judgment, that on-package memory "is considered secure against everyday physical attack tools." So compute engines execute plaintext code on plaintext data resident in device memory. No encryption in the inner loop, no bandwidth tax on HBM. That is where the "compute is unchanged" claim comes from, and it is honest.

The consequence is that the boundary sits at the PCIe bus, and the CPU side of that boundary is a confidential VM whose memory the GPU is not permitted to read. AMD SEV-SNP and Intel TDX both block device DMA into private guest memory. So a bounce buffer appears:

1. The NVIDIA driver, itself running inside the CPU TEE, allocates a buffer in *shared* (non-private) system memory that the GPU can reach.
2. Data is encrypted and authenticated by the CPU into that buffer.
3. The GPU's security engine decrypts on ingress into HBM. Egress runs in reverse.

This applies to more than tensors. Command buffers and CUDA kernels are encrypted and signed before crossing PCIe. Synchronization primitives, exception metadata, and other driver structures are encrypted too, specifically to deny side channels on user data. Unified Memory follows the same rule: every page migrating over the non-secure interconnect is encrypted by the UVM manager.

Two operational details matter more than they first appear. First, initialization order: firmware scrubs GPU state and memory, configures a hardware firewall, and only *then* enables PCIe. Teardown is a function-level reset plus another scrub. Second, in CC-On mode all performance counters are disabled to prevent their use as a side channel. Your profiler stops working. That is why a third mode, CC-DevTools, exists, mirroring the CC workflow with protections off and counters on. Plan for the fact that the mode you profile is not the mode you ship.

## The one number that predicts everything

NVIDIA states the interconnect is "limited by CPU encryption performance, which we currently measure at roughly 4 GBytes/sec." That is the whole story. Compare it against the device it feeds:

| Path | Bandwidth |
|---|---|
| H100 HBM3 | ~3.35 TB/s |
| PCIe Gen5 x16, no CC | ~64 GB/s |
| Encrypted bounce buffer path | ~4 GB/s |

Now turn it into a decision rule. A kernel is compute-bound when its arithmetic intensity, FLOPs per byte moved, exceeds the ratio of peak compute to the bandwidth of the relevant path. For dense BF16 on H100 at roughly 990 TFLOP/s:

```python
PEAK_FLOPS   = 990e12   # H100 SXM, dense BF16
BW_HBM       = 3.35e12  # inside the trust boundary
BW_CC_PCIE   = 4.0e9    # encrypted bounce buffer path

def break_even(bw):
    """FLOPs per byte needed to hide transfer under compute."""
    return PEAK_FLOPS / bw

print(f"HBM ridge point:     {break_even(BW_HBM):>10,.0f} FLOP/byte")
print(f"CC PCIe ridge point: {break_even(BW_CC_PCIE):>10,.0f} FLOP/byte")
# HBM ridge point:            296 FLOP/byte
# CC PCIe ridge point:    247,500 FLOP/byte
```

Encryption moves the ridge point by a factor of ~840. Any stage of your pipeline whose arithmetic intensity *across the host boundary* sits below ~250k FLOP/byte becomes bounce-buffer-bound, and everything above it is free.

That threshold sounds impossible until you evaluate it on real workloads.

## Why inference is nearly free

Take prefill for an 8B-parameter model on a 1,000-token prompt. Bytes crossing PCIe: token IDs in, on the order of 4 KB. FLOPs: roughly `2 * params * tokens`.

```python
def intensity(params, tokens, bytes_in):
    flops = 2 * params * tokens          # fwd pass, MAC = 2 FLOPs
    return flops / bytes_in

print(f"{intensity(8e9, 1_000, 4_000):,.0f} FLOP/byte")   # 4,000,000,000
```

Four billion FLOPs per byte, against a threshold of 247,500. Prefill clears it by four orders of magnitude. The model weights never cross PCIe during steady-state serving, they are resident in HBM. Decode moves a handful of bytes per step for many gigaflops of work. This is exactly why the benchmark study found overhead below 7% and shrinking as models and sequences grow: bigger model means more FLOPs per identical byte of prompt. The security tax is levied on a resource the workload barely uses.

The residual few percent is latency, not bandwidth. Every launch pays encryption and authentication on command buffers, so small-batch, short-sequence, high-request-rate serving sees the worst of it. The mitigation is the same one that helps in the clear, amortize fixed per-launch cost over larger batches, which is why the overhead curve improves with scale rather than degrading.

## Why distributed training falls off a cliff

Data-parallel training inverts the ratio, because the bytes that dominate are not inputs, they are gradients, and they cross the boundary every iteration.

Ring all-reduce over `N` GPUs moves approximately `2 * (N-1)/N * S` bytes per GPU for a gradient buffer of `S` bytes. Under a GPU TEE, each scatter-reduce and all-gather hop leaves the trust boundary, so every hop pays encryption plus MAC generation at the sender and decryption plus verification at the receiver. Cost grows with GPU count.

```python
def allreduce_crypto_seconds(params, n_gpus, dtype_bytes=2, bw=4.0e9):
    grad_bytes = params * dtype_bytes
    moved = 2 * (n_gpus - 1) / n_gpus * grad_bytes
    return moved / bw

for n in (2, 4, 8):
    s = allreduce_crypto_seconds(1e9, n)
    print(f"N={n}: {s*1e3:8.0f} ms of crypto-bound all-reduce per iteration")
# N=2:      500 ms
# N=4:      750 ms
# N=8:      875 ms
```

For a 1B-parameter model whose uncontended iteration takes on the order of 100 ms, several hundred milliseconds of serialized crypto-bound communication per step lands you squarely in the 8x-average regime the characterization paper reports, and the 41.6x tail is what happens when larger models trigger more asynchronous all-reduce calls that no longer overlap with compute. This is a back-of-envelope reconstruction, not a replication of their setup, but it lands in the right order of magnitude for the right reason: collectives are the one part of ML that is intrinsically low arithmetic intensity across the device boundary, and GPU TEEs price exactly that.

## Attestation is the part you can actually get wrong

Performance is a capacity-planning problem. Attestation is a correctness problem, and it is where deployments silently lose the property they paid for.

The chain has three links: secure measured boot, an SPDM session binding the GPU to the driver inside the CPU TEE, and a signed attestation report. Device identity rests on an ECC-384 key pair whose private half is burned into fuses at manufacture, with the certificate chaining to NVIDIA's CA and revocation checked over OCSP.

The failure mode is treating this as a health check. Running the workload first and verifying afterward means you have already shipped plaintext weights into a device you had not authenticated. Verification must gate admission:

```python
# Shape of the nv_attestation_sdk flow; exact surface tracks the SDK version.
import secrets
from nv_attestation_sdk import attestation

client = attestation.Attestation()
client.set_name("inference-node-1")
client.set_nonce(secrets.token_hex(32))        # freshness: never reuse
client.add_verifier(
    attestation.Devices.GPU,
    attestation.Environment.REMOTE,            # NRAS; LOCAL only if air-gapped
    "https://nras.attestation.nvidia.com/v1/attest/gpu",
    "",
)

if not (client.attest() and client.validate_token(policy)):
    raise SystemExit("attestation failed: refusing to release key material")

decrypt_and_load_weights(kms.unwrap(key_id))   # only reachable post-verify
```

Two things to hold onto. The nonce must be fresh per attestation or a captured report replays forever. And local verification, while supported for air-gapped cases, carries NVIDIA's own caveat that revocation and verifier-integrity data may be stale, which is a real weakening of the guarantee, not a formality.

## The rule of thumb

Compute the arithmetic intensity of every stage that crosses the host boundary. Above ~250k FLOP/byte, encryption is close to free and you should turn it on. Below it, the ~4 GB/s encrypted path is your effective bandwidth, and you should either keep that stage inside the trust boundary or expect a multiple, not a percentage.

Single-node LLM serving happens to sit on the comfortable side of that line by four orders of magnitude, which is why GPU confidential computing arrived looking cheap. Distributed training sits on the other side. Same silicon, same feature flag, and a ratio you can evaluate on a napkin before you provision anything.
