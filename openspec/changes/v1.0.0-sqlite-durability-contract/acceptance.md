# Acceptance — SQLite durability contract, error catalog and evidence

Objective acceptance criteria for change `v1.0.0-sqlite-durability-contract`. Every criterion is
traceable to a requirement in `specs/release-contract/spec.md` and a task in `tasks.md`, and is
marked with how it is verified: **[unit]** unit test, **[prop]** property test, **[CI]** CI gate,
**[doc]** checkable doc artifact or doc test, **[manual]** manual reviewer evidence.

**Nothing here gates on a performance number.** Where a criterion depends on a performance property,
it gates on the *existence of a measurement under stated conditions*, never on a value — the research
corpus that would have supplied values measured a RAM disk and is inadmissible (`design.md` §1.3).

## Preconditions (block the whole change)

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| P0 | The driver ruling is recorded with its pinned version and runtime `sqlite_version()`, plus whether the engine handle is worker-owned. **Satisfied:** `better-sqlite3@13.0.2`, `sqlite_version()` 3.53.4, re-verified first-hand (`design.md` §0.4; tasks note 0.1). Worker-versus-in-process remains change 1's and no criterion here depends on it. | [manual] | design §0.4 / 0.1 |
| P1 | `v1.0.0-sqlite-engine-core`'s measurement gate exists and its conditions (filesystem, `journal_mode`, `synchronous`, dataset size relative to page cache, unit of work) are published, so criteria B3, C10 and E1 can reference them. | [manual] | "synchronous default is FULL" / 0.1, 3.3 |
| P2 | No criterion in this file assumes `enableDefensive`, `setAuthorizer`, a session extension, an `interrupt` entry or a virtual-filesystem hook — each verified absent from the ruled binding's prototype. | [manual] | design §0.4 / 0.1 |

## A — The durability probe

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| A1 | Every probe decision is an exported pure classifier with no database dependency, and every branch of every classifier is covered by direct injection. | [unit][CI] | "probe verifies library-controlled pragmas" / 2.1 |
| A2 | `journal_mode` in `{off, memory}` makes `runMigrations` reject with `DurabilityContractError` before any migration row is written, with no override option. | [unit][CI] | same / 2.2 |
| A3 | `synchronous = OFF` rejects; `synchronous = NORMAL` under a `FULL` floor returns a `kind: "lost-tail"` warning through `onDurabilityWarning` and the migrations run. | [unit][CI] | same / 2.2 |
| A4 | `foreign_keys` other than `ON` rejects, and the message states that the checkpoint schema's cascade is what allows a manifest delete, so the setting makes GC a silent no-op. | [unit][CI] | same / 2.2 |
| A5 | A database file on `nfs`/`cifs`/`v9fs`/`tmpfs`/`ramfs`/un-allowlisted `fuse` rejects, naming the filesystem type; the refusal is keyed on the reported type, not on timing. | [unit][CI] | same / 2.3 |
| A6 | **Negative control:** in the same situation, a `PRAGMA journal_mode` readback alone returns `wal`, demonstrating that readback is insufficient. | [unit][CI] | same (negative-control scenario) / 2.3 |
| A7 | The `fsync` calibration produces only warnings in every test, and `docs/durability-contract.md` states that no in-process probe can verify filesystem honesty about `fsync`. | [unit][doc] | same / 2.4 |
| A8 | `docs/durability-contract.md`'s binding deployer preconditions reduce to one (local, non-networked filesystem), and every remaining summary-table row cites the classifier that enforces it. | [doc] | same / 5.1 |

