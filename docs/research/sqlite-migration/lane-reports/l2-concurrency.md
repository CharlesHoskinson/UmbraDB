# L2 — Concurrency, transactions and the lease

Lane: `l2-concurrency` · worktree `/root/UDB-sqlite-l2-concurrency` (cut from `origin/main`, `3c0c68b`)
Environment: WSL Ubuntu 26.04, `node v24.18.0`, built-in `node:sqlite`, SQLite `3.53.1`.

---

## 1. Verdict

**The lease moves, and moves better than it does today. Cancellation does not.**

`pg_advisory_lock`'s one decisive property — *the server releases it when the holder dies, with no
heartbeat and no stale-takeover rule* — has an exact SQLite analogue that costs zero dependencies: a
**per-key sidecar SQLite lock file held open under `BEGIN IMMEDIATE`**. The OS releases the
underlying `fcntl` lock on `SIGKILL`; a competing acquirer measured **0 ms** to take over
(§3, exp 07/4b). Law L1 survives intact and is in one respect *strengthened*: today's lock lives in
the connection's failure domain (CONTRACT.md §5's "does not fence writes against connection death"),
whereas a file lock lives in the *process's* failure domain, so the "mutual exclusion may have
lapsed" hazard that `withLease`'s entire `onReleaseFault` apparatus exists to report becomes
essentially unreachable.

Two things break. First, **G4 §3's cancellation contract**: `node:sqlite` exposes no
`sqlite3_interrupt` and no progress handler, and it is synchronous — a 50 ms timer scheduled before a
6 033 ms query **never fired** (§3, exp 06a). Lock waits remain genuinely cancellable if the wait is
moved out of SQLite into a JS poll loop (measured: abort honoured at 204 ms against a 200 ms target),
but "**during a long read** … the in-flight cursor is **freed**" cannot be honoured for any statement
whose cost is in SQLite. Second, **there is no `statement_timeout`**: `TransactionOptions.timeoutMs`
(frozen G1 surface) and `UmbraDBConnectionOptions.statementTimeoutMs` / `idleInTxTimeoutMs` have no
SQLite implementation at all.

One hazard is severe enough to call out in the verdict because the obvious port walks straight into
it: **the naive translation of the blocking lease wait self-deadlocks P10.** Porting
`pg_advisory_lock` to `PRAGMA busy_timeout` + `BEGIN IMMEDIATE` makes 8 concurrent in-process
`withLease` calls resolve **1 acquired / 7 `LEASE_TIMEOUT`** in 7 018 ms, because the blocking wait
pins the single JS thread and the 20 ms holder can never reach the event loop to release. The poll
loop makes the identical test **8/8, maxActive 1, 171 ms** (§3, exp 10).

Everything else in this lane is a simplification: no pool, no reservation, no protocol cancellation,
no pooler-detection, no `statement_timeout` poisoning of returned connections. Roughly 180 lines of
`src/postgres/transaction-lease.ts` delete outright.

---

## 2. Blockers

### B1 — Mid-statement cancellation is not implementable · **not closeable** · touches **G4 §3**

- **Postgres today:** `raceAgainstAbort` (`src/postgres/transaction-lease.ts:91-117`) captures the
  `Query` object before awaiting it and calls real protocol-level `Query.prototype.cancel()` from the
  abort listener; `src/postgres/errors.ts:192` translates the resulting `57014`. `docs/CONTRACT.md:66-68`
  promises this as a **frozen release contract**: "During a long read (`listKeys`, lease acquisition) —
  the in-flight cursor / lock wait is **freed**."
- **SQLite offers:** `sqlite3_interrupt` and `sqlite3_progress_handler` exist in the C API.
  `node:sqlite` exposes **neither** (exp 01: `db.interrupt`, `db.setProgressHandler` both
  `undefined`; module exports are exactly `DatabaseSync, Session, StatementSync, backup, constants`).
  Worse, `DatabaseSync` is synchronous, so even if a handle were interruptible there is no other
  JS thread to call it from — `DatabaseSync` is not structured-cloneable to a Worker (exp 06d).
- **Partially closeable in application code:** the *lease-acquisition* half of the contract is
  recoverable by moving the wait out of SQLite (`busy_timeout=0` + `try BEGIN IMMEDIATE` + `await
  sleep(pollMs)`), which restores true mid-wait abort at poll granularity — measured 204 ms against a
  200 ms abort (exp 10c) and 356 ms against 350 ms (exp 09D). The *long read* half
  (`listKeys`, a large `load()`) is **not closeable**: the event loop does not turn.
- **Contract must become:** three timings collapse to two — "before dispatch" (unchanged) and
  "during a **lock wait**" (freed, at poll granularity); "during a long read" must be restated as
  *may still complete*, joining the existing "during a quick write" bullet. That is a **narrowing of a
  published G4 contract** and, because it changes documented behaviour of a frozen surface without
  changing a type, it is the kind of change `docs/STABILITY.md` would want called out in a major.
- **Escape hatch, disclosed:** a throwing user-defined function *does* abort a running statement
  (exp 06c: threw at 301 ms out of a ~6 s query). This is the only cooperative interrupt available.
  It requires injecting `umbradb_check_abort()` into the query text, works only where the planner
  actually re-invokes it per row, and cannot help a `BEGIN IMMEDIATE` lock wait or an index-only
  scan. Usable as a targeted mitigation for the chain-archive scan queries; not a general answer.

### B2 — No `statement_timeout` / `idle_in_transaction_session_timeout` · **not closeable** · touches **G1, G7, G4**

- **Postgres today:** `SET LOCAL statement_timeout = ${ms}` inside `withTransaction`
  (`transaction-lease.ts:221`), `SET statement_timeout` on the lease's reserved connection
  (`:285`, `:347`), connection-level `statement_timeout` / `lock_timeout` /
  `idle_in_transaction_session_timeout` startup parameters (`src/postgres/client.ts:176-181`) with
  exported defaults 120 s / 30 s / 120 s (`client.ts:143-145`). `test/postgres/timeouts.test.ts`
  asserts all of it; `test/postgres/transaction-lease.test.ts:97` asserts
  `TransactionFaultError(faultKind:"timeout")`.
