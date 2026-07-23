import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";
import { IndexerClient } from "../../chain-archive-sync/indexer-client.js";

/**
 * REAL, non-mocked, live end-to-end integration test: a real Postgres (testcontainers) plus a
 * live HTTP connection to an already-running local Midnight devnet (node RPC
 * `http://localhost:9944`, indexer GraphQL `http://localhost:8088/api/v3/graphql`, network id
 * `undeployed1` -- confirmed live via `system_chain` during the original implementation session).
 *
 * This is deliberately NOT gated behind an env-var flag the way `test/integration/
 * preprod-db-sync.integration.test.ts` is (`UMBRADB_LIVE_PREPROD=1`) -- that gate exists because
 * preprod is a shared, funded, real-money-adjacent public network with a seed file that must
 * never be committed; the local devnet used here has none of those constraints.
 *
 * **Devnet-availability gating (Sol-audit fix round, Finding 4)**: when the devnet endpoints are
 * unreachable, this whole suite is `describe.skipIf`-SKIPPED -- reported honestly as skipped in
 * the run summary, exactly like the preprod suite's `describe.skipIf(!LIVE_PREPROD_ENABLED)`
 * precedent. It previously used per-test `if (!up) return;` early-returns, which vitest counts
 * as PASSED, silently inflating the green count in any devnet-less environment. That matters
 * because devnet-less is the NORMAL state in CI: `.github/workflows/conformance.yml` provisions
 * Docker for testcontainers but NO Midnight devnet, so in CI these tests are ALWAYS skipped --
 * a green CI run proves nothing about this file beyond it collecting cleanly. Run it for real
 * with the local devnet up (docs in `design/full-chain-storage-design.md` §3).
 */
async function devnetIsUp(): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:9944", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "system_chain", params: [] }),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const NET = "undeployed1";
const NODE_URL = "http://localhost:9944";
const INDEXER_URL = "http://localhost:8088/api/v3/graphql";

// Probed once at collection time (top-level await) so the whole suite can be genuinely
// `describe.skipIf`-skipped -- shows up as SKIPPED, never as a vacuous PASS (Finding 4).
const up = await devnetIsUp();

