import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PgCheckpointStore } from "../../src/postgres/checkpoint-store.js";
import { saveAndAdvance } from "../../src/postgres/save-and-advance.js";
import { PgTransactionLeaseLayer } from "../../src/postgres/transaction-lease.js";
import { PgWatermarks } from "../../src/postgres/watermarks.js";
import { registerSuiteLifecycle, TEST_SCHEMA } from "./setup.js";

/**
 * G5 (A9) — new property P11 (leaves STORAGE_ALGEBRA §5 P1–P10 unchanged).
 * Requirement `durable-composition` — "a conforming composition keeps the durable cursor from ever
 * being ahead of durable checkpoint data". Over randomized fault-free interleavings of BOTH
 * `saveAndAdvance` AND manual safe-ordering (data transaction committed, then the cursor advanced
 * in a separate transaction), the durable cursor never references an absent checkpoint, and
 * resume-from-cursor reproduces the reference CURRENT state.
 *
 * Determinism (guideline C1): payloads come from fast-check's seeded generator (no unseeded
 * randomness, no wall-clock); the seed is pinned and reported below.
 */

const { sql: getSql } = registerSuiteLifecycle();

/** Pinned, reported fast-check seed for P11 (guideline C1 / QA property-reproducibility). */
const P11_SEED = 20260723;
const P11_NUM_RUNS = 15;

const KIND = "ckpt-cursor";

function store(): PgCheckpointStore {
  const sql = getSql();
  return new PgCheckpointStore(sql, new PgTransactionLeaseLayer(sql), TEST_SCHEMA);
}

let walletCounter = 0;
function freshWallet(): string {
  walletCounter += 1;
  return `p11-wallet-${walletCounter}`;
}

describe("durable-composition property P11 (Formal/STORAGE_ALGEBRA.md W1; A9)", () => {
  it(`P11: fault-free, the cursor never references an absent checkpoint and resume reproduces current state (seed=${P11_SEED})`, async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            form: fc.constantFrom("combinator" as const, "manual" as const),
            data: fc.uint8Array({ minLength: 1, maxLength: 48 }),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        async (ops) => {
          const w = freshWallet();
          const net = "net";
          const key = w;
          const checkpoints = store();
          const sql = getSql();
          const watermarks = new PgWatermarks(sql, TEST_SCHEMA);
          const txLayer = new PgTransactionLeaseLayer(sql);
          const deps = { checkpoints, watermarks, txLayer };

          let referenceData: Buffer | undefined;
          let referenceSeq = 0;

          for (const op of ops) {
            const data = Buffer.from(op.data);
            const nextSeq = referenceSeq + 1;

            if (op.form === "combinator") {
              // Atomic co-commit: the cursor is advanced to the sequence this save will claim,
              // inside one transaction. One save per op ⇒ the claimed sequence is deterministic.
              const summary = await saveAndAdvance(deps, w, net, data, {
                kind: KIND,
                key,
                value: String(nextSeq),
              });
              expect(summary.sequence).toBe(nextSeq);
            } else {
              // Manual SAFE ordering: commit the data transaction first, then advance the cursor
              // strictly AFTER, in a separate transaction — the documented safe composition.
              const summary = await checkpoints.save(w, net, data);
              expect(summary.sequence).toBe(nextSeq);
              await watermarks.set(KIND, key, String(summary.sequence));
            }

            referenceSeq = nextSeq;
            referenceData = data;

            // Invariant 1: the durable cursor names a checkpoint that EXISTS (load must not throw).
            const cursorVal = await watermarks.get<string>(KIND, key);
            expect(cursorVal).toBeDefined();
            const cursorSeq = Number(cursorVal);
            const atCursor = await checkpoints.load(w, net, cursorSeq);

            // Invariant 2: resume-from-cursor reproduces the reference CURRENT state.
            expect(Buffer.from(atCursor.data).equals(referenceData)).toBe(true);
            expect(cursorSeq).toBe(referenceSeq);

            // The latest durable checkpoint is exactly the current reference too.
            const latest = await checkpoints.load(w, net);
            expect(latest.sequence).toBe(referenceSeq);
            expect(Buffer.from(latest.data).equals(referenceData)).toBe(true);
          }
        },
      ),
      { seed: P11_SEED, numRuns: P11_NUM_RUNS, endOnFailure: true },
    );
  }, 120_000);
});
