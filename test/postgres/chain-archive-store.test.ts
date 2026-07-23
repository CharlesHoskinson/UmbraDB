import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { PgChainArchiveStore } from "../../src/postgres/chain-archive-store.js";
import { BlobIntegrityError, BlobMissingError } from "../../src/interfaces/chain-archive-store.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import { chainArchiveMigrations } from "../../src/postgres/migrations/chain_archive/index.js";

/**
 * Real Postgres 17 (testcontainers), not mocked -- exercises `PgChainArchiveStore`
 * (`src/postgres/chain-archive-store.ts`) end-to-end against the actual migrated schema, mapped
 * directly to the acceptance criteria the implementation sprint's task requires:
 *
 *   - AC-2 (canonical-chain uniqueness, the "reorg flip is a single observable state transition"
 *     scenario): `setCanonical`'s atomic flip, observed by a genuinely concurrent second
 *     connection mid-flip.
 *   - AC-3 (content-addressed blob integrity + corruption detection on read): round-trip via
 *     `getBlob`, then an out-of-band `UPDATE` corrupting the stored bytes directly, proving the
 *     next read is rejected rather than silently served.
 *   - AC-5 (chain identity isolation across networks): two networks with a deliberately
 *     COLLIDING (height, block_hash) pair, proving every read path stays scoped to `net`.
 *   - AC-10 (core query patterns use an index, not a sequential scan, at realistic volume):
 *     `EXPLAIN` against get-block-by-height, get-transaction-by-hash, and get-canonical-range,
 *     after ingesting enough rows that a sequential scan would be the planner's fallback if no
 *     usable index/partition-pruning existed.
 */
