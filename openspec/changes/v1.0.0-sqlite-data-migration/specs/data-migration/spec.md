# data-migration

The capability that moves an existing UmbraDB **PostgreSQL** deployment's wallet-tier data onto
**SQLite** without loss, and that lets a consumer *prove* it was moved without loss before deleting
the PostgreSQL database.

**Scope note.** This capability does not specify the target schema (`v1.0.0-sqlite-schema-parity`,
change 4; `v1.0.0-sqlite-temporal-event-log`, change 2), the driver, shim, worker topology, pragma
bootstrap or the measurement gate (`v1.0.0-sqlite-engine-core`, change 1), or the digest regime,
`verifyIntegrity`, the durability probe, backup/restore, the error catalog and observability
(`v1.0.0-sqlite-durability-contract`, change 5). It specifies only how existing rows become target
rows, what happens when they cannot, and what "verified" means. It covers the **wallet tier only**:
the chain archive begins life with zero rows and is ported greenfield by change 6
(`v1.0.0-sqlite-chain-archive`), so it has no import step.

`data-migration` has never been merged into `openspec/specs/`, so every requirement below is
`ADDED`. There is no merged text to delta against and a `## MODIFIED Requirements` header here would
be a delta against nothing — the same reasoning `v1.0.0-sqlite-durability-contract/design.md` §0.3
records for `release-contract`.

Requirements follow EARS (Easy Approach to Requirements Syntax), as in Sprint 4's and Sprint 7's
spec files. **CAN** marks a measured possibility; **SHALL** marks an obligation. Negative-control
scenarios describe a hypothetical wrong implementation and what it would lose; they are house style
and several of the ones below are measured rather than imagined (`design.md` §13).

## ADDED Requirements

### Requirement: the migration reads the source PostgreSQL database and never writes to it

The export SHALL issue only `SET`, `BEGIN`, `SELECT`, `COPY … TO`, `COMMIT` and `ROLLBACK`. It SHALL
NOT create, alter or drop any object in the source database; SHALL NOT insert, update or delete any
row, including into any bookkeeping, progress or marker table of its own; and SHALL NOT hold any
lock beyond the read transaction.

Because the source is untouched, the supported rollback is the source database itself, at zero
additional cost and with no restore step (see the rollback requirement below).

#### Scenario: The export SQL contains no writing statement

- **WHEN** every shipped export `.sql` file is scanned by an automated check
- **THEN** no statement outside the permitted set SHALL appear
- **AND** the check SHALL fail the build rather than warn

#### Scenario: The source is byte-identical after an export

- **GIVEN** a source database whose pre-export state has been recorded
- **WHEN** an export runs to completion, and separately when an export is interrupted mid-stream
- **THEN** in both cases every source table's row count and content digest SHALL be unchanged
- **AND** no new relation SHALL exist in the source schema

#### Scenario: A progress-tracking table in the source (negative control)

- **WHEN** a hypothetical exporter records its progress by writing a row into the source database so
  it can resume
- **THEN** it CAN resume more cheaply
- **AND** it SHALL be rejected, because it destroys the property that makes the source a valid
  rollback: a consumer who aborts the migration would be returning to a database the migration has
  modified, and `docs/STABILITY.md:40-42`'s "take a backup" guidance would no longer be satisfied by
  the source alone

### Requirement: the target database is created by running the SQLite lineage to completion on an empty file before any row is imported

WHEN the importer creates a target database, it SHALL open it through the connection factory of
`v1.0.0-sqlite-engine-core`, so the pragma bootstrap and its read-back assertion run on the empty
file before any write; it SHALL then apply `v1.0.0-sqlite-schema-parity`'s full migration lineage —
`000` through `009`, including `008_ckpt_manifests_seq_unique` and `009_value_digests` — to
completion; and only then SHALL it insert the first imported row.

The importer SHALL NOT create any table, index, trigger or view of its own, and SHALL NOT interleave
lineage steps with data.

#### Scenario: Migration 006 replays because the table is empty

- **GIVEN** `v1.0.0-sqlite-schema-parity`'s migration `006` adds `size_bytes` as
  `GENERATED ALWAYS AS (octet_length(data)) STORED`, which succeeds on a zero-row table and fails at
  one or more rows
- **WHEN** the lineage runs before the first imported chunk
- **THEN** `006` SHALL apply
- **AND** the target's schema SHALL be indistinguishable from a greenfield database's at the same
  lineage position

#### Scenario: Rows imported before the lineage completes (negative control)

- **WHEN** a hypothetical importer creates the chunk table itself, loads chunks, and then runs the
  remaining lineage
- **THEN** migration `006` SHALL fail with `cannot add a STORED column`
- **AND** an importer that "fixed" this by substituting a `VIRTUAL` column would produce a database
  whose schema silently differs from every greenfield database, which
  `v1.0.0-sqlite-schema-parity` requirement *"migration 006 replays verbatim, and no future migration adds a STORED generated column to a populated table"* prohibits

#### Scenario: The irreversible pragmas are set on an empty file

- **WHEN** the target file is created
- **THEN** `page_size` and `auto_vacuum` SHALL be established before `journal_mode` and before any
  write, per `v1.0.0-sqlite-engine-core` requirement *"the pragma bootstrap is an ordered, once-only sequence whose effect is verified by read-back"*
- **AND** the importer SHALL NOT offer an option that changes them for a bulk load, because neither
  can be retrofitted afterwards without a full `VACUUM`

### Requirement: the temporal event log is reconstructed from both source tables and the live version is never dropped

For each `(ns, scope, key)`, the imported event chain SHALL be the source's `kv_history` rows in
ascending `version` — each contributing `written_at := valid_from` — followed by the source's
`kv_current` row contributing `written_at := updated_at`. The importer SHALL NOT transport
`kv_history.id`, `kv_history.valid_to`, `kv_history.validity` or `kv_current.updated_xact`.

`kv_history` holds versions `1 … n−1` and `kv_current` holds version `n`, because the `BEFORE UPDATE`
trigger at `src/postgres/migrations/001_temporal_kv.ts:113-139` writes the **superseded** row to
history. Reading either table alone is a truncation, not an approximation.

#### Scenario: A key with three versions round-trips

- **GIVEN** a key whose source state is two `kv_history` rows at versions 1 and 2 and a `kv_current`
  row at version 3
- **WHEN** the key is imported
- **THEN** the target SHALL hold exactly three `kv_event` rows for it, at versions 1, 2 and 3
- **AND** the derived `valid_to` of version 3 SHALL be SQL `NULL`, not a far-future sentinel
- **AND** `get()` SHALL return version 3's value, and `getAt({version: 1})` SHALL return version 1's

#### Scenario: A current-state-only migration (negative control)

- **WHEN** a hypothetical importer copies `kv_current` only, on the reasoning that it is the live
  state and history is derivable or expendable
- **THEN** `get()` SHALL agree for every key, and a row-count check on `kv_current` SHALL pass
- **AND** every historical version SHALL be gone: `getAt({version: 1})` returns `null` where it
  returned a value, and `getAt({at: T})` for any `T` before the last write returns `null` where it
  returned a value
- **AND** this is unrecoverable: under `v1.0.0-sqlite-durability-contract` requirement *"integrity
  coverage follows the three-class corruption model with an explicit column-level coverage set"*,
  re-derivability is the obligation test *within* Class A, and `kv_event.value` is non-re-derivable
  Class-A exposure — so no resynchronisation from chain restores a lost version

