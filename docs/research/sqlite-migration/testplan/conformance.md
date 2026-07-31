# Verification plan — lane `conformance`

**Subject:** the P1–P10 conformance suite and the `fast-check` property tests, re-executed against
SQLite; the abstract→concrete refinement claim the Lean cut-line does *not* carry; the Class B
invariants I-1…I-8.

**Governing principle:** a negative control that never runs is a comment.

**Measurement discipline:** every figure below states its conditions and the file that produced it.
Nothing here is offered as a pass threshold; where a threshold is needed and does not exist, the
test is listed in §6 as blocked on a B-gate.

---

## 0. What this lane measured before writing the plan

Five questions were settled by running code rather than by inference. Scripts are in
`/root/umbradb-sqlite-research/scratch-conformance/` (`probe.mjs`, `probe2.mjs`, `probe3.mjs`);
each was run as `cd /root/umbradb-sqlite-research/scratch-conformance && node probe<N>.mjs`.
Conditions for all of them: ext4 (`/root`, `/dev/sdd` — `df -T /root` → `ext4`; `/tmp` on this host
is `tmpfs` and was not used), `better-sqlite3@13.0.2` unpacked at `/tmp/l3-bs3b`,
`sqlite_version()` `3.53.4`, Node `v24.18.0`, single writer, dataset far inside page cache.

**M-1 — the damaged-index negative control is constructible, and it behaves exactly as change 2's
I-3 requirement describes.** Planting method: open the database, `db.unsafeMode(true)`,
`PRAGMA writable_schema=ON`, delete the time index's `sqlite_schema` row, mutate the table (the
index b-tree is now unmaintained because the engine no longer knows the index exists), then
re-insert the schema row with its **original `rootpage`**. Result at `T = 4500` on a five-version
key whose version 3 was moved from `written_at` 4000 to 9000:

```
answer via time index : { version: 3, written_at: 4000 }   <- the stale index copy
true row by primary key: { written_at: 9000 }              <- 9000 > 4500, so v3 is not a legal answer
I-3 bound half         : FAILS  (re-read 9000 <= 4500 is false)
every value digest     : verifies clean
PRAGMA integrity_check : "row 3 missing from index kv_event_time"
```

So: **a wrong answer from Law T3, every digest green, and no error raised.** Two consequences for
the plan. First, `PRAGMA integrity_check` *does* detect this — the requirement's claim is about the
**digest sweep**, not the structural check, and the plan must keep those two apart or the negative
control proves less than it appears to. Second, and unexpected:

**M-2 — `NOT INDEXED` does not give a test the table's own copy.** On the `WITHOUT ROWID` event-log
shape, all three of `NOT INDEXED`, `INDEXED BY kv_event_time` and planner-choice produced the same
plan and the same wrong answer:

```
SEARCH kv_event USING COVERING INDEX kv_event_time (ns=? AND scope=? AND key=? AND written_at<?)
```

A test that tries to obtain "the truth" with `NOT INDEXED` will silently re-read the damaged index
and report agreement. The only reliable independent path is a **primary-key-addressed** read
(`WHERE ns=? AND scope=? AND key=? AND version=?`), which is precisely what I-3 specifies. Any
harness helper named `readWithoutIndex` is a trap; the helper must be `readByPrimaryKey`.

**M-3 — the "sub-millisecond fixture" win is real for in-memory and not available under change 5's
own rules.** Per-fixture cost, schema of 4 tables + 1 index, n=100 (`probe2.mjs` §B):

| mechanism | ms per fresh store |
|---|---|
| fresh `:memory:` + `exec(schema)` | 0.131 |
| `new Database(serializedTemplate)` (deserialize a 36 KB template) | **0.038** |
| copy a 36 KB template file, then open `wal`/`FULL` | 6.72 |
| fresh file, `journal_mode=wal`, `synchronous=NORMAL` | 13.18 |
| fresh file, `journal_mode=wal`, `synchronous=FULL` | 24.53 (a second run at n=200 gave 63.49 — high variance; treat as tens of milliseconds, not as a number) |

But an in-memory database reports `journal_mode = memory` and **refuses to become `wal`**
(`PRAGMA journal_mode=wal` returns `memory`). Change 5 acceptance **A2** makes `runMigrations`
reject `journal_mode ∈ {off, memory}` with `DurabilityContractError` **and no override option**.
Therefore the fastest two rows of that table are unreachable for any suite that goes through the
shipped migration runner. This is a real cross-change conflict, not a preference — see §5 G-1.

**M-4 — the existing P5 passes vacuously on its own smallest generated case.** With `n = 2` puts the
Postgres fixture yields exactly one `kv_history` interval, and P5's assertion is
`for (let i = 0; i < intervals.length - 1; i++)` — **zero assertions executed**, green result
(`probe2.mjs` §C). This is trap 2 present in the suite today, in the very property that is supposed
to carry T5(2).

**M-5 — trap 1 reproduces on the ruled binding, and the numbers are stark.** A user function used
as a row guard over a 3,000 × 3,000 join matching 90,000 rows fired **3,000 times**, not 90,000
(`probe2.mjs` §D). A single-table version of the same test cannot see this. Any cancellation- or
abort-guard test in this lane must join.

**M-6 — change 2's F4 is tagged `[doc]` "recorded, not run" and is executable in nine lines.**
Measured (`probe.mjs` §E): inside `BEGIN IMMEDIATE`, a `RAISE(ROLLBACK)` from a `BEFORE INSERT`
trigger left `db.inTransaction === false`, the *earlier* write in that transaction was discarded,
an unaware follow-up write **committed on its own**, and the caller's `COMMIT` failed with
`cannot commit - no transaction is active`. Final table contents were `[2]` — the row written after
the rollback, and only that row. Tagging finding, per the brief: F4 should be `[unit][doc]`.

**M-7 — `PRAGMA ignore_check_constraints=ON` bypasses `CHECK` and does not touch triggers**
(`probe.mjs` §D): the `CHECK (v > 0)` insert of `-1` succeeded; the `RAISE(ABORT,'umbradb:version-chain')`
trigger still fired. Change 2 acceptance **C3** is therefore satisfiable as written. In the same
probe, a clock trigger of the form `RAISE(ABORT) WHERE NEW.written_at <= (SELECT written_at FROM e
WHERE version = NEW.version - 1)` **accepted** an insert at version 7 into an empty table — the
vacuous-predecessor case C1b names, confirmed rather than assumed.

---

## 1. Scope

Requirements are cited **by title**, never by line number.

### `v1.0.0-sqlite-temporal-event-log` (change 2)

