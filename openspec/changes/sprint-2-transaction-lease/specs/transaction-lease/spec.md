# transaction-lease (implementation)

The Postgres-backed implementation of `src/interfaces/transaction-lease.ts`. Requirements below
follow EARS (Easy Approach to Requirements Syntax): each is one of Ubiquitous ("The system
SHALL..."), Event-driven ("WHEN \<trigger>, the system SHALL..."), Unwanted-behavior ("IF
\<trigger>, THEN the system SHALL..."), State-driven ("WHILE \<state>, the system SHALL..."), or
Optional-feature ("WHERE \<feature>, the system SHALL...") form.

## ADDED Requirements

### Requirement: Transactions commit or roll back atomically

The system SHALL commit all writes performed inside a `withTransaction` callback if and only if
that callback returns without throwing, and SHALL make none of those writes visible otherwise.

#### Scenario: A callback that returns normally commits
- **WHEN** `withTransaction(fn)` is called and `fn` returns a value without throwing
- **THEN** every write `fn` performed SHALL be visible to subsequent reads
- **AND** `withTransaction` SHALL resolve with `fn`'s return value

#### Scenario: A callback that throws Rollback rolls back and rejects with TransactionRolledBackError
- **WHEN** `fn` throws `Rollback(cause)`
- **THEN** `withTransaction` SHALL reject with `TransactionRolledBackError` carrying `cause`
- **AND** no write `fn` performed SHALL be visible afterward

#### Scenario: A callback that throws an unrelated error still rolls back, and that error propagates unchanged
- **WHEN** `fn` throws an `Error` that is not `Rollback`
- **THEN** `withTransaction` SHALL reject with that same error, not a wrapped or translated one
- **AND** no write `fn` performed SHALL be visible afterward

### Requirement: A transaction timeout surfaces as TransactionFaultError

IF `opts.timeoutMs` is given and a statement inside the transaction runs longer than that
duration, THEN the system SHALL reject `withTransaction` with `TransactionFaultError` whose
`faultKind` is `"timeout"`, and SHALL roll back the transaction.

#### Scenario: A slow statement under a tight timeout fails the transaction
- **WHEN** `withTransaction(fn, {timeoutMs: 50})` is called and `fn` executes a statement that
  runs longer than 50ms
- **THEN** the call SHALL reject with `TransactionFaultError` (`faultKind: "timeout"`)
- **AND** any write `fn` performed before the slow statement SHALL NOT be visible afterward

### Requirement: A resolved transaction handle always refers to its own live transaction

WHILE a `withTransaction` callback is executing, the system SHALL make the `TransactionHandle`
passed to that callback resolvable (via `resolveTransaction`) to the exact `postgres.js`
transaction-scoped connection running that callback. IF `resolveTransaction` is called with a
handle whose transaction has already ended (committed, rolled back, or never existed), THEN the
system SHALL throw `TransactionHandleInvalidError` rather than resolve to any connection.

#### Scenario: A handle resolves to its own transaction while live
- **WHEN** `resolveTransaction(handle)` is called from inside the `fn` callback that received
  `handle`
- **THEN** it SHALL return a connection on which a write performed through it is visible to a
  read performed through that same resolved connection, before `fn` returns

#### Scenario: A handle used after its transaction ended throws TransactionHandleInvalidError
- **WHEN** a `TransactionHandle` captured during one `withTransaction` call is passed to
  `resolveTransaction` AFTER that `withTransaction` call has already resolved or rejected
- **THEN** the call SHALL throw `TransactionHandleInvalidError`
- **AND** it SHALL NOT resolve to any connection (including a connection from an unrelated,
  still-live transaction)

#### Scenario: A fabricated handle throws TransactionHandleInvalidError
- **WHEN** `resolveTransaction` is called with a `TransactionHandle`-shaped value whose `id` was
  never issued by any `withTransaction` call
- **THEN** the call SHALL throw `TransactionHandleInvalidError`

### Requirement: At most one holder per lease key at any instant (Law L1)

The system SHALL ensure that, for any lease `key`, no two `acquireLease`/`withLease` critical
sections for that same `key` are ever concurrently active, across any number of connections.

#### Scenario: A second acquireLease for a held key blocks until release
- **WHEN** `acquireLease(key)` is called (no `timeoutMs`) while another caller already holds the
  lease for `key`
- **THEN** the call SHALL NOT resolve until the current holder releases the lease
- **AND** it SHALL resolve promptly once released

#### Scenario: Concurrent withLease calls on one key never overlap
- **WHEN** N concurrent `withLease(key, fn)` calls are issued against the same `key` from N
  independent connections
- **THEN** at most one `fn` invocation's critical section SHALL be active at any instant,
  regardless of N or the connections' relative timing

### Requirement: acquireLease waits indefinitely absent a timeout; tryAcquireLease never blocks unboundedly

WHERE no `opts.timeoutMs` is given, `acquireLease` SHALL wait as long as necessary for the lease
to become available, matching `pg_advisory_lock`'s native blocking behavior. WHERE no
`opts.timeoutMs` is given, `tryAcquireLease` SHALL return `null` immediately if the lease is
currently held by another caller, without waiting, matching `pg_try_advisory_lock`'s native
non-blocking behavior.

#### Scenario: tryAcquireLease with no timeoutMs returns null promptly under contention
- **WHEN** `tryAcquireLease(key)` is called (no `opts.timeoutMs`) while another caller holds the
  lease for `key`
- **THEN** the call SHALL resolve `null` promptly (not after any waiting period)

### Requirement: A lease timeout surfaces distinctly for acquireLease vs. tryAcquireLease

IF `opts.timeoutMs` is given and elapses before the lease becomes available, THEN
`acquireLease` SHALL reject with `LeaseTimeoutError`, and `tryAcquireLease` SHALL instead resolve
`null` — the same underlying contention, two different documented outcomes.

#### Scenario: acquireLease with a timeout throws LeaseTimeoutError on expiry
- **WHEN** `acquireLease(key, {timeoutMs: 100})` is called against a key held by another caller
  for longer than 100ms
- **THEN** the call SHALL reject with `LeaseTimeoutError` whose `key` matches and whose
  `waitedMs` is approximately 100

#### Scenario: tryAcquireLease with a timeout resolves null on expiry, not an error
- **WHEN** `tryAcquireLease(key, {timeoutMs: 100})` is called against a key held by another
  caller for longer than 100ms
- **THEN** the call SHALL resolve `null`
- **AND** it SHALL NOT reject

### Requirement: releaseLease rejects a lease that is not currently held

IF `releaseLease` is called with a `Lease` whose token does not correspond to a currently-held
lease (already released, or its connection already closed), THEN the system SHALL reject with
`LeaseNotHeldError` rather than silently no-op.

#### Scenario: Releasing an already-released lease throws LeaseNotHeldError
- **WHEN** `releaseLease(lease)` is called twice in sequence on the same `lease` object
- **THEN** the first call SHALL succeed
- **AND** the second call SHALL reject with `LeaseNotHeldError`

### Requirement: withLease always releases its lease, even when fn throws

The system SHALL release the lease acquired by `withLease` regardless of whether `fn` resolves
or rejects, and SHALL propagate `fn`'s own error unchanged (a release failure SHALL be logged,
not thrown, so it never masks `fn`'s error).

#### Scenario: withLease releases the lease when fn throws
- **WHEN** `withLease(key, fn)` is called and `fn` throws an error
- **THEN** the lease for `key` SHALL be released before `withLease` rejects
- **AND** `withLease` SHALL reject with `fn`'s own error, not a release-related error
- **AND** a subsequent `acquireLease(key)` by another caller SHALL succeed immediately
