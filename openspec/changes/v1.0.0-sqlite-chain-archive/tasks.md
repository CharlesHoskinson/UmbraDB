# Tasks — SQLite chain archive

Every task states its acceptance criteria concretely — what test passes, what command succeeds, what
artifact is checkable — per `openspec/config.yaml`'s tasks rule. Cadence matches Sprints 1–8: a
builder implements, two auditors review in parallel (spec compliance against `design.md` +
`specs/chain-archive/spec.md`; code and test quality), and a task is CLOSED only when both approve or
their findings are fixed and re-reviewed.

**Ordering.** §0 is a blocking gate and includes the one record that must be written *before any
archive database file is created*, because `auto_vacuum` and `page_size` are irreversible. §1 is the
DDL and blocks everything below it. §5 (snapshots) is the enhancement mandate and is deliberately not last —
it must be built while the schema is still malleable, because the manifest's derived fields are
queries against that schema. §9 is last because it re-executes the archive's existing test suite
against everything above.

## 0. Preconditions (blocking gate)

- [ ] 0.1 **Confirm `v1.0.0-sqlite-engine-core` has landed, and record what it ruled.**
  **Acceptance:** a written note in this file records the selected binding and its pinned version,
  the runtime `sqlite_version()`, the observed default of `PRAGMA foreign_keys` on a fresh
  connection, and the resolved values of B-2 (`synchronous`) and **B-3 (`page_size`,
  `auto_vacuum`)** — each with the command that produced it. If change 1 has not landed, STOP: §1
  onward is blocked, and §0.3 cannot be decided.

- [ ] 0.2 **Confirm changes 3, 4 and 5 have landed the four things this change is written against.**
  **Acceptance:** the note records that `BEGIN IMMEDIATE` is guaranteed on write paths (change 3),
  that `qualify(schema, name)` covers tables, indexes **and** triggers and that `STRICT` is
  obligatory (change 4), and the status of change 5's B-6 (copy primitive) and its digest regime.
  A landed B-6 unblocks §5.2's mechanism; an unlanded one does not block §5 at all, because §5
  specifies properties rather than a primitive.

- [ ] 0.3 **Record the `auto_vacuum` consequence for the archive — before any archive file exists.**
  The layout is already ruled (one table per relation), so this task no longer selects a layout. What
  it decides is whether retired space can ever return to the filesystem, which is irreversible.
  Requires the owner's answer to Q-A1 (is any height range ever retired?) and B-3's `auto_vacuum`
  value from 0.1. **Acceptance:** a written record stating the `auto_vacuum` value the archive file
  will be created with, whether a retention requirement exists, and — if one does and `auto_vacuum`
  is 0 — an explicit acceptance that retired space returns only via a full `VACUUM` with its exclusive
  lock and transient double disk usage.

- [ ] 0.4 **Record the ext4 measurement gate's identity for this change's obligations.**
  **Acceptance:** the note records the harness path, `df -hT` output for the target directory showing
  it is **not** `tmpfs`, and the `journal_mode`/`synchronous` settings it reports under. Every M-*
  obligation in `design.md` §12 references it.

- [ ] 0.5 **Re-verify the engine facts this change depends on, on the ruled binding, and record
  them.** **Acceptance:** a checked-in transcript records `MAX_ATTACHED`, `MAX_COMPOUND_SELECT`,
  `MAX_VARIABLE_NUMBER`, `MAX_LENGTH`, the presence or absence of
  `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`, and the binding prototype's members (to confirm the absence of
  an incremental-BLOB member and the presence of a backup member), each with the command that
  produced it. If the ruled binding differs from the one used in this change's `design.md` §5.6,
  the differences are enumerated and the affected requirements re-checked.

## 1. The ported data-definition language

- [ ] 1.1 **Translate `001_chain_archive_core.ts` to SQLite, table by table, through change 4's
  naming layer.** Every table `STRICT`; every object name (table, index **and** trigger) prefixed.
  **Acceptance:** the lineage applies cleanly against a fresh file; a test asserts every created
  object name carries the schema prefix; a test applies the lineage twice under two `schema` values
  against one file and asserts two disjoint object sets.

