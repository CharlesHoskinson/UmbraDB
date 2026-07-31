# Acceptance — SQLite chain archive

Objective acceptance criteria for change `v1.0.0-sqlite-chain-archive`. Every criterion is traceable
to a requirement in `specs/chain-archive/spec.md` and to a task in `tasks.md`, and carries how it is
verified: **[unit]** unit test, **[prop]** property test, **[CI]** CI gate, **[doc]** checkable doc
artifact, **[manual]** manual reviewer evidence. Modelled on `v1.0.0-api-surface/acceptance.md`.

**Nothing here gates on a performance number.** Criteria M1–M6 gate on the *existence, conditions and
admissibility* of a measurement, never on its value.

## P — Preconditions (block the change)

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| P1 | `v1.0.0-sqlite-engine-core` has landed. The note records the binding and pinned version, runtime `sqlite_version()`, the fresh-connection default of `PRAGMA foreign_keys`, and the resolved B-2 (`synchronous`) and B-3 (`page_size`, `auto_vacuum`) values, each with the command that produced it. | [manual] | design §0 / 0.1 |
| P2 | Changes 3, 4 and 5 are recorded as landed or not, naming the four dependencies: `BEGIN IMMEDIATE`, `qualify()`+`STRICT`, B-6's status, and the digest regime. | [manual] | design §14.1 / 0.2 |
| P3 | The `auto_vacuum` consequence is recorded **before any archive file exists**: the value the file will be created with, whether a retention requirement exists, and — if one does at `auto_vacuum=0` — an explicit acceptance that retired space returns only via a full `VACUUM`. | [manual][doc] | "each archive relation is stored in one table" / 0.3 |
| P4 | The measurement gate's identity is recorded: harness path, `df -hT` for the target directory showing **not** `tmpfs`, and the `journal_mode`/`synchronous` it reports under. | [manual] | design §12 / 0.4 |
| P5 | Engine facts re-verified on the ruled binding and checked in with commands: `MAX_ATTACHED`, `MAX_COMPOUND_SELECT`, `MAX_VARIABLE_NUMBER`, `MAX_LENGTH`, `SQLITE_ENABLE_UPDATE_DELETE_LIMIT` presence, and the prototype member list. Differences from `design.md` §5.6 are enumerated. | [manual][CI] | "bulk deletion does not depend on an unpinnable compile option" / 0.5 |

## S — Scope and lineage

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| S1 | The lineage applies cleanly against a fresh zero-table file, and the per-schema `_migrations` table records each applied migration name. | [unit][CI] | "created empty and replayed forward" / 1.1 |
| S2 | No function, script or documented procedure reads chain-archive content from PostgreSQL; the absence is stated as a consequence of there being no data. | [manual][doc] | "created empty and replayed forward" / 1.8 |
| S3 | The archive sync entry point applies the lineage and ingests given only an archive file path, without opening the wallet database. | [unit][CI] | "own database file" / 7.1 |
| S4 | A static check asserts no transaction handle crosses the tier boundary, and fails against a deliberately introduced violation. | [unit][CI] | "own database file" / 2.3 |
| S6 | `grep -rn writer_generation` over this change hits a requirement, a migration and a scenario. Two `archive:sync` processes against one file: the displaced one's next write transaction rolls back with a non-retryable typed error distinct from every contention code. | [unit][CI] | "second process writing the archive file" / 1.9 |
| S7 | *(negative control)* Registration with the seeded row absent affects zero rows; the implementation fails with a named non-retryable startup error rather than proceeding with an undefined generation. | [unit] | same / 1.9 |
| S8 | *(negative control)* Without registration, two `archive:sync` processes both proceed — their `BEGIN IMMEDIATE` transactions interleave legally — demonstrating that transaction serialization is not process-level single-writer. No two writers both commit; no acknowledged commit is lost. | [unit] | same / 1.9 |
| S9 | A `SIGKILL`ed archive writer's successor registers with no cleanup step or expiry wait. | [unit] | same / 1.9 |
| S10 | The build-failing descriptor check covers the archive database path and its `-wal`/`-shm` sidecars, including indirectly derived paths; a deliberate violation fails the build. | [CI] | same / 1.10 |
| S11 | Every claim in this change resting on write-lock exclusivity — the row-lock-removal justification and the single-transaction ingest bundle — carries the descriptor precondition explicitly rather than reading as unconditional. | [doc][manual] | "guard trigger has a named counterpart", "ingest cursor advances" / 1.6, 3.4 |
| S5 | The lineage applies twice under two `schema` values against **one** archive file, producing two disjoint object sets — so file-per-lineage and change 4's prohibition on file-per-schema both hold. | [unit][CI] | "own database file" / 1.1 |

