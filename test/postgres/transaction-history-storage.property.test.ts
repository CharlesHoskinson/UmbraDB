import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/interfaces/storage-errors.js";
import { hasPostgresUnsafeText } from "../../src/interfaces/temporal-kv.js";
import {
  THS_RESERVED_KEY_PREFIX,
  type EntryContent, type TransactionHistoryEntry,
} from "../../src/interfaces/transaction-history-storage.js";
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
  sectionValue: EntryContent;
}

/**
 * F3 (the property-test oracle gap that let the F1 reserved-tag-collision BLOCK finding slip
 * through review): `sectionValue` previously only ever produced `fc.integer`, so the Pg-vs-in-
 * memory oracle never actually exercised `PgTransactionHistoryStorage`'s bigint/Date JSONB
 * encode/decode surface (`encodeContent`/`decodeContent`) at all, let alone the reserved-tag
 * collision case. Broadened to also generate `bigint`, `Date`, shallow nested objects, and --
 * importantly -- objects shaped like the reserved tag sentinel or containing a PostgreSQL-unsafe
 * key, so this oracle now actually proves both backends accept/reject each generated value
 * IDENTICALLY (see `replay`/`applyCommand` below), not just that "well-formed" commands agree.
 */
const GOOD_LEAF_KEYS = ["note", "amount", "detail"] as const;

const goodLeaf: fc.Arbitrary<EntryContent> = fc.oneof(
  fc.integer({ min: -1000, max: 1000 }),
  fc.string({ maxLength: 12 }).filter((s) => !hasPostgresUnsafeText(s)),
  fc.boolean(),
  fc.constant(null),
  fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }),
  fc.date({ min: new Date("2000-01-01T00:00:00.000Z"), max: new Date("2035-01-01T00:00:00.000Z"), noInvalidDate: true }),
);

const goodNestedObject: fc.Arbitrary<EntryContent> = fc.dictionary(
  fc.constantFrom(...GOOD_LEAF_KEYS), goodLeaf, { maxKeys: 3 },
);

/** Deliberately boundary-INVALID section values: a key shaped like this storage layer's own
 *  reserved bigint/Date tag sentinel (`THS_RESERVED_KEY_PREFIX`), and PostgreSQL-unsafe keys (a
 *  NUL byte, a lone UTF-16 surrogate) -- both MUST be rejected identically by
 *  `PgTransactionHistoryStorage` and `InMemoryTransactionHistoryStorage`, since both validate
 *  against the exact same shared `TransactionHistoryEntrySchema` (F1 / the related Codex MEDIUM
 *  finding on PG-unsafe keys). Built with `String.fromCharCode` rather than a literal escape so
 *  the NUL/surrogate character is unambiguously a real code unit, not a stray escape sequence. */
const badKeyValue: fc.Arbitrary<EntryContent> = fc.oneof(
  fc.constant({ [`${THS_RESERVED_KEY_PREFIX}bigint`]: "not-a-real-tag" }),
  fc.constant({ [`${THS_RESERVED_KEY_PREFIX}date`]: "not-a-real-tag" }),
  fc.constant({ [`bad${String.fromCharCode(0)}key`]: 1 }),
  fc.constant({ [`bad${String.fromCharCode(0xD800)}key`]: 1 }),
);

const sectionValue: fc.Arbitrary<EntryContent> = fc.oneof(
  { weight: 5, arbitrary: goodLeaf },
  { weight: 2, arbitrary: goodNestedObject },
  { weight: 1, arbitrary: badKeyValue },
);

const arbitraryCommand: fc.Arbitrary<Command> = fc.record({
  kind: fc.constantFrom(...LIFECYCLE_KINDS),
  hash: fc.constantFrom(...HASH_POOL),
  identifiers: fc.uniqueArray(fc.constantFrom(...IDENTIFIER_POOL), { minLength: 0, maxLength: 3 }),
  sectionKey: fc.constantFrom(...SECTION_KEY_POOL),
  sectionValue,
});

interface ReplayableStorage {
  gotPending: (entry: Omit<TransactionHistoryEntry, "lifecycle">) => Promise<void>;
  gotFinalized: (entry: Omit<TransactionHistoryEntry, "lifecycle">) => Promise<void>;
  gotRejected: (entry: Omit<TransactionHistoryEntry, "lifecycle">) => Promise<void>;
}

/** Applies one command to `storage`, reporting whether it was accepted or rejected at the
 *  boundary -- a boundary `ValidationError` is an expected, comparable outcome (both backends
 *  must produce it identically for the same generated command, per F3's broadened generator);
 *  any other error is a genuine test failure and rethrown. */
async function applyCommand(storage: ReplayableStorage, cmd: Command): Promise<"applied" | "rejected"> {
  const entry = {
    hash: cmd.hash,
    identifiers: cmd.identifiers,
    sections: { [cmd.sectionKey]: cmd.sectionValue },
  };
  try {
    if (cmd.kind === "pending") await storage.gotPending(entry);
    else if (cmd.kind === "finalized") await storage.gotFinalized(entry);
    else await storage.gotRejected(entry);
    return "applied";
  } catch (err) {
    if (err instanceof ValidationError) return "rejected";
    throw err;
  }
}

/** Replays `commands` onto BOTH backends in lockstep (rather than each backend's own full pass
 *  independently), asserting each command is accepted/rejected IDENTICALLY by both -- this is
 *  what actually proves the in-memory reference and `PgTransactionHistoryStorage` agree on
 *  boundary validation (F3), not just that their post-hoc stored state matches for commands that
 *  happened to already be valid. */
async function replay(pg: ReplayableStorage, mem: ReplayableStorage, commands: readonly Command[]): Promise<void> {
  for (const cmd of commands) {
    const pgOutcome = await applyCommand(pg, cmd);
    const memOutcome = await applyCommand(mem, cmd);
    expect(memOutcome).toBe(pgOutcome);
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

          await replay(pg, mem, commands);

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
