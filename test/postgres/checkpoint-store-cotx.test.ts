import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import {
  CheckpointNotFoundError,
  type SaveCheckpointOptions,
} from "../../src/interfaces/checkpoint-store.js";
import {
  Rollback,
  TransactionHandleInvalidError,
  TransactionRolledBackError,
  type TransactionHandle,
} from "../../src/interfaces/transaction-lease.js";
import { PgCheckpointStore } from "../../src/postgres/checkpoint-store.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { PgTransactionLeaseLayer } from "../../src/postgres/transaction-lease.js";
import { registerSuiteLifecycle, TEST_SCHEMA } from "./setup.js";

/**
 * G5 (A1–A5): `PgCheckpointStore.save` accepts and joins a caller-supplied `opts.tx`.
 * Requirement `durable-composition` — "save accepts and joins a caller-supplied transaction
 * handle" (`openspec/changes/v1.0.0-durable-checkpoint-cursor/specs/durable-composition/spec.md`).
 * All DB tests run against the shared Testcontainers Postgres (no mocks).
 */

const { sql: getSql, connectionUri } = registerSuiteLifecycle();

function store(): PgCheckpointStore {
  const sql = getSql();
  return new PgCheckpointStore(sql, new PgTransactionLeaseLayer(sql), TEST_SCHEMA);
}

function txLayer(): PgTransactionLeaseLayer {
  return new PgTransactionLeaseLayer(getSql());
}

async function truncateAll(sql: UmbraDBSql): Promise<void> {
  await sql`TRUNCATE ${sql(TEST_SCHEMA)}.ckpt_manifest_chunks, ${sql(TEST_SCHEMA)}.ckpt_manifests, ${sql(TEST_SCHEMA)}.ckpt_chunks, ${sql(TEST_SCHEMA)}.ckpt_sequence_counters`;
}

/** An independent physical connection, used to observe cross-transaction visibility. */
async function rawConnection(): Promise<postgres.Sql> {
  return postgres(connectionUri(), { max: 1, connection: { search_path: TEST_SCHEMA } });
}

/**
 * A dedicated single-connection pool whose postgres.js `debug` hook (`connection.js` calls
 * `options.debug(id, string, params, types)` once per statement dispatched to the server) counts
 * every statement issued on it. Backs a `PgCheckpointStore` for the A5 rejection cases so we can
 * assert **zero statements were issued** directly — a genuine pool-level query spy, strictly
 * stronger than the empty-tables proxy: it fires on ANY statement (a stray SELECT included), not
 * only ones that leave a durable row. `types.bigint` matches `createClient` so the store's own
 * `bigint` column handling is identical to production.
 */
async function spyPool(): Promise<{ sql: UmbraDBSql; issued: () => number; end: () => Promise<void> }> {
  let count = 0;
  const sql = postgres(connectionUri(), {
    max: 1,
    connection: { search_path: TEST_SCHEMA },
    types: { bigint: postgres.BigInt },
    debug: () => {
      count += 1;
    },
  });
  Object.defineProperty(sql, "umbradbSchema", { value: TEST_SCHEMA, enumerable: false });
  return { sql: sql as unknown as UmbraDBSql, issued: () => count, end: () => sql.end() };
}

const FAKE_TX = { __brand: "TransactionHandle", id: "fake-never-issued" } as unknown as TransactionHandle;

