# sqlite-engine

The embedded storage engine, the query façade every UmbraDB adapter is written against, the handle
lifecycle that replaces `createClient`'s pooled semantics, and the measurement gate the rest of the
migration reads its numbers from. Requirements follow EARS (Easy Approach to Requirements Syntax),
matching Sprint 2's, Sprint 4's and Sprint 7's spec files.

Scope note: this capability specifies the **engine and its façade**. It does not specify DDL
(`storage-schema`), the temporal event log or the clock (`temporal-kv`), the lease or transaction
semantics (`transaction-lease`), or the written contracts, error catalog and backup story
(`release-contract`). Where a requirement below constrains one of those, it constrains only the
interface between them and says so.

## ADDED Requirements

### Requirement: the storage engine is an embedded SQLite database reached through a version-pinned, gate-observable binding

UmbraDB SHALL reach SQLite through a third-party binding declared in `package.json`
`dependencies`, resolved to an exact version with an integrity hash in `package-lock.json`, listed
in `docs/supply-chain/inventory.md` as a runtime component, and covered by
`.github/workflows/supply-chain.yml`'s `npm ci` and `npm audit --omit=dev` steps.

UmbraDB SHALL NOT depend on a platform-provided SQLite module that cannot be pinned in the lockfile
or observed by the supply-chain gate.

The binding SHALL NOT require a package lifecycle script to install, so that `.npmrc`'s
`ignore-scripts=true` and the effective-`ignore-scripts` drift guard remain satisfied.

The inventory entry SHALL record the SQLite version vendored by the pinned binding, and CI SHALL
assert that the running binding's `sqlite_version()` equals the recorded value.

The inventory entry SHALL also record the binding's compiled option set. UmbraDB SHALL NOT issue SQL
whose validity depends on a compile option that is not recorded and asserted; where such an option
would otherwise be required, the statement SHALL be written in a form that does not need it.

#### Scenario: SQL does not depend on an un-asserted compile option
- **WHEN** a statement could be expressed either in a form requiring an optional compile-time feature
  or in a form that does not
- **THEN** the form that does not require it SHALL be used
- **AND** this SHALL hold even where the feature is present on the currently pinned binding, because
  presence today is not a pin — a rebuild of the same binding version can change the option set
  without changing the version string

#### Scenario: an optional feature that happens to be available is still not relied upon (negative control)
- **GIVEN** an optional statement-limiting compile option that **is** present on the pinned binding,
  so the convenient syntax parses and every test passes
- **WHEN** the binding is rebuilt, or replaced by another build of the same version, without that
  option
- **THEN** the statement CAN fail as a syntax error at runtime, in a code path that CI never
  exercised, on a consumer's machine rather than in the project's own
- **AND** this is why the requirement is written against *dependence* rather than against
  *availability* — availability was never the property in question

#### Scenario: the compiled option set is inventoried alongside the version
- **WHEN** the supply-chain inventory is inspected
- **THEN** it SHALL record the compiled option set the recorded behaviour depends on
- **AND** an option the codebase relies on that is absent from the running binding SHALL fail CI
  rather than surface as a runtime syntax error

#### Scenario: the pinned binding is visible to every mechanism the project uses to watch dependencies
- **WHEN** `package-lock.json`, `docs/supply-chain/inventory.md` and the supply-chain workflow are
  inspected after this change
- **THEN** the binding SHALL appear in all three with an exact resolved version and an integrity
  hash
- **AND** `npm audit --audit-level=high --omit=dev` SHALL include it in its blocking scope

#### Scenario: a silently-changed storage engine fails CI rather than shipping
- **WHEN** the running binding's `sqlite_version()` differs from the version recorded in
  `docs/supply-chain/inventory.md`
- **THEN** the supply-chain job SHALL fail with a message naming both versions
- **AND** the failure SHALL occur before any release artifact is produced

#### Scenario: installing with lifecycle scripts disabled produces a working binding (negative control for the refuted objection)
- **GIVEN** a scratch project whose effective `npm config get ignore-scripts` is `true`
- **WHEN** the pinned binding is installed and a database is opened and queried
- **THEN** the install SHALL succeed without compiling, using a prebuilt binary shipped inside the
  npm tarball
- **AND** the query SHALL return its result — establishing that the "a native binding breaks the
  `ignore-scripts` gate" objection, which was the only hard blocker recorded against this choice, is
  false

#### Scenario: the PostgreSQL driver is removed outright, not retained for one directory
- **WHEN** the migration completes across every tier, including the chain archive
- **THEN** the PostgreSQL driver SHALL NOT appear in `package.json` `dependencies`
- **AND** it SHALL NOT be retained scoped to the archive-sync directory, because that directory is
  ported rather than stranded

#### Scenario: the three archive-touching commands stay coherent across the removal
- **GIVEN** that the typecheck configuration compiles the archive-sync directory, the build
  configuration excludes it, and an npm script executes it directly
