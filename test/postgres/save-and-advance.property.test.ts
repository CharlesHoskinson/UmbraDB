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
 * A9 is "driven fault-free", so rather than only asserting the end state we also exercise the
 * intermediate WATERMARK-BEHIND window the contract (§2.2) describes: in the manual form, between
 * the data commit and the cursor advance, the new checkpoint is ALREADY durable while the cursor
 * still names the PRIOR value — the safe, recoverable direction, and NEVER the reverse
 * (cursor-ahead-of-data) silent-skip failure. The combinator form has no such observable window
 * (atomic co-commit), which is itself the property that distinguishes the two.
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
          // The cursor value durable BEFORE this op's advance (undefined until the first advance) —
          // the value the intermediate watermark-behind window must still show in the manual form.
          let priorCursor: string | undefined;

          for (const op of ops) {
            const data = Buffer.from(op.data);
            const nextSeq = referenceSeq + 1;

            if (op.form === "combinator") {
              // Atomic co-commit: the cursor is advanced to the sequence this save will claim,
              // inside one transaction. One save per op ⇒ the claimed sequence is deterministic.
              // There is NO observable watermark-behind window here — both land at one commit.
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

              // Intermediate WATERMARK-BEHIND window (contract §2.2): the new checkpoint is ALREADY
              // durable, but the cursor has not yet advanced — so it still names the PRIOR value
              // (undefined before the very first advance), i.e. the cursor is BEHIND its data, the
              // safe/recoverable direction. It is provably never AHEAD: the cursor here can only be
              // the previous value or (after the set below) the new one, never a not-yet-saved seq.
              const behind = await watermarks.get<string>(KIND, key);
              expect(behind).toBe(priorCursor);
              const newlyDurable = await checkpoints.load(w, net);
              expect(newlyDurable.sequence).toBe(nextSeq);

              await watermarks.set(KIND, key, String(summary.sequence));
            }

            referenceSeq = nextSeq;
            referenceData = data;
            priorCursor = String(nextSeq);

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
