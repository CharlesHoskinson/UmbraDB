# Tasks — v1.0.0-durable-checkpoint-cursor

Each task: implemented by a builder, then reviewed in parallel by two Opus auditors
(spec-compliance against this change's `design.md` + `specs/durable-composition/spec.md`; code
quality/docs/test coverage). A task is CLOSED only after both auditors approve, or their findings are
fixed and re-reviewed. Matches the Sprint 1–4 review cadence.

**Critical-path ordering (from `ROADMAP-v1.0.0-CONSOLIDATED.md` §"Critical path" and
`council/A-release-scope.md` §5):** this whole change is Phase 1 (API-affecting, **pre-freeze**).
Within it: **G5 first** (it changes `save`'s signature and unblocks the T5 crash test owned by the
testing-gate change), then **G6/G7/G8** (durability probe, timeouts, contract fixes — parallelizable
among themselves). None of the G6/G7/G8 tasks may re-open `save`'s signature after G5 closes.

Each task names the requirement(s) it satisfies by their spec heading.

## 0. G5 — Co-transactional watermark + checkpoint data (do first; pre-freeze, signature-changing)

- [x] 0.1 Add `tx?: TransactionHandle` to `PgCheckpointStore.save`'s options and thread it through
  `saveImpl` (`design.md` §1.2): when `opts.tx` is present, resolve it via `resolveTransaction` and
  run all statements on that transaction; when absent, keep the existing internal `withTransaction`
  path byte-for-byte. Rewrite the `src/interfaces/checkpoint-store.ts:135` "deliberately do NOT accept
  a `tx`" doc to the new contract. **Satisfies:** _save accepts and joins a caller-supplied
  transaction handle_. **Depends on:** nothing — do first. **Acceptance:** `tsc --noEmit` passes with
  `PgCheckpointStore implements CheckpointStore`; a test saves on a caller transaction, commits, and
  confirms the checkpoint `load`s (scenario "checkpoint saved on a caller transaction commits with
  it"); a test saves on a caller transaction, rolls it back, and confirms no manifest/junction/
  `complete=true` row is visible (scenario "…rolls back leaves no trace"); a test passes a stale and a
  fabricated handle and confirms `TransactionHandleInvalidError` with **no statement issued** (assert
  via a query-counting spy on the pool, or record the limitation in the test comment per Sprint 4's
  task 1.1 convention); a test confirms the no-`tx` path returns the same `CheckpointSummary` shape as
  before (regression against the existing save tests).

- [x] 0.2 Implement the `saveAndAdvance` combinator in a new `src/postgres/save-and-advance.ts`
  (`design.md` §1.3): opens one `withTransaction`, calls `save` with the tx and `watermarks.set` with
  the same tx, composing only in-repo primitives (no consumer/indexer import). **Satisfies:**
  _saveAndAdvance co-commits a checkpoint and its sync cursor atomically_. **Depends on:** 0.1.
  **Acceptance:** a test runs `saveAndAdvance` to success and confirms both `load` returns the
  checkpoint and `watermarks.get` returns the cursor value (scenario "successful saveAndAdvance makes
  both durable together"); a test forces the combinator's transaction to roll back (inject a failure
  after `save` but before commit) and confirms **neither** the checkpoint nor the advanced cursor is
  durable and the prior cursor still points at prior durable data (scenario "crash before the single
  commit leaves neither"); a static check / import-lint confirms `save-and-advance.ts` imports no
  consumer/indexer module (indexer-agnostic boundary, `council/A-release-scope.md` ruling b).

- [x] 0.3 Write the ordering + replay contract into the checkpoint-store contract docs and
  cross-reference it from `Formal/STORAGE_ALGEBRA.md` W1 (`design.md` §1.4): cursor strictly after
  data commit for manual composition; watermark-behind recovery; replay convergence judged on current
  state. **Satisfies:** _a conforming composition keeps the durable cursor from ever being ahead of
  durable checkpoint data_ (its documentation scenarios). **Depends on:** 0.1, 0.2. **Acceptance:** the doc states the
  cursor-strictly-after-data ordering rule and the current-state replay contract explicitly and cites
  `STORAGE_ALGEBRA.md` W1 (scenario "the ordering and replay contract is a checkable documentation
  artifact"); an auditor confirms the wording matches the spec requirement, not a weaker paraphrase.

- [x] 0.4 Property test for the cursor-never-ahead invariant under the ordering contract, fault-free
  (`design.md` §1.4). **Satisfies:** _a conforming composition keeps the durable cursor from ever
  being ahead of durable checkpoint data_. **Depends on:** 0.2. **Acceptance:** a `fast-check`
  property drives randomized interleavings of **both** (a) `saveAndAdvance` calls **and** (b) the
  manual safe-ordering composition (commit the checkpoint data transaction, then advance the cursor in
  a separate transaction) and asserts that at every observed durable state the cursor references a
  checkpoint that exists (never one that is absent), and that resume-from-cursor reproduces the
  reference **current** state (spec scenario "the fault-free property holds for both composition
  forms"). Covering the manual composition here — not only `saveAndAdvance` — is required so the spec's
  manual-composition scenario has in-change coverage of its non-crash half (Fable Finding 4). Note in
  the test that the *crash-level* proof (kill between data and cursor, `synchronous_commit` on AND off)
  is T5, owned by the testing-gate change and depending on this task's API (handoff A11) — not
  re-proven here.

## 1. G6 — Durability startup probe + binding contract

- [x] 1.1 Implement `probeDurability(sql, opts?)` in a new `src/postgres/durability-probe.ts` and wire
  it as a **mandatory step of `runMigrations`** (`design.md` §2.1/§2.2): `SHOW` `fsync` (refuse on
  `off`), `synchronous_commit` (typed lost-tail warning on `off` **only**; no warning for
  `local`/`remote_write`/`remote_apply`/`on`, which are crash-durable on a primary), `full_page_writes`
  (refuse by default on `off`, overridable); return a typed `DurabilityWarning[]` and throw a typed
  `DurabilityContractError` on a hard violation so `runMigrations` rejects before running any
  migration. `probeDurability` also remains directly callable. **There is no "documented pre-first-use
  step" escape hatch** — the invocation point is fixed at `runMigrations` so the probe is
  non-skippable (Fable Finding 3 / Opus B2); a probe a consumer can forget to call is not a guarantee.
  **Satisfies:** _a durability probe asserts the server's crash-safety settings at client bootstrap_.
  **Depends on:** none (parallel with G5). **Acceptance:** unit tests against a Testcontainers Postgres
  started with `fsync=off` assert `runMigrations` rejects with the typed error having run no migration
  (scenario "fsync=off makes runMigrations reject before any migration runs"); with
  `synchronous_commit=off` assert a typed lost-tail warning and no refusal (scenario
  "synchronous_commit=off is warned, not refused"); with `synchronous_commit=local` (and
  `remote_write`/`remote_apply`) assert **no** lost-tail warning and that `runMigrations` proceeds
  (scenario "a standby-oriented synchronous_commit is treated as durable, not warned"); with
  `full_page_writes=off` and no override assert `runMigrations` rejects (scenario
  "full_page_writes=off is refused by default"); a healthy default server yields no hard violation and
  `runMigrations` proceeds.

- [x] 1.2 Implement transaction-pooler detection inside the probe (`design.md` §2.3): acquire a
  session advisory lock, then confirm in a follow-up query it is visible in `pg_locks` on the same
  session; if not visible, make `runMigrations` reject with a typed error. **Satisfies:** _a
  transaction-pooling proxy is detected and refused_. **Depends on:** 1.1. **Acceptance:** a test
  against a direct/session-mode connection confirms the follow-up query observes the lock and the check
  passes (scenario "direct connection passes"); a test simulating pooler behaviour (e.g. issuing the
  follow-up on a different backend, or a documented harness that reproduces the invisibility) confirms
  `runMigrations` rejects with a typed error naming the pooler hazard, having run no migration
  (scenario "session advisory-lock invisibility on follow-up fails fast"). If a faithful
  transaction-pooler harness is
  impractical in CI, record the limitation in the test comment and assert the invisibility branch via
  a direct unit-level injection of the "lock not visible" condition.

- [x] 1.3 Author `docs/durability-contract.md` (`design.md` §2.4): the binding Postgres-config
  precondition — `fsync=on`, `full_page_writes=on`, `synchronous_commit` semantics, session-mode
  pooling only, the three server-side timeouts — stating which items the probe enforces vs.
  documents. **Satisfies:** _the required Postgres configuration is published as a binding Durability
  Contract_. **Depends on:** 1.1, 1.2, and G7 task 2.1 (for the timeout values). **Acceptance:** the
  doc names every setting in the requirement's scenario and correctly labels each as probe-enforced or
  documented-only; an auditor cross-checks each "enforced" claim against the actual probe code (no
  doc/behaviour drift).

## 2. G7 — Server-side timeouts

- [x] 2.1 Add `statement_timeout`, `lock_timeout`, and `idle_in_transaction_session_timeout` to
  `client.ts`'s `options.connection`, with conservative documented defaults and per-option overrides
  on `UmbraDBConnectionOptions` (`design.md` §3.1). **Satisfies:** _the UmbraDB connection sets
  bounded server-side timeouts by default_. **Depends on:** none (parallel with G5/G6).
  **Acceptance:** a test creates a default client and `SHOW`s each of the three settings, asserting a
  non-zero configured default (scenario "three timeouts are set on a fresh connection"); a test with
  explicit overrides asserts each `SHOW` reports the override (scenario "caller can override each
  timeout default"); a test acquires and releases a lease that set its own `statement_timeout` and
  confirms the reserved connection's `statement_timeout` returns to the **connection default**, not
  `0` and not the lease TTL (scenario "lease path restores the connection timeout default, not zero"),
  verifying the reset interaction at `transaction-lease.ts:183`; a test creates a client with
  `idle_in_transaction_session_timeout` raised via `UmbraDBConnectionOptions` and `SHOW`s it on a
  connection to confirm the raised value is in effect, so a legitimate long in-transaction workload is
  not bounded by the shorter default (scenario "a raised idle-in-transaction default is honoured for a
  long in-transaction workload"; Opus N3 — the lease/`withTransaction` idle-in-tx interaction).

- [x] 2.2 Bound the class-1 migration advisory-lock acquire in `migrate.ts` (`design.md` §3.2):
  wrap the blocking `pg_advisory_lock(1, hashtext(schema))` acquire with a bounded mechanism —
  `lock_timeout`, a scoped `statement_timeout`, or a `pg_try_advisory_lock` deadline poll (all three
  are verified to abort a blocked advisory-lock acquisition, `design.md` §3.2) — translate the timeout
  SQLSTATE into a typed migration-lock-timeout error, and restore any prior session-level timeout
  immediately after acquiring. **Satisfies:** _migration advisory-lock acquisition is bounded and
  fails fast_. **Depends on:** none (independent of 2.1, but coordinate the timeout constant).
  **Acceptance:** a test holds the class-1 lock for a schema from a first session, invokes
  `runMigrations` for the same schema from a second session, and asserts a fast typed timeout within
  the bound rather than an indefinite hang (scenario "held migration lock makes a second runMigrations
  fail fast" — the roadmap's T8); a test confirms that a successful acquire restores the prior timeout
  so the migration DDL itself is not subject to the short acquire bound (scenario "acquire timeout is
  scoped and restored"). **Do NOT record any claim that `lock_timeout` cannot abort an advisory-lock
  acquisition** — that is empirically false (reproduced on PostgreSQL 16.14, `design.md` §3.2/§6.1);
  the earlier draft's mandate to comment it has been removed. The mechanism is an implementation choice
  proven by the fail-fast test, not a fixed knob.

## 3. G8 — Contract-integrity fixes

- [x] 3.1 Validate `walletId`/`networkId` at all four `PgCheckpointStore` entry points
  (`save`/`load`/`history`/`prune`) with a shared identifier schema
  (`z.string().min(1).max(...).refine(!hasPostgresUnsafeText)`) defined in
  `src/interfaces/checkpoint-store.ts`, rejecting with `ValidationError` before any statement
  (`design.md` §4.1). Mirror `src/interfaces/wallet-state-envelope.ts:81-82`'s existing pattern for
  the same two ids. **Satisfies:** _PgCheckpointStore validates walletId and networkId at every entry
  point_. **Depends on:** 0.1 (so the `save` signature is final first). **Acceptance:** for each of
  the four methods, a test passes a NUL-containing (and separately a lone-surrogate) id and asserts
  `ValidationError` — specifically NOT `UnrecognizedPostgresError` or a raw driver error — with **no
  statement issued** (query-counting spy, or documented limitation per task 0.1's convention); a test
  passes an over-length id and asserts `ValidationError` before any statement; a regression test
  confirms a well-formed id path is unchanged for all four methods.

- [x] 3.2 Add a depth bound to `JsonValueSchema` by reusing `exceedsMaxDepth` (`design.md` §4.2):
  hoist the iterative `exceedsMaxDepth` guard and its depth constant out of
  `transaction-history-storage.ts` into `temporal-kv.ts` (or a shared json-util module) with no import
  cycle, have `transaction-history-storage.ts` import it (behaviour there unchanged), and wrap
  `JsonValueSchema` in a `z.preprocess` depth guard that runs BEFORE `z.json()`'s recursive parse.
  Use one shared depth constant (equal to the existing `64`). **Satisfies:** _JsonValueSchema rejects
  values exceeding the maximum nesting depth_. **Depends on:** none (parallel).
  **Acceptance:** a test calls `PgTemporalKV.put` with an over-deep value and asserts `ValidationError`
  before any statement, with no stack overflow (scenario "over-deep value passed to put is rejected");
  a test calls `PgWatermarks.set` with an over-deep value and asserts the same, proving the shared
  bound applies to both (scenario "over-deep value passed to set is rejected identically"); a test
  with a value at exactly the bound asserts it passes (scenario "a value at or under the bound is
  accepted"); the existing `transaction-history-storage` `sections` depth tests still pass unchanged
  after the hoist (regression).

- [x] 3.3 Make `withLease` surface release failures instead of swallowing them (`design.md` §4.3):
  replace the `.catch(() => {})` at `transaction-lease.ts:412` with the **pinned** surfacing contract
  (Fable Finding 2 / Opus N5 — the option shape is frozen at G1, so it is decided here, not left
  either/or). Add `opts.onReleaseFault?: (err: unknown) => void` to `LeaseAcquireOptions`
  (`interfaces/transaction-lease.ts:179`). When `fn` **succeeded** and release fails: WHERE
  `onReleaseFault` is supplied, invoke it with the `LeaseFaultError` and resolve with `fn`'s value;
  WHERE it is **not** supplied (the default), **reject** with the `LeaseFaultError`. When `fn`
  **threw**, keep `fn`'s error as the primary rejection but still surface the release fault (via
  `onReleaseFault` if supplied, else attach it as `cause`/aggregated error). Update the `withLease`
  interface doc from the "swallowed, no logging infrastructure" wording to this contract. **Satisfies:**
  _withLease surfaces a lease-release failure instead of swallowing it_. **Depends on:** none
  (parallel). **Acceptance:** a test where `fn` succeeds, **no** `onReleaseFault` is supplied, and
  release fails (inject a `LeaseFaultError("connection-lost")` from `releaseLease`, e.g. by
  killing/faulting the reserved connection) asserts `withLease` **rejects** with the fault (scenario "a
  release failure after a successful fn, with no callback, rejects"); a test with `onReleaseFault`
  supplied asserts the callback is invoked and `withLease` resolves with `fn`'s value (scenario "…with
  a callback, resolves and reports"); a test where `fn` throws AND release fails asserts `fn`'s error
  is the primary rejection and the release fault is still surfaced (scenario "fn's own error stays
  primary while a release failure is still surfaced"); a test with a clean release asserts `withLease`
  resolves with `fn`'s return value and surfaces no fault (scenario "a clean release is unaffected").

## 4. Change close-out

- [x] 4.1 Whole-change differential review: an Opus auditor re-reads this proposal/design/spec against
  the actual committed code and confirms every "Acceptance" criterion above was actually checked — a
  CI run passing is not sufficient evidence on its own, per every prior sprint's close-out standard.
  Confirm explicitly that the four non-goals were honoured in code: no `idempotency_key`/UNIQUE added
  to `save`; no lease write-routing/fencing-token change (only the swallow fixed); no perf/benchmark
  work; no consumer/indexer import.

- [x] 4.2 Confirm the pre-freeze sequencing obligation is met: `save`'s final signature (0.1) and the
  `withLease` option shape (3.3) are settled and recorded so the API-surface freeze change (`G1`) can
  export them without a later breaking change (`council/A-release-scope.md` §5 Phase 1 → Phase 2).
  Record the T5 (cursor-durability crash) and T12 (durability-probe) dependencies as handoffs to the
  testing-gate change (`G9`–`G12`), noting both now have the API they require.

- [x] 4.3 Per this repo's `CLAUDE.md`: re-run `graphify --update` against the repo root and commit the
  refreshed `graphify-out/` outputs in this close-out commit, so the knowledge graph does not silently
  drift stale behind this change's new code and openspec change.
