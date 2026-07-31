# L6 — Contracts, durability, migrations and verification

Lane id `l6-contracts`. Worktree `/root/UDB-sqlite-l6-contracts` (cut from `origin/main`).
All measurements taken on this host (WSL2 Ubuntu 26.04, 12 cores, 62 GB RAM, ext4 on `/dev/sdd`)
with Node v24.18.0 / `node:sqlite` / SQLite **3.53.1**. Every number below is followed by the
command that produced it in §3.

---

## 1. Verdict

**Seven of the eight written contracts survive the move; one does not, and one improves outright.**
Durability (§1) is the contract most likely to *improve*: Postgres's four binding **deployer**
preconditions collapse into two pragmas UmbraDB can set itself, and SQLite's per-frame WAL checksums
make the `full_page_writes` torn-page hazard structurally absent — I crash-tested a torn WAL tail and
recovery landed on the last good frame with `integrity_check = ok` every time. The honest cost of
holding today's guarantee is **`PRAGMA synchronous=FULL`, measured at 523 co-transactional
commits/s versus 14,229 at `NORMAL` — a 27x lever**, and `NORMAL` is *already contract-legal* because
it maps exactly onto the `synchronous_commit=off` "lost tail" the current probe **warns** about
rather than refuses. **Cancellation (CONTRACT §3) is the one contract that cannot be kept**: with a
synchronous embedded driver an `AbortSignal` provably cannot fire mid-query (measured) and
`node:sqlite` exposes no `interrupt()`, so the "during a long read the wait is freed" clause must be
deleted, not reworded. On migrations the received wisdom is **wrong in both directions**: SQLite
3.53.1 *does* support `ALTER TABLE … ALTER COLUMN … SET/DROP NOT NULL` and `ADD/DROP CONSTRAINT`
(measured, O(1) metadata ops), so the 12-step rebuild is needed far less than expected — but
migration `006`'s exact statement, `ADD COLUMN … GENERATED ALWAYS AS (…) **STORED**`, is **rejected
on any non-empty table** ("cannot add a STORED column"), so the shipped lineage does not replay
as-written. The decisive de-risking fact for the whole error-catalog question is that
**`docs/STABILITY.md:46` says the SemVer commitments are NOT yet in force at 0.9.5** — land the
migration before the 1.0.0 tag and none of the ~6 catalog changes is a breaking change at all.
Finally, the verification infrastructure is where this migration pays for itself: a Postgres
testcontainer costs **2,513–3,271 ms**; a fresh, fully-migrated SQLite database costs **0.29 ms**
in memory and **52.8 ms** on ext4 — roughly **9,000x** and **50x** respectively. **One late finding
outranks all of the above for the 1.0.0 question specifically (B10):** `package.json:31-33` declares
`engines: node >=24`, and on Node 24 `node:sqlite` is an **experimental** platform API that emits
**no warning at all** (verified). A library about to make a binding SemVer promise would be resting
its entire storage engine on an unpinnable built-in that no lockfile, inventory or CI gate can
observe — a different and arguably worse supply-chain profile than the pinned `postgres@^3.4.9` it
replaces, and one that must be resolved by an `engines` floor, an explicit `STABILITY.md` carve-out,
or a pinnable third-party driver before the tag, not after.

---

## 2. Blockers

Ordered by severity. Each names the Postgres feature, what it guarantees today, the SQLite offer,
and whether the gap is *closeable in application code* / *closeable with a schema redesign* /
*not closeable*.

### B1 — Cancellation semantics (CONTRACT §3). **NOT CLOSEABLE** with a synchronous driver.

*Today:* `docs/CONTRACT.md:53-70` promises three timings. The middle one is load-bearing: "**During
a long read** (`listKeys`, lease acquisition) — the in-flight cursor / lock wait is **freed**: the
driver's `query.cancel()` fires and the wait unwinds." That rests on postgres.js's protocol-level
`Query.prototype.cancel()` opening a *second* connection to issue a `CancelRequest`.

*SQLite:* there is no second connection to cancel from, and `node:sqlite` exposes **no**
`interrupt()` and **no** progress handler (`DatabaseSync.prototype` enumerated in §3.7 — the full
list contains neither). Worse, because the API is synchronous, the event loop is blocked for the
whole query: I scheduled `ac.abort()` at +5 ms before a 36 ms query and the abort listener **did not
fire until the query had already returned**. `opts.signal` can therefore only ever be checked
*between* statements.

*Verdict:* the "before dispatch" timing survives verbatim; the "during a quick write" timing survives
(trivially — it becomes *always* "may still complete"); the "during a long read" timing must be
**deleted**. Two partial mitigations exist, neither sufficient: (a) `PRAGMA busy_timeout` bounds
*lock* waits precisely (measured: 352 ms for a 350 ms bound) so `LEASE_TIMEOUT` /
`MIGRATION_LOCK_TIMEOUT` keep working; (b) a throwing user-defined function *can* abort a running
statement mid-scan (measured: aborted after 1,001 rows in 30 ms) — but only for queries whose plan
actually invokes it, and the thrown error loses `errcode`/`code`. **Frozen commitment touched: G4
contract 3.** Depends on **L3**'s driver choice — an async driver (`node-sqlite3`) exposes
`sqlite3_interrupt` and would restore part of this; that trade is L3's to make, and it is the single
strongest argument for an async driver in the whole sprint.

### B2 — Three server-side timeouts collapse to one. **Closeable in application code, partially.**

*Today:* `docs/durability-contract.md:94-111` — `createClient` applies `statement_timeout` (120 s),
`lock_timeout` (30 s) and `idle_in_transaction_session_timeout` (120 s) as startup parameters, so
"no statement, lock wait, or idle-in-transaction session can hang unbounded."

*SQLite:* `busy_timeout` is a faithful `lock_timeout`. There is **no** `statement_timeout` analogue
without a progress handler, and **no** `idle_in_transaction_session_timeout` analogue at all. In a
single-process embedded engine an idle-in-transaction session is a bug in *our* code rather than a
foreign session wedging the server, which softens (does not remove) the second gap. A JS-side
watchdog can bound wall clock but cannot *unwind* the C call. **Frozen commitment touched: none
directly** (§5 of the durability contract is "documented, not probe-enforced") — but the sentence
"so no statement … can hang unbounded" becomes false as written.

### B3 — Migration `006`'s `ADD COLUMN … STORED` does not replay. **Closeable with a schema redesign.**

*Today:* `src/postgres/migrations/006_ckpt_chunks_size_bytes.ts:16-19` is exactly
`ALTER TABLE <schema>.ckpt_chunks ADD COLUMN size_bytes integer GENERATED ALWAYS AS
(octet_length(data)) STORED`. The same shape appears again in the chain-archive lineage
(`migrations/chain_archive/001_chain_archive_core.ts`).

*SQLite:* **measured** — `ALTER TABLE … ADD COLUMN … STORED` succeeds on a **0-row** table and fails
with `cannot add a STORED column` on a table with **1 or more rows**. `VIRTUAL` always succeeds and
is instant even on 200,000 rows (0.1 ms). `STORED` in a `CREATE TABLE` always works.

*Verdict:* three ways out, in ascending cost. (a) Use `VIRTUAL` — `size_bytes` exists purely to let
`history()`'s aggregate `sum(size_bytes)` avoid detoasting the `bytea`; SQLite has no TOAST, and
`length(blob)` on a blob column is O(1) from the record header, so **`VIRTUAL` is very likely free
here and the whole migration may be unnecessary** (flag to **L5**: measure `sum(length(data))` vs
`sum(size_bytes)` before keeping either). (b) Fold the column into the `CREATE TABLE` in the
`002` transliteration and make `006` a no-op recorded row — legitimate for a greenfield SQLite
lineage, *not* legitimate for an in-place engine migration of an existing database. (c) The
12-step rebuild — see B4. **Frozen commitment touched: G4 contract 2** (forward-only) only in the
sense that the lineage's *text* changes; the forward-only *property* is preserved.

### B4 — Table rebuild at archive scale. **Closeable, at a stated and large cost.**

The classic "SQLite `ALTER TABLE` is crippled" framing is **substantially out of date at 3.53.1**.
Measured on a 200,000-row table with a secondary index:

| statement | result | time |
|---|---|---|
| `ADD COLUMN` (plain, with constant default) | OK | 0.3 ms |
| `ADD COLUMN … GENERATED … VIRTUAL` | OK | 0.1 ms |
| `ADD COLUMN … GENERATED … STORED` | **FAIL** `cannot add a STORED column` | — |
| `ALTER COLUMN … SET NOT NULL` | **OK** (schema really changes) | 0.1 ms |
| `ALTER COLUMN … DROP NOT NULL` | **OK** | 0.1 ms |
| `ADD CONSTRAINT … CHECK(…)` | **OK**, and *validates existing rows* (fails if violated) | 7.2 ms |
| `DROP CONSTRAINT` | **OK** | 0.1 ms |
| `DROP COLUMN` | OK (full rewrite) | 86.2 ms |
| `RENAME COLUMN` / `RENAME TO` | OK | 0.5 ms |
| `ADD COLUMN … UNIQUE` | FAIL `Cannot add a UNIQUE column` | — |
| `ADD COLUMN … NOT NULL` with no default | FAIL | — |
| `ADD COLUMN … DEFAULT (datetime('now'))` | FAIL `non-constant default` | — |
| DDL inside `BEGIN … ROLLBACK` | **transactional, correctly rolled back** | — |

So the rebuild is reserved for: adding a `STORED` generated column to populated data, adding a
`UNIQUE` column, and changing a column's declared type. For those, **measured on a 4,096 MB
table on ext4**: the rebuild ran at **80 MB/s**, and the **peak on-disk footprint was 14,164 MB for
4,096 MB of logical data — 3.5x, not the 2x everyone assumes**, because the whole rebuild sits in
one WAL that cannot be checkpointed until the transaction commits. Extrapolated (a *floor*: this
host's page cache absorbed most of the working set, and a cold 300 GB archive is I/O-bound on both
read and write):

