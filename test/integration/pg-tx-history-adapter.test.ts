import { Schema } from "effect";
import { TransactionHistoryStorage as Sdk } from "@midnightntwrk/wallet-sdk-abstractions";
import { afterEach, describe, expect, it } from "vitest";
import { SerializationFailedError, ValidationError } from "../../src/interfaces/storage-errors.js";
import { referenceMergeEntries } from "../postgres/reference-merge.js";
import { registerSuiteLifecycle, TEST_SCHEMA } from "../postgres/setup.js";
import {
  mapSdkStatusToUmbra, mapUmbraStatusToSdk, PgWalletSdkTransactionHistoryAdapter,
  UMBRADB_ADAPTER_LIFECYCLE_DETAIL_KEY, UMBRADB_ADAPTER_RESERVED_KEY_PREFIX,
} from "./pg-tx-history-adapter.js";

const { sql: getSql } = registerSuiteLifecycle();

interface TestSection {
  note: string;
  amount?: bigint;
}
type TestEntry = Sdk.TransactionHistoryEntryCommon & { demo?: TestSection };

function makeAdapter(walletId = "adapter-wallet-a"): PgWalletSdkTransactionHistoryAdapter<TestEntry> {
  return new PgWalletSdkTransactionHistoryAdapter<TestEntry>(getSql(), walletId, referenceMergeEntries, TEST_SCHEMA);
}

async function truncateAll(): Promise<void> {
  const sql = getSql();
  await sql`TRUNCATE ${sql(TEST_SCHEMA)}.transaction_history`;
}

/** Asserts `entry` -- already Type-shaped (live `Date`/`bigint` instances, not the wire/encoded
 *  ISO-string/decimal-string form) -- satisfies the SDK's own
 *  `TransactionHistoryEntryCommonSchema`. Deliberately `Schema.validateSync`, NOT
 *  `Schema.decodeUnknownSync`: `decodeUnknownSync` operates on the schema's ENCODED side (where
 *  `Schema.Date`'s encoded form is an ISO string, confirmed empirically -- a real `Date` instance
 *  fails it with "Expected string, actual ..."), whereas `validateSync` checks a value already in
 *  the schema's TYPE side, which is exactly what `getAll()`/`get()` return here (per the
 *  "getAll returns live bigint/Date" requirement). `Schema.is` (a non-throwing predicate) would
 *  also work; `validateSync` is used so a failure surfaces vitest's assertion message via the
 *  thrown `ParseError`. */
function assertSchemaValidSdkEntry(entry: unknown): void {
  Schema.validateSync(Sdk.TransactionHistoryEntryCommonSchema)(entry);
}

