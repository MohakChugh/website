---
title: "CRDTs and Automerge 2.0: How Columnar Encoding Achieves 1000x Compression for Conflict-Free Collaboration"
date: 2026-07-09
tags: [distributed-systems, crdts, automerge, collaboration, encoding]
excerpt: "Conflict-Free Replicated Data Types promise coordination-free merging, but naive implementations explode in memory. Automerge 2.0's columnar encoding compresses operation histories by three orders of magnitude, making CRDTs practical for real-time collaborative editing at scale."
---

## CRDTs and Automerge 2.0: How Columnar Encoding Achieves 1000x Compression for Conflict-Free Collaboration

Collaborative editing is a distributed systems problem disguised as a UX feature. Every character typed, every cursor moved, every formatting change is a concurrent mutation to shared state across unreliable networks. Google Docs solves this with Operational Transformation (OT) and a central server that serializes all operations. But OT requires a single linearization point, which means the server is always in the critical path. What if you could merge edits from any replica, in any order, with no coordination, and always converge to the same result?

Conflict-Free Replicated Data Types (CRDTs) deliver exactly this guarantee through their mathematical structure. But until recently, the engineering reality was brutal: a CRDT document representing 100,000 characters of text could consume 500MB of memory, because every operation carried a globally unique identifier and a pointer to its causal predecessor. Automerge 2.0, released in late 2023, solved this with a columnar encoding scheme that compresses operation histories by 1000x, finally making CRDTs practical for production collaborative editors.

## The convergence guarantee

A CRDT satisfies one property: any two replicas that have seen the same set of operations will be in the same state, regardless of the order those operations were applied. There is no "conflict resolution" in the traditional sense. The data structure's merge function is associative, commutative, and idempotent.

For text editing, the standard approach is a sequence CRDT. Each character is assigned a unique identifier that encodes its position in the causal history. The two dominant families are:

**RGA (Replicated Growable Array):** Each element has a unique ID (timestamp, actorId) and a reference to the element it was inserted after. Deletion marks elements as tombstones rather than removing them.

**Yjs-style CRDT:** Uses a linked list of "items" where each item knows its left and right neighbors at insertion time, with conflict resolution based on actor ID ordering.

The fundamental operation set for a text CRDT is minimal:

```typescript
type Operation =
  | { type: 'insert'; id: OpId; after: OpId; value: char }
  | { type: 'delete'; id: OpId; target: OpId }

type OpId = { counter: number; actor: ActorId }
```

Every insert creates a new element positioned after an existing one. Every delete references the element to tombstone. The `OpId` is a Lamport timestamp: `(counter, actor)` pairs that form a total order. Two concurrent inserts at the same position are resolved deterministically by comparing actor IDs.

## The storage explosion problem

Consider a user typing 260,000 characters (a typical technical document). In a naive representation, you store one operation per character:

```
Operation 1: insert('H', after=ROOT, id=(1, actor_A))
Operation 2: insert('e', after=(1, actor_A), id=(2, actor_A))
Operation 3: insert('l', after=(2, actor_A), id=(3, actor_A))
...
```

Each operation carries: a type tag (1 byte), the inserted character (1-4 bytes), the operation's own ID (8+ bytes for counter + variable-length actor), and the predecessor's ID (another 8+ bytes). For 260K characters, you are looking at roughly 20-30 bytes per operation, totaling 5-8MB just for the operation log of a single-author document. With multiple collaborators, tombstones, and undo history, documents can reach hundreds of megabytes.

Martin Kleppmann's benchmarks on the real-time collaborative editing trace from the Automerge-perf dataset showed that Automerge 1.0 consumed 154MB to represent a document that stored as 127KB of plain text. The overhead factor was over 1200x.

## Automerge 2.0's columnar insight

The key observation is that operation logs have extreme structural regularity. When a user types sequentially, consecutive operations share almost all metadata:

- The actor ID is identical across all operations from the same session
- The counter increments by exactly 1
- The predecessor ID is the previous operation's ID (sequential insertion)
- The operation type is always "insert"

This is precisely the pattern that columnar encoding exploits in analytical databases. Instead of storing operations as rows (one record per operation), Automerge 2.0 stores them as columns (one array per field), then applies run-length encoding and delta encoding to each column independently.

The document format decomposes the operation log into separate columns:

```
┌─────────────────────────────────────────────────────┐
│ Column: objType   [RLE]  → [text, text, text, ...]  │
│ Column: action    [RLE]  → [insert, insert, ...]    │
│ Column: actor     [RLE]  → [A, A, A, ..., B, B, B]  │
│ Column: counter   [Delta]→ [1, 1, 1, 1, ...]        │
│ Column: predActor [RLE]  → [A, A, A, ...]           │
│ Column: predCtr   [Delta]→ [0, 1, 1, 1, ...]        │
│ Column: value     [Raw]  → ['H','e','l','l','o',...]│
│ Column: successor [RLE]  → [null, null, ...]         │
└─────────────────────────────────────────────────────┘
```

