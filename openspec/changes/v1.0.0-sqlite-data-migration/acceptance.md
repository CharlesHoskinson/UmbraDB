# Acceptance — PostgreSQL→SQLite data migration for the wallet tier

Every criterion is traceable to a requirement in `specs/data-migration/spec.md` and a task in
`tasks.md`, and is marked with how it is verified: **[unit]** unit test, **[prop]** property test,
**[CI]** CI gate, **[doc]** checkable doc artifact, **[manual]** manual reviewer evidence.

**Nothing here gates on a performance number.** Where a criterion touches import cost or replay cost,
it gates on the *decision rule* being written and open, never on a figure. The one duration in this
change — **D** in §10.3 — is a blocked decision, not a criterion.

**Requirement short names** used in the `Req / Task` column:

| Short name | `specs/data-migration/spec.md` requirement |
|---|---|
| **READONLY** | the migration reads the source PostgreSQL database and never writes to it |
| **LINEAGE** | the target database is created by running the SQLite lineage to completion on an empty file before any row is imported |
| **RECON** | the temporal event log is reconstructed from both source tables and the live version is never dropped |
| **PRECOND** | the reconstruction's source preconditions are verified per key rather than inherited from the adapter |
| **REFUSE** | a source state the event-log encoding cannot represent is refused, and no target database is produced |
| **CKPT** | checkpoint manifest identifiers are preserved and no generated column is transported |
| **IDENT** | the identifier array is exploded into the junction table and the two I-7 cross-checks hold on the imported data |
| **NEWCON** | a source that violates a constraint the target newly adds is refused with a remediation report, and is never quarantined |
| **TWOART** | the stored-value digest and the transport-fidelity comparison are two distinct artifacts and are never conflated |
| **NASCOPE** | a check with nothing in scope reports n/a and never pass, and the fixtures are proven non-empty |
| **TOOLDIAG** | migration-tool failures are tool diagnostics with a stable exit code and a machine-readable report |
| **JSON** | stored JSON values are transported as the source's own canonical text and never through a JavaScript JSON round trip |
| **TIME** | timestamps are transported as an exact millisecond integer under pinned session settings |
| **NOTMINE** | objects belonging to the target lineage are produced by the lineage and are never imported |
| **BUNDLE** | the export is a single read-only snapshot and the bundle is self-describing |
| **LADDER** | verification is a ladder of five rungs whose pass is their conjunction, and it states what it assumes |
| **REPLAY** | point-in-time equivalence is established exhaustively over the breakpoint set |
| **DIGEST** | content verification reuses the durability contract's digest regime and introduces no second mechanism |
| **ATOMIC** | an interrupted migration never leaves a database that presents itself as complete |
| **RERUN** | re-running the migration is safe, and resumability is decided by measurement rather than assumed |
| **NOWEAKEN** | the import does not weaken any check in order to go faster |
| **ROLLBACK** | the supported rollback is the untouched source database and no reverse migration is offered |
| **CHANNELS** | each distribution channel has a written procedure and the container channel's hazards are named |
| **DISCLOSE** | differences that survive a faithful migration are disclosed before the migration runs |
| **NONUMBERS** | no migration duration or throughput figure is asserted, and every PostgreSQL-side claim is labelled |

## P — Preconditions (block the whole change)

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| P0 | Changes 1, 2, 4 and 5 have each settled the half this change consumes; every `file:line` in `design.md` §0.1 resolves; all four validate strict. Until then no section-1 task starts. | [manual][CI] | design §0.1 / 0.1 |
| P1 | Every `design.md` §13 measurement is re-run on `better-sqlite3@13.0.2` (SQLite 3.53.4) and reproduces; both bindings named in the recorded output. A divergence is blocking. | [manual] | design §13 / 0.2 |
| P2 | The owner's container-image inventory answer is recorded (§15 Q-1). Task 6.2 is blocked until it lands. | [manual] | CHANNELS / 0.3 |
| P3 | **Satisfied:** change 4's `design.md` §19.2 rules invariant I-7 — derive `identifiers` from `entry`, cross-check the junction as a **set**, require the `lifecycle` column to equal `entry.lifecycle.status`. `getAll()` is compared **exactly**; the disclosure list is **two** items with lifecycle replacing identifiers. | [manual] | IDENT, DISCLOSE / 0.4 |
| P5 | Change 4's `design.md` §17.4 hand-off is discharged: `design.md` §4.5 distinguishes Class 1 from Class 2, rules refuse-plus-remediation for Class 2 and refuse-only for Class 1, and rejects quarantine with three stated reasons. | [manual] | NEWCON / 0.4b |
| P4 | The three sibling statements that contradict this change on their face are reconciled: change 5's N7 re-scoped, change 4's non-goal/P3/task 0.3 updated to name this change, change 1's dependency row still matching. | [manual][CI] | proposal Impact / 0.5 |