## A — The ATTACH prohibition

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| A1 | The tenth attach succeeds and the eleventh fails with `too many attached databases - max 10`; `PRAGMA compile_options` reports `MAX_ATTACHED=10`. | [unit] | "SHALL NOT be implemented with ATTACH" / 0.5 |
| A2 | A `REFERENCES` clause qualified with an attached database name is rejected at parse time at the qualifying dot. | [unit] | same / 0.5 |
| A3 | The prohibition is written as a requirement with the cross-file torn-commit evidence cited, so it is not re-proposed. | [doc][manual] | same / 1.8 |

## L — Physical layout

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| L1 | At `auto_vacuum=0`, **neither** `DROP TABLE` nor an equivalent `DELETE` reduces the file's size on disk, and both leave an equivalent freelist. | [unit] | "stored in one table" / 1.5 |
| L2 | At `auto_vacuum=FULL`, **both** reduce the file's size on disk, by the same amount within measurement noise. | [unit] | same / 1.5 |
| L3 | At `auto_vacuum=INCREMENTAL`, the `PRAGMA incremental_vacuum` cost is equivalent after either operation — reclaim cost is a property of the pages freed, not of the operation. | [unit] | same / 1.5 |
| L4 | `blocks`, `transactions` and `bridge_observations` are each a **single** table; a static check asserts the lineage creates no `UNION ALL` view over range tables, no `INSTEAD OF` trigger and no catch-all range table, and fails against a deliberately introduced one. | [unit][CI] | same / 1.4 |
| L5 | An unbounded `DELETE … WHERE height < :x` commits as one transaction, so a range is never observable half-retired — the atomicity argument for `DROP TABLE` is shown to be about chunking, not about the operation. | [unit] | same / 1.5 |
| L6 | *(negative control)* A revival proposal citing L5's `DROP`-returns-space finding is rejected, because the two halves were measured at different `auto_vacuum` settings; and re-measuring the timings alone does not revive it, because the retention-requirement condition is timing-independent. | [manual] | same / 1.5 |
| L7 | *(negative control, executable)* A throwaway `UNION ALL` view with proving range `CHECK`s still shows a search of **every** arm; the same query against one table shows a single search. | [unit] | "height-qualified read resolves in one index descent" / 1.5 |
| L8 | *(negative control, executable)* A throwaway **unguarded** `INSTEAD OF` routing trigger accepts an out-of-range row, raises nothing and stores nothing; the guarded form rejects the same row with the guard constraint name. | [unit] | "never accepts a row it does not store" / 1.5 |
| L9 | 500 view arms are accepted and 501 fails with `too many terms in compound SELECT`, recorded as a bound on any revived layout. | [unit] | "height-qualified read …" / 0.5 |
| L10 | A second canonical block at an already-canonical `(net, height)` is rejected by one partial unique index enforcing globally. | [unit][CI] | "at most one canonical block per height" / 1.2 |
| L11 | The `DEFAULT` catch-all partition, the partition generator and its `sql.unsafe()` path are not ported; the four PostgreSQL rollover failure modes are recorded as retired with reason, each attributed to that catch-all. | [doc][manual] | "never accepts a row it does not store" / 2.1 |

