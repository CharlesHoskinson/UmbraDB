# Design — Sprint 2: Transaction/Lease

## Prerequisite: Sprint 1 merged and archived (RESOLVED 2026-07-21)

**Found by review**, before this section's own resolution: `openspec/` had no `openspec/specs/`
directory at all, since Sprint 1 (`sprint-1-setup-and-temporal-kv`) hadn't been archived yet —
this sprint's `specs/temporal-kv/spec.md` `## MODIFIED Requirements` block was therefore a delta
against a baseline that didn't exist. `openspec validate --strict` didn't catch this (it checks a
change's own internal structure, not cross-change baseline resolution), so passing validation was
never evidence this dependency was satisfied. **Resolved**: `sprint-1-setup-and-temporal-kv`
merged to `main` and was archived (`openspec archive sprint-1-setup-and-temporal-kv`), producing
`openspec/specs/temporal-kv/spec.md` as the real baseline — confirmed the archived requirement
header text matches this change's `## MODIFIED Requirements` header EXACTLY (`grep`-verified
directly, not assumed), and `openspec validate --strict` re-run against that real baseline still
passes. Implementation proceeded on that basis.

## 0. Package layout

```
src/
  postgres/
    transaction-lease.ts   PgTransactionLeaseLayer (this sprint) + the handle registry (§2)
    temporal-kv.ts          (existing, modified: opts.tx wiring, §4)
    errors.ts               (existing, modified: two new SQLSTATE/timeout translations, §5)
test/
  postgres/
    transaction-lease.test.ts            unit tests
    transaction-lease.property.test.ts   P10 from Formal/STORAGE_ALGEBRA.md §5
```

No new top-level directory — `transaction-lease.ts` joins `client.ts`/`errors.ts`/`migrate.ts`/
`temporal-kv.ts` in `src/postgres/`, matching Sprint 1's own "no abstraction-for-its-own-sake
nesting" rationale (`sprint-1-setup-and-temporal-kv/design.md` §1).

## 1. `withTransaction`

Directly `sql.begin()`, per `design/design.md` §5's already-made call to delete the
standalone/replset detection branch entirely rather than port a no-op version of it.

