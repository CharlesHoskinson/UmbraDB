# Tasks — SQLite concurrency, transactions and the writer lease

Each task is implemented by a builder and then reviewed against this change's `design.md` and
`specs/transaction-lease/spec.md`. Every task states concrete acceptance criteria — what test
passes, what command succeeds, what artifact is checkable — per `openspec/config.yaml`'s tasks rule.

**Ordering.** Phase 0 is a blocking gate on `v1.0.0-sqlite-engine-core` (design §0, rows D-1..D-3).
Phase 1 (transaction primitive, write queue, `BEGIN IMMEDIATE`, poison, hold bound) is the
foundation the other three sprint changes compile against and must land first. Phase 2 (the lease)
and Phase 3 (the writer-generation guard) are independent of each other. Phase 4 (isolation, prune,
read path) consumes Phase 1. Phase 5 (errors) can start in parallel and closes last because it needs
Phase 3's fault. Phase 6 (conformance) is last by construction. Phase 7 (contracts) must not be
written before Phase 3 is measured — writing the strengthening first is exactly the failure this
change exists to prevent.

## 0. Preconditions (blocking gate)

- [x] 0.1 **Confirm the driver and topology decision from `v1.0.0-sqlite-engine-core`.**
  **Acceptance:** a written note in this file naming the decision and the change that made it.

  > **RULED (`v1.0.0-sqlite-engine-core`): a version-pinned `better-sqlite3`, with the database
  > handle confined to a dedicated worker thread.** Two consequences land in this change and are
  > already reflected in it. (i) The contention discriminator is a **string** on `err.code` with
  > `err.name === "SqliteError"`, not a numeric `errcode` — the research corpus's numeric key is
  > wrong for the ruled binding, and the ruled binding carries no numeric field at all (design
  > §7.1, verified §12(f)); tasks 5.2 and 5.8 are keyed accordingly. (ii) The worker topology is
  > confirmed viable on that binding, which is what makes §5's poll loop mandatory for the *worker's
  > message queue* rather than for the event loop — the reason recorded in the requirement.

- [ ] 0.2 **Confirm the ext4 measurement gate exists and is blocking, and claim decision B-4.**
  `v1.0.0-sqlite-engine-core` records **B-4** — the lease poll interval, the lease timeout budget,
  and whether the worker's per-statement write-lock amplification is acceptable — as *this* change's
  decision, blocked on that gate. Its required datum is commit latency at the chosen `synchronous`
  on a real filesystem, because contention cost per retry scales with commit latency and that is the
  quantity that moved 233×. **Acceptance:** the gate is referenced by id, this file records which of
  this change's quantities are gated on it — the poll schedule (2.2), the retry bound/jitter (5.1),
  and the default transaction-hold bound (1.5) — and B-4 is answered in writing with the measurement
  conditions attached before any of those numbers is written into `src/`.
- [ ] 0.3 **Confirm the writer-registration table's physical name with
  `v1.0.0-sqlite-schema-parity`.** Index and trigger names are global per database file, so the
  table must go through that change's prefix layer. **Acceptance:** the prefixed name is recorded
  here and referenced by task 3.1 rather than invented there.

## 1. The transaction primitive

- [ ] 1.1 **Implement `withTransaction` over `BEGIN IMMEDIATE`.** Preserve the module-level
  transaction-handle registry's shape and rationale (`src/postgres/transaction-lease.ts:35-61`),
  mapping a handle to the SQLite connection or worker RPC channel instead of a `postgres.js`
  callback. **Acceptance:** a unit test asserts a resolved handle always refers to its own live
  transaction and that a handle used after its transaction ended throws
  `TransactionHandleInvalidError`; an executable check (task 1.6) finds no `BEGIN DEFERRED` on any
  write path. Satisfies "every write transaction opens BEGIN IMMEDIATE and no write path is
  DEFERRED".
