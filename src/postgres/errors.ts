import { ConnectionError, StorageError } from "../interfaces/storage-errors.js";
import { TransactionKeyReuseError } from "../interfaces/temporal-kv.js";

/**
 * SQLSTATE `23P01` (exclusion_violation) firing on `kv_history_no_overlap` — NOT `23505`
 * (unique_violation), a distinct code (design/design.md §4a). Defense-in-depth only: the
 * trigger is designed not to produce overlaps, so this is not expected to fire under normal
 * `PgTemporalKV` operation. Deliberately not a `TemporalKVError` subclass — it isn't a
 * documented part of that interface's contract, just a distinguishable failure mode.
 */
export class ExclusionViolationError extends StorageError {
  readonly code = "EXCLUSION_VIOLATION" as const;
  constructor(message: string, cause?: unknown) { super(message, cause); }
}

/**
 * SQLSTATE `23514` (check_violation) firing on `kv_history_range` — caused by a backward
 * wall-clock STEP (not drift) between two writes to the same key, since `valid_from`/`valid_to`
 * are `clock_timestamp()`-derived (design/design.md §4a; `Formal/STORAGE_ALGEBRA.md` §1 Law T4's
 * accepted caveat). Not a data-model violation and not caller-fixable by retrying.
 */
export class ClockRegressionError extends StorageError {
  readonly code = "CLOCK_REGRESSION" as const;
  constructor(message: string, cause?: unknown) { super(message, cause); }
}

/** Shape of the fields postgres.js's `PostgresError` actually carries — narrower than `Error`,
 *  declared locally rather than imported since postgres.js does not export a named error class
 *  (`err instanceof Error && typeof err.code === "string"` is the real duck-typed contract). */
interface PgDriverError extends Error {
  code?: string;
}

function isPgDriverError(err: unknown): err is PgDriverError {
  return err instanceof Error;
}

/**
 * Connection-failure codes, translated to `ConnectionError`. Two distinct namespaces share
 * this one set (both surface via the same driver `.code` property, so one lookup covers both):
 * Node-level codes (no SQLSTATE — the driver never reached/kept a connection to the server),
 * and real Postgres SQLSTATEs for connection/authentication/shutdown failures. **Revised after
 * a cross-vendor audit found the original set covered only the Node-level half** — a real
 * Postgres error (a wrong password, an admin-initiated shutdown, a dropped connection
 * mid-query) has its own SQLSTATE and was previously falling through to the `default` branch
 * unchanged, contradicting the documented no-raw-driver-errors contract.
 */
const CONNECTION_FAILURE_CODES = new Set([
  // Node-level
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNRESET",
  "CONNECTION_CLOSED",
  "CONNECT_TIMEOUT",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  // Postgres SQLSTATE class 08 (connection_exception) — see PostgreSQL's own error-codes table
  "08000", // connection_exception
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "08006", // connection_failure
  "08007", // transaction_resolution_unknown
  "08P01", // protocol_violation
  // Authentication failures — a wrong password/role is a connection-establishment failure from
  // this adapter's point of view, not a data-model error
  "28000", // invalid_authorization_specification
  "28P01", // invalid_password
  // Server-initiated termination while a connection was in use
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);

/**
 * Translates a raw `postgres.js` driver error into the shared `StorageError` hierarchy
 * (design/design.md §4a). Callers pass the operation's own `ns`/`scope`/`key` context so
 * `TransactionKeyReuseError` can be constructed directly from what the caller already knows,
 * rather than parsing it back out of the trigger's human-readable exception message (which
 * would be fragile and duplicate information the caller already has).
 */
export function translatePostgresError(
  err: unknown,
  keyContext?: { namespace: string; scope: string; key: string },
): Error {
  if (!isPgDriverError(err)) return err instanceof Error ? err : new Error(String(err));

  if (err.code && CONNECTION_FAILURE_CODES.has(err.code)) {
    return new ConnectionError(err.message, err);
  }

  switch (err.code) {
    case "UB001":
      if (keyContext) {
        return new TransactionKeyReuseError(keyContext.namespace, keyContext.scope, keyContext.key);
      }
      return new ExclusionViolationError(`transaction key reuse (UB001) with no key context: ${err.message}`, err);
    case "23P01":
      return new ExclusionViolationError(err.message, err);
    case "23514":
      return new ClockRegressionError(err.message, err);
    default:
      return err;
  }
}
