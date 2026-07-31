# Proposal — v1.0.0 SQLite Engine Core

> **Status:** Draft for the 1.0.0 program. Capability: `sqlite-engine`. Change id:
> `v1.0.0-sqlite-engine-core`. This change is the **keystone** of the PostgreSQL→SQLite migration:
> it selects the driver, defines the query façade every adapter is written against, moves the
> database handle behind a worker boundary, fixes the once-only pragma bootstrap, and owns the
> **blocking measurement gate** that four of the other five changes read their numbers from.
> Nothing else in the migration is implementable until the decisions here are made.

## Why

UmbraDB is a library embedded in a Midnight wallet client. Today it requires the consumer to
install, provision and operate a PostgreSQL server: `package.json:4` describes it as
"A local, single-writer, **PostgreSQL-backed** temporal and content-addressed store," and
`createClient` (`src/postgres/client.ts:147`) takes a `postgres://` connection string, a pool size,
a TCP connect timeout and three server-side GUC timeouts. For a wallet that is a deployment
requirement out of all proportion to the workload, and it puts four of UmbraDB's durability
preconditions (`docs/CONTRACT.md` §1) in the hands of whoever configured the server.

An embedded engine removes the server. The adjudicated research verdict is **migrate, land it
before the 1.0.0 tag, and re-measure almost everything first** — and the pre-tag window is real:
`docs/STABILITY.md:46` states verbatim *"Current version: `0.9.5` — the commitments above are NOT
yet in force,"* and `:60-61` that *"a breaking change between `0.9.5` and `1.0.0` is permitted by
SemVer."* The tag is separately blocked on a full local Midnight sync (`CHANGELOG.md:15-18`,
`ROADMAP.md:389-398`), so the window is not closing on this migration's schedule.

This change exists because three of its decisions are **irreversible or load-bearing for everything
else**, and each was left genuinely open by the research:

1. **The driver is contested.** Lane L3 recommends the `node:sqlite` built-in; the commitments
   council seat rules against it and for a pinnable third-party binding, because `docs/STABILITY.md:18`
   commits UmbraDB to *"No breaking changes to the exported surface or the error-`code` set in a
   minor or patch release"* and that promise cannot be made about a substrate whose platform reserves
   the right to change in a minor. `design.md` §1 rules, with reasons and consequences.

2. **The pragma bootstrap is a one-shot decision that fails silently in the wrong order.** Measured
   on the ruled driver (`design.md` §4): setting `page_size`/`auto_vacuum` *after*
   `journal_mode=WAL` leaves a database permanently at `page_size=4096, auto_vacuum=0` — and both
   orderings report success. `auto_vacuum` cannot be retrofitted at all; the only remedy is a full
   `VACUUM`. No lane owned this sequence; the contradiction seat found two lanes had written it and
   the wrong one owned the code path.

3. **Six of seven research lanes benchmarked on a tmpfs RAM disk.** Re-measured on ext4, WAL
   `synchronous=FULL` went from a published 88,485 commits/s to **379** — a **233× error**. Two of
   L5's conclusions invert. L1's clock crisis ("99.2% of same-key puts rejected") is **0.0% at
   `synchronous=FULL`**, so the entire logical-clock redesign is downstream of a pragma L1 never
   varied. Every performance-dependent decision in this sprint is therefore standing on numbers that
   are known-wrong, and this change owns the gate that replaces them.

There is also an **enhancement** available that PostgreSQL could not give: today
`resolveTransaction` hands a live driver object across a module boundary
(`src/postgres/transaction-lease.ts:57` returns `ISql<{bigint: bigint}>`), so a caller holding a
`TransactionHandle` holds database access. Moving the handle into a worker thread makes the
transaction-identity guard **unforgeable** — the caller holds an opaque token and the only code that
can execute SQL lives on the other side of a message boundary.