- **SQLite offers:** `busy_timeout` only. `busy_timeout` bounds *lock waits*, never statement
  runtime. There is no server to enforce anything and no watchdog thread.
- **Gap:** `LeaseAcquireOptions.timeoutMs` maps cleanly onto a poll deadline. `TransactionOptions.timeoutMs`
  does **not** map — it is a frozen field on a frozen interface (`src/interfaces/transaction-lease.ts:166`)
  that would have to become validated-then-ignored, and `faultKind:"timeout"` becomes unreachable.
  `statementTimeoutMs` / `idleInTxTimeoutMs` on `createClient` likewise.
- **This matters more, not less, under SQLite** — see B3: an over-running write transaction now
  blocks every other writer in every process, and there is no server-side backstop to kill it.

### B3 — `withTransaction` becomes a whole-database write mutex · **closeable only with a schema/file redesign** · touches **G5 co-transactionality**

- **Postgres today:** each transaction sits on its own pooled connection; two transactions touching
  different tables never block each other.
- **SQLite:** one write lock per *database file*. Measured (exp 11A): a writer to a **different
  table** in the same file gets `SQLITE_BUSY`. Measured (exp 11D): an `await` inside the callback
  holds the lock for the whole await — another writer was still `BUSY` 352 ms in. Since
  `withTransaction`'s `fn` is arbitrary caller code that may await anything (`transaction-lease.ts:212-229`),
  a slow callback stalls the entire database.
- **Consequence for the archive:** the ~1 GB/hour chain-archive ingest and the wallet-sync writer
  cannot share one file without serialising against each other. Separate files give independent write
  locks (exp 11B: succeeded).
- **Hard constraint this places on L1/L5:** **everything `saveAndAdvance` touches must live in one
  database file.** SQLite does not guarantee atomic commit across `ATTACH`ed databases when any of
  them is in WAL mode. My run committed and rolled back cleanly across an `ATTACH` (exp 11C) — that
  is *not* evidence of crash atomicity and must not be read as such. If a lane proposes splitting
  `ckpt_chunks` / `ckpt_manifests` / `watermarks` across files, G5's "both durable at one commit or
  neither" (`docs/CONTRACT.md:14-18`) breaks. Flagging as a cross-lane dependency, not researching
  file layout here.

### B4 — SQLite does not poison a transaction after a failed statement · **closeable in application code** · touches **G5 / atomicity**

- **Postgres today:** `src/interfaces/transaction-lease.ts:216-226` documents at length that once any
  query through `tx` rejects, "the whole underlying Postgres transaction is poisoned server-side" —
  so a caller who swallows the error and continues gets **nothing** committed.
- **SQLite:** measured (exp 08b) — after a `SQLITE_CONSTRAINT_PRIMARYKEY` (1555) inside
  `BEGIN IMMEDIATE`, the next `INSERT` succeeded and `COMMIT` **committed both surrounding writes**.
  The same holds after `SQLITE_BUSY_SNAPSHOT` (exp 09A: the connection was still inside its
  transaction, not auto-rolled-back).
- **Why this is a safety regression, not a nicety:** the exact caller anti-pattern the docs warn
  about changes outcome from "you get nothing" to "you get a **partial** transaction". The adapter
  must emulate poisoning: set a sticky `poisoned` flag on the handle when any statement through it
  throws, reject every later statement on that handle with the original error, and force `ROLLBACK`
  at the end. Cheap (~20 lines) but **mandatory**, and it is not something a naive port would do.

### B5 — `CONNECTION_ERROR` has no honest embedded meaning · **not closeable without touching G3** · touches **G2, G3**

- The frozen retryable set is `{CONNECTION_ERROR, TRANSACTION_FAULT, LEASE_TIMEOUT,
  MIGRATION_LOCK_TIMEOUT}` (`docs/ERROR-CATALOG.md:60-70`). `docs/STABILITY.md`'s rule (quoted in the
  catalog header) is that within `1.x` no code is "removed, renamed, or **repurposed**".
- Embedded SQLite has no connection. The nearest failure modes — `SQLITE_CANTOPEN` (14),
  `SQLITE_NOTADB` (26), `SQLITE_CORRUPT` (11), `SQLITE_READONLY` (8), `SQLITE_IOERR` (10) — are all
  **non-retryable**. Mapping any of them onto the retryable `CONNECTION_ERROR` would be exactly the
  repurposing the policy forbids, and would make a caller's bounded-retry loop spin on an unopenable
  file.
- **Recommendation:** keep `CONNECTION_ERROR` in the catalog (removal is forbidden) and let it become
  **unreachable** — a code the SQLite adapter never throws. The drift test
  (`test/api-surface/error-catalog-drift.test.ts`, catalog §"The count is enforced") checks
  *table ≡ exported surface*, not reachability, so an unreachable-but-exported code keeps it green.
  Route file-level faults to new non-retryable codes in a minor. **L6 owns the full code catalog;
  this is the concurrency-adjacent subset only.**

### B6 — Blocking waits self-deadlock a single-threaded process · **closeable in application code** · touches **P10 / L1 test**

Not a Postgres-feature gap but a port hazard severe enough to list as a blocker: see §1 and exp 10.
The same reasoning applies to nested `withTransaction`. Today it is documented as
"under a small connection pool this **can** deadlock" (`src/interfaces/transaction-lease.ts:207-212`);
under a synchronous SQLite driver on one thread it is a **guaranteed** self-deadlock — the inner
connection blocks the thread waiting for a write lock the outer connection, on the same thread, holds
and cannot release. Mitigation: implement real reentrancy with `SAVEPOINT` (exp 08a/08d: savepoints
nest and roll back only the inner scope; a bare `SAVEPOINT` outside a transaction opens one), rather
than leave a documented footgun that is now fatal instead of merely risky.

### B7 — Filesystem precondition replaces the pooler precondition · **closeable as documentation** · touches **G4 §1 preconditions**

`docs/CONTRACT.md:26-28` binds the deployer to "no transaction pooler", enforced by
`TransactionPoolerDetectedError`. That precondition disappears. It is replaced by a new binding one:
**the database and its sidecar lock files must live on a local filesystem with working POSIX
advisory locks.** NFS/SMB and, relevantly for this project's own environment, WSL's `/mnt/c` DrvFs
mounts, are documented-unsafe for SQLite locking. Losing lock correctness there silently destroys L1
— it does not error. This wants a startup probe with the same "mandatory step of `runMigrations`"
posture as `probeDurability` (`src/postgres/migrate.ts:162`).

