import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { ISql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "../../src/postgres/client.js";
import { ValidationError } from "../../src/interfaces/storage-errors.js";
import { MigrationLockTimeoutError, runMigrations } from "../../src/postgres/migrate.js";

// G7 task 2.2 — the migration advisory-lock acquire is bounded and fails fast with a typed error
// (openspec/changes/v1.0.0-durable-checkpoint-cursor: design.md §3.2; roadmap T8).

describe("G7 bounded migration-lock acquire (design.md §3.2)", () => {
  let container: StartedPostgreSqlContainer;
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);
  afterAll(async () => {
    await container?.stop();
  });

  it("a held migration lock makes a second runMigrations fail fast with MigrationLockTimeoutError (T8)", async () => {
    const schema = "g7_locktest";
    const holder = createClient({ connectionString: container.getConnectionUri(), schema, maxConnections: 1 });
    const held = (await holder.reserve()) as unknown as ISql;
    // Hold the exact class-1 lock runMigrations acquires: pg_advisory_lock(1, hashtext(schema)).
    await held`select pg_advisory_lock(1, hashtext(${schema}))`;
    try {
      const migrator = createClient({ connectionString: container.getConnectionUri(), schema });
      try {
        const start = performance.now();
        await expect(
          runMigrations(migrator, { schema, migrationLockTimeoutMs: 1500 }),
        ).rejects.toBeInstanceOf(MigrationLockTimeoutError);
        const elapsedMs = performance.now() - start;
        // Proves the 1.5s bound actually fired — not the connection's 120s statement_timeout and
        // not an unbounded hang (either would blow this test's timeout).
        expect(elapsedMs).toBeGreaterThan(1000);
        expect(elapsedMs).toBeLessThan(8000);
      } finally {
        await migrator.end({ timeout: 5 });
      }
    } finally {
      await held`select pg_advisory_unlock(1, hashtext(${schema}))`.catch(() => {});
      (held as unknown as { release: () => void }).release();
      await holder.end({ timeout: 5 });
    }
  }, 20_000);

  it("a statement_timeout shorter than the lock bound still yields the typed MigrationLockTimeoutError (BLOCK)", async () => {
    const schema = "g7_stmt";
    const holder = createClient({ connectionString: container.getConnectionUri(), schema, maxConnections: 1 });
    const held = (await holder.reserve()) as unknown as ISql;
    await held`select pg_advisory_lock(1, hashtext(${schema}))`;
    try {
      // statement_timeout (100ms) fires BEFORE the 1500ms lock bound -> SQLSTATE 57014, which must
      // still surface as the typed error, not a raw UnrecognizedPostgresError.
      const migrator = createClient({ connectionString: container.getConnectionUri(), schema, statementTimeoutMs: 100 });
      try {
        await expect(
          runMigrations(migrator, { schema, migrationLockTimeoutMs: 1500 }),
        ).rejects.toBeInstanceOf(MigrationLockTimeoutError);
      } finally {
        await migrator.end({ timeout: 5 });
      }
    } finally {
      await held`select pg_advisory_unlock(1, hashtext(${schema}))`.catch(() => {});
      (held as unknown as { release: () => void }).release();
      await holder.end({ timeout: 5 });
    }
  }, 20_000);

  it("a successful acquire scopes and restores the prior lock_timeout (DDL not subject to the short bound)", async () => {
    const schema = "g7_restore";
    const sql = createClient({ connectionString: container.getConnectionUri(), schema, maxConnections: 1 });
    try {
      // Uncontended: the 100ms bound acquires instantly, migrations run, then the connection's
      // lock_timeout is restored to its default (30s = "30s"), NOT left at the short 100ms bound.
      await runMigrations(sql, { schema, migrationLockTimeoutMs: 100 });
      const reserved = (await sql.reserve()) as unknown as ISql;
      try {
        const rows = await reserved<{ v: string }[]>`select current_setting('lock_timeout') as v`;
        expect(rows[0]!.v).toBe("30s");
      } finally {
        (reserved as unknown as { release: () => void }).release();
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 30_000);

  it("rejects a non-positive or non-integer migrationLockTimeoutMs with ValidationError (never disables the bound)", async () => {
    const sql = createClient({ connectionString: container.getConnectionUri(), schema: "g7_validate" });
    try {
      await expect(runMigrations(sql, { schema: "g7_validate", migrationLockTimeoutMs: 0 })).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(runMigrations(sql, { schema: "g7_validate", migrationLockTimeoutMs: -5 })).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(
        runMigrations(sql, { schema: "g7_validate", migrationLockTimeoutMs: 1.5 }),
      ).rejects.toBeInstanceOf(ValidationError);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 30_000);
});