## D — Data-definition parity

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| D1 | Every object name the lineage creates — table, index **and** trigger — carries the schema prefix; a static check over the emitted SQL fails if one is missed. | [unit][CI] | design §5 / 1.1 |
| D2 | Each constraint in `design.md` §5.1 has one accepting and one rejecting test, and the rejecting test asserts the **expected constraint name**. | [unit][CI] | "guard trigger has a named counterpart" / 1.2 |
| D3 | The exact-duplicate NULL-address verifier-key observation is rejected by the `coalesce(…)` expression index. | [unit][CI] | "coalesce expression index, not a plain UNIQUE" / 1.3 |
| D4 | Two NULL-address observations differing only in `net` both persist. | [unit] | same / 1.3 |
| D5 | A zero-length `contract_address` is rejected by the sentinel-excluding `CHECK`. | [unit] | same / 1.3 |
| D6 | *(negative control)* A throwaway plain-`UNIQUE` build **accepts** the duplicate NULL-address row, reproducing the defect recorded at `001_chain_archive_core.ts:522-529`. | [unit] | same / 1.3 |
| D7 | The upsert on the expression index collapses repeated sightings to the minimum `first_seen_height`. | [unit] | same / 1.3 |
| D8 | Blob-role completeness, the removal guard and finalized monotonicity each reject with their constraint name. | [unit][CI] | "guard trigger has a named counterpart" / 1.6 |
| D9 | The removal guard's comment cites `001_chain_archive_core.ts:605-654` and names `BEGIN IMMEDIATE` (change 3) as what discharges the two-session proof. | [doc][manual] | same / 1.6 |
| D10 | The archive bootstrap reads `PRAGMA foreign_keys` back and refuses to apply the lineage if it is off; a test drives the refusal. | [unit][CI] | design §5.4 / 1.7 |
| D11 | The payload-bearing blob table is **not** `WITHOUT ROWID`; the narrow blob-role junction **is**. | [unit] | "blob content is stored in the database" / 1.1 |
| D12 | The five UNVERIFIED deferred categories and the cut `block_undo` table are recorded as unchanged by this port. | [doc] | design §5.2 / 1.8 |

## W — Write path

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| W1 | A static check asserts no constant in the archive adapter bounds rows per statement as a function of the bind-parameter ceiling. | [unit][CI] | "no bind-parameter row cap" / 3.2 |
| W2 | A bundle with more records than `MAX_VARIABLE_NUMBER / params-per-row` commits in one transaction. | [unit] | same / 3.2 |
| W3 | The ported store implements `ChainArchiveStore` (`src/interfaces/chain-archive-store.ts:189`) with no signature change; a caller-supplied hash is ignored in favour of the recomputed one. | [unit][CI] | "verified on read by recomputing its address" / 3.1 |
| W4 | A blob corrupted in the file after checkpointing raises a typed `code`-discriminated integrity error on read; the bytes are not returned. | [unit][CI] | same / 3.3 |
| W5 | *(negative control)* Corruption confined to a **stored blob's payload** (an overflow page, not a b-tree structure) leaves `PRAGMA integrity_check` reporting `ok` while the blob is returned as data. Stated in the **two-case** form — structural damage *is* detected — and the corruption offset is chosen with regard to page role so the test is deterministic about which case it exercises. | [unit] | same / 3.3 |
| W6 | `setWatermark` is no longer a separate commit; a randomised crash test across N trials shows the watermark never refers to a height whose bundle is absent. | [unit][CI] | "ingest cursor advances in the same transaction" / 3.4 |
| W7 | *(negative control)* A deliberately watermark-first two-transaction build produces the gap the crash test looks for, so the test is shown to detect it. | [unit] | same / 3.4 |
| W8 | Re-ingesting an already-committed height is a no-op rather than a duplicate-key error. | [unit] | same / 3.4 |
| W9 | No `DELETE … LIMIT` appears in archive code; the row-identifier rewrite deletes at most n rows. | [unit][CI] | "does not depend on an unpinnable compile option" / 3.5 |

## E — Errors

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| E1 | The translator selects the error class from the driver's **string** `code` alone. | [unit][CI] | "constraint identity survives the port" / 4.1 |
| E2 | Constraint-name extraction lives in one function, handles exactly the two message grammars, and returns an explicit unknown-constraint outcome otherwise. | [unit] | same / 4.1 |
| E3 | A round-trip test enumerates every constraint name the lineage declares, violates each, and asserts the extractor returns that exact name — driven from the lineage, so a new unrecoverable name fails without editing the test. | [unit][CI] | same / 4.2 |
| E4 | *(negative control)* A message-matching translator mis-routes under a message-wording change while the code-keyed one does not. | [unit] | same / 4.1 |
| E5 | Every negative-path assertion in the existing archive suite yields the **same** UmbraDB error class and the same `constraintName` as before the port. | [unit][CI] | "re-executed, not amended" / 4.3 |
| E6 | Any weakened or deleted assertion is its own reviewed commit naming the behaviour given up. | [manual] | same / 4.3, 9.1 |

