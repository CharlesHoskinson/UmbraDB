import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "../../src/postgres/client.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import { chainArchiveMigrations } from "../../src/postgres/migrations/chain_archive/index.js";

/**
 * Closes the v3 audit's "no committed automated test for the new lineage" gap
 * (`design/full-chain-storage-design.md` §5's own note that `chainArchiveMigrations` was
 * empirically applied by hand during the v2/v3 revisions but never exercised by a committed
 * test). Real Postgres 17 via testcontainers, matching every other test in this directory —
 * not a mock, not an assertion about SQL text.
 *
 * Deliberately ONE test (not a `describe` full of small ones): the task this closes asks for a
 * single test that walks fresh-apply -> idempotent re-run -> a fork scenario -> the two
 * violation cases end-to-end against the SAME migrated schema, which is also the more realistic
 * shape of how this lineage will actually be exercised (one schema, applied once, written to
 * over time) than five independent schemas each re-paying migration cost to prove one fact.
 */
describe("chainArchiveMigrations (design/full-chain-storage-design.md, Tier-1.5)", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  it("fresh apply succeeds, is idempotent, supports a same-height fork with an overlapping tx hash, and rejects a dual-canonical insert and an FK violation", async () => {
    const schema = "chain_archive_v3_test";
    const sql = createClient({ connectionString: container.getConnectionUri(), schema });
    try {
      // --- fresh apply succeeds ---
      await runMigrations(sql, { schema, migrations: chainArchiveMigrations });
      const firstRun = await sql<{ name: string }[]>`
        select name from ${sql(schema)}._migrations order by name
      `;
      expect(firstRun.map((r) => r.name)).toEqual(["000_schema", "001_chain_archive_core"]);

      // --- idempotent re-run: applies zero additional migrations ---
      await runMigrations(sql, { schema, migrations: chainArchiveMigrations });
      const secondRun = await sql<{ name: string }[]>`
        select name from ${sql(schema)}._migrations order by name
      `;
      expect(secondRun).toEqual(firstRun);

      // --- helper: register a chain_blobs row + its chain_blob_roles row together, since the
      // v3 blob-role-integrity trigger requires the role to already exist before anything
      // referencing that hash can be inserted. ---
      const registerBlob = async (hashHex: string, role: string): Promise<Buffer> => {
        const hash = Buffer.from(hashHex, "hex");
        await sql`insert into ${sql(schema)}.chain_blobs (hash, data) values (${hash}, ${Buffer.from("payload-" + hashHex)})`;
        await sql`insert into ${sql(schema)}.chain_blob_roles (blob_hash, role) values (${hash}, ${role})`;
        return hash;
      };
      const h = (n: number): string => n.toString(16).padStart(64, "0");

      // --- fork scenario: two competing blocks at the SAME (net, height), different
      // block_hash, each carrying a transaction with the SAME tx_hash. Under the pre-v2-fix PK
      // (block_height, tx_hash) this would have collided; under the current PK
      // (net, block_height, block_hash, tx_hash) both inclusion records coexist. ---
      const net = "fork_test_net";
      const height = 42;
      const parentHash = Buffer.from(h(1), "hex");
      const stateRoot = Buffer.from(h(2), "hex");
      const extrinsicsRoot = Buffer.from(h(3), "hex");
      const blockHashA = Buffer.from(h(10), "hex");
      const blockHashB = Buffer.from(h(11), "hex");
      const headerBlobA = await registerBlob(h(20), "block_header");
      const headerBlobB = await registerBlob(h(21), "block_header");
      const txRawBlob = await registerBlob(h(30), "tx_raw");
      const txHash = Buffer.from(h(40), "hex");

      await sql`insert into ${sql(schema)}.blocks
        (net, block_hash, height, parent_hash, state_root, extrinsics_root, header_blob_hash)
        values (${net}, ${blockHashA}, ${height}, ${parentHash}, ${stateRoot}, ${extrinsicsRoot}, ${headerBlobA})`;
      await sql`insert into ${sql(schema)}.blocks
        (net, block_hash, height, parent_hash, state_root, extrinsics_root, header_blob_hash)
        values (${net}, ${blockHashB}, ${height}, ${parentHash}, ${stateRoot}, ${extrinsicsRoot}, ${headerBlobB})`;

      await sql`insert into ${sql(schema)}.transactions
        (net, tx_hash, block_height, block_hash, position, kind, protocol_version, raw_blob_hash)
        values (${net}, ${txHash}, ${height}, ${blockHashA}, 0, 'regular', 1, ${txRawBlob})`;
      await sql`insert into ${sql(schema)}.transactions
        (net, tx_hash, block_height, block_hash, position, kind, protocol_version, raw_blob_hash)
        values (${net}, ${txHash}, ${height}, ${blockHashB}, 0, 'regular', 1, ${txRawBlob})`;

      const forkRows = await sql<{ n: number }[]>`
        select count(*)::int as n from ${sql(schema)}.transactions
        where net = ${net} and tx_hash = ${txHash}
      `;
      expect(forkRows[0]!.n).toBe(2); // both forks' inclusion records coexist

      // --- dual-canonical insert is rejected: mark block A canonical, then try to also mark
      // block B canonical at the SAME (net, height) -- blocks_one_canonical_per_height must
      // reject the second one. ---
      await sql`update ${sql(schema)}.blocks set status = 'canonical', is_canonical = true
                 where net = ${net} and height = ${height} and block_hash = ${blockHashA}`;
      await expect(
        sql`update ${sql(schema)}.blocks set status = 'canonical', is_canonical = true
             where net = ${net} and height = ${height} and block_hash = ${blockHashB}`,
      ).rejects.toMatchObject({ code: "23505" }); // unique_violation

      // --- FK violation: a transaction referencing a block that does not exist is rejected. ---
      const ghostBlockHash = Buffer.from(h(99), "hex");
      await expect(
        sql`insert into ${sql(schema)}.transactions
          (net, tx_hash, block_height, block_hash, position, kind, protocol_version, raw_blob_hash)
          values (${net}, ${Buffer.from(h(41), "hex")}, ${height}, ${ghostBlockHash}, 1, 'regular', 1, ${txRawBlob})`,
      ).rejects.toMatchObject({ code: "23503" }); // foreign_key_violation
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);
});
