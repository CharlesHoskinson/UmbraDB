# temporal-kv (SQLite event-log redesign)

TemporalKV's storage representation moves from a current-table + trigger-populated interval-history
table (`design/design.md` §2) to an **event log** whose validity intervals are derived with a
`LEAD()` window function — `Formal/Lean/UmbraDBFormal/TemporalKV/Model.lean:57-62`'s
`validityIntervals` compiled to SQL. Requirements below follow EARS, as in Sprint 4's and Sprint 7's
spec files.

This is the only change in the SQLite migration program that deltas a **merged** spec
(`openspec/specs/temporal-kv/spec.md`). `## MODIFIED Requirements` headers below match that file's
headers **byte-for-byte**, including their now-inaccurate Postgres naming, because OpenSpec resolves
a modification by header text; renaming them is a separate, deliberate act deferred to
`v1.0.0-sqlite-durability-contract` (which owns naming). Two merged requirements are deliberately
**not** deltaed here — *"Migrations are idempotent and ordered"* and *"Schema isolation is the
default, not opt-in"* — because `v1.0.0-sqlite-schema-parity` owns their subject matter; see
`design.md` §0.3 for the seam and the recommended resolution.

Performance-shaped claims are written as obligations to *establish* a number under stated conditions,
never as assertions of one (`design.md` §12).

## ADDED Requirements

### Requirement: the event log is the only stored temporal representation and validity intervals are derived, never stored

The store SHALL persist one row per accepted `put` — `(ns, scope, key, version, value, written_at)` —
and SHALL NOT persist any interval boundary column. `[valid_from, valid_to)` SHALL be derived, with
`valid_from` equal to that version's own `written_at` and `valid_to` equal to the next version's
`written_at` for the same `(ns, scope, key)` (SQL `NULL` for the live tail), computed by a `LEAD()`
window function partitioned by `(ns, scope, key)` and ordered by `version`.

