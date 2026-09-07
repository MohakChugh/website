---
title: "Diskless Kafka: What Happens When the Log's Replication Protocol Becomes a PUT"
date: 2026-09-07
tags: [kafka, distributed-systems, object-storage, streaming, cost-optimization]
excerpt: "KIP-1150 and KIP-1163 propose a leaderless Kafka topic type where any broker accepts produces, batches from many partitions share one WAL object, and a batch coordinator assigns offsets after upload. I worked through the design and ran the cost model: the cross-AZ advantage converges to ~41x on AWS, and the KIP's own P50 latency target carries ~2x headroom over the sum of its stated components."
---

Kafka's replication protocol was designed for an environment where the network between replicas was free and disks were the scarce resource. In the cloud that inverts: EBS is cheap and durable enough, but every gigabyte a leader ships to its two followers in other availability zones costs real money — $0.02/GiB on AWS, $0.01 on GCP, per the numbers [KIP-1150](https://cwiki.apache.org/confluence/display/KAFKA/KIP-1150%3A+Diskless+Topics) cites. For a busy cluster, inter-AZ replication is routinely the dominant line item, bigger than the brokers themselves. WarpStream and AutoMQ built businesses on this observation; KIP-1150 ("Diskless Topics") and its companion [KIP-1163](https://cwiki.apache.org/confluence/display/KAFKA/KIP-1163%3A+Diskless+Core) ("Diskless Core") are the proposal to fold the idea into Apache Kafka itself, as a per-topic opt-in that coexists with classic topics in the same cluster.

The name undersells the interesting part. The design doesn't just move segments to S3 — tiered storage (KIP-405) already does that for cold data. It removes the *leader* from the write path, and that forces a rethink of the one thing a Kafka leader fundamentally provides: a total order per partition.

## The write path: upload first, order later

In a classic topic, the partition leader does everything in sequence: validate the batch, assign offsets, write to its local log, wait for followers to replicate, acknowledge. Ordering and durability are fused in one broker, which is exactly why every producer must route to the leader — and why a producer in AZ-a writing to a leader in AZ-b pays cross-AZ tax before replication even starts.

Diskless topics split that fusion into two phases:

1. **Durability without order.** Any broker accepts Produce requests for any diskless partition. The broker buffers incoming batches — up to 250 ms or 4 MiB, whichever comes first (`diskless.append.commit.interval.ms`, `diskless.append.buffer.max.bytes`) — and packs batches from *many topics and partitions* into a single shared WAL segment object. That object gets a UUID name and is PUT to object storage with zero cross-broker coordination. At this point the data is durable but has no offsets.

2. **Order without data movement.** The broker then commits the batch *coordinates* — object ID, byte ranges, partition IDs — to a batch coordinator. The coordinator appends the coordinates to its own log, assigning each batch its global offset in each partition, and only then does the broker acknowledge the producers.

The two-phase split is the whole trick. Object storage is very good at durably storing large blobs and very bad at fine-grained ordered appends; a coordinator log is very good at ordering small metadata records and would melt if you pushed data through it. Each does only what it's good at. Brokers may upload multiple WAL objects in parallel but must commit them to the coordinator in order, so per-producer ordering survives.

Two consequences worth noticing. First, the number of objects scales with *aggregate throughput*, not partition count — a cluster with 50,000 mostly-idle partitions writes the same handful of objects per second as one with 50. Mixing partitions into shared segments is what makes S3 request pricing survivable. Second, a WAL object is immutable and its batches carry no final offsets; the KIP specifies that offsets and timestamps are injected later, by replicas at fetch time or during compaction into classic-format segments, so consumers see byte-identical batch encodings either way.

## Failure semantics fall out cleanly

What happens if a broker uploads an object and dies before committing coordinates? Nothing, semantically: the object is unreferenced garbage, cleaned up asynchronously, and the producer times out and retries through any other broker. With idempotent produce enabled, the coordinator deduplicates on (producer ID, epoch, sequence) exactly as a leader would — the KIP moves leader-local idempotence state into the coordinator. This is a nicer failure story than classic Kafka's, where an ack'd-but-unreplicated write depends on the ISR dance. Here the commit point is a single metadata append; either the coordinates landed or they didn't.