---

## 3. Evidence

All scripts under `/tmp/l2/` in WSL. Node and SQLite versions confirmed at the top of exp 01.
Every block below is real pasted stdout.

### exp 01 — `node:sqlite` API surface (`/tmp/l2/01-api-surface.mjs`)

```
$ wsl -e bash -lc 'cd /tmp/l2 && node 01-api-surface.mjs'
node: v24.18.0
sqlite_version: 3.53.1

--- DatabaseSync.prototype members ---
aggregate applyChangeset close constructor createSession createTagStore deserialize
enableDefensive enableLoadExtension exec function loadExtension location open prepare
serialize setAuthorizer

--- node:sqlite module exports ---
DatabaseSync  Session  StatementSync  backup  constants  default

--- interrupt-ish probes ---
  db.interrupt: undefined
  db.setProgressHandler: undefined
  db.cancel: undefined
  db.setBusyTimeout: undefined
```

**No interrupt. No progress handler.** `constants` carries only changeset/authorizer constants — no
result-code table.

### exp 03 — two-process write contention in WAL (`/tmp/l2/03-contend.mjs`, holder `/tmp/l2/02-holder.mjs`)

```
[A] holder=immediate contender=immediate busy_timeout=300ms  hold=1500ms -> errcode=5 "database is locked" after 302ms
[B] holder=immediate contender=immediate busy_timeout=5000ms hold=800ms  -> SUCCEEDED after 806ms
[C] holder=immediate contender=deferred  busy_timeout=300ms  hold=1500ms -> errcode=5 "database is locked" after 302ms
[D] holder=immediate contender=immediate busy_timeout=0ms    hold=1000ms -> errcode=5 after 0ms
[E] holder=EXCLUSIVE  reader -> READ OK after 0ms
[F] holder=IMMEDIATE  reader -> READ OK after 0ms
```

`busy_timeout` is honoured to ~2 ms precision. `busy_timeout=0` is a true non-blocking probe —
this is the `pg_try_advisory_lock` equivalent. **In WAL mode `BEGIN EXCLUSIVE` does not block
readers** (E) — it behaves as `IMMEDIATE`, so "hold `BEGIN EXCLUSIVE` open" buys nothing over
`IMMEDIATE` as a lease mechanism.

### exp 04 / exp 13 — result codes and `BUSY_SNAPSHOT` (`04-snapshot-and-codes.mjs`, `13-timing.mjs`)

```
c1 upgrade FAILED: code=ERR_SQLITE_ERROR errcode=517 errstr="database is locked"
                   ownProps=["stack","message","code","errcode","errstr"]
constraint error:  errcode=1555 "UNIQUE constraint failed: u.id"

ctor {timeout:4321} -> pragma busy_timeout = 4321
default             -> pragma busy_timeout = 0

BUSY_SNAPSHOT returned after 0ms with busy_timeout=3000 -> errcode=517
after ROLLBACK + BEGIN IMMEDIATE retry: succeeded in 1ms
read-only tx during an open write tx: ok in 0ms, saw 3 rows (writer's row not visible)
```

Three findings. (i) `err.errcode` is the **extended** result code (517 = `SQLITE_BUSY_SNAPSHOT`,
1555 = `SQLITE_CONSTRAINT_PRIMARYKEY`) — enough precision to build the whole error map; hand this to
L6. (ii) **The default `busy_timeout` is 0**; the `DatabaseSync` ctor's `{timeout}` option sets it.
(iii) The busy handler is **not** applied to `BUSY_SNAPSHOT` — it returned in 0 ms despite a 3 000 ms
`busy_timeout`. It is a retry-from-scratch error, not a wait error, and (exp 09A) it does **not**
auto-rollback the reader's transaction.

### exp 05 — SIGKILL with an open `BEGIN IMMEDIATE` (`/tmp/l2/05-sigkill.mjs`)

```
holder pid 284558 is inside an open BEGIN IMMEDIATE with an uncommitted INSERT
files: kill.db kill.db-shm kill.db-wal
PRE-KILL:  write lock contended as expected -> 5 database is locked
holder exited code= null signal= SIGKILL
POST-KILL: acquired write lock and committed after 0ms  <-- kernel released the fcntl lock
rows now: [{"v":"before"},{"v":"after-kill"}]
integrity_check: [{"integrity_check":"ok"}]
files after: kill.db
```

The uncommitted `'holder-wrote'` row is gone, integrity is clean, the `-wal`/`-shm` files were
reclaimed on last-connection close, and the successor acquired the write lock in **0 ms**. This is
the property the whole lease design rests on.

### exp 06 — cancellation (`/tmp/l2/06-cancellation.mjs`)

```
(a) long query ran 6033ms, result n=60000000
    during it: timerFired=false abortSeen=false  <-- 50ms timer inside a 6033ms statement
(b) authorizer calls at prepare=7, after full execution=7  <-- prepare-time only
(c) UDF-abort: statement threw after 301ms -> Error: UMBRADB_ABORTED errcode=undefined
(d) DatabaseSync is not structured-cloneable: DOMException: Cannot clone object of unsupported type.
```

(a) is the hard result for B1. (b) rules out `setAuthorizer` as an interrupt — it fires only at
`prepare`. (c) is the one usable cooperative interrupt. (d) rules out driving an interrupt from a
Worker.

### exp 07 — per-key sidecar lock file as the lease (`07-lease.mjs`, holder `07-lease-holder.mjs`)

```
(1) tryAcquire(busy=0) while held  -> {"ok":false,"ms":0,"errcode":5,"msg":"database is locked"}
(2) acquire(timeout=300ms) held    -> {"ok":false,"ms":302,"errcode":5}
(5) tryAcquire on a different key  -> {"ok":true,"ms":0}
(3) acquire(timeout=5000ms)        -> {"ok":true,"ms":1200}
(4a) pre-kill tryAcquire           -> {"ok":false,"errcode":5}
(4b) post-SIGKILL tryAcquire       -> {"ok":true,"ms":0}   <-- crash-release, no heartbeat
     stale holder pid recorded in the lock row: {"holder":289948}
(6) same-process second connection -> {"ok":false,"ms":201,"errcode":5}
(7) nested begin on one connection -> "cannot start a transaction within a transaction" errcode=1
```