describe("PgWalletSdkTransactionHistoryAdapter (Pg-only, required gate)", () => {
  afterEach(truncateAll);

  describe("status enum mapping (L1)", () => {
    it.each(["SUCCESS", "FAILURE", "PARTIAL_SUCCESS"] as const)(
      "SDK status %s round-trips SDK -> UmbraDB -> SDK",
      (sdkStatus) => {
        expect(mapUmbraStatusToSdk(mapSdkStatusToUmbra(sdkStatus))).toBe(sdkStatus);
      },
    );

    it.each(["success", "failure", "partialSuccess"] as const)(
      "UmbraDB status %s round-trips UmbraDB -> SDK -> UmbraDB",
      (umbraStatus) => {
        expect(mapSdkStatusToUmbra(mapUmbraStatusToSdk(umbraStatus))).toBe(umbraStatus);
      },
    );

    it("a written status field round-trips through the adapter+Postgres using the mapped enum", async () => {
      const adapter = makeAdapter();
      await adapter.gotFinalized({
        hash: "status-h1",
        identifiers: ["a"],
        status: "PARTIAL_SUCCESS",
        finalizedBlock: { hash: "block-1", height: 2, timestamp: new Date("2026-01-01T00:00:00.000Z") },
      });
      const got = await adapter.get("status-h1");
      expect(got!.status).toBe("PARTIAL_SUCCESS");
    });

    // F6 (audit finding, fail-closed): an unmapped status value must THROW a typed error in
    // BOTH directions, not silently return `undefined` (which used to satisfy neither function's
    // own declared return type).
    it("F6: mapSdkStatusToUmbra throws SerializationFailedError on an unmapped SDK status value", () => {
      expect(() => mapSdkStatusToUmbra("NOT_A_REAL_STATUS" as unknown as Sdk.TransactionHistoryStatus))
        .toThrow(SerializationFailedError);
    });

    it("F6: mapUmbraStatusToSdk throws SerializationFailedError on an unmapped UmbraDB status value", () => {
      expect(() => mapUmbraStatusToSdk("notARealUmbraStatus" as unknown as "success"))
        .toThrow(SerializationFailedError);
    });

    // F6 (Codex re-audit): the fail-closed guard must use an OWN-property check, not `!== undefined`.
    // An inherited-prototype key resolves to a real Object.prototype member (a function, not
    // undefined) and would otherwise be returned instead of rejected.
    it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])(
      "F6: mapSdkStatusToUmbra rejects the inherited-prototype key %p rather than returning a prototype member",
      (protoKey) => {
        expect(() => mapSdkStatusToUmbra(protoKey as unknown as Sdk.TransactionHistoryStatus))
          .toThrow(SerializationFailedError);
      },
    );
    it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])(
      "F6: mapUmbraStatusToSdk rejects the inherited-prototype key %p rather than returning a prototype member",
      (protoKey) => {
        expect(() => mapUmbraStatusToSdk(protoKey as unknown as "success"))
          .toThrow(SerializationFailedError);
      },
    );
  });

  describe("the adapter backs txHistoryStorage with Postgres (ubiquitous requirement)", () => {
    it("a gotFinalized call through the adapter persists to Postgres and is readable via getAll", async () => {
      const adapter = makeAdapter();
      await adapter.gotFinalized({
        hash: "seam-h1",
        identifiers: ["seam-id"],
        finalizedBlock: { hash: "block-seam", height: 10, timestamp: new Date("2026-02-01T00:00:00.000Z") },
        demo: { note: "seam works" },
      });
      const all = await adapter.getAll();
      expect(all.find((e) => e.hash === "seam-h1")).toBeDefined();
    });
  });

  describe("lifecycle-detail round-trip (design.md §3.2 decision (i))", () => {
    it("a finalized entry read back through the adapter carries its finalizedBlock detail and decodes against the SDK schema", async () => {
      const adapter = makeAdapter();
      const finalizedBlock = { hash: "block-detail", height: 1_763_274, timestamp: new Date("2026-03-01T00:00:00.000Z") };
      await adapter.gotFinalized({
        hash: "lifecycle-h1",
        identifiers: ["a"],
        finalizedBlock,
        demo: { note: "finalized" },
      });
      const got = await adapter.get("lifecycle-h1");
      expect(got).toBeDefined();
      expect(got!.lifecycle).toEqual({ status: "finalized", finalizedBlock });
      assertSchemaValidSdkEntry(got);
    });

    it("a pending entry carries its submittedAt detail and decodes against the SDK schema", async () => {
      const adapter = makeAdapter();
      const submittedAt = new Date("2026-03-02T00:00:00.000Z");
      await adapter.gotPending({ hash: "lifecycle-h2", identifiers: ["a"], submittedAt });
      const got = await adapter.get("lifecycle-h2");
      expect(got!.lifecycle).toEqual({ status: "pending", submittedAt });
      assertSchemaValidSdkEntry(got);
    });

    it("a rejected entry carries its rejectedAt+reason detail and decodes against the SDK schema", async () => {
      const adapter = makeAdapter();
      const rejectedAt = new Date("2026-03-03T00:00:00.000Z");
      await adapter.gotRejected({ hash: "lifecycle-h3", identifiers: [], rejectedAt, reason: "ttl-expired" });
      const got = await adapter.get("lifecycle-h3");
      expect(got!.lifecycle).toEqual({ status: "rejected", rejectedAt, reason: "ttl-expired" });
      assertSchemaValidSdkEntry(got);
    });

    it("a rejected entry with no reason omits it, not a null/empty-string placeholder", async () => {
      const adapter = makeAdapter();
      const rejectedAt = new Date("2026-03-04T00:00:00.000Z");
      await adapter.gotRejected({ hash: "lifecycle-h4", identifiers: [], rejectedAt });
      const got = await adapter.get("lifecycle-h4");
      expect(got!.lifecycle).toEqual({ status: "rejected", rejectedAt });
      expect(got!.lifecycle).not.toHaveProperty("reason");
      assertSchemaValidSdkEntry(got);
    });

    // M1: reconstruct the SDK lifecycle detail authoritatively by CURRENT status -- no stale
    // submittedAt bleed after gotPending -> gotFinalized (or -> gotRejected) on ONE hash.
    it("M1: gotPending -> gotFinalized -> gotRejected on one hash always yields a schema-valid, CURRENT-status-only lifecycle (no stale detail bleed)", async () => {
      const adapter = makeAdapter();
      const hash = "m1-h1";

      await adapter.gotPending({ hash, identifiers: ["a"], submittedAt: new Date("2026-04-01T00:00:00.000Z") });
      let got = await adapter.get(hash);
      expect(got!.lifecycle.status).toBe("pending");
      assertSchemaValidSdkEntry(got);

      const finalizedBlock = { hash: "m1-block", height: 7, timestamp: new Date("2026-04-01T00:05:00.000Z") };
      await adapter.gotFinalized({ hash, identifiers: ["b"], finalizedBlock });
      got = await adapter.get(hash);
      expect(got!.lifecycle).toEqual({ status: "finalized", finalizedBlock });
      expect(got!.lifecycle).not.toHaveProperty("submittedAt"); // no stale bleed from the pending write
      assertSchemaValidSdkEntry(got);

      const rejectedAt = new Date("2026-04-01T00:10:00.000Z");
      await adapter.gotRejected({ hash, identifiers: [], rejectedAt, reason: "reverted" });
      got = await adapter.get(hash);
      expect(got!.lifecycle).toEqual({ status: "rejected", rejectedAt, reason: "reverted" });
      expect(got!.lifecycle).not.toHaveProperty("submittedAt");
      expect(got!.lifecycle).not.toHaveProperty("finalizedBlock");
      assertSchemaValidSdkEntry(got);

      // Also verify getAll() (not just get()) reflects the same current-status-only reconstruction.
      const all = await adapter.getAll();
      const fromGetAll = all.find((e) => e.hash === hash);
      expect(fromGetAll!.lifecycle).toEqual({ status: "rejected", rejectedAt, reason: "reverted" });
    });
  });

  describe("getAll returns live bigint/Date-typed common fields (task 3.3)", () => {
    it("fees and timestamp survive the adapter+Postgres round-trip as native bigint/Date, not strings", async () => {
      const adapter = makeAdapter();
      const timestamp = new Date("2026-05-01T00:00:00.000Z");
      await adapter.gotFinalized({
        hash: "bigint-h1",
        identifiers: ["a"],
        fees: 123456789012345678901234n,
        timestamp,
        finalizedBlock: { hash: "b", height: 1, timestamp },
        demo: { note: "amounts", amount: 42n },
      });
      const got = await adapter.get("bigint-h1");
      expect(typeof got!.fees).toBe("bigint");
      expect(got!.fees).toBe(123456789012345678901234n);
      expect(got!.timestamp).toBeInstanceOf(Date);
      expect(got!.timestamp!.getTime()).toBe(timestamp.getTime());
      expect(typeof got!.demo!.amount).toBe("bigint");

      const all = await adapter.getAll();
      const fromGetAll = all.find((e) => e.hash === "bigint-h1")!;
      expect(typeof fromGetAll.fees).toBe("bigint");
      expect(fromGetAll.timestamp).toBeInstanceOf(Date);
    });

    it("fees: null round-trips as null, not a coerced 0n or dropped field", async () => {
      const adapter = makeAdapter();
      await adapter.gotFinalized({
        hash: "bigint-h2", identifiers: ["a"], fees: null,
        finalizedBlock: { hash: "b", height: 1, timestamp: new Date() },
      });
      const got = await adapter.get("bigint-h2");
      expect(got!.fees).toBeNull();
    });
  });

  describe("scripted got* trace -> getAll() yields schema-valid SDK entries (design.md §7.1)", () => {
    it("a scripted sequence of pending/finalized/rejected entries across several hashes all decode against the SDK schema after getAll()", async () => {
      const adapter = makeAdapter("adapter-wallet-scripted");
      await adapter.gotPending({ hash: "s1", identifiers: ["a"], submittedAt: new Date("2026-06-01T00:00:00.000Z") });
      await adapter.gotFinalized({
        hash: "s2", identifiers: ["b"], protocolVersion: 3, status: "SUCCESS",
        timestamp: new Date("2026-06-02T00:00:00.000Z"), fees: 10n,
        finalizedBlock: { hash: "block-s2", height: 5, timestamp: new Date("2026-06-02T00:00:00.000Z") },
        demo: { note: "s2" },
      });
      await adapter.gotRejected({
        hash: "s3", identifiers: [], rejectedAt: new Date("2026-06-03T00:00:00.000Z"), reason: "expired",
      });

      const all = await adapter.getAll();
      expect(all.length).toBeGreaterThanOrEqual(3);
      for (const entry of all) {
        assertSchemaValidSdkEntry(entry);
      }
    });
  });

  describe("F2: reserved adapter-key namespace is enforced at write time (fail loud, never clobber)", () => {
    it("a gotFinalized call whose extension carries a section named the exact reserved lifecycle-detail key throws ValidationError, and the underlying Pg row is untouched (no clobber)", async () => {
      const adapter = makeAdapter("adapter-wallet-f2-write1");
      const finalizedBlock = { hash: "f2-block", height: 3, timestamp: new Date("2026-07-01T00:00:00.000Z") };

      await expect(adapter.gotFinalized({
        hash: "f2-h1",
        identifiers: ["a"],
        finalizedBlock,
        [UMBRADB_ADAPTER_LIFECYCLE_DETAIL_KEY]: { evil: true },
      } as unknown as Sdk.FinalizedEntryInput<TestEntry>)).rejects.toBeInstanceOf(ValidationError);

      // No clobber: the write was rejected BEFORE anything reached Postgres, so the row was
      // never written at all (not merely "written then fixed").
      expect(await adapter.get("f2-h1")).toBeUndefined();
    });

    it("a section key merely sharing the reserved prefix (not an exact match) is rejected identically", async () => {
      const adapter = makeAdapter("adapter-wallet-f2-write2");
      await expect(adapter.gotPending({
        hash: "f2-h2",
        identifiers: ["a"],
        submittedAt: new Date("2026-07-01T00:00:00.000Z"),
        [`${UMBRADB_ADAPTER_RESERVED_KEY_PREFIX}something_else`]: "oops",
      } as unknown as Sdk.PendingEntryInput<TestEntry>)).rejects.toBeInstanceOf(ValidationError);
      expect(await adapter.get("f2-h2")).toBeUndefined();
    });
  });

  describe("Codex re-audit hardening: prototype-key sections, write-side stash validation, safe status errors", () => {
    it.each(["__proto__", "constructor", "prototype"])(
      "rejects an extension section named the prototype-manipulation key %p at write (ValidationError, never a silent drop; row untouched)",
      async (protoKey) => {
        const adapter = makeAdapter(`adapter-wallet-proto-${protoKey.replace(/\W/g, "")}`);
        const finalizedBlock = { hash: "proto-block", height: 4, timestamp: new Date("2026-07-02T00:00:00.000Z") };
        await expect(adapter.gotFinalized({
          hash: "proto-h1",
          identifiers: ["a"],
          finalizedBlock,
          [protoKey]: { some: "section" },
        } as unknown as Sdk.FinalizedEntryInput<TestEntry>)).rejects.toBeInstanceOf(ValidationError);
        expect(await adapter.get("proto-h1")).toBeUndefined();
      },
    );

    it("rejects a runtime-invalid finalizedBlock (string height/timestamp) at WRITE time, not later at read (write/read symmetry)", async () => {
      const adapter = makeAdapter("adapter-wallet-writeval");
      await expect(adapter.gotFinalized({
        hash: "writeval-h1",
        identifiers: ["a"],
        // a type-erased caller passing runtime-invalid leaves the generic EntryContentSchema accepts
        finalizedBlock: { hash: "b", height: "not-a-number", timestamp: "not-a-date" },
      } as unknown as Sdk.FinalizedEntryInput<TestEntry>)).rejects.toBeInstanceOf(ValidationError);
      // Fail closed AT WRITE: nothing persisted, so a later getAll() is not bricked by this row.
      expect(await adapter.get("writeval-h1")).toBeUndefined();
    });

    it("mapSdkStatusToUmbra throws SerializationFailedError (not a raw TypeError) on a type-erased bigint status", () => {
      expect(() => mapSdkStatusToUmbra(1n as unknown as Sdk.TransactionHistoryStatus))
        .toThrow(SerializationFailedError);
    });
    it("mapUmbraStatusToSdk throws SerializationFailedError (not a raw TypeError) on a type-erased bigint status", () => {
      expect(() => mapUmbraStatusToSdk(2n as unknown as "success"))
        .toThrow(SerializationFailedError);
    });
  });

  describe("F2: a malformed stashed lifecycle detail (a raw-Pg row bypassing this adapter's own write path) throws a typed, per-hash error on read", () => {
    async function insertRawRow(entryJson: unknown, txHash: string, walletId: string, lifecycle: string): Promise<void> {
      const sql = getSql();
      const literal = JSON.stringify(entryJson).replace(/'/g, "''");
      await sql.unsafe(`
        INSERT INTO ${TEST_SCHEMA}.transaction_history (wallet_id, tx_hash, entry, identifiers, lifecycle, updated_at)
        VALUES ('${walletId}', '${txHash}', '${literal}'::jsonb, '{}', '${lifecycle}', now())
      `);
    }

    it("adapter.get(hash) throws SerializationFailedError naming the hash when the stashed lifecycle detail's shape is malformed", async () => {
      const walletId = "adapter-wallet-f2-corrupt1";
      const hash = "f2-corrupt-1";
      await insertRawRow(
        {
          hash, identifiers: ["a"], lifecycle: { status: "finalized" },
          sections: {
            [UMBRADB_ADAPTER_LIFECYCLE_DETAIL_KEY]: {
              finalized: { finalizedBlock: { hash: "b", height: "not-a-number", timestamp: "not-a-tagged-date" } },
            },
          },
        },
        hash, walletId, "finalized",
      );

      const adapter = new PgWalletSdkTransactionHistoryAdapter(getSql(), walletId, referenceMergeEntries, TEST_SCHEMA);
      await expect(adapter.get(hash)).rejects.toBeInstanceOf(SerializationFailedError);
      await expect(adapter.get(hash)).rejects.toThrow(new RegExp(hash));
    });

    it("adapter.getAll() also throws SerializationFailedError naming the offending hash -- a single bad row does not silently poison or hide which hash is bad", async () => {
      const walletId = "adapter-wallet-f2-corrupt2";
      const goodHash = "f2-good-1";
      const badHash = "f2-bad-1";

      const adapter = new PgWalletSdkTransactionHistoryAdapter(getSql(), walletId, referenceMergeEntries, TEST_SCHEMA);
      await adapter.gotPending({ hash: goodHash, identifiers: ["a"], submittedAt: new Date("2026-07-02T00:00:00.000Z") });

      await insertRawRow(
        {
          hash: badHash, identifiers: ["a"], lifecycle: { status: "pending" },
          sections: { [UMBRADB_ADAPTER_LIFECYCLE_DETAIL_KEY]: { pending: "not-an-object" } },
        },
        badHash, walletId, "pending",
      );

      await expect(adapter.getAll()).rejects.toBeInstanceOf(SerializationFailedError);
      await expect(adapter.getAll()).rejects.toThrow(new RegExp(badHash));
    });
  });

  describe("F3: gotFinalized -> getAll() reconstruction proves the real SDK schema decodes finalizedBlock.height (gate-tier, no env vars, npm test)", () => {
    it("a finalized entry written via the adapter is returned by getAll() as a schema-valid SDK entry whose finalizedBlock.height matches what was written", async () => {
      const adapter = makeAdapter("adapter-wallet-f3");
      const finalizedBlock = { hash: "f3-block", height: 1_763_274, timestamp: new Date("2026-07-21T00:00:00.000Z") };
      await adapter.gotFinalized({ hash: "f3-h1", identifiers: ["f3-id"], finalizedBlock });

      const all = await adapter.getAll();
      const found = all.find((e) => e.hash === "f3-h1");
      expect(found).toBeDefined();
      assertSchemaValidSdkEntry(found);
      expect(found!.lifecycle.status).toBe("finalized");
      const lifecycle = found!.lifecycle as { status: "finalized"; finalizedBlock: { height: number } };
      expect(lifecycle.finalizedBlock.height).toBe(finalizedBlock.height);
    });
  });

  describe("no wallet-SDK runtime import under src/ (this adapter is the one exception, and lives outside src/)", () => {
    it("this adapter file itself is not under src/", () => {
      const url = new URL("./pg-tx-history-adapter.ts", import.meta.url);
      expect(url.pathname).not.toMatch(/\/src\//);
      expect(url.pathname).toMatch(/\/test\//);
    });
  });
});