- **WHEN** the PostgreSQL driver is removed
- **THEN** each of those three commands SHALL either succeed, or fail for a reason recorded in the
  cross-change register
- **AND** none SHALL fail with an unresolved import of the removed dependency

#### Scenario: an unpinnable platform module is rejected even though it is otherwise capable (negative control)
- **GIVEN** a hypothetical implementation that imported Node's built-in `node:sqlite` instead
- **WHEN** the running Node version changes within the range permitted by `package.json`
  `engines` (`>=24`)
- **THEN** that implementation's SQLite version and module API surface CAN change with no lockfile
  diff, no inventory diff, no CI signal and — measured at the declared floor — no runtime warning of
  any kind
- **AND** UmbraDB's commitment at `docs/STABILITY.md:18` ("No breaking changes to the exported
  surface or the error-`code` set in a minor or patch release") would then be a promise about a
  substrate whose platform reserves the opposite right — which is why the pinned binding is required

### Requirement: the database handle is owned by a dedicated worker thread and never escapes it

The database handle SHALL be constructed inside, and confined to, a single dedicated worker thread.
No module reachable from the public barrel SHALL expose the handle, a statement object, or any
other object whose methods execute SQL, to the main thread.

WHEN a caller issues a query, the system SHALL transport the statement and its bound parameters to
the worker as a message and return the decoded rows as a message.

WHERE a sequence of statements is entirely UmbraDB-authored (for example the composite issued by
`saveAndAdvance`), the system SHALL transport it as a single program in one round trip rather than
one round trip per statement.

#### Scenario: no database handle is reachable from the public surface
- **WHEN** every value re-exported from the package-root barrel is inspected at runtime, including
  transitively through returned objects
- **THEN** none SHALL be, or expose, the binding's `Database` or `Statement` object
- **AND** a caller SHALL have no supported way to execute SQL other than through the adapters

#### Scenario: an UmbraDB-authored composite costs one round trip, not one per statement
- **WHEN** the composite that writes a checkpoint and advances its cursor in one transaction is
  executed
- **THEN** the number of main-thread-to-worker round trips SHALL be independent of the number of
  statements in that composite

#### Scenario: a caller-supplied transaction body cannot be amortised, and the spec says so rather than implying otherwise
- **GIVEN** a caller invoking `withTransaction(fn)` where `fn` issues three statements
- **WHEN** those statements execute
- **THEN** each SHALL cost its own round trip, because `fn` is arbitrary caller code running on the
  main thread and cannot be shipped to the worker as a program
- **AND** this SHALL be documented as a known cost of the worker boundary, not presented as
  amortisable

### Requirement: a transaction handle is an opaque token that cannot be used to reach the database

A `TransactionHandle` SHALL be an opaque token minted by the worker. It SHALL NOT contain, wrap, or
provide access to a database handle, a statement, or a connection.

WHEN a statement is submitted with a transaction token, the worker SHALL validate that token against
its own table of live transactions before executing anything, and SHALL reject a token it did not
mint or that names a transaction that has ended.

#### Scenario: a fabricated token executes nothing
- **WHEN** a caller constructs a value structurally identical to a valid `TransactionHandle` without
  obtaining it from the system, and submits a statement with it
- **THEN** the statement SHALL NOT reach SQLite
- **AND** the call SHALL fail with a typed error rather than executing against an ambient connection

#### Scenario: a retained token stops working when its transaction ends
- **WHEN** a caller retains a `TransactionHandle` after its transaction has committed or rolled back,
  and submits a statement with it
- **THEN** the statement SHALL NOT execute

#### Scenario: the guard is a barrier rather than a check (contrast with the current implementation)
- **GIVEN** today's implementation, in which `resolveTransaction` returns a live driver object across
  a module boundary, so a caller holding a handle holds database access and the reuse guard is a
  check performed by cooperating code
- **WHEN** the worker boundary is in place
- **THEN** the caller SHALL hold no object capable of executing SQL, so the guard SHALL hold even
  against a caller that deliberately reaches around it — this is the property the worker boundary
  exists to add

### Requirement: the connection factory opens exactly one database file and rejects options that no longer mean anything

The connection factory SHALL accept a filesystem path identifying exactly one database file, and
SHALL NOT accept or simulate a connection pool.

**The factory and its owning worker are per database file, not per process.** A process that opens
more than one UmbraDB database file — as one opening both the wallet file and the archive file
does — SHALL obtain one factory result and one owning worker per file. Every per-connection
structure the engine layer owns — the prepared-statement cache, the transaction-token table, the
cancellation flag and the stream registry — SHALL be scoped to a single file's worker and SHALL NOT
be shared across files.

#### Scenario: two database files in one process do not share engine state
- **WHEN** a process opens two UmbraDB database files
- **THEN** each SHALL have its own worker and its own transaction-token table
- **AND** a transaction token minted for one file SHALL NOT be accepted by the other
- **AND** cancelling a statement on one file SHALL NOT abort a statement on the other

