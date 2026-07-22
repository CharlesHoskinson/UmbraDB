import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionError, ValidationError } from "../../src/interfaces/storage-errors.js";
import {
  THS_RESERVED_KEY_PREFIX,
  type EntryContent, type MergeEntriesFn, type TransactionHistoryEntry,
} from "../../src/interfaces/transaction-history-storage.js";
import { TransactionHandleInvalidError, type TransactionHandle } from "../../src/interfaces/transaction-lease.js";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { PgTransactionHistoryStorage } from "../../src/postgres/transaction-history-storage.js";
import { PgTransactionLeaseLayer } from "../../src/postgres/transaction-lease.js";
import { referenceMergeEntries } from "./reference-merge.js";
import { registerSuiteLifecycle, TEST_SCHEMA } from "./setup.js";

const { sql: getSql } = registerSuiteLifecycle();

function store(walletId = "wallet-a", mergeFn: MergeEntriesFn = referenceMergeEntries): PgTransactionHistoryStorage {
  return new PgTransactionHistoryStorage(getSql(), walletId, mergeFn, TEST_SCHEMA);
}

function txLayer(): PgTransactionLeaseLayer {
  return new PgTransactionLeaseLayer(getSql());
}

async function truncateAll(sql: UmbraDBSql): Promise<void> {
  await sql`TRUNCATE ${sql(TEST_SCHEMA)}.transaction_history`;
}

function entry(
  hash: string, identifiers: string[], sections: Record<string, EntryContent> = {},
): Omit<TransactionHistoryEntry, "lifecycle"> {
  return { hash, identifiers, sections };
}

const FAKE_TX = { __brand: "TransactionHandle", id: "fake-never-issued" } as unknown as TransactionHandle;

// Mirrors production's own documented tagging scheme (`src/postgres/transaction-history-storage.ts`)
// so this test can verify serialize()'s round-trip claim without reaching into that module's
// private encode/decode helpers.
const BIGINT_TAG = "__umbradb_ths_bigint";
const DATE_TAG = "__umbradb_ths_date";

function decodeSerializedContent(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decodeSerializedContent);
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v as object);
    if (keys.length === 1 && keys[0] === BIGINT_TAG) return BigInt((v as Record<string, string>)[BIGINT_TAG]!);
    if (keys.length === 1 && keys[0] === DATE_TAG) return new Date((v as Record<string, string>)[DATE_TAG]!);
    return Object.fromEntries(Object.entries(v as object).map(([k, val]) => [k, decodeSerializedContent(val)]));
  }
  return v;
}

function decodeSerializedEntry(raw: Record<string, unknown>): TransactionHistoryEntry {
  return {
    hash: raw.hash as string,
    identifiers: raw.identifiers as string[],
    ...(raw.protocolVersion !== undefined ? { protocolVersion: raw.protocolVersion as number } : {}),
    ...(raw.status !== undefined ? { status: raw.status as TransactionHistoryEntry["status"] } : {}),
    ...(raw.timestamp !== undefined ? { timestamp: new Date(raw.timestamp as string) } : {}),
    ...(raw.fees !== undefined ? { fees: raw.fees === null ? null : BigInt(raw.fees as string) } : {}),
    lifecycle: raw.lifecycle as TransactionHistoryEntry["lifecycle"],
    sections: decodeSerializedContent(raw.sections) as Record<string, EntryContent>,
  };
}

describe("migrations/004_transaction_history.ts schema", () => {
  it("creates the table with exactly the specified columns/PK and the identifiers GIN index", async () => {
    const sql = getSql();
    const columns = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${TEST_SCHEMA} AND table_name = 'transaction_history'
    `;
    expect(columns.map((c) => c.column_name).sort()).toEqual(
      ["entry", "identifiers", "lifecycle", "tx_hash", "updated_at", "wallet_id"],
    );

    const pk = await sql<{ attname: string }[]>`
      SELECT a.attname
      FROM pg_constraint c
      JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.conrelid = ${TEST_SCHEMA + ".transaction_history"}::regclass AND c.contype = 'p'
      ORDER BY k.ord
    `;
    expect(pk.map((r) => r.attname)).toEqual(["wallet_id", "tx_hash"]);

    const indexes = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = ${TEST_SCHEMA} AND tablename = 'transaction_history'
    `;
    expect(indexes.map((r) => r.indexname).sort()).toEqual(
      ["transaction_history_identifiers_gin", "transaction_history_pkey"],
    );
  });
});

