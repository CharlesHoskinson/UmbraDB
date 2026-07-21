# watermarks (implementation)

The Postgres-backed implementation of `src/interfaces/watermarks.ts`. Extends (does not replace)
the interface-level requirements already implied by that file's own TSDoc contract.

## ADDED Requirements

### Requirement: set rejects an invalid value with ValidationError before any statement

`PgWatermarks.set` SHALL validate `value` against `WatermarkValueSchema` and, when validation
fails, SHALL reject with `ValidationError` before issuing any database statement.

#### Scenario: A value that fails WatermarkValueSchema is rejected with no statement issued
- **WHEN** `set` is called with a `value` that fails `WatermarkValueSchema` (e.g. containing a
  `bigint`, `undefined`, or a JavaScript `Date` instance nested inside it)
- **THEN** the call SHALL reject with `ValidationError`
- **AND** no row in `watermarks` SHALL be inserted or updated as a result

### Requirement: set is an idempotent, unconditional overwrite (Law W1)

`PgWatermarks.set(kind, key, value)` SHALL upsert the watermark for `(kind, key)` to `value`
unconditionally — no version check, no history retained — such that setting the same value twice
in succession is indistinguishable from setting it once, and setting a new value always succeeds
regardless of what was previously stored.

#### Scenario: Setting the same value twice leaves the stored state unchanged
- **WHEN** `set(kind, key, v)` is called, and then `set(kind, key, v)` is called again with the
  identical value
- **THEN** `get(kind, key)` SHALL return `v` after either call, indistinguishably
- **AND** exactly one row SHALL exist in `watermarks` for `(kind, key)`, not one per call

#### Scenario: A new set always overwrites, with no conflict possible
- **WHEN** `set(kind, key, v1)` has already committed, and `set(kind, key, v2)` is then called
  with a different value and no compare-and-set option (none exists on this interface)
- **THEN** the second call SHALL succeed unconditionally
- **AND** `get(kind, key)` SHALL return `v2` afterward, with no error and no trace of `v1`
  retained anywhere in this store

### Requirement: get never throws for an unset cursor

`PgWatermarks.get` SHALL resolve `undefined` when no watermark has ever been set for `(kind,
key)`, and SHALL NOT reject in that case.

#### Scenario: get on a never-set (kind, key) resolves undefined, not an error
- **WHEN** `get` is called for a `(kind, key)` pair that has never been passed to `set`
- **THEN** the call SHALL resolve with `undefined`
- **AND** SHALL NOT reject

### Requirement: get returns exactly the last value set, scoped per (kind, key)

`PgWatermarks.get(kind, key)` SHALL return the value from the most recent successful `set` call
for that exact `(kind, key)` pair, and SHALL NOT be affected by `set` calls to a different `kind`
or a different `key`.

#### Scenario: get reflects the most recent set among several
- **WHEN** `set(kind, key, v1)`, then `set(kind, key, v2)`, then `set(kind, key, v3)` are called in
  sequence
- **THEN** `get(kind, key)` SHALL return `v3`

#### Scenario: A different kind or key is never affected by an unrelated set
- **WHEN** `set(kindA, keyA, vA)` is called, and separately `set(kindB, keyA, vB)` and
  `set(kindA, keyB, vC)` are also called
- **THEN** `get(kindA, keyA)` SHALL return `vA`, unaffected by either of the other two calls

### Requirement: a caller-supplied transaction handle is honored, not silently ignored

`PgWatermarks.set` and `get` SHALL, when given a non-`undefined` `opts.tx`, resolve it via the
shared transaction-handle registry and issue their statement against that transaction-scoped
connection rather than the pooled connection — participating in the caller's ambient transaction
exactly as `TemporalKV`'s equivalent methods already do.

#### Scenario: A set issued inside a caller's transaction is visible to a get using the same handle before commit
- **WHEN** a transaction is opened via `TransactionLeaseLayer.withTransaction`, and `set` is
  called with that transaction's handle as `opts.tx`, and `get` is then called with the same
  handle before the transaction commits
- **THEN** `get` SHALL return the value just set, visible within that same in-flight transaction

#### Scenario: A set rolled back with its transaction is not visible afterward
- **WHEN** `set` is called with `opts.tx` set to a handle for a transaction that is later rolled
  back (not committed)
- **THEN** a subsequent `get` for that same `(kind, key)`, outside that transaction, SHALL NOT
  reflect the rolled-back value

### Requirement: an already-aborted opts.signal rejects before any statement; a later abort has no effect

`PgWatermarks.set` and `get` SHALL each reject with `AbortError` — before issuing any statement —
when their `opts.signal` is already aborted at call time. A signal that aborts after the call has
already begun SHALL have no effect: the call SHALL proceed to its ordinary outcome, matching the
pre-check-only `withAbort` contract this module shares with `PgTemporalKV.get`/`put`
(`sprint-3-checkpoint-store/design.md` §8's corrected description of that same contract).

#### Scenario: An already-aborted signal rejects before any database work
- **WHEN** `set` or `get` is called with an `opts.signal` that is already aborted
- **THEN** the call SHALL reject with `AbortError`
- **AND** no database statement SHALL have been issued by that call

#### Scenario: A signal aborting after the call has begun does not interrupt it
- **WHEN** `set`'s `opts.signal` is aborted after the call has already begun (its statement
  already dispatched)
- **THEN** the call SHALL complete its ordinary outcome (the value is persisted) unaffected by
  that abort
- **AND** the call SHALL NOT reject with `AbortError` solely because the signal aborted after it
  had already begun

### Requirement: Postgres errors surface as the shared StorageError hierarchy

Driver-level failures SHALL be translated into the project's shared `StorageError` subclasses
before reaching the caller; a raw `postgres.js` error object SHALL NOT escape the adapter layer.

#### Scenario: A connection failure surfaces as ConnectionError
- **WHEN** the underlying Postgres connection cannot be established
- **THEN** the call SHALL reject with `ConnectionError`
- **AND** SHALL NOT reject with a raw driver-level error type

### Requirement: a non-object JSON value round-trips correctly

`PgWatermarks.set` SHALL correctly store and `get` SHALL correctly return a `WatermarkValue` that
is a bare JSON scalar (a string, a number, or a boolean) at its top level, not only an object or
array.

#### Scenario: A bare numeric watermark value round-trips exactly
- **WHEN** `set(kind, key, 42)` is called with a bare number as the entire value
- **THEN** `get(kind, key)` SHALL resolve `42`, not an error and not a wrapped/miscast value

#### Scenario: A bare string watermark value round-trips exactly
- **WHEN** `set(kind, key, "block-1234")` is called with a bare string as the entire value
- **THEN** `get(kind, key)` SHALL resolve `"block-1234"` exactly
