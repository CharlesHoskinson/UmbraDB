# Tasks — TemporalKV on SQLite: the event log replaces the interval table

Ordered. Each task states concrete acceptance criteria — what test passes, what command succeeds, or
what artifact exists with what content — per `openspec/config.yaml`'s tasks rule. Task ids are
referenced by `acceptance.md`.

**Two hard sequencing rules govern this list and are not stylistic:**

- **R-A.** Task 0.2 (the refinement register rewrite) blocks task 2.1. The commitments seat's ruling
  R4(iv)(6): *"Written after, it documents what was built. Written before, it constrains it."*
- **R-B.** Task 0.1 (the clock-policy gate report) blocks tasks 2.3 and 5.x. Nothing that depends on
  the `written_at` expression may be built before the gate reports R.

---

## Phase 0 — Preconditions (block the rest of the change)

### 0.0 Round-2 audit gates owned by this change — closed at authoring time

Recorded here rather than only in the adjudication, per its §3.5 ruling: **the obligation lands in
the owner's own `tasks.md` at discovery time, and the owner makes its own edits.** That rule is the
structural fix for how invariant I-4 was lost, so honouring it in form as well as substance matters.

| Gate | Obligation on this change | State |
|---|---|---|
| **G-1** | `proposal.md`'s archive non-goal asserted a program-wide exclusion of the archive — the sprint's strongest-worded instance of the retracted premise, flagged by three seats independently. Rewritten to R-1's wording: **owned by change 6, not by this change**. The supporting inference from the artifact's wiring state is deleted rather than softened, because that inference *was* the premise. | **Done** — closes on the coordinator's widened G-2 grep. |
| **G-2 (assist)** | Not my gate, but my directory must not pollute its transcript. Swept for the widened phrase list including the inference forms; one genuine non-archive instance found and reworded — the retention non-goal had justified itself by inferring from an artifact's apparent disuse, the same reasoning form. It now stands on two cited repository facts instead. | **Done** — this directory contributes zero hits, correction or otherwise. |
| **G-3** | Acceptance criterion **N6** asserted a statement the sprint refutes. Rewritten to a true, self-limiting statement scoped to this change's boundary, with an explicit disclaimer that it makes no program-scope claim. | **Done.** |
| **G-16** | Cross-change citations converted to title anchors; the two-scheme convention (titles across changes, `file:line` into the frozen product repo) stated in `design.md` §0 preamble with its rationale. | **Done.** |

**Standing rule adopted from §3.5, binding on this change for the rest of the sprint:** if this
change discovers false or stale text in a sibling, the finding is filed against **that sibling's
`tasks.md`** at discovery time. Recording it only in this change's design notes — or deferring it to
a later grep by a non-owner — is not an acceptable disposition, because it converts a known defect
into a hoped-for detection.

### 0.1 Consume the clock-policy measurement from `v1.0.0-sqlite-engine-core`'s gate

