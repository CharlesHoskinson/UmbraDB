import { afterEach, describe, expect, it } from "vitest";
import { ValidationError } from "../../src/interfaces/storage-errors.js";
import {
  LeaseFaultError,
  LeaseNotHeldError,
  LeaseTimeoutError,
  Rollback,
  TransactionFaultError,
  TransactionHandleInvalidError,
  type TransactionHandle,
} from "../../src/interfaces/transaction-lease.js";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { PgTemporalKV } from "../../src/postgres/temporal-kv.js";
import { PgTransactionLeaseLayer, resolveTransaction } from "../../src/postgres/transaction-lease.js";
import { registerSuiteLifecycle, TEST_SCHEMA } from "./setup.js";

const { sql: getSql, connectionUri } = registerSuiteLifecycle();

function txLayer(): PgTransactionLeaseLayer {
  return new PgTransactionLeaseLayer(getSql());
}

function kv(): PgTemporalKV {
  return new PgTemporalKV(getSql(), TEST_SCHEMA);
}

async function truncateAll(sql: UmbraDBSql): Promise<void> {
  await sql`TRUNCATE ${sql(TEST_SCHEMA)}.kv_current, ${sql(TEST_SCHEMA)}.kv_history`;
}

async function tick(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

const FAKE_TX = { __brand: "TransactionHandle", id: "fake-never-issued" } as unknown as TransactionHandle;

describe("PgTransactionLeaseLayer.withTransaction", () => {
  afterEach(async () => {
    await truncateAll(getSql());
  });

  it("a callback that returns a value commits and that value is returned", async () => {
    const result = await txLayer().withTransaction(async (tx) => {
      await kv().put("ns", "sc", "wt-a", { v: 1 }, { tx });
      return "committed";
    });
    expect(result).toBe("committed");
    const row = await kv().get("ns", "sc", "wt-a");
    expect(row?.value).toEqual({ v: 1 });
  });

  it("a callback that throws Rollback results in TransactionRolledBackError and no data written is visible", async () => {
    await expect(
      txLayer().withTransaction(async (tx) => {
        await kv().put("ns", "sc", "wt-b", { v: 1 }, { tx });
        throw new Rollback({ kind: "callback-requested", reason: "test" });
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_ROLLED_BACK" });
    const row = await kv().get("ns", "sc", "wt-b");
    expect(row).toBeNull();
  });

  it("a callback that throws a plain Error propagates that error unchanged and still rolls back", async () => {
    const marker = new Error("plain application error");
    await expect(
      txLayer().withTransaction(async (tx) => {
        await kv().put("ns", "sc", "wt-c", { v: 1 }, { tx });
        throw marker;
      }),
    ).rejects.toBe(marker);
    const row = await kv().get("ns", "sc", "wt-c");
    expect(row).toBeNull();
  });

  it("opts.timeoutMs rejects with TransactionFaultError(faultKind: timeout) when a statement runs too long", async () => {
    await expect(
      txLayer().withTransaction(
        async (tx) => {
          const sql = resolveTransaction(tx);
          await sql`select pg_sleep(0.3)`;
        },
        { timeoutMs: 50 },
      ),
    ).rejects.toMatchObject({ code: "TRANSACTION_FAULT", faultKind: "timeout" });
  });

  it("an already-aborted signal rejects with AbortError before fn is ever invoked", async () => {
    const controller = new AbortController();
    controller.abort();
    let fnCalled = false;
    await expect(
      txLayer().withTransaction(async () => { fnCalled = true; }, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fnCalled).toBe(false);
  });

  it("aborting after withTransaction has already started has no effect on that in-flight call", async () => {
    const controller = new AbortController();
    const result = await txLayer().withTransaction(async (tx) => {
      controller.abort(); // fires synchronously once fn is already running
      await kv().put("ns", "sc", "wt-d", { v: 1 }, { tx });
      return "still-committed";
    }, { signal: controller.signal });
    expect(result).toBe("still-committed");
    const row = await kv().get("ns", "sc", "wt-d");
    expect(row?.value).toEqual({ v: 1 });
  });

  it("resolving a handle during fn's own execution participates in that same transaction (read-your-own-write before commit)", async () => {
    await txLayer().withTransaction(async (tx) => {
      await kv().put("ns", "sc", "wt-e", { v: 1 }, { tx });
      const readBack = await kv().get("ns", "sc", "wt-e", { tx });
      expect(readBack?.value).toEqual({ v: 1 });
    });
  });

  it("a handle from an already-ended transaction throws TransactionHandleInvalidError on resolveTransaction", async () => {
    let staleHandle: TransactionHandle | undefined;
    await txLayer().withTransaction(async (tx) => { staleHandle = tx; });
    expect(() => resolveTransaction(staleHandle!)).toThrow(TransactionHandleInvalidError);
  });

  it("a fabricated handle never issued by any withTransaction call throws TransactionHandleInvalidError", () => {
    expect(() => resolveTransaction(FAKE_TX)).toThrow(TransactionHandleInvalidError);
  });

  it("invalid opts (e.g. a non-enum isolation string) rejects with ValidationError before opening a transaction", async () => {
    await expect(
      txLayer().withTransaction(async () => {}, { isolation: "bogus" as never }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("a serialization failure under repeatable read isolation surfaces as TransactionFaultError(faultKind: serialization-failure)", async () => {
    // Deterministic recipe (not a timing-dependent SSI-cycle scenario): tx2 takes its
    // repeatable-read snapshot via a SELECT, a SEPARATE, already-committed write then changes
    // the SAME row, and tx2's own subsequent UPDATE of that row is guaranteed to conflict --
    // Postgres detects the row changed after tx2's snapshot began and raises 40001.
    await kv().put("ns", "sc", "wt-ser", { v: 0 });
    let signalReady: () => void;
    const readySignal = new Promise<void>((resolve) => { signalReady = resolve; });
    // Definite-assignment assertion: the Promise executor runs synchronously (per spec), so
    // signalGo is always assigned before the top-level `signalGo()` call below -- TypeScript
    // just can't prove that across the closure boundary on its own.
    let signalGo!: () => void;
    const goSignal = new Promise<void>((resolve) => { signalGo = resolve; });

    const tx2Promise = txLayer().withTransaction(async (tx) => {
      const sql = resolveTransaction(tx);
      await sql`select value from ${sql(TEST_SCHEMA)}.kv_current where ns = 'ns' and scope = 'sc' and key = 'wt-ser'`;
      signalReady();
      await goSignal;
      await sql`update ${sql(TEST_SCHEMA)}.kv_current set value = '{"v":2}'::jsonb, version = version + 1 where ns = 'ns' and scope = 'sc' and key = 'wt-ser'`;
    }, { isolation: "repeatable read" });

    await readySignal;
    await kv().put("ns", "sc", "wt-ser", { v: 1 }); // a separate, already-committed conflicting write
    signalGo();

    await expect(tx2Promise).rejects.toMatchObject({ code: "TRANSACTION_FAULT", faultKind: "serialization-failure" });
  });

  it("a deadlock between two transactions surfaces as TransactionFaultError(faultKind: deadlock) for the loser", async () => {
    await kv().put("ns", "sc", "wt-dl-a", { v: 0 });
    await kv().put("ns", "sc", "wt-dl-b", { v: 0 });
    let signalAReady: () => void;
    const aReady = new Promise<void>((resolve) => { signalAReady = resolve; });
    let signalBReady: () => void;
    const bReady = new Promise<void>((resolve) => { signalBReady = resolve; });

    // A locks row a then waits for B to lock row b before trying to lock row b itself; B does
    // the mirror image -- a guaranteed circular wait once both signals have fired.
    const txA = txLayer().withTransaction(async (tx) => {
      const sql = resolveTransaction(tx);
      await sql`update ${sql(TEST_SCHEMA)}.kv_current set version = version where ns = 'ns' and scope = 'sc' and key = 'wt-dl-a'`;
      signalAReady();
      await bReady;
      await sql`update ${sql(TEST_SCHEMA)}.kv_current set version = version where ns = 'ns' and scope = 'sc' and key = 'wt-dl-b'`;
    });
    const txB = txLayer().withTransaction(async (tx) => {
      const sql = resolveTransaction(tx);
      await sql`update ${sql(TEST_SCHEMA)}.kv_current set version = version where ns = 'ns' and scope = 'sc' and key = 'wt-dl-b'`;
      signalBReady();
      await aReady;
      await sql`update ${sql(TEST_SCHEMA)}.kv_current set version = version where ns = 'ns' and scope = 'sc' and key = 'wt-dl-a'`;
    });

    const results = await Promise.allSettled([txA, txB]);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect(rejected.some((r) => (r.reason as { faultKind?: string })?.faultKind === "deadlock")).toBe(true);
  }, 15_000);
});

describe("PgTransactionLeaseLayer leases (acquireLease / tryAcquireLease / releaseLease / withLease)", () => {
  it("a second acquireLease for a held key (no timeoutMs) blocks until release, then resolves promptly", async () => {
    const layer = txLayer();
    const first = await layer.acquireLease("lease-a");
    let secondResolved = false;
    const second = layer.acquireLease("lease-a").then((lease) => { secondResolved = true; return lease; });
    await tick(100);
    expect(secondResolved).toBe(false);
    await layer.releaseLease(first);
    const secondLease = await second;
    expect(secondResolved).toBe(true);
    await layer.releaseLease(secondLease);
  });

  it("acquireLease with opts.timeoutMs on a contended key rejects with LeaseTimeoutError after that duration", async () => {
    const layer = txLayer();
    const held = await layer.acquireLease("lease-b");
    try {
      const start = Date.now();
      await expect(layer.acquireLease("lease-b", { timeoutMs: 100 }))
        .rejects.toMatchObject({ code: "LEASE_TIMEOUT", key: "lease-b", waitedMs: 100 });
      expect(Date.now() - start).toBeGreaterThanOrEqual(90);
    } finally {
      await layer.releaseLease(held);
    }
  });

  it("tryAcquireLease with no timeoutMs against a contended key resolves null promptly", async () => {
    const layer = txLayer();
    const held = await layer.acquireLease("lease-c");
    try {
      const start = Date.now();
      const result = await layer.tryAcquireLease("lease-c");
      expect(result).toBeNull();
      expect(Date.now() - start).toBeLessThan(200);
    } finally {
      await layer.releaseLease(held);
    }
  });

  it("tryAcquireLease with timeoutMs against a contended key resolves null (not throw) after that duration", async () => {
    const layer = txLayer();
    const held = await layer.acquireLease("lease-d");
    try {
      const result = await layer.tryAcquireLease("lease-d", { timeoutMs: 100 });
      expect(result).toBeNull();
    } finally {
      await layer.releaseLease(held);
    }
  });

  it("an already-aborted signal rejects acquireLease/tryAcquireLease with AbortError before any connection is reserved", async () => {
    const layer = txLayer();
    const controller = new AbortController();
    controller.abort();
    await expect(layer.acquireLease("lease-e", { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    await expect(layer.tryAcquireLease("lease-e", { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("a reservation failure surfaces as LeaseFaultError(reserve-failed)", async () => {
    const badSql = createClient({
      connectionString: "postgres://nouser:nopass@127.0.0.1:1/nonexistent",
      schema: TEST_SCHEMA,
      maxConnections: 1,
    });
    try {
      await expect(new PgTransactionLeaseLayer(badSql).acquireLease("lease-f"))
        .rejects.toMatchObject({ code: "LEASE_FAULT", faultKind: "reserve-failed" });
    } finally {
      await badSql.end({ timeout: 1 });
    }
  });

  it("aborting while genuinely waiting on a contended lease cancels server-side and leaks no lock", async () => {
    const layer = txLayer();
    const held = await layer.acquireLease("lease-g");
    const controller = new AbortController();
    const waiting = layer.acquireLease("lease-g", { signal: controller.signal });
    await tick(100); // let the second acquireLease actually dispatch and start waiting
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await layer.releaseLease(held);
    // A third, independent acquireLease must succeed promptly -- proving the aborted attempt
    // left no advisory lock behind (the defensive pg_advisory_unlock in design.md §3).
    const third = await layer.acquireLease("lease-g", { timeoutMs: 2_000 });
    await layer.releaseLease(third);
  }, 10_000);

  it("releaseLease against a connection that has been terminated surfaces LeaseFaultError(connection-lost), not LeaseNotHeldError", async () => {
    // Found missing by the sprint's whole-sprint review: an earlier version of releaseLease
    // unconditionally swallowed the unlock query's own failure, so a dead held connection
    // resolved successfully instead of surfacing this documented error at all.
    //
    // Simulates connection loss via a graceful dedicated.end() BEFORE releaseLease, not an
    // external pg_terminate_backend() -- an earlier version of this test used
    // pg_terminate_backend and found it triggers an uncaught internal TypeError deep in
    // postgres.js's own connection internals (a surprise server-side kill while the client still
    // believes the socket is live is evidently not a path the installed driver handles cleanly),
    // hanging the test rather than producing the clean rejection this test needs to assert on.
    // end() is the driver's own normal, well-tested shutdown path and reliably rejects a
    // subsequent query instead.
    const dedicated = createClient({ connectionString: connectionUri(), schema: TEST_SCHEMA, maxConnections: 1 });
    const layer = new PgTransactionLeaseLayer(dedicated);
    const lease = await layer.acquireLease("lease-dead");
    await dedicated.end({ timeout: 0 });
    await expect(layer.releaseLease(lease))
      .rejects.toMatchObject({ code: "LEASE_FAULT", faultKind: "connection-lost" });
  }, 10_000);

  it("releaseLease then a subsequent acquireLease by another caller succeeds immediately", async () => {
    const layer = txLayer();
    const lease = await layer.acquireLease("lease-h");
    await layer.releaseLease(lease);
    const start = Date.now();
    const second = await layer.acquireLease("lease-h");
    expect(Date.now() - start).toBeLessThan(200);
    await layer.releaseLease(second);
  });

  it("releasing an already-released lease throws LeaseNotHeldError", async () => {
    const layer = txLayer();
    const lease = await layer.acquireLease("lease-i");
    await layer.releaseLease(lease);
    await expect(layer.releaseLease(lease)).rejects.toBeInstanceOf(LeaseNotHeldError);
  });

  it("withLease releases the lease even when fn throws, and propagates fn's own error unchanged", async () => {
    const layer = txLayer();
    const marker = new Error("fn failed");
    await expect(layer.withLease("lease-j", async () => { throw marker; })).rejects.toBe(marker);
    // A subsequent acquireLease succeeding proves the lease was released despite the throw.
    const start = Date.now();
    const lease = await layer.acquireLease("lease-j");
    expect(Date.now() - start).toBeLessThan(200);
    await layer.releaseLease(lease);
  });

  it("a lease acquired WITH timeoutMs does not leave statement_timeout poisoned on the connection after release (regression test)", async () => {
    // A dedicated maxConnections: 1 pool -- not the shared suite pool -- so the SAME physical
    // connection the lease reserves is GUARANTEED to be the one the follow-up query reuses.
    // Using the shared pool here would make this test pass or fail depending on which of several
    // physical connections happened to be idle, proving nothing either way -- exactly the class
    // of self-fulfilling test this project's own history has repeatedly had to catch and fix.
    const dedicated = createClient({ connectionString: connectionUri(), schema: TEST_SCHEMA, maxConnections: 1 });
    try {
      const layer = new PgTransactionLeaseLayer(dedicated);
      const lease = await layer.acquireLease("lease-poison", { timeoutMs: 5_000 });
      await layer.releaseLease(lease);
      // SHOW statement_timeout names its result column "statement_timeout", not "timeout" --
      // select current_setting(...) AS timeout gives a reliable, aliased column name instead.
      const rows = await dedicated<{ timeout: string }[]>`select current_setting('statement_timeout') as timeout`;
      expect(rows[0]!.timeout).toBe("0"); // Postgres default: no statement_timeout
    } finally {
      await dedicated.end({ timeout: 5 });
    }
  });

  it("a normal (no timeoutMs) lease never touches statement_timeout on the connection at all", async () => {
    const dedicated = createClient({ connectionString: connectionUri(), schema: TEST_SCHEMA, maxConnections: 1 });
    try {
      const layer = new PgTransactionLeaseLayer(dedicated);
      const lease = await layer.acquireLease("lease-no-poison"); // no timeoutMs at all
      await layer.releaseLease(lease);
      // SHOW statement_timeout names its result column "statement_timeout", not "timeout" --
      // select current_setting(...) AS timeout gives a reliable, aliased column name instead.
      const rows = await dedicated<{ timeout: string }[]>`select current_setting('statement_timeout') as timeout`;
      expect(rows[0]!.timeout).toBe("0");
    } finally {
      await dedicated.end({ timeout: 5 });
    }
  });
});
