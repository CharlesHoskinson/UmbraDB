import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { PgCheckpointStore } from "../../../src/postgres/checkpoint-store.js";
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
 * T1 — process-kill mid-save (`design.md` §2.1; `tasks.md` §1.1; acceptance B1-B4). Builds on the
 * Task 0 crash harness (`setup.ts` fault primitives + `crash-worker.ts` `before-commit` hook +
 * `crash-harness.smoke.test.ts` patterns).
 *
 * `saveImpl` issues, inside ONE transaction: the chunk upsert -> the gapless seq allocation
 * (`ckpt_sequence_counters`, `RETURNING next_seq - 1`) -> the manifest INSERT with `complete = true`
 * written EXPLICITLY -> the junction inserts (`checkpoint-store.ts`). A SIGKILL between those writes
 * and the COMMIT must roll the WHOLE transaction back — Postgres aborts the in-flight backend's
 * transaction the instant the client socket closes. This test proves that already-good crash
 * atomicity (`02` §Cold-start: "A killed save leaves nothing visible") is ACTUALLY TESTED, not
 * merely asserted.
 *
 * TEST-HONESTY (the dominant risk in this change): every assertion observes durable state from a
 * FRESH client (a new pool) STRICTLY AFTER the SIGKILL is confirmed (`exit.signal === "SIGKILL"`);
 * (a) is written so it FAILS if the harness rollback were broken (a committed killed txn would put
 * a complete manifest at the interrupted seq); and a mandatory SAME-PATH NEGATIVE CONTROL runs the
 * SAME co-transactional `save({ tx })` path to completion (commit, no kill) and asserts the OPPOSITE outcome of (a) at the SAME
 * seq — proving the kill CAUSED the absence, not that `save` is broken. Every DB op is wrapped in
 * `withSuiteWatchdog` so a half-dead backend fails the op typed rather than hanging the gate.
 */

const { sql: getSql, connectionUri } = registerSuiteLifecycle();

/** Dedicated pools opened by the test, torn down after it. */
let openPools: UmbraDBSql[] = [];
/** Workers spawned by the test, hard-killed after it (belt-and-suspenders vs. the worker's own
 *  orphan guard). */
let liveWorkers: CrashWorkerHandle[] = [];

function pool(maxConnections = 5): UmbraDBSql {
  const p = createClient({ connectionString: connectionUri(), schema: TEST_SCHEMA, maxConnections, connectTimeout: 10 });
  openPools.push(p);
  return p;
}

function store(p: UmbraDBSql): PgCheckpointStore {
  return new PgCheckpointStore(p, new PgTransactionLeaseLayer(p), TEST_SCHEMA);
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

// -- Parent-side verification queries. Each takes the pool to run on (so an assertion can be made
//    from a FRESH client), and each is bounded by the suite watchdog so a half-dead Postgres fails
//    it typed rather than hanging the suite (Task 0.3). --------------------------------------------

/** Count of `complete = true` manifests at a SPECIFIC seq for (w, net). */
async function completeManifestCountAtSeq(sql: UmbraDBSql, w: string, net: string, seq: number): Promise<number> {
  const rows = await withSuiteWatchdog(
    sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(TEST_SCHEMA)}.ckpt_manifests
      WHERE w = ${w} AND net = ${net} AND seq = ${seq} AND complete`,
    { label: "completeManifestCountAtSeq", timeoutMs: 10_000 },
  );
  return rows[0]!.n;
}

/** Count of ALL manifest rows (complete OR not) at a specific seq for (w, net). */
async function manifestRowCountAtSeq(sql: UmbraDBSql, w: string, net: string, seq: number): Promise<number> {
  const rows = await withSuiteWatchdog(
    sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(TEST_SCHEMA)}.ckpt_manifests
      WHERE w = ${w} AND net = ${net} AND seq = ${seq}`,
    { label: "manifestRowCountAtSeq", timeoutMs: 10_000 },
  );
  return rows[0]!.n;
}

/** Count of ALL `complete = true` manifests for (w, net) (across every seq). */
async function completeManifestCount(sql: UmbraDBSql, w: string, net: string): Promise<number> {
  const rows = await withSuiteWatchdog(
    sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(TEST_SCHEMA)}.ckpt_manifests
      WHERE w = ${w} AND net = ${net} AND complete`,
    { label: "completeManifestCount", timeoutMs: 10_000 },
  );
  return rows[0]!.n;
}

/** Orphan junction rows: `ckpt_manifest_chunks` rows referencing a manifest that is ABSENT or
 *  NOT `complete`. (The FK makes a truly-absent manifest impossible, but the LEFT JOIN + the
 *  `complete = false` arm keep the check honest as defense-in-depth against out-of-band state.) */
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

/** Dangling chunks: `ckpt_chunks` rows referenced by NO junction row at all. */
async function danglingChunkCount(sql: UmbraDBSql): Promise<number> {
  const rows = await withSuiteWatchdog(
    sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(TEST_SCHEMA)}.ckpt_chunks c
      WHERE NOT EXISTS (
        SELECT 1 FROM ${sql(TEST_SCHEMA)}.ckpt_manifest_chunks mc WHERE mc.chunk_hash = c.hash
      )`,
    { label: "danglingChunkCount", timeoutMs: 10_000 },
  );
  return rows[0]!.n;
}