- [ ] 1.2 **Port every constraint enumerated in `design.md` §5.1, with a positive and a negative test
  per constraint.** **Acceptance:** for each of the two biconditional `CHECK`s on `blocks`, the
  fixed-length blob `CHECK`s, the composite primary keys, the composite foreign keys, the positional
  `UNIQUE` on `transactions`, the partial unique index on `blocks`, and the generated `size_bytes`
  column, one test asserts a legal value is accepted and one asserts an illegal value is rejected
  **with the expected constraint name**.

- [ ] 1.3 **Implement `verifier_key_observations`' identity as change 4's `coalesce(…)` expression
  index plus the sentinel-excluding `CHECK`, with the matching upsert target.** **Acceptance:** four
  tests — the exact-duplicate NULL-address insert is rejected; two NULL-address rows differing only
  in `net` both persist; a zero-length address is rejected by the `CHECK`; and the
  `ON CONFLICT … DO UPDATE SET first_seen_height = min(…)` upsert collapses repeated sightings to the
  minimum height. A fifth test constructs the naive plain-`UNIQUE` form in a throwaway database and
  asserts it **accepts** the duplicate, so the negative control fails against the implementation it
  targets.

- [ ] 1.4 **Create each relation as one table, and add the static check that forbids a
  table-per-height-range layout.** **Acceptance:** `blocks`, `transactions` and `bridge_observations`
  are each a single table; a check over the emitted SQL asserts the lineage creates no `UNION ALL`
  view over range tables, no `INSTEAD OF` trigger and no catch-all range table, and fails against a
  deliberately introduced one.

- [ ] 1.5 **Record the prohibited layout's two hazards as executable evidence, not prose.**
  **Acceptance:** two throwaway-database tests that do not touch the shipped lineage — one asserts a
  `UNION ALL` view with proving range `CHECK`s still searches **every** arm, and one asserts an
  **unguarded** `INSTEAD OF` routing trigger accepts an out-of-range row, raises nothing and stores
  nothing. Both must pass, because both document what a revival would reintroduce; the guarded form
  is asserted to reject the same row.

- [ ] 1.6 **Port the four guard triggers as `BEFORE … WHEN … RAISE(ABORT,'<name>')`, and delete the
  row-locking argument with a written justification.** **Acceptance:** blob-role completeness, the
  removal guard and finalized-monotonicity each have a rejecting test naming their constraint; a
  comment at the removal guard cites `001_chain_archive_core.ts:605-654` and states that the
  two-session interleaving proof is discharged by single-writer serialization under `BEGIN
  IMMEDIATE`, naming change 3 as its owner.

- [ ] 1.7 **Assert `PRAGMA foreign_keys` is ON before the archive lineage applies.**
  **Acceptance:** the archive bootstrap reads the pragma back and refuses to apply the lineage if it
  is off; a test drives the refusal.

- [ ] 1.8 **Record what is deliberately not translated.** **Acceptance:** a comment in the ported
  migration enumerates the dropped `fillfactor` storage parameter, the dropped `sql.unsafe()`
  partition-bound path and why its reason does not arise, and states that
  `design/full-chain-storage-design.md` §7's five UNVERIFIED deferrals and the cut `block_undo` table
  are unchanged by this port.

## 2. Retiring the PostgreSQL layout

- [ ] 2.1 **Delete `src/postgres/chain-archive-rollover.ts` (353 lines), the partition generator and
  the `DEFAULT` catch-all, and record the four PostgreSQL rollover failure modes as retired with
  reason.** **Acceptance:** the file is gone; `createHeightPartitions` and its `sql.unsafe()` path are
  gone; a note in the ported migration or the change record names each of the four failure modes from
  `design/full-chain-storage-design.md` §4.6 and states that each was caused by the `DEFAULT`
  catch-all partition, which is not ported. Net lines for this task are strongly negative.

- [ ] 2.2 **Delete the PostgreSQL archive store, its migrations directory and its
  Testcontainers-backed tests, replacing the tests with file-backed equivalents.**
  **Acceptance:** `grep -rn "postgres" src/ chain-archive-sync/` returns no hits outside comments
  explaining the removal; the archive test suite runs with no container runtime available.