The factory SHALL reject, with a thrown error naming the offending key, any option key that is not
part of its declared option surface — including the retired keys `connectionString`,
`maxConnections`, `connectTimeout` and `idleInTxTimeoutMs`.

The factory SHALL NOT forward an unrecognised option key to the binding.

#### Scenario: a retired durability bound fails loudly instead of being dropped
- **WHEN** the factory is called with `idleInTxTimeoutMs` (or any other retired key) set
- **THEN** it SHALL throw an error naming that key
- **AND** it SHALL NOT open a database

#### Scenario: forwarding the old option bag would silently drop every bound (negative control)
- **GIVEN** a hypothetical compatibility implementation that forwarded today's option object to the
  binding unchanged
- **WHEN** a caller passed `maxConnections`, `connectTimeout` and `idleInTxTimeoutMs`
- **THEN** the binding CAN accept all of them silently and open normally — measured behaviour, not
  hypothesis
- **AND** that implementation would present a client which appears to honour three durability and
  concurrency bounds while enforcing none, which is the failure this requirement's rejection rule
  prevents

#### Scenario: the pre-tag window is what makes these removals affordable
- **WHEN** the surface changes in this requirement are recorded
- **THEN** they SHALL be recorded as landing before the `1.0.0` tag, under
  `docs/STABILITY.md:46` ("Current version: `0.9.5` — the commitments above are NOT yet in force")
  and `:60-61` (a breaking change between `0.9.5` and `1.0.0` is permitted)
- **AND** the record SHALL state the post-tag cost: each of the removed exports would independently
  force a major version bump

### Requirement: the pragma bootstrap is an ordered, once-only sequence whose effect is verified by read-back

WHEN a database file is created, the system SHALL apply its bootstrap pragmas in an order in which
`page_size` and `auto_vacuum` are set **before** `journal_mode`, and before any write occurs.

After the bootstrap sequence, the system SHALL read back `page_size`, `auto_vacuum` and
`journal_mode` and SHALL fail with a typed error if any observed value differs from the intended
value.

The system SHALL NOT treat the pragma statements' own success as evidence that the settings took
effect.

#### Scenario: the intended file geometry is achieved and confirmed
- **WHEN** a new database file is bootstrapped
- **THEN** the read-back SHALL report the intended `page_size` and `auto_vacuum` mode together with
  `journal_mode=wal`
- **AND** startup SHALL proceed only after that confirmation

#### Scenario: setting WAL first silently produces a permanently mis-configured database (negative control)
- **GIVEN** a hypothetical bootstrap that issues `PRAGMA journal_mode = WAL` first and then sets
  `page_size` and `auto_vacuum`
- **WHEN** it runs against a fresh file
- **THEN** every pragma statement CAN report success while the file is left at `page_size=4096` and
  `auto_vacuum=0` — measured, both orderings "succeed"
- **AND** the condition is permanent: `auto_vacuum` cannot be retrofitted and `page_size` cannot be
  changed without a full `VACUUM`, so the read-back assertion above is the only runtime mechanism
  that distinguishes this outcome from the intended one

#### Scenario: a database that did not receive the bootstrap is refused rather than used
- **WHEN** an existing database file is opened whose `page_size` or `auto_vacuum` differs from the
  intended values
- **THEN** the system SHALL fail with an error that names the observed and intended values
- **AND** SHALL NOT silently proceed, since neither setting can be corrected in place

### Requirement: every bound parameter is normalised before it reaches the binding

The query façade SHALL normalise every bound value before binding: `undefined` and `null` to SQL
NULL; `boolean` to `1`/`0`; `Date` to an **integer count of milliseconds since the Unix epoch**;
`Buffer`/`Uint8Array` to a byte array; `bigint`, `number` and `string` unchanged.

The façade SHALL throw on any other object type rather than passing it to the binding.

No adapter SHALL bind a `Date`, a `boolean`, or an arbitrary object directly.

#### Scenario: a point-in-time read returns the row the caller asked for
- **WHEN** a caller reads as of an instant `T` for a key that has several versions written before and
  after `T`
- **THEN** the returned version SHALL be the one in force at `T`
- **AND** this SHALL hold for instants that fall between adjacent versions, not only for instants
  equal to a stored coordinate

#### Scenario: a Date bound positionally without normalisation corrupts a proved property (negative control)
- **GIVEN** a hypothetical implementation that binds `asOf.at` directly, as
  `src/postgres/temporal-kv.ts:254` and `:257` do today for PostgreSQL
- **WHEN** the point-in-time read executes
- **THEN** on one candidate binding the `Date` CAN be stored as SQL NULL with no error raised, and
  on the other the bind CAN throw — the first outcome being measured, silent, and undetectable by
  any test that does not assert on a specific instant
- **AND** because those two call sites implement law T3 (`Formal/STORAGE_ALGEBRA.md` §1), the silent
  outcome is a falsification of a Lean-mechanised law introduced by a parameter conversion, which is
  why normalisation is specified as a requirement of the façade rather than a convention for call
  sites

