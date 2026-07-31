# Council seat: feasibility, sequencing and cost

Seat `feasibility`. All seven lane reports read in full, plus `corpus/00-BRIEF.md` and
`COUNCIL-BRIEF.md`. Independent checks were run against `origin/main` (`3c0c68b`) via the
`/root/UDB-sqlite-l6-contracts` worktree and against Node v24.18.0 / `node:sqlite` 3.53.1 in WSL.
Commands and output are in §3.

---

## 1. Verdict

**Do it. Start now, wallet tier first, chain archive deferred, and land it before the local-sync
evidence run — not merely before the 1.0.0 tag.** The go/no-go does not actually rest on any lane's
technical finding; it rests on two facts outside every lane's remit that I verified myself: UmbraDB
is **not published to npm**, has **no installed consumer anywhere in this environment**, and **no
Postgres deployment exists, running or stopped** — so the migration-of-existing-data problem that
consumed years in every precedent L7 surveyed is, today, **zero work**; and `1.0.0` is blocked on an
owner-added condition (a full local Midnight sync, `ROADMAP.md:347-398`) that is an **infrastructure**
long pole, not a code one, so the pre-tag window is already open for a duration nobody has measured.
**The aggregate verdict is genuinely supported, but not by the aggregate.** Three lanes' designs are
mutually inconsistent as written, one lane's headline scale evidence is circular, and the summed cost
estimate is unusable — so the honest reading is *"the conclusion is right and the evidence for it is
partly seven local optima."* The corrected cost is **94–131 engineer-days** on the pre-tag critical
path (~19–26 engineer-weeks; ~2.5–3.5 calendar months for two engineers), with 20–30 further days for
the archive deferred past the tag. The genuinely-not-closeable list is **five items**, only one of
which — `node:sqlite`'s unpinnable, silently-experimental platform status — has real product
consequence, and it is a posture decision rather than an engineering one.

---

## 2. Adjudications

### 2.1 Is the aggregate verdict real, or seven local optima? (the question my seat owes first)

**Both, and it matters which part is which.** Seven agents each asked whether their own slice was
tractable did find it tractable, and the composition is measurably not free. I found four cross-lane
seams the sprint did not close, three of them straight contradictions:

| Seam | Lane A says | Lane B says | Status |
|---|---|---|---|
| Concurrency architecture | **L2**: `busy_timeout=0` everywhere, all waiting in a JS poll loop, "assumes L3 chooses a synchronous driver" run in-process | **L3**: the database lives on a **worker thread**; **L6**: `PRAGMA busy_timeout=30000`; **L7**: 60 s, "5 s is a bug" | **Unresolved 3-way.** See below — L2's *finding* survives the worker, its *rationale* does not |
| Tier file layout | **L5**: "One database file. Not per-tier." | **L7 D1**: "Two databases, not one. The single most important structural decision." | **Contradiction. I resolve it below, from the code.** |
| `STRICT` vs declared-type decoding | **L3**: decoder keys on `columns().type` (`JSONB`, `TIMESTAMPTZ`) | **L4 B10**: `STRICT` forbids those type names; key on origin `(table, column)` instead | **Resolved by L4**, at 0.5 d. The only seam a lane closed itself. |
| Table/index/trigger naming | **L4**: everything must carry the `schema` prefix, because index and trigger names are **global per file** (measured) | **L1** ships `CREATE TABLE kv_event` / `CREATE TRIGGER kv_event_bi` unprefixed; **L5** ships `blocks_p0_one_canonical` unprefixed | **Ordering constraint, not a conflict.** L4's prefix layer must exist before any other lane writes DDL. |

The concurrency seam is the important one and it is worth spelling out, because it is exactly the
failure mode L2 itself warned about in a different context. L2's central design decision —
`busy_timeout = 0`, wait in JS — is justified by "keeps the event loop turning so an in-process holder
can actually release" (exp 10: naive port 1/8 acquired, poll loop 8/8). Under L3's worker topology
that justification is **wrong as written**: the main event loop keeps turning by construction, but the
*worker's* message loop is what must turn for a release to be delivered, and a blocking `busy_timeout`
inside the worker pins exactly that. **L2's conclusion survives; L2's reason for it does not, and must
be re-derived rather than carried over** — the same instruction L2 correctly gave about
`checkpoint-store.ts:485`'s READ COMMITTED argument. Meanwhile L6's 30 s and L7's 60 s
`busy_timeout` recommendations are imported from multi-process daemons (CLN, LND) and are actively
harmful in a single-process library that does its waiting in JS. Nobody synthesised: the correct
answer is `busy_timeout=0` **plus** L7's bounded jittered retry classifier on the masked primary
result code, and it is written down in no report.

**What this does not defeat:** the verdict. What it defeats is the summed cost estimate and any plan
that fans out to seven parallel implementers. Hence Phase 0 in §2.4.

### 2.2 Adjudication 1 — is this a 2.0.0, or is it free?

**Verified.** `docs/STABILITY.md:46` reads verbatim: *"**Current version: `0.9.5` — the commitments
above are NOT yet in force.**"* `git tag` returns exactly `v0.9.5`; there is no `v1.0.0`.
`package.json` is `"version": "0.9.5"`. The claim holds.