Grounding follows this project's own convention (`openspec/config.yaml` correctness rule): every
external-API claim below and in `design.md` was verified against the actually installed binding on
this machine, with the command and its output recorded in `design.md` §4 — not asserted from a lane
report.

## What changes

1. **Driver ruling: a version-pinned third-party binding (`better-sqlite3`), not `node:sqlite`.**
   The commitments seat's ruling is adopted, and strengthened by measurement: L3's central
   supply-chain objection to `better-sqlite3` was already refuted by L3 itself (no install scripts,
   8 prebuilds in the tarball), and L3's "newest SQLite" advantage is **inverted** — the binding
   ships 3.53.4, `node:sqlite` on the declared `engines` floor ships 3.53.1. The trade, its costs and
   the two capabilities given up (`enableDefensive`, `setAuthorizer`) are recorded in `design.md` §1.

2. **A `postgres.js`-shaped tagged-template shim** (`src/sqlite/sql.ts`) so the ~190 hand-written
   `` sql`…` `` call sites port **without their authors rewriting them**. The shim owns four things
   no call site may re-implement: **bind normalisation**, **origin-keyed row decoding**, the
   **parameter-ceiling** split, and **per-row guard injection**.

   *Amended (G-7): an earlier draft of this line said "query text preserved rather than rewritten."
   That is false for every guarded statement — the cancellation guard must appear in the SQL text, so
   the shim rewrites it. What is preserved is the property that actually mattered: **no call-site
   author writes or maintains the difference**, and the diff stays reviewable because the
   transformation is one mechanical injection rather than 190 hand edits.*

3. **Connection/handle lifecycle replacing `createClient`'s pooled semantics.** One database file,
   one handle, no pool. `connectionString`→`path`; `maxConnections`, `connectTimeout` and
   `idleInTxTimeoutMs` are removed (no analogue in an embedded engine); `lockTimeoutMs` maps to
   `busy_timeout`; `statementTimeoutMs` survives via a deadline guard. Retired keys are **rejected**,
   not forwarded — measured, the binding accepts unknown option keys silently, so forwarding today's
   option bag would produce a client that appears to honour durability bounds it has dropped.

