# Proposal — TemporalKV on SQLite: the event log replaces the interval table

> **Status:** Draft for the 1.0.0 PostgreSQL→SQLite migration program. Capability: `temporal-kv`
> (**MODIFIED** — this is the only change in the program that deltas a *merged* spec,
> `openspec/specs/temporal-kv/spec.md`). Change id: `v1.0.0-sqlite-temporal-event-log`. Change 2 of
> 5. Depends on `v1.0.0-sqlite-engine-core` (change 1) for the driver, the connection/handle
> lifecycle, the pragma bootstrap **and the blocking measurement gate this change's clock policy is
> conditional on**.

## Why

TemporalKV is the module the migration cannot transliterate. Three of the four mechanisms that
carry its frozen laws today are PostgreSQL-only, and each fails in a different way:

1. **`EXCLUDE USING gist (ns WITH =, scope WITH =, key WITH =, validity WITH &&)`**
   (`src/postgres/migrations/001_temporal_kv.ts:97-99`) is the *only* thing in this project that
   `Formal/STORAGE_ALGEBRA.md:216-217` calls "genuinely mechanism-backed, not just trigger
   discipline." SQLite has no exclusion constraints, no range types, no GiST — and, measured, **no
   subqueries in `CHECK` constraints or generated columns at all** (L1 E0). Nothing declarative
   replaces it. The honest transliteration — a `BEFORE INSERT` trigger doing an overlap `EXISTS`
   probe over the key's whole history — is **quadratic**: 1,441× slower than the unconstrained
   floor, 708 rows/s and still falling at 50k versions (L1 E4). It is not a candidate.
2. **`txid_current()`** (`:80`, `:117`, `:120-124`) backs the same-transaction key-reuse guard that
   `Formal/STORAGE_ALGEBRA.md:78-95` calls "the correct, mechanical detector." SQLite exposes no
   SQL-visible transaction identity of any kind (L1 E0: no `sqlite3_txn_state` binding, no
   `pragma txn_state`, no `txid_current()`), and the best SQL-derived substitute is defeated by one
   extra `INSERT` (L1 E9a). `TRANSACTION_KEY_REUSE` — a frozen `code`
   (`docs/ERROR-CATALOG.md:25`) — moves from database-enforced to adapter-enforced.
3. **`date_trunc('milliseconds', clock_timestamp())`** (`:79`) is correct on SQLite in *scoping*
   (`unixepoch('now','subsec')` is statement-scoped, not transaction-scoped — L1 E1.2) and in
   *resolution* (a hard 1.000 ms, which is exactly what UmbraDB already truncates to — L1 E1.1).
   What changes is the write rate underneath it, and that is where the sprint's evidence broke; see
   "the clock is not settled" below.

But there is a fourth fact, and it is the reason this change is a redesign rather than a salvage
operation. `Formal/Lean/UmbraDBFormal/TemporalKV/Model.lean:57-62` does not store intervals. It
defines

```lean
def validityIntervals : History Value Time → List (ValidityInterval Time)
```