**Ruling.** L4 is right that *its* lane produces no permanent break and wrong that this collapses the
whole bill. L3's B3 is a genuine permanent surface break — `UmbraDBSql` is an exported **type** that
is structurally `postgres.js`'s `Sql`, re-exported at `src/index.ts:81`, and it cannot survive
dropping the `postgres` dependency; so are `createClient`'s option shape and the `Pg*` class names on
the barrel. Post-tag this is unambiguously a 2.0.0. **Pre-tag it costs a CHANGELOG entry and one
honest paragraph.**

**The sequencing constraint is sharper than "before the tag", and this is my main contribution here.**
`ROADMAP.md:389-397` sets the remaining path to 1.0.0 as: archive node to tip → local indexer catches
up → *"UmbraDB ingests from **that** local stack, end to end, with the evidence recorded alongside
`docs/recovery/EVIDENCE.md`"* → re-run the R1–R12 tag gate. L6 establishes that `EVIDENCE.md`'s own
binding rule ("the run MUST be against the RC commit") means it must be **re-executed, not amended**,
when the engine changes. So the last and most expensive 1.0.0 gate item is precisely the item that
would have to be paid for twice if the migration lands after it. **Land the migration before the
local-sync evidence run.** That is a strictly stronger constraint than the tag, and it is the one
that should drive scheduling.

**Does 1.0.0 have to be *delayed*?** Probably not, or trivially. It is already blocked on an external
dependency whose remaining duration nobody has measured — `ROADMAP.md:393` names the local indexer
catch-up as "the slower of the two and the real long pole", and the node only resumed on 2026-07-25.
**The one number the owner needs and nobody has is: how many weeks of indexer catch-up remain.** If it
is ≥ 10 weeks, the migration is free in calendar terms. If it is 2 weeks, 1.0.0 slips by roughly the
migration's elapsed time minus 2.

**Credibility cost, stated honestly.** It is real but small and it is not the SemVer promise —
`STABILITY.md:57-63` already says a breaking change between 0.9.5 and 1.0.0 is permitted. What it
costs is the *expectation* the same page sets: *"The intent is that none is needed — the surface at
1.0.0 is expected to be identical."* The engine swap falsifies that sentence loudly. The honest
handling is one paragraph in `STABILITY.md` recording that the RC expectation was not met and why, and
a CHANGELOG section enumerating the surface delta. Because the package was never on npm (`README.md`:
*"Not published to npm yet"*), the exposure is to readers of the repository, not to installed users.
Cost: hours. Compare it with the alternative — the same work as a 2.0.0 in six months, with L7's
evidence that no comparable project has ever supported a cross-engine data migration.

### 2.3 Adjudication 2 — the scale claim, and a circularity nobody caught

**Re-verified independently.** `ledger-db.sqlite` is **53,530,624 bytes** (`page_count` 13,069 ×
`page_size` 4,096, `journal_mode` **`delete`**). The coordinator's correction stands.

What the artifact **does** prove, and it is a good find: the actual upstream this project ingests from
deploys a content-addressed store keyed by a random 32-byte BLOB primary key
(`ledger_db_nodes(key BLOB PRIMARY KEY, object BLOB NOT NULL)`) on SQLite, under real migrations. The
*shape* is real. What it does not prove is anything about 88 GB, about WAL, or about a tuned
configuration — it runs with no pragmas at all.

**The circularity, which is my finding and which neither lane saw.** L7 §3.2 states plainly that it
*also* could not reproduce the 88 GB / 161 GB figures (`find / -xdev -size +5G` returns only Mithril
archives; largest ledger DB on disk is 52 MB) and cites the in-repo record per trap 4. So **two lanes'
archive-scale evidence traces to the same single unreproduced measurement.** Worse: L5 §5.1 concedes
that all its numbers are cache-resident and offers a mitigation — *"roadmap R1 measured the real
deployment as also page-cache-resident (23 GB cache over an 88 GB store)"* — **which is derived from
the same unreproduced record.** The scale claim is used both as the evidence and as the excuse for not
measuring the thing the evidence would be needed for.

**What survives.** L5's own ingest measurements are independent and stand on their own: 203 MB/s
random-key / 417 MB/s sorted, sustained to an 11.8 GB file, against a stated 0.28 MB/s requirement.
That is a real 660–730× headroom result *at 11.8 GB on a 62 GB box*. It is not an archive-scale
result. **Consequence for my seat: this is decisive for deferring the archive, and only for that.** It
does not touch the wallet tier, where every lane's evidence is direct.

### 2.4 Adjudication 3 — cancellation, and a measurement that changes the answer

**Build the worker, but only with a transaction-granular RPC. L3 priced the worker at its worst
possible granularity and nobody re-priced it.** L3 measured 32× on point reads (3.86 µs → 124 µs) and
wrote *"batching those into a single worker message … would amortise the hop almost completely. I did
not build that."* I built it.

