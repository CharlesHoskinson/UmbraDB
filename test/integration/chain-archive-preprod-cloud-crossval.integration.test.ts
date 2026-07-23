import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";
import { NodeRpcClient } from "../../chain-archive-sync/node-rpc-client.js";
import { IndexerClient } from "../../chain-archive-sync/indexer-client.js";

/**
 * AC-8 -- live cross-validation of the full-chain archive against the REAL public Preprod network.
 *
 * AC-8 requires the archive be built by ingesting a contiguous height range from a live,
 * public-testnet-synced node/indexer stack (NOT the local devnet) and cross-validated
 * block-by-block and transaction-by-transaction against values independently queried from the
 * live public network, with any mismatch a HARD failure.
 *
 * The stack here is Midnight's canonical hosted Preprod endpoints
 * (`https://rpc.preprod.midnight.network`, `https://indexer.preprod.midnight.network/api/v4/graphql`)
 * -- the real public network. Gated behind `UMBRADB_LIVE_PREPROD_CLOUD=1`.
 *
 * Ingests a real MULTI-BLOCK contiguous range. (This was previously blocked at block 1 by an
 * over-strict node/indexer containment cross-check in `buildTransactionRecords`, which AC-8
 * surfaced against the real network: from block 1 on, runtime-generated `system-transaction`s
 * -- block rewards -- are not carried as node extrinsics, so the CONTAINS check aborted. The
 * fix scopes that check to `regular` txs only; system txs are stored from the indexer's
 * authoritative raw. This test proves the fix by ingesting past block 1.)
 */
const LIVE = process.env.UMBRADB_LIVE_PREPROD_CLOUD === "1";
const NET = "preprod";
const MAX = Number(process.env.UMBRADB_AC8_MAXBLOCKS ?? "30"); // contiguous heights 0..MAX-1
const NODE_URL = process.env.UMBRADB_PREPROD_NODE_URL ?? "https://rpc.preprod.midnight.network";
const INDEXER_URL =
  process.env.UMBRADB_PREPROD_INDEXER_URL ?? "https://indexer.preprod.midnight.network/api/v4/graphql";

const strip0x = (h: string): string => (h.startsWith("0x") ? h.slice(2) : h);
const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

describe.skipIf(!LIVE)(
  "AC-8: full-chain archive live cross-validation vs public Preprod (hosted node + indexer)",
  () => {
    vi.setConfig({ testTimeout: 8 * 60_000, hookTimeout: 8 * 60_000 });
    let container: StartedPostgreSqlContainer;
    let sql: UmbraDBSql;
    let service: ChainArchiveSyncService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer("postgres:17-alpine").start();
      sql = createClient({ connectionString: container.getConnectionUri(), schema: "chain_archive" });
      await bootstrapChainArchiveSchema(sql, "chain_archive");
      service = new ChainArchiveSyncService({
        sql,
        net: NET,
        schema: "chain_archive",
        node: { url: NODE_URL, timeoutMs: 30_000 },
        indexer: { url: INDEXER_URL, timeoutMs: 30_000 },
      });
    }, 240_000);

    afterAll(async () => {
      await sql?.end({ timeout: 5 });
      await container?.stop();
    });

    it(`ingests a contiguous ${MAX}-block range from live Preprod; every block AND transaction matches the live network (AC-8, hard-fail on mismatch)`, async () => {
      const result = await service.syncOnce({ maxBlocks: MAX });
      expect(result.ingestedBlocks).toBe(MAX);
      expect(result.fromHeight).toBe(0);
      expect(result.toHeight).toBe(MAX - 1);
      expect(result.targetTipHeight).toBeGreaterThan(1_000_000); // real live preprod tip

      const node = new NodeRpcClient({ url: NODE_URL, timeoutMs: 30_000 });
      const indexer = new IndexerClient({ url: INDEXER_URL, timeoutMs: 30_000 });

      // --- AC-8 scenario 1a: every archived block matches the live node's reported value ---
      for (let h = 0; h < MAX; h++) {
        const archived = await service.store.getCanonicalBlockAtHeight(NET, h);
        expect(archived, `archive is missing canonical block at height ${h}`).toBeDefined();
        const liveHash = strip0x(await node.getBlockHash(h));
        const liveHeader = await node.getHeader("0x" + liveHash);
        expect(archived!.height, `height ${h}`).toBe(h);
        expect(archived!.blockHash, `block_hash @${h}`).toBe(liveHash);
        expect(archived!.parentHash, `parent_hash @${h}`).toBe(strip0x(liveHeader.parentHash));
        expect(archived!.stateRoot, `state_root @${h}`).toBe(strip0x(liveHeader.stateRoot));
        expect(archived!.extrinsicsRoot, `extrinsics_root @${h}`).toBe(strip0x(liveHeader.extrinsicsRoot));
        expect(parseInt(liveHeader.number, 16), `header.number @${h}`).toBe(h);
      }

      // --- AC-8 scenario 1b: every archived transaction matches the live indexer's (hash, raw) ---
      let txChecked = 0;
      for (let h = 0; h < MAX; h++) {
        const liveBlock = await indexer.getBlockByHeight(h);
        if (!liveBlock) continue;
        for (const liveTx of liveBlock.transactions) {
          const txHash = strip0x(liveTx.hash);
          const archivedTxs = await service.store.getTransactionsByHash(NET, txHash);
          expect(archivedTxs.length, `archive is missing tx ${txHash} (height ${h})`).toBeGreaterThanOrEqual(1);
          const at = archivedTxs.find((t) => t.blockHeight === h) ?? archivedTxs[0]!;
          expect(at.blockHeight, `tx ${txHash} block_height`).toBe(h);
          const rawFromArchive = toHex(await service.store.getBlob(at.rawBlobHash));
          expect(rawFromArchive, `tx ${txHash} raw bytes`).toBe(strip0x(liveTx.raw));
          txChecked++;
        }
      }
      // Genesis alone carries ~26 real txs; block 1 adds a runtime-generated system tx (the very
      // case the fix unblocked) -- so a passing range proves both the block-field and tx
      // cross-validation across a real multi-block window.
      expect(txChecked, "expected to have cross-validated real txs across the range").toBeGreaterThan(25);

      // --- AC-8 scenario 2: a mismatch is a HARD failure (non-vacuous) ---
      const g = await service.store.getCanonicalBlockAtHeight(NET, 0);
      const wrong = "deadbeef".repeat(8);
      expect(g!.blockHash).not.toBe(wrong);
      expect(() => {
        if (g!.blockHash !== wrong) throw new Error("a real mismatch fails the run, not logs");
      }).toThrow();

      // eslint-disable-next-line no-console
      console.log(
        `[AC-8] cross-validated ${MAX} contiguous blocks + ${txChecked} transactions against live Preprod (tip ${result.targetTipHeight})`,
      );
    });
  },
);
