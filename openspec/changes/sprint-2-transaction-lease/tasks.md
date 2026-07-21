# Tasks — Sprint 2: Transaction/Lease

Each task: implemented by a Sonnet builder, then reviewed in parallel by
two Opus auditors (spec-compliance against this change's `design.md`;
code quality/docs/test coverage). A task is CLOSED only after both
auditors approve, or their findings are fixed and re-reviewed.

## 0. `PgTransactionLeaseLayer` — transactions

- [x] 0.1 Implement `withTransaction` (design.md §1): `sql.begin()`-based,
  `opts.isolation` mapped to the two-argument `begin(isolationString, cb)`
  overload, `opts.timeoutMs` set via `SET LOCAL statement_timeout` as the
  transaction's first statement using `tx.unsafe(...)` with the
  already-validated integer interpolated directly — NOT postgres.js's
  normal tagged-template parameter binding, which `SET`/`SET LOCAL`
  cannot accept at all (design.md §1's corrected code sample). `Rollback`
  caught and translated to `TransactionRolledBackError`; a `57014`
  (`query_canceled`) while `opts.timeoutMs` was set caught and translated
  to `TransactionFaultError({faultKind: "timeout"})` via the shared
  `isStatementTimeout` helper (design.md §1/§5); everything else routed
  through `translatePostgresError` (including the two new serialization-
  failure/deadlock entries from design.md §5).
  **Acceptance:** (a) a unit test asserts a `fn` that returns a value
  commits and that value is returned; (b) a unit test asserts a `fn` that
  throws `Rollback` results in `TransactionRolledBackError` AND that no
  data written earlier in that same `fn` is visible afterward; (c) a unit
  test asserts a `fn` that throws a plain `Error` propagates that error
  unchanged (not wrapped) AND still rolls back; (d) a unit test sets
  `opts.timeoutMs` to a very small value and a slow query inside `fn`,
  asserting `TransactionFaultError` with `faultKind: "timeout"`; (e) a unit
  test asserts `withTransaction` with an already-aborted `opts.signal`
  rejects with `AbortError` before `fn` is ever invoked; (f) **a unit test
  asserts the OPPOSITE of what an earlier draft of this criterion said**:
  aborting `opts.signal` AFTER `fn` has already started executing has NO
  EFFECT on that call — it proceeds to commit or roll back based on `fn`'s
  own outcome only, and does NOT reject with `AbortError` solely because
  of that abort (design.md §1's pre-check-only contract,
  `specs/transaction-lease/spec.md`'s abort Requirement — an earlier draft
  of this acceptance criterion demanded genuine mid-flight rollback, which
  contradicts both of those and has no implementation mechanism; caught by
  review before implementation started).
- [x] 0.2 Implement the transaction-handle registry (design.md §2):
  `registerTransaction`/`unregisterTransaction` (module-internal),
  `resolveTransaction` (exported), and `TransactionHandleInvalidError`
  added to `src/interfaces/transaction-lease.ts`'s error hierarchy. Also
  update that file's `TransactionOptions.signal` doc to state the
  pre-check-only cancellation contract explicitly (design.md §1), and add
  the nested/recursive `withTransaction` limitation note to
  `withTransaction`'s own JSDoc (design.md §1 — found missing by
  adversarial review: calling `withTransaction` from inside another
  `withTransaction` callback silently starts an unrelated, non-nested
  transaction rather than erroring, and must say so).
  **Acceptance (doc-only, no test):** confirm both doc updates land in the
  same commit as the registry implementation, not deferred.
  **Acceptance:** (a) a unit test resolves a handle DURING its `fn`
  callback and asserts the resolved `sql` actually participates in that
  same transaction (write inside `fn` via the resolved handle, read it
  back inside the SAME `fn` before commit — proving it's really the same
  transaction, not a coincidentally-similar one); (b) a unit test captures
  a handle, lets its transaction commit, then calls `resolveTransaction`
  on the STALE handle afterward and asserts `TransactionHandleInvalidError`
  — this is the sprint's single most important test per design.md's own
  risk note; (c) a unit test fabricates a handle with a random `id` never
  issued by `withTransaction` and asserts the same error.

## 1. `PgTransactionLeaseLayer` — leases

