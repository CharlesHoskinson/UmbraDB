# R-3 ruling — application-level integrity digests (blocking gate, adjudicated)

**Adjudicator:** Fable (Claude Opus 5), 2026-07-31.
**Inputs:** all three council seats in `/root/umbradb-sqlite-research/council-r3/` read in full
(`corruption-modes.md`, `cost-mechanism.md`, `contract-precedent.md`); change 5 draft
(`openspec/changes/v1.0.0-sqlite-durability-contract/`), change 4 §17–18, change 6 §10; independent
re-tests on the ruled binding (§3, script `/root/r3-adjudicate/retest.cjs`).
**Status: gate R-3 is CLOSED by this document.** Change 5's author edits to match; no further round.

---

## 1. Ruling

The draft's axis (re-derivable vs non-re-derivable) is replaced by the corruption-modes seat's
three-class model as the analytical frame: **Class A** (wrong bytes returned) is answered by a
digest; **Class B** (wrong row / no row returned) is answered by invariants and index redundancy,
never by a digest; **Class C** (`sqlite_schema` text corruption) is answered by the change-4 schema
digest verified at open. The re-derivability test survives *inside* Class A as the obligation test:
non-re-derivable Class-A exposure ⇒ COVER.

### 1.1 The coverage set — wallet-tier database file

