import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { PgChainArchiveStore } from "../../src/postgres/chain-archive-store.js";
import { rolloverDefaultPartition } from "../../src/postgres/chain-archive-rollover.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import { chainArchiveMigrations } from "../../src/postgres/migrations/chain_archive/index.js";

/**
 * AC-6 (partition/rollover correctness, verified with a real rollover event). The real migrated
 * schema pre-creates 5 bounded buckets of 1,000,000 heights each
 * (`CHAIN_ARCHIVE_HEIGHT_PARTITION_SIZE`/`CHAIN_ARCHIVE_PRECREATED_PARTITIONS`,
 * `partition-config.ts`) -- filling that to reach a real `DEFAULT`-overflow rollover scenario
 * would mean inserting 5,000,001+ rows, infeasible for a test's runtime. This test instead
 * proves BOTH halves of AC-6 for real, at a scale that fits a real test run:
 *
 *   1. Ingesting across the boundary BETWEEN TWO ALREADY-PRE-CREATED bounded buckets (height
 *      999,999 -> 1,000,000, the `blocks_p0`/`blocks_p1` boundary) -- no rollover mechanics
 *      needed here since both buckets already exist, but this is a real partition boundary a
 *      range query must span correctly, and IS exercised for real, not assumed.
 *   2. A genuine `DEFAULT`-partition rollover EVENT, run for real via
 *      `rolloverDefaultPartition` (`src/postgres/chain-archive-rollover.ts`, the executable
 *      implementation of the design doc's v4 runbook) -- rows inserted directly into `DEFAULT`
 *      (heights beyond the 5 pre-created buckets, i.e. >= 5,000,000, matching the real
 *      deployment's actual overflow condition) are correctly retired into a newly-created
 *      bounded partition, with zero data loss and a post-rollover write into the new range
 *      correctly routed (not into `DEFAULT`).
 */
