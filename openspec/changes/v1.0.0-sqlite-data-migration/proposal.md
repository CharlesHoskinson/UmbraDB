# Proposal — PostgreSQL→SQLite data migration for the wallet tier

> **Status:** Draft for the SQLite migration program. Capability: `data-migration`. Change id:
> `v1.0.0-sqlite-data-migration`. **Change 7 of the program.** Depends on
> `v1.0.0-sqlite-engine-core` (change 1) for the driver, shim, worker topology, pragma bootstrap and
> the measurement gate; on `v1.0.0-sqlite-temporal-event-log` (change 2) for the target temporal
> encoding; on `v1.0.0-sqlite-schema-parity` (change 4) for the target DDL and the migration
> lineage; and on `v1.0.0-sqlite-durability-contract` (change 5) for the digest regime this change
> verifies through. This change was created after a premise the sprint was costed on was reversed by
> the repo owner; §"Why" item 1 states the reversal and what it invalidated.

## Why

**1. The premise that made this work free has been reversed by the owner, and the evidence that
supported it was evidence of a missing chokepoint, not of missing consumers.**

The research concluded that migrating existing user data cost nothing. Three observations carried
that conclusion: `registry.npmjs.org/umbradb` returns 404, the developer machine has no PostgreSQL
container, and CI has no publish step. The third is still true and I re-verified it — the workflow
set is `bench-smoke.yml`, `conformance.yml`, `lean.yml`, `pack-smoke.yml`, `supply-chain.yml`, and
none publishes. But all three observations are about *the registry*, and **the owner has stated that
consumers install through three channels: the git tag, a repository clone, and docker images.**

Two of those three are documented in the repository's own front door. `README.md:14-17`:

> *Not published to npm yet. Install from the repository until it is:*
> ```bash
> npm install github:CharlesHoskinson/UmbraDB#v0.9.5
> ```

and `README.md:22-26` gives the clone-and-pack path. A git-tag install and a clone install leave no
trace a registry could report, which is exactly why an absent registry entry looked like an absent
consumer. The correct reading is `v1.0.0-sqlite-engine-core/design.md` §8 (correction R-9) R-9, adopted here
verbatim as the premise of this change:

> *UmbraDB has consumers on three distribution channels — **git tag, repo clone, and docker
> images** — and no npm-registry chokepoint through which to reach them. The absence of a registry
> entry is the absence of a chokepoint, not the absence of consumers. A PostgreSQL→SQLite
> data-migration path is therefore required, and is owned by change 7.*

So there are live deployments holding real wallet data in real PostgreSQL databases, and no
mechanism by which a release could reach them other than a written, executable procedure. This
change owns that procedure. Three sibling changes explicitly deferred it to whoever answered the
owner question — `v1.0.0-sqlite-schema-parity`'s data-migration non-goal and its blocking precondition
P3, `v1.0.0-sqlite-durability-contract`'s data-migration non-goal and its boundary criterion N7, and
change 1's dependency table at `design.md` §8's change-7 dependency table. This change is that answer, and §"Impact"
records the reconciliation each of them now needs.

**2. This is a reconstruction, not a copy, because the target schema is not the source schema.**

`v1.0.0-sqlite-temporal-event-log` (change 2) replaces the `kv_current`/`kv_history` pair with a
single append-only `kv_event` table whose `[valid_from, valid_to)` intervals are *derived* by a
`LEAD()` window function and never stored (its requirement *"the event log is the only stored temporal representation and validity intervals are derived, never stored"*). PostgreSQL stores those boundaries
as columns — `valid_from timestamptz`, `valid_to timestamptz`, and a `validity tstzrange GENERATED
… STORED` (`src/postgres/migrations/001_temporal_kv.ts:93-95`). There is no table-to-table copy
available: the live version of every key lives in a *different table* from its history
(`001_temporal_kv.ts:73-83` vs `:86-101`), and the event log must interleave them into one
version-ordered chain per key. The correctness bar is therefore not "the same rows arrived" but
**observational equivalence**: for every key and every instant within retention, the migrated
database must return what the source returned (`Formal/STORAGE_ALGEBRA.md` §1, Law T3).