describe("PgChainArchiveStore", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  let store: PgChainArchiveStore;
  const schema = "chain_archive_store_test";

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await runMigrations(sql, { schema, migrations: chainArchiveMigrations });
    store = new PgChainArchiveStore(sql, schema);
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  });

  const h = (n: number, tag = 0): string => (tag.toString(16).padStart(2, "0") + n.toString(16)).padStart(64, "0");

  function makeBlock(net: string, height: number, blockHash: string, parentHash: string, tag = 0) {
    return {
      net, blockHash, height,
      parentHash,
      stateRoot: h(1, tag), extrinsicsRoot: h(2, tag),
      headerBytes: new TextEncoder().encode(`header-${net}-${height}-${blockHash}`),
      bodyBytes: new TextEncoder().encode(`body-${net}-${height}-${blockHash}`),
      isCanonical: false, status: "seen" as const, finalized: false,
    };
  }

  it("AC-3: a stored blob round-trips and its content matches its key", async () => {
    const bytes = new TextEncoder().encode("ac3-round-trip-payload");
    const hash = await store.putBlobWithRole(bytes, "tx_raw");
    const readBack = await store.getBlob(hash);
    expect(Buffer.from(readBack).toString("utf8")).toBe("ac3-round-trip-payload");
  });

  it("AC-3: out-of-band corruption of stored bytes is caught on the next read (typed integrity error), not silently served", async () => {
    const bytes = new TextEncoder().encode("ac3-corruption-payload");
    const hash = await store.putBlobWithRole(bytes, "tx_raw");
    // Direct UPDATE bypassing the store's own write path entirely -- the out-of-band mutation
    // the AC scenario specifically requires, not a re-write through putBlobWithRole.
    await sql`UPDATE ${sql(schema)}.chain_blobs SET data = ${Buffer.from("tampered-bytes-here")} WHERE hash = ${Buffer.from(hash, "hex")}`;
    await expect(store.getBlob(hash)).rejects.toBeInstanceOf(BlobIntegrityError);
  });

  it("AC-3: reading a hash with no chain_blobs row throws BlobMissingError", async () => {
    await expect(store.getBlob(h(999))).rejects.toBeInstanceOf(BlobMissingError);
  });

  it("AC-2: setCanonical performs a single observable state transition -- a concurrent reader never sees zero or two canonical rows", async () => {
    const net = "ac2_net";
    const height = 500;
    const blockA = h(500, 0xa);
    const blockB = h(500, 0xb);
    const genesisParent = h(0);
    await store.putBlock(makeBlock(net, height, blockA, genesisParent, 0xa));
    await store.putBlock(makeBlock(net, height, blockB, genesisParent, 0xb));

    await store.setCanonical(net, height, blockA);
    let canonical = await store.getCanonicalBlockAtHeight(net, height);
    expect(canonical?.blockHash).toBe(blockA);

    // The reorg flip itself, from a second connection concurrently polling mid-flip -- must
    // never observe two canonical rows OR zero canonical rows (the spec's own scenario wording:
    // "it SHALL observe exactly one canonical row (A before the flip, B after) -- never zero,
    // never both"). Sol-audit fix round, Finding 5: the previous version of this test (a)
    // tolerated "NONE" observations, directly contradicting the never-zero clause, and (b)
    // could pass with ZERO observations recorded if the flip completed before the poller's
    // first iteration -- both vacuities removed: the poller is now required to record real
    // observations both BEFORE and AFTER the flip, and NONE/MULTIPLE are both hard failures.
    const observations: string[] = [];
    let polling = true;
    const poller = (async () => {
      const sql2 = createClient({ connectionString: container.getConnectionUri(), schema });
      try {
        while (polling) {
          const rows = await sql2<{ block_hash: Buffer }[]>`
            SELECT block_hash FROM ${sql2(schema)}.blocks
            WHERE net = ${net} AND height = ${height} AND is_canonical
          `;
          observations.push(rows.length === 0 ? "NONE" : rows.length > 1 ? "MULTIPLE" : rows[0]!.block_hash.toString("hex"));
        }
      } finally {
        await sql2.end({ timeout: 5 });
      }
    })();
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    // The poller must genuinely observe the PRE-flip state before we flip...
    while (observations.length < 3) await sleep(5);
    await store.setCanonical(net, height, blockB);
    // ...and the POST-flip state before we stop -- so this test cannot pass on an empty or
    // pre-flip-only observation log.
    const lengthAtFlip = observations.length;
    while (observations.length < lengthAtFlip + 3) await sleep(5);
    polling = false;
    await poller;

    expect(observations.length).toBeGreaterThanOrEqual(6);
    expect(observations).not.toContain("MULTIPLE"); // never both
    expect(observations).not.toContain("NONE"); // never zero
    expect(observations.every((o) => o === blockA || o === blockB)).toBe(true);
    expect(observations[0]).toBe(blockA); // A before the flip
    expect(observations[observations.length - 1]).toBe(blockB); // B after
    // Exactly one transition: once B is observed, A never reappears.
    const firstB = observations.indexOf(blockB);
    expect(firstB).toBeGreaterThan(0);
    expect(observations.slice(firstB).every((o) => o === blockB)).toBe(true);

    canonical = await store.getCanonicalBlockAtHeight(net, height);
    expect(canonical?.blockHash).toBe(blockB);

    // blockA's row still exists, just no longer canonical (AC-1's "reorg does not delete the
    // losing fork's data" property, exercised here at the store layer).
    const all = await store.getBlocksAtHeight(net, height);
    expect(all.map((b) => b.blockHash).sort()).toEqual([blockA, blockB].sort());
    expect(all.find((b) => b.blockHash === blockA)?.isCanonical).toBe(false);
  });

  it("AC-2 (mutation-test evidence): the DB-level enforcement really does reject a raw dual-canonical UPDATE, independent of application code", async () => {
    // Adversarial: bypass PgChainArchiveStore entirely and issue the two raw UPDATEs by hand --
    // proves the partial unique index (not merely setCanonical's ordering) is what rejects this.
    const net = "ac2_raw_net";
    const height = 600;
    const blockA = h(600, 0xa);
    const blockB = h(600, 0xb);
    await store.putBlock(makeBlock(net, height, blockA, h(0), 0xa));
    await store.putBlock(makeBlock(net, height, blockB, h(0), 0xb));
    await sql`UPDATE ${sql(schema)}.blocks SET status = 'canonical', is_canonical = true
              WHERE net = ${net} AND height = ${height} AND block_hash = ${Buffer.from(blockA, "hex")}`;
    await expect(
      sql`UPDATE ${sql(schema)}.blocks SET status = 'canonical', is_canonical = true
          WHERE net = ${net} AND height = ${height} AND block_hash = ${Buffer.from(blockB, "hex")}`,
    ).rejects.toMatchObject({ code: "23505" });
  });

  /**
   * Sol-audit fix round, Finding 5: this test now exercises AC-1's ACTUAL scenario shape --
   * complete competing transaction SETS ({t1, t2, t3} vs {t1, t4}, t1's hash shared with
   * distinct bytes, exactly the spec's example), verified for COMPLETENESS per fork via the
   * public `getTransactionsForBlock` enumeration added for this purpose (previously only the
   * one shared transaction was inserted, and no public method could enumerate a block's full
   * set to check nothing was lost). Also covers the spec's second scenario: a reorg marking A
   * non-canonical must not delete A's transaction rows (previously only the block ROW's
   * survival was checked, never its transactions).
   */
  it("AC-1: competing blocks at one height, sharing a tx hash, both persist with their COMPLETE transaction sets -- and a reorg preserves the losing fork's transaction rows", async () => {
    const net = "ac1_net";
    const height = 700;
    const blockA = h(700, 0xa);
    const blockB = h(700, 0xb);
    await store.putBlock(makeBlock(net, height, blockA, h(0), 0xa));
    await store.putBlock(makeBlock(net, height, blockB, h(0), 0xb));

    // Block A carries {t1, t2, t3}; competing block B carries {t1, t4} -- t1's HASH is shared
    // across both blocks (distinct bytes/position permitted, per the spec's own scenario).
    const t1 = h(701);
    const t2 = h(702);
    const t3 = h(703);
    const t4 = h(704);
    const tx = (txHash: string, blockHash: string, position: number, raw: string) => ({
      net, txHash, blockHeight: height, blockHash, position,
      kind: "regular" as const, protocolVersion: 1, rawBytes: new TextEncoder().encode(raw),
    });
    // Neither insert may raise a uniqueness violation caused by the shared hash alone.
    await store.putTransactions([
      tx(t1, blockA, 0, "t1-bytes-in-A"), tx(t2, blockA, 1, "t2-bytes"), tx(t3, blockA, 2, "t3-bytes"),
    ]);
    await store.putTransactions([
      tx(t1, blockB, 0, "t1-bytes-in-B"), tx(t4, blockB, 1, "t4-bytes"),
    ]);

    // Both blocks retrievable at height H by their own hashes.
    const blocksAtH = await store.getBlocksAtHeight(net, height);
    expect(blocksAtH.map((b) => b.blockHash).sort()).toEqual([blockA, blockB].sort());

    // COMPLETE per-fork transaction sets, scoped to each block -- nothing missing, nothing
    // leaked across forks, positions intact.
    const setA = await store.getTransactionsForBlock(net, blockA);
    expect(setA.map((t) => t.txHash)).toEqual([t1, t2, t3]); // ordered by position
    expect(setA.map((t) => t.position)).toEqual([0, 1, 2]);
    const setB = await store.getTransactionsForBlock(net, blockB);
    expect(setB.map((t) => t.txHash)).toEqual([t1, t4]);
    expect(setB.map((t) => t.position)).toEqual([0, 1]);

    // The shared hash resolves to BOTH inclusion records, each with its own distinct bytes.
    const both = await store.getTransactionsByHash(net, t1);
    expect(both).toHaveLength(2);
    expect(both.map((t) => t.blockHash).sort()).toEqual([blockA, blockB].sort());
    const bytesByBlock = new Map<string, string>();
    for (const meta of both) {
      bytesByBlock.set(meta.blockHash, Buffer.from(await store.getBlob(meta.rawBlobHash)).toString("utf8"));
    }
    expect(bytesByBlock.get(blockA)).toBe("t1-bytes-in-A");
    expect(bytesByBlock.get(blockB)).toBe("t1-bytes-in-B");

    // Reorg: B's fork wins, A is marked non-canonical -- A's block row AND its full transaction
    // set must remain queryable (the archive's "recovery source of last resort" property).
    await store.setCanonical(net, height, blockB);
    const losingBlock = (await store.getBlocksAtHeight(net, height)).find((b) => b.blockHash === blockA);
    expect(losingBlock).toBeDefined();
    expect(losingBlock!.isCanonical).toBe(false);
    const losingSet = await store.getTransactionsForBlock(net, blockA);
    expect(losingSet.map((t) => t.txHash)).toEqual([t1, t2, t3]); // not cascade-deleted, complete
  });

  it("AC-5: two networks with a COLLIDING (height, block_hash) pair never leak into each other's query results", async () => {
    const height = 800;
    const collidingHash = h(800, 0xc); // deliberately identical block_hash across both networks
    await store.putBlock(makeBlock("net_alpha", height, collidingHash, h(0), 0xc));
    await store.putBlock(makeBlock("net_beta", height, collidingHash, h(0), 0xc));
    await store.setCanonical("net_alpha", height, collidingHash);
    await store.setCanonical("net_beta", height, collidingHash);

    const alphaBlocks = await store.getBlocksAtHeight("net_alpha", height);
    const betaBlocks = await store.getBlocksAtHeight("net_beta", height);
    expect(alphaBlocks).toHaveLength(1);
    expect(betaBlocks).toHaveLength(1);
    expect(alphaBlocks[0]!.net).toBe("net_alpha");
    expect(betaBlocks[0]!.net).toBe("net_beta");

    const alphaRange = await store.getCanonicalChainRange("net_alpha", height, height);
    expect(alphaRange.every((b) => b.net === "net_alpha")).toBe(true);
    const betaRange = await store.getCanonicalChainRange("net_beta", height, height);
    expect(betaRange.every((b) => b.net === "net_beta")).toBe(true);
  });

  /**
   * Sol-audit fix round, Finding 5: real store-level coverage for `putVerifierKeyObservation` --
   * previously the only "verifier key" test queried an empty table via a sync service that never
   * calls this method at all (see `chain-archive-sync.integration.test.ts`'s honesty rewrite).
   * The SYNC-side ingestion remains explicitly unimplemented
   * (`ChainArchiveSyncService.INGESTS_VERIFIER_KEYS === false`); the WRITE PATH itself is real
   * and exercised here against real Postgres, including the documented LEAST-upsert semantics.
   */
  it("putVerifierKeyObservation: writes the blob + observation row, and repeated observations collapse via LEAST(first_seen_height), never a unique violation", async () => {
    const vkBytes = new TextEncoder().encode("verifier-key[v6]-test-payload");
    const record = {
      vkBytes, net: "vk_net", scope: "protocol" as const, tag: "spend_v6", firstSeenHeight: 100,
    };
    await store.putVerifierKeyObservation(record);

    const rows = await sql<{ scope: string; tag: string; first_seen_height: bigint }[]>`
      SELECT scope, tag, first_seen_height FROM ${sql(schema)}.verifier_key_observations WHERE net = 'vk_net'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scope).toBe("protocol");
    expect(rows[0]!.tag).toBe("spend_v6");
    expect(Number(rows[0]!.first_seen_height)).toBe(100);

    // A LATER re-observation of the same context must not raise and must keep the EARLIER height.
    await store.putVerifierKeyObservation({ ...record, firstSeenHeight: 250 });
    // An EARLIER observation must lower it (LEAST semantics), still exactly one row.
    await store.putVerifierKeyObservation({ ...record, firstSeenHeight: 40 });
    const after = await sql<{ first_seen_height: bigint }[]>`
      SELECT first_seen_height FROM ${sql(schema)}.verifier_key_observations WHERE net = 'vk_net'
    `;
    expect(after).toHaveLength(1);
    expect(Number(after[0]!.first_seen_height)).toBe(40);

    // The vk bytes themselves are a real, hash-verified blob (AC-3 applies to this category too).
    const blobHash = await sql<{ vk_hash: Buffer }[]>`
      SELECT vk_hash FROM ${sql(schema)}.verifier_key_observations WHERE net = 'vk_net'
    `;
    const readBack = await store.getBlob(blobHash[0]!.vk_hash.toString("hex"));
    expect(Buffer.from(readBack).toString("utf8")).toBe("verifier-key[v6]-test-payload");
  });

  it("watermarks: set/get round-trips and is scoped to the chain_archive schema's own local table (not tier1_wallet's)", async () => {
    await store.setWatermark("canonical_tip:ac_watermark_net", { height: 12345 });
    const got = await store.getWatermark("canonical_tip:ac_watermark_net");
    expect(got).toEqual({ height: 12345 });
    const missing = await store.getWatermark("never_set_key");
    expect(missing).toBeUndefined();
  });

  /**
   * Fix 5 (sprint-fix round, MEDIUM): nothing previously prevented two overlapping `syncOnce()`
   * calls from racing `setWatermark`, and the plain last-write-wins upsert let a
   * slower/lagging call finishing AFTER a faster one silently regress the stored cursor
   * backward -- which then makes the next sync attempt re-process already-ingested heights and
   * hit the duplicate-key wedge Fix 1 addresses. This test genuinely exercises the regression
   * scenario (a LOWER height written after a HIGHER one, exactly what a lagging concurrent
   * caller would do) and confirms the guard actually rejects it, not merely that a monotonic
   * write succeeds (which a trivial last-write-wins implementation would also pass).
   */
  it("Fix 5: setWatermark never regresses the stored height -- a lower height written after a higher one is silently dropped, a genuinely higher one still advances it", async () => {
    const key = "canonical_tip:ac_watermark_monotonic_net";
    await store.setWatermark(key, { height: 10 });
    expect(await store.getWatermark(key)).toEqual({ height: 10 });

    // Simulates a slower/lagging concurrent syncOnce() call finishing AFTER a faster one already
    // advanced the cursor past it -- must be a silent no-op, not a regression.
    await store.setWatermark(key, { height: 5 });
    expect(await store.getWatermark(key)).toEqual({ height: 10 });

    // A genuinely later write (the normal, non-racing case) must still advance the cursor.
    await store.setWatermark(key, { height: 11 });
    expect(await store.getWatermark(key)).toEqual({ height: 11 });

    // Equal height (a legitimate no-op retry of the same progress) does not error and leaves the
    // stored value unchanged.
    await store.setWatermark(key, { height: 11 });
    expect(await store.getWatermark(key)).toEqual({ height: 11 });
  });

  /**
   * Fix 1 (sprint-fix round, HIGH): `putBlockBundle` is the new atomic block+transactions+
   * bridge-observations write `chain-archive-sync/sync-service.ts` now uses instead of three
   * separately-committed calls. These tests exercise the two real retry shapes the 3-reviewer
   * review identified: retrying an already-FULLY-committed bundle (e.g. the caller's own
   * watermark write crashed after this succeeded), and retrying after a PARTIAL legacy-style
   * write (what the old `putBlock`-then-`putTransactions`-then-`putBridgeObservations` sequence
   * could leave behind on a crash between steps) -- both must succeed as a no-op/completion
   * rather than a duplicate-key error, which is exactly the bug the reviewers reproduced.
   */
  describe("Fix 1: putBlockBundle idempotency", () => {
    function bundleFixture(net: string, height: number, blockHash: string, parentHash: string, tag: number) {
      const block = makeBlock(net, height, blockHash, parentHash, tag);
      const txHash = h(height, 0x9);
      return {
        block: { ...block, isCanonical: true, status: "canonical" as const, finalized: true },
        transactions: [{
          net, txHash, blockHeight: height, blockHash, position: 0,
          kind: "regular" as const, protocolVersion: 1,
          rawBytes: new TextEncoder().encode(`tx-${net}-${height}`),
        }],
        bridgeObservations: [{
          net, blockHeight: height, blockHash, observationIndex: 0,
          kind: "system_parameters_d" as const,
          rawBytes: new TextEncoder().encode(`obs-${net}-${height}`),
        }],
      };
    }

    it("retrying an identical bundle after a full commit is a safe no-op, not a duplicate-key error, and does not create duplicate rows", async () => {
      const net = "fix1_full_retry_net";
      const height = 900;
      const blockHash = h(900, 0xa);
      const bundle = bundleFixture(net, height, blockHash, h(0), 0xa);

      await store.putBlockBundle(bundle);
      // The exact same bundle again -- simulates a crash between this call durably succeeding
      // and the caller's own watermark write committing, causing a later syncOnce() to retry
      // this exact height from scratch.
      await expect(store.putBlockBundle(bundle)).resolves.toBeDefined();

      const blocks = await store.getBlocksAtHeight(net, height);
      expect(blocks).toHaveLength(1);
      const txs = await store.getTransactionsByHash(net, bundle.transactions[0]!.txHash);
      expect(txs).toHaveLength(1);
      const obsRows = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM ${sql(schema)}.bridge_observations
        WHERE net = ${net} AND block_height = ${height}
      `;
      expect(obsRows[0]!.n).toBe(1);
    });

    it("retrying after a partial legacy-style write (block row already committed by a bare putBlock, transactions/bridge_observations missing) completes the missing rows instead of duplicate-key-erroring", async () => {
      const net = "fix1_partial_retry_net";
      const height = 901;
      const blockHash = h(901, 0xa);
      const bundle = bundleFixture(net, height, blockHash, h(0), 0xa);

      // Reproduces exactly what the OLD (pre-fix) `ingestOneBlock` could leave behind: `putBlock`
      // committed on its own, but the transactions/bridge_observations writes never ran (crash,
      // transient error, or the indexer-not-caught-up throw that used to happen AFTER putBlock).
      await store.putBlock(bundle.block);

      // The retry -- under the OLD code this hit a duplicate-key error on the `blocks` PK and
      // wedged permanently. Under the fix, the block insert is a no-op (ON CONFLICT DO NOTHING)
      // and the previously-missing transactions/bridge_observations rows are written for real.
      await expect(store.putBlockBundle(bundle)).resolves.toBeDefined();

      const blocks = await store.getBlocksAtHeight(net, height);
      expect(blocks).toHaveLength(1); // still exactly one row, not duplicated
      const txs = await store.getTransactionsByHash(net, bundle.transactions[0]!.txHash);
      expect(txs).toHaveLength(1); // the previously-missing transaction is now present
      const obsRows = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM ${sql(schema)}.bridge_observations
        WHERE net = ${net} AND block_height = ${height}
      `;
      expect(obsRows[0]!.n).toBe(1); // the previously-missing bridge observation is now present
    });
  });

  describe("AC-10: core access patterns use an index, not a sequential scan, at realistic volume", () => {
    const net = "ac10_net";
    const ROW_COUNT = 8_000;

    beforeAll(async () => {
      // Realistic-enough volume that a sequential scan would be the planner's honest fallback if
      // no usable index/partition-pruning existed -- inserted via bulk raw SQL (not
      // store.putBlock() one row at a time -- that would dominate this test's runtime with N
      // separate transactions for no benefit; this is a volume-generation step, not a
      // functional-behavior test of putBlock itself, which is already covered above).
      const headerHash = await store.putBlobWithRole(new TextEncoder().encode("ac10-shared-header"), "block_header");
      interface BlockRow {
        net: string; block_hash: Buffer; height: number; parent_hash: Buffer; state_root: Buffer;
        extrinsics_root: Buffer; header_blob_hash: Buffer; is_canonical: boolean; status: string; finalized: boolean;
      }
      const values: BlockRow[] = [];
      for (let i = 0; i < ROW_COUNT; i++) {
        values.push({
          net, block_hash: Buffer.from(h(i, 0xf), "hex"), height: i,
          parent_hash: Buffer.from(h(Math.max(0, i - 1), 0xf), "hex"),
          state_root: Buffer.from(h(1, 0), "hex"), extrinsics_root: Buffer.from(h(2, 0), "hex"),
          header_blob_hash: Buffer.from(headerHash, "hex"), is_canonical: true, status: "canonical", finalized: false,
        });
      }
      // Chunked INSERT via postgres.js's array-of-objects bulk-insert helper (not an array of
      // plain arrays -- that overload's `EscapableArray` type is `(string|number)[]`, which does
      // not admit `Buffer` values; the array-of-objects form does, one column type-cast per
      // key). Keeps any single statement's parameter count reasonable.
      const CHUNK = 500;
      for (let i = 0; i < values.length; i += CHUNK) {
        const chunk = values.slice(i, i + CHUNK);
        await sql`
          INSERT INTO ${sql(schema)}.blocks ${sql(
            chunk, "net", "block_hash", "height", "parent_hash", "state_root",
            "extrinsics_root", "header_blob_hash", "is_canonical", "status", "finalized",
          )}
        `;
      }
      interface TxRow {
        net: string; tx_hash: Buffer; block_height: number; block_hash: Buffer;
        position: number; kind: string; protocol_version: number; raw_blob_hash: Buffer;
      }
      const txValues: TxRow[] = [];
      const rawHash = await store.putBlobWithRole(new TextEncoder().encode("ac10-shared-tx-raw"), "tx_raw");
      for (let i = 0; i < ROW_COUNT; i++) {
        txValues.push({
          net, tx_hash: Buffer.from(h(i, 0x7), "hex"), block_height: i, block_hash: Buffer.from(h(i, 0xf), "hex"),
          position: 0, kind: "regular", protocol_version: 1, raw_blob_hash: Buffer.from(rawHash, "hex"),
        });
      }
      for (let i = 0; i < txValues.length; i += CHUNK) {
        const chunk = txValues.slice(i, i + CHUNK);
        await sql`
          INSERT INTO ${sql(schema)}.transactions ${sql(
            chunk, "net", "tx_hash", "block_height", "block_hash", "position", "kind", "protocol_version", "raw_blob_hash",
          )}
        `;
      }
      await sql`ANALYZE ${sql(schema)}.blocks`;
      await sql`ANALYZE ${sql(schema)}.transactions`;
    }, 180_000);

    it("get-block-by-height uses an index scan, not a Seq Scan", async () => {
      const plan = await sql.unsafe(
        `EXPLAIN (FORMAT TEXT) SELECT * FROM "${schema}".blocks WHERE net = $1 AND height = $2`,
        [net, 4321],
      );
      const text = (plan as unknown as { "QUERY PLAN": string }[]).map((r) => r["QUERY PLAN"]).join("\n");
      expect(text).not.toMatch(/Seq Scan/);
    });

    it("get-transaction-by-hash uses an index scan on the populated partition, not a sequential scan of live data", async () => {
      // tx_hash is NOT the partition key (block_height is), so this query cannot be
      // partition-pruned the way the height-keyed queries above are -- Postgres correctly
      // `Append`s a per-partition plan across every partition, INCLUDING the four empty
      // pre-created buckets (transactions_p1..p4) and transactions_default that this test's
      // ROW_COUNT=8,000 rows (all within height [0, 8000), i.e. entirely inside transactions_p0)
      // never touched. For a genuinely EMPTY child relation, Postgres's own planner correctly
      // picks a trivial `Seq Scan (cost=0.00..0.00 rows=... )` over that zero-row table -- there
      // is nothing to index, and a "sequential scan of zero rows" is not the O(n) live-data
      // sequential scan this AC exists to rule out. The real, meaningful assertion is that the
      // ONE partition that actually holds the matching data (`transactions_p0`) is accessed via
      // an index scan, not a scan of its live rows -- confirmed two ways: (a) the plan contains
      // a real `Index Scan`, and (b) no `Seq Scan` line names `transactions_p0` specifically.
      const plan = await sql.unsafe(
        `EXPLAIN (FORMAT TEXT) SELECT * FROM "${schema}".transactions WHERE tx_hash = $1`,
        [Buffer.from(h(4321, 0x7), "hex")],
      );
      const text = (plan as unknown as { "QUERY PLAN": string }[]).map((r) => r["QUERY PLAN"]).join("\n");
      expect(text).toMatch(/Index Scan/);
      expect(text).not.toMatch(/Seq Scan on transactions_p0/);
    });

    it("get-canonical-chain-in-range uses an index/partition-pruned scan, not a full Seq Scan", async () => {
      const plan = await sql.unsafe(
        `EXPLAIN (FORMAT TEXT) SELECT * FROM "${schema}".blocks WHERE net = $1 AND height BETWEEN $2 AND $3 AND is_canonical`,
        [net, 1000, 1100],
      );
      const text = (plan as unknown as { "QUERY PLAN": string }[]).map((r) => r["QUERY PLAN"]).join("\n");
      expect(text).not.toMatch(/Seq Scan/);
    });
  });
});