## A — The source is never written to

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| A1 | An automated check over every shipped export `.sql` file finds only `SET`, `BEGIN`, `SELECT`, `COPY … TO`, `COMMIT`, `ROLLBACK`, and fails the build on anything else. | [CI] | READONLY / 1.2 |
| A2 | Fixture A's per-table row counts and content digests are identical before and after a complete export, and after an export killed mid-stream; the relation list is unchanged in both cases. | [unit] | READONLY / 1.5 |
| A3 | **Negative control:** an exporter variant that writes a progress row into the source is rejected by A1's check, and the rejection message states the reason — it would destroy the property that makes the source a valid rollback. | [CI][manual] | READONLY negative-control scenario / 1.2 |
| A4 | No PostgreSQL client library appears in `dependencies` or `devDependencies` at the closing commit, and `docs/supply-chain/inventory.md` gains no PostgreSQL row. | [CI] | design §7.2 / 1.1 |

## B — Lineage before data

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| B1 | Migration `006` applies during import, which is only possible on a zero-row `ckpt_chunks`. | [unit][CI] | LINEAGE / 3.1 |
| B2 | A schema dump of a freshly imported database is byte-identical to a schema dump of a greenfield database at the same lineage position. | [unit] | LINEAGE / 3.1 |
| B3 | `page_size`, `auto_vacuum` and `journal_mode` read back the intended values after import; the importer exposes no option that changes them for a bulk load. | [unit][CI] | LINEAGE / 3.1 |
| B4 | **Negative control:** an importer that creates the chunk table itself and loads rows before the lineage fails at `006` with `cannot add a STORED column`; substituting a `VIRTUAL` column is rejected by review against `v1.0.0-sqlite-schema-parity` requirement *"migration 006 replays verbatim, and no future migration adds a STORED generated column to a populated table"*. | [unit][manual] | LINEAGE negative-control scenario / 3.1 |

## C — The reconstruction

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| C1 | A three-version key yields exactly three `kv_event` rows; the newest derived `valid_to` is `NULL`, not a sentinel; `get()` and `getAt` at every version and every breakpoint match the source. | [unit][prop] | RECON / 3.3 |
| C2 | `kv_history.id`, `valid_to`, `validity` and `kv_current.updated_xact` appear nowhere in the target and nowhere in the import path. | [CI] | RECON / 3.3 |
| C3 | **Negative control:** a `kv_current`-only import passes `get()` for every key and a `kv_current` row count, and is caught only by the per-key check `count(kv_event WHERE key=K) = kv_current.version`. | [unit] | RECON negative-control scenario / 3.3, 4.2 |
| C4 | **Negative control:** a `kv_history`-only import leaves every key returning its previous value from `get()`, and is caught by the same per-key check. | [unit] | RECON negative-control scenario / 3.3, 4.2 |
| C5 | The import is per-key ascending in `version` with strictly increasing `written_at`, and interleaving different keys is permitted; both are asserted against change 2's triggers. | [unit] | design §2.3 / 3.3 |
| C6 | No imported value derives from the wall clock: `grep` over the import path finds no `Date.now`, `new Date()` or `unixepoch` outside logging. | [CI] | RERUN / 5.2 |

