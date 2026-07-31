# R-3 — corruption-mode seat

**Question:** which stored data must be covered by application-level integrity digests, and which
may be left uncovered?

**Host:** all experiments run in `/root/corruption-lab` on `/dev/sdd` (ext4, real disk — `findmnt -no
FSTYPE /root` → *(blank, i.e. the root ext4 mount)*; `/tmp` is `tmpfs` and was avoided). Node
v24.18.0, `node:sqlite`, SQLite **3.53.1**. Scripts: `e1-detection-surface.mjs`,
`e3-addressing.mjs`, `e4-invariants-and-rest.mjs`, `e5-blocks-junction-wal-digest.mjs`,
`e6-digest-efficacy.mjs`.

---

## 1. Recommendation

### 1.1 The headline: the draft is split on the wrong axis

The draft splits on **re-derivable vs non-re-derivable**. That axis does not predict whether a
digest helps, because a digest only ever answers one question: *are the bytes I just read the bytes
that were written?* Corruption in this schema comes in three classes, and only one of them is that
question.

| Class | What corruption does | Does a value digest fire? | The right instrument |
|---|---|---|---|
| **A — wrong bytes returned** | the row is found, its payload is wrong | **yes** | application digest, verified on read |
| **B — wrong row returned, or no row returned** | payload of the returned row is perfect; the *addressing* picked the wrong one | **no** — the digest verifies the intact row it was handed | index redundancy (`integrity_check`), or a co-read invariant |
| **C — the rules change** | a `CHECK`/`UNIQUE`/type declaration in `sqlite_schema` is rewritten | **no** — nothing in any covered table changed | schema digest pinned at migrate time, verified at open |

Class B is where UmbraDB's real exposure sits, and the draft has no instrument for it at all. The
sharpest instance is measured in §2.4 below: **one corrupted byte in `ckpt_sequence_counters` makes
the wallet read back a 40-checkpoint-old state forever, while every SHA-256 check passes.** A digest
over the wallet-state envelope is the mechanism the draft proposes, and it is exactly the mechanism
that does not fire.

### 1.2 A second, cheaper axis that does predict detectability

Measured in `e3-addressing.mjs` and confirmed three times: **a column that appears in an index has a
second physical copy of itself, and `PRAGMA integrity_check` cross-checks the two. A column that
appears in no index has one copy and is invisible to every structural check SQLite offers.**

```
[value, 1 site]              integrity_check=ok    read-back={"version":5,"value":"{\"marker\":\"KVVALUE_9999\"}"}
[written_at table only]  2 sites [8003,16302] -> smashed [8003]
  integrity_check : row 5 missing from index kv_event_time
[written_at index only]  2 sites [8003,16302] -> smashed [16302]
  integrity_check : row 5 missing from index kv_event_time; row 6 missing ... (+3)
  quick_check     : ok
```

Two consequences that shape every ruling below:

