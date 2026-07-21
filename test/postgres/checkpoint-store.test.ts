import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import {
  CheckpointNotFoundError,
  ChunkIntegrityError,
  ChunkMissingError,
  ManifestCorruptError,
} from "../../src/interfaces/checkpoint-store.js";
import { ValidationError } from "../../src/interfaces/storage-errors.js";
import { PgCheckpointStore } from "../../src/postgres/checkpoint-store.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { PgTransactionLeaseLayer } from "../../src/postgres/transaction-lease.js";
import { registerSuiteLifecycle, TEST_SCHEMA } from "./setup.js";

const { sql: getSql, connectionUri } = registerSuiteLifecycle();

function store(): PgCheckpointStore {
  const sql = getSql();
  return new PgCheckpointStore(sql, new PgTransactionLeaseLayer(sql), TEST_SCHEMA);
}

async function truncateAll(sql: UmbraDBSql): Promise<void> {
  await sql`TRUNCATE ${sql(TEST_SCHEMA)}.ckpt_manifest_chunks, ${sql(TEST_SCHEMA)}.ckpt_manifests, ${sql(TEST_SCHEMA)}.ckpt_chunks, ${sql(TEST_SCHEMA)}.ckpt_sequence_counters`;
}

function sha256(data: Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

/** A second, independent connection for tests that need raw SQL control the adapter's own
 *  public methods don't expose (fixture corruption, concurrency ordering). */
async function rawConnection(): Promise<postgres.Sql> {
  return postgres(connectionUri(), { max: 1, connection: { search_path: TEST_SCHEMA } });
}

describe("migrations/002_checkpoint_store.ts schema (tasks 0.1, 0.2)", () => {
  it("creates all four tables and both indexes", async () => {
    const sql = getSql();
    const tables = await sql<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = ${TEST_SCHEMA}
        AND tablename IN ('ckpt_chunks', 'ckpt_manifests', 'ckpt_manifest_chunks', 'ckpt_sequence_counters')
    `;
    expect(tables.map((t) => t.tablename).sort()).toEqual(
      ["ckpt_chunks", "ckpt_manifest_chunks", "ckpt_manifests", "ckpt_sequence_counters"],
    );
    const indexes = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = ${TEST_SCHEMA}
        AND indexname IN ('ckpt_manifests_lookup', 'ckpt_manifest_chunks_by_hash')
    `;
    expect(indexes.map((i) => i.indexname).sort()).toEqual(["ckpt_manifest_chunks_by_hash", "ckpt_manifests_lookup"]);
  });

  it("ckpt_manifest_chunks' primary key is (manifest_id, position), not (manifest_id, chunk_hash) — design.md §2.1", async () => {
    const sql = getSql();
    const pkColumns = await sql<{ attname: string }[]>`
      SELECT a.attname
      FROM pg_constraint c
      JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.conrelid = ${TEST_SCHEMA + ".ckpt_manifest_chunks"}::regclass AND c.contype = 'p'
      ORDER BY k.ord
    `;
    expect(pkColumns.map((r) => r.attname)).toEqual(["manifest_id", "position"]);
  });

  it("ckpt_manifest_chunks.manifest_id's FK delete action is CASCADE — without it every real prune fails with 23503", async () => {
    const sql = getSql();
    const fk = await sql<{ confdeltype: string }[]>`
      SELECT confdeltype FROM pg_constraint
      WHERE conrelid = ${TEST_SCHEMA + ".ckpt_manifest_chunks"}::regclass AND contype = 'f'
        AND conkey = (SELECT array_agg(attnum) FROM pg_attribute
                      WHERE attrelid = ${TEST_SCHEMA + ".ckpt_manifest_chunks"}::regclass AND attname = 'manifest_id')
    `;
    expect(fk).toHaveLength(1);
    expect(fk[0]!.confdeltype).toBe("c"); // 'c' = CASCADE
  });

  it("repeated-chunk regression: the same chunk_hash at two different positions in one manifest is admitted (design.md §2.1)", async () => {
    const sql = getSql();
    await sql`TRUNCATE ${sql(TEST_SCHEMA)}.ckpt_manifest_chunks, ${sql(TEST_SCHEMA)}.ckpt_manifests, ${sql(TEST_SCHEMA)}.ckpt_chunks`;

    const hashA = sha256(randomBytes(10));
    const hashB = sha256(randomBytes(10));
    await sql`INSERT INTO ${sql(TEST_SCHEMA)}.ckpt_chunks (hash, data) VALUES (${hashA}, ${randomBytes(10)}), (${hashB}, ${randomBytes(10)})`;
    const manifestRows = await sql<{ id: bigint }[]>`
      INSERT INTO ${sql(TEST_SCHEMA)}.ckpt_manifests (w, net, seq, complete, manifest_hash)
      VALUES ('w', 'n', 1, true, ${sha256(Buffer.concat([hashA, hashB, hashA]))})
      RETURNING id
    `;
    const manifestId = manifestRows[0]!.id;

    // hashA referenced at BOTH position 0 and position 2 -- would violate the original
    // PRIMARY KEY (manifest_id, chunk_hash) design; must succeed against the corrected schema.
    await sql`
      INSERT INTO ${sql(TEST_SCHEMA)}.ckpt_manifest_chunks (manifest_id, position, chunk_hash)
      VALUES (${manifestId}, 0, ${hashA}), (${manifestId}, 1, ${hashB}), (${manifestId}, 2, ${hashA})
    `;

    const rows = await sql<{ position: number; chunk_hash: Buffer }[]>`
      SELECT position, chunk_hash FROM ${sql(TEST_SCHEMA)}.ckpt_manifest_chunks
      WHERE manifest_id = ${manifestId} ORDER BY position
    `;
    expect(rows.map((r) => r.chunk_hash.toString("hex"))).toEqual(
      [hashA, hashB, hashA].map((h) => h.toString("hex")),
    );

    await sql`TRUNCATE ${sql(TEST_SCHEMA)}.ckpt_manifest_chunks, ${sql(TEST_SCHEMA)}.ckpt_manifests, ${sql(TEST_SCHEMA)}.ckpt_chunks`;
  });
});

describe("PgCheckpointStore", () => {
  afterEach(async () => {
    await truncateAll(getSql());
  });

  describe("save — chunking (task 1.1)", () => {
    it("a payload whose length is not an exact multiple of chunkSize produces a correctly-sized final chunk", async () => {
      const chunkSize = 100;
      const data = randomBytes(250); // 2 full chunks + 50-byte remainder
      const summary = await store().save("w1", "n1", data, { chunkSize });
      expect(summary.chunkCount).toBe(3);
      expect(summary.byteLength).toBe(250);

      const loaded = await store().load("w1", "n1");
      expect(Buffer.from(loaded.data).equals(data)).toBe(true);
    });

    it("a payload smaller than one chunk produces exactly one chunk", async () => {
      const data = randomBytes(10);
      const summary = await store().save("w1", "n1", data, { chunkSize: 1000 });
      expect(summary.chunkCount).toBe(1);
      const loaded = await store().load("w1", "n1");
      expect(Buffer.from(loaded.data).equals(data)).toBe(true);
    });

    it("writes complete = true explicitly on the manifest row (design.md §2.3)", async () => {
      await store().save("w1", "n1", randomBytes(10));
      const sql = getSql();
      const rows = await sql<{ complete: boolean }[]>`
        SELECT complete FROM ${sql(TEST_SCHEMA)}.ckpt_manifests WHERE w = 'w1' AND net = 'n1'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.complete).toBe(true);
    });

    it("rejects opts.chunkSize above the 16 MiB bound with ValidationError, doing no work (task 1.5)", async () => {
      await expect(
        store().save("w1", "n1", randomBytes(10), { chunkSize: 16 * 1024 * 1024 + 1 }),
      ).rejects.toBeInstanceOf(ValidationError);
      const sql = getSql();
      const chunkRows = await sql`SELECT 1 FROM ${sql(TEST_SCHEMA)}.ckpt_chunks`;
      const manifestRows = await sql`SELECT 1 FROM ${sql(TEST_SCHEMA)}.ckpt_manifests`;
      expect(chunkRows).toHaveLength(0);
      expect(manifestRows).toHaveLength(0);
      // Next valid save for this pair still gets sequence 1 -- no number was consumed.
      const summary = await store().save("w1", "n1", randomBytes(5));
      expect(summary.sequence).toBe(1);
    });
  });

  describe("save — dedup (task 1.3, Law C1)", () => {
    it("identical chunk content across different checkpoints is stored once, and refreshes created_at", async () => {
      const chunkSize = 50;
      const shared = randomBytes(50);
      await store().save("w1", "n1", shared, { chunkSize });
      const sql = getSql();
      const before = await sql<{ hash: Buffer; created_at: Date }[]>`
        SELECT hash, created_at FROM ${sql(TEST_SCHEMA)}.ckpt_chunks
      `;
      expect(before).toHaveLength(1);

      await new Promise((r) => setTimeout(r, 20));
      await store().save("w2", "n1", shared, { chunkSize }); // different wallet, same content

      const after = await sql<{ hash: Buffer; data: Buffer; created_at: Date }[]>`
        SELECT hash, data, created_at FROM ${sql(TEST_SCHEMA)}.ckpt_chunks
      `;
      expect(after).toHaveLength(1); // still exactly one row for that hash
      expect(after[0]!.data.equals(shared)).toBe(true);
      expect(after[0]!.created_at.getTime()).toBeGreaterThan(before[0]!.created_at.getTime());
    });
  });

  describe("save — sequence allocation (task 1.2)", () => {
    it("sequential saves for one wallet+network produce consecutive sequence numbers", async () => {
      const s = store();
      const seqs: number[] = [];
      for (let i = 0; i < 5; i++) {
        seqs.push((await s.save("w1", "n1", randomBytes(5))).sequence);
      }
      expect(seqs).toEqual([1, 2, 3, 4, 5]);
    });

    it("concurrent saves for one wallet+network produce a gapless, non-repeating sequence", async () => {
      const s = store();
      const results = await Promise.all(
        Array.from({ length: 20 }, () => s.save("w1", "n1", randomBytes(5))),
      );
      const seqs = results.map((r) => r.sequence).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    });

    it("returns sequence as a real JS number, not the driver's bigint", async () => {
      const summary = await store().save("w1", "n1", randomBytes(5));
      expect(typeof summary.sequence).toBe("number");
    });

    it("different wallet+network pairs have independent sequence counters", async () => {
      const s = store();
      expect((await s.save("wA", "nA", randomBytes(5))).sequence).toBe(1);
      expect((await s.save("wB", "nB", randomBytes(5))).sequence).toBe(1);
      expect((await s.save("wA", "nA", randomBytes(5))).sequence).toBe(2);
    });
  });

  describe("save — manifest_hash (task 1.4)", () => {
    it("identical payloads saved as separate checkpoints report the same manifestHash", async () => {
      const data = randomBytes(500);
      const a = await store().save("w1", "n1", data, { chunkSize: 100 });
      const b = await store().save("w1", "n1", data, { chunkSize: 100 });
      expect(a.manifestHash).toBe(b.manifestHash);
      expect(a.sequence).not.toBe(b.sequence);
    });

    it("payloads producing the same chunk hashes in a different order report different manifestHash", async () => {
      const chunkA = randomBytes(50);
      const chunkB = randomBytes(50);
      const forward = Buffer.concat([chunkA, chunkB]);
      const reversed = Buffer.concat([chunkB, chunkA]);
      const a = await store().save("w1", "n1", forward, { chunkSize: 50 });
      const b = await store().save("w1", "n1", reversed, { chunkSize: 50 });
      expect(a.manifestHash).not.toBe(b.manifestHash);
    });

    it("known-vector: manifestHash for a single-chunk payload equals an independently-computed SHA-256 over the chunk's own hash bytes", async () => {
      const data = randomBytes(37); // smaller than any chunkSize below -> exactly one chunk
      const summary = await store().save("w1", "n1", data, { chunkSize: 1024 });
      const expectedChunkHash = sha256(data);
      const expectedManifestHash = sha256(expectedChunkHash).toString("hex");
      expect(summary.manifestHash).toBe(expectedManifestHash);
    });
  });

  describe("save — label and summary metadata", () => {
    it("a label given at save time is returned by history and load; no label is undefined, not empty string", async () => {
      const s = store();
      await s.save("w1", "n1", randomBytes(10), { label: "pre-migration" });
      await s.save("w1", "n1", randomBytes(10)); // no label

      const loadedWithLabel = await s.load("w1", "n1", 1);
      expect(loadedWithLabel.label).toBe("pre-migration");
      const loadedWithoutLabel = await s.load("w1", "n1", 2);
      expect(loadedWithoutLabel.label).toBeUndefined();

      const history = await s.history("w1", "n1");
      expect(history.find((h) => h.sequence === 1)?.label).toBe("pre-migration");
      expect(history.find((h) => h.sequence === 2)?.label).toBeUndefined();
    });

    it("byteLength, chunkCount, and createdAt reflect the saved payload", async () => {
      const data = randomBytes(230);
      const summary = await store().save("w1", "n1", data, { chunkSize: 100 });
      expect(summary.byteLength).toBe(230);
      expect(summary.chunkCount).toBe(3);
      expect(summary.createdAt).toBeInstanceOf(Date);
    });
  });

  describe("load — round trip and integrity (task 2.1)", () => {
    it("round-trips a multi-chunk payload byte-identically", async () => {
      const data = randomBytes(1000);
      await store().save("w1", "n1", data, { chunkSize: 111 });
      const loaded = await store().load("w1", "n1");
      expect(Buffer.from(loaded.data).equals(data)).toBe(true);
    });

    it("a payload containing a repeated chunk (same content at two positions) round-trips correctly", async () => {
      const repeated = randomBytes(50);
      const middle = randomBytes(50);
      const data = Buffer.concat([repeated, middle, repeated]);
      await store().save("w1", "n1", data, { chunkSize: 50 });
      const loaded = await store().load("w1", "n1");
      expect(Buffer.from(loaded.data).equals(data)).toBe(true);

      const sql = getSql();
      const junctionRows = await sql<{ position: number }[]>`
        SELECT mc.position FROM ${sql(TEST_SCHEMA)}.ckpt_manifest_chunks mc
        JOIN ${sql(TEST_SCHEMA)}.ckpt_manifests m ON m.id = mc.manifest_id
        WHERE m.w = 'w1' AND m.net = 'n1' ORDER BY mc.position
      `;
      expect(junctionRows.map((r) => r.position)).toEqual([0, 1, 2]);
    });

    it("a mutated stored chunk raises ChunkIntegrityError with the correct hashes", async () => {
      const data = randomBytes(40);
      await store().save("w1", "n1", data, { chunkSize: 1000 });
      const sql = getSql();
      const chunkHash = sha256(data);
      await sql`UPDATE ${sql(TEST_SCHEMA)}.ckpt_chunks SET data = ${randomBytes(40)} WHERE hash = ${chunkHash}`;

      await expect(store().load("w1", "n1")).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(ChunkIntegrityError);
        expect((err as ChunkIntegrityError).expectedHash).toBe(chunkHash.toString("hex"));
        return true;
      });
    });

    it("a referenced chunk missing from storage raises ChunkMissingError, via a trigger-disabled fixture on the referenced table", async () => {
      const data = randomBytes(40);
      await store().save("w1", "n1", data, { chunkSize: 1000 });
      const chunkHash = sha256(data);
      const sql = getSql();
      // ckpt_chunks (the REFERENCED/parent table) is what actually enforces chunk_hash's FK
      // delete-check -- disabling triggers on ckpt_manifest_chunks (the child) would not
      // suppress it (design.md's own corrected rationale for this exact fixture).
      await sql.begin(async (tx) => {
        await tx`ALTER TABLE ${tx(TEST_SCHEMA)}.ckpt_chunks DISABLE TRIGGER ALL`;
        await tx`DELETE FROM ${tx(TEST_SCHEMA)}.ckpt_chunks WHERE hash = ${chunkHash}`;
        await tx`ALTER TABLE ${tx(TEST_SCHEMA)}.ckpt_chunks ENABLE TRIGGER ALL`;
      });

      await expect(store().load("w1", "n1")).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(ChunkMissingError);
        expect((err as ChunkMissingError).chunkHash).toBe(chunkHash.toString("hex"));
        return true;
      });
    });

    it("a manifest with a position gap raises ManifestCorruptError", async () => {
      const data = Buffer.concat([randomBytes(10), randomBytes(10), randomBytes(10)]);
      await store().save("w1", "n1", data, { chunkSize: 10 });
      const sql = getSql();
      await sql`
        DELETE FROM ${sql(TEST_SCHEMA)}.ckpt_manifest_chunks mc
        USING ${sql(TEST_SCHEMA)}.ckpt_manifests m
        WHERE mc.manifest_id = m.id AND m.w = 'w1' AND m.net = 'n1' AND mc.position = 1
      `;
      await expect(store().load("w1", "n1")).rejects.toBeInstanceOf(ManifestCorruptError);
    });

    it("manifest_hash tamper: substituting one junction row's chunk_hash for another valid one raises ManifestCorruptError (task 3.5)", async () => {
      const dataA = randomBytes(30);
      const dataB = randomBytes(30);
      await store().save("w1", "n1", dataA, { chunkSize: 1000 });
      await store().save("w1", "n1", dataB, { chunkSize: 1000 }); // a second, independently-valid chunk exists

      const sql = getSql();
      const chunkBHash = sha256(dataB);
      await sql`
        UPDATE ${sql(TEST_SCHEMA)}.ckpt_manifest_chunks mc
        SET chunk_hash = ${chunkBHash}
        FROM ${sql(TEST_SCHEMA)}.ckpt_manifests m
        WHERE mc.manifest_id = m.id AND m.w = 'w1' AND m.net = 'n1' AND m.seq = 1
      `;

      // Every per-chunk check now passes (chunkBHash is a real, individually-valid chunk), and
      // the position range is still dense -- only the manifest_hash recomputation catches this.
      await expect(store().load("w1", "n1", 1)).rejects.toBeInstanceOf(ManifestCorruptError);
    });
  });

  describe("load / history — not-found and empty-result distinction (task 2.3)", () => {
    it("load for a wallet+network with zero checkpoints rejects with CheckpointNotFoundError", async () => {
      await expect(store().load("nobody", "nowhere")).rejects.toBeInstanceOf(CheckpointNotFoundError);
    });

    it("load for a valid wallet+network but a never-written sequence rejects with CheckpointNotFoundError carrying that sequence", async () => {
      await store().save("w1", "n1", randomBytes(5));
      await expect(store().load("w1", "n1", 999)).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(CheckpointNotFoundError);
        expect((err as CheckpointNotFoundError).sequence).toBe(999);
        return true;
      });
    });

    it("omitting sequence loads the latest checkpoint", async () => {
      const s = store();
      await s.save("w1", "n1", randomBytes(5));
      await s.save("w1", "n1", randomBytes(5));
      const loaded = await s.load("w1", "n1");
      expect(loaded.sequence).toBe(2);
    });

    it("history for a wallet+network with zero checkpoints resolves empty, not an error", async () => {
      await store().save("other", "net", randomBytes(5));
      const history = await store().history("nobody", "nowhere");
      expect(history).toEqual([]);
    });
  });

  describe("history — pagination and scoping (task 2.2)", () => {
    it("pages newest-first with no gap or duplicate", async () => {
      const s = store();
      for (let i = 0; i < 7; i++) await s.save("w1", "n1", randomBytes(5));

      const page1 = await s.history("w1", "n1", { limit: 3 });
      expect(page1.map((h) => h.sequence)).toEqual([7, 6, 5]);

      const page2 = await s.history("w1", "n1", { limit: 3, before: page1[page1.length - 1]!.sequence });
      expect(page2.map((h) => h.sequence)).toEqual([4, 3, 2]);

      const seen = new Set([...page1, ...page2].map((h) => h.sequence));
      expect(seen.size).toBe(6);
    });

    it("history for one wallet+network never includes another's checkpoints", async () => {
      const s = store();
      await s.save("w1", "n1", randomBytes(5));
      await s.save("w2", "n1", randomBytes(5));
      const history = await s.history("w1", "n1");
      expect(history.every((h) => h.sequence >= 1)).toBe(true);
      expect(history).toHaveLength(1);
    });
  });

  describe("prune — validation (task 3.1)", () => {
    it("retainCount = 0 rejects with ValidationError and no effect", async () => {
      await store().save("w1", "n1", randomBytes(5));
      await expect(store().prune("w1", "n1", 0)).rejects.toBeInstanceOf(ValidationError);
      const history = await store().history("w1", "n1");
      expect(history).toHaveLength(1);
    });

    it.each([NaN, Infinity, 1.5, 1e20])("retainCount = %s rejects with ValidationError", async (bad) => {
      await expect(store().prune("w1", "n1", bad)).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("prune — retention (task 3.2)", () => {
    it("retaining 1 keeps only the newest checkpoint", async () => {
      const s = store();
      for (let i = 0; i < 5; i++) await s.save("w1", "n1", randomBytes(5));
      const result = await s.prune("w1", "n1", 1);
      expect(result.prunedSequences.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
      const history = await s.history("w1", "n1");
      expect(history.map((h) => h.sequence)).toEqual([5]);
    });

    it("retaining k keeps exactly the k newest", async () => {
      const s = store();
      for (let i = 0; i < 6; i++) await s.save("w1", "n1", randomBytes(5));
      const result = await s.prune("w1", "n1", 3);
      expect(result.prunedSequences.sort((a, b) => a - b)).toEqual([1, 2, 3]);
      const history = await s.history("w1", "n1");
      expect(history.map((h) => h.sequence).sort((a, b) => a - b)).toEqual([4, 5, 6]);
    });
  });

  describe("prune — GC safety (Law C2a, task 3.4)", () => {
    it("a chunk shared across wallets survives one wallet's prune", async () => {
      const shared = randomBytes(60);
      const s = store();
      await s.save("w1", "n1", shared, { chunkSize: 1000 });
      await s.save("w2", "n1", shared, { chunkSize: 1000 });
      // A second w1 checkpoint so retaining 1 actually prunes the first (the one referencing
      // `shared`) -- retaining 1 out of a single existing checkpoint would prune nothing.
      await s.save("w1", "n1", randomBytes(5), { chunkSize: 1000 });
      await s.prune("w1", "n1", 1);

      const loaded = await s.load("w2", "n1"); // w2's checkpoint still references `shared`
      expect(Buffer.from(loaded.data).equals(shared)).toBe(true);
    });

    it("adversarial: interleaved save/prune never orphans a live manifest's chunk", async () => {
      const s = store();
      const wallets = ["w1", "w2", "w3"];
      const sharedChunk = randomBytes(20);

      for (let round = 0; round < 8; round++) {
        await Promise.all(
          wallets.flatMap((w) => [
            s.save(w, "n1", Buffer.concat([sharedChunk, randomBytes(10)]), { chunkSize: 20 }),
            s.prune(w, "n1", 2),
          ]),
        );
      }

      for (const w of wallets) {
        const history = await s.history(w, "n1");
        for (const summary of history) {
          await expect(s.load(w, "n1", summary.sequence)).resolves.toBeDefined();
        }
      }
    });
  });

  describe("prune — grace window (task 3.3)", () => {
    it("a chunk within the grace window is never reclaimed even when currently unreferenced", async () => {
      const s = store();
      const data = randomBytes(20);
      await s.save("w1", "n1", data, { chunkSize: 1000 });
      await s.save("w1", "n1", randomBytes(5)); // unrelated second checkpoint
      await s.prune("w1", "n1", 1); // orphans the first checkpoint's chunk, freshly created

      const sql = getSql();
      const chunkHash = sha256(data);
      const rows = await sql`SELECT 1 FROM ${sql(TEST_SCHEMA)}.ckpt_chunks WHERE hash = ${chunkHash}`;
      expect(rows).toHaveLength(1); // still present -- grace window hasn't elapsed
    });

    it("deterministic: a chunk re-referenced by an uncommitted save is not reclaimed by a concurrent prune (READ COMMITTED re-evaluation)", async () => {
      const s = store();
      const chunkData = randomBytes(20);
      const chunkHash = sha256(chunkData);

      // Backdate the chunk's created_at past the grace window while still referenced.
      await s.save("w1", "n1", chunkData, { chunkSize: 1000 });
      const sql = getSql();
      await sql`UPDATE ${sql(TEST_SCHEMA)}.ckpt_chunks SET created_at = now() - interval '1 hour' WHERE hash = ${chunkHash}`;
      // Orphan it from w1's side.
      await s.save("w1", "n1", randomBytes(5));
      await s.prune("w1", "n1", 1);

      const rawA = await rawConnection();
      const rawB = await rawConnection();
      try {
        // Connection A: begin a transaction that re-references the chunk (refreshing created_at
        // via the dedup upsert) but does not commit yet. reserve() pins one physical connection
        // for the whole manual BEGIN/.../COMMIT sequence (a ReservedSql has no .begin(), matching
        // migrate.ts's own established manual-transaction pattern).
        const txA = await rawA.reserve();
        await txA`BEGIN`;
        await txA`
          INSERT INTO ${txA(TEST_SCHEMA)}.ckpt_chunks (hash, data) VALUES (${chunkHash}, ${chunkData})
          ON CONFLICT (hash) DO UPDATE SET created_at = now()
        `;

        // Connection B: run the reclaim DELETE concurrently. Under READ COMMITTED it initially
        // sees the still-stale (pre-refresh) created_at and attempts to lock the row, blocking
        // behind connection A's held lock.
        const reclaimPromise = rawB<{ hash: Buffer }[]>`
          DELETE FROM ${rawB(TEST_SCHEMA)}.ckpt_chunks c
          WHERE c.created_at < now() - interval '15 minutes'
            AND NOT EXISTS (SELECT 1 FROM ${rawB(TEST_SCHEMA)}.ckpt_manifest_chunks mc WHERE mc.chunk_hash = c.hash)
          RETURNING hash
        `;

        // Give B a moment to reach and block on the row lock, then commit A.
        await new Promise((r) => setTimeout(r, 200));
        await txA`COMMIT`;
        txA.release();

        const reclaimed = await reclaimPromise;
        expect(reclaimed.find((r) => r.hash.equals(chunkHash))).toBeUndefined();
      } finally {
        await rawA.end();
        await rawB.end();
      }

      const survives = await sql`SELECT 1 FROM ${sql(TEST_SCHEMA)}.ckpt_chunks WHERE hash = ${chunkHash}`;
      expect(survives).toHaveLength(1);
    });
  });

  describe("cancellation (opts.signal)", () => {
    it("an already-aborted signal rejects with AbortError before any statement, for all four methods", async () => {
      const controller = new AbortController();
      controller.abort();
      const s = store();
      await expect(s.save("w1", "n1", randomBytes(5), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      await expect(s.load("w1", "n1", undefined, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      // HistoryOptions' z.infer-derived type requires `limit` explicitly at the TS level even
      // though it defaults to 50 at runtime (z.infer resolves the post-default OUTPUT type).
      await expect(s.history("w1", "n1", { limit: 50, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      await expect(s.prune("w1", "n1", 1, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });

      const sql = getSql();
      const rows = await sql`SELECT 1 FROM ${sql(TEST_SCHEMA)}.ckpt_manifests`;
      expect(rows).toHaveLength(0);
    });

    it("a signal aborting after the call has begun does not interrupt it -- save still commits normally", async () => {
      const controller = new AbortController();
      const s = store();
      const promise = s.save("w1", "n1", randomBytes(50), { signal: controller.signal });
      controller.abort(); // fires after the call has already begun -- withAbort is pre-check-only
      const summary = await promise; // must resolve normally, not reject
      expect(summary.sequence).toBe(1);
      const history = await s.history("w1", "n1");
      expect(history).toHaveLength(1);
    });
  });
});
