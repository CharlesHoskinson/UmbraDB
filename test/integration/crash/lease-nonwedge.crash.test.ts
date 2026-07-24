import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../../src/postgres/client.js";
import { PgTransactionLeaseLayer } from "../../../src/postgres/transaction-lease.js";
import {
  registerSuiteLifecycle,
  spawnCrashWorker,
  TEST_SCHEMA,
  withSuiteWatchdog,
  type CrashWorkerHandle,
} from "../../postgres/setup.js";

/**
 * T3 — lease non-wedge cold start (`design.md` §2.4; `tasks.md` §4.1; `acceptance.md` E1/E2). Builds
 * on the Task 0 crash harness (`setup.ts` fault primitives + `crash-worker.ts` `in-critical-section`
 * hook + `crash-harness.smoke.test.ts` patterns). NO new worker mode is needed — the existing
 * `in-critical-section` hook already holds a REAL `txLayer.withLease` open on a known key, on a
 * `sql.reserve()`-pinned connection, and reports `lockKey`/`lockKeyHash` (`transaction-lease.ts`
 * `acquireLease` pins the class-2 advisory lock to a reserved connection; `LEASE_ADVISORY_LOCK_CLASS
 * = 2`).
 *
 * THE GUARANTEE (`02`-F4 "Good" half): a lease does NOT wedge across a clean process death. A
 * SIGKILL drops all of the holder's TCP connections; Postgres auto-releases every session-level
 * (class-2) advisory lock the killed backend held, and the layer's in-memory `heldLeases` map dies
 * with the process — so a fresh process's `withLease` on the same key must re-acquire IMMEDIATELY.
 *
 * TEST-HONESTY (the dominant risk in this change — a test that passes for the wrong reason):
 *  - CAUSATION CONTROL, run BEFORE the kill so the test is not vacuous: while the worker still holds
 *    the lease, a fresh bounded acquire on the SAME key from the parent must NOT acquire — it BLOCKS
 *    on the held lock and times out (`tryAcquireLease` resolves `null`), and `pg_locks` shows
 *    exactly one GRANTED class-2 lock for the key's hash. This proves the lock is GENUINELY HELD.
 *  - Only AFTER a CONFIRMED SIGKILL (`exit.signal === "SIGKILL"`), and from a FRESH pool, do the
 *    post-kill assertions run: (b) `pg_locks` shows the class-2 lock GONE (released by the backend's
 *    death), checked before the re-acquire so it observes the WORKER's lock gone (not our own); then
 *    (a) a fresh `withLease` on the SAME key acquires IMMEDIATELY, its wait BOUNDED by a short
 *    `timeoutMs` so a wedge FAILS FAST (`LeaseTimeoutError`) rather than hanging the suite — the
 *    bounded acquire IS the "no wedge" proof.
 *  - Held => BLOCKS (before the kill) together with killed => ACQUIRES (after the kill) proves the
 *    kill CAUSED the release, not that the lease was never held.
 *  - Every DB op is wrapped in `withSuiteWatchdog` so a half-dead backend fails the op typed rather
 *    than hanging the gate.
 *
 * EXPLICITLY OUT OF SCOPE (not built here): the T4 fence-VIOLATION test (a reserved connection dies
 * while the pool stays healthy and a second writer co-enters the critical section). That is
 * "Negotiable" per `council/B` §3 (and §5 item 2) — it gates the P1-1(b) routing fix, NOT 1.0.0.
 * T3 verifies only the clean-death non-wedge property, which IS the 1.0.0 guarantee (`design.md`
 * §2.4 "Explicitly not T4").
 */

const { sql: getSql, connectionUri } = registerSuiteLifecycle();

/** Dedicated pools opened by the test, torn down after it. */
let openPools: UmbraDBSql[] = [];
/** Workers spawned by the test, hard-killed after it (belt-and-suspenders vs. the worker's own
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
  // Await each worker's TERMINATION before discarding the handle so a killed child is reaped (not
  // left as a zombie) and its connections are released before the next test — bounded so a stuck
  // child cannot hang teardown.
  await Promise.all(liveWorkers.map((w) =>
    withSuiteWatchdog(w.waitForExit(), { label: "afterEach-worker-exit", timeoutMs: 15_000 }).catch(() => {}),
  ));
  liveWorkers = [];
  await Promise.all(openPools.map((p) => p.end({ timeout: 5 }).catch(() => {})));
  openPools = [];
});

// -- Bounds (named constants, not magic numbers). Each is deliberately far below "hangs forever" so
//    a wedge fails the gate fast, and far above the legitimate operation's real cost so a healthy
//    run never spuriously trips it. ------------------------------------------------------------------
/** The held->blocks control's bounded acquire: a `pg_advisory_lock` under this `statement_timeout`
 *  BLOCKS on the worker's held lock, then times out (`tryAcquireLease` -> `null`). */