`v1.0.0-sqlite-schema-parity` (change 4) changes more things a faithful import must honour: the
`identifiers text[]` column plus its GIN index (`004_transaction_history.ts:29,39-42`) becomes a
junction table (its `design.md` §12.1), its invariant **I-7** re-homes the transaction-history read
path onto `entry` with the junction cross-checked against it (its `design.md` §19.2 — the answer to
this change's Q-2), and `listKeys` ordering moves from PostgreSQL collation to
SQLite `BINARY` (its requirement *"listKeys ordering is code-point order and the one-time resume-cursor reorder is disclosed"*), which its own requirement *"listKeys ordering is code-point order and the one-time resume-cursor reorder is disclosed"* already records as a
one-time reorder a migrating consumer will observe.

**3. The source can hold states the target cannot represent, and one of them silently
manufactures data.** Measured on this machine, `design.md` §13:

- PostgreSQL's `kv_history_no_overlap` EXCLUDE constraint (`001_temporal_kv.ts:97-99`) forbids
  *overlap*, not *gaps*. A source whose intervals are `[1000, 2000)` and `[3000, ∞)` is legal there,
  and `getAt({at: 2500})` returns `null`. Imported naively into the event log, the derived intervals
  become `[1000, 3000)` and `[3000, NULL)` and the same query returns **version 1**. The migration
  invents coverage that never existed. Change 2's structural gap-freedom is a genuine strengthening;
  its flipside is that a gapped source is unrepresentable and must be **refused, not coerced**.
- `src/postgres/temporal-kv.ts:231-240` documents in terms that a `kv_history` row can collide with
  the live `kv_current` row, and resolves it with a `priority` tiebreak so `getAt` is deterministic.
  In such a source `get()` and `getAt({version: n})` already disagree, and no single-relation
  encoding reproduces both. That state is also a refusal, not a choice of winner.
- Two versions of one key sharing a millisecond are rejected by change 2's `kv_event_time` unique
  index. They are already impossible in the source — the `CHECK (valid_from < valid_to)` at
  `001_temporal_kv.ts:96` raises SQLSTATE 23514 — but "already impossible" is a property of the
  *adapter's* writes, not of the *database*, and the importer verifies it rather than inheriting it.

**4. Verification is the deliverable; the copy is the easy part.** A consumer must be able to prove
the migration was faithful *before deleting a PostgreSQL database*. SQLite gives no help here:
`v1.0.0-sqlite-durability-contract/design.md` §2 records the coordinator's measurement that
corrupting 64 bytes of a checkpointed main database yields `integrity_check → ok`, `quick_check →
ok`, and the corrupted row returned as data. Re-measured for this change, `PRAGMA integrity_check`
also reports `ok` on a database holding a dangling foreign-key reference, while `PRAGMA
foreign_key_check` names the offending table (`design.md` §13, E4). Verification must therefore be
an explicit, layered obligation with a written statement of what it checks and what it assumes —
and it must reuse change 5's digest regime rather than inventing a second integrity mechanism.

**5. This is the one item in the sprint whose cost the pre-tag window does not reduce.** Every other
break the program makes is cheap because `docs/STABILITY.md:46` says the commitments are not yet in
force and `:60-61` permits a break between `0.9.5` and `1.0.0`. That argument is about *SemVer*. A
consumer's obligation to move a database full of wallet state is an **operations** cost, and it is
identical the day before the tag and the day after. What the tag changes is only the *permission*:
`docs/STABILITY.md:34-42` (commitment 3) already contemplates that "a new UmbraDB **major** MAY ship
a schema change that requires running a forward-only migration … before the new major will operate
against it", so landing at 1.0.0 makes this migration a documented, policy-sanctioned major-boundary
event rather than an exception. Landing it later would additionally force a 2.0.0. Say the cost out
loud rather than letting the sprint's "cheap pre-tag" framing absorb it.

## What changes

1. **A two-phase, file-mediated migration.** Phase 1 *exports* from the live PostgreSQL database
   into a self-describing **migration bundle**. Phase 2 *imports* that bundle into a freshly created
   SQLite database. Phase 3 *verifies*. The phases are separable in time and do not require the two
   databases to be reachable from the same process. `design.md` §7 rules on the export mechanism —
   **SQL text executed by the consumer's own `psql`, not a JavaScript exporter** — and states the
   reasons and the counter-considerations.

2. **The event-log reconstruction rule, stated so a builder cannot get it wrong.** For each key, the
   event chain is the `kv_history` rows in `version` order followed by the `kv_current` row, with
   `written_at` taken from `valid_from` for history rows and from `updated_at` for the live row
   (`design.md` §3). Six source preconditions S1–S6 make that reconstruction equivalent to the
   source, and the importer **verifies every one per key** instead of assuming any of them.

3. **A refusal set, in two classes, and the ruling change 4 handed this change.** A **Class 1** state
   is one the target cannot represent because importing it changes what a caller observes — a gap, a
   history/current version collision, a non-monotone `written_at`, a version chain that is not
   `1..n`, a history row whose key has no `kv_current` row, and an `entry`/column disagreement in
   transaction history. A **Class 2** state is representable but fails a constraint PostgreSQL never
   had: change 4's new migration `008` `UNIQUE (w, net, seq)`, its `next_seq > max(seq)` invariant,
   the 32-byte hash `CHECK`s and the `lifecycle` enum. `v1.0.0-sqlite-schema-parity/design.md` §17.4
   assigns the choice — *"reject the migration, or quarantine and report"* — to this change and
   declines to make it. **The ruling: both classes refuse by default; Class 2 additionally gets a
   remediation report the consumer applies to their own database before re-exporting; quarantine is
   rejected outright** (`design.md` §4.5), because it produces a target that is not observationally
   equivalent while reporting success, has nowhere to put the set-aside rows, and makes the migration
   rather than the consumer the actor that dropped a wallet's manifest.

4. **A verification ladder V1–V5.** V1 through V5a are mandatory; **V5b runs where the source is
   still reachable and is reported as `not run`, never omitted, where it is not.** *(An earlier draft
   of this line said "every rung mandatory", which the spec never said — corrected under G-17; the
   spec is the authority on the split.)* The ladder covers lineage completeness, structural integrity
   (`integrity_check` **and** `foreign_key_check`), cardinality with the derived-table arithmetic
   written out, content digests, and behavioural replay. A check with nothing in scope reports
   `n/a — no rows in scope` and never `pass`. `design.md` §9 states in one table what each rung
   checks and what it assumes.

5. **Point-in-time equivalence verified exhaustively, not sampled.** Both encodings are
   piecewise-constant step functions of the query instant with a *finite* breakpoint set, so
   checking every breakpoint plus one interior point of every gap between consecutive breakpoints is
   equivalent to checking every instant. The probe count is linear in the number of stored versions.
   `design.md` §9.3 gives the argument; sampling becomes admissible only under a stated decision rule
   against change 1's measurement gate.

6. **Content verification reuses change 5's digest regime.** The importer computes change 5's
   per-value digest as it writes — which change 5 requires anyway, "computed and written in the same
   statement as the value" (its requirement *"the value digest is a versioned, length-prefixed, row-bound SHA-256 computed adapter-side"*) — and the migration's table-level commitment is a fold
   over those same digests. Change 5 has since settled the algorithm (SHA-256, 32 raw bytes) and
   change 4 owns the DDL: the `dg BLOB` column that migration `009_value_digests` adds over
   `kv_event.value`, `watermarks.value` and `transaction_history.entry`. This change **does not
   choose a digest algorithm**, does not add a column, does not extend the coverage set, and adds no
   second integrity mechanism or error code. `dg` is computed at import, never transported — and a
   `NULL` `dg` after import is an import defect, not a benign not-yet-computed state.

7. **The source database is read-only, which makes it the rollback.** The migration writes nothing
   to PostgreSQL — no marker table, no `_migrations` row, no `ANALYZE`. A consumer's supported
   rollback is therefore "keep running 0.9.5 against the untouched source", which is *stronger* than
   the "take a backup before a major upgrade" guidance `docs/STABILITY.md:40-42` and
   `docs/CONTRACT.md` §2 offer for an ordinary major.

8. **Atomic publication and unconditional re-runnability.** The target is built under a distinct
   in-progress path and becomes the live database only by a rename that follows a successful
   verification, so an interrupted migration can never present itself as complete. Because the
   target is disposable and the source is untouched, re-running is always safe and always produces
   the same database. Resumability of a *partial* import is deliberately **not** promised
   unconditionally; `design.md` §10 makes it conditional on a duration measured under change 1's gate.

9. **A written procedure per distribution channel**, with the container channel's hazards named
   specifically: the SQLite file must live on a volume rather than the container's writable layer;
   change 5's durability probe **hard-refuses** `tmpfs`, `nfs`, `cifs`/`smb`, `v9fs` and
   un-allowlisted `fuse` (its requirement *"the durability probe verifies library-controlled pragmas instead of deployer-supplied server settings"*), all of which a container can plausibly supply; and an
   entrypoint that runs `runMigrations` against a fresh file before the import has produced one
   boots an empty database that looks like total data loss. `design.md` §12 states what UmbraDB can
   and cannot do here — it builds and publishes **no image**, verified — and §15 Q-1 carries the
   residual to the owner.

10. **Disclosure of the observable differences that survive a faithful migration**, published in a
    migration-notes artifact **before** a consumer runs the migration, not discovered afterwards. Two
    items. The one-time `listKeys` collation reorder (change 4's requirement *"listKeys ordering is code-point order and the one-time resume-cursor reorder is disclosed"*). And — not the
    `identifiers` array, which change 4's I-7 ruling preserves byte-for-byte by deriving it from
    `entry` — the **`lifecycle` agreement fault**: today `decodeRow` takes the lifecycle object from
    the JSON (`src/postgres/transaction-history-storage.ts:243`) while the `lifecycle` column is
    selected (`:329`, `:358`, `:462`) and never compared, so the two can already have drifted with
    nothing ever raising an error. Under I-7 that disagreement becomes a detected, non-retryable
    fault. Both items are consequences of invariants that make the store *stricter*, and the notes
    say so rather than listing them as damage.

11. **A specified test fixture, and an honest label on every PostgreSQL-side claim.** No live
    PostgreSQL exists on this machine and none was run for this change; `design.md` §0.2 says so
    plainly and every source-side statement in this change is marked as citation-from-code or
    inference, never as measurement. §14 specifies the two fixtures a builder needs: a *faithful*
    fixture seeded through the 0.9.5 public API, and an *adversarial* fixture seeded by raw SQL to
    produce each refusal state.

## Non-goals (explicitly out of scope)

- **The chain archive's data.** There is none to move: `archive:sync` has never been run against a
  real database (owner answer), so the archive lineage begins life empty. `v1.0.0-sqlite-chain-archive`
  (change 6) ports the archive to SQLite as a **greenfield lineage**, and a lineage with zero rows
  needs no import. This change therefore covers the **wallet tier only**, and the reason is the
  absence of rows, not the absence of a runner — the archive *is* wired (`package.json:46` exposes
  `archive:sync` → `chain-archive-sync/sync-cli.ts` → `bootstrap.ts:21`'s
  `runMigrations(sql, { schema, migrations: chainArchiveMigrations })`, and `sync-service.ts`
  constructs `PgChainArchiveStore`). If the owner's answer on archive data ever changes, an archive
  import is a new change, not an amendment to this one.
- **The target DDL.** The `kv_event` table, its triggers and the `kv_validity` view are change 2's
  (`design.md` §2, `:237-256`); every other table, its prefixing, its `STRICT` declaration, its
  `CHECK` constraints and the migration lineage are change 4's (`design.md` §12.1). This change
  states what an import requires *of* that DDL and authors none of it.
- **The digest algorithm, the verification-pass API, backup/restore, the durability probe, the error
  catalog and observability.** All change 5's. This change consumes `verifyIntegrity` as change 5
  designates it — "the post-restore step" (its requirement *"the verification pass runs the structural check, the digest sweep, the schema digest and the invariants together, and never refuses"*) — and does **not** pick the hash, does
  not add an error code, and does not re-open `docs/CONTRACT.md` §6.
- **The driver, the tagged-template shim, bind normalisation, `columns()` origin-metadata decoding,
  the worker topology, the pragma bootstrap order and the measurement gate.** All change 1's. This
  change writes through them and specifies none of them.
- **A reverse SQLite→PostgreSQL migration.** It is mechanically possible — `kv_current` and
  `kv_history` are both derivable from the event log by the same `LEAD()` that derives the intervals
  — but at 1.0.0 there is no PostgreSQL adapter to migrate *into*, so it would have no consumer, no
  test surface and no way to stay correct. The supported reverse direction is the untouched source
  database (§"What changes" item 7).
- **A dual-backend or compatibility mode.** The program's decision is full replacement; `src/postgres/`
  is deleted. This change does not preserve a PostgreSQL code path, and does not add a runtime switch.
- **A zero-downtime or online migration.** The procedure quiesces writers on the source. UmbraDB is
  single-writer by contract (`docs/CONTRACT.md` §5, `ROADMAP.md:499-501`), so "quiesce writers" means
  "stop the one application process", which is a materially smaller ask than it would be for a
  multi-writer store. No replication, no change-data-capture, no cutover window is specified.
- **Building or publishing a container image.** UmbraDB builds none today: a search of the repository
  for any `Dockerfile`, compose file or image-publishing step returns nothing outside
  `package-lock.json`'s transitive `docker-compose` entry (pulled in by Testcontainers) and design
  documents referencing *Midnight upstream* images. This change writes the procedure an image builder
  follows; it does not acquire an image to change.
- **Any addition to the frozen public barrel.** Change 5's its data-migration non-goal requires that a
  migration path, if built, be "built outside the frozen surface", and `v1.0.0-api-surface` froze that
  surface deliberately. The migration is a repository-resident tool and a set of SQL files, reachable
  by `npm run`, not by `import { … } from "umbradb"`.
- **Encryption at rest, network filesystems, and Windows-specific behaviour.** No lane covered them.
  This change names the container-volume filesystem hazard because change 5's probe hard-refuses on
  it, and claims no coverage beyond that.
- **Any assertion of a migration duration, throughput or row rate.** Six of seven research lanes
  benchmarked against a tmpfs RAM disk; the one re-measurement moved WAL `synchronous=FULL` from a
  published 88,485 commits/s to 379. Every performance-dependent statement here is an obligation to
  *establish* a number under change 1's declared conditions, never an assertion of one. The database
  files this change measured against live on `/root` (ext4), never `/tmp`.

## Impact

- **New files.** `openspec/changes/v1.0.0-sqlite-data-migration/{proposal,design,tasks,acceptance}.md`
  and `specs/data-migration/spec.md`. On implementation: a migration tool directory outside `src/`, a
  set of `.sql` export files, a migration-notes document under `docs/`, and fixtures under `test/`.
  No file under `src/` or `test/` changes in this OpenSpec change; it is a specification.
- **Modified documents (on implementation, not here).** `README.md`'s install section gains an
  upgrade pointer; `docs/CONTRACT.md` §2 gains a sentence recording that the 0.9.5→1.0.0 engine
  change is a forward migration under commitment 3, cross-referencing §6's rewrite (change 5's);
  `CHANGELOG.md` records the migration as a required consumer action.
- **Frozen-surface breaks: none.** This change adds no export, no type and no error code. It is built
  outside the frozen surface by construction.
- **Cross-change reconciliations this change forces**, each of which an auditor will otherwise read
  as a contradiction:
  - `v1.0.0-sqlite-durability-contract`'s boundary criterion N7 criterion **N7** — *"No PostgreSQL-to-SQLite
    data-migration path is built or promised"* — must be re-scoped to change 5's own deliverables, or
    restated as "change 5 builds none".
  - `v1.0.0-sqlite-schema-parity`'s data-migration non-goal's non-goal, its precondition **P3** and its task
    **0.3** are all conditioned on the owner question; the owner has answered, so their condition is
    discharged and their pointer must name this change.
  - `v1.0.0-sqlite-schema-parity/design.md` §17.4 states that this change must decide what happens to
    rows failing migration `008`'s new constraint and *"does not decide that; it states the
    obligation."* `design.md` §4.5 discharges it. Change 4's §19.2 likewise answers this change's
    Q-2; that question is now closed and its consequences are folded through §1.4, §4.5, §5.3, §9.5
    and §11.4.
  - `v1.0.0-sqlite-engine-core`'s task 1.1 removes the `postgres` dependency outright. This
    change's export mechanism (`design.md` §7) is chosen so that removal is unblocked: the export
    runs on the consumer's own `psql`, so UmbraDB never re-acquires a PostgreSQL client and the
    ordering hazard disappears.
- **Risk.** The largest is a *silent* one: a migration that passes row counts and digests while
  having changed what a point-in-time read returns. The gap-manufacture case (§"Why" item 3) is
  exactly that shape, is measured, and is written as a negative-control scenario. The second-largest
  is that this change cannot be tested against a live PostgreSQL on this machine; it is mitigated by
  specifying the fixtures rather than by asserting the behaviour, and by labelling every source-side
  claim as citation or inference.
- **Delivery cadence.** This change cannot begin implementation before changes 1, 2, 4 and 5 have
  settled the halves it depends on; that ordering is recorded in change 1's `design.md` §8's change-7 dependency table and
  restated in `tasks.md` Phase 0.
