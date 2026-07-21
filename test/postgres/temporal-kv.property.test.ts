import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { VersionConflictError } from "../../src/interfaces/temporal-kv.js";
import { PgTemporalKV } from "../../src/postgres/temporal-kv.js";
import { registerSuiteLifecycle, TEST_SCHEMA } from "./setup.js";

const { sql: getSql } = registerSuiteLifecycle();

function kv(): PgTemporalKV {
  return new PgTemporalKV(getSql(), TEST_SCHEMA);
}

let keyCounter = 0;
function freshKey(): string {
  keyCounter += 1;
  return `prop-key-${keyCounter}`;
}

describe("TemporalKV properties (Formal/STORAGE_ALGEBRA.md §5)", () => {
  it("P1 (Law T1): sequential unconditional puts produce exactly 1,2,3,...,N — no gap, no repeat", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 15 }), async (n) => {
        const key = freshKey();
        const versions: bigint[] = [];
        for (let i = 0; i < n; i++) {
          const entry = await kv().put("p1", "sc", key, { i });
          versions.push(entry.version);
          // Found by a third-round cross-vendor re-audit: without this, two of the N writes
          // can legitimately land in the same truncated millisecond and reject with
          // ClockRegressionError instead of producing the next consecutive version -- the
          // accepted caveat this project documents (Formal/STORAGE_ALGEBRA.md §1's Law T4),
          // not a violation of T1 itself. Matches P3/P4/P5's own pattern.
          await new Promise((r) => setTimeout(r, 5));
        }
        expect(versions).toEqual(Array.from({ length: n }, (_, i) => BigInt(i + 1)));
      }),
      { numRuns: 15 },
    );
  }, 60_000);

  it("P2 (Law T2): put with expectedVersion succeeds iff it matches current (or 0n against absent), else conflicts with the real actual", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5 }), // number of prior writes before the probe
        fc.integer({ min: 0, max: 8 }), // probed expectedVersion
        async (priorWrites, probed) => {
          const key = freshKey();
          for (let i = 0; i < priorWrites; i++) {
            await kv().put("p2", "sc", key, { i });
            // Same millisecond-collision guard as P1 -- prevents a prior write from
            // legitimately colliding with the probe put below (Formal/STORAGE_ALGEBRA.md §1's
            // Law T4 caveat), found by a third-round cross-vendor re-audit.
            await new Promise((r) => setTimeout(r, 5));
          }
          const currentVersion = BigInt(priorWrites); // 0 means never written
          const expectedVersion = BigInt(probed);

          if (expectedVersion === currentVersion) {
            const before = currentVersion;
            const entry = await kv().put("p2", "sc", key, { probe: true }, { expectedVersion });
            expect(entry.version).toBe(before + 1n);
          } else {
            await expect(
              kv().put("p2", "sc", key, { probe: true }, { expectedVersion }),
            ).rejects.toSatisfy((e) => {
              if (!(e instanceof VersionConflictError)) return false;
              const expectedActual = currentVersion === 0n ? undefined : currentVersion;
              return e.actual === expectedActual;
            });
            // State unchanged on conflict.
            const current = await kv().get("p2", "sc", key);
            expect(current?.version ?? 0n).toBe(currentVersion);
          }
        },
      ),
      { numRuns: 25 },
    );
  }, 120_000);

  it("P4 (Law T4): for every committed version, {version} and {at: writtenAt} addressing return the same full entry", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (n) => {
        const key = freshKey();
        const committed: { version: bigint; writtenAt: Date; value: unknown }[] = [];
        for (let i = 0; i < n; i++) {
          const entry = await kv().put("p4", "sc", key, { i });
          committed.push({ version: entry.version, writtenAt: entry.writtenAt, value: entry.value });
          // Force each write into a separate millisecond tick so consecutive recorded write
          // timestamps never collide after truncation (migrations/001_temporal_kv.ts's own
          // documented residual caveat) — a real property-test concern, not test flakiness.
          await new Promise((r) => setTimeout(r, 5));
        }
        for (const c of committed) {
          const byVersion = await kv().getAt("p4", "sc", key, { kind: "version", version: c.version });
          const byTime = await kv().getAt("p4", "sc", key, { kind: "at", at: c.writtenAt });
          expect(byVersion).not.toBeNull();
          expect(byTime).not.toBeNull();
          expect(byVersion!.value).toEqual(c.value);
          expect(byTime!.value).toEqual(c.value);
          expect(byVersion!.version).toBe(c.version);
          expect(byTime!.version).toBe(c.version);
          expect(byVersion!.writtenAt.getTime()).toBe(byTime!.writtenAt.getTime());
        }
      }),
      { numRuns: 8 },
    );
  }, 120_000);

  it("P3 (Law T3): getAt({at}) matches a from-scratch fold of the put sequence, for an arbitrary T", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 6 }), fc.integer({ min: 0, max: 5 }), async (n, cutoffIndex) => {
        const key = freshKey();
        const events: { value: { i: number }; writtenAt: Date }[] = [];
        for (let i = 0; i < n; i++) {
          const entry = await kv().put("p3", "sc", key, { i });
          events.push({ value: { i }, writtenAt: entry.writtenAt });
          await new Promise((r) => setTimeout(r, 5));
        }
        const cutoff = Math.min(cutoffIndex, n - 1);
        const asOfTime = events[cutoff]!.writtenAt;

        // Plain, from-scratch reference fold — NOT the code under test.
        const expectedValue = events
          .filter((e) => e.writtenAt.getTime() <= asOfTime.getTime())
          .reduce<{ i: number } | undefined>((_, e) => e.value, undefined);

        const result = await kv().getAt("p3", "sc", key, { kind: "at", at: asOfTime });
        expect(result?.value).toEqual(expectedValue);
      }),
      { numRuns: 8 },
    );
  }, 120_000);

  it("P5 (Law T5, adapter-private diagnostic): kv_history intervals for one key never overlap and never gap", async () => {
    const sql = getSql();
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 8 }), async (n) => {
        const key = freshKey();
        for (let i = 0; i < n; i++) {
          await kv().put("p5", "sc", key, { i });
          await new Promise((r) => setTimeout(r, 5));
        }
        const intervals = await sql<{ valid_from: Date; valid_to: Date }[]>`
          SELECT valid_from, valid_to FROM ${sql(TEST_SCHEMA)}.kv_history
          WHERE ns = 'p5' AND scope = 'sc' AND key = ${key}
          ORDER BY valid_from
        `;
        // T5(1) non-overlap: each interval's valid_to <= the next one's valid_from.
        // T5(2) gap-freedom: each interval's valid_to == the next one's valid_from exactly.
        for (let i = 0; i < intervals.length - 1; i++) {
          expect(intervals[i]!.valid_to.getTime()).toBe(intervals[i + 1]!.valid_from.getTime());
        }
      }),
      { numRuns: 8 },
    );
  }, 120_000);
});