- [ ] 1.2 **Implement the FIFO write queue for top-level transactions.** **Acceptance:** a test
  issues two concurrent top-level `withTransaction` calls and asserts both complete, and that
  neither produces `SQLITE_ERROR` ("cannot start a transaction within a transaction"); a second test
  asserts a nested call does **not** enter the queue.
- [ ] 1.3 **Implement `SAVEPOINT` reentrancy for nested calls.** **Acceptance:** a test nests
  `withTransaction`, fails the inner scope, and asserts the outer transaction rolls back with the
  inner error rather than deadlocking; a negative-control test drives the same input through a
  naive independent-transaction implementation and asserts it deadlocks (bounded by a test timeout).
  Satisfies "nested withTransaction resolves to a savepoint rather than deadlocking".
- [ ] 1.4 **Implement sticky-poison emulation, set by the adapter wrapper.** The flag is set on any
  thrown `StorageError` whose scope is the transaction, including one thrown before any statement is
  issued; poison is monotone and survives a nested rollback; a poisoned transaction always ends in
  `ROLLBACK`. **Acceptance:** three tests — (a) swallow a statement error, continue, return
  normally, assert zero rows durable; (b) swallow an **adapter-thrown** guard error that issued no
  statement, continue, assert zero rows durable; (c) a negative control implementing L2's
  statement-executor-set flag, asserting it produces a partial commit on (b). Satisfies "a
  transaction handle is poisoned by any transaction-scoped error…".
- [ ] 1.5 **Implement the transaction-hold watchdog.** Bound = `opts.timeoutMs`, else the configured
  default derived from `idleInTxTimeoutMs`. On expiry: `ROLLBACK`, release the write lock,
  unregister the handle, reject with `TransactionFaultError(faultKind:"timeout")`, and discard
  `fn`'s later outcome. **Acceptance:** a test holds a transaction past its bound and asserts (i) an
  independent writer commits immediately afterwards, (ii) the rejection's `faultKind` is
  `"timeout"`, (iii) further use of the handle throws `TransactionHandleInvalidError`; a negative
  control with no bound asserts the second writer is blocked indefinitely (bounded by a test
  timeout). The default's numeric value is written only after gate 0.2 clears. Satisfies "the
  whole-database write lock held by withTransaction is bounded".
- [ ] 1.6 **Add the executable `BEGIN IMMEDIATE` check.** **Acceptance:** a test (or lint rule) that
  scans the SQLite adapter sources and fails the build if any transaction-opening statement
  preceding a write is not `BEGIN IMMEDIATE`. A deliberately introduced `BEGIN DEFERRED` makes it
  fail.

## 2. The lease

- [ ] 2.1 **Implement the process-local per-key FIFO lease.** No file is created, opened, read,
  written, locked or unlinked. Preserve every frozen observable behaviour (`acquireLease` waits
  indefinitely absent `timeoutMs`; `tryAcquireLease` resolves `null`; mid-wait abort;
  `LeaseNotHeldError`; `withLease` always releases). **Acceptance:** the existing Sprint 2 lease
  test file passes unchanged in its assertions (only its fixture changes), plus a test asserting no
  file is created under the database directory during acquire/hold/release. Satisfies "per-key lease
  mutual exclusion is enforced in-process and uses no lock file" and "the lease's frozen observable
  contract is preserved…".
- [ ] 2.2 **Establish the wake/poll schedule.** **Acceptance:** the chosen schedule is recorded with
  the measurement conditions (filesystem, `synchronous`, `journal_mode`, contention shape, dataset
  size relative to page cache) and the command that produced it, behind gate 0.2. No figure from a
  tmpfs-era lane run is used.
- [ ] 2.3 **Delete the Postgres lease machinery.** `raceAgainstAbort`
  (`src/postgres/transaction-lease.ts:91-117`), `reserveBounded` + `RESERVE_TIMED_OUT` (`:130-170`),
  `resetStatementTimeout` (`:181-184`), the advisory-lock class constant and every
  `pg_advisory_lock` / `pg_advisory_unlock` call (`:195,287,301,340,353,364,389`).
  **Acceptance:** `grep -rn "pg_advisory\|reserveBounded\|raceAgainstAbort" src/` returns nothing
  outside `src/postgres/`, and `npm run typecheck` passes.
