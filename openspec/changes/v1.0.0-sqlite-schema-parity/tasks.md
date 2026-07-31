# Tasks — SQLite schema parity

Every task states concrete acceptance criteria — what test passes, what command succeeds, what
artifact is checkable — per `openspec/config.yaml`'s tasks rule. Cadence matches Sprints 1–8: a
builder implements, two auditors review in parallel (spec-compliance against this change's
`design.md` + `specs/storage-schema/spec.md`; code/test quality), and a task is CLOSED only when both
approve or their findings are fixed and re-reviewed.

**Ordering.** §1 (the naming layer) is a **hard upstream dependency for changes 2 and 3**, both of
which write DDL and both of which drafted it unprefixed — the feasibility seat records this as an
ordering constraint, not a conflict. It must land before any other lane's DDL is written, or that
DDL is written twice. §0 is a blocking gate. §9 is last because it validates everything above
against the conformance suite.

## 0. Preconditions (blocking gate)

- [ ] 0.1 **Confirm `v1.0.0-sqlite-engine-core` has landed the driver seam and the pragma bootstrap,
  and record which driver was selected.** The schema layer's `PRAGMA foreign_keys=ON` dependency
  (design §8) and the `columns()`-origin decoder contract (design §2.3) both resolve differently per
  driver; `node:sqlite` enables foreign keys by default, a third-party binding may not.
  **Acceptance:** a written note in this file records the selected driver, its pinned version, and
  the observed default of `PRAGMA foreign_keys` on a fresh connection, with the command that
  produced it. If change 1 has not landed, STOP — §2 onward is blocked.

- [ ] 0.2 **Record the ext4 measurement gate's identity.** Every performance-dependent obligation in
  this change (design §4.5, §7.2, §15 Q2/Q3) references it. **Acceptance:** the note records the
  gate's harness path, the filesystem it runs on (`df -hT` output for the target directory, showing
  **not** `tmpfs`), and the `journal_mode`/`synchronous` settings under which it reports.

- [ ] 0.3 **Consume the answered consumer question — it is CLOSED, and the answer is YES.**
  `v1.0.0-sqlite-data-migration` records that consumers install through three channels (git tag,
  repository clone, docker images). An earlier draft of this task asked the question and offered
  "record it as unanswered" as an acceptable outcome; that outcome is no longer available.
  **Acceptance:** this file records the closed answer and its three live consequences — change 7 is
  the required data-migration path; §17.4's `UNIQUE (w, net, seq)` violation flag is a live
  obligation on change 7 rather than a conditional one; and §11.4's collation reorder is a real
  migration-boundary hazard. It also records what does **not** change: §10's `STORED` replay and
  §5's sentinel emulation stay free, since those depend on SQLite lineage history (empty), not on
  Postgres consumers. Cross-checked against design §15 Q1, which must show the question CLOSED.

## 1. The schema naming layer (blocks changes 2 and 3)

- [ ] 1.1 **Implement `qualify(schema, name)` and route every DDL object name through it.** Retain
  `assertValidSchemaName` including its 63-byte bound, re-documented as a library-imposed bound
  rather than a `NAMEDATALEN` bound (design §1.6). **Acceptance:** `qualify` is the only producer of
  created-object names; a unit test asserts `qualify("umbradb", "watermarks") === "umbradb_watermarks"`
  and that an invalid schema string is rejected before any DDL is emitted.

- [ ] 1.2 **Apply the prefix to index and trigger names, not only tables.** **Acceptance:** a static
  test parses the SQL text every migration emits and asserts that every `CREATE TABLE|INDEX|TRIGGER|VIEW`
  object name begins with the schema prefix, and that no column name or constraint name carries it.
  The test fails if a single name is missed.

- [ ] 1.3 **Two-schema application test.** **Acceptance:** a test applies the whole lineage twice
  against one database file with `schema = "umbradb"` then `schema = "tenant_a"`, asserts both
  succeed, asserts the file holds two disjoint object sets, and asserts a write through one schema's
  adapters is invisible through the other's. This is the test that catches a missed index or trigger
  prefix; it must fail if 1.2's static check is bypassed.