1. **`quick_check` is worthless for this purpose.** It returned `ok` for *every single* index-vs-table
   divergence I produced (E1-B, E1-D, E3 §3 all three modes, E3 §4 all three modes). The draft's
   §2.3(2) says `integrity_check` **"(or `quick_check`)"`. Delete the parenthesis — `quick_check`
   skips the index cross-check, which is the only thing structural verification contributes here.
2. **Index redundancy gives detection *on demand*, not detection *on read*.** `integrity_check` is a
   whole-database scan; it cannot run on the read path. So for a column whose corruption produces a
   *silent wrong answer the application acts on*, "detectable by `integrity_check`" is not
   sufficient — something must fire at the moment of use. For those columns the answer is a **co-read
   invariant** (§2.4), not a digest and not a scan.

### 1.3 The mandated coverage set

`COVER` = an application-level digest column, written in the same statement as the value, verified
on every read, `ValueIntegrityError` on mismatch.
`INVARIANT` = a bounded (O(log n), index-seek) consistency assertion evaluated on the read path.
`UNCOVERED` = no digest; the stated mechanism is the accepted detection.

| Table | Column(s) | Ruling | Reason |
|---|---|---|---|
| **`kv_event`** | `value` | **COVER** | Class A. Non-re-derivable by any means. 1 site, no index (measured). `integrity_check=ok`, corrupted JSON returned as data. This is the draft's own case and it is correct. |
| `kv_event` | `written_at`, `version` | **UNCOVERED** + **INVARIANT** | Class B. Both carry a redundant index copy (`kv_event_time`, and the `(ns,scope,key,version)` PK auto-index), so `integrity_check` detects single-site damage. But the read path acts on them: a corrupted `written_at` made `getAt(t0+5500)` return **version 4 instead of 5**, and made `kv_validity` emit `valid_to < valid_from` — an interval `Model.lean`'s `validityIntervals` cannot denote. Add a read-path assertion that the row returned by `getAt` satisfies `valid_from ≤ at < valid_to` and that `version` is contiguous with its neighbour. Do **not** fold these into the value digest: a digest over `(value ‖ version ‖ written_at)` still verifies clean when the *index* copy is the damaged one. |
| **`watermarks.value`** (both lineages — wallet and chain-archive) | `value` | **COVER** | Class A, and the single most consequential one. See §3.1: this is the auditor's leak, and it is worse than reported — the anti-regression guard **latches** the corruption permanently. R-3's offered alternative ("or add the on-demand cursor-not-ahead-of-data check") is **not implementable**: `WatermarkKind`/`WatermarkKey` are `string` and `WatermarkValue` is `z.json()` (`src/interfaces/watermarks.ts:19-22`), so the primitive cannot know the value shape, and for the wallet-sync cursor there is no data side inside UmbraDB to compare against (measured, §3.1). Digest is the only available instrument. |
| **`transaction_history.entry`** | `entry` | **COVER** | Class A. `entry` is JSON text, 1 site, no index. It is the *only* copy of the transaction's lifecycle detail and merge state; nothing re-derives a locally-merged `TransactionHistoryEntry` from chain (the merge is first-writer-wins over caller-supplied sections). The draft omits this table from its coverage set; the omission is not defensible. |
| `transaction_history` | `lifecycle` | **UNCOVERED** | Class A, but already covered twice: it carries a named `CHECK (lifecycle IN (...))` which `integrity_check` **and** `quick_check` both evaluate (measured, E1-E: `CHECK constraint failed in t` from both), and the same discriminant is duplicated inside `entry`, which is COVERed. Cross-check `entry.lifecycle.status === lifecycle` on read; that is free. |
| `transaction_history_identifiers` | all | **UNCOVERED** | Class A, and the most redundant table in the schema: every identifier exists at **3 sites** — inside `entry`'s JSON, in the `WITHOUT ROWID` PK b-tree, and in `<s>_th_ident_reverse` (measured: `'IDENTIFIER_AAAA' appears at 3 sites [8110,12273,16366]`). Corrupting the PK copy produced *two* `integrity_check` errors and the query still answered correctly from the reverse index. Derive-and-compare against `entry.identifiers` (`src/interfaces/transaction-history-storage.ts:206`) instead of adding a fourth copy. |
| **`ckpt_sequence_counters.next_seq`** | `next_seq` | **UNCOVERED** + **INVARIANT (mandatory)** | Class B, the worst case in the schema. §2.4. A digest here would fire only if the counter row itself were read *and* damaged; it does not help because the damage is expressed through a *different* table's read. Mandate instead: `next_seq > max(seq)` asserted inside the same transaction as every `save()`/`load()`, **and** add the missing `UNIQUE (w, net, seq)`. |
| **`ckpt_manifests.seq`** | `seq` | **UNCOVERED** + **INVARIANT (mandatory)** | Class B. Indexed, so `integrity_check` detects single-site damage — but it detected damage in *all three* of my modes while the **answer was wrong in two of them** and right in one, so `integrity_check` alone tells you nothing about whether you were served a stale checkpoint. The `next_seq > max(seq)` invariant catches exactly the two answer-changing modes (measured, §2.4). |
| `ckpt_manifests` | `w`, `net`, `complete`, `manifest_hash`, `label`, `created_at` | **UNCOVERED** | `manifest_hash` is self-verifying (`checkpoint-store.ts:378` recomputes it and throws `ManifestCorruptError` — fail-closed). `w`/`net`/`complete` are all in `ckpt_manifests_lookup`, so single-site damage is `integrity_check`-detectable, and damage to any of them makes the manifest *unfindable*, not *wrong* — `CheckpointNotFoundError`, loud. `label`/`created_at` are diagnostic. |
| `ckpt_chunks` | `hash`, `data` | **UNCOVERED — already covered** | **Verified in code, not assumed.** `checkpoint-store.ts:366-368` recomputes `sha256(row.data)` on every load and throws `ChunkIntegrityError` on mismatch. The hash is *not* decorative; it is a real rehash-on-read. A second digest column would be strictly redundant. The draft is right here. |
| `ckpt_manifest_chunks` | `manifest_id`, `position`, `chunk_hash` | **UNCOVERED — already covered** | Triply: the dense `position !== i` check (`:355`), the `LEFT JOIN`-null `ChunkMissingError` (`:363`), and the recomputed `manifest_hash` over the ordered chunk-hash sequence (`:378`), which the code's own comment says exists to catch junction-row substitution. Fail-closed on all three paths. |
| **wallet-state envelope** | — | **N/A — the spec names a table that does not exist** | See §3.4. `PgWalletStateEnvelopeStore` "Adds NO new table or migration — it reuses `CheckpointStore`'s own chunk/manifest storage entirely" (`src/postgres/wallet-state-envelope.ts:12-13`). Its *content* is already covered by `ckpt_chunks`'s rehash-on-read; its *addressing* is the `ckpt_sequence_counters` hole above. There is nothing to put a digest column on. |
| **`sqlite_schema`** (implicit) | `sql` text of every object | **COVER (new — no lane found this)** | Class C. §3.5. A corrupted `CHECK` text **silently weakens** the constraint: `integrity_check` = `ok`, and a 7-byte value was then accepted into a `octet_length(h) = 32` column (measured). Change 4's entire `STRICT` + named-`CHECK` regime is itself unprotected. Fix is cheap: `sha256` over `SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name,type`, pinned by the last migration, verified at `open()`. One query. |
| `_migrations` | `name`, `applied_at` | **UNCOVERED** | Class B but fail-loud *by accident, and the accident must be made a rule*. Corrupting `007_writer_generation` → `007_Xriter_generation` gave `integrity_check=ok`; `runMigrations` then sees 007 as unapplied and replays it. That aborts on `CREATE TABLE ... already exists`. Make this a written invariant: **every migration's first statement must be non-idempotent DDL, and `runMigrations` must run each migration in one transaction.** 007 already contains an `INSERT` seed; if a future migration is reordered so an idempotent statement comes first, the replay becomes silent. |
| `writer_generation` | `generation`, `owner`, `pid`, `host`, `registered_at` | **UNCOVERED** | Fail-closed. Corrupting `generation` made the guard read `1000000099` against `myGeneration=1000000007` → `WriterDisplaced`, non-retryable, loud (measured). The protocol compares, it does not trust an absolute value. `pid`/`host` are explicitly "diagnostic only, never authoritative" (change 3 §2.2). |
| `writer_generation` | `id` | **UNCOVERED** + **assert `changes === 1`** | Class B, and it re-creates a hazard the project already identified. Corrupting the rowid `1 → 9` made the registration `UPDATE ... WHERE id = 1` report `changes=0` and the read-back return `null` — **`myGeneration` undefined with no error**, verbatim the failure `schema-parity/design.md` §9.4 says the seed row exists to prevent. `integrity_check` *does* catch it (`CHECK constraint failed in wg`), but that runs on demand and this runs at `open()`. Assert `changes === 1` and `readback !== undefined` in the registration protocol. |
| `chain_blobs` | `hash`, `data` | **UNCOVERED — already covered** | **Verified in code.** `chain-archive-store.ts:490-492`: `const actualHash = sha256Hex(data); if (actualHash !== hash) throw new BlobIntegrityError(...)`, with a comment naming it AC-3 rehash-on-read and explicitly *"rather than trusting the key was correct at write time."* Real, not decorative. |
| `chain_blob_roles` | `blob_hash`, `role` | **UNCOVERED** | Both columns are the PK; corruption makes a role lookup miss (loud-ish: a blob classified as neither header nor body) and is `integrity_check`-detectable via the PK b-tree ordering check. **Note: this table is absent from R-3's own table list** — the enumeration is not yet exhaustive. |
| **`blocks`** | `is_canonical`, `status`, `finalized`, `height` | **UNCOVERED** + **INVARIANT** | Class B, and *not* covered by `getBlob`'s rehash — §3.3. Flipping one serial-type byte turned a non-canonical fork block canonical: `canonicalCount` 20 → 21, two canonical blocks at the same height, `integrity_check = ok` (measured). The attached header blob still passes its SHA-256: the *bytes* are fine, the *classification* is not. A per-row digest **would** work here (the row is returned, its content is wrong) — but the cheaper and stronger instrument is the invariant the store already implies: **at most one canonical block per `(net, height)`**, expressible as a partial `UNIQUE INDEX ... WHERE is_canonical = 1`, which makes the corrupted state structurally unrepresentable *and* `integrity_check`-detectable. Prefer that to a digest column on a 100M-row table. |
| `blocks` | `block_hash`, `parent_hash`, `state_root`, `extrinsics_root`, `author`, `header_blob_hash`, `body_blob_hash` | **UNCOVERED** | Genuinely re-derivable, and the re-derivation does not depend on the corrupted datum: every one of these is recoverable by re-fetching the block from a node keyed on `height`, and `header_blob_hash` is validated transitively the moment `getBlob` is called on it. |
| `transactions` | `raw_blob_hash` and content columns | **UNCOVERED** | Same as `blocks`. `raw_blob_hash` is validated by `getBlob`'s rehash on use. `position`/`kind`/`result` are re-derivable from the raw blob itself, which is content-addressed. |
| `bridge_observations`, `verifier_key_observations` | all | **UNCOVERED** | Same. Both are indexes *into* content-addressed blobs; the authoritative bytes are in `chain_blobs` and are rehash-verified. |

**Net cost of this ruling vs. the draft:** three digest columns instead of two-and-a-half (`kv_event.value`,
`watermarks.value`, `transaction_history.entry`), plus one schema digest (a single `open()`-time
query), plus three invariants that are index seeks, plus one missing `UNIQUE` and one partial
`UNIQUE INDEX` that should have been there on correctness grounds regardless. **No digest column on
any chain-archive row table** — that is where the write-path cost would actually have hurt, and it
is not needed.

---

## 2. Table-by-table analysis: the measurements

### 2.1 The detection surface (`e1-detection-surface.mjs`)

```
$ wsl -e bash -lc 'cd /root/corruption-lab && node e1-detection-surface.mjs'
sqlite 3.53.1