- [ ] 2.4 **Port the migration lock onto the same primitive.** **Acceptance:** a test asserts a
  second concurrent `runMigrations` fails with `MigrationLockTimeoutError` within its bound, and
  that the bound defaults to the value already published for
  `DEFAULT_MIGRATION_LOCK_TIMEOUT_MS` (`src/postgres/migrate.ts:18`).
- [ ] 2.5 **Edit the frozen TSDoc mechanism clause.** Remove "matching `pg_advisory_lock`'s real
  blocking semantics" from `src/interfaces/transaction-lease.ts:83` while preserving the behaviour
  it described. **Acceptance:** a test greps the built `dist/index.d.ts` for `pg_advisory_lock` and
  asserts zero matches; the indefinite-wait behaviour is still documented in the same TSDoc block.

## 3. The writer-generation guard

- [ ] 3.1 **Add the writer-registration row and the open-time registration.** Single row, monotone
  `generation`, per-open `owner`; `pid`/`host`/`registered_at` are diagnostics only and are read by
  nothing. **Acceptance:** a test opens, reads back the generation, re-opens, and asserts the
  generation strictly increased; a code-level check asserts no code path reads `pid` or `host` to
  make a decision.
- [ ] 3.1a **Implement invariant I-4 on the registration (gate G-4).** The registration `UPDATE`
  asserts it affected **exactly one** row, and the read-back asserts a row whose `owner` and
  `generation` are the values just written. Either assertion failing is a named non-retryable startup
  error and the process does not open the database for writing. No code path retains an undefined
  generation and continues.
  **Why this exists rather than relying on the seed row:** measured on the ruled binding, `UPDATE …
  WHERE id = 1` against a registration table with no row reports success with `changes = 0`, the
  read-back returns no row, and `myGeneration` is `undefined`, with nothing thrown. Change 4's
  migration seed closes the *initial* instance; I-4 closes the *class*, including a row deleted after
  seeding, which reproduces identically.
  **Acceptance:** (a) registration against an unseeded table fails with the named startup error
  rather than proceeding; (b) the same against a row deleted after seeding; (c) two negative
  controls — one with the affected-row assertion removed, one with the read-back assertion removed —
  each demonstrating undefined-generation silent success, including that the resulting guard is
  *inert* rather than merely wrong (two processes both pass the check); (d) the named error is
  non-retryable. Satisfies invariant **I-4** and its three scenarios. **This task is what makes
  change 5's task 3.7 acknowledgment criterion satisfiable.**
- [ ] 3.2 **Add the per-write-transaction guard read inside `BEGIN IMMEDIATE`, and test it across
  all three orderings.** An earlier draft of this task asked for a single two-process test in which
  "B registers **while** A holds a transaction open", asserting A is rejected. That test cannot be
  staged and the assertion is wrong: with the write lock intact, B cannot register while A holds it,
  so the interleaving is unreachable — *except* under the descriptor attack, which realises it and
  makes the assertion fail again for a third reason. Three orderings, three different assertions:
  - **O1 — B registers between A's transactions (the reachable case the guard exists for).**
    **Acceptance:** A holds no open transaction; B registers; A's *next* write transaction rolls
    back, does not commit, and the fault's `retryable` marking is `"non-retryable"`; every
    subsequent A transaction is rejected identically.
  - **O2 — B attempts to register while A holds a write transaction (unreachable under
    `BEGIN IMMEDIATE`).** **Acceptance:** B observes `SQLITE_BUSY` and waits under the bounded retry
    policy; **A commits normally and is NOT refused.** A test asserting "A is refused" here is
    defective and must be rejected in review — it could pass only if the write lock were already
    void, which is exactly what O3 covers.
  - **O3 — the ordering the descriptor attack makes reachable (negative control).**
    **Acceptance:** with an in-process `fs.readFileSync` of `-shm` while A holds its transaction, the
    test asserts the two observables directly — *no two writers both commit*, and *no acknowledged
    commit is lost*. Against an implementation permitting the in-process open+close this test
    **FAILS** (both `COMMIT`s return ok, one acknowledged row is absent, `integrity_check` is `ok`);
    it passes only once task 3.6's source guard makes the void unreachable from UmbraDB's own code.

  Plus the standing negative control: a guard evaluated on a separate connection, before
  `BEGIN IMMEDIATE`, or on a timer, permits a displaced process to commit. Satisfies "a second
  writer process is detected…" and its three ordering scenarios.