| logical size | rebuild wall clock | peak disk needed |
|---|---|---|
| 100 GB | ≥ 0.3 h | ≥ 350 GB |
| 300 GB | ≥ 1.0 h | ≥ 1.05 TB |
| 1 TB | ≥ 3.5 h | ≥ 3.5 TB |

A rebuild is **not** flatly infeasible at archive scale, but it requires 3.5x free disk and an
exclusive window, and it is a single transaction — a crash mid-rebuild rolls the whole thing back
and repeats the cost. **Recommendation, and this is a real constraint on the forward-only
framework:** add a binding rule that *the chain-archive lineage may never contain a rebuild
migration*, and enforce it with a lint (grep the lineage for `create table … _new`). Additive
`ADD COLUMN`/`ADD CONSTRAINT`/`CREATE INDEX` are cheap enough to remain unrestricted. Chunking a
rebuild into a resumable copy-in-batches loop is possible but breaks the framework's
one-transaction-per-migration invariant (`migrate.ts:263`) and is a design change, not a tweak.

### B5 — Error catalog: 6 of 24 codes change meaning or die. **Closeable in code; the *contract* question is the real one.**

The catalog is **24** codes (`docs/ERROR-CATALOG.md`; the drift test derives the count and never
hard-codes it — `test/api-surface/error-catalog-drift.test.ts`). `node:sqlite` exposes the
**extended** result code on `err.errcode`, which is a genuinely good SQLSTATE analogue (measured in
§3.6). Code-by-code:

| Code | Fate | Notes |
|---|---|---|
| `VALIDATION_FAILED` | **clean** | Zod, pre-backend. Engine-independent. |
| `SERIALIZATION_FAILED` | **clean** | encoding round-trip. |
| `VERSION_CONFLICT` | **clean** | `WHERE version = e`, 0 rows affected. |
| `HISTORY_UNAVAILABLE` | **clean** | pure application logic. |
| `NOT_FOUND` | **clean** | |
| `CHUNK_MISSING` | **clean** | |
| `CHUNK_INTEGRITY` | **clean** | SHA-256 re-verify in app code. |
| `MANIFEST_CORRUPT` | **clean** | |
| `VERSION_UNSUPPORTED` | **clean** | envelope decoder. |
| `CORRUPT` | **clean** | envelope decoder. |
| `TRANSACTION_ROLLED_BACK` | **clean** | `Rollback` control primitive. |
| `TRANSACTION_HANDLE_INVALID` | **clean** | in-process handle bookkeeping. |
| `LEASE_NOT_HELD` | **clean** | |
| `LEASE_TIMEOUT` | **clean** | `busy_timeout` → `SQLITE_BUSY` (5). Measured exact. |
| `MIGRATION_LOCK_TIMEOUT` | **clean** | same mechanism (**L2** owns the lock itself). |
| `TRANSACTION_KEY_REUSE` | **changed mechanism, same meaning** | `UB001` → `RAISE(ABORT,…)` in a trigger, surfacing as **`SQLITE_CONSTRAINT_TRIGGER` = 1811** with a caller-controlled message. Measured. Needs a message sentinel (e.g. `UB001:` prefix) because 1811 is shared by every trigger-raised abort. **Depends on L1** for the mechanism. |
| `LEASE_FAULT` | **changed meaning** | "infrastructure fault, e.g. a connection loss during release." An embedded engine has no connection to lose; it becomes `SQLITE_IOERR_*` / `SQLITE_FULL` during release. Reachable, narrower. |
| `CLOCK_REGRESSION` | **changed meaning, still `conditional`** | The 23514 CHECK becomes a SQLite CHECK (`SQLITE_CONSTRAINT_CHECK` = 275, measured). The same-millisecond collision cause survives; but SQLite has no `clock_timestamp()`/`now()` split — everything is statement-scoped, so **the underlying temporal mechanism is L1's to redesign** and the *second* cause may vanish or change character. |
| `TRANSACTION_FAULT` | **substantially narrowed** | Today: `40001` serialization failure, `40P01` deadlock, or mid-transaction connection loss. SQLite is a **single writer with no MVCC write conflicts and no deadlock detector** — 40001 and 40P01 have no analogue, and there is no connection to lose. It stays reachable only via `SQLITE_BUSY_SNAPSHOT` (WAL, a read snapshot that can't be upgraded) and I/O faults. **This is a retryable-set member whose retry semantics genuinely change.** |
| `CONNECTION_ERROR` | **repurposed** | The obvious case. `CONNECTION_FAILURE_CODES` (`src/postgres/errors.ts:215-241`) is 8 Node network codes + 10 SQLSTATEs, **every one of which becomes unreachable**. It is *not* dead: `SQLITE_CANTOPEN` (14), `SQLITE_READONLY` (8), `SQLITE_NOTADB` (26) and the `SQLITE_IOERR_*` family are exactly "cannot get at the database" and map here naturally (all measured). But repurposing changes the *retry advice*: `ConnectionError` is **retryable**, and `CANTOPEN` on a missing path or `READONLY` on a bad mode will never clear on retry. This is the identical hazard `docs/ERROR-CATALOG.md:108-120` already documents for persistent `28xxx` auth failures — the same "bound your retries" caveat covers it, but it gets *worse*, because on Postgres the transient share of `CONNECTION_ERROR` is large and on SQLite it is nearly zero. |
| `EXCLUSION_VIOLATION` | **becomes unreachable as spelled** | `23P01` fires on `kv_history_no_overlap`, a GiST `EXCLUDE`. SQLite has **no EXCLUDE constraint**. Whatever **L1** replaces T5 non-overlap with (a trigger, a partial unique index, or an application check) will raise something else — most plausibly `SQLITE_CONSTRAINT_TRIGGER`. The code can be kept alive by mapping the replacement mechanism to it. Its second role (a key-reuse conflict arriving with no key context) survives. |
| `TRANSACTION_POOLER_DETECTED` | **DEAD — genuinely unreachable** | There is no pooler in front of an embedded engine. Nothing can ever throw it. |
| `DURABILITY_CONTRACT_VIOLATION` | **survives, trigger conditions change wholesale** | `fsync=off` → `PRAGMA synchronous=OFF` and/or `journal_mode=OFF|MEMORY`; `full_page_writes=off` → *nothing* (see B6). The `allowFullPageWritesOff` option becomes vestigial. |
| `UNRECOGNIZED_POSTGRES_ERROR` | **the sharpest single problem** | Functionally fine — a catch-all is exactly what an unrecognized `errcode` needs. But the *identifier contains the word POSTGRES*. Keeping it is absurd; renaming it is a **breaking change to a frozen code string** under `docs/STABILITY.md:18-25`, which forbids renaming or repurposing a `code` in a minor or patch and permits removal only in the next major after a minor's deprecation. |

**The contract question the brief asks me to argue rather than assume: is an unreachable code a
breaking change?** My answer: **no for `TRANSACTION_POOLER_DETECTED`, yes for the retryable-set
members.** The stability policy's actual promise (`docs/STABILITY.md:20-25`) is about the *exported
surface* — "the set of exported names, their types, and the frozen `code` discriminants" — and a
class that still exists, still exports, still narrows in a `switch`, and simply never fires breaks
no consumer's code. A `catch` arm that stops being taken is not a compile error and not a runtime
error; it is dead code in the consumer, which is a documentation problem, not a compatibility one.
The drift test (which compares the doc's code set against the *exported* class set, not against a
set of observed throws) stays green, correctly. **But that argument does not extend to
`retryable`.** `retryable` is explicitly "so a caller decides whether to retry **without parsing a
message string**" (`src/interfaces/storage-errors.ts:26-33`); a caller has built a retry policy
*on that field*. `CONNECTION_ERROR` going from "mostly transient, retry is usually right" to
"almost always permanent, retry is almost always wrong" keeps the marking `retryable` while
inverting the behaviour the marking predicts. That is a semantic break the SemVer text does not
catch, and it is the honest reason to prefer additive new codes (`DATABASE_UNAVAILABLE`,
`DISK_FULL`, `DATABASE_CORRUPT`) over repurposing. **Frozen commitments touched: G2, G3.**

**The decisive mitigation:** `docs/STABILITY.md:46` — *"Current version: `0.9.5` — the commitments
above are NOT yet in force."* SemVer permits a breaking change between 0.9.5 and 1.0.0. **If this
migration lands before the 1.0.0 tag, every item in this section costs a CHANGELOG entry and
nothing more.** After the tag, `UNRECOGNIZED_POSTGRES_ERROR` alone forces a 2.0.0. This is the
single highest-leverage scheduling fact in my lane, and it should drive the sprint's sequencing.

### B6 — `full_page_writes` has no analogue, and that is good news. **Not a blocker; a contract simplification.**

`docs/CONTRACT.md:34` and `docs/durability-contract.md:38-45` make `full_page_writes=off` a refusal
with the project's **only** documented override. SQLite's WAL carries a **per-frame checksum**, so a
torn or garbage frame is detected at recovery and the log is truncated at the last valid frame — the
failure mode is a *lost tail* (the safe direction per CONTRACT §1), never a torn page. Measured, all
four damage modes, `integrity_check = ok` in every case:

| damage to a hot WAL after SIGKILL | committed | recovered | integrity |
|---|---|---|---|
| none (control) | 400 | 400 | ok |
| 400 B garbage at the tail | 400 | **399** | ok |
| truncated by 1,500 B | 400 | **399** | ok |
| 2,048 B garbage mid-WAL | 400 | **199** | ok |
| `-wal` deleted entirely | 400 | **table gone** | ok |

That last row is the **new, lethal operational hazard** and it belongs in the contract in bold: the
`-wal` sidecar holds everything since the last checkpoint, so **copying `umbradb.db` without
`umbradb.db-wal` silently restores a database from an arbitrarily old point** — here, from *before
the CREATE TABLE*. Postgres has no comparable single-file footgun.

### B7 — Backup/restore (CONTRACT §6) must be rewritten, but the *properties* survive. **Closeable.**

`pg_dump --format=custom`, `pg_restore`, physical backup and PITR all go away. Measured
replacements:

- **`VACUUM INTO '<path>'` is a faithful `pg_dump --single-snapshot`.** It runs from a read snapshot,
  so it works *while another connection holds an open write transaction* and **does not see that
  connection's uncommitted rows** (measured: copy row count 20,000 = source committed count 20,000
  while a second connection held an uncommitted insert). It also ran to completion against an
  external process committing 2,025 transactions during the window. **Both of CONTRACT §6's stated
  properties therefore hold verbatim**: the schema is captured as one consistent unit so no manifest
  can reference a chunk that is missing, and a mid-GC snapshot is internally consistent.
