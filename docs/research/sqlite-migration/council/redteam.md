# Red team seat — UmbraDB → SQLite

Seat `redteam`. Every number below is followed by the command that produced it in §3.
Scripts are in `/root/rt/` (throwaway; 2.3 GB of test data deleted after, disk checked before and after).
Nothing in `src/`, `test/` or any lane's worktree was modified.

---

## 1. Verdict

**The migration survives; the sprint's evidence largely does not.** Six of seven lanes benchmarked
against `/tmp`, which on this host is a **32 GB tmpfs RAM disk** — L6 caught the trap mid-run and
moved to ext4, and that finding never reached the other six. On real storage L5's durability figures
are overstated by up to **233×**, and the specific conclusion L5 called robust — "journal mode
matters ~6×, `synchronous` ~12%" — **inverts**: `synchronous` is the dominant term by ~102× and
journal mode is nearly irrelevant. **Adjudication 6 inverts outright**: L1's "99.2% of same-key puts
rejected" is real at `synchronous=NORMAL` and is **0.0% at `FULL`** (5000/5000 accepted), so the
clock crisis, the logical clock, its 1.8 s drift and the coupled weakening of `TRANSACTION_KEY_REUSE`
are all contingent on a durability setting L1 never varied and never stated. Of the four
"SQLite is better than Postgres" claims I was asked to break, **three fail**: L2's sidecar lease is
silently voided by a single `fs.readFileSync` and by deleting the lock file; L6's "torn-page hazard
structurally absent" is true of the WAL and false of the main database, which carries **no page
checksums at all** — a durability *regression* against Postgres recorded as an improvement; and L4's
"higher fidelity than jsonb" trades write-time validation for byte-fidelity, with SQL and JS readers
demonstrably disagreeing about the same row. **The fourth survived my hardest attack and came out
stronger** — L1's trigger-based T5 enforcement holds under concurrent writers in rollback-journal
mode too, not only WAL. The archive verdict survives on real disk at 261–433× headroom, but L5's lane
should not be on the critical path at all: the chain archive is wired into no runner path.

---

## 2. Adjudications

### #1 — Is this a 2.0.0, or is it free?

`docs/STABILITY.md:46` verified verbatim: *"**Current version: `0.9.5` — the commitments above are
NOT yet in force.**"* L6 and L4 are right. But every lane priced the pre-tag window as a **scarce**
resource to race against, and it is not. `CHANGELOG.md` states the 1.0.0 tag is **"Blocked"** on
*"a full local sync of UmbraDB against Midnight (archive node → local indexer → UmbraDB), which is
not yet complete."* The window is open, gated on an unrelated incomplete task, and nobody costed it.