describe.skipIf(!up)("ChainArchiveSyncService against the live local devnet (real node + indexer, real Postgres)", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema: "chain_archive" });
    // The "real invocation path" (task requirement 1): bootstraps the chain_archive schema via
    // runMigrations(sql, { schema, migrations: chainArchiveMigrations }), exercised here against
    // a real Postgres instance, not merely unit-tested in isolation
    // (test/postgres/chain-archive-migrate.test.ts already covers that in isolation; this proves
    // the SAME bootstrap function a real deployment would call actually works end to end,
    // immediately followed by real ingestion using the schema it just created).
    await bootstrapChainArchiveSchema(sql, "chain_archive");
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  });

  it("syncs real blocks from genesis, including genesis's real ~26 transactions with cross-checked raw bytes", async () => {
    const service = new ChainArchiveSyncService({
      sql, net: NET, schema: "chain_archive",
      node: { url: NODE_URL }, indexer: { url: INDEXER_URL },
    });

    const result = await service.syncOnce({ maxBlocks: 5 });
    expect(result.ingestedBlocks).toBe(5);
    expect(result.fromHeight).toBe(0);
    expect(result.toHeight).toBe(4);
    expect(result.targetTipHeight).toBeGreaterThan(4);

    // Genesis block (height 0) is retrievable, with a real, non-zero-only stateRoot/extrinsicsRoot.
    const genesis = await service.store.getCanonicalBlockAtHeight(NET, 0);
    expect(genesis).toBeDefined();
    expect(genesis!.parentHash).toBe("0".repeat(64)); // genesis's parent hash is the all-zero hash
    expect(genesis!.stateRoot).not.toBe("0".repeat(64));

    // The header/body blobs round-trip and hash-verify (AC-3, exercised against REAL archived
    // chain data, not synthetic test bytes).
    const headerBytes = await service.store.getBlob(genesis!.headerBlobHash);
    expect(headerBytes.length).toBeGreaterThan(0);
    expect(genesis!.bodyBlobHash).toBeDefined();
    const bodyBytes = await service.store.getBlob(genesis!.bodyBlobHash!);
    expect(bodyBytes.length).toBeGreaterThan(0);

    // Real, independently-confirmed data volume: genesis carries ~26 real transactions
    // (`design/full-chain-storage-design.md` §3.3's own live count). Confirmed against the
    // archive by querying every tx hash the indexer reports for height 0 and checking each
    // landed in the archive with byte-identical raw bytes.
    const indexer = new IndexerClient({ url: INDEXER_URL });
    const indexerGenesis = await indexer.getBlockByHeight(0);
    expect(indexerGenesis).toBeDefined();
    expect(indexerGenesis!.transactions.length).toBeGreaterThan(20); // real count observed: 26

    for (const tx of indexerGenesis!.transactions.slice(0, 5)) { // sample, not all 26, to keep this fast
      const archived = await service.store.getTransactionsByHash(NET, tx.hash.startsWith("0x") ? tx.hash.slice(2) : tx.hash);
      expect(archived.length).toBeGreaterThanOrEqual(1);
      const rawFromArchive = await service.store.getBlob(archived[0]!.rawBlobHash);
      expect(Buffer.from(rawFromArchive).toString("hex")).toBe(tx.raw.startsWith("0x") ? tx.raw.slice(2) : tx.raw);
    }
  }, 60_000);

  it("is resumable: a second syncOnce() call continues from the watermark, does not re-ingest, and does not error", async () => {
    const service = new ChainArchiveSyncService({
      sql, net: NET, schema: "chain_archive",
      node: { url: NODE_URL }, indexer: { url: INDEXER_URL },
    });
    const before = await service.getSyncedHeight();
    expect(before).toBe(4); // watermark left by the previous test in this same schema/net

    const result = await service.syncOnce({ maxBlocks: 3 });
    expect(result.fromHeight).toBe(5);
    expect(result.toHeight).toBe(7);
    expect(result.ingestedBlocks).toBe(3);

    const after = await service.getSyncedHeight();
    expect(after).toBe(7);

    // Heights 0-4 (from the prior run) are still present and untouched -- a second syncOnce()
    // never re-touches already-ingested heights.
    const stillThere = await service.store.getCanonicalBlockAtHeight(NET, 2);
    expect(stillThere?.height).toBe(2);
  }, 60_000);

  it("bridge_observations ingestion path is exercised for real and does not error on this devnet's data (build-now stub, task requirement 2)", async () => {
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM chain_archive.bridge_observations WHERE net = ${NET}
    `;
    // At least the genesis-block D-parameter observation should have landed (real, live data --
    // design doc §3.7 confirms system_parameters_d has real rows on this devnet). Could
    // legitimately be a small number given the dedup-on-unchanged-value logic
    // (sync-service.ts's buildBridgeObservationRecords) -- this asserts the path is exercised
    // and produces real rows, not that every block gets one.
    expect(rows[0]!.n).toBeGreaterThanOrEqual(1);
  });

  /**
   * Sol-audit fix round, Finding 5: HONESTY REWRITE. The previous version of this test called
   * itself an "ingestion path" test while only querying an empty table -- implying coverage of a
   * code path that does not exist: `ChainArchiveSyncService` never calls
   * `putVerifierKeyObservation` anywhere. Judgment call, recorded: sync-side verifier-key
   * ingestion stays OUT OF SCOPE for this sprint -- no contract has ever been deployed on this
   * devnet (design doc §3.6, re-confirmed live) and the captured testnet indexer DB shows
   * `contract_actions: 0` too, so there is genuinely no VK-bearing data source to ingest from or
   * test against; wiring a speculative code path no data can exercise would itself be the kind
   * of untestable coverage-theater this fix round exists to remove. What IS real and covered:
   * the STORE-level write path (`putVerifierKeyObservation`'s upsert/LEAST semantics) has a
   * direct, real-Postgres test in `test/postgres/chain-archive-store.test.ts`. This test now
   * asserts exactly what is true: the sync service declares the gap
   * (`INGESTS_VERIFIER_KEYS = false`), and a fully-synced archive's table is empty and queryable
   * BECAUSE no ingestion path exists yet.
   */
  it("verifier-key ingestion is NOT implemented in the sync service (documented gap; store-level write path covered in chain-archive-store.test.ts)", async () => {
    expect(ChainArchiveSyncService.INGESTS_VERIFIER_KEYS).toBe(false);
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM chain_archive.verifier_key_observations`;
    expect(rows[0]!.n).toBe(0); // empty precisely because no ingestion path exists yet
  });

  /**
   * AC-4 SUBSTRATE check (retained): proves the raw bytes a reconstruction needs are genuinely
   * archived, hash-verified, and retrievable purely from the archive, with zero live queries
   * during retrieval, against a REAL zswap-bearing devnet transaction.
   *
   * **Correction (Sol-audit fix round, Finding 1)**: an earlier version of this block claimed
   * the semantic decode of these bytes was "genuinely blocked -- no existing pure-JS/TS decoder
   * ... and no pre-built WASM bindings available in this environment." That claim was FALSE:
   * the sibling `midnight-wallet` checkout ships a built `@midnight-ntwrk/ledger-v8` WASM
   * package that decodes these exact payloads (independently proven by review: the design doc's
   * genesis sample decodes to `DistributeReserve(1000000000000000)`, and real regular
   * transactions expose their zswap outputs, unshielded outputs, and dust actions). The real
   * semantic decode -- reconstructed zswap/unshielded/dust events from archived bytes,
   * field-matched against the indexer's independent report -- is now implemented
   * (`chain-archive-sync/tx-replay-decoder.ts`) and proven end-to-end by
   * `test/integration/chain-archive-replay-decode.integration.test.ts`, which is the actual
   * AC-4 gate. This block remains only as the live-devnet substrate-availability check.
   */
  describe("AC-4 substrate: the archived raw bytes the replay decoder consumes are real and retrievable (semantic decode proven by chain-archive-replay-decode.integration.test.ts)", () => {
    it("a real zswap/dust/unshielded-bearing transaction's raw bytes are retrievable purely from the archive, hash-verified, with no live query during retrieval", async () => {
      const indexer = new IndexerClient({ url: INDEXER_URL });
      const indexerGenesis = await indexer.getBlockByHeight(0);
      expect(indexerGenesis).toBeDefined();
      // Find a transaction the indexer independently reports as carrying a zswap event -- ground
      // truth queried SEPARATELY from reconstruction, exactly as AC-4's scenario requires.
      const eventQuery = await fetch(INDEXER_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ block(offset:{height:0}) { transactions { hash zswapLedgerEvents { __typename } } } }" }),
      }).then((r) => r.json()) as { data: { block: { transactions: { hash: string; zswapLedgerEvents: unknown[] }[] } } };
      const zswapTx = eventQuery.data.block.transactions.find((t) => t.zswapLedgerEvents.length > 0);
      expect(zswapTx).toBeDefined(); // real live data must actually contain at least one

      const service = new ChainArchiveSyncService({
        sql, net: NET, schema: "chain_archive", node: { url: NODE_URL }, indexer: { url: INDEXER_URL },
      });
      const archived = await service.store.getTransactionsByHash(
        NET, zswapTx!.hash.startsWith("0x") ? zswapTx!.hash.slice(2) : zswapTx!.hash,
      );
      expect(archived.length).toBeGreaterThanOrEqual(1);
      // getBlob rehashes on read (AC-3) -- this call succeeding at all IS the proof the raw
      // bytes the replay decoder needs are present, uncorrupted, and content-address-verified,
      // with zero indexer/node query in this specific call (getBlob talks to Postgres only).
      const rawBytes = await service.store.getBlob(archived[0]!.rawBlobHash);
      expect(rawBytes.length).toBeGreaterThan(0);
    });
  });
});
