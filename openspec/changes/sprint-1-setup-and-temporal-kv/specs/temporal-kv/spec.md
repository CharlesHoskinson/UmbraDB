# temporal-kv (implementation)

The Postgres-backed implementation of `src/interfaces/temporal-kv.ts`,
plus the project-setup/migration machinery it depends on. Extends (does
not replace) the interface-level requirements already implied by
`src/interfaces/temporal-kv.ts`'s own TSDoc contract.

## ADDED Requirements

### Requirement: Migrations are idempotent and ordered

The migration runner SHALL apply each `migrations/NNN_*.sql` file at most
once, in ascending numeric order, recording each successful application in
`umbradb._migrations`, and SHALL be safe to invoke repeatedly against an
already-migrated database.

#### Scenario: Running migrations twice is a no-op the second time
- **WHEN** `runMigrations(sql)` is called against a fresh database, then
  called again against the same now-migrated database
- **THEN** the second call SHALL apply zero additional migrations
- **AND** SHALL NOT error

#### Scenario: A migration failure does not partially apply
- **WHEN** a migration file's SQL fails partway through execution
- **THEN** none of that file's DDL/DML SHALL be visible afterward (the
  migration runs inside a transaction)
- **AND** that migration SHALL NOT be recorded as applied

### Requirement: Schema isolation is the default, not opt-in

The connection factory SHALL create and operate within a dedicated
Postgres schema (default `umbradb`), SHALL set `search_path` to that schema
for every connection it creates, and SHALL NOT rely on table-name
distinctiveness alone to avoid colliding with other schemas in the same
database.

#### Scenario: Default schema is used when none is specified
- **WHEN** `createClient()` is called with no `schema` option
- **THEN** the resulting connection's `search_path` SHALL be `umbradb`
- **AND** all subsequent DDL/DML from this connection SHALL operate within
  that schema

#### Scenario: A custom schema is honored end to end
- **WHEN** `createClient({ schema: "custom_name" })` is called
- **THEN** migrations and all `TemporalKV` operations on that connection
  SHALL operate within `custom_name`, not `umbradb`

### Requirement: Postgres errors surface as the shared StorageError hierarchy

Driver-level and constraint-violation errors SHALL be translated into the
project's shared `StorageError` subclasses before reaching the caller; a
raw `postgres.js` error object SHALL NOT escape the adapter layer.

#### Scenario: A connection failure surfaces as ConnectionError
- **WHEN** the underlying Postgres connection cannot be established (e.g.
  an invalid connection string or an unreachable host)
- **THEN** the adapter SHALL reject with `ConnectionError`
- **AND** SHALL NOT reject with a raw driver-level error type

#### Scenario: An exclusion-constraint violation is identified by its correct SQLSTATE
- **WHEN** a `kv_history_no_overlap` violation occurs
- **THEN** the adapter's error translation SHALL match it on SQLSTATE `23P01`
  (`exclusion_violation`), NOT `23505` (`unique_violation`) — these are distinct SQLSTATEs and
  matching the wrong one means this translation path silently never fires

#### Scenario: A transaction-key-reuse violation surfaces as TransactionKeyReuseError
- **WHEN** the `kv_current_history_trigger` trigger raises the custom SQLSTATE `UB001`
  (`design/design.md` §2)
- **THEN** the adapter SHALL translate it to `TransactionKeyReuseError`
  (`src/interfaces/temporal-kv.ts`), not a generic query-failure error

### Requirement: Unconditional writes are gapless and monotonic (Law T1)