- **It cannot run from inside a transaction** (measured: `cannot VACUUM from within a transaction`) —
  a small but real constraint on where the call site can live.
- **`node:sqlite` also exposes an async, rate-limited `backup()`** (measured, 3,156 pages). The
  online backup API **restarts if the source is written during the copy**, which on a ~1 GB/hour
  ingest makes it a poor fit for the archive; `VACUUM INTO` is the right primitive.
- **The cost L5 owns, stated so they can measure it:** a long `VACUUM INTO` holds a read snapshot,
  and a held snapshot **completely blocks WAL checkpointing**. Measured: with one reader open,
  four 16 MB write bursts grew the WAL 17.5 → 35.0 → 52.6 → **70.1 MB** while
  `wal_checkpoint(PASSIVE)` returned `{busy: 0, checkpointed: 0}` each time — note `busy: 0`, i.e.
  **it reports success while doing nothing**, a silent failure mode for anyone monitoring it. On a
  300 GB archive at 80 MB/s the backup takes ~1 h and the WAL grows by roughly a full hour of ingest
  (~1 GB) that cannot be reclaimed until it finishes.
- **What replaces PITR:** nothing equivalent. A WAL-set filesystem snapshot (LVM/ZFS/btrfs of `.db`
  + `-wal` + `-shm` atomically) is the closest, and it is a *deployer* capability, not a UmbraDB
  one. `.dump` (text SQL) works but is O(size) and much slower; it is a disaster-recovery format,
  not an operational one.
- **What is genuinely new and better:** `PRAGMA integrity_check` — a whole-database structural
  verification Postgres has no counterpart for. Measured at **~580–690 MB/s** on cached data
  (5,000 → 200,000 rows: 5 ms / 34 ms / 160 ms), so a 300 GB archive is a tens-of-minutes offline
  verification. `quick_check` is ~3x faster and skips index-consistency. **Caveat that must be
  written down:** `integrity_check` verifies b-tree *structure*, not cell content — I flipped one
  byte at 60% into a database and it reported `ok`. UmbraDB's own content-addressed SHA-256
  re-verify (`CHUNK_INTEGRITY`) is the complement, and the two together are strictly stronger than
  what Postgres offers today. **Frozen commitment touched: G4 contract 6** (rewritten, not broken).

### B8 — Security posture (CONTRACT §7 / `SECURITY.md`). **Net simpler, one real regression.**

Improves on four axes: no network listener, no DB roles, no `search_path`/schema-as-not-a-boundary
confusion (T-A1/T-A2 collapse into "the process that owns the file"), and the entire
transaction-pooler class of misconfiguration disappears. `node:sqlite` additionally exposes
`enableDefensive()` and `setAuthorizer()` (both in the enumerated prototype, §3.7) — real
hardening primitives with no Postgres analogue in this codebase.

**The one genuine regression** is in `SECURITY.md:117-127`. The binding at-rest precondition today
offers the deployer a menu: "encrypt the disk/volume backing Postgres, **use Postgres transparent
data encryption (TDE)**, and encrypt every backup and replica." **SQLite has no built-in
encryption** — SEE is a commercial licence and SQLCipher is a fork, neither available through
`node:sqlite`. So the TDE option must be struck, leaving **filesystem/volume encryption as the only
mitigation available without writing code**, which narrows a documented menu to one item. The
`CheckpointStore.save`-ciphertext path (`SECURITY.md:134-140`) is unaffected and the `EnvelopeCipher`
1.1 seam becomes *more* important, not less. Two additions the file needs: (a) **file permissions
are now the access-control mechanism** — the `.db`, `-wal` and `-shm` sidecars must all be `0600`
and the *directory* must be writable (SQLite needs to create the sidecars, so a read-only directory
breaks writes even on a writable file); (b) the cross-wallet dedup oracle of `SECURITY.md:57-105` is
**unchanged in kind but easier to run**, because a local attacker who can time `save()` no longer
needs to be a database client at all — they need only read the file's mtime/size. The
single-trust-domain requirement that already bounds it still bounds it.

### B9 — `DEFAULT_SCHEMA` / schema-configurability. **Flagged, owned by L2.**

`CREATE SCHEMA` + `search_path` (`migrate.ts:236`, `migrations/000_schema.ts`) have no SQLite
equivalent; `ATTACH` is the nearest. `DEFAULT_SCHEMA` and schema-configurability are named in the
brief as part of the **G1 frozen public API surface**, and `assertValidSchemaName` is part of the
validation path this lane's `ValidationError` route depends on (`migrate.ts:122-129`). Whatever L2
chooses, note that `to_regclass(<schema>._migrations)` (`migrate.ts:240-242`) has a clean analogue —
measured: `select count(*) from sqlite_schema where type='table' and name = ?` returns 0 on a cold
database without erroring, exactly matching `to_regclass`'s NULL-not-error behaviour.

**Hard ceiling for L2, measured while checking the coordinator's relay:** if L2 implements schemas
via `ATTACH`, the limit is **10 attached databases plus `main`**. Attaches 1–10 succeed; the **11th**
fails with `SQLITE_ERROR` (errcode 1) and message `too many attached databases - max 10` (§3.13).
`DEFAULT_SCHEMA` plus 10 configured schemas is the entire budget, and the failure is a generic
errcode 1 — indistinguishable by code from a syntax error, so it must be caught by message. That is
a **new, hard, previously-unstated bound on a G1 surface feature** (schema-configurability is named
in the brief as part of the frozen public API). Postgres has no comparable limit.

### B10 — `node:sqlite` is an *experimental* API on UmbraDB's declared minimum runtime. **Not closeable by UmbraDB; it is a posture decision.**

Raised by the coordinator; I verified the checkable parts and agree with the substance, with two
corrections and one addition.

**Verified here:** `package.json:31-33` declares `"engines": { "node": ">=24" }`. On this host
(`node v24.18.0`) `require("node:sqlite")` works with **no `--experimental-sqlite` flag and emits no
`ExperimentalWarning` at all** — I registered a `process.on("warning")` handler and the process
printed only the SQLite version (§3.13). **The experimental status is therefore completely silent at
runtime**, which is worse than a noisy one: nothing in a build, a test run, or a production log will
ever tell an operator that the storage engine is an experimental platform API. The stability-index
claim itself (1.2 RC as of v25.7.0; "no longer behind the flag but still experimental" from
v22.13/v23.4) is the coordinator's citation, not my measurement, and I record it as such.

**This is the sharpest contract problem in my lane after B1, and it is worse than B1** because B1
breaks one written clause while this undermines the *frame* in which all eight are written. A 1.0.0
library making a binding SemVer promise (`docs/STABILITY.md:18-25`) cannot honestly rest its entire
storage engine on an API whose own platform reserves the right to change it in a minor release —
which is precisely what Node's stability index means at both Experimental and Release Candidate.

**On (1) — the `engines` floor.** I would raise it, and I would not pretend that is cheap.
Node >=25.7 in a `1.0.0` release means: no Node 24 LTS (24 is the active LTS line; 25 is the odd,
non-LTS current line), so **the floor would be a non-LTS runtime** — which for a library aimed at
wallet clients is a harder sell than the RC status it buys. Three postures, and I recommend the
third:
  - **(a) Keep `>=24`, document the experimental status in `STABILITY.md`.** Cheapest, and dishonest
    by omission unless the doc is blunt. If taken, `STABILITY.md` must gain a section stating in
    terms that *the storage engine is an experimental platform API on the minimum supported runtime,
    that this is invisible at runtime, and that a Node minor could break the frozen surface*.
  - **(b) Raise to `>=25.7`.** Buys RC, costs LTS. Raising an `engines` floor is a **breaking change**
    (it removes runtimes the package claims to support) and is therefore free before the 1.0.0 tag
    and a major after it — the same clock as B5. Worth 0.5 d of work and a real product argument.
  - **(c) Recommended: raise the floor to the first Node version where `node:sqlite` is at least RC
    *and* which is on an LTS line, and if none exists at tag time, hold the SQLite backend behind an
    explicitly-labelled pre-1.0 boundary rather than shipping it inside the frozen surface.** UmbraDB
    already has the vocabulary for this: the chain-archive track is `@experimental`/`@internal`, not
    re-exported from the barrel, and explicitly outside the frozen catalog
    (`docs/ERROR-CATALOG.md:139-147`). The same device applies. It is unattractive because the whole
    point of this sprint is full replacement — but it is the only posture that lets 1.0.0 mean what
    it says.

