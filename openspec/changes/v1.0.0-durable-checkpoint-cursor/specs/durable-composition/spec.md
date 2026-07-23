# durable-composition (implementation)

The durable-composition capability for UmbraDB 1.0.0: it makes a sync cursor and the checkpoint data
it points at co-committable, states and enforces the Postgres durability configuration UmbraDB's
guarantees depend on, bounds every wait server-side, and closes three contract-integrity holes.
Extends (does not replace) the interface-level contracts already implied by
`src/interfaces/checkpoint-store.ts`, `src/interfaces/temporal-kv.ts`,
`src/interfaces/transaction-lease.ts`, and `src/postgres/client.ts`.

Requirements below follow EARS (Easy Approach to Requirements Syntax): each is one of Ubiquitous
("The system SHALL..."), Event-driven ("WHEN \<trigger>, the system SHALL..."), Unwanted-behaviour
("IF \<trigger>, THEN the system SHALL..."), State-driven ("WHILE \<state>, the system SHALL..."), or
Optional-feature ("WHERE \<feature>, the system SHALL...") form — as in Sprint 2's
`specs/transaction-lease/spec.md` and Sprint 4's `specs/watermarks/spec.md`.

Filed under `## ADDED Requirements` against a new `durable-composition` capability because the
base specs it touches (checkpoint-store / temporal-kv / transaction-lease) live in sprint changes
that are not yet archived, so there is no archived base spec to `## MODIFIED`-delta against — the
same convention Sprint 4 used. `design.md` §5 records the intended archival reconciliation (which of
these become MODIFIED deltas against the base capabilities once the sprint specs are archived) so the
spec base does not fork.

## ADDED Requirements

### Requirement: save accepts and joins a caller-supplied transaction handle

WHERE `opts.tx` is supplied to `PgCheckpointStore.save`, `save` SHALL issue every one of its
statements (chunk upserts, sequence allocation, manifest insert, junction inserts) on the
transaction resolved from that handle rather than opening its own internal `withTransaction`, so the
checkpoint commits or rolls back atomically with everything else the caller wrote in that same
transaction. WHERE `opts.tx` is not supplied, `save` SHALL behave exactly as before, composing its
own internal transaction. IF the supplied handle does not resolve to a live transaction — reused
after its transaction committed or rolled back, or fabricated — THEN `save` SHALL reject with
`TransactionHandleInvalidError` before issuing any statement.

#### Scenario: A checkpoint saved on a caller transaction commits with it
- **WHEN** a transaction is opened via `TransactionLeaseLayer.withTransaction`, and `save` is called
  with that transaction's handle as `opts.tx`, and the transaction is then committed
- **THEN** the checkpoint SHALL be present and `load`able after the commit
- **AND** its manifest and junction rows SHALL have been written on the caller's transaction, not on
  a separate one

#### Scenario: A checkpoint saved on a caller transaction that rolls back leaves no trace
- **WHEN** `save` is called with `opts.tx` set to a handle for a transaction that is later rolled
  back (not committed)
- **THEN** no manifest, junction, or `complete=true` row for that call SHALL be visible to any
  reader afterward

#### Scenario: save on a caller transaction behaves identically to the internal-transaction path for a reader
- **WHEN** `save` is called without `opts.tx` (the default path)
- **THEN** it SHALL open and commit its own transaction and return the same `CheckpointSummary` shape
  it returns today, with no observable behavioural change for existing callers

#### Scenario: A stale or fabricated transaction handle is rejected before any statement
- **WHEN** `save` is called with `opts.tx` set to a `TransactionHandle` whose transaction has already
  committed or rolled back, or to a fabricated handle that never named a live transaction
- **THEN** the call SHALL reject with `TransactionHandleInvalidError`
- **AND** no database statement SHALL have been issued by that call

### Requirement: saveAndAdvance co-commits a checkpoint and its sync cursor atomically

`saveAndAdvance` SHALL persist a checkpoint and advance a watermark cursor within a single database
transaction, composing only in-repo primitives (`CheckpointStore.save`, `Watermarks.set`, and the
transaction layer) and importing no consumer or indexer application. WHEN `saveAndAdvance` is called,
it SHALL open one transaction, call `save` with that transaction's handle, call `watermarks.set` with
the same handle, and commit both together — such that the cursor is never made durable unless the
checkpoint data it describes is also durable.