## D — Preconditions verified, not inherited

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| D1 | The S1–S6 pass runs before the first write transaction opens; against Fixture A it reports clean. | [unit] | PRECOND / 3.2 |
| D2 | Against Fixture B, each of the six preconditions produces a distinct refusal naming the precondition id, the `(ns, scope, key)` and the two source rows involved. Six tests. | [unit] | PRECOND, REFUSE / 3.2, 7.2 |
| D3 | Every refusal leaves **no file at the target path** and exits non-zero. | [unit] | REFUSE / 3.2, 5.1 |
| D4 | **Negative control (measured):** a gapped source imported without the S3 check yields derived intervals `[1000,3000)`/`[3000,NULL)` and `getAt({at:2500})` returning version 1 where the source returned `null` — while row counts, per-row digests and every change-2 assertion pass. | [unit] | REFUSE negative-control scenario, design §13 E3 / 3.2, 4.4 |
| D5 | **Negative control:** an importer that resolves a history/current version collision with the source's `priority` tiebreak passes the `getAt` replay and is caught **only** by the `get()` replay. | [unit] | REFUSE negative-control scenario / 3.2, 4.5 |
| D6 | Change 2's triggers are never disabled; a violating row that reaches the database aborts with `UB_T1_VERSION` or `UB_T4_CLOCK`, and that is documented as a backstop rather than the diagnostic. | [unit][doc] | REFUSE / 3.2, 3.8 |
| D7 | No refusal adds an entry to `docs/ERROR-CATALOG.md`; the catalog drift test stays green and the code count is unchanged. | [CI] | REFUSE / 3.2 |

## E — The other tiers

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| E1 | Manifest ids are preserved; after import a new `CheckpointStore.save()` allocates an id strictly greater than every imported id, with no manual `sqlite_sequence` seeding. | [unit] | CKPT, design §13 E1 / 3.4 |
| E2 | `PRAGMA foreign_key_check` returns empty after import; a manifest referencing one chunk hash at two positions still does; `size_bytes` equals `octet_length(data)` without having been transported. | [unit] | CKPT / 3.4 |
| E3 | **Negative control (measured):** importing with `foreign_keys = OFF` and one chunk omitted produces a dangling junction row that `integrity_check` reports as `ok` and only `foreign_key_check` names. | [unit] | CKPT negative-control scenario, design §13 E4 / 3.4, 4.1 |
| E4 | The wallet-state envelope requires no import step, and `WalletStateEnvelopeStore.load()` round-trips for every `(walletId, networkId)` in Fixture A. | [unit] | CKPT, design §1.2 / 4.5 |
| E5 | A source row with `identifiers = ['a','a','b']` yields exactly two junction rows and an `entry` still containing `["a","a","b"]`; `getAll().identifiers` returns `["a","a","b"]` unchanged across the migration, because I-7 derives it from `entry`. | [unit] | IDENT / 3.5, 4.5 |
| E6 | Junction cardinality is compared against the distinct-triple count; a test proves comparing against summed array length fails on E5's row. | [unit] | IDENT / 3.5, 4.2 |
| E8 | Both I-7 cross-checks are asserted against the target alone: junction rows equal the identifiers derived from `entry` **as a set**; the `lifecycle` column equals `entry.lifecycle.status`. A sequence comparison of the junction is shown to raise a spurious fault on a re-ordered `entry` array. | [unit] | IDENT / 4.5 |
| E9 | **Negative control:** a read path that returns the junction rather than deriving from `entry` returns wrong identifiers with **every digest passing**, because no per-value digest covers the junction — and additionally reorders and deduplicates the array relative to the source. | [unit][manual] | IDENT negative-control scenario / 4.5 |

