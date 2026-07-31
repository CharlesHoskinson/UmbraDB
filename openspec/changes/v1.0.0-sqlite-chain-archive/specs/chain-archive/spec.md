# chain-archive

The SQLite chain-archive tier: its database file, its physical layout, its ported DDL and adapter,
its ingest path, and its snapshot/restore capability. Requirements follow EARS (Easy Approach to
Requirements Syntax), as in Sprint 2's, Sprint 4's and Sprint 7's spec files.

Scope boundary. The driver, the tagged-template shim, the worker topology, the pragma bootstrap and
the measurement gate belong to `v1.0.0-sqlite-engine-core`; object-name prefixing, `STRICT`, the
type mapping and the migration framework belong to `v1.0.0-sqlite-schema-parity`; `BEGIN IMMEDIATE`,
the lease and contention mapping belong to `v1.0.0-sqlite-concurrency-lease`; the written contracts,
the error catalog, the durability probe, the application-level digest regime and the **choice of
backup primitive** belong to `v1.0.0-sqlite-durability-contract`. This capability is written against
all four and specifies none of them.

The archive lineage's own design document is `design/full-chain-storage-design.md`; where a
requirement below carries a claim about what the archive stores or does not prove, it is cited to a
section of that document rather than restated more favourably.

## ADDED Requirements

### Requirement: the chain-archive lineage is created empty and replayed forward, with no data migration

The system SHALL create the SQLite chain archive as a fresh, zero-row database and SHALL apply the
`chainArchiveMigrations` lineage from its first migration forward. The system SHALL NOT provide, and
SHALL NOT require, any path that imports existing chain-archive content from PostgreSQL, and SHALL
NOT provide a dual-write, backfill or cutover mechanism for the archive tier.

`archive:sync` has never been run against a real database, so no archive content exists to migrate.
This is a stated premise: IF archive content is ever found to exist in a real PostgreSQL deployment,
THEN this change's scope and cost estimate (`design.md` §13) are void and a data-migration change is
required.

#### Scenario: The lineage applies against an empty file
- **WHEN** `runMigrations` is invoked with the chain-archive lineage against a newly created,
  zero-table database file
- **THEN** every migration in the lineage SHALL apply successfully
- **AND** the lineage's own `_migrations` bookkeeping table SHALL record each applied migration name

#### Scenario: No import path is offered
- **WHEN** the shipped surface and the `archive:sync` entry point are inspected
- **THEN** no function, script or documented procedure SHALL read chain-archive content from a
  PostgreSQL database
- **AND** the absence SHALL be stated in the change record as a consequence of there being no data,
  not as an omission

### Requirement: the chain archive occupies its own database file and no transaction spans the tier boundary

The chain archive SHALL be stored in a database file distinct from the wallet tier's. No transaction
SHALL span the two files, and no transaction handle SHALL be passed across the tier boundary.

