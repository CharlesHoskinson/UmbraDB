import { z } from "zod";

/**
 * Machine-readable retryability classification for a {@link StorageError} (G3, design §3.1/§3.2).
 * A caught error exposes this alongside its stable `code`, so a caller decides whether to retry
 * without parsing a message string:
 *
 * - `"retryable"` -- a transient fault a retry can clear: `CONNECTION_ERROR`, `TRANSACTION_FAULT`,
 *   `LEASE_TIMEOUT` (an immediate in-process retry), and `MIGRATION_LOCK_TIMEOUT` (a bounded
 *   backoff-then-retry, which clears once the concurrent migration finishes).
 * - `"non-retryable"` -- retrying cannot succeed without changing the input, the data, or the
 *   deployment (validation, integrity, conflict, config, and lease-ownership failures).
 * - `"conditional"` -- retryability depends on the specific cause; the only 1.0.0 case is
 *   `CLOCK_REGRESSION`, whose same-millisecond precision collision IS retryable once the
 *   millisecond boundary passes while a sustained backward wall-clock step is NOT (see
 *   `ClockRegressionError`). A `"conditional"` error MUST NOT be treated as uniformly
 *   non-retryable.
 */
export type Retryability = "retryable" | "non-retryable" | "conditional";

/**
 * Common ancestor for every typed error thrown by the storage layer
 * (TemporalKV, CheckpointStore, Watermarks, Transaction/Lease).
 */
export abstract class StorageError extends Error {
  /** Discriminant for narrowing without `instanceof` — stable across serialization. */
  abstract readonly code: string;
  /**
   * Machine-readable retryability of this error (G3, design §3.2). Every concrete subclass
   * sets it; see {@link Retryability} and the frozen `{code -> retryable}` catalog (design
   * §3.1). A caught error exposes this alongside `code`, so a caller decides whether to
   * retry without parsing a message.
   */
  abstract readonly retryable: Retryability;
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = new.target.name;
  }
}

/** Codes for infrastructure failures shared by every module (design doc §1.1). */
export type SharedStorageErrorCode =
  | "VALIDATION_FAILED"
  | "SERIALIZATION_FAILED"
  | "CONNECTION_ERROR";

/**
 * Thrown when an input fails its Zod boundary schema (§1.4). Rejects before any backend
 * work happens. `issues` is the flattened Zod issue list, safe to log and serialize.
 */
export class ValidationError extends StorageError {
  readonly code = "VALIDATION_FAILED" as const;
  readonly retryable = "non-retryable" as const;
  constructor(
    message: string,
    readonly issues: ReadonlyArray<{ readonly path: string; readonly message: string }>,
    cause?: unknown,
  ) { super(message, cause); }

  /** Canonical constructor from a ZodError at a module boundary. */
  static fromZod(boundary: string, err: z.ZodError): ValidationError {
    return new ValidationError(
      `invalid input at ${boundary}`,
      err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      err,
    );
  }
}

/** Thrown when a value fails to round-trip through the backend's encoding (JSONB/BSON). */
export class SerializationFailedError extends StorageError {
  readonly code = "SERIALIZATION_FAILED" as const;
  readonly retryable = "non-retryable" as const;
  constructor(message: string, cause?: unknown) { super(message, cause); }
}

/** Thrown on driver-level connection failure, by any module. */
export class ConnectionError extends StorageError {
  readonly code = "CONNECTION_ERROR" as const;
  readonly retryable = "retryable" as const;
  constructor(message: string, cause?: unknown) { super(message, cause); }
}