Every semantic `TransactionLeaseLayer` needs is present: non-blocking try (1), bounded wait (2),
successful wait (3), per-key independence (5), **cross-process crash release in 0 ms with no
heartbeat and no takeover rule** (4b), and **in-process mutual exclusion between two connections in
one process** (6) — the last is what P10 actually exercises today.

### exp 08 — savepoints and transaction poisoning (`/tmp/l2/08-savepoint.mjs`)

```
(a) after inner rollback: [{"v":"outer"}]
(b) stmt failed: 1555 UNIQUE constraint failed: t.id
(b) transaction STILL USABLE after a failed statement: [{"v":"outer"},{"v":"ok1"},{"v":"ok2"}]
(d) savepoint-as-outermost-tx rows: [{"id":1}]
```

### exp 09 — WAL snapshot isolation, `flock` interaction, cancellable poll loop (`09-followup.mjs`)

```
(A)  after BUSY_SNAPSHOT, c1 in autocommit (auto-rolled-back)? -> false
(A2) after constraint error, in autocommit? -> false
(B)  WAL snapshot: reader saw 2 at snapshot, 2 mid-tx (writers committed 3), 5 after commit
(C)  SQLite wrote successfully while an external `flock -x` held the SAME file (0ms)
(D)  poll-loop acquire with mid-wait abort -> AbortError after 356ms (abort scheduled at 350ms)
```

(B) is real snapshot isolation for a `DEFERRED` reader — **strictly stronger than Postgres READ
COMMITTED**, and it is free. (C) answers the brief's `flock` question directly: on Linux `flock(2)`
and the `fcntl(F_SETLK)` POSIX record locks SQLite's unix VFS uses are **independent lock spaces**.
An external `flock` on the DB file neither blocks SQLite nor is respected by it. So `flock` is safe
to use as a *separate* lease channel but is useless as a fence against SQLite writers — and anyone
who assumes otherwise gets a silent mutual-exclusion hole. (Node core exposes no `flock`/`fcntl`
binding anyway, so this route also needs a native addon — an L3 dependency the sidecar-file design
avoids entirely.)

### exp 10 — P10 reproduction, naive port vs. poll loop (`/tmp/l2/10-p10-selfdeadlock.mjs`)

```
(a) blocking busy_timeout=1000: acquired=1/8 failed=[7x LeaseTimeoutError] maxActive=1 overlap=false elapsed=7018ms
(b) poll loop timeout=5000    : acquired=8/8 failed=[]                     maxActive=1 overlap=false elapsed=171ms
(c) mid-wait abort -> AbortError after 204ms (abort at 200ms)
```

This mirrors `test/postgres/transaction-lease.property.test.ts` (8 concurrent `withLease` on one key,
20 ms critical section, `maxActive` instrumented). The naive port **fails P10**: 7 s of the run is
seven serialised 1 s busy waits during which the 20 ms holder could not reach the event loop. The
poll loop passes with the same `maxActive === 1` assertion the real test makes.

**What would have to be true for (a) to be a wrong reading:** if the holder's critical section were
purely synchronous (never awaited), the blocking wait would be harmless. It is not — `withLease`'s
`fn` is arbitrary async caller code, and every real call site (`saveAndAdvance`, `README.md:163`) does
I/O inside it. The negative result stands specifically for async critical sections, which is the
only kind this API has.

### exp 11 — scope of the write lock, `ATTACH` (`/tmp/l2/11-scope.mjs`)

```
(A) writer to a DIFFERENT TABLE in the same file -> BUSY errcode=5
(B) writer to a DIFFERENT FILE -> SUCCEEDED
(C) cross-ATTACH commit rows main: 1  arch: 2 ; after rollback main: 1 arch: 2 ; both journal_mode=wal
(D) another writer during an awaiting withTransaction -> BUSY (352ms into the holder's await)
```

### exp 12 — `SQLITE_LOCKED` and iterator hazards (`/tmp/l2/12-locked.mjs`)

```
(a) DROP during live iterate -> errcode= 6 "database table is locked"
(b) UPDATE during live iterate: allowed
(c) rows after close() with an open write tx: []   (implicit ROLLBACK)
```

`SQLITE_LOCKED` (6) is a **same-connection** error, not a cross-process one: DDL while a cursor is
open on that table. Directly relevant to migrations (`src/postgres/migrate.ts` runs DDL) and to any
`listKeys`-style streaming read. (c) confirms `close()` implicitly rolls back — the desired direction.

### Code citations (worktree-relative)

| What | Where |
|---|---|
| Module-level handle registry (survives the port, unchanged rationale) | `src/postgres/transaction-lease.ts:35-61` |
| `raceAgainstAbort` + already-aborted entry check (deletes) | `src/postgres/transaction-lease.ts:91-117` |
| `reserveBounded` + `RESERVE_TIMED_OUT` (deletes — no pool) | `src/postgres/transaction-lease.ts:130-170` |
| `resetStatementTimeout` (deletes — no pooled connection to poison) | `src/postgres/transaction-lease.ts:181-184` |
| `SET LOCAL statement_timeout` in `withTransaction` (**no analogue**) | `src/postgres/transaction-lease.ts:221` |
| Advisory-lock class 2, `hashtext(key)` (becomes a lock-file name) | `src/postgres/transaction-lease.ts:195, 287, 301` |
| `withLease` release-fault machinery (becomes near-unreachable) | `src/postgres/transaction-lease.ts:403-472` |
| Transaction-poisoning contract text (**inverted under SQLite**) | `src/interfaces/transaction-lease.ts:216-226` |
| Non-reentrancy note (becomes a guaranteed deadlock) | `src/interfaces/transaction-lease.ts:207-212` |
| `TransactionOptions.timeoutMs` / `isolation` (frozen, unimplementable) | `src/interfaces/transaction-lease.ts:163-176` |
| `LeaseAcquireOptions.timeoutMs` / `signal` (implementable) | `src/interfaces/transaction-lease.ts:178-198` |
| Server-side timeout defaults 120 s / 30 s / 120 s (**no analogue**) | `src/postgres/client.ts:143-145, 176-181` |
| Migration advisory lock class 1 + `SET LOCAL lock_timeout` | `src/postgres/migrate.ts:207-232` |
| `MIGRATION_LOCK_TIMEOUT`, retryable | `src/postgres/migrate.ts:18-38` |
| `saveAndAdvance` — one transaction, both writes | `src/postgres/save-and-advance.ts:66-70` |
| GC prune's explicit READ COMMITTED dependency | `src/postgres/checkpoint-store.ts:485-487` |
| `load` / `history` under `repeatable read` (torn-read fix) | `src/postgres/checkpoint-store.ts:392, 458` |
| L1 status: MECHANISM SPECIFIED, "breaks only under a transaction-pooling proxy" | `Formal/STORAGE_ALGEBRA.md:318-321` |
| P10's spec ("ideally multiple processes") | `Formal/STORAGE_ALGEBRA.md:389-396` |
| Cancellation contract (the one that narrows) | `docs/CONTRACT.md:55-70` |
| Lease limitation: "Do not run two writer processes" | `docs/CONTRACT.md:101-112` |
| Frozen retryable set | `docs/ERROR-CATALOG.md:60-70` |

