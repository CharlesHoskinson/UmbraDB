# R-3 — Cost and mechanism seat

**Question:** which stored data must be covered by application-level integrity digests, what exactly
is the digest, and what does it cost?

**Conditions for every figure in this document.** Host: AMD Ryzen AI MAX+ 395, 12 cores, 62 GB RAM.
WSL2 Ubuntu 26.04, Node **v24.18.0**, `node:sqlite` (SQLite **3.53.1**), `better-sqlite3@13.0.2`
(SQLite **3.53.4**) where stated. **Filesystem: ext4** — `/dev/sdd on / type ext4
(rw,relatime,discard,errors=remount-ro,data=ordered)`, 1007 GB, 40 % used. **No figure in this
document was measured on `/tmp`** (32 GB tmpfs); all benchmark files live under
`/root/udb-r3-bench/`. `journal_mode=wal` everywhere; `synchronous` and `page_size` are stated per
table. Scripts: `/root/udb-r3-bench/{hash-throughput,gencol,gencol2,writepath2,writepath3,verify-backfill,backfill2,domainsep,overflow-corrupt,coltests}.mjs`.

---

## 1. Recommendation

### 1.1 The headline

**The expensive part is already built and paid for.** UmbraDB's two largest tables by bytes —
`ckpt_chunks` and `chain_blobs` — are content-addressed: the primary key *is* `SHA-256(data)`, and
`CheckpointStore.loadImpl` (`src/postgres/checkpoint-store.ts:366`) and
`ChainArchiveStore.getBlob` (`src/postgres/chain-archive-store.ts:485-490`) already rehash on every
read and raise `ChunkIntegrityError` / `BlobIntegrityError` on mismatch. I verified that this
existing check catches exactly the corruption class SQLite misses (§3.1). The R-3 gate is therefore
not "build a digest system"; it is "extend an existing, already-verified one to the four small
tables it does not cover, and add a whole-database pass."

### 1.2 The digest specification

**Algorithm: SHA-256.** Not a compromise — the measured winner.

| algorithm | MB/s @ 5893 B (p50 blob) | MB/s @ 4 MiB (ckpt chunk) |
|---|---:|---:|
| **sha256** | **1,652** | **2,381** |
| sha1 | 1,889 | 2,542 |
| blake2b512 | 1,223 | 1,504 |
| blake2s256 | 808 | 807 |
| sha512 | 1,076 | 1,271 |
| md5 | 921 | 1,073 |
| crc32 (zlib) | 6,902 | 7,908 |

The brief asks whether "this is a detection problem, not an adversarial-integrity one" licenses a
non-cryptographic hash. **Stated explicitly: yes in principle, no in this project, and the reason is
cost, not cryptography.** SHA-256 outruns every other *cryptographic* option on this hardware
because Zen 5 has SHA-NI; the usual "SHA-256 is slow, reach for BLAKE3" reasoning is simply false
here — BLAKE2b measures **1.5×–1.6× slower** than SHA-256, not faster. CRC32 is genuinely 3.3–11×
faster, but the entire saving is **0.5–9 µs per row against a 2,088 µs fsync** (§2.1). Downgrading
buys 0.02–0.4 % of one commit and costs: a second hash primitive in a codebase that has exactly one,
loss of collision resistance the content-addressed tables already depend on, and a 32-bit digest
whose false-negative rate on a corrupted page is ~2⁻³² per row rather than ~2⁻²⁵⁶. **Use SHA-256
everywhere, for the same reason the project already does.**

**Preimage and domain separation.** A digest over a bare value is forgeable, and I demonstrated it
rather than asserting it (§3.2): two `kv` rows legitimately holding the same value (`{"balance":0,
"utxos":[]}` — an empty wallet, a default config, a zeroed balance; this is common, not contrived)
produce identical `sha256(value)`, so substituting one row's `(value, dg)` pair for another's
verifies clean. Measured: `bare digest sha256(value) verifies? YES -- CORRUPTION UNDETECTED`.

The digest is therefore over a **versioned, length-prefixed, fully-framed preimage**:

```
dg = SHA-256(
      0x01                        // 1 byte, preimage-format version
   || u32be(len(table))  || table // UTF-8 table name, unprefixed (logical name)
   || u32be(len(column)) || column
   || u32be(len(pkEnc))  || pkEnc // canonical PK encoding, see below
   || u32be(len(value))  || value // the EXACT stored bytes
)

pkEnc = concat over PK columns in declared order of ( u32be(len(c_i)) || c_i )
        where c_i is the UTF-8 bytes of a TEXT pk column, or the 8-byte big-endian
        two's-complement encoding of an INTEGER pk column.
```

Length-prefixing every field (rather than concatenating with a separator) is what makes the encoding
injective: without it `("ab","c")` and `("a","bc")` collide. Verified: identical values in different
rows now produce different digests, and the row-substitution above is **detected**.

`value` is the exact bytes SQLite stores — the UTF-8 bytes for a TEXT column (L4: jsonb becomes
TEXT), the raw bytes for a BLOB column. Never a re-serialised object; the digest must cover what was
read back, not what the object model thinks it means.

