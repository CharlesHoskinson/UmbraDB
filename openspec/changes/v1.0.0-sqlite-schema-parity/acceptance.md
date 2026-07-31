# Acceptance — SQLite schema parity

Objective acceptance criteria for change `v1.0.0-sqlite-schema-parity`. Every criterion is traceable
to a requirement in `specs/storage-schema/spec.md` (or `specs/temporal-kv/spec.md`, marked **[tkv]**)
and to a task in `tasks.md`, and carries how it is verified: **[unit]** unit test, **[prop]**
property test, **[CI]** CI gate, **[doc]** checkable doc artifact, **[manual]** manual reviewer
evidence.

**Nothing here gates on a performance number.** Criteria M1–M4 gate on the *existence and
provenance* of a measurement, not on its value. Model on `v1.0.0-api-surface/acceptance.md`.

## P — Preconditions (block the change)

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| P1 | `v1.0.0-sqlite-engine-core` has landed a driver seam and pragma bootstrap; the selected driver, its pinned version, and the observed default of `PRAGMA foreign_keys` on a fresh connection are recorded with the command that produced them. If not landed, §2 onward is blocked. | [manual] | design §0 / 0.1 |
| P2 | The ext4 measurement gate is identified: harness path, `df -hT` output for the target directory showing **not** `tmpfs`, and the `journal_mode`/`synchronous` settings it reports under. | [manual] | "performance-dependent property … obligation to measure" / 0.2 |
| P3 | The consumer question is recorded as **CLOSED, answered YES** (change 7: three install channels), with its three live consequences and the two items that remain free. No artifact in this change describes it as open, and none asserts it blocks nothing in this change. | [manual][doc] | design §15 Q1 / 0.3 |

## N — Naming layer

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| N1 | `qualify(schema, name)` is the sole producer of created-object names; `qualify("umbradb","watermarks")` is `"umbradb_watermarks"`; an invalid schema string is rejected before any DDL is emitted. | [unit] | "every object name … carries the schema prefix" / 1.1 |
| N2 | A static check over every migration's emitted SQL asserts every `CREATE TABLE\|INDEX\|TRIGGER\|VIEW` object name starts with the schema prefix, and that no column name or constraint name does. | [unit][CI] | "every object name … carries the schema prefix" / 1.2 |
| N3 | The whole lineage applies twice against **one file** under two different `schema` values; both succeed; the file holds two disjoint object sets; a write through one schema is invisible through the other. | [unit][CI] | "every object name …" + [tkv] "Schema isolation is the default, not opt-in" / 1.3 |
| N4 | A throwaway reproduction with `002_checkpoint_store.ts:40-41`'s index name unprefixed fails the second application with `index … already exists`; likewise for `001_temporal_kv.ts:135`'s trigger name. | [unit] | negative-control scenarios / 1.3 |
| N5 | `DEFAULT_SCHEMA` is still exported, still typed `string`, still `"umbradb"`; every adapter still accepts `schema` with the same type and default. No major version is required on their account. | [unit][CI] | "the schema parameter and DEFAULT_SCHEMA survive … byte-for-byte" / 1.1 |
| N6 | `grep -r search_path src/` returns no hits outside deletion-explaining comments; `assertNoConflictingSearchPath` is gone; `assertValidSchemaName` including its 63-byte bound remains, re-documented as library-imposed. | [unit][doc] | design §1.6 / 1.4 |
| N7 | The naming layer's contract (signature + "tables, indexes and triggers are prefixed; columns and constraints are not") is published and linked from changes 2 and 3. | [doc][manual] | design §0 / 1.5 |
| N8 | The one-file-per-schema alternative is recorded as rejected with both measured grounds: a cross-`ATTACH` `REFERENCES` is a syntax error, and `SQLITE_MAX_ATTACHED` is 10. | [doc] | "schema emulation SHALL NOT be … one database file per schema" / design §1.5 |