## M — Newly added constraints (change 4 §17.4's hand-off)

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| M1 | A source with two `ckpt_manifests` rows sharing `(w, net, seq)` is refused, leaves no target database, names both rows, and emits source-side remediation statements. | [unit] | NEWCON / 3.5b |
| M2 | A source whose `next_seq` is below `max(seq)` for its `(w, net)` is refused by the invariant check specifically, proven by a test in which the `008` unique constraint alone would have passed — the pruned-gap case of change 4's `design.md` §17.3(b). | [unit] | NEWCON / 3.5b |
| M3 | A non-32-byte `hash`/`manifest_hash` and an out-of-enum `lifecycle` are each refused with a remediation report. | [unit] | NEWCON / 3.5b |
| M4 | Class 1 refusals emit **no** remediation script; Class 2 refusals always do. Both leave no target database. | [unit] | NEWCON / 3.5b, 3.5c |
| M5 | An `identifiers`-column/`entry` disagreement and a `lifecycle`-column/`entry` disagreement are each refused as Class 1, with a diagnostic recording that the inconsistency predates the migration. | [unit] | NEWCON, IDENT / 3.5c |
| M6 | **Negative control:** a quarantining variant produces a target that is not observationally equivalent while reporting success; review records that there is nowhere to put the set-aside rows and that it inverts who dropped the manifest. | [unit][manual] | NEWCON negative-control scenario / 3.5b |
| M7 | No quarantine path exists in the shipped tool: `grep -rn "quarantine\|skipped_rows\|rejected_rows"` over the migration tool returns nothing. | [CI] | NEWCON / 3.5b |
| E7 | Watermarks copy without an ordering claim; migration `005`'s fillfactor invariant is not carried into the target. | [unit] | design §5.2 / 3.5 |

## F — Value fidelity

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| F1 | `grep -rn "JSON.parse"` over the export and transport path returns nothing. | [CI] | JSON / 1.3 |
| F2 | A value whose PostgreSQL text is `{"fees": 12345678901234567890123}` exports with those digits intact, asserted byte-for-byte against `jsonb::text`. | [unit] | JSON / 1.3 |
| F3 | **Negative control (measured):** the same value through `JSON.parse`/`JSON.stringify` becomes `1.2345678901234568e+22`, and `0.1000000000000000055511151231257827` becomes `0.1`; neither is detected by a row count, by a digest taken after the round trip, or by a replay that compares parsed values. | [unit] | JSON negative-control scenario, design §13 E5 / 1.3 |
| F4 | The two artifacts are separate: `dg` is computed over the stored bytes with **no canonicalisation** and is persisted; the transport-fidelity comparison is over canonically parsed values, is not persisted, and is not called a digest. Neither is computed by comparing a `jsonb` rendering against a `JSON.stringify` rendering. | [unit][manual] | TWOART / 2.2b |
| F4b | Gate G-11's incoherent single-artifact phrasing appears nowhere in this change. Run through the shared refuted-phrase sweep rather than by reproducing the phrase here, so this criterion does not trip its own check. | [CI] | TWOART / 2.2b |
| F4c | `dg` for an imported row equals the digest the adapter computes for the same row on the read path — only possible if neither side canonicalises. | [unit] | TWOART / 2.2b |
| F4d | **Negative control:** a canonicalising `dg` makes two byte-sequences differing only in whitespace produce the same digest, disabling the detection it exists for. | [unit] | TWOART negative-control scenario / 2.2b |
| F5 | A fixture row's known `updated_at` exports to that instant's exact epoch milliseconds, asserted with `===` and not a tolerance; the bundle records `server_version_num` and an unknown version is refused. | [unit] | TIME / 1.3, 2.1 |
| F6 | **Negative control:** an ISO-8601 string bound into the epoch-millisecond column is rejected by `STRICT`; the review record states what it would have caused without `STRICT` — Law T3 silently false with the mechanised proof green. | [unit][manual] | TIME negative-control scenario / 3.3 |
| F7 | Sub-millisecond truncation on `ckpt_*.created_at` and `watermarks.updated_at` is recorded in the bundle manifest rather than performed silently. | [unit][doc] | TIME / 2.1 |
| F8 | A NUL byte or a lone surrogate anywhere in the bundle is refused at the boundary, not stored. | [unit] | design §6.5 / 3.7 |