```
node v24.18.0  transactions=400 stmts/tx=25 ops=10000
A in-process sync        : 19 ms   1.90 us/op
B worker, msg/statement  : 1274 ms 127.40 us/op = 67.1x A
C worker, msg/transaction: 65 ms     6.50 us/op =  3.4x A     <- C vs B: 19.6x

in-process point read     : 66 ms   3.30 us/read
worker,   1 read/message  : 2406 ms 120.30 us/read = 36.5x
worker,  10 reads/message : 313 ms   15.65 us/read =  4.7x
worker, 100 reads/message : 102 ms    5.10 us/read =  1.5x
empty worker round trip   : 101.20 us   <- the constant
```

**The 32× is a fixed ~101 µs per round trip, not a multiplier on the work.** It is entirely a
granularity artefact. At transaction granularity on the write path it is 3.4×; at 100 reads per
message it is 1.5×. What the worker actually costs is **+101 µs of latency on a single isolated
operation** — against a networked Postgres round trip, that is still a win, and against the current
architecture it is invisible.

**Ruling: build it.** CONTRACT §3 then survives for lock waits (L2 measured mid-wait abort at 204 ms
against a 200 ms target) and for scanning reads (L3 measured SAB-flag cancellation at +1 ms with the
main loop at 0.6 ms lag). **What the caller loses regardless:** cancellation becomes *cooperative and
plan-dependent*. A statement whose plan does not re-invoke `umbradb_guard()` — a single-row index
seek, `VACUUM INTO`, `backup()` — is uncancellable. The contract must therefore narrow from "the
in-flight cursor is freed" to "cancellable at row granularity for scanning statements; not cancellable
for single-row seeks, backup, or VACUUM", and it must name which. That is narrower than today's
protocol-level cancel, which kills anything.

**Two things the worker buys that nobody counted.** (i) It converts L1's "adapter-enforced"
`TRANSACTION_KEY_REUSE` guard into a **process-boundary-enforced** one: the caller holds no
`DatabaseSync` handle at all, so the per-transaction write-set cannot be bypassed by issuing an extra
statement, which is exactly how L1's E9a forgery defeats the SQL-derived substitute. That materially
shrinks the sprint's one named "unavoidable strict weakening". (ii) It removes L5's worst operational
number: `VACUUM INTO` blocking the JS thread for 0 event-loop ticks over 2.26 s (extrapolated to ~11
minutes frozen at 400 GB) becomes 11 minutes of a *worker* being busy.

**If the worker is rejected**, retract §3's long-read clause explicitly and in the release notes.
L3 is right that the worst outcome is letting it rot into an untested promise.

### 2.5 Adjudication 4 — out-of-cache exposure (I defer the ruling; here is the cost view)

Exposure is **confined to the archive tier**, and my sequencing recommendation removes the archive
from the pre-tag critical path, so this experiment does not gate 1.0.0. The wallet tier is bounded by
`SaveCheckpointOptions.chunkSize` and by wallet-scale data; no wallet-tier conclusion in any lane
depends on multi-hundred-GB B-tree behaviour.

**The experiment that closes it, costed:** a store 3–4× the box's RAM (≥200 GB) with random 32-byte
keys, on **real block storage, not a WSL2 VHDX**, cache-dropped between passes, measuring insert rate
and point-read latency at 25/50/100/200 GB. It closes L5's §5.1 *and* §5.2 (the 11 µs/commit fsync
that makes the `NORMAL`-vs-`FULL` 27× lever unquotable) *and* L6's §5.1 power-loss gap in one rig.
Budget: a machine with ~500 GB of free disk plus ~2 engineer-days. It is cheap; it is simply not
doable on this host, and no lane should be criticised for not doing it.

### 2.6 Adjudication 5 — the honest not-closeable list

I confirm two items, **shrink four**, and **add three**. The list is genuinely much shorter than the
sprint's volume suggests, and that survives testing.

**Shrunk from "not closeable" to "expensive" or "conditional":**

| Item | Why it moves |
|---|---|
| **In-process cancellation of a long read** (L2 B1, L3 B1, L6 B1) | Closeable via the worker at a **now-measured** 3.4× write / 1.5× batched-read cost, not 32×. §2.4. Residual: cooperative and plan-dependent. |
| **`auto_vacuum` cannot be retrofitted** (L5 B6) | True, but it is a one-way decision at file creation, and **no SQLite file exists**. Costs one line in migration 000. Only "not closeable" for a database that already exists — there is none. |
| **No partition elimination / no cheap bulk drop** (L5 B1) | Conditional on bulk pruning being a requirement. L5 §5.5 states nothing prunes today, `blocks.status='pruned'` is written by nothing, and the design doc says `chain_blobs` rows are "never pruned". **The condition is currently false.** Do not build table-per-range. |
| **No `sqlite3_blob_open`** (L5 §3.5, L3 §5.4) | Confirmed absent. Severity is low: L5 measured the real blob distribution as p50 6 KB / p99 29 KB / max 145 KB. It hardens `CEILINGS.md` SC-3, which is *already* a deferred ceiling under Postgres. Not a new obligation. |

**Confirmed not closeable (2):**

