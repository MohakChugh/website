---
title: "Shredding the Variant: Columnar Statistics for Schemaless JSON"
date: 2026-08-19
tags: [data-engineering, parquet, columnar, file-formats, query-optimization]
excerpt: "Storing JSON in a data lake has always meant choosing between a rigid schema and an opaque blob. Parquet's Variant type plus its shredding spec promise both: self-describing values that still get typed columns, page statistics, and partial projection. I reimplemented the encoding and shredding rules from scratch, and found that the size win is modest, the projection win is enormous, and the data-skipping win has a cliff so sharp that one bad producer in 3,000 rows destroys it entirely."
---

Every data lake accumulates a column nobody can plan for. Event payloads, webhook bodies, feature bags, LLM tool-call traces: data whose keys are stable enough to query and unstable enough that nobody will commit to a schema. Both usual answers are bad. Store it as a JSON string and every query pays full-document parse cost with zero statistics. Or flatten it into real columns and take an outage every time a producer adds a key.

Apache Parquet's `VARIANT` logical type, with its companion **shredding** specification, is the first design I have seen that refuses that trade. A Variant is a self-describing binary value, so writers never need a schema. Shredding then lifts the *statistically common* parts of that value into ordinary typed Parquet columns, keeping whatever does not fit in a binary residual. Readers get column statistics and partial projection over data that was never schematized.

I implemented the binary encoding and the shred/reconstruct rules from scratch in Python to check the parts that matter operationally. The round trips are clean: 0 mismatches over 50,000 randomized values, both unshredded and through the full shred plus reconstruct path. The interesting results are the costs.

## The binary layer

A Variant is two byte strings. `metadata` is a dictionary of field names; `value` is the encoded value, referring to names by dictionary index.

The metadata header is a single byte: bits 3 to 0 hold the version, which must be 1, bit 4 is `sorted_strings`, and bits 7 to 6 hold `offset_size_minus_one`. After it come `dictionary_size`, then `dictionary_size + 1` offsets, then the concatenated UTF-8 names.

The value's first byte packs a 2-bit `basic_type` in bits 1 to 0 and a 6-bit header above it: 0 for primitive, 1 for short string, 2 for object, 3 for array.

```python
def encode_value(v, ids):
    if v is None:  return bytes([0])                    # Variant null: 0x00
    if isinstance(v, str):
        b = v.encode()
        if len(b) < 64:                                  # short string: length in the tag
            return bytes([(len(b) << 2) | 1]) + b
        return bytes([16 << 2]) + struct.pack("<I", len(b)) + b
    if isinstance(v, dict):
        keys = sorted(v.keys(), key=lambda s: s.encode())   # lexicographic, always
        return _container(2, [ids[k] for k in keys], [encode_value(v[k], ids) for k in keys])
```

The short-string basic type folds a string's length into the tag byte, saving four bytes on every string under 64 characters. Given how much semi-structured data is short strings, that alone is a meaningful fraction of a real payload.

One subtlety is worth flagging. Field IDs inside an object must be ordered by the **lexicographic order of the field names**, not numerically. If the dictionary is not itself sorted, the ID array is not monotonic:

```
dictionary (sorted_strings=0) : ['zebra', 'apple', 'mango']
encoded field_ids             : [1, 2, 0]  ->  ['apple', 'mango', 'zebra']
ids monotonic? False          names sorted? True
```

The ordering exists so readers can binary search for a field. But the comparison key is the name behind the ID, not the ID. A reader that binary searches the raw ID array will silently return the wrong field for any writer that ships an unsorted dictionary, which is legal.

## Shredding: two columns per value

Shredding pairs every `value` with an optional sibling `typed_value`. Their joint nullity encodes four distinct states:

| `value` | `typed_value` | meaning |
|---|---|---|
| null | null | value is **absent**, legal only for a shredded object field |
| non-null | null | present, any type, including Variant null |
| null | non-null | present, and matches the shredded type |
| non-null | non-null | present, and is a **partially shredded object** |

That fourth row is the whole design. An object can have some fields promoted to real columns while unexpected keys land in the residual `value` blob, and the invariant is that the residual **must never contain a field represented in `typed_value`**. A shredded event looks like this:

```
optional group event (VARIANT(1)) {
  required binary metadata;
  optional binary value;                        # residual: unexpected keys only
  optional group typed_value {
    required group event_type {
      optional binary value;                    # fallback when the type is wrong
      optional binary typed_value (STRING);
    }
    required group event_ts {
      optional binary value;
      optional int64 typed_value (TIMESTAMP(true, MICROS));
    }
  }
}
```