#### Scenario: A history-only migration (negative control)

- **WHEN** a hypothetical importer copies `kv_history` only, on the reasoning that it is "the
  history table"
- **THEN** every key SHALL be missing its live version, and every key's `get()` SHALL return the
  previous value
- **AND** the per-key cardinality check `count(kv_event WHERE key = K) = kv_current.version` SHALL
  detect it, which is why that check is per-key and not a total

### Requirement: the reconstruction's source preconditions are verified per key rather than inherited from the adapter

The importer SHALL verify, for every `(ns, scope, key)` in the bundle: that a `kv_current` row exists
whenever `kv_history` rows exist (**S1**); that the history versions are exactly `1 … n−1`, each once
(**S2**); that `valid_to(v) = valid_from(v+1)` for every `v < n−1` and `valid_to(n−1) =
kv_current.updated_at` (**S3**); that `valid_from` strictly increases and `kv_current.updated_at`
exceeds the last `valid_from` (**S4**); that no version appears in both tables (**S5**); and that
every timestamp is a whole number of milliseconds (**S6**).

The importer SHALL NOT treat any of these as guaranteed by the source schema. None is enforced by a
constraint spanning both tables — `src/postgres/temporal-kv.ts:233-237` states this in terms, and
`kv_history_no_overlap` (`src/postgres/migrations/001_temporal_kv.ts:97-99`) constrains `kv_history`
alone.

The verification SHALL run as a pre-flight pass over the bundle **before** the first write
transaction opens, so a failure names the source rows rather than a SQLite constraint.

#### Scenario: S3 is the whole correctness argument and is checked, not assumed

- **WHEN** the pre-flight pass runs
- **THEN** it SHALL confirm for every key that each history row's `valid_to` equals the next
  version's `valid_from`, and that the last history row's `valid_to` equals the live row's
  `updated_at`
- **AND** because point-in-time equivalence (Law T3, `Formal/STORAGE_ALGEBRA.md` §1) follows from
  this property and nothing else, a bundle that satisfies it is the only bundle for which the
  reconstruction is faithful

#### Scenario: Trusting the trigger instead of checking (negative control)

- **GIVEN** that the `BEFORE UPDATE` trigger writes `valid_to` and the surviving row's `updated_at`
  from a single `now_ts` (`src/postgres/migrations/001_temporal_kv.ts:126-127`), so S3 holds for
  every write the adapter made
- **WHEN** a hypothetical importer concludes S1–S6 need no checking
- **THEN** it SHALL be correct for every database only ever touched by UmbraDB
- **AND** it SHALL silently mis-migrate any database a consumer has ever repaired, backfilled or
  edited with `psql` — which is unknowable from the exporting side, and is why the check is
  unconditional rather than opt-in

### Requirement: a source state the event-log encoding cannot represent is refused, and no target database is produced

IF the pre-flight pass finds a violation of S1–S6, THEN the migration SHALL abort with a diagnostic
naming the precondition, the `(ns, scope, key)`, and the source rows involved; SHALL NOT import the
key; SHALL NOT import any other key; and SHALL leave no database at the target path.

The importer SHALL NOT repair, coerce, interpolate or select a winner for any such state.

Refusals SHALL be reported as tool diagnostics following `design/design-interfaces.md` §1.1's one
idiom — thrown and `code`-discriminated — and SHALL NOT add an entry to `docs/ERROR-CATALOG.md`, per
`v1.0.0-sqlite-durability-contract` requirement *"no frozen error code is repurposed and no contention code is added"*.

#### Scenario: A gapped history manufactures data (negative control, measured)

- **GIVEN** a source key whose history intervals are `[1000, 2000)` and `[3000, ∞)` — legal, because
  `kv_history_no_overlap` forbids overlap and not gaps — where `getAt({at: 2500})` returns `null`
- **WHEN** a hypothetical importer transports the event rows without checking S3
- **THEN** the derived intervals become `[1000, 3000)` and `[3000, NULL)`, and `getAt({at: 2500})`
  returns **version 1** (measured, `design.md` §13 E3)
- **AND** every downstream check passes: row counts match, per-row digests match, and every one of
  change 2's append-only and strict-increase assertions holds, because the imported chain is
  well-formed — it is simply a different function of the query instant
- **AND** the migration SHALL therefore refuse at the pre-flight pass, which is the only layer that
  can see it

#### Scenario: A version present in both source tables is unrepresentable

- **GIVEN** a source in which a `kv_history` row and the `kv_current` row share a `version` — a state
  `src/postgres/temporal-kv.ts:231-240` documents as reachable and resolves for reads with a
  `priority` tiebreak
- **WHEN** the pre-flight pass runs
- **THEN** it SHALL refuse under S5
- **AND** the diagnostic SHALL state that the source's own `get()` and `getAt({version: n})` already
  disagree, so no single-row encoding can preserve both observations

#### Scenario: Applying the priority tiebreak instead of refusing (negative control)

- **WHEN** a hypothetical importer resolves the collision the way the source's reads do — history
  wins — and imports one row
- **THEN** the point-in-time replay SHALL pass, because it exercises `getAt`
- **AND** `get()` SHALL return a different value than it did before the migration, which no
  digest, row count or `getAt` replay detects

#### Scenario: A trigger abort is a backstop, not the diagnostic

- **GIVEN** that change 2's `kv_event_bi` trigger rejects an out-of-order version with
  `UB_T1_VERSION` and a non-increasing `written_at` with `UB_T4_CLOCK` (measured, `design.md` §13 E3)
- **WHEN** a defect lets a violating row reach the database
- **THEN** the trigger SHALL abort the statement
- **AND** the triggers SHALL NOT be disabled or worked around, and the pre-flight pass SHALL remain
  the layer that produces a diagnostic naming the source

### Requirement: checkpoint manifest identifiers are preserved and no generated column is transported

The importer SHALL insert `ckpt_manifests` rows with their source `id` values explicitly, because
`ckpt_manifest_chunks.manifest_id` references them (`src/postgres/migrations/002_checkpoint_store.ts:58`).
It SHALL import chunks, then manifests, then junction rows, so every foreign key resolves at insert
time with `PRAGMA foreign_keys = ON`. It SHALL preserve the junction's `position` multiplicity, since
one manifest CAN reference one chunk hash at two positions (`002_checkpoint_store.ts:44-49`).

The importer SHALL NOT transport any generated column, including `ckpt_chunks.size_bytes`.

The wallet-state envelope tier requires no import step of its own: `src/postgres/wallet-state-envelope.ts:11-12`
states verbatim that it *"Adds NO new table or migration -- it reuses `CheckpointStore`'s own
chunk/manifest storage entirely."* Migrating the checkpoint tables migrates it in full.

#### Scenario: Preserved ids do not collide with later allocations

- **GIVEN** manifests imported with explicit ids into an `INTEGER PRIMARY KEY AUTOINCREMENT` column
- **WHEN** the application later saves a new checkpoint
- **THEN** the newly allocated id SHALL exceed every imported id, because `sqlite_sequence` follows
  the largest explicitly inserted value (measured, `design.md` §13 E1: ids `7, 3, 91` leave
  `seq = 91` and the next insert receives `92`)
