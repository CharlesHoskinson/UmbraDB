# Acceptance — TemporalKV on SQLite: the event log replaces the interval table

Consolidated, objective acceptance criteria for change `v1.0.0-sqlite-temporal-event-log`. Every
criterion is traceable to a requirement in `specs/temporal-kv/spec.md` and a task in `tasks.md`, and
is marked with how it is verified: **[unit]** unit test, **[prop]** property test, **[CI]** CI gate,
**[doc]** checkable doc artifact, **[manual]** manual reviewer evidence.

**No criterion here gates on a throughput or latency number.** Where a performance property is
load-bearing, the criterion is that the number was *established under stated conditions* (filesystem,
`synchronous`, `journal_mode`, dataset size relative to page cache) — never that it reached a value
carried over from the research corpus, six of whose seven lanes benchmarked against a tmpfs RAM disk
(`design.md` §12).

Requirement short names below: **EVT** = "the event log is the only stored temporal representation…";
**GAP** = "gap-freedom is structural…"; **APP** = "the event log is append-only…"; **WF** =
"WellFormed is the single remaining refinement obligation…"; **CLK** = "the write-timestamp clock
policy is decided by the engine-core measurement gate…"; **TXK** = "same-transaction key reuse is
adapter-enforced…"; **REP** = "the adapter never issues INSERT OR REPLACE…"; **ABT** = "trigger
assertions abort the statement…"; **QUA** = "the naive EXCLUDE transliteration is prohibited"; **CFG**
= "the engine configuration under which trigger-based enforcement is sound…". Modified requirements
are cited by their merged headers.

## Preconditions (block the whole change)

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| P0 | `v1.0.0-sqlite-engine-core`'s measurement gate has reported **R** under the stated conditions, and the recorded branch (no logical clock / logical clock + drift bound / durability-default change) follows from R mechanically. **If R is unrecorded, tasks 2.3 and 5.x are blocked.** | [manual][doc] | CLK / 0.1 |
| P1 | The T5 refinement-register rewrite is committed **strictly before** the first `src/` commit of this change (`git log` order is the evidence). | [manual][CI] | GAP / 0.2 |
| P2 | A written ruling exists naming which change re-points the two un-deltaed merged requirements ("Migrations are idempotent and ordered", "Schema isolation is the default, not opt-in"). | [doc] | `design.md` §0.3 / 0.3 |

## The encoding

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| A1 | The stored schema contains no `valid_to`, no stored range/`validity` column, and no interval-boundary column of any name — asserted against the live schema, not the migration source. | [unit][CI] | EVT / 1.1 |
| A2 | For a three-version key, the derived intervals are exactly `[t1,t2)`, `[t2,t3)`, `[t3,NULL)`, and the boundary `t2` is version 2's own stored `written_at`. | [unit] | EVT / 1.1 |
| A3 | The live version's derived `valid_to` is `NULL`, not a far-future sentinel. | [unit] | EVT / 1.1 |
| A4 | `EXPLAIN QUERY PLAN` for `getAt({at})` reports a covering-index search on `(ns, scope, key, written_at)`, not a scan. | [unit][CI] | EVT, T3 / 1.1 |

