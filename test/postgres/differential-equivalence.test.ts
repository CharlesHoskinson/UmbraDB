import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PgCheckpointStore } from "../../src/postgres/checkpoint-store.js";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { saveAndAdvance } from "../../src/postgres/save-and-advance.js";
import { PgTemporalKV } from "../../src/postgres/temporal-kv.js";
import { PgTransactionLeaseLayer } from "../../src/postgres/transaction-lease.js";
import { PgWatermarks } from "../../src/postgres/watermarks.js";
import type { JsonValue } from "../../src/interfaces/temporal-kv.js";
import {
  pgTerminateBackend,
  registerSuiteLifecycle,
  spawnCrashWorker,
  TEST_SCHEMA,
  withSuiteWatchdog,
  type CrashWorkerHandle,
} from "./setup.js";

/**
 * G11 — the differential state-equivalence gate, fault-schedule half (`design.md` §5; `tasks.md`
 * §6.2; acceptance G2/G3/G4/G5c/G6c; `02`-T11; `council/B` §1 "compare CURRENT state, not history
 * chains"). Depends on G5 (co-transactional `save({tx})` / `saveAndAdvance`, both MERGED — see the
 * design's post-G5 note); the fault-schedule half could not pass honestly before G5.
 *
 * WHAT THIS PROVES. A randomized-but-SEEDED schedule that mixes the three G9 faults — T1
 * (process-kill mid-save), T2 (Postgres-kill mid-save), T5 (crash between data and cursor) — across
 * a sequence of numbered write batches, recovering (re-syncing from durable state) after each fault,
 * converges to a CURRENT STATE that is EQUIVALENT to a fault-free reference run of the SAME input
 * schedule. Equivalence is judged on CURRENT STATE ONLY (the §2.3 exhaustive predicate: the full
 * `kv_current` row set + the full `watermarks` row set + the latest complete checkpoint payload
 * bytes), with `kv_history`/`version`/checkpoint-seq divergence TOLERATED and shown explicitly
 * (`council/B` §1: replay legitimately re-applies version-bumping upserts and duplicate manifests).
 *
 * THE REFERENCE IS IN-REPO (`design.md` §4/§5 boundary; acceptance G3). It is a fault-free replay of
 * the same write-batch sequence via UmbraDB's OWN adapters (`PgTemporalKV` + `saveAndAdvance` over
 * `PgCheckpointStore`/`PgWatermarks`) into a SEPARATE wallet — the SAME keystone reference discipline
 * `cursor-durability.crash.test.ts` (§2.3) uses, NEVER a hand-coded expected value and NEVER an
 * imported consumer/indexer store. (`test/postgres/reference-merge.ts` is the transaction-HISTORY
 * merge stand-in; it does NOT model KV/checkpoint/watermark current state, so the current-state
 * reference here follows the keystone discipline instead — Task 5.1 note.) The
 * import-cleanliness of the reference side is asserted by a static audit of THIS file's own imports
 * (`the reference side imports nothing outside the repo` — acceptance G3 / test below).
 *
 * TEST-HONESTY (the dominant risk in this change):
 *  - DETERMINISTIC / SEEDED: the fault schedule is derived from a fixed SEED via a seeded PRNG
 *    (mulberry32) + a seeded Fisher-Yates shuffle — never `Math.random`. Same seed => same schedule
 *    every run (logged for reproducibility). The schedule GUARANTEES at least one of each fault type
 *    appears, so all three faults are genuinely exercised and interleaved.
 *  - EACH FAULT IS THE REAL G9 FAULT: T1/T2/T5 are driven by the SAME Task-0 `crash-worker.ts` +
 *    `setup.ts` primitives the dedicated crash tests use (a literal cross-process SIGKILL, a real
 *    `pg_terminate_backend` of the worker's in-flight backend). No `src/` fault hook is added.
 *  - RECOVERY IS A REAL RESUME: after each fault the run re-reads the DURABLE cursor and re-applies
 *    the batches at/after it through UmbraDB's own adapters — exactly the idempotent resume a
 *    consumer performs on restart — never a hand-patched "fix up the row" shortcut.
 *  - REFERENCE FROM UmbraDB's OWN ADAPTERS (never a copy of the fault run): a plain fault-free replay
 *    into a separate wallet.
 *  - CURRENT-STATE-ONLY, EXHAUSTIVE predicate: the FULL kv_current + FULL watermarks (raw SELECTs, so
 *    a stale/extra row on one side breaks equality) + latest complete checkpoint payload; excludes
 *    kv_history/version — and that exclusion's divergence is asserted explicitly, not hand-waved.
 *  - NEGATIVE CONTROL WITH TEETH: a deliberately-broken variant that genuinely DROPS a committed
 *    range (skips one faulted batch's recovery step) makes the equivalence assertion FIRE — proving
 *    the check would catch a real divergence rather than passing vacuously.
 *  - Every DB op is bounded by `withSuiteWatchdog` so a half-dead Postgres fails typed, not hangs.
 *  - CI-tractable: the schedule length is bounded and every fault is a fast primitive (no container
 *    restart), so the whole file runs well within the required gate's budget.
 *
 * `src/` is byte-unchanged: this test drives only the public adapters + the existing (Task-0) crash
 * worker/harness.
 */