## B — The `synchronous` decision rule

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| B1 | The shipped default is `synchronous = FULL`. | [unit][CI] | "synchronous default is FULL" / 2.2 |
| B2 | No document in this change's set states a commits-per-second figure, throughput ratio or latency for any `synchronous` level as an established fact. Enforced by a doc test, not by review. | [doc][CI] | same / 5.1 |
| B3 | The durability contract enumerates all three preconditions for lowering the default: a magnitude measured under P1's conditions, power-loss evidence with a failing negative control, and a recorded decision. | [doc] | same / 5.1 |
| B4 | **Negative control:** the document states that SIGKILL trials are not admissible as power-loss evidence, and gives the reason (SIGKILL is a process crash, which is exactly the guarantee `NORMAL` does make). | [doc] | same (negative-control scenario) / 5.1 |
| B5 | The document states that a measurement taken on a filesystem the probe would refuse is inadmissible. | [doc] | same / 5.1 |
| B6 | The document states that `NORMAL` is contract-legal in kind and that legality is not sufficiency, in the same paragraph. | [doc] | same / 5.1 |

## C — Corruption detection (the enhancement mandate)

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| C1 | A value whose bytes are altered in the database file after a checkpoint is **detected** on read: the adapter rejects with `ValueIntegrityError` (`code === "VALUE_INTEGRITY"`) carrying the table name and primary key, and never returns the corrupted bytes. | [unit][prop][CI] | "value digest" / 3.1 |
| C2 | **Negative control (P15), both cases:** the payload fixture checked only with `integrity_check` and `quick_check` reports `ok` on both and a full scan returns the corrupted row as data; the structural fixture is reported by **both** checks and the read throws. | [prop][CI] | same (negative-control scenario) / 3.2 |
| C3 | The digest is written in the same statement as the value, and the covered set is exactly `kv_event.value`, `watermarks.value` (**both** lineages), `transaction_history.entry`, and all non-PK columns of `bridge_observations` and `verifier_key_observations`. No `dg` column exists on `ckpt_chunks`, `ckpt_manifests`, `chain_blobs`, `blocks`, `transactions` or `chain_blob_roles`. The phrase "wallet-state envelope store" appears in no coverage context. | [unit][doc][CI] | "three-class coverage set" / 3.1 |
| C3a | The preimage is versioned, length-prefixed and binds table, column and primary key, and is computed over the **stored bytes**. A whole-row substitution is detected; the paired negative control shows a bare value hash verifying clean under the same substitution. | [unit][CI] | "framed preimage" / 3.1a |
| C3b | Every covered table carries the no-UDF drift-guard trigger: an update leaving `dg` unchanged aborts, the same update with a recomputed `dg` succeeds, and `sqlite_schema` references no user-defined function. | [unit][CI] | same / 3.1b |
| C3c | A migration that rewrites a covered column's bytes without recomputing `dg` fails the lint; one that recomputes passes. | [unit][CI] | "stored bytes, never a logical value" / 3.1d |
| C3d | The salvage bypass exists, is off by default, returns damaged bytes only when enabled, reports every bypassed row, and cannot disable digest computation, narrow the coverage set, or change what `verifyIntegrity()` reports. | [unit][doc][CI] | "dangerous bypass" / 3.1c |
| C4 | `CHUNK_INTEGRITY` and `VALUE_INTEGRITY` are distinguishable by `code` alone; the content-addressed tier is not given a second, redundant digest. | [unit] | "coverage set" / 3.1 |
| C4a | Verification occurs on **every** read of a covered column, and no configuration option disables it. | [unit][CI][manual] | "a covered row cannot be downgraded" / 3.1 |
| C4b | An update setting `dg` to NULL on a covered row whose digest is non-NULL **aborts** on the anti-downgrade trigger; replacing a non-NULL digest with a different non-NULL digest still succeeds; backfill's NULL-to-value write is unobstructed. | [unit][CI] | same / 3.1e |
| C4c | **Negative control:** with only the drift-guard trigger installed, `UPDATE … SET dg = NULL` is accepted and the row becomes permanently unverified — demonstrating the one-directional gap the anti-downgrade trigger closes. | [unit][CI] | same (negative-control scenario) / 3.1e |
| C4d | A covered row whose `dg` is NULL raises `ValueIntegrityError` on read naming table and primary key; the value is not returned. No warn branch ships in any lineage of this release. | [unit][CI] | same / 3.1e |
| C4e | The `dg` column is nullable at the schema level and its adding migration carries the **named null-tolerant** length constraint; a 31-byte digest is rejected naming the constraint, 32 bytes and schema-level NULL are accepted, and no `NOT NULL` or non-null default exists. | [unit][CI] | "value digest" / 3.1 |
| C4f | **Negative control:** the superseded rationale — that any length constraint forecloses the NULL marker — is recorded as false in **both** forms, since a constraint evaluating to NULL passes under three-valued logic. | [doc][unit] | same (negative-control scenario) / 3.1 |
| C5 | The verification pass runs the structural check **and** the digest sweep **and** the schema digest **and** the invariants, reporting all four together; it reports an overall failure when any part fails, and never throws or refuses. | [unit][CI] | "verification pass runs four parts" / 4.1 |
| C5a | `quick_check` appears nowhere as an alternative to `integrity_check`; the only occurrences are the negative-control test and the contract sentence prohibiting it. | [doc][CI] | same / 4.1 |
| C5b | The pass is not invoked from `open()` or `runMigrations`. | [unit][CI] | same / 4.1 |
| C6 | A structurally-`ok` database with one digest mismatch fails the pass, with all four parts reported separately and the failing row named by table and primary key. | [unit][CI] | same / 4.1 |
| C6a | A schema-text mismatch makes `open()` raise `DatabaseCorruptError` with a `schemaDigest` detail, without scanning data; a **value**-digest failure does **not** refuse at open. | [unit][CI] | "schema digest verified at open" / 3.5 |
| C6b | Invariant I-6 fires: a watermark corrupted upward whose guard suppresses a legitimate write raises `ValueIntegrityError`; the negative control against a plain no-op guard shows the corrupted position persisting and correct writes discarded. | [unit][CI] | "anti-latch" / 3.6 |
| C6c | Each Class B invariant names exactly one owning change; none owned elsewhere is re-specified here; change 6 records M-5 as resolved. | [manual] | "invariants owned across the sprint" / 3.7 |
| C7 | `docs/CONTRACT.md` §1 uses the **two-case** wording (structural damage detected and the read fails; value-byte damage undetected and returned as data), states that the structural check is sound for rejection and not for acceptance, carries the coverage table, and states detection is not repair. | [doc][CI] | "integrity boundary disclosed" / 5.2 |
| C7a | §1 states the limits: at-rest detection only; unkeyed and therefore not a tamper defence; and the coherently-wrong restored file that nothing self-consistent can detect. | [doc] | same / 5.2 |
| C8 | No document states or implies that the engine detects nothing, and every write-ahead-log checksum claim is explicitly scoped to the log. Enforced by a doc test. | [doc][CI] | same / 5.2 |
| C9 | The not-a-regression paragraph is present and grounded: it cites the probe's actual scope (`src/postgres/durability-probe.ts:204-206` — three settings, none of them page checksums) and the absence of any `data_checksums`/`amcheck`/`pg_checksums` mention in the shipped documents, and states that what is removed is the operator's **option**. No sentence claims UmbraDB restores a capability the PostgreSQL backend gave the consumer. | [doc][CI] | same / 5.2 |
| C9a | The disclosure appears in all six channels, and **no channel depends on a container image** — the repository builds none and references no registry. | [doc][CI] | same / 5.2a |
| C9b | No document cites a corruption frequency figure; the record states that no field base rate was obtained. | [doc][CI] | same / 5.2, 3.3 |
| C9c | The checksum VFS is recorded as considered and **declined**, with the process-global default-VFS reason stated; the contract warns that the verification pragma is silently accepted and does nothing on the pinned build, and names the correct probe; new databases pre-provision no reserve bytes. | [doc][unit][CI] | "checksum VFS declined" / 5.2b |
| C10 | The digest's write cost is measured under P1's conditions and recorded, together with the storage delta on real payloads. **The coverage set in C3 is unconditional; there is no cost-based fallback, and no term anywhere conditions mandatory coverage.** | [manual] | "unmeasured quantities carried as obligations" / 3.3 |
| C11 | Corruption recovery is row-scoped: with one covered row corrupted, an unrelated read succeeds and open, migrations and lease acquisition all succeed. | [unit][CI] | "recovery is row-scoped" / 5.8 |
| C12 | `docs/recovery/CORRUPTION.md` exists with the four consumer paths, names the non-re-derivable tiers in the re-derive path, names the verification pass as the post-restore check, and presents filesystem or hardware integrity only as defence-in-depth. | [doc] | same / 5.8 |
| C13 | The verification pass is documented as an on-demand diagnostic and post-restore check only; no document recommends a scheduled pass or assumes one is affordable. | [doc][CI] | "unmeasured quantities" / 4.2 |

