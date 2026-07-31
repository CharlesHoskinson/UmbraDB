# transaction-lease (SQLite implementation)

The SQLite-backed implementation of the transaction/lease contract at
`src/interfaces/transaction-lease.ts` (`design/design-interfaces.md` §3.1). Requirements below
follow EARS, as in Sprint 2's and Sprint 7's spec files.

This capability has **no merged spec** in `openspec/specs/` — Sprint 2's `transaction-lease` delta
is itself unmerged — so these requirements are written as `## ADDED Requirements` and **supersede**
Sprint 2's delta wherever the two describe the same behaviour. Where a Sprint 2 requirement is not
restated here it is unchanged; no requirement below removes a guarantee from the frozen surface, and
none changes a type in `src/interfaces/transaction-lease.ts`.

**No requirement below asserts a performance number.** Six of seven research lanes benchmarked on a
tmpfs RAM disk, so every millisecond figure in the corpus is void; requirements are stated against
observable outcomes, and the quantities the implementation needs are requirements to *establish* a
number behind `v1.0.0-sqlite-engine-core`'s measurement gate.

## ADDED Requirements

### Requirement: per-key lease mutual exclusion is enforced in-process and uses no lock file

For any lease `key`, at most one holder exists at any instant (Law L1,
`Formal/STORAGE_ALGEBRA.md` §4). The system SHALL enforce this with a process-local per-key FIFO
queue. It SHALL NOT create, open, read, write, lock or unlink any file in order to acquire, hold,
verify or release a lease, and SHALL NOT rely on POSIX record locks (`fcntl`), `flock`, an OS
advisory lock, a lock table row, a heartbeat, a TTL, a fencing token, or any stale-takeover rule.

