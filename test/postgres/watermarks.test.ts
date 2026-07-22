import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionError, ValidationError } from "../../src/interfaces/storage-errors.js";
import { TransactionHandleInvalidError, type TransactionHandle } from "../../src/interfaces/transaction-lease.js";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { PgTransactionLeaseLayer } from "../../src/postgres/transaction-lease.js";
import { PgWatermarks } from "../../src/postgres/watermarks.js";
import { registerSuiteLifecycle, TEST_SCHEMA } from "./setup.js";

const { sql: getSql, connectionUri } = registerSuiteLifecycle();

function store(): PgWatermarks {
  return new PgWatermarks(getSql(), TEST_SCHEMA);
}

function txLayer(): PgTransactionLeaseLayer {
  return new PgTransactionLeaseLayer(getSql());
}

async function truncateAll(sql: UmbraDBSql): Promise<void> {
  await sql`TRUNCATE ${sql(TEST_SCHEMA)}.watermarks`;
}

async function rawConnection(): Promise<postgres.Sql> {
  return postgres(connectionUri(), { max: 1, connection: { search_path: TEST_SCHEMA } });
}

/** Sum of n_tup_ins + n_tup_upd for the watermarks table -- used as a proxy for "no row-changing
 *  statement was issued." Forces this backend's own accumulated stats to flush first (PG15+;
 *  matches the HOT test's own settle discipline above), since without it a just-issued INSERT/
 *  UPDATE could go uncounted here and produce a false "unchanged" reading. Still only a proxy,
 *  not a query-level spy: a SELECT, or an INSERT that fails a constraint before the row is
 *  counted (e.g. a NOT NULL violation), would not move this counter either way -- callers combine
 *  this with a direct row-count assertion where that distinction matters. */
async function watermarksWriteActivity(sql: UmbraDBSql): Promise<number> {
  await sql`SELECT pg_stat_force_next_flush()`;
  const rows = await sql<{ n: number }[]>`
    SELECT (coalesce(n_tup_ins, 0) + coalesce(n_tup_upd, 0))::int AS n
    FROM pg_stat_user_tables WHERE schemaname = ${TEST_SCHEMA} AND relname = 'watermarks'
  `;
  return rows[0]?.n ?? 0;
}

const FAKE_TX = { __brand: "TransactionHandle", id: "fake-never-issued" } as unknown as TransactionHandle;

describe("migrations/003_watermarks.ts schema (task 0.1)", () => {
  it("creates the table with exactly the specified columns/PK and fillfactor=90, no extra index", async () => {
    const sql = getSql();
    const columns = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${TEST_SCHEMA} AND table_name = 'watermarks'
    `;
    expect(columns.map((c) => c.column_name).sort()).toEqual(["key", "kind", "updated_at", "value"]);

    const pk = await sql<{ attname: string }[]>`
      SELECT a.attname
      FROM pg_constraint c
      JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.conrelid = ${TEST_SCHEMA + ".watermarks"}::regclass AND c.contype = 'p'
      ORDER BY k.ord
    `;
    expect(pk.map((r) => r.attname)).toEqual(["kind", "key"]);

    const reloptions = await sql<{ reloptions: string[] | null }[]>`
      SELECT reloptions FROM pg_class WHERE oid = ${TEST_SCHEMA + ".watermarks"}::regclass
    `;
    expect(reloptions[0]!.reloptions).toContain("fillfactor=90");

    const indexes = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = ${TEST_SCHEMA} AND tablename = 'watermarks'
    `;
    // Only the primary key's own index -- design.md §1's hard invariant: never index value/updated_at.
    expect(indexes).toHaveLength(1);
  });
});