- [ ] 1.9 **Add the `writer_generation` table and registration to the archive lineage, with the
  affected-row and read-back assertions from day one.** Mirrors `v1.0.0-sqlite-concurrency-lease`'s
  mechanism; no pid, host, heartbeat, TTL or lock file in the protocol. **Acceptance:** a test starts
  two archive writers against one file and asserts the displaced one's next write transaction rolls
  back with a non-retryable typed error distinct from every contention code; a test asserts the
  registration fails with a named non-retryable startup error when the seeded row is absent (zero
  rows affected) rather than proceeding with an undefined generation; a `SIGKILL` test asserts the
  successor registers with no cleanup step. `grep -rn writer_generation` over this change hits the
  requirement, the migration and the scenarios.

- [ ] 1.10 **Extend the build-failing descriptor guard to the archive artifact set.**
  **Acceptance:** the check rejects any call opening a descriptor on the archive database path or a
  path formed by appending `-wal`/`-shm` to it, including via a helper that derives the path rather
  than concatenating literally; a deliberately introduced violation fails the build.

- [ ] 2.3 **Add the cross-tier guard test.** **Acceptance:** a static check asserts that no
  archive-tier call site accepts a transaction handle originating from the wallet tier or vice
  versa, and the check fails against a deliberately introduced violation.

## 3. The adapter port

- [ ] 3.1 **Port `PgChainArchiveStore` to the SQLite client, preserving its method surface and its
  content-addressing discipline.** The store continues to compute each blob's SHA-256 itself and
  never accept one from a caller. **Acceptance:** the ported store implements the same
  `ChainArchiveStore` interface (`src/interfaces/chain-archive-store.ts:189`) with no signature
  change; a test asserts a caller-supplied hash is ignored and the recomputed one is stored.

- [ ] 3.2 **Convert the write path to prepared-statement reuse inside one `BEGIN IMMEDIATE`
  transaction, and introduce no row cap.** **Acceptance:** a static check asserts no constant in the
  archive adapter bounds rows per statement as a function of the bind-parameter ceiling; a test
  writes a bundle larger than `MAX_VARIABLE_NUMBER / params-per-row` in one transaction and asserts
  it commits.

- [ ] 3.3 **Implement verify-on-read for blobs.** **Acceptance:** a test corrupts a blob's bytes in
  the file after checkpointing, reads it back through the adapter, and asserts a typed
  `code`-discriminated integrity error is thrown and the bytes are not returned. A companion
  assertion shows `PRAGMA integrity_check` reports `ok` on the same file, so the negative control is
  the structural check's failure to notice.

- [ ] 3.4 **Fold the ingest watermark into the block bundle's transaction.** **Acceptance:**
  `chain-archive-sync/sync-service.ts` no longer issues `setWatermark` as a separate commit; a crash
  test kills the process at randomised points during ingest, reopens, and asserts the watermark never
  refers to a height whose bundle is absent, across N trials. A negative-control run against a
  deliberately watermark-first two-transaction build must produce the gap the test looks for.

- [ ] 3.5 **Rewrite the bounded-delete form as a row-identifier subquery.** **Acceptance:** no
  `DELETE … LIMIT` appears in archive code; a test asserts the rewrite deletes at most n rows; the
  engine-facts record from 0.5 states the observed compile-option value and that it is not relied on.

## 4. Errors

- [ ] 4.1 **Implement error translation keyed on the driver's string `code`, with constraint-name
  extraction confined to one function.** **Acceptance:** the translator selects the error class from
  `code` alone; the extraction function handles exactly the two message grammars and returns an
  explicit unknown-constraint outcome otherwise; a test asserts a message-only translator would
  mis-route while the code-keyed one does not.

- [ ] 4.2 **Add the constraint-name round-trip test, driven from the lineage's own declared names.**
  **Acceptance:** the test enumerates every constraint name the lineage declares, violates each in
  turn, and asserts the extraction function returns that exact name. Adding a constraint whose name
  is not recoverable fails the test without anyone editing the test.

- [ ] 4.3 **Re-execute every negative-path assertion in the existing archive test suite against the
  SQLite lineage.** **Acceptance:** the fork and dual-canonical cases, the foreign-key violation,
  blob-role completeness, the removal guard and finalized monotonicity each assert the **same**
  UmbraDB error class and the same `constraintName` as the PostgreSQL suite did. Any assertion that
  is weakened or deleted is its own reviewed commit stating what behaviour was given up.

## 5. Snapshots (the enhancement mandate)

