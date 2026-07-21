# Tasks — Sprint 3: CheckpointStore

Each task: implemented by a Sonnet builder, then reviewed in parallel by two Opus auditors
(spec-compliance against this change's `design.md`; code quality/docs/test coverage). A task is
CLOSED only after both auditors approve, or their findings are fixed and re-reviewed. Matches
Sprint 1/2's own review cadence.

## 0. Preconditions and schema

- [ ] 0.0 **Reconciliation gate.** Confirm `sprint-2-transaction-lease` has merged to `main` (or,
  if implementation of this sprint starts before that merge, confirm the exact commit of that
  branch this sprint is built against). Diff `design.md` §8's assumed
  `TransactionLeaseLayer`/`TransactionHandle`/`resolveTransaction` shapes against whatever
  actually landed; if Sprint 2's own Codex-clearing pass changed any of those signatures, update
  this change's `design.md` §8 before proceeding. **Acceptance:** a one-line note recorded in
  this file (or a follow-up commit) stating either "no reconciliation needed, shapes match
  `design.md` §8 exactly" or listing what changed and where §8 was updated.
- [ ] 0.1 Write `src/postgres/migrations/002_checkpoint_store.ts` (`design.md` §6): `ckpt_chunks`,
  `ckpt_manifests` (with `manifest_hash bytea NOT NULL` and `label text`, `design.md` §5), the
  corrected `ckpt_manifest_chunks` (`(manifest_id, position)` PK and the `manifest_id ... ON
  DELETE CASCADE` FK, `design.md` §2.1 — NOT the `(manifest_id, chunk_hash)` PK / no-delete-action
  FK in `design/design.md` §3, which this change's own §2.1
  supersedes for this table only), `ckpt_sequence_counters` (`design.md` §2.2), and both indexes.
  Add the migration to `src/postgres/migrate.ts`'s `migrations` array.
  **Acceptance:** after `runMigrations`, all four tables and both indexes exist (verified via
  `information_schema`/`pg_constraint`, not just "the migration didn't error" — same standard
  Sprint 1 task 0.4 used); a test asserts `ckpt_manifest_chunks`'s primary key is specifically
  `(manifest_id, position)`, not `(manifest_id, chunk_hash)` (a schema-shape regression here would
  silently reintroduce the repeated-chunk bug `design.md` §2.1 fixes); a test asserts the
  `manifest_id` FK's delete action is specifically CASCADE (`pg_constraint.confdeltype = 'c'`) —
  without it, every real `prune` fails with SQLSTATE 23503 and GC cannot run at all
  (`design.md` §2.1/§3).
- [ ] 0.2 **Repeated-chunk regression test, direct SQL level.** Before any adapter code exists:
  insert one manifest row, then insert two `ckpt_manifest_chunks` rows for it referencing the
  **same** `chunk_hash` at positions `0` and `2` (with a different chunk at position `1`) —
  confirm this succeeds (proving the schema fix actually admits the case it exists for) and that
  a `SELECT ... ORDER BY position` recovers all three rows in the right order. **Acceptance:** this
  test would have failed against the original `design/design.md` §3 junction table (a comment in
  the test says so, referencing `design.md` §2.1) and passes against the corrected one.

## 1. Chunking and write path

- [ ] 1.1 Implement `PgCheckpointStore.save` (`design.md` §1, §2.2, §5's `manifest_hash`
  computation) against `src/interfaces/checkpoint-store.ts` exactly, composing
  `PgTransactionLeaseLayer.withTransaction` (`design.md` §8). **Acceptance:** `tsc --noEmit`
  passes with `PgCheckpointStore implements CheckpointStore`; a test saves data whose length is
  not an exact multiple of `DEFAULT_CHUNK_SIZE` and confirms the last chunk is the correct
  (shorter) remainder, not padded or truncated; a test reads the saved manifest row back via
  direct SQL and asserts `complete = true` — the INSERT must write it explicitly, `design.md`
  §2.3: if the schema's `DEFAULT false` leaked through, `load`/`history`/`prune`'s `complete`
  filters would all see zero rows while every save appeared to succeed (and no code path in this
  sprint may ever write `complete = false`, per §2.3's closing rule).
- [ ] 1.2 **Sequence allocation test.** Concurrently call `save` many times (e.g. 20, via
  `Promise.all`) for the same `(walletId, networkId)` and assert the resulting `seq` values are
  exactly `1..20` with no gap and no repeat (`design.md` §2.2's claim that the upsert-increment is
  gapless under concurrency, not just under sequential calls). Separately, confirm two different
  `(walletId, networkId)` pairs each independently start at `1` (the `ckpt_sequence_counters` PK
  is `(w, net)`, not global). Also assert every returned `sequence` is a JS `number`
  (`typeof === "number"`), not the driver's `bigint` — `design.md` §2.2's boundary coercion,
  which Sprint 1's global `types: { bigint: postgres.BigInt }` mapping makes necessary — and
  that a deliberately rolled-back `save` (force a mid-transaction failure after the sequence
  claim) consumes no number: the next successful save receives the sequence the failed one had
  claimed, keeping the assigned run gapless.
- [ ] 1.3 **Dedup test.** Save two checkpoints (same or different wallets) that share at least one
  identical chunk of content; confirm `ckpt_chunks` has exactly one row for that hash after both
  saves (global cross-wallet dedup, `design/design.md` §3's chunk-write idempotence, Law C1). Also
  confirm re-saving already-stored content refreshes `created_at` (the GC-clock-refresh behavior
  `design.md` §3's grace-window note depends on) without changing `data`.
- [ ] 1.4 Implement `manifest_hash` (`design.md` §5) as SHA-256 over the concatenated,
  position-ordered chunk-hash bytes, computed once at `save()` time. **Acceptance:** a test saves
  identical `data` twice as two separate checkpoints and confirms both manifests report the same
  `manifestHash` in their `CheckpointSummary` (same chunk sequence ⇒ same manifest hash,
  independent of `seq`). **Added per Codex's audit — the above alone doesn't distinguish a
  correct order-sensitive implementation from a constant hash, a sorted-hash-set hash, or a hash
  over raw payload bytes:** a second test compares two payloads producing the identical multiset
  of chunk hashes but in different order (e.g. swap two equal-size, distinct-content chunks) and
  confirms their `manifestHash` values differ, per the spec's order-sensitivity requirement.
  **Added per Codex's second-pass audit, which found the above two tests still don't pin down the
  exact scheme (SHA-256 over which bytes, in what encoding) — a known-vector test:** save a fixed,
  single-chunk payload (so there is exactly one chunk hash, eliminating any concatenation-order
  ambiguity), independently compute
  `crypto.createHash("sha256").update(thatChunkHashAsRawBytes).digest("hex")` in the test itself
  (via `node:crypto`, not by calling any `PgCheckpointStore` internals), and assert the returned
  `manifestHash` equals that independently-computed value exactly — ruling out double-hashing,
  hashing the hex-text representation instead of raw bytes, or a different digest function, none
  of which the two prior tests could distinguish from a correct implementation.
- [ ] 1.5 **`save` options-validation test** (`design.md` §1 step 1, the spec's ValidationError
  requirement): call `save` with `opts.chunkSize` above `SaveCheckpointOptionsSchema`'s 16 MiB
  bound and confirm it rejects with `ValidationError` before any work — the same standard
  `prune`'s `retainCount` validation (task 3.1) already gets. **Acceptance:** the test asserts
  the rejection type AND, via direct SQL after the rejected call, that no `ckpt_chunks` or
  `ckpt_manifests` row was written and no sequence number was consumed (the next valid save for
  that `(walletId, networkId)` still receives the next expected number).

## 2. Read path

- [ ] 2.1 Implement `PgCheckpointStore.load` (`design.md` §4), wrapping its manifest-resolve and
  chunk-fetch statements in one `withTransaction(fn, { isolation: "repeatable read" })` call
  (`design.md` §8) — manifest resolution (latest or by `sequence`), ordered chunk fetch, full
  rehash-and-verify of every chunk, concatenation, manifest-hash recomputation and comparison.
  **Acceptance:** a round-trip test (`save` then `load`) returns byte-identical `data` for at
  least one multi-chunk payload (not just a payload smaller than one chunk, which wouldn't
  exercise concatenation order at all); a test that mutates a stored chunk's bytes directly (test-
  only helper, bypassing `save`) confirms `load` throws `ChunkIntegrityError` with the correct
  `chunkHash`/`expectedHash`. **Corrected per Codex's audit (twice — the first fix targeted the
  wrong table) — a plain `DELETE FROM ckpt_chunks` on a still-referenced row is not reachable,
  since `chunk_hash`'s FK (unlike `manifest_id`'s, §2.1) has no delete action and raises SQLSTATE
  23503 before `load` ever runs:** the `ChunkMissingError` test instead brackets the corrupting
  delete with `ALTER TABLE ckpt_chunks DISABLE TRIGGER ALL` / `... ENABLE TRIGGER ALL` — **on
  `ckpt_chunks`, the referenced (parent) table, NOT `ckpt_manifest_chunks`**: Postgres implements
  one FK constraint as two independent trigger sets — INSERT/UPDATE-check triggers on the
  *referencing* (child) table, and DELETE/UPDATE-action triggers on the *referenced* (parent)
  table — and `ALTER TABLE X DISABLE TRIGGER ALL` only reaches triggers whose `tgrelid` is `X`.
  The trigger that raises SQLSTATE 23503 on a `DELETE FROM ckpt_chunks` while a `ckpt_manifest_chunks`
  row still references it is the parent-side trigger, defined on `ckpt_chunks` itself — disabling
  triggers on the child table (`ckpt_manifest_chunks`, the first fix's mistake) does nothing to
  suppress it. Disabling `ckpt_chunks`'s own triggers for the corrupting statement, then
  re-enabling them immediately after, is what actually removes a referenced row while its junction
  row still points at it, then confirms `load` throws `ChunkMissingError` carrying `mc.chunk_hash`'s
  value — not a generic null-reference failure and not an uncaught 23503. **Added per Codex's audit — a
  concurrency test:** using two raw `postgres.js` connections to control statement/commit timing
  directly (the interleaving needs finer granularity than the adapter's own methods expose), begin
  a `load` call, and — after its manifest-resolve statement but before its chunk-fetch statement —
  commit, on the second connection, a `prune` that would otherwise cascade-delete this exact
  manifest's junction rows; confirm the in-flight `load` still returns the pre-prune payload
  correctly (its REPEATABLE READ snapshot insulates it, `design.md` §4/§8), not a
  truncated/empty result and not an uncaught error.
- [ ] 2.2 Implement `PgCheckpointStore.history` (`design.md` §5), wrapping the page query and each
  summary's metadata aggregation in one `withTransaction(fn, { isolation: "repeatable read" })`
  call (`design.md` §8): newest-first, `limit`/`before` cursor paging. **Acceptance:** a test saves
  N checkpoints and pages through `history` with a
  `limit` smaller than N, confirming the `before` cursor from one page correctly continues into
  the next with no duplicate and no gap; a test confirms `history` is scoped per
  `(walletId, networkId)` — a second wallet's checkpoints never appear in the first's history;
  a test confirms `history` for a pair with zero checkpoints resolves `[]`, not an error (the
  spec's "lookup vs. load" distinction); a test confirms each returned `CheckpointSummary`
  carries the save-time `label` round-tripped (and no label when none was given — never an empty
  string), `byteLength` equal to the original `data.byteLength` (coerced from the aggregate
  query's driver-returned `bigint`, `design.md` §5, not left as `bigint`), the correct
  `chunkCount` (same coercion), a populated `createdAt` `Date`, and a hex-string `manifestHash`
  (coerced from `bytea`, `design.md` §5) — not a raw `Buffer` (the spec's summary-metadata
  requirement, and Codex's audit finding on the bigint/hex boundary conversions). **Added per
  Codex's audit — a concurrency test:** analogous to 2.1's, confirming a `prune` committing
  between the page query and a page entry's own aggregate query does not produce a
  `byteLength`/`chunkCount` for that entry that reflects a different instant than the page listing
  it.
- [ ] 2.3 `CheckpointNotFoundError` coverage: a test calls `load` for a `(walletId, networkId)`
  with zero checkpoints, and separately for a valid wallet+network but a `sequence` that was
  never written, confirming both reject with `CheckpointNotFoundError` carrying the right
  `walletId`/`networkId`/`sequence` fields (not a generic not-found error).
- [ ] 2.4 **`ManifestCorruptError` coverage** (`design.md` §4's dense-position check): via direct
  SQL (test-only, bypassing `save` — no `save` path can produce this, which is exactly why the
  check is defense-in-depth), give one manifest junction rows at positions `0, 1, 3` with no
  `2`, then call `load` for it. **Acceptance:** `load` rejects with `ManifestCorruptError` whose
  `reason` names the structural failure — not a silently short-concatenated payload, not a
  generic error, and not `ChunkMissingError` (the chunks all exist; the *manifest's shape* is
  what is wrong).
- [ ] 2.5 **Cancellation (`opts.signal`) coverage** (`design.md` §8's cancellation paragraph, the
  spec's `AbortError` requirement, now unified across all four methods per the H1 fix): for each
  of `save`/`load`/`history`/`prune`, calling with an already-aborted signal rejects with
  `AbortError` and issues no statement. **Mid-transaction abort, made deterministic per Codex's
  audit (twice: first for finding no task covered `prune`'s claim at all, second for finding
  the "abort while in flight" language gave no actual synchronization mechanism for landing the
  abort mid-transaction rather than before or after it) — for each of `save`/`prune`:** from a
  second raw connection, hold a lock the target call's transaction will need (e.g. a row lock on
  a `ckpt_manifests`/`ckpt_chunks` row the call must touch, or the writer-lease advisory lock if
  the call composes one), so the real call — invoked normally through the public
  `save`/`prune` method, not a hand-rolled replica — starts its transaction, executes its
  statements up to the point of contention, and blocks; poll `pg_stat_activity`/`pg_locks` until
  the call's backend is confirmed waiting on that lock (not merely "probably blocked by now" —
  actually observed); fire the abort at that confirmed instant; release the second connection's
  lock; confirm the call rejects with `AbortError` and, via direct SQL, that no manifest, junction,
  or chunk row from that call is visible and (`save` only) no sequence number was consumed (the
  next successful `save` receives the aborted call's number — overlaps deliberately with 1.2's
  rollback-gaplessness check, from the abort path specifically). This is the first task to
  actually pin the abort to a confirmed mid-transaction instant, for either method, rather than
  describing the timing in prose alone.

## 3. GC (`prune`)

- [ ] 3.1 Implement `PgCheckpointStore.prune` (`design.md` §3): manifest-prune then
  chunk-reclaim, both inside one transaction, `retainCount` rejected with `ValidationError`
  before either statement runs unless it is a safe integer `>= 1`
  (`Number.isSafeInteger(retainCount) && retainCount >= 1`, `design.md` §3). **Acceptance:** a test
  with `retainCount = 0` confirms `ValidationError` and confirms neither manifests nor chunks
  changed (no partial effect from the rejected call); **added per Codex's audit, which found the
  original bare `< 1` check admits values that would otherwise reach `OFFSET` and fail as a raw
  driver error:** further tests with `retainCount` equal to `NaN`, `Infinity`, and a non-integer
  such as `1.5` each confirm the same `ValidationError` rejection with no partial effect;
  **added per Codex's second-pass audit, which found `Number.isInteger` alone doesn't bound
  magnitude:** a further test with `retainCount = 1e20` (an integer, but not a safe one) confirms
  the same `ValidationError` rejection; a test
  prunes a manifest that has junction rows and confirms the manifest
  delete succeeds (no SQLSTATE 23503) with its junction rows cascade-deleted in the same pass
  (`design.md` §2.1's `ON DELETE CASCADE` — the exact failure the original no-delete-action FK
  guaranteed); review confirms the `withTransaction` call passes no `isolation` override
  (READ COMMITTED, `design.md` §3's stated dependency for the grace-window TOCTOU argument).
- [ ] 3.2 **Off-by-one regression test** (`design/design.md` §3's own documented fix — re-verify
  it against this sprint's real implementation, don't just trust the SQL comment): save `N`
  checkpoints for one `(w, net)`, `prune(retainCount = k)`, confirm exactly the `k` newest survive
  and the oldest `N - k` are gone — for at least one case where `k = 1` (the edge the original
  off-by-one bug specifically got wrong).
- [ ] 3.3 **Grace-window / TOCTOU test, deterministic** (`design/design.md` §3's dedup-refresh
  rationale; `design.md` §3's own comment on the mechanism). **Tightened per Codex's audit, which
  found the originally-permitted "simpler version" doesn't exercise the actual race, and that
  task 3.4's `Promise.all` fuzzing doesn't reliably reproduce it either** — this test MUST
  deterministically construct the mechanism, not rely on scheduler timing: backdate a chunk's
  `created_at` (via direct SQL) to past the grace window while it is still referenced by a live
  manifest; on one raw `postgres.js` connection, begin a transaction and run that chunk's
  `INSERT ... ON CONFLICT ... DO UPDATE` upsert as part of re-referencing it from a new `save`
  (refreshing `created_at`, acquiring the row's lock), but do NOT commit yet; on a second raw
  connection, concurrently run `prune`'s reclaim `DELETE` targeting that same chunk after its
  other manifest reference has been pruned away — under READ COMMITTED it sees the still-stale
  (pre-refresh) `created_at`, attempts to lock the row for deletion, and blocks on the first
  connection's held lock; commit the first connection's transaction; confirm the second
  connection's `DELETE` then completes WITHOUT deleting the chunk (Postgres re-evaluates the row
  via EvalPlanQual after the lock releases and sees the now-refreshed `created_at`, no longer
  matching the grace-window predicate) and that the chunk survives and remains loadable. As a
  separate, simpler supplementary test (not a substitute for the above): confirm a chunk created
  less than the grace window ago is never reclaimed while unreferenced, and is reclaimed by a
  later `prune` once the window has elapsed (a test-only backdated `created_at` is acceptable here
  too, to avoid a real-time sleep).
- [ ] 3.4 **Law C2a safety test, adversarial**: interleave `save` and `prune` calls (concurrently,
  via `Promise.all`, across multiple `(w, net)` pairs sharing common chunk content) for many
  iterations and confirm no `load()` call — for any checkpoint that `history()` still lists as
  surviving — ever throws `ChunkMissingError`. This is the sprint's hardest correctness bar
  (proposal.md's own risk note); a failure here is a real GC-safety bug, not a flaky test to
  retry past.

- [ ] 3.5 **`manifest_hash` tamper coverage** (`design.md` §4's new verification step — added
  because Codex's audit found `load` never recomputed `manifest_hash` at all in the original
  draft). Via a test-only helper, after a normal `save`, swap one junction row's `chunk_hash` for
  a *different*, independently-valid chunk hash (individually present and correctly hashed in
  `ckpt_chunks`, dense position range preserved), so every per-chunk integrity check and the
  position-density check both pass, then call `load`. **Acceptance:** the call rejects with
  `ManifestCorruptError` specifically because the recomputed `manifest_hash` no longer matches the
  stored value — proving this check fires on a substitution that the pre-existing per-chunk and
  position checks cannot catch on their own (the spec's tamper-detection requirement).

## 4. Property tests (`Formal/STORAGE_ALGEBRA.md` §5)

- [ ] 4.1 P6 (chunk idempotence): `fast-check` property — writing the same `(hash, data)` pair
  twice (via two `save` calls whose payloads share a chunk) leaves that chunk's stored `data`
  byte-identical and `ckpt_chunks`' row count for that hash unchanged (still exactly one row).
- [ ] 4.2 P7 (Law C1, adapter-private diagnostic): for two random chunk multisets saved in either
  order (across possibly-different wallets), the resulting global chunk set (by hash) is
  identical regardless of save order. Per `Formal/STORAGE_ALGEBRA.md` §5's own note, this needs a
  test-only diagnostic query against `ckpt_chunks` (clearly marked test-only, not part of the
  public `CheckpointStore` surface) since the public API has no "list all chunk hashes" method.
- [ ] 4.3 P8 (Law C2a, black-box, no adapter-private access needed): after random interleaved
  `save`/`prune` sequences, reload every checkpoint `history()` still lists via `load` and confirm
  none throws `ChunkIntegrityError`, `ChunkMissingError`, or `CheckpointNotFoundError` — the
  public-API formulation of "no reachable chunk is ever reclaimed," per that document's own
  framing of P8 as the practical version of C2a's safety property. (`ChunkMissingError` is
  asserted here beyond `Formal/STORAGE_ALGEBRA.md` §5's literal P8 wording, which omits it — a
  chunk reclaimed while still referenced surfaces as exactly this error, per
  `src/interfaces/checkpoint-store.ts`'s own doc for it, so it is the most direct C2a-violation
  signal this property can catch; found by this change's review, that document is not modified
  here.)

## 5. Sprint close-out

- [ ] 5.1 Whole-sprint differential review: an Opus auditor re-reads this proposal/design against
  the actual committed code and confirms every "Acceptance" criterion above was actually checked
  — a CI run passing is not sufficient evidence on its own, per Sprint 1's own close-out standard.
- [ ] 5.2 Update `ROADMAP.md`'s Milestone 2 checklist and `design/tasks.md`'s phase-map table
  (mark §2/§3 rows as superseded by this change, matching how Sprint 1 closed out its own §0/§1
  rows) so the roadmap doesn't drift from what's actually been built.
- [ ] 5.3 Per this repo's `CLAUDE.md`: re-run `graphify --update` against the repo root and commit
  the refreshed `graphify-out/` outputs in this close-out commit, so the knowledge graph doesn't
  silently drift stale behind this sprint's new openspec change and code.
