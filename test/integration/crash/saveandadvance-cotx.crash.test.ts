import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { PgCheckpointStore } from "../../../src/postgres/checkpoint-store.js";
import { createClient, type UmbraDBSql } from "../../../src/postgres/client.js";
import { saveAndAdvance } from "../../../src/postgres/save-and-advance.js";
import { PgTransactionLeaseLayer } from "../../../src/postgres/transaction-lease.js";
import { PgWatermarks } from "../../../src/postgres/watermarks.js";
import {
  registerSuiteLifecycle,
  spawnCrashWorker,
  TEST_SCHEMA,
  withSuiteWatchdog,
  type CrashWorkerHandle,
} from "../../postgres/setup.js";

/**
 * Co-transactional G5 atomicity crash — the SINGLE-transaction `saveAndAdvance` under a crash
 * (change-level audit BLOCK 1). One required test: `[[crash.saveAndAdvance.co-tx-atomic]]`.
 *
 * WHY THIS EXISTS. The T5 keystone (`cursor-durability.crash.test.ts`) models the TWO-transaction
 * ordering (an independent checkpoint save, then a separate watermark advance) and asserts the
 * watermark is never durable ahead of durable data. It never crashes the co-transactional G5
 * primitive itself. `saveAndAdvance` (`src/postgres/save-and-advance.ts`) opens ONE transaction,
 * writes the checkpoint (`save({tx})`) and then advances the cursor (`watermarks.set({tx})`) on the
 * SAME handle, and commits both together — the primitive whose entire point is that "a crash before
 * that single COMMIT leaves neither the checkpoint nor the cursor durable." This test crash-tests
 * THAT guarantee directly: a `saveAndAdvance` that leaked a partial commit (e.g. an inner implicit
 * commit between the data and cursor writes) would be caught here and nowhere else.
 *
 * HOW (NO `src/` CHANGE). A `co-tx-crash` crash-worker mode drives `saveAndAdvance` through a
 * test-only query observer — a `Proxy` over saveAndAdvance's OWN transaction handle (the same
 * technique load-under-prune uses) — that pauses the tx BETWEEN its internal checkpoint-data write
 * and its cursor write (both inside the one uncommitted tx), signals readiness (with the worker's
 * backend pid), and blocks until the parent SIGKILLs the worker process. The SIGKILL drops the
 * connection; Postgres rolls the single uncommitted tx back.
 *
 * TEST-HONESTY:
 *  - DETERMINISTIC: the pause is at a NAMED program point (the cursor write inside the one tx),
 *    never a wall-clock timer; the SIGKILL freezes a reproducible state.
 *  - HONESTY GUARD: before the kill, the worker's backend is proven to hold an OPEN transaction
 *    ('idle in transaction', xact_start set) with the checkpoint-data writes already issued and
 *    nothing yet visible from a fresh observer.
 *  - FRESH CLIENT, POST-KILL: every durable-state assertion is observed from a NEW pool STRICTLY
 *    AFTER the confirmed SIGKILL (`exit.signal === "SIGKILL"`).
 *  - NEGATIVE CONTROL: the SAME `saveAndAdvance` run to COMPLETION (`co-tx-full-flow`, no kill)
 *    lands BOTH the checkpoint AND the cursor — so the killed run's all-or-nothing absence is
 *    provably caused by the crash, not a missing op.
 *  - Every DB op is bounded by `withSuiteWatchdog` so a half-dead backend fails typed, not hangs.
 *
 * `src/` is byte-unchanged: this test drives only the public adapters + the Task-0 crash harness
 * (extended with the `co-tx-crash`/`co-tx-full-flow` worker modes, both TEST code).
 */

const NET = "n";
const CURSOR_KIND = "sync";

const { sql: getSql, connectionUri } = registerSuiteLifecycle();

let openPools: UmbraDBSql[] = [];
let liveWorkers: CrashWorkerHandle[] = [];

function pool(maxConnections = 5): UmbraDBSql {
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
  await Promise.all(liveWorkers.map((w) =>
    withSuiteWatchdog(w.waitForExit(), { label: "afterEach-worker-exit", timeoutMs: 15_000 }).catch(() => {}),
  ));
  liveWorkers = [];
  await Promise.all(openPools.map((p) => p.end({ timeout: 5 }).catch(() => {})));
  openPools = [];
});