- [ ] 5.0 **Place the snapshot tooling outside `src/`.** Snapshot production, manifest derivation and
  restore verification live beside the archive sync entry point, not in the published build, and
  operate on a finished artifact or a quiesced archive only. **Acceptance:** the descriptor guard of
  task 1.10 passes with no exemption entry; a static check asserts no module under `src/` opens a
  descriptor on an archive path or its sidecars; the build excludes the tooling exactly as it
  excludes `chain-archive-sync/`.

- [ ] 5.1 **Define and implement the manifest format.** **Acceptance:** the manifest carries every
  field in `specs/chain-archive/spec.md`'s identity requirement; a schema test rejects a manifest
  missing any of them; no field is named or documented as asserting completeness.

- [ ] 5.2 **Implement manifest derivation, reading only the finished artifact.** **Acceptance:** a
  static check asserts the derivation code opens only the artifact path; a test produces a snapshot
  under concurrent ingest, derives the manifest from the artifact, and asserts every derived field
  matches the artifact. A negative-control build that derives from the source before the copy must
  produce a mismatch the test detects.

- [ ] 5.3 **Implement the content digest.** **Acceptance:** the digest is a single hash over the
  ordered canonical `(net, height, block_hash)` sequence with a domain-separation prefix; a test
  asserts two artifacts of the same logical content produced by two different copy paths are **not**
  byte-identical yet have **equal** digests.

- [ ] 5.4 **Implement the four-check restore verification and its report, with a three-valued
  outcome per check.** Each check reports `pass`, `fail`, or `n/a — no rows in scope`; none reports
  `pass` on an empty scope. **Acceptance:** the report names the structural, identity, pragma and
  continuity outcomes separately; a test injects one failure of each kind and asserts the overall
  result is a failure naming that check; a test asserts a `page_size` mismatch is reported as
  unrepairable in place; and **a test runs all four against a fresh zero-row archive — the state this
  change specifies as the starting point — and asserts the empty-scope checks report `n/a` and the
  overall result is not a pass.** A negative-control build reporting `pass` for all four must fail
  that test.

- [ ] 5.5 **Implement the continuity walk and document its four limits where the result is
  reported.** **Acceptance:** a test removes a canonical block from the middle of the range and
  asserts the walk fails naming the height; a doc test asserts the report text states that the walk
  does not prove fork completeness, transaction completeness, bridge-observation completeness or body
  integrity, each with the reason from `design/full-chain-storage-design.md` §9.

- [ ] 5.6 **Write the snapshot procedure without naming a copy primitive until B-6 is recorded.**
  **Acceptance:** a review check asserts the procedure names no copy call while B-6 is open; when
  B-6 lands, the procedure names the ruled mechanism and cites the record. If B-6 rules no live
  primitive is acceptable, the procedure documents quiesce-then-copy using the sync entry point's
  existing signal stop path, and this task is complete — not incomplete for lacking a live primitive.

- [ ] 5.7 **Round-trip test: produce a snapshot from a populated archive, restore it into a fresh
  location, and verify.** **Acceptance:** all four checks pass; the restored archive resumes ingest
  from its watermark without error; the test runs with ingest active during snapshot production.

## 6. Durability posture

- [ ] 6.1 **Record the archive tier's `synchronous` decision as "same as the wallet tier" with the
  four preconditions for changing it.** **Acceptance:** the record states the default, enumerates
  change 5's three preconditions plus the per-table re-derivability determination, and contains **no**
  commits-per-second figure, throughput ratio or latency presented as an established fact.

- [ ] 6.2 **Implement the archive coverage set as closed by gate R-3.** **Acceptance:** every table
  in the lineage carries exactly one classification; `bridge_observations`, `verifier_key_observations`
  and the archive `watermarks` are covered; `chain_blobs`, `blocks`, `transactions` and
  `chain_blob_roles` are uncovered with their stated mechanisms; a test asserts the classification
  list is exhaustive against the lineage's own table list and fails if a table is added without one.