A. rowid-table LEAF payload  (offset 21474 of 28672)
  integrity_check : [{"integrity_check":"ok"}]
  quick_check     : [{"quick_check":"ok"}]
  read-back       : {"payload":"PAYLOAD_000400_XXXXXXXXXXXXXXXX"}

B. secondary INDEX key       (table copy @39415, index copy @41661, size 53248)
  integrity_check : [{"integrity_check":"row 400 missing from index t_tag"}]
  quick_check     : [{"quick_check":"ok"}]
  read-back       : {"byIndex":null,"byScan":{"id":400}}

C. WITHOUT ROWID leaf value  (offset 25652 of 32768)
  integrity_check : [{"integrity_check":"ok"}]
  quick_check     : [{"quick_check":"ok"}]
  read-back       : {"v":"VAL_000400_WWWWWWWWWWWWWWWW"}

D. WITHOUT ROWID PRIMARY KEY (offset 24484 of 24576)
  integrity_check : [{"integrity_check":"row not in PRIMARY KEY order for t"}]
  quick_check     : [{"quick_check":"ok"}]

E. CHECK-violating value     (offset 3991 of 24576)
  integrity_check : [{"integrity_check":"CHECK constraint failed in t"}, ... x100]
  quick_check     : [{"quick_check":"CHECK constraint failed in t"}, ... x100]