- [ ] 1.4 **Delete `assertNoConflictingSearchPath` and the `search_path` widen/reset pair.**
  (`src/postgres/client.ts:113-135`; `src/postgres/migrate.ts:236,273`.) **Acceptance:** `grep -r
  search_path src/` returns no hits outside comments explaining the deletion; the typecheck passes;
  net LOC for the task is negative.

- [ ] 1.5 **Publish the layer's contract to changes 2 and 3.** **Acceptance:** a short note in this
  file gives the exported function signature and the rule ("tables, indexes and triggers are
  file-global and all three are prefixed; columns and constraints are not"), and is linked from both
  downstream changes' task lists.

## 2. `STRICT` DDL and the type map

- [ ] 2.1 **Transliterate `000`, `002`, `003`, `004` as `STRICT` tables** per design §12.1, with the
  `WITHOUT ROWID` assignment of §7.3. **Acceptance:** the lineage applies clean against a fresh file;
  `SELECT sql FROM sqlite_schema WHERE type='table'` shows `STRICT` on every table; no column is
  declared `ANY`, `JSONB`, `BYTEA`, `TIMESTAMPTZ` or `BIGINT`.

- [ ] 2.2 **Prove the rejection, and prove the negative control.** **Acceptance:** a unit test binds
  `"notanint"` to an `INTEGER` column of a `STRICT` table and asserts the write fails with a
  datatype error and stores no row; a companion test creates the *same table without `STRICT`* in a
  throwaway database, performs the same write, and asserts it is silently stored with
  `typeof()` reporting `text` — pinning the guarantee `STRICT` adds rather than merely asserting the
  happy path.

- [ ] 2.3 **Prove the T3 failure mode the `STRICT` decision exists to convert.** **Acceptance:** a
  test binds an ISO-8601 string to an epoch-ms `INTEGER` column and asserts rejection; the same test
  against a non-`STRICT` table asserts that a `WHERE ts <= :t ORDER BY ts DESC LIMIT 1` lookup then
  returns the latest row for *every* `:t`, with no error — the Law T3 violation
  (`Formal/STORAGE_ALGEBRA.md` §1) recorded as an executable negative control.

- [ ] 2.4 **Build the `(table, column) → decoder` registry and hand it to change 1.**
  **Acceptance:** the registry is a data table derived from §12.1's DDL covering every column; a test
  asserts every column in `sqlite_schema` has a registry entry (no silent fall-through), and that any
  view column or `NULL`-origin column without an explicit entry is a **failure**, not a default
  (design §12.2). The artifact is referenced from change 1's task list.

- [ ] 2.5 **Keep and re-document the NUL / lone-surrogate guard.** **Acceptance:** the guard at
  `src/interfaces/temporal-kv.ts:35-37` still rejects both; its doc string now cites SQLite's
  behaviour (NUL desynchronises `length()`; a lone surrogate becomes U+FFFD) rather than Postgres's;
  a test asserts both inputs are rejected before any statement is issued.

## 3. Constraints

- [ ] 3.1 **Add the named `CHECK` constraints** of design §3 and §12.1: 32-byte content addresses,
  the boolean domain on `complete`, the lifecycle enum. Use `octet_length`, never `length`.
  **Acceptance:** three unit tests assert rejection of a 31-byte hash, `complete = 2`, and
  `lifecycle = 'bogus'`; each asserts the **constraint name** appears in the error message, so
  change 5 has a stable translation key. A static check asserts no `length(` appears in a
  byte-length predicate anywhere in the lineage.

- [ ] 3.2 **Assert foreign-key enforcement as a migration precondition.** **Acceptance:**
  `runMigrations` fails before issuing DDL when `PRAGMA foreign_keys` reports 0, with the pragma
  named in the message; a test proves it. A second test proves the cascade fires on a manifest
  delete.

- [ ] 3.3 **Pin the foreign-keys-off leak as a negative control.** **Acceptance:** a test in a
  throwaway database with `foreign_keys` off runs the `prune()` sequence and asserts that orphan
  junction rows survive the manifest delete and that the chunk-reclaim `NOT EXISTS` therefore
  reclaims **zero** chunks, with no error raised — pinning the silent unbounded-growth failure mode
  (design §8) rather than trusting the pragma.

## 4. The identifiers junction table

- [ ] 4.1 **Create the junction table, its reverse index and the partial pending index** per design
  §4.2 and §12.1. **Acceptance:** the DDL applies; `EXPLAIN QUERY PLAN` for the candidate subquery
  resolves to a search of `<s>_th_ident_reverse` on `(wallet_id, identifier)`, asserted by a test
  that reads the plan text — not by inspection.

- [ ] 4.2 **Implement the three-statement write path** (upsert entry; delete junction rows; insert
  from `json_each`) replacing `transaction-history-storage.ts:494-507`, and delete the
  `pg_advisory_xact_lock` (`:458`) and `SELECT ... FOR UPDATE` (`:465`). **Acceptance:** a test
  rewrites an entry from identifiers `{a,b,c}` to `{c}` and asserts exactly one junction row
  survives; a test asserts the identifier insert binds exactly three parameters regardless of
  identifier count.

- [ ] 4.3 **Implement the two-phase containment `DELETE`** of design §4.3. **Acceptance:** the full
  fixture matrix from `specs/storage-schema/spec.md` passes: `{a}` cleared, `{a,b}` cleared,
  `{a,b,c}` **survives**, `{b,z}` survives, `{z}` survives, `{}` survives, `[a,a]` cleared, another
  wallet's `{a}` untouched, and a finalize with zero identifiers clears nothing.

- [ ] 4.4 **Pin the inverted direction as a negative control.** **Acceptance:** a test constructs the
  `@>` predicate over the same fixture and asserts it selects `{a,b}` and `{a,b,c}` — proving the two
  directions agree on exactly one row of seven, and that a suite exercising only the equal-set case
  would pass against both. The test asserts the *wrong* answer explicitly, so an accidental
  inversion of the production query cannot make both tests pass.

- [ ] 4.5 **Establish the containment query's latency on ext4.** **Acceptance:** a benchmark run
  under §0.2's gate reports the index-driven and naive forms at a stated dataset size and page-cache
  ratio, and the number is recorded here with the command that produced it. No document quotes a
  figure until this task closes.

## 5. `listKeys`

- [ ] 5.1 **Replace the `LIKE` predicate with the half-open range scan** and delete
  `escapeLikePrefix` (`src/postgres/temporal-kv.ts:50,317-323`). **Acceptance:** a test over the key
  set `ab, abc, abcd, abd, Abc, aBc` with prefix `ab` returns exactly `ab, abc, abcd, abd`; a test
  reads `EXPLAIN QUERY PLAN` and asserts a key range appears on the `key` column; `grep -r
  escapeLikePrefix src/` returns nothing.

- [ ] 5.2 **Pin the `LIKE` defects as a negative control.** **Acceptance:** a test issues the `LIKE`
  form against the same key set in a throwaway database and asserts it *also* returns `Abc` and
  `aBc`, and that its query plan shows no key range — both defects recorded as observations, not
  prose.

- [ ] 5.3 **Implement `prefixUpper` with the full edge-case rule** of design §11.3.
  **Acceptance:** unit tests cover the empty prefix (no upper bound), a prefix ending in U+D7FF
  (successor is U+E000, **not** U+D800), a prefix ending in U+10FFFF (strip and recurse), and a
  prefix containing `%`, `_` and `\` (matched literally).

- [ ] 5.4 **Assert ordering by code point, not by a JS sort.** **Acceptance:** a test over a key set
  containing a supplementary-plane code point and a key in U+E000–U+FFFF computes the expected order
  by `codePointAt`, and a comment records that a bare `Array.prototype.sort()` would disagree because
  JS compares UTF-16 code units. This task also *closes* design §15 Q4 — the divergence is currently
  an inference, and this test is what establishes it.

- [ ] 5.5 **Document the one-time resume-cursor reorder.** **Acceptance:** the migration notes state
  that a consumer resuming a `listKeys` cursor persisted under PostgreSQL collation may skip or
  repeat keys once, that this is free pre-tag and a live-migration hazard post-tag, and that
  `src/interfaces/temporal-kv.ts:314` promises stability rather than a named collation, so it is not
  a contract break.

## 6. Bulk inserts

- [ ] 6.1 **Delete `CHUNK_INSERT_MAX_ROWS`, `JUNCTION_INSERT_MAX_ROWS`, both sub-batch loops and the
  comment block that justifies them** (`src/postgres/checkpoint-store.ts:36-63,229-235,275-280`).
  **Acceptance:** `grep -n "MAX_ROWS" src/` returns nothing; the typecheck passes; net LOC is
  negative.

- [ ] 6.2 **Chunk rows via one prepared statement re-executed inside one transaction.**
  **Acceptance:** a test saves a checkpoint whose chunk count exceeds 16,383 and asserts success;
  a test asserts no payload byte passes through a JSON or hex encoding on that path.

- [ ] 6.3 **Manifest-chunk junction via one `json_each` statement.** **Acceptance:** a test asserts
  exactly one statement is issued for the junction regardless of chunk count, that it binds **two**
  parameters, and that `position` values match the array order — including a manifest that
  references the same chunk hash at two different positions (the case
  `002_checkpoint_store.ts:44-49` exists for).

- [ ] 6.4 **Pin the parameter ceiling.** **Acceptance:** a test executes a multi-row `VALUES`
  statement binding more than 32,766 parameters and asserts `too many SQL variables` — the
  observation proving the shipped caps could not have been ported unchanged. A note records that
  retuning to 16,383/10,922 was considered and rejected (design §6.2).

- [ ] 6.5 **Convert `= ANY(sql.array(...))` to `IN (SELECT value FROM json_each(:ids))`**
  (`src/postgres/checkpoint-store.ts:442`). **Acceptance:** `history()` returns correct aggregates
  for a manifest count exceeding any prior parameter bound; the statement binds one parameter.

## 7. The migration framework

- [ ] 7.1 **Port the runner: `sqlite_schema` bootstrap detection, no `CREATE SCHEMA`, no
  `search_path`, per-migration transactions.** **Acceptance:** a test asserts the bootstrap probe
  returns false without raising on a database with no tables; a test asserts a second
  `runMigrations` applies nothing and leaves `<schema>_migrations` unchanged; a test asserts a
  migration raising mid-way leaves none of its DDL and no `_migrations` row.

- [ ] 7.2 **Retain migration `005` as a recorded no-op with a header explaining why**, and record
  the retirement of the two never-index hard invariants (`003_watermarks.ts:10-12`,
  `005_kv_current_fillfactor.ts:15-17`). **Acceptance:** a test asserts `<schema>_migrations`
  contains a `005_kv_current_fillfactor` row and that the migration issued no DDL; the headers state
  the retirement and its reason; a reviewer checklist item records that deleting `005` is
  **not** a permitted cleanup.

- [ ] 7.3 **Transliterate `006` verbatim, including `STORED`.** **Acceptance:** `000` → `006`
  applies clean against a fresh file and `history()`'s `sum(size_bytes)` returns correct totals.

- [ ] 7.4 **Pin the populated-table `STORED` constraint as an executable test.** **Acceptance:** a
  test applies `000` → `005` against a throwaway database, inserts one `ckpt_chunks` row, applies
  `006`, and asserts it fails with `cannot add a STORED column` — proving the forward constraint is
  real and documenting it in executable form (design §10.3). A note records that the `VIRTUAL`
  workaround and the fold-into-`002` option were both considered and rejected, with the measurement
  that decided it.

- [ ] 7.5 **State the migration-lock dependency on change 3.** **Acceptance:** a test asserts that
  two concurrent `runMigrations` against one file result in exactly one applying the lineage, and
  that any failure surfaces as the existing `MIGRATION_LOCK_TIMEOUT` code with **no new error code
  introduced**; the mechanism is consumed from change 3, and this file records which one landed.

- [ ] 7.6 **Add migration `007_writer_generation`: create the table and seed the singleton row.**
  DDL per design §12.1 — prefixed through `qualify()`, `STRICT`, both `CHECK`s named, plain rowid
  table — with the `INSERT` of `(id=1, generation=0)` in the same migration. **Acceptance:** after
  the lineage runs, `<schema>_writer_generation` exists, `sqlite_schema` shows `STRICT`, exactly one
  row exists with `generation = 0`, and inserting `id = 2` is rejected with the **named** singleton
  constraint in the message. Task 1.3's two-schema test must cover this table and task 1.2's static
  prefix check must see it. **Do not implement change 3's protocol here** — only the table.

- [ ] 7.7 **Pin the unseeded-table failure as a negative control.** **Acceptance:** a test in a
  throwaway database creates the table *without* the seed row, runs change 3's registration shape
  (`UPDATE … WHERE id = 1`, then read back), and asserts the `UPDATE` reports zero changed rows and
  the read-back returns no row **with no error raised** — pinning the silent
  guard-that-guards-nothing failure mode (design §9.4).

- [ ] 7.8 **Prove the bootstrap ordering.** **Acceptance:** a test asserts that on a fresh database
  `runMigrations` completes before any generation read is attempted, and that migration transactions
  do not consult the generation table. A note records the two-phase exclusion argument — the
  migration lock covers migrations, the generation guard covers post-open writes, and no window
  exists in which neither applies (design §9.4). Coordinate the read-side half of the assertion with
  change 3, which owns it.

- [ ] 7.9 **Add migration `008_ckpt_manifests_seq_unique`.** `CREATE UNIQUE INDEX
  <s>_ckpt_manifests_seq_unique ON <s>_ckpt_manifests (w, net, seq)` — full, not partial (design
  §17.3c). **Acceptance:** the index exists after the lineage runs and carries the schema prefix, so
  tasks 1.2 and 1.3 cover it; inserting two manifests at the same `(w, net, seq)` is rejected; a
  test asserts `EXPLAIN QUERY PLAN` for `max(seq)` over a `(w, net)` uses this index.

- [ ] 7.10 **Implement the mandatory sequence invariant in `save()`.** Inside the save transaction,
  after allocation, assert the claimed `seq` exceeds `coalesce(max(seq), 0)` for that `(w, net)`,
  reading `max(seq)` **without** the `complete` filter. **Acceptance:** a test corrupts `next_seq`
  to a value at or below the current max, calls `save()`, and asserts it fails with a non-retryable
  error having committed no manifest row. The error code is taken from change 5's catalog; this task
  records which code was used and confirms no new code was minted.

- [ ] 7.11 **Pin the two negative controls that justify the shape of 7.9/7.10.** **Acceptance:**
  (a) a test with the unique index present but the invariant *absent* reproduces the gap case —
  store pruned to a single manifest at `seq = 34`, `next_seq` corrupted to `5` — and asserts the
  insert succeeds, the index raises nothing, and `load()` still returns `34`, proving the constraint
  alone does not close the hole; (b) a test asserts that with a *partial* `WHERE complete` index, a
  row whose `complete` is flipped to false falls outside coverage, proving why the full index was
  chosen.

- [ ] 7.12 **Record the change 7 dependency.** **Acceptance:** a written note in this file states
  that existing PostgreSQL deployments may already hold rows violating `UNIQUE (w, net, seq)`, that
  the PostgreSQL-to-SQLite data migration owns the decision on such rows (reject vs quarantine), and
  that this change does not decide it. Linked from change 7's task list.

- [ ] 7.13 **Record and compute the `sqlite_schema` digest at migrate time.** At the end of every
  successful `runMigrations`, digest the `sql` text of every `sqlite_schema` row carrying this
  schema's prefix, in a deterministic order, and store it in the lineage bookkeeping.
  **Acceptance:** a test asserts a digest is recorded after the lineage runs; that two schema values
  in one file yield two different digests; and that the digest recorded after `006` differs from one
  computed before it, proving recomputation rather than create-time-only capture. **Verification
  timing and the mismatch error are change 5's** — do not implement them here.

- [ ] 7.14 **Document the digest's limit.** **Acceptance:** the migration header and `docs/SCHEMA.md`
  both state that the digest detects corruption, not tampering, because it lives in the same
  unprotected file as the schema text it covers; neither describes it as a security control.

## 8. Translation rules that outlive this lineage

- [ ] 8.1 **Implement the `UNIQUE NULLS NOT DISTINCT` emulation rule.** **Acceptance:** in a
  throwaway database reproducing `chain_archive/001_chain_archive_core.ts:570`'s constraint shape, a
  unique index over `coalesce(contract_address, x'')` accepts two protocol-scoped rows differing only
  in `net` (both NULL address) and rejects an exact duplicate context. The chain-archive lineage
  itself is **not** ported (proposal non-goals).

- [ ] 8.2 **Add the sentinel-exclusion `CHECK`.** **Acceptance:** the same fixture asserts that a
  zero-length `contract_address` is rejected by
  `CHECK (contract_address IS NULL OR octet_length(contract_address) > 0)` — closing the hole where a
  real empty value collides with the NULL sentinel and a legitimately distinct row is wrongly
  rejected.

- [ ] 8.3 **Pin the naive `UNIQUE` as a negative control, and enforce the rule statically.**
  **Acceptance:** a test asserts that a plain `UNIQUE (vk_hash, net, scope, contract_address, tag)`
  **accepts** the duplicate — reproducing the v4 audit's own data-loss bug
  (`001_chain_archive_core.ts:63-70`, `:522-529`). A static check over every migration's SQL text
  asserts no `UNIQUE` constraint or unique index names a nullable column directly; the check runs
  even though the tier-1 lineage has no such constraint today, which is the point.

- [ ] 8.4 **Record the `WITHOUT ROWID` ruling and its falsifiers.** **Acceptance:** the migration
  headers state the per-table assignment and the reason payload tables are plain rowid tables; a
  note records the three conditions under which the negative would be meaningless (design §7.2) and
  which of them are refuted against the code.

- [ ] 8.5 **Re-confirm the `WITHOUT ROWID` direction on ext4.** **Acceptance:** L4's matrix is
  re-run under §0.2's gate at 4 KiB / 64 KiB / 4 MiB rows and the result recorded here with the
  command. If the *direction* inverts, §7.3's assignment is reopened and this task blocks §2.1.

## 9. Merged-spec deltas, docs, and the conformance re-run

- [ ] 9.1 **Verify the two `temporal-kv` delta headers byte-for-byte.** **Acceptance:**
  `grep -n "^### Requirement:" openspec/specs/temporal-kv/spec.md` output is pasted here and the two
  headers in `specs/temporal-kv/spec.md` are shown to match character-for-character — a paraphrase
  would silently create a new requirement rather than modify the existing one (design §16.3).

- [ ] 9.2 **Record the deliberate non-deltas.** **Acceptance:** this file records that the `listKeys`
  streaming/ordering requirement (`openspec/specs/temporal-kv/spec.md:213`) and the
  caller-supplied-transaction-handle requirement (`:104`) are deliberately untouched, with the
  reasons and the changes that own them (design §16.5), so an auditor sees a decision rather than an
  omission.

- [ ] 9.3 **Rewrite `docs/SCHEMA.md`.** **Acceptance:** it describes the SQLite lineage, the prefix
  convention, the `STRICT`/`CHECK` guarantees, the junction table with the containment direction
  stated, and the narrowed meaning of the `schema` parameter. `docs/CONTRACT.md` §2's text is
  unchanged in substance; only its "generated schema reference" pointer is retargeted.

- [ ] 9.4 **Re-execute P1–P10 against the new shapes.** **Acceptance:** the conformance suite is
  **re-run, not amended**, and passes. A note records that the Lean cut-line `{T3, T5, W1, C1}`
  surviving untouched is **not** evidence this migration is safe — the abstract→concrete refinement
  was always a trusted, unmechanized bridge, and P1–P10 is what carries the refinement claim
  (`SYNTHESIS.md` trap 8).

- [ ] 9.5 **Validate the change.** **Acceptance:**
  `/usr/local/bin/openspec validate v1.0.0-sqlite-schema-parity --type change --strict --no-interactive`
  exits zero, and its verbatim output is recorded here.

## 10. R-3 Class B/C invariants owned by this change (I-5, I-7)

- [ ] 10.1 **Implement the migration-lineage check (I-5).** A static check over the lineage
  asserting every DDL-issuing migration begins with non-idempotent DDL, plus a no-op registry
  containing exactly `005_kv_current_fillfactor`. **Acceptance:** the check passes over the whole
  lineage; a deliberately added `CREATE TABLE IF NOT EXISTS` first statement fails it; a
  deliberately added empty migration absent from the registry fails it; `005` passes only via the
  registry, whose entry carries the §19.1 justification.

- [ ] 10.2 **Pin re-entry as an executable test.** **Acceptance:** a test removes a migration's
  `_migrations` row from a throwaway database, re-runs `runMigrations`, and asserts the migration
  fails on its first statement with an "already exists" error — not a silent success. A companion
  negative-control test with an `IF NOT EXISTS` first statement asserts the silent success, pinning
  what the law prevents.

- [ ] 10.3 **Assert per-migration atomicity and partial-lineage distinguishability.**
  **Acceptance:** a migration failing on a later DDL statement leaves none of its DDL and no
  `_migrations` row; after a mid-lineage failure, `_migrations` records exactly the committed
  migrations and the `sqlite_schema` digest still describes the previous successful run. A note
  records that neither signal alone identifies the missing migration (design §19.1).

- [ ] 10.4 **Answer change 7's Q-2 in writing and implement the ruling (I-7).** **Acceptance:** a
  note records that today's read path takes `identifiers` from the denormalised column
  (`transaction-history-storage.ts:238`, rationale at `:229-232`), that `entry` retains both
  identifiers and lifecycle (`StoredEntryJson`, `:160-169`), and that the ruling is to derive from
  `entry` with the junction cross-checked. `decodeRow` is changed accordingly. Linked from change
  7's Q-2.

- [ ] 10.5 **Implement both cross-checks.** Lifecycle column equals `entry.lifecycle.status`;
  identifier set derived from `entry` equals the junction rows as a **set**. **Acceptance:** four
  tests — a deleted junction row, an added junction row, a diverged lifecycle column, and a
  reordered/duplicated `entry.identifiers` array — assert failure on the first three and success on
  the fourth. Failures surface as a non-retryable `StorageError` through the existing catch-all at
  `:250-260`, never a raw `TypeError`; the task records which catalog code was used and confirms no
  new code was minted.

- [ ] 10.6 **Pin the dropped-cross-check negative control.** **Acceptance:** a test with the
  cross-check disabled asserts a damaged junction yields a wrong identifier set with **no error**
  and every value digest still passing — and that the wrong set propagates into the
  identifier-subset pending-clear predicate.

- [ ] 10.6b **Add the anti-downgrade trigger DDL to migration `009` (gate G-6).** One
  `BEFORE UPDATE OF dg … WHEN NEW.dg IS NULL AND OLD.dg IS NOT NULL → RAISE(ABORT, …)` trigger per
  covered table, named through `qualify()`, using no user-defined function. **Acceptance:**
  `UPDATE t SET dg = NULL` on a digested row aborts; a non-NULL-replacing-non-NULL recompute
  succeeds; a NULL-to-value backfill write succeeds; a negative-control test with only the
  drift-guard trigger installed demonstrates the NULL update being **accepted**, pinning what this
  trigger closes. The requirement is change 5's; only the DDL is implemented here.

- [ ] 10.6c **Carry the write-lock-exclusivity qualifier on every migration-lock claim (gate
  G-9).** **Acceptance:** both concurrent-`runMigrations` scenarios (in
  `specs/storage-schema/spec.md` and `specs/temporal-kv/spec.md`) state that cross-process exclusion
  rests on SQLite's file-level write lock, that those locks live in `-shm` under WAL, and that the
  claim holds only under change 3's source guard plus the documented embedder precondition. A grep
  for `-shm` in this change returns hits. Change 3's inheritance-table row **E-7** is tracked in its
  own tasks.md (task 3.11) and is not re-filed here.

- [ ] 10.7 **Add migration `009_value_digests`.** `ALTER TABLE … ADD COLUMN dg BLOB` (nullable, no
  default) on `kv_event`, `watermarks` and `transaction_history`, each with a named
  `CHECK (dg IS NULL OR octet_length(dg) = 32)`, plus change 5's drift-guard triggers named through
  `qualify()`. **Acceptance:** the migration applies; a 31-byte digest is rejected with the
  constraint name in the message; a `NULL` digest is accepted; tasks 1.2 and 1.3 cover the new
  trigger names; the migration's first statement is the `ALTER TABLE`, satisfying 10.1. **The
  digest's computation, verification and trigger predicate are change 5's** — do not implement them
  here. `kv_event` is change 2's table; `009` only adds a column and must run after change 2's
  `001`.