## G — The bundle

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| G1 | The whole export runs in one `REPEATABLE READ READ ONLY` transaction; running the export twice against an unchanged Fixture A produces byte-identical bundles. | [unit] | BUNDLE / 1.2 |
| G2 | The manifest is Zod-validated at import; a manifest missing any required field is refused naming the field. One test per required field. | [unit] | BUNDLE / 2.1 |
| G3 | Truncating a data file, deleting a data file, corrupting one byte, and editing one manifest row count each produce a refusal, a non-zero exit and no file at the target path. Four tests. | [unit] | BUNDLE / 2.3 |
| G4 | **Negative control:** an export that dumps `kv_history` and `kv_current` in two separately timed queries can produce a bundle violating S3 for a key that was never inconsistent in the source; the review cites `docs/CONTRACT.md:122-133` for the checkpoint half of the same hazard. | [unit][manual] | BUNDLE negative-control scenario / 1.2 |
| G5 | Every text-keyed export is ordered `COLLATE "C"` and the resulting order equals the target's `BINARY` order, compared element by element on the `design.md` §13 E6 key set. | [unit] | DIGEST / 1.4 |

## H — Verification

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| H1 | V1–V5 all run and an overall pass is their conjunction; no rung is reported as advisory. | [unit][CI] | LADDER / 4.1–4.6 |
| H2 | A target with a dangling foreign key fails V2 although `integrity_check` reports `ok`; a target one migration short fails V1. | [unit] | LADDER / 4.1 |
| H3 | V3 checks `count(kv_event) = count(kv_history) + count(kv_current)` **and** the per-key form; excludes generated columns, `<schema>_migrations` and `<schema>_writer_generation`. | [unit] | LADDER / 4.2 |
| H4 | Dropping one interior version from one key's chain is detected by the per-key check; a test confirms the whole-table total alone misses it when a row is added elsewhere. | [unit] | LADDER / 4.2 |
| H5 | V4 detects a single flipped byte in an imported value, naming table and row. | [unit] | DIGEST / 4.3 |
| H6 | The V5a probe set has size at most `2\|B\|+1` per key, asserted by test, and covers every breakpoint, one interior instant per gap wider than 1 ms, one instant before the earliest, every version in `1..n`, and `0` and `n+1`. | [unit][prop] | REPLAY / 4.4 |
| H7 | With the pre-flight pass disabled for the test, V5a independently detects the gap-manufacture case — proving the replay is a second check and not a restatement of the S1–S6 pass. | [unit] | REPLAY / 4.4 |
| H8 | **Negative control:** a thousand-random-instants variant misses a one-millisecond boundary shift that the exhaustive form catches. | [unit] | REPLAY negative-control scenario / 4.4 |
| H9 | The `get()` replay detects the version-collision case that the `getAt` replay passes. | [unit] | LADDER / 4.5 |
| H10 | `listKeys` is compared as a **set** plus a separate code-point-ordering assertion; a sequence comparison is shown to fail on a correctly migrated database. | [unit] | LADDER, DISCLOSE / 4.5 |
| H11 | With the source unreachable the report marks V5b **not run** explicitly rather than omitting the rung. | [unit] | LADDER / 4.6 |
| H12 | The V1–V5a report contains the sentence distinguishing "the import was faithful to the bundle" from "the export faithfully rendered the source", and names the fixture that discharges the latter. | [doc] | LADDER / 4.7 |
| H13 | No hash construction of this change's own exists: every hash call in the migration tool resolves to change 5's digest helper (SHA-256, 32 raw bytes), and changing change 5's algorithm changes the migration digest with no edit here. | [CI][unit] | DIGEST / 2.2 |
| H14 | No new error code, no digest column and no extension of change 5's coverage set is introduced; a migration mismatch is never reported as `VALUE_INTEGRITY`. | [CI][manual] | DIGEST / 2.2, 4.3 |
| H15 | `dg` is computed at import and never transported; it is excluded from V3 and from the source side of V4, as generated columns are. | [unit] | DIGEST / 2.2, 4.2 |
| H16 | A `NULL` `dg` on any covered row after import **fails** verification, notwithstanding change 5's general `NULL`-means-not-yet-computed semantics — the importer held the value. | [unit] | DIGEST / 4.1 |
| H17 | Rows outside the `dg` coverage set fold on their existing content address where they have one (`ckpt_chunks.hash`, `ckpt_manifests.manifest_hash`), not on a newly minted digest. | [unit][manual] | DIGEST / 2.2 |

