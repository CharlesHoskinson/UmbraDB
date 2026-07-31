# Council seat: contradiction and dependency

Seat id `contradiction`. All seven reports read in full, plus `corpus/00-BRIEF.md` and
`COUNCIL-BRIEF.md`. Re-tests run on Node **v24.18.0** / `node:sqlite` / SQLite **3.53.1** in WSL;
scripts in `/root/council-contradiction/` (`x1.mjs`, `x2.mjs`, `x3.mjs`, `x4-worker.mjs`), commands
and verbatim output in §3.

---

## 1. Verdict

**The sprint's conclusions survive; a material fraction of its *numbers* and three of its *design
sketches* do not.** The single largest defect is not a disagreement between lanes at all — it is that
**every benchmark in L5 was written to `/tmp`, which is `tmpfs` on this host**, a trap L6 found and
corrected mid-run and L5 never learned about. I reproduced L5's own durability harness on both
filesystems: `WAL/FULL` gives **93,386 commits/s on tmpfs and 345 commits/s on ext4** — a 271×
divergence that explains the entire L5-vs-L6 disagreement on the `synchronous` lever, and that
invalidates L5's pragma matrix (runs A–O), its journal-mode and `page_size` and `cache_size`
comparisons, and its blob in-DB-vs-files crossover. L5's *verdict* (the archive fits, throughput is
not the problem) still holds, because L6 independently measured 136 MB/s of ingest on ext4 — but it
holds on L6's number, not L5's.

**Second: three lanes wrote a bootstrap pragma block, and the two that matter are mutually
incompatible in a way that is irreversible after the first write.** `page_size` and `auto_vacuum`
are silently ignored if `journal_mode=WAL` runs first (measured, §3.G). L5's order is correct; L6's
`createClient` block — the one that actually owns connection setup — puts WAL first and never sets
either, permanently pinning a 300 GB archive to 4 KiB pages and `auto_vacuum=0`.

**Third: L3's fix for its own silent-corruption trap re-creates that trap one layer down.** L3
mandates `normalize(): Date → ISO-8601 text` to close B6 (`Date` bound positionally becomes NULL).
Against L1's `written_at INTEGER` event log, an ISO-text bind makes `getAt({at})` return **the wrong
version, silently** — because in SQLite's type ordering every INTEGER sorts before every TEXT, so
`written_at <= '1970-...'` is true for every row (measured, §3.B). That is the same law, **T3**, that
L3's B6 was written to protect. L4's `STRICT` is what converts this from a silent wrong answer into a
loud `errcode 3091` — an argument for `STRICT` that neither L3 nor L4 made.

Beyond those, the highest-value contradiction class is exactly where the brief predicted: **L7 against
the six internal lanes.** L7 corrects nobody on precedent and is corrected on two mechanisms — its
headline schema recommendation (D5, "move content-addressing off the primary key") is a **no-op in
SQLite**, measured byte-identical, because a non-INTEGER `PRIMARY KEY` on a rowid table is already a
secondary index; and its `busy_timeout = 60000` would reproduce the deadlock L2 measured, **even
inside L3's worker thread** (measured, §3.W). But L7 is right, and two internal lanes are wrong, on
the backup primitive and on the file-layout question.

---

## 2. Adjudications

### 2.0 The contradiction register, ranked by whether it changes an engineering decision

| # | Conflict | Who is right | Decision it changes |
|---|---|---|---|
| **C1** | L5 measured on tmpfs; L6 on ext4 | **L6**, measured | `synchronous` default; every pragma in L5 §3.3 |
| **C2** | `backup()` vs `VACUUM INTO` for G4 §6 | **L5** (+ L7), measured | the backup mechanism in a frozen contract rewrite |
| **C3** | L3 `Date → ISO text` vs L1 `written_at INTEGER` | **neither as written**; fix is epoch-ms + `STRICT` | the shim's `normalize()`; T3 correctness |
| **C4** | L3 declared-type decoder vs L4 `STRICT` | **L4**, with a hole L4 missed | the DDL convention and the decoder key |
| **C5** | One file (L5) vs two files (L7, L2, L4-(b)) | **two files**; repo facts settle it | archive/wallet durability, backup, lock contention |
| **C6** | L7 D5 "hash off the PK" | **no-op**, measured | deletes an "M–L plus a data migration" cost item |
| **C7** | `busy_timeout` = 0 / 30000 / 60000 | **L2 (0)**, and it survives the worker | every connection; P10 |
| **C8** | `ADD COLUMN … STORED` "refused outright" (L4) | **L6** (works at 0 rows), measured | collapses L4's B1 and its pre-tag argument |
| **C9** | Bootstrap pragma *order* | **L5's order**, L6's block is wrong | irreversible at file creation |
| **C10** | L1's adapter-side key-reuse guard vs L2's sticky poison | **gap neither closed**, measured | ~20-line emulation must widen |
| C11 | L5: "better-sqlite3 exposes incremental BLOB I/O" | **false**, measured | removes an argument for switching driver |
| C12 | L3 picks `node:sqlite`; L6 B10 undercuts it | **unresolved**; L3 lacked the fact | the driver decision itself |
| C13 | `json_each` vs prepared loop for the junction | **both**, for different tables | L4 answered about the wrong junction |
| C14 | L7: `SQLITE_BUSY` has no home in G3 | **L2/L6**, *conditional* on `BEGIN IMMEDIATE` | whether a new error code is needed |
| C15 | `octet_length` (L4) vs `length` (L5 DDL) | **L4** | one word in shipped DDL |
| C16 | `page_size` 16384 / 4096-assumed / 32768 | **unmeasurable now** (C1) — must be re-run | irreversible at file creation |
| C17 | `synchronous=NORMAL` is contract-legal (L6) | argument stands; **stakes are 137×, not 27×** | the durability default |
| C18 | `DEFAULT_SCHEMA` "no break" (L4) vs "no analogue" (L5/L6) | **scope confusion, not a conflict** | resolution changes under C5 |

The ten Tier-1 items are worked below. Tier-2 items are covered in §2.9.

---

### 2.1 C1 — L5's benchmarks ran on a RAM disk. This is the sprint's largest measurement defect.

L6 §3 opens with: *"Environment caveat found and corrected mid-run: `/tmp` on this host is `tmpfs`,
so every durability number measured there would have been meaningless."* L6 moved to `/root/l6-bench`
(ext4). **L5 did not get that relay.** Every L5 script defaults to a `/tmp/l5/...` directory
(`ingest.mjs:9 dir: "/tmp/l5/run"`, `fsync.mjs:7 "/tmp/l5/fsync"`, `scale.mjs:7 "/tmp/l5/scale"`),
while L5's environment header claims *"ext4 on a VHDX (`dd` direct write 976 MB/s)"* — which describes
`/root`, not `/tmp`.

I ran L5's own `fsync.mjs` shape on both filesystems (§3.H):

| | WAL/NORMAL | WAL/FULL | DELETE/FULL |
|---|---|---|---|
| `/tmp` (tmpfs) | 115,225 c/s | **93,386 c/s** (11 µs) | 21,644 c/s |
| `/root` (ext4) | 47,263 c/s | **345 c/s** (2,895 µs) | 173 c/s |

The tmpfs column reproduces L5's published `WAL/FULL 88,485` and its own §5.2 caveat number
("11 µs per commit"). The ext4 column sits in L6's family (523 c/s). **L5 diagnosed the symptom and
mis-attributed the cause** — it blamed "ext4 on a WSL2 VHDX" and concluded the durability knob's
*magnitude* was untrustworthy while treating everything else as sound. The actual cause was a RAM
disk, and it does not merely soften the durability number, it inverts it: L5 reports
*"journal mode matters ~6×, `synchronous` ~12%"*; on real storage `synchronous` NORMAL→FULL is
**137×** and journal mode at FULL is 2×.

