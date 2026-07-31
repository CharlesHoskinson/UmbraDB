# L1 — Temporal integrity: TemporalKV, T3 and T5 on SQLite

Lane `l1-temporal`. Worktree `/root/UDB-sqlite-l1-temporal` @ `3c0c68b` (origin/main).
All experiments run against Node v24.18.0 / `node:sqlite` / SQLite **3.53.1**, scripts in `/tmp/l1/`.

---

## 1. Verdict

**T5 moves to SQLite intact, and the honest surprise is that it moves to a place that is arguably
*stronger* than where it is today — but only if the schema is redesigned, not transliterated.**
SQLite has no exclusion constraints, no range types, no GiST, and **no subqueries in CHECK
constraints at all** (measured, E0), so the declarative half of T5 has no direct equivalent. The
replacement is not "a trigger, which is weaker under concurrency": I measured that SQLite closes
the check-then-insert TOCTOU window three independent ways (single-writer lock, `SQLITE_BUSY_SNAPSHOT`
on snapshot upgrade, and fresh-snapshot visibility — E3), so a trigger-based overlap check on SQLite
**is** safe under genuinely concurrent writers, which the same trigger in Postgres would not be. The
better answer, though, is to stop storing intervals: store the event log and *derive* `[valid_from,
valid_to)` with a `LEAD()` window function. That makes overlap **unrepresentable** rather than
merely rejected, makes gap-freedom — today's CALLER-ENFORCED half of T5 — structural for the first
time, and is a strictly closer refinement of `Formal/Lean/.../TemporalKV/Model.lean`, which already
defines `validityIntervals` as a projection of an event list rather than as stored data.

**The real blocker in this lane is not T5 — it is the clock.** SQLite's SQL-layer clock has a hard
**1.000 ms** resolution (measured, E1), which is exactly the precision UmbraDB already truncates to,
so the resolutions match. But SQLite writes at ~470k rows/s where Postgres writes at network speed,
so the "far rarer" same-millisecond collision that today raises `ClockRegressionError` becomes the
**common case: 99.2% of sequential same-key puts rejected** (measured, E8a). That is a hard failure
of Law T4 in practice, and it is fixed only by replacing the wall clock with a per-key monotone
logical clock (`written_at := max(now_ms, prev+1)`), which I measured to accept 5000/5000 puts with
**zero drift at any rate at or below 1 put/ms/key** (E9b). Cost: `writtenAt` stops being a pure wall
clock during a burst.

Two guarantees genuinely weaken. First, per L2's finding and my own measurement, `RAISE(ABORT)`
does **not** poison the transaction — the caller can swallow the error and commit (E6). It does
reverse the entire statement *including the trigger's own history INSERT*, so the store stays
T5-coherent; what is lost is the caller's atomicity, not the invariant. Second, the
`txid_current()`-backed same-transaction guard has **no unforgeable substitute** in SQLite (E9a): the
best SQL-derived candidate is defeated by one extra INSERT. `TRANSACTION_KEY_REUSE` (a frozen G3
code) degrades from database-enforced to adapter-enforced.

Engineering size for this lane: **3–4 weeks**, most of it re-deriving `getAt` and the retention
floor against the event-log shape and re-proving the Lean bridge, not writing DDL.

---

## 2. Blockers

### B1 — `EXCLUDE USING gist` has no equivalent. T5(1) non-overlap.
**Postgres today:** `migrations/001_temporal_kv.ts:97-99`
`EXCLUDE USING gist (ns WITH =, scope WITH =, key WITH =, validity WITH &&)` over a
`validity tstzrange GENERATED ALWAYS AS (tstzrange(valid_from, valid_to, '[)')) STORED` column
(`:95`), backed by `btree_gist` (`:57`). This is the *only* thing in the project the algebra calls
"genuinely mechanism-backed, not just trigger discipline" (`Formal/STORAGE_ALGEBRA.md:213-217`).

**SQLite offers:** nothing declarative. Measured (E0): `EXCLUDE USING` is a syntax error; **subqueries
are prohibited in CHECK constraints** *and* in generated columns, so no correlated-subquery CHECK is
possible in either direction; `UNIQUE` over a composed generated range column rejects duplicate
ranges but not overlapping ones (E2b). The only cross-row comparison SQLite can perform on write is a
trigger.

**Gap: closeable with a schema redesign (preferred) or in a trigger (acceptable).** See §4.
**Touches:** T5(1), the one law in the frozen cut-line whose status is *stronger* than
CALLER-ENFORCED. If the answer is a trigger, its status changes from "database-enforced invariant" to
"trigger discipline" — a wording change in `Formal/STORAGE_ALGEBRA.md:213-217` and row `T5(1)` of the
table at `:332`. If the answer is the event-log encoding, T5(1) becomes *structural* and needs no
enforcement at all — a strictly better status than today.

### B2 — Gap-freedom has no enforcement today, and SQLite can give it one. T5(2).
**Postgres today:** nothing enforces it. `STORAGE_ALGEBRA.md:218-231` is explicit: the EXCLUDE
constraint "says nothing about gaps"; contiguity holds "by construction of the trigger's write
discipline", status **CALLER-ENFORCED**, and `P5` (`test/postgres/temporal-kv.property.test.ts:134-155`)
is "the only thing that would catch a regression there". I confirmed a trigger-based interval design
inherits exactly this weakness: an overlap trigger accepts a gap `[400,500)` after `[200,300)` without
complaint, and a `DELETE` of a middle row silently opens a gap (E2, E2b).

**SQLite offers:** the event-log encoding removes the failure mode. If only `written_at` is stored and
`valid_to` is `LEAD(written_at)`, contiguity is a theorem of the projection — there is no column that
could hold a discontiguous boundary. Measured: derived intervals from a 3-event log were gap-free and
non-overlapping by construction (E2, Option C).

