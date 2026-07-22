import { z } from "zod";
import { StorageError } from "./storage-errors.js";

/**
 * The Tier-1.5 chain-archive storage interface (`design/full-chain-storage-design.md`,
 * `src/postgres/migrations/chain_archive/001_chain_archive_core.ts`). Mirrors this repo's
 * established interface/implementation split (`src/interfaces/checkpoint-store.ts` +
 * `src/postgres/checkpoint-store.ts`): this file declares the storage contract only -- no
 * `postgres` import, no SQL, no node-RPC/indexer-GraphQL awareness. `src/postgres/
 * chain-archive-store.ts` is the one Postgres implementation; the real ingestion/sync service
 * that talks to a Midnight node/indexer lives entirely outside `src/` (`chain-archive-sync/`,
 * AC-7) and depends on THIS interface, never on the Postgres implementation's internals.
 *
 * Deliberately narrower than the full `chain_archive` schema: `bridge_observations` and
 * `verifier_key_observations` get minimal write-only support (a "stub/initial pass" per the
 * implementation task) since this devnet's ingestion of those categories is genuinely a first
 * pass, not a fully round-tripped read/query surface yet.
 */

/** Lowercase 64-char hex encoding of a 32-byte hash -- every hash column in this schema
 *  (`block_hash`, `parent_hash`, `state_root`, `extrinsics_root`, `tx_hash`, blob `hash`,
 *  `vk_hash`, `author`) is exactly 32 bytes; this type documents that shape at the interface
 *  boundary instead of leaving every caller to independently remember it. */
export type Hex32 = string;
export const Hex32Schema = z.string().regex(/^[0-9a-f]{64}$/, "expected 64 lowercase hex chars (32 bytes)");

export type BlobRole =
  | "block_header" | "block_body" | "tx_raw" | "proof" | "verifier_key" | "bridge_observation";

export type BlockStatus = "seen" | "canonical" | "orphaned" | "pruned";

/** One block, as archived. `headerBytes`/`bodyBytes` are the raw content-addressed payload
 *  (stored in `chain_blobs`, classified via `chain_blob_roles`); every other field is the
 *  queryable metadata column set in `blocks`. */
export interface BlockRecord {
  net: string;
  blockHash: Hex32;
  height: number;
  parentHash: Hex32;
  stateRoot: Hex32;
  extrinsicsRoot: Hex32;
  author?: Hex32;
  headerBytes: Uint8Array;
  bodyBytes?: Uint8Array;
  isCanonical: boolean;
  status: BlockStatus;
  finalized: boolean;
}

/** Metadata-only projection of `BlockRecord` returned by read paths -- raw bytes are fetched
 *  separately via {@link ChainArchiveStore.getBlob}, matching the schema's own metadata/blob
 *  split (`design/full-chain-storage-design.md` §4.1). */
export interface BlockMeta {
  net: string;
  blockHash: Hex32;
  height: number;
  parentHash: Hex32;
  stateRoot: Hex32;
  extrinsicsRoot: Hex32;
  author?: Hex32;
  headerBlobHash: Hex32;
  bodyBlobHash?: Hex32;
  isCanonical: boolean;
  status: BlockStatus;
  finalized: boolean;
}

export type TransactionKind = "regular" | "system";
export type TransactionResult = "success" | "partial_success" | "failure";

export interface TransactionRecord {
  net: string;
  txHash: Hex32;
  blockHeight: number;
  blockHash: Hex32;
  position: number;
  kind: TransactionKind;
  protocolVersion: number;
  result?: TransactionResult;
  rawBytes: Uint8Array;
}

export interface TransactionMeta {
  net: string;
  txHash: Hex32;
  blockHeight: number;
  blockHash: Hex32;
  position: number;
  kind: TransactionKind;
  protocolVersion: number;
  result?: TransactionResult;
  rawBlobHash: Hex32;
}

export type BridgeObservationKind =
  | "cnight_registration" | "system_parameters_d" | "spo_registration" | "other";

export interface BridgeObservationRecord {
  net: string;
  blockHeight: number;
  blockHash: Hex32;
  observationIndex: number;
  kind: BridgeObservationKind;
  rawBytes: Uint8Array;
}

export type VerifierKeyScope = "protocol" | "contract";

export interface VerifierKeyObservationRecord {
  vkBytes: Uint8Array;
  net: string;
  scope: VerifierKeyScope;
  tag: string;
  contractAddress?: Hex32;
  firstSeenHeight: number;
}

export type ChainArchiveErrorCode = "BLOB_INTEGRITY" | "BLOB_MISSING" | "BLOCK_NOT_FOUND" | "VALIDATION_FAILED";

export abstract class ChainArchiveError extends StorageError {
  abstract readonly code: ChainArchiveErrorCode;
}

/** AC-3: a blob's recomputed hash, on read, does not match its content-addressed storage key --
 *  mirrors `ChunkIntegrityError` (`checkpoint-store.ts`)'s proven rehash-on-read contract. Never
 *  returns the corrupted bytes to the caller. */
export class BlobIntegrityError extends ChainArchiveError {
  readonly code = "BLOB_INTEGRITY" as const;
  constructor(readonly expectedHash: Hex32, readonly actualHash: Hex32) {
    super(`chain_blobs content hash mismatch: expected ${expectedHash}, recomputed ${actualHash}`);
  }
}

