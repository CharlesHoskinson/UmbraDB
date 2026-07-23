import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";
import { NodeRpcInvalidHeightError } from "../../chain-archive-sync/node-rpc-client.js";
import type { BlockBundle, Hex32 } from "../../src/interfaces/chain-archive-store.js";

/**
 * Real Postgres (testcontainers), a fully-controllable fake node RPC / indexer GraphQL (no
 * dependency on a live devnet, unlike `chain-archive-sync.integration.test.ts`) -- exercises the
 * sprint-fix round's Fix 1 and Fix 2 end to end through `ChainArchiveSyncService.syncOnce`, the
 * real production entry point, not just the underlying store methods in isolation. Also covers
 * the `syncOnce`-level consequence of Fix 3's `getHeightOf` validation.
 */

const NET = "retry_test_net";

function hx(n: number, tag: number): Hex32 {
  return (tag.toString(16).padStart(2, "0") + n.toString(16)).padStart(64, "0");
}

interface FakeChainBlock {
  height: number;
  hash: Hex32;
  parentHash: Hex32;
  stateRoot: Hex32;
  extrinsicsRoot: Hex32;
  /** hex, no 0x prefix -- must CONTAIN the indexer's reported tx raw hex as a substring, matching
   *  the real node/indexer byte-relationship `sync-service.ts` cross-checks. */
  extrinsics: string[];
  txHashes: Hex32[];
  txRawHex: string[];
  dParameter: { numPermissionedCandidates: number; numRegisteredCandidates: number };
}

function fakeChain(blocks: { height: number; dParamSeed: number }[]): FakeChainBlock[] {
  return blocks.map(({ height, dParamSeed }) => {
    const txRaw = Buffer.from(`tx-raw-${height}`, "utf8").toString("hex");
    return {
      height,
      hash: hx(height, 0xa),
      parentHash: height === 0 ? hx(0, 0x00) : hx(height - 1, 0xa),
      stateRoot: hx(height, 0xb),
      extrinsicsRoot: hx(height, 0xc),
      extrinsics: [txRaw],
      txHashes: [hx(height, 0xd)],
      txRawHex: [txRaw],
      dParameter: { numPermissionedCandidates: dParamSeed, numRegisteredCandidates: dParamSeed + 1 },
    };
  });
}

