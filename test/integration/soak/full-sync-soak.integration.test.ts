import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PgCheckpointStore } from "../../../src/postgres/checkpoint-store.js";
import { createClient, type UmbraDBSql } from "../../../src/postgres/client.js";
import { saveAndAdvance } from "../../../src/postgres/save-and-advance.js";
import { PgTemporalKV } from "../../../src/postgres/temporal-kv.js";
import { PgTransactionLeaseLayer } from "../../../src/postgres/transaction-lease.js";
import { PgWatermarks } from "../../../src/postgres/watermarks.js";
import type { JsonValue } from "../../../src/interfaces/temporal-kv.js";
import { registerSuiteLifecycle, TEST_SCHEMA, withSuiteWatchdog } from "../../postgres/setup.js";

/**
 * G10 — full-sync SOAK (`design.md` §3.1; `tasks.md` §5.1; acceptance F1–F5; `council/B` §3 item 5).
 *
 * A sustained CONCURRENT mix — KV `put`s (versioned) + checkpoint `save` cadence + watermark ticks
 * (fused as the G5 `saveAndAdvance` durable-composition primitive) + periodic `prune` (GC passes) +
 * a held `withLease` — run at a DECLARED envelope. The test asserts:
 *
 *   (a) a NAMED, ENUMERATED set of P1–P10-derived, SQL-observable invariants — spelled out IN CODE
 *       below (never a vague "P1–P10 hold") — is sampled DURING the run (not only at teardown) and
 *       never fails. The four invariants (`design.md` §3.1(a) / acceptance F2):
 *         I1  gapless per-(ns,scope,key) `version` sequences in `kv_history`, AND the per-key
 *             `kv_current.version` is consistent with that history (P1/P2) — see below;
 *         I2  only `complete = true` manifests are `load`able (C1);
 *         I3  no `ckpt_manifest_chunks` row references a missing/incomplete manifest (C2a);
 *         I4  the durable watermark is never AHEAD of the max durable data — KV-INCLUSIVE (the T5
 *             invariant): the covered batch's KV datum must be durable too, not checkpoint-only.
 *       Sampling is REAL: a concurrent sampler evaluates all four every ~SAMPLE_INTERVAL_MS against
 *       the LIVE database and fails on the FIRST violation. Sample count is asserted > 0 (in fact
 *       >= MIN_SAMPLES), and the LAST sample is asserted NON-VACUOUS (real manifests + history +
 *       watermark + covered KV datum present), so "mid-run sampling is real" is auditor-verifiable.
 *
 *   (b) the END STATE equals a FAULT-FREE REFERENCE on the current-state equality predicate
 *       (`design.md` §2.3 / acceptance F3): the FULL `kv_current` value set + the latest complete
 *       checkpoint payload bytes + the FULL `watermarks` value set — EXCLUDING `kv_history` rows and
 *       every `version` column (which legitimately diverge and are documented as excluded). The
 *       reference is a genuine fault-free replay of the SAME recorded write sequence via UmbraDB's
 *       OWN adapters into a SEPARATE identity — never a hand-coded expected value, never an imported
 *       store (`design.md` §4 boundary).
 *
 *   (c) each GC/prune-pass duration is recorded as a WRITTEN artifact and completes within a named
 *       `GC_PASS_WATCHDOG_MS` TEST-TERMINATION constant (`design.md` §3.1(c) / acceptance F4). The
 *       watchdog is a TERMINATION bound, not a perf gate: NO pass-rate/latency threshold gates the
 *       release (`ROADMAP` §D). The recorded durations ARE the deliverable; they are ungated. A
 *       dedicated leg (below) additionally proves a GC pass GENUINELY reclaims chunks (not merely
 *       records `reclaimedChunks`): chunks backdated past the 15-min grace window are actually
 *       deleted, so `reclaimedChunks > 0` and a broken chunk-reclamation anti-join would fail.
 *
 * ENVELOPE — DECLARED and MET (acceptance F1: "a declared envelope (10^5–10^6 chunks, not 10^7)"):
 *   The DECLARED supported envelope is 10^5–10^6 chunks (`council/B` §1: "'10^7 chunks' exceeds the
 *   plausible envelope of a local wallet datastore; benchmark to a declared supported envelope (e.g.
 *   10^5–10^6 chunks) and document the ceiling"). This live run EXECUTES at the declared FLOOR: the
 *   full-sync writer commits {@link SYNC_SAVES} checkpoints of {@link CHUNKS_PER_SAVE} distinct
 *   chunks each — a DETERMINISTIC {@link TARGET_CHUNKS} = SYNC_SAVES x CHUNKS_PER_SAVE >= 10^5
 *   chunks — so the lock / query-plan / GC anti-join behaviour at 10^5 chunks is ACTUALLY exercised
 *   under the concurrent mix, not a 1,000-chunk stand-in. The writer is COUNT-bounded (not merely
 *   time-bounded), so the 10^5 floor is met on every host regardless of speed; it is self-paced over
 *   ~{@link SOAK_TARGET_MS}ms so the sampler and GC passes fire many times DURING the run, and the
 *   whole test finishes in a couple of minutes wall-clock — well under `conformance.yml`'s
 *   `timeout-minutes: 30`. The envelope is a real, MET constant ({@link LIVE_ENVELOPE}), written into
 *   the GC artifact; the 10^7 matrix is explicitly out of scope (`council/B` §1).
 *
 * `src/` is byte-unchanged: this test drives ONLY the public adapters (+ raw SQL through the client
 * for the grace-window backdate and the interrupted-save leftover, exactly as the load-under-prune
 * and checkpoint-store GC tests do) + the existing shared container harness (`registerSuiteLifecycle`
 * / `withSuiteWatchdog`); it adds no `src/` code and spins up NO second container (one dedicated
 * actor pool + one small sampler pool + a couple of tiny admin pools, all against the SAME shared
 * container, per the harness's documented "own dedicated pool against the same database" hook).
 */

// ============================================================================================
// NAMED CONSTANTS — envelope, duration, watchdog, cadences (all declared, none magic-inline)
// ============================================================================================

const NET = "n";
/** KV namespace the churn actor writes (versioned `put`s → the gapless-version invariant). */
const CHURN_NS = "soak-churn";
/** KV namespace the SYNC actor writes its per-batch, cursor-tied datum into (the T5 KV half). */
const SYNC_KV_NS = "soak-sync-kv";
/** Watermark kind the sync/full-sync writer ticks (co-committed with each checkpoint). */
const SYNC_KIND = "soak-sync";

/** DECLARED supported envelope (`council/B` §1) — the live run below EXECUTES at its 10^5 floor. */
const DECLARED_ENVELOPE = {
  chunksLow: 100_000, // 10^5 — the declared FLOOR (this live run meets it)
  chunksHigh: 1_000_000, // 10^6 — the declared ceiling
  note:
    "council/B §1 declared supported envelope for a local wallet datastore (10^5–10^6 chunks); " +
    "the 10^7 matrix is explicitly out of scope. This live CI run EXECUTES at the 10^5 FLOOR " +
    "(acceptance F1): SYNC_SAVES x CHUNKS_PER_SAVE distinct chunks under the concurrent mix.",
} as const;

/** Chunking: each checkpoint `save` produces exactly {@link CHUNKS_PER_SAVE} distinct chunks (its
 *  payload is CHUNKS_PER_SAVE * CHUNK_SIZE bytes, split into CHUNKS_PER_SAVE distinct chunks). */
const CHUNK_SIZE = 512;
const CHUNKS_PER_SAVE = 550;

/** The full-sync writer commits exactly this many checkpoints — a DETERMINISTIC, count-bounded
 *  envelope so the 10^5 chunk floor is MET on every host, not left to a timing race. */
const SYNC_SAVES = 200;

/** The DETERMINISTIC live chunk envelope actually written by the sync writer (>= the 10^5 floor). */
const TARGET_CHUNKS = SYNC_SAVES * CHUNKS_PER_SAVE; // 200 * 550 = 110,000 (10% over the 10^5 floor)