#### Scenario: normalising a Date to ISO-8601 text is also wrong, and is caught rather than tolerated (negative control)
- **GIVEN** a hypothetical façade that normalised `Date` to ISO-8601 text
- **WHEN** it wrote a timestamp into a column declared `INTEGER` in a `STRICT` table
- **THEN** the write SHALL be rejected with a datatype-mismatch error rather than stored
- **AND** had the table not been `STRICT`, the text CAN be stored silently and every subsequent
  `written_at <= T` comparison CAN return the latest version for every `T`, because SQLite sorts
  every INTEGER before every TEXT — so this requirement's integer rule and the schema capability's
  `STRICT` rule are jointly load-bearing and neither may be dropped alone

### Requirement: result columns are decoded from origin metadata, never from declared type names

The query façade SHALL determine each result column's decoder from that column's **origin table and
origin column** as reported by the prepared statement's column metadata, together with an explicit
registry entry for derived columns.

The façade SHALL NOT key decoding on a column's declared type name.

IF a result column has no origin metadata and no explicit registry entry, THEN the façade SHALL
throw rather than return an undecoded or default-decoded value.

#### Scenario: decoding survives aliasing and views
- **WHEN** a query selects a column under an alias, or through a view that renames it
- **THEN** the value SHALL be decoded according to its origin column's registered decoder, not
  according to its output name

#### Scenario: a derived column without a registry entry fails closed
- **WHEN** a query returns a column produced by a window function or other expression, for which no
  explicit registry entry exists
- **THEN** the façade SHALL throw an error naming the column
- **AND** SHALL NOT fall through to a default decoding

#### Scenario: declared-type decoding is structurally impossible under the chosen schema (negative control)
- **GIVEN** a hypothetical façade keyed on declared type names, decoding `JSONB` by parsing,
  `TIMESTAMPTZ` to a `Date` and `BYTEA` to a byte buffer
- **WHEN** the tables are declared `STRICT`
- **THEN** those declared type names SHALL be rejected by SQLite at DDL time — measured:
  `unknown datatype for <table>.<column>: "JSONB"`, and likewise for `BYTEA`, `TIMESTAMPTZ`,
  `BIGINT` and `INT4`
- **AND** the only declared types `STRICT` admits collapse a JSON document and a plain string to the
  same `TEXT`, so the hypothetical façade cannot distinguish them at all — which is why origin
  metadata, and not declared type text, is the required key

#### Scenario: two columns of the same logical type decode differently if the registry is incomplete (negative control)
- **GIVEN** a diagnostic view exposing a validity interval whose start column resolves to a stored
  column and whose end column is produced by a window function
- **WHEN** a row is read through that view with no explicit registry entry for the derived column
- **THEN** the two columns of the same logical type CAN decode to different JavaScript types — a
  silent wrong-type result rather than an error
- **AND** the fail-closed rule above is what converts this into a caught error

### Requirement: 64-bit integer values round-trip without precision loss

The system SHALL read integer columns with 64-bit fidelity, and SHALL then downcast only those
columns whose registered decoder declares a JavaScript `number` representation.

The system SHALL NOT rely on the binding's default integer mode.

#### Scenario: a version at the top of the 64-bit range survives a round trip
- **WHEN** a value near the maximum signed 64-bit integer is written to a version-like column and
  read back
- **THEN** the value read SHALL be exactly the value written, as a `bigint`

#### Scenario: the binding's default integer mode silently truncates (negative control)
- **GIVEN** a hypothetical implementation that used the chosen binding's default integer mode
- **WHEN** the maximum signed 64-bit integer is written and read back
- **THEN** it CAN be returned as `9223372036854776000` with no error raised — measured; and
  `2^53 + 1` CAN be returned as `2^53`
- **AND** because UmbraDB's `version` is typed as `bigint` end to end
  (`src/postgres/client.ts:10`, `:182`), this would be silent corruption of a monotonic counter, so
  64-bit read mode is mandatory rather than advisory

#### Scenario: the trap is recorded as introduced by the driver choice, not inherited
- **WHEN** the driver decision record is inspected
- **THEN** it SHALL state that the rejected alternative binding *throws* in this situation while the
  chosen one truncates, and that closing this trap is part of the price of the choice

### Requirement: text that SQLite stores incorrectly is rejected at the boundary

The system SHALL reject, with a validation error, any caller-supplied string containing a NUL byte
or an unpaired UTF-16 surrogate — at every input where it is rejected today, including namespace,
scope, key, recursively through stored JSON values, and `listKeys`'s prefix.

The guard SHALL be retained through the migration. Its justification text SHALL be rewritten from
"PostgreSQL cannot store either" to state that SQLite silently corrupts both.

#### Scenario: both classes of hostile text are refused
- **WHEN** a caller supplies a key containing a NUL byte, or a JSON value containing an unpaired
  surrogate