- **AND** no manual `sqlite_sequence` seeding SHALL be required

#### Scenario: Importing with foreign keys disabled (negative control, measured)

- **WHEN** a hypothetical importer sets `PRAGMA foreign_keys = OFF` so it can load tables in any
  order
- **THEN** a junction row referencing a chunk that was never imported SHALL insert successfully, and
  `PRAGMA integrity_check` SHALL report `ok` (measured, `design.md` §13 E4)
- **AND** only `PRAGMA foreign_key_check` names the dangling reference, which is why the verification
  ladder requires both
- **AND** `foreign_keys` not being `ON` is in any case a hard refusal of the durability probe
  (`v1.0.0-sqlite-durability-contract` requirement *"the durability probe verifies library-controlled pragmas instead of deployer-supplied server settings"*)

### Requirement: the identifier array is exploded into the junction table and the two I-7 cross-checks hold on the imported data

The importer SHALL write one `<schema>_transaction_history_identifiers` row per distinct
`(wallet_id, tx_hash, identifier)` triple in the source's `identifiers text[]` column, and SHALL
import the `entry` JSON unchanged, which carries the same array with its order and multiplicity
(`src/postgres/transaction-history-storage.ts:182`).

Under `v1.0.0-sqlite-schema-parity`'s invariant **I-7** (its `design.md` §19.2), the read path
derives the returned `identifiers` array from `entry` and cross-checks it against the junction.
Because `entry` is transported verbatim, `getAll().identifiers` SHALL therefore be byte-identical
across the migration, order and multiplicity included, and verification SHALL compare it **exactly**
rather than as a set.

Verification SHALL additionally assert both I-7 cross-checks against the imported target, without
reference to the source, since both are target-internal invariants: the junction rows for each
`(wallet_id, tx_hash)` SHALL equal, **as a set**, the identifiers derived from that row's `entry`;
and the `lifecycle` column SHALL equal `entry.lifecycle.status`.

IF either cross-check fails on data derived from the source, THEN the source itself held two
disagreeing representations of one fact, and the migration SHALL refuse under the newly-constrained-
source requirement below rather than choosing a representation.

#### Scenario: A row with duplicate identifiers

- **GIVEN** a source row whose `identifiers` column is `['a', 'a', 'b']`
- **WHEN** it is imported
- **THEN** the junction SHALL hold exactly two rows, for `a` and `b`
- **AND** the imported `entry` SHALL still contain `["a","a","b"]` in that order
- **AND** `getAll()` SHALL return `["a","a","b"]` in that order, unchanged from before the migration,
  because I-7 derives it from `entry`
- **AND** the junction cross-check SHALL compare as a **set** and SHALL NOT fault on the duplicate,
  per `v1.0.0-sqlite-schema-parity/design.md` §19.2

#### Scenario: The junction is verified, not trusted

- **WHEN** the junction rows for a wallet's transaction disagree with that row's `entry.identifiers`
- **THEN** verification SHALL report a fault naming the `(wallet_id, tx_hash)`
- **AND** the returned value SHALL still derive from `entry`, which is the representation covered by
  the `dg` digest, so the caller's answer is backed by a value digest rather than by an unverified
  index

#### Scenario: A junction-reading read path would return a wrong answer silently (negative control)

- **WHEN** a hypothetical port keeps today's behaviour of returning the denormalised representation —
  after migration, the junction table
- **THEN** a damaged junction SHALL return wrong identifiers with **every digest passing**, because
  no per-value digest covers the junction
- **AND** the returned array SHALL also be reordered to code-point order and deduplicated relative to
  what the source returned, which I-7 avoids entirely

### Requirement: a source that violates a constraint the target newly adds is refused with a remediation report, and is never quarantined

`v1.0.0-sqlite-schema-parity/design.md` §17.4 assigns this decision to this capability. It is
answered by distinguishing two classes of unimportable source.

A **Class 1** state is one the target cannot represent because importing it would change what a
caller observes: a gap in a validity chain; a version present in both source temporal tables; and an
`entry`/column disagreement in transaction history, where the source holds two answers and the target
keeps one. A **Class 2** state is one whose observable behaviour *is* representable but which fails a
constraint PostgreSQL never had: migration `008`'s `UNIQUE (w, net, seq)` on `ckpt_manifests`; the
`next_seq > max(seq)` runtime invariant of that change's §17.3(a); the 32-byte `CHECK` on chunk and
manifest hashes; and the `lifecycle` enum `CHECK`.

Both classes SHALL refuse by default, and the migration SHALL NOT repair either automatically.

WHEN a Class 2 violation is found, the tool SHALL additionally emit a remediation report naming every
offending row, the constraint it fails, and the **source-side** statements that would resolve it. The
consumer applies those to their own PostgreSQL database and re-exports; the migration SHALL still
write nothing to the source. WHEN a Class 1 violation is found, the tool SHALL report what was
inconsistent and SHALL NOT emit a remediation script, because no resolution exists that is not a data
decision.

The migration SHALL NOT quarantine: it SHALL NOT import the conforming rows while setting the
offending rows aside.

#### Scenario: Colliding manifest sequence numbers are refused, with a remediation report

- **GIVEN** a source holding two `ckpt_manifests` rows with the same `(w, net, seq)` — legal in
  PostgreSQL, which has no such constraint
- **WHEN** the migration runs
- **THEN** it SHALL refuse, SHALL leave no database at the target path, and SHALL name both rows
- **AND** it SHALL emit source-side remediation statements
- **AND** it SHALL NOT choose which of the two manifests survives

#### Scenario: A corrupted sequence counter is caught by the invariant, not by the constraint

- **GIVEN** a source whose `ckpt_sequence_counters.next_seq` is below `max(seq)` for its `(w, net)` —
  the case `v1.0.0-sqlite-schema-parity/design.md` §17.3(b) shows a unique constraint alone does not
  catch, because a corrupted value landing in a pruned gap collides with nothing
- **WHEN** the migration runs
- **THEN** the `next_seq > max(seq)` check SHALL refuse it
- **AND** the diagnostic SHALL state that the store would otherwise have been silently frozen, since
  `load()` continues returning the newest manifest while new saves claim already-used sequences

#### Scenario: Quarantining the offending rows (negative control)

- **WHEN** a hypothetical migration imports the conforming rows, sets the offending ones aside and
  reports a warning
- **THEN** it SHALL produce a target that is not observationally equivalent to the source **while
  reporting success**
- **AND** there is nowhere to put the set-aside rows: the target schema has no such table and adding
  one is `v1.0.0-sqlite-schema-parity`'s DDL, which does not
- **AND** it makes the migration, rather than the consumer, the actor that dropped a wallet's
  manifest

#### Scenario: A lifecycle disagreement that has never been observable becomes a refusal

- **GIVEN** a source row whose `lifecycle` column disagrees with `entry.lifecycle.status` — possible
  today because `decodeRow` reads the object from the JSON at
  `src/postgres/transaction-history-storage.ts:243` while the column is selected at `:329`, `:358`
  and `:462` and never compared
- **WHEN** the migration runs
- **THEN** it SHALL refuse as Class 1
- **AND** the diagnostic SHALL record that this migration is the first mechanism that has ever
  compared the two representations, so the inconsistency predates the migration and is not caused by
  it

