import { z } from "zod";
import { StorageError } from "./storage-errors.js";

/**
 * Transaction/Lease layer — implementation-agnostic contract.
 * Backed by `sql.begin()` (transactions) and `sql.reserve()` + advisory locks (leases) in the
 * Postgres adapter; this file contains no `pg`-specific types.
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

/** Opaque proof of a held writer lease (advisory lock pinned to a reserved connection). */
export interface Lease {
  readonly __brand: "Lease";
  readonly key: string;
  /** Unique per acquisition; lets releaseLease reject a stale/duplicate release. */
  readonly token: string;
  readonly acquiredAt: Date;
  /** `null` = held until explicit release or connection death (no TTL). */
  readonly expiresAt: Date | null;
}

// ---------------------------------------------------------------------------
// Typed error hierarchy
// ---------------------------------------------------------------------------

export type TransactionLeaseErrorCode =
  | "TRANSACTION_ROLLED_BACK"
  | "TRANSACTION_FAULT"
  | "LEASE_TIMEOUT"
  | "LEASE_HELD_BY_OTHER"
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
 *  when the lock could not be acquired within `opts.timeoutMs`. */
export class LeaseTimeoutError extends TransactionLeaseError {
  readonly code = "LEASE_TIMEOUT" as const;
  constructor(readonly key: string, readonly waitedMs: number) {
    super(`timed out after ${waitedMs}ms waiting for lease "${key}"`);
  }
}

/** Thrown when a lease is held by another writer and no (or an exhausted) timeout was given. */
export class LeaseHeldByOtherError extends TransactionLeaseError {
  readonly code = "LEASE_HELD_BY_OTHER" as const;
  constructor(readonly key: string, readonly ownerHint?: string) {
    super(`lease "${key}" is held by another writer${ownerHint ? ` (${ownerHint})` : ""}`);
  }
}

/** Thrown by {@link TransactionLeaseLayer.releaseLease} when the lease was already released,
 *  expired, or stolen — releasing twice is routine under contention, not a bug, but the caller
 *  is still told so via a distinct, catchable error rather than a silent no-op. */
export class LeaseNotHeldError extends TransactionLeaseError {
  readonly code = "LEASE_NOT_HELD" as const;
  constructor(readonly key: string) {
    super(`lease "${key}" was not held (expired, stolen, or already released)`);
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
  | { kind: "constraint-violation"; code: string; detail?: string }
  | { kind: "lease-lost"; key: string };

// ---------------------------------------------------------------------------
// Options — Zod-first, per §1.4 (data fields in the schema; live handles intersected on)
// ---------------------------------------------------------------------------

export const TransactionOptionsSchema = z.object({
  isolation: z.enum(["read committed", "repeatable read", "serializable"]).optional(),
  /** Statement/transaction timeout; a timeout surfaces as {@link TransactionFaultError}. */
  timeoutMs: z.number().int().positive().optional(),
});
export type TransactionOptions = z.infer<typeof TransactionOptionsSchema> & {
  /** Cancellation, per §1.2: abort rolls back and rejects with `AbortError`. */
  signal?: AbortSignal;
};

export const LeaseAcquireOptionsSchema = z.object({
  /** Give up after this long waiting for the lock: {@link LeaseTimeoutError} from
   *  `acquireLease`/`withLease`, `null` from `tryAcquireLease`. */
  timeoutMs: z.number().int().positive().optional(),
  /** Optional self-expiry so a crashed holder doesn't wedge the lock forever. Requires the
   *  lease bookkeeping table (see implementation notes below) — advisory locks alone have
   *  no TTL concept. */
  ttlMs: z.number().int().positive().optional(),
});
export type LeaseAcquireOptions = z.infer<typeof LeaseAcquireOptionsSchema> & {
  /** Cancellation, per §1.2: abort while waiting rejects with `AbortError`; if the lock was
   *  already acquired when the abort lands, the lease is released before rejecting. */
  signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// The layer's public surface
// ---------------------------------------------------------------------------

export interface TransactionLeaseLayer {
  /**
   * Runs `fn` inside a database transaction and resolves with its return value on commit.
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
   * e.g. `wallet-sync:{networkId}`).
   * @throws {LeaseTimeoutError} if the lock could not be acquired within `opts.timeoutMs`.
   * @throws {LeaseHeldByOtherError} if another writer holds it and no timeout resolves that.
   * @throws {LeaseFaultError} on connection loss or reservation failure.
   */
  acquireLease(key: string, opts?: LeaseAcquireOptions): Promise<Lease>;

  /**
   * Non-throwing companion to {@link TransactionLeaseLayer.acquireLease} for the routine
   * contention hot path (§1.1): resolves `null` if the lease is held by another writer or if
   * `opts.timeoutMs` elapses — contention is data here, mirroring `get`'s `null` for a
   * missing key. Prefer this in retry/poll loops; reserve `acquireLease` for call sites where
   * failing to get the lock is genuinely exceptional.
   * @throws {LeaseFaultError} on connection loss or reservation failure — infrastructure
   *   faults still throw; only contention resolves `null`.
   */
  tryAcquireLease(key: string, opts?: LeaseAcquireOptions): Promise<Lease | null>;

  /**
   * Releases a previously acquired lease.
   * @throws {LeaseNotHeldError} if the lease was already released, expired, or stolen.
   * @throws {LeaseFaultError} on connection loss.
   */
  releaseLease(lease: Lease): Promise<void>;

  /**
   * Convenience combinator: acquire → run `fn` → always release, even on throw.
   * Prefer this over manual `acquireLease`/`releaseLease` pairs.
   * @throws Same as {@link TransactionLeaseLayer.acquireLease}; if `fn` throws, that error
   *   propagates after the lease is released (release failures are logged, not thrown, so they
   *   never mask the caller's real error).
   */
  withLease<T>(
    key: string,
    fn: (lease: Lease) => Promise<T>,
    opts?: LeaseAcquireOptions,
  ): Promise<T>;
}