**Column:** `dg BLOB` — 32 raw bytes. Verified STRICT-legal; `BLOB`, `TEXT` and `INTEGER` are
accepted in a `STRICT` table, `BYTEA` and `VARCHAR(64)` are rejected (`unknown datatype`). Do **not**
store hex TEXT — it doubles the column to 64 bytes, which matters precisely on the small-value tables
where the digest's storage cost is highest (§2.3).

**Where it is computed: in the adapter, on the caller's thread, before the value crosses into the
worker.** Not in a SQL expression (§4 rejects that outright), and not on the worker thread. L3
measures the worker round-trip at **124.38 µs/op (32.2× overhead)**; the worker owns the single
`DatabaseSync` and is the serialisation point for every write, so a hash computed *there* lands
directly on the write-lock critical path. Computed caller-side it is 1–13 µs of work hidden behind a
124 µs hop that is happening anyway. This is free in the strict sense: it does not extend the
critical section.

**Cheap extra: a trigger guard.** The one real property a generated column would have bought is that
the digest cannot drift from the value. A `BEFORE UPDATE OF value` trigger recovers it with no UDF
and no cost:

```sql
CREATE TRIGGER kv_current_dg_guard BEFORE UPDATE OF value ON kv_current
WHEN NEW.dg IS OLD.dg
BEGIN SELECT RAISE(ABORT, 'digest not recomputed for updated value'); END;
```

Verified: `UPDATE v without touching dg: REJECTED -> digest not recomputed for updated value`;
`UPDATE v WITH a new dg: ACCEPTED`.

### 1.3 The coverage set my cost analysis supports

**Tier A — already covered. No column, no migration, no new cost.**

| table | existing digest | already verified on read? |
|---|---|---|
| `ckpt_chunks` | `hash` PK = `SHA-256(data)` | yes — `checkpoint-store.ts:366` |
| `chain_blobs` | `hash` PK = `SHA-256(data)`, `CHECK(octet_length(hash)=32)` | yes — `chain-archive-store.ts:489` |
| `ckpt_manifests` | `manifest_hash` = `SHA-256(‖ chunk hashes in position order)` | yes — `checkpoint-store.ts:378` |
| `ckpt_manifest_chunks` | covered transitively by `manifest_hash` recomputation | yes |

This is >95 % of the bytes in a populated UmbraDB. Keep these checks; do not weaken them. The one
gap is *framing*: `ckpt_chunks.hash` is a bare content hash, so a chunk cannot be substituted for a
*different* chunk without detection, but the manifest-hash recomputation is what closes the
row-substitution hole above it — and that already exists.

**Tier B — MUST gain a `dg BLOB` column. This is the actual ask.**

| table | column digested | why |
|---|---|---|
| `kv_current` / `kv_history` — `kv_event` after L1's redesign | `value` | the wallet state. The one thing a wallet must not silently lose. |
| `transaction_history` | `entry` | per-tx lifecycle; silent corruption here misreports settlement |
| `watermarks` (both lineages) | `value` | tiny table, but it is the sync cursor; a corrupted watermark causes silent resync divergence rather than an error |
| `sqlite_schema` | one digest over all DDL text, pinned by the last migration, checked at `open()` | not a column — a single stored digest. **53 µs once per open** (§2.2c) |

This is the same COVER set the coverage seat arrived at independently, which is worth recording: two
seats reasoning from different evidence — corruption modes on one side, cost on the other — converged
on the same four items. Note the table naming depends on whether L1's event-log redesign lands;
`kv_current`/`kv_history` and `kv_event` are the same data and the same ruling.

Total cost of Tier B: **~3 µs added to a `saveAndAdvance` commit that costs 2,088 µs (0.15 %)**,
**+1.9–3.4 µs per verified read**, and a storage delta bounded by 34–42 bytes/row on tables measured
in the 10⁴–10⁶ row range — tens of MB at the very top end.

**Tier C — deliberately NOT covered, on cost grounds.** The chain-archive metadata tables `blocks`,
`transactions`, `bridge_observations`, `verifier_key_observations`.

The reasoning is not "too expensive to bother"; it is that **these rows are projections of data that
is already covered.** Every one of them holds a `*_blob_hash` FK into `chain_blobs`, whose content is
digest-protected and rehashed on read. `transactions.tx_hash`, `block_height`, and the rest are
parsed *out of* `raw_blob_hash`'s bytes. A corrupted metadata row is therefore recoverable by
re-parsing a blob whose integrity is already guaranteed — it needs a documented rebuild path, not a
digest.

The cost side confirms the call. These are the highest-row-count tables in the system (one row per
transaction on chain). At a ~150–250 byte metadata row, the measured storage delta for a 32-byte
digest column is **+15 % to +46 %** (§2.3) — on the largest tables in the database, to protect data
that is reconstructible. That is the one place in this design where a digest is a bad trade.

### 1.4 Verification strategy: both, at three tiers