**Ruling: free, and the sequencing constraint is nearly costless — but it is not the interesting
fact.** The interesting fact is that the 1.0.0 gate *is* the experiment L5 could not run. A full
local sync against Midnight is precisely a multi-hundred-GB, out-of-cache, real-hardware archive
ingest. **Do the migration first and let the mandatory 1.0.0 gate produce the out-of-cache evidence**
(adjudication #4) instead of commissioning a separate rig. That inverts the sequencing from a cost
into the sprint's cheapest available de-risking.

I defer the exact CHANGELOG/deprecation mechanics to the contracts seat.

### #2 — The scale claim that does not hold

Confirmed, and the circularity is worse than "one bad citation". Three facts:

- The artifact is real in *shape*: `ledger_db_nodes(key BLOB PRIMARY KEY, object BLOB NOT NULL)`
  exists, and `indexer-data/ledger-db.sqlite` is **53,530,624 bytes**, not 88 GB.
- The 88 GB figure comes from `docs/research/indexer-parallelism-roadmap.md` R1, *"60-second
  measurement on the running process"* — a **different deployment** (161 GB at half Preprod height).
  **The roadmap never names the engine for that instance**, and L7 established the indexer ships
  *both* Postgres and SQLite lineages for `ledger_db`. So the claim "already running on SQLite at
  88 GB" is unsupported in the one dimension that matters.
- R1's own numbers do not say what L5 read into them: **23 GB page cache against an 88 GB store is
  26% residency**, not "essentially every read".

**The circularity, stated precisely.** L5 used the same unreproduced record as (a) its existence
proof that the scale is fine and (b) its stated reason for not measuring out-of-cache behaviour
(§5.1: *"the mitigating argument… roadmap R1 measured the real deployment as also
page-cache-resident"*). A single unverified citation is doing double duty as both the evidence and
the excuse for the missing evidence. **L7 had already refuted exactly this use of it** — *"for
'CPU-bound means SQLite is fine at archive scale' to be a meaningful conclusion, the page-cache
residency ratio (23/88 GB) would have to hold as the store grows past RAM. It will not."* Two lanes
contradicted each other on the sprint's single most load-bearing citation and nobody reconciled them.

**Do L5's throughput conclusions survive without it?** Its *verdict* does; its *numbers* do not — see
#4. And the honest framing is stronger than "L5's numbers are wrong": the chain-archive migration
should not have been costed yet at all (see §4.6).

### #3 — Cancellation, and the worker thread

I reproduced L3's figure exactly (30.96× vs L3's 32.2×), so **L3 is not mispriced at the granularity
it measured**. The feasibility seat is right that batching helps and wrong about the model and the
scope:

- The per-round-trip cost is **not a fixed ~101 µs**. It grows with payload: 114.7 µs at 1
  statement/message, 151.5 at 10, **503.6 at 100**. The marginal statement still costs ~4 µs of
  transport on top of ~3.7 µs of execution.
- Amortisation is real where **UmbraDB owns the whole program**: a `saveAndAdvance`-shaped 14-statement
  program in one round trip is 168.8 µs against ~52 µs in-process — ~3.2× on the operation, matching
  the feasibility seat's 3.4×.
- **It is structurally unreachable for `withTransaction(fn)`**, which is a frozen G1 export whose body
  is caller code on the main thread. `src/interfaces/transaction-lease.ts` says so itself: *"`fn` is
  arbitrary caller code with no mechanism for this layer to interrupt it partway through."* You
  cannot ship a JS closure to a worker as a program. A 3-statement caller callback is 5 round trips —
  measured **538.7 µs of pure transport** on a ~37 µs operation.

**Ruling: build the worker, but not for cancellation, and do not let it retire the contract change.**
Rewrite CONTRACT §3 to promise less *and* build the worker. The worker's real justification is L3's
event-loop finding (a 500k-row `.all()` blocks the loop **429 ms**; a wallet's websocket heartbeat
dies), which is a liveness bug independent of cancellation. **What the caller loses either way:**
mid-read abort on any read whose cost is inside SQLite and whose statement text UmbraDB does not
control — `listKeys` over a caller-supplied prefix, and every statement the caller issues inside
`withTransaction`. The guard-UDF only helps where the planner re-invokes it per row.

**A cost nobody priced:** with a worker, `withTransaction` holds `BEGIN IMMEDIATE` on the worker
across every main-thread round trip. L2's B3 already establishes that this is a *whole-database*
write mutex. The worker therefore lengthens the global write-lock hold time by ~110 µs per caller
statement — it makes L2's worst finding measurably worse, and no lane and no seat costed that.

### #4 — Out-of-cache behaviour, and the blast radius of the tmpfs error

**Which lanes were affected.** `/tmp/l1`, `/tmp/l2`, `/tmp/l3`, `/tmp/l4`, `/tmp/l5`, `/tmp/l7` all
exist on tmpfs. Only L6 used `/root/l6-bench` (ext4). **Six of seven.**

**Destroyed** (I/O-bound, measured on RAM):

| L5 claim | published | tmpfs (my repro) | **ext4 (mine)** | error |
|---|---|---|---|---|
| WAL/`synchronous=FULL` | 88,485 c/s | 116,954 | **379** | **233×** |
| WAL/`NORMAL` | 99,418 | 111,987 | **38,620** | 2.6× |
| `DELETE`/`NORMAL` | 17,423 | 20,196 | **215** | **81×** |
| baseline ingest (run A) | 202.9 MB/s | — | **120.3** | 1.7× |
| ingest at `synchronous=FULL` (run B) | 213.4 MB/s | — | **72.5** | 2.9× |

Also dead: the whole A–O pragma matrix, the `page_size` recommendation, the `cache_size` negative,
and the in-DB-vs-filesystem blob crossover (both sides were RAM).

**Two of L5's conclusions invert, not merely shift.**
1. *"Durability is not the throughput lever at this payload size… A/B/C are within 6%."* On ext4,
   NORMAL→FULL costs **1.66×** (120.3 → 72.5 MB/s). L5's run B literally reported `FULL` as *faster*
   than `NORMAL` — a physically impossible result that was a visible tell and was not acted on.
2. *"The ordering (WAL >> rollback journal, 6×) is robust; the magnitude of the durability knob is
   not."* Exactly backwards. On ext4 `synchronous` is worth **102×** (38,620 vs 379) and journal mode
   is worth ~1.8× at FULL.

**Does L5's verdict survive? Yes, and I tested it rather than assuming.** 120.3 MB/s (NORMAL) and
72.5 MB/s (FULL) against a 0.278 MB/s requirement is **433× / 261× headroom**. The headline holds.

**But the thing L5 said it could not see started appearing the moment I put it on a disk.** At
`synchronous=FULL` the per-quarter throughput decayed **11,890 → 9,305 → 5,147 → 4,502 rows/s** — a
**2.64× decay over just 2.4 GB, still falling steeply at the end of the run**, against 1.42× on
tmpfs. That is the out-of-cache onset, at 2.4 GB on a 62 GB box, in the configuration the contract
currently specifies. Extrapolating a flat slope to 400 GB was never defensible; extrapolating this
one is not either.

**Strengthened by the error** — findings that held *despite* a favourable environment, and which get
worse on disk, not better:
- **L1's 1,441× quadratic penalty** on the honest `EXCLUDE` transliteration (708 rows/s and falling).
  Measured on a RAM disk, so it is a **floor**. The recommendation against the naive transliteration
  is the best-supported conclusion in the sprint.
- **L5's run O** (`WITHOUT ROWID` on `chain_blobs`, 3.3× regression) and **L4's** independent
  `WITHOUT ROWID` negative — two lanes, same direction, both on RAM, both understated.
- **L3's 429 ms event-loop stall** and the 64 MB blob block (237 ms) — the blob figure is a memcpy on
  tmpfs and is *understated* on disk.

**Unaffected** (semantics, not I/O): every syntax/capability probe (L1 E0, L4 §3.1–3.9, L3 §3.6–3.10),
the `errcode` mappings, L2's lock semantics, SIGKILL crash-release timing, savepoints, the
non-poisoning finding, `SQLITE_BUSY_SNAPSHOT` behaviour, and **all of L6**.

**Distinguish one negative carefully.** L5's `cache_size` negative (2 GB worse than default) is
neither strengthened nor merely wrong — it is **meaningless**, because its stated mechanism was *"the
OS page cache is doing the work"* and on tmpfs the file *is* the page cache. Applying the project's
own rule: for that negative to be meaningful the store would have had to be backed by real storage
with a real cache hierarchy. It was not. It must be re-measured, not reported.

**The experiment that closes #4** is the one already on the 1.0.0 critical path: instrument the
mandatory full local Midnight sync (`CHANGELOG.md`) with per-window throughput, `dbstat` depth, and
`/proc/diskstats`, on real hardware, at `synchronous=FULL`, past RAM.

### #5 — What is genuinely not closeable

Shorter than the sprint suggests, and it has an entry no lane listed:

1. **Page-level corruption detection — not closeable, and it is a regression.** SQLite writes no
   checksum on main-database pages. I corrupted 64 bytes mid-file after a checkpoint:
   `integrity_check` returned **`ok`** and the row's payload came back as garbage. Postgres has
   `data_checksums` (`initdb -k`; default ON since PG18) and `amcheck`/`pg_amcheck`. `node:sqlite`
   exposes no VFS hook, and SEE/SQLCipher are unavailable. UmbraDB's own SHA-256 covers
   `ckpt_chunks`/`chain_blobs` — and **not** `kv_current`/`kv_event`, `watermarks`, or
   `transaction_history`, i.e. exactly the wallet state and sync cursors.
2. **Mid-statement cancellation of a caller-supplied read** — not closeable in-process; partially
   closeable off-thread, never for `withTransaction`'s body (#3).
3. **I/O fault injection** (`SQLITE_IOERR_*`) — L6 is right, no VFS hook, so two error codes stay
   reachable-in-principle and untested-in-practice.
4. **Encryption at rest in-engine** — L6 B8. Filesystem/volume encryption only.
5. **PITR** — deployer capability, not a UmbraDB one.

Everything else the lanes called a blocker is expensive, not impossible.

### #6 — The clock. **This adjudication inverts.**

L1's E8a is reproducible and is an artifact of an unstated parameter. Same trigger, same shape, four
durability configurations, on ext4:

```
WAL/OFF     5000 attempts in    40 ms -> accepted   40, rejected 4960 (99.2%)
WAL/NORMAL  5000 attempts in    44 ms -> accepted   45, rejected 4955 (99.1%)
WAL/FULL    5000 attempts in 36150 ms -> accepted 5000, rejected    0 ( 0.0%)
DELETE/FULL 5000 attempts in 36413 ms -> accepted 5000, rejected    0 ( 0.0%)
```

At `synchronous=FULL` — today's contract, and what L6 calls *"the only defensible default"* absent
power-loss evidence — a commit costs 7.2 ms, so **two sequential same-key puts cannot land in the
same millisecond**. The collision rate is zero. L1 never varied the pragma and never named it.

**Ruling: do not adopt the logical clock.** It is a fix for a problem that does not exist at the
durability setting the project currently promises. Its costs are all real and all paid regardless:
`writtenAt` ceases to be a wall clock and can run **1.8 s ahead**; the frozen `CLOCK_REGRESSION` code
loses its only documented trigger; and by L1's own B4 the two fixes are coupled — *"you cannot take
B3's fix without paying B4's cost"* — so adopting it also forfeits the accidental same-transaction
guard. **A `written_at` that runs seconds ahead of wall time is not acceptable for a store whose
contract is point-in-time reads**: a caller that computes `getAt({at: Date.now()})` after a burst
reads a *past* state and cannot tell; a caller that compares `writtenAt` against its own clock sees
timestamps from the future and will either reject them as clock skew or mis-order them against
externally-timestamped events. Neither failure raises an error.

**Therefore the honest ordering is: decide `synchronous` first; the clock question is downstream of
it, not independent.** If the project later spends the `NORMAL` lever on real power-loss evidence,
the clock problem returns and *then* the logical clock must be priced — including the frozen-`Date`
API change, which at that point becomes the cheaper of two bad options rather than the ruled-out one.
Microsecond storage being "ruled out by the frozen API, not by SQLite" is correct and, pre-1.0.0
(#1), that API is not actually frozen.

### #7 — A frozen commitment that gets stronger is still a change

Agree with L6 on re-execution: `docs/recovery/EVIDENCE.md`'s binding rule 1 ("the run MUST be against
the RC commit") is invalidated by an engine change, and amending it would be a false record.

**I add one thing the lanes missed, from my own results.** P1–P10 as written would pass against a
lease that is void. My readFileSync attack (§2 below) breaks Law L1 with no error and no signal;
L2's own proposed startup probe (two in-process connections, assert the second is refused) does not
catch it either. So "re-execute P10" is necessary and not sufficient — **P10 must gain a negative
control**, exactly as L6's crash harness has one (§3.5, "the forbidden cursor-first ordering violated
the invariant in 4 of 9 runs, so the harness genuinely detects the failure it is looking for").
Without one, a green P10 after the migration certifies nothing about the new mechanism.

What a reviewer is owed for a strengthening: the register row rewritten with the old mechanism struck
and the new one named, plus the *negative* test that would have caught the old mechanism failing.

### #8 — Total cost and sequencing

Do not add the lane estimates. My specific correction: **strike L5's 4–6 engineer-weeks from the
critical path.** The chain-archive lineage states verbatim *"Not wired into any runner path that
would execute it"*; `chainArchiveMigrations` is an exported array nothing calls; `src/index.ts:22`
calls it *"the deferred full-chain-archival track"*. There is no data, no consumer, and no runner. It
is a design-stage artifact and it absorbed the sprint's largest single cost estimate and its most
damaged evidence.

I defer the consolidated number to the feasibility seat.

---

## 3. Evidence

### 3.1 What I re-tested myself (commands and output)

**The tmpfs finding, independently.**
```
$ wsl -e bash -lc 'df -hT /tmp /root'
tmpfs          tmpfs   32G  1.9G   30G   6% /tmp
/dev/sdd       ext4  1007G  375G  581G  40% /
$ wsl -e bash -lc 'grep -n "dir:" /tmp/l5/ingest.mjs'
9:  dir: "/tmp/l5/run",
$ wsl -e bash -lc 'for d in /tmp/l1 /tmp/l2 /tmp/l3 /tmp/l4 /tmp/l5 /tmp/l6 /tmp/l7; do [ -d $d ] && echo $d; done'
/tmp/l1  /tmp/l2  /tmp/l3  /tmp/l4  /tmp/l5  /tmp/l7        # no /tmp/l6
```

**L5's own `fsync.mjs` shape, both filesystems** (`/root/rt/a1_fsync.mjs`):
```
/root/rt/ext4  raw fsync: 4738 us/call        /tmp/rt-tmpfs  raw fsync: 14 us/call
  WAL/OFF:       112100 commits/s               WAL/OFF:       115937 commits/s
  WAL/NORMAL:     38620 commits/s               WAL/NORMAL:    111987 commits/s
  WAL/FULL:         379 commits/s               WAL/FULL:      116954 commits/s
  DELETE/NORMAL:    215 commits/s               DELETE/NORMAL:  20196 commits/s
  DELETE/FULL:      171 commits/s               DELETE/FULL:    20697 commits/s
```
My ext4 WAL/FULL (379) triangulates with L6's independent 523 and the contradiction seat's 345.

**L5's actual `ingest.mjs`, unmodified except the output directory** (`/root/rt/ingest_ext4.mjs`):
```
baseline WAL/NORMAL: 10911 rows/s, 120.3 MB/s, windows 13925 -> 10883 -> 9965 -> 9752
FULL:                 6579 rows/s,  72.5 MB/s, windows 11890 ->  9305 -> 5147 -> 4502
```

**The clock** (`/root/rt/a2_clock.mjs`) — output quoted in full under #6.

**The lease** (`/root/rt/a3_lease.mjs`, `/root/rt/a3b_lease.mjs`):
```
child: {"holder":"acquired","pid":461492}
[pre]  competitor tryAcquire -> {"ok":false,"errcode":5,"msg":"database is locked"}
child: {"holder":"readFileSync done","bytes":8192}
[post-readFileSync] competitor tryAcquire -> {"ok":true, ...}
*** MUTUAL EXCLUSION BROKEN: two live holders of the same lease key ***

-- attack 2: rm the sidecar lock file while held --
[post-unlink] competitor tryAcquire -> {"ok":true}
*** MUTUAL EXCLUSION BROKEN: new inode => new lock space => two live holders ***

=== sidecar journal_mode=default ===   pre: refused  after read .db: ACQUIRED  after read -shm: ACQUIRED
=== sidecar journal_mode=wal     ===   pre: refused  after read .db: refused   after read -shm: ACQUIRED
```
Mechanism: POSIX record locks are dropped when a process closes **any** fd on the inode. SQLite's
unix VFS defers closing *its own* fds to work around this; it cannot defend against an fd opened by
Node's `fs` module. In rollback-journal mode the locks live on the `.db` inode; in WAL they live on
`-shm`. **L2's `acquireLocked` sketch never sets `journal_mode` on the sidecar, so the shipped lease
is in the `default` (= `delete`) row — the vulnerable one.** WAL on the sidecar is a partial
mitigation only; reading `-shm` still voids it.

**JSON fidelity** (`/root/rt/a5_json.mjs`):
```
ACCEPTED garbage into the jsonb-replacement column: "{not json at all" / "" / "{\"a\":1" / "undefined"
stored bytes byte-identical: true
  JS JSON.parse(...).height      = 99
  SQL json_extract(v,'$.height') = 10          <-- same row, two readers, two answers
SELECT json_type(value,'$.height') FROM wm -> THROWS: malformed JSON (errcode=1)
CHECK(json_valid(value)) rejects at write: errcode=275   <-- the fix L4's DDL omits
```

**Main-database page integrity** (`/root/rt/a7_misc.mjs`):
```
integrity_check after 64 corrupted bytes in the main db: [{"integrity_check":"ok"}]
rows whose payload is now garbage: 1
```

**Worker RPC** (`/root/rt/a6_worker.js`):
```
in-process point read : 3.70 us/op
batch |  msgs | us/op | us/round-trip | vs in-process
    1 | 20000 | 114.69|         114.7 | 30.96x        <-- reproduces L3's 32x
   10 |  2000 |  15.15|         151.5 |  4.09x
  100 |   200 |   5.04|         503.6 |  1.36x        <-- round-trip cost is NOT fixed
  withTransaction(fn) w/ 3 caller statements (5 round trips)   538.7 us
  saveAndAdvance-shaped program, 14 stmts, 1 round trip        168.8 us
  same, split at the RETURNING dependency (2 round trips)      279.8 us
```

**Repo facts** (`docs/STABILITY.md:46`, `CHANGELOG.md`, `package.json`, `README.md:17`) — quoted
inline above; commands in §2.

### 3.2 Attacks I made and **failed** — these are the ones that make the rest credible

1. **L1's E3 (the sprint's highest-value positive claim) survives, and is stronger than L1 stated.**
   I attacked it across three journal modes × two `busy_timeout` values — L1 tested one cell
   (`wal`/`0`), and both off-diagonal axes are reachable by the recommended design (L1's own sketch
   defers `busy_timeout` to L2; L5 measured rollback-journal ingest as *faster*):
   ```
   journal_mode=wal      bt=0     A.insert:E517  rows=[{k,100,200}]  T5 holds
   journal_mode=wal      bt=5000  A.insert:E517  rows=[{k,100,200}]  T5 holds
   journal_mode=delete   bt=0     B.insert:E5    rows=[]             T5 holds
   journal_mode=delete   bt=5000  B.insert:E5    rows=[]             T5 holds
   journal_mode=truncate bt=0     B.insert:E5    rows=[]             T5 holds
   journal_mode=truncate bt=5000  B.insert:E5    rows=[]             T5 holds
   ```
   L1 claimed WAL was *required* ("`PRAGMA journal_mode = WAL; -- required for E3's snapshot-upgrade
   refusal"). It is not: in rollback-journal mode the reader's SHARED lock blocks the competing
   writer outright (errcode 5), which is a *stronger* exclusion than the WAL path. **The claim that a
   trigger-based overlap check is safe under concurrent writers on SQLite stands, and the
   single-writer assumption is genuinely not load-bearing for T5.** This is the sprint's best
   finding and my seat could not dent it.
2. **The main WAL database survived the fd attack.** Same `readFileSync`, on `main.db` under an open
   `BEGIN IMMEDIATE`: the second writer was still refused (errcode 5), the commit succeeded,
   `integrity_check` was `ok`. The hazard is specific to rollback-journal-mode files, which is why it
   hits the lease sidecar and not the main store.
3. **`TRANSACTION_KEY_REUSE` forgery failed — the feasibility seat is right and L1 overstated.** With
   UmbraDB holding `BEGIN IMMEDIATE`, an attacker connection opened on the same path was refused
   (`errcode 5`) and could not bump the counter; the guard held. L1's "one unavoidable strict
   weakening" is too strong. **But the credit belongs to UmbraDB owning the handle, not to the
   worker** — any design where the caller receives an opaque `TransactionHandle` instead of today's
   `UmbraDBSql` achieves it. The residual hole is any escape hatch that runs caller-supplied SQL on
   the transaction's connection (L3 counts 2 live `sql.unsafe` sites); close those and the guard is
   as unforgeable as `txid_current()` in practice.

### 3.3 Taken on a lane's authority, not re-tested

All Postgres-side behaviour (no server available to any of us): jsonb normalization, `<@` set
semantics, `lc_collate` ordering, GiST O(log n) rejection, and my own PG-side citations
(`data_checksums`, `amcheck`) — these are documentation-level claims, and I label them as such.
L6's `ALTER TABLE` matrix, rebuild footprint and WAL-damage results (its methodology is the only one
on real storage). L7's external precedent in full. L3's driver comparison table. L4's junction-table
performance work (semantics verified by L4 on a fixture; I did not re-run it).

---

## 4. What the sprint got wrong or missed

**4.1 The measurement environment was never validated, and the one lane that caught it could not
tell the others.** This is a process failure, not seven independent analytic failures. The shared
brief told every lane to put scratch work in `/tmp`; nobody checked what `/tmp` was. Any future
sprint of this shape needs a one-line environment assertion in the brief (`df -T` on the scratch
path, plus a raw-fsync calibration) that every lane pastes into its evidence section.

**4.2 A direct lane contradiction on file layout that is not among the eight adjudications.** L2 B3:
*"the ~1 GB/hour chain-archive ingest and the wallet-sync writer cannot share one file without
serialising against each other. Separate files give independent write locks."* L5 §4: *"**One
database file.** Not per-tier, not per-height-range."* These are incompatible recommendations on the
single highest-consequence structural decision in the migration, reached by two lanes that each cited
the other, and no seat was asked to resolve it. It is decidable — L5's atomicity argument only binds
tables a single transaction spans, and no transaction spans the wallet tier and the archive — but
someone must actually decide it and write down the rule ("one file per lineage; no transaction may
span lineages"), because the naive reading of L5 produces exactly the write-lock contention L2
measured.

**4.3 Nobody owns corruption detection or field repair.** §2 #5 item 1. Beyond detection: there is no
plan for what UmbraDB *does* when `integrity_check` fails. SQLite's `.recover` is a CLI feature; the
CLI is not installed on this host and is not a dependency. Postgres has `pg_amcheck`, `pg_checksums`,
`zero_damaged_pages`, and a professional recovery ecosystem. This is a genuine capability the
migration deletes, and it was recorded in L6 as an *improvement*.

**4.4 Nobody owns Windows.** UmbraDB is a wallet library with no stated OS restriction. L2 explicitly
labels its Windows lease reasoning an *inference, not a measurement*. Windows uses `LockFileEx`, with
different semantics from the `fcntl` hazard I demonstrated; L6's filesystem-refusal probe would also
need a Windows path. For a library whose whole new precondition is "a local filesystem with working
POSIX advisory locks", shipping without testing the platform that has no POSIX advisory locks is a
gap, not a detail.

**4.5 Nobody owns observability.** `pg_stat_activity`, `pg_stat_statements`, `EXPLAIN ANALYZE`,
`log_min_duration_statement` and every exporter built on them have no SQLite analogue. `dbstat` and
`sqlite3_status` are not substitutes. Small, but it is a real operational surface that silently
becomes the consumer's problem.

**4.6 The chain archive should not have been costed.** Not wired into any runner path, no data, no
consumer — and it carried the largest cost estimate and the most damaged evidence in the sprint.
Costing an unwired design-stage tier at 4–6 engineer-weeks distorted adjudication #8.

**4.7 Data migration from Postgres is ~zero work — and it is a fact about the world, not this
laptop, with one honest caveat.** `registry.npmjs.org/umbradb` returns 404; there is **no publish
step anywhere in `.github/`**; `README.md:17` instructs `npm install
github:CharlesHoskinson/UmbraDB#v0.9.5`; `CHANGELOG.md` dates 0.9.5 to 2026-07-25 and calls it *"the
first importable, published public surface"*. **Caveat I will not paper over:** a git-tag install
leaves no registry footprint and no dependents graph, so "zero consumers" is *unobservable* rather
than *proven*. The correct statement is: there is no discoverable consumer, the sole distribution
channel is a tag the owner controls, and **the owner is the only party who can enumerate them.** Ask
him; do not infer it. If the answer is zero, L7's warning that the dual-backend migration path cost
every precedent years does not apply here at all, and that is the single largest cost the sprint
avoided without noticing.

**4.8 The Lean immunity — taking the position the brief asks for.**

`Formal/FORMALIZATION_ROADMAP.md:24` is unambiguous: *"No theorem relates any Lean definition to SQL
DDL, a trigger, `clock_timestamp()`, `Finmap`→rows, or the TS adapter."* So the model is invariant
under total replacement of the concrete layer — and I think **both framings offered in the brief are
half right, and the synthesis is the useful part.**

The model is *not* too weak. An abstract model that constrains observable behaviour and not mechanism
is exactly right; that is what makes it survive a mechanism change, and L1's demonstration that the
event-log encoding is *literally* `History Value Time` with `validityIntervals` compiled to `LEAD()`
is the strongest formal-methods finding in the sprint. A model you must rewrite when you change
engines was over-fitted to the engine.

But the **gate** is a different object from the model, and with respect to this migration the gate is
theatre. It certifies depth about a mathematical object that no theorem connects to the artifact. The
migration is a natural experiment that *proves* this: it replaces 100% of the untrusted layer and 0%
of the proven one, and the CI stays green throughout. **Therefore my position: the value of the
formal work is real and lives entirely in specification, not in assurance; and the assurance for the
concrete store is, and after the migration remains, ten property tests.** Two operational
consequences: (a) **ban the sentence "the Lean layer is unaffected" from every risk argument in this
migration** — it is true and it is evidence of disconnection, not of safety; (b) put L6's rewritten
refinement register on the critical path, because after the migration the refinement obligation is
small enough to mechanize for TemporalKV for the first time, and that is the only way the gate starts
certifying breadth. L1's claim that the event-log design *shrinks* the obligation to a single property
(`WellFormed`) is the best argument in the sprint for redesign over transliteration — but note it is
a claim about the size of an obligation nobody has discharged.

---

## 5. Recommendation

1. **Re-measure before deciding anything performance-shaped.** Every I/O-sensitive number in L1–L5
   and L7 is void. Re-run on ext4 at `synchronous=FULL`, past RAM. Budget ~3 days. Until then, the
   only durability figures in the corpus are L6's and mine.
2. **Set `synchronous=FULL` and treat it as decided.** It is today's contract, L6's power-loss gap is
   real and unclosable on this host, and it makes adjudication #6 disappear. **Do not adopt L1's
   logical clock.** Re-open only if the project buys real power-loss evidence and chooses to spend
   the `NORMAL` lever — and price the clock as part of *that* decision, not separately.
3. **Redesign the lease before it ships.** The sidecar must at minimum (a) run in WAL mode, (b) live
   in a directory no cleaner touches, (c) never be opened by anything but SQLite in-process, and
   (d) be covered by a P10 negative control that performs the `readFileSync` and asserts the lease
   *survives*. Honestly: given that (c) is unenforceable against consumer code in the same process, I
   would take L2's own rejected option — an in-process JS mutex, which satisfies the letter of the
   1.0 single-writer promise — **plus** a whole-database `BEGIN IMMEDIATE`-derived guard against an
   accidental second process, and drop the per-key sidecar entirely. That is fewer moving parts and
   no silent-void mode. L2's "strictly safer than `pg_advisory_lock`" must be struck from the record.
4. **Add `CHECK (json_valid(value))` to every JSON column** and strike "higher fidelity than jsonb"
   from L4. Byte-fidelity without write-time validation is a downgrade; the duplicate-key divergence
   (`json_extract` says 10, `JSON.parse` says 99) is a live correctness hazard the moment the
   chain-archive watermark guard runs.
5. **Rewrite L6 B6 and B7.** "Torn-page hazard structurally absent" applies to the WAL only; the main
   database has no page checksums, `integrity_check` does not detect payload corruption, and Postgres
   has both `data_checksums` and `amcheck`. Record this as the migration's one genuine **durability
   regression**, and decide explicitly whether wallet-state tables get application-level checksums
   the way `ckpt_chunks` already does.
6. **Build the worker for event-loop liveness, and rewrite CONTRACT §3 anyway.** Batch every
   UmbraDB-owned composite into one message (~3× — worth it); accept ~110 µs per statement for
   `withTransaction` bodies; and cost the lengthened global write-lock hold time, which no lane did.
7. **Sequence it as: migrate → full local Midnight sync → tag 1.0.0.** The sync is already a blocking
   requirement for the tag and is the out-of-cache experiment. Instrument it. This turns adjudication
   #1's "sequencing constraint" from a cost into the cheapest de-risking available.
8. **Ask the owner to enumerate consumers.** One question that decides whether a whole workstream
   (data migration, which L7 says cost every precedent years) exists or not.
9. **Resolve L2 vs L5 on file layout explicitly** (§4.2), and assign the four unowned surfaces:
   corruption response, Windows, observability, and the migration-from-Postgres path if #8 comes back
   non-zero.
