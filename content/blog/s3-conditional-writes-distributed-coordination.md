---
title: "S3 Conditional Writes: The CAS Primitive That Killed the Coordination Sidecar"
date: 2026-07-07
tags: [distributed-systems, object-storage, databases, consistency, s3]
excerpt: For years, every database built on object storage needed a DynamoDB table or a ZooKeeper cluster on the side just to answer "who is the writer?" In late 2024, S3 quietly shipped If-Match and If-None-Match support on PutObject, turning the object store itself into a compare-and-swap register. Here is why that one HTTP header changes how you architect storage systems, and how projects like SlateDB use it for formally verified writer fencing.
---

## The sidecar tax

The economics of building a database directly on object storage have been obvious for a decade: eleven nines of durability, no cross-AZ replication traffic, storage that costs 2 cents per GB-month, and compute you can scale to zero. Snowflake proved the model for analytics; a new generation of systems (WarpStream, Turbopuffer, SlateDB, Neon's pageserver lineage) is proving it for streams, vectors, and OLTP-ish key-value workloads.

But until recently, every one of these systems carried the same embarrassing appendage: a strongly consistent metadata store bolted onto the side. Delta Lake on S3 required a DynamoDB table to commit transactions. WarpStream ran a custom metadata service. Kafka tiered-storage designs kept ZooKeeper or KRaft in the hot path. The object store held 99.9% of the bytes, and a completely separate distributed system existed to arbitrate writes to the other 0.1%.

The reason was simple: S3's `PutObject` was last-writer-wins. Two clients racing to write `manifest/current` would both receive `200 OK`, and one of them would silently lose. Without an atomic read-modify-write primitive, you cannot do leader election, you cannot fence a zombie writer, and you cannot commit a transaction log. So everyone rented consensus from somewhere else.

That changed in two steps. In August 2024, S3 shipped `If-None-Match: *` on `PutObject`, put-if-absent. In November 2024, it added `If-Match: <etag>`, put-if-unchanged, on `PutObject`, `CompleteMultipartUpload`, and later `CopyObject`, with conditional deletes following. Google Cloud Storage had generation preconditions for years and Azure Blob had ETag conditions, so S3 was the laggard, but S3 is where the ecosystem lives. The day it landed, the object store became a linearizable compare-and-swap register.

## What you actually get

The mechanics are plain HTTP conditional request semantics (RFC 9110), applied to writes:

```
PUT /bucket/manifest/current HTTP/1.1
If-Match: "3f8b9c2d1e0a..."   # succeed only if current ETag matches
```

- `If-None-Match: *` — the write succeeds only if no object exists at the key. Failure returns `412 Precondition Failed`.
- `If-Match: <etag>` — the write succeeds only if the object's current ETag equals the supplied value. If another writer got there first, you get `412`.
- If two conditional writes race, S3 serializes them: one wins, the other gets `409 ConditionalRequestConflict` and should re-read and retry.

Both operations are free (you pay normal request rates, including for failed requests) and work in all regions, on general purpose and directory buckets.

Combined with S3's strong read-after-write consistency (shipped December 2020, and the unsung prerequisite for all of this), you now have exactly the register semantics that the classic lock-free literature assumes: read the current value and its version tag, compute a new value, write it back conditionally, retry on conflict.

## Recipe 1: put-if-absent as a commit protocol

The simplest pattern is a monotonic log where each committer claims the next slot. This is how Delta Lake commits work, and with `If-None-Match` the DynamoDB lock table disappears entirely:

```python
def commit(s3, bucket, log_prefix, payload, version):
    key = f"{log_prefix}/{version:020d}.json"
    try:
        s3.put_object(
            Bucket=bucket, Key=key, Body=payload,
            IfNoneMatch="*",
        )
        return version                    # we own this slot
    except s3.exceptions.ClientError as e:
        code = e.response["ResponseMetadata"]["HTTPStatusCode"]
        if code in (409, 412):
            raise CommitConflict(version) # someone else committed; rebase and retry
        raise
```

Delta Lake 3.x's S3 committer adopted exactly this, and the `delta-rs` Rust implementation dropped its DynamoDB requirement. The transaction log is just numbered objects, and the object store itself guarantees that version N has exactly one author. Optimistic concurrency, zero extra infrastructure.

There is one sharp edge worth knowing: retry semantics. If your `PutObject` with `If-None-Match: *` succeeds but the response is lost (timeout, connection reset), the SDK retry will get a `412`, because the object now exists, written by you. A `412` on retry is therefore ambiguous: either you lost the race or you won it and didn't hear back. The fix is to make the payload self-identifying (embed a writer UUID) and, on `412`, read the object back and check whether you wrote it. CAS gives you atomicity, not exactly-once acknowledgement.

## Recipe 2: If-Match as writer fencing

Put-if-absent handles append-only logs. `If-Match` handles the harder problem: a mutable pointer with a single logical owner, which is the core of every LSM-on-object-storage design.

SlateDB, an embedded LSM engine that persists directly to S3 with a zero-disk architecture, is the cleanest public example. It maintains a manifest object that describes the current state of the tree (which SSTs exist, which WAL segments are live) plus a monotonically increasing writer epoch. Its fencing protocol, which the project has model-checked, works like this:

1. A new writer reads the current manifest and its ETag.
2. It writes a new manifest with `epoch = old_epoch + 1`, conditioned on `If-Match: <etag>`.
3. If the CAS succeeds, it is the writer. Any older writer that later tries to update the manifest will fail its own `If-Match`, because the ETag it holds is stale.
4. WAL objects are also written with conditional puts keyed to the epoch, so a zombie writer that was network-partitioned cannot sneak stale data in behind the new leader's back.

This is textbook epoch-based fencing, the same idea as ZooKeeper's zxid fencing or Kafka's leader epochs, except the fencing token lives in the ETag and the arbiter is S3's own metadata layer. The failure mode that plagued every previous S3-native design (a paused-then-resumed process overwriting the manifest with stale state) is structurally impossible: the pause invalidates your ETag.

```rust
// sketch of the CAS loop at the heart of manifest updates
loop {
    let (manifest, etag) = read_manifest(&s3).await?;
    if manifest.writer_epoch > my_epoch {
        return Err(Fenced);            // someone newer took over
    }
    let next = manifest.apply(&mutation);
    match s3.put_conditional(&next, IfMatch(etag)).await {
        Ok(_) => return Ok(next),
        Err(PreconditionFailed) => continue,  // re-read, re-check epoch
    }
}
```

## What it does not give you

It is tempting to conclude that S3 is now a consensus service. It is closer to say it exports a single linearizable register per key, which is enough for a surprising amount of coordination but comes with real limits:

**Throughput.** A conditional write costs one PUT (~$5 per million) and S3 documents roughly 3,500 PUTs/sec per prefix. A hot manifest key contested by many writers will livelock into 409/412 retry storms. The pattern only works when contention is structurally rare, one intended writer with occasional failover, or committers that batch aggressively. WarpStream batches hundreds of Kafka produces into one object precisely for this reason.

**Latency.** Every CAS is a ~10 to 30 ms round trip to S3. You cannot put this in a per-request path; you put it in a per-epoch or per-batch path.

**No leases, no watches.** There is no TTL, no expiring lock, no notification when the register changes. A "lock object" written with `If-None-Match` and never deleted is held forever, which is exactly why the epoch/fencing pattern (where new writers overwrite rather than wait) is the right idiom and lock-with-timeout is not. If you need liveness detection or watches, you still want a real coordination service.

**ETag subtleties.** ETags are opaque version identifiers here, not content hashes. Multipart uploads and SSE-KMS produce ETags that are not MD5s, which is fine for CAS but breaks anyone using ETags for integrity checking. Use checksums for integrity and ETags for versioning; conflating them is a recurring bug.

## Why this matters architecturally

The deeper shift is about where consistency lives. The last decade of cloud storage design treated the object store as a dumb, eventually-coordinated byte sink and pushed all agreement into a separate control plane. Each system re-derived the same fencing and commit machinery on DynamoDB, etcd, FoundationDB, or Postgres, and each carried the operational weight of a second stateful system whose failure modes compound with the first.

Conditional writes collapse that stack for a specific but important class of systems: single-writer-per-shard engines with batch-oriented commit. That class turns out to include LSM trees, log-structured message queues, table-format transaction logs, and checkpoint/manifest pointers, which is most of the data infrastructure being built right now. The coordination sidecar is not dead for high-contention, low-latency, or lease-based workloads. But "we need DynamoDB because S3 can't CAS" is no longer true, and designs that internalized that constraint are worth revisiting.

One HTTP header, fifteen years late, and an entire architectural pattern quietly became legacy.

## References

- Amazon S3 conditional requests, AWS documentation (conditional reads, writes, and deletes)
- AWS What's New: S3 conditional writes (`If-None-Match`, Aug 2024; `If-Match`, Nov 2024)
- SlateDB documentation: manifest design and writer fencing protocol
- Delta Lake `S3DynamoDBLogStore` history and the conditional-write committer in delta-rs
- RFC 9110, HTTP Semantics, sections 13.1.1 to 13.1.2 (`If-Match`, `If-None-Match`)