---

### The four lease options, judged on the question that decides them

| Option | Behaviour on `SIGKILL` of the holder | Verdict |
|---|---|---|
| **OS file lock (`flock`/`fcntl`) beside the DB** | Kernel releases. **Correct.** | Rejected on cost, not correctness. Node core exposes neither call, so it needs a native addon (L3 dependency). `flock(2)` is measurably invisible to SQLite's own `fcntl` locks (exp 09C), and raw `fcntl` carries the classic "closing *any* fd to the file drops *all* that process's locks" footgun that SQLite's VFS already solves internally. |
| **Lock table row + heartbeat + stale takeover** | Row survives. Without a heartbeat: **deadlocks forever.** With a heartbeat: recovers after the takeover timeout `T`, but safety now rests on "no live holder is ever stalled longer than `T`" — unknowable. A GC pause, a swapping host, a paused debugger, or (per this project's own recorded environment issues) a frozen WSL VM resumes and writes after being declared dead. | **Rejected on the project's own prior grounds.** This is exactly the TTL/lease-stealing design `Formal/STORAGE_ALGEBRA.md:305-317` and `src/interfaces/transaction-lease.ts:10-15` **already removed**, because L1 cannot be guaranteed for arbitrary caller code without a fencing token, a lease-loss `AbortSignal`, and fencing checks on every downstream write. Choosing it would silently reopen a closed decision and downgrade L1 from *unconditional* to *conditional on a liveness assumption*. |
| **`BEGIN EXCLUSIVE` held open on the main DB** | Kernel releases. **Correct.** | Rejected on granularity. It is whole-database, so it cannot express per-key leases (`wallet-sync:{networkId}`), and it serialises writers that hold no lease at all. Also measured (exp 03E): in WAL mode `EXCLUSIVE` does not even block readers — it is `IMMEDIATE` with a misleading name. |
| **Per-key sidecar lock DB under a held `BEGIN IMMEDIATE`** | Kernel releases the underlying `fcntl` lock. Successor acquired in **0 ms** (exp 07/4b). | **Chosen.** Zero dependencies, per-key, works cross-process *and* between connections in one process (exp 07/6), and reproduces `pg_advisory_lock`'s semantics — including "no TTL, no self-expiry, no stealing" — exactly as `src/interfaces/transaction-lease.ts:31-33` specifies. |

**The mutual-exclusion property that survives, stated precisely:** for each lease key, at most one
holder at any instant; a holder retains the lease until it explicitly releases, closes the lock
connection, or its **process** dies. This is *not* weaker than today's — it is a shift of failure
domain from *connection* to *process*, and the process domain is strictly the coarser (safer) one.
Today a Postgres backend can be terminated while the client process lives on believing it holds the
lease; that is precisely the case `withLease`'s `onReleaseFault` exists to report
(`src/interfaces/transaction-lease.ts:189-194`) and that CONTRACT.md §5 flags as unfenced. Under a
sidecar lock file the lock cannot outlive, or die before, its holder.

### Cross-process vs. in-process — what UmbraDB actually promises

The code and docs are unambiguous, and they resolve the lane:

- `docs/CONTRACT.md:109-110` — "**Do not run two writer processes.** UmbraDB is designed for a single
  writer against a single Postgres instance; running two writer processes is unsupported in the 1.0
  model."
- `src/interfaces/transaction-lease.ts:14-15` — "correct for this project's **single-process,
  single-writer** deployment; revisit only if a real multi-process/crash-recovery requirement appears."
- `Formal/STORAGE_ALGEBRA.md:389-393` (P10) — the guarantee is *connection*-scoped; the test uses 8
  independent connections in one process and notes multiple processes would be "ideal", not required.

So the **promise is one writer process; the obligation that must actually hold is mutual exclusion
between concurrent async callers and connections inside that process.** A pure in-process JS mutex
(`Map<key, Promise>` queue) would satisfy the letter of the 1.0 promise and would be ~30 lines. I
recommend against it: it silently discards two things the current implementation provides for free —
crash release, and protection against an *accidental* second process (a stray CLI, a leftover
supervisor, a `--watch` reload overlapping the old process). The sidecar lock file costs no
dependencies, satisfies the promise, and lets `CONTRACT.md` §5 be **strengthened** to "a second
writer process is refused, not merely unsupported." That is one of the few places SQLite beats
Postgres in this lane.

### Transactions — which `BEGIN`, and nesting

- **`withTransaction` → `BEGIN IMMEDIATE`.** `DEFERRED` takes no write lock at `BEGIN`; the first
  write attempts an upgrade, which yields `SQLITE_BUSY` (exp 03C) or, if any other connection
  committed since the read snapshot, `SQLITE_BUSY_SNAPSHOT` (517). 517 is **not** retried by the
  busy handler (exp 13: returned in 0 ms under `busy_timeout=3000`) and does **not** auto-rollback
  (exp 09A) — the caller must `ROLLBACK` and re-run the whole callback. `IMMEDIATE` converts that
  unavoidable mid-callback failure into a bounded wait at `BEGIN`, where the callback has not yet run
  and a retry is free.
- **`saveAndAdvance` → `BEGIN IMMEDIATE`, same file.** With `IMMEDIATE`, the checkpoint write and the
  watermark advance are in one file-level transaction; SIGKILL before `COMMIT` discards both
  (exp 05: the uncommitted row was gone, integrity clean). G5's ordering guarantee holds. The
  constraint is B3's: one file.
- **`prune` → must become `BEGIN IMMEDIATE`, and its stated argument must be rewritten.**
  `checkpoint-store.ts:485-487` explicitly depends on READ COMMITTED's per-row re-evaluation for its
  grace-window TOCTOU argument. Under WAL, a `DEFERRED` prune would evaluate its
  `NOT EXISTS (… ckpt_manifest_chunks …)` against a *snapshot*, so a chunk re-referenced by a `save`
  that committed after the snapshot would still look unreferenced — **a direct C2a violation**.
  Under `IMMEDIATE`, no other writer can commit for the transaction's whole duration, so
  `Deleted ∩ ⋃_{m∈Live} refs(m) = ∅` becomes trivially true. Net: C2a gets *stronger* and simpler,
  but the sentence justifying it in the code and in `STORAGE_ALGEBRA.md` §2 is wrong as written and
  must be re-derived, not carried over. The 15-minute grace window is no longer load-bearing for
  safety (keep it for the backup story).
- **Nesting: SQLite has no nested `BEGIN`** (exp 07/7, `errcode=1` "cannot start a transaction within
  a transaction"), but **`SAVEPOINT` covers it fully** (exp 08a: inner rollback left the outer write
  intact; exp 08d: `SAVEPOINT` outside a transaction opens one). The current code uses no nesting and
  documents `withTransaction` as non-reentrant. Because B6 makes accidental nesting fatal rather than
  merely risky, I recommend implementing reentrancy via `SAVEPOINT` — an *additive* behaviour change
  (previously-broken code now works), permissible under G2.

### Isolation

- The code sets a non-default isolation in exactly two places, both `repeatable read`, both for the
  same torn-read fix: `checkpoint-store.ts:392` (`load`) and `:458` (`history`). Everything else runs
  Postgres's default READ COMMITTED, and `prune` says so deliberately.
- **WAL is strictly stronger for readers.** Measured (exp 09B): a `DEFERRED` reader pinned its
  snapshot and saw 2 rows while three writer commits landed, then 5 after committing. That *is*
  `repeatable read`, obtained for free — so `load`/`history`'s explicit isolation option becomes a
  no-op that can be dropped from the call sites while `TransactionOptions.isolation` stays on the
  frozen surface as validated-then-ignored.
- **Writers are serialised, so `serializable` is also free** and `40001` serialization failures
  between writers cannot occur. `TransactionFaultError(faultKind:"serialization-failure")` maps
  instead onto `SQLITE_BUSY_SNAPSHOT` (517), which is the same *shape* of error (your snapshot is
  stale, retry the whole transaction) reached by a different route.
- **`faultKind:"deadlock"` becomes unreachable.** With a single write lock per file there is no
  lock-cycle to detect; SQLite returns `SQLITE_BUSY` to one party instead of deadlocking. That
  invalidates `test/postgres/transaction-lease.test.ts:195`.
- **Readers are never blocked by writers** (exp 03E/03F, exp 13: a read-only transaction opened and
  completed in 0 ms during an open write transaction). No `lock_timeout` analogue is needed on the
  read path at all.

### Concurrency-related result-code mapping (L6 owns the full catalog)

| SQLite (`err.errcode`, extended) | Context | UmbraDB code | Retryable |
|---|---|---|---|
| `5` `SQLITE_BUSY` | lease acquire, poll deadline elapsed | `LEASE_TIMEOUT` | retryable (unchanged) |
| `5` `SQLITE_BUSY` | migration lock acquire, bound elapsed | `MIGRATION_LOCK_TIMEOUT` | retryable (unchanged) |
| `5` `SQLITE_BUSY` | `BEGIN IMMEDIATE` inside `withTransaction` | `TRANSACTION_FAULT` (`faultKind:"timeout"`) | retryable (unchanged) |
| `517` `SQLITE_BUSY_SNAPSHOT` | snapshot went stale on write upgrade | `TRANSACTION_FAULT` (`faultKind:"serialization-failure"`) | retryable (unchanged) |
| `261` `SQLITE_BUSY_TIMEOUT` | busy handler gave up (not observed in my runs — `5` was returned even after the timeout elapsed, exp 03A) | same as `5` for its context | — |
| `6` `SQLITE_LOCKED` | DDL vs. a live cursor on the *same* connection (exp 12a) | programmer error → `UNRECOGNIZED_*`; must be prevented in the migration runner | non-retryable |
| `14`/`26`/`11`/`8`/`10` (`CANTOPEN`/`NOTADB`/`CORRUPT`/`READONLY`/`IOERR`) | file-level faults | **not** `CONNECTION_ERROR` — see B5 | non-retryable |

The frozen retryable set survives **as a set**: all four codes remain reachable and correctly
retryable except `CONNECTION_ERROR`, which becomes unreachable rather than repurposed.

### What gets easier — and what deletes

- **The connection pool disappears**, and with it: `reserveBounded` + `RESERVE_TIMED_OUT`
  (`transaction-lease.ts:130-170`, ~40 lines), the `LeaseFaultError("reserve-failed")` fault kind, the
  `maxConnections` / `connectTimeout` options, `assertNoConflictingSearchPath`, and the entire
  "blocked purely on connection-pool exhaustion" test family — `transaction-lease.test.ts:351`,
  `:376`, `:530`, `:565`.
- **`resetStatementTimeout`** (`:181-184`) and the whole "a `SET` poisons the pooled connection"
  hazard, plus its two regression tests (`:445`, `:469`).
- **`raceAgainstAbort`** (`:91-117`, ~27 lines of hard-won cross-vendor-audited race handling) —
  replaced by a poll loop that is both shorter and, per exp 10, *required* anyway.
- **`TransactionPoolerDetectedError`** and its probe; the "session-mode pool" precondition in
  `docs/CONTRACT.md:26-28` and `docs/durability-contract.md`.
- **`withLease`'s release-fault apparatus** (`:403-472`, ~70 lines, plus all 7 tests in
  `with-lease-release-fault.test.ts`) becomes near-unreachable: `ROLLBACK` on a local file handle does
  not fail from connection death. Keep the API (G1 freezes it); expect it to be dead code.