| Table | Column(s) | Ruling | Mechanism / reason |
|---|---|---|---|
| `kv_event` | `value` | **COVER** | Class A, non-re-derivable, 1 site, no index. Digest per §1.3, verified on **every** read, `ValueIntegrityError` on mismatch. |
| `kv_event` | `written_at`, `version` | **UNCOVERED + INVARIANT I-3** | Class B. Do **not** fold into the digest — index-copy damage passes any row digest (measured). Read-path assertion per §5. |
| `watermarks` | `value` | **COVER** | Class A and the single most consequential row in the file: a corrupted-high cursor silently skips a block range, the monotonic guard **latches** it, and the omitted `kv_event` rows are lost without one covered byte changing. No generic data-side check is implementable at the `Watermarks` primitive (`WatermarkValue` is `z.json()`). Plus invariant I-6 (anti-latch). |
| `transaction_history` | `entry` | **COVER** | Class A, only copy of merged lifecycle detail, not re-derivable (first-writer-wins merge over caller-supplied sections). The draft's omission of this table is overruled. |
| `transaction_history` | `lifecycle` | UNCOVERED | Named `CHECK` evaluated by both pragmas (measured) + free cross-check I-7a (`entry.lifecycle.status === lifecycle` on read). |
| `transaction_history_identifiers` | all | UNCOVERED + I-7b | 3 physical sites per identifier (measured); derive-and-compare vs `entry.identifiers` on read instead of a fourth copy. |
| `ckpt_chunks` | `hash`, `data` | UNCOVERED — **already covered** | Rehash-on-read is real: `checkpoint-store.ts:366-368` → `ChunkIntegrityError`. A second digest is forbidden as redundant. |
| `ckpt_manifests` | `manifest_hash` etc. | UNCOVERED — already covered | Manifest rehash `:378`, dense-position `:355`, `ChunkMissingError` `:363`; lookup columns are indexed and make manifests unfindable-not-wrong. |
| `ckpt_manifests` | `seq` | UNCOVERED + invariant | **Closed by change 4** (`next_seq > max(seq)` mandatory + migration `008` `UNIQUE (w, net, seq)` defence-in-depth). Recorded, not re-opened, not duplicated. |
| `ckpt_sequence_counters` | `next_seq` | UNCOVERED + invariant | Same — closed by change 4. A digest here is neither necessary nor sufficient (measured: the freeze is expressed through a different table's read). |
| **wallet-state envelope** | — | **N/A — spec text must be fixed** | `PgWalletStateEnvelopeStore` adds **no table**; the envelope *is* `ckpt_chunks` rows (content already rehash-verified) addressed via `ckpt_sequence_counters` (change 4's invariant). The phrase "and the wallet-state envelope store" **must be deleted from the coverage requirement** (`specs/release-contract/spec.md:142`, `acceptance.md` C3, `tasks.md:158`) and replaced by the explicit column list in this table. As drafted the spec mandates and forbids covering the same bytes; that contradiction is resolved by this ruling. |
| `sqlite_schema` (implicit) | `sql` text | **COVER — via change 4's schema digest** | Class C. Change 4 owns the artifact and records it at the end of every successful `runMigrations`. **Change 5 owns**: verified at `open()` and inside `verifyIntegrity()`; mismatch raises `DatabaseCorruptError` (`DATABASE_CORRUPT`) with detail `schemaDigest` — see §7 for why this one failure is open-scoped. Labelled corruption detection, not tamper protection. |
| `_migrations` | all | UNCOVERED + rule I-5 | Replay is loud only by accident today; the migration-lineage rule in §5 makes it a law. |
| `writer_generation` | all | UNCOVERED + I-4 | Generation comparison is fail-closed (measured `WriterDisplaced`); rowid displacement needs the `changes === 1` assertion. |

### 1.2 The coverage set — archive database file (change 6's file)

| Table | Ruling | Mechanism / reason |
|---|---|---|
| `chain_blobs` | UNCOVERED — already covered | Content-addressed; rehash-on-read is real: `chain-archive-store.ts:490-492` → `BlobIntegrityError` (AC-3). |
| `blocks` (all `blocks_pK` children) | **UNCOVERED + INVARIANT I-2** | Class B is the exposure (measured: one serial-type byte → two canonical blocks at one height, `integrity_check=ok`). The partial `UNIQUE INDEX … ON blocks_pK (net, height) WHERE is_canonical` already in change 6's DDL is hereby elevated from schema detail to **mandatory normative requirement with its own scenario**. Content columns are projections of rehash-verified blobs; documented rebuild path per §7, no digest column on a 10⁷–10⁸-row table (+15–46 % storage for reconstructible data is the one bad trade in this design). |
| `transactions` | UNCOVERED | Same: projection of `raw_blob_hash`-verified bytes; rebuild path documented. |
| `chain_blob_roles` | UNCOVERED | Both columns are the PK; corruption is a loud-ish miss and PK-b-tree-detectable. (Noted: this table was missing from R-3's own enumeration — the spec's table list must include it explicitly as UNCOVERED.) |
| `bridge_observations` | **COVER** | Change 6's own lineage rules it **not cleanly re-derivable** (`cnight_registrations` partly Cardano-side; data in block bodies; replay reconstruction UNVERIFIED). The corruption seat's UNCOVERED rested on a re-derivability premise the archive's own design document contradicts; consistency with change 6's durability ruling (which refused to weaken `synchronous` on exactly this ground) requires COVER. Row count is bounded by bridge activity, not chain size, so the Tier-C storage objection does not apply. Multi-column digest per §1.3. |
| `verifier_key_observations` | **COVER** | "The one category where UmbraDB adds coverage the indexer genuinely lacks" — there is **no upstream to re-derive from**. Same mechanism. |
| `watermarks` (archive lineage) | **COVER** | Same as wallet-lineage watermarks, same column, same mechanism, plus I-6. For **this** cursor a data side exists: the archive store additionally asserts `cursor.height ≤ max(blocks.height) + 1` on read (cheap, measured real by the corruption seat). |

**This resolves change 6's open question M-5**: the metadata tables do **not** take a blanket digest
regime; `blocks`/`transactions`/`chain_blob_roles` take invariants + a documented rebuild path, and
the two observation tables plus the archive watermark take the digest. The M-5 re-derivation
experiment is no longer coverage-gating; it remains useful input to the rebuild-path doc.

### 1.3 The digest, specified (complete — no undefined terms)

Adopted from the cost-mechanism seat, verbatim where possible, with one extension.

- **Algorithm: SHA-256**, everywhere, unconditionally. Measured fastest cryptographic hash on the
  target hardware (SHA-NI; BLAKE2b is 1.5–1.6× *slower*); CRC32's saving is 0.5–9 µs against a
  2,088 µs fsync; one hash primitive in the codebase, same primitive the content-addressed tables
  already use.
- **Column:** `dg BLOB` — 32 raw bytes, **nullable**. `NULL` means "not yet computed / unverified"
  and is the backfill-resumability marker. Never hex TEXT, never `NOT NULL DEFAULT x''`, no
  `CHECK(length(dg)=32)` in the same migration as the column.
- **Preimage, single-value tables** (`kv_event.value`, `watermarks.value`, `transaction_history.entry`)
  — format version `0x01`, length-prefixed, injective:

  ```
  dg = SHA-256( 0x01
     || u32be(len(table))  || table      // logical table name, unprefixed
     || u32be(len(column)) || column
     || u32be(len(pkEnc))  || pkEnc      // PK columns in declared order:
                                          //   TEXT -> u32be(len)||utf8 bytes
                                          //   INTEGER -> u32be(8)||8-byte BE two's-complement
     || u32be(len(value))  || value )    // the EXACT stored bytes (TEXT: utf8; BLOB: raw)
  ```

  The pk binding is what defeats whole-row substitution (re-verified, §3 T4). `value` is what
  SQLite stores, never a re-serialisation.
- **Preimage, multi-column rows** (`bridge_observations`, `verifier_key_observations`) — format
  version `0x02`: same header (`0x02 || framed table || framed pkEnc`), then for **every non-PK
  column in declared order**: `u32be(len(colName)) || colName || typeTag || u32be(len(enc)) || enc`,
  where `typeTag` is 1 byte (`0x00` NULL with `len=0`, `0x01` INTEGER as 8-byte BE two's-complement,
  `0x02` REAL as 8-byte IEEE-754 BE, `0x03` TEXT utf8, `0x04` BLOB raw). Injective by construction;
  covers FK hash columns too (uniform rule, no exclusion logic).
- **Where computed:** in the adapter, **on the caller's thread**, before the write crosses to the
  worker; the constant `0x01/0x02 || table || column` prefix is built once per prepared statement.
  Never in SQL: the generated-column route is **REJECTED** (measured: a deterministic UDF in a
  STORED gencol works but becomes a permanent schema dependency — `VACUUM` and every third-party
  write fail without it — and `ADD COLUMN … STORED` is rejected on any populated table).
- **Drift guard (mandatory per covered table):** the no-UDF trigger, re-verified §3 T5:

  ```sql
  CREATE TRIGGER <table>_dg_guard BEFORE UPDATE OF <column> ON <table>
  WHEN NEW.dg IS OLD.dg
  BEGIN SELECT RAISE(ABORT, 'digest not recomputed for updated value'); END;
  ```

- **Write:** the `dg` is bound in the **same statement** as the value. Verified on every read of the
  covered column; mismatch raises `ValueIntegrityError` (`VALUE_INTEGRITY`, non-retryable) carrying
  the table name and primary key; the corrupted bytes are **not** returned to the caller. A `NULL`
  digest on a covered row reads as **unverified**, is returned with a one-time process-level warning,
  and is reported by `verifyIntegrity()` — it is not an error (it is the honest state of a
  mid-backfill table).
- **Backfill (applies only if a `dg` column is ever added to a populated table — fresh SQLite
  databases have the column from day one, and the Postgres→SQLite data migration computes digests
  at ingest, so v1.0.0 ships with zero backfill):** keyset pagination on the PK
  (`WHERE pk > :cursor ORDER BY pk LIMIT 200`), digests hashed outside the write transaction, cursor
  persisted **in the same transaction** as the batch, `count(*) WHERE dg IS NULL` as the completion
  check. **Never** `WHERE dg IS NULL` as the pagination predicate (measured 6.2× penalty). `VACUUM`
  afterwards optional and default-off. The contract must state the honest limit: a backfilled digest
  certifies the bytes **as found**, not as originally written — which is why coverage lands pre-tag
  (contract seat §1.4: the SQLite backend has no installed base today and never will again).

### 1.4 Verification strategy — tiered, with one deletion and one rejection

| Tier | What | When | Status |
|---|---|---|---|
| 1 | Rehash-on-read, content-addressed tables (`ckpt_chunks`, `chain_blobs`, manifest recompute) | every load | already shipped; unchanged; MUST NOT be weakened |
| 2 | **Verify-on-read for every covered `dg` column** | every read of the covered column | **mandatory, always on, no opt-out.** See reconciliation §2.5 — the cost seat's default-off is overruled on its own numbers. |
| 3 | `verifyIntegrity()` — `PRAGMA integrity_check` **and** full digest sweep **and** schema-digest check **and** the I-1/I-2 invariant queries, reported **together**, never refusing | on demand; recommended after unclean shutdown and **required** as the post-restore check | reports an inventory; never wired into startup as a gate (§7) |

Two rulings inside this:

1. **The `"(or quick_check)"` parenthesis in change 5 `design.md` §2.3(2) is deleted.** Across every
   index-vs-table divergence produced by two seats and re-verified here (§3 T2), `quick_check`
   returned `ok` while `integrity_check` reported the fault. `quick_check` is not an alternative
   anywhere in the spec.
2. **The cost seat's suggestion to run the digest sweep *instead of* `integrity_check` is REJECTED.**
   The digest sweep is blind to Class B by construction — it verifies rows it is handed and cannot
   see an index that omits rows (§3 T2: `byIndex=null` while the row exists). `integrity_check` is
   blind to Class A. Neither subsumes the other; `verifyIntegrity()` runs both, always, and reports
   both. (The sweep being 7–8× cheaper is a nice fact, not a substitution argument.)

### 1.5 Required edits to change 5 (implementable checklist)

1. `specs/release-contract/spec.md:142` and `acceptance.md` C3: replace "at minimum the TemporalKV
   value tables and the wallet-state envelope store" with the explicit list:
   `kv_event.value`, `watermarks.value` (both lineages), `transaction_history.entry`,
   `bridge_observations` (all non-PK columns), `verifier_key_observations` (all non-PK columns).
   Add a note that the wallet-state envelope is `ckpt_chunks` rows (covered by existing
   rehash-on-read) and its addressing is protected by change 4's `next_seq > max(seq)` invariant.
2. `design.md` §2.3(2): delete `"(or quick_check)"`.
3. **`acceptance.md` C10 and `design.md` §2.4 / `tasks.md:175` are rewritten to remove the
   "operating envelope" escape hatch entirely.** New C10: *"The digest's write cost is measured under
   P1's conditions and recorded. The coverage set in C3 is unconditional; there is no cost-based
   fallback."* Justification: measured cost is 3.5–12.6 µs against a 2,088 µs `synchronous=FULL`
   commit (below the noise floor), and the cost seat's own bound shows even an infinitely fast hash
   saves ≤ 3.5 µs at p50 — no plausible measurement changes the answer, so no term may gate it.
4. Adopt the two-case wording (structural damage detected / payload damage returned as data) from
   the contract seat's §0.5 everywhere the gap is described. "SQLite detects nothing" is wrong and
   would not survive review.
5. Add `chain_blob_roles` to the spec's table enumeration (currently absent), marked UNCOVERED.
6. Error catalog: `VALUE_INTEGRITY` / `ValueIntegrityError` (non-retryable, names table + pk) and
   `DATABASE_CORRUPT` / `DatabaseCorruptError` (non-retryable; `SQLITE_CORRUPT`, failing
   `integrity_check`, or schema-digest mismatch with detail `schemaDigest`) — both additive,
   non-breaking per `STABILITY.md:18-22`; the union-widening caveat lands pre-1.0 per the contract
   seat's §1.7 (and the `STABILITY.md` amendment it proposes is endorsed).
7. Contract text per §6 below, in the six placements listed there.
8. Coordinate with change 6: record M-5 as resolved by this ruling (per §1.2).

---

## 2. Reconciliation — where the seats disagreed and what I took

1. **The axis.** Draft/contract seat split on re-derivability; corruption seat proved the split
   mis-predicts (a digest never fires on Class B or C). **Taken: the three-class frame**, with
   re-derivability retained as the obligation test within Class A. This is not a compromise — the
   corruption seat's measurements (stale-checkpoint freeze, canonical-fork flip, index-omission) are
   dispositive that "COVER everything non-re-derivable with digests" both over- and under-protects.
2. **`watermarks.value`.** Contract seat: re-derivable tier, disclosure only. Corruption + cost
   seats: COVER. **Taken: COVER**, and the contract seat is overruled on its own rule: the cursor's
   corruption destroys non-re-derivable `kv_event` data *by omission* (blocks never fetched are
   never recorded), the monotonic guard latches the damage permanently, and the project's own
   `docs/checkpoint-store-contract.md:20-21` names cursor-ahead-of-data as the silent-skip failure an
   entire v1.0.0 change exists to prevent. A one-byte flip reaching the state that
   `v1.0.0-durable-checkpoint-cursor` was built to make unreachable is not a "re-derivable tier"
   problem. Cost: a handful of rows; negligible by the cost seat's own measurements.
3. **`transaction_history.entry`.** Draft omitted it; corruption and cost seats both mandate it.
   **Taken: COVER.** The omission was not defensible — it is the only copy of locally-merged state.
4. **Table names.** The cost seat's Tier B names `kv_current`/`kv_history`; change 2 superseded that
   pair with the single `kv_event` table (`v1.0.0-sqlite-temporal-event-log/design.md:168-196`).
   **Reconciled to `kv_event.value`.** No other consequence — the cost figures transfer.
5. **Verify-on-read default.** Cost seat: opt-in, default off (+70–96 % of a warm point read).
   Corruption seat and contract seat: verified on every read. **Taken: mandatory, always on.**
   Relative percentages are the wrong unit here: the absolute cost is +3.8–10.8 µs on reads of
   wallet-state tables that are not bulk-scan hot paths, and a default-off verify makes the
   contract's central promise ("corrupted bytes are not returned to the caller") conditional on a
   flag — which is the undefined-envelope escape hatch in another shape, and the exact LND failure
   pattern (a guarantee that exists but is not wired in). The bulk case the cost seat worried about
   is Tier C, which this ruling declines to cover at all.
6. **Archive metadata tables.** Change 6's interim position: all six take the digest regime pending
   M-5. Corruption + cost seats: none of them. **Taken: the split in §1.2** — invariants + rebuild
   for the projection tables, digests for the two observation tables and the cursor, because change
   6's own lineage documents that those are not cleanly re-derivable and the Tier-C cost objection
   (row count scaling with chain size) does not apply to them. Both seats' blanket-UNCOVERED
   position silently adopted a re-derivability claim the archive's own design flags as contradicted.
7. **Digest sweep vs `integrity_check`.** Cost seat proposed the sweep may *replace*
   `integrity_check`. **Rejected** — Class B blindness (§1.4).
8. **Framing.** Contract seat's Ruling 0 (UmbraDB never had, required, probed or documented page
   checksums; its pinned PG17 image measures `data_checksums = off`; what is lost is the operator's
   *option*) is **adopted for all contract wording**. It does not weaken the digest obligation one
   millimetre — it converts "restore lost parity" into "disclose an undisclosed gap and close it
   where it bites", which is what this ruling does.
9. **`cksumvfs` reserve-bytes pre-provisioning.** The contract seat proposed it in draft and
   withdrew it. **Withdrawal ratified** (§4): it freezes `page_size` forever and forecloses the
   reserve-bytes consumer `SECURITY.md` already names as 1.1 headroom (SEE at-rest encryption).
10. **Closed items honoured.** Change 4's checkpoint-sequence ruling (invariant primary, full
    `UNIQUE (w,net,seq)` in `008` as defence-in-depth) is recorded as closed; nothing here
    duplicates or contradicts it. Change 4 owns the schema-digest artifact and its recording point;
    this ruling supplies only the verification half (open + `verifyIntegrity`, `DATABASE_CORRUPT`),
    which is exactly the split change 4 §18.2 requested.