## S — `STRICT` and the type map

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| S1 | Every table in `sqlite_schema` carries `STRICT`; no column is declared `ANY`, `JSONB`, `BYTEA`, `TIMESTAMPTZ` or `BIGINT`. | [unit][CI] | "every table is STRICT …" / 2.1 |
| S2 | Binding `"notanint"` to an `INTEGER` column fails with a datatype error and stores no row. | [unit] | "every table is STRICT …" / 2.2 |
| S3 | **Negative control:** the identical write against the same table *without* `STRICT` is silently stored with `typeof()` reporting `text`, no error raised. | [unit] | negative-control scenario / 2.2 |
| S4 | An ISO-8601 string bound to an epoch-ms `INTEGER` column is rejected; the same write against a non-`STRICT` table makes `WHERE ts <= :t ORDER BY ts DESC LIMIT 1` return the latest row for **every** `:t` with no error — Law T3 (`Formal/STORAGE_ALGEBRA.md` §1) silently false. | [unit] | "every table is STRICT …" / 2.3 |
| S5 | A JSON document with large integers, unicode, a specific key order and duplicate keys round-trips byte-identically through a `TEXT` column; no `json()`/`jsonb()` call appears on any write path. | [unit] | "each PostgreSQL type class maps to exactly one SQLite declared type" / 2.1 |
| S6 | A NUL byte and an unpaired UTF-16 surrogate are both rejected before any statement is issued; the guard's doc string cites SQLite's behaviour, not Postgres's. | [unit][doc] | "each PostgreSQL type class …" / 2.5 |
| S7 | With generated ids 1, 2, 3 and row 3 deleted, the next insert's id is **not** 3. | [unit] | "each PostgreSQL type class …" / 2.1 |
| S8 | The `(table, column) → decoder` registry covers every column in `sqlite_schema`; a column with no entry is a test **failure**, and a view or `NULL`-origin column with no explicit entry is likewise a failure, not a default. | [unit][CI] | design §2.3, §12.2 / 2.4 |

## C — Constraints and foreign keys

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| C1 | A 31-byte `ckpt_chunks.hash` is rejected and the **constraint name** appears in the message. | [unit] | "domain constraints … as named CHECK constraints" / 3.1 |
| C2 | `complete = 2` is rejected; `lifecycle = 'bogus'` is rejected; both messages name their constraint. | [unit] | "domain constraints …" / 3.1 |
| C3 | A static check asserts no byte-length predicate anywhere in the lineage uses `length(`. | [unit][CI] | "domain constraints …" / 3.1 |
| C4 | `runMigrations` fails before issuing any DDL when `PRAGMA foreign_keys` reports 0, naming the pragma. | [unit] | "foreign-key enforcement is a schema precondition …" / 3.2 |
| C5 | Deleting a `ckpt_manifests` row removes its `ckpt_manifest_chunks` rows in the same statement. | [unit] | "foreign-key enforcement …" / 3.2 |
| C6 | **Negative control:** with `foreign_keys` off, `prune()` leaves orphan junction rows, the chunk-reclaim `NOT EXISTS` reclaims **zero** chunks, and **no error is raised**. | [unit] | negative-control scenario / 3.3 |