- **`faultKind:"deadlock"`** and its test; **`isConnectionFailure`** on the transaction path.
- No network partition, no server to be down, no `search_path` to restore, no `hashtext()` collision
  analysis (`client.ts:22-29`), no 63-byte identifier limit.
- The **handle registry** (`:35-61`) survives unchanged and for exactly the reason its comment gives —
  two independently-constructed adapters must agree on a live transaction handle with no DI container.
  Under SQLite it maps to a `DatabaseSync` connection instead of a `postgres.js` `sql` callback.

---

## 4. Design sketch

Assumes **L3 chooses a synchronous driver** (`node:sqlite` or `better-sqlite3`). If L3 instead
chooses an async, off-thread driver, B1(a) and B6 both soften considerably — flag that as this lane's
single largest dependency. Assumes **L1/L5 keep everything `saveAndAdvance` touches in one file** (B3).

### Connection model

```
main.db          — one writer connection, N reader connections (WAL readers never block)
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 0;        -- NEVER block inside SQLite: all waiting is done in JS
  PRAGMA synchronous = FULL;      -- L4's call, not mine
<schema>.locks/<sha256(key)>.lock.db   — one tiny sidecar DB per lease key
<schema>.migrate.lock.db               — the class-1 migration lock
```

`busy_timeout = 0` everywhere is the load-bearing decision. Every wait becomes a JS poll loop, which
(a) keeps the event loop turning so an in-process holder can actually release (exp 10), and (b) makes
`opts.signal` genuinely honoured mid-wait (exp 09D/10c).

