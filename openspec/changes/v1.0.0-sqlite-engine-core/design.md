# Design — v1.0.0 SQLite Engine Core

Implementation-level design for the migration keystone. Where a decision touches an existing design
document it is cited by section number, per `openspec/config.yaml`'s design rule; where it
*overrides* one, the override is stated explicitly rather than left to inference.

**Documents this design supersedes or amends:**

- **`design/design.md` §7 ("Driver / toolkit choice")** — currently: *"`postgres.js` (npm
  `postgres`). Tagged-template `sql` function gives parameterized, injection-safe hand-written SQL …
  if `postgres.js`'s actual installed `.d.ts` surface … doesn't cover a need found during
  implementation … fall back to `pg` before reaching for an ORM."* §1 below **replaces** that
  section's conclusion. Its *reasoning* is preserved intact and is the reason §2 specifies a shim
  rather than a rewrite: the tagged-template, hand-written-SQL, no-ORM style is retained.
- **`design/design.md` §8 ("Test infrastructure")** — resolved in favour of Testcontainers
  PostgreSQL. That resolution lapses with the engine; the replacement is a file path, not a
  container. This change does not author the test architecture (change 4 owns fixtures), but §7
  below records the consequence so nobody re-derives it.
- **`design/design.md` §5 ("Commit/transaction layer")** — §3 below changes *where the handle
  lives*, not what a transaction means. The commit/rollback algebra is unchanged.
- **`design/design-interfaces.md` §1.2 ("Async pattern")** — preserved exactly. Every public method
  stays `async`; §3.4 explains why a synchronous binding behind an async surface preserves every
  interleaving the existing tests can observe, and what it does *not* preserve.
- **`design/design-interfaces.md` §1.3 ("Transaction participation")** and **§3.1 (Transaction/Lease
  layer)** — §3.3 below **strengthens** the handle's opacity. The interface's semantics are
  unchanged; what changes is that a handle stops carrying database access.
- **`Formal/STORAGE_ALGEBRA.md` §1 (T3 temporal projection, T5 temporal coherence)** — untouched by
  this change. §5.2 records that two of the traps here are *silent falsification paths into T3*, and
  §9 records why the Lean cut-line's survival is not evidence of safety.
- **`Formal/STORAGE_ALGEBRA.md` §5 (P1–P10 testable-law deliverable)** — §9 requires re-execution,
  not amendment.

---

## 0. What this change decides, and what it hands off

| Decided here | Handed off |
|---|---|
| Which binding, and on what grounds (§1) | The DDL that the decoder keys off — **change 4** |
| The shim's contract: normalise, decode, split (§2) | The event-log schema and clock policy — **change 2** |
| Handle lifecycle, no pool, option surface (§3) | The lease mechanism, `BEGIN IMMEDIATE`, poison — **change 3** |
| Worker topology and the unforgeable handle (§3.3) | Contract text, catalog, backup, checksums — **change 5** |
| The streaming primitive across the worker boundary (§3.5) | What `listKeys` still *promises* — **change 2** |
| Pragma bootstrap **order** (§4.1) | Pragma **values** — blocked on §6 |
| The blocking ext4 measurement gate (§6) | Everything that cites a number (§6.3) |
| The cross-change correction register (§10) | The chain archive's port — **change 6**; the PostgreSQL→SQLite data migration — **change 7** |

---

## 1. The driver ruling

### 1.1 The disagreement, stated fairly

**L3 (`reports/l3-driver.md` §1) recommends `node:sqlite`**, Node's built-in. Its case is strong and
mostly correct: zero new npm packages, zero native binaries, nothing for `npm audit --omit=dev` or
the `ignore-scripts=true` gate to chew on, nothing that can fail `pack-smoke.yml` on an unsupported
platform. It exposes `columns()` origin metadata, `createTagStore()`, an async `backup()`,
`VACUUM INTO`, UDFs, aggregates, sessions/changesets, `enableDefensive()` and `setAuthorizer()`.
L3 built a 130-line shim on it and ported real `PgTemporalKV` query bodies onto it verbatim.

**The commitments seat (`council/commitments.md` R5) rules against it.** Its objection is not risk
magnitude but *observability of the frame*: `docs/STABILITY.md:18` commits UmbraDB to *"No breaking
changes to the exported surface or the error-`code` set in a minor or patch release."* You cannot
make that promise about a surface whose runtime substrate reserves the right to change in a minor.
`postgres@^3.4.9` is locked in `package-lock.json`, hashed in `docs/supply-chain/inventory.md:26`
(`sha512-GD3qdB0x…KDLnaw==`) and gated by `.github/workflows/supply-chain.yml`. A platform module
appears in **none** of the three: `supply-chain.yml:61-79` runs `npm ci` and
`npm audit --audit-level=high --omit=dev`, both of which are lockfile-scoped and structurally blind
to it. A Node patch upgrade can change both the bundled SQLite version and the module's API shape
under a frozen contract, and no lockfile row, no inventory row, no CI gate and — measured — no
runtime warning will say so.

**Per the authoring brief, where a council seat contradicts a lane report the council wins.** But
the ruling below does not rest on precedence; four independent measurements taken for this change
move the decision further in the seat's direction than the seat itself could see.

### 1.2 Ruling

**Adopt a version-pinned third-party binding. Concretely: `better-sqlite3`, pinned in
`package.json` and `package-lock.json`, inventoried in `docs/supply-chain/inventory.md`, with its
vendored SQLite version asserted in CI.**

Five reasons, in decreasing weight. Reasons 3–5 are new to this change and each is measured; the
commands and outputs are in §4.

1. **The frame problem is decisive and is not a risk trade.** `docs/STABILITY.md:18` and
   `docs/ERROR-CATALOG.md:11-13` make a promise UmbraDB cannot keep about an unobservable substrate.
   The supply-chain trade is roughly a wash — an auditable, hashed npm package containing a prebuilt
   binary versus an unpinnable platform API no gate can observe. The *stability* trade is one-sided.

2. **`node:sqlite` is silently experimental at the declared floor.** `package.json:31-33` declares
   `engines: {"node": ">=24"}`. Re-verified for this change (§4.2): on `node v24.18.0`, importing
   `node:sqlite`, opening a database and running DDL registers **zero** process warnings under a
   `process.on("warning")` probe. An experimental API that announces itself is a manageable risk; one
   that does not is invisible to every mechanism this project has for noticing things.
   `engines: >=24` also cannot be raised to buy release-candidate status: Node 25 is the non-LTS
   line, and raising an `engines` floor is itself a breaking change.

3. **L3's own supply-chain objection to `better-sqlite3` was already refuted by L3, and this change
   re-confirms it.** `better-sqlite3@13.0.2` declares **no** `install` or `postinstall` script
   (measured, §4.3 — its `scripts` are `build-release`, `build-debug`, `test`, `benchmark`,
   `download`, `clean`) and ships **8 prebuilds inside the npm tarball**
   (`prebuilds/{darwin,linux,linuxmusl,win32}-{x64,arm64}.node`). `.npmrc`'s `ignore-scripts=true`
   and `supply-chain.yml:45-59`'s effective-`ignore-scripts` drift guard are therefore **not**
   breached. The one hard blocker against a native binding does not exist.