## J — Failure, publication, re-run

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| J1 | Killing the importer at ten different points leaves no file at the target path in all ten runs. | [unit] | ATOMIC / 5.1 |
| J2 | **Negative control:** a variant that renames before checkpoint-and-close produces a database missing its most recent commits while reporting `integrity_check → ok`. | [unit] | ATOMIC / 5.1 |
| J3 | Importing the same bundle twice into two paths yields equal per-table digests for every table. | [unit][prop] | RERUN / 5.2 |
| J4 | **Negative control:** a resume that inspects the target to decide what to skip leaves a key interrupted mid-chain silently truncated while every isolated check on that key passes. | [unit] | RERUN negative-control scenario / 5.3 |
| J5 | No resume protocol is implemented; `design.md` §10.3's rule is reproduced in the migration notes with **D** unmeasured and register entry M-2 open. | [CI][doc] | RERUN / 5.3 |
| J6 | `grep` over the migration tool finds no `synchronous` change, no `foreign_keys = OFF`, no `ignore_check_constraints`, no `DROP TRIGGER`, and no `INSERT OR REPLACE`/`REPLACE INTO`. | [CI] | NOWEAKEN / 3.8 |
| J7 | A deliberately introduced `INSERT OR REPLACE` in the importer **fails the build** under change 2's automated guard — confirming the importer is inside that guard's scope. | [CI] | NOWEAKEN / 3.8 |
| J8 | The import runs in row-count-bounded transactions; the batch default is configuration-driven and marked blocked on register entry M-1, not hard-coded. | [unit][doc] | NOWEAKEN / 3.8 |
| J9 | **Negative control:** a single whole-file import transaction trips change 5's long-held-transaction diagnostic, and the atomicity it buys is already provided by J1's mechanism. | [unit][manual] | NOWEAKEN negative-control scenario / 3.8 |

## Q — Empty scope, tool diagnostics and the inherited write-lock premise (gates G-9, G-12, G-14)

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| Q1 | A bundle with correctly-formed but empty data files yields `n/a — no rows in scope` for every content, cardinality and replay check and an overall outcome that is **not** `pass`. | [unit] | NASCOPE / 4.6b |
| Q2 | **Negative control:** a seeding defect emptying Fixture A fails the fixture-inventory assertion instead of producing a smaller green run. | [unit] | NASCOPE negative-control scenario / 4.6b, 7.1 |
| Q3 | A database that legitimately has no transaction-history rows reports `n/a` for that tier, still permits an overall pass, and has every `n/a` rung named in the report. | [unit] | NASCOPE / 4.6b |
| Q4 | Six failure classes exit with six distinct documented codes; exit `0` occurs only for a completed, fully verified migration. | [unit][doc] | TOOLDIAG / 4.8 |
| Q5 | A shell-script test branches on exit codes with no message parsing; the report file alone determines the outcome. | [unit] | TOOLDIAG / 4.8 |
| Q6 | `docs/ERROR-CATALOG.md` is unchanged; the drift test is green and the code count unchanged; no refusal is a `StorageError` subclass. | [CI] | TOOLDIAG / 4.8 |
| Q7 | **Negative control:** raising a migration refusal as a `StorageError` subclass is rejected — it would add a member to the frozen error surface for a process outside the library. | [unit][manual] | TOOLDIAG negative-control scenario / 4.8 |
| Q8 | The import-transaction requirement states the write-lock premise is **absent, not weakened**, when the descriptor precondition is violated, and carries the void-not-degraded scenario. `grep -rn "absent, not weakened" specs/` hits it. | [CI][manual] | NOWEAKEN / 0.4c |
| Q9 | No requirement rests exclusivity on `BEGIN IMMEDIATE` alone or derives process-level exclusivity from transaction serialization; exclusivity cites the writer-generation guard **and** the descriptor precondition. Checked by the shared refuted-phrase sweep, not by reproducing the phrase here. | [CI] | NOWEAKEN / 0.4c |
| Q10 | Row E-10's obligation is recorded in **this change's** `tasks.md` (task 0.4c), not only in change 3's design — the mechanism that stops a handover going missing the way I-4 did. | [manual] | NOWEAKEN / 0.4c |