## N — Snapshots

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| N0 | No module under `src/` opens a descriptor on an archive database path or its sidecars; the snapshot, manifest-derivation and restore-verification tooling lives outside `src/` beside the archive sync entry point, and the descriptor guard passes with **no** exemption entry. | [unit][CI] | "tooling runs outside the library process" / 5.0 |
| N0a | *(negative control)* An `src/`-resident snapshot module opening the three-file set voids the write lock exactly as a hostile reader would, with no error raised — rejected rather than exempted. | [manual] | same / 5.0 |
| N1 | The snapshot procedure states that a copy of the main file alone silently reverts to an older state while reporting a clean structural check, and that the shared-memory sidecar is never part of a snapshot. | [doc][manual] | "database file with no write-ahead-log dependency" / 5.6 |
| N2 | A produced artifact requires no sidecar file to reach the state its manifest describes. | [unit][CI] | same / 5.7 |
| N3 | A static check asserts the manifest derivation opens only the artifact path, never the source. | [unit][CI] | "derived from the finished artifact" / 5.2 |
| N4 | A snapshot produced under concurrent ingest matches its manifest on every derived field, and the restore verification passes. | [unit][CI] | same / 5.2, 5.7 |
| N5 | *(negative control)* A derive-from-source build produces a manifest that under-reports the artifact, and the test detects the mismatch. | [unit] | same / 5.2 |
| N6 | The manifest carries every field the identity requirement lists; a schema test rejects a manifest missing any of them. | [unit][CI] | "identifies the artifact" / 5.1 |
| N7 | A snapshot whose manifest names a different applied-migration list fails restore, naming the mismatch, and the archive is not opened for writing. | [unit][CI] | same / 5.4 |
| N8 | A wrong-network artifact is reported before any ingest occurs. | [unit] | same / 5.4 |
| N9 | Two artifacts of the same logical content produced by two different copy paths are **not** byte-identical yet have **equal** content digests. | [unit][CI] | same / 5.3 |
| N10 | The digest is a single hash over the ordered canonical `(net, height, block_hash)` sequence with a domain-separation prefix; the record states no Merkle tree, inclusion proof or third-party verification protocol is provided, citing `Formal/STORAGE_ALGEBRA.md` §6. | [doc][unit] | same / 5.3 |
| N11 | The restore report names the structural, identity, pragma and continuity outcomes separately; one injected failure of each kind yields an overall failure naming that check. | [unit][CI] | "four checks reported separately" / 5.4 |
| N11a | None of the four checks runs on archive open, inside the ingest loop, or on a timer; a static check asserts it. | [unit][CI] | same / 5.4 |
| N11c | Each check reports `pass`, `fail` or `n/a — no rows in scope`; none reports `pass` on an empty scope. | [unit][CI] | same / 5.4 |
| N11d | *(negative control)* All four checks run against a fresh zero-row archive — this change's own specified starting state — and the empty-scope checks report `n/a` with the overall result not a pass. A build reporting `pass` for all four fails this test. | [unit][CI] | same / 5.4 |
| N11b | Before M-7 exists, no document describes the verification pass as anything more than an on-demand diagnostic and post-restore check; no text recommends a periodic pass. | [doc][CI] | same / 8.7 |
| N12 | A `page_size` or `auto_vacuum` mismatch fails verification and is reported as unrepairable in place. | [unit] | same / 5.4 |
| N13 | Removing a canonical block from the middle of the range makes the continuity walk fail, naming the height. | [unit][CI] | same / 5.5 |
| N14 | No manifest field is named or documented as asserting completeness; the report states all four limits of the continuity walk with their reasons. | [doc][unit] | "makes no completeness claim" / 5.1, 5.5 |
| N15 | *(negative control)* A proposed completeness field justified by the walk passing is rejected, because each of the four limits admits an archive that passes and is incomplete. | [manual] | same / 5.5 |
| N16 | While B-6 is open, the procedure names **no** copy call; a named primitive is a defect, not a draft. | [manual][CI] | "no primitive named until measured" / 5.6 |
| N17 | *(negative control)* A proposal citing the corpus backup measurement is rejected once its recorded conditions show a binding other than the ruled one. | [manual] | same / 5.6 |
| N18 | If B-6 rules no live primitive acceptable, the quiesce-then-copy procedure using the entry point's existing signal stop path is accepted as complete. | [manual][doc] | same / 5.6 |
| N19 | Round trip: a snapshot of a populated archive restores into a fresh location, passes all four checks, and resumes ingest from its watermark — with ingest active during production. | [unit][CI] | all snapshot reqs / 5.7 |