4. **L3's "newest SQLite of any candidate" advantage is inverted.** Measured (§4.1, §4.2):
   `better-sqlite3@13.0.2` → **SQLite 3.53.4**; `node:sqlite` on `node v24.18.0` →
   `process.versions.sqlite` **3.53.1**. L3's §1 prose asserts the built-in "ships the newest SQLite
   of any candidate (3.53.1 vs better-sqlite3's 3.53.4)" — a sentence its own numbers contradict.
   Strike it from the ledger; the binding is the newer engine, not the older one.

5. **The binding turns the sprint's worst silent-corruption trap loud.** A positionally bound `Date`
   on `node:sqlite` is stored as **NULL with no error** (re-measured, §4.2: `{"x":null,"t":"null"}`).
   On `better-sqlite3` it **throws**: `SQLite3 can only bind numbers, strings, bigints, buffers, and
   null` (§4.4). The affected call sites — `src/postgres/temporal-kv.ts:254` and `:257`, the
   `${asOf.at}::timestamptz` binds in `getAtImpl` — implement **T3**
   (`Formal/STORAGE_ALGEBRA.md` §1, "Law T3 — temporal-projection / observational equivalence"), a
   Lean-mechanised cut-line law. The shim closes this trap on either driver (§2.2); choosing the
   driver that *also* fails loudly is defence in depth on a proved property, and it costs nothing.

### 1.3 What the ruling costs, stated without hedging

- **+2 runtime packages** (`better-sqlite3` + `node-addon-api`), taking `dependencies` from
  `{postgres, zod}` to `{better-sqlite3, zod}` — a net wash in count, not a reduction. L3's
  "zero runtime dependencies" framing was already doubly wrong: the current graph is 2, and `zod`
  is load-bearing for `VALIDATION_FAILED` at every boundary.
- **~27 MB of `node_modules`** and an N-API binary inside a tree whose supply-chain workflow exists
  specifically to keep foreign code out. That binary is hashed, lockfile-pinned and gate-visible,
  which is the whole point — but it is foreign code.
- **A platform tail risk**: a consumer platform with no prebuild must compile, which needs a
  toolchain and could fail `pack-smoke.yml`. The 8 shipped prebuilds cover
  darwin/linux/linuxmusl/win32 × x64/arm64.
- **Two capabilities are given up.** `better-sqlite3`'s `Database.prototype` is, measured (§4.5):
  `constructor, prepare, transaction, pragma, explain, backup, serialize, function, aggregate,
  table, loadExtension, exec, close, defaultSafeIntegers, unsafeMode`. There is **no**
  `enableDefensive`, **no** `setAuthorizer`, and **no** session/changeset member. The commitments
  seat R5(a) required that whichever binding wins be checked against exactly these; it has been, and
  they are absent. **Consequence, binding on the rest of the sprint:** no requirement in any of the
  five changes may depend on `enableDefensive()`, `setAuthorizer()` or the session extension. If a
  later change needs one, it reopens this ruling rather than working around it.
- **Neither driver fixes cancellation.** Both are synchronous and neither exposes
  `sqlite3_interrupt` (measured for both, §4.2/§4.5). The worker (§3.3) is required either way, and
  `docs/CONTRACT.md` §3 still changes — that is change 5's, not a consequence this ruling avoids.

### 1.4 The consequence had the ruling gone the other way

Recorded so the decision is falsifiable rather than merely stated. Choosing `node:sqlite` would
require, as a *precondition of the 1.0.0 tag*, either (a) an amendment to `docs/STABILITY.md:18`
carving the storage substrate out of the no-breaking-changes-in-a-minor promise — which is a
weakening of the project's headline stability commitment, made at the moment it takes force — or
(b) pinning the patch-level Node version in `engines`, which is not something a library may do to
its consumers. Neither is acceptable, and the absence of a third option is why this ruling is
mandatory rather than preferential.

### 1.5 A trap the ruling *introduces*, and must therefore close

`better-sqlite3` reads integers as JS `number` by default and **silently truncates** beyond 2^53.
Measured (§4.5): `9223372036854775807n` written, read back as `9223372036854776000`;
`9007199254740993n` read back as `9007199254740992`. `node:sqlite` **throws** `ERR_OUT_OF_RANGE` in
the same situation.

This is a real regression introduced by the swap, and it lands on a load-bearing column: UmbraDB's
`version` is a `bigint` end to end — `src/postgres/client.ts:10` types `UmbraDBSql` as
`Sql<{bigint: bigint}>` and `:182` configures `types: { bigint: postgres.BigInt }` precisely so
`version` columns round-trip as real `bigint`, matching `StoredVersionSchema` in
`src/interfaces/temporal-kv.ts`.

**Therefore `defaultSafeIntegers(true)` is mandatory at handle construction, is a requirement (not a
configuration note), and carries a negative-control scenario.** The decoder (§2.3) then downcasts
the columns that must be `number` rather than the reverse — the same direction of travel L3
established, on the opposite default.

---

## 2. The shim

### 2.1 Shim, not rewrite

`design/design.md` §7's reasoning is retained: hand-written SQL, tagged templates, no ORM. The shim
(`src/sqlite/sql.ts`) reproduces the `postgres.js` call shape so query text ports with a mechanical
diff instead of being rewritten. The decisive argument is not line count: a native-API rewrite meets
each of the traps in §5 **once per call site**, and the `Date` trap fails *silently* in the exact
code path that implements T3. One normalisation table and one decoder table close them once.

Surface reproduced, with the site counts verified in this worktree:

| `postgres.js` | shim | verified count |
|---|---|---|
| `` sql`…` `` awaited → row array | thenable `Query`, `.execute()` → array with `.count` | ~190 sites (L3) |
| `sql(name)` identifier splice | quoted-identifier splice, injection-safe | per-adapter |
| `sql.json(v)` | `JSON.stringify` bind | 6 sites |
| `sql.array(a)` | JSON-text bind for `json_each()` — **shape only; change 4 owns whether it is the right index strategy** | 6 (`grep -rn 'sql.array(' src/` → 6) |
| `sql.unsafe(text)` | passthrough to `exec`/`prepare` | 2 live sites |
| `sql.reserve()` | returns the same handle, no-op `release()` — no pool exists | 10 (`grep -rn '\.reserve()' src/`) |
| `sql.begin(fn)` / nested | `BEGIN IMMEDIATE` / `SAVEPOINT` — **change 3 owns the semantics** | 20 (`grep -rn '\.begin(' src/`) |
| `sql.begin("isolation level …", fn)` | ignored; SQLite has one isolation level | `transaction-lease.ts` |
| `query.cursor(n)` | async generator yielding to a macrotask tick per batch | `listKeys` |

### 2.2 Bind normalisation — the trap-closing layer

`normalize()` runs on **every** bound value before it reaches the binding. Non-negotiable rules:

| input | output | why |
|---|---|---|
| `undefined` / `null` | `null` | — |
| `boolean` | `1` / `0` | the binding rejects booleans outright (§4.4) |
| `Date` | **epoch-milliseconds integer** | see below |
| `Buffer` / `Uint8Array` | `Uint8Array` | — |
| `bigint`, `number`, `string` | passthrough | — |
| anything else | **throw** | never let an object become a named-parameter bag |

**`Date` → integer, not ISO-8601 text.** This overrides L3 §4.2, which specified
`Date → ISO-8601 text`, and adopts the contradiction seat's ruling (`council/contradiction.md` §2.3(b)).
L3's remedy closes its own B6 and opens a second, identical-class hole: with `written_at` stored as
`INTEGER` epoch-ms and read via `WHERE written_at <= :T ORDER BY written_at DESC LIMIT 1`, an
ISO-text bind makes the comparison cross-type, and **every INTEGER sorts before every TEXT in
SQLite**. The seat measured `getAt` returning the *latest* version for every `at`, always, with no
error — **T3 silently false**. Two lanes reached this destination independently (L7 B6 by a
different mechanism: a `BYTEA`-declared column taking NUMERIC affinity and storing `"42"` as an
integer).

The `Date` rule has a **structural backstop** that only exists because change 4 chooses `STRICT`
tables: measured (§4.6), writing TEXT into an `INTEGER` column of a `STRICT` table raises
`SQLITE_CONSTRAINT_DATATYPE` — *"cannot store TEXT value in INTEGER column kv_event.written_at"* —
where a non-`STRICT` table stores it silently. So the wrong normalisation is **loud** under the
schema change 4 specifies and **silent** without it. That coupling is stated here so neither change
can drop its half unilaterally (§5.3).

### 2.3 Row decoding — keyed on origin metadata, never on declared type names

L3's "decisive discovery" was that `columns()` returns each column's **declared type name verbatim**
(`JSONB`, `TIMESTAMPTZ`, `BYTEA`, `INT4`), letting the shim reproduce `postgres.js`'s OID-driven
decoding with no call-site annotation. That is true of a *non-`STRICT`* table and false of the schema
this migration is adopting. Measured (§4.6):

- A `STRICT` table **rejects** `JSONB`, `BYTEA`, `TIMESTAMPTZ`, `BIGINT` and `INT4` as declared
  types outright — `unknown datatype for s_JSONB.a: "JSONB"`.
- Under `STRICT`, `columns()[i].type` is only ever `TEXT` / `INTEGER` / `BLOB` / `REAL` / `ANY`, so
  a JSON document and a plain string are indistinguishable by declared type.

**Therefore the decoder is keyed on `(origin table, origin column)`, not on `type`.** Verified on
the ruled binding (§4.6): `columns()` returns `{name, column, table, database, type}`, and origin
survives **aliasing** (`select value as v` → `{name:"v", column:"value", table:"kv_event"}`) and
**views** (`select … from kv_validity` → `valid_from` resolves to `kv_event.written_at`). The
contradiction seat established the same on `node:sqlite` and stress-tested subqueries, CTEs, JOINs
and `UNION ALL`; the property is SQLite's `ENABLE_COLUMN_METADATA`, which is compiled into both
(§4.5).

**The known hole, and its fix.** A window function loses origin. Measured (§4.6):
`lead(written_at) over (…) as valid_to` → `{name:"valid_to", column:null, table:null, type:null}`.
In change 2's proposed `kv_validity` view, `valid_from` and `valid_to` are the same logical type and
would decode **differently** — `valid_from` as a `Date`, `valid_to` falling through as a `bigint`.
This is a silent wrong-type bug, not a crash. The decoder registry therefore requires an explicit
`(view, output column) → decoder` entry for every derived column, and the shim must **throw** on a
result column that has no origin and no explicit registry entry rather than guessing. Failing closed
is what makes this catchable; the alternative is a value that is merely the wrong JS type.

### 2.4 The parameter ceiling

`SQLITE_MAX_VARIABLE_NUMBER` is **32,766** on the ruled binding (measured, §4.5, from
`pragma_compile_options`). `src/postgres/checkpoint-store.ts:62-63` sets
`CHUNK_INSERT_MAX_ROWS = 30_000` (2 params/row) and `JUNCTION_INSERT_MAX_ROWS = 20_000`
(3 params/row) — both deliberately sized at 60,000 params against PostgreSQL's 65,534 cap, as that
file's own comments at `:54-61` state. Measured on the ruled binding (§4.6): 16,383 rows × 2 params
= 32,766 **prepares OK**; 16,384 × 2 = 32,768 **fails** `too many SQL variables`; 30,000 × 2 =
60,000 **fails**. This is a day-one runtime failure, not a tuning question.

The shim owns the split so no call site has to know the ceiling: a batch that would exceed it is
divided into statements that do not. The *chosen* chunk size is a throughput/statement-count trade
and is **blocked on §6** (B-5), because splitting doubles the statement count per save — which is
exactly the "EXACTLY ONE statement per checkpoint" property `checkpoint-store.ts`'s comments defend
— and each additional statement costs a worker round trip (§3.4). `test/postgres/perf-batching.test.ts`
re-baselines against the measured value.

---

## 3. Handle lifecycle and worker topology

### 3.1 One file, one handle, no pool

`createClient` (`src/postgres/client.ts:147`) currently returns a `postgres.js` pool. An embedded
engine has no pool to size: the replacement opens exactly one database file and returns one handle.

**Corrected derivation — do not rest this on transaction serialization.** An earlier draft justified
"one writer" by observing that a second `BEGIN IMMEDIATE` raises `SQLITE_BUSY` (§4.6). Per change 6:
**SQLite serializes transactions; it does not make a process a single writer.** Two processes
interleaving `BEGIN IMMEDIATE` transactions is legal and undetected — the busy error proves
*mutual exclusion between transactions*, not *exclusivity between writers*. What this change
actually establishes is narrower and sufficient for its own purpose: **one handle per file, owned by
one worker, within one process** (§3.3, §3.2's per-file rule). Single-*writer-process* exclusivity is
not a property of SQLite and is not claimed here — it is enforced, where it is enforced at all, by
change 3's writer-generation mechanism for the wallet file and change 6's for the archive file. Any
argument in this change that appears to rest on "SQLite gives us a single writer" should be read
against those mechanisms instead. `DEFAULT_SCHEMA` and schema-configurability survive as *concepts* —
**change 4 owns what a schema becomes** (table-name prefixing); this change only notes that the
`sql(identifier)` splice mechanism ports cleanly and is injection-safe.

### 3.2 The option surface, and why retired keys must be rejected

| today (`client.ts:44-77`) | replacement | note |
|---|---|---|
| `connectionString` | `path` | a filesystem path |
| `schema` | retained | change 4 owns its meaning |
| `maxConnections` | **removed** | no pool exists |
| `connectTimeout` | **removed** | no TCP handshake |
| `lockTimeoutMs` | `busyTimeoutMs` | maps to `busy_timeout`; measured, the binding's `{timeout: N}` constructor option sets `PRAGMA busy_timeout` to `N` (§4.6). **Change 3 rules on whether it is used at all** — a *blocking* `busy_timeout` fails P10 and deadlocks inside the worker too |
| `statementTimeoutMs` | retained | enforced by a deadline guard inside the worker (§3.4) |
| `idleInTxTimeoutMs` | **removed** | no analogue; `DEFAULT_IDLE_IN_TX_TIMEOUT_MS` (`client.ts:145`) is dropped from the surface |

`DEFAULT_STATEMENT_TIMEOUT_MS` and `DEFAULT_LOCK_TIMEOUT_MS` (`client.ts:143-144`) keep their
exported names and their current numbers so `docs/CONTRACT.md`'s non-zero-timeout text survives
verbatim; change 5 owns the contract prose.

**Retired keys are rejected, not forwarded.** Measured (§4.7): `better-sqlite3` accepts
`{maxConnections, idleInTxTimeoutMs, connectionString, statementTimeoutMs}` **silently** and opens
normally. So a "compatibility" client that forwarded today's option bag would appear to work while
dropping every durability bound the caller asked for. This mirrors the discipline
`client.ts:155-168` already applies to timeout overrides — malformed config fails fast, here, with a
clear message — and extends it to the keys that no longer mean anything.

### 3.3 The worker boundary, and the enhancement

**Topology.** One `node:worker_threads` worker owns the single `Database`. The main thread holds a
proxy that speaks a message protocol. Verified for the ruled binding (§4.8): `better-sqlite3` loads
and runs inside a worker (`{"ok":true,"row":{"a":42}}`), and its compiled `THREADSAFE=2` is
consistent with one handle per thread.

**The enhancement — an unforgeable transaction-identity guard.** Today
`src/postgres/transaction-lease.ts:57` exports `resolveTransaction(handle): ISql<{bigint: bigint}>`,
which hands a live driver object across a module boundary: a caller in possession of a
`TransactionHandle` is in possession of database access, and the guard against reusing a handle is a
*check*, not a *barrier*. Under the worker boundary the handle becomes an **opaque token** minted by
the worker and validated against the worker's own live-transaction table. A token that the worker did
not mint, or that names a transaction that has ended, cannot be made to execute anything — there is
no object on the caller's side to call. This is a genuine strengthening of
`design/design-interfaces.md` §1.3 and §3.1 that PostgreSQL could not provide, and it is why the
worker is worth building even though it does **not** rescue cancellation (§3.4).

Note the credit is narrow: the red team established that `TRANSACTION_KEY_REUSE` forgery already
failed under the Postgres design, and that the credit for that belongs to UmbraDB owning the
transaction handle rather than to any worker thread. What the worker adds is that the guard stops
depending on callers not reaching around it.

### 3.4 What the worker costs, and the limit it cannot cross

Recorded because the temptation is to bill the worker as free.

- **Per-operation latency**: ~32× on a point read (L3: 3.86 µs in-process → 124 µs across the hop;
  the red team reproduced 30.96×).
- **Transport is not a fixed cost — it grows with payload.** The feasibility seat's "fixed ~101 µs
  per round trip" is wrong; the red team measured **114.7 µs** at 1 statement/message, **151.5 µs**
  at 10, **503.6 µs** at 100.
- **Amortisation works where UmbraDB owns the program**: a `saveAndAdvance`-shaped 14-statement
  program shipped as one message is ~168.8 µs against ~52 µs in-process — ~3.2×.
- **It is structurally unreachable for `withTransaction(fn)`.** That is a frozen export whose body is
  arbitrary caller code running on the main thread; `src/interfaces/transaction-lease.ts:172` says so
  itself — the layer has *"no mechanism … to interrupt it partway through."* You cannot ship a JS
  closure to a worker as a program. A 3-statement caller callback measured **538.7 µs of pure
  transport** on a ~37 µs operation.
- **A cost no lane and no seat priced**: with a worker, `withTransaction` holds `BEGIN IMMEDIATE` on
  the worker across every main-thread round trip. That is a *whole-database* write mutex, so the
  worker lengthens the global write-lock hold by ~110 µs per caller statement — it makes change 3's
  worst finding measurably worse. **This interaction is blocked on §6 (B-4)**: the transport figures
  are IPC-bound and were reproduced, but their *interaction with commit latency* has only ever been
  measured against a RAM disk.

**The worker's actual justification is liveness, not cancellation.** A synchronous binding on the
main thread blocks the event loop proportionally to the work: L3 measured a 500k-row `.all()`
blocking for **429 ms** and a 64 MiB blob write for **237 ms**, against a 0.15–0.3 ms idle baseline.
UmbraDB is embedded in a wallet whose sync loop and RPC keep-alives share that loop; a 429 ms stall
is a dropped websocket heartbeat. That is a liveness bug independent of any contract clause, and it
is what the worker fixes.

**What it does not fix.** Neither binding exposes `sqlite3_interrupt` (§4.2, §4.5). A worker plus a
`SharedArrayBuffer` flag polled by a guard UDF cancels a *row-visiting* statement (L3 measured ~1 ms
cancellation latency with the main loop still ticking at ≤0.6 ms lag), but only where the planner
re-invokes the guard per row. The caller still loses mid-read abort on any statement whose cost is
inside SQLite and whose text UmbraDB does not control — `listKeys` over a caller-supplied prefix, and
every statement issued inside `withTransaction`. **`docs/CONTRACT.md` §3's cancellation clause
therefore still changes, and change 5 owns that deletion.** This change must not be read as having
preserved it.

### 3.5 Streaming across the worker boundary

This section resolves a seam change 4 found, recorded at its `design.md` §16.5 and open question 7,
and correctly declined to take. It is engine-topology work.

**The merged requirement is normative.** `openspec/specs/temporal-kv/spec.md:213` requires that
`listKeys` *"SHALL yield keys incrementally via a database cursor (**SHALL NOT** load the entire
matching result set into memory before yielding its first item)"*, with the scenario *"The first key
is yielded before the full scan completes"* and a second scenario requiring that an abort mid-
iteration *"reject with `AbortError`"* and that *"the underlying database cursor SHALL be released,
not left open."* Today that is a real `postgres.js` server cursor — `query.cursor(256)` at
`src/postgres/temporal-kv.ts:324-325`.

#### 3.5.1 Change 4's assessment is half right, and the half it got wrong is the good half

Change 4 §16.5 records the streaming property as implemented by *"a postgres.js server-cursor
mechanism with no SQLite analogue."* **Measured, that is false for the ruled binding** (§4.9): a
prepared statement's `iterate()` is genuinely lazy. Over a 200,000-row table, the **first row arrived
in 0.11 ms** while full materialisation of the same query took **109 ms** — a factor of ~990. The
in-process streaming property is not merely satisfiable, it is comfortably satisfiable, and no
rewording of the merged requirement is needed on that account. Change 4's caution was reasonable on
the information it had (its statement is about `StatementSync`, the *rejected* binding's API); it is
superseded by measurement on the binding this change actually rules for.

**The coordinator's diagnosis is the correct one: the problem is the worker, not the engine.** Once
the handle lives on a worker, "yield the first key before the scan completes" stops being a local
iterator and becomes a streaming protocol across a thread boundary — and §3.4 establishes that
transport cost grows with payload rather than being fixed, so a row-per-message stream is
pathological and a whole-result-set message is exactly the materialisation the requirement forbids.

#### 3.5.2 The mechanism: the worker holds the iterator, the main thread pulls batches

The worker opens the iterator and keeps it. The main thread's async generator pulls **one batch per
round trip** and yields that batch's rows locally, one at a time, to its consumer. Time-to-first-row
is therefore one round trip plus one batch of iteration — not one scan. The consumer's `for await`
loop sees rows incrementally, which is what the requirement asks for and what the batch protocol
preserves.

**Batch size is not picked here.** It trades three quantities against each other — round-trip count,
per-message transport (which grows with payload), and *cancellation latency*, since an abort
arriving mid-batch cannot be observed until that batch finishes. In-process I measured a 256-row
batch at **1.138 ms worst case** over 200k rows (§4.9) and L3 measured the same shape at 2.9 ms
worst case over 500k; neither figure includes the worker hop, and neither was taken on the target
filesystem. It is therefore a **measurement obligation under the gate — B-8 in §6.3**, not a
constant in this document.

#### 3.5.3 The hazard nobody had: an open stream wedges the writer

This is the finding that makes the section necessary, and it is worse than the one change 4 flagged.

Measured (§4.9): **while an iterator is open, a write on the same handle is refused** —
`This database connection is busy executing a query`. Reads still succeed; writes do not. Calling
`iterator.return()` restores writes immediately.

Under PostgreSQL this hazard does not exist: the cursor lives on a **pooled** connection, so a
half-consumed `listKeys` inconveniences one connection out of a pool and blocks nobody's writes.
Under a single-handle worker, a half-consumed `listKeys` blocks **every write in the process** for
as long as the stream is open — and the stream's lifetime is controlled by the **consumer**, not by
UmbraDB. `src/postgres/temporal-kv.ts:295-302` already documents this exact residual limitation for
the Postgres implementation:

> if the CONSUMER stops calling `.next()` on this generator entirely (neither continuing iteration
> nor explicitly calling `.return()`/`break`) and then aborts, this generator's own body is suspended
> at `yield` and simply isn't running any code to notice — no async generator can be "pushed" from
> outside without the consumer resuming it.

That limitation was accepted because its consequence was a leaked pooled connection. Its consequence
is now a **wedged writer**, which is not the same limitation and may not be inherited silently. It is
also the concrete shape of the `idle_in_transaction_session_timeout` backstop the migration
otherwise loses.

#### 3.5.4 What replaces `query.cancel()`

Today's abort path is `iterator.return()` **plus** `query.cancel()` — a real Postgres-protocol
cancellation on a second connection, added after an audit found that `return()` alone is a silent
no-op before the first batch arrives (`src/postgres/temporal-kv.ts:279-289`). §3.4 establishes that
protocol-level cancellation has no counterpart here, so the replacement cannot be a translation of
that design. It is a reallocation of responsibility:

**Stream liveness moves from the consumer to the worker.** Because the worker holds the iterator, the
worker can release it without the consumer's cooperation — which is precisely what the Postgres
implementation could not do. Three mechanisms, all owned here:

1. **Abort delivery by message.** An abort on the main thread sends a release message; the worker
   calls `iterator.return()`. Between batches this takes effect immediately. *Within* a batch it is
   bounded by batch duration — the second reason batch size is a gate item (B-8) and not merely a
   throughput knob.
2. **A stream idle deadline, enforced by the worker.** If the main thread does not request the next
   batch within a bounded interval, the worker releases the iterator on its own initiative. The
   stream then fails on its next pull with a typed error. This converts the wedged-writer outcome of
   §3.5.3 into a failed read, which is the correct trade: a stalled `listKeys` must not be able to
   stop the wallet from writing. The interval's value is B-8.
3. **Release on shutdown.** Measured (§4.9): `db.close()` with an open iterator **throws**
   `This database connection is busy executing a query`. The worker must therefore release
   outstanding iterators before closing, or it cannot shut down cleanly — a failure mode that would
   otherwise appear only at process exit.

Mechanism 2 is a **strengthening** relative to today: the current implementation's own documentation
concedes that a suspended consumer cannot be pushed from outside, and under the worker boundary it
can. It should be claimed as one, and change 2 should say so when it restates what `listKeys`
promises.

#### 3.5.5 A consequence to measure, not to assert

A long-lived read holds a WAL read snapshot, which prevents the WAL from being checkpointed and
truncated for the stream's duration. Whether that matters at UmbraDB's sizes is unknown to this
sprint — nobody measured it, and every existing WAL-growth figure is tmpfs-tainted. It is folded into
B-8 as a recorded quantity rather than stated as a bound.

#### 3.5.6 The boundary with change 2

**This change specifies the mechanism; change 2 states what `listKeys` still promises.** Concretely:

- On the evidence in §4.9, the merged requirement's streaming scenario **survives** and change 2
  should not need to weaken it. If change 2 nonetheless proposes to reword or remove it, it should
  cite a measurement that contradicts §4.9 rather than the "no SQLite analogue" premise, which is
  superseded.
- The merged abort scenario's clause *"the underlying database cursor SHALL be released, not left
  open"* survives in substance but changes mechanism — release is by worker message and worker-side
  deadline, not by `query.cancel()`. Change 2 owns that wording.
- The requirement's other two properties — newest-version-only and stable ordering — are untouched
  by this change; change 4 §11.4 already establishes that `BINARY` satisfies "stable".

---

## 4. Evidence

Every command below was run for this change on this machine. `better-sqlite3@13.0.2` was already
present at `/tmp/l3-bs3b` from the research phase; **no `npm install` was run**, and nothing was
written to `src/` or `test/`.

### 4.1 Environment

```
$ node -v
v24.18.0
$ cd /tmp/l3-bs3b && node -p "require('better-sqlite3/package.json').version"
13.0.2
```

### 4.2 `node:sqlite` at the declared `engines` floor

```
$ node /tmp/udb-verify/ns-probe.mjs
node: 24.18.0
process.versions.sqlite: 3.53.1
node:sqlite Date positional bind: {"x":null,"t":"null"}      <- SILENT NULL
node:sqlite has interrupt: false
node:sqlite columns(): [{"column":"x","database":"main","name":"x","table":"t","type":"TIMESTAMPTZ"}]
warnings emitted: []                                          <- no ExperimentalWarning of any kind
```

### 4.3 The binding's install-script and prebuild posture

```
bs3 scripts: {"build-release":…,"build-debug":…,"test":…,"benchmark":…,"download":…,"clean":…}
bs3 has install/postinstall: false
bs3 deps: {"node-addon-api":"^8.0.0"}
native artifacts: ["prebuilds/darwin-arm64.node","prebuilds/darwin-x64.node",
  "prebuilds/linux-arm64.node","prebuilds/linux-x64.node","prebuilds/linuxmusl-arm64.node",
  "prebuilds/linuxmusl-x64.node","prebuilds/win32-arm64.node","prebuilds/win32-x64.node"]
```

### 4.4 Bind-time behaviour on the ruled binding

```
Date positional bind: {"threw":true,"message":"SQLite3 can only bind numbers, strings, bigints, buffers, and null"}
boolean bind:         {"threw":true,"message":"SQLite3 can only bind numbers, strings, bigints, buffers, and null"}
lone surrogate roundtrip: {"equal":false,"got":"\"a�b\"","length":3}
NUL byte length(): [{"jsLen":3,"sqlLen":3},{"jsLen":3,"sqlLen":1}]     <- JS sees 3, SQL sees 1
```

### 4.5 Engine, API surface, integer fidelity

```
sqlite_version: 3.53.4
compile_options: ENABLE_COLUMN_METADATA | MAX_ATTACHED=10 | MAX_LENGTH=1000000000 |
                 MAX_VARIABLE_NUMBER=32766 | THREADSAFE=2
Database.prototype: constructor, prepare, transaction, pragma, explain, backup, serialize,
                    function, aggregate, table, loadExtension, exec, close,
                    defaultSafeIntegers, unsafeMode
Statement.prototype: run, get, all, iterate, bind, pluck, expand, raw, safeIntegers, columns, toString
has interrupt: false
members matching /defens|author|session|changeset/: []        <- no enableDefensive, no setAuthorizer

bigint default read (2^63-1 written):   9223372036854776000   <- SILENT TRUNCATION
safeIntegers read:                      9223372036854775807   <- exact
default read of 2^53+1:                 9007199254740992      <- SILENT TRUNCATION
safeIntegers read of 2^53+1:            9007199254740993
```

### 4.6 Schema, decoding, ceilings, locking

```
STRICT declared type JSONB:       REJECTED: unknown datatype for s_JSONB.a: "JSONB"
STRICT declared type BYTEA:       REJECTED: unknown datatype for s_BYTEA.a: "BYTEA"
STRICT declared type TIMESTAMPTZ: REJECTED: unknown datatype for s_TIMESTAMPTZ.a: "TIMESTAMPTZ"
STRICT declared type BIGINT:      REJECTED   STRICT declared type INT4: REJECTED
STRICT declared type TEXT/INTEGER/ANY: ACCEPTED

non-STRICT columns() type text: [{"name":"v","type":"JSONB"},{"name":"w","type":"TIMESTAMPTZ"},{"name":"h","type":"BYTEA"}]
STRICT     columns() type text: [{"name":"v","type":"TEXT"}, {"name":"w","type":"INTEGER"},    {"name":"h","type":"BLOB"}]

columns() plain:   [{"name":"value","column":"value","table":"kv_event","database":"main","type":"TEXT"}, …,
                    {"name":"c","column":null,"table":null,"database":null,"type":null}]
columns() aliased: [{"name":"v","column":"value","table":"kv_event"},{"name":"w","column":"written_at","table":"kv_event"}]
columns() view:    [{"name":"value","column":"value","table":"kv_event"},
                    {"name":"valid_from","column":"written_at","table":"kv_event"},   <- origin survives the rename
                    {"name":"valid_to","column":null,"table":null,"type":null}]       <- LEAD() loses origin

STRICT TEXT-into-INTEGER: {"threw":true,"code":"SQLITE_CONSTRAINT_DATATYPE",
                           "message":"cannot store TEXT value in INTEGER column kv_event.written_at"}

prepare 16383 rows x2 = 32766 params: OK
prepare 16384 rows x2 = 32768 params: FAIL: too many SQL variables
prepare 30000 rows x2 = 60000 params: FAIL: too many SQL variables     <- checkpoint-store.ts:62

busy_timeout after {timeout:3000}: 3000        busy_timeout after {timeout:0}: 0
second BEGIN IMMEDIATE: {"message":"database is locked","code":"SQLITE_BUSY","name":"SqliteError"}
constraint error shape: {"code":"SQLITE_CONSTRAINT_PRIMARYKEY","message":"UNIQUE constraint failed: uq.i"}

# no sticky poison — re-confirmed on the ruled binding
inTransaction after failed stmt: true
next stmt after failed stmt: SUCCEEDED
rows committed after swallowed error: [{"i":1},{"i":2}]
```

**Pragma bootstrap order, on the ruled binding, both orders on fresh files:**

```
correct order (page_size, auto_vacuum, WAL): {"page_size":16384,"auto_vacuum":2,"journal_mode":"wal"}
WAL first, then page_size/auto_vacuum:       {"page_size":4096, "auto_vacuum":0,"journal_mode":"wal"}
```

Both sequences report success. The second is permanent.

### 4.7 Option handling

```
unknown option keys {maxConnections, idleInTxTimeoutMs, connectionString, statementTimeoutMs}:
  ACCEPTED SILENTLY — the database opened and answered `select 1`
```

### 4.8 The binding inside a worker thread

```
better-sqlite3 inside worker_thread: {"ok":true,"row":{"a":42},"ver":"24.18.0"}
```

### 4.9 Streaming: laziness, the write-wedge, and release

200,000-row `STRICT` table, WAL, ext4, ruled binding. Full script and output for §3.5.

```
seeded rows: 200000
iterate: first row: {"key":"key0000000","msToFirstRow":0.11}     <- lazy: first row in 0.11 ms
all() full materialisation: {"rows":200000,"ms":109}             <- ~990x the time-to-first-row

read while iterator OPEN:  {"ok":true,"c":200000}                <- reads still work
write while iterator OPEN: {"ok":false,"message":"This database connection is busy executing a query"}
iterator.return(): {"done":true}
read AFTER iterator.return():  {"ok":true,"c":200000}
write AFTER iterator.return(): {"ok":true}                       <- release restores writes

batched drain @256: {"rows":200000,"batches":782,"totalMs":77.9,"worstBatchMs":1.138}

close() with iterator open: {"message":"This database connection is busy executing a query"}
```

**Readings.** (1) The streaming property is satisfiable on the ruled binding, contradicting the
"no SQLite analogue" premise in change 4 §16.5. (2) An open iterator refuses **writes** on the same
handle — the hazard of §3.5.3, which does not exist under a pooled Postgres cursor. (3)
`iterator.return()` is an effective release, so the worker-side release path of §3.5.4 is
implementable. (4) The handle cannot be closed with an iterator open, so shutdown must release
first. The 1.138 ms worst-case 256-row batch is **in-process only** and excludes the worker hop; it
is not a justification for 256 and is not carried into any requirement (B-8).

### 4.10 `auto_vacuum` and space return — B-3's real reach

Prompted by change 6. Three fresh files, identical 6,000×4 KiB payloads in two tables, WAL
checkpointed to `TRUNCATE` before and after each step; `DROP TABLE` on one, `DELETE` on the other.

```
auto_vacuum=0 (none):        before 54028 KB | after DROP 54028 | after DELETE 54028
                             DROP returned 0 KB, DELETE returned 0 KB, freelist 13505 pages
                             DROP 2.9 ms, DELETE 2.1 ms
auto_vacuum=1 (FULL):        before 54096 KB | after DROP 27052 | after DELETE 12
                             DROP returned 27044 KB, DELETE returned 27040 KB, freelist 0 pages
                             DROP 62.7 ms, DELETE 2.8 ms
auto_vacuum=2 (INCREMENTAL): before 54096 KB | after DROP 54096 | after DELETE 54096
                             DROP returned 0 KB, DELETE returned 0 KB, freelist 13505 pages
auto_vacuum=2 + explicit `PRAGMA incremental_vacuum`:
                             before 27052 KB | after DROP 27052 | after incremental_vacuum 4 KB (27.7 ms)
```

**Reading, and it goes further than the report that prompted it.** Change 6 found that `DROP TABLE`
returns file space *only when `auto_vacuum` was set at creation*. That is right, and the fuller
result is that **L5's `DROP TABLE`-versus-`DELETE` argument does not hold at any `auto_vacuum`
setting**:

- at `0`, neither returns file space — `DROP` has no advantage;
- at `INCREMENTAL`, neither returns file space until an explicit `PRAGMA incremental_vacuum`, which
  then returns it for **both**;
- at `FULL`, **both** return file space.

**On the relative speed of `DROP` and `DELETE` at `FULL` — disputed, and NOT carried as fact.** This
change's single trial measured `DROP` at 62.7 ms against `DELETE` at 2.8 ms. Change 6's independent
harness — composite primary key plus a secondary index, at two scales two orders of magnitude
apart — found the two comparable at 6k rows and `DROP` **14% faster** at 120k. Two single trials
disagreeing is not a result, and neither is admissible under §6.2's conditions rule. This is the same
defect class as the preordained `233×` the round-1 remediation ordered reworded: a number promoted to
normative text on one unreproduced run. **The direction is unresolved, is not published, and is not a
premise any change must adopt.** Change 6 has scoped its M-4 to settle it; if a layout decision ever
turns on it, it becomes a datum under B-3b.

**What both harnesses agree on, and what N-1 therefore publishes:** *reclamation is a function of
`auto_vacuum` and of pages freed — orthogonal to `DROP` versus `DELETE`.* Change 6's `INCREMENTAL`
pair is the cleanest evidence and needs no direction and no factor: the two operations cost 19.9 ms
and 16.8 ms, and the subsequent reclaim costs 194.0 ms and 188.9 ms — **2.6% apart across entirely
different mechanisms**. The cost lives in the reclaim, not in the statement.

So the pragma does not merely *gate* the "`DROP` returns space" claim: at `NONE` and at
`INCREMENTAL`-without-explicit-vacuum, neither statement reclaims, and at `FULL` both do. L5 conflated freelist return with
file-size return, and the freelist column is the direct evidence: 13,505 free pages retained at
`auto_vacuum=0`, 0 at `FULL`. This is handed to change 6 as a fact about the pragma, **not** as a
ruling on its layout — the layout is change 6's, and this bears on the *condition* its Form B is
gated on, which is change 6's to reconcile.

**Two further readings that land on B-2 and B-3.** The compiled defaults are
`DEFAULT_SYNCHRONOUS=2` but `DEFAULT_WAL_SYNCHRONOUS=1` (§4.11) — in WAL mode the engine's own
default is `NORMAL`, not `FULL`, which is what B-2 must choose *against* rather than inherit. And
although `DEFAULT_AUTOVACUUM` appears in the compile-option list, a fresh file that is not explicitly
configured reads back `auto_vacuum=0` (§4.6, the WAL-first case) — the listing must not be read as a
guarantee of a non-zero default.

### 4.11 Compile-option surface, and the error object's shape

```
compile_options count: 59
… DEFAULT_AUTOVACUUM | DEFAULT_CACHE_SIZE=-16000 | DEFAULT_PAGE_SIZE=4096 |
DEFAULT_SYNCHRONOUS=2 | DEFAULT_WAL_SYNCHRONOUS=1 | DEFAULT_WAL_AUTOCHECKPOINT=1000 |
ENABLE_COLUMN_METADATA | ENABLE_DBSTAT_VTAB | ENABLE_STAT4 | ENABLE_UPDATE_DELETE_LIMIT |
LIKE_DOESNT_MATCH_BLOBS | MAX_ATTACHED=10 | MAX_DEFAULT_PAGE_SIZE=8192 | MAX_LENGTH=1000000000 |
MAX_PAGE_SIZE=65536 | MAX_VARIABLE_NUMBER=32766 | OMIT_PROGRESS_CALLBACK | THREADSAFE=2 …

UPDATE_DELETE_LIMIT present: true
DELETE ... LIMIT parses:     true
```

Three readings:

1. **`ENABLE_UPDATE_DELETE_LIMIT` is present and `DELETE … LIMIT` parses** — the syntax works on the
   ruled binding and did not on the build L5 measured. Change 6 nonetheless specified the
   `rowid IN (…)` rewrite, reasoning that a query whose validity depends on an unpinnable compile
   option is a supply-chain hazard rather than a query. **That reasoning is this change's**, and it
   generalises — it is the argument §1.2 makes for pinning the binding at all. It is promoted to a
   clause of the pinned-binding requirement so no change has to re-derive it.
2. **`OMIT_PROGRESS_CALLBACK`** independently confirms §3.4: there is no progress handler to hang
   cancellation on, so the guard-UDF route is the only one and the contract change stands.
3. **`MAX_DEFAULT_PAGE_SIZE=8192` while `MAX_PAGE_SIZE=65536`** — a `page_size` above 8192 must be
   set explicitly and cannot be inherited, a further reason B-3 is a bootstrap decision and not a
   default to accept.

**The error object carries no structured constraint identity:**

```
CHECK violation:   ownProps ["code","message","stack"], enumerable ["code"], name "SqliteError",
                   code "SQLITE_CONSTRAINT_CHECK",      message "CHECK constraint failed: j_positive"
PK violation:      code "SQLITE_CONSTRAINT_PRIMARYKEY", message "UNIQUE constraint failed: c.i"
RAISE(ABORT,name): code "SQLITE_CONSTRAINT_TRIGGER",    message "kv_history_no_overlap"
structured constraint field (constraint/detail/table/column/schema): NONE in any case
```

The constraint's identity exists **only inside the message string**. PostgreSQL exposes it as
structured fields, so this is a **regression** — not the G3 opportunity L5 recorded
`RAISE(ABORT,'<name>')` as being. Change 6 contains it correctly (message parsing confined to one
function, with a round-trip test driven from the lineage's declared constraint names), and that
containment is the right shape for changes 2, 3 and 5 too, which is why it is recorded in §4.12
rather than left inside change 6.

### 4.12 Hand-off facts for other changes

- **Change 3 / change 5 — the error discriminator.** The ruled binding surfaces the **string**
  extended result-code name on the thrown error (`code: "SQLITE_BUSY"`,
  `"SQLITE_CONSTRAINT_PRIMARYKEY"`, `"SQLITE_CONSTRAINT_DATATYPE"`, `name: "SqliteError"`).
  `node:sqlite` surfaces a **numeric** `errcode` (`5`, `1555`, `275`) with
  `code === "ERR_SQLITE_ERROR"`. Both are different discriminators from the SQLSTATE strings
  `src/postgres/errors.ts` switches on. Any error-mapping design written against the numeric form
  must be re-keyed to the string form. **And the error object carries nothing else**: its own
  properties are exactly `["code","message","stack"]`, with no structured constraint, table, column
  or detail field (§4.11). Constraint identity — including a `RAISE(ABORT,'<name>')` name — lives
  only in the message string. Any change that needs to distinguish *which* constraint fired must
  parse the message, and must confine that parsing to a single function with a round-trip test
  driven from the lineage's own declared constraint names, as change 6 does.
- **Change 3 — sticky poison.** SQLite does not poison a transaction after a failed statement; the
  swallowed-error partial-commit is re-confirmed above on the ruled binding.
- **Change 4 — `STRICT` is load-bearing for §2.2, not hygiene.** It is the only thing that makes a
  wrong `Date` normalisation loud.
- **Change 5 — `backup()` needs re-measurement.** The contradiction seat measured `backup()` as
  non-blocking and integrity-clean under 781 concurrent commits while `VACUUM INTO` froze the
  thread — **on `node:sqlite`**. The ruled binding's `backup(dest, opts)` has a different
  implementation and threading model. That measurement is listed as blocked (§6, B-6).

---

## 5. The traps, and why each is a requirement rather than a note

### 5.1 They are all silent

Every one of the four fails without an error under at least one plausible implementation. That is
the whole reason they belong in a spec: a note describes the hazard, a requirement with a scenario
makes its absence detectable.

### 5.2 Two of them are silent falsification paths into a proved property

`src/postgres/temporal-kv.ts:254` and `:257` are the `${asOf.at}::timestamptz` binds inside
`getAtImpl` — the point-in-time read. That is **T3** (`Formal/STORAGE_ALGEBRA.md` §1, Law T3). A
`Date` that becomes NULL, and a `Date` that becomes ISO text and therefore sorts after every
integer, both make `getAt` return the wrong row *with no error and no test failure* unless a test
happens to assert on a specific instant. A Lean-mechanised law is falsified by a bind conversion
three layers below the model. This is the sharpest available illustration of trap 9 — a green gate
certifies depth, never breadth.

### 5.3 The text guard must be renamed, never deleted

`hasPostgresUnsafeText` (`src/interfaces/temporal-kv.ts:35`) rejects NUL bytes and unpaired UTF-16
surrogates, and is applied through `NamespaceSchema`/`ScopeSchema`/`KeySchema` (`:110-114`),
recursively through `jsonValueHasUnsafeText` (`:44-53`), and directly to `listKeys`'s `prefix`
(`src/postgres/temporal-kv.ts:309`). Its message says *"PostgreSQL cannot store either"*
(`:38`, and again at `temporal-kv.ts:313`).

Under SQLite the *justification* inverts but the *necessity* increases. Measured on the ruled
binding (§4.4): a lone surrogate is **accepted and silently replaced with U+FFFD** — the round trip
is not equal to what was written; a NUL byte is **accepted** but `length()` reports 1 for a 3-code-
unit string, so `LIKE`, `length()` and ordering disagree with the stored value. PostgreSQL *refused*
this input; SQLite *corrupts* it. A migration cleanup that removed the guard as "Postgres-specific"
would convert a rejection into silent data corruption. **Rename it and rewrite its message; deleting
it is a regression, and the spec carries a negative-control scenario that says so.**

### 5.4 The pragma order is irreversible

§4.6 shows both orders reporting success and only one producing the intended file. `auto_vacuum` in
particular **cannot be retrofitted** — space never returns without a full `VACUUM`, which at archive
scale was estimated in tens of minutes and requires free disk equal to the database. The requirement
is therefore not "apply these pragmas" but "apply them in this order, once, before the first write,
and **read them back and fail** if the observed values differ from the intended ones." A read-back
assertion is the only thing that distinguishes the two outcomes at runtime.

---

## 6. The measurement gate

### 6.1 Why it blocks

Six of seven lanes benchmarked against `/tmp`, which on the research host is a 32 GB tmpfs RAM disk;
only L6 caught it. Re-measured on ext4: WAL `synchronous=FULL` **88,485 → 379 commits/s (233×)**;
`DELETE`/`NORMAL` **17,423 → 215 (81×)**; ingest at `FULL` **213.4 → 72.5 MB/s (2.9×)**. Two of L5's
conclusions **invert**: "durability is not the throughput lever (~6%)" is really 1.66× on ingest and
~102× on commits, and L5 published `FULL` as *faster* than `NORMAL` — physically impossible, and a
tell it did not act on. The whole pragma matrix, the `page_size` recommendation and the `cache_size`
negative are not merely wrong but **meaningless**, because their stated mechanism was the OS page
cache and on tmpfs the file *is* the page cache.

Also destroyed: the assumption that out-of-cache behaviour was unobservable. On ext4 at
`synchronous=FULL`, per-quarter throughput decayed **11,890 → 9,305 → 5,147 → 4,502 rows/s** — a
2.64× decay over 2.4 GB, still falling. The onset is real and near.

### 6.2 What the gate requires

A re-measurement suite, run on a real filesystem, publishing a **machine-readable artifact** in
which every datum carries its conditions: filesystem and mount options; `journal_mode`;
`synchronous`; `page_size`; `auto_vacuum`; dataset size **and** the machine's RAM, so the
cache-residency ratio is derivable; single vs concurrent writer; and the driver and
`sqlite_version()`. At minimum the artifact must contain a `synchronous=FULL` cell, a
`synchronous=NORMAL` cell, and at least one cell whose dataset exceeds the page cache far enough to
show the decay curve rather than its first point.

The suite must be re-runnable by command, and CI must assert the artifact exists and that its
declared conditions include a non-tmpfs filesystem. **A number measured on tmpfs is not admissible
evidence anywhere in this sprint**, and neither is a number without its conditions attached.

The most economical way to get the out-of-cache cell is the one already on the 1.0.0 critical path:
instrument the mandatory full local Midnight sync (`CHANGELOG.md:15-18`, `ROADMAP.md:389-398`) with
per-window throughput and I/O counters. That sync is a tag precondition regardless, so the
experiment is nearly free — but this change does not *depend* on it, because a synthetic ext4 run
establishes the pragma numbers without waiting for a sync.

### 6.3 Decisions blocked on the gate

| id | blocked decision | owner | why it cannot be decided now |
|---|---|---|---|
| **B-1** | **Whether the monotone logical clock is adopted at all**, and whether `CLOCK_REGRESSION` narrows from `conditional` to `non-retryable` | **change 2** | L1's headline "99.2% of same-key puts rejected" is **0.0% at `synchronous=FULL`** — at ~7.2 ms/commit two puts cannot share a millisecond. The clock crisis, its ~1.8 s drift and the coupled `TRANSACTION_KEY_REUSE` weakening are all downstream of a pragma L1 never varied. Narrowing a `retryable` marking is a **forbidden weakening** under `docs/ERROR-CATALOG.md:13`, so adopting the clock on a RAM-disk number would break a frozen commitment to fix a problem that may not exist. **Required datum:** same-key collision rejection rate at the chosen `synchronous`, on ext4 |
| **B-2** | The default `synchronous` value | this change | It is a durability/throughput trade that `docs/CONTRACT.md` §1 publishes, and the two candidate values differ by ~102× on commits on real disk. Note the engine's own WAL-mode default is `NORMAL`, not `FULL` (`DEFAULT_WAL_SYNCHRONOUS=1`, §4.11) — so `FULL` is a choice that must be made and paid for, not a default that must be preserved |
| **B-3a** | `page_size` and `auto_vacuum` for the **wallet** database file | this change | One-shot and irreversible (§5.4). L5's page-size sweep is tmpfs-tainted; L7's `page_size=32768` is another project's number for another workload. `page_size` above 8192 must be set explicitly — `MAX_DEFAULT_PAGE_SIZE=8192` (§4.11) |
| **B-3b** | `page_size` and `auto_vacuum` for the **archive** database file | this change, **unblocks change 6's layout ruling** | The archive gets **its own file** (`umbra-archive.sqlite`, per the contradiction seat's C5), so it may take a different `auto_vacuum` from the wallet file — B-3 is **two decisions, not one**. **Required data now includes whether the archive file is created with `auto_vacuum` enabled**, because space return is entirely downstream of it (§4.10): at `0` and at `INCREMENTAL`-without-an-explicit-vacuum, *neither* `DROP TABLE` nor `DELETE` returns file space; at `FULL`, *both* do and `DROP` is ~22× slower. Change 6's two-form layout ruling is gated on this, and so is any retention design that assumes space comes back |
| **B-4** | The lease poll interval, the lease timeout budget, and the acceptability of the worker's ~110 µs/statement write-lock amplification | **change 3** | Contention cost per retry scales with commit latency, which is the quantity that moved 233× |
| **B-5** | The chosen batch chunk size below the 32,766 ceiling | **change 4** | The ceiling is measured and fixed; the chunk size trades statement count against per-round-trip transport, and that interaction has only been measured against RAM |
| **B-6** | `backup()` vs `VACUUM INTO` for `docs/CONTRACT.md` §6 | **change 5** | The seats disagree, and the measurement favouring `backup()` was taken on the *other* driver (§4.10) |
| **B-7** | Which pragma values the durability probe asserts | **change 5** | The probe can only assert what the bootstrap sets; those values are B-2, B-3a and B-3b (two files, so the probe asserts a per-file expectation) |
| **B-8** | The streaming batch size and the stream idle deadline (§3.5.2, §3.5.4) | this change | Batch size trades round-trip count against per-message transport (which grows with payload) **and** against abort latency, since an abort arriving mid-batch is only observed when that batch ends. The only figures available — 1.138 ms/256 rows measured here, 2.9 ms/256 measured by L3 — are both **in-process**, exclude the worker hop, and were not taken on the target filesystem. **Required data:** time-to-first-row and total drain time as functions of batch size *across the worker boundary* on ext4 at the chosen `synchronous`; observed abort latency at each candidate batch size; and WAL growth during a long-lived stream (§3.5.5) |

### 6.4 Close rules — how each blocked decision is discharged

A datum without a decision rule leaves an implementer unable to tell CLOSED from open, which makes
the gate decorative. Each rule below is **inputs → mutually exclusive outcomes**, so that reading the
artifact *determines* the answer rather than informing a debate. No rule may be discharged by a
research-phase figure.

| id | Close rule |
|---|---|
| **B-1** | Measure the same-key collision rejection rate at each candidate `synchronous` on ext4. **If** the rate at the value B-2 chooses is **0%**, the monotone logical clock is **not adopted** and `CLOCK_REGRESSION` keeps its `conditional` marking unchanged. **If non-zero**, change 2 adopts a clock and must justify any retryability change as an *additive* catalog edit — never a narrowing, which `docs/ERROR-CATALOG.md:13` forbids. There is no third outcome; "adopt it defensively" is not one. |
| **B-2** | Measure sustained commit throughput at `synchronous=NORMAL` and `FULL`, in-cache and out-of-cache. **Default to `FULL`.** Adopt `NORMAL` **only if** `FULL`'s out-of-cache commit rate leaves less than 2× headroom over the wallet's measured sustained write demand — in which case `NORMAL` is adopted **and** `docs/CONTRACT.md` §1 states the weakened durability position explicitly. Throughput alone never selects `NORMAL`; only insufficient headroom does. |
| **B-3a** | Sweep `page_size` ∈ {4096, 8192, 16384, 32768} against the wallet workload. **Choose the smallest page size within 10% of the best measured throughput**, ties broken downward — smaller pages lose less to write amplification on a wallet's small-row profile. For `auto_vacuum`: **`NONE` unless** the wallet lineage ships a delete-heavy path with a written reclaim requirement, in which case **`INCREMENTAL` + an explicit vacuum step**. `FULL` is not selected for the wallet file: it pays on every commit for reclaim a wallet does not need. |
| **B-3b** | The same page-size rule measured **separately** against the archive workload (large blobs, different profile). For `auto_vacuum`: **`NONE` if change 6 ships no retention or pruning requirement**; **`INCREMENTAL` + explicit vacuum if it does**; **`FULL` only if** change 6 states a requirement that space return be automatic rather than scheduled. §4.10 is the input: at `NONE` neither `DROP` nor `DELETE` reclaims, so a layout justified by reclaim is unavailable; at `FULL` both reclaim and `DROP` is the slower, so reclaim does not justify a table-per-range layout either. **This rule is what unblocks change 6's layout ruling** — change 6 selects its form from the outcome, not the reverse. |
| **B-4** | Measure lease acquisition under contention across candidate poll intervals at B-2's `synchronous`. **Choose the largest poll interval whose measured p99 acquisition latency stays below the lease timeout budget ÷ 4** — the margin exists so a run of unlucky polls cannot itself cause a timeout. **If no candidate satisfies it**, raise the timeout budget (rather than shrink the interval past the point where polling dominates CPU) and record the raise in `docs/CONTRACT.md`. Separately, the worker's write-lock amplification is **accepted** if measured total hold time stays within the same order of magnitude as the in-process baseline, and **escalated to change 3 as a design question** if it does not. |
| **B-6** | Run both `backup()` and `VACUUM INTO` on the **ruled binding** — the prior measurement was on the rejected one — under a concurrent writer, at B-2's `synchronous`. **Choose `backup()` if** it completes without blocking the worker beyond one batch interval **and** the copy passes `integrity_check`. **Choose `VACUUM INTO` if** `backup()` fails either condition and `VACUUM INTO` passes both. **If both fail**, neither is specified as an online mechanism and change 5 §6 documents an offline post-quiesce copy as the only supported procedure — which is where the precedent survey already points, not a fallback to be avoided. |
| **B-8** | Sweep batch size across the worker boundary. **Choose the smallest batch size whose time-to-first-row is within 2× of the smallest batch tested** — protecting the streaming property the merged `listKeys` requirement states — **subject to** total drain time within 1.5× of the best measured. The idle deadline is **10× the measured p99 inter-batch pull interval, floored at one second**. **If no batch size satisfies both bounds**, change 2 re-scopes the streaming promise rather than these bounds being relaxed here. |

**B-5 and B-7 are derived, not independent.** B-5 closes when B-8's transport figures exist — it is
the same trade. B-7 closes automatically once B-2, B-3a and B-3b are closed, since the probe asserts
exactly what the bootstrap sets, per file.

---

## 7. Consequences for the test architecture

Not authored here (change 4 owns fixtures), but recorded so it is not rediscovered: `design/design.md`
§8 resolved test infrastructure in favour of Testcontainers PostgreSQL, and that resolution lapses.
Per-test setup goes from ~2,500–3,300 ms of container startup to opening a file, which also removes
the reason the per-adapter test *architecture* exists — it exists to amortise that startup. Deleting
that architecture is a real gain and a real diff, and it belongs to whoever owns fixtures, not here.

`.github/workflows/pack-smoke.yml:47-52` currently needs a Docker daemon for its round-trip oracle
and fails in CI when Docker is missing (`:14-17`); after the migration the round-trip needs a
temporary directory. `.github/workflows/supply-chain.yml` gains the inventory assertion from §1.2.

## 8. Answered by the owner — and two premises this change had wrong

The owner has answered the three questions that were open when §1–§7 were written. Two of the
answers reverse premises this change was written on, and one reverses a premise the whole sprint was
costed on. They are recorded here as **answers**, and the corrections they force are propagated in
§10 so the other authors adopt one wording rather than six.

### 8.1 The chain archive is in scope, and my non-goal citation was stale

**Owner, answer 1:** *"We should be able to have archive snapshots."* **Owner, answer 2**, on whether
`archive:sync` has ever run against a real database: *"No."*

**Coordinator's reading, recorded here as an assumption for the owner to correct:** the archive is
**ported to SQLite as a sixth change**, not stranded on PostgreSQL. It has never run, so there is no
data and no backfill to design; and a SQLite archive file *is* a snapshot artifact, which is what
answer 1 asks for and which fits the owner's existing Mithril snapshot/restore workflow far better
than `pg_dump` — a point that also bears on change 5's §6 rewrite.

**Separately, and independently of the owner's answers, the non-goal wording I used was wrong.** I
cited `src/postgres/migrations/chain_archive/001_chain_archive_core.ts:86` verbatim — *"Not wired
into any runner path that would execute it."* **That comment is stale, and I verified it is stale
rather than repeating it:**

```
package.json:46                     "archive:sync": "tsx chain-archive-sync/sync-cli.ts"
chain-archive-sync/sync-cli.ts:22   import { bootstrapChainArchiveSchema } from "./bootstrap.js";
chain-archive-sync/sync-cli.ts:38   await bootstrapChainArchiveSchema(sql, SCHEMA);
chain-archive-sync/bootstrap.ts:21    await runMigrations(sql, { schema, migrations: chainArchiveMigrations });
chain-archive-sync/sync-service.ts:1  import { PgChainArchiveStore } from "../src/postgres/chain-archive-store.js";
chain-archive-sync/sync-service.ts:123  this.store = new PgChainArchiveStore(opts.sql, opts.schema ?? "chain_archive");
tsconfig.json  "include": [... "chain-archive-sync/**/*.ts" ...]      <- npm run typecheck covers it
tsconfig.build.json "exclude": [... "chain-archive-sync" ...]         <- npm run build does not
```

So `chainArchiveMigrations` **is** reachable from a runner path, via a real npm script. "No data and
no consumer" was true; "not wired" was not. Two facts were being conflated, and I propagated the <!--MENTION:retraction-->
conflation. The correction is in the register (§10, R-1).

**The consequence for this change, and it is the one R-1 turns on:** `npm run typecheck` compiles
`chain-archive-sync/`, `npm run build` does not, and `npm run archive:sync` executes it through
`tsx`. Those three must stay coherent under the amended plan. Because the archive is ported rather
than stranded, the `postgres` dependency is removed outright — **not** retained scoped to
`chain-archive-sync/`, which was the adjudication's default resolution. Task 1.1's acceptance is
amended accordingly, and task 0's blanket prohibition on touching the archive is **lifted**: the
archive is in scope, owned by **change 6** (`v1.0.0-sqlite-chain-archive`).

**What this change owes change 6, and nothing more:** the driver, the shim, the worker topology and
the pragma bootstrap. This change does **not** specify the archive's schema, its ingestion design,
its snapshot format, or its blob strategy. Two engine-level facts are handed over rather than
designed: `SQLITE_MAX_LENGTH` is 1,000,000,000 (measured, §4.5), which caps any single BLOB; and
neither the ruled binding nor the rejected one exposes incremental BLOB I/O — the contradiction seat
refuted L5's claim that `better-sqlite3` provides it, and §4.5's prototype listing confirms no such
member. Both bear on change 6 and neither is settled here.

### 8.2 There are consumers, on three channels, and no chokepoint

**Owner, answer 3:** consumers *"will install from the git tag and from repo clone and from docker
images."*

This **reverses** the feasibility seat's finding that data migration was zero work, which rested
entirely on there being no observable consumer. The finding's evidence was real —
`registry.npmjs.org/umbradb` returns 404 and there is no publish step in CI — but its conclusion does
not follow: the absence of an npm registry entry is the absence of a *chokepoint*, not the absence of
consumers. There are three live distribution channels and no single point through which to reach
them.

Consequences:

- **It is now false to claim there are no consumers.** The corrected wording is in §10 (R-9). Any <!--MENTION:retraction-->
  change still carrying "no known external consumer" is carrying a refuted claim. <!--MENTION:retraction-->
- **A PostgreSQL→SQLite data-migration path is in scope and was owned by nobody.** It is now
  **change 7** (`v1.0.0-sqlite-data-migration`). Its dependencies on this change and others are in
  §10. It covers the **wallet tier only** — the archive has no data (answer 2), so there is nothing
  to import for it.
- **Docker images are a distribution surface nobody in the sprint considered.** An image shipping
  UmbraDB today either bundles PostgreSQL or expects one to exist. What "upgrade" means for that
  channel is unanswered, and it is cheap now and expensive after the tag. Recorded as an open
  question with an owner in §10.

## 9. On the formal layer

The Lean cut-line `{T3, T5, W1, C1}` survives a complete storage-engine replacement **untouched**,
because it models an abstract store and the abstract→concrete refinement was always an explicitly
trusted, unmechanised bridge (`ROADMAP.md:404-410` already records a written deferral of "the whole
SQL/runtime refinement"). **That survival is not evidence the migration is safe** — it is evidence
the proofs never constrained the concrete implementation, so they cannot vouch for the new one. §5.2
gives the concrete illustration: a bind conversion falsifies T3 without touching a single Lean line.

`Formal/STORAGE_ALGEBRA.md` §5's P1–P10 conformance suite is what carries the refinement claim, and
it must be **re-executed against the SQLite build, not amended to suit it**. A property that needs
its text changed to pass is a property that was measuring the old engine.

---

## 10. The cross-change register

Two registers ship with this change. §6.3 is the **blocked-decision register** (B-1…B-8): things
nobody may decide until a measurement exists. This section is the **correction and dependency
register**: facts that were wrong in more than one change, and cross-change dependencies that were
owned by nobody. It exists so the other authors adopt one wording rather than each inventing their
own, and it is this change's to maintain because this change is the keystone every other one reads.

### 10.1 Corrections — every change carrying the old wording must adopt the new

**R-1 — "the chain archive is not wired into any runner path."** *Status: **refuted**, by me, against <!--MENTION:retraction-->
this worktree.*

- **Old wording**, which I used and which the other four changes inherited: the archive is out of
  scope because `001_chain_archive_core.ts:86` says it is *"Not wired into any runner path that would <!--MENTION:retraction-->
  execute it."*
- **Corrected wording, to be adopted verbatim:** *The chain archive has no data and no production
  consumer, but it **is** wired: `package.json:46` exposes `archive:sync`, which runs
  `chain-archive-sync/sync-cli.ts:38` → `bootstrap.ts:21` → `runMigrations(..., chainArchiveMigrations)`,
  and `sync-service.ts:123` constructs `PgChainArchiveStore`. `tsconfig.json` typechecks the
  directory; `tsconfig.build.json` excludes it from the build. The in-file comment claiming it is
  unwired is stale.*
- **And the scope statement changes too:** the archive is **in scope**, ported to SQLite by
  **change 6**. No change may still say "the chain archive is out of scope"; the correct statement is <!--MENTION:retraction-->
  "the chain archive is owned by change 6, not by this change."
- **Consequence for `dependencies`:** `postgres` is removed outright. It is **not** retained scoped
  to `chain-archive-sync/` — that was the adjudication's default and it is superseded.
- **Closing condition, unchanged:** `npm run typecheck`, `npm run build` and `npm run archive:sync`
  must be coherent under the amended plan.

**R-9 — "there is no known external consumer."** *Status: **false**, per the owner.* <!--MENTION:retraction-->

- **Old wording:** no npm registry entry, no publish step in CI, therefore no consumers; git-tag <!--MENTION:retraction-->
  installs unobservable; data migration is zero work.
- **Corrected wording, to be adopted verbatim:** *UmbraDB has consumers on three distribution
  channels — **git tag, repo clone, and docker images** — and no npm-registry chokepoint through
  which to reach them. The absence of a registry entry is the absence of a chokepoint, not the
  absence of consumers. A PostgreSQL→SQLite data-migration path is therefore required, and is owned
  by change 7.*
- Any cost estimate that assumed zero migration work is understated by whatever change 7 costs.

**N-1 — "`DROP TABLE` returns the space, `DELETE` does not."** *Status: **refuted at every
`auto_vacuum` setting**, measured by me on the ruled binding on ext4 (§4.10). Raised by change 6,
which found the first half of it; this entry records the whole.*

- **Old wording** (L5, and repeated in the sprint summary): table-per-range partitioning is justified
  because `DROP TABLE` of a height range returns the space (35 ms) while `DELETE` does not (1,296 ms,
  46,396 free pages left behind).
- **Corrected wording, to be adopted verbatim:** *Space return is a property of `auto_vacuum`, not of
  `DROP` versus `DELETE`. At `auto_vacuum=0`, neither returns file space. At `INCREMENTAL`, neither
  returns file space until an explicit `PRAGMA incremental_vacuum`, which then returns it for both.
  At `FULL`, both return file space and `DROP TABLE` is the slower of the two (62.7 ms vs 2.8 ms in a
  6,000-row × 4 KiB trial). L5 conflated freelist return with file-size return.*
- **Consequence:** any layout, retention or pruning design that assumes `DROP` reclaims disk must
  first state which `auto_vacuum` the file was **created** with (B-3a/B-3b), because the setting is
  irreversible. This is offered to change 6 as a pragma fact; **the layout ruling remains change
  6's**, including whether its Form B condition is still sufficient given that `DELETE` also returns
  space at `FULL`.

**N-2 — a query's validity may not depend on an unpinnable compile option.** *Status: raised by
change 6's `DELETE … LIMIT` reasoning; generalised here because it is this change's argument.*

- `ENABLE_UPDATE_DELETE_LIMIT` **is** present on the ruled binding and `DELETE … LIMIT` parses
  (§4.11) — yet change 6 correctly specified the `rowid IN (…)` rewrite anyway.
- **Wording to adopt:** *A compile option is not part of the pinned surface unless it is inventoried
  and asserted. SQL whose validity depends on an un-asserted compile option is a supply-chain hazard,
  not a query, and must be written in a form that does not need it.* This is the same argument §1.2
  makes for pinning the binding, and it is now a clause of the pinned-binding requirement.

**N-3 — "SQLite gives us a single writer."** *Status: **false**; raised by change 6, adopted here and
applied to this change's own §3.1.*

- **Corrected wording, to be adopted verbatim:** *SQLite serializes transactions; it does not make a
  process a single writer.* Two processes interleaving `BEGIN IMMEDIATE` transactions is legal and
  undetected. A second `BEGIN IMMEDIATE` raising `SQLITE_BUSY` proves mutual exclusion **between
  transactions**, not exclusivity **between writers**.
- **Consequence:** any argument phrased as "single-writer serialization" rests on nothing enforced.
  Writer exclusivity, where it exists, comes from change 3's writer-generation mechanism (wallet
  file) and change 6's (archive file) — not from the engine. This change's §3.1 derivation was
  corrected accordingly; what this change establishes is the narrower and sufficient "one handle per
  file, one owning worker, within one process."

**N-4 — the relay rule (from the adjudication §3.5, this change's half of G-4).** *Status: rule,
adopted.*

- **A change that discovers false or contradicted text in a sibling files the finding against that
  sibling's `tasks.md` at discovery time.** The owner still makes the edit — ownership etiquette
  governs *who edits*, never *whether known-false text ships* — but the obligation lands in the
  owner's own artifact, not in the discoverer's design notes.
- **Why it is a rule and not advice:** invariant I-4 was assigned in one change's design document and
  never reached the owning change, because a note in a neighbour's file is not a task in yours.
  Registers also rot — this one's own citations will — so a durable finding must live where the work
  is tracked. Change 3 has since applied the rule in the other direction, re-scoping its inheritance
  table to E-1…E-10 and filing E-7 (change 4), E-8/E-9 (change 6) and E-10 (change 7) into those
  changes' `tasks.md`. That is the pattern.

**N-5 — the use/mention rule (sprint-wide; raised independently by changes 3, 5 and 7).**
*Status: rule, adopted for every change in this sprint.*

- **A mechanical text sweep cannot distinguish use from mention.** A retraction record must quote the
  premise it withdraws; a criterion must name what it forbids; a gate's pattern must spell the
  phrases it hunts; a negative control must plant one. None of these *asserts* the premise, and no
  phrase list can tell them apart from one that does. This is why the sweep's own owner scored the
  most hits: it is the change that documents the retraction.
- **Rule:** a line that mentions a banned phrase without asserting it carries an inline
  `<!--MENTION:<class>-->` marker, class ∈ {`retraction`, `criterion`, `pattern`, `control`}. The
  sweep excludes marked lines from the failing set **and prints them in a second list that must be
  read**. The marker re-files; it does not hide.
- **Rule:** where a mention is *incidental and avoidable*, reword instead of marking — change 5's
  discipline, adopted. Markers are reserved for mentions the work requires.
- **Rule:** any sweep of this kind ships with three controls: it fires on a planted unmarked
  assertion; a planted **marked** assertion appears in the read-list rather than vanishing; and the
  control apparatus itself does not fail the gate.
- **Why sprint-wide and not per-change:** the pattern appeared independently in three changes in one
  round. A per-change fix would produce three incompatible conventions and a fourth author
  rediscovering it.

**N-6 — a citation check must surface the resolved requirement's *title*, not merely resolve.**
*Status: rule, adopted; this change's half of G-16. From change 7's resolver work.*

- Change 7 built a resolver over every cross-change `file:line` in its own change — **99 citations**
  (34 explicit, 26 relative, 40 bare) — and converted all of them to title anchors.
- **The finding that matters:** two were not merely mis-anchored but **stale in content**. It had
  cited change 5 for a claim change 5 has since replaced wholesale. Re-pointing the anchor would have
  preserved a superseded claim behind a correct-looking line number.
- **Rule:** cross-change citations use **requirement-title anchors** — titles do not rot with line
  numbers — and any CI resolution check **prints the resolved requirement's title** beside the
  citation. Resolving to *a* requirement is necessary but not sufficient; only reading the target
  catches a superseded claim. Where a cited claim has been superseded, the citing change
  **re-derives** rather than re-points.

### 10.2 Dependencies — changes 6 and 7

Recorded, not specified. Neither change's content is authored here.

| Change | Depends on | What it needs from the dependency |
|---|---|---|
| **6 — `v1.0.0-sqlite-chain-archive`** | **change 1** (this) | Driver, shim, worker topology, pragma bootstrap. Plus three handed-over engine facts: `SQLITE_MAX_LENGTH = 1000000000` caps any single BLOB (§4.5); **no** incremental BLOB I/O on either binding — L5's claim that it does was refuted by the contradiction seat and is not restored by §4.5's prototype listing; and the `auto_vacuum` space-return result in §4.10 / N-1 |
| | **change 1 — B-3b specifically** | The archive file's `auto_vacuum`, which its **layout ruling is gated on**. The archive has its own database file, so B-3b is a separate decision from the wallet file's B-3a. Change 6's Form B may not be selected until B-3b is closed, and N-1 bears on whether the Form B condition is sufficient as written |
| | **change 4** | Table/index/trigger prefixing conventions and `STRICT` discipline, so the archive's schema is built the same way as the wallet tier's |
| | **change 5** | The snapshot/backup regime — answer 1 asks for archive *snapshots*, and whether that is `backup()`, `VACUUM INTO` or a file copy is B-6, not change 6's to invent |
| **7 — `v1.0.0-sqlite-data-migration`** | **change 1** (this) | The driver and shim it writes through |
| | **change 4** | The target schema it imports into |
| | **change 5** | The digest/integrity regime, so an import can be verified rather than assumed |
| | scope note | **Wallet tier only.** The archive has no data (owner answer 2), so there is nothing to import for it |

Change 7 cannot begin specifying an import before 1, 4 and 5 have settled their halves; that is a
sequencing fact for the coordinator, not a requirement of this change.

### 10.3a Rulings adopted from sibling changes (recorded so they are not re-litigated)

| ruling | owner | what this change adopts |
|---|---|---|
| **Catalog membership for the new faults (G-14)** | change 5 | Both of change 4's faults route to `VALUE_INTEGRITY`; **no new code is minted**. The rule is scope-based — *addressable scope → `VALUE_INTEGRITY`; whole file → `DATABASE_CORRUPT`* — with a machine-readable discriminator, since one code now carries several triggers. **Tool failures are tool diagnostics, not catalog entries.** This change adds no error code and defers all catalog questions here; §4.12's error-shape hand-off is consistent with it (the discriminator must be parsed from the message, so the discriminator field is UmbraDB's own, not the engine's). |
| **Transaction serialization ≠ single writer (N-3)** | change 6 | Adopted, and applied to this change's own §3.1 derivation. |
| **The relay rule (N-4)** | adjudication §3.5 | Adopted as a standing rule of this register; change 3's E-1…E-10 handover is the reference application. |

### 10.3 Open questions with owners

| id | question | owner | why it is cheap now |
|---|---|---|---|
| **Q-1** | What does "upgrade" mean for the **docker image** channel? An image shipping UmbraDB today either bundles PostgreSQL or expects one; nothing in the sprint has considered what happens to that image, its volumes, or its entrypoint | **owner + change 7** | The image contract is not covered by any freeze today. After the tag it becomes a published expectation, and changing it is a breaking change to a channel with no chokepoint to reach |
| **Q-2** | Is the coordinator's reading of answer 1 correct — that "archive snapshots" means *port the archive to SQLite*, rather than *keep producing PostgreSQL snapshots*? | **owner** | Recorded as an assumption, per the coordinator, so the owner can correct it before change 6 is written rather than after |
| **Q-3** | Does the repo-clone channel imply consumers running `archive:sync` from source? If so, R-1's coherence condition is a consumer-facing contract, not an internal build detail | **owner + change 6** | Determines whether `archive:sync` may break at any point during the migration or must work at every commit |