```

Four results that matter:

- **A and C**: the hole is the same for rowid and `WITHOUT ROWID` tables. Since change 4 makes
  `watermarks`, `transaction_history`, `_migrations`, `ckpt_sequence_counters` and
  `ckpt_manifest_chunks` all `WITHOUT ROWID`, none of them gains anything from that choice here.
- **B**: `byIndex: null, byScan: {"id":400}` — **the row is silently omitted from an indexed
  lookup while still existing in the table.** This is the general form of the auditor's insight: a
  digest cannot fire on a row that is never returned. Corruption by omission is a first-class class,
  not a watermarks quirk.
- **E**: `CHECK` constraints **are** evaluated by both `integrity_check` and `quick_check`. This is
  load-bearing for the ruling — every named `CHECK` change 4 adds is genuine, cheap coverage. (Note:
  the 100-row cap is `integrity_check`'s default error limit; my probe accidentally hit the
  constraint's *text* in `sqlite_schema`, which is finding §3.5.)
- Across all six probes `quick_check` never once reported something `integrity_check` missed, and
  missed the index cross-check every time.

### 2.2 `kv_event` — the draft's own case, confirmed and bounded

`value` has **1 site**, no index. Corrupting it: `integrity_check=ok`, and
`{"marker":"KVVALUE_9999"}` is returned to the caller in place of `KVVALUE_0005`. The draft's
central claim holds; **COVER** is correct.

But `written_at` has **2 sites** and its corruption is a different class:

```
[written_at index only] 2 sites [8003,16302] -> smashed [16302]
  integrity_check : row 5 missing from index kv_event_time; row 6 ...; row 7 ...; row 8 ...; row 9 ...
  quick_check     : ok
  getAt(t0+5500)  : {"version":4,"value":"{\"marker\":\"KVVALUE_0004\"}"}   (uncorrupted: version 5)
  kv_validity     : [{"version":4,"f":4000,"t":5000},{"version":5,"f":5000,"t":6000},...]
```

The wrong version is returned and *its digest is perfect*. Note also the `kv_validity` view reports
the **uncorrupted** intervals here (it reads the table copy) while `getAt` reads the index copy —
so the derived-interval view and the point-read disagree about the same key, and neither is
self-evidently wrong. Under table-copy-only corruption the view instead emits
`{"version":5,"f":9500,"t":6000}` — `valid_to < valid_from`, a value `Model.lean:57-62`'s
`validityIntervals` cannot denote. The `kv_event_bi` trigger does not help: **BEFORE-INSERT
triggers never re-run on rows already on disk**, and the `UNIQUE` index on
`(ns,scope,key,written_at)` is still satisfied because the corrupted instant collides with nothing.

### 2.3 `watermarks` — see §3.1 (the leak, and why it is worse than reported)

### 2.4 `ckpt_sequence_counters` — the strongest finding

Faithful transcription of `PgCheckpointStore.saveImpl`'s seq allocator (`checkpoint-store.ts:238-247`)
and `loadImpl`'s `ORDER BY seq DESC LIMIT 1` + full rehash verification (`:329-383`):

```
$ wsl -e bash -lc 'cd /root/corruption-lab && node e3-addressing.mjs'
before : load() -> {"seq":1000000039,"data":"ENVELOPE_STATE_AT_BLOCK_000039","allSha256Checks":"PASSED"}
         next_seq = 1000000040