This supersedes `design/design.md` §2's `kv_current` + `kv_history` pair and
`Formal/STORAGE_ALGEBRA.md` §1's description of T5 as ranging over "the set of `[valid_from,
valid_to)` intervals in `kv_history` (plus the live `kv_current` row)". The derived projection is
`Model.lean:57-62`'s `validityIntervals`, and the stored table is `Model.lean:42`'s `History`.

#### Scenario: A three-version key's derived intervals are contiguous and half-open
- **WHEN** a key is written three times, producing events at `written_at` 100, 200 and 300
- **THEN** the derived intervals SHALL be exactly `[100,200)`, `[200,300)` and `[300, NULL)`
- **AND** the derivation SHALL read the boundary `200` from version 2's own stored `written_at`, not
  from any value stored on version 1's row

#### Scenario: No interval boundary is writable
- **WHEN** the stored schema for the event log is inspected
- **THEN** it SHALL contain no `valid_to` column, no stored range/`validity` column, and no column
  whose value is an upper bound of another row's interval
- **AND** a write that attempts to set an interval upper bound SHALL fail because no such column
  exists, not because a constraint rejected it

#### Scenario: The live version has an open upper bound, not a sentinel
- **WHEN** the newest version of a key is projected
- **THEN** its `valid_to` SHALL be `NULL`
- **AND** the projection SHALL NOT substitute a far-future sentinel timestamp, which would make the
  live row indistinguishable from a bounded row whose successor was lost

### Requirement: gap-freedom is structural — a gap in a key's validity chain is unrepresentable

Gap-freedom (Law T5(2)) SHALL hold structurally under the derived-interval encoding: for consecutive
versions of one key, the earlier interval's `valid_to` and the later interval's `valid_from` SHALL be
the *same stored value read twice*, so no assignment of values to the event log's columns denotes a
discontiguous chain.

This is a **strengthening** of a frozen commitment inside the 1.0.0 Lean cut-line `{T3, T5, W1, C1}`.
`Formal/STORAGE_ALGEBRA.md:227-231` records T5(2)'s status today as **CALLER-ENFORCED** — it "holds
only as long as the trigger remains the sole writer of `valid_from` … a manual `INSERT` bypassing the
trigger could violate it and no constraint would catch that" — and the status table at `:333` says
the same. Under this encoding the status becomes **structural**, and
`Formal/STORAGE_ALGEBRA.md:218-231` plus the `:333` row SHALL be rewritten to say so, with the label
re-derived rather than carried over. The formal counterpart is
`Formal/Lean/UmbraDBFormal/TemporalKV/Laws.lean:283` `adjacent_intervals_gap_free`, which is proved
by structural induction with no hypothesis — gap-freedom does not even depend on `WellFormed`.

**The boundary of this guarantee, stated here so it is never read as more than it is.**
"Structural" is a claim about the **encoding**, and it holds for every history written through this
adapter. It is *not* a claim that a data path filling the event log preserves the semantics of
whatever it read from — and because PostgreSQL's `EXCLUDE` constraint permits gaps, an encoding that
cannot represent one also cannot faithfully carry a source that has one. That consequence is
specified in full by *"the structural gap-freedom guarantee is a property of the encoding, so
converting a gap-bearing history into it is not information-preserving"* below. Nothing there weakens
anything here: this requirement governs what the store guarantees about data written through it, that
one governs what may be imported into it.

#### Scenario: A deliberately non-contiguous write cannot produce a gap
- **WHEN** an actor with direct SQL access attempts to create a gap for one key — for example by
  inserting a version whose intended validity begins later than the previous version's intended end
- **THEN** the derived `valid_to` of the previous version SHALL still equal the derived `valid_from`
  of the inserted version, because both are the inserted version's `written_at`
- **AND** no gap SHALL be observable in the projection regardless of what values were written

#### Scenario: Deleting a middle version cannot open a gap in the projection
- **WHEN** a middle version of a key is removed from the event log (bypassing the append-only
  assertion, e.g. after that trigger is dropped)
- **THEN** the derived intervals SHALL re-link across the removal and remain contiguous
- **AND** the resulting damage SHALL surface as a Law T1 version-chain gap — `getAt({version: v})`
  returning `null` for a version that really existed — not as a T5(2) violation

#### Scenario: The interval-table design accepts a gap (negative control, hypothetical implementation)
- **GIVEN** a hypothetical SQLite implementation that stores `[valid_from, valid_to)` columns and
  enforces non-overlap with a `BEFORE INSERT`/`BEFORE UPDATE` trigger
- **WHEN** an interval `[400,500)` is inserted for a key whose previous interval was `[200,300)`
- **THEN** that hypothetical implementation SHALL accept it — the overlap trigger has nothing to say
  about gaps — and a `DELETE` of a middle interval row would likewise open a gap with no trigger
  objecting
- **AND** this is precisely the CALLER-ENFORCED weakness `Formal/STORAGE_ALGEBRA.md:227-231` records
  today; the positive scenarios above are what verify the shipped design does not exhibit it

#### Scenario: A reviewer can audit the strengthening from the register alone
- **WHEN** the refinement register row for T5 is read after this change
- **THEN** it SHALL name the struck mechanism (`EXCLUDE USING gist`, and "trigger remains sole writer
  of the boundary columns") and the new one (derived intervals over an append-only event log)
- **AND** the status label SHALL be re-derived — T5(1) `MECHANISM SPECIFIED` → structural, T5(2)
  `CALLER-ENFORCED` → structural — not copied forward
- **AND** the register's `T5(2)-refinement` (b)-hypothesis
  (`openspec/changes/v1.1.0-formal-completion/design.md`, section "Refinement register & three statuses") SHALL be **removed**, not softened,
  because it is discharged structurally rather than assumed
- **AND** the row SHALL carry a replacement voiding precondition — a second writer process, a network
  filesystem, a `-shm` on a filesystem without working shared memory, or shared-cache mode with
  `read_uncommitted` — in place of the retired "a transaction pooler"

### Requirement: the structural gap-freedom guarantee is a property of the encoding, so converting a gap-bearing history into it is not information-preserving

Gap-freedom is structural because the encoding has no degree of freedom in which a gap could be
written. **That same fact is a limit on what the encoding can faithfully carry.** An encoding that
cannot represent a gap cannot represent a source history that has one, so any data path that converts
an existing `kv_history`/`kv_current` pair into the event log SHALL be treated as
information-preserving **only** for source histories that are already gap-free, and SHALL be
specified, implemented and reviewed as a **lossy transformation** otherwise.

A gap-bearing source is legal, not hypothetical. `kv_history_no_overlap`
(`src/postgres/migrations/001_temporal_kv.ts:97-99`) is an `EXCLUDE` constraint: it forbids
**overlap** and, in `Formal/STORAGE_ALGEBRA.md:218-231`'s own words, *"says nothing about gaps"* —
which is exactly why T5(2)'s status there is **CALLER-ENFORCED** and why
`src/postgres/temporal-kv.ts:230-241` already names *"a manual/backfill `kv_history` row"* as the
scenario its `UNION`/`priority` tiebreak exists to make deterministic. Nothing in the source schema
rejects a hole.

**The worked example, which this requirement exists to make unmissable.** A source key holds
`[1000, 2000)` at version 1 and a live row from `3000`. Both rows satisfy every source constraint. A
point-in-time read at `2500` correctly returns **`null`** — the key genuinely had no value then.
Convert those two rows to events at `written_at` 1000 and 3000 and derive intervals with `LEAD()`,
and the intervals become `[1000, 3000)` and `[3000, NULL)`. The same read now returns **version 1**.
The conversion has **invented coverage that never existed**, and it has done so while every check
this change specifies passes: the version chain is consecutive, `written_at` strictly increases, the
unique time index is satisfied, the derived intervals are non-overlapping and gap-free, the row count
matches, and a per-row digest of every stored value matches.

The reduction is a single property. Where the source satisfies `valid_to(v) = valid_from(v+1)` for
every consecutive pair, `valid_to` is redundant and the conversion loses nothing; where it does not,
`valid_to` carried information the event log has nowhere to put. **The import-side verification of
that property, per key, belongs to `v1.0.0-sqlite-data-migration` and is cited here, not specified**
— that change has ruled the reconstruction's correctness reduces to it, and verifies it rather than
inheriting it from this adapter's triggers, which enforce it only for data this adapter itself wrote.

#### Scenario: A gap-bearing source history is refused, not silently converted
- **WHEN** a conversion encounters a source key whose consecutive versions do not satisfy
  `valid_to(v) = valid_from(v+1)` — for example `[1000, 2000)` followed by a live row at `3000`
- **THEN** the conversion SHALL fail or report that key as unconvertible
- **AND** it SHALL NOT silently produce an event log whose point-in-time reads answer differently
  from the source's

#### Scenario: Structural checks alone do not detect the loss (negative control)
- **GIVEN** a conversion of that same gap-bearing key which is validated only by row counts, per-row
  value digests, and the assertions this change specifies
- **WHEN** every one of those checks is run against the converted store
- **THEN** all of them SHALL pass
- **AND** `getAt({at: 2500})` SHALL nevertheless have changed from `null` to version 1 — which is why
  this requirement exists and why the conversion's correctness cannot be delegated to this change's
  triggers

#### Scenario: A gap-free source converts faithfully
- **WHEN** a source key's consecutive versions satisfy `valid_to(v) = valid_from(v+1)` throughout —
  the shape this adapter's own trigger discipline produces
- **THEN** the conversion SHALL be information-preserving for that key, and every point-in-time read
  SHALL return what it returned before
- **AND** the guarantee that gap-freedom is structural going forward SHALL be unaffected by anything
  in this requirement — the limit is on what may be imported, never on what the encoding guarantees
  about data written through it

#### Scenario: A JavaScript round trip is not a valid fidelity oracle (negative control)
- **GIVEN** a fidelity check that compares source and converted values by `JSON.parse`, or that
  transports values through a JS value rather than through the stored text
- **WHEN** a stored value is the integer literal `12345678901234567890123` or the number
  `0.1000000000000000055511151231257827`
- **THEN** the round trip SHALL alter them — to `1.2345678901234568e+22` and `0.1` respectively —
  so the check both corrupts the data and destroys its own evidence
- **AND** `0.1000000000000000055511151231257827` and `0.1` SHALL compare **equal** after parsing
  though their stored texts differ, so such an oracle can report success on values it has already
  destroyed
- **AND** any equivalence claim across a conversion SHALL therefore be evaluated on the stored text,
  never on a parsed JS value — the transport itself is
  `v1.0.0-sqlite-data-migration`'s and is cited, not specified here

### Requirement: getAt asserts the `at` bound through the primary-key index, not only through the index it searched

**Class B invariant I-3.** The `{at}` read path seeks through the time index
`(ns, scope, key, written_at)`. Before returning a row, the adapter SHALL re-read the candidate
version **by primary key** — `(ns, scope, key, version)`, a different b-tree — and SHALL assert both
halves of "last event at or before `T`" against that re-read:

1. the candidate's `written_at` is `<= T`; and
2. the candidate's successor version either does not exist, or has `written_at > T`.

IF either assertion fails THEN `getAt` SHALL raise a typed error and SHALL NOT return a row. A failed
assertion means the two b-trees disagree about the same fact, and a store in that state cannot answer
the query.

**Why a digest cannot substitute for this.** An application-level digest covers the stored value **in
the table row**. An index entry is an independent copy of the key columns. If the index copy is
damaged while the table row is intact, the digest verifies clean, the row's contents are entirely
valid, and the query still returns the wrong row — Class B, not Class A. `PRAGMA integrity_check` can
in principle detect index/table divergence, but it is a full-database scan and is not run on the read
path; the cross-path assertion is the read-time detector. SQLite provides no main-database page
checksums to fall back on.

**Why this matters more here than anywhere else in the sprint.** `getAt` **is** Law T3, the
mechanised law: `Formal/Lean/UmbraDBFormal/TemporalKV/Model.lean:95-106`'s `getAtTime`. A wrong-row
answer at `getAt` is precisely the failure the whole digest regime does not detect, in the one place
the formal layer is relied upon. It also composes with what this change establishes elsewhere: **T3
does not compose across a conversion, and it does not compose across an index either.** In both cases
the answer has to be *compared*, not inferred — from the target's internal coherence in one case,
from a single b-tree's say-so in the other.

The two assertions above are exactly the definition of `getAtTime`, so the check is not a heuristic
approximation of correctness but the property itself, evaluated through an independent path. Cost is
two index seeks (`v1.0.0-sqlite-durability-contract`'s costing); this is a correctness decision, not
a performance trade.

**Scope, stated rather than assumed.** This invariant as distributed covers the `{at}` path. The
symmetric hazard — a damaged **primary-key** index with an intact time index, corrupting
`getAt({version: v})` — is **not** closed by this requirement. Law T4's dual-addressing property
exercises both paths against each other, but as a property test over sampled traces, not as a
read-time assertion. Naming it is deliberate: it is the residual, and it should not be discovered
later as an oversight.

#### Scenario: The bound is verified through the primary-key index before any row is returned
- **WHEN** `getAt(k, { at: T })` finds a candidate version through the time index
- **THEN** the adapter SHALL re-read that version by primary key and confirm its `written_at <= T`
- **AND** SHALL confirm the successor version is absent or has `written_at > T`
- **AND** only then SHALL it return the row

#### Scenario: A damaged index copy is caught although every digest verifies clean (negative control)
- **GIVEN** a store in which the time index's copy of a key's entries has been damaged while the
  corresponding table rows are left intact — so that a seek through it yields a version whose true
  `written_at` is greater than `T`
- **WHEN** `getAt(k, { at: T })` is issued
- **THEN** every application-level digest over the stored values SHALL verify clean, because no
  stored value was altered
- **AND** with the cross-path assertion in place the read SHALL fail loudly with a typed error
- **AND** with the assertion removed the read SHALL return a row that does not satisfy the query —
  a wrong answer from Law T3 with no error raised anywhere, which is the failure this requirement
  exists to make impossible and the reason a green digest is not evidence for this read

#### Scenario: A candidate that is too early is caught by the successor half
- **GIVEN** a damaged index that yields version `v` when the correct answer is a later version `v+n`
  whose `written_at` is still `<= T`
- **WHEN** the cross-path assertion runs
- **THEN** the first half SHALL pass — `written_at(v) <= T` is true — and the **successor** half SHALL
  fail, because `written_at(v+1) <= T`
- **AND** this is why both halves are required: checking only the bound would accept a stale-but-valid
  row, which is a wrong answer that looks correct

#### Scenario: The assertion fails closed, never open
- **WHEN** the cross-path assertion cannot be evaluated — the candidate version is absent from the
  primary-key index, or the re-read returns no row
- **THEN** `getAt` SHALL raise rather than fall back to the value the time-index seek produced
- **AND** it SHALL NOT treat a zero-row re-read as confirmation, since a re-read matching nothing is
  evidence of divergence, not of agreement

### Requirement: the event log is append-only at the database level

`UPDATE` and `DELETE` against the event log SHALL be rejected by database-level trigger assertions,
not by adapter discipline alone. The rejection SHALL identify itself distinctly from a version or
clock violation.

#### Scenario: Updating a stored event is rejected
- **WHEN** any `UPDATE` is issued against a row of the event log, from any connection
- **THEN** it SHALL be rejected by a `BEFORE UPDATE` trigger assertion
- **AND** the rejection SHALL be distinguishable from the version-chain and strict-clock assertions

#### Scenario: Deleting a stored event is rejected
- **WHEN** any `DELETE` is issued against a row of the event log
- **THEN** it SHALL be rejected by a `BEFORE DELETE` trigger assertion
- **AND** this SHALL hold even though a deletion cannot break gap-freedom (see the T5(2) requirement
  above) — it is rejected because it breaks Law T1's gapless version chain

#### Scenario: The assertions are present at open, not assumed
- **WHEN** the adapter opens a database file
- **THEN** it SHALL verify that the append-only and `WellFormed` trigger assertions exist in the
  schema
- **AND** SHALL fail to open rather than operate against a database whose assertions have been
  dropped
- **AND** the probe SHALL assert an expected **count** of matching schema objects; a query that
  completes without error but matches zero rows SHALL be treated as absence, never as confirmation —
  a probe that checks only for the absence of an error reports success on a database with no
  assertions on it at all

### Requirement: WellFormed is the single remaining refinement obligation and is asserted in the database

The store SHALL enforce, at the database level on every insert, that (1) the new version is exactly
one greater than the key's current maximum version (Law T1), and (2) the new `written_at` strictly
exceeds the immediately preceding version's `written_at` for that key (`WellFormed`,
`Formal/Lean/UmbraDBFormal/TemporalKV/Model.lean:69-72`). It SHALL additionally make two versions of
one key sharing an instant unrepresentable via a unique index on `(ns, scope, key, written_at)`.

This replaces the discharge that exists today: `CONSTRAINT kv_history_range CHECK (valid_from <
valid_to)` (`src/postgres/migrations/001_temporal_kv.ts:96`), whose SQLSTATE `23514` is what the
adapter routes to `ClockRegressionError` (`src/postgres/errors.ts:280-296`).

**The version assertion SHALL be evaluated before the clock assertion, and the ordering is a
correctness constraint rather than a stylistic one.** The clock assertion compares the new
`written_at` against the immediately preceding version's; when that predecessor row does not exist
the comparison matches zero rows and the assertion **passes vacuously**. It is sound only because the
version assertion has already rejected any chain gap by the time it runs. Splitting the two into
separate triggers, or reordering them within one trigger body, would silently remove that protection
— so the dependency is stated here rather than left implicit in statement order.

#### Scenario: A non-consecutive version is rejected
- **WHEN** an insert supplies a version that is not exactly `prev + 1` for that key — a skip or a
  duplicate
- **THEN** the insert SHALL be rejected by the database, not by the adapter

#### Scenario: A non-increasing written_at is rejected
- **WHEN** an insert supplies a `written_at` less than or equal to the previous version's
  `written_at` for that key
- **THEN** the insert SHALL be rejected by the database
- **AND** the rejection SHALL surface to the caller as `ClockRegressionError`, preserving the frozen
  `CLOCK_REGRESSION` code's routing

#### Scenario: Writes to different keys may interleave, but one key's versions may not arrive out of order
- **WHEN** versions are inserted as key A v1, key B v1, key A v2, key B v2
- **THEN** all four SHALL be accepted, because the version and clock assertions are evaluated per
  `(ns, scope, key)` and carry no cross-key ordering requirement
- **AND WHEN** a key's version 2 is inserted before its version 1
- **THEN** it SHALL be rejected by the version assertion
- **AND** this is a realistic path rather than a contrived one: an importer or a bulk writer that
  streams rows grouped by time rather than by key will interleave keys freely, and one that sorts
  descending will fail on its first row rather than corrupting a chain

#### Scenario: The assertion is enforced as a trigger, not as a CHECK constraint
- **WHEN** `PRAGMA ignore_check_constraints=on` is set on the connection and a violating insert is
  attempted
- **THEN** the insert SHALL still be rejected, because that pragma disables `CHECK` constraints but
  not triggers — making a trigger assertion strictly harder to bypass on SQLite than the `CHECK` it
  replaces

### Requirement: the write-timestamp clock policy is decided by the engine-core measurement gate, not assumed

The expression that produces `written_at` SHALL NOT be fixed by this change. It SHALL be decided by
the following rule against the blocking measurement gate owned by `v1.0.0-sqlite-engine-core`.

Let **R** be the rejection rate of the strict-increase assertion, measured over at least 5,000
back-to-back unconditional `put`s to a single key, each in its own autocommitting transaction, with
no throttle, against a database file on a **real (non-tmpfs) filesystem**, at the `journal_mode` and
`synchronous` values selected as UmbraDB's shipped defaults, with the dataset size relative to page
cache recorded.

- **IF R = 0, THEN** a per-key monotone logical clock SHALL NOT be adopted; `written_at` SHALL be the
  millisecond-truncated statement-scoped SQL clock, and the strict-increase assertion SHALL remain a
  live witness that the clock behaved.
- **IF R > 0, THEN** the implementation SHALL adopt exactly one of, and record which: **(a)** a
  per-key monotone logical clock (`written_at := max(now_ms, prev + 1)`) **together with** a
  configured maximum-drift threshold that raises a typed error when `written_at − wall_clock` exceeds
  it; or **(b)** a change to the shipped `synchronous`/`journal_mode` default that brings R to 0,
  with its durability consequence recorded.
- **WHILE** the gate has not reported R, no implementation task depending on the policy SHALL be
  started, and this specification SHALL NOT be read as having adopted either option.

The frozen `writtenAt: Date` field (`src/interfaces/temporal-kv.ts:153`, pinned to
`VersionedEntrySchema`'s `z.date()` at `:143` by the `AssertExact` guard at `:156-163`) SHALL NOT be
widened, and no second timestamp field SHALL be added.

#### Scenario: The gate reports a zero rejection rate at the shipped defaults
- **WHEN** the measurement gate reports R = 0 over at least 5,000 sequential same-key puts under the
  stated conditions
- **THEN** `written_at` SHALL be the truncated SQL wall clock and no logical clock SHALL ship
- **AND** `CLOCK_REGRESSION` SHALL retain both documented causes and its `conditional` marking
  (`docs/ERROR-CATALOG.md:73-89`) unchanged

#### Scenario: The gate reports a nonzero rejection rate at the shipped defaults
- **WHEN** the measurement gate reports R > 0 under the stated conditions
- **THEN** exactly one of the logical clock (with its drift bound) or a durability-default change
  SHALL be adopted, and which one SHALL be recorded
- **AND** IF the logical clock is adopted THEN the bounded-drift check SHALL ship in the same change,
  because it is what gives `CLOCK_REGRESSION` a second live cause and therefore preserves its
  `conditional` marking — narrowing that marking to `non-retryable` is a weakening that
  `docs/ERROR-CATALOG.md:13` forbids

#### Scenario: A design that assumes the logical clock before the gate reports (negative control)
- **GIVEN** a hypothetical implementation that ships the per-key monotone logical clock on the
  strength of the published "99.2% of sequential same-key puts rejected" figure
- **WHEN** that figure is re-measured across durability settings on a real filesystem
- **THEN** it is 99.2% at `synchronous=OFF`, 99.1% at `NORMAL`, and **0.0% at `synchronous=FULL`**
  (5,000/5,000 accepted, because a commit costs milliseconds and two puts cannot then share one)
- **AND** that hypothetical implementation would have paid the logical clock's whole cost — a
  `writtenAt` that can run ahead of wall time, and the loss of the same-transaction rejection the 1 ms
  clock resolution currently provides by accident — to fix a problem that does not exist at the
  durability setting the project currently promises

#### Scenario: Microsecond storage is not an escape from the collision question
- **WHEN** widening `writtenAt` to microsecond precision is proposed as an alternative to the clock
  decision
- **THEN** it SHALL be rejected on the ground that the SQL-layer clock source is 1.000 ms regardless
  of the field's width — so a wider field would still require the same policy decision, while
  additionally breaking `VersionedEntry`, `AsOf.at`, `VersionedEntrySchema` and their compile-time
  sync guard
- **AND** an additive second field carrying finer precision SHALL likewise be rejected, because two
  temporal coordinates for one version can disagree

### Requirement: same-transaction key reuse is adapter-enforced, and the adapter states exactly what it guarantees

WHEN two `put` calls to the same `(namespace, scope, key)` occur within one transaction, the adapter
SHALL reject the second with `TransactionKeyReuseError` (`src/interfaces/temporal-kv.ts:250-256`),
detected by an in-memory per-transaction write-set. The frozen `TRANSACTION_KEY_REUSE` code
(`docs/ERROR-CATALOG.md:25`), its class and its `non-retryable` marking SHALL be preserved; its
enforcement SHALL be documented as moving from **database-enforced to adapter-enforced**.

SQLite exposes no SQL-visible transaction identity: there is no `txid_current()`, no `pragma
txn_state`, and no `sqlite3_txn_state` binding, so
`Formal/STORAGE_ALGEBRA.md:78-95`'s "correct, mechanical detector" —
`updated_xact bigint NOT NULL DEFAULT txid_current()` at
`src/postgres/migrations/001_temporal_kv.ts:80`, checked at `:117-124` — has no substitute. The
adapter write-set SHALL be required **unconditionally**, independent of how the clock policy above
resolves, because the strict-clock assertion's incidental rejection of same-transaction second writes
holds only by accident of 1 ms clock resolution and disappears under a monotone logical clock.

#### Scenario: A second put to one key in one transaction is rejected by the adapter
- **WHEN** a transaction issues `put(ns, scope, key, v1)` and then `put(ns, scope, key, v2)`
- **THEN** the second call SHALL reject with `TransactionKeyReuseError`
- **AND** the rejection SHALL be produced by the adapter's write-set, and SHALL NOT be attributed in
  documentation to any database mechanism

#### Scenario: Forgery from outside the transaction is refused by the write lock
- **WHEN** a second connection is opened against the same database file while UmbraDB holds a write
  transaction, and attempts to write state the guard depends on
- **THEN** that connection SHALL be refused by SQLite's whole-database write lock (`SQLITE_BUSY`)
- **AND** the guarantee SHALL be attributed to UmbraDB owning the transaction handle, not to any
  worker-thread topology — any design in which the caller receives an opaque `TransactionHandle`
  rather than a live database handle achieves it
- **AND** this refusal **is** write-lock exclusivity rather than a second, independent barrier, so it
  is governed by `v1.0.0-sqlite-concurrency-lease`'s inheritance table (cited by its section title, "Inheritance table"), which
  enumerates every claim resting on that foundation and rules that any such claim stated without the
  qualifier is a specification defect — this scenario is listed there and cites it rather than
  restating it

#### Scenario: A caller-supplied-SQL escape hatch voids the guard (named voiding precondition)
- **GIVEN** any adapter path that executes caller-supplied SQL on the transaction's own connection
- **WHEN** that path exists and is reachable
- **THEN** the same-transaction guard SHALL be considered voided, because a caller can then issue
  writes the write-set never observes
- **AND** the absence of such a path SHALL be asserted by a guard test — in the style of the existing
  import-guard test family — rather than assumed

#### Scenario: An SQL-derived transaction identity is not an acceptable substitute (negative control)
- **GIVEN** a hypothetical implementation that emulates transaction identity with an
  `AUTOINCREMENT` counter table the adapter appends to once per `BEGIN`, read by the trigger
- **WHEN** the caller inserts one extra row into that counter table mid-transaction
- **THEN** the guard SHALL be defeated and the second same-key write accepted
- **AND** this is why the guard is specified as adapter code with a named voiding precondition,
  rather than as a database mechanism that would be described as unforgeable and would not be

### Requirement: the adapter never issues INSERT OR REPLACE against the event log

The adapter SHALL NOT issue `INSERT OR REPLACE` (or `REPLACE INTO`) against the event log, and the
prohibition SHALL be enforced by an automated guard over the adapter's SQL, not by review alone.

`INSERT OR REPLACE` performs DELETE+INSERT and therefore **never fires a `BEFORE UPDATE` trigger**,
so on any schema where an update carries history it silently loses a history row. `INSERT … ON
CONFLICT DO UPDATE` — the shape the current unconditional `put` uses
(`src/postgres/temporal-kv.ts:119-124`) — does fire it correctly.

#### Scenario: INSERT OR REPLACE would silently skip an update trigger
- **GIVEN** a hypothetical port that translates the unconditional `put`'s upsert to
  `INSERT OR REPLACE`
- **WHEN** it writes a second version of an existing key on a schema whose history row is produced by
  a `BEFORE UPDATE` trigger
- **THEN** the trigger SHALL NOT fire and the history row SHALL be silently lost — no error, no
  diagnostic
- **AND** the equivalent `ON CONFLICT DO UPDATE` statement SHALL fire the trigger and write the row

#### Scenario: The ban is mechanically enforced
- **WHEN** the adapter's SQL is scanned by the guard test
- **THEN** any occurrence of `INSERT OR REPLACE` or `REPLACE INTO` targeting the event log SHALL fail
  the build
- **AND** the guard SHALL remain in force even though the append-only assertions would also reject
  the deletion half, because the ban must survive a future schema that reintroduces an updatable row

### Requirement: trigger assertions abort the statement and never end the transaction

Trigger assertions SHALL raise with `ABORT` (or `FAIL`) and SHALL NOT use `ROLLBACK`. A single
logical `put` SHALL be expressed as exactly one SQL statement, so that a rejected write leaves no
partial trace.

SQLite does **not** poison a transaction after a failed statement: after the assertion fires the
transaction is still open, further writes succeed, and `COMMIT` succeeds. `ABORT` reverses the entire
statement, including anything the trigger body itself wrote — so a swallowed error costs *caller
atomicity*, not the store's temporal invariants. Sticky-poison emulation for caller atomicity belongs
to `v1.0.0-sqlite-concurrency-lease`; the requirements in this specification do not depend on it.

#### Scenario: A swallowed assertion leaves the store temporally coherent
- **WHEN** a transaction triggers an assertion, catches the error, continues writing unrelated rows,
  and commits
- **THEN** the commit SHALL succeed and the rejected write SHALL have left no row
- **AND** the derived intervals for every key SHALL still be non-overlapping and gap-free, and the
  version chain SHALL still be gapless

#### Scenario: RAISE(ROLLBACK) is a worse failure and is banned (negative control)
- **GIVEN** a hypothetical implementation whose assertions raise with `ROLLBACK` in order to obtain
  PostgreSQL-like transaction poisoning
- **WHEN** the assertion fires and an unaware caller continues writing and then commits
- **THEN** the transaction SHALL already be gone, the caller's subsequent write SHALL execute and
  commit **in autocommit**, and the caller's own `COMMIT` SHALL fail with "cannot commit - no
  transaction is active"
- **AND** that silent partial persistence outside any transaction is strictly worse than the
  swallowable `ABORT` error, which is why `ABORT` is specified

#### Scenario: Splitting one put across two statements is forbidden
- **GIVEN** a hypothetical adapter that writes the new version in one statement and records the
  temporal bookkeeping in a second
- **WHEN** the second statement fails and the caller swallows the error and commits
- **THEN** that hypothetical implementation CAN leave the store temporally incoherent, because
  `ABORT` reverses only the failing statement
- **AND** this is why the write is specified as a single statement, and it is the sole reason T5's
  soundness does not depend on transaction-poisoning emulation

### Requirement: the naive EXCLUDE transliteration is prohibited

An overlap check that probes a key's whole stored history on every write — the direct transliteration
of `EXCLUDE USING gist (ns WITH =, scope WITH =, key WITH =, validity WITH &&)`
(`src/postgres/migrations/001_temporal_kv.ts:97-99`) into a `BEFORE INSERT` trigger with an
overlap-`EXISTS` subquery — SHALL NOT be adopted. Any interval-based fallback SHALL restrict its
check to immediately adjacent intervals and SHALL record, in the design record, that such a check is
sound only **inductively** (it presupposes the invariant it enforces, which a GiST exclusion
constraint does not).

The write path's cost SHALL be established as **flat in a key's version count** under stated
measurement conditions — filesystem, `synchronous`, `journal_mode`, and dataset size relative to page
cache — rather than asserted from any figure in the research corpus.

#### Scenario: The whole-history overlap probe is quadratic (negative control)
- **GIVEN** the naive transliteration, whose predicate is
  `EXISTS (SELECT 1 FROM h x WHERE x.k = new.k AND x.vf < new.vt AND new.vf < x.vt)`
- **WHEN** versions are appended to a single key and per-chunk insert time is recorded as the key's
  history grows
- **THEN** per-chunk time SHALL grow linearly with history length — measured 2,653 → 8,425 → 16,988 →
  23,929 ms per 10k rows, i.e. **still degrading at 50k versions**, a 1,441× slowdown against the
  unconstrained floor at 708 rows/s
- **AND** because that measurement was taken on a RAM disk it is a **floor**: on real storage the
  penalty is larger, not smaller

#### Scenario: The shipped write path is flat, and the number is established rather than quoted
- **WHEN** the write path's cost is characterised for the acceptance record
- **THEN** the measurement SHALL be taken on a real (non-tmpfs) filesystem at the shipped
  `journal_mode`/`synchronous` defaults, with dataset size relative to page cache recorded
- **AND** the criterion SHALL be that per-chunk insert time shows no upward trend as a key's version
  count grows by at least an order of magnitude — a shape, not a rate

### Requirement: the engine configuration under which trigger-based enforcement is sound is asserted, not assumed

The trigger assertions that carry `WellFormed` SHALL be documented and tested as sound under
concurrent writers in `journal_mode` `wal`, `delete` and `truncate`, at any `busy_timeout`,
**conditional on write-lock exclusivity holding**. The adapter SHALL NOT enable shared-cache mode or
`PRAGMA read_uncommitted`, and SHALL assert that neither is in effect when it opens a database. No
in-process code SHALL open a file descriptor on the database file or on its `-wal`/`-shm` sidecars.

**Corrected — the window is closed by one mechanism observed at three points, not by three
independent ones.** A previous revision of this requirement claimed the check-then-insert TOCTOU
window was closed "three independent ways": `SQLITE_BUSY` (5) refusing a second simultaneous writer,
`SQLITE_BUSY_SNAPSHOT` (517) refusing a stale-snapshot reader upgrading to a writer, and
fresh-snapshot visibility making a committed competing row visible to the assertion. **They are not
independent.** All three are consequences of write-lock exclusivity and they fail together:
`v1.0.0-sqlite-concurrency-lease` reproduced the `-shm` descriptor attack and measured that once
exclusivity is voided, nothing raises `SQLITE_BUSY` (both writers hold locks), fresh-snapshot
visibility also fails (each assertion's snapshot predates the other's commit), and neither commit is
refused. The distinction is load-bearing: three independent guarantees would survive one of them
failing; one guarantee observed at three points does not. The correct characterisation of the failure
mode is **void, not weakened**.

WHILE no in-process code opens and closes a descriptor on the database file or its sidecars,
write-lock exclusivity holds and the window is closed. POSIX record locks are released when a process
closes **any** descriptor on the inode, and SQLite's unix VFS defers closing its own descriptors
precisely to work around that — it cannot defend against a descriptor opened by other code in the
same process.

**Which file carries the locks is journal-mode-dependent, so the guard is the union, not a per-mode
rule.** Under `wal` the locks live on `-shm`; under the rollback-journal modes (`delete`, `truncate`)
they live on the main database file. `v1.0.0-sqlite-concurrency-lease` measured all three modes with
a control arm each and extended its build-failing source guard to cover **the database file and both
sidecars, unconditionally** — including opens through path-building helpers, and permitting metadata
operations. That guard is cited here as the mechanism restoring the precondition, not re-specified.

The ruling turns on what is **statically expressible**, not on which mode is safer: `journal_mode` is
a persistent property of the file and mutable at runtime, so a build-time check cannot know which
mode a given file will be in, and the union is the only rule that covers all of them. Consequently
this requirement's soundness claim stands for **all three modes, unnarrowed**. Narrowing to `wal`
would have forfeited rollback-journal mode's *stronger* exclusion in exchange for avoiding a build
rule that costs UmbraDB nothing — the engine opens the database natively rather than through the Node
filesystem API, and backup is specified out-of-process.

Everything in this change resting on write-lock exclusivity is enumerated in
`v1.0.0-sqlite-concurrency-lease`'s inheritance table (cited by its section title, "Inheritance table"), which rules that any such
claim appearing without this qualifier is a **specification defect**. Claims elsewhere in this
specification cite that table rather than restating the qualifier locally.

What is **not** in question is the enforcement result itself. The red team attacked it across three
journal modes × two `busy_timeout` settings and it held in all six cells; nothing above touches that.
What changes is only the strength of the argument given for it. The comparison with PostgreSQL also
stands: the same trigger at READ COMMITTED would be unsound, which is *why* `EXCLUDE` constraints
exist — they take predicate-style locks — and WAL is not required, because in rollback-journal mode
the reader's SHARED lock blocks the competing writer outright.

#### Scenario: A concurrent writer cannot slip past the assertion in any supported journal mode
- **WHEN** two connections on one database file race a write to the same key, in each of
  `journal_mode` `wal`, `delete` and `truncate`, with `busy_timeout` both `0` and a nonzero value,
  and no in-process descriptor has been opened on the database file or its sidecars
- **THEN** in every combination one writer SHALL be refused — by `SQLITE_BUSY`, by
  `SQLITE_BUSY_SNAPSHOT`, or by the assertion itself seeing the committed row
- **AND** the invariant SHALL hold on disk afterward in every combination
- **AND** the refusal SHALL be attributed to write-lock exclusivity, of which those three observations
  are consequences, and SHALL NOT be described as three independent guarantees

#### Scenario: Voiding write-lock exclusivity defeats all three observations at once (negative control)
- **GIVEN** three arms run on a real (non-tmpfs) filesystem against the ruled binding: a control; an
  arm that opens a descriptor on the `-shm` file **without** closing it; and an arm that opens and
  closes one
- **WHEN** a competing writer then attempts to commit against the same database
- **THEN** the control SHALL be refused with `SQLITE_BUSY`, and the open-without-close arm SHALL
  **also** be refused — isolating the fault to POSIX close semantics rather than to the act of opening
- **AND** the open-and-close arm SHALL let the competitor commit, with the first writer's commit
  reported lost and `integrity_check` still returning `ok`
- **AND** in that arm none of the three observations SHALL fire — no `SQLITE_BUSY`, no
  `SQLITE_BUSY_SNAPSHOT`, and no fresh-snapshot visibility — demonstrating that they share one
  foundation and fail together

#### Scenario: The voiding file differs by journal mode, and one mode fails loudly while two fail silently
- **WHEN** the descriptor open-and-close is directed at the database file rather than at `-shm`, in
  each of `wal`, `delete` and `truncate`
- **THEN** under `wal` it SHALL be harmless — the competitor is still refused, because the locks live
  on `-shm` — while under `delete` and `truncate` it SHALL void exclusivity and let the competitor
  commit
- **AND** under `delete` the original holder's own `COMMIT` SHALL **fail**, because the competitor
  removed the rollback journal underneath it, whereas under `wal` and `truncate` both commits are
  acknowledged and the loss is **silent on both sides**
- **AND** that asymmetry SHALL be recorded rather than averaged away: a mode that errors on one side
  is materially different from one that loses a commit with no signal anywhere, and only the silent
  cases are undetectable without the cross-path assertions this specification requires elsewhere

#### Scenario: The descriptor guard is build-failing and covers the union of the three files
- **WHEN** adapter source is scanned by the guard
- **THEN** any code path that opens a descriptor on the database file **or** on either sidecar SHALL
  fail the build, including opens constructed through a path-building helper
- **AND** metadata operations that do not open a descriptor SHALL remain permitted
- **AND** the guard SHALL NOT be conditioned on journal mode, because `journal_mode` is a persistent,
  runtime-mutable property of the file that a build-time check cannot observe — the union is the only
  statically expressible rule that covers every mode this requirement claims soundness under

#### Scenario: Shared-cache mode with read_uncommitted is refused at open
- **WHEN** the adapter opens a database in shared-cache mode, or with `PRAGMA read_uncommitted`
  enabled
- **THEN** it SHALL refuse to operate rather than proceed
- **AND** this is specified as a refusal rather than a tested hazard because the failure it prevents
  was reasoned about and never measured — the refusal makes the untested case unreachable

## MODIFIED Requirements

### Requirement: Postgres errors surface as the shared StorageError hierarchy

Driver-level and constraint-violation errors SHALL be translated into the project's shared
`StorageError` subclasses before reaching the caller; a raw driver-level error object SHALL NOT
escape the adapter layer. The requirement's header retains its original wording so this modification
resolves against the merged specification; renaming the engine out of the frozen surface (including
`UNRECOGNIZED_POSTGRES_ERROR` / `UnrecognizedPostgresError`) is
`v1.0.0-sqlite-durability-contract`'s, not this change's.

Two frozen codes change reachability as a direct consequence of this change's mechanism, and both are
handed to `v1.0.0-sqlite-durability-contract` for catalog treatment rather than being repurposed
here: `EXCLUSION_VIOLATION` — defined as "A Postgres exclusion constraint fired (23P01)"
(`docs/ERROR-CATALOG.md:41`) — becomes **unreachable from this module**, because there is no
exclusion constraint and non-overlap is structural; and `CLOCK_REGRESSION`'s cause set depends on how
the clock policy above resolves.

#### Scenario: A connection failure surfaces as ConnectionError
- **WHEN** the underlying database cannot be opened or read (e.g. a missing file, a permissions
  failure, or an unreadable database)
- **THEN** the adapter SHALL reject with a typed error from the shared hierarchy
- **AND** SHALL NOT reject with a raw driver-level error type

#### Scenario: The strict-clock assertion is translated to ClockRegressionError
- **WHEN** the `written_at` strict-increase assertion rejects an insert
- **THEN** the adapter SHALL translate it to `ClockRegressionError`, preserving the frozen
  `CLOCK_REGRESSION` code
- **AND** the translation SHALL match on the assertion's own distinct message tag, not on a generic
  constraint-failure result code shared with unrelated assertions

#### Scenario: Same-transaction key reuse is raised by the adapter, not translated from a database error
- **WHEN** a second `put` to one key occurs in one transaction
- **THEN** `TransactionKeyReuseError` SHALL be raised by the adapter's write-set before any statement
  is issued
- **AND** the error-translation table SHALL NOT contain an entry claiming a database mechanism
  produced it, since none does (the `UB001` SQLSTATE route at `src/postgres/errors.ts:273-277` has no
  successor)

#### Scenario: The exclusion-constraint translation path is retired, not left silently dead
- **WHEN** the adapter's error-translation table is reviewed after this change
- **THEN** the path that matched an exclusion-constraint violation SHALL be recorded as unreachable
  from this module, with the reason (non-overlap is structural; there is no constraint to fire)
- **AND** the frozen `EXCLUSION_VIOLATION` code and `ExclusionViolationError` class SHALL remain
  exported, because removing a frozen code is forbidden and unreachability is not removal

### Requirement: Unconditional writes are gapless and monotonic (Law T1)

`put` calls with no `expectedVersion` (the unconditional write path) SHALL assign versions that
increase by exactly 1 from the key's previous version, starting at 1 for a key's first write, with no
gaps and no repeats, when calls are serialized — this requirement is explicitly conditional on
serialization, per `Formal/STORAGE_ALGEBRA.md` §1 Law T1, not a claim that concurrent unserialized
writers cannot race.

Version assignment SHALL be enforced by the database: the `WellFormed` insert assertion rejects any
version that is not exactly `prev + 1`, so a gap or a repeat is rejected rather than stored. This is
strictly stronger than the current Postgres arrangement, in which the server computes `version + 1`
(`src/postgres/temporal-kv.ts:119-124`) with no independent assertion that it did so.

**The same-millisecond caveat is retained but is now conditional on the clock policy, not on the
engine.** The merged version of this requirement recorded that two sequential same-key writes whose
truncated instants land in one millisecond cause the second to reject with `ClockRegressionError`
rather than assigning the next consecutive version. That caveat survives verbatim in *shape* — it is
the strict-increase assertion firing — but whether it is a rare edge case or the common case is a
function of the shipped durability setting, and the clock-policy requirement above is what settles
it. Until the measurement gate reports, this requirement SHALL be read as gapless-and-monotonic for
any sequence of writes that does not hit that collision, with the collision's *frequency* explicitly
undetermined.

#### Scenario: Sequential unconditional writes produce consecutive versions
- **WHEN** a key is written N times in sequence with no `expectedVersion` supplied, no concurrent
  writer involved, and no two of the N writes' recorded instants colliding
- **THEN** the assigned versions SHALL be exactly `1, 2, 3, ..., N` in order, with no gap and no
  repeated value

#### Scenario: The CAS-guarded and unconditional paths agree on version assignment
- **WHEN** a `put` with `expectedVersion` matching the current version succeeds
- **THEN** the resulting version SHALL be exactly `current + 1`, identical to what an unconditional
  write at that point would have produced
- **AND** both paths SHALL be the same SQL statement, differing only in a guard predicate, so
  divergence between them is not expressible

#### Scenario: A version gap is rejected by the database, not merely avoided by the adapter
- **WHEN** an insert supplies a version two greater than the key's current maximum, bypassing the
  adapter's own computation
- **THEN** the database SHALL reject it
- **AND** the rejection SHALL be attributable to the version assertion specifically, not to a unique
  constraint on the primary key (which would not catch a forward skip)

### Requirement: A caller-supplied transaction handle is honored or rejected, never silently ignored

The merged text of this requirement was explicitly scoped — *"Until the Transaction/Lease module's
real wiring lands (a later sprint)"* — and mandated that every method accepting `opts.tx` throw a
*"transaction participation not yet supported"* error. **That condition has now been met.**
`v1.0.0-sqlite-concurrency-lease` delivers real transactions in this same sprint, so leaving the
merged text in force would require an implementation to refuse the very feature another change in the
sprint ships, and would archive a requirement that is false the day it merges.

Every `TemporalKV` method accepting `opts.tx` — `put`, `get`, `getAt` and `listKeys` — SHALL, when
given a non-`undefined` `TransactionHandle`, either **execute inside that transaction** or **reject
before issuing any query**. It SHALL NOT, under any circumstance, accept a handle and run the
operation outside the transaction it names. That last clause is the invariant this requirement's
header has always named, it is the only part of the merged text that was never engine-specific or
sprint-scoped, and it survives this change unchanged.

Transaction semantics — begin/commit/rollback, isolation, the writer lease, the transaction-hold
bound and its error mapping — belong to `v1.0.0-sqlite-concurrency-lease` and are cited here, not
restated. `TransactionHandle` (`src/interfaces/transaction-lease.ts:26-29`) and
`TransactionHandleInvalidError` (`:126-132`) are frozen G1 surface and are unchanged by this change.
The latter's own frozen doc already anticipates precisely this design: *"Every storage-layer method
accepting `opts.tx` (not just this layer's own methods) can throw this, since resolving the handle
happens before that method's query ever runs."*

Two consequences are this requirement's own, because they are temporal rather than transactional:

1. **Reads issued with a live handle SHALL resolve against that transaction**, so a `get` or `getAt`
   observes events the same transaction has already written and not yet committed. Resolving them
   against any other connection would be the silent-ignoring failure in read form.
2. **The same-transaction key-reuse guard becomes reachable through the public API for the first
   time.** The merged requirement *"A second write to the same key within one transaction is rejected
   at the trigger level, not silently absorbed"* carried a scope note stating that no public call
   sequence could reach that path *because* `opts.tx` was rejected outright. This requirement is what
   retires that note; the write-set guard specified elsewhere in this change is what makes the path
   correct once it is reachable.

#### Scenario: A live handle is honored end to end
- **WHEN** `put(ns, scope, key, value, { tx })` is issued with a live handle, and `get(ns, scope,
  key, { tx })` is then issued with that same handle
- **THEN** the read SHALL return the value the transaction just wrote
- **AND** IF that transaction subsequently rolls back THEN a later `get` issued with no handle SHALL
  NOT return that value — demonstrating the write was genuinely inside the transaction rather than
  alongside it

#### Scenario: A handle that is not live rejects before any query runs
- **WHEN** any of `put`/`get`/`getAt`/`listKeys` is called with a `TransactionHandle` that is
  fabricated, or that names a transaction which has already committed or rolled back
- **THEN** the call SHALL reject with `TransactionHandleInvalidError`
- **AND** SHALL NOT execute any statement against the database first

#### Scenario: A handle invalidated by the transaction-hold bound rejects rather than escaping
- **WHEN** the transaction-hold bound established by `v1.0.0-sqlite-concurrency-lease` elapses, and
  that change's semantics roll the transaction back, release its lock and invalidate the handle
- **AND** a caller afterwards issues a `TemporalKV` operation with that now-invalidated handle
- **THEN** the operation SHALL reject with `TransactionHandleInvalidError` before issuing any
  statement
- **AND** SHALL NOT fall back to executing outside the transaction — an expired hold must not convert
  a transactional write into an autocommitted one

#### Scenario: Accepting a handle and running outside it (negative control)
- **GIVEN** a hypothetical adapter that accepts `opts.tx` but resolves its statements against the
  default connection — the failure mode this requirement's header names
- **WHEN** a caller performs a `put` with a live handle and then rolls that transaction back
- **THEN** that hypothetical adapter's write SHALL already have committed independently and SHALL
  survive the rollback, with no error raised at any point
- **AND** the caller would have no way to detect it, which is why "honored or rejected" is specified
  as an exhaustive pair with no third outcome

### Requirement: put's CAS guard distinguishes conflict from absence

`put`, when given `expectedVersion`, SHALL determine whether a failed compare-and-set was caused by a
version mismatch (key exists at a different version) or by the key never having been written, and
SHALL populate `VersionConflictError.actual` accordingly (`undefined` only in the never-written case,
per `src/interfaces/temporal-kv.ts:194-204`'s documented contract) — a zero-affected-rows result from
the underlying statement alone is NOT sufficient to make this distinction and MUST NOT be used as the
sole signal.

The CAS guard SHALL be expressed as a predicate on the same single `INSERT` statement that performs
the write, comparing `expectedVersion` against the key's current maximum version, with
`expectedVersion = 0n` ("this key must not already exist",
`src/interfaces/temporal-kv.ts:124-131`) being the case where that maximum is 0. This collapses the
three separate statement shapes the Postgres adapter uses today —
`ON CONFLICT DO UPDATE`, `ON CONFLICT DO NOTHING`, and a guarded `UPDATE`
(`src/postgres/temporal-kv.ts:113-166`) — into one, and it is why the interface's documented
distinction between "conflict" and "never written" must still be resolved by a follow-up read.

#### Scenario: CAS conflict against an existing key reports the actual version
- **WHEN** `put(ns, scope, key, value, { expectedVersion: 2 })` is called and the key's current
  version is actually `3`
- **THEN** the call SHALL reject with `VersionConflictError`
- **AND** `error.actual` SHALL equal `3`

#### Scenario: CAS against a never-written key reports actual as undefined
- **WHEN** `put(ns, scope, key, value, { expectedVersion: 1 })` is called and the key has never been
  written
- **THEN** the call SHALL reject with `VersionConflictError`
- **AND** `error.actual` SHALL be `undefined`, not `0` and not the numeral zero as a version

#### Scenario: A zero-row write is never reported as success, and the guard stays the only filter
- **WHEN** the write statement affects zero rows
- **THEN** it SHALL be reported as a CAS failure, never as a successful write
- **AND** the statement SHALL carry exactly one filtering predicate — the CAS guard — so that a
  zero-row result is unambiguously attributable to it; adding a second predicate would make
  `changes() = 0` ambiguous between "the guard failed" and "the new predicate excluded the row", and
  the error would then be misreported with no diagnostic

#### Scenario: expectedVersion 0n against an existing key is a conflict, not a silent no-op
- **WHEN** `put(ns, scope, key, value, { expectedVersion: 0n })` is called for a key that already has
  versions
- **THEN** the statement's guard predicate SHALL exclude the row, zero rows SHALL be written, and the
  call SHALL reject with `VersionConflictError` whose `actual` is the key's real current version
- **AND** the write SHALL NOT be silently discarded as a successful no-op

### Requirement: A second write to the same key within one transaction is rejected at the trigger level, not silently absorbed

The header is retained verbatim so this modification resolves against the merged specification; the
mechanism it names has changed and this requirement now states the change explicitly.

A second `put` to the same `(ns, scope, key)` within one transaction SHALL be rejected with
`TransactionKeyReuseError`, and SHALL NOT result in any recorded version being lost. Rejection is
**no longer at the trigger level**: SQLite exposes no transaction identity, so the detector moves
into the adapter (see "same-transaction key reuse is adapter-enforced" above). The guarantee that
survives is exactly the one the merged requirement says it exists to provide — *no history row is
silently dropped as a side effect of the rejection* — and it now survives for a stronger reason: the
event log has no separate history row to drop, and the rejection happens before any statement runs.

Three properties of the merged requirement change and are restated rather than left to be inferred:

1. **The whole transaction no longer necessarily fails.** SQLite does not poison a transaction after
   a failed statement; the caller can catch and commit. The merged requirement's "the entire
   transaction SHALL fail to commit as a result" was a statement about PostgreSQL's documented
   behaviour and is no longer true. Transaction-level poisoning, if wanted for caller atomicity, is
   emulated by `v1.0.0-sqlite-concurrency-lease`, not here.
2. **The rejection is unforgeable only under a named precondition**, not by mechanism — see the
   adapter-enforcement requirement's voiding-precondition scenario.
3. **The scope note is retired.** The merged requirement's note that no public API call sequence
   reaches this path (because `opts.tx` was rejected outright in Sprint 1) is superseded once
   `v1.0.0-sqlite-concurrency-lease` wires `opts.tx`; this requirement's scenarios are written
   against the public API, not against raw SQL.

#### Scenario: The second put in one transaction is rejected before any statement is issued
- **WHEN** a transaction issues `put(ns, scope, key, v1)` and then `put(ns, scope, key, v2)`
- **THEN** the second call SHALL reject with `TransactionKeyReuseError`
- **AND** no SQL statement SHALL be issued for the second call

#### Scenario: The first write is not lost, and the caller's own choice decides whether it commits
- **WHEN** the caller catches the `TransactionKeyReuseError` and commits the transaction
- **THEN** the first write SHALL be present and the key's version chain SHALL be gapless
- **AND** the store's derived intervals SHALL be non-overlapping and gap-free — no recorded version
  is dropped as a side effect of the rejection, which is the property this requirement exists to
  guarantee

#### Scenario: The clock-resolution accident is not the enforcement (negative control)
- **GIVEN** a hypothetical implementation that omits the adapter write-set on the grounds that two
  same-transaction writes land in the same millisecond and the strict-clock assertion rejects the
  second anyway
- **WHEN** the clock policy resolves toward a per-key monotone logical clock
- **THEN** that hypothetical implementation SHALL accept the second same-transaction write, because
  the logical clock manufactures a strictly greater instant
- **AND** a frozen guarantee would then have become a function of a pragma — which is why the
  write-set is required unconditionally

### Requirement: listKeys streams without materializing the full result set first, and orders results correctly

`listKeys` SHALL yield keys incrementally (SHALL NOT load the entire matching result set into memory
before yielding its first item), SHALL yield each matching key at most once, and SHALL yield in a
total, deterministic order suitable for resumable pagination — the three properties
`src/interfaces/temporal-kv.ts:314-329` documents.

**All three survive this migration.** An earlier draft of this requirement narrowed the streaming
promise on the assumption that the `postgres.js` server cursor
(`query.cursor(256)`, `src/postgres/temporal-kv.ts:324-325`) had no SQLite analogue.
`v1.0.0-sqlite-engine-core` has since measured its ruled binding's `iterate()` against a 200,000-row
table on a real filesystem and established that it is **genuinely lazy** — first row available in a
small fraction of the time full materialisation takes. The promise therefore stands unweakened, and
the mechanism is change 1's to specify, not this requirement's to restate.

Three things do change, and one of them is an improvement over PostgreSQL that this requirement
claims.

**(1) At most once per key — preserved, by a different derivation, with a new hazard.** With the
live-row table folded into the event log, "each key's newest version" is no longer free from reading
a table that holds one row per key. Deduplication SHALL NOT require memory proportional to the number
of matching keys or events — it SHALL be achieved either by skipping adjacent duplicates over an
index-ordered scan, or by a query whose plan contains no materialising step. A planner-chosen
temporary B-tree for `DISTINCT` or `ORDER BY` would defeat lazy iteration **below the driver**, where
no transport choice can rescue it. `listKeys` SHALL be satisfied from the event log's own key
ordering and SHALL NOT be evaluated over the derived validity projection, whose window function
introduces a buffering step that a query returning no interval data has no reason to pay for.

**(2) A total, deterministic ordering — preserved, but it is a different order.** The ordering SHALL
be total and deterministic, so a resume boundary is well-defined. It is **not** the same order as
today's: PostgreSQL orders `text` by the database's collation, while SQLite's default `TEXT`
comparison is `BINARY`. The prefix predicate and the collation are `v1.0.0-sqlite-schema-parity`'s;
the caller-facing consequence is this requirement's, and it is that **a resume cursor persisted under
the old ordering is not portable across this migration** — free before the 1.0.0 tag
(`docs/STABILITY.md:46`), a breaking change to documented behaviour after it.

`BINARY` compares UTF-8 bytes, which is code-point order. JavaScript's `<` and
`Array.prototype.sort` compare UTF-16 code units. The two agree for keys drawn entirely from the
Basic Multilingual Plane and **disagree above it**: a supplementary-plane character is encoded in
UTF-16 as a surrogate pair in `U+D800`–`U+DFFF`, which sorts *below* `U+E000`–`U+FFFF` in code-unit
order and *above* it in code-point order. The adapter SHALL NOT compute a pagination boundary by
comparing keys in JavaScript. This is not a well-formedness problem — the boundary schemas already
reject lone surrogates (`src/interfaces/temporal-kv.ts:28-38`) — it is two different total orderings
of well-formed strings.

**(3) An abandoned stream SHALL fail the reader, and SHALL NOT stall writers — a strengthening.**
This is the property that genuinely changes, and it changes for the better.

An open iterator makes the database handle refuse writes while reads continue to pass. Under
PostgreSQL the cursor lived on a **pooled** connection, so a half-consumed `listKeys` cost one
connection and blocked nobody. Under a single-handle topology it would block **every write in the
process** — and the stream's lifetime belongs to the *consumer*. `src/postgres/temporal-kv.ts:291-298`
already concedes the shape of this: a generator suspended at `yield` "isn't running any code to
notice" and "no async generator can be 'pushed' from outside without the consumer resuming it." That
limitation was accepted when its cost was a leaked pooled connection. **Its cost would now be a
wedged writer, which is a materially different limitation and SHALL NOT be inherited silently.**

Therefore: stream liveness SHALL NOT depend on the consumer. The system SHALL bound the time an
abandoned iteration can hold read resources, by a **worker-enforced idle deadline** that releases the
iterator unilaterally — the mechanism is `v1.0.0-sqlite-engine-core`'s and is cited here, not
restated. The caller-visible consequence, which is this requirement's to state: **an abandoned stream
becomes a failed read rather than a stalled writer.** PostgreSQL could not offer this, because the
suspended generator was the only thing that could act; moving liveness to the worker is what makes it
available.

WHEN an iteration is released by that deadline, it SHALL surface to the consumer as an error on its
next resumption and SHALL NOT terminate the iteration normally — a normal termination is
indistinguishable from "there are no more keys", which would silently return a truncated key set to a
caller that believed it had seen all of them.

**On batching:** `v1.0.0-sqlite-engine-core` has filed the batch size as an open decision and has
marked the existing in-process figures inadmissible as justification, because they exclude the worker
hop. This requirement therefore references the batching *obligation* and never a size, and no
criterion below is satisfied or falsified by a particular batch number.

#### Scenario: The first key is observable long before the scan completes
- **WHEN** `listKeys` is called against a prefix matching a large number of keys (at least 100,000)
- **THEN** the elapsed time until the first key is yielded SHALL be a small fraction — no more than
  5% — of the elapsed time to drain the full iteration
- **AND** this SHALL be asserted as a **ratio between two timings measured in the same run**, not
  against an absolute latency, so that it is independent of hardware and fails as a test rather than
  as a review judgement
- **AND** the adapter's resident memory SHALL NOT grow in proportion to the number of matching keys
  as the iteration proceeds

#### Scenario: A materialise-first implementation fails the ratio (negative control)
- **GIVEN** a hypothetical implementation that fetches all matching rows before yielding its first
  key
- **WHEN** the same two timings are taken against the same fixture
- **THEN** its time-to-first-key SHALL approach its time-to-drain, so the ratio approaches 1 and the
  scenario above fails
- **AND** this is what makes the positive assertion meaningful: it is a measurement a wrong
  implementation cannot pass, not a property that is true by construction of the test

#### Scenario: Only the newest version of each key is yielded
- **WHEN** a key under the queried prefix has been written multiple times
- **THEN** `listKeys` SHALL yield that key at most once, not once per stored event
- **AND** this SHALL be achieved over the event log, since no current-row table exists to read it from

#### Scenario: Deduplication and ordering do not introduce a materialising step
- **WHEN** the query plan for `listKeys` is inspected
- **THEN** it SHALL NOT contain a temporary B-tree for `DISTINCT` or for `ORDER BY`, and SHALL NOT
  evaluate the derived validity projection
- **AND** IF the planner cannot satisfy both from the index ordering THEN the adapter SHALL instead
  perform an ordered scan and skip adjacent duplicates in constant memory, rather than accept a
  materialising plan

#### Scenario: The ordering is total, and is not JavaScript's string ordering
- **WHEN** the key set includes both a key containing a supplementary-plane character (encoded in
  UTF-16 as a surrogate pair) and a key containing a BMP character in `U+E000`–`U+FFFF`
- **THEN** `listKeys` SHALL yield them in the database's `BINARY` (code-point) order, consistently
  across runs and across resumptions
- **AND** a pagination boundary computed by comparing those two keys in JavaScript SHALL be
  recognised as disagreeing with that order — which is why the adapter is forbidden from computing
  boundaries that way

#### Scenario: Aborting mid-iteration rejects with AbortError and leaves no scan running
- **WHEN** `opts.signal` is aborted partway through a `listKeys` iteration
- **THEN** the iteration SHALL reject with `AbortError` — ending the generator's loop via a plain
  `break`, which completes the iteration successfully, does NOT satisfy this requirement
- **AND** the underlying statement SHALL be released and no scan SHALL still be running after the
  iteration settles — an abandoned scan holds a read snapshot open, which in WAL mode blocks
  checkpointing and grows the write-ahead log without bound

#### Scenario: A consumer that simply stops consuming does not wedge writers
- **WHEN** a consumer begins a `listKeys` iteration, reads a few keys, and then stops calling `next()`
  entirely — without aborting, without `break`, and without calling `return()`
- **THEN** writes elsewhere in the process SHALL become possible again once the idle deadline elapses,
  without any action by that consumer
- **AND** the guarantee SHALL NOT depend on the consumer resuming the generator, because a generator
  suspended at `yield` cannot be pushed from outside
  (`src/postgres/temporal-kv.ts:291-298`)

#### Scenario: A deadline-released iteration is not silently indistinguishable from completion
- **WHEN** an iteration is released by the idle deadline and the consumer later resumes it
- **THEN** the resumption SHALL reject with an error identifying the release
- **AND** it SHALL NOT return `{done: true}` as though the key set had been fully enumerated

#### Scenario: A silently truncated key set (negative control)
- **GIVEN** a hypothetical implementation whose idle deadline ends the iteration normally rather than
  faulting it
- **WHEN** a consumer pauses past the deadline mid-enumeration and then resumes
- **THEN** that implementation SHALL report the enumeration as complete while an arbitrary number of
  matching keys were never yielded, and no error SHALL be raised at any point
- **AND** a caller using `listKeys` to enumerate keys for deletion, reconciliation or migration would
  act on a silently short list — which is why the release is specified as a fault, not as an ending

### Requirement: getAt satisfies temporal-projection equivalence (Law T3), within the store's retention window

`getAt(k, { at: T })` SHALL return the value that a full, from-scratch fold of every `put` to `k` at
or before `T` would produce, for any `T` within whatever history-retention window this implementation
actually enforces. **This change enforces no retention or pruning at all** — retention remains
unimplemented, as it is today (`src/postgres/temporal-kv.ts:224`) — so this requirement holds
unconditionally for the store's entire lifetime, and `HistoryUnavailableError`
(`src/interfaces/temporal-kv.ts:219-229`) remains exported and unreachable. A future change that adds
retention MUST revisit these scenarios rather than assume they still hold.

The mechanism is restated because it changes: the fold is no longer "an interval containment read
against a precomputed `[valid_from, valid_to)`" (`Formal/STORAGE_ALGEBRA.md` §1 Law T3's status note)
but "the last event at or before `T`" over the event log — which is
`Formal/Lean/UmbraDBFormal/TemporalKV/Model.lean:95-106`'s `getAtTime` directly, rather than a
precomputation of it. The two-table `UNION ALL … ORDER BY priority LIMIT 1` defence
(`src/postgres/temporal-kv.ts:230-260`), which exists because the `EXCLUDE` constraint could not span
`kv_history` and `kv_current` together, is deleted along with the split that required it.

#### Scenario: getAt matches an independent replay for an arbitrary put sequence
- **WHEN** an arbitrary sequence of `put`s to a key, each with a distinct recorded instant, is
  applied, and `getAt(k, { at: T })` is queried for an arbitrary `T` within the sequence's range
- **THEN** the returned value SHALL equal the value produced by folding (in a plain, from-scratch
  reference implementation, not the code under test) only the puts at or before `T`

#### Scenario: A query before the first write returns null, not the first value
- **WHEN** `getAt(k, { at: T })` is queried for a `T` strictly earlier than the key's first event
- **THEN** it SHALL return `null`
- **AND** SHALL NOT return `HistoryUnavailableError`, since no retention floor exists and the answer
  is knowable

#### Scenario: The read requires no tiebreak between two sources
- **WHEN** the `getAt` read path is inspected
- **THEN** it SHALL query a single relation
- **AND** SHALL NOT contain a priority column or an ordering tiebreak between a live-row source and a
  history source, because no such split exists

**What a T3 claim means across a conversion from the PostgreSQL schema — the sharp end, because T3 is
the mechanised law and a conversion can violate it while passing every check.** T3 is an
equivalence between a store's reads and a fold over *that store's* events. It is therefore a claim
about one store, and it does **not** compose across a conversion by itself: two stores can each
satisfy T3 against their own event sequence and still answer the same query differently, which is
exactly what the gap case produces. A conversion that changes `getAt({at: 2500})` from `null` to
version 1 leaves T3 true of the source and true of the target and false of the migration.

The formal position, stated precisely rather than in the direction that flatters this change: the
abstract model **cannot represent a gap either**. `Model.lean:42`'s `History` is a list of events, and
`getAtTime` (`:95-106`) returns the last event at or before the query unconditionally. So a
gap-bearing `kv_history` was never in the model's image, and the converted event log's answer is the
**model-conformant** one. That is not a defence. A migration's obligation is to preserve what the
store returned, not to silently correct it toward the model — and a repair that changes an observable
read is a repair, which must be recorded and chosen, never a side effect of an encoding change.

#### Scenario: A T3-preserving conversion is asserted per key, not inferred from the target
- **WHEN** a conversion into the event log is claimed to preserve point-in-time reads
- **THEN** the claim SHALL be established by comparing source and target answers for the affected
  keys, and SHALL NOT be inferred from the target store satisfying T3 against its own events
- **AND** the comparison SHALL be evaluated on stored value text, never on a JS-parsed round trip

#### Scenario: A silent semantic repair is refused (negative control)
- **GIVEN** a conversion of a source key with a gap, whose target satisfies T3 against its own event
  sequence
- **WHEN** the pre- and post-conversion answers to `getAt({at: <an instant inside the gap>})` are
  compared
- **THEN** they SHALL differ — `null` before, a value after — and the conversion SHALL be reported as
  changing observable behaviour
- **AND** the fact that the post-conversion answer agrees with the abstract model SHALL NOT be
  accepted as grounds for performing the conversion silently

### Requirement: Dual addressing agrees at recorded write timestamps (Law T4)

For any committed version `v` of a key, `getAt(k, { version: v })` and `getAt(k, { at: T })`, where
`T` is that version's successfully persisted, strictly increasing `writtenAt` timestamp, SHALL return
equal values. The recorded timestamp is a statement-execution coordinate; this requirement does not
identify it with the transaction's commit or visibility instant
(`src/interfaces/temporal-kv.ts:171-177`).

Agreement SHALL rest on two structural facts rather than on write discipline: the strict-increase
assertion, and a unique index on `(ns, scope, key, written_at)` that makes two versions of one key
sharing an instant **unrepresentable**. The statement-scoped clock source is on the correct side of
the `now()`-versus-`clock_timestamp()` distinction that
`Formal/STORAGE_ALGEBRA.md` §1 and `design/design.md` §2 both turn on: SQLite's `'now'` advances
between statements inside one transaction, so the transaction-stable-timestamp defect that broke this
law in the original design cannot recur.

Whether `writtenAt` remains a wall-clock reading is decided by the clock-policy requirement above.
IF a per-key monotone logical clock is adopted, THEN `writtenAt` SHALL be documented as a store
coordinate that is usually wall time, never behind it, and not to be used as a clock — a narrowing of
the already-hedged documented meaning, whose text is `v1.0.0-sqlite-durability-contract`'s.

#### Scenario: Version and timestamp addressing agree
- **WHEN** a key is written across several versions, and for each version `v` its exact persisted
  `writtenAt` timestamp is recorded
- **THEN** `getAt(k, { version: v })` and `getAt(k, { at: <that version's writtenAt> })` SHALL return
  the same full entry — value, version and `writtenAt` — for every `v`

#### Scenario: A round-tripped Date addresses the same version it came from
- **WHEN** a caller reads `writtenAt` back from a `put` or `get` result and passes that exact `Date`
  into a later `getAt({ kind: "at", at })`
- **THEN** the returned entry SHALL be the same version
- **AND** this SHALL hold because the stored coordinate is already millisecond-quantised, so the
  value read back and the value round-tripped are identical — the property
  `src/postgres/migrations/001_temporal_kv.ts:60-71` exists to protect, preserved by storing
  milliseconds rather than a finer unit

#### Scenario: Two versions of one key cannot share an instant
- **WHEN** an insert would give a second version of one key a `written_at` equal to an existing
  version's
- **THEN** it SHALL be rejected — by the strict-increase assertion, and independently by the unique
  index on `(ns, scope, key, written_at)`
- **AND** the redundancy SHALL be retained deliberately, so that the guarantee does not rest solely
  on an assertion whose input the adapter computes

### Requirement: History intervals never overlap for a single key (Law T5)

Two validity intervals belonging to the same `(ns, scope, key)` SHALL NOT overlap. This SHALL hold
**structurally**: intervals are derived from a strictly increasing `written_at` by a `LEAD()` window
function, so no assignment of values to the event log's columns denotes an overlapping pair, and no
constraint is required to reject one.

This supersedes `Formal/STORAGE_ALGEBRA.md:213-217`, which records T5(1)'s status as
**MECHANISM SPECIFIED** via `EXCLUDE USING gist (ns WITH =, scope WITH =, key WITH =, validity WITH
&&)` and calls it "genuinely mechanism-backed, not just trigger discipline", and the status table row
at `:332`. Both SHALL be rewritten with the label re-derived to **structural**, and the change SHALL
be recorded in the refinement register **before** the implementation lands, not after.

#### Scenario: Overlap is unrepresentable rather than rejected
- **WHEN** an actor with direct SQL access attempts to create two overlapping validity intervals for
  one key
- **THEN** there SHALL be no write that produces overlapping derived intervals, because each
  interval's upper bound is the next event's own `written_at`
- **AND** the attempt SHALL fail for the absence of a writable boundary, not for a constraint
  violation — there is no constraint to name in a failure message

#### Scenario: The formal counterpart is the derivation, not the storage
- **WHEN** the correspondence between this requirement and the mechanised proof is reviewed
- **THEN** non-overlap SHALL be traceable to
  `Formal/Lean/UmbraDBFormal/TemporalKV/Laws.lean:333` `intervals_pairwise_disjoint`, conditioned on
  `WellFormed` (`Model.lean:69-72`) and nothing else
- **AND** the review SHALL record that the Lean layer is unchanged by this migration and that this
  is **evidence of the abstract-to-concrete disconnection, not evidence of safety** — the
  refinement claim is carried by the re-executed conformance suite, not by the proof assistant

#### Scenario: The obligation that disappears is named, not quietly dropped
- **WHEN** the refinement obligations before and after this change are compared
- **THEN** the record SHALL state that today's schema carries an obligation with no counterpart in
  the model — "no stored interval is unrelated to any event", discharged only by the `EXCLUDE`
  constraint — and that under the derived encoding that obligation **disappears** rather than being
  re-discharged
- **AND** the remaining obligation SHALL be stated as exactly one property: `WellFormed`, strictly
  increasing `written_at` per key
