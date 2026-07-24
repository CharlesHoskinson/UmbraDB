import type { ISql, Sql } from "postgres";
import { StorageError } from "../interfaces/storage-errors.js";

/**
 * G6 — Durability startup probe + transaction-pooler detection
 * (`openspec/changes/v1.0.0-durable-checkpoint-cursor/design.md` §2, tasks 1.1/1.2).
 *
 * `createClient` is synchronous, but a `SHOW`/`current_setting`-and-verify probe is inherently
 * async, so the probe is this exported async function rather than folded into `createClient`. It is
 * wired as a MANDATORY step of `runMigrations` (`migrate.ts`) so the crash-safety precondition is
 * enforced, not left to caller discipline (design.md §2.1) — a hard violation makes `runMigrations`
 * reject before any migration runs. `probeDurability` also remains directly callable.
 *
 * SQL discipline: the probe interpolates NO identifier or value into SQL. Settings are read via
 * `current_setting($1)` (the name is a bind parameter, equivalent to `SHOW <name>`, verified against
 * PostgreSQL 17), and the pooler check uses parameterized `pg_try_advisory_lock`/`pg_locks`. There
 * is no `sql.unsafe()` site here — the frozen-surface allowlist is unchanged.
 */

/** A recoverable durability trade the operator may deliberately accept (returned, never thrown). */
export interface DurabilityWarning {
  readonly kind: "lost-tail";
  readonly setting: string;
  readonly value: string;
  readonly message: string;
}

/** A hard crash-safety violation (collected, then thrown as a `DurabilityContractError`). */
export interface DurabilityViolation {
  readonly setting: string;
  readonly value: string;
  readonly message: string;
}

/**
 * Thrown when a PostgreSQL setting forfeits crash durability in a way that risks corruption
 * (`fsync=off`, or `full_page_writes=off` without an explicit override). Joins the `StorageError`
 * hierarchy so `translatePostgresError` passes it through unchanged (`errors.ts`).
 */
export class DurabilityContractError extends StorageError {
  readonly code = "DURABILITY_CONTRACT_VIOLATION" as const;
  constructor(message: string, readonly violations: readonly DurabilityViolation[], cause?: unknown) {
    super(message, cause);
  }
}

/**
 * Thrown when a session advisory lock this connection holds is not visible to a follow-up query on
 * the same logical session — the signature of a transaction-pooling proxy (PgBouncer transaction
 * mode), which silently breaks UmbraDB's advisory-lease scheme (design.md §2.3).
 */
