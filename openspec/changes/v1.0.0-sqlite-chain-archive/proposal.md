# Proposal — v1.0.0 SQLite Chain Archive

> **Status:** Draft for the 1.0.0 program. Capability: `chain-archive`. Change id:
> `v1.0.0-sqlite-chain-archive`. This is the **sixth** change of the PostgreSQL→SQLite migration and
> the last one added: it exists because the sprint's premise that the chain archive was unwired was
> found stale, and because the owner asked for archive snapshots. It ports the `chain_archive`
> lineage and its ingest path to SQLite, and specifies snapshot/restore as a first-class capability
> of the archive tier.

## Why

### The archive is wired, and the sprint's non-goal rested on a stale comment

Five sibling changes declared the chain archive out of scope, each citing
`src/postgres/migrations/chain_archive/001_chain_archive_core.ts:86` verbatim — *"Not wired into any
runner path that would execute it."* **The quotation is accurate. The inference drawn from it is
not**, and I re-verified that against this worktree rather than repeating either claim:

```
package.json:46                        "archive:sync": "tsx chain-archive-sync/sync-cli.ts"
chain-archive-sync/sync-cli.ts:4         "This is the production/ops entry point the feature previously lacked"
chain-archive-sync/sync-cli.ts:37-38     createClient({...}); await bootstrapChainArchiveSchema(sql, SCHEMA)
chain-archive-sync/bootstrap.ts:21       await runMigrations(sql, { schema, migrations: chainArchiveMigrations })
chain-archive-sync/bootstrap.ts:6-7      records that this invocation path "was missing", i.e. it was added AFTER
                                          the migration file's comment was written
chain-archive-sync/sync-service.ts:1     import { PgChainArchiveStore } from "../src/postgres/chain-archive-store.js"
chain-archive-sync/sync-service.ts:123   this.store = new PgChainArchiveStore(opts.sql, opts.schema ?? "chain_archive")
tsconfig.json:15                         "include" covers "chain-archive-sync/**/*.ts"  -> npm run typecheck compiles it
tsconfig.build.json:15                   "exclude" lists "chain-archive-sync"           -> npm run build does not
```

`chainArchiveMigrations` is reachable from a real npm script. Two different facts — *"no data and no
production consumer"* and *"not wired"* — were being conflated, and the conflation propagated
through both audit lanes, all four council seats and the synthesis before a cross-vendor audit caught
it. The corrected wording is `v1.0.0-sqlite-engine-core`'s register entry **R-1** (`design.md` §10.1),
adopted here verbatim. Changes 2, 3 and 5 still carry the old wording in their non-goals; §14.3 of
this change's `design.md` lists exactly which lines must be amended, and this change does not amend
them itself.

The consequence is concrete. Change 1 removes the `postgres` dependency outright (R-1). With it gone,
`chain-archive-sync/` breaks at `npm run typecheck` **and** at `npm run archive:sync`. There is no
"leave it alone" option; the only choices are port it or delete it.

### The owner asked for snapshots, and that is what makes SQLite the right home for it

**Owner, answer 1:** *"We should be able to have archive snapshots."*

A PostgreSQL archive snapshot is a `pg_dump` artifact — a logical dump that requires a running
server to produce and another to restore. A SQLite archive is a **file**. Snapshot and restore stop
being a database-administration procedure and become a file-transfer problem, which is the shape the
owner already operates for chain data (a Mithril-style snapshot/restore workflow). This is not a side
benefit of the migration for the archive tier; for this tier it is the largest single benefit, and it
is why the archive is ported rather than stranded on PostgreSQL.

But a database file is not a snapshot *artifact*. An unlabelled `.db` on disk does not say which
network it holds, which heights, which migration lineage produced it, or whether it is complete —
and, because SQLite's write-ahead log holds every commit since the last checkpoint, a bare copy of
the main file silently reverts to an arbitrarily older state while still reporting a clean structural
check. This change specifies what a snapshot **is**, how it is identified, and what is checked on
restore. That is the enhancement mandate, and it is the most valuable content here.