| Requirement (title) | Criteria this lane owns |
|---|---|
| the event log is the only stored temporal representation and validity intervals are derived, never stored | A1, A2, A3 |
| gap-freedom is structural — a gap in a key's validity chain is unrepresentable | B1, B2, B3, B4 |
| the structural gap-freedom guarantee is a property of the encoding, so converting a gap-bearing history into it is not information-preserving | B4a, B4b, B4c, B4e |
| getAt asserts the `at` bound through the primary-key index, not only through the index it searched | I3a, I3b, I3c, I3d, I3e |
| the event log is append-only at the database level | C4, C5, J3 |
| WellFormed is the single remaining refinement obligation and is asserted in the database | C1, C1a, C1b, C1c, C1d, C2, C3, C6 |
| the naive EXCLUDE transliteration is prohibited | G1 (shape only), G4 |
| the engine configuration under which trigger-based enforcement is sound is asserted, not assumed | F7 (six-cell matrix) — **shared with the concurrency lane**; this lane owns only the T5-invariant assertion inside each cell |
| Unconditional writes are gapless and monotonic (Law T1) | H5 (P1) |
| put's CAS guard distinguishes conflict from absence | H5 (P2) |
| getAt satisfies temporal-projection equivalence (Law T3), within the store's retention window | H2 (P3), H3 |
| Dual addressing agrees at recorded write timestamps (Law T4) | H4 (P4), D6 |
| History intervals never overlap for a single key (Law T5) | B4, B5, B6, B7, J2 |
| trigger assertions abort the statement and never end the transaction | F3, F4 |
| the adapter never issues INSERT OR REPLACE against the event log | F2 |
| — (conformance section) | J1, J2, J3, J4, J5 |

**Explicitly not this lane's:** the clock-policy branch (D1–D5 — engine-core measurement gate),
`listKeys` streaming (H6*), transaction-handle plumbing (H9*), the descriptor attack (F7b–F7e),
error-catalog wiring (H7, H8), and the transaction-identity guard (E1–E6).

### `v1.0.0-sqlite-concurrency-lease` (change 3)

| Requirement (title) | Criteria this lane owns |
|---|---|
| P10 is re-executed with negative controls that fail against the implementations they target | H1, H2, H3 |
| per-key lease mutual exclusion is enforced in-process and uses no lock file | A1 (the P10 property itself, not the lock-file controls) |
| all lock waiting happens outside SQLite and busy_timeout is 0 on every handle | E2 (the P10-failing negative control) |
| prune's C2a justification is re-derived from BEGIN IMMEDIATE, not carried over | G5, G6 (these are P8's justification) |
| — (formal record) | H4, H5 |

Everything else in change 3 — the writer-generation guard, the descriptor ban, poisoning, the hold
bound, the error classifier — belongs to the concurrency lane. This lane consumes B3j/B3k (I-4) as
an invariant row only.

### `v1.0.0-sqlite-durability-contract` (change 5)

| Requirement (title) | Criteria this lane owns |
|---|---|
| the conformance suite is re-executed with negative controls and gains the properties SQLite creates | G5, G6, G7, G8, and the P11–P15 numbering (§5 G-4) |
| Class B corruption is answered by named invariants with an owner per change | C6b, C6c, and the I-1…I-8 inventory in §2 group D |
| the verification pass runs the structural check, the digest sweep, the schema digest and the invariants together, and never refuses | C5, C6 — this lane owns only the *invariants* part |
| deleting a pinned conformance id is a reviewed contract change in its own commit | G11, G12 |
| the manual pre-tag evidence artifact is re-executed against the new release candidate, never amended | G1 (P1–P10 rows only) |

The digest mechanism itself (C1–C4f), the probe (A1–A8), backup (E*), the catalog (F*) and
cancellation (D*) are other lanes'.

**Cross-cutting from change 4 and change 6, consumed not owned:** I-1 (`next_seq > max(seq)`,
change 4), I-5 (migration-lineage law, change 4), I-7 (transaction-history cross-checks, change 4),
I-2 (one canonical block per height, change 6), I-8 (archive cursor bound, change 6).

---

## 2. The test inventory

Type key: **U** unit · **P** property (`fast-check`) · **C** conformance (a named P-law) ·
**I** integration · **G** CI gate. Every pass condition is stated as something a machine decides.

### Group A — the P-suite, re-executed

The single most important column in this table is the fourth. Re-execution is not a port: for each
law it says whether the property **transfers unchanged**, **needs a new mechanism** because the
enforcing construct changed, or is **unreachable** and must be recorded as retired rather than
quietly dropped.