**What survives.** L5's b-tree/GC/plan-shape results are CPU-bound and largely survive: the GC curve
(§3.8), `EXPLAIN QUERY PLAN` findings, the compile-time limits, the `UNION ALL` no-elimination result,
the cross-ATTACH torn-commit result (that one used SIGKILL and `synchronous=FULL`; on tmpfs a torn
commit is *easier* to produce, so the negative finding is if anything strengthened), and the
`DROP TABLE` 35 ms vs `DELETE` 1,296 ms ratio.

**What does not survive and must be re-run on ext4 before anything is decided on it:** ingest matrix
runs **A–O** (including the headline 203 MB/s / 417 MB/s and the 660–730× headroom), `fsync.mjs`
entirely, the `page_size` sweep (E/F/G and `blobs2.mjs`), the `cache_size` runs (H/I — "2 GB of page
cache is worse than 2 MB" is not a meaningful statement on a RAM disk), the in-DB-vs-external-files
blob crossover (§3.5), and the `VACUUM`/`backup` throughput figures.

**Does the lane's verdict survive? Yes.** L6 measured 136 MB/s ingest on ext4 (`l6-exp14-rebuild.mjs`,
1 M × 4 KB rows in 34.7 s) — 1.5× below L5's tmpfs 203 MB/s, still ~490× the stated 0.28 MB/s
requirement. **Report the headroom as L6's number, not L5's**, and strike the pragma matrix.