- **THEN** the call SHALL fail with a validation error
- **AND** nothing SHALL be written

#### Scenario: removing the guard as "Postgres-specific" introduces silent corruption (negative control)
- **GIVEN** a hypothetical migration cleanup that deleted the guard on the grounds that its message
  names PostgreSQL
- **WHEN** a value containing an unpaired surrogate is written and read back
- **THEN** SQLite CAN accept it and return it with the surrogate replaced by U+FFFD, so the value
  read is not equal to the value written, with no error at any layer — measured
- **AND** a value containing a NUL byte CAN be accepted while `length()` reports 1 for a
  three-code-unit string, so `LIKE`, `length()` and ordering disagree with the stored value —
  measured
- **AND** PostgreSQL *refused* both inputs while SQLite *corrupts* both, so deleting the guard
  converts a loud rejection into silent data corruption; the guard is therefore renamed and
  re-justified, never removed

### Requirement: no statement is issued with more bound parameters than the engine accepts

The query façade SHALL split any batch whose bound-parameter count would exceed the engine's
compiled `SQLITE_MAX_VARIABLE_NUMBER` into statements that do not, and SHALL derive that limit from
the running engine rather than from a hard-coded constant.

No adapter SHALL be required to know the limit.

#### Scenario: a batch far above the limit succeeds by being split
- **WHEN** a batch is submitted whose naive form would bind 60,000 parameters
- **THEN** the operation SHALL complete successfully
- **AND** no individual prepared statement SHALL bind more than the engine's reported maximum

#### Scenario: today's constants fail on day one if carried over unchanged (negative control)
- **GIVEN** `src/postgres/checkpoint-store.ts:62-63`, which sets `CHUNK_INSERT_MAX_ROWS = 30_000`
  (2 parameters per row) and `JUNCTION_INSERT_MAX_ROWS = 20_000` (3 parameters per row), both
  deliberately sized at 60,000 parameters against PostgreSQL's 65,534 cap as that file's own
  comments state
- **WHEN** such a statement is prepared against the SQLite engine, whose compiled maximum is 32,766
- **THEN** preparation SHALL fail with `too many SQL variables` — measured, including the exact
  boundary: 16,383 rows × 2 parameters prepares, 16,384 × 2 does not
- **AND** the failure is a runtime error at the first large save rather than a tuning issue, which is
  why the limit is read from the engine and enforced by the façade

### Requirement: a long read does not starve the main thread

WHILE a query is executing inside the worker, the main thread's event loop SHALL remain able to run
timers, I/O callbacks and immediates.

WHEN a result set is streamed, the façade SHALL yield to the main thread's macrotask queue between
batches rather than materialising the whole set in one blocking step.

#### Scenario: the event loop keeps ticking during a large scan
- **WHEN** a query is executed whose in-engine cost is hundreds of milliseconds
- **THEN** a timer scheduled on the main thread before the query SHALL fire while the query is still
  running
- **AND** measured main-thread event-loop lag SHALL stay within the same order of magnitude as its
  idle baseline

#### Scenario: running the synchronous binding on the main thread blocks it proportionally to the work (negative control)
- **GIVEN** a hypothetical in-process implementation with the synchronous binding on the main thread
- **WHEN** a large result set is materialised, or a large blob is written
- **THEN** the event loop CAN be blocked for the full duration — measured at 429 ms for a 500k-row
  materialisation and 237 ms for a 64 MiB blob write, against a 0.15–0.3 ms idle baseline
- **AND** for a library embedded in a wallet client whose sync loop and RPC keep-alives share that
  loop, a stall of that length is a dropped heartbeat, which is the liveness defect the worker
  boundary exists to fix

### Requirement: a result set is streamed across the worker boundary in batches, and a stream can never wedge the writer

WHEN a caller iterates a result set, the worker SHALL hold the underlying statement iterator and the
main thread SHALL pull **one batch per round trip**, yielding that batch's rows to the consumer
individually.

The system SHALL NOT materialise the full result set before yielding its first row, and SHALL NOT
send one message per row.

WHILE a statement iterator is open on the database handle, the system SHALL treat the handle as
unavailable for writes, and SHALL release the iterator — restoring write availability — when the
stream ends, is aborted, or exceeds its idle deadline.

WHEN a stream's consumer does not request a further batch within the configured idle deadline, the
worker SHALL release the iterator on its own initiative, and the stream SHALL fail on its next pull
with a typed error.

WHEN an abort is signalled on the main thread, the worker SHALL release the iterator, and the
iteration SHALL reject rather than complete successfully.

The worker SHALL release every outstanding iterator before closing the database handle.

The batch size and the idle-deadline interval SHALL be established by measurement across the worker
boundary and SHALL NOT be fixed by this specification.

#### Scenario: the first row is observable long before the scan completes
- **WHEN** a query matching a large number of rows is iterated
- **THEN** the consumer SHALL observe the first row after approximately one round trip plus one
  batch of engine iteration
