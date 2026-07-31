# L7 — Prior art: SQLite in cryptocurrency clients

Lane: `l7-precedent`. The only lane doing external research. Worktree cut from `origin/main`.

---

## 1. Verdict

**The destination is well-trodden; the direction of travel is not; and the dual-backend hedge has
already been attempted and abandoned by a project this repo depends on.** Three parts:

- **Wallet-scale storage on SQLite is the industry default, not a risk.** Zcash
  (`zcash_client_sqlite`, now the storage engine of Zallet — the *only* remaining Zcash full-node
  wallet since zcashd's end-of-support halt on 2026-07-18), Penumbra (`pcli` view service), Bitcoin
  Core (descriptor wallets), BDK, Core Lightning (default backend) and LND (recommended backend) all
  store exactly what UmbraDB stores — decrypted notes, a note-commitment tree, sync cursors,
  checkpoints — in SQLite. Every one of UmbraDB's five primitives has a direct analogue in a shipped
  SQLite schema. Nothing in this lane's evidence suggests the primitives cannot move.
- **The chain archive is the opposite case, and the strongest evidence is in-house.** UmbraDB's own
  upstream — the Midnight indexer — *already* runs its content-addressed ledger node store on SQLite,
  at 88 GB of node store / ~161 GB total at half of Preprod height, growing ~1 GB/hour
  (`docs/research/indexer-parallelism-roadmap.md`). Chain-scale-on-SQLite is not merely possible; it
  is what this project is already operating. But that same document records the pathology: a
  content-addressed store keys every row by a uniformly random 32-byte hash, which is the exact
  write-amplification case B-trees are worst at, and the exact reason Erigon built ETL sorted
  staging. `ckpt_chunks.hash` and `chain_blobs` are the same shape.
- **The direction is unusual and the dual-backend seam is a trap.** No serious crypto project has
  migrated *from* PostgreSQL *to* SQLite. Traffic runs the other way (BDB to SQLite, bbolt to SQLite,
  sled to SQLite) or adds Postgres as a second option (CLN 0.7.3, LND, the Midnight indexer). Two of
  those three now document that the seam did not pay: **Core Lightning refuses to support migrating
  an existing SQLite node to Postgres at all** ("move funds to a new node, then shut the old one down
  permanently"), and **the Midnight indexer's two DDL lineages have already drifted apart and shipped
  bugs because of it**. That is direct support for the owner's full-replacement scope decision, and
  direct evidence against any lane proposing a backend-abstraction seam.

**One line:** *well-trodden at the wallet, in-house-proven but write-path-hazardous at the archive,
and correct to do as a full replacement rather than as a second backend.* The single hardest thing to
replace is not a query or a constraint — it is **`docs/CONTRACT.md` §6, the live-backup guarantee**,
which no SQLite project in this survey has solved cleanly and several have publicly failed at.

---

## 2. Blockers

Framed as *precedent-derived* blockers: places where the industry record says a named UmbraDB
commitment is at risk. Feature-by-feature gap analysis belongs to L1–L6; where I touch their
territory I flag it.

### B1 — T5's exclusion constraint has no precedent in any SQLite wallet, because no SQLite wallet enforces temporal coherence in the engine

- **Postgres feature:** `btree_gist` + `tstzrange` + a `GENERATED ALWAYS AS (...) STORED` validity
  column + `EXCLUDE USING gist (ns WITH =, scope WITH =, key WITH =, validity WITH overlap)`
  (`src/postgres/migrations/001_temporal_kv.ts:57,95,97`). This *is* the runtime enforcement of **T5**.
- **What SQLite offers:** nothing equivalent. No exclusion constraints, no range types, no GiST. The
  only mechanism is a `BEFORE INSERT/UPDATE` trigger doing a manual overlap probe and
  `RAISE(ABORT,...)` — <https://www.sqlite.org/lang_createtrigger.html>. PostgreSQL 18's
  `WITHOUT OVERLAPS` has no SQLite counterpart either.
- **Precedent check:** I read the schemas of `zcash_client_sqlite`, Penumbra's view service, BDK,
  Bitcoin Core and CLN. **None enforces a temporal non-overlap invariant in the database at all.**
  Zcash's nearest equivalent, `scan_queue`, gets only
  `CONSTRAINT range_bounds_order CHECK (block_range_start < block_range_end)` plus two single-column
  `UNIQUE` constraints on the range endpoints — a strictly weaker invariant than non-overlap.
  Gap-freedom is maintained in Rust, not in SQL.
- **Gap classification:** *closeable in application code or a trigger, with a named loss of strength.*
  There is no precedent for doing better, which is itself the finding: the industry's answer to "how
  do you enforce temporal coherence in SQLite" is "you don't; you enforce it above the engine."
- **Frozen commitment touched:** **T5** (frozen Lean cut-line) and, more sharply, the
  **abstract-to-concrete refinement bridge**. Today T5 is discharged at runtime by a declarative
  constraint the database *cannot* violate. Under SQLite it would be discharged by a trigger *and* by
  application discipline — a materially longer trusted bridge for the same unmechanized-refinement
  claim (`ROADMAP.md:91-94`). The P1–P10 conformance suite becomes the *only* empirical bridge rather
  than one of two. Restate it in `ROADMAP.md`; do not absorb it silently.
  **Dependency: L-TemporalKV owns the design; I supply the negative precedent only.**

### B2 — The GIN-indexed identifier array: the precedent says redesign the schema, and upstream already did it

- **Postgres feature:** `identifiers text[] NOT NULL DEFAULT '{}'` with
  `CREATE INDEX ... USING gin (identifiers)` and subset-containment queries
  (`src/postgres/migrations/004_transaction_history.ts:29,37,41`).
- **What SQLite offers:** no array type, no GIN. Options: a JSON string with `json_each()`, FTS5, or a
  junction table.
- **Precedent — and it is exact.** The Midnight indexer solved this identical problem, on this
  identical chain, in its own SQLite lineage. Its Postgres schema has `identifiers BYTEA[] NOT NULL`
  on `regular_transactions`; its SQLite schema **drops the column entirely and adds a junction
  table**:
  ```sql
  -- indexer-common/migrations/sqlite/001_initial.sql
  CREATE TABLE transaction_identifiers (
    id INTEGER PRIMARY KEY,
    transaction_id INTEGER NOT NULL REFERENCES regular_transactions (id),
    identifier BLOB NOT NULL
  );
  CREATE INDEX transaction_identifiers_transaction_id_idx ON transaction_identifiers (transaction_id);
  CREATE INDEX transaction_identifiers_identifier_idx ON transaction_identifiers (identifier);
  ```
- **Gap classification:** *closeable with a schema redesign*, with a known-good shape already written
  by upstream. The containment query becomes an anti-join rather than a single index probe —
  semantically equivalent, different plan.
- **Frozen commitment touched:** none directly. `PgTransactionHistoryStorage` is on the frozen G1
  surface, but the interface is the wallet SDK's `TransactionHistoryStorage`, not the schema.
  `docs/SCHEMA.md` changes; the exported surface need not.
  **Dependency: L-TransactionHistory owns the redesign. Steal the upstream table verbatim.**

### B3 — Random-hash-key B-tree insert is the archive's real ceiling, and this project has already measured it

- **Not a feature gap — a shared pathology.** `ckpt_chunks.hash` is a bare SHA-256 `bytea` primary key
  (`docs/CONTRACT.md` §8) and the chain archive is content-addressed too.
- **What the record says:** Erigon's stated rationale, quoted in this repo's own research doc, is
  *"B-tree databases suffer write amplification with random inserts… loading them in sorted order via
  heap"* leading to *"dramatic (orders of magnitude) write speed improvements."* The repo's own note
  continues: *"our node store is content-addressed, so every key is a uniformly random 32-byte hash…
  Measured penalty for random vs sequential keys is ~19x; two ascending passes recover ~94% of
  sequential speed"* (`docs/research/indexer-parallelism-roadmap.md`, Stage 2.1).
- **The nuance the brief asked for.** UmbraDB's measured **CPU-bound** result *weakens* the usual
  "SQLite cannot do archive scale" argument — but only for the *read* path, and only while the working
  set fits in page cache. The measurement was 70% of one core, **27 KB/s physical reads**, 23 GB page
  cache against an 88 GB store. Reads are already served from memory, so B-tree traversal cost is CPU
  and syscall overhead, which Postgres also pays. The measurement says nothing about the **write**
  path — physical writes were 2 MB/s and the store grows ~1 GB/hour with no GC in the running version
  (R3). **B3 is a write-side ceiling and the CPU-bound finding does not retire it.**
  Per trap 8: for "CPU-bound means SQLite is fine at archive scale" to be a *meaningful* conclusion,
  the page-cache residency ratio (23/88 GB) would have to hold as the store grows past RAM. It will
  not. State the ceiling as *"holds while working set fits in page cache"*, never as a general result.
- **Gap classification:** *closeable with a schema redesign plus write staging* (ETL-style sorted
  batch inserts, which content-addressing makes provably order-independent — see D5); *not closeable*
  by pragmas alone.
- **Frozen commitment touched:** `Performance/CEILINGS.md` SC-1 through SC-6 must be re-derived. No
  frozen API breaks. **Dependency: L5 owns this. This section is my contribution to L5.**

### B4 — Backup/restore §6 breaks. This is the best-sourced negative in the lane and the hardest blocker.

- **Contract today:** `docs/CONTRACT.md` §6 promises a *consistent* backup of a live database via
  `pg_dump --format=custom --schema=...`, explicitly including the guarantee that **a dump taken
  mid-GC restores to an internally consistent state**, because reads run `REPEATABLE READ` and
  `pg_dump` takes one snapshot. It is a one-command, zero-downtime, mid-GC-safe story.
- **No SQLite project in this survey has an equivalent.** Four independent primary sources:
  - **Core Lightning**, `docs/backup`: *"Snapshot-style backups of the lightningd database is
    **discouraged**, as any loss of state may result in permanent loss of funds."* And on naive
    copies: copying the file while the daemon runs *"may result in the file not being copied
    properly ... potentially leading to a corrupted backup file that cannot be recovered from. You
    have to stop lightningd before copying the database."*
  - **CLN explicitly rejects `VACUUM INTO`** — which was my own first instinct, and it is wrong:
    > *"sqlite3 has .dump and VACUUM INTO commands, but note that those lock the main database
    > for long time periods, which will negatively affect your lightningd instance."*
  - **LND has no live-backup primitive at all on its SQL backends.** In `kvdb/sqlbase/db.go`, the
    `Copy(w io.Writer)` method returns `errors.New("not implemented")`. bbolt implements `Copy` via
    `tx.WriteTo`; the SQL backends do not. `docs/sqlite.md` contains zero backup guidance.
    `docs/safety.md` instead tells you to never restore a channel DB, and to back up the static
    channel backup (SCB) file instead.
  - **Zallet** (Zcash's SQLite wallet), `book/src/guide/backup.md`: *"There is currently no single
    command or RPC method that produces a complete wallet backup (#195 tracks adding one)"* and step 1
    of the documented procedure is literally *"Stop Zallet. wallet.db is a SQLite database; copying it
    while the wallet is running can produce a torn copy."*
- **The one project that solved it used the online backup API, not `VACUUM INTO`.** Bitcoin Core's
  `backupwallet` RPC, in `src/wallet/sqlite.cpp`, calls `sqlite3_backup_init(db_copy, "main", m_db,
  "main")` then `sqlite3_backup_step(backup, -1)` — single-shot, all pages, not incremental.
  `doc/managing-wallets.md`: *"To backup the wallet, the backupwallet RPC or the Backup Wallet GUI
  menu item must be used to ensure the file is in a safe state when the copy is made."* That works
  because a Bitcoin Core wallet is megabytes.
- **And the streaming-replication workaround has a documented, retracted failure.** CLN previously
  recommended **Litestream** and withdrew the recommendation:
  > *"Previous versions of this document recommended this technique, but we no longer do so.
  > According to issue 4857, even with a 60-second timeout that we added in 0.10.2, this leads to
  > constant crashing of lightningd in some situations."*
  Their replacement is a built-in dual-write replica (`sqlite3://main:backup`, PR 4890, merged
  2021-11-17, shipped v0.11.0): the connection struct holds both a `conn` and a `backup_conn`, seeds
  the replica via the online backup API, then forwards every statement to both. A user on that PR
  reports the initial sync of a **200 MB** database took **~10 minutes** with no progress output.
- **Gap classification:** *closeable in application code for the wallet tier* — but only by adopting a
  replication design, not by finding a better dump command. **Not closeable at archive scale** with
  anything resembling the current one-command story: at hundreds of GB the online backup API holds a
  read lock for the duration, and `VACUUM INTO` holds it longer.
- **Frozen commitment touched: G4 contract §6, directly and unavoidably.** The `pg_dump` command is
  quoted verbatim in the contract and must be rewritten. The substantive guarantee — "a mid-GC dump is
  safe to restore" — is preservable in principle, since the online backup API reads a consistent
  snapshot; but the mechanism, the cost model, the downtime profile, and the "never dump chunk tables
  and manifest tables in separately-timed passes" caveat all change. **Whoever owns the contract
  rewrite should read CLN's `docs/backup` and `docs/advanced-db-backup` in full before drafting.**

### B5 — Concurrent access: the lease model survives and probably improves; multi-process does not

- **Contract today:** `docs/CONTRACT.md` §5 already says *"Do not run two writer processes"*, and the
  lease is a session-scoped advisory lock, explicitly **not** a fencing token.
- **What SQLite offers:** WAL gives many readers plus exactly one writer. `busy_timeout` converts
  contention into a wait rather than an immediate `SQLITE_BUSY`. Bitcoin Core takes the strictest line
  available in `SQLiteDatabase::Open` (`src/wallet/sqlite.cpp`): it sets
  `PRAGMA locking_mode = exclusive`, then executes `BEGIN EXCLUSIVE TRANSACTION` and holds it for the
  life of the process, throwing a runtime error naming the likely culprit — another instance of the
  client — if the lock cannot be taken. **The OS file lock IS the writer lease**, and it is arguably
  stronger than `pg_advisory_lock`: a dead process releases it via the kernel rather than via a
  connection timeout, and the failure mode is a named startup error rather than silent concurrent
  corruption.
- **The universal industry policy is that nobody opens the wallet DB from a second process.** Bitcoin
  Core enforces it mechanically, as above. LND exposes gRPC only; `lncli` never touches the file. CLN's
  `sql` RPC deliberately materializes a *separate throwaway* sqlite3 database from RPC output rather
  than exposing the wallet file read-only, and plugins observe writes through the in-process
  `db_write` hook. Zallet is JSON-RPC to a daemon owning a single `rusqlite::Connection`.
  **UmbraDB is already shaped correctly for this** — it is a library inside one writer process.
- **Precedent that this is a real trap if you get it wrong:** BDK shipped a wallet that panicked with
  `SQLite error: database is locked` when syncing about 35,000 UTXOs
  (<https://github.com/bitcoindevkit/bdk/issues/1827>), found in production on iOS and Android. The fix
  was to enable WAL and a 5000 ms `busy_timeout` (<https://github.com/bitcoindevkit/bdk/pull/1836>).
- **The contention pattern to copy is LND's**, in `sqldb/`: the DSN option `_txlock=immediate` so write
  transactions take their lock at `BEGIN` rather than on first write, plus a bounded randomized
  exponential retry layer (`DefaultNumTxRetries = 20`, `DefaultRetryDelay = 50ms`,
  `DefaultMaxRetryDelay = 1s`) shared by both the SQLite and Postgres paths. It was added for Postgres
  `SQLSTATE 40001` serialization failures (lnd issue 8049) and makes the two engines behave alike.
- **Gap classification:** *closeable in application code, and arguably an upgrade.*
- **Frozen commitment touched:** **G3 error catalog.** `TransactionPoolerDetectedError` becomes
  unreachable — there is no pooler — and `LEASE_TIMEOUT` / `MIGRATION_LOCK_TIMEOUT` change mechanism.
  Removing a code is a **breaking** change under G2; keeping a permanently-unreachable code is the
  non-breaking option. Name whichever you choose, in the CHANGELOG.

### B6 — Dynamic typing will silently corrupt large integers, and upstream already shipped that bug

- **Postgres feature:** static types. `bigserial`, `bigint`, `CHECK (octet_length(hash) = 32)`.
- **What SQLite offers:** type *affinity*, not types. A declared type SQLite does not recognise gets
  NUMERIC affinity and will coerce values into it.
- **Measured on this machine** (`/tmp/l7/affinity.mjs`, Node 24.18.0 `node:sqlite`, SQLite 3.53.1):
  ```
  sqlite_version = 3.53.1
  col a declared: BYTEA   col b declared: BLOB   col c declared: BIGINT   col d declared: TEXT
  { ta: 'blob',    tb: 'blob', tc: 'integer', td: 'text' }   -- inserting a Uint8Array
  { ta: 'integer', tb: 'text', tc: 'integer', td: 'text' }   -- inserting the string "42"
  ```
  A column declared `BYTEA` stores the string `"42"` as an **integer**; a column declared `BLOB`
  stores the same value as **text**. Same input, different storage class, purely from the declared
  type name.
- **Not hypothetical — upstream shipped it twice.** The Midnight indexer's SQLite lineage still
  contains two `BYTEA` columns copy-pasted from the Postgres lineage
  (`indexer-common/migrations/sqlite/001_initial.sql:112`, `008_contract_events.sql:38`). And
  migration `003_spo_stake_integer.sql` exists solely to repair a precision bug, in its own words:
  > *"SQLite REAL is IEEE-754 f64, which only represents integers exactly up to 2^53 (approx.
  > 9.0 x 10^15). Cardano total supply is 4.5 x 10^16 lovelace and aggregate SUM queries over per-pool
  > stakes can exceed 2^53, so keeping these columns as REAL would silently lose precision... SQLite
  > cannot change a column's type in place, so rebuild each table."*
  Note the second half: **SQLite cannot `ALTER COLUMN TYPE`.** Fixing a type mistake means
  create-new-table, `INSERT INTO ... SELECT CAST(...)`, drop, rename, and rebuild every index. That is
  the real cost of getting affinity wrong, and it grows with table size.
- **Gap classification:** *closeable in application code*, via `STRICT` tables — BDK uses `STRICT` on
  every single table — plus `CHECK (typeof(x) = 'blob')` guards. Note CLN disables `STRICT` during
  migrations precisely because legacy rows have wrong affinity; plan for that.
- **Frozen commitment touched:** none broken, but an existing one is *reinforced*. `README.md`'s
  Watermarks invariant — *"Large integers cross the boundary as decimal strings, not JS numbers, so a
  block height cannot silently lose precision"* — is exactly the discipline that would have saved the
  indexer's Cardano stake columns. Keep it; it becomes more load-bearing, not less.

### B7 — A dual-backend seam is the thing to avoid, and there is a measured price tag

- **Not a Postgres-feature gap** — a design-direction warning, because the brief invites a lane to
  propose an abstraction seam if its evidence demands one. Mine says do not.
- **Evidence 1 — the seam costs, measured in the closest comparable codebase.** The Midnight indexer
  runs Postgres (`cloud`) and SQLite (`standalone`) behind Cargo features. On `midnight-indexer`
  commit `0775a15`: **212 conditional-compilation sites across 41 source files**, plus two
  hand-maintained DDL lineages, to support two engines for one logical schema.
- **Evidence 2 — the seam drifts.** The lineages are out of sync: Postgres at `007_*`, SQLite at
  `009_*`, different numbering, SQLite-only migrations. One exists purely to repair drift:
  > ```sql
  > -- indexer-common/migrations/sqlite/005_blocks_height_idx.sql
  > -- Add a UNIQUE index on `blocks.height`.
  > -- The postgres schema declares `height BIGINT NOT NULL UNIQUE`, which gives
  > -- postgres an implicit btree on height. The sqlite schema lacks that UNIQUE
  > CREATE UNIQUE INDEX IF NOT EXISTS blocks_height_idx ON blocks (height);
  > ```
  An index Postgres got for free from a `UNIQUE` declaration was simply missing on SQLite until
  someone noticed. Same team, same repo, same review process. The two `BYTEA` leftovers of B6 are the
  same failure in the other direction.
- **Evidence 3 — the seam does not deliver portability anyway.** Core Lightning has had both engines
  since 0.7.3 and still states: *"If you want to continue a node that started using an SQLITE3
  database, note that we do not support this. You should set up a new PostgreSQL node, move funds from
  the SQLITE3 node to the PostgreSQL node, then shut down the SQLITE3 node permanently."* LND says the
  same thing in different words: *"LND requires a single consistent backend"* and *"Once migrated to
  either Postgres or SQLite, it is not possible to switch."* Two backends, zero migration path between
  them. A third-party tool (`fiatjaf/mcldsp`) exists to move a CLN database from SQLite to Postgres
  precisely because the project itself will not.
- **Gap classification:** n/a — this is a recommendation, and **it supports the owner's existing scope
  decision.** Any lane proposing a `StorageBackend` interface to keep `src/postgres/` alive should
  read this section first.
- **The counter-consideration, stated honestly.** Both LND and CLN *do* run their full test suite
  against multiple backends, and they consider it worth the CI cost specifically because they do not
  trust one backend to stand in for another — lnd issue 8049, Postgres serialization failures, is
  exactly the class of bug a SQLite-only suite would hide. That argument does not apply to UmbraDB
  under full replacement, since there is no second backend to be surprised by. But it does mean the
  P1-P10 suite must be re-run against SQLite from scratch rather than assumed to carry over.

### B8 — `SQLITE_BUSY` has no home in the frozen G3 retryable set, and mishandling it caused a P0 fund-loss bug in LND

**This is the single strongest negative this lane found, and it lands directly on a frozen commitment.**

- **The frozen commitment:** G3 freezes the retryable set as exactly
  `{CONNECTION_ERROR, TRANSACTION_FAULT, LEASE_TIMEOUT, MIGRATION_LOCK_TIMEOUT}`
  (`docs/ERROR-CATALOG.md`, `ROADMAP.md` §G3). **`SQLITE_BUSY` maps cleanly onto none of them.** It is
  not a connection failure, not a transaction fault, not a lease timeout, not a migration lock
  timeout. It is a fifth thing: a transient, retryable, entirely-normal contention signal that
  Postgres simply does not produce, because Postgres blocks instead of returning.
- **The precedent, in full.** [lightningnetwork/lnd#7869](https://github.com/lightningnetwork/lnd/issues/7869),
  *"Force closes for commitment not revoked, probable SQLite management issue"*, labelled **P0**,
  milestone v0.17.0. An operator on lnd 0.16.4 with the SQLite backend:
  > *"zgrepping for `SQLITE_BUSY` returns a LOT of results. Is this normal in any way? Doesn't lnd use
  > wal for the sqlite database, and isn't it the only process accessing the database for writes
  > anyway? why should the database be busy at all?"*
  > *"`[ERR] HSWC: ChannelLink(...): unable to revoke commitment: database is locked (5)
  > (SQLITE_BUSY)` relating to the channel that got FCed 36 minutes later.... is SQLite implementation
  > experimental? Why isn't there a big red warning sign about this?"*
  Root cause, diagnosed and reproduced on regtest by a maintainer: lnd failed *before* sending the
  revocation to the peer but *after* advancing local state — so the state machine was ahead of the
  counterparty, and the next HTLC forced a channel close. Fixed in
  [#7927](https://github.com/lightningnetwork/lnd/pull/7927): *"If a revoke failed in the past, we
  wouldn't tear down the link. This could lead to desynchornized state, eventually leading to a force
  close."*
- **The maintainer's own words**, from that thread:
  > *"Re `SQLITE_BUSY`, the current logic just sets a value, but then doesn't actually try re-execute
  > the transaction before reporting the error back to the caller."*
  > *"Usage of the `sqlite` backend requires a build tag... **bbolt (even with all its issues) should
  > be considered the most stable DB backend.**"*
- **The failure is NOT corruption and NOT lost commits.** It is that a *transient* BUSY, surfaced to
  the caller as an ordinary application error mid-protocol, left durable state advanced while the
  external world was not told. **That is precisely UmbraDB's `saveAndAdvance` hazard class**, expressed
  in a different vocabulary: `docs/CONTRACT.md` §1's whole purpose is preventing a cursor from
  outrunning its data. A mis-typed BUSY that a caller treats as fatal, mid-composition, is the same
  bug with the arrow pointing the other way.
- **Timeouts alone do not fix it, and the numbers are much larger than anyone's default.** The
  reporting operator: *"after increasing BUSY_TIMEOUT (first to 1m, then **10m**) I got no more
  timeout errors not FCs"* — and a follow-on report
  ([#8125](https://github.com/lightningnetwork/lnd/issues/8125)) still saw stuck HTLCs at a 10-minute
  timeout. Core Lightning **hardcodes 60000 ms** in `db/db_sqlite3.c` and deliberately declined to
  expose it as a knob (rustyrussell, on the PR that added it: *"the user surely prefers a delay to a
  crash! Providing knobs like this is a last resort."*). LND's shipped default is **5000 ms**.
  **If you ship SQLite in a daemon, 5 s is not a default — it is a bug.**
- **The minimum viable configuration is four layers, not one.** LND now runs all of:
  1. `_txlock=immediate` on the DSN, so a write transaction takes its lock at `BEGIN` instead of
     upgrading a DEFERRED read lock mid-transaction (`sqldb/sqlite.go`; **Core Lightning does *not*
     do this**, and also does not set `journal_mode=WAL` by default — that is operator opt-in);
  2. a `busy_timeout`;
  3. an application-level retry classifier — `DefaultNumTxRetries = 20`,
     `DefaultRetryDelay = 50ms`, `DefaultMaxRetryDelay = 1s`, jittered and doubling
     (`sqldb/interfaces.go`);
  4. a connection pool deliberately capped at two: *"SQLite only supports a single writer, so a low
     default reduces contention on the busy_timeout"* — `DefaultSqliteMaxConns = 2`
     (`sqldb/config.go`). More connections cannot buy write throughput, only contention.
- **Two further LND bugs show how the retry layer itself fails.**
  [#10565](https://github.com/lightningnetwork/lnd/pull/10565): `db.sqlite.busytimeout`,
  `pragmaoptions` and `maxconnections` were wired up but **unused** by the native-SQL store, with
  `busy_timeout` hardcoded to 5000 ms regardless of operator config — so operators who "fixed it by
  raising the timeout" were fixing only half their process.
  [#10558](https://github.com/lightningnetwork/lnd/issues/10558) /
  [#10561](https://github.com/lightningnetwork/lnd/pull/10561): SQLite auto-rolls-back on
  `SQLITE_IOERR`; lnd's explicit rollback then failed with *"cannot rollback - no transaction is
  active"*, **masking the original error and defeating the retry classifier** — symptom was Android
  wallets permanently stuck at block 123000. The fix had to mask extended result codes
  (`code & 0xFF`) and reclassify `SQLITE_IOERR` / `SQLITE_FULL` / `SQLITE_LOCKED` as retryable.
- **Gap classification: *not closeable without changing the frozen error surface.*** Either a new
  error code is added (additive, non-breaking under G2, and the natural choice — call it
  `BUSY_TIMEOUT` or fold it into a widened `TRANSACTION_FAULT` `faultKind`), or `SQLITE_BUSY` is
  translated onto an existing retryable code, which is semantically wrong and will mislead callers
  who tune retry policy per code. **The set itself is frozen; adding to it is a minor.** This must be
  decided explicitly, not discovered in `translateSqliteError`.
- **Frozen commitments touched: G3** (error catalog and retryable set) and, indirectly,
  **`docs/CONTRACT.md` §1 and §4** — the save-retry caveat's "re-check `history()` before retrying"
  rule needs a BUSY-shaped sibling. **The generalized lesson from #7869 is that engine configuration
  is necessary but not sufficient: every write path must be idempotent and restartable, because BUSY
  will eventually escape the retry layer.** UmbraDB is better positioned than LND was — content
  addressing makes chunk writes naturally idempotent, and `saveAndAdvance` is already one transaction
  — but the error taxonomy has to admit the new failure exists.

---

## 3. Evidence

### 3.1 Commands run in this lane, with output

**In-house: the Midnight indexer's engine configuration** — the upstream UmbraDB ingests from.

```
$ wsl -e bash -lc "sed -n 28,34p /root/midnight-testnet/indexer-config.yaml"
  storage:
    cnn_url: "/root/midnight-testnet/indexer-data/indexer.sqlite"

  ledger_db:
    cache_size: "1kiB"
    cnn_url: "/root/midnight-testnet/indexer-data/ledger-db.sqlite"
```
Both the API/wallet database and the content-addressed ledger node store are SQLite in the deployment
this project runs.

```
$ cd /root/midnight/midnight-indexer && git log -1 --format="%H %ci"
0775a15d15c51e430520343e26eabfc1fbd481bf 2026-07-21 21:26:40 +0100

$ grep -n "Supports both" README.md
70:- Supports both PostgreSQL (cloud) and SQLite (standalone) storage backends.
79:The standalone Indexer combines the Chain Indexer, Indexer API, Wallet Indexer and SPO Indexer
   components in a single executable alongside an in-process SQLite database.
```
**The engine choice upstream is driven by deployment topology, not by scale**: single binary means
SQLite, microservices means Postgres. UmbraDB is unambiguously the former shape — single-writer,
local, a library and not a service (`README.md:9-12`).

**The archive-scale schema, both engines, side by side:**
```
$ cat indexer-common/migrations/sqlite-ledger-db/000_ledger_db.sql
CREATE TABLE ledger_db_nodes (key BLOB PRIMARY KEY, object BLOB NOT NULL);
CREATE TABLE ledger_db_roots (key BLOB PRIMARY KEY, count INTEGER NOT NULL);
CREATE INDEX ledger_db_roots_count_idx ON ledger_db_roots (count);

$ head -8 indexer-common/migrations/postgres/000_ledger_db.sql
CREATE TABLE ledger_db_nodes (key BYTEA PRIMARY KEY, object BYTEA NOT NULL);
CREATE TABLE ledger_db_roots (key BYTEA PRIMARY KEY, count BIGINT NOT NULL);
CREATE INDEX ON ledger_db_roots (count);
```
The roughly 88 GB content-addressed store is two tables of `(BLOB PRIMARY KEY, BLOB)`. This is the
archive tier's precedent, and it is a positive one, subject to B3.

**Dual-backend seam cost** (run inside `/root/midnight/midnight-indexer`, `--include=*.rs`, with
`./target` excluded):
```
cfg sites matching feature = standalone / feature = cloud : 212
source files containing them                             :  41

$ ls indexer-common/migrations/postgres indexer-common/migrations/sqlite
postgres: 000_ledger_db.sql 001_initial.sql 002_dust_generations_qdo_fields.sql
          003_block_tree_end_indexes.sql 004_block_dust_merkle_roots.sql 005_bridge_events.sql
          006_contract_events.sql 007_unshielded_utxos_owner_composite_indexes.sql
sqlite:   001_initial.sql 002_dust_generations_qdo_fields.sql 003_spo_stake_integer.sql
          004_block_tree_end_indexes.sql 005_blocks_height_idx.sql 006_block_dust_merkle_roots.sql
          007_bridge_events.sql 008_contract_events.sql 009_unshielded_utxos_owner_composite_indexes.sql
```
`003_spo_stake_integer.sql` and `005_blocks_height_idx.sql` exist only in the SQLite lineage; both are
repairs for engine-difference bugs (B6, B7).

**Representative per-query divergence** (`indexer-api/src/infra/storage/block.rs:111-172`) — the same
15-column `SELECT` written twice, because Postgres binds an array and SQLite cannot. The `cloud`
variant ends `WHERE hash = ANY($1)`; the `standalone` variant ends `WHERE hash IN (` and then builds
the placeholder list at runtime with `QueryBuilder::<Sqlite>` and one `push_bind` per hash. This is
the shape UmbraDB's `unnest(...)` batch inserts and its defensive `VALUES` sub-batch fallback will
take. The bound-parameter ceiling is real, and I measured it:
```
$ node /tmp/l7/limits.mjs
max bound params accepted = 32766
at limit+1 -> too many SQL variables
```
(Node 24.18.0 built-in `node:sqlite`, SQLite 3.53.1 — this is `SQLITE_MAX_VARIABLE_NUMBER`.) A
runtime-built `IN (...)` or a multi-row `VALUES` must chunk below 32766 **placeholders**, i.e.
32766/columns rows, not 32766 rows.

**Type-affinity measurement:** script `/tmp/l7/affinity.mjs`; output quoted verbatim in B6.

### 3.2 What could NOT be re-measured

`docs/research/indexer-parallelism-roadmap.md` records **161 GB at half height** and an **88 GB node
store with 23 GB resident page cache**, measured 2026-07-26. **I could not independently reproduce
those numbers today.** The largest `ledger-db.sqlite` now on disk is 52 MB
(`/root/midnight-testnet/indexer-data/`), and `find / -xdev -type f -size +5G` returns only Mithril
archives and ParityDB tables. The large database was evidently removed, or lives on an unmounted
volume. Per trap 4 I am citing the in-repo record, not a measurement of my own. **The scale claim
should be re-verified before it is used to gate a decision.**

### 3.3 Precedent citations (primary sources)

#### Zcash — the canonical shielded-wallet precedent

`zcash/librustzcash`, crate `zcash_client_sqlite`. The `WalletRead` / `WalletWrite` / `InputSource` /
`WalletCommitmentTrees` traits live in `zcash_client_backend::data_api`; `zcash_client_sqlite` is the
complete SQLite implementation. Schema in `zcash_client_sqlite/src/wallet/db.rs`.

- **Note-commitment tree (`shardtree`)** — five tables per pool. For Sapling, identical for Orchard
  and Ironwood:
  ```sql
  CREATE TABLE sapling_tree_shards (
      shard_index INTEGER PRIMARY KEY,
      subtree_end_height INTEGER,
      root_hash BLOB,
      shard_data BLOB,
      contains_marked INTEGER,
      CONSTRAINT root_unique UNIQUE (root_hash)
  )
  CREATE TABLE sapling_tree_checkpoints ( checkpoint_id INTEGER PRIMARY KEY, position INTEGER )
  ```
  plus `sapling_tree_cap`, `sapling_tree_checkpoint_marks_removed`,
  `sapling_tree_retained_checkpoints`. Each 2^16 subtree is one row holding an opaque serialized
  `shard_data` BLOB. **This is CheckpointStore's shape**: a chunked, content-keyed BLOB store with
  checkpoints in a sibling table. Note the shard is keyed by `shard_index`, not by hash — see D5.
- **Wallet birthday** — columns on `accounts`: `birthday_height INTEGER NOT NULL`,
  `birthday_sapling_tree_size INTEGER`, `birthday_orchard_tree_size INTEGER`,
  `recover_until_height INTEGER`.
- **Scan ranges** — `scan_queue (block_range_start, block_range_end, priority)` with
  `range_start_uniq` / `range_end_uniq` UNIQUE constraints and a `range_bounds_order` CHECK. Supports
  non-linear, prioritized scanning with gaps. Paired with `nullifier_map` + `tx_locator_map`, which
  let the wallet detect spends of its notes inside blocks it has not scanned yet.
- **Migrations** — the `schemerz` + `schemerz_rusqlite` crates: a **DAG keyed by UUIDs**, not a linear
  version integer. There are about **70 migration modules** under
  `zcash_client_sqlite/src/wallet/init/migrations/`, and `all_migrations()` carries an ASCII drawing
  of the dependency graph as a comment. The module header states the design intent:
  > *"The constants in this module cover all states of the migration DAG that have been exposed in a
  > public crate release, in the order that crate users would have encountered them."*
  The DAG exists for two real reasons. First, **multiple crates write migrations into one database**:
  downstream wallets register their own via `WalletMigrator::with_external_migrations`, and a global
  integer counter cannot be allocated across independent release trains. Second, a UUID plus a
  dependency set means two concurrent PRs adding migrations never collide on a version number.
  The external-migration API carries a blunt warning: *"DO NOT depend on or modify internal details of
  the `zcash_client_sqlite` schema! ... Use the prefix `ext_` for external schema names."*
  **Named per-release constants** (`V_0_19_0`, etc.) let a consumer pin to *the graph state that
  shipped in release X* rather than to an individual migration ID — that is the API-stability trick
  worth stealing, and it is directly analogous to UmbraDB's SemVer promise.
- **Forward-only in practice.** Each migration implements `down()`, but `init.rs` only ever calls
  `migrator.up()`; no revert path exists in shipped code, and the error enum has `CannotRevert(Uuid)`.
- **What they hit at scale.** One of those migrations is `fix_broken_commitment_trees.rs`, doc comment:
  *"Truncates away bad note commitment tree state for users whose wallets were broken by incorrect
  reorg handling."* It rolls the database back to the last valid checkpoint, deletes blocks,
  transactions and nullifier mappings after that point, un-mines affected transactions, and lets the
  client re-scan. **The recovery strategy for a corrupted commitment tree was to ship a migration that
  truncates and resyncs** — an option that exists only because a wallet is derivable from chain.
- **Stability posture.** Crate docs: *"the database schema is an implementation detail and should not
  be depended upon directly outside the provided APIs"*; callers *"MUST NOT write to the database
  without using these APIs."* Zallet's README: *"Breaking changes may occur at any time, requiring you
  to delete and recreate your Zallet wallet."*
- **Testing.** `zcash_client_sqlite/src/testing/db.rs` uses `Connection::open_in_memory()` **by
  default**, with a file-backed `NamedTempFile` variant behind `TestDbFactory::file_backed()`. No
  container, no fixture server.
- **Reach.** zcashd reached its final end-of-support halt at block 3417100 on **2026-07-18**
  (<https://z.cash/support/zcashd-deprecation/>). Zallet, built on `zcash_client_sqlite`, is its wallet
  successor. **Zcash's entire first-party wallet stack is now SQLite**, and the Berkeley DB engine it
  replaced is gone.

#### Penumbra — named in UmbraDB's own 0.9.5 release

`penumbra-zone/penumbra`, `crates/view/src/storage/schema.sql`, accessed through `r2d2_sqlite`. The
view service is exactly UmbraDB's job description: sync against the chain with a viewing key, decrypt,
and persist. Verbatim DDL:
```sql
CREATE TABLE schema_hash    (schema_hash TEXT NOT NULL);
CREATE TABLE client_version (client_version TEXT NOT NULL);
CREATE TABLE kv             (k TEXT PRIMARY KEY NOT NULL, v BLOB NOT NULL);
CREATE TABLE sync_height    (height BIGINT NOT NULL);
CREATE TABLE sct_position   (position BIGINT);           INSERT INTO sct_position  VALUES (0);
CREATE TABLE sct_forgotten  (forgotten BIGINT NOT NULL); INSERT INTO sct_forgotten VALUES (0);
CREATE TABLE sct_hashes     (position BIGINT NOT NULL, height TINYINT NOT NULL, hash BLOB NOT NULL);
CREATE TABLE sct_commitments(position BIGINT NOT NULL, commitment BLOB NOT NULL);
CREATE TABLE notes          (note_commitment BLOB PRIMARY KEY NOT NULL, address BLOB NOT NULL,
                             amount BLOB NOT NULL, asset_id BLOB NOT NULL, rseed BLOB NOT NULL);
CREATE TABLE spendable_notes(note_commitment BLOB PRIMARY KEY NOT NULL, nullifier BLOB NOT NULL,
                             position BIGINT NOT NULL, height_created BIGINT NOT NULL,
                             address_index BLOB NOT NULL, source BLOB NOT NULL,
                             height_spent BIGINT, tx_hash BLOB);
```
Three things UmbraDB should notice. (a) `sync_height` is a **single-row unversioned cursor table** —
Watermarks, exactly, last-write-wins by construction, no secondary index. (b) A generic
`kv (k TEXT PRIMARY KEY, v BLOB)` table sits alongside the typed ones; they did not feel obliged to
make everything relational. (c) **`schema_hash` instead of a migration lineage** — the client hashes
its expected schema and compares, and a mismatch is resolved by rebuilding rather than by migrating.
That is legitimate *only* because view state is fully derivable from chain. UmbraDB's checkpoints are
too; its `TemporalKV` history is not.

#### Bitcoin Core — the best-documented rationale, and the design NOT to copy

The rationale lives in issue <https://github.com/bitcoin/bitcoin/issues/18916> (“Sqlite wallet
storage”, Sjors, 2020-05-08), not in the PR. The implementation is
<https://github.com/bitcoin/bitcoin/pull/19077> (achow101, merged 2020-10-15, commit `8ed37f6`).

The decisive comment on #18916 (achow101, 2020-05-21) gives three reasons to leave Berkeley DB —
*“It does not fit our use case and there are still some issues with potential corruption and data
loss”*; *“we have tons of workarounds and magic that makes the code developer unfriendly and scary to
touch… It is just workarounds on workarounds on workarounds”*; *“It is old, unsupported, and
unmaintained”* — and why SQLite specifically:
> *“it is designed for our use case (application file format is an advertised use case of SQLite)…
> Because SQLite does not require the use of a database environment like BDB does, and it does not use
> a shared cache by default, we do not need the workarounds of separate directories and unique
> fileids… Because SQLite does not use a persistent log file, we do not have the issue of users
> forgetting log files when copying their wallets… There is additionally no need for force flushing or
> periodic flushing.”*

The sipa requirements list (2020-08-07) **explicitly disclaims a performance motive**: *“the entire
wallet is effectively loaded in memory, and writes are rare.”* The stated criteria were backward
compatibility (*“Wallet files often live years”*), forward compatibility, portability across
architectures, and room for *“more advanced queries at some point”*.

**Rejected alternatives**, all in that thread:
- Keeping BDB (TheBlueMatt: *“There does not appear to be a feature that we want from a non-BDB
  database, nor any issues we are having with BDB”*). Overruled.
- **PostgreSQL** — rejected on IRC, quoted verbatim in the opening post:
  *“promag: any reason to not consider postgres for instance? / wumpus: AHHHH / sipa: promag: god why”*.
- A custom append-only journal file (prior art PR #5686). Rejected: *“we do not use the database
  strictly append only.”*
- **LMDB** — pushed by its author Howard Chu and by a former Sleepycat/Oracle BDB engineer, rejected on
  **file-format portability**: *“I had considered LMDB but it seems like the database format is not
  portable… for the wallet we need this to be architecture independent.”*
- WiredTiger, on licensing (AGPLv3). RocksDB/LevelDB: *“unworkable. Its memory/cache/tuning
  requirements are ridiculous.”*

**Schema — a deliberate anti-pattern.** `src/wallet/sqlite.cpp:333` creates exactly one table:
`CREATE TABLE main(key BLOB PRIMARY KEY NOT NULL, value BLOB NOT NULL)`. That is the entire schema.
PR #19077: *“To keep compatibility with BDB and to [keep] complexity of the change down, we do not
make use of many SQLite features. We use it strictly as a key-value store.”*
**They are now paying to undo it** — <https://github.com/bitcoin/bitcoin/pull/33034>, open since
2025-07-21:
> *“The wallet uses SQLite as a key-value store even though SQLite is a powerful relational database
> engine. This causes us numerous headaches due to the need to serialize multiple fields together, and
> since record read from the database during loading can come in any order… The eventual goal is to
> use SQLite as a relational database.”*

**PRAGMAs**, in `SQLiteDatabase::Open` (`src/wallet/sqlite.cpp`): `locking_mode = exclusive` plus a
`BEGIN EXCLUSIVE TRANSACTION` held for the life of the process; `fullfsync = true`; `application_id`
set to the network magic bytes; `user_version` set to `WALLET_SCHEMA_VERSION`, declared
`static constexpr int32_t WALLET_SCHEMA_VERSION = 0` and never changed since; `PRAGMA integrity_check`
on open; and `sqlite3_config(SQLITE_CONFIG_SERIALIZED)`. On open it reads `application_id` back and
rejects a mismatch, and rejects any `user_version` other than 0 with *“SQLiteDatabase: Unknown sqlite
wallet schema version %d. Only version %d is supported”*.
**There is no `journal_mode` pragma — Core deliberately does NOT use WAL**, to keep the wallet a
single portable file; a `-wal` sidecar would reintroduce the “users forget the log file when copying
their wallet” bug they left BDB over. `synchronous=OFF` exists only behind the test-only
`-unsafesqlitesync` flag, whose help text reads *“This is unsafe and can cause data loss and
corruption.”*

**Post-adoption problems.** <https://github.com/bitcoin/bitcoin/issues/21628>: the `CreateWallet` unit
test went from 3.4 s under BDB to 1124 s under SQLite on a spinning disk — roughly 330x — diagnosed as
*“Presumably we are using sqlite sub-optimally and it is doing a lot more writes than BDB.”* That
issue is the origin of `-unsafesqlitesync`.
<https://github.com/bitcoin/bitcoin/issues/33618> and
<https://github.com/bitcoin/bitcoin/pull/35237>: v30 `generatetoaddress` ran 2-3x slower than v29
because *“each individual write currently runs in its own implicit SQLite autocommit transaction. That
forces an fsync per WriteKey”* — fixed by wrapping per-block writes in one explicit transaction, and
notable because the offending change could not simply be reverted: it had fixed a real correctness bug
(#31824, a best-block locator lagging across unclean shutdown during a reorg).
Also #20216 (a buffer over-read in the magic-byte dispatch introduced by #19077) and #20204 (SQLite
wallets lost the unique database id BDB had given them for free; still unmerged).

**Timeline.** 0.21.0 introduced SQLite for descriptor wallets; 23.0 made descriptor wallets the
default; #19602 (2022-09-01) added the `migratewallet` RPC; #26596 (2024-07-11) made migration
possible without linking BDB, via a read-only Berkeley DB parser; #31961 (2025-03-14) made SQLite a
hard build requirement; #28710 (2025-05-07) removed BDB entirely, landing in **v30.0**.
**Five years from “add SQLite” to “delete the old engine.”**

Backup is the one place Bitcoin Core got it right: the `backupwallet` RPC calls
`sqlite3_backup_init(db_copy, "main", m_db, "main")` then `sqlite3_backup_step(backup, -1)` — the
online backup API, single-shot, all pages. `doc/managing-wallets.md`: *“To backup the wallet, the
backupwallet RPC or the Backup Wallet GUI menu item must be used to ensure the file is in a safe state
when the copy is made.”*

Testing note: wallet unit tests run against an `InMemoryWalletDatabase`, documented in
`src/wallet/sqlite.h` as *“An in-memory SQLiteDatabase. Used as a temporary build artifact where no
on-disk persistence is needed.”* No container, no fixture server.

#### LND — the richest dual-backend source, and it recommends SQLite

`docs/db_migration_guide.md` states the rationale as escaping bbolt: the SQL migration *“moves LND
further away from the kvdb data stores that have historically held back LND performance at scale.”*
Two stages: (1) offline bbolt to SQL-kvdb via `lndinit`; (2) incremental per-subsystem migration to
**native relational tables** — invoices v0.19+, graph v0.20+, payments v0.21+, channel state targeted
v0.22. Reported numbers: bbolt ~35 tps vs Postgres-kvdb ~15 tps; pathfinding 25 ms (bbolt) vs 800 ms
(Postgres-kvdb); **over 97% wall-time reduction on `ListPayments` for large databases** after moving to
native SQL. Their comparison table is explicit:

| Backend | Performance (in kvdb mode) | Default in LND? | Long-term viability |
|---|---|---|---|
| Postgres | Mediocre | No | yes |
| SQLite | Good | **Yes (future)** | yes |

> *“Unless you require Postgres for infrastructure reasons, migrate to SQLite kvdb as your backend.”*
> *“No migration path between SQL backends: Once migrated to either Postgres or SQLite, it is not
> possible to switch to the other, so choose your target backend carefully.”*

The originating request is issue <https://github.com/lightningnetwork/lnd/issues/6176>, and its stated
motive is **migration ergonomics, not speed**: *“maintaining custom serialization code is
time-consuming and error-prone. This becomes apparent in an extreme way for database migrations. One
way to address this problem is to replace bbolt by SQLite.”*

Pragmas: the mandatory kvdb set (`kvdb/sqlite/db.go`) is `busy_timeout`, `foreign_keys`,
`journal_mode=WAL`, `auto_vacuum=incremental`. `synchronous=full` and `fullfsync=true` are enforced
only on the **native-SQL** path, with the comment *“With the WAL mode, this ensures that we also do an
extra WAL sync after each transaction. The normal sync mode skips this and gives better performance,
but risks durability.”* Migrations use `golang-migrate` with **two version counters** — a
tool-tracked `SchemaVersion` and a `Version` spanning schema plus in-code data migrations — so a data
migration can be ordered *at* a schema version. `.down.sql` files exist and are never executed.

**Important reconciliation.** LND says SQLite beats Postgres; CLN says *“PostgreSQL is generally
faster than SQLITE3.”* Both are true, and the difference is the schema. LND is comparing a
**key-value store emulated in SQL**, which is pathological on Postgres; CLN is comparing a real
relational schema on both engines. **UmbraDB is the CLN case, not the LND case — do not quote LND
numbers as evidence that SQLite will be faster.**

#### Core Lightning — SQLite as default since inception; Postgres added for backup, not scale

Default wallet is `sqlite3://$HOME/.lightning/bitcoin/lightningd.sqlite3`. Postgres arrived in 0.7.3
via an *“SQL re-writing engine and a Postgres driver”* (Christian Decker), marketed as bring-your-own
database; the stated motivation was *“improving c-lightning persistence and backup toolset”* —
replication and failover, not throughput. Their stated Postgres advantage: *“PostgreSQL is generally
faster than SQLITE3, and also supports running a PostgreSQL cluster… with automatic replication and
failover.”*

Migrations, `wallet/migrations.c`, are a numbered append-only C array with the header comment
*“Do not reorder or remove elements from this array, it is used to migrate existing databases from a
previous state, based on the string indices.”* The engine in `wallet/db.c::db_migrate()` is 40 lines
and contains four things worth stealing outright:
- **Downgrade is fatal**, never silent: *“Refusing to migrate down from version %u to %u.”*
- **Upgrades are treated as irreversible and are refused by default on non-release builds** unless the
  operator passes `--database-upgrade=true`: *“Refusing to irreversibly upgrade db from version %u to
  %u in non-final version %s.”*
- A **`db_upgrades` audit table** records `(from_version, binary_version_string)` for every upgrade
  ever applied.
- `STRICT` typing is **disabled during migration**, because legacy rows have wrong affinity.

`db/db_sqlite3.c` sets only `busy_timeout=60000` and `foreign_keys=ON` — notably it does **not** set
`journal_mode=WAL` (that is operator opt-in) and does **not** use `BEGIN IMMEDIATE`. The 60 s busy
timeout was added under duress and deliberately not exposed as a knob (rustyrussell: *“the user surely
prefers a delay to a crash! Providing knobs like this is a last resort.”*).

The multi-process answer is the most elegant in the survey: rather than expose the wallet file
read-only, CLN’s `sql` RPC **materializes a separate throwaway sqlite3 database from RPC output** —
*“The sql RPC command runs the given query across a sqlite3 database created from various list
commands… Writing to the database is not permitted.”* Plugins that need to observe writes use the
in-process `db_write` hook, whose contract is the single best idea in this survey:
> *“`data_version` is an unsigned 32-bit number that will always increment by 1 each time `db_write`
> is called… Your plugin MUST validate the `data_version`… If the new `data_version` is less than the
> previous, your plugin MUST halt and catch fire. Any response other than `{"result": "continue"}`
> will cause lightningd to error without committing to the database!”*
A monotonic per-write counter that a backup consumer validates, with a gap or a regression halting the
daemon rather than silently diverging, is exactly the primitive UmbraDB would need to build a
trustworthy live-backup story on SQLite.

Third-party `fiatjaf/mcldsp` exists to move a CLN database from SQLite to Postgres precisely because
the project itself will not.

#### Cardano — the wallet/index/node split, and the one live SQLite-at-chain-scale experiment

The Cardano ecosystem sorts cleanly into three regimes, without exception:

1. **Node-shaped** — owns ledger state, must roll back: **never SQL.** cardano-sl used RocksDB plus
   flat files (`db/src/Pos/DB/Rocks/Types.hs`). cardano-node uses custom immutable chunk files, a
   volatile DB, and an in-memory LedgerDB with an LSM backing store (the LMDB backend was retired).
   The ImmutableDB design note is the clearest rationale on record: *“Traditional database systems
   provide guarantees that are not needed and, conversely, do not take advantage of the
   requirements.”* txpipe’s `dolos` independently reaches the same place with redb v3 plus a Fjall
   LSM tree.
2. **Index-shaped** — whole chain, unbounded third-party clients writing ad-hoc SQL: **PostgreSQL.**
   cardano-db-sync (mainnet database on the order of 438 GB), carp, cardano-rosetta,
   cardano-graphql via Hasura over db-sync, cardano-js-sdk’s server-side projector via TypeORM.
3. **Wallet/agent-shaped** — single process, single writer, one file, on the user’s machine:
   **SQLite.** cardano-wallet, cardano-deposit-wallet, Mithril, hydra-node — or whatever the sandbox
   allows (Daedalus keeps only UI preferences in an `electron-store` JSON file and delegates all
   wallet state to cardano-wallet’s SQLite; Lace uses WebExtension `storage.local` plus PouchDB).

**The decision rule that predicts every case is not how much data you have, but how many independent
readers will write queries you did not anticipate.** Zero means files or an embedded KV store. One
process means SQLite. Unbounded third parties means PostgreSQL. **UmbraDB is unambiguously the
one-process case** — `README.md` says so explicitly: not multi-tenant, not distributed, not a service.

**Two Cardano precedents matter directly.**

**(a) The legacy wallet split its state along exactly the line this report recommends in D1.** In
`input-output-hk/cardano-wallet-legacy`, `Cardano/Wallet/Kernel/DB/AcidState.hs` is *“Acid-state
database for the wallet kernel”* and holds the HD tree, accounts, addresses, UTxO, pending
transactions and restoration state — everything mutated by `ApplyBlock`, **`SwitchToFork`**,
`NewPending`, `CancelPending`. Meanwhile `Cardano/Wallet/Kernel/DB/Sqlite.hs` is *“Sqlite database for
the TxMeta portion of the wallet kernel”* and its entire API is `putTxMeta` / `getTxMeta` /
`getTxMetas`. **The rollback-bearing, structurally-shared state lived in an in-memory value with a
write-ahead log; only the append-mostly, paged, range-queried transaction history went into SQL.**
The modern cardano-wallet gave that split up, put rollback checkpoints into SQLite rows, and had to
invent sparse checkpointing to survive it. If UmbraDB keeps rollback checkpoints, **this split, not
the engine choice, is the decision to copy.**

**(b) Hydra migrated file-based persistence TO SQLite in v2.1.0** (2026-05-13,
cardano-scaling/hydra#2578). CHANGELOG verbatim: *“Replace file-based persistence with a SQLite-backed
event store. Events are now persisted in a database file (`hydra.db`) instead of a plain append-only
JSON file (`state`). On first startup after upgrading, existing `state` files are automatically
migrated into `hydra.db` and renamed to `state.migrated`.”* One `events` table, integer PK,
`event_data` BLOB holding JSON; rotation via `VACUUM INTO`. Their durability stance is worth quoting
to whoever owns UmbraDB’s archive tier: *“Events in the queue that have not yet been flushed to SQLite
are lost on SIGKILL, OOM, or power loss. **This is acceptable because the L1 chain is the source of
truth.**”*

#### Kupo — the closest existing experiment to "chain index on SQLite", and it is straining

`CardanoSolutions/kupo` is a Cardano chain indexer whose **only shipping backend is SQLite**. Its
PostgreSQL module carries this header, verbatim:
> *“Beside the module name, this file is a copy of `Kupo.App.Database.SQLite`. It only exists as a
> preliminary step of an effort to get Kupo multi-backend, **which was put on hold**.”*

That alone is a data point for B7: a third project started a dual-backend seam and stalled.

What is happening to it at scale, from its own issue tracker:
- **Open bug #209 (2026-07-26), on a 365 GB database.** Unbounded `PRAGMA optimize` reads at
  *“~19 MB/s (single-threaded small reads)”*, taking **over 5 hours per pass**; with the default
  3600 s GC interval, consecutive passes overlap, so the scan is *“effectively permanent”*. About 70%
  `/proc/pressure/io` around the clock. *“Chain-sync visibly stalls during the startup pass.”*
  Proposed mitigation is `PRAGMA analysis_limit = 1000`.
- **#146 (Nov 2023)** is titled *“Question: moving away from sqlite to a more performant DB?”*; the
  reporter was considering forking kupo to replace SQLite with Postgres. (Maintainer reply
  UNVERIFIED — the thread would not render.)
- **#131**: *“Synchronization sometimes pauses during rollback for 10-15min.”* Rollback again.
- Journal-mode thrash: 2.7.2 switched the writer to `journal_mode=TRUNCATE` to dodge *“cannot rollback
  - no transaction is active”*, *“linked to the write-ahead logging journal mode”*; WAL was reinstated
  the next release *“to allow setting up more concurrent readers.”* (Note this is the same
  rollback-masking failure mode as lnd #10558 in B8.)
- GC had to be made incremental because a single large delete transaction caused garbage-collection
  delays of several minutes; `--defer-db-indexes` exists because index maintenance during sync *“adds
  a lot of unnecessary overhead.”*
- Their tuning is the shape of a project fighting a ceiling: `page_size = 32768`,
  `synchronous = NORMAL`, `journal_mode = WAL`, `foreign_keys = ON`, one long-lived **exclusive**
  writer plus a bounded pool of short-lived readers, and a `retryWhenBusy` loop on `ErrorLocked` with
  0.1 s backoff.

**The lesson for UmbraDB is precise, and it is not a byte count.** Kupo scaled to roughly 220 GB
comfortably *for its design centre* — a handful of address patterns. It is at 365 GB and in trouble
for the wildcard pattern. **The cliff is the moment a second consumer needs concurrent analytical
reads while the single writer is still writing.** UmbraDB is explicitly single-writer and is not an
analytics surface, so it sits on the safe side of that line — but `chain-archive-sync` ingesting at
~1 GB/hour while anything else reads the archive is precisely the shape that broke kupo. **Flag for
L5: is there any concurrent-reader-during-ingest workload in the chain archive? If yes, kupo #209 is
your risk, not a hypothetical.**

#### The counterexamples — why nobody runs an archive node on SQLite

The brief asked whether this is a hard technical ceiling or convention. **The answer is neither
exactly: it is that no general-purpose storage engine, B-tree or LSM, survives chain-scale
random-key ingest without either (a) a data-structure redesign that removes the randomness from the
key, or (b) tiering the cold majority into append-only flat files.** SQLite is excluded from the hot
tier by three properties its own documentation states — a single writer, a single file with no
partitioning, and terabyte-scale guidance — not by a unique defect. The evidence:

- **Solana.** <https://github.com/solana-labs/solana/issues/16234>, *“Storing data/coding shred data
  in rocksdb causes problems”*, **open since March 2021**: *“The main issue is these long (~40 min)
  stalls; however, there are other more subtle problems that make RocksDB unattractive: High write IO
  from write amplification / Sometimes high insert latency / Inability to delete individual dead slots
  without poor performance / **Corruption on restart** / Deletions (and corresponding tombstones) slow
  down scans until next compaction.”* And: *“none of these knobs seemed to have much effect in solving
  the core issue.”* Their own design doc quantifies level compaction at **~30x write amplification**.
  The FIFO-compaction fix was tried and then abandoned (agave deprecated
  `--rocksdb-shred-compaction=fifo` in v2.0, removed it in v2.1). And they concede the ledger cannot
  hold history at all: *“6 months of transaction data cannot be stored practically in a validator
  rocksdb ledger so an external data store is necessary”* — hence BigTable. The blockstore targets
  *“a default 500 GB footprint.”*
- **Sui.** Built **Tidehunter** (Apache-2.0), wired into sui behind a `USE_TIDEHUNTER` build flag —
  **opt-in, not default**, so “Sui replaced RocksDB” is false. Their blog post gives the measurement:
  *“In Sui production-like workloads, we measured write amplification on the order of 10-12x”* —
  roughly 40 MB/s of application writes becoming 400-500 MB/s of disk writes — with *“noticeable
  performance degradation at moderate throughput levels, around 6,000 transactions per second.”*
  Architecture is WAL plus a sharded index, with no general compaction.
- **Aptos.** Did not leave RocksDB; **sharded it**. AIP-97 “Storage Format Change”, verbatim:
  *“RocksDB has some limitation on the write throughput due to some of operations have to be
  single-threaded, which becomes the performance bottleneck at high load.”* Fix: LedgerDb split into
  6 RocksDB instances, StateKvDb and StateMerkleDb into **16 shards each**, every shard its own
  RocksDB. Peer-to-peer TPS went from about 14K to about 25K.
- **The Jellyfish Merkle Tree paper is a direct confirmation of D5 below.** Gao, Hu and Wu (2021)
  describe *“a space-and-computation-efficient sparse Merkle tree optimized for Log-Structured
  Merge-tree based key-value storage”*, using **version-based keys specifically to avoid the “heavy
  I/O brought about by the randomness of a pervading hash-based key.”** That is a serious project
  stating in a paper that hash-random keys are the problem, and redesigning the *data structure*
  rather than swapping the engine.
- **Ethereum.** go-ethereum moved its default from LevelDB to Pebble; Erigon uses MDBX (after LMDB and
  BoltDB) and states the B-tree random-insert rationale quoted in B3; Reth uses MDBX and pushes
  changesets to static files. geth’s path-based state scheme is case (a) again: path keys instead of
  hash keys.
- **Bitcoin Core is the cleanest statement of the two-tier answer**, in its own `doc/files.md`:
  `blocks/index/` is LevelDB, `chainstate/` is LevelDB, `blkNNNNN.dat` are flat files, every
  `indexes/*` is LevelDB — **and “Wallets are SQLite databases.”** One codebase, both scales,
  explicitly separated in the documentation. That is D1.
- **Indexers, all confirmed non-SQLite:** electrs uses RocksDB (its own docs report a 56 GB index; its
  optional `rusqlite` feature is a cache only); Fulcrum vendors static librocksdb; ElectrumX offers
  LevelDB and RocksDB, with docs noting *“On an SSD, RocksDB performs better than LevelDB”* and an
  index around 46.9 GB; Blockstream esplora is RocksDB; ord uses redb; Trezor Blockbook uses RocksDB
  and documents a *“database is in inconsistent state and cannot be used”* failure after a kill
  mid-import.
- **Two documented SQL-at-chain-scale failures — the best counter-evidence in the survey.**
  **bitcoin-abe** supports SQLite, and its own README documents the outcome under “Slow startup”:
  *“Reading the block files takes much too long, **several days or more for the main BTC block chain as
  of 2013**.”* Unmaintained. **Bitcoin Verde**, a BCH full node, stored the chain in MariaDB and
  retreated: README patch notes for **v3.0.0**, *“Replaced MariaDB with LevelDB.”* That is a
  documented, in-production SQL-to-KV reversal at chain scale.

**What this does and does not say about UmbraDB.** It says the *hot mutable state tier* of a
consensus node is off-limits — but UmbraDB is not that; it is not a chain indexer, by its own
`README.md`. It says the archive tier is survivable on SQLite when the workload is
append-mostly-and-read-rarely (Hydra, and the Midnight indexer’s own ledger DB), and that the failure
mode when it is not survivable is kupo #209: multi-hour maintenance passes and sync stalls, not
corruption. **The honest framing is that UmbraDB’s chain archive sits between the Hydra case and the
kupo case, and which one it resembles depends on whether anything reads it concurrently with ingest.**

---

## 4. Design sketch

Not a full schema — that is L1-L6 work. This is the shape the precedent converges on, and the five
decisions I would take from it.

### D1 — Two databases, not one. The single most important structural decision.

**Every precedent that stores both scanned-chain data and wallet state separates them into different
files, and one of them says so in its own documentation.** Bitcoin Core’s `doc/files.md` lists LevelDB
for `blocks/index/`, `chainstate/` and every `indexes/*`, flat files for `blkNNNNN.dat`, and then
*“Wallets are SQLite databases”* — one codebase, two tiers, two engines, stated explicitly. Zcash
splits `WalletDb` from `BlockDb`/`FsBlockDb`, the latter *“read-only within all light client APIs.”*
The Midnight indexer splits `indexer.sqlite` from `ledger-db.sqlite`, with separate pools and separate
migration lineages. Cardano’s legacy wallet split rollback-bearing state from transaction history at
the same seam.

For UmbraDB:

| File | Contents | Tier | Backup | Durability |
|---|---|---|---|---|
| `umbra.sqlite` | TemporalKV, CheckpointStore, Watermarks, TransactionHistory | wallet | online backup API, or a CLN-style dual-write replica | `synchronous=FULL` |
| `umbra-archive.sqlite` | `chain_blobs`, `blocks`, `transactions`, `bridge_observations` | archive | filesystem or ZFS snapshot; re-ingestible from chain | `synchronous=NORMAL` defensible |

This is the only way B3 and B4 both get answered, because it lets the two tiers take different
durability, backup and pragma settings. It preserves the *substance* of `docs/CONTRACT.md` §6 for the
tier that needs it — the archive is derivable, the wallet envelope is what a crash must not lose. It
is also the Hydra argument (*“acceptable because the L1 chain is the source of truth”*) applied
selectively rather than globally.

It costs the ability to run one transaction across both tiers. **Flag for L5: confirm that no
chain-archive write shares a transaction with a wallet-tier write.** If one does, this decision is
blocked and B3/B4 both get harder. Note SQLite’s `ATTACH DATABASE` permits cross-file transactions
but not with independent pragmas, so attaching is not a free escape.

`DEFAULT_SCHEMA` and schema-configurability — part of the frozen **G1** surface — become file paths
rather than `CREATE SCHEMA` plus `search_path`. `ATTACH DATABASE ... AS umbra` gives a near-drop-in
namespace (`main.kv_current` becomes `umbra.kv_current`) if the exported name must keep working.
**Confirm that mapping with L-API before assuming G1 survives.**

### D2 — Pragmas and the contention stack, from the union of LND, Bitcoin Core and kupo

```sql
PRAGMA journal_mode   = WAL;              -- LND, BDK, kupo. NOT Bitcoin Core; NOT CLN by default
PRAGMA synchronous    = FULL;             -- LND native-SQL default; wallet tier
PRAGMA foreign_keys   = ON;               -- universal
PRAGMA busy_timeout   = 60000;            -- CLN hardcodes 60s. NOT LND's 5s. See B8.
PRAGMA auto_vacuum    = INCREMENTAL;      -- LND; avoids full-VACUUM downtime
PRAGMA application_id = <umbra magic>;    -- Bitcoin Core: refuse to open a foreign file
PRAGMA user_version   = <schema version>; -- Bitcoin Core; plus integrity_check on open
PRAGMA page_size      = 32768;            -- kupo, for large-BLOB workloads; measure before adopting
```
plus, and this is not optional per B8:
- **`_txlock=immediate`** (or an explicit `BEGIN IMMEDIATE`) on every write transaction, so the write
  lock is taken at `BEGIN` rather than upgraded mid-transaction. LND does this; CLN does not, and CLN
  is the one that treats DB errors as fatal.
- **A bounded, jittered retry classifier** around every write, on the *masked* primary result code
  (`code & 0xFF`), treating `SQLITE_BUSY`, `SQLITE_LOCKED`, `SQLITE_IOERR` and `SQLITE_FULL` as
  retryable. LND ships 20 attempts, 50 ms base, 1 s cap.
- **A connection pool capped at 2.** LND: *“SQLite only supports a single writer, so a low default
  reduces contention on the busy_timeout.”* More connections cannot buy write throughput.
- **Never issue a rollback SQLite has already performed** — lnd #10558 masked the original error and
  defeated the whole retry layer that way.

Two judgement calls, both with precedent on each side:
- **WAL vs no-WAL.** Bitcoin Core deliberately avoids WAL so the wallet stays one portable file. LND,
  BDK and kupo use WAL; CLN leaves it opt-in. UmbraDB is a daemon-side library, not a user-copied
  file, and it has concurrent readers (`load` and `history` run REPEATABLE READ today) — **take WAL**,
  and treat the `-wal` and `-shm` sidecars as part of the backup unit.
- **`locking_mode = EXCLUSIVE` interacts badly with WAL** (WAL needs shared-memory coordination;
  exclusive locking changes its behaviour and locks other connections out entirely). Since UmbraDB is
  *explicitly* single-writer-single-process, exclusive locking is arguably the correct lease and would
  let the advisory-lock machinery be deleted outright. **This is a genuine either/or I could not
  settle — see §5.2.** Note kupo runs one long-lived exclusive writer alongside a bounded pool of
  short-lived readers, which may be the reconciliation.

### D3 — Migrations: forward-only, per-component versions, `STRICT` everywhere

Follow **BDK**, not Bitcoin Core. UmbraDB already has a forward-only `000`-to-`006` lineage with a
`_migrations` bookkeeping table (`docs/CONTRACT.md` §2), which maps onto BDK’s `bdk_schemas` shape
almost exactly. Forward-only matches **every** precedent surveyed: Zcash implements `down()` but never
calls it; LND writes `.down.sql` files and never executes them; CLN makes downgrade `db_fatal`;
Bitcoin Core has no migrations at all. **Nobody ships a user-facing down migration.**

Six specific steals:
- **`STRICT` on every table** — the countermeasure to B6. BDK does it universally. Plan to disable it
  during migrations, as CLN does, because legacy rows carry wrong affinity.
- **Per-component version rows** rather than one global integer, so the chain-archive lineage (already
  separate at `src/postgres/migrations/chain_archive/`) can advance independently.
- **Two version counters** if in-code data migrations are ever needed — LND’s `SchemaVersion` (tool
  tracked) versus `Version` (schema plus data migrations), so a data migration can be ordered *at* a
  schema version.
- **`application_id` and `user_version` checked on open with a hard refusal** (Bitcoin Core). This
  gives `docs/CONTRACT.md` §2’s no-downgrade rule an enforcement mechanism it does not have today —
  currently an older app silently runs against a newer schema. **That is a strengthening; claim it.**
- **Refuse an irreversible upgrade on a non-release build unless explicitly opted in** — CLN’s
  `--database-upgrade=true`. Cheap, and it prevents a whole class of user-data disaster.
- **A `db_upgrades` audit table** recording `(from_version, binary_version)` per upgrade — CLN.

Explicitly **reject** Penumbra’s `schema_hash`-and-rebuild strategy for the wallet tier: it is sound
only because view state is fully derivable from chain, and UmbraDB’s `TemporalKV` history is not. It
*is* the right strategy for `umbra-archive.sqlite`.

### D4 — TransactionHistory: take the upstream junction table verbatim

```sql
CREATE TABLE transaction_history_identifiers (
  history_id INTEGER NOT NULL REFERENCES transaction_history (id) ON DELETE CASCADE,
  identifier TEXT NOT NULL,
  PRIMARY KEY (history_id, identifier)
) STRICT;
CREATE INDEX th_identifiers_identifier_idx ON transaction_history_identifiers (identifier);
```
The subset-containment predicate becomes an anti-join: select history rows for which no attached
identifier falls outside the candidate set. Chunk the candidate list below the measured 32766
placeholder ceiling. This mirrors `indexer-common/migrations/sqlite/001_initial.sql`’s
`transaction_identifiers` table exactly — same chain, same problem, already solved upstream.

### D5 — CheckpointStore chunks: keep content-addressing, move it off the primary key

**This is the highest-leverage schema change in the whole migration, and it has two independent
precedents.**

Zcash keys its shardtree rows by **monotonic index**, not by content hash, and puts the hash in a
secondary `UNIQUE` constraint: `sapling_tree_shards (shard_index INTEGER PRIMARY KEY, ..., shard_data
BLOB, CONSTRAINT root_unique UNIQUE (root_hash))`. And the Jellyfish Merkle Tree paper does the same
thing deliberately and says why — **version-based keys chosen specifically to avoid the “heavy I/O
brought about by the randomness of a pervading hash-based key.”** Erigon’s ETL staging and geth’s
path-based state scheme are the same idea in two more codebases.

The UmbraDB equivalent:
```sql
CREATE TABLE ckpt_chunks (
  id         INTEGER PRIMARY KEY,            -- rowid alias: sequential appends to the table B-tree
  hash       BLOB NOT NULL UNIQUE,           -- content address becomes a narrow secondary index
  data       BLOB NOT NULL,
  size_bytes INTEGER GENERATED ALWAYS AS (length(data)) STORED,
  created_at INTEGER NOT NULL,
  CHECK (length(hash) = 32)
) STRICT;
```
`INTEGER PRIMARY KEY` aliases the rowid, so the clustered B-tree holding the 4 MiB payloads is
appended to in order. Only the `hash` index takes random inserts, and it is 32 bytes plus a rowid per
entry rather than a 4 MiB row — orders of magnitude less page churn. The same change applies to
`chain_blobs`. SQLite supports `GENERATED ALWAYS AS (...) STORED` and `CHECK`, so
`src/postgres/migrations/006_ckpt_chunks_size_bytes.ts`’s generated column survives with
`octet_length` becoming `length`.

Pair it with **ETL-style sorted write staging** for the archive tier: buffer dirty rows across a batch,
sort by key, insert ascending. Erigon reports *“dramatic (orders of magnitude) write speed
improvements”*; the repo’s own note measures ~19x for random versus sequential keys, with two ascending
passes recovering ~94% of sequential speed. Content addressing makes the reordering provably
output-preserving.

**Flags for L-Checkpoint:** verify the 4 MiB chunk size against `SQLITE_MAX_LENGTH` (default 1e9) and
against overflow-page behaviour in the page cache; and consider kupo’s `page_size = 32768` for the
archive file, since a 4 KiB page size means roughly a thousand overflow pages per chunk.

---

## 5. Open questions / what I could not settle

1. **The 161 GB / 88 GB scale claim could not be re-measured** (§3.2). The largest ledger DB on disk
   today is 52 MB. Everything I say about archive-tier SQLite at hundreds of GB rests on the in-repo
   record of a measurement taken 2026-07-26, not on an observation of my own. Re-verify before using
   it to gate a decision.
2. **`locking_mode = EXCLUSIVE` versus `journal_mode = WAL`.** Bitcoin Core uses the former with the
   default rollback journal; LND, BDK and kupo use WAL. Kupo runs an exclusive long-lived writer
   *alongside* a reader pool, which suggests a reconciliation exists, but I did not confirm the exact
   pragma combination and did not run the experiment. Whether UmbraDB can have Bitcoin Core’s
   kernel-enforced writer lease *and* WAL’s concurrent readers is unresolved, and it is a genuine fork
   in the design. **Worth one afternoon of `node:sqlite` measurement by whichever lane owns
   Transaction/Lease.**
3. **Whether `synchronous=NORMAL` in WAL mode is acceptable for the archive tier** under UmbraDB’s
   durability contract. I have the mechanism — a committed transaction may roll back on power loss,
   the database is never corrupted — but did not reconcile it against `docs/CONTRACT.md` §1’s ordering
   guarantee. L-Durability’s call. Note the repo’s own indexer roadmap already accepted `NORMAL` on
   exactly this reasoning, and kupo ships it.
4. **Does anything read the chain archive concurrently with `chain-archive-sync` ingest?** This is the
   single question that decides whether the archive tier resembles Hydra (fine) or kupo #209 (multi-
   hour maintenance stalls). **I could not answer it from outside L5’s lane, and it matters more than
   any pragma.**
5. **No project in this survey runs SQLite at UmbraDB’s stated ~1 GB/hour sustained ingest.** Kupo is
   the closest and is in trouble at 365 GB; the Midnight indexer is closer still but was never
   measured on the write path, having been diagnosed CPU-bound on reads. Absence of precedent is not
   evidence of a ceiling, but it is not evidence of headroom either.
6. **Encryption at rest.** `SECURITY.md` makes “no at-rest encryption” a binding deployer precondition
   and defers `EnvelopeCipher` to 1.1. The options have real costs: **SQLCipher** community edition is
   BSD-style but breaks tooling compatibility (the stock `sqlite3` CLI reports *“file is not a
   database”*), defaults to 256,000 PBKDF2-HMAC-SHA512 iterations paid on every open, and its version-4
   format change required a documented three-open `cipher_migrate` dance in Signal Desktop. **SQLite
   SEE** is US$2,000 one-time for the source licence. **Zallet chose neither** and encrypts key
   material per-field with `age` while leaving `wallet.db` itself plaintext — which matches UmbraDB’s
   current stance better than whole-file encryption does. Signal’s six-year lesson is the one to
   record: SQLCipher moves the problem to key custody, and their key sat in plaintext `config.json`
   until 2024. Flagged as a 1.1 interaction, not a blocker.
7. **Two claims I could not source and am marking UNVERIFIED**, so they are not repeated downstream:
   whether SQLite on WSL2 / 9p / virtiofs is specifically known-problematic (relevant because this
   project runs in WSL, and `howtocorrupt.html` warns about network filesystems generally); and the
   maintainer reply on kupo #146, whose thread would not render.

---

## 6. Cost estimate

This lane produces no code. What the *precedent* implies for the sprint:

| Item | Size | What it breaks |
|---|---|---|
| Split into two SQLite files (D1) | S — plumbing, but decide it first | Nothing frozen, *if* no cross-tier transaction exists |
| Pragma set + open-time validation (D2, D3) | S — about a day | Nothing; strengthens `docs/CONTRACT.md` §2 |
| Contention stack: IMMEDIATE, retry classifier, pool cap 2 (B8, D2) | M — and it is not optional | See below — touches **G3** |
| `STRICT` tables plus typeof/length CHECKs (B6) | S, but only if done at DDL-writing time; retrofitting means table rebuilds | Nothing |
| TransactionHistory junction table (D4) | M — schema, containment query rewrite, P-test updates | `docs/SCHEMA.md`; **not** G1 |
| Chunk table rowid re-key + sorted write staging (D5) | M-L — plus a data migration for existing deployments | `docs/SCHEMA.md`; `Performance/CEILINGS.md` re-derivation |
| T5 enforcement via trigger (B1) | L — and it lengthens the trusted refinement bridge | **T5** in the frozen Lean cut-line; `ROADMAP.md` cut-line text |
| Backup/restore contract rewrite (B4) | M for the wallet tier, **L or unresolved for the archive** | **`docs/CONTRACT.md` §6, verbatim** |
| Error-catalog reconciliation (B5, B8) | S in code, but a **policy decision** | **G3** — a new retryable code for BUSY is additive (a minor); removing `TransactionPoolerDetectedError` is breaking under **G2** |
| Delete `src/postgres/` | S once the above land | The `Pg*` class names are on the frozen G1 barrel — renaming them is a **major** |

**The item not on this table that should be: elapsed time.** Every precedent that made this move took
years, not sprints, and did it behind a migration tool. Bitcoin Core: 2020-10 to add SQLite, 2025-05 to
delete BDB — **five years**. LND is still mid-migration, with channel state targeted for v0.22. Zcash
ran zcashd’s Berkeley DB wallet alongside `zcash_client_sqlite` for years before the 2026-07-18 halt.

**UmbraDB has one advantage none of them had: no shipped users to migrate.** It is 0.9.5, not on npm
(`README.md:14`), with no SemVer promise yet binding. Every project in this survey paid most of its
cost in *migrating existing user data*, and UmbraDB has none. **That is the strongest argument for
doing this now, before 1.0.0 freezes the surface, rather than after** — and it is a window that closes
at the tag.

---

## 7. Comparison table

| Project | Engine | What it stores | Scale | Outcome |
|---|---|---|---|---|
| **Zcash** `zcash_client_sqlite` / Zallet | SQLite | shielded notes, shardtree shards + checkpoints, scan queue, nullifier map, birthdays | wallet (MB-GB) | **Success.** Now the only first-party Zcash wallet store; zcashd/BDB halted 2026-07-18. ~70 forward-only UUID-DAG migrations, one of which truncates and resyncs a corrupted commitment tree |
| **Penumbra** `pcli` view service | SQLite (`r2d2_sqlite`) | notes, spendable notes, SCT hashes/commitments, `sync_height`, generic `kv` | wallet | **Success.** No migration lineage at all — a `schema_hash` mismatch means rebuild from chain |
| **Bitcoin Core** descriptor wallets | SQLite | one table `main(key BLOB PK, value BLOB)` | wallet (MB) | **Success, but the schema was a mistake.** BDB fully removed in v30.0 (2025-05). Now unwinding the K/V design (#33034). No WAL; `locking_mode=exclusive`; online backup API for `backupwallet` |
| **Bitcoin Core** chain/index | LevelDB + flat files | blocks, chainstate, txindex | 100s GB | **Deliberately not SQLite**, and `doc/files.md` says so on the same page it says wallets are SQLite |
| **BDK** `bdk_chain` | SQLite (`rusqlite`, bundled) | txs, txouts, anchors, local chain, revealed SPKs, wallet changeset | wallet | **Success.** `STRICT` everywhere, per-component `bdk_schemas` versions, real `ALTER TABLE` migrations. Left its flat-file backend explicitly over the missing migration story |
| **Core Lightning** | SQLite (default) **or** Postgres | channel state, HTLCs, on-chain wallet | wallet (100s MB) | **Success on SQLite.** Postgres added 0.7.3 for replication, not speed. **No supported migration between the two.** Litestream recommendation retracted after it crashed `lightningd` |
| **LND** | bbolt → SQLite **or** Postgres | invoices, graph, payments, channel state | wallet-node (GB) | **In progress, SQLite recommended.** >97% faster `ListPayments` after native SQL. But a **P0 fund-loss bug** (#7869) from mishandled `SQLITE_BUSY`; maintainer called bbolt *“the most stable DB backend”* at the time |
| **Cardano** cardano-wallet, Mithril, Hydra | SQLite | wallet state, checkpoints, certificates, event store | wallet (GB) | **Success.** Hydra *migrated to* SQLite in v2.1.0 (2026-05) from flat files |
| **Cardano** db-sync | PostgreSQL | full chain index for unbounded third-party SQL | ~438 GB | **Postgres is correct here** — many unknown readers writing ad-hoc queries |
| **Kupo** (Cardano chain index) | SQLite **only**; Postgres backend a stub, *“put on hold”* | chain index by address pattern | **220 GB fine, 365 GB straining** | **The cautionary tale.** Open bug #209: >5 h `PRAGMA optimize` passes, ~70% io pressure, chain-sync stalls |
| **Midnight indexer** (upstream) | SQLite (`standalone`) **or** Postgres (`cloud`) | `ledger_db_nodes(key BLOB PK, object BLOB)` plus the full indexer schema | **~88 GB node store / ~161 GB total, ~1 GB/h** (in-repo record, not re-measured) | **Working, but the seam hurts.** 212 `cfg` sites across 41 files, two drifted DDL lineages, two drift-repair migrations |
| **Geth / Erigon / Reth** | Pebble / MDBX | full and archive chain state | 100s GB - TB | **No SQLite.** Erigon states the B-tree random-insert rationale; geth path-based state removes hash randomness from the key |
| **Solana** | RocksDB | blockstore/ledger | 500 GB target | **No SQLite, and RocksDB is contested**: ~30x write amplification, 40-min stalls, corruption on restart (#16234, open since 2021). History offloaded to BigTable |
| **Sui / Aptos** | RocksDB (+ Tidehunter opt-in / 22-way sharding) | chain and object state | 100s GB+ | **No SQLite.** Sui measured **10-12x write amplification**; Aptos cites RocksDB single-threaded commit as the bottleneck |
| **bitcoin-abe** | SQLite (supported) | full chain index | mainnet | **Documented failure.** Own README: reading the block files takes *“several days or more.”* Unmaintained |
| **Bitcoin Verde** | MariaDB → LevelDB | full BCH chain | ~600 GB | **Documented SQL-to-KV reversal.** v3.0.0: *“Replaced MariaDB with LevelDB”* |

---

## 8. What we should steal

1. **BDK’s `STRICT` tables and per-component `bdk_schemas` version table.** Answers B6 directly and
   maps onto UmbraDB’s existing forward-only migrator with almost no redesign.
2. **Bitcoin Core’s `application_id` + `user_version` + `integrity_check` on open, with a hard refusal
   on mismatch.** Gives `docs/CONTRACT.md` §2’s no-downgrade rule a mechanism it does not have today.
3. **CLN’s migration discipline**: downgrade is fatal, irreversible upgrades are refused on non-release
   builds unless explicitly opted in, and a `db_upgrades` audit table records every upgrade applied.
4. **CLN’s `db_write` hook contract** — a synchronous in-process hook carrying a monotonic
   `data_version` that a backup consumer must validate, halting the daemon on a gap or a regression.
   This is the single best idea in the survey and the only credible foundation for a live-backup story
   on SQLite.
5. **LND’s full contention stack**: `_txlock=immediate`, a large `busy_timeout`, a 20-attempt jittered
   retry classifier on the masked primary result code, and a connection pool capped at 2.
6. **LND’s `auto_vacuum=incremental` plus a startup `incremental_vacuum`** — the industry answer to
   VACUUM downtime on a large file.
7. **Zcash’s `sapling_tree_shards` rowid-keyed, hash-as-secondary-index shape**, corroborated by the
   Jellyfish Merkle Tree paper’s version-keys rationale. The highest-leverage fix for random-key write
   amplification (D5).
8. **The upstream Midnight indexer’s `transaction_identifiers` junction table** — verbatim (D4).
9. **Zcash’s `scan_queue` shape** — prioritized block ranges with CHECKed bounds — plus
   `nullifier_map`/`tx_locator_map` for detecting spends in unscanned regions, if UmbraDB ever needs
   non-linear or gapped sync.
10. **Zcash’s named per-release migration constants** (`V_0_19_0` and friends), which let a consumer
    pin to *the graph state that shipped in release X* rather than to an individual migration ID. That
    is the SemVer-compatible way to expose a migration lineage.
11. **Two databases, two durability policies** (D1) — Bitcoin Core, Zcash, and the Midnight indexer all
    do this, and Bitcoin Core documents it on one page.
12. **In-memory SQLite as the default unit-test store** (Bitcoin Core’s `InMemoryWalletDatabase`,
    `zcash_client_sqlite`’s `open_in_memory()`), which is where the testcontainers win actually comes
    from — but keep an on-disk leg, because `:memory:` does not exercise WAL, fsync or BUSY.
13. **The “derivable from chain” escape hatch, written down as a supported recovery tool.** Zcash
    ships migrations that truncate and re-scan; Zallet warns users they may need to delete and
    recreate; Penumbra rebuilds on schema-hash mismatch; Hydra accepts queue loss because *“the L1
    chain is the source of truth.”* UmbraDB’s checkpoints and archive have the same property. Its
    `TemporalKV` history does not — and that asymmetry should be stated explicitly in the contract.

## 9. What we should heed

1. **Do not build a dual-backend seam.** 212 `cfg` sites across 41 files in the closest comparable
   codebase; two DDL lineages that have already drifted and shipped bugs; kupo’s Postgres backend
   abandoned as a stub; and neither CLN nor LND can migrate between their two backends. **The owner’s
   full-replacement decision is correct**, and this lane’s evidence supports it against any lane
   inclined to hedge.
2. **`SQLITE_BUSY` has no home in the frozen G3 retryable set, and getting that wrong cost LND a P0
   fund-loss bug.** This is the most important single finding in the lane. Decide the error taxonomy
   deliberately, before writing `translateSqliteError`.
3. **5 seconds is not a `busy_timeout` default, it is a bug.** CLN hardcodes 60 s and refused to expose
   a knob; LND ships 5 s and real operators needed 1 to 10 *minutes*. And timeouts alone are not
   sufficient — the full four-layer stack is the minimum, and even it let a BUSY escape.
4. **The backup contract is the frozen commitment most at risk.** `docs/CONTRACT.md` §6 is not
   survivable as written, and **`VACUUM INTO` is not the escape hatch** — CLN explicitly warns it
   *“locks the main database for long time periods.”* LND’s SQL `Copy` is literally
   `errors.New("not implemented")`; Zallet’s documented procedure begins *“Stop Zallet.”* Put CLN’s
   Litestream retraction in front of the owner alongside the §6 rewrite.
5. **Do not use SQLite as a blob key-value store.** Bitcoin Core did exactly that for compatibility
   reasons UmbraDB does not have, called it *“numerous headaches”*, and is now unwinding it (#33034).
   Go relational from day one, like BDK.
6. **Dynamic typing will cost you silently, and it already has upstream.** Two `BYTEA` columns still
   sit in the Midnight indexer’s SQLite schema, and a whole migration exists to undo an f64 precision
   loss on Cardano lovelace amounts. SQLite cannot `ALTER COLUMN TYPE`; fixing it means rebuilding the
   table and every index. `STRICT` plus `typeof()` CHECKs, from the first DDL.
7. **A content-addressed store on a B-tree is the archive tier’s real ceiling**, and this project has
   already measured the pathology in its own indexer. The CPU-bound finding does *not* retire it: that
   was a read-path measurement taken while the working set fit in page cache. Sui measured 10-12x
   write amplification; Solana ~30x; the JMT paper redesigned the data structure rather than the
   engine. **Take the key randomness out (D5); do not tune around it.**
8. **Every write must be inside an explicit transaction.** Bitcoin Core’s v30 regression — 2-3x slower
   `generatetoaddress` — was one fsync per implicit autocommit. UmbraDB’s batched inserts already have
   the right instinct; preserve it.
9. **Expect a `database is locked` incident if the contention stack is not there from day one.** BDK
   shipped one to production mobile users at 35,000 UTXOs.
10. **Do not quote LND’s “SQLite beats Postgres” numbers as support.** They compare a key-value schema
    emulated in SQL, which is pathological on Postgres. CLN, which runs a real relational schema on
    both engines, says the opposite: *“PostgreSQL is generally faster than SQLITE3.”* **The honest case
    for this migration is operational simplicity, single-process fit, and deleting a service
    dependency — not speed.**
11. **The engine choice is close to irreversible.** CLN and LND both say so in writing. Make it before
    there is state to migrate — which, for UmbraDB, means before 1.0.0.
