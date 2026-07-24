import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConnectionError } from "../../src/interfaces/storage-errors.js";
import { assertValidSchemaName, createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { ExclusionViolationError, translatePostgresError } from "../../src/postgres/errors.js";
import { runMigrations } from "../../src/postgres/migrate.js";

describe("runMigrations", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  it("is idempotent: a second run against an already-migrated schema applies zero migrations", async () => {
    const sql = createClient({ connectionString: container.getConnectionUri(), schema: "idempotent_test" });
    try {
      await runMigrations(sql, { schema: "idempotent_test" });
      const first = await sql<{ count: string }[]>`
        select count(*)::text as count from ${sql("idempotent_test")}._migrations
      `;
      await runMigrations(sql, { schema: "idempotent_test" }); // second run
      const second = await sql<{ count: string }[]>`
        select count(*)::text as count from ${sql("idempotent_test")}._migrations
      `;
      expect(second[0]!.count).toBe(first[0]!.count);
      expect(Number(first[0]!.count)).toBe(7); // 000_schema + 001_temporal_kv + 002_checkpoint_store + 003_watermarks + 004_transaction_history + 005_kv_current_fillfactor + 006_ckpt_chunks_size_bytes
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 30_000);

  it("two concurrent runMigrations calls against the same fresh database do not duplicate or race", async () => {
    const schema = "concurrent_test";
    const sqlA = createClient({ connectionString: container.getConnectionUri(), schema });
    const sqlB = createClient({ connectionString: container.getConnectionUri(), schema });
    try {
      await Promise.all([
        runMigrations(sqlA, { schema }),
        runMigrations(sqlB, { schema }),
      ]);
      const rows = await sqlA<{ name: string }[]>`select name from ${sqlA(schema)}._migrations order by name`;
      expect(rows.map((r) => r.name)).toEqual(["000_schema", "001_temporal_kv", "002_checkpoint_store", "003_watermarks", "004_transaction_history", "005_kv_current_fillfactor", "006_ckpt_chunks_size_bytes"]);
    } finally {
      await sqlA.end({ timeout: 5 });
      await sqlB.end({ timeout: 5 });
    }
  }, 30_000);

  it("two concurrent runMigrations for DIFFERENT schemas do not race on the global CREATE EXTENSION (Codex audit finding #5)", async () => {
    // Distinct per-schema advisory locks (class 1, hashtext(schema)) let these two run
    // genuinely concurrently up to the point both try `CREATE EXTENSION IF NOT EXISTS
    // btree_gist` -- which touches one shared, database-global catalog row regardless of
    // schema. Without the class-3 global lock around just that statement, this races.
    //
    // Revised after a follow-up cross-vendor re-audit found this test non-representative when
    // run against the SUITE'S shared container: by this point in the file, earlier tests have
    // already installed btree_gist, so both concurrent calls here would hit the cheap
    // "already exists, skipping" no-op path regardless of whether the locking fix works at
    // all -- the test would pass even against a reverted fix. A FRESH, dedicated container
    // (btree_gist genuinely not yet installed) is required to actually exercise the slow
    // first-time installation path where the original race lived.
    const freshContainer = await new PostgreSqlContainer("postgres:17-alpine").start();
    try {
      const schemaA = "ext_race_a";
      const schemaB = "ext_race_b";
      const sqlA = createClient({ connectionString: freshContainer.getConnectionUri(), schema: schemaA });
      const sqlB = createClient({ connectionString: freshContainer.getConnectionUri(), schema: schemaB });
      try {
        const before = await sqlA<{ n: number }[]>`select count(*)::int as n from pg_extension where extname = 'btree_gist'`;
        expect(before[0]!.n).toBe(0); // confirms this run actually exercises the fresh-install path, not a no-op
        await Promise.all([
          runMigrations(sqlA, { schema: schemaA }),
          runMigrations(sqlB, { schema: schemaB }),
        ]);
        const rowsA = await sqlA<{ name: string }[]>`select name from ${sqlA(schemaA)}._migrations order by name`;
        const rowsB = await sqlB<{ name: string }[]>`select name from ${sqlB(schemaB)}._migrations order by name`;
        expect(rowsA.map((r) => r.name)).toEqual(["000_schema", "001_temporal_kv", "002_checkpoint_store", "003_watermarks", "004_transaction_history", "005_kv_current_fillfactor", "006_ckpt_chunks_size_bytes"]);
        expect(rowsB.map((r) => r.name)).toEqual(["000_schema", "001_temporal_kv", "002_checkpoint_store", "003_watermarks", "004_transaction_history", "005_kv_current_fillfactor", "006_ckpt_chunks_size_bytes"]);
        const ext = await sqlA<{ n: number }[]>`select count(*)::int as n from pg_extension where extname = 'btree_gist'`;
        expect(ext[0]!.n).toBe(1); // exactly one catalog row, not a failed/duplicate race
      } finally {
        await sqlA.end({ timeout: 5 });
        await sqlB.end({ timeout: 5 });
      }
    } finally {
      await freshContainer.stop();
    }
  }, 60_000);

  it("does not leave search_path or the advisory lock dangling on the connection after completion (Codex audit finding #4)", async () => {
    // Revised after a follow-up cross-vendor re-audit found the original version of this test
    // non-functional: it checked search_path on a SEPARATE, freshly-created pool that was never
    // configured with the migrated schema in the first place (createClient without an explicit
    // schema defaults to "umbradb"), so the assertion was unconditionally true regardless of
    // whether the actual fix works -- Postgres search_path is session-local, so one connection
    // can never observe another's. Fixed by capping THIS SAME pool at maxConnections: 1 (so the
    // single connection it holds is necessarily the one that ran the migration) and asserting
    // against it directly, plus a session-independent pg_locks check that doesn't depend on
    // connection reuse at all and also covers the class-3 global lock from finding #5.
    const schema = "cleanup_test";
    // Deliberately NOT passing `schema` here -- if this pool's own startup search_path were
    // "cleanup_test", RESET search_path (migrate.ts) would restore it right back to that same
    // value, making the assertion below pass trivially regardless of whether the fix works.
    const sql = createClient({ connectionString: container.getConnectionUri(), maxConnections: 1 });
    try {
      await runMigrations(sql, { schema });

      const searchPath = await sql<{ search_path: string }[]>`show search_path`;
      expect(searchPath[0]!.search_path).not.toContain(schema);
      // Unqualified lookup: if search_path still resolved to `schema`, this would find the
      // migrated table; it must not, resolving through this pool's own default ("umbradb")
      // search_path instead, which has no such table.
      const unqualified = await sql<{ reg: string | null }[]>`select to_regclass('_migrations')::text as reg`;
      expect(unqualified[0]!.reg).toBeNull();

      // Session-independent check that doesn't rely on connection reuse at all -- covers both
      // the per-schema class-1 lock (finding #4) and the global class-3 lock (finding #5).
      const locks = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_locks where locktype = 'advisory' and classid in (1, 3)
      `;
      expect(locks[0]!.n).toBe(0);

      // The migration's own advisory lock (class 1) must not still be held -- a fresh
      // migration run against the SAME schema must not block waiting for it.
      await expect(runMigrations(sql, { schema })).resolves.toBeUndefined();
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 30_000);

  it("rejects a schema name over PostgreSQL's 63-byte identifier limit (Codex audit finding #6)", () => {
    const tooLong = "a".repeat(64);
    expect(() => assertValidSchemaName(tooLong)).toThrow(/63-byte/);
    const exactly63 = "a".repeat(63);
    expect(() => assertValidSchemaName(exactly63)).not.toThrow();
  });

  it("hostile search_path: a decoy kv_history in another schema does not receive history rows (design.md task 0.4)", async () => {
    const schema = "hostile_test";
    const decoySchema = "hostile_decoy";
    const sql = createClient({ connectionString: container.getConnectionUri(), schema });
    try {
      await runMigrations(sql, { schema });

      // Install a decoy kv_history in a DIFFERENT schema, same shape.
      await sql`create schema if not exists ${sql(decoySchema)}`;
      await sql`
        create table ${sql(decoySchema)}.kv_history (
          id bigserial primary key, ns text, scope text, key text, value jsonb, version bigint,
          valid_from timestamptz, valid_to timestamptz
        )
      `;

      // A raw connection whose session search_path is set to the DECOY schema first — proving
      // the trigger's own function-level `SET search_path` (not the caller's) determines where
      // its unqualified `INSERT INTO kv_history` actually lands.
      const hostileConn = postgres(container.getConnectionUri(), {
        connection: { search_path: `${decoySchema}, ${schema}` },
      });
      try {
        await hostileConn`insert into ${hostileConn(schema)}.kv_current (ns, scope, key, value, version)
                           values ('h', 'h', 'h', '{"a":1}'::jsonb, 1)`;
        // These are two separate auto-committing statements against the same key -- found by a
        // fourth-round cross-vendor re-audit as another site exposed to the documented
        // millisecond-collision caveat (design/design.md §4a) if both land in the same truncated
        // millisecond. Force a boundary crossing, matching this project's other tests.
        await new Promise((r) => setTimeout(r, 5));
        await hostileConn`update ${hostileConn(schema)}.kv_current set value = '{"a":2}'::jsonb, version = 2
                           where ns='h' and scope='h' and key='h'`;
      } finally {
        await hostileConn.end({ timeout: 5 });
      }

      const decoyRows = await sql`select count(*)::int as n from ${sql(decoySchema)}.kv_history`;
      expect(decoyRows[0]!.n).toBe(0);
      const realRows = await sql`select count(*)::int as n from ${sql(schema)}.kv_history where key = 'h'`;
      expect(realRows[0]!.n).toBe(1);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 30_000);
});

describe("error translation (design.md §4a)", () => {
  it("runMigrations itself translates a connection failure to ConnectionError, not a raw driver error (Codex re-audit finding: prior test only exercised translatePostgresError directly, not the exported adapter operation)", async () => {
    const sql = createClient({
      connectionString: "postgres://nouser:nopass@127.0.0.1:1/nonexistent",
      schema: "unreachable_test",
      maxConnections: 1,
      // Fail fast: unreachable endpoint; avoids the 30s default connect timeout hanging past the
      // test timeout where a closed port does not promptly refuse (WSL2). Mirrors the raw
      // postgres() call below, which already sets connect_timeout: 2 for the same reason.
      connectTimeout: 2,
    });
    try {
      await expect(runMigrations(sql, { schema: "unreachable_test" })).rejects.toBeInstanceOf(ConnectionError);
    } finally {
      await sql.end({ timeout: 1 });
    }
  }, 10_000);

  it("a connection failure surfaces as ConnectionError, not a raw driver error", async () => {
    const sql = postgres("postgres://nouser:nopass@127.0.0.1:1/nonexistent", {
      max: 1,
      connect_timeout: 2,
    });
    try {
      await sql`select 1`;
      expect.unreachable("expected a connection failure");
    } catch (err) {
      expect(translatePostgresError(err)).toBeInstanceOf(ConnectionError);
    } finally {
      await sql.end({ timeout: 1 });
    }
  }, 10_000);

  it("a kv_history_no_overlap violation is identified by SQLSTATE 23P01, not 23505", async () => {
    const container2 = await new PostgreSqlContainer("postgres:17-alpine").start();
    let sql: UmbraDBSql | undefined;
    try {
      const schema = "exclusion_test";
      sql = createClient({ connectionString: container2.getConnectionUri(), schema });
      await runMigrations(sql, { schema });
      await sql`insert into ${sql(schema)}.kv_history (ns, scope, key, value, version, valid_from, valid_to)
                values ('n','s','k','{}'::jsonb, 1, now(), now() + interval '1 hour')`;
      try {
        await sql`insert into ${sql(schema)}.kv_history (ns, scope, key, value, version, valid_from, valid_to)
                  values ('n','s','k','{}'::jsonb, 2, now() + interval '30 minutes', now() + interval '2 hours')`;
        expect.unreachable("expected an exclusion violation");
      } catch (err) {
        expect((err as { code?: string }).code).toBe("23P01");
        expect(translatePostgresError(err)).toBeInstanceOf(ExclusionViolationError);
      }
    } finally {
      await sql?.end({ timeout: 5 });
      await container2.stop();
    }
  }, 30_000);
});
