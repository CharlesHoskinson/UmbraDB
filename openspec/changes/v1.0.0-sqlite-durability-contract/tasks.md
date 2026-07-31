# Tasks — SQLite durability contract, error catalog and evidence

Every task states concrete acceptance criteria — what test passes, what command succeeds, what
artifact is checkable — per `openspec/config.yaml`'s tasks rule. A task is CLOSED only when its
acceptance criteria are demonstrated with the command that produced the evidence; "verified" without
a command is not acceptance.

**Ordering.** Phase A (tasks 1–2) is the pre-tag catalog and policy work: it is free only before the
1.0.0 tag and it gates nothing technically, so it runs first and in parallel with change 1's driver
decision. Phase B (tasks 3–5) depends on change 1's driver, handle ownership and pragma bootstrap.
Phase C (tasks 6–8) is the contract text, which cannot be finalised until B's mechanisms exist.
Phase D (tasks 9–11) is evidence, and task 9 (the refinement register) must land **before** any
adapter port commit in changes 1–4.

## 0. Preconditions

- [x] 0.1 **Record the driver and handle-ownership decision from `v1.0.0-sqlite-engine-core`.**
  This change's probe, diagnostic surface, error translation and cancellation text all depend on
  which driver ships and whether the engine handle lives on a worker thread.
  **Acceptance:** a note in this file records the chosen driver, its pinned version, the bundled
  SQLite version, and whether the handle is worker-owned.