- [ ] 3.6 **Add the source guard banning in-process descriptor operations on `-wal`/`-shm`.** Same
  instrument as change 2's `INSERT OR REPLACE` ban: an executable check that fails the build.
  **Scope note — widened after change 2 found the gap:** an earlier draft banned sidecar paths only,
  which covers `journal_mode=wal` and nothing else, because under `delete`/`truncate` there is no
  `-shm` and the locks live on the database file itself (measured, design §12(h)). The ban is
  unconditional rather than mode-conditional because `journal_mode` is a mutable property of the file
  and a build-time check cannot know it.
  **Acceptance:** a deliberately introduced `fs.readFileSync` on the database path **and** on each
  sidecar path fails the build, including when the path is built by a helper rather than concatenated
  at the call site; an existence/metadata check on any of them does **not** fail it; the rule's
  recorded rationale states that the fault is the close rather than the open, that the ban is
  deliberately stricter than the minimum, and that mode-mutability is why it is not mode-scoped.
  Satisfies "no UmbraDB code opens and closes a descriptor on the database file or its sidecars".
- [ ] 3.8 **Add the per-journal-mode locus test.** **Acceptance:** for each of `wal`, `delete` and
  `truncate`, a control arm (no attack) asserts the competing writer is refused, and an attack arm
  performs an in-process open+close of the database file and asserts: harmless under `wal`; write
  lock voided, competitor commits, acknowledged commit lost under `delete` and `truncate`. The
  control arms are what make the attack arms evidence rather than coincidence. Satisfies "the write
  lock's locus is journal-mode-dependent…".
- [ ] 3.9 **Sweep every write-lock-exclusivity claim for the qualifier.** **Acceptance:** each of the
  enumerated claims — the writer-generation fail-stop, ordering 2, the migration lock's cross-process
  exclusion (task 2.4), and `prune`'s C2a argument (task 4.3) — carries the descriptor precondition
  in its requirement text, code comment and contract sentence; a reviewer checklist item records that
  a claim found without it is a specification defect. Satisfies "every claim resting on write-lock
  exclusivity carries the precondition".
- [ ] 3.7 **Quarantine the lease's sidecar-reading test (paired with task 2.1).** **Acceptance:** the
  test that reads `-wal`/`-shm` to prove the lease survives runs against a throwaway database with no
  write transaction open and no reliance on the writer-generation guard anywhere in its fixture,
  discards that database afterwards, and carries an inline note at the read site recording that this
  act voids the adjacent guarantee. Satisfies the quarantine clauses of "…does not void a held
  lease".
- [ ] 3.3 **Add the crash-recovery test.** **Acceptance:** `SIGKILL` a registered writer, start a
  new process, assert it registers and operates with no cleanup step and no waiting; assert the
  registration row is readable and consistent.
- [ ] 3.4 **Add the guard read at lease acquisition.** Fast-fail only; safety stays with 3.2.
  **Acceptance:** a test asserts a displaced process's `acquireLease` rejects; a comment and a test
  assert that disabling this read does not change whether a displaced process can commit.
