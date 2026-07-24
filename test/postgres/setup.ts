import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { runMigrations } from "../../src/postgres/migrate.js";

/**
 * One shared, session-scoped Postgres container for the whole test run
 * (`openspec/changes/sprint-1-setup-and-temporal-kv/design.md` §5) — container startup cost is
 * real and shouldn't be paid per-test. Each test file is responsible for cleaning up its own
 * data (`TRUNCATE` between tests), not relying on a fresh container per test.
 *
 * Uses `createClient` (not a raw `postgres()` call) specifically so the `types.bigint` mapping
 * is actually configured on this connection — that mapping is runtime behavior of the
 * connection object itself, not something a TypeScript type assertion at the call site can
 * substitute for. A test setup using a differently-configured connection would silently return
 * `version` as a string at runtime while the adapter's own types still claimed `bigint`.
 */
let container: StartedPostgreSqlContainer;
let adminSql: UmbraDBSql;

export const TEST_SCHEMA = "umbradb_test";

export async function startTestDatabase(): Promise<UmbraDBSql> {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  adminSql = createClient({ connectionString: container.getConnectionUri(), schema: TEST_SCHEMA, maxConnections: 5 });
  await runMigrations(adminSql, { schema: TEST_SCHEMA });
  return adminSql;
}

export async function stopTestDatabase(): Promise<void> {
  await adminSql?.end({ timeout: 5 });
  await container?.stop();
}

export function registerSuiteLifecycle(): { sql: () => UmbraDBSql; connectionUri: () => string } {
  let sql: UmbraDBSql;
  beforeAll(async () => {
    sql = await startTestDatabase();
  }, 120_000);
  afterAll(async () => {
    await stopTestDatabase();
  }, 60_000); // teardown can exceed the 10s default under heavy host load (container.stop)
  // Exposed so a test that needs its OWN dedicated, small (e.g. maxConnections: 1) pool against
  // the SAME database -- rather than the shared suite pool, whose physical connection a given
  // query lands on is not deterministic -- doesn't have to spin up a second container.
  return { sql: () => sql, connectionUri: () => container.getConnectionUri() };
}
