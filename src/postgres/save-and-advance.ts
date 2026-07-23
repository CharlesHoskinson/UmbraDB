import type { CheckpointStore, CheckpointSummary } from "../interfaces/checkpoint-store.js";
import type { TransactionLeaseLayer } from "../interfaces/transaction-lease.js";
import type {
  WatermarkKey,
  WatermarkKind,
  Watermarks,
  WatermarkValue,
} from "../interfaces/watermarks.js";

/**
 * `saveAndAdvance` — the co-transactional composition primitive for the durable-composition
 * capability (`openspec/changes/v1.0.0-durable-checkpoint-cursor`, requirement "saveAndAdvance
 * co-commits a checkpoint and its sync cursor atomically", `design.md` §1.3).
 *
 * `CheckpointStore` has no knowledge of `Watermarks`, so this combinator lives outside
 * `PgCheckpointStore`: it takes the checkpoint store, the watermarks store, and the transaction
 * layer, opens ONE transaction, calls `checkpoints.save(..., { tx })` and then
 * `watermarks.set(..., { tx })` on the same handle, and commits both together. A crash before that
 * single COMMIT leaves neither the checkpoint nor the cursor durable — so the cursor can never be
 * made durable while the checkpoint data it describes is not (never "ahead of its data").
 *
 * Composes only in-repo primitives and imports nothing from any consumer/indexer application,
 * honouring the indexer-agnostic boundary (guideline §0.3; acceptance A8).
 *
 * NOTE: this primitive is intentionally not yet re-exported from any barrel/`exports`; its exact
 * public signature is finalised by the api-surface change (G1). Kept usable and internally clean
 * here without freezing the exported shape.
 */

/** The in-repo primitives `saveAndAdvance` composes. */
export interface SaveAndAdvanceDeps {
  checkpoints: CheckpointStore;
  watermarks: Watermarks;
  txLayer: TransactionLeaseLayer;
}

/** The sync cursor to advance in the same transaction as the checkpoint write. */
export interface SaveAndAdvanceCursor {
  kind: WatermarkKind;
  key: WatermarkKey;
  value: WatermarkValue;
}

/**
 * Persists `data` as a checkpoint for `(walletId, networkId)` and advances `cursor` to
 * `cursor.value` within a single database transaction, returning the checkpoint's summary.
 *
 * Either both become durable at the one commit, or — on any failure before that commit — neither
 * does, and the previously durable cursor still points at previously durable checkpoint data.
 *
 * @throws {ValidationError} if `opts`/`cursor.value` fail their schemas (rejects inside the
 *   transaction, which then rolls back, before the commit).
 * @throws {TransactionHandleInvalidError} never in normal use — the handle is this call's own
 *   live transaction; documented for completeness with the `save`/`set` contracts.
 */
export async function saveAndAdvance(
  deps: SaveAndAdvanceDeps,
  walletId: string,
  networkId: string,
  data: Uint8Array,
  cursor: SaveAndAdvanceCursor,
  opts?: { chunkSize?: number; label?: string; signal?: AbortSignal },
): Promise<CheckpointSummary> {
  return deps.txLayer.withTransaction(async (tx) => {
    const summary = await deps.checkpoints.save(walletId, networkId, data, { ...opts, tx });
    await deps.watermarks.set(cursor.kind, cursor.key, cursor.value, { tx, signal: opts?.signal });
    return summary;
  });
}