A lease SHALL be held from acquisition until explicit `releaseLease` or the exit of the holding
process, matching `src/interfaces/transaction-lease.ts:31-33` verbatim ("no TTL, no self-expiry, no
stealing").

#### Scenario: Concurrent in-process acquirers on one key never overlap
- **WHEN** N concurrent `withLease` calls are issued on one key from independent callers in one
  process, each holding an instrumented critical section that awaits
- **THEN** the instrumented maximum concurrent holder count SHALL be 1
- **AND** every call SHALL acquire and complete — none SHALL fail with `LeaseTimeoutError`
- **AND** this SHALL hold for the same N and the same critical-section shape the existing P10
  property test uses, so the assertion is comparable to the Postgres run it replaces

#### Scenario: Reading every file UmbraDB owns does not void a held lease (negative control — red-team attack 1)
- **GIVEN** a lease is held in this process
- **WHEN** the same process calls `fs.readFileSync` on the database file, on its `-wal` and `-shm`
  sidecars, and on every other file UmbraDB created under the database's directory
- **THEN** a second in-process acquisition of the same key SHALL still be refused
- **AND** the instrumented maximum concurrent holder count SHALL remain 1
- **AND** the test SHALL enumerate the directory rather than a hardcoded list, so a file added by a
  later change is covered without the test being edited
- **AND** because reading `-wal`/`-shm` **voids the database write lock** for the whole process, this
  scenario SHALL be quarantined: it SHALL run against a throwaway database, with no write transaction
  open and no reliance on the writer-generation guard anywhere in its fixture, and that database
  SHALL be discarded afterwards rather than reused by a later test
- **AND** the test SHALL carry, at the site of the sidecar reads, an explicit note that this act
  voids the adjacent guarantee and is safe **here only** because the lease consults no file — so a
  later author who copies this fixture into a test that does rely on the guard is warned at the point
  of copying

#### Scenario: The lease's immunity and the write lock's exposure are separate claims (implementation note)
- **WHEN** a reader concludes from the scenario above that reading `-shm` is harmless
- **THEN** that conclusion SHALL be false, and the specification SHALL say so adjacently rather than
  relying on the reader to hold two requirements in mind at once
- **AND** the correct statement is: the **lease** survives the read because it consults no file,
  while the **database write lock** does not survive it, so the same act is harmless to one mechanism
  and fatal to the other
- **AND** this pairing is precisely the error an earlier revision of this change made in the opposite
  direction — concluding from a test that read the database file that the write lock was immune,
  when the locks live on a file that test never touched

#### Scenario: Deleting files out from under a held lease does not produce a second holder (negative control — red-team attack 2)
- **GIVEN** a lease is held in this process
- **WHEN** every file UmbraDB created under the database's directory other than the database file
  itself is unlinked
- **THEN** a second in-process acquisition of the same key SHALL still be refused
- **AND** no new file SHALL be created by that acquisition attempt

#### Scenario: A per-key sidecar SQLite lock file is a forbidden implementation (negative control)
- **GIVEN** a hypothetical implementation that acquires a lease by opening a per-key sidecar SQLite
  database and holding `BEGIN IMMEDIATE` open on it — the mechanism research lane L2 proposed and
  called "strictly safer than `pg_advisory_lock`"
- **WHEN** the holding process performs a single `fs.readFileSync` of that sidecar (the `.db` file
  in rollback-journal mode, the `-shm` file in WAL mode)
- **THEN** that hypothetical implementation SHALL grant the lease to a second, simultaneous holder,
  with no error raised to either holder — because a POSIX record lock is dropped when the process
  closes **any** descriptor on the inode, and SQLite's VFS defends only its own descriptors
- **AND** unlinking the sidecar while it is held SHALL likewise produce two simultaneous holders,
  because the next acquirer creates a new inode and therefore a new lock space
- **AND** these are the failure modes the in-process mechanism above exists to make unreachable;
  the positive scenarios verify the real implementation does not exhibit them
- **AND** a test SHALL assert that no source file under the SQLite adapter creates a per-key lock
  file, so the rejected mechanism cannot be reintroduced silently

#### Scenario: A killed holder's lease is released with no takeover rule
- **WHEN** a process holding a lease is terminated with `SIGKILL`
- **THEN** a freshly started process SHALL acquire the same lease key without waiting for any
  expiry, without executing any cleanup step, and without any operator action
- **AND** no lock artifact SHALL remain on the filesystem for an operator to remove

#### Scenario: A filesystem with broken advisory locks does not silently void the lease
- **WHEN** the database is placed on a filesystem where SQLite's own advisory locking does not work
  (a network filesystem, or a WSL `/mnt/c` DrvFs mount)
- **THEN** per-key lease mutual exclusion between in-process callers SHALL be unaffected, because it
  consults no filesystem
- **AND** the separate startup filesystem probe owned by `v1.0.0-sqlite-engine-core` SHALL still
  reject that deployment, because the writer-generation guard and the database's own write lock do
  depend on it

### Requirement: the lease's frozen observable contract is preserved under the new mechanism

WHEN the lease mechanism changes, the observable contract documented on the frozen surface SHALL NOT
change. `acquireLease` without `opts.timeoutMs` SHALL wait indefinitely and SHALL NOT throw
`LeaseTimeoutError`; with `opts.timeoutMs` it SHALL throw `LeaseTimeoutError` on expiry.
`tryAcquireLease` SHALL resolve `null` on contention rather than throwing. Aborting `opts.signal`
during a wait SHALL reject with `AbortError` while the wait is still in progress. `releaseLease` on
an already-released lease SHALL throw `LeaseNotHeldError`. `withLease` SHALL always release, even
when `fn` throws.

The system SHALL NOT introduce a new lease-acquisition outcome, a new option, or a new error class.

#### Scenario: A no-timeout acquire waits rather than failing
- **WHEN** `acquireLease(key)` is called with no `timeoutMs` while another in-process caller holds
  the key
- **THEN** the call SHALL remain pending until the holder releases, then resolve
- **AND** `LeaseTimeoutError` SHALL NOT be thrown, matching
  `src/interfaces/transaction-lease.ts:81-86`

#### Scenario: An abort during a wait rejects while the wait is still in progress
- **WHEN** `opts.signal` is aborted after `acquireLease` has begun waiting for a contended key but
  before the key becomes free
- **THEN** the call SHALL reject with `AbortError` without first acquiring the lease
- **AND** no lease SHALL be left held

#### Scenario: The frozen TSDoc no longer names a PostgreSQL mechanism
- **WHEN** the shipped `dist/index.d.ts` is inspected
- **THEN** `LeaseTimeoutError`'s documentation SHALL NOT contain the clause "matching
  `pg_advisory_lock`'s real blocking semantics" (`src/interfaces/transaction-lease.ts:83`)
- **AND** the behaviour that clause described — indefinite waiting absent a `timeoutMs` — SHALL
  still be documented, because only the mechanism reference is false, not the behaviour

#### Scenario: The release-fault path survives as API and becomes unreachable
- **WHEN** `withLease`'s `fn` succeeds and the lease is released
- **THEN** `releaseLease` SHALL NOT fail from connection death, because the lease has no connection
- **AND** `LeaseFaultError`, `opts.onReleaseFault` and their documented behaviours SHALL remain
  exported and unchanged in shape, since they are frozen surface
- **AND** the fact that the fault has become unreachable SHALL be recorded in writing rather than
  left for a reader to infer from silence

### Requirement: a second writer process is detected and the displaced process is fail-stopped before it can commit

The system SHALL maintain a single-row writer-registration record inside the database file itself,
carrying a monotonically increasing `generation` and an `owner` identifier unique per open. On
opening the database for writing, the system SHALL bump `generation` and record its own `owner`
inside a `BEGIN IMMEDIATE` transaction, and SHALL retain the read-back generation for the life of
the process.

**Invariant I-4 — registration asserts a single affected row and a defined read-back; failure is a
startup error, not an undefined generation.** The registration `UPDATE` SHALL assert that it
affected **exactly one** row, and the read-back SHALL be asserted to return a row whose `owner` and
`generation` are the values just written. IF either assertion fails THEN registration SHALL fail
with a named non-retryable startup error and the process SHALL NOT open the database for writing.
There SHALL be no code path in which the process retains an undefined or absent generation and
continues.

WHILE a process is registered, every write transaction it opens SHALL re-read the registration
record **inside its own `BEGIN IMMEDIATE` transaction, before performing any write**, and IF the
generation differs from the one this process registered THEN the system SHALL roll back and reject
with a typed error that is **non-retryable** and distinct from every contention outcome.

The system SHALL NOT use a process id, a host name, a heartbeat, a TTL, a lock file, or any liveness
inference to make this determination. `pid` and `host` MAY be recorded as diagnostics and SHALL NOT
be read by the protocol.

**This guarantee is conditional on the database write lock being intact, and the condition SHALL be
stated wherever the guarantee is.** SQLite's write lock is a POSIX record lock, which is dropped when
the holding process closes any descriptor on the inode carrying it — `-shm` under WAL. IF any code in
the holding process opens and closes a descriptor on the database's `-wal` or `-shm` file THEN this
guarantee is **absent**, not merely weakened: two processes may both commit, and an acknowledged
commit may be silently lost while `integrity_check` reports `ok`. The system SHALL enforce that
precondition against its own sources (see "no UmbraDB code opens and closes a descriptor…" below) and
SHALL state it as a binding precondition on the embedding application.

The three orderings below are exhaustive over the interleavings of "B registers" against "A's write
transaction", and each has a **different** correct assertion. An implementation or a test that
applies one ordering's assertion to another is wrong even when it passes.

#### Scenario: Registration asserts one affected row and a matching read-back (invariant I-4)
- **WHEN** the registration `UPDATE` runs inside its `BEGIN IMMEDIATE` transaction
- **THEN** the system SHALL assert that the statement reported **exactly one** affected row
- **AND** the system SHALL assert that the read-back returns a row whose `owner` and `generation`
  are the values this process just wrote
- **AND** IF either assertion fails THEN registration SHALL fail with a **named, non-retryable
  startup error**, and the process SHALL NOT proceed to open the database for writing
- **AND** the process SHALL NOT retain an undefined, absent or partially-read generation under any
  circumstances

#### Scenario: Without I-4, an unseeded or emptied registration table is silent (negative control)
- **GIVEN** a hypothetical registration that performs `UPDATE … WHERE id = 1` and reads the
  generation back, but asserts neither the affected-row count nor the read-back
- **WHEN** the registration row is absent — an unseeded table, or a row deleted or emptied after
  seeding
- **THEN** the `UPDATE` SHALL report success while affecting **zero** rows, the read-back SHALL
  return no row, and the process SHALL retain an undefined generation, with nothing raised
- **AND** the resulting guard SHALL be **inert while reporting healthy**: every later comparison of
  an undefined stored generation against an undefined registered generation finds them equal, so
  every write transaction passes the check and two processes can both believe they are the
  registered writer — the failure is not that the guard rejects, it is that the guard stops existing
- **AND** removing **either** assertion SHALL reproduce this, so the negative control SHALL be run
  twice, once per assertion, rather than once against both
- **AND** it SHALL be demonstrated failing against the unguarded form, so a green result against the
  real implementation is evidence rather than coincidence

#### Scenario: I-4 closes the class, not only the seeded instance
- **GIVEN** a lineage whose migration seeds the registration row, making the *initial* zero-row case
  unreachable
- **WHEN** the row is later deleted, truncated, or absent because a restored lineage predates the
  seed
- **THEN** registration SHALL still fail loudly with the named startup error, because I-4 asserts a
  property of the statement's own effect rather than trusting a migration to have run
- **AND** a seeded row SHALL NOT be accepted as a substitute for the assertions: the seed removes one
  instance, and I-4 is what removes the class

#### Scenario: Ordering 1 — B registers between A's transactions, and A is refused at its next one
- **GIVEN** process A has the database open and registered at generation N, and holds **no** open
  write transaction
- **WHEN** process B opens the same database file and registers at generation N+1
- **AND** process A then opens its next write transaction
- **THEN** A's guard read SHALL observe a generation different from N, and the transaction SHALL roll
  back and SHALL NOT commit
- **AND** the rejection SHALL be a typed error whose `retryable` marking is `"non-retryable"`
- **AND** every subsequent write transaction from process A SHALL be rejected the same way
- **AND** this is the reachable case the guard exists for, and the only one of the three in which
  "A is refused" is the correct assertion

#### Scenario: Ordering 2 — B cannot register while A holds a write transaction (the interleaving BEGIN IMMEDIATE prevents)
- **GIVEN** process A holds an open write transaction under `BEGIN IMMEDIATE`, and the write lock is
  intact
- **WHEN** process B attempts to register
- **THEN** B's registration SHALL NOT commit while A's transaction is open: B SHALL observe
  `SQLITE_BUSY` and SHALL wait under the bounded retry policy rather than proceeding
- **AND** A's transaction SHALL commit normally — A SHALL NOT be refused, because no displacement has
  occurred
- **AND** a test asserting "A is refused" here SHALL be treated as a defective test rather than a
  failing implementation: it asserts an interleaving that `BEGIN IMMEDIATE` makes unreachable, and it
  would pass only if the write lock were already void

#### Scenario: Ordering 3 — the interleaving the descriptor attack makes reachable (negative control)
- **GIVEN** process A holds an open write transaction under `BEGIN IMMEDIATE`
- **WHEN** any code inside process A opens and closes a descriptor on the database's `-shm` file —
  a single `fs.readFileSync` is sufficient
- **AND** process B then attempts to write and commit
- **THEN** with the write lock voided, B SHALL succeed: the ordering ordering 2 declares unreachable
  becomes reachable, and the guard's premise no longer holds
- **AND** the two observables that SHALL be asserted are: **no two writers both commit**, and **no
  acknowledged commit is lost** — a `COMMIT` that returned successfully whose row is absent from a
  subsequent read is a failure of this scenario
- **AND** against an implementation permitting the in-process open+close, this scenario SHALL FAIL,
  with both `COMMIT`s returning ok, one acknowledged commit absent, and `integrity_check` reporting
  `ok` — the failure is silent at every layer, which is why it is asserted directly rather than
  inferred from an error
- **AND** it SHALL pass only where the source guard makes the void unreachable from UmbraDB's own
  code, so the scenario measures the guard rather than the engine

#### Scenario: A guard evaluated outside the write transaction is insufficient (negative control)
- **GIVEN** a hypothetical implementation that reads the registration record on a separate
  connection, or before `BEGIN IMMEDIATE`, or on a timer
- **WHEN** a second process registers between that read and the transaction's `COMMIT`
- **THEN** that hypothetical implementation CAN commit a write from a displaced process — the
  time-of-check-to-time-of-use window is exactly what placing the read inside the write transaction
  eliminates
- **AND** an implementation whose safety degrades when an out-of-transaction poll is disabled or
  slowed SHALL be treated as defective, because that is a TTL reintroduced under another name

#### Scenario: A crashed writer does not wedge its successor
- **WHEN** a registered writer process is terminated with `SIGKILL`
- **THEN** the next process to open the database SHALL register successfully and operate
- **AND** no operator step, no stale-record cleanup and no expiry wait SHALL be required
- **AND** the registration record SHALL be readable and internally consistent afterwards, because it
  is an ordinary committed row

#### Scenario: The guarantee is transaction-granular, not lease-granular (stated limit)
- **GIVEN** process A is running a critical section under `withLease` that spans several write
  transactions
- **WHEN** process B registers partway through
- **THEN** transactions A committed before B registered SHALL remain committed, and A SHALL be
  rejected at its next transaction
- **AND** the sequence MAY therefore be torn at a transaction boundary — each transaction stays
  atomic, the multi-transaction sequence does not
- **AND** this limit SHALL be stated in `docs/CONTRACT.md` §5, not left to be discovered

#### Scenario: The fault is not routed to a retryable code (negative control)
- **GIVEN** a hypothetical implementation that surfaces the displacement fault as
  `TransactionFaultError`
- **WHEN** a caller applies the bounded-retry policy that `TRANSACTION_FAULT`'s frozen `retryable`
  marking predicts (`docs/ERROR-CATALOG.md:34`)
- **THEN** every retry SHALL fail identically, because displacement is terminal — the caller spins
  against a permanent condition
- **AND** the real implementation SHALL therefore carry a non-retryable code, so the retry policy the
  marking predicts is the correct one

### Requirement: no UmbraDB code opens and closes a descriptor on the database file or its sidecars

Closing any descriptor on an inode drops that process's POSIX record locks on it, so a single
open-and-close of whichever file carries the write lock voids that lock while an open
`BEGIN IMMEDIATE` still holds it. **Which file that is depends on `journal_mode`:** under `wal` the
locks live on `-shm`; under `delete` and `truncate` there is no `-shm` and they live on the database
file itself.

The system SHALL therefore prohibit, in UmbraDB's own sources, any file-system operation that opens a
descriptor on **the database file or either of its `-wal` / `-shm` sidecars** — including reads,
opens, copies and read streams — and the prohibition SHALL be enforced by an executable check that
fails the build, in the same manner as this migration's ban on `INSERT OR REPLACE`.

The prohibition SHALL be unconditional rather than journal-mode-conditional. `journal_mode` is a
persistent property of the database file and is mutable at runtime, so a build-time check cannot know
which mode a given file will be in; the only statically expressible rule covering every mode is the
union of the files any mode exposes.

Operations that do **not** open a descriptor, such as existence and metadata checks, SHALL remain
permitted, and the check SHALL distinguish them.

The system SHALL additionally state the descriptor precondition as **binding on the embedding
application**, since UmbraDB cannot enforce it against other code sharing its process, and SHALL
state the consequence concretely rather than as a general caution about locking.

#### Scenario: A build-failing check bans descriptor operations on the whole database artifact set
- **WHEN** the sources are scanned
- **THEN** no call SHALL open a descriptor on a database path, nor on a path formed by appending
  `-wal` or `-shm` to one
- **AND** introducing one SHALL fail the build rather than produce a review comment
- **AND** the check SHALL cover indirect construction — a helper that takes the database path and
  derives one of those paths — not only literal string concatenation at the call site

#### Scenario: The write lock's locus is journal-mode-dependent, which is why the ban is not mode-scoped
- **WHEN** an in-process open-and-close is performed on the database file while a write transaction
  is open
- **THEN** under `journal_mode=wal` the write lock SHALL survive, because its locks are on `-shm`
- **AND** under `journal_mode=delete` and `journal_mode=truncate` the write lock SHALL be voided, a
  competing process SHALL commit, and an acknowledged commit SHALL be lost
- **AND** a sidecar-only prohibition SHALL therefore be treated as covering the `wal` case only, and
  as insufficient to support any claim of soundness across journal modes
- **AND** each mode's control arm — no attack performed — SHALL refuse the competing writer, so the
  test demonstrates it detects the property it asserts rather than passing vacuously

#### Scenario: Under the default mode only the sidecars are exposed, and the contract says so
- **WHEN** the embedder-facing precondition is written
- **THEN** it SHALL state the rule over the whole artifact set — database file and both sidecars
- **AND** it SHALL also state that under the shipped `wal` mode a read of the database file is
  harmless and only `-shm` is exposed, so the embedder is given the rule and its reason without being
  told something false in either direction
- **AND** it SHALL name the mutability of `journal_mode` as the reason the rule is stated more
  broadly than the shipped configuration strictly requires

#### Scenario: Metadata operations are not banned, because holding a descriptor is not the fault
- **WHEN** the check encounters an existence or metadata query on a sidecar path that opens no
  descriptor
- **THEN** it SHALL permit it
- **AND** the rule's rationale SHALL record that opening a descriptor and holding it open is
  harmless, and that the ban is nonetheless written against the open rather than the close because
  "open and never close" is not a sustainable discipline — a deliberate over-restriction whose
  direction is justified by the violation being silent data loss

#### Scenario: Every claim resting on write-lock exclusivity carries the precondition
- **WHEN** any requirement, code comment or contract sentence asserts that a competing writer is
  refused, that no other writer can commit for a transaction's duration, or that an external actor
  cannot forge or interleave
- **THEN** it SHALL carry the descriptor precondition explicitly rather than reading as unconditional
- **AND** the claims SHALL be enumerated across **all seven** changes so none is re-derived as
  unconditional later: in this capability, the writer-generation guard's fail-stop, a second process
  being unable to register mid-transaction, the wallet migration lock's **cross-process** exclusion
  (which is the write lock, not the process-local mutex), and `prune`'s C2a safety argument; in
  temporal-kv, trigger soundness under concurrent writers and the transaction-identity guard's
  refusal of forgery from outside the process; in storage-schema, the migration lock's
  `BEGIN IMMEDIATE` reinforcement clause that makes the handover to the generation guard gapless; in
  chain-archive, the row-lock-removal justification and the single-transaction ingest bundle; in
  data-migration, the premise that a whole-import transaction holds the write lock for the import's
  duration
- **AND** each claim's qualifier SHALL appear in **the owning change's own text**, not only in this
  capability's table, because a qualifier recorded solely in a neighbour's design document is how an
  invariant is lost in relay
- **AND** a claim discovered without the qualifier SHALL be treated as a defect in the specification,
  not merely in the prose

#### Scenario: The enumeration is mechanically swept, not authored from recollection
- **GIVEN** that the first version of this enumeration covered five changes and was silently
  incomplete once two more landed — an enumeration presented as complete, the same over-claim shape
  this capability exists to correct elsewhere
- **WHEN** the enumeration is checked
- **THEN** it SHALL be produced by a sweep across **all seven** change directories for the
  exclusivity phrasings — `BEGIN IMMEDIATE`, "single-writer", "write lock", "serializ" — rather than
  from an author's list
- **AND** every hit SHALL be either present in the table with an owner, or explicitly recorded as
  not resting on exclusivity, with no third category
- **AND** the sweep SHALL be re-run whenever a change is added to the sprint, since the defect was
  not that the table was wrong when written but that nothing made it wrong *loudly* when the world
  moved

#### Scenario: Archive exclusivity claims need the writer guard as well as the descriptor precondition
- **WHEN** a claim in the chain-archive capability is justified by "single-writer serialization
  under `BEGIN IMMEDIATE`"
- **THEN** it SHALL carry two qualifiers, not one: the descriptor precondition, **and** the archive
  database file having its own writer-generation registration
- **AND** the reason SHALL be stated: `BEGIN IMMEDIATE` serializes transactions, it does not make a
  process a single writer, so two long-running `archive:sync` instances interleave transactions
  legally and neither is detected
- **AND** this capability SHALL NOT specify that registration — it is the chain-archive capability's,
  recorded here as a handover with a named owner rather than as a deferral

#### Scenario: The precondition on the embedding application is stated with its consequence
- **WHEN** `docs/CONTRACT.md` §5 is read
- **THEN** it SHALL name the descriptor precondition as binding on the embedder
- **AND** it SHALL state the consequence as two writers both committing and an acknowledged commit
  being silently lost with `integrity_check` reporting `ok` — not as unreliable locking
- **AND** it SHALL NOT claim that UmbraDB enforces the precondition against code it does not own

#### Scenario: An in-process three-file copy is the attack performed by our own documentation (negative control)
- **GIVEN** a hypothetical backup procedure that copies the database together with its `-wal` and
  `-shm` files from inside the UmbraDB process while the database is open
- **WHEN** it runs concurrently with a write transaction
- **THEN** it SHALL void the write lock exactly as a hostile reader would, with no error raised
- **AND** the release-contract capability SHALL therefore specify offline copy procedures as
  out-of-process or post-quiesce, which is recorded as a handover rather than specified here

### Requirement: every concurrency object in this capability is scoped per database file

The process opens more than one database file — the wallet lineage and the archive lineage — and
each file has its own independent write lock. The scope of every concurrency object this capability
owns SHALL therefore be stated explicitly rather than left to the implementation, item by item:

- The **write queue** SHALL be per database file. A single process-wide queue would serialize
  transactions against two independent write locks and manufacture contention that does not exist.
- The **per-key lease mutex map** SHALL be keyed by `(database file, lease key)`, not by lease key
  alone. Two layers bound to different files SHALL NOT share a key namespace.
- The **poison flag** SHALL be per transaction, and therefore per file transitively. It SHALL NOT be
  process-wide: a poisoned transaction on one file SHALL NOT affect a live transaction on the other.
- The **transaction-hold watchdog** SHALL be per transaction, and therefore per file transitively.
  Its bound SHALL be resolvable per file, since the two lineages have different write profiles.
- The **transaction-handle registry** SHALL be process-wide as a map — handle identifiers are unique
  across the process — but every entry SHALL record the database file it belongs to.
- The **writer-generation registration** SHALL be per database file: one registration row per file,
  one `myGeneration` per file, checked against the file its transaction belongs to.
- The **migration lock** SHALL be per lineage, and therefore per file.
- The **source guard's descriptor ban** SHALL cover **every** database file the process opens and
  their sidecars — it is the one object here whose scope is process-wide by construction, because it
  is a build-time property of the sources rather than a runtime object.

WHEN a `TransactionHandle` is passed to an adapter bound to a different database file than the one
it was created against, the system SHALL reject it rather than execute against the wrong file. No
transaction SHALL span two database files.

#### Scenario: A transaction handle cannot cross the file boundary
- **WHEN** a handle obtained from a `withTransaction` on the wallet database is passed as `opts.tx`
  to an adapter bound to the archive database
- **THEN** the call SHALL reject with `TransactionHandleInvalidError` rather than executing
- **AND** it SHALL NOT silently execute outside the caller's transaction, which is the failure this
  rejection exists to prevent
- **AND** the rejection SHALL come from the handle's recorded file identity, not from a name or path
  comparison performed by the caller

#### Scenario: Work on one file is not serialized behind the other
- **WHEN** a long write transaction is open on one database file
- **THEN** a write transaction on the other database file SHALL proceed without waiting
- **AND** a lease acquisition on the other file SHALL proceed without waiting, including when both
  files' callers use the *same* lease key string
- **AND** a hold-bound expiry or a poisoned transaction on one file SHALL leave the other file's
  in-flight transaction unaffected

#### Scenario: A process-wide concurrency object is a defect (negative control)
- **GIVEN** a hypothetical implementation with one process-wide write queue, or a lease map keyed by
  bare lease key
- **WHEN** the wallet lineage and the archive lineage are both written
- **THEN** the two lineages SHALL serialize against each other despite holding independent write
  locks, producing contention with no correctness purpose — the archive's sustained ingest would
  block wallet sync and vice versa
- **AND** with a bare-key lease map the two files' leases for the same logical key SHALL exclude each
  other, which is not a safety property but an over-serialization defect

### Requirement: the lease limitation stated in writing is exactly what the mechanism delivers

`docs/CONTRACT.md` §5 SHALL be rewritten to state the guarantee the implemented mechanism actually
provides, and SHALL NOT state a stronger one. Specifically it SHALL state that a second writer
process is **detected and the displaced process is fail-stopped before its next commit**; it SHALL
state that the guarantee is transaction-granular; it SHALL state that it does not hold if the
database file is deleted or replaced beneath a live process; and it SHALL NOT claim that a second
writer process is refused at open.

The "does not fence writes against connection death" clause SHALL be retired rather than reworded,
because the lease no longer has a connection.

#### Scenario: The written contract and the mechanism agree
- **WHEN** `docs/CONTRACT.md` §5 is read against the implemented mechanism
- **THEN** every guarantee in the text SHALL correspond to a scenario in this specification that
  asserts it
- **AND** the text SHALL NOT contain the sentence "a second writer process is refused" or any
  paraphrase asserting refusal at open, because no dependency-free in-process mechanism delivers it:
  first-wins refusal needs an OS-supplied liveness signal, and Node exposes no file-locking API
- **AND** if a later change acquires such a signal, the strengthening SHALL be re-derived from the
  new mechanism rather than edited into the text

#### Scenario: A stronger written claim than the mechanism supports is the failure mode (negative control)
- **GIVEN** the record of this migration, in which a lease mechanism was published as "strictly
  safer than `pg_advisory_lock`" and was then broken two ways by a single `fs.readFileSync` and a
  single `unlink`
- **WHEN** any future contract text asserts a concurrency guarantee
- **THEN** the assertion SHALL name the mechanism that delivers it and the attack that would falsify
  it, so the claim is checkable rather than persuasive

### Requirement: every write transaction opens BEGIN IMMEDIATE and no write path is DEFERRED

WHEN `withTransaction` opens a transaction, the system SHALL issue `BEGIN IMMEDIATE`. No write path
in the adapter SHALL open a `DEFERRED` transaction, and no write SHALL be issued on a transaction
that began `DEFERRED`.

#### Scenario: The adapter contains no DEFERRED write path
- **WHEN** the SQLite adapter's sources are scanned for transaction-opening statements
- **THEN** every statement that precedes a write SHALL be `BEGIN IMMEDIATE`
- **AND** the scan SHALL be an executable check that fails the build, not a review convention

#### Scenario: A DEFERRED write path lets contention escape mid-transaction (negative control)
- **GIVEN** a hypothetical implementation that opens `BEGIN DEFERRED` and lets the first write
  attempt the lock upgrade
- **WHEN** another connection commits between the transaction's read snapshot and that first write
- **THEN** the upgrade SHALL fail with `SQLITE_BUSY_SNAPSHOT` **after arbitrary caller code has
  already run**, the busy handler SHALL NOT retry it, and the transaction SHALL NOT be
  auto-rolled-back
- **AND** that is the shape of the LND P0 fund-loss failure (issue #7869): a transient contention
  error escaping into the caller's protocol mid-transaction, whose upstream fix was to make the
  transaction `IMMEDIATE`
- **AND** it is also the condition under which the claim "SQLITE_BUSY needs a new frozen error code"
  becomes true; `BEGIN IMMEDIATE` on every write path is what keeps the error mapping requirement
  below achievable with zero surface change

### Requirement: the whole-database write lock held by withTransaction is bounded

WHILE a `withTransaction` callback is executing, the system holds SQLite's **whole-database** write
lock, and there is no server-side backstop equivalent to
`idle_in_transaction_session_timeout`. The system SHALL therefore bound the hold itself: IF a
transaction's hold exceeds its bound THEN the system SHALL roll back, release the write lock,
invalidate the transaction handle, and reject with `TransactionFaultError` carrying
`faultKind: "timeout"`.

The bound SHALL be `opts.timeoutMs` when supplied, and otherwise a configured default derived from
`UmbraDBConnectionOptions.idleInTxTimeoutMs`. The default's value SHALL be established under stated
measurement conditions behind `v1.0.0-sqlite-engine-core`'s measurement gate; it SHALL NOT be
carried over from any research lane's figure.

The system SHALL NOT claim to interrupt `fn`. `fn` is arbitrary caller code and the engine exposes
no interrupt.

#### Scenario: A callback that overruns its bound loses the lock and the transaction
- **WHEN** a `withTransaction` callback awaits past its hold bound
- **THEN** the transaction SHALL be rolled back and the database write lock SHALL be released before
  the bound's grace elapses
- **AND** a second, independent writer SHALL be able to commit immediately afterwards
- **AND** `withTransaction` SHALL reject with `TransactionFaultError` whose `faultKind` is
  `"timeout"`, which is an already-frozen member of the union at
  `src/interfaces/transaction-lease.ts:76`

#### Scenario: The handle is dead after the bound fires
- **WHEN** a callback continues to run after its transaction was rolled back by the bound and passes
  its `TransactionHandle` to any storage-layer method
- **THEN** that method SHALL reject with `TransactionHandleInvalidError`
- **AND** no write from that callback SHALL become durable

#### Scenario: An unbounded transaction stalls the whole database (negative control)
- **GIVEN** a hypothetical implementation in which `TransactionOptions.timeoutMs` is
  validated-then-ignored and no default hold bound exists
- **WHEN** a caller's `withTransaction` callback awaits an external resource that never resolves
- **THEN** every other writer in the process SHALL be blocked indefinitely, because the lock is
  whole-database and not table-scoped — a stalled database rather than a slow query
- **AND** no error SHALL ever be raised to anyone, which is why the bound is a requirement and not a
  nicety

#### Scenario: A synchronously blocking callback cannot be bounded (stated limit)
- **WHEN** a callback blocks the executing thread without yielding
- **THEN** the hold bound SHALL NOT fire, because the timer cannot run
- **AND** this limit SHALL be stated in the contract text as a caller obligation, since it is a
  property of the runtime rather than of this design

#### Scenario: The hold bound fires late by an uncancellable statement's remaining runtime
- **WHEN** a transaction's current statement is one of the cases `v1.0.0-sqlite-engine-core`
  enumerates as uncancellable — a statement whose cost is inside the engine with no per-row guard —
  and the transaction's hold bound elapses
- **THEN** the rollback SHALL NOT take effect until that statement returns, so the whole-database
  write lock is held for the bound plus that statement's remaining runtime
- **AND** the hold bound SHALL NOT be described as a bound on statement runtime: the per-statement
  deadline is enforced by the engine capability, and the two bounds SHALL be documented as distinct
  objects rather than merged into one claim
- **AND** `docs/durability-contract.md` SHALL state which of the two replaces `statement_timeout` and
  which replaces `idle_in_transaction_session_timeout`, rather than leaving the removed GUC rows to
  imply that both gaps were closed or that neither was

### Requirement: all lock waiting happens outside SQLite and busy_timeout is 0 on every handle

The system SHALL set `PRAGMA busy_timeout = 0` on every database handle it opens, and SHALL perform
every wait for a contended lock in JavaScript. It SHALL NOT rely on SQLite's busy handler to wait.

The reason SHALL be recorded as: **a blocking wait inside SQLite pins the queue that must deliver
the release.** Which queue that is depends on the driver topology — the JavaScript event loop
in-process, the worker's message queue off-thread — so the requirement SHALL NOT be justified by
reference to one topology.

#### Scenario: Concurrent lease acquirers all succeed
- **WHEN** the existing P10 property test's concurrent `withLease` workload is run against the poll
  loop
- **THEN** every acquirer SHALL acquire and complete, and the instrumented maximum concurrent holder
  count SHALL be 1

#### Scenario: A blocking busy_timeout fails P10 (negative control)
- **GIVEN** a hypothetical implementation that ports `pg_advisory_lock`'s blocking wait to a non-zero
  `PRAGMA busy_timeout`
- **WHEN** the same concurrent `withLease` workload is run against it
- **THEN** most acquirers SHALL fail with `LeaseTimeoutError` while exactly one succeeds — measured
  by research lane L2 as 1 acquired and 7 `LeaseTimeoutError` out of 8 — because the blocking wait
  pins the thread and the holder cannot reach the scheduler to release
- **AND** the harness SHALL be shown to produce this result, so a green P10 against the real
  implementation demonstrates the test detects the failure it is looking for

#### Scenario: A blocking busy_timeout deadlocks inside a worker thread too (negative control)
- **GIVEN** the same hypothetical implementation running inside a worker thread that owns the
  database handle
- **WHEN** a contender blocks inside SQLite's busy handler on the worker while the holder's release
  message is posted to that worker
- **THEN** the release message SHALL sit undelivered in the worker's queue until the contender's
  wait expires, and the contender SHALL fail with `SQLITE_BUSY` — even though the main thread's
  event loop remains healthy throughout
- **AND** this SHALL be recorded explicitly, because "the worker keeps the event loop turning"
  is the reasoning that would otherwise retire this requirement

#### Scenario: SQLITE_BUSY_TIMEOUT is unreachable by construction
- **WHEN** the adapter is exercised under contention
- **THEN** the extended result code `SQLITE_BUSY_TIMEOUT` SHALL never be observed, because
  `busy_timeout = 0` leaves no busy handler to give up
- **AND** a test SHALL assert this rather than a mapping being carried defensively for a code nobody
  could produce

### Requirement: contention is retried inside the adapter and surfaces only through already-frozen codes

The system SHALL classify `SQLITE_BUSY` and `SQLITE_BUSY_SNAPSHOT` internally and retry them under a
bounded, jittered policy. It SHALL surface a contention outcome to the caller only when that bound is
exhausted, and then only as one of the codes already frozen for the situation: `LEASE_TIMEOUT` at
lease acquisition, `MIGRATION_LOCK_TIMEOUT` at the migration lock, and `TransactionFaultError` with
`faultKind: "timeout"` (bound elapsed at `BEGIN IMMEDIATE`) or `faultKind: "serialization-failure"`
(`SQLITE_BUSY_SNAPSHOT`).

Classification SHALL key on the **result-code name** carried by the binding's thrown error together
with the **situation** in which it arose. It SHALL NOT key on a numeric extended result code: the
binding ruled by `v1.0.0-sqlite-engine-core` exposes the code as a string on `err.code` with
`err.name === "SqliteError"` and carries **no numeric field at all**, so a numeric key reads
`undefined` for every contention error and routes all of them to the catch-all — silently, and with
no type error.

The system SHALL NOT add a new error code for write contention. The retry bound, attempt count and
jitter SHALL be established under stated conditions behind `v1.0.0-sqlite-engine-core`'s measurement
gate. The acquisition bounds SHALL default to the values already published for UmbraDB's
`lock_timeout` and migration lock (`docs/durability-contract.md:103`;
`DEFAULT_MIGRATION_LOCK_TIMEOUT_MS`, `src/postgres/migrate.ts:18`), which the external field
evidence argues for keeping rather than shortening.

#### Scenario: Every contention outcome lands on a frozen code with an unchanged retryable marking
- **WHEN** each of the four contention situations occurs
- **THEN** the surfaced error SHALL be one of `LEASE_TIMEOUT`, `MIGRATION_LOCK_TIMEOUT` or
  `TRANSACTION_FAULT`, each already present in `docs/ERROR-CATALOG.md` with an unchanged `retryable`
  marking
- **AND** the `faultKind` values used SHALL already be members of the frozen union at
  `src/interfaces/transaction-lease.ts:76` — no widening of that union, and therefore no break of a
  consumer's exhaustive `switch`

#### Scenario: The discriminator field is asserted to exist on a real thrown error
- **WHEN** a genuine contention error is provoked against the configured binding
- **THEN** a test SHALL assert the field the classifier keys on is present and not `undefined` on
  that error, and that it carries the expected result-code name
- **AND** the same test SHALL assert `err.name` identifies the binding's error type
- **AND** this SHALL exist because the classifier's failure mode under a binding change is silent:
  the key's *shape* changes while every value remains conceptually the same, so nothing fails except
  the mappings themselves

#### Scenario: A mapping keyed on a numeric extended result code is wrong for the ruled binding (negative control)
- **GIVEN** a hypothetical implementation that ports the research corpus's mapping unchanged, keying
  on a numeric `errcode` — the form correct for the built-in binding that was **not** ruled
- **WHEN** any contention error is raised by the ruled binding
- **THEN** the key SHALL read `undefined`, no mapping arm SHALL match, and every contention error
  SHALL fall through to the unrecognised-error path
- **AND** the caller SHALL receive a non-retryable unrecognised error where a retryable
  `LEASE_TIMEOUT`, `MIGRATION_LOCK_TIMEOUT` or `TRANSACTION_FAULT` was contractually due — inverting
  the retryability of routine contention, which is the same class of defect as repurposing a code

#### Scenario: A transient contention error never reaches the caller un-retried
- **WHEN** a `SQLITE_BUSY` occurs and the bound has not been exhausted
- **THEN** the operation SHALL be retried internally and SHALL NOT surface any error
- **AND** the caller SHALL observe only success, or the bounded-wait code once the bound is spent

#### Scenario: Adding a contention error code is the forbidden remedy (negative control)
- **GIVEN** a hypothetical change that adds a `BUSY` or `WRITE_CONTENDED` code to the catalog, as
  research lane L7 proposed
- **WHEN** a caller receives it mid-protocol
- **THEN** that change SHALL have promoted a transient into the caller's decision surface — the
  precise shape that produced LND's P0 fund-loss failure (issue #7869, force-closed channels),
  whose maintainer's own diagnosis was a **missing retry layer, not a missing code**
- **AND** the prohibition SHALL be recorded as a safety ruling, not a SemVer one: `docs/STABILITY.md`
  permits adding codes additively even in a minor, so nothing except this requirement prevents it
- **AND** the bounded internal retry above is what makes the existing timeout codes correct, because
  they already mean "a bounded wait elapsed"

#### Scenario: The displacement fault is not a contention outcome
- **WHEN** a writer-displacement fault and a contention timeout are both possible
- **THEN** they SHALL be distinguishable by `code` and by `retryable` alone, without inspecting a
  message string
- **AND** the displacement fault SHALL NOT reuse `TRANSACTION_FAULT`, `LEASE_TIMEOUT` or
  `MIGRATION_LOCK_TIMEOUT`, all of which are frozen retryable

### Requirement: CONNECTION_ERROR becomes unreachable and is never repurposed

Embedded SQLite has no connection. The SQLite adapter SHALL NOT throw `ConnectionError` for any
condition. File-level faults (`SQLITE_CANTOPEN`, `SQLITE_NOTADB`, `SQLITE_CORRUPT`,
`SQLITE_READONLY`, `SQLITE_IOERR`) SHALL NOT be mapped onto `CONNECTION_ERROR`, whose frozen
`retryable` marking is `"retryable"` and all of which are non-retryable conditions.

`CONNECTION_ERROR` SHALL remain exported and remain in the catalog, marked unreachable in writing.

#### Scenario: No file-level fault surfaces as a retryable connection error
- **WHEN** the database file is missing, unreadable, not a database, read-only, or reports an I/O
  error
- **THEN** the surfaced error SHALL NOT be `ConnectionError`
- **AND** it SHALL carry a `retryable` marking of `"non-retryable"`

#### Scenario: Repurposing keeps the marking while inverting the behaviour it predicts (negative control)
- **GIVEN** a hypothetical implementation that keeps `CONNECTION_ERROR` reachable by re-pointing its
  meaning at `SQLITE_CANTOPEN` / `READONLY` / `NOTADB` and editing the catalog's Meaning cell
- **WHEN** a caller applies the bounded-retry policy the unchanged `retryable` marking predicts
- **THEN** the retry loop SHALL spin against a condition that cannot clear without operator action
- **AND** the edit SHALL be recognised as unsound on the catalog's own terms: `retryable` exists "so
  a caller decides whether to retry **without parsing a message string**"
  (`docs/ERROR-CATALOG.md:8-9`), so a field whose point is that the message need not be read cannot
  have its meaning changed by editing the message

#### Scenario: A retryable code retains empirical evidence of reachability
- **GIVEN** that making `CONNECTION_ERROR` unreachable deletes the only pinned conformance test
  proving a frozen retryable code is reachable at all
- **WHEN** the conformance suite runs against SQLite
- **THEN** at least one frozen retryable code SHALL be demonstrated reachable by an executed test
- **AND** deleting the old evidence without adding replacement evidence SHALL be treated as a
  contract change, not as test maintenance

### Requirement: a transaction handle is poisoned by any transaction-scoped error, including one thrown before any statement reaches SQLite

SQLite does not poison a transaction after a failed statement: after a constraint failure inside
`BEGIN IMMEDIATE`, the next statement succeeds and `COMMIT` commits the surrounding writes. The
frozen interface documents the opposite consequence (`src/interfaces/transaction-lease.ts:216-226`).
The system SHALL therefore emulate poisoning.

WHEN any error whose scope is the transaction is thrown through a transaction handle, the system
SHALL mark that handle poisoned **whether or not any statement reached SQLite**. The mark SHALL be
set by the adapter wrapper, not by the statement executor. WHILE a handle is poisoned, every
subsequent use SHALL reject with the original error, and the transaction SHALL end in `ROLLBACK`
regardless of what the callback returns.

Poison SHALL be per-transaction and monotone: once poisoned, a transaction SHALL NOT become usable
again, including after a nested scope is rolled back.

#### Scenario: Swallowing a statement error and continuing commits nothing
- **WHEN** a callback issues a statement that fails, catches the rejection, issues further
  successful statements, and returns normally
- **THEN** no write from that callback SHALL be durable
- **AND** `withTransaction` SHALL reject with the original error, matching the consequence the frozen
  interface documents

#### Scenario: An adapter-thrown guard poisons even though no statement reached SQLite
- **WHEN** an adapter-side guard rejects a call before issuing any statement — for example the
  transaction-identity guard, whose enforcement moves into the adapter because SQLite has no
  unforgeable transaction identity
- **AND** the callback swallows that rejection and continues
- **THEN** no write from that callback SHALL be durable
- **AND** the poison mark SHALL have been set even though the driver never saw an error

#### Scenario: A statement-executor-set flag misses the adapter-thrown case (negative control)
- **GIVEN** a hypothetical implementation that sets the poison flag "when any statement through the
  handle throws", as research lane L2 specified it
- **WHEN** an adapter-side guard throws before any statement is issued and the caller swallows it
- **THEN** the flag SHALL never be set and the transaction SHALL commit a **partial** result —
  reproduced in the research corpus as a two-row commit surviving an adapter-thrown error
- **AND** this is the exact regression against today's behaviour, where the same guard arrives as a
  server-side SQLSTATE and does poison the transaction

#### Scenario: The emulation protects caller atomicity and is not what makes T5 sound
- **WHEN** a `BEFORE INSERT` trigger raises `RAISE(ABORT)` on a temporal-KV write and the caller
  swallows the error
- **THEN** the store SHALL remain free of any partial history row, because `RAISE(ABORT)` reverses
  the **entire statement including the trigger's own INSERT** — independently of the poison flag
- **AND** the poison emulation SHALL therefore be specified and tested as a **caller-atomicity**
  guarantee only
- **AND** T5's soundness SHALL rest on the design rule that a logical put is never split across two
  statements, which is the property that actually carries it; an implementation that treats the
  poison flag as T5's guarantee will under-test that rule

#### Scenario: Poison survives a nested rollback
- **WHEN** a nested scope fails and is rolled back to its savepoint
- **THEN** the enclosing transaction SHALL remain poisoned and SHALL end in `ROLLBACK`
- **AND** this SHALL match today's behaviour, where a failed statement poisons the whole transaction
  regardless of savepoints unless the caller explicitly rolls back to one — which UmbraDB has never
  exposed

### Requirement: read paths do not take the database write lock

WAL gives a `DEFERRED` reader a stable snapshot, which is `repeatable read` obtained for free and is
strictly stronger than the READ COMMITTED default the Postgres adapter relied on. The system SHALL
therefore provide an internal read-snapshot transaction that does **not** take the database write
lock, and the read paths that today request `{ isolation: "repeatable read" }` SHALL use it.

`TransactionOptions.isolation` SHALL remain on the frozen surface, validated and then ignored, and
that SHALL be documented rather than silent.

#### Scenario: A write proceeds while a long read is in flight
- **WHEN** a multi-chunk checkpoint reassembly is in flight on a read path
- **THEN** an independent writer SHALL be able to open `BEGIN IMMEDIATE` and commit without waiting
  for that read to finish

#### Scenario: A read still sees one consistent instant
- **WHEN** a read path reads a manifest page and then aggregates over its chunks, while a prune
  commits between the two statements
- **THEN** the returned summaries SHALL reflect one instant — the torn-read defect the
  `repeatable read` override at `src/postgres/checkpoint-store.ts:392` and `:458` was added to fix
- **AND** the guarantee SHALL come from the WAL snapshot, not from an isolation option

#### Scenario: Routing reads through withTransaction serialises them against the writer (negative control)
- **GIVEN** a hypothetical port that leaves `load` and `history` calling `withTransaction`, which
  opens `BEGIN IMMEDIATE`
- **WHEN** a large `load` runs
- **THEN** that hypothetical implementation SHALL hold the whole-database write lock for the entire
  reassembly and block the sync writer — a regression with no counterpart under Postgres, where each
  transaction had its own pooled connection
- **AND** it would pass every correctness test, which is why the read path is specified separately
  rather than left to fall out of the transaction primitive

### Requirement: prune's C2a justification is re-derived from BEGIN IMMEDIATE, not carried over

`prune` SHALL run under `BEGIN IMMEDIATE`. The justification recorded at
`src/postgres/checkpoint-store.ts:485-487` — that the grace-window TOCTOU argument relies on READ
COMMITTED's per-row re-evaluation — is **false under WAL** and SHALL NOT be carried over. The code
comment and `Formal/STORAGE_ALGEBRA.md` §2's C2a status SHALL be re-derived from the write lock and
the re-derivation SHALL be written down.

#### Scenario: The recorded justification names the mechanism that actually holds
- **WHEN** the prune code comment and `Formal/STORAGE_ALGEBRA.md` §2 are read after the migration
- **THEN** neither SHALL claim a dependency on READ COMMITTED per-row re-evaluation
- **AND** both SHALL state that under `BEGIN IMMEDIATE`, **while the write lock is intact**, no other
  writer can commit for the transaction's duration, so the live-manifest set cannot grow between the
  manifest delete and the chunk-reachability scan, making `Deleted ∩ ⋃_{m ∈ Live} refs(m) = ∅` hold
  trivially
- **AND** both SHALL carry the descriptor precondition, because a write lock voided mid-prune lets a
  competing `save` re-reference a chunk between the two steps and step 2 reclaims it — the same C2a
  violation the `DEFERRED` control demonstrates, reached by a different route and with no error
- **AND** a reviewer SHALL be able to tell from the text that the claim was re-derived rather than
  restated, because the mechanism named in it no longer exists

#### Scenario: A DEFERRED prune reclaims a live chunk (negative control)
- **GIVEN** a hypothetical prune that runs `DEFERRED`
- **WHEN** a `save` that re-references an otherwise-unreferenced chunk commits after the prune's read
  snapshot is established
- **THEN** the prune's `NOT EXISTS` check SHALL evaluate against the stale snapshot, the chunk SHALL
  still look unreferenced, and it SHALL be reclaimed — a direct C2a violation, observable as a
  surviving checkpoint that no longer loads
- **AND** a test SHALL demonstrate this failure against the `DEFERRED` shape, so the passing
  `IMMEDIATE` result is evidence rather than coincidence

#### Scenario: The grace window is no longer load-bearing for safety
- **WHEN** the grace window's role is documented after the migration
- **THEN** it SHALL be described as serving the backup story, not as part of the C2a safety argument
- **AND** shortening or lengthening it SHALL NOT change whether C2a holds

### Requirement: nested withTransaction resolves to a savepoint rather than deadlocking

WHEN `withTransaction` is called from inside another `withTransaction` callback on the same layer,
the system SHALL open a `SAVEPOINT` scoped to the enclosing transaction and SHALL NOT enqueue the
nested call behind the enclosing one. Releasing the nested scope SHALL `RELEASE` the savepoint;
rejecting it SHALL `ROLLBACK TO` the savepoint and poison the enclosing transaction.

#### Scenario: An inner rollback leaves the outer transaction's earlier writes intact until it too is rolled back
- **WHEN** a nested transaction fails and rolls back to its savepoint
- **THEN** the enclosing transaction's earlier statements SHALL still be present in the transaction's
  state at that instant
- **AND** the enclosing transaction SHALL nonetheless end in `ROLLBACK`, because it is poisoned

#### Scenario: A naive port deadlocks on the same input (negative control)
- **GIVEN** a hypothetical port that keeps the current documented behaviour — a nested call opens an
  independent transaction on another connection
- **WHEN** it runs against a single-threaded engine with one write lock per file
- **THEN** the inner call SHALL wait for a write lock the outer call holds and cannot release,
  producing a guaranteed self-deadlock rather than the "can deadlock under a small connection pool"
  the interface documents today (`src/interfaces/transaction-lease.ts:207-214`)
- **AND** the requirement above SHALL therefore be treated as a correctness fix, not an ergonomics
  improvement

### Requirement: P10 is re-executed with negative controls that fail against the implementations they target

The conformance property for Law L1 SHALL be **re-executed** against the SQLite implementation, not
ported and assumed. It SHALL be extended with negative controls, and each negative control SHALL be
demonstrated to fail against the implementation it targets.

#### Scenario: Each negative control fails as designed
- **WHEN** the extended P10 suite runs
- **THEN** the descriptor-close attack SHALL void a sidecar-lock-file implementation and SHALL NOT
  void the shipped one
- **AND** the unlink attack SHALL produce two holders against a sidecar-lock-file implementation and
  SHALL NOT against the shipped one
- **AND** the blocking `busy_timeout` implementation SHALL fail the concurrent-acquirer assertion
  while the poll loop passes it
- **AND** a suite in which every negative control passes SHALL be treated as broken, because it then
  proves nothing about the mechanism

#### Scenario: The property is executed, not amended
- **WHEN** the conformance record is reviewed
- **THEN** the SQLite results SHALL come from an executed run against the SQLite build
- **AND** no result SHALL be carried over, restated or edited from the Postgres run
- **AND** the fact that the Lean cut-line is unchanged by this migration SHALL NOT be offered
  anywhere as evidence that the migration is safe, since the abstract model was never connected to
  the concrete store

### Requirement: Windows parity for the writer-generation guard is established before the strengthened contract ships

Every measurement supporting this design was taken on Linux `fcntl` semantics; the corpus labels its
Windows reasoning an inference rather than a measurement, and UmbraDB declares no OS restriction.
The system SHALL NOT ship the strengthened `docs/CONTRACT.md` §5 text until the guard's behaviour is
established on Windows by an executed experiment, or until §5 states the restriction explicitly.

#### Scenario: The experiment is specified rather than assumed
- **WHEN** the Windows obligation is discharged
- **THEN** the executed experiment SHALL cover: two processes opening the same database file,
  registration ordering, and the displaced process being refused at its next write transaction
- **AND** it SHALL record the result with the command that produced it
- **AND** if the experiment is not run, `docs/CONTRACT.md` §5 SHALL name the platforms on which the
  strengthened guarantee holds, rather than stating it unqualified

#### Scenario: The descriptor hazard is POSIX-specific and its Windows status is measured, not inferred
- **GIVEN** that the descriptor open-and-close hazard follows from POSIX record-lock semantics —
  locks are owned by the `(process, inode)` pair and are dropped on any close — whereas Windows
  locking is owned by the file handle, which predicts the hazard is absent there
- **WHEN** the Windows arm runs
- **THEN** it SHALL execute the same three arms as the POSIX reproduction — a control, an
  open-and-hold arm, and an open-and-close arm — and assert the same two observables: no two writers
  both commit, and no acknowledged commit is lost
- **AND** the prediction SHALL NOT be recorded as a result: an inference about `LockFileEx` is the
  same class of reasoning that produced the falsified immunity claim, and this specification treats
  it as a hypothesis to be tested
- **AND** IF the hazard is confirmed absent on Windows THEN the guarantee is **stronger on Windows
  than on POSIX**, and the contract SHALL state the two platforms separately rather than documenting
  the weaker one as if it were universal
- **AND** the source guard SHALL remain in force on every platform regardless of the outcome, since
  it costs nothing where the hazard is absent

#### Scenario: The in-process lease is not blocked on this
- **WHEN** the Windows obligation is outstanding
- **THEN** the per-key lease requirement SHALL still hold on every platform, because it consults no
  operating-system facility
- **AND** only the cross-process guarantee SHALL be qualified