| tier | what | when | measured cost |
|---|---|---|---|
| **1** | rehash-on-read, **mandatory**, content-addressed tables | every `getBlob` / `load` | already shipped; 3.5 µs at p50, 12.6 µs at p99 |
| **2** | verify-on-read for Tier-B rows, **mandatory, default ON** | every point read | **+1.9 to +3.4 µs** per read (§2.2b) |
| **2s** | `sqlite_schema` digest, verified at `open()` | once per open | **52.8 µs** (§2.2c) |
| **3** | whole-database verification pass | on demand + after unclean shutdown | **4.49 s cold / 3.61 s warm on a 2.97 GB, 300k-row database** |

**A note on how I arrived at Tier 2, because I changed my mind on the evidence.** My blob-sized read
measurements (§2.2a) show verify-on-read roughly *doubling* a warm point read, and on that basis I
initially ruled Tier 2 opt-in and default-off. The coverage seat independently mandates "verified on
every read" for its COVER set. Rather than defend the disagreement I measured the actual case — the
COVER tables hold small JSON values, not blobs — and the absolute numbers do not support my position
(§2.2b): verification costs **1.9–3.4 µs**, taking a point read from ~231,000/s to ~161,000/s. A
wallet store does not do 160,000 reads per second. **The percentage is alarming and the absolute cost
is nothing; the absolute cost is what matters here, so I concede and adopt default-ON.** The opt-out
survives only for bulk scans, where the pass in Tier 3 covers the same ground at 520–650 MB/s.

Tier 2s is the coverage seat's `sqlite_schema` item, which my original enumeration missed. It is the
cheapest recommendation in this whole document — one query and one hash over ~3.7 KB of DDL text,
**52.8 µs, once per `open()`** — and I endorse it without reservation on cost grounds.

Tier 3 is the load-bearing recommendation, and the argument for it is a comparison the project has
not yet made:

```
| cache               | work   | rows   | wall s | rows/s | MB/s | mismatches |
| cold (drop_caches)  | sha256 | 300000 |   4.49 |  66765 |  520 |          0 |
| warm                | sha256 | 300000 |   3.61 |  83051 |  647 |          0 |

  quick_check:      34.97 s -> [{"quick_check":"ok"}]
  integrity_check:  32.37 s -> [{"integrity_check":"ok"}]
```

**The application-level pass is 7–8× cheaper than `PRAGMA integrity_check` on the same database,
while detecting a strictly larger class of corruption** (integrity_check returned `ok` on a database
whose blob content I had corrupted — §3.1). If the project can afford `integrity_check`, and the
plan already proposes running it, it can afford this seven times over. Ship the pass; consider
running it *instead of* `integrity_check`, not in addition.

**It runs concurrently with the writer.** Verified on the 300k-row database, two connections in WAL:

```
verified 300000 rows in 10.23 s while committing 3000 new rows in 15 write txns
writer error: none -- reader never blocked the writer
```

The single-writer topology and `withTransaction`'s whole-database lock are not a problem here,
because the pass is a *reader*. In WAL mode readers never block the writer. Use a second, read-only
`DatabaseSync` (L3 already proposes exactly this for the read worker).

Scaling: the pass is I/O-bound at 520–650 MB/s. A 30 GB archive costs roughly **50–60 s**.

---

## 2. Measurements

### 2.1 The framing that decides it: digest vs. the surrounding write path

Raw `fsync()` on ext4, 4 KB write, 300 samples:

```
min=1893.97  p25=2022.38  median=2087.66  p75=2368.32  p99=3392.32  max=5756.29   (us)
=> ONE fsync = 2087.66 us. SHA-256 of a 5893 B p50 blob = 3.49 us  ->  ratio 1 : 598
```

**One SHA-256 over a median chain-archive blob is 0.17 % of one fsync.** That single ratio is the
answer to the cost question at `synchronous=FULL`.

Per-commit latency distribution, 1 row per `BEGIN IMMEDIATE…COMMIT`, 1200 commits, `page_size=16384`
(µs):

| sync | size | digest | min | p25 | **median** | p75 | p99 |
|---|---|---|---:|---:|---:|---:|---:|
| FULL | 2 KB jsonb | none | 820.03 | 2029.79 | **2222.39** | 2689.50 | 4077.80 |
| FULL | 2 KB jsonb | sha256 | 837.50 | 2129.88 | **2708.91** | 3132.61 | 3968.76 |
| FULL | 5893 B p50 | none | 825.20 | 1115.04 | **2158.63** | 2526.62 | 4443.92 |
| FULL | 5893 B p50 | sha256 | 743.76 | 1125.29 | **2134.49** | 2394.89 | 4066.49 |
| FULL | 29158 B p99 | none | 707.28 | 1134.81 | **2058.59** | 2263.24 | 3913.80 |
| FULL | 29158 B p99 | sha256 | 974.09 | 1159.84 | **2087.48** | 2265.68 | 4023.07 |
| NORMAL | 2 KB jsonb | none | 9.08 | 10.94 | **14.40** | 15.10 | 56.68 |
| NORMAL | 2 KB jsonb | sha256 | 11.31 | 13.30 | **16.02** | 18.84 | 58.97 |
| NORMAL | 5893 B p50 | none | 9.72 | 10.77 | **19.54** | 21.75 | 67.70 |
| NORMAL | 5893 B p50 | sha256 | 12.86 | 14.24 | **23.05** | 29.29 | 87.73 |
| NORMAL | 29158 B p99 | none | 25.29 | 27.22 | **28.20** | 36.34 | 106.24 |
| NORMAL | 29158 B p99 | sha256 | 38.00 | 40.43 | **41.55** | 54.88 | 166.95 |

