# release-contract

The written release contracts for UmbraDB on SQLite: the durability contract and its startup probe,
the corruption-detection decision, cancellation, backup/restore, the frozen `{code → meaning →
retryable}` catalog, the stability policy's unclosed holes, the evidence obligations that carry the
abstract-to-concrete refinement claim, and the observability surface for a running embedded engine.

Requirements below follow EARS (Easy Approach to Requirements Syntax): each is Ubiquitous ("The
system SHALL…"), Event-driven ("WHEN \<trigger>, the system SHALL…"), Unwanted-behavior ("IF
\<condition>, THEN the system SHALL…"), State-driven ("WHILE \<state>, the system SHALL…"), or
Optional-feature ("WHERE \<feature>, the system SHALL…"), as in
`openspec/changes/v1.0.0-api-surface/specs/release-contract/spec.md` and Sprint 7's spec.

This delta uses `## ADDED Requirements` only. `openspec/specs/` contains one merged capability
(`temporal-kv`); `release-contract` has no merged baseline, so the deletions this change makes are
expressed as positive, falsifiable requirements about the resulting documents (`design.md` §0.3).

Scope boundaries: the driver, shim, worker topology, pragma bootstrap ordering and the ext4
measurement gate belong to `v1.0.0-sqlite-engine-core`; the temporal encoding and clock policy to
`v1.0.0-sqlite-temporal-event-log`; the lease, `BEGIN IMMEDIATE`, poll loop and contention mapping to
`v1.0.0-sqlite-concurrency-lease`; the schema and migration lineage to `v1.0.0-sqlite-schema-parity`.
The chain archive is **owned by `v1.0.0-sqlite-chain-archive`, not by this change** — this change
supplies only the archive-lineage rows of the digest coverage set, the anti-latch invariant applied
to the archive cursor, and the contract text; it does not specify the archive itself. The
PostgreSQL-to-SQLite data migration is owned by `v1.0.0-sqlite-data-migration`; this change supplies
the digest regime that migration reuses and rules on catalog membership for its failures.

## ADDED Requirements

### Requirement: the durability probe verifies library-controlled pragmas instead of deployer-supplied server settings

The startup durability probe SHALL remain a mandatory step of `runMigrations`, running before any
migration, and SHALL verify state UmbraDB itself established on the handle it opened, rather than
reading a server's configuration and taking the answer on trust
(`src/postgres/durability-probe.ts:200-206`). The probe SHALL retain the existing split between
**pure classifiers** — unit-testable with no database, as `classifyFsync` /
`classifyFullPageWrites` / `classifySynchronousCommit` / `assertNoTransactionPooler` are today
(`src/postgres/durability-probe.ts:72-135`) — and a single live function that gathers observations
and hands them to those classifiers. The probe SHALL raise `DurabilityContractError`
(`DURABILITY_CONTRACT_VIOLATION`) on a hard violation and return typed `DurabilityWarning` values
with `kind: "lost-tail"` for a recoverable trade, so `runMigrations`' `onDurabilityWarning` surface is
unchanged.

Hard refusals (no override): `journal_mode` in `{off, memory}`; `synchronous = OFF`;
`foreign_keys` not `ON`; the database file resident on a filesystem where SQLite's locking or
write-ahead-log shared memory is unsafe. Warnings (never refusals): `synchronous = NORMAL` while the
configured floor is `FULL`; an implausibly fast `fsync` calibration; database and sidecar files not
restricted to owner-only permissions.

`docs/durability-contract.md` SHALL be rewritten so that its binding **deployer** preconditions
reduce to one — place the database file on a local, non-networked filesystem — and SHALL state, in
the same terms the pooler check already uses for itself (`docs/durability-contract.md:73-77`), that
the `fsync` calibration is a **best-effort detector and never a guarantee**.

#### Scenario: A journal mode that forfeits crash recovery is refused, not warned about
- **WHEN** `runMigrations` runs against a database whose `journal_mode` is `off` or `memory`
- **THEN** the probe SHALL throw `DurabilityContractError` before any migration runs
- **AND** the thrown error's `violations` payload SHALL name the setting and its observed value
- **AND** no option SHALL exist that permits the run to proceed

#### Scenario: synchronous=NORMAL under a FULL floor warns and proceeds
- **WHEN** `runMigrations` runs with `synchronous = NORMAL` while the configured floor is `FULL`
- **THEN** the probe SHALL return a `DurabilityWarning` with `kind: "lost-tail"` naming the setting
  and its value
- **AND** `runMigrations` SHALL proceed, mirroring today's warn-never-refuse treatment of
  `synchronous_commit = off` (`src/postgres/durability-probe.ts:101-118`)

#### Scenario: foreign_keys=OFF is refused because it silently disables garbage collection
- **WHEN** the probe observes `foreign_keys` other than `ON` on the connection it was handed
- **THEN** it SHALL throw `DurabilityContractError`
- **AND** the message SHALL state that the checkpoint schema's `ON DELETE CASCADE` is what allows a
  manifest to be deleted at all, so the setting turns garbage collection into a silent no-op

#### Scenario: A database file on an unsafe filesystem is refused on a hard signal, not a heuristic
- **WHEN** the probe resolves the filesystem type of the directory holding the database file and
  finds a network or memory filesystem (`nfs`, `cifs`/`smb`, `v9fs`, `tmpfs`, `ramfs`, or an
  un-allowlisted `fuse`)
- **THEN** it SHALL throw `DurabilityContractError` naming the filesystem type
- **AND** the refusal SHALL be based on the reported filesystem type, not on a timing measurement

#### Scenario: A probe that trusted PRAGMA readback alone would miss the case that motivates the check (negative control)
- **GIVEN** a hypothetical probe that verifies only that `PRAGMA journal_mode` reads back `wal`
- **WHEN** the database file is placed on a 9p/`drvfs` mount, where SQLite is recorded as entering
  WAL mode without complaint even though WAL's shared-memory index is not safe there
- **THEN** that hypothetical probe SHALL report success on a configuration whose locking primitive
  does not work — which is the failure the filesystem-type refusal exists to catch, and is why the
  readback alone is specified as insufficient

#### Scenario: The fsync calibration never refuses and is documented as a heuristic
- **WHEN** the probe's `fsync` latency calibration returns a value implying no real write barrier
- **THEN** the probe SHALL return a warning and SHALL NOT refuse
- **AND** `docs/durability-contract.md` SHALL state that no in-process probe can verify that a
  filesystem is honest about `fsync`, and SHALL NOT claim otherwise anywhere in the document

### Requirement: the synchronous default is FULL and is lowered only under a stated decision rule

The shipped default SHALL be `synchronous = FULL`. Documentation SHALL NOT state a commits-per-second
figure, a throughput ratio, or a latency for any `synchronous` level as an established fact.

IF a proposal is made to lower the default to `NORMAL`, THEN it SHALL be accepted only when all
three of the following hold, and SHALL be rejected when any one is missing:

1. **A magnitude measured under the gate conditions of `v1.0.0-sqlite-engine-core`**, with the
   filesystem, `journal_mode`, `synchronous` level, dataset size relative to page cache, and the unit
   of work all recorded — the unit of work being the co-transactional `saveAndAdvance` shape
   (`design/design.md` §5, `Formal/STORAGE_ALGEBRA.md` §4), not a bare insert.
2. **Power-loss evidence**, obtained from a rig that removes power or faithfully emulates a lost
   volatile write cache (for example a device-mapper `dm-flakey` harness, a QEMU
   `nvme,write-cache=off` configuration, or a physical power-cut rig), asserting across N trials that
   no acknowledged commit is lost, that `integrity_check` reports `ok`, and that the durable cursor
   is never ahead of durable data (`docs/checkpoint-store-contract.md:16-18`) — **with a negative
   control that fails**, so the rig is shown to detect the failure it is looking for.
3. **A recorded decision** in the release record naming what is being traded and who accepted it.

`docs/durability-contract.md` SHALL state that `NORMAL` is contract-legal *in kind* — it maps onto
the same bounded lost tail the probe already warns about rather than refuses — and SHALL state in the
same paragraph that legality is not sufficiency.

#### Scenario: The contract states the rule and no number
- **WHEN** the durability contract's `synchronous` section is read
- **THEN** it SHALL state `FULL` as the default and enumerate the three preconditions for lowering it
- **AND** it SHALL contain no commits-per-second figure, throughput ratio or latency presented as an
  established property of any `synchronous` level

#### Scenario: A SIGKILL corpus offered as power-loss evidence is rejected (negative control)
- **GIVEN** a proposal to lower the default to `NORMAL` supported by crash trials in which the
  process was terminated with SIGKILL
- **WHEN** the proposal is evaluated against precondition 2
- **THEN** it SHALL be rejected, because SIGKILL is a process crash and a process crash is exactly
  the guarantee `synchronous = NORMAL` does make — such a corpus is evidence about the guarantee
  `NORMAL` keeps and says nothing about the one it declines to make

#### Scenario: A measurement taken on a memory filesystem is not admissible
- **GIVEN** a throughput measurement whose recorded conditions show the database file on `tmpfs`,
  `ramfs` or any filesystem the probe would refuse
- **WHEN** it is offered against precondition 1
- **THEN** it SHALL be rejected as inadmissible, and the requirement to re-measure on the target
  filesystem SHALL stand

### Requirement: integrity coverage follows the three-class corruption model with an explicit column-level coverage set

UmbraDB's integrity coverage SHALL be assigned by corruption class, not by re-derivability alone:
**Class A** (wrong bytes returned for the addressed row) is answered by a value digest; **Class B**
(wrong row, or no row, returned) is answered by invariants and index redundancy and SHALL NOT be
answered by a digest; **Class C** (`sqlite_schema` text corruption) is answered by the schema digest.
Re-derivability survives as the obligation test *within* Class A: non-re-derivable Class-A exposure
SHALL be covered.

The covered set SHALL be exactly these columns, and the specification SHALL name them explicitly
rather than by category:

| Table | Column(s) | Coverage |
|---|---|---|
| `kv_event` | `value` | **COVER** |
| `kv_event` | `written_at`, `version` | UNCOVERED — Class B, invariant I-3; folding them into the digest is prohibited because index-copy damage passes any row digest |
| `watermarks` (wallet **and** archive lineages) | `value` | **COVER**, plus invariant I-6 |
| `transaction_history` | `entry` | **COVER** |
| `transaction_history` | `lifecycle` | UNCOVERED — named `CHECK` plus cross-check I-7a |
| `transaction_history_identifiers` | all | UNCOVERED — three physical sites already; cross-check I-7b |
| `bridge_observations` | all non-PK columns | **COVER** (multi-column preimage) |
| `verifier_key_observations` | all non-PK columns | **COVER** (multi-column preimage) |
| `ckpt_chunks`, `ckpt_manifests` | content and hash columns | UNCOVERED — **already covered** by rehash-on-read; a second digest is prohibited as redundant |
| `ckpt_manifests.seq`, `ckpt_sequence_counters.next_seq` | — | UNCOVERED — closed by invariant I-1, owned by `v1.0.0-sqlite-schema-parity`; not duplicated here |
| `chain_blobs` | — | UNCOVERED — already covered by rehash-on-read |
| `blocks` (and every partition child), `transactions`, `chain_blob_roles` | all | UNCOVERED — projections of rehash-verified blobs; invariant I-2 plus a documented rebuild path, not a digest column on a table whose row count scales with chain size |
| `_migrations` | all | UNCOVERED — rule I-5 |
| `writer_generation` | all | UNCOVERED — invariant I-4 |
| `sqlite_schema` | `sql` text | **COVER** via the schema digest — recorded by `v1.0.0-sqlite-schema-parity`, verified by this change |

The specification and `docs/CONTRACT.md` SHALL NOT refer to a "wallet-state envelope store" as a
covered table. `PgWalletStateEnvelopeStore` adds no table: the envelope **is** `ckpt_chunks` rows,
whose content is already rehash-verified and whose addressing is protected by the checkpoint-sequence
invariant. Any text mandating digest coverage of the envelope store while also excluding
`ckpt_chunks` mandates and forbids covering the same bytes, and SHALL be treated as a defect.

#### Scenario: The coverage set is stated as columns, not categories
- **WHEN** the coverage requirement is read
- **THEN** it SHALL name `kv_event.value`, `watermarks.value` in both lineages,
  `transaction_history.entry`, and the non-PK columns of `bridge_observations` and
  `verifier_key_observations` as the covered set
- **AND** it SHALL contain no category term whose membership a reader must infer

#### Scenario: The envelope contradiction is absent (negative control)
- **GIVEN** a proposed coverage requirement that mandates digest coverage of "the wallet-state
  envelope store" while excluding `ckpt_chunks` as already covered
- **WHEN** the two clauses are resolved against the fact that the envelope is stored as `ckpt_chunks`
  rows
- **THEN** the proposal SHALL be rejected, because it mandates and forbids covering the same bytes

#### Scenario: A digest is not added to a table whose row count scales with the chain
- **WHEN** the archive projection tables `blocks`, `transactions` and `chain_blob_roles` are
  considered for coverage
- **THEN** they SHALL remain UNCOVERED
- **AND** their protection SHALL be invariant I-2 plus a documented rebuild path, on the stated ground
  that a per-row digest on reconstructible data at that row count is the one bad storage trade in
  this design

#### Scenario: A digest is not proposed as an answer to Class B (negative control)
- **GIVEN** a proposal to fold `kv_event.written_at` and `version` into the value digest so that
  wrong-version reads are detected
- **WHEN** the proposal is evaluated against a measured index-copy divergence, in which the table row
  is intact and the index copy is damaged
- **THEN** it SHALL be rejected: the row digest verifies clean because the row is clean, and the read
  still returns the wrong version or no row — which is why invariant I-3 exists and a digest does not
  substitute for it

### Requirement: the value digest is a versioned, length-prefixed, row-bound SHA-256 computed adapter-side

The digest SHALL be SHA-256, unconditionally, stored in a `dg BLOB` column holding 32 raw bytes. The
column SHALL NOT be hex `TEXT`.

The column SHALL be nullable at the schema level, and the migration that adds it SHALL carry a
**named, null-tolerant length constraint** of the form
`CONSTRAINT <name> CHECK (dg IS NULL OR octet_length(dg) = 32)`. Only constraints that **reject a
NULL `dg`** are prohibited — no `NOT NULL`, no non-null default. A truncated or garbage digest is
thereby made unrepresentable rather than merely detected, and the named form feeds the same
constraint-name extraction path every other constraint in the schema lineage uses.

Nullability is a schema-level property only. It SHALL NOT be read as licensing a NULL digest on a
covered row at runtime: under the anti-downgrade requirement below, a covered row whose digest is
NULL is an integrity failure in every lineage this release ships.

For single-value covered columns the preimage SHALL be format version `0x01`: the version byte,
followed by the length-prefixed logical (unprefixed) table name, the length-prefixed column name, the
length-prefixed encoded primary key in declared column order, and the length-prefixed value bytes
exactly as SQLite stores them. For multi-column covered rows the preimage SHALL be format version
`0x02`: the same header, then for every non-PK column in declared order its length-prefixed name, a
one-byte type tag, and its length-prefixed encoding. Both encodings SHALL be injective.

The digest SHALL be computed **in the adapter, on the caller's thread**, before the write crosses any
worker boundary, and SHALL be bound in the **same statement** as the value. The generated-column
route SHALL NOT be used: a deterministic user-defined function in a `STORED` generated column works
but becomes a permanent schema dependency under which `VACUUM` and every third-party write fail, and
`ADD COLUMN … STORED` is rejected on any populated table.

Every covered table SHALL carry a drift-guard trigger that aborts an update of the covered column
which does not also change `dg`, implemented with no user-defined function.

IF a re-verified digest does not match its value, THEN the read SHALL reject with
`ValueIntegrityError` (`VALUE_INTEGRITY`, non-retryable) **carrying the table name and the primary
key**, and the corrupted bytes SHALL NOT be returned to the caller — following the one error idiom of
`design/design-interfaces.md` §1.1: thrown and `code`-discriminated, never a boolean return or a
logged warning.

WHERE a `dg` column is ever added to an already-populated table, backfill SHALL use keyset pagination
on the primary key, hash outside the write transaction, persist the cursor in the same transaction as
the batch, and use a null-digest count as the completion check; the null-digest predicate SHALL NOT
be used as the pagination predicate. The contract SHALL state that a backfilled digest certifies the
bytes **as found**, not as originally written.

#### Scenario: Whole-row substitution is detected by the row binding
- **WHEN** a row's stored value and its digest are both replaced by a valid value/digest pair taken
  from a different row of the same table
- **THEN** the read SHALL reject with `ValueIntegrityError`, because the preimage binds the primary
  key

#### Scenario: A bare value hash fails the same attack (negative control)
- **GIVEN** a hypothetical digest computed as a plain hash of the value bytes alone
- **WHEN** the same whole-row substitution is performed
- **THEN** the digest verifies clean and the substitution goes undetected — which is why the
  versioned, length-prefixed, table/column/primary-key-bound preimage is specified rather than a
  bare value hash

#### Scenario: An update that does not recompute the digest is refused
- **WHEN** a covered column is updated by a statement that leaves `dg` unchanged
- **THEN** the write SHALL abort with the drift-guard trigger's message
- **AND** the same update carrying a recomputed `dg` SHALL be accepted

#### Scenario: The generated-column route is rejected with its reason (negative control)
- **GIVEN** a proposal to compute the digest in SQL as a `STORED` generated column over a
  deterministic user-defined function
- **WHEN** the resulting database is compacted or opened by any writer that has not registered that
  function
- **THEN** the operation fails on the missing function — a permanent schema dependency — which is why
  the digest is specified as adapter-side and the generated-column route is prohibited

#### Scenario: The adding migration carries the named null-tolerant length constraint
- **WHEN** the migration that adds `dg` to a populated table is applied
- **THEN** it SHALL succeed
- **AND** the constraint SHALL reject a 31-byte digest naming the constraint, accept a 32-byte
  digest, and accept `NULL` at the schema level

#### Scenario: A null-rejecting constraint is refused (negative control)
- **GIVEN** a proposed migration adding the column as `NOT NULL` or with a non-null default
- **WHEN** it is evaluated
- **THEN** it SHALL be rejected, because a non-null default writes a digest matching no value and
  turns every existing row into a permanent verification failure indistinguishable from corruption

#### Scenario: A length constraint does not foreclose a NULL digest (negative control on this change's own superseded rationale)
- **GIVEN** the rationale this change previously gave for prohibiting any length constraint in the
  adding migration — that `NULL` marks a not-yet-computed digest and a length constraint would
  foreclose it
- **WHEN** that rationale is tested against SQL constraint semantics, under which a constraint
  evaluating to NULL passes rather than fails
- **THEN** it SHALL be found false in **both** forms — the null-tolerant form admits NULL explicitly,
  and the bare length form admits NULL as well because three-valued logic makes the constraint
  indeterminate rather than false — which is why the prohibition is narrowed to null-*rejecting*
  constraints only

### Requirement: the digest covers the stored bytes and never a logical value

The preimage SHALL be computed over the **exact bytes SQLite stores** and SHALL NOT be computed over
a re-serialisation, a normalised form, or a parsed logical value. Any migration that rewrites a
covered column's bytes — an encoding change, a normalisation, a re-serialisation — SHALL recompute
the digest for every row it rewrites, in the same migration.

#### Scenario: An encoding change recomputes rather than fires
- **WHEN** a migration rewrites a covered column's stored bytes
- **THEN** it SHALL recompute and write the digest for every rewritten row within the same migration
- **AND** a read after that migration SHALL verify clean

#### Scenario: A digest over the logical value cries wolf on an encoding change (negative control)
- **GIVEN** a hypothetical digest computed over a parsed or re-serialised logical value rather than
  the stored bytes
- **WHEN** the storage encoding changes in any way that preserves the logical value — key ordering,
  whitespace, numeric formatting
- **THEN** every previously written row fails verification although no data is damaged
- **AND** the predictable consequence is that operators disable the check, which is why the preimage
  is specified over stored bytes

### Requirement: a documented-as-dangerous salvage bypass ships from day one

UmbraDB SHALL ship, in its first release carrying digests, an explicit **salvage** mode that permits
reading a row whose digest fails, so a consumer with no backup can extract what remains. It SHALL be
off by default, SHALL be named and documented as dangerous, SHALL state the situations in which its
use is legitimate, and SHALL surface every bypassed row — never silently.

This bypass SHALL NOT be a coverage or verification opt-out. It SHALL NOT disable digest computation
on write, SHALL NOT remove any column from the covered set, and SHALL NOT be usable as a
general-purpose read-path performance switch. Enabling it SHALL NOT change what
`verifyIntegrity()` reports.

#### Scenario: Salvage returns damaged data loudly and only when asked
- **WHEN** salvage mode is enabled and a row whose digest fails is read
- **THEN** the stored bytes SHALL be returned to the caller
- **AND** the row SHALL be reported as bypassed, naming its table and primary key
- **AND** with salvage mode off, the same read SHALL raise `ValueIntegrityError`

#### Scenario: Salvage cannot be repurposed as a verification opt-out (negative control)
- **GIVEN** an attempt to use salvage mode to avoid verification cost on a hot read path
- **WHEN** the mode is enabled
- **THEN** digests SHALL still be computed on write and compared on read, and every mismatch SHALL
  still be reported — so the mode buys no throughput and cannot stand in for the opt-out this
  specification prohibits

#### Scenario: Shipping without a bypass is rejected (negative control)
- **GIVEN** a proposal to ship digests with no salvage path, on the grounds that a strict check is
  safer
- **WHEN** the proposal is weighed against the systems that were each forced to add one after the
  fact — relational engines, filesystems, key-value and log stores alike
- **THEN** it SHALL be rejected: the bypass is added under field pressure in every case, and adding
  it deliberately, off by default and documented as dangerous, is strictly better than adding it in a
  hotfix

### Requirement: a covered row cannot be downgraded to unverified, by configuration or by statement

Verification of a covered column's digest SHALL occur on **every** read of that column. There SHALL
be no configuration flag, option, or environment variable that disables it, and the specification
SHALL contain no term whose value could make the coverage set conditional.

Configuration is only half of it. Every covered table SHALL additionally carry an **anti-downgrade
trigger**, implemented with no user-defined function, that aborts any update setting `dg` to NULL on
a row whose `dg` is currently non-NULL. The drift-guard trigger specified above is one-directional —
it fires on an update of the covered *column* that leaves `dg` unchanged, and does not fire on an
update of `dg` alone — so without this second trigger a single statement setting `dg` to NULL
permanently downgrades a row to unverified while touching no covered value.

The anti-downgrade trigger SHALL NOT obstruct a legitimate recompute (a non-NULL digest replacing
another) and SHALL NOT obstruct a backfill, which only ever writes NULL to a value.

IN a lineage that ships no backfill — which is every lineage in this release — a covered row whose
`dg` is NULL SHALL raise `ValueIntegrityError` on read. There is no legitimate "not yet computed"
state to distinguish it from, so a warning branch would be reachable only by the downgrade this
requirement forbids or by corruption, and would function solely to mask both. Warn semantics MAY be
reinstated only by a future change that actually ships a backfill, as part of that change.

#### Scenario: There is no flag that turns verification off
- **WHEN** the shipped configuration surface is inspected
- **THEN** no option SHALL exist whose effect is to skip digest verification on read
- **AND** the contract's promise that corrupted bytes are not returned to the caller SHALL therefore
  hold unconditionally

#### Scenario: A statement that nulls a digest is refused
- **WHEN** an update sets `dg` to NULL on a covered row whose `dg` is currently non-NULL
- **THEN** the write SHALL abort with the anti-downgrade trigger's message
- **AND** replacing a non-NULL digest with a different non-NULL digest SHALL still be accepted

#### Scenario: The drift guard alone leaves a per-row opt-out (negative control)
- **GIVEN** only the drift-guard trigger, which fires when a covered column is updated without
  recomputing `dg`
- **WHEN** a single statement sets `dg` to NULL without touching the covered column
- **THEN** the statement is accepted, the row is permanently unverified, and the guarantee that
  every covered read is verified becomes false one row at a time — which is why the anti-downgrade
  trigger is mandatory rather than defence-in-depth

#### Scenario: A NULL digest on a covered row is an integrity failure, not a warning
- **WHEN** a covered row whose `dg` is NULL is read in a lineage that ships no backfill
- **THEN** the read SHALL raise `ValueIntegrityError` naming the table and primary key
- **AND** the value SHALL NOT be returned

#### Scenario: A default-off verification is rejected (negative control)
- **GIVEN** a proposal to make verify-on-read opt-in on the grounds that it adds a large *relative*
  percentage to a warm point read
- **WHEN** the proposal is evaluated against absolute cost on the covered tables, which are
  wallet-state tables and not bulk-scan hot paths
- **THEN** it SHALL be rejected: a guarantee that exists but is not wired in is the failure pattern
  this change exists to avoid, and relative percentage is the wrong unit against a commit dominated
  by `fsync`

### Requirement: the schema digest is verified at open and is the one open-scoped corruption failure

A digest over the database's schema text SHALL be verified at `open()` and again inside the
verification pass. The artifact and its recording point are owned by `v1.0.0-sqlite-schema-parity`,
which records it at the end of every successful migration run; this change owns the verification half.

IF the schema digest does not match, THEN `open()` SHALL raise `DatabaseCorruptError`
(`DATABASE_CORRUPT`) carrying a `schemaDigest` detail. This SHALL be the **only** open-scoped
corruption failure, on the ground that schema-text damage silently weakens the rules governing every
future write, so continuing to write is continuing to corrupt.

The contract SHALL label the schema digest as corruption detection, not tamper protection.

#### Scenario: A schema-text mismatch refuses at open
- **WHEN** a database whose recorded schema digest does not match its current schema text is opened
- **THEN** `open()` SHALL raise `DatabaseCorruptError` with a `schemaDigest` detail
- **AND** the failure SHALL not depend on scanning any data

#### Scenario: A value-digest failure does not refuse at open (negative control)
- **GIVEN** an implementation that verifies value digests at `open()` and refuses the whole database
  on any mismatch
- **WHEN** a single stored value is corrupted
- **THEN** every undamaged key becomes unreachable — the whole-database-refusal failure shape this
  specification prohibits, and the reason value-digest failures are specified as row-scoped and
  read-time

### Requirement: the verification pass runs the structural check, the digest sweep, the schema digest and the invariants together, and never refuses

`verifyIntegrity()` SHALL run `PRAGMA integrity_check`, **and** a full sweep of the covered digests,
**and** the schema-digest check, **and** the invariant queries, and SHALL report all four together as
an inventory: the structural result, the list of failing digest rows by table and primary key, the
schema-digest result, and the invariant results. It SHALL NOT report an overall pass when any part
fails, SHALL NOT refuse or throw on a finding, and SHALL NOT be wired into startup as a gate.

`quick_check` SHALL NOT be specified as an alternative to `integrity_check` anywhere.

The digest sweep SHALL NOT be substituted for `integrity_check`. Until the verification pass's
runtime is measured at a representative archive scale, it SHALL be documented as an **on-demand
diagnostic and post-restore check**, and no specification text SHALL assume a scheduled or periodic
pass is affordable.

#### Scenario: A structurally intact database with a corrupted value fails the pass
- **WHEN** the verification pass runs against a database whose structural check returns `ok` but
  which contains one row whose stored digest does not match its value
- **THEN** the overall reported result SHALL be a failure
- **AND** the report SHALL name the structural result, the failing row's table and primary key, the
  schema-digest result and the invariant results separately

#### Scenario: quick_check is blind to the fault integrity_check reports (negative control)
- **GIVEN** a proposal to offer `quick_check` as a faster alternative to `integrity_check`
- **WHEN** a database with a secondary index that omits an existing row is checked by both
- **THEN** `integrity_check` reports the missing index entry while `quick_check` reports `ok`, and an
  indexed lookup returns nothing for a row a table scan still finds — which is why `quick_check` is
  prohibited wherever `integrity_check` is specified

#### Scenario: The digest sweep does not replace the structural check (negative control)
- **GIVEN** a proposal to run only the digest sweep on the grounds that it is substantially cheaper
- **WHEN** the same index-omission fault is present
- **THEN** the sweep reports every row it is handed as intact, because the rows are intact — it is
  blind to Class B by construction, `integrity_check` is blind to Class A, and neither subsumes the
  other

#### Scenario: The pass reports and never refuses
- **WHEN** the verification pass encounters a structural failure, a failing digest and a failing
  invariant in one run
- **THEN** it SHALL return an inventory naming all three
- **AND** it SHALL NOT throw, and the database SHALL remain open and usable for undamaged rows

### Requirement: Class B corruption is answered by named invariants with an owner per change

The change SHALL record the mandatory Class B invariants and their owning change, and SHALL NOT
duplicate or re-specify an invariant owned elsewhere. This change owns the **anti-latch** rule and
coordinates the rest.

WHEN a monotonic guard on a watermark write suppresses a write as a regression, the store SHALL
verify the **incumbent** row's digest in the same transaction, and SHALL raise `ValueIntegrityError`
on a failing digest instead of silently no-opping.

#### Scenario: A corrupted-high cursor is detected instead of latched
- **GIVEN** a watermark row whose stored value has been corrupted to a higher position than the true
  cursor
- **WHEN** a subsequent legitimate write is suppressed by the monotonic guard as a regression
- **THEN** the store SHALL verify the incumbent row's digest in that same transaction and SHALL raise
  `ValueIntegrityError`

#### Scenario: A silently no-opping guard latches the damage permanently (negative control)
- **GIVEN** a monotonic guard that returns without action whenever the incoming position is not
  greater than the stored one
- **WHEN** the stored position has been corrupted upward
- **THEN** every subsequent correct write is discarded, the skipped range is never fetched, and the
  omitted history rows are lost without one covered byte changing — the latch this requirement
  converts into a detection point

#### Scenario: Invariant ownership is recorded without duplication
- **WHEN** the invariant table in this change is read
- **THEN** each invariant SHALL name exactly one owning change
- **AND** an invariant owned by another change SHALL be recorded as closed there and SHALL NOT be
  re-specified with its own requirement here

### Requirement: the checksum VFS is considered and declined, with its reasons recorded

`docs/CONTRACT.md` SHALL record SQLite's first-party checksum VFS as **considered and declined**, not
as deferred headroom, and SHALL record the reasons so the option is not re-proposed without new
upstream facts: it is a loadable extension not present in the pinned driver build; its enabling path
is not reachable from the runtime; enabling it registers a **process-global default VFS**, which a
library embedded in a consumer's process must not do on that consumer's behalf; its own history
includes a write-ahead-log recovery data-loss defect; and it would not discharge the value-digest
obligation in any case.

The contract SHALL warn that the corresponding verification pragma is **silently accepted and does
nothing** on the pinned build, and SHALL name the probe that actually detects the shim's absence.

New databases SHALL NOT be created with reserve bytes pre-provisioned for the shim, because doing so
permanently freezes the page size and forecloses the reserve-bytes consumer already named as later
headroom.

#### Scenario: The decline is recorded with reasons
- **WHEN** `docs/CONTRACT.md`'s headroom section is read
- **THEN** the checksum VFS SHALL appear as considered and declined
- **AND** the process-global default-VFS reason SHALL be stated, because it is the reason that does
  not expire with a future upstream release

#### Scenario: The silent no-op is warned about
- **WHEN** the contract's integrity section is read
- **THEN** it SHALL state that setting the checksum-verification pragma on this build is accepted and
  has no effect, so an operator following upstream documentation receives no error and no protection
- **AND** it SHALL name the probe whose empty result is the correct detection of the shim's absence

#### Scenario: Reserve bytes are not pre-provisioned (negative control)
- **GIVEN** a proposal to create databases with reserve bytes set aside so the shim could be enabled
  later
- **WHEN** the consequence is evaluated
- **THEN** it SHALL be rejected, because it permanently freezes the page size and forecloses the
  at-rest-encryption consumer of the same reserve bytes

### Requirement: the integrity boundary is disclosed using the two-case wording, in every channel a consumer reads

The integrity disclosure SHALL use the **two-case** wording and SHALL NOT state that the engine
detects nothing: damage to SQLite's **own structures** *is* detected, the structural check reports the
fault and the read fails; damage confined to a **stored value's bytes** is **not** detected, both
pragmas report `ok`, and the corrupted value is returned to the caller as data. The disclosure SHALL
state that the structural check is sound for *rejection* and not sound for *acceptance*.

The disclosure SHALL state that this is **not a regression from the PostgreSQL backend**, and SHALL
NOT contain any sentence implying UmbraDB is restoring a capability the PostgreSQL backend previously
gave a consumer. **UmbraDB never had page checksums.** The startup probe reads exactly `fsync`,
`synchronous_commit` and `full_page_writes` (`src/postgres/durability-probe.ts:204-206`); no shipped
document has ever mentioned `data_checksums`, `amcheck` or `pg_checksums`; and PostgreSQL initialises
the option off by default across UmbraDB's entire supported range, which its own pinned reference
image reports. What the SQLite backend removes is the operator's **option** to enable a protection
UmbraDB never required, checked or promised. The engineering claim is therefore weaker and the
documentation obligation stronger: the absence was undisclosed on **both** backends, and this
disclosure closes that.

The disclosure SHALL appear in six channels, because there is no registry chokepoint: the durability
contract; the README's durability section; the durability-configuration document with the measured
transcript and a summary-table row recording that page checksums are absent on **both** backends; the
error catalog; the security document's at-rest section, stating that the digests are not a tamper
defence; and **the code itself**, which raises the typed errors and exposes the verification pass —
the only channel that reaches a consumer who reads nothing. The disclosure SHALL NOT be routed
through, or assume the existence of, a container image: the repository builds no such artifact and
references no registry, so any channel claiming one would be asserting a distribution path that does
not exist.

No document produced by this change SHALL cite a corruption frequency figure that lacks an
attributable primary source. The specification records that no seat obtained a field base rate, and
the disclosure SHALL therefore make no frequency claim in either direction.

The disclosure SHALL state these limits plainly: detection is not repair; a digest detects corruption
at rest and not a value that was already wrong when UmbraDB was asked to store it; the digest is
unkeyed and is therefore not a tamper defence; and the one event nothing detects is a **coherently
wrong file** — a restore from a stale or corrupt backup that is internally self-consistent passes
every check UmbraDB can run.

#### Scenario: The disclosure states both cases and the asymmetry
- **WHEN** the integrity section of the durability contract is read
- **THEN** it SHALL state that structural damage is detected and that value-byte damage is not
- **AND** it SHALL state that a structural `ok` means "no structural fault was found", never "the
  data is intact"

#### Scenario: A "SQLite detects nothing" formulation is rejected (negative control)
- **GIVEN** proposed disclosure text stating that SQLite performs no integrity checking
- **WHEN** it is checked against the measured behaviour, in which structural damage *is* reported and
  the read fails
- **THEN** the text SHALL be rejected as inaccurate in the direction that would not survive review,
  and replaced by the two-case wording

#### Scenario: The not-a-regression framing is present and does not weaken the obligation
- **WHEN** the disclosure is read
- **THEN** it SHALL state that the PostgreSQL option was off by default and never required, probed or
  documented by UmbraDB, so what is lost is the operator's option
- **AND** the digest coverage requirement SHALL be unchanged by that framing

#### Scenario: A restoring-lost-parity claim is rejected (negative control)
- **GIVEN** proposed text stating that the digests restore integrity coverage the PostgreSQL backend
  provided
- **WHEN** it is checked against the probe's actual scope
  (`src/postgres/durability-probe.ts:204-206`, which reads `fsync`, `synchronous_commit` and
  `full_page_writes` and nothing else) and against the absence of any `data_checksums` / `amcheck`
  mention in the shipped documents
- **THEN** the text SHALL be rejected as false, and replaced by the operator's-option framing

#### Scenario: All six disclosure channels carry it, and none of them is a container image
- **WHEN** the shipped documentation set and the built surface are inspected
- **THEN** the durability contract, the README, the durability-configuration document, the error
  catalog, the security document and the code's typed errors and verification pass SHALL each carry
  the disclosure or its pointer
- **AND** no channel SHALL depend on a container image, since the repository builds none
- **AND** the coherently-wrong-restored-file limit SHALL be stated in the contract

#### Scenario: An unsourced frequency figure is refused (negative control)
- **GIVEN** proposed text citing a per-month corruption rate circulating without an attributable
  primary source
- **WHEN** the citation is checked
- **THEN** the figure SHALL be struck rather than hedged, and the document SHALL state that no field
  base rate was obtained

### Requirement: corruption recovery is row-scoped and proportionate, never whole-database refusal

A value-digest failure SHALL be thrown by the read that addressed the damaged row and by nothing
else. Open, migrations, lease acquisition and every undamaged key SHALL keep working. The error
SHALL name the row's table and primary key, so a single-row fault does not force a full restore.

A new corruption-recovery document SHALL record four consumer paths — scope the damage with the
verification pass; re-derive where the tier allows; restore from backup with the verification pass as
the post-restore check; or accept a bounded, known loss per key — and SHALL state the value
proposition in these terms: UmbraDB does not promise to repair corruption; it promises corruption is
never silent, so the response can be proportionate instead of total.

The document SHALL NOT present the SQLite command-line recovery tool, a checksumming filesystem, or
error-correcting memory as *the* answer; filesystem-level integrity SHALL be recorded as
defence-in-depth advice only, because a library cannot verify its deployer adopted it.

#### Scenario: One corrupted row leaves a working wallet
- **WHEN** a single covered row is corrupted and an unrelated key is read
- **THEN** the unrelated read SHALL succeed
- **AND** opening the database, running migrations and acquiring the writer lease SHALL all succeed

#### Scenario: Whole-database refusal on one bad record is the shape being avoided (negative control)
- **GIVEN** an implementation that maps any digest failure to a database-level corruption error at
  open
- **WHEN** one record is damaged
- **THEN** the entire store becomes unusable and the consumer's only remaining action is a full
  restore — the failure shape this requirement prohibits, in contrast to the row-scoped path where
  the consumer knows exactly which keys are unrecoverable

#### Scenario: The recovery document answers "is my backup good?"
- **WHEN** the corruption-recovery document's restore path is read
- **THEN** it SHALL name the verification pass — structural, digest, schema and invariants — as the
  post-restore check
- **AND** it SHALL state that this is strictly stronger than the structural check alone

### Requirement: the cancellation contract promises only what a mechanism can deliver

`docs/CONTRACT.md` §3 SHALL be rewritten. The clause at `docs/CONTRACT.md:65-67` — "During a long
read … the in-flight cursor / lock wait is **freed**: the driver's `query.cancel()` fires and the
wait unwinds" — SHALL be **deleted**, not reworded, because it names a mechanism that requires a
second connection to a server (`src/postgres/abort.ts:30-36`) and an embedded engine has neither.
The rewritten section SHALL state two unconditional timings — an already-aborted signal issues no
query; an abort during a write may always still complete — and SHALL name, in a list a reader can
check, what is **not** cancellable: any scan inside a single engine call, the body of
`withTransaction(fn)`, the backup operation, and any compaction operation.

WHERE `v1.0.0-sqlite-concurrency-lease` implements lock waiting as a JavaScript poll loop, the
contract MAY additionally state that a wait UmbraDB implements in JavaScript observes an abort at its
next poll boundary — and IF it does, THEN it SHALL name the bound (the poll interval) rather than
promising immediacy, and SHALL NOT extend that statement to any wait inside an engine call.

`TransactionLeaseLayer.releaseLease(lease)` SHALL remain signal-less for the reason
`docs/CONTRACT.md:57-60` already gives: release is the always-run cleanup half of a lease.

#### Scenario: Section 3 contains two unconditional timings and no freed-wait clause
- **WHEN** `docs/CONTRACT.md` §3 is read
- **THEN** it SHALL state that an already-aborted signal issues no query and touches no backend
- **AND** it SHALL state that an abort during a write may still complete and that a caller must
  re-read to determine the actual state
- **AND** it SHALL contain no clause asserting that an in-flight read, cursor or lock wait is freed,
  unwound, interrupted or cancelled by an abort

#### Scenario: A softened rewording is a violation, not a fix (negative control)
- **GIVEN** a proposed §3 that replaces "the wait is **freed**" with "the wait is best-effort freed"
  or "the wait may be freed"
- **WHEN** that proposal is evaluated against this requirement
- **THEN** it SHALL be rejected, because the softened clause still names a mechanism that does not
  exist and still leaves a caller believing an in-flight engine call can be interrupted

#### Scenario: The callback body is named as uncancellable with its reason
- **WHEN** §3's list of what is not cancellable is read
- **THEN** it SHALL name the body of `withTransaction(fn)`
- **AND** it SHALL state the reason — `fn` is arbitrary caller code running on the caller's thread,
  which no transport can carry to an off-thread engine as a program, so cancellation cannot be
  amortised for it at any granularity

### Requirement: the backup primitive is established by measurement on the ruled binding, not asserted

`docs/CONTRACT.md` §6 SHALL be rewritten and the `pg_dump` / `pg_restore` commands at
`docs/CONTRACT.md:114-134` SHALL be removed. §6 SHALL NOT name a live-backup primitive until the
comparison between the ruled binding's online backup call and `VACUUM INTO` has been **re-measured on
the ruled binding** (`v1.0.0-sqlite-engine-core`'s blocked decisions B-6/B-7). The corpus comparison
was measured against a different binding and SHALL NOT be carried forward as the basis for contract
text.

The re-measurement SHALL record, with its result: the binding and its exact package version; the
`sqlite_version()` reported at runtime; the filesystem holding the source database, which SHALL be
one the durability probe accepts; the `journal_mode` and `synchronous` level in force; the dataset
size stated relative to the host's page cache; a concurrent-writer load with its commit count; and,
per candidate, the wall-clock duration, the event-loop tick count during the copy, the destination's
structural check result, and the destination's row or page count against the source's committed state
at the call.

IF the ruled binding's online backup call keeps the event loop turning and produces a structurally
clean copy under concurrent commits, THEN it SHALL be documented as the live-backup mechanism, and
`VACUUM INTO` SHALL be documented as a compaction tool only, marked as freezing the JavaScript thread
for the whole copy and as uncancellable.

IF it blocks the thread, restarts under writer interference, or produces a copy that fails
verification under concurrent commits, THEN §6 SHALL state that UmbraDB has **no live-backup
mechanism** and SHALL document the offline procedure rather than presenting a primitive that does not
deliver.

**Any documented file-copy procedure SHALL specify the copy as out-of-process, or taken after a
quiesce, and SHALL say which.** "Quiesced" is not left to the reader: it means **no open write
transaction and every handle to the database closed, or the owning process exited** — the definition
`v1.0.0-sqlite-concurrency-lease` supplies and this change consumes rather than restates in its own
words. A procedure that instructs a consumer
to copy the database file and its sidecars with in-process filesystem calls is the descriptor defect
performed by UmbraDB's own documentation: a single in-process open-then-close of the shared-memory
sidecar voids the write lock held under `BEGIN IMMEDIATE`, after which a second operating-system
process commits inside the holder's transaction — **both commits return success, one acknowledged
commit is silently lost, and the structural check still reports `ok`**. `v1.0.0-sqlite-concurrency-lease`
ships a build-failing source guard banning in-process sidecar descriptor opens, including via
path-building helpers, so an in-process procedure would also fail the build.

§6 SHALL describe this hazard in the **same terms** as the embedder-binding precondition in
`docs/CONTRACT.md` §5, so a consumer who reads one section and not the other still ends up safe.

The re-measurement SHALL additionally record whether each candidate opens any filesystem descriptor
on the database sidecars. A primitive that opens none is **structurally incapable** of triggering the
descriptor defect, which is a mechanism-level argument independent of any timing result.

Under either outcome, §6 SHALL state, each as its own checkable sentence:

1. The **actual cancellation behaviour of the shipped backup call**, as a named exception to §3 —
   whether that is an `AbortSignal` parameter accepted and ignored, or the absence of any
   cancellation affordance. It SHALL be stated as observed on the ruled binding, never carried over
   from another binding's measurement.
2. The backup captures a committed state **at or after** the call, not a snapshot as of the call,
   so §6's chunk/manifest consistency claim is re-justified as *any committed state is closed under
   manifest → chunk* (`Formal/STORAGE_ALGEBRA.md` §2) rather than by snapshot isolation.
3. **Never copy the main database file alone**: the write-ahead-log sidecar holds every commit since
   the last checkpoint, and restoring without it silently reverts the database to an arbitrarily
   older state while reporting a healthy integrity check.
4. A long-running copy **blocks write-ahead-log checkpointing for its whole duration**, and a passive
   checkpoint call returns a not-busy result while checkpointing nothing — so that return is not a
   success signal.
5. There is **no point-in-time recovery**; it becomes a deployer capability (an atomic
   filesystem or volume snapshot of the database and its sidecars) that UmbraDB cannot provide.
6. There is **no SQLite equivalent of a `pg_dump`-class live backup** in the surveyed field, and §6
   SHALL say so rather than implying UmbraDB has recovered the capability.
7. Restore is followed by the verification pass, with its limit stated in the same paragraph.

#### Scenario: Section 6 names no primitive until the measurement exists
- **WHEN** `docs/CONTRACT.md` §6 is reviewed before the B-6/B-7 re-measurement has been recorded
- **THEN** §6 SHALL NOT name a live-backup primitive
- **AND** a named primitive SHALL be treated as a defect, not as a draft to be confirmed later

#### Scenario: The measurement is recorded with the conditions that make it admissible
- **WHEN** the B-6/B-7 re-measurement is recorded
- **THEN** it SHALL carry the binding and package version, the runtime `sqlite_version()`, the
  filesystem, `journal_mode`, `synchronous`, the dataset size relative to page cache, and the
  concurrent-writer commit count
- **AND** a measurement whose recorded filesystem is one the durability probe would refuse SHALL be
  rejected as inadmissible

#### Scenario: Carrying another binding's result into the contract is rejected (negative control)
- **GIVEN** a proposed §6 naming the online backup call as the live-backup mechanism, citing a
  measurement in which a 691 MB copy completed integrity-clean under 781 concurrent commits with the
  event loop turning
- **WHEN** that citation's conditions are checked and show a binding other than the one ruled by
  `v1.0.0-sqlite-engine-core`
- **THEN** the proposal SHALL be rejected — the same defect class as a throughput figure taken on a
  memory filesystem: a real measurement whose conditions no longer hold, carried into a written
  contract

#### Scenario: The no-live-backup outcome is a legitimate contract, not an incomplete one
- **WHEN** the re-measurement shows the ruled binding's backup call blocking the thread or producing
  a copy that fails verification under concurrent commits
- **THEN** §6 SHALL document the offline procedure as the supported path, specifying the copy as
  out-of-process or post-quiesce
- **AND** the change SHALL NOT be judged incomplete for lacking a live-backup primitive

#### Scenario: An in-process file copy is prohibited because it is the defect (negative control)
- **GIVEN** a proposed §6 instructing the consumer to copy the database file and its sidecars using
  in-process filesystem calls
- **WHEN** any writer in the same process holds a transaction during the copy
- **THEN** opening and closing the shared-memory sidecar voids that writer's lock, a second process
  commits inside the holder's transaction, **both commits return success, one acknowledged commit is
  silently lost, and the structural check reports `ok`** — so the procedure SHALL be rejected and
  rewritten as out-of-process or post-quiesce

#### Scenario: The sidecar-descriptor property is recorded per candidate
- **WHEN** the B-6/B-7 re-measurement is recorded
- **THEN** it SHALL state, per candidate, whether that candidate opens any filesystem descriptor on
  the database sidecars
- **AND** a candidate that opens none SHALL be recorded as structurally incapable of triggering the
  descriptor defect, independent of its timing result

#### Scenario: Sections 5 and 6 describe one hazard in one vocabulary
- **WHEN** `docs/CONTRACT.md` §5's embedder precondition and §6's copy procedure are read side by side
- **THEN** both SHALL name the same mechanism and the same consequence in the same terms
- **AND** a consumer who reads only one of the two SHALL still be led to a safe procedure

#### Scenario: The abort exception is discoverable from the backup section itself
- **WHEN** a reader reads §6 without having read §3
- **THEN** §6 SHALL itself state the shipped backup call's cancellation behaviour, rather than
  deferring that fact to §3

### Requirement: driver errors are discriminated by the ruled binding's string code, never by a numeric result code

The error translator SHALL identify a driver error by `err.name === "SqliteError"` and SHALL
discriminate it on `err.code` — the string extended-result-code name, for example `"SQLITE_BUSY"`,
`"SQLITE_CONSTRAINT_PRIMARYKEY"`, `"SQLITE_CONSTRAINT_DATATYPE"`. It SHALL NOT key on a numeric
`err.errcode`, which is `undefined` on the ruled binding (`design.md` §0.4).

The already-typed-error passthrough at the head of the translator SHALL be keyed on
`err instanceof StorageError` and SHALL NOT be keyed on the presence of a string `.code`, because
under the ruled binding a driver error and a `StorageError`
(`src/interfaces/storage-errors.ts:25-38`) both carry one.

The conformance suite SHALL assert that specific provoked faults raise their specific frozen codes,
so a translator that routes everything to the unrecognised-error catch-all fails the gate.

#### Scenario: A provoked fault raises its specific frozen code
- **WHEN** a fault whose translation is defined in the catalog is provoked against the shipped
  adapter
- **THEN** the caller SHALL observe that fault's specific frozen `code`
- **AND** the assertion SHALL be on the `code` value, not merely on the thrown value being a
  `StorageError`

#### Scenario: A numeric-keyed translator makes most of the catalog silently unreachable (negative control)
- **GIVEN** a hypothetical translator written as a switch over numeric extended result codes, as
  every error-translation sketch in the research corpus was
- **WHEN** it runs against the ruled binding, where the numeric field is `undefined`
- **THEN** every driver error SHALL fall through to the unrecognised-error catch-all with no throw,
  no warning and no type error
- **AND** the error-catalog drift test SHALL remain green throughout, because it compares the
  document's code set against the exported class set and reachability is outside its scope
  (`docs/ERROR-CATALOG.md:48-58`) — which is why the per-code reachability assertions above are
  required rather than optional

#### Scenario: A raw driver error never escapes through the passthrough
- **GIVEN** a passthrough written as "if the thrown value carries a string `code`, return it
  unchanged"
- **WHEN** a driver error reaches it
- **THEN** that raw driver error SHALL be returned to the caller untranslated, defeating the
  no-raw-driver-error-escapes property the unrecognised-error code exists to guarantee — which is why
  the passthrough is specified as an `instanceof StorageError` check

### Requirement: a backup's manifest-to-chunk closure is tested rather than asserted

Because the chunk/manifest consistency of a backup is no longer a documented property of an external
dump tool but a property of UmbraDB's own code, the conformance suite SHALL include a property
asserting that a copy produced by the backup operation, taken while writes and garbage collection are
in flight, satisfies the reachability closure of `Formal/STORAGE_ALGEBRA.md` §2 — every manifest in
the copy has every chunk it references.

#### Scenario: A backup taken during garbage collection restores to a closed state
- **WHEN** a backup is taken while a garbage-collection pass and concurrent writes are running
- **THEN** the copy SHALL open cleanly
- **AND** every manifest in the copy SHALL have every chunk it references present
- **AND** the copy SHALL pass the verification pass of this specification

### Requirement: no frozen error code is repurposed and no contention code is added

No existing `code` string in `docs/ERROR-CATALOG.md` SHALL be re-pointed at a different situation
while retaining its `retryable` marking. `CONNECTION_ERROR` SHALL remain exported and listed in the
catalog, marked **documented-unreachable**, and SHALL NOT be re-pointed at the situations "cannot
open the database file", "the database is read-only" or "the file is not a database". Four codes
SHALL be added instead: `DATABASE_UNAVAILABLE` (non-retryable), `DISK_FULL` (conditional),
`DATABASE_CORRUPT` (non-retryable) and `VALUE_INTEGRITY` (non-retryable). `TRANSACTION_POOLER_DETECTED`
SHALL be retained and marked documented-unreachable.

`ValueIntegrityError` SHALL carry the table name and the primary key of the row that failed.
`DatabaseCorruptError` SHALL cover the driver's corruption result code, a failing structural check,
and a schema-digest mismatch, and SHALL carry a `schemaDigest` detail in the last case.

No `BUSY` or `WRITE_CONTENDED` code SHALL be added. Write contention SHALL be bounded inside UmbraDB
and surfaced only through the existing codes that already mean "a bounded wait elapsed" —
`LEASE_TIMEOUT`, `MIGRATION_LOCK_TIMEOUT`, and `TRANSACTION_FAULT` with a `faultKind` that is already
a member of the frozen union at `src/interfaces/transaction-lease.ts:76`.

That prohibition SHALL NOT be generalised into an argument against adding `VALUE_INTEGRITY` or
`DATABASE_CORRUPT`. It turns on **transience**: a contention code would promote a transient the
library should retry into the caller's decision surface. Every premise inverts for a corruption code —
the condition is permanent, not transient; the caller cannot retry past it; and it has no existing
home in the frozen catalog. The field precedent behind the prohibition concerns the mishandling of an
*existing* error, not the absence of a needed one. Both new codes are additive and non-breaking under
`docs/STABILITY.md:20-22`.

`UNRECOGNIZED_POSTGRES_ERROR` and its class SHALL be renamed to `UNRECOGNIZED_DATABASE_ERROR` /
`UnrecognizedDatabaseError` before the 1.0.0 tag. The decision on the six exported `Pg*` adapter
class names SHALL be recorded in the changelog as a decision, whichever way it goes.

#### Scenario: An unreachable code stays exported and stays narrowable
- **WHEN** the built barrel and the catalog are inspected after the migration
- **THEN** `ConnectionError` SHALL still be exported and its `code` SHALL still narrow without
  `instanceof`
- **AND** its catalog row SHALL be marked documented-unreachable with a pointer to the code that now
  covers its former situations

#### Scenario: Repurposing keeps the marking while inverting the behaviour it predicts (negative control)
- **GIVEN** a hypothetical implementation that maps "cannot open the database file" and "the database
  is read-only" onto `CONNECTION_ERROR`, editing only the catalog's Meaning cell
- **WHEN** a consumer's retry policy, built on the machine-readable `retryable` field precisely so it
  need not parse a message (`docs/ERROR-CATALOG.md:8-9`,
  `src/interfaces/storage-errors.ts:19-38`), encounters that error
- **THEN** it retries a condition that will never clear without a deployment change — a semantic break
  the four forbidden verbs of `docs/STABILITY.md:18-25` do not catch, which is why repurposing is
  prohibited rather than merely discouraged

#### Scenario: Write contention does not reach the caller as a new decision
- **WHEN** a write transaction cannot acquire the write lock within its bound
- **THEN** the caller SHALL observe `LEASE_TIMEOUT`, `MIGRATION_LOCK_TIMEOUT` or `TRANSACTION_FAULT`
  as appropriate to the acquisition site
- **AND** no new code representing transient contention SHALL appear in the catalog

#### Scenario: A corruption error names the row it failed on
- **WHEN** a covered row's digest fails verification
- **THEN** the thrown `ValueIntegrityError` SHALL carry the table name and the row's primary key
- **AND** an implementation that raises an unnamed corruption error SHALL be rejected, because it
  forces a full restore for a single-row fault

#### Scenario: The contention prohibition is not generalised to corruption codes (negative control)
- **GIVEN** an argument that adding `VALUE_INTEGRITY` repeats the mistake the contention prohibition
  exists to prevent
- **WHEN** the two are compared on the property the prohibition turns on
- **THEN** the argument SHALL be rejected: contention is transient and library-retryable while
  corruption is permanent and not caller-retryable, and the cited field failure was the mishandling
  of an existing error rather than the absence of a needed one

### Requirement: every integrity fault raised by a sibling change is routed to a named existing code, and scope decides which

This change owns the error catalog, so a sibling change that specifies a fault without naming its
code is specifying an unowned decision. Two such faults exist in `v1.0.0-sqlite-schema-parity` — the
checkpoint-sequence assertion (invariant I-1) failing at `save()`, and the transaction-history
lifecycle / identifier cross-check (invariant I-7) failing on read — and both are ruled here. **No
new code is minted for either.**

The routing rule is **scope**, and it SHALL be stated in `docs/ERROR-CATALOG.md` so a consumer can
predict it:

- A fault detected at the moment of use over an **addressable scope** — a named table and primary
  key, or a named store partition — raises `ValueIntegrityError` (`VALUE_INTEGRITY`, non-retryable).
  This covers a digest mismatch, a NULL digest on a covered row, and every row-scoped invariant
  violation, including both change-4 faults and invariants I-3, I-6, I-7 and I-8.
- A fault whose scope is the **whole database file** raises `DatabaseCorruptError`
  (`DATABASE_CORRUPT`, non-retryable): the driver's corruption result code, a failing structural
  check, and a schema-digest mismatch.

Because one code now has several triggers, `ValueIntegrityError` SHALL carry a machine-readable
discriminator naming which check failed, alongside the table and primary key. A consumer SHALL NOT
have to parse a message to distinguish a digest mismatch from an invariant violation — the same
principle that forbids repurposing a code by editing its meaning.

#### Scenario: Both sibling faults resolve to a named existing code
- **WHEN** the checkpoint-sequence assertion fails at `save()`, and separately when the
  transaction-history cross-check fails on read
- **THEN** each SHALL raise `ValueIntegrityError` with `code === "VALUE_INTEGRITY"`, non-retryable
- **AND** neither SHALL mint a new catalog code
- **AND** each SHALL carry a discriminator identifying the failed check and the addressed scope

#### Scenario: Scope decides the code, and the rule is written down
- **WHEN** `docs/ERROR-CATALOG.md` is read
- **THEN** it SHALL state the scope rule: addressable-scope faults raise `VALUE_INTEGRITY`,
  whole-file faults raise `DATABASE_CORRUPT`
- **AND** each code's row SHALL enumerate its triggers

#### Scenario: A sibling change leaving its fault's code unnamed is a defect (negative control)
- **GIVEN** a sibling requirement stating only that a fault "SHALL fail with a non-retryable error"
  and deferring the code to this change
- **WHEN** this change has not routed it
- **THEN** the decision is owned by nobody and a builder must invent a code at implementation time —
  which is how a frozen catalog acquires an unreviewed member, and is why this requirement routes
  every such fault by name

### Requirement: failures of a process outside the frozen surface are tool diagnostics, not catalog entries

`docs/ERROR-CATALOG.md` covers errors thrown **through the library's frozen public surface**. A
failure raised by a process that is not the library — the data-migration tool, the archive
synchronisation CLI, the snapshot tool — SHALL be reported as a tool diagnostic following the one
error idiom of `design/design-interfaces.md` §1.1, and SHALL NOT add an entry to the catalog, SHALL
NOT be a `StorageError` subclass, and SHALL NOT be re-pointed at an existing catalog code.

This is a membership ruling, not an observability design: the exit codes, report schema and
operator-facing presentation of those tools belong to the changes that own them, and this change
does not specify them. It fixes only which failures the frozen catalog admits, so neither side of
that boundary can defer the question to the other.

#### Scenario: A migration-tool refusal does not enter the frozen catalog
- **WHEN** the data-migration tool refuses an import on a precondition violation
- **THEN** the refusal SHALL be reported as a tool diagnostic with a stable discriminant
- **AND** no row SHALL be added to `docs/ERROR-CATALOG.md`, and the error-catalog drift test SHALL
  remain green because no `StorageError` subclass was added to the barrel

#### Scenario: A tool failure is not routed onto a library code (negative control)
- **GIVEN** a proposal to report a migration-tool refusal as `VALUE_INTEGRITY` or `DATABASE_CORRUPT`
  so it has a stable code
- **WHEN** it is evaluated
- **THEN** it SHALL be rejected: those codes name conditions of a live database addressed through the
  library, and re-pointing them at a tool's precondition failure is the repurposing this change
  prohibits elsewhere

#### Scenario: Neither side defers the membership question to the other
- **WHEN** this change and the tool-owning changes are read together
- **THEN** exactly one of them SHALL state whether tool failures are catalog members, and it SHALL be
  this one
- **AND** the tool-owning changes SHALL specify exit codes and report schemas **against** that ruling
  rather than restating or contradicting it

### Requirement: the persisted value digest and the migration fidelity comparison are two distinct artifacts

The `dg` digest specified by this change is computed over the **exact bytes the database stores**,
with no canonicalisation, and is **persisted**. A migration or import that compares a source system's
values against the imported target is performing a different operation — a transport fidelity check
over canonically parsed values, necessarily not byte-identical because the two systems do not encode
identically — and it SHALL be named distinctly, SHALL NOT be persisted as `dg`, and SHALL NOT be
described as a digest of stored bytes.

A specification SHALL NOT combine the two, and the phrase "bytes as stored, through a
canonicalisation" SHALL NOT appear: it names a preimage that is neither the stored bytes nor a
canonical form, and no implementation can satisfy both readings.

Because the transport check is a comparison rather than a stored integrity mechanism, it does **not**
constitute a second digest mechanism over the covered tier, and the prohibition on a second mechanism
is not violated by it.

#### Scenario: The two artifacts are separable by inspection
- **WHEN** the migration capability's verification text is read
- **THEN** the persisted `dg` and the transport fidelity comparison SHALL be named distinctly, with
  the persisted one described as over stored bytes with no canonicalisation
- **AND** no sentence SHALL describe one preimage as both byte-exact and canonicalised

#### Scenario: The transport check does not trip the one-mechanism-per-tier rule
- **WHEN** the transport fidelity comparison is evaluated against the prohibition on a second
  integrity mechanism over the same tier
- **THEN** it SHALL NOT be treated as a violation, because it is a non-persisted comparison performed
  once during import rather than a stored mechanism verified on read

### Requirement: CLOCK_REGRESSION retains its conditional retryability marking

`CLOCK_REGRESSION` SHALL remain marked `conditional` in `docs/ERROR-CATALOG.md`. IF
`v1.0.0-sqlite-temporal-event-log` adopts a mechanism that removes the same-millisecond precision
collision — the cause that makes the marking `conditional` today (`docs/ERROR-CATALOG.md:73-89`) —
THEN this change SHALL require a second live, caller-fixable cause to be introduced and documented
before that mechanism ships, so the marking is preserved rather than weakened.

#### Scenario: The catalog row and its rationale name two live causes
- **WHEN** the `CLOCK_REGRESSION` row and its rationale section are read after the migration
- **THEN** the `Retryable` cell SHALL read `conditional`
- **AND** the rationale SHALL name two causes that can actually fire against the shipped
  implementation, at least one of which is caller-fixable by retrying

#### Scenario: A silent narrowing to non-retryable is a forbidden weakening (negative control)
- **GIVEN** a proposed catalog in which `CLOCK_REGRESSION` is marked `non-retryable` because the
  same-millisecond cause can no longer occur
- **WHEN** that proposal is evaluated against `docs/ERROR-CATALOG.md:13` ("no `retryable` marking is
  weakened")
- **THEN** it SHALL be rejected as a forbidden weakening, free to avoid before the 1.0.0 tag and a
  forced major release after it

### Requirement: the catalog count is derived from the exported surface and is not confused with the conformance pin

`docs/ERROR-CATALOG.md` SHALL continue to derive its count from the exported concrete `StorageError`
subclasses via the drift test rather than hard-coding it, preserving the arrangement documented at
`docs/ERROR-CATALOG.md:48-58` and `test/api-surface/error-catalog-drift.test.ts:19-31`. The catalog's
reconciliation section SHALL state that the pre-migration catalog was **24** codes, and SHALL state
that `EXPECTED_REQUIRED_COUNT` (`test/integration/check-required-tests.ts:100`) is the pinned length
of the required conformance-test id list and is **not** a count of error codes.

#### Scenario: The drift test remains the authority and the two pins are distinguished
- **WHEN** the catalog's reconciliation section is read after the migration
- **THEN** it SHALL state that the count is derived by the drift test and hard-coded nowhere
- **AND** it SHALL record 24 as the pre-migration catalog size
- **AND** it SHALL state explicitly that the conformance manifest's pinned required-id count is a
  different object from the error-code count

#### Scenario: Adding a code fails the gate until the table is updated
- **WHEN** a new concrete `StorageError` subclass is re-exported from the barrel without a
  corresponding catalog row
- **THEN** the drift test SHALL fail
- **AND** the failure SHALL name the code set difference rather than a count mismatch alone

### Requirement: the stability policy binds the situation-to-code mapping and bounds additive-only

`docs/STABILITY.md` SHALL state that for each row of the frozen catalog, the situation the row's
Meaning cell describes raises that row's `code`, except where the row is explicitly marked
documented-unreachable. It SHALL also state that "additive-only" does not automatically extend to
widening the exported string-literal union types (`SharedStorageErrorCode`, `TemporalKVErrorCode`,
`CheckpointStoreErrorCode`, `TransactionLeaseErrorCode`, `WalletStateEnvelopeErrorCode`, and the
`faultKind` union at `src/interfaces/transaction-lease.ts:76`), because widening a union in an output
position breaks a consumer's exhaustive `switch`.

`docs/STABILITY.md` SHALL additionally record that the expectation it sets at `:60-63` — that the
surface at 1.0.0 would be identical to `0.9.5` — was not met, and why.

#### Scenario: The policy closes the situation-to-code hole in one direction or the other
- **WHEN** `docs/STABILITY.md` is read
- **THEN** it SHALL contain a statement binding the situation-to-code mapping, with the
  documented-unreachable carve-out named
- **AND** the mapping SHALL NOT be left unmentioned

#### Scenario: The union-widening caveat is stated
- **WHEN** `docs/STABILITY.md`'s additive-only commitment is read
- **THEN** it SHALL name the exported string-literal union types and state that widening one is not
  automatically a non-breaking change

#### Scenario: The retraction is recorded before the tag, not at it
- **WHEN** the stability policy's pre-1.0 scope section is read
- **THEN** it SHALL record that the release-candidate expectation of an identical 1.0.0 surface was
  falsified by the storage-engine migration, and name the surface delta

### Requirement: the release record prices every break as pre-tag and post-tag

The change's release record SHALL, for each surface or contract break it makes, state the cost of
landing it before the 1.0.0 tag and the cost of landing it after, grounded in `docs/STABILITY.md:46`
(the commitments are not yet in force at `0.9.5`) and `:60-63` (a breaking change between `0.9.5` and
`1.0.0` is permitted).

#### Scenario: Each break carries both prices
- **WHEN** the release record's break ledger is read
- **THEN** every listed break SHALL carry a pre-tag cost and a post-tag cost
- **AND** the entries that independently force a major release after the tag — the
  `UNRECOGNIZED_POSTGRES_ERROR` rename and a `CLOCK_REGRESSION` narrowing — SHALL be identified as
  such

#### Scenario: The one permanently broken promise is identified as such
- **WHEN** the break ledger is read
- **THEN** the deletion of `docs/CONTRACT.md` §3's freed-wait clause SHALL be recorded as a promise
  that cannot be bought back at any price, before or after the tag, under any driver choice

### Requirement: the manual pre-tag evidence artifact is re-executed against the new release candidate, never amended

`docs/recovery/EVIDENCE.md` SHALL be re-executed against the new release-candidate commit rather than
edited, in accordance with its own binding rule 1 (`docs/recovery/EVIDENCE.md:10-11`). The change's
cost accounting SHALL record this as a **sunk cost of the 1.0.0 tag rather than a cost of this
migration**, because `ROADMAP.md:389-398` already requires a fresh release candidate and a full
R1–R12 re-run (`docs/v1-implementation-guideline.md:826,862`) before the tag.

The re-execution SHALL also repair the artifact's existing violation of its own binding rule 2
(`:12-13`): the Cold-boot round-trip table at `:44-53` is six blank cells today, neither captured nor
marked `NOT CAPTURED`. Every field SHALL carry captured output or the literal `NOT CAPTURED`, and a
document lint SHALL fail the gate on a blank cell in any table governed by binding rule 2.

#### Scenario: The re-executed artifact records the release-candidate commit it ran against
- **WHEN** the re-executed `docs/recovery/EVIDENCE.md` is read
- **THEN** its Run-identity table SHALL name the release-candidate commit SHA that will be tagged
- **AND** no value SHALL have been copied forward from the previous run

#### Scenario: A blank cell in a rule-2 table fails the gate
- **WHEN** the document lint runs against an evidence artifact whose Cold-boot round-trip table
  contains an empty cell
- **THEN** the lint SHALL fail and SHALL name the empty field
- **AND** a cell containing the literal `NOT CAPTURED` SHALL pass

#### Scenario: The cost accounting does not charge the re-execution to the migration
- **WHEN** the change's cost accounting is read
- **THEN** the evidence re-execution SHALL be recorded as already required by the path to 1.0.0
- **AND** the incremental cost attributed to the migration SHALL be stated as approximately zero,
  with `ROADMAP.md:389-398` cited

### Requirement: the conformance suite is re-executed with negative controls and gains the properties SQLite creates

The P1–P10 conformance suite (`Formal/STORAGE_ALGEBRA.md` §5) SHALL be **executed against SQLite**,
not ported and assumed. Every surviving crash property SHALL ship a negative control demonstrating
that the harness detects the failure it is looking for. Five properties SHALL be added:

- **P11** — `journal_mode` and `synchronous` hold at or above their configured floors at every commit
  the durability contract covers, since the pragma is persistent in the file and mutable out from
  under the library.
- **P12** — after a crash, the structural check reports `ok` **and** the durable cursor is not ahead
  of durable data (`docs/checkpoint-store-contract.md:16-18`).
- **P13** — the backup closure property of this specification.
- **P14** — `foreign_keys` is `ON` on every connection.
- **P15** — a value corrupted in place is detected on read, and the same corruption is **not**
  detected by the structural check alone.

Documentation and risk arguments SHALL NOT cite the survival of the Lean cut-line `{T3, T5, W1, C1}`
across the migration as evidence that the migration is safe; that survival is a consequence of the
cut-line modelling an abstract store across an explicitly trusted, unmechanized bridge.

The refinement register (`openspec/changes/v1.1.0-formal-completion/design.md`) SHALL be rewritten
**before** the adapter port begins, with every status label re-derived rather than carried over, and
with an explicit statement naming the mechanisms that no longer exist.

#### Scenario: A surviving crash property ships its negative control
- **WHEN** a crash property that held under PostgreSQL is re-executed against SQLite and passes
- **THEN** the same harness SHALL be run against the deliberately forbidden shape it exists to reject
- **AND** that run SHALL fail the invariant, demonstrating the harness is not vacuously green

#### Scenario: A green formal gate is not offered as migration evidence (negative control)
- **GIVEN** a risk argument that cites the Lean cut-line remaining green across the engine
  replacement as evidence the migration is safe
- **WHEN** that argument is reviewed
- **THEN** it SHALL be rejected, because the cut-line constrains an abstract store and no theorem
  relates it to the concrete implementation — its greenness across a total replacement of the
  concrete layer is evidence of that disconnection

#### Scenario: The register is written before the port
- **WHEN** the first adapter commit of the migration is reviewed
- **THEN** the rewritten refinement register SHALL already be committed
- **AND** each row SHALL name the new mechanism and carry a status label derived from that mechanism,
  not inherited from the PostgreSQL row it replaces

### Requirement: deleting a pinned conformance id is a reviewed contract change in its own commit

WHEN a required conformance-test id is removed from `test/integration/required-tests.manifest.json`,
the removal SHALL be committed separately from any change to `EXPECTED_REQUIRED_COUNT`
(`test/integration/check-required-tests.ts:100`), so the structural pin does its job of forcing a
review rather than being adjusted in the same diff.

Because making `CONNECTION_ERROR` unreachable deletes `crash.pg-kill-save.typed-connection-error` —
the only required id whose assertion is that a **retryable** frozen code is reachable and typed — a
replacement required id SHALL be added proving that at least one member of the retryable set
`{TRANSACTION_FAULT, LEASE_TIMEOUT, MIGRATION_LOCK_TIMEOUT}` is reachable under SQLite and surfaces
as a typed class with its stable `.code`, never a message substring.

#### Scenario: The pin change and the deletions are separate reviewed commits
- **WHEN** the history of the conformance-manifest change is inspected
- **THEN** the commit that removes required ids SHALL NOT also change the pinned count
- **AND** the commit that changes the pinned count SHALL reference the review of the removals

#### Scenario: A retryable frozen code is still empirically reachable
- **WHEN** the re-executed conformance suite runs
- **THEN** a required id SHALL exercise a real fault that surfaces as a member of the frozen
  retryable set
- **AND** the assertion SHALL be on the typed class and its `.code`, not on a message substring

### Requirement: a running embedded engine can be diagnosed from outside itself without a debugger

Because no analogue of `pg_stat_activity`, `pg_stat_statements` or a live `EXPLAIN ANALYZE` exists for
an embedded engine — and because the engine handle may be owned by a worker thread — UmbraDB SHALL
provide a diagnostic operation and a written triage procedure that together answer, for a process
reported as stuck: which statement is in flight and for how long; how long the open transaction has
been open; whether the writer lease is held and by whom; the current write-ahead-log size and the
outcome of the last checkpoint attempt; contention and retry counters; and the verification pass on
demand.

This diagnostic surface SHALL NOT be added to the frozen public barrel; the deferral of a public
observability API recorded by `v1.0.0-api-surface` is not reopened by this change.

`docs/CONTRACT.md` SHALL state that a passive checkpoint call returning a not-busy result while
checkpointing nothing is **not** a success signal and must not be monitored as one.

#### Scenario: The triage procedure answers "the wallet is stuck" without attaching a debugger
- **WHEN** an operator follows the documented triage procedure against a process that has stopped
  making progress
- **THEN** the diagnostic report SHALL name the in-flight statement and its elapsed time, the age of
  the open transaction, the lease holder, the write-ahead-log size, and the last checkpoint outcome
- **AND** none of those SHALL require attaching a debugger or reading the engine's internals

#### Scenario: The diagnostic surface is not on the frozen barrel
- **WHEN** the built public barrel is inspected
- **THEN** no diagnostic or observability symbol introduced by this change SHALL be re-exported from
  it

#### Scenario: A passive checkpoint result is not treated as success
- **WHEN** the contract's checkpoint guidance is read
- **THEN** it SHALL state that a passive checkpoint can report a not-busy result while checkpointing
  zero pages, and that monitoring must use the write-ahead-log size rather than that return value

### Requirement: the unbounded transaction hold is documented as unbounded and instrumented rather than claimed to be bounded

`docs/durability-contract.md`'s statement that no statement, lock wait or idle-in-transaction session
can hang unbounded (`docs/durability-contract.md:94-115`) SHALL be rewritten. The rewritten text
SHALL state that only the lock wait retains a bound; that there is no equivalent of a server-side
idle-in-transaction timeout; and that `withTransaction` holds a **whole-database** write lock around
arbitrary caller code (`design/design-interfaces.md` §1.3, `design/design.md` §5), with no backstop
that can unwind a synchronous engine call.

UmbraDB SHALL instrument the hold: a transaction open longer than a configured threshold SHALL raise
a diagnostic observable through the surface required above.

#### Scenario: The contract states the hold is unbounded
- **WHEN** the rewritten timeouts section is read
- **THEN** it SHALL NOT claim that an idle-in-transaction session is bounded
- **AND** it SHALL state that a caller callback holding the write lock stalls every writer with no
  server-side backstop

#### Scenario: A long-held transaction is observable before it becomes a support ticket
- **WHEN** a transaction remains open beyond the configured threshold
- **THEN** a diagnostic SHALL be raised naming the transaction's age and its opening call site
- **AND** the diagnostic SHALL be visible in the diagnostic report without restarting the process

### Requirement: every engine-named contract sentence is re-derived and every external precedent citation is re-verified before it ships

WHEN a sentence in the contract document set names a PostgreSQL artifact — a SQLSTATE, a server
setting, a pooler, an advisory lock, `pg_dump`, `jsonb`, `bytea` — that sentence SHALL be re-derived
against the shipped SQLite implementation rather than translated, and the resulting claim SHALL cite
the code or measurement that supports it.

IF a contract sentence rests on a claim about an external project, THEN that claim SHALL be
re-verified against a pinned upstream commit or a version-pinned document URL before the text ships,
and any claim that cannot be re-verified SHALL be **struck rather than softened**.

#### Scenario: An engine-named claim carries its own evidence
- **WHEN** any sentence in the rewritten contract set is checked
- **THEN** it SHALL be supported by a `file:line` citation into this repository, or by a recorded
  measurement with the command that produced it
- **AND** no sentence SHALL rest solely on a research lane's characterisation of a document

#### Scenario: An unverifiable external precedent is struck (negative control)
- **GIVEN** a proposed §6 paragraph citing another project's backup guidance, its retraction of a
  third-party replication recommendation, or an unimplemented method in its source
- **WHEN** the citation cannot be resolved to a pinned upstream commit or a version-pinned document
  URL at authoring time
- **THEN** the paragraph SHALL be removed rather than reworded into a hedge, because a hedged
  unverifiable citation reads as evidence while carrying none

### Requirement: the known verification gaps are recorded in the catalog rather than left for a green gate to hide

The catalog SHALL record, against the codes affected, that I/O-fault result codes cannot be injected
without a virtual-filesystem hook the driver does not expose, so `LEASE_FAULT` and `DISK_FULL` are
reachable in principle and untested in practice. The contract set SHALL state whether Windows is a
supported platform for the new filesystem-locking precondition or is explicitly out of scope, rather
than leaving it unstated. The release record SHALL record whether any external consumer of the
`0.9.5` surface is known to exist, noting that a git-tag install leaves no registry footprint so the
absence of consumers is unobservable rather than proven.

#### Scenario: An untestable code is labelled untestable
- **WHEN** the catalog rows for `LEASE_FAULT` and `DISK_FULL` are read
- **THEN** each SHALL carry a note that its triggering condition cannot be injected in CI with the
  chosen driver
- **AND** the note SHALL name what would be required to close the gap

#### Scenario: Platform support is a decision, not an omission
- **WHEN** the contract set is read
- **THEN** it SHALL state either that Windows is supported and covered by a filesystem-locking test,
  or that Windows is out of scope for the 1.0.0 line

#### Scenario: The consumer question is answered in the record rather than assumed
- **WHEN** the release record is read
- **THEN** it SHALL state what is known about external consumers of `0.9.5`
- **AND** it SHALL state that a git-tag install is unobservable from the repository, so a claim of
  zero consumers rests on the owner's enumeration rather than on evidence

### Requirement: the unmeasured integrity quantities are carried as obligations, never as assumptions

Five quantities remain unmeasured and SHALL be carried as named obligations against a stated gate
rather than assumed in any document: the digest's write cost under the engine change's measurement
conditions; the verification pass's runtime at a representative archive scale, measured for both its
structural and digest components and with a **separate-process** writer; the storage delta on real
rather than synthetic payloads; the field corruption base rate; and an executed rebuild procedure for
the archive projection tables.

Until the verification pass's runtime is measured, no document SHALL recommend it as a routine or
scheduled operation; it SHALL be described only as an on-demand diagnostic and post-restore check.
Until the rebuild procedure has been executed once and its transcript recorded, the contract's archive
row SHALL say "resynchronise from chain" and SHALL NOT claim a local rebuild. The field base rate
SHALL be recorded as an honest open, and no cost or benefit argument in any document SHALL be stated
as if a rate were known.

The digest write-cost measurement SHALL **record** and SHALL NOT **gate**: the coverage set is
unconditional, and no measured value changes it.

#### Scenario: The obligations are listed against gates, with their consequences
- **WHEN** the unmeasured-obligations record is read
- **THEN** each of the five SHALL name the gate it lands under and the consequence that holds until
  it is measured
- **AND** none SHALL appear anywhere else in the document set as a settled quantity

#### Scenario: A scheduled verification pass is not recommended before it is measured
- **WHEN** the documentation is searched for operational guidance on the verification pass
- **THEN** it SHALL be described as an on-demand diagnostic and a post-restore check
- **AND** no text SHALL recommend running it on a schedule or assume a periodic pass is affordable

#### Scenario: The write-cost measurement records but does not gate (negative control)
- **GIVEN** a proposal to drop a table from the coverage set because the measured digest write cost
  came in higher than expected
- **WHEN** the proposal is evaluated
- **THEN** it SHALL be rejected: the coverage set is unconditional, and a measurement that could
  narrow it would be the cost-based escape hatch this specification removed