### It is greenfield, which is what makes it cheap

**Owner, answer 2**, on whether `archive:sync` has ever run against a real database: **No.**

So there is **no data, no backfill, and no migration of existing archive content**. The lineage is
replayed from zero against a fresh file. Every hazard that dominates a real storage migration —
dual-write windows, online backfill, cutover, rollback of half-migrated rows — is absent. Migration
`006`'s `ADD COLUMN … GENERATED … STORED`, which any non-empty table rejects, is not even in this
lineage, and the general fresh-lineage rule is change 4's. Say it plainly, because if it were false
this change would be several times larger: **the entire porting cost here is DDL translation, adapter
translation and the snapshot capability. There is no data-migration cost at all.**

This is also why the archive is *not* in change 7 (`v1.0.0-sqlite-data-migration`), which covers the
wallet tier only.

### One correction the research got backwards, and it removed a whole subsystem

L5 measured `DROP TABLE` of a one-million-row range against the equivalent `DELETE` and reported that
`DROP TABLE` *"returns the space"* while `DELETE` returns nothing. The entire case for a
table-per-height-range physical layout rests on that sentence.

I first found that the space half is conditional on `auto_vacuum`, which L5 never varied. Change 1
then re-measured across all three settings and found the claim fails at **every** setting. I
reproduced that independently, on a different table shape and at two scales two orders of magnitude
apart, before adopting it (`design.md` §3.2):

```
av=default rows=6000   DROP  : 55172 -> 55172 KB (returned     0)  |  DELETE: 55172 -> 55172 KB (returned     0)
av=FULL    rows=6000   DROP  : 55240 -> 27624 KB (returned 27616)  |  DELETE: 55240 -> 27636 KB (returned 27604)
av=FULL    rows=120000 DROP  : 97636 -> 48820 KB (returned 48816)  |  DELETE: 97636 -> 48832 KB (returned 48804)
INCREMENTAL rows=120000 DROP  : incremental_vacuum = 194.0 ms      |  DELETE: incremental_vacuum = 188.9 ms
```

**Reclamation is a property of the `auto_vacuum` setting and the number of pages freed, and is
independent of how they were freed.** At `auto_vacuum=0` neither operation returns a byte; at `FULL`
both return the same space within 0.05%; and at `INCREMENTAL` the reclaim cost is carried entirely by
`incremental_vacuum`, which costs the same either way. L5's comparison put the two halves on databases
with different settings and different contents, so the file-size difference it reported is
attributable to the setting, not to the operation.

**The consequence is that table-per-range has no justification left**, and this change rules **one
table per relation**, unconditionally. An earlier draft made the layout conditional on a retention
requirement plus `auto_vacuum`; that condition would have selected the complex layout precisely where
its advantage had evaporated, and it is withdrawn. Each surviving candidate justification — bulk-drop
latency, atomic retirement, bounded per-arm index depth — was checked individually and fails
(`design.md` §3.3). The result deletes a subsystem: `chain-archive-rollover.ts`'s 353 lines, the
`UNION ALL` view, the routing triggers, the arm generator and the `DEFAULT` catch-all all go.

One honest disagreement is recorded rather than smoothed over: change 1 measured `DROP TABLE` about
22× *slower* than `DELETE` at `auto_vacuum=FULL`; I measured them comparable, at 120,000 rows with
`DROP` 14% faster. I did not reproduce the 22× and do not adopt it. **The ruling does not depend on
it** — both harnesses refute L5's claim that `DROP` is the cheap path, and disagree only about which
is marginally worse.

## What changes

1. **The `chain_archive` lineage is ported to SQLite as a fresh, zero-row lineage**, replayed from
   `000_schema` forward against a new file. Every constraint in
   `001_chain_archive_core.ts` gets a named SQLite counterpart, and the mapping is enumerated
   constraint-by-constraint in `design.md` §5 rather than asserted to be mechanical.