- [ ] 6.3 **Add the `dg BLOB` columns, the named null-tolerant length constraint, and both guard
  triggers through this lineage's DDL conventions.** Column nullable with
  `CHECK (dg IS NULL OR octet_length(dg) = 32)` in the introducing migration and no NULL-rejecting
  constraint; drift guard **and** anti-downgrade guard, both prefixed by `qualify()`, both aborting
  with the constraint name; tables still `STRICT`. The digest specification itself is change 5's and
  is cited, not restated. **Acceptance:** a test asserts a 31-byte digest is rejected naming the
  length constraint and that `NULL` and 32 bytes are accepted; a test asserts an update of a covered
  column leaving `dg` unchanged is rejected naming the drift guard; **a test asserts
  `UPDATE … SET dg = NULL` over a non-NULL digest is rejected naming the anti-downgrade guard, and a
  negative-control build without that trigger shows the update accepted and the row permanently
  downgraded**; a test asserts a legitimate joint recompute of value and digest is permitted; the
  constraint-name round-trip test of 4.2 covers both new trigger names.

- [ ] 6.4 **Verify on read for every covered column, with no opt-out, and treat an absent digest as
  an integrity failure.** **Acceptance:** a test corrupts a covered value in the file and asserts the
  read raises the typed value-integrity error naming table and primary key without returning the
  bytes; a second test asserts a covered row whose `dg` is NULL raises the same error rather than
  returning with a warning, because this lineage ships no backfill; a static check asserts no
  warn-and-return branch exists on the covered read path.

- [ ] 6.5 **Implement invariants I-2, I-6 and I-8.** **Acceptance:** I-2 — a test asserts a second
  canonical block at one `(net, height)` is rejected on write, and a companion test constructs the
  two-canonical-rows state directly and asserts a per-row digest sweep does **not** detect it while
  the invariant query does. I-6 — a test corrupts the cursor forward, drives **four** consecutive
  legitimate advances, and asserts a negative-control build without I-6 discards all four in silence
  (the latch is permanent, not a single miss), while with I-6 the **first** suppression verifies the
  incumbent digest and raises; a further test asserts the check sits on the suppression path, since a
  corrupted-high cursor produces no successful writes for a success-path check to fire on. I-8 —
  additionally, a test with **zero** block rows and a positive cursor asserts the invariant raises,
  and a negative-control build using a bare `max(height)` instead of `coalesce(max(height), -1)`
  asserts the comparison evaluates to NULL and the assertion silently does not fire. I-8 — a test sets the cursor beyond
  `max(blocks.height) + 1` and asserts the read raises.

- [ ] 6.6 **Write the rebuild path for `blocks` and `transactions`, and execute it once.**
  **Acceptance:** a written procedure plus one recorded transcript of an executed run; the transcript
  shows a deliberately altered projection column reported as divergent from the value re-derived from
  its rehash-verified blob; the documented limits (corrupt blob reference, un-synced body) are stated
  with it. Until this exists, the durability contract's archive row says only "resync from chain" —
  a check asserts the contract text does not claim a local rebuild before the transcript is recorded.

## 7. The sync entry point

- [ ] 7.1 **Port `chain-archive-sync/bootstrap.ts` and `sync-cli.ts` to the SQLite client, changing
  the connection input to a file path.** **Acceptance:** `npm run typecheck` passes with
  `chain-archive-sync/**/*.ts` still in the include set; `npm run build` succeeds with the directory
  still excluded; `npm run archive:sync` starts against a file path, applies the lineage and exits
  cleanly on a termination signal.

- [ ] 7.2 **Price the connection-input change in the release record.** **Acceptance:** the record
  names it as a break, states it costs one changelog entry landed before the 1.0.0 tag
  (`docs/STABILITY.md:46`, `:60-61`), and states that landed after the tag it would force a major
  version across a distribution channel with no registry chokepoint.

- [ ] 7.4 **Retire the two stale repository artifacts this change owns.**
  `src/postgres/migrations/chain_archive/index.ts:25-31`'s "not wired into any executing path"
  comment — the origin of the sprint's propagated error, and a distinct copy from the one at
  `001_chain_archive_core.ts:86` — goes with the lineage deletion in task 2.2, and the deletion note
  records that it was retired deliberately. `docs/features/full-chain-storage.md:81`'s "there is
  currently no CLI entry point or npm script for this feature" is a documentation file that no
  deletion carries away and is corrected here. **Acceptance:** `grep -rn "no CLI entry point"
  docs/` returns nothing; a grep for the inference-form phrases over `src/` and `docs/` returns no
  archive hits outside text explaining the correction.

