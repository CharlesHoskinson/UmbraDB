import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { ISql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createClient,
  DEFAULT_IDLE_IN_TX_TIMEOUT_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  type UmbraDBSql,
} from "../../src/postgres/client.js";
import { PgTransactionLeaseLayer } from "../../src/postgres/transaction-lease.js";

// G7 task 2.1 — bounded server-side timeouts on every UmbraDB connection
// (openspec/changes/v1.0.0-durable-checkpoint-cursor: design.md §3.1, acceptance C-rows).

const TEST_SCHEMA = "umbradb_test";

describe("G7 server-side timeouts (design.md §3.1, task 2.1)", () => {
  let container: StartedPostgreSqlContainer;
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);
  afterAll(async () => {
    await container?.stop();
  });

  const show = async (sql: UmbraDBSql, name: string): Promise<string> => {
    const rows = await sql<{ v: string }[]>`select current_setting(${name}) as v`;
    return rows[0]!.v;
  };

  it("three timeouts are set to non-zero defaults on a fresh connection", async () => {
    const sql = createClient({ connectionString: container.getConnectionUri(), schema: TEST_SCHEMA });
    try {
      expect(await show(sql, "statement_timeout")).not.toBe("0");
      expect(await show(sql, "lock_timeout")).not.toBe("0");
      expect(await show(sql, "idle_in_transaction_session_timeout")).not.toBe("0");
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 30_000);

  it("caller can override each timeout default", async () => {
    const sql = createClient({
      connectionString: container.getConnectionUri(),
      schema: TEST_SCHEMA,
      statementTimeoutMs: 7000,
      lockTimeoutMs: 3000,
      idleInTxTimeoutMs: 11000,
    });
    try {
      expect(await show(sql, "statement_timeout")).toBe("7s");
      expect(await show(sql, "lock_timeout")).toBe("3s");
      expect(await show(sql, "idle_in_transaction_session_timeout")).toBe("11s");
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 30_000);

  it("lease path restores the connection statement_timeout default, not zero and not the lease TTL", async () => {
    const sql = createClient({ connectionString: container.getConnectionUri(), schema: TEST_SCHEMA, maxConnections: 1 });
    try {
      const layer = new PgTransactionLeaseLayer(sql);
      const lease = await layer.acquireLease("g7-reset-key", { timeoutMs: 5000 });
      await layer.releaseLease(lease);
      // maxConnections:1 → the next reservation is the same physical connection the lease used.
      // Its statement_timeout must be back at the connection default (120s = "2min"), not "0"
      // (PostgreSQL's own default) and not "5s" (the lease TTL) — verifying the reset interaction
      // at transaction-lease.ts's resetStatementTimeout.
      const reserved = (await sql.reserve()) as unknown as ISql;
      try {
        const rows = await reserved<{ v: string }[]>`select current_setting('statement_timeout') as v`;
        expect(rows[0]!.v).toBe("2min");
      } finally {
        (reserved as unknown as { release: () => void }).release();
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 30_000);

  it("a raised idle-in-transaction default is honoured for a long in-transaction workload", async () => {
    const sql = createClient({
      connectionString: container.getConnectionUri(),
      schema: TEST_SCHEMA,
      idleInTxTimeoutMs: 300_000,
    });
    try {
      expect(await show(sql, "idle_in_transaction_session_timeout")).toBe("5min");
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 30_000);

  it("rejects a non-positive or non-integer connection timeout override", () => {
    const uri = "postgres://u:p@127.0.0.1:1/db";
    for (const bad of [0, -1, 1.5]) {
      expect(() => createClient({ connectionString: uri, statementTimeoutMs: bad })).toThrow();
      expect(() => createClient({ connectionString: uri, lockTimeoutMs: bad })).toThrow();
      expect(() => createClient({ connectionString: uri, idleInTxTimeoutMs: bad })).toThrow();
    }
  });

  it("rejects a connectionString query parameter that would override a validated setting", () => {
    for (const p of [
      "statement_timeout=0",
      "lock_timeout=0",
      "idle_in_transaction_session_timeout=0",
      "search_path=public",
    ]) {
      expect(() => createClient({ connectionString: `postgres://u:p@127.0.0.1:5432/db?${p}` })).toThrow();
    }
    // case-insensitive (PostgreSQL GUC names are case-insensitive) and multi-host DSNs (new URL()
    // fails to parse them, but postgres.js accepts them) must also be rejected (audit).
    expect(() => createClient({ connectionString: "postgres://u:p@127.0.0.1:5432/db?STATEMENT_TIMEOUT=0" })).toThrow();
    expect(() => createClient({ connectionString: "postgres://u:p@host1,host2:5432/db?statement_timeout=0" })).toThrow();
  });

  it("the exported defaults are the documented conservative values", () => {
    expect(DEFAULT_STATEMENT_TIMEOUT_MS).toBe(120_000);
    expect(DEFAULT_LOCK_TIMEOUT_MS).toBe(30_000);
    expect(DEFAULT_IDLE_IN_TX_TIMEOUT_MS).toBe(120_000);
  });
});
