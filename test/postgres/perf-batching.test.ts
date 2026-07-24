import { createHash } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PgCheckpointStore } from "../../src/postgres/checkpoint-store.js";
import { type UmbraDBSql } from "../../src/postgres/client.js";
import { PgTransactionLeaseLayer } from "../../src/postgres/transaction-lease.js";
import { registerSuiteLifecycle, TEST_SCHEMA } from "./setup.js";

// G13 — perf-correctness fixes (openspec/changes/v1.0.0-perf-baseline: HP-1, HP-2, IS-1, IS-2)
// plus the cross-vendor audit's empty-safe / bind-param-cap guards on the batched save path.

const { sql: getSql, connectionUri } = registerSuiteLifecycle();

function store(sql: UmbraDBSql): PgCheckpointStore {
  return new PgCheckpointStore(sql, new PgTransactionLeaseLayer(sql), TEST_SCHEMA);
}

// A payload that splits into `bytes / chunkSize` distinct chunks: byte i = i % 256, so 4-byte
// chunks aligned to multiples of 4 are pairwise distinct up to 256 chunks.
function payload(bytes: number): Uint8Array {
  const a = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) a[i] = i % 256;
  return a;
}

function sha256(data: Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

// A raw, debug-instrumented client on the SAME migrated schema/container as the suite pool, so a
// test can COUNT the SQL statements a call emits (postgres.js `debug` hook — the acceptance.md
// A1/A5 "emitted-SQL" fallback when a per-statement spy is what postgres.js actually exposes).
function debugClient(onQuery: (query: string) => void): UmbraDBSql {
  const sql = postgres(connectionUri(), {
    max: 2,
    types: { bigint: postgres.BigInt },
    connection: { search_path: TEST_SCHEMA },
    debug: (_c, query) => onQuery(query),
  }) as UmbraDBSql;
  Object.defineProperty(sql, "umbradbSchema", { value: TEST_SCHEMA, enumerable: false });
  return sql;
}

describe("BLOCK 1+2 — empty-safe + bind-param-cap-safe batched inserts (design.md §1)", () => {
  it("empty-data save persists a 0-chunk manifest that round-trips to empty (empty-safe insert)", async () => {
    // An empty save produces chunkRows=[] and junctionRows=[]; the batched loops run ZERO
    // iterations and issue no statement (never rendering an invalid empty `VALUES`), so the
    // manifest persists with 0 chunks / 0 bytes and load/history observe exactly that — the
    // pre-HP-1 per-chunk loop's behaviour.
    const s = store(getSql());
    const summary = await s.save("w-empty", "net", new Uint8Array(0));
    expect(summary.chunkCount).toBe(0);
    expect(summary.byteLength).toBe(0);

    const loaded = await s.load("w-empty", "net");
    expect(loaded.byteLength).toBe(0);
    expect(Buffer.from(loaded.data).length).toBe(0);

    const hist = await s.history("w-empty", "net");
    expect(hist).toHaveLength(1);
    expect(hist[0]!.chunkCount).toBe(0);
    expect(hist[0]!.byteLength).toBe(0);
  }, 30_000);

  it("param-cap: a save of 30,000 junction rows exceeds the old single-statement bind-param cap and now succeeds", async () => {
    // 30,000 chunks of 1 byte -> 30,000 junction rows -> 90,000 bind params in a single INSERT,
    // which exceeds PostgreSQL's 65,535 protocol cap (the old unconditional single statement would
    // throw). The batched loop issues ceil(30000/10000)=3 junction inserts, each well under the cap.
    // (With chunkSize:1 the unique chunk hashes are <=256, so the chunk table stays tiny; the
    // junction table holds all 30,000 positions.)
    const s = store(getSql());
    const data = payload(30_000);
    const summary = await s.save("w-big", "net", data, { chunkSize: 1 });
    expect(summary.chunkCount).toBe(30_000);

    const loaded = await s.load("w-big", "net");
    expect(Buffer.from(loaded.data)).toEqual(Buffer.from(data));
  }, 120_000);
});

describe("BLOCK 3 — HP-1 acceptance A1–A4 (design.md §1)", () => {
  it("A1: statement count is CONSTANT across N (exactly 1 chunk-insert + 1 junction-insert per save, N in {1,16,64})", async () => {
    // Each N <= INSERT_ROW_BATCH (10,000), so the batched loops emit exactly one statement each,
    // independent of N — the round count does not grow with N (was 2N single-row awaits pre-HP-1).
    for (const n of [1, 16, 64]) {
      const counts = { chunkInsert: 0, junctionInsert: 0 };
      const sql = debugClient((query) => {
        if (/insert\s+into\s+\S*ckpt_manifest_chunks\b/i.test(query)) counts.junctionInsert++;
        else if (/insert\s+into\s+\S*ckpt_chunks\b/i.test(query)) counts.chunkInsert++;
      });
      try {
        const summary = await store(sql).save(`w-a1-${n}`, "net", payload(n * 4), { chunkSize: 4 });
        expect(summary.chunkCount).toBe(n);
        expect(counts.chunkInsert).toBe(1); // constant across N — was N before HP-1
        expect(counts.junctionInsert).toBe(1); // constant across N — was N before HP-1
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
  }, 60_000);

  it("A2/A3: a repeated chunk dedups in ckpt_chunks yet every position is recorded; manifest_hash + load are exact", async () => {
    const s = store(getSql());
    const chunkA = Buffer.from([1, 2, 3, 4]);
    const data = Buffer.concat([chunkA, chunkA]); // two byte-identical 4-byte chunks
    const summary = await s.save("w-a3", "net", data, { chunkSize: 4 });
    expect(summary.chunkCount).toBe(2);
    expect(summary.byteLength).toBe(8);

    // manifest_hash equals an independently computed sha256(concat(chunkHashes)) — the repeat's
    // hash appears twice in the sequence even though the chunk is stored once.
    const h = sha256(chunkA);
    const expectedManifestHash = sha256(Buffer.concat([h, h])).toString("hex");
    expect(summary.manifestHash).toBe(expectedManifestHash);

    // load round-trips byte-identically and passes every integrity check (per-chunk hash,
    // dense-position, recomputed-manifest-hash — load would throw otherwise).
    const loaded = await s.load("w-a3", "net");
    expect(Buffer.from(loaded.data)).toEqual(data);
    expect(loaded.manifestHash).toBe(expectedManifestHash);

    const sql = getSql();
    // the junction table has a row for EVERY position, including the repeat
    const pos = await sql<{ position: number }[]>`
      SELECT mc.position FROM ${sql(TEST_SCHEMA)}.ckpt_manifest_chunks mc
      JOIN ${sql(TEST_SCHEMA)}.ckpt_manifests m ON m.id = mc.manifest_id
      WHERE m.w = 'w-a3' AND m.net = 'net' ORDER BY mc.position
    `;
    expect(pos.map((p) => Number(p.position))).toEqual([0, 1]);
    // the chunk table stored the UNIQUE chunk only once (dedup by hash)
    const chunkRows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(TEST_SCHEMA)}.ckpt_chunks WHERE hash = ${h}
    `;
    expect(chunkRows[0]!.n).toBe(1);
  }, 30_000);

  it("A4: re-saving identical content REFRESHES ckpt_chunks.created_at (ON CONFLICT DO UPDATE, not DO NOTHING)", async () => {
    const s = store(getSql());
    const sql = getSql();
    const chunk = Buffer.from([9, 8, 7, 6]); // a chunk unique to this test
    const h = sha256(chunk);

    await s.save("w-a4", "net", chunk, { chunkSize: 4 });
    const before = await sql<{ created_at: Date }[]>`
      SELECT created_at FROM ${sql(TEST_SCHEMA)}.ckpt_chunks WHERE hash = ${h}
    `;
    // guarantee a measurable transaction-clock tick between the two saves (now() = txn timestamp)
    await new Promise((r) => setTimeout(r, 25));
    await s.save("w-a4b", "net", chunk, { chunkSize: 4 }); // same chunk content, re-referenced
    const after = await sql<{ created_at: Date }[]>`
      SELECT created_at FROM ${sql(TEST_SCHEMA)}.ckpt_chunks WHERE hash = ${h}
    `;
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1); // still exactly one row — a DO UPDATE, not a duplicate insert
    expect(after[0]!.created_at.getTime()).toBeGreaterThan(before[0]!.created_at.getTime());
  }, 30_000);

  it("HP-1 equivalence: the batched save stores identical junction positions and load round-trips", async () => {
    const s = store(getSql());
    const data = payload(10); // 3 chunks at chunkSize 4 (4+4+2)
    const summary = await s.save("w-eq", "net", data, { chunkSize: 4 });
    expect(summary.chunkCount).toBe(3);
    expect(summary.byteLength).toBe(10);

    const loaded = await s.load("w-eq", "net");
    expect(Buffer.from(loaded.data)).toEqual(Buffer.from(data));

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
});

describe("BLOCK 4 — HP-2 / IS-2 / IS-1 acceptance A5, A6, A8, A10 (design.md §2-§3)", () => {
  it("A5/A8: history(limit=50) over 50 manifests issues exactly TWO queries (page + one grouped aggregate over size_bytes)", async () => {
    const s = store(getSql());
    // 50 manifests for one wallet, varied so the aggregates are non-trivial: chunkCount cycles
    // 1..3 (byteLength = chunkCount*4) with distinct sequences 1..50.
    for (let k = 0; k < 50; k++) {
      const chunks = (k % 3) + 1;
      await s.save("w-a5", "net", payload(chunks * 4), { chunkSize: 4 });
    }

    const q = { page: 0, agg: 0, total: 0, aggSql: "" };
    const sql = debugClient((query) => {
      if (!/ckpt_/i.test(query)) return; // ignore BEGIN/COMMIT/isolation-level control statements
      q.total++;
      if (/from\s+\S*ckpt_manifests\b/i.test(query)) q.page++;
      if (/group\s+by/i.test(query) && /ckpt_manifest_chunks/i.test(query)) {
        q.agg++;
        q.aggSql = query;
      }
    });
    try {
      const hist = await store(sql).history("w-a5", "net", { limit: 50 });
      expect(hist).toHaveLength(50);

      // A5: exactly two queries total — one page + one grouped aggregate, NOT 1+N.
      expect(q.page).toBe(1);
      expect(q.agg).toBe(1);
      expect(q.total).toBe(2);

      // A6: aggregates correct for the whole page, in ORDER BY seq DESC.
      expect(hist.map((h) => h.sequence)).toEqual(Array.from({ length: 50 }, (_, i) => 50 - i));
      for (const h of hist) {
        const k = h.sequence - 1;
        const expectedChunks = (k % 3) + 1;
        expect(h.chunkCount).toBe(expectedChunks);
        expect(h.byteLength).toBe(expectedChunks * 4);
      }

      // A8/IS-2: the emitted aggregate SQL sums the stored size_bytes column, never octet_length(data).
      expect(q.aggSql).toMatch(/size_bytes/i);
      expect(q.aggSql).not.toMatch(/octet_length/i);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

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

  it("IS-1 + A10: kv_current has fillfactor=90 and EXACTLY ONE index — its primary key (no HOT-defeating secondary index)", async () => {
    const sql = getSql();
    const rows = await sql<{ reloptions: string[] | null }[]>`
      SELECT reloptions FROM pg_class
      WHERE relname = 'kv_current' AND relnamespace = ${TEST_SCHEMA}::regnamespace
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reloptions ?? []).toContain("fillfactor=90");

    // A10: no index on kv_current beyond the (ns,scope,key) primary key — a secondary index on a
    // changing column would defeat HOT, which IS-1 depends on.
    const idx = await sql<{ indisprimary: boolean }[]>`
      SELECT i.indisprimary FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      WHERE c.relname = 'kv_current' AND c.relnamespace = ${TEST_SCHEMA}::regnamespace
    `;
    expect(idx).toHaveLength(1); // exactly ONE index
    expect(idx[0]!.indisprimary).toBe(true); // and it is the primary key
  });
});