## R — Citation integrity (gate G-16)

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| R1 | `grep -rnoE "v1\.0\.0-sqlite-[a-z-]+/[a-z]+\.md:[0-9]+" .` returns nothing. | [CI] | — / 0.4d |
| R2 | No bare `` `spec.md:NNN` `` or `` `design.md:NNN` `` token referring to a sibling change remains; in-repo citations into `src/`, `docs/`, `README.md`, `ROADMAP.md` are retained deliberately, and the reason is written down. | [CI][manual] | — / 0.4d |
| R3 | Every requirement-title anchor resolves to a live `### Requirement:` heading in the named change; every design anchor resolves to a numbered section. | [CI] | — / 0.4d |
| R4 | The two citations change 5 flagged as dangling resolve after the repoint, and neither leaves a decision unowned: catalog membership is change 5's ruling, exit codes and report schema are this change's. | [manual] | TOOLDIAG / 0.4d, 4.8 |

## K — Documents

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| K1 | A reviewer executes the clone procedure end to end against Fixture A from the written text alone and succeeds; the transcript is recorded. | [manual] | CHANNELS / 6.1 |
| K2 | The notes state that UmbraDB builds and publishes no container image, backed by a recorded command showing no `Dockerfile`, compose file or image-publish step in the repository. | [doc][manual] | CHANNELS / 6.2 |
| K3 | All five container hazards appear with their consequences; the filesystem hazard cites change 5's refused-type list and states that a refusal there is expected behaviour. | [doc] | CHANNELS / 6.2 |
| K4 | The disclosure list contains exactly two items: the `listKeys` reorder with the resume-cursor instruction, satisfying `v1.0.0-sqlite-schema-parity` requirement *"listKeys ordering is code-point order and the one-time resume-cursor reorder is disclosed"*'s obligation at a cited paragraph; and the `lifecycle` agreement fault, stated as a visibility change rather than a value change. | [doc] | DISCLOSE / 6.3 |
| K4b | The notes **do not** list `identifiers` as a difference, and a doc test asserts that absence, so a later edit cannot silently re-add a claim that I-7 made false. | [doc][CI] | DISCLOSE / 6.3 |
| K4c | Both disclosure items are framed as consequences of invariants that make the store stricter, not as regressions. | [doc][manual] | DISCLOSE / 6.3 |
| K5 | The rollback section cites `docs/STABILITY.md:34-36` and `:40-42`, states that the untouched source satisfies the backup guidance without the consumer taking a backup, states that migration is required to run 1.0.0, and states the `0.9.5` tag as the stay-put option. | [doc] | ROLLBACK / 6.4 |
| K6 | No reverse SQLite→PostgreSQL path is built or promised, and the reason is written. | [doc][CI] | ROLLBACK / 6.4 |
| K7 | The two `docs/CONTRACT.md` §2 clarifications are handed to change 5 as inbound items and appear in **no** diff of this change. | [manual] | design §11.3 / 6.5 |

## L — Fixtures and evidence discipline

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| L1 | Fixture A contains no raw SQL against the source schema — every row is produced through the 0.9.5 public API — and its contents are pinned by a checked-in inventory the tests assert against, so a silently shrinking fixture fails. | [CI][unit] | design §14 / 7.1 |
| L2 | Fixture B has twelve cases — six Class 1 temporal, two Class 1 transaction-history disagreements, four Class 2 — with twelve distinct refusals and twelve assertions that no target database exists afterwards; the four Class 2 cases emit a remediation report and the eight Class 1 cases do not. Tasks 3.2, 3.5b and 3.5c do not close without it. | [unit] | design §14, §4.5 / 7.2 |
| L3 | The conformance-manifest decision is written: either a reasoned statement that these tests are not gated, or a new id plus a pinned-count change **in a separate commit from any deletion**. | [manual][CI] | design §14 / 7.3 |
| L4 | Every duration/throughput/rate hit across the five documents is inside a decision rule naming change 1's measurement gate, or inside `design.md` §13 with its command and conditions. No bare figure appears in a requirement. | [manual] | NONUMBERS / 8.1 |
| L5 | Every PostgreSQL-behaviour statement carries `[code]` with a `file:line` or `[inference]`; none is presented as measured. | [manual] | NONUMBERS / 8.1 |
| L6 | Any measurement this change performs uses a database file on a real, non-memory-backed filesystem, and names both the binding it was taken through and the obligation to re-confirm on the ruled binding. | [manual][doc] | NONUMBERS / 0.2, 8.1 |

