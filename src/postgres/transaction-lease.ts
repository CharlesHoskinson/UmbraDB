import { randomUUID } from "node:crypto";
import type { ISql, ReservedSql } from "postgres";
import { ValidationError } from "../interfaces/storage-errors.js";
import {
  LeaseAcquireOptionsSchema,
  LeaseFaultError,
  LeaseNotHeldError,
  LeaseTimeoutError,
  Rollback,
  TransactionFaultError,
  TransactionHandleInvalidError,
  TransactionOptionsSchema,
  TransactionRolledBackError,
  type Lease,
  type LeaseAcquireOptions,
  type TransactionHandle,
  type TransactionLeaseLayer,
  type TransactionOptions,
} from "../interfaces/transaction-lease.js";
import { abortError, withAbort } from "./abort.js";
import type { UmbraDBSql } from "./client.js";
import { isConnectionFailure, isStatementTimeout, translatePostgresError } from "./errors.js";

/**
 * The transaction-handle registry (openspec/changes/sprint-2-transaction-lease/design.md §2) —
 * the one genuinely new design decision this sprint makes. `TransactionHandle` is an opaque
 * `{__brand, id}` by design (the interface layer has zero `postgres.js` knowledge), but when a
 * caller passes that same handle to a DIFFERENT module's adapter (e.g. `PgTemporalKV.put(...,
 * {tx})`), that adapter needs the ACTUAL `postgres.js` transaction-scoped `sql` callback --
 * the same one `sql.begin()` gave `PgTransactionLeaseLayer`. Module-level, not a field on a
 * `PgTransactionLeaseLayer` instance: two separately-constructed adapter instances (this one,
 * `PgTemporalKV`) must agree on this without either importing the other's internals, and there
 * is no dependency-injection container in this project to wire them together otherwise.
 */
const activeTransactions = new Map<string, ISql<{ bigint: bigint }>>();

/** Called only by `PgTransactionLeaseLayer.withTransaction` — not exported as public API. */
function registerTransaction(tx: ISql<{ bigint: bigint }>): TransactionHandle {
  const handle: TransactionHandle = { __brand: "TransactionHandle", id: randomUUID() };
  activeTransactions.set(handle.id, tx);
  return handle;
}

function unregisterTransaction(handle: TransactionHandle): void {
  activeTransactions.delete(handle.id);
}

/**
 * The only function other modules' adapters call. `registerTransaction`/`unregisterTransaction`
 * bracket `fn`'s execution inside `sql.begin()`'s own callback (below) in a `try`/`finally`, so
 * the registry entry disappears whether `fn` resolves, throws, or the transaction itself fails —
 * and disappears BEFORE `sql.begin()` returns control to `withTransaction`'s own caller. A handle
 * resolved successfully is therefore *always* still inside its live transaction; a handle used
 * after its transaction ended always misses the registry and throws
 * `TransactionHandleInvalidError` here — never silently resolves to a stale or wrong connection.
 */
export function resolveTransaction(handle: TransactionHandle): ISql<{ bigint: bigint }> {
  const tx = activeTransactions.get(handle.id);
  if (!tx) throw new TransactionHandleInvalidError(handle.id);
  return tx;
}

function validateTransactionOptions(opts: TransactionOptions | undefined): TransactionOptions | undefined {
  if (opts === undefined) return undefined;
  const { signal, ...rest } = opts;
  const parsed = TransactionOptionsSchema.safeParse(rest);
  if (!parsed.success) throw ValidationError.fromZod("PgTransactionLeaseLayer withTransaction opts", parsed.error);
  return { ...parsed.data, signal };
}

function validateLeaseAcquireOptions(opts: LeaseAcquireOptions | undefined): LeaseAcquireOptions | undefined {
  if (opts === undefined) return undefined;
  const { signal, ...rest } = opts;
  const parsed = LeaseAcquireOptionsSchema.safeParse(rest);
  if (!parsed.success) throw ValidationError.fromZod("PgTransactionLeaseLayer lease-acquire opts", parsed.error);
  return { ...parsed.data, signal };
}