## J — Junction table and the containment direction

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| J1 | The full fixture matrix passes: `{a}` cleared, `{a,b}` cleared, `{a,b,c}` **survives**, `{b,z}` survives, `{z}` survives, `{}` survives, `[a,a]` cleared. | [unit][prop] | "identifier containment … row-subset-of-the-finalizing-set" / 4.3 |
| J2 | Another wallet's `{a}` row is untouched by a finalize in the first wallet. | [unit] | same requirement / 4.3 |
| J3 | A finalize carrying zero identifiers clears nothing. | [unit] | same requirement / 4.3 |
| J4 | **Negative control:** the `@>` predicate over the same fixture selects `{a,b}` and `{a,b,c}` — the wrong answer asserted explicitly, so an accidental inversion of the production query cannot leave both tests green. | [unit] | negative-control scenario / 4.4 |
| J5 | `EXPLAIN QUERY PLAN` for the candidate subquery resolves to a search of the reverse index on `(wallet_id, identifier)` and **not** to a bare `SEARCH … USING PRIMARY KEY (wallet_id=?)`; asserted by reading the plan text. | [unit][CI] | same requirement / 4.1 |
| J6 | Rewriting an entry from `{a,b,c}` to `{c}` leaves exactly one junction row; a subsequent containment evaluation sees `{c}`. | [unit] | "an identifier set is replaced wholesale …" / 4.2 |
| J7 | The identifier insert binds exactly three parameters regardless of identifier count. | [unit] | "an identifier set is replaced wholesale …" / 4.2 |
| J8 | FTS5's rejection is recorded on **semantics** (it answers the `@>` direction; subset is a universal over the row's own tokens), not on speed. | [doc] | "identifier containment …" / design §4.5 |
| J9 | Concurrent merges on the same `(walletId, txHash)` still lose no section, with `pg_advisory_xact_lock` and `SELECT … FOR UPDATE` both removed. | [unit] | design §4.4 / 4.2 |

## L — `listKeys`

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| L1 | Prefix `ab` over `ab, abc, abcd, abd, Abc, aBc` returns exactly `ab, abc, abcd, abd`. | [unit] | "listKeys matches a literal prefix with a half-open range scan" / 5.1 |
| L2 | `EXPLAIN QUERY PLAN` shows a key range on `key` in addition to `ns` and `scope`. | [unit][CI] | same requirement / 5.1 |
| L3 | **Negative control:** the `LIKE` form over the same key set also returns `Abc` and `aBc`, and its plan shows **no** key range. | [unit] | negative-control scenario / 5.2 |
| L4 | `grep -r escapeLikePrefix src/` returns nothing. | [unit][CI] | same requirement / 5.1 |
| L5 | `prefixUpper` edge cases pass: empty prefix omits the bound; U+D7FF's successor is **U+E000**, not U+D800; U+10FFFF is stripped and recursed; `%`, `_`, `\` are matched literally. | [unit] | same requirement / 5.3 |
| L6 | Ordering over a key set containing a supplementary-plane code point and a key in U+E000–U+FFFF is asserted by `codePointAt`, not by `Array.prototype.sort()`; the test closes design §15 Q4. | [unit] | "listKeys ordering is code-point order …" / 5.4 |
| L7 | The one-time resume-cursor reorder is documented, together with the statement that `src/interfaces/temporal-kv.ts:314` promises stability rather than a named collation and that this is therefore not a contract break. | [doc] | "listKeys ordering …" / 5.5 |

## B — Bulk inserts

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| B1 | `grep -n "MAX_ROWS" src/` returns nothing; both sub-batch loops and the justifying comment block are gone; net LOC negative. | [unit][CI] | "bulk inserts have no row cap derived from the bind-parameter ceiling" / 6.1 |
| B2 | A checkpoint with more than 16,383 chunks saves successfully via one prepared statement re-executed inside one transaction. | [unit] | same requirement / 6.2 |
| B3 | No payload byte passes through a JSON or hex encoding on the chunk path. | [unit] | same requirement / 6.2 |
| B4 | The manifest-chunk junction issues exactly **one** statement binding **two** parameters for any chunk count, with `position` taken from `json_each.key`, including a manifest referencing the same chunk hash at two positions. | [unit] | same requirement / 6.3 |
| B5 | **Negative control:** a multi-row `VALUES` binding more than 32,766 parameters fails with `too many SQL variables`. | [unit] | negative-control scenario / 6.4 |
| B6 | The retune-to-16,383/10,922 option is recorded as considered and rejected, with the reason (it is the only option that keeps the sub-batch machinery alive and it breaks the "exactly one statement" property). | [doc] | design §6.2 / 6.4 |
| B7 | `history()` returns correct aggregates for a manifest count exceeding any prior parameter bound; the statement binds one parameter. | [unit] | same requirement / 6.5 |
| B8 | The two parser gotchas are recorded: `WHERE true` before `ON CONFLICT` in an `INSERT … SELECT`; `DELETE … LIMIT` is a syntax error. | [doc] | same requirement / design §6.4 |