## N — Negative / boundary criteria (nothing out of scope leaked in)

| # | Criterion | Verify | Source ruling |
|---|---|---|---|
| N1 | No archive data is imported and no archive import step exists; the stated reason is the absence of rows, not the absence of a runner. The archive is owned by change 6. | [manual] | proposal non-goals |
| N2 | No target DDL is authored here: no `CREATE TABLE`, `CREATE INDEX`, `CREATE TRIGGER` or `CREATE VIEW` for a target object appears outside a quotation attributed to change 2 or change 4. | [CI][manual] | proposal non-goals |
| N3 | No digest algorithm is chosen, no `verifyIntegrity` behaviour is redefined, no backup/restore text is written, and `docs/CONTRACT.md` §6 is not touched. | [manual] | proposal non-goals |
| N4 | No driver, shim, bind-normalisation, decoding, worker-topology or pragma-ordering decision is made here. | [manual] | proposal non-goals |
| N5 | No reverse migration, no dual-backend mode, no runtime engine switch, and no zero-downtime/CDC mechanism is specified. | [manual] | proposal non-goals |
| N6 | No addition to the frozen public barrel: the migration is reachable by `npm run`, never by `import { … } from "umbradb"`. The api-surface barrel test stays green with no new export. | [CI] | proposal non-goals |
| N7 | No container image is built or published by this change. | [CI][manual] | proposal non-goals |
| N8 | No claim of coverage for encryption at rest, network filesystems, or Windows-specific behaviour, beyond naming the container-volume filesystem hazard because change 5's probe hard-refuses on it. | [manual] | proposal non-goals |
| N9 | Change 1's task-0.5b refuted-phrase sweep returns zero hits over this change's directory. Run through the shared script rather than by reproducing the phrase list here, so this change does not trip its own check. | [CI] | change 1 task 0.5b / 8.2 |
| N10 | `/usr/local/bin/openspec validate v1.0.0-sqlite-data-migration --type change --strict --no-interactive` exits zero, output recorded verbatim; the two pre-existing failures elsewhere are unchanged. | [CI] | — / 8.3 |

> **Reconciliation note — why the negative controls carry this change.** Four criteria here would
> each, alone, be the difference between a migration that is correct and one that is merely green:
> **D4** (a gapped source manufactures data while every count and digest agrees), **D5** (a version
> collision resolved rather than refused passes the `getAt` replay and changes what `get()` returns),
> **F3** (a JavaScript round trip destroys stored numbers in the one tier that is not re-derivable
> from chain), and **E9** (a junction-reading transaction-history read path returns wrong identifiers
> with every digest passing, because no per-value digest covers a derived index). None of the four is
> detectable by the checks a reader would reach for first. Each is measured or directly derived from
> cited code, and each is written as a scenario rather than as advice. A green run of this change's
> suite means something only because those four are in it.
>
> **Reconciliation note — the §17.4 hand-off.** `v1.0.0-sqlite-schema-parity/design.md` §17.4 states
> its obligation and declines to discharge it: *"Change 7 … must decide what happens to rows that
> fail the new constraint — reject the migration, or quarantine and report. This change does not
> decide that; it states the obligation."* Section **M** is what makes that decision falsifiable
> rather than merely written: **M6** is the quarantine option implemented and shown to report success
> on a non-equivalent database, and **M7** is the assertion that it does not exist in the shipped
> tool. A ruling with no negative control is a preference; with M6 and M7 it is a constraint.