**`opts.signal` follows Sprint 1's own established, disclosed narrowing exactly — it does NOT
attempt genuine mid-execution cancellation.** `fn` is arbitrary caller code; there is no
mechanism to interrupt it partway through (the same reasoning Sprint 1's `withAbort` doc already
gives for why `put`/`get`/`getAt` only pre-check, and why a real fix there was to narrow the
contract rather than build one — see that function's own doc in `src/postgres/temporal-kv.ts`).
`withTransaction`'s `opts.signal` is therefore pre-check-only too: aborting before the call
starts rejects with `AbortError` before any transaction opens; aborting after `fn` has begun
running has no effect on that already-started transaction. `src/interfaces/transaction-lease.ts`'s
existing `TransactionOptions.signal` doc ("Cancellation: abort rolls back and rejects with
AbortError") reads as promising true mid-flight cancellation and must be corrected to state this
narrower, achievable contract as part of this sprint's edit to that file — the exact same doc
mismatch Sprint 1 found and fixed for `put`/`get`/`getAt`'s own JSDoc, not a new problem being
invented here, just the same one recurring in a file this sprint also touches.

**The original draft of the code below also had a second, more mechanical bug: it passed
`withAbort` an already-invoked promise (`this.sql.begin(async (tx) => {...})`, which calls
`.begin()` immediately as a plain expression) instead of the thunk `withAbort`'s real signature
(`withAbort<T>(fn: () => Promise<T>, signal)`) requires — the identical bug Sprint 1's own audit
found and fixed in `put`/`get`/`getAt` (dispatching the query before ever checking the signal).
This would not even type-check (a `Promise<T>` is not assignable to `() => Promise<T>`), let
alone run correctly; fixed by wrapping in a thunk, below:**

```typescript
async withTransaction<T>(
  fn: (tx: TransactionHandle) => Promise<T>,
  opts?: TransactionOptions,
): Promise<T> {
  const validated = validateTransactionOptions(opts); // ValidationError before any query
  try {
    return await withAbort(
      () => this.sql.begin(async (tx) => {
        const handle = registerTransaction(tx); // §2 — the shared registry
        try {
          return await fn(handle);
        } finally {
          unregisterTransaction(handle);
        }
      }),
      validated?.signal,
    );
  } catch (err) {
    if (err instanceof Rollback) throw new TransactionRolledBackError(err.rollbackCause);
    throw translatePostgresError(err); // maps serialization failures, deadlocks, etc.
  }
}
```

`opts.isolation` maps to `sql.begin(options, callback)` — `postgres.js`'s two-argument `begin`
overload. Verified directly against the installed source (`node_modules/postgres/src/index.js`'s
`begin(options, fn)`): it builds the statement as `'begin ' + options.replace(/[^a-z ]/ig, '')`
and runs it via `sql.unsafe(...)`, i.e. a string-concatenated, character-class-sanitized raw
statement — NOT a bound parameter. This matters for the fix below, since it's the same technique
that fix has to use.

**`options` must be the FULL clause `isolation level <mode>`, not the bare enum value — a real
bug found only by actually implementing and testing this, corrected here after this design.md's
own earlier draft was found to be incomplete.** Postgres's real `BEGIN` grammar requires the
complete `ISOLATION LEVEL <mode>` clause (e.g. `BEGIN ISOLATION LEVEL REPEATABLE READ`); `BEGIN
REPEATABLE READ` alone (the bare `TransactionOptionsSchema` enum value, which is what this
section originally said to pass directly) is a syntax error. The call must therefore be
`` this.sql.begin(`isolation level ${validated.isolation}`, txCallback) ``, not
`` this.sql.begin(validated.isolation, txCallback) ``.

**`opts.timeoutMs` — corrected by review, which found the original plan used a SQL construct
that cannot work at all.** The original draft set `statement_timeout` via
`` await tx`set local statement_timeout = ${opts.timeoutMs}` ``, i.e. `postgres.js`'s normal
tagged-template parameter binding. Postgres's `SET`/`SET LOCAL` grammar (`VariableSetStmt`) only
accepts a literal constant or identifier in that position — a bind parameter (`$1`, which is what
`${opts.timeoutMs}` becomes under the extended query protocol) is a syntax error there, full
stop; this is exactly why `begin()` itself (above) builds its isolation-level statement by string
concatenation instead of a placeholder — the same limitation, already worked around correctly
elsewhere in this very file. Fix: since `opts.timeoutMs` is already validated by
`TransactionOptionsSchema` (`z.number().int().positive()`) before this point, it is safe to
interpolate directly into a raw statement string — no injection risk, since a validated positive
integer cannot contain anything but digits:

```typescript
if (validated?.timeoutMs !== undefined) {
  await tx.unsafe(`set local statement_timeout = ${validated.timeoutMs}`);
}
```

`SET LOCAL` scopes it to the transaction, so it never leaks onto the connection after
`sql.begin()` returns it to the pool (`sql.begin()`, unlike `sql.reserve()`, hands the connection
back automatically) — that part of the original reasoning was correct; only the SQL construction
itself was broken.

**A timed-out statement inside the transaction must surface as `TransactionFaultError`
(`faultKind: "timeout"`), per `specs/transaction-lease/spec.md`'s own Requirement — a mapping
the original draft's catch block omitted entirely.** When `statement_timeout` fires, Postgres
cancels the in-flight statement with SQLSTATE `57014` (`query_canceled`) — the SAME code
`acquireLease` (§3) already treats as contextual, not a shared-table entry, because `57014` means
different things in different call sites. `withTransaction`'s catch must check for it explicitly,
before falling through to the shared `translatePostgresError` (whose table only covers `40001`/
`40P01`, added by §5 below — it has no `57014` entry, and must not gain one, since `57014` is
NOT always a transaction-timeout in every context `translatePostgresError` is used from):

```typescript
} catch (err) {
  if (err instanceof Rollback) throw new TransactionRolledBackError(err.rollbackCause);
  if (isStatementTimeout(err) && validated?.timeoutMs !== undefined) {
    throw new TransactionFaultError(
      `transaction exceeded its ${validated.timeoutMs}ms timeout`, "timeout", err,
    );
  }
  // Added by a cross-vendor Sprint 2 audit, missing from the original draft: this interface's
  // own JSDoc documents "@throws TransactionFaultError on connection loss," but without this
  // check the shared translatePostgresError below maps a connection-failure code to the
  // UNRELATED shared ConnectionError class instead, so a caller catching TransactionFaultError
  // specifically (as the interface tells them to) would miss it.
  if (isConnectionFailure(err)) {
    throw new TransactionFaultError("connection lost during transaction", "connection-lost", err);
  }
  throw translatePostgresError(err); // maps serialization failures, deadlocks, etc. (§5)
}
```

`isStatementTimeout` is the same helper §3 defines for the lease-acquisition case — moved to a
shared location (`src/postgres/errors.ts`) since both call sites now need it, rather than
duplicated. `isConnectionFailure` is a second, smaller helper in the same file, exported
specifically so this catch block (which sees arbitrary errors, not just ones from this module's
own SQL calls) can check for a genuine connection failure without routing through the full
`translatePostgresError` switch.

**A related, more fundamental bug in the shared `isPgDriverError` check `translatePostgresError`
itself relies on, found by the same audit**: this catch block sees whatever `fn` (arbitrary
caller code) throws, not just errors from this module's own SQL calls — unlike every other
existing call site of `translatePostgresError`. The pre-Sprint-2 `isPgDriverError` check (`err
instanceof Error && typeof err.code === "string"`) was written for those narrower call sites and
is too loose here: an arbitrary application error that happens to carry its own `.code` string
(a Node built-in like `ENOENT`, or a caller's own business-error convention) would be
misclassified as a driver error and, for any code not in this file's specific enumerations,
silently relabeled `UnrecognizedPostgresError` by the `default` branch — directly violating this
interface's own documented contract ("any other error thrown by `fn` propagates unchanged").
Fixed in `src/postgres/errors.ts` by requiring EITHER a `.severity` string field (which every
genuine Postgres wire-protocol error carries, confirmed against real driver error dumps
throughout this project's test output, e.g. `{severity: 'ERROR', code: 'UB001', ...}`) OR
membership in the existing, closed `CONNECTION_FAILURE_CODES` set (for Node-level connection
failures, which never reach the wire protocol and so never carry `.severity`). This benefits
every existing caller of `translatePostgresError`, not just this sprint's new one.

**Nested/recursive `withTransaction` calls are explicitly out of scope, not silently broken —
found by adversarial review, which asked what happens if `fn` itself calls `withTransaction`
again.** `withTransaction` always calls `this.sql.begin()` on the top-level pooled client, never
on a caller-supplied `tx` — so a nested call reserves an UNRELATED connection and starts a fully
independent transaction, not a real nested one (genuine nesting in `postgres.js` requires
`tx.savepoint(...)`, which this design does not use or expose). Under a small pool (e.g. `max: 1`)
this deadlocks outright, waiting forever for a connection the outer transaction is holding; under
a larger pool it silently breaks atomicity (the inner "transaction" can commit or fail
independently of the outer one, with no relationship between them at all). This sprint does not
implement save point-based real nesting — `withTransaction`'s own JSDoc (in this sprint's edit to
`src/interfaces/transaction-lease.ts`) must state plainly that calling `withTransaction` from
inside another `withTransaction` callback is unsupported and produces an unrelated, non-nested
transaction rather than throwing or nesting, so a caller can't discover this by surprise in
production. Revisit only if a real nested-transaction requirement appears — consistent with this
interface's already-stated single-process, single-writer scope (`src/interfaces/transaction-lease.ts`'s
own revision note on why TTL/fencing were removed).

**A caught `err instanceof Rollback` still lets the underlying transaction roll back correctly**:
`sql.begin()`'s own callback-throws-anything-rolls-back semantics fire before our `catch` block
ever runs (the `Rollback` instance is what actually propagated out of `fn`, through `sql.begin`'s
internal rollback handling, and back to us) — we are translating the ALREADY-rolled-back error
into the interface's typed shape, not deciding whether to roll back.

## 2. The transaction-handle registry (the one new design decision this sprint makes)

**The problem no existing document had settled:** `TransactionHandle` (`src/interfaces/transaction-lease.ts`)
is an opaque `{ __brand, id }` — by design, so the interface layer has zero `postgres.js`
knowledge. But when a caller passes that same handle to, say, `PgTemporalKV.put(..., { tx })`,
`PgTemporalKV` needs the ACTUAL `postgres.js` transaction-scoped `sql` callback (a `TransactionSql`
instance) to issue its query against — the same one `sql.begin()` gave `PgTransactionLeaseLayer`.
Two separately-constructed adapter instances (`PgTransactionLeaseLayer`, `PgTemporalKV`) must
agree on this without either one importing the other's internals.

**Design: a process-wide registry module, not a per-instance one.** `src/postgres/transaction-lease.ts`
exports two functions alongside `PgTransactionLeaseLayer`:

```typescript
const activeTransactions = new Map<string, ISql>(); // module-level, not class-level

/** Called only by PgTransactionLeaseLayer.withTransaction — not exported as public API. */
function registerTransaction(tx: ISql): TransactionHandle {
  const handle: TransactionHandle = { __brand: "TransactionHandle", id: randomUUID() };
  activeTransactions.set(handle.id, tx);
  return handle;
}

function unregisterTransaction(handle: TransactionHandle): void {
  activeTransactions.delete(handle.id);
}

/** The only function other modules' adapters call. Exported. */
export function resolveTransaction(handle: TransactionHandle): ISql {
  const tx = activeTransactions.get(handle.id);
  if (!tx) {
    throw new TransactionHandleInvalidError(handle.id);
  }
  return tx;
}
```

**Why module-level, not a field on a `PgTransactionLeaseLayer` instance:** `PgTemporalKV` and
`PgTransactionLeaseLayer` are constructed independently by the application (there is no
dependency-injection container in this project, per its stated no-framework style) — a consumer
could easily end up with a `PgTemporalKV` that has no reference to "the" `PgTransactionLeaseLayer`
instance that produced a given handle. A module-level registry keyed by an unguessable UUID
sidesteps that wiring problem entirely: ANY code holding the right `TransactionHandle` value can
resolve it, regardless of which `PgTransactionLeaseLayer` instance (there is normally exactly one
per application, but the registry doesn't assume that) created it. This does mean the registry is
a genuine module-level mutable singleton — acceptable here because `postgres.js` connections
themselves are already process-scoped resources (there's no multi-tenant isolation concern this
would violate), but called out explicitly since "module-level mutable state" is exactly the kind
of thing this project's review discipline exists to scrutinize rather than wave through.

**Lifecycle safety — the registry cannot outlive its transaction.** `registerTransaction`/
`unregisterTransaction` bracket `fn`'s execution inside `sql.begin()`'s own callback (§1) — the
entry is removed in a `finally`, so it disappears whether `fn` resolves, throws, or the
transaction itself fails, and it disappears BEFORE `sql.begin()` returns control to
`withTransaction`'s caller. Consequently: a handle resolved successfully is *always* still
inside its live transaction (the entry cannot exist after the transaction ends); a handle used
after its transaction ended (e.g. a caller that leaks the handle out of the `fn` closure and
calls `put(..., {tx: handle})` later) always misses the registry and throws
`TransactionHandleInvalidError` — never silently resolves to a stale or wrong connection. This is
the property the sprint's adversarial review (§ below) must verify hardest.

**New error type**, added to `src/interfaces/transaction-lease.ts` (a genuine interface addition,
not just an adapter-internal detail, since every module accepting `opts.tx` needs to document
this failure mode consistently):

```typescript
/** Thrown when opts.tx names a TransactionHandle that is not (or is no longer) a live
 *  transaction — e.g. reused after its transaction committed/rolled back, or fabricated. */
export class TransactionHandleInvalidError extends TransactionLeaseError {
  readonly code = "TRANSACTION_HANDLE_INVALID" as const;
  constructor(readonly handleId: string) {
    super(`transaction handle "${handleId}" does not refer to a live transaction`);
  }
}
```

(`TransactionLeaseErrorCode` gains `"TRANSACTION_HANDLE_INVALID"`.)

## 3. Lease acquisition, release, and timeout

`acquireLease`/`tryAcquireLease`/`releaseLease`/`withLease`, per `design/design.md` §5's
corrected design: a `sql.reserve()`-pinned connection, `pg_advisory_lock(2, hashtext(key))` /
`pg_try_advisory_lock(2, hashtext(key))` / `pg_advisory_unlock(2, hashtext(key))` — class `2`
("writer lease"), distinct from Sprint 1 migration runner's class `1` (`design/design.md` §5's
own collision-avoidance note; `src/postgres/migrate.ts`'s existing class-`1` comment already
reserves `2` for this module).

**Timeout mechanism — `pg_advisory_lock` has no native timeout parameter, unlike this interface's
`opts.timeoutMs`.** Fix: set a `statement_timeout` on the reserved connection immediately before
issuing the (session-level, not transaction-scoped) `pg_advisory_lock` call.

**Five bugs in the original draft of this section, all found by review and fixed below:**
(a) `` reserved`set statement_timeout = ${validated.timeoutMs}` `` used `postgres.js`'s normal
parameter binding — the same broken construct §1 identifies for `SET LOCAL`, for the identical
reason (`SET` cannot take a bind parameter; only a literal). (b) neither the failure path nor
`releaseLease` (below) ever reset `statement_timeout` before returning the connection to the
pool — a session-level `SET` (unlike `SET LOCAL` inside a transaction) persists on the physical
connection indefinitely, so ANY lease acquired with `timeoutMs` would poison that pooled
connection's `statement_timeout` for whatever unrelated query lands on it next, forever, since
nothing ever reset it back. (c) **a plain `withAbort` call cannot actually deliver what this
interface promises.** `src/interfaces/transaction-lease.ts`'s own existing doc on
`LeaseAcquireOptions.signal` reads: *"abort while waiting rejects with `AbortError`; if the lock
was already acquired when the abort lands, the lease is released before rejecting"* — a
STRONGER, genuine mid-wait-cancellation contract than `put`/`get`/`getAt`/`withTransaction`'s
pre-check-only one, because `pg_advisory_lock` (unlike those) can block indefinitely. Plain
`withAbort` only pre-checks before dispatch and has no effect on an abort firing later — an
earlier draft of this section called it here anyway, which would silently fail to honor an
already-shipped, already-documented part of the interface. This needs the SAME custom
Promise-race-plus-`query.cancel()` mechanism `listKeys` already built for exactly this reason
(`src/postgres/temporal-kv.ts`), not `withAbort`. (d) even with real cancellation, `pg_advisory_lock`
granting the lock and the cancel request arriving can race at the server — the lock can end up
actually held even though the client observes `AbortError`; an unconditional, best-effort
`pg_advisory_unlock` closes this without needing to know which side of the race won (Postgres's
`pg_advisory_unlock` returns `false`, not an error, if the session doesn't hold it — always safe
to call). (e) the `isStatementTimeout(err)` check ran unconditionally, not gated on whether
`timeoutMs` was actually set (contrast §1's correctly-gated version) — so an operator-issued
`pg_cancel_backend()`, or the server's own default `statement_timeout` firing on a NO-timeout
`acquireLease` call, would be misclassified as this project's own `LeaseTimeoutError` instead of
the generic `LeaseFaultError("connection-lost")` the interface documents for that case (and would
construct `LeaseTimeoutError(key, validated!.timeoutMs!)` against a genuinely `undefined` value,
lying to that class's own typed contract):

```typescript
async acquireLease(key: string, opts?: LeaseAcquireOptions): Promise<Lease> {
  const validated = validateLeaseAcquireOptions(opts);
  const signal = validated?.signal;
  if (signal?.aborted) throw abortError(signal);
  const reserved = await this.sql.reserve().catch((err) => {
    throw new LeaseFaultError("failed to reserve a connection", "reserve-failed", err);
  });
  const hadTimeout = validated?.timeoutMs !== undefined;
  try {
    if (hadTimeout) {
      // Validated by LeaseAcquireOptionsSchema (z.number().int().positive()) before this point,
      // so direct interpolation into a raw statement is injection-safe -- it cannot contain
      // anything but digits. Bind-parameter syntax does not work here at all (see the bug this
      // replaces, above, and the identical §1 fix for SET LOCAL).
      await reserved.unsafe(`set statement_timeout = ${validated.timeoutMs}`);
    }
    const query = reserved`select pg_advisory_lock(2, hashtext(${key}))`;
    await raceAgainstAbort(query, signal); // §3a below -- NOT plain withAbort, see (c) above
  } catch (err) {
    // (d) above: defensive, unconditional, harmless if this session never actually held it.
    await reserved`select pg_advisory_unlock(2, hashtext(${key}))`.catch(() => {});
    await resetStatementTimeout(reserved, hadTimeout); // never poison the pool -- see below
    reserved.release();
    if (err instanceof Error && err.name === "AbortError") throw err;
    if (hadTimeout && isStatementTimeout(err)) { // (e) above -- gated on hadTimeout
      throw new LeaseTimeoutError(key, validated!.timeoutMs!);
    }
    throw new LeaseFaultError("failed to acquire lease", "connection-lost", err);
  }
  const token = randomUUID();
  heldLeases.set(token, { reserved, key, hadTimeout });
  return { __brand: "Lease", key, token, acquiredAt: new Date() };
}

/** Best-effort: if resetting fails (connection already dead), the connection is about to be
 *  released/discarded anyway, so there is nothing further to protect -- swallow, don't mask the
 *  real error already being handled by the caller. */
async function resetStatementTimeout(reserved: ISql, hadTimeout: boolean): Promise<void> {
  if (!hadTimeout) return;
  await reserved`reset statement_timeout`.catch(() => {});
}
```

### 3a. `raceAgainstAbort` — the real mid-wait cancellation `acquireLease`/`tryAcquireLease` need

Structurally identical to `listKeys`'s own abort-while-blocked handling (`src/postgres/temporal-kv.ts`),
adapted from a cursor iterator to a single query: capture the `Query` object BEFORE awaiting it (so
`.cancel()` remains reachable regardless of whether the abort fires before or after the query
settles), race it against a promise that resolves only on abort, and call `query.cancel()` from
the abort listener — the SAME real Postgres-protocol cancellation `listKeys` uses, for the same
reason (`Query.prototype.cancel()`'s actual runtime behavior, not its `.d.ts`, already verified
against the installed source in Sprint 1's own fix history).

```typescript
async function raceAgainstAbort<T>(query: Promise<T> & { cancel(): unknown }, signal?: AbortSignal): Promise<T> {
  if (!signal) return query;
  // Added after TWO independent Sprint 2 reviews (Opus and Codex) found the same bug: no entry
  // check for an ALREADY-aborted signal. addEventListener("abort", ...) never fires for an abort
  // that already happened -- callers of this function pre-check `signal.aborted` at their OWN
  // entry, but real `await` gaps exist between that pre-check and this call (`sql.reserve()`,
  // `SET statement_timeout`), during which the signal can abort and then be silently lost: with
  // no timeoutMs, a contended acquireLease would then block FOREVER (a permanent hang, plus a
  // leaked pinned connection).
  if (signal.aborted) {
    query.cancel();
    return Promise.reject(abortError(signal));
  }
  let onAbort: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => { query.cancel(); reject(abortError(signal)); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([query, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort!);
  }
}
```

**A second race window, found by the same reviews: even with the entry check above, `pg_advisory_lock`
granting the lock and the signal aborting can settle at essentially the same instant** — `Promise.race`
only reports whichever settles first; it does not also notice a genuinely simultaneous abort. Both
`acquireLease` and `tryAcquireLease` therefore re-check `signal?.aborted` immediately after
`raceAgainstAbort` resolves successfully (i.e. the lock was granted), and treat a true value the
same as if the query itself had thrown `AbortError` — routing into the same catch block so the
lock this session just acquired is still released via the existing defensive `pg_advisory_unlock`
(§3(d) above), not leaked.

**A third gap, found by the same reviews and NOT closed by `raceAgainstAbort` at all: `sql.reserve()`
itself has no timeout/abort/nonblocking awareness.** Both methods `await this.sql.reserve()` BEFORE
any of the abort/timeout machinery above even starts, so against an exhausted connection pool,
`acquireLease`/`tryAcquireLease` could block past their configured `timeoutMs`, ignore an abort
entirely, or (for `tryAcquireLease` with no `timeoutMs`) fail to return `null` promptly — all
while the caller reasonably believes those guarantees already apply. Fix: a `reserveBounded(sql,
timeoutMs, signal)` helper that races `sql.reserve()` itself against the same kind of
timeout/abort machinery, with one added subtlety a naive race would get wrong — if this gives up
(timeout or abort wins) before the underlying `reserve()` call actually settles, and it resolves
anyway afterward, the now-orphaned connection must be released immediately rather than leaked:

```typescript
const RESERVE_TIMED_OUT = Symbol("reserve-timed-out");

function reserveBounded(
  sql: UmbraDBSql, timeoutMs: number | undefined, signal: AbortSignal | undefined,
): Promise<ReservedSql> {
  if (timeoutMs === undefined && !signal) return sql.reserve();

  let gaveUp = false; // set ONLY inside the bail branches below -- never means "not yet settled"
  const reservePromise = sql.reserve();
  reservePromise.then((reserved) => { if (gaveUp) reserved.release(); }).catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const bail = new Promise<never>((_resolve, reject) => {
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => { gaveUp = true; reject(RESERVE_TIMED_OUT); }, timeoutMs);
    }
    if (signal) {
      if (signal.aborted) { gaveUp = true; reject(abortError(signal)); return; }
      onAbort = () => { gaveUp = true; reject(abortError(signal)); };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });

  return Promise.race([reservePromise, bail]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  });
}
```

`acquireLease`/`tryAcquireLease` call `reserveBounded(this.sql, validated?.timeoutMs, signal)`
instead of the plain `this.sql.reserve().catch(...)` shown in §3's code sample above, and catch
the `RESERVE_TIMED_OUT` sentinel the same way each method already handles a lock-phase timeout
(`LeaseTimeoutError` for `acquireLease`, `null` for `tryAcquireLease`). **One sub-case is a
disclosed limitation, not fully solved**: `tryAcquireLease` with no `timeoutMs` is now
abort-aware during the reservation wait, but if the connection pool itself has zero free
connections, this still genuinely waits for one rather than returning `null` instantly —
`pg_try_advisory_lock`'s native non-blocking behavior only ever applied to the ADVISORY LOCK,
and there is no synchronous, non-blocking way to probe an inherently-blocking connection-pool
acquisition. This project's single-writer deployment model does not expect callers to treat the
shared connection pool as a per-call contended resource the way the lease itself is.

`isStatementTimeout(err)` checks SQLSTATE `57014` (`query_canceled` — the code Postgres uses for
a statement cancelled by `statement_timeout`, confirmed against Postgres's own SQLSTATE
documentation; distinct from `57P01`, admin-initiated connection termination, which is a genuine
`LeaseFaultError` case instead). This `statement_timeout` is set on the RESERVED connection,
session-wide, not `SET LOCAL` — unlike `withTransaction`'s transaction-scoped setting (§1), there
is no enclosing transaction here to scope it to. Unlike the original draft's reasoning, the
connection genuinely CAN return to the pool still carrying the elevated value — on this failure
path (`reserved.release()` right after), and later on the success path too, once `releaseLease`
runs — so both paths must explicitly `RESET` it first; "the connection is held exclusively until
release" was true but irrelevant, since the pool reuses that same physical connection for
someone else immediately after release.

`tryAcquireLease` mirrors this exactly — including the `resetStatementTimeout` fix, the pre-check
for an already-aborted signal, the `raceAgainstAbort`/`query.cancel()` mid-wait cancellation
(§3a), and the defensive unconditional `pg_advisory_unlock` in its own catch block — except: with
no `timeoutMs`, it uses `pg_try_advisory_lock` (native non-blocking, returns a boolean — no
timeout machinery, and nothing to race against an abort either, since the call already returns
immediately) and resolves `null` on `false`; with `timeoutMs` given, it uses the SAME
`statement_timeout` + blocking `pg_advisory_lock` + `raceAgainstAbort` approach as `acquireLease`,
but a caught statement-timeout (gated on `hadTimeout`, same as `acquireLease`) resolves `null`
instead of throwing `LeaseTimeoutError` — this is the one behavioral fork between the two
methods, matching `src/interfaces/transaction-lease.ts`'s existing doc for both.

`releaseLease(lease)`: look up `lease.token` in `heldLeases`; if absent, throw
`LeaseNotHeldError(lease.key)`. Otherwise, in order: delete the map entry (unconditionally, before
attempting cleanup — a stale entry left behind would be a real bug regardless of what happens
next); attempt `pg_advisory_unlock(2, hashtext(key))` on the held `reserved` connection, capturing
(not swallowing) any failure; call `resetStatementTimeout(reserved, hadTimeout)`; call
`reserved.release()`; if the unlock attempt failed, THEN throw `LeaseFaultError` (`faultKind:
"connection-lost"`) with the captured error as `cause`.

**Corrected by the sprint's own whole-sprint review (task 3.1), which found this section's
original version unconditionally swallowed the unlock call's own failure entirely.** The original
reasoning — "a dead connection can't hold a session-level lock anyway, so a failed unlock attempt
doesn't matter" — is true as far as it goes, but `specs/transaction-lease/spec.md`'s own
Requirement explicitly demands the OPPOSITE observable behavior: a dead held connection must
surface `LeaseFaultError("connection-lost")` on release, not resolve as if nothing happened. The
map-entry removal, `resetStatementTimeout`, and `reserved.release()` steps still all run
regardless (cleanup must not depend on whether the caller ends up seeing an error) — only the
FINAL step changed: report the captured failure instead of discarding it.

`withLease` is the acquire→run→always-release combinator already documented in the interface;
implemented directly in terms of the three methods above with a `try/finally`, release failures
swallowed (not thrown) per the interface's own documented contract — **corrected by review**:
an earlier draft of this sentence said "logged," which was never actually implementable (this
project has no logging infrastructure); the doc, the interface JSDoc, the spec Requirement, and
the implementation comment were all corrected to say "swallowed" instead.

## 4. Wiring `PgTemporalKV`'s `opts.tx`

**The original draft of this section was written as if each of `put`/`get`/`getAt` were a single
method — reviewed and found to mischaracterize the ACTUAL Sprint 1 code structure it's editing.**
Reading `src/postgres/temporal-kv.ts` as it actually exists: each public method
(`put`/`get`/`getAt`) does its own validation, calls `assertNoTx(opts?.tx, methodName)`, and then
delegates to a SEPARATE private `*Impl` method (`putImpl`/`getImpl`/`getAtImpl`) via
`withAbort(() => this.xImpl(...), opts?.signal)` — and it is those private `*Impl` methods, not
the public ones, that actually reference `this.sql`. **Exact counts, recounted directly against
the current file by review (an earlier draft of this section said "one in `getImpl`, two in
`getAtImpl`," which underrepresented both):** `putImpl` has exactly ONE `this.sql` reference
(`const sql = this.sql;`, immediately aliased to a local `sql` used for the rest of its body —
the simplest of the three to convert, since only that one line changes). `getImpl` has TWO
(the tagged-template call itself, plus one `${this.sql(this.schema)}` identifier-interpolation
inside it). `getAtImpl` has SIX: each of its two query branches (`{version}` and `{at}`) uses
`this.sql` once as the tag and TWICE more as `${this.sql(this.schema)}` for the `kv_history` and
`kv_current` identifiers respectively (3 per branch × 2 branches). None of the `*Impl` methods
currently accept any parameter carrying `opts.tx` at all. A literal reading of the original
one-line snippet — inserting it in place of `assertNoTx` in the PUBLIC method — would validate
correctly and then silently keep calling `this.xImpl(...)` exactly as before, still hardcoding
`this.sql` inside, never actually routing the query through the caller's transaction. `listKeys`
is the one method NOT split this way (a single async generator, no separate impl method), so it
does not have this problem — but `put`/`get`/`getAt` all do, and any one of them missing this fix
would be a real per-method atomicity bug (a caller's transactional write silently running outside
their transaction), not a cosmetic one.

**Corrected plan, per method already split into public + `*Impl`:** thread the resolved
connection through as a new parameter to the `*Impl` method, and replace every `this.sql`
reference INSIDE that `*Impl` method's body (all of the counts above, not just one) with the
parameter. For `putImpl` specifically, this means DELETING its existing `const sql = this.sql;`
line entirely and receiving `sql` as a parameter instead — the rest of its body already only
references the local `sql`, not `this.sql` directly, so nothing else in its body changes:

```typescript
// put() — public method — unchanged except the resolveTransaction call itself:
async put<T extends JsonValue>(..., opts?: {...}): Promise<VersionedEntry<T>> {
  const sql = opts?.tx !== undefined ? resolveTransaction(opts.tx) : this.sql; // was assertNoTx
  this.validateKey(namespace, scope, key);
  // ...existing value/expectedVersion validation, unchanged...
  return withAbort(() => this.putImpl<T>(sql, namespace, scope, key, value, opts?.expectedVersion), opts?.signal);
}

// putImpl — private — gains a leading `sql: ISql` parameter; every existing `this.sql` reference
// in its body (the upsert, the CAS UPDATE, both re-read SELECTs) becomes the parameter instead:
private async putImpl<T extends JsonValue>(
  sql: ISql, ns: Namespace, scope: Scope, key: Key, value: T, expectedVersion: Version | undefined,
): Promise<VersionedEntry<T>> {
  const jsonValue = sql.json(value as JsonValue);
  // ...every subsequent `this.sql` in the existing body becomes `sql`, unchanged otherwise...
}
```

`getImpl`/`getAtImpl` take the identical treatment — a leading `sql: ISql` parameter, and every
`this.sql` reference in their existing bodies (TWO in `getImpl`, SIX in `getAtImpl` — see the
exact counts above; an earlier draft of this sentence repeated the since-corrected undercount)
becomes that parameter. `this.schema` (the schema name, used for identifier interpolation like
`${sql(this.schema)}`) is unaffected — it stays a `this.` reference in all cases, since the
resolved transaction connection still operates against the SAME schema this adapter was
constructed for; only the CONNECTION the query is issued against changes, never the schema.

For `listKeys` (not split into a separate impl method): the same `resolveTransaction`
substitution applies directly at its single `this.sql` reference — no threading needed, since
there's only the one method.

`TransactionParticipationNotSupportedError` is deleted once no method throws it anymore (a real
deletion, not a deprecated-but-kept type, per this project's stated no-backwards-compatibility-
shims convention).

**One behavioral note carried over from Sprint 1's own design.md, now resolved rather than just
flagged:** `TransactionKeyReuseError` (Sprint 1's `UB001` mechanism) can now actually fire through
the public `put()` API, not only via a direct raw-SQL trigger test — a caller who issues two
`put()` calls to the same key inside one `withTransaction` callback will hit it for real. Sprint 1's
`specs/temporal-kv/spec.md` scope note ("this sprint's `PgTemporalKV` adapter... cannot reach this
case yet") is superseded by this sprint; this sprint's own `specs/temporal-kv/spec.md` (a
`## MODIFIED Requirements`/`## ADDED Requirements` addendum to the same capability Sprint 1
specified, per openspec's convention for a later change touching an existing capability) adds the
corresponding public-API-level scenario Sprint 1 could only test at the trigger level.

## 5. Error translation additions (`src/postgres/errors.ts`)

| SQLSTATE / condition | Meaning | Translated to |
|---|---|---|
| `57014` (`query_canceled`) on a lease-acquisition connection specifically | `statement_timeout` fired while waiting for `pg_advisory_lock` | `LeaseTimeoutError` (acquireLease) or `null` (tryAcquireLease) — see §3; this SQLSTATE is contextual, not translated the same way everywhere it could appear, so this entry applies only within `acquireLease`/`tryAcquireLease`'s own catch, not the shared `translatePostgresError` table used elsewhere |
| `57014` (`query_canceled`) inside a `withTransaction` call that set `opts.timeoutMs` specifically | `statement_timeout` fired on a statement inside the transaction | `TransactionFaultError` (`faultKind: "timeout"`) — see §1; **added by review, missing from the original draft**, and — like the lease-acquisition case above — this is ALSO contextual and handled in `withTransaction`'s own catch, not the shared table, for the same reason: `57014` does not always mean "our own timeout fired" in every context (e.g. an operator-issued `pg_cancel_backend()` on an unrelated statement is the same SQLSTATE). Both contextual call sites share one `isStatementTimeout(err)` helper (moved to `src/postgres/errors.ts` so it isn't duplicated between `transaction-lease.ts`'s two use sites) |
| connection failure during `sql.reserve()` or while a lease connection is held | reservation failed, or the held connection died | `LeaseFaultError` (`faultKind: "reserve-failed"` or `"connection-lost"` respectively) |
| serialization failure (`40001`) or deadlock (`40P01`) inside `withTransaction` | concurrent-transaction conflict under `repeatable read`/`serializable` isolation | `TransactionFaultError` (`faultKind: "serialization-failure"` or `"deadlock"`) — added to the shared `translatePostgresError` table since `withTransaction` reuses it (§1), unlike the two contextual `57014` cases above |

## 6. Test infrastructure

Reuses Sprint 1's `test/postgres/setup.ts` (`registerSuiteLifecycle`) unchanged — no new
container-lifecycle machinery needed. `transaction-lease.property.test.ts` implements P10 from
`Formal/STORAGE_ALGEBRA.md` §5 (mutual exclusion under concurrent `withLease` from multiple
connections — "ideally multiple processes, not just multiple in-process callers, since the
guarantee is connection-scoped": this sprint's test uses multiple independent `createClient()`
connections within one process, which already exercises the connection-scoped guarantee; a
genuine multi-process variant is noted as a stretch goal, not a blocking requirement, since
Sprint 1's own P1 property test made the same in-process-vs-multi-process distinction and treated
it as acceptable).
