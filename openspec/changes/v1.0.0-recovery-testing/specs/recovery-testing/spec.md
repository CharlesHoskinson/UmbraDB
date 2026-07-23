# recovery-testing (crash-injection, soak, differential & live-evidence gate)

The failure-path verification layer for UmbraDB 1.0.0 — roadmap gate items **G9–G12**. These
requirements are about **what the test suite and release process SHALL do**; the storage behavior
they verify is fixed by the correctness/durability change (G5–G8) and the merged primitives.
Requirements follow EARS (Easy Approach to Requirements Syntax): each is Ubiquitous ("The system
SHALL…"), Event-driven ("WHEN \<trigger>, the system SHALL…"), Unwanted-behavior ("IF \<trigger>,
THEN the system SHALL…"), State-driven ("WHILE \<state>, the system SHALL…"), or Optional-feature
("WHERE \<feature>, the system SHALL…") form — as in Sprint 2's
`specs/transaction-lease/spec.md` and Sprint 4's `specs/watermarks/spec.md`. Each requirement
carries its roadmap gate tag (`G9`/`G10`/`G11`/`G12`) and, where applicable, its fault-plan id
(`T1`/`T2`/`T3`/`T5`/`T11`, from `02-reliability-hardening.md` §"Fault-injection test plan") in
its title, per the auditors' format ruling — the OpenSpec tooling keys on the `### Requirement:`
heading level, so the gate tag lives inside the requirement name, not in a section heading.

"The crash-injection suite" / "the soak suite" / "the differential gate" refer to the concrete
test suites this change adds (`design.md` §0). "The required gate" is the non-live CI job
(`.github/workflows/conformance.yml` → `npm run test:conformance`), never the live tier
(`UMBRADB_LIVE_PREPROD=1`, `npm run test:live`,
`test/integration/live-fixtures/preprod-fixtures.ts`).

Two terms are defined once in `design.md` and used throughout below:

- **Write batch** (`design.md` §2.3) — one harness-generated unit of sync progress, identified by
  a monotonic index the harness assigns as it drives the run. Every write batch has an associated
  cursor value; "state increment up to the watermark" means "every harness-generated write batch
  whose cursor value ≤ the durable watermark." This term is testable precisely because the harness
  owns the generating schedule.
- **Current-state equality predicate** (`design.md` §2.3) — the objective equality used by every
  replay-equivalence assertion in this change: two databases have equal *current state* iff their
  `kv_current` rows agree on `(kind, key) → value` for every key, their latest **complete**
  checkpoint manifests decode to identical payload bytes, and their watermark rows agree on
  `(kind, key) → value`. The predicate **excludes** `kv_history` rows and the `version` columns,
  which legitimately diverge when a version-bumping `put` is replayed.

## ADDED Requirements

### Requirement: G9 — the crash-injection suite runs in the required gate and does not self-skip

The crash-injection suite SHALL execute in the required, non-live CI gate
(`npm run test:conformance`) against a real Testcontainers Postgres, and SHALL NOT be gated behind
`UMBRADB_LIVE_PREPROD` nor self-skip via `describe.skipIf` in that gate. IF any crash test cannot
run in a given environment (e.g. the child-process fault mechanism is unavailable), THEN it SHALL
fail the gate rather than silently skip, so a green required run is genuine evidence that the
durability guarantees were exercised. The sole exception is a `WHERE`-gated optional-feature
scenario (the idempotency-key path below): such a scenario SHALL be reported as
`skipped-pending-feature` and enumerated in the gate summary, and SHALL NOT count as a silent skip.

#### Scenario: a green required-gate run has actually executed the crash tests
- **WHEN** `npm run test:conformance` completes green with `UMBRADB_LIVE_PREPROD` unset
- **THEN** the reporter SHALL show the process-kill, Postgres-kill, cursor-durability, and
  lease-non-wedge tests as **run and passed** (not skipped)
- **AND** none of them SHALL be reported as SKIPPED under the required gate

#### Scenario: a WHERE-gated optional-feature scenario is reported as skipped-pending-feature, not as a silent skip
- **WHEN** the required gate runs and the idempotency-key feature has not shipped, so the
  no-duplicate-on-retry scenario is inactive
- **THEN** that scenario SHALL be reported as `skipped-pending-feature` and listed in the gate
  summary as a known deferred optional-feature scenario
- **AND** the gate SHALL NOT treat it as a non-live crash test that silently skipped

### Requirement: G9 — a skip-enforcement check proves every required crash test executed, none silently skipped

The required gate SHALL enforce the no-self-skip guarantee by a **named mechanism**, not merely by
convention: a checked-in manifest of required crash/soak test ids SHALL be compared, after the run,
against the reporter's executed-and-passed set, and the gate SHALL fail if any required id is
absent or reported skipped. `vitest run` does not fail on a skipped or `skipIf` test by default,
so this post-run reconciliation is the enforcement that makes "durability shipped unverified
because a test self-skipped" (the failure this whole change exists to prevent) unable to recur
silently. `WHERE`-gated optional-feature ids SHALL be listed in a separate `deferred` section of
the manifest and are exempt from the "must have executed" check while their feature is unshipped.

#### Scenario: a deliberately-skipped required crash test turns the gate red
- **WHEN** a required (non-`WHERE`-gated) crash test is deliberately marked skipped and the
  required gate runs
- **THEN** the skip-enforcement check SHALL find that required id missing from the executed-passed
  set and SHALL fail the gate
- **AND** the failure message SHALL name the missing required test id

#### Scenario: the executed set matches the required manifest on a genuine green run
- **WHEN** the required gate completes and every required crash/soak test ran and passed
- **THEN** the skip-enforcement check SHALL confirm the reporter's executed-passed set contains
  every id in the manifest's required section
- **AND** any id in the manifest's `deferred` (optional-feature) section SHALL be accounted for as
  `skipped-pending-feature`, never as an unexplained skip

### Requirement: G9 — the crash and soak suites terminate within a bounded wall-clock even when Postgres is half-dead

The crash-injection and soak suites SHALL each terminate within a bounded wall-clock and fail with
a typed error rather than hang, even when Postgres is half-dead (accepting connections but not
completing queries). The primary bound is G7's server-side
`statement_timeout`/`lock_timeout`/`idle_in_transaction_session_timeout`; this change SHALL add a
suite-level watchdog timeout as an independent backstop so that a missing or misconfigured G7
timeout surfaces as a fast typed failure, not an indefinitely wedged CI job.

#### Scenario: a half-dead Postgres makes the suite fail fast, not hang
- **WHEN** a crash or soak test issues a query against a Postgres backend that accepts the
  connection but never completes the query
- **THEN** the test SHALL terminate within its declared watchdog bound
- **AND** SHALL fail with a typed timeout/connection error rather than hang until the CI job's own
  wall-clock limit

### Requirement: G9/T1 — process-kill mid-save leaves no partially-visible checkpoint

WHEN the writer process is SIGKILLed after its chunk rows and manifest INSERT are issued but before
the `save` transaction commits, THEN after a fresh client connects the crash-injection suite SHALL
assert that no partial checkpoint is visible and prior state is intact.

#### Scenario: an interrupted save is atomically absent, prior state survives
- **WHEN** a child-process writer is killed at the `before-commit` fault point during
  `PgCheckpointStore.save`
- **THEN** the suite SHALL assert no `complete = true` manifest exists at the interrupted sequence
- **AND** the suite SHALL assert the most recent previously-committed checkpoint still `load`s and
  passes its manifest/chunk hash verification
- **AND** the suite SHALL assert no junction (`ckpt_manifest_chunks`) rows reference a
  non-existent or incomplete manifest

#### Scenario: negative control — without the kill the same save is visible and complete
- **WHEN** the identical `save` runs to completion with no fault injected
- **THEN** the suite SHALL assert a `complete = true` manifest is visible at that sequence and
  `load`s — proving a passing test attributes the absence to the kill, not to a broken `save`

### Requirement: G9/T2 — Postgres-kill mid-save surfaces a typed error and stays all-or-nothing

WHEN Postgres is killed (container restart or `pg_terminate_backend`) during an in-flight `save`,
THEN the crash-injection suite SHALL assert the caller receives a typed `ConnectionError` and that,
after recovery, the checkpoint is all-or-nothing — never partially present.

#### Scenario: the in-flight save fails typed, and recovers to a consistent state
- **WHEN** Postgres is killed at the `before-commit` fault point during `save`
- **THEN** the in-flight `save` SHALL reject with `ConnectionError`, not a raw `postgres.js` error
- **AND** after Postgres is available again, the interrupted checkpoint SHALL be either fully
  present (and `load`able) or fully absent — never a partial manifest
- **AND** `load` of the latest complete checkpoint SHALL return correct bytes

### Requirement: G9/T2 — the save retry-duplication contract is verified in its 1.0.0 (documented-unsafe) form

The crash-injection suite SHALL verify the documented 1.0.0 retry contract: because `save` is not
idempotent under a lost COMMIT-ack and the `idempotency_key` fix is out of scope for 1.0.0
(deferred with Sprint 9), a blind retry produces a benign, identical-content duplicate — not
corruption — and the auto-retry wrapper excludes `save`. The lost-ack condition SHALL be
constructed by the sanctioned simulation of `design.md` §2.2 (a `save` that provably committed,
followed by a re-invocation with identical content), since the post-commit-pre-ack window cannot be
hit deterministically by a timed kill. WHERE the caller-supplied idempotency key with a UNIQUE
constraint has shipped, the suite SHALL additionally assert that a retry produces no duplicate.

#### Scenario: a blind retry after a lost ack yields a benign duplicate, and load stays correct
- **WHEN** a `save` that provably committed is re-invoked with identical content, simulating a
  lost COMMIT-ack retry (per `design.md` §2.2's sanctioned construction)
- **THEN** the suite SHALL assert the result is a second, identical-content checkpoint at the next
  sequence (a benign duplicate), not a corrupted or divergent state
- **AND** the suite SHALL assert `load` of the latest checkpoint returns correct bytes regardless
- **AND** the suite SHALL assert (statically, against the retry allowlist) that `save` is excluded
  from any auto-retry wrapper

#### Scenario: with the idempotency key present, a retry does not duplicate
- **WHERE** a caller-supplied idempotency key with a UNIQUE constraint has shipped
- **WHEN** a retry of `save` re-uses the same idempotency key after a lost ack
- **THEN** the suite SHALL assert exactly one manifest exists for that key — the retry collided
  rather than duplicating

### Requirement: G9/T5 — a crash between data and cursor never leaves the watermark ahead of durable data

WHEN the writer is killed at the boundary between the durable data commit and the cursor (watermark)
advance — exercising both the co-transactional path and the documented **safe** two-transaction
ordering (data committed first, then cursor) — THEN the crash-injection suite SHALL assert that, on
resume, the durable watermark is never ahead of durable data and that replay from the durable cursor
converges on the correct current state under the current-state equality predicate. The kill SHALL be
driven by the named `after-data-commit-before-cursor` and `after-cursor-before-data` fault hooks of
`design.md` §1/§2.3, not a wall-clock timer. This requirement depends on the co-transactional
`save`/cursor path (G5); it cannot be satisfied while `PgCheckpointStore.save` structurally refuses a
caller transaction. A `watermark-ahead` outcome from a deliberately-unsafe caller ordering
(cursor-before-data) is a caller error the storage layer cannot prevent and is out of scope; the
requirement asserts the invariant for the co-transactional and safe two-transaction paths only.

#### Scenario: the durable watermark is never ahead of durable data
- **WHEN** the writer is SIGKILLed at the `after-data-commit-before-cursor` hook, after the data
  commit and around the cursor advance
- **THEN** for the durable watermark value observed on restart, the suite SHALL assert every write
  batch whose cursor value ≤ that watermark is present in durable checkpoint/KV data
- **AND** the suite SHALL assert the watermark is never observed pointing past a write batch whose
  data was not persisted (watermark-behind-data is acceptable; watermark-ahead is a failure)

#### Scenario: replay from the durable cursor converges on current state
- **WHEN** the sync resumes from the durable cursor and re-applies the interrupted window
- **THEN** the suite SHALL assert the resulting current state equals the reference current state,
  where the reference is a fault-free replay of the **same** harness-generated input sequence built
  from UmbraDB's own adapters (the same in-repo reference discipline as G11)
- **AND** the equality SHALL be the current-state equality predicate (defined above) — `kv_current`
  values + latest complete checkpoint payload + watermark values — explicitly excluding
  `kv_history` rows and `version` columns, which legitimately diverge when a version-bumping `put`
  is replayed

#### Scenario: the invariant holds under synchronous_commit = on
- **WHILE** the server is configured with `synchronous_commit = on`
- **WHEN** the crash-between-data-and-cursor fault is injected
- **THEN** the suite SHALL assert "watermark never ahead of durable data" holds

#### Scenario: the invariant holds under synchronous_commit = off
- **WHILE** the server is configured with `synchronous_commit = off`
- **WHEN** the crash-between-data-and-cursor fault is injected, with the off-leg forced by an
  unclean postmaster kill (`design.md` §2.3) so a tail loss is actually reachable
- **THEN** the suite SHALL assert "watermark never ahead of durable data" still holds for whatever
  survived
- **AND** a lost tail of acknowledged commits SHALL be treated as acceptable, while an inverted
  durability order (cursor durable, its data not) SHALL be a failure

### Requirement: G9/T3 — a killed lease-holder does not wedge the lease

WHEN a process holding a `withLease` critical section is SIGKILLed, THEN the crash-injection suite
SHALL assert a fresh process re-acquires the same lease immediately and that the underlying advisory
lock is released server-side.

#### Scenario: a fresh process re-acquires the lease after a holder is killed
- **WHEN** a child-process holding a `withLease` on key `k` is SIGKILLed mid-critical-section (at
  the `in-critical-section` fault hook)
- **THEN** the suite SHALL assert a fresh process's `withLease` on key `k` acquires immediately,
  within a bounded wait, with no wedge or timeout
- **AND** the suite SHALL assert `pg_locks` shows the class-2 advisory lock for `k` is gone

### Requirement: G10 — a full-sync soak runs at a declared envelope with GC passes and holds every invariant

The soak suite SHALL run a sustained realistic write mix — versioned KV puts, checkpoint saves at a
realistic cadence, watermark ticks, periodic `prune` GC passes, and a held lease, concurrently —
for a bounded duration at a declared data/concurrency envelope, and SHALL assert no invariant is
violated during or after the run.

#### Scenario: the soak completes with zero invariant violations and a replay-equivalent end state
- **WHEN** the soak runs for its declared duration at its declared envelope (on the order of
  10^5–10^6 chunks, not a 10^7 matrix)
- **THEN** the suite SHALL assert that a named set of SQL-observable, P1–P10-derived invariants —
  sampled during the run, not only at the end — never fails; that set SHALL include at minimum:
  gapless per-key `version` sequences (P1/P2), only-`complete = true` manifests are `load`able (C1),
  no junction rows referencing a missing manifest (C2a), and the durable watermark never exceeding
  the maximum durable data (T5 invariant)
- **AND** the suite SHALL assert the end state is equal (on the current-state equality predicate) to
  a fault-free reference run of the same input
- **AND** the suite SHALL record each GC-pass duration as an artifact and SHALL assert each pass
  completes within a named per-pass watchdog constant (a **test-termination** bound, explicitly not
  a performance gate — the recorded durations are the artifact; no pass-rate or latency threshold
  gates the release)

### Requirement: G10 — load during a concurrent prune never corrupts a live checkpoint's retrieval

WHILE a `prune` (GC pass) runs concurrently, `load` of a checkpoint that should survive the prune
SHALL NOT yield `ChunkIntegrityError` or `ChunkMissingError`, and the soak/retrieval suite SHALL
assert this. The concurrency SHALL be made deterministic by a forced-interleave primitive
(`design.md` §3.2) that provably lands the `prune` COMMIT inside `load`'s open REPEATABLE READ
snapshot window — not left to a timing race that may run `prune` entirely before or after `load`.

#### Scenario: a live checkpoint loads cleanly under a forced concurrent prune
- **WHEN** `load` of a live (retained) checkpoint runs concurrently with a `prune` that reclaims
  unreferenced chunks, with the `prune` COMMIT forced (via the `design.md` §3.2 interleave
  primitive) to land between `load`'s snapshot start and its chunk-byte read
- **THEN** the suite SHALL assert `load` returns the checkpoint's correct bytes
- **AND** SHALL assert `load` never raises `ChunkIntegrityError` or `ChunkMissingError` for that
  live checkpoint (the REPEATABLE READ snapshot property holds)

#### Scenario: negative control — the un-snapshotted ordering would actually raise
- **WHEN** the same interleave is applied to a deliberately un-snapshotted read path (reading a
  chunk outside `load`'s REPEATABLE READ snapshot) whose chunk the forced `prune` reclaims
- **THEN** the suite SHALL assert that path DOES raise `ChunkMissingError` — proving the passing
  test's clean `load` is attributable to the snapshot, not to the `prune` never having overlapped

### Requirement: G11 — the differential gate is anchored on the P3 replay-equivalence property

The differential state-equivalence gate SHALL be satisfied in-repo, with the P3 property (temporal
projection equals fold of events up to `T`, `Formal/STORAGE_ALGEBRA.md` §5) named as its
replay-equivalence anchor and running in the required gate — no foreign consumer or indexer
application is imported to provide a reference.

#### Scenario: P3 runs in the required gate as the fold-equivalence anchor
- **WHEN** the required gate runs
- **THEN** the P3 property test SHALL execute and pass against real Postgres
- **AND** the gate's documentation SHALL record that P3 is the differential gate's
  fold-equivalence half, satisfied without importing the replaced store

### Requirement: G11/T11 — a fault-schedule run is state-equivalent to a fault-free reference

WHEN a randomized schedule mixing the G9 faults (process-kill, Postgres-kill, crash-between-data-
and-cursor) is applied to a sync run, THEN the differential gate SHALL assert that a full re-sync
from durable state produces a current state equal (on the current-state equality predicate) to a
fault-free reference run of the same input, with the reference built entirely from UmbraDB's own
in-repo code. This depends on the co-transactional cursor/data path (G5).

#### Scenario: fault-schedule end state matches the fault-free reference on current state
- **WHEN** the same input is applied twice — once under a randomized G9 fault schedule with re-sync
  from durable state, once fault-free — using an in-repo reference (e.g.
  `test/postgres/reference-merge.ts`), with no imported external store
- **THEN** the gate SHALL assert the two current states are equal on the current-state equality
  predicate (`kv_current` + latest complete checkpoint payload + watermark values)
- **AND** SHALL exclude `kv_history`/`version` divergence introduced by replaying version-bumping
  writes

#### Scenario: negative control — a dropped range makes the equivalence assertion fire
- **WHEN** a deliberately-broken variant of the re-sync drops a range of durable data
- **THEN** the gate SHALL assert the equivalence check FAILS — proving the check has teeth and does
  not pass vacuously

#### Scenario: the differential gate imports no foreign consumer application
- **WHEN** the differential gate's reference side is constructed
- **THEN** it SHALL be built from UmbraDB's own adapters and in-repo fixtures only
- **AND** SHALL NOT import or depend on the replaced consumer/indexer application, preserving the
  indexer-agnostic boundary

### Requirement: G12 — a manual pre-tag Preprod round-trip is run against the RC with recorded evidence

WHEN the 1.0.0 release candidate is cut and before the tag is applied, the release process SHALL run
a manual live round-trip against the release candidate under `UMBRADB_LIVE_PREPROD=1` — sync a
funded wallet to live Preprod tip, persist its envelope, kill, cold-start in a fresh
independently-constructed object graph, and resume — and SHALL record the outcome as a release
evidence artifact. This run SHALL remain outside the required CI gate (it needs a real network and a
funded seed that must not be in CI).

#### Scenario: the pre-tag run resumes from the durable cursor with no resync or drift
- **WHEN** the RC is synced to live Preprod tip, its envelope persisted, the wallet/process torn
  down, and a fresh object graph reloads the envelope from Postgres alone
- **THEN** the run SHALL resume from the durable cursor without a full resync
- **AND** the restored wallet state (balance and transaction history) SHALL match the pre-kill
  state with no drift

#### Scenario: the run's evidence is recorded as a release artifact
- **WHEN** the pre-tag Preprod round-trip completes
- **THEN** an evidence artifact (`docs/recovery/EVIDENCE.md`) SHALL record the run date, the RC
  commit/tag, the synced tip height, the durable cursor value at kill, the restored
  balance/tx-history, and a pass/fail against each M5 sub-criterion
- **AND** the artifact SHALL record that the "remove the replaced engine" clause belongs to the
  consumer project, not this release (the indexer-agnostic boundary)

#### Scenario: the evidence run is not a required CI gate
- **WHEN** the required gate (`npm run test:conformance`, `UMBRADB_LIVE_PREPROD` unset) runs
- **THEN** the Preprod evidence run SHALL NOT execute as part of it
- **AND** the required gate SHALL remain green without a live network, funded seed, or built wallet
  checkout
