import { createHash } from "node:crypto";
import {
  BlobIntegrityError,
  BlobMissingError,
  BlockNotFoundError,
  Hex32Schema,
  type BlockBundle,
  type BlockMeta,
  type BlockRecord,
  type BridgeObservationRecord,
  type ChainArchiveStore,
  type Hex32,
  type TransactionMeta,
  type TransactionRecord,
  type VerifierKeyObservationRecord,
} from "../interfaces/chain-archive-store.js";
import { ValidationError } from "../interfaces/storage-errors.js";
import type { JSONValue, TransactionSql } from "postgres";
import type { UmbraDBSql } from "./client.js";
import { translatePostgresError } from "./errors.js";

/** The `sql` handle `UmbraDBSql.begin(async (tx) => ...)` hands its callback -- used to type the
 *  shared row-insert helpers below so they can run either as their own standalone transaction
 *  (`putBlock`/`putTransactions`/`putBridgeObservations`, unchanged public call sites) or
 *  composed together inside ONE transaction (`putBlockBundle`, Fix 1). */
type ChainArchiveTx = TransactionSql<{ bigint: bigint }>;

function sha256Hex(data: Uint8Array): Hex32 {
  return createHash("sha256").update(data).digest("hex");
}

function hexToBuf(hex: Hex32): Buffer {
  return Buffer.from(hex, "hex");
}

function bufToHex(buf: Buffer): Hex32 {
  return buf.toString("hex");
}

function assertHex32(value: string, field: string): void {
  const parsed = Hex32Schema.safeParse(value);
  if (!parsed.success) throw ValidationError.fromZod(`PgChainArchiveStore.${field}`, parsed.error);
}

interface BlockRow {
  net: string;
  block_hash: Buffer;
  height: bigint;
  parent_hash: Buffer;
  state_root: Buffer;
  extrinsics_root: Buffer;
  author: Buffer | null;
  header_blob_hash: Buffer;
  body_blob_hash: Buffer | null;
  is_canonical: boolean;
  status: string;
  finalized: boolean;
}

interface TxRow {
  net: string;
  tx_hash: Buffer;
  block_height: bigint;
  block_hash: Buffer;
  position: number;
  kind: string;
  protocol_version: number;
  result: string | null;
  raw_blob_hash: Buffer;
}

function toBlockMeta(row: BlockRow): BlockMeta {
  return {
    net: row.net,
    blockHash: bufToHex(row.block_hash),
    height: Number(row.height),
    parentHash: bufToHex(row.parent_hash),
    stateRoot: bufToHex(row.state_root),
    extrinsicsRoot: bufToHex(row.extrinsics_root),
    author: row.author ? bufToHex(row.author) : undefined,
    headerBlobHash: bufToHex(row.header_blob_hash),
    bodyBlobHash: row.body_blob_hash ? bufToHex(row.body_blob_hash) : undefined,
    isCanonical: row.is_canonical,
    status: row.status as BlockMeta["status"],
    finalized: row.finalized,
  };
}

function toTxMeta(row: TxRow): TransactionMeta {
  return {
    net: row.net,
    txHash: bufToHex(row.tx_hash),
    blockHeight: Number(row.block_height),
    blockHash: bufToHex(row.block_hash),
    position: row.position,
    kind: row.kind as TransactionMeta["kind"],
    protocolVersion: row.protocol_version,
    result: (row.result ?? undefined) as TransactionMeta["result"],
    rawBlobHash: bufToHex(row.raw_blob_hash),
  };
}

/**
 * Postgres implementation of `ChainArchiveStore` (`src/interfaces/chain-archive-store.ts`)
 * against the `chain_archive` schema (`migrations/chain_archive/001_chain_archive_core.ts`).
 * Does not run migrations itself -- call `runMigrations(sql, { schema, migrations:
 * chainArchiveMigrations })` before constructing this against a fresh database, matching every
 * other Postgres adapter in this repo (`checkpoint-store.ts`, `watermarks.ts`).
 *
 * Blob writes are content-addressed and idempotent: `putBlob` computes SHA-256 itself (never
 * trusts a caller-supplied hash) and uses `INSERT ... ON CONFLICT (hash) DO NOTHING` so a byte-
 * identical blob already present (from an earlier ingest, or shared across the header/body/tx
 * split) is reused rather than duplicated or rejected, matching `chain_blobs`'s documented
 * single-global-content-addressed-pool design (`design/full-chain-storage-design.md` §4.1). The
 * `chain_blob_roles` row is inserted the same way -- `ON CONFLICT DO NOTHING` on its own
 * `(blob_hash, role)` PK -- so re-registering an already-classified blob under the same role is a
 * no-op, not an error.
 */
