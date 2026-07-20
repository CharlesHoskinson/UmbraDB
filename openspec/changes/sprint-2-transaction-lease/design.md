# Design — Sprint 2: Transaction/Lease

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
standalone/replset detection branch entirely rather than port a no-op version of it:

```typescript
async withTransaction<T>(
  fn: (tx: TransactionHandle) => Promise<T>,
  opts?: TransactionOptions,
): Promise<T> {
  const validated = validateTransactionOptions(opts); // ValidationError before any query
  try {
    return await withAbort(
      this.sql.begin(async (tx) => {
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

`opts.isolation` maps to `sql.begin(isolationString, callback)` — `postgres.js`'s two-argument
`begin` overload (confirmed against the installed `.d.ts` in Sprint 1's task 0.1 already, and
re-confirmed here since this sprint is the first to actually call it with an isolation string).
`opts.timeoutMs` sets `statement_timeout` as the transaction's first statement
(`` await tx`set local statement_timeout = ${opts.timeoutMs}` ``) — `SET LOCAL` scopes it to the
transaction, so it never leaks onto the connection after `sql.begin()` returns it to the pool
(`sql.begin()`, unlike `sql.reserve()`, hands the connection back automatically).

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
issuing the (session-level, not transaction-scoped) `pg_advisory_lock` call:

```typescript
async acquireLease(key: string, opts?: LeaseAcquireOptions): Promise<Lease> {
  const validated = validateLeaseAcquireOptions(opts);
  const reserved = await this.sql.reserve().catch((err) => {
    throw new LeaseFaultError("failed to reserve a connection", "reserve-failed", err);
  });
  try {
    if (validated?.timeoutMs !== undefined) {
      await reserved`set statement_timeout = ${validated.timeoutMs}`;
    }
    await withAbort(
      reserved`select pg_advisory_lock(2, hashtext(${key}))`,
      validated?.signal,
    );
  } catch (err) {
    reserved.release();
    if (isStatementTimeout(err)) {
      throw new LeaseTimeoutError(key, validated!.timeoutMs!);
    }
    if (err instanceof Error && err.name === "AbortError") throw err; // abort while waiting
    throw new LeaseFaultError("failed to acquire lease", "connection-lost", err);
  }
  const token = randomUUID();
  heldLeases.set(token, { reserved, key });
  return { __brand: "Lease", key, token, acquiredAt: new Date() };
}
```

`isStatementTimeout(err)` checks SQLSTATE `57014` (`query_canceled` — the code Postgres uses for
a statement cancelled by `statement_timeout`, confirmed against Postgres's own SQLSTATE
documentation; distinct from `57P01`, admin-initiated connection termination, which is a genuine
`LeaseFaultError` case instead). **This `statement_timeout` is set on the RESERVED connection,
session-wide, not `SET LOCAL`** — unlike `withTransaction`'s transaction-scoped setting (§1),
there is no enclosing transaction here to scope it to, and the connection is either released
back to the pool immediately after (on failure, above) or held exclusively by this lease until
`releaseLease` (on success) — it is never returned to the general pool while a stale
`statement_timeout` could affect an unrelated later query.

`tryAcquireLease` mirrors this exactly, except: with no `timeoutMs`, it uses
`pg_try_advisory_lock` (native non-blocking, returns a boolean — no timeout machinery needed at
all) and resolves `null` on `false`; with `timeoutMs` given, it uses the SAME
`statement_timeout` + blocking `pg_advisory_lock` approach as `acquireLease`, but a caught
statement-timeout resolves `null` instead of throwing `LeaseTimeoutError` — this is the one
behavioral fork between the two methods, matching `src/interfaces/transaction-lease.ts`'s
existing doc for both.

`releaseLease(lease)`: look up `lease.token` in `heldLeases`; if absent, throw
`LeaseNotHeldError(lease.key)`; otherwise issue `pg_advisory_unlock(2, hashtext(key))` on the held
`reserved` connection, then `reserved.release()`, then delete the map entry — in that order, so a
failure calling `pg_advisory_unlock` itself (connection already dead) still reaches
`reserved.release()` in a `finally`, and the map entry is removed regardless of whether the
unlock call itself succeeded (a dead connection can't hold a session-level lock anyway; leaving
a stale map entry around would be the actual bug, not calling unlock on a connection that may
already be gone).

`withLease` is the acquire→run→always-release combinator already documented in the interface;
implemented directly in terms of the three methods above with a `try/finally`, release failures
caught and logged (not thrown) per the interface's own documented contract.

## 4. Wiring `PgTemporalKV`'s `opts.tx`

Every `assertNoTx(opts?.tx, methodName)` call in `src/postgres/temporal-kv.ts` (`put`/`get`/
`getAt`/`listKeys`) is replaced with:

```typescript
const sql = opts?.tx !== undefined ? resolveTransaction(opts.tx) : this.sql;
```

— using the resolved `sql` (an `ISql`) for that method's queries instead of unconditionally
`this.sql`. This is a mechanical, low-risk change PER METHOD (the query bodies themselves are
unchanged; only which connection issues them changes) — the actual complexity is entirely
absorbed by §2's registry design, which this sprint's review must verify before implementation,
not something this wiring step reopens. `TransactionParticipationNotSupportedError` is deleted
once no method throws it anymore (a real deletion, not a deprecated-but-kept type, per this
project's stated no-backwards-compatibility-shims convention).

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
| connection failure during `sql.reserve()` or while a lease connection is held | reservation failed, or the held connection died | `LeaseFaultError` (`faultKind: "reserve-failed"` or `"connection-lost"` respectively) |
| serialization failure (`40001`) or deadlock (`40P01`) inside `withTransaction` | concurrent-transaction conflict under `repeatable read`/`serializable` isolation | `TransactionFaultError` (`faultKind: "serialization-failure"` or `"deadlock"`) — added to the shared `translatePostgresError` table since `withTransaction` reuses it (§1), unlike the lease-specific `57014` case above |

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