2. **The archive gets its own database file**, `umbra-archive.sqlite`, separate from the wallet
   tier's. This adopts the contradiction seat's C5 ruling and is what makes an archive snapshot a
   self-contained artifact you can hand to someone without handing them a wallet. No transaction ever
   spans the two files, and a guard test asserts it. It is **not** in tension with change 4's
   prohibition on one-file-per-`schema`: that requirement governs the multi-tenant `schema`
   parameter *within* a lineage; this is one file per *lineage*, which is the same seat's §2.9
   recommendation (`design.md` §2.3).

3. **`PARTITION BY RANGE` is replaced by one table per relation**, and a table-per-height-range
   layout is **prohibited** with four named revival conditions. The prohibition is written as a
   requirement rather than as silence, because L5's retracted argument is persuasive on first reading
   and will be rediscovered. Two measured hazards of the prohibited layout are kept on the record with
   their scenarios: SQLite performs **no partition elimination**, so a `UNION ALL` view searches every
   arm even with proving `CHECK`s; and the natural `INSTEAD OF` routing trigger has a **silent
   data-loss** mode — an unguarded trigger accepted an out-of-range row, raised nothing, and stored it
   nowhere (`design.md` §3.4). Any revival inherits a mandatory `RAISE(ABORT)` guard arm.

4. **`ATTACH`-per-range is prohibited outright**, in either form, and the prohibition is recorded as
   a requirement so nobody re-proposes it. Three independently fatal facts, all re-verified here on
   the ruled binding: the attach limit is 10 databases plus `main`; a cross-database `REFERENCES`
   clause is a parse error; and in WAL mode a transaction spanning attached databases is not
   atomically committed (reproduced under SIGKILL by two lanes independently — 1/12 WAL trials torn
   against 0/16 with a rollback journal).

5. **Blobs stay in the database.** The archive's own measured payload distribution — `transactions.raw`
   p50 5.9 KB, p90 12 KB, p99 29 KB, max 145 KB — sits below the in-database/filesystem crossover in
   every reading the research produced. The *crossover figure itself* is a timing measurement taken
   on a RAM disk and is re-stated here as an obligation to establish, not as a fact.

6. **The sub-batch logic is not ported.** `SQLITE_MAX_VARIABLE_NUMBER` is 32,766 (re-verified on the
   ruled binding), and the shipped wallet-tier caps each bind 60,000 parameters — but the archive
   store never had a batched path to begin with: `insertTransactionRows` and
   `insertBridgeObservationRows` (`src/postgres/chain-archive-store.ts:214-262`) already issue
   single-row statements in a loop. The archive's write path therefore ports to prepared-statement
   reuse inside one explicit transaction with **no cap acquired**, and a requirement forbids
   introducing one.

7. **The ingest cursor becomes co-transactional with the block bundle it advances past.**
   `chain-archive-sync/sync-service.ts:168-170` writes `putBlockBundle` and `setWatermark` as two
   independently committed transactions today. In one file they fold into one, mirroring the wallet
   tier's `saveAndAdvance` (`design/design.md` §5, `Formal/STORAGE_ALGEBRA.md` §4), and the
   never-ahead-of-data property becomes structural instead of argued.

