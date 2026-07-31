# Proposal — SQLite concurrency, transactions and the writer lease

> **Status:** Draft for the 1.0.0 program. Capability: `transaction-lease`. Change id:
> `v1.0.0-sqlite-concurrency-lease`. Change **3 of 5** in the PostgreSQL→SQLite migration. It
> depends on `v1.0.0-sqlite-engine-core` (driver, handle lifecycle, pragma bootstrap, worker
> topology, the blocking ext4 measurement gate) and is depended on by
> `v1.0.0-sqlite-temporal-event-log` (whose T5 trigger runs inside this layer's transactions) and
> `v1.0.0-sqlite-schema-parity` (whose migration runner takes this layer's migration lock).

## Why

`src/postgres/transaction-lease.ts` is 473 lines built on four PostgreSQL server facilities that do
not exist in an embedded engine: a connection pool (`sql.reserve()`), session-scoped advisory locks
(`pg_advisory_lock`, class 2, `transaction-lease.ts:195,287,301`), protocol-level query cancellation
(`raceAgainstAbort`, `:91-117`), and server-enforced timeouts (`set local statement_timeout`, `:221`;
`statement_timeout` / `lock_timeout` / `idle_in_transaction_session_timeout` startup parameters,
`src/postgres/client.ts:176-181`, defaults 120 s / 30 s / 120 s at `client.ts:143-145`). Roughly 180
of those lines delete outright. What replaces them is not a transliteration, and the research found
that the obvious transliteration is wrong in three separate, independently fatal ways.

**First, the proposed replacement lease is broken.** Research lane L2 selected a *per-key sidecar
SQLite lock file held open under `BEGIN IMMEDIATE`* (`reports/l2-concurrency.md` §4), measured 0 ms
successor acquisition after `SIGKILL`, and claimed it was "one of the few places SQLite beats
Postgres in this lane" and strictly safer than `pg_advisory_lock`. The red-team seat broke it twice
over (`council/redteam.md` §2 #5, §3.1):

- **POSIX record locks are dropped when a process closes *any* file descriptor on the inode.** A
  single `fs.readFileSync` of the lock file — by consumer code, by a diagnostic, by a backup script
  running in-process — silently voids the lease. Measured: `[post-readFileSync] competitor
  tryAcquire -> {"ok":true}`, `*** MUTUAL EXCLUSION BROKEN: two live holders of the same lease key
  ***`. SQLite's unix VFS defers closing *its own* descriptors precisely to dodge this; it cannot
  defend against a descriptor Node's `fs` module opened.
- **`unlink` defeats it outright.** Deleting the sidecar while held gives the next acquirer a new
  inode, a new lock space, and therefore a second simultaneous holder. Measured:
  `*** MUTUAL EXCLUSION BROKEN: new inode => new lock space => two live holders ***`.

Neither failure raises an error. Worse, the conformance suite would not catch either: the red team
established that **P1–P10 as written pass against a lease that is void**, and that L2's own proposed
startup probe (two in-process connections, assert the second is refused) does not catch it either
(`council/redteam.md` §2 #7).

**Second, the obvious wait primitive deadlocks.** Porting `pg_advisory_lock`'s blocking wait to
`PRAGMA busy_timeout` fails P10: eight concurrent in-process `withLease` calls on one key resolve
**1 acquired / 7 `LEASE_TIMEOUT`**, because the blocking wait pins the thread and the holder can
never reach the event loop to release. The JS poll loop makes the identical test **8/8, `maxActive`
1** (`reports/l2-concurrency.md` exp 10). L2's *prescription* is right; its *stated reason* ("keeps
the event loop turning") is wrong under `v1.0.0-sqlite-engine-core`'s worker topology, where the
main loop keeps turning by construction. The contradiction seat put the blocking wait inside the
worker and measured the deadlock move rather than disappear: the release message sat in the
**worker's** queue for three seconds while the main thread ticked 3,649 times healthily
(`council/contradiction.md` §2.6, §3.W).

**Third, SQLite does not poison a transaction after a failed statement.** Today's frozen interface
documents at length that once any query through `tx` rejects, "the whole underlying Postgres
transaction is poisoned server-side," so a caller who swallows the error and continues gets
**nothing** committed (`src/interfaces/transaction-lease.ts:216-226`). Under SQLite the same caller
gets a **partial** commit — measured twice, once for a statement-level failure
(`council/contradiction.md` §3.A) and once for an *adapter-thrown* guard that never reached SQLite
at all (`§3.A2`: `ON DISK: [{"id":1,"v":"a"},{"id":2,"v":"c"}] <- PARTIAL COMMIT`). The second case
is the one neither lane could see alone, and it is the one that matters, because the adapter-side
guards this migration introduces throw before any statement is issued.

Alongside those three, the migration removes `idle_in_transaction_session_timeout` — a *server-side*
backstop — while `withTransaction` becomes a **whole-database** write mutex held around arbitrary
caller code (`reports/l2-concurrency.md` B3, exp 11A/11D). The feasibility seat rates this the most
under-weighted loss in the sprint: "today that is a slow query; tomorrow it is a stalled database"
(`council/feasibility.md` §4 item 7). Nothing in the corpus replaces it. This change does.

Against that, three things genuinely get **better** and must be claimed as such: WAL gives a
`DEFERRED` reader real snapshot isolation, strictly stronger than READ COMMITTED and free
(`reports/l2-concurrency.md` exp 09B); a single write lock per file makes serialization failures
between writers impossible and makes C2a's safety argument trivial rather than delicate; and the
lease's failure domain moves from *connection* to *process*, which is the coarser and therefore the
safer one.

Every claim below cites real code at `/root/UDB-sqlite-sprint` (`file:line`) read in this session, or
a named council/lane artifact. Per `openspec/config.yaml`'s correctness rule, external-API claims
were re-verified against the installed runtime, not recalled — see `design.md` §9.

## What changes

1. **The lease mechanism is replaced, not repaired (design §1).** The per-key sidecar lock file is
   **rejected and must not be implemented.** Law L1 (`Formal/STORAGE_ALGEBRA.md` §4) is enforced by
   a **process-local per-key FIFO mutex** that touches no file, takes no `fcntl`/`flock`, and
   therefore cannot be voided by a descriptor close or by `unlink` — it has no inode to attack. The
   two red-team attacks become **negative-control scenarios asserting the lease survives**, and a
   third negative control pins the rejected sidecar so nobody re-proposes it. Crash release becomes
   exact rather than fast: the mutex lives in the dying process's heap.

2. **Cross-process protection is delivered by a writer-generation guard on the main database file
   (design §2).** A registration row is bumped under `BEGIN IMMEDIATE` at open; **every** write
   transaction re-reads it *inside* its own `BEGIN IMMEDIATE` and refuses to commit if it has
   changed. No TTL, no heartbeat, no liveness heuristic, no stale-lock cleanup step.

   **Gate R-2 falsified the premise this originally rested on, and the correction is stated in the
   design rather than buried in it.** An earlier revision claimed the main database *survives* the
   descriptor attack, citing the red team. That test read `main.db`; WAL keeps its locks on
   `main.db-shm`, which the test never touched. Reproduced independently on ext4 against the ruled
   binding (design §12(g)): one `fs.readFileSync` of `-shm` inside the holding process voids the
   write lock held by an open `BEGIN IMMEDIATE`; a second OS process then commits inside the
   holder's transaction; **both `COMMIT`s return ok, one acknowledged commit is silently lost, and
   `integrity_check` still reports `ok`.** An open-and-hold arm is harmless, which isolates the
   fault to the close rather than the read.

   The guard neither causes that hazard nor would removing it help: what the attack voids is
   `BEGIN IMMEDIATE` itself, the primitive under *every* UmbraDB write. So the response is to
   eliminate the act, not the mechanism — **a build-failing source guard banning in-process
   descriptor operations on `-wal`/`-shm`** (design §2.6), the same instrument change 2 uses to ban
   `INSERT OR REPLACE`; the guarantee restated as **conditional**, with the condition in the
   requirement text rather than a footnote; and the residue stated as the honest limit it is — the
   guard binds UmbraDB's own code and can only be *documented* as a precondition on the embedding
   application.

3. **`docs/CONTRACT.md` §5 is strengthened to exactly what that mechanism delivers, and no
   further (design §3).** From "**Do not run two writer processes** … unsupported" to: a second
   writer process is **detected, and the displaced process is fail-stopped before its next commit,
   with a non-retryable typed error**. The stronger sentence the enhancement mandate offers —
   "a second writer process is *refused*" at open — is **NOT claimed**, because no dependency-free
   in-process mechanism delivers it (design §3.2 rules on this with reasons, prices the two
   mechanisms that would, and names the experiment that would earn it).

4. **`withTransaction` opens `BEGIN IMMEDIATE`, and the whole-database lock it takes is bounded
   (design §4).** `TransactionOptions.timeoutMs` and `UmbraDBConnectionOptions.idleInTxTimeoutMs`
   — which the lane report writes off as "validated-then-ignored" and "no analogue" — are
   **re-implemented** as a transaction *hold* bound enforced by the layer, keeping
   `faultKind:"timeout"` reachable and restoring the semantic
   `idle_in_transaction_session_timeout` provided.

5. **All lock waiting moves into JS; `busy_timeout` is 0 on every handle (design §5)** — with the
   requirement written against the *real* reason (the queue that must deliver the release has to
   stay drainable, which under the worker topology is the worker's message queue, not the event
   loop), plus a bounded, jittered retry classifier inside the adapter.

6. **Sticky-poison emulation, scoped precisely (design §6).** The flag is set by the **adapter
   wrapper on any transaction-scoped error**, including one thrown before any statement reaches
   SQLite. The spec records what it does and does **not** protect: it protects **caller atomicity**;
   **T5's soundness does not depend on it**, because `RAISE(ABORT)` reverses the entire statement
   including the trigger's own history INSERT.

7. **Contention error mapping with zero surface change (design §7).** `SQLITE_BUSY` and
   `SQLITE_BUSY_SNAPSHOT` map onto codes and union members that are **already frozen**
   (`src/interfaces/transaction-lease.ts:76`), keyed on the ruled binding's string discriminator
   rather than the corpus's numeric one. Adding a `BUSY`/`WRITE_CONTENDED` code is
   **forbidden**, with the reason recorded: it is the one action that reproduces LND #7869's
   fund-loss shape. `CONNECTION_ERROR` becomes **unreachable, never repurposed**.

8. **Isolation is re-derived from WAL, not carried over (design §8).** `repeatable read` at
   `src/postgres/checkpoint-store.ts:392` and `:458` becomes a no-op; read paths stop taking the
   write lock; and `prune`'s stated READ-COMMITTED justification at `checkpoint-store.ts:485-487`
   is **wrong as written under WAL** and is re-derived from `BEGIN IMMEDIATE`, with the wrong
   derivation preserved as a negative control that reclaims a live chunk.

9. **`SAVEPOINT`-based reentrancy (design §10)**, because the documented footgun at
   `src/interfaces/transaction-lease.ts:207-214` ("under a small connection pool this **can**
   deadlock") becomes a *guaranteed* self-deadlock under a single-threaded engine.

10. **P10 is re-executed with negative controls, never amended (design §11)** — the red team's
    finding that a green P10 certifies nothing about a new mechanism unless the harness is shown to
    detect the failure it is looking for.

**Every break this change makes is cheap if and only if it lands pre-tag.** `docs/STABILITY.md:46`
states verbatim: *"**Current version: `0.9.5` — the commitments above are NOT yet in force.**"* The
breaks are: `UmbraDBConnectionOptions.statementTimeoutMs`/`lockTimeoutMs`/`idleInTxTimeoutMs`
changing meaning; `LeaseFaultError("reserve-failed")` and `faultKind:"deadlock"` becoming
unreachable; the mechanism-reference clause in `LeaseTimeoutError`'s frozen TSDoc
(`src/interfaces/transaction-lease.ts:83`, "matching `pg_advisory_lock`'s real blocking semantics")
which ships in `dist/index.d.ts`; and the inverted transaction-poisoning consequence at
`:216-226`. **Post-tag each of those is a documented-behaviour change on a frozen surface** — the
commitments seat rules that the catalog freezes `{code → meaning → retryable}` but never
`{situation → code}`, so several of these would pass every gate and still break a consumer at
runtime (`council/commitments.md` R3(a)). Landing pre-tag costs a CHANGELOG entry; landing post-tag
costs a major, or a silent runtime break the drift test cannot see.

## Non-goals (explicitly out of scope for this change)

- **The chain archive is owned by `v1.0.0-sqlite-chain-archive`, not by this change.** It is a
  live, ported track with its own database file, not an unwired one: `chain-archive-sync/` is a
  typechecked ops entry point exposed as the `archive:sync` npm script. An earlier revision of this
  non-goal justified the exclusion by quoting a source comment saying the archive was "not wired
  into any runner path" and asserting it had no data, no consumer and no runner. **That premise is
  retracted and false**; the exclusion is a division of ownership, not an absence of a consumer.
  **Handover record (gate G-8):** the writer-generation guard specified here covers the wallet
  database file. The archive database file needs its own registration, and it is
  `v1.0.0-sqlite-chain-archive`'s to build — mirroring this change's mechanism, **including the I-4
  assertions from day one** so the archive does not re-import the bootstrap defect this change had
  to repair. The source guard's descriptor ban likewise extends to the archive database file and
  its `-wal`/`-shm` sidecars, including indirect path construction. That is a named obligation on a
  named change, not a deferral to an unspecified future.
- **Driver selection, the tagged-template shim, connection/handle lifecycle, pragma bootstrap
  order, the worker topology and the ext4 measurement gate** belong to
  `v1.0.0-sqlite-engine-core`. This change *consumes* them and states its dependencies in
  `design.md` §0; it does not specify them. That change has now **ruled**: a version-pinned
  `better-sqlite3`, handle confined to a worker thread. This change consumes the ruling — most
  visibly in the contention discriminator, which is a string on `err.code` rather than the numeric
  extended result code the research corpus keys on (`design.md` §7.1, verified §12(f)) — and does
  not re-argue it.
- **The error catalog itself** (`docs/ERROR-CATALOG.md`), the new non-retryable file-fault codes,
  and the `UNRECOGNIZED_POSTGRES_ERROR` rename belong to `v1.0.0-sqlite-durability-contract`. This
  change states the *behavioural* requirements its faults must satisfy (non-retryable, distinct
  from every contention code, never routed to a retryable code) and names the dependency.
- **`docs/CONTRACT.md` §3 (cancellation) and §6 (backup/restore) rewrites** belong to
  `v1.0.0-sqlite-durability-contract`. This change owns **§5 only**, and states the half of §3 it
  constrains: lease waits remain cancellable at poll granularity.
- **Schema, DDL, `STRICT` tables, table/index/trigger name prefixing and the migration
  framework** belong to `v1.0.0-sqlite-schema-parity`. The writer-registration table's *name and
  prefixing* are that change's; its *columns and protocol* are here. The migration **lock** is
  here; the migration **runner** is there.
- **TemporalKV's event-log schema, its `BEFORE INSERT` trigger, the clock policy and the
  transaction-identity guard** belong to `v1.0.0-sqlite-temporal-event-log`. This change specifies
  only the poison-scope interaction with an adapter-thrown guard, without specifying the guard.
- **No performance number is fixed here.** Six of seven research lanes benchmarked against `/tmp`,
  a 32 GB tmpfs RAM disk; re-measured on ext4, WAL `synchronous=FULL` went from a published 88,485
  commits/s to **379** — a 233× error (`council/redteam.md` §2 #4). Every quantity this change
  needs — the poll schedule, the retry bound and jitter, the default transaction-hold bound — is
  specified as a **requirement to establish a number under stated conditions**, gated on
  `v1.0.0-sqlite-engine-core`'s measurement gate, not as an assertion of one.
- **Windows behaviour is not established and is not claimed.** Every lease measurement in the
  corpus ran on WSL2 Linux `fcntl`; L2 labels its Windows reasoning "an **inference**, not a
  measurement" (`reports/l2-concurrency.md` §5 item 6). This change specifies the experiment that
  closes it and forbids shipping the §5 strengthening until it runs.
- **No mid-statement cancellation is invented here.** `TransactionOptions.signal` stays
  pre-check-only, exactly as the frozen TSDoc already says
  (`src/interfaces/transaction-lease.ts:169-175`). Whatever per-statement deadline and per-row
  guard `v1.0.0-sqlite-engine-core` enforces inside the worker is that change's; this change bounds
  the *transaction's* hold of the write lock, which is a different object and is bounded by nothing
  there (`design.md` §4.5).
- **No fencing token is exposed to callers.** The writer-generation guard is a process-level
  fail-stop enforced inside UmbraDB's own write transactions. It does **not** reintroduce the
  TTL/lease-stealing design that `Formal/STORAGE_ALGEBRA.md:303-317` and
  `src/interfaces/transaction-lease.ts:9-15` deliberately removed, and `design.md` §2.4 states why
  the removal's stated reason does not bite here.
- **The Lean cut-line is untouched, and that is not evidence of anything.** `{T3,T5,W1,C1}` models
  an abstract store; the abstract→concrete refinement was always a trusted, unmechanized bridge.
  Its survival is evidence of the disconnection, not of safety, and this change does not cite it as
  a risk argument (`council/redteam.md` §4.8; trap 9).

## Impact

- **New files:** `src/sqlite/transaction-lease.ts` (poll-loop lease over a process-local per-key
  mutex, write queue, `SAVEPOINT` reentrancy, poison emulation, transaction-hold watchdog);
  `src/sqlite/writer-generation.ts` (registration + per-transaction guard);
  `src/sqlite/contention.ts` (bounded jittered retry classifier + result-code mapping for the
  contention subset).
- **Deleted:** `raceAgainstAbort` (`src/postgres/transaction-lease.ts:91-117`), `reserveBounded`
  + `RESERVE_TIMED_OUT` (`:130-170`), `resetStatementTimeout` (`:181-184`), the
  `LEASE_ADVISORY_LOCK_CLASS` machinery (`:195,287,301,340,353,364,389`), and the whole
  connection-pool test family. `withLease`'s release-fault apparatus (`:403-472`) and
  `LeaseFaultError("connection-lost")` survive as **API** (G1 freezes them) and become near-dead
  code — a `ROLLBACK` on a local handle does not fail from connection death.
- **Survives unchanged in rationale:** the module-level transaction-handle registry
  (`src/postgres/transaction-lease.ts:35-61`) — two independently constructed adapters must agree
  on a live handle with no DI container, which is as true of a `DatabaseSync` connection as of a
  `postgres.js` callback.
- **Modified docs:** `docs/CONTRACT.md` §5 (this change); `docs/durability-contract.md`'s timeout
  table at `:100-104` (`lock_timeout` 30 000 ms becomes the lease/migration acquisition bound;
  `idle_in_transaction_session_timeout` 120 000 ms becomes the transaction-hold bound;
  `statement_timeout` has no analogue and its row is struck); `Formal/STORAGE_ALGEBRA.md` §2's C2a
  justification and §4's L1 mechanism line.
- **Risk, named.** The dominant risk is that the writer-generation guard is *believed* to refuse a
  second writer at open when it does not — the same over-claim that broke L2's sidecar. The
  mitigations are structural: the spec forbids the stronger sentence in §5; requirement
  "the strengthening claimed in writing is exactly what the mechanism delivers" is a
  doc-vs-mechanism assertion with its own acceptance criterion; and the honest limits (the guard is
  transaction-granular, not lease-granular; it does not survive deletion of the database file
  itself) are written as scenarios, not as footnotes.
- **Delivery cadence:** matches the sprint — proposal/design/tasks/spec drafted and reviewed first,
  then a builder implements against it. Nothing in `src/`, `test/` or any product file is modified
  by this change; it authors specification only.
