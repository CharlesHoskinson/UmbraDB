# Proposal — SQLite schema parity: the data model, the constraints, the migration framework

> **Status:** Draft for the 1.0.0 program. Capability: `storage-schema`. Change id:
> `v1.0.0-sqlite-schema-parity`. Change **4 of 5** in the PostgreSQL→SQLite migration sprint.
> Depends on `v1.0.0-sqlite-engine-core` (change 1) for the driver, the shim's decoding, the pragma
> bootstrap and the blocking ext4 measurement gate. Consumed by `v1.0.0-sqlite-temporal-event-log`
> (change 2) and `v1.0.0-sqlite-concurrency-lease` (change 3), both of which write DDL and must
> write it through the naming layer this change defines.

## Why

UmbraDB's persisted shape is Postgres-shaped in ways that are invisible until the engine changes.
Six of those ways are load-bearing and four of them fail **silently** if transliterated:

1. **Namespaces.** `000_schema.ts:13` issues `CREATE SCHEMA IF NOT EXISTS <schema>`; every
   migration and every adapter query is schema-qualified through `sql(schema)`; `client.ts:14`
   exports `DEFAULT_SCHEMA = "umbradb"` and `src/index.ts:40` re-exports it as **frozen G1
   surface**. SQLite has no `CREATE SCHEMA` and no `SET search_path` (lane L4 measured both as
   syntax errors). The naive reading — "the schema parameter becomes meaningless, so the export has
   to go" — is wrong, and this change rules against it: table-name prefixing preserves
   `DEFAULT_SCHEMA`, its type, and every adapter's `schema` constructor parameter **byte-for-byte**.
   What it does not preserve is a detail nobody would guess: **index and trigger names are global
   per database file**, not per table (L4 measured `index dup_name already exists` and
   `trigger tn already exists`). Prefix the tables and forget the indexes and you get a migration
   that works for one schema value and fails for the second.

2. **Type enforcement.** Postgres gave column typing for free. SQLite's dynamic typing does not:
   L4 measured a non-`STRICT` `INTEGER` column accepting the string `"notanint"` and storing it as
   text. The contradiction seat then found the case that turns this from hygiene into correctness —
   an ISO-8601 `Date` bound into an `INTEGER` timestamp column is stored as text, every `INTEGER`
   sorts before every `TEXT`, and `getAt(at)` returns the **latest** version for every `at`, always,
   with no error. That is Law T3 silently false. `STRICT` converts it into a loud
   `cannot store TEXT value in INTEGER column`. This change makes `STRICT` mandatory.

3. **Array containment.** `004_transaction_history.ts:29,39-42` stores `identifiers text[]` with a
   GIN index, and `transaction-history-storage.ts:521-522` runs
   `array_length(identifiers, 1) > 0 AND identifiers <@ <finalizing set>`. SQLite has neither array
   types nor GIN. The replacement is a junction table — and the containment **direction** is the
   single easiest thing in this change to get backwards. `<@` is *contained-by*: the pending row's
   set must be a subset of the finalizing entry's set. Inverting it to `@>` is not a performance
   bug, it is a wrong-rows-deleted bug, and on L4's own fixture the two directions return disjoint
   answers.