## M — Migration framework

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| MG1 | The bootstrap probe returns false without raising against a database with no tables. | [unit] | [tkv] "Migrations are idempotent and ordered" / 7.1 |
| MG2 | A second `runMigrations` applies nothing and leaves `<schema>_migrations` unchanged. | [unit] | [tkv] same / 7.1 |
| MG3 | A migration raising mid-way leaves none of its DDL and no `_migrations` row, relying on transactional DDL. | [unit] | [tkv] same / 7.1 |
| MG4 | `<schema>_migrations` contains a `005_kv_current_fillfactor` row and that migration issued no DDL; the header states the retirement of the two never-index invariants and its reason; a reviewer checklist records that deleting `005` is not a permitted cleanup. | [unit][doc] | "migration 005 is retained as a recorded no-op …" / 7.2 |
| MG5 | `000` → `006` applies clean against a fresh file and `history()`'s `sum(size_bytes)` returns correct totals — `006` transliterated verbatim, `STORED` retained. | [unit] | "migration 006 replays verbatim …" / 7.3 |
| MG6 | **Negative control:** `000` → `005`, insert one `ckpt_chunks` row, then `006` fails with `cannot add a STORED column`. | [unit] | negative-control scenario / 7.4 |
| MG7 | The `VIRTUAL` workaround and the fold-into-`002` option are recorded as considered and rejected, with the 0-row-succeeds / ≥1-row-fails measurement that decided it, and the earlier "refused outright" reading recorded as void. | [doc] | "migration 006 replays verbatim …" / 7.4 |
| MG8 | Two concurrent `runMigrations` against one file result in exactly one applying the lineage; any failure surfaces as the existing `MIGRATION_LOCK_TIMEOUT`; **no new error code is introduced**. | [unit] | [tkv] "Migrations are idempotent and ordered" / 7.5 |

## W — Writer-generation table (DDL only; protocol is change 3's)

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| W1 | After the lineage runs, `<schema>_writer_generation` exists, is declared `STRICT`, and carries the `<schema>_` prefix — so it is caught by N2's static prefix check and N3's two-schema test like every other table. | [unit][CI] | "the writer-generation table is created and seeded …" / 7.6 |
| W2 | Its `id = 1` singleton constraint is a **named** `CONSTRAINT`; inserting `id = 2` is rejected and the constraint **name** appears in the message, satisfying the property `v1.0.0-sqlite-durability-contract` consumes. | [unit] | same requirement / 7.6 |
| W3 | Exactly one row exists after migration, with `id = 1` and `generation = 0`; the first registrant therefore reads back `1`. | [unit] | same requirement / 7.6 |
| W4 | **Negative control:** with the table created but unseeded, change 3's registration shape (`UPDATE … WHERE id = 1`, then read back) reports zero changed rows and returns no row, **raising nothing** — the guard silently guards nothing. | [unit] | negative-control scenario / 7.7 |
| W5 | On a fresh database, `runMigrations` completes before any generation read is attempted, and migration transactions do not consult the generation table. | [unit] | same requirement / 7.8 |
| W6 | The two-phase exclusion argument is recorded: the migration lock covers migrations, the generation guard covers post-open writes, and no window exists in which neither applies. | [doc] | same requirement / 7.8 |
| W7 | This change specifies **no** part of the guard's protocol — no bump, no re-read point, no displacement error — and cites `v1.0.0-sqlite-concurrency-lease` §2.2 for all of it. | [manual][doc] | design §0, §9.4 / 7.6 |

