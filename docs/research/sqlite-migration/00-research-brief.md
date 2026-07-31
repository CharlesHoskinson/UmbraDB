# UmbraDB → SQLite migration: shared research brief

You are one lane of a six-lane parallel research sprint. Read this whole file before starting.

## The question

**Can UmbraDB be migrated off PostgreSQL onto SQLite entirely — and what would that migration
actually look like?**

Scope decisions already made by the repo owner, do not re-litigate them:

- **Full replacement.** SQLite becomes the engine. `src/postgres/` is eventually deleted. This is
  NOT a "second backend alongside Postgres" study. Do not spend effort designing a dual-backend
  abstraction seam unless your lane's evidence says full replacement is impossible without one.
- **Everything is in scope**, including the chain archive (`chain_blobs`, `blocks`,
  `transactions`, `bridge_observations`) at multi-hundred-GB scale with ~1 GB/hour ingest.

Your job is evidence, not enthusiasm. A finding that a thing is **impossible** or **only possible
at a stated cost** is worth more than a hand-wave that it will be fine. If a frozen 1.0.0
commitment cannot survive the move, say so plainly and name the commitment.

## The subject

Repo: https://github.com/CharlesHoskinson/UmbraDB — a local, persistent, single-writer datastore
for Midnight blockchain clients. TypeScript, ESM-only, Node >= 24. It is a **library over
PostgreSQL** using [`postgres.js`](https://github.com/porsager/postgres) with no ORM: the caller
supplies the database, UmbraDB owns a schema inside it.

Five primitives plus two capabilities:

| Primitive | Purpose |
|---|---|
| TemporalKV | Versioned KV with point-in-time reads |
| CheckpointStore | Content-addressed, deduplicated, chunked snapshot storage with GC |
| Watermarks | Unversioned sync-progress cursors (last-write-wins) |
| Transaction/Lease | Real Postgres transactions + connection-pinned advisory locks |
| TransactionHistory | Per-wallet tx history, GIN-indexed on an identifiers array |

| Capability | Built from |
|---|---|
| WalletStateEnvelope | CheckpointStore — a whole wallet-sync snapshot in one `save()` |
| `saveAndAdvance` | CheckpointStore + Watermarks — the co-transactional cursor primitive |

Plus the chain archive (full-chain storage) and its `chain-archive-sync/` ingest service.

### What is frozen at 1.0.0 (read `ROADMAP.md` and `docs/` for the real text)

These are commitments the project has already made publicly. A migration that breaks one is not
automatically disqualified, but the break must be **named and costed**.

- **Formal cut-line `{T3, T5, W1, C1}`** — mechanized in Lean 4 under `Formal/Lean/`, gated by CI
  (`.github/workflows/lean.yml` rejects any `sorry`/`admit`/`axiom`/`unsafe`, then builds and
  independently `leanchecker`s the tree).
  - **T3** temporal projection / observational equivalence within retention
  - **T5** temporal coherence — interval non-overlap + gap-freedom
  - **W1** Watermarks last-write-wins
  - **C1** CheckpointStore abstract save-side chunk projection (a join-semilattice)
  The Lean layer models an **abstract store**; the abstract → PostgreSQL/TypeScript refinement is
  explicitly a *trusted, unmechanized* bridge (the AWS TLA+ stance), bridged empirically by the
  P1–P10 conformance suite. Ask what that trusted bridge becomes when the concrete store changes.
- **C2a** (GC reachability-safety) and **L1** (lease mutual exclusion) are MECHANISM SPECIFIED,
  not proved — enforced at runtime by a same-transaction reachability scan and a session-scoped
  advisory lock respectively, tested by P8 and P10.
- **G1 frozen public API surface** — a single barrel `src/index.ts`, strict `exports` map, no deep
  imports. Note `DEFAULT_SCHEMA` and schema-configurability are part of that surface.
- **G2 SemVer + CHANGELOG** — no incompatible change to the exported surface or the error `code`
  set in a minor/patch.
- **G3 frozen error catalog** — `docs/ERROR-CATALOG.md`, 25 codes with a machine-readable
  `retryable` field; frozen retryable set `{CONNECTION_ERROR, TRANSACTION_FAULT, LEASE_TIMEOUT,
  MIGRATION_LOCK_TIMEOUT}`. Drift-tested against the exported surface.
- **G4 eight written release contracts** — `docs/CONTRACT.md`: durability, forward-only migration,
  cancellation, save-retry, lease limitation, backup/restore, threat-model pointer, format
  headroom.

### The PostgreSQL features that are actually load-bearing

Inventory taken from `origin/main` before dispatch. Your lane owns some subset; the rest is
context so you understand what neighbouring lanes are handling.

- `btree_gist` extension + `tstzrange` + a `GENERATED ALWAYS AS (...) STORED` validity column +
  `EXCLUDE USING gist (ns WITH =, scope WITH =, key WITH =, validity WITH &&)` — this constraint
  **is** how T5 non-overlap is enforced at runtime.
- A `plpgsql` `BEFORE UPDATE FOR EACH ROW` trigger (`kv_current_history_trigger`) that uses
  `txid_current()` to reject a second write to the same key in the same transaction (raises
  custom SQLSTATE `UB001`), and writes the history row.
- `clock_timestamp()` + `date_trunc('milliseconds', ...)` for temporal boundaries — deliberately
  *not* `now()`, because `now()` is transaction-scoped.
- `pg_advisory_lock` / `pg_try_advisory_lock` / `pg_advisory_xact_lock`, session-scoped and pinned
  to a reserved connection (`sql.reserve()`).
- `jsonb` columns; `text[]` arrays with a **GIN** index and `<@` containment queries.
- `bytea` with `CHECK (octet_length(hash) = 32)` and
  `size_bytes integer GENERATED ALWAYS AS (octet_length(data)) STORED`.
- `PARTITION BY RANGE (height)` / `(block_height)` on the chain-archive tables, with a
  `_default` partition, plus partition-compatible unique indexes.
- `bigserial` and `bigint GENERATED ALWAYS AS IDENTITY`.
- `CREATE SCHEMA` + `search_path` for schema isolation and configurability.
- `SET LOCAL statement_timeout` / `lock_timeout`; real protocol-level query cancellation via
  `Query.prototype.cancel()`.
- `ON CONFLICT ... DO UPDATE`, `RETURNING`, `FOR UPDATE`, `unnest(...)` batch inserts, a defensive
  VALUES sub-batch fallback, and `fillfactor` tuning.
- `to_regclass` for migration bootstrap detection.

## Ground truth already established (do not re-derive, do build on)

Verified by the coordinator before dispatch, with the commands that produced them:

- The repo in WSL is `/root/UmbraDB`. **Its checked-out branch is stale** — it sits on
  `formal/v1.0.0-formal-completion` (`baf476a`), and `origin/main` (`3c0c68b`) is well ahead with
  the 0.9.5 "Penumbra" release, a rewritten README, and a v2 indexer-parallelism roadmap.
  **Your worktree is cut from `origin/main`. Treat your worktree as the truth.**
- `node --version` → **v24.18.0**. `node:sqlite` is **built in and working**; `select
  sqlite_version()` → **3.53.1**. You can run real SQLite experiments with **zero installation**.
  Use this. Measured behavior beats cited behavior every time.
- `sqlite3` CLI is **not** installed and `psql` **is** — but assume no live Postgres server.

## Traps — the complete recorded list

Every one of these has actually cost this project time. Read all of them even if only some look
relevant to your lane.

1. **WSL/Windows path trap.** The repo lives in WSL but your tools run on Windows. `Read`/`Write`/
   `Edit`/`Glob`/`Grep` given a bare `/root/...` path resolve it on the **Windows** drive and
   silently create or read phantom files. Always address WSL files through the UNC prefix
   `\\wsl.localhost\Ubuntu-26.04\root\...`. This is verified working for both read and write.
2. **WSL inline heredoc trap.** Never build a script or a multi-line prompt inline via
   `wsl -e bash -lc "..."` with **double** outer quotes — the outer quoting eats backticks and
   silently deletes content. Use single outer quotes: `wsl -e bash -lc '...'`.
3. **Use the Bash tool, not PowerShell, for WSL.** PowerShell expands `$(...)` and `$VAR` before
   bash ever sees them.
4. **Never claim "verified" without the command that produced it.** Paste the command and the
   relevant output into your report. An assertion with no command behind it must be labelled as
   an inference or a citation, not as a measurement.
5. **Do not run `npm install`** in your worktree. It is not needed (`node:sqlite` is built in),
   it is slow, and npm installs in this project's neighbourhood have previously destroyed an
   adjacent checkout's `node_modules` through a symlink.
6. **Do not modify `src/`, `test/`, or any product code.** This is a research sprint. Your only
   writes are your report and any throwaway experiment scripts, which go in `/tmp`.
7. **Don't trust HEAD of an upstream project when the repo pins a version.** A prior research
   round reached the wrong conclusion by reading an upstream `HEAD` while the deployment ran a
   tagged release with different feature flags. Check what UmbraDB actually pins.
8. **Beware the confident negative.** A prior round recorded "lever spent — measured no gain" and
   had to retract it: the measurement was masked by a much larger cost elsewhere. If you record a
   negative result, state what would have had to be true for the measurement to be meaningful.
9. **A green gate certifies depth, never breadth.** `0 sorry` in Lean proves that what is stated
   is proved; it cannot detect a missing or too-weak law. Do not treat CI green as coverage.

## Deliverable

Write **one Markdown report**, to **both** of these paths (same content):

- `\\wsl.localhost\Ubuntu-26.04\root\<YOUR_WORKTREE>\REPORT.md`
- `\\wsl.localhost\Ubuntu-26.04\root\umbradb-sqlite-research\reports\<YOUR_LANE_ID>.md`

Writing to the shared `reports/` directory is what makes your work survive; do not skip it.

Structure it as:

1. **Verdict** — 3–6 sentences. Can your lane's surface move to SQLite? At what cost? Lead with
   the answer, not the journey.
2. **Blockers** — each one: what Postgres feature, what it guarantees today, what SQLite offers
   instead, and whether the gap is *closeable in application code*, *closeable with a schema
   redesign*, or *not closeable*. Name any frozen 1.0.0 commitment it touches.
3. **Evidence** — commands run and their output, file:line citations into the worktree, and any
   experiment scripts with their results. This section is what the consolidation trusts.
4. **Design sketch** — the SQLite shape you would actually build, concretely enough that someone
   could start. DDL where it matters.
5. **Open questions / what you could not settle** — be honest. An unsettled question that is
   clearly flagged is far more useful than a guess presented as a finding.
6. **Cost estimate** — rough engineering size for your lane's slice, and what it would break.

Cite as `path/to/file.ts:123` relative to the worktree root. Keep the report dense; the
coordinator reads all six.

## Boundaries

Stay inside your lane. Where you touch a neighbouring lane's territory, note the dependency
explicitly (e.g. "this assumes L3 chooses a synchronous driver") rather than researching it
yourself. Overlap is waste; a flagged dependency is a finding.
