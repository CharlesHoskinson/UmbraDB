# Design — v1.0.0 SQLite Chain Archive

Technical design for change `v1.0.0-sqlite-chain-archive`, capability `chain-archive`.

Per `openspec/config.yaml`'s design rule, every decision below that touches an existing one cites
`design/design.md`, `design/design-interfaces.md` or `Formal/STORAGE_ALGEBRA.md` **by section
number**, and additionally `design/full-chain-storage-design.md`, which is this capability's own
design document and the thing being ported. Per its correctness rule, every external-API and
engine-behaviour claim below was verified against the installed binding on this machine, with the
command and its output recorded — not asserted from a lane report.

---

## 0. What this change is handed, and what it must not decide

| From | What is handed over | Where it is used here |
|---|---|---|
| **change 1** (`v1.0.0-sqlite-engine-core`) | The ruled binding and its pin; the `postgres.js`-shaped tagged-template shim; origin-keyed row decoding; the worker topology; the ordered, once-only pragma bootstrap; the ext4 measurement gate | §5 (DDL is written through the shim), §7 (write path), §3.6 (`auto_vacuum` dependency), §12 (every measurement obligation) |
| **change 1**, two engine facts | `SQLITE_MAX_LENGTH = 1000000000` caps any single BLOB; **no** incremental BLOB I/O exists on either binding (L5's claim that `better-sqlite3` provides it was refuted by the contradiction seat, and §5.6's prototype listing confirms no such member) | §6 (blob strategy), §15 Q-A3 |
| **change 3** (`v1.0.0-sqlite-concurrency-lease`) | `BEGIN IMMEDIATE` on every write path; the JS poll loop; sticky-poison emulation; contention error mapping | §7.1, §8.1 |
| **change 4** (`v1.0.0-sqlite-schema-parity`) | `qualify(schema, name)` prefixing for tables, indexes **and** triggers; the `STRICT` obligation; the PostgreSQL→SQLite type mapping; the `coalesce(…)` expression-index form for a nullable uniqueness key | §5 throughout, §5.5 |
| **change 5** (`v1.0.0-sqlite-durability-contract`) | The choice of copy primitive (B-6); the durability probe's asserted pragmas (B-7); the application-level digest regime; the `synchronous` decision rule; the string-`code` error discriminator | §9.2, §9.6, §10, §8.2 |

**What this change must not decide, and does not:** the driver, `page_size`, `auto_vacuum`'s *value*,
`synchronous`'s *value*, the copy primitive's *name*, the batch chunk size, or any number that
depends on a measurement. Where the design turns on one of those, it states the dependency and the
decision rule rather than the answer.

---

## 1. Scope: the archive is wired, and I verified it rather than repeating either claim

`src/postgres/migrations/chain_archive/001_chain_archive_core.ts:86` and `…/index.ts:25` both say the
lineage is not wired. Both comments predate `chain-archive-sync/`, whose own `bootstrap.ts:6-7`
records that *"the real invocation path `chainArchiveMigrations` was missing"* — i.e. that directory
exists precisely to close the gap the older comments describe. Verified against this worktree
(`sprint/sqlite-migration`, cut from `3c0c68b`):

```
$ cd /root/UDB-sqlite-sprint && sed -n '46p' package.json
    "archive:sync": "tsx chain-archive-sync/sync-cli.ts",

$ grep -n 'bootstrapChainArchiveSchema\|createClient\|PgChainArchiveStore\|runMigrations' \
    chain-archive-sync/sync-cli.ts chain-archive-sync/bootstrap.ts chain-archive-sync/sync-service.ts
chain-archive-sync/sync-cli.ts:22:import { bootstrapChainArchiveSchema } from "./bootstrap.js";
chain-archive-sync/sync-cli.ts:37:const sql = createClient({ connectionString: CONN, schema: SCHEMA });
chain-archive-sync/sync-cli.ts:38:await bootstrapChainArchiveSchema(sql, SCHEMA);
chain-archive-sync/bootstrap.ts:1:import { runMigrations } from "../src/postgres/migrate.js";
chain-archive-sync/bootstrap.ts:21:  await runMigrations(sql, { schema, migrations: chainArchiveMigrations });
chain-archive-sync/sync-service.ts:123:    this.store = new PgChainArchiveStore(opts.sql, opts.schema ?? "chain_archive");

$ grep -n 'chain-archive-sync' tsconfig.json tsconfig.build.json
tsconfig.json:15:    "chain-archive-sync/**/*.ts",
tsconfig.build.json:15:    "chain-archive-sync"
```

`tsconfig.json:15` puts the directory inside `npm run typecheck`; `tsconfig.build.json:15` keeps it
out of `npm run build`. That asymmetry is R-1's closing condition (change 1 `design.md` §10.1) and
§11 below is where this change discharges it.

**The two facts that are actually true.** (a) The lineage *is* reachable from a real npm script.
(b) It has **no data and no production consumer** — `archive:sync` has never been run against a real
database (owner answer 2), and the one integration test that exercises it end-to-end,
`test/integration/chain-archive-sync.integration.test.ts`, is `describe.skipIf`-skipped whenever the
local devnet is unreachable, *"the NORMAL state in CI"* by that file's own header comment
(`:19-27`). A green CI run has never proved anything about this path. Both facts matter, and
conflating them is what produced the stale non-goal.

**Consequence for scope.** Change 1 removes the `postgres` dependency outright rather than retaining
it scoped to `chain-archive-sync/` (R-1). With `postgres` gone, this directory fails `npm run
typecheck` at `chain-archive-sync/bootstrap.ts:1` and `sync-service.ts:1`. Porting it is not
optional; the alternative is deleting a production entry point the owner has just asked to build a
snapshot capability on top of.

---

## 2. File layout: the archive is its own database file

### 2.1 The ruling

`umbra-archive.sqlite` (the `chain_archive` lineage) is a **separate file** from the wallet tier's
`umbra.sqlite`. No transaction spans them; no `ATTACH` connects them.

### 2.2 Why, and why L5's contrary rule does not apply

L5 §4 ruled *"One database file. Not per-tier, not per-height-range,"* justified by L2's constraint
that a transaction must not span files. The contradiction seat found that L5 **generalised** L2's
constraint from *"one transaction must not span files"* to *"the product must have one file"*, and
that the repo settles which applies. It ruled **two files** (C5, `council/contradiction.md` §2.4),
and the repo facts it cited are still true here:

- `src/postgres/chain-archive-store.ts:122` — `private readonly schema: string = "chain_archive"`,
  a separate schema from `DEFAULT_SCHEMA = "umbradb"` (`src/postgres/client.ts:14`).
- `001_chain_archive_core.ts:717-745` gives the archive its **own** `watermarks` table, with the
  comment stating it is *"chain_archive's OWN local watermark-equivalent table, NOT a reuse of
  `tier1_wallet.watermarks`"* — the shared-table design recorded as deliberately rejected, because
  *"a chain_archive-only deployment/backup/restore could no longer be self-contained."*
  `design/full-chain-storage-design.md` §5 says the same thing at length.

So no transaction spans the tiers today, by construction, and the tiers were engineered apart
specifically so that a **self-contained archive backup** would be possible. The owner's snapshot
request is the use case that decision was made for. Splitting the files is the SQLite expression of a
boundary the schema already draws.

### 2.3 Why this does not contradict change 4

Change 4's `specs/storage-schema/spec.md:81` requires that *"schema emulation SHALL NOT be
implemented as one database file per schema."* That governs the **multi-tenant `schema` parameter**
— an arbitrary, free-form, caller-supplied string that would be capped at eleven tenants by
`SQLITE_MAX_ATTACHED` and could not express intra-lineage foreign keys. This change splits by
**lineage**, of which there are exactly two, fixed at build time. That is L4's option (b), and the
contradiction seat's §2.9 recommendation is verbatim *"file-per-lineage, prefix-within-file for
multi-tenant `schema` values."* Both hold simultaneously: within `umbra-archive.sqlite`, the
`schema` parameter is still emulated by change 4's name prefixing, and `assertValidSchemaName`
still runs (`src/postgres/migrate.ts` validates `opts.schema` before any migration runs, and
`001_chain_archive_core.ts:107` re-asserts it).

### 2.4 The cost, stated

A cross-tier transaction becomes unavailable **forever**. There is no escape hatch: §4 shows
`ATTACH` is not one. Nothing in the repo needs one today, and the guard against acquiring the need
later is a test (task 2.3) asserting no transaction handle is ever passed across the tier boundary —
the property the contradiction seat named as what keeps this decision safe.

---

### 2.5 The archive file needs its own writer-generation guard, and it did not have one

`archive:sync` is a standalone, long-running CLI (§11). An operator can start it twice against the
same file. Nothing in this change detected that until the round-2 audit, and the reason is a clean
example of how a deferral outlives its premise: change 3 wrote *"the archive file, if it is ever
wired, gets its own registration under its own change"* — a correct handover, made when the archive
was believed unwired. When the archive came into scope, **the deferred item did not travel with it.**
The grep was empty against the live tree.

**Why it is not covered by anything else.** Every exclusivity argument in this change — the
row-lock-removal justification of §5.3, the single-transaction ingest bundle of §7.2, `prune`-style
reasoning inherited from change 3 — is phrased as resting on "single-writer serialization". That
phrase is doing more work than it can carry: **SQLite serializes transactions; it does not make a
process a single writer.** Two `archive:sync` processes interleave `BEGIN IMMEDIATE` transactions
entirely legally. Each transaction is atomic; the sequence of them is not, and nothing detects the
second process.

**What this change adds.** A `writer_generation` table in the archive lineage, mirroring change 3's
mechanism rather than inventing a second one: a single seeded row carrying a monotonic `generation`
and a per-open `owner`; a bump inside `BEGIN IMMEDIATE` at open; and a re-read inside every write
transaction, before any write, rejecting non-retryably when the generation differs. No pid, no host,
no heartbeat, no TTL, no lock file — those are diagnostics at most.

**With the I-4 assertions from day one.** Change 3's registration `UPDATE` shipped without asserting
its affected-row count, which recreates the zero-row silent-success class *on the guard's own
bootstrap*: if the seeded row is absent the statement affects nothing, the process proceeds with an
undefined generation, and every later comparison is made against it. Change 3 is adding the
assertions; the archive takes them from the first migration rather than importing the defect and
repairing it later. Concretely: assert exactly one row affected, and read back the owner and
generation just written, failing with a named non-retryable startup error if either does not hold.

**And the source guard extends here.** Change 3's build-failing ban on opening a descriptor on a
database file or its `-wal`/`-shm` sidecars was written for the wallet file. The archive file has the
same POSIX-record-lock exposure and had no coverage at all. The ban now covers the archive artifact
set including indirectly derived paths — which is also what forces §9's snapshot tooling
out-of-process (§9.8).

Ownership is exactly one change: this change owns the guard and the migration; change 3 owns the
mechanism it is mirrored from and the handover record.

---

## 3. The physical layout: `PARTITION BY RANGE` has no equivalent, and its substitute is not worth building

`001_chain_archive_core.ts:275,395,456` declare `blocks`, `transactions` and `bridge_observations`
as `PARTITION BY RANGE` over their height column, with five pre-created 1,000,000-height buckets plus
a `DEFAULT` catch-all (`partition-config.ts:16,26`). SQLite has no declarative partitioning at all.

The PostgreSQL feature bought three things: partition pruning, per-partition maintenance, and **cheap
bulk retirement of an old height range**. Only the third was ever load-bearing for this schema, and
§3.2 shows it does not survive measurement.