The cost is latency, and the KIP is refreshingly explicit: buffering up to 250 ms, upload P50 ~100 ms / P99 ~200–400 ms, coordinate commit P50 ~10 ms / P99 ~20–50 ms, for a target produce latency of **P50 ~500 ms, P99 ~1–2 s**. Summing the stated component P50s gives ~235 ms (expected buffer wait ~125 ms + 100 + 10), so the 500 ms target carries roughly 2x headroom — presumably for coordinator queueing and the commit-in-order constraint serializing a slow upload behind its predecessors. Either way, this is two orders of magnitude above a tuned classic topic's single-digit-millisecond acks. That's why it's per-topic: clickstream and logs take the deal; a change-data-capture feed driving a cache probably doesn't. KIP-1269 adds more in-flight requests per producer so pipelining can hide the per-request latency for throughput-bound workloads.

## Reads: the disk demoted to a cache

Brokers still have disks; "diskless" means the disk is no longer *authoritative*. Replicas tail the coordinator's log, download newly committed batches from object storage, inject offsets, and append to local segments that function purely as cache — safe to lose, because S3 is the source of truth. A warm replica serves Fetch requests from local data exactly like a classic follower. Only when a consumer asks for data older than the local cache, or the replica lags far behind, does the broker issue ranged GETs directly against the WAL objects (batches are grouped contiguously per partition within each object precisely so one partition's data comes back in few ranged reads).

Cross-AZ savings on the client side need one more piece, because there's no leader to be rack-local to. Metadata v14 adds a `RackId` request field and `PreferredProduceBrokers` in the response, steering producers to same-AZ brokers; consumers reuse the existing KIP-392 follower-fetch machinery. There's even a compatibility hack for old clients: append `,diskless_rack_id=<az>` to your `client.id` and the broker rewrites the metadata response's leader to a same-rack replica.

## The cost model, run honestly

I put the AWS numbers into a small model: RF=3 across three AZs, replication shipping two cross-AZ copies at $0.02/GiB plus non-rack-aware producers crossing AZs two-thirds of the time, versus diskless paying $0.005 per thousand PUTs at one 4 MiB object per 250 ms minimum, with 10% of consumer reads going to S3 directly.

| Ingress | Classic cross-AZ | Diskless requests | Ratio |
|---------|-----------------:|------------------:|------:|
| 1 MB/s | $135/mo | $52/mo | 2.6x |
| 10 MB/s | $1,350/mo | $52/mo | 26x |
| 100 MB/s | $13,500/mo | $327/mo | 41x |
| 500 MB/s | $67,500/mo | $1,633/mo | 41x |

The ratio converges to ~41x because both sides eventually scale linearly: classic pays an effective $0.053/GiB in transfer while diskless pays ~$0.0013/GiB in PUTs once segments fill to 4 MiB. Below ~3 MB/s of ingress the advantage shrinks fast — the 250 ms flush floor costs a fixed ~$52/month per uploading broker regardless of volume, which is also a hint that very-low-traffic diskless topics want longer commit intervals. And the model deliberately omits diskless's remaining costs (coordinator replication is still cross-AZ, though it's metadata-sized) and classic Kafka's mitigations — if you're on Azure, where the KIP notes inter-AZ transfer is free, the entire economic argument evaporates and you'd be paying the latency for nothing.

The deeper pattern here is one we keep re-learning: **separating the data plane from the ordering plane**. Neon does it for Postgres WAL, disaggregated LSM stores do it for compaction, and the batch coordinator is Kafka's version — the partition leader was never really about storing bytes, it was about sequencing them, and once you see that, the bytes can go anywhere cheap. The open question, deferred to KIP-1164, is whether the coordinator itself — one logical sequencer now in the commit path of every diskless produce in the cluster — scales past the very throughput ceiling that leaderless data movement just removed.