Record R — the rejection rate of the strict-increase assertion over ≥5,000 back-to-back
unconditional same-key puts, each its own autocommitting transaction, no throttle — measured on a
**real (non-tmpfs) filesystem** at the `journal_mode`/`synchronous` values change 1 selects as
shipped defaults, with dataset size relative to page cache recorded. Apply the decision rule in
`specs/temporal-kv/spec.md` ("the write-timestamp clock policy is decided by the engine-core
measurement gate") and write down which branch was taken.

**Acceptance:** a checked-in record naming the filesystem (`df -T` output on the database path), the
two pragma values, N, R, the dataset size, and the branch taken (no logical clock / logical clock +
drift bound / durability-default change). Reviewers can verify the branch follows from R mechanically.
**If R is not recorded, tasks 2.3 and 5.1–5.3 are blocked and must not be started.**

### 0.2 Rewrite the refinement register row for T5 **before** any implementation

Rewrite the T5 rows of the register at `openspec/changes/v1.1.0-formal-completion/design.md`,
section "Refinement register & three statuses", and
of `Formal/STORAGE_ALGEBRA.md`'s status table at `:332-333`: old mechanism struck, new mechanism
named, status label **re-derived** (T5(1) `MECHANISM SPECIFIED` → structural; T5(2) `CALLER-ENFORCED`
→ structural), the `T5(2)-refinement` (b)-hypothesis **removed** rather than softened, and the
voiding precondition replaced (a second writer process / a network filesystem / a `-shm` without
working shared memory / shared-cache with `read_uncommitted`, replacing "a transaction pooler").

**Acceptance:** `git log` shows the register commit strictly precedes the first `src/` commit of this
change. The rewritten rows contain no carried-over status label — a reviewer diffing old against new
sees every label re-derived. Also record, in the same commit, the sentence that the Lean layer is
unchanged by this migration and that this is evidence of disconnection, not of safety.

### 0.3 Rule on the two un-deltaed merged requirements (`design.md` §0.3)

Get a decision on how *"Migrations are idempotent and ordered"* and *"Schema isolation is the
default, not opt-in"* — both Postgres-worded, both in this capability's merged spec, both owned by
`v1.0.0-sqlite-schema-parity` — will be re-pointed.

**Acceptance:** a written ruling recorded in this change's directory naming which change carries
those two deltas. If the ruling is "change 4 adds a `specs/temporal-kv/` delta directory", that
change's validation must show a `temporal-kv` delta before this change is archived.

---

## Phase 1 — Schema and enforcement

### 1.1 Author the `kv_event` DDL, the unique time index, and the `kv_validity` view

Per `design.md` §2. Written unprefixed and without `STRICT`; `v1.0.0-sqlite-schema-parity` supplies
prefixing (identifiers are global per database file — index and trigger names too) and `STRICT`.

**Acceptance:** a migration that creates the table, the unique index on `(ns, scope, key,
written_at)` and the view applies cleanly to a fresh database; `EXPLAIN QUERY PLAN` for the
`getAt({at})` read reports a covering-index search on the time index, not a scan. A test asserts the
schema contains **no** `valid_to`, no stored range column, and no interval-boundary column of any
name.

### 1.2 Author the `WellFormed` and append-only trigger assertions

`kv_event_bi` (version = prev+1; `written_at` strictly increasing), `kv_event_bu` and `kv_event_bd`
(append-only). Each raises with `ABORT` and a distinct message tag.

**Acceptance:** unit tests show each of the four rejections fires with its own distinguishable tag; a
test with `PRAGMA ignore_check_constraints=on` set shows a violating insert is **still** rejected; a
test shows `RAISE(ROLLBACK)` appears nowhere in the DDL. An open-time schema probe fails to open a
database whose assertions have been dropped.

### 1.3 Establish the write path's cost *shape* on a real filesystem

Not a rate. Measure per-chunk insert time as one key's version count grows by at least an order of
magnitude, on a non-tmpfs filesystem, at the shipped `journal_mode`/`synchronous`, with dataset size
relative to page cache recorded.

**Acceptance:** a recorded run showing no upward trend in per-chunk time, with the four measurement
conditions stated alongside. **The published research figures (467,732 rows/s; 1.69× overhead) are
tmpfs measurements and must not be cited as the result** — the run's own numbers are the record.

### 1.4 Benchmark `get()` on a key with ~1M versions

L1's open question 3: it believed `ORDER BY version DESC LIMIT 1` is a covering-index seek and did
not confirm it. This is the one read the two-table→one-table fold could plausibly regress.

**Acceptance:** `EXPLAIN QUERY PLAN` shows an index search (not a scan), and measured `get()` latency
at ~1M versions/key is within the same order of magnitude as at 1k versions/key, on a real
filesystem. If it is not, the result is recorded and a covering index is added before phase 2 closes.

### 1.5 Record the prohibited alternatives in the design record

The naive `EXCLUDE` transliteration (quadratic — per-10k-chunk time 2,653 → 8,425 → 16,988 → 23,929
ms, 1,441× slowdown, 708 rows/s **and still degrading at 50k versions**; a tmpfs measurement and
therefore a *floor*), and the `overlap_neighbour` fallback's inductive-soundness caveat.

**Acceptance:** the design record names both, with the reason each is rejected/qualified, so a future
reader cannot re-propose either without first contradicting a written finding.

---

## Phase 2 — Adapter

### 2.1 Implement `SqliteTemporalKV.put` as one statement

The single `INSERT … SELECT … WHERE` of `design.md` §2.1, with the CAS guard as a predicate on that
statement and `changes() = 0` triggering the follow-up read that fills
`VersionConflictError.actual`. **Blocked by 0.2 (rule R-A).**

**Acceptance:** P2's existing conflict-vs-absence assertions pass unchanged (`actual` is a real
version on conflict, `undefined` on never-written, never `0n`); a test proves `expectedVersion: 0n`
against an existing key rejects with the real current version rather than silently no-op'ing; a
source-level assertion shows `put` issues exactly one write statement.