Read this honestly, in two halves.

**At `synchronous=FULL` the digest is not measurable.** At p50 the median with the digest (2134 µs)
is *below* the median without it (2159 µs); at p99 it is 29 µs above, against a p25–p75 spread of
~1,100 µs. The digest costs 3.5–12.6 µs and the fsync noise floor is two orders of magnitude wider.
I will not dress this up as a percentage — the correct statement is **the digest is below the
measurement noise floor of a `synchronous=FULL` commit**, and the analytic ratio (1:598) is the only
meaningful number.

**At `synchronous=NORMAL` the digest is visible and small.** p50 blob: 19.54 → 23.05 µs, **+3.51 µs
(+18.0 %)** — which matches the standalone SHA-256 cost of 3.49 µs exactly, so the measurement is
self-consistent and the digest is pure CPU with no hidden I/O. p99 blob: 28.20 → 41.55, **+13.35 µs
(+47 %)**, against a standalone 12.64 µs. At 2 KB: +1.62 µs (+11 %).

So the true statement is: **at NORMAL the digest is 11–47 % of a bare commit, and a bare commit at
NORMAL is 100× cheaper than one at FULL.** The absolute added cost is 1.6–13 µs per row in both
regimes. L6 argues `NORMAL` is already contract-legal; even if the council adopts NORMAL, the digest
adds at most 13 µs to a 28 µs commit at the p99 blob size, and 3.5 µs at the size that actually
dominates.

Bulk insert, all rows in one transaction (fsync amortised to ~0 — the worst case for the digest,
because nothing else is left to hide behind), median of 5 interleaved reps, µs/row:

| sync | size | no digest | sha256 | crc32 | sha256 delta | as % |
|---|---|---:|---:|---:|---:|---:|
| FULL | 2 KB jsonb | 7.05 | 9.51 | 8.13 | +2.46 | +34.8 % |
| FULL | 5893 B p50 | 22.29 | 26.46 | 22.45 | +4.17 | +18.7 % |
| FULL | 29158 B p99 | 97.95 | 123.45 | 115.18 | +25.50 | +26.0 % |
| NORMAL | 2 KB jsonb | 8.03 | 10.80 | 10.04 | +2.77 | +34.6 % |
| NORMAL | 5893 B p50 | 53.34 | 56.22 | 52.81 | +2.88 | +5.4 % |
| NORMAL | 29158 B p99 | 102.59 | 99.19 | 81.07 | −3.39 | −3.3 % |

Bulk ingest is where the digest is most expensive: **+18 % to +35 %** of the amortised per-row cost.
Against L5's measured **660–730× throughput headroom** on the archive, that is affordable — and note
that Tier C (the bulk-ingest tables) is the coverage I am *declining*, so this row of the table is
the cost of a recommendation I am not making. Tier A's ingest already pays this today.

### 2.2a Read path — blob sizes

Warm point `SELECT` by primary key, `page_size=16384`:

| value size | plain µs/read | verify µs/read | delta | as % of read |
|---|---:|---:|---:|---:|
| 2 KB jsonb | 5.47 | 9.29 | +3.82 | +69.9 % |
| 5893 B p50 | 7.46 | 14.66 | +7.19 | +96.4 % |
| 29158 B p99 | 15.28 | 26.09 | +10.81 | +70.8 % |

A warm point read has no fsync to hide behind and the hash is comparable to the entire read:
**verify-on-read roughly doubles a warm read of a blob.** This cost is already being paid on Tier A
and is correct there — a blob read is a rare, large, deliberate operation and the existing
`BlobIntegrityError` contract depends on it.

But these are *blob* sizes, and Tier B does not hold blobs. Measuring the right case changes the
ruling.

### 2.2b Read path — the sizes Tier B actually holds

Warm point `SELECT` by the three-part primary key on a `kv_event`-shaped STRICT table with realistic
wallet JSON values, `page_size=4096`, `synchronous=NORMAL`, verification using the full
domain-separated preimage of §1.2 (not a bare hash):

| value size | plain µs/read | verify µs/read | delta | as % | reads/s plain | reads/s verify |
|---|---:|---:|---:|---:|---:|---:|
| 65 B (watermark / sync cursor) | 4.331 | 6.203 | **+1.872** | +43.2 % | 230,899 | 161,224 |
| 364 B (small wallet state) | 4.071 | 6.452 | **+2.380** | +58.5 % | 245,632 | 155,000 |
| 1522 B (wallet state) | 4.599 | 7.952 | **+3.353** | +72.9 % | 217,424 | 125,747 |

**Verification costs 1.9–3.4 µs and leaves 126,000–161,000 reads/s on the table.** A wallet store
reads its state on sync ticks and user actions, not at six figures per second. The relative column
says "expensive"; the absolute column says the headroom is four to five orders of magnitude. Default
this ON.