**Gap: closeable with a schema redesign — and it closes a gap that is currently open in Postgres.**
**Touches:** T5(2). This is the one place in this lane where the migration *improves* a frozen
commitment. It should be named as such, not oversold: it is still not mechanized in Lean against the
concrete store (see B6).

### B3 — Same-millisecond collision rate. Law T4, `CLOCK_REGRESSION`.
**Postgres today:** `updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp())`
(`migrations/001_temporal_kv.ts:79`), deliberately truncated so a JS `Date` round-trip is bit-identical
(`:60-71`). The documented residual: two same-key writes in different transactions inside one
millisecond collide and raise `23514` -> `ClockRegressionError`, described as "far rarer" (`:69-71`,
`docs/ERROR-CATALOG.md:73-88`). The test suite already sleeps 5 ms between same-key writes to dodge it
(`test/postgres/temporal-kv.test.ts:462`, `.property.test.ts:89-92`).

**SQLite offers:** `unixepoch('now','subsec')` is **statement-scoped** (good — like `clock_timestamp()`,
not like `now()`; measured E1.2) but resolution is exactly **1.000 ms** with **no finer option at the
SQL layer** (E1.1: 200 000 reads over 150 ms produced 147 distinct values, smallest nonzero gap
1.000 ms). Since SQLite writes are in-process, sequential same-key puts land in one millisecond
almost always: **4961/5000 rejected, 99.2%** (E8a). Postgres's per-write network round trip is what
was hiding this.

**Gap: closeable in application code, but only by changing what `writtenAt` means.** A per-key monotone
step `written_at := max(now_ms, prev_written_at + 1)` accepted 5000/5000 (E8b). Drift above the wall
clock is exactly "same-key puts issued within one millisecond": **0 ms at 10/100/1000 puts/s, ~1.8 s
after an unthrottled 2000-put burst** (E9b).
**Touches:** Law T4 and the frozen `CLOCK_REGRESSION` code. With the monotone clock,
`ClockRegressionError` becomes unreachable for sequential same-key writes — a live G3 code with no
remaining trigger. G2 forbids removing it, so it stays exported and unreachable, or is re-pointed at
a genuine backward system-clock step detected by the adapter.
**Not closeable by storing microseconds:** `VersionedEntry.writtenAt` is a JS `Date`
(`src/interfaces/temporal-kv.ts`), so sub-millisecond precision is destroyed on the boundary (E9c) and
the `getAt({at: writtenAt})` round trip that `:60-71` exists to protect would break. Millisecond
granularity is **forced by the G1 frozen API**, not by SQLite.

### B4 — No transaction identity. `TRANSACTION_KEY_REUSE` / UB001.
**Postgres today:** `updated_xact bigint NOT NULL DEFAULT txid_current()` (`:80`) and
`IF OLD.updated_xact = txid_current() THEN RAISE ... ERRCODE 'UB001'` (`:120-124`). The algebra calls
this "the correct, mechanical detector" and stresses it must not be built on a timestamp
(`STORAGE_ALGEBRA.md:78-95`). Routed at `src/postgres/errors.ts:273-277`.

**SQLite offers:** measured (E0) — no `sqlite3_txn_state` binding in `node:sqlite`, no `pragma txn_state`,
no SQL-visible transaction id. `db.isTransaction` exists but is a boolean, not an identity. Three
substitutes tested:
- *Adapter-supplied token column* — works, but **trivially forged**: the caller passes a different
  value and the guard is defeated (E8c(i)).
- *SQL-derived identity* (an `autoincrement` `txn` table the adapter appends to once per `BEGIN`; the
  trigger reads `max(id)`, the write never names it) — works, correctly rejects the same-tx second
  write and accepts a new-transaction write, but is **defeated by one extra `INSERT INTO txn`**
  (E9a). Strictly stronger than the token, strictly weaker than `txid_current()`, which no statement
  can move.
- *Move the guard into the adapter* (per-transaction write-set in memory) — the only option that
  reproduces the exact semantics, at the cost of being pure application code.

**Gap: not closeable at the SQL layer; closeable in application code with a named loss.** Yes, moving
it weakens a guarantee that is currently unforgeable at the SQL layer — that is the plain answer to
charter question 3.
**Mitigating finding:** on the event-log schema the guard is *mostly redundant*. Its purpose is to
guarantee distinct `writtenAt` per version (`STORAGE_ALGEBRA.md:70-76`); the strict-clock trigger
`new.written_at > prev.written_at` already rejects a same-transaction second write, because both land
in one millisecond (measured, E8d). But that is enforcement *by accident of clock resolution*: adopt
the B3 monotone clock and the second write is accepted again. So the two fixes are coupled — you
cannot take B3's fix without paying B4's cost.

### B5 — `RAISE(ABORT)` does not poison the transaction. (L2's finding, confirmed and refined.)
**Measured (E6):** with `RAISE(ABORT)` *and* with `RAISE(FAIL)`, after the guard fires
`db.isTransaction === true`, further writes succeed, and `COMMIT` **succeeds**. Unrelated rows written
earlier and later in the transaction were both committed.

**Refinement L2 could not make from outside this lane:** `ABORT` reverses the *entire statement,
including the trigger body's own `INSERT INTO kv_history`*. In E6 the failed second update left no
trace: `kv_current` at v3/`updated_at=300`, history `[100,200),[200,300)`, last history `valid_to`
meeting the live row exactly — **non-overlap, gap-freedom and history-meets-live all still held**. So
the store-level T5 invariant survives a swallowed error. What is lost is *caller atomicity*, not T5.
The T5-breaking version of this hazard exists only if the adapter splits one logical put across two
statements (update `kv_current`, then separately insert into history) — which is precisely why the
history write must stay inside the trigger, in the same statement. That is a design rule for §4, and
it is why I do **not** need L2's sticky-poison emulation for soundness of T5 itself.