### 2.2 Implement `get` and `getAt` against the event log

`getAt({at})` becomes "last event at or before T"; the `UNION ALL … ORDER BY priority LIMIT 1`
tiebreak is deleted.

**Acceptance:** P3 and P4 pass; a test asserts the `getAt` SQL contains no priority column and queries
one relation.

### 2.2b Implement `listKeys` against the event log (`design.md` §10.3)

The one read whose contract does not simply survive, split out of 2.2 because it has five separable
obligations and a narrowed guarantee. Consume change 4's prefix predicate and change 1's
incremental-read transport.

**Acceptance — six checks:**
1. A key written N times is yielded exactly once, and dedup is constant-memory: drive a large match
   set and assert the adapter's resident memory does not scale with the number of matching keys.
2. `EXPLAIN QUERY PLAN` for the shipped query contains no `USE TEMP B-TREE FOR DISTINCT` and no
   `USE TEMP B-TREE FOR ORDER BY`, and does not reference the validity view. If the planner insists on
   materialising, the adapter falls back to an ordered scan with adjacent-duplicate skipping and the
   test asserts *that* shape instead.
3. Streaming is asserted as a **ratio measured in one run** — time-to-first-key ≤ 5% of
   time-to-drain at ≥100k matching rows — with a paired negative control showing a materialise-first
   implementation drives that ratio toward 1 and fails. Hardware-independent by construction, and no
   absolute latency appears in the assertion.
4. A fixture containing a supplementary-plane key and a `U+E000`–`U+FFFF` key is yielded in `BINARY`
   (code-point) order, **and** a companion assertion shows JavaScript's own comparison of those two
   keys disagrees — the divergence is demonstrated, not merely described.
5. Abort mid-iteration rejects with `AbortError` (not a silent `break`), and a post-abort probe shows
   no scan still running and no read snapshot left open.
6. **Liveness:** a consumer that reads a few keys and then stops calling `next()` — no abort, no
   `break`, no `return()` — does not block writes indefinitely; a write elsewhere in the process
   succeeds once the idle deadline elapses. And the released iteration, when resumed, **rejects**
   rather than returning `{done: true}`, with a negative control showing that a deadline which ends
   the iteration normally silently truncates the key set.

**Blocked on** change 1 shipping the idle deadline: checks 5 and 6 exercise it. Check 3 and check 6's
negative control are writable now. **No check references a batch size** — change 1 filed it as an
open decision and ruled the existing in-process figures inadmissible, so nothing here turns on it.

### 2.2c Implement Class B invariant I-3: cross-path assertion on the `{at}` read (`design.md` §10.4)

After the time-index seek, re-read the candidate **by primary key** and assert both halves of "last
event at or before `T`": `written_at(candidate) <= T`, and successor absent or `written_at > T`.
Raise a typed error on failure and return no row.

**Acceptance — four checks.**
1. The positive path re-reads by primary key before returning, verified at source **and** by query
   plan: two index seeks, the second on the PK auto-index rather than the time index.
2. **Negative control.** With the time index's copy damaged and the table rows left intact: every
   digest verifies clean, and *with* the assertion the read fails loudly, *without* it the same read
   returns a row that violates the query. Both arms must be shown — a wrong answer from Law T3 with
   no error anywhere is the failure being excluded, and only the paired run proves the assertion is
   what excludes it.
3. A candidate that is too *early* is caught by the **successor** half specifically, proving both
   conjuncts are load-bearing and neither is redundant.
4. A zero-row PK re-read raises rather than falling back to the time index's answer.

### 2.3 Implement the `written_at` expression per the branch recorded in 0.1

**Blocked by 0.1 (rule R-B).** If the branch is the logical clock, the bounded-drift check ships in
the same commit — it is what preserves `CLOCK_REGRESSION`'s `conditional` marking, and shipping the
clock without it is a forbidden weakening under `docs/ERROR-CATALOG.md:13`.

**Acceptance:** the shipped expression matches the recorded branch, verifiable by reading the record
and the SQL side by side. If the logical clock shipped: a test drives drift past the configured
threshold and asserts the typed error fires, and change 5's catalog rationale is updated in the same
PR.

### 2.3b Honor `opts.tx` on all four methods (`design.md` §0.4)