#### Scenario: A crash before the single commit leaves neither the checkpoint nor the cursor
- **WHEN** `saveAndAdvance` is interrupted (process or database failure) at any point before its one
  transaction commits
- **THEN** on recovery neither the checkpoint for that call nor the advanced cursor value SHALL be
  durable
- **AND** the previously durable cursor SHALL still point at previously durable checkpoint data,
  never at absent data

#### Scenario: A successful saveAndAdvance makes both durable together
- **WHEN** `saveAndAdvance(walletId, networkId, data, cursor)` completes successfully
- **THEN** `load(walletId, networkId)` SHALL return the just-saved checkpoint
- **AND** `watermarks.get(cursor.kind, cursor.key)` SHALL return `cursor.value`
- **AND** both SHALL have become visible at the same commit, not one before the other

### Requirement: a conforming composition keeps the durable cursor from ever being ahead of durable checkpoint data

WHERE a checkpoint write and its cursor advance are composed via `saveAndAdvance` or within one
shared transaction, the system SHALL make the cursor durable only if the checkpoint data it
references is durable in the same commit (the cursor can never be ahead of its data). WHERE a caller
composes a checkpoint write and a cursor advance manually (not via `saveAndAdvance` and not within
one shared transaction), the documented ordering contract SHALL require the cursor to be advanced
strictly AFTER the checkpoint data transaction has committed, so that any crash yields at worst a
cursor that is BEHIND durable data (the recoverable direction), never ahead of it. The contract SHALL
further state that watermark-behind recovery re-applies a bounded window of already-durable writes,
so replay convergence is defined on CURRENT state, not on history chains.

> The library provides the safe composition (`saveAndAdvance` / a shared `tx`) and the documented
> ordering contract; it cannot prevent a caller who deliberately advances the cursor first in an
> earlier, separate transaction — that path is what the ordering contract forbids, not what the API
> structurally blocks. Hence the conditional (WHERE) form rather than an unconditional guarantee.

#### Scenario: Manual composition in the safe ordering survives a crash without skipping data
> Crash-level verification of this scenario (kill between the data commit and the cursor advance,
> under `synchronous_commit` on AND off) is delivered by T5 in the testing-gate change (`G9`–`G12`),
> recorded as handoff A11; this change delivers the API, the ordering contract, and the fault-free
> property coverage (task 0.4) that this scenario's non-crash half relies on.
- **WHEN** a caller commits a checkpoint's data transaction, and only afterward advances the cursor in
  a separate transaction, and a crash occurs at any point in that sequence
- **THEN** the durable cursor SHALL be either the previous value (data-then-crash) or the new value
  (both committed), and in neither case SHALL it reference a checkpoint that was not persisted
- **AND** resuming from the durable cursor SHALL reproduce the reference current state (replay
  convergence judged on current state, per the documented replay contract)

#### Scenario: The fault-free property holds for both composition forms
- **WHEN** randomized interleavings of `saveAndAdvance` calls AND of manual safe-ordering
  compositions (data transaction committed, then the cursor advanced) are driven fault-free
- **THEN** at every observed durable state the cursor SHALL reference a checkpoint that exists (never
  one that is absent), and resume-from-cursor SHALL reproduce the reference CURRENT state

#### Scenario: The ordering and replay contract is a checkable documentation artifact
- **WHEN** the checkpoint-store contract documentation is reviewed
- **THEN** it SHALL state the cursor-strictly-after-data ordering rule and the current-state replay
  contract explicitly, cross-referenced from `Formal/STORAGE_ALGEBRA.md` W1

### Requirement: a durability probe asserts the server's crash-safety settings at client bootstrap

The system SHALL run a durability probe as a mandatory step of `runMigrations`, and SHALL also expose
it as a directly callable `probeDurability(sql, opts?)`, so that no consumer can reach first use of
the client without the probe having run (every consumer must call `runMigrations` before first use).
WHEN the probe runs, the system SHALL query the server's `fsync`, `synchronous_commit`, and
`full_page_writes` settings, evaluate each against the Durability Contract, and return a typed set of
durability warnings, failing on a hard violation. IF `fsync` is `off`, THEN `runMigrations` SHALL
reject with a typed `DurabilityContractError` before running any migration, so the client is not
usable against that server. IF `synchronous_commit` is `off`, THEN the probe SHALL surface a typed
durability warning (not a refusal), because only `off` sacrifices local crash durability and its lost
tail of recently-committed progress is recoverable by re-syncing. IF `full_page_writes` is `off` and
no override is configured, THEN `runMigrations` SHALL reject with a typed `DurabilityContractError`.
WHERE `synchronous_commit` is a standby-oriented value (`local`, `remote_write`, `remote_apply`, or
`on`), the probe SHALL treat it as durable for local crash recovery on a primary and SHALL NOT emit a
lost-tail durability warning for it (it MAY record a non-durability informational note).

