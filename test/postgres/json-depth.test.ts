import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/interfaces/storage-errors.js";
import { JsonValueSchema, MAX_JSON_DEPTH } from "../../src/interfaces/temporal-kv.js";
import { createClient } from "../../src/postgres/client.js";
import { PgTemporalKV } from "../../src/postgres/temporal-kv.js";
import { PgWatermarks } from "../../src/postgres/watermarks.js";
import { registerSuiteLifecycle, TEST_SCHEMA } from "./setup.js";

// G8 task 3.2 — JsonValueSchema depth bound (design.md §4.2). The bound is shared across
// TemporalKV.put and Watermarks.set (WatermarkValueSchema === JsonValueSchema structurally).

const { sql: getSql } = registerSuiteLifecycle();

// A value nested `depth` levels deep (leaf at depth `depth`).
function nest(depth: number): unknown {
  let v: unknown = "leaf";
  for (let i = 0; i < depth; i++) v = [v];
  return v;
}

describe("G8 JSON depth bound (design.md §4.2)", () => {
  it("the shared depth bound is 64", () => {
    expect(MAX_JSON_DEPTH).toBe(64);
  });

  it("schema: a value at the bound is accepted; one past it is rejected", () => {
    expect(JsonValueSchema.safeParse(nest(MAX_JSON_DEPTH)).success).toBe(true);
    expect(JsonValueSchema.safeParse(nest(MAX_JSON_DEPTH + 1)).success).toBe(false);
  });

  it("PgTemporalKV.put rejects an over-deep value with ValidationError", async () => {
    const kv = new PgTemporalKV(getSql(), TEST_SCHEMA);
    await expect(kv.put("ns", "sc", "over", nest(MAX_JSON_DEPTH + 1) as never)).rejects.toBeInstanceOf(ValidationError);
  }, 30_000);

  it("PgWatermarks.set rejects an over-deep value identically (shared bound applies to both)", async () => {
    const w = new PgWatermarks(getSql(), TEST_SCHEMA);
    await expect(w.set("kind", "over", nest(MAX_JSON_DEPTH + 1) as never)).rejects.toBeInstanceOf(ValidationError);
  }, 30_000);

  it("a value at or under the bound round-trips through put", async () => {
    const kv = new PgTemporalKV(getSql(), TEST_SCHEMA);
    await expect(kv.put("ns", "sc", "atbound", nest(MAX_JSON_DEPTH) as never)).resolves.toBeDefined();
  }, 30_000);

  it("a pathologically deep value is rejected cleanly with ValidationError and NO stack overflow", async () => {
    const kv = new PgTemporalKV(getSql(), TEST_SCHEMA);
    // 20_000 levels would overflow z.json()'s recursive parse if the iterative guard did not run
    // first — asserting ValidationError (not a RangeError) proves the guard short-circuits before
    // the recursion.
    await expect(kv.put("ns", "sc", "deep", nest(20_000) as never)).rejects.toBeInstanceOf(ValidationError);
  }, 30_000);

  it("no statement issued: over-deep put fails with ValidationError even against an unreachable server", async () => {
    const badSql = createClient({ connectionString: "postgres://u:p@127.0.0.1:1/db", schema: TEST_SCHEMA, connectTimeout: 1 });
    try {
      const kv = new PgTemporalKV(badSql, TEST_SCHEMA);
      await expect(kv.put("ns", "sc", "over", nest(MAX_JSON_DEPTH + 1) as never)).rejects.toBeInstanceOf(ValidationError);
      // Positive half of the control: a SHALLOW (valid) value against the same unreachable server
      // gets past validation and then fails to connect — a non-validation error — proving the
      // server is genuinely unreachable.
      await expect(kv.put("ns", "sc", "shallow", { ok: 1 } as never)).rejects.toSatisfy((e: unknown) => e instanceof Error && !(e instanceof ValidationError));
    } finally {
      await badSql.end({ timeout: 2 }).catch(() => {});
    }
  }, 15_000);
});