/**
 * Real mid-wait cancellation for a single query — structurally identical to `listKeys`'s own
 * abort-while-blocked handling (`temporal-kv.ts`), adapted from a cursor iterator to a single
 * query. Plain `withAbort` (pre-check only) cannot deliver this: `pg_advisory_lock` can block
 * indefinitely, unlike a quick key-value read/write, and `src/interfaces/transaction-lease.ts`'s
 * own `LeaseAcquireOptions.signal` doc already promises genuine mid-wait cancellation. Captures
 * the `Query` object BEFORE awaiting it so `.cancel()` stays reachable regardless of whether the
 * abort fires before or after the query settles, races it against a promise that resolves only
 * on abort, and calls `query.cancel()` from the abort listener — the same real Postgres-protocol
 * cancellation `listKeys` uses (`Query.prototype.cancel()`'s actual runtime behavior, not its
 * `.d.ts`, already verified against the installed source during Sprint 1).
 */
function raceAgainstAbort<T>(query: Promise<T> & { cancel(): unknown }, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return query;
  // Found by two independent Sprint 2 reviews (Opus and Codex, same bug): this had no entry
  // check for an ALREADY-aborted signal -- addEventListener("abort", ...) never fires for an
  // abort that already happened, since the DOM/Node AbortSignal spec does not replay past
  // events to new listeners. Every caller of this function already pre-checks `signal.aborted`
  // at its OWN entry, but there are real `await` gaps between that pre-check and this call
  // (`this.sql.reserve()`, the `SET statement_timeout` statement) during which the signal can
  // abort -- and without this check, that abort is then silently lost: the only remaining
  // promise in the race is the query itself, so a contended, no-timeout `acquireLease` would
  // block forever (a permanent hang, plus the connection stays pinned/leaked).
  if (signal.aborted) {
    query.cancel();
    return Promise.reject(abortError(signal));
  }
  let onAbort: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      query.cancel();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([query, aborted]).finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
}

/**
 * Bounds `sql.reserve()` itself against `opts.timeoutMs`/`opts.signal` — found missing by a
 * cross-vendor Sprint 2 audit: neither bounded the reservation wait, only the advisory-lock wait
 * that begins AFTER a connection is already in hand, so a caller against an exhausted connection
 * pool could block past their configured `timeoutMs`, or have an abort silently ignored, before
 * ever reaching the lock-acquisition logic that DOES respect them. If this gives up (timeout or
 * abort wins the race) before the underlying `reserve()` call itself settles, and that call
 * later resolves anyway, the now-orphaned connection is released immediately rather than leaked
 * — `gaveUp` is set ONLY inside the timeout/abort branches below, specifically so the normal
 * "reserve() genuinely won the race" path is never mistaken for an abandoned one.
 */
const RESERVE_TIMED_OUT = Symbol("reserve-timed-out");

function reserveBounded(
  sql: UmbraDBSql, timeoutMs: number | undefined, signal: AbortSignal | undefined,
): Promise<ReservedSql> {
  if (timeoutMs === undefined && !signal) return sql.reserve();

  let gaveUp = false;
  const reservePromise = sql.reserve();
  reservePromise.then((reserved) => {
    if (gaveUp) reserved.release();
  }).catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const bail = new Promise<never>((_resolve, reject) => {
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        gaveUp = true;
        reject(RESERVE_TIMED_OUT);
      }, timeoutMs);
    }
    if (signal) {
      if (signal.aborted) {
        gaveUp = true;
        reject(abortError(signal));
        return;
      }
      onAbort = () => {
        gaveUp = true;
        reject(abortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });

  return Promise.race([reservePromise, bail]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  });
}

/**
 * Best-effort: resets a session-level `statement_timeout` before a reserved connection returns
 * to the pool. A `SET` (unlike `SET LOCAL` inside a transaction) persists on the physical
 * connection indefinitely — without this, ANY lease acquired with `timeoutMs` would poison that
 * pooled connection's `statement_timeout` for whatever unrelated query lands on it next, forever
 * (design.md §3). If resetting itself fails (connection already dead), the connection is about
 * to be released/discarded anyway — swallow, don't mask the real error the caller is already
 * handling.
 */
async function resetStatementTimeout(reserved: ISql, hadTimeout: boolean): Promise<void> {
  if (!hadTimeout) return;
  await reserved`reset statement_timeout`.catch(() => {});
}

interface HeldLease {
  reserved: ReservedSql;
  key: string;
  hadTimeout: boolean;
}

/** Advisory-lock class `2` ("writer lease"), distinct from the migration runner's class `1`
 *  (`src/postgres/migrate.ts`'s own comment already reserves `2` for this module) and the Sprint
 *  1 `CREATE EXTENSION` serialization's class `3` (`src/postgres/migrations/001_temporal_kv.ts`). */
const LEASE_ADVISORY_LOCK_CLASS = 2;