function fakeNodeFetch(blocks: FakeChainBlock[], finalizedHeight: number, badHeaderNumberForHash?: Hex32): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse((init as RequestInit).body as string) as { id: number; method: string; params: unknown[] };
    const { id, method, params } = body;
    let result: unknown;
    switch (method) {
      case "chain_getFinalizedHead":
        result = "0x" + blocks[finalizedHeight]!.hash;
        break;
      case "chain_getHeader": {
        const hash = (params[0] as string).replace(/^0x/, "");
        if (badHeaderNumberForHash !== undefined && hash === badHeaderNumberForHash) {
          result = { parentHash: "0x" + hx(0, 0), number: "not-a-valid-hex-number", stateRoot: "0x" + hx(0, 1), extrinsicsRoot: "0x" + hx(0, 2), digest: { logs: [] } };
        } else {
          const blk = blocks.find((b) => b.hash === hash)!;
          result = {
            parentHash: "0x" + blk.parentHash, number: "0x" + blk.height.toString(16),
            stateRoot: "0x" + blk.stateRoot, extrinsicsRoot: "0x" + blk.extrinsicsRoot, digest: { logs: [] },
          };
        }
        break;
      }
      case "chain_getBlockHash": {
        const height = params[0] as number;
        result = "0x" + blocks[height]!.hash;
        break;
      }
      case "chain_getBlock": {
        const hash = (params[0] as string).replace(/^0x/, "");
        const blk = blocks.find((b) => b.hash === hash)!;
        result = {
          block: {
            header: {
              parentHash: "0x" + blk.parentHash, number: "0x" + blk.height.toString(16),
              stateRoot: "0x" + blk.stateRoot, extrinsicsRoot: "0x" + blk.extrinsicsRoot, digest: { logs: [] },
            },
            extrinsics: blk.extrinsics.map((e) => "0x" + e),
          },
          justifications: null,
        };
        break;
      }
      default:
        throw new Error(`fakeNodeFetch: unhandled method ${method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200 });
  };
}

function fakeIndexerFetch(blocks: FakeChainBlock[]): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse((init as RequestInit).body as string) as { variables?: { height?: number } };
    const height = body.variables?.height;
    if (typeof height === "number") {
      const blk = blocks.find((b) => b.height === height);
      const data = {
        block: blk === undefined ? null : {
          hash: "0x" + blk.hash,
          height: blk.height,
          transactions: blk.txHashes.map((hash, i) => ({ hash: "0x" + hash, protocolVersion: 1, raw: blk.txRawHex[i] })),
          systemParameters: { dParameter: blk.dParameter },
        },
      };
      return new Response(JSON.stringify({ data }), { status: 200 });
    }
    const maxHeight = Math.max(...blocks.map((b) => b.height));
    return new Response(JSON.stringify({ data: { block: { height: maxHeight } } }), { status: 200 });
  };
}

describe("ChainArchiveSyncService retry safety (sprint-fix round Fixes 1-3)", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  let schemaCounter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  afterEach(async () => {
    await sql?.end({ timeout: 5 });
  });

  async function newService(blocks: FakeChainBlock[], finalizedHeight: number, opts?: { badHeaderNumberForHash?: Hex32 }) {
    const schema = `retry_test_${schemaCounter++}`;
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await bootstrapChainArchiveSchema(sql, schema);
    const service = new ChainArchiveSyncService({
      sql, net: NET, schema,
      node: { url: "http://fake-node", fetchImpl: fakeNodeFetch(blocks, finalizedHeight, opts?.badHeaderNumberForHash) },
      indexer: { url: "http://fake-indexer", fetchImpl: fakeIndexerFetch(blocks) },
    });
    return { service, schema };
  }

  it("Fix 1: retrying after a partial legacy-style write (block row already present, transactions/bridge_observations missing) succeeds instead of duplicate-key-erroring", async () => {
    const blocks = fakeChain([{ height: 0, dParamSeed: 1 }]);
    const { service } = await newService(blocks, 0);

    // Reproduces exactly what the OLD (pre-fix) ingestOneBlock could leave behind: the block row
    // committed via a bare putBlock call, but transactions/bridge_observations never wrote.
    const blk = blocks[0]!;
    await service.store.putBlock({
      net: NET, blockHash: blk.hash, height: 0, parentHash: blk.parentHash,
      stateRoot: blk.stateRoot, extrinsicsRoot: blk.extrinsicsRoot,
      headerBytes: new TextEncoder().encode("placeholder-header"),
      bodyBytes: new TextEncoder().encode("placeholder-body"),
      isCanonical: true, status: "canonical", finalized: true,
    });

    // Under the OLD code, this threw a duplicate-key error on the blocks PK and wedged
    // permanently. Under the fix, it completes the missing transaction/bridge-observation rows.
    const result = await service.syncOnce({ maxBlocks: 1 });
    expect(result.ingestedBlocks).toBe(1);
    expect(await service.getSyncedHeight()).toBe(0);

    const archivedTx = await service.store.getTransactionsByHash(NET, blk.txHashes[0]!);
    expect(archivedTx).toHaveLength(1);
  }, 60_000);

  it("Fix 1: retrying an already-fully-committed height at the sync-service layer (simulating a crash between ingestion succeeding and the watermark write) is a safe no-op, not a duplicate-key error", async () => {
    const blocks = fakeChain([{ height: 0, dParamSeed: 1 }, { height: 1, dParamSeed: 1 }]);
    const { service } = await newService(blocks, 1);

    const first = await service.syncOnce({ maxBlocks: 2 });
    expect(first.ingestedBlocks).toBe(2);

    // Directly re-invoke the private per-block ingestion method for an already-fully-ingested
    // height, bypassing the watermark-driven skip -- this is precisely the retry shape a crash
    // between `ingestOneBlock` returning and `syncOnce`'s own `setWatermark` call would produce.
    const serviceInternal = service as unknown as { ingestOneBlock(height: number): Promise<void> };
    await expect(serviceInternal.ingestOneBlock(0)).resolves.toBeUndefined();

    const blocksAtZero = await service.store.getBlocksAtHeight(NET, 0);
    expect(blocksAtZero).toHaveLength(1); // no duplicate row created by the retry
  }, 60_000);

  it("Fix 2: the D-parameter dedup cursor is only advanced after a durable write succeeds -- a failed write does not silently drop the observation on retry", async () => {
    const blocks = fakeChain([{ height: 0, dParamSeed: 1 }, { height: 1, dParamSeed: 99 }]); // height 1's dParameter genuinely differs
    const { service, schema } = await newService(blocks, 1);

    await service.syncOnce({ maxBlocks: 1 }); // ingests height 0 only, cursor now reflects height 0's dParameter
    const cursorAfterHeight0 = (service as unknown as { lastDParameterJson: string | undefined }).lastDParameterJson;
    expect(cursorAfterHeight0).toBeDefined();

    // Simulate a transient failure on height 1's durable write specifically -- the exact scenario
    // Fix 2 addresses: the write for the block carrying the NEW dParameter value fails.
    const originalPutBlockBundle = service.store.putBlockBundle.bind(service.store);
    let shouldFail = true;
    service.store.putBlockBundle = async (bundle: BlockBundle) => {
      if (shouldFail && bundle.block.height === 1) {
        throw new Error("simulated transient write failure for height 1");
      }
      return originalPutBlockBundle(bundle);
    };

    await expect(service.syncOnce({ maxBlocks: 1 })).rejects.toThrow("simulated transient write failure");

    // The cursor must be UNCHANGED after the failed attempt -- under the pre-fix bug, it would
    // already have been advanced to height 1's value BEFORE the write was attempted, causing the
    // observation to be silently dropped on retry.
    const cursorAfterFailedAttempt = (service as unknown as { lastDParameterJson: string | undefined }).lastDParameterJson;
    expect(cursorAfterFailedAttempt).toBe(cursorAfterHeight0);

    // Now retry for real (write succeeds this time) -- the observation must actually land.
    shouldFail = false;
    const retryResult = await service.syncOnce({ maxBlocks: 1 });
    expect(retryResult.ingestedBlocks).toBe(1);

    const cursorAfterSuccess = (service as unknown as { lastDParameterJson: string | undefined }).lastDParameterJson;
    expect(cursorAfterSuccess).not.toBe(cursorAfterHeight0); // cursor now reflects height 1's dParameter

    // Proves the observation was NOT silently dropped by the earlier failed attempt -- it landed
    // for real once the retry succeeded.
    const obsRows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.bridge_observations WHERE net = ${NET} AND block_height = 1
    `;
    expect(obsRows[0]!.n).toBe(1);
  }, 60_000);

  it("Fix 3 (syncOnce-level consequence): a malformed node-reported block number surfaces a typed error from syncOnce instead of silently no-oping with a reported success", async () => {
    const blocks = fakeChain([{ height: 0, dParamSeed: 1 }]);
    const { service } = await newService(blocks, 0, { badHeaderNumberForHash: blocks[0]!.hash });

    // Under the pre-fix bug, `getHeightOf` silently produced NaN, `startHeight > NaN` was always
    // `false`, and `syncOnce` returned a normal-looking `{ ingestedBlocks: 0, ... }` "success"
    // instead of surfacing the real problem.
    await expect(service.syncOnce({ maxBlocks: 1 })).rejects.toBeInstanceOf(NodeRpcInvalidHeightError);
  }, 60_000);
});