#### Scenario: Cardinality is counted distinctly, not summed

- **WHEN** the bundle records the expected junction row count
- **THEN** it SHALL record the number of **distinct** triples, not the sum of array lengths
- **AND** an importer that compared against the summed length would report a false mismatch on every
  database containing a duplicate identifier

### Requirement: stored JSON values are transported as the source's own canonical text and never through a JavaScript JSON round trip

The export SHALL emit each `jsonb` column as PostgreSQL's own text rendering of the stored value, and
the importer SHALL bind that text verbatim into the target's `TEXT` column. Neither side SHALL call
`JSON.parse` on a value it is transporting.

The migration SHALL NOT introduce a fidelity loss the source did not already have, and SHALL NOT
claim to remove one it did: a consumer reading such a value back through the adapter still parses
JSON on both engines, so a number outside IEEE-754 double range remains unreadable — the requirement
is that the *stored bytes* survive.

#### Scenario: A JavaScript exporter destroys stored numbers (negative control, measured)

- **GIVEN** a stored value whose PostgreSQL text is
  `{"fees": 12345678901234567890123, "ratio": 0.1000000000000000055511151231257827}`
- **WHEN** a hypothetical exporter reads it into JavaScript and re-serialises it
- **THEN** the transported text becomes `{"fees":1.2345678901234568e+22,"ratio":0.1}` (measured,
  `design.md` §13 E5)
- **AND** both numbers are permanently destroyed at rest, in a column (`kv_event.value`) that
  `v1.0.0-sqlite-durability-contract` requirement *"integrity coverage follows the three-class
  corruption model with an explicit column-level coverage set"* classifies as non-re-derivable
  Class-A exposure
- **AND** no row count, no digest computed after the round trip, and no point-in-time replay that
  compares parsed values detects it

#### Scenario: A byte difference that is not a fidelity difference, and the two artifacts that answer it

- **GIVEN** that PostgreSQL's `jsonb` text rendering inserts a space after `:` and `,` where
  `JSON.stringify` does not
- **WHEN** an imported value and a natively written value hold the same JSON
- **THEN** they CAN differ byte-for-byte while being the same value
- **AND** the **stored-value digest** (`dg`) SHALL be computed exactly as
  `v1.0.0-sqlite-durability-contract` requires — over the bytes SQLite stores after the import, with
  **no canonicalisation of any kind** — because a digest that normalised its input would no longer
  detect the byte-level corruption it exists to detect
- **AND** the **transport-fidelity comparison**, which is a different artifact, SHALL compare the
  source value against the imported value as **canonically parsed values**, SHALL NOT be persisted,
  and SHALL NOT be called a digest
- **AND** neither SHALL be computed by comparing a `jsonb` rendering against a `JSON.stringify`
  rendering, which would report a difference where there is none

### Requirement: timestamps are transported as an exact millisecond integer under pinned session settings

The export SHALL render every `timestamptz` as an epoch-millisecond integer **in SQL**, and SHALL run
under explicitly pinned `DateStyle`, `TimeZone`, `IntervalStyle`, `bytea_output`, `client_encoding`
and `standard_conforming_strings`, so its output does not depend on the server's or the client's
configuration. The importer SHALL bind an integer and SHALL NOT bind a string or a `Date` positionally.

The bundle SHALL record the source `server_version_num`, and the importer SHALL refuse a bundle
produced by a server version the fixture does not cover.

WHERE a source timestamp carries sub-millisecond precision — `ckpt_*.created_at` and
`watermarks.updated_at` use `now()` — the truncation to milliseconds SHALL be recorded in the bundle
manifest rather than performed silently. That precision is not caller-observable today, because the
driver returns those columns as a millisecond-quantised `Date`.

#### Scenario: An ISO string bound into an integer column breaks Law T3 silently (negative control)

- **WHEN** a hypothetical importer binds an ISO-8601 string into the epoch-millisecond `written_at`
  column
- **THEN** under a `STRICT` table the write SHALL be rejected with a datatype error, per
  `v1.0.0-sqlite-schema-parity` requirement *"every table is STRICT and a wrong-typed write is rejected, not coerced"*
- **AND** had the table not been `STRICT`, `WHERE written_at <= :t ORDER BY written_at DESC LIMIT 1`
  would return the latest row for **every** `:t`, making Law T3 false while the mechanised proof
  stayed green — the failure `v1.0.0-sqlite-schema-parity` requirement *"every table is STRICT and a wrong-typed write is rejected, not coerced"* names

#### Scenario: A known instant round-trips exactly

- **GIVEN** a fixture row whose `updated_at` is a known instant
- **WHEN** it is exported and imported
- **THEN** the target's stored integer SHALL equal that instant's epoch milliseconds **exactly**, not
  approximately
- **AND** the test SHALL assert equality rather than a tolerance, because the exactness of the export
  expression is server-version-dependent and this is the check that discharges it

### Requirement: objects belonging to the target lineage are produced by the lineage and are never imported

The importer SHALL NOT import the source's `_migrations` rows. The target's migration bookkeeping
SHALL reflect the SQLite lineage that actually ran. The importer SHALL NOT import or synthesise
`<schema>_writer_generation`, whose singleton seed row is written by
`v1.0.0-sqlite-schema-parity`'s migration `007`. Verification SHALL NOT compare either table's
cardinality against the source.

#### Scenario: Importing the source's migration rows (negative control)

- **WHEN** a hypothetical importer copies `_migrations` on the reasoning that it is "part of the
  schema"
- **THEN** the target SHALL claim to have applied migrations that do not exist in its own lineage
- **AND** `v1.0.0-sqlite-schema-parity`'s bootstrap detection SHALL then mis-decide whether the
  database is initialised, and a subsequent lineage extension SHALL either skip a migration or
  re-apply one

### Requirement: the export is a single read-only snapshot and the bundle is self-describing

The export SHALL run inside one `REPEATABLE READ READ ONLY` transaction covering every table, so all
tables describe the same instant.

The bundle SHALL carry a manifest recording at minimum: bundle format version; the UmbraDB version
that produced the export; the source `server_version_num`; the source schema name; the pinned session
settings; the set of table names present; per-table row count; per-table content digest; and the
timestamp-truncation record.

IF a table named in the manifest is absent, IF a data file's row count disagrees with the manifest,
IF a digest disagrees, or IF the bundle format version is unrecognised, THEN the importer SHALL
refuse and SHALL NOT produce a target database.

#### Scenario: Independently timed passes break cross-table consistency (negative control)

- **WHEN** a hypothetical export dumps `kv_history` and `kv_current` in two separately timed queries,
  or dumps the chunk tables and manifest tables in separate passes
- **THEN** a write landing between the two passes CAN produce a bundle in which S3 is violated for a
  key that was never inconsistent in the source, or a manifest whose chunks are absent
- **AND** `docs/CONTRACT.md:122-133` already names the checkpoint half of this hazard for `pg_dump`,
  instructing that the schema be dumped "as one consistent unit … never … in separate,
  independently-timed passes"

#### Scenario: A truncated export is detected, not imported

- **GIVEN** an export interrupted partway through writing one table's data file
- **WHEN** the importer reads the bundle
- **THEN** the row count or digest SHALL disagree with the manifest
- **AND** the importer SHALL refuse before opening a write transaction