as a *projection of an event list*. The Postgres schema materialises what the model derives, which
creates a refinement obligation with no counterpart in the model at all ("no stored interval is
unrelated to any event"), discharged today only by the GiST constraint. **Storing the event log and
deriving `[valid_from, valid_to)` with `LEAD()` is that Lean definition compiled to SQL.** It
removes the obligation instead of re-discharging it, and it makes two things structural that are
not structural today:

- **T5(1) non-overlap** stops needing enforcement. `LEAD()` over a strictly increasing column
  cannot produce overlapping intervals for any row the table can hold.
- **T5(2) gap-freedom** — status **CALLER-ENFORCED** today, by
  `Formal/STORAGE_ALGEBRA.md:227-231`'s own admission ("holds only as long as the trigger remains
  the sole writer of `valid_from`"; `:333`'s status row says the same) — becomes **structural**.
  There is no column that could hold a discontiguous boundary. This is a genuine strengthening of a
  property inside the frozen 1.0.0 Lean cut-line `{T3, T5, W1, C1}`, and it is the enhancement this
  change exists to deliver.

  **With a boundary condition that is part of the claim, not a caveat bolted onto it.**
  Unrepresentability cuts both ways: an encoding in which a gap cannot be written is one into which a
  gap cannot be *read*. PostgreSQL's `EXCLUDE` constraint forbids overlap and — per
  `Formal/STORAGE_ALGEBRA.md:218-231`, which is why T5(2) is CALLER-ENFORCED in the first place —
  "says nothing about gaps", so a gap-bearing source is legal. Convert `[1000,2000)` plus a live row
  at `3000` into the event log and `getAt({at: 2500})` changes from `null` to version 1: coverage
  that never existed. `v1.0.0-sqlite-data-migration` measured that row counts, per-row digests **and
  every assertion this change specifies** pass while it happens. The strengthening stands for data
  written through the adapter; converting a gap-bearing source is a **lossy transformation**, and
  this change specifies that as a first-class requirement so that "gap-freedom is structural" is
  never read as a licence to import unchecked.

**The whole redesign is cheap if and only if it lands pre-tag.** `docs/STABILITY.md:46` states
verbatim: *"**Current version: `0.9.5` — the commitments above are NOT yet in force.**"*, and
`:60-61` that *"a breaking change between `0.9.5` and `1.0.0` is permitted by SemVer."* Landing
pre-tag, this change's breaks cost a CHANGELOG entry and a rewritten `Formal/STORAGE_ALGEBRA.md`
§1. Landing post-tag, two of them independently force a major version: `CLOCK_REGRESSION` narrowing
from `conditional` to `non-retryable` is a forbidden *weakening* of a `retryable` marking
(`docs/ERROR-CATALOG.md:13`, and the commitments seat's §4 item 2 — no research lane caught it),
and any change to the frozen `writtenAt: Date` field (`src/interfaces/temporal-kv.ts:153`, pinned to
`VersionedEntrySchema` at `:143` by the `AssertExact` guard at `:156-163`) breaks every consumer
call site.

## What changes

1. **Schema.** `kv_current` + `kv_history` are replaced by one table, `kv_event`
   `(ns, scope, key, version, value, written_at)`, plus a `kv_validity` view that derives
   `valid_from = written_at` and `valid_to = LEAD(written_at) OVER (PARTITION BY ns, scope, key
   ORDER BY version)`. The `getAt` `UNION`-with-`priority` defence
   (`src/postgres/temporal-kv.ts:230-260`) disappears with the two-table split that made it
   necessary.
2. **T5(1) becomes structural**; the `EXCLUDE` constraint has no replacement because it needs none.
   The naive transliteration is explicitly **prohibited** in the spec so nobody re-proposes it.
3. **T5(2) becomes structural** — the enhancement — with a scenario proving a gap is
   *unrepresentable*, and a negative control describing the interval-table design that accepts one.
4. **`WellFormed` becomes the single remaining refinement obligation.** Two `BEFORE INSERT` trigger
   assertions (version is exactly `prev + 1`; `written_at` strictly exceeds the previous version's)
   plus a `BEFORE UPDATE`/`BEFORE DELETE` append-only assertion. This is
   `Model.lean:69-72`'s `WellFormed` and nothing else.
5. **The clock policy is specified as conditional, not settled.** L1 reported that SQLite's 1.000 ms
   SQL clock makes **99.2%** of sequential same-key puts reject with a clock error. The red team
   re-ran the same experiment across four durability configurations on ext4 and measured that same
   rate as **0.0% at `synchronous=FULL`** (5,000/5,000 accepted, because a commit costs 7.2 ms and
   two puts cannot then share a millisecond). The entire clock crisis — the per-key monotone logical
   clock, its ~1.8 s drift, the coupled `CLOCK_REGRESSION` re-pointing — is downstream of a pragma
   L1 never varied and never named. This change therefore specifies a **decision rule** keyed to the
   measurement gate owned by `v1.0.0-sqlite-engine-core`, and specifies that no implementation task
   depending on the policy may start before the gate reports.
6. **The transaction-identity guard moves to the adapter**, with a precisely bounded statement of
   what remains guaranteed and by what. The red team's forgery attack **failed** — but the credit
   belongs to UmbraDB owning the transaction handle, not to any SQL mechanism, so the guarantee has
   a named voiding precondition rather than a mechanism.
7. **Four adapter-level bans**, each with a scenario: `INSERT OR REPLACE` (silently skips
   `BEFORE UPDATE` triggers and would lose history rows — L1 E10); `RAISE(ROLLBACK)` (drops the
   connection into autocommit, a strictly worse failure than `RAISE(ABORT)` — L1 E7a); splitting one
   logical put across two statements; and shared-cache / `PRAGMA read_uncommitted`, which would
   void the concurrency result T5 enforcement rests on.
8. **`listKeys` is re-specified, keeping all three merged promises, and it carries a second
   strengthening.** *At most once per key* survives with a new derivation (there is no `kv_current`
   to read it from) and a new hazard: a materialising `DISTINCT` plan would defeat lazy iteration
   *below* the driver, where no transport choice can rescue it. *Ordering* survives as a property but
   **is a different order** — Postgres collation → SQLite `BINARY` — so a resume cursor persisted
   under the old ordering is not portable, and `BINARY` (code-point) order disagrees with
   JavaScript's UTF-16 code-unit comparison on supplementary-plane keys. *Incremental delivery*
   survives intact: `v1.0.0-sqlite-engine-core` measured its ruled binding's `iterate()` as genuinely
   lazy, so the promise needs no weakening. The strengthening is in **stream liveness**: an open
   iterator makes the handle refuse writes, which under a single-handle topology would let a consumer
   that simply stops iterating wedge every writer in the process — where PostgreSQL only leaked a
   pooled connection. Change 1 moves liveness from the consumer to a worker-enforced idle deadline,
   so **an abandoned stream becomes a failed read instead of a stalled writer**. This change claims
   that, and adds the correctness clause only this lane would catch: a deadline release must surface
   as a *fault*, never as a normal ending, or `listKeys` silently returns a truncated key set. See
   `design.md` §10.3.
9. **`opts.tx` is honored, not refused.** The merged requirement mandating that any caller-supplied
   `TransactionHandle` be rejected with *"transaction participation not yet supported"* was
   explicitly scoped *"Until the Transaction/Lease module's real wiring lands (a later sprint)"* —
   and `v1.0.0-sqlite-concurrency-lease` lands it in this same sprint. Left as written, the merged
   spec would require an implementation to refuse the feature another change in the sprint delivers.
   This change re-points it: honored when live, rejected with `TransactionHandleInvalidError` before
   any statement when not, and **never** accepted-then-run-outside — the one clause of that
   requirement that was never sprint-scoped. Transaction semantics are cited to change 3, not
   restated.
10. **Evidence obligations.** The refinement register row is rewritten **before** the port, not after
   (commitments seat R4(iv)(6)); P1–P5 are **re-executed, not amended**; and every property whose
   enforcement mechanism changed ships a negative control, because a re-executed test after a
   migration is precisely the situation in which a test goes green for the wrong reason.

## Non-goals (explicitly out of scope)

- **The chain archive is owned by `v1.0.0-sqlite-chain-archive` (change 6), not by this change.**
  This change specifies, costs and schedules nothing about it, and consumes nothing from it: the
  `temporal-kv` capability and the archive lineage share no table, no trigger and no transaction.
  *(An earlier revision of this bullet asserted a program-wide exclusion of the archive, reasoning
  from a stale source comment about its wiring state. That premise is retracted — the archive is in
  the program's scope and change 6 owns it. Corrected under audit gate G-1; neither the premise nor
  its supporting inference is restated anywhere in this change.)*
- **The driver, the tagged-template shim, the pragma bootstrap order, the worker-thread topology,
  the measurement gate itself, and the incremental-read transport behind `listKeys` (driver iterator,
  batch policy, and how an abort reaches a mid-stream scan) are `v1.0.0-sqlite-engine-core`'s**
  (change 1). This change *consumes* the gate's output and states the decision rule; it does not
  author the gate, does not choose the driver, and does not specify the streaming mechanism — it
  states what `listKeys` still promises a caller once that mechanism exists.
- **Transactions, the lease, `busy_timeout`/retry policy, sticky-poison emulation, the
  transaction-hold bound and the contention error-code mapping are
  `v1.0.0-sqlite-concurrency-lease`'s** (change 3). This change deltas the merged requirement *"A
  caller-supplied transaction handle is honored or rejected, never silently ignored"* — because it
  lives in this capability and change 3 structurally cannot reach it (its deltas resolve against
  `specs/transaction-lease/`) — but it specifies only what `TemporalKV` does with a handle. It does
  **not** specify what a transaction *is*: begin/commit/rollback, isolation, the lease and the hold
  bound are cited to change 3, never restated.
- **Table-name prefixing (which preserves `DEFAULT_SCHEMA`), `STRICT` tables, JSON storage and
  `json_valid` validation, the `listKeys` prefix-matching mechanism, and the migration framework are
  `v1.0.0-sqlite-schema-parity`'s** (change 4). This change's DDL sketch is written *unprefixed and
  untyped-strict* on purpose; change 4 supplies both. Consequently the merged spec's two
  infrastructure requirements — *"Migrations are idempotent and ordered"* and *"Schema isolation is
  the default, not opt-in"* — are **not deltaed here** even though they live in this capability's
  spec file. **This is a named seam, not an oversight:** see `design.md` §0.3 for the residual risk
  and the recommended resolution.
- **The written contracts, the error catalog's names and `retryable` markings, backup/restore, the
  durability probe, application-level checksums and observability are
  `v1.0.0-sqlite-durability-contract`'s** (change 5). Where this change's mechanism forces a catalog
  consequence (`EXCLUSION_VIOLATION` becomes unreachable; `CLOCK_REGRESSION`'s causes change), it
  **states the consequence and hands it to change 5** rather than rewriting the catalog.
- **The PostgreSQL→SQLite data conversion itself is `v1.0.0-sqlite-data-migration`'s** (change 7):
  the per-key verification of its six preconditions — including **S3**, `valid_to(v) =
  valid_from(v+1)`, to which it has reduced the reconstruction's correctness — and the value
  transport that carries `jsonb`'s own text rather than a JS round trip. This change specifies the
  **semantics** that verification exists to protect (what the encoding can faithfully carry, and what
  a T3 claim does and does not mean across a conversion) and cites change 7 for the mechanism. It
  does not specify an importer, a preflight, or a repair procedure.
- **Retention / history pruning is not implemented here and remains unimplemented.**
  `src/postgres/temporal-kv.ts:224` records that *"Sprint 1 performs no history retention at all"*;
  `HistoryUnavailableError` (`src/interfaces/temporal-kv.ts:219-229`) stays exported and
  unreachable. L1's `kv_retention` floor table is left out deliberately: adding a retention
  mechanism is new capability, and this change is a storage-representation change.
  *(Reworded under gate G-2's widened phrase list — the prior wording justified the exclusion by
  inferring from an artifact's apparent disuse, which is the reasoning form that produced the
  retracted archive premise. The exclusion stands on the two cited repository facts above; it never
  needed the inference.)*
- **Mechanising the abstract→concrete refinement in Lean is not in scope.** The event-log encoding
  makes that obligation small enough to attempt for the first time — that is a *finding*, recorded
  in `design.md` §5.3, not a deliverable here.
- **No `src/`, `test/` or product-code change ships in this OpenSpec change.** It is a
  specification. The DDL and SQL in `design.md` are sketches with measured provenance, not the
  final migration file.

## Impact

- **Frozen surface (G1):** unchanged. `TemporalKV`'s five method signatures, `VersionedEntry`,
  `AsOf`, `Version`, and the three `TemporalKVErrorCode` values (`src/interfaces/temporal-kv.ts:183`)
  all survive byte-for-byte. `writtenAt: Date` is deliberately **not** widened; see `design.md` §6.4.
- **Frozen error catalog (G3):** two consequences, both handed to change 5.
  `EXCLUSION_VIOLATION` — *"A Postgres exclusion constraint fired (23P01)"*
  (`docs/ERROR-CATALOG.md:41`) — becomes unreachable from this module. `CLOCK_REGRESSION`
  (`:42`, `:73-89`) keeps its same-millisecond cause **only if** the gate rules against the logical
  clock; if the logical clock is adopted, a bounded-drift check must supply a second live cause or
  the `conditional` marking narrows to `non-retryable`, which `:13` forbids.
- **`listKeys`'s observable contract:** all three merged promises are kept, and stream liveness
  improves (an abandoned stream fails the reader instead of stalling every writer). One
  caller-observable behaviour does change: the ordering moves from the database collation to
  `BINARY`, so a **persisted resume cursor is not portable across the migration**. That is free
  before the tag and a documented-behaviour break after it, so it rides the same
  `docs/STABILITY.md:46` clock as everything else in the ledger.
- **`opts.tx` on `TemporalKV`:** the merged refusal requirement is retired in favour of honoring.
  This is a behaviour change to a merged spec requirement, not to the frozen type surface —
  `TransactionHandle` and `TransactionHandleInvalidError` (`src/interfaces/transaction-lease.ts:26-29`,
  `:126-132`) are unchanged, and the latter's frozen doc already anticipated methods outside the
  lease layer throwing it.
- **Frozen formal cut-line (G20):** zero Lean lines change. `Formal/STORAGE_ALGEBRA.md:209-231` and
  the status table at `:332-333` are rewritten: T5(1) `MECHANISM SPECIFIED` → **structural**;
  T5(2) `CALLER-ENFORCED` → **structural**. Per trap 9 and the red team's §4.8, the Lean gate's
  continued greenness across this migration is **evidence of disconnection, not of safety**, and no
  requirement or task here cites it as assurance.
- **Deleted:** `kv_current`, `kv_history`, the `validity` generated column, `kv_history_no_overlap`,
  `kv_history_range`, `kv_current_history_trigger`, `kv_current_history_bu`, and the `getAt` `UNION`
  + `priority` tiebreak.
- **Risk.** The dominant risk is *specifying the logical clock as settled*. Its costs are real and
  paid regardless of whether the problem it solves exists: `writtenAt` ceases to be a wall clock and
  can run ahead of it, and it forfeits the same-transaction guard that the 1 ms clock resolution
  currently provides by accident (L1 B4: "you cannot take B3's fix without paying B4's cost"). The
  mitigation is the decision rule in §6 and the requirement that no dependent task starts before the
  gate reports.
- **Delivery cadence:** matches the sprint — proposal/design/tasks/acceptance/spec drafted and
  reviewed first, then a builder implements against it with independent audit.
