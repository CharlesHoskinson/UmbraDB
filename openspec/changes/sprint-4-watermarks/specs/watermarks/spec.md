# watermarks (implementation)

The Postgres-backed implementation of `src/interfaces/watermarks.ts`. Extends (does not replace)
the interface-level requirements already implied by that file's own TSDoc contract. Requirements
below follow EARS (Easy Approach to Requirements Syntax): each is one of Ubiquitous ("The system
SHALL..."), Event-driven ("WHEN \<trigger>, the system SHALL..."), Unwanted-behavior ("IF
\<trigger>, THEN the system SHALL..."), State-driven ("WHILE \<state>, the system SHALL..."), or
Optional-feature ("WHERE \<feature>, the system SHALL...") form — as in Sprint 2's
`specs/transaction-lease/spec.md`.

## ADDED Requirements

### Requirement: set rejects an invalid value with ValidationError before any statement

`PgWatermarks.set` SHALL validate `value` against `WatermarkValueSchema` and, when validation
fails, SHALL reject with `ValidationError` before issuing any database statement.

#### Scenario: A value that fails WatermarkValueSchema is rejected with no statement issued
- **WHEN** `set` is called with a `value` that fails `WatermarkValueSchema` (e.g. containing a
  `bigint`, `undefined`, or a JavaScript `Date` instance nested inside it)
- **THEN** the call SHALL reject with `ValidationError`
- **AND** no row in `watermarks` SHALL be inserted or updated as a result

### Requirement: set rejects a top-level null value with ValidationError before any statement

IF `set` is called with a `value` that is exactly `null` at its top level, THEN `PgWatermarks.set`
SHALL reject with `ValidationError` before issuing any database statement — an application-level
guard in `set` itself, not a `WatermarkValueSchema` change. The shared schema structurally admits
a top-level JSON `null`, but the driver would bind a JavaScript `null` parameter as a
wire-protocol SQL NULL (not the JSONB literal `'null'`) against the `value jsonb NOT NULL`
column, surfacing as a mistranslated generic error instead of a clean boundary rejection
(`design.md` §2's top-level-null guard, with the verified driver-source reasoning).

#### Scenario: A top-level null value is rejected with no statement issued
- **WHEN** `set(kind, key, null)` is called with `null` as the entire value
- **THEN** the call SHALL reject with `ValidationError` — specifically NOT
  `UnrecognizedPostgresError` and NOT a raw driver-level `not_null_violation` (SQLSTATE 23502)
  error
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
exactly as `TemporalKV`'s equivalent methods already do. IF the supplied handle does not resolve
to a live transaction — reused after its transaction committed or rolled back, or fabricated —
THEN the method SHALL reject with `TransactionHandleInvalidError` before issuing any statement
(`src/interfaces/transaction-lease.ts`'s own documented contract for every `opts.tx`-accepting
storage-layer method).

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

#### Scenario: A stale or fabricated transaction handle is rejected with TransactionHandleInvalidError
- **WHEN** `set` or `get` is called with `opts.tx` set to a `TransactionHandle` whose transaction
  has already committed or rolled back, or to a fabricated handle that never named a live
  transaction
- **THEN** the call SHALL reject with `TransactionHandleInvalidError`
- **AND** no database statement SHALL have been issued by that call

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

#### Scenario: A get whose signal aborts after the call has begun likewise completes normally
- **WHEN** `get`'s `opts.signal` is aborted after the call has already begun (its statement
  already dispatched)
- **THEN** the call SHALL complete its ordinary outcome (resolving the stored value, or
  `undefined` for a never-set pair)
- **AND** the call SHALL NOT reject with `AbortError` solely because the signal aborted after it
  had already begun

### Requirement: Postgres errors surface as the shared StorageError hierarchy

`set` and `get` SHALL each translate driver-level failures into the project's shared
`StorageError` subclasses before they reach the caller; a raw `postgres.js` error object SHALL
NOT escape the adapter layer from either method. This binds `get` no less than `set`: the "get
never throws for an unset cursor" requirement above is about a *missing key*, not about `get`
never throwing at all — the interface's module-level doc names `ConnectionError` as a failure
mode of both methods. (The interface also inherits `SerializationFailedError` as a third shared
failure mode; it is not independently triggerable on the current `sql.json()` path, per
`design.md` §8, so it is acknowledged here for contract parity with the interface rather than
given its own scenario.)

#### Scenario: A connection failure during set surfaces as ConnectionError
- **WHEN** `set` is called and the underlying Postgres connection cannot be established
- **THEN** the call SHALL reject with `ConnectionError`
- **AND** SHALL NOT reject with a raw driver-level error type

#### Scenario: A connection failure during get surfaces as ConnectionError, not undefined
- **WHEN** `get` is called against a connection that cannot be established (e.g. a dead
  connection)
- **THEN** the call SHALL reject with `ConnectionError` — a failure to ask the database is not
  the same as a missing cursor, so the call SHALL NOT resolve `undefined`
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

#### Scenario: A large integer encoded as a decimal string round-trips exactly
- **WHEN** `set(kind, key, "9007199254740993")` is called — a cursor value above
  `Number.MAX_SAFE_INTEGER`, encoded as a decimal string per `design.md` §4's documented
  large-integer convention
- **THEN** `get(kind, key)` SHALL resolve the string `"9007199254740993"` exactly, digit for
  digit — proving the convention's recommended encoding actually survives the full driver/JSONB
  round-trip (the bare-number precision-loss failure mode itself is established Node.js
  `JSON.parse` behavior and is not re-proven here)

### Requirement: T is a caller assertion — no runtime validation beyond the erased WatermarkValue shape

`PgWatermarks.set<T>`/`get<T>` SHALL perform no runtime validation of `T` beyond the erased
`WatermarkValue` shape: a caller who writes one shape under a `kind` and reads it back with a
mismatched `T` SHALL receive the stored value unchanged — "a type lie, not a runtime error," in
the interface's own words (`src/interfaces/watermarks.ts`'s documented caller-assertion
contract). This requirement exists as a regression guard: if runtime `T`-validation were ever
added later, that would be a contract change, and this is what catches it.

#### Scenario: Reading with a mismatched T returns the stored value, not a runtime error
- **WHEN** `set(kind, key, v)` stores a value of one shape (e.g. an object cursor), and `get<T>`
  is then called for the same `(kind, key)` with a `T` naming a different shape (e.g. a bare
  number)
- **THEN** the call SHALL resolve with the stored value exactly as written
- **AND** SHALL NOT reject with `ValidationError` or any other runtime type error