1. **No unforgeable transaction identity** (L1 B4). `txid_current()` has no substitute;
   `TRANSACTION_KEY_REUSE` degrades to adapter-enforced. **Mitigated, not removed**, by the worker
   boundary (§2.4) and by the fact that on the event-log schema the guard is largely redundant with
   the strict-clock trigger — but L1 is right that adopting the monotone clock re-opens it.
2. **`backup()` accepts an `AbortSignal` and ignores it** (L5 §3.8). A driver defect, not a design
   gap. Costs one documented exception in CONTRACT §3. Low consequence.

**Added — items the brief's candidate list did not name, in descending consequence:**

3. **`node:sqlite` is an unpinnable, gate-invisible, experimental platform API** (L6 B10). This is the
   only item on the list that engineering cannot shrink, and it is the one with real product
   consequence: it is invisible to `package-lock.json`, to `docs/supply-chain/inventory.md`, and to
   `supply-chain.yml`; it emits **no `ExperimentalWarning` at all** on v24.18.0 (L6 verified with a
   `process.on("warning")` probe); and a Node patch bump silently changes the bundled SQLite version
   under a frozen contract. **My ruling on the three postures L6 offers: take (a), keep `engines:
   >=24`, but only with the blunt `STABILITY.md` section L6 specifies *and* the CI assertion that the
   runtime's `sqlite_version()` matches a recorded value.** Raising the floor to `>=25.7` buys RC
   status at the price of dropping the LTS line, which for a wallet-client library is a worse trade;
   L6's option (c) — holding the storage engine outside the frozen surface — defeats the point of the
   sprint. I disagree with L6's own preference here, and I would flag that `better-sqlite3` remains a
   live fallback whose only real cost (a native prebuild) is one the project's own gate can at least
   *see*.
4. **No fault-injection VFS** (L6 §5.4). `node:sqlite` exposes no VFS hook, so `SQLITE_IOERR_*` and
   `SQLITE_FULL` — the codes on which `LEASE_FAULT` and the repurposed `CONNECTION_ERROR` would live —
   become reachable-in-principle and untestable-in-practice. This is a genuine, permanent test-coverage
   loss and exactly the class of thing a green gate hides.
5. **No PITR, and the at-rest encryption menu narrows to one item** (L6 B7, B8). Point-in-time
   recovery becomes a deployer capability that UmbraDB cannot provide. `SECURITY.md:117-127` currently
   offers "encrypt the volume, **or** use Postgres TDE, **or** …"; TDE must be struck, leaving
   filesystem/volume encryption as the only no-code mitigation on a **binding** precondition.

**Five items. Only #3 changes a product decision.**

### 2.7 Adjudications 6 and 7 — the clock, and mechanism change (I defer; cost view only)

**On the clock (6):** I defer the ruling on whether a `written_at` that can run seconds ahead of wall
clock is acceptable to the correctness seat. My contribution is one fact that bounds the risk: the hot
write path is `saveAndAdvance`, and `src/postgres/save-and-advance.ts:66-70` composes
**CheckpointStore + Watermarks only — it does not touch TemporalKV.** TemporalKV puts are per-key
wallet state, not a burst workload, and L1 measured **0 ms drift at every rate up to 1,000 puts/s/key**;
drift appears only at 10,000/s and unthrottled. So the burst case is not evidenced to exist.
**Take the monotone clock, and ship a drift diagnostic so the burst case is observed rather than
assumed.** Pricing the alternative, per the brief: changing the frozen `writtenAt: Date` to carry
microseconds is free pre-tag *as a SemVer matter* but is **worse on the merits**, because L1's E9c
shows sub-millisecond precision is destroyed on the JS `Date` boundary anyway and it would break the
`getAt({at: writtenAt})` round-trip that the millisecond truncation exists to protect. Do not do it.

**On mechanism change (7):** the ruling on what a reviewer is owed belongs to the promises seat. My
cost view: L6 §3.14's four deliverables (rewritten refinement register; P1–P10 **re-executed**, not
amended; new P11–P13; an explicit statement that C2a's and L1's named mechanisms no longer exist) are
**on the critical path, not optional**, at 3–5 d + 5–8 d. And `docs/recovery/EVIDENCE.md`'s binding
rule 1 forces re-execution — which is the same fact that drives §2.2's sequencing constraint. These
are not two findings; they are one.

---

## 2.8 The sequencing plan

**Resolved first, because it is free and it unlocks the rest: two database files, not one.** L5 and
L7 contradict each other, and the deciding facts are in the code, not in either report. I verified:
`PgChainArchiveStore`'s constructor defaults to `schema = "chain_archive"`
(`src/postgres/chain-archive-store.ts:120-123`); the archive lineage runs `000_schema` a **second
time** against that schema, giving it **its own `_migrations` table**
(`migrations/chain_archive/index.ts`); and `001_chain_archive_core.ts:717-729` creates the archive's
**own local `watermarks` table**, with a comment explicitly recording that reuse of
`tier1_wallet.watermarks` was rejected by an audit. **There is no cross-tier transaction anywhere.**
Therefore L2's B3 constraint ("everything `saveAndAdvance` touches in one file") is satisfied by the
wallet file alone, L5's stated reason for one file (cross-file atomicity, B2) does not apply, and
L7's D1 two-file split is correct and free — buying per-tier pragmas, per-tier durability
(`FULL` wallet / `NORMAL` archive), per-tier backup policy, and independent write locks so a
1 GB/hour ingest cannot serialise against wallet sync (L2 exp 11B: separate files, separate locks).