/** Total junction row count (this file owns a fresh container, so it reflects only this test). */
async function junctionRowCount(sql: UmbraDBSql): Promise<number> {
  const rows = await withSuiteWatchdog(
    sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(TEST_SCHEMA)}.ckpt_manifest_chunks`,
    { label: "junctionRowCount", timeoutMs: 10_000 },
  );
  return rows[0]!.n;
}

describe("process-kill mid-save leaves no partially-visible checkpoint (T1 / design.md §2.1)", () => {
  it("[[crash.process-kill-save.no-partial-checkpoint]] SIGKILL at before-commit rolls the second save back: no complete manifest at the interrupted seq, the prior seq still loads+hash-verifies, no orphan junction/chunk rows; a no-kill negative control proves the kill CAUSED the absence", async () => {
    const walletId = `t1-${randomUUID()}`;
    const networkId = "n";

    // ---- Step 1: a NORMAL committed prior checkpoint (seq 1) -------------------------------------
    // Done as a DIRECT save (design.md §2.1 sanctions "or a direct save") so this test holds the
    // exact bytes and can later assert load() returns THEM (a positive integrity check on the
    // survivor). 512 bytes < the 4 MiB default chunkSize ⇒ exactly one chunk ⇒ one junction row.
    const seq1Bytes = randomBytes(512);
    const setupStore = store(pool());
    const seq1 = await withSuiteWatchdog(
      () => setupStore.save(walletId, networkId, seq1Bytes),
      { label: "seq1-prior-save", timeoutMs: 20_000 },
    );
    expect(seq1.sequence).toBe(1); // the first save for a (w, net) is seq 1

    // ---- Step 2: a SECOND save (seq 2) crashed mid-transaction -----------------------------------
    // The worker drives the co-transactional save on its OWN open transaction and pauses at
    // `before-commit`: every statement of the seq-2 save — chunk upsert, seq allocation, the
    // manifest INSERT with complete=true, the junction inserts — has been ISSUED but NOT COMMITTED.
    // BLOCK 1: the killed leg and the no-kill control (Step 4) must save the IDENTICAL payload so only
    // the SIGKILL differs -- a payload-dependent `{tx}` defect then cannot no-op for one payload while
    // committing the other. Generate the seq-2 payload ONCE and forward its EXACT bytes (hex) to BOTH.
    const seq2Hex = randomBytes(384).toString("hex");
    const killed = worker({ connectionUri: connectionUri(), schema: TEST_SCHEMA, hook: "before-commit", walletId, networkId, payloadHex: seq2Hex });
    const killedReady = await killed.waitForReady();
    expect(killedReady.hook).toBe("before-commit");
    expect(killedReady.backendPid).toBeGreaterThan(0); // paused on a real, uncommitted backend txn

    // While the worker is paused (uncommitted), the seq-2 manifest is invisible to every other
    // connection: the prior seq 1 is the ONLY complete manifest observable. This confirms the pause
    // truly sits on an uncommitted transaction before the kill converts it into a permanent rollback.
    expect(await completeManifestCountAtSeq(getSql(), walletId, networkId, 2)).toBe(0);
    expect(await completeManifestCount(getSql(), walletId, networkId)).toBe(1);

    // SIGKILL the worker mid-transaction, then AWAIT its CONFIRMED death (child gone ⇒ socket closed
    // ⇒ Postgres aborts the in-flight transaction). EVERY assertion below observes durable state
    // STRICTLY AFTER this confirmed SIGKILL, from a FRESH client.
    killed.sigkill();
    const exit = await withSuiteWatchdog(killed.waitForExit(), { label: "killed-worker-exit", timeoutMs: 15_000 });
    expect(exit.signal).toBe("SIGKILL"); // the kill actually landed as a SIGKILL

    // ---- Step 3: assert from a FRESH client (a NEW pool via connectionUri()) ---------------------
    const freshPool = pool();
    const freshStore = store(freshPool);

    // (a) No complete=true manifest at the interrupted seq (seq 2) — the killed save left NOTHING
    //     visible. Stronger: no manifest row AT ALL at seq 2 (not even an incomplete one), and the
    //     ONLY complete manifest for (w, net) is still the prior seq 1.
    //     HONESTY: this assertion CAN FAIL. If the harness rollback were broken (the killed txn had
    //     committed), a complete manifest would exist at seq 2 and the first line below would read 1,
    //     not 0. The negative control (Step 4) shows exactly that opposite outcome without a kill.
    expect(await completeManifestCountAtSeq(freshPool, walletId, networkId, 2)).toBe(0);
    expect(await manifestRowCountAtSeq(freshPool, walletId, networkId, 2)).toBe(0);
    expect(await completeManifestCount(freshPool, walletId, networkId)).toBe(1);

    // (b) The PRIOR committed seq (1) still load()s and hash-verifies. load() fully rehashes every
    //     chunk AND recomputes the manifest hash before returning (it throws ChunkIntegrityError /
    //     ChunkMissingError / ManifestCorruptError otherwise), so a returned CheckpointRecord is
    //     integrity-verified BY CONSTRUCTION; asserting the exact bytes is the strongest form of
    //     "returns the correct bytes".
    const record = await withSuiteWatchdog(
      () => freshStore.load(walletId, networkId, 1),
      { label: "load-prior-seq-1", timeoutMs: 15_000 },
    );
    expect(record.sequence).toBe(1);
    expect(seq1Bytes.equals(record.data)).toBe(true); // correct bytes ⇒ hash verification passed

    // (c) No ORPHANED junction rows and no DANGLING chunks attributable to the rolled-back save.
    //     This file owns a FRESH container (registerSuiteLifecycle ⇒ a new container), so the ONLY
    //     data present after the kill is this test's prior seq 1: one 512-byte chunk ⇒ exactly one
    //     ckpt_chunks row, one ckpt_manifest_chunks row, one complete manifest. The killed save's
    //     chunk, manifest and junction rows all rolled back with its transaction.
    expect(await orphanJunctionCount(freshPool)).toBe(0); // no junction row → a missing/incomplete manifest
    expect(await danglingChunkCount(freshPool)).toBe(0);  // no chunk left unreferenced by any junction
    expect(await junctionRowCount(freshPool)).toBe(1);    // exactly seq 1's single junction row — none from the killed save

    // ---- Step 4: SAME-PATH NEGATIVE CONTROL (mandatory) — WITHOUT the kill the SAME `save({ tx })`
    //     path COMMITS (change-level re-audit BLOCK 1). Run the second save to COMPLETION via the
    //     `save-tx-commit-control` worker: it opens a caller `withTransaction` and issues
    //     `save(..., { tx })` on it, then COMMITs — the EXACT co-transactional `{tx}` path the killed
    //     `before-commit` leg exercised, differing from it ONLY by the absence of the SIGKILL (NOT a
    //     different, plain-`save()` code path as before). This closes the vacuity where a broken
    //     `{tx}` branch (one returning without writing) would leave the KILLED leg absent regardless
    //     of the kill while an ordinary `save()` control still committed — a T1 that passed without
    //     the kill being the cause. Because the killed txn's seq allocation ALSO rolled back, the
    //     (w, net) counter is still at 2, so this `{tx}` save reuses the SAME interrupted seq (2) —
    //     the exact seq ABSENT in (a) is now PRESENT and complete VIA THE SAME PATH. This is the
    //     OPPOSITE outcome of (a) at the SAME seq on the SAME path, proving the kill CAUSED the
    //     absence in (a) rather than the `{tx}` save path being broken.
    const control = worker({ connectionUri: connectionUri(), schema: TEST_SCHEMA, mode: "save-tx-commit-control", walletId, networkId, payloadHex: seq2Hex });
    const controlReady = await control.waitForReady();
    expect(controlReady.hook).toBeNull();                 // a mode control, not a pause hook
    expect(controlReady.savedSequence).toBe(2); // the {tx} save reused the interrupted seq ⇒ the seq counter rolled back too
    const controlExit = await withSuiteWatchdog(control.waitForExit(), { label: "control-worker-exit", timeoutMs: 15_000 });
    expect(controlExit.code).toBe(0); // the uninterrupted save committed and exited cleanly

    // From ANOTHER fresh client: seq 2 now HAS a visible complete manifest (the opposite of (a)),
    // and load(seq 2) succeeds + hash-verifies.
    const verifyPool = pool();
    const verifyStore = store(verifyPool);
    expect(await completeManifestCountAtSeq(verifyPool, walletId, networkId, 2)).toBe(1); // opposite of (a)
    const controlRecord = await withSuiteWatchdog(
      () => verifyStore.load(walletId, networkId, 2),
      { label: "load-control-seq-2", timeoutMs: 15_000 },
    );
    expect(controlRecord.sequence).toBe(2);
  }, 120_000);
});