- [ ] 7.3 **Route change 1's Q-3 to the owner and record the answer or its absence.**
  **Acceptance:** either the owner's answer on whether the repo-clone channel implies consumers
  running `archive:sync` from source, or an explicit statement that it is unanswered and gates the
  tag rather than this change, together with the list of items whose price flips if the answer is
  yes.

## 8. Measurement obligations

- [ ] 8.1 **Run M-1 and M-2** (ingest throughput at the stated requirement and at 10× and 100×; decay
  as the file grows past host RAM). **Acceptance:** results published to change 1's gate artifact
  with all gate conditions recorded, the co-transactional bundle as the unit of work, and dataset
  size stated **relative to page cache** with caches dropped between runs. The task is complete when
  the measurement exists and is admissible — not when it takes any particular value.

- [ ] 8.2 **Run M-3** (blob in-database/filesystem crossover at the ruled `page_size`).
  **Acceptance:** published with conditions and with the measured blob-size distribution as input;
  if the result contradicts the in-database ruling, that is recorded and escalated rather than
  absorbed.

- [ ] 8.3 **Run M-4** (range-retirement cost: `DELETE` of a height range and the reclaim cost of the
  chosen `auto_vacuum`, at archive-realistic row counts). **Acceptance:** published with the row
  count, `auto_vacuum` value and whether the delete is chunked. This settles the `DROP`-versus-`DELETE`
  direction that change 1's harness and this change's disagree about; it is **not** a layout input,
  because the layout ruling holds in both directions (design §3.3). It also sizes the write-lock hold
  a retirement would take.

- [ ] 8.4 **Run M-5, repurposed.** It no longer decides coverage — gate R-3 ruled `blocks` and
  `transactions` uncovered — so it now produces task 6.6's transcript and tells us which projection
  columns re-derive in practice. **Acceptance:** a corruption injected per column with the per-column
  outcome recorded, feeding the rebuild-path document.

- [ ] 8.7 **Run M-7** (`verifyIntegrity()` runtime at archive scale). **Acceptance:** the structural
  check and the digest sweep measured as **separate** components, at a stated representative scale,
  with writer concurrency driven from a **separate process** rather than the same one. Until this
  exists, no document in this change describes the pass as anything more than an on-demand diagnostic
  and the post-restore check; a check asserts no text recommends a periodic pass.

- [ ] 8.5 **Run M-6** (snapshot production cost and event-loop behaviour on the ruled binding at
  archive-realistic sizes, under concurrent ingest). **Acceptance:** published alongside change 5's
  B-6 record, with the concurrent-writer commit count. This informs §9.3's "may the archive stall
  longer" question; it does **not** choose the primitive.

- [ ] 8.6 **Assert inadmissibility.** **Acceptance:** a check rejects any measurement in this
  change's record whose stated filesystem is `tmpfs`, `ramfs` or anything the durability probe would
  refuse, and the check fails against a deliberately inadmissible entry.

## 9. Suite re-execution and closeout

- [ ] 9.1 **Re-execute the archive's full test suite against the SQLite lineage, amending nothing to
  make it pass.** **Acceptance:** every test from `chain-archive-migrate.test.ts`,
  `chain-archive-store.test.ts` and `chain-archive-rollover.test.ts` either passes against the ported
  lineage or is retired in its own reviewed commit naming the behaviour that no longer exists (the
  rollover suite is expected to be retired wholesale under §2.1, and that retirement states why).

- [ ] 9.2 **Re-enable the live integration test honestly.** `test/integration/chain-archive-sync.integration.test.ts`
  is `describe.skipIf`-skipped whenever the devnet is unreachable, *"the NORMAL state in CI"* by its
  own header. **Acceptance:** the suite still reports as skipped rather than passed when the devnet
  is absent, and a documented, reproducible local procedure exists for running it for real — because
  this is the only test that exercises the production entry point end to end, and a green CI run has
  never proved anything about it.

- [ ] 9.3 **Close the register.** **Acceptance:** `design.md` §14.3's list of sibling documents
  carrying R-1's refuted wording is re-checked; each is either amended by its own author or recorded
  as outstanding with an owner. This change does not edit another author's spec.

- [ ] 9.4 **Validate.** **Acceptance:**
  `/usr/local/bin/openspec validate v1.0.0-sqlite-chain-archive --type change --strict
  --no-interactive` passes, and its output is recorded verbatim in the change record.