> **Builder note (0.1) — driver ruled, and three consequences re-verified first-hand.**
>
> `v1.0.0-sqlite-engine-core` has ruled for a **pinned `better-sqlite3`**, not the `node:sqlite`
> built-in, on the commitments seat's grounds: `docs/STABILITY.md:18` cannot promise
> no-breaking-changes-in-a-minor about an unpinnable, silently-experimental platform built-in.
> Worker-versus-in-process is still change 1's to finalise; tasks 6.1 and 7.1 are written to hold
> either way.
>
> Re-probed against the already-installed copy at `/tmp/l3-bs3b` — **no `npm install` was run**
> (command and full output in `design.md` §0.4):
>
> - `better-sqlite3@13.0.2`, runtime `sqlite_version()` = **3.53.4** (against 3.53.1 for
>   `node:sqlite` on Node v24.18.0 — the opposite direction from L3's assertion).
> - `Object.getOwnPropertyNames(Database.prototype)` = `constructor, prepare, transaction, pragma,
>   explain, backup, serialize, function, aggregate, table, loadExtension, exec, close,
>   defaultSafeIntegers, unsafeMode`. **No `interrupt`, no `enableDefensive`, no `setAuthorizer`.**
> - On a provoked constraint failure: `err.name = SqliteError`,
>   `err.code = "SQLITE_CONSTRAINT_PRIMARYKEY"`, `typeof err.errcode = undefined`.
>
> Consequences carried into this change: **task 1.8** (string discriminator, replacing every numeric
> `errcode` mapping in the research corpus); **task 5.5** (the backup comparison must be re-measured —
> change 1's blocked decisions B-6/B-7 — so §6 names no primitive yet, and task 3.4 runs it);
> **task 5.3** (the §3 deletion is now supported by this change's own measurement rather than a
> relay). No requirement in this change assumes `enableDefensive`, `setAuthorizer` or the session
> extension, all of which are absent from the ruled binding.

- [ ] 0.2 **Record whether any external consumer of `0.9.5` is known to exist.**
  **Acceptance:** the release record contains a statement of what is known, and states that a
  git-tag install leaves no registry footprint so absence is unobservable rather than proven.
  Satisfies the consumer-question scenario of the known-gaps requirement.

## Phase A — the pre-tag catalog and policy work (free only now)

- [ ] 1.1 **Rename `UNRECOGNIZED_POSTGRES_ERROR` and `UnrecognizedPostgresError`.**
  Rename the `code` string to `UNRECOGNIZED_DATABASE_ERROR` and the class to
  `UnrecognizedDatabaseError`, update the barrel, the catalog row and the drift-test import list
  (`test/api-surface/error-catalog-drift.test.ts`).
  **Acceptance:** `npm run typecheck` passes; `npx vitest run test/api-surface/error-catalog-drift.test.ts`
  passes; `grep -rn "UNRECOGNIZED_POSTGRES_ERROR\|UnrecognizedPostgresError" src/ docs/ test/` returns
  nothing; `CHANGELOG.md` carries the rename under the pre-1.0.0 entry with the post-tag cost stated.

- [ ] 1.2 **Add the four new error codes and mark two rows documented-unreachable.**
  Add `DatabaseUnavailableError` (`DATABASE_UNAVAILABLE`, non-retryable),
  `DiskFullError` (`DISK_FULL`, conditional), `DatabaseCorruptError` (`DATABASE_CORRUPT`,
  non-retryable) and `ValueIntegrityError` (`VALUE_INTEGRITY`, non-retryable) to
  `src/interfaces/storage-errors.ts` (or the adapter error module, following
  `design/design-interfaces.md` §2) and to `docs/ERROR-CATALOG.md`. Mark `CONNECTION_ERROR` and
  `TRANSACTION_POOLER_DETECTED` documented-unreachable, each with a pointer to the code that now
  covers its situations.
  **Acceptance:** the drift test passes with the enlarged surface; the catalog table and the exported
  concrete subclass set are equal by the drift test's own comparison; `DISK_FULL` is the only new
  code marked `conditional`; no existing row's `Meaning` cell has been re-pointed at a different
  situation. Satisfies the no-repurposing requirement.

- [ ] 1.3 **Record the `Pg*` class-name decision.**
  Decide whether the six exported `Pg*` adapter class names are renamed or retained, and write the
  decision down.
  **Acceptance:** `CHANGELOG.md` records the decision and its reason; if retained, it states that the
  names are not machine-facing and that retention is deliberate.

- [ ] 1.4 **Close the `{situation → code}` hole and bound "additive-only" in `docs/STABILITY.md`.**
  **Acceptance:** `docs/STABILITY.md` contains a sentence binding the situation-to-code mapping with
  the documented-unreachable carve-out named, and a sentence stating that widening the exported
  string-literal union types (including `faultKind`, `src/interfaces/transaction-lease.ts:76`) is not
  automatically additive. A doc test asserts both sentences are present.

- [ ] 1.5 **Write the retraction paragraph in `docs/STABILITY.md`.**
  **Acceptance:** the pre-1.0 scope section records that the "surface at 1.0.0 is expected to be
  identical" expectation (`docs/STABILITY.md:60-63`) was falsified by the migration, and enumerates
  the surface delta.

- [ ] 1.6 **Constrain `CLOCK_REGRESSION` for `v1.0.0-sqlite-temporal-event-log`.**
  Record, in the catalog's rationale section, that the `conditional` marking is preserved and name
  the two live causes that will exist under the shipped temporal design.
  **Acceptance:** the `Retryable` cell reads `conditional`; the rationale names two causes that can
  fire against the shipped implementation, at least one caller-fixable by retrying; a unit test
  asserts `new ClockRegressionError("m").retryable === "conditional"`.

- [ ] 1.7 **Record the untestable-code gaps in the catalog.**
  **Acceptance:** the `LEASE_FAULT` and `DISK_FULL` rows each carry a note that their triggering
  I/O-fault conditions cannot be injected in CI with the ruled binding, which exposes no
  virtual-filesystem hook (`design.md` §0.4), naming what would be required (a fault-injecting
  filesystem or a device-mapper error target).

- [ ] 1.8 **Key error translation on the ruled binding's string discriminator.**
  The driver branch keys on `err.name === "SqliteError"` and switches on `err.code` (the string
  extended-result-code name). No mapping keys on a numeric `err.errcode`, which is `undefined` on the
  ruled binding. The already-typed passthrough at the head of the translator keys on
  `err instanceof StorageError`, **not** on the presence of a string `.code`.
  **Acceptance:** `grep -rn "errcode" src/` returns nothing in the translator; a unit test asserts
  that a `SqliteError` reaching the passthrough is translated rather than returned unchanged; and a
  reachability suite provokes a specific fault per translated code and asserts that code is raised —
  so a translator that routed everything to the catch-all would fail even though the drift test stays
  green. Satisfies the string-discriminator requirement and its two negative controls.

- [ ] 1.10 **Route both `v1.0.0-sqlite-schema-parity` faults to named existing codes (gate G-14).**
  The checkpoint-sequence assertion failing at `save()` and the transaction-history lifecycle /
  identifier cross-check failing on read both raise `ValueIntegrityError`, non-retryable, with **no
  new code minted**. Add the scope rule to `docs/ERROR-CATALOG.md` — addressable scope raises
  `VALUE_INTEGRITY`, whole-file conditions raise `DATABASE_CORRUPT` — and give `ValueIntegrityError`
  a machine-readable discriminator naming the failed check.
  **Acceptance:** a test provokes each fault and asserts `code === "VALUE_INTEGRITY"` plus a
  discriminator distinguishing it from a digest mismatch **without parsing a message**; the drift
  test passes with no catalog growth; the catalog states the scope rule and enumerates each code's
  triggers; and `v1.0.0-sqlite-schema-parity`'s two "the error code belongs to the durability
  contract's catalog" deferrals now resolve to a named code.

- [ ] 1.11 **Rule catalog membership for failures outside the frozen surface (gate G-14).**
  Failures of the data-migration tool, the archive synchronisation CLI and the snapshot tool are tool
  diagnostics: no catalog row, no `StorageError` subclass, no re-pointing at an existing code. Exit
  codes and report schemas belong to the changes owning those tools.
  **Acceptance:** the catalog states the membership rule; a test asserts a tool refusal adds no
  barrel export and leaves the drift test green; and exactly one change in the sprint states this
  rule, with `v1.0.0-sqlite-data-migration` specifying its CLI surface **against** it rather than
  deferring back.

- [ ] 1.12 **Add the two-artifact cross-reference for the migration digest (gate G-11).**
  State that the persisted `dg` is over exact stored bytes with no canonicalisation, and that a
  migration's source-to-target fidelity comparison is a distinct, non-persisted transport check over
  canonically parsed values that does not constitute a second mechanism over the covered tier.
  **Acceptance:** the phrase "bytes as stored, through one canonicalisation" exists nowhere in the
  sprint; both artifacts are named distinctly; `v1.0.0-sqlite-data-migration` consumes this ruling.

- [ ] 1.13 **Repoint the citations `v1.0.0-sqlite-data-migration` makes into this change (gate G-14/G-16).**
  Two of its supporting citations resolve to unrelated text: the deferral of catalog membership and
  the "reserved for a read-path mismatch" claim both land on this change's `quick_check` and
  coverage-set passages after the R-3 rewrite moved them.
  **Acceptance:** cross-change citations into this change address **requirement titles**, not line
  numbers, so they cannot rot; a sampled resolution check passes; and the membership deferral now
  points at task 1.11's requirement, which exists.

- [ ] 1.9 **Record the binding and its SQLite version in the supply-chain inventory, with a CI assertion.**
  **Acceptance:** `docs/supply-chain/inventory.md` names the binding, its pinned version and the
  `sqlite_version()` it reports; a CI check asserts the runtime `sqlite_version()` matches the
  recorded value, so a dependency bump cannot swap the storage engine under a frozen contract. A
  pinned regression test asserts the `err.name`/`err.code` shape, since the whole translation layer
  rests on it and it was verified on one version only.

## Phase B — the probe, the digests and the verification pass

- [ ] 2.1 **Write the SQLite durability probe's pure classifiers.**
  Mirror `src/postgres/durability-probe.ts:72-135`: one exported pure function per decision
  (`classifyJournalMode`, `classifySynchronous`, `classifyForeignKeys`, `classifyFilesystem`,
  `classifyFsyncLatency`, `classifyFilePermissions`), each returning a `DurabilityViolation | null` or
  `DurabilityWarning | null`, with no database dependency.
  **Acceptance:** a unit suite covers every branch of every classifier by direct injection with no
  database and no filesystem harness, mirroring the arrangement documented at
  `src/postgres/durability-probe.ts:148-153`; `npm run typecheck` passes.

- [ ] 2.2 **Wire the live probe into `runMigrations` as a mandatory pre-migration step.**
  **Acceptance:** an integration test shows that a database with `journal_mode=memory` makes
  `runMigrations` reject with `DurabilityContractError` **before** any migration row is written
  (assert the `_migrations` table is absent or empty); a second shows `synchronous=NORMAL` under a
  `FULL` floor returns a `kind: "lost-tail"` warning through `onDurabilityWarning` and the migrations
  run; a third shows `foreign_keys=OFF` rejects.

- [ ] 2.3 **Implement the filesystem-type refusal.**
  **Acceptance:** a unit test injects each refused filesystem type (`nfs`, `cifs`, `v9fs`, `tmpfs`,
  `ramfs`, un-allowlisted `fuse`) into `classifyFilesystem` and asserts a violation; an integration
  test creates a database on a memory filesystem and asserts `runMigrations` rejects naming the
  filesystem type. The negative-control scenario is realised as a test asserting that a
  `PRAGMA journal_mode` readback alone returns `wal` in that same situation.

- [ ] 2.4 **Implement the `fsync` calibration as a warning and document it as a heuristic.**
  **Acceptance:** the calibration never produces a `DurabilityViolation` in any test;
  `docs/durability-contract.md` states that no in-process probe can verify filesystem honesty about
  `fsync`, reusing the best-effort-detector language of `docs/durability-contract.md:73-77`; a doc
  test asserts the document contains no sentence claiming `fsync` honesty is verified.

- [ ] 3.1 **Add the stored value digest to the ruled coverage set.**
  `dg BLOB` (nullable, 32 raw bytes) plus adapter-side computation on the caller's thread plus
  read-path re-verification, for exactly: `kv_event.value`; `watermarks.value` in **both** lineages;
  `transaction_history.entry`; all non-PK columns of `bridge_observations` and
  `verifier_key_observations`. DDL coordinated with `v1.0.0-sqlite-schema-parity`; the digest is bound
  in the same statement as the value. **The phrase "wallet-state envelope store" must not appear** —
  the envelope is `ckpt_chunks` rows, already rehash-verified.
  **Acceptance:** a test writes a value, alters its bytes in the file after a checkpoint, reopens and
  reads through the adapter, and asserts `ValueIntegrityError` with `code === "VALUE_INTEGRITY"`
  carrying the table name and primary key; the corrupted bytes are never returned. A second test
  asserts `CHUNK_INTEGRITY` and `VALUE_INTEGRITY` are distinguishable by `code` alone. A third asserts
  no `dg` column exists on `ckpt_chunks`, `ckpt_manifests`, `chain_blobs`, `blocks`, `transactions` or
  `chain_blob_roles`.

- [ ] 3.1a **Implement the framed preimage and its substitution test.**
  Format `0x01` for single-value columns, `0x02` for multi-column rows; versioned, length-prefixed,
  binding table, column and primary key; computed over the **stored bytes**, never a parsed or
  re-serialised value.
  **Acceptance:** a test replaces a row's value and digest with a valid pair from another row of the
  same table and asserts `ValueIntegrityError`; the paired negative control computes a bare hash of
  the value alone and asserts the substitution goes **undetected**, demonstrating the binding is
  load-bearing. A third asserts no normalisation occurs anywhere on the path: bytes read back and
  re-hashed reproduce the stored digest exactly.

- [ ] 3.1b **Add the no-UDF drift-guard trigger to every covered table.**
  **Acceptance:** an update of the covered column leaving `dg` unchanged aborts with the guard's
  message; the same update carrying a recomputed `dg` succeeds; `sqlite_schema` references no
  user-defined function, so compaction and third-party writes are unaffected.

- [ ] 3.1e **Add the anti-downgrade trigger and delete the NULL-warn read branch (gate G-6).**
  A second no-UDF trigger per covered table, aborting any update that sets `dg` to NULL on a row
  whose `dg` is non-NULL. A covered row with a NULL digest raises `ValueIntegrityError` on read; the
  warn branch ships in no lineage of this release.
  **Acceptance:** `UPDATE … SET dg = NULL` aborts on the trigger; a non-NULL-to-non-NULL recompute
  succeeds; a NULL-to-value backfill write is unobstructed. **Negative control:** with only the drift
  guard installed, the same `UPDATE` is accepted and the row becomes permanently unverified — the
  one-directional gap this trigger closes. A read of a NULL-digest covered row raises
  `ValueIntegrityError` naming table and primary key, and no NULL-digest warning path exists in
  `src/`. The requirement is this change's; the DDL lands in the schema lineage
  (`v1.0.0-sqlite-schema-parity`) and the archive lineage (`v1.0.0-sqlite-chain-archive`).

- [ ] 3.1f **Adopt the null-tolerant length constraint on `dg` (gate G-5).**
  Rewrite this change's prohibition: only null-*rejecting* constraints are forbidden, and the adding
  migration carries `CONSTRAINT <name> CHECK (dg IS NULL OR octet_length(dg) = 32)`. The superseded
  rationale is recorded as false in both forms.
  **Acceptance:** this change's text, `v1.0.0-sqlite-schema-parity`'s migration and
  `v1.0.0-sqlite-chain-archive`'s lineage agree; a 31-byte digest is rejected naming the constraint;
  32 bytes and schema-level NULL are accepted; no `NOT NULL` or non-null default appears; and the
  R-3 amendment is noted in this change's design.

- [ ] 3.1c **Ship the salvage bypass, off by default and documented as dangerous.**
  **Acceptance:** with salvage off, a failing-digest read raises `ValueIntegrityError`; with salvage
  on, the same read returns the stored bytes **and** reports the bypassed row by table and primary
  key. Tests assert that enabling salvage does not disable digest computation on write, does not
  remove any column from the coverage set, and does not change what `verifyIntegrity()` reports — so
  it cannot be repurposed as a verification or performance opt-out. The documentation names it
  dangerous and states when its use is legitimate.

- [ ] 3.1d **Enforce digest recomputation in value-rewriting migrations.**
  **Acceptance:** a lint or migration-framework rule fails any migration that rewrites a covered
  column's bytes without recomputing `dg` in the same migration; a test migration that changes an
  encoding and recomputes passes, and the same migration without the recompute fails.

- [ ] 3.2 **Implement the negative control for 3.1, both cases.**
  **Acceptance:** the payload case — the corruption fixture checked only with `PRAGMA integrity_check`
  and `PRAGMA quick_check` reports `ok` on both and a full scan returns the corrupted row, reproducing
  `design.md` §2.1. The structural case — a corrupted structural region is reported by **both** checks
  and the read throws. Together they demonstrate the two-case wording rather than asserting it. This
  is property **P15**.

- [ ] 3.3 **Measure the digest's write cost under `v1.0.0-sqlite-engine-core`'s gate — recording only.**
  **Acceptance:** a recorded measurement on the target filesystem, at the configured `synchronous`
  level, with dataset size relative to page cache stated, comparing the write path with and without
  the digest, plus the storage delta on **real** payloads rather than synthetic random bytes; written
  into this change's design record. **The coverage set is unconditional: no measured value narrows it,
  and no task or criterion may make coverage contingent on this result.**

- [ ] 3.5 **Verify the schema digest at `open()`.**
  Consume the artifact `v1.0.0-sqlite-schema-parity` records at the end of every successful migration
  run; verify at `open()` and inside `verifyIntegrity()`.
  **Acceptance:** a test alters the schema text out of band and asserts `open()` raises
  `DatabaseCorruptError` with a `schemaDigest` detail; a second asserts the check performs no data
  scan; a third asserts a **value**-digest failure does **not** refuse at open, keeping this the only
  open-scoped corruption failure.

- [ ] 3.6 **Implement invariant I-6 (anti-latch) on the watermarks primitive.**
  When the monotonic guard suppresses a write as a regression, verify the incumbent row's digest in
  the same transaction and raise `ValueIntegrityError` on failure.
  **Acceptance:** a test corrupts a watermark value upward, issues a legitimate write the guard
  suppresses, and asserts `ValueIntegrityError` rather than a silent no-op. The negative control runs
  the same fixture against a plain no-op guard and asserts the corrupted position persists while
  correct writes are discarded — the latch this invariant converts into a detection point.

- [ ] 3.7 **Hand the remaining Class B invariants to their owners and record the handoff.**
  **Acceptance:** this change's design carries the invariant table with exactly one owning change per
  row; changes 2, 3, 4 and 6 have each acknowledged their rows; and no invariant owned elsewhere is
  re-specified as a requirement here. Change 6 additionally records M-5 as resolved by the R-3 ruling.

- [ ] 3.4 **Re-measure the backup comparison on the ruled binding (change 1's B-6/B-7).**
  Run the ruled binding's online backup call and `VACUUM INTO` against the same source database with
  a concurrent writer, on a filesystem the durability probe accepts — never `tmpfs`.
  **Acceptance:** a recorded result carrying the binding and package version, the runtime
  `sqlite_version()`, the filesystem, `journal_mode`, `synchronous`, the dataset size relative to page
  cache, and the concurrent-writer commit count; and, per candidate, wall-clock duration, event-loop
  tick count during the copy, the destination's structural check result, and the destination's row or
  page count against the source's committed state at the call. The result selects branch A or branch B
  of the §6 requirement. **Task 5.5 is blocked until this lands.**

- [ ] 4.1 **Implement the verification pass — four parts, reported together, never refusing.**
  `PRAGMA integrity_check` **and** the full digest sweep **and** the schema-digest check **and** the
  invariant queries, returned as one inventory. `quick_check` appears nowhere.
  **Acceptance:** a test builds a database whose structural check returns `ok` but which contains one
  digest mismatch, runs the pass, and asserts the overall result is a failure with all four parts
  reported separately and the failing row named by table and primary key. A second test presents a
  structural failure, a failing digest and a failing invariant in one run and asserts the pass returns
  an inventory naming all three, throws nothing, and leaves the database open and usable for
  undamaged rows. A third asserts the pass is not invoked from `open()` or `runMigrations`.
  `grep -rn "quick_check" src/ docs/` returns only the negative-control test and the contract sentence
  that prohibits it.

- [ ] 4.2 **Document the verification pass as a diagnostic until its runtime is measured.**
  **Acceptance:** a doc test fails if any document recommends running the pass on a schedule or
  assumes a periodic pass is affordable; the unmeasured-obligations record names the archive-scale
  runtime measurement (both components, with a **separate-process** writer) and its gate.

## Phase C — the contract text

- [ ] 5.1 **Rewrite `docs/durability-contract.md`.**
  Deployer preconditions reduce to one; the probe table is re-derived; the `synchronous` decision
  rule replaces every throughput figure; the timeouts section states that only the lock wait retains
  a bound.
  **Acceptance:** a doc test asserts the document contains no commits-per-second figure, throughput
  ratio or latency presented as an established property of a `synchronous` level; asserts the three
  preconditions for lowering the default are enumerated; and asserts the document does not claim an
  idle-in-transaction session is bounded. Every remaining row of the summary table cites the
  classifier that enforces it.

- [ ] 5.2 **Rewrite `docs/CONTRACT.md` §1 and insert the integrity subsection, using the two-case wording.**
  §1 keeps the ordering guarantee; states the single remaining deployer precondition; then adds the
  integrity subsection: structural damage **is** detected and the read fails, value-byte damage is
  **not** and is returned as data, so the structural check is sound for rejection and not for
  acceptance. It carries the coverage table (content-addressed tier / digest tier / invariant tier /
  schema digest / archive projection tables / SQLite's own structures), the limits (detection is not
  repair; at-rest only; unkeyed and therefore not a tamper defence; the coherently-wrong restored
  file), and the not-a-regression paragraph.
  **Acceptance:** a doc test asserts §1 contains no sentence stating or implying that the engine
  detects nothing, and none implying UmbraDB restores a capability the PostgreSQL backend gave the
  consumer; asserts every write-ahead-log checksum claim in `docs/` is explicitly scoped to the log;
  asserts the phrase "wallet-state envelope store" appears in no coverage context; and asserts the
  not-a-regression paragraph cites the probe's actual scope
  (`src/postgres/durability-probe.ts:204-206`) and the absence of any `data_checksums`/`amcheck`
  mention. A further test asserts no document cites a corruption frequency figure.

- [ ] 5.2a **Place the disclosure in the remaining five channels.**
  README durability section (two-case statement, digest tier, "detection is not repair", link);
  `docs/durability-contract.md` (measured transcript plus a summary row recording that page checksums
  are absent on **both** backends); `docs/ERROR-CATALOG.md` (`VALUE_INTEGRITY`, `DATABASE_CORRUPT`);
  `SECURITY.md` at-rest section (one line: no at-rest integrity beyond the unkeyed corruption digests,
  which are not a tamper defence); and the code itself (typed errors raised at the fault plus a
  callable verification pass).
  **Acceptance:** a doc test asserts each of the five carries the disclosure or its pointer, and that
  **no channel depends on a container image** — the repository builds no Dockerfile and references no
  registry, so a channel claiming one would assert a distribution path that does not exist.

- [ ] 5.2b **Record the checksum VFS as considered and declined.**
  **Acceptance:** `docs/CONTRACT.md` records it as declined, not as headroom, with the process-global
  default-VFS reason stated explicitly (the reason that does not expire with a future upstream
  release); states that `PRAGMA checksum_verification = 1` is silently accepted and does nothing on
  the pinned build and names the empty-result probe that actually detects the shim's absence; and a
  test asserts new databases are created with no reserve bytes pre-provisioned.

- [ ] 5.3 **Rewrite `docs/CONTRACT.md` §3 (cancellation).**
  **Acceptance:** `grep -n "freed\|unwinds\|query.cancel" docs/CONTRACT.md` returns nothing in §3; §3
  states the two unconditional timings and lists what is not cancellable, naming the
  `withTransaction(fn)` body with its reason; if the JavaScript poll-loop sentence is included, it
  names the poll interval as the bound. A doc test enforces the absence of the freed-wait clause.

- [ ] 5.4 **Add the second retry clause to `docs/CONTRACT.md` §4.**
  Distinguish the `faultKind` values whose commit outcome is uncertain (the `history()` re-check
  applies) from those that unambiguously mean nothing happened (safely retryable without the
  re-check), using only members already frozen at `src/interfaces/transaction-lease.ts:76`.
  **Acceptance:** §4 names, per `faultKind`, whether the re-check is required; a unit test asserts
  every `faultKind` union member is covered by exactly one branch of that text.

- [ ] 5.5 **Rewrite `docs/CONTRACT.md` §6 (backup/restore). Blocked on task 3.4.**
  Remove the `pg_dump`/`pg_restore` commands. Take branch A or branch B of the §6 requirement
  according to 3.4's recorded result — **do not choose a primitive in advance of it.**
  **Acceptance:** under branch A, §6 names the online backup call as the live-backup mechanism and
  `VACUUM INTO` appears only as compaction, marked thread-freezing and uncancellable; under branch B,
  §6 states that UmbraDB has no live-backup mechanism and documents the offline quiesce-then-copy
  procedure. Under either, the seven required sentences (the shipped call's actual cancellation
  behaviour, at-or-after semantics with the closure re-justification, never copy the main file alone,
  checkpoint blocking and the not-a-success-signal return, no point-in-time recovery, no
  `pg_dump`-class equivalent in the surveyed field, post-restore verification with its limit) are
  each present and individually asserted by a doc test. A doc test additionally fails if §6 names a
  primitive while 3.4's result is absent from the record.

- [ ] 5.6 **Re-verify or strike every external precedent citation.**
  **Acceptance:** each external claim in the rewritten contract set resolves to a pinned upstream
  commit or a version-pinned document URL recorded alongside it; any claim that cannot be resolved at
  authoring time is removed from the document, not reworded. The task's evidence is the list of
  citations with their pinned sources, or the list of struck claims.

- [ ] 5.7 **Update `docs/CONTRACT.md` §5 and §7.**
  §5 gains the note that no server-side backstop bounds a caller callback holding the whole-database
  write lock, **and** carries `v1.0.0-sqlite-concurrency-lease`'s descriptor precondition as binding
  on the **embedder**, with its consequence written concretely: two writers both commit, one
  acknowledged commit is silently lost, and the structural check reports `ok`. §7 remains a pointer,
  and records that SQLite has no in-engine encryption so the at-rest menu narrows, flagging it to the
  threat-model change rather than authoring it here.
  **Acceptance:** a doc test asserts §5 and §6 name the same descriptor mechanism and the same
  consequence in the same terms, so a consumer reading either alone is led to a safe procedure; and
  asserts §7 still contains only a pointer plus the flag, and that this change adds no content to
  `SECURITY.md` beyond the one at-rest line placed by task 5.2a.

- [ ] 5.8 **Write `docs/recovery/CORRUPTION.md`.**
  The four consumer paths — scope with the verification pass; re-derive where the tier allows;
  restore from backup with the pass as the post-restore check; accept a bounded, known loss per key —
  plus the value proposition stated as: UmbraDB does not promise to repair corruption; it promises
  corruption is never silent, so the response can be proportionate instead of total.
  **Acceptance:** a doc test asserts the document names the tiers that are **not** re-derivable
  (`kv_event` history, `transaction_history.entry`, the observation tables) in the re-derive path; and
  asserts the SQLite command-line recovery tool, checksumming filesystems and error-correcting memory
  appear only as defence-in-depth advice, never as *the* answer. The contract and README link it.

## Phase D — evidence and observability

- [ ] 6.1 **Implement the diagnostic operation and write the triage procedure.**
  **Acceptance:** a test starts a workload, holds a transaction open past the configured threshold,
  and asserts the diagnostic report names the in-flight statement and its elapsed time, the
  transaction age and opening call site, the lease holder, the write-ahead-log size and the last
  checkpoint outcome, and the contention counters. A second test asserts none of the new symbols is
  re-exported from the built barrel.

- [ ] 6.2 **Document the passive-checkpoint trap.**
  **Acceptance:** `docs/CONTRACT.md` states that a passive checkpoint can return a not-busy result
  while checkpointing zero pages and that monitoring must use the write-ahead-log size; a doc test
  asserts the sentence is present.

- [ ] 7.1 **Instrument the long-held transaction.**
  **Acceptance:** a test opens a transaction, waits past the threshold, and asserts a diagnostic is
  raised naming the age and the opening call site, and that it is visible in 6.1's report without
  restarting the process.

- [ ] 8.1 **Declare the Windows position.**
  **Acceptance:** the contract set states either that Windows is supported and names the
  filesystem-locking test that covers it, or that Windows is out of scope for the 1.0.0 line. A doc
  test asserts one of the two statements is present.

- [ ] 9.1 **Rewrite the refinement register before any adapter port commit.**
  **Acceptance:** the rewritten register is committed and each row names the new mechanism with a
  status label derived from it, plus an explicit sentence naming the mechanisms that no longer exist.
  The evidence is a `git log` showing the register commit precedes the first adapter commit in
  changes 1–4.

- [ ] 9.2 **Add a lint forbidding the "Lean gate is green" safety argument.**
  **Acceptance:** a doc test fails if any document in this change's set cites the survival of the
  formal cut-line across the migration as evidence of migration safety.

- [ ] 10.1 **Re-execute P1–P10 against SQLite with negative controls.**
  **Acceptance:** every P1–P10 property runs green against SQLite, **and** each surviving crash
  property's forbidden shape is run and fails the invariant, with both results recorded. A property
  with no failing negative control is not accepted as green.

- [ ] 10.2 **Add P11–P14.**
  **Acceptance:** P11 asserts the pragma floors hold at every covered commit, including after a
  reopen (the pragma is persistent in the file); P12 asserts post-crash structural `ok` **and**
  cursor-not-ahead-of-data across the crash matrix; P13 asserts a backup taken during garbage
  collection and concurrent writes opens cleanly, satisfies manifest-to-chunk closure, and passes the
  verification pass; P14 asserts `foreign_keys` is `ON` on every connection, with a negative control
  showing that with it off a manifest delete silently removes no junction rows.

- [ ] 11.1 **Re-execute `docs/recovery/EVIDENCE.md` against the new release candidate.**
  **Acceptance:** the artifact's Run-identity table names the release-candidate SHA to be tagged; no
  value is copied forward; the Cold-boot round-trip table at `:44-53` carries captured output or the
  literal `NOT CAPTURED` in every field.

- [ ] 11.2 **Add the binding-rule-2 document lint.**
  **Acceptance:** the lint fails on a fixture evidence artifact containing one empty cell in a
  rule-2 table and names the field; it passes when that cell reads `NOT CAPTURED`; it runs in the
  required gate.

- [ ] 11.3 **Change the conformance manifest in two reviewed commits.**
  Commit one removes the engine-named required ids and adds the replacement id proving a member of
  `{TRANSACTION_FAULT, LEASE_TIMEOUT, MIGRATION_LOCK_TIMEOUT}` is reachable and typed under SQLite.
  Commit two adjusts `EXPECTED_REQUIRED_COUNT` (`test/integration/check-required-tests.ts:100`) and
  references the review of commit one.
  **Acceptance:** `git log --oneline -- test/integration/required-tests.manifest.json test/integration/check-required-tests.ts`
  shows the two changes in separate commits; the replacement test asserts the typed class and its
  stable `.code`, never a message substring;
  `npx vitest run test/integration/check-required-tests.test.ts` passes.

- [ ] 12.1 **Write the break ledger into the release record.**
  **Acceptance:** `docs/releases/` carries a ledger in which every break has a pre-tag and a post-tag
  cost; the `UNRECOGNIZED_POSTGRES_ERROR` rename and a hypothetical `CLOCK_REGRESSION` narrowing are
  each identified as independently forcing a major after the tag; and the deletion of
  `docs/CONTRACT.md` §3's freed-wait clause is identified as a promise that cannot be bought back at
  any price under any driver.

- [ ] 12.2 **Record the evidence re-execution as a sunk cost of the tag.**
  **Acceptance:** the cost accounting states that `ROADMAP.md:389-398` already required a fresh
  release candidate and an R1–R12 re-run, and attributes approximately zero incremental cost to this
  migration for `docs/recovery/EVIDENCE.md`.
