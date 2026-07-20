# Tasks — Sprint 1: project setup + TemporalKV

Each task: implemented by a Sonnet builder, then reviewed in parallel by
two Opus auditors (spec-compliance against this change's `design.md`;
code quality/docs/test coverage). A task is CLOSED only after both
auditors approve, or their findings are fixed and re-reviewed.

## 0. Project setup

- [ ] 0.1 Add `postgres` (postgres.js) as a real dependency. Verify its
  installed `.d.ts` covers `sql.reserve()`, `sql.begin()`, `sql.cursor()`,
  and tagged-template generics — cite the actual `.d.ts` file:line per this
  repo's correctness rule (`openspec/config.yaml`). If anything is missing,
  stop and flag it before proceeding (this would mean revisiting
  `design/design.md` §7's driver choice, not silently working around a gap).
  **Acceptance:** `npm ls postgres` shows it installed; a one-line smoke
  test (`import postgres from "postgres"; const sql = postgres(); await
  sql\`select 1\`;`) runs and returns `1`; AND, separately, the specific
  `.d.ts` coverage claim this task is actually about is checked directly —
  write a throwaway `.ts` snippet that calls `sql.reserve()`, `sql.begin()`,
  `sql.cursor()`, and a tagged-template call with an explicit generic
  (`sql<Row[]>\`...\``), and confirm it typechecks (`tsc --noEmit`). A
  passing `select 1` smoke test alone does not exercise any of these four
  and is not sufficient evidence for this task on its own. **Added by the
  2026-07-20 audit:** a test asserting `createClient()` (no `maxConnections`
  given) opens a pool of the driver's actual default size (10), not 1 (the
  `max: undefined` bug this change's `design.md` §3 fixes); and a test
  writing/reading a `version` above `Number.MAX_SAFE_INTEGER` through
  `PgTemporalKV`, asserting it round-trips as a real JS `bigint`, not a
  string or a precision-lossy number (the `types.bigint` config fix, same
  section).
- [ ] 0.2 Add `@testcontainers/postgresql` as a devDependency. Write
  `test/postgres/setup.ts`: starts one Postgres container for the whole
  test run, exposes its connection string, tears down on suite completion.
  **Acceptance:** a trivial test file that imports the setup and runs
  `select 1` against the container passes in CI/locally with no other
  Postgres running.
- [ ] 0.3 Write `src/postgres/migrations/000_schema.ts` and the migration
  runner (`src/postgres/migrate.ts`, `design.md` §2 — migrations are
  TypeScript `up(sql, schema)` functions, not static `.sql` files, per this
  change's schema-configurability fix). **Acceptance:** running
  `runMigrations(sql, {schema})` twice in a row against a fresh database is
  idempotent (second run applies zero new migrations, doesn't error); a
  test asserts this directly (run twice, assert `_migrations` row count is
  identical after both runs). **Added by the 2026-07-20 audit — idempotency
  alone does not prove concurrent safety:** a second test starts two
  concurrent `runMigrations` calls against the same fresh database and
  asserts (a) neither errors, (b) `_migrations` ends with exactly one row
  per migration (not duplicated), and (c) a deliberately-failing injected
  migration leaves `_migrations` unchanged and its DDL fully rolled back.
- [ ] 0.4 Write `src/postgres/migrations/001_temporal_kv.ts`
  (design/design.md §2's DDL, schema-qualified via `sql(schema)` per this
  change's design.md §0/§2). **Acceptance:** after `runMigrations`,
  `kv_current`, `kv_history`, both indexes (`kv_history_lookup` and the
  audit-added `kv_history_by_version`), and the `kv_history_no_overlap`
  EXCLUDE constraint all exist (verify via a query against
  `information_schema`/`pg_constraint`, not just "the migration didn't
  error"). **Added by the 2026-07-20 audit — existence alone does not prove
  qualification:** a hostile-`search_path` test that (1) creates a decoy
  `kv_history` table of the same shape in a *different* schema, (2) sets
  the connection that will fire the trigger to that decoy schema's
  `search_path`, (3) performs a `kv_current` update, and (4) asserts the
  resulting history row landed in the CONFIGURED schema's `kv_history`,
  not the decoy — proving schema qualification holds at trigger-execution
  time, not just that the migration's own DDL ran without error.
- [ ] 0.5 Write `src/postgres/client.ts` (design.md §3) and
  `src/postgres/errors.ts` (design.md §4a — Postgres error-code → shared
  `StorageError` translation: connection failures → `ConnectionError`;
  SQLSTATE `23P01` [exclusion_violation — NOT `23505`/unique_violation,
  a distinct code; the original task wording named the wrong one] on the
  `kv_history_no_overlap` constraint → a distinguishable, catchable error,
  even if `TemporalKV` itself doesn't hit this constraint under normal
  operation since the trigger is designed not to produce overlaps; the
  custom SQLSTATE `UB001` on `kv_current_history_trigger` →
  `TransactionKeyReuseError`).
  **Acceptance:** three separate assertions, not one — (a) a unit test that
  forces a connection failure (e.g. an invalid connection string) asserts
  a `ConnectionError` is thrown, not a raw `postgres.js` error leaking
  through; (b) a unit test that directly triggers the
  `kv_history_no_overlap` constraint violation (e.g. a manual `INSERT`
  bypassing the trigger, in a test-only helper) asserts the error is
  identified via SQLSTATE `23P01` specifically and translated to a
  distinguishable error, not just that "some error" was thrown; (c) a unit
  test that triggers `UB001` (two `put`s to one key in one transaction)
  asserts the result is specifically `TransactionKeyReuseError`.

## 1. TemporalKV

- [ ] 1.1 Implement `PgTemporalKV` (`src/postgres/temporal-kv.ts`,
  design.md §4) against `src/interfaces/temporal-kv.ts` exactly.
  **Acceptance:** `tsc --noEmit` passes with `PgTemporalKV implements
  TemporalKV` (the TypeScript compiler itself is the first acceptance
  check — a missing or mis-typed method fails to compile).
- [ ] 1.2 Port the Mongo package's `temporalKv.test.ts` +
  `temporalKvConformance.test.ts` intent (19 tests combined, per the
  parent project's `postgres-jsonb-storage` change tasks.md — read those
  original test files for exact scenarios covered, don't re-derive from
  scratch) as `test/postgres/temporal-kv.test.ts`, adjusted only for
  `bytea`/`jsonb` syntax differences (no scenario silently dropped).
  **Acceptance:** all ported tests pass; a differential note is written
  for any test whose assertion had to change, explaining why the schema
  difference (not a weaker check) justifies it — same rigor already
  applied by the earlier `design/design.md` §10 discussion of this exact
  risk. **Added by the 2026-07-20 audit:** a literal seven-case `put` CAS
  regression matrix (design.md §4's re-derivation table: omitted/`0n`/`N>0`
  expectedVersion crossed with absent/matching/mismatched current state),
  each case asserting BOTH the return/error value AND that `kv_current`
  and `kv_history` are byte-for-byte unchanged when the case is a failure
  — not just "an error was thrown." Also a hostile-prefix `listKeys` test
  using a prefix containing a literal `%` and `_`, asserting only
  literal-prefix matches are returned (the `LIKE`-escaping fix, design.md
  §4).
- [ ] 1.3 Implement property tests P1-P5 from `Formal/STORAGE_ALGEBRA.md`
  §5 as `test/postgres/temporal-kv.property.test.ts`, using `fast-check`.
  **Acceptance:** all five pass against the real Testcontainers Postgres,
  not a mock — P3 (temporal-projection replay-equivalence) and P4
  (dual-addressing agreement) are the two hardest and most important; if
  either fails, that is a real design or implementation bug to fix, not a
  test to weaken. P1 (Law T1, gapless monotonicity) specifically must
  exercise the UNCONDITIONAL write path (no `expectedVersion`), not just
  the CAS-guarded path 1.1/spec.md's CAS requirement already covers — T1 is
  most at risk exactly where no CAS guard is protecting it (found by
  review: the original draft only tracked T2 in its acceptance criteria and
  silently under-covered T1). **Resolves an earlier tension the audit
  flagged:** `Formal/STORAGE_ALGEBRA.md`'s properties no longer require a
  shared transaction to exercise Law T1 (the "one write per key per
  transaction" rule, `design.md` §2, makes wrapping a same-key sequence in
  one `sql.begin()` meaningless for this purpose anyway) — sequential,
  separately-committed `put` calls are sufficient, so this task does not
  conflict with task 1.6's rule that `opts.tx` must not be passed this
  sprint.
- [ ] 1.4 Confirm whether point-in-time `listKeys` is actually needed
  (`design/design.md` §2 flags this as an open question, deferred to
  implementation time) — check the ported test suite from 1.2 for any
  exercise of this; if none, document the gap as accepted (matching
  `design/design.md` §2's own phrasing) rather than silently ignoring the
  open question. **Acceptance:** a written note (in this file or the
  adapter's own docs) stating explicitly which outcome applies — "exercised
  by test X" or "accepted gap, not required by any ported test" — not left
  implicit.
- [ ] 1.5 Document, in `PgTemporalKV`'s own code comments (not just this
  spec), the `opts.tx` limitation noted in design.md §4 — that
  transaction-participation wiring is deferred until the Transaction/Lease
  module exists — so a future reader of the adapter code sees the
  limitation without having to find this openspec change first.
  **Acceptance:** a doc comment on every method accepting `opts.tx` states
  the limitation, cross-referencing task 1.6 below.
- [ ] 1.6 **(Added by review — closes a real gap the original draft left
  as a code-comment-only tripwire.)** Every `PgTemporalKV` method that
  accepts `opts.tx` MUST throw a dedicated, clearly-named error (e.g.
  `TransactionParticipationNotSupportedError`, distinct from the shared
  `StorageError` subclasses already defined, or a documented reuse of one
  if that fits better) whenever a caller actually passes a `TransactionHandle`
  — silently accepting and ignoring it is not acceptable (design.md §4).
  **Acceptance:** a unit test for each method accepting `opts.tx`
  (`put`/`get`/`getAt`/`listKeys`) asserts that passing any
  non-`undefined` `opts.tx` value throws this specific error, not a
  generic one and not a silent no-op. `specs/temporal-kv/spec.md` gets its
  own Requirement/Scenario for this so it isn't only a task-list item.

## 2. Sprint close-out

- [ ] 2.1 Whole-sprint differential review: an Opus auditor re-reads this
  proposal/design against the actual committed code and confirms every
  "Acceptance" criterion above was actually checked (a CI run passing is
  not sufficient evidence on its own — confirm the specific assertions
  described exist, not just that "tests pass" in aggregate).
- [ ] 2.2 Update `ROADMAP.md`'s Milestone 2 checklist and `design/tasks.md`
  (mark §0/§1 items complete or superseded by this change's more detailed
  breakdown) so the roadmap doesn't drift from what's actually been built.