/**
 * Postgres implementation of `TransactionLeaseLayer` (`src/interfaces/transaction-lease.ts`),
 * against `sql.begin()` (transactions) and `sql.reserve()`-pinned advisory locks (leases)
 * (`openspec/changes/sprint-2-transaction-lease/design.md`).
 */
export class PgTransactionLeaseLayer implements TransactionLeaseLayer {
  private readonly heldLeases = new Map<string, HeldLease>();

  constructor(private readonly sql: UmbraDBSql) {}

  async withTransaction<T>(
    fn: (tx: TransactionHandle) => Promise<T>,
    opts?: TransactionOptions,
  ): Promise<T> {
    const validated = validateTransactionOptions(opts);
    const txCallback = async (tx: ISql<{ bigint: bigint }>): Promise<T> => {
      if (validated?.timeoutMs !== undefined) {
        // Validated by TransactionOptionsSchema (z.number().int().positive()) above, so direct
        // interpolation into a raw statement is injection-safe -- it cannot contain anything but
        // digits. postgres.js's normal tagged-template parameter binding does NOT work here:
        // Postgres's SET/SET LOCAL grammar only accepts a literal constant or identifier, never a
        // bind parameter (confirmed against the installed postgres.js source: begin()'s own
        // isolation-level handling avoids parameter binding for this exact reason, building its
        // statement by string concatenation instead).
        await tx.unsafe(`set local statement_timeout = ${validated.timeoutMs}`);
      }
      const handle = registerTransaction(tx);
      try {
        return await fn(handle);
      } finally {
        unregisterTransaction(handle);
      }
    };
    try {
      return await withAbort(
        // opts.isolation maps to postgres.js's two-argument begin(options, cb) overload --
        // verified against the installed source (node_modules/postgres/src/index.js's
        // begin(options, fn)): it builds the statement as literally 'begin ' + options (after
        // stripping anything outside [a-zA-Z ]). Found by the sprint's whole-sprint review
        // (a genuine bug, caught by actually RUNNING a test that exercises opts.isolation for
        // the first time -- no earlier test had): Postgres's real BEGIN grammar requires the
        // full clause `ISOLATION LEVEL <mode>` (e.g. `BEGIN ISOLATION LEVEL REPEATABLE READ`) --
        // `BEGIN REPEATABLE READ` alone is a syntax error (confirmed: "syntax error at or near
        // 'repeatable'"). The earlier draft passed TransactionOptionsSchema's bare enum value
        // straight through, missing the required "isolation level" prefix entirely.
        // postgres.js's begin<T>() return type is Promise<UnwrapPromiseArray<T>> -- a
        // conditional type TypeScript cannot statically reduce back to a generic T, even though
        // txCallback always resolves a plain (never array) value, so unwrapping is a no-op at
        // runtime. Cast, not a real type hole: T here is exactly what txCallback resolves to.
        () => (validated?.isolation !== undefined
          ? this.sql.begin(`isolation level ${validated.isolation}`, txCallback)
          : this.sql.begin(txCallback)) as Promise<T>,
        validated?.signal,
      );
    } catch (err) {
      if (err instanceof Rollback) throw new TransactionRolledBackError(err.rollbackCause);
      if (isStatementTimeout(err) && validated?.timeoutMs !== undefined) {
        throw new TransactionFaultError(
          `transaction exceeded its ${validated.timeoutMs}ms timeout`, "timeout", err,
        );
      }
      // Found by a cross-vendor Sprint 2 audit: this interface's own JSDoc documents
      // "@throws TransactionFaultError on connection loss..." but this catch previously fell
      // straight through to the shared translatePostgresError, which maps a connection-failure
      // code to the UNRELATED shared ConnectionError class instead -- a caller following the
      // documented contract and catching TransactionFaultError specifically would miss it.
      if (isConnectionFailure(err)) {
        throw new TransactionFaultError("connection lost during transaction", "connection-lost", err);
      }
      throw translatePostgresError(err); // maps serialization failures (40001), deadlocks (40P01)
    }
  }

