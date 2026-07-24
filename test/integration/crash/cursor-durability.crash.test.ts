import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterEach, describe, expect, it } from "vitest";
import { PgCheckpointStore } from "../../../src/postgres/checkpoint-store.js";
import { createClient, type UmbraDBSql } from "../../../src/postgres/client.js";
import { runMigrations } from "../../../src/postgres/migrate.js";
import { saveAndAdvance } from "../../../src/postgres/save-and-advance.js";
import { PgTemporalKV } from "../../../src/postgres/temporal-kv.js";
import { PgTransactionLeaseLayer } from "../../../src/postgres/transaction-lease.js";
import { PgWatermarks } from "../../../src/postgres/watermarks.js";
import type { JsonValue } from "../../../src/interfaces/temporal-kv.js";
import {
  registerSuiteLifecycle,
  spawnCrashWorker,
  TEST_SCHEMA,
  withSuiteWatchdog,
  type CrashWorkerHandle,
} from "../../postgres/setup.js";

/**
 * T5 — crash between data and cursor, the KEYSTONE (`design.md` §2.3; `tasks.md` §3.1/§3.2;
 * acceptance D1-D6; `council/B` §1 replay-idempotence note + §3 synchronous_commit ruling).
 * Depends on G5 (co-transactional `save({tx})` / `saveAndAdvance`, both MERGED — see the design's
 * post-G5 note). This is the test the whole release turns on: proving a crash between durable data
 * and the sync cursor never leaves the watermark AHEAD of durable data, and that replay from the
 * durable cursor converges on the correct current state.
 *
 * THE HARNESS OWNS A DETERMINISTIC WRITE-BATCH SCHEDULE (`design.md` §2.3 "write batch"). Batch i
 * carries cursor value i, one checkpoint payload, and one KV entry; by construction batch i's
 * checkpoint is the i-th `save` for its wallet, so its durable data is exactly checkpoint seq i.
 * PREFIX batches (1..N-1) are committed IN FULL by the parent via the safe data->cursor ordering
 * (KV data, then the checkpoint co-committed WITH the cursor advance through the G5 `saveAndAdvance`
 * combinator). The CRASH batch (N) is driven by the `crash-worker.ts` child at the named
 * `after-data-commit-before-cursor` hook — data committed in its own transaction, then a pause
 * BETWEEN the two real ops — and SIGKILLed there, so the batch's DATA is durable while its CURSOR
 * advance never was.
 *
 * TEST-HONESTY (the dominant risk in this change):
 *  - DETERMINISTIC: the kill lands at a NAMED PROGRAM POINT (`after-data-commit-before-cursor`),
 *    never on a wall-clock timer; the crash freezes a reproducible state.
 *  - FRESH CLIENT, POST-KILL: every durable-state assertion is observed from a NEW pool STRICTLY
 *    AFTER the confirmed SIGKILL (`exit.signal === "SIGKILL"`) or the confirmed unclean postmaster
 *    kill + restart.
 *  - GENUINELY FALSIFIABLE: the watermark-never-ahead invariant is a PURE function whose teeth are
 *    proven in the same test by running it against the UNSAFE `after-cursor-before-data` crash
 *    state (cursor durable, data absent) and asserting it returns holds === FALSE.
 *  - REFERENCE FROM UmbraDB's OWN ADAPTERS: the replay-convergence reference is a fault-free replay
 *    of the SAME batch sequence via UmbraDB's own adapters into a SEPARATE wallet — never a
 *    hand-coded expected value, never an imported store (`design.md` §4 boundary).
 *  - CURRENT-STATE-ONLY predicate: equality is judged on {kv_current values + latest complete
 *    checkpoint payload bytes + watermark values}, EXCLUDING kv_history rows and version columns,
 *    which legitimately diverge on replay (`council/B` §1) — and that divergence is asserted
 *    explicitly, not hand-waved.
 *  - Every DB op is bounded by `withSuiteWatchdog` so a half-dead Postgres fails typed, not hangs.
 *
 * `src/` is byte-unchanged: this test drives only the public adapters + the existing (Task-0)
 * crash worker/harness; no worker mode or `src/` fault hook is added.
 */

// ---- Deterministic batch schedule -----------------------------------------------------------
const NET = "n";
const CURSOR_KIND = "sync";
const KV_NS = "umbra-sync";
const SAFE_HOOK = "after-data-commit-before-cursor" as const;
const UNSAFE_HOOK = "after-cursor-before-data" as const;