// ---- Identity / batch model (mirrors the keystone `design.md` §2.3 "write batch") ------------
const NET = "n";
const CURSOR_KIND = "sync";
const KV_NS = "umbra-sync";

/** Batch i carries cursor value i, one KV datum (`item:i`), and one checkpoint payload
 *  `payload(salt,i)`. Byte-deterministic for a fixed (salt,i) so the fault run's durable content and
 *  the fault-free reference's are directly comparable (the current-state predicate compares the
 *  latest checkpoint payload bytes and every kv_current value). Kept BYTE-IDENTICAL with the crash
 *  worker's `t5DeterministicPayload` (`crash-worker.ts`) so a T5 crash batch commits the SAME content
 *  as the fault-free reference batch for its index — a genuine same-sequence step, not arbitrary
 *  bytes the recovery silently overwrites (the keystone `design.md` §2.3 deterministic-data mode). */
function payload(salt: string, batch: number): Buffer {
  return Buffer.from(`t5-checkpoint|salt=${salt}|batch=${batch}|` + "x".repeat(64), "utf8");
}
function itemKey(batch: number): string { return `item:${batch}`; }
function itemValue(batch: number): JsonValue { return { batch }; }
/** INJECTIVE current-state map key for a (ns, key) tuple (change-level round-3 BLOCK 2). The old
 *  `${ns} ${key}` space-join was NOT injective — spaces are legal in ns/key (interfaces/temporal-kv),
 *  so (ns="a b", key="c") and (ns="a", key="b c") both collapsed to "a b c" and the exhaustive
 *  equality could pass with DIFFERENT kv_current row sets. `JSON.stringify([ns, key])` is injective. */
function kvMapKey(ns: string, key: string): string { return JSON.stringify([ns, key]); }

// ---- Seeded schedule (deterministic, reproducible — NO Math.random) --------------------------
type Fault = "none" | "t1" | "t2" | "t5";

/** A fixed seed makes the whole fault schedule reproducible: the same faults land on the same
 *  batches every run. Change it only deliberately. */
const SEED = 0x5eed_da7a;
/** Bounded so the file is CI-tractable (each faulted batch spawns one short-lived worker). */
const SCHEDULE_LENGTH = 7;

/** mulberry32 — a tiny deterministic PRNG in [0,1). Seeded, reproducible, no global state. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds the seeded fault schedule of `length` batches. A base multiset that GUARANTEES at least one
 * T1, one T2 and two T5 (plus fault-free `none` batches to interleave clean progress) is
 * deterministically SHUFFLED with a seeded Fisher-Yates — so the mix and ORDER of faults are
 * randomized yet fully reproducible, and every fault type is genuinely exercised.
 */