### The lease

```ts
// src/sqlite/transaction-lease.ts
const LOCK_DDL = `create table if not exists lease(
  id integer primary key check(id = 1), holder_pid integer, acquired_at text)`;

async function acquireLocked(path: string, timeoutMs: number | undefined,
                             signal: AbortSignal | undefined, pollMs = 5) {
  const db = new DatabaseSync(path, { timeout: 0 });     // never block in SQLite
  const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) { db.close(); throw abortError(signal); }
    try { db.exec("begin immediate"); return db; }        // <- the lock IS the held transaction
    catch (e) { if (e.errcode !== 5 && e.errcode !== 517) { db.close(); throw e; } }
    if (Date.now() >= deadline) { db.close(); return null; }  // caller maps to LeaseTimeoutError | null
    await sleep(pollMs);                                  // yields: holder can release; abort observable
  }
}
```

- `acquireLease(key, {timeoutMs})` → `acquireLocked(...)`, `null` → `LeaseTimeoutError`.
- `tryAcquireLease(key)` with no `timeoutMs` → one attempt, no sleep (exp 07/1: 0 ms).
- `releaseLease` → `ROLLBACK` (never `COMMIT`; the lock row is bookkeeping, not data) + `close()`.
  Cannot fail from connection death, so `LeaseFaultError("connection-lost")` becomes unreachable.
- `heldLeases: Map<token, {db, key, path}>` replaces the `ReservedSql` map — same shape,
  same `LeaseNotHeldError` semantics for a double release.
- Suggested poll schedule: 1 ms for the first 20 ms, then 5 ms, capped at 25 ms. Under P10-shaped
  contention the measured end-to-end cost of 8 serialised 20 ms critical sections was 171 ms
  against a 160 ms floor (exp 10b) — ~1.4 ms of overhead per handoff at a flat 5 ms poll.

### Transactions

```ts
async function withTransaction<T>(fn, opts) {
  if (opts?.signal?.aborted) throw abortError(opts.signal);   // pre-check only (unchanged)
  const db = this.writer;                                     // single writer connection
  return this.writeQueue.enqueue(async () => {                // in-process serialisation, async-safe
    db.exec("begin immediate");                               // + poll-retry on errcode 5
    const handle = registerTransaction(db);                   // registry unchanged, ts:35-61
    try { const v = await fn(handle); db.exec("commit"); return v; }
    catch (e) { try { db.exec("rollback"); } catch {} throw translateSqliteError(e); }
    finally { unregisterTransaction(handle); }
  });
}
```

Three notes. (i) The `writeQueue` is mandatory, not an optimisation: without it two concurrent
in-process `withTransaction` calls on the same connection hit `errcode=1` "cannot start a transaction
within a transaction" (exp 07/7). (ii) Nested calls resolve to `SAVEPOINT sp<n>` /
`RELEASE` / `ROLLBACK TO` (exp 08a) instead of the current documented footgun. (iii) The handle must
carry a sticky `poisoned` flag set by the adapter wrapper around every statement, so a caller who
swallows an error cannot produce a partial commit (B4, exp 08b).

### Migration lock

`pg_advisory_lock(1, hashtext(schema))` → `acquireLocked("<schema>.migrate.lock.db",
migrationLockTimeoutMs)`; `null` → `MigrationLockTimeoutError` unchanged, still retryable. The
`SET LOCAL lock_timeout` / session-lock-survives-COMMIT dance (`migrate.ts:217-232`) and the
`lockHeld` cleanup flag all disappear — the lock is a file handle in a `finally`. **New hazard:**
`SQLITE_LOCKED` (6) fires on DDL while a cursor is open on the same connection (exp 12a), so the
migration runner must use a dedicated connection and materialise every result set before running DDL.

### New startup probe (replaces the pooler probe)

Same mandatory-step-of-`runMigrations` posture as `probeDurability` (`migrate.ts:162`): create a
throwaway sidecar lock file, take `BEGIN IMMEDIATE` on it from two connections in-process, and assert
the second is refused with `errcode=5`. On a filesystem with broken advisory locks (NFS, SMB, WSL
DrvFs) the second succeeds, and L1 is silently void — this probe turns that into a startup rejection
(B7).

---

## 5. Open questions / what I could not settle