const HELD_BLOCK_TIMEOUT_MS = 1_500;
/** Lower bound on the control's measured elapsed: proves the acquire actually BLOCKED (waited ~the
 *  full timeout) rather than failing instantly for some unrelated reason. Safely below the real
 *  ~1.5s block and safely above "instant" (<100ms). */
const HELD_BLOCK_MIN_ELAPSED_MS = 1_000;
/** Bounded poll for the killed backend's advisory lock to disappear from `pg_locks`. A real release
 *  lands well inside this; a genuine wedge (lock never released) exhausts the poll and FAILS. */
const LOCK_GONE_MAX_WAIT_MS = 10_000;
const LOCK_GONE_POLL_INTERVAL_MS = 200;
/** The post-kill re-acquire's OWN bound (`withLease` `timeoutMs`): if the lease had wedged, the
 *  `pg_advisory_lock` blocks and this `statement_timeout` fires a `LeaseTimeoutError` at ~5s — the
 *  suite FAILS FAST instead of hanging. The bounded acquire is the "no wedge" proof. */
const REACQUIRE_TIMEOUT_MS = 5_000;
/** `withSuiteWatchdog` backstops, slightly larger than the inner bounds they wrap. */
const CONTROL_WATCHDOG_MS = 15_000;
const REACQUIRE_WATCHDOG_MS = 15_000;
const HASHTEXT_WATCHDOG_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Count the GRANTED class-2 advisory locks whose `objid` is EXACTLY `hashtext(leaseKey)` (the worker
 * reports this as `ready.lockKeyHash`). Same pattern as `crash-harness.smoke.test.ts`: filtering by
 * `objid` — rather than counting ALL class-2 locks — makes the assertion robust to a shared
 * container / parallelism, and filtering by `granted` counts only HELD locks (never a concurrent
 * WAITING attempt, e.g. the held->blocks control's own blocked acquire). `objid` is an unsigned
 * 32-bit `oid`; `hashtext` returns a SIGNED int4, so we compare on the unsigned 32-bit
 * representation of the hash (`& 0xFFFFFFFF`). Read from the shared admin pool — `pg_locks` is
 * cluster-global, so it observes a lock held by ANY backend, including the crash worker's.
 */
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

/** Polls {@link class2AdvisoryLockCountForHash} until it reads 0 or `maxWaitMs` elapses, returning
 *  the last observed count. Postgres releases a session-level advisory lock when it observes the
 *  killed backend's socket close — normally within a few ms of the process's death, but the poll
 *  absorbs that small, unavoidable async gap WITHOUT masking a real wedge (which never releases and
 *  so exhausts the bound, leaving a non-zero count for the caller's assertion to fail on). */
async function pollForLockGone(hash: number, maxWaitMs: number): Promise<number> {
  const deadline = Date.now() + maxWaitMs;
  let count = await class2AdvisoryLockCountForHash(hash);
  while (count > 0 && Date.now() < deadline) {
    await sleep(LOCK_GONE_POLL_INTERVAL_MS);
    count = await class2AdvisoryLockCountForHash(hash);
  }
  return count;
}

describe("lease non-wedge cold start (T3 / design.md §2.4)", () => {
  it("[[crash.lease-nonwedge.no-wedge-cold-start]] a SIGKILLed lease-holder's class-2 advisory lock is released by the backend's death: a fresh process's withLease on the same key re-acquires immediately (bounded, no wedge) and pg_locks shows the lock gone; a pre-kill held->blocks control proves the lock was genuinely held so the kill CAUSED the release", async () => {
    const leaseKey = `t3-lease-${randomUUID()}`;

    // ---- Step 1: a worker holds a REAL withLease on `leaseKey`, paused in the critical section ----
    // `in-critical-section` (crash-worker.ts): acquireLease has RETURNED — a class-2 advisory lock
    // pg_advisory_lock(2, hashtext(leaseKey)) is HELD on a reserved connection and recorded in the
    // layer's in-memory heldLeases map — and the withLease callback has NOT returned, so the lock is
    // NOT released. The worker is paused here awaiting the parent's SIGKILL.
    const holder = worker({ connectionUri: connectionUri(), schema: TEST_SCHEMA, hook: "in-critical-section", leaseKey });
    const ready = await holder.waitForReady();
    expect(ready.hook).toBe("in-critical-section");
    expect(ready.lockKey).toBe(leaseKey);
    // The reported hash matches the parent's OWN hashtext of the key — the readiness payload is tied
    // to the real lock, not fabricated (same integrity check the smoke test makes).
    const parentHash = (await withSuiteWatchdog(
      getSql()<{ h: number }[]>`SELECT hashtext(${leaseKey})::int AS h`,
      { label: "parent-hashtext", timeoutMs: HASHTEXT_WATCHDOG_MS },
    ))[0]!.h;
    expect(ready.lockKeyHash).toBe(parentHash);
    const hash = ready.lockKeyHash!;

    // ---- Step 2: CAUSATION CONTROL (BEFORE the kill — so the post-kill re-acquire is not vacuous) --
    // (2a) pg_locks shows EXACTLY ONE granted class-2 advisory lock for this key's hash — the
    //      worker's held lease. The unique random key => exactly one such lock.
    expect(await class2AdvisoryLockCountForHash(hash)).toBe(1); // the lease is genuinely held

    // (2b) HELD => BLOCKS: a fresh bounded acquire on the SAME key, from a fresh parent-side pool,
    //      must NOT acquire — it blocks on the worker's held lock and times out. `tryAcquireLease`
    //      with a `timeoutMs` uses the BLOCKING `pg_advisory_lock` under a `statement_timeout`, so a
    //      genuinely-held lock makes it wait the full bound and then resolve `null`. Measuring the
    //      elapsed time proves it actually BLOCKED (waited), not that it failed instantly for an
    //      unrelated reason. This is the control that makes the post-kill re-acquire CAUSAL: while
    //      held, a real acquire cannot get in.
    const contendLayer = new PgTransactionLeaseLayer(pool(1));
    const blockStart = Date.now();
    const contended = await withSuiteWatchdog(
      () => contendLayer.tryAcquireLease(leaseKey, { timeoutMs: HELD_BLOCK_TIMEOUT_MS }),
      { label: "held-blocks-control", timeoutMs: CONTROL_WATCHDOG_MS },
    );
    const blockElapsed = Date.now() - blockStart;
    // If it somehow ACQUIRED (it must not, the worker holds the lock), release it so we don't leak a
    // held lock into the pool — then the assertion below fails loudly, never a false pass.
    if (contended !== null) await contendLayer.releaseLease(contended).catch(() => {});
    expect(contended).toBeNull();                                       // did NOT acquire — genuinely held
    expect(blockElapsed).toBeGreaterThanOrEqual(HELD_BLOCK_MIN_ELAPSED_MS); // it BLOCKED (waited ~1.5s), not instant
    // The worker's granted lock is STILL the only one after the timed-out attempt cleaned itself up
    // (tryAcquireLease unlocks + resets + releases on timeout) — the control did not perturb it.
    expect(await class2AdvisoryLockCountForHash(hash)).toBe(1);

    // ---- Step 3: SIGKILL the holder; confirm the kill actually landed as a SIGKILL ---------------
    holder.sigkill();
    const exit = await withSuiteWatchdog(holder.waitForExit(), { label: "holder-exit", timeoutMs: 15_000 });
    expect(exit.signal).toBe("SIGKILL"); // the process died by SIGKILL — a clean, hard process death

    // ---- Step 4: from a FRESH pool, STRICTLY AFTER the confirmed SIGKILL --------------------------
    // (4b) pg_locks shows the class-2 advisory lock for this key GONE — Postgres released it when the
    //      killed backend's socket closed. Checked BEFORE the re-acquire so it observes the WORKER's
    //      lock gone, not our own re-acquire masking it. Bounded-polled so a genuine wedge (the lock
    //      never released) FAILS rather than passing on a lucky first read.
    const goneCount = await pollForLockGone(hash, LOCK_GONE_MAX_WAIT_MS);
    expect(goneCount).toBe(0); // the killed lease-holder's advisory lock is released by the backend's death

    // (4a) NO WEDGE: a fresh process's `withLease` on the SAME key acquires IMMEDIATELY. The wait is
    //      BOUNDED by a short `timeoutMs`: had the lease wedged, `pg_advisory_lock` would block and
    //      this `statement_timeout` would raise `LeaseTimeoutError` at ~REACQUIRE_TIMEOUT_MS, failing
    //      this test FAST instead of hanging the suite. The bounded acquire succeeding IS the "no
    //      wedge" proof. Together with the pre-kill held->blocks control (Step 2), this proves the
    //      kill CAUSED the release: held => blocks, killed => acquires.
    const freshLayer = new PgTransactionLeaseLayer(pool(1));
    const acquireStart = Date.now();
    let heldDuringReacquire = -1;
    await withSuiteWatchdog(
      () => freshLayer.withLease(
        leaseKey,
        async () => {
          // Inside the fresh critical section: our re-acquire GENUINELY holds the lock now — exactly
          // one granted class-2 lock for the hash again. Proves the re-acquire is a real lock grant,
          // not a silent no-op.
          heldDuringReacquire = await class2AdvisoryLockCountForHash(hash);
        },
        { timeoutMs: REACQUIRE_TIMEOUT_MS },
      ),
      { label: "fresh-reacquire", timeoutMs: REACQUIRE_WATCHDOG_MS },
    );
    const acquireElapsed = Date.now() - acquireStart;
    expect(acquireElapsed).toBeLessThan(REACQUIRE_TIMEOUT_MS); // acquired inside its own bound — no wedge
    expect(heldDuringReacquire).toBe(1);                       // the re-acquire really held the lock
    // withLease released on exit — nothing is left held on the key.
    expect(await class2AdvisoryLockCountForHash(hash)).toBe(0);
  }, 120_000);
});