One implementation note that is worth ~1 µs of the above: a meaningful fraction of the delta is
`Buffer.from(row.value, "utf8")` — re-encoding a string that `node:sqlite` just decoded *from* UTF-8.
Reading the column as `CAST(value AS BLOB)` on the verification path hands back the stored bytes
directly and skips the round trip. I measured the pessimistic version; the optimisation is available
if the number ever matters.

### 2.2c The `sqlite_schema` digest

```
58 schema objects, 3729 bytes of DDL text
full schema digest (query + hash): 52.766 us  -> 0.053 ms, once per open()
```

On a schema deliberately built to exceed UmbraDB's real object count (14 tables + 14 indexes + 14
triggers + the base tables). **53 µs once per `open()`.** There is no cost argument against this.

### 2.3 Storage

32-byte `dg BLOB` column, VACUUMed main database, digest vs. no digest:

| row value size | page_size | rows | no-digest bytes | +digest bytes | delta | % | delta/row |
|---|---:|---:|---:|---:|---:|---:|---:|
| 64 B (watermark jsonb) | 4096 | 40000 | 2,973,696 | 4,333,568 | 1,359,872 | **+45.7 %** | 34.0 |
| 256 B (small kv) | 4096 | 40000 | 10,956,800 | 12,640,256 | 1,683,456 | **+15.4 %** | 42.1 |
| 1020 B (tight fit @4K) | 4096 | 40000 | 54,755,328 | 54,755,328 | 0 | **0.00 %** | 0.0 |
| 2 KB jsonb | 4096 | 20000 | 82,116,608 | 82,116,608 | 0 | **0.00 %** | 0.0 |
| 2 KB jsonb | 16384 | 20000 | 46,891,008 | 46,891,008 | 0 | **0.00 %** | 0.0 |
| 5893 B p50 | 16384 | 12000 | 98,385,920 | 98,385,920 | 0 | **0.00 %** | 0.0 |
| 29158 B p99 | 16384 | 4000 | 131,137,536 | 131,137,536 | 0 | **0.00 %** | 0.0 |

The zeros are real, not a measurement bug (the first attempt *was* a bug — sizing before
`wal_checkpoint(TRUNCATE)`; these numbers are post-checkpoint and post-`VACUUM`). At ≥1 KB rows the
32 bytes fit in existing per-page slack without changing the page count: at `page_size=16384` a
5,893-byte row packs 2 per page (11,850 of 16,349 usable), and +64 bytes does not change that.

**The storage cost of a digest is inversely proportional to value size, and it is a real cost only
on small-value tables.** That is exactly the shape that makes the Tier B / Tier C split correct: Tier
B's small-value tables are small in *absolute* terms (watermarks holds a handful of rows; even 1M
`kv_history` rows at +34 B is 34 MB), while Tier C's small-metadata-row tables are the ones with
10⁷–10⁸ rows, where +15–46 % is gigabytes.

### 2.4 Cost of domain separation

The framed preimage costs more than a bare hash because of buffer construction, not hashing. With
the constant prefix (`0x01 ‖ table ‖ column`) built once per prepared statement rather than per row:

| value size | bare `crypto.hash` | domain-sep, naive | domain-sep, prefix cached | **DS overhead** |
|---|---:|---:|---:|---:|
| 64 B | 0.984 | 2.418 | 1.242 | **+0.258 µs** |
| 256 B | 0.896 | 2.417 | 1.353 | **+0.457 µs** |
| 2 KB | 1.625 | 3.344 | 2.291 | **+0.666 µs** |
| 5893 B p50 | 3.297 | 4.860 | 3.841 | **+0.543 µs** |
| 29158 B p99 | 12.752 | 14.671 | 13.868 | **+1.116 µs** |

Domain separation costs **0.26–1.12 µs/row** if the prefix is cached, and 1.4–1.7 µs if it is not.
Cache the prefix; the code that does it is four lines. Note the ~0.9 µs floor on any `crypto.hash`
call at small sizes — for a 64-byte watermark value the cost is *entirely* call overhead, and no
choice of algorithm changes it.

---

## 3. Evidence for the premise (re-verified independently)

### 3.1 SQLite returns corrupted content as data — third independent reproduction

The council's red-team lane verified this twice. My first two attempts on a small-row table
*failed* to reproduce it, and the failure is instructive: a 64-byte overwrite at an arbitrary
mid-file offset, and even one landing inside a short TEXT payload, perturbs adjacent cell headers
and the page's pointer array, and `integrity_check` **does** catch that (`Tree 2 page 8 cell 25:
Rowid 248 out of order`). `PRAGMA integrity_check` verifies b-tree *structure*, and structural damage
is detected.

The premise holds for **content**, and the cleanest demonstration is an **overflow page** — 4 bytes
of next-page pointer followed by pure payload, no cell headers, no pointer array. This is exactly how
SQLite stores `ckpt_chunks.data` and `chain_blobs.data`:

```
db=2469888 bytes, page_size=4096, 40 blobs of 60000 B (each spans ~15 overflow pages)
corrupted 64 bytes at file offset 459776 (page 113, byte 1024 in page)
  before: 00704e8400704e8800704e8c00704e90...
  after : ff8fb17bff8fb177ff8fb173ff8fb16f...