### Requirement: verification is a ladder of five rungs whose pass is their conjunction, and it states what it assumes

Verification SHALL comprise: **V1** lineage completeness; **V2** structure — `PRAGMA integrity_check`
**and** `PRAGMA foreign_key_check`, plus `v1.0.0-sqlite-durability-contract`'s `verifyIntegrity`
reporting a pass on both of its halves; **V3** cardinality against the manifest, with the derived
arithmetic stated; **V4** content digests; **V5a** exhaustive point-in-time replay against an oracle
derived from the bundle; and **V5b**, where the source is still reachable, the same probes issued
against the source.

Verification SHALL NOT report an overall pass when any rung fails.

The migration notes SHALL state, in these terms, what a consumer who runs V1–V5a has and has not
established: they have established that the *import* was faithful to the bundle and that the target's
behaviour matches the bundle's semantics; they have **not** independently established that the
*export* faithfully rendered the source. That assumption is discharged by the builder's fixture, not
by the consumer's run. A consumer who can still reach the source SHALL be told to run V5b, which
closes it.

#### Scenario: Cardinality arithmetic is not one-to-one

- **WHEN** V3 runs
- **THEN** it SHALL check `count(kv_event) = count(kv_history) + count(kv_current)` **and**, per key,
  `count(kv_event WHERE key = K) = kv_current.version`
- **AND** it SHALL compare the junction against the distinct-triple count, exclude generated columns,
  and exclude the migration bookkeeping and writer-generation tables entirely

#### Scenario: Structural checks are blind to content, and content checks are blind to structure

- **GIVEN** that corrupting 64 bytes of a checkpointed main database yields `integrity_check → ok`,
  `quick_check → ok` and the corrupted row returned as data
  (`v1.0.0-sqlite-durability-contract/design.md` §2), and that `integrity_check` also reports
  `ok` on a database holding a dangling foreign key (measured, `design.md` §13 E4)
- **WHEN** the ladder runs
- **THEN** neither V2 nor V4 SHALL be treated as a substitute for the other
- **AND** verification SHALL be documented as detecting rather than repairing, since UmbraDB has no
  `pg_amcheck` analogue

#### Scenario: A rung reported as advisory (negative control)

- **WHEN** a hypothetical verifier reports V5 as "informational" because it is the slowest rung
- **THEN** every failure mode that no digest and no row count can see — the gap manufacture, the
  version-collision tiebreak, the reordered identifier array — SHALL become undetected
- **AND** the ladder's value collapses to the rungs that only prove rows arrived

### Requirement: point-in-time equivalence is established exhaustively over the breakpoint set

For each key, verification SHALL probe every instant in the union of the source's interval boundaries
and the target's `written_at` values; plus, for each consecutive pair of those instants more than one
millisecond apart, one instant strictly between them; plus one instant before the earliest. It SHALL
compare the source's and the target's `getAt({at: …})` at each. It SHALL likewise probe every
`{kind: "version"}` in `1 … n`, plus `0` and `n+1`, which SHALL return `null`.

This SHALL be described as **exhaustive**, not as a sample: both encodings are piecewise constant in
the query instant with a finite breakpoint set, so agreement on the breakpoints and on one interior
point of each gap is equivalent to agreement at every instant. The probe count is at most `2|B|+1` per
key and is therefore linear in the number of stored versions.

Sampling SHALL NOT be adopted by default. IF `v1.0.0-sqlite-engine-core`'s measurement gate
establishes, under its declared conditions, that exhaustive replay on a representative wallet
database exceeds a wall-clock budget recorded in the migration notes, THEN a sampling rule SHALL be
stated explicitly with its coverage fraction recorded in the verification report. WHILE that
measurement does not exist, exhaustive replay SHALL be the specified behaviour.

#### Scenario: Boundary instants are probed on both sides of the boundary

- **GIVEN** a key with versions written at 1000, 2000 and 3000
- **WHEN** the replay runs
- **THEN** it SHALL probe at least 999, 1000, 1001, 2000, 2001, 3000 and 3001
- **AND** at 2000 both SHALL return version 2, because the source's interval is half-open `[)` and the
  target selects the last event at or before the instant

#### Scenario: Sampling a thousand random instants (negative control)

- **WHEN** a hypothetical verifier probes a thousand uniformly random instants per key instead
- **THEN** it CAN run faster on a large database
- **AND** it SHALL be overwhelmingly likely to miss a one-millisecond discrepancy at a single
  boundary, which is exactly the shape a version-ordering or truncation defect produces
- **AND** it costs nothing to avoid, because the exhaustive probe set is linear in the number of
  versions — the same order as the import that produced them

### Requirement: a check with nothing in scope reports n/a and never pass, and the fixtures are proven non-empty

WHEN a verification rung, or any check within a rung, has **no rows in scope**, it SHALL report
`n/a — no rows in scope` and SHALL NOT report `pass`. An overall pass SHALL NOT be reported when any
constituent check reported `n/a` unless the report also records, per rung, that the empty scope was
expected for that database.

This follows the pattern `v1.0.0-sqlite-durability-contract` established for its own zero-row
checks: a check that asserts nothing has not succeeded, and recording it as success is how a
verification suite comes to certify a database it never examined.

The migration's fixtures SHALL be proven non-empty before their results are admissible. Each fixture
SHALL carry a checked-in inventory of the cases it contains, and the test suite SHALL assert both
that the inventory is satisfied and that every rung of the ladder had rows in scope when it ran
against Fixture A. A fixture that silently shrinks — through a seeding failure, a truncated import,
or an edit — SHALL fail the suite rather than produce a smaller green run.

#### Scenario: A zero-row migration does not report success

- **GIVEN** a bundle that contains a manifest and correctly-formed but empty data files
- **WHEN** the import and the full ladder run
- **THEN** every content, cardinality and replay check SHALL report `n/a — no rows in scope`
- **AND** the overall outcome SHALL NOT be reported as `pass`
- **AND** the report SHALL state that no rows were examined, so an operator cannot read the run as
  evidence that their data migrated

#### Scenario: An empty fixture cannot produce a green suite (negative control)

- **WHEN** a seeding defect leaves Fixture A with zero keys, zero manifests and zero transactions
- **THEN** a verifier that reports `pass` for each vacuously-satisfied check SHALL report an overall
  pass having verified nothing at all
- **AND** the fixture-inventory assertion SHALL fail instead, which is the only mechanism in this
  capability that distinguishes "everything checked out" from "there was nothing to check"

#### Scenario: A rung with legitimately empty scope is recorded, not hidden

- **GIVEN** a real consumer database that has never written a transaction-history row
- **WHEN** the transaction-history rungs run
- **THEN** they SHALL report `n/a — no rows in scope` for that tier
- **AND** the overall outcome CAN still be a pass, because the empty scope is a true fact about that
  database
- **AND** the report SHALL name every rung that reported `n/a`, so the difference between this case
  and the previous one is visible to a reader rather than inferred

### Requirement: migration-tool failures are tool diagnostics with a stable exit code and a machine-readable report

`v1.0.0-sqlite-durability-contract` requirement *"failures of a process outside the frozen surface are
tool diagnostics, not catalog entries"* rules the membership question and states that the exit codes,
report schema and operator-facing presentation belong to the changes that own the tools. This
requirement is that specification for the migration tool.

