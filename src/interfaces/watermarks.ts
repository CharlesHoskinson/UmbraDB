import { z } from "zod";
import { JsonValueSchema, type JsonValue } from "./temporal-kv.js";
import type { TransactionHandle } from "./transaction-lease.js";

/**
 * Watermarks: durable sync-progress cursors. Tracks how far an external sync process
 * (indexer, wallet scan, chain follower) has progressed, keyed by an arbitrary (kind, key)
 * pair. Deliberately has no history/versioning (see TemporalKV) and no built-in concurrency
 * control (compose with the Lease layer if CAS semantics are needed) — it is a plain
 * last-write-wins cursor store.
 *
 * This module defines no error hierarchy of its own: its only failure modes are the shared
 * infrastructure errors (§2) — {@link ConnectionError} on driver failure,
 * {@link ValidationError} when a value fails {@link WatermarkValueSchema} at the boundary,
 * {@link SerializationFailedError} if a value fails the JSONB round-trip.
 */

/** Namespaces independent watermark cursors, e.g. one per sync-process type. */
export type WatermarkKind = string;

/** Identifies a specific cursor within a kind, e.g. a network id or wallet id. */
export type WatermarkKey = string;

/** Opaque progress value, stored as JSONB. Callers agree on shape per kind: a block height,
 *  byte offset, or composite cursor object. Schema-first per §1.4 — the type is derived,
 *  not hand-duplicated.
 *
 *  REVISED after review found the original `z.union([z.string(), z.number(),
 *  z.record(z.string(), z.unknown())])` unsound: `z.unknown()` record values admit anything —
 *  `bigint`, `undefined`, `Date`, functions, class instances — none of which round-trip through
 *  JSONB losslessly, so a value could pass validation on `set()` and come back a different
 *  shape (or throw in the JSONB encoder) on `get()`. Reusing the shared, already-audited
 *  {@link JsonValueSchema} from `temporal-kv.ts` (rather than a second hand-rolled definition)
 *  guarantees the same lossless-round-trip property this store's sibling interface already
 *  relies on, and a top-level bare string/number is still valid JSON so no existing use case
 *  narrows.
 *
 *  **Large-integer convention (added, Sprint 4 — `openspec/changes/sprint-4-watermarks/design.md`
 *  §4): a cursor value that could ever exceed `Number.MAX_SAFE_INTEGER` MUST be encoded as a
 *  decimal string, not a bare JSON number.** Postgres stores a JSONB number as an
 *  arbitrary-precision `numeric` internally and preserves it exactly, but the JS driver's
 *  `JSON.parse` on read silently loses precision beyond `2^53 - 1` (RFC 8259 §6) — with no error,
 *  no warning, and no defense from this schema (a `bigint` is rejected here, but a plain
 *  out-of-safe-range `number` is not, since JS cannot even represent the distinction once the
 *  literal has been parsed). A block-height or byte-offset cursor for a sufficiently long-running
 *  sync could hit this silently. Mirrors Ethereum's own JSON-RPC "Quantities" convention
 *  (`ethereum.org`), which hex/decimal-string-encodes every quantity for the identical reason.
 *  This is a documented caller convention, not a schema-level restriction — deliberately: this
 *  schema is shared with `TemporalKV`, and narrowing it to reject large numbers would change that
 *  module's own already-implemented contract as a side effect. */
export const WatermarkValueSchema = JsonValueSchema;
export type WatermarkValue = JsonValue;

export interface Watermarks {
  /**
   * Upserts the watermark for (kind, key) to `value`. Last write wins; callers needing
   * monotonicity or compare-and-set must guard the call (e.g. hold a writer lease) themselves.
   * `T` lets a caller pin the cursor shape they use for a given kind — it narrows within
   * {@link WatermarkValue}; runtime validation checks the erased shape only.
   * @throws {ValidationError} if `value` fails {@link WatermarkValueSchema}.
   * @throws {ConnectionError} on driver-level failure.
   */
  set<T extends WatermarkValue>(
    kind: WatermarkKind, key: WatermarkKey, value: T,
    opts?: { tx?: TransactionHandle; signal?: AbortSignal },
  ): Promise<void>;

  /**
   * Returns the current watermark for (kind, key), or `undefined` if none has ever been set.
   * Never throws for a missing cursor (§1.1). `T` is a caller assertion, exactly like
   * `TemporalKV.get<T>` — the runtime validates only the erased {@link WatermarkValue} shape,
   * so a caller who writes one shape and reads another gets a type lie, not a runtime error.
   */
  get<T extends WatermarkValue = WatermarkValue>(
    kind: WatermarkKind, key: WatermarkKey,
    opts?: { tx?: TransactionHandle; signal?: AbortSignal },
  ): Promise<T | undefined>;
}