#### Scenario: fsync=off makes runMigrations reject before any migration runs
- **WHEN** the probe runs (via `runMigrations`) against a server with `fsync = off`
- **THEN** `runMigrations` SHALL reject with a typed `DurabilityContractError`, having run no
  migration, so the client is not usable against that server

#### Scenario: synchronous_commit=off is warned, not refused
- **WHEN** the probe runs against a server with `synchronous_commit = off`
- **THEN** it SHALL surface a typed durability warning naming the setting
- **AND** it SHALL NOT refuse to proceed solely because of this setting

#### Scenario: a standby-oriented synchronous_commit is treated as durable, not warned
- **WHEN** the probe runs against a primary (no synchronous standbys) with `synchronous_commit` set
  to `local`, `remote_write`, or `remote_apply`
- **THEN** it SHALL NOT emit a lost-tail durability warning for that setting, because each of these
  flushes WAL to local disk before acknowledging the commit and is crash-durable on the primary
- **AND** `runMigrations` SHALL proceed

#### Scenario: full_page_writes=off is refused by default
- **WHEN** the probe runs against a server with `full_page_writes = off` and no override is configured
- **THEN** `runMigrations` SHALL reject with a typed `DurabilityContractError`

### Requirement: a transaction-pooling proxy is detected and refused

The durability probe SHALL detect an intervening transaction-pooling proxy (e.g. PgBouncer in
`transaction` mode) by acquiring a session-scoped advisory lock and then, in a follow-up query on the
same logical session, confirming that lock is visible in `pg_locks`. IF the session advisory lock is
not visible on the follow-up query, THEN the probe SHALL cause `runMigrations` to reject with a typed
error, because the connection-pinned advisory-lease scheme is silently unsafe under transaction
pooling.

#### Scenario: session advisory-lock invisibility on follow-up fails fast
- **WHEN** the probe acquires a session advisory lock and a follow-up query on the same session does
  not observe that lock in `pg_locks` (as happens when a transaction pooler routes the follow-up to a
  different backend)
- **THEN** `runMigrations` SHALL reject with a typed error identifying the transaction-pooling hazard
- **AND** SHALL have run no migration, so the client is not usable against that proxy

#### Scenario: a direct (session-mode) connection passes the pooler check
- **WHEN** the probe runs against a direct connection or a session-mode pool where the same backend
  serves consecutive queries
- **THEN** the follow-up query SHALL observe the session advisory lock, and the pooler check SHALL
  pass without a warning

### Requirement: the required Postgres configuration is published as a binding Durability Contract

The system SHALL publish a Durability Contract document stating the Postgres configuration UmbraDB's
durability guarantees depend on as a binding deployer precondition: `fsync = on`,
`full_page_writes = on`, the `synchronous_commit` semantics (that only `off` sacrifices local crash
durability, and that `local`/`remote_write`/`remote_apply`/`on` are all crash-durable on a primary),
session-mode pooling only (no transaction pooler), and the server-side timeout defaults. The document
SHALL state, for each setting, whether the startup probe enforces it (rejects) or merely documents it.

#### Scenario: the Durability Contract doc exists and states every enforced precondition
- **WHEN** the Durability Contract document is reviewed
- **THEN** it SHALL name `fsync`, `full_page_writes`, `synchronous_commit`, the transaction-pooler
  prohibition, and the three server-side timeouts
- **AND** SHALL state, for each, whether the startup probe enforces it (rejects) or documents it
- **AND** SHALL state that only `synchronous_commit = off` forfeits local crash durability

### Requirement: the UmbraDB connection sets bounded server-side timeouts by default