**And the second free move: the chain archive is not on the critical path.** Verified:
`001_chain_archive_core.ts:86` — *"**Not wired into any runner path that would execute it.**"*
`chainArchiveMigrations` is imported by nothing that calls `runMigrations`. `STABILITY.md:8-14`
excludes "the deferred full-chain-archival track" from the frozen surface. No archive data exists.
**L5's 4–6 engineer-weeks is speculative work on an unshipped design, and it carries every one of the
sprint's weakest measurements (§2.3).** Port it after the tag, when it is actually wired and when
L7 §5.4's unanswered question — does anything read the archive concurrently with ingest? — has an
answer, because L7 is right that that question "matters more than any pragma".

**Phase 0 — decisions (3–5 d, strictly serial, before any code).** These exist because §2.1 showed
the lanes did not compose.
- **D1 Driver + topology.** `node:sqlite` vs `better-sqlite3`; worker thread vs in-process. Gates
  L2's entire lease design, L6's CONTRACT §3 text, the `engines` floor, and the supply-chain
  inventory. **The one decision everything hangs on, and two lanes assumed opposite answers.**
  Recommended: `node:sqlite` + worker + transaction-granular RPC (§2.4), + L6's `STABILITY.md`
  carve-out and `sqlite_version()` CI assertion (§2.6 #3).
- **D2 Two files.** Resolved above.
- **D3 Archive deferred.** Resolved above.
- **D4 Wait policy.** `busy_timeout=0` + JS poll (L2's finding, L2's *rationale* re-derived for the
  worker per §2.1) + L7's bounded jittered retry classifier on the masked primary result code. Rejects
  L6's 30 s and L7's 60 s as imported from multi-process daemons.
- **D5 Error taxonomy**, decided once and up front — L7's B8 lesson is that discovering it inside
  `translateSqliteError` cost LND a P0. Additive `DATABASE_UNAVAILABLE` / `DISK_FULL` /
  `DATABASE_CORRUPT`, a home for `SQLITE_BUSY`, and `UNRECOGNIZED_POSTGRES_ERROR` renamed. All free
  pre-tag.
- **D6 TemporalKV encoding**: L1's event-log (recommended — 1.69× vs the transliteration's 1441× and
  quadratic) vs the interval table. Gates all `001` DDL.

**Phase 1 — foundation (10–14 d + 7–10 d, strictly serial, no useful fan-out).** Shim + `normalize()`
+ the origin-metadata decoder registry (the L3↔L4 handshake) + worker host + SAB cancel + guard UDF +
**the transaction-as-program RPC L3 did not build**; then the migration framework port, the rewritten
durability probe, and the prefix layer. **This is the hard bottleneck**: everything else compiles
against it, and a third engineer adds nothing here.

**Phase 2 — schema and adapters (parallel, three tracks).**
- 2a **TemporalKV** (L1): `001` DDL + triggers + monotone clock + drift diagnostic + adapter write-set
  guard + retention floor. *Consumes L4's prefix layer, including trigger names — L1's DDL is written
  unprefixed and must be regenerated through it.*
- 2b **Concurrency** (L2): lease sidecar files, write queue, `SAVEPOINT` reentrancy, sticky poison
  emulation, migration lock, filesystem advisory-lock startup probe. *Its `BEGIN IMMEDIATE` guarantee
  is a precondition for 2a's TOCTOU result (L1 E3) and for C2a (L5 B5) — so the `BEGIN IMMEDIATE` +
  write-queue piece lands in Phase 1, and only the lease is Phase 2.*
- 2c **Types and queries** (L4): `000`/`002`–`006` STRICT DDL, junction table, `listKeys` range scan,
  batch rework, `checkpoint-store` bulk path. *L4 explicitly excludes `001`, so 2a and 2c do not
  collide.*

**Phase 3 — contracts, tests, evidence (mostly parallel with Phase 2).** Test-fixture rebuild, P1–P10
port, new P11–P13, crash harness, error translation, CONTRACT §1/§3/§6, `SECURITY.md`,
`STABILITY.md`, supply-chain inventory, refinement register, `src/postgres/` deletion and the `Pg*`
rename, `bench/` re-baseline (G14 requires the artefact).

**Phase 4 — the tag (serial, and the reason for everything above).** Local sync end-to-end **on
SQLite**, `docs/recovery/EVIDENCE.md` re-executed against the new RC, R1–R12, tag 1.0.0.

**Phase 5 — post-tag, off the critical path.** Chain archive port; partitioning only if bulk pruning
becomes a real requirement; ETL sorted staging only if the write-side slope is measured to matter.

**Strictly serial:** Phase 0 → Phase 1 → Phase 2 → Phase 4. **Parallelisable:** Phase 2's three
tracks and most of Phase 3. **Maximum useful team size: two engineers**, three during Phase 2 only.