Resolve a live `TransactionHandle` to change 3's transaction and execute there; reject a
non-live handle with `TransactionHandleInvalidError` before issuing any statement. Delete the Sprint-1
"transaction participation not yet supported" refusal path.

**Acceptance:** a `put` with a live handle followed by a `get` with the same handle returns the
written value, and after that transaction rolls back a handle-less `get` does not; a fabricated or
already-settled handle rejects with `TransactionHandleInvalidError` with **zero** statements issued;
a handle invalidated by change 3's transaction-hold bound rejects rather than silently executing
outside the transaction; and a negative-control test demonstrates that an adapter resolving `opts.tx`
against the default connection would let the write survive the caller's rollback with no error —
the failure mode the requirement's header names. **Blocked on** change 3's transaction wiring.

### 2.4 Implement the adapter-side same-transaction write-set guard

Unconditional — not contingent on 0.1's branch (`design.md` §7.3).

**Acceptance:** a test issues two `put`s to one key in one transaction and asserts
`TransactionKeyReuseError` with **zero** SQL statements issued for the second; a test catches that
error, commits, and asserts the first write is present and the version chain gapless; a guard test in
the style of `no-sdk-import-guard.test.ts` asserts no adapter path executes caller-supplied SQL on a
transaction's connection.

### 2.5 Ban `INSERT OR REPLACE` mechanically

**Acceptance:** a guard test fails the build on any `INSERT OR REPLACE` / `REPLACE INTO` targeting the
event log; a companion test demonstrates the failure mode on a scratch schema (a `BEFORE UPDATE`
trigger that fires under `ON CONFLICT DO UPDATE` and does **not** fire under `INSERT OR REPLACE`), so
the ban has a live justification rather than a comment.

### 2.6 Assert the engine configuration the enforcement is sound under

**Acceptance:** the adapter refuses to open a database in shared-cache mode or with
`PRAGMA read_uncommitted` enabled, with a test proving the refusal; a concurrency test exercises two
connections racing a same-key write across `journal_mode` ∈ {`wal`, `delete`, `truncate`} × 
`busy_timeout` ∈ {0, nonzero} and asserts the invariant holds on disk in all six cells.

**Plus the precondition, which was previously assumed rather than asserted.** A three-arm test on a
real (non-tmpfs) filesystem — verified with `df -T`, not `/tmp` — demonstrates that the six-cell
result rests on write-lock exclusivity and not on three independent barriers: (i) control →
competitor refused with `SQLITE_BUSY`; (ii) a descriptor opened on `-shm` **without** closing → still
refused, isolating the fault to POSIX close semantics rather than to opening; (iii) opened **and
closed** → competitor commits, the first writer's commit reported lost, `integrity_check` still
`ok`, and **none** of `SQLITE_BUSY` / `SQLITE_BUSY_SNAPSHOT` / fresh-snapshot visibility fires. Arm
(iii) is the negative control and must be *shown* defeating all three observations at once, since
that is the finding. Cite `v1.0.0-sqlite-concurrency-lease` for the reproduction and for the
build-failing descriptor guard (its task titled "descriptor-ban source guard"); re-implement neither.

**Plus the journal-mode dimension, now ruled** (change 3; former open question 4b). The guard covers
the database file **and both sidecars unconditionally**, because a static check cannot be
journal-mode-conditional — `journal_mode` is persistent in the file and mutable at runtime. The
all-modes soundness claim therefore stands unnarrowed. A directed test confirms the measured
asymmetry: a `.db` descriptor open-and-close is harmless under `wal` (locks live on `-shm`) and voids
exclusivity under `delete`/`truncate`; under `delete` the **holder's own `COMMIT` fails**, while
under `wal` and `truncate` both commits are acknowledged and the loss is silent. Assert that this
change's own source opens no descriptor on any of the three paths, and cite change 3's inheritance
table (cited by its section title, "Inheritance table") rather than restating the exclusivity
qualifier locally.

### 2.7 Retire the dead error-translation paths without removing frozen codes

**Acceptance:** the exclusion-constraint translation path is removed or explicitly marked unreachable
with its reason; `ExclusionViolationError` and the `EXCLUSION_VIOLATION` code remain exported (the
existing catalog drift test stays green); the strict-clock assertion routes to `ClockRegressionError`
matched on its own message tag, proven by a test that a *different* assertion's rejection does **not**
route there.

---

## Phase 3 — Conformance, re-executed

### 3.1 Re-execute P1–P4 against SQLite

Executed, not ported-and-assumed.