// -- Parent-side verification queries (each on a caller-supplied pool so an assertion is made from a
//    FRESH client; each bounded by the suite watchdog). --------------------------------------------

async function completeManifestCount(sql: UmbraDBSql, w: string, net: string): Promise<number> {
  const rows = await withSuiteWatchdog(
    sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(TEST_SCHEMA)}.ckpt_manifests
      WHERE w = ${w} AND net = ${net} AND complete`,
    { label: "completeManifestCount", timeoutMs: 10_000 },
  );
  return rows[0]!.n;
}

/** ALL manifest rows for (w,net), complete or not — must be 0 after an all-or-nothing rollback. */
async function manifestRowCount(sql: UmbraDBSql, w: string, net: string): Promise<number> {
  const rows = await withSuiteWatchdog(
    sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(TEST_SCHEMA)}.ckpt_manifests
      WHERE w = ${w} AND net = ${net}`,
    { label: "manifestRowCount", timeoutMs: 10_000 },
  );
  return rows[0]!.n;
}

/** Junction rows referencing a manifest that is ABSENT or NOT `complete`. */
async function orphanJunctionCount(sql: UmbraDBSql): Promise<number> {
  const rows = await withSuiteWatchdog(
    sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM ${sql(TEST_SCHEMA)}.ckpt_manifest_chunks mc
      LEFT JOIN ${sql(TEST_SCHEMA)}.ckpt_manifests m ON m.id = mc.manifest_id
      WHERE m.id IS NULL OR m.complete = false`,
    { label: "orphanJunctionCount", timeoutMs: 10_000 },
  );
  return rows[0]!.n;
}

async function watermarkValue(sql: UmbraDBSql, kind: string, key: string): Promise<number | undefined> {
  return withSuiteWatchdog(
    () => new PgWatermarks(sql, TEST_SCHEMA).get<number>(kind, key),
    { label: "watermarkValue", timeoutMs: 10_000 },
  );
}

describe("Co-transactional saveAndAdvance crash — G5 atomicity (change-level audit BLOCK 1)", () => {
  it("[[crash.saveAndAdvance.co-tx-atomic]] a crash BETWEEN saveAndAdvance's internal data write and cursor write (both inside its ONE uncommitted transaction) leaves NEITHER the checkpoint NOR the watermark advance durable (all-or-nothing); a no-kill control lands BOTH", async () => {
    const walletId = `cotx-${randomUUID()}`;
    const cursorKey = walletId;
    const cursorValue = 7;

    // ---- CRASH LEG: saveAndAdvance killed between its data write and its cursor write ----------
    const killed = worker({
      connectionUri: connectionUri(), schema: TEST_SCHEMA, mode: "co-tx-crash",
      walletId, networkId: NET, cursorKind: CURSOR_KIND, cursorKey, cursorValue, payloadBytes: 384,
    });
    const ready = await killed.waitForReady();
    expect(ready.mode).toBe("co-tx-crash");
    expect(ready.backendPid).toBeGreaterThan(0);
    // BLOCK 2 (write-proof readiness): readiness PROVES saveAndAdvance's checkpoint writes actually
    // executed on the worker's OWN tx -- the observer saw the checkpoint manifest INSERT flow through
    // that tx AND an in-tx SELECT sees the COMPLETE manifest row present-but-uncommitted (count >= 1).
    // Combined with the fresh-observer assertions below (nothing durable), this establishes the
    // checkpoint is present-in-tx yet NOT durable, so the SIGKILL's rollback is what removes it -- not
    // the observer's own probe query alone creating the reported idle transaction.
    expect(ready.manifestObserved).toBe(true);
    expect(Number(ready.checkpointRowsInTx)).toBeGreaterThanOrEqual(1);

    // HONESTY GUARD: the worker holds an OPEN transaction (save's writes issued on it; the cursor
    // write not yet issued — the observer paused before it). 'idle in transaction' + xact_start set.
    const activity = await withSuiteWatchdog(
      getSql()<{ state: string | null; hasXact: boolean }[]>`
        SELECT state, xact_start IS NOT NULL AS "hasXact"
        FROM pg_stat_activity WHERE pid = ${ready.backendPid!}`,
      { label: "worker-activity", timeoutMs: 10_000 },
    );
    expect(activity.length).toBe(1);
    expect(activity[0]!.hasXact).toBe(true);
    expect(activity[0]!.state).toBe("idle in transaction");

    // While paused (uncommitted) NOTHING is durable from a fresh observer: no checkpoint, no cursor.
    expect(await completeManifestCount(getSql(), walletId, NET)).toBe(0);
    expect(await watermarkValue(getSql(), CURSOR_KIND, cursorKey)).toBeUndefined();

    // KILL: SIGKILL the worker PROCESS; the single uncommitted tx is rolled back by Postgres.
    killed.sigkill();
    const exit = await withSuiteWatchdog(killed.waitForExit(), { label: "cotx-worker-exit", timeoutMs: 15_000 });
    expect(exit.signal).toBe("SIGKILL");

    // ---- ALL-OR-NOTHING from a FRESH client, strictly POST-KILL: NEITHER side is durable --------
    const fresh = pool();
    // (a) no checkpoint — not even an incomplete manifest row (the whole tx rolled back).
    expect(await completeManifestCount(fresh, walletId, NET)).toBe(0);
    expect(await manifestRowCount(fresh, walletId, NET)).toBe(0);
    // (b) no cursor advance — the watermark for this key never became durable.
    expect(await watermarkValue(fresh, CURSOR_KIND, cursorKey)).toBeUndefined();
    // (c) no partial leak.
    expect(await orphanJunctionCount(fresh)).toBe(0);

    // (d) The rollback was TOTAL — including the checkpoint sequence allocation. A fresh
    //     saveAndAdvance on the SAME (wallet, net) therefore lands seq 1 and commits BOTH sides,
    //     proving the crashed tx left no durable partial state behind (G5 atomicity end-to-end).
    const recoveryDeps = (() => {
      const p = pool();
      const txLayer = new PgTransactionLeaseLayer(p);
      return { checkpoints: new PgCheckpointStore(p, txLayer, TEST_SCHEMA), watermarks: new PgWatermarks(p, TEST_SCHEMA), txLayer };
    })();
    const recovered = await withSuiteWatchdog(
      () => saveAndAdvance(recoveryDeps, walletId, NET, Buffer.from("cotx-recovery"), { kind: CURSOR_KIND, key: cursorKey, value: 1 }),
      { label: "recovery-saveAndAdvance", timeoutMs: 20_000 },
    );
    expect(recovered.sequence).toBe(1); // counter never advanced under the crash
    expect(await completeManifestCount(fresh, walletId, NET)).toBe(1);
    expect(await watermarkValue(fresh, CURSOR_KIND, cursorKey)).toBe(1);

    // ---- NEGATIVE CONTROL: the SAME co-tx flow run to COMPLETION (no kill) lands BOTH -----------
    const ctlWallet = `cotx-ctl-${randomUUID()}`;
    const ctlKey = ctlWallet;
    const ctl = worker({
      connectionUri: connectionUri(), schema: TEST_SCHEMA, mode: "co-tx-full-flow",
      walletId: ctlWallet, networkId: NET, cursorKind: CURSOR_KIND, cursorKey: ctlKey, cursorValue, payloadBytes: 384,
    });
    const ctlReady = await ctl.waitForReady();
    expect(ctlReady.mode).toBe("co-tx-full-flow");
    expect(ctlReady.savedSequence).toBe(1);
    const ctlExit = await withSuiteWatchdog(ctl.waitForExit(), { label: "cotx-control-exit", timeoutMs: 15_000 });
    expect(ctlExit.code).toBe(0); // clean completion, not a crash

    const ctlPool = pool();
    expect(await completeManifestCount(ctlPool, ctlWallet, NET)).toBe(1);   // checkpoint durable
    expect(await watermarkValue(ctlPool, CURSOR_KIND, ctlKey)).toBe(cursorValue); // cursor durable
  }, 120_000);
});