This is the second confident-positive in this lane to fail checking, after the 88 GB claim
(adjudication #2). That pattern is itself a finding: see §4.1.

### 2.2 C2 — `backup()` vs `VACUUM INTO`. L6 owns the contract text and has it backwards.

L6 §2 B7 calls `VACUUM INTO` *"a faithful `pg_dump --single-snapshot`"* and §4.5 writes it into the
rewritten CONTRACT §6 as **the** command, dismissing `backup()` because *"the online backup API
restarts if the source is written during the copy, which on a ~1 GB/hour ingest makes it a poor fit
for the archive."* L5 measured the opposite and recommends `backup()`. I re-ran both on a 691 MB
ext4 database with a writer racing the copy (§3.I):

```
VACUUM INTO : 2045 ms, event-loop ticks during = 0        <- thread frozen for the whole copy
backup()    : 2584 ms, ticks during = 1539, 169677 pages, 781 concurrent commits landed
api.db rows = 150780  integrity=ok      (source held 150000 at the moment of the call)
backup(signal aborted at 5ms) -> COMPLETED anyway: 169678
```

**L6's stated reason is factually wrong.** `backup()` did not restart, did not fail, and did not
degrade — it produced an integrity-clean copy of a *later* committed state while 781 transactions
committed underneath it. L5's measurement replicates exactly. L6's own §3.8 evidence block shows
`backup() -> 3156 pages` with no restart observed; the "restarts" claim is a citation dressed as a
finding, and it is the one load-bearing sentence behind L6's recommendation.

L7 supplies the outside confirmation from three independent projects: Core Lightning explicitly warns
that `.dump` and `VACUUM INTO` *"lock the main database for long time periods, which will negatively
affect your lightningd instance"*; **Bitcoin Core's `backupwallet` uses `sqlite3_backup_init` +
`sqlite3_backup_step(-1)`** — the online backup API — and no SQLite project in L7's survey uses
`VACUUM INTO` for live backup. Three independent lines (L5 measured, mine measured, L7's precedent)
against one lane's citation.

**Ruling: `backup()` is the default mechanism. `VACUUM INTO` is a compaction tool, documented as
uncancellable and event-loop-blocking.** At the archive's scale L6's own §3.9 makes this worse still:
a long-held read snapshot **completely blocks WAL checkpointing** while reporting `busy: 0`, so a
~15-minute `VACUUM INTO` of a 300 GB store freezes the process *and* grows the WAL by a full window
of ingest. Two honest caveats survive for the contract text, both L5's: `backup()` captures a state
**at or after** the call (so CONTRACT §6's "mid-GC dump is safe" must be re-justified as "any
committed state is closed under manifest→chunk", which is L6's proposed **P13** — keep P13), and
`backup()` **accepts an `AbortSignal` and ignores it**, which is a G4 §3 exception that must be
written down rather than discovered.

### 2.3 C3/C4 — the type boundary. L3's fix breaks T3; L4's fix has a hole; `STRICT` is what saves both.

This is the four-way interaction the brief asked about (L3↔L4 on `STRICT`, L1↔L3 on the clock), and
it resolves as one problem, not two.

**(a) L4's resolution of the `STRICT` conflict works — verified, including the case L4 did not test.**
L4 proposes keying the shim's decoder on `columns()` *origin* metadata rather than declared type
names. I stressed it past L4's fixture (§3.C): origin `table`/`column` survive **aliasing, JOIN, a
`FROM (subquery)`, a CTE, `UNION ALL`, and — the case that matters — a VIEW**:

```
VIEW : [{"n":"value","tbl":"kv_event","col":"value"},
        {"n":"valid_from","tbl":"kv_event","col":"written_at"},   <- origin survives the rename
        {"n":"valid_to","tbl":null,"col":null,"t":null}]          <- LEAD() is an expression
```

That matters because **L1's design sketch reads through exactly such a view** (`kv_validity`, the P5
diagnostic). So L4's registry works there. **The hole:** `valid_from` and `valid_to` are the same
logical type and decode differently — `valid_from` resolves to `kv_event.written_at` and becomes a
`Date`; `valid_to` is a window function, gets no origin, and falls through as a `bigint`. A row of
the P5 diagnostic view would carry `{valid_from: Date, valid_to: bigint}`. L4 argued this class was
harmless because "UmbraDB's computed columns are all plain numbers needing no decoding" — true of
today's Postgres queries, **false of L1's proposed view**, which L4 could not see. Fix: the registry
needs an explicit `(view, column) → decoder` entry, or derived temporal columns must be aliased to
their origin column. Cheap, but it is a silent-wrong-type bug if missed.

**(b) L3's `normalize()` is wrong against L1's schema, and it breaks the same law B6 protects.**
L3's rule is `Date → ISO-8601 text`. L1 stores `written_at INTEGER` (epoch ms) and reads
`WHERE written_at <= :T ORDER BY written_at DESC LIMIT 1`. Measured (§3.B):

```
getAt(at=2500) bound as INTEGER ms         : [{"version":2}]   <- correct
getAt(at="1970-01-01T00:00:02.500Z") as TEXT: [{"version":3}]   <- WRONG
raw: (3000 <= <iso text>) -> {"c":1}   (SQLite: every INTEGER sorts before every TEXT)
```

`getAt` returns the **latest** version for every `at`, always, with no error. That is
**T3 — temporal projection / observational equivalence**, a Lean-mechanised cut-line law, silently
false. It is the identical failure class as L3's own B6 (`Date` → NULL, which I also re-confirmed:
`{"x":null,"t":"null"}`), reintroduced by L3's remedy for B6. L3's B6 write-up says the shim "closes
it once, versus finding every `Date` bind by hand" — it does, and then opens a second one, once,
everywhere.

**(c) `STRICT` is the mechanism that makes this loud.** Measured (§3.B2):

```
STRICT  : errcode 3091 "cannot store TEXT value in INTEGER column s.written_at"   <- LOUD
non-STRICT: stored {"w":"1970-01-01T00:00:01.000Z","t":"text"}                    <- SILENT
```

**Ruling.** Adopt L4's `STRICT` (this is now a correctness argument, not a hygiene one), adopt L4's
origin-keyed decoder *with* an explicit entry for derived view columns, and **change L3's
`normalize()` from `Date → ISO-8601 text` to `Date → epoch-ms integer`**, matching L1's and L4's DDL,
which both already store `INTEGER` timestamps. A single conformance property — "every `TIMESTAMPTZ`-
class column is `INTEGER` and every `Date` bind arrives as a number" — pins it. Note L7 reaches the
same destination by an independent route (B6: a column declared `BYTEA` gets NUMERIC affinity and
stored the string `"42"` as an integer), so **two lanes independently contradict L3's "decisive
discovery"**, on two different mechanisms.

**(d) The clock, resolved narrowly.** I checked the frozen interface rather than reasoning about it.
`src/interfaces/temporal-kv.ts:179-181` types `AsOf` as `{kind:"at"; at: Date}` with no bound, and
`src/postgres/temporal-kv.ts:206-210` validates only `instanceof Date && !Number.isNaN(...)`. **There
is no future-date rejection**, so my prior hypothesis — that L1's drifted `writtenAt` would be
rejected when fed back into `getAt` — is **wrong, and I record it as refuted.** The round trip
`getAt({at: writtenAt})` survives the monotone clock. What does not survive is
`getAt({at: new Date()})`: after L1's measured ~1.8 s burst drift, a caller asking "as of now" gets a
version **older** than its own last write, with no error. That is a read-your-own-writes violation
against wall-clock `at`, not against the store's own coordinate. The interface's own doc comment
(`:174-177`) already says `at` addresses *"the successfully persisted `writtenAt` coordinate… not a
true transaction commit or visibility timestamp"* — so L1's clock keeps that sentence true while
falsifying the next clause, *"the coordinate is `clock_timestamp()` at statement/trigger execution"*.
That is a documented-semantics change on a frozen interface, and the honest mitigation is the one L1
did not name: **the adapter should clamp `getAt({at})` reads against the store's own max
`written_at`, or the docs must say plainly that `writtenAt` may lead wall time.** I defer the
accept/reject call on the drift itself to the seat that owns the temporal contract; my finding is
only that the drift is *invisible* to the type system and to the existing validation.

### 2.4 C5 — one file or two. L5's "one database file" is over-constrained, and the repo settles it.

Four lanes hold three positions:

- **L5 §4:** *"One database file. Not per-tier, not per-height-range."* Justification: *"B2 and L2's
  constraint make any second file a place where atomicity silently disappears."*
- **L2 B3:** *"everything `saveAndAdvance` touches must live in one database file"* — and, in the same
  blocker, *"the ~1 GB/hour chain-archive ingest and the wallet-sync writer **cannot share one file**
  without serialising against each other. Separate files give independent write locks."*
- **L7 D1:** two files, *"the single most important structural decision"*, with different durability
  and backup policies per tier, flagging to L5: *"confirm that no chain-archive write shares a
  transaction with a wallet-tier write."* L5 never answered that question; it asserted one file.
- **L4 B2:** option (b) one-file-per-*lineage* is *"tempting and does give genuine isolation… only
  works if each lineage is one file — coincidentally true today."*

**L5 generalised L2's constraint from "one transaction must not span files" to "the product must have
one file."** Those are different statements, and the repo decides which applies. I checked
`origin/main`:

- `src/postgres/chain-archive-store.ts:122` — `private readonly schema: string = "chain_archive"`,
  a **separate schema** from `DEFAULT_SCHEMA = "umbradb"` (`client.ts:14`).
- `src/postgres/migrations/chain_archive/001_chain_archive_core.ts:717-729` — the chain archive has
  its **own** `watermarks` table, and the comment says so explicitly: *"chain_archive's OWN local
  watermark-equivalent table, **NOT** a reuse of `tier1_wallet.watermarks` (§5 of the audit)"*, with
  the original shared-table design recorded as rejected.

So the tiers were *deliberately engineered* not to share a table, and no transaction spans them. L5's
"free win" of folding `setWatermark` into `putBlockBundle`'s transaction (`sync-service.ts:169`) is
an *intra-archive* fold and stays inside one file. **The premise of L5's one-file rule is not met.**

**Ruling: two files** — `umbra.sqlite` (tier-1 wallet) and `umbra-archive.sqlite`. L2's constraint is
satisfied (`saveAndAdvance` is entirely tier-1), L2's B3 write-lock argument is *satisfied only this
way*, L4's option (b) becomes available with no cross-file FK (every FK is intra-lineage), L7's
precedent (Bitcoin Core `doc/files.md`, Zcash `WalletDb`/`BlockDb`, the Midnight indexer's own
`indexer.sqlite`/`ledger-db.sqlite`) all point here, and it is what makes the divergent
`synchronous`/`page_size` policies of C1/C16 expressible at all. It also gives `DEFAULT_SCHEMA` a
natural mapping (§2.9, C18) and makes the archive independently re-ingestible, which is the whole
basis of L7's "derivable from chain" escape hatch.

The cost is real and must be stated: **a cross-tier transaction becomes unavailable forever**, and
L5's own §3.7 shows why the escape hatch (ATTACH) is not one — 1 torn commit in 12 SIGKILL trials
under WAL against 0 in 16 with a rollback journal. Add a guard test asserting no transaction handle
is ever passed across the tier boundary; that is the property that keeps this decision safe.

### 2.5 C6 — L7's D5 is a no-op in SQLite. Measured.

L7 D5 is *"the highest-leverage schema change in the whole migration"*: re-key `ckpt_chunks` from
`hash BLOB PRIMARY KEY` to `id INTEGER PRIMARY KEY` with `hash BLOB UNIQUE`, so the clustered b-tree
holding 4 MiB payloads is appended in order and only a narrow index takes random inserts. It is
argued from Zcash's `sapling_tree_shards`, the Jellyfish Merkle Tree paper, Erigon and geth.

**In SQLite the two shapes are the same object.** A non-`INTEGER` `PRIMARY KEY` on a rowid table is
implemented as a separate `sqlite_autoindex_*` UNIQUE index; the table b-tree is *already* keyed by
rowid. Measured (§3.D), 60,000 rows × 1 KiB on ext4:

```
schema: sqlite_autoindex_a_1 exists for `hash BLOB PRIMARY KEY`  (=> rowid table)
{"shape":"hashpk", "ms":707.6,"rowsPerSec":84789,"fileKB":82852}
{"shape":"rowidpk","ms":702.1,"rowsPerSec":85463,"fileKB":82852}
```

0.8% apart on time and **byte-identical on file size**. L5's own evidence corroborates it without
noticing: `/tmp/l5/scale-random.json` reports the 20 M-row table's index as
`sqlite_autoindex_nodes_1` at 226,684 pages — i.e. L5's "random-hash primary key" benchmark was
*already* L7's recommended shape.

**Ruling: delete L7's D5 as a schema change** (keep its ETL sorted-staging half, which L5 measured
independently at 1.8–2.05× — though that measurement is tmpfs-tainted per C1 and needs re-running).
This removes an "M–L plus a data migration for existing deployments" line from L7's cost table. It is
also a caution about the whole precedent lane: L7 reasoned from engines where the PK is clustered
(Postgres is not either, but LMDB/MDBX/RocksDB effectively are), and the reasoning did not transfer.
L4's DDL (`hash BLOB NOT NULL PRIMARY KEY` on a plain rowid table) is already correct, for the
different reason L4 measured (`WITHOUT ROWID` is 2× slower on point reads at 4 MiB rows).

