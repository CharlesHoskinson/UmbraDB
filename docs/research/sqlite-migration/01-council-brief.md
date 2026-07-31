# UmbraDB → SQLite: council brief

You are one member of a four-seat council convened to adjudicate a completed seven-lane research
sprint. The research is done. Your job is not to gather more evidence about SQLite — it is to
**judge the evidence that exists**, resolve where lanes contradict each other, and produce the
part of the decision your seat owns.

## The corpus

Seven lane reports, all in `\\wsl.localhost\Ubuntu-26.04\root\umbradb-sqlite-research\reports\`:

| Lane | File | Owns |
|---|---|---|
| L1 | `l1-temporal.md` | TemporalKV, T3/T5 temporal coherence, the exclusion constraint, the history trigger |
| L2 | `l2-concurrency.md` | Transactions, the lease (L1 property), cancellation, isolation |
| L3 | `l3-driver.md` | Driver choice, sync/async, the postgres.js shim, type marshalling |
| L4 | `l4-typesystem.md` | Types, constraints, indexes, jsonb, arrays/GIN, schema emulation |
| L5 | `l5-archive.md` | Chain archive, partitioning, blobs, ingest throughput, GC, backup mechanism |
| L6 | `l6-contracts.md` | The eight written contracts, durability, error catalog, migrations, verification, formal refinement |
| L7 | `l7-precedent.md` | External prior art — what other cryptocurrency clients did and learned |

The shared brief the lanes worked from is `00-BRIEF.md` in
`\\wsl.localhost\Ubuntu-26.04\root\umbradb-sqlite-research\corpus\`. Read it — it states the scope
decisions, the frozen 1.0.0 commitments, and the trap list, and you are bound by the same scope.

**Read every report.** Your seat has a lens, not a subset. A judgment formed from four of seven
reports is the failure mode this council exists to prevent.

## The subject and the scope decisions

UmbraDB is a local, single-writer, persistent datastore for Midnight blockchain clients —
TypeScript, ESM-only, Node ≥ 24, a library over PostgreSQL via `postgres.js` with no ORM. Five
primitives (TemporalKV, CheckpointStore, Watermarks, Transaction/Lease, TransactionHistory), two
capabilities built on them (WalletStateEnvelope, `saveAndAdvance`), plus a chain archive.

The repo owner already decided, and you may not re-litigate: **full replacement of PostgreSQL**
(not a second backend), and **everything in scope including the chain archive**.

Source of truth for the code is `origin/main` (`3c0c68b`). Note the working checkout in
`/root/UmbraDB` sits on a stale branch — do not read the code from there without checking.

## What the lanes concluded (compressed — verify against the reports, do not trust this table)

- **L1** — T5 moves to a *stronger* place, but by schema redesign rather than transliteration.
  A trigger-based overlap check is measured **safe under concurrent writers** on SQLite (three
  independent mechanisms close the check-then-insert TOCTOU: `SQLITE_BUSY`, `SQLITE_BUSY_SNAPSHOT`
  517, and fresh-snapshot visibility) — so the single-writer assumption is not load-bearing here,
  whereas the same trigger in Postgres at READ COMMITTED would be genuinely unsound, which is *why*
  `EXCLUDE` exists. The recommended design stores the event log and derives `[valid_from,valid_to)`
  with `LEAD()`, making **gap-freedom — today's caller-enforced half of T5 — structural for the
  first time** (1.69× the unconstrained floor, flat to 1M rows), while the honest transliteration
  of the `EXCLUDE` constraint is **quadratic: 1,441× slower, 708 rows/s and falling at 50k
  versions**. The real blocker in the lane is the **clock**, not T5.
- **L2** — the lease moves and *improves*: a per-key sidecar lock file under `BEGIN IMMEDIATE`
  gives crash-release with no heartbeat (measured 0 ms successor acquisition after SIGKILL).
  Cancellation of long reads is dead. The naive `busy_timeout` port fails P10 (1/7 acquired);
  a JS poll loop fixes it (8/8). SQLite does not poison a transaction after a failed statement.
- **L3** — recommends `node:sqlite` behind a ~250-line postgres.js-shaped tagged-template shim,
  with the DB on a worker thread. `columns()` returns declared type names verbatim, which
  reproduces postgres.js type-driven decoding with no call-site changes. Worker + SharedArrayBuffer
  + a scalar UDF restores cancellation at 1 ms latency but costs 32× per-op latency.
- **L4** — the whole surface moves; `DEFAULT_SCHEMA` **survives** via table-name prefixing. jsonb is
  a near non-issue (TEXT round-trips at higher fidelity than PG jsonb). The `text[]`/GIN `<@`
  problem resolves to a junction table, 4,600× faster than alternatives. `WITHOUT ROWID` is
  *wrong* for the content-addressed tables. Pushes back on "this must be a 2.0.0."
- **L5** — the archive fits; throughput has 660–730× headroom. Bulk pruning needs table-per-range
  (`DROP TABLE` 35 ms vs `DELETE` 1,296 ms with no space returned). ATTACH-per-range is dead three
  ways. `backup()` ignores its `AbortSignal`. `auto_vacuum` cannot be retrofitted.
- **L6** — seven of eight written contracts survive; cancellation does not; durability *improves*
  (WAL frame checksums make the torn-page hazard structurally absent). `synchronous=FULL` costs
  27× (523 vs 14,229 commits/s) and `NORMAL` is argued already contract-legal. Migration 006's
  `ADD COLUMN ... GENERATED ... STORED` is rejected on any non-empty table.
- **L7** — external precedent. Read it; it is the only lane with evidence from outside this repo.

## The adjudications this council owes

These are live disagreements or unresolved calls in the evidence. Every seat should have a view on
the ones its lens touches; say so explicitly when you defer to another seat.

1. **Is this a 2.0.0, or is it free?** L2 and L3 independently concluded the API breakage forces a
   major version. L4 pushed back: nothing in its lane is a *permanent* break. L6 then found the
   decisive fact — **`docs/STABILITY.md:46` states the SemVer commitments are not yet in force at
   0.9.5**; they bind at the 1.0.0 tag, which has not been cut. If true, the entire G1/G2/G3
   breakage bill collapses to a CHANGELOG entry *provided the work lands before the tag*. Verify
   the claim at the cited line. Then answer: does that change the recommendation, and what is the
   cost of the sequencing constraint it implies?
2. **A scale claim that does not hold as stated.** L5 reported that the archive workload is
   "already running on SQLite in production at the exact shape and exact scale (88 GB, 1 GB/h)",
   citing `/root/midnight-testnet/indexer-data/ledger-db.sqlite`. The coordinator verified: the
   table `ledger_db_nodes(key BLOB PRIMARY KEY, object BLOB NOT NULL)` **does** exist and is
   deployed by the Midnight indexer under `sqlx` migrations — so the *shape* is real and it is a
   good find. But that file is **53.5 MB** (13,069 pages × 4,096), not 88 GB; nothing over 1 MB on
   the machine comes close; and it runs `journal_mode=delete`, not WAL. The 88 GB figure in the
   repo's roadmap refers to the *node* store, a different engine. Establish what this artifact does
   and does not prove, and whether L5's throughput conclusions survive without it. Note that L5's
   own ingest measurements are independent of this claim and may stand on their own.
3. **Cancellation.** L2, L3 and L6 all concluded independently that in-process cancellation of a
   long read is impossible under `node:sqlite`. L3 says the worker thread restores it at a 32×
   per-op latency cost. Is the worker thread worth it, or should CONTRACT §3 simply be rewritten to
   promise less? Whichever you argue, name what the caller loses.
4. **Out-of-cache behaviour is unmeasured.** L5 states plainly that it could not measure B-tree
   behaviour beyond the page cache (3–12 GB stores on a 62 GB box) and that WSL2's VHDX makes fsync
   timings untrustworthy (11 µs/commit). Several conclusions rest on cache-resident measurement.
   How much of the verdict is exposed, and what experiment would close it?
5. **What is genuinely not closeable**, as opposed to merely expensive. Produce the honest short
   list. It is currently much shorter than the sprint's volume suggests, which is itself a claim
   worth testing.
6. **The clock, and whether a frozen API forces a logical clock.** L1 measured SQLite's SQL clock
   at a hard **1.000 ms** resolution — identical to UmbraDB's own truncation, so no mismatch. But
   SQLite writes at ~470k rows/s, which turns the "far rarer" same-millisecond collision into
   **99.2% of sequential same-key puts rejected** with `ClockRegressionError`. L1's fix is a
   per-key monotone logical clock (`max(now_ms, prev+1)`): 5,000/5,000 accepted, zero drift at any
   rate ≤ 1 put/ms/key, but **~1.8 s of drift after an unthrottled burst**. Microsecond storage is
   ruled out by the frozen `writtenAt: Date` API, not by SQLite. Rule on this: is a `written_at`
   that can run ahead of wall-clock time by seconds acceptable for a *temporal* store whose whole
   contract is point-in-time reads? What breaks for a caller who compares `writtenAt` against its
   own clock? If it is not acceptable, the alternative is changing a frozen API field — price both.
7. **A frozen commitment that gets *stronger* is still a change.** L1's redesign moves T5(1) from
   database-enforced-by-`EXCLUDE` to enforced by a different mechanism, and promotes T5(2)
   gap-freedom from caller-enforced to structural. Separately, `TRANSACTION_KEY_REUSE` degrades
   from database-enforced to **adapter-enforced** — L1 calls this the one unavoidable strict
   weakening, because `txid_current()` has no unforgeable substitute (no `sqlite3_txn_state`
   binding, and the best SQL-derived counter is defeated by one extra `INSERT`). Rule on what a
   reviewer is owed when a *frozen* property changes enforcement mechanism even in the
   strengthening direction, and whether `docs/recovery/EVIDENCE.md` and the P1–P10 conformance
   suite must be re-executed rather than amended.
8. **Total cost and sequencing.** The lanes estimated separately: L2 ~2.5–3.5 engineer-weeks,
   L3 ~900–1,100 lines new/rewritten plus a ~200-line mechanical diff, L4 ~2.5–4 developer-weeks,
   L5 ~4–6 engineer-weeks, L6 ~48–69 engineer-days. These overlap and were not costed against a
   shared baseline. Do not simply add them.

## Traps — the complete recorded list

Every one of these has cost this project time. Read all of them.

1. **WSL/Windows path trap.** The corpus lives in WSL; your tools run on Windows. A bare `/root/...`
   path given to Read or Write resolves on the **Windows** drive and silently reads or creates a
   phantom file. Address WSL files through `\\wsl.localhost\Ubuntu-26.04\root\...`. Verified working.
2. **WSL inline heredoc trap.** Never build a script or prompt inline via `wsl -e bash -lc "..."`
   with **double** outer quotes — the outer quoting eats backticks and silently deletes content.
   Use single outer quotes.
3. **Use the Bash tool, not PowerShell, for WSL.** PowerShell expands `$(...)` and `$VAR` first.
4. **Never claim "verified" without the command that produced it.** This applies to you as much as
   to the lanes. If you re-check a lane's number, paste what you ran.
5. **Do not modify `src/`, `test/`, or any product code.** Judgment only. Your writes are your report.
6. **Do not run `npm install`.**
7. **Beware the confident negative — and the confident positive.** This project has already had to
   retract a measured "lever spent" conclusion that turned out to be masked by a larger cost
   elsewhere, and adjudication #2 above is a confident positive that did not survive checking.
8. **A green gate certifies depth, never breadth.** `0 sorry` in Lean proves what is stated is
   proved; it cannot detect a missing or too-weak law. The Lean cut-line `{T3,T5,W1,C1}` models an
   *abstract* store and the abstract→Postgres refinement is explicitly a trusted, unmechanized
   bridge. That the Lean layer survives a storage-engine swap untouched is a fact to interrogate,
   not a reassurance to bank.
9. **Lane reports are evidence, not verdicts.** They were written by agents who each saw one
   seventh of the problem and had an incentive to find their lane interesting. Weigh accordingly.

## Deliverable

Write your report to **both**:

- `\\wsl.localhost\Ubuntu-26.04\root\umbradb-sqlite-research\council\<YOUR_SEAT_ID>.md`
- and nowhere else — the coordinator reads that directory.

If the Write tool refuses the path, stage the file in your scratchpad and copy it into place with
`wsl -e bash -lc 'cp <source> /root/umbradb-sqlite-research/council/<YOUR_SEAT_ID>.md'`, then
verify it exists.

Structure:

1. **Verdict** — your seat's answer in 3–6 sentences. Lead with it.
2. **Adjudications** — your ruling on each numbered question above that your lens touches, with
   reasoning. Where you defer to another seat, say which and why.
3. **Evidence** — what you re-checked yourself and what you took on a lane's authority. Be explicit
   about which is which; a council that only re-reads is worth less than one that re-tests the
   load-bearing claims.
4. **What the sprint got wrong or missed** — including anything no lane was assigned.
5. **Your recommendation** — concrete and actionable.

Keep it dense. Disagreeing with another seat is expected and useful; the coordinator consolidates.