`PgTemporalKV.put` calls with no `expectedVersion` (the unconditional write
path) SHALL assign versions that increase by exactly 1 from the key's
previous version, starting at 1 for a key's first write, with no gaps and
no repeats, when calls are serialized (a single writer, or writes
coordinated by a lease/transaction outside this sprint's scope) — this
requirement is explicitly conditional on serialization, per
`Formal/STORAGE_ALGEBRA.md` Law T1, not a claim that concurrent
unserialized writers cannot race.

**Also explicitly conditional on the millisecond-collision caveat, corrected by a third-round
cross-vendor re-audit that found this Requirement still claimed unconditional gaplessness after
a DIFFERENT requirement had already documented the exception.** Since Sprint 1 does not wire
`opts.tx` yet, each sequential `put` in the Scenario below is its own separate, autocommitting
transaction — exactly the case `ClockRegressionError`'s own doc describes. If two of the N
sequential writes to one key have `clock_timestamp()`-derived, millisecond-truncated instants
landing in the SAME millisecond, the second SHALL reject with `ClockRegressionError` (SQLSTATE
`23514`) rather than assigning the next consecutive version — this is the accepted, disclosed
tradeoff `Formal/STORAGE_ALGEBRA.md` §1's Law T4 caveat already documents, not a violation of
this Requirement; the Requirement's gapless-and-monotonic guarantee holds for any sequence of
writes that does NOT hit that collision, which is what the word "serialized" above is scoped to.

#### Scenario: Sequential unconditional writes produce consecutive versions
- **WHEN** a key is written N times in sequence with no `expectedVersion`
  supplied, no concurrent writer involved, and no two of the N writes'
  truncated `clock_timestamp()` instants land in the same millisecond
- **THEN** the assigned versions SHALL be exactly `1, 2, 3, ..., N` in
  order, with no gap and no repeated value

#### Scenario: The CAS-guarded and unconditional paths agree on version assignment
- **WHEN** a `put` with `expectedVersion` matching the current version
  succeeds
- **THEN** the resulting version SHALL be exactly `current + 1`, identical
  to what an unconditional write at that point would have produced

### Requirement: A caller-supplied transaction handle is honored or rejected, never silently ignored

Until the Transaction/Lease module's real wiring lands (a later sprint),
every `PgTemporalKV` method accepting `opts.tx` SHALL throw a dedicated,
distinctly-named error when a caller passes a non-`undefined`
`TransactionHandle`, rather than accepting it and running the operation
outside that transaction.

#### Scenario: Passing a transaction handle throws before any query runs
- **WHEN** any of `put`/`get`/`getAt`/`listKeys` is called with a
  non-`undefined` `opts.tx`
- **THEN** the call SHALL reject with a dedicated
  "transaction participation not yet supported" error
- **AND** SHALL NOT execute any query against the database first

### Requirement: put's CAS guard distinguishes conflict from absence

`PgTemporalKV.put`, when given `expectedVersion`, SHALL determine whether a
failed compare-and-set was caused by a version mismatch (key exists at a
different version) or by the key never having been written, and SHALL
populate `VersionConflictError.actual` accordingly (`undefined` only in the
never-written case, per `src/interfaces/temporal-kv.ts`'s documented
contract) — a zero-affected-rows result from the underlying `UPDATE`
statement alone is NOT sufficient to make this distinction and MUST NOT be
used as the sole signal.

#### Scenario: CAS conflict against an existing key reports the actual version
- **WHEN** `put(ns, scope, key, value, { expectedVersion: 2 })` is called
  and the key's current version is actually `3`
- **THEN** the call SHALL reject with `VersionConflictError`
- **AND** `error.actual` SHALL equal `3`

#### Scenario: CAS against a never-written key reports actual as undefined
- **WHEN** `put(ns, scope, key, value, { expectedVersion: 1 })` is called
  and the key has never been written
- **THEN** the call SHALL reject with `VersionConflictError`
- **AND** `error.actual` SHALL be `undefined`, not `0` and not the numeral
  zero as a version

### Requirement: A second write to the same key within one transaction is rejected at the trigger level, not silently absorbed

Added 2026-07-20 after a cross-vendor audit found the original design lost history rows under
same-transaction double-writes (Postgres's `now()` is fixed at transaction start, so two writes
to one key in one transaction shared an indistinguishable commit instant). Per
`Formal/STORAGE_ALGEBRA.md` §1 (Law T4) and `design/design.md` §2's trigger:
`kv_current_history_trigger` SHALL reject a second `UPDATE` to the same `(ns, scope, key)` row
within a single transaction with SQLSTATE `UB001` (translated by the adapter to
`TransactionKeyReuseError`), and SHALL NOT insert a `kv_history` row that would go unrecorded as
a result of the rejection.

**Corrected 2026-07-20 by a follow-up cross-vendor audit — a prior version of this Requirement
overclaimed what actually survives.** An uncaught error raised inside a Postgres transaction
aborts the ENTIRE transaction — Postgres's own documented behavior ("current transaction is
aborted, commands ignored until end of transaction block") gives no way to commit part of a
transaction while only the failing statement rolls back, absent an explicit `SAVEPOINT` this
design does not use. This Requirement therefore does NOT claim the first write's row "remains
committed" after a rejected second write — nothing in that transaction commits at all unless the
caller catches the error and takes its own recovery action (e.g. retrying the whole transaction
with only the first write). What IS guaranteed, and is the actual point of this Requirement: no
`kv_history` row is silently dropped as a side effect of the rejection (the original bug this
Requirement replaces) — the trigger fails loudly instead of losing data quietly. Whether a
future sprint wraps each `put` in its own `SAVEPOINT` so a same-transaction reuse only rolls back
to that savepoint (preserving the first write) is an open design question for the Transaction/
Lease module wiring `opts.tx` (a later sprint), not settled by this Requirement.

**Scope note, corrected after a follow-up review found the original scenario unreachable as
written:** this sprint's `PgTemporalKV.put` never issues two `UPDATE`s within one transaction on
its own, and (per the separate opts.tx Requirement below) rejects any caller-supplied
`opts.tx` outright — so there is no public-API call sequence that reaches this trigger twice in
one transaction yet. The scenario below is therefore exercised directly at the SQL/trigger
level (two `UPDATE`s issued within one `sql.begin()` against the same connection, bypassing
`PgTemporalKV.put`'s public surface entirely), proving the database-level mechanism itself is
correct and ready for the day the Transaction/Lease module wires real `opts.tx` support through
to it in a later sprint — at which point this scenario becomes reachable via `put` directly and
should be re-verified end-to-end through the public API too.

#### Scenario: A second UPDATE to the same key's row in one transaction is rejected at the trigger level
- **WHEN** a `sql.begin()` transaction issues an `UPDATE` to a `kv_current` row, followed by a
  second `UPDATE` to that same row, before committing
- **THEN** the second `UPDATE` SHALL reject with SQLSTATE `UB001`
- **AND** the entire transaction SHALL fail to commit as a result (Postgres aborts the whole
  transaction on an uncaught in-transaction error; there is no partial commit without an
  explicit `SAVEPOINT`, which this design does not use)
- **AND** after the caller's own rollback, the row's version SHALL be whatever it was
  immediately before this transaction began — i.e. NEITHER write took effect, not just the
  second one
- **AND** no `kv_history` row SHALL be silently dropped as a side effect of the rejection (this
  is the property this Requirement actually exists to guarantee — see the note above)

#### Scenario: Sequential puts to the same key in separate transactions succeed, outside the millisecond-collision caveat
- **WHEN** `put(ns, scope, key, v1)` commits in one transaction, then `put(ns, scope, key, v2)`
  is issued in a separate transaction immediately afterward, with the two writes' truncated
  `clock_timestamp()` values (millisecond precision, `Formal/STORAGE_ALGEBRA.md` §1's second Law
  T4 caveat) landing in DIFFERENT milliseconds
- **THEN** the second `put` SHALL succeed normally
- **AND** `getAt({version: 1})` SHALL still return `v1`'s value afterward

**Revised 2026-07-20 by a follow-up cross-vendor audit — the prior wording of this Scenario
("arbitrarily close in wall-clock time") overclaimed unconditional success, contradicting the
already-documented millisecond-truncation caveat.** If the two writes' truncated instants land
in the SAME millisecond, `valid_from` (the first write's timestamp) equals `valid_to` (the
second write's timestamp) for the history row the trigger would insert, violating
`kv_history_range`'s `CHECK (valid_from < valid_to)` and rejecting the second `put` with
`ClockRegressionError` (SQLSTATE `23514`) — even though the two writes are in genuinely separate
transactions, not the same-transaction-reuse case this Requirement's main Scenario covers. This
is the accepted, narrower tradeoff `Formal/STORAGE_ALGEBRA.md` already documents in exchange for
fixing the far worse `now()`-based data-loss bug; it is a real, disclosed limitation, not an
edge case this Scenario should paper over by claiming unconditional success.

### Requirement: listKeys streams without materializing the full result set first, and orders results correctly

`PgTemporalKV.listKeys` SHALL yield keys incrementally via a database
cursor (SHALL NOT load the entire matching result set into memory before
yielding its first item), SHALL yield only each matching key's newest
version, and SHALL yield in a stable order suitable for resumable
pagination — all three properties required by
`src/interfaces/temporal-kv.ts`'s own documented contract for this method,
not only the streaming behavior.

#### Scenario: The first key is yielded before the full scan completes
- **WHEN** `listKeys` is called against a prefix matching a large number of
  keys
- **THEN** the first yielded key SHALL be observable by the caller before
  every matching row has been fetched from Postgres

#### Scenario: Only the newest version of each key is yielded
- **WHEN** a key under the queried prefix has been written multiple times
- **THEN** `listKeys` SHALL yield that key at most once, reflecting its
  current version, not once per historical version

#### Scenario: Aborting mid-iteration rejects with AbortError and releases the cursor
- **WHEN** `opts.signal` is aborted partway through a `listKeys` iteration
- **THEN** the iteration SHALL reject with `AbortError` (per
  `src/interfaces/temporal-kv.ts`'s cancellation contract) — ending the generator's loop via a
  plain `break`, which completes the iteration successfully, does NOT satisfy this requirement
- **AND** the underlying database cursor SHALL be released, not left open

### Requirement: getAt satisfies temporal-projection equivalence (Law T3), within the store's retention window

`getAt(k, { at: T })` SHALL return the value that a full, from-scratch fold
of every `put` to `k` at or before `T` would produce, **for any `T` within
whatever history-retention window this implementation actually enforces**
— this sprint enforces no retention/pruning at all (that is a later
concern, per `design/design.md` §2's `pg_cron`-based retention discussion),
so for Sprint 1 this requirement holds unconditionally for the store's
entire lifetime. A future sprint that adds retention MUST revisit this
requirement's scenarios rather than assume they still hold unchanged once
old history can be pruned.

#### Scenario: getAt matches an independent replay for an arbitrary put sequence
- **WHEN** an arbitrary sequence of `put`s to a key, each with a
  distinct timestamp, is applied, and `getAt(k, { at: T })` is queried for
  an arbitrary `T` within the sequence's time range
- **THEN** the returned value SHALL equal the value produced by folding
  (in a plain, from-scratch reference implementation, not the code under
  test) only the puts at or before `T`

### Requirement: Dual addressing agrees at commit instants (Law T4)

For any committed version `v` of a key, `getAt(k, { version: v })` and
`getAt(k, { at: T })`, where `T` is that version's actual commit instant,
SHALL return equal values.

#### Scenario: Version and timestamp addressing agree
- **WHEN** a key is written across several versions, and for each version
  `v` its exact commit timestamp is recorded
- **THEN** `getAt(k, { version: v })` and `getAt(k, { at: <that version's
  commit timestamp> })` SHALL return the same value for every `v`

### Requirement: History intervals never overlap for a single key (Law T5)

The `kv_history_no_overlap` constraint SHALL make it impossible, at the
database level, for two history intervals belonging to the same
`(ns, scope, key)` to overlap — this SHALL be enforced by Postgres itself,
not solely by application logic.

#### Scenario: An attempt to create overlapping history intervals is rejected
- **WHEN** application logic attempts (whether through a bug or a direct
  manual `INSERT`) to create two `kv_history` rows for the same key whose
  `[valid_from, valid_to)` ranges overlap
- **THEN** Postgres SHALL reject the write with a constraint violation
- **AND** the violation SHALL be traceable to the `kv_history_no_overlap`
  exclusion constraint specifically