---

## 3. What I re-tested (commands and output)

Ground rule honoured: nothing below is claimed from a seat's report alone. Script:
`/root/r3-adjudicate/retest.cjs`, run on ext4 in `/root/` (not tmpfs), against the **ruled binding**
`better-sqlite3@13.0.2` (unpacked at `/tmp/l3-bs3b`, `npm install` not used).

```
$ wsl -e bash -lc 'cd /root/r3-adjudicate && node retest.cjs'
driver: better-sqlite3 13.0.2 / SQLite 3.53.4

=== T1: payload byte corruption -> integrity_check/quick_check/read-back ===
file size 32768 ; corrupting 22 bytes at payload offset 26301
integrity_check : [{"integrity_check":"ok"}]
quick_check     : [{"quick_check":"ok"}]
read-back id=400: "PAYLOAD_????????????????????????XXXXXXXXX"
RETURNED-AS-DATA: YES - corrupted bytes returned, no error

=== T2: secondary-index divergence -> quick_check vs integrity_check ===
sites of TAGVAL_000400: [32660,34949] (expect 2: table copy + index copy)
integrity_check : [{"integrity_check":"row 400 missing from index t_tag"}, ... (5 rows)]
quick_check     : [{"quick_check":"ok"}]
byIndex: null  byScan: {"id":400}

=== T3: checksum VFS availability in better-sqlite3@13.0.2 ===
compile_options containing CKSUM: []
pragma checksum_verification -> []
set checksum_verification=1 -> silently accepted (no-op)

=== T4: row substitution -- bare sha256(value) vs framed preimage ===
bare digest verifies after substitution?   YES -- substitution UNDETECTED
framed digest verifies after substitution? NO -- substitution DETECTED

=== T5: dg-not-recomputed trigger guard ===
UPDATE v without new dg: REJECTED -> digest not recomputed for updated value
UPDATE v with new dg   : ACCEPTED
```