- [ ] 3.5 **Run the Windows parity experiment, or qualify the contract.** The experiment now carries
  the descriptor arm as well: the hazard follows from POSIX record-lock ownership by
  `(process, inode)`, whereas Windows locking is owned by the file handle, which *predicts* absence
  — a prediction of exactly the class that produced the falsified immunity claim, so it is tested,
  not recorded. **Acceptance:** either an executed Windows run of all three arms (control,
  open-and-hold, open-and-close) asserting no two writers both commit and no acknowledged commit is
  lost, recorded with its command and output; or `docs/CONTRACT.md` §5 naming the platforms on which
  the strengthened guarantee holds. If the hazard is confirmed absent on Windows, the contract states
  the two platforms separately rather than documenting the weaker as universal. The source guard
  (3.6) stays in force on every platform either way. Satisfies "Windows parity…" and "the descriptor
  hazard is POSIX-specific and its Windows status is measured, not inferred".

- [ ] 3.10 **State the per-file scope of every concurrency object (gate G-15).** Write queue per
  file; lease mutex map keyed by `(file, key)`; poison flag and hold watchdog per transaction hence
  per file; handle registry process-wide as a map but every entry recording its file; registration
  and migration lock per file; the descriptor ban process-wide by construction. Handles do not cross
  files. **Acceptance:** a test passes a wallet-database handle to an archive-bound adapter and
  asserts `TransactionHandleInvalidError`; a test asserts a long write transaction on one file does
  not delay a write or a lease acquisition on the other, **including when both use the same lease key
  string**; a negative control with a process-wide queue or a bare-key lease map demonstrates the
  cross-lineage serialization. Change 1 states the per-file factory/worker scope; this task does not
  restate it. Satisfies "every concurrency object in this capability is scoped per database file".
- [ ] 3.11 **Re-sweep the inheritance table across all seven changes (gate G-9).** **Acceptance:** a
  sweep for the exclusivity phrasings (`BEGIN IMMEDIATE`, "single-writer", "write lock", "serializ")
  across all seven change directories; every hit is either a row in §2.6.2 with a named owner or is
  explicitly recorded as not resting on exclusivity, with no third category; the sweep is re-run
  whenever a change is added. Rows E-7 (change 4 migration lock), E-8/E-9 (change 6 row-lock removal
  and ingest bundle) and E-10 (change 7 import lock) are present, and E-8/E-9 additionally carry the
  archive-writer-guard qualifier. Satisfies "the enumeration is mechanically swept, not authored from
  recollection".

## 3b. Handovers created by gate R-2 (not implemented here)

- [ ] 3b.1 **Hand H-2 to `v1.0.0-sqlite-temporal-event-log`.** Their its requirement *"the engine configuration under which trigger-based enforcement is sound is asserted, not assumed"*
  states the check-then-insert TOCTOU window is "closed **three independent ways**". The three are
  not independent: all rest on write-lock exclusivity, which one in-process `-shm` open+close
  removes. With the lock void, two writers hold write locks simultaneously so nothing raises
  `SQLITE_BUSY`; each transaction's assertion runs against a snapshot taken before the other
  committed, so fresh-snapshot visibility does not see it either; and neither commit is refused.
  **Acceptance:** the handover is delivered with the reproduction, the word "independent" is struck
  or qualified in their spec by their author, and this file records the outcome. **Do not edit their
  spec.**
- [ ] 3b.3 **Tell `v1.0.0-sqlite-temporal-event-log` which way the guard-scope question went**
  (their design open question 4b / acceptance F7d). **The answer is option 1: the source guard is
  widened to the database file as well as the sidecars, unconditionally, so their all-modes T5
  soundness claim stands and needs no narrowing.** They should keep `wal`, `delete` and `truncate`
  in the claim, and add the descriptor precondition as its qualifier rather than dropping modes.
  Also relay the knock-on they flagged: their transaction-identity guard's "forgery from outside is
  refused by the write lock" scenario inherits the same precondition, and is listed in design
  §2.6.2's inheritance table. **Acceptance:** the answer is delivered, their claim and that scenario
  carry the qualifier, and this file records the outcome. **Do not edit their spec.**