8. **Snapshot and restore become first-class, specified capabilities** — what a snapshot is (a
   database file with no outstanding write-ahead-log dependency, plus a manifest, as a set), how the
   manifest is derived (**from the artifact after it is produced, never from the source before it**,
   which is what makes the copy primitive's at-or-after capture semantics harmless), how it is
   identified (lineage, network, height range, canonical tip, per-table row counts, irreversible
   pragma values, and a content digest), and what is checked on restore. The copy **primitive** is
   deliberately not named — that is change 5's blocked decision B-6, and this change cites its rule
   rather than pre-empting it.

9. **The archive tier's durability posture is ruled explicitly, not inherited and not weakened by
   default.** The archive is *mostly* re-derivable from chain, which is the standard argument for a
   weaker `synchronous`. But two of its six tables are not: `bridge_observations` was reclassified as
   build-now precisely because it is *"partly Cardano-side and not cleanly re-derivable from Midnight
   block replay alone"* (`design/full-chain-storage-design.md` §7), and `verifier_key_observations`
   covers the one category where *"the indexer has no dedicated VK archive at all"* (§4.5). So the
   premise for weakening is false for part of the tier. The ruling: **the archive keeps the wallet
   tier's default**, and lowering it requires change 5's three preconditions plus a fourth that is
   specific to this tier — a written, per-table re-derivability determination.

10. **Content-addressing gives the archive's largest tier value-integrity for free**, which the
    wallet tier had to add a digest column to obtain (change 5). `chain_blobs.hash` is a SHA-256 the
    store computes itself and never accepts from a caller
    (`src/postgres/chain-archive-store.ts:110-113`), so a corrupted blob is detectable by
    recomputation — the same mechanism `CheckpointStore` already uses
    (`Formal/STORAGE_ALGEBRA.md` §2, Law C1). This change specifies verify-on-read for blobs and
    routes the *non*-content-addressed archive tables to change 5's digest regime, with the
    re-derive-from-header alternative flagged **UNVERIFIED** rather than assumed, following this
    lineage's own honesty discipline (`design/full-chain-storage-design.md` §7).

11. **`chain-archive-rollover.ts` (353 lines) is deleted**, and the four PostgreSQL rollover failure
    modes its runbook reproduces (`design/full-chain-storage-design.md` §4.6) are recorded as
    **retired with reason** rather than silently dropped. The `DEFAULT` catch-all partition — itself
    the cause of all four — is not ported.

12. **The archive database file gets its own writer-generation guard**, which it did not have. The
    program committed to this — *"the archive file, if it is ever wired, gets its own registration
    under its own change"* — when the archive was believed out of scope; the deferral did not travel
    with the archive when it came into scope, and the guard was in no change. `archive:sync` is a CLI
    an operator can start twice, and **SQLite serializing transactions is not the same as a process
    being a single writer**, so every argument here phrased as resting on single-writer serialization
    rested on nothing enforced. The guard mirrors change 3's mechanism and takes its affected-row and
    read-back assertions **from the first migration** rather than importing a bootstrap defect and
    repairing it later; the descriptor source-guard extends to the archive file and its sidecars.

13. **The `archive:sync` CLI's connection contract changes** from `ARCHIVE_PG` (a `postgres://`
    string) to a file path, and `npm run typecheck` / `npm run build` / `npm run archive:sync` are
    required to stay coherent at every commit, which is R-1's closing condition and change 1's
    open question **Q-3**.

## Non-goals (explicitly out of scope)

- **No data migration, no backfill, no dual-write.** `archive:sync` has never run against a real
  database (owner answer 2), so the SQLite lineage is created empty and replayed from `000_schema`.
  This change specifies **no** PostgreSQL→SQLite import path for archive content and **no**
  rollback-to-PostgreSQL path. If the owner's answer is ever corrected, this change is not the one
  that covers it and its cost estimate (`design.md` §13) is void.
- **The driver, the tagged-template shim, the worker topology, the pragma bootstrap and the ext4
  measurement gate are change 1's** (`v1.0.0-sqlite-engine-core`). This change is written *against*
  them and states its dependencies in `design.md` §14.1; it specifies none of them. In particular it
  does **not** choose `page_size` or `auto_vacuum` values — those are change 1's B-3. The layout
  ruling is deliberately **independent** of that decision: an earlier draft made it conditional on
  `auto_vacuum`, and withdrawing that condition is one of the outcomes of change 1's re-measurement
  (`design.md` §3.1). `auto_vacuum` still governs whether retired space ever returns to the
  filesystem, and is recorded and asserted in the snapshot manifest because it is irreversible.