4. **Worker-thread topology.** One worker owns the single database handle. The main thread never
   holds it. `TransactionHandle` becomes an opaque token validated by the worker, which is the
   enhancement in item 3 of "Why". The red team's limit is recorded rather than papered over:
   round-trip transport grows with payload (114.7 µs at 1 statement/message → 503.6 µs at 100) and
   amortisation is **structurally unreachable for `withTransaction(fn)`**, a frozen export whose body
   is caller code on the main thread (`src/interfaces/transaction-lease.ts:172`: the layer has "no
   mechanism … to interrupt it partway through").

5. **A batched streaming protocol across the worker boundary, with worker-owned release.** The merged
   `temporal-kv` spec requires `listKeys` to stream (`openspec/specs/temporal-kv/spec.md:213`), today
   via a `postgres.js` server cursor (`src/postgres/temporal-kv.ts:324-325`). Measured, the ruled
   binding streams lazily — first row in 0.11 ms against 109 ms to materialise the same 200,000 rows —
   so the property survives; the difficulty is the thread boundary, not the engine. The worker holds
   the iterator and the main thread pulls one batch per round trip. **The hazard this exposes is
   new:** while an iterator is open the handle refuses **writes**, so a half-consumed stream would
   wedge the writer for the whole process — a consequence a pooled Postgres cursor never had. Release
   therefore becomes a worker obligation (abort message, idle deadline, release-before-close) rather
   than a consumer courtesy, which strengthens a limitation the current implementation documents as
   unavoidable. Batch size and deadline are measurement obligations, not constants.

6. **An ordered, once-only, read-back-verified pragma bootstrap**, with the *values* explicitly
   deferred to the measurement gate and the *order* fixed by requirement.

7. **The blocking ext4 measurement gate.** A re-measurement suite with declared conditions
   (filesystem, `journal_mode`, `synchronous`, `page_size`, dataset size relative to page cache,
   single vs concurrent writer, driver and SQLite version) publishing a machine-readable artifact,
   plus a rule that **no requirement in this sprint may cite a number absent from that artifact**.
   Eight downstream decisions are named as blocked on it (`design.md` §6), including change 2's
   logical clock and this change's own streaming batch size.

8. **Four silent-corruption traps promoted from prose to requirements with catching scenarios:**
   a positionally bound `Date`; unpaired surrogates and NUL bytes; the irreversible pragma order; and
   64-bit integer fidelity — the last being a trap the driver ruling *introduces* and must therefore
   close (`design.md` §1.5).

## Non-goals (explicitly out of scope)

- **The chain archive's port — owned by change 6, and no longer "out of scope."** *Corrected: an
  earlier draft of this proposal called the archive out of scope and cited
  `src/postgres/migrations/chain_archive/001_chain_archive_core.ts:86` — "Not wired into any runner
  path that would execute it."* **That comment is stale and the scope claim was wrong on two
  counts.** It *is* wired: `package.json:46` exposes `archive:sync` → `sync-cli.ts:38` →
  `bootstrap.ts:21` → `runMigrations(..., chainArchiveMigrations)`, and `sync-service.ts:123`
  constructs `PgChainArchiveStore`; `tsconfig.json` typechecks the directory while
  `tsconfig.build.json` excludes it from the build. And the owner has asked for archive snapshots, so
  the archive is **ported to SQLite by change 6** (`v1.0.0-sqlite-chain-archive`). What remains true
  is that it has **no data and no production consumer** — `archive:sync` has never run against a real
  database. This change owes change 6 the driver, shim, worker topology and pragma bootstrap, plus
  two engine facts (`SQLITE_MAX_LENGTH` = 1 GB; no incremental BLOB I/O on either binding), and
  specifies none of the archive's own design. See `design.md` §8.1 and §10.1 (R-1).
- **The DDL.** Table/index/trigger naming and prefixing, `STRICT` table definitions, the junction
  table, `listKeys` range scans, the `coalesce(...)` expression index and the migration framework are
  **change 4** (`v1.0.0-sqlite-schema-parity`). This change specifies what the shim requires *of*
  the DDL (§5.3) and does not author it.
- **The event-log schema, T3/T5 enforcement and the clock policy** are **change 2**
  (`v1.0.0-sqlite-temporal-event-log`). This change specifies the measurement its clock decision is
  blocked on, not the decision.
- **What `listKeys` still promises.** This change specifies the streaming *mechanism* across the
  worker boundary (`design.md` §3.5) because that is engine topology. It authors **no** delta to
  `openspec/specs/temporal-kv/spec.md:213` — restating the requirement is **change 2**'s, and the
  predicate that method issues is **change 4**'s §11. On the measured evidence the requirement's
  streaming scenario survives and needs no weakening; that finding is offered to change 2, not
  imposed on it.
- **The lease, `BEGIN IMMEDIATE`, the JS poll loop, sticky-poison emulation and contention
  error-code mapping** are **change 3** (`v1.0.0-sqlite-concurrency-lease`). This change provides
  the worker boundary they run on and hands over the measured error shape (§4.6); it does not choose
  the lease mechanism.
- **Contract text, the error catalog, the durability probe, backup/restore, page-checksum coverage
  and observability** are **change 5** (`v1.0.0-sqlite-durability-contract`). In particular this
  change does **not** rewrite `docs/CONTRACT.md` §3 or §6.
- **Migrating data out of an existing PostgreSQL deployment — owned by change 7.** *Corrected: an
  earlier draft said there was "currently nothing to migrate," resting on the feasibility seat's <!--MENTION:retraction-->
  finding of no observable consumer.* **The owner has answered: consumers install from the git tag,
  from repo clone, and from docker images.** The absence of an npm-registry entry is the absence of a
  *chokepoint*, not the absence of consumers, and the zero-work finding is reversed. A
  PostgreSQL→SQLite data-migration path is required and is **change 7**
  (`v1.0.0-sqlite-data-migration`), covering the **wallet tier only** — the archive has no data.
  This change records change 7's dependencies (`design.md` §10.2) and specifies no migration path.
- **Encryption at rest.** SQLite has no equivalent of the PostgreSQL TDE option in `SECURITY.md`;
  SEE is commercial and SQLCipher is a fork. Recording the gap is change 5's.
- **Network filesystems and Windows-specific behaviour.** No lane was assigned either; SQLite is
  known-hazardous on network filesystems. This change does not claim coverage.
- **Raising the `engines` floor.** `package.json:31-33` stays `">=24"`. Raising it to buy release-
  candidate status for a platform module is itself a breaking change, and Node 25 is the non-LTS
  line (commitments seat R5(b)).
- **Re-proving anything in Lean.** The cut-line `{T3, T5, W1, C1}` survives this migration untouched
  because it models an abstract store — that survival is **not** evidence the migration is safe. The
  P1–P10 conformance suite carries the refinement claim and must be **re-executed, not amended**.
- **No performance number is a completion criterion of this change.** The gate requires the numbers
  to be *established under declared conditions and published*; it does not assert what they will be.

## Impact

- **New files:** `src/sqlite/sql.ts` (the shim: tagged template, normalise, origin-keyed decoder,
  parameter-ceiling split); `src/sqlite/worker.ts` + `src/sqlite/worker-host.ts` (the worker, its RPC
  and the opaque-token table); `src/sqlite/bootstrap.ts` (ordered pragma sequence + read-back
  assertion); `src/sqlite/client.ts` (the replacement `createClient`); a measurement harness and its
  published artifact under `bench/`.
- **Modified files:** `src/index.ts` — `UmbraDBSql` and `UmbraDBConnectionOptions` re-exports
  (`:81`) change shape; `src/postgres/checkpoint-store.ts:62-63` batch constants must come down from
  60,000 bind parameters to fit a hard 32,766 ceiling (measured: 30,000 rows × 2 params fails to
  prepare); `src/interfaces/temporal-kv.ts:35` `hasPostgresUnsafeText` is **renamed and its rationale
  rewritten, never deleted**; `docs/supply-chain/inventory.md` gains a runtime row for the binding
  and its vendored SQLite version; `.github/workflows/supply-chain.yml` gains an assertion that the
  runtime's `sqlite_version()` matches the inventoried one; `package.json` `dependencies` and the
  `description` at `:4`.
- **Frozen-surface breaks, all cheap pre-tag and expensive after.** `UmbraDBSql`
  (`src/postgres/client.ts:10`) is the one **permanent, unavoidable** change — it is nominally the
  `postgres.js` `Sql` type and its declaration leaves with the dependency. `UmbraDBConnectionOptions`
  (`:44-77`) loses four fields. `DEFAULT_IDLE_IN_TX_TIMEOUT_MS` (`:145`) becomes meaningless. Landed
  before the tag each costs a `CHANGELOG.md` entry (`docs/STABILITY.md:46`, `:60-61`); landed after,
  each independently forces a major version.
- **The honest price of the pre-tag window,** per the commitments seat: `0.9.5` exists so the surface
  can be exercised by real consumers before it becomes a promise, and this migration retires it as a
  release candidate. Expect **one more pre-1.0 RC with a soak window**, not a straight tag.
- **Risk.** The dominant risk is a *silent* one: every trap this change closes fails without an
  error — a `Date` becomes NULL or is rejected only if the schema is `STRICT`, a surrogate becomes
  U+FFFD, a wrong pragma order yields a permanently mis-configured file, a 64-bit version number
  loses its low bits. That is why each is specified as a requirement with a scenario that would
  catch it, and why the shim — one normalisation table, one decoder table — is preferred over a
  native-API rewrite that would meet each trap once per call site.
