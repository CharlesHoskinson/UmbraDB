import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConnectionError } from "../../src/interfaces/storage-errors.js";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
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
      expect(Number(first[0]!.count)).toBe(2); // 000_schema + 001_temporal_kv
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
      expect(rows.map((r) => r.name)).toEqual(["000_schema", "001_temporal_kv"]);
    } finally {
      await sqlA.end({ timeout: 5 });
      await sqlB.end({ timeout: 5 });
    }
  }, 30_000);

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