## The strengthening: T5(1) and T5(2)

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| B1 | An attempt to create a gap for one key leaves the derived `valid_to` of the previous version equal to the derived `valid_from` of the new one — no gap is observable regardless of what was written. | [prop] | GAP / 3.2 |
| B2 | **Negative control.** The interval-table design is demonstrated to accept `[400,500)` after `[200,300)` (the overlap trigger has nothing to say about gaps), and to let a middle-row `DELETE` open a gap. A green B1 without B2 does not close this row. | [prop] | GAP / 3.4 |
| B3 | Removing a middle version (assertions dropped) leaves the derived intervals contiguous and surfaces as a Law T1 version-chain gap — `getAt({version})` → `null` for a version that existed — not as a T5(2) violation. | [prop] | GAP, APP / 3.3 |
| B4 | No write produces overlapping derived intervals for one key; the attempt fails for the absence of a writable boundary, not for a named constraint violation. | [prop] | "History intervals never overlap for a single key (Law T5)" / 3.2 |
| B4a | **The boundary is written down, and it does not weaken B1–B4.** The record states that gap-freedom is structural for data written through the adapter **and** that the same unrepresentability makes conversion of a gap-bearing source lossy, with `[1000,2000)` + a live row at `3000` as the worked example. Reading "gap-freedom is structural" as a licence to import unchecked fails this row. | [doc][manual] | gap-boundary / `design.md` §4.4 |
| B4b | The worked fixture shows in one run that the source's `getAt({at:2500})` is `null` while the converted store's is version 1, **and** that row counts, per-row digests and every assertion this change specifies pass against that converted store. The negative control must be *shown passing* — its passing is the finding. | [prop][manual] | gap-boundary / 3.3b |
| B4c | A T3 claim across a conversion is established by comparing source and target answers per key, never inferred from the target satisfying T3 against its own events; and agreement with the abstract model is explicitly refused as grounds for converting silently. | [doc][unit] | T3 / 3.3b |
| B4d | S3 verification and the value transport are **cited** to `v1.0.0-sqlite-data-migration`, not re-implemented here. This change specifies semantics only. | [manual] | gap-boundary / 3.3b |
| B4e | A JS round trip is proven invalid as a fidelity oracle: `JSON.parse` alters `12345678901234567890123` and `0.1000000000000000055511151231257827`, **and** maps the latter equal to `0.1`, destroying the evidence of its own corruption. A guard asserts no equality assertion on a stored value in this change's suite goes through a parsed JS value. | [unit][CI] | gap-boundary / 3.3c |
| B5 | The rewritten register row strikes the old mechanism (`EXCLUDE USING gist`; "trigger remains sole writer of the boundary columns"), names the new one, **re-derives** both status labels to *structural*, **removes** the `T5(2)-refinement` (b)-hypothesis, and carries the replacement voiding precondition. | [doc][manual] | GAP / 0.2 |
| B6 | The record states in writing that the Lean layer is unchanged by this migration and that this is evidence of disconnection, not of safety; no acceptance criterion in this file is satisfied by Lean CI. | [doc][manual] | "…(Law T5)" scenario 2 / 0.2, 4.1 |
| B7 | `Formal/STORAGE_ALGEBRA.md:209-231` and the `:332-333` status rows contain no surviving sentence claiming `EXCLUDE USING gist` or trigger-sole-writer discipline. | [doc] | GAP, "…(Law T5)" / 4.1 |

## WellFormed and append-only

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| C1 | A version that is not exactly `prev + 1` (skip or duplicate) is rejected **by the database**, and the rejection is attributable to the version assertion — not to the primary key, which would not catch a forward skip. | [unit][prop] | WF, T1 / 1.2 |
| C1a | Interleaved keys (A v1, B v1, A v2, B v2) are all accepted, because the assertions are per-`(ns, scope, key)`; a key's v2 inserted before its v1 is rejected. Both are realistic importer paths, so both are exercised. | [unit] | WF / 1.2 |
| C1b | **Zero-row self-audit (`design.md` §10.5).** The version assertion is evaluated *before* the clock assertion, and the ordering dependency is recorded: the clock assertion passes vacuously when its predecessor row is absent, so it is sound only because the version assertion has already rejected chain gaps. Splitting or reordering them fails this row. | [unit][doc] | WF / 1.2 |
| C1c | The open-time schema probe asserts an expected **count** of schema objects; a query completing without error but matching zero rows is treated as absence, never confirmation. | [unit] | APP / 1.2 |
| C1d | The write statement carries exactly one filtering predicate, so `changes() = 0` is unambiguously the CAS guard; a zero-row write is reported as failure, never success. | [unit][doc] | CAS / 2.1 |
| C2 | A `written_at` less than or equal to the previous version's is rejected by the database and surfaces to the caller as `ClockRegressionError`. | [unit] | WF / 1.2, 2.7 |
| C3 | With `PRAGMA ignore_check_constraints=on` set, a violating insert is **still** rejected — the assertion is a trigger, not a `CHECK`. | [unit] | WF / 1.2 |
| C4 | `UPDATE` and `DELETE` against the event log are both rejected by trigger assertions, with tags distinguishable from the version and clock assertions. | [unit][prop] | APP / 1.2, 3.3 |
| C5 | The adapter refuses to open a database whose `WellFormed`/append-only assertions are absent. | [unit] | APP / 1.2 |
| C6 | Two versions of one key cannot share an instant: rejected by the strict-increase assertion **and**, independently, by the unique index on `(ns, scope, key, written_at)`. Both are exercised. | [unit] | T4 / 1.1, 1.2 |

