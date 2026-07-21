import { z } from "zod";
import { StorageError } from "./storage-errors.js";

/**
 * Transaction/Lease layer — implementation-agnostic contract.
 * Backed by `sql.begin()` (transactions) and `sql.reserve()` + advisory locks (leases) in the
 * Postgres adapter; this file contains no `pg`-specific types.
 *
 * REVISED after a cross-vendor audit found the original TTL/lease-stealing design made the
 * mutual-exclusion guarantee (Law L1, {@link STORAGE_ALGEBRA.md} §4) impossible for arbitrary
 * caller code: a `withLease` callback had no way to learn its lease was stolen mid-execution
 * and stop, so "at most one holder" could not actually be guaranteed. TTL/stealing/fencing are
 * REMOVED — a lease is held from acquisition until explicit release or connection death, full
 * stop. This is simpler and correct for this project's single-process, single-writer
 * deployment; revisit only if a real multi-process/crash-recovery requirement appears.
 */

// ---------------------------------------------------------------------------
// Shared opaque handles
// ---------------------------------------------------------------------------

/** Opaque handle for an in-flight transaction. Pass to any storage-layer method that accepts
 *  `opts.tx` to participate in the same transaction. This is the ONE transaction-handle type
 *  in the storage layer — TemporalKV, CheckpointStore, and Watermarks all import it rather than
 *  defining their own. */
export interface TransactionHandle {
  readonly __brand: "TransactionHandle";
  readonly id: string;
}

/** Opaque proof of a held writer lease (advisory lock pinned to a reserved connection). Held
 *  until {@link TransactionLeaseLayer.releaseLease} or the underlying connection closes — no
 *  TTL, no self-expiry, no stealing. */
export interface Lease {
  readonly __brand: "Lease";
  readonly key: string;
  /** Unique per acquisition; lets {@link TransactionLeaseLayer.releaseLease} distinguish a
   *  fresh release from a duplicate one on an already-released lease object. */
  readonly token: string;
  readonly acquiredAt: Date;
}

// ---------------------------------------------------------------------------
// Typed error hierarchy
// ---------------------------------------------------------------------------

export type TransactionLeaseErrorCode =
  | "TRANSACTION_ROLLED_BACK"
  | "TRANSACTION_FAULT"
  | "TRANSACTION_HANDLE_INVALID"
  | "LEASE_TIMEOUT"
  | "LEASE_NOT_HELD"
  | "LEASE_FAULT";

export abstract class TransactionLeaseError extends StorageError {
  abstract readonly code: TransactionLeaseErrorCode;
}

/** Thrown by {@link TransactionLeaseLayer.withTransaction} when the callback requested a
 *  rollback via {@link Rollback}. Distinct from a driver-level fault. */
export class TransactionRolledBackError extends TransactionLeaseError {
  readonly code = "TRANSACTION_ROLLED_BACK" as const;
  constructor(readonly rollbackCause: TransactionRollbackCause) {
    super(`transaction rolled back: ${rollbackCause.kind}`);
  }
}

/** Thrown when a transaction fails for infrastructure reasons — connection loss, a
 *  serialization failure under `serializable` isolation, deadlock, or a statement timeout. */
export class TransactionFaultError extends TransactionLeaseError {
  readonly code = "TRANSACTION_FAULT" as const;
  constructor(
    message: string,
    readonly faultKind: "connection-lost" | "serialization-failure" | "deadlock" | "timeout" | "unknown",
    cause?: unknown,
  ) { super(message, cause); }
}

/** Thrown by {@link TransactionLeaseLayer.acquireLease}/{@link TransactionLeaseLayer.withLease}
 *  when `opts.timeoutMs` was given and elapsed before the lock was acquired. If no
 *  `timeoutMs` is given, `acquireLease` waits indefinitely (matching `pg_advisory_lock`'s real
 *  blocking semantics) and this error cannot occur — there is no separate "held by another
 *  writer" error for the no-timeout case, because the caller is, by construction, willing to
 *  wait as long as it takes. */
export class LeaseTimeoutError extends TransactionLeaseError {
  readonly code = "LEASE_TIMEOUT" as const;
  constructor(readonly key: string, readonly waitedMs: number) {
    super(`timed out after ${waitedMs}ms waiting for lease "${key}"`);
  }
}

