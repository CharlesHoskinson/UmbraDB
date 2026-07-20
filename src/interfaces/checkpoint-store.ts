import { z } from "zod";
import { StorageError, ValidationError } from "./storage-errors.js";

/** Sequence numbers are monotonic per (walletId, networkId) and start at 1. */
export type CheckpointSequence = number;

/** SHA-256 hex digest of a chunk or manifest's canonical byte content. */
export type ContentHash = string;

export const SaveCheckpointOptionsSchema = z.object({
  /** Target chunk size in bytes; implementations may round up to their own boundary. */
  chunkSize: z.number().int().positive().max(16 * 1024 * 1024).optional(),
  /** Free-text label surfaced in history(), e.g. "pre-migration". */
  label: z.string().max(200).optional(),
});
export type SaveCheckpointOptions = z.infer<typeof SaveCheckpointOptionsSchema> & {
  signal?: AbortSignal;
};

export const HistoryOptionsSchema = z.object({
  limit: z.number().int().positive().max(1000).default(50),
  /** Return only checkpoints strictly older than this sequence (cursor paging). */
  before: z.number().int().positive().optional(),
});
export type HistoryOptions = z.infer<typeof HistoryOptionsSchema> & {
  signal?: AbortSignal;
};

/** Identity + integrity metadata for a saved checkpoint, without its payload. */
export interface CheckpointSummary {
  sequence: CheckpointSequence;
  manifestHash: ContentHash;
  byteLength: number;
  chunkCount: number;
  label?: string;
  createdAt: Date;
}

/** A summary plus the reconstructed payload. */
export interface CheckpointRecord extends CheckpointSummary {
  data: Uint8Array;
  /** True if every chunk's rehashed content matched its manifest entry. */
  integrityVerified: boolean;
}

export interface PruneResult {
  prunedSequences: CheckpointSequence[];
  /** Chunks physically deleted because this prune removed their last remaining reference
   *  anywhere in the store — across ALL wallets and networks, not just this one. Chunk
   *  storage is globally content-addressed and shared (see interface doc), so a chunk still
   *  referenced by another wallet's manifest is never reclaimed, and this count can be zero
   *  even when many checkpoints were pruned. */
  reclaimedChunks: number;
  reclaimedBytes: number;
}

export type CheckpointStoreErrorCode = "NOT_FOUND" | "CHUNK_INTEGRITY" | "MANIFEST_CORRUPT";

export abstract class CheckpointStoreError extends StorageError {
  abstract readonly code: CheckpointStoreErrorCode;
}

/** Thrown by {@link CheckpointStore.load} — the one method in this storage layer where
 *  absence is an error rather than a `null` return; see §1.1's "lookup vs. load" rule. */
export class CheckpointNotFoundError extends CheckpointStoreError {
  readonly code = "NOT_FOUND" as const;
  constructor(
    readonly walletId: string,
    readonly networkId: string,
    readonly sequence?: number,
  ) { super("checkpoint not found"); }
}

/** A chunk's rehashed content didn't match its manifest entry. */
export class ChunkIntegrityError extends CheckpointStoreError {
  readonly code = "CHUNK_INTEGRITY" as const;
  constructor(readonly chunkHash: ContentHash, readonly expectedHash: ContentHash) {
    super("chunk hash mismatch");
  }
}

/** The manifest itself failed its own shape/hash validation. */
export class ManifestCorruptError extends CheckpointStoreError {
  readonly code = "MANIFEST_CORRUPT" as const;
  constructor(readonly manifestHash: ContentHash, readonly reason: string) {
    super(`manifest corrupt: ${reason}`);
  }
}

/**
 * Content-addressed, chunked persistence for large periodic snapshots (e.g. wallet sync
 * state). `save()` splits `data` into fixed-size chunks, writes each chunk once keyed by its
 * own content hash — chunk storage is a single GLOBAL pool, deduplicating against every prior
 * checkpoint for the same wallet+network and across wallets — then writes an immutable
 * manifest (the ordered chunk-hash list) under the next sequence number.
 *
 * Because chunks are shared across wallets, chunk garbage collection is necessarily global:
 * implementations MUST maintain a per-chunk reference count (or perform a full cross-manifest
 * reference scan) and may physically delete a chunk only when no manifest anywhere in the
 * store references it. The refcount update/scan runs in the same internal transaction as the
 * manifest write or deletion, so a concurrent `save` in another wallet can never resurrect a
 * reference to a chunk mid-reclamation.
 *
 * Each method is an atomic unit of work; implementations compose the Transaction/Lease layer
 * internally to make manifest + chunk writes all-or-nothing. That plumbing never appears in
 * this interface — `save`/`prune` deliberately do NOT accept a `tx` option (§1.3).
 */
export interface CheckpointStore {
  /**
   * @throws {ValidationError} if `opts` fails {@link SaveCheckpointOptionsSchema} — rejects
   *   before any chunking/hashing work happens.
   */
  save(walletId: string, networkId: string, data: Uint8Array, opts?: SaveCheckpointOptions): Promise<CheckpointSummary>;

  /**
   * Omit `sequence` for the latest checkpoint.
   * @throws {CheckpointNotFoundError} if no checkpoint exists (or `sequence` doesn't).
   * @throws {ChunkIntegrityError} if a chunk's rehash doesn't match its manifest entry.
   * @throws {ManifestCorruptError} if the manifest itself fails validation.
   */
  load(
    walletId: string, networkId: string, sequence?: CheckpointSequence,
    opts?: { signal?: AbortSignal },
  ): Promise<CheckpointRecord>;

  /** Newest-first, bounded by `opts.limit`; use `opts.before` to page further back. */
  history(walletId: string, networkId: string, opts?: HistoryOptions): Promise<CheckpointSummary[]>;

  /**
   * Deletes all but the `retainCount` newest checkpoints (manifests) for this wallet+network,
   * then reclaims any chunk whose GLOBAL reference count dropped to zero as a result. The
   * checkpoint selection is wallet+network-scoped; the chunk reclamation decision never is —
   * see the interface doc above.
   */
  prune(
    walletId: string, networkId: string, retainCount: number,
    opts?: { signal?: AbortSignal },
  ): Promise<PruneResult>;
}