This preserves a separation the schema already makes: the archive was given its own schema and its
own `watermarks` table specifically so that *"a chain_archive-only deployment/backup/restore could
no longer be self-contained"* would not become true
(`src/postgres/migrations/chain_archive/001_chain_archive_core.ts:717-745`;
`design/full-chain-storage-design.md` §5; `design/design.md` §0's tier semantics).

#### Scenario: The archive is reachable without opening the wallet database
- **WHEN** the archive sync entry point is started with only an archive file path
- **THEN** it SHALL apply the lineage and ingest without opening or requiring the wallet tier's
  database file

#### Scenario: A transaction handle is never shared across tiers
- **WHEN** a static check inspects every call site that constructs or accepts a transaction handle
- **THEN** no archive-tier call site SHALL accept a handle originating from the wallet tier, and no
  wallet-tier call site SHALL accept one originating from the archive
- **AND** this check SHALL exist even though no such call site is present today, because the
  cross-file atomicity failure it prevents is silent (see the ATTACH prohibition below)

#### Scenario: File-per-lineage is not file-per-schema
- **WHEN** the archive lineage is applied twice against **one** archive file under two different
  `schema` values
- **THEN** both applications SHALL succeed and the file SHALL hold two disjoint object sets
- **AND** the `schema` parameter SHALL still be emulated by object-name prefixing
  (`v1.0.0-sqlite-schema-parity`), never by a second file, so this requirement and that change's
  prohibition on one-file-per-schema both hold

### Requirement: a second process writing the archive file is detected and fail-stopped before it can commit

The archive lineage SHALL create a `writer_generation` table — schema-prefixed like every other
object this lineage creates — carrying the archive file's own writer-registration record and
mirroring the mechanism `v1.0.0-sqlite-concurrency-lease` specifies for the wallet file: a single
seeded row with a monotonically increasing `generation` and an `owner` unique per open; a bump inside
`BEGIN IMMEDIATE` at open; and a re-read of that row inside every write transaction, before any
write, rejecting with a non-retryable typed error distinct from every contention outcome when the
generation differs from the one this process registered. Process id, host name, heartbeats, time-to-live
and lock files SHALL NOT be used to make the determination.

The registration write against `writer_generation` SHALL assert that **exactly one row was affected**
and SHALL read back the owner and generation it wrote, failing with a named non-retryable startup error if either assertion
does not hold. These assertions are present **from the first migration**, not added later.

The build-failing source guard that prohibits UmbraDB's own code from opening a descriptor on a
database file or its `-wal`/`-shm` sidecars SHALL cover **the archive file and its sidecars**,
including paths derived indirectly from an archive path rather than only literal concatenations.

This requirement exists because the archive was believed out of scope when writer registration was
specified, and the deferral — *"the archive file, if it is ever wired, gets its own registration under
its own change"* — did not travel with the archive when it came into scope. This is that change.

#### Scenario: Two archive:sync processes against one file, and the displaced one cannot commit
- **GIVEN** one `archive:sync` process has the archive file open and registered in
  `writer_generation` at generation N
- **WHEN** an operator starts a second `archive:sync` against the same file, which registers at
  generation N+1
- **AND** the first process opens its next ingest transaction
- **THEN** the first process's guard read SHALL observe a different generation, and the transaction
  SHALL roll back without committing
- **AND** every subsequent write transaction from the first process SHALL be rejected the same way
- **AND** the rejection SHALL be non-retryable, because displacement is terminal

#### Scenario: Serialized transactions are not a single-writer guarantee (negative control)
- **GIVEN** a hypothetical archive with no writer registration, relying on the statement that SQLite
  serializes writers
- **WHEN** two `archive:sync` processes run against the same file
- **THEN** both SHALL proceed: their `BEGIN IMMEDIATE` transactions interleave **legally**, because
  SQLite serializes transactions and does not make a process a single writer
- **AND** every argument in this capability phrased as resting on single-writer serialization SHALL
  therefore be understood as resting on a property that nothing enforces or detects until this
  registration exists
- **AND** the two observables to assert SHALL be that no two writers both commit, and that no
  acknowledged commit is lost

#### Scenario: The registration bootstrap does not silently succeed on zero rows (negative control)
- **GIVEN** a hypothetical registration that issues its `UPDATE` against `writer_generation` without
  asserting the affected-row count
- **WHEN** the seeded row is absent, so the statement affects zero rows
- **THEN** that implementation SHALL proceed with an undefined generation and no error, and every
  later guard comparison SHALL be made against it
- **AND** the real implementation SHALL fail at registration with a named non-retryable startup
  error, because a guard whose own bootstrap can silently no-op guards nothing

#### Scenario: A crashed archive writer does not wedge its successor
- **WHEN** a registered `archive:sync` process is terminated with `SIGKILL`
- **THEN** the next process to open the archive SHALL register successfully and operate
- **AND** no operator step, stale-record cleanup or expiry wait SHALL be required

#### Scenario: The source guard covers the archive artifact set
- **WHEN** the sources are scanned by the build-failing descriptor check
- **THEN** no call SHALL open a descriptor on the archive database path, nor on a path formed by
  appending `-wal` or `-shm` to it
- **AND** the check SHALL cover a helper that derives such a path from an archive path, not only
  literal string concatenation

### Requirement: height-range separation SHALL NOT be implemented with ATTACH

The system SHALL NOT implement height-range separation, tier separation, or any other data
partitioning by attaching a second database file to the archive connection.

#### Scenario: The attach limit caps any file-splitting scheme at ten
- **WHEN** databases are attached to one connection until the engine refuses
- **THEN** the tenth attach SHALL succeed and the eleventh SHALL fail with
  `too many attached databases - max 10`
- **AND** `PRAGMA compile_options` SHALL report `MAX_ATTACHED=10`, i.e. the cap is compiled into the
  shipped binding and is not a configuration

#### Scenario: A foreign key cannot cross a database boundary
- **WHEN** a `REFERENCES` clause names a table qualified with an attached database name
- **THEN** the engine SHALL reject it at parse time with a syntax error at the qualifying dot
- **AND** because the archive lineage declares foreign keys at
  `001_chain_archive_core.ts:139,258,259,390,394,452,455,539`, any file-splitting scheme SHALL
  either place all of them in one file or abandon their enforcement

#### Scenario: A write-ahead-log transaction across attached files is not atomically committed (negative control)
- **GIVEN** a hypothetical implementation that stores height ranges in separate attached files and
  writes a block and its transactions in one transaction spanning two of them
- **WHEN** the process is killed mid-commit repeatedly in write-ahead-log mode
- **THEN** some trials SHALL leave the two files disagreeing, because the write-ahead log creates no
  super-journal and SQLite's atomic multi-database commit requires one — reproduced independently by
  two research lanes at 1 torn commit in 12 write-ahead-log trials against 0 in 16 with a rollback
  journal
- **AND** the failure SHALL be understood as silent and rare rather than caught by a test at
  implementation time, which is why this prohibition is stated as a requirement rather than a note

### Requirement: each archive relation is stored in one table and a table-per-height-range layout is prohibited

The system SHALL store `blocks`, `transactions` and `bridge_observations` each in a **single** table.
The system SHALL NOT implement a table-per-height-range layout, a `UNION ALL` view over range tables,
`INSTEAD OF` routing triggers, or a catch-all range table.

PostgreSQL's `PARTITION BY RANGE` (`001_chain_archive_core.ts:275,395,456`) has no SQLite equivalent.
Its only load-bearing use in this schema was cheap bulk retirement of an old height range, and that
justification does not survive measurement: reclamation of freed space is a function of the
`auto_vacuum` setting and the number of pages freed, and is **independent of whether those pages were
freed by `DROP TABLE` or by `DELETE`**.

IF a table-per-height-range layout is ever re-proposed, THEN it SHALL be accepted only when all four
of the following hold, and SHALL be rejected when any one is missing: (1) a written retention
requirement that a range `DELETE` provably cannot satisfy; (2) a measurement, under
`v1.0.0-sqlite-engine-core`'s gate conditions, showing a retirement advantage for `DROP TABLE` at
archive-realistic row counts; (3) a routing-trigger guard arm as required below; and (4) an accounting
of the read cost, which is measured and is not zero.

#### Scenario: Neither operation returns space at the default setting
- **WHEN** a range is retired by `DROP TABLE` and, separately, by an equivalent `DELETE`, on databases
  created at `auto_vacuum=0`
- **THEN** neither SHALL reduce the file's size on disk
- **AND** both SHALL leave an equivalent freelist, which is the direct evidence that the two
  operations free the same pages by different means

#### Scenario: Both operations return the same space when auto_vacuum is enabled
- **WHEN** the same two retirements are performed on databases created at `auto_vacuum=FULL`
- **THEN** both SHALL reduce the file's size on disk, and by the same amount within measurement noise
- **AND** the setting that makes `auto_vacuum` effective SHALL therefore be recognised as the setting
  at which `DELETE` reclaims just as well as `DROP TABLE`

#### Scenario: Reclaim cost is a property of the pages freed, not of the operation
- **WHEN** a range is retired at `auto_vacuum=INCREMENTAL` by each operation in turn and
  `PRAGMA incremental_vacuum` is then run
- **THEN** the two `incremental_vacuum` costs SHALL be equivalent, because the same pages are being
  returned in both cases
- **AND** this SHALL be the reason the layout ruling does not depend on which operation is marginally
  faster

#### Scenario: A layout selected on the retracted argument is rejected (negative control)
- **GIVEN** a proposal for a table-per-height-range layout justified by the research finding that
  *"`DROP TABLE` of a 1 M-row range is 35 ms and returns the space, versus 1,296 ms for the equivalent
  `DELETE`, which returns nothing"*
- **WHEN** that justification is checked against the three scenarios above
- **THEN** it SHALL be rejected, because the two halves of the comparison were measured on databases
  with different `auto_vacuum` settings and different contents, so the file-size difference is
  attributable to the setting rather than to the operation
- **AND** a proposal SHALL NOT be revived merely by re-measuring the timings, because condition (1) —
  a retention requirement a range `DELETE` cannot satisfy — is independent of any timing

#### Scenario: An unbounded range delete is a single transaction
- **WHEN** a height range is retired with one unbounded `DELETE … WHERE height < :x`
- **THEN** it SHALL commit as a single transaction, so the range is never observable half-retired
- **AND** an atomicity argument for `DROP TABLE` SHALL therefore be recognised as an argument about
  *chunking*, which is a separate decision applying equally to either operation

### Requirement: a view-routing insert trigger never accepts a row it does not store

The system SHALL NOT insert into a view through an `INSTEAD OF` trigger that can accept a row and
store it nowhere. WHERE such a trigger exists — which under the layout ruling above means only in a
re-proposed table-per-height-range design — it SHALL begin with a guard that aborts when the routing
key falls outside every target range, and the abort's message SHALL be the constraint name.

This is recorded as a requirement rather than dropped with the layout, because the failure it
prevents is silent, is the natural way to write the trigger, and would be reintroduced by anyone
reviving the layout.

#### Scenario: An unguarded routing trigger silently discards the row (negative control)
- **GIVEN** a routing trigger written as one `INSERT … SELECT … WHERE <range predicate>` per target
  range, with no guard arm
- **WHEN** a row whose routing key falls outside every range is inserted through the view
- **THEN** every predicate SHALL be false, no row SHALL be stored, **and no error SHALL be raised** —
  the caller observes a successful insert of a row that does not exist
- **AND** this SHALL be recognised as strictly worse than the PostgreSQL `DEFAULT` partition such a
  design replaces, which at least stored the row

#### Scenario: The guarded form rejects the same row loudly
- **WHEN** the same out-of-range row is inserted through a view whose trigger carries the guard arm
- **THEN** the insert SHALL fail with an error naming the guard constraint
- **AND** the rows already present SHALL be unchanged

#### Scenario: A view is not insertable at all without a trigger
- **WHEN** an insert is issued against a view carrying no `INSTEAD OF` trigger
- **THEN** the engine SHALL reject it
- **AND** this SHALL be understood as why such triggers get hand-written, and therefore why the guard
  requirement exists

#### Scenario: The catch-all range table is not reintroduced
- **WHEN** any layout proposal is reviewed
- **THEN** it SHALL NOT include a catch-all range table equivalent to PostgreSQL's `DEFAULT` partition
- **AND** the record SHALL state that the four rollover failure modes reproduced against real
  PostgreSQL at `design/full-chain-storage-design.md` §4.6 — the retained-foreign-key detach failure,
  the `duplicate_table` on recreate, the write race that makes the subsequent attach fail, and
  `DETACH … CONCURRENTLY` refusing whenever a default partition exists — were each caused by that
  catch-all, and are **retired with reason** under the single-table ruling

### Requirement: a height-qualified read resolves in one index descent

The system SHALL serve a point or range lookup by height from a single index descent on the relation's
own table. The system SHALL NOT introduce a read path whose cost grows with the number of physical
tables the relation is spread across.

#### Scenario: The engine performs no partition elimination (negative control)
- **GIVEN** a hypothetical table-per-height-range layout in which every non-matching range table
  carries a `CHECK` constraint that **proves** it cannot contain a matching row
- **WHEN** a range query with a height predicate is issued through the `UNION ALL` view
- **THEN** the query plan SHALL show a search of **every** range table, because SQLite does not
  consult `CHECK` constraints for partition elimination
- **AND** the same query issued directly against the one covering table SHALL show a single search,
  which is what the single-table ruling gives unconditionally

#### Scenario: The compound-select cap bounds any such layout
- **WHEN** the number of arms in a `UNION ALL` view is increased
- **THEN** 500 arms SHALL be accepted and 501 SHALL be rejected with `too many terms in compound
  SELECT`
- **AND** this SHALL be recorded as a bound on any revived layout, while the per-query fan-out rather
  than this cap SHALL be recognised as the binding cost

### Requirement: at most one canonical block per height is enforced by the database (invariant I-2)

The system SHALL enforce, in the database rather than in application code, that at most one block per
`(net, height)` is marked canonical, by a partial unique index on `(net, height) WHERE is_canonical`.

This is a **mandatory Class B invariant**. Its exposure is measured rather than hypothetical: a single
corrupted byte can yield two canonical blocks at one height while `PRAGMA integrity_check` reports
`ok`. No digest reaches this failure, because the bytes of each row are individually intact — it is
the wrong *row set* that is returned.

#### Scenario: A second canonical block at the same height is rejected on write
- **WHEN** a second block at an already-canonical `(net, height)` is inserted with `is_canonical` set
- **THEN** the insert SHALL be rejected by the unique index

#### Scenario: Two canonical blocks at one height are detectable at rest, where a digest is not
- **GIVEN** a database in which corruption has produced two rows at one `(net, height)` both marked
  canonical
- **WHEN** the verification pass runs
- **THEN** the condition SHALL be reported by the structural check or the invariant query
- **AND** a per-row digest sweep SHALL NOT detect it, because each individual row's bytes verify
  correctly — which is why this invariant exists rather than a digest column on this table

#### Scenario: The partial shape is correct here even though the full shape was ruled correct elsewhere
- **WHEN** this index's shape is compared with the **full** unique index ruled for the checkpoint
  manifest table by `v1.0.0-sqlite-schema-parity`
- **THEN** the difference SHALL be justified by the predicate's nature, not by preference: the
  manifest predicate is bookkeeping that is true for every row, so the partial and full shapes are
  equivalent in extension and the one that does not depend on a mutable byte wins
- **AND** `is_canonical` is a genuine domain fact with several legitimate rows per height, because
  this schema deliberately stores the whole block tree rather than only the canonical chain, so a
  full unique index on `(net, height)` would forbid the forks the archive exists to retain
- **AND** the predicate is not free-floating: the biconditional and implication `CHECK`s already on
  the table mean a flip of `is_canonical` must corrupt `status` consistently to remain
  representable, which answers the corruptible-predicate objection rather than waving it away

#### Scenario: Overlapping ranges would break the equivalence in a revived range layout
- **WHEN** a revived table-per-height-range layout's range constraints admit a common height
- **THEN** the layout SHALL be rejected at migration time, because per-range uniqueness would no
  longer imply global uniqueness and the invariant would silently degrade to an application
  assumption

### Requirement: the archive cursor is bounded by its data and its monotonic guard cannot latch

On read, the system SHALL assert that the archive ingest cursor's height is at most
`coalesce(max(height), -1) + 1` over the stored blocks, and SHALL raise the typed value-integrity
error when it is not (invariant I-8). The aggregate SHALL be wrapped in `coalesce`, matching the form
`v1.0.0-sqlite-schema-parity` uses for invariant I-1: a bare `max(...)` over an empty table yields
NULL, and every comparison against NULL yields NULL, so the assertion would neither pass nor fail —
it would silently not fire, which is the failure mode this family of invariants exists to close. WHEN a monotonic guard suppresses a cursor write as a regression, the system SHALL
verify the incumbent row's digest within the same transaction, and IF that digest fails THEN it SHALL
raise the value-integrity error rather than silently performing no write (invariant I-6).

#### Scenario: A cursor ahead of its data is rejected on read
- **WHEN** the stored cursor height exceeds the highest stored block height by more than one
- **THEN** the read SHALL raise the value-integrity error naming the cursor
- **AND** the bound SHALL be exactly one, because the cursor advances in the same transaction as the
  bundle it passes, so "one past the highest stored height" is the only legitimate excess

#### Scenario: The bound fires on an empty blocks table rather than evaluating to NULL (negative control)
- **GIVEN** an archive with no block rows and a cursor row claiming a positive height
- **WHEN** the invariant is evaluated
- **THEN** it SHALL raise, because `coalesce(max(height), -1) + 1` is `0` and the claimed height
  exceeds it
- **AND** a hypothetical implementation comparing against a bare `max(height)` SHALL neither raise
  nor pass, because the comparison evaluates to NULL — the assertion silently does not fire, on
  exactly the state the archive starts in

#### Scenario: A corrupted-forward cursor latches permanently without the guard (negative control)
- **GIVEN** a cursor whose stored height has been corrupted forward, and a monotonic guard that
  suppresses any write proposing a lower height
- **WHEN** ingest subsequently proposes its next legitimate height, repeatedly
- **THEN** without I-6 the guard SHALL discard **every** such advance as a regression, in silence,
  and the archive SHALL stop advancing with no error ever raised
- **AND** the failure SHALL be understood as **latching rather than merely missing**: the established
  finding is not that a monotonic guard fails to notice a corrupted-high cursor, but that it pins it
  — four consecutive legitimate writes were observed failing to lower it — so the corruption becomes
  permanent and self-defending rather than transient
- **AND** with I-6 the suppressed write SHALL trigger verification of the incumbent row, whose digest
  fails, converting a silent permanent latch into a raised error at the first suppression

#### Scenario: The suppression path is the detection point, not the write path
- **WHEN** the placement of the I-6 check is reviewed
- **THEN** it SHALL run on the path where a write is **suppressed**, not on the path where a write
  succeeds
- **AND** this SHALL be recognised as the point of the invariant: a corrupted-high cursor produces no
  successful writes to hang a check on, so a check placed only on the success path would never fire
  for exactly the fault it exists to catch

#### Scenario: The wallet cursor cannot carry this check, which is why the asymmetry exists
- **WHEN** the asymmetry between the two cursors is documented
- **THEN** it SHALL state that only the archive cursor has a data side inside UmbraDB to compare
  against — the archive indexes blocks it also stores, whereas the wallet-sync cursor names a
  position in a chain UmbraDB does not hold
- **AND** it SHALL record that a data-side sanity check was offered as an escape hatch for the
  watermark tables generally and found **not implementable on the wallet side** for that reason,
  which is why that cursor is covered by a digest instead
- **AND** the archive SHALL therefore carry **both** mechanisms rather than choosing between them,
  because the digest answers a corrupted value and the bound answers a value that is individually
  well-formed but inconsistent with the data it describes

### Requirement: verifier-key observation identity uses the ruled coalesce expression index, not a plain UNIQUE

The system SHALL express `verifier_key_observations`' identity constraint as a unique expression
index over `coalesce(contract_address, <sentinel>)` together with a `CHECK` excluding the sentinel
from the column's real domain — the form ruled by `v1.0.0-sqlite-schema-parity`. A plain `UNIQUE`
naming `contract_address` directly SHALL NOT appear in this lineage. The upsert target SHALL name the
same expression.

This is the only instance in the repository of PostgreSQL's `UNIQUE NULLS NOT DISTINCT`
(`001_chain_archive_core.ts:570`), and it is the constraint whose absence the v4 design-council audit
found had already lost data: *"two legitimate different-entry-point observations of the same VK
collided and one silently lost the race"* (`:63-70`).

#### Scenario: An exact duplicate NULL-address observation is rejected
- **WHEN** a second row is inserted with the same `(vk_hash, net, scope, tag)` and
  `contract_address IS NULL`
- **THEN** the insert SHALL be rejected by the unique expression index

#### Scenario: Legitimately distinct NULL-address observations both persist
- **WHEN** two protocol-scoped observations of the same verifier key differing only in `net` are
  inserted, both with `contract_address IS NULL`
- **THEN** both SHALL persist as distinct rows

#### Scenario: A plain UNIQUE accepts the duplicate and reintroduces the audited bug (negative control)
- **GIVEN** a hypothetical port that transliterates `001_chain_archive_core.ts:570` as a plain
  `UNIQUE (vk_hash, net, scope, contract_address, tag)`
- **WHEN** the exact-duplicate NULL-address insert above is issued
- **THEN** that port SHALL **accept** it, because SQLite treats every NULL as distinct from every
  other NULL
- **AND** the accepted duplicate SHALL be exactly the defect recorded at `:522-529` — *"ordinary
  `UNIQUE` … would NOT have caught that duplicate"*
- **AND** the port SHALL pass every test whose rows carry a non-NULL address, which is why the
  NULL-address scenarios above are the ones that must exist

#### Scenario: The sentinel is excluded from the column's real domain
- **WHEN** a zero-length value is written to `contract_address`
- **THEN** the write SHALL be rejected by the accompanying `CHECK`
- **AND** without that `CHECK` a genuine zero-length address would collide with the NULL sentinel,
  wrongly rejecting a legitimately distinct row — a new defect traded for the old one

### Requirement: every PostgreSQL guard trigger has a named SQLite counterpart and row locking is removed with reason

The system SHALL reproduce each guard the PostgreSQL lineage enforces by trigger — blob-role
completeness on every table that references a blob, the blob-role removal guard, and
finalized-monotonicity on `blocks` — as a `BEFORE` trigger that aborts with the constraint name. The
`FOR SHARE` / `FOR UPDATE` row locking those PostgreSQL guards use SHALL be removed, and its removal
SHALL be justified by single-writer serialization under `BEGIN IMMEDIATE`
(`v1.0.0-sqlite-concurrency-lease`), not by the guards being unnecessary.

**This justification is conditional and the condition SHALL be stated wherever it is made.** It rests
on write-lock exclusivity, which requires both the archive writer registration above **and** the
descriptor precondition: SQLite's write lock is a POSIX record lock dropped when the holding process
closes any descriptor on the inode carrying it. IF that precondition is violated THEN the
justification is **absent**, not weakened, and the removed row locking was load-bearing after all.

Each guard SHALL be declared once, on the one table it guards. SQLite provides no
partitioned-parent trigger cloning, so a revived table-per-height-range layout would have to
redeclare every guard on every range table and regenerate them at each rollover — recorded as a
further cost of that layout, not as a property of this one.

#### Scenario: A block referencing an unclassified blob is rejected
- **WHEN** a block is inserted whose header blob has no matching blob-role row
- **THEN** the insert SHALL be rejected with an error naming the blob-role completeness constraint

#### Scenario: Un-finalizing a finalized block is rejected
- **WHEN** an update sets `finalized` to false on a block that is already finalized
- **THEN** the update SHALL be rejected with an error naming the monotonicity constraint

#### Scenario: Removing a blob role under a live reference is rejected
- **WHEN** a blob-role row is deleted while a table still references that blob under that role
- **THEN** the delete SHALL be rejected with an error naming the removal-guard constraint

#### Scenario: The removal of row locking is justified, not assumed
- **WHEN** the design record for the removal-guard trigger is read
- **THEN** it SHALL state that the two-session interleaving proof recorded at
  `001_chain_archive_core.ts:605-654` is discharged by single-writer serialization
- **AND** it SHALL name `BEGIN IMMEDIATE` on every archive write path as the condition that argument
  depends on, and name the change that owns it

### Requirement: blob content is stored in the database and verified on read by recomputing its address

The system SHALL store chain blob payloads in the archive database rather than in external files, and
SHALL compute each blob's content address itself rather than accepting one from a caller. WHEN a blob
is read back, the system SHALL recompute its content address and compare it to the stored key, and IF
they differ THEN the read SHALL reject with a typed, `code`-discriminated error following the one
error idiom of `design/design-interfaces.md` §1.1 — never returning the bytes to the caller.

This is the mechanism `CheckpointStore` already uses for its chunk tier
(`Formal/STORAGE_ALGEBRA.md` §2, Law C1: *"a chunk's hash IS a proof of its own content"*), and it is
why the blob table needs no separate digest column under
`v1.0.0-sqlite-durability-contract`'s digest regime.

#### Scenario: A blob corrupted in place is detected on read
- **WHEN** a stored blob's bytes are altered in the database file after it was written and
  checkpointed, and the blob is subsequently read through the adapter
- **THEN** the read SHALL reject with the content-integrity error
- **AND** the corrupted bytes SHALL NOT be returned to the caller as data

#### Scenario: Structural verification alone does not detect payload corruption (negative control)
- **GIVEN** a hypothetical implementation relying on `PRAGMA integrity_check` as its corruption
  detection for blob content
- **WHEN** bytes **within a stored blob's payload** — in an overflow page, not in SQLite's own
  b-tree structures — are overwritten in a checkpointed database file and the database is reopened
- **THEN** the structural check SHALL report `ok` and the corrupted blob SHALL be returned as data
- **AND** the scenario SHALL be written in the **two-case** form, because the unqualified claim is
  refuted: damage to SQLite's own structures **is** detected and the read fails, while damage
  confined to a stored value's bytes is not — the structural check is sound for rejection and not
  sound for acceptance
- **AND** the corruption offset SHALL be chosen with regard to page role, since a test written to the
  unqualified wording is non-deterministic about which case it exercises
- **AND** this SHALL be the reason content verification is specified on the read path rather than
  delegated to a structural pass

#### Scenario: A page-level checksum shim is not treated as an available alternative
- **WHEN** a page-checksum layer is proposed as a substitute for read-path verification
- **THEN** it SHALL be rejected on the grounds already adjudicated: it is absent from the pinned
  binding's build, its enabling path is unreachable from this runtime, and its registration is
  **process-global** — UmbraDB is a library in another process and may not make itself the default
  virtual file system for unrelated code at any version
- **AND** the archive SHALL NOT pre-set reserved bytes on its database file in anticipation, because
  doing so permanently freezes `page_size`, which the snapshot manifest records as irreversible

#### Scenario: External blob files are not used
- **WHEN** the archive's storage layout is inspected
- **THEN** blob payloads SHALL reside in the database file
- **AND** the record SHALL state the three properties external files would cost: foreign-key
  enforcement between a blob and its referencing metadata row, transactional consistency between
  them, and the single-file snapshot artifact this capability's snapshot requirement depends on

#### Scenario: The blob table is a rowid table and the junction is not
- **WHEN** the ported data-definition language is inspected
- **THEN** the payload-bearing blob table SHALL NOT be declared `WITHOUT ROWID`
- **AND** the narrow blob-role junction table SHALL be

### Requirement: the archive write path reuses prepared statements and acquires no bind-parameter row cap

The system SHALL write an ingested block, its transactions and its bridge observations by re-running
prepared statements inside one explicit transaction. The system SHALL NOT introduce a maximum-rows
constant derived from the engine's bind-parameter ceiling on any archive write path.

The archive's PostgreSQL adapter already issues single-row statements in a loop
(`src/postgres/chain-archive-store.ts:214-262`), so this is the shape being preserved, not a new one.
A re-run prepared statement binds a fixed number of parameters per execution and is therefore not
subject to the ceiling at all.

#### Scenario: No row cap constant exists on an archive write path
- **WHEN** the archive adapter's source is inspected
- **THEN** no constant SHALL bound rows per statement as a function of the bind-parameter ceiling
- **AND** the absence SHALL be deliberate: the wallet tier's equivalent constants exist because a
  multi-row statement binds parameters per row, which no archive write path does

#### Scenario: A bundle larger than the parameter ceiling would allow still commits
- **WHEN** a block bundle containing more records than the bind-parameter ceiling divided by the
  per-row parameter count is written
- **THEN** the write SHALL succeed in one transaction
- **AND** a hypothetical port that assembled the same bundle into one multi-row statement SHALL fail
  to prepare, which is the failure this requirement exists to make unreachable

### Requirement: the ingest cursor advances in the same transaction as the block bundle it passes

The system SHALL write the ingested block bundle and the advance of the archive's ingest watermark in
one transaction. The watermark SHALL NOT be committed separately from the data it describes.

The atomicity this provides is intra-process. Its cross-process exclusivity rests on the archive
writer registration and on the descriptor precondition, and SHALL carry that qualifier rather than
reading as unconditional.

Today these are two independently committed transactions
(`chain-archive-sync/sync-service.ts:168-170`). This mirrors the wallet tier's co-transactional
`saveAndAdvance` (`design/design.md` §5; `Formal/STORAGE_ALGEBRA.md` §4) and makes structural the
property the wallet tier states in writing — that the durable cursor is never ahead of durable data.

#### Scenario: A crash between the bundle and the cursor is unrepresentable
- **WHEN** the process is killed at an arbitrary point during ingest and the archive is reopened
- **THEN** the ingest watermark SHALL correspond to a height whose block bundle is fully present, or
  to a height before it — never to a height whose bundle is absent
- **AND** the reopened archive SHALL resume from the watermark without error

#### Scenario: Two independently committed transactions permit a cursor ahead of its data (negative control)
- **GIVEN** a hypothetical port that keeps today's shape — the bundle in one transaction, the
  watermark in a second
- **WHEN** the process is killed between the two commits, with the watermark commit ordered first
- **THEN** the reopened archive SHALL hold a cursor referring to a height whose data was never
  committed, and ingest SHALL resume past a gap
- **AND** this SHALL be distinguished from today's actual ordering, which commits the bundle first
  and is therefore safe but wasteful — the requirement removes the ordering dependence, it does not
  claim the current code is broken

#### Scenario: Idempotent re-ingest still holds
- **WHEN** a height whose bundle is already fully committed is ingested again
- **THEN** every insert SHALL be a no-op rather than a duplicate-key error, so a crash **within** the
  single transaction is recoverable by replay

### Requirement: constraint identity survives the port and message parsing is confined to one function

The system SHALL raise, for every constraint the archive lineage declares, an UmbraDB error whose
class and `constraintName` match the error the PostgreSQL adapter raised for the same violation. The
error class SHALL be selected by the driver's **string** `code`. Extraction of a constraint name from
a driver error message SHALL be confined to one function.

In PostgreSQL the constraint name arrives in a structured field, which is why the lineage uses
`RAISE EXCEPTION … USING CONSTRAINT = '…'` (`001_chain_archive_core.ts:193-204`) to populate it. The
SQLite driver error carries only a message and a code, so the name is recoverable only from the
message. This is a **regression** in structure and SHALL be recorded as one, not as the improvement
an earlier research pass reported.

#### Scenario: Every declared constraint name is recoverable from the error it raises
- **WHEN** each constraint the lineage declares is violated in turn
- **THEN** the extraction function SHALL return that constraint's declared name for every one of them
- **AND** the test SHALL be driven from the lineage's own list of declared constraint names, so a
  newly added constraint whose name is not recoverable fails the test

#### Scenario: The two message grammars are the extraction function's only inputs
- **WHEN** the extraction function is inspected
- **THEN** it SHALL handle the trigger-abort grammar, in which the message is the bare constraint
  name, and the check-violation grammar, in which the name follows a fixed prefix
- **AND** an unrecognised message SHALL produce an explicit unknown-constraint outcome rather than a
  silently wrong name

#### Scenario: The class is chosen by code, never by message (negative control)
- **GIVEN** a hypothetical translator that selects the error class by matching message text
- **WHEN** the driver's message wording changes between patch versions
- **THEN** that translator SHALL silently mis-route errors, whereas a translator keyed on the string
  `code` SHALL be unaffected
- **AND** the constraint-name extraction SHALL still fail loudly under the same change, because it is
  covered by the round-trip test above

#### Scenario: The existing negative-path tests are re-executed, not amended
- **WHEN** the archive's existing tests are ported
- **THEN** every negative-path assertion in them — the fork and dual-canonical cases, the foreign-key
  violation, blob-role completeness, the removal guard, and finalized monotonicity — SHALL be
  re-executed against the SQLite lineage
- **AND** an assertion SHALL be weakened or deleted only by a reviewed change that states what
  behaviour was given up and why, never as part of making a port pass

### Requirement: the archive's bounded delete is written in the form that needs no optional compile option

WHERE the system deletes a bounded number of rows, it SHALL express the bound with a row-identifier
subquery rather than a `LIMIT` clause attached to the delete statement.

This is an **application** of `v1.0.0-sqlite-engine-core`'s rule that UmbraDB SHALL NOT issue SQL
whose validity depends on a compile option that is not recorded and asserted; the inventory obligation
and the general rule are that change's, and this capability neither restates them nor asserts a
compile-option value of its own. Recorded here because an earlier research pass concluded the rewrite
was *forced* by the option's absence, which is not the case on the ruled binding — the rewrite is
required despite the option being available.

#### Scenario: The bounded delete works regardless of the compile option
- **WHEN** a bounded delete is issued using the row-identifier subquery form
- **THEN** it SHALL delete at most the requested number of rows
- **AND** it SHALL parse on a build with the optional statement-limiting compile option absent

#### Scenario: Availability is not a reason to depend on it (negative control)
- **GIVEN** an archive statement written in the convenient form because the optional compile option is
  present on the currently pinned binding, so it parses and every test passes
- **WHEN** the binding is rebuilt, or replaced by another build of the same version, without that
  option
- **THEN** the statement CAN fail as a syntax error at runtime on a consumer's machine, in a path CI
  never exercised
- **AND** the defect SHALL be attributed to *dependence* rather than to *availability*, per the rule
  this requirement applies

### Requirement: a snapshot is a database file with no outstanding write-ahead-log dependency, together with a manifest

The system SHALL define an archive snapshot as a set comprising one archive database file carrying no
outstanding write-ahead-log dependency and one manifest describing it. A snapshot SHALL NOT be
defined as, or produced as, a copy of the main database file alone, and the shared-memory sidecar
SHALL NOT be part of a snapshot under any form.

#### Scenario: Copying the main file alone is rejected as a snapshot procedure
- **WHEN** the snapshot procedure is documented
- **THEN** it SHALL state that the write-ahead-log sidecar holds every commit since the last
  checkpoint, so a copy of the main file alone silently reverts the database to an arbitrarily older
  state while still reporting a clean structural check
- **AND** it SHALL state that this failure is invisible to `PRAGMA integrity_check`

#### Scenario: A snapshot produced from a live database restores to the state its manifest describes
- **WHEN** a snapshot is produced while ingest is running, and the artifact is then opened
- **THEN** every field the manifest derives from the artifact SHALL match the artifact
- **AND** the artifact SHALL require no sidecar file to reach that state

### Requirement: the snapshot and verification tooling runs outside the library process

The module that produces a snapshot, derives its manifest, or verifies a restored artifact SHALL NOT
live under `src/`, and SHALL run as a separate tool alongside the archive sync entry point. It SHALL
operate only on a **finished artifact** or on a **quiesced** archive, never on a database file that
the library process holds open.

This follows from the build-failing descriptor ban, which takes no exemptions. A manifest or
verification tool necessarily opens database files; placed inside `src/`, it is precisely the
descriptor operation the ban rejects, and an in-process copy of the three-file set is the write-lock
attack performed by the project's own documentation. The ban's scope SHALL NOT be weakened to
accommodate this capability.

#### Scenario: The snapshot module is not part of the shipped library surface
- **WHEN** the file layout is inspected
- **THEN** no module under `src/` SHALL open a descriptor on an archive database path or its sidecars
- **AND** the snapshot, manifest-derivation and restore-verification code SHALL live outside `src/`,
  beside the archive sync entry point rather than inside the published build

#### Scenario: An in-process snapshot module is rejected even though it is our own code (negative control)
- **GIVEN** a proposed `src/`-resident snapshot module that opens the archive file and its `-wal` and
  `-shm` sidecars to copy them
- **WHEN** it runs concurrently with an open write transaction in the same process
- **THEN** it SHALL void the write lock exactly as a hostile reader would, with no error raised
- **AND** the proposal SHALL be rejected rather than granted an exemption, because the ban's value is
  that it has none — an exemption for trusted tooling is the attack with a friendlier name

#### Scenario: Quiesce is what makes the out-of-process procedure safe
- **WHEN** the snapshot procedure operates on a live archive rather than a finished artifact
- **THEN** it SHALL first quiesce the writer through the sync entry point's termination-signal stop
  path
- **AND** the procedure SHALL state that a quiesced archive means no open write transaction and no
  open handle, so the artifact it copies is not being written beneath it

### Requirement: the snapshot manifest is derived from the finished artifact, never from the source database

The system SHALL compute every derived field of a snapshot manifest by reading the finished snapshot
artifact. It SHALL NOT compute any derived field from the source database before or during the copy.

This is what makes a copy primitive's capture semantics harmless: a copy that captures a committed
state **at or after** the call, rather than as of it, cannot disagree with a manifest that was read
out of the copy.

#### Scenario: A copy that advanced past the call still matches its manifest
- **WHEN** a snapshot is produced under concurrent ingest and the copy therefore contains commits
  that landed after the copy began
- **THEN** the manifest's height range, canonical tip, row counts and content digest SHALL describe
  what the copy contains
- **AND** the restore verification SHALL pass

#### Scenario: A manifest derived from the source under-reports the artifact (negative control)
- **GIVEN** a hypothetical implementation that records the source's canonical tip and row counts
  before starting the copy
- **WHEN** ingest commits further blocks while the copy runs
- **THEN** the manifest SHALL describe less content than the artifact holds, and the restore
  verification SHALL either fail on a row-count comparison or, worse, pass while the artifact and its
  label disagree about what chain range was archived
- **AND** this SHALL be recognised as the failure mode the derive-from-artifact rule exists to make
  unreachable

### Requirement: the snapshot manifest identifies the artifact well enough to restore it safely

A snapshot manifest SHALL carry, at minimum: the migration lineage and the list of applied
migrations; the schema value the lineage was applied under; the network; the canonical height range;
the canonical tip as a height and block hash; the archive's own watermark rows; a row count per
table; a content digest; the irreversible pragma values the file was created with (`page_size` and
`auto_vacuum`); the
binding name, its pinned package version and the runtime SQLite version; and the UmbraDB version.

An archive database file without such a manifest SHALL NOT be treated as a snapshot.

#### Scenario: A restore into a mismatched lineage fails loudly
- **WHEN** a snapshot whose manifest names a different applied-migration list than the running code
  expects is restored
- **THEN** the restore SHALL fail with an error naming the mismatch
- **AND** the archive SHALL NOT be opened for writing

#### Scenario: A wrong-network artifact is detected before use
- **WHEN** a snapshot whose manifest names one network is restored into a deployment configured for
  another
- **THEN** the mismatch SHALL be reported before any ingest occurs

#### Scenario: The content digest is over logical content, not file bytes
- **WHEN** two snapshots of the same logical content are produced by two different copy mechanisms,
  one of which compacts the file
- **THEN** the two artifacts SHALL NOT be byte-identical
- **AND** their content digests SHALL be equal, which is why the identity check is specified over
  ordered logical content rather than as a file checksum

#### Scenario: The digest is a flat root over an ordered sequence, not a tree
- **WHEN** the digest's definition is read
- **THEN** it SHALL be a single hash over the ordered canonical `(net, height, block_hash)` sequence
  with a domain-separation prefix
- **AND** the record SHALL state that no Merkle tree, inclusion proof or third-party verification
  protocol is provided, because `Formal/STORAGE_ALGEBRA.md` §6 rules against an authenticated data
  structure for this deployment and this digest is the "rudimentary" content-addressing case that
  section already grants, not the tree it declined

### Requirement: restoring a snapshot runs four checks and reports them separately

WHEN a snapshot is restored, the system SHALL run and report, as four separately named outcomes: a
structural and stored-value verification (the pass owned by
`v1.0.0-sqlite-durability-contract`); an identity comparison of every derived manifest field
recomputed from the restored file; an assertion that the restored file's irreversible pragma values
match the manifest; and a continuity walk of the canonical header chain over the manifest's height
range. The system SHALL NOT report an overall pass when any of the four fails.

Each check SHALL report one of three outcomes: `pass`, `fail`, or **`n/a — no rows in scope`**. A
check whose scope contains no rows SHALL report `n/a`, and SHALL NOT report `pass`. An overall
result SHALL NOT be reported as a pass when every check reported `n/a`.

#### Scenario: An operator can tell which check failed
- **WHEN** a restore verification fails
- **THEN** the report SHALL name which of the four checks failed and SHALL report the other three
  independently

#### Scenario: A zero-row archive does not report a passing restore (negative control)
- **GIVEN** the archive's own specified starting state — a fresh, greenfield, zero-row database
- **WHEN** the four restore checks run against it
- **THEN** the identity, continuity and digest-sweep checks SHALL each report `n/a — no rows in
  scope`, because there is nothing for them to compare, walk or verify
- **AND** the overall result SHALL NOT be reported as a pass
- **AND** a hypothetical implementation reporting `pass` for all four SHALL be treated as defective:
  it certifies an empty artifact as verified, which is this sprint's recurring silent-success shape
  rather than a benign edge case

#### Scenario: A page-size mismatch is detected and named unrepairable
- **WHEN** the restored file's `page_size` or `auto_vacuum` differs from the manifest's
- **THEN** the verification SHALL fail
- **AND** the report SHALL state that these values cannot be changed in place, so the remedy is to
  obtain a correct artifact rather than to repair this one

#### Scenario: A break in the stored header chain is detected
- **WHEN** a canonical block row within the manifest's height range is absent or carries a
  `parent_hash` that does not equal the preceding row's `block_hash`
- **THEN** the continuity walk SHALL fail and SHALL name the height at which the walk broke

#### Scenario: None of the four checks is wired into startup, ingest or a schedule
- **WHEN** the archive's runtime paths are inspected
- **THEN** none of the four checks SHALL run on archive open, inside the ingest loop, or on a timer
- **AND** they SHALL run only on restore or on explicit demand, because the whole-database
  verification pass has **no measured runtime at archive scale** and wiring an unmeasured cost into
  every start of a long-running process would convert a diagnostic into a blocking gate
- **AND** the continuity walk SHALL be subject to the same rule, because it is a scan over a height
  range whose cost grows with the archive rather than with the restore

#### Scenario: The verification pass is described as a diagnostic until its runtime is measured
- **WHEN** the archive's documentation of the verification pass is read before the archive-scale
  runtime measurement exists
- **THEN** it SHALL be described as an on-demand diagnostic and the post-restore check
- **AND** no text SHALL recommend a periodic or scheduled pass, because affordability at archive
  scale is unestablished

### Requirement: a snapshot makes no completeness claim

The snapshot manifest SHALL NOT contain a field named or documented as asserting that the archive is
complete, and the restore report SHALL state what the continuity walk does and does not prove.

Adopted verbatim from `design/full-chain-storage-design.md` §9's own v3 audit fix and §10.9, rather
than restated more favourably.

#### Scenario: The documented limits of the continuity walk are stated where the result is reported
- **WHEN** the restore report's continuity section is read
- **THEN** it SHALL state that the walk proves one stored header chain is internally continuous
- **AND** it SHALL state that it does **not** prove fork completeness, because a missing orphaned
  block does not break the canonical walk
- **AND** it SHALL state that it does **not** prove transaction or bridge-observation completeness,
  because a block row can exist, hash-chain correctly and hold none of its real transactions
- **AND** it SHALL state that it does **not** prove body integrity, and cannot with this schema,
  because the block body needed to recompute `extrinsics_root` is nullable and often absent

#### Scenario: A stronger claim is rejected in review (negative control)
- **GIVEN** a proposed manifest field asserting the archive is complete for a height range, justified
  by the continuity walk passing
- **WHEN** it is evaluated against this requirement
- **THEN** it SHALL be rejected, because the walk's four documented limits each admit an archive that
  passes the walk and is incomplete

### Requirement: no live-backup primitive is named for the archive until it has been measured on the ruled binding

This capability SHALL NOT name the mechanism that produces a snapshot copy until the comparison
between the ruled binding's online backup call and `VACUUM INTO` has been re-measured on the ruled
binding and recorded, which is `v1.0.0-sqlite-engine-core`'s blocked decision B-6 and
`v1.0.0-sqlite-durability-contract`'s to rule.

WHERE the archive tier's answer may differ from the wallet tier's, the difference SHALL be stated
explicitly: the archive MAY adopt a **more** stalling copy procedure than the wallet tier, because
its writer is a batch ingest loop with an existing signal-driven stop path rather than an interactive
wallet. The archive SHALL NOT adopt a weaker definition of the artifact.

#### Scenario: The archive's snapshot documentation names properties, not a primitive
- **WHEN** the archive snapshot procedure is reviewed before B-6 has been recorded
- **THEN** it SHALL specify what the artifact must be, how the manifest is derived and what is
  verified, and SHALL NOT name the call that produces the copy

#### Scenario: Carrying the corpus measurement into this capability is rejected (negative control)
- **GIVEN** a proposal naming the online backup call as the archive's snapshot mechanism, citing a
  measurement in which a copy completed integrity-clean under concurrent commits with the event loop
  turning
- **WHEN** that citation's recorded conditions are checked and show a binding other than the ruled
  one
- **THEN** the proposal SHALL be rejected — the same defect class as a throughput figure taken on a
  memory filesystem, and the same rejection
  `v1.0.0-sqlite-durability-contract` already applies to that measurement

#### Scenario: An offline procedure is a legitimate outcome for the archive
- **WHEN** B-6 rules that no live-backup primitive is acceptable
- **THEN** the archive SHALL adopt a quiesce-then-copy procedure using the sync entry point's
  existing termination-signal stop path
- **AND** this capability SHALL NOT be judged incomplete for lacking a live primitive

### Requirement: the archive's durability setting is not lowered without four stated preconditions

The archive database's `synchronous` setting SHALL default to the same value as the wallet tier's. IF
a proposal is made to lower it for the archive, THEN it SHALL be accepted only when all four of the
following hold and SHALL be rejected when any one is missing: the three preconditions
`v1.0.0-sqlite-durability-contract` states for lowering the default, **and** a written, per-table
re-derivability determination for the archive.

No document in this change SHALL state a commits-per-second figure, throughput ratio or latency for
any `synchronous` level as an established fact.

#### Scenario: The re-derivability determination addresses the two tables that are not re-derivable
- **WHEN** a per-table re-derivability determination is offered
- **THEN** it SHALL address `bridge_observations`, which
  `design/full-chain-storage-design.md` §7 records as *"partly Cardano-side and not cleanly
  re-derivable from Midnight block replay alone"*, and `verifier_key_observations`, which §4.5 and §3
  record as covering a category the upstream indexer does not archive at all
- **AND** a determination that marks a table's re-derivability as unverified SHALL NOT count as
  addressing it

#### Scenario: The re-derivable premise is not assumed from the tier's name (negative control)
- **GIVEN** a proposal to lower the archive's durability setting justified only by the archive being
  re-derivable from chain
- **WHEN** it is evaluated against the fourth precondition
- **THEN** it SHALL be rejected, because the premise is false for at least two of the archive's
  tables and is flagged unverified for the deferred categories by the archive's own design document
- **AND** the two-file split SHALL be understood as making the decision available separately for each
  tier, not as making it already decided differently

### Requirement: each archive table has a stated integrity classification and mechanism

Every table in the archive lineage SHALL carry one of two integrity classifications, and no table
SHALL be left unclassified. The classifications and their mechanisms are:

| Table | Classification | Mechanism |
|---|---|---|
| `chain_blobs` | UNCOVERED — already protected | content-addressed; rehash-on-read |
| `blocks` | UNCOVERED | projection of rehash-verified blobs; invariant I-2 plus the rebuild path |
| `transactions` | UNCOVERED | projection of rehash-verified blobs; rebuild path |
| `chain_blob_roles` | UNCOVERED | both columns are the primary key; corruption is b-tree-detectable |
| `bridge_observations` | **COVERED** | multi-column digest, verified on every read |
| `verifier_key_observations` | **COVERED** | multi-column digest, verified on every read |
| `watermarks` (archive lineage) | **COVERED** | digest, plus invariants I-6 and I-8 |

A covered table's digest SHALL follow the specification owned by
`v1.0.0-sqlite-durability-contract`; this capability SHALL NOT restate it. Verification of a covered
column on read SHALL be mandatory, with no opt-out.

The two covered observation tables are covered **because this lineage's own design document rules
them not cleanly re-derivable** — `bridge_observations` being partly Cardano-side with replay
reconstruction unverified (`design/full-chain-storage-design.md` §7), and
`verifier_key_observations` covering the one category with no upstream archive to re-derive from
(§4.5, §3).

#### Scenario: A corrupted covered value is detected on read
- **WHEN** a stored value in a covered table is altered in the database file after it was written and
  checkpointed, and the row is read through the adapter
- **THEN** the read SHALL reject with the typed value-integrity error, naming the table and primary
  key
- **AND** the corrupted bytes SHALL NOT be returned to the caller

#### Scenario: A NULL digest on a covered row is an integrity failure, not a warning
- **WHEN** a covered row's digest is absent
- **THEN** the read SHALL reject with the typed value-integrity error
- **AND** it SHALL NOT be returned with a warning, because this lineage ships no backfill: every row
  is written with its digest in the same statement as the value, so an absent digest is corruption or
  a downgrade rather than a mid-backfill state
- **AND** a warn-and-return branch in this lineage SHALL be treated as dead code whose only reachable
  function is masking corruption

#### Scenario: The classification list is exhaustive
- **WHEN** the archive lineage's table list is compared against the classification table above
- **THEN** every table SHALL appear exactly once
- **AND** `chain_blob_roles` SHALL be present, because the adjudicated ruling records that this table
  was omitted from its own first enumeration — an omission is not a classification, and the check
  exists so a future table cannot be added without one

#### Scenario: A blanket exclusion of the archive is rejected (negative control)
- **GIVEN** a proposal to leave every archive table uncovered on the ground that the archive is
  re-derivable from chain
- **WHEN** it is evaluated against the two covered tables
- **THEN** it SHALL be rejected, because the same premise was already refused for this tier's
  durability setting, and a design cannot decline to weaken durability on the ground that two tables
  are not re-derivable while excluding those same two tables from integrity coverage on the ground
  that they are

#### Scenario: A digest column is not added to the high-row-count projection tables (negative control)
- **GIVEN** a proposal to cover `blocks` and `transactions` with digest columns for uniformity
- **WHEN** it is evaluated
- **THEN** it SHALL be rejected, because their exposure is Class B — the wrong row returned — which a
  digest cannot detect, and because the storage cost lands on the only tables in the lineage that
  reach chain scale
- **AND** the exclusion SHALL depend on the rebuild path below actually existing

### Requirement: the digest column and its drift guard follow this lineage's DDL conventions

WHERE a table is covered, the system SHALL add a `dg BLOB` column that is **nullable**, together with
a **named, null-tolerant length constraint** of the form
`CHECK (dg IS NULL OR octet_length(dg) = 32)`, in the migration that introduces the column. The
system SHALL NOT add any constraint that rejects a NULL `dg` — no `NOT NULL`, no non-null default.

The system SHALL create, per covered table, two `BEFORE UPDATE` triggers: a **drift guard** that
aborts when the covered column is updated without the digest changing, and an **anti-downgrade
guard** that aborts when `dg` is set to NULL over a non-NULL value. Both trigger names SHALL carry
the schema prefix like every other object this lineage creates, and both abort messages SHALL be the
constraint name so the single extraction function recovers them. Covered tables SHALL remain
`STRICT`.

Because this lineage is greenfield and ships **no backfill**, a NULL `dg` on a covered row SHALL be
`VALUE_INTEGRITY`, not a warning. No row in this lineage is ever written without its digest, so a
NULL is corruption or a downgrade, never a mid-backfill state.

#### Scenario: A truncated digest is rejected by the named length constraint
- **WHEN** a 31-byte value is written to `dg`
- **THEN** the write SHALL be rejected with an error naming the length constraint

#### Scenario: The length constraint does not foreclose the NULL marker
- **WHEN** `NULL` is written to `dg` on a fresh row
- **THEN** the named null-tolerant constraint SHALL accept it
- **AND** the constraint SHALL be recognised as compatible with NULL for a second, independent
  reason: SQL `CHECK` three-valued logic passes a NULL result, so **even a bare**
  `CHECK (octet_length(dg) = 32)` accepts NULL — measured on the ruled binding
- **AND** any rationale claiming that a length constraint in the adding migration would foreclose the
  NULL marker SHALL be treated as refuted in both forms

#### Scenario: A digest cannot be downgraded to NULL
- **GIVEN** a covered row whose `dg` holds a 32-byte digest
- **WHEN** `UPDATE … SET dg = NULL` is issued against it
- **THEN** the anti-downgrade trigger SHALL reject it naming its constraint
- **AND** without that trigger the update SHALL be **accepted** — one statement, touching no covered
  column, permanently downgrading the row to unverified — which is why the drift guard alone is
  insufficient and both triggers are required

#### Scenario: The anti-downgrade guard does not obstruct a legitimate recompute
- **WHEN** a covered column and its `dg` are updated together to new values
- **THEN** both triggers SHALL permit it

#### Scenario: Updating a covered value without recomputing its digest is rejected
- **WHEN** an update changes a covered column while leaving `dg` identical
- **THEN** the update SHALL be rejected with an error naming the drift-guard constraint

#### Scenario: The digest column is nullable and unconstrained on length at introduction
- **WHEN** the migration that introduces `dg` is inspected
- **THEN** the column SHALL be nullable
- **AND** it SHALL carry no length `CHECK` in that migration, because `NULL` is the marker for a
  digest that has not been computed and a length constraint in the same migration would foreclose it

#### Scenario: The archive lineage ships with no digest backfill
- **WHEN** the archive lineage is applied
- **THEN** the `dg` column SHALL exist from the migration that creates the covered table, and every
  row SHALL be written with its digest in the same statement as the value
- **AND** the change record SHALL state that the caveat attached to backfilled digests — that they
  certify the bytes as found rather than as originally written — does not apply to this lineage,
  because it is greenfield and no row ever exists without its digest
- **AND** the absence of backfill SHALL be the stated reason a NULL digest is an error here rather
  than a warning

#### Scenario: The digest is not computed in SQL (negative control)
- **GIVEN** a proposed implementation computing `dg` in a `STORED` generated column via a
  user-defined function
- **WHEN** it is evaluated
- **THEN** it SHALL be rejected, because the schema would then permanently depend on that function
  being registered — `VACUUM` and any third-party write would fail without it — and because
  `ADD COLUMN … STORED` is rejected on any populated table

### Requirement: the uncovered projection tables have a written rebuild path with an executed transcript

The system SHALL document a procedure that re-derives `blocks` and `transactions` content columns
from the blobs they project, and that procedure SHALL have been executed at least once with its
transcript recorded before the uncovered classification of those tables ships in the durability
contract. Until that transcript exists, the contract SHALL state only that the archive is recovered
by resyncing from chain, and SHALL NOT claim a local rebuild.

#### Scenario: The procedure re-derives a projection column and reports divergence
- **WHEN** a `blocks` content column is altered in the file and the rebuild procedure is run over its
  height range
- **THEN** the procedure SHALL report that column as divergent from the value re-derived from the
  block's header blob
- **AND** the blob it re-derives from SHALL itself have been rehash-verified on read, so a divergence
  is attributable to the projection rather than to the source

#### Scenario: The rebuild path's limits are stated with it
- **WHEN** the procedure is documented
- **THEN** it SHALL state that a row whose blob reference is itself corrupt cannot be rebuilt
- **AND** it SHALL state that facts depending on a block body that was never synced cannot be
  rebuilt, because that column is nullable by design

#### Scenario: The classification does not ship without the transcript
- **WHEN** the durability contract's archive row is reviewed before the transcript exists
- **THEN** it SHALL say only that recovery is by resync from chain
- **AND** an uncovered classification presented without the rebuild path SHALL be treated as
  incomplete, because the rebuild path is what makes the exclusion defensible rather than merely
  cheap

### Requirement: the archive sync entry point remains coherent across typecheck, build and run

The system SHALL keep `npm run typecheck`, `npm run build` and `npm run archive:sync` coherent: the
sync directory SHALL remain inside the typecheck set, SHALL remain outside the published build, and
SHALL execute against the SQLite client. The entry point's connection input SHALL become an archive
database file path, and the change SHALL be recorded as a break with its pre-tag and post-tag price.

#### Scenario: All three commands succeed after the port
- **WHEN** the three commands are run against the ported tree
- **THEN** the typecheck SHALL pass with the sync directory included, the build SHALL succeed with it
  excluded, and the sync entry point SHALL start against a file path and apply the lineage

#### Scenario: The connection-input change is priced, not silently renamed
- **WHEN** the release record is read
- **THEN** it SHALL name the entry point's connection-input change as a break, state that it costs a
  changelog entry landed before the 1.0.0 tag, and state that landed after the tag it would force a
  major version across a distribution channel with no registry chokepoint

### Requirement: every performance-dependent property of the archive is an obligation to measure, not a number

No requirement in this capability SHALL be satisfied by citing a throughput, latency or pragma
performance figure. WHERE a decision depends on such a figure, this capability SHALL state the
obligation to establish it under `v1.0.0-sqlite-engine-core`'s measurement gate, with the filesystem,
`journal_mode`, `synchronous`, `page_size`, dataset size relative to page cache, binding and runtime
SQLite version recorded alongside the result.

#### Scenario: A measurement taken on a memory filesystem is inadmissible
- **GIVEN** a measurement whose recorded conditions place the database file on a memory filesystem
- **WHEN** it is offered in support of any archive decision
- **THEN** it SHALL be rejected, and the obligation to measure on the target filesystem SHALL stand

#### Scenario: The gate's obligations are enumerated with the decisions they unblock
- **WHEN** this change's measurement obligations are reviewed
- **THEN** each SHALL name what must be established, the conditions that must be recorded with it,
  and the specific decision it unblocks
- **AND** none SHALL be a completion criterion of this change, which requires the measurement to
  exist and be admissible rather than to take any particular value

#### Scenario: A structural verification is not mistaken for a performance measurement
- **WHEN** this change's own verification runs are reviewed
- **THEN** their outputs SHALL be limits, parse results, query-plan shapes, pragma behaviour and file
  sizes — not timings
- **AND** they SHALL have been executed on a filesystem the durability probe would accept, with the
  command and its output recorded
