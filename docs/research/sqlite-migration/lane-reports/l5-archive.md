# L5 — Chain archive and storage at scale

**Lane:** `l5-archive` · **Worktree:** `/root/UDB-sqlite-l5-archive` (cut from `origin/main`, `3c0c68b`)
**Environment:** WSL2 Ubuntu 26.04, 12 cores, 62 GB RAM, ext4 on a VHDX (`dd` direct write 976 MB/s),
Node **v24.18.0**, `node:sqlite` → SQLite **3.53.1**. No PostgreSQL server was running: every
Postgres number here is read from the committed baseline artifact, never re-measured.

---

## 1. Verdict

**The chain archive fits on SQLite. This lane does not block the migration.** Measured single-writer
ingest is **203 MB/s (18.4 k blob-rows/s)** with content-addressed random-hash keys and **417 MB/s
(37.8 k rows/s)** with sorted keys, sustained to an 11.8 GB file (183 / 330 MB/s), against a stated
requirement of **~1 GB/hour = 0.28 MB/s**. That is ~660–730× headroom at the baseline configuration
and still ~6.6× at **100×** the required rate. Say it plainly: throughput is not the problem, and
"does SQLite hold up at this size" resolves **yes** for this workload in this deployment's actual
I/O regime.

**One Postgres feature has no SQLite equivalent, and one closure route is dead.** Declarative
`PARTITION BY RANGE` is gone; its only load-bearing use in this schema is *cheap bulk drop* of an old
height range, and recovering that is worth doing — `DROP TABLE` of a 1 M-row range is **35 ms and
returns the space**, versus **1,296 ms for the equivalent `DELETE`, which returns nothing** (951 MB
file unchanged, 46,396 free pages). The recovery route is table-per-range behind a `UNION ALL` view,
at a quantified cost: SQLite performs **no partition elimination** (every range query probes every
arm), `SQLITE_MAX_COMPOUND_SELECT = 500` caps the view at 500 arms, and views need hand-generated
`INSTEAD OF` routing triggers regenerated at every rollover. **ATTACH-per-range — the closest
structural analogue — is not viable**: Node's bundled SQLite is compiled `SQLITE_MAX_ATTACHED=10`
(verified independently, matching L3), cross-database foreign keys are a *syntax error* (verified),
and I independently reproduced L2's finding that a WAL transaction spanning two attached files is
**not atomic** — 1 torn commit in 12 SIGKILL trials, against 0 in 16 with a rollback journal.

**The costs that must be named.** `pg_dump --schema=` disappears: backup granularity becomes the
whole file, `VACUUM INTO` **blocks the JS thread for the entire copy** (0 event-loop ticks across
2.26 s for 1.4 GB → ~11 minutes frozen at 400 GB), and the only non-blocking alternative,
`node:sqlite`'s `backup()`, **accepts an `AbortSignal` and ignores it**. That is a direct collision
between **G4 §6 (backup/restore)** and **G4 §3 (cancellation)**. `SQLITE_MAX_VARIABLE_NUMBER = 32766`
halves the parameter budget and **both existing caps would fail** (`CHUNK_INSERT_MAX_ROWS = 30_000` ×
2 params = 60,000; `JUNCTION_INSERT_MAX_ROWS = 20_000` × 3 = 60,000). `DELETE … LIMIT` is a syntax
error (`SQLITE_ENABLE_UPDATE_DELETE_LIMIT` not compiled in), removing the exact mechanism SC-2 names
as its conditional remediation. Free space is never returned to the filesystem without a full
`VACUUM`, and `auto_vacuum` **cannot be retrofitted** after the first write.

**One finding cuts in SQLite's favour and deserves to be stated loudly.**
`docs/research/indexer-parallelism-roadmap.md` R1 measured the real deployment as **CPU-bound, not
I/O-bound** (70 % of one core, 27 KB/s physical reads, 23 GB page cache over an 88 GB store), and R3
found **no ledger-DB GC** at the pinned v4.3.3 with ~1 GB/hour of unreclaimed growth. Both transfer to
SQLite and get *better*: an in-process engine deletes the per-query socket round trip that Postgres
charges for exactly that syscall-bound, cache-resident pattern. And the archive is **already running
on SQLite in production** — the deployed indexer's own content-addressed node store is
`ledger_db_nodes(key BLOB PRIMARY KEY, object BLOB NOT NULL)` in `ledger-db.sqlite`, 32-byte random
keys, at the exact scale (88 GB, 1 GB/hour) this lane was asked to doubt. That is an existence proof,
not an argument.

---

## 2. Blockers

### B1 — `PARTITION BY RANGE (height)` and cheap bulk drop — **closeable with a schema redesign, at a measured cost**

`001_chain_archive_core.ts:275,395,456` declare `blocks`, `transactions` and `bridge_observations` as
`PARTITION BY RANGE`, with 5 pre-created 1 M-height buckets plus a `_default` catch-all
(`partition-config.ts:16,26`). Postgres gives pruning, per-partition maintenance, and O(1) bulk
retirement. SQLite gives none of them declaratively.

| Option | Bulk drop of a 1 M-row range | Range query plan | Verdict |
|---|---|---|---|
| One table, PK `(net,height,block_hash)` | `DELETE` **1,296 ms**, file unchanged, 46,396 free pages | `SEARCH blocks USING PRIMARY KEY (net=? AND height>? AND height<?)` — one descent | Simplest; pruning is the weak point |
| Table-per-range + `UNION ALL` view | **`DROP TABLE` 35 ms**, space returned | **all 5 arms SEARCHed — no elimination** | Recovers bulk drop, costs O(arms)/query |
| `ATTACH`-per-range | file `rm` | n/a | **Dead — B2** |