## R — Durability posture

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| R1 | The archive's `synchronous` default is recorded as the same as the wallet tier's, with change 5's three preconditions plus the per-table re-derivability determination enumerated. | [doc][manual] | "not lowered without four preconditions" / 6.1 |
| R2 | No document in this change states a commits-per-second figure, throughput ratio or latency for any `synchronous` level as an established fact. | [doc][CI] | same / 6.1 |
| R3 | *(negative control)* A lowering proposal justified only by "the archive is re-derivable" is rejected, citing `design/full-chain-storage-design.md` §7 on `bridge_observations` and §4.5/§3 on `verifier_key_observations`. | [manual] | same / 6.1 |
| R4 | Every table in the lineage carries exactly one integrity classification; the covered set is `bridge_observations`, `verifier_key_observations` and the archive `watermarks`. A test asserts the list is exhaustive against the lineage's own table list and fails if a table is added without a classification. | [unit][CI] | "stated integrity classification" / 6.2 |
| R5 | `chain_blob_roles` appears explicitly in the classification table — the table the adjudicated ruling records as omitted from its own first enumeration. | [doc][unit] | same / 6.2 |
| R6 | *(negative control)* A proposal to leave every archive table uncovered on re-derivability grounds is rejected, because the same premise was already refused for this tier's durability setting. | [manual] | same / 6.1, 6.2 |
| R7 | *(negative control)* A proposal to add digest columns to `blocks` and `transactions` for uniformity is rejected: their exposure is Class B, which a digest cannot detect, and the cost lands on the only chain-scale tables. | [manual] | same / 6.2 |
| R8 | `dg` is nullable **and** carries the named null-tolerant `CHECK (dg IS NULL OR octet_length(dg) = 32)` in the introducing migration; no NULL-rejecting constraint exists; a 31-byte digest is rejected naming the constraint; `NULL` and 32 bytes are accepted; covered tables remain `STRICT`. | [unit][CI] | "digest column and its guards" / 6.3 |
| R8a | The refuted rationale is gone: no text in this change claims a length constraint would foreclose the NULL marker, and the record states that even the bare form accepts NULL under three-valued logic. | [doc][CI] | same / 6.3 |
| R8b | `UPDATE … SET dg = NULL` over a non-NULL digest is rejected naming the anti-downgrade guard; *(negative control)* without that trigger the update is accepted and the row is permanently downgraded. A legitimate joint recompute of value and digest is permitted. | [unit][CI] | same / 6.3 |
| R9 | Updating a covered column while leaving `dg` unchanged is rejected, naming the prefixed drift-guard constraint; the constraint-name round-trip test covers the new trigger names. | [unit][CI] | same / 6.3, 4.2 |
| R10 | *(negative control)* A generated-column digest computed by a user-defined function is rejected — the schema would depend permanently on that function, and `ADD COLUMN … STORED` fails on a populated table. | [manual] | same / 6.3 |
| R11 | A corrupted covered value raises the typed value-integrity error naming table and primary key, without returning the bytes; a covered row whose `dg` is NULL raises the **same error** rather than returning with a warning, because this lineage ships no backfill. A static check asserts no warn-and-return branch exists on the covered read path. | [unit][CI] | same / 6.4 |
| R12 | The archive ships with no digest backfill: `dg` exists from the migration that creates each covered table, and the change record states the backfilled-digest caveat does not apply to this lineage. | [doc][unit] | same / 6.3 |
| R13 | **I-2** — a second canonical block at one `(net, height)` is rejected on write; a companion test constructs the two-canonical-rows state and shows a per-row digest sweep does **not** detect it while the invariant query does. | [unit][CI] | "invariant I-2" / 6.5 |
| R14 | The partial-versus-full index distinction is stated from this side, citing change 4's opposite ruling for the manifest table, so the two do not read as inconsistent. | [doc][manual] | same / 6.5 |
| R15 | **I-8** — a cursor beyond `coalesce(max(height), -1) + 1` raises on read. | [unit][CI] | "cursor is bounded by its data" / 6.5 |
| R15a | *(negative control)* With **zero** block rows and a positive cursor the invariant raises; a build using a bare `max(height)` instead evaluates the comparison to NULL and silently does not fire — on exactly the state the archive starts in. | [unit] | same / 6.5 |
| R16 | **I-6** *(negative control)* — a corrupted-forward cursor with a monotonic guard latches **permanently**: the test drives four consecutive legitimate advances and asserts all four are silently discarded without I-6, and that with I-6 the **first** suppression verifies the incumbent digest and raises. | [unit] | same / 6.5 |
| R16a | The I-6 check runs on the **suppression** path, not the success path; a test asserts a check placed only on the success path never fires for a corrupted-high cursor. | [unit] | same / 6.5 |
| R16b | The two-cursor asymmetry is documented: the wallet-sync cursor names a position in a chain UmbraDB does not hold, so the data-side check offered as a general watermark escape hatch was not implementable there; the archive carries both the digest and the bound rather than trading one for the other. | [doc][manual] | "cursor is bounded by its data" / 6.5 |
| R16c | Cross-side consistency: change 5's assertion that no `dg` column exists on `chain_blobs`, `blocks`, `transactions` or `chain_blob_roles` and this change's UNCOVERED classification of those tables are both present, so neither side can drift without failing the other's test. | [CI][manual] | "stated integrity classification" / 6.2 |
| R17 | The rebuild path is written and has **one executed transcript** showing an altered projection column reported as divergent; its two limits are stated with it. Until the transcript exists, a check asserts the contract's archive row claims only resync from chain. | [manual][doc][CI] | "written rebuild path" / 6.6, 8.4 |
| R18 | *(prohibition)* No archive requirement assumes a page-checksum shim; the archive does not pre-set reserved bytes on its file, because that would permanently freeze `page_size`. | [doc][unit] | "blob content … verified on read" / 6.2 |