**Run-Length Encoding (RLE):** A column like `[insert, insert, insert, ..., insert]` (260K identical values) compresses to `(insert, 260000)`, consuming only a few bytes.

**Delta Encoding:** The counter column `[1, 2, 3, 4, ..., 260000]` becomes deltas `[1, 1, 1, 1, ...]`, which then RLE-compresses to `(1, 260000)`.

**The combined effect:** A sequential typing session of 260K characters compresses to roughly the size of the raw text plus a few hundred bytes of metadata. The 154MB Automerge 1.0 document shrinks to approximately 160KB in Automerge 2.0, a compression ratio exceeding 1000x.

## The encoding format in detail

Automerge 2.0's binary format uses a chunked structure. Each chunk contains a set of columns, where each column is encoded with one of four strategies:

```rust
enum ColumnEncoder {
    RawBytes,         // UTF-8 string values, no compression
    Uvarint,          // Unsigned LEB128 integers
    DeltaVarint,      // Signed deltas, LEB128 encoded
    BooleanRLE,       // Run-length encoded booleans
}
```

The column selection is determined by the data type of the field. For the operation counter (monotonically increasing integers), `DeltaVarint` produces runs of `1` that compress further. For the action column (enum values), `Uvarint` with implicit RLE produces single-byte representations of long runs.

A critical design choice: operations are sorted by (object, key, actor, counter) before encoding. This sort order maximizes run lengths, since operations on the same object by the same actor tend to be contiguous. The sort also enables binary search for random access into the operation log without decompressing the entire document.

## Handling the adversarial case

Columnar encoding exploits regularity. What happens when the editing pattern is adversarial, with many actors interleaving single-character edits?

In the worst case (N actors each inserting one character in round-robin), the actor column contains no runs, and compression degrades to approximately one byte per actor switch. However, real collaborative editing rarely looks like this. Empirical traces from shared documents show that even with 10+ concurrent editors, operations cluster by author in bursts of 5-50 characters. The columnar approach degrades gracefully rather than catastrophically.

Automerge 2.0 also introduces incremental saves. Rather than rewriting the entire columnar document on every edit, changes accumulate in an append-only "changes" section. Periodically, the document is compacted by re-sorting and re-encoding all operations. This amortizes the cost of maintaining optimal column encoding.

## Performance characteristics

Benchmarks on the Automerge-perf editing trace (Martin Kleppmann, 2023):

| Metric | Automerge 1.0 | Automerge 2.0 | Yjs |
|--------|---------------|---------------|-----|
| Document size | 154 MB | 160 KB | 128 KB |
| Load time | 5.3 s | 0.05 s | 0.02 s |
| Memory usage | 258 MB | 3.2 MB | 1.8 MB |
| Apply 1 op | 1.2 ms | 0.008 ms | 0.003 ms |

Yjs remains faster for raw operation throughput because its internal linked-list structure avoids the overhead of maintaining a sorted columnar log. But Automerge 2.0 closed the gap from 1000x slower to approximately 2-3x slower, while providing richer semantics (nested objects, multiple data types, branching/merging histories).

## Beyond text: nested CRDTs

Automerge's columnar encoding generalizes beyond text sequences. The same format encodes:

- **Maps:** Key-value pairs where each key has a register CRDT (last-writer-wins with Lamport ordering)
- **Lists:** Ordered sequences using the RGA algorithm
- **Counters:** Increment/decrement operations that merge by summation
- **Nested structures:** JSON-like documents where each node is independently a CRDT

The object ID column tracks which CRDT object each operation belongs to. Combined with the sorted encoding, this means operations on different sub-objects naturally cluster together, preserving compression efficiency even for complex document structures.

## Practical implications

The columnar encoding makes several previously impractical architectures viable:

**Offline-first applications:** A mobile app can store the full edit history of a document in a few hundred KB, sync opportunistically when connectivity returns, and merge without conflict resolution logic.

**Git-like branching for documents:** Because the operation log is the document, you can fork a document at any point, make independent edits on two branches, and merge them with the same guarantee as a linear edit session.

**Efficient sync protocols:** Two replicas can compare their operation sets by exchanging Bloom filters over operation IDs, then transmitting only the delta of missing operations in columnar format. The wire cost of syncing a 100K-character document that has diverged by 500 operations is roughly 2-5KB.

The lesson is structural: the same columnar encoding insight that makes analytical databases fast (Parquet, Arrow, ORC) applies to CRDT operation logs. Sequential operations from the same actor are the equivalent of a "sorted column" in a database, and the compression techniques are identical. Automerge 2.0 demonstrates that CRDTs' theoretical elegance need not come with a practical storage penalty, as long as you encode the history the same way you would encode any other highly regular dataset.
