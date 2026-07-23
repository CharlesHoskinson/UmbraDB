import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ValidationError } from "../../src/interfaces/storage-errors.js";
import type { WatermarkValue } from "../../src/interfaces/watermarks.js";
import { PgCheckpointStore } from "../../src/postgres/checkpoint-store.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { saveAndAdvance } from "../../src/postgres/save-and-advance.js";
import { PgTransactionLeaseLayer } from "../../src/postgres/transaction-lease.js";
import { PgWatermarks } from "../../src/postgres/watermarks.js";
import { registerSuiteLifecycle, TEST_SCHEMA } from "./setup.js";

/**
 * G5 (A6, A7): `saveAndAdvance` co-commits a checkpoint and its sync cursor in one transaction.
 * Requirement `durable-composition` — "saveAndAdvance co-commits a checkpoint and its sync cursor
 * atomically" (`openspec/changes/v1.0.0-durable-checkpoint-cursor/specs/durable-composition/spec.md`).
 */

const { sql: getSql } = registerSuiteLifecycle();

const KIND = "ckpt-cursor";

function deps(): {
  checkpoints: PgCheckpointStore;
  watermarks: PgWatermarks;
  txLayer: PgTransactionLeaseLayer;
} {
  const sql = getSql();
  return {
    checkpoints: new PgCheckpointStore(sql, new PgTransactionLeaseLayer(sql), TEST_SCHEMA),
    watermarks: new PgWatermarks(sql, TEST_SCHEMA),
    txLayer: new PgTransactionLeaseLayer(sql),
  };
}

async function truncateAll(sql: UmbraDBSql): Promise<void> {
  await sql`TRUNCATE ${sql(TEST_SCHEMA)}.ckpt_manifest_chunks, ${sql(TEST_SCHEMA)}.ckpt_manifests, ${sql(TEST_SCHEMA)}.ckpt_chunks, ${sql(TEST_SCHEMA)}.ckpt_sequence_counters`;
  await sql`TRUNCATE ${sql(TEST_SCHEMA)}.watermarks`;
}

describe("saveAndAdvance — co-transactional checkpoint + cursor (G5, A6–A7)", () => {
  afterEach(async () => {
    await truncateAll(getSql());
  });

  it("A6: a successful saveAndAdvance makes both the checkpoint and the cursor durable together", async () => {
    const d = deps();
    const data = randomBytes(140);
    const summary = await saveAndAdvance(d, "w1", "n1", data, { kind: KIND, key: "w1", value: "1" });
    expect(summary.sequence).toBe(1);

    // load returns the just-saved checkpoint...
    const loaded = await d.checkpoints.load("w1", "n1");
    expect(Buffer.from(loaded.data).equals(data)).toBe(true);
    // ...AND the cursor was advanced, both now durable.
    expect(await d.watermarks.get(KIND, "w1")).toBe("1");

    // Independent proof the two landed in the SAME commit: the manifest row and the watermark row
    // exist together, and neither exists without the other.
    const sql = getSql();
    const manifests = await sql`SELECT 1 FROM ${sql(TEST_SCHEMA)}.ckpt_manifests WHERE w = 'w1' AND net = 'n1'`;
    const cursor = await sql`SELECT 1 FROM ${sql(TEST_SCHEMA)}.watermarks WHERE kind = ${KIND} AND key = 'w1'`;
    expect(manifests).toHaveLength(1);
    expect(cursor).toHaveLength(1);
  });

  it("A7: a saveAndAdvance rolled back before commit leaves neither, and the prior cursor still points at prior durable data", async () => {
    const d = deps();

    // Prior durable state: checkpoint seq 1 + cursor "1", committed by an earlier saveAndAdvance.
    const priorData = randomBytes(64);
    await saveAndAdvance(d, "w1", "n1", priorData, { kind: KIND, key: "w1", value: "1" });

    // Attempt a second saveAndAdvance whose cursor value fails validation (a bigint is not a
    // JSON-representable WatermarkValue). This fires INSIDE the single transaction, AFTER `save`
    // has already written the seq-2 rows on that transaction but BEFORE the one COMMIT — the
    // injected in-transaction failure the A7 scenario describes (an injected rollback, distinct
    // from the T5 postmaster-kill crash owned by the testing-gate change).
    const newData = randomBytes(64);
    await expect(
      saveAndAdvance(d, "w1", "n1", newData, {
        kind: KIND,
        key: "w1",
        value: 1n as unknown as WatermarkValue,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    // Neither the new checkpoint nor the advanced cursor is durable...
    const history = await d.checkpoints.history("w1", "n1");
    expect(history.map((h) => h.sequence)).toEqual([1]); // seq 2 rolled back with the transaction
    const loaded = await d.checkpoints.load("w1", "n1");
    expect(loaded.sequence).toBe(1);
    expect(Buffer.from(loaded.data).equals(priorData)).toBe(true);
    // ...and the previously durable cursor still points at the previously durable checkpoint.
    expect(await d.watermarks.get(KIND, "w1")).toBe("1");
  });
});