Every failure of the export, import or verify step SHALL be reported as a tool diagnostic following
the one error idiom of `design/design-interfaces.md` §1.1. It SHALL NOT add an entry to
`docs/ERROR-CATALOG.md`, SHALL NOT be a `StorageError` subclass, and SHALL NOT be re-pointed at an
existing catalog code.

The tool SHALL exit with a stable, documented, machine-readable exit code, distinct per failure
class, so a consumer scripting the migration can branch without parsing a message string — the same
reason `docs/ERROR-CATALOG.md` gives for the frozen `code` field existing at all. The classes SHALL
be distinguishable at minimum as: success; a bundle-integrity refusal; a Class 1 refusal; a Class 2
refusal; a verification failure after a completed import; and an unexpected internal fault. Exit code
`0` SHALL mean a completed, fully verified migration and nothing else.

The tool SHALL additionally write a **structured report file** whose schema is versioned and
documented, containing at minimum: the tool and bundle format versions; the outcome class; for a
refusal, the class and every offending row with its identifying key; for a Class 2 refusal, the
remediation statements; per-rung verification outcomes including any rung reported `n/a`; and the
identity of the source bundle and target path. A consumer SHALL be able to determine the outcome from
the report file alone, without the terminal output.

Codes SHALL NOT be assigned to a failure class this capability has not defined, and the report schema
SHALL NOT carry a field whose only purpose is to mirror a catalog code.

#### Scenario: A scripted migration branches without parsing text

- **WHEN** a consumer runs the migration from a shell script
- **THEN** a bundle-integrity refusal, a Class 1 refusal and a Class 2 refusal SHALL each produce a
  different, documented exit code
- **AND** the script SHALL be able to distinguish "the source needs remediation before this can
  proceed" from "the source cannot be migrated at all" without reading the message

#### Scenario: A tool failure does not reach the frozen catalog (negative control)

- **WHEN** a hypothetical implementation raises a migration refusal as a `StorageError` subclass so
  that callers can catch it uniformly
- **THEN** it SHALL have added a member to the frozen error surface for a process that is not the
  library
- **AND** it SHALL be rejected: the catalog covers errors thrown through the library's frozen public
  surface, and the migration tool is outside it by construction

#### Scenario: Exit code zero means verified, not merely finished

- **WHEN** an import completes but a verification rung fails
- **THEN** the tool SHALL NOT exit `0`
- **AND** the target database SHALL NOT have been published to the live path

### Requirement: the stored-value digest and the transport-fidelity comparison are two distinct artifacts and are never conflated

Migration verification involves exactly two integrity artifacts. They answer different questions,
have different inputs, and only one of them is a digest. The specification SHALL name both and SHALL
NOT describe either in the other's terms.

**Artifact 1 — the stored-value digest (`dg`).** Owned and defined by
`v1.0.0-sqlite-durability-contract`; the column is `v1.0.0-sqlite-schema-parity`'s migration
`009_value_digests` over `kv_event.value`, `watermarks.value` and `transaction_history.entry`. Its
preimage is **the exact bytes SQLite stores after the import**, with **no canonicalisation, no
normalisation and no re-serialisation of any kind**. It is **persisted** in the target database and
re-verified on every read for the life of the database. The importer computes it as it writes,
because that change requires it computed and written in the same statement as the value. This
capability consumes that definition and SHALL NOT restate, vary or extend it.

**Artifact 2 — the transport-fidelity comparison.** Owned by this capability. It answers "did this
value survive the trip from PostgreSQL to SQLite", which is a question about **transport**, not about
storage integrity. Its inputs are the source value and the imported value compared as **canonically
parsed values**, so that a difference in JSON text rendering — PostgreSQL's `jsonb` puts a space
after `:` and `,` where `JSON.stringify` does not — is correctly not reported as a difference. It is
**not persisted**, exists only for the duration of a verification run, and SHALL NOT be called a
digest, stored in a column, or compared against `dg`.

Because artifact 2 is a transport check rather than a digest mechanism, specifying it does **not**
introduce a second integrity mechanism, and the prohibition below is not violated by it.

The V-ladder's table-level content rung folds **artifact 1** where a row is covered by it. WHERE a
row is outside that coverage set, the per-row input SHALL be the row's existing content address where
it has one — `ckpt_chunks.hash` and `ckpt_manifests.manifest_hash` are already SHA-256 over the
covered bytes — and a defined serialisation otherwise.

#### Scenario: The digest is not canonicalised and the transport check is

- **WHEN** the two artifacts are computed for the same imported row
- **THEN** `dg`'s preimage SHALL be the stored bytes exactly, with no normalisation applied
- **AND** the transport-fidelity comparison SHALL operate on parsed values
- **AND** no specification sentence SHALL describe one artifact as being computed *both* over the
  stored bytes *and* through a canonicalisation, because that describes an object that cannot exist:
  canonicalising the input means the preimage is no longer the stored bytes

#### Scenario: A canonicalising digest stops detecting what it exists to detect (negative control)

- **WHEN** a hypothetical implementation normalises JSON before computing `dg`
- **THEN** two byte-sequences differing only in whitespace SHALL produce the same digest
- **AND** a corruption that altered only bytes the normaliser discards SHALL become undetectable,
  which is the entire failure mode the value digest was introduced to close
- **AND** the digest would also disagree with every digest computed by the adapter on the read path,
  making every covered row fail verification or, worse, requiring the read path to canonicalise too

### Requirement: content verification reuses the durability contract's digest regime and introduces no second mechanism

The `dg` column SHALL be computed at import and SHALL NOT be transported: PostgreSQL has no such
column. It SHALL be excluded from cardinality comparison and from the source side of the fold, as
generated columns are. IF a covered row's `dg` is `NULL` after import, THEN that is an import defect
and verification SHALL fail, notwithstanding that
`v1.0.0-sqlite-durability-contract`'s `NULL`-means-not-yet-computed semantics permit it in general —
the importer held the value and had no reason to skip it.

This capability SHALL NOT choose a digest algorithm, SHALL NOT add a digest column, SHALL NOT extend
or duplicate that coverage set, and SHALL NOT add an error code. A migration digest mismatch is a
tool diagnostic and a non-zero exit; it SHALL NOT be reported as `VALUE_INTEGRITY`, which
`v1.0.0-sqlite-durability-contract` requirement *"every covered column is verified on every read, with no opt-out"* reserves for a read-path mismatch, and which
`:403-420` forbids re-pointing at a different situation.

The table-level digest SHALL be order-defined, with the source ordered by `COLLATE "C"` on every
text-keyed column and the target by its default `BINARY` collation, so the two orders agree.

#### Scenario: The digest is comparable across two different default collations

- **GIVEN** that PostgreSQL orders `text` by the database's `lc_collate`, commonly not code-point
  order, while SQLite's default is `BINARY`, which is code-point order (measured, `design.md` §13 E6)
- **WHEN** the export orders by `COLLATE "C"`
- **THEN** the two sides SHALL enumerate rows in the same order
- **AND** the digest SHALL commit to the multiset of rows and SHALL NOT be read as committing to the
  order a consumer will observe from `listKeys`

#### Scenario: A second digest scheme (negative control)

- **WHEN** a hypothetical migration defines its own hash and its own coverage set for verification
- **THEN** two integrity mechanisms SHALL exist over the same tier, and a future change to the
  durability contract's algorithm SHALL silently desynchronise them