next_seq 1000000040 appears at 1 site(s) in the file: [32764]  (no index covers it)
corrupted 4 bytes at 32764: next_seq 1000000040 -> 1000000005
integrity_check : ok
quick_check     : ok
save() -> seq 1000000005  (succeeded; there is NO UNIQUE (w,net,seq) on ckpt_manifests)
after  : load() -> {"seq":1000000039,"data":"ENVELOPE_STATE_AT_BLOCK_000039","allSha256Checks":"PASSED"}
dupes  : [{"seq":1000000005,"c":2}]
```

Read that carefully. The wallet **successfully saved** a new state, got no error, and then
**loaded back a 34-checkpoint-old state** — and `allSha256Checks: PASSED`, because every chunk hash,
every junction position and the manifest hash are all perfectly intact. The freshly-saved envelope
is unreachable, and it will stay unreachable: every subsequent `save()` allocates `1000000006`,
`1000000007`, … all still below the pre-existing maximum. **The store is permanently, silently
frozen at a stale checkpoint while reporting success on every write.**

The proposed digest over "the wallet-state envelope" cannot see this. The envelope's bytes are not
corrupt. Its *reachability* is.

No `UNIQUE` constraint stands in the way — confirmed in both engines:

```
$ wsl -e bash -lc 'grep -in "unique" /root/UDB-sqlite-sprint/src/postgres/migrations/002_checkpoint_store.ts'
(no output)
$ wsl -e bash -lc 'grep -n "ckpt_manifests_lookup" .../v1.0.0-sqlite-schema-parity/design.md'
878:CREATE INDEX <s>_ckpt_manifests_lookup
```

**The instrument that does work** — two index seeks, no scan (`e4-invariants-and-rest.mjs`):

```
clean                      : {"next_seq":1000000010,"max_seq":1000000009,"holds":true}
next_seq -> BASE+5         : {"next_seq":1000000005,"max_seq":1000000009,"holds":false}  integrity_check=ok
seq index-copy -> BASE+99  : {"next_seq":1000000010,"max_seq":1000000099,"holds":false}  integrity_check=row 2 missing from index m_lookup
seq table-copy -> BASE+99  : {"next_seq":1000000010,"max_seq":1000000009,"holds":true}   integrity_check=row 2 missing from index m_lookup
```

The invariant catches both cases that change the answer; the one case it misses does not change the
answer and *is* caught by `integrity_check`. Together they are complete over this table pair. A
digest column is neither necessary nor sufficient.

### 2.5 `ckpt_manifests.seq` alone — why `integrity_check` is not a verdict

```
[table-copy only]  integrity_check : row 2 missing from index u_ckpt_manifests_lookup
                   latest : {"seq":1000000009,"label":"SEQMARK_009"}   <- CORRECT
[index-copy only]  integrity_check : row 2 missing from index u_ckpt_manifests_lookup
                   latest : {"seq":1000000099,"label":"SEQMARK_002"}   <- WRONG, 7 checkpoints stale
[both copies]      integrity_check : row 2 missing from index u_ckpt_manifests_lookup
                   latest : {"seq":1000000099,"label":"SEQMARK_002"}   <- WRONG
quick_check        : ok in all three
```

Identical `integrity_check` output for a correct answer and a wrong one. Structural verification
tells you *something is damaged*; it does not tell you *you were served stale state*. Only the
invariant distinguishes them.

### 2.6 `blocks.is_canonical` — a hash on the payload does not protect the classification

```
$ wsl -e bash -lc 'cd /root/corruption-lab && node e5-blocks-junction-wal-digest.mjs'
before: {"rows":[{"height":1000000010,"bh":"35F9047E","is_canonical":1},
                 {"height":1000000010,"bh":"E5BD4963","is_canonical":0}],"canonicalCount":20}
flipped is_canonical serial type at 15477 (0x08 -> 0x09)
integrity_check : ok
after : {"rows":[{"height":1000000010,"bh":"35F9047E","is_canonical":1},
                 {"height":1000000010,"bh":"E5BD4963","is_canonical":1}],"canonicalCount":21}