- **AND** the elapsed time to that first row SHALL be a small fraction of the time the same query
  takes to materialise in full

#### Scenario: an implementation that materialises first is detected rather than merely discouraged (negative control)
- **GIVEN** a hypothetical implementation that answered a stream request by collecting every matching
  row in the worker and returning them in one message
- **WHEN** the query matches a large number of rows
- **THEN** time-to-first-row SHALL be indistinguishable from time-to-last-row, and the assertion
  comparing the two SHALL fail
- **AND** that ratio is the observation which falsifies this requirement, so it SHALL be asserted as a
  ratio between two timings rather than described as a property of the implementation's shape

#### Scenario: a row-per-message stream is also rejected (negative control)
- **GIVEN** a hypothetical implementation that sent one message per row to obtain maximum
  incrementality
- **WHEN** a large result set is drained
- **THEN** the round-trip count SHALL equal the row count, and because per-round-trip transport cost
  grows with payload rather than being fixed, the drain CAN cost orders of magnitude more than the
  engine work it wraps
- **AND** the batch protocol is required precisely because this implementation and the materialising
  one above are both wrong, which is why batching is specified rather than left to the implementer

#### Scenario: a half-consumed stream does not stop the process from writing
- **GIVEN** a consumer that begins iterating, stops requesting further rows, and neither aborts nor
  closes the iteration
- **WHEN** the configured idle deadline elapses
- **THEN** the worker SHALL release the iterator without the consumer's cooperation
- **AND** a write issued after that release SHALL succeed
- **AND** the abandoned stream SHALL fail with a typed error if the consumer later resumes it

#### Scenario: without the worker-side deadline, an abandoned stream blocks every write (negative control)
- **GIVEN** a hypothetical implementation that relied on the consumer to release the iterator, as the
  current PostgreSQL implementation's own documentation concedes it must — an async generator
  suspended at `yield` runs no code and cannot be pushed from outside
- **WHEN** a consumer suspends mid-iteration and never resumes
- **THEN** a write on the same handle CAN be refused for as long as the stream stays open — measured:
  the binding reports the connection busy while an iterator is open, and reads continue to succeed
  while writes do not
- **AND** under PostgreSQL the same abandonment cost only a pooled connection, so a wedged writer is a
  **new** consequence of the embedded engine, which is why release is specified as a worker-side
  obligation rather than inherited as an already-accepted limitation

#### Scenario: an abort mid-stream releases the iterator and rejects the iteration
- **WHEN** an abort is signalled while a stream is part-way through a large result set
- **THEN** the iteration SHALL reject with an abort error rather than completing successfully
- **AND** the iterator SHALL be released, evidenced by a subsequent write succeeding
- **AND** the release SHALL NOT depend on protocol-level query cancellation, which does not exist for
  this engine — the mechanism is a release message to the worker plus the worker's own idle deadline

#### Scenario: the worker cannot be shut down with a stream still open
- **WHEN** the worker is asked to close the database handle while an iterator remains open
- **THEN** it SHALL release the outstanding iterator first
- **AND** the close SHALL succeed, rather than failing with the engine's connection-busy error

#### Scenario: the batch size is justified by measurement, not chosen
- **WHEN** the batch size and the idle deadline are set
- **THEN** each SHALL cite a datum from the measurement artifact taken **across the worker boundary**
- **AND** an in-process measurement SHALL NOT be accepted as justification, because it omits the
  transport cost the batch size exists to trade against
- **AND** the measurement SHALL record observed abort latency at each candidate batch size, since an
  abort arriving mid-batch is not observable until that batch ends

### Requirement: a cancellable statement carries a per-row guard whose argument cannot be hoisted

The system SHALL define exactly one guard user-defined function, registered as **non-deterministic**,
which on each invocation reads a cancellation flag from a `SharedArrayBuffer` shared with the main
thread and throws a distinguished internal error when the flag is set or the statement's deadline has
passed.

**The guard's argument SHALL depend on every table in the statement.** A guard call whose argument is
constant, absent, or dependent on only a proper subset of the statement's tables SHALL NOT be used,
because SQLite evaluates such a term once per iteration of the loop level at which its arguments
become available rather than once per visited row.

The **shim** SHALL inject the guard call into the statement text for every statement in the guarded
classes. Call sites SHALL NOT write guard calls themselves.

The system SHALL enumerate the **guarded classes** (statements with a `WHERE` clause slot in which a
row-correlated guard term can be placed) and the **unguarded classes** (statements with no such slot,
and any operation whose cost lies inside the engine with no per-row callback). The enumeration SHALL
be exhaustive over the statements UmbraDB issues.

#### Scenario: a guarded statement aborts promptly when the flag is set
- **WHEN** the main thread sets the cancellation flag while a guarded row-visiting statement is
  running in the worker
- **THEN** the statement SHALL stop before completing
- **AND** the guard SHALL have been invoked once per visited row up to that point