describe("AC-6: partition/rollover correctness with a real rollover event", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  const schema = "chain_archive_rollover_test";
  const net = "rollover_net";

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await runMigrations(sql, { schema, migrations: chainArchiveMigrations });
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  });

  const h = (n: number, tag: number): string => (tag.toString(16).padStart(2, "0") + n.toString(16)).padStart(64, "0");

  it("a range query spanning an existing pre-created bucket boundary (blocks_p0/blocks_p1, height 1,000,000) returns the correct, complete result", async () => {
    const store = new PgChainArchiveStore(sql, schema);
    const boundary = 1_000_000; // CHAIN_ARCHIVE_HEIGHT_PARTITION_SIZE
    const below = boundary - 1;
    const above = boundary;

    await store.putBlock({
      net, blockHash: h(below, 0xb1), height: below, parentHash: h(0, 0), stateRoot: h(1, 0), extrinsicsRoot: h(2, 0),
      headerBytes: new TextEncoder().encode("header-below"), isCanonical: true, status: "canonical", finalized: true,
    });
    await store.putBlock({
      net, blockHash: h(above, 0xb2), height: above, parentHash: h(below, 0xb1), stateRoot: h(1, 0), extrinsicsRoot: h(2, 0),
      headerBytes: new TextEncoder().encode("header-above"), isCanonical: true, status: "canonical", finalized: true,
    });

    // Confirm the rows physically landed in the two DISTINCT pre-created partitions.
    const p0Count = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(schema)}.blocks_p0 WHERE height = ${below}`;
    const p1Count = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(schema)}.blocks_p1 WHERE height = ${above}`;
    expect(p0Count[0]!.n).toBe(1);
    expect(p1Count[0]!.n).toBe(1);

    const range = await store.getCanonicalChainRange(net, below, above);
    expect(range.map((b) => b.height)).toEqual([below, above]);
  });

  it("a real DEFAULT-partition rollover event: overflow rows beyond the 5 pre-created buckets are correctly retired into a new bounded partition with zero data loss", async () => {
    const store = new PgChainArchiveStore(sql, schema);
    const overflowNet = "rollover_default_net";
    // Heights beyond CHAIN_ARCHIVE_PRECREATED_PARTITIONS * CHAIN_ARCHIVE_HEIGHT_PARTITION_SIZE
    // (5,000,000) -- these genuinely land in DEFAULT under the real migrated schema, matching
    // the actual deployment's overflow condition (not a smaller synthetic re-shaped schema).
    const overflowHeights = [5_000_010, 5_000_020, 5_000_030];
    for (const height of overflowHeights) {
      await store.putBlock({
        net: overflowNet, blockHash: h(height, 0xd), height, parentHash: h(0, 0), stateRoot: h(1, 0), extrinsicsRoot: h(2, 0),
        headerBytes: new TextEncoder().encode(`header-overflow-${height}`), isCanonical: true, status: "canonical", finalized: true,
      });
    }
    // One matching transaction, to prove the transactions_default -> transactions_p5 retirement
    // (and its FK to blocks) survives the rollover too, not just blocks.
    await store.putTransactions([{
      net: overflowNet, txHash: h(5_000_010, 0xe), blockHeight: 5_000_010, blockHash: h(5_000_010, 0xd),
      position: 0, kind: "regular", protocolVersion: 1, rawBytes: new TextEncoder().encode("overflow-tx"),
    }]);

    const beforeDefaultCount = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(schema)}.blocks_default`;
    expect(beforeDefaultCount[0]!.n).toBe(3);

    await rolloverDefaultPartition(sql, schema, { lo: 5_000_000, hi: 6_000_000, suffix: "p5" });

    // Every original row present, now correctly repartitioned into blocks_p5 (not DEFAULT).
    const p5Blocks = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(schema)}.blocks_p5`;
    expect(p5Blocks[0]!.n).toBe(3);
    const afterDefaultCount = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(schema)}.blocks_default`;
    expect(afterDefaultCount[0]!.n).toBe(0);
    const p5Tx = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(schema)}.transactions_p5`;
    expect(p5Tx[0]!.n).toBe(1);

    // Every individually-ingested row is still retrievable via the normal store API, post-rollover.
    for (const height of overflowHeights) {
      const block = await store.getCanonicalBlockAtHeight(overflowNet, height);
      expect(block?.height).toBe(height);
    }
    const range = await store.getCanonicalChainRange(overflowNet, 5_000_000, 5_999_999);
    expect(range.map((b) => b.height)).toEqual(overflowHeights);

    // A write made AFTER the rollover into the newly-bounded range is accepted and correctly
    // routed into blocks_p5, not DEFAULT (proves the write-race window the v4 runbook rewrite
    // specifically closed is actually closed here, not just in the design doc's own transcript).
    const postRolloverHeight = 5_000_040;
    await store.putBlock({
      net: overflowNet, blockHash: h(postRolloverHeight, 0xd), height: postRolloverHeight,
      parentHash: h(5_000_030, 0xd), stateRoot: h(1, 0), extrinsicsRoot: h(2, 0),
      headerBytes: new TextEncoder().encode("header-post-rollover"), isCanonical: true, status: "canonical", finalized: true,
    });
    const p5AfterWrite = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(schema)}.blocks_p5`;
    expect(p5AfterWrite[0]!.n).toBe(4);
    const defaultAfterWrite = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(schema)}.blocks_default`;
    expect(defaultAfterWrite[0]!.n).toBe(0);

    // The FK is still correctly enforced post-rollover: a transaction referencing a nonexistent
    // block at a height inside the new p5 bucket is rejected.
    await expect(
      store.putTransactions([{
        net: overflowNet, txHash: h(999_999, 0xe), blockHeight: 5_000_050, blockHash: h(5_000_050, 0xff),
        position: 0, kind: "regular", protocolVersion: 1, rawBytes: new TextEncoder().encode("ghost-tx"),
      }]),
    ).rejects.toBeTruthy();
  }, 60_000);

  /**
   * Sol-audit fix round, Finding 3(b): genuine idempotency. A second invocation with the SAME
   * (suffix, lo, hi) after a fully-successful rollover must be a safe no-op -- previously it
   * detached/renamed the fresh DEFAULT partitions and then failed on the already-existing
   * `blocks_p5` name. Runs AFTER the real-rollover test above (vitest executes `it` blocks in
   * declaration order within a file), so `p5` genuinely exists in this schema.
   */
  it("Finding 3(b): re-running the same rollover (same suffix and bounds) is a safe no-op that leaves the hierarchy and data untouched", async () => {
    const before = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(schema)}.blocks_p5`;
    expect(before[0]!.n).toBeGreaterThanOrEqual(4); // the rows the previous test left behind

    await expect(
      rolloverDefaultPartition(sql, schema, { lo: 5_000_000, hi: 6_000_000, suffix: "p5" }),
    ).resolves.toBeUndefined();

    // Data untouched, hierarchy intact: p5 still attached with the same rows, DEFAULT still
    // exists and is still empty (a dismantled hierarchy would make either query throw).
    const after = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(schema)}.blocks_p5`;
    expect(after[0]!.n).toBe(before[0]!.n);
    const defaultCount = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(schema)}.blocks_default`;
    expect(defaultCount[0]!.n).toBe(0);
  }, 60_000);

  it("Finding 3(b): reusing an applied suffix with DIFFERENT bounds is rejected loudly, not guessed at", async () => {
    await expect(
      rolloverDefaultPartition(sql, schema, { lo: 6_000_000, hi: 7_000_000, suffix: "p5" }),
    ).rejects.toThrow(/DIFFERENT\s+bounds/);
  }, 60_000);

  /**
   * Sol-audit fix round, Finding 3(a): the whole rollover -- idempotency check, pre-flight, FK
   * lookups, DDL -- must run on the ONE reserved connection. Under `maxConnections: 1` (a
   * supported configuration of `createClient`), ANY mid-operation query against the general pool
   * would wait forever for the connection the rollover itself is holding. Running a real
   * rollover to completion on a 1-connection pool is therefore a direct no-self-deadlock proof,
   * not a code-reading argument. (vitest's per-test timeout turns a regression into a loud
   * failure rather than a hang.)
   */
  it("Finding 3(a): a real rollover completes on a maxConnections: 1 pool -- no self-deadlock from mid-operation general-pool queries", async () => {
    const schema1 = "chain_archive_rollover_m1";
    const sql1 = createClient({
      connectionString: container.getConnectionUri(), schema: schema1, maxConnections: 1,
    });
    try {
      await runMigrations(sql1, { schema: schema1, migrations: chainArchiveMigrations });
      const store1 = new PgChainArchiveStore(sql1, schema1);
      const overflowHeight = 5_000_100;
      await store1.putBlock({
        net, blockHash: h(overflowHeight, 0xd), height: overflowHeight, parentHash: h(0, 0),
        stateRoot: h(1, 0), extrinsicsRoot: h(2, 0),
        headerBytes: new TextEncoder().encode("m1-overflow-header"),
        isCanonical: true, status: "canonical", finalized: true,
      });

      await rolloverDefaultPartition(sql1, schema1, { lo: 5_000_000, hi: 6_000_000, suffix: "p5" });

      const p5 = await sql1<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql1(schema1)}.blocks_p5`;
      expect(p5[0]!.n).toBe(1);
      // And the idempotent no-op retry also completes on the same 1-connection pool.
      await rolloverDefaultPartition(sql1, schema1, { lo: 5_000_000, hi: 6_000_000, suffix: "p5" });
    } finally {
      await sql1.end({ timeout: 5 });
    }
  }, 120_000);

  /**
   * Sol-audit fix round, Finding 2: every caller-controlled value interpolated into the
   * rollover's raw DDL is validated BEFORE any SQL is issued. The `sql` handle passed here is a
   * poisoned proxy whose every use throws -- so these tests fail unless the validation genuinely
   * fires first, proving rejection happens before any interpolation/execution, not after.
   */
  describe("Finding 2: schema/suffix/bounds validation fires before any SQL", () => {
    const poisonedSql = new Proxy(() => {}, {
      get() { throw new Error("SQL was used before validation"); },
      apply() { throw new Error("SQL was used before validation"); },
    }) as unknown as Parameters<typeof rolloverDefaultPartition>[0];

    it("rejects a SQL-injection-shaped schema name", async () => {
      await expect(
        rolloverDefaultPartition(poisonedSql, 'x"; DROP TABLE blocks; --', { lo: 0, hi: 10, suffix: "p9" }),
      ).rejects.toThrow(/invalid schema name/);
    });

    it("rejects a SQL-injection-shaped partition suffix", async () => {
      await expect(
        rolloverDefaultPartition(poisonedSql, "safe_schema", { lo: 0, hi: 10, suffix: 'p9" FOR VALUES FROM (0) TO (1); DROP TABLE blocks; --' }),
      ).rejects.toThrow(/invalid rollover partition suffix/);
    });

    it("rejects an over-length partition suffix that Postgres would silently truncate", async () => {
      await expect(
        rolloverDefaultPartition(poisonedSql, "safe_schema", { lo: 0, hi: 10, suffix: "p".padEnd(60, "x") }),
      ).rejects.toThrow(/identifier limit/);
    });

    it("rejects non-integer and malformed bucket bounds", async () => {
      await expect(
        rolloverDefaultPartition(poisonedSql, "safe_schema", { lo: "0); DROP TABLE blocks; --" as unknown as number, hi: 10, suffix: "p9" }),
      ).rejects.toThrow(/invalid rollover bucket bound/);
      await expect(
        rolloverDefaultPartition(poisonedSql, "safe_schema", { lo: 0.5, hi: 10, suffix: "p9" }),
      ).rejects.toThrow(/invalid rollover bucket bound/);
      await expect(
        rolloverDefaultPartition(poisonedSql, "safe_schema", { lo: -1, hi: 10, suffix: "p9" }),
      ).rejects.toThrow(/invalid rollover bucket bound/);
      await expect(
        rolloverDefaultPartition(poisonedSql, "safe_schema", { lo: 10, hi: 10, suffix: "p9" }),
      ).rejects.toThrow(/lo \(10\) must be < hi \(10\)/);
    });
  });
});
