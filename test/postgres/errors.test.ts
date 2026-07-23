import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "../../src/postgres/client.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import { chainArchiveMigrations } from "../../src/postgres/migrations/chain_archive/index.js";
import {
  ChainArchiveCheckViolationError,
  ChainArchiveInvariantError,
  ClockRegressionError,
  translatePostgresError,
} from "../../src/postgres/errors.js";

/**
 * Sprint-fix round Fix 4 (MEDIUM): before this fix, EVERY SQLSTATE 23514 (check_violation) --
 * regardless of which subsystem/constraint actually raised it -- was translated to
 * `ClockRegressionError`, a class whose own doc comment is specifically about temporal-kv's
 * clock-regression CHECK (`kv_history_range`). chain-archive's own triggers/CHECK constraints
 * also raise 23514 (blob-role classification completeness, finalized-monotonicity, the delete-
 * side removal guard, and ordinary column CHECKs like the status/kind enums and hash-length
 * checks) and were silently mislabeled the same way -- actively misleading anyone debugging a
 * real chain-archive data-integrity failure into thinking it was a clock/NTP issue.
 *
 * These tests exercise the translator against REAL errors raised by a real Postgres 17 instance
 * (not synthetic/mocked error objects) for each of the newly-distinguished categories, plus a
 * negative control proving `kv_history_range`'s own -- genuinely unrelated -- 23514 is untouched
 * by this fix and still resolves to `ClockRegressionError` exactly as before.
 */
