import { z } from "zod";
import {
  ConnectionError, SerializationFailedError, StorageError, ValidationError,
} from "./storage-errors.js";
import type { TransactionHandle } from "./transaction-lease.js";

/**
 * REVISED after a cross-vendor audit found the original design mathematically
 * self-contradictory: permitting multiple `put`s to one key within a single transaction made
 * Law T4 (dual-addressing agreement, STORAGE_ALGEBRA.md §1) impossible to satisfy, because
 * Postgres's `now()` is fixed at transaction start — two such writes would share one commit
 * instant, and no timestamp-based lookup could then distinguish them. Fix: **at most one
 * `put` to a given key may occur within a single transaction** (enforced at the trigger level
 * in the Postgres adapter, not just documented — see design.md §2). This is a real constraint
 * on callers, not a cosmetic one: batch multiple logical updates to the same key across
 * separate transactions, not one.
 */

/**
 * A Postgres-safe UTF-16 string: rejects NUL (`\u0000`, which Postgres `text`/`jsonb` cannot
 * store at all) and unpaired ("lone") surrogate code units (which `jsonb` also rejects, since
 * it requires well-formed UTF-8 on the wire). Found necessary by a cross-vendor audit: the
 * schemas below previously admitted these values, which then reached the driver and failed as
 * raw, untranslated Postgres errors instead of the documented `ValidationError` — a boundary
 * that looked like it validated everything but didn't actually cover what the storage backend
 * can represent.
 */
const LONE_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** Exported (not just an internal helper) so adapter-level code validating a raw string that
 *  isn't itself a Namespace/Scope/Key/JsonValue — e.g. `listKeys`'s `prefix` parameter, which
 *  has no dedicated Zod schema of its own — can reuse the same check instead of duplicating it.
 *  Found necessary by a cross-vendor re-audit: `listKeys`'s `prefix` was LIKE-escaped for
 *  pattern-matching safety but never checked for the same NUL/lone-surrogate problem every
 *  other string-shaped input is checked for. */
export function hasPostgresUnsafeText(s: string): boolean {
  return s.includes("\u0000") || LONE_SURROGATE_PATTERN.test(s);
}
const POSTGRES_SAFE_TEXT_MESSAGE = "must not contain a NUL byte or an unpaired UTF-16 surrogate (PostgreSQL cannot store either)";

/** Recursively checks a parsed `JsonValue` tree (both keys and string leaves) for the same
 *  NUL/lone-surrogate problem `hasPostgresUnsafeText` checks on a plain string — `z.json()`'s
 *  own recursive schema has no hook to apply a per-leaf refinement, so this walks the parsed
 *  result once after the fact. */
function jsonValueHasUnsafeText(v: unknown): boolean {
  if (typeof v === "string") return hasPostgresUnsafeText(v);
  if (Array.isArray(v)) return v.some(jsonValueHasUnsafeText);
  if (v !== null && typeof v === "object") {
    return Object.entries(v as Record<string, unknown>).some(
      ([k, val]) => hasPostgresUnsafeText(k) || jsonValueHasUnsafeText(val),
    );
  }
  return false;
}

/**
 * A JSON-serializable value — the only value shape TemporalKV accepts, since both the
 * Postgres JSONB and Mongo BSON backends must round-trip it losslessly.
 * Schema-first: `z.json()` is Zod v4's built-in recursive JSON-value schema, refined with the
 * Postgres-safety check above so a value that would fail at the JSONB boundary is rejected
 * here as `ValidationError`, not at the driver as a raw, untranslated error.
 */
export const JsonValueSchema = z.json().refine((v) => !jsonValueHasUnsafeText(v), {
  message: `JSON value ${POSTGRES_SAFE_TEXT_MESSAGE}`,
});
export type JsonValue = z.infer<typeof JsonValueSchema>;

export const NamespaceSchema = z.string().min(1).max(63)
  .refine((s) => !hasPostgresUnsafeText(s), { message: `namespace ${POSTGRES_SAFE_TEXT_MESSAGE}` });
export const ScopeSchema = z.string().min(1).max(63)
  .refine((s) => !hasPostgresUnsafeText(s), { message: `scope ${POSTGRES_SAFE_TEXT_MESSAGE}` });