## The clock policy

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| D1 | The shipped `written_at` expression matches the branch recorded in P0, verifiable by reading the record and the SQL side by side. | [manual][doc] | CLK / 2.3 |
| D2 | IF the logical clock shipped, the bounded-drift check shipped in the same commit, a test drives drift past the threshold and asserts the typed error fires, and `CLOCK_REGRESSION` retains a second live cause. | [unit][doc] | CLK / 2.3, 4.2 |
| D3 | IF the logical clock did not ship, `docs/ERROR-CATALOG.md:73-89`'s two causes and the `conditional` marking are unchanged (the catalog drift test stays green and no `retryable` marking is weakened). | [unit][doc] | CLK / 2.3, 4.2 |
| D4 | **Negative control (recorded, not run).** The record states the published "99.2% rejected" figure is 99.2% at `synchronous=OFF`, 99.1% at `NORMAL` and **0.0% at `FULL`**, so a design that adopted the logical clock on the strength of the headline would have paid its full cost for a problem that does not exist at the promised durability setting. | [doc][manual] | CLK / 0.1, 1.5 |
| D5 | `writtenAt` is still `Date`: `src/interfaces/temporal-kv.ts`'s `VersionedEntry`/`VersionedEntrySchema` pair and their `AssertExact` guard compile unchanged, and no second timestamp field was added. | [CI][unit] | CLK / 2.3 |
| D6 | A `writtenAt` read back from `put`/`get` and passed into `getAt({kind:"at", at})` addresses the same version (millisecond round-trip is bit-identical). | [prop] | T4 / 2.2, 3.1 |

## The transaction-identity guard

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| E1 | A second `put` to one key in one transaction rejects with `TransactionKeyReuseError` and issues **zero** SQL statements for that call. | [unit] | TXK, "A second write to the same key…" / 2.4 |
| E2 | After catching that error and committing, the first write is present and the version chain is gapless — no recorded version dropped as a side effect of the rejection. | [unit] | "A second write to the same key…" / 2.4 |
| E3 | A guard test asserts no adapter path executes caller-supplied SQL on a transaction's own connection (the named voiding precondition is closed, not assumed). | [unit][CI] | TXK / 2.4 |
| E4 | A second connection opened against the same file while a write transaction is held is refused (`SQLITE_BUSY`); the documentation attributes the guarantee to UmbraDB owning the transaction handle, **not** to any worker-thread topology. | [unit][doc] | TXK / 2.4 |
| E5 | **Negative control.** The SQL-derived transaction-identity substitute is demonstrated defeated by one extra counter-table `INSERT`, which is why the guard is specified as adapter code with a named precondition. | [unit][doc] | TXK / 3.4 |
| E6 | The write-set guard ships **unconditionally** — it is present regardless of P0's branch, so the guarantee is not a function of a pragma. | [manual][unit] | TXK / 2.4 |