describe("translatePostgresError -- Fix 4: constraint-name-aware 23514 routing", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  const h = (n: number): string => n.toString(16).padStart(64, "0");

  it("a blob-role classification-completeness violation (blocks.header_blob_hash referencing an unclassified blob) translates to ChainArchiveInvariantError, not ClockRegressionError", async () => {
    const schema = "errors_fix4_blob_role_test";
    const sql = createClient({ connectionString: container.getConnectionUri(), schema });
    try {
      await runMigrations(sql, { schema, migrations: chainArchiveMigrations });
      const unclassifiedHash = Buffer.from(h(1), "hex");
      await sql`insert into ${sql(schema)}.chain_blobs (hash, data) values (${unclassifiedHash}, ${Buffer.from("x")})`;

      let caught: unknown;
      try {
        await sql`insert into ${sql(schema)}.blocks
          (net, block_hash, height, parent_hash, state_root, extrinsics_root, header_blob_hash)
          values ('net', ${Buffer.from(h(2), "hex")}, 1, ${Buffer.from(h(0), "hex")},
                  ${Buffer.from(h(3), "hex")}, ${Buffer.from(h(4), "hex")}, ${unclassifiedHash})`;
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      const translated = translatePostgresError(caught);
      expect(translated).toBeInstanceOf(ChainArchiveInvariantError);
      expect((translated as ChainArchiveInvariantError).constraintName).toBe("chain_blob_roles_completeness");
      expect(translated).not.toBeInstanceOf(ClockRegressionError);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  it("attempting to un-finalize a finalized block translates to ChainArchiveInvariantError with constraintName blocks_finalized_monotonic, not ClockRegressionError", async () => {
    const schema = "errors_fix4_finalized_test";
    const sql = createClient({ connectionString: container.getConnectionUri(), schema });
    try {
      await runMigrations(sql, { schema, migrations: chainArchiveMigrations });
      const headerHash = Buffer.from(h(10), "hex");
      await sql`insert into ${sql(schema)}.chain_blobs (hash, data) values (${headerHash}, ${Buffer.from("x")})`;
      await sql`insert into ${sql(schema)}.chain_blob_roles (blob_hash, role) values (${headerHash}, 'block_header')`;
      const blockHash = Buffer.from(h(11), "hex");
      await sql`insert into ${sql(schema)}.blocks
        (net, block_hash, height, parent_hash, state_root, extrinsics_root, header_blob_hash, is_canonical, status, finalized)
        values ('net', ${blockHash}, 2, ${Buffer.from(h(0), "hex")}, ${Buffer.from(h(3), "hex")}, ${Buffer.from(h(4), "hex")}, ${headerHash}, true, 'canonical', true)`;

      let caught: unknown;
      try {
        await sql`update ${sql(schema)}.blocks set finalized = false, is_canonical = false, status = 'orphaned'
          where net = 'net' and height = 2 and block_hash = ${blockHash}`;
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      const translated = translatePostgresError(caught);
      expect(translated).toBeInstanceOf(ChainArchiveInvariantError);
      expect((translated as ChainArchiveInvariantError).constraintName).toBe("blocks_finalized_monotonic");
      expect(translated).not.toBeInstanceOf(ClockRegressionError);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  it("deleting a chain_blob_roles row still referenced by a live row translates to ChainArchiveInvariantError with constraintName chain_blob_roles_removal_guard, not ClockRegressionError", async () => {
    const schema = "errors_fix4_removal_guard_test";
    const sql = createClient({ connectionString: container.getConnectionUri(), schema });
    try {
      await runMigrations(sql, { schema, migrations: chainArchiveMigrations });
      const headerHash = Buffer.from(h(20), "hex");
      await sql`insert into ${sql(schema)}.chain_blobs (hash, data) values (${headerHash}, ${Buffer.from("x")})`;
      await sql`insert into ${sql(schema)}.chain_blob_roles (blob_hash, role) values (${headerHash}, 'block_header')`;
      await sql`insert into ${sql(schema)}.blocks
        (net, block_hash, height, parent_hash, state_root, extrinsics_root, header_blob_hash)
        values ('net', ${Buffer.from(h(21), "hex")}, 3, ${Buffer.from(h(0), "hex")}, ${Buffer.from(h(3), "hex")}, ${Buffer.from(h(4), "hex")}, ${headerHash})`;

      let caught: unknown;
      try {
        await sql`delete from ${sql(schema)}.chain_blob_roles where blob_hash = ${headerHash} and role = 'block_header'`;
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      const translated = translatePostgresError(caught);
      expect(translated).toBeInstanceOf(ChainArchiveInvariantError);
      expect((translated as ChainArchiveInvariantError).constraintName).toBe("chain_blob_roles_removal_guard");
      expect(translated).not.toBeInstanceOf(ClockRegressionError);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  it("an ordinary chain-archive CHECK violation (an invalid status enum value) translates to ChainArchiveCheckViolationError, not ClockRegressionError", async () => {
    const schema = "errors_fix4_check_test";
    const sql = createClient({ connectionString: container.getConnectionUri(), schema });
    try {
      await runMigrations(sql, { schema, migrations: chainArchiveMigrations });
      const headerHash = Buffer.from(h(30), "hex");
      await sql`insert into ${sql(schema)}.chain_blobs (hash, data) values (${headerHash}, ${Buffer.from("x")})`;
      await sql`insert into ${sql(schema)}.chain_blob_roles (blob_hash, role) values (${headerHash}, 'block_header')`;

      let caught: unknown;
      try {
        await sql.unsafe(`insert into "${schema}".blocks
          (net, block_hash, height, parent_hash, state_root, extrinsics_root, header_blob_hash, status)
          values ('net', $1, 4, $2, $3, $4, $5, 'not-a-real-status')`,
          [Buffer.from(h(31), "hex"), Buffer.from(h(0), "hex"), Buffer.from(h(3), "hex"), Buffer.from(h(4), "hex"), headerHash],
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      const translated = translatePostgresError(caught);
      expect(translated).toBeInstanceOf(ChainArchiveCheckViolationError);
      expect((translated as ChainArchiveCheckViolationError).constraintName).toBe("blocks_status_check");
      expect(translated).not.toBeInstanceOf(ClockRegressionError);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  it("a 23514 with no recognizable chain-archive constraint name (e.g. temporal-kv's own kv_history_range) still falls through to ClockRegressionError -- negative control proving this fix did not touch temporal-kv's existing behavior", () => {
    // A representative shape of what postgres.js actually reports for a real kv_history_range
    // violation (field names/values matching temporal-kv.test.ts's own coverage of this same
    // constraint, and this project's own `PgDriverError` duck-typed contract in errors.ts --
    // `severity` is required to look like a genuine driver error, matching `isPgDriverError`).
    const fakeDriverError = Object.assign(
      new Error('new row for relation "temporal_kv_history" violates check constraint "kv_history_range"'),
      { code: "23514", severity: "ERROR", constraint_name: "kv_history_range" },
    );
    const translated = translatePostgresError(fakeDriverError);
    expect(translated).toBeInstanceOf(ClockRegressionError);
    expect(translated).not.toBeInstanceOf(ChainArchiveInvariantError);
    expect(translated).not.toBeInstanceOf(ChainArchiveCheckViolationError);
  });
});