- **Table, index and trigger name prefixing, `STRICT` discipline, the type mapping and the migration
  framework are change 4's** (`v1.0.0-sqlite-schema-parity`). The archive's DDL is written *through*
  change 4's naming layer and inherits its `STRICT` obligation. The `coalesce(contract_address, x'')`
  expression index plus the sentinel-excluding `CHECK` is **change 4's ruled form**, adopted here by
  citation for the one table that needs it; this change does not reinvent it and does not re-specify
  the rule.
- **Transactions, `BEGIN IMMEDIATE`, the lease, contention retry and error-to-code mapping for
  contention are change 3's** (`v1.0.0-sqlite-concurrency-lease`). This change assumes
  `BEGIN IMMEDIATE` on every archive write path and says where; it does not specify the mechanism.
- **The written contracts, the error catalog, the durability probe, the application-level digest
  regime, the corruption-detection gap, observability, and the choice of backup primitive are change
  5's** (`v1.0.0-sqlite-durability-contract`). This change specifies the archive **snapshot
  artifact** — its identity, derivation and verification — and explicitly **does not name a copy
  primitive**, because §6's naming is blocked on change 5's B-6 re-measurement on the ruled binding.
  Where the archive tier's answer could differ from the wallet tier's, `design.md` §10 says so
  explicitly rather than diverging silently.
- **No Merkle tree, no inclusion proofs, no external-verifier protocol.**
  `Formal/STORAGE_ALGEBRA.md` §6 rules against an authenticated data structure for this deployment
  and names *"a future 'export this checkpoint and let someone else verify it' requirement"* as the
  condition that would flip the threat model. The snapshot manifest specified here is a **flat
  root digest over an ordered sequence**, which is §6's own "rudimentary" content-addressing case and
  not the tree it declined. Inclusion proofs, selective disclosure and third-party verification
  remain out of scope, and `design/full-chain-storage-design.md` §9's L2/L3 layers stay at the
  concept level.
- **No archive completeness claim.** The restore-time continuity walk proves that *one* stored header
  chain is internally continuous. It does **not** prove fork completeness, transaction or
  bridge-observation completeness, or body/`extrinsics_root` integrity — the design doc's own v3
  audit fix (`design/full-chain-storage-design.md` §9, §10.9) is adopted verbatim rather than
  quietly improved upon. Anything stronger is gated on body/extrinsics sync landing, which is not
  scheduled.
- **No reorg-handling redesign.** `design/full-chain-storage-design.md` §6's insert-only,
  status-flip policy is carried across unchanged. `setCanonical`'s reorg-flip support is ported as
  it stands; the fork-following logic `chain-archive-sync/sync-service.ts:150-153` names as out of
  scope stays out of scope.
- **No new archive tables and no reclassification of a deferred category.** The five UNVERIFIED
  deferrals (`design/full-chain-storage-design.md` §7 — zswap, unshielded UTXO, dust, contract
  state, generic ledger events) stay deferred and stay flagged UNVERIFIED. Porting is not the moment
  to relitigate the data model.
- **No ETL sorted-staging backfill stage.** L5 recommends one on a measured 1.8–2.05× ingest gain,
  but every number supporting it is tmpfs-tainted, the archive has no backfill to run (owner answer
  2), and steady-state tip-following does not need it. Recorded as a candidate for after the
  measurement gate, specified by nobody.
- **No performance number is asserted as fact.** Six of seven research lanes benchmarked against a
  32 GB tmpfs RAM disk; re-measured on ext4, WAL `synchronous=FULL` moved from a published
  88,485 commits/s to 379 — a 233× error, and two of L5's own conclusions invert under it. **No L5
  throughput, latency or pragma figure appears in this change as fact.** Every
  performance-dependent property is an obligation to establish under change 1's gate with conditions
  declared. The structural facts re-verified here (`design.md` §3.4, §5.6, §8.2) are limits, parse
  results and pragma behaviour — not timings.
