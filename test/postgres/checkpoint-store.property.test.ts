import { createHash, randomBytes } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PgCheckpointStore } from "../../src/postgres/checkpoint-store.js";
import { PgTransactionLeaseLayer } from "../../src/postgres/transaction-lease.js";
import { registerSuiteLifecycle, TEST_SCHEMA } from "./setup.js";

const { sql: getSql } = registerSuiteLifecycle();

function store(): PgCheckpointStore {
  const sql = getSql();
  return new PgCheckpointStore(sql, new PgTransactionLeaseLayer(sql), TEST_SCHEMA);
}

let walletCounter = 0;
function freshWallet(): string {
  walletCounter += 1;
  return `prop-wallet-${walletCounter}`;
}

describe("CheckpointStore properties (Formal/STORAGE_ALGEBRA.md §5)", () => {
  it("P6 (chunk idempotence): saving the same (hash, data) twice leaves stored data unchanged and chunk count unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 8, max: 200 }), async (size) => {
        const w = freshWallet();
        const chunk = randomBytes(size);
        const chunkHash = createHash("sha256").update(chunk).digest();
        const s = store();
        await s.save(w, "net", chunk, { chunkSize: size }); // exactly one chunk
        const sql = getSql();
        // Scoped to THIS chunk's own hash -- ckpt_chunks is a global, cross-wallet table shared
        // by every fast-check iteration in this same it() call (no truncate between them), so an
        // unscoped SELECT over the whole table would count prior iterations' unrelated chunks too.
        const before = await sql`SELECT hash, data FROM ${sql(TEST_SCHEMA)}.ckpt_chunks WHERE hash = ${chunkHash}`;
        await s.save(w, "net", chunk, { chunkSize: size }); // same content again
        const after = await sql<{ hash: Buffer; data: Buffer }[]>`
          SELECT hash, data FROM ${sql(TEST_SCHEMA)}.ckpt_chunks WHERE hash = ${chunkHash}
        `;
        expect(after).toHaveLength(before.length); // no new row for the same hash
        expect(after).toHaveLength(1);
        expect(after[0]!.data.equals(chunk)).toBe(true);
      }),
      { numRuns: 10 },
    );
  }, 60_000);

  it("P7 (Law C1, adapter-private diagnostic): the resulting global chunk set is identical regardless of save order", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 16, max: 64 }), { minLength: 3, maxLength: 3 }),
        async (sizes) => {
          const chunks = sizes.map((n) => randomBytes(n));
          const sql = getSql();
          // ckpt_chunks is global and shared across every fast-check iteration within this one
          // it() call -- truncate at the START of each iteration too (not just between the
          // forward/reversed passes within one iteration), or the forward pass here would pick
          // up leftover chunks from the PREVIOUS iteration's reversed pass.
          await sql`TRUNCATE ${sql(TEST_SCHEMA)}.ckpt_manifest_chunks, ${sql(TEST_SCHEMA)}.ckpt_manifests, ${sql(TEST_SCHEMA)}.ckpt_chunks, ${sql(TEST_SCHEMA)}.ckpt_sequence_counters`;

          const wForward = freshWallet();
          const sForward = store();
          for (const c of chunks) await sForward.save(wForward, "net", c, { chunkSize: c.byteLength });
          const forwardHashes = (
            await sql<{ hash: Buffer }[]>`SELECT hash FROM ${sql(TEST_SCHEMA)}.ckpt_chunks ORDER BY hash`
          ).map((r) => r.hash.toString("hex"));

          await sql`TRUNCATE ${sql(TEST_SCHEMA)}.ckpt_manifest_chunks, ${sql(TEST_SCHEMA)}.ckpt_manifests, ${sql(TEST_SCHEMA)}.ckpt_chunks, ${sql(TEST_SCHEMA)}.ckpt_sequence_counters`;

          const wReversed = freshWallet();
          const sReversed = store();
          for (const c of [...chunks].reverse()) await sReversed.save(wReversed, "net", c, { chunkSize: c.byteLength });
          const reversedHashes = (
            await sql<{ hash: Buffer }[]>`SELECT hash FROM ${sql(TEST_SCHEMA)}.ckpt_chunks ORDER BY hash`
          ).map((r) => r.hash.toString("hex"));

          expect(reversedHashes).toEqual(forwardHashes);
        },
      ),
      { numRuns: 6 },
    );
  }, 60_000);

  it("P8 (Law C2a, black-box): after random interleaved save/prune, every checkpoint history() still lists reloads without ChunkMissingError/ChunkIntegrityError/CheckpointNotFoundError", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            kind: fc.constantFrom("save", "prune"),
            retain: fc.integer({ min: 1, max: 3 }),
          }),
          { minLength: 5, maxLength: 15 },
        ),
        async (ops) => {
          const wallets = ["pw1", "pw2"].map(() => freshWallet());
          const sharedChunk = randomBytes(16);
          const s = store();

          for (const op of ops) {
            for (const w of wallets) {
              if (op.kind === "save") {
                await s.save(w, "net", Buffer.concat([sharedChunk, randomBytes(8)]), { chunkSize: 16 });
              } else {
                await s.prune(w, "net", op.retain);
              }
            }
          }

          for (const w of wallets) {
            const history = await s.history(w, "net");
            for (const summary of history) {
              await expect(s.load(w, "net", summary.sequence)).resolves.toBeDefined();
            }
          }
        },
      ),
      { numRuns: 8 },
    );
  }, 120_000);
});