- **AND** `v1.0.0-sqlite-durability-contract` requirement *"integrity coverage follows the three-class corruption model with an explicit column-level coverage set"* already forbids the analogous case for
  the checkpoint tier — one mechanism per tier, distinguishable by `code` alone

### Requirement: an interrupted migration never leaves a database that presents itself as complete

The importer SHALL write to a distinct in-progress path, SHALL run the full verification ladder
against it, SHALL checkpoint and close the handle, and only then SHALL rename it to the live target
path. A file at the live target path SHALL therefore be either absent or fully verified.

IF the import fails or is interrupted, THEN the in-progress file and its sidecars SHALL be removed,
and the tool SHALL exit non-zero.

The rename SHALL follow the checkpoint-and-close, because the write-ahead-log sidecars follow the
filename and a database renamed without them silently reverts to an arbitrarily older state while
reporting a healthy integrity check.

#### Scenario: A crash mid-import leaves nothing at the target path

- **GIVEN** an import killed partway through
- **WHEN** the target path is inspected
- **THEN** no database SHALL exist there
- **AND** the source SHALL be unchanged, so the recovery is to re-run

#### Scenario: Importing directly into the live path (negative control)

- **WHEN** a hypothetical importer writes straight to the path the application will open
- **THEN** a crash SHALL leave a structurally valid, fully migrated, partially populated database
- **AND** the application SHALL start against it, `PRAGMA integrity_check` SHALL report `ok`, and the
  wallet SHALL appear to have lost an arbitrary subset of its state with no error anywhere

### Requirement: re-running the migration is safe, and resumability is decided by measurement rather than assumed

Re-running the import against the same bundle SHALL produce the same target database. The importer
SHALL NOT consult the wall clock for any imported value, SHALL NOT depend on the target's prior
contents, and SHALL create the target fresh on every run.

Resumption of a partially completed import SHALL NOT be promised unconditionally. Let **D** be the
wall-clock duration of a complete import of a representative wallet database, measured under
`v1.0.0-sqlite-engine-core`'s declared gate conditions on a non-memory-backed filesystem, at the
shipped `journal_mode` and `synchronous`, with dataset size relative to host page cache recorded.
**IF D is within the re-run budget recorded in the migration notes, THEN** re-running from a fresh
target SHALL be the supported recovery and no resume protocol ships. **IF D exceeds it, THEN** a
resume protocol SHALL ship, and it SHALL be per-table-and-position checkpointing over the bundle's
canonical order, never a heuristic that inspects the target to guess what is already there.
**WHILE D is unmeasured**, neither branch SHALL be taken and no implementation task depending on the
choice SHALL start.

#### Scenario: Two runs of the same bundle produce identical databases

- **WHEN** the same bundle is imported twice into two target paths
- **THEN** every table's content digest SHALL match between the two targets
- **AND** the only permitted difference SHALL be in file-level artifacts that carry no row content

#### Scenario: A resume that inspects the target to decide what to skip (negative control)

- **WHEN** a hypothetical resume protocol reads the partially imported target and skips keys it finds
  there
- **THEN** a key interrupted mid-chain SHALL be skipped with only part of its versions present
- **AND** every subsequent check passes for that key in isolation, while its history is silently
  truncated — which is why the specified protocol, if it ships at all, is positional over the bundle

### Requirement: the import does not weaken any check in order to go faster

The importer SHALL NOT lower `synchronous`, SHALL NOT set `foreign_keys` to `OFF`, SHALL NOT set
`PRAGMA ignore_check_constraints`, and SHALL NOT drop, disable or defer any trigger, index or `CHECK`
constraint created by the target lineage.

The importer's SQL SHALL be inside the scope of `v1.0.0-sqlite-temporal-event-log`'s automated ban on
`INSERT OR REPLACE` and `REPLACE INTO`, and its inserts SHALL be plain `INSERT`.

The import SHALL run in bounded transactions rather than one whole-file transaction, and the batch
bound SHALL be a row count rather than a byte count. The batch size SHALL NOT be fixed by this
capability; it is blocked on the engine-core measurement gate.