`blocks_one_canonical_per_height` (`001_chain_archive_core.ts:281`) survives *and gets stronger*: a
SQLite partial unique index `ON blocks(net,height) WHERE is_canonical` enforces **globally**, whereas
the Postgres version is per-partition enforcement that is global only because `height` is the
partition key (the migration's own comment, lines 219-236, says exactly this). **Split the table per
range and you lose that** — each child gets its own index and cross-child uniqueness becomes an
application invariant rather than a database-enforced one. That is the concrete correctness price of
table-per-range.

Cross-partition foreign keys (`transactions`/`bridge_observations` → `blocks`, everything →
`chain_blobs`) are **fine within one file** — composite-FK enforcement verified, §3.9 — and are
**destroyed** by any file-splitting option.

**Frozen commitments touched:** none directly; `CEILINGS.md` SC-1's deferred remediation
"IS-3 `kv_history` partitioning + retention" loses its Postgres mechanism and must be re-planned.

### B2 — `ATTACH`-per-range as the structural analogue — **not closeable**

Three independent, individually fatal facts, each measured here:

1. **`SQLITE_MAX_ATTACHED = 10`** — compile-time in the SQLite Node bundles; the 11th `ATTACH` fails
   with `too many attached databases - max 10`. Upstream allows raising it to 125 at compile time,
   which is irrelevant (cannot recompile Node's copy) and insufficient anyway. **Confirms L3.**
2. **Cross-database foreign keys do not exist.** `REFERENCES main.chain_blobs(hash)` is rejected at
   parse time: `near ".": syntax error`. Every FK in `001_chain_archive_core.ts` (lines 139, 258, 259,
   390, 394, 452, 455, 539) either lives in one file or stops being enforced.
3. **WAL + ATTACH is not atomic across files.** SQLite's atomic multi-database commit needs a
   super-journal; WAL does not create one. Reproduced directly: **1 of 12** SIGKILL-mid-commit trials
   left `main.max=360` / `r0.max=359`; the rollback-journal control was **0 of 16**, with
   `main.db-mj<hex>` super-journal files visible in the listings. **L2's finding confirmed by
   independent reproduction, not accepted secondhand.**

### B3 — `pg_dump --schema` / physical backup — **closeable in application code; the contract changes**

`docs/CONTRACT.md:114-133` promises a snapshot-consistent, **schema-scoped** logical dump and states a
mid-GC dump is safe to restore.

| Mechanism | Measured (1.4 GB source) | Consistent | Concurrent with ingest | Cancellable |
|---|---|---|---|---|
| `VACUUM INTO 'f'` | **2,264 ms (~620 MB/s)**, `integrity_check ok` | yes | yes | **no — 0 event-loop ticks, thread frozen** |
| `backup()` | **2,026 ms (~690 MB/s)**, `integrity_check ok` | yes | yes — 795 concurrent commits landed during a 400 MB run | **no — `signal` accepted and ignored** |
| copy `.db`+`-wal`+`-shm` | — | only under an atomic FS snapshot | — | — |
| `serialize()` | — | yes | — | infeasible: whole DB into one Buffer |

Three losses: **schema scoping is gone** (unit is the file; interacts with **G1**'s `DEFAULT_SCHEMA`
and, given B2, constrains how many files the product may have → **L1**); **`backup()` captures a state
at or after the call, not at it** (source had 900,000 rows at start, copy contained **900,794** — it
restarts on writer interference); **neither is cancellable**, and `VACUUM INTO` freezes the event loop
for the whole copy. **G4 §6 must be rewritten; G4 §3 needs a stated exception.** L6 owns the text.

### B4 — Unbounded bulk insert / the bind-parameter cap — **closeable in application code, and it simplifies**

`checkpoint-store.ts:40-63` records that a single unbounded statement is infeasible under postgres.js
and ships a defensive sub-batch; `docs/research/a1-unbounded-bytea-insert.md` names COPY-binary as the
bounded-constant resolution. Under SQLite:

- **The cap recurs and halves**: `SQLITE_MAX_VARIABLE_NUMBER = 32766` (verified: 16,383 two-parameter
  rows accepted, 16,384 rejected with `too many SQL variables`). **Both shipped caps would fail as
  written** — 30,000 × 2 and 20,000 × 3 are each 60,000 parameters. Ported values: **16,383** and
  **10,922**.
- **The V8-string analogue exists and is worse**: `json_each` bulk insert requires hex round-tripping
  and measured **66.5 MB/s vs 202.9** for prepared reuse — the same class of failure as postgres.js's
  `unnest` text serialisation, slow rather than fatal.
- **But the problem dissolves.** One prepared `INSERT` re-`run()` in a loop inside one explicit
  transaction has **no parameter cap and no serialisation path**, and measured within 20 % of the
  fastest multi-row form (203 vs 248 MB/s). There is no COPY equivalent and none is needed.
  **Recommendation: prepared-statement reuse; delete the sub-batch logic rather than porting it.**
- Two parser gotchas: `INSERT … SELECT … ON CONFLICT` needs a literal **`WHERE true`** before
  `ON CONFLICT` (else `near "DO": syntax error`); and **`DELETE … LIMIT` is a syntax error**, which
  removes the pg-boss-style ≤100-row chunked delete that `CEILINGS.md` SC-2 names as its conditional
  remediation. Rewrite: `DELETE … WHERE rowid IN (SELECT rowid … LIMIT n)`.

### B5 — GC and the C2a same-transaction reachability scan — **transfers intact; the argument gets easier**

`checkpoint-store.ts:488-534` runs prune as manifest-delete-then-chunk-reclaim in one transaction with
a 15-minute grace window and a `NOT EXISTS` anti-join. Everything survives:

- The anti-join is expressible verbatim, backed by `ckpt_manifest_chunks_by_hash`.
- **The concurrency argument gets strictly simpler.** Postgres needed `FOR SHARE`/`FOR UPDATE` row
  locking on `chain_blob_roles` plus a two-session empirical proof of both interleavings
  (`001_chain_archive_core.ts:605-654`). SQLite has one writer at a time, so both interleavings
  collapse to "the other transaction has already committed or has not started". *Conditional on
  `BEGIN IMMEDIATE` on every write path — **L2** owns that.*
- WAL's reader snapshot makes the reader side easier too: `load`/`history`'s REPEATABLE READ
  requirement (`checkpoint-store.ts:392,458`) is WAL's default for any read transaction.
- **Measured against the baseline's own declared cliff rule** (`CEILINGS.md` SC-2, K = 2.0, D = 5000 ms):

| live chunks | SQLite pass | PG baseline `gcCurve` |
|---|---|---|
| 10,000 | 4.5 ms | 5.47 ms |
| 50,000 | 34.5 ms | 15.55 ms |
| 100,000 | 97.2 ms | 32.22 ms |
| 300,000 | 416.5 ms | 127.90 ms |
| 1,000,000 | **1,922.3 ms** | 595.87 ms |

  ~3× slower at 10^6 live chunks, but **the SC-2 cliff is still not met**: no pass exceeded D, and
  growth stayed within K = 2.0 (100 k→300 k: 3.00× chunks / 4.28× time = 1.43×; 300 k→1 M: 3.33× /
  4.62× = 1.39×). A pass that actually reclaims 100,000 chunks took **3,573 ms** — under D, with much
  less margin. **SC-2 stands as written; its recorded numbers change.** *(Not a same-hardware
  comparison — §5.)*

### B6 — Space is never reclaimed to the filesystem — **closeable in application code; slightly worse**

R3 records ~1 GB/hour of growth with nothing reclaimed. Under SQLite that is the same for live data
and worse for deleted data: after deleting 100,000 chunks the file stayed at **458.4 MB** with **8,886
free pages**; after the 1 M-row block `DELETE`, 951 MB unchanged with 46,396 free pages.

- **`VACUUM`** — 1,516 ms for 458 MB (~300 MB/s); exclusive lock, ~2× space. At 400 GB: ~22 min and
  400 GB of free disk.
- **`auto_vacuum=INCREMENTAL`** — **must be chosen before the first write**. Verified it cannot be
  retrofitted: setting the pragma on an existing DB reported `auto_vacuum = 0` until a full `VACUUM`
  ran, after which it reported `2`. **This is a one-way decision at file-creation time and belongs in
  the migration bootstrap.**
- Free pages *are* reused by later inserts, so for an append-mostly archive "let the freelist absorb
  it" is the same disposition R3 already documents.

### B7 — `UNIQUE NULLS NOT DISTINCT` — **closeable with a schema redesign**

`verifier_key_observations`'s `UNIQUE NULLS NOT DISTINCT (vk_hash, net, scope, contract_address, tag)`
(`001_chain_archive_core.ts:570`) exists so two protocol-scoped observations with
`contract_address IS NULL` collide. **A plain SQLite `UNIQUE` over the same columns accepts the
duplicate** (verified) — a naive port silently reintroduces the exact data-loss bug the v4 audit fixed.
Working replacement, both halves verified:

```sql
CREATE UNIQUE INDEX vko_identity
  ON verifier_key_observations (vk_hash, net, scope, coalesce(contract_address, x''), tag);
-- and: ON CONFLICT (vk_hash, net, scope, coalesce(contract_address, x''), tag)
--      DO UPDATE SET first_seen_height = min(...)     -- SQLite 2-arg min() == Postgres LEAST
```

### B8 — Not blockers (verified working)

`GENERATED ALWAYS AS (length(data)) STORED`; partial unique indexes; composite FKs to composite PKs;
`BEFORE INSERT/DELETE/UPDATE OF … FOR EACH ROW WHEN … RAISE(ABORT,'<name>')` reproducing all three
plpgsql guard triggers with the constraint name **as the error message** — cleaner than the Postgres
`USING CONSTRAINT =` workaround at `001_chain_archive_core.ts:193-204` (**flag to L4**: a G3
opportunity, not a problem); `RETURNING`; `ON CONFLICT … DO UPDATE`; `STRICT`; `WITHOUT ROWID`;
`json_each`; 200 MB single BLOBs.

---
## 3. Evidence

Scripts in `/tmp/l5/`, throwaway. Nothing in `src/`, `test/` or product code was modified.

### 3.1 Compile-time limits

```
$ wsl -e bash -lc 'node -e "const{DatabaseSync}=require(\"node:sqlite\");
  const db=new DatabaseSync(\":memory:\"); const o=[];
  for(let i=0;;i++){const r=db.prepare(\"select sqlite_compileoption_get(?) v\").get(i);
  if(r.v===null)break;o.push(r.v)} console.log(o.join(\"\n\"))"'

DEFAULT_CACHE_SIZE=-2000        DEFAULT_MMAP_SIZE=0        DEFAULT_PAGE_SIZE=4096
DEFAULT_SYNCHRONOUS=2           DEFAULT_WAL_SYNCHRONOUS=2  DEFAULT_WAL_AUTOCHECKPOINT=1000
MAX_ATTACHED=10                 MAX_COLUMN=2000            MAX_COMPOUND_SELECT=500
MAX_DEFAULT_PAGE_SIZE=8192      MAX_EXPR_DEPTH=1000        MAX_LENGTH=1000000000
MAX_MMAP_SIZE=0x7fff0000        MAX_PAGE_COUNT=0xfffffffe  MAX_PAGE_SIZE=65536
MAX_SQL_LENGTH=1000000000       MAX_VARIABLE_NUMBER=32766  TEMP_STORE=1  THREADSAFE=1
```
`SQLITE_ENABLE_UPDATE_DELETE_LIMIT` is **absent**.

Empirical confirmation (`/tmp/l5/limits.mjs`):
```
ATTACH: succeeded=10 then error: too many attached databases - max 10
VALUES rows 16383 (2 params/row): OK
VALUES rows 16384 (2 params/row): too many SQL variables
UNION ALL arms 1+499: OK
UNION ALL arms 1+500: too many terms in compound SELECT
DELETE ... LIMIT: near "LIMIT": syntax error
blob 209715200 bytes: OK, stored length=209715200
pragma max_page_count = {"max_page_count":4294967294}
pragma mmap_size = {"mmap_size":0}   after set 256MB -> {"mmap_size":268435456}
backup export typeof: function length: 2
generated column: OK / partial unique idx: OK / RETURNING: {"a":7} / without rowid: OK
upsert+generated: {"size_bytes":10} / json_each: [{"a":1,"b":"aa"},{"a":2,"b":"bb"}]
```

**Derived ceilings.** Max DB size = `MAX_PAGE_COUNT × page_size` = 4,294,967,294 × 4,096 = **17.6 TB**
at the default page size, **281 TB** at `page_size=65536`. Max single BLOB = **1 GB**
(`SQLITE_MAX_LENGTH`; 200 MB stored successfully). `mmap` is **off by default** and capped near 2 GiB
(`MAX_MMAP_SIZE=0x7fff0000`) — a partial-coverage optimisation for a multi-hundred-GB archive, not a
strategy.

**`node:sqlite` API surface.** `Object.getOwnPropertyNames(DatabaseSync.prototype)` → `open, close,
prepare, exec, function, createTagStore, location, aggregate, createSession, applyChangeset,
enableLoadExtension, enableDefensive, loadExtension, serialize, deserialize, setAuthorizer`. **No
`sqlite3_blob_open` binding — no incremental BLOB I/O** (matches L3). Module exports
`{ DatabaseSync, StatementSync, Session, constants, backup }` — the **online backup API is available**.

### 3.2 The archive's real blob-size distribution — measured, not assumed

The design doc §3 records reading the deployed indexer's SQLite directly; those files are still on
disk, so I measured them.

```
/root/midnight-testnet/indexer-data/indexer.sqlite
blocks: { c: 11941, mn: 0, mx: 11940 }   transactions: 359
transactions.raw length: min 41, max 145167, avg 7433.0, total 2,668,460
percentiles [min,p50,p90,p99,max] = [41, 5893, 11987, 29158, 145167]
buckets: <64:1  <256:31  <1K:20  <4K:41  <16K:235  <64K:30  >=64K:1

/root/midnight-testnet/indexer-data/ledger-db.sqlite
sqlite_master: ledger_db_nodes(key BLOB PRIMARY KEY, object BLOB NOT NULL)
               ledger_db_roots(key BLOB PRIMARY KEY, count INTEGER NOT NULL)
nodes: n=7448, object min 931, max 10347, avg 3805.2, total 28,341,115; key length = 32 exactly
page_size 4096, journal_mode 'delete', auto_vacuum 0, freelist_count 4646
```

**This is the most load-bearing observation in the report.** The deployed indexer's content-addressed
node store — the one the roadmap measures at 88 GB growing 1 GB/hour — *is already a SQLite table with
a random 32-byte BLOB primary key*: exactly the workload and exactly the pathology this lane was asked
to doubt. Note `journal_mode='delete'` and no pragmas set, precisely what roadmap Stage 1.1 flags.

`chain_blobs` will hold three role families: header JSON (sub-KB — 5 header fields plus ~5 digest
logs, design doc §3.1), body JSON (hex-encoded extrinsics, ≈2× raw), and `tx_raw` at the distribution
above. **Median blob ≈ 6 KB, p99 ≈ 29 KB, hard max ≈ 145 KB** — three to four orders of magnitude
below `SQLITE_MAX_LENGTH`.

### 3.3 Ingest configuration matrix

`/tmp/l5/ingest.mjs` — 200,000 `chain_blobs` rows, 32-byte SHA-256 keys, blob sizes drawn from §3.2
(mean 11.0 KB, 2,204.8 MB logical), one `chain_blob_roles` row each, WAL, `temp_store=MEMORY`, 1,000
rows per explicit transaction, prepared-statement reuse unless stated.

| # | Config | rows/s | MB/s | file MB | amp | window rows/s (quarters) |
|---|---|---|---|---|---|---|
| A | **baseline** WAL / `synchronous=NORMAL` / page 4096 | 18,405 | 202.9 | 2,376 | 1.078 | 23,840 → 17,352 → 17,194 → 16,779 |
| B | `synchronous=FULL` | 19,361 | 213.4 | 2,376 | 1.078 | 25,571 → … → 17,199 |
| C | `synchronous=OFF` | 19,516 | 215.1 | 2,376 | 1.078 | 26,393 → … → 16,021 |
| D | rollback journal (`DELETE`) | 25,740 | 283.8 | 2,376 | 1.078 | 41,566 → … → 19,475 |
| E | `page_size=8192` | 21,440 | 236.4 | 2,507 | 1.137 | |
| F | `page_size=16384` | 20,993 | 231.4 | 2,772 | 1.257 | |
| G | `page_size=65536` | 17,199 | 189.6 | 2,655 | 1.204 | |
| H | `cache_size=-256000` (256 MB) | 21,024 | 231.8 | 2,376 | 1.078 | |
| I | `cache_size=-2000000` (2 GB) | 16,872 | 186.0 | 2,376 | 1.078 | **worse than default** |
| J | `mmap_size=2 GiB` | 21,390 | 235.8 | 2,376 | 1.078 | |
| **K** | **sorted hash order** | **37,832** | **417.1** | 2,376 | 1.078 | **38,582 → 39,357 → 36,793 → 36,734 (flat)** |
| L | sorted + 256 MB cache | 35,078 | 386.7 | 2,376 | 1.078 | flat |
| M | multi-row `VALUES`, 4,000 rows/stmt | 22,518 | 248.2 | 2,376 | 1.078 | |
| N | `json_each` bulk insert (hex round-trip) | 6,030 | 66.5 | 2,376 | 1.078 | |
| O | `chain_blobs` as `WITHOUT ROWID` | 6,252 | 68.9 | 2,546 | 1.155 | **3.3× regression** |

**Sustained at 5× the size** (same harness, 1,000,000 rows → 11.8 GB file):
```
random: 16,662 rows/s, 183.1 MB/s, file 11,847 MB, amp 1.078, windows 20,977→16,689→15,574→14,649
sorted: 30,031 rows/s, 330.0 MB/s, file 11,849 MB, amp 1.078, windows 35,132→30,051→26,752→29,347
```

**Readings.**
- **vs the requirement.** 1 GB/hour = 0.278 MB/s. Baseline is **660–730×** that; sorted **1,190–1,500×**.
  At 10× the rate, 66–73× headroom; at **100× (100 GB/h = 27.8 MB/s), still 6.6×**. In rows: at ~6 s
  blocks the archive writes ≈1,800 blob rows/hour against a measured 60 M rows/hour.
- **Durability is not the throughput lever at this payload size.** A/B/C are within 6 % because ~11 KB
  of payload per row swamps the fsync. Isolating it with tiny rows, one commit per row
  (`/tmp/l5/fsync.mjs`): `WAL/OFF 94,775 c/s · WAL/NORMAL 99,418 · WAL/FULL 88,485 · DELETE/NORMAL
  17,423 · DELETE/FULL 15,118`. **Journal mode matters ~6×; `synchronous` ~12 %.** Caveat in §5.
- **`cache_size` is a trap.** 2 GB of SQLite page cache was *worse* than the 2 MB default (I vs A);
  256 MB mildly better. The OS page cache is doing the work — independently the same conclusion
  roadmap R2 reached for the indexer's `ledger_db.cache_size`.
- **`WITHOUT ROWID` must not be used for the blob table** — right for narrow junctions
  (`chain_blob_roles`, `ckpt_manifest_chunks`), catastrophic for multi-KB payloads.

### 3.4 The random-hash B-tree pathology — does roadmap Stage 2.1 transfer?

**Yes, and as a slope fix rather than a constant — but only if the sort window is a large fraction of
the key space.**

`/tmp/l5/scale.mjs` — 20,000,000 rows, `key BLOB PRIMARY KEY` + 64-byte payload (index-dominated on
purpose), 20,000-row transactions:

| run | overall rows/s | first 1 M window | last 1 M window | file | PK index |
|---|---|---|---|---|---|
| random | 64,671 | 104,731 | 57,277 | 3,090 MB | 928 MB / 226,684 pages |
| sorted **within each 20 k batch** | 66,474 | 126,813 | 60,829 | 3,091 MB | 929 MB / 226,917 pages |

**A 20 k sort window over a 20 M-key space buys nothing (+2.8 %)** — every batch still touches every
leaf. Contrast run K, where all 200,000 keys were sorted **globally**: **2.05× throughput and a flat
slope** (38.6 k → 36.7 k rows/s) against random's 1.42× decay; and at 11.8 GB, **1.80×** (330 vs
183 MB/s) with a 1.20× vs 1.43× decay.

**Design consequence, precisely:** ETL-style staging is worth building, and its value is entirely in
the window size. Erigon's framing is "load them in sorted order via heap" — a spill-to-disk sort of a
large batch, not an `Array.sort()` per transaction. Content-addressed rows are order-independent by
definition, so reordering cannot change output.

B-tree shape at 20 M rows: `dbstat` reports the PK index at **226,684 pages / 928 MB**, and
`max(length(dbstat.path)) = 13`, consistent with a **4-level** tree (~90 entries per 4 KB page,
log_90 20 M ≈ 3.7). Depth reaches 5 somewhere past ~10^9 rows. **Depth is not the scaling risk; cache
residency is.**

### 3.5 Blob storage — in-database vs external files

`/tmp/l5/blobs.mjs`, 4,000 blobs per size, `page_size=4096`, WAL/NORMAL, warm cache:

| blob size | write in-DB / files | read in-DB / files | space in-DB / files (logical) |
|---|---|---|---|
| 1,024 B | **33 / 125 ms** | **25 / 60 ms** | 6.4 / 4.1 MB (4.1) |
| 4,096 B | **61 / 151 ms** | **48 / 75 ms** | 19.3 / 16.4 MB (16.4) |
| 8,192 B | **93 / 154 ms** | **42 / 100 ms** | 35.7 / 32.8 MB (32.8) |
| 16,384 B | **202 / 251 ms** | 72 / 70 ms | 68.5 / 65.5 MB (65.5) |
| 65,536 B | 966 / **583 ms** | 143 / **122 ms** | 265.1 / 262.1 MB (262.1) |
| 145,167 B (measured max) | 1,583 / **954 ms** | 244 / **202 ms** | 582.5 / 580.7 MB (580.7) |

**Crossover sits between 16 KB and 64 KB at `page_size=4096`**, and page size moves it
(`/tmp/l5/blobs2.mjs`):

| blob | page 4096 | 8192 | 16384 | 32768 | 65536 |
|---|---|---|---|---|---|
| 16 KB write | 144 ms | 127 | **110** | 151 | 94 |
| 64 KB write | 683 ms | 553 | **439** | 526 | 485 |
| 145 KB write | 1,644 ms | 1,176 | **974** | 1,529 | 876 |

**Recommendation: keep blobs in the database, at `page_size=16384`.** p50 (6 KB) and p99 (29 KB) both
sit where in-DB wins outright; 16 KB pages roughly halve the write cost of the ≥64 KB tail (0.5 % of
rows) and push the crossover above p99, at a measured ~26 % space amplification for mixed content
(2,772 vs 2,204 MB logical, run F). `sqlar` adds nothing — it is a file-archive layout, and
`chain_blobs` + `chain_blob_roles` is a better fit for content-addressed data. External files lose FK
enforcement, transactional consistency with the metadata rows, and the single-file backup story, for a
win that only materialises above p99.

**One real loss:** with no `sqlite3_blob_open`, `getBlob()` (`chain-archive-store.ts:477-496`) always
materialises the whole blob into a JS `Buffer` — fine at 145 KB, but it re-states `CEILINGS.md` SC-3
(`load()` single-buffer materialisation) as **unfixable by streaming** under `node:sqlite`, where
under Postgres it was merely deferred. **Dependency on L3:** `better-sqlite3` does expose incremental
BLOB I/O.

### 3.6 Partitioning — three options, measured

`/tmp/l5/partition.mjs`, `/tmp/l5/partition2.mjs`:
```
one-table: inserted 5,000,000 block rows in 15.1 s, file=951 MB
  second canonical at height 7 rejected: UNIQUE constraint failed: blocks.net, blocks.height
  EXPLAIN range scan: SEARCH blocks USING PRIMARY KEY (net=? AND height>? AND height<?)
  DELETE 1M oldest rows: 1296 ms, file still 951 MB, freelist_count=46396

view insert (no trigger): cannot modify blocks because it is a view
view+trigger: inserted 2,000,000 in 5.7 s
  DROP TABLE of a 1M-row range + view rebuild: 35 ms
  file after DROP: 199 MB, freelist_count=24260

A1 view, net+height range: ["COMPOUND QUERY","LEFT-MOST SUBQUERY",
  "SEARCH blocks_p0 USING PRIMARY KEY (net=? AND height>? AND height<?)","UNION ALL",
  "SEARCH blocks_p1 …","UNION ALL","SEARCH blocks_p2 …","UNION ALL",
  "SEARCH blocks_p3 …","UNION ALL","SEARCH blocks_p4 …"]
A3 direct child table:     ["SEARCH blocks_p1 USING PRIMARY KEY (net=? AND height>? AND height<?)"]
A4 view, point lookup:     all five arms SCANned
A5 view range query 0.101 ms  /  A6 same query direct on the child 0.042 ms
```

**The view uses each child's index but visits every arm — SQLite performs no partition elimination
even when each child carries a `CHECK` that proves it cannot match.** Cost is O(#arms) index descents
per query, hard-capped at 500 arms. At the schema's 1 M-height bucket that is 500 M blocks of
headroom, so the cap is not the binding constraint — the per-query fan-out is.

ATTACH (`/tmp/l5/partition2.mjs`, `/tmp/l5/attach-wal.mjs`):
```
ATTACH-per-range: attached 10 ranges before: too many attached databases - max 10
B1 qualified cross-db FK DDL: near ".": syntax error
B4 atomic txn across attached files: OK   (COMMIT returns OK — but see §3.7)
B5 journal mode of attached files: {"journal_mode":"delete"}
```

### 3.7 Cross-file atomicity under WAL — reproducing L2's finding

`/tmp/l5/atomic-child.mjs` writes the same counter into `main.t` and `r0.t` (a second ATTACHed file)
inside one transaction, 512 KB of padding per row so `COMMIT` takes real time, both files in the same
journal mode, `synchronous=FULL`. `/tmp/l5/atomic-parent.mjs` SIGKILLs it at a random point 300–1200 ms
in, reopens both, compares `max(i)`.

```
$ node atomic-parent.mjs WAL 12
WAL trial 9: main.max=360 r0.max=359 *** TORN ***  files=[main.db main.db-shm main.db-wal r0.db r0.db-shm r0.db-wal]
… (11 others consistent)
WAL: 1/12 trials left the two files DISAGREEING (torn multi-file commit)

$ node atomic-parent.mjs DELETE 16
DELETE trial 1: main.max=333 r0.max=333 consistent  files=[main.db main.db-journal main.db-mj1CC243913 r0.db r0.db-journal]
… (all 16 consistent; super-journal main.db-mj<hex> present in 12 of 16 listings)
DELETE: 0/16 trials left the two files DISAGREEING (torn multi-file commit)
```

**L2 is right and the mechanism is visible in the artefacts**: rollback-journal runs create a
`main.db-mj<hex>` super-journal, WAL runs never do. I adopt L2's constraint without reservation, and
the consequence: **everything `saveAndAdvance` touches stays in one file**, and the chain archive gets
no file-splitting freedom that would cross a transaction boundary.

### 3.8 GC, VACUUM and backup

`/tmp/l5/gc-backup.mjs` (table shapes mirroring `002_checkpoint_store.ts`, 256-byte chunks):
```
GC pass @10000 live chunks: 4.5 ms      GC pass @300000: 416.5 ms
GC pass @50000: 34.5 ms                 GC pass @1000000: 1922.3 ms
GC pass @100000: 97.2 ms
GC pass WITH real reclaim (prune 3 manifests): 3573.1 ms, reclaimed 100000 chunks
file after delete: 458.4 MB, freelist_count=8886, page_count=111908
VACUUM: 1516 ms -> 399.2 MB
VACUUM INTO: 541 ms -> 399.2 MB
backup() while 795 concurrent commits ran: 825 ms, pages=98188, size=402.2 MB
backup-vacuum.db: integrity_check=ok  chunks=900000
backup-api.db:    integrity_check=ok  chunks=900794      <-- captured a LATER state
set auto_vacuum=INCREMENTAL on existing db -> auto_vacuum=0  (NOT applied)
VACUUM to apply auto_vacuum: 1290 ms -> auto_vacuum=2
```

`/tmp/l5/backup2.mjs` / `backup3.mjs` on a 1,397 MB source, instrumenting the event loop:
```
backup(rate:64): 2026 ms, pages=341037, event-loop ticks during=2018   (non-blocking)
backup with signal: completed (signal ignored?)                        (AbortSignal has no effect)
VACUUM INTO:     2264 ms, size 1395.2 MB, event-loop ticks during=0    (BLOCKS the JS thread)
```

### 3.9 DDL translation of every constraint in `001_chain_archive_core.ts`

`/tmp/l5/ddl.mjs`:
```
protocol dup rejected: UNIQUE constraint failed: vko.vk_hash, vko.net, vko.scope, vko.tag
NAIVE UNIQUE(...,contract_address,...) with NULLs: duplicate ACCEPTED -> NOT equivalent to NULLS NOT DISTINCT
COALESCE expression index rejects the NULL duplicate: UNIQUE constraint failed: index 'vko_fix'
upsert on expression index: OK, row= [{"h":2}]
block insert w/o role rejected: chain_blob_roles_completeness
block insert WITH role: OK, size_bytes= {"size_bytes":10}
role delete under live ref rejected: chain_blob_roles_removal_guard
un-finalize rejected: blocks_finalized_monotonic
composite FK to nonexistent block rejected: FOREIGN KEY constraint failed
composite FK valid insert: OK
```

### 3.10 Ingest-path shape in the repo

`chain-archive-sync/sync-service.ts:155-175` — `syncOnce({ maxBlocks = 100 })` loops one height at a
time; `ingestOneBlock` calls `putBlockBundle` (one transaction per block,
`chain-archive-store.ts:304-331`) and then `setWatermark` as a **separate** transaction
(`sync-service.ts:169-170`). `insertTransactionRows` / `insertBridgeObservationRows`
(`chain-archive-store.ts:214-262`) issue **three single-row statements per transaction** in a JS loop —
no batching at all. So the current ingest path is already the "prepared statement in a loop inside one
transaction" shape §3.3 measures as optimal for SQLite; the port is close to mechanical.

---
## 4. Design sketch

**One database file.** Not per-tier, not per-height-range. B2 and L2's constraint make any second file
a place where atomicity silently disappears; the only thing multiple files buy is bulk drop, and §3.6
shows table-per-range *inside one file* buys that for 35 ms without giving up the FKs.

**Bootstrap pragmas — two are irreversible, so they belong in migration 000.**
```sql
PRAGMA page_size    = 16384;       -- MUST precede the first write (§3.5)
PRAGMA auto_vacuum  = INCREMENTAL; -- MUST precede the first write; cannot be retrofitted (B6)
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;      -- lose recent commits on power loss, never corrupt
PRAGMA foreign_keys = ON;          -- OFF by default; every FK in the schema depends on it
PRAGMA temp_store   = MEMORY;
PRAGMA cache_size   = -262144;     -- 256 MB; do NOT go to GB (§3.3 run I)
PRAGMA busy_timeout = <L2's value>;
```

**Schema — chain archive.** Direct translation plus the three deltas below.
```sql
CREATE TABLE chain_blobs (
  hash       BLOB PRIMARY KEY CHECK (length(hash) = 32),
  data       BLOB NOT NULL,
  size_bytes INTEGER GENERATED ALWAYS AS (length(data)) STORED,
  created_at INTEGER NOT NULL                    -- unixepoch ms; SQLite has no timestamptz
);                                               -- rowid table: NOT `WITHOUT ROWID` (§3.3 run O)

CREATE TABLE chain_blob_roles (
  blob_hash BLOB NOT NULL REFERENCES chain_blobs(hash),
  role      TEXT NOT NULL CHECK (role IN ('block_header','block_body','tx_raw','proof',
                                          'verifier_key','bridge_observation')),
  PRIMARY KEY (blob_hash, role)
) WITHOUT ROWID;                                 -- narrow junction: WITHOUT ROWID is right here

CREATE TABLE blocks_p0 (                          -- one per 1 M-height bucket
  net TEXT NOT NULL,
  height INTEGER NOT NULL CHECK (height >= 0 AND height < 1000000),
  block_hash BLOB NOT NULL CHECK (length(block_hash) = 32),
  parent_hash BLOB NOT NULL, state_root BLOB NOT NULL, extrinsics_root BLOB NOT NULL, author BLOB,
  header_blob_hash BLOB NOT NULL REFERENCES chain_blobs(hash),
  body_blob_hash   BLOB          REFERENCES chain_blobs(hash),
  is_canonical INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'seen' CHECK (status IN ('seen','canonical','orphaned','pruned')),
  finalized INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER NOT NULL,
  CHECK ((status = 'canonical') = is_canonical),
  CHECK (NOT finalized OR is_canonical),
  PRIMARY KEY (net, height, block_hash)
) WITHOUT ROWID;
CREATE UNIQUE INDEX blocks_p0_one_canonical ON blocks_p0(net, height) WHERE is_canonical;
```

**Delta 1 — partitioning.** Table-per-1 M-height-bucket, `UNION ALL` view for reads, `INSTEAD OF`
triggers for writes, all DDL generated from `CHAIN_ARCHIVE_HEIGHT_PARTITION_SIZE` — the constant
already exists (`partition-config.ts:16`), and its "build-time constant, not runtime configurable"
caveat becomes moot because SQLite requires generated DDL anyway. Rollover replaces
`chain-archive-rollover.ts` entirely: no `DETACH`/`ATTACH`, no `_default` partition, no FK-drop dance,
none of the four reproduced Postgres failure modes — just `CREATE TABLE blocks_pN`, `DROP VIEW`,
`CREATE VIEW`, `DROP TRIGGER`, `CREATE TRIGGER` in one transaction (SQLite DDL is transactional).
**That file's 353 lines collapse to roughly 60.** Cap the view at 500 arms; past that, retire old
ranges or nest views.
*If bulk pruning is not actually a requirement, drop this delta and use one table per relation — it is
strictly simpler and §3.6 shows the query path is better.* **This is the one genuinely open design
decision, and it is a product question (see §5.5).**

**Delta 2 — `verifier_key_observations` identity.** The `coalesce(contract_address, x'')` expression
index of B7, with a matching `ON CONFLICT` target.

**Delta 3 — triggers.** Every plpgsql guard becomes a SQLite `BEFORE` trigger with `WHEN <cond>` +
`SELECT RAISE(ABORT,'<constraint-name>')`, verified §3.9. Drop the `FOR SHARE`/`FOR UPDATE` locking
and the two-session interleaving argument — SQLite's single writer supplies it (B5, conditional on
`BEGIN IMMEDIATE`, **L2's**). Triggers must be declared **per child table**: there is no
partitioned-parent trigger cloning.

**Write path.**
```js
const insBlob = db.prepare(
  "INSERT INTO chain_blobs(hash,data,created_at) VALUES (?,?,?) ON CONFLICT(hash) DO NOTHING");
db.exec("BEGIN IMMEDIATE");
for (const b of blobs) insBlob.run(b.hash, b.data, now);  // no parameter cap, no serialisation
// … block + txs + observations + watermark, all in the same transaction
db.exec("COMMIT");
```
Delete `CHUNK_INSERT_MAX_ROWS` / `JUNCTION_INSERT_MAX_ROWS` and the sub-batch loops rather than
re-deriving them for 32766 (B4). **Free win while porting:** fold `setWatermark` into the same
transaction as `putBlockBundle` — `sync-service.ts:169` commits them separately today, and in a
single-file SQLite design co-transactionality is free.

**Bulk backfill.** Add an ETL sorted-staging stage: buffer N blocks' blobs, sort by hash, insert.
§3.4 shows **1.8–2.05× and a flat throughput slope** — but only if the window is a large fraction of
the keys written, so size it in the millions of rows (spill to a temp table or external sort), not
per-transaction. Steady-state tip-following does not need it.

**Backup/restore (mechanism; L6 owns the contract text).**
- Default: `backup()` — non-blocking, ~690 MB/s, safe under concurrent ingest, `integrity_check ok`.
  Document that it captures a state **at or after** the call, not at it.
- `VACUUM INTO` when a compacted copy is wanted and a multi-minute stall is acceptable. Document it as
  **uncancellable and event-loop-blocking**.
- Never `cp` a live WAL database; filesystem snapshots must be atomic across `.db`/`-wal`/`-shm`.
- Restore = replace the file; verify with `PRAGMA integrity_check`.

---

## 5. Open questions / what I could not settle

1. **Out-of-cache B-tree behaviour is not measured, and my numbers must not be read as if it were.**
   The 20 M-row store (3.1 GB) and the 11.8 GB volume run both fit inside this machine's 62 GB of RAM,
   so the OS page cache served essentially every read. To make an out-of-cache claim I would have had
   to build a store larger than RAM and drop caches — not done. **The mitigating argument, which I
   believe is strong but is an argument, not a measurement:** roadmap R1 measured the *real*
   deployment as also page-cache-resident (23 GB cache over an 88 GB store, 27 KB/s physical reads,
   CPU-bound at 70 % of one core), so the in-cache regime is the representative one, not a flattering
   artefact. **For the negative case to bite, the deployment would have to become genuinely
   I/O-bound** — a store many times RAM with a random access pattern — and R1 says it is not.
2. **fsync on this machine is not trustworthy.** ext4 on a WSL2 VHDX; `WAL/FULL` measured 11 µs per
   commit, far too fast for a real barrier-to-media fsync. The `NORMAL` vs `FULL` delta (12 %) is a
   **floor**. The *ordering* (WAL >> rollback journal, 6×) is robust; the magnitude of the durability
   knob is not. It does not change the verdict — §3.3 shows the workload is payload-bound, not
   fsync-bound — but a durability-contract decision should be re-measured on real hardware.
3. **No Postgres server was available**, so §3.8's comparison sets a fresh SQLite measurement on this
   box against the *recorded* `bench/baseline.1.0.0-perf-baseline.1.json`, taken in a
   `postgres:17-alpine` container with `shared_buffers=256MB`, possibly on different hardware. The
   **cliff-rule determination** (K = 2.0, super-linearity) is shape-based and survives that; the
   **D = 5000 ms absolute bound** does not — a slower machine could push the 3,573 ms real-reclaim
   pass over it. Re-run `bench/workloads/gc.ts` on one box against both engines before quoting a ratio.
4. **Every measurement is single-writer, no concurrent readers, no `busy_timeout` wait.** Per the
   coordinator's relay of L2's finding that `node:sqlite` is synchronous with no interrupt and that a
   blocking `busy_timeout` pins the JS thread, these are **upper bounds** for a real ingest-plus-read
   workload. I did not model reader contention; that is L2's lane and I flagged the dependency rather
   than duplicating it.
5. **Whether bulk pruning is actually required.** The whole partitioning question turns on it. Nothing
   in the archive prunes today (`chain_blobs` rows are "referenced by permanent, range-partitioned
   rows, never pruned by a manifest-completion event", design doc §4.1), and `blocks.status` has a
   `'pruned'` value nothing writes. If the archive is genuinely append-only forever, the one-table
   design wins outright and Delta 1 should be deleted. **A product question, not a storage question,
   and I could not settle it from the repo.**
6. **`page_size=16384` is recommended on write-cost evidence only.** I did not measure its effect on
   random-key index descent at out-of-cache scale (larger pages => shallower tree, more bytes per
   touch), nor its interaction with WAL frame size. The ~26 % space amplification for mixed content is
   measured; the read-side effect is not.
7. **`sqlar` was not benchmarked.** It is a convention over a `sqlar(name,mode,mtime,sz,data)` table,
   and `chain_blobs` + `chain_blob_roles` is a strictly better fit for content-addressed data. Judged
   out of scope rather than measured; if that judgement is wrong it is a cheap experiment.

---

## 6. Cost estimate

| Work item | Size | Notes |
|---|---|---|
| `001_chain_archive_core` → SQLite DDL | **M** (3–5 d) | Mechanical apart from Deltas 1–3; every constraint verified translatable (§3.9). |
| Partition generator + rollover rewrite | **M** (4–6 d) | Replaces `chain-archive-rollover.ts` (353 → ~60 lines). **S if Delta 1 is dropped.** |
| `chain-archive-store.ts` port | **S–M** (2–4 d) | Already single-row-per-statement (§3.10); mostly type and error-translation churn. |
| `checkpoint-store.ts` bulk-insert path | **S** (1–2 d) | Net *deletion*: sub-batch logic removed, not re-derived (B4). |
| GC / prune port + `DELETE … LIMIT` rewrite | **S** (1–2 d) | `rowid IN (SELECT … LIMIT n)`; re-run the SC-2 curve and re-adjudicate the cliff. |
| ETL sorted-staging backfill stage | **M** (4–6 d) | Optional; 1.8–2.05× and a flat slope (§3.4). Needs a real external sort. |
| Backup/restore mechanism + soak | **M** (3–5 d) | `backup()` wrapper, integrity verification, uncancellability caveat. Contract text is L6's. |
| Re-run `bench/` against SQLite, re-baseline | **M** (3–5 d) | G14 requires the artefact to exist and reproduce structurally; every number changes. |
| **Total for this lane** | **≈4–6 engineer-weeks** | Excluding L1/L2/L3/L4/L6 surfaces. |

**What it breaks.**
- **G4 §6 (backup/restore)** — rewritten, not amended: no `pg_dump`, no schema scoping, whole-file
  granularity, fastest mechanism blocks the process.
- **G4 §3 (cancellation)** — needs a stated exception for backup/`VACUUM`, which cannot be aborted.
- **`CEILINGS.md` SC-2** — recorded GC curve invalidated and must be re-measured; the cliff
  determination itself survives (**not met**) on this hardware.
- **`CEILINGS.md` SC-3** — hardens from "deferred: streaming reconstruction" to "**not fixable under
  `node:sqlite`**": no incremental BLOB I/O binding.
- **`CEILINGS.md` SC-6** (TOAST storage mode) — moot; replaced by a `page_size` decision that is
  irreversible after the first write.
- **`CEILINGS.md` SC-1's deferred IS-3 remediation** (`kv_history` partitioning) — loses its mechanism.
- **G1** — `DEFAULT_SCHEMA` / schema-configurability has no in-file analogue; with B2 this constrains
  how many files the product may have. **L1 owns the resolution.**
- **G3** — unaffected in scope and *improved* in mechanism: `RAISE(ABORT,'<name>')` puts the
  constraint name directly in the error message, removing the Postgres `USING CONSTRAINT =` workaround
  (`001_chain_archive_core.ts:193-204`). **Flagged to L4.**
- **Nothing in the formal cut-line `{T3, T5, W1, C1}`** is touched by this lane. **C2a** survives with
  a *simpler* mechanism argument (single-writer serialisation replaces the `FOR SHARE`/`FOR UPDATE`
  two-session proof), which strengthens rather than weakens its MECHANISM-SPECIFIED status — but it
  becomes conditional on `BEGIN IMMEDIATE`, which is **L2's** to guarantee.