**Migration of existing user data — the question no lane owned.** There is nothing to migrate, and I
checked rather than assumed: `README.md` says *"Not published to npm yet"* and documents installation
as `npm install github:CharlesHoskinson/UmbraDB#v0.9.5`; no `node_modules/umbradb` exists anywhere in
this environment outside the repo's own worktrees; `docker ps -a` shows **no Postgres container at
all**, running or stopped; and the archive lineage has never been executed. The only at-risk data is
the owner's own local-sync state, which (a) does not exist yet and (b) is derivable from chain by
re-syncing. **The cost of the absence of an export/import path is zero today and becomes non-zero the
moment the local-sync run produces the 1.0.0 evidence database — which is the third independent reason
to sequence the migration ahead of that run.** If a path is ever needed, build a one-shot
`pg_dump`-to-SQLite loader *outside* the frozen surface (a few days) and do not promise it: L7's
evidence is that CLN and LND both refuse to support cross-engine migration outright, and Bitcoin Core
paid five years. The one honest caveat to document: checkpoints, watermarks and the archive are
re-derivable from chain; **`TemporalKV` history is not**. That asymmetry belongs in the contract.

---

## 2.9 A defensible cost number

Naive sum of the lane estimates is ~110–160 engineer-days plus L3's untimed 900–1,100 lines. **Do not
use it.** The double-counting I found:

| Overlap | Appears in | Counted once as |
|---|---|---|
| Driver shim / seam | L3 (250 lines) + *assumed* by L2, L4, L6 | L3 |
| Error translation | L3 (~200 lines, "L6 owns") + L2 (1 d) + L4 (§3.8) + L6 (5–7 d) | L6 |
| Migration lineage DDL | L4 (3–4 d, "7 migrations") + L6 (5–8 d, "000–006") + L1 (3 d, kv_event) | ~6–9 d total, not 11–15 |
| Migration framework / lock | L6 (3–4 d) + L2 (1–2 d) | ~1 d overlap |
| Test-fixture + P1–P10 port | L6 (8–12 + 5–8) + L4 (3–5) + L1 (3) + L2 (4–5) | ~12–18 d total, not 20–30 |
| Contract/doc rewrites | L6 (~11–14 d) + L2 (1–2) + L1 (2) | ~2–3 d overlap |
| Batch-constant / bulk-insert rework | L3 B5 + L4 B5 + L5 B4 | 1–2 d |
| `BEGIN IMMEDIATE` / write queue | L2's design, *assumed* by L1, L4, L5 | L2 |

And work **nobody billed**: resolving the two unresolved lane conflicts (3–5 d); the
transaction-as-program worker RPC that §2.4 shows is required to make the worker affordable and which
L3 explicitly did not build (3–5 d); `src/postgres/` deletion and the `Pg*` barrel rename (2–3 d).

**Pre-1.0.0 critical path, wallet tier, archive deferred:**

| Block | Days |
|---|---|
| Phase 0 decisions + closing the two cross-lane conflicts | 3–5 |
| Shim + decoder + normalize + worker host + transaction-granular RPC | 10–14 |
| Migration framework + durability probe + bootstrap + prefix layer | 7–10 |
| Migration lineage `000`/`002`–`006` DDL | 8–11 |
| TemporalKV: DDL, triggers, monotone clock, adapter guard, retention floor | 12–16 |
| Concurrency: lease sidecars, write queue, `SAVEPOINT`, poison emulation, FS probe | 9–12 |
| TransactionHistory junction + `listKeys` + batch rework + checkpoint bulk path | 8–11 |
| Error translation + catalog decisions + drift test | 6–8 |
| Test harness rebuild + P1–P10 port + P11–P13 (all lanes merged) | 14–20 |
| Contract / security / stability / supply-chain / refinement-register rewrites | 12–16 |
| `src/postgres/` deletion + `Pg*` rename + barrel | 2–3 |
| `bench/` re-baseline (G14) | 3–5 |
| **Total** | **94–131 engineer-days** |

**≈19–26 engineer-weeks. ~2.5–3.5 calendar months for two engineers** (Phase 1 is serial; a third
adds little before Phase 2). **Deferred past the tag: 20–30 d** for the archive.

Sanity check against the real denominator, measured independently: `src/postgres/` is **5,364 LOC
across 24 files**, `test/postgres/` is **9,024 LOC across 39 files**, `src/` total is 7,303 LOC, docs
are 7,106 LOC. Roughly 5.4k LOC of adapter replaced and 9k LOC of Postgres-bound tests rewritten, at
~100 net LOC/day including tests, contracts and review, lands in the same place.

**Assumptions that drive it:** archive deferred; worker chosen; L1's event-log encoding chosen; no
user-data migration path built; two engineers.

**What makes it the high end (131+ days):**
- The archive is required pre-tag: **+20–30 d**, and it brings the sprint's weakest evidence with it.
- The driver posture flips to `better-sqlite3` *after* the shim is built against `node:sqlite`'s
  `columns()` behaviour — decoder and supply-chain rework, **+5–8 d**.