## D — Cancellation

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| D1 | `docs/CONTRACT.md` §3 contains no clause asserting that an in-flight read, cursor or lock wait is freed, unwound, interrupted or cancelled by an abort. Enforced by a doc test, not review. | [doc][CI] | "cancellation contract promises only what a mechanism delivers" / 5.3 |
| D2 | §3 states the two unconditional timings: an already-aborted signal issues no query; an abort during a write may still complete and the caller must re-read. | [doc] | same / 5.3 |
| D3 | §3 lists what is not cancellable — any scan inside a single engine call, the `withTransaction(fn)` body, the backup operation, and compaction — and gives the reason for the callback body (arbitrary caller code on the caller's thread, unshippable to a worker as a program). | [doc] | same / 5.3 |
| D4 | **Negative control:** a §3 that softens "freed" to "best-effort freed" or "may be freed" is rejected, and the change record says why. | [manual] | same (negative-control scenario) / 5.3 |
| D5 | IF the JavaScript poll-loop sentence is included, THEN it names the poll interval as the bound and does not extend to any wait inside an engine call; IF `v1.0.0-sqlite-concurrency-lease` does not ship a poll loop, THEN the sentence is absent. | [doc][manual] | same / 5.3 |
| D6 | `releaseLease` remains signal-less, with the existing reason retained. | [doc][unit] | same / 5.3 |
| D7 | §4 states, per `faultKind` union member (`src/interfaces/transaction-lease.ts:76`), whether the `history()` re-check is required; every member is covered by exactly one branch. | [doc][unit] | "cancellation contract" support work / 5.4 |

## E — Backup and restore

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| E0 | The B-6/B-7 re-measurement is recorded on the **ruled binding**, carrying the binding and package version, runtime `sqlite_version()`, filesystem (one the probe accepts — never `tmpfs`), `journal_mode`, `synchronous`, dataset size relative to page cache, concurrent-writer commit count, and per candidate the duration, event-loop tick count, destination structural check, and destination row/page count against the source's committed state at the call. | [manual] | "backup primitive established by measurement" / 3.4 |
| E1 | §6 names **no** live-backup primitive until E0 exists; a doc test fails if it does. Once E0 exists, §6 takes branch A (online backup call is the mechanism) or branch B (no live-backup mechanism; offline quiesce-then-copy documented) according to the recorded result. | [doc][CI][manual] | same / 5.5 |
| E2 | Under branch A, `VACUUM INTO` appears in §6 only as a compaction tool, marked as freezing the JavaScript thread for the whole copy and as uncancellable. Under branch B, no primitive is presented as live-capable. | [doc] | same / 5.5 |
| E3 | §6 itself states the **shipped** backup call's actual cancellation behaviour — an `AbortSignal` accepted and ignored, or the absence of any cancellation affordance — as observed on the ruled binding, without deferring the fact to §3 and without carrying another binding's finding forward. | [doc][CI] | same / 5.5 |
| E4 | §6 states the at-or-after capture semantics and re-justifies chunk/manifest consistency as closure under manifest→chunk rather than by snapshot isolation. | [doc] | same / 5.5 |
| E5 | §6 states in bold that copying the main database file alone silently restores an arbitrarily older state while the integrity check still reports healthy. | [doc] | same / 5.5 |
| E6 | §6 states that a long copy blocks write-ahead-log checkpointing and that a passive checkpoint's not-busy return is not a success signal. | [doc] | same / 5.5, 6.2 |
| E7 | §6 states there is no point-in-time recovery and that it becomes a deployer capability. | [doc] | same / 5.5 |
| E8 | §6 names the verification pass as the post-restore step and states its limit in the same paragraph. | [doc] | same / 5.5, 4.1 |
| E9 | **Negative control:** a proposed §6 that names a primitive by citing a measurement whose recorded binding is not the ruled one is rejected, and the change record states the reason — a real measurement whose conditions no longer hold, the same defect class as a throughput figure taken on a memory filesystem. | [manual] | same (negative-control scenario) / 5.5 |
| E10 | Branch B is accepted as a complete outcome: if the re-measurement goes that way, the change is not judged incomplete for lacking a live-backup primitive. | [manual] | same / 5.5 |
| E10a | Any documented file-copy procedure specifies the copy as **out-of-process** or **post-quiesce with no writer transaction open**, and says which. A doc test rejects a procedure instructing an in-process copy of the database file or its sidecars. | [doc][CI] | same / 5.5 |
| E10b | §5's embedder-binding descriptor precondition and §6's copy procedure name the same mechanism and the same consequence — two writers both commit, one acknowledged commit is silently lost, the structural check reports `ok` — in the same terms. | [doc][CI] | same / 5.5, 5.7 |
| E10c | The B-6/B-7 record states, per candidate, whether it opens any filesystem descriptor on the sidecars; a candidate opening none is recorded as structurally incapable of triggering the descriptor defect, independent of timing. | [manual] | same / 3.4 |
| E11 | §6 states that no SQLite project in the surveyed field has a `pg_dump`-class live backup, rather than implying UmbraDB has recovered the capability. | [doc] | same / 5.5, 5.6 |
| E12 | **P13:** a backup taken during a GC pass with concurrent writes opens cleanly, satisfies manifest→chunk closure, and passes the verification pass. | [prop][CI] | "backup closure is tested" / 10.2 |
| E13 | Every external precedent citation in the rewritten contract set resolves to a pinned upstream commit or version-pinned URL recorded alongside it; unresolvable claims are removed, not hedged. | [manual][doc] | "citations re-verified before shipping" / 5.6 |

## F — The error catalog and stability policy

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| F1 | No existing `code` is re-pointed at a different situation. `ConnectionError` remains exported and narrowable, its row marked documented-unreachable with a pointer to the codes that now cover its situations. | [unit][doc][CI] | "no frozen code is repurposed" / 1.2 |
| F2 | `DATABASE_UNAVAILABLE` (non-retryable), `DISK_FULL` (conditional), `DATABASE_CORRUPT` (non-retryable) and `VALUE_INTEGRITY` (non-retryable) are added; `DISK_FULL` is the only new `conditional`. | [unit][doc][CI] | same / 1.2 |
| F3 | `TRANSACTION_POOLER_DETECTED` is retained and marked documented-unreachable. | [doc][unit] | same / 1.2 |
| F4 | No `BUSY`/`WRITE_CONTENDED` code exists; contention surfaces only as `LEASE_TIMEOUT`, `MIGRATION_LOCK_TIMEOUT` or `TRANSACTION_FAULT` with an already-frozen `faultKind`. | [unit][doc] | same / 1.2 |
| F5 | `UNRECOGNIZED_POSTGRES_ERROR` / `UnrecognizedPostgresError` no longer appear anywhere in `src/`, `docs/` or `test/`; the renamed code and class pass the drift test. | [unit][CI] | same / 1.1 |
| F6 | The `Pg*` class-name decision is recorded in `CHANGELOG.md` as a decision with a reason. | [doc] | same / 1.3 |
| F7 | `new ClockRegressionError(...).retryable === "conditional"`, and the catalog rationale names two causes that can fire against the shipped implementation, at least one caller-fixable by retrying. | [unit][doc][CI] | "CLOCK_REGRESSION retains conditional" / 1.6 |
| F8 | **Negative control:** a catalog marking `CLOCK_REGRESSION` `non-retryable` is rejected as a forbidden weakening under `docs/ERROR-CATALOG.md:13`, recorded as free pre-tag and a forced major after. | [manual] | same (negative-control scenario) / 1.6, 12.1 |
| F9 | The drift test remains the authority on the count; the catalog's reconciliation section records 24 as the pre-migration size and states that `EXPECTED_REQUIRED_COUNT` is a different object (a required-test-id pin, not a code count). | [doc][unit][CI] | "count derived from the surface" / 1.2 |
| F10 | Adding a barrel-exported concrete `StorageError` subclass without a catalog row fails the drift test, naming the code-set difference. | [unit][CI] | same / 1.2 |
| F11 | `docs/STABILITY.md` binds the situation-to-code mapping with the documented-unreachable carve-out named. | [doc][CI] | "stability policy binds situation-to-code" / 1.4 |
| F12 | `docs/STABILITY.md` states that widening the exported string-literal union types (including `faultKind`) is not automatically additive, naming the unions. | [doc][CI] | same / 1.4 |
| F13 | `docs/STABILITY.md` records that the identical-1.0.0-surface expectation was falsified and enumerates the surface delta. | [doc] | same / 1.5 |
| F14 | The `LEASE_FAULT` and `DISK_FULL` rows carry a note that their I/O-fault triggers cannot be injected in CI with the ruled binding, which exposes no virtual-filesystem hook, naming what would close the gap. | [doc] | "known gaps recorded in the catalog" / 1.7 |
| F20 | Both `v1.0.0-sqlite-schema-parity` faults — the checkpoint-sequence assertion and the transaction-history cross-check — resolve to `VALUE_INTEGRITY`, non-retryable, with no new code minted, and each carries a discriminator naming the failed check and the addressed scope. | [unit][CI] | "every integrity fault routed to a named code" / 1.10 |
| F21 | `docs/ERROR-CATALOG.md` states the scope rule (addressable scope → `VALUE_INTEGRITY`; whole file → `DATABASE_CORRUPT`) and enumerates each code's triggers. | [doc][CI] | same / 1.10 |
| F22 | A consumer distinguishes a digest mismatch from an invariant violation by the machine-readable discriminator alone, without parsing a message. | [unit] | same / 1.10 |
| F23 | Failures of the migration tool, archive sync CLI and snapshot tool are tool diagnostics: no catalog row, no `StorageError` subclass, not re-pointed at an existing code; the drift test stays green. | [unit][doc][CI] | "failures outside the frozen surface" / 1.11 |
| F24 | Exactly one change states whether tool failures are catalog members, and it is this one; the tool-owning changes specify exit codes and report schemas against that ruling. | [manual] | same / 1.11 |
| F25 | The persisted `dg` and the migration transport fidelity comparison are named distinctly; no text describes one preimage as both byte-exact and canonicalised; the transport comparison is not treated as a second mechanism over the covered tier. | [doc][manual] | "two distinct artifacts" / 1.12 |
| F15 | The translator identifies a driver error by `err.name === "SqliteError"` and switches on the string `err.code`; `grep -rn "errcode" src/` returns nothing in the translator. | [unit][CI] | "driver errors discriminated by string code" / 1.8 |
| F16 | **Negative control:** a numeric-keyed translator is shown to route every driver error to the catch-all with no throw and no warning **while the drift test stays green** — which is why F17 exists. | [unit][manual] | same (negative-control scenario) / 1.8 |
| F17 | A reachability suite provokes a specific fault per translated code and asserts that specific frozen `code` is raised, not merely that a `StorageError` was thrown. | [unit][CI] | same / 1.8 |
| F18 | The already-typed passthrough keys on `err instanceof StorageError`, not on the presence of a string `.code`; a unit test asserts a driver error reaching it is translated rather than returned unchanged. | [unit][CI] | same / 1.8 |
| F19 | `docs/supply-chain/inventory.md` records the binding, its pinned version and its `sqlite_version()`; CI asserts the runtime `sqlite_version()` matches, and a pinned regression test asserts the `err.name`/`err.code` shape. | [CI][doc] | same / 1.9 |

## G — Evidence, conformance and the refinement register

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| G1 | `docs/recovery/EVIDENCE.md` is re-executed: its Run-identity table names the release-candidate SHA to be tagged, and no value is copied forward from the previous run. | [manual] | "evidence re-executed, never amended" / 11.1 |
| G2 | Every field of the Cold-boot round-trip table carries captured output or the literal `NOT CAPTURED`. | [doc][manual] | same / 11.1 |
| G3 | A document lint fails the required gate on any empty cell in a binding-rule-2 table, names the field, and passes when the cell reads `NOT CAPTURED`. | [CI][unit] | same / 11.2 |
| G4 | The cost accounting records the evidence re-execution as already required by `ROADMAP.md:389-398` and attributes approximately zero incremental cost to this migration. | [doc][manual] | same / 12.2 |
| G5 | Every P1–P10 property runs green against SQLite **and** each surviving crash property's forbidden shape is run and fails the invariant; a property with no failing negative control is not accepted. | [prop][CI] | "conformance re-executed with negative controls" / 10.1 |
| G6 | P11 holds: the `journal_mode` and `synchronous` floors hold at every covered commit, including after a reopen. | [prop][CI] | same / 10.2 |
| G7 | P12 holds: after a crash, the structural check reports `ok` **and** the durable cursor is not ahead of durable data. | [prop][CI] | same / 10.2 |
| G8 | P14 holds: `foreign_keys` is `ON` on every connection, with a negative control showing that with it off a manifest delete silently removes no junction rows. | [prop][CI] | same / 10.2 |
| G9 | The rewritten refinement register is committed **before** the first adapter port commit in changes 1–4, with every status label re-derived and a sentence naming the mechanisms that no longer exist. | [manual] | same / 9.1 |
| G10 | **Negative control:** no document in this change's set cites the survival of the formal cut-line across the migration as evidence of migration safety; a doc test enforces it. | [doc][CI] | same (negative-control scenario) / 9.2 |
| G11 | The conformance-manifest id removals and the `EXPECTED_REQUIRED_COUNT` change are in separate commits, the second referencing the review of the first. | [manual] | "pinned id deletion is a reviewed change" / 11.3 |
| G12 | A replacement required id proves a member of `{TRANSACTION_FAULT, LEASE_TIMEOUT, MIGRATION_LOCK_TIMEOUT}` is reachable under SQLite and asserts the typed class and its stable `.code`, never a message substring. | [unit][CI] | same / 11.3 |

## H — Observability and the missing backstop

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| H1 | The diagnostic report names the in-flight statement and its elapsed time, the open transaction's age and opening call site, the lease holder, the write-ahead-log size, the last checkpoint outcome, and contention/retry counters. | [unit][CI] | "a running engine can be diagnosed" / 6.1 |
| H2 | The triage procedure is written and produces H1's answers without attaching a debugger or reading engine internals. | [doc][manual] | same / 6.1 |
| H3 | No symbol introduced by this change is re-exported from the built public barrel. | [unit][CI] | same / 6.1 |
| H4 | `docs/CONTRACT.md` states that a passive checkpoint can report a not-busy result while checkpointing zero pages and that monitoring must use the write-ahead-log size. | [doc][CI] | same / 6.2 |
| H5 | The timeouts section no longer claims an idle-in-transaction session is bounded, and states that a caller callback holding the whole-database write lock stalls every writer with no server-side backstop. | [doc][CI] | "unbounded hold documented and instrumented" / 5.1, 5.7 |
| H6 | A transaction open past the configured threshold raises a diagnostic naming its age and opening call site, visible in H1's report without restarting the process. | [unit][CI] | same / 7.1 |

## I — Provenance, the break ledger and platform position

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| I1 | Every sentence in the rewritten contract set is supported by a `file:line` citation into this repository or a recorded measurement with its command; none rests solely on a research lane's characterisation. | [manual] | "engine-named sentences re-derived" / 5.1-5.7 |
| I2 | **Negative control:** an external precedent citation that cannot be resolved to a pinned source at authoring time is removed rather than hedged, and the removal is recorded. | [manual] | same (negative-control scenario) / 5.6 |
| I3 | The break ledger gives every break a pre-tag and a post-tag cost, and identifies the `UNRECOGNIZED_POSTGRES_ERROR` rename and a hypothetical `CLOCK_REGRESSION` narrowing as independently forcing a major after the tag. | [doc][manual] | "release record prices every break" / 12.1 |
| I4 | The ledger identifies the deletion of §3's freed-wait clause as a promise that cannot be bought back at any price under any driver. | [doc] | same / 12.1 |
| I5 | The contract set states either that Windows is supported with a named filesystem-locking test, or that it is out of scope for the 1.0.0 line. | [doc][CI] | "known gaps recorded" / 8.1 |
| I6 | The release record states what is known about external consumers of `0.9.5` and that a git-tag install is unobservable, so a zero-consumer claim rests on the owner's enumeration. | [doc][manual] | same / 0.2 |

## Negative / boundary criteria (nothing out of scope leaked in)

| # | Criterion | Verify | Source ruling |
|---|---|---|---|
| N1 | No archive schema, archive code, archive cost estimate or archive schedule appears in this change. What this change contributes to the archive is bounded to three named items: the archive-lineage rows of the digest coverage set, the anti-latch invariant applied to the archive cursor, and the contract text. **The archive is owned by `v1.0.0-sqlite-chain-archive`**, and no criterion here asserts it is unwired, unconsumed or without a runner. | [manual] | proposal non-goals |
| N2 | This change does not select a driver, define the shim, define the worker topology, or fix the pragma bootstrap order — it consumes the ruling (`better-sqlite3`, pinned) from `v1.0.0-sqlite-engine-core` and re-verifies only its own consequences. | [manual] | design §0.2, §0.4 |
| N9 | No requirement, task or criterion assumes a driver capability verified absent from the ruled binding: `enableDefensive`, `setAuthorizer`, a session extension, `interrupt`, a progress handler, or a virtual-filesystem hook. | [manual] | design §0.4 / 0.1 |
| N3 | This change does not decide the temporal encoding or the clock policy; it constrains only the `CLOCK_REGRESSION` marking. | [manual] | design §0.2 |
| N4 | This change does not define the lease mechanism, `busy_timeout`, the poll loop or sticky-poison emulation. | [manual] | design §0.2 |
| N5 | This change authors no DDL and no `SECURITY.md` content; `docs/CONTRACT.md` §7 remains a pointer plus a flag to the threat-model change. | [manual][doc] | proposal non-goals; `docs/CONTRACT.md:135-143` |
| N6 | No public observability or tracing API is added to the frozen barrel. | [unit][CI] | `v1.0.0-api-surface` acceptance N3 |
| N7 | This change builds no exporter, importer, verification ladder or CLI surface for the PostgreSQL-to-SQLite migration. **That migration is owned by `v1.0.0-sqlite-data-migration`**; this change supplies the digest regime it reuses and rules on catalog membership for its failures, and asserts nowhere that no migration path exists or is promised. | [manual] | proposal non-goals; "failures outside the frozen surface" |
| N8 | No performance number from the research corpus is carried into any document as fact. | [doc][CI] | design §1.3; B2 |