export class TransactionPoolerDetectedError extends StorageError {
  readonly code = "TRANSACTION_POOLER_DETECTED" as const;
  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

export interface DurabilityProbeOptions {
  /**
   * Permit `full_page_writes=off`. Default: refuse. Only set this when the storage layer guarantees
   * atomic 8 kB page writes (so torn pages on crash recovery are impossible); documented as an
   * operator opt-out in `docs/durability-contract.md`.
   */
  allowFullPageWritesOff?: boolean;
}

// ---- pure classifiers (the whole decision, unit-testable without a database) ----------------------

export function classifyFsync(value: string): DurabilityViolation | null {
  if (value === "off") {
    return {
      setting: "fsync",
      value,
      message:
        "fsync=off lets PostgreSQL skip flushing WAL and data to disk, so an OS crash or power loss " +
        "can leave the database arbitrarily corrupted — not merely missing a recent tail. UmbraDB " +
        "refuses to run migrations against it. Set fsync=on.",
    };
  }
  return null;
}

export function classifyFullPageWrites(value: string, allowOff: boolean): DurabilityViolation | null {
  if (value === "off" && !allowOff) {
    return {
      setting: "full_page_writes",
      value,
      message:
        "full_page_writes=off risks torn pages on crash recovery — a page half-written across an OS " +
        "crash cannot be reconstructed from the WAL — which can corrupt committed data. UmbraDB " +
        "refuses by default. Set full_page_writes=on, or pass durability.allowFullPageWritesOff only " +
        "if the storage layer guarantees atomic 8 kB page writes.",
    };
  }
  return null;
}

export function classifySynchronousCommit(value: string): DurabilityWarning | null {
  if (value === "off") {
    return {
      kind: "lost-tail",
      setting: "synchronous_commit",
      value,
      message:
        "synchronous_commit=off acknowledges a commit before its WAL is flushed, so an OS crash or " +
        "power loss can silently lose a bounded tail of already-acknowledged transactions (it does " +
        "not corrupt the database). This is a recoverable trade an operator may accept deliberately, " +
        "so UmbraDB warns rather than refuses. Use local/remote_write/remote_apply/on to guarantee no " +
        "acknowledged commit is lost on a primary.",
    };
  }
  // on / local / remote_write / remote_apply all flush this transaction's WAL to local disk before
  // acknowledging the commit on a primary, so none forfeit local crash durability — no warning.
  return null;
}

export function assertNoTransactionPooler(acquired: boolean, visibleCount: number): void {
  // A transaction pooler is indicated ONLY by a lock that was acquired but is INVISIBLE to a
  // follow-up query on the same session. With a per-session-unique sentinel the acquire always
  // succeeds on a healthy server; if it somehow does not, that is an anomaly, not a pooler
  // signature — do NOT block migrations on it (fail open), since a real pooler still manifests as
  // acquired-but-invisible below (audit BLOCK).
  if (!acquired) return;
  if (visibleCount < 1) {
    throw new TransactionPoolerDetectedError(
      "a session advisory lock this connection acquired was not visible to a follow-up query on the " +
        "same logical session — the signature of a transaction-pooling proxy (e.g. PgBouncer in " +
        "transaction mode), which routes successive queries to different backends and silently breaks " +
        "UmbraDB's advisory-lease scheme. Connect UmbraDB directly to PostgreSQL or use a session-mode pool.",
    );
  }
}

// ---- live probe primitives ------------------------------------------------------------------------

// Probe under the class the writer-lease's own advisory locks appear under (`transaction-lease.ts`'s
// LEASE_ADVISORY_LOCK_CLASS = 2), so the check tests the exact property the lease depends on:
// session-scoped advisory-lock visibility across two queries. The sentinel key is UNIQUE per probe
// session (derived from pg_backend_pid()) so two concurrent runMigrations probes never contend on a
// shared key — which, under a non-blocking pg_try_advisory_lock, would make the loser's acquire fail
// and be misread as a pooler (audit BLOCK). The lock is taken, checked, and released within the one
// reserved session.
const POOLER_PROBE_LOCK_CLASS = 2;

/**
 * Acquires the sentinel session advisory lock, counts whether a follow-up query on the SAME session
 * observes it, then unlocks. Returns the raw observations for `assertNoTransactionPooler` to judge —
 * split out so the "not visible" branch is unit-testable by direct injection (task 1.2), no
 * transaction-pooler harness required in CI.
 */
export async function probeAdvisoryLockVisibility(
  reserved: ISql,
): Promise<{ acquired: boolean; visibleCount: number }> {
  // Per-session-unique sentinel key so concurrent probes never contend (audit BLOCK). pg_backend_pid()
  // is unique among live backends; captured once and used as the key for acquire, visibility, and unlock.
  const pidRow = await reserved<{ pid: number }[]>`select pg_backend_pid() as pid`;
  const key = `umbradb:durability-probe:pooler:${pidRow[0]!.pid}`;
  const acq = await reserved<{ acquired: boolean }[]>`
    select pg_try_advisory_lock(${POOLER_PROBE_LOCK_CLASS}, hashtext(${key})) as acquired
  `;
  const acquired = acq[0]!.acquired;
  if (!acquired) return { acquired: false, visibleCount: 0 };
  try {
    // objsubid = 2 is the two-key advisory-lock form; the (hashtext(...))::oid cast matches the oid
    // PostgreSQL stores for a negative int4 key (verified against PostgreSQL 17). The pg_backend_pid()
    // filter asks specifically whether THIS session's follow-up query sees THIS session's lock.
    const rows = await reserved<{ visible: number }[]>`
      select count(*)::int as visible
      from pg_locks
      where locktype = 'advisory'
        and classid = ${POOLER_PROBE_LOCK_CLASS}
        and objid = (hashtext(${key}))::oid
        and objsubid = 2
        and pid = pg_backend_pid()
    `;
    return { acquired: true, visibleCount: rows[0]!.visible };
  } finally {
    // A session advisory lock persists until the backend ends or is explicitly released; since the
    // reserved connection returns to the pool, unlock here so the sentinel does not accumulate.
    await reserved`
      select pg_advisory_unlock(${POOLER_PROBE_LOCK_CLASS}, hashtext(${key}))
    `.catch(() => {});
  }
}

/**
 * Reads `fsync`, `synchronous_commit`, and `full_page_writes` on one pinned session and detects a
 * transaction pooler. Throws `DurabilityContractError` on a hard violation (fsync/full_page_writes)
 * or `TransactionPoolerDetectedError` on a pooler; otherwise returns any lost-tail warnings.
 */
export async function probeDurability<TTypes extends Record<string, unknown> = {}>(
  sql: Sql<TTypes>,
  opts?: DurabilityProbeOptions,
): Promise<DurabilityWarning[]> {
  const reserved = await sql.reserve();
  try {
    const readSetting = async (name: string): Promise<string> => {
      const rows = await reserved<{ v: string }[]>`select current_setting(${name}) as v`;
      return rows[0]!.v;
    };
    const fsync = await readSetting("fsync");
    const synchronousCommit = await readSetting("synchronous_commit");
    const fullPageWrites = await readSetting("full_page_writes");

    const violations: DurabilityViolation[] = [];
    const fsyncViolation = classifyFsync(fsync);
    if (fsyncViolation) violations.push(fsyncViolation);
    const fpwViolation = classifyFullPageWrites(fullPageWrites, opts?.allowFullPageWritesOff ?? false);
    if (fpwViolation) violations.push(fpwViolation);

    const warnings: DurabilityWarning[] = [];
    const syncWarning = classifySynchronousCommit(synchronousCommit);
    if (syncWarning) warnings.push(syncWarning);

    if (violations.length > 0) {
      throw new DurabilityContractError(
        `PostgreSQL durability contract violated: ${violations
          .map((v) => `${v.setting}=${v.value}`)
          .join(", ")}. See docs/durability-contract.md for the binding configuration.`,
        violations,
      );
    }

    const visibility = await probeAdvisoryLockVisibility(reserved);
    assertNoTransactionPooler(visibility.acquired, visibility.visibleCount);

    return warnings;
  } finally {
    reserved.release();
  }
}