/** A referenced blob hash has no row in `chain_blobs` at all. */
export class BlobMissingError extends ChainArchiveError {
  readonly code = "BLOB_MISSING" as const;
  constructor(readonly hash: Hex32) { super(`chain_blobs has no row for hash ${hash}`); }
}

export class BlockNotFoundError extends ChainArchiveError {
  readonly code = "BLOCK_NOT_FOUND" as const;
  constructor(readonly net: string, readonly height: number, readonly blockHash?: Hex32) {
    super(`no block found for net=${net} height=${height}${blockHash ? ` blockHash=${blockHash}` : ""}`);
  }
}

/**
 * Storage contract for the Tier-1.5 chain archive. Every write method is content/idempotency-
 * aware where the schema itself is (blob puts are naturally idempotent by content address;
 * `putBlock`/`putTransactions` are NOT implicitly upsert-safe against a byte-for-byte-identical
 * re-ingest of the SAME (net, height, blockHash) row -- callers driving an at-least-once sync
 * loop must track a watermark, exactly like every other sync consumer in this codebase
 * (`src/interfaces/watermarks.ts`), and are expected to detect "already ingested this height"
 * before calling `putBlock` a second time for it).
 */
export interface ChainArchiveStore {
  /** Writes `header`/`body` bytes into `chain_blobs` (content-addressed by SHA-256) plus their
   *  `chain_blob_roles` rows, then the `blocks` row itself, inside one transaction. Returns the
   *  computed header/body blob hashes. A byte-identical header/body blob already present under
   *  the same role is reused, not duplicated (`chain_blobs` is a single global content-addressed
   *  pool, matching `ckpt_chunks`'s established convention). */
  putBlock(block: BlockRecord): Promise<{ headerBlobHash: Hex32; bodyBlobHash?: Hex32 }>;

  /** Writes each transaction's raw bytes into `chain_blobs`/`chain_blob_roles` (role `tx_raw`)
   *  plus its `transactions` row, one insert per element, inside one transaction covering the
   *  whole batch (so a partial block's transaction set never becomes visible on failure). */
  putTransactions(txs: readonly TransactionRecord[]): Promise<void>;

  putBridgeObservations(obs: readonly BridgeObservationRecord[]): Promise<void>;

  /** Upserts via `ON CONFLICT ... DO UPDATE SET first_seen_height = LEAST(...)`, matching the
   *  schema's own documented convention (`001_chain_archive_core.ts`'s verifier_key_observations
   *  comment) -- never a plain INSERT, since a plain INSERT of a repeated context would violate
   *  the UNIQUE constraint. */
  putVerifierKeyObservation(vk: VerifierKeyObservationRecord): Promise<void>;

  /**
   * Atomically flips canonical status at `(net, height)`: un-marks whichever block currently
   * holds `is_canonical = true` at that height (if any, and if it isn't already `blockHash`),
   * then marks `blockHash` canonical -- both inside one transaction, so a concurrent reader can
   * only ever observe zero-then-new-canonical or old-then-new-canonical, never two at once
   * (AC-2's "reorg flip is a single observable state transition"). `finalized` is monotonic
   * (schema-enforced, `blocks_finalized_monotonic_trigger`) -- passing `finalized: false` on an
   * already-finalized row throws, translated from the trigger's `23514`.
   * @throws {BlockNotFoundError} if no `(net, height, blockHash)` row exists to flip onto.
   */
  setCanonical(
    net: string, height: number, blockHash: Hex32, opts?: { finalized?: boolean },
  ): Promise<void>;

  /** All blocks at `(net, height)` -- the full block tree at that height, not just canonical
   *  (§4.2's "block tree, not just the canonical chain" modeling). Empty array if none. */
  getBlocksAtHeight(net: string, height: number): Promise<BlockMeta[]>;

  /** The one canonical block at `(net, height)`, or `undefined` if none is currently canonical
   *  there (e.g. height beyond the synced tip, or a genuinely orphaned gap). */
  getCanonicalBlockAtHeight(net: string, height: number): Promise<BlockMeta | undefined>;

  /** Every transaction inclusion record for `txHash`, across every fork that carries it
   *  (AC-1: a shared tx hash across competing blocks at one height persists in full for both). */
  getTransactionsByHash(net: string, txHash: Hex32): Promise<TransactionMeta[]>;

  /** The canonical chain's blocks within `[fromHeight, toHeight]` inclusive, ordered by height
   *  ascending. Spans a partition boundary transparently (AC-6) -- the caller never needs to know
   *  where a `CHAIN_ARCHIVE_HEIGHT_PARTITION_SIZE` boundary falls. */
  getCanonicalChainRange(net: string, fromHeight: number, toHeight: number): Promise<BlockMeta[]>;

  /**
   * Reads a blob by its content-addressed key and rehashes it before returning (AC-3) -- never
   * returns bytes whose recomputed hash disagrees with `hash`.
   * @throws {BlobMissingError} if no `chain_blobs` row exists for `hash`.
   * @throws {BlobIntegrityError} if the recomputed hash does not match `hash`.
   */
  getBlob(hash: Hex32): Promise<Uint8Array>;

  /** `chain_archive`'s own local watermark table (§5 -- deliberately NOT `tier1_wallet.
   *  watermarks`). `key` is caller-structured, matching the design doc's documented convention
   *  (e.g. `canonical_tip:<net>`). */
  getWatermark(key: string): Promise<unknown | undefined>;
  setWatermark(key: string, value: unknown): Promise<void>;
}
