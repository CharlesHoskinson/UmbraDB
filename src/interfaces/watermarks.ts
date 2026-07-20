import { z } from "zod";
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
 *  not hand-duplicated. */
export const WatermarkValueSchema = z.union([
  z.string(), z.number(), z.record(z.string(), z.unknown()),
]);
export type WatermarkValue = z.infer<typeof WatermarkValueSchema>;

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