/** Thrown by {@link TransactionLeaseLayer.releaseLease} when the lease was already released or
 *  its connection already closed — releasing twice is routine under normal cleanup paths (e.g.
 *  a `finally` block racing an already-completed release), not a bug, but the caller is still
 *  told so via a distinct, catchable error rather than a silent no-op. With TTL/stealing
 *  removed, this is the only way a release can fail to find its lease. */
export class LeaseNotHeldError extends TransactionLeaseError {
  readonly code = "LEASE_NOT_HELD" as const;
  constructor(readonly key: string) {
    super(`lease "${key}" was not held (already released, or its connection closed)`);
  }
}

/** Thrown on connection loss / reservation failure while acquiring or releasing a lease. */
export class LeaseFaultError extends TransactionLeaseError {
  readonly code = "LEASE_FAULT" as const;
  constructor(
    message: string,
    readonly faultKind: "connection-lost" | "reserve-failed" | "unknown",
    cause?: unknown,
  ) { super(message, cause); }
}

/** Thrown when `opts.tx` names a {@link TransactionHandle} that is not (or is no longer) a live
 *  transaction — reused after its transaction committed/rolled back, or fabricated. Every
 *  storage-layer method accepting `opts.tx` (not just this layer's own methods) can throw this,
 *  since resolving the handle happens before that method's query ever runs. */
export class TransactionHandleInvalidError extends TransactionLeaseError {
  readonly code = "TRANSACTION_HANDLE_INVALID" as const;
  constructor(readonly handleId: string) {
    super(`transaction handle "${handleId}" does not refer to a live transaction`);
  }
}

/**
 * Thrown *inside* a `withTransaction` callback to request a deliberate rollback.
 * `withTransaction` catches this specifically and rejects with
 * {@link TransactionRolledBackError} — rollback is a controlled, named outcome, not an
 * escaped exception the caller must intuit from a generic `Error`.
 */
export class Rollback extends Error {
  constructor(readonly rollbackCause: TransactionRollbackCause) {
    super(`transaction rollback requested: ${rollbackCause.kind}`);
    this.name = "Rollback";
  }
}

export type TransactionRollbackCause =
  | { kind: "callback-requested"; reason?: string }
  | { kind: "constraint-violation"; code: string; detail?: string };

// ---------------------------------------------------------------------------
// Options — Zod-first (data fields in the schema; live handles intersected on)
// ---------------------------------------------------------------------------

export const TransactionOptionsSchema = z.object({
  isolation: z.enum(["read committed", "repeatable read", "serializable"]).optional(),
  /** Statement/transaction timeout; a timeout surfaces as {@link TransactionFaultError}. */
  timeoutMs: z.number().int().positive().optional(),
});
export type TransactionOptions = z.infer<typeof TransactionOptionsSchema> & {
  /** Cancellation is pre-check-only, matching every other method in this storage layer
   *  (`PgTemporalKV`'s own `withAbort`): an already-aborted `signal` rejects with `AbortError`
   *  before any transaction opens. `fn` is arbitrary caller code with no mechanism for this
   *  layer to interrupt it partway through, so an abort that fires AFTER `fn` has already begun
   *  running has NO EFFECT on that in-flight transaction — it proceeds to commit or roll back
   *  based on `fn`'s own outcome only. This is a real, disclosed narrowing, not an oversight. */
  signal?: AbortSignal;
};