function buildSchedule(seed: number, length: number): Fault[] {
  const rnd = mulberry32(seed);
  // Coverage-guaranteeing base (>= 1 of each fault, the rest fault-free), padded/truncated to length.
  const base: Fault[] = ["t1", "t2", "t5", "t5", "t1", "none", "none"];
  const items = base.slice(0, length);
  while (items.length < length) items.push("none");
  // Seeded Fisher-Yates shuffle (deterministic given the seed).
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

// ---- Pools / adapters / worker tracking ------------------------------------------------------
const { sql: getSql, connectionUri } = registerSuiteLifecycle();

let openPools: UmbraDBSql[] = [];
let liveWorkers: CrashWorkerHandle[] = [];

interface Adapters {
  sql: UmbraDBSql;
  checkpoints: PgCheckpointStore;
  watermarks: PgWatermarks;
  kv: PgTemporalKV;
  txLayer: PgTransactionLeaseLayer;
}

/** Build UmbraDB's own adapters over a pool (no imported store anywhere). */
function adaptersOf(sql: UmbraDBSql): Adapters {
  const txLayer = new PgTransactionLeaseLayer(sql);
  return {
    sql,
    checkpoints: new PgCheckpointStore(sql, txLayer, TEST_SCHEMA),
    watermarks: new PgWatermarks(sql, TEST_SCHEMA),
    kv: new PgTemporalKV(sql, TEST_SCHEMA),
    txLayer,
  };
}

/** A tracked dedicated pool (torn down in afterEach) against the shared container. */
function newPool(uri: string, maxConnections = 5): UmbraDBSql {
  const p = createClient({ connectionString: uri, schema: TEST_SCHEMA, maxConnections, connectTimeout: 10 });
  openPools.push(p);
  return p;
}

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

// ---- Fault-free batch driver (safe ordering: DATA then CURSOR) via UmbraDB's own adapters -----

/** Commits ONE full write batch in the documented SAFE ordering: the batch's KV DATA first, then the
 *  checkpoint co-committed WITH the cursor advance through the G5 `saveAndAdvance` combinator. Used
 *  BOTH by the fault run's recovery (resume) AND by the fault-free reference — the reference is
 *  nothing more than this same driver run without any fault. */
async function driveFullBatch(a: Adapters, wallet: string, salt: string, batch: number): Promise<void> {
  await withSuiteWatchdog(
    () => a.kv.put(KV_NS, wallet, itemKey(batch), itemValue(batch)),
    { label: `kv-put-b${batch}`, timeoutMs: 20_000 },
  );
  await withSuiteWatchdog(
    () => saveAndAdvance(
      { checkpoints: a.checkpoints, watermarks: a.watermarks, txLayer: a.txLayer },
      wallet, NET, payload(salt, batch),
      { kind: CURSOR_KIND, key: wallet, value: batch },
    ),
    { label: `saveAndAdvance-b${batch}`, timeoutMs: 20_000 },
  );
}

// ---- The three G9 faults, driven by the Task-0 crash worker/harness --------------------------

/** T1 — process-kill mid-save. The worker drives a co-transactional `save` and pauses at
 *  `before-commit`; a literal SIGKILL drops its connection so Postgres aborts the in-flight
 *  transaction: NOTHING becomes durable for this batch (no checkpoint, no KV, cursor unchanged). */
async function injectT1(uri: string, wallet: string, batch: number): Promise<void> {
  const h = worker({ connectionUri: uri, schema: TEST_SCHEMA, hook: "before-commit", walletId: wallet, networkId: NET });
  const ready = await h.waitForReady(30_000);
  expect(ready.hook).toBe("before-commit");
  h.sigkill();
  const exit = await withSuiteWatchdog(h.waitForExit(), { label: `t1-exit-b${batch}`, timeoutMs: 15_000 });
  expect(exit.signal).toBe("SIGKILL"); // deterministic process kill landed
}

/** T2 — Postgres-kill mid-save. The worker opens a real transaction and issues the save's statements
 *  (uncommitted), reports its backend pid; the parent kills THAT backend (`pg_terminate_backend`)
 *  STRICTLY BEFORE the failing op, then releases the worker, whose in-flight commit rejects with a
 *  typed connection failure. All-or-nothing => NOTHING durable for this batch (cursor unchanged). */
async function injectT2(uri: string, wallet: string, batch: number): Promise<void> {
  const h = worker({
    connectionUri: uri, schema: TEST_SCHEMA, hook: "before-commit",
    walletId: wallet, networkId: NET, extraEnv: { UMBRADB_CRASH_T2_COMMIT_AFTER_KILL: "1" },
  });
  const ready = await h.waitForReady(30_000);
  expect(ready.backendPid).toBeGreaterThan(0);
  const terminated = await pgTerminateBackend(getSql(), ready.backendPid!); // kill the worker's backend first
  expect(terminated).toBe(true);
  h.sendLine("proceed"); // release: the worker's in-flight save now commits on a dead connection
  const result = await h.waitForResult(30_000);
  expect(result.threw).toBe(true);          // the in-flight save failed typed (not a silent success)
  expect(result.committed).not.toBe(true);  // never a false commit
  await withSuiteWatchdog(h.waitForExit(), { label: `t2-exit-b${batch}`, timeoutMs: 15_000 });
}

/** T5 — crash between data and cursor. In the keystone deterministic-data mode the worker commits the
 *  batch's REAL content (KV `item:i` + checkpoint `payload(salt,i)`) in its own transaction, pauses
 *  at `after-data-commit-before-cursor`, and is SIGKILLed there: the batch's DATA is durable while
 *  its CURSOR advance never ran (durable watermark stays BEHIND — the only safe direction). */
async function injectT5(uri: string, wallet: string, salt: string, batch: number): Promise<void> {
  const h = worker({
    connectionUri: uri, schema: TEST_SCHEMA, hook: "after-data-commit-before-cursor",
    walletId: wallet, networkId: NET, cursorKind: CURSOR_KIND, cursorKey: wallet, cursorValue: batch,
    salt, index: batch, kvNamespace: KV_NS, kvScope: wallet, kvKey: itemKey(batch), kvValue: itemValue(batch),
  });
  const ready = await h.waitForReady(30_000);
  expect(ready.hook).toBe("after-data-commit-before-cursor");
  h.sigkill();
  const exit = await withSuiteWatchdog(h.waitForExit(), { label: `t5-exit-b${batch}`, timeoutMs: 15_000 });
  expect(exit.signal).toBe("SIGKILL");
}

/** Apply batch `i` under its scheduled fault (or drive it fault-free for `none`). */
async function applyBatchUnderFault(uri: string, a: Adapters, wallet: string, salt: string, i: number, fault: Fault): Promise<void> {
  switch (fault) {
    case "none": await driveFullBatch(a, wallet, salt, i); return;
    case "t1": await injectT1(uri, wallet, i); return;
    case "t2": await injectT2(uri, wallet, i); return;
    case "t5": await injectT5(uri, wallet, salt, i); return;
  }
}

/** Re-sync from DURABLE state: read the durable cursor `w` and re-apply every batch at/after it
 *  (`w+1 .. uptoBatch`) through UmbraDB's own adapters — the idempotent resume a consumer performs on
 *  recovery. A `none` batch already advanced its own cursor, so this is a no-op there; a faulted
 *  batch left the cursor behind, so this re-applies exactly the interrupted batch(es). */
async function resyncFromDurableCursor(a: Adapters, wallet: string, salt: string, uptoBatch: number): Promise<void> {
  const w = await withSuiteWatchdog(
    () => a.watermarks.get<number>(CURSOR_KIND, wallet),
    { label: `resync-read-cursor-b${uptoBatch}`, timeoutMs: 10_000 },
  );
  for (let b = (w ?? 0) + 1; b <= uptoBatch; b++) {
    await driveFullBatch(a, wallet, salt, b);
  }
}

/**
 * Runs the whole fault schedule into `wallet`: for each batch, apply its scheduled fault, then
 * re-sync from durable state. `dropRecoveryOfBatch` (negative control) SKIPS the recovery of one
 * batch — genuinely dropping that batch's committed range from the converged state.
 */
async function runFaultSchedule(
  uri: string, wallet: string, salt: string, schedule: readonly Fault[],
  opts: { dropRecoveryOfBatch?: number } = {},
): Promise<void> {
  const a = adaptersFor(uri); // one live "consumer" pool drives the run + its recoveries
  for (let i = 1; i <= schedule.length; i++) {
    await applyBatchUnderFault(uri, a, wallet, salt, i, schedule[i - 1]!);
    if (opts.dropRecoveryOfBatch === i) continue; // NEGATIVE CONTROL: skip recovery => dropped range
    await resyncFromDurableCursor(a, wallet, salt, i);
  }
}

/** The fault-free reference: the SAME batch sequence, driven via UmbraDB's own adapters into a
 *  SEPARATE wallet, with NO fault. Never a copy of the fault run, never an imported store. */
async function runReference(uri: string, wallet: string, salt: string, length: number): Promise<void> {
  const a = adaptersFor(uri);
  for (let b = 1; b <= length; b++) await driveFullBatch(a, wallet, salt, b);
}

// ---- Current-state equality predicate (`design.md` §2.3 / acceptance G4) ----------------------

interface CurrentState {
  /** EXHAUSTIVE: EVERY `kv_current` row for the scope, `JSON.stringify([ns, key])` -> value. Excludes version. */
  kvAll: Record<string, JsonValue>;
  /** EXHAUSTIVE: EVERY `watermarks` row for the cursor key, `kind` -> value. */
  watermarksAll: Record<string, JsonValue>;
  /** Bytes of the latest COMPLETE checkpoint payload. */
  latestPayload: Buffer;
  /** Convenience: the sync-cursor watermark value (derived from {@link watermarksAll}). */
  watermark: number | undefined;
}

/** Read the FULL CURRENT STATE for a wallet from a FRESH client: EVERY kv_current row for the scope
 *  + EVERY watermarks row for the cursor key + the latest complete checkpoint payload. Raw SELECTs
 *  scoped to this run's unique wallet (not an expected-key subset), so the predicate is EXHAUSTIVE.
 *  Deliberately reads NO `version` columns and NO `kv_history` rows (they legitimately diverge on
 *  replay — `council/B` §1 / acceptance G4). */
async function readCurrentState(a: Adapters, wallet: string): Promise<CurrentState> {
  const kvRows = await withSuiteWatchdog(
    a.sql<{ ns: string; key: string; value: JsonValue }[]>`
      SELECT ns, key, value FROM ${a.sql(TEST_SCHEMA)}.kv_current WHERE scope = ${wallet}`,
    { label: "readCurrentState-kv-all", timeoutMs: 10_000 },
  );
  const kvAll: Record<string, JsonValue> = {};
  for (const r of kvRows) kvAll[kvMapKey(r.ns, r.key)] = r.value;

  const wmRows = await withSuiteWatchdog(
    a.sql<{ kind: string; value: JsonValue }[]>`
      SELECT kind, value FROM ${a.sql(TEST_SCHEMA)}.watermarks WHERE key = ${wallet}`,
    { label: "readCurrentState-wm-all", timeoutMs: 10_000 },
  );
  const watermarksAll: Record<string, JsonValue> = {};
  for (const r of wmRows) watermarksAll[r.kind] = r.value;

  const record = await withSuiteWatchdog(() => a.checkpoints.load(wallet, NET), { label: "load-latest", timeoutMs: 15_000 });
  const watermark = watermarksAll[CURSOR_KIND] as number | undefined;
  return { kvAll, watermarksAll, latestPayload: Buffer.from(record.data), watermark };
}

/** The CURRENT-STATE equality predicate: equal iff the FULL kv_current row set agrees, the latest
 *  complete checkpoint payload bytes are identical, and the FULL watermarks row set agrees. An
 *  extra/stale row on ONLY one side falsifies equality (it is not an expected-keys-only check).
 *  `kv_history`/`version` stay excluded (they legitimately diverge on replay — acceptance G4). */
function assertCurrentStateEqual(fault: CurrentState, reference: CurrentState): void {
  expect(fault.kvAll).toEqual(reference.kvAll);                           // (1) FULL kv_current values
  expect(fault.latestPayload.equals(reference.latestPayload)).toBe(true); // (2) latest checkpoint payload bytes
  expect(fault.watermarksAll).toEqual(reference.watermarksAll);          // (3) FULL watermark values
}

// ---- Tolerated-divergence readers (EXCLUDED from the predicate; read only to DEMONSTRATE it) --

async function completeManifestCount(sql: UmbraDBSql, wallet: string): Promise<number> {
  const rows = await withSuiteWatchdog(
    sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(TEST_SCHEMA)}.ckpt_manifests
      WHERE w = ${wallet} AND net = ${NET} AND complete`,
    { label: "completeManifestCount", timeoutMs: 10_000 },
  );
  return rows[0]!.n;
}

async function kvVersion(a: Adapters, wallet: string, key: string): Promise<bigint | null> {
  const entry = await withSuiteWatchdog(() => a.kv.get(KV_NS, wallet, key), { label: "kv-version", timeoutMs: 10_000 });
  return entry === null ? null : entry.version;
}

// ---- Import-cleanliness static audit (acceptance G3 / `design.md` §4 boundary) ---------------

/** Extracts every module specifier a source file imports from — from-clauses, bare side-effect
 *  imports, dynamic imports, and require calls (change-level round-3 BLOCK 4: the old scan saw only
 *  from-clauses, so a bare/dynamic/require import of a foreign module evaded it). NOTE: the quoted
 *  specifier shapes are written only as regexes below, never spelled out in prose here, because this
 *  file audits its OWN source text and a comment example would be mistaken for a real import. */
function importedSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,                 // from-clause
    /\bimport\s+["']([^"']+)["']/g,               // bare side-effect import
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import()
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, // require()
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) specs.push(m[1]!);
  return specs;
}

/** Resolves a relative `.js`/`.mjs` specifier (as written in ESM source) to the on-disk `.ts`/`.mts`
 *  module it refers to, so the reference module's own import CLOSURE can be re-scanned. Returns
 *  undefined for a bare/non-relative specifier (nothing in-repo to walk). */
function resolveRelativeTs(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, base.replace(/\.js$/, ".ts"), base.replace(/\.mjs$/, ".mts"), `${base}.ts`, resolve(base, "index.ts")];
  for (const c of candidates) if (existsSync(c)) return c;
  return undefined;
}

// =============================================================================================
describe("G11 differential state-equivalence — a seeded fault schedule (T1/T2/T5) is current-state-equivalent to a fault-free in-repo reference (design.md §5)", () => {
  // ---- 6.2 the fault-schedule equivalence gate (the required id lives on THIS test) ----------
  it("[[differential.fault-schedule.state-equivalent]] a SEEDED schedule mixing T1/T2/T5 across write batches, re-syncing from durable state after each fault, converges to a current state EQUAL (current-state predicate) to a fault-free reference run of the same schedule; kv_history/version/seq divergence is tolerated and shown", async () => {
    const uri = connectionUri();
    const salt = randomUUID();
    const schedule = buildSchedule(SEED, SCHEDULE_LENGTH);

    // Reproducibility evidence: the schedule is a pure function of SEED (deterministic; no Math.random).
    // eslint-disable-next-line no-console
    console.log(`[differential] seed=0x${(SEED >>> 0).toString(16)} length=${SCHEDULE_LENGTH} schedule=[${schedule.join(",")}]`);
    // Sanity: the seeded schedule genuinely MIXES all three faults (so the gate exercises each).
    expect(schedule).toContain("t1");
    expect(schedule).toContain("t2");
    expect(schedule).toContain("t5");

    const faultW = `diff-fault-${randomUUID()}`;
    const refW = `diff-ref-${randomUUID()}`;

    // FAULT RUN: apply each batch under its fault, then re-sync from durable state.
    await runFaultSchedule(uri, faultW, salt, schedule);
    // FAULT-FREE REFERENCE: the same sequence via UmbraDB's own adapters, no fault.
    await runReference(uri, refW, salt, schedule.length);

    // ---- CURRENT-STATE EQUALITY (from FRESH clients) -----------------------------------------
    const faultState = await readCurrentState(adaptersFor(uri), faultW);
    const refState = await readCurrentState(adaptersFor(uri), refW);
    assertCurrentStateEqual(faultState, refState);

    // Spell the convergence out: the cursor is fully advanced on BOTH, and the FULL kv_current state
    // is exactly item:1..N (an EXHAUSTIVE check — an extra/stale key would fail this too).
    const expectedKv: Record<string, JsonValue> = {};
    for (let b = 1; b <= schedule.length; b++) expectedKv[kvMapKey(KV_NS, itemKey(b))] = itemValue(b);
    expect(faultState.watermark).toBe(schedule.length);
    expect(refState.watermark).toBe(schedule.length);
    expect(faultState.kvAll).toEqual(expectedKv);
    expect(faultState.latestPayload.equals(payload(salt, schedule.length))).toBe(true);

    // ---- EXHAUSTIVENESS of the predicate (no DB mutation) — a stale/extra kv_current row OR an
    //      extra watermark present on ONLY one side breaks equality. --------------------------------
    expect(() => assertCurrentStateEqual(
      { ...faultState, kvAll: { ...faultState.kvAll, [kvMapKey(KV_NS, "item:stale")]: { batch: 999 } } },
      refState,
    )).toThrow();
    expect(() => assertCurrentStateEqual(
      { ...faultState, watermarksAll: { ...faultState.watermarksAll, "stale-kind": 7 } },
      refState,
    )).toThrow();

    // ---- TOLERATED DIVERGENCE (EXCLUDED from the predicate) — asserted explicitly so the exclusion
    //      is real, not hand-waved (`council/B` §1). The fault run re-applied faulted batches on
    //      recovery, producing MORE complete checkpoint manifests than the fault-free reference, and
    //      HIGHER kv `version` counters (+ spurious kv_history rows) for any re-applied key — while
    //      the current-state VALUES converge. ------------------------------------------------------
    const faultManifests = await completeManifestCount(getSql(), faultW);
    const refManifests = await completeManifestCount(getSql(), refW);
    expect(faultManifests).toBeGreaterThan(refManifests); // extra manifests from crashes + recovery

    // The first T5 batch's KV datum was written twice on the fault side (worker commit + recovery
    // re-apply) but once on the reference — so its version DIVERGES while its VALUE converges.
    const firstT5 = schedule.findIndex((f) => f === "t5") + 1;
    const faultVer = await kvVersion(adaptersFor(uri), faultW, itemKey(firstT5));
    const refVer = await kvVersion(adaptersFor(uri), refW, itemKey(firstT5));
    expect(Number(faultVer)).toBeGreaterThan(Number(refVer)); // version chain diverges (re-applied)
    expect(faultState.kvAll[kvMapKey(KV_NS, itemKey(firstT5))])
      .toEqual(refState.kvAll[kvMapKey(KV_NS, itemKey(firstT5))]); // ...but the current VALUE converges
  }, 240_000);

  // ---- 6.2 NEGATIVE CONTROL (mandatory) — the check has teeth ---------------------------------
  it("[[differential.fault-schedule.negative-control-fires]] negative control: a deliberately-broken variant that genuinely DROPS a committed range (skips one faulted batch's recovery step) makes the current-state equivalence assertion FIRE", async () => {
    const uri = connectionUri();
    const salt = randomUUID();
    // A small deterministic schedule with a data-dropping T1 fault on batch 2, whose recovery we skip.
    const schedule: Fault[] = ["none", "t1", "none"];
    const dropBatch = 2;
    const brokenW = `diff-neg-${randomUUID()}`;
    const refW = `diff-neg-ref-${randomUUID()}`;

    // BROKEN fault run: batch 2 (T1) commits nothing AND its recovery is skipped, so item:2 never
    // lands and the cursor marches past it — a genuine dropped committed range in the durable state.
    await runFaultSchedule(uri, brokenW, salt, schedule, { dropRecoveryOfBatch: dropBatch });
    await runReference(uri, refW, salt, schedule.length);

    const brokenState = await readCurrentState(adaptersFor(uri), brokenW);
    const refState = await readCurrentState(adaptersFor(uri), refW);

    // GENUINE DROP confirmed in the real durable state (not a synthetic in-memory tweak).
    expect(brokenState.kvAll[kvMapKey(KV_NS, itemKey(dropBatch))]).toBeUndefined();
    expect(refState.kvAll[kvMapKey(KV_NS, itemKey(dropBatch))]).toEqual(itemValue(dropBatch));

    // THE CHECK HAS TEETH: the SAME current-state equality assertion the positive test relies on
    // FIRES (throws) on this real divergence — so it would catch a fault that dropped a range.
    expect(() => assertCurrentStateEqual(brokenState, refState)).toThrow();
  }, 180_000);

  // ---- 6.2 import-cleanliness of the reference side (acceptance G3 / `design.md` §4 boundary) --
  it("[[differential.reference.import-clean]] the reference side imports NOTHING outside the repo (direct AND through its relative-import closure) — no foreign consumer/indexer/wallet application, via a scan that also catches bare/dynamic/require imports", () => {
    const FORBIDDEN = /@midnightntwrk|indexer|consumer|wallet-sdk|mongo/i;
    const selfPath = fileURLToPath(import.meta.url);
    const source = readFileSync(selfPath, "utf8");
    const specs = importedSpecifiers(source);
    expect(specs.length).toBeGreaterThan(5); // the audit actually parsed this file's imports

    // Every DIRECT import is either a node builtin, an IN-REPO relative path, or a sanctioned
    // test-infra devDependency. NOTHING is a foreign consumer/indexer/wallet application.
    const ALLOWED_BARE = new Set(["vitest", "@testcontainers/postgresql", "fast-check"]);
    const offenders: string[] = [];
    for (const s of specs) {
      const inRepo = s.startsWith("node:") || s.startsWith("./") || s.startsWith("../") || ALLOWED_BARE.has(s);
      if (!inRepo) offenders.push(s);
    }
    expect(offenders, `reference side must import nothing outside the repo; offending specifiers: ${offenders.join(", ")}`).toEqual([]);

    // Explicit boundary guard on the DIRECT specifiers: never the extracted-from consumer / indexer /
    // wallet SDK — the scan above also covers bare, dynamic and require imports of a foreign module.
    for (const s of specs) {
      expect(s, `forbidden foreign import: ${s}`).not.toMatch(FORBIDDEN);
    }
    // Every relative import resolves under src/ or the test tree (in-repo) — none escapes the repo.
    for (const s of specs) {
      if (s.startsWith(".")) {
        expect(s, `relative import must stay in-repo: ${s}`).toMatch(/^\.\.?\/(?:\.\.\/)*(src|test)\/|^\.\/setup\.js$/);
      }
    }

    // CLOSURE (change-level round-3 BLOCK 4): a relative helper could itself import the foreign
    // consumer/indexer. Walk the reference module's own relative imports ONE level and re-scan each —
    // rejecting any @midnightntwrk/indexer/consumer/wallet specifier reachable through that closure.
    let closureScanned = 0;
    for (const s of specs) {
      const dep = resolveRelativeTs(selfPath, s);
      if (dep === undefined) continue;
      closureScanned += 1;
      for (const d of importedSpecifiers(readFileSync(dep, "utf8"))) {
        expect(d, `reference dependency ${s} pulls in forbidden ${d}`).not.toMatch(FORBIDDEN);
      }
    }
    expect(closureScanned, "at least one relative reference dependency must be closure-scanned").toBeGreaterThan(0);
  });

  // ---- 6.2 injective current-state key encoding (change-level round-3 BLOCK 2) -----------------
  it("injective kv-map key: colliding (ns,key) tuples the OLD `${ns} ${key}` space-join merged are now DISTINCT and detected as unequal", () => {
    // The OLD non-injective encoding collapsed these two DISTINCT tuples to the same string:
    const oldEncode = (ns: string, key: string): string => `${ns} ${key}`;
    expect(oldEncode("a b", "c")).toBe(oldEncode("a", "b c")); // "a b c" === "a b c" — the collision
    // The NEW injective encoding keeps them apart:
    expect(kvMapKey("a b", "c")).not.toBe(kvMapKey("a", "b c"));
    // ...so the shared predicate now CATCHES a divergence the old encoding hid: two current states with
    // GENUINELY different kv_current row sets that both encoded to {"a b c": v} under the space-join.
    const left: CurrentState = { kvAll: { [kvMapKey("a b", "c")]: { batch: 1 } }, watermarksAll: {}, latestPayload: Buffer.alloc(0), watermark: undefined };
    const right: CurrentState = { kvAll: { [kvMapKey("a", "b c")]: { batch: 1 } }, watermarksAll: {}, latestPayload: Buffer.alloc(0), watermark: undefined };
    expect(() => assertCurrentStateEqual(left, right)).toThrow();
    // Sanity: identical tuple sets remain equal.
    expect(() => assertCurrentStateEqual(left, { ...left, kvAll: { ...left.kvAll } })).not.toThrow();
  });
});