describe("no wallet-SDK runtime import (structural conformance, specs/transaction-history-storage/spec.md)", () => {
  it("src/postgres/transaction-history-storage.ts imports nothing resolving to a @midnightntwrk/* package", () => {
    const path = fileURLToPath(new URL("../../src/postgres/transaction-history-storage.ts", import.meta.url));
    const source = readFileSync(path, "utf8");
    const importLines = source.split("\n").filter((line) => /^\s*import\b/.test(line));
    expect(importLines.length).toBeGreaterThan(0); // sanity: the file does import something
    for (const line of importLines) {
      expect(line).not.toMatch(/@midnightntwrk/);
    }
  });
});

describe("PgTransactionHistoryStorage", () => {
  afterEach(async () => {
    await truncateAll(getSql());
  });

  describe("construction / walletId isolation", () => {
    it("a gotFinalized call on one wallet's instance is not visible via getAll/get on a different wallet's instance", async () => {
      const a = store("wallet-a");
      const b = store("wallet-b");
      await a.gotFinalized(entry("h1", ["id1"]));
      expect(await b.getAll()).toEqual([]);
      expect(await b.get("h1")).toBeUndefined();
      expect(await a.get("h1")).toBeDefined();
    });
  });

  describe("sequential lifecycle", () => {
    it("gotPending then gotFinalized merges into a single finalized entry", async () => {
      const s = store();
      await s.gotPending(entry("h1", ["a"]));
      await s.gotFinalized(entry("h1", ["b"]));
      const got = await s.get("h1");
      expect(got?.lifecycle).toEqual({ status: "finalized" });
      expect(got?.identifiers.slice().sort()).toEqual(["a", "b"]);
    });

    it("gotRejected path merges and marks the entry rejected", async () => {
      const s = store();
      await s.gotPending(entry("h2", ["x"]));
      await s.gotRejected(entry("h2", ["y"]));
      const got = await s.get("h2");
      expect(got?.lifecycle).toEqual({ status: "rejected" });
      expect(got?.identifiers.slice().sort()).toEqual(["x", "y"]);
    });

    it("duplicate delivery of an identical gotFinalized call is idempotent", async () => {
      const s = store();
      const e = entry("h3", ["a", "b"], { shielded: { note: "n1" } });
      await s.gotFinalized(e);
      await s.gotFinalized(e);
      const all = await s.getAll();
      expect(all).toHaveLength(1);
      expect(all[0]!.identifiers.slice().sort()).toEqual(["a", "b"]);
    });

    it("out-of-order delivery: gotFinalized/gotRejected for a hash never gotPending does not throw", async () => {
      const s = store();
      await expect(s.gotFinalized(entry("h4", ["z"]))).resolves.toBeUndefined();
      expect(await s.get("h4")).toBeDefined();

      await expect(s.gotRejected(entry("h5", ["z2"]))).resolves.toBeUndefined();
      expect(await s.get("h5")).toBeDefined();
    });
  });

  describe("identifier-subset pending-clear (spec: survives repeated merges)", () => {
    it("a pending entry survives while the finalized counterpart's identifiers have not grown to a superset, then clears once they do", async () => {
      const s = store();
      await s.gotPending(entry("pending1", ["a"]));

      await s.gotFinalized(entry("final1", ["x"])); // {x} -- 'a' not present yet
      expect(await s.get("pending1")).toBeDefined();

      await s.gotFinalized(entry("final1", ["b"])); // merged -> {x, b} -- still no 'a'
      expect(await s.get("pending1")).toBeDefined();

      await s.gotFinalized(entry("final1", ["a"])); // merged -> {x, b, a} -- now a superset of {a}
      expect(await s.get("pending1")).toBeUndefined();
    });

    it("a pending entry does not clear when its identifiers are not a subset of the finalized counterpart's", async () => {
      const s = store();
      await s.gotPending(entry("pending2", ["a", "d"]));
      await s.gotFinalized(entry("final2", ["a"]));
      await s.gotFinalized(entry("final2", ["b"]));
      await s.gotFinalized(entry("final2", ["c"])); // final2 identifiers now {a, b, c}
      expect(await s.get("pending2")).toBeDefined(); // {a, d} not a subset of {a, b, c}
    });

    it("gotRejected also clears superseded pending entries under the same subset rule", async () => {
      const s = store();
      await s.gotPending(entry("pending3", ["p"]));
      await s.gotRejected(entry("rej1", ["p", "q"]));
      expect(await s.get("pending3")).toBeUndefined();
    });

    // Codex low finding: direct tests for the "empty set is vacuously a subset of anything" guard
    // (`writeRows`'s own doc comment) -- an empty identifier set must never be treated as a subset
    // of (or superset containing) anything for pending-clear purposes, on EITHER side of the
    // comparison. Removing either guard in `writeRows` should fail one of these.
    it("a finalized entry with EMPTY identifiers does not clear an unrelated pending entry", async () => {
      const s = store();
      await s.gotPending(entry("pending-vac1", ["z"]));
      await s.gotFinalized(entry("final-vac1", [])); // empty identifiers -- not vacuously "a superset of everything"
      expect(await s.get("pending-vac1")).toBeDefined();
    });

    it("a pending entry with EMPTY identifiers is not cleared when an unrelated entry finalizes with non-empty identifiers", async () => {
      const s = store();
      await s.gotPending(entry("pending-vac2", [])); // empty identifiers
      await s.gotFinalized(entry("final-vac2", ["x", "y"])); // non-empty -- {} is vacuously "a subset" of this
      expect(await s.get("pending-vac2")).toBeDefined();
    });
  });

  describe("bigint/Date round-trip", () => {
    it("a bigint fees field and a Date timestamp field survive the Postgres round-trip as real bigint/Date", async () => {
      const s = store();
      const ts = new Date("2024-03-01T12:34:56.789Z");
      await s.gotFinalized({
        hash: "bh1",
        identifiers: ["a"],
        fees: 123456789012345678901234n,
        timestamp: ts,
        sections: { shielded: { amount: 42n, note: "hi" } },
      });
      const got = await s.get("bh1");
      expect(typeof got!.fees).toBe("bigint");
      expect(got!.fees).toBe(123456789012345678901234n);
      expect(got!.timestamp).toBeInstanceOf(Date);
      expect(got!.timestamp!.getTime()).toBe(ts.getTime());
      const shielded = got!.sections.shielded as Record<string, unknown>;
      expect(typeof shielded.amount).toBe("bigint");
      expect(shielded.amount).toBe(42n);
    });

    it("fees: null round-trips as null, not a coerced 0n or dropped field", async () => {
      const s = store();
      await s.gotFinalized({ hash: "bh2", identifiers: ["a"], fees: null, sections: {} });
      const got = await s.get("bh2");
      expect(got!.fees).toBeNull();
    });

    it("getAll() also returns live bigint/Date values (not just get())", async () => {
      const s = store();
      await s.gotFinalized({ hash: "bh3", identifiers: ["a"], fees: 9n, sections: {} });
      const all = await s.getAll();
      const found = all.find((e) => e.hash === "bh3")!;
      expect(typeof found.fees).toBe("bigint");
    });
  });

  describe("serialize()", () => {
    it("round-trips (via this module's documented tagging scheme) to data equivalent to getAll()", async () => {
      const s = store();
      await s.gotFinalized({
        hash: "s1", identifiers: ["a"], fees: 7n,
        timestamp: new Date("2024-01-01T00:00:00.000Z"), sections: { shielded: { v: 1n } },
      });
      await s.gotPending({ hash: "s2", identifiers: ["b"], sections: {} });

      const serialized = await s.serialize();
      expect(typeof serialized).toBe("string");
      const rawParsed = JSON.parse(serialized) as Array<Record<string, unknown>>;
      const decoded = rawParsed.map(decodeSerializedEntry).sort((x, y) => x.hash.localeCompare(y.hash));

      const all = [...await s.getAll()].sort((x, y) => x.hash.localeCompare(y.hash));
      expect(decoded).toEqual(all);
    });
  });

  describe("connection-failure translation", () => {
    it("all six methods reject with ConnectionError, not a raw driver error", async () => {
      // Built via `createClient` itself (F4: this branch ADDED `connectTimeout`, so the previous
      // comment claiming it "exposes no connect_timeout option" was stale/false) with an explicit
      // small `connectTimeout` so this test fails fast against the dead port rather than waiting
      // out this environment's much slower default connect timeout -- the same root cause behind
      // this project's known pre-existing, environment-dependent connection-timing test failures
      // elsewhere (migrate/temporal-kv/transaction-lease/watermarks), which this test deliberately
      // avoids reproducing. Mirrors `watermarks.test.ts`/`migrate.test.ts`'s own identical pattern.
      const deadSql = createClient({
        connectionString: "postgres://nouser:nopass@127.0.0.1:1/nonexistent",
        schema: TEST_SCHEMA,
        maxConnections: 1,
        connectTimeout: 2,
      });
      try {
        const s = new PgTransactionHistoryStorage(deadSql, "wallet-dead", referenceMergeEntries, TEST_SCHEMA);
        await expect(s.getAll()).rejects.toBeInstanceOf(ConnectionError);
        await expect(s.get("h")).rejects.toBeInstanceOf(ConnectionError);
        await expect(s.serialize()).rejects.toBeInstanceOf(ConnectionError);
        await expect(s.gotPending(entry("h", ["a"]))).rejects.toBeInstanceOf(ConnectionError);
        await expect(s.gotFinalized(entry("h", ["a"]))).rejects.toBeInstanceOf(ConnectionError);
        await expect(s.gotRejected(entry("h", ["a"]))).rejects.toBeInstanceOf(ConnectionError);
      } finally {
        await deadSql.end({ timeout: 1 });
      }
    }, 20_000);
  });

  describe("opts.tx participation", () => {
    it("a write inside a transaction is visible via get using the same handle before commit, and after commit without one", async () => {
      const layer = txLayer();
      const s = store();
      await layer.withTransaction(async (tx) => {
        await s.gotFinalized(entry("tx1", ["a"]), { tx });
        expect(await s.get("tx1", { tx })).toBeDefined();
      });
      expect(await s.get("tx1")).toBeDefined();
    });

    it("a write rolled back with its transaction is not visible afterward", async () => {
      const layer = txLayer();
      const s = store();
      await expect(
        layer.withTransaction(async (tx) => {
          await s.gotFinalized(entry("tx2", ["a"]), { tx });
          throw new Error("force rollback");
        }),
      ).rejects.toThrow("force rollback");
      expect(await s.get("tx2")).toBeUndefined();
    });

    it("a stale (already-ended) or fabricated transaction handle rejects with TransactionHandleInvalidError", async () => {
      const layer = txLayer();
      const s = store();
      let endedHandle!: TransactionHandle;
      await layer.withTransaction(async (tx) => {
        endedHandle = tx;
      });
      await expect(s.gotFinalized(entry("tx3", ["a"]), { tx: endedHandle })).rejects.toBeInstanceOf(TransactionHandleInvalidError);
      await expect(s.getAll({ tx: endedHandle })).rejects.toBeInstanceOf(TransactionHandleInvalidError);
      await expect(s.get("tx3", { tx: FAKE_TX })).rejects.toBeInstanceOf(TransactionHandleInvalidError);
    });
  });

  describe("cancellation (opts.signal)", () => {
    it("an already-aborted signal rejects with AbortError before any statement, for all six methods", async () => {
      const controller = new AbortController();
      controller.abort();
      const s = store();
      await expect(s.getAll({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      await expect(s.get("h", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      await expect(s.serialize({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      await expect(s.gotPending(entry("h", ["a"]), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      await expect(s.gotFinalized(entry("h", ["a"]), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      await expect(s.gotRejected(entry("h", ["a"]), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      expect(await s.getAll()).toEqual([]); // nothing was actually written
    });

    it("a signal aborting after gotFinalized has begun does not interrupt it", async () => {
      const controller = new AbortController();
      const s = store();
      const promise = s.gotFinalized(entry("abort1", ["a"]), { signal: controller.signal });
      controller.abort();
      await promise; // must resolve normally, not reject
      expect(await s.get("abort1")).toBeDefined();
    });
  });

  describe("merge semantics (equivalence to the injected merge function, not last-write-wins)", () => {
    it("a shared scalar fact set by the first writer is not overwritten by a later merge", async () => {
      const s = store();
      const t1 = new Date("2024-01-01T00:00:00.000Z");
      const t2 = new Date("2024-06-01T00:00:00.000Z");
      await s.gotPending({ hash: "ms1", identifiers: ["a"], timestamp: t1, sections: {} });
      await s.gotFinalized({ hash: "ms1", identifiers: ["a"], timestamp: t2, sections: {} });
      const got = await s.get("ms1");
      expect(got!.timestamp!.getTime()).toBe(t1.getTime());
    });

    it("identifiers accumulate via union across merges", async () => {
      const s = store();
      await s.gotPending(entry("ms2", ["a", "b"]));
      await s.gotFinalized(entry("ms2", ["b", "c"]));
      const got = await s.get("ms2");
      expect(got!.identifiers.slice().sort()).toEqual(["a", "b", "c"]);
    });

    it("lifecycle always reflects the most recent write, regardless of write order otherwise", async () => {
      const s = store();
      await s.gotPending(entry("ms3", ["a"]));
      await s.gotFinalized(entry("ms3", []));
      expect((await s.get("ms3"))!.lifecycle).toEqual({ status: "finalized" });
    });

    it("disjoint sections from two sequential writers both survive the merge", async () => {
      const s = store();
      await s.gotFinalized(entry("ms4", ["a"], { shielded: { note: "s" } }));
      await s.gotFinalized(entry("ms4", ["a"], { dust: { note: "d" } }));
      const got = await s.get("ms4");
      expect(got!.sections.shielded).toEqual({ note: "s" });
      expect(got!.sections.dust).toEqual({ note: "d" });
    });
  });

  describe("defensive: merge function result validation", () => {
    it("throws ValidationError if the injected merge function changes the entry's hash", async () => {
      const badMerge: MergeEntriesFn = (_existing, incoming) => ({ ...incoming, hash: "different-hash" });
      const s = store("wallet-bad-merge", badMerge);
      await expect(s.gotFinalized(entry("original-hash", ["a"]))).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("validation", () => {
    it("rejects an entry with an empty hash", async () => {
      const s = store();
      await expect(s.gotFinalized(entry("", ["a"]))).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects an entry whose sections contain a NUL byte", async () => {
      const s = store();
      await expect(s.gotFinalized(entry("bad1", ["a"], { note: "x\u0000y" }))).rejects.toBeInstanceOf(ValidationError);
    });
  });

  // F1 (BLOCK finding): the reserved-tag sentinel namespace must be rejected at the Zod boundary,
  // so a caller's own data can never collide with `PgTransactionHistoryStorage`'s internal
  // bigint/Date JSONB tagging scheme (`src/postgres/transaction-history-storage.ts`).
  describe("F1: reserved tag-key namespace / PostgreSQL-unsafe object keys are rejected at the boundary", () => {
    it("rejects a caller value shaped like the reserved bigint tag object", async () => {
      const s = store();
      await expect(
        s.gotFinalized(entry("bad-tag1", ["a"], { note: { [`${THS_RESERVED_KEY_PREFIX}bigint`]: "123" } })),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects a caller value shaped like the reserved date tag object", async () => {
      const s = store();
      await expect(
        s.gotFinalized(entry("bad-tag2", ["a"], { note: { [`${THS_RESERVED_KEY_PREFIX}date`]: "2024-01-01T00:00:00.000Z" } })),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects a reserved-prefixed key even as a top-level section name", async () => {
      const s = store();
      await expect(
        s.gotFinalized(entry("bad-tag3", ["a"], { [`${THS_RESERVED_KEY_PREFIX}bigint`]: "123" })),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects an object key (not just a string leaf) containing a NUL byte", () => {
      const badKey = String.fromCharCode(98, 97, 100, 0, 107, 101, 121); // "bad key"
      const s = store();
      return expect(
        s.gotFinalized(entry("bad-key1", ["a"], { note: { [badKey]: 1 } })),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects an object key containing an unpaired UTF-16 surrogate", () => {
      const badKey = `bad${String.fromCharCode(0xD800)}key`; // an unpaired (lone) high surrogate
      const s = store();
      return expect(
        s.gotFinalized(entry("bad-key2", ["a"], { note: { [badKey]: 1 } })),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("a genuine bigint/Date leaf still round-trips after the reserved-namespace fix", async () => {
      const s = store();
      const ts = new Date("2025-05-05T05:05:05.000Z");
      await s.gotFinalized({
        hash: "still-works1",
        identifiers: ["a"],
        fees: 42n,
        timestamp: ts,
        sections: { shielded: { amount: 7n, when: ts, note: "ordinary key names are unaffected" } },
      });
      const got = await s.get("still-works1");
      expect(got!.fees).toBe(42n);
      expect(got!.timestamp!.getTime()).toBe(ts.getTime());
      const shielded = got!.sections.shielded as Record<string, unknown>;
      expect(shielded.amount).toBe(7n);
      expect((shielded.when as Date).getTime()).toBe(ts.getTime());
    });
  });

  // F6 (audit panel): walletId is checked at construction, not just typed as `string`.
  describe("F6: walletId runtime guard", () => {
    it("throws ValidationError for an empty-string walletId", () => {
      expect(() => store("")).toThrow(ValidationError);
    });

    it("throws ValidationError for a non-string walletId (bypassing the type system)", () => {
      const badWalletId = null as unknown as string;
      expect(() => store(badWalletId)).toThrow(ValidationError);
    });
  });
});