/** Batches committed IN FULL by the parent before the crash (each: data -> cursor, safe ordering). */
const PREFIX_BATCHES = [1, 2] as const;
/** The batch the worker crashes on (its cursor value; also its expected checkpoint seq). */
const CRASH_BATCH = 3;
/** The whole harness-owned sequence (cursorValue === expectedSeq === batch index, one save/batch). */
const ALL_BATCHES = [1, 2, 3] as const;

const { sql: getSql, connectionUri } = registerSuiteLifecycle();

// ---- Pools / adapters / worker tracking -----------------------------------------------------
let openPools: UmbraDBSql[] = [];
let liveWorkers: CrashWorkerHandle[] = [];

interface Adapters {
  sql: UmbraDBSql;
  checkpoints: PgCheckpointStore;
  watermarks: PgWatermarks;
  kv: PgTemporalKV;
  txLayer: PgTransactionLeaseLayer;
}

/** Build UmbraDB's own adapters over an existing pool (no tracking). */
function adaptersOf(sql: UmbraDBSql, schema = TEST_SCHEMA): Adapters {
  const txLayer = new PgTransactionLeaseLayer(sql);
  return {
    sql,
    checkpoints: new PgCheckpointStore(sql, txLayer, schema),
    watermarks: new PgWatermarks(sql, schema),
    kv: new PgTemporalKV(sql, schema),
    txLayer,
  };
}

/** A tracked dedicated pool (torn down in afterEach) against the shared container. */
function newPool(uri: string, maxConnections = 5, track = true): UmbraDBSql {
  const p = createClient({ connectionString: uri, schema: TEST_SCHEMA, maxConnections, connectTimeout: 10 });
  if (track) openPools.push(p);
  return p;
}

