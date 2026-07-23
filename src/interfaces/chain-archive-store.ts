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

/** Everything one call to `putBlockBundle` needs to ingest a single block atomically: the block
 *  row itself plus every transaction/bridge-observation row that belongs to it. `transactions`/
 *  `bridgeObservations` may be empty (e.g. a block with no `pallet_midnight` transactions, or no
 *  D-parameter change since the previous block) -- `putBlockBundle` still only writes the
 *  `blocks` row in that case, inside the same one transaction. */
export interface BlockBundle {
  block: BlockRecord;
  transactions: readonly TransactionRecord[];
  bridgeObservations: readonly BridgeObservationRecord[];
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
 * aware where the schema itself is (blob puts are naturally idempotent by content address) AND,
 * as of the sprint-fix round below, `putBlock`/`putTransactions`/`putBridgeObservations`/
 * `putBlockBundle` are now ALSO idempotent against a byte-for-byte-identical re-ingest of the
 * SAME (net, height, blockHash) row: their terminal `INSERT`s use `ON CONFLICT ... DO NOTHING`
 * on the table's own primary key, so retrying an ingest that already durably committed is a
 * silent no-op rather than a duplicate-key error. This does NOT remove the need for a watermark
 * (callers driving an at-least-once sync loop still must track "last successfully ingested
 * height," exactly like every other sync consumer in this codebase,
 * `src/interfaces/watermarks.ts`) -- it removes the failure mode where retrying the SAME height
 * after a partial or already-fully-committed prior attempt wedges permanently on a duplicate-key
 * error instead of succeeding as a no-op.
 */
export interface ChainArchiveStore {
  /** Writes `header`/`body` bytes into `chain_blobs` (content-addressed by SHA-256) plus their
   *  `chain_blob_roles` rows, then the `blocks` row itself, inside one transaction. Returns the
   *  computed header/body blob hashes. A byte-identical header/body blob already present under
   *  the same role is reused, not duplicated (`chain_blobs` is a single global content-addressed
   *  pool, matching `ckpt_chunks`'s established convention). The final `blocks` insert is
   *  `ON CONFLICT (net, height, block_hash) DO NOTHING` -- re-`putBlock`-ing an already-committed
   *  block is a safe no-op, not a duplicate-key error. Prefer `putBlockBundle` over calling this
   *  standalone from an ingestion loop -- it additionally makes the block/transactions/bridge-
   *  observations write atomic as one unit, not just individually retry-safe. */
  putBlock(block: BlockRecord): Promise<{ headerBlobHash: Hex32; bodyBlobHash?: Hex32 }>;

  /** Writes each transaction's raw bytes into `chain_blobs`/`chain_blob_roles` (role `tx_raw`)
   *  plus its `transactions` row, one insert per element, inside one transaction covering the
   *  whole batch (so a partial block's transaction set never becomes visible on failure). Each
   *  transaction's insert is `ON CONFLICT (net, block_height, block_hash, tx_hash) DO NOTHING` --
   *  re-`putTransactions`-ing an already-committed set (in full or in part) is a safe no-op. */
  putTransactions(txs: readonly TransactionRecord[]): Promise<void>;

  /** `ON CONFLICT (net, block_height, block_hash, observation_index) DO NOTHING` on the terminal
   *  insert -- same re-ingest-safety as `putTransactions`. */
  putBridgeObservations(obs: readonly BridgeObservationRecord[]): Promise<void>;

  /**
   * Ingests one full block -- `bundle.block`, `bundle.transactions`, and
   * `bundle.bridgeObservations` -- inside ONE Postgres transaction, so a partial block (e.g. the
   * `blocks` row committed but its transactions not, because the write was interrupted or the
   * caller's own upstream data source was itself inconsistent mid-ingest) can never become
   * durably visible. This is the fix for the sprint-fix round's Fix 1: previously, a real
   * ingestion caller (`chain-archive-sync/sync-service.ts`) issued `putBlock`/`putTransactions`/
   * `putBridgeObservations` as three SEPARATE, independently-committed transactions, so a retry
   * of the same height after a partial failure hit a duplicate-key error on whichever insert(s)
   * had already committed and wedged permanently. Every underlying insert additionally uses
   * `ON CONFLICT ... DO NOTHING` on its own primary key (matching `putBlock`/`putTransactions`/
   * `putBridgeObservations` above), so retrying the exact same bundle after it has ALREADY fully
   * committed (e.g. a crash between this call returning and the caller durably recording its own
   * watermark) is also a safe no-op, not an error -- both the "partial prior attempt" and
   * "fully-committed prior attempt, watermark just hadn't caught up" retry cases are covered.
   * Returns the same header/body blob hashes `putBlock` would.
   */
  putBlockBundle(bundle: BlockBundle): Promise<{ headerBlobHash: Hex32; bodyBlobHash?: Hex32 }>;

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