| ID | Asserts | Discharges | Transfer status | Type | Fixture | Pass condition |
|---|---|---|---|---|---|---|
| CF-P1 | N sequential unconditional puts to one key emit versions exactly `1..N` | change 2 H5, "Unconditional writes are gapless and monotonic (Law T1)" | **New mechanism.** Postgres enforced this with a server-assigned `current+1` under a row lock; SQLite enforces it with a `BEFORE INSERT` trigger asserting `NEW.version = coalesce(max(version),0)+1`. The observable is identical; the thing that would break is different | P/C | fresh store per fast-check run (§4 F-1); `n ∈ [1,50]` | returned versions `=== [1n..Nn]`; **and** the run asserts ≥1 comparison executed (§4 F-5) |
| CF-P1n | With the version assertion dropped, an inserted `version = prev + 2` is **accepted** and `getAt({version: prev+1})` returns `null` | change 2 C1, B3 | new | U | scratch schema built without the version trigger | insert succeeds **and** the skipped version reads `null`. If either fails, the control is not planting what it claims |
| CF-P1p | A **forward skip** is rejected by the version assertion and *not* by the primary key | change 2 C1 | new | U | shipped schema | thrown error's message tag is the version assertion's; a control with the version trigger removed but the PK intact shows the same insert **succeeding** |
| CF-P1i | Interleaved keys `A1,B1,A2,B2` all accepted; `A2` before `A1` rejected | change 2 C1a | new | U | shipped schema | four accepts, one reject, reject tagged to the version assertion |
| CF-P2 | `put` with `expectedVersion` succeeds iff it equals the current version (or `0n` against absent); otherwise `VersionConflictError` with `actual` = real version, `undefined` when never written, never `0n`; state unchanged | change 2 H5, "put's CAS guard distinguishes conflict from absence" | **New mechanism.** `UPDATE … WHERE version = e` on `kv_current` becomes a single insert statement carrying exactly one filtering predicate, so `changes() = 0` is unambiguously the CAS guard (C1d) | P/C | fresh store; prior writes `∈ [0,5]`, probed expectation `∈ [0,8]` | as stated, plus: the post-conflict `get` returns the pre-conflict version |
| CF-P2z | A zero-row write is reported as failure, never success; the statement carries exactly one predicate | change 2 C1d | new | U + G | source-level assertion + runtime | `changes() === 0` path throws; a source lint fails on a second predicate in the put statement |
| CF-P3 | `getAt({at: T})` equals a from-scratch fold of the accepted puts with `writtenAt ≤ T` | change 2 H2, "getAt satisfies temporal-projection equivalence (Law T3)…" | **Transfers**, but the oracle must be strengthened (see CF-P3o) | P/C | fresh store; 2–12 puts; `T` drawn from *all* of {before first, each `writtenAt`, each `writtenAt ± 1`, after last} | equality on the **full entry**, not `.value` |
| CF-P3o | The same trace replayed through a transliteration of `Formal/Lean/UmbraDBFormal/TemporalKV/Model.lean`'s `runAttempts` / `getAtTime` / `getAtVersion` agrees with the adapter on **every** outcome, including failures | the refinement claim (§3 N-1); change 2 J1 | new | P | fresh store + the Lean-derived oracle (§4 F-3) | for every generated write list: adapter outcome sequence ≡ oracle outcome sequence, and for every `T` and every `v`, adapter read ≡ oracle read. A divergence names the write index |
| CF-P4 | For every committed version `v`, `getAt({version: v})` and `getAt({at: writtenAt(v)})` return the **same full `VersionedEntry`** — value, version and `writtenAt` | change 2 H4, "Dual addressing agrees at recorded write timestamps (Law T4)" | **Transfers.** Its Postgres form needed a 5 ms sleep between puts to dodge millisecond truncation; whether that survives depends on B-1 (§6) | P/C | fresh store; 1–8 puts | full-entry deep equality both ways; **and** the test asserts it compared ≥1 version |
| CF-P4r | A `writtenAt` read back from `put`/`get` and passed into `getAt({kind:"at", at})` addresses the same version | change 2 D6 | new (the round-trip hazard changes with the clock representation) | P | fresh store | same version returned; byte-identical `writtenAt` |
| CF-P5′ | Over the **derived** validity intervals of one key: no two overlap, and each interval's `valid_to` equals the next's `valid_from`, **including the boundary between the last bounded interval and the live event** | change 2 B1, B4, J2; "History intervals never overlap for a single key (Law T5)" | **Unreachable in its original form.** The old P5 queried `kv_history.valid_from/valid_to`; A1 asserts no such column exists. The replacement queries the derived view. Note what this changes: the old P5 could fail; the new one **cannot**, because the encoding has no state that violates it (§3 N-3) | P/C | fresh store; 2–10 puts | zero overlaps; zero gaps; **and** the assertion counter is ≥ `versions - 1` (M-4: the current test executes zero assertions at `n = 2`) |
| CF-P5nc | The **legacy-shaped** interval schema accepts `[400,500)` after `[200,300)` and lets a middle-row `DELETE` open a gap | change 2 B2, J2 | new | P/U | a scratch table reproducing `kv_history` with the overlap constraint but no gap constraint | both writes succeed; the derived read at a time inside the hole returns `null`; **the test asserts this and passes** — the point is that the old shape admits it |
| CF-P5g | A gap-bearing history is **unrepresentable**: for every generated event list, the derived intervals are contiguous by construction | change 2 B1; the refinement claim | new | P | fresh store; generator deliberately attempts holes (§4 F-2) | every attempt either is rejected by an assertion or produces a contiguous chain; no third outcome |
| CF-P5m | Removing a middle version surfaces as a **T1 version-chain gap** (`getAt({version})` → `null`), not as a T5(2) violation | change 2 B3 | new | P | scratch schema with append-only assertions dropped | derived intervals still contiguous **and** the version read is `null` — both, in one run |
| CF-P6 | Writing the same `(hash, data)` twice leaves `data` byte-identical and the chunk count unchanged | STORAGE_ALGEBRA §2 chunk idempotence | **Transfers.** `INSERT … ON CONFLICT (hash) DO UPDATE` is expressible in SQLite | P/C | fresh store per iteration — deletes the hash-scoped `WHERE hash = ?` workaround the Postgres test needed because the table was shared across iterations | one row for the hash; `data` equal; count delta 0 |
| CF-P6nc | `INSERT OR REPLACE` on the event log does **not** fire the `BEFORE UPDATE` trigger while `ON CONFLICT DO UPDATE` does | change 2 F2 | new | U | scratch schema with both triggers instrumented | trigger fire counts `{onConflict: ≥1, insertOrReplace: 0}`, and the `INSERT OR REPLACE` arm shows a history row silently gone |
| CF-P6g | No source file issues `INSERT OR REPLACE` / `REPLACE INTO` against the event log | change 2 F1 | new | G | repository source | build fails on a planted occurrence; passes on the shipped tree |
| CF-P7 | Two chunk multisets saved in either order produce an identical chunk set | Law C1; STORAGE_ALGEBRA P7 | **Transfers.** The adapter-private diagnostic query changes shape only | P/C | **fresh store per direction** — this deletes the two `TRUNCATE` calls the Postgres version needs inside each iteration | sorted hash lists equal; both lists non-empty |
| CF-P8 | After random interleaved `save`/`prune`, every checkpoint listed by `history()` still `load`s without `ChunkIntegrityError` / `ChunkMissingError` / `CheckpointNotFoundError` | Law C2a; change 3 G6 | **New justification.** The property is identical; what makes it hold changed from Postgres's same-transaction scan under READ COMMITTED to `BEGIN IMMEDIATE`. A green P8 with the old justification in the comment is a documentation defect (change 3 G7) | P/C | fresh store; 5–15 ops over 2 wallets sharing a chunk | every listed checkpoint loads; **and** the run asserts `history()` was non-empty for ≥1 wallet |
| CF-P8nc | A `DEFERRED` prune reclaims a live chunk against a `save` that re-references it after the snapshot | change 3 G5 | new | I | fresh file-backed store, two connections | the surviving checkpoint fails to `load`; the same fixture under `BEGIN IMMEDIATE` (CF-P8nc2) loads clean |
| CF-P9 | `get` after N random `set`s returns the last value; `set·set` of an equal value is indistinguishable from one | Law W1 | **Transfers unchanged.** Single-row upsert either way | P/C | fresh store; 1–8 values | last value returned; exactly one row |
| CF-P10 | N concurrent in-process `withLease` calls on one key: instrumented maximum concurrent holders = 1 | change 3 A1, H1 | **New mechanism, and narrowed.** `pg_advisory_lock` was *connection*-scoped, so the Postgres P10 used 8 **independent clients**. SQLite's replacement is an in-process mutex; the multi-connection arm is unreachable (see CF-P10x) | P/C | fresh file-backed store; N = 8; 20 ms critical section | `maxActive === 1` and `overlapDetected === false`; **and** the test asserts all N callbacks ran |
| CF-P10x | **Retirement record.** The multi-connection / multi-process holder-overlap arm of P10 is recorded as unreachable, with the replacement named (change 3's O1/O2/O3 displacement tests, which assert fail-stop, not mutual exclusion) | change 3 H1; §5 G-2 | n/a | G (doc lint) | — | the retired arm appears in the conformance register with `UNREACHABLE` and a pointer; a suite that silently drops it fails the register check |
| CF-P10nc | A non-zero blocking `busy_timeout` fails the concurrent-acquirer assertion while the poll loop passes it | change 3 E2, H2 | new | P | same fixture, `busy_timeout` varied | with blocking timeout: acquirers < N and ≥1 timeout; with poll loop: N acquirers, `maxActive === 1` |

### Group B — the refinement bridge (this lane's central obligation)

| ID | Asserts | Discharges | Type | Fixture | Pass condition |
|---|---|---|---|---|---|
| CF-R1 | The abstraction function α (concrete rows → Lean `History`) is **total** on every state the shipped schema admits | the refinement claim | P | fresh store; arbitrary accepted write sequences | for every reachable state, α produces a `List Event` and `WellFormed` holds; failure prints the offending rows |
| CF-R2 | α is **not** total on the PostgreSQL shape: a legal `kv_history` state (`[1000,2000)` + live row at `3000`) has no `History` preimage | change 2 "…converting a gap-bearing history into it is not information-preserving" | U | the legacy-shaped scratch table | the state is constructed, α refuses it, and the refusal names the pair of versions whose `valid_to(v) ≠ valid_from(v+1)` |
| CF-R3 | The TypeScript oracle is a faithful transliteration of the pinned Lean model | CF-P3o's own trustworthiness | G | `Formal/Lean/UmbraDBFormal/TemporalKV/Model.lean` + `Watermarks/Model.lean` + `Checkpoint/*.lean` | the oracle file records the SHA-256 of each Lean model file it mirrors; CI recomputes them and fails if any differs, naming the file. Editing the model without re-deriving the oracle turns the gate red |
| CF-R4 | `WellFormed` — strictly increasing `written_at` per key — is asserted **by the database**, and is the only remaining unmechanised obligation | change 2 C2, C6, "WellFormed is the single remaining refinement obligation…" | U + P | shipped schema | an insert at `written_at ≤ prev` is rejected by the strict-increase assertion **and** independently by the unique index on `(ns,scope,key,written_at)`; both arms exercised separately (C6) |
| CF-R5 | Under `PRAGMA ignore_check_constraints=on` a violating insert is still rejected | change 2 C3 | U | shipped schema | rejection persists (M-7 confirms the pragma bypasses `CHECK` and not triggers) |
| CF-R6 | The version assertion is evaluated **before** the clock assertion, and the ordering is load-bearing | change 2 C1b | U | shipped schema, plus a reordered scratch variant | in the shipped order, a version-7-into-empty insert is rejected by the version assertion; in the reordered variant the clock assertion passes vacuously and the row lands (M-7 measured this exact vacuity) |
| CF-R7 | The open-time schema probe asserts an expected **count** of schema objects | change 2 C1c | U | a database with one trigger removed | open refuses, naming the count difference; a zero-row probe result is treated as absence, never confirmation |

### Group C — T3 does not compose

Two independent failures of composition, each requiring comparison against an independent source of
the same fact rather than inference from the target.

| ID | Asserts | Discharges | Type | Fixture | Pass condition |
|---|---|---|---|---|---|
| CF-C1 | **Across a conversion.** For the worked fixture, the source's `getAt({at: 2500})` is `null` and the converted store's is version 1, **while** row counts, per-row digests, the version chain, strict `written_at` increase, the unique time index, and derived non-overlap/gap-freedom all pass against the converted store | change 2 B4b, B4c | P + U | the two-row gap-bearing source; conversion by `written_at` (verified: derived intervals `[1000,3000)`, `[3000,NULL)`, converted read at 2500 → version 1, `probe.mjs` §C) | **all** target-side checks pass **and** the two answers differ. The negative control's *passing* is the finding; a run in which any target-side check fails has planted the wrong fixture |
| CF-C2 | A T3 claim across a conversion is established by comparing **source and target answers per key**, never inferred from the target's internal coherence | change 2 B4c | P | a mixed corpus: ~200 keys, ~10% deliberately gap-bearing | for every key and every probe time, `source.getAt(k,T) ≡ target.getAt(k,T)`; the gap-bearing keys are reported unconvertible rather than converted |
| CF-C3 | A JS round trip is not a valid fidelity oracle | change 2 B4e | U + G | the two literals `12345678901234567890123` and `0.1000000000000000055511151231257827` | `JSON.parse` alters both; the second compares **equal** to `0.1`; and a source lint fails any equality assertion in this change's suite that routes a stored value through a parsed JS value |
| CF-C4 | **Across an index.** `getAt({at: T})` re-reads its candidate by **primary key** and asserts both halves — `written_at(candidate) ≤ T` **and** successor absent or `written_at > T` | change 2 I3a | U + G | shipped adapter | source assertion plus `EXPLAIN QUERY PLAN` showing a **second** seek on the primary-key index, not the time index |
| CF-C5 | **Paired negative control, both arms.** With the time index damaged and table rows intact: every value digest verifies clean; **with** the assertion the read fails loudly; **without** it the same read returns a row violating the query | change 2 I3b | U + P | the stale-index fixture of M-1 | with assertion: typed error naming the divergence. Without assertion: a returned row whose primary-key-addressed `written_at` is `> T`, with no error. Digest sweep green in **both** arms. Only the paired run closes this row |
| CF-C5a | The structural check is **not** the read-time detector | change 2 I3b framing | U | same fixture | `PRAGMA integrity_check` reports `row 3 missing from index kv_event_time` (M-1) while the read path raises nothing without CF-C4 — the test records both, so nobody later mistakes the structural check for coverage |
| CF-C6 | A too-**early** candidate is caught by the **successor** half specifically | change 2 I3c | U | index damaged so a seek yields `v` when `v+n` is correct and still `≤ T` | bound half passes, successor half fails, error names the successor conjunct |
| CF-C7 | A zero-row primary-key re-read **raises** rather than falling back to the time index's answer | change 2 I3d | U | fixture with the candidate's PK entry removed | typed error; no row returned; the test asserts the time index *did* produce a candidate, so the fallback path was genuinely reachable |
| CF-C8 | The mirror hazard is recorded, not silently left: a damaged **primary-key** index corrupting `getAt({version})` is out of I-3's scope and is covered only by CF-P4's sampled property | change 2 I3e | G (doc lint) | — | the residual appears in the register with its owner and its coverage level (`sampled property, not read-time assertion`) |

### Group D — the Class B invariants I-1…I-8

Every row is a Class B protection: damage that leaves each individual row internally valid, which a
per-row digest therefore cannot detect. Two of them — I-1 and I-8 — exist specifically for that
case, and their negative controls must show the digest sweep passing.

| ID | Invariant | Owner | Asserts | Type | Pass condition |
|---|---|---|---|---|---|
| CF-I1 | `next_seq > max(seq)` per `(wallet, network)`, asserted inside every checkpoint save and load, plus `UNIQUE (wallet, network, seq)` | change 4 | A counter rewound below `max(seq)` is rejected at `save()` with `VALUE_INTEGRITY`; the aggregate is wrapped in `coalesce` so an empty table yields the identity, not `NULL` | U + P | rejection fires; **negative control:** the same state passes a full per-row digest sweep and `integrity_check` — the corruption is invisible to both |
| CF-I1v | I-1's zero-row arm | change 4 | With no manifests, `max(seq)` is `NULL`; a bare comparison silently evaluates `NULL` and the assertion passes vacuously | U | the un-coalesced form is shown accepting a rewound counter; the `coalesce` form rejects it. Both arms in one run |
| CF-I2 | At most one canonical block per `(network, height)` | change 6 | A second canonical row at one height is rejected on write; a constructed two-canonical-row state is **not** detected by a per-row digest sweep while the invariant query detects it | U | both halves asserted; the digest arm must be shown green |
| CF-I3 | `getAt` cross-path assertion | change 2 | see CF-C4…CF-C8 | — | — |
| CF-I4 | Writer registration asserts one affected row **and** a defined read-back | change 3 | With either assertion removed, an unseeded or emptied registration table yields `changes = 0`, an absent read-back and an undefined generation with nothing thrown — and the resulting guard is **inert** (two processes both pass) | U + I | run **twice, once per assertion**; inertness demonstrated, not merely wrongness; and I-4 holds against a row **deleted after seeding**, not only the unseeded case |
| CF-I5 | Migration-lineage law: every migration issuing DDL begins with non-idempotent DDL; each migration runs in one transaction | change 4 | Re-entering an already-applied migration fails loudly; a migration issuing no DDL must be in the no-op registry or fail the check | U + G | a planted `CREATE TABLE IF NOT EXISTS` first statement fails the lint; an accidentally-empty migration not in the registry fails; the one deliberate no-op passes with its justification adjacent |
| CF-I6 | Anti-latch: when a monotonic watermark guard suppresses a write as a regression, verify the **incumbent** row's digest in the same transaction | change 5 (archive-side application, change 6) | A watermark corrupted **upward** whose guard then suppresses legitimate writes raises `ValueIntegrityError` | U + P | with the invariant: raises on the first suppressed write. **Negative control** against a plain no-op guard: the corrupted position persists, four consecutive correct writes are discarded, nothing is raised, and W1's own P9 stays green throughout — which is the point (§3 N-4) |
| CF-I7 | Transaction-history read-path cross-checks: the entry's own lifecycle status agrees with the `lifecycle` column; identifier junction rows derive-and-compare as a **set** against the entry's identifiers | change 4 | A disagreeing `lifecycle` column raises `VALUE_INTEGRITY` on read | U + P | both halves asserted separately; the identifier comparison is set-equality, not array-equality (order is not information) |
| CF-I8 | Archive cursor sanity: the archive watermark's height does not exceed `max(block height) + 1`, with the aggregate wrapped in `coalesce` | change 6 | A cursor advanced past the data raises on read | U + P | rejection fires; **negative control:** every row involved is internally valid, its digest verifies, and `integrity_check` is `ok` — the invariant is the only detector |
| CF-Iown | Each invariant names exactly one owning change; none owned elsewhere is re-specified | change 5 C6c | G (doc lint) | a mechanical sweep over all seven change directories finds exactly one owner per invariant; a second definition fails the gate |

### Group E — suite meta-gates

These exist because five vacuous-pass instances and one 41% line-anchor mis-rate were measured in
this sprint. Without them the rest of the table is unfalsifiable.

| ID | Asserts | Type | Pass condition |
|---|---|---|---|
| CF-M1 | **Non-vacuity.** Every conformance property reports the number of assertions it actually executed; a run reporting zero for any property fails the suite | G | the harness's per-property assertion counter is `> 0` for all of P1–P10 and every CF-* property. M-4 shows the current P5 would fail this today |
| CF-M2 | **Empty-scope honesty.** A suite that can run against an empty fixture asserts its fixture is non-empty, or reports `n/a — no rows in scope`; `pass` on an empty scope is a failure | G | a planted empty fixture yields `n/a`, never `pass`, for every property in Group A |
| CF-M3 | **Meta-assertion on negative controls.** The suite fails if **every** negative control passes | G | generalises change 3 H3 to the whole conformance suite: each control is registered with the implementation it targets, and the run asserts each one failed against its target and passed against the shipped one |
| CF-M4 | **Filesystem assertion.** Any file-backed conformance fixture asserts its filesystem is not memory-backed | G | `df -T` (or `statfs`) on the fixture directory rejects `tmpfs`, `ramfs`, `nfs`, `cifs`, `v9fs` and un-allowlisted `fuse`. Asserted by the **suite**, independently of change 5's probe — a probe that is the system under test cannot be its own control |
| CF-M5 | **Property register.** A machine-readable register lists every property `P1…P15`, its law, its owning change, its status (`transfers` / `new mechanism` / `unreachable`) and, for `unreachable`, its replacement | G | the register is complete and each executing test declares its register id; an executed property absent from the register, or a register entry with no executing test and no `UNREACHABLE` marking, fails the gate |
| CF-M6 | **Numbering collision.** `P11` is currently used twice (§5 G-4) | G | the register rejects a duplicate id; the collision is resolved before either test ships |
| CF-M7 | `EXPECTED_REQUIRED_COUNT` in `test/integration/check-required-tests.ts` is not edited in the same commit as any manifest id deletion | G | change 2 J5 / change 5 G11: a CI check inspects the commit's diff and fails when both appear |
| CF-M8 | Every conformance property records a **pinned fast-check seed** and its `numRuns`, reported on both pass and fail | G | follows `save-and-advance.property.test.ts`'s existing pattern; a property without a pinned seed fails the register check |
| CF-M9 | Cross-change citations in this lane's tests resolve by **requirement title**, not line number | G (doc lint) | a lint resolves each cited title against the spec files; an unresolvable title fails. Line-number citations in test comments fail |

---

## 3. Negative controls

Listed separately, as the brief requires. For each: what wrong implementation it plants, how it is
planted without shipping, and what its failure proves. **How planted** matters as much as what:
several of these need a door into the engine that the shipped adapter must not have.

| ID | Wrong implementation planted | How planted without shipping it | What its failure proves |
|---|---|---|---|
| NC-1 (CF-P1n) | Event log without the version assertion | The trigger DDL lives in one exported function; the test builds a **scratch database** from the same function with the assertion suppressed by a parameter that exists only in the test-only export. The shipped `runMigrations` has no such parameter, asserted by a source lint | That the version assertion, and not the primary key, is what rejects a forward skip. Without it, a gap in the version chain is accepted silently and reads `null` |
| NC-2 (CF-P5nc) | The interval-table design: overlap constraint, no gap constraint | A scratch table reproducing `kv_history`'s shape. Never reachable from `src/` — the shipped schema has no `valid_to` column at all (change 2 A1 asserts this against the **live schema**, not the migration source) | That gap-freedom in the old design rested on trigger discipline and could be defeated by a manual insert or a middle-row `DELETE`, and therefore that the new encoding's structural guarantee is a real change and not a restatement |
| NC-3 (CF-C1) | A conversion that validates by row count, per-row digest and this change's own assertions | The conversion is run for real against a two-row gap-bearing source. **The control is shown *passing*** — all target-side checks green — and the finding is that `getAt({at:2500})` moved from `null` to version 1 | That target-side coherence is not evidence of faithful conversion. This is the one negative control whose *green* result is the deliverable; a red result means the fixture is wrong |
| NC-4 (CF-C5) | `getAt({at})` without the I-3 cross-path re-read | Two arms over one fixture: the same damaged database read by the shipped adapter and by a test-local reimplementation of the read without the assertion | That a damaged index copy returns a wrong row from Law T3 with every digest green and no error raised. **Measured (M-1):** answer `{version:3, written_at:4000}` at `T=4500` while the true row is `9000` |
| NC-4p | *Planting method, called out because it is not obvious.* `better-sqlite3` sets `SQLITE_DBCONFIG_DEFENSIVE = 1` in its constructor (`src/objects/database.cpp:172`), so `PRAGMA writable_schema=ON` alone raises `table sqlite_master may not be modified`. The fixture builder must call `db.unsafeMode(true)` first | The fixture builder is a test-only module; a source lint fails the build on `unsafeMode` or `writable_schema` anywhere under `src/` | That the damaged fixture is constructible at all, and that the door used to construct it cannot reach production. **This is also a finding for change 5's P2**, which records `enableDefensive` as "absent from the ruled binding's prototype" — defensive mode is nonetheless **on by default** and toggled by `unsafeMode` |
| NC-5 (CF-C3) | A fidelity oracle that compares stored values through `JSON.parse` | Two literal values in a unit test | That the oracle both corrupts the data and destroys the evidence: `0.1000000000000000055511151231257827` parses to `0.1` and compares **equal** to it |
| NC-6 (CF-P6nc) | `INSERT OR REPLACE` against the event log | Scratch schema with instrumented triggers; the shipped path is guarded by CF-P6g | That `INSERT OR REPLACE` bypasses the `BEFORE UPDATE` trigger while `ON CONFLICT DO UPDATE` fires it — silent history-row loss, demonstrated not asserted |
| NC-7 (CF-P8nc) | A `DEFERRED` prune | A test-local transaction opener; the shipped path is guarded by change 3 D1's build-failing check | That C2a's safety depends on `BEGIN IMMEDIATE`, not on an inherited READ COMMITTED argument — a live chunk is reclaimed and a surviving checkpoint no longer loads |
| NC-8 (CF-P10nc) | A blocking `busy_timeout` instead of the out-of-SQLite poll loop | Test-local pragma override on the fixture handle | That a blocking wait fails P10 at 1 acquired / N−1 timeouts while the poll loop passes it |
| NC-9 (CF-I1v) | `next_seq > max(seq)` written without `coalesce` | Scratch schema | That the un-coalesced form passes vacuously against an empty table — `NULL` comparison is neither true nor false — so a rewound counter is accepted on a fresh store |
| NC-10 (CF-I4) | Registration without the affected-row assertion, and separately without the read-back assertion | Two scratch variants, run separately | That either omission makes the guard **inert**, not merely wrong: `changes = 0`, an undefined generation, nothing thrown, and two processes both passing the check |
| NC-11 (CF-I6) | A plain no-op monotonic guard on the watermark | Test-local guard implementation | That a watermark corrupted upward latches: four consecutive correct writes are discarded, the corrupted position persists, nothing is raised, **and P9 (Law W1) stays green the entire time** — because W1 deliberately does not include monotonicity |
| NC-12 (CF-I2, CF-I8) | Digest-only detection | No wrong implementation is planted; the control is the **digest sweep and `integrity_check` run against a state that violates the invariant** | That both report clean. This is the empirical content of "Class B is what digests provably cannot cover"; without it that sentence is an assertion |
| NC-13 (CF-R6) | The clock assertion evaluated before the version assertion | Scratch schema with the two triggers reordered | That the clock assertion passes vacuously when its predecessor row is absent — **measured (M-7):** version 7 inserted into an empty table, accepted — so the ordering is load-bearing and splitting or reordering them holes the check |
| NC-14 (F4, change 2) | `RAISE(ROLLBACK)` instead of `RAISE(ABORT)` in a trigger assertion | Scratch schema | That the transaction ends and the connection drops into autocommit: **measured (M-6)** — the earlier write in the transaction is discarded, an unaware follow-up write commits on its own, and the caller's `COMMIT` fails with `cannot commit - no transaction is active`. Currently tagged `[doc]`; this run makes it `[unit]` |
| NC-15 (trap 1) | A cancellation/abort guard tested on a single table | The control is the **join**: 3,000 × 3,000 rows, 90,000 matches | That the guard fires 3,000 times, not 90,000 — **measured (M-5)**. A single-table test of the same guard cannot distinguish a correct implementation from a hoisted one |
| NC-16 (CF-M1) | A property whose assertion loop never executes | The existing P5 shape at `n = 2` | That a green property can have executed **zero** comparisons — **measured (M-4)**. The assertion counter is what makes the rest of this plan falsifiable |

---

## 4. Fixtures and harnesses

**F-1 — the fixture factory, and what it replaces.** `test/postgres/setup.ts`'s
`registerSuiteLifecycle()` — one session-scoped `PostgreSqlContainer`, `TRUNCATE` between tests, a
module-level `keyCounter` so iterations do not collide, and per-test `maxConnections` pools — exists
almost entirely to amortise container startup. It is replaced by `freshStore()`: a function
returning a migrated, empty store **per fast-check iteration**, not per file.

Direct consequences, each of which deletes existing test code rather than adding to it:
`freshKey()`/`freshWallet()` counters disappear (every iteration owns its store); the two `TRUNCATE`
statements inside P7's iteration body disappear; P6's `WHERE hash = ?` scoping — which exists only
because `ckpt_chunks` was shared across iterations — becomes an unscoped count; the "dedicated pool
against the same container" hook disappears; and the per-adapter test architecture that exists to
share one container goes with it.

**Cost, measured (M-3), and the constraint that decides the mechanism.** The fastest options —
`new Database(serializedTemplate)` at 0.038 ms and fresh `:memory:` at 0.131 ms — produce a store
whose `journal_mode` is `memory` and which **cannot be set to `wal`**. Change 5 A2 makes
`runMigrations` reject `journal_mode ∈ {off, memory}` with **no override option**. Under the sprint
as specified, the conformance suite therefore runs **file-backed on ext4**, and the mechanism is
*copy a pre-built template file, then open* — 6.72 ms per fixture, versus 13.18 ms (`wal`/`NORMAL`)
or ~25–63 ms (`wal`/`FULL`) for a fresh migration each time. Against 2,500–3,300 ms per container
that is still a ~400× improvement and it is honest. §5 G-1 records the decision this needs.

**F-2 — generators that produce states the current suite has never generated.** Three, and the
first is the one that closes a live gap in the *existing* verification:

1. **Gap-bearing histories.** An arbitrary that emits `(version, written_at, value)` triples with
   deliberate holes in the time coverage — and, for the legacy-shaped table, explicit
   `(valid_from, valid_to)` pairs where `valid_to(v) ≠ valid_from(v+1)`. Shapes to cover: a hole
   between two bounded intervals; a hole before the live event (the worked example); a
   middle-version `DELETE`; and a backfilled row inserted out of order. The existing P5 generates
   only adapter-written sequences and therefore **cannot** produce any of these — which is why a
   state with no abstract counterpart has survived in the Postgres schema unnoticed.
2. **Damaged-index fixtures.** Parameterised by which index (time vs primary key), which version,
   and whether the divergence makes the candidate too late (bound half fails) or too early
   (successor half fails). Built by the NC-4p method.
3. **Corrupted-but-internally-valid states** for Group D: a rewound `next_seq`; two canonical blocks
   at one height; a watermark advanced past `max(height)+1`; a `lifecycle` column disagreeing with
   its entry; a deleted registration row. Each must be constructed so that **every row remains
   internally valid and every digest verifies** — that is the whole point of the class.

**F-3 — the Lean-derived oracle.** A TypeScript module mirroring
`Formal/Lean/UmbraDBFormal/TemporalKV/Model.lean`: `Expectation`, `Failure`, `Outcome`,
`expectationMatches`, `snapshotVersion`, `current`, `getAtVersion`, `getAtTime`, `attempt`,
`runAttempts`, `validityIntervals`, `WellFormed` — plus `Watermarks/Model.lean`'s `set`/`runSets`/
`lastMatching` and `Checkpoint/ChunkMap.lean`'s `mergeChunkMaps`. It is a **plain fold, no database
access**, so a divergence localises to the adapter.

The honest caveat, stated here rather than discovered later: hand-transliterating the model
introduces a **second** trusted bridge. Two mitigations, both cheap: CF-R3 pins each mirrored Lean
file's SHA-256 in the oracle and fails CI on drift; and the oracle is exercised by its own unit
tests reproducing the Lean theorem statements as concrete cases (`attempt_applied_version`,
`getAtTime_eq_last_prefix`, `dual_address_agrees`, `adjacent_intervals_gap_free`,
`intervals_pairwise_disjoint`, `set_idempotent`, `mergeChunkIds_order_independent`) so a
mis-transliteration is caught against the proofs' own claims.

**F-4 — data volume and shape.** Deliberately small where the property is algebraic and large only
where size is the mechanism:

| Fixture | Volume | Why this size |
|---|---|---|
| P1–P5, P9 | 1–50 versions on 1–3 keys | the laws are per-key folds; more rows buy nothing |
| CF-C2 conversion corpus | ~200 keys × 1–20 versions, ~10% gap-bearing | enough keys that per-key comparison is a real sweep, small enough to run per-PR |
| CF-P7, CF-P8 | 3–20 chunks of 16–200 bytes, 2 wallets | order-independence and reachability are structural |
| CF-C4 query-plan assertion | ≥ 1,000 versions on one key | below that the planner may prefer a scan and the plan assertion becomes untestable |
| G3-shape check (change 2) | ~1M versions on one key vs 1k | a **shape** assertion (no upward trend), never a rate — §6 |
| NC-15 join guard | 3,000 × 3,000 rows, 90,000 matches | measured to reproduce hoisting (M-5); a single table does not |

**F-5 — the assertion counter.** A tiny harness wrapper every conformance property routes its
comparisons through, reporting a count per property. Feeds CF-M1 and CF-M2. It is the cheapest item
in this plan and the one without which M-4 recurs.

**F-6 — the conformance register.** A machine-readable file (`test/conformance/register.json`)
holding one row per property: id, law, owning change, status
(`transfers` | `new-mechanism` | `unreachable`), replacement (for `unreachable`), pinned seed,
`numRuns`, and the negative controls paired to it. CF-M5, CF-M6, CF-M8 and CF-P10x all read it.

---

## 5. What cannot be tested, and the nearest achievable substitute

**G-1 — the fast in-memory suite is forbidden by change 5's own acceptance criterion.**
Measured: `:memory:` reports `journal_mode = memory` and refuses `wal`; change 5 A2 rejects exactly
that with no override. So sub-millisecond fixtures and the shipped migration runner are mutually
exclusive as specified. Three ways out, and this lane cannot pick one: (a) accept 6.72 ms
file-backed template-copy fixtures (recommended — still ~400×, no rule bent); (b) give change 5 a
narrowly-scoped test-only carve-out, which A2's "no override option" currently forbids and which
would itself need a negative control proving it cannot be reached from a shipped code path; or
(c) let the conformance suite construct its schema without `runMigrations`, which trades the
migration lineage (I-5) out of every conformance run. **Substitute until decided:** (a).

**G-2 — P10's connection-scoped guarantee has no SQLite counterpart.** The Postgres P10 spins 8
independent clients because `pg_advisory_lock` is connection-scoped and that is the guarantee being
tested. SQLite's replacement is an in-process mutex plus a cross-process **fail-stop**. Those are
different properties: mutual exclusion versus detection-and-refusal. The multi-connection arm is
recorded `UNREACHABLE` in the register (CF-P10x) with change 3's O1/O2/O3 named as the replacement.
Anyone reading "P10 passes" after the migration is reading a weaker statement than before, and the
register is what says so.

**G-3 — the conformance suite cannot falsify T5 after the migration.** This is the sharpest thing
this lane has to report. Under the event-log encoding, a gap or an overlap in the derived intervals
is **unrepresentable**: `validityIntervals` derives `[wᵢ, wᵢ₊₁)` from consecutive events, so
contiguity is a theorem about the derivation, not a fact about the data. CF-P5′ therefore cannot
fail for any state the schema admits — it is vacuously true, in a way CF-M1's assertion counter
will *not* catch, because comparisons do execute; they just cannot come out false. The real risk
does not disappear, it **moves to the importer**, where CF-R2 and CF-C1/CF-C2 live. Substitute: the
register records CF-P5′ as `structural — cannot fail on adapter-written data`, and the falsifiable
content is carried by CF-P5nc (the legacy shape *can* violate it) and CF-P5g (attempts to write a
hole are rejected, not silently normalised). A plan that reports "T5 green" without this note is
reporting the encoding's tautology as evidence about the implementation.

**G-4 — `P11` is already taken.** `test/postgres/save-and-advance.property.test.ts` defines P11 as
the co-transactional durable-composition property with a pinned seed (`P11_SEED = 20260723`).
Change 5 defines P11 as "`journal_mode` and `synchronous` hold at or above their configured floors
at every commit". Two different properties, one number, and the conformance manifest is a shared
namespace. CF-M6 fails the gate until this is resolved; resolving it is a one-line rename, but only
if someone notices before both ship.

**G-5 — the Lean gate proves nothing about the SQLite implementation.** The cut-line `{T3, T5, W1,
C1}` survives this migration untouched because the model is an abstract store: `History` is a
`List Event`, there is no index, no bytes, no second process, no filesystem, and no notion of a
damaged copy. Every failure this sprint actually worries about — descriptor-close voiding a write
lock, a stale index b-tree, a lossy conversion, page-level corruption — is outside the model's
vocabulary, so no Lean theorem can be false for any of them. What a green Lean gate *does* buy,
after the change-2 redesign, is that the trusted bridge shrinks to a single property: `WellFormed`
(strictly increasing `written_at` per key), which CF-R4 asserts **in the database**. Substitute for
the unmechanised remainder: CF-R1 (α total on every admissible concrete state), CF-P3o (differential
against the transliterated model), and CF-R3 (the transliteration pinned to the model's hash). No
criterion in this lane is discharged by Lean CI, per change 2 B6/N7 and change 3 H4.

**What a green run of this lane proves, stated per law, so nobody has to infer it:**

- **T3 green** ⇒ `getAt` agrees with a fold over the events *this store holds*, on the sampled
  traces, on an undamaged store, and — with CF-C4 — that the `{at}` answer survives a cross-check
  through a second b-tree. It does **not** prove the store holds the right events (CF-C1/CF-C2 is
  the only thing that speaks to that), and it does **not** cover `getAt({version})` against a
  damaged primary-key index (CF-C8's recorded residual).
- **T5 green** ⇒ the derived intervals of adapter-written data are contiguous and non-overlapping.
  Per G-3, this is a property of the encoding. It says nothing about imported data.
- **W1 green** ⇒ last-write-wins holds on the watermarks primitive. It is fully compatible with a
  cursor corrupted upward and latched forever (NC-11), because monotonicity is deliberately not a
  W1 law. I-6 is what covers that, and I-6 is not part of W1.
- **C1 green** ⇒ the save-only chunk projection is a commutative idempotent join. It says nothing
  about `prune`; C2a is P8's business, and P8's *justification* changed with the migration even
  though its assertion did not — so a green P8 without NC-7 having failed against `DEFERRED` proves
  the property held, not that the new mechanism is what held it.

**G-6 — no in-process test can verify filesystem honesty about `fsync`.** Inherited from change 5
A7; this lane's file-backed fixtures assert the filesystem *type* (CF-M4) and nothing about whether
it tells the truth. Substitute: CF-M4 plus change 5's calibration warning.

**G-7 — the boundary with the durability lane, flagged rather than assumed.** Everything in this
plan that runs in memory or against a template copy is a *logic* test. An in-memory database is not
a file-backed one under crash: it has no WAL, no checkpoint, no `synchronous` semantics, and no
`-shm`. Crash properties (P12), pragma-floor properties (change 5's P11), backup closure (P13),
`foreign_keys` (P14) and payload-corruption detection (P15) are the durability lane's and are named
here only so the seam is explicit. Where this lane's fixtures are file-backed (CF-P8nc, CF-P10,
CF-C5), they run on `/root` (ext4) and assert it via CF-M4.

**G-8 — tagging findings** (per the brief: a `[manual]`/`[doc]` criterion that could be automated is
a finding):

| Criterion | Current tag | Should be | Why |
|---|---|---|---|
| change 2 **F4** | `[doc]` "recorded, not run" | `[unit][doc]` | Measured executable in nine lines (M-6) |
| change 2 **B4b** | `[prop][manual]` | `[prop]` | The worked fixture and both answers were produced mechanically (`probe.mjs` §C); nothing needs a reviewer's eye |
| change 2 **J2** | `[prop][manual]` | `[prop][CI]` | "Run red, then green, both recorded" is exactly change 3's H3 meta-assertion. Automate it rather than attesting it |
| change 2 **C3** | `[unit]` | keep | Confirmed satisfiable (M-7) |
| change 5 **P2** | `[manual]` | needs correction, not re-tagging | It records defensive-mode affordances as absent from the binding; `SQLITE_DBCONFIG_DEFENSIVE = 1` is set in the constructor and toggled by `unsafeMode()` (NC-4p) |

---

## 6. Blocked on measurement

Tests that cannot get a threshold until a B-gate closes. None of these is blocked from being
*written*; each is blocked from having a pass condition.

| Test | Blocked on | What the gate must produce | Interim posture |
|---|---|---|---|
| CF-P4, CF-P4r (T4 dual addressing) | **B-1** — whether the monotone logical clock is adopted, measured as the same-key collision rejection rate at the chosen `synchronous` on ext4 | The shipped `written_at` expression. The Postgres property needed a 5 ms sleep between puts to avoid millisecond-truncation collisions; whether the SQLite property needs any spacing at all is entirely downstream of this | Write the property against the *observable* (`writtenAt` from `put` addresses the same version); do not encode any spacing constant until B-1 records the branch. A property carrying a hard-coded 5 ms sleep after B-1 closes is a defect |
| CF-P4, CF-R4 (`ClockRegressionError` reachability) | **B-1** | Whether `CLOCK_REGRESSION` retains a second live cause. If the clock does not ship, change 2 D3 requires the catalog unchanged | Assert the error type is reachable *by construction* (a hand-written `written_at ≤ prev` insert), which holds under both branches |
| CF-P10, CF-P10nc (lease) | **B-4** — lease poll interval, timeout budget, worker write-lock amplification, measured under contention at B-2's `synchronous` | The poll interval and the timeout budget. P10's own assertion (`maxActive === 1`) needs neither; but the **negative control**'s "the rest time out" arm needs a timeout that exists | Ship CF-P10 now with `maxActive === 1`; hold CF-P10nc's timeout-count assertion until B-4, asserting only "at least one acquirer failed to acquire" in the interim |
| CF-C4 query-plan assertion; the G3 shape check | **B-2**, **B-3a** — `synchronous` default, `page_size`, `auto_vacuum` | Whether a 1M-version key is in or out of page cache at the shipped `page_size`, which decides whether "same order of magnitude" is a meaningful claim | The **shape** assertion (no upward trend in per-insert time as version count grows by ≥1 order of magnitude) is measurable now and is what change 2 G1 asks for; the absolute figure waits |
| CF-P8nc / CF-P8nc2 (`DEFERRED` prune) | **B-2** only for its timing arm | — | The correctness arm (a live chunk is reclaimed; the checkpoint no longer loads) is deterministic and ships now |
| Fixture-cost claim in §4 | **B-2**, **B-7** | The shipped `journal_mode`/`synchronous` for the wallet file, which decides which row of M-3's table the suite actually pays | Use template-copy (6.72 ms) as the working assumption; re-measure once B-2 closes and record the new figure with its conditions. **No figure in M-3 is a pass threshold** |
| Any assertion on digest write cost inside a conformance property | **C10** (change 5), itself gated on **P1**'s published conditions | Per-write digest cost and storage delta on real payloads | Conformance properties assert *behaviour* (a corrupted row is detected, an uncovered row is not); they assert no cost. Cost belongs to the benchmark lane |

**Not blocked, and worth saying so:** every Group C and Group D test, all of Group B, and the
negative controls NC-1…NC-16 have deterministic pass conditions today. The refinement work — which
is the part the Lean layer does not carry — does not wait on a single measurement.