**`RAISE(ROLLBACK)` is not the fix.** Measured (E7a): it does end the transaction — and leaves the
connection in **autocommit**. Work done before the failure was rolled back; a subsequent write by an
unaware caller was **accepted and committed on its own**, and the caller's `COMMIT` then failed with
"cannot commit - no transaction is active". That is a worse failure mode than `ABORT`: silent partial
persistence outside any transaction. **Use `ABORT`, and take L2's sticky-poison emulation for caller
atomicity — but note T5's soundness does not depend on it.**

**Gap: closeable in application code (L2's ~20 lines).** Touches G4's durability/cancellation
contracts and `TRANSACTION_KEY_REUSE`'s "the write did not happen" implication. Dependency on **L2**.

### B6 — The trusted abstract-to-concrete bridge. T3, T5, and the "green gate" trap.
**What the Lean actually proves.** `Formal/Lean/UmbraDBFormal/TemporalKV/Model.lean:57-62` defines
`validityIntervals : History -> List (ValidityInterval)` — intervals are a **projection of an event
list**, not stored data. `Laws.lean:333` (`intervals_pairwise_disjoint`) and `:283`
(`adjacent_intervals_gap_free`) / `:358` (`validityIntervals_cover_iff`) prove T5(1) and T5(2) of that
projection, both conditioned on `WellFormed` — strictly increasing timestamps (`Model.lean:64-72`) —
and `Model.attempt` (`:114-125`) already rejects a non-increasing clock with `clockNotIncreasing`.

**Consequence.** The Lean layer survives a SQLite migration **completely untouched**, because it never
modeled PostgreSQL in the first place. **That is not reassuring — it is exactly trap 9.** A green
Lean gate after the migration certifies precisely what it certified before: that *if* the concrete
store is a faithful refinement of an append-only, strictly-time-increasing event list, *then* T3 and
T5 hold. Every bit of the migration risk sits in the refinement obligation, which is unmechanized and
whose only empirical bridge is the P1-P10 conformance suite. Swapping the engine changes 100% of the
untrusted-but-unproven part and 0% of the proven part, while the gate stays green throughout. Anyone
reading "Lean still passes" as evidence the migration is safe has read it backwards.

**The one substantive thing that does change, and it changes for the better.** Today the
Postgres schema stores intervals directly, so the refinement obligation includes "no interval in
`kv_history` is unrelated to any event" — an obligation `EXCLUDE` discharges mechanically but which
has no counterpart in the model. The event-log schema (§4) is *literally* `History Value Time` with
`validityIntervals` compiled to `LEAD()`, so that obligation disappears rather than being discharged:
there is no interval column to corrupt. The refinement narrows to a single property — **`WellFormed`,
i.e. strictly increasing `written_at` per key** — which is one trigger, testable in isolation, and
which the derived-interval design makes the *only* thing that can go wrong. That is a genuinely
smaller trusted surface than today's, and it is the strongest argument in this report for the
redesign over the transliteration.

**Gap: not closeable (the bridge is trusted by design; the AWS TLA+ stance is unchanged).** What is
closeable is its *size*. Touches the frozen cut-line `{T3, T5}` and `.github/workflows/lean.yml`
(unaffected mechanically).

### B7 — `INSERT OR REPLACE` silently skips UPDATE triggers.
**Measured (E10):** `INSERT OR REPLACE` performs DELETE+INSERT and **never fires the `BEFORE UPDATE`
trigger** — a history row would be silently lost. `INSERT ... ON CONFLICT DO UPDATE` **does** fire it
correctly, which matters because `put()` case 1 uses exactly that shape
(`src/postgres/temporal-kv.ts:118-124`). `INSERT OR IGNORE` does **not** swallow a `RAISE(ABORT)`
(good). `PRAGMA ignore_check_constraints=on` disables `CHECK` but **not** triggers — so a trigger is
strictly harder to disable than a `CHECK`, and `CHECK (valid_from < valid_to)`
(`migrations/001_temporal_kv.ts:96`) should become a trigger assertion on SQLite rather than a CHECK.
**Gap: closeable in application code** (ban `OR REPLACE` in the adapter; a guard test like the
existing import guards).

---

## 3. Evidence

All scripts in `/tmp/l1/`. Run as `node /tmp/l1/<file>` under Node v24.18.0.

### E0 — capability probe (`e0_probe.mjs`)
```
sqlite_version: 3.53.1
[OK]   GENERATED ALWAYS AS ... STORED => 5
[OK]   GENERATED ALWAYS AS ... VIRTUAL => 6
[OK]   index on a STORED generated column => 'created'
[FAIL] STORED generated column referencing another table => subqueries prohibited in generated columns
[FAIL] CHECK with a subquery                             => subqueries prohibited in CHECK constraints
[FAIL] CHECK with a self-referencing subquery            => subqueries prohibited in CHECK constraints
[FAIL] EXCLUDE USING gist                                => near "using": syntax error
[OK]   partial UNIQUE index (WHERE ... IS NULL) => 'second open row rejected: UNIQUE constraint failed'
[OK]   BEFORE INSERT trigger with RAISE(ABORT, msg) => { errcode: 1811 /* SQLITE_CONSTRAINT_TRIGGER */,
                                                          msg: 'UB999: nope' }
[OK]   sqlite3_txn_state exposed? => []
[OK]   pragma / function for txn id => [['select sqlite3_txn_state()','ERR no such function'],
                                        ['pragma txn_state', undefined],
                                        ['select txid_current()','ERR no such function']]
[OK]   db.isTransaction => { before: false, during: true, after: false }
```
Answers charter question 5 directly: `GENERATED ALWAYS AS ... STORED` exists and is indexable, but it
cannot see any other row, so nothing analogous to `tstzrange(valid_from, valid_to, '[)')` *as a thing
a constraint can compare across rows* is expressible. Composing the value works
(`printf('%016x%016x', lo, hi)`, E2b) — what is missing is `&&`, a GiST index over it, and any
constraint kind that compares NEW to other rows.

### E1 — the clock (`e1_time.mjs`)
```
E1.1 unixepoch('now','subsec')
  samples: 200000   wallclock span: 0.150 s   distinct values: 147
  samples/distinct: 1360.5
  strictly-DECREASING violations: 0
  smallest nonzero tick gap: 0.001000 s  => effective resolution ~ 1000 us
E1.2 'now' inside one transaction, 30ms apart: 1785519494.185 / 1785519494.215
  => STATEMENT-SCOPED (like pg clock_timestamp())
E1.4 back-to-back reads truncated to integer ms:
  19989/19999 consecutive pairs landed in the SAME millisecond (99.9%)
  JS Date.now(): 19999/19999 same-ms pairs (100.0%)
E1.5 zero-width interval [t,t) rejected by CHECK: CHECK constraint failed: vf < vt | errcode 275
```
So: correct scoping (the `now()` vs `clock_timestamp()` distinction the design cares about is
*automatically* on the right side in SQLite), 1 ms hard resolution, and yes — two writes in one tick
produce `valid_from == valid_to`, which `CHECK (valid_from < valid_to)` rejects, exactly as in
Postgres. **Monotonicity:** not measured — SQLite's `'now'` reads `xCurrentTimeInt64` ->
`CLOCK_REALTIME`, which an NTP step moves backwards. This is a **citation/inference, not a
measurement**; I could not step the system clock in this environment. It is the same hazard class as
`clock_timestamp()`, so it is not a regression.

### E2 / E2b — T5 mechanism comparison (`e2_t5.mjs`, `e2b_fix.mjs`)
```
A. interval table + BEFORE INSERT/UPDATE overlap-EXISTS trigger
  [ACCEPTED] [100,200)                 [ACCEPTED] [200,300) contiguous
  [REJECTED] [150,250) OVERLAP         [REJECTED] [199,201) OVERLAP by 1
  [REJECTED] [100,200) exact duplicate [ACCEPTED] [50,100) touching from below
  [ACCEPTED] [400,500) GAP  <-- trigger has nothing to say
  [REJECTED] widen [200,300)->[150,300) so it overlaps  (UPDATE trigger fires)
  [REJECTED] widen [100,200)->[100,250) so it overlaps
  [ACCEPTED] DELETE the middle row (creates a GAP — no trigger objects)

B. partial UNIQUE index on the open interval
  [REJECTED] second open interval -> UNIQUE constraint failed
  [ACCEPTED] [150,180) a CLOSED interval overlapping closed [100,200) — index says nothing

C. event-log encoding (store valid_from only; derive valid_to)
  [REJECTED] v3 @150 (clock backwards)  -> UB_T4_CLOCK
  [REJECTED] v3 @200 (same tick as v2)  -> UB_T4_CLOCK
  [REJECTED] v5 @300 (version gap)      -> UB_T1_VERSION
  [REJECTED] v2 @250 (duplicate version)-> UB_T1_VERSION
  [REJECTED] UPDATE a history row       -> UB_APPEND_ONLY
  derived validityIntervals: [{v1,[100,200)},{v2,[200,300)},{v3,[300,null)}]
  gap-free by construction (valid_to[i] === valid_from[i+1]): true
  getAt(at=50)->null  (at=100)->v1  (at=150)->v1  (at=250)->v2  (at=300)->v3  (at=999)->v3
```
This is the honest enumeration charter question 1 asks for. **B alone is not an answer** — a partial
unique index pins the live row and says nothing about closed rows. **A works** but leaves gap-freedom
exactly as unenforced as today and lets a `DELETE` open a gap. **C makes both halves structural.**

### E3 — concurrency: does a trigger check survive concurrent writers? (`e3_concurrency.mjs`)
Two real `sqlite3*` handles on one WAL file, `busy_timeout=0`, deterministically interleaved.
```
journal_mode: wal
--- T1: two connections holding a write transaction simultaneously?
  [OK]  A: BEGIN IMMEDIATE
  [ERR] B: BEGIN IMMEDIATE -> (5) database is locked          # SQLITE_BUSY: one writer, period
--- T2: the TOCTOU window. A reads (deferred snapshot), B commits an overlap, A inserts.
  [OK]  A: BEGIN DEFERRED ; A: read -> {"c":0}
  [OK]  B: insert [100,200) and COMMIT
  [ERR] A: insert [150,250) -> (517) database is locked        # SQLITE_BUSY_SNAPSHOT
  rows: [{"vf":100,"vt":200}]
  => TOCTOU CLOSED by SQLite snapshot-upgrade refusal
--- T3: A uses BEGIN IMMEDIATE
  [ERR] B: BEGIN IMMEDIATE + insert -> (5) database is locked
  [OK]  A: insert [150,250) ; A: COMMIT
  [ERR] B: now insert [100,200) -> (1811) UB_T5_OVERLAP        # trigger sees A's committed row
--- T4: deferred, read taken after B commits
  [ERR] A: insert [150,250) -> (1811) UB_T5_OVERLAP
```
**This is the central result of the lane.** In Postgres a `BEFORE INSERT` overlap-EXISTS trigger is
genuinely unsound under concurrency at READ COMMITTED — two concurrent transactions each fail to see
the other's uncommitted row and both commit overlapping intervals; that is *why* `EXCLUDE` constraints
exist (they take predicate-style locks). On SQLite that race has no representation: error **5**
(`SQLITE_BUSY`) forbids two simultaneous writers, and error **517** (`SQLITE_BUSY_SNAPSHOT`) forbids a
stale-snapshot reader from upgrading to a writer. So the answer to charter question 1's sharpest part
is: **a trigger-based overlap check on SQLite preserves T5(1) under arbitrary concurrent writers, not
merely under UmbraDB's single-writer assumption.** The single-writer assumption is not load-bearing
here. (Caveat, not measured: shared-cache mode with `PRAGMA read_uncommitted` would break this; the
adapter must not enable it.)

### E4 — cost of enforcement as history grows (`e4_perf.mjs`, `KEYS=1 TOTAL=50000`)
```
none               50000 rows in    49 ms  (1 020 076 rows/s)
overlap_naive      50000 rows in 70647 ms  (       708 rows/s)
overlap_neighbour  50000 rows in   122 ms  (   410 537 rows/s)
eventlog           50000 rows in    83 ms  (   602 802 rows/s)

per-10k-chunk wall time (ms) as the table grows
rows            none   overlap_naive  overlap_neighbour   eventlog
10000           11.0         2653.4               24.4       17.6
20000            8.3         8425.4               28.7       18.2
30000           12.0        16987.7               29.2       17.7
50000            8.4        23929.3               19.4       14.7

slowdown vs. 'none':  overlap_naive 1441.30x   overlap_neighbour 2.48x   eventlog 1.69x
```
The direct transliteration of the `EXCLUDE` constraint — `WHERE EXISTS (SELECT 1 FROM h x WHERE
x.k=new.k AND x.vf < new.vt AND new.vf < x.vt)` — is **quadratic**: per-chunk time grows linearly
(2.6 s -> 8.4 s -> 17.0 s -> 23.9 s) because the index on `(k, vf)` can only seek `vf < new.vt`, which
for an append-at-the-end workload is the whole key's history. At 50k versions it is **708 rows/s and
falling**. This is a genuine blocker for the naive design and it is why §4 does not recommend it.

The `overlap_neighbour` variant restricts the check to the immediately adjacent intervals
(`ORDER BY vf DESC LIMIT 1` plus the symmetric upper probe) and is flat. **But it is sound only
inductively** — it assumes non-overlap already holds among existing rows. A GiST exclusion constraint
needs no such assumption. That is a real, if subtle, loss of strength that belongs in the record.

At 1M rows, single key (`e5_scale.mjs`), both survivors stay flat:
```
overlap_neighbour  write 1000000 in 2371ms (421748/s)  file 36MB
  per-100k chunk ms: 216 229 207 223 235 249 231 230 261 291
eventlog           write 1000000 in 2138ms (467732/s)  file 49MB
  per-100k chunk ms: 211 215 212 213 204 201 221 224 225 212
```

### E7b — read path, and a measurement I am retracting (`e7_fix.mjs`)
`e5_scale.mjs` reported **30 077 us/read** for point-in-time reads against the interval table. **That
number is wrong and I am withdrawing it** — trap 8 exactly. It was masked by a missing index: the
table had only `(k, vf)`, so `WHERE k=? AND vf<=? AND ?<vt` degenerated to a scan of the key's whole
history. With an index on `(k, vt)` added and `ANALYZE` run, at the same 1M rows / one key:
```
interval, direct containment (the `validity @> T` transliteration)   5.5 us/read
      plan: ["SEARCH h USING INDEX h_kvt (k=? AND vt>?)"]
interval, neighbour rewrite (SOUND ONLY IF non-overlap holds)        5.3 us/read
interval, upper-bound rewrite via index on (k,vt)                    5.3 us/read
event-log, `last write at or before T`                               3.8 us/read
      plan: ["SEARCH e USING COVERING INDEX e_t (k=? AND written_at<?)"]
```
For the retracted result to have been meaningful, the interval design would have had to be
*inherently* unable to index the upper bound — it can, with a second index. **Corrected finding: the
read paths are comparable (5.5 vs 3.8 us); the event-log is ~30% faster and needs one fewer index.**
The read path is not a differentiator. The *write* path (E4) is.

### E6 / E7a — `RAISE` semantics (`e6_raise.mjs`, `e7_fix.mjs`)
```
===== RAISE(ABORT) =====                 ===== RAISE(FAIL) =====     (identical outcomes)
  guard raised: (1811) UB001: one write per key per transaction
  db.isTransaction after the raise: true
  can the tx keep writing after the raise? yes
  COMMITTED
  ON DISK kv_current: {"k","v3",version:3,updated_at:300,updated_tx:7002}
  ON DISK kv_history: [{v1,[100,200)},{v2,[200,300)}]
  ON DISK side rows : {"c":2}
  VERDICT: non-overlap=true gapFree(history)=true history-meets-live=true

===== RAISE(ROLLBACK) =====
  db.isTransaction after RAISE(ROLLBACK): false   <- the tx is GONE
  a further write by an unaware caller: ACCEPTED (executes in AUTOCOMMIT — commits immediately)
  caller's COMMIT: commit failed: cannot commit - no transaction is active
  ON DISK audit: [{"x":2}]     # pre-failure x=1 rolled back; post-failure x=2 LEAKED
```
And the event-log design under the same swallowed-error attack (`e6_raise.mjs` E6c): a transaction
that ignores four consecutive rejections (dup version, version gap, clock backwards, same tick) and
commits leaves `[{version:1,written_at:100},{version:2,written_at:200}]` on disk — **T1 gapless and
T4 strict-clock still hold, therefore the derived intervals are still non-overlapping and gap-free.**

### E8 / E9 — clock collisions, the monotone fix, and txid substitutes
```
E8a  5000 attempted puts to ONE key, one transaction each, in 38ms
     accepted: 39   rejected with UB_T4_CLOCK: 4961  (99.2%)
E8b  monotone clock: 5000 puts in 71ms — accepted 5000, rejected 0; strictly increasing: true
     logical clock ran 4925 ms ahead of wall clock after the burst
E8d  two puts to the same key inside ONE transaction: REJECTED: UB_T4_CLOCK
     => the strict-clock check subsumes the same-tx guard, but only by accident of ms resolution;
        with the E8b monotone clock it would ACCEPT them.
E9a  SQL-derived transaction identity (per-BEGIN counter row read by the trigger):
       second write in same tx: UB001 -> REJECTED
       write in a NEW transaction: accepted
       forgery (caller inserts an extra txn row mid-transaction): ACCEPTED — guard defeated
E9b  monotone-clock drift vs. write rate (same key):
       rate(puts/s)   puts   max drift ahead of wall clock (ms)
       10             20     0
       100            200    0
       1000           2000   0
       10000          2000   1794
       unthrottled    2000   1858
E9c  new Date(1785521264259.4443).getTime() = 1785521264259  <- sub-ms lost on the API boundary
```

### E10 — bypass surface (`e10_bypass.mjs`)
```
  [BLOCKED]  plain overlapping INSERT            -> UB_T5_OVERLAP
  [BLOCKED]  INSERT OR REPLACE                   -> UB_T5_OVERLAP   (BEFORE INSERT trigger fires)
  [BLOCKED]  INSERT OR IGNORE                    -> UB_T5_OVERLAP   (does NOT swallow RAISE(ABORT))
  [BLOCKED]  pragma ignore_check_constraints=on, then overlapping INSERT -> UB_T5_OVERLAP
  [WORKED]   ...and a zero-width interval, which the CHECK would normally reject
  [WORKED]   DROP TRIGGER then insert an overlap  -> invariant now violated on disk
  ON CONFLICT DO UPDATE  -> BEFORE UPDATE trigger DOES fire (history row written)
  INSERT OR REPLACE      -> BEFORE UPDATE trigger NEVER fires (history row silently lost)
```
Note the asymmetry: `PRAGMA ignore_check_constraints` disables `CHECK` but not triggers, so on SQLite
a trigger assertion is *harder* to bypass than a `CHECK`. `DROP TRIGGER` is a real escape hatch, but
so is `ALTER TABLE ... DROP CONSTRAINT` in Postgres; that is not a regression.

### Source citations (worktree-relative)
- `src/postgres/migrations/001_temporal_kv.ts:57` btree_gist; `:79` `date_trunc('milliseconds', clock_timestamp())`; `:80` `updated_xact ... DEFAULT txid_current()`; `:95` generated `tstzrange`; `:96` `CHECK (valid_from < valid_to)`; `:97-99` `EXCLUDE USING gist`; `:113-132` trigger function; `:120-124` UB001 raise; `:125-126` history row manufacture; `:134-139` `BEFORE UPDATE FOR EACH ROW`.
- `src/postgres/temporal-kv.ts:118-124` upsert (Law T1 total case); `:149-154` CAS `UPDATE ... WHERE version = e`; `:224-229` "Sprint 1 performs no history retention at all"; `:241-260` `getAt` UNION with `validity @> T` and the `priority` tiebreak; `:319-323` `listKeys` cursor query.
- `src/postgres/errors.ts:273-277` UB001 -> `TransactionKeyReuseError`; `:280-297` 23514 -> `ClockRegressionError`.
- `src/interfaces/temporal-kv.ts:206-217` `getAt` `asOf` validation; `:250` `TransactionKeyReuseError`.
- `docs/ERROR-CATALOG.md:41-42` `EXCLUSION_VIOLATION` / `CLOCK_REGRESSION`; `:73-88` the conditional-retryable rationale.
- `Formal/STORAGE_ALGEBRA.md:70-95` one-write-per-key-per-tx rule and the `txid_current()` normative note; `:129-165` Law T3; `:167-207` Law T4 and the ms-truncation caveat; `:209-231` Law T5 split; `:332-333` the status table.
- `Formal/Lean/UmbraDBFormal/TemporalKV/Model.lean:44-62` `ValidityInterval`/`validityIntervals`; `:64-72` `WellFormed`; `:114-125` `attempt` with `clockNotIncreasing`.
- `Formal/Lean/UmbraDBFormal/TemporalKV/Laws.lean:283` `adjacent_intervals_gap_free`; `:333` `intervals_pairwise_disjoint`; `:358` `validityIntervals_cover_iff`.
- `test/postgres/temporal-kv.property.test.ts:134-155` P5; `:89-92` the 5 ms sleep that dodges the ms collision.
- `test/postgres/temporal-kv.test.ts:451-489` UB001 tests; `:462` `await tick()` for the same reason.

---

## 4. Design sketch

**Store the event log. Derive the intervals.** This is `UmbraDBFormal.TemporalKV.History` compiled to
SQL.

```sql
PRAGMA journal_mode = WAL;          -- required for E3's snapshot-upgrade refusal
PRAGMA foreign_keys = ON;
-- adapter MUST NOT enable shared-cache / read_uncommitted (would defeat E3)

CREATE TABLE kv_event (
  ns          TEXT    NOT NULL,
  scope       TEXT    NOT NULL,
  key         TEXT    NOT NULL,
  version     INTEGER NOT NULL,          -- 1-based, gapless (Law T1)
  value       TEXT    NOT NULL,          -- JSON text; jsonb is L4/L5's call
  written_at  INTEGER NOT NULL,          -- ms since epoch. THE sole temporal coordinate.
  PRIMARY KEY (ns, scope, key, version)
) STRICT, WITHOUT ROWID;

-- makes getAt({at}) a covering-index seek AND makes duplicate instants unrepresentable
CREATE UNIQUE INDEX kv_event_time ON kv_event (ns, scope, key, written_at);

-- The single remaining refinement obligation: WellFormed (Model.lean:64-72).
-- Two O(log n) predecessor seeks. Measured flat to 1M rows (E4/E5).
CREATE TRIGGER kv_event_bi BEFORE INSERT ON kv_event
BEGIN
  SELECT raise(ABORT, 'UB_T1_VERSION: version must be exactly prev+1')
   WHERE NEW.version <> 1 + coalesce(
     (SELECT max(version) FROM kv_event e
       WHERE e.ns=NEW.ns AND e.scope=NEW.scope AND e.key=NEW.key), 0);
  SELECT raise(ABORT, 'UB_T4_CLOCK: written_at must strictly exceed the previous version')
   WHERE NEW.written_at <= coalesce(
     (SELECT written_at FROM kv_event e
       WHERE e.ns=NEW.ns AND e.scope=NEW.scope AND e.key=NEW.key
         AND e.version = NEW.version - 1), -9223372036854775808);
END;

-- history is append-only; retention prunes an oldest PREFIX only (Retention/Model.lean)
CREATE TRIGGER kv_event_bu BEFORE UPDATE ON kv_event
BEGIN SELECT raise(ABORT, 'UB_APPEND_ONLY'); END;

-- retention floor, per key, so getAt can throw HistoryUnavailableError rather than null (Law T3)
CREATE TABLE kv_retention (
  ns TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL,
  pruned_count INTEGER NOT NULL CHECK (pruned_count > 0),
  PRIMARY KEY (ns, scope, key)
) STRICT, WITHOUT ROWID;
```

**The write (one statement — B5 requires it).** The monotone clock is computed *inside* the INSERT,
because a SQLite `BEFORE` trigger cannot rewrite `NEW`; the trigger above remains the independent
assertion that it worked:

```sql
INSERT INTO kv_event (ns, scope, key, version, value, written_at)
SELECT :ns, :scope, :key,
       1 + coalesce((SELECT max(version) FROM kv_event e
                      WHERE e.ns=:ns AND e.scope=:scope AND e.key=:key), 0),
       :value,
       max(CAST(unixepoch('now','subsec')*1000 AS INTEGER),
           1 + coalesce((SELECT written_at FROM kv_event e
                          WHERE e.ns=:ns AND e.scope=:scope AND e.key=:key
                          ORDER BY version DESC LIMIT 1), 0))
WHERE :expectedVersion IS NULL
   OR :expectedVersion = coalesce((SELECT max(version) FROM kv_event e
                                    WHERE e.ns=:ns AND e.scope=:scope AND e.key=:key), 0);
-- 0 rows changed => VersionConflictError; re-read to fill `actual` (matches temporal-kv.ts:155-163)
```
CAS (Law T2) collapses into the same statement. `expectedVersion = 0` is the `max(version)=0` case, so
`ON CONFLICT DO NOTHING` (`temporal-kv.ts:131-136`) is no longer needed.

**The reads.**
```sql
-- get()               : ORDER BY version DESC LIMIT 1        (PK seek)
-- getAt({version: v}) : WHERE version = :v                   (PK seek)
-- getAt({at: T})      : WHERE written_at <= :T ORDER BY written_at DESC LIMIT 1
--                       -> "SEARCH e USING COVERING INDEX kv_event_time", 3.8 us at 1M rows
-- listKeys(prefix)    : SELECT DISTINCT key ... WHERE key >= :p AND key < :p||char(0x10FFFF)
--                       -- a range comparison, not LIKE; the interface explicitly permits this
--                       -- (src/interfaces/temporal-kv.ts listKeys doc) and it sidesteps
--                       -- escapeLikePrefix (temporal-kv.ts:50-52) entirely.
-- retention floor     : if :T < (written_at of the oldest retained event) AND a kv_retention row
--                       exists -> HistoryUnavailableError (matches Retention/Model.lean's derived
--                       two-coordinate floor exactly)
-- the P5 diagnostic   : the LEAD() view below IS validityIntervals
CREATE VIEW kv_validity AS
SELECT ns, scope, key, version, value,
       written_at AS valid_from,
       LEAD(written_at) OVER (PARTITION BY ns, scope, key ORDER BY version) AS valid_to
FROM kv_event;
```

**Why this and not the interval table.** Non-overlap and gap-freedom are properties of `LEAD()` over a
strictly increasing column, so neither can be violated by any row the table can hold — no `EXCLUDE`
substitute is needed and no `DELETE` can open a gap. The write cost is 1.69x the unconstrained floor
and flat to 1M rows, versus 1441x and quadratic for the honest transliteration (E4). And it is the
same object the Lean model already reasons about (B6).

**Adapter obligations (application code — name them as such).**
1. Per-transaction write-set to raise `TransactionKeyReuseError` (B4). Guarantee moves from
   SQL-enforced to adapter-enforced. **This is the one unavoidable strict weakening in the lane.**
2. L2's sticky transaction poisoning, for caller atomicity (B5). T5 does not depend on it; G4's
   durability contract does.
3. Ban `INSERT OR REPLACE` on `kv_event` (B7); add a guard test alongside the existing
   `no-sdk-import-guard.test.ts` family.
4. Never split a logical put across two statements (B5).
5. Detect a genuine backward system-clock step and raise `ClockRegressionError`, so the frozen G3 code
   keeps a real trigger after the monotone clock removes its current one (B3).

**Dependencies flagged, not researched.**
- **L2** owns transaction poisoning, `busy_timeout`/retry policy, and the fact that `node:sqlite` is
  synchronous with no `sqlite3_interrupt`. `listKeys`'s abort-mid-wait machinery
  (`temporal-kv.ts:267-384`, built on `Query.prototype.cancel()`) has **no SQLite counterpart** and is
  entirely L2's call; I did not research it. WAL snapshot isolation for readers (L2's finding) is
  strictly stronger than READ COMMITTED and makes the T3 point-in-time read argument easier, not
  harder — a consistent `getAt` across a long iteration is free.