**On (2) — I agree, and the "zero runtime dependencies" framing is doubly wrong.** First, factually:
`package.json` declares **two** runtime dependencies, `postgres@^3.4.9` **and `zod@^4.0.0`**
(verified). Zod is load-bearing for `VALIDATION_FAILED` at every module boundary and is not going
anywhere. So the win is "one runtime dependency instead of two", not zero. Second, and more
importantly, **the risk does not disappear; it changes shape into a form the existing supply-chain
machinery cannot see.** `postgres@^3.4.9` is pinned in `package-lock.json`, hashed in
`docs/supply-chain/inventory.md`, and gated by `supply-chain.yml`. A built-in is **unpinnable**: the
SQLite version is whatever the Node release bundles (3.53.1 here — I flagged this independently at
§5.6 before the relay arrived), the API shape is whatever that Node release ships, and **neither
appears in the lockfile, the inventory, or the gate**. So the trade is: fewer entries in the
inventory, in exchange for a dependency that is *invisible to every mechanism the project built to
watch its dependencies*. For a project whose supply-chain posture is one of its selling points that
is a real regression, and `docs/supply-chain/inventory.md` would need a new "platform-provided,
unpinnable" section naming both the module and the bundled SQLite version, with the CI job asserting
the runtime's `sqlite_version()` matches the recorded one — otherwise a Node patch upgrade silently
changes the storage engine under a frozen contract.

**On (3) — the `better-sqlite3` trade, which is mine to state since I own `SECURITY.md` and
`supply-chain.yml`.** Taking L3's refutation as given (no install scripts, ships prebuilds, so
`ignore-scripts=true` survives), the comparison is:

| | `node:sqlite` | `better-sqlite3` |
|---|---|---|
| API stability | Experimental on `>=24`, RC at 25.7; **silent** | ordinary npm SemVer; pinnable in the lockfile |
| SQLite version | whatever Node bundles; **unpinnable, invisible to the gate** | pinned, hashed, in the inventory |
| Supply-chain surface | zero new npm entries | +1 direct dep, +prebuilt **native binaries** |
| Prebuilt-binary risk | none | real: a prebuild is an opaque artifact that `gitleaks`/`npm audit` do not inspect; provenance rests on the publisher |
| Cancellation (B1) | no `interrupt()` | also synchronous; no better |
| `engines` floor | forces `>=25.7` for RC | none |

My read: **the supply-chain story is roughly a wash and the stability story favours
`better-sqlite3`.** Trading "one auditable, pinned, hashed npm package containing a native prebuild"
for "an unpinnable platform API at experimental status that no gate can observe" is not obviously a
win, and the current framing treats it as one. Neither option fixes B1. **This is L3's call to make,
but it should be made against this table rather than against a dependency count**, and whichever way
it goes, `docs/supply-chain/inventory.md` and `SECURITY.md` need a paragraph that does not exist
today. I do not think this changes the sprint's overall verdict; I do think it changes what
"1.0.0" is allowed to claim.

---

## 3. Evidence

Scripts live in `/root/l6-exp*.mjs` (throwaway). **Environment caveat found and corrected mid-run:
`/tmp` on this host is `tmpfs`, so every durability number measured there would have been
meaningless** (`fsync` on tmpfs is a 4 µs no-op). All durability figures below were re-run on
`/root/l6-bench` (ext4).

### 3.1 `ALTER TABLE` capability matrix (isolated database per case)

```
$ wsl -e bash -lc 'node /tmp/l6-exp2-alter-isolated.mjs'
sqlite: 3.53.1
OK    [0 rows] ADD COLUMN ... STORED | []
FAIL  [1 rows] ADD COLUMN ... STORED -> cannot add a STORED column
FAIL  [3 rows] ADD COLUMN ... STORED -> cannot add a STORED column
OK    [3 rows] ADD COLUMN ... VIRTUAL | [{"size_bytes":4},{"size_bytes":5},{"size_bytes":6}]
OK    [3 rows] ALTER COLUMN data SET NOT NULL
OK    [3 rows] ALTER COLUMN data DROP NOT NULL
         schema: CREATE TABLE ckpt_chunks (hash blob primary key not null, data blob)
FAIL  [3 rows] ADD CONSTRAINT hashlen CHECK (length(hash)=32) [violating data] -> constraint failed
OK    [3 rows] ADD CONSTRAINT hashlen CHECK (length(hash)=1) [satisfied]
FAIL  [3 rows] DROP CONSTRAINT (nonexistent) -> no such constraint: nope
OK    [3 rows] ADD then DROP CONSTRAINT
FAIL  [3 rows] ADD COLUMN u integer UNIQUE -> Cannot add a UNIQUE column
OK    [3 rows] ADD COLUMN nn integer NOT NULL DEFAULT 0
OK    [3 rows] DROP COLUMN data
```

Note the `ADD CONSTRAINT` line: it **validated existing rows** and refused when they violated the
new CHECK. That is `ALTER TABLE … ADD CONSTRAINT … NOT VALID`'s *opposite* and is safer than
Postgres's default. Transactional DDL confirmed separately (`BEGIN; CREATE TABLE; ROLLBACK` →
table absent). Cited target: `src/postgres/migrations/006_ckpt_chunks_size_bytes.ts:16-19`.

### 3.2 `ALTER TABLE` cost on 200,000 rows, and the rebuild floor

```
$ wsl -e bash -lc 'node /tmp/l6-exp3-alter-cost.mjs'
table: 200000 rows x 200B payload + 32B hash pk + secondary index; built, db size 125.9 MB
  ALTER TABLE ADD COLUMN plain (int default 0)      0.3 ms
  ALTER TABLE ADD COLUMN GENERATED ... VIRTUAL      0.1 ms
  ALTER TABLE ADD COLUMN GENERATED ... STORED       FAIL cannot add a STORED column
  ALTER TABLE ALTER COLUMN refcount DROP NOT NULL   0.1 ms
  ALTER TABLE ALTER COLUMN refcount SET NOT NULL    0.1 ms
  ALTER TABLE ADD CONSTRAINT hashlen CHECK(len=32)  7.2 ms
  ALTER TABLE DROP CONSTRAINT hashlen               0.1 ms
  ALTER TABLE DROP COLUMN c1                       86.2 ms
  ALTER TABLE RENAME COLUMN refcount->rc            0.5 ms
```

```
$ wsl -e bash -lc 'node /root/l6-exp14-rebuild.mjs 4096'
building ~4096 MB (1000000 rows x 4096B) on ext4 ...
  built in 34.7s, db=4728 MB (136 MB/s ingest)
-- 12-step table rebuild (add a STORED generated column, which ALTER TABLE cannot do) --
  rebuild of 4096 MB: 50.9 s  => 80 MB/s
  db+wal after rebuild (peak footprint): 14164 MB  (logical data 4096 MB)
  extrapolated to 300 GB: 1.0 hours, needs >= 600 GB free disk, ...
```

The script's own extrapolation line prints the naive 2x; **the measured ratio is 3.5x**
(14,164 / 4,096) and the table in §2 B4 uses the measured ratio. *What would have to be true for
this to be a meaningful floor:* the 4 GB working set largely fit in this host's page cache, so the
80 MB/s is optimistic for a cold 300 GB archive; treat it as a lower bound on time and an accurate
figure for space.

### 3.3 Durability: `PRAGMA synchronous` throughput (3 reps, alternating order)

```
$ wsl -e bash -lc 'cd /root && node l6-exp4b-durability.mjs'
payload=4096B n=1500 reps=3 (order alternated)
  WAL/FULL       median     523 commits/s   runs=[618, 489, 523]
  WAL/NORMAL     median   14229 commits/s   runs=[14229, 11416, 14626]
  WAL/EXTRA      median     584 commits/s   runs=[629, 544, 584]
  WAL/OFF        median   41614 commits/s   runs=[41614, 38918, 43896]
  DELETE/FULL    median     165 commits/s   runs=[167, 146, 165]

  raw fs.fsyncSync latency on /root/l6-bench: 2506 us/call (200 calls, 4KB writes)
```

The unit of work is one **co-transactional** `BEGIN IMMEDIATE; insert chunk; upsert cursor; COMMIT`
— i.e. the `saveAndAdvance` shape. `WAL/FULL` at 523/s against a 2.5 ms raw `fsync` is ~1 fsync per
commit and is internally consistent. **A first run with a different ordering reported WAL/EXTRA as
3.67x *faster* than WAL/FULL, which is backwards** (EXTRA is strictly stricter); re-running with
alternating order and three reps showed 523 vs 584, i.e. indistinguishable — in WAL mode EXTRA adds
only a directory sync on journal deletion, which WAL mode does not do. The first run was
first-iteration/cold-file noise. Recorded because trap 8 says to say so.

### 3.4 Filesystem honesty probe — can we detect a lying `fsync`?

```
$ wsl -e bash -lc 'cd /root && node l6-exp5-fsprobe.mjs /tmp/l6fs /root/l6-bench /dev/shm/l6fs /mnt/c/Users/charl/l6fs'
/tmp/l6fs               fstype=tmpfs      fsync=     4 us  journal_mode->wal  WAL/FULL= 42130 c/s
/root/l6-bench          fstype=ext2/ext3  fsync=  2360 us  journal_mode->wal  WAL/FULL=   411 c/s
/dev/shm/l6fs           fstype=tmpfs      fsync=     3 us  journal_mode->wal  WAL/FULL= 51607 c/s
/mnt/c/Users/charl/l6fs fstype=v9fs       fsync=  1554 us  journal_mode->wal  WAL/FULL=   168 c/s
```

**Three orders of magnitude** separate a real barrier from a no-op, so a timing calibration is a
usable *heuristic* — exactly the same "best-effort detector, not a guarantee" character the existing
pooler probe already documents for itself (`durability-probe.ts:120-135`). Two harder signals are
also available and are not heuristics: `statfs` f_type (tmpfs, v9fs, NFS, CIFS are all identifiable)
and `PRAGMA journal_mode` readback. **Note the hazard in row 4:** SQLite happily entered WAL mode on
a 9p/`drvfs` mount, where WAL's shared-memory index is not safe. SQLite refuses WAL on filesystems
it recognises as networked; it does not recognise this one. A probe that checks the filesystem type
would catch it.