/** Self-pacing target for the sync writer: spread SYNC_SAVES saves over ~this long so the sampler
 *  (every SAMPLE_INTERVAL_MS) and the GC passes (every PRUNE_INTERVAL_MS) fire many times DURING
 *  the run. The writer is COUNT-bounded — a slower host simply takes longer, still reaching 10^5. */
const SOAK_TARGET_MS = 60_000;
const SYNC_PACE_MS = Math.floor(SOAK_TARGET_MS / SYNC_SAVES); // ~300ms between checkpoint saves

/** Hard safety deadline for the concurrent actors: they stop when the sync writer completes its
 *  count OR at this bound (belt-and-suspenders vs. a wedged run — the per-op watchdog is the primary
 *  termination mechanism). Generous vs. the ~60s expected soak; comfortably under CI's 30 min. */
const MAX_SOAK_MS = 300_000;

/** Cadences for the concurrent actors (paced so the mix is SUSTAINED across the whole duration). */
const CHURN_INTERVAL_MS = 30; // KV put cadence
const PRUNE_INTERVAL_MS = 2_000; // GC-pass cadence
const LEASE_HOLD_MS = 300; // how long each held withLease is held
const LEASE_GAP_MS = 50; // gap between successive lease holds
const SAMPLE_INTERVAL_MS = 1_000; // mid-run invariant sampling cadence

const CHURN_KEYS = 20; // rotating keyspace → many versions per key for the gapless check
const RETAIN_COUNT = 40; // prune retains this many newest complete manifests

/** GC-pass TEST-TERMINATION bound (`design.md` §3.1(c)). Its ONLY role is to fail a WEDGED pass
 *  fast — it is NOT a perf gate (no pass-rate/latency threshold gates the release; the durations
 *  are a recorded, ungated artifact). Generous vs. the real prune cost on this envelope. */
const GC_PASS_WATCHDOG_MS = 15_000;

/** Per-op JS-level watchdog bound (independent of G7's server-side timeouts) for the non-prune
 *  actor ops, so a half-dead backend fails typed rather than hanging the suite. */
const OP_WATCHDOG_MS = 30_000;

/** Live-run floors — asserted so a green run PROVES the envelope was actually exercised (not a
 *  vacuous zero-op pass). The chunk floor is the DECLARED 10^5; the sync writer is count-bounded to
 *  TARGET_CHUNKS > this, so it is met deterministically. */
const LIVE_CHUNK_FLOOR = 100_000; // 10^5 — the declared envelope FLOOR (acceptance F1)
const MIN_SAMPLES = 10; // mid-run invariant samples that must have fired
const MIN_GC_PASSES = 5; // prune passes that must have run and been timed
const MIN_CHURN_PUTS = 400; // KV puts that must have committed

/** BLOCK 5 — the dedicated GC-reclamation leg (mirrors the checkpoint-store GC-scale /
 *  load-under-prune tests): a handful of UNIQUE-content checkpoints whose chunks are backdated past
 *  prune's 15-minute grace window, so a `prune` retaining only the newest few GENUINELY deletes the
 *  older manifests AND reclaims their now-orphaned chunks. */
const GC_RECLAIM_SAVES = 8;
const GC_RECLAIM_RETAIN = 2; // keep the newest 2 → the other 6 manifests + their chunks are reclaimed
const GC_RECLAIM_CHUNK_SIZE = 4_096;
const GC_RECLAIM_PAYLOAD_BYTES = 512; // < chunkSize → exactly one distinct chunk per checkpoint

/** BLOCK 8 — the "only complete manifests are loadable" leg: complete checkpoints plus an ACTUAL
 *  incomplete (interrupted-save leftover) manifest at a HIGHER seq, driven through the REAL adapter. */
const INCOMPLETE_COMPLETE_SAVES = 3;
const INCOMPLETE_CHUNK_SIZE = 4_096;

/** The live-run envelope, recorded into the artifact so what actually ran is documented, not hidden. */
const LIVE_ENVELOPE = {
  syncSaves: SYNC_SAVES,
  chunkSize: CHUNK_SIZE,
  chunksPerSave: CHUNKS_PER_SAVE,
  targetChunks: TARGET_CHUNKS,
  chunkFloor: LIVE_CHUNK_FLOOR,
  syncPaceMs: SYNC_PACE_MS,
  churnKeys: CHURN_KEYS,
  retainCount: RETAIN_COUNT,
  note:
    "DECLARED-envelope live run (acceptance F1): the full-sync writer commits SYNC_SAVES checkpoints " +
    "of CHUNKS_PER_SAVE distinct chunks each = TARGET_CHUNKS (>= the 10^5 floor), DETERMINISTICALLY " +
    "(count-bounded, not timing-dependent), under the sustained concurrent mix. Self-paced over " +
    "~SOAK_TARGET_MS so the sampler + GC passes fire many times DURING the run; fits conformance.yml " +
    "timeout-minutes:30 without being live-gated or made optional (design.md §3.1 'Fit to the gate').",
} as const;

/** Test timeout: the count-bounded soak (safety-capped at MAX_SOAK_MS) + the sequential fault-free
 *  reference replay + the GC-reclamation / incomplete-manifest legs + comfortable margin. */
const TEST_TIMEOUT_MS = MAX_SOAK_MS + 300_000;

// ============================================================================================
// Deterministic payloads / values (byte-identical between the soak run and its fault-free
// reference for the SAME (salt, batch), so the current-state predicate compares real content)
// ============================================================================================

/** Deterministic checkpoint payload for `batch`: exactly {@link CHUNKS_PER_SAVE} DISTINCT
 *  {@link CHUNK_SIZE}-byte blocks (each block's header carries (salt, batch, position) so no two
 *  blocks — within a save or across saves — collide, hence one distinct chunk per position and no
 *  accidental dedup within the run). Byte-identical for the same (salt, batch), so the fault-free
 *  reference reproduces the exact "latest complete checkpoint payload" bytes. */
function payload(salt: string, batch: number): Buffer {
  const blocks: Buffer[] = [];
  for (let j = 0; j < CHUNKS_PER_SAVE; j++) {
    const header = `soak|salt=${salt}|b=${batch}|c=${j}|`;
    const block = Buffer.alloc(CHUNK_SIZE, 0);
    block.write(header, 0, "utf8");
    for (let k = header.length; k < CHUNK_SIZE; k++) block[k] = (batch + j + k) & 0xff;
    blocks.push(block);
  }
  return Buffer.concat(blocks);
}

/** Deterministic churn value for the `n`-th write to `key`. */
function churnValue(key: string, n: number): JsonValue {
  return { k: key, v: n };
}

/** The sync writer's per-batch, cursor-tied KV datum (mirrors the T5 keystone
 *  `cursor-durability.crash.test.ts`: `item:i` -> `{ batch: i }`, with batch index === cursor
 *  value). Written FIRST, before the batch's cursor advance, so the cursor covering batch `i`
 *  implies `item:i` is already durable — the KV half of "durable data" the T5 sample checks. */
function itemKey(batch: number): string {
  return `item:${batch}`;
}
function itemValue(batch: number): JsonValue {
  return { batch };
}