### 2.6 C7 — `busy_timeout`, and why L3's worker does not rescue it. Measured.

Four values are prescribed: **L2 = 0** (all waiting in a JS poll loop), **L5 = "L2's value"**,
**L6 = 30000**, **L7 = 60000** (from CLN, with the strong argument that *"5 seconds is not a default,
it is a bug"* and LND's P0 fund-loss bug #7869 behind it).

L2 measured that the blocking form **fails P10**: 8 concurrent `withLease` calls resolve 1 acquired /
7 `LEASE_TIMEOUT` in 7,018 ms, because the blocking wait pins the single JS thread and the 20 ms
holder can never reach the event loop to release. L2's stated mechanism is *"keeps the event loop
turning"* — and L2 flagged, as its single largest dependency, that this softens if L3 lands an
off-thread driver. **L3 did land one.** So the obvious reading is that L2's prescription is now
optional and L6/L7's larger timeouts are safe.

It is not. I built the worker topology and put the blocking wait inside it (§3.W):

```
blocking busy_timeout in the worker: main-thread ticks 3649 (healthy)
   acquired@39ms  contend-start@49ms  contend-end:FAILED(5)@3054ms  released@3054ms
busy_timeout=0 + JS poll in the worker: main-thread ticks 3654
   acquired@36ms  contend-start@50ms  released@300ms  contend-end:ACQUIRED@304ms
```

The release message sat in the **worker's** message queue for three seconds while the worker was
blocked inside SQLite's busy handler. The contender burned the whole timeout and failed with
errcode 5; the release was processed 54 ms after the failure. The main loop was perfectly healthy
throughout — **which is precisely the trap**: L3's report demonstrates a worker with 0.6 ms main-loop
lag and 1 ms cancellation, and an implementer could reasonably conclude the blocking-wait hazard is
gone. It is not; it moved.

**Ruling: `busy_timeout = 0` on every handle, all waiting in JS — L2's prescription stands, under
either topology, but its *stated reason must be re-derived* as "keeps the worker's message queue
drainable."** L6's 30000 and L7's 60000 are wrong for this runtime; L7's underlying point survives
intact and is complementary — the JS poll loop **is** LND's retry classifier, and it should be built
with LND's parameters (bounded attempts, jitter, cap) rather than L2's flat 5 ms poll, which L2 itself
flags as untested against the archive's long batches.

### 2.7 C8 — `ADD COLUMN … STORED`. L4's "blocker" is not one.

L4's headline blocker B1: *"the blocker is `ALTER TABLE … ADD COLUMN … GENERATED ALWAYS AS (…)
STORED`, which SQLite **refuses outright**."* L6 measured it succeeding on a 0-row table and failing
only at ≥1 row. I confirm L6 (§3.F): `0 rows -> OK`, `1 rows -> FAIL cannot add a STORED column`.

The consequence is larger than a precision correction. A **fresh** SQLite lineage runs `000`→`006` in
order against an empty database, so `ckpt_chunks` has zero rows when `006` executes and **migration
006 replays verbatim, unchanged**. There are no shipped SQLite databases (L7: UmbraDB is 0.9.5 and
not on npm). Therefore:

- L4's recommended `VIRTUAL` workaround is unnecessary.
- L6's option (b), folding the column into `002`, is unnecessary.
- **L4's argument that "the pre-1.0.0 tag window is worth real engineering money — and that saving is
  in B1, not B2" collapses**, because B1 costs nothing at any tag time for a greenfield lineage.

What remains is a genuine forward constraint on *future* migrations: after 1.0.0 ships SQLite
databases with data, no migration may ever add a `STORED` generated column. That is L6's proposed
no-rebuild lint, extended by one rule, and it is cheap. **L4's B1 should be demoted from "the one hard
blocker" to a lint rule**, which materially changes L4's blocker ordering and its pre-tag argument.

### 2.8 C9 — bootstrap pragma order is irreversible and one lane has it wrong.

Measured (§3.G), same three pragmas, two orders, then a write:

```
L5 order (page_size, auto_vacuum, WAL): {"page_size":16384,"auto_vacuum":2,"journal_mode":"wal"}
WAL first, then page_size/auto_vacuum : {"page_size":4096, "auto_vacuum":0,"journal_mode":"wal"}
```

Both silently "succeed". L5 flagged the irreversibility (`auto_vacuum` "must be chosen before the
first write… cannot be retrofitted") but placed it in a *design sketch*. **L6's §4.2 "what
`createClient` applies" block — the code that actually runs — leads with `PRAGMA journal_mode = WAL`
and never mentions `page_size` or `auto_vacuum` at all.** If L6's block ships, every UmbraDB database
is created at 4 KiB pages with `auto_vacuum=0`, permanently, and the only remedy is a full `VACUUM`
(L5: 22 minutes and 400 GB of free disk at archive scale).

This is the clearest instance of the failure mode the seat exists to catch: **two lanes wrote the
same artefact, only one is correct, and the wrong one owns the code path.** It also means the
`page_size` value itself (C16) is a one-shot decision that must be made on a *re-measured* number,
because L5's page-size sweep is tmpfs-tainted (C1) and L7's `page_size=32768` is kupo's number for a
different workload. **Nobody owns the bootstrap sequence. Assign it.**

### 2.9 C10 — the poisoning gap between L1 and L2 is real, and neither lane closes it.

The brief asks whether L2's "sticky poison is mandatory" and L1's "T5's soundness does not depend on
it" are compatible. **They are compatible, and both are right on their own terms** — L1 is talking
about the store invariant, L2 about caller atomicity. I re-confirmed L2's premise (§3.A): after a
1555 constraint failure inside `BEGIN IMMEDIATE`, `isTransaction` is still true, the next insert
succeeds, and `COMMIT` commits both surrounding writes. And L1's refinement is right and is the more
useful half: `RAISE(ABORT)` reverses the whole statement *including the trigger's own history INSERT*,
so a swallowed error leaves the store T5-coherent — which is exactly why L1's design rule "never split
a logical put across two statements" is load-bearing and must survive into the implementation.

**But the two lanes together open a hole neither can see alone.** L1's B4 moves
`TRANSACTION_KEY_REUSE` out of SQL into a per-transaction write-set in the adapter, because
`txid_current()` has no unforgeable substitute. L2's emulation is specified as *"set a sticky
`poisoned` flag on the handle **when any statement through it throws**."* An adapter-side guard
throws **before any statement reaches SQLite**, so the flag is never set. Measured (§3.A2):

```
adapter threw: TransactionKeyReuseError (adapter-enforced)
isTransaction: true | NO statement reached SQLite
ON DISK: [{"id":1,"v":"a"},{"id":2,"v":"c"}]   <- PARTIAL COMMIT survives an adapter-thrown error
```

Today, `TRANSACTION_KEY_REUSE` arrives from the server as SQLSTATE `UB001` and therefore *does* poison
the Postgres transaction — `src/interfaces/transaction-lease.ts:216-226` documents that a caller who
swallows it "gets nothing". Under L1+L2 as written, that same caller gets a partial commit. **The
frozen error's documented consequence changes, and the change is invisible in both lanes' reports
because each is correct within its own scope.** Fix: the poison flag must be set by the *adapter
wrapper*, on any thrown `StorageError` whose scope is the transaction — not by the statement executor.
Two lines, but it has to be specified by someone, and right now it is specified by nobody.

### 2.9b Tier-2 rulings, compressed

- **C11 — `better-sqlite3` incremental BLOB I/O.** L5 states *"**Dependency on L3:** `better-sqlite3`
  does expose incremental BLOB I/O"* and uses it to harden `CEILINGS.md` SC-3. **False**, measured on
  the already-installed copy (§3.C11): `better-sqlite3@13.0.2` prototype is
  `prepare, transaction, pragma, explain, backup, serialize, function, aggregate, table,
  loadExtension, exec, close, defaultSafeIntegers, unsafeMode` — no blob handle. SC-3 is unfixable by
  streaming under **either** driver, and one of the two arguments for switching driver evaporates.
- **C12 — the driver decision.** L3 recommends `node:sqlite` and lists, as its own open question 1,
  *"`node:sqlite`'s documented stability index… the single largest unquantified risk in the lane."*
  L6 B10 answered it: experimental on `>=24`, **silent** (no `ExperimentalWarning`, verified), the
  bundled SQLite version is unpinnable and invisible to the lockfile, the inventory and
  `supply-chain.yml`. **The lane that owns the decision did not have the fact that undercuts it.**
  With C11 removed, the trade is purely stability/supply-chain versus 27 MB and one dependency. I do
  not own this call — it belongs to the seat weighing 1.0.0 posture — but the council must not record
  L3's verdict as settled: it is conditional on a question L6 already answered against it.
- **C13 — the junction batch.** L4's "the junction table needs 3 parameters regardless" is about the
  *transaction-history identifiers* junction. `JUNCTION_INSERT_MAX_ROWS` is a different table:
  `checkpoint-store.ts:59-61` says *"junction insert is 3 bind-params/row"* for `ckpt_manifest_chunks`
  `(manifest_id, position, chunk_hash BLOB)`. **L4 answered about the wrong junction.** The fix works
  anyway and I measured the recipe (§3.J): `INSERT … SELECT ?, key, unhex(value) FROM json_each(?)`
  — **2 bind parameters**, `position` taken from `json_each.key`, the 32-byte BLOB restored by
  `unhex()`. So L4 and L5 are reconcilable: `json_each` for the junctions (small values, no hex cost
  worth measuring), prepared-statement reuse for the chunk blobs (L5 is right that JSON is the wrong
  road for 4 MiB payloads — though its 66.5 vs 202.9 MB/s figures are tmpfs-tainted). **L3's §4.5
  "retune to 16,000/10,000" is superseded; do not implement it** — it is the only one of the three
  answers that keeps the sub-batch machinery alive, and L3 itself notes it breaks the "EXACTLY ONE
  statement per checkpoint" property that file's comments defend.
- **C14 — `SQLITE_BUSY` and G3.** L7 calls this *"the single strongest negative this lane found"* and
  concludes *not closeable without changing the frozen error surface*. L2 and L6 independently map
  BUSY onto `LEASE_TIMEOUT` / `MIGRATION_LOCK_TIMEOUT` / `TRANSACTION_FAULT(timeout)`, all already
  retryable. **L2/L6 are right, conditional on L2's design landing whole:** with `BEGIN IMMEDIATE` at
  the start of every write transaction plus a bounded JS poll-retry, BUSY cannot surface mid-protocol
  — it surfaces only at acquisition, where a retryable code already exists. The LND failure L7
  documents is specifically a `DEFERRED` lock upgrade escaping mid-transaction, which `BEGIN
  IMMEDIATE` structurally prevents (LND's own fix was `_txlock=immediate`). **So L7's B8 is a
  conditional, not an absolute — and it should be recorded as the strongest reason `BEGIN IMMEDIATE`
  is non-negotiable rather than as a forced catalog change.** If any write path is ever allowed to be
  `DEFERRED`, L7's B8 fires and a new code is needed.
- **C15 — `octet_length` vs `length`.** L4 §3.1 measured and mandates `octet_length(data)`; L5's §4
  DDL ships `length(data)`. Both are bytes *for a BLOB column*, so both work today — but `length()` on
  a TEXT column is **characters**, and `chain_blobs.data` is only a BLOB by convention until `STRICT`
  makes it one. L4 is right; adopt `octet_length` everywhere, and note it is also the same identifier
  as the Postgres original, so the migration diff stays readable.
- **C16 — `page_size`.** Unresolvable from the current evidence (L5's sweep is tmpfs, L7's 32768 is
  kupo's), and it is irreversible (C9). **One experiment closes it**: re-run L5's `blobs2.mjs` and
  ingest matrix on `/root` (ext4) at 4096/8192/16384/32768 against the measured p50≈6 KB / p99≈29 KB
  distribution. Half a day. Do it before any file is created.
- **C17 — `synchronous`.** L6 argues `NORMAL` is *already contract-legal* because it maps onto the
  `synchronous_commit=off` "lost tail" the current probe warns about rather than refuses, at a 27×
  cost. My ext4 numbers make the lever **137×** (47,263 → 345 c/s), which strengthens L6's economic
  argument and simultaneously raises the stakes of getting it wrong. L6's own §5.1 is the binding
  constraint and I endorse it verbatim: **every crash result in the sprint is SIGKILL, i.e. a process
  crash, which is exactly the guarantee `NORMAL` does make and says nothing about the one it does
  not.** The two-file split (C5) is what lets this be decided *twice*: `FULL` for the wallet tier,
  `NORMAL` defensible for the re-ingestible archive — which is L7's D1 position, and it is only
  available if C5 goes the way I rule.
- **C18 — `DEFAULT_SCHEMA`.** Not a real conflict. L4 is right that the *exported surface* is
  untouched by table-name prefixing; L5 and L6 are right that *namespace isolation* is gone. They are
  describing different things and both wrote "no analogue"/"no break" as if describing the same one.
  Under C5 the resolution changes shape: the two lineages become two files, which is L4's option (b),
  and L4's objection to (b) — cross-file foreign keys are a syntax error — does not apply, because
  every FK in the repo is intra-lineage. **Recommendation: file-per-lineage, prefix-within-file for
  multi-tenant `schema` values.** That keeps `DEFAULT_SCHEMA` exported, keeps every constructor
  parameter working, and delivers real isolation for the case that matters.

### 2.10 Adjudications the council owes, from this seat

**#1 — Is this a 2.0.0?** I verified L6's decisive fact myself:
`docs/STABILITY.md:46` reads *"**Current version: `0.9.5` — the commitments above are NOT yet in
force.**"* and `package.json:3` is `"version": "0.9.5"` (§3.S). L6's line number is right; L4 cited
`:45`. **The claim holds.** From my lens the significant consequence is a *dependency*, not a cost:
the pre-tag window converts every G1/G2/G3 item into a CHANGELOG entry, which means **the sequencing
decision must be made before any other decision, because at least four lanes' cost tables are
conditional on it** (L4's per-option table, L6's B5 and B10, L7's §6 closing argument). Note that
C8 removes L4's specific reason for valuing the window; the window's real value is L6's error-catalog
and `engines`-floor items, plus L4's one-time `listKeys` collation reorder. I defer the ruling to the
version/contract seat but record that **L4's stated basis for it is now void.**

**#2 — the scale claim.** Two lanes reached the coordinator's conclusion independently: L7 §3.2 states
*"I could not independently reproduce those numbers today. The largest `ledger-db.sqlite` now on disk
is 52 MB"* and marks the claim as an in-repo citation. L5 asserted it as *"an existence proof, not an
argument."* **L5's own evidence block refutes L5's verdict paragraph**: §3.2 prints `nodes: n=7448`
and 28 MB of objects. I confirmed the file is 53,530,624 bytes (§3.S). What the artefact *does* prove
is real and worth keeping: the **shape** — a content-addressed `(key BLOB PRIMARY KEY, object BLOB)`
table, 32-byte keys, deployed by the Midnight indexer under `sqlx` — is production-real, and (per C6)
it is already the rowid-table shape L7 recommends adopting. What it does not prove is anything about
88 GB, 1 GB/h, or WAL (it runs `journal_mode=delete`). L5's ingest measurements are independent of the
claim **but are separately invalidated by C1**, so the lane's throughput case must now be rebuilt on
L6's ext4 number. Two lanes resting a scale claim on the same unreproducible record, while one of
them calls it an existence proof, is the pattern in §4.1.

**#3 — Cancellation.** My lens says the live problem is not "is the worker worth 32×" but that
**L6's B1 is stale**: L6 concludes *"NOT CLOSEABLE with a synchronous driver"* and writes the deletion
of CONTRACT §3's middle clause into its contract rewrite, without L3's worker result. L2 explicitly
made its verdict conditional (*"If L3 lands an off-thread driver, B1 must be re-examined: it might
reduce from 'not closeable' to 'closeable', which would materially change this lane's verdict on
G4"*). L3 landed it, measured 1 ms cancellation and 0.6 ms main-loop lag. **Three lanes concluded
"impossible" and one of them then made it possible; the contract text currently reflects the first
three.** Whatever the council decides, the §3 rewrite cannot be drafted from L6's B1 as written. I
defer the cost/benefit ruling and add one dependency the other lanes did not price: per C7, the
worker does **not** remove the need for `busy_timeout = 0`, so the worker's cost is additive to L2's
poll loop, not a substitute for it.

**#4 — Out-of-cache behaviour.** Worse than L5 states. L5's caveat is that its stores fit in 62 GB of
RAM so the OS page cache served every read. Per C1, the stores were **on** a RAM disk, so there was
no I/O path at all — the exposure is one level deeper than the lane's own honest caveat admits. L6's
rebuild figures have the same character and L6 says so ("a *floor*: this host's page cache absorbed
most of the working set"). **The experiment that closes it:** build a ≥120 GB store on `/` (ext4, 581
GB free — verified available), `echo 3 > /proc/sys/vm/drop_caches`, then measure random-hash point
reads and the ingest slope. That is the only measurement in the sprint that cannot be substituted by
argument, and it is a day of wall-clock time on hardware that exists.

**#8 — Cost.** Naive sum of the lane figures is **123–176 engineer-days (25–35 engineer-weeks)**:
L1 15–20, L2 12.5–17.5, L3 ~15–20 (inferred from 900–1,100 lines), L4 12.5–20, L5 20–30, L6 48–69.
Concrete double-counts I can name:

| Work | Counted by | Overlap |
|---|---|---|
| Migration lineage 000–006 → SQLite DDL | L6 (5–8 d) **and** L4 (3–4 d) | ~5 d |
| P1–P10 port | L6 (5–8 d), L4 (3–5 d, *flagged* "shared with L6"), L1 (3 d) | ~6–8 d |
| `checkpoint-store` batch inserts | L3 (~10 lines), L4 (1–2 d), L5 (1–2 d) | ~2 d |
| `durability-probe.ts` rebuild | L3 (234 lines) **and** L6 (4–5 d) | ~4 d |
| Error mapping | L6 (5–7 d), L2 (1 d), L3 (~200 lines, "L6 owns") | ~1–2 d |
| Migration lock / framework | L6 (3–4 d) and L2 (1–2 d) | ~1–2 d |
| CONTRACT §3/§5/§6 text | L6 (5–6 d) and L2 (1–2 d) and L5 (part of 3–5 d) | ~2–3 d |

That is **~21–26 days of duplication**, giving an honest **~100–150 engineer-days (20–30
engineer-weeks)**. But the structural double-count is bigger than the arithmetic one: **L3's central
claim is that the shim reduces every other lane's adapter port to a mechanical, reviewable diff, and
not one of L1, L4 or L5 costed its port that way** — each budgeted a full hand-rewrite. Either the
shim's value is uncounted (the total is over-stated by several more days) or the shim is redundant.
That question should be settled before the number is quoted, because it moves the total more than any
line item.

Two things are *under*-counted and belong on the table: **the bootstrap/pragma decision, which nobody
owns (C9/C16)**, and **the cross-lane reconciliation work this council's findings imply** — C3, C5,
C7 and C10 each require a change to an artefact a lane has already declared finished.

---

## 3. Evidence

Everything below is mine, run in this session. Where I took a lane's word for something I say so.

**Environment.** `wsl -e bash -lc 'node --version; …sqlite_version()'` → `v24.18.0`, `3.53.1`.
Worktrees at `3c0c68b` (`origin/main`) confirmed via `git log -1`.

### §3.C1 — the tmpfs finding

```
$ wsl -e bash -lc 'df -hT /tmp /root; stat -f -c "%n %T" /tmp /root'
tmpfs  tmpfs  32G  ... /tmp
/dev/sdd ext4 1007G ... /
/tmp tmpfs
/root ext2/ext3
$ wsl -e bash -lc 'grep -nE "dir *[:=]" /tmp/l5/*.mjs'
/tmp/l5/fsync.mjs:7:  const dir = "/tmp/l5/fsync";
/tmp/l5/ingest.mjs:9:  dir: "/tmp/l5/run",
/tmp/l5/scale.mjs:7: const cfg = { name: "scale", dir: "/tmp/l5/scale", rows: 20_000_000, ...
/tmp/l5/globalsort.mjs:18: const dir = "/tmp/l5/gs";
```

### §3.H — L5's `fsync.mjs` shape on both filesystems (`x3.mjs`)

```
$ wsl -e bash -lc 'cd /root/council-contradiction && node x3.mjs'
/tmp/cc-fsync                      -> WAL/NORMAL = 115225 c/s (9 us)   | WAL/FULL = 93386 c/s (11 us)  | DELETE/FULL = 21644 c/s
/root/council-contradiction/fsync  -> WAL/NORMAL =  47263 c/s (21 us)  | WAL/FULL =   345 c/s (2895 us)| DELETE/FULL =   173 c/s
```
L5 published `WAL/FULL 88,485` and flagged "11 µs/commit"; the tmpfs row reproduces both. L6 published
523 c/s on ext4; the ext4 row is the same order.

### §3.I — `backup()` vs `VACUUM INTO` on ext4, 691 MB, with a concurrent writer (`x3.mjs`)

```
source: 691.4 MB, rows=150000
VACUUM INTO : 2045 ms, event-loop ticks during = 0
backup()    : 2584 ms, ticks during = 1539, pages=169677, concurrent commits landed = 781
vac.db  rows=150000 integrity=ok
api.db  rows=150780 integrity=ok        (source at start = 150000)
backup(signal aborted at 5ms) -> COMPLETED anyway: 169678
```

### §3.A / §3.A2 — poisoning, and the adapter-guard gap (`x1.mjs`)

```
A.  stmt failed: 1555 UNIQUE constraint failed: t.id
    isTransaction after failure: true
    ON DISK: [{"id":1,"v":"before"},{"id":2,"v":"after"}]
A2. adapter threw: TransactionKeyReuseError (adapter-enforced)
    isTransaction: true | NO statement reached SQLite
    ON DISK: [{"id":1,"v":"a"},{"id":2,"v":"c"}]   <- PARTIAL COMMIT
```

### §3.B / §3.B2 / §3.B3 — the Date/type boundary (`x1.mjs`)

```
getAt(at=2500) bound as INTEGER ms          : [{"version":2}]   <- correct
getAt(at=1970-01-01T00:00:02.500Z) as TEXT  : [{"version":3}]   <- WRONG
raw: (3000 <= <iso text>) -> {"c":1}
STRICT rejects ISO text into INTEGER -> 3091 cannot store TEXT value in INTEGER column s.written_at
non-STRICT stored: {"w":"1970-01-01T00:00:01.000Z","t":"text"}
Date bound positionally -> {"x":null,"t":"null"}          (L3 B6 re-confirmed)
```

### §3.C — `columns()` origin metadata stress test (`x2.mjs`)

```
plain    : [{"n":"value","tbl":"kv_event","col":"value","t":"TEXT"}, {"n":"written_at",...,"t":"INTEGER"}]
aliased  : [{"n":"v","tbl":"kv_event","col":"value"}, {"n":"w","tbl":"kv_event","col":"written_at"}]
JOIN     : [{"n":"value","tbl":"kv_event"}, {"n":"pruned","tbl":"kv_retention"}]
subquery : origin preserved      CTE: origin preserved      UNION ALL: origin preserved
VIEW     : [{"n":"value","tbl":"kv_event","col":"value"},
            {"n":"valid_from","tbl":"kv_event","col":"written_at"},
            {"n":"valid_to","tbl":null,"col":null,"t":null}]     <- LEAD() loses origin
expr     : [{"n":"c","tbl":null},{"n":"m","tbl":null}]
```

### §3.D — hash-PK vs rowid-PK (`x2.mjs`), 60,000 × 1 KiB on ext4

```
sqlite_autoindex_a_1 exists for `hash BLOB PRIMARY KEY`   => a is a rowid table
{"shape":"hashpk", "ms":707.6,"rowsPerSec":84789,"fileKB":82852}
{"shape":"rowidpk","ms":702.1,"rowsPerSec":85463,"fileKB":82852}
```
Corroborated by L5's own artefact: `/tmp/l5/scale-random.json` lists
`{"name":"sqlite_autoindex_nodes_1","pages":226684}`.

### §3.E — `locking_mode=EXCLUSIVE` + WAL (`x2.mjs`) — settles L7 open question 2

```
set locking_mode=exclusive -> [{"locking_mode":"exclusive"}]
journal_mode now: {"journal_mode":"wal"}
second connection READ  blocked -> 5 database is locked
second connection WRITE blocked -> 5 database is locked
```
L7 open question 2 asks whether UmbraDB can have Bitcoin Core's kernel-enforced writer lease *and*
WAL's concurrent readers. **No.** Exclusive locking mode locks every other connection out of the file
entirely, including reads, which is incompatible with L2's writer+N-readers model and with L5's
concurrent-read-during-ingest question. Note L2 tested `BEGIN EXCLUSIVE`, a *different* thing, and
rejected it on granularity; L7's actual proposal was never tested by anyone. It is now.

### §3.F — `ADD COLUMN … STORED` (`x2.mjs`)

```
0 rows -> OK
1 rows -> FAIL cannot add a STORED column
```

### §3.G — bootstrap pragma order (`x2.mjs`)

```
L5 order (page_size, auto_vacuum, WAL): {"page_size":16384,"auto_vacuum":2,"journal_mode":"wal"}
WAL first, then page_size/auto_vacuum : {"page_size":4096, "auto_vacuum":0,"journal_mode":"wal"}
```

### §3.J — `ckpt_manifest_chunks` in one statement, 2 bind parameters (`x3.mjs`)

```
insert into mc(manifest_id,position,chunk_hash) select ?, key, unhex(value) from json_each(?)
rows: [{"manifest_id":1,"position":0,"h":"0000…","t":"blob"}, {"position":1,…}, {"position":2,…}]
```

### §3.W — blocking `busy_timeout` inside a worker thread (`x4-worker.mjs`)

```
blocking : mainTicks 3649  ["acquired@39ms","contend-start@49ms","contend-end:failed(5)@3054ms","released@3054ms"]
poll     : mainTicks 3654  ["acquired@36ms","contend-start@50ms","released@300ms","contend-end:acquired(poll)@304ms"]
```

### §3.C11 — `better-sqlite3` prototype (already installed by L3 at `/tmp/l3-bs3b`; **no `npm install` run**)

```
bs3 ok 3.53.4
proto: constructor,prepare,transaction,pragma,explain,backup,serialize,function,aggregate,table,
       loadExtension,exec,close,defaultSafeIntegers,unsafeMode
```
No incremental-BLOB binding. L5's claim to the contrary is refuted.

### §3.S — repo facts read from `origin/main` (`3c0c68b`), worktree `/root/UDB-sqlite-l1-temporal`

- `docs/STABILITY.md:46` — *"**Current version: `0.9.5` — the commitments above are NOT yet in
  force.**"*; `package.json:3` — `"version": "0.9.5"`.
- `src/postgres/client.ts:14` — `DEFAULT_SCHEMA = "umbradb"`;
  `src/postgres/chain-archive-store.ts:122` — `private readonly schema: string = "chain_archive"`.
- `src/postgres/migrations/chain_archive/001_chain_archive_core.ts:717-729` — the chain archive
  creates its **own** `watermarks` table, commented *"chain_archive's OWN local watermark-equivalent
  table, NOT a reuse of `tier1_wallet.watermarks` (§5 of the audit)"*.
- `src/postgres/checkpoint-store.ts:59-61` — `JUNCTION_INSERT_MAX_ROWS` is `ckpt_manifest_chunks`
  ("junction insert is 3 bind-params/row"), not the identifiers junction.
- `src/interfaces/temporal-kv.ts:179-181` — `AsOf = {kind:"at"; at: Date}`, no bound;
  `src/postgres/temporal-kv.ts:206-210` — validation is `instanceof Date && !Number.isNaN(...)` only.
- `ls -la /root/midnight-testnet/indexer-data/` → `ledger-db.sqlite` **53,530,624 bytes**.

**Taken on a lane's authority, not re-tested by me:** L1's E4/E5 write-cost curves and the 99.2%
clock-collision rate; L2's exp 07 SIGKILL lease release and exp 10 P10 reproduction; L3's 32×
worker-hop and 1.59× shim overhead; L4's `WITHOUT ROWID` matrix and `text[]`/GIN junction timings;
L5's cross-ATTACH SIGKILL torn-commit trials; L6's WAL-damage and crash-ordering harnesses and its
container-vs-fixture costs; **all of L7's external citations**, which I could not verify offline and
which the council should treat as citations.

---

## 4. What the sprint got wrong or missed

### 4.1 The lane with the most confident positives has the weakest measurement hygiene

Three of L5's headline claims have now failed checking: the 88 GB existence proof (coordinator, and
independently L7), the tmpfs benchmarks (me), and the `better-sqlite3` blob-I/O claim (me). L5 is not
a careless lane — it wrote the sprint's best open-questions section and self-flagged the fsync
anomaly. The pattern is narrower than "L5 is unreliable": **every failure is a claim L5 imported from
outside its own measurements or inherited from an environment it did not check**, while its own
directly-measured plan shapes and ratios have held up. Weight the lane accordingly rather than
discounting it.

### 4.2 Nobody owned the artefacts that cross every lane

Four lanes wrote a pragma block (L1 §4, L2 §4, L5 §4, L6 §4.2) and they disagree on `busy_timeout`,
`synchronous`, `page_size`, `auto_vacuum` and ordering. Two lanes wrote a backup mechanism and
disagreed. Three lanes wrote a batch-insert fix and disagreed. Two lanes wrote DDL for `size_bytes`
with different functions. **The sprint had no owner for the shared artefacts**, and the parallel
structure guaranteed that the last lane to write one would not know it was the fourth. This is the
generalisation of C9: the failure is not that any lane was wrong, it is that "connection setup" and
"bootstrap" were nobody's lane.

### 4.3 What no lane was assigned, and it shows

- **The wallet SDK consumer.** Every lane reasons about UmbraDB's surface; none checks what the
  Midnight wallet actually does with it. L1's open question 2 — *"I do not know UmbraDB's real per-key
  put rate during wallet sync… Someone who knows the sync loop should answer it"* — is the hinge of
  the entire clock adjudication, and it went to nobody. Same for L7's open question 4 (does anything
  read the archive concurrently with ingest?), which L7 says *"matters more than any pragma"* and
  which decides whether the archive resembles Hydra or kupo #209.
- **The migration of the existing deployment.** Every lane assumed greenfield; L7 is the only one that
  noticed the assumption is *correct* (no shipped users) and made it an argument. But L4's open
  question 3 (a `listKeys` resume cursor persisted under Postgres collation, resumed under SQLite
  BINARY) is a live-data hazard for whoever is running 0.9.5 today, and no lane owned data migration.
- **The `-wal` sidecar as an operational footgun.** L6 found it (copying `umbradb.db` without
  `-wal` silently restores from before the `CREATE TABLE`) and it is the single most dangerous new
  operational behaviour in the migration. It appears in one lane's blocker list and in nobody's
  design.

### 4.4 The Lean gate, from a contradiction lens

L1 B6 and L6 §3.14 reach the same conclusion by different routes — the Lean layer survives untouched
*because it was never connected to the artefact*, so a green gate after the migration is evidence of
the disconnection, not of portability. **They do not contradict each other and both are right.** What
neither says: the abstract→concrete refinement obligation is not merely *replaced*, it is replaced by
obligations that this council has just shown are **cross-lane**. `WellFormed` (strictly increasing
`written_at` per key) is L1's single remaining obligation — and C3 shows it can be satisfied in the
database and still produce wrong `getAt` answers at the driver boundary. A refinement register that
lists only per-lane mechanisms will miss exactly the class of defect that cost this council its
afternoon. L6's proposed register rewrite should have a fourth column: *which other component's
choice this obligation depends on.*

### 4.5 The dependency graph, drawn

Conditional edges the sprint left live. **Bold** = the resolution differs between lanes today.

```
pre-1.0.0 sequencing ──► L6 error catalog, L6 engines floor, L4 option table, L7 §6
L3 driver topology (worker) ──► L2 cancellation verdict, L6 B1 contract text
        └─ but NOT ──► busy_timeout (C7: the worker does not rescue it)
L6 B10 (experimental/unpinnable) ──► L3 driver choice   [inverted: decided without the fact]
L2 BEGIN IMMEDIATE ──► L5 C2a/GC argument, L4 B6 (FOR UPDATE), L7 B8 severity
**file layout** ──► L5 §4 (one), L2 B3 (archive separate), L7 D1 (two), L4 B2(b) (per lineage)
**bootstrap pragmas** ──► L5 §4 (correct order), L6 §4.2 (wrong order, owns the code)
**backup primitive** ──► L5 (backup()), L6 (VACUUM INTO, owns the contract text)
**batch inserts** ──► L3 (retune caps), L4 (json_each), L5 (prepared loop)
L4 STRICT ──► L3 decoder key, L3 normalize(), L1 written_at type   [C3/C4: unresolved]
L1 monotone clock ──► L1 txid substitute (coupled, L1 said so), L3 Date decoding, T4/T3 docs
L1 adapter-side key-reuse guard ──► L2 poison emulation scope   [C10: gap]
L5 partitioning ──► L4 schema answer, and (via C5) the whole file-layout question
```

Three lanes each assuming a different resolution of the same open question happened **four times**
(the bolded rows). That is the failure mode this seat exists to catch, and it is more than the sprint
would suggest from reading any single report — each lane flagged its dependency correctly and none
was in a position to notice that the flags pointed at incompatible answers.

---

## 5. Recommendation

**Before any code is written, in this order:**

1. **Assign an owner for the cross-lane artefacts** — connection/bootstrap pragmas, file layout,
   backup mechanism, error taxonomy. Four of the ten Tier-1 conflicts exist only because these were
   nobody's lane. This costs nothing and prevents the recurrence.
2. **Re-run L5's benchmark suite on `/root` or `/`, not `/tmp`** (C1). Strike the pragma matrix from
   the record until then; quote L6's 136 MB/s for headroom. Half a day.
3. **Settle `page_size` on that re-run** (C16) and freeze the bootstrap order as
   `page_size → auto_vacuum → journal_mode=WAL` (C9). Irreversible; decide once, in migration 000, not
   in `createClient`.
4. **Two files, one per lineage** (C5): `umbra.sqlite` and `umbra-archive.sqlite`, with a guard test
   forbidding a transaction handle from crossing the boundary. This is what makes C17's per-tier
   `synchronous` policy and L2's write-lock separation available at all.
5. **The type boundary as one decision** (C3/C4): `STRICT` everywhere, `Date → epoch-ms integer` in
   `normalize()`, origin-keyed decoder with explicit entries for derived view columns, and one
   conformance property pinning it. This is the only Tier-1 item that silently falsifies a
   Lean-mechanised law.

**Corrections to make in the record before consolidation:**

- `backup()` is the backup mechanism; `VACUUM INTO` is compaction (C2). Rewrite L6 §4.5.
- `busy_timeout = 0` everywhere, JS poll with LND's retry parameters (C7). Overrides L6 §4.2 and
  L7 D2.
- L4's B1 is a lint rule, not a blocker; migration 006 replays unchanged on a fresh lineage (C8).
- L7's D5 is a no-op; delete the schema change, keep the ETL staging (C6).
- L5's "better-sqlite3 has incremental BLOB I/O" is false; `CEILINGS.md` SC-3 is unfixable under
  either driver (C11).
- The poison flag is set by the adapter wrapper on any transaction-scoped `StorageError`, not by the
  statement executor (C10).
- `locking_mode=EXCLUSIVE` is incompatible with WAL readers; L7's open question 2 is closed, negative
  (§3.E).

**Two experiments worth a day each, in priority order:**

1. **The out-of-cache run** (adjudication #4): ≥120 GB store on ext4, drop caches, measure the random
   point-read and ingest slope. Nothing in the sprint substitutes for it, and 581 GB of ext4 is free
   on this box.
2. **The consumer question** — the wallet sync loop's per-key put rate (decides L1's clock) and
   whether anything reads the archive during ingest (decides whether L7's kupo #209 risk is live).
   Both are answerable by reading the consumer, not by measuring SQLite, and both outrank any
   remaining pragma question.

**What I would not change.** The migration verdict is sound and the scope decision is well supported —
L7's dual-backend evidence (212 `cfg` sites, two drifted lineages, two drift-repair migrations in the
project's own upstream) is the strongest single piece of external evidence in the sprint, and no lane
hedged toward a seam. The 0.9.5 window is real and verified. The disagreements above are all
recoverable at the design stage and none of them argues against doing this.