### 3.5 Crash semantics: SIGKILL mid-write, with a working negative control

```
$ wsl -e bash -lc 'cd /root && node l6-exp11-crash.mjs'
  synchronous=FULL   mode=cotx   killed@150ms  ... maxManifestSeq=52    cursor=52    cursor<=data: HOLDS
  synchronous=FULL   mode=cotx   killed@400ms  ... maxManifestSeq=157   cursor=157   cursor<=data: HOLDS
  synchronous=FULL   mode=cotx   killed@900ms  ... maxManifestSeq=435   cursor=435   cursor<=data: HOLDS
  synchronous=FULL   mode=twotx  killed@150ms  ... maxManifestSeq=30    cursor=31    *** VIOLATED (ahead by 1) ***
  synchronous=NORMAL mode=cotx   killed@{150,400,900}ms                              cursor<=data: HOLDS x3
  synchronous=OFF    mode=cotx   killed@{150,400,900}ms                              cursor<=data: HOLDS x3
  synchronous=OFF    mode=twotx  killed@400ms  ... maxManifestSeq=12235 cursor=12236 *** VIOLATED ***
  synchronous=OFF    mode=twotx  killed@900ms  ... maxManifestSeq=27360 cursor=27361 *** VIOLATED ***

  co-transactional (saveAndAdvance shape): invariant held 9/9
  cursor-first two-transaction (the forbidden shape): invariant VIOLATED 4/9
```

`integrity_check = ok` on all 18 recoveries. The invariant under test is verbatim
`docs/CONTRACT.md:10-18` / `docs/checkpoint-store-contract.md:18` — "the durable cursor MUST NOT
reference checkpoint data that is not itself durable." **The second line is the negative control:
the forbidden cursor-first ordering violated the invariant in 4 of 9 runs, so the harness genuinely
detects the failure it is looking for.** Without it, 9/9 would prove nothing.

**Scope limit, stated plainly:** SIGKILL is a *process* crash, not a power loss. It therefore
exercises exactly the guarantee `synchronous=NORMAL` *does* make and says nothing about the one it
does not. The NORMAL and OFF rows above must **not** be read as "NORMAL is as safe as FULL under
power loss" — they are not evidence about power loss at all, and I have no way to produce such
evidence on this host. This is the single most important caveat in my lane and it is why B6 relies
on the WAL-damage experiment (§3.9) rather than on these rows.

### 3.6 Error surface: `errcode` is a real SQLSTATE analogue

```
$ wsl -e bash -lc 'cd /root && node l6-exp8-errors.mjs'
  UNIQUE violation           code="ERR_SQLITE_ERROR" errcode=2067 errstr="constraint failed" message="UNIQUE constraint failed: ck.h"
  PRIMARYKEY violation       code="ERR_SQLITE_ERROR" errcode=1555 ...
  NOT NULL violation         code="ERR_SQLITE_ERROR" errcode=1299 ...
  CHECK violation            code="ERR_SQLITE_ERROR" errcode= 275 ... message="CHECK constraint failed: length(h)=32"
  FOREIGN KEY violation      code="ERR_SQLITE_ERROR" errcode= 787 ...
  RAISE(ABORT) from trigger  code="ERR_SQLITE_ERROR" errcode=1811 ... message="UB001: same-transaction key reuse"
  BUSY (2nd writer)          errcode=5  "database is locked"
  open readonly then write   errcode=8  "attempt to write a readonly database"
  open nonexistent           errcode=14 "unable to open database file"
  open a directory           errcode=14 "unable to open database file"
  open a non-database file   errcode=26 "file is not a database"
  fill a 1MB filesystem      errcode=13 "database or disk is full"
  read a page-corrupted db   errcode=11 "database disk image is malformed"
  no such table / syntax err errcode=1  "SQL logic error"
  strict-table type mismatch errcode=3091 "cannot store TEXT value in INTEGER column s.a"
```

`err.errcode` is the **extended** result code, which is finer-grained than a SQLSTATE class — 2067
`CONSTRAINT_UNIQUE` vs 1555 `CONSTRAINT_PRIMARYKEY` vs 1811 `CONSTRAINT_TRIGGER` are all
distinguishable. `err.code` is always the Node-level `"ERR_SQLITE_ERROR"` and is **not** usable as a
discriminant, which matters because `isPgDriverError` (`src/postgres/errors.ts:168-173`) currently
duck-types on `.code` + `.severity`; the SQLite equivalent must duck-type on
`typeof err.errcode === "number"`. Note `errcode=1811` for the trigger raise **with the message
fully caller-controlled** — that is the `UB001` replacement (**L1** owns the mechanism).

### 3.7 Cancellation and timeouts

```
$ wsl -e bash -lc 'cd /root && node l6-exp13-cancel.mjs'
StatementSync proto: iterate, all, get, run, columns, setAllowBareNamedParameters,
                     setAllowUnknownNamedParameters, setReadBigInts, setReturnArrays, constructor
has interrupt(): undefined
matching /interrupt|progress|cancel|busy/ on DatabaseSync.prototype: []

slow query took 36 ms; abort listener fired DURING it? false
after the sync call returns, aborted=false
after one event-loop turn, aborted=true   <-- the abort could only ever land here

UDF guard: statement aborted after 1001 rows in 30 ms -> UMBRADB_CANCELLED (code=undefined errcode=undefined)
busy_timeout=350ms: second writer failed after 352 ms with errcode=5 "database is locked"
```

Full `DatabaseSync.prototype`: `open, close, prepare, exec, function, createTagStore, location,
aggregate, createSession, applyChangeset, enableLoadExtension, enableDefensive, loadExtension,
serialize, deserialize, setAuthorizer`. No `interrupt`. Contract cited:
`docs/CONTRACT.md:53-70`; timeouts cited: `docs/durability-contract.md:94-111`.

### 3.8 Backup

```
$ wsl -e bash -lc 'cd /root && node l6-exp6-backup.mjs'
node:sqlite exports: DatabaseSync, Session, StatementSync, backup, constants, default
source size: 11.7 MB
OK   VACUUM INTO (idle): 11.7 MB
FAIL VACUUM INTO with own open write tx: cannot VACUUM from within a transaction
OK   VACUUM INTO on A while B holds an open write tx (WAL reader snapshot)
     copy row count: 20000 | source committed count: 20000
OK   VACUUM INTO concurrent with an external writer (42 ms)
     concurrent writer committed 2025 txs during the backup window
OK   node:sqlite backup() -> 3156 pages
```

### 3.9 WAL damage and WAL growth under a held snapshot

```
$ wsl -e bash -lc 'cd /root && node l6-exp12b-torn.mjs'
  control: undamaged WAL              committed={"n":400,"m":400} -> recovered={"n":400,"m":400} integrity=ok
  garbage over last 400B of the WAL   committed={"n":400,"m":400} -> recovered={"n":399,"m":399} integrity=ok
  WAL truncated by 1500B              committed={"n":400,"m":400} -> recovered={"n":399,"m":399} integrity=ok
  garbage 2048B in the MIDDLE         committed={"n":400,"m":400} -> recovered={"n":199,"m":199} integrity=ok
  WAL deleted entirely                committed={"n":400,"m":400} -> recovered="ERR no such table: t" integrity=ok

  baseline after checkpoint(TRUNCATE): wal=0.0 MB, main=17.4 MB
  burst 1 (16 MB) with reader open: wal=  17.5 MB  checkpoint(PASSIVE)={"busy":0,"log":4252,"checkpointed":0}
  burst 2 (16 MB) with reader open: wal=  35.0 MB  checkpoint(PASSIVE)={"busy":0,"log":8506,"checkpointed":0}
  burst 3 (16 MB) with reader open: wal=  52.6 MB  checkpoint(PASSIVE)={"busy":0,"log":12760,"checkpointed":0}
  burst 4 (16 MB) with reader open: wal=  70.1 MB  checkpoint(PASSIVE)={"busy":0,"log":17015,"checkpointed":0}
  reader closed -> checkpoint(TRUNCATE)={"busy":0,"log":0,"checkpointed":0}  wal=0.0 MB
```

### 3.10 Integrity checking

```
$ wsl -e bash -lc 'cd /root && node l6-exp7-integrity.mjs'
== healthy DB ==                       integrity_check=[{"integrity_check":"ok"}]  4.4 ms
== truncated to 80% ==                 ERR database disk image is malformed
== truncated by 1234 bytes (torn) ==   "*** in database main *** Tree 2 page 569 cell 1: Rowid 0 out of order ..."
== one byte flipped at 60% offset ==   integrity_check=[{"integrity_check":"ok"}]   <-- NOT detected
== header magic clobbered ==           ERR file is not a database
   rows=   5000 size=  2.3MB integrity_check=    5ms quick_check=   1ms  => 486 MB/s
   rows=  50000 size= 23.3MB integrity_check=   34ms quick_check=  16ms  => 686 MB/s
   rows= 200000 size= 93.4MB integrity_check=  160ms quick_check=  55ms  => 583 MB/s
```

### 3.11 Verification-infrastructure cost

```
$ wsl -e bash -lc 'bash /root/l6-exp9-testcost.sh'
== docker: cold-start a postgres:17-alpine container to accepting-connections ==
  run 1: 3271 ms to ready
  run 2: 2596 ms to ready
  run 3: 2513 ms to ready
```
(image already cached; the wait condition is testcontainers' own — the "ready to accept connections"
log line seen twice. `test/postgres/setup.ts:26` uses exactly `postgres:17-alpine`, and
`setup.ts:41` budgets 120 s for `beforeAll`.)