## SQ — Sequence-allocator integrity (design §17)

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| SQ1 | With `next_seq` corrupted to a value at or below the current `max(seq)`, `save()` fails with a **non-retryable** error and commits no manifest row, before the caller is told it succeeded. | [unit] | "sequence allocation is guarded by a runtime invariant …" / 7.10 |
| SQ2 | The invariant reads `max(seq)` **without** the `complete` filter. | [unit] | same requirement / 7.10 |
| SQ3 | `<schema>_ckpt_manifests_seq_unique` exists, is **full** (not partial), carries the schema prefix, and rejects two manifests at the same `(w, net, seq)`. | [unit][CI] | same requirement / 7.9 |
| SQ4 | **Negative control:** with the index present but the invariant absent, a store pruned to a single manifest at `seq = 34` with `next_seq` corrupted to `5` accepts the insert, raises nothing, and `load()` still returns `34` — proving the constraint alone does not close the gap. | [unit] | negative-control scenario / 7.11 |
| SQ5 | **Negative control:** under a partial `WHERE complete` index, a row whose `complete` is flipped to false falls outside coverage — the reason the full index was chosen. | [unit] | negative-control scenario / 7.11 |
| SQ6 | The retry path still works: a failed save leaves neither manifest row nor counter increment; a retry of a committed save allocates a fresh seq; no abandoned incomplete manifest exists at a duplicate `(w, net, seq)`. | [unit] | same requirement / 7.9 |
| SQ7 | `EXPLAIN QUERY PLAN` for the invariant's `max(seq)` lookup uses the `(w, net, seq)` unique index. | [unit] | same requirement / 7.9 |
| SQ8 | A note records that existing PostgreSQL deployments may already violate the new constraint, that change 7 owns the reject-vs-quarantine decision, and that this change does not make it. | [doc][manual] | design §17.4 / 7.12 |
| SQ9 | The error code used comes from change 5's existing catalog; no new code was minted. | [manual][doc] | same requirement / 7.10 |

## SD — Schema-text digest (design §18)

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| SD1 | A digest over the prefixed subset of `sqlite_schema` is recorded after the lineage runs. | [unit] | "the schema text is covered by a digest …" / 7.13 |
| SD2 | Two schema values in one database file yield two independent digests. | [unit] | same requirement / 7.13 |
| SD3 | The digest recorded after `006` differs from one computed before it, proving recomputation rather than create-time-only capture. | [unit] | same requirement / 7.13 |
| SD4 | The migration header and `docs/SCHEMA.md` both state the digest detects corruption, not tampering, and neither calls it a security control. | [doc] | same requirement / 7.14 |
| SD5 | No requirement in this change offers `quick_check` as an alternative to `integrity_check`; verified by grep returning nothing, and the obligation is flagged to change 5. | [manual][doc] | same requirement / design §18.4 |

## R — Translation rules that outlive this lineage

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| R1 | A unique index over `coalesce(contract_address, x'')` accepts two protocol-scoped rows differing only in `net` (both NULL address) and rejects an exact duplicate context. | [unit] | "uniqueness over a nullable key column …" / 8.1 |
| R2 | A zero-length `contract_address` is rejected by `CHECK (… IS NULL OR octet_length(…) > 0)`. | [unit] | same requirement / 8.2 |
| R3 | **Negative control:** a plain `UNIQUE (vk_hash, net, scope, contract_address, tag)` **accepts** the duplicate — reproducing the v4 audit's data-loss bug (`001_chain_archive_core.ts:63-70`, `:522-529`). | [unit] | negative-control scenario / 8.3 |
| R4 | A static check over every migration's SQL asserts no `UNIQUE` constraint or unique index names a nullable column directly; the check runs despite the tier-1 lineage having no such constraint today. | [unit][CI] | same requirement / 8.3 |
| R5 | No chain-archive DDL is ported: `src/sqlite/migrations/chain_archive/` does not exist and no chain-archive table appears in `sqlite_schema` after the lineage runs. | [unit][CI] | proposal non-goals / 8.1 |
| R6 | Every table's rowid choice matches design §7.3, with `ckpt_chunks` and `ckpt_manifests` as plain rowid tables; the migration headers state the assignment and the reason. | [unit][doc] | "WITHOUT ROWID is used only for narrow tables …" / 8.4 |
| R7 | The three conditions under which the `WITHOUT ROWID` negative would be meaningless are recorded, and which of them are refuted against the code (`load()` is a point join; `prune()` is a predicate delete). | [doc] | same requirement / 8.4 |