export class PgChainArchiveStore implements ChainArchiveStore {
  constructor(
    private readonly sql: UmbraDBSql,
    private readonly schema: string = "chain_archive",
  ) {}

  /** Not part of the public interface -- an internal helper `chain-archive-sync` doesn't need to
   *  duplicate its own SHA-256/idempotent-insert logic for a blob that isn't yet attached to any
   *  metadata row (used by the AC-3 test harness directly against a real blob, and internally by
   *  `putBlock`/`putTransactions`). Exposed as a plain method (not `private`) so tests can drive
   *  it directly without needing a full block/transaction row just to exercise blob integrity. */
  async putBlobWithRole(data: Uint8Array, role: string): Promise<Hex32> {
    try {
      return await this.sql.begin(async (tx) => {
        const hashHex = sha256Hex(data);
        const hash = hexToBuf(hashHex);
        await tx`
          INSERT INTO ${tx(this.schema)}.chain_blobs (hash, data)
          VALUES (${hash}, ${Buffer.from(data)})
          ON CONFLICT (hash) DO NOTHING
        `;
        await tx`
          INSERT INTO ${tx(this.schema)}.chain_blob_roles (blob_hash, role)
          VALUES (${hash}, ${role})
          ON CONFLICT (blob_hash, role) DO NOTHING
        `;
        return hashHex;
      });
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  /** Shared by `putBlock` (standalone, its own transaction) and `putBlockBundle` (composed
   *  alongside the transactions/bridge-observations insert in ONE transaction, Fix 1). The
   *  terminal `blocks` insert is `ON CONFLICT (net, height, block_hash) DO NOTHING` -- re-running
   *  this against an already-committed row (a retry after the row durably committed but a LATER
   *  step in the caller's own sequence failed/crashed) is a safe no-op rather than a
   *  duplicate-key error. */
  private async insertBlockRow(
    tx: ChainArchiveTx, block: BlockRecord,
  ): Promise<{ headerBlobHash: Hex32; bodyBlobHash?: Hex32 }> {
    const headerHashHex = sha256Hex(block.headerBytes);
    const headerHash = hexToBuf(headerHashHex);
    await tx`
      INSERT INTO ${tx(this.schema)}.chain_blobs (hash, data)
      VALUES (${headerHash}, ${Buffer.from(block.headerBytes)})
      ON CONFLICT (hash) DO NOTHING
    `;
    await tx`
      INSERT INTO ${tx(this.schema)}.chain_blob_roles (blob_hash, role)
      VALUES (${headerHash}, 'block_header')
      ON CONFLICT (blob_hash, role) DO NOTHING
    `;

    let bodyHash: Buffer | null = null;
    let bodyHashHex: Hex32 | undefined;
    if (block.bodyBytes !== undefined) {
      bodyHashHex = sha256Hex(block.bodyBytes);
      bodyHash = hexToBuf(bodyHashHex);
      await tx`
        INSERT INTO ${tx(this.schema)}.chain_blobs (hash, data)
        VALUES (${bodyHash}, ${Buffer.from(block.bodyBytes)})
        ON CONFLICT (hash) DO NOTHING
      `;
      await tx`
        INSERT INTO ${tx(this.schema)}.chain_blob_roles (blob_hash, role)
        VALUES (${bodyHash}, 'block_body')
        ON CONFLICT (blob_hash, role) DO NOTHING
      `;
    }

    await tx`
      INSERT INTO ${tx(this.schema)}.blocks
        (net, block_hash, height, parent_hash, state_root, extrinsics_root, author,
         header_blob_hash, body_blob_hash, is_canonical, status, finalized)
      VALUES
        (${block.net}, ${hexToBuf(block.blockHash)}, ${block.height},
         ${hexToBuf(block.parentHash)}, ${hexToBuf(block.stateRoot)},
         ${hexToBuf(block.extrinsicsRoot)}, ${block.author ? hexToBuf(block.author) : null},
         ${headerHash}, ${bodyHash}, ${block.isCanonical}, ${block.status}, ${block.finalized})
      ON CONFLICT (net, height, block_hash) DO NOTHING
    `;

    return { headerBlobHash: headerHashHex, bodyBlobHash: bodyHashHex };
  }

  /** Shared by `putTransactions` and `putBlockBundle`. The terminal `transactions` insert is a
   *  bare `ON CONFLICT DO NOTHING` (no target list) rather than one naming a specific constraint
   *  -- `transactions` carries TWO independent unique constraints (the
   *  `(net, block_height, block_hash, tx_hash)` PK and the separate
   *  `UNIQUE (net, block_height, block_hash, position)`), and for a genuine idempotent retry
   *  (byte-identical row) either one alone identifies the same already-committed row; targeting
   *  only one by name would leave the other free to still raise if Postgres happened to check it
   *  first. */
  private async insertTransactionRows(tx: ChainArchiveTx, txs: readonly TransactionRecord[]): Promise<void> {
    for (const t of txs) {
      const rawHashHex = sha256Hex(t.rawBytes);
      const rawHash = hexToBuf(rawHashHex);
      await tx`
        INSERT INTO ${tx(this.schema)}.chain_blobs (hash, data)
        VALUES (${rawHash}, ${Buffer.from(t.rawBytes)})
        ON CONFLICT (hash) DO NOTHING
      `;
      await tx`
        INSERT INTO ${tx(this.schema)}.chain_blob_roles (blob_hash, role)
        VALUES (${rawHash}, 'tx_raw')
        ON CONFLICT (blob_hash, role) DO NOTHING
      `;
      await tx`
        INSERT INTO ${tx(this.schema)}.transactions
          (net, tx_hash, block_height, block_hash, position, kind, protocol_version, result, raw_blob_hash)
        VALUES
          (${t.net}, ${hexToBuf(t.txHash)}, ${t.blockHeight}, ${hexToBuf(t.blockHash)},
           ${t.position}, ${t.kind}, ${t.protocolVersion}, ${t.result ?? null}, ${rawHash})
        ON CONFLICT DO NOTHING
      `;
    }
  }

  /** Shared by `putBridgeObservations` and `putBlockBundle`. */
  private async insertBridgeObservationRows(tx: ChainArchiveTx, obs: readonly BridgeObservationRecord[]): Promise<void> {
    for (const o of obs) {
      const rawHashHex = sha256Hex(o.rawBytes);
      const rawHash = hexToBuf(rawHashHex);
      await tx`
        INSERT INTO ${tx(this.schema)}.chain_blobs (hash, data)
        VALUES (${rawHash}, ${Buffer.from(o.rawBytes)})
        ON CONFLICT (hash) DO NOTHING
      `;
      await tx`
        INSERT INTO ${tx(this.schema)}.chain_blob_roles (blob_hash, role)
        VALUES (${rawHash}, 'bridge_observation')
        ON CONFLICT (blob_hash, role) DO NOTHING
      `;
      await tx`
        INSERT INTO ${tx(this.schema)}.bridge_observations
          (net, block_height, block_hash, observation_index, kind, raw_blob_hash)
        VALUES
          (${o.net}, ${o.blockHeight}, ${hexToBuf(o.blockHash)}, ${o.observationIndex}, ${o.kind}, ${rawHash})
        ON CONFLICT (net, block_height, block_hash, observation_index) DO NOTHING
      `;
    }
  }

  async putBlock(block: BlockRecord): Promise<{ headerBlobHash: Hex32; bodyBlobHash?: Hex32 }> {
    assertHex32(block.blockHash, "putBlock.blockHash");
    assertHex32(block.parentHash, "putBlock.parentHash");
    assertHex32(block.stateRoot, "putBlock.stateRoot");
    assertHex32(block.extrinsicsRoot, "putBlock.extrinsicsRoot");
    if (block.author !== undefined) assertHex32(block.author, "putBlock.author");

    try {
      return await this.sql.begin(async (tx) => this.insertBlockRow(tx, block));
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  async putTransactions(txs: readonly TransactionRecord[]): Promise<void> {
    if (txs.length === 0) return;
    for (const t of txs) {
      assertHex32(t.txHash, "putTransactions.txHash");
      assertHex32(t.blockHash, "putTransactions.blockHash");
    }
    try {
      await this.sql.begin(async (tx) => this.insertTransactionRows(tx, txs));
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  async putBridgeObservations(obs: readonly BridgeObservationRecord[]): Promise<void> {
    if (obs.length === 0) return;
    try {
      await this.sql.begin(async (tx) => this.insertBridgeObservationRows(tx, obs));
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  /** Fix 1 (sprint-fix round, HIGH): collapses the block + transactions + bridge-observations
   *  writes for one block into ONE Postgres transaction, so a partial block can never be
   *  committed at all -- see this method's own doc on `ChainArchiveStore` for the full
   *  before/after failure-mode writeup. */
  async putBlockBundle(bundle: BlockBundle): Promise<{ headerBlobHash: Hex32; bodyBlobHash?: Hex32 }> {
    const { block, transactions: txs, bridgeObservations: obs } = bundle;
    assertHex32(block.blockHash, "putBlockBundle.blockHash");
    assertHex32(block.parentHash, "putBlockBundle.parentHash");
    assertHex32(block.stateRoot, "putBlockBundle.stateRoot");
    assertHex32(block.extrinsicsRoot, "putBlockBundle.extrinsicsRoot");
    if (block.author !== undefined) assertHex32(block.author, "putBlockBundle.author");
    for (const t of txs) {
      assertHex32(t.txHash, "putBlockBundle.transactions.txHash");
      assertHex32(t.blockHash, "putBlockBundle.transactions.blockHash");
    }

    try {
      return await this.sql.begin(async (tx) => {
        const result = await this.insertBlockRow(tx, block);
        // FK-ordering note: `transactions`/`bridge_observations` both carry a real FK back to
        // `blocks (net, height, block_hash)` (001_chain_archive_core.ts) -- inserting the block
        // row first, in the SAME transaction, makes it visible to these later statements' own FK
        // checks (ordinary same-transaction MVCC visibility), so the FK is satisfied even though
        // the referenced row hasn't committed yet.
        if (txs.length > 0) await this.insertTransactionRows(tx, txs);
        if (obs.length > 0) await this.insertBridgeObservationRows(tx, obs);
        return result;
      });
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  async putVerifierKeyObservation(vk: VerifierKeyObservationRecord): Promise<void> {
    try {
      await this.sql.begin(async (tx) => {
        const vkHashHex = sha256Hex(vk.vkBytes);
        const vkHash = hexToBuf(vkHashHex);
        await tx`
          INSERT INTO ${tx(this.schema)}.chain_blobs (hash, data)
          VALUES (${vkHash}, ${Buffer.from(vk.vkBytes)})
          ON CONFLICT (hash) DO NOTHING
        `;
        await tx`
          INSERT INTO ${tx(this.schema)}.chain_blob_roles (blob_hash, role)
          VALUES (${vkHash}, 'verifier_key')
          ON CONFLICT (blob_hash, role) DO NOTHING
        `;
        // Matches the schema's own documented upsert convention (001_chain_archive_core.ts's
        // verifier_key_observations comment): first_seen_height is a mutable "earliest known"
        // fact, not part of the identity key, so a repeated observation of the same context
        // collapses via LEAST rather than violating the UNIQUE constraint via a plain INSERT.
        await tx`
          INSERT INTO ${tx(this.schema)}.verifier_key_observations
            (vk_hash, net, scope, tag, contract_address, first_seen_height)
          VALUES
            (${vkHash}, ${vk.net}, ${vk.scope}, ${vk.tag},
             ${vk.contractAddress ? hexToBuf(vk.contractAddress) : null}, ${vk.firstSeenHeight})
          ON CONFLICT (vk_hash, net, scope, contract_address, tag) DO UPDATE
          SET first_seen_height = LEAST(
            ${tx(this.schema)}.verifier_key_observations.first_seen_height, EXCLUDED.first_seen_height)
        `;
      });
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  async setCanonical(
    net: string, height: number, blockHash: Hex32, opts?: { finalized?: boolean },
  ): Promise<void> {
    assertHex32(blockHash, "setCanonical.blockHash");
    const blockHashBuf = hexToBuf(blockHash);
    try {
      await this.sql.begin(async (tx) => {
        // Un-mark whichever OTHER block currently holds is_canonical at this height first --
        // required ordering under the partial-unique-index enforcement (AC-2): the new row
        // cannot become canonical while the old one still holds the slot, since
        // blocks_one_canonical_per_height permits at most one is_canonical=true row per
        // (net, height) at every instant, not just at transaction end.
        await tx`
          UPDATE ${tx(this.schema)}.blocks
          SET is_canonical = false, status = 'orphaned'
          WHERE net = ${net} AND height = ${height} AND is_canonical
            AND block_hash <> ${blockHashBuf}
        `;
        const updated = await tx<{ block_hash: Buffer }[]>`
          UPDATE ${tx(this.schema)}.blocks
          SET is_canonical = true, status = 'canonical',
              finalized = COALESCE(${opts?.finalized ?? null}, finalized)
          WHERE net = ${net} AND height = ${height} AND block_hash = ${blockHashBuf}
          RETURNING block_hash
        `;
        if (updated.length === 0) {
          throw new BlockNotFoundError(net, height, blockHash);
        }
      });
    } catch (err) {
      if (err instanceof BlockNotFoundError) throw err;
      throw translatePostgresError(err);
    }
  }

  async getBlocksAtHeight(net: string, height: number): Promise<BlockMeta[]> {
    try {
      const rows = await this.sql<BlockRow[]>`
        SELECT net, block_hash, height, parent_hash, state_root, extrinsics_root, author,
               header_blob_hash, body_blob_hash, is_canonical, status, finalized
        FROM ${this.sql(this.schema)}.blocks
        WHERE net = ${net} AND height = ${height}
        ORDER BY block_hash
      `;
      return rows.map(toBlockMeta);
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  async getCanonicalBlockAtHeight(net: string, height: number): Promise<BlockMeta | undefined> {
    try {
      const rows = await this.sql<BlockRow[]>`
        SELECT net, block_hash, height, parent_hash, state_root, extrinsics_root, author,
               header_blob_hash, body_blob_hash, is_canonical, status, finalized
        FROM ${this.sql(this.schema)}.blocks
        WHERE net = ${net} AND height = ${height} AND is_canonical
      `;
      return rows[0] ? toBlockMeta(rows[0]) : undefined;
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  async getTransactionsByHash(net: string, txHash: Hex32): Promise<TransactionMeta[]> {
    assertHex32(txHash, "getTransactionsByHash.txHash");
    try {
      const rows = await this.sql<TxRow[]>`
        SELECT net, tx_hash, block_height, block_hash, position, kind, protocol_version, result, raw_blob_hash
        FROM ${this.sql(this.schema)}.transactions
        WHERE net = ${net} AND tx_hash = ${hexToBuf(txHash)}
        ORDER BY block_hash
      `;
      return rows.map(toTxMeta);
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  async getTransactionsForBlock(net: string, blockHash: Hex32): Promise<TransactionMeta[]> {
    assertHex32(blockHash, "getTransactionsForBlock.blockHash");
    try {
      const rows = await this.sql<TxRow[]>`
        SELECT net, tx_hash, block_height, block_hash, position, kind, protocol_version, result, raw_blob_hash
        FROM ${this.sql(this.schema)}.transactions
        WHERE net = ${net} AND block_hash = ${hexToBuf(blockHash)}
        ORDER BY position ASC
      `;
      return rows.map(toTxMeta);
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  async getCanonicalChainRange(net: string, fromHeight: number, toHeight: number): Promise<BlockMeta[]> {
    try {
      const rows = await this.sql<BlockRow[]>`
        SELECT net, block_hash, height, parent_hash, state_root, extrinsics_root, author,
               header_blob_hash, body_blob_hash, is_canonical, status, finalized
        FROM ${this.sql(this.schema)}.blocks
        WHERE net = ${net} AND height BETWEEN ${fromHeight} AND ${toHeight} AND is_canonical
        ORDER BY height ASC
      `;
      return rows.map(toBlockMeta);
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  async getBlob(hash: Hex32): Promise<Uint8Array> {
    assertHex32(hash, "getBlob.hash");
    try {
      const rows = await this.sql<{ data: Buffer }[]>`
        SELECT data FROM ${this.sql(this.schema)}.chain_blobs WHERE hash = ${hexToBuf(hash)}
      `;
      if (rows.length === 0) throw new BlobMissingError(hash);
      const data = rows[0]!.data;
      // AC-3 rehash-on-read: recompute SHA-256 over the retrieved bytes and reject if it
      // disagrees with the key we looked it up by -- mirrors CheckpointStore.loadImpl's proven
      // ChunkIntegrityError pattern (checkpoint-store.ts:260-278), rather than trusting the key
      // was correct at write time.
      const actualHash = sha256Hex(data);
      if (actualHash !== hash) throw new BlobIntegrityError(hash, actualHash);
      return data;
    } catch (err) {
      if (err instanceof BlobMissingError || err instanceof BlobIntegrityError) throw err;
      throw translatePostgresError(err);
    }
  }

  async getWatermark(key: string): Promise<unknown | undefined> {
    try {
      const rows = await this.sql<{ value: unknown }[]>`
        SELECT value FROM ${this.sql(this.schema)}.watermarks WHERE kind = 'chain_archive' AND key = ${key}
      `;
      return rows.length === 0 ? undefined : rows[0]!.value;
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  /** Fix 5 (sprint-fix round, MEDIUM): a monotonic guard against watermark regression. Nothing
   *  prevents two overlapping `syncOnce()` calls (two service instances, or a scheduler firing
   *  while a slow previous run is still in flight) from racing each other's `setWatermark` calls
   *  -- without a guard, a slower/lagging call finishing AFTER a faster one can overwrite the
   *  cursor backward with a stale, lower height, which then makes the next sync attempt
   *  re-process already-ingested heights and hit the duplicate-key wedge Fix 1 addresses.
   *
   *  The guard is scoped to this store's one real convention -- a JSON value shaped
   *  `{ height: number }` (`chain-archive-sync/sync-service.ts`'s sync cursor; also this file's
   *  own test coverage) -- via the `ON CONFLICT ... DO UPDATE ... WHERE` clause below: when BOTH
   *  the already-stored value and the incoming value carry a numeric `height` field, the update
   *  is only applied if the incoming height is strictly greater, so a stale/regressed write is
   *  silently dropped (the row keeps its later, correct value) rather than clobbering forward
   *  progress. Any OTHER value shape (either side missing a numeric `height`, e.g. a future,
   *  unrelated `chain_archive` watermark consumer with its own value convention) falls through to
   *  the previous unconditional last-write-wins behavior unchanged -- this guard deliberately does
   *  not assume every current or future caller of this generic `(key, value)` API uses the
   *  height-cursor convention. */
  async setWatermark(key: string, value: unknown): Promise<void> {
    try {
      await this.sql`
        INSERT INTO ${this.sql(this.schema)}.watermarks AS w (kind, key, value, updated_at)
        VALUES ('chain_archive', ${key}, ${this.sql.json(value as JSONValue)}, now())
        ON CONFLICT (kind, key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = now()
        WHERE jsonb_typeof(w.value -> 'height') IS DISTINCT FROM 'number'
           OR jsonb_typeof(EXCLUDED.value -> 'height') IS DISTINCT FROM 'number'
           OR (EXCLUDED.value ->> 'height')::numeric > (w.value ->> 'height')::numeric
      `;
    } catch (err) {
      throw translatePostgresError(err);
    }
  }
}
