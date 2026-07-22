import { Schema } from "effect";
import { TransactionHistoryStorage as Sdk } from "@midnightntwrk/wallet-sdk-abstractions";
import { afterEach, describe, expect, it } from "vitest";
import { referenceMergeEntries } from "../postgres/reference-merge.js";
import { registerSuiteLifecycle, TEST_SCHEMA } from "../postgres/setup.js";
import { mapSdkStatusToUmbra, mapUmbraStatusToSdk, PgWalletSdkTransactionHistoryAdapter } from "./pg-tx-history-adapter.js";

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

  describe("no wallet-SDK runtime import under src/ (this adapter is the one exception, and lives outside src/)", () => {
    it("this adapter file itself is not under src/", () => {
      const url = new URL("./pg-tx-history-adapter.ts", import.meta.url);
      expect(url.pathname).not.toMatch(/\/src\//);
      expect(url.pathname).toMatch(/\/test\//);
    });
  });
});