## C — CLI coherence

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| C1 | `npm run typecheck` passes with `chain-archive-sync/**/*.ts` still in `tsconfig.json`'s include set. | [CI] | "coherent across typecheck, build and run" / 7.1 |
| C2 | `npm run build` succeeds with `chain-archive-sync` still in `tsconfig.build.json`'s exclude list. | [CI] | same / 7.1 |
| C3 | `npm run archive:sync` starts against a file path, applies the lineage, and exits cleanly on a termination signal. | [manual][CI] | same / 7.1 |
| C4 | The release record names the connection-input change as a break, prices it as one changelog entry pre-tag (`docs/STABILITY.md:46`, `:60-61`) and as a forced major post-tag across a channel with no registry chokepoint. | [doc] | same / 7.2 |
| C5 | Change 1's Q-3 is either answered by the owner and recorded, or recorded as unanswered with the list of items whose price flips if the answer is yes. | [manual][doc] | design §15 Q-A2 / 7.3 |

## M — Measurement obligations (gate on existence and admissibility, never on value)

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| M1 | M-1 published to change 1's gate artifact with all gate conditions recorded and the co-transactional bundle as the unit of work. | [manual][CI] | "obligation to measure, not a number" / 8.1 |
| M2 | M-2 published with dataset size stated **relative to page cache** and caches dropped between runs. | [manual] | same / 8.1 |
| M3 | M-3 published with conditions and the measured blob-size distribution as input; a result contradicting the in-database ruling is escalated, not absorbed. | [manual] | same / 8.2 |
| M4 | M-4 published with row count, `auto_vacuum` value and whether the delete is chunked; it settles the `DROP`-versus-`DELETE` direction change 1's harness and this change's disagree about, and is not a layout input. | [manual] | same / 8.3 |
| M5 | M-5 published with a corruption injected per column and the per-column outcome recorded. It no longer decides coverage; it feeds the rebuild-path transcript (R17). | [manual] | same / 8.4 |
| M5a | M-7 published with the structural check and the digest sweep measured as **separate** components, at a stated representative scale, with writer concurrency driven from a **separate process**. | [manual] | same / 8.7 |
| M6 | M-6 published alongside change 5's B-6 record with the concurrent-writer commit count; it informs the stall question and does **not** choose the primitive. | [manual] | same / 8.5 |
| M7 | A check rejects any measurement whose stated filesystem is `tmpfs`, `ramfs` or anything the durability probe would refuse, and fails against a deliberately inadmissible entry. | [unit][CI] | same / 8.6 |
| M8 | This change's own verification runs were executed on a filesystem the probe would accept, with the binding, SQLite version, `journal_mode`, checkpoint discipline, table shape and row count recorded alongside each result. | [doc][manual] | same / 0.5 |
| M9 | Where those runs report a duration (the `DROP`-versus-`DELETE` reconciliation, design §3.2), it is recorded as informing a design ruling and **not** as satisfying any requirement; the ruling it supports is shown to hold in both measured directions, and the disagreement with change 1's harness is stated rather than reconciled by preference. | [doc][manual] | "obligation to measure, not a number" / 8.3 |