## MS — Measurement obligations (gate on provenance, never on a value)

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| MS1 | Every throughput or latency figure in any artifact this change produces is traceable to a run on ext4 under P2's gate, with the command recorded. | [doc][manual] | "every performance-dependent property is stated as an obligation to measure" / 4.5, 8.5 |
| MS2 | No figure taken from the research corpus's tmpfs runs appears as fact in any artifact — the calibrating example (WAL `synchronous=FULL`: 88,485 → 379 commits/s, 233×) is recorded as the reason. | [doc] | same requirement / design §0 |
| MS3 | The containment query's latency is measured on ext4 at a stated dataset size and page-cache ratio before any document quotes one. | [manual] | same requirement / 4.5 |
| MS4 | The `WITHOUT ROWID` direction is re-confirmed on ext4 at 4 KiB / 64 KiB / 4 MiB rows; if the **direction** inverts, §7.3's assignment is reopened and task 2.1 blocks. | [manual] | "WITHOUT ROWID is used only for narrow tables …" / 8.5 |

## I5 — Migration-lineage law (design §19.1)

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| I5-1 | A static check asserts every DDL-issuing migration begins with non-idempotent DDL; it passes over the whole lineage. | [unit][CI] | "every migration begins with non-idempotent DDL …" / 10.1 |
| I5-2 | A deliberately added `CREATE TABLE IF NOT EXISTS` first statement fails the check. | [unit] | same requirement / 10.1 |
| I5-3 | A deliberately added empty migration absent from the no-op registry fails the check; `005_kv_current_fillfactor` passes only via the registry, whose entry carries the justification. | [unit][doc] | same requirement / 10.1 |
| I5-4 | Removing a `_migrations` row and re-running makes that migration fail on its first statement with an "already exists" error — not a silent success. | [unit] | same requirement / 10.2 |
| I5-5 | **Negative control:** the same re-entry against an `IF NOT EXISTS` first statement silently succeeds and the runner records it as freshly applied. | [unit] | negative-control scenario / 10.2 |
| I5-6 | A migration failing on a later DDL statement leaves none of its DDL and no `_migrations` row. | [unit] | same requirement / 10.3 |
| I5-7 | After a mid-lineage failure, `_migrations` records exactly the committed migrations and the `sqlite_schema` digest still describes the previous successful run; a note records that neither signal alone identifies the missing migration. | [unit][doc] | same requirement / 10.3 |

## I7 — Transaction-history read-path cross-checks (design §19.2)

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| I7-1 | Change 7's Q-2 is answered in writing: today's read path takes `identifiers` from the denormalised column (`transaction-history-storage.ts:238`), `entry` retains both facts (`:160-169`), and the ruling is to derive from `entry` with the junction cross-checked. Linked from change 7. | [doc][manual] | "transaction-history reads derive identifiers from entry …" / 10.4 |
| I7-2 | `get()`/`getAll()` return identifiers derived from `entry`, not from the junction. | [unit] | same requirement / 10.4 |
| I7-3 | A junction row deleted out of band makes the read fail with a non-retryable error rather than returning the smaller set. | [unit] | same requirement / 10.5 |
| I7-4 | A junction row added out of band makes the read fail with a non-retryable error. | [unit] | same requirement / 10.5 |
| I7-5 | A `lifecycle` column diverging from `entry.lifecycle.status` makes the read fail. | [unit] | same requirement / 10.5 |
| I7-6 | Comparison is by **set**: a reordered or duplicated `entry.identifiers` array does not raise. | [unit][prop] | same requirement / 10.5 |
| I7-7 | **Negative control:** with the cross-check disabled, a damaged junction yields a wrong identifier set with **no error** and every value digest still passing, and the wrong set propagates into the pending-clear predicate. | [unit] | negative-control scenario / 10.6 |
| I7-8 | Failures surface as a `StorageError` through the existing catch-all (`:250-260`), never a raw `TypeError`; the code came from change 5's catalog and no new code was minted. | [unit][manual] | same requirement / 10.5 |

