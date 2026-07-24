import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, type UmbraDBSql } from "../../../src/postgres/client.js";
import {
  backendPid,
  pgTerminateBackend,
  registerSuiteLifecycle,
  spawnCrashWorker,
  SUITE_WATCHDOG_MS,
  SuiteWatchdogTimeoutError,
  TEST_SCHEMA,
  withSuiteWatchdog,
  type CrashWorkerHandle,
} from "../../postgres/setup.js";

/**
 * Task 0 crash-harness smoke/unit tests (`design.md` §1). Proves the fault primitives (0.1), the
 * `UMBRADB_CRASH_HOOK` worker's four named pause points (0.2), and the suite watchdog (0.3) work,
 * reusing the ONE shared session-scoped container (no second container). The hook tests use honest
 * positive controls: because the worker emits its readiness signal STRICTLY AFTER its named
 * boundary operation, and the parent observes durable state STRICTLY AFTER readiness, the observed
 * state deterministically proves which operation had/had-not happened at the pause.
 */

const { sql: getSql, connectionUri } = registerSuiteLifecycle();

/** Dedicated single-connection pools opened by a test, torn down after it. */
let openPools: UmbraDBSql[] = [];
/** Workers spawned by a test, hard-killed after it (belt-and-suspenders vs. the worker's own
 *  orphan guard). */
let liveWorkers: CrashWorkerHandle[] = [];

function pool(maxConnections = 1): UmbraDBSql {
  const p = createClient({ connectionString: connectionUri(), schema: TEST_SCHEMA, maxConnections, connectTimeout: 10 });
  openPools.push(p);
  return p;
}

function worker(...args: Parameters<typeof spawnCrashWorker>): CrashWorkerHandle {
  const h = spawnCrashWorker(...args);
  liveWorkers.push(h);
  return h;
}

afterEach(async () => {
  for (const w of liveWorkers) { try { w.sigkill(); } catch { /* already gone */ } }
  // Await each worker's TERMINATION before discarding the handle, so a killed child is reaped (not
  // left as a zombie) and its connections are released before the next test — bounded so a stuck
  // child cannot hang teardown.
  await Promise.all(liveWorkers.map((w) =>
    withSuiteWatchdog(w.waitForExit(), { label: "afterEach-worker-exit", timeoutMs: 15_000 }).catch(() => {}),
  ));
  liveWorkers = [];
  await Promise.all(openPools.map((p) => p.end({ timeout: 5 }).catch(() => {})));
  openPools = [];
});

// Parent-side verification queries — each bounded by the suite watchdog so a half-dead Postgres
// fails them typed rather than hanging the suite (Task 0.3 / BLOCK 4).
async function manifestCount(w: string, net: string): Promise<number> {
  const rows = await withSuiteWatchdog(
    getSql()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${getSql()(TEST_SCHEMA)}.ckpt_manifests WHERE w = ${w} AND net = ${net} AND complete`,
    { label: "manifestCount", timeoutMs: 10_000 },
  );
  return rows[0]!.n;
}
async function watermarkCount(kind: string, key: string): Promise<number> {
  const rows = await withSuiteWatchdog(
    getSql()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${getSql()(TEST_SCHEMA)}.watermarks WHERE kind = ${kind} AND key = ${key}`,
    { label: "watermarkCount", timeoutMs: 10_000 },
  );
  return rows[0]!.n;
}
/** Count the granted class-2 advisory locks whose `objid` is EXACTLY `hashtext(leaseKey)` (the
 *  worker reports this as `ready.lockKeyHash`). Filtering by `objid` — rather than counting ALL
 *  class-2 locks — makes the assertion robust to a shared container / parallelism (other keys'
 *  locks no longer count). `objid` is an unsigned 32-bit `oid`; `hashtext` returns a SIGNED int4,
 *  so we compare on the unsigned 32-bit representation of the hash (`& 0xFFFFFFFF`). */