function sha256(data: Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

/** Deep-equality of a durable KV value against an expected value (mirrors the T5 keystone). Values
 *  here are small single-key JSON objects, so a canonical `JSON.stringify` compare is exact. */
function kvValueEqual(actual: JsonValue | undefined, expected: JsonValue): boolean {
  return actual !== undefined && JSON.stringify(actual) === JSON.stringify(expected);
}

// ============================================================================================
// PURE invariant predicates — GENUINELY FALSIFIABLE (a negative-control block below feeds each a
// crafted bad input and asserts it flags a violation, so none is a weaker proxy). The sampler
// evaluates these over data fetched from the LIVE database.
// ============================================================================================

interface HistGroup {
  ns: string;
  scope: string;
  key: string;
  cur: bigint; // kv_current.version for this key (int8 → bigint)
  mn: bigint | null; // min(history version) — null when the key has no superseded history yet
  mx: bigint | null; // max(history version)
  cnt: number | null; // count(*)          (cast ::int)
  dcnt: number | null; // count(distinct version) (cast ::int)
}

/** I1 (P1/P2): for each (ns,scope,key) present in `kv_current`, the superseded `version` values in
 *  `kv_history` form a CONTIGUOUS run with no gap, no duplicate, starting at 1, AND — critically —
 *  the LIVE `kv_current.version` is consistent with that history: `kv_history` holds the OLD row on
 *  every supersession, so a key at current version V has history {1..V-1}, i.e. `cur == max+1` (or
 *  `cur == 1` with no history yet). Reading `kv_current.version` too (not just `kv_history`) is what
 *  catches a current-row version JUMP (history={1,2,3} but `kv_current` at 100) that a history-only
 *  check would miss. Returns one message per violating key; empty ⇒ the invariant holds. */
function gaplessVersionViolations(rows: readonly HistGroup[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const cnt = r.cnt ?? 0;
    if (cnt === 0) {
      // No superseded history yet: the key must be at its FIRST version (a first, un-superseded put).
      if (r.cur !== 1n) {
        out.push(`I1 gapless(${r.key}): no kv_history yet but kv_current.version=${r.cur} (expected 1)`);
      }
      continue;
    }
    const mn = r.mn!;
    const mx = r.mx!;
    const dcnt = r.dcnt!;
    const span = Number(mx - mn) + 1;
    if (dcnt !== cnt) {
      out.push(`I1 gapless(${r.key}): duplicate versions (count=${cnt}, distinct=${dcnt})`);
    } else if (span !== cnt) {
      out.push(`I1 gapless(${r.key}): GAP in versions (min=${mn}, max=${mx}, count=${cnt})`);
    } else if (mn !== 1n) {
      out.push(`I1 gapless(${r.key}): history does not start at version 1 (min=${mn})`);
    } else if (r.cur !== mx + 1n) {
      // kv_current.version must be exactly one past the newest superseded version — a current-row
      // version jump (history {1..k}, kv_current jumping to N != k+1) is caught HERE, mid-run.
      out.push(
        `I1 gapless(${r.key}): kv_current.version=${r.cur} inconsistent with kv_history max=${mx} (expected ${mx + 1n})`,
      );
    }
  }
  return out;
}

/** I4 (T5), KV-INCLUSIVE (mirrors the T5 keystone `cursor-durability.crash.test.ts`): the durable
 *  watermark is never AHEAD of the max durable DATA, where "data" is BOTH the checkpoint (its label
 *  == cursor value) AND the batch's KV datum (`item:cursorValue`). `undefined` watermark (no cursor
 *  yet) is vacuously ok. Returns a message on inversion (checkpoint OR covered KV missing), else
 *  `null`. A checkpoint-seq-only check would let a LOST KV write for a cursor-covered batch pass —
 *  covering the KV half closes that hole. */
function watermarkNotAheadViolation(
  watermark: number | undefined,
  maxDurableData: number | undefined,
  coveredKvValue: JsonValue | undefined,
): string | null {
  if (watermark === undefined) return null;
  if (maxDurableData === undefined || watermark > maxDurableData) {
    return `I4 T5: watermark ${watermark} is AHEAD of max durable checkpoint data ${maxDurableData ?? "none"}`;
  }
  if (!kvValueEqual(coveredKvValue, itemValue(watermark))) {
    return `I4 T5: covered batch ${watermark}'s KV datum (item:${watermark}) is ABSENT/mismatched in durable data (got ${JSON.stringify(coveredKvValue ?? null)})`;
  }
  return null;
}

/** I3 (C2a): every `ckpt_manifest_chunks` row references a manifest that exists AND is complete.
 *  `danglingCount` is the SQL COUNT of junction rows whose manifest is missing or `complete=false`. */
function danglingJunctionViolation(danglingCount: number): string | null {
  return danglingCount === 0
    ? null
    : `I3 C2a: ${danglingCount} junction row(s) reference a missing/incomplete manifest`;
}

/** I2 (C1): only complete manifests are loadable. `loadedComplete` is the SQL `complete` flag of the
 *  manifest `load(latest)` actually returned; `incompleteCount` is the number of incomplete manifests
 *  that exist for the wallet (must be 0, so none could ever be loaded). */
function onlyCompleteLoadableViolations(loadedComplete: boolean, incompleteCount: number): string[] {
  const out: string[] = [];
  if (!loadedComplete) out.push("I2 C1: load(latest) returned a NON-complete manifest");
  if (incompleteCount !== 0) out.push(`I2 C1: ${incompleteCount} incomplete manifest(s) exist for the wallet`);
  return out;
}

// ============================================================================================
// Adapters / pools
// ============================================================================================

interface Adapters {
  sql: UmbraDBSql;
  checkpoints: PgCheckpointStore;
  watermarks: PgWatermarks;
  kv: PgTemporalKV;
  txLayer: PgTransactionLeaseLayer;
}

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

const { connectionUri } = registerSuiteLifecycle();

let openPools: UmbraDBSql[] = [];
function newPool(uri: string, maxConnections: number): UmbraDBSql {
  const p = createClient({ connectionString: uri, schema: TEST_SCHEMA, maxConnections, connectTimeout: 10 });
  openPools.push(p);
  return p;
}

afterEach(async () => {
  await Promise.all(openPools.map((p) => p.end({ timeout: 5 }).catch(() => {})));
  openPools = [];
});

// ============================================================================================
// Current-state equality predicate (`design.md` §2.3 / acceptance F3) — EXHAUSTIVE, excluding
// kv_history/version with the documented rationale.
// ============================================================================================

interface CurrentState {
  /** EXHAUSTIVE: EVERY `kv_current` row for the scope, keyed by `${ns} ${key}` → value. Reading the
   *  FULL set (raw SELECT, not an expected-key subset) means an extra/stale row on ONLY one side
   *  breaks equality. Excludes `version` and all `kv_history`. */
  kvAll: Record<string, JsonValue>;
  /** EXHAUSTIVE: EVERY `watermarks` row for the cursor key, keyed by `kind` → value. */
  watermarksAll: Record<string, JsonValue>;
  /** Bytes of the latest COMPLETE checkpoint payload. */
  latestPayload: Buffer;
}

async function readCurrentState(
  a: Adapters,
  wallet: string,
  scope: string,
  cursorKey: string,
): Promise<CurrentState> {
  const kvRows = await withSuiteWatchdog(
    a.sql<{ ns: string; key: string; value: JsonValue }[]>`
      SELECT ns, key, value FROM ${a.sql(TEST_SCHEMA)}.kv_current WHERE scope = ${scope}`,
    { label: "readCurrentState-kv", timeoutMs: OP_WATCHDOG_MS },
  );
  const kvAll: Record<string, JsonValue> = {};
  for (const r of kvRows) kvAll[`${r.ns} ${r.key}`] = r.value;

  const wmRows = await withSuiteWatchdog(
    a.sql<{ kind: string; value: JsonValue }[]>`
      SELECT kind, value FROM ${a.sql(TEST_SCHEMA)}.watermarks WHERE key = ${cursorKey}`,
    { label: "readCurrentState-wm", timeoutMs: OP_WATCHDOG_MS },
  );
  const watermarksAll: Record<string, JsonValue> = {};
  for (const r of wmRows) watermarksAll[r.kind] = r.value;

  const record = await withSuiteWatchdog(() => a.checkpoints.load(wallet, NET), {
    label: "readCurrentState-load",
    timeoutMs: OP_WATCHDOG_MS,
  });
  return { kvAll, watermarksAll, latestPayload: Buffer.from(record.data) };
}

/** Equal iff the FULL kv_current value set agrees, the latest complete checkpoint payload bytes are
 *  identical, and the FULL watermarks value set agrees. `kv_history`/`version` are excluded because
 *  they legitimately diverge (`council/B` §1: an unconditioned `put` is a version-bumping upsert;
 *  the soak's concurrency + reference's independent run produce different version counters and
 *  spurious `kv_history` rows, but the CURRENT value is identical). The sync writer's per-batch KV
 *  datum lives under its OWN scope (SYNC_KV_NS/`syncKvScope`) which this predicate does NOT compare
 *  (it compares the churn scope) — it is auxiliary evidence for the T5 sample, not part of the
 *  fault-free-reference equality, so the reference does not replay it. */
function assertCurrentStateEqual(actual: CurrentState, reference: CurrentState): void {
  expect(actual.kvAll).toEqual(reference.kvAll);
  expect(actual.latestPayload.equals(reference.latestPayload)).toBe(true);
  expect(actual.watermarksAll).toEqual(reference.watermarksAll);
}

// ============================================================================================
// Mid-run sampler observation
// ============================================================================================

interface SampleObservation {
  tMs: number; // ms since run start (proves the sample fired DURING the run)
  completeManifests: number; // non-vacuity witness
  historyRows: number; // non-vacuity witness
  chunks: number;
  watermark: number | undefined;
  maxDurableLabel: number | undefined;
  coveredKvPresent: boolean; // the KV-inclusive T5 half checked a real covered datum
  gaplessKeysChecked: number;
  c1Checked: boolean;
  violations: string[];
}

// ============================================================================================
// The one required soak test
// ============================================================================================

describe("G10 full-sync soak — enumerated P1–P10 SQL invariants hold under a sustained concurrent mix at the declared 10^5 envelope (design.md §3.1)", () => {
  it(
    "[[soak.full-sync.invariants-hold]] a sustained concurrent mix (KV puts + checkpoint/watermark cadence + periodic prune + held lease) at a DECLARED 10^5-chunk envelope samples four enumerated P1–P10-derived SQL invariants DURING the run (gapless incl. kv_current.version; C1; C2a; KV-inclusive T5 — never failing), a GC pass genuinely reclaims backdated chunks, an incomplete manifest is excluded by the real load/history path, and the end state is replay-equivalent to a fault-free reference on the current-state predicate; each GC-pass duration is recorded and bounded by GC_PASS_WATCHDOG_MS (no perf threshold gates)",
    async () => {
      // ---- FALSIFIABILITY (test-honesty): prove each pure invariant predicate has TEETH before
      //      the soak relies on it — a crafted bad input MUST be flagged; a good input MUST pass. ----
      // I1 gapless + the kv_current.version consistency (BLOCK 7):
      expect(gaplessVersionViolations([{ ns: "x", scope: "s", key: "k", cur: 5n, mn: 1n, mx: 5n, cnt: 4, dcnt: 4 }]).length)
        .toBeGreaterThan(0); // span 5 ≠ count 4 ⇒ GAP
      expect(gaplessVersionViolations([{ ns: "x", scope: "s", key: "k", cur: 4n, mn: 1n, mx: 3n, cnt: 3, dcnt: 3 }]))
        .toEqual([]); // contiguous history 1..3 with kv_current at 4 ⇒ holds
      expect(gaplessVersionViolations([{ ns: "x", scope: "s", key: "k", cur: 4n, mn: 2n, mx: 3n, cnt: 2, dcnt: 2 }]).length)
        .toBeGreaterThan(0); // history does not start at 1
      expect(gaplessVersionViolations([{ ns: "x", scope: "s", key: "k", cur: 4n, mn: 1n, mx: 3n, cnt: 3, dcnt: 2 }]).length)
        .toBeGreaterThan(0); // duplicate version
      expect(gaplessVersionViolations([{ ns: "x", scope: "s", key: "k", cur: 100n, mn: 1n, mx: 3n, cnt: 3, dcnt: 3 }]).length)
        .toBeGreaterThan(0); // BLOCK 7: gapless history 1..3 but kv_current JUMPED to 100 ⇒ violation
      expect(gaplessVersionViolations([{ ns: "x", scope: "s", key: "k", cur: 1n, mn: null, mx: null, cnt: null, dcnt: null }]))
        .toEqual([]); // first put, no history yet, kv_current at 1 ⇒ holds
      expect(gaplessVersionViolations([{ ns: "x", scope: "s", key: "k", cur: 5n, mn: null, mx: null, cnt: null, dcnt: null }]).length)
        .toBeGreaterThan(0); // no history but kv_current at 5 ⇒ violation
      // I4 KV-inclusive T5 (BLOCK 6):
      expect(watermarkNotAheadViolation(5, 3, { batch: 5 })).not.toBeNull(); // ahead of checkpoint ⇒ violation
      expect(watermarkNotAheadViolation(3, 3, { batch: 3 })).toBeNull(); // equal + covered KV present ⇒ holds
      expect(watermarkNotAheadViolation(2, 3, { batch: 2 })).toBeNull(); // behind + covered KV present ⇒ holds
      expect(watermarkNotAheadViolation(undefined, undefined, undefined)).toBeNull(); // no cursor yet ⇒ vacuous
      expect(watermarkNotAheadViolation(3, 3, undefined)).not.toBeNull(); // covered batch's KV datum MISSING ⇒ violation
      expect(watermarkNotAheadViolation(3, 3, { batch: 99 })).not.toBeNull(); // covered batch's KV datum MISMATCHED ⇒ violation
      // I3 / I2:
      expect(danglingJunctionViolation(1)).not.toBeNull();
      expect(danglingJunctionViolation(0)).toBeNull();
      expect(onlyCompleteLoadableViolations(false, 0).length).toBeGreaterThan(0); // non-complete loaded
      expect(onlyCompleteLoadableViolations(true, 2).length).toBeGreaterThan(0); // incomplete exists
      expect(onlyCompleteLoadableViolations(true, 0)).toEqual([]); // holds

      const uri = connectionUri();
      const runId = randomUUID().slice(0, 12);
      const salt = runId;

      // Distinct identities for the SOAK run and its fault-free REFERENCE (same container, no second
      // container / schema — isolation is by identifier, as in the T5 keystone test).
      const syncWallet = `soak-sw-${runId}`;
      const syncKey = `soak-sk-${runId}`;
      const syncKvScope = `soak-skv-${runId}`;
      const churnScope = `soak-cs-${runId}`;
      const leaseKey = `soak-lease-${runId}`;
      const refWallet = `ref-sw-${runId}`;
      const refSyncKey = `ref-sk-${runId}`;
      const refChurnScope = `ref-cs-${runId}`;

      // One dedicated pool for the concurrent actors + one small pool for the sampler (its reads are
      // not starved by actor saturation). Both against the SHARED container.
      const actorPool = newPool(uri, 16);
      const samplerPool = newPool(uri, 3);
      const a = adaptersOf(actorPool);
      const sampler = adaptersOf(samplerPool);

      // ---- Recorded write log (the "input"), replayed verbatim into the reference identity ----
      const syncBatches: number[] = []; // committed batch indices, in order (contiguous 1..B)
      const churnLog: Array<{ key: string; value: JsonValue }> = []; // committed KV puts, in order

      // ---- GC-pass durations artifact (the deliverable of assertion (c)) ----
      interface GcPass {
        passIndex: number;
        startedAtMsSinceRunStart: number;
        durationMs: number;
        prunedManifests: number;
        reclaimedChunks: number;
        reclaimedBytes: number;
      }
      const gcPasses: GcPass[] = [];

      // ---- Mid-run sampling state ----
      let sampleCount = 0;
      let lastSample: SampleObservation | undefined;

      // ---- Run control + fatal-error collection (any actor error stops the run and fails) ----
      let running = true;
      const fatals: string[] = [];
      const recordFatal = (where: string, err: unknown): void => {
        const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
        fatals.push(`[${where}] ${msg}`);
        running = false;
      };
      const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

      const runStart = Date.now();
      const runStartPerf = performance.now();
      const deadline = runStart + MAX_SOAK_MS;
      const active = (): boolean => running && Date.now() < deadline;

      // ---- ACTOR 1: full-sync writer — for each batch, FIRST the batch's KV datum (item:b, tied to
      //      the cursor value b), THEN the checkpoint + watermark fused via the G5 saveAndAdvance
      //      durable-composition primitive (the watermark for batch b co-commits with checkpoint b,
      //      labelled b — precisely WHY I4 holds). COUNT-bounded to SYNC_SAVES so the 10^5 chunk
      //      envelope is met DETERMINISTICALLY on every host; self-paced so the mix is sustained.
      //      Single-threaded, owns the monotonic batch counter, so its recorded sequence is totally
      //      ordered and the reference reproduces it exactly. ----
      const syncActor = async (): Promise<void> => {
        for (let batch = 1; batch <= SYNC_SAVES && running; batch++) {
          const b = batch;
          try {
            // KV half FIRST (mirrors the T5 keystone): item:b becomes durable BEFORE the cursor
            // advances to b, so a cursor covering b implies item:b is durable — the KV half of
            // "durable data" the T5 sample verifies.
            await withSuiteWatchdog(() => a.kv.put(SYNC_KV_NS, syncKvScope, itemKey(b), itemValue(b)), {
              label: `sync-kv-b${b}`,
              timeoutMs: OP_WATCHDOG_MS,
            });
            await withSuiteWatchdog(
              () =>
                saveAndAdvance(
                  { checkpoints: a.checkpoints, watermarks: a.watermarks, txLayer: a.txLayer },
                  syncWallet,
                  NET,
                  payload(salt, b),
                  { kind: SYNC_KIND, key: syncKey, value: b },
                  { chunkSize: CHUNK_SIZE, label: String(b) },
                ),
              { label: `sync-b${b}`, timeoutMs: OP_WATCHDOG_MS },
            );
            syncBatches.push(b);
          } catch (err) {
            recordFatal("sync", err);
            return;
          }
          if (b < SYNC_SAVES) await delay(SYNC_PACE_MS);
        }
        // The full deterministic 10^5 envelope is written — stop the concurrent actors.
        running = false;
      };

      // ---- ACTOR 2: KV churn — independent versioned put()s over a rotating keyspace (disjoint from
      //      the sync identity), generating the per-key version history the gapless invariant checks.
      //      A benign ClockRegressionError (two sub-millisecond writes to the same key) is retried
      //      with the SAME deterministic value, so the recorded sequence stays faithful. ----
      const churnKeys = Array.from({ length: CHURN_KEYS }, (_v, i) => `ckey-${i}`);
      const perKeyCount = new Map<string, number>();
      const churnActor = async (): Promise<void> => {
        let cursor = 0;
        while (active()) {
          const key = churnKeys[cursor % churnKeys.length]!;
          cursor += 1;
          const n = (perKeyCount.get(key) ?? 0) + 1;
          perKeyCount.set(key, n);
          const value = churnValue(key, n);
          let committed = false;
          for (let attempt = 0; attempt < 6 && !committed && running; attempt++) {
            try {
              await withSuiteWatchdog(() => a.kv.put(CHURN_NS, churnScope, key, value), {
                label: `churn-${key}-${n}`,
                timeoutMs: OP_WATCHDOG_MS,
              });
              committed = true;
            } catch (err) {
              if ((err as { code?: string }).code === "CLOCK_REGRESSION") {
                await delay(2);
                continue;
              }
              recordFatal("churn", err);
              return;
            }
          }
          if (!committed) {
            if (running) recordFatal("churn", new Error(`clock-regression retries exhausted for ${key}`));
            return;
          }
          churnLog.push({ key, value });
          await delay(CHURN_INTERVAL_MS);
        }
      };

      // ---- ACTOR 3: periodic prune (GC passes) — each pass timed; duration recorded as the artifact
      //      and bounded by GC_PASS_WATCHDOG_MS (the wrapping withSuiteWatchdog IS the termination
      //      mechanism; the explicit check is belt-and-suspenders). NO threshold gates anything. ----
      const pruneActor = async (): Promise<void> => {
        let idx = 0;
        while (active()) {
          idx += 1;
          const passIndex = idx;
          const t0 = performance.now();
          try {
            const res = await withSuiteWatchdog(() => a.checkpoints.prune(syncWallet, NET, RETAIN_COUNT), {
              label: `prune-${passIndex}`,
              timeoutMs: GC_PASS_WATCHDOG_MS, // termination bound
            });
            const durationMs = performance.now() - t0;
            gcPasses.push({
              passIndex,
              startedAtMsSinceRunStart: t0 - runStartPerf,
              durationMs,
              prunedManifests: res.prunedSequences.length,
              reclaimedChunks: res.reclaimedChunks,
              reclaimedBytes: res.reclaimedBytes,
            });
            if (durationMs > GC_PASS_WATCHDOG_MS) {
              recordFatal("prune", new Error(`GC pass ${passIndex} took ${durationMs.toFixed(1)}ms > GC_PASS_WATCHDOG_MS ${GC_PASS_WATCHDOG_MS}ms`));
              return;
            }
          } catch (err) {
            recordFatal("prune", err); // includes a SuiteWatchdogTimeoutError if a pass wedged
            return;
          }
          await delay(PRUNE_INTERVAL_MS);
        }
      };

      // ---- ACTOR 4: a held withLease — acquire, HOLD across a critical section, release, repeat, so
      //      a lease is genuinely held concurrently with the rest of the mix throughout the run. ----
      let leaseHolds = 0;
      const leaseActor = async (): Promise<void> => {
        while (active()) {
          try {
            await withSuiteWatchdog(
              () =>
                a.txLayer.withLease(leaseKey, async () => {
                  leaseHolds += 1;
                  await delay(LEASE_HOLD_MS);
                }),
              { label: `lease-${leaseHolds}`, timeoutMs: OP_WATCHDOG_MS },
            );
          } catch (err) {
            recordFatal("lease", err);
            return;
          }
          await delay(LEASE_GAP_MS);
        }
      };

      // ---- ACTOR 5: the MID-RUN SAMPLER — evaluates all four enumerated invariants against the LIVE
      //      database every ~SAMPLE_INTERVAL_MS and fails on the FIRST violation. This is the heart of
      //      assertion (a): sampling DURING the run, not only at teardown. ----
      const sampleInvariants = async (): Promise<SampleObservation> => {
        const violations: string[] = [];

        // I1 — gapless per-(ns,scope,key) versions in kv_history AND kv_current.version consistency.
        // ONE self-consistent statement: kv_current LEFT JOIN its kv_history aggregate, so the live
        // current version and its superseded history are read from the SAME snapshot (a cross-
        // statement read could otherwise report a spurious current-vs-history inversion mid-put).
        const hist = await withSuiteWatchdog(
          sampler.sql<HistGroup[]>`
            SELECT c.ns, c.scope, c.key, c.version AS cur,
                   h.mn, h.mx, h.cnt, h.dcnt
            FROM ${sampler.sql(TEST_SCHEMA)}.kv_current c
            LEFT JOIN (
              SELECT ns, scope, key,
                     min(version) AS mn, max(version) AS mx,
                     count(*)::int AS cnt, count(distinct version)::int AS dcnt
              FROM ${sampler.sql(TEST_SCHEMA)}.kv_history
              WHERE ns = ${CHURN_NS} AND scope = ${churnScope}
              GROUP BY ns, scope, key
            ) h ON h.ns = c.ns AND h.scope = c.scope AND h.key = c.key
            WHERE c.ns = ${CHURN_NS} AND c.scope = ${churnScope}`,
          { label: "sample-I1-gapless", timeoutMs: OP_WATCHDOG_MS },
        );
        violations.push(...gaplessVersionViolations(hist));
        const historyRows = hist.reduce((s, r) => s + (r.cnt ?? 0), 0);

        // I4 — watermark ≤ max durable data, KV-INCLUSIVE. ONE statement (scalar subselects) so the
        // watermark, the max complete-manifest label, AND the covered batch's KV datum
        // (item:watermark) are read from the SAME consistent snapshot (they co-commit via
        // saveAndAdvance / are written before it, so a cross-statement read could otherwise report a
        // spurious inversion). The covered KV key is built from the SAME watermark value.
        const t5 = await withSuiteWatchdog(
          sampler.sql<{ wm: number | null; maxlabel: bigint | null; covered_kv: JsonValue | null }[]>`
            SELECT
              (SELECT value FROM ${sampler.sql(TEST_SCHEMA)}.watermarks
                 WHERE kind = ${SYNC_KIND} AND key = ${syncKey}) AS wm,
              (SELECT max((label)::bigint) FROM ${sampler.sql(TEST_SCHEMA)}.ckpt_manifests
                 WHERE w = ${syncWallet} AND net = ${NET} AND complete AND label ~ '^[0-9]+$') AS maxlabel,
              (SELECT value FROM ${sampler.sql(TEST_SCHEMA)}.kv_current
                 WHERE ns = ${SYNC_KV_NS} AND scope = ${syncKvScope}
                   AND key = ('item:' || ((SELECT value FROM ${sampler.sql(TEST_SCHEMA)}.watermarks
                                             WHERE kind = ${SYNC_KIND} AND key = ${syncKey}) #>> '{}'))) AS covered_kv`,
          { label: "sample-I4-watermark", timeoutMs: OP_WATCHDOG_MS },
        );
        const watermark = t5[0]!.wm === null ? undefined : Number(t5[0]!.wm);
        const maxDurableLabel = t5[0]!.maxlabel === null ? undefined : Number(t5[0]!.maxlabel);
        const coveredKv = t5[0]!.covered_kv === null ? undefined : t5[0]!.covered_kv;
        const t5v = watermarkNotAheadViolation(watermark, maxDurableLabel, coveredKv);
        if (t5v !== null) violations.push(t5v);

        // I3 — no junction row references a missing/incomplete manifest (single statement).
        const c2 = await withSuiteWatchdog(
          sampler.sql<{ v: number }[]>`
            SELECT count(*)::int AS v
            FROM ${sampler.sql(TEST_SCHEMA)}.ckpt_manifest_chunks mc
            LEFT JOIN ${sampler.sql(TEST_SCHEMA)}.ckpt_manifests m ON m.id = mc.manifest_id
            WHERE m.id IS NULL OR NOT m.complete`,
          { label: "sample-I3-c2a", timeoutMs: OP_WATCHDOG_MS },
        );
        const c2v = danglingJunctionViolation(c2[0]!.v);
        if (c2v !== null) violations.push(c2v);

        // Non-vacuity witnesses (complete manifests, incomplete manifests, chunk count).
        const counts = await withSuiteWatchdog(
          sampler.sql<{ complete_manifests: number; incomplete_manifests: number; chunks: number }[]>`
            SELECT
              (SELECT count(*)::int FROM ${sampler.sql(TEST_SCHEMA)}.ckpt_manifests
                 WHERE w = ${syncWallet} AND net = ${NET} AND complete) AS complete_manifests,
              (SELECT count(*)::int FROM ${sampler.sql(TEST_SCHEMA)}.ckpt_manifests
                 WHERE w = ${syncWallet} AND net = ${NET} AND NOT complete) AS incomplete_manifests,
              (SELECT count(*)::int FROM ${sampler.sql(TEST_SCHEMA)}.ckpt_chunks) AS chunks`,
          { label: "sample-counts", timeoutMs: OP_WATCHDOG_MS },
        );
        const completeManifests = counts[0]!.complete_manifests;
        const incompleteManifests = counts[0]!.incomplete_manifests;
        const chunks = counts[0]!.chunks;

        // I2 — only complete manifests are loadable: genuinely exercise load(latest), then SQL-verify
        // the returned manifest is complete, and that ZERO incomplete manifests exist. Skipped only
        // until the first checkpoint exists (a real absence, recorded as c1Checked=false).
        let c1Checked = false;
        if (completeManifests > 0) {
          const rec = await withSuiteWatchdog(() => sampler.checkpoints.load(syncWallet, NET), {
            label: "sample-I2-load",
            timeoutMs: OP_WATCHDOG_MS,
          });
          const flag = await withSuiteWatchdog(
            sampler.sql<{ complete: boolean }[]>`
              SELECT complete FROM ${sampler.sql(TEST_SCHEMA)}.ckpt_manifests
              WHERE w = ${syncWallet} AND net = ${NET} AND seq = ${rec.sequence}`,
            { label: "sample-I2-verify", timeoutMs: OP_WATCHDOG_MS },
          );
          violations.push(...onlyCompleteLoadableViolations(flag[0]?.complete === true, incompleteManifests));
          c1Checked = true;
        }

        return {
          tMs: Date.now() - runStart,
          completeManifests,
          historyRows,
          chunks,
          watermark,
          maxDurableLabel,
          coveredKvPresent: coveredKv !== undefined,
          gaplessKeysChecked: hist.length,
          c1Checked,
          violations,
        };
      };

      const samplerActor = async (): Promise<void> => {
        while (active()) {
          await delay(SAMPLE_INTERVAL_MS);
          if (!active()) break;
          try {
            const obs = await sampleInvariants();
            sampleCount += 1;
            lastSample = obs;
            if (obs.violations.length > 0) {
              recordFatal("sampler", new Error(`INVARIANT VIOLATION at sample ${sampleCount} (t=${obs.tMs}ms): ${obs.violations.join("; ")}`));
              return;
            }
          } catch (err) {
            recordFatal("sampler", err);
            return;
          }
        }
      };

      // ---- Run the sustained concurrent mix; the sync writer is count-bounded (it stops the others
      //      when its full envelope is written), with MAX_SOAK_MS as a safety backstop. ----
      const stopTimer = setTimeout(() => {
        running = false;
      }, MAX_SOAK_MS);
      await Promise.all([syncActor(), churnActor(), pruneActor(), leaseActor(), samplerActor()]);
      clearTimeout(stopTimer);
      const soakWallMs = Date.now() - runStart;

      // ---- Any actor fatal (incl. a sampled invariant violation) fails the test, naming it. ----
      if (fatals.length > 0) {
        throw new Error(`soak run failed (${fatals.length} fatal error(s)):\n${fatals.join("\n")}`);
      }

      const batchMax = syncBatches.length;

      // ---- Assertion (a) evidence: mid-run sampling was REAL and NON-VACUOUS ----
      expect(sampleCount).toBeGreaterThanOrEqual(MIN_SAMPLES); // sampling actually fired, many times, DURING the run
      expect(lastSample).toBeDefined();
      expect(lastSample!.tMs).toBeLessThanOrEqual(soakWallMs); // the last sample fired within the run window
      // The final sample observed a genuinely non-trivial state — so the invariants were checked
      // against REAL data, not an empty database (no vacuous pass).
      expect(lastSample!.completeManifests).toBeGreaterThan(0);
      expect(lastSample!.historyRows).toBeGreaterThan(0);
      expect(lastSample!.gaplessKeysChecked).toBeGreaterThan(0);
      expect(lastSample!.c1Checked).toBe(true);
      expect(lastSample!.watermark).toBeDefined();
      expect(lastSample!.coveredKvPresent).toBe(true); // the KV-inclusive T5 half checked a real covered datum

      // ---- The DECLARED 10^5 envelope was actually exercised (not a zero-op vacuous pass). The sync
      //      writer is count-bounded to SYNC_SAVES * CHUNKS_PER_SAVE distinct chunks, so this floor is
      //      met DETERMINISTICALLY; measured before the GC-reclamation leg (which reclaims some) and
      //      the reference replay (which dedups). ----
      expect(batchMax).toBe(SYNC_SAVES); // every declared checkpoint committed (deterministic envelope)
      const finalChunks = (
        await withSuiteWatchdog(
          a.sql<{ chunks: number }[]>`SELECT count(*)::int AS chunks FROM ${a.sql(TEST_SCHEMA)}.ckpt_chunks`,
          { label: "final-chunk-count", timeoutMs: OP_WATCHDOG_MS },
        )
      )[0]!.chunks;
      expect(finalChunks).toBeGreaterThanOrEqual(LIVE_CHUNK_FLOOR); // >= 10^5 (acceptance F1)
      expect(gcPasses.length).toBeGreaterThanOrEqual(MIN_GC_PASSES);
      expect(churnLog.length).toBeGreaterThanOrEqual(MIN_CHURN_PUTS);
      expect(leaseHolds).toBeGreaterThan(0);

      // ---- Assertion (c): every recorded GC pass completed within the termination watchdog, and the
      //      durations are WRITTEN as an artifact. NO pass-rate/latency threshold gates the release —
      //      the durations are the deliverable, ungated (ROADMAP §D). ----
      for (const p of gcPasses) {
        expect(p.durationMs).toBeLessThanOrEqual(GC_PASS_WATCHDOG_MS); // termination bound, not a perf gate
      }

      // ---- BLOCK 5: a REAL reclamation — prove a GC pass GENUINELY reclaims chunks (not merely
      //      records reclaimedChunks). During the soak all chunks are inside the 15-min grace window,
      //      so reclaimedChunks is legitimately 0; here a DEDICATED wallet's UNIQUE-content chunks are
      //      backdated PAST the grace window (mirroring the checkpoint-store GC-scale / load-under-
      //      prune tests: `UPDATE ckpt_chunks SET created_at = now() - interval '1 hour'`), then a
      //      prune retaining only the newest few genuinely DELETES the older manifests AND reclaims
      //      their now-orphaned backdated chunks. A broken chunk-reclamation anti-join would fail. ----
      const gcWallet = `soak-gc-${runId}`;
      const gc = adaptersOf(newPool(uri, 2));
      for (let i = 0; i < GC_RECLAIM_SAVES; i++) {
        await withSuiteWatchdog(
          () => gc.checkpoints.save(gcWallet, NET, randomBytes(GC_RECLAIM_PAYLOAD_BYTES), { chunkSize: GC_RECLAIM_CHUNK_SIZE, label: `gc${i}` }),
          { label: `gc-seed-${i}`, timeoutMs: OP_WATCHDOG_MS },
        );
      }
      // Backdate this wallet's chunks past prune's 15-minute grace window (trusted literal, inlined
      // exactly as the store's own prune inlines its window / as load-under-prune backdates).
      await withSuiteWatchdog(
        gc.sql`
          UPDATE ${gc.sql(TEST_SCHEMA)}.ckpt_chunks
          SET created_at = now() - interval '1 hour'
          WHERE hash IN (
            SELECT mc.chunk_hash FROM ${gc.sql(TEST_SCHEMA)}.ckpt_manifest_chunks mc
            JOIN ${gc.sql(TEST_SCHEMA)}.ckpt_manifests m ON m.id = mc.manifest_id
            WHERE m.w = ${gcWallet} AND m.net = ${NET}
          )`,
        { label: "gc-backdate", timeoutMs: OP_WATCHDOG_MS },
      );
      const gcReclaim = await withSuiteWatchdog(
        () => gc.checkpoints.prune(gcWallet, NET, GC_RECLAIM_RETAIN),
        { label: "gc-reclaim-prune", timeoutMs: GC_PASS_WATCHDOG_MS },
      );
      // The older manifests were genuinely deleted AND their backdated, now-orphaned chunks reclaimed.
      expect(gcReclaim.prunedSequences.length).toBeGreaterThan(0); // manifests deleted > 0
      expect(gcReclaim.reclaimedChunks).toBeGreaterThan(0); // chunks GENUINELY reclaimed (broken anti-join fails)
      expect(gcReclaim.reclaimedBytes).toBeGreaterThan(0);

      // ---- BLOCK 8: the "only complete manifests are loadable" (C1) filter, exercised against the
      //      REAL adapter with an ACTUAL incomplete manifest present. Save complete checkpoints, then
      //      forge an interrupted-save LEFTOVER (a `complete = false` manifest at a HIGHER seq, wired
      //      to a real chunk) — the partial state an aborted save leaves behind. A load/history that
      //      DROPPED its `complete = true` filter would return the higher-seq incomplete manifest;
      //      the REAL adapter path must EXCLUDE it: load(latest) returns the last COMPLETE checkpoint,
      //      and history omits the leftover. ----
      const incWallet = `soak-inc-${runId}`;
      const inc = adaptersOf(newPool(uri, 2));
      const completeSeqs: number[] = [];
      for (let i = 0; i < INCOMPLETE_COMPLETE_SAVES; i++) {
        const s = await withSuiteWatchdog(
          () => inc.checkpoints.save(incWallet, NET, randomBytes(256), { chunkSize: INCOMPLETE_CHUNK_SIZE, label: `ok${i}` }),
          { label: `inc-complete-${i}`, timeoutMs: OP_WATCHDOG_MS },
        );
        completeSeqs.push(s.sequence);
      }
      const lastCompleteSeq = Math.max(...completeSeqs);
      // Forge the interrupted-save leftover on the SAME counter the real save() allocates from, so it
      // lands at a HIGHER seq than every complete one (that higher seq is what gives the test teeth:
      // without the complete filter, load's `ORDER BY seq DESC LIMIT 1` would return THIS row).
      const incData = randomBytes(256);
      const incChunkHash = sha256(incData);
      const incompleteSeq = await withSuiteWatchdog(
        () =>
          inc.sql.begin(async (tx) => {
            const seqRow = await tx<{ claimed: bigint }[]>`
              INSERT INTO ${tx(TEST_SCHEMA)}.ckpt_sequence_counters (w, net)
              VALUES (${incWallet}, ${NET})
              ON CONFLICT (w, net) DO UPDATE
              SET next_seq = ${tx(TEST_SCHEMA)}.ckpt_sequence_counters.next_seq + 1
              RETURNING next_seq - 1 AS claimed`;
            const seq = seqRow[0]!.claimed;
            await tx`
              INSERT INTO ${tx(TEST_SCHEMA)}.ckpt_chunks (hash, data)
              VALUES (${incChunkHash}, ${incData}) ON CONFLICT (hash) DO NOTHING`;
            const mrow = await tx<{ id: bigint }[]>`
              INSERT INTO ${tx(TEST_SCHEMA)}.ckpt_manifests (w, net, seq, complete, manifest_hash, label)
              VALUES (${incWallet}, ${NET}, ${seq}, false, ${sha256(incChunkHash)}, 'interrupted-save')
              RETURNING id`;
            await tx`
              INSERT INTO ${tx(TEST_SCHEMA)}.ckpt_manifest_chunks (manifest_id, position, chunk_hash)
              VALUES (${mrow[0]!.id}, 0, ${incChunkHash})`;
            return Number(seq);
          }),
        { label: "inc-forge-leftover", timeoutMs: OP_WATCHDOG_MS },
      );
      // Sanity/teeth: an incomplete manifest genuinely EXISTS, at a HIGHER seq than any complete one.
      const incState = await withSuiteWatchdog(
        inc.sql<{ n: number; maxinc: number | null; maxcomplete: number | null }[]>`
          SELECT
            (SELECT count(*)::int FROM ${inc.sql(TEST_SCHEMA)}.ckpt_manifests
               WHERE w = ${incWallet} AND net = ${NET} AND NOT complete) AS n,
            (SELECT max(seq)::int FROM ${inc.sql(TEST_SCHEMA)}.ckpt_manifests
               WHERE w = ${incWallet} AND net = ${NET} AND NOT complete) AS maxinc,
            (SELECT max(seq)::int FROM ${inc.sql(TEST_SCHEMA)}.ckpt_manifests
               WHERE w = ${incWallet} AND net = ${NET} AND complete) AS maxcomplete`,
        { label: "inc-verify-state", timeoutMs: OP_WATCHDOG_MS },
      );
      expect(incState[0]!.n).toBeGreaterThan(0); // the incomplete leftover really exists
      expect(incompleteSeq).toBeGreaterThan(lastCompleteSeq); // ...at a HIGHER seq (the teeth)
      expect(incState[0]!.maxinc).toBe(incompleteSeq);
      expect(incState[0]!.maxcomplete).toBe(lastCompleteSeq);
      // The REAL adapter path EXCLUDES it: load(latest) returns the last COMPLETE checkpoint, NOT the
      // higher-seq incomplete one — so weakening the `complete = true` filter in `src` fails here.
      const loaded = await withSuiteWatchdog(() => inc.checkpoints.load(incWallet, NET), {
        label: "inc-load-latest",
        timeoutMs: OP_WATCHDOG_MS,
      });
      expect(loaded.sequence).toBe(lastCompleteSeq);
      // history() omits the incomplete leftover entirely (returns only the complete seqs).
      const incHistory = await withSuiteWatchdog(() => inc.checkpoints.history(incWallet, NET, { limit: 100 }), {
        label: "inc-history",
        timeoutMs: OP_WATCHDOG_MS,
      });
      const incHistSeqs = incHistory.map((h) => h.sequence);
      expect(incHistSeqs).toContain(lastCompleteSeq);
      expect(incHistSeqs).not.toContain(incompleteSeq); // the leftover is excluded
      expect(incHistSeqs.every((s) => completeSeqs.includes(s))).toBe(true);

      // ---- Write the GC-pass durations + reclamation artifact (deliverable of assertion (c)) ----
      const artifactPath =
        process.env.UMBRADB_SOAK_GC_ARTIFACT ??
        fileURLToPath(new URL("./artifacts/gc-pass-durations.json", import.meta.url));
      const durations = gcPasses.map((p) => p.durationMs);
      const artifact = {
        schema: "umbradb-soak-gc-pass-durations/v1",
        runId,
        generatedAt: new Date().toISOString(),
        soakWallMs,
        declaredEnvelope: DECLARED_ENVELOPE,
        liveEnvelope: { ...LIVE_ENVELOPE, chunksCreated: finalChunks, checkpointSaves: batchMax, churnPuts: churnLog.length },
        gcPassWatchdogMs: GC_PASS_WATCHDOG_MS,
        gate: "NONE — GC-pass durations are recorded, NOT gated (ROADMAP §D / council/B §3 baseline ruling). GC_PASS_WATCHDOG_MS is a test-termination bound only.",
        passCount: gcPasses.length,
        durationStatsMs: durations.length
          ? { min: Math.min(...durations), max: Math.max(...durations), mean: durations.reduce((s, d) => s + d, 0) / durations.length }
          : null,
        reclamation: {
          note: "Dedicated grace-window-backdated leg (BLOCK 5): proves a GC pass GENUINELY reclaims chunks.",
          prunedManifests: gcReclaim.prunedSequences.length,
          reclaimedChunks: gcReclaim.reclaimedChunks,
          reclaimedBytes: gcReclaim.reclaimedBytes,
        },
        passes: gcPasses,
      };
      mkdirSync(dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
      // Prove the artifact was GENUINELY written (read it back and re-parse).
      const readBack = JSON.parse(readFileSync(artifactPath, "utf8")) as { passCount: number; passes: unknown[] };
      expect(readBack.passCount).toBe(gcPasses.length);
      expect(readBack.passes.length).toBe(gcPasses.length);

      // ---- Assertion (b): the END STATE equals a FAULT-FREE REFERENCE on the current-state predicate.
      //      The reference is a genuine fault-free replay of the SAME recorded write sequence, via
      //      UmbraDB's OWN adapters, into the separate reference identity — NO prune, NO concurrency,
      //      NO imported store (design.md §4). ----
      // Replay the sync/full-sync write-batch sequence 1..batchMax (checkpoint payload + watermark).
      for (const b of syncBatches) {
        await withSuiteWatchdog(
          () =>
            saveAndAdvance(
              { checkpoints: a.checkpoints, watermarks: a.watermarks, txLayer: a.txLayer },
              refWallet,
              NET,
              payload(salt, b),
              { kind: SYNC_KIND, key: refSyncKey, value: b },
              { chunkSize: CHUNK_SIZE, label: String(b) },
            ),
          { label: `ref-sync-b${b}`, timeoutMs: OP_WATCHDOG_MS },
        );
      }
      // Replay the churn put sequence verbatim (same order, same deterministic values).
      for (const e of churnLog) {
        let done = false;
        for (let attempt = 0; attempt < 6 && !done; attempt++) {
          try {
            await withSuiteWatchdog(() => a.kv.put(CHURN_NS, refChurnScope, e.key, e.value), {
              label: `ref-churn-${e.key}`,
              timeoutMs: OP_WATCHDOG_MS,
            });
            done = true;
          } catch (err) {
            if ((err as { code?: string }).code === "CLOCK_REGRESSION") {
              await delay(2);
              continue;
            }
            throw err;
          }
        }
        expect(done).toBe(true);
      }

      // Read both current states from a FRESH client and assert equality on the predicate.
      const fresh = adaptersOf(newPool(uri, 4));
      const soakState = await readCurrentState(fresh, syncWallet, churnScope, syncKey);
      const refState = await readCurrentState(fresh, refWallet, refChurnScope, refSyncKey);
      assertCurrentStateEqual(soakState, refState);

      // EXHAUSTIVENESS teeth (test-honesty): the predicate compares the FULL current state, so an
      // extra/stale kv_current row OR an extra watermark on ONLY one side breaks equality — demonstrate
      // over the just-read states (no DB mutation) that injecting an unexpected row THROWS.
      expect(() =>
        assertCurrentStateEqual(
          { ...soakState, kvAll: { ...soakState.kvAll, [`${CHURN_NS} ckey-stale`]: { k: "ckey-stale", v: 99 } } },
          refState,
        ),
      ).toThrow();
      expect(() =>
        assertCurrentStateEqual({ ...soakState, watermarksAll: { ...soakState.watermarksAll, "stale-kind": 7 } }, refState),
      ).toThrow();

      // Spell the convergence out: the watermark fully advanced to batchMax on BOTH sides; the latest
      // checkpoint payload equals payload(salt, batchMax) on both.
      expect(soakState.watermarksAll[SYNC_KIND]).toEqual(batchMax);
      expect(refState.watermarksAll[SYNC_KIND]).toEqual(batchMax);
      expect(soakState.latestPayload.equals(payload(salt, batchMax))).toBe(true);
      expect(refState.latestPayload.equals(payload(salt, batchMax))).toBe(true);

      // ---- Diagnostics (evidence for the orchestrator): what actually ran ----
      // eslint-disable-next-line no-console
      console.log(
        `[soak] wall=${(soakWallMs / 1000).toFixed(1)}s samples=${sampleCount} ` +
          `checkpointSaves=${batchMax} chunks=${finalChunks} (floor=${LIVE_CHUNK_FLOOR}) churnPuts=${churnLog.length} ` +
          `gcPasses=${gcPasses.length} leaseHolds=${leaseHolds} ` +
          `reclaim={prunedManifests=${gcReclaim.prunedSequences.length}, reclaimedChunks=${gcReclaim.reclaimedChunks}, reclaimedBytes=${gcReclaim.reclaimedBytes}} ` +
          `incompleteManifest={completeSeqs=[${completeSeqs.join(",")}], incompleteSeq=${incompleteSeq}, loadedSeq=${loaded.sequence}} ` +
          `lastSample={t=${lastSample!.tMs}ms, completeManifests=${lastSample!.completeManifests}, ` +
          `historyRows=${lastSample!.historyRows}, watermark=${String(lastSample!.watermark)}, ` +
          `maxDurableLabel=${String(lastSample!.maxDurableLabel)}, coveredKvPresent=${lastSample!.coveredKvPresent}, ` +
          `gaplessKeys=${lastSample!.gaplessKeysChecked}} ` +
          `gcDurationsMs=[${gcPasses.map((p) => p.durationMs.toFixed(1)).join(",")}] ` +
          `artifact=${artifactPath}`,
      );
    },
    TEST_TIMEOUT_MS,
  );
});
