import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PgWatermarks } from "../../src/postgres/watermarks.js";
import { registerSuiteLifecycle, TEST_SCHEMA } from "./setup.js";

const { sql: getSql } = registerSuiteLifecycle();

function store(): PgWatermarks {
  return new PgWatermarks(getSql(), TEST_SCHEMA);
}

let keyCounter = 0;
function freshKey(): string {
  keyCounter += 1;
  return `prop-key-${keyCounter}`;
}

// A simple generator over WatermarkValue-shaped data -- avoids fast-check's own fc.jsonValue(),
// whose structural JSONType doesn't align with this project's Zod-derived JsonValue type, and
// deliberately excludes null (set() rejects a top-level null explicitly, design.md §2).
const arbitraryWatermarkValue = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.record({ v: fc.integer(), label: fc.string() }),
);

describe("Watermarks properties (Formal/STORAGE_ALGEBRA.md §5)", () => {
  it("P9 (Law W1): get after N random sets returns the last value; set·set of an equal value is indistinguishable from one", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbitraryWatermarkValue, { minLength: 1, maxLength: 8 }),
        async (values) => {
          const key = freshKey();
          const s = store();
          for (const v of values) {
            await s.set("p9", key, v);
          }
          const last = values[values.length - 1]!; // minLength: 1, so always defined
          expect(await s.get("p9", key)).toEqual(last);

          // set·set of an equal value is indistinguishable from one: repeating the final set
          // leaves get's return value, and the row count, unchanged.
          await s.set("p9", key, last);
          expect(await s.get("p9", key)).toEqual(last);
          const sql = getSql();
          const rows = await sql`SELECT 1 FROM ${sql(TEST_SCHEMA)}.watermarks WHERE kind = 'p9' AND key = ${key}`;
          expect(rows).toHaveLength(1);
        },
      ),
      { numRuns: 20 },
    );
  }, 60_000);
});