```

One byte. Two canonical blocks at one height. `integrity_check` clean. `getBlob()` on either block's
header still passes its AC-3 rehash, because the blob is genuinely intact — what changed is which
fork the archive believes it is on. `getCanonicalBlocks(from,to)` now returns both. The fix is a
partial `UNIQUE INDEX ... WHERE is_canonical = 1`, which makes the state unrepresentable rather
than merely detectable, at the cost of one index on a table that already has several.

### 2.7 Corruption sources, and where the WAL boundary actually is

Verified (`e5`, §I): 200 rows written with `wal_autocheckpoint=0`, main file **4096 B**, WAL
**844632 B**; a payload byte corrupted *inside the `-wal`*; a second connection then read
`rows=200 corrupted=0 err=null`. SQLite's two per-frame checksums caused the damaged frame and
everything after it to be treated as uncommitted, so the reader saw a shorter but **consistent**
history. L6's "torn-page hazard structurally absent" is right *about the WAL*. **The exposure window
opens the instant `wal_checkpoint` moves a page into the main file and never closes.**

| Source | Reaches | Detected by |
|---|---|---|
| Bit rot / bad sector on the main DB | any page, post-checkpoint | digest (Class A) or `integrity_check` if the column is indexed; **nothing** otherwise |
| Bit rot in the `-wal` | WAL frames | **SQLite itself** — frame checksums, measured above |
| Truncated / short file | tail pages | `integrity_check`. 75% truncation → hard `SQLITE_CORRUPT` on any query; 99.9% truncation → `count(*)` returned all 2000 rows **silently**, and only `integrity_check` reported `Rowid 0 out of order` / `NULL value in t.v`. So truncation is loud-ish but not always loud on the read path. |
| Interrupted checkpoint | main-file pages mid-write | WAL is the recovery source; SQLite handles it. Not an application concern. |
| Restored-from-bad-backup file | **every page coherently** | The one source that can damage a value *and* its digest *and* both index copies consistently. Nothing detects this; it is the honest residual, and it belongs in the `docs/CONTRACT.md` §1 disclosure. |
| WSL2 VHDX / network FS | arbitrary ranges; also breaks POSIX locking assumptions | same as bit rot for the data half |

### 2.8 Does a digest stored next to its value still work? Yes.

The draft's §2.3(3) concedes "a digest stored adjacent to its value can in principle be damaged by
the same event." Measured (`e6-digest-efficacy.mjs`, after `VACUUM` so every hit is a live cell):

```
baseline sweep            : {"checked":400,"mism":0,"unread":0,"threw":null}
[value only, 4B]   smashed 4B  at 31019   digest sweep : {"checked":400,"mism":1,...}  integrity_check: ok
[value only, 16B]  smashed 16B at 31019   digest sweep : {"checked":400,"mism":1,...}  integrity_check: ok
[value+digest smear, 64B]  k0200 now ...ZZZZZZZZ  digest 5A5A5A5A5A5A5A5A...
                                          digest sweep : {"checked":400,"mism":1,...}  integrity_check: ok
```

The 64-byte smear demonstrably overwrote **both** the value tail and the digest BLOB (`digest
5A5A5A5A…`) and the comparison still failed. Co-location weakens the digest only against a
corruption that produces a *second internally-consistent (value, SHA-256) pair* — which is a forgery,
not a fault. The concession should be reworded: co-location is fine; **the real residual is the
coherent bad restore**, which is a different thing and is the one worth writing down.

---

## 3. Circularity findings

Every place a "re-derivable" classification depends on something that could itself be corrupt.

### 3.1 The cursor decides how much to re-derive — and the anti-regression guard latches the damage

The auditor's finding, reproduced and extended:

```
corrupted 1 byte-run at offset 8168: height 1200000 -> 9200000 (JSON stays valid)
integrity_check : ok
get()           : {"height":9200000}   <-- returned to the caller as data
  legitimate setWatermark(1200001) -> stored height is now 9200000
  legitimate setWatermark(1300000) -> stored height is now 9200000
  legitimate setWatermark(5000000) -> stored height is now 9200000
  legitimate setWatermark(9199999) -> stored height is now 9200000
```

Three compounding facts:

1. `PgWatermarks.getImpl` has **no read-side validation at all** — its own comment says so: *"No
   read-side validation against `WatermarkValueSchema`, unlike `PgTemporalKV.get` … the row's value
   is returned exactly as the driver parsed it. Validation runs once, at the `set()` boundary, and
   nowhere on this read path."* (`src/postgres/watermarks.ts`). There is no existing hook where a
   corrupted cursor could be caught.
2. `PgChainArchiveStore.setWatermark`'s monotonic `ON CONFLICT … WHERE` guard — added as *"Fix 5
   (sprint-fix round, MEDIUM): a monotonic guard against watermark regression"* — **converts a
   transient corruption into a permanent one.** No honest write can ever lower the cursor again.
   A defence against a concurrency bug became a corruption-latch. Nothing in the corpus notes this.
3. The damage is *by omission* and is invisible at every layer: blocks 1.2M–9.2M are never fetched,
   so the `kv_event` rows that would have recorded them are never written. Their digests are not
   wrong. They do not exist. **The non-re-derivable tier is damaged without a single byte of it
   being corrupted.**

And R-3's offered escape hatch does not exist:

```
chain-archive cursor: 9200050   max(blocks.height): 1200050   cursor_ahead_of_data = true
  -> for the CHAIN-ARCHIVE cursor a data side exists, so the check is real and cheap.
WALLET-SYNC cursor  : names a chain height whose data lives on the NODE, not in this
  store. UmbraDB holds no max(height) to compare against.
