import { ConnectionError, StorageError } from "../interfaces/storage-errors.js";
import { TransactionKeyReuseError } from "../interfaces/temporal-kv.js";
import { TransactionFaultError } from "../interfaces/transaction-lease.js";

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
 * SQLSTATE `23514` (check_violation) firing on `kv_history_range`, from EITHER of two distinct
 * causes with different retry characteristics — **corrected by a fourth-round cross-vendor
 * re-audit, which found the prior wording only described one of them and blanket-claimed
 * non-retryability that doesn't hold for the other**:
 * (a) a backward wall-clock STEP (an NTP correction, not drift) between two writes to the same
 * key — genuinely NOT caller-fixable by retrying, since the caller has no way to know when (or
 * whether) the clock will move forward again; or
 * (b) two writes to the SAME key, in different transactions, whose `clock_timestamp()`-derived,
 * millisecond-truncated instants land in the same millisecond — IS caller-fixable: simply
 * retrying after the millisecond boundary has passed succeeds, since the collision is a
 * precision artifact, not a real ordering conflict. (`design/design.md` §4a;
 * `Formal/STORAGE_ALGEBRA.md` §1 Law T4's accepted caveat covers both causes.) Not a data-model
 * violation either way, but callers should not assume this error is always non-retryable.
 */
export class ClockRegressionError extends StorageError {
  readonly code = "CLOCK_REGRESSION" as const;
  constructor(message: string, cause?: unknown) { super(message, cause); }
}

/**
 * Sprint-fix round Fix 4 (MEDIUM): the chain-archive schema (`src/postgres/migrations/
 * chain_archive/001_chain_archive_core.ts`) raises SQLSTATE `23514` (check_violation) from
 * several of its OWN invariants, entirely unrelated to temporal-kv's clock-regression CHECK --
 * before this fix, EVERY `23514` fell through to `ClockRegressionError` below unconditionally,
 * which actively misled anyone debugging a genuine chain-archive data-integrity failure into
 * thinking it was a clock/NTP issue. `translatePostgresError` now branches on the error's own
 * `.constraint_name` (Postgres reports which named constraint fired; see that function's own
 * comment for the full routing table) to tell these apart. Two categories:
 *
 *   - `ChainArchiveInvariantError`: one of chain-archive's own hand-written `RAISE EXCEPTION ...
 *     USING CONSTRAINT = '...'` triggers fired (see the migration's `chain_blob_roles_completeness`/
 *     `blocks_finalized_monotonic`/`chain_blob_roles_removal_guard` constraint names) -- a
 *     malformed blob-role write, or a genuine attempt to un-finalize a previously-finalized
 *     block. These are cross-write invariants a plain CHECK constraint cannot express on its own,
 *     which is why they're triggers rather than CHECKs in the first place.
 *   - `ChainArchiveCheckViolationError`: an ordinary table `CHECK` constraint on one of
 *     chain-archive's own tables fired (status/kind enum values, hash-length checks, nonnegative
 *     checks, the `(scope = 'contract') = (contract_address IS NOT NULL)` tie, etc.) --
 *     recognized by the constraint name's table-name prefix (Postgres auto-names an unlabeled
 *     CHECK `<table>_<column>_check` or `<table>_check[N]`, confirmed empirically against a real
 *     Postgres 17 instance while implementing this fix).
 */
export class ChainArchiveInvariantError extends StorageError {
  readonly code = "CHAIN_ARCHIVE_INVARIANT_VIOLATION" as const;
  constructor(message: string, readonly constraintName: string, cause?: unknown) { super(message, cause); }
}

/** See `ChainArchiveInvariantError`'s own doc above -- the ordinary-table-CHECK counterpart. */
export class ChainArchiveCheckViolationError extends StorageError {
  readonly code = "CHAIN_ARCHIVE_CHECK_VIOLATION" as const;
  constructor(message: string, readonly constraintName: string, cause?: unknown) { super(message, cause); }
}

/**
 * Catch-all for a real driver/database error (has a SQLSTATE or Node network `.code`) that
 * doesn't match any of this module's specific translations. **Added after a cross-vendor
 * re-audit found the interface's own Requirement ("a raw postgres.js error object SHALL NOT
 * escape the adapter layer," `specs/temporal-kv/spec.md`) taken literally** — the previous
 * `default: return err` branch let anything not explicitly enumerated (a statement-cancellation
 * `57014`, an `undefined_table` `42P01`, an unlisted network code) through unchanged, which is
 * exactly the raw-error leak that Requirement exists to prevent. This class exists so that
 * promise is actually kept for every case, not just the ones this file happened to enumerate,
 * without inventing a bespoke class per SQLSTATE this project doesn't otherwise care about.
 */
export class UnrecognizedPostgresError extends StorageError {
  readonly code = "UNRECOGNIZED_POSTGRES_ERROR" as const;
  constructor(message: string, cause?: unknown) { super(message, cause); }
}

/** Shape of the fields postgres.js's `PostgresError` actually carries — narrower than `Error`,
 *  declared locally rather than imported since postgres.js does not export a named error class
 *  (`err instanceof Error && typeof err.code === "string"` is the real duck-typed contract).
 *  **Revised after a cross-vendor re-audit**: the `code` check is now REQUIRED, not optional —
 *  a plain application-level `Error`/`TypeError` unrelated to Postgres has no `.code` at all, so
 *  requiring one here is what actually distinguishes "this looks like a real driver/database
 *  error" from "this is an arbitrary bug elsewhere in the codebase that happened to be an
 *  `Error` instance." That distinction matters for the new catch-all below — wrapping a random
 *  application bug as though it were a Postgres error would hide it, not translate it. */
interface PgDriverError extends Error {
  code: string;
  /** The name of the specific constraint that fired, when Postgres reports one -- present for a
   *  genuine table `CHECK`/`UNIQUE`/etc. constraint violation, and for a `RAISE EXCEPTION ...
   *  USING CONSTRAINT = '...'` that explicitly sets it (Fix 4, see `ChainArchiveInvariantError`'s
   *  own doc above). `undefined` for a plain `RAISE EXCEPTION` with no `CONSTRAINT` clause.
   *  postgres.js surfaces this as `constraint_name` (verified against its own wire-protocol field
   *  table, `node_modules/postgres/src/connection.js`), not the `.constraint` name Postgres's own
   *  C client (`libpq`) uses -- easy to get wrong, confirmed by testing both against a real
   *  Postgres 17 instance while implementing this fix. */
  constraint_name?: string;
}

/** Chain-archive's own known constraint/trigger names that raise SQLSTATE `23514`
 *  (`src/postgres/migrations/chain_archive/001_chain_archive_core.ts`) -- the three hand-written
 *  cross-write invariants (triggers, not plain CHECKs). */
const CHAIN_ARCHIVE_INVARIANT_CONSTRAINT_NAMES = new Set([
  "chain_blob_roles_completeness",
  "blocks_finalized_monotonic",
  "chain_blob_roles_removal_guard",
]);

/** Every table chain-archive's own migration defines a plain `CHECK` constraint on -- Postgres
 *  auto-names an unlabeled CHECK `<table>_<column>_check` or `<table>_check[N]`, so a leading-
 *  prefix match against this list (checked before the `_` that would otherwise also match, e.g.
 *  a hypothetical `blocks_something_else` table this schema doesn't have) is what tells these
 *  apart from `kv_history_range` (temporal-kv's own, explicitly-named, unrelated CHECK) and from
 *  any future, not-yet-anticipated 23514 source elsewhere in this codebase. */
const CHAIN_ARCHIVE_CHECK_TABLE_PREFIXES = [
  "blocks_", "transactions_", "bridge_observations_", "chain_blobs_", "chain_blob_roles_",
  "verifier_key_observations_",
];

function isChainArchiveCheckConstraintName(constraintName: string): boolean {
  return CHAIN_ARCHIVE_CHECK_TABLE_PREFIXES.some((prefix) => constraintName.startsWith(prefix));
}

/**
 * **Revised again after a cross-vendor Sprint 2 audit found the `.code`-only check above still
 * too loose** — it was originally written for call sites that only ever see errors thrown by
 * THIS module's own SQL calls, but `withTransaction`'s catch block (`transaction-lease.ts`) also
 * sees whatever `fn` (arbitrary caller code) throws. Any plain application error that happens to
 * carry its OWN `.code` string property — a Node built-in like `ENOENT`/`EACCES`, or a caller's
 * own business-error convention — would previously be misclassified as a driver error and, for
 * any code not in this file's specific enumerations, silently relabeled `UnrecognizedPostgresError`
 * by the `default` branch below, directly violating `withTransaction`'s own documented contract
 * ("any other error thrown by fn propagates unchanged"). A genuine Postgres wire-protocol error
 * ALWAYS carries a `.severity` field too (confirmed against real driver error dumps throughout
 * this project's own test output, e.g. `{severity_local: 'ERROR', severity: 'ERROR', code:
 * 'UB001', ...}`) — an arbitrary application error essentially never coincidentally has this AS
 * WELL as a `.code`. Node-level connection failures (`ECONNREFUSED` etc.) never reach the wire
 * protocol and so never carry `.severity` either, but they're a small, closed, already-enumerated
 * set (`CONNECTION_FAILURE_CODES` below) — trusting membership in that set is safe precisely
 * because it's closed, unlike accepting any arbitrary string `.code`. */
function isPgDriverError(err: unknown): err is PgDriverError {
  if (!(err instanceof Error) || typeof (err as { code?: unknown }).code !== "string") return false;
  const code = (err as PgDriverError).code;
  const looksLikeRealPostgresError = typeof (err as { severity?: unknown }).severity === "string";
  return looksLikeRealPostgresError || CONNECTION_FAILURE_CODES.has(code);
}

/** Exported so callers that see arbitrary, non-adapter-internal errors (`withTransaction`'s
 *  catch, which also sees whatever `fn` throws) can check for a genuine connection failure
 *  specifically, without routing through the full `translatePostgresError` switch. */
export function isConnectionFailure(err: unknown): boolean {
  return isPgDriverError(err) && CONNECTION_FAILURE_CODES.has(err.code);
}

/**
 * SQLSTATE `57014` (`query_canceled`) is CONTEXTUAL — it fires for a `statement_timeout`
 * cancellation, an operator-issued `pg_cancel_backend()`, or this project's own explicit
 * `query.cancel()` calls (`listKeys`, lease acquisition's mid-wait abort) alike, so it cannot be
 * given one universal translation in the shared table below (`openspec/changes/
 * sprint-2-transaction-lease/design.md` §3/§5). Centralized here (moved out of
 * `transaction-lease.ts`, which has two separate call sites that both need it — lease
 * acquisition's own timeout, and `withTransaction`'s) so both agree on the exact same check
 * rather than maintaining two copies.
 */
export function isStatementTimeout(err: unknown): boolean {
  return isPgDriverError(err) && err.code === "57014";
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
  // Found by a third-round cross-vendor re-audit: every StorageError subclass ALSO has a
  // string `.code` (storage-errors.ts's own `abstract readonly code: string`), so the
  // `isPgDriverError` check below — added specifically to distinguish real driver errors from
  // arbitrary application bugs — cannot by itself tell a genuine driver error apart from one of
  // THIS project's own already-typed errors. Concretely: `toEntry()` throws `ValidationError`
  // for a malformed stored row, and callers that invoke it inside the same try/catch that
  // routes through this function (e.g. a read path) would previously see that `ValidationError`
  // silently relabeled as `UnrecognizedPostgresError`, losing its real type. Any error that is
  // ALREADY one of ours must pass through completely unchanged, checked first, before the
  // driver-error classification below ever runs.
  if (err instanceof StorageError) return err;

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
    case "23514": {
      // Fix 4: constraint-name-aware routing -- see `ChainArchiveInvariantError`'s own doc above
      // for the full reasoning. `err.constraint_name` is `undefined` for a plain RAISE EXCEPTION
      // with no CONSTRAINT clause and for any 23514 source this file doesn't yet know about --
      // both fall through to the historical `ClockRegressionError` default, preserving prior
      // behavior for anything not explicitly enumerated here (defense in depth: a future 23514
      // source elsewhere in this codebase that forgets to update this routing table fails toward
      // the PRE-Fix-4 behavior, not toward silently swallowing/misrouting a brand-new error kind
      // no one has looked at yet).
      const constraintName = err.constraint_name;
      if (constraintName !== undefined && CHAIN_ARCHIVE_INVARIANT_CONSTRAINT_NAMES.has(constraintName)) {
        return new ChainArchiveInvariantError(err.message, constraintName, err);
      }
      if (constraintName !== undefined && isChainArchiveCheckConstraintName(constraintName)) {
        return new ChainArchiveCheckViolationError(err.message, constraintName, err);
      }
      return new ClockRegressionError(err.message, err);
    }
    // Added for Sprint 2 (openspec/changes/sprint-2-transaction-lease/design.md §5):
    // withTransaction reuses this shared table for these two, unlike the two CONTEXTUAL 57014
    // cases (lease-acquisition timeout, transaction timeout), which are handled directly in
    // their own call sites via isStatementTimeout, not here.
    case "40001":
      return new TransactionFaultError(`serialization failure: ${err.message}`, "serialization-failure", err);
    case "40P01":
      return new TransactionFaultError(`deadlock detected: ${err.message}`, "deadlock", err);
    default:
      return new UnrecognizedPostgresError(err.message, err);
  }
}