- **L4/L5** own JSON storage (`jsonb` -> `TEXT`/`BLOB` + `json_valid`) and schema isolation
  (`CREATE SCHEMA`/`search_path` -> `ATTACH`/table prefix), both of which the DDL above assumes are
  solved; `DEFAULT_SCHEMA` is part of the frozen G1 surface.
- Whoever owns migrations must note `to_regclass` -> `sqlite_schema` and that `bigserial` -> `INTEGER
  PRIMARY KEY AUTOINCREMENT`.

---

## 5. Open questions / what I could not settle

1. **Clock monotonicity across an NTP step — not measured.** I could not step the system clock in
   this environment. My statement that SQLite's `'now'` derives from `CLOCK_REALTIME` and is therefore
   non-monotonic is a **citation, not a measurement**. It matters because the monotone-clock design
   (B3) makes UmbraDB *robust* to it, which would be a real improvement, but I have not demonstrated
   the failure it protects against.
2. **What `writtenAt` should mean after the monotone clock.** Drift is 0 at realistic rates and ~1.8 s
   after a 2000-put burst (E9b). I do not know UmbraDB's real per-key put rate during wallet sync —
   that is an empirical question about the consumer, not about SQLite, and it decides whether the
   drift is a non-issue or a documented caveat. Someone who knows the sync loop should answer it.