The system SHALL set `statement_timeout`, `lock_timeout`, and `idle_in_transaction_session_timeout` to
conservative, non-zero default values on the UmbraDB connection, so that a half-dead server (accepting
connections but not completing queries) fails typed and bounded rather than hanging indefinitely. Each
default SHALL be overridable through `UmbraDBConnectionOptions`. The `idle_in_transaction_session_timeout`
default SHALL be chosen not to terminate a lease-held reserved connection or an open `withTransaction`
that is performing legitimate in-transaction work at the declared operating envelope; a workload that
legitimately holds a transaction open longer SHALL be able to raise the default via
`UmbraDBConnectionOptions`. (The concrete default values are stated in `design.md` §3.1 and the
Durability Contract, not fixed by this requirement.)

#### Scenario: the three timeouts are set on a fresh connection
- **WHEN** a client is created with default options and a session-level `SHOW` is issued for each of
  `statement_timeout`, `lock_timeout`, and `idle_in_transaction_session_timeout`
- **THEN** each SHALL report the configured non-zero default, not `0` (disabled)

#### Scenario: a caller can override each timeout default
- **WHEN** a client is created with explicit timeout overrides in `UmbraDBConnectionOptions`
- **THEN** each `SHOW` SHALL report the caller-supplied value, not the default

#### Scenario: the lease path restores the connection timeout default, not zero
- **WHEN** a lease that set its own `statement_timeout` on its reserved connection is released, and
  that reserved connection is reused
- **THEN** the connection's `statement_timeout` SHALL be the configured connection default afterward,
  not `0` and not the lease's TTL value

#### Scenario: a raised idle-in-transaction default is honoured for a long in-transaction workload
- **WHEN** a client is created with `idle_in_transaction_session_timeout` raised via
  `UmbraDBConnectionOptions`, and a `SHOW idle_in_transaction_session_timeout` is issued on a
  connection about to run a long `withTransaction`
- **THEN** it SHALL report the raised value, so a legitimate long in-transaction workload is not
  bounded by the shorter default

### Requirement: migration advisory-lock acquisition is bounded and fails fast