- [ ] 3b.4 **Hand the qualifier obligations to changes 4, 6 and 7 (gate G-9).** Each carries the
  descriptor precondition in **its own** spec text for the claims §2.6.2 lists against it: change 4's
  migration-lock `BEGIN IMMEDIATE` reinforcement clause (E-7); change 6's row-lock-removal
  justification and single-transaction ingest bundle (E-8, E-9), which additionally need the
  archive's own writer-generation guard as a second qualifier per G-8; change 7's whole-import
  write-lock premise (E-10). **Acceptance:** each qualifier is present in the owning change's file,
  the obligation is recorded in that change's `tasks.md` rather than only here, and this file records
  the outcome. **Do not edit their specs.**
- [ ] 3b.6 **Flag a G-2 design problem to `v1.0.0-sqlite-engine-core` (the enforcement grep's
  owner).** After this change's G-1/G-3 edits, a sweep of this directory for the widened phrase list
  ("not wired", "nothing calls", "no consumer", "no runner", "if it is ever wired") still returns
  four hits — **all of them corrections**: the proposal's retraction paragraph, acceptance N1's
  "it does not assert…", and H13's own criterion. A bare phrase list therefore cannot distinguish
  *asserting* the retracted premise from *retracting* it, and will stay red forever no matter how
  correctly every author edits. G-2 needs either a retraction-context exclusion or a machine-readable
  correction marker the grep skips. **Acceptance:** the amended J3 discriminates assertion from
  retraction — demonstrated by its negative control firing on a planted assertion while these four
  correction hits pass — and this file records the resolution. **Do not edit their check.**
- [ ] 3b.5 **Hand `v1.0.0-sqlite-durability-contract` an operational definition of "quiesce"
  (gate G-17).** Quiesced = **no open write transaction on the file, and every handle to it closed**
  — or, equivalently and more simply verified, the owning process has exited. A copy procedure is
  post-quiesce only if it runs after that state is established and nothing can reopen the file
  meanwhile. **Acceptance:** the definition appears in change 5's backup text, and the out-of-process
  copy procedure references it rather than using the bare word.
- [ ] 3b.2 **Hand H-5 to `v1.0.0-sqlite-durability-contract`.** Offline backup/restore that copies
  the database with its `-wal`/`-shm` sidecars must be specified out-of-process or post-quiesce; an
  in-process three-file copy is the attack performed by our own documentation. Note also that
  `backup()` is executed by the engine and opens no `fs` descriptor on the sidecars, which is a
  further argument for the seat's `backup()`-over-`VACUUM INTO` ruling. **Acceptance:** the handover
  is delivered and this file records the outcome. **Do not edit their spec.**

## 4. Isolation, reads and prune

- [ ] 4.1 **Add the internal read-snapshot primitive** (`BEGIN DEFERRED` on a reader connection, no
  write lock) and move `load` and `history` onto it, dropping
  `{ isolation: "repeatable read" }` from `src/postgres/checkpoint-store.ts:392` and `:458`.
  **Acceptance:** a test asserts an independent writer commits while a large `load` is in flight; a
  second test reproduces the torn-read fixture (a prune committing between the page query and the
  aggregate) and asserts one consistent instant; a negative control routing `load` through
  `withTransaction` asserts the writer is blocked. Satisfies "read paths do not take the database
  write lock".
- [ ] 4.2 **Document `TransactionOptions.isolation` as validated-then-ignored.** **Acceptance:** the
  TSDoc at `src/interfaces/transaction-lease.ts:164` says so; a test asserts every enum value is
  accepted and none changes observable behaviour.