### 3.1 The ruling

**One table per relation.** `blocks`, `transactions` and `bridge_observations` are each a single
`STRICT` table with the primary key unchanged. There is no `UNION ALL` view, no `INSTEAD OF` routing
trigger, no per-range child table and no `DEFAULT` catch-all.

An earlier draft of this design made the layout a *conditional* choice: table-per-range would be
adopted if a written retention requirement existed **and** `auto_vacuum` was enabled at file
creation. That condition is now withdrawn, because §3.2's measurement shows it would have selected
table-per-range in exactly the case where table-per-range has no advantage left. The withdrawal is
recorded rather than quietly applied, because the retracted reasoning is the reasoning a future
reader will rediscover in L5.

### 3.2 Why: `DROP TABLE` has no space or cost advantage over `DELETE` at any `auto_vacuum` setting

L5's B1 is the entire case for a table-per-range layout: *"`DROP TABLE` of a 1 M-row range is 35 ms
and returns the space, versus 1,296 ms for the equivalent `DELETE`, which returns nothing (951 MB
file unchanged, 46,396 free pages)."*

I first found that the space half of that claim is conditional on `auto_vacuum`, which L5 never
varied. Change 1 then re-measured across all three settings and found something stronger: the claim
fails at **every** setting, not only at the default. I reproduced that independently on a different
harness before adopting it — a composite-primary-key table with a secondary index, so index
maintenance is represented rather than only heap pages, at two scales two orders of magnitude apart.

Conditions: `better-sqlite3@13.0.2`, SQLite 3.53.4, `/root` on ext4 (`/dev/sdd`), `journal_mode=WAL`,
`PRAGMA wal_checkpoint(TRUNCATE)` around every step, two tables of the stated row count, file size
measured on disk.

```
av=default rows=6000   payload=4096B  actual_av=0  DROP  : 55172 -> 55172 KB (returned     0) freelist=6896  in   7.0 ms
av=default rows=6000   payload=4096B               DELETE: 55172 -> 55172 KB (returned     0) freelist=6893  in   6.7 ms
av=FULL    rows=6000   payload=4096B  actual_av=1  DROP  : 55240 -> 27624 KB (returned 27616) freelist=0     in 132.7 ms
av=FULL    rows=6000   payload=4096B               DELETE: 55240 -> 27636 KB (returned 27604) freelist=0     in 129.4 ms
av=INCR    rows=6000   payload=4096B  actual_av=2  DROP  : 55240 -> 55240 KB (returned     0) freelist=6896  in   7.1 ms
av=INCR    rows=6000   payload=4096B               DELETE: 55240 -> 55240 KB (returned     0) freelist=6893  in   6.7 ms

av=default rows=120000 payload=256B   actual_av=0  DROP  : 97516 -> 97516 KB (returned     0) freelist=12189 in  20.8 ms
av=default rows=120000 payload=256B                DELETE: 97516 -> 97516 KB (returned     0) freelist=12186 in  20.5 ms
av=FULL    rows=120000 payload=256B   actual_av=1  DROP  : 97636 -> 48820 KB (returned 48816) freelist=0     in 221.9 ms
av=FULL    rows=120000 payload=256B                DELETE: 97636 -> 48832 KB (returned 48804) freelist=0     in 258.3 ms

INCREMENTAL rows=120000 DROP TABLE r1 : 97636 -> 97636 -> 48820 KB  op=19.9 ms  incremental_vacuum=194.0 ms
INCREMENTAL rows=120000 DELETE FROM r1: 97636 -> 97636 -> 48832 KB  op=16.8 ms  incremental_vacuum=188.9 ms
```

**Reading, in the order the conclusions fall.**

1. **At `auto_vacuum=0` and at `INCREMENTAL` without an explicit vacuum, neither operation returns a
   byte to the filesystem.** Both leave the same freelist (6,896 against 6,893 pages; 12,189 against
   12,186). This is the finding I originally recorded, and it stands.
2. **At `FULL`, *both* operations return the space, within 0.05% of each other** (27,616 against
   27,604 KB; 48,816 against 48,804 KB). So the setting that makes `auto_vacuum` "hold" — the second
   half of the withdrawn condition — is precisely the setting at which `DELETE` reclaims just as
   well. The condition would have selected the complex layout exactly where its justification had
   evaporated. That is the coordinator's point and it is correct.
3. **The reclaim cost is a property of the pages freed, not of how they were freed.** The clearest
   evidence is the `INCREMENTAL` pair: the operations themselves cost 19.9 ms and 16.8 ms, and then
   `PRAGMA incremental_vacuum` costs **194.0 ms and 188.9 ms** — a 2.6% difference across two
   completely different mechanisms for freeing the same pages. Space reclamation is orthogonal to the
   `DROP`-versus-`DELETE` choice. This is the structural statement that closes the question, and it
   is the reason no future measurement is likely to reopen it.
4. **No latency advantage appears at either scale.** At `auto_vacuum=0` the two are within 2%
   (7.0/6.7 ms; 20.8/20.5 ms). At `FULL` they are within 3% at 6,000 rows and `DROP` is 14% *faster*
   at 120,000 — the opposite direction from change 1's harness, which measured `DROP` at 62.7 ms
   against `DELETE` at 2.8 ms.

**On that disagreement, stated rather than smoothed over.** Change 1 measured `DROP` roughly 22×
slower than `DELETE` at `auto_vacuum=FULL`; I measured them comparable, in one case with `DROP`
faster. I did not reproduce the 22×, and I am not adopting a figure I could not reproduce. The most
likely cause is harness shape — my tables carry a secondary index and a composite primary key, and at
`FULL` the dominant cost in both runs is the commit-time page relocation, which is a function of
pages moved and therefore similar for both operations. **The disagreement does not matter to the
ruling**, and that is worth saying plainly: change 1's numbers and mine both refute L5's claim that
`DROP TABLE` is the cheap path and `DELETE` the expensive one. They disagree only about which is
marginally worse, and neither direction supports building a table-per-range layout. Whichever harness
is right, the conclusion is the same, which is the useful property of a result that does not depend
on a contested number. If a requirement ever needs the direction settled, it becomes an obligation
under change 1's gate (§12, M-4).

### 3.3 The three candidate justifications that were considered, and why each fails

Because the original justification is gone, each remaining argument for table-per-range was checked
individually rather than the layout being dropped by default.

- **Bulk-drop latency at range granularity.** Refuted above at two scales. `DELETE` of a whole range
  is one statement in one implicit transaction; it is not obliged to be chunked, and unchunked it is
  within noise of `DROP TABLE`.
- **Atomicity of retirement.** Initially the strongest survivor: a bounded delete loop retires a range
  across many commits, leaving it observably half-retired, while `DROP TABLE` is a single DDL
  transaction. Measured:

  ```
  chunked DELETE (5000/txn): 97636 -> 48832 KB in 25 transactions, 429.1 ms total, remaining=0
  ```

  But the premise is false: nothing requires range retirement to be chunked. An unbounded
  `DELETE … WHERE height < X` is one transaction and reclaims identically (line 2 of the `FULL` pair
  above). The chunked form exists to bound the write-lock hold, which is a separate decision that
  applies equally to a `DROP`-based design. So the atomicity difference is a property of *chunking*,
  not of `DROP` versus `DELETE`.
- **Bounded index depth per arm.** Real in principle — a per-arm index is shallower than one index
  over all heights. But it is a *read* argument, and it must be weighed against the read cost the
  same layout imposes: §3.4's measurement shows every arm is searched on every query, with no
  partition elimination whatsoever. Trading a possible fraction of a b-tree level for a measured
  linear fan-out across arms is not a trade worth making, and the archive's read pattern is
  point-and-range lookups by height, which one index serves in a single descent.

**None survives. Form B is folded into Form A**, and the layout is unconditional.

### 3.4 What the folded-away layout would have cost, recorded so it is not re-proposed

The table-per-range design is not merely unnecessary; it carries two measured hazards and one
measured penalty. These are recorded because L5's retracted argument is persuasive on first reading
and someone will re-propose the layout.

**Penalty — SQLite performs no partition elimination.** Three arms, each with a range `CHECK` that
*proves* it cannot contain a matching row, queried through a `UNION ALL` view:

```
B2 view range-query plan (CHECKs prove p0/p2 cannot match):
["COMPOUND QUERY","LEFT-MOST SUBQUERY",
 "SEARCH blocks_p0 USING COVERING INDEX sqlite_autoindex_blocks_p0_1 (net=? AND height>? AND height<?)","UNION ALL",
 "SEARCH blocks_p1 USING COVERING INDEX sqlite_autoindex_blocks_p1_1 (net=? AND height>? AND height<?)","UNION ALL",
 "SEARCH blocks_p2 USING COVERING INDEX sqlite_autoindex_blocks_p2_1 (net=? AND height>? AND height<?)"]
B3 direct child plan:
["SEARCH blocks_p1 USING COVERING INDEX sqlite_autoindex_blocks_p1_1 (net=? AND height>? AND height<?)"]
```

Every arm is searched; the `CHECK` constraints are not consulted by the planner. The arm count is
additionally capped:

```
C arms=499: OK
C arms=500: OK
C arms=501: too many terms in compound SELECT
```

**Hazard 1 — a view is not insertable, and the obvious routing trigger silently discards rows.**

```
B1 insert into view without INSTEAD OF: cannot modify blocks because it is a view
B4 with INSTEAD OF trigger, p0 count = 1
B5 out-of-range insert via trigger: NO ERROR, view total rows = 2 (row silently dropped)
```

The natural trigger — one `INSERT … SELECT … WHERE <range predicate>` per arm — accepts a row whose
height falls outside every arm, raises nothing, and stores nothing. The caller observes a successful
insert of a row that does not exist. That is strictly worse than the PostgreSQL `DEFAULT` partition
it replaces, which at least stored the row. A guard arm closes it, and works:

```
T1 guarded trigger, out-of-range: chain_archive_no_range_for_height
T2 rows retained = 2
```

This finding stands independently of the layout ruling, and it is why the spec keeps the layout as a
**prohibition with named revival conditions** rather than simply not mentioning it: if the layout is
ever revived, the guard is not optional.

**Where the generator actually lives.** `createHeightPartitions` and its `sql.unsafe()`
partition-bound path are defined in `src/postgres/migrations/chain_archive/001_chain_archive_core.ts`
— **not** in `chain-archive-rollover.ts`, which is a separate 353-line file implementing the rollover
runbook. Both are deleted, but they are two deletions in two files, and an earlier draft of the
deletion inventory attributed the generator to the rollover file.

**Hazard 2 — the `DEFAULT` catch-all.** In PostgreSQL it was the cause of all four rollover failure
modes reproduced against a real server at `design/full-chain-storage-design.md` §4.6 — the retained-FK
detach failure, the `duplicate_table` on recreate, the write race that makes the subsequent `ATTACH`
fail, and `DETACH … CONCURRENTLY` refusing outright whenever a default partition exists. Under the
single-table ruling all four become inapplicable, and `src/postgres/chain-archive-rollover.ts`'s 353
lines are deleted outright (§13). They are recorded as **retired with reason**, not silently dropped.

### 3.5 One correction that survives in the folded-away layout's favour

Recorded for completeness, because it was a genuine finding and because a revival proposal should
inherit the accurate version rather than L5's.

L5 states that splitting the table loses `blocks_one_canonical_per_height`'s global enforcement:
*"each child gets its own index and cross-child uniqueness becomes an application invariant."* That
is over-stated, and the migration's own comment contains the reason
(`001_chain_archive_core.ts:219-236`: the PostgreSQL partial unique index is global *because*
`height` is the partition key). Verified:

```
U1 same-arm second canonical: UNIQUE constraint failed: b_p0.net, b_p0.h
U2 cross-arm duplicate at one height is unrepresentable iff the range CHECKs partition the key space
```

A given `(net, height)` lives in exactly one arm when the range `CHECK`s are disjoint and the guard
arm makes them total, so per-child partial unique indexes are collectively equivalent to the single
PostgreSQL index. Under the ruled single-table layout the question does not arise at all: one partial
unique index on `blocks(net, height) WHERE is_canonical` enforces it globally and directly, which is
the simplest possible outcome and one more reason the single table is the right ruling.

### 3.6 `auto_vacuum` is still a decision this change depends on, for a different reason

Folding away the layout removes `auto_vacuum` as a *layout* input, but not as an input. Two things
still turn on it, and both are change 1's B-3:

- **Whether retired space ever returns to the filesystem at all.** At `auto_vacuum=0` the archive
  file is monotonically non-shrinking regardless of what is deleted, short of a full `VACUUM` with its
  exclusive lock and transient double disk usage. For an append-mostly archive that may be the right
  answer; it must be a decision rather than a default.
- **Snapshot artifact size.** `auto_vacuum` is recorded in the snapshot manifest (§9.4) and asserted
  on restore (§9.6), because it is irreversible and a restore cannot repair it.

And the ordering trap is reconfirmed on the ruled binding — setting `journal_mode=WAL` first leaves
`auto_vacuum=0` permanently, with both orderings reporting success:

```
F1 auto_vacuum at creation (WAL set first): 0
F2 after PRAGMA auto_vacuum=INCREMENTAL on populated db: 0
F3 after full VACUUM: 2
F4 correct order (page_size,auto_vacuum,WAL): page_size=16384 auto_vacuum=2
```

---

## 4. `ATTACH`-per-range and per-tier-inside-one-file are both prohibited

`ATTACH` is the closest structural analogue to Postgres partitions, and it is dead three ways over.
Re-verified here on the ruled binding rather than accepted from L5/L2:

```
A1 attached=10 then: too many attached databases - max 10
compileopt MAX_ATTACHED: MAX_ATTACHED=10
A2 cross-db FK: near ".": syntax error
```

1. **`SQLITE_MAX_ATTACHED = 10`**, compile-time in the ruled binding's bundled SQLite. Ten databases
   plus `main`. Raising it needs a recompile of the shipped native module.
2. **Cross-database foreign keys do not exist.** `REFERENCES main.chain_blobs(hash)` is rejected at
   parse time. Every FK in `001_chain_archive_core.ts` (lines 139, 258, 259, 390, 394, 452, 455, 539)
   would either have to live in one file or stop being enforced.
3. **A WAL transaction spanning attached databases is not atomically committed.** SQLite's atomic
   multi-database commit requires a super-journal, and WAL does not create one. Reproduced
   independently by two lanes under SIGKILL-mid-commit: **1 of 12** WAL trials left the two files
   disagreeing, against **0 of 16** with a rollback journal, with `main.db-mj<hex>` super-journal
   files visible in the rollback-journal listings and never in the WAL ones. Not re-reproduced here;
   two independent reproductions is sufficient and the mechanism is documented upstream.

This is recorded as a **prohibition requirement** rather than a design note, because it is the
obvious thing for a future reader to re-propose — it is the shape Postgres partitions have, and its
first two failures (a limit and a parse error) are loud while its third (a torn commit under crash)
is silent and rare.

---

## 5. DDL translation, constraint by constraint

The lineage is `[migration000, chainArchiveCore]` (`…/chain_archive/index.ts:32`). Every object name
goes through change 4's `qualify(schema, name)` — **including index and trigger names**, which are
global per database file in SQLite where Postgres scoped them per schema.

### 5.1 The mapping table

| `001_chain_archive_core.ts` | SQLite form | Note |
|---|---|---|
| `bytea` | `BLOB` | change 4's type mapping |
| `text` | `TEXT` | |
| `bigint` / `integer` | `INTEGER` | |
| `boolean` | `INTEGER` + `CHECK (col IN (0,1))` | `STRICT` has no boolean; the `CHECK` restores the domain |
| `timestamptz NOT NULL DEFAULT now()` (`:124`, `:271`, `:392`, …) | `INTEGER NOT NULL` (Unix epoch ms) | no `timestamptz`; `STRICT` rejects the declared type outright. Written by the adapter, not by a column `DEFAULT`, so the value is the shim's normalised form and cannot drift between engines |
| `jsonb` (`watermarks.value`, `:733`) | `TEXT` holding JSON | change 4 owns the general `jsonb` ruling; the archive's only instance is this column |
| `size_bytes integer GENERATED ALWAYS AS (octet_length(data)) STORED` (`:123`) | `INTEGER GENERATED ALWAYS AS (length(data)) STORED` | `length()` on a BLOB returns bytes. Legal on a **0-row** table, which every table in this lineage is at creation |
| `PRIMARY KEY (net, height, block_hash)` (`:274`) | same | composite PKs are fine; the table stays a **rowid** table (§6.2) |
| `UNIQUE (net, block_height, block_hash, position)` (`:392`) | same | |
| composite FK `(net, block_height, block_hash) → blocks(net, height, block_hash)` (`:394`, `:455`) | same | composite FK to a composite PK is supported; requires `PRAGMA foreign_keys=ON` (§5.4) |
| `CREATE UNIQUE INDEX … ON blocks (net, height) WHERE is_canonical` (`:281`) | same | partial unique indexes are supported |
| `CREATE INDEX … WHERE contract_address IS NOT NULL` (`:585`) | same | |
| `UNIQUE NULLS NOT DISTINCT (…)` (`:570`) | **change 4's ruled form** — `coalesce(contract_address, x'')` expression index **plus** a sentinel-excluding `CHECK` | §5.5 |
| `CHECK ((status = 'canonical') = is_canonical)` (`:270`) | same, with `is_canonical` as 0/1 | biconditional over integers behaves identically |
| `CHECK (NOT finalized OR is_canonical)` (`:277`) | same | |
| `id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY` (`:538`) | `INTEGER PRIMARY KEY` (rowid alias) | monotonic, gapless-not-guaranteed in both |
| plpgsql trigger functions + `CREATE TRIGGER` (`:295-360`, `:410-430`, `:465-485`, `:590-610`, `:700-715`) | `CREATE TRIGGER … BEFORE … FOR EACH ROW WHEN <cond> BEGIN SELECT RAISE(ABORT,'<name>'); END` | §5.3 |
| `SELECT … FOR SHARE` / `FOR UPDATE` inside the guard functions (`:605-654`) | **deleted** | §5.3 |
| `WITH (fillfactor = 90)` (`:735`) | **deleted, recorded** | a Postgres HOT-update tuning knob with no SQLite analogue; SQLite has no equivalent page-fill concept |
| `PARTITION BY RANGE` (`:275`, `:395`, `:456`) + `createHeightPartitions` | **deleted** — one table per relation (§3.1) | the partition key remains an ordinary indexed column |
| `sql.unsafe()` for partition-bound DDL (`:769-777`) | **deleted** with the partitions | the reason it existed — PostgreSQL rejecting a bind parameter in a `FOR VALUES` position — does not arise |

### 5.2 What is *not* translated

`design/full-chain-storage-design.md` §7's five deferred categories stay deferred and stay flagged
**UNVERIFIED**. `block_undo` stays cut (§6 of that doc). No table is added, removed or reclassified.
A port is not a redesign, and the design doc's phasing table (§11) is carried across unchanged.

### 5.3 Triggers: the guards survive, the locking does not, and one thing gets *worse*

Every plpgsql guard becomes a `BEFORE` trigger with a `WHEN` clause and `SELECT RAISE(ABORT,'<name>')`.
Four guards translate: `chain_archive_assert_blob_role` (four call sites: `blocks`,
`transactions`, `bridge_observations`, `verifier_key_observations`),
`chain_blob_roles_guard_removal`, `blocks_finalized_monotonic`, and the `chain_archive_assert_role_removable`
helper. Each is declared once, on the one table it guards. SQLite has no partitioned-parent trigger
cloning — the mechanism `001_chain_archive_core.ts:117-125` records PostgreSQL providing — which
under a table-per-range layout would have meant redeclaring every guard on every arm and
regenerating them at each rollover. The single-table ruling (§3.1) removes that entirely.

