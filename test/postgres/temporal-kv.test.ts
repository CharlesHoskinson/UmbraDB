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

/**
 * Forces a millisecond-boundary crossing between two sequential writes to the same key.
 * **Added by a fourth-round cross-vendor re-audit**: any two writes to one key whose
 * `clock_timestamp()`-truncated instants land in the same millisecond collide and reject with
 * `ClockRegressionError` (the accepted, documented caveat — `Formal/STORAGE_ALGEBRA.md` §1's
 * Law T4), which is a real, if low-probability, source of flakiness for any test doing
 * back-to-back same-key writes with no delay between them. Call this between such writes,
 * matching the property tests' own established P3/P4/P5 pattern.
 */
async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
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
      await tick();
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
      await tick();
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
      await tick();
      await kv().put("ns", "sc", "kg1", { a: 2 });
      const at1 = await kv().getAt("ns", "sc", "kg1", { kind: "version", version: v1.version });
      expect(at1?.value).toEqual({ a: 1 });
      expect(at1?.version).toBe(1n);
    });

    it("{at} addressing agrees with {version} addressing at that version's commit instant (Law T4)", async () => {
      const v1 = await kv().put("ns", "sc", "kg2", { a: 1 });
      await tick();
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
      await tick();
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

  describe("schema threading (Codex audit finding: PgTemporalKV must not default independently of createClient)", () => {
    it("constructing without an explicit schema argument uses the client's own configured schema, not a hardcoded literal", async () => {
      const sql = getSql();
      // Deliberately omit the second constructor argument entirely -- the bug was that this
      // silently defaulted to "umbradb" instead of reading sql.umbradbSchema (TEST_SCHEMA here).
      const kvNoExplicitSchema = new PgTemporalKV(sql);
      const entry = await kvNoExplicitSchema.put("ns", "sc", "schema-thread-key", { a: 1 });
      expect(entry.version).toBe(1n);
      // Confirm it actually landed in TEST_SCHEMA, not some other/default schema.
      const viaExplicitSchema = await kv().get("ns", "sc", "schema-thread-key");
      expect(viaExplicitSchema?.value).toEqual({ a: 1 });
    });
  });

  describe("AbortSignal (Codex audit: pre-check only, no false rejection while a write actually commits)", () => {
    it("put with an already-aborted signal rejects with AbortError and never touches the database", async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(kv().put("ns", "sc", "abort-key", { a: 1 }, { signal: controller.signal }))
        .rejects.toMatchObject({ name: "AbortError" });
      const row = await kv().get("ns", "sc", "abort-key");
      expect(row).toBeNull();
    });

    it("get with an already-aborted signal rejects with AbortError", async () => {
      await kv().put("ns", "sc", "abort-key-2", { a: 1 });
      const controller = new AbortController();
      controller.abort();
      await expect(kv().get("ns", "sc", "abort-key-2", { signal: controller.signal }))
        .rejects.toMatchObject({ name: "AbortError" });
    });

    it("getAt with an already-aborted signal rejects with AbortError", async () => {
      await kv().put("ns", "sc", "abort-key-3", { a: 1 });
      const controller = new AbortController();
      controller.abort();
      await expect(kv().getAt("ns", "sc", "abort-key-3", { kind: "version", version: 1n }, { signal: controller.signal }))
        .rejects.toMatchObject({ name: "AbortError" });
    });

    it("a signal aborted AFTER a put has already been dispatched does not cause a false AbortError rejection", async () => {
      const controller = new AbortController();
      const promise = kv().put("ns", "sc", "abort-key-4", { a: 1 }, { signal: controller.signal });
      controller.abort(); // fires after putImpl has already started, synchronously in the same tick
      const entry = await promise; // must resolve normally, not reject -- the write is already in flight
      expect(entry.version).toBe(1n);
      const row = await kv().get("ns", "sc", "abort-key-4");
      expect(row?.value).toEqual({ a: 1 });
    });

    it("abort(reason) with an arbitrary Error still surfaces as a real AbortError, not the arbitrary reason", async () => {
      const controller = new AbortController();
      controller.abort(new Error("some unrelated failure"));
      await expect(kv().get("ns", "sc", "abort-key-5", { signal: controller.signal }))
        .rejects.toMatchObject({ name: "AbortError" });
    });

    it("listKeys with an already-aborted signal rejects with AbortError before yielding anything", async () => {
      await kv().put("ns", "sc", "abort-list:a", { v: 1 });
      const controller = new AbortController();
      controller.abort();
      const iterate = async () => {
        const keys: string[] = [];
        for await (const k of kv().listKeys("ns", "sc", "abort-list:", { signal: controller.signal })) keys.push(k);
        return keys;
      };
      await expect(iterate()).rejects.toMatchObject({ name: "AbortError" });
    });

    it("aborting listKeys mid-iteration rejects with AbortError and releases the cursor (no pool leak)", async () => {
      for (let i = 0; i < 10; i++) {
        await kv().put("ns", "sc", `abort-mid:${String(i).padStart(2, "0")}`, { v: i });
      }
      const controller = new AbortController();
      const seen: string[] = [];
      const iterate = async () => {
        for await (const k of kv().listKeys("ns", "sc", "abort-mid:", { signal: controller.signal })) {
          seen.push(k);
          if (seen.length === 2) controller.abort();
        }
      };
      await expect(iterate()).rejects.toMatchObject({ name: "AbortError" });
      expect(seen.length).toBeGreaterThanOrEqual(2);
      // Prove the connection/cursor wasn't left in a broken state: a fresh query still works.
      const after = await kv().get("ns", "sc", "abort-mid:00");
      expect(after?.value).toEqual({ v: 0 });
    });

    it("aborting listKeys while the initial SELECT is genuinely blocked cancels the query SERVER-SIDE, not just the client-side wait (Codex re-audit finding)", async () => {
      // The mid-iteration test above aborts AFTER rows have already arrived, which never
      // exercises the code path where NO batch has ever arrived yet -- iterator.return() alone
      // is a no-op in that case (verified against the installed postgres.js source: its `prev`
      // resolver is only set inside the callback fired when a batch arrives). Force a genuine
      // block on the underlying SELECT itself using an ACCESS EXCLUSIVE table lock from a
      // separate connection, so this actually reaches that path.
      //
      // Revised after a fourth-round cross-vendor re-audit found the original version of this
      // test proved only client-side rejection, not that query.cancel() actually reached the
      // server: it released the lock immediately after observing AbortError, so the same
      // assertions would have passed even with query.cancel() removed entirely (the blocked
      // SELECT would just complete naturally once unlocked, on a spare pool connection). Fixed
      // by checking pg_stat_activity for the blocked backend WHILE THE LOCK IS STILL HELD --
      // proving the backend actually stopped waiting on the lock because it was cancelled, not
      // because the lock was released.
      const sql = getSql();
      await kv().put("ns", "sc", "blocked:a", { v: 1 });

      let releaseLock: (() => void) | undefined;
      let lockAcquired: () => void;
      const lockHeld = new Promise<void>((resolve) => { lockAcquired = resolve; });
      // Capturing (and later awaiting) this promise directly -- rather than discarding it -- is
      // itself part of the fourth-round fix: the original version never awaited sql.begin()'s
      // own promise, so a BEGIN/LOCK failure could leave an unobserved rejection and
      // nondeterministic cleanup ordering.
      const lockTxDone = sql.begin(async (tx) => {
        await tx`LOCK TABLE ${tx(TEST_SCHEMA)}.kv_current IN ACCESS EXCLUSIVE MODE`;
        lockAcquired();
        await new Promise<void>((resolveRelease) => { releaseLock = resolveRelease; });
      });
      await lockHeld;

      try {
        const controller = new AbortController();
        const iterate = async () => {
          const keys: string[] = [];
          for await (const k of kv().listKeys("ns", "sc", "blocked:", { signal: controller.signal })) keys.push(k);
          return keys;
        };
        const iteration = iterate();
        await new Promise((r) => setTimeout(r, 50)); // let the SELECT actually dispatch and block

        const before = await sql<{ n: number }[]>`
          select count(*)::int as n from pg_stat_activity
          where wait_event_type = 'Lock' and query ilike '%kv_current%'
        `;
        expect(before[0]!.n).toBeGreaterThanOrEqual(1); // confirms the SELECT really is blocked

        controller.abort();
        await expect(iteration).rejects.toMatchObject({ name: "AbortError" });

        // Still holding the lock at this point -- if the backend still shows up waiting on it,
        // query.cancel() did NOT actually reach the server.
        await new Promise((r) => setTimeout(r, 50));
        const after = await sql<{ n: number }[]>`
          select count(*)::int as n from pg_stat_activity
          where wait_event_type = 'Lock' and query ilike '%kv_current%'
        `;
        expect(after[0]!.n).toBe(0);
      } finally {
        releaseLock?.();
        await lockTxDone;
      }

      // Prove the connection wasn't left broken/leaked by the cancellation: a fresh query
      // still works.
      const finalRow = await kv().get("ns", "sc", "blocked:a");
      expect(finalRow?.value).toEqual({ v: 1 });
    }, 15_000);
  });

  describe("getAt AsOf payload validation (Codex audit: only the discriminant was checked before)", () => {
    it("negative version rejects with ValidationError before touching SQL", async () => {
      await expect(kv().getAt("ns", "sc", "asof-key", { kind: "version", version: -1n as unknown as bigint }))
        .rejects.toBeInstanceOf(ValidationError);
    });

    it("an invalid Date for {at} rejects with ValidationError before touching SQL", async () => {
      await expect(kv().getAt("ns", "sc", "asof-key", { kind: "at", at: new Date(NaN) }))
        .rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("PostgreSQL-unsafe values rejected as ValidationError, not raw driver errors (Codex audit)", () => {
    it("a value containing a NUL byte rejects with ValidationError before touching SQL", async () => {
      await expect(kv().put("ns", "sc", "unsafe-key-1", { a: "contains\u0000nul" }))
        .rejects.toBeInstanceOf(ValidationError);
      const row = await kv().get("ns", "sc", "unsafe-key-1");
      expect(row).toBeNull();
    });

    it("a value containing a lone UTF-16 surrogate rejects with ValidationError before touching SQL", async () => {
      await expect(kv().put("ns", "sc", "unsafe-key-2", { a: "lone\uD800surrogate" }))
        .rejects.toBeInstanceOf(ValidationError);
      const row = await kv().get("ns", "sc", "unsafe-key-2");
      expect(row).toBeNull();
    });

    it("a key containing a NUL byte in an object key rejects with ValidationError before touching SQL", async () => {
      const value = { ["bad\u0000key"]: 1 };
      await expect(kv().put("ns", "sc", "unsafe-key-3", value))
        .rejects.toBeInstanceOf(ValidationError);
    });

    it("listKeys with a prefix containing a NUL byte rejects with ValidationError before touching SQL (Codex re-audit finding)", async () => {
      const iterate = async () => {
        const keys = [];
        for await (const k of kv().listKeys("ns", "sc", "unsafe\u0000prefix")) keys.push(k);
        return keys;
      };
      await expect(iterate()).rejects.toBeInstanceOf(ValidationError);
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

    it("sequential puts to the same key in separate transactions succeed once a millisecond boundary is crossed", async () => {
      await kv().put("ns", "sc", "reuse-key-2", { a: 1 });
      // Found by a third-round cross-vendor re-audit: two back-to-back puts with no delay can
      // legitimately land in the same truncated millisecond and reject with
      // ClockRegressionError (the accepted caveat this project documents, not a bug) -- a real,
      // if low-probability, source of flakiness this test previously didn't guard against.
      // Force a millisecond boundary crossing, matching the property test's own P4 pattern.
      await new Promise((r) => setTimeout(r, 5));
      const second = await kv().put("ns", "sc", "reuse-key-2", { a: 2 });
      expect(second.version).toBe(2n);
      const v1 = await kv().getAt("ns", "sc", "reuse-key-2", { kind: "version", version: 1n });
      expect(v1?.value).toEqual({ a: 1 });
    });
  });
});