export const KeySchema = z.string().min(1)
  .refine((s) => !hasPostgresUnsafeText(s), { message: `key ${POSTGRES_SAFE_TEXT_MESSAGE}` });
export type Namespace = z.infer<typeof NamespaceSchema>;
export type Scope = z.infer<typeof ScopeSchema>;
export type Key = z.infer<typeof KeySchema>;

/** Postgres's `bigint` column type is a signed 64-bit integer; a JS `bigint` has no such
 *  ceiling, so without this bound a value outside Postgres's representable range would pass
 *  Zod validation and then fail at the driver as a raw error instead of `ValidationError`. */
const POSTGRES_BIGINT_MAX = 9223372036854775807n;

/** Monotonic logical version, scoped to a single (namespace, scope, key) triple. A STORED
 *  version is always >= 1 (versions start at 1); `0n` is meaningful only as the sentinel value
 *  of `put`'s `expectedVersion` option ("this key must not already exist") and never appears as
 *  a stored/observed version — these are deliberately two different schemas below, not one
 *  reused type, so a stored `0n` can never round-trip as if it were valid. */
export type Version = bigint;
export const StoredVersionSchema = z.bigint().positive().max(POSTGRES_BIGINT_MAX);
export const ExpectedVersionSchema = z.bigint().nonnegative().max(POSTGRES_BIGINT_MAX);

/** Runtime schema for the erased shape of {@link VersionedEntry} — validated on every read
 *  boundary. The generic interface below is a deliberate exception to "derive the type from the
 *  schema": `z.infer` cannot express the type parameter, so it is hand-written, but pinned to
 *  this schema by the compile-time guard that follows it. */
export const VersionedEntrySchema = z.object({
  namespace: NamespaceSchema,
  scope: ScopeSchema,
  key: KeySchema,
  value: JsonValueSchema,
  version: StoredVersionSchema,
  writtenAt: z.date(),
});

/** A single versioned record as returned by reads. */
export interface VersionedEntry<T extends JsonValue = JsonValue> {
  readonly namespace: Namespace;
  readonly scope: Scope;
  readonly key: Key;
  readonly value: T;
  readonly version: Version;
  readonly writtenAt: Date;
}

// Compile-time sync guard: a real mutual-assignability check, not the previous
// `extends ? true : never` pattern (which silently resolves to `never` without ever failing
// compilation — an alias of `never` is not a type error). This form actually fails to compile
// if either type gains/loses a field the other lacks.
type AssertExact<A, B> = A extends B ? (B extends A ? true : ["schema drifted from interface", B]) : ["interface drifted from schema", A];
type _VersionedEntryInSync = AssertExact<z.infer<typeof VersionedEntrySchema>, VersionedEntry> extends true ? true : never;
const _versionedEntrySyncCheck: _VersionedEntryInSync = true;
void _versionedEntrySyncCheck;

/**
 * Point-in-time selector for {@link TemporalKV.getAt}. A real discriminated union (not a loose
 * structural union of two optional-looking shapes) — exactly one of `version`/`at` is present,
 * enforced by the `kind` discriminant, so a value naming both (or neither) is a type error, not
 * a runtime ambiguity.
 *
 * `{kind: "version"}` addresses the store's own logical clock (cheap on both backends).
 * `{kind: "at"}` addresses the successfully persisted `writtenAt` coordinate. Given strict
 * same-key timestamp increase and the one-`put`-per-key-per-transaction rule, every committed
 * version has a distinct recorded write timestamp, so the two addressing schemes agree there
 * (Law T4). The coordinate is `clock_timestamp()` at statement/trigger execution, not a true
 * transaction commit or visibility timestamp; commit-time refinement remains a separate
 * obligation.
 */
export type AsOf =
  | { readonly kind: "version"; readonly version: Version }
  | { readonly kind: "at"; readonly at: Date };

export type TemporalKVErrorCode = "VERSION_CONFLICT" | "HISTORY_UNAVAILABLE" | "TRANSACTION_KEY_REUSE";

/** Base class for TemporalKV's domain failures. Infrastructure failures — connection loss,
 *  encoding round-trip failure, boundary validation — surface as the shared
 *  {@link ConnectionError} / {@link SerializationFailedError} / {@link ValidationError}, not
 *  module-local copies. Note: absence of a key is NOT modeled here — `get`/`getAt` return
 *  `null`, per the storage-layer-wide "lookup vs. load" convention. */