What each confirms:

- **T1** — fourth independent reproduction of the premise, on the ruled binding: payload corruption
  in a checkpointed main database passes both pragmas and is returned to the caller as data.
- **T2** — the Class B mechanism and the `quick_check` deletion: an indexed lookup silently returns
  `null` for a row that exists; `integrity_check` reports it; `quick_check` says `ok`.
- **T3** — `cksumvfs` is not compiled in, and `PRAGMA checksum_verification = 1` is a **silent
  no-op** — the sharp edge the contract text must warn about.
- **T4** — the domain-separation requirement is real, not theoretical: a bare `sha256(value)`
  verifies clean after whole-row substitution of an identical value; the framed preimage detects it.
- **T5** — the mandatory trigger guard works with no UDF and no schema dependency.

Not re-tested here, relied on with attribution: the seats' scale/cost measurements (cost seat,
`/root/udb-r3-bench/`, ext4, disclosed conditions), the stale-checkpoint freeze and canonical-flip
experiments (corruption seat, `/root/corruption-lab/`, transcripts in its report), and the PG
`data_checksums=off` measurement on the pinned image (contract seat, transcript in its report).
Their conclusions enter this ruling only where consistent with the re-tested core.

---

## 4. The `checksumvfs` ruling

**Not viable, and declined rather than deferred. Nobody re-proposes this without new upstream
facts.** Five independent reasons, any one sufficient:

1. **It is not in the build.** `cksumvfs` is a loadable extension, not part of the amalgamation, and
   the pinned `better-sqlite3@13.0.2` prebuilt has no `CKSUM` compile option (re-verified, §3 T3).
   Shipping it means compiling, distributing and codesigning a native `.so/.dylib/.dll` per
   platform — reintroducing exactly the supply-chain burden the driver decision was made to bound.
2. **The enabling path is unreachable from Node.** Activation requires reserve-bytes = 8 via
   `sqlite3_file_control`, which neither `better-sqlite3` nor `node:sqlite` exposes; the only
   alternative is `SQLITE_CKSUMVFS_INIT_FUNCNAME`, which upstream's own source calls
   *"undocumented, apart from this comment."* A 1.0 durability guarantee cannot rest on that.
3. **The disqualifier that never expires: registration is process-global.**
   `sqlite3_vfs_register(&cksm_vfs, 1)` makes it the **default VFS** and installs a global
   auto-extension for every subsequently opened connection in the host process. UmbraDB is a library
   in someone else's process; it does not get to mutate the SQLite environment of unrelated code.
   Bitcoin Core/CLN/LND could take this route because they *are* the process; UmbraDB cannot, at
   any version.
4. **Its own track record includes the one failure a checksum must never have.** The shim
   overwrote WAL frame checksums such that *uncheckpointed transactions could not be recovered* —
   a data-loss bug fixed only in SQLite 3.51.0 (2025-08), with a wire-incompatible fix (two builds
   of the shim cannot share a WAL); plus a false-positive `SQLITE_IOERR_DATA` class from sub-page
   reads, and an unanswered enable-on-populated-DB failure report. An application digest's worst
   failure is a recoverable false rejection of one row; a VFS shim's worst failure is losing the
   transactions it was guarding. That asymmetry is the strongest single argument for the
   application digest.
5. **Even if present it would not discharge the obligation.** It is Fletcher-style, main-DB-file
   only, skips non-power-of-two reads, and its failure surfaces as a page-scoped I/O error
   indistinguishable from disk failure without extended-result-code plumbing. Complementary to a
   value digest at best; a substitute for it in neither direction.

**Consequences:** record in `docs/CONTRACT.md` §8 as **considered and declined, with reasons**
(not headroom). Do **not** pre-set reserve-bytes = 8 on new databases — it permanently freezes
`page_size` and forecloses the reserve-bytes consumer already named as 1.1 headroom (SEE). The
contract text must carry the silent-no-op warning (`PRAGMA checksum_verification = 1` is accepted
and does nothing on this build — re-verified §3 T3).