async function class2AdvisoryLockCountForHash(expectedHash: number): Promise<number> {
  const rows = await withSuiteWatchdog(
    getSql()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND classid = 2 AND objsubid = 2 AND granted
        AND objid::bigint = (${expectedHash}::bigint & 4294967295)`,
    { label: "class2AdvisoryLockCount", timeoutMs: 10_000 },
  );
  return rows[0]!.n;
}

describe("crash-harness fault primitives + hook worker + watchdog (Task 0)", () => {
  // -- 0.1: spawn + SIGKILL, container survives, fresh client connects ------------------------
  it("[[crash-harness.smoke.spawn-sigkill-container-survives]] spawning and SIGKILLing the worker leaves the shared container up and a fresh client connects", async () => {
    const w = `spawnkill-${randomUUID()}`;
    const h = worker({ connectionUri: connectionUri(), schema: TEST_SCHEMA, hook: "before-commit", walletId: w, networkId: "n" });
    const ready = await h.waitForReady();
    expect(ready.pid).toBeGreaterThan(0);

    h.sigkill();
    const exit = await withSuiteWatchdog(h.waitForExit(), { label: "worker-exit", timeoutMs: 15_000 });
    expect(exit.signal).toBe("SIGKILL");

    // The container is unaffected: the shared pool still answers, and a brand-new client connects.
    const shared = await withSuiteWatchdog(getSql()<{ ok: number }[]>`SELECT 1 AS ok`, { label: "shared-ping", timeoutMs: 10_000 });
    expect(shared[0]!.ok).toBe(1);
    const fresh = pool();
    const freshRows = await withSuiteWatchdog(fresh<{ ok: number }[]>`SELECT 1 AS ok`, { label: "fresh-connect", timeoutMs: 10_000 });
    expect(freshRows[0]!.ok).toBe(1);
  });

  // -- 0.1: pg_terminate_backend drops a targeted backend, pool recovers ----------------------
  it("[[crash-harness.smoke.pg-terminate-backend-drops-and-recovers]] pg_terminate_backend drops a targeted backend and the dedicated pool recovers", async () => {
    const probe = pool(1);
    const pid = await withSuiteWatchdog(() => backendPid(probe), { label: "capture-pid", timeoutMs: 10_000 });
    expect(pid).toBeGreaterThan(0);

    // Terminate the probe's backend from a SECOND connection (the shared admin pool).
    const terminated = await withSuiteWatchdog(() => pgTerminateBackend(getSql(), pid), { label: "terminate", timeoutMs: 10_000 });
    expect(terminated).toBe(true);

    // The pool recovers: a subsequent query reconnects (a fresh backend, different pid). The first
    // query after the drop may surface the connection loss once, so allow one reconnect.
    let pid2 = -1;
    for (let attempt = 0; attempt < 3 && pid2 < 0; attempt++) {
      try { pid2 = await withSuiteWatchdog(() => backendPid(probe), { label: "recover-pid", timeoutMs: 10_000 }); }
      catch { /* reconnect on next attempt */ }
    }
    expect(pid2).toBeGreaterThan(0);
    expect(pid2).not.toBe(pid); // genuinely a new backend — the old one was dropped
  });

  // -- 0.3: suite watchdog bounds a deliberately-stalled backend with a typed error -----------
  it("[[crash-harness.smoke.suite-watchdog-bounds-stalled-backend]] the suite watchdog bounds a stalled backend with a typed error, not a hang", async () => {
    expect(SUITE_WATCHDOG_MS).toBeGreaterThan(0);
    const stall = pool(1);
    // pg_sleep(30) far exceeds the watchdog bound AND is well under G7's 120s statement_timeout,
    // so ONLY the JS-level watchdog can terminate it here — proving the backstop is independent
    // of G7's server-side timeouts.
    const started = Date.now();
    await expect(
      withSuiteWatchdog(stall<{ slept: unknown }[]>`SELECT pg_sleep(30) AS slept`, { label: "stalled-backend", timeoutMs: 1_500 }),
    ).rejects.toBeInstanceOf(SuiteWatchdogTimeoutError);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(8_000); // terminated fast — did NOT wait ~30s for pg_sleep
  });

  // -- 0.2: no hook -> ordinary uninterrupted save --------------------------------------------
  it("[[crash-harness.smoke.no-hook-ordinary-save]] without a hook the worker performs an ordinary uninterrupted save and exits 0", async () => {
    const w = `nohook-${randomUUID()}`;
    const h = worker({ connectionUri: connectionUri(), schema: TEST_SCHEMA, walletId: w, networkId: "n" });
    const ready = await h.waitForReady();
    expect(ready.hook).toBeNull();
    expect(ready.savedSequence).toBe(1);
    const exit = await withSuiteWatchdog(h.waitForExit(), { label: "no-hook-exit", timeoutMs: 15_000 });
    expect(exit.code).toBe(0);
    expect(await manifestCount(w, "n")).toBe(1); // the save is durable
  });

  // -- 0.2: before-commit pauses after the manifest INSERT, before COMMIT ----------------------
  it("[[crash-harness.smoke.hook-pauses.before-commit]] before-commit pauses after the manifest INSERT is issued but before COMMIT (nothing visible yet)", async () => {
    const w = `before-commit-${randomUUID()}`;
    const h = worker({ connectionUri: connectionUri(), schema: TEST_SCHEMA, hook: "before-commit", walletId: w, networkId: "n" });
    const ready = await h.waitForReady();
    expect(ready.hook).toBe("before-commit");
    expect(ready.backendPid).toBeGreaterThan(0); // the worker's own backend pid (T2's kill target)
    // Real boundary: the save's manifest INSERT is issued on the worker's OPEN transaction but not
    // committed, so no complete=true manifest is visible from any other connection.
    expect(await manifestCount(w, "n")).toBe(0);
  });

  // -- 0.2: in-critical-section pauses inside a held withLease --------------------------------
  it("[[crash-harness.smoke.hook-pauses.in-critical-section]] in-critical-section pauses inside a held withLease (the advisory lock is held)", async () => {
    const leaseKey = `lease-${randomUUID()}`;
    const h = worker({ connectionUri: connectionUri(), schema: TEST_SCHEMA, hook: "in-critical-section", leaseKey });
    const ready = await h.waitForReady();
    expect(ready.hook).toBe("in-critical-section");
    expect(ready.lockKey).toBe(leaseKey);
    // The reported hash matches the parent's own hashtext of the key — the readiness payload is tied
    // to the real lock, not fabricated.
    const parentHash = (await withSuiteWatchdog(
      getSql()<{ h: number }[]>`SELECT hashtext(${leaseKey})::int AS h`,
      { label: "parent-hashtext", timeoutMs: 10_000 },
    ))[0]!.h;
    expect(ready.lockKeyHash).toBe(parentHash);
    // Real boundary: the class-2 advisory lock for THIS key (objid = hashtext(leaseKey)) is genuinely
    // held while paused inside the critical section. The unique random key ⇒ exactly one such lock.
    expect(await class2AdvisoryLockCountForHash(ready.lockKeyHash!)).toBe(1);
  });

  // -- 0.2: after-data-commit-before-cursor — SIGKILL BETWEEN the two real ops (safe ordering) --
  it("[[crash-harness.smoke.hook-pauses.after-data-commit-before-cursor]] after-data-commit-before-cursor: killed BETWEEN the two real ops leaves data durable and the cursor absent", async () => {
    const w = `adc-${randomUUID()}`;
    const cursorKey = `k-${randomUUID()}`;
    const h = worker({ connectionUri: connectionUri(), schema: TEST_SCHEMA, hook: "after-data-commit-before-cursor", walletId: w, networkId: "n", cursorKind: "sync", cursorKey, cursorValue: 5 });
    const ready = await h.waitForReady();
    expect(ready.hook).toBe("after-data-commit-before-cursor");
    expect(ready.savedSequence).toBe(1);
    // Boundary at the pause: Op1 (data commit) has returned (durable); Op2 (cursor advance) is the
    // real code past the pause and has NOT been issued yet.
    expect(await manifestCount(w, "n")).toBe(1);              // Op1 data durable
    expect(await watermarkCount("sync", cursorKey)).toBe(0);  // Op2 cursor not yet advanced

    // SIGKILL the worker WHILE it is paused between the two ops — the crash freezes the state here.
    h.sigkill();
    const exit = await withSuiteWatchdog(h.waitForExit(), { label: "adc-exit", timeoutMs: 15_000 });
    expect(exit.signal).toBe("SIGKILL");
    // Killed run: data COMMITTED (Op1), cursor NEVER ISSUED (Op2 killed before it ran). The cursor's
    // absence is CAUSED by the crash-between-the-two-ops — see the negative control below.
    expect(await manifestCount(w, "n")).toBe(1);              // data present
    expect(await watermarkCount("sync", cursorKey)).toBe(0);  // cursor absent (watermark behind data)
  });

  // -- 0.2: after-cursor-before-data — SIGKILL BETWEEN the two real ops (unsafe ref ordering) ---
  it("[[crash-harness.smoke.hook-pauses.after-cursor-before-data]] after-cursor-before-data: killed BETWEEN the two real ops leaves the cursor durable and the data absent (T5 negative case)", async () => {
    const w = `acd-${randomUUID()}`;
    const cursorKey = `k-${randomUUID()}`;
    const h = worker({ connectionUri: connectionUri(), schema: TEST_SCHEMA, hook: "after-cursor-before-data", walletId: w, networkId: "n", cursorKind: "sync", cursorKey, cursorValue: 9 });
    const ready = await h.waitForReady();
    expect(ready.hook).toBe("after-cursor-before-data");
    // Boundary at the pause: Op1 (cursor advance) committed; Op2 (data save) is the real code past
    // the pause and has NOT been issued yet.
    expect(await watermarkCount("sync", cursorKey)).toBe(1);  // Op1 cursor durable (AHEAD of data)
    expect(await manifestCount(w, "n")).toBe(0);              // Op2 data not yet saved

    h.sigkill();
    const exit = await withSuiteWatchdog(h.waitForExit(), { label: "acd-exit", timeoutMs: 15_000 });
    expect(exit.signal).toBe("SIGKILL");
    // Killed run: cursor COMMITTED (Op1), data NEVER ISSUED (Op2 killed before it ran). The data's
    // absence is CAUSED by the crash — the negative control proves the data op lands when uninterrupted.
    expect(await watermarkCount("sync", cursorKey)).toBe(1);  // cursor present
    expect(await manifestCount(w, "n")).toBe(0);              // data absent
  });

  // -- 0.2: T5 NEGATIVE CONTROL — the SAME data->cursor flow, run to COMPLETION without a kill ---
  it("[[crash-harness.smoke.t5-full-flow-negative-control]] the co-transactional data->cursor flow run to completion (no kill) lands BOTH data and cursor — proving the killed runs' absences are caused by the crash", async () => {
    const w = `t5full-${randomUUID()}`;
    const cursorKey = `k-${randomUUID()}`;
    // Dedicated no-pause, no-kill `t5-full-flow` mode: save (Op1) then watermark.set (Op2), both
    // committed, then a clean exit 0. This is the SAME co-transactional flow the killed
    // after-data-commit run performs — but uninterrupted.
    const h = worker({ connectionUri: connectionUri(), schema: TEST_SCHEMA, mode: "t5-full-flow", walletId: w, networkId: "n", cursorKind: "sync", cursorKey, cursorValue: 5 });
    const ready = await h.waitForReady();
    expect(ready.hook).toBeNull();
    expect(ready.mode).toBe("t5-full-flow");
    const exit = await withSuiteWatchdog(h.waitForExit(), { label: "t5-full-flow-exit", timeoutMs: 15_000 });
    expect(exit.code).toBe(0);
    // BOTH present when the flow completes — so in the killed run the cursor's absence is caused by
    // the crash-between-data-and-cursor, NOT by the cursor op never existing.
    expect(await manifestCount(w, "n")).toBe(1);              // data present
    expect(await watermarkCount("sync", cursorKey)).toBe(1);  // cursor ALSO present
  });

  // -- 0.3: the suite watchdog applies SUITE_WATCHDOG_MS as its DEFAULT bound (fast, fake timers) -
  it("[[crash-harness.smoke.suite-watchdog-default-bound]] withSuiteWatchdog with NO override applies SUITE_WATCHDOG_MS as the default bound", async () => {
    // Fake timers so the DEFAULT 60s bound is exercised WITHOUT a real 60s wait — proving the
    // default is wired (the 1.5s-override test above proves the JS backstop fires before G7's 120s;
    // this proves the bound applied when nobody passes an override is exactly SUITE_WATCHDOG_MS).
    vi.useFakeTimers();
    try {
      const never = new Promise<never>(() => {}); // never settles on its own
      let outcome: unknown = "pending";
      const raced = withSuiteWatchdog(never, { label: "default-bound" }).then(
        () => { outcome = "resolved"; },
        (e: unknown) => { outcome = e; },
      );
      // One tick short of the default bound: still pending (the default is not SHORTER than SUITE_WATCHDOG_MS).
      await vi.advanceTimersByTimeAsync(SUITE_WATCHDOG_MS - 1);
      expect(outcome).toBe("pending");
      // Exactly at the default bound: the typed timeout fires, carrying SUITE_WATCHDOG_MS.
      await vi.advanceTimersByTimeAsync(1);
      await raced;
      expect(outcome).toBeInstanceOf(SuiteWatchdogTimeoutError);
      expect((outcome as SuiteWatchdogTimeoutError).timeoutMs).toBe(SUITE_WATCHDOG_MS);
    } finally {
      vi.useRealTimers();
    }
  });
});
