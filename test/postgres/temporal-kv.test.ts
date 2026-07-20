import { afterEach, describe, expect, it } from "vitest";
import { ValidationError } from "../../src/interfaces/storage-errors.js";
import { VersionConflictError } from "../../src/interfaces/temporal-kv.js";
import type { TransactionHandle } from "../../src/interfaces/transaction-lease.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { PgTemporalKV, TransactionParticipationNotSupportedError } from "../../src/postgres/temporal-kv.js";
import { registerSuiteLifecycle, TEST_SCHEMA } from "./setup.js";

/** A fake handle for exercising the opts.tx-rejection path only — deliberately never a real
 *  transaction, since Sprint 1's adapter must reject before running any query regardless. */
const FAKE_TX = { __brand: "TransactionHandle", id: "fake" } as unknown as TransactionHandle;

const { sql: getSql } = registerSuiteLifecycle();

function kv(): PgTemporalKV {
  return new PgTemporalKV(getSql(), TEST_SCHEMA);
}

async function truncateAll(sql: UmbraDBSql): Promise<void> {
  await sql`TRUNCATE ${sql(TEST_SCHEMA)}.kv_current, ${sql(TEST_SCHEMA)}.kv_history`;
}

describe("PgTemporalKV", () => {
  afterEach(async () => {
    await truncateAll(getSql());
  });

  describe("put — CAS regression matrix (design.md §4's re-derivation table)", () => {
    it("1a. omitted expectedVersion, absent key -> insert version 1", async () => {
      const entry = await kv().put("ns", "sc", "k1", { a: 1 });
      expect(entry.version).toBe(1n);
      expect(entry.value).toEqual({ a: 1 });
    });

    it("1b. omitted expectedVersion, existing version N -> update to N+1", async () => {
      await kv().put("ns", "sc", "k2", { a: 1 });
      const entry = await kv().put("ns", "sc", "k2", { a: 2 });
      expect(entry.version).toBe(2n);
      expect(entry.value).toEqual({ a: 2 });
    });

    it("2a. expectedVersion=0n, absent key -> insert version 1", async () => {
      const entry = await kv().put("ns", "sc", "k3", { a: 1 }, { expectedVersion: 0n });
      expect(entry.version).toBe(1n);
    });

    it("2b. expectedVersion=0n, existing key -> VersionConflictError with real actual, state unchanged", async () => {
      await kv().put("ns", "sc", "k4", { a: 1 });
      await expect(kv().put("ns", "sc", "k4", { a: 2 }, { expectedVersion: 0n }))
        .rejects.toSatisfy((e) => e instanceof VersionConflictError && e.actual === 1n);
      const current = await kv().get("ns", "sc", "k4");
      expect(current?.version).toBe(1n);
      expect(current?.value).toEqual({ a: 1 });
    });

    it("3a. expectedVersion=N matching -> update to N+1", async () => {
      await kv().put("ns", "sc", "k5", { a: 1 });
      const entry = await kv().put("ns", "sc", "k5", { a: 2 }, { expectedVersion: 1n });
      expect(entry.version).toBe(2n);
    });

    it("3b. expectedVersion=N mismatched -> VersionConflictError with real actual, state unchanged", async () => {
      await kv().put("ns", "sc", "k6", { a: 1 });
      await expect(kv().put("ns", "sc", "k6", { a: 2 }, { expectedVersion: 5n }))
        .rejects.toSatisfy((e) => e instanceof VersionConflictError && e.actual === 1n);
      const current = await kv().get("ns", "sc", "k6");
      expect(current?.version).toBe(1n);
    });

    it("3c. expectedVersion=N against never-written key -> VersionConflictError with actual=undefined", async () => {
      await expect(kv().put("ns", "sc", "k7-never", { a: 1 }, { expectedVersion: 3n }))
        .rejects.toSatisfy((e) => e instanceof VersionConflictError && e.actual === undefined);
      const current = await kv().get("ns", "sc", "k7-never");
      expect(current).toBeNull();
    });

    it("4. invalid (negative) expectedVersion rejects with ValidationError before touching SQL", async () => {
      await expect(kv().put("ns", "sc", "k8", { a: 1 }, { expectedVersion: -1n as unknown as bigint }))
        .rejects.toBeInstanceOf(ValidationError);
      const current = await kv().get("ns", "sc", "k8");
      expect(current).toBeNull();
    });
  });

  describe("getAt", () => {
    it("{version} addressing returns the value at that version, including old ones from kv_history", async () => {
      const v1 = await kv().put("ns", "sc", "kg1", { a: 1 });
      await kv().put("ns", "sc", "kg1", { a: 2 });
      const at1 = await kv().getAt("ns", "sc", "kg1", { kind: "version", version: v1.version });
      expect(at1?.value).toEqual({ a: 1 });
      expect(at1?.version).toBe(1n);
    });

    it("{at} addressing agrees with {version} addressing at that version's commit instant (Law T4)", async () => {
      const v1 = await kv().put("ns", "sc", "kg2", { a: 1 });
      await kv().put("ns", "sc", "kg2", { a: 2 });
      const atTime = await kv().getAt("ns", "sc", "kg2", { kind: "at", at: v1.writtenAt });
      expect(atTime?.value).toEqual({ a: 1 });
      expect(atTime?.version).toBe(1n);
    });

    it("returns null for a point in time before the key ever existed", async () => {
      const before = new Date(Date.now() - 60_000);
      await kv().put("ns", "sc", "kg3", { a: 1 });
      const result = await kv().getAt("ns", "sc", "kg3", { kind: "at", at: before });
      expect(result).toBeNull();
    });
  });

  describe("listKeys", () => {
    it("yields only the newest version of each key under a prefix, in order", async () => {
      await kv().put("ns", "sc", "list:a", { v: 1 });
      await kv().put("ns", "sc", "list:a", { v: 2 });
      await kv().put("ns", "sc", "list:b", { v: 1 });
      await kv().put("ns", "sc", "other:c", { v: 1 });

      const keys: string[] = [];
      for await (const k of kv().listKeys("ns", "sc", "list:")) keys.push(k);
      expect(keys).toEqual(["list:a", "list:b"]);
    });

    it("hostile prefix containing LIKE metacharacters matches only the literal prefix", async () => {
      await kv().put("ns", "sc", "100%off", { v: 1 });
      await kv().put("ns", "sc", "100Xoff", { v: 1 }); // would match if % were treated as a wildcard

      const keys: string[] = [];
      for await (const k of kv().listKeys("ns", "sc", "100%")) keys.push(k);
      expect(keys).toEqual(["100%off"]);
    });
  });

  describe("opts.tx rejection (deferred wiring, tasks.md 1.6)", () => {
    it("put rejects a non-undefined opts.tx before running any query", async () => {
      await expect(kv().put("ns", "sc", "tx-key", { a: 1 }, { tx: FAKE_TX }))
        .rejects.toBeInstanceOf(TransactionParticipationNotSupportedError);
      const row = await kv().get("ns", "sc", "tx-key");
      expect(row).toBeNull();
    });
  });

  describe("Transaction key reuse (UB001 -> TransactionKeyReuseError), exercised at the trigger level per spec.md's scope note", () => {
    it("a second UPDATE to the same kv_current row within one transaction is rejected", async () => {
      const sql = getSql();
      await kv().put("ns", "sc", "reuse-key", { a: 1 });
      await expect(
        sql.begin(async (tx) => {
          await tx`UPDATE ${tx(TEST_SCHEMA)}.kv_current SET value = ${tx.json({ a: 2 })}, version = version + 1
                    WHERE ns = 'ns' AND scope = 'sc' AND key = 'reuse-key'`;
          await tx`UPDATE ${tx(TEST_SCHEMA)}.kv_current SET value = ${tx.json({ a: 3 })}, version = version + 1
                    WHERE ns = 'ns' AND scope = 'sc' AND key = 'reuse-key'`;
        }),
      ).rejects.toMatchObject({ code: "UB001" });

      const current = await kv().get("ns", "sc", "reuse-key");
      expect(current?.version).toBe(1n);
      expect(current?.value).toEqual({ a: 1 });
    });

    it("sequential puts to the same key in separate transactions are unaffected", async () => {
      await kv().put("ns", "sc", "reuse-key-2", { a: 1 });
      const second = await kv().put("ns", "sc", "reuse-key-2", { a: 2 });
      expect(second.version).toBe(2n);
      const v1 = await kv().getAt("ns", "sc", "reuse-key-2", { kind: "version", version: 1n });
      expect(v1?.value).toEqual({ a: 1 });
    });
  });
});