WHEN `runMigrations` acquires the class-1 schema advisory lock, the system SHALL bound the wait so
that a lock already held by another session causes a fast, typed timeout failure within the bounded
window rather than an indefinite hang. The bound SHALL be proven by test (scenario "a held migration
lock makes a second runMigrations fail fast") and MAY be implemented by any mechanism that actually
aborts a blocked advisory-lock acquisition — `lock_timeout`, a scoped `statement_timeout` around the
acquire, or a bounded `pg_try_advisory_lock` deadline poll. Whichever mechanism sets a session-level
timeout for the acquisition SHALL restore the prior value before the migration DDL runs, so the DDL is
not subject to the short acquire bound.

#### Scenario: a held migration lock makes a second runMigrations fail fast, not hang
- **WHEN** the class-1 advisory lock for a schema is held by a first session, and `runMigrations` is
  invoked for the same schema from a second session
- **THEN** the second invocation SHALL reject with a typed timeout error within the bounded window
- **AND** SHALL NOT block indefinitely waiting for the lock

#### Scenario: the acquire timeout is scoped and restored
- **WHEN** `runMigrations` acquires the advisory lock successfully within the bound, using a mechanism
  that set a session-level timeout for the acquisition
- **THEN** that timeout SHALL be restored to the prior value before the migrations run, so migration
  DDL is not subject to the short acquire bound

### Requirement: PgCheckpointStore validates walletId and networkId at every entry point

`PgCheckpointStore.save`, `load`, `history`, and `prune` SHALL each validate `walletId` and
`networkId` against a shared identifier schema — non-empty, length-bounded, and rejecting
Postgres-unsafe text (NUL and lone surrogates) — and SHALL reject an invalid id with `ValidationError`
before issuing any database statement. A raw driver-level error SHALL NOT escape any of these four
methods because of a malformed id. The schema SHALL reuse the wallet-state envelope's existing
`z.string().min(1).refine(!hasPostgresUnsafeText)` pattern for these same two ids
(`src/interfaces/wallet-state-envelope.ts:81-82`), extended with an explicit maximum-length bound
(the envelope schema itself has no `.max()`), so that an over-length id is also a clean boundary
rejection rather than a raw driver error.

#### Scenario: a NUL-containing walletId is rejected with ValidationError at each entry point
- **WHEN** `save`, `load`, `history`, or `prune` is called with a `walletId` (or `networkId`)
  containing a NUL character or a lone surrogate
- **THEN** the call SHALL reject with `ValidationError`
- **AND** SHALL NOT reject with `UnrecognizedPostgresError` or a raw driver-level error
- **AND** no database statement SHALL have been issued by that call

#### Scenario: an over-length id is rejected before any statement
- **WHEN** any of the four methods is called with an id exceeding the identifier length bound
- **THEN** the call SHALL reject with `ValidationError` before issuing any statement

#### Scenario: a valid id continues to work unchanged
- **WHEN** any of the four methods is called with a well-formed `walletId`/`networkId`
- **THEN** the method SHALL proceed exactly as before, with no behavioural change

### Requirement: JsonValueSchema rejects values exceeding the maximum nesting depth

`JsonValueSchema` SHALL reject a value whose nesting depth exceeds the shared maximum depth bound with
`ValidationError`, before the value reaches the driver and before any recursive parse of the value can
overflow the stack. Because `JsonValueSchema` is shared, this bound SHALL apply to every value passed
to `TemporalKV.put`, `Watermarks.set`, and any read-side validation that reuses the schema. The bound
SHALL use the same single shared depth constant already applied to transaction-history `sections`
(`MAX_ENTRY_CONTENT_DEPTH = 64`), so there is one depth number in the codebase, not two. (The
depth-guard implementation — reusing the existing iterative, non-recursive `exceedsMaxDepth` guard as
a pre-parse preprocess step — is specified in `design.md` §4.2; this requirement states the observable
outcome.)

#### Scenario: an over-deep value passed to put is rejected before any statement
- **WHEN** `PgTemporalKV.put` is called with a value nested more deeply than the maximum supported
  depth
- **THEN** the call SHALL reject with `ValidationError` before issuing any statement
- **AND** the writer process SHALL NOT overflow its stack

#### Scenario: an over-deep value passed to set is rejected identically
- **WHEN** `PgWatermarks.set` is called with a value nested more deeply than the maximum supported
  depth (the same shared bound)
- **THEN** the call SHALL reject with `ValidationError` before issuing any statement

#### Scenario: a value at or under the bound is accepted
- **WHEN** a value nested exactly at the maximum supported depth is validated
- **THEN** it SHALL pass validation, so the bound rejects only genuinely over-deep input

### Requirement: withLease surfaces a lease-release failure instead of swallowing it

`withLease` SHALL NOT silently discard a failure from releasing the lease. WHEN the wrapped function
completes successfully but releasing the lease fails (e.g. the reserved connection was lost mid-
critical-section, surfacing as `LeaseFaultError("connection-lost")`), `withLease` SHALL surface that
failure so a caller can learn that mutual exclusion may have lapsed. WHERE a caller-supplied
`onReleaseFault` callback is provided, `withLease` SHALL invoke it with the release failure and SHALL
resolve with the wrapped function's return value. WHERE no `onReleaseFault` callback is provided (the
default), `withLease` SHALL reject with the `LeaseFaultError`. WHEN the wrapped function itself threw,
`withLease` SHALL surface the wrapped function's error as the primary outcome AND SHALL still surface
the release failure — via `onReleaseFault` if supplied, otherwise as a `cause`/aggregated error
attached to the primary rejection — never dropping it silently.

#### Scenario: a release failure after a successful fn, with no callback, rejects
- **WHEN** the function passed to `withLease` returns successfully, no `onReleaseFault` callback was
  supplied, and the subsequent lease release fails with `LeaseFaultError("connection-lost")`
- **THEN** `withLease` SHALL reject with that `LeaseFaultError`, not resolve as if nothing failed

#### Scenario: a release failure after a successful fn, with a callback, resolves and reports
- **WHEN** the function passed to `withLease` returns successfully, an `onReleaseFault` callback was
  supplied, and the subsequent lease release fails with `LeaseFaultError("connection-lost")`
- **THEN** `withLease` SHALL invoke `onReleaseFault` with that `LeaseFaultError`
- **AND** SHALL resolve with the wrapped function's return value

#### Scenario: fn's own error stays primary while a release failure is still surfaced
- **WHEN** the function passed to `withLease` throws, and the subsequent lease release also fails
- **THEN** the caller SHALL receive the function's own error as the primary rejection
- **AND** the release failure SHALL still be surfaced (via `onReleaseFault` if supplied, otherwise as
  an attached `cause`/aggregated error), never silently swallowed

#### Scenario: a clean release is unaffected
- **WHEN** the function passed to `withLease` completes and the lease releases without error
- **THEN** `withLease` SHALL resolve with the function's return value and surface no release fault
