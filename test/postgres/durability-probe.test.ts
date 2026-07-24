import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { ISql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import {
  assertNoTransactionPooler,
  classifyFsync,
  classifyFullPageWrites,
  classifySynchronousCommit,
  DurabilityContractError,
  probeAdvisoryLockVisibility,
  probeDurability,
  TransactionPoolerDetectedError,
  type DurabilityWarning,
} from "../../src/postgres/durability-probe.js";

// G6 — Durability startup probe + binding contract
// (openspec/changes/v1.0.0-durable-checkpoint-cursor: design.md §2, tasks 1.1/1.2, acceptance B1–B8)
//
// The pure classifiers (classifyFsync / classifyFullPageWrites / classifySynchronousCommit /
// assertNoTransactionPooler) hold the decision logic and are exercised exhaustively with no
// container; the live containers prove the probe reads the real server settings and wires those
// decisions into runMigrations. This split is why B2b's four "standby-oriented" synchronous_commit
// values (local/remote_write/remote_apply/on) are covered by the classifier unit test rather than
// four separate containers, while one live `synchronous_commit=local` container proves the durable
// value flows end-to-end.

const TEST_SCHEMA = "umbradb_test";

async function startPg(serverArgs: string[]): Promise<StartedPostgreSqlContainer> {
  const base = new PostgreSqlContainer("postgres:17-alpine");
  return serverArgs.length > 0 ? base.withCommand(["postgres", ...serverArgs]).start() : base.start();
}

function firstMigrationExists(sql: UmbraDBSql): Promise<boolean> {
  // to_regclass returns NULL (not an error) for a relation that does not exist yet, so this is
  // safe against a cold database that never ran migration 000 — it is exactly how the probe's
  // "having run no migration" claim is checked after a refusal.
  return sql<{ exists: boolean }[]>`
    select to_regclass(${TEST_SCHEMA + "._migrations"}) is not null as exists
  `.then((rows) => rows[0]!.exists);
}

describe("G6 durability probe — pure classifiers (no container)", () => {
  it("classifyFsync: off is a hard violation, on is clean (B1)", () => {
    const v = classifyFsync("off");
    expect(v).not.toBeNull();
    expect(v!.setting).toBe("fsync");
    expect(v!.value).toBe("off");
    expect(classifyFsync("on")).toBeNull();
  });

  it("classifyFullPageWrites: off refused by default, permitted under override, on clean (B3)", () => {
    const refused = classifyFullPageWrites("off", false);
    expect(refused).not.toBeNull();
    expect(refused!.setting).toBe("full_page_writes");
    expect(classifyFullPageWrites("off", true)).toBeNull(); // override
    expect(classifyFullPageWrites("on", false)).toBeNull();
  });

  it("classifySynchronousCommit: off is a lost-tail warning, never a violation (B2)", () => {
    const w = classifySynchronousCommit("off");
    expect(w).not.toBeNull();
    expect(w!.kind).toBe("lost-tail");
    expect(w!.setting).toBe("synchronous_commit");
    expect(w!.value).toBe("off");
  });

  it("classifySynchronousCommit: local/remote_write/remote_apply/on are durable, no warning (B2b)", () => {
    for (const durable of ["local", "remote_write", "remote_apply", "on"]) {
      expect(classifySynchronousCommit(durable)).toBeNull();
    }
  });

  it("assertNoTransactionPooler: only acquired-but-invisible signals a pooler; !acquired fails open (B6)", () => {
    // Direct unit-level injection of the "lock not visible on follow-up" condition, per task 1.2:
    // a faithful transaction-pooler (PgBouncer transaction mode) harness is impractical in CI, so
    // the invisibility branch is asserted here by feeding the decision function a zero visible
    // count. The live acquire+visible path is proven separately against a real session connection
    // in "probeAdvisoryLockVisibility observes its own lock" (B5) below.
    expect(() => assertNoTransactionPooler(true, 1)).not.toThrow();
    expect(() => assertNoTransactionPooler(true, 0)).toThrow(TransactionPoolerDetectedError);
    // !acquired is an anomaly (e.g. lock contention between concurrent probes), NOT a pooler
    // signature — fail open so a healthy concurrent startup is never falsely rejected; a real
    // pooler still shows as acquired-but-invisible above (audit BLOCK).
    expect(() => assertNoTransactionPooler(false, 0)).not.toThrow();
    expect(() => assertNoTransactionPooler(false, 3)).not.toThrow();
  });
});

describe("G6 durability probe — live against Testcontainers Postgres", () => {
  let healthy: StartedPostgreSqlContainer;
  let fsyncOff: StartedPostgreSqlContainer;
  let fpwOff: StartedPostgreSqlContainer;
  let syncOff: StartedPostgreSqlContainer;
  let syncLocal: StartedPostgreSqlContainer;

  beforeAll(async () => {
    [healthy, fsyncOff, fpwOff, syncOff, syncLocal] = await Promise.all([
      startPg([]),
      startPg(["-c", "fsync=off"]),
      startPg(["-c", "full_page_writes=off"]),
      startPg(["-c", "synchronous_commit=off"]),
      startPg(["-c", "synchronous_commit=local"]),
    ]);
  }, 240_000);

  afterAll(async () => {
    await Promise.all([
      healthy?.stop(), fsyncOff?.stop(), fpwOff?.stop(), syncOff?.stop(), syncLocal?.stop(),
    ]);
  });

  it("B4: healthy default server → no hard violation, no warning, runMigrations proceeds", async () => {
    const sql = createClient({ connectionString: healthy.getConnectionUri(), schema: TEST_SCHEMA });
    try {
      const warnings = await probeDurability(sql);
      expect(warnings).toEqual([]);
      await runMigrations(sql, { schema: TEST_SCHEMA });
      const rows = await sql<{ count: string }[]>`
        select count(*)::text as count from ${sql(TEST_SCHEMA)}._migrations
      `;
      // 7 = migrations 000..006 (perf-baseline added 005_kv_current_fillfactor +
      // 006_ckpt_chunks_size_bytes to the tier-1 lineage; keep in sync with migrate.test.ts).
      expect(Number(rows[0]!.count)).toBe(7);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  it("B1: fsync=off → runMigrations rejects with DurabilityContractError, no migration ran", async () => {
    const sql = createClient({ connectionString: fsyncOff.getConnectionUri(), schema: TEST_SCHEMA });
    try {
      await expect(probeDurability(sql)).rejects.toBeInstanceOf(DurabilityContractError);
      await expect(runMigrations(sql, { schema: TEST_SCHEMA })).rejects.toBeInstanceOf(DurabilityContractError);
      expect(await firstMigrationExists(sql)).toBe(false);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  it("B3: full_page_writes=off → refused by default; override lets runMigrations proceed", async () => {
    const sql = createClient({ connectionString: fpwOff.getConnectionUri(), schema: TEST_SCHEMA });
    try {
      await expect(runMigrations(sql, { schema: TEST_SCHEMA })).rejects.toBeInstanceOf(DurabilityContractError);
      expect(await firstMigrationExists(sql)).toBe(false);

      await runMigrations(sql, { schema: TEST_SCHEMA, durability: { allowFullPageWritesOff: true } });
      const rows = await sql<{ count: string }[]>`
        select count(*)::text as count from ${sql(TEST_SCHEMA)}._migrations
      `;
      expect(Number(rows[0]!.count)).toBe(7);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  it("B2: synchronous_commit=off → lost-tail warning, NOT a refusal; runMigrations proceeds and surfaces it", async () => {
    const sql = createClient({ connectionString: syncOff.getConnectionUri(), schema: TEST_SCHEMA });
    try {
      const warnings = await probeDurability(sql);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.kind).toBe("lost-tail");
      expect(warnings[0]!.setting).toBe("synchronous_commit");

      const surfaced: DurabilityWarning[] = [];
      await runMigrations(sql, {
        schema: TEST_SCHEMA,
        onDurabilityWarning: (ws) => surfaced.push(...ws),
      });
      expect(surfaced).toHaveLength(1);
      expect(surfaced[0]!.kind).toBe("lost-tail");
      const rows = await sql<{ count: string }[]>`
        select count(*)::text as count from ${sql(TEST_SCHEMA)}._migrations
      `;
      expect(Number(rows[0]!.count)).toBe(7);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  it("B2b: synchronous_commit=local → no lost-tail warning, runMigrations proceeds", async () => {
    const sql = createClient({ connectionString: syncLocal.getConnectionUri(), schema: TEST_SCHEMA });
    try {
      const warnings = await probeDurability(sql);
      expect(warnings).toEqual([]);
      const surfaced: DurabilityWarning[] = [];
      await runMigrations(sql, {
        schema: TEST_SCHEMA,
        onDurabilityWarning: (ws) => surfaced.push(...ws),
      });
      expect(surfaced).toEqual([]);
      const rows = await sql<{ count: string }[]>`
        select count(*)::text as count from ${sql(TEST_SCHEMA)}._migrations
      `;
      expect(Number(rows[0]!.count)).toBe(7);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  it("B5: probeAdvisoryLockVisibility observes its own session advisory lock on a direct connection", async () => {
    const sql = createClient({ connectionString: healthy.getConnectionUri(), schema: TEST_SCHEMA, maxConnections: 1 });
    try {
      const reserved = (await sql.reserve()) as unknown as ISql;
      try {
        const r = await probeAdvisoryLockVisibility(reserved);
        expect(r.acquired).toBe(true);
        expect(r.visibleCount).toBeGreaterThanOrEqual(1);
        // decision function agrees the direct connection is not behind a transaction pooler
        expect(() => assertNoTransactionPooler(r.acquired, r.visibleCount)).not.toThrow();
      } finally {
        (reserved as unknown as { release: () => void }).release();
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  it("a concurrent class-2 advisory-lock holder does not make the probe falsely detect a pooler (BLOCK fix)", async () => {
    // Another instance's probe (or any class-2 advisory-lock holder) holds the exact key the
    // pre-fix probe used as its single fixed sentinel. With a per-session key the sentinel never
    // collides, so this probe succeeds; the pre-fix fixed-key version failed here with a spurious
    // TransactionPoolerDetectedError, breaking concurrent runMigrations on a healthy direct primary.
    const other = createClient({ connectionString: healthy.getConnectionUri(), schema: TEST_SCHEMA, maxConnections: 1 });
    const otherConn = (await other.reserve()) as unknown as ISql;
    try {
      await otherConn`select pg_advisory_lock(2, hashtext('umbradb:durability-probe:pooler-detection'))`;
      const sql = createClient({ connectionString: healthy.getConnectionUri(), schema: TEST_SCHEMA });
      try {
        await expect(probeDurability(sql)).resolves.toEqual([]);
      } finally {
        await sql.end({ timeout: 5 });
      }
    } finally {
      await otherConn`select pg_advisory_unlock(2, hashtext('umbradb:durability-probe:pooler-detection'))`.catch(() => {});
      (otherConn as unknown as { release: () => void }).release();
      await other.end({ timeout: 5 });
    }
  }, 60_000);
});