**The write-lock premise this capability inherits, and its precondition (row E-10 of
`v1.0.0-sqlite-concurrency-lease`'s §2.6.2 inheritance table).** The negative control below reasons
from "a whole-file import transaction holds the whole-database write lock for the import's
duration." That premise is **conditional on the descriptor precondition** of
`v1.0.0-sqlite-concurrency-lease` requirement *"no UmbraDB code opens and closes a descriptor on the
database file or its sidecars"*: closing any descriptor on the inode drops the process's POSIX record
locks on it, and under WAL the locks live on the `-shm` sidecar.

IF that precondition is violated — by UmbraDB code, by the migration tool, or by the embedding
application — THEN the write-lock premise is **absent, not weakened**. The distinction is the whole
point and SHALL be stated in those terms: an in-process open-and-close of a lock-bearing descriptor
does not degrade exclusion to a lower level of assurance, it voids it, after which two processes can
each believe they hold the lock. In that state the negative control's stated consequence does not
follow and the long-held-transaction diagnostic it relies on may never fire.

This capability SHALL NOT claim exclusivity from `BEGIN IMMEDIATE` alone. `BEGIN IMMEDIATE`
serializes **transactions**; it does not make a process a single writer, so two importer instances
would interleave transactions perfectly legally. Import exclusivity SHALL therefore rest on the
writer-generation guard and the descriptor precondition together, never on transaction serialization,
and no requirement in this capability SHALL be phrased as resting on transaction serialization
presented as process-level exclusivity — the formulation change 3's E-8/E-9 note refutes.

#### Scenario: The import's exclusivity premise is void, not degraded, if a descriptor is cycled

- **GIVEN** an import relying on the whole-database write lock
- **WHEN** any code in the importing process opens and closes a descriptor on the target database
  file or its `-wal` / `-shm` sidecars
- **THEN** the process's POSIX record locks on that inode SHALL be dropped
- **AND** the exclusivity premise SHALL be reported as **absent**, not as weakened or best-effort
- **AND** a second importer or a running application CAN then hold what both believe is the write
  lock, so the import's atomicity argument does not hold and must not be relied on

#### Scenario: Bulk-load tuning is a durability-probe refusal, not a knob

- **WHEN** an operator asks for a faster import
- **THEN** `synchronous = OFF` and `foreign_keys` not `ON` SHALL both be refused, because both are
  hard refusals of the durability probe with no override
- **AND** `PRAGMA ignore_check_constraints` SHALL be refused for a second reason: it disables `CHECK`
  constraints but **not** triggers, so it would disable half the target's protections and leave the
  other half firing

#### Scenario: A single whole-file transaction (negative control)

- **WHEN** a hypothetical importer wraps the entire import in one transaction for atomicity
- **THEN** it SHALL hold a whole-database write lock for the whole import and trip the long-held
  transaction diagnostic `v1.0.0-sqlite-durability-contract` requirement *"the unbounded transaction hold is documented as unbounded and instrumented rather than claimed to be bounded"* requires
- **AND** the atomicity it buys is already provided more cheaply by the in-progress-path-and-rename
  rule, which also survives a process kill that a transaction does not

### Requirement: the supported rollback is the untouched source database and no reverse migration is offered

The migration notes SHALL state that the supported rollback is to continue running the `0.9.5` git
tag against the source PostgreSQL database, which the migration has not modified, and SHALL state
that this satisfies `docs/STABILITY.md:40-42`'s guidance to hold a backup before a major upgrade
without the consumer having to take one.

The notes SHALL state that migration is required to run 1.0.0 — there is no dual-backend mode and no
PostgreSQL backend at 1.0.0 — and that the transition window is the continued availability of the
`0.9.5` tag rather than a period in which both engines are supported.

A SQLite→PostgreSQL reverse migration SHALL NOT be offered. The notes SHALL state the reason: at
1.0.0 there is no PostgreSQL adapter to migrate into, so such a path would have no consumer and no
test surface.

#### Scenario: The rollback requires no restore step

- **GIVEN** a consumer who has migrated and then decides to revert
- **WHEN** they follow the documented rollback
- **THEN** they SHALL revert their dependency to the `0.9.5` tag and point it at the same
  `connectionString` they used before
- **AND** no restore, no replay and no reconstruction SHALL be required, because the source was never
  written to

#### Scenario: The engine change is a forward migration under the published policy

- **WHEN** the release record explains why a required migration at 1.0.0 is not a policy violation
- **THEN** it SHALL cite `docs/STABILITY.md:34-36`, which already permits a major to require a
  forward-only migration before it will operate against an existing database
- **AND** it SHALL record that this is the one item in the program whose cost the pre-tag window does
  not reduce, because a consumer's obligation to move a database is an operations cost and not a
  SemVer cost

### Requirement: each distribution channel has a written procedure and the container channel's hazards are named

The migration notes SHALL contain one procedure per distribution channel — git tag, repository clone,
and container image — each stating the ordering of quiesce, export, upgrade, import, verify and
restart.

For the container channel the notes SHALL additionally state: that the export runs **before** the
PostgreSQL service is removed from the image or its volume detached; that the SQLite database must
live on a volume and not on the container's writable layer; that the durability probe **refuses
outright** on `tmpfs`, `ramfs`, `nfs`, `cifs`/`smb`, `v9fs` and un-allowlisted `fuse`, which a
container can plausibly supply, and that such a refusal is expected behaviour rather than a defect;
and that the entrypoint must not run `runMigrations` against a fresh database file before the import
has produced one.

The notes SHALL state that UmbraDB builds and publishes no container image, so the procedure is
addressed to whoever builds the image. WHERE PostgreSQL is bundled inside the same image as the
application rather than running as a sidecar, the export must run from a container built from the
**old** image; this case SHALL be recorded as an open question owned by the repo owner until the
image inventory is known.

#### Scenario: An upgrade that rebuilds the image first (negative control)

- **WHEN** an operator rebuilds their image on the new UmbraDB version, removing the bundled
  PostgreSQL because it is no longer a dependency, and then starts it
- **THEN** the source database SHALL be gone before the export ever ran
- **AND** if the entrypoint also runs `runMigrations`, a valid, empty, fully migrated SQLite database
  SHALL be created and the wallet SHALL appear to have lost everything, with no error raised anywhere

#### Scenario: A volume on a refused filesystem fails loudly at migration time

- **GIVEN** a container whose data volume is a `tmpfs` mount or a bind mount from a network share
- **WHEN** `runMigrations` runs against a database file on it
- **THEN** the durability probe SHALL refuse, based on the reported filesystem type
- **AND** the notes SHALL have said so in advance, so the refusal is read as the contract working
  rather than as a migration bug

### Requirement: differences that survive a faithful migration are disclosed before the migration runs

The migration notes SHALL enumerate every consumer-observable difference that a *correct* migration
still produces, and SHALL be published for a consumer to read **before** running the migration.

At minimum, two items.

1. The one-time `listKeys` ordering change from the PostgreSQL database's collation to code-point
   order, with the instruction to discard any persisted `listKeys` resume cursor across the
   migration.
2. The `lifecycle` agreement fault. Under invariant **I-7** a `lifecycle` column that disagrees with
   `entry.lifecycle.status` becomes a detected, non-retryable fault on read, where today it is
   invisible because `decodeRow` never compares them. The notes SHALL state that the value previously
   returned was the JSON's, which is the representation I-7 keeps, so no value changes — what changes
   is that a pre-existing disagreement becomes loud. They SHALL also state that the migration refuses
   such a source up front, so the fault should never first appear in production.

The notes SHALL NOT list the `identifiers` array as a difference: under I-7 the returned array
derives from `entry`, which is transported verbatim, so it is unchanged.

The notes SHALL frame both items as consequences of invariants that make the store stricter, not as
regressions.

The verifier SHALL assert the target's `listKeys` order is code-point order, so the disclosure is a
falsifiable statement rather than a promise.

#### Scenario: A resume cursor spans the migration boundary

- **GIVEN** a consumer that persisted a `listKeys` resume position under a PostgreSQL locale
  collation
- **WHEN** it resumes against the migrated database
- **THEN** it MAY skip or repeat keys exactly once, at the boundary — the hazard
  `v1.0.0-sqlite-schema-parity` requirement *"listKeys ordering is code-point order and the one-time resume-cursor reorder is disclosed"* requires be *"stated in the migration notes rather
  than discovered"*
- **AND** these notes are those notes

#### Scenario: The key set is compared as a set, not as a sequence

- **WHEN** verification compares `listKeys` output between source and target
- **THEN** it SHALL compare the key **sets** for equality, and SHALL separately assert the target's
  ordering
- **AND** a verifier that compared the sequences would report a failure on every correctly migrated
  database whose keys are not already in code-point order

### Requirement: no migration duration or throughput figure is asserted, and every PostgreSQL-side claim is labelled

No requirement, design statement, task or acceptance criterion in this capability SHALL cite a
migration duration, throughput, row rate or latency as a fact. Where a decision depends on one, it
SHALL be written as a rule against `v1.0.0-sqlite-engine-core`'s measurement gate, with the gate's
declared conditions attached.

Every statement this capability makes about PostgreSQL behaviour SHALL be labelled as read from this
repository's code at a cited `file:line`, or as an inference from it. No such statement SHALL be
presented as measured: no PostgreSQL server was run for this capability, and there is none on the
authoring machine.

Any measurement this capability does perform SHALL use a database file on a real, non-memory-backed
filesystem, and SHALL record the binding it was taken through together with the obligation to
re-confirm it on the binding `v1.0.0-sqlite-engine-core` ruled.

#### Scenario: A reviewer sweeps the capability for unconditioned numbers

- **WHEN** a reviewer greps this capability's four documents and its spec for throughput, duration
  and rate claims
- **THEN** every hit SHALL be either inside a decision rule that names the measurement gate, or
  inside the evidence section with its command and its conditions
- **AND** no hit SHALL be a bare figure in a requirement

#### Scenario: Research-phase figures are inadmissible here (negative control)

- **GIVEN** that six of seven research lanes benchmarked against a tmpfs RAM disk, and that
  re-measurement on ext4 moved WAL `synchronous=FULL` from 88,485 commits/s to 379
- **WHEN** any import-sizing or replay-cost decision is proposed
- **THEN** no research-phase figure SHALL be admissible evidence for it
- **AND** the decision SHALL remain open until the gate reports the corresponding cell under declared
  conditions
