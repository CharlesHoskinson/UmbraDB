# temporal-kv (transaction-participation wiring)

Modifies requirements Sprint 1 (`sprint-1-setup-and-temporal-kv`) added to this same capability,
now that `Transaction/Lease` exists and `PgTemporalKV`'s `opts.tx` is wired to it (this change's
`design.md` §4). EARS form as in `specs/transaction-lease/spec.md`.

## MODIFIED Requirements

### Requirement: A caller-supplied transaction handle is honored, not rejected

Supersedes Sprint 1's requirement of the same name (which required rejection, since no
Transaction/Lease implementation existed yet to honor a handle with). WHEN any of
`put`/`get`/`getAt`/`listKeys` is called with a non-`undefined` `opts.tx`, the system SHALL
resolve that handle via `resolveTransaction` and route that method's query through the resulting
connection, so the operation genuinely participates in the caller's transaction. IF the handle
does not resolve (`TransactionHandleInvalidError`, `specs/transaction-lease/spec.md`), THEN the
system SHALL reject with that error before issuing any query.

#### Scenario: Two puts inside one withTransaction either both commit or neither does
- **WHEN** a `withTransaction` callback calls `put(ns, scope, "keyA", v1, {tx: handle})` and
  `put(ns, scope, "keyB", v2, {tx: handle})` using the handle it was given, and then throws
  `Rollback`
- **THEN** neither `keyA` nor `keyB`'s write SHALL be visible after `withTransaction` settles

#### Scenario: Two puts inside one withTransaction both commit together
- **WHEN** the same two `put()` calls as above are made, and the callback returns normally
  instead of throwing
- **THEN** both `keyA` and `keyB`'s writes SHALL be visible after `withTransaction` resolves

#### Scenario: A stale transaction handle is rejected before any query runs
- **WHEN** `put(ns, scope, key, value, {tx: handle})` is called with a `handle` whose
  transaction has already ended
- **THEN** the call SHALL reject with `TransactionHandleInvalidError`
- **AND** SHALL NOT execute any query against the database

## ADDED Requirements

### Requirement: TransactionKeyReuseError is now reachable through the public put() API

Sprint 1 could only exercise `TransactionKeyReuseError` (`UB001`) via a direct, trigger-level SQL
test, since `opts.tx` was rejected outright — see that change's own scope note on this
Requirement, now superseded. WHEN a `withTransaction` callback calls `put()` twice against the
SAME `(ns, scope, key)` using the transaction's handle as `opts.tx`, the system SHALL reject the
second call with `TransactionKeyReuseError`, reachable through the public API without any
trigger-level test scaffolding.

#### Scenario: A second put to the same key in one real transaction rejects through the public API
- **WHEN** a `withTransaction` callback calls `put(ns, scope, key, v1, {tx: handle})` followed
  by `put(ns, scope, key, v2, {tx: handle})`
- **THEN** the second call SHALL reject with `TransactionKeyReuseError`
- **AND** the first `put`'s version SHALL remain the current value after the transaction commits