3. **Whether `kv_current` should survive at all.** The sketch folds it into `kv_event`, which removes
   the `getAt` UNION and its `priority` tiebreak (`temporal-kv.ts:241-260`) — that defence exists
   precisely because the EXCLUDE constraint spans only `kv_history` and not the pair. But `get()` on a
   hot key becomes a PK seek plus `ORDER BY version DESC LIMIT 1` rather than a single-row PK hit. I
   measured reads at 3.8 us and did not separately benchmark `get()` under a 1M-version key; I believe
   it is a covering-index seek but I did not confirm it.
4. **Retention/GC is unimplemented in Postgres too** (`temporal-kv.ts:224-229`: "Sprint 1 performs no
   history retention at all"), so I could not compare mechanisms — there is nothing to compare against.
   `Retention/Model.lean` is fully mechanized and the SQLite shape (prefix delete + a `pruned_count`
   row) maps onto it cleanly, but that is a design claim, not a measurement. Note SQLite has no
   `pg_cron` and no partitioning, so the pruning schedule is the adapter's problem.
5. **Postgres-side cost comparison not measured.** The brief says assume no live Postgres server, so I
   have no `EXCLUDE`-constraint insert-rate number to put next to E4's SQLite numbers. My claim that
   GiST gives O(log n) overlap rejection is standard and cited, not measured here. For the E4
   comparison to have been *misleading*, SQLite's absolute insert rate would have had to be so much
   lower than Postgres's that even the 1.69x-overhead design was a regression — at 467k rows/s
   single-threaded, it is not.
6. **The soundness caveat on `overlap_neighbour`.** If the interval design is chosen over the
   event-log design, someone must decide whether an inductively-sound check (which presupposes the
   invariant it enforces) is acceptable where a GiST constraint presupposes nothing. I flag it; I do
   not think it is my call.
7. **Shared-cache mode.** I asserted `PRAGMA read_uncommitted` would defeat E3's guarantee without
   testing it, because the adapter should never enable it. If anyone proposes shared cache, retest E3.

---

## 6. Cost estimate

**~3-4 engineer-weeks for this lane**, roughly:

| Work | Size |
|---|---|
| `kv_event` DDL + triggers + the single-statement write/CAS | 3 days |
| Rewrite `PgTemporalKV` -> `SqliteTemporalKV`: `put`/`get`/`getAt`/`listKeys` | 4 days |
| Monotone clock + drift documentation + `ClockRegressionError` re-pointing | 2 days |
| Adapter-side same-transaction write-set guard (B4) + tests | 2 days |
| Retention floor + `HistoryUnavailableError` wiring (currently unimplemented anywhere) | 4 days |
| Port P1-P5 property tests; rewrite P5's diagnostic against the `kv_validity` view | 3 days |
| Rewrite `STORAGE_ALGEBRA.md` §1 status labels and the §4 table for the new mechanisms | 2 days |
| Bypass/guard tests (`OR REPLACE` ban, trigger-presence assertion at open) | 1 day |

**What it breaks:**
- **T5(1)** loses its "genuinely mechanism-backed, not just trigger discipline" status *if* the
  interval design is chosen; **gains** structural status if the event-log design is chosen. Either way
  `STORAGE_ALGEBRA.md:209-231` and the `:332-333` table must be rewritten. **Frozen cut-line.**
- **T5(2)** upgrades from CALLER-ENFORCED to structural. Frozen cut-line, improved.
- **T4** survives only with the monotone clock; without it, 99.2% of sequential same-key puts fail.
- **`TRANSACTION_KEY_REUSE`** (G3, frozen) moves from database-enforced to adapter-enforced. The code
  and its `retryable: non-retryable` classification survive; its *unforgeability* does not.
- **`CLOCK_REGRESSION`** (G3, frozen, the only `conditional` code) loses its documented
  same-millisecond cause entirely under the monotone clock. `docs/ERROR-CATALOG.md:73-88` must be
  rewritten; the "conditional" classification may no longer be justified, and G2 forbids changing the
  code set in a minor.
- **`EXCLUSION_VIOLATION`** (G3, frozen) is defined as "A Postgres exclusion constraint fired (23P01)"
  (`ERROR-CATALOG.md:41`). There are no exclusion constraints in SQLite. The code must stay exported
  (G2) with a rewritten description, or become dead.
- **`UNRECOGNIZED_POSTGRES_ERROR`** (G3, frozen) is named after the wrong database. Out of my lane to
  fix, but it is this lane's error-translation path that surfaces it.
- **The Lean layer breaks nothing** — and per B6 that fact is a hazard, not a comfort. The refinement
  obligation it rests on is 100% replaced while the gate stays green. The mitigation is that the
  event-log encoding shrinks that obligation to a single property (`WellFormed`) instead of
  discharging a larger one; someone should decide whether that warrants finally mechanizing the
  abstract-to-concrete step for TemporalKV, since after this migration it would be small enough to try.