## Adapter bans

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| F1 | A guard test fails the build on any `INSERT OR REPLACE` / `REPLACE INTO` targeting the event log. | [unit][CI] | REP / 2.5 |
| F2 | **Negative control.** On a scratch schema, `ON CONFLICT DO UPDATE` fires a `BEFORE UPDATE` trigger and `INSERT OR REPLACE` does **not** — the silent history-row loss is demonstrated, not asserted. | [unit] | REP / 2.5, 3.4 |
| F3 | `RAISE(ROLLBACK)` appears nowhere in the DDL; a test proves a swallowed `ABORT` leaves the store temporally coherent (commit succeeds, rejected write left no row, intervals still non-overlapping and gap-free, version chain gapless). | [unit][CI] | ABT / 1.2 |
| F4 | **Negative control (recorded).** The record states that `RAISE(ROLLBACK)` ends the transaction and drops the connection into autocommit — a subsequent unaware write commits on its own and the caller's `COMMIT` fails with "no transaction is active" — which is why `ABORT` is specified. | [doc] | ABT / 1.5 |
| F5 | A source-level assertion shows `put` issues exactly one write statement; splitting a logical put across two statements is prohibited in the record with its reason. | [unit][doc] | ABT / 2.1, 1.5 |
| F6 | The adapter refuses to open in shared-cache mode or with `PRAGMA read_uncommitted`; the refusal is tested. | [unit] | CFG / 2.6 |
| F7 | Two connections racing a same-key write hold the invariant on disk in all six cells of `journal_mode` ∈ {wal, delete, truncate} × `busy_timeout` ∈ {0, nonzero}. WAL is **not** claimed to be required. | [unit][prop] | CFG / 2.6 |
| F7a | **No document in this change describes the TOCTOU closure as three *independent* guarantees.** It is one mechanism — write-lock exclusivity — observed at three points, and the failure mode is recorded as **void, not weakened**. A reviewer grepping for "independent" against that claim finds the correction, not the claim. | [doc][manual] | CFG / 2.6, `design.md` §3.1 |
| F7b | **Negative control, three arms, on a real filesystem** (`df -T`, not `/tmp`): control refused with `SQLITE_BUSY`; a `-shm` descriptor opened **without** close still refused (isolating the fault to POSIX close semantics); opened **and closed** → competitor commits, first commit reported lost, `integrity_check` `ok`, and none of the three observations fires. Arm 3 must be shown defeating all three at once. | [unit][prop] | CFG / 2.6 |
| F7c | The precondition is a requirement, not an assumption: no in-process code opens a descriptor on the database file or its `-wal`/`-shm` sidecars; `v1.0.0-sqlite-concurrency-lease`'s build-failing guard (its task titled "descriptor-ban source guard") is **cited** as the restoring mechanism, not re-implemented; this change's own source is asserted clean. | [unit][CI][doc] | CFG / 2.6 |
| F7d | **The journal-mode question is closed, not flagged.** The all-modes soundness claim stands unnarrowed; the guard covers the database file and both sidecars unconditionally; the record states the reason is static **expressibility** (`journal_mode` is persistent in the file and runtime-mutable, so a build-time check cannot be mode-conditional), not a safety ranking between modes. | [doc] | CFG / 2.6 |
| F7d1 | The measured asymmetry is captured, not averaged away: a `.db` descriptor open-and-close is harmless under `wal`, voids exclusivity under `delete`/`truncate`, and under `delete` the **holder's own `COMMIT` fails** while `wal` and `truncate` acknowledge both commits and lose one silently. The negative controls distinguish loud from silent failure. | [unit][doc] | CFG / 2.6 |
| F7e | The transaction-identity guard's "forgery from outside is refused" claim **cites change 3's inheritance table** (cited by its section title, "Inheritance table") rather than restating the exclusivity qualifier locally, and is listed there. No document in this change restates the qualifier per-instance. | [doc][manual] | TXK / 2.4, `design.md` §7.2 |

## Performance properties — established, never quoted

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| G1 | The write path's cost is characterised on a real (non-tmpfs) filesystem at the shipped `journal_mode`/`synchronous`, with dataset size relative to page cache recorded; the criterion is **no upward trend** in per-chunk insert time as a key's version count grows by ≥1 order of magnitude — a shape, not a rate. | [manual][doc] | QUA / 1.3 |
| G2 | No research-corpus throughput figure appears in any requirement, task acceptance criterion or contract document as an assertion of fact. Figures may appear only as attributed prior measurements with their conditions. | [manual][doc] | QUA / 1.3, 1.5 |
| G3 | `get()` at ~1M versions of one key uses an index search (`EXPLAIN QUERY PLAN`) and is within the same order of magnitude as at 1k versions/key; if not, the result is recorded and an index is added. | [manual][unit] | EVT / 1.4 |
| G4 | The design record names the naive `EXCLUDE` transliteration as quadratic (with its measured per-chunk growth, labelled a tmpfs measurement and therefore a **floor**) and the `overlap_neighbour` fallback as sound only inductively. | [doc] | QUA / 1.5 |