describe("HOT-update behavior of the real watermarks table (task 0.2)", () => {
  // A genuine two-table (fillfactor=90 vs. 100) comparison was attempted here and empirically
  // did NOT isolate fillfactor's own causal contribution: both settings converged to a 100% HOT
  // ratio under a repeated same-key, same-size update workload, because Postgres's HOT pruning
  // reclaims the row's own prior tuple version efficiently once a couple of update cycles have
  // run, regardless of how much per-page slack fillfactor reserved at insert time -- the
  // differential effect this task originally set out to isolate is real (per the cited Postgres
  // docs and Crunchy Data guidance) but does not reproduce reliably in a short, deterministic,
  // single-connection benchmark like this one; reliably forcing the counterfactual would need
  // either much larger data volumes or genuinely concurrent multi-row page pressure, neither of
  // which fits a fast CI-blocking test. Recorded here as an accepted limitation, not silently
  // dropped: this test instead verifies the REAL watermarks table's actual HOT behavior under
  // realistic churn is good in practice (a meaningful regression check on its own -- it WOULD
  // catch e.g. a future index accidentally added on `value`/`updated_at`, design.md §1's hard
  // invariant, since that defeats HOT entirely regardless of fillfactor) without claiming this
  // isolates fillfactor=90's specific contribution versus the default.
  it("repeated same-key updates to the real watermarks table achieve a high HOT-update ratio", async () => {
    const sql = getSql();
    // pg_stat_force_next_flush() only flushes the CALLING backend's own accumulated stats, so
    // the whole loop -- the sets, the flush, and the settle-poll -- runs on one pinned reserved
    // connection, not the ambient pool, matching the discipline design.md/tasks.md called for.
    // The cast is safe here: PgWatermarks is given its schema explicitly, so it never reads
    // `.umbradbSchema` off this connection at runtime.
    const reserved = await sql.reserve();
    try {
      const s = new PgWatermarks(reserved as unknown as UmbraDBSql, TEST_SCHEMA);
      await s.set("hot", "k", { v: 0 });

      await reserved`SELECT pg_stat_force_next_flush()`;
      const before = await reserved<{ n_tup_upd: number; n_tup_hot_upd: number }[]>`
        SELECT n_tup_upd::int, n_tup_hot_upd::int FROM pg_stat_user_tables
        WHERE schemaname = ${TEST_SCHEMA} AND relname = 'watermarks'
      `;

      const UPDATE_ITERATIONS = 50;
      for (let i = 0; i < UPDATE_ITERATIONS; i++) {
        await s.set("hot", "k", { v: i });
      }

      let after: { n_tup_upd: number; n_tup_hot_upd: number } | undefined;
      const MAX_ATTEMPTS = 20;
      const POLL_INTERVAL_MS = 50;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        await reserved`SELECT pg_stat_force_next_flush()`;
        const rows = await reserved<{ n_tup_upd: number; n_tup_hot_upd: number }[]>`
          SELECT n_tup_upd::int, n_tup_hot_upd::int FROM pg_stat_user_tables
          WHERE schemaname = ${TEST_SCHEMA} AND relname = 'watermarks'
        `;
        const candidate = rows[0]!;
        if (candidate.n_tup_upd - before[0]!.n_tup_upd >= UPDATE_ITERATIONS) {
          after = candidate;
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      if (!after) throw new Error(`stats did not settle after ${MAX_ATTEMPTS} attempts`);

      const updDelta = after.n_tup_upd - before[0]!.n_tup_upd;
      const hotUpdDelta = after.n_tup_hot_upd - before[0]!.n_tup_hot_upd;
      expect(hotUpdDelta / updDelta).toBeGreaterThanOrEqual(0.9);
    } finally {
      reserved.release();
    }
  }, 30_000);
});

describe("PgWatermarks", () => {
  afterEach(async () => {
    await truncateAll(getSql());
  });

  describe("set — validation (task 1.1)", () => {
    it("rejects an invalid value with ValidationError, no row written, no statement issued", async () => {
      const sql = getSql();
      const before = await watermarksWriteActivity(sql);
      await expect(store().set("k", "key1", { bad: 1n as unknown as number })).rejects.toBeInstanceOf(ValidationError);
      const rows = await sql`SELECT 1 FROM ${sql(TEST_SCHEMA)}.watermarks WHERE kind = 'k' AND key = 'key1'`;
      expect(rows).toHaveLength(0);
      const after = await watermarksWriteActivity(sql);
      expect(after).toBe(before);
    });

    it("rejects a top-level null value with ValidationError, not UnrecognizedPostgresError or a raw 23502, no statement issued", async () => {
      const sql = getSql();
      const before = await watermarksWriteActivity(sql);
      await expect(store().set("k", "key1", null as unknown as string)).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as { code?: string }).code).not.toBe("UNRECOGNIZED_POSTGRES_ERROR");
        return true;
      });
      const rows = await sql`SELECT 1 FROM ${sql(TEST_SCHEMA)}.watermarks WHERE kind = 'k' AND key = 'key1'`;
      expect(rows).toHaveLength(0);
      const after = await watermarksWriteActivity(sql);
      expect(after).toBe(before);
    });

    it("setting the same value twice leaves exactly one row", async () => {
      const s = store();
      await s.set("k", "key1", { v: 1 });
      await s.set("k", "key1", { v: 1 });
      const sql = getSql();
      const rows = await sql`SELECT 1 FROM ${sql(TEST_SCHEMA)}.watermarks WHERE kind = 'k' AND key = 'key1'`;
      expect(rows).toHaveLength(1);
    });
  });

  describe("set/get — non-object JSON roots (task 1.2)", () => {
    it("a bare number value round-trips exactly", async () => {
      const s = store();
      await s.set("k", "n", 42);
      expect(await s.get("k", "n")).toBe(42);
    });

    it("a bare string value round-trips exactly", async () => {
      const s = store();
      await s.set("k", "s", "block-1234");
      expect(await s.get("k", "s")).toBe("block-1234");
    });
  });

  describe("set/get — transaction participation (task 1.3)", () => {
    it("a set inside a transaction is visible to a get using the same handle before commit", async () => {
      const layer = txLayer();
      const s = store();
      await layer.withTransaction(async (tx) => {
        await s.set("k", "tx1", { v: "in-flight" }, { tx });
        expect(await s.get("k", "tx1", { tx })).toEqual({ v: "in-flight" });
      });
    });

    it("a set rolled back with its transaction is not visible afterward", async () => {
      const layer = txLayer();
      const s = store();
      await expect(
        layer.withTransaction(async (tx) => {
          await s.set("k", "tx2", { v: "rolled-back" }, { tx });
          throw new Error("force rollback");
        }),
      ).rejects.toThrow("force rollback");
      expect(await s.get("k", "tx2")).toBeUndefined();
    });

    it("a stale (already-ended) transaction handle rejects with TransactionHandleInvalidError, no statement issued", async () => {
      const layer = txLayer();
      const s = store();
      const sql = getSql();
      let endedHandle!: TransactionHandle;
      await layer.withTransaction(async (tx) => {
        endedHandle = tx;
      });
      const before = await watermarksWriteActivity(sql);
      await expect(s.set("k", "stale", { v: 1 }, { tx: endedHandle })).rejects.toBeInstanceOf(TransactionHandleInvalidError);
      await expect(s.get("k", "stale", { tx: endedHandle })).rejects.toBeInstanceOf(TransactionHandleInvalidError);
      const after = await watermarksWriteActivity(sql);
      expect(after).toBe(before);
    });

    it("a fabricated transaction handle rejects with TransactionHandleInvalidError", async () => {
      const s = store();
      await expect(s.set("k", "fake", { v: 1 }, { tx: FAKE_TX })).rejects.toBeInstanceOf(TransactionHandleInvalidError);
      await expect(s.get("k", "fake", { tx: FAKE_TX })).rejects.toBeInstanceOf(TransactionHandleInvalidError);
    });
  });

  describe("set/get — large-integer convention (task 1.4)", () => {
    it("a large integer encoded as a decimal string round-trips digit-for-digit exactly", async () => {
      const s = store();
      await s.set("k", "big", "9007199254740993");
      expect(await s.get("k", "big")).toBe("9007199254740993");
    });

    it("the same magnitude as a bare JSON number is silently corrupted on read -- the documented risk, as an executable fact", async () => {
      // A JS numeric LITERAL `9007199254740993` (2^53 + 1) is already rounded to
      // 9007199254740992 by the JS parser before it ever reaches set() -- a test built that way
      // would only prove a round-trip of the already-rounded value, demonstrating nothing about
      // the actual failure mode design.md §4 documents. To prove the real risk, the numeric
      // literal is embedded directly in the SQL TEXT below, NOT bound as a parameter: a bound
      // parameter cast with `$n::jsonb` gets JSON-encoded by the driver as a JSON STRING first
      // (matching how `sql.json()` treats any JS value elsewhere in this codebase), which would
      // silently retest the already-covered string case above instead of a genuine bare JSON
      // number. Written into the query text, Postgres's own jsonb input parser reads it as an
      // exact, arbitrary-precision numeric with no JS number ever involved on the write side; the
      // corruption this test demonstrates happens only afterward, in get()'s JSON.parse on the
      // way out.
      const sql = getSql();
      await sql.unsafe(
        `INSERT INTO ${TEST_SCHEMA}.watermarks (kind, key, value, updated_at) VALUES ($1, $2, '9007199254740993'::jsonb, now())`,
        ["k", "bignum-raw"],
      );
      const s = store();
      expect(await s.get<number>("k", "bignum-raw")).toBe(9007199254740992);
    });
  });

  describe("get (task 2.1)", () => {
    it("resolves undefined for a never-set (kind, key), not an error", async () => {
      expect(await store().get("nobody", "nowhere")).toBeUndefined();
    });

    it("returns exactly the last of several sequential sets", async () => {
      const s = store();
      await s.set("k", "seq", { v: 1 });
      await s.set("k", "seq", { v: 2 });
      await s.set("k", "seq", { v: 3 });
      expect(await s.get("k", "seq")).toEqual({ v: 3 });
    });

    it("is unaffected by sets to a different kind or a different key", async () => {
      const s = store();
      await s.set("kindA", "keyA", "vA");
      await s.set("kindB", "keyA", "vB");
      await s.set("kindA", "keyB", "vC");
      // Three independent pairs, cross-checked: each resolves only its own value.
      expect(await s.get("kindA", "keyA")).toBe("vA");
      expect(await s.get("kindB", "keyA")).toBe("vB");
      expect(await s.get("kindA", "keyB")).toBe("vC");
    });

    it("T is a caller assertion only -- no runtime validation beyond the erased WatermarkValue shape", async () => {
      const s = store();
      await s.set("k", "typelie", { shape: "object" });
      // Read with a mismatched T -- must resolve the raw stored value, not throw a runtime
      // type error, per the interface's own "type lie, not a runtime error" contract.
      const result = await s.get<number>("k", "typelie");
      expect(result).toEqual({ shape: "object" });
    });
  });

  describe("cancellation (opts.signal) (task 3.1)", () => {
    it("an already-aborted signal rejects with AbortError before any statement, for both set and get", async () => {
      const controller = new AbortController();
      controller.abort();
      const s = store();
      const sql = getSql();
      const before = await watermarksWriteActivity(sql);
      await expect(s.set("k", "abort1", { v: 1 }, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      await expect(s.get("k", "abort1", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      const after = await watermarksWriteActivity(sql);
      expect(after).toBe(before);
    });

    it("a signal aborting after the call has begun does not interrupt set", async () => {
      const controller = new AbortController();
      const s = store();
      const promise = s.set("k", "abort2", { v: 1 }, { signal: controller.signal });
      controller.abort();
      await promise; // must resolve normally, not reject
      expect(await s.get("k", "abort2")).toEqual({ v: 1 });
    });

    it("a signal aborting after the call has begun does not interrupt get", async () => {
      const s = store();
      await s.set("k", "abort3", { v: 1 });
      const controller = new AbortController();
      const promise = s.get("k", "abort3", { signal: controller.signal });
      controller.abort();
      await expect(promise).resolves.toEqual({ v: 1 });
    });
  });

  describe("connection-failure translation (task 3.2)", () => {
    it("set and get each reject with ConnectionError, not a raw driver error -- get distinctly from resolving undefined", async () => {
      const deadSql = createClient({
        connectionString: "postgres://nouser:nopass@127.0.0.1:1/nonexistent",
        schema: TEST_SCHEMA,
        maxConnections: 1,
        // Fail fast: this endpoint is unreachable and, in environments where a closed port hangs
        // rather than refusing (WSL2), the 30s default connect timeout outlives the test timeout.
        connectTimeout: 2,
      });
      try {
        const s = new PgWatermarks(deadSql, TEST_SCHEMA);
        await expect(s.set("k", "unreachable", { v: 1 })).rejects.toBeInstanceOf(ConnectionError);
        // Distinct from the "never-set cursor resolves undefined" contract: a connection failure
        // must reject, not resolve undefined as if the key simply hadn't been set.
        await expect(s.get("k", "unreachable")).rejects.toBeInstanceOf(ConnectionError);
      } finally {
        await deadSql.end({ timeout: 1 });
      }
    });
  });
});
