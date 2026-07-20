# Tasks — Sprint 2: Transaction/Lease

Each task: implemented by a Sonnet builder, then reviewed in parallel by
two Opus auditors (spec-compliance against this change's `design.md`;
code quality/docs/test coverage). A task is CLOSED only after both
auditors approve, or their findings are fixed and re-reviewed.

## 0. `PgTransactionLeaseLayer` — transactions

- [ ] 0.1 Implement `withTransaction` (design.md §1): `sql.begin()`-based,
  `opts.isolation` mapped to the two-argument `begin(isolationString, cb)`
  overload, `opts.timeoutMs` set via `SET LOCAL statement_timeout` as the
  transaction's first statement, `Rollback` caught and translated to
  `TransactionRolledBackError`, everything else routed through
  `translatePostgresError` (including the two new serialization-
  failure/deadlock entries from design.md §5).
  **Acceptance:** (a) a unit test asserts a `fn` that returns a value
  commits and that value is returned; (b) a unit test asserts a `fn` that
  throws `Rollback` results in `TransactionRolledBackError` AND that no
  data written earlier in that same `fn` is visible afterward; (c) a unit
  test asserts a `fn` that throws a plain `Error` propagates that error
  unchanged (not wrapped) AND still rolls back; (d) a unit test sets
  `opts.timeoutMs` to a very small value and a slow query inside `fn`,
  asserting `TransactionFaultError` with `faultKind: "timeout"`.
- [ ] 0.2 Implement the transaction-handle registry (design.md §2):
  `registerTransaction`/`unregisterTransaction` (module-internal),
  `resolveTransaction` (exported), and `TransactionHandleInvalidError`
  added to `src/interfaces/transaction-lease.ts`'s error hierarchy.
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

- [ ] 1.1 Implement `acquireLease`/`tryAcquireLease` (design.md §3): the
  `sql.reserve()`-pinned two-integer advisory lock (class `2`), the
  `statement_timeout`-based timeout mechanism, SQLSTATE `57014` detection
  distinct from `57P01`.
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
  key resolves `null` (not throw) after that duration.
- [ ] 1.2 Implement `releaseLease` and `withLease` (design.md §3).
  **Acceptance:** (a) a unit test releases a lease and asserts a
  subsequent `acquireLease` for the same key by another caller succeeds
  immediately; (b) a unit test calls `releaseLease` TWICE on the same
  lease object and asserts the second call throws `LeaseNotHeldError`; (c)
  a unit test asserts `withLease` releases the lease even when `fn` throws,
  and that the original error from `fn` (not a release-related error)
  propagates to the caller.
- [ ] 1.3 Implement P10 (`Formal/STORAGE_ALGEBRA.md` §5) as
  `test/postgres/transaction-lease.property.test.ts`: concurrent
  `withLease` calls on one key from multiple independent connections,
  asserting an instrumented critical section (e.g. a shared counter
  incremented/decremented around the critical section, asserted never to
  exceed 1) never observes overlap.

## 2. Wire `PgTemporalKV`'s `opts.tx`

- [ ] 2.1 Replace all four `assertNoTx`/`TransactionParticipationNotSupportedError`
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
- [ ] 2.2 This change's own `specs/temporal-kv/spec.md` (a `## MODIFIED
  Requirements` addendum to the same capability Sprint 1 specified)
  supersedes Sprint 1's "A caller-supplied transaction handle is honored
  or rejected, never silently ignored" Requirement with one that no
  longer describes a rejection — confirm `openspec validate --strict`
  accepts this addendum against the archived Sprint 1 spec once Sprint 1
  is archived.
- [ ] 2.3 Add the public-API-level `TransactionKeyReuseError` scenario
  design.md §4 notes is now reachable: two `put()` calls to the SAME key
  inside one `withTransaction` callback, asserting `TransactionKeyReuseError`
  (not just the trigger-level SQLSTATE test Sprint 1 already has).

## 3. Sprint close-out

- [ ] 3.1 Whole-sprint differential review: an Opus auditor re-reads this
  proposal/design against the actual committed code and confirms every
  "Acceptance" criterion above was actually checked — matching Sprint 1's
  task 2.1's own standard (a passing CI run is not sufficient evidence on
  its own).
- [ ] 3.2 Update `ROADMAP.md`'s Milestone 2 checklist to reflect
  Transaction/Lease's completion, and update `design/tasks.md`'s
  supersession note (see the separate `design/tasks.md` cleanup tracked
  outside this change) so the roadmap doesn't drift from what's actually
  been built.