describe("PgCheckpointStore.save — co-transactional opts.tx (G5, A1–A5)", () => {
  afterEach(async () => {
    await truncateAll(getSql());
  });

  it("A1: SaveCheckpointOptions admits opts.tx at the type level (compiles only once the field exists)", () => {
    // Static-surface assertion. Under `tsc --noEmit` (the A1 CI gate) this only compiles after
    // `tx?: TransactionHandle` is added to SaveCheckpointOptions; vitest runs it as a trivial
    // runtime no-op. The whole file's `save(..., { tx })` call sites are the broader A1 evidence.
    const opts: SaveCheckpointOptions = { tx: FAKE_TX, label: "a1" };
    expect(opts.tx).toBe(FAKE_TX);
  });

  it("A2: save on a caller transaction commits with it, writing its rows on the caller's transaction", async () => {
    const layer = txLayer();
    const s = store();
    const data = randomBytes(120);
    const raw = await rawConnection();
    let externalRowsMidTx = -1;
    try {
      await layer.withTransaction(async (tx) => {
        await s.save("w1", "n1", data, { tx });
        // The manifest must live on the caller's still-open transaction: a wholly independent
        // connection MUST NOT observe it before that transaction commits. (With a save that opened
        // its own internal transaction instead, this row would already be committed and visible.)
        const rows = await raw<{ one: number }[]>`
          SELECT 1 AS one FROM ${raw(TEST_SCHEMA)}.ckpt_manifests WHERE w = 'w1' AND net = 'n1'
        `;
        externalRowsMidTx = rows.length;
      });
    } finally {
      await raw.end();
    }
    expect(externalRowsMidTx).toBe(0); // invisible externally until the caller's COMMIT
    const loaded = await s.load("w1", "n1"); // visible (and load-able) after the commit
    expect(Buffer.from(loaded.data).equals(data)).toBe(true);
  });

  it("A3: save on a caller transaction that rolls back leaves no manifest/junction/complete row", async () => {
    const layer = txLayer();
    const s = store();
    const sql = getSql();
    const data = randomBytes(80);

    await expect(
      layer.withTransaction(async (tx) => {
        await s.save("w1", "n1", data, { tx });
        throw new Rollback({ kind: "callback-requested", reason: "A3 co-tx rollback" });
      }),
    ).rejects.toBeInstanceOf(TransactionRolledBackError);

    await expect(s.load("w1", "n1")).rejects.toBeInstanceOf(CheckpointNotFoundError);
    const manifests = await sql`SELECT 1 FROM ${sql(TEST_SCHEMA)}.ckpt_manifests WHERE w = 'w1' AND net = 'n1'`;
    const junction = await sql`
      SELECT 1 FROM ${sql(TEST_SCHEMA)}.ckpt_manifest_chunks mc
      JOIN ${sql(TEST_SCHEMA)}.ckpt_manifests m ON m.id = mc.manifest_id
      WHERE m.w = 'w1' AND m.net = 'n1'`;
    expect(manifests).toHaveLength(0);
    expect(junction).toHaveLength(0);
  });

  it("A4: save with no tx returns the same CheckpointSummary shape and behaviour (regression)", async () => {
    const s = store();
    const data = randomBytes(230);
    const summary = await s.save("w1", "n1", data, { chunkSize: 100 });
    expect(summary).toMatchObject({
      sequence: 1,
      byteLength: 230,
      chunkCount: 3,
    });
    expect(summary.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.createdAt).toBeInstanceOf(Date);
    expect(Object.prototype.hasOwnProperty.call(summary, "label")).toBe(false);
    const loaded = await s.load("w1", "n1");
    expect(Buffer.from(loaded.data).equals(data)).toBe(true);
  });

  it("A5: a fabricated tx handle rejects with TransactionHandleInvalidError, issuing NO statement (pool query-count spy is zero)", async () => {
    const sql = getSql();
    const spy = await spyPool();
    try {
      const s = new PgCheckpointStore(spy.sql, new PgTransactionLeaseLayer(spy.sql), TEST_SCHEMA);
      const before = spy.issued();
      await expect(
        s.save("w1", "n1", randomBytes(30), { tx: FAKE_TX }),
      ).rejects.toBeInstanceOf(TransactionHandleInvalidError);
      // Directly: resolveTransaction rejects the fabricated handle BEFORE any statement is
      // dispatched to the server on the store's own pool -- not merely "the tables stayed empty".
      expect(spy.issued() - before).toBe(0);
    } finally {
      await spy.end();
    }
    // Corroborating durable state (observed from the shared pool): nothing was written anywhere.
    const chunks = await sql`SELECT 1 FROM ${sql(TEST_SCHEMA)}.ckpt_chunks`;
    const manifests = await sql`SELECT 1 FROM ${sql(TEST_SCHEMA)}.ckpt_manifests`;
    expect(chunks).toHaveLength(0);
    expect(manifests).toHaveLength(0);
  });

  it("A5: a stale (already-ended) tx handle rejects with TransactionHandleInvalidError, issuing NO statement (pool query-count spy is zero)", async () => {
    const sql = getSql();
    const spy = await spyPool();
    try {
      const layer = new PgTransactionLeaseLayer(spy.sql);
      const s = new PgCheckpointStore(spy.sql, layer, TEST_SCHEMA);
      let endedHandle!: TransactionHandle;
      await layer.withTransaction(async (tx) => {
        endedHandle = tx;
      });
      // Snapshot AFTER the setup transaction so its own BEGIN/COMMIT is excluded; the count then
      // measures ONLY what the rejecting save issues.
      const before = spy.issued();
      await expect(
        s.save("w1", "n1", randomBytes(30), { tx: endedHandle }),
      ).rejects.toBeInstanceOf(TransactionHandleInvalidError);
      expect(spy.issued() - before).toBe(0);
    } finally {
      await spy.end();
    }
    const manifests = await sql`SELECT 1 FROM ${sql(TEST_SCHEMA)}.ckpt_manifests`;
    expect(manifests).toHaveLength(0);
    // A rolled-back/absent claim consumes no sequence: the next real save still gets sequence 1.
    const summary = await store().save("w1", "n1", randomBytes(5));
    expect(summary.sequence).toBe(1);
  });
});