- [ ] 4.3 **Move `prune` to `BEGIN IMMEDIATE` and re-derive its C2a justification.** Rewrite the
  comment at `src/postgres/checkpoint-store.ts:485-487` and `Formal/STORAGE_ALGEBRA.md` §2's C2a
  status. **Acceptance:** a negative-control test runs prune `DEFERRED` against a `save` that
  re-references a chunk after the snapshot and asserts a live chunk is reclaimed (observable as a
  surviving checkpoint that no longer loads); the same fixture under `IMMEDIATE` asserts no live
  chunk is reclaimed; a doc check asserts neither the comment nor `STORAGE_ALGEBRA.md` §2 mentions a
  READ COMMITTED dependency. Satisfies "prune's C2a justification is re-derived…".
- [ ] 4.4 **Restate the grace window's role.** **Acceptance:** the code comment and the contract text
  describe it as serving the backup story; a test varies the window and asserts C2a still holds.

## 5. Contention and error mapping

- [ ] 5.1 **Implement the bounded, jittered retry classifier over the masked primary result code.**
  **Acceptance:** a test asserts a transient `SQLITE_BUSY` is retried internally and surfaces no
  error; a second asserts that when the bound is exhausted the surfaced code is the frozen one for
  that situation. Bound/attempts/jitter are written only after gate 0.2 clears.
- [ ] 5.2 **Implement the contention mapping with zero surface change, keyed on the ruled binding's
  string discriminator.** `err.code === "SQLITE_BUSY"` → `LEASE_TIMEOUT` /
  `MIGRATION_LOCK_TIMEOUT` / `TransactionFaultError("timeout")` by context;
  `err.code === "SQLITE_BUSY_SNAPSHOT"` → `TransactionFaultError("serialization-failure")`. Do
  **not** key on a numeric `errcode`: the ruled binding carries no such field, so a numeric key
  routes every contention error to the catch-all silently (design §7.1, §12(f)).
  **Acceptance:** a test asserts every surfaced
  contention error's `code` is already present in `docs/ERROR-CATALOG.md` with an unchanged
  `retryable` marking, and that every `faultKind` used is already a member of the union at
  `src/interfaces/transaction-lease.ts:76`; the error-catalog drift test stays green with no catalog
  edit. Satisfies "contention is retried inside the adapter and surfaces only through already-frozen
  codes".
- [ ] 5.3 **Assert no contention code is added.** **Acceptance:** a test asserts the exported error
  `code` set contains no `BUSY`/`WRITE_CONTENDED`-shaped member, with a comment naming LND #7869 as
  the reason; the same test documents that `docs/STABILITY.md` would *permit* the addition, so the
  prohibition is recorded as a safety ruling rather than a SemVer one.
- [ ] 5.4 **Make `CONNECTION_ERROR` unreachable without repurposing it.** **Acceptance:** a test
  asserts no adapter path throws `ConnectionError`, and that file-level faults surface
  `"non-retryable"` errors; a negative control mapping `SQLITE_CANTOPEN` onto `CONNECTION_ERROR`
  asserts a bounded-retry loop spins. Satisfies "CONNECTION_ERROR becomes unreachable and is never
  repurposed".
- [ ] 5.5 **Add replacement reachability evidence for a retryable code.** **Acceptance:** at least
  one executed conformance test demonstrates a frozen retryable code reachable under SQLite, and the
  change record notes which pinned Postgres id it replaces. The pinned
  `EXPECTED_REQUIRED_COUNT` change lands in a **separate, reviewed commit** from any id deletion
  (`test/integration/check-required-tests.ts:100`).
- [ ] 5.6 **Agree the displacement fault's code with
  `v1.0.0-sqlite-durability-contract`.** **Acceptance:** the code is non-retryable, is not
  `TRANSACTION_FAULT`/`LEASE_TIMEOUT`/`MIGRATION_LOCK_TIMEOUT`, and a test asserts a caller can
  distinguish displacement from contention by `code` and `retryable` alone.
- [ ] 5.7 **Assert `SQLITE_BUSY_TIMEOUT` is unreachable.** **Acceptance:** a test exercises the
  adapter under contention and asserts that result-code name is never observed; the defensive
  mapping row is removed rather than carried.
