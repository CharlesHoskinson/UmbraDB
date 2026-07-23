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

  /**
   * v4 audit fix (round-3 design-council re-audit, Fable 5 / GPT-5.6 Sol) — the v3 test above
   * only ever exercised the blob-role-missing rejection through `transactions`, and only ever
   * created a role before inserting a row that needed it, so a broken/removed trigger anywhere
   * else would still have passed. Closes that gap with real negative coverage across
   * `blocks`/`bridge_observations`/`verifier_key_observations` too (item 6a of the round-3
   * findings) — not just re-asserting the `transactions` case already covered above.
   */
  it("v4: rejects a reference to an unclassified blob on blocks, bridge_observations, and verifier_key_observations (not just transactions)", async () => {
    const schema = "chain_archive_v4_missing_role_test";
    const sql = createClient({ connectionString: container.getConnectionUri(), schema });
    try {
      await runMigrations(sql, { schema, migrations: chainArchiveMigrations });
      const h = (n: number): string => n.toString(16).padStart(64, "0");
      const net = "v4_missing_role_net";

      // a chain_blobs row with NO chain_blob_roles row at all -- every insert below that
      // references it must be rejected.
      const unclassifiedHash = Buffer.from(h(200), "hex");
      await sql`insert into ${sql(schema)}.chain_blobs (hash, data) values (${unclassifiedHash}, ${Buffer.from("unclassified")})`;

      // blocks.header_blob_hash
      await expect(
        sql`insert into ${sql(schema)}.blocks
          (net, block_hash, height, parent_hash, state_root, extrinsics_root, header_blob_hash)
          values (${net}, ${Buffer.from(h(201), "hex")}, 1, ${Buffer.from(h(0), "hex")},
                  ${Buffer.from(h(2), "hex")}, ${Buffer.from(h(3), "hex")}, ${unclassifiedHash})`,
      ).rejects.toMatchObject({ code: "23514" }); // check_violation (raised by the trigger)

      // Set up a real, legitimately-classified block so bridge_observations' own FK to
      // `blocks` is satisfiable, isolating the assertion to the blob-role trigger specifically.
      const registerBlob = async (hashHex: string, role: string): Promise<Buffer> => {
        const hash = Buffer.from(hashHex, "hex");
        await sql`insert into ${sql(schema)}.chain_blobs (hash, data) values (${hash}, ${Buffer.from("payload-" + hashHex)})`;
        await sql`insert into ${sql(schema)}.chain_blob_roles (blob_hash, role) values (${hash}, ${role})`;
        return hash;
      };
      const blockHash = Buffer.from(h(210), "hex");
      const headerBlob = await registerBlob(h(211), "block_header");
      await sql`insert into ${sql(schema)}.blocks
        (net, block_hash, height, parent_hash, state_root, extrinsics_root, header_blob_hash)
        values (${net}, ${blockHash}, 5, ${Buffer.from(h(0), "hex")},
                ${Buffer.from(h(2), "hex")}, ${Buffer.from(h(3), "hex")}, ${headerBlob})`;

      // bridge_observations.raw_blob_hash
      await expect(
        sql`insert into ${sql(schema)}.bridge_observations
          (net, block_height, block_hash, observation_index, kind, raw_blob_hash)
          values (${net}, 5, ${blockHash}, 0, 'cnight_registration', ${unclassifiedHash})`,
      ).rejects.toMatchObject({ code: "23514" });

      // verifier_key_observations.vk_hash
      await expect(
        sql`insert into ${sql(schema)}.verifier_key_observations
          (vk_hash, net, scope, tag, first_seen_height)
          values (${unclassifiedHash}, ${net}, 'protocol', 'entry_point_x', 5)`,
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  /**
   * v4 audit fix — closes the delete-side blob-role integrity gap (item 2 of the round-3
   * findings, both reviewers, one calls it a hard BLOCK) plus its concurrency race, using two
   * genuinely separate reserved connections/transactions (matching this repo's existing
   * `transaction-lease.test.ts` pattern for exercising real Postgres lock-blocking behavior),
   * not a mock and not just reasoning about it.
   */
  it("v4: rejects deleting a chain_blob_roles row still referenced by a live row, allows deleting an unreferenced one, and closes the concurrent-deletion race", async () => {
    const schema = "chain_archive_v4_role_delete_test";
    const sql = createClient({ connectionString: container.getConnectionUri(), schema });
    try {
      await runMigrations(sql, { schema, migrations: chainArchiveMigrations });
      const h = (n: number): string => n.toString(16).padStart(64, "0");
      const net = "v4_role_delete_net";
      const registerBlob = async (hashHex: string, role: string): Promise<Buffer> => {
        const hash = Buffer.from(hashHex, "hex");
        await sql`insert into ${sql(schema)}.chain_blobs (hash, data) values (${hash}, ${Buffer.from("payload-" + hashHex)})`;
        await sql`insert into ${sql(schema)}.chain_blob_roles (blob_hash, role) values (${hash}, ${role})`;
        return hash;
      };

      // --- an unreferenced role can still be deleted freely ---
      const unusedBlob = await registerBlob(h(300), "tx_raw");
      await sql`delete from ${sql(schema)}.chain_blob_roles where blob_hash = ${unusedBlob} and role = 'tx_raw'`;
      const remaining = await sql<{ n: number }[]>`
        select count(*)::int as n from ${sql(schema)}.chain_blob_roles where blob_hash = ${unusedBlob}
      `;
      expect(remaining[0]!.n).toBe(0);

      // --- a role still referenced by a live transactions row cannot be deleted ---
      const headerBlob = await registerBlob(h(301), "block_header");
      const txRawBlob = await registerBlob(h(302), "tx_raw");
      const blockHash = Buffer.from(h(303), "hex");
      await sql`insert into ${sql(schema)}.blocks
        (net, block_hash, height, parent_hash, state_root, extrinsics_root, header_blob_hash)
        values (${net}, ${blockHash}, 7, ${Buffer.from(h(0), "hex")},
                ${Buffer.from(h(2), "hex")}, ${Buffer.from(h(3), "hex")}, ${headerBlob})`;
      await sql`insert into ${sql(schema)}.transactions
        (net, tx_hash, block_height, block_hash, position, kind, protocol_version, raw_blob_hash)
        values (${net}, ${Buffer.from(h(304), "hex")}, 7, ${blockHash}, 0, 'regular', 1, ${txRawBlob})`;

      await expect(
        sql`delete from ${sql(schema)}.chain_blob_roles where blob_hash = ${txRawBlob} and role = 'tx_raw'`,
      ).rejects.toMatchObject({ code: "23514" });

      // --- concurrency: an in-flight referencing INSERT (holding FOR SHARE, uncommitted)
      // forces a concurrent DELETE of that same role to block, and to correctly fail once it
      // unblocks and sees the now-committed reference. Uses two real reserved connections with
      // manual BEGIN/COMMIT, matching transaction-lease.test.ts's own pattern for exercising
      // genuine Postgres lock-blocking behavior. ---
      const raceBlob = await registerBlob(h(310), "tx_raw");
      const sessionA = await sql.reserve();
      const sessionB = await sql.reserve();
      let sessionACommitted = false;
      try {
        await sessionA`BEGIN`;
        await sessionA`insert into ${sessionA(schema)}.transactions
          (net, tx_hash, block_height, block_hash, position, kind, protocol_version, raw_blob_hash)
          values (${net}, ${Buffer.from(h(311), "hex")}, 7, ${blockHash}, 1, 'regular', 1, ${raceBlob})`;
        // Session A now holds FOR SHARE on the (raceBlob, 'tx_raw') chain_blob_roles row,
        // uncommitted. Start session B's DELETE -- it must block on that lock, not race past it.
        const deletePromise = sessionB`delete from ${sessionB(schema)}.chain_blob_roles
          where blob_hash = ${raceBlob} and role = 'tx_raw'`;
        await tick(150); // let session B's DELETE actually reach Postgres and start blocking
        await sessionA`COMMIT`;
        sessionACommitted = true;
        // Once unblocked by A's commit, B's guard must see the now-live reference and reject.
        await expect(deletePromise).rejects.toMatchObject({ code: "23514" });
      } finally {
        if (!sessionACommitted) {
          await sessionA`ROLLBACK`.catch(() => {});
        }
        sessionA.release();
        sessionB.release();
      }

      // the reference and its role both still stand after the failed concurrent delete attempt
      const stillPresent = await sql<{ n: number }[]>`
        select count(*)::int as n from ${sql(schema)}.chain_blob_roles
        where blob_hash = ${raceBlob} and role = 'tx_raw'
      `;
      expect(stillPresent[0]!.n).toBe(1);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  /**
   * v4 audit fix — closes the `finalized`-monotonicity gap (item 3 of the round-3 findings).
   */
  it("v4: rejects un-finalizing a previously-finalized block while still allowing legal transitions", async () => {
    const schema = "chain_archive_v4_finalized_test";
    const sql = createClient({ connectionString: container.getConnectionUri(), schema });
    try {
      await runMigrations(sql, { schema, migrations: chainArchiveMigrations });
      const h = (n: number): string => n.toString(16).padStart(64, "0");
      const net = "v4_finalized_net";
      const registerBlob = async (hashHex: string, role: string): Promise<Buffer> => {
        const hash = Buffer.from(hashHex, "hex");
        await sql`insert into ${sql(schema)}.chain_blobs (hash, data) values (${hash}, ${Buffer.from("payload-" + hashHex)})`;
        await sql`insert into ${sql(schema)}.chain_blob_roles (blob_hash, role) values (${hash}, ${role})`;
        return hash;
      };
      const insertBlock = async (
        height: number, blockHash: Buffer, isCanonical: boolean, status: string, finalized: boolean,
      ): Promise<Buffer> => {
        const header = await registerBlob(h(1000 + height), "block_header");
        await sql`insert into ${sql(schema)}.blocks
          (net, block_hash, height, parent_hash, state_root, extrinsics_root, header_blob_hash,
           is_canonical, status, finalized)
          values (${net}, ${blockHash}, ${height}, ${Buffer.from(h(0), "hex")},
                  ${Buffer.from(h(2), "hex")}, ${Buffer.from(h(3), "hex")}, ${header},
                  ${isCanonical}, ${status}, ${finalized})`;
        return blockHash;
      };

      // --- illegal: un-finalizing a previously-finalized block is rejected ---
      const finalizedHash = Buffer.from(h(400), "hex");
      await insertBlock(400, finalizedHash, true, "canonical", true);
      await expect(
        sql`update ${sql(schema)}.blocks set finalized = false, is_canonical = false, status = 'orphaned'
             where net = ${net} and height = 400 and block_hash = ${finalizedHash}`,
      ).rejects.toMatchObject({ code: "23514" });

      // --- legal: an unrelated-column update on the same finalized row still succeeds ---
      await sql`update ${sql(schema)}.blocks set is_canonical = true
                 where net = ${net} and height = 400 and block_hash = ${finalizedHash}`;

      // --- legal: a not-yet-finalized canonical block can still flip to non-canonical (reorg) ---
      const reorgHash = Buffer.from(h(401), "hex");
      await insertBlock(401, reorgHash, true, "canonical", false);
      await sql`update ${sql(schema)}.blocks set is_canonical = false, status = 'orphaned'
                 where net = ${net} and height = 401 and block_hash = ${reorgHash}`;
      const reorgRow = await sql<{ is_canonical: boolean; finalized: boolean }[]>`
        select is_canonical, finalized from ${sql(schema)}.blocks
        where net = ${net} and height = 401 and block_hash = ${reorgHash}
      `;
      expect(reorgRow[0]).toEqual({ is_canonical: false, finalized: false });

      // --- legal: a not-yet-finalized block can still transition to finalized ---
      const finalizingHash = Buffer.from(h(402), "hex");
      await insertBlock(402, finalizingHash, true, "canonical", false);
      await sql`update ${sql(schema)}.blocks set finalized = true
                 where net = ${net} and height = 402 and block_hash = ${finalizingHash}`;
      const finalizingRow = await sql<{ finalized: boolean }[]>`
        select finalized from ${sql(schema)}.blocks
        where net = ${net} and height = 402 and block_hash = ${finalizingHash}
      `;
      expect(finalizingRow[0]!.finalized).toBe(true);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  /**
   * v4 audit fix — the verifier-key `tag`/uniqueness fix (item 4 of the round-3 findings).
   */
  it("v4: verifier_key_observations persists two legitimate different-tag observations, rejects a true duplicate, and the LEAST-upsert pattern collapses repeated first_seen_height claims correctly", async () => {
    const schema = "chain_archive_v4_verifier_key_test";
    const sql = createClient({ connectionString: container.getConnectionUri(), schema });
    try {
      await runMigrations(sql, { schema, migrations: chainArchiveMigrations });
      const h = (n: number): string => n.toString(16).padStart(64, "0");
      const net = "v4_vk_net";
      const vkHash = Buffer.from(h(500), "hex");
      await sql`insert into ${sql(schema)}.chain_blobs (hash, data) values (${vkHash}, ${Buffer.from("vk-bytes")})`;
      await sql`insert into ${sql(schema)}.chain_blob_roles (blob_hash, role) values (${vkHash}, 'verifier_key')`;

      // --- (a) two legitimate different-tag observations of the SAME key/context coexist ---
      await sql`insert into ${sql(schema)}.verifier_key_observations
        (vk_hash, net, scope, tag, first_seen_height) values (${vkHash}, ${net}, 'protocol', 'entry_point_a', 100)`;
      await sql`insert into ${sql(schema)}.verifier_key_observations
        (vk_hash, net, scope, tag, first_seen_height) values (${vkHash}, ${net}, 'protocol', 'entry_point_b', 100)`;
      const both = await sql<{ tag: string }[]>`
        select tag from ${sql(schema)}.verifier_key_observations
        where vk_hash = ${vkHash} and net = ${net} order by tag
      `;
      expect(both.map((r) => r.tag)).toEqual(["entry_point_a", "entry_point_b"]);

      // --- (b) the ON CONFLICT / LEAST upsert pattern collapses repeated sightings of the SAME
      // context into one row holding the minimum first_seen_height, not contradictory rows ---
      const upsert = async (firstSeenHeight: number): Promise<void> => {
        await sql`insert into ${sql(schema)}.verifier_key_observations
          (vk_hash, net, scope, tag, first_seen_height)
          values (${vkHash}, ${net}, 'protocol', 'entry_point_a', ${firstSeenHeight})
          on conflict (vk_hash, net, scope, contract_address, tag)
          do update set first_seen_height =
            least(${sql(schema)}.verifier_key_observations.first_seen_height, excluded.first_seen_height)`;
      };
      await upsert(50);
      await upsert(999);
      const collapsed = await sql<{ first_seen_height: number }[]>`
        select first_seen_height from ${sql(schema)}.verifier_key_observations
        where vk_hash = ${vkHash} and net = ${net} and tag = 'entry_point_a'
      `;
      expect(collapsed).toHaveLength(1);
      expect(Number(collapsed[0]!.first_seen_height)).toBe(50); // min(100, 50, 999)

      // --- (c) a plain (non-upsert) duplicate-context insert is still correctly rejected ---
      await expect(
        sql`insert into ${sql(schema)}.verifier_key_observations
          (vk_hash, net, scope, tag, first_seen_height)
          values (${vkHash}, ${net}, 'protocol', 'entry_point_a', 100)`,
      ).rejects.toMatchObject({ code: "23505" }); // unique_violation
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);
});

async function tick(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