PRAGMA integrity_check -> [{"integrity_check":"ok"}]
PRAGMA quick_check -> [{"quick_check":"ok"}]
rows returned: 40; rows whose BLOB bytes differ from what was written: 1
rows caught by rehash-vs-primary-key (the existing AC-3 check): 1
VERDICT: SQLite reported ok and returned corrupted bytes as data; the application digest is the ONLY detector.
```

This sharpens the finding for the council: **the corruption SQLite cannot see is precisely the
corruption that lands in large blob payloads** — the data UmbraDB stores most of. And it confirms
that the check the project already ships is the thing that catches it.

Compile options confirm no checksum facility is available to fall back on — no
`SQLITE_ENABLE_CKSUMVFS`, no hash extension:

```
ATOMIC_INTRINSICS=1, ..., ENABLE_COLUMN_METADATA, ENABLE_DBSTAT_VTAB, ENABLE_FTS3,
ENABLE_FTS3_PARENTHESIS, ENABLE_FTS5, ENABLE_GEOPOLY, ENABLE_MATH_FUNCTIONS,
ENABLE_PERCENTILE, ENABLE_PREUPDATE_HOOK, ENABLE_RBU, ENABLE_RTREE, ENABLE_SESSION, ...
pragma checksum_verification -> []      (unrecognised pragma; cksmvfs not compiled in)
```

### 3.2 A bare digest is forgeable

```
alice's value replaced by mallory's row (a whole-row substitution)
bare digest sha256(value) verifies?  YES -- CORRUPTION UNDETECTED
domain-separated digests differ for the same value in different rows: true
two rows with IDENTICAL values still get different digests: true
after the same substitution, domain-separated digest verifies? no -- CORRUPTION DETECTED
```

---

## 4. The generated-column ruling: **REJECT**

**Ruling: the digest must be computed by the adapter. A `GENERATED ALWAYS AS (...) STORED` column is
technically possible and operationally unacceptable.**

**Finding 1 — SQLite exposes no hash function to SQL in either candidate binding.** Verified against
`node:sqlite` (SQLite 3.53.1) and `better-sqlite3@13.0.2` (SQLite 3.53.4):

```
absent  sha3 / sha1 / md5 / crc32 / sha256 / hash / digest / checksum  -> no such function
PRESENT hex / quote / randomblob
bs3 builtin sha3: absent -> no such function: sha3
```

`ext/misc/shathree.c` (`sha3`, `sha3_query`) is a loadable extension that neither binding compiles
in, and loading extensions is not on the table.

**Finding 2 — a deterministic UDF *is* accepted in a STORED generated column.** This contradicts the
natural assumption, so it is worth recording that the mechanism itself works:

```
CREATE TABLE with UDF in STORED gencol: ACCEPTED
INSERT ok, dg=2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824
  expected =2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824
```

The determinism rules are hard and were checked, not assumed:

```
nd_hash (no deterministic flag): REJECTED -> non-deterministic functions prohibited in generated columns
do_hash (directOnly):           REJECTED -> unsafe use of do_hash()
```

So the function must be registered with `{ deterministic: true }` and must **not** be `directOnly`.

**Finding 3 — and this is what kills it — the UDF becomes a permanent dependency of the schema
itself.** Any connection that does not register `udb_sha256` cannot write to the table or maintain
the file:

```
### A. VACUUM with the UDF ABSENT
  VACUUM: FAILED -> no such function: udb_sha256
### B. VACUUM with the UDF PRESENT
  VACUUM: ACCEPTED
### C. UPDATE of a non-generated column, UDF absent
  UPDATE: REJECTED -> unknown function: udb_sha256()
  DELETE: ACCEPTED
### D. better-sqlite3@13.0.2 opening the same file, UDF absent
  select dg  => ok (49 rows)
  INSERT: REJECTED -> unknown function: udb_sha256()
  INSERT after bs3 registers UDF: ACCEPTED
### E. Online backup API with UDF absent
  backup(): ACCEPTED