export abstract class TemporalKVError extends StorageError {
  abstract readonly code: TemporalKVErrorCode;
}

/** Thrown by {@link TemporalKV.put} when `expectedVersion` doesn't match the current version.
 *  `actual` is `undefined` when the key has never been written at all — i.e. the CAS failed
 *  because a nonzero `expectedVersion` was passed for a missing key. `actual === 0n` never
 *  occurs (versions start at 1); the two cases are not conflated. */
export class VersionConflictError extends TemporalKVError {
  readonly code = "VERSION_CONFLICT" as const;
  constructor(readonly expected: Version, readonly actual: Version | undefined) {
    super(`expected version ${expected}, found ${actual ?? "none (key never written)"}`);
  }
}

/**
 * Thrown by {@link TemporalKV.getAt} when `asOf` names a point in time (or version) older than
 * this store's retention floor — i.e. history that once existed but has since been pruned.
 * This is DELIBERATELY distinct from returning `null`: `null` means "this key had no value yet
 * at the requested point," while `HistoryUnavailableError` means "this key may well have had a
 * value there, but the record proving it has been deleted and the true answer is no longer
 * knowable." Conflating these was a real bug found by review — a caller must be able to tell
 * "never existed" from "existed, but we can't prove it anymore." Sprint 1 performs no
 * retention at all (see the Sprint 1 openspec change), so this error cannot yet be thrown by
 * any implementation that ships before a retention mechanism (`pg_cron` or partitioning) lands
 * — but the error type must exist now so retention can be added later without a breaking
 * interface change.
 */
export class HistoryUnavailableError extends TemporalKVError {
  readonly code = "HISTORY_UNAVAILABLE" as const;
  constructor(
    readonly requested: AsOf,
    readonly oldestAvailableAt: Date,
    readonly oldestAvailableVersion: Version,
  ) {
    super(`history for this key is unavailable before ${oldestAvailableAt.toISOString()} (oldest retained version: ${oldestAvailableVersion})`);
  }
}

/**
 * Thrown by {@link TemporalKV.put} when it is the SECOND `put` to the same (namespace, scope,
 * key) within one transaction (`opts.tx`). See this file's top-level doc comment for why this
 * is forbidden rather than merely discouraged: Postgres's `now()` is fixed for the whole
 * transaction, so a same-transaction second write cannot be given a distinct, well-defined
 * recorded write timestamp, and the adapter's trigger detects and rejects it rather than silently
 * discarding the first write's history row (the bug this rule replaces). Detection is
 * transaction-scoped (keyed off the writing transaction's ID, not a timestamp comparison), so
 * this SPECIFIC error can only be thrown when both writes share one transaction — sequential
 * `put`s in separate transactions never throw `TransactionKeyReuseError`, no matter how close
 * together in wall-clock time. **This does not mean separate-transaction sequential writes are
 * unconditionally unaffected by ANY error, though** — corrected after a cross-vendor re-audit
 * found this comment's original, broader phrasing contradicted the documented
 * `ClockRegressionError` caveat: a Postgres adapter using `clock_timestamp()`-derived,
 * millisecond-truncated instants can still reject a genuinely separate-transaction second write
 * with `ClockRegressionError` if both writes' truncated instants land in the same millisecond
 * (see that error's own doc, and `Formal/STORAGE_ALGEBRA.md` §1's Law T4 caveat) — a different
 * failure mode than the one this class documents, not ruled out by anything said here.
 */
export class TransactionKeyReuseError extends TemporalKVError {
  readonly code = "TRANSACTION_KEY_REUSE" as const;
  constructor(readonly namespace: Namespace, readonly scope: Scope, readonly key: Key) {
    super(`key already written earlier in this transaction: ${namespace}/${scope}/${key} (at most one put per key per transaction is allowed)`);
  }
}