## DG — Wallet-tier digest column DDL (design §19.3)

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| DG1 | `009_value_digests` adds a nullable `dg BLOB` with no default to `kv_event`, `watermarks` and `transaction_history`. | [unit] | "wallet-tier digest columns are declared …" / 10.7 |
| DG2 | Each carries a **named** `CHECK (dg IS NULL OR octet_length(dg) = 32)` using `octet_length`, not `length`; a 31-byte digest is rejected with the constraint name in the message; `NULL` is accepted. | [unit] | same requirement / 10.7 |
| DG3 | Drift-guard trigger names are produced by `qualify()`; the two-schema application test (N3) covers them and passes. | [unit][CI] | same requirement / 10.7 |
| DG4 | The migration's first statement is the `ALTER TABLE`, satisfying I5-1. | [unit][CI] | same requirement / 10.7 |
| DG5 | This change specifies no part of the digest's computation or verification; all are cited to `v1.0.0-sqlite-durability-contract`. Archive tables are excluded as change 6's. | [manual][doc] | design §19.3 / 10.7 |
| DG6 | Each covered table carries an anti-downgrade trigger named through `qualify()`: `UPDATE t SET dg = NULL` on a digested row aborts, using no user-defined function. | [unit] | "wallet-tier digest columns …" / 10.6b |
| DG7 | The trigger obstructs neither a non-NULL-replacing-non-NULL recompute nor a NULL-to-value backfill write. | [unit] | same / 10.6b |
| DG8 | **Negative control:** with only the drift-guard trigger installed, `UPDATE t SET dg = NULL` is **accepted** and the row is permanently downgraded to unverified while no covered value is touched. | [unit] | negative-control scenario / 10.6b |
| G9a | Both concurrent-`runMigrations` scenarios carry the write-lock-exclusivity qualifier naming `-shm`, the source guard and the embedder precondition; a grep for `-shm` in this change returns hits. | [doc][manual] | design §9.2 / 10.6c |

## X — Cross-change seam and closeout

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| X1 | The two `specs/temporal-kv/` delta headers match `openspec/specs/temporal-kv/spec.md:6` and `:25` **character-for-character**, evidenced by pasted grep output — a paraphrase would create a new requirement instead of modifying the existing one. | [manual][CI] | design §16.3 / 9.1 |
| X2 | The deliberate non-deltas are recorded with reasons and owners: the `listKeys` streaming/ordering requirement (`:213`, changes 1+2) and the caller-supplied-transaction-handle requirement (`:104`, change 3). | [doc] | design §16.5 / 9.2 |
| X3 | The retained-but-now-inaccurate header `Schema isolation is the default, not opt-in` is recorded as an owed rename with the reason it was not taken here (delta resolution), not left as a silent inconsistency. | [doc] | design §16.4 / 9.1 |
| X4 | `docs/SCHEMA.md` describes the SQLite lineage, the prefix convention, the `STRICT`/`CHECK` guarantees, the junction table with its containment direction, and the narrowed `schema` meaning; `docs/CONTRACT.md` §2's substance is unchanged. | [doc] | design §13 / 9.3 |
| X5 | P1–P10 is **re-executed, not amended**, and passes; a note records that the Lean cut-line surviving untouched is not evidence of safety (`SYNTHESIS.md` trap 8). | [CI][doc] | design §14 / 9.4 |
| X6 | `/usr/local/bin/openspec validate v1.0.0-sqlite-schema-parity --type change --strict --no-interactive` exits zero, output recorded verbatim. | [CI] | — / 9.5 |
