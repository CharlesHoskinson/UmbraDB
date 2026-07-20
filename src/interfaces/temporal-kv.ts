import { z } from "zod";
import {
  ConnectionError, SerializationFailedError, StorageError, ValidationError,
} from "./storage-errors.js";
import type { TransactionHandle } from "./transaction-lease.js";

/**
 * A JSON-serializable value — the only value shape TemporalKV accepts, since both the
 * Postgres JSONB and Mongo BSON backends must round-trip it losslessly.
 * Schema-first per §1.4: `z.json()` is Zod v4's built-in recursive JSON-value schema, and the
 * type is derived from it — there is no hand-written duplicate.
 */
export const JsonValueSchema = z.json();
export type JsonValue = z.infer<typeof JsonValueSchema>;

export type Namespace = string;
export type Scope = string;
export type Key = string;

/** Monotonic logical version, scoped to a single (namespace, scope, key) triple. */
export type Version = bigint;

/** Runtime schema for the erased shape of {@link VersionedEntry} — validated on every read
 *  boundary. The generic interface below is the §1.4 "generic exception": hand-written because
 *  `z.infer` cannot express the type parameter, but pinned to this schema by the compile-time
 *  guard that follows it. */
export const VersionedEntrySchema = z.object({
  namespace: z.string().min(1).max(63),
  scope: z.string().min(1).max(63),
  key: z.string().min(1),
  value: JsonValueSchema,
  version: z.bigint().nonnegative(),
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

// Compile-time sync guard (§1.4): fails to typecheck if schema and interface drift apart.
type _VersionedEntryInSync =
  z.infer<typeof VersionedEntrySchema> extends VersionedEntry ? true : never;

/**
 * Point-in-time selector for {@link TemporalKV.getAt}. `version` addresses the store's own
 * logical clock (cheap on both backends). `at` addresses wall-clock time — implementations
 * MUST maintain a per-record wall-clock validity interval with a supporting index (Postgres:
 * a `[valid_from, valid_to)` tstzrange column with a GiST index, distinct from the version
 * interval; Mongo: a revision-timestamp index) so that resolving `{ at }` is an index lookup,
 * never a sequential scan over history.
 */
export type AsOf = { readonly version: Version } | { readonly at: Date };

export type TemporalKVErrorCode = "VERSION_CONFLICT";

/** Base class for TemporalKV's domain failures. Infrastructure failures — connection loss,
 *  encoding round-trip failure, boundary validation — surface as the shared
 *  {@link ConnectionError} / {@link SerializationFailedError} / {@link ValidationError}
 *  (§1.1), not module-local copies. Note: absence of a key is NOT modeled here — `get`/`getAt`
 *  return `null`, per the storage-layer-wide "lookup vs. load" convention (§1.1). */
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

export interface TemporalKV {
  /**
   * Writes `value` for (namespace, scope, key), creating a new version.
   *
   * `opts.expectedVersion` is an optimistic-concurrency guard: omit for an unconditional
   * write, pass the last-read version to CAS, or `0n` to require the key not already exist.
   * @throws {ValidationError} if inputs fail their boundary schemas.
   * @throws {VersionConflictError} if `expectedVersion` is stale.
   * @throws {SerializationFailedError} if `value` cannot be round-tripped.
   * @throws {ConnectionError} on driver-level failure.
   */
  put<T extends JsonValue>(
    namespace: Namespace, scope: Scope, key: Key, value: T,
    opts?: { expectedVersion?: Version; tx?: TransactionHandle; signal?: AbortSignal },
  ): Promise<VersionedEntry<T>>;

  /** Latest version of a key, or `null` if it has never been written. */
  get<T extends JsonValue = JsonValue>(
    namespace: Namespace, scope: Scope, key: Key,
    opts?: { tx?: TransactionHandle; signal?: AbortSignal },
  ): Promise<VersionedEntry<T> | null>;

  /** The version of a key as of `asOf`, or `null` if none existed yet at that point.
   *  See {@link AsOf} for the index the `{ at }` variant requires of implementations. */
  getAt<T extends JsonValue = JsonValue>(
    namespace: Namespace, scope: Scope, key: Key, asOf: AsOf,
    opts?: { tx?: TransactionHandle; signal?: AbortSignal },
  ): Promise<VersionedEntry<T> | null>;

  /** Streams keys under `prefix`, newest-version-only, in a stable order for resumable
   *  pagination. In-process iteration (§1.2) — not a network-paginated cursor. Aborting
   *  `opts.signal` stops iteration and frees the underlying cursor (§1.2). */
  listKeys(
    namespace: Namespace, scope: Scope, prefix: string,
    opts?: { tx?: TransactionHandle; signal?: AbortSignal },
  ): AsyncIterable<Key>;
}