export const LeaseAcquireOptionsSchema = z.object({
  /** How long to wait for the lock before giving up: {@link LeaseTimeoutError} from
   *  `acquireLease`/`withLease`, `null` from `tryAcquireLease`. Omit to wait indefinitely
   *  (`acquireLease`) or to fail fast with no wait at all (`tryAcquireLease` — see its own
   *  doc). */
  timeoutMs: z.number().int().positive().optional(),
});
export type LeaseAcquireOptions = z.infer<typeof LeaseAcquireOptionsSchema> & {
  /** Cancellation: abort while waiting rejects with `AbortError`; if the lock was already
   *  acquired when the abort lands, the lease is released before rejecting. */
  signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// The layer's public surface
// ---------------------------------------------------------------------------

export interface TransactionLeaseLayer {
  /**
   * Runs `fn` inside a database transaction and resolves with its return value on commit.
   *
   * **Not reentrant: calling `withTransaction` again from inside `fn` does not nest.** It opens
   * an unrelated, independent transaction on a different connection — under a small connection
   * pool this can deadlock (waiting for a connection the outer transaction is holding); under a
   * larger pool it silently breaks atomicity, since the "inner" transaction can commit or fail
   * with no relationship to the outer one at all. This layer does not implement save
   * point-based real nesting. Do not call `withTransaction` from within another
   * `withTransaction`'s `fn`.
   *
   * **Do not catch a query's rejection inside `fn` and continue as though the transaction were
   * still usable.** Once ANY query issued through `tx` rejects, the whole underlying Postgres
   * transaction is poisoned server-side, matching standard transaction-abort semantics — this
   * holds regardless of whether `fn`'s own code catches that specific rejection. Concretely,
   * verified against the installed `postgres.js` driver: every query dispatched through `tx`
   * has its own independent `.catch()` attached internally, so if `fn` returns normally after
   * swallowing a query's rejection, that SAME raw, untranslated error resurfaces from
   * `withTransaction`'s own returned promise anyway — not the more specific, properly-typed
   * error a caller who instead let the rejection propagate naturally out of `fn` would see. Let
   * a failed query's rejection propagate out of `fn` unchanged; do not `try`/`catch` (or
   * `.catch()`) it and keep issuing further queries on the same `tx`.
   * @throws {ValidationError} if `opts` fails {@link TransactionOptionsSchema}.
   * @throws {TransactionRolledBackError} if `fn` threw {@link Rollback}.
   * @throws {TransactionFaultError} on connection loss, serialization failure, deadlock, or
   *   statement timeout.
   * Any other error thrown by `fn` propagates unchanged — treat it as a programmer error, not
   * a domain outcome.
   */
  withTransaction<T>(
    fn: (tx: TransactionHandle) => Promise<T>,
    opts?: TransactionOptions,
  ): Promise<T>;

  /**
   * Acquires the writer lease identified by `key` (one advisory lock per logical writer role,
   * e.g. `wallet-sync:{networkId}`). With no `opts.timeoutMs`, blocks indefinitely until the
   * lock is available — the same behavior as `pg_advisory_lock` itself. There is no "held by
   * another writer, fail immediately" outcome for this method; use {@link tryAcquireLease} for
   * that.
   * @throws {LeaseTimeoutError} if `opts.timeoutMs` was given and elapsed before acquisition.
   * @throws {LeaseFaultError} on connection loss or reservation failure.
   */
  acquireLease(key: string, opts?: LeaseAcquireOptions): Promise<Lease>;

  /**
   * Non-blocking (or bounded-wait, if `opts.timeoutMs` is given) companion to
   * {@link TransactionLeaseLayer.acquireLease} for the routine contention hot path: resolves
   * `null` immediately if the lease is held by another writer and no `timeoutMs` was given
   * (matching `pg_try_advisory_lock`'s real non-blocking semantics), or after `opts.timeoutMs`
   * elapses if one was given — contention is data here, mirroring `get`'s `null` for a missing
   * key. Prefer this in retry/poll loops; reserve `acquireLease` for call sites willing to wait
   * as long as it takes.
   * @throws {LeaseFaultError} on connection loss or reservation failure — infrastructure
   *   faults still throw; only contention resolves `null`.
   */
  tryAcquireLease(key: string, opts?: LeaseAcquireOptions): Promise<Lease | null>;

  /**
   * Releases a previously acquired lease.
   * @throws {LeaseNotHeldError} if the lease was already released or its connection already
   *   closed.
   * @throws {LeaseFaultError} on connection loss.
   */
  releaseLease(lease: Lease): Promise<void>;

  /**
   * Convenience combinator: acquire → run `fn` → always release, even on throw.
   * Prefer this over manual `acquireLease`/`releaseLease` pairs.
   * @throws Same as {@link TransactionLeaseLayer.acquireLease}; if `fn` throws, that error
   *   propagates after the lease is released. A release failure in this cleanup step is
   *   swallowed (this project has no logging infrastructure to route it through — an earlier
   *   draft of this doc claimed it would be "logged," which was never actually implementable),
   *   so it never masks `fn`'s own error, but it is also not surfaced anywhere; callers who need
   *   to observe release failures should call `acquireLease`/`releaseLease` manually instead of
   *   this combinator.
   */
  withLease<T>(
    key: string,
    fn: (lease: Lease) => Promise<T>,
    opts?: LeaseAcquireOptions,
  ): Promise<T>;
}