```

Plus a generic blocker: `WatermarkKind` and `WatermarkKey` are both bare `string`, and
`WatermarkValue` is `z.json()` (`src/interfaces/watermarks.ts:19-27`). The primitive is deliberately
shape-agnostic — the chain-archive store's own guard has to defensively test
`jsonb_typeof(value->'height') IS DISTINCT FROM 'number'` and fall through for any other shape. A
generic "cursor not ahead of data" check is therefore **not implementable at the `Watermarks`
level**. R-3 must take the first horn: **COVER**.

**The severity is set by the project's own documents.** `docs/checkpoint-store-contract.md:20-21`:
*"A cursor that is ahead of durable data is the silent-skip failure: on resume the sync believes it
has already persisted data that a crash actually lost, and never re-fetches it."* An entire v1.0.0
change (`v1.0.0-durable-checkpoint-cursor`) and a whole contract document exist to make that state
unreachable *by crash*. A one-byte flip reaches the identical state and bypasses all of it. Leaving
the datum uncovered while shipping that change is internally inconsistent.

### 3.2 The checkpoint tier is classified re-derivable but *is the physical home of* the non-re-derivable tier

`design.md` §2.2 asserts *"checkpoints, watermarks and the archive are re-derivable from chain;
TemporalKV history is not."* But `PgWalletStateEnvelopeStore` stores the wallet-state envelope
**inside `ckpt_chunks`/`ckpt_manifests`** and adds no table of its own. So `ckpt_*` is
simultaneously in both tiers, and §2.4's measurement shows the re-derivable half's corruption
(`next_seq`) silently destroys the non-re-derivable half's accessibility. The tier boundary does not
follow a table boundary; it cannot be used to assign coverage.

### 3.3 `chain_blobs` is re-derivable — but the re-derivation is keyed by the thing that corrupts

`blocks.height` and `blocks.is_canonical` are the coordinates you would use to re-fetch a block from
a node. If `height` is corrupt you re-fetch the wrong block; if `is_canonical` is corrupt you
re-derive along the wrong fork and every re-fetched blob is content-valid and semantically wrong.
The blob layer's rehash-on-read (real, verified) protects the payload of whatever you asked for; it
has nothing to say about whether you asked for the right thing. This is the same circularity as
§3.1, one layer down.

### 3.4 The draft's coverage set names a storage location that does not exist

The requirement reads: *"at minimum the TemporalKV value tables **and the wallet-state envelope**."*
The very next scenario in the same requirement says `ckpt_chunks`/`ckpt_manifests` *"SHALL be
covered by their existing content-addressed SHA-256 verification rather than by a second, redundant
digest column."* The envelope **is** `ckpt_chunks` rows. As written, the spec both mandates and
forbids coverage of the same bytes, and §2.2's claim that *"the wallet-state envelope [has] no
digest"* is already false — it has had the chunk rehash since sprint 3. The implementer has no
buildable instruction here. Replace the phrase with the three concrete columns in §1.3 plus the
`ckpt_sequence_counters` invariant.

### 3.5 The schema is itself uncovered, and its corruption is *silent* (no lane found this)

```
sqlite_schema CHECK text 'octet_length(h) = 32' -> 'octet_length(h) > 00' at 4067
integrity_check : ok
schema now reads: CREATE TABLE t (id INTEGER PRIMARY KEY, h BLOB NOT NULL
                    CONSTRAINT t_h_len CHECK (octet_length(h) > 00)) STRICT
INSERT of a 7-byte hash into a 32-byte-CHECK column: ACCEPTED  <-- constraint silently gone
```

E1-E established that `integrity_check` *does* evaluate `CHECK` constraints — which is precisely
why this is dangerous: a corruption that makes a constraint **stricter or violated** is caught
loudly, and a corruption that makes it **weaker** is caught by nothing, because no existing row
violates the weakened predicate. The whole of change 4's defence-in-depth (`STRICT`, named `CHECK`s,
`json_valid`, `octet_length(hash)=32`, the `lifecycle` enum, `CHECK (id=1)`, `CHECK (generation>=0)`)
is a set of guarantees stored in an unprotected 4 KB region of the same unchecksummed file. This is
also the only class where corruption is *forward-acting*: it does not damage existing data, it
permits future bad data.

This is Class C and no per-value digest reaches it. A schema digest pinned by the last migration and
verified at `open()` closes it for one query's cost, and as a bonus detects an out-of-band `ALTER`,
a dropped index, or a third-party tool having touched the file.

### 3.6 `_migrations` is re-derivable only if replay is loud, which is currently an accident

Corrupting a migration name is `integrity_check`-clean and causes replay. Replay is safe *today*
because every migration begins with non-idempotent DDL. `007_writer_generation` ends with an
`INSERT` seed; nothing in the lineage rules forbids a future migration from *starting* with an
`INSERT … ON CONFLICT DO NOTHING` or a `CREATE TABLE IF NOT EXISTS`, at which point replay becomes
silent and partial. The "re-derivable" classification is conditional on a property no document
currently states. State it.

### 3.7 `writer_generation.id` — corruption re-creates a hazard the project already designed around

`schema-parity/design.md` §9.4 seeds the singleton row specifically because the registration
protocol is an `UPDATE`, which *"would match zero rows and leave `myGeneration` undefined with no
error."* Corrupting the rowid reproduces that exactly:

```
D2 rowid 1 -> 9  : table now holds [{"id":9,"generation":1000000007}]
   registration UPDATE ... WHERE id=1 -> changes=0; read-back = null
   integrity_check = CHECK constraint failed in wg