4. **A bug a prior audit already caught.** `UNIQUE NULLS NOT DISTINCT`
   (`chain_archive/001_chain_archive_core.ts:570`) exists because ordinary `UNIQUE` treats every
   NULL as distinct and therefore **would not catch** a duplicate protocol-scoped observation whose
   `contract_address` is NULL. SQLite's `UNIQUE` matches Postgres's *default*, not `NULLS NOT
   DISTINCT` (L4 measured both halves). A transliteration is therefore a silent regression to the
   exact defect the v4 chain-archive audit found and documented at `001_chain_archive_core.ts:63-70`
   ("a real data-loss bug: two legitimate different-entry-point observations of the same VK collided
   and one was lost").

5. **`listKeys`.** `temporal-kv.ts:317-323` builds `escapeLikePrefix(prefix) + "%"` and runs
   `key LIKE ... ESCAPE '\'`. SQLite's `LIKE` is **case-insensitive for ASCII by default** — L4
   measured `LIKE 'ab%'` returning `Abc` — *and* `EXPLAIN QUERY PLAN` shows it does not use the key
   column for an index range. Both wrong and slow, and wrong quietly.

6. **The bind-parameter ceiling.** `checkpoint-store.ts:62-63` sets `CHUNK_INSERT_MAX_ROWS =
   30_000` and `JUNCTION_INSERT_MAX_ROWS = 20_000`, each derived from postgres.js's 65,534-parameter
   limit and each binding **60,000 parameters**. `SQLITE_MAX_VARIABLE_NUMBER` is **32,766** (L4 and
   L5 measured it independently, from `pragma compile_options` and by a failing statement). Both
   shipped caps would fail as written.

The window matters. `docs/STABILITY.md:46` states verbatim: *"**Current version: `0.9.5` — the
commitments above are NOT yet in force.**"* and `:60-61` that a breaking change between `0.9.5` and
`1.0.0` is permitted. **Everything in this change is cheap if and only if it lands pre-tag.** The
per-item post-tag cost is stated in `design.md` §13 — and honestly: for *this* change the pre-tag
window buys less than an earlier reading claimed, because the migration-`006` "blocker" turned out
not to be one (`design.md` §10).

## What changes

1. **A schema-emulation naming layer** (`design.md` §1). `<schema>_` prefixing of every table,
   **every index and every trigger name**, replacing `CREATE SCHEMA` + `search_path`.
   `DEFAULT_SCHEMA`, its type, and every `schema` constructor parameter survive unchanged — this is
   **not a G1 surface break**, and this change says so explicitly and rules against the
   one-file-per-schema `ATTACH` alternative (foreign keys cannot cross attached files; the attach
   limit is 10 plus `main` — both L4-measured).

2. **`STRICT` on every table**, with the declared-type vocabulary restricted to
   `INT`/`INTEGER`/`REAL`/`TEXT`/`BLOB`/`ANY`, and the Postgres type-class mapping that follows
   (`jsonb`→`TEXT` verbatim, `bytea`→`BLOB`, `timestamptz`→`INTEGER` epoch-ms, `boolean`→`INTEGER`
   + a domain `CHECK`, `bigserial`→`INTEGER PRIMARY KEY AUTOINCREMENT`).

3. **`CHECK` constraints that recover domain guarantees**, several of which are *stronger* than what
   Postgres enforced (`octet_length(hash) = 32` was never enforced by `bytea`), all **named** so the
   constraint name reaches the error message.

4. **The identifiers junction table**, its two indexes, its two-phase index-driven containment
   `DELETE`, and the direction stated as a testable invariant in both directions.

5. **A `coalesce()` expression-index emulation of `UNIQUE NULLS NOT DISTINCT`**, plus the sentinel-
   collision `CHECK` the naive form of that fix omits.

6. **A half-open range scan for `listKeys`**, deleting `escapeLikePrefix`, with a precisely
   specified successor computation and the collation/resume-cursor consequences recorded.

7. **The forward-only migration framework, ported and preserved.** `_migrations` prefixed;
   `to_regclass` → `sqlite_schema`; `up()`-only preserved (`docs/CONTRACT.md` §2 unchanged in
   substance); migration `006` transliterated **verbatim including `STORED`**, because it replays on
   a fresh lineage; migration `005` retained as a recorded no-op so lineage identity is preserved.

8. **A new migration `007_writer_generation`, creating *and seeding* the table change 3's
   cross-process writer guard reads.** Change 3 owns the guard's protocol, and its dependency row
   **D-4** (`v1.0.0-sqlite-concurrency-lease` design, dependency table) defers its physical name and prefixing
   here; an earlier draft of this change pushed the whole mechanism back to change 3, leaving a
   table that two changes described and neither created. It is created here, carrying every
   invariant this change imposes on the rest of the schema — the `qualify()` prefix, `STRICT`, named
   `CHECK`s — because §1's rule that all three file-global namespaces go through one function is
   falsified by a table outside the lineage. **The seed row is part of the migration**: change 3's
   registration is an `UPDATE … WHERE id = 1`, which against an empty table matches zero rows,
   returns no generation, and raises nothing — a guard that silently guards nothing.

9. **A fix for a live integrity gap in the *current PostgreSQL* schema**, found by the R-3
   corruption-modes seat. A single corrupted byte in `ckpt_sequence_counters.next_seq` makes
   `save()` allocate a sequence below the existing maximum; `load()` selects
   `ORDER BY seq DESC LIMIT 1` (`checkpoint-store.ts:328-334`), so the wallet saves new state, gets
   no error, and reads back a stale checkpoint with every digest passing — permanently. The bytes
   are intact; the *reachability* is wrong, which no per-value digest can see. `002` has no
   `UNIQUE (w, net, seq)` and nothing relates `next_seq` to `max(seq)`, so **the gap is in
   PostgreSQL today** and this is the first opportunity to close it. The fix is a **mandatory
   runtime invariant** (`next_seq > max(seq)`) plus a **full** `UNIQUE (w, net, seq)` as
   defence-in-depth — full rather than partial because a partial index would condition integrity on
   a corruptible predicate, and the invariant rather than the constraint because the constraint
   alone provably misses the case where the corrupted value lands in a gap (`design.md` §17).

10. **A digest over `sqlite_schema`, recorded at migrate time.** Corrupting a `CHECK`'s stored text
    leaves `integrity_check` reporting no fault while the weakened constraint admits values it
    should reject — so the whole `STRICT`/named-`CHECK` regime this change sells as guarantees sits
    in an unchecksummed region of the file it protects. This change owns the artifact; *when* it is
    verified and what a mismatch raises are change 5's. Documented as corruption detection, **not**
    tamper protection, since the digest shares the file (`design.md` §18).

11. **Two of the R-3 mandatory Class B/C invariants — I-5 and I-7** (`design.md` §19). **I-5**, the
    migration-lineage law: every DDL-issuing migration begins with non-idempotent DDL, so a lineage
    whose bookkeeping is damaged **fails loudly on re-entry** instead of silently re-applying. The
    repo already reasons this way at `000_schema.ts:6-9`; I-5 generalises that one comment into a
    checkable law, with exactly one registered exemption (`005`, which issues no DDL and therefore
    cannot be partially applied). **I-7**, the transaction-history read-path cross-checks — and with
    it **the answer to change 7's Q-2**: today `getAll()` reads identifiers from the *denormalised
    column* (`transaction-history-storage.ts:238`), so post-migration a literal port would read the
    junction and half of I-7 would **not** be free. The ruling is to derive from `entry` — the
    representation the `dg` digest covers — and verify the junction against it, a derived index
    being something to verify rather than trust.

12. **The wallet-tier `dg BLOB` digest columns** (migration `009_value_digests`), added under this
    capability's conventions: nullable with no default, a named
    `CHECK (dg IS NULL OR octet_length(dg) = 32)`, and drift-guard trigger names through
    `qualify()` — the third time the file-global-trigger-namespace rule has caught a cross-change
    artifact. Change 5 owns the digest itself; change 6 owns the archive tables.

13. **Deletion of the two bulk-insert row caps and their sub-batch loops** — not a retune to
    16,383/10,922. Prepared-statement reuse has no parameter cap at all.

14. **A rule against the obvious `WITHOUT ROWID` answer** for the content-addressed payload tables,
    with the conditions under which the negative would be meaningless stated explicitly.

15. **Two requirements in the merged `temporal-kv` spec, adopted and corrected.**
    `openspec/specs/temporal-kv/spec.md` is the only merged spec in the repository, and two of its
    requirements — *"Migrations are idempotent and ordered"* (`:6`) and *"Schema isolation is the
    default, not opt-in"* (`:25`) — are Postgres-worded but are migration-framework and
    schema-namespacing requirements, i.e. this capability's. Change 2 correctly declined them as
    outside its boundary; left alone by both, they would stay merged and **false** (there is no
    `search_path` and no `CREATE SCHEMA` after this change). This change therefore carries a
    **second delta directory**, `specs/temporal-kv/`, modifying exactly those two — headers
    reproduced byte-for-byte so the deltas resolve against the merged requirements rather than
    creating new ones. Two adjacent requirements are deliberately *not* deltaed, with reasons
    recorded (`design.md` §16.5).

## Non-goals (explicitly out of scope)

- **The chain archive is owned by `v1.0.0-sqlite-chain-archive` (change 6), not by this change.**
  **No chain-archive DDL is ported here.** Where archive DDL is *cited* (the
  `UNIQUE NULLS NOT DISTINCT` case, the partial unique index, the biconditional `CHECK`), it is
  cited because it is the known instance of a **translation rule** that must be recorded now so it
  is not rediscovered the hard way later. The rules are binding; the lineage belongs to change 6.

  > **Correction (round-2 audit, G-1).** An earlier draft of this proposal asserted that
  > `chainArchiveMigrations` "is an exported array nothing calls" and that the archive "has no data
  > and no consumer". **That was false.** `chain-archive-sync/bootstrap.ts:2` imports
  > `chainArchiveMigrations` and `:21` calls
  > `runMigrations(sql, { schema, migrations: chainArchiveMigrations })` inside
  > `bootstrapChainArchiveSchema` — a real, non-test invocation path, itself exercised against a
  > live database by `test/integration/chain-archive-sync.integration.test.ts`. The claim was copied
  > from a stale in-repo comment at `src/postgres/migrations/chain_archive/index.ts:25` (*"Not wired
  > into any executing path"*), which change 6 retires under G-17; the companion sentence in
  > `001_chain_archive_core.ts` is stale for the same reason. The premise is retracted rather than
  > reworded: scope is now stated as ownership ("change 6 owns it"), which is true independently of
  > whether anything calls the lineage.
- **The TemporalKV table shapes are change 2's.** `kv_current`/`kv_history` become an event log
  under `v1.0.0-sqlite-temporal-event-log`; `written_at`'s clock policy is change 2's and is
  explicitly *conditional on re-measurement*. This change owns the naming layer that change 2's DDL
  must be written through, the `STRICT` obligation on it, and `listKeys` — nothing else about those
  tables.
- **The driver, the shim, connection lifecycle, pragma bootstrap and the ext4 measurement gate are
  change 1's.** This change *states its dependency* on `columns()` origin-metadata decoding and on
  `PRAGMA foreign_keys=ON`; it does not specify them.
- **Transactions, the lease, `BEGIN IMMEDIATE`, isolation and contention error mapping are change
  3's.** This change assumes single-writer serialization for the write paths it describes and says
  where.
- **The written contracts, the error catalog, backup/restore, the durability probe, page-checksum
  coverage and observability are change 5's.** In particular: **SQLite has no main-database page
  checksums** and this change does not close that hole. It only names the constraint whose *name* a
  translated error must carry.
- **No PostgreSQL→SQLite data migration path — but one is required, and it is change 7's.**
  `v1.0.0-sqlite-data-migration` records that consumers install through three channels (git tag,
  repository clone, docker images), so the migrate-existing-data problem is real rather than
  hypothetical. This change states two obligations against it and specifies neither: the
  `UNIQUE (w, net, seq)` constraint added by migration `008` may reject rows existing deployments
  already hold (`design.md` §17.4), and the `listKeys` collation reorder is crossed once at the
  migration boundary (§11.4).
- **No performance number is asserted as fact anywhere in this change.** Six of seven research lanes
  benchmarked against a tmpfs RAM disk; the one re-measurement available moved WAL
  `synchronous=FULL` from 88,485 commits/s to 379. Every performance-dependent requirement here is
  written as an obligation to *establish* a number under stated conditions, referencing change 1's
  gate — never as an assertion of one.
- **No encryption at rest, no `SQLITE_MAX_LENGTH` chunk-size bound change, no
  `page_size`/`auto_vacuum` selection.** `page_size` and `auto_vacuum` are irreversible and are
  change 1's pragma-ordering decision; this change only records that the DDL is agnostic to both.

## Impact

- **New files:** `src/sqlite/migrations/000_schema.ts` … `006_ckpt_chunks_size_bytes.ts` (the
  transliterated lineage, minus TemporalKV's `001` which is change 2's); a naming module exporting
  the prefix function used by every migration and every adapter; a `(table, column) → decoder`
  registry handed to change 1's shim.
- **Modified behaviour, same exported surface:** `listKeys`'s query shape; `writeRows`'s single
  upsert becoming three statements; `saveImpl`'s two sub-batch loops becoming one prepared loop and
  one `json_each` statement; `history()`'s `= ANY(array)` becoming `IN (SELECT value FROM
  json_each(...))`.
- **Deleted:** `escapeLikePrefix` (`temporal-kv.ts:50`); `CHUNK_INSERT_MAX_ROWS` /
  `JUNCTION_INSERT_MAX_ROWS` and the 27-line comment block at `checkpoint-store.ts:36-61` that
  justifies them; `assertNoConflictingSearchPath` (`client.ts:113-135`); the `set search_path` /
  `reset search_path` pair at `migrate.ts:236,273`; the `fillfactor` clauses at
  `003_watermarks.ts:27` and `005_kv_current_fillfactor.ts:21` **and the two hard invariants they
  imposed**. Net LOC is negative.
- **Documentation break, disclosed not hidden:** the `schema` parameter no longer *isolates*, it
  *names*. Two schemas in one file share one writer lock and one WAL. `docs/SCHEMA.md` is retitled
  and rewritten; `docs/CONTRACT.md` §2's text survives, its "generated schema reference" pointer
  changes target.
- **Risk.** The two highest-risk items are the containment direction (a wrong-rows-deleted bug that
  a single-direction test suite would not catch — hence the mandated both-directions scenario
  matrix) and the naming layer's *ordering* position: the feasibility seat records it as a hard
  sequencing constraint, because changes 2 and 3 write DDL and both drafted it unprefixed. If the
  naming layer lands late, every other lane's DDL is written twice.