## X — Closeout

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| X1 | Every test from the three existing archive test files passes against the ported lineage or is retired in its own reviewed commit naming the behaviour that no longer exists. | [CI][manual] | "re-executed, not amended" / 9.1 |
| X2 | The archive test suite runs with no container runtime available. | [CI] | design §13 / 2.2 |
| X3 | `grep -rn "postgres" src/ chain-archive-sync/` returns no hits outside comments explaining the removal. | [CI] | design §11 / 2.2 |
| X4 | `src/postgres/chain-archive-rollover.ts`, `createHeightPartitions` and the `sql.unsafe()` partition-bound path are deleted; net lines for task 2.1 are strongly negative. | [CI] | design §13 / 2.1 |
| X5 | The live integration test still reports as **skipped**, not passed, when the devnet is absent, and a reproducible local procedure exists for running it for real. | [CI][doc] | design §1 / 9.2 |
| X6 | `design.md` §14.3 is a **closed record**: it tracks no sibling's state, asserts no line numbers, and states that each owning change makes its own edits under the sprint's remediation gates. The general discovery rule (file the finding against the sibling's `tasks.md`) is referenced to change 1's register rather than restated. | [doc][manual] | design §14.3 / 9.3 |
| X8 | `grep -rn "no CLI entry point" docs/` returns nothing; `docs/features/full-chain-storage.md`'s claim is corrected. | [CI] | design §14.4 / 7.4 |
| X9 | `src/postgres/migrations/chain_archive/index.ts:25-31`'s stale comment is retired by the lineage deletion, and the deletion note records the retirement as deliberate — it is a distinct second copy of the claim from `001_chain_archive_core.ts:86`. | [doc][manual] | design §14.4 / 2.2, 7.4 |
| X10 | The deletion inventory attributes `createHeightPartitions` and the `sql.unsafe()` partition-bound path to `001_chain_archive_core.ts`, and the 353-line rollover runbook to `chain-archive-rollover.ts` — two deletions in two files. | [doc] | design §3.4 / 2.1 |
| X11 | `page_size` change control is stated: pinned per lineage, recorded in the supply-chain inventory, revision is a new lineage decision. The value remains change 1's B-3. | [doc] | design §10.5.1 / 0.1 |
| X7 | `/usr/local/bin/openspec validate v1.0.0-sqlite-chain-archive --type change --strict --no-interactive` passes, output recorded verbatim. | [CI][manual] | all / 9.4 |