```

Reads work (the value is materialised on disk) and page-level `backup()` works. But **`VACUUM`
fails** — and L5 has already established that `auto_vacuum` cannot be retrofitted, which makes manual
`VACUUM` an operational necessity, not an optional nicety. A user with the `sqlite3` CLI, DB Browser,
a recovery tool, or any script that is not UmbraDB cannot compact, repair, or write to their own
wallet database. For a library whose whole pitch is "it's a local file", that is a serious regression
in what the file *is*.

**Finding 4 — it cannot serve the migration anyway.** Confirmed on the real 300k-row, 2.97 GB
database, and again on a minimal case:

```
3a ADD COLUMN ... STORED on populated table: REJECTED -> cannot add a STORED column
ADD COLUMN dg5 BLOB GENERATED ... STORED  -> cannot add a STORED column
ADD COLUMN dg6 BLOB GENERATED ... VIRTUAL -> constraint failed
```

The plan's claim is confirmed: `ADD COLUMN … GENERATED … STORED` succeeds at 0 rows and fails on any
populated table. So even if findings 1–3 were acceptable, every existing deployment would need a full
table rebuild — the exact route §5 rejects.

**Finding 5 — the one thing worth salvaging.** A generated column genuinely cannot be desynchronised
from its source: `direct write to gencol: REJECTED -> cannot UPDATE generated column "dg"`. The
adapter-computed column has no such protection. **Recover it with the trigger in §1.2** — verified
working, no UDF, no schema dependency, no VACUUM breakage.

**Also settled: `ADD COLUMN` variants on a non-empty STRICT table.**

```
ACCEPTED  ADD COLUMN dg BLOB
REJECTED  ADD COLUMN dg2 BLOB NOT NULL              -> Cannot add a NOT NULL column with default value NULL
ACCEPTED  ADD COLUMN dg3 BLOB NOT NULL DEFAULT x''
ACCEPTED  ADD COLUMN dg4 BLOB CHECK(length(dg4)=32)
```

Add the column **nullable** (`dg BLOB`), and treat `NULL` as "not yet backfilled / unverified" — it
is the resumability marker and the honest representation of a partially migrated table. Do not use
`NOT NULL DEFAULT x''`: it destroys the distinction between "no digest yet" and "digest of empty",
and it makes the backfill un-resumable. Do not add the `CHECK(length(dg)=32)` in the same migration —
it would be violated by every not-yet-backfilled row; add it in a later rebuild if wanted.

---

## 5. Backfill plan and cost

Measured on the 300k-row, 2.97 GB chain-archive-shaped database, ext4, WAL, `synchronous=NORMAL`,
`page_size=16384`.

**Step 1 — add the column.** `ALTER TABLE … ADD COLUMN dg BLOB` measured at **975 ms** on a 2.97 GB
database. SQLite's `ADD COLUMN` rewrites only `sqlite_schema`; it does not touch existing rows.

**Step 2 — keyset-paginated, resumable backfill.** `WHERE hash > :cursor ORDER BY hash LIMIT :n`:

| batch | rows | total s | rows/s | lock hold ms median | p99 | max | txns |
|---:|---:|---:|---:|---:|---:|---:|---:|
| **200** | 303,000 | **19.23** | **15,760** | **2.98** | **47.02** | **97.23** | 1515 |
| 1000 | 303,000 | 23.43 | 12,932 | 50.56 | 158.05 | 184.78 | 303 |
| 5000 | 303,000 | 20.54 | 14,754 | 206.38 | 645.28 | 645.28 | 61 |

**`BATCH=200` is strictly dominant** — it is both the fastest overall *and* has by far the shortest
write-lock hold. There is no tradeoff to make. Hash outside the write transaction (the script does),
so the lock covers only the `UPDATE`s.

This matters because of exactly the topology concern in the brief: `withTransaction` takes a
whole-database lock and the writer is serialised. At `BATCH=200` the backfill holds that lock for a
**median 3 ms, p99 47 ms, max 97 ms** at a time, releasing it between batches — a live wallet's
writes interleave with it. At `BATCH=5000` the max hold is 645 ms, which is long enough to be felt.

**Do not use `WHERE dg IS NULL` as the pagination predicate.** My first implementation did, and it is
O(n²) — each batch rescans the whole prefix of already-backfilled rows. Measured: **118.64 s at 2,554
rows/s**, versus 19.23 s at 15,760 rows/s for keyset pagination. A **6.2× penalty** for the obvious
implementation.

**Step 3 — resumability.** Persist the cursor in the **same transaction** as the digests:

```
pass 1: 50000 rows, cursor persisted = 42,45,189,150,24...
nulls remaining: 253000
resumed to completion: 303000 rows total, nulls remaining = 0
cursor is committed in the SAME transaction as the digests -> exactly-once, no re-hash of committed rows
```

A crash mid-backfill loses at most one 200-row batch. `SELECT count(*) WHERE dg IS NULL` is the
progress indicator and the completion check.

**Storage impact.** `+28.8 MB on 2.953 GB (+0.98 %)` before VACUUM, settling to **+20 MB (+0.68 %)**
after. The excess over the 9.6 MB of logical digest bytes is page splits from the in-place `UPDATE`.
`VACUUM` afterwards costs **40.9 s** on this database and requires ~2× free space transiently — make
it **optional and off by default**; 0.3 % of a database is not worth a mandatory 40-second
double-disk operation on a user's machine.

**Rejected alternative — table rebuild** (`CREATE TABLE new … INSERT … SELECT … DROP … RENAME`):

```
single-transaction rebuild: 20.62 s -- ONE write lock held for the ENTIRE duration
peak db+wal bytes: db=5.948 GB (was 2.973 GB)
=> not resumable, and the lock hold is 20.62 s vs ~0.1 s per batch for the paginated route
```

Same wall-clock, but it holds the whole-database write lock for 20.6 s uninterrupted, doubles peak
disk (2.97 → 5.95 GB), and cannot resume after a crash. On real deployments — installed by git tag,
repo clone, and docker image, per the brief — that is the wrong shape. **Use the paginated route.**

**What this costs a real user.** Tier B is the only backfill required, and those tables are far
smaller than the 300k rows benchmarked here. At the measured 15,760 rows/s, a 100k-row
`transaction_history` backfills in **~6 s**; `watermarks` and `kv_current` are effectively
instantaneous. Tier A needs no backfill at all — the digests are the primary keys and already exist.
**The migration cost of this entire recommendation, on a real deployment, is seconds.**

---

## 6. What I could not measure

Stated plainly, not estimated silently.

1. **BLAKE3 and xxHash64.** `npm install` is prohibited and neither is in Node core (`blake3 pkg: no`,
   `xxhash pkg: no`). I measured BLAKE2b/BLAKE2s as the nearest in-core cryptographic proxies and
   `zlib.crc32` as the in-core non-cryptographic one, but **the specific claim that BLAKE3 has a
   materially different cost profile is unverified on this host.** What I can bound: even a
   *hypothetically infinitely fast* hash saves at most 3.49 µs per p50 row versus SHA-256, which is
   0.17 % of one fsync. No plausible BLAKE3 result changes the recommendation. It would only change
   it if the council chose Tier C coverage plus `synchronous=NORMAL` plus a bulk-ingest-dominated
   workload — the one corner where hashing is 18–35 % of the write path.

2. **Power-loss corruption, and the base rate of the thing being detected.** Every corruption in this
   document is a deliberate `write()` to the file. I have not measured how often real hardware
   produces silent bit-rot in a SQLite main database, so I cannot express the *value* of detection —
   only its price. The council's contract seat owns that question.

3. **The worker-thread topology end-to-end.** I measured hash cost in isolation and cite L3's
   124.38 µs/op worker round-trip, but I did not build a combined harness that hashes caller-side and
   writes worker-side. The claim that caller-side hashing is hidden behind the worker hop is a
   composition of two measurements, not one measurement.

4. **Real UmbraDB data.** Every payload here is `randomBytes`. Hash throughput is entropy-independent
   so §2.1 transfers directly; **page packing is not**, so the storage table (§2.3) could shift on
   real JSON, which compresses and packs differently. The blob size distribution is L5's measured
   one, but the *content* is synthetic.

5. **Chain-archive metadata row sizes.** My Tier C storage argument uses an estimated 150–250 byte
   metadata row, interpolated from the §2.3 measurements at 64 B and 256 B. I did not measure a real
   `transactions` row from a populated archive. The direction of the conclusion is robust (small rows
   pay 15–46 %), but the exact percentage for Tier C is interpolated, not measured.

6. **Concurrency across processes.** The verification-pass-vs-writer test used two connections in one
   process. WAL's reader/writer independence is a file-level property so I expect it to hold across
   processes, but I did not test a separate-process writer.

7a. **Read rates in real UmbraDB workloads.** My concession on default-ON verify-on-read (§2.2b)
   rests on the claim that a wallet store does not sustain six-figure reads/s. That is a judgement
   about the workload, not a measurement of it — I measured the *ceiling* (231k/s plain, 161k/s
   verified) but not where real usage sits under it. If some caller does drive a hot read loop, the
   +43–73 % is real and the opt-out matters more than I have allowed.

7. **`sqlite3` CLI behaviour.** Not installed on this host, so the "third-party tooling cannot write
   to a UDF-bearing schema" claim in §4 is demonstrated via a *second binding*
   (`better-sqlite3@13.0.2` — `INSERT: REJECTED -> unknown function: udb_sha256()`) and via `VACUUM`,
   not via the CLI itself. The mechanism is the same (schema parse requires the function), but the
   CLI specifically was not exercised.

---

## 7. Deference

- **Which data is at risk / corruption modes** — the coverage seat. My Tier C exclusion rests on a
  claim about *reconstructibility* (metadata is a projection of digest-covered blobs) that belongs to
  that seat; if it rules the metadata is not reconstructible in practice, Tier C moves to Tier B and
  the cost is +15–46 % storage on the archive's largest tables. I have priced that; I have not
  adjudicated it. **In fact that seat reached the same UNCOVERED verdict on `blocks`, `transactions`,
  `bridge_observations` and `verifier_key_observations` from corruption-mode evidence, so the two
  lenses agree and the adjudicator does not need to break a tie here.**
- **`blocks.is_canonical` and the `ckpt_sequence_counters` / `ckpt_manifests.seq` invariants** — the
  coverage seat proposes bounded read-path invariants and a partial `UNIQUE INDEX` rather than
  digests for these. I have no cost objection: a partial unique index on a 100M-row table is
  vastly cheaper than a 32-byte column on the same table (which §2.3 prices at +15–46 % storage),
  and an index-seek invariant is O(log n) against a digest's O(value). **On cost grounds the
  invariant route is strictly better than the digest route for every Class B item, and I endorse
  it.** Whether the invariants are *sufficient* is that seat's call, not mine.
- **Verify-on-every-read for the COVER set** — I initially ruled opt-in/default-off from blob-sized
  measurements and **withdrew that position** after measuring the real value sizes (§2.2b). No
  disagreement remains.
- **`synchronous=FULL` vs `NORMAL`** — L6's call, not mine. My numbers are given for both because the
  digest's *relative* cost changes by ~100× between them while its absolute cost does not change at
  all.
- **Whether losing page checksums is a 2.0.0-grade regression** — the contract seat. I claim only
  that the replacement detection capability costs 4.49 s per full-database pass and ~3 µs per write.