## Reads and the surviving interface contracts

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| H1 | The `getAt` SQL queries one relation and contains no priority column or source tiebreak. | [unit] | T3 / 2.2 |
| I3a | **Class B invariant I-3.** The `{at}` read re-reads its candidate through the **primary-key** index before returning and asserts both halves of "last event at or before `T`" — bound and successor. Verified at source and by query plan (second seek on the PK auto-index, not the time index). | [unit][CI] | I-3 / 2.2c |
| I3b | **Negative control, both arms.** With the time index damaged and table rows intact: every digest verifies clean; *with* the assertion the read fails loudly; *without* it the same read returns a row violating the query — a wrong answer from Law T3 with no error raised. Only the paired run proves the assertion is what excludes it. | [unit][prop] | I-3 / 2.2c |
| I3c | A too-*early* candidate is caught by the **successor** half specifically, proving both conjuncts are load-bearing and neither is redundant. | [unit] | I-3 / 2.2c |
| I3d | A zero-row primary-key re-read raises rather than falling back to the time index's answer — a re-read matching nothing is evidence of divergence, not agreement. | [unit] | I-3 / 2.2c |
| I3e | The residual is named, not silently left: the mirror hazard (damaged PK index corrupting `getAt({version})`) is out of I-3's scope, covered only by T4's sampled property test and recorded as an open question. | [doc] | I-3 / 4.3 |
| H2 | P3 passes: `getAt({at:T})` equals a from-scratch reference fold of the puts at or before `T`. | [prop] | T3 / 3.1 |
| H3 | `getAt({at:T})` for a `T` before the key's first event returns `null`, not `HistoryUnavailableError` (no retention floor exists). | [unit] | T3 / 2.2 |
| H4 | P4 passes on the **full** entry — value, version and `writtenAt` — not just `.value`. | [prop] | T4 / 3.1 |
| H5 | P1 and P2 pass; `VersionConflictError.actual` is a real version on conflict, `undefined` on never-written, never `0n`; `expectedVersion: 0n` against an existing key rejects with the real current version rather than a silent no-op. | [prop][unit] | T1, CAS / 2.1, 3.1 |
| H6 | `listKeys` yields a key written N times exactly once, with the first key observable before the full scan completes, and adapter resident memory that does not scale with the number of matching keys. | [unit][prop] | listKeys / 2.2b |
| H6a | `EXPLAIN QUERY PLAN` for the shipped `listKeys` query contains no `USE TEMP B-TREE FOR DISTINCT` and no `USE TEMP B-TREE FOR ORDER BY`, and does not reference the validity view; if the planner materialises, the ordered-scan + adjacent-duplicate-skip shape is asserted instead. | [unit][CI] | listKeys / 2.2b |
| H6b | A fixture with a supplementary-plane key and a `U+E000`–`U+FFFF` key is yielded in `BINARY` (code-point) order, **and** a companion assertion demonstrates JavaScript's comparison of those two keys disagrees — so the divergence is shown, not described. The adapter is proven not to compute pagination boundaries in JavaScript. | [unit] | listKeys / 2.2b |
| H6c | An abort mid-iteration rejects with `AbortError` rather than completing via `break`; a post-abort probe shows the statement released, no scan still running, and no read snapshot left open (an abandoned reader blocks WAL checkpointing). | [unit] | listKeys / 2.2b |
| H6d | Streaming is asserted as a **ratio measured in one run** (time-to-first-key ≤ 5% of time-to-drain at ≥100k rows), with a paired negative control showing a materialise-first implementation drives the ratio toward 1 and fails. No absolute latency appears in the assertion, and **no criterion in this file references a batch size** — change 1 filed it as an open decision and ruled the existing in-process figures inadmissible. | [unit][CI] | listKeys / 2.2b |
| H6e | **Liveness.** A consumer that reads a few keys and then stops calling `next()` — no abort, no `break`, no `return()` — does not block writes indefinitely: a write elsewhere in the process succeeds once the idle deadline elapses, with no action by that consumer. | [unit] | listKeys / 2.2b |
| H6f | A deadline-released iteration **rejects** on resumption and does not return `{done: true}`; a negative control shows that a deadline ending the iteration normally silently truncates the key set with no error anywhere. This is the row that prevents a liveness fix from becoming a correctness bug. | [unit] | listKeys / 2.2b |
| H6g | The caller-facing consequence of the collation change is recorded: a resume cursor persisted under the Postgres ordering is not portable across the migration — free pre-tag, a documented-behaviour break after. | [doc] | listKeys / 4.3 |
| H9 | A live `TransactionHandle` is honored: a `put` with the handle is visible to a `get` with the same handle, and is absent to a handle-less `get` after that transaction rolls back. | [unit] | opts.tx / 2.3b |
| H9a | A fabricated or already-settled handle rejects with `TransactionHandleInvalidError` and issues **zero** statements; the Sprint-1 "transaction participation not yet supported" refusal path is deleted. | [unit] | opts.tx / 2.3b |
| H9b | A handle invalidated by change 3's transaction-hold bound rejects on the next `TemporalKV` call rather than executing outside the transaction — an expired hold never converts a transactional write into an autocommitted one. | [unit] | opts.tx / 2.3b |
| H9c | **Negative control.** An adapter that accepts `opts.tx` but resolves against the default connection is shown to let the write survive the caller's rollback with no error — the exact failure "never silently ignored" names. | [unit] | opts.tx / 3.4 |
| H9d | The delta cites change 3 for transaction semantics and defines none of its own: no begin/commit/rollback, isolation, lease or hold-bound behaviour is specified in this change's spec. | [manual][doc] | opts.tx / `design.md` §0.4 |
| H7 | The exclusion-constraint translation path is removed or explicitly marked unreachable with its reason; `ExclusionViolationError` and `EXCLUSION_VIOLATION` remain exported and the catalog drift test stays green. | [unit][CI] | "Postgres errors surface as the shared StorageError hierarchy" / 2.7 |
| H8 | The strict-clock rejection routes to `ClockRegressionError` matched on its own message tag; a different assertion's rejection is proven **not** to route there. | [unit] | "Postgres errors surface…" / 2.7 |

