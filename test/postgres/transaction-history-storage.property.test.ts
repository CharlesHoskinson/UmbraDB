import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { TransactionHistoryEntry } from "../../src/interfaces/transaction-history-storage.js";
import { PgTransactionHistoryStorage } from "../../src/postgres/transaction-history-storage.js";
import { InMemoryTransactionHistoryStorage } from "./in-memory-transaction-history-storage.js";
import { referenceMergeEntries } from "./reference-merge.js";
import { registerSuiteLifecycle, TEST_SCHEMA } from "./setup.js";

const { sql: getSql } = registerSuiteLifecycle();

let walletCounter = 0;
function freshWalletId(): string {
  walletCounter += 1;
  return `prop-wallet-${walletCounter}`;
}

async function truncateAll(): Promise<void> {
  const sql = getSql();
  await sql`TRUNCATE ${sql(TEST_SCHEMA)}.transaction_history`;
}

/** A small, closed pool of hashes/identifiers/section keys so random command traces produce
 *  genuine merge collisions (repeated writes to the same hash, overlapping identifier sets)
 *  rather than every command landing on a fresh, never-touched row. */
const HASH_POOL = ["h1", "h2", "h3"];
const IDENTIFIER_POOL = ["a", "b", "c", "d"];
const SECTION_KEY_POOL = ["shielded", "unshielded", "dust", "fact"];
const LIFECYCLE_KINDS = ["pending", "finalized", "rejected"] as const;

interface Command {
  kind: (typeof LIFECYCLE_KINDS)[number];
  hash: string;
  identifiers: string[];
  sectionKey: string;
  sectionValue: number;
}

const arbitraryCommand: fc.Arbitrary<Command> = fc.record({
  kind: fc.constantFrom(...LIFECYCLE_KINDS),
  hash: fc.constantFrom(...HASH_POOL),
  identifiers: fc.uniqueArray(fc.constantFrom(...IDENTIFIER_POOL), { minLength: 0, maxLength: 3 }),
  sectionKey: fc.constantFrom(...SECTION_KEY_POOL),
  sectionValue: fc.integer({ min: 0, max: 1000 }),
});

async function replay(
  storage: { gotPending: PgTransactionHistoryStorage["gotPending"]; gotFinalized: PgTransactionHistoryStorage["gotFinalized"]; gotRejected: PgTransactionHistoryStorage["gotRejected"] },
  commands: readonly Command[],
): Promise<void> {
  for (const cmd of commands) {
    const entry = {
      hash: cmd.hash,
      identifiers: cmd.identifiers,
      sections: { [cmd.sectionKey]: cmd.sectionValue },
    };
    if (cmd.kind === "pending") await storage.gotPending(entry);
    else if (cmd.kind === "finalized") await storage.gotFinalized(entry);
    else await storage.gotRejected(entry);
  }
}

function normalize(entries: readonly TransactionHistoryEntry[]): unknown {
  return [...entries]
    .sort((a, b) => a.hash.localeCompare(b.hash))
    .map((e) => ({
      hash: e.hash,
      identifiers: [...e.identifiers].sort(),
      lifecycle: e.lifecycle,
      sections: e.sections,
    }));
}

describe("Transaction history storage properties (openspec/changes/sprint-7-transaction-history-storage)", () => {
  it("sequential-equivalence oracle: an identical scripted command trace produces equivalent getAll() output on PgTransactionHistoryStorage and InMemoryTransactionHistoryStorage", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbitraryCommand, { minLength: 1, maxLength: 25 }),
        async (commands) => {
          await truncateAll();
          const walletId = freshWalletId();
          const pg = new PgTransactionHistoryStorage(getSql(), walletId, referenceMergeEntries, TEST_SCHEMA);
          const mem = new InMemoryTransactionHistoryStorage(referenceMergeEntries);

          await replay(pg, commands);
          await replay(mem, commands);

          const pgAll = await pg.getAll();
          const memAll = await mem.getAll();
          expect(normalize(pgAll)).toEqual(normalize(memAll));
        },
      ),
      { numRuns: 20 },
    );
  }, 120_000);

  /**
   * Concurrency invariant (`design.md` §3, `specs/transaction-history-storage/spec.md`'s
   * "shielded-only and dust-only concurrent write" scenario): two `gotFinalized` calls racing on
   * the SAME `(walletId, hash)` — one supplying only a `shielded` section, the other only a
   * `dust` section — must not lose either section. Checked directly against Postgres state, NOT
   * against `InMemoryTransactionHistoryStorage` (whose own doc explicitly disclaims this: its
   * atomicity relies on JS being single-threaded, so it cannot exhibit -- let alone correctly
   * resolve -- this race at all). A bare `INSERT ... ON CONFLICT DO UPDATE` without the row lock
   * (`design.md` §3's documented negative control) would let the second writer's read land
   * between the first writer's read and write, silently overwriting one section — this test is
   * the positive proof `PgTransactionHistoryStorage`'s actual row-lock write path does not do
   * that.
   */
  it("concurrency invariant: two concurrent gotFinalized calls on the same hash with disjoint sections both survive", async () => {
    await truncateAll();
    const walletId = freshWalletId();
    const store = new PgTransactionHistoryStorage(getSql(), walletId, referenceMergeEntries, TEST_SCHEMA);

    const RACES = 6;
    for (let i = 0; i < RACES; i++) {
      const hash = `race-${i}`;
      await Promise.all([
        store.gotFinalized({ hash, identifiers: ["a"], sections: { shielded: { note: "shielded-value" } } }),
        store.gotFinalized({ hash, identifiers: ["a"], sections: { dust: { note: "dust-value" } } }),
      ]);

      const got = await store.get(hash);
      expect(got).toBeDefined();
      expect(got!.sections.shielded).toEqual({ note: "shielded-value" });
      expect(got!.sections.dust).toEqual({ note: "dust-value" });
      expect(got!.lifecycle).toEqual({ status: "finalized" });
    }
  }, 60_000);
});