- [x] 1.1 Implement `acquireLease`/`tryAcquireLease` (design.md §3): the
  `sql.reserve()`-pinned two-integer advisory lock (class `2`), the
  `statement_timeout`-based timeout mechanism (raw `.unsafe()` interpolation
  of the validated integer, NOT tagged-template parameter binding — design.md
  §3's corrected code sample), SQLSTATE `57014` detection distinct from
  `57P01`, and the `resetStatementTimeout` pool-poisoning fix on every path
  that returns the reserved connection.
  **Acceptance:** (a) a unit test acquires a lease with no `timeoutMs`,
  then asserts a second `acquireLease` call for the SAME key from a
  different connection blocks (does not resolve) until the first is
  released, then resolves promptly after release; (b) a unit test sets
  `opts.timeoutMs` on a contended key and asserts `LeaseTimeoutError` with
  the correct `key`/`waitedMs` (approximately) after that duration, NOT
  before; (c) a unit test asserts `tryAcquireLease` with no `timeoutMs`
  against a contended key resolves `null` promptly (not after a timeout
  window) via `pg_try_advisory_lock`'s native non-blocking behavior; (d) a
  unit test asserts `tryAcquireLease` WITH `timeoutMs` against a contended
  key resolves `null` (not throw) after that duration; (e) **the
  pool-poisoning regression test**: acquire a lease with `timeoutMs` set,
  let it time out (or release it normally), then issue an unrelated query
  on a FRESH connection from the same pool and assert its own
  `statement_timeout` (`SHOW statement_timeout`) is still the server
  default, not the leased value — this is the one test this project's
  review found completely missing from the original draft, and the whole
  point of the `resetStatementTimeout` fix; (f) a unit test asserts an
  already-aborted `opts.signal` rejects `acquireLease`/`tryAcquireLease`
  with `AbortError` before any connection is reserved; (g) a unit test
  asserts a reservation failure (e.g. pool exhaustion or an unreachable
  database) surfaces as `LeaseFaultError` (`faultKind: "reserve-failed"`);
  (h) **the genuine mid-wait cancellation test** (missing from an earlier
  draft of this criterion, per `specs/transaction-lease/spec.md`'s own
  "Aborting while waiting for a contended lease" Scenario): call
  `acquireLease(key, {signal})` against a key ALREADY held by another
  caller, abort the signal while genuinely still waiting (not
  pre-aborted), and assert the call rejects with `AbortError` via
  `raceAgainstAbort`/`query.cancel()` (design.md §3a) — then assert a
  SUBSEQUENT `acquireLease(key)` by a third caller succeeds once the
  ORIGINAL holder releases (proving the aborted caller's own attempt
  left no advisory lock behind, per the defensive `pg_advisory_unlock`
  in design.md §3's catch block).
- [x] 1.2 Implement `releaseLease` and `withLease` (design.md §3).
  **Acceptance:** (a) a unit test releases a lease and asserts a
  subsequent `acquireLease` for the same key by another caller succeeds
  immediately; (b) a unit test calls `releaseLease` TWICE on the same
  lease object and asserts the second call throws `LeaseNotHeldError`; (c)
  a unit test asserts `withLease` releases the lease even when `fn` throws,
  and that the original error from `fn` (not a release-related error)
  propagates to the caller; (d) a unit test asserts that after a NORMAL
  `releaseLease` (no timeout involved), the released connection's
  `statement_timeout` was never touched in the first place (the `hadTimeout`
  guard in `resetStatementTimeout` — a lease acquired with no `timeoutMs`
  has nothing to reset, and the reset call must not run needlessly).
- [x] 1.3 Implement P10 (`Formal/STORAGE_ALGEBRA.md` §5) as
  `test/postgres/transaction-lease.property.test.ts`: concurrent
  `withLease` calls on one key from multiple independent connections,
  asserting an instrumented critical section (e.g. a shared counter
  incremented/decremented around the critical section, asserted never to
  exceed 1) never observes overlap.

## 2. Wire `PgTemporalKV`'s `opts.tx`

- [x] 2.1 Replace all four `assertNoTx`/`TransactionParticipationNotSupportedError`
  throws in `src/postgres/temporal-kv.ts` with `resolveTransaction`-based
  routing (design.md §4). Delete `TransactionParticipationNotSupportedError`
  once nothing throws it.
  **Acceptance:** (a) a unit test performs two `put()` calls to DIFFERENT
  keys inside one `withTransaction` callback (using the yielded handle as
  `opts.tx` for both), then throws `Rollback`, and asserts NEITHER write
  is visible afterward (proving both actually joined the same transaction,
  not two separate autocommit writes that happened to both occur inside
  the callback's synchronous extent); (b) the equivalent positive case —
  same two `put()` calls, callback returns normally, both writes ARE
  visible after commit.
- [x] 2.2 This change's own `specs/temporal-kv/spec.md` (a `## MODIFIED
  Requirements` addendum to the same capability Sprint 1 specified)
  supersedes Sprint 1's "A caller-supplied transaction handle is honored
  or rejected, never silently ignored" Requirement with one that no
  longer describes a rejection. Sprint 1 has been merged and archived
  (`openspec/specs/temporal-kv/spec.md`); `openspec validate --strict`
  confirmed against that real baseline.
- [x] 2.3 Add the public-API-level `TransactionKeyReuseError` scenario
  design.md §4 notes is now reachable: two `put()` calls to the SAME key
  inside one `withTransaction` callback, asserting `TransactionKeyReuseError`
  (not just the trigger-level SQLSTATE test Sprint 1 already has).

## 3. Sprint close-out

- [x] 3.1 Whole-sprint differential review: a single review pass (not a
  multi-agent panel — this project deliberately scaled back review-cycle
  overhead for this sprint) re-read this proposal/design against the
  actual committed code and confirmed every "Acceptance" criterion above
  was actually checked. Found and fixed: `releaseLease` silently
  swallowing connection-loss instead of surfacing `LeaseFaultError`
  (contradicted its own spec Requirement — fixed, tested); the two
  40001/40P01 error-translation entries were completely untested (added
  real serialization-failure and deadlock tests — which in turn caught a
  genuine, previously-undetected production bug: `opts.isolation` was
  missing the required `ISOLATION LEVEL` prefix in the `BEGIN` statement,
  a real Postgres syntax error no earlier test had ever exercised); an
  overclaiming "release failures are logged" doc that was never actually
  implementable (this project has no logging infrastructure) — corrected
  to state they're swallowed instead.
- [x] 3.2 Update `ROADMAP.md`'s Milestone 2 checklist to reflect
  Transaction/Lease's completion, and update `design/tasks.md`'s
  supersession note (see the separate `design/tasks.md` cleanup tracked
  outside this change) so the roadmap doesn't drift from what's actually
  been built.
- [x] 3.3 Second review round (Opus + Codex GPT-5.6 + Fable 5, run in
  parallel — the panel-cycle style, resumed after 3.1's single-pass
  experiment, since this round found real bugs a single pass had missed).
  Found and fixed: **Blocker-adjacent** `raceAgainstAbort` had no entry
  check for an already-aborted `signal` (two independent reviewers found
  this) — an abort landing in the real `await` gaps before it was called
  (`sql.reserve()`, `SET statement_timeout`) was silently lost, hanging a
  no-timeout `acquireLease` forever against a contended key and leaking
  the pinned connection; **High** a query-win/abort race at the exact
  instant `pg_advisory_lock` grants could take the success path despite
  the caller having aborted (added a post-grant re-check); **High**
  `sql.reserve()` itself had no timeout/abort/nonblocking awareness at
  all, only the advisory-lock wait after a connection was already in hand
  (added `reserveBounded`, with orphaned-connection cleanup if the
  bail-branch wins after `reserve()` already resolved); **High**
  `isPgDriverError` classified ANY `Error` with a string `.code` as a
  driver error, so an arbitrary application error thrown by `fn` (a Node
  built-in, a caller's own business-error convention) would be
  misclassified and, for an unenumerated code, silently relabeled
  `UnrecognizedPostgresError` — violating `withTransaction`'s own
  documented "propagates unchanged" contract (fixed by additionally
  requiring `.severity`, which every genuine Postgres wire-protocol error
  carries); **Medium** `withTransaction`'s connection-loss path
  contradicted its own interface doc (`ConnectionError` instead of
  `TransactionFaultError`); **Medium** `timeoutMs` schemas accepted values
  above Postgres's `int4` max; **Low** `LeaseNotHeldError`'s doc (three
  places) and a `spec.md` Requirement still claimed "or its connection
  already closed," directly contradicting the connection-loss Requirement
  fixed in 3.1; **Low** several doc/code-count staleness spots in
  `design.md` and `design/design-interfaces.md` (a historical doc,
  annotated rather than rewritten). All fixes covered by new or
  strengthened tests; full suite green (83/83) after this round.