**Acceptance:** P1–P4 run green against the SQLite adapter, and the run is recorded as a fresh
execution (not a copied artifact). Per the commitments seat, the pinned
`EXPECTED_REQUIRED_COUNT` in `test/integration/check-required-tests.ts` is **not** edited in the same
commit as any manifest id deletion.

### 3.2 Rewrite P5 against `kv_validity`, and prove the diagnostic detects failure first

P5's current body reads `kv_history` directly
(`test/postgres/temporal-kv.property.test.ts:143-147`) — a table that will not exist.

**Acceptance:** the rewritten P5 is first run against a deliberately gapped/overlapping fixture and
**fails**, then against the real store and passes. Both runs are recorded. A P5 that has only ever
been green does not satisfy this task.

### 3.3 Add the append-only conformance property

New — it has no Postgres counterpart, because the Postgres schema had no append-only table.

**Acceptance:** a property test attempts `UPDATE` and `DELETE` against the event log from a direct
SQL path and asserts both are rejected; and asserts that a `DELETE` performed with the trigger
dropped surfaces as a Law T1 version-chain gap (`getAt({version})` → `null` for a version that
existed), not as a T5 violation.

### 3.3b Prove the conversion boundary is observable, not merely documented

`design.md` §4.4. The hazard is that a gap-bearing source converts into a perfectly coherent target,
so nothing this change already asserts can detect it.

**Acceptance:** build the worked fixture — a source key with `[1000, 2000)` and a live row at `3000`
— and demonstrate three things in one run. (i) The source's `getAt({at: 2500})` is `null` and the
converted store's is version 1. (ii) Row count, per-row value digests, and **every** assertion this
change specifies — version chain, strict clock, unique time index, append-only, and the `kv_validity`
P5 diagnostic — all pass against that converted store. This is the negative control and it must be
*shown passing*: its passing is the finding. (iii) A per-key S3 check flags that key as
unconvertible. Cite `v1.0.0-sqlite-data-migration` for the S3 verification and the transport; do not
re-implement either.

### 3.3c Ban the JavaScript round trip as a fidelity oracle

**Acceptance:** a test asserts that `JSON.parse` alters `12345678901234567890123` and
`0.1000000000000000055511151231257827`, **and** that it maps `0.1000000000000000055511151231257827`
and `0.1` to the same value — so an oracle built on parsing destroys the evidence of its own
corruption; plus a guard over this change's test suite asserting that no equality assertion on a
stored value is made through a parsed JS value rather than the stored text. The frozen public
`JsonValue` boundary (`src/interfaces/temporal-kv.ts:97-107`) is untouched and out of scope.

### 3.4 Ship the negative controls for every property whose mechanism changed

**Acceptance:** each of T5(1) non-overlap, T5(2) gap-freedom, the same-transaction guard, and the
`INSERT OR REPLACE` ban has a paired negative control demonstrating the failure the positive test
claims to exclude. A green positive test with no negative control does not close this task — a
re-executed suite after a migration is exactly where a test goes green for the wrong reason.

---

## Phase 4 — Record

### 4.1 Rewrite `Formal/STORAGE_ALGEBRA.md` §1's T5 prose and status table

**Acceptance:** `:209-231` and the `:332-333` rows are rewritten; no sentence claiming
`EXCLUDE USING gist` or "trigger remains sole writer of the boundary columns" survives; T5(1) and
T5(2) both read *structural*; the T4 caveat text names the clock-policy branch actually shipped.

### 4.2 Hand the catalog consequences to `v1.0.0-sqlite-durability-contract`

**Acceptance:** a written handoff naming exactly three items — `EXCLUSION_VIOLATION` becomes
unreachable from this module; `TRANSACTION_KEY_REUSE`'s enforcement moves from database to adapter
with no text change to the catalog row (so the row's silence is now misleading and needs one
sentence); `CLOCK_REGRESSION`'s cause set and `conditional` marking depend on 0.1's branch. Change 5
acknowledges receipt.

### 4.3 Record what this change does **not** close

**Acceptance:** the design record's open-questions list is current, naming at minimum: clock
monotonicity across an NTP step (never measured by anyone), shared-cache mode (asserted-off rather
than tested), the real per-key put rate during wallet sync (nobody owned it), and that no
application-level checksum protects `kv_event` values — SQLite has no main-database page checksums,
and that gap belongs to `v1.0.0-sqlite-durability-contract`.