- **Windows and network filesystems.** No lane covered either; SQLite is known-hazardous on network
  filesystems and a snapshot artifact is exactly the thing someone will try to write to one. Named
  as an unowned surface (`design.md` §15 Q-A5), not claimed.
- **No re-proof in Lean.** The cut-line `{T3, T5, W1, C1}` does not touch the archive at all — the
  archive is not in the formal model. That is not evidence this port is safe; the archive's own
  test suite carries its correctness claim and must be **re-executed, not amended**.

## Impact

- **New files.** `src/sqlite/migrations/chain_archive/001_chain_archive_core.ts` (the translated
  DDL), `…/index.ts` and a `writer_generation` migration; `src/sqlite/chain-archive-store.ts` (the
  ported adapter); **outside `src/`** — the snapshot, manifest-derivation and restore-verification
  tooling, beside the archive sync entry point rather than in the published build, because the
  descriptor ban takes no exemption for our own code (`design.md` §9.8);
  `chain-archive-sync/bootstrap.ts` and `sync-cli.ts` rewritten against the new client.
- **Deleted files.** `src/postgres/chain-archive-store.ts`, `src/postgres/chain-archive-rollover.ts`
  (353 lines), `src/postgres/migrations/chain_archive/*` including `partition-config.ts` and the
  `createHeightPartitions`/`sql.unsafe()` partition-bound path, and their Testcontainers-backed tests —
  replaced by file-backed equivalents, not merely retargeted. The partition-size constant has no
  consumer once the layout is one table per relation.
- **Frozen-surface breaks, all cheap pre-tag and expensive after.** `docs/STABILITY.md:46` states
  verbatim *"Current version: `0.9.5` — the commitments above are NOT yet in force,"* and `:60-61`
  that a break between `0.9.5` and `1.0.0` is permitted. Three archive-visible breaks:
  `ChainArchiveInvariantError`/`ChainArchiveCheckViolationError`'s `constraintName` is no longer
  sourced from a structured driver field (§8.2); `ChainArchiveStore`'s construction takes a file
  path rather than an `UmbraDBSql` over a `postgres://` connection; and the `archive:sync` env
  contract changes from `ARCHIVE_PG` to a path. Each costs a `CHANGELOG.md` entry landed pre-tag and
  independently forces a major version landed after. Note that the archive error classes are
  *excluded* from the frozen barrel today (`src/index.ts:58`), which makes the first of the three
  cheaper than it looks — but not free, because `constraintName` is observable to any consumer
  running `archive:sync` from a repo clone.
- **A capability gained that PostgreSQL could not give.** A snapshot stops being a `pg_dump` and
  becomes a file plus a manifest, verifiable offline with no server, transferable by any file
  mechanism the owner already runs for chain data.
- **A capability lost, and it must not be buried.** `pg_dump --schema=chain_archive` scoped a backup
  to the archive *within* one server; the SQLite unit is the whole file. The two-file split (§2)
  recovers tier-level scoping and nothing finer. There is no per-table, per-height-range or
  point-in-time archive backup, and point-in-time recovery becomes a deployer capability
  (an atomic filesystem or volume snapshot) that UmbraDB cannot provide — change 5's §6 point 5,
  which applies to this tier too.
- **Risk.** The dominant risks here are both *silent*. An unguarded `INSTEAD OF` routing trigger
  accepts a row, raises nothing, and stores it nowhere — measured, §3.3. A snapshot manifest derived
  from the source rather than the artifact under-reports what the artifact contains, and the
  discrepancy is invisible until a restore is checked against it — §9.4. Each is specified as a
  requirement with a scenario that would catch it.