#### Scenario: a constant or absent argument is hoisted and the statement is silently unabortable (negative control)
- **GIVEN** a hypothetical guarded statement written the obvious way — the guard with no argument, or
  with a constant argument — joining two tables of 3,000 rows each
- **WHEN** it runs over the 9,000,000 visited rows
- **THEN** the guard SHALL be invoked **3,000** times, not 9,000,000 — measured, and measured even
  with non-deterministic registration
- **AND** the statement therefore looks guarded, passes review, and is abortable at roughly one
  opportunity in three thousand

#### Scenario: an argument depending on only some of the statement's tables is also hoisted (negative control)
- **GIVEN** a two-table join and a guard argument referencing exactly one of the two tables — a form
  that satisfies any reading of "row-dependent"
- **WHEN** it runs over the same 9,000,000 visited rows
- **THEN** the guard SHALL be invoked **3,000** times, whichever of the two tables the argument names
  — measured for both — because the planner evaluates the term at the loop level where its single
  dependency becomes available, and may reorder the join so that table is the outer loop
- **AND** only an argument depending on **every** table in the statement SHALL be invoked 9,000,000
  times, which is why this requirement is written against hoistability rather than against
  "row-dependence"

#### Scenario: a single-table test would not catch either defect (negative control)
- **GIVEN** a test exercising the guard on a single-table range scan — the shape of UmbraDB's own
  key-listing query
- **WHEN** the constant-argument form is measured on it
- **THEN** the guard SHALL be invoked once per row (200,000 of 200,000, measured) and the test SHALL
  pass
- **AND** the hoisting defect is therefore invisible to a single-table test and appears only on
  multi-table statements, so the conformance test for this requirement SHALL use a join

#### Scenario: statements with no guard slot are enumerated rather than assumed guarded
- **WHEN** a statement has no `WHERE` clause in which a row-correlated term can be placed — for
  example a bare aggregate over a whole table
- **THEN** the guard SHALL be invoked zero times, measured
- **AND** that statement SHALL appear in the unguarded enumeration, and SHALL NOT be described
  anywhere as cancellable

### Requirement: statement deadlines are enforced in flight where a guard is possible, and detected at completion where it is not

WHERE a statement belongs to a guarded class, the system SHALL enforce its deadline **in flight**:
the statement is aborted when the deadline passes and the caller receives a typed timeout error.

WHERE a statement belongs to an unguarded class, the system SHALL detect the deadline breach **at
completion** and surface a typed after-the-fact fault that distinguishes "exceeded its deadline and
ran to completion anyway" from "aborted at its deadline".

The system SHALL NOT claim mid-execution cancellation for statements it cannot abort — specifically
those whose cost lies inside SQLite with no per-row callback, and those whose text UmbraDB does not
control.

#### Scenario: a guarded statement exceeding its deadline is aborted in flight
- **WHEN** a guarded statement runs past its configured deadline
- **THEN** it SHALL be aborted before completing
- **AND** the caller SHALL receive a typed timeout error rather than waiting for completion

#### Scenario: an unguarded statement exceeding its deadline is reported, not silently tolerated
- **WHEN** an unguarded statement runs past its configured deadline
- **THEN** it SHALL run to completion
- **AND** the caller SHALL receive a typed fault distinguishing this outcome from an in-flight abort,
  rather than a success, or a timeout indistinguishable from a real abort

#### Scenario: an unconditional deadline claim contradicts its own uncancellable enumeration (negative control)
- **GIVEN** a hypothetical requirement stating unconditionally that any statement exceeding its
  deadline is aborted, while two sentences later enumerating statements it cannot abort
- **WHEN** a reader tries to determine what happens to a statement in the second list
- **THEN** the specification CAN be read as promising an abort the mechanism cannot perform
- **AND** the guarded/unguarded split above exists precisely so no statement class is left without a
  stated outcome

#### Scenario: an abort issued from the main thread takes effect while the statement is running
- **WHEN** the main thread signals cancellation of a running row-visiting statement
- **THEN** that statement SHALL stop before completing
- **AND** the main thread SHALL remain responsive throughout

#### Scenario: the statements that remain uncancellable are enumerated, not glossed
- **WHEN** the cancellation behaviour is documented
- **THEN** the documentation SHALL name the cases that cannot be aborted — statements issued by
  caller code inside a transaction callback, and any operation whose cost is inside the engine with
  no per-row guard
- **AND** it SHALL state that neither candidate binding exposes an interrupt primitive, so this is a
  property of the engine layer and not an implementation shortfall
- **AND** the corresponding change to the published cancellation contract SHALL be made by the
  release-contract capability, not silently absorbed here

### Requirement: every performance-dependent decision is blocked on measurements taken on a real filesystem under declared conditions

The system SHALL publish a machine-readable measurement artifact in which every datum records:
filesystem and mount options; `journal_mode`; `synchronous`; `page_size`; `auto_vacuum`; dataset size
and host RAM; whether a concurrent writer was present; and the binding and `sqlite_version()`.

