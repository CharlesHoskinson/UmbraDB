import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PgCheckpointStore } from "../../src/postgres/checkpoint-store.js";
import { type UmbraDBSql } from "../../src/postgres/client.js";
import { PgTransactionLeaseLayer } from "../../src/postgres/transaction-lease.js";
import { registerSuiteLifecycle, TEST_SCHEMA } from "./setup.js";

// G13 — perf-correctness fixes (openspec/changes/v1.0.0-perf-baseline: HP-1, HP-2, IS-1, IS-2).

const { sql: getSql, connectionUri } = registerSuiteLifecycle();

function store(sql: UmbraDBSql): PgCheckpointStore {
  return new PgCheckpointStore(sql, new PgTransactionLeaseLayer(sql), TEST_SCHEMA);
}

// A payload guaranteed to split into >= N chunks at the given chunk size.
function payload(bytes: number): Uint8Array {
  const a = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) a[i] = i % 256;
  return a;
}

describe("G13 HP-1 batched save + HP-2 grouped history (design.md §1-§2)", () => {
  it("HP-1: a multi-chunk save issues exactly ONE chunk insert and ONE junction insert (bounded round-trips)", async () => {
    // A debug-instrumented raw client on the SAME migrated schema, counting the two insert kinds.
    const counts = { chunkInsert: 0, junctionInsert: 0 };
    const sql = postgres(connectionUri(), {
      max: 2,
      types: { bigint: postgres.BigInt },
      connection: { search_path: TEST_SCHEMA },
      debug: (_c, query) => {
        if (/insert\s+into\s+\S*ckpt_manifest_chunks\b/i.test(query)) counts.junctionInsert++;
        else if (/insert\s+into\s+\S*ckpt_chunks\b/i.test(query)) counts.chunkInsert++;
      },
    }) as UmbraDBSql;
    Object.defineProperty(sql, "umbradbSchema", { value: TEST_SCHEMA, enumerable: false });
    try {
      const summary = await store(sql).save("w-hp1", "net", payload(9), { chunkSize: 4 }); // 3 chunks
      expect(summary.chunkCount).toBe(3);
      expect(counts.chunkInsert).toBe(1); // was 3 (one per chunk) before HP-1
      expect(counts.junctionInsert).toBe(1); // was 3 before HP-1
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 30_000);

  it("HP-1 equivalence: the batched save stores identical chunk/junction/manifest rows and load round-trips", async () => {
    const s = store(getSql());
    const data = payload(10); // 3 chunks at chunkSize 4 (4+4+2)
    const summary = await s.save("w-eq", "net", data, { chunkSize: 4 });
    expect(summary.chunkCount).toBe(3);
    expect(summary.byteLength).toBe(10);

    // load round-trips byte-identically
    const loaded = await s.load("w-eq", "net");
    expect(Buffer.from(loaded.data)).toEqual(Buffer.from(data));

    // junction positions are 0..N-1 in order (verified directly)
    const sql = getSql();
    const pos = await sql<{ position: number }[]>`
      SELECT mc.position FROM ${sql(TEST_SCHEMA)}.ckpt_manifest_chunks mc
      JOIN ${sql(TEST_SCHEMA)}.ckpt_manifests m ON m.id = mc.manifest_id
      WHERE m.w = 'w-eq' AND m.net = 'net' ORDER BY mc.position
    `;
    expect(pos.map((p) => Number(p.position))).toEqual([0, 1, 2]);

    // re-saving the same content is idempotent at the chunk level (grace-window refresh, no dup-key)
    await expect(s.save("w-eq", "net", data, { chunkSize: 4 })).resolves.toBeDefined();
  }, 30_000);

  it("HP-2: history returns correct per-manifest aggregates for a page of manifests, in seq DESC order", async () => {
    const s = store(getSql());
    await s.save("w-hist", "net", payload(4), { chunkSize: 4 }); // seq 1: 1 chunk, 4 bytes
    await s.save("w-hist", "net", payload(9), { chunkSize: 4 }); // seq 2: 3 chunks, 9 bytes
    await s.save("w-hist", "net", payload(6), { chunkSize: 4 }); // seq 3: 2 chunks, 6 bytes
    const hist = await s.history("w-hist", "net");
    expect(hist.map((h) => h.sequence)).toEqual([3, 2, 1]); // seq DESC preserved
    expect(hist.map((h) => h.chunkCount)).toEqual([2, 3, 1]);
    expect(hist.map((h) => h.byteLength)).toEqual([6, 9, 4]);
  }, 30_000);
});

describe("G13 IS-1/IS-2 schema tuning (design.md §2-§3)", () => {
  it("IS-2: ckpt_chunks.size_bytes exists as a STORED generated column equal to octet_length(data)", async () => {
    const sql = getSql();
    const col = await sql<{ generation: string; type: string }[]>`
      SELECT is_generated AS generation, data_type AS type
      FROM information_schema.columns
      WHERE table_schema = ${TEST_SCHEMA} AND table_name = 'ckpt_chunks' AND column_name = 'size_bytes'
    `;
    expect(col).toHaveLength(1);
    expect(col[0]!.generation).toBe("ALWAYS");
    expect(col[0]!.type).toBe("integer");
    // and it equals octet_length(data) for stored rows
    const s = store(sql);
    await s.save("w-is2", "net", payload(7), { chunkSize: 16 }); // 1 chunk of 7 bytes
    const rows = await sql<{ ok: boolean }[]>`
      SELECT bool_and(size_bytes = octet_length(data)) AS ok FROM ${sql(TEST_SCHEMA)}.ckpt_chunks
    `;
    expect(rows[0]!.ok).toBe(true);
  }, 30_000);

  it("IS-1: kv_current is created with fillfactor=90", async () => {
    const sql = getSql();
    const rows = await sql<{ reloptions: string[] | null }[]>`
      SELECT reloptions FROM pg_class
      WHERE relname = 'kv_current' AND relnamespace = ${TEST_SCHEMA}::regnamespace
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reloptions ?? []).toContain("fillfactor=90");
  });
});