Reconstruction is a recursive merge, and it is where the disjointness invariant is cashed in:

```python
def reconstruct(node, names):
    tv, val = node["typed_value"], node["value"]
    if tv is not None:
        if isinstance(tv, dict):                          # shredded object
            out = {f: r for f, c in tv.items()
                   if (r := reconstruct(c, names)) is not MISSING}
            if val is not None:                           # partially shredded
                resid, _ = decode_value(val, names)
                assert isinstance(resid, dict)
                assert not (set(resid) & set(tv))         # writers must guarantee this
                out.update(resid)
            return out
        assert val is None                                # primitives/arrays: exclusive
        return tv
    return decode_value(val, names)[0] if val is not None else MISSING
```

Note the three distinct flavours of nothing, which I verified byte by byte. A field *absent* from an object has both columns null. A field *present with a null value* has `value = 0x00`, the Variant null primitive. A whole Variant that is null has the root `value = 0x00` and `typed_value` null, which also tells the reader definitively that the value is not an object. Collapsing any two of these into SQL `NULL` loses information that round-trips today.

## Shredding is a projection optimization, not a compression one

I generated 200,000 realistic events, wrote both layouts as real Parquet with zstd, and compared. Shredded came out at 13.4 bytes per row against 16.0 unshredded, only **83.8%**. That is a rounding error next to what people expect from columnarization.

The projection numbers are a different story. Reading a single shredded path means touching two column chunks instead of every blob:

```
whole unshredded Variant : 1,651,367 B
project $.event_type     :    42,486 B  ( 2.57%)
project $.event_ts       : 1,445,589 B  (87.54%)
```

`event_type` is low cardinality, so its column is 2.6% of the file. `event_ts` is a high-entropy timestamp that simply *is* most of the dataset's information, and no layout makes reading it cheap. Shredding buys the right to skip bytes you do not need, and the payoff is proportional to how much entropy sits outside your access path. In the same reference implementation, a predicate on `event_type` took 21 ms from the shredded column against 184 ms parsing whole Variants, a 9x gap that is entirely parse avoidance.

The metadata column deserves a note, because per-row dictionary duplication looks alarming and mostly is not. What matters is not the raw byte count but the *cardinality of distinct metadata blobs*, which Parquet's dictionary encoding collapses:

```
stable keys    :       1 distinct blob,  raw 23.0 B/row -> parquet 0.01 B/row
moderate churn :     501 distinct blobs, raw 23.4 B/row -> parquet 0.20 B/row
unique per row : 200,000 distinct blobs, raw 35.4 B/row -> parquet 1.04 B/row
```

A 100x swing, driven purely by key stability. Using trace IDs or timestamps as object *keys* is the anti-pattern, and it inflates the metadata column, not the value column, which is exactly where nobody looks.

## The pruning cliff

Here is the finding I did not expect, and the one worth carrying into a design review.

`typed_value` statistics can drive row-group and page pruning **only when the sibling `value` is entirely null** over that range. The reasoning is airtight: a non-null `value` means at least one row fell back to an untyped encoding, so the typed column's min/max no longer bound the data. The spec says so, and it is unavoidable.

The consequence is that pruning is not degraded gracefully by dirty data. It is a per-page all-or-nothing property, so the probability a page survives is `(1 - p)^n` for off-type rate `p` and page size `n`. Solving for the rate at which half your pages stay prunable gives `p < 1 - 0.5^(1/n)`. Measured against 100 pages of 2,000 rows:

```
off-type rate   clean pages   predicted
        3e-02        0/100         0.0%
        3e-03        0/100         0.2%
        3e-04       66/100        54.9%
        3e-05       96/100        94.2%
```

At 2,000 rows per page, you need fewer than **1 in 2,886** values off-type to keep half your pages prunable. At 20,000 rows, 1 in 28,854. A single upstream service that emits `"2024-10-24"` where every other producer emits an epoch microsecond count, at a 3% rate, takes your data skipping from complete to zero. Nothing gets slower in a way you would notice in a benchmark; the statistics just quietly stop being consulted, and a query that should read one page reads the file.

That reframes shredding as an operational discipline rather than a storage setting. The shredding schema is a contract, the residual `value` column's null count is the compliance metric, and it is cheap to monitor: any non-null in a page is a producer that drifted. If you adopt Variant shredding, alarm on that null count per partition before you tune anything else. Type discipline at the edge is what buys the pruning, and the format will not tell you when you have lost it.
