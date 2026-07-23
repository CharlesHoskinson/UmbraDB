import { z } from "zod";
import { StorageError, ValidationError } from "./storage-errors.js";
import type { TransactionHandle } from "./transaction-lease.js";

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
  /**
   * An in-flight transaction handle (from {@link TransactionLeaseLayer.withTransaction}) to run
   * this `save` inside. When supplied, `save` issues every one of its statements on that
   * transaction instead of opening its own, so the checkpoint commits or rolls back atomically
   * with everything else the caller wrote in it (co-transactional composition — see
   * {@link CheckpointStore.save}). A live handle, like `signal`, is intersected on rather than
   * declared in {@link SaveCheckpointOptionsSchema}: it is not a serialisable data field.
   */
  tx?: TransactionHandle;
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

/**
 * A summary plus the reconstructed payload. There is deliberately no `integrityVerified`
 * field: `load()` always fully rehashes and verifies every chunk before returning (see its
 * `@throws`), so a `CheckpointRecord` in hand has, by construction, already passed integrity
 * verification — an `integrityVerified: false` value could never actually be observed, and a
 * review found that dead, always-true field misleading rather than informative. If a caller
 * needs to distinguish "verified now" from "verified when originally loaded," that is a
 * caching concern for the caller, not a property of this type.
 */
export interface CheckpointRecord extends CheckpointSummary {
  data: Uint8Array;
}

export interface PruneResult {
  prunedSequences: CheckpointSequence[];
  /**
   * Chunks physically deleted BY THIS CALL. `prune` checks for reclaimable chunks
   * synchronously, in the same internal transaction as the manifest deletion (so the safety
   * side — never deleting a chunk a live manifest still references, `Formal/STORAGE_ALGEBRA.md`
   * §2 Law C2a — holds unconditionally, at every instant) — but this count is NOT everything
   * that just became unreferenced. A chunk only appears here if it ALSO clears this store's
   * grace-window age check (an intentional TOCTOU guard, see the interface doc above and
   * `design/design.md` §3's grace-window `DELETE`): a chunk that lost its last reference in
   * this very call, but was created too recently to have aged past the grace window, is left
   * in place and will only show up in `reclaimedChunks`/`reclaimedBytes` on a LATER `prune`
   * call made after the window elapses (Law C2b, "eventual collection," is explicitly
   * conditional on a later GC pass actually running — do not read a zero or low count here as
   * proof nothing became unreferenced). Chunk storage is globally content-addressed and
   * shared, so a chunk still referenced by another wallet's manifest is never reclaimed either,
   * for an unrelated reason — and this count can be zero even when many checkpoints were
   * pruned, for either reason.
   */
  reclaimedChunks: number;
  reclaimedBytes: number;
}

export type CheckpointStoreErrorCode = "NOT_FOUND" | "CHUNK_MISSING" | "CHUNK_INTEGRITY" | "MANIFEST_CORRUPT";

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

/** A chunk hash listed in the manifest has no corresponding row in chunk storage at all —
 *  distinct from {@link ChunkIntegrityError} (chunk present, content wrong). This can only mean
 *  the chunk was reclaimed while still referenced (a garbage-collection bug) or the store was
 *  corrupted out-of-band; it is never a normal, expected outcome. */
export class ChunkMissingError extends CheckpointStoreError {
  readonly code = "CHUNK_MISSING" as const;
  constructor(readonly chunkHash: ContentHash) {
    super("chunk referenced by manifest is missing from chunk storage");
  }
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
 * Each method is an atomic unit of work. With no `opts.tx`, implementations compose the
 * Transaction/Lease layer internally to make manifest + chunk writes all-or-nothing. `save`
 * additionally accepts an `opts.tx` transaction handle so a caller can compose the checkpoint
 * write into a larger transaction (e.g. co-committing a checkpoint and its sync cursor via
 * `saveAndAdvance`); on that path it issues no `BEGIN`/`COMMIT` of its own and joins the caller's
 * transaction instead. `prune`/`load`/`history` remain internal-transaction-only.
 */
export interface CheckpointStore {
  /**
   * With no `opts.tx`, opens and commits its own internal transaction. With `opts.tx`, issues
   * every statement on the caller's transaction — the checkpoint then commits or rolls back
   * atomically with everything else in that transaction.
   * @throws {ValidationError} if `opts` fails {@link SaveCheckpointOptionsSchema} — rejects
   *   before any chunking/hashing work happens.
   * @throws {TransactionHandleInvalidError} if `opts.tx` is supplied but does not resolve to a
   *   live transaction (reused after its transaction ended, or fabricated) — rejects before any
   *   statement is issued.
   */
  save(walletId: string, networkId: string, data: Uint8Array, opts?: SaveCheckpointOptions): Promise<CheckpointSummary>;

  /**
   * Omit `sequence` for the latest checkpoint. Always fully rehashes and verifies every chunk
   * before returning — see {@link CheckpointRecord}'s doc for why the return type has no
   * separate `integrityVerified` flag.
   * @throws {CheckpointNotFoundError} if no checkpoint exists (or `sequence` doesn't).
   * @throws {ChunkMissingError} if a chunk hash listed in the manifest has no corresponding
   *   row in chunk storage at all.
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