1. **`better-sqlite3` vs `node:sqlite` for interrupt.** `better-sqlite3` is also synchronous, so
   B1(a) applies regardless; the async `node-sqlite3` binding does expose `interrupt()`, but on a
   different threading model with different transaction semantics. **I did not evaluate drivers —
   L3 owns this.** If L3 lands an off-thread async driver, B1 must be re-examined: it might reduce
   from "not closeable" to "closeable", which would materially change this lane's verdict on G4.
2. **Poll granularity vs. tail latency at production contention.** I measured 8 concurrent acquirers
   with 20 ms critical sections. I did **not** measure the chain-archive shape (sustained 1 GB/hour
   ingest holding the write lock in long batches while a wallet-sync writer polls). A 5 ms poll
   against a multi-second batch is fine; a 5 ms poll against thousands of 200 µs transactions is
   pure overhead and would want an adaptive or `Atomics.wait`-based handoff.
3. **WAL checkpoint starvation.** Continuous readers can prevent WAL checkpointing, letting `-wal`
   grow without bound. I did not test this and it interacts with L1/L5's archive sizing. Whoever owns
   `wal_autocheckpoint` / `PRAGMA wal_checkpoint(TRUNCATE)` policy should treat it as a concurrency
   concern, because the mitigation (a periodic `TRUNCATE` checkpoint) needs the write lock.
4. **Whether the sticky-poison emulation (B4) is sufficient.** I verified that SQLite does not poison
   and that a naive port therefore commits partially. I did **not** build and test the emulation, so
   I cannot claim the ~20-line sketch closes every path (e.g. a statement that fails inside a
   `SAVEPOINT` a caller then releases).
5. **`SQLITE_BUSY_TIMEOUT` (261).** SQLite documents it, but every timed-out wait in my runs returned
   plain `5` (exp 03A, 07/2). I could not produce 261 and cannot say when it fires; the mapping table
   above lists it defensively. L6 should confirm against the amalgamation rather than my runs.
6. **Windows locking parity.** All experiments ran on WSL2 (real Linux, `fcntl`). SQLite on Windows
   uses `LockFileEx`, which is also released on process death, so I expect the lease to behave
   identically — but that is an **inference**, not a measurement. UmbraDB targets Node ≥ 24 with no
   stated OS restriction, so it needs verifying before the lease design is committed.
7. **What P10 should become.** Today it is 8 connections in one process. The sidecar design makes a
   genuine *multi-process* P10 cheap and meaningful for the first time (`STORAGE_ALGEBRA.md:389`'s
   "ideally multiple processes"). Whether to strengthen the property test — and thereby whether to
   strengthen `CONTRACT.md` §5 from "unsupported" to "refused" — is a product decision, not a
   research finding.

---

## 6. Cost estimate

**Implementation: ~2.5–3.5 engineer-weeks for this lane's slice.**

| Work | Size |
|---|---|
| `src/sqlite/transaction-lease.ts` — poll-loop lease, write queue, `SAVEPOINT` reentrancy, poison emulation | ~350 lines net (replacing ~470) · 4–5 days |
| Lock-file lifecycle: naming, directory creation, cleanup of orphaned `*.lock.db`, `close()` on process exit | 1–2 days |
| Filesystem advisory-lock startup probe (B7) + typed error | 1 day |
| Migration lock port + `SQLITE_LOCKED` avoidance in the DDL runner | 1–2 days |
| `prune` → `BEGIN IMMEDIATE` + re-derive the C2a argument in code comments and `STORAGE_ALGEBRA.md` §2 | 1 day |
| Error mapping for the concurrency subset (with L6) | 1 day |
| Test port: rewrite ~12 lease/transaction tests, delete ~8 pool/pooler tests, extend P10 to multi-process | 4–5 days |
| Doc changes: `CONTRACT.md` §3 and §5, `durability-contract.md` preconditions, `ERROR-CATALOG.md` note on `CONNECTION_ERROR` | 1–2 days |

**What it breaks, named:**

| Commitment | Break | Severity |
|---|---|---|
| **G4 §3 cancellation** | "During a long read the in-flight cursor is **freed**" becomes false. Lock waits stay cancellable; statement-bound reads do not. | **Contract rewrite.** The only unavoidable one. |
| **G4 §1 preconditions** | "no transaction pooler" is replaced by "local filesystem with working POSIX advisory locks". | Swap, not a loss. |
| **G4 §5 lease limitation** | Can be *strengthened*: a second writer process becomes refused rather than merely unsupported. | Improvement. |
| **G4 §6 backup/restore** | "reads run under `REPEATABLE READ`" is still true (WAL gives it free), but `pg_dump` guidance is entirely replaced. | L4/L5's lane. |
| **G1 frozen surface** | No type changes. `TransactionOptions.timeoutMs` and `.isolation` become validated-then-ignored; `LeaseFaultError("reserve-failed")` and `faultKind:"deadlock"` become unreachable. | Silent behaviour change on a frozen field — must be documented, arguably a major. |
| **G2/G3 error catalog** | `CONNECTION_ERROR` becomes unreachable rather than repurposed (repurposing is explicitly forbidden). The retryable set survives as a set. | Manageable if it is *not* repurposed. |
| **G7 timeouts** | `statementTimeoutMs` / `idleInTxTimeoutMs` have no implementation; `DEFAULT_*` constants stay exported but stop meaning anything. `test/postgres/timeouts.test.ts` mostly deletes. | Real capability loss, worsened by B3. |
| **L1 (`STORAGE_ALGEBRA` §4)** | Holds, with the enforcing mechanism restated from "session-scoped advisory lock, breaks under a transaction-pooling proxy" to "OS advisory file lock, breaks on a filesystem without working POSIX locks". Status stays MECHANISM SPECIFIED. | No downgrade. |
| **C2a (`STORAGE_ALGEBRA` §2)** | Gets *stronger* (a single writer under `BEGIN IMMEDIATE` makes it trivial), but the READ-COMMITTED-based justification at `checkpoint-store.ts:485` is **wrong as written** under WAL and must be re-derived — not carried over. | Must not be copy-pasted. |
| **P10** | Passes only with the poll-loop design; **fails 7/8 with the naive port**. Should be extended to multiple processes, which the design now makes possible. | Caught here, cheap to avoid. |
