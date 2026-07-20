# Proposal — Sprint 2: Transaction/Lease

## Why

Sprint 1 (`openspec/changes/sprint-1-setup-and-temporal-kv`) shipped `PgTemporalKV` with a
deliberate, loud gap: every method that accepts `opts.tx` throws
`TransactionParticipationNotSupportedError` before running any query, because no real
implementation of `src/interfaces/transaction-lease.ts` existed yet to wire it to. That gap is
tracked in Sprint 1's own `tasks.md` task 1.6 and `specs/temporal-kv/spec.md` as "deferred until
the Transaction/Lease module exists (later sprint)." This is that sprint.

`Formal/STORAGE_ALGEBRA.md` §4 (Law L1, mutual exclusion) and `design/design.md` §5 (the
corrected writer-lease design — `sql.reserve()`-pinned advisory locks after a real connection-
pool-pinning bug was found and fixed before any code existed) already specify the algebra and the
Postgres mechanism. This sprint turns that into a real, tested `PgTransactionLeaseLayer`
implementing `src/interfaces/transaction-lease.ts`, and — because leaving `opts.tx` unwired once
this module exists would just relocate Sprint 1's loud gap rather than close it — wires
`PgTemporalKV`'s `opts.tx` parameter through to real transaction participation as part of this
same sprint, replacing every `TransactionParticipationNotSupportedError` throw with actual
behavior.

## What changes

1. **`PgTransactionLeaseLayer`** (`src/postgres/transaction-lease.ts`): `withTransaction` via
   `sql.begin()`; `acquireLease`/`tryAcquireLease`/`releaseLease`/`withLease` via
   `sql.reserve()`-pinned two-integer advisory locks (`pg_advisory_lock(2, hashtext(key))` — class
   `2`, reserved and distinct from Sprint 1 migration runner's class `1`, per `design/design.md`
   §5's collision-avoidance fix).
2. **A shared transaction-handle registry**: `TransactionHandle` (the opaque type every module's
   `opts.tx` parameter already accepts) needs to resolve, inside a DIFFERENT module's adapter
   (e.g. `PgTemporalKV`), to the actual `postgres.js` transaction-scoped `sql` callback created by
   `PgTransactionLeaseLayer.withTransaction`. This sprint's `design.md` specifies exactly how that
   resolution works (a module-scoped registry keyed by the handle's opaque `id`) since no existing
   document had settled this — it's the one genuinely new design question this sprint answers,
   not just an implementation of an already-fully-specified interface.
3. **Wiring `PgTemporalKV`'s `opts.tx`**: replace the four
   `TransactionParticipationNotSupportedError` throws (`put`/`get`/`getAt`/`listKeys`) with real
   resolution through the registry in (2), so a caller-supplied transaction handle actually routes
   that method's query through the caller's transaction. `TransactionParticipationNotSupportedError`
   itself is removed once nothing throws it.
4. Lease-specific error translation added to `src/postgres/errors.ts`: a `statement_timeout`
   cancellation (SQLSTATE `57014`) on a lock-acquisition connection → `LeaseTimeoutError`; a
   connection failure during `sql.reserve()` or while a lease connection is held →
   `LeaseFaultError`.

## Non-goals (explicitly out of scope for this sprint)

- CheckpointStore and Watermarks implementations — later sprints, each getting the same
  proposal→design→tasks→spec→review treatment, matching Sprint 1's own stated non-goals.
- Wiring `opts.tx` into CheckpointStore or Watermarks — neither exists as a Postgres adapter yet;
  the registry this sprint builds is designed to be reusable by them when their own sprints land,
  but actually wiring them is those sprints' work, not this one's.
- Multi-process/crash-recovery lease semantics (fencing tokens, TTL, takeover) — deliberately
  removed from the interface already (`src/interfaces/transaction-lease.ts`'s own revision note,
  `Formal/STORAGE_ALGEBRA.md` §4 Law L1); not reopened here.
- `midnight-dev-env` integration/cutover work — out of this repo's scope entirely, per Sprint 1's
  identical non-goal.

## Impact

- **New in this repo**: `src/postgres/transaction-lease.ts` (the adapter + the shared handle
  registry), a `test/postgres/transaction-lease.test.ts` and
  `test/postgres/transaction-lease.property.test.ts` (P10 from `Formal/STORAGE_ALGEBRA.md` §5).
- **Changed in this repo**: `src/postgres/temporal-kv.ts` (opts.tx wiring),
  `src/postgres/errors.ts` (two new translation-table entries),
  `test/postgres/temporal-kv.test.ts` (the opts.tx-rejection tests become opts.tx-participation
  tests — a real transaction, not a rejection, is now the thing under test).
- **Risk**: the handle-registry design (item 2 above) is the sprint's hardest correctness bar — a
  registry that leaks entries (a `withTransaction` callback that never resolves) or resolves a
  stale/foreign handle to the wrong connection would silently corrupt cross-module atomicity. This
  gets the same adversarial review treatment Sprint 1's CAS-guard bug and this project's
  Codex-audited `now()`/transaction-time bug both got before any implementation started.
- **Delivery**: this proposal/design/tasks/spec drafted and reviewed (3-agent Opus panel + Fable 5
  consolidation, then a Codex GPT-5.6 Sol audit) before any code, matching Sprint 1's process
  exactly. Implementation then follows: Sonnet builder, two parallel Opus auditors per task
  (spec-compliance; code quality/docs/test coverage).