- [ ] 5.8 **Assert the discriminator field exists on a real thrown error.** **Acceptance:** a test
  provokes a genuine contention error, asserts `err.name` identifies the binding's error type and
  that the keyed field is present, not `undefined`, and carries the expected result-code name; a
  negative control keyed on a numeric `errcode` asserts every contention error falls through to the
  unrecognised-error path and is surfaced non-retryable where a retryable code was due. Satisfies
  "…discriminator field is asserted to exist on a real thrown error" and its negative control.

## 6. Conformance

- [ ] 6.1 **Re-execute P10 against SQLite.** **Acceptance:** an executed run, recorded with the
  command that produced it; no result carried over from the Postgres run.
- [ ] 6.2 **Add P10's three negative controls.** Descriptor-close attack, unlink attack, blocking
  `busy_timeout`. **Acceptance:** each control fails against the implementation it targets and
  passes against the shipped one; a meta-assertion fails the suite if every negative control passes.
  Satisfies "P10 is re-executed with negative controls…".
- [ ] 6.3 **Delete the pool/pooler test family.** The connection-pool-exhaustion tests, the
  `statement_timeout`-poisons-a-pooled-connection regression tests, and the `faultKind:"deadlock"`
  test have no referent. **Acceptance:** `npm test` passes with them removed and no test asserts a
  behaviour the SQLite adapter cannot exhibit.

## 7. Contracts and formal record

- [ ] 7.1 **Rewrite `docs/CONTRACT.md` §5.** Retire the connection-death clause; state detection +
  transaction-granular fail-stop; state the deleted-file precondition; state the **descriptor
  precondition as binding on the embedding application**, with its consequence written concretely
  (two writers both commit, an acknowledged commit is silently lost, `integrity_check` reports `ok`)
  rather than as a general caution about locking; do **not** claim refusal-at-open, and do **not**
  claim UmbraDB enforces the descriptor precondition against code it does not own.
  **Acceptance:** a doc check asserts §5 contains no sentence asserting a second writer process is
  refused at open, that the descriptor precondition and its concrete consequence are both present,
  and that every guarantee in §5 maps to a scenario in `specs/transaction-lease/spec.md`. Satisfies
  "the lease limitation stated in writing is exactly what the mechanism delivers". **This task must
  not start before tasks 3.2 and 3.6 pass.**
- [ ] 7.2 **Update `docs/durability-contract.md`'s timeout table (`:100-104`).** `lock_timeout`
  becomes the acquisition bound; `idle_in_transaction_session_timeout` becomes the transaction-hold
  bound; the `statement_timeout` row is struck and the absence of any statement-runtime bound is
  stated. **Acceptance:** a doc check asserts no GUC name remains in the table and that the
  statement-runtime gap is stated in prose.
- [ ] 7.3 **Update `Formal/STORAGE_ALGEBRA.md` §4's L1 mechanism line.** Replace "session-scoped
  advisory lock; breaks only under a transaction-pooling proxy" with the in-process mutex plus the
  writer-generation guard, and name the new voiding precondition (the database file replaced beneath
  a live process, or a filesystem where SQLite's locking does not work). **Acceptance:** a reviewer
  can read the line and tell the mechanism changed; the status label is re-derived rather than
  carried over.
- [ ] 7.4 **Add the CHANGELOG entry enumerating the surface deltas.** `statementTimeoutMs` /
  `lockTimeoutMs` / `idleInTxTimeoutMs` change meaning; `LeaseFaultError("reserve-failed")` and
  `faultKind:"deadlock"` become unreachable; `TransactionOptions.isolation` becomes
  validated-then-ignored; the transaction-poisoning consequence is now emulated; the
  `pg_advisory_lock` TSDoc clause is removed. **Acceptance:** every item in this list appears, and
  the entry states that each is free only because `docs/STABILITY.md:46` records the 1.0.0
  commitments as not yet in force.
