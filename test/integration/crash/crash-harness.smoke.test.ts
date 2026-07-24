import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
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
  liveWorkers = [];
  await Promise.all(openPools.map((p) => p.end({ timeout: 5 }).catch(() => {})));
  openPools = [];
});

async function manifestCount(w: string, net: string): Promise<number> {
  const rows = await getSql()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ${getSql()(TEST_SCHEMA)}.ckpt_manifests WHERE w = ${w} AND net = ${net} AND complete`;
  return rows[0]!.n;
}
async function watermarkCount(kind: string, key: string): Promise<number> {
  const rows = await getSql()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ${getSql()(TEST_SCHEMA)}.watermarks WHERE kind = ${kind} AND key = ${key}`;
  return rows[0]!.n;
}
async function class2AdvisoryLockCount(): Promise<number> {
  const rows = await getSql()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND classid = 2 AND objsubid = 2 AND granted`;
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
    const before = await class2AdvisoryLockCount();
    const h = worker({ connectionUri: connectionUri(), schema: TEST_SCHEMA, hook: "in-critical-section", leaseKey });
    const ready = await h.waitForReady();
    expect(ready.hook).toBe("in-critical-section");
    expect(ready.lockKey).toBe(leaseKey);
    // The reported hash matches the parent's own hashtext of the key — the readiness payload is tied
    // to the real lock, not fabricated.
    const parentHash = (await getSql()<{ h: number }[]>`SELECT hashtext(${leaseKey})::int AS h`)[0]!.h;
    expect(ready.lockKeyHash).toBe(parentHash);
    // Real boundary: a class-2 advisory lock is genuinely held while paused inside the critical section.
    expect(await class2AdvisoryLockCount()).toBe(before + 1);
  });

  // -- 0.2: after-data-commit-before-cursor pauses with data durable, cursor not advanced -----
  it("[[crash-harness.smoke.hook-pauses.after-data-commit-before-cursor]] after-data-commit-before-cursor pauses with the checkpoint durable and the cursor NOT advanced", async () => {
    const w = `adc-${randomUUID()}`;
    const cursorKey = `k-${randomUUID()}`;
    const h = worker({ connectionUri: connectionUri(), schema: TEST_SCHEMA, hook: "after-data-commit-before-cursor", walletId: w, networkId: "n", cursorKind: "sync", cursorKey, cursorValue: 5 });
    const ready = await h.waitForReady();
    expect(ready.hook).toBe("after-data-commit-before-cursor");
    expect(ready.savedSequence).toBe(1);
    // Real boundary: the data commit has returned (durable) but the cursor advance has not been issued.
    expect(await manifestCount(w, "n")).toBe(1);        // data durable
    expect(await watermarkCount("sync", cursorKey)).toBe(0); // cursor NOT advanced (watermark behind data)
  });

  // -- 0.2: after-cursor-before-data pauses with cursor durable, data absent (unsafe ref case) -
  it("[[crash-harness.smoke.hook-pauses.after-cursor-before-data]] after-cursor-before-data pauses with the cursor durable and the checkpoint data absent (T5 negative case)", async () => {
    const w = `acd-${randomUUID()}`;
    const cursorKey = `k-${randomUUID()}`;
    const h = worker({ connectionUri: connectionUri(), schema: TEST_SCHEMA, hook: "after-cursor-before-data", walletId: w, networkId: "n", cursorKind: "sync", cursorKey, cursorValue: 9 });
    const ready = await h.waitForReady();
    expect(ready.hook).toBe("after-cursor-before-data");
    // Real boundary: the cursor advance committed (durable) but the later data commit was not issued.
    expect(await watermarkCount("sync", cursorKey)).toBe(1); // cursor durable (AHEAD of data)
    expect(await manifestCount(w, "n")).toBe(0);             // data absent
  });
});