  async acquireLease(key: string, opts?: LeaseAcquireOptions): Promise<Lease> {
    const validated = validateLeaseAcquireOptions(opts);
    const signal = validated?.signal;
    if (signal?.aborted) throw abortError(signal);
    const hadTimeout = validated?.timeoutMs !== undefined;
    let reserved: ReservedSql;
    try {
      reserved = await reserveBounded(this.sql, validated?.timeoutMs, signal);
    } catch (err) {
      if (err === RESERVE_TIMED_OUT) throw new LeaseTimeoutError(key, validated!.timeoutMs!);
      if (err instanceof Error && err.name === "AbortError") throw err;
      throw new LeaseFaultError("failed to reserve a connection", "reserve-failed", err);
    }
    try {
      if (hadTimeout) {
        await reserved.unsafe(`set statement_timeout = ${validated!.timeoutMs}`);
      }
      const query = reserved`select pg_advisory_lock(${LEASE_ADVISORY_LOCK_CLASS}, hashtext(${key}))`;
      await raceAgainstAbort(query, signal);
      // Found by a cross-vendor Sprint 2 audit: without this re-check, a query-win/abort race
      // (the lock query settles at essentially the same instant the signal aborts) could take
      // the success path below despite the caller having aborted, since Promise.race only
      // reports whichever settled first -- it does not also notice a SIMULTANEOUS abort. Throw
      // into the same catch block below so the lock this session just acquired is still
      // released, not leaked.
      if (signal?.aborted) throw abortError(signal);
    } catch (err) {
      // Defensive, unconditional, harmless if this session never actually held it (Postgres's
      // pg_advisory_unlock returns false, not an error, in that case) -- closes the race where
      // query.cancel() and pg_advisory_lock's own grant land at essentially the same instant,
      // which would otherwise leak a held lock into the pool forever (design.md §3).
      await reserved`select pg_advisory_unlock(${LEASE_ADVISORY_LOCK_CLASS}, hashtext(${key}))`.catch(() => {});
      await resetStatementTimeout(reserved, hadTimeout);
      reserved.release();
      if (err instanceof Error && err.name === "AbortError") throw err;
      if (hadTimeout && isStatementTimeout(err)) {
        throw new LeaseTimeoutError(key, validated!.timeoutMs!);
      }
      throw new LeaseFaultError("failed to acquire lease", "connection-lost", err);
    }
    const token = randomUUID();
    this.heldLeases.set(token, { reserved, key, hadTimeout });
    return { __brand: "Lease", key, token, acquiredAt: new Date() };
  }

  async tryAcquireLease(key: string, opts?: LeaseAcquireOptions): Promise<Lease | null> {
    const validated = validateLeaseAcquireOptions(opts);
    const signal = validated?.signal;
    if (signal?.aborted) throw abortError(signal);
    const hadTimeout = validated?.timeoutMs !== undefined;
    let reserved: ReservedSql;
    try {
      // NOTE (disclosed, not fixed): with no timeoutMs, this still bounds the reservation wait
      // against an abort (closing that gap), but NOT against the connection pool itself being
      // exhausted -- if the pool has zero free connections, this genuinely waits for one before
      // even reaching pg_try_advisory_lock's real non-blocking check. "Non-blocking" here refers
      // specifically to the ADVISORY LOCK, matching this interface's own documented scope; the
      // connection pool is a shared, generally-available resource this project's single-writer
      // deployment model does not expect callers to probe for exhaustion.
      reserved = await reserveBounded(this.sql, validated?.timeoutMs, signal);
    } catch (err) {
      if (err === RESERVE_TIMED_OUT) return null; // matches the lock-phase timeout fork below
      if (err instanceof Error && err.name === "AbortError") throw err;
      throw new LeaseFaultError("failed to reserve a connection", "reserve-failed", err);
    }
    try {
      if (!hadTimeout) {
        // pg_try_advisory_lock is native non-blocking -- returns immediately, nothing to time
        // out and nothing to race against an abort (there is no wait to interrupt).
        const rows = await reserved<{ locked: boolean }[]>`
          select pg_try_advisory_lock(${LEASE_ADVISORY_LOCK_CLASS}, hashtext(${key})) as locked
        `;
        if (!rows[0]!.locked) {
          reserved.release();
          return null;
        }
      } else {
        await reserved.unsafe(`set statement_timeout = ${validated!.timeoutMs}`);
        const query = reserved`select pg_advisory_lock(${LEASE_ADVISORY_LOCK_CLASS}, hashtext(${key}))`;
        try {
          await raceAgainstAbort(query, signal);
        } catch (err) {
          if (isStatementTimeout(err)) {
            await reserved`select pg_advisory_unlock(${LEASE_ADVISORY_LOCK_CLASS}, hashtext(${key}))`.catch(() => {});
            await resetStatementTimeout(reserved, hadTimeout);
            reserved.release();
            return null; // the one behavioral fork vs. acquireLease: timeout resolves null here
          }
          throw err;
        }
      }
      // Same query-win/abort-race re-check as acquireLease -- see that method's own comment.
      if (signal?.aborted) throw abortError(signal);
    } catch (err) {
      await reserved`select pg_advisory_unlock(${LEASE_ADVISORY_LOCK_CLASS}, hashtext(${key}))`.catch(() => {});
      await resetStatementTimeout(reserved, hadTimeout);
      reserved.release();
      if (err instanceof Error && err.name === "AbortError") throw err;
      throw new LeaseFaultError("failed to acquire lease", "connection-lost", err);
    }
    const token = randomUUID();
    this.heldLeases.set(token, { reserved, key, hadTimeout });
    return { __brand: "Lease", key, token, acquiredAt: new Date() };
  }