## Conformance, re-executed

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| J1 | P1–P4 are **executed** against SQLite and recorded as a fresh run, not a copied artifact. | [prop][CI] | all / 3.1 |
| J2 | The rewritten P5 is run against a deliberately gapped/overlapping fixture and **fails**, then against the real store and passes; both runs recorded. A P5 that has only ever been green does not satisfy this. | [prop][manual] | GAP / 3.2 |
| J3 | A new append-only conformance property exists (no Postgres counterpart) and passes. | [prop] | APP / 3.3 |
| J4 | Every property whose enforcement mechanism changed — T5(1), T5(2), the same-transaction guard, the `INSERT OR REPLACE` ban — ships a paired negative control. | [prop][manual] | all / 3.4 |
| J5 | `EXPECTED_REQUIRED_COUNT` in `test/integration/check-required-tests.ts` is not edited in the same commit as any manifest id deletion. | [manual][CI] | — / 3.1 |

## Negative / boundary criteria (nothing out-of-scope leaked in)

| # | Criterion | Verify | Source |
|---|---|---|---|
| N1 | No retention or pruning mechanism ships; `HistoryUnavailableError` remains exported and unreachable. | [manual] | proposal non-goals |
| N2 | No driver selection, shim, pragma-bootstrap ordering, worker-thread topology or measurement-gate implementation ships here. | [manual] | proposal non-goals / change 1 |
| N3 | No lease, `busy_timeout` policy, sticky-poison emulation, transaction machinery or contention error mapping ships here. The merged requirement "A caller-supplied transaction handle is honored or rejected, never silently ignored" **is** deltaed here — change 3 structurally cannot reach it — but only to say what `TemporalKV` does with a handle; see H9d. | [manual] | proposal non-goals / change 3, `design.md` §0.4 |
| N4 | No table-name/index/trigger prefixing, `STRICT` declaration, JSON `CHECK`, or `listKeys` prefix-matching mechanism ships here. | [manual] | proposal non-goals / change 4 |
| N5 | No contract-document rewrite, error-catalog edit, backup/restore change, durability probe, checksum scheme or observability surface ships here; catalog consequences are handed over in writing and acknowledged. | [manual][doc] | proposal non-goals / change 5, task 4.2 |
| N6 | **This change** specifies, costs and schedules no chain-archive work and consumes nothing from the archive lineage; the archive is owned by `v1.0.0-sqlite-chain-archive` (change 6). This criterion certifies the boundary of **this change only** — it makes no claim about whether the archive is in the program's scope, which it is. *(Rewritten under gate G-3. The prior wording inherited the retracted program-wide-exclusion premise, so ticking it would have certified a statement the sprint refutes — a gate that certifies a falsehood is worse than no gate.)* | [manual] | proposal non-goals |
| N7 | No Lean file changes, and no claim anywhere that the Lean gate's greenness is evidence the migration is safe. | [manual][CI] | `design.md` §1, §5 |
| N8 | The record names what this change does **not** close: NTP-step monotonicity (never measured), shared-cache mode (asserted-off, not tested), the real per-key put rate during wallet sync (unowned), and the absence of any checksum protecting `kv_event` values. | [doc] | `design.md` §13 / 4.3 |
