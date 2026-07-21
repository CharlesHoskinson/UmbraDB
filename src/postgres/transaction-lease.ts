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
import { isStatementTimeout, translatePostgresError } from "./errors.js";

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
      throw translatePostgresError(err); // maps serialization failures (40001), deadlocks (40P01)
    }
  }

  async acquireLease(key: string, opts?: LeaseAcquireOptions): Promise<Lease> {
    const validated = validateLeaseAcquireOptions(opts);
    const signal = validated?.signal;
    if (signal?.aborted) throw abortError(signal);
    const reserved = await this.sql.reserve().catch((err: unknown) => {
      throw new LeaseFaultError("failed to reserve a connection", "reserve-failed", err);
    });
    const hadTimeout = validated?.timeoutMs !== undefined;
    try {
      if (hadTimeout) {
        await reserved.unsafe(`set statement_timeout = ${validated!.timeoutMs}`);
      }
      const query = reserved`select pg_advisory_lock(${LEASE_ADVISORY_LOCK_CLASS}, hashtext(${key}))`;
      await raceAgainstAbort(query, signal);
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
    const reserved = await this.sql.reserve().catch((err: unknown) => {
      throw new LeaseFaultError("failed to reserve a connection", "reserve-failed", err);
    });
    const hadTimeout = validated?.timeoutMs !== undefined;
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
    try {
      return await fn(lease);
    } finally {
      await this.releaseLease(lease).catch(() => {
        // Swallowed, not thrown, so it never masks fn's own error -- this project has no
        // logging infrastructure to route it through instead (src/interfaces/transaction-lease.ts's
        // own doc on this combinator, corrected by review from an earlier, unimplementable
        // "logged" claim).
      });
    }
  }
}