export interface TemporalKV {
  /**
   * Writes `value` for (namespace, scope, key), creating a new version. At most one `put` to
   * a given key may occur within a single transaction (`opts.tx`) — see this file's top-level
   * doc comment; a second `put` to the same key in the same transaction is rejected.
   * `opts.expectedVersion` is an optimistic-concurrency guard: omit for an unconditional write,
   * pass the last-read version to CAS, or `0n` to require the key not already exist.
   * @throws {ValidationError} if inputs fail their boundary schemas.
   * @throws {VersionConflictError} if `expectedVersion` is stale.
   * @throws {TransactionKeyReuseError} if `opts.tx` names a transaction that already wrote
   *   this same key once.
   * @throws {SerializationFailedError} if `value` cannot be round-tripped.
   * @throws {ConnectionError} on driver-level failure.
   * @throws Rejects with `AbortError`, WITHOUT issuing any query, if `opts.signal` is already
   *   aborted when this is called. **Revised after a cross-vendor audit found the original
   *   wording ("aborts before the write completes") ambiguous in exactly the way that broke
   *   an implementation**: it does NOT mean an abort can interrupt an in-flight write.
   *   Cancelling an already-dispatched database operation requires backend-specific
   *   infrastructure (e.g. a dedicated `pg_cancel_backend()` connection tracking the query's
   *   backend PID) that this interface does not require implementations to provide — an abort
   *   that fires AFTER the call has already started has NO effect on that call; it neither
   *   rejects early nor prevents the write from completing and being committed. Racing a live
   *   operation against abort and rejecting with `AbortError` while the write still commits
   *   moments later is explicitly the failure mode this revision rules out, since a caller
   *   that sees `AbortError` must be able to trust the operation never started.
   */
  put<T extends JsonValue>(
    namespace: Namespace, scope: Scope, key: Key, value: T,
    opts?: { expectedVersion?: Version; tx?: TransactionHandle; signal?: AbortSignal },
  ): Promise<VersionedEntry<T>>;

  /**
   * Latest version of a key, or `null` if it has never been written.
   * @throws Rejects with `AbortError`, without issuing any query, if `opts.signal` is already
   *   aborted when this is called — see `put`'s doc for why this does not extend to
   *   interrupting an already-dispatched read.
   */
  get<T extends JsonValue = JsonValue>(
    namespace: Namespace, scope: Scope, key: Key,
    opts?: { tx?: TransactionHandle; signal?: AbortSignal },
  ): Promise<VersionedEntry<T> | null>;

  /**
   * The version of a key as of `asOf`, or `null` if none existed yet at that point (see
   * {@link AsOf}'s doc for the index/instant each variant requires of implementations).
   * @throws {HistoryUnavailableError} if `asOf` names a point older than this store's
   *   retention floor — distinct from `null`, see that error's own doc.
   * @throws Rejects with `AbortError`, without issuing any query, if `opts.signal` is already
   *   aborted when this is called — see `put`'s doc for why this does not extend to
   *   interrupting an already-dispatched read.
   */
  getAt<T extends JsonValue = JsonValue>(
    namespace: Namespace, scope: Scope, key: Key, asOf: AsOf,
    opts?: { tx?: TransactionHandle; signal?: AbortSignal },
  ): Promise<VersionedEntry<T> | null>;

  /** Streams keys under `prefix`, newest-version-only, in a stable order for resumable
   *  pagination. In-process iteration (a database cursor, batches flattened to individual
   *  keys) — not a network-paginated cursor. `prefix` is matched as a literal string prefix;
   *  implementations MUST NOT interpret pattern-matching metacharacters in it (Postgres `LIKE`
   *  semantics treat `%`/`_`/`\` specially — a naive `LIKE prefix || '%'` would let a `%` or `_`
   *  inside a caller's prefix change what matches; implementations must escape them or use a
   *  non-pattern-based range comparison instead).
   * @throws Aborting `opts.signal` stops iteration and frees the underlying cursor, rejecting
   *   the in-progress iteration with `AbortError` — ending the async generator's loop via a
   *   plain `break` (which completes the iteration successfully) does NOT satisfy this
   *   contract; the abort must surface as a rejection. This applies even while a batch fetch
   *   is blocked waiting on the underlying connection, not only between already-arrived
   *   batches. (Standard async-iterator limitation, not specific to this method: if the
   *   consumer stops calling `.next()` entirely without an explicit `break`/`.return()`, this
   *   generator's body is simply not running any code to notice an abort — implementations are
   *   not required to solve that case, only the case where the consumer keeps consuming.)
   */
  listKeys(
    namespace: Namespace, scope: Scope, prefix: string,
    opts?: { tx?: TransactionHandle; signal?: AbortSignal },
  ): AsyncIterable<Key>;
}