**The `FOR SHARE`/`FOR UPDATE` row locking is deleted.** `001_chain_archive_core.ts:605-654` records
a two-concurrent-session lock-ordering proof for the blob-role removal guard. SQLite serialises
writers, so both interleavings collapse to "the other transaction has already committed or has not
started." That argument is **conditional on `BEGIN IMMEDIATE` on every archive write path**, which
is change 3's to guarantee and §7.1's to use. This is the same simplification the wallet tier's C2a
justification gets (change 3's spec, "prune's C2a justification is re-derived from `BEGIN IMMEDIATE`").

**And one thing gets worse, which L5 recorded backwards.** L5 §B8 calls
`RAISE(ABORT,'<constraint-name>')` *"cleaner than the Postgres `USING CONSTRAINT =` workaround at
`001_chain_archive_core.ts:193-204`"* and flags it as a G3 opportunity. Measured on the ruled binding
(§8.2), the constraint name is available **only in the message string**. Postgres supplies it in a
structured field. That is a regression, not an improvement, and §8.2 specifies how it is contained.

### 5.4 `PRAGMA foreign_keys` is a precondition, not an assumption

Every FK in this lineage is enforced only if `foreign_keys` is ON, and SQLite's default is OFF. The
pragma is change 1's bootstrap and change 4's asserted schema precondition; this change adds an
archive-specific assertion that the *archive* connection has it on before the lineage applies,
because the archive is opened by a different code path (`chain-archive-sync/bootstrap.ts`) than the
wallet tier.

### 5.5 `UNIQUE NULLS NOT DISTINCT` — change 4's form, adopted by citation, re-verified on this key

`verifier_key_observations`'s `UNIQUE NULLS NOT DISTINCT (vk_hash, net, scope, contract_address, tag)`
(`:570`) exists so that two protocol-scoped observations with `contract_address IS NULL` collide.
`001_chain_archive_core.ts:522-529` records that *"ordinary `UNIQUE` … would NOT have caught that
duplicate"*, and `:63-70` records the v4 audit finding it closes: *"two legitimate different-entry-
point observations of the same VK collided and one silently lost the race."*

Change 4's ruled form is a `coalesce(<col>, <sentinel>)` unique expression index **plus** a `CHECK`
excluding the sentinel from the column's real domain, and its spec includes the negative control.
This change **adopts that form and does not restate the rule**. It re-verifies the form against this
table's actual key, on the ruled binding, because this is the only instance of it in the repo and it
is the reason change 4 could state the rule at all:

```
E1 naive UNIQUE, duplicate NULL-address row: ACCEPTED -> reintroduces the v4 bug
E2 coalesce index, duplicate NULL-address row: UNIQUE constraint failed: index 'vko_fixed_identity'
E3 distinct-net NULL-address rows both persist: count=2
E4 zero-length sentinel value: CHECK constraint failed: contract_address IS NULL OR octet_length(contract_address) > 0
```

The upsert target moves with the index: `ON CONFLICT (vk_hash, net, scope, coalesce(contract_address,
x''), tag) DO UPDATE SET first_seen_height = min(…)`. SQLite's two-argument `min()` is Postgres's
`LEAST`, which is what `001_chain_archive_core.ts:558-561` requires callers to use.

### 5.6 Engine limits re-read on the ruled binding, not carried from a lane

L5 read its compile options from `node:sqlite`. The ruled binding is a different build of SQLite and
its limits had to be re-read, not assumed:

```
binding: better-sqlite3@13.0.2
sqlite_version: 3.53.4
compileopt MAX_ATTACHED: MAX_ATTACHED=10
compileopt MAX_COMPOUND_SELECT: MAX_COMPOUND_SELECT=500
compileopt MAX_VARIABLE_NUMBER: MAX_VARIABLE_NUMBER=32766
compileopt MAX_LENGTH: MAX_LENGTH=1000000000
compileopt DEFAULT_PAGE_SIZE: DEFAULT_PAGE_SIZE=4096
compileopt ENABLE_UPDATE_DELETE_LIMIT: ENABLE_UPDATE_DELETE_LIMIT
compileopt THREADSAFE: THREADSAFE=2
proto has backup(): true
proto members: constructor,prepare,transaction,pragma,explain,backup,serialize,function,aggregate,
               table,loadExtension,exec,close,defaultSafeIntegers,unsafeMode
```

**One of these differs from L5 in a way that matters.** L5 B4 states *"`DELETE … LIMIT` is a syntax
error (`SQLITE_ENABLE_UPDATE_DELETE_LIMIT` not compiled in)"*, and treats the loss as removing the
mechanism `CEILINGS.md` SC-2 names as its conditional remediation. On the **ruled** binding that
option **is** compiled in:

```
D1 DELETE..LIMIT: ACCEPTED (unexpected)
D2 rowid-IN rewrite left 1 rows
```

So `DELETE … LIMIT` is available here, and the `DELETE … WHERE rowid IN (SELECT rowid … LIMIT n)`
rewrite is not forced. **This change nevertheless specifies the rewrite**, for a reason unrelated to
availability: a query whose validity depends on a compile option that no lockfile pins is a
supply-chain-shaped hazard, not a query.

**Change 1 has since generalised this into a requirement, and this change defers to it rather than
restating it.** Its pinned-binding requirement now obliges the supply-chain inventory to record the
binding's compiled option set and forbids UmbraDB from issuing SQL whose validity depends on an
option that is not recorded and asserted, with a negative control written against *dependence*
rather than *availability* — because a rebuild of the same binding version can drop an option
without changing the version string. The archive's bounded-delete requirement is therefore an
**application** of that rule to one statement, not a second rule; it asserts no compile-option
value of its own, and the inventory obligation is change 1's. The finding is still recorded here so
that nobody re-derives L5's conclusion that the rewrite is *forced*, which it is not.

`SQLITE_MAX_LENGTH = 1000000000` and the absence of an incremental-BLOB member on the prototype are
change 1's two handed-over facts, confirmed here rather than taken on trust.

---

## 6. Blob storage stays in the database

### 6.1 The ruling and its evidence

`chain_blobs.data` stays in the database. The archive's real payload distribution was measured
directly from the deployed indexer's own SQLite files — a *data* measurement, not a timing one, and
therefore not affected by the tmpfs contamination:

```
/root/midnight-testnet/indexer-data/indexer.sqlite
transactions.raw length: min 41, max 145167, avg 7433.0
percentiles [min,p50,p90,p99,max] = [41, 5893, 11987, 29158, 145167]
buckets: <64:1  <256:31  <1K:20  <4K:41  <16K:235  <64K:30  >=64K:1
```

p50 ≈ 5.9 KB, p90 ≈ 12 KB, p99 ≈ 29 KB, max ≈ 145 KB — three to four orders of magnitude below
`SQLITE_MAX_LENGTH`. External files would cost foreign-key enforcement, transactional consistency
between a blob and the metadata row that references it, and — decisively for this change — the
**single-file snapshot artifact** that §9 is built on. A snapshot that is a database file plus a
sidecar directory of loose blobs is not the artifact the owner asked for.

### 6.2 What is an obligation to measure, not a fact

L5's in-database/filesystem crossover ("between 16 KB and 64 KB at `page_size=4096`") and its
page-size sweep are **timing** measurements taken against `/tmp` on a host where `/tmp` is a 32 GB
tmpfs. They are not carried into this change. What is specified instead is an obligation
(§12, M-3): establish the crossover under change 1's gate conditions, and record that
`page_size` is irreversible after creation and is change 1's B-3, not this change's to choose.

Two related facts *are* structural and are specified: `chain_blobs` **SHALL NOT** be `WITHOUT ROWID`
(a `WITHOUT ROWID` table stores the whole row in the index b-tree, which is wrong for multi-KB
payloads), while the narrow junction `chain_blob_roles` **SHALL** be. And `getBlob`
(`src/postgres/chain-archive-store.ts:477-496`) always materialises the whole blob into a JS buffer,
because neither binding exposes incremental BLOB I/O — at a 145 KB maximum that is fine, and it is
recorded rather than presented as streaming.

---

## 7. The write path

### 7.1 Prepared-statement reuse, no sub-batching, one `BEGIN IMMEDIATE` per bundle

`SQLITE_MAX_VARIABLE_NUMBER = 32766` (§5.6), and the wallet tier's shipped caps
(`src/postgres/checkpoint-store.ts:62-63`: `CHUNK_INSERT_MAX_ROWS = 30_000` at 2 params/row,
`JUNCTION_INSERT_MAX_ROWS = 20_000` at 3) each bind 60,000 parameters and would fail to prepare.
Change 4 owns that repair.

**The archive never had a batched path**, which makes this the easiest part of the port.
`insertTransactionRows` and `insertBridgeObservationRows`
(`src/postgres/chain-archive-store.ts:214-262`) issue three single-row statements per record inside a
JS loop; `putBlobWithRole`, `insertBlockRow` and `putVerifierKeyObservation` do the same. That is
already the prepared-statement-in-a-loop-inside-one-transaction shape. The port therefore:

- reuses one prepared statement per distinct SQL text for the whole bundle, rather than re-preparing;
- issues them inside **one** `BEGIN IMMEDIATE` transaction (change 3's);
- **acquires no row cap at all**, and a requirement forbids introducing one. There is no bind-parameter
  ceiling on a re-`run()` prepared statement, and any cap added here would be a cargo-culted copy of a
  constraint that belongs to a different adapter.

The FK-ordering note at `chain-archive-store.ts:315-320` — block row first, in the same transaction,
so `transactions`/`bridge_observations` FK checks see it — holds identically under SQLite's
same-transaction visibility.

### 7.2 The ingest cursor becomes co-transactional

Today:

```
chain-archive-sync/sync-service.ts:168-170
    for (let height = startHeight; height <= endHeight; height++) {
      await this.ingestOneBlock(height);
      await this.store.setWatermark(this.watermarkKey(), { height });
```

`ingestOneBlock` calls `putBlockBundle`, which is one transaction
(`chain-archive-store.ts:304-331`); `setWatermark` is a second, independently committed one. A crash
between them leaves the cursor **behind** the data, which the current design survives because every
insert is `ON CONFLICT … DO NOTHING` and re-ingesting the height is a no-op — `sync-service.ts:190-196`
argues exactly this and it is correct.

It is nonetheless two commits where one will do, and the one-file split (§2) makes the fold free.
Folding gives a **structural** guarantee in place of an argued one: the cursor is never ahead of
durable data because they are the same commit. This mirrors the wallet tier's co-transactional
`saveAndAdvance` (`design/design.md` §5; `Formal/STORAGE_ALGEBRA.md` §4's control algebra), and it
is the archive's analogue of the property `docs/checkpoint-store-contract.md:16-18` states for the
wallet cursor. The negative control is the current two-transaction form, and the scenario that
catches it is a crash injected between the two commits.

Note what this does **not** claim: it does not make the archive's *content* atomic with respect to
the chain, and it does not remove the need for `ON CONFLICT … DO NOTHING` (a crash *during* the
single transaction still replays the height).

---

## 8. Errors

### 8.1 Contention

`SQLITE_BUSY` and `SQLITE_BUSY_SNAPSHOT` map onto the frozen `faultKind` union through change 3's
retry and mapping rules. **No new error code is added.** Change 3's spec records that adding one
would reproduce LND's P0 fund-loss failure shape, and change 5's records that the catalog is
additive-only under a bound. The archive introduces no contention situation the wallet tier does not
already have; it introduces a *second file*, which reduces contention rather than creating a new kind.

### 8.2 The constraint name loses its structured field — measured, and contained

`ChainArchiveInvariantError` and `ChainArchiveCheckViolationError`
(`src/postgres/errors.ts:69,82`) each carry a `constraintName`, and `errors.ts:281-294` routes on it.
In Postgres that name arrives in a structured field, which is why
`001_chain_archive_core.ts:193-204` uses `RAISE EXCEPTION … USING CONSTRAINT = '…'` — a workaround
whose whole purpose is to *populate* that field. Measured on the ruled binding:

```
A trigger RAISE(ABORT,'<name>'):
   name=SqliteError code="SQLITE_CONSTRAINT_TRIGGER" typeof(code)=string
   message="chain_archive_blob_roles_completeness"
   own props=["message","code"]
B named table CHECK violation:
   name=SqliteError code="SQLITE_CONSTRAINT_CHECK" typeof(code)=string
   message="CHECK constraint failed: blocks_finalized_implies_canonical"
   own props=["message","code"]
C UNIQUE/PK violation:
   name=SqliteError code="SQLITE_CONSTRAINT_PRIMARYKEY" typeof(code)=string
   message="UNIQUE constraint failed: blocks.h"
   own props=["message","code"]
```

The error object carries `{message, code}` and nothing else. **There is no structured constraint
field.** L5's "G3 opportunity" is the opposite of what it claimed: the trigger case is convenient
(the message *is* the bare name, exactly) but it is still a message, and the `CHECK` case requires
stripping a fixed prefix.

**Containment, specified as three rules.** (1) The `code` is a **string** and is the sole
discriminator for *which class* of error occurred — this is change 5's ruling and it is followed, not
re-litigated. (2) Message parsing is confined to **one function** that extracts a constraint name,
with the two message grammars (`<name>` for `SQLITE_CONSTRAINT_TRIGGER`, `CHECK constraint failed:
<name>` for `SQLITE_CONSTRAINT_CHECK`) as its only inputs, so a message-format change breaks one
function loudly rather than mis-routing errors quietly. (3) A **round-trip test** asserts that every
constraint name the lineage declares is recoverable from the error the engine raises when that
constraint is violated — which is what makes the parser falsifiable rather than hopeful.

### 8.3 Error-identity parity is a requirement, not an aspiration

The archive's existing tests already assert negative paths — `chain-archive-migrate.test.ts` and
`chain-archive-store.test.ts` cover the fork/dual-canonical/FK-violation scenarios, the blob-role
completeness guard, the removal guard, and the finalized-monotonicity guard. Requirement: **every
negative-path assertion in the existing archive suite is re-executed against the SQLite lineage and
SHALL produce the same UmbraDB error class and the same `constraintName`.** That is the falsifiable
form of "the port preserved behaviour", and it is cheap because the assertions already exist.

One observed subtlety worth recording so a reviewer is not surprised by it: a `blocks` insert
referencing a blob hash that does not exist raises the **blob-role** guard, not a foreign-key
violation, because the `BEFORE INSERT` trigger fires before the FK check and the absent blob also has
no role row (measured, case D of the same run). Postgres orders these the same way, so this is
parity, not divergence — but it is exactly the kind of thing an error-identity test locks in.

---

## 9. Snapshots — the enhancement mandate

### 9.1 The problem statement

`design/full-chain-storage-design.md` §9 already sketches chain-archive snapshots by generalising the
wallet-state verifiable-snapshot L0–L3 layers, and it is explicit that the sketch is *"deliberately
left at the concept level."* The owner has now asked for the capability. Under PostgreSQL it would
have been a `pg_dump` procedure; under SQLite the archive **is** a file, and a file is a snapshot
artifact — provided it is complete, labelled and checkable. Those three provisos are this section.

### 9.2 What a snapshot IS — a rule, and its justification

**A snapshot is a set: one archive database file with no outstanding write-ahead-log dependency,
plus one manifest.** Not a bare `.db`. Not a `.db` plus a live `-wal`. Justification, in order of
force:

1. **The `-wal` sidecar holds every commit since the last checkpoint.** Copying the main file alone
   silently reverts the database to an arbitrarily older state *while still reporting a clean
   structural check* — change 5's §6 point 3, and it is the single most likely way to produce a
   snapshot that looks fine and is not.
2. **A file set is a worse artifact than a file.** Three files that must travel together, one of
   which is meaningless without the others, is a class of operational error that a
   single-file-plus-manifest shape does not have. So the ruling is not "copy the `.db`, the `-wal`
   and the `-shm`" — it is "produce a copy that has no WAL dependency", which is what a copy
   primitive that reads through the WAL gives you and what a filesystem `cp` does not.
3. `-shm` is never part of a snapshot under any form: it is a shared-memory index rebuildable from
   the `-wal`, and carrying it across machines is meaningless.

**The primitive that produces the copy is deliberately not named here.** Change 5's spec requires
that `docs/CONTRACT.md` §6 *"SHALL NOT name a live-backup primitive until the comparison … has been
re-measured on the ruled binding"* (its blocked decisions B-6/B-7), and it explicitly rejects, as a
negative control, exactly the corpus measurement this sprint has — a 691 MB copy completing
integrity-clean under 781 concurrent commits — on the grounds that it was taken on a different
binding. That rejection is correct and this change honours it. What this change specifies is the
**properties the artifact must have**, which are primitive-independent, plus the two facts that
constrain any candidate:

- `VACUUM INTO` freezes the JavaScript thread for the whole copy (0 event-loop ticks over 2.26 s for
  1.4 GB in the corpus, on the other binding), so any candidate's event-loop behaviour is part of
  B-6's required record;
- the online backup call **accepts an `AbortSignal` and ignores it** on the binding it was measured
  on, and captures a committed state **at or after** the call rather than as of it. §9.4 makes the
  second of these harmless by construction; the first is change 5's §6 point 1 to state.

The ruled binding does expose a `backup` member (§5.6's prototype listing), so a candidate exists.
Naming it is B-6's.

### 9.3 Could the archive tier justify a different answer than the wallet tier?

Yes on one axis, no on the other, and both are stated rather than assumed.

**Yes — cadence and acceptable stall.** The wallet tier's backup competes with an interactive wallet.
The archive's competes with a batch ingest loop that already sleeps 10 s when it catches the tip
(`chain-archive-sync/sync-cli.ts:64`) and retries after 15 s on error (`:68`). A snapshot mechanism
that stalls the archive process for minutes is *tolerable* for the archive and is not for the wallet.
So if B-6 rules that no live-backup primitive is acceptable and §6 documents an offline
quiesce-then-copy procedure, the archive can adopt it at a far lower cost than the wallet tier —
`archive:sync` is a long-running CLI with a `SIGINT`/`SIGTERM` stop path already wired
(`sync-cli.ts:47-52`), so "quiesce" is a signal, not an outage.

**No — the artifact's integrity rules.** Nothing about the archive makes a WAL-dependent copy safer,
a manifest optional, or a structural check skippable. §9.2's rules apply to both tiers identically.

This change therefore states: **the archive MAY adopt a stricter (more stalling) copy procedure than
the wallet tier, and MAY NOT adopt a weaker artifact definition.** If B-6 rules a live primitive
acceptable, the archive uses it; if not, the archive quiesces. Either way §9.4–§9.6 are unchanged.

### 9.4 Identity: the manifest, and the one rule that makes at-or-after capture harmless

**The manifest SHALL be derived from the finished snapshot artifact, never from the source database
before or during the copy.** This is the load-bearing rule of the whole section, and it is what makes
the copy primitive's capture semantics a non-issue: if the manifest is computed by reading the
artifact, then whatever the artifact happens to contain is what the manifest describes, and "at or
after the call" stops being a hazard because there is no earlier claim to contradict.

Derived from the artifact, the manifest carries:

| Field | Source | Why it is in the artifact |
|---|---|---|
| `lineage`, `appliedMigrations` | the archive's own `_migrations` table (`000_schema.ts`'s per-schema bookkeeping) | a restore into a runtime expecting a different lineage must fail loudly |
| `schema` | the `schema` value the lineage was applied under | change 4 prefixes object names with it; a mismatch makes every object unreachable |
| `net` | `SELECT DISTINCT net` across `blocks` | an archive of the wrong network is the most likely mis-restore |
| `heightRange` | `min(height)`, `max(height)` over `blocks WHERE is_canonical` | what range of chain this artifact actually holds |
| `canonicalTip` | `(height, block_hash)` of the highest canonical block | the anchor, `design/full-chain-storage-design.md` §9's L0 |
| `watermarks` | every row of the archive's own `watermarks` table | the ingest cursor travels with the data (§7.2 makes them consistent by construction) |
| `rowCounts` | one count per table in the lineage | catches a truncated or partially copied artifact |
| `contentDigest` | SHA-256 over the ordered `(net, height, block_hash)` sequence of canonical blocks, ascending, with a domain-separation prefix | §9.5 |
| `pragmas` | `page_size`, `auto_vacuum`, `journal_mode` | `page_size` and `auto_vacuum` are irreversible properties of the file (§3.6); a restore cannot repair them |
| `engine` | binding name, pinned package version, runtime `sqlite_version()` | change 5's admissibility discipline, applied to artifacts as well as measurements |
| `umbradbVersion` | `package.json` version | |

An unlabelled database file is not a usable artifact; this table is the difference.

### 9.5 The content digest, and why it is not a Merkle tree

`contentDigest` is a **flat** SHA-256 over an ordered sequence, not a tree. That is deliberate and it
is bounded by an existing decision. `Formal/STORAGE_ALGEBRA.md` §6 rules against adding a
Merkle/authenticated data structure for this deployment, and names as one of the two conditions that
would flip the threat model *"a future 'export this checkpoint and let someone else verify it'
requirement, which would flip the threat model to the exact external-verifier case Trillian/CT
solve."* An archive snapshot handed to a third party is arguably that condition. This change does
**not** flip it, and says why:

- The snapshot's purpose here is **availability and restore verification for the operator**, not
  third-party verification. §6's own framing — *"the DB is never a source of correctness, only of
  availability"*, inherited by `design/full-chain-storage-design.md` §9 — is unchanged.
- §6 already grants that SHA-256 content-addressing is *"a rudimentary authenticated structure"*;
  a single root digest over an ordered sequence is that, and nothing more.
- A Merkle tree buys **inclusion proofs**, which are only useful to a verifier who does not hold the
  whole artifact. A snapshot recipient holds the whole artifact by definition.
- `design/full-chain-storage-design.md` §9's L3 already proposes exactly this shape — a
  `chainArchiveManifestRoot` committing to *"`sha256` over the ordered `(net, height, block_hash)`
  sequence UmbraDB has actually archived"* — as a *"structurally identical addition, not a new
  mechanism."* This change makes that concrete for the local case and leaves L2/L3 (remote/untrusted
  serving, on-chain self-certification) at the concept level, which is where that document puts them.

If third-party verification ever becomes a requirement, §6's revisit condition is met and the tree is
that change's, not this one's.

### 9.6 Verification on restore — four checks, and what they do not prove

1. **Structural and stored-value.** Change 5's `verifyIntegrity()` pass, which per gate R-3 runs
   `PRAGMA integrity_check` **and** the digest sweep **and** the schema-digest check **and** the
   Class B invariant queries, reports them **together**, and never refuses. This change does not
   duplicate it and does not define a second one. Two constraints from the ruling carry into the
   archive's use of it: `quick_check` is **not** an acceptable substitute anywhere (it returned
   `ok` on every index-versus-table divergence the seats produced), and the digest sweep is **not**
   a substitute for `integrity_check` — the sweep is blind to Class B by construction, since it
   verifies the rows it is handed and cannot see an index that omits rows, while `integrity_check`
   is blind to Class A. Neither subsumes the other.
2. **Identity.** Recompute every derived manifest field from the restored file and compare to the
   manifest: lineage, schema, net, height range, canonical tip, per-table row counts, and
   `contentDigest`. Note that two snapshots of the same logical content taken by different mechanisms
   are **not** byte-identical (a compacting copy rewrites the file), so a file-level checksum is
   *not* the identity check — the logical digest is.
3. **Irreversible pragmas.** Assert the restored file's `page_size` and `auto_vacuum` match the
   manifest. A mismatch is unrepairable in place (§3.6): a restore onto a file created with a
   different `page_size` cannot be fixed by any in-place operation, and an artifact restored at
   `auto_vacuum=0` will never return retired space to the filesystem however much is deleted.
4. **Continuity.** Walk the canonical header chain over the manifest's `heightRange`, asserting each
   row's `parent_hash` equals the previous row's `block_hash`. This is
   `design/full-chain-storage-design.md` §9's L1 layer.

**What check 4 does and does not prove**, adopted verbatim from that document's own v3 audit fix
(§9, §10.9) rather than restated more favourably:

- **Proves:** for the *one* chain of header rows actually walked, the stored sequence is internally
  continuous — no header can be silently omitted from the middle without breaking the walk.
- **Does not prove fork completeness.** `blocks` deliberately stores the full block tree; a missing
  orphaned-fork row does not break the canonical walk at all.
- **Does not prove transaction or bridge-observation completeness.** A block row can exist,
  hash-chain correctly, and have zero of its real transactions archived.
- **Does not prove body/`extrinsics_root` integrity**, and structurally cannot with this schema:
  `blocks.body_blob_hash` is nullable pending body/extrinsics sync, so the bytes needed to recompute
  `extrinsics_root` are often simply absent.

The manifest therefore **SHALL NOT** contain a field named or documented as `complete`, and the
restore report **SHALL** name the four checks separately so an operator can tell which one passed.

### 9.6.1 The verification pass is a post-restore check, not a routine gate

`verifyIntegrity()`'s runtime **at archive scale is unmeasured** — obligation U-2 of the R-3
ruling, routed to change 1's gate and mirrored here as M-7 (§12). Until it is measured at a stated
representative scale with a **separate-process** writer, the pass is documented as an **on-demand
diagnostic and post-restore check**, and no text in this change may assume a periodic pass is
affordable.

Concretely, for the archive's four restore checks: running them **after a restore** is required and
is not affected, because a restore is a bounded, operator-initiated event. What this change SHALL
NOT do is wire any of the four into archive **startup**, into `archive:sync`'s ingest loop, or into
a schedule — that would promote an unmeasured runtime into a blocking one on every boot of a
long-running process. The continuity walk is subject to the same rule for the same reason: it is a
scan over a height range, and a range that is cheap to walk on a restored 1 GB artifact is not
cheap on a 400 GB one.

### 9.8 The snapshot tooling runs outside the library process

The snapshot module reads database files. Change 3's descriptor ban forbids exactly that inside
`src/`, and the ban is the load-bearing remedy for the write-lock attack — an in-process copy of the
three-file set is that attack performed by our own documentation. An earlier draft of this change
listed `src/sqlite/chain-archive-snapshot.ts` among its new files, which would have collided.

**Ruled: the snapshot, manifest-derivation and restore-verification code lives outside `src/`**,
beside the archive sync entry point rather than inside the published build, and operates only on a
finished artifact or a quiesced archive. The ban is not weakened and takes no exemption for our own
tooling — an exemption for trusted code is the attack with a friendlier name.

This also removes a tension rather than creating one: change 5's copy procedure is already specified
as out-of-process or post-quiesce, so the archive's tooling now sits on the same side of the
boundary. It fits the existing shape too — `chain-archive-sync/` is already an ops track that
`tsconfig.build.json:15` excludes from the published build while `tsconfig.json:15` typechecks it
(§11), so this is the track the tooling belongs on.

"quiesce" for this tier means what §9.3 already relies on: the sync entry point's termination-signal
stop path, leaving no open write transaction and no open handle.

### 9.7 Producing a snapshot while ingest runs

The archive is append-only and single-writer. Given §9.4's derive-from-artifact rule, the procedure
is:

1. Produce the copy by whatever primitive B-6 rules (or quiesce first, per §9.3, if B-6 rules none).
2. Open the copy read-only and derive the manifest **from it**.
3. Write the manifest beside it.
4. Optionally run the restore verification (§9.6) against the copy immediately, which is the cheapest
   possible moment to discover a bad artifact.

No step requires stopping ingest, and no step requires the source and the artifact to agree about
anything — which is the point.

---

## 10. Durability posture for the archive tier — ruled, not inherited

### 10.1 The tempting argument, and why it is only two-thirds true

The standard argument for a weaker `synchronous` on an archive is: a corrupt or lost archive can be
re-synced from chain, while a lost wallet cursor cannot. The contradiction seat leans this way
(§2.9's C17 note: *"`FULL` for the wallet tier, `NORMAL` defensible for the re-ingestible archive"*),
and it is the whole basis of L7's "derivable from chain" escape hatch.

**It is false for part of this schema, and the archive's own design document says so.**

- `bridge_observations` was **reclassified from "defer" to "build now"** precisely because it is *not*
  cleanly re-derivable: `design/full-chain-storage-design.md` §7 records that the original
  replay-recoverable justification *"is contradicted by this data living in block bodies (not
  `transactions`) and by the design's own acknowledgment that `cnight_registrations` is partly
  Cardano-side and not cleanly re-derivable from Midnight block replay alone."*
- `verifier_key_observations` covers *"the one category where UmbraDB adds coverage the indexer
  genuinely lacks"* — §4.5/§3 record that the indexer has **no dedicated VK archive at all**. There
  is no upstream to re-derive from.
- Even the categories that *are* believed replay-recoverable are flagged **UNVERIFIED** by that
  document (§7, §10.2): *"no genesis-to-event replay reconstruction has been performed."*

So "the archive is re-derivable" is an assumption that this lineage's own authors declined to make
without a test.

### 10.2 The ruling

**The archive file's `synchronous` default is the same as the wallet tier's.** Lowering it requires
change 5's three preconditions — a magnitude measured under change 1's gate conditions; power-loss
evidence from a rig that removes power or faithfully emulates a lost volatile write cache, with a
negative control that fails; and a recorded decision naming what is traded — **plus a fourth that is
specific to this tier:**

4. **A written, per-table re-derivability determination**, naming for each of the six archive tables
   whether its content can be reconstructed from chain, by what procedure, and with what evidence.
   `bridge_observations` and `verifier_key_observations` must be addressed explicitly, and an
   UNVERIFIED flag is not a determination. **Gate R-3 has since supplied part of this**: it ruled
   those two tables COVER for integrity precisely because this lineage rules them not cleanly
   re-derivable (§10.3.1). A `synchronous` proposal that contradicts that finding contradicts a
   closed gate, not merely this change.

The two-file split (§2) is what makes this decidable *twice* at all — a single file would have forced
one answer for both tiers — and that is a genuine capability the split buys. But "decidable
separately" is not "decided differently", and defaulting the archive to weaker on a premise its own
design document flags as untested is exactly the failure mode this sprint exists to avoid.

### 10.3 Value integrity: the coverage set, closed by gate R-3

**Gate R-3 is closed** (`umbradb-sqlite-research/audit/fable-r3-ruling.md`, adjudicated 2026-07-31),
and it resolves this change's M-5. The analytical frame is no longer re-derivable-versus-not; it is
the three-class corruption model, and **the re-derivability test survives inside Class A as the
obligation test** — non-re-derivable Class-A exposure ⇒ cover. Change 5 owns the digest
specification; this change owns the archive's coverage set, the DDL that carries it, and three of the
eight mandatory Class B invariants.

| Class | What goes wrong | Instrument |
|---|---|---|
| **A** | the wrong **bytes** are returned for the right row | a digest, verified on read |
| **B** | the wrong **row**, or no row, is returned | invariants and index redundancy — **never** a digest |
| **C** | `sqlite_schema` text corruption | change 4's schema digest, verified at open |

#### 10.3.1 The archive coverage set, as ruled

| Table | Ruling | Mechanism |
|---|---|---|
| `chain_blobs` | **UNCOVERED — already covered** | Content-addressed; rehash-on-read is real and shipped, not aspirational: `src/postgres/chain-archive-store.ts:477-496` recomputes SHA-256 over the retrieved bytes and raises `BlobIntegrityError` when it disagrees with the key it was looked up by. Verified in code, not assumed |
| `blocks` | **UNCOVERED + invariant I-2** | Class B is the exposure, not Class A. Content columns are projections of rehash-verified blobs; a digest column on a 10⁷–10⁸-row table is the one bad trade in the design. Rebuild path per §10.4 |
| `transactions` | **UNCOVERED** | Same: a projection of `raw_blob_hash`-verified bytes. Rebuild path per §10.4 |
| `chain_blob_roles` | **UNCOVERED** | Both columns are the primary key, so corruption is b-tree-detectable rather than silently wrong. *Named explicitly because the ruling records that this table was missing from R-3's own first enumeration* — an omission is not a classification |
| `bridge_observations` | **COVER** | Multi-column digest. The argument is this lineage's own: `design/full-chain-storage-design.md` §7 rules it *not cleanly re-derivable* — partly Cardano-side, living in block bodies, replay reconstruction UNVERIFIED. Row count is bounded by bridge activity, not by chain size, so the storage objection that excludes `blocks` does not reach it |
| `verifier_key_observations` | **COVER** | *"The one category where UmbraDB adds coverage the indexer genuinely lacks"* (§4.5/§3) — there is **no upstream to re-derive from** |
| `watermarks` (archive lineage) | **COVER** + invariants I-6, I-8 | Same column and mechanism as the wallet-lineage watermark, plus the two invariants in §10.5 that only the *archive* cursor can carry |

This is the same argument §10.1 makes about `synchronous`, applied to a different mechanism, and the
adjudication took it over the cost seat's blanket exclusion: **it would be incoherent to refuse to
weaken the archive's durability on the ground that two of its tables are not re-derivable, and then
exclude those same two tables from integrity coverage on the ground that the archive is
re-derivable.** Consistency across the two rulings is the reason both land where they do.

#### 10.3.2 What this change does *not* re-specify

The digest itself is change 5's: SHA-256 unconditionally; a nullable `dg BLOB` of 32 raw bytes where
`NULL` means *not yet computed*; a versioned, length-prefixed, injective preimage binding the logical
table name, the column name and the primary key so that whole-row substitution is defeated; format
`0x01` for single-value columns and `0x02` for multi-column rows; computed **adapter-side on the
caller's thread**, never in SQL, because the generated-column route makes the schema permanently
dependent on a UDF and `ADD COLUMN … STORED` is rejected on any populated table. Verify-on-read is
**mandatory and has no opt-out**. This change cites that specification and does not restate it.

#### 10.3.3 What this change *does* own: the DDL that carries it

The digest columns are ordinary columns of this lineage and take its conventions:

- `dg BLOB` — **nullable**, with a **named, null-tolerant** length constraint
  `CHECK (dg IS NULL OR octet_length(dg) = 32)` in the migration that adds the column, and with **no**
  constraint that rejects a NULL — no `NOT NULL`, no non-null default.

  *Amended.* An earlier draft of this section, following R-3 §1.3, forbade any length `CHECK` in the
  adding migration on the ground that nullability is the backfill-resumability marker and a length
  constraint would defeat it. **That rationale is refuted, and in both forms.** Change 4's mandated
  form is explicitly null-tolerant; and measured on the ruled binding, even the *bare*
  `CHECK (octet_length(dg) = 32)` **accepts** NULL, because SQL `CHECK` three-valued logic passes a
  NULL result. No length constraint of either form forecloses the marker. The constraint earns its
  place independently: a truncated or garbage digest is a real defect it makes unrepresentable, and
  the named form feeds §8.2's single extraction function like every other constraint here. R-3 §1.3
  is amended accordingly, and change 5 amends the matching passage in its own spec.
- Every covered table carries **two** mandatory no-UDF triggers, both with names taking this
  lineage's `qualify()` prefix like every other trigger (change 4), and both with the constraint name
  as the abort message so §8.2's single extraction function recovers it. The first is the drift
  guard:

  ```sql
  CREATE TRIGGER <s>_bridge_observations_dg_guard
    BEFORE UPDATE OF <covered columns> ON <s>_bridge_observations
    WHEN NEW.dg IS OLD.dg
    BEGIN SELECT RAISE(ABORT, '<s>_bridge_observations_dg_guard'); END;
  ```

  The second is the **anti-downgrade guard**, and it closes a hole the drift guard does not:

  ```sql
  CREATE TRIGGER <s>_bridge_observations_dg_nodowngrade
    BEFORE UPDATE OF dg ON <s>_bridge_observations
    WHEN NEW.dg IS NULL AND OLD.dg IS NOT NULL
    BEGIN SELECT RAISE(ABORT, '<s>_bridge_observations_dg_nodowngrade'); END;
  ```

  The drift guard fires only when a covered *column* is updated. `UPDATE t SET dg = NULL` touches no
  covered column, so the drift guard permits it — measured, on the ruled binding, with the R-3
  trigger installed verbatim — and the row is permanently downgraded to unverified by one statement.
  A "verified on every read, no opt-out" guarantee that a single `UPDATE` can opt a row out of is
  true of configuration and false per row. The anti-downgrade trigger cannot obstruct a backfill,
  which only ever writes NULL→value, and does not obstruct a legitimate recompute.

- **In this lineage a NULL `dg` on a covered row is `VALUE_INTEGRITY`, not a warning.** The
  warn-and-return branch was specified for a mid-backfill world; this lineage ships no backfill
  (below), so as shipped that branch is dead code whose only reachable function is masking either
  corruption or the downgrade above. Warn semantics are reinstated only by a future change that
  actually ships a backfill, as part of that change.

- The tables remain `STRICT`; `BLOB` is a legal `STRICT` declared type, so no exception is needed.
- **The archive ships with zero backfill.** The ruling's backfill procedure applies only where a `dg`
  column is added to a populated table. The archive lineage is greenfield (§1, owner answer 2), so
  the column exists from the first migration and every row is written with its digest in the same
  statement as the value. The archive is the *only* tier for which this is unconditionally true, and
  it is worth stating because the ruling's honest caveat — that a backfilled digest certifies the
  bytes *as found*, not as originally written — **does not apply here at all**.

### 10.4 The rebuild path, which is what makes UNCOVERED defensible rather than merely cheap

`blocks` and `transactions` are excluded from the digest because they are projections of blobs that
*are* verified. That is only an argument if the projection can actually be recomputed, so the ruling
makes a written rebuild procedure with **one executed transcript** a precondition (U-5) on the
UNCOVERED classification shipping in the contract. Until that transcript exists, the contract's
archive row may say only *"resync from chain"* and may **not** claim a local rebuild.

The procedure: for a suspect height range, re-derive each `blocks` row's content columns from its
`header_blob_hash` blob — whose bytes are rehash-verified on read — using the header field
enumeration at `design/full-chain-storage-design.md` §3.1, and each `transactions` row's metadata
from its `raw_blob_hash` blob; compare against the stored projection; report divergence per column.
M-5 is **repurposed, not deleted**: it is no longer coverage-gating, and it becomes the experiment
that produces this transcript and tells us which columns are re-derivable in practice rather than in
principle.

Two limits stated up front, because the honest version is what makes the exclusion reviewable:
a rebuild cannot recover a row whose blob reference is itself corrupt, and it cannot recover
`blocks.body_blob_hash`-dependent facts where the body was never synced (nullable by design, §9.6).

### 10.5 The three Class B invariants this change carries

Class B is the archive's real exposure, and no digest reaches it. Each of these is a bounded
index-seek assertion at the moment of use.

Gate R-3 distributes eight mandatory invariants. Three reach this change, and the ownership
distinction on I-6 matters: change 5 owns the *invariant* because it is a property of the watermarks
primitive contract, while this change owns the archive-side *application* of it, because the archive
has its own watermark table and therefore its own instance of the fault.

| # | Invariant | Owner |
|---|---|---|
| I-1 | `next_seq > max(seq)` plus `UNIQUE (w, net, seq)` | change 4 — closed |
| **I-2** | **one canonical block per `(net, height)`** | **this change** |
| I-3 | `getAt` asserts via the primary-key auto-index | change 2 |
| I-4 | writer registration asserts `changes === 1` and a defined read-back | change 3 |
| I-5 | migration-lineage law | change 4 |
| **I-6** | **anti-latch watermark guard** | change 5 owns; **this change applies it archive-side** |
| I-7 | transaction-history read-path cross-checks | change 4 |
| **I-8** | **archive cursor sanity** | **this change** |

**I-2 — at most one canonical block per `(net, height)`.** The partial unique index on
`blocks(net, height) WHERE is_canonical` was already in this change's DDL; the ruling **elevates it
from a schema detail to a normative requirement with its own scenario**. The exposure is measured:
one corrupted serial-type byte yields two canonical blocks at one height with `integrity_check`
reporting `ok`.

**On the shape, and why it does not contradict change 4.** Change 4 ruled the *opposite* way for
`ckpt_manifests`, choosing a **full** `UNIQUE (w, net, seq)` over a partial `WHERE complete`, on the
ground that *"a partial index conditions the integrity constraint on a corruptible predicate … If
`complete` is flipped true-to-false by the same class of corruption, a partial index silently stops
covering that row … Conditioning integrity on non-integrity is backwards."* That reasoning is right,
and it does not apply here — change 4 says so itself, naming this case
(`v1.0.0-sqlite-schema-parity/design.md:1216-1220`, and `:1243` handing the index to this change).
The distinction is precise and worth stating from this side too:

- For `ckpt_manifests`, `complete` is **bookkeeping**. Every row has it set; the design calls it
  *"not a load-bearing mechanism"*; the partial and full indexes are today equivalent in extension.
  When two shapes are equivalent, the one that does not depend on a mutable byte wins.
- For `blocks`, `is_canonical` is a **domain fact with several legitimate rows per height.** This
  schema deliberately stores the whole block tree, not just the canonical chain
  (`design/full-chain-storage-design.md` §4.2), so a full `UNIQUE (net, height)` would be *wrong* —
  it would forbid the forks the archive exists to retain. The predicate is not narrowing a constraint
  that could have been total; it is the only shape that expresses the actual rule.
- And `is_canonical` is not free-floating: `001_chain_archive_core.ts:270` carries
  `CHECK ((status = 'canonical') = is_canonical)` and `:277` carries `CHECK (NOT finalized OR
  is_canonical)`, so a flip of that one byte must corrupt `status` consistently to stay
  representable. The corruptible-predicate objection is answered by the biconditional, not waved away.

**I-6 — anti-latch on the archive watermark's monotonic guard.** When a `setWatermark` monotonic
guard suppresses a write as a regression, the store verifies the **incumbent** row's digest in the
same transaction; a failing digest raises the integrity error rather than silently no-opping. Change
5 owns the primitive contract; this change applies it to the archive-side guard, because the archive
has its own watermark table (`001_chain_archive_core.ts:729-745`, deliberately not a reuse of the
wallet lineage's) and therefore its own instance of the fault.

The finding this answers is sharper than "a monotonic guard can miss a corrupted-high cursor." The
corruption-modes seat established that the guard **latches** it: once the stored height is corrupted
forward, four consecutive legitimate writes were observed failing to lower it. So the guard does not
merely fail to detect the corruption — it actively defends it, converting a one-off bit flip into a
permanent stall, and one that presents as "sync has stopped" with no error anywhere. That is the
exact bug-report shape the feasibility seat flagged as this library's observability problem
("the wallet is stuck"), which is why a silent no-op is not an acceptable outcome here.

Placement follows from the same fact: the check belongs on the **suppression** path, not the success
path. A corrupted-high cursor produces no successful writes, so a check that only runs when a write
lands would never fire for the fault it exists to catch.

**I-8 — archive cursor sanity.** On read, the archive asserts
`watermarks(chain-archive).height ≤ max(blocks.height) + 1`.

The asymmetry is worth stating precisely, because it is why this invariant is the archive's alone. A
data-side sanity check was offered during R-3 as a general escape hatch for the watermark tables —
if a cursor can be checked against the data it indexes, perhaps it does not need a digest. It was
found **not implementable on the wallet side**: the wallet-sync cursor names a position in a chain
UmbraDB does not hold, so there is nothing inside the database to compare it against, and that is why
that cursor is covered by a digest instead. The archive cursor indexes blocks the archive also
stores. So the comparison exists here and is used — and the archive takes **both** mechanisms rather
than trading one for the other, since the digest answers a corrupted value while the bound answers a
value that is individually well-formed and inconsistent with the data it describes. The `+ 1` is exact rather
than slack: §7.2 folds the cursor advance into the block bundle's transaction, so the cursor may
legitimately point one past the highest stored height only in the sense of "next height to ingest",
and anything beyond that is corruption rather than a race.

### 10.5.1 `page_size` change control

`page_size` is the one irreversible setting this change records and asserts (§9.4, §9.6), and
nothing stated who may change it. Ruled, so the manifest assertion has something to mean: the value
is **pinned per lineage**, recorded in the supply-chain inventory alongside the binding, and a
revision is **a new lineage decision** — not a configuration change, because an existing file cannot
adopt it and a restore across the boundary fails §9.6's pragma check by design. The value itself
remains change 1's B-3.

### 10.6 `checksumvfs` is declined, not deferred — and this change does not hold a door open for it

Recorded because the archive is the tier where a page-level checksum sounds most attractive: it is the
largest file, the one that gets copied around as a snapshot artifact, and the one whose corruption is
least likely to be noticed quickly. Gate R-3 declined it outright, on five independent grounds any one
of which is sufficient. Two are decisive for a library specifically and do not expire: **registration
is process-global** — it makes the shim the default VFS for every subsequently opened connection in
the host process, and UmbraDB is a library in someone else's process, so it does not get to mutate the
SQLite environment of unrelated code at any version; and **the shim's own track record includes the
one failure a checksum must never have**, having overwritten write-ahead-log frame checksums such that
uncheckpointed transactions could not be recovered.

Consequences this change adopts rather than restates: it is not in the pinned binding's build, so no
archive requirement may assume it; `PRAGMA checksum_verification = 1` is **accepted and silently does
nothing** on this build, so it must never appear as evidence of anything; and reserve-bytes = 8 SHALL
NOT be pre-set on the archive file, because doing so permanently freezes `page_size` — which §9.4
records in the snapshot manifest as irreversible and §9.6 asserts on restore — and forecloses the
reserve-bytes consumer already named as 1.1 headroom. Nothing in this change references it as future
headroom, and this paragraph exists so that nothing does.

---

## 11. The sync CLI, and the three-command coherence condition

`chain-archive-sync/sync-cli.ts` is the production entry point. Its changes:

| Today | After |
|---|---|
| `ARCHIVE_PG` — a `postgres://` connection string, **required** (`:12`, `:25-30`) | a file path for the archive database, required |
| `createClient({ connectionString, schema })` (`:37`) | change 1's replacement client, opened on the archive file |
| `ARCHIVE_SCHEMA` (default `chain_archive`) (`:14`, `:32`) | unchanged in meaning; becomes change 4's name prefix within the file |
| `await sql.end({ timeout: 5 })` (`:73`) | change 1's handle close |
| `NET`, `NODE_URL`, `INDEXER_URL`, `MAX_BLOCKS` | unchanged |
| `SIGINT`/`SIGTERM` stop path (`:47-52`) | unchanged, and now also the "quiesce" primitive §9.3 relies on |

**R-1's closing condition** is that `npm run typecheck`, `npm run build` and `npm run archive:sync`
stay coherent. Concretely: `tsconfig.json:15` keeps `chain-archive-sync/**/*.ts` in the typecheck
set, `tsconfig.build.json:15` keeps it out of the published build, and the CLI must run against the
new client. That asymmetry is deliberate and is preserved: the archive sync tool is an ops entry
point shipped in the repo, not part of the published library surface, which is consistent with
`src/index.ts:58` excluding the archive error classes from the frozen barrel.

**Change 1's open question Q-3** — *does the repo-clone channel imply consumers running `archive:sync`
from source, making this a consumer-facing contract rather than an internal build detail?* — is
routed to the owner and is **not** answered here. This change specifies the conservative behaviour
either way: the env-var contract change is recorded as a break in `CHANGELOG.md`, priced pre-tag and
post-tag, rather than treated as an internal rename.

---

## 12. Measurement obligations — every one deferred, none answered

No number in this change is a completion criterion. These are obligations to *establish* a number
under change 1's gate conditions (filesystem, `journal_mode`, `synchronous`, `page_size`, dataset size
relative to page cache, binding and `sqlite_version()`), each with a stated decision it unblocks.

| id | what must be established | conditions that must be recorded | decision it unblocks |
|---|---|---|---|
| **M-1** | Archive ingest throughput at the deployment's stated requirement and at 10× and 100× it | all gate conditions, plus single-writer and the co-transactional bundle of §7.2 as the unit of work — not a bare insert | whether the archive's ingest path needs any optimisation at all before the tag |
| **M-2** | Whether ingest throughput decays as the file grows past host RAM | dataset size **relative to page cache**, explicitly; caches dropped between runs | the one thing L5 could not measure (its open question 1) and the only way its verdict could be wrong |
| **M-3** | The in-database/filesystem blob crossover at the ruled `page_size` | gate conditions, plus the measured blob-size distribution of §6.1 as the input | confirms or overturns §6.1's in-database ruling. **`page_size` itself remains change 1's B-3** |
| **M-4** | Range-retirement cost — `DELETE` of a height range, and the reclaim cost of the chosen `auto_vacuum` — at archive-realistic row counts | gate conditions, row count, `auto_vacuum` value, and whether the delete is chunked | settles the `DROP`-versus-`DELETE` direction that change 1's harness and mine disagree about (§3.2), and sizes the write-lock hold a retirement would take. **Not** a layout input: §3.3 rules the layout on properties that hold in both directions |
| **M-5** | *(repurposed — no longer coverage-gating)* Whether a corrupted `blocks`/`transactions` projection column is detectable by re-derivation from its verified blob | the header-field enumeration of `design/full-chain-storage-design.md` §3.1; a corruption injected per column | gate R-3 already ruled these tables UNCOVERED, so this no longer decides coverage. It now produces the executed transcript that R-3's U-5 makes a **precondition** on that classification shipping in the contract (§10.4), and tells us which columns rebuild in practice |
| **M-7** | `verifyIntegrity()` runtime at archive scale — `integrity_check` and the digest sweep as separate components | gate conditions, a stated representative scale (the ruling names ≥ 30 GB synthetic), and writer concurrency driven from a **separate process**, not the same one | whether the pass may ever be described as anything more than an on-demand diagnostic and post-restore check (§9.6.1). This is R-3's obligation U-2, mirrored here because the archive is the tier where the scale bites |
| **M-6** | Snapshot production cost and its event-loop behaviour on the ruled binding, at archive-realistic sizes | change 5's B-6 record, plus concurrent ingest with its commit count | §9.3's "may the archive stall longer" question, quantitatively. **The primitive choice stays change 5's B-6** |

A measurement whose recorded filesystem is `tmpfs`, `ramfs` or anything the durability probe would
refuse is **inadmissible**, per change 5's rule. The verification runs quoted in this document were
executed on `/root` (ext4, `/dev/sdd`) with `/tmp` explicitly avoided, and produce no throughput or
latency figure at all — they are limits, parse results, plan shapes, pragma behaviour and file sizes.

---

## 13. Cost, and what it would cost after the tag

L5 estimated 4–6 engineer-weeks for the archive lane, which the synthesis carried as "+20–30 days
whenever it is wanted." Under this change's rulings that estimate is **too high**, for three
reasons that are specific rather than optimistic:

- **No data migration at all** (owner answer 2). L5's estimate did not include one either, but every
  comparable project's cost is dominated by it, and stating the absence is what keeps a later reader
  from re-adding it.
- **The layout is one table per relation** (§3.1), which removes L5's largest line item — *"partition generator +
  rollover rewrite, M (4–6 d)"* — and turns it into a deletion of `chain-archive-rollover.ts`'s 353
  lines. L5 itself notes the item is "S if Delta 1 is dropped."
- **The write path is already the right shape** (§7.1), so the adapter port is type and
  error-translation churn.

What is *added* relative to L5's table is the snapshot capability (§9), which L5 costed only as a
backup *mechanism* wrapper and which is here a manifest format, a derivation, a verification pass and
a restore report.

**Pre-tag versus post-tag.** `docs/STABILITY.md:46` — *"Current version: `0.9.5` — the commitments
above are NOT yet in force"* — and `:60-61`, that a break between `0.9.5` and `1.0.0` is permitted.
The three breaks §Impact lists (the `constraintName` provenance, the store's construction signature,
the `archive:sync` env contract) each cost one `CHANGELOG.md` entry landed pre-tag. Landed after,
each independently forces a **major version**, and the `archive:sync` contract change would do so
across a channel — repo clone — with no chokepoint to reach (change 1's R-9). The archive error
classes being outside the frozen barrel (`src/index.ts:58`) reduces but does not eliminate this:
`constraintName` is observable to anyone running the CLI from a clone.

---

## 14. Cross-change relationships

### 14.1 What this change depends on

| Depends on | What is needed | If it is not settled |
|---|---|---|
| change 1 | driver + pin, shim, worker topology, pragma bootstrap, gate | §5 cannot be written against a binding; §3.6's `auto_vacuum` dependencies (space return, manifest field) cannot be resolved; every M-* is unrunnable |
| change 3 | `BEGIN IMMEDIATE` on write paths | §5.3's deletion of the row-locking argument is unjustified and §7.1's single-transaction bundle has no isolation guarantee |
| change 4 | `qualify()` prefixing, `STRICT`, type mapping, the `coalesce(…)` + `CHECK` form | §5's whole table is unimplementable; §5.5 has no rule to cite |
| change 5 | B-6 (copy primitive), the digest regime, the verification pass, the `synchronous` decision rule, the string-`code` discriminator | §9.2 cannot name a primitive (and does not), §9.6 check 1 has nothing to call, §10.2/§10.3 have no rule to extend |

### 14.2 What this change owes others

- **Change 5** gains a second consumer for its verification pass and its digest regime. The input
  it did not have — §10.1's finding that the archive is **not uniformly** re-derivable — has since
  been adjudicated: gate R-3 took this change's argument over the cost seat's blanket exclusion and
  ruled `bridge_observations` and `verifier_key_observations` COVER on exactly that ground
  (§10.3.1). Change 5 leads implementation of the digest specification and records this change's M-5
  as resolved at its `tasks.md` 3.7; this change supplies the archive's coverage set, its DDL, and
  invariants I-2, I-6 and I-8.
  **The coverage set is asserted from both sides, which is what makes a silent divergence
  impossible:** change 5's `tasks.md` 3.1 requires a test asserting that **no** `dg` column exists on
  `ckpt_chunks`, `ckpt_manifests`, `chain_blobs`, `blocks`, `transactions` or `chain_blob_roles`,
  while this change's §10.3.1 classifies those same archive tables UNCOVERED. Neither side can drift
  without failing the other's test.
- **Change 4** is additionally owed a cross-reference rather than a correction: its full-versus-
  partial unique-index ruling for `ckpt_manifests` and this change's partial index on
  `blocks.is_canonical` reach opposite conclusions from the same threat model, and §10.5 states the
  distinction from this side so the two do not read as inconsistent.
- **Change 1** gains a second independent reproduction of the irreversible pragma-ordering trap on
  the ruled binding (§3.6, F1/F4), and a correction to a lane fact it hands over
  (§5.6: `SQLITE_ENABLE_UPDATE_DELETE_LIMIT` is present on the ruled binding, absent on the one L5
  measured). Change 1 has generalised the second into its pinned-binding requirement, and this
  change now cites that requirement instead of carrying its own version of the rule.
- **Change 1, on `auto_vacuum`.** Its re-measurement across all three settings is what withdrew this
  change's conditional layout (§3.1–§3.3). In return this change hands back an independent
  reproduction at two scales on a different table shape, which **confirms the structural conclusion
  and does not reproduce the 22× `DROP`-slower timing** (§3.2). The disagreement is recorded, does
  not affect either change's ruling, and is routed to M-4 if a requirement ever needs it settled.
- **Changes 2, 3 and 5** — the error-containment pattern this change specifies (one parse function
  for the constraint name, plus a round-trip test driven from the lineage's own declared constraint
  names) has been prescribed to them as well. §8.2 states it once; those changes cite it rather than
  each deriving it, and the underlying error-object shape is change 1's and change 5's to assert.
- **Change 4** gains a verification of its `coalesce(…)` + `CHECK` ruling against the one real key in
  the repo that needs it (§5.5), including the sentinel-domain `CHECK` firing.

### 14.3 The stale-premise corrections — closed record

**Status: closed.** This section was an open register listing sibling documents that carried R-1's
refuted archive premise, with the corrections left to their authors out of ownership etiquette. That
was ruled **not acceptable**, and the ruling is right: recording a list of known-false normative
statements, declining to fix them, and tracking the correction as a later grep by a non-owner
converts a known defect into a hoped-for detection — and the detector was itself mis-scoped and
already red. Worse, four of those statements are **acceptance criteria**, so a reviewer ticking them
certifies a claim two changes in the same sprint refute. A gate that certifies a falsehood is worse
than no gate.

Two consequences, both adopted here:

1. **Each owning change makes its own edits**, assigned by name under the sprint's remediation gates
   (G-1 and G-3). This change tracks nothing on their behalf and this section asserts nothing about
   their current state — including line numbers, which had already rotted here (a register that
   decays is worse than none, because it is trusted).
2. **The general rule now lives in change 1's register, not in this design note:** a change that
   discovers false text in a sibling files the finding against **the sibling's `tasks.md`** at
   discovery time. The owner still edits; the obligation lands in the owner's own artifact rather
   than in the discoverer's notes. That is the structural fix for how invariant I-4 was lost between
   changes, and it is what this section did wrong.

What this change owns and has done: its own text carries R-1's corrected wording throughout, and the
two stale artifacts in the **repository** that no change was retiring are retired here (§14.4).

### 14.4 Stale repository artifacts this change retires

Both were still live in the tree at round-2 audit, and both are the archive's own:

- **`src/postgres/migrations/chain_archive/index.ts:25-31`** — *"Not wired into any executing path.
  Nothing in this repo's application code imports this array…"* This is the **origin** of the sprint's
  propagated error: it is a second copy of the stale claim, distinct from the one at
  `001_chain_archive_core.ts:86` that every change quoted, and it is the copy change 4's independently
  false "exported array nothing calls" was derived from. It is retired by this change's deletion of
  the PostgreSQL lineage (§13, task 2.2) — but it is named here so the retirement is deliberate rather
  than incidental, because a file deleted for one reason does not document a claim withdrawn for
  another.
- **`docs/features/full-chain-storage.md:81`** — *"There is currently **no CLI entry point or npm
  script** for this feature."* False since `package.json:46`. This is a documentation file, not code,
  so it is **not** carried away by any deletion and needs an explicit owner: this change, task 7.4.

## 15. Open questions, with owners

| id | question | owner | why it is cheap now |
|---|---|---|---|
| **Q-A1** | Is there a retention policy for the archive — does any height range ever get retired? | **owner** | It no longer selects a layout (§3.3 settles that in both measurement directions), but it does decide whether `auto_vacuum` must be non-zero, and that is irreversible: answered "yes", it must reach change 1's B-3 **before the first archive file exists**, or retired space never returns without a full `VACUUM` |
| **Q-A2** | Change 1's **Q-3**: does the repo-clone channel imply consumers running `archive:sync` from source? | **owner** | Decides whether §11's env-var change is a consumer-facing break or an internal detail. Cheap pre-tag either way; post-tag the answer determines whether it forces a major |
| **Q-A3** | Is a single archive file acceptable at the sizes this deployment will reach, given no incremental BLOB I/O and whole-file backup granularity? | **owner + M-2** | The alternative (splitting the archive across files by height) is foreclosed by §4 and would have to be re-litigated as a product constraint, not a storage one |
| **Q-A4** | Should the snapshot manifest be signed? | **owner** | §9 specifies a digest, not a signature. A digest detects corruption; it does not authenticate the producer. If snapshots are ever published rather than kept, that is `Formal/STORAGE_ALGEBRA.md` §6's revisit condition and a separate change |
| **Q-A5** | Windows, and network filesystems, for snapshot artifacts | **unowned** | No lane covered either; SQLite is known-hazardous on network filesystems, and a snapshot artifact is precisely the file someone will write to one. Named, not claimed |
| **Q-A6** | Is the archive's ingest expected to run **concurrently** with wallet-tier writes in a real deployment? | **owner** | §2's two-file split makes it safe; if the answer is "never concurrent", M-1's concurrent-writer condition can be dropped and the measurement gets cheaper |
