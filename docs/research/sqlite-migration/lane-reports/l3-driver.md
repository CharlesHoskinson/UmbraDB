# L3 — Driver and runtime shape

Lane: `l3-driver`. Worktree: `/root/UDB-sqlite-l3-driver` (cut from `origin/main`).
All measurements on Node **v24.18.0**, WSL2 Ubuntu 26.04, `node:sqlite` **SQLite 3.53.1**.

---

## 1. Verdict

**Use `node:sqlite` (Node 24's built-in `DatabaseSync`), behind a ~250-line `postgres.js`-shaped
tagged-template shim, with the database owned by a dedicated worker thread.** It is the only
candidate that takes UmbraDB's runtime dependency graph from `{postgres, zod}` to `{zod}` — zero new
packages, zero native binaries, nothing for `npm audit --omit=dev` or the `ignore-scripts=true`
supply-chain gate to chew on, and nothing that can fail the packed-tarball smoke test on an
unsupported platform. It ships the newest SQLite of any candidate (3.53.1 vs better-sqlite3's 3.53.4
in its own vendored copy and libsql's forked **3.45.1**), and it exposes UDFs, aggregates, an async
`backup()`, `VACUUM INTO`, sessions/changesets, and extension loading.

The sync/async fault line is **not** the blocker it looks like. Awaiting an already-resolved value
still drains the microtask queue, so the *relative interleaving* of concurrent UmbraDB callers is
bit-identical to today (measured: `A0 B0 A1 B1 A2 B2` under both real I/O and resolved values). What
a synchronous driver destroys is **macrotask liveness**: I measured 100,000 resolved-value `await`s
running to completion in 9 ms with a `setTimeout(…, 0)` still un-fired. That has one fatal
consequence — **an `AbortSignal` can never fire while a synchronous query is running on the same
thread**, which I proved directly: a 103 ms scan completed with `signal.aborted === false` even
though `ac.abort()` had been scheduled at t+20 ms. Mid-wait cancellation, which G4 publishes as a
release contract and which `listKeys` and `acquireLease` implement with real `Query.prototype.cancel()`,
is therefore **impossible in-process**. A worker thread restores it exactly: with a
`SharedArrayBuffer` flag polled by a scalar UDF I cancelled a running 8M-row scan **1 ms** after the
main thread set the flag, while the main event loop kept ticking at max 0.6 ms lag.

I recommend the **shim, not a rewrite**. I built one (130 lines) and ported `PgTemporalKV`'s three
`put` cases, the CAS-miss path, the `listKeys` cursor, nested `sql.begin`, and hostile identifier
interpolation onto it **verbatim**, changing only the schema-qualification token. The decisive
discovery is that `StatementSync.columns()` returns each result column's **declared type name
verbatim** (`JSONB`, `TIMESTAMPTZ`, `BYTEA`, `BIGINT`, `INT4`) — SQLite preserves declared type text
even though affinity ignores it. That lets the shim reproduce postgres.js's OID-driven row decoding
with **zero call-site annotation**: I measured full row-shape parity — `value` as a parsed object,
`version` as `bigint`, `written_at` as a real `Date`, `size_bytes` as `number`, `hash` as a `Buffer`,
`count(*)` as `bigint`. Shim overhead is **1.59×** over raw prepared statements (5.23 µs vs 3.28 µs
per point read), which is noise against a networked Postgres round trip.

The real costs are three: **`UmbraDBSql` and `createClient`'s option shape are frozen G1 type exports
and cannot survive** (`src/index.ts:81`, `src/postgres/client.ts:10,44`); the worker hop costs **32×
per-operation latency** (3.86 µs → 124 µs); and there are three silent-corruption traps
(`Date`→NULL, lone surrogate→U+FFFD, NUL-truncated `length()`) that a shim must close explicitly and
a native-API rewrite would hit one at a time.

---

## 2. Blockers

### B1 — Mid-query `AbortSignal` cancellation is impossible with a synchronous driver on the main thread
- **Today:** `Query.prototype.cancel()` sends a real Postgres-protocol cancellation on a second
  connection. `src/postgres/temporal-kv.ts:319-383` (`listKeys`) and
  `src/postgres/transaction-lease.ts:91-117` (`raceAgainstAbort`) both build dedicated machinery on
  it; `src/interfaces/transaction-lease.ts` documents `LeaseAcquireOptions.signal` as *genuine*
  mid-wait cancellation. G4 publishes a **cancellation** release contract.
- **SQLite offers:** `node:sqlite` exposes **no** `sqlite3_interrupt` and **no** progress handler —
  `"interrupt" in db === false`, and no prototype member matches `/prog|interrupt|busy|timeout/`
  (experiment 09). Even if it did, on the main thread there is nobody to call it: the loop is blocked.
- **Gap:** **Not closeable in application code on a single thread.** Closeable *only* by moving the
  database into a worker thread (measured working, §3.5) or by demoting the contract from
  "abortable" to "deadline-bounded".
- **Frozen commitments touched:** **G4 cancellation contract**; `LeaseAcquireOptions.signal` and
  `TemporalKV.listKeys(..., {signal})` semantics on the **G1 frozen surface**; the `LEASE_TIMEOUT` and
  `TRANSACTION_FAULT` entries of the **G3** retryable set change meaning.

### B2 — A synchronous driver blocks the Node event loop proportionally to the work
- **Measured** (experiment 07, 500k-row table on disk, WAL): a `count(*)`-with-`LIKE` scan blocks the
  loop **34 ms**; `.all()` of 500k rows blocks **430 ms**; a 64 MiB BLOB write blocks **237 ms**; a
  64 MiB BLOB read blocks **162 ms**. Idle baseline lag is 0.15–0.3 ms.
- **Matters for a wallet client:** yes. UmbraDB is a library embedded in a Midnight wallet whose sync
  loop, RPC keep-alives and any UI share that event loop. A 430 ms stall per large read is a dropped
  websocket heartbeat.
- **Gap:** **Closeable in application code, partially.** `StatementSync.iterate()` chunked at 256
  rows costs a **worst case 2.9 ms** per batch (total 258 ms for 500k rows) — awaiting a macrotask
  tick between batches keeps the loop responsive, and that is exactly the shape `listKeys` already
  has. Big single-blob reads/writes cannot be chunked this way without incremental-BLOB I/O, which
  `node:sqlite` does not expose. **Fully closeable with a worker thread** at 32× per-op latency.

### B3 — `UmbraDBSql` is a frozen public *type* and cannot survive
- `src/postgres/client.ts:10`: `export type UmbraDBSql = Sql<{ bigint: bigint }> & { readonly umbradbSchema: string }`,
  re-exported at `src/index.ts:81`. It is structurally the `postgres.js` `Sql` type. Every adapter
  constructor takes it (`PgTemporalKV`, `PgCheckpointStore`, `PgWatermarks`,
  `PgTransactionLeaseLayer`, `PgTransactionHistoryStorage`, `PgWalletStateEnvelopeStore`), and
  `resolveTransaction` returns `ISql<{bigint: bigint}>` across a module boundary
  (`src/postgres/transaction-lease.ts:35,57`).
- **Gap:** **Not closeable.** Even a perfectly shaped shim is not the same nominal type, and dropping
  the `postgres` dependency removes the type's declaration entirely. **G1** (frozen surface) and
  **G2** (no incompatible change to the exported surface in minor/patch) — this is a **2.0.0**.

### B4 — `createClient`'s option surface is Postgres-shaped end to end
- `src/postgres/client.ts:44-77`: `connectionString`, `maxConnections`, `connectTimeout`,
  `statementTimeoutMs`, `lockTimeoutMs`, `idleInTxTimeoutMs`. Every one is meaningless for an
  embedded engine. `assertNoConflictingSearchPath` (`:113`) and the 63-byte identifier bound (`:31`)
  are Postgres-specific validations on the frozen path.
- **SQLite offers:** `new DatabaseSync(path, { readOnly, enableForeignKeyConstraints, allowExtension,
  timeout, readBigInts, returnArrays, … })` — verified all accepted (exp. 16). `timeout` maps to
  `busy_timeout` (measured: `{ timeout: 5000n }`). Unknown options are **silently ignored**, so a
  compatibility shim that forwards today's option bag would *appear* to work while dropping every
  durability bound — do not do that.
- **Gap:** **Closeable with a redesign, but it is a G1/G2 break.** `maxConnections` in particular has
  no meaning: there is one writer, enforced by SQLite (`begin immediate` from a second connection
  raised `SQLITE_BUSY` errcode 5, exp. 12). `statementTimeoutMs` is recoverable via the deadline UDF
  (§4); `lockTimeoutMs` maps onto `busy_timeout`; `idleInTxTimeoutMs` has no analogue.
- `DEFAULT_SCHEMA` and schema-configurability are also frozen G1 — L4 owns what a schema *becomes*;
  I only report that the driver-level mechanics (`sql(schema)` → `"quoted"` identifier splice) port
  cleanly.

### B5 — `SQLITE_MAX_VARIABLE_NUMBER` is 32,766; UmbraDB's batches bind 60,000
- `src/postgres/checkpoint-store.ts:62-63`: `CHUNK_INSERT_MAX_ROWS = 30_000` (2 params/row) and
  `JUNCTION_INSERT_MAX_ROWS = 20_000` (3 params/row) — both sized at 60,000 params against
  Postgres's 65,534 cap (the file's own comments at `:56-62` say so).
- **Measured exact thresholds** (exp. 11): 16,383 rows × 2 params = 32,766 prepares fine; **16,384
  rows × 2 = 32,768 fails** `Error: too many SQL variables`. 10,922 × 3 = 32,766 fine; **10,923 × 3 =
  32,769 fails**.
- **Gap:** **Closeable in application code** — retune to `CHUNK_INSERT_MAX_ROWS = 16_000` and
  `JUNCTION_INSERT_MAX_ROWS = 10_000`. But it doubles the statement count per save, which changes the
  "EXACTLY ONE statement per checkpoint" property that file's comments defend, and it is a silent
  runtime failure if missed. `test/postgres/perf-batching.test.ts` will need re-baselining.

### B6 — A `Date` bound as a positional parameter is silently stored as **NULL**
- **Measured** (exp. 06): `db.prepare("insert into t(x) values(?)").run(new Date())` → stored value
  `null`, `typeof(x)` = `'null'`, **no error**. Cause: `node:sqlite` treats a non-`Uint8Array` object
  argument as a *named-parameter bag*; a `Date` has no own enumerable keys, so parameter 1 is never
  bound. An `Array` or a class instance *does* throw (`Unknown named parameter '0'` / `'q'`) — the
  `Date` case is the one that fails silently.
- **Where it bites:** `src/postgres/temporal-kv.ts:254` and `:257` — `${asOf.at}::timestamptz` in
  `getAtImpl`. That is the point-in-time read, i.e. **T3 (temporal projection / observational
  equivalence)**, a Lean-mechanized cut-line law. A naive port makes `getAt({kind:"at"})` return the
  wrong row with no error and no test failure unless a test happens to assert on a specific instant.
- **Gap:** **Closeable in the driver layer** — the shim's `normalize()` converts `Date` →
  ISO-8601 text (verified: `{"a":"2026-07-31T12:00:00.000Z","t":"text"}`). This is a **strong argument
  for the shim over a rewrite**: one function closes it once, versus finding every `Date` bind by hand.

### B7 — Booleans are rejected outright
- **Measured** (exp. 05): `.run(true)` → `Provided value cannot be bound to SQLite parameter 1.`
- **Where:** `src/postgres/chain-archive-store.ts:199` (`${block.isCanonical}`, `${block.finalized}`)
  and `:389` (`COALESCE(${opts?.finalized ?? null}, finalized)`).
- **Gap:** **Closeable in the driver layer** (shim `normalize()` maps `true→1`/`false→0`). Loud, so
  cheap to find even without the shim.

### B8 — `sql.array()` + GIN `<@` containment has no driver-level equivalent
- `src/postgres/transaction-history-storage.ts:500,522` and `src/postgres/checkpoint-store.ts:442`
  (`= ANY(${sql.array(manifestIds)})`). SQLite has no array type and no GIN.
- **Gap:** **Not closeable at the driver level.** The shim can only serialize an array to a JSON text
  parameter for `json_each()`; whether that is an acceptable index strategy is **L4/L1's call**, and I
  flag it to them rather than research it. Driver-level fact: 6 `sql.array` sites total.

### B9 — Text that PostgreSQL rejects, SQLite silently mangles
- **Measured** (exp. 05): a NUL byte in TEXT is **accepted**, but SQLite's `length()` reports `1` for
  `"a\0b"` (it stops at the NUL) while the JS round trip returns all three code units — so
  `LIKE`/`length()`/ordering disagree with the stored value. A **lone surrogate** is **accepted and
  silently replaced with U+FFFD** — `g.j === "a\uD800b"` is **false**.
- **Gap:** **Already closed, and must stay closed.** `hasPostgresUnsafeText`
  (`src/interfaces/temporal-kv.ts`, used at `src/postgres/temporal-kv.ts:309`) rejects both. Under
  SQLite that guard stops being "PostgreSQL cannot store either" and becomes
  "**SQLite corrupts either**". Any migration cleanup that relaxes it as "Postgres-specific" would
  introduce silent data corruption. Rename it; do not delete it.

### B10 — `readBigInts` is per-statement/per-database, never per-column
- **Measured** (exp. 04b/04c): with the default (number) mode, reading an INTEGER outside the safe
  range **throws** `ERR_OUT_OF_RANGE` rather than losing precision silently — `9007199254740992`,
  `…93`, `2^63-1`, and their negatives all throw. **There is exactly one hole:** `INT64_MIN`
  (`-9223372036854775808`) is returned as a `number` with no throw. The value is exact (it is `-2^63`,
  a power of two), so this is a *type-discipline* hole, not precision loss — almost certainly an
  overflow in Node's own range check. UmbraDB's `version`/`height`/`id` are all non-negative, so it is
  unreachable in practice; record it, don't fix it.
- With `setReadBigInts(true)`, **every** integer column becomes `bigint`, including ones postgres.js
  hands back as `number` for `int4` (e.g. `size_bytes integer`,
  `src/postgres/migrations/006_ckpt_chunks_size_bytes.ts`).
- **Gap:** **Closeable in the driver layer** — read everything as `bigint`, then downcast columns whose
  declared type is `INT4`/`INTEGER`/`SMALLINT` in the decoder. Verified working (§3.10).

### B11 — flagged to neighbouring lanes, not researched here
- `SQLITE_MAX_ATTACHED = 10` (measured compile option). **→ L4**: an ATTACH-per-schema design has a
  hard ceiling of 10 attached databases.
- `SQLITE_MAX_LENGTH = 1000000000` (1 GB) caps any single BLOB/TEXT. **→ L5** (chain archive).
- `THREADSAFE=1` (serialized). One `DatabaseSync` per thread is safe; sharing a handle across worker
  threads is not supported by the JS binding regardless. **→ L2**.
- Extended result codes are exposed on the thrown error as `errcode`/`errstr`
  (measured: `1555` `SQLITE_CONSTRAINT_PRIMARYKEY`, `275` `SQLITE_CONSTRAINT_CHECK`, `5`
  `SQLITE_BUSY`, `1` `SQL logic error`) with `err.code === "ERR_SQLITE_ERROR"`. **→ L6**: that is a
  workable substrate for the frozen **G3** 25-code catalog, but it is a *different* discriminator
  from SQLSTATE, and `src/postgres/errors.ts` switches on SQLSTATE strings including the custom
  `UB001` (`:273`), `23P01` (`:278`), `57014`, `55P03`.

---

## 3. Evidence

Every experiment script is under `/tmp/l3/` (throwaway, per the brief; nothing was written to `src/`
or `test/`, and **no `npm install` was run in the worktree** — the two third-party drivers were
installed into `/tmp/l3-bs3b` and `/tmp/l3-libsql`, each with its own `package.json`).

### 3.1 Candidate comparison (all figures measured, not cited)

| | `node:sqlite` | `better-sqlite3` | `@libsql/client` | `bun:sqlite` |
|---|---|---|---|---|
| Version | built in | 13.0.2 | 15-pkg tree | Bun 1.3.14 built-in |
| SQLite version | **3.53.1** | 3.53.4 | **3.45.1** (fork) | 3.53.0 |
| Runtime packages added | **0** | 2 (`+node-addon-api`) | **15** | 0 |
| `node_modules` size | **0** | 27 MB | 23 MB | 0 |
| Install time (warm registry) | — | 0.62 s | 1.79 s | — |
| Compiler needed? | no | **no** — 8 prebuilds ship *in the tarball* | no — per-platform optional native pkgs | no |
| Survives `ignore-scripts=true`? | n/a | **yes** (verified — declares no `install`/`postinstall`) | yes | n/a |
| Sync/async | sync | sync | **async** | sync |
| Blobs come back as | `Uint8Array` | `Buffer` | **`ArrayBuffer`** | `Uint8Array` |
| >2^53 INTEGER default | **throws** `ERR_OUT_OF_RANGE` | `safeIntegers` opt | **throws** `RangeError` | number |
| `sqlite3_interrupt` | **absent** | absent | in-driver | absent |
| Backup API | **`backup()` → Promise, `rate`/`progress`** | `db.backup()` | server-side | yes |
| UDF / aggregate | yes (`function`, `aggregate`) | yes | no | yes |
| Extension loading | `enableLoadExtension`/`loadExtension` | yes | limited | yes |
| Sessions / changesets | yes (`ENABLE_SESSION`) | via ext | no | no |
| Blocks the packed-tarball smoke test? | no | only on a platform with no prebuild | only on a platform with no optional pkg | **yes** |

**`bun:sqlite` is disqualified on packaging, not on capability.** UmbraDB is a *library* published to
npm declaring `engines: { node: ">=24" }` (`package.json:31-33`) with a strict single-entry `exports`
map, and its release gates (`pack-smoke.yml`, `supply-chain.yml`, `conformance.yml`) all run
`actions/setup-node@… node-version: "24"`. Adopting `bun:sqlite` would make the package
runtime-exclusive to Bun and break every Node consumer plus all three CI gates. (The recorded
"Bun is not viable in this neighbourhood" finding is about `bun` + the `mongodb` npm package and does
**not** apply here — Bun and `bun:sqlite` both work fine on this machine: `bun -e "…sqlite_version()"`
→ `3.53.0`. The disqualification is packaging.)

**The native-addon supply-chain hypothesis is REFUTED by measurement.** I expected
`ignore-scripts=true` (`.npmrc`, asserted by `supply-chain.yml`'s "Assert repo-root .npmrc sets
ignore-scripts=true" step) to break `better-sqlite3`. It does not: v13 declares **no** `install` or
`postinstall` script and ships `prebuilds/{linux,linuxmusl,darwin,win32}-{x64,arm64}.node` inside the
npm tarball. It installed and ran clean under `ignore-scripts=true`. What *would* have had to be true
for a "better-sqlite3 breaks the gate" finding to hold: it would need a `prebuild-install`
postinstall step (which older versions had). So the case against `better-sqlite3` rests on 27 MB, two
extra packages, an N-API binary in a package whose supply-chain workflow exists specifically to keep
foreign code out, and the tail risk of a platform with no prebuild — **not** on an install failure.

```
$ cd /tmp/l3-bs3b && cat .npmrc && npm config get ignore-scripts && npm install better-sqlite3
ignore-scripts=true
true
added 2 packages in 553ms          ELAPSED 0.62 s
$ node -e 'const D=require("better-sqlite3"); …'
bs3 WITH ignore-scripts ok: 3.53.4
$ node -p 'JSON.stringify(require("better-sqlite3/package.json").scripts)'
{"build-release":…,"build-debug":…,"test":…,"benchmark":…,"download":…,"clean":…}   # no install/postinstall
$ find node_modules/better-sqlite3 -name '*.node'
prebuilds/{win32,linuxmusl,linux,darwin}-{x64,arm64}.node
```

```
$ cd /tmp/l3-libsql && npm install @libsql/client
added 15 packages in 2s        23M    node_modules
node_modules/@libsql/linux-x64-musl/index.node ; node_modules/@libsql/linux-x64-gnu/index.node
$ node t2.mjs
intMode=bigint: big=9223372036854775807 (bigint) blob=ArrayBuffer len=3
intMode=string: big=9223372036854775807 (string) blob=ArrayBuffer len=3
intMode=number: THROWS RangeError: Received integer which cannot be safely represented…
$ select sqlite_version()  ->  3.45.1
```

Runtime graph today, for contrast:
```
$ node -e '…walk package-lock.json runtime deps…'
runtime packages: 2 postgres, zod
```

### 3.2 `node:sqlite` API surface (`/tmp/l3/01-surface.mjs`)

```
node v24.18.0
node:sqlite exports: DatabaseSync, Session, StatementSync, backup, constants
sqlite_version: 3.53.1
DatabaseSync.prototype: aggregate, applyChangeset, close, constructor, createSession,
  createTagStore, deserialize, enableDefensive, enableLoadExtension, exec, function,
  loadExtension, location, open, prepare, serialize, setAuthorizer
StatementSync.prototype: all, columns, get, iterate, run, setAllowBareNamedParameters,
  setAllowUnknownNamedParameters, setReadBigInts, setReturnArrays
compile_options (relevant): THREADSAFE=1 | MAX_ATTACHED=10 | MAX_VARIABLE_NUMBER=32766 |
  MAX_LENGTH=1000000000 | ENABLE_COLUMN_METADATA | ENABLE_SESSION | ENABLE_PREUPDATE_HOOK |
  ENABLE_FTS5 | ENABLE_RTREE | ENABLE_MATH_FUNCTIONS | ENABLE_RBU | DEFAULT_SYNCHRONOUS=2 |
  DEFAULT_WAL_SYNCHRONOUS=2 | DEFAULT_WAL_AUTOCHECKPOINT=1000
```
Stability signals: `process.versions.sqlite` → `3.53.1` (first-class bundled component); the module
imports with **no flag and emits no `ExperimentalWarning`** under a `process.on("warning")` probe. I
could **not** verify the documented stability index offline — treat "no warning" as evidence of
unflagged availability, not as a stability guarantee.

### 3.3 The sync/async fault line (`/tmp/l3/08-ordering.mjs`)

```
after 100k awaits of already-resolved: 9 ms; timer fired? false immediate fired? false
after one setImmediate yield:                timer fired? true  immediate fired? true
  resolved-value interleave: A0 B0 A1 B1 A2 B2
  real-async interleave:     A0 B0 A1 B1 A2 B2
```
**Reading:** ordering between concurrent async chains is *unchanged* — a synchronous driver behind an
`async` public API preserves every interleaving invariant the existing tests can observe, because
`await` on a resolved value still defers to the microtask queue. What changes is that timers, I/O
callbacks and `setImmediate` are starved for the whole duration of a synchronous burst.

### 3.4 Event-loop blocking (`/tmp/l3/07-eventloop.mjs`, 500k rows, WAL, on disk)

```
seed 500k rows: 637 ms
BASELINE idle lag samples:  0.31 0.18 0.16 0.15 0.16 0.18 0.20 0.23 0.31 (ms)
FULL SCAN 500k (count):     work  33 ms   -> single lag spike  34.08 ms
SELECT ALL 500k (.all()):   work 429 ms   -> single lag spike 429.94 ms
64MB BLOB write:            work 237 ms   -> single lag spike 237.01 ms
64MB BLOB read:             work 162 ms   -> single lag spike 161.56 ms
iterate() 500k @256/batch:  total 258.7 ms, rows 500000, worst 256-row batch 2.907 ms
```
Caveat on a *different* measurement I ran (`/tmp/l3/10-worker.mjs`) that reported "max event-loop lag
0.0 ms" for the same `.all()`: that number is an artefact — the `setInterval` probe was installed and
cleared without ever getting a tick, because the synchronous work ran to completion before the first
timer could fire. Exp. 07's single-spike numbers are the valid ones. I record this because it is
exactly the shape of a false negative.

### 3.5 Cancellation (`/tmp/l3/09-cancel.mjs`, `14-deadline.mjs`, `15-worker-cancel.mjs`)

```
has interrupt? false undefined
prototype members matching /prog|interrupt|busy|timeout/: []

# a UDF that throws DOES abort the running statement, and the error propagates:
UDF-throw aborted query after 1001 calls -> Error: UMBRADB_CANCELLED

# (a) deadline UDF == statement_timeout emulation
2M-row scan: UDF-guarded 136 ms, 2,000,000 UDF calls  (~68 ns/row guard cost)
deadline 50ms -> StatementTimeout after 51 ms, 909,312 UDF calls

# (b) AbortSignal mid-query, MAIN THREAD  <-- the hard negative
main-thread AbortSignal: query COMPLETED in 103 ms, signal.aborted=false,
  UDF ever saw abort=false   <-- the setTimeout(…,20) that would have aborted was starved

# (c) worker thread + SharedArrayBuffer flag polled by the UDF  <-- the fix
worker seeded and idle
  main thread set cancel flag at t+201 ms
worker result: {"cancelled":true,"rowsVisited":2708992,"ms":202} at t+202 ms
main loop during the whole thing: 39 ticks (expect ~40), max lag 0.6 ms
```
**Cancellation latency ≈ 1 ms; main-loop lag ≈ 0.6 ms.** This is the whole argument for the worker.

Also verified in the same run: `backup(src, dest, {rate, progress})` returns a real `Promise` and the
destination verified correct; `VACUUM INTO '/tmp/l3/vac.db'` produced a readable 200k-row copy. Both
are directly relevant to **G4's backup/restore contract**, and both are *better* than what the
Postgres adapter has today (no in-library backup at all).

### 3.6 Types across the boundary (`04b`, `04c`, `05`, `06`)

```
# insert side
BigInt > 2^63-1               -> TypeError: BigInt value is too large to bind.        (loud)
new Date()                    -> stored as NULL, typeof(x)='null'                     (SILENT — B6)
[1,2,3] / class instance      -> Error: Unknown named parameter '0' / 'q'             (loud)
true / undefined              -> Provided value cannot be bound to SQLite parameter 1 (loud)
"a\0b"                        -> accepted; length()=1 but 3 code units round-trip     (SILENT — B9)
"a\uD800b"                    -> accepted; returns "a�b", not equal              (SILENT — B9)

# read side, default (number) mode
9007199254740991     -> 9007199254740991 (number)  exact
9007199254740992     -> THROWS ERR_OUT_OF_RANGE
9223372036854775807  -> THROWS ERR_OUT_OF_RANGE
-9007199254740992    -> THROWS ERR_OUT_OF_RANGE
-9223372036854775807 -> THROWS ERR_OUT_OF_RANGE
-9223372036854775808 -> -9223372036854776000 (number), BigInt(n)===v true  <-- the one hole (B10)

# read side, setReadBigInts(true): every value above exact as bigint
# BLOB: comes back Uint8Array (never Buffer), even when a Buffer was bound; NULL blob -> null
# JSON: text/jsonb both work; jsonb() is 21 bytes for a 34-byte doc; json_extract/json_type fine
```

### 3.7 Bind-parameter ceiling vs UmbraDB's batch constants (`/tmp/l3/11-limits.mjs`)

```
VALUES 16383 rows x2 params = 32766: PREPARE OK
VALUES 16384 rows x2 params = 32768: Error: too many SQL variables
VALUES 30000 rows x2 params = 60000: Error: too many SQL variables      <- CHUNK_INSERT_MAX_ROWS
VALUES 10922 rows x3 params = 32766: PREPARE OK
VALUES 10923 rows x3 params = 32769: Error: too many SQL variables
VALUES 20000 rows x3 params = 60000: Error: too many SQL variables      <- JUNCTION_INSERT_MAX_ROWS
```
against `src/postgres/checkpoint-store.ts:62-63`.

### 3.8 WAL / locking / error shape (`/tmp/l3/12-wal.mjs`)

```
default busy_timeout: 0
second `begin immediate` while A holds a write txn -> Error: database is locked | errcode 5
reader during A's uncommitted write sees 0 rows; after commit sees 1     (WAL snapshot isolation)
UNIQUE violation : {"code":"ERR_SQLITE_ERROR","errcode":1555,"errstr":"constraint failed",
                    "message":"UNIQUE constraint failed: t.i"}
no such table    : {"code":"ERR_SQLITE_ERROR","errcode":1,"errstr":"SQL logic error"}
CHECK violation  : {"code":"ERR_SQLITE_ERROR","errcode":275,"errstr":"constraint failed"}
```

### 3.9 The shim, and real UmbraDB queries ported onto it

`/tmp/l3/shim/shim2.mjs` — **130 lines** total, implementing ``sql`…` `` (thenable, returns a row
array with `.count`), `sql(ident)`, `sql.json`, `sql.array`, `sql.unsafe`, `sql.reserve`, `sql.begin`
(with `SAVEPOINT` nesting), `sql.end`, `Query.prototype.cancel()`, and `Query.prototype.cursor(n)` as
an async generator that awaits a macrotask tick between batches.

`/tmp/l3/shim/port.mjs` ports `PgTemporalKV.putImpl` cases 1/2/3, the CAS-miss re-read, `listKeys`'s
cursor, nested `sql.begin`, and a hostile identifier:

```
case1 upsert   -> {"value":"{\"a\":1}","version":"1n","written_at":"…"} rows.count = 1
case1 2nd      -> version 2n                                   (ON CONFLICT DO UPDATE works)
case2 DO NOTHING rows: 0   (postgres parity: 0)                (…DO NOTHING RETURNING works)
CAS hit        -> version 3n, rows: 1
CAS miss rows: 0           (postgres parity: 0)
cursor rows: 1000 first: p0000 last: p0999
cursor cancel -> AbortError after 256 rows
after nested savepoint rollback: [ 't1' ]                       (inner SAVEPOINT rolled back)
hostile identifier -> no such table: x"; DROP TABLE umbradb_kv_current; --
table still present, rows: 1002n                                (identifier splice is escaped)
Date through shim -> {"a":"2026-07-31T12:00:00.000Z","t":"text"}  (B6 closed by normalize())
```
The **only** textual edits to the real query bodies were: `${sql(this.schema)}.kv_current` →
`${sql(table)}`; drop `::timestamptz`; `ESCAPE '\\'` survives unchanged. `ON CONFLICT … DO UPDATE`,
`DO NOTHING`, `RETURNING`, `EXCLUDED`, and `LIKE … ESCAPE` are all SQLite-native.

### 3.10 The decisive discovery: `columns()` gives declared type names, so postgres.js row decoding ports

```
$ node /tmp/l3/13-columns.mjs
[{"column":"value","table":"kv","name":"value","type":"JSONB"},
 {"column":"version","table":"kv","name":"version","type":"INTEGER"},
 {"column":"updated_at","table":"kv","name":"written_at","type":"TIMESTAMPTZ"},
 {"column":"sz","table":"kv","name":"sz","type":"INT4"},
 {"column":"h","table":"kv","name":"h","type":"BLOB"},
 {"column":null,"table":null,"name":"c","type":null}]        <- computed column
```
SQLite stores the *declared* type text verbatim (affinity is derived from it but does not replace
it), and `SQLITE_ENABLE_COLUMN_METADATA` is compiled into Node's build. So the shim can key a decoder
table off declared type names exactly the way postgres.js keys off type OIDs — **with no annotation
at any of the 190 call sites**. `/tmp/l3/shim/port2.mjs` proves full parity:

```
value      : object {"a":1,"b":[1,2,null],"c":"x"}  deep-equal: true
version    : bigint 1n           (postgres.js { bigint: bigint } parity)
written_at : Date 2026-07-31T17:50:27.145Z
size_bytes : number 7            (postgres.js int4 parity)
hash       : Buffer len 32 first=0xab
count(*)   : bigint 1n           (postgres.js int8 parity — type null falls through as bigint)
NULL row   : {"value":null,"size_bytes":null,"hash":null}
i64 max    : bigint 9223372036854775807n exact: true
8MiB blob  : Buffer 8388608 bytes, equal: true
```

### 3.11 Cost of the abstractions

```
# statement caching is real and matters
tagstore/prepared 200k point reads: 166 ms / 167 ms;  re-prepare each time: 791 ms  (4.7x)

# shim overhead over raw prepared statements
shim tagged-template + decode   x50000: 261 ms (5.23 us/op)
raw node:sqlite prepared .get() x50000: 164 ms (3.28 us/op)      shim overhead: 1.59x

# worker-thread hop
in-process sync point-read  x20000:   77.2 ms   (3.86 us/op)
worker round-trip point-read x20000: 2487.7 ms (124.38 us/op)    overhead: 32.2x
```

Node 24 also ships `db.createTagStore()`, a **built-in** tagged-template façade
(`{ get, all, iterate, run, clear }`, each a template tag) with automatic statement caching — measured
identical to hand-prepared statements. It binds parameters (an injection attempt returned `{"c":0}`)
and **cannot** splice identifiers (``select … from ${tbl}`` → `Error near "?": syntax error`). It is a
good fallback but is not sufficient on its own: no identifier interpolation, no promise interface, no
row decoding.

---

## 4. Design sketch

### 4.1 Topology

```
main thread                              writer thread (node:worker_threads)
─────────────                            ──────────────────────────────────
UmbraDB public API (unchanged, async)    DatabaseSync(path, { timeout, readBigInts:true })
  └─ RpcClient                             └─ postgres.js-shaped shim (`sql`)
       postMessage({id, sql, binds})   ->        prepared-statement cache (Map<text,{st,decode}>)
       Int32Array(SharedArrayBuffer)   ->        udf `umbradb_guard()` polls flag + deadline
       await pending.get(id)           <-        postMessage({id, rows}) / ({id, err})
```
One worker owns the single `DatabaseSync`. UmbraDB is already a single-writer store, so this costs
nothing architecturally. A **second, read-only** worker holding its own `DatabaseSync(path,
{readOnly:true})` is possible later under WAL for concurrent readers — that is L2's call, not mine.

Cancellation and timeouts land on one mechanism. Every long-running statement gets
`AND umbradb_guard() = 0` appended (statements where that is impossible run uncancellable — document
which). The UDF, called once per row visited at ~68 ns:

```js
db.function("umbradb_guard", { deterministic: false }, () => {
  if ((++n & 0xff) !== 0) return 0;                       // amortise the checks
  if (Atomics.load(cancelFlag, 0) === 1) throw new Error("UMBRADB_CANCELLED");
  if (Date.now() > deadline)              throw new Error("UMBRADB_STATEMENT_TIMEOUT");
  return 0;
});
```
Measured: 50 ms deadline honoured at 51 ms; SAB cancel honoured at +1 ms.

**Fallback if the worker is judged too expensive:** run in-process, keep `withAbort`'s pre-check-only
contract (`src/postgres/abort.ts:38` — which is *already* documented as pre-check-only), keep the
deadline UDF for `statement_timeout`, and **explicitly retract** the mid-wait-cancellation half of the
G4 contract in `docs/CONTRACT.md`. Say it out loud; do not let it rot into an untested promise.

### 4.2 The shim (`src/sqlite/sql.ts`, ~250 lines with types and errors)

| postgres.js | shim | notes |
|---|---|---|
| ``sql`…` `` awaited → row array | thenable `Query`, `.execute()` → array with `.count` | 190 sites unchanged |
| `sql(name)` | `{[IDENT]: name}` → `"quoted"` splice | verified injection-safe (§3.9) |
| `sql.json(v)` | `{[JSONV]: v}` → `JSON.stringify` | 6 sites |
| `sql.array(a)` | JSON text for `json_each()` | **6 sites, needs L4/L1 sign-off (B8)** |
| `sql.unsafe(text)` | `db.exec`/`prepare` passthrough | 2 live sites |
| `sql.reserve()` | returns the same handle + no-op `release()` | 19 sites; no pool exists |
| `sql.begin(fn)` / nested | `BEGIN IMMEDIATE` / `SAVEPOINT sp_n` | 23 sites, verified |
| `sql.begin("isolation level …", fn)` | ignored — SQLite has one isolation level | `transaction-lease.ts:247` |
| `query.cancel()` | sets the SAB flag | verified in worker |
| `query.cursor(n)` | async generator over `iterate()`, macrotask tick per batch | `listKeys` |

Bind normalisation (`normalize()`), non-negotiable — it closes B6/B7:
`undefined|null → null`, `boolean → 0|1`, `Date → ISO-8601 text`, `Buffer → Uint8Array`, everything
else passthrough. **Throw on any other object** rather than let it become a named-parameter bag.

Row decoding, keyed off `st.columns()[i].type`, cached with the statement:
```
JSONB|JSON -> JSON.parse    TIMESTAMPTZ|TIMESTAMP -> new Date
BYTEA|BLOB -> Buffer.from   BOOLEAN -> v !== 0n
INT4|INTEGER|SMALLINT -> Number     BIGINT|(null type) -> leave as bigint
```
with `setReadBigInts(true)` on every statement. This is the piece that makes the shim *not* a
semantic-difference-hider: the type boundary is closed structurally, in one table, not per call site.

### 4.3 DDL convention that makes 4.2 work

```sql
CREATE TABLE umbradb_kv_current (
  ns    TEXT   NOT NULL,
  scope TEXT   NOT NULL,
  key   TEXT   NOT NULL,
  value JSONB  NOT NULL,                 -- decoder: JSON.parse
  version BIGINT NOT NULL,               -- decoder: stays bigint
  updated_at TIMESTAMPTZ NOT NULL,       -- decoder: new Date
  PRIMARY KEY (ns, scope, key)
);
```
Caveat I did not settle: `STRICT` tables only accept `INT/INTEGER/REAL/TEXT/BLOB/ANY` as declared
types, so `STRICT` and the Postgres-name decoder convention are **mutually exclusive** — pick one.
Column-name-keyed decoding is the escape hatch if `STRICT` wins.

### 4.4 `createClient` replacement (breaks G1 — this is the 2.0.0 surface)

```ts
export type UmbraDBSql = /* the shim's Sql-shaped type */;
export interface UmbraDBConnectionOptions {
  path: string;                       // was: connectionString
  readOnly?: boolean;
  busyTimeoutMs?: number;             // was: lockTimeoutMs   -> DatabaseSync { timeout }
  statementTimeoutMs?: number;        // -> deadline UDF, kept (default unchanged: 120_000)
  // REMOVED: connectionString, maxConnections, connectTimeout, idleInTxTimeoutMs
  // schema?: string  -> L4 decides whether this survives at all (it is frozen G1)
}
```
Keep `DEFAULT_STATEMENT_TIMEOUT_MS`/`DEFAULT_LOCK_TIMEOUT_MS` exported with the same numbers so the
G4 "non-zero timeout" contract text survives verbatim; drop `DEFAULT_IDLE_IN_TX_TIMEOUT_MS`.

### 4.5 Retune the batch constants (B5)
`CHUNK_INSERT_MAX_ROWS: 30_000 → 16_000`, `JUNCTION_INSERT_MAX_ROWS: 20_000 → 10_000`
(`src/postgres/checkpoint-store.ts:62-63`), and update that file's 65,534-based comments to 32,766.

---

## 5. Open questions / what I could not settle

1. **`node:sqlite`'s documented stability index.** I verified empirically that it needs no flag,
   emits no `ExperimentalWarning`, and reports `process.versions.sqlite`. I could **not** check the
   Node docs' stability marker offline. If it is still "Release Candidate", the API could change
   within Node 24's lifetime — and `createTagStore`, `backup`, `columns()`'s `type` field and
   `setReadBigInts` are all things this design leans on. **Someone must check this before the
   decision is final.** It is the single largest unquantified risk in the lane.
2. **Whether the worker thread is worth 32×.** 124 µs/op is still ~8k ops/s and far faster than a
   networked Postgres round trip, but I did not benchmark UmbraDB's actual workload mix. The
   `saveAndAdvance`/checkpoint path issues many small statements inside one transaction; batching
   those into a *single* worker message (send the whole transaction as a program, not statement by
   statement) would amortise the hop almost completely. I did not build that.
3. **`STRICT` tables vs the declared-type decoder** (§4.3). Mutually exclusive; I did not pick.
4. **Incremental BLOB I/O.** `node:sqlite` exposes no `sqlite3_blob_open`, so a 64 MiB blob is one
   ~237 ms synchronous block (or one 64 MiB `postMessage` through the worker). For the chain archive
   this may be the dominant cost. **→ L5.** I did not measure structured-clone cost for large buffers
   across the worker boundary; a `Uint8Array` can be *transferred* rather than copied, which should
   make it cheap, but I did not verify it.
5. **`sql.array` / `<@` containment** (B8) — deliberately left to L4/L1.
6. **The `INT64_MIN` type hole** (B10) — I established the behaviour but not the upstream cause, and
   did not check whether it is a known Node issue.
7. **Extension loading as an escape hatch.** `enableLoadExtension`/`loadExtension` exist, so if a lane
   concludes it needs (say) a custom collation beyond what is compiled in, it is *technically*
   possible — but shipping a compiled `.so` in the npm tarball reintroduces every native-binary
   problem this recommendation avoids. Treat "we need an extension" as a red flag that should come
   back to this lane.

---

## 6. Cost estimate

| Work | Size | Risk |
|---|---|---|
| Shim + decoder + normalise (`src/sqlite/sql.ts`) | ~250 lines new | **low** — prototyped and measured |
| Worker host + RPC + SAB cancel flag + guard UDF | ~300 lines new | **medium** — new failure modes (worker death, backpressure, transaction affinity) |
| Mechanical port of 190 `` sql`…` `` sites | ~200 edited lines across 14 adapter files, mostly `${sql(x)}.tbl` → `${sql(x)}` and dropping `::casts` | **low per site, high in aggregate** — reviewable precisely *because* the query text is preserved |
| `createClient` rewrite + `UmbraDBSql` retype | ~150 lines, `src/postgres/client.ts` | **low code / high contract** |
| Batch-constant retune + `perf-batching` re-baseline | ~10 lines + 1 test | low |
| `errors.ts` SQLSTATE → `errcode` remap | ~200 lines, **L6 owns** | flagged |
| Migration DDL rewrite (~64 `sql(schema)` DDL sites) | **L4 owns** | flagged |
| Rebuild `durability-probe.ts` (234 lines) on PRAGMA reads | ~234 lines rewritten | medium — `DurabilityContractError`/`TransactionPoolerDetectedError` are frozen G1 exports; the latter becomes meaningless |

**Lane total: roughly 900–1,100 lines of new/rewritten code, plus a ~200-line mechanical diff over the
adapters.** A clean rewrite to `node:sqlite`'s native API instead of the shim would be, by my estimate,
**3–4× larger** (every one of the 190 sites becomes hand-written `prepare`/`all`/`get`/`run` with
hand-managed parameter arrays and hand-written type conversion), and — this is the decisive argument
— it would hit B6, B7 and B10 **once per site** instead of once per codebase, with B6 failing
*silently* in the exact code path that implements the Lean-mechanized law T3.

**What it breaks:** **G1** (`UmbraDBSql`, `UmbraDBConnectionOptions`, `createClient`'s signature,
`DEFAULT_IDLE_IN_TX_TIMEOUT_MS`, and — per L4 — possibly `DEFAULT_SCHEMA`); **G2** (this is a major
version, 2.0.0, not a minor); **G4's cancellation contract** unless the worker thread is built; **G3**
indirectly, since the SQLSTATE discriminator behind the 25-code catalog is replaced by SQLite
`errcode`. It does **not** break **G4's durability, backup/restore, or forward-only-migration**
contracts — backup and `VACUUM INTO` are strictly better served here than by the Postgres adapter.