```
$ wsl -e bash -lc 'cd /root && node l6-exp10-fixture.mjs'
== SQLite fixture cost: fresh, fully-migrated database ==
  in-memory: open + full migration lineage                     0.290 ms each
  temp file on ext4: open + WAL + synchronous=FULL + lineage   52.795 ms each
  per-test reset: delete from 10 tables in one tx              0.021 ms each
  (migrated empty DB serializes to 77824 bytes)
  restore a pre-migrated snapshot via deserialize()            0.011 ms each
```

The DDL used is a SQLite transliteration of `migrations/000`–`006`. Against the recorded CI budgets
(`.github/workflows/conformance.yml:30` — "measured wall-clock for the whole deterministic set is
~100s on a 24-core host"; `conformance.yml:85` — the mutation gate is "~1,384s (~23 min) … per-adapter
… so every adapter reuses ONE Testcontainers Postgres … versus the single interleaved `stryker run`
that churns a container per file switch and is slower/unbounded"), **the mutation gate's entire
architecture is a workaround for container startup cost.** At 0.011 ms per pre-migrated snapshot
restore, a per-mutant fresh database is free and the per-adapter split, the aggregate-vs-per-file
threshold compromise, and the 45-minute timeout all become unnecessary.

**What loses fidelity — be careful here.** An in-memory database is *not* the same as a file-backed
one, and my own §3.5 crash results depend on that difference: WAL recovery, `-wal` sidecar
semantics, `wal_checkpoint`, `VACUUM INTO`, `integrity_check` on a damaged file, `SQLITE_FULL`, and
`SQLITE_BUSY` between processes are all **only** observable file-backed. The correct split is
in-memory for the algebra (P1–P10, unit, mutation) and a temp *file* for the recovery/crash suite —
and at 52.8 ms even the file path is ~50x cheaper than a container.

### 3.12 What ports unchanged

- `test/api-surface/error-catalog-drift.test.ts` — reads `docs/ERROR-CATALOG.md` and reflects over
  the barrel. **Zero Postgres dependency. Ports byte-for-byte.**
- The four import guards (`no-sdk-import-guard`, `no-chain-sync-import-guard`,
  `no-consumer-import-in-bench`, `save-and-advance-import-guard`) — all pure source-text scans.
  **Port byte-for-byte.** `save-and-advance-import-guard` even keeps its meaning: it asserts
  `save-and-advance.ts` composes only in-repo primitives.
- The `fast-check` P1–P10 property tests — the bodies are written against the **interfaces**
  (`PgTemporalKV`, `VersionConflictError`), with the only engine-specific concession being the
  `await new Promise(r => setTimeout(r, 5))` millisecond-collision guards that exist because of
  `date_trunc('milliseconds', clock_timestamp())`. Change the temporal mechanism (L1) and those
  sleeps change or vanish; the properties themselves do not. **This is a genuine signal that the
  abstraction is clean** — but see §3.14 for why it is a weaker signal than it looks.
- `pack-smoke.yml` and `supply-chain.yml` are engine-agnostic; `supply-chain` gets *smaller*
  (`postgres`, `@testcontainers/postgresql` and their trees leave `docs/supply-chain/inventory.md`).
- **What does not port:** everything in `test/postgres/setup.ts:51-574` — the entire crash-harness
  fault-primitive layer. `pg_terminate_backend`, `waitForBackendGone`, `pg_stat_activity` polling,
  and `container.restart()` all vanish. Primitive 1 (SIGKILL of a spawned writer) survives and is
  the *only* one that does; my §3.5 harness is essentially that primitive, rebuilt. A file-level
  fault-injection VFS would be needed to replace primitives 2 and 3, and `node:sqlite` exposes no
  VFS hook — this is the largest single piece of test infrastructure the migration destroys.

### 3.13 Platform-dependency facts (verifying the coordinator's relay)

```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-l6-contracts && grep -n "\"engines\"" -A4 package.json'
31:  "engines": {
32-    "node": ">=24"
33-  },
--- dependencies ---
  "dependencies": { "postgres": "^3.4.9", "zod": "^4.0.0" }

$ node -e 'process.on("warning",w=>console.log("WARNING:",w.name,w.message));
           const s=require("node:sqlite"); const d=new s.DatabaseSync(":memory:");
           console.log("opened ok, version", d.prepare("select sqlite_version() v").get().v);'
opened ok, version 3.53.1
exit=0
```

**No `ExperimentalWarning` is emitted** on v24.18.0 — the handler was registered and fired for
nothing. The experimental status is silent.

```
$ node -e '... attach 12 databases in a loop ...'
attach 1..10 OK
attach 11 FAIL errcode=1 too many attached databases - max 10
database_list length: 11
```

**Correction to the relay:** the failure is at the **11th** `ATTACH`, not the 10th — ten attached
databases plus `main` succeed. The error is a generic `SQLITE_ERROR` (errcode **1**), the same code
as a syntax error or a missing table (§3.6), so it is only distinguishable by message text.

### 3.14 The formal refinement

`Formal/FORMALIZATION_ROADMAP.md:24` is unambiguous: *"No theorem relates any Lean definition to SQL
DDL, a trigger, `clock_timestamp()`, `Finmap`→rows, or the TS adapter."* So the literal answer is
**changing the concrete store invalidates exactly zero Lean lines**, and the `lean.yml` gate stays
green without a single edit.

**That portability is not a virtue; it is the measurement.** The Lean layer proves T3, T5, W1 and C1
about an *abstract* store. It would remain equally green if the concrete store were replaced with a
JSON file, a spreadsheet, or a store that lost data on every third write. Trap 9 says a green gate
certifies depth, never breadth — here the gate certifies depth about a model that was never
connected to the artifact, so its greenness across an engine swap is *evidence of the disconnection*,
not evidence of portability. `FORMALIZATION_ROADMAP.md:5` says this itself: *"0-sorry means fully
proved but narrow."*

Where the work actually lives is `openspec/changes/v1.1.0-formal-completion/design.md:50`, which
defines the refinement register as a row of
`{abstract-theorem, trusted-mechanism, (b)-hypothesis-or-(c)-test, voiding-precondition}`. **Column
1 is unchanged by this migration. Columns 2, 3 and 4 are replaced wholesale.** Concretely, of the
five mechanism-level obligations that roadmap names (`FORMALIZATION_ROADMAP.md:52` — "T5(2) trigger
discipline, C2a same-tx visibility, L1 pinning, T4 clock, W1 JSON"):

- **T5(2) trigger discipline** — the trusted mechanism is today the GiST `EXCLUDE` plus the
  `BEFORE UPDATE` trigger as sole `valid_from` writer. Both are gone. New mechanism = L1's choice.
- **T4 clock** — `clock_timestamp()` vs `now()` is the whole obligation, and SQLite has no such
  distinction. The obligation does not merely change mechanism; **its statement changes.**
- **C2a same-tx reachability visibility** — today rests on Postgres read-committed visibility of
  uncommitted same-transaction writes. SQLite gives the *same* property (a connection sees its own
  uncommitted writes) and, being single-writer, gives it more simply. This obligation gets
  **easier**.
- **L1 lease pinning** — the trusted mechanism is a session-scoped advisory lock on a reserved
  connection. Replaced entirely (L2's territory). The "voiding precondition" changes from
  "a transaction pooler" to "a second process, a network filesystem, or a `-shm` on a filesystem
  without working shared memory."
- **W1 JSON losslessness** — `jsonb` normalizes (key reorder, whitespace, duplicate-key
  elimination); SQLite `TEXT`/`BLOB` does not, and `JSONB` in SQLite is a different, private
  encoding. This obligation **also gets easier** if UmbraDB stores raw bytes.

**What a reviewer is owed** to believe SQLite refines the same abstract model — and this is the
deliverable I would put on the critical path, because without it the migration silently downgrades
the honesty of the whole formal story:
1. A **rewritten refinement register**, row by row, with the old mechanism struck and the new one
   named — not a note saying "Lean unaffected."
2. **P1–P10 re-run against the new engine**, since option (c) (conformance-as-refinement) is the
   *entire* bridge and it is engine-specific by construction.
3. **New conformance properties for the obligations SQLite creates that Postgres never had.** At
   minimum: **P11** — `journal_mode` is `wal` and `synchronous` ≥ 1 at every commit that the
   durability contract covers (the pragma is persistent in the file and can be changed out from
   under us); **P12** — after an induced crash, `integrity_check` is `ok` and the cursor is not
   ahead of the data (my §3.5 harness, generalised); **P13** — a `VACUUM INTO` copy taken during
   concurrent writes satisfies the manifest→chunk closure (CONTRACT §6's chunk/manifest consistency
   claim, which is currently a *documented property of `pg_dump`* and would become a *property of
   our own backup path* — it must be tested, not asserted).
4. An explicit statement that **C2a and L1 are `MECHANISM SPECIFIED, not proved`, and the mechanism
   named in that specification no longer exists.** Both are today discharged only by P8 and P10 at
   runtime. When the mechanism changes and the tests are ported, the *label* is unchanged and the
   *evidence* is entirely new — a reviewer who sees "C2a: MECHANISM SPECIFIED, P8 green" after the
   migration is looking at a different claim wearing the same words. The register must say so.

---

## 4. Design sketch

### 4.1 The durability probe, rewritten

The Postgres probe asks a *server* about *deployer* settings. The SQLite probe sets what it can and
interrogates the *filesystem* about what it cannot. Contract §1's "binding Postgres precondition"
list shrinks from four deployer obligations to **one** (put the file on a local, non-networked
filesystem); the rest UmbraDB owns.

```ts
// src/sqlite/durability-probe.ts — runs as a mandatory step of runMigrations, as today
export interface DurabilityProbeOptions {
  /** Minimum acceptable synchronous level. Default "FULL" (the current contract).
   *  "NORMAL" is permitted and raises a lost-tail DurabilityWarning — the exact analogue of
   *  today's synchronous_commit=off warn-don't-refuse rule (durability-probe.ts:101). */
  minSynchronous?: "FULL" | "NORMAL";
  /** Skip the fsync-latency calibration (heuristic; a battery-backed controller is a legitimate
   *  reason it looks "too fast"). Analogue of today's allowFullPageWritesOff escape hatch. */
  allowImplausibleFsync?: boolean;
}

export async function probeDurability(db, opts): Promise<DurabilityWarning[]> {
  // 1. HARD REFUSAL — journal_mode. The fsync=off analogue: OFF/MEMORY means a crash can leave
  //    the database arbitrarily corrupted, not merely missing a tail. No override.
  const jm = db.prepare("pragma journal_mode").get().journal_mode;      // set by createClient
  if (jm === "off" || jm === "memory") throw new DurabilityContractError(...);

  // 2. HARD REFUSAL — synchronous=OFF (0). Same category. No override.
  //    WARN — synchronous=NORMAL (1) when minSynchronous is FULL: a bounded lost tail on power
  //    loss, recoverable, deliberately acceptable. Exactly classifySynchronousCommit's shape.
  const sy = db.prepare("pragma synchronous").get().synchronous;        // 0|1|2|3
  if (sy === 0) throw new DurabilityContractError(...);
  if (sy === 1 && (opts.minSynchronous ?? "FULL") === "FULL") warnings.push({ kind: "lost-tail", ... });

  // 3. HARD REFUSAL — the file is on a filesystem where SQLite's locking or WAL shared-memory
  //    is unsafe. This is the transaction-pooler detector's true successor: an environment in
  //    which the primitive we rely on silently does not work. statfs f_type, not a heuristic.
  //      REFUSE: nfs, cifs/smb, v9fs, fuse (unless allowlisted), tmpfs, ramfs
  //    (v9fs measured: SQLite entered WAL mode on it without complaint — §3.4.)

  // 4. WARN — fsync latency calibration. N=100 timed fsyncs on a scratch file in the SAME
  //    directory: < 50 us means either a battery-backed cache or a filesystem lying about
  //    durability. BEST-EFFORT, exactly as documented for the pooler probe
  //    (durability-probe.ts:73-77). Measured discriminator: 3-4 us (tmpfs) vs 2360 us (ext4).

  // 5. WARN — the .db, -wal, -shm sidecars are not mode 0600, or the directory is not writable.
}
```

**Can it verify anything meaningful about the filesystem's honesty about `fsync`? Honestly: no, not
provably.** Only a real power cut can settle that, and no in-process probe can. What it *can* do is
(a) rule out whole classes of dishonest substrate by type (tmpfs, network mounts — a hard, not
heuristic, signal) and (b) flag an implausible latency. That is strictly more than the Postgres
probe does today, which asks the server what it was *configured* to do and takes the answer on
trust. Frame it in the docs as a *detector*, never a *guarantee* — the language
`durability-probe.ts:73-77` already uses for the pooler check is the right precedent.

### 4.2 Connection setup (what `createClient` applies)

```sql
PRAGMA journal_mode   = WAL;      -- persistent in the file; set once, verified every open
PRAGMA synchronous    = FULL;     -- 523 c/s measured; NORMAL = 14229 c/s, warn-level trade
PRAGMA foreign_keys   = ON;       -- ckpt_manifest_chunks' ON DELETE CASCADE depends on it (!)
PRAGMA busy_timeout   = 30000;    -- the lock_timeout analogue; measured exact to 2 ms
PRAGMA wal_autocheckpoint = 4000; -- ~16 MB at 4 KB pages; tune with L5
PRAGMA cache_size     = -262144;  -- 256 MB
PRAGMA trusted_schema = OFF;      -- + enableDefensive() — hardening with no Pg analogue
```

`foreign_keys = ON` deserves a callout: it is **off by default in SQLite and is per-connection, not
persistent**, and `migrations/002_checkpoint_store.ts` relies on `ON DELETE CASCADE` for GC to be
able to delete a manifest at all. A connection that forgets this pragma turns GC into a silent
no-op. That belongs in a conformance property, not a comment.

### 4.3 Migration framework

`migrate.ts` survives structurally almost intact — that is a real finding. The `Migration` interface
(`migrate.ts:42-45`, `up()`-only) is unchanged; forward-only and no-downgrade (CONTRACT §2) are
unaffected; DDL is transactional (§3.1), so `withReservedTransaction` (`migrate.ts:57-67`) keeps its
meaning. Three substitutions:

```ts
// bootstrap detection: to_regclass (migrate.ts:240-242) -> sqlite_schema
//   measured: returns 0 on a cold DB without erroring, exactly matching to_regclass's NULL
const bootstrapped = db.prepare(
  `select count(*) as n from sqlite_schema where type = 'table' and name = ?`
).get("_migrations").n > 0;

// migration lock: pg_advisory_lock(1, hashtext(schema)) (migrate.ts:220) -> L2's decision.
//   Whatever it is, MIGRATION_LOCK_TIMEOUT must remain reachable. The cheapest faithful
//   substitute is `BEGIN IMMEDIATE` under busy_timeout: it is exclusive, bounded, and the
//   timeout surfaces as SQLITE_BUSY (5) — measured at 352 ms for a 350 ms bound.

// SET LOCAL lock_timeout (migrate.ts:219) -> pragma busy_timeout (connection-scoped, not
//   transaction-scoped, so it must be saved and restored rather than relying on auto-revert
//   at COMMIT. This is a real regression in the "no manual restore that could fail" argument
//   the current code makes in its own comment at migrate.ts:200-206.)
```

Add one **new** rule to the framework, enforced by a test, per B4: *a migration in the chain-archive
lineage may not rebuild a table.* And one new capability worth having: run `PRAGMA integrity_check`
(or `quick_check`, ~3x faster) **after** a rebuild migration commits, since we now have a whole-store
verification primitive and a rebuild is exactly when you want it.

### 4.4 Error translation

`translateSqliteError(err, keyContext)` mirrors `translatePostgresError`
(`src/postgres/errors.ts:250-309`) one-for-one:

```ts
function isSqliteError(e): e is SqliteError { return e instanceof Error && typeof e.errcode === "number"; }
// NOT `.code` — that is always the Node-level "ERR_SQLITE_ERROR" (§3.6).
// Keep the StorageError passthrough at the top (errors.ts:264) unchanged — same reasoning applies.

switch (err.errcode) {
  case 1811: // SQLITE_CONSTRAINT_TRIGGER  <- the UB001 successor; disambiguate by message sentinel
    return err.message.startsWith("UB001:") && keyContext
      ? new TransactionKeyReuseError(...) : new ExclusionViolationError(...);
  case  275: // SQLITE_CONSTRAINT_CHECK    <- the 23514 successor; route by CHECK name in message
    return routeCheckViolation(err);                  // ClockRegression / chain-archive family
  case 2067: // SQLITE_CONSTRAINT_UNIQUE
  case 1555: // SQLITE_CONSTRAINT_PRIMARYKEY
  case 1299: // SQLITE_CONSTRAINT_NOTNULL
  case  787: // SQLITE_CONSTRAINT_FOREIGNKEY
  case    5: // SQLITE_BUSY                <- LEASE_TIMEOUT / MIGRATION_LOCK_TIMEOUT at their sites
  case  517: // SQLITE_BUSY_SNAPSHOT       <- the closest thing to TRANSACTION_FAULT that remains
  case    8: // SQLITE_READONLY
  case   11: // SQLITE_CORRUPT
  case   13: // SQLITE_FULL
  case   14: // SQLITE_CANTOPEN
  case   26: // SQLITE_NOTADB
  default:   // -> the catch-all, whatever it ends up being named
}
```

`23514` routing by **constraint name** (`errors.ts:280-297`) has a direct SQLite equivalent because
the message is `CHECK constraint failed: <name-or-expression>` (measured) — but note it degrades to
the *expression text* when the constraint is unnamed, so **every CHECK in the SQLite lineage must be
explicitly named** for the chain-archive routing table to keep working. That is a hard requirement
on L1/L2's DDL, not a nice-to-have.

**Catalog changes I would propose, all additive, all pre-1.0.0:**

| change | kind | why |
|---|---|---|
| deprecate `UNRECOGNIZED_POSTGRES_ERROR`, add `UNRECOGNIZED_DATABASE_ERROR` | additive + deprecation | the name is a lie post-migration; per `STABILITY.md:27-32` deprecate-in-a-minor is the sanctioned path, and pre-1.0.0 it is free |
| add `DATABASE_UNAVAILABLE` (non-retryable) | additive | splits `CANTOPEN`/`READONLY`/`NOTADB` off `CONNECTION_ERROR` so the retryable marking stops lying — the same fix `ERROR-CATALOG.md:108-120` already earmarks for `28xxx` |
| add `DISK_FULL` (conditional) | additive | `SQLITE_FULL` (13) is genuinely conditional: clears if the operator frees space |
| add `DATABASE_CORRUPT` (non-retryable) | additive | `SQLITE_CORRUPT` (11) / `integrity_check` failure. `CORRUPT` is already taken by the *envelope* decoder — do not reuse it |
| retain `TRANSACTION_POOLER_DETECTED`, document as unreachable | no change | keeping it costs nothing and removing it costs a major |
| retain `DURABILITY_CONTRACT_VIOLATION`, restate trigger conditions | no change | class survives, `violations[]` payload changes |

### 4.5 Backup/restore contract, rewritten (CONTRACT §6)

```bash
# Consistent snapshot. Runs concurrently with writers; sees only committed data (measured).
# Must NOT be issued from inside a transaction.
sqlite3 umbradb.db "VACUUM INTO '/backup/umbradb-$(date -Is).db'"
# or, in-process:  db.exec(`vacuum into '...'`)
```

The three claims of §6 survive with their justifications rewritten: chunk/manifest consistency holds
because `VACUUM INTO` reads one snapshot; a mid-GC backup is safe for the same reason; restore is
"copy the file back", and the same-major rule from §2 is unaffected. **Four new sentences the
contract must gain**, each backed by a measurement above:

1. **Never copy `umbradb.db` alone.** The `-wal` sidecar holds every commit since the last
   checkpoint; restoring without it silently reverts the database to the last checkpoint — in §3.9,
   to before the table existed. Use `VACUUM INTO`, or snapshot `.db`+`-wal`+`-shm` **atomically**.
2. A backup **blocks WAL checkpointing for its whole duration**; the WAL grows by the full write
   volume of the backup window and is reclaimed only afterwards. Budget disk accordingly.
   `wal_checkpoint(PASSIVE)` reports `busy: 0` while checkpointing nothing — do not treat it as a
   success signal.
3. There is **no PITR**. Point-in-time recovery requires a filesystem/volume snapshot regime the
   deployer supplies. Say this plainly rather than leaving it implied.
4. `PRAGMA integrity_check` after restore is cheap (~580 MB/s measured) and should be the documented
   post-restore step. State its limit: it verifies structure, not cell content (a single flipped
   payload byte was **not** detected, §3.10) — `CheckpointStore`'s own SHA-256 verify covers that
   half.

---

## 5. Open questions / what I could not settle

1. **Power loss.** Every crash result in §3.5 is SIGKILL, i.e. a *process* crash. `synchronous=NORMAL`
   is guaranteed against exactly that and explicitly *not* against power loss. **I have no power-loss
   evidence and cannot produce any on this host.** If the project wants to actually spend the 27x
   `NORMAL` lever, that needs a physical rig (or a device-mapper `dm-flakey` / QEMU
   `nvme,write-cache=off` harness) — not a claim from a document. Until then the only defensible
   default is `FULL`.
2. **Whether `WAL/FULL` at 523 commits/s is enough.** That is L5's measurement, not mine. The number
   to check it against is the chain archive's ~1 GB/hour ingest and whatever batch size the sync
   uses: at 4 KB per commit, 523/s is ~7.5 GB/hour, which sounds ample — but if the ingest commits
   per *block* rather than per batch, or if `saveAndAdvance` is called per wallet-sync tick, the
   margin could be thin. **Flagged to L5.**
3. **Whether `size_bytes` is needed at all.** B3(a). Needs an L5 measurement of
   `sum(length(data))` vs `sum(size_bytes)` on a realistic `ckpt_chunks`.
4. **Fault-injection replacement.** I could not find a way to inject I/O faults (`SQLITE_IOERR_*`),
   which are the codes `LEASE_FAULT` and the repurposed `CONNECTION_ERROR` would live on, without a
   custom VFS — and `node:sqlite` exposes no VFS hook. Without it, those two codes would be
   *reachable in principle and untested in practice*, which is exactly the sort of thing a green
   gate hides (trap 9). Options I did not evaluate: a FUSE fault-injecting filesystem, or
   `dm-error`. **Unsettled.**
5. **Whether `ALTER COLUMN` / `ADD CONSTRAINT` are documented-stable or an undocumented 3.53
   addition.** I measured them working, repeatedly and with correct semantics (`ADD CONSTRAINT`
   validated existing rows and refused a violating one). I did **not** verify them against the
   SQLite changelog or docs, so I cannot say whether they are a supported public feature or an
   implementation detail — and trap 7 says a repo pinning a version must not be reasoned about from
   an upstream HEAD. **Before any migration relies on them, check the SQLite release notes for the
   exact version the project will pin, and pin it explicitly** (`node:sqlite`'s SQLite version is
   whatever the Node release bundles — that is an implicit, unpinned dependency and is itself worth
   flagging).
6. **`errcode` stability across Node versions.** `err.errcode` carrying the *extended* result code is
   the load-bearing fact for the whole error-translation design, and it is a `node:sqlite`
   implementation choice I verified empirically on v24.18.0 only. If a future Node narrows it to the
   primary code, `SQLITE_CONSTRAINT_TRIGGER` becomes indistinguishable from `SQLITE_CONSTRAINT_CHECK`
   and the `UB001` mapping degrades to message-sniffing. Worth a pinned regression test on day one.
7. **The 80 MB/s rebuild figure is a floor, not an estimate.** Stated in §3.2. A cold 300 GB archive
   on this hardware would plausibly be 2–5x slower. The **3.5x peak-disk ratio** is the number I
   would actually stake a plan on; the time is not.

---

## 6. Cost estimate

Engineering size for this lane's slice only (contracts, error translation, migration framework,
durability probe, verification infrastructure) — excluding the storage adapters themselves, which
are L1–L4.

| Work item | Size | Notes |
|---|---|---|
| Rewrite `docs/durability-contract.md` + CONTRACT §1/§2 | **2–3 d** | Mostly deletion. Four deployer preconditions become one. |
| New `src/sqlite/durability-probe.ts` + unit tests | **4–5 d** | The pure classifiers port structurally; statfs detection and fsync calibration are new. |
| `translateSqliteError` + `errors.test.ts` | **5–7 d** | The switch is a day; the *judgement* on each of the 24 codes, plus the additive-code proposals and CHANGELOG entries, is the rest. |
| Migration framework port (`migrate.ts`) | **3–4 d** | Structurally intact; bootstrap + lock + timeout substitutions. Depends on **L2**. |
| Migration lineage `000`–`006` transliteration | **5–8 d** | Depends on **L1** (T5/trigger) and **L2** (schema). `006` needs a decision (B3). |
| No-rebuild lint + rebuild-cost documentation | **1–2 d** | Cheap and high value. |
| Rewrite CONTRACT §3 (cancellation) | **1 d** doc, but see note | The doc change is trivial; the *decision* it forces (sync vs async driver) is L3's and is not cheap. |
| Rewrite CONTRACT §6 (backup/restore) + `VACUUM INTO` path | **3–4 d** | Plus the new P13 conformance property. |
| `SECURITY.md` revision | **2 d** | Strike TDE; add file-permission and sidecar sections. |
| `STABILITY.md` platform-dependency section + `engines` decision (B10) | **1–2 d** + a product call | Doc is cheap; raising the floor to `>=25.7` is a breaking change and drops LTS. |
| `docs/supply-chain/inventory.md` "platform-provided, unpinnable" section + a CI assertion that the runtime's `sqlite_version()` matches the recorded one (B10) | **2 d** | Otherwise a Node patch bump silently swaps the storage engine under a frozen contract. |
| Test-harness rebuild: `setup.ts` fixture + crash primitives | **8–12 d** | The fixture is trivial (§3.11); replacing crash primitives 2 and 3 is the cost, and item 4 of §5 may make part of it impossible. |
| P1–P10 port + P11–P13 new properties | **5–8 d** | Bodies largely unchanged; the new ones are new. |
| Refinement register rewrite (`v1.1.0-formal-completion`) | **3–5 d** | Zero Lean edits; all prose, all judgement. |
| CI rework (`conformance.yml`, `lean.yml` untouched, mutation gate simplification) | **2–3 d** | The mutation gate gets *simpler* and much faster — likely a net saving. |

**Total for L6: roughly 48–69 engineer-days**, on the assumption that L1–L4 deliver the adapters and
the T5/lease/schema mechanisms. The three schedule risks are (a) the fault-injection gap (§5.4),
which could silently convert "tested" codes into "untested" ones, (b) the cancellation decision (B1),
which is not L6's to make but blocks L6's contract text, and (c) the driver/`engines` decision (B10),
which is L3's to make but determines whether 1.0.0 can be tagged honestly at all.

**What it breaks, named:**

- **G4 contract 3 (cancellation)** — broken, not merely reworded. One of the three documented
  timings cannot be delivered by a synchronous embedded engine.
- **G4 contract 6 (backup/restore)** — every command in it is replaced; the properties survive.
- **G4 contract 1 (durability)** — survives and strengthens; the `full_page_writes` clause and its
  `allowFullPageWritesOff` override become vestigial.
- **G3 (frozen error catalog)** — ~6 of 24 codes change meaning or become unreachable; 1 needs
  renaming; 3–4 additive codes should be introduced. **Not breaking if it lands before the 1.0.0 tag**
  (`docs/STABILITY.md:46`); a forced 2.0.0 if it lands after.
- **G2 (SemVer)** — same conditional. This is the sequencing decision the sprint should make first.
- **G1 (frozen API surface)** — touched only through `DEFAULT_SCHEMA`/schema-configurability
  (**L2**), and through whichever error classes are added.
- **The Lean cut-line `{T3, T5, W1, C1}`** — literally untouched, and that fact is itself the finding
  a reviewer should be shown, not the reassurance it looks like.
- **`docs/recovery/EVIDENCE.md`** — the G12/R5 pre-tag evidence artifact records a run against
  `postgres:17-alpine` and is invalidated by the engine change. Its binding rule 1 ("the run MUST be
  against the RC commit") means it must be **re-executed**, not amended.
- **`engines: node >=24`** (`package.json:31-33`) — very likely must rise (B10). An `engines` floor
  increase removes runtimes the package claims to support and is therefore itself a breaking change:
  free before the 1.0.0 tag, a major after it. Same clock as G2/G3, which is the second reason the
  sprint's sequencing decision should be made first.
- **`docs/supply-chain/inventory.md` and the "zero runtime dependencies" claim** — the claim is not
  true either way (`zod@^4.0.0` remains), and the dependency that is removed is replaced by an
  unpinnable, gate-invisible platform built-in. The inventory needs a new section; the marketing
  line needs deleting.