---

## 5. Class B — the mandatory invariants, with owners

The corruption seat is right that Class B is UmbraDB's largest real exposure and that no digest
reaches it. The instrument is a bounded (index-seek) assertion at the moment of use, plus
structural unrepresentability where the schema can express it. **Mandatory list:**

| # | Invariant | Fires | Owner |
|---|---|---|---|
| I-1 | `next_seq > max(seq)` per `(w, net)`, asserted inside the same transaction as every checkpoint `save()` and `load()`; plus migration `008` `UNIQUE (w, net, seq)` (defence-in-depth) | `CheckpointSequenceError` (or change 4's chosen error), non-retryable | **change 4 — already closed.** Recorded here only so the coverage table is complete. |
| I-2 | At most one canonical block per `(net, height)`: `CREATE UNIQUE INDEX … ON blocks_pK (net, height) WHERE is_canonical` on every partition child | constraint violation on write; `integrity_check` finding at rest | **change 6.** Already present in its DDL; this ruling elevates it to a normative requirement with its own scenario and acceptance row. |
| I-3 | `getAt(ns, scope, key, at)` asserts, via the **PK auto-index** (a different b-tree than `kv_event_time`), that the returned version `v` satisfies `written_at(v) ≤ at` and (`v+1` absent or `written_at(v+1) > at`) | `ValueIntegrityError` variant naming the key | **change 2** (temporal-event-log store). Two seeks on a divergent access path — this catches exactly the measured wrong-version case, which no digest can. |
| I-4 | Writer registration asserts `changes === 1` and a defined read-back; failure is a startup error, not an undefined `myGeneration` | non-retryable startup error | **change 3** (concurrency lease). |
| I-5 | Migration-lineage law, written down: every migration's **first** statement is non-idempotent DDL, and each migration runs in one transaction — so `_migrations` corruption-induced replay is guaranteed loud | `runMigrations` abort | **change 4** (lineage rules doc + a lineage lint if cheap). |
| I-6 | Anti-latch: when a `setWatermark` monotonic guard suppresses a write as a "regression", the store verifies the **incumbent** row's digest in the same transaction; a failing digest raises `ValueIntegrityError` instead of silently no-opping | `ValueIntegrityError` | **change 5** (watermarks primitive contract); **change 6** applies it to the archive-side guard. This converts the corruption seat's latch finding from a hazard into a detection point. |
| I-7 | Read-path cross-checks on transaction history: (a) `entry.lifecycle.status === lifecycle`; (b) identifier junction rows derive-and-compare against `entry.identifiers` on read | `ValueIntegrityError` naming the tx | **change 4** (schema/store parity scenarios for the transaction-history port). |
| I-8 | Archive cursor sanity: on read, `watermarks(chain-archive).height ≤ max(blocks.height) + 1` | `ValueIntegrityError` | **change 6.** Only the archive cursor has a data side; the wallet-sync cursor cannot get this check (measured), which is one reason it gets the digest instead. |

Everything else the corruption seat listed as recommended-but-optional (e.g., version-contiguity
sweeps) belongs in `verifyIntegrity()`'s inventory, not on the read path.

---

## 6. The contract text, verbatim, and its placement

Insert as a new subsection of `docs/CONTRACT.md` §1 (Durability contract), directly after the
binding-precondition material. This is the contract seat's §1.5 text amended to match §1 of this
ruling; the amendments are the coverage table, the schema-digest row, and the bad-restore residual.

> ### 1.x Integrity: what UmbraDB detects, and what it does not
>
> **SQLite writes no checksum on main-database pages.** Its integrity checks are **structural**, and
> the coverage boundary matters:
>
> - Damage to SQLite's **own structures** — page headers, cell pointers, the b-tree — *is* detected.
>   `PRAGMA integrity_check` reports the fault and the read fails with `SQLITE_CORRUPT`.
> - Damage confined to a **stored value's bytes** is **not** detected. `integrity_check` and
>   `quick_check` report `ok`, and the corrupted value is returned to the caller **as data**.
>
> Both cases are measured on UmbraDB's pinned driver, not asserted — see the durability doc for the
> transcript. The consequence is that **`integrity_check` is sound for *rejection* and not sound for
> *acceptance*:** `ok` means "no structural fault was found", never "the data is intact."
> (`quick_check` additionally skips the index cross-check and must never be used where
> `integrity_check` is specified.)
>
> UmbraDB's integrity coverage is consequently **not uniform**, and the boundary is part of this
> contract:
>
> | Tier | What protects it | On detection |
> |---|---|---|
> | Checkpoint chunks and manifests; chain-archive blobs | SHA-256 content-address recomputed on every load | `ChunkIntegrityError`, `ManifestCorruptError`, `BlobIntegrityError` |
> | TemporalKV values (`kv_event.value`), sync cursors (`watermarks.value`, both lineages), transaction history entries (`transaction_history.entry`), bridge and verifier-key observations | stored SHA-256 digest with a versioned, length-prefixed, row-bound preimage, written in the same statement as the value and re-verified on **every** read | `ValueIntegrityError` (`VALUE_INTEGRITY`) — the corrupted bytes are **not** returned to the caller |
> | Checkpoint addressing (`ckpt_sequence_counters`, `ckpt_manifests.seq`); canonical-chain classification (`blocks.is_canonical`) | runtime invariants asserted at the moment of use (`next_seq > max(seq)`; one canonical block per height), plus `UNIQUE` constraints that make the corrupt state unrepresentable | typed non-retryable errors at the read/write that would have acted on the corrupt state |
> | The schema itself (`sqlite_schema` text — every `CHECK`, every type, every index definition) | a digest over the schema text, recorded at the end of every successful migration run and verified at `open()` | `DatabaseCorruptError` (`DATABASE_CORRUPT`) at open |
> | Chain-archive metadata rows (`blocks`, `transactions`, `chain_blob_roles`) | **no per-row digest.** These are projections of content-addressed blobs; the documented recovery is rebuild/resync (see `docs/recovery/CORRUPTION.md`), and structural faults surface via `verifyIntegrity()` | — |
> | SQLite's b-tree pages, indexes, free list | `PRAGMA integrity_check`, run on demand via `verifyIntegrity()` | reported, not thrown |
>
> **Limits, stated plainly.**
> - **Detection is not repair.** UmbraDB has no `zero_damaged_pages`, no `pg_amcheck`, and does not
>   depend on the SQLite CLI's `.recover`. Recovery from detected corruption is **restore from
>   backup** (§6), or resynchronisation for the tiers derivable from chain. See §1.y.
> - A digest stored in the same row as its value can be damaged by the same event as the value —
>   measured, the comparison still fails, so detection survives co-location. The one event nothing
>   detects is a **coherently wrong file**: a restore from a stale or corrupt backup that is
>   internally self-consistent passes every check UmbraDB can run. Backup hygiene is the only
>   defence there, and §6's post-restore `verifyIntegrity()` step is its floor.
> - A digest detects corruption **at rest**. It does not detect a value that was already wrong when
>   UmbraDB was asked to store it.
> - **The digest is not a tamper defence.** It is unkeyed; an attacker able to write the database
>   file can recompute digests along with values. It detects accidental corruption, not deliberate
>   modification — consistent with `SECURITY.md`'s single-trusted-writer model. The same is true of
>   the schema digest.
> - `verifyIntegrity()` reports the structural check, the digest sweep, the schema digest and the
>   invariant checks **together**. A structural `ok` reported alone would be the misleading result
>   this section exists to prevent.
>
> **No engine-level page checksums are available on this backend.** SQLite ships a first-party
> checksum VFS (`cksumvfs`), but it is a loadable extension that is **not** part of the amalgamation
> and is **not** compiled into UmbraDB's pinned driver build. UmbraDB does not ship it and does not
> plan to: enabling it registers a **process-global default VFS**, which a library embedded in a
> consumer's process must not do on that consumer's behalf.
>
> **On this build, `PRAGMA checksum_verification = 1` is silently accepted and does nothing.**
> SQLite ignores unknown pragmas without error, so an operator following SQLite's own documentation
> to "turn on checksum verification" receives **no error and no protection**. `PRAGMA
> checksum_verification` returning **no rows** is the correct probe for the shim's absence.
>
> **This is not a regression from the PostgreSQL backend.** PostgreSQL's `data_checksums` is an
> `initdb`-time option that is **off by default** through PostgreSQL 17 — the whole range UmbraDB
> supports — and UmbraDB never required it, never probed it (the durability probe reads `fsync`,
> `full_page_writes` and `synchronous_commit` only) and never documented it. UmbraDB's own pinned
> reference server reports `data_checksums = off`. What the SQLite backend removes is the
> **operator's option** to turn checksums on (`initdb -k`, `pg_checksums --enable`), not a guarantee
> UmbraDB ever made. This subsection exists because that absence was undisclosed on **both**
> backends, and disclosing it is overdue.

**Placement — six channels, because there is no registry chokepoint** (consumers install by git tag,
clone, and container images; a CHANGELOG reaches none of them reliably):

| # | Location | Content |
|---|---|---|
| 1 | `docs/CONTRACT.md` §1 | the full text above, plus §1.y (recovery, §7 below) |
| 2 | `README.md` § "Durability and crash semantics" | four lines: the two-case statement, the digest tier, "detection is not repair — see CONTRACT §1.x", link |
| 3 | `docs/durability-contract.md` | the measured transcript + a summary-table row: "page checksums — **none**, on either backend" |
| 4 | `docs/ERROR-CATALOG.md` | `VALUE_INTEGRITY` and `DATABASE_CORRUPT` rows (additive; drift test absorbs them) |
| 5 | `SECURITY.md`, under "Data at rest — NO encryption is provided" | one line: *"and no at-rest integrity beyond the unkeyed corruption digests — see `docs/CONTRACT.md` §1.x; the digests are not a tamper defence."* |
| 6 | **The code itself**: `ValueIntegrityError` / `DatabaseCorruptError` raised at the fault, and `verifyIntegrity()` callable | the only channel that reaches a consumer who reads nothing — mandatory, and the delivery mechanism for the disclosure |

Plus `docs/recovery/CORRUPTION.md` (new, §7) linked from 1 and 2.

---

## 7. Recovery

**Ruled: detection is not worse than nothing — whole-database refusal is.** The contract seat's
Bitcoin Core analysis is adopted: the failure shape to avoid is `DBErrors::CORRUPT` (one bad record
denies the whole wallet, salvage tool deleted); the shape to copy is `NEED_RESCAN` (scoped, opens,
repairs what can be repaired). Binding rules:

1. **Row-scoped, read-time, never open-time** — for value digests. `ValueIntegrityError` is thrown
   by the read that addressed the damaged row, and by nothing else. Open, migrations, lease
   acquisition and every undamaged key keep working. One corrupted history entry leaves a working
   wallet — strictly better than today, where it leaves a working wallet acting on a wrong value.
2. **One deliberate exception — the schema digest is open-scoped.** A schema-text mismatch (Class C)
   is not row damage: it silently weakens the rules governing every **future** write, so continuing
   to write is continuing to corrupt. `open()` raises `DatabaseCorruptError` with detail
   `schemaDigest`. This is bounded (one 4 KB region, one query) and does not reintroduce the
   whole-database-refusal hazard, because it never depends on scanning data.
3. **`verifyIntegrity()` reports, never refuses.** It returns an inventory — structural result,
   failing-digest row list (table + pk), schema-digest result, invariant results — so an operator
   scopes damage before deciding. It is not wired into startup.
4. **Errors name the row.** `ValueIntegrityError` carries table and primary key; an unnamed
   corruption error forces a full restore for a single-row fault.
5. **The four consumer paths**, written in `docs/recovery/CORRUPTION.md` and summarised in
   `CONTRACT.md` §1.y:
   1. **Scope it** — run `verifyIntegrity()`; structural failure → path 3; bounded digest failures →
      continue.
   2. **Re-derive where the tier allows** — checkpoints, the chain archive's projection tables, and
      the archive generally: discard and resynchronise. Not available for `kv_event` history,
      `transaction_history.entry`, or (practically) the observation tables — which is exactly why
      those carry digests.
   3. **Restore from backup** — `CONTRACT.md` §6 gains a SQLite section whose post-restore check is
      `verifyIntegrity()` (structural **and** digest **and** schema), strictly stronger than
      `integrity_check` alone. **The digest is what makes "is my backup good?" answerable at all** —
      the first benefit a consumer feels, independent of live corruption.
   4. **No backup: accept a bounded, known loss.** With digests the consumer knows exactly which
      keys are unrecoverable and decides per key. The contract states the value proposition in
      these terms: *UmbraDB does not promise to repair corruption; it promises corruption is never
      silent, so the response can be proportionate instead of total.*
6. **What the doc must not do:** recommend `.recover`, ZFS/BTRFS or ECC as *the* answer.
   Filesystem-level integrity is recorded as defence-in-depth advice, never as discharge of the
   obligation — a library cannot verify its deployer took it.

---

## 8. What remains unmeasured — obligations under change 1's gate, not guesses

| # | Obligation | Gate condition | Consequence until measured |
|---|---|---|---|
| U-1 | **Digest write cost under P1's conditions** (real hardware, ext4, pinned binding, real payload distribution). | Change 1's perf gate. | Recorded only. Per §1.5(3) the coverage set is unconditional — this measurement documents, it does not gate. |
| U-2 | **`verifyIntegrity()` runtime at archive scale.** Measured so far: 32.4 s `integrity_check` + 4.5 s digest sweep at 2.97 GB (cost seat); nothing beyond. Measure both components at a stated representative scale (≥ 30 GB synthetic archive) plus the writer-concurrency behaviour with a **separate-process** writer (the seat's test was single-process). | Change 1's gate. | Until measured, `verifyIntegrity()` is documented as an **on-demand diagnostic and post-restore check**, not as a routine/scheduled operational recommendation. No spec text may assume a periodic pass is affordable. |
| U-3 | **Storage delta on real (non-random) payloads.** The zero-delta results at ≥1 KB rows used `randomBytes`; page packing may differ on real JSON. | Change 1's gate, alongside U-1. | Recorded only; no coverage consequence (covered tables are small in absolute terms). |
| U-4 | **Field corruption base rate.** No seat has a primary-source rate; every cost/benefit here is priced against a hazard, not a probability. | Not gateable — recorded as an honest open in the durability doc. | The contract's §1.x text deliberately makes no frequency claim in either direction. |
| U-5 | **Rebuild path for archive projection tables.** The documented blocks/transactions rebuild-from-blobs procedure (change 6's M-5 experiment, repurposed) must exist as a written procedure with one executed transcript before the archive's UNCOVERED classification ships in the contract. | Change 6's acceptance. | Until executed once, the contract's archive row says "resync from chain" only, and does not claim local rebuild. |

The two known-unknowables are recorded in the contract itself rather than gated: the coherently
wrong restored file (nothing self-consistent can detect it; §6 text) and adversarial modification
(out of scope by `SECURITY.md`'s trust model; digests are unkeyed).

---

*Gate R-3 closed. Change 5's author implements §1.5's edit list, the §1.3 digest spec, the §1.4
verification tiers, the §6 contract text and placements, and the §7 recovery doc; changes 2, 3, 4
and 6 receive the invariant ownerships in §5 and the M-5 resolution in §1.2.*