```

The seed row defends against *absence*; it does not defend against *displacement*. `integrity_check`
catches it, but `open()` does not run `integrity_check`. Asserting `changes === 1` costs nothing and
converts a silent single-writer-exclusion failure into a startup error.

---

## 4. What I tested, and what I could not

### Tested (commands and output above)

- Detection surface of `integrity_check` / `quick_check` across six corruption shapes on SQLite
  3.53.1: rowid leaf, secondary index key, `WITHOUT ROWID` leaf, `WITHOUT ROWID` PK, `CHECK`
  violation, record header.
- The index-redundancy rule, on three columns (`ckpt_manifests.seq`, `kv_event.written_at`,
  `transaction_history_identifiers.identifier`), each corrupted at table-copy / index-copy / both.
- `ckpt_sequence_counters.next_seq` end-to-end against a faithful transcription of
  `saveImpl`/`loadImpl` including the full SHA-256 verification chain.
- The `next_seq > max(seq)` invariant against four states (clean + three corruptions).
- `watermarks.value` corruption + four subsequent legitimate `setWatermark` calls through a SQLite
  transcription of the real monotonic `ON CONFLICT … WHERE` guard.
- `blocks.is_canonical` single-serial-type-byte flip.
- `writer_generation.generation` and `.id`.
- `_migrations.name`.
- `sqlite_schema` `CHECK`-text weakening, followed by an `INSERT` that the original constraint
  forbade.
- WAL-frame corruption read by a second connection.
- Digest efficacy at 4 / 16 / 64 / 200-byte smash widths, post-`VACUUM` so every hit is a live cell.
- File truncation at 75% and 99.9%.
- Code reading, not assumption, for the two "is the hash verified or decorative?" questions:
  `src/postgres/checkpoint-store.ts:366-368` (`ChunkIntegrityError`), `:378` (manifest rehash),
  `:355` (dense position), `:363` (`ChunkMissingError`); `src/postgres/chain-archive-store.ts:490-492`
  (`BlobIntegrityError`, AC-3). **Both are genuine rehash-on-read, not decorative keys.**
- Absence of `UNIQUE (w, net, seq)` in both the Postgres migration and the proposed SQLite DDL.

### Not tested — stated as inference or left open

- **PostgreSQL's side.** `data_checksums` and `amcheck` are citations; there is no PostgreSQL server
  on this host. The *regression* framing does not depend on my re-verifying them.
- **Real bit rot.** Every corruption here is a deliberate `pwrite`. I have not shown that any of
  these byte patterns is a *likely* physical fault — only that if the bytes change, this is what
  happens. Probability is out of my lens; consequence is in it.
- **Scale.** All databases are 4 KB–850 KB, single-page-cache-resident. `integrity_check`'s runtime
  on a multi-GB archive is unmeasured, and it is the load-bearing input to "how often can the
  on-demand pass actually run?" That number should be measured before `verifyIntegrity` is specified
  as an operational recommendation rather than a diagnostic. **This is the one open question I would
  hand to another seat.**
- **Digest write cost.** Unmeasured here by design — §2.4 of the draft assigns it to change 1's gate.
  My ruling *reduces* the covered set to three columns and adds no digest to any chain-archive row
  table, which should make that measurement easier to pass, but I did not measure it.
- **`blocks` row-digest vs partial-unique-index trade-off.** I argue for the index on cost grounds
  (100M-row table) without having measured either. If the measurement contradicts me, the digest is
  the safe fallback; the ruling that `is_canonical` needs *something* is measured and firm.
- **The coherent bad-restore case.** I assert nothing detects it. I did not construct one — it is a
  definitional claim (a self-consistent file passes every self-consistency check), not an empirical
  one, and I flag it as such.
- **`transaction_history`'s new identifier junction under change 4's exact DDL.** I used the
  proposed DDL, but the reverse index name and the `entry` merge semantics were transcribed from the
  interface, not exercised against the real `PgTransactionHistoryStorage`.

### One correction to the draft's own text, not a coverage question

`design.md` §2.3(2) specifies the verification pass as `PRAGMA integrity_check` **"(or
`quick_check`)"**. Across every index-vs-table divergence I produced — six independent cases —
`quick_check` returned `ok` while `integrity_check` reported the fault. `quick_check` skips exactly
the cross-check that makes structural verification worth running here. The alternative must be
removed from the spec, not left as an implementer's choice.