The artifact SHALL include at least one `synchronous=FULL` datum, at least one `synchronous=NORMAL`
datum, and at least one datum whose dataset exceeds the host page cache sufficiently to exhibit
throughput decay rather than only its first point.

CI SHALL assert that the artifact exists and that its declared filesystem is not a memory-backed
filesystem.

No requirement, design decision or contract statement in this migration SHALL cite a throughput,
latency or rejection-rate figure that is not present in that artifact with its conditions attached.

#### Scenario: the artifact is complete enough to decide the pragma values
- **WHEN** the measurement suite is run and its artifact is inspected
- **THEN** it SHALL contain the commit-rate and ingest figures at both `synchronous` settings on a
  non-memory-backed filesystem
- **AND** each figure SHALL carry the full condition set above

#### Scenario: a memory-backed measurement is refused
- **WHEN** the artifact declares a memory-backed filesystem
- **THEN** CI SHALL fail
- **AND** the failure message SHALL state that the figures are not admissible

#### Scenario: research-phase figures are invalid and their reuse is prevented (negative control)
- **GIVEN** the research-phase figures, six of seven lanes of which were measured against a RAM disk
- **WHEN** those figures are compared with a re-measurement on a real filesystem
- **THEN** WAL `synchronous=FULL` commit throughput SHALL be seen to differ by **at least two orders
  of magnitude** — the research-phase re-measurement observed a factor in the low hundreds, and this
  requirement fixes the *finding* (the figures are invalid by orders of magnitude, not by a margin)
  without preordaining the ratio a fresh run must produce
- **AND** two of the archive lane's stated conclusions SHALL be seen to invert — including a
  published claim that `synchronous=FULL` was *faster* than `NORMAL`, which is physically impossible
  and was a visible tell
- **AND** any requirement citing an unattributed figure SHALL be treated as unsupported, because a
  figure whose conditions are absent cannot be distinguished from one of these

#### Scenario: out-of-cache behaviour is measured rather than extrapolated
- **WHEN** the large-dataset datum is examined
- **THEN** it SHALL report throughput per window across the run rather than a single aggregate
- **AND** the decay curve SHALL be recorded, since a re-measurement on real disk showed throughput
  falling by a factor of 2.64 over 2.4 GB and still falling at the end of the run — so a flat
  extrapolation from any single point is unsupported

### Requirement: the decisions blocked on the measurement gate are named, and none of them is settled by this change

The change SHALL enumerate every downstream decision that cannot be made until the measurement
artifact exists, naming for each the capability that owns it and the specific datum it needs.

The enumeration SHALL include the temporal capability's logical-clock decision.

No blocked decision SHALL be presented as settled anywhere in this migration until its datum is
present in the artifact.

#### Scenario: the clock decision is explicitly conditional
- **WHEN** the blocked-decision list is inspected
- **THEN** it SHALL record that the research finding "99.2% of same-key puts rejected" is 0.0% at
  `synchronous=FULL`, so the entire clock redesign is downstream of a setting the originating lane
  never varied
- **AND** it SHALL record that narrowing the corresponding error code's retryability marking would be
  a forbidden weakening of a frozen commitment, so adopting the redesign on an inadmissible figure
  would break a commitment to fix a problem that may not exist
- **AND** it SHALL name the datum required to close it: the same-key collision rejection rate at the
  chosen `synchronous` value on a real filesystem

#### Scenario: a blocked decision cannot be closed by assertion
- **WHEN** any change in this migration states a value for a blocked decision
- **THEN** that statement SHALL cite the artifact datum that supports it
- **AND** in the absence of such a datum the statement SHALL be treated as an open question rather
  than a design decision

### Requirement: the conformance suite is re-executed against the new engine rather than amended to suit it

The property-based conformance suite that carries the abstract-to-concrete refinement claim SHALL be
re-executed against the SQLite build.

A conformance property SHALL NOT be weakened, reworded or removed in order to pass against the new
engine; a property that fails SHALL be treated as a defect in the implementation until proven
otherwise.

The change SHALL record that the Lean cut-line's survival is not evidence that the migration is
safe.

#### Scenario: the suite runs green against the new engine without textual change
- **WHEN** the conformance suite is executed against the SQLite build
- **THEN** every property SHALL pass
- **AND** the property texts SHALL be unchanged from those that ran against PostgreSQL, apart from
  fixture wiring

#### Scenario: an unchanged formal layer is not offered as assurance (negative control)
- **GIVEN** that the mechanised cut-line survives a complete storage-engine replacement with no
  proof edited
- **WHEN** the safety of the migration is assessed
- **THEN** that survival SHALL NOT be cited as evidence of safety, because it follows from the proofs
  modelling an abstract store across a trusted, unmechanised refinement bridge
- **AND** the concrete illustration SHALL be recorded: a parameter-conversion defect in the bind
  layer can falsify the temporal-projection law without touching a single line of the proof