  async releaseLease(lease: Lease): Promise<void> {
    const held = this.heldLeases.get(lease.token);
    if (!held) throw new LeaseNotHeldError(lease.key);
    this.heldLeases.delete(lease.token);
    // Found by a single-pass whole-sprint review: unconditionally swallowing the unlock query's
    // own failure (as an earlier version of this method did) silently satisfied "a dead
    // connection can't hold a session-level lock anyway, so there's nothing to unlock" -- true,
    // but it directly contradicted specs/transaction-lease/spec.md's own Requirement that a dead
    // held connection surfaces as LeaseFaultError("connection-lost") on release, not a silent
    // success. Capture the unlock failure and still throw it, AFTER cleanup runs regardless (the
    // map entry must stay removed and the connection must still be reset/released either way --
    // this is a reporting fix, not a resource-cleanup change).
    let unlockError: unknown;
    try {
      await held.reserved`select pg_advisory_unlock(${LEASE_ADVISORY_LOCK_CLASS}, hashtext(${held.key}))`;
    } catch (err) {
      unlockError = err;
    }
    try {
      await resetStatementTimeout(held.reserved, held.hadTimeout);
    } finally {
      held.reserved.release();
    }
    if (unlockError !== undefined) {
      throw new LeaseFaultError("failed to release lease: connection lost", "connection-lost", unlockError);
    }
  }

  async withLease<T>(
    key: string,
    fn: (lease: Lease) => Promise<T>,
    opts?: LeaseAcquireOptions,
  ): Promise<T> {
    const lease = await this.acquireLease(key, opts);
    // Run fn to completion, capturing its outcome, BEFORE releasing — so a release fault can be
    // surfaced without masking fn's own error (design.md §4.3).
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await fn(lease) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    let releaseFault: unknown;
    try {
      await this.releaseLease(lease);
    } catch (err) {
      releaseFault = err; // LeaseFaultError("connection-lost") when the reserved connection died.
    }
    if (releaseFault !== undefined) {
      // opts.onReleaseFault is caller code; a throwing callback MUST NOT mask fn's outcome, so
      // every invocation is guarded (audit: callback-throw masking).
      const notifyReleaseFault = (): void => {
        const cb = opts?.onReleaseFault;
        if (!cb) return;
        try {
          const maybePromise = cb(releaseFault) as unknown;
          // onReleaseFault is typed () => void, but TS allows an async fn there; swallow a
          // rejected promise too so an async callback cannot escape as an unhandled rejection
          // and terminate the process (audit).
          if (maybePromise !== null && typeof (maybePromise as { then?: unknown }).then === "function") {
            void Promise.resolve(maybePromise).catch(() => {});
          }
        } catch {
          // a throwing onReleaseFault callback must not derail fn's primary outcome.
        }
      };
      if (!outcome.ok) {
        // fn's own error stays primary; the release fault is still surfaced, never dropped.
        if (opts?.onReleaseFault) {
          notifyReleaseFault();
          throw outcome.error;
        }
        // No callback: attach the fault as fn's error's cause so it is not lost. A frozen/sealed/
        // non-extensible fn error cannot take a `cause` (the assignment throws under ESM strict
        // mode) — fall through to the AggregateError so BOTH errors are surfaced and fn's error is
        // never masked (audit F1).
        if (outcome.error instanceof Error && outcome.error.cause === undefined) {
          let attached = false;
          try {
            (outcome.error as { cause?: unknown }).cause = releaseFault;
            attached = true;
          } catch {
            // non-extensible fn error — handled by the AggregateError below.
          }
          if (attached) throw outcome.error;
        }
        throw new AggregateError([outcome.error, releaseFault], "lease fn failed and lease release also failed");
      }
      // fn succeeded but release failed.
      if (opts?.onReleaseFault) {
        notifyReleaseFault();
        return outcome.value;
      }
      throw releaseFault; // default: reject with the fault — the safe direction.
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
}