/** A tracked adapter set (FRESH client) against the shared container. */
function adaptersFor(uri: string): Adapters {
  return adaptersOf(newPool(uri));
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

// ---- Deterministic payloads / KV values -----------------------------------------------------

/** Deterministic (NOT random) checkpoint payload for a batch. Byte-identical for the same
 *  (salt, batch) so the fault-run replay and the fault-free reference produce identical "latest
 *  complete checkpoint payload bytes" — the leg of the current-state equality predicate that
 *  compares checkpoint content. */
function payload(salt: string, batch: number): Buffer {
  return Buffer.from(`t5-checkpoint|salt=${salt}|batch=${batch}|` + "x".repeat(64), "utf8");
}
function itemKey(batch: number): string { return `item:${batch}`; }
function itemValue(batch: number): JsonValue { return { batch }; }

// ---- Parent-side batch driver (safe ordering: DATA then CURSOR) ------------------------------

/**
 * Commits ONE full write batch via UmbraDB's own adapters, in the documented SAFE ordering:
 * first the batch's KV DATA, then the checkpoint co-committed WITH the cursor advance through the
 * G5 `saveAndAdvance` combinator (checkpoint + watermark in ONE transaction). The cursor for
 * `batch` therefore only ever becomes durable once this batch's data has — which is precisely WHY
 * a crash can never leave the watermark ahead of durable data on this path.
 */
async function driveFullBatch(a: Adapters, wallet: string, scope: string, cursorKey: string, salt: string, batch: number): Promise<void> {
  await withSuiteWatchdog(
    () => a.kv.put(KV_NS, scope, itemKey(batch), itemValue(batch)),
    { label: `kv-put-b${batch}`, timeoutMs: 20_000 },
  );
  await withSuiteWatchdog(
    () => saveAndAdvance(
      { checkpoints: a.checkpoints, watermarks: a.watermarks, txLayer: a.txLayer },
      wallet, NET, payload(salt, batch),
      { kind: CURSOR_KIND, key: cursorKey, value: batch },
    ),
    { label: `saveAndAdvance-b${batch}`, timeoutMs: 20_000 },
  );
}

// ---- Crash-batch driver (worker child, killed at a named hook) -------------------------------

/** Spawn the worker to drive the crash batch's two real ops with a pause between, and wait until
 *  it has paused at the named hook. Returns the handle + readiness for boundary assertions. */
async function spawnCrashBatch(
  uri: string, wallet: string, cursorKey: string,
  hook: typeof SAFE_HOOK | typeof UNSAFE_HOOK, cursorValue: number,
): Promise<{ h: CrashWorkerHandle; ready: Awaited<ReturnType<CrashWorkerHandle["waitForReady"]>> }> {
  const h = worker({
    connectionUri: uri, schema: TEST_SCHEMA, hook,
    walletId: wallet, networkId: NET, cursorKind: CURSOR_KIND, cursorKey, cursorValue,
  });
  const ready = await h.waitForReady(30_000);
  expect(ready.hook).toBe(hook);
  return { h, ready };
}

/** SIGKILL the paused worker and CONFIRM the kill actually landed as a SIGKILL — the deterministic
 *  crash. Every durable-state assertion in the caller runs strictly after this resolves. */
async function killAndConfirm(h: CrashWorkerHandle): Promise<void> {
  h.sigkill();
  const exit = await withSuiteWatchdog(h.waitForExit(), { label: "crash-batch-exit", timeoutMs: 15_000 });
  expect(exit.signal).toBe("SIGKILL");
}

// ---- Durable-state readers (bounded; observe committed state from a caller-supplied pool) ----

/** The set of COMPLETE checkpoint seqs durably present for `wallet` (== the durable checkpoint
 *  data; batch i's data is durable iff seq i is in this set). */
async function durableCompleteSeqs(sql: UmbraDBSql, wallet: string): Promise<Set<number>> {
  const rows = await withSuiteWatchdog(
    sql<{ seq: number }[]>`
      SELECT seq::int AS seq FROM ${sql(TEST_SCHEMA)}.ckpt_manifests
      WHERE w = ${wallet} AND net = ${NET} AND complete`,
    { label: "durableCompleteSeqs", timeoutMs: 10_000 },
  );
  return new Set(rows.map((r) => r.seq));
}

/** Count of complete checkpoint manifests for `wallet` (used to show the tolerated seq divergence). */
async function completeManifestCount(sql: UmbraDBSql, wallet: string): Promise<number> {
  const rows = await withSuiteWatchdog(
    sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(TEST_SCHEMA)}.ckpt_manifests
      WHERE w = ${wallet} AND net = ${NET} AND complete`,
    { label: "completeManifestCount", timeoutMs: 10_000 },
  );
  return rows[0]!.n;
}

// ---- The watermark-never-ahead invariant (a PURE, genuinely-falsifiable predicate) ----------

interface BatchSpec { cursorValue: number; expectedSeq: number; }

interface InvariantResult {
  holds: boolean;
  watermark: number | undefined;
  maxDurableSeq: number | undefined;
  /** Seqs that are covered by the durable watermark but ABSENT from durable data (must be empty). */
  missingCoveredSeqs: number[];
  /** True iff the durable watermark exceeds the max durable checkpoint seq (an inversion). */
  watermarkAheadOfMaxData: boolean;
}

/**
 * THE T5 INVARIANT (`design.md` §2.3 / acceptance D1): the durable watermark is never AHEAD of
 * durable data. Concretely, for the durable watermark value `w`: (1) every write batch whose cursor
 * value <= `w` has its data durably present (its expected checkpoint seq is in `durableCompleteSeqs`),
 * and (2) `w` does not exceed the maximum durable checkpoint seq. Both must hold.
 *
 * This is a PURE function so it can be run against BOTH the safe crash state (returns holds=true)
 * AND the unsafe `after-cursor-before-data` crash state (returns holds=FALSE), proving the invariant
 * is real and the SAFE ordering is what preserves it.
 */
function watermarkNeverAheadResult(
  watermark: number | undefined,
  batches: readonly BatchSpec[],
  durableCompleteSeqs: ReadonlySet<number>,
): InvariantResult {
  const maxDurableSeq = durableCompleteSeqs.size > 0 ? Math.max(...durableCompleteSeqs) : undefined;
  const covered = watermark === undefined ? [] : batches.filter((b) => b.cursorValue <= watermark);
  const missingCoveredSeqs = covered
    .map((b) => b.expectedSeq)
    .filter((seq) => !durableCompleteSeqs.has(seq));
  const watermarkAheadOfMaxData =
    watermark !== undefined && (maxDurableSeq === undefined || watermark > maxDurableSeq);
  return {
    holds: missingCoveredSeqs.length === 0 && !watermarkAheadOfMaxData,
    watermark,
    maxDurableSeq,
    missingCoveredSeqs,
    watermarkAheadOfMaxData,
  };
}

const ALL_BATCH_SPECS: readonly BatchSpec[] = ALL_BATCHES.map((b) => ({ cursorValue: b, expectedSeq: b }));

// ---- Current-state equality predicate (`design.md` §2.3 / acceptance D2/D3) ------------------

interface CurrentState {
  /** kv_current VALUES per key (NOT version, NOT history). */
  kv: Record<string, JsonValue | null>;
  /** Bytes of the latest COMPLETE checkpoint payload. */
  latestPayload: Buffer;
  /** The durable watermark value. */
  watermark: number | undefined;
}

/** Read the {kv_current values + latest complete checkpoint payload + watermark} CURRENT STATE for
 *  a wallet/scope/cursor, via UmbraDB's OWN adapters, from a FRESH client. Deliberately reads NO
 *  version columns and NO kv_history rows — those are excluded from the equality predicate. */
async function readCurrentState(a: Adapters, wallet: string, scope: string, cursorKey: string): Promise<CurrentState> {
  const kv: Record<string, JsonValue | null> = {};
  for (const b of ALL_BATCHES) {
    const entry = await withSuiteWatchdog(() => a.kv.get(KV_NS, scope, itemKey(b)), { label: `kv-get-${b}`, timeoutMs: 10_000 });
    kv[itemKey(b)] = entry === null ? null : entry.value;
  }
  const record = await withSuiteWatchdog(() => a.checkpoints.load(wallet, NET), { label: "load-latest", timeoutMs: 15_000 });
  const watermark = await withSuiteWatchdog(() => a.watermarks.get<number>(CURSOR_KIND, cursorKey), { label: "watermark-get", timeoutMs: 10_000 });
  return { kv, latestPayload: Buffer.from(record.data), watermark };
}

/** The CURRENT-STATE equality predicate (`design.md` §2.3): equal iff kv_current values agree for
 *  every key, latest complete checkpoint payload bytes are identical, and watermark values agree. */
function assertCurrentStateEqual(fault: CurrentState, reference: CurrentState): void {
  expect(fault.kv).toEqual(reference.kv);                                 // (1) kv_current values
  expect(fault.latestPayload.equals(reference.latestPayload)).toBe(true); // (2) latest checkpoint payload bytes
  expect(fault.watermark).toBe(reference.watermark);                      // (3) watermark values
}

/** Current version of a kv key (a DELIBERATELY-EXCLUDED-from-the-predicate quantity, read only to
 *  DEMONSTRATE the tolerated divergence). */
async function kvVersion(a: Adapters, scope: string, key: string): Promise<bigint | null> {
  const entry = await withSuiteWatchdog(() => a.kv.get(KV_NS, scope, key), { label: "kv-version", timeoutMs: 10_000 });
  return entry === null ? null : entry.version;
}

/** Raw watermark read from a caller pool (for pre-kill boundary observation). */
async function watermarkRaw(sql: UmbraDBSql, cursorKey: string): Promise<number | undefined> {
  const rows = await withSuiteWatchdog(
    sql<{ value: number }[]>`
      SELECT value FROM ${sql(TEST_SCHEMA)}.watermarks WHERE kind = ${CURSOR_KIND} AND key = ${cursorKey}`,
    { label: "watermarkRaw", timeoutMs: 10_000 },
  );
  return rows.length === 0 ? undefined : rows[0]!.value;
}

// =============================================================================================
describe("T5 keystone — a crash between data and cursor never leaves the watermark ahead of durable data (design.md §2.3)", () => {
  // ---- 3.1(a) watermark-never-ahead + the falsifiable unsafe-ordering contrast ---------------
  it("[[crash.cursor-durability.watermark-never-ahead]] SIGKILL at after-data-commit-before-cursor leaves the durable watermark BEHIND durable data (invariant holds); the SAME invariant applied to the unsafe after-cursor-before-data crash state FAILS — proving it is real and that the safe ordering preserves it", async () => {
    const uri = connectionUri();
    const salt = randomUUID();

    // ============ SAFE ordering (data -> cursor): the invariant MUST hold ============
    const safeW = `t5-safe-${randomUUID()}`;
    // Prefix batches 1,2 committed IN FULL (kv data, then checkpoint co-committed WITH cursor).
    const safeParent = adaptersFor(uri);
    for (const b of PREFIX_BATCHES) await driveFullBatch(safeParent, safeW, safeW, safeW, salt, b);

    // Crash batch 3 in the worker: DATA committed (its own transaction), pause, then the SIGKILL —
    // the cursor advance (op past the pause) never runs.
    const { h: safeH, ready: safeReady } = await spawnCrashBatch(uri, safeW, safeW, SAFE_HOOK, CRASH_BATCH);
    expect(safeReady.savedSequence).toBe(CRASH_BATCH); // batch-3 checkpoint committed & durable at the pause

    // Boundary (WHILE paused, before the kill): batch-3 data is durable (seq 3 present) but the
    // cursor is still at the prefix value 2 — the crash is about to freeze exactly this state.
    expect((await durableCompleteSeqs(getSql(), safeW)).has(CRASH_BATCH)).toBe(true);
    expect(await watermarkRaw(getSql(), safeW)).toBe(2);

    await killAndConfirm(safeH); // deterministic SIGKILL at the named hook

    // Assert from a FRESH client, strictly AFTER the confirmed kill.
    const safeFresh = adaptersFor(uri);
    const wSafe = await safeFresh.watermarks.get<number>(CURSOR_KIND, safeW);
    const seqsSafe = await durableCompleteSeqs(safeFresh.sql, safeW);
    const resSafe = watermarkNeverAheadResult(wSafe, ALL_BATCH_SPECS, seqsSafe);

    // THE INVARIANT: every batch covered by the durable watermark is present in durable data, and
    // the watermark does not exceed the max durable checkpoint seq.
    expect(resSafe.holds).toBe(true);
    expect(resSafe.watermark).toBe(2);          // cursor stuck at the last FULLY committed batch (2)
    expect(resSafe.missingCoveredSeqs).toEqual([]); // batches 1,2 (cursor <= 2) both durable
    expect(resSafe.watermarkAheadOfMaxData).toBe(false);
    expect(resSafe.maxDurableSeq).toBe(3);      // batch-3 DATA is durable — watermark (2) is BEHIND it
    expect(wSafe!).toBeLessThanOrEqual(resSafe.maxDurableSeq!); // watermark <= data actually committed

    // ============ UNSAFE ordering (cursor -> data): the SAME invariant MUST FAIL ============
    // A caller error the storage layer cannot prevent (out of the invariant's scope) — used ONLY to
    // construct the negative case and prove the invariant above genuinely has teeth.
    const unsafeW = `t5-unsafe-${randomUUID()}`;
    const unsafeParent = adaptersFor(uri);
    for (const b of PREFIX_BATCHES) await driveFullBatch(unsafeParent, unsafeW, unsafeW, unsafeW, salt, b);

    // Crash batch 3 unsafe: CURSOR advanced to 3 FIRST, pause, then the SIGKILL — the data save
    // (op past the pause) never runs, so the cursor is durable with its data ABSENT.
    const { h: unsafeH } = await spawnCrashBatch(uri, unsafeW, unsafeW, UNSAFE_HOOK, CRASH_BATCH);
    // Boundary: cursor is AHEAD (3) while batch-3 data (seq 3) is absent.
    expect(await watermarkRaw(getSql(), unsafeW)).toBe(3);
    expect((await durableCompleteSeqs(getSql(), unsafeW)).has(CRASH_BATCH)).toBe(false);

    await killAndConfirm(unsafeH);

    const unsafeFresh = adaptersFor(uri);
    const wUnsafe = await unsafeFresh.watermarks.get<number>(CURSOR_KIND, unsafeW);
    const seqsUnsafe = await durableCompleteSeqs(unsafeFresh.sql, unsafeW);
    const resUnsafe = watermarkNeverAheadResult(wUnsafe, ALL_BATCH_SPECS, seqsUnsafe);

    // The invariant is FALSIFIABLE: on the unsafe crash state it returns holds === FALSE.
    expect(resUnsafe.holds).toBe(false);
    expect(resUnsafe.watermark).toBe(3);
    expect(resUnsafe.missingCoveredSeqs).toContain(CRASH_BATCH); // batch-3 covered by cursor 3 but ABSENT
    expect(resUnsafe.watermarkAheadOfMaxData).toBe(true);        // cursor 3 ahead of max durable data (seq 2)
    expect(resUnsafe.maxDurableSeq).toBe(2);
  }, 180_000);

  // ---- 3.1(b) replay converges on a fault-free reference (current-state equality) ------------
  it("[[crash.cursor-durability.replay-converges]] replay from the durable cursor converges on a fault-free reference (built from UmbraDB's own adapters) on the current-state equality predicate; kv_history/version + checkpoint-seq divergence is tolerated and shown explicitly", async () => {
    const uri = connectionUri();
    const salt = randomUUID();
    const faultW = `t5-fault-${randomUUID()}`;
    const refW = `t5-ref-${randomUUID()}`;

    // ---- FAULT RUN: prefix 1,2 full; batch 3 crashes after data, before cursor ----------------
    const faultParent = adaptersFor(uri);
    for (const b of PREFIX_BATCHES) await driveFullBatch(faultParent, faultW, faultW, faultW, salt, b);
    const { h } = await spawnCrashBatch(uri, faultW, faultW, SAFE_HOOK, CRASH_BATCH);
    await killAndConfirm(h);

    // The durable cursor after the crash is the last FULLY committed batch (2) — batch 3's data is
    // durable but its cursor never advanced.
    const afterCrash = adaptersFor(uri);
    const durableCursor = await afterCrash.watermarks.get<number>(CURSOR_KIND, faultW);
    expect(durableCursor).toBe(2);

    // ---- REPLAY from the durable cursor: re-drive UmbraDB's OWN adapters for every batch AT/AFTER
    //      the durable watermark (cursor value >= durableCursor), ascending — the idempotent resume
    //      a consumer performs on recovery. This re-applies batch 2 (already durable, so its KV put
    //      bumps the version and writes a spurious kv_history row) and batch 3 (its data never got a
    //      cursor), reaching the fully-synced state. ------------------------------------------------
    const replay = adaptersFor(uri);
    const replayBatches = ALL_BATCHES.filter((b) => b >= durableCursor!); // [2, 3]
    expect(replayBatches).toEqual([2, 3]);
    for (const b of replayBatches) await driveFullBatch(replay, faultW, faultW, faultW, salt, b);

    // ---- FAULT-FREE REFERENCE: the SAME batch sequence 1..3, replayed via UmbraDB's OWN adapters
    //      into a SEPARATE wallet/scope/cursor, with NO fault (never a hand-coded expected value,
    //      never an imported store — `design.md` §4 boundary). ------------------------------------
    const referenceRun = adaptersFor(uri);
    for (const b of ALL_BATCHES) await driveFullBatch(referenceRun, refW, refW, refW, salt, b);

    // ---- CURRENT-STATE EQUALITY (from FRESH clients) ------------------------------------------
    const faultState = await readCurrentState(adaptersFor(uri), faultW, faultW, faultW);
    const refState = await readCurrentState(adaptersFor(uri), refW, refW, refW);
    assertCurrentStateEqual(faultState, refState);
    // Spell the convergence out: watermark fully advanced to 3 on both; all kv_current values equal.
    expect(faultState.watermark).toBe(3);
    expect(refState.watermark).toBe(3);
    expect(faultState.kv).toEqual({ "item:1": { batch: 1 }, "item:2": { batch: 2 }, "item:3": { batch: 3 } });

    // ---- TOLERATED DIVERGENCE (EXCLUDED from the predicate) — asserted explicitly so the exclusion
    //      is real, not hand-waved. WHY tolerated (`council/B` §1's replay-idempotence note): `put`
    //      without `expectedVersion` is a version-bumping upsert, so REPLAY re-applies writes and
    //      produces higher `version` counters + spurious `kv_history` rows + duplicate checkpoint
    //      manifests at fresh seqs versus a fault-free run. The CURRENT-STATE value is identical; the
    //      version/history/seq chains legitimately differ and are deliberately not compared. ---------
    const faultItem2Version = await kvVersion(adaptersFor(uri), faultW, itemKey(2));
    const refItem2Version = await kvVersion(adaptersFor(uri), refW, itemKey(2));
    expect(Number(faultItem2Version)).toBeGreaterThan(Number(refItem2Version)); // version DIVERGES (replay re-applied batch 2)
    expect(faultState.kv[itemKey(2)]).toEqual(refState.kv[itemKey(2)]);         // ...but the VALUE converges
    // Checkpoint seq chain diverges too (crash's superseded seq + replay's duplicates) while the
    // LATEST payload converges — the predicate compares only the latest complete payload.
    const faultManifests = await completeManifestCount(adaptersFor(uri).sql, faultW);
    const refManifests = await completeManifestCount(adaptersFor(uri).sql, refW);
    expect(faultManifests).toBeGreaterThan(refManifests); // extra manifests from the crash + replay
    expect(faultState.latestPayload.equals(payload(salt, CRASH_BATCH))).toBe(true); // latest = batch-3 payload, on both
  }, 180_000);

  // ---- 3.2 synchronous_commit = ON (shared container; a client SIGKILL cannot lose acked data) --
  it("[[crash.cursor-durability.synchronous-commit-on]] under synchronous_commit = on, the watermark-never-ahead invariant holds after the T5 crash; the acked (synchronous) data survives the client kill with no tail loss, watermark strictly behind durable data", async () => {
    const uri = connectionUri();
    // Server default is synchronous_commit = on; assert it so this leg is unambiguously the ON leg.
    const scRows = await withSuiteWatchdog(
      getSql()<{ synchronous_commit: string }[]>`SHOW synchronous_commit`,
      { label: "show-sc-on", timeoutMs: 10_000 },
    );
    expect(scRows[0]!.synchronous_commit).toBe("on");

    const salt = randomUUID();
    const onW = `t5-on-${randomUUID()}`;
    const parent = adaptersFor(uri);
    for (const b of PREFIX_BATCHES) await driveFullBatch(parent, onW, onW, onW, salt, b);

    const { h, ready } = await spawnCrashBatch(uri, onW, onW, SAFE_HOOK, CRASH_BATCH);
    expect(ready.savedSequence).toBe(CRASH_BATCH);
    await killAndConfirm(h);

    const fresh = adaptersFor(uri);
    const w = await fresh.watermarks.get<number>(CURSOR_KIND, onW);
    const seqs = await durableCompleteSeqs(fresh.sql, onW);
    const res = watermarkNeverAheadResult(w, ALL_BATCH_SPECS, seqs);

    // The invariant holds (the same falsifiable checker proven in the watermark-never-ahead test).
    expect(res.holds).toBe(true);
    expect(res.watermark).toBe(2);
    expect(res.watermarkAheadOfMaxData).toBe(false);
    // What ON PROVES: a synchronous commit is durable at ack, so a CLIENT SIGKILL cannot lose it —
    // batch-3's committed DATA (seq 3) survived; the watermark (2) is strictly BEHIND durable data.
    expect(seqs.has(CRASH_BATCH)).toBe(true); // NO tail loss under synchronous_commit = on
    expect(w!).toBeLessThan(res.maxDurableSeq!);
  }, 120_000);

  // ---- 3.2 synchronous_commit = OFF (dedicated container; UNCLEAN postmaster kill) --------------
  it("[[crash.cursor-durability.synchronous-commit-off]] under synchronous_commit = off with an UNCLEAN postmaster kill (SIGQUIT/immediate crash, not a clean stop) + crash recovery, the watermark-never-ahead invariant STILL holds: a lost tail of acked commits is acceptable, an inverted durability order is a failure", async () => {
    // A DEDICATED container with SERVER-LEVEL synchronous_commit=off (`design.md` §1.3 sanctions
    // "the container started with -c synchronous_commit=off"). Killing THIS container's postmaster
    // uncleanly cannot disturb the shared container the other legs use.
    const container: StartedPostgreSqlContainer = await new PostgreSqlContainer("postgres:17-alpine")
      .withCommand(["postgres", "-c", "synchronous_commit=off"])
      .start();
    const localPools: UmbraDBSql[] = [];
    try {
      let uri = container.getConnectionUri();
      const admin = createClient({ connectionString: uri, schema: TEST_SCHEMA, maxConnections: 5, connectTimeout: 10 });
      localPools.push(admin);
      await runMigrations(admin, { schema: TEST_SCHEMA });

      // Assert the leg really runs with server-level synchronous_commit = off.
      const scRows = await withSuiteWatchdog(
        admin<{ synchronous_commit: string }[]>`SHOW synchronous_commit`,
        { label: "show-sc-off", timeoutMs: 10_000 },
      );
      expect(scRows[0]!.synchronous_commit).toBe("off");

      const salt = randomUUID();
      const offW = `t5-off-${randomUUID()}`;
      const parent = adaptersOf(admin);
      for (const b of PREFIX_BATCHES) await driveFullBatch(parent, offW, offW, offW, salt, b);

      // DURABLE FLOOR: force the async prefix commits to disk with an explicit CHECKPOINT, so the
      // invariant is checked NON-VACUOUSLY (a real surviving watermark + real surviving data) even
      // though the tail may be lost. Confirmed empirically: a checkpointed prefix survives the
      // immediate crash; an un-checkpointed async tail can be lost.
      await withSuiteWatchdog(admin`CHECKPOINT`, { label: "durable-floor-checkpoint", timeoutMs: 20_000 });

      // CRASH batch 3 on the dedicated container: data async-committed (NOT checkpointed — a losable
      // tail), then the worker pauses before the cursor advance.
      const { h, ready } = await spawnCrashBatch(uri, offW, offW, SAFE_HOOK, CRASH_BATCH);
      expect(ready.savedSequence).toBe(CRASH_BATCH);

      // UNCLEAN POSTMASTER KILL: SIGQUIT to PID 1 (postgres) == immediate crash shutdown (no
      // checkpoint), NOT a clean, WAL-flushing container stop. This is what makes a tail loss
      // REACHABLE (a client kill or clean stop never loses acked async commits — `design.md` §2.3).
      try {
        await container.exec(["kill", "-s", "QUIT", "1"]);
      } catch { /* the postmaster dying can drop the exec stream; the crash is what matters */ }
      h.sigkill(); // reap the worker child too (its connection died with the postmaster)

      // Recover via crash recovery (container restart) and RE-READ the (remapped) connection URI.
      await new Promise((r) => setTimeout(r, 1_500)); // let the container settle into 'exited'
      await container.restart({ timeout: 30 });
      uri = container.getConnectionUri();

      // Reconnect from a FRESH client, strictly AFTER the crash + recovery.
      const fresh = createClient({ connectionString: uri, schema: TEST_SCHEMA, maxConnections: 2, connectTimeout: 10 });
      localPools.push(fresh);
      let ok = false;
      for (let i = 0; i < 40 && !ok; i++) {
        try { await fresh<{ ok: number }[]>`SELECT 1 AS ok`; ok = true; } catch { await new Promise((r) => setTimeout(r, 500)); }
      }
      expect(ok).toBe(true); // Postgres came back after crash recovery

      const freshAdapters = adaptersOf(fresh);
      const w = await freshAdapters.watermarks.get<number>(CURSOR_KIND, offW);
      const seqs = await durableCompleteSeqs(fresh, offW);
      const res = watermarkNeverAheadResult(w, ALL_BATCH_SPECS, seqs);

      // NON-VACUOUS: the checkpointed prefix (batches 1,2 + cursor 2) survived the crash.
      expect(seqs.has(1)).toBe(true);
      expect(seqs.has(2)).toBe(true);
      expect(w).toBe(2);

      // THE INVARIANT STILL HOLDS: watermark never ahead of durable data — an INVERTED durability
      // order (cursor durable, its data not) would make holds=false (the same falsifiable checker
      // the watermark-never-ahead test drives to FALSE on the unsafe crash state).
      expect(res.holds).toBe(true);
      expect(res.watermarkAheadOfMaxData).toBe(false); // no inversion, regardless of tail loss

      // TAIL LOSS IS ACCEPTABLE (fault-agnostic, non-flaky): batch-3's un-checkpointed data (the
      // tail) MAY or MAY NOT have survived the immediate crash. Either way the invariant holds; we
      // record the outcome as evidence but assert NOTHING on it (so the test never flakes).
      const tailLost = !seqs.has(CRASH_BATCH);
      // eslint-disable-next-line no-console
      console.log(`[t5-off-leg] synchronous_commit=off unclean-crash: tail (batch ${CRASH_BATCH} data) ${tailLost ? "LOST (acceptable)" : "survived"}; watermark=${String(w)}, durableSeqs=${[...seqs].sort((a, b) => a - b).join(",")}`);
    } finally {
      await Promise.all(localPools.map((p) => p.end({ timeout: 5 }).catch(() => {})));
      await container.stop().catch(() => {});
    }
  }, 240_000);
});