- The fault-injection gap (§2.6 #4) is judged unacceptable and a FUSE/`dm-error` harness is built —
  unestimated by any lane, **+8–15 d** by my estimate.
- `synchronous=FULL` at 523 commits/s proves too slow for the real wallet-sync rate, forcing a
  power-loss rig to justify `NORMAL` (L6 §5.1) — **+3–5 d plus hardware**.
- The out-of-cache experiment is run, and the answer is bad, forcing an archive redesign.

---

## 3. Evidence

**What I re-tested myself** (commands and verbatim output):

```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-l6-contracts && git rev-parse HEAD'
3c0c68b3d0397ee2e8344b77e9ed715132fef6ca
$ grep -n "NOT yet in force" docs/STABILITY.md
46:**Current version: `0.9.5` — the commitments above are NOT yet in force.**
$ git tag
v0.9.5                                  # no v1.0.0
$ grep -n '"version"' package.json
3:  "version": "0.9.5",
```

```
$ ls -la /root/midnight-testnet/indexer-data/ledger-db.sqlite
-rw-r--r-- 1 root root 53530624 Jul 22 14:41 ledger-db.sqlite
$ node -e '...pragma page_count/page_size/journal_mode...'
{ page_count: 13069 } { page_size: 4096 } { journal_mode: 'delete' }
```

```
$ ls -d /root/*/node_modules/umbradb          # (none)
$ grep -rl '"umbradb"' /root/*/package.json   # only the repo's own worktrees
$ docker ps -a --format '{{.Names}}\t{{.Image}}'
midnight-indexer-preprod   midnightntwrk/indexer-standalone:4.3.3   Exited (1) 7 days ago
midnight-proof-server-preprod  midnightntwrk/proof-server:8.1.0     Exited (0) 6 days ago
                                              # no Postgres container at all
```

```
$ grep -n "constructor" -A 4 src/postgres/chain-archive-store.ts
120:  constructor(
121-    private readonly sql: UmbraDBSql,
122-    private readonly schema: string = "chain_archive",
$ grep -n "watermarks" src/postgres/migrations/chain_archive/001_chain_archive_core.ts
717:  // watermarks — chain_archive's OWN local watermark-equivalent table, NOT a reuse of
729:    CREATE TABLE ${sql(schema)}.watermarks (
$ grep -n "Not wired into any runner path" src/postgres/migrations/chain_archive/001_chain_archive_core.ts
86: * **Not wired into any runner path that would execute it.**
```

```
$ find src/postgres -name '*.ts' | xargs wc -l | tail -1      #  5364 total (24 files)
$ find test/postgres -name '*.ts' | xargs wc -l | tail -1     #  9024 total (39 files)
$ find src -name '*.ts' | xargs wc -l | tail -1               #  7303 total
$ find docs Formal -name '*.md' | xargs wc -l | tail -1       #  7106 total
```

Worker-RPC benchmark: scripts at `/tmp/fx/worker.mjs`, `/tmp/fx/bench.mjs`, `/tmp/fx/worker2.mjs`,
`/tmp/fx/bench2.mjs`; output quoted verbatim in §2.4. Method: one `node:worker_threads` worker owning
one `DatabaseSync` (WAL, `synchronous=normal`), prepared-statement cache keyed by SQL text, main
thread awaiting a `postMessage` round trip. Write case: 400 transactions × 25 statements. Read case:
20,000 point reads against a 100,000-row table. **Caveat:** measured on an idle machine;
`postMessage` latency will degrade under main-thread load, and I did not model that. **What would have
to be true for this to be a wrong reading:** the RPC would have to be forced to statement granularity
by something structural — it is not, because UmbraDB's write paths are already whole transactions
(`saveAndAdvance`, `putBlockBundle`) and its read paths are already cursor-batched (`listKeys`).

**What I took on a lane's authority** (not re-tested): every SQLite capability probe (L1 E0, L2
exp 01–13, L3 §3.1–3.11, L4 §3.1–3.9, L5 §3.1–3.10, L6 §3.1–3.13); all throughput, GC-curve, rebuild
and durability numbers; L7's entire external survey and every quotation in it; L6's testcontainer
timings and the 0.29 ms / 52.8 ms fixture figures; L3's supply-chain refutation of the
`better-sqlite3` install-script hypothesis. Where I disagree with a lane, I disagree with its
*reasoning from* a measurement, never with the measurement.

---

## 4. What the sprint got wrong or missed

1. **Nobody owned composition.** Four cross-lane seams (§2.1), three of them contradictions, one
   closed by a lane on its own initiative. The brief's boundary rule ("stay in your lane; a flagged
   dependency is a finding") produced good lanes and no architecture. Phase 0 exists to pay this off.
2. **The archive's actual status was never checked.** Every lane treated the chain archive as a
   shipping obligation. It is design-stage, unwired into any runner path, outside the frozen surface,
   with no data — which removes L5's 4–6 weeks from the critical path and, with it, the sprint's
   weakest evidence.
3. **The one-file-vs-two-files question was answered by two lanes in opposite directions, and the
   deciding facts are three greps away** (separate schema, separate `_migrations`, separate
   `watermarks` table, no cross-tier transaction). §2.8.
4. **The 88 GB claim is load-bearing twice over and unreproduced twice over** — used as the scale
   evidence *and* as the reason not to measure out-of-cache behaviour. §2.3.
5. **The worker's cost was measured at the worst possible granularity and never re-measured**, which
   let three lanes conclude "cancellation is dead" against one lane's "closeable at 32×". It is
   closeable at 1.5–3.4×. §2.4.
6. **Nobody owned existing-data migration**, and it turns out to be the cheapest item in the whole
   program — but only until the local-sync evidence run creates the first real database.
7. **The most underweighted *loss* went unnamed**: today an idle-in-transaction session is bounded by
   `idle_in_transaction_session_timeout` on the *server*. Under SQLite an awaited callback inside
   `withTransaction` holds the **whole-database** write lock with no backstop of any kind (L2 exp 11D:
   another writer still `BUSY` 352 ms in), and `fn` is arbitrary caller code. Today that is a slow
   query; tomorrow it is a stalled database. L2 recorded the mechanism; nobody rated it.
8. **Nobody mentioned operability.** A Postgres deployment can be inspected from outside the process:
   `pg_stat_activity`, `EXPLAIN ANALYZE` against a live workload, `psql` on a wedged system. Under an
   embedded engine — and especially with the worker owning the only handle — there is no way to look
   at a running system from outside it. For a library whose canonical failure report is "the wallet is
   stuck", that is a real regression and it should be answered deliberately (a diagnostic RPC on the
   worker; `PRAGMA integrity_check`, `wal_checkpoint` and prepared-statement stats exposed as a
   support surface).
9. **`STABILITY.md`'s own sentence was not confronted**: *"the surface at 1.0.0 is expected to be
   identical"* to 0.9.5. That expectation is falsified by this migration, and the honest handling is a
   retraction paragraph, not silence. §2.2.

---

## 5. Recommendation

1. **Go.** Approve the migration, wallet tier, starting now.
2. **Make Phase 0's six decisions in one sitting before any code** (§2.8). D1 (driver + worker) and D6
   (TemporalKV encoding) are the two that cannot be deferred; everything downstream branches on them.
3. **Two database files, wallet and archive. Defer the archive past the tag.** Both are free, both are
   established from the code, and together they remove the sprint's weakest evidence from the decision.
4. **Build the worker with a transaction-granular RPC.** It costs 1.5–3.4×, not 32×; it keeps
   CONTRACT §3 mostly intact; it makes the one named "unavoidable strict weakening" process-enforced;
   and it un-freezes the event loop during backup. If it is rejected, retract §3's long-read clause
   loudly.
5. **Land it before the local-sync evidence run**, not merely before the tag — otherwise
   `docs/recovery/EVIDENCE.md` and R1–R12 are paid for twice, and the first real Postgres database
   comes into existence at exactly the wrong moment.
6. **Get one number the sprint does not have: the remaining weeks of local-indexer catch-up.** It is
   the only input that decides whether this delays 1.0.0 at all. Everything else in the schedule is
   under the team's control; that is not.
7. **Budget 94–131 engineer-days pre-tag, two engineers, ~2.5–3.5 calendar months.** Do not fan out
   past two before Phase 2. Re-forecast at the end of Phase 1 — it is the serial bottleneck and the
   only phase whose slip cannot be absorbed.
8. **Decide the `node:sqlite` posture explicitly and write it down** (§2.6 #3). Keep `engines: >=24`,
   add the blunt `STABILITY.md` section, add the `sqlite_version()` CI assertion, and add the
   "platform-provided, unpinnable" section to `docs/supply-chain/inventory.md`. Delete the
   "zero runtime dependencies" line — `zod` remains and the claim was never true.
9. **Write the retraction paragraph in `STABILITY.md` now, not at tag time.** It is the cheapest
   credibility purchase available and it gets more expensive the longer the 0.9.5 expectation stands.

### Alternatives — flagged for the owner, not campaigned for

I accept the full-replacement scope decision and do not re-litigate it; L7's dual-backend evidence
(212 `cfg` sites across 41 files upstream, two drifted lineages, two drift-repair migrations, and
neither CLN nor LND able to migrate between their own backends) is strong and I would not hedge
against it.

But the evidence does *incidentally* argue for one narrower thing, which is what §2.8 recommends
anyway: **the strong evidence in this sprint is wallet-tier evidence, and the weak evidence is
archive-tier evidence.** Deferring the archive is not a dual-backend hedge — it stays SQLite-bound in
intent — it is declining to decide a question whose deciding inputs are not yet measurable. What would
have to be true for the archive to *not* end up on SQLite: it acquires a concurrent-analytical-reader-
during-ingest workload (L7's kupo #209 shape, and L7 §5.4 says this question "matters more than any
pragma" and could not be answered), or the deployment becomes genuinely I/O-bound with a working set
many times RAM. Neither is true today and neither was measured. What would have to be true for
"don't migrate at all" to win: a real consumer with a Postgres deployment appears before the tag, or
the owner values the server-side backstops and external observability (§4 items 7 and 8) above the
operational simplification. Neither is evidenced. **I flag both; I recommend neither.**
