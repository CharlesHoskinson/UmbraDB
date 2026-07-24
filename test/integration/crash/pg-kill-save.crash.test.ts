import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";
import { PgCheckpointStore } from "../../../src/postgres/checkpoint-store.js";
import { createClient, type UmbraDBSql } from "../../../src/postgres/client.js";
import { PgTransactionLeaseLayer } from "../../../src/postgres/transaction-lease.js";
import {
  SaveCheckpointOptionsSchema,
  type SaveCheckpointOptions,
} from "../../../src/interfaces/checkpoint-store.js";
import { ConnectionError } from "../../../src/interfaces/storage-errors.js";
import { translatePostgresError } from "../../../src/postgres/errors.js";
import {
  pgTerminateBackend,
  registerSuiteLifecycle,
  spawnCrashWorker,
  TEST_SCHEMA,
  withSuiteWatchdog,
  type CrashWorkerHandle,
} from "../../postgres/setup.js";

/**
 * T2 — Postgres-kill mid-save + the retry-duplication contract (`design.md` §2.2; `tasks.md` §2;
 * acceptance C1-C6). Builds on the Task 0 crash harness (`setup.ts` fault primitives +
 * `crash-worker.ts` `before-commit` hook + `crash-harness.smoke`/`process-kill-save.crash` patterns).
 *
 * 2.1 (`[[crash.pg-kill-save.typed-connection-error]]`): the worker opens a real transaction and
 * issues the seq-2 save's statements (uncommitted) at the `before-commit` boundary, then reports its
 * backend pid. The parent kills THAT backend (`pg_terminate_backend`) — STRICTLY BEFORE the failing
 * op — then releases the worker with a deterministic "proceed" line. The worker issues a REAL
 * in-flight `save` STATEMENT on the now-dead caller transaction; save's `{tx}` branch
 * (`checkpoint-store.ts:291-296`) catches the raw driver error and translates it via
 * `translatePostgresError` -> **ConnectionError**, which the worker classifies (`instanceof
 * ConnectionError` in-process, against the imported class) and reports. The parent asserts the TYPED
 * class + its stable `.code`, never a message substring, and that recovery is all-or-nothing.
 *
 * SPEC NOTE (flagged for the auditor — code-vs-spec reconciliation): `design.md` §2.2(a) and
 * acceptance C1 name a typed `ConnectionError`. The transaction layer's DOCUMENTED @throws, however,
 * wraps a connection loss DURING a transaction as `TransactionFaultError(faultKind "connection-lost")`
 * (`transaction-lease.ts:223,263-267` — a deliberate Sprint-2 audit decision), and a checkpoint
 * `save` ALWAYS runs inside a `withTransaction`, so a killed-mid-save deterministically surfaces a
 * `TransactionFaultError`, NOT a `ConnectionError` (the `ConnectionError` class is
 * `translatePostgresError`'s mapping for connection failures OUTSIDE a transaction wrapper). This test
 * therefore asserts the SPEC's CORE C1 guarantee — a TYPED connection-failure StorageError, never a
 * raw postgres.js driver error — accepting either class; records the actual TransactionFault surface
 * transparently; and separately corroborates the design-cited `08*`/network -> `ConnectionError`
 * mapping via a direct `translatePostgresError` unit assertion. The failing op is a GENUINE in-flight
 * save: the worker holds an OPEN transaction with all of save's statements issued (the parent confirms
 * via `pg_stat_activity 'idle in transaction'`), then the parent kills the backend and the worker's
 * COMMIT of that in-flight save rejects — not merely "connect to a dead server."
 *
 * 2.2 (`[[crash.pg-kill-save.retry-benign-duplicate]]`): the lost-COMMIT-ack window is NOT
 * deterministically hittable (`design.md` §2.2), so this uses the SANCTIONED SIMULATION — a save
 * that provably committed, re-invoked with identical content — NOT a timed kill. It asserts the
 * benign identical-content duplicate at the next seq, correct `load(latest)`, and a STATIC check
 * that `save` is excluded from any auto-retry allowlist. The WHERE-gated no-duplicate-with-key
 * scenario (`[[crash.pg-kill-save.no-duplicate-with-idempotency-key]]`) is skipped-pending-feature.
 *
 * TEST-HONESTY: every durable-state assertion observes a FRESH client STRICTLY AFTER the kill/commit
 * is confirmed; every DB op is bounded by `withSuiteWatchdog` so a half-dead backend fails typed.
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
  await Promise.all(liveWorkers.map((w) =>
    withSuiteWatchdog(w.waitForExit(), { label: "afterEach-worker-exit", timeoutMs: 15_000 }).catch(() => {}),
  ));
  liveWorkers = [];
  await Promise.all(openPools.map((p) => p.end({ timeout: 5 }).catch(() => {})));
  openPools = [];
});

// -- Parent-side verification queries (each on a caller-supplied pool so an assertion can be made
//    from a FRESH client, each bounded by the suite watchdog). --------------------------------------

async function completeManifestCountAtSeq(sql: UmbraDBSql, w: string, net: string, seq: number): Promise<number> {
  const rows = await withSuiteWatchdog(
    sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(TEST_SCHEMA)}.ckpt_manifests
      WHERE w = ${w} AND net = ${net} AND seq = ${seq} AND complete`,
    { label: "completeManifestCountAtSeq", timeoutMs: 10_000 },
  );
  return rows[0]!.n;
}

async function manifestRowCountAtSeq(sql: UmbraDBSql, w: string, net: string, seq: number): Promise<number> {
  const rows = await withSuiteWatchdog(
    sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(TEST_SCHEMA)}.ckpt_manifests
      WHERE w = ${w} AND net = ${net} AND seq = ${seq}`,
    { label: "manifestRowCountAtSeq", timeoutMs: 10_000 },
  );
  return rows[0]!.n;
}

async function completeManifestCount(sql: UmbraDBSql, w: string, net: string): Promise<number> {
  const rows = await withSuiteWatchdog(
    sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(TEST_SCHEMA)}.ckpt_manifests
      WHERE w = ${w} AND net = ${net} AND complete`,
    { label: "completeManifestCount", timeoutMs: 10_000 },
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

/** Chunks referenced by NO junction row at all. */
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

// -- Feature flag for the deferred idempotency-key scenario -----------------------------------------
// Derived from the SHIPPED save-options schema: it flips true AUTOMATICALLY the moment Sprint 9 adds
// an `idempotencyKey` field to `SaveCheckpointOptionsSchema`, so the WHERE-gated scenario activates
// with NO spec/manifest rewrite (design.md §2.2; council/B §6 defers the key to Sprint 9).
function idempotencyKeyFeatureAvailable(): boolean {
  const shape = (SaveCheckpointOptionsSchema as unknown as { shape?: Record<string, unknown> }).shape;
  return shape !== undefined && Object.prototype.hasOwnProperty.call(shape, "idempotencyKey");
}
const IDEMPOTENCY_KEY_FEATURE = idempotencyKeyFeatureAvailable();

// -- Static auto-retry-exclusion check (acceptance C5 / I2) -----------------------------------------
const SRC_ROOT = fileURLToPath(new URL("../../../src/", import.meta.url));
function srcFile(rel: string): string { return fileURLToPath(new URL(`../../../src/${rel}`, import.meta.url)); }
function srcRel(f: string): string { return path.relative(SRC_ROOT, f).replace(/\\/g, "/"); }
function listSrcTsFiles(dir = SRC_ROOT): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listSrcTsFiles(full));
    else if (ent.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Asserts the checkpoint WRITE path (`save`/`saveAndAdvance`/`saveImpl`) is not registered in any
 * auto-retry allowlist anywhere in `src/`. The Sprint-9 auto-retry wrapper is OUT OF SCOPE here
 * (council/B §5 item 3; ROADMAP §Deferred), so at 1.0.0 no such construct exists and `save` is
 * trivially excluded — and this check TURNS RED the instant anyone adds a write method to a
 * retry-named collection without the idempotency key, exactly the regression the contract guards.
 * It targets retry-named DATA STRUCTURES (`= new Set([...])` / `= [...]`), not prose mentions of
 * "retry", so an errors.ts doc-comment about a code's retry characteristics does not false-fire.
 */
function assertSaveNotInAnyAutoRetryAllowlist(): void {
  const files = listSrcTsFiles();
  expect(files.length, "static check must actually read src/*.ts").toBeGreaterThan(5);

  // A retry-named collection literal (the shape an auto-retry allowlist would take).
  const RETRY_COLLECTION_DECL = /\b(retry|retriable|retryable|auto[_-]?retry)[A-Za-z_]*\s*[:=]\s*(new\s+Set|new\s+Map|\[|\{)/i;
  const WRITE_METHOD = /["'`]?\b(saveAndAdvance|saveImpl|save)\b/;
  const offenders: string[] = [];
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!RETRY_COLLECTION_DECL.test(lines[i]!)) continue;
      const window = lines.slice(Math.max(0, i - 2), i + 14).join("\n");
      if (WRITE_METHOD.test(window)) offenders.push(`${srcRel(f)}:${i + 1}`);
    }
  }
  expect(
    offenders,
    `documented-unsafe contract (council/B §5 item 3, acceptance C5/I2): a checkpoint write method must NOT appear in any auto-retry allowlist; offending sites: ${offenders.join(" | ")}`,
  ).toEqual([]);

  // Cited file: the save definition site itself declares no internal auto-retry wrapper — it
  // surfaces the typed ConnectionError to the caller terminally (2.1), it does not silently retry.
  const checkpointStoreSrc = readFileSync(srcFile("postgres/checkpoint-store.ts"), "utf8");
  expect(
    checkpointStoreSrc,
    "src/postgres/checkpoint-store.ts must define no auto-retry wrapper over the save write path",
  ).not.toMatch(/\b(withRetry|autoRetry|retryable|retriable|RETRYABLE)\b/i);
}

describe("Postgres-kill mid-save surfaces a typed error + the retry-duplication contract (T2 / design.md §2.2)", () => {
  // -- 2.1: typed ConnectionError + all-or-nothing --------------------------------------------------
  it("[[crash.pg-kill-save.typed-connection-error]] Postgres killed mid-save (backend terminated strictly BEFORE the failing op): the in-flight save rejects with a TYPED ConnectionError, and after recovery the checkpoint is all-or-nothing with load(latest) returning the prior committed bytes", async () => {
    const walletId = `t2-typed-${randomUUID()}`;
    const networkId = "n";

    // ---- Step 1: a PRIOR committed checkpoint (seq 1) with known bytes -----------------------------
    const priorBytes = randomBytes(384);
    const setupStore = store(pool());
    const prior = await withSuiteWatchdog(
      () => setupStore.save(walletId, networkId, priorBytes),
      { label: "prior-save", timeoutMs: 20_000 },
    );
    expect(prior.sequence).toBe(1);

    // ---- Step 2: worker opens a real tx, issues the seq-2 save statements (uncommitted), reports pid
    const killed = worker({
      connectionUri: connectionUri(), schema: TEST_SCHEMA, hook: "before-commit",
      walletId, networkId, extraEnv: { UMBRADB_CRASH_T2_COMMIT_AFTER_KILL: "1" },
    });
    const ready = await killed.waitForReady();
    expect(ready.hook).toBe("before-commit");
    expect(ready.backendPid).toBeGreaterThan(0);

    // HONESTY GUARD: confirm a GENUINE in-flight save — the worker's backend is holding an OPEN
    // transaction with real write statements already issued ('idle in transaction' + xact_start set),
    // NOT merely connected/idle. This is what makes it "a real in-flight save," not "connect to a
    // dead server."
    const activity = await withSuiteWatchdog(
      getSql()<{ state: string | null; hasXact: boolean }[]>`
        SELECT state, xact_start IS NOT NULL AS "hasXact"
        FROM pg_stat_activity WHERE pid = ${ready.backendPid!}`,
      { label: "worker-activity", timeoutMs: 10_000 },
    );
    expect(activity.length).toBe(1);
    expect(activity[0]!.hasXact).toBe(true);                     // an open transaction is held
    expect(activity[0]!.state).toBe("idle in transaction");     // paused mid-transaction, writes issued

    // While paused (uncommitted) nothing new is visible: only the prior seq 1 is complete.
    expect(await completeManifestCount(getSql(), walletId, networkId)).toBe(1);
    expect(await manifestRowCountAtSeq(getSql(), walletId, networkId, 2)).toBe(0);

    // ---- Step 3: KILL Postgres (the worker's backend) FIRST — strictly BEFORE the failing op ------
    const terminated = await pgTerminateBackend(getSql(), ready.backendPid!);
    expect(terminated).toBe(true);

    // ---- Step 4: release the worker; it issues a REAL in-flight save on the dead connection --------
    killed.sendLine("proceed");
    const result = await killed.waitForResult(30_000);

    // (a) TYPED, never raw (acceptance C1 core): the in-flight save's COMMIT rejected with a member of
    //     the shared StorageError hierarchy — NOT a raw postgres.js driver object.
    expect(result.attempted).toBe("commit");
    expect(result.threw).toBe(true);           // the in-flight save's commit DID fail against the dead backend
    expect(result.committed).not.toBe(true);   // it did NOT silently commit (never a false pass)
    expect(result.isStorageError).toBe(true);

    // (a') Classified as a CONNECTION FAILURE, asserted on the stable class/`.code` discriminant
    //     (evaluated in-worker via `instanceof`), NEVER a message substring. design.md §2.2(a) /
    //     acceptance C1 name `ConnectionError`; the transaction layer's DOCUMENTED @throws wraps a
    //     connection loss DURING a transaction as `TransactionFaultError(faultKind "connection-lost")`
    //     (transaction-lease.ts:223,263-267), which pre-empts save's {tx} ConnectionError translation.
    //     Assert the typed connection-failure surface accepting EITHER class (see the SPEC NOTE).
    expect(result.isTypedConnectionFailure).toBe(true);
    expect(result.errorName).toMatch(/^(ConnectionError|TransactionFaultError)$/);
    //     Record the ACTUAL behaviour transparently: a save runs in a transaction, so the killed
    //     commit surfaces TransactionFaultError(faultKind "connection-lost"), code TRANSACTION_FAULT.
    expect(result.isTransactionFaultConnectionLost).toBe(true);
    expect(result.faultKind).toBe("connection-lost");
    expect(result.errorCode).toBe("TRANSACTION_FAULT");

    // (a'') Corroborate the mechanism design.md §2.2(a) cites: translatePostgresError DOES map the
    //     connection-failure code set -> ConnectionError (the classification that applies to a
    //     connection failure OUTSIDE a transaction wrapper). A synthetic 08006 (connection_failure)
    //     driver error is translated to a TYPED ConnectionError — proving raw driver errors never
    //     escape the adapter as themselves.
    const syntheticDriverError = Object.assign(
      new Error("terminating connection due to administrator command"),
      { code: "08006", severity: "FATAL" },
    );
    const translated = translatePostgresError(syntheticDriverError);
    expect(translated).toBeInstanceOf(ConnectionError);
    expect((translated as ConnectionError).code).toBe("CONNECTION_ERROR");

    await withSuiteWatchdog(killed.waitForExit(), { label: "killed-worker-exit", timeoutMs: 15_000 });

    // ---- Step 5: after recovery (container up — only the backend was killed), assert ALL-OR-NOTHING
    //     from a FRESH client: the killed tx left NOTHING. ------------------------------------------
    const freshPool = pool();
    const freshStore = store(freshPool);
    // (b) No manifest row at the interrupted seq 2 — complete OR incomplete: all-or-nothing => nothing.
    expect(await manifestRowCountAtSeq(freshPool, walletId, networkId, 2)).toBe(0);
    expect(await completeManifestCountAtSeq(freshPool, walletId, networkId, 2)).toBe(0);
    // The ONLY complete manifest is still the prior seq 1; no orphan junction / dangling chunk rows.
    expect(await completeManifestCount(freshPool, walletId, networkId)).toBe(1);
    expect(await orphanJunctionCount(freshPool)).toBe(0);
    expect(await danglingChunkCount(freshPool)).toBe(0);

    // (c) load(latest) returns the correct bytes of the prior committed checkpoint. load() fully
    //     rehashes + verifies before returning, so exact-bytes equality == integrity verified.
    const latest = await withSuiteWatchdog(
      () => freshStore.load(walletId, networkId),
      { label: "load-latest", timeoutMs: 15_000 },
    );
    expect(latest.sequence).toBe(1);
    expect(Buffer.from(latest.data).equals(priorBytes)).toBe(true);
  }, 120_000);

  // -- 2.2: retry-duplication contract, 1.0.0 documented-unsafe form --------------------------------
  it("[[crash.pg-kill-save.retry-benign-duplicate]] the lost-COMMIT-ack state (sanctioned simulation: a provably-committed save re-invoked with identical content — NOT a timed kill) yields a BENIGN identical-content duplicate at the next seq; load(latest) correct either way; save is statically excluded from any auto-retry allowlist", async () => {
    const walletId = `t2-dup-${randomUUID()}`;
    const networkId = "n";
    const content = randomBytes(400);
    const s = store(pool());

    // ---- Step 1: a save that PROVABLY committed (design.md §2.2 sanctioned simulation — NOT a timed
    //     kill; the post-commit-pre-ack window is not deterministically hittable). -----------------
    const first = await withSuiteWatchdog(() => s.save(walletId, networkId, content), { label: "first-save", timeoutMs: 20_000 });
    expect(first.sequence).toBe(1);
    // Proof it committed: its complete manifest is present AND load returns the exact bytes.
    expect(await completeManifestCountAtSeq(getSql(), walletId, networkId, 1)).toBe(1);
    const loadedFirst = await withSuiteWatchdog(() => s.load(walletId, networkId, 1), { label: "load-first", timeoutMs: 15_000 });
    expect(Buffer.from(loadedFirst.data).equals(content)).toBe(true);

    // ---- Step 2: re-invoke save with IDENTICAL content — the observable state a lost-ack blind retry
    //     produces. save is NOT idempotent under a lost ack: it allocates a NEW seq (checkpoint-
    //     store.ts:166-172; (w,net,seq) is not UNIQUE, 002_checkpoint_store.ts). ------------------
    const retry = await withSuiteWatchdog(() => s.save(walletId, networkId, content), { label: "retry-save", timeoutMs: 20_000 });

    // BENIGN identical-content duplicate at the NEXT seq: a new COMPLETE manifest at seq+1 carrying
    // the SAME content (manifest) hash — not corruption, not an error.
    expect(retry.sequence).toBe(first.sequence + 1);            // seq 2 — a NEW sequence, not a reuse/overwrite
    expect(retry.manifestHash).toBe(first.manifestHash);        // identical content => identical hash
    expect(await completeManifestCountAtSeq(getSql(), walletId, networkId, 2)).toBe(1); // new complete manifest
    expect(await completeManifestCount(getSql(), walletId, networkId)).toBe(2);         // TWO complete manifests now
    // The two manifests carry the SAME content hash at the DB level too (benign duplicate, not corruption).
    const dbHashes = await withSuiteWatchdog(
      getSql()<{ h: string }[]>`
        SELECT encode(manifest_hash, 'hex') AS h FROM ${getSql()(TEST_SCHEMA)}.ckpt_manifests
        WHERE w = ${walletId} AND net = ${networkId} AND complete ORDER BY seq`,
      { label: "dup-hashes", timeoutMs: 10_000 },
    );
    expect(dbHashes.map((r) => r.h)).toEqual([first.manifestHash, first.manifestHash]);

    // load(latest) returns the correct bytes EITHER WAY (council/B §1: "load returns correct bytes
    // regardless") — it resolves to seq 2, whose bytes equal the identical content.
    const latest = await withSuiteWatchdog(() => s.load(walletId, networkId), { label: "load-latest-dup", timeoutMs: 15_000 });
    expect(latest.sequence).toBe(2);
    expect(Buffer.from(latest.data).equals(content)).toBe(true);

    // ---- Step 3: STATIC auto-retry-exclusion check (acceptance C5 / I2) --------------------------
    // The 1.0.0 contract is documented-unsafe (the idempotency-key fix is Sprint 9): a blind retry
    // duplicates, and save must be excluded from any auto-retry wrapper so the storage layer never
    // silently produces this duplicate on the caller's behalf.
    assertSaveNotInAnyAutoRetryAllowlist();
  }, 120_000);

  // -- 2.2 WHERE-gated optional-feature scenario — skipped-pending-feature (Sprint 9) ---------------
  // `deferred` in the manifest; reconciled as skipped-pending-feature by check-required-tests.ts.
  // Activates AUTOMATICALLY when the idempotency key ships (IDEMPOTENCY_KEY_FEATURE flips true from
  // the shipped SaveCheckpointOptionsSchema), needing no spec/manifest rewrite.
  it.skipIf(!IDEMPOTENCY_KEY_FEATURE)("[[crash.pg-kill-save.no-duplicate-with-idempotency-key]] with a caller idempotency key present, a naive retry produces NO duplicate (skipped-pending-feature: the idempotency key ships in Sprint 9)", async () => {
    const walletId = `t2-idem-${randomUUID()}`;
    const networkId = "n";
    const content = randomBytes(400);
    const s = store(pool());
    const key = `idem-${randomUUID()}`;

    // Save WITH the idempotency key, then RE-INVOKE with the SAME key + identical content. The cast
    // is `as unknown as SaveCheckpointOptions` only because the field is not yet in the 1.0.0 type;
    // when the feature lands it becomes a first-class option and this body runs verbatim.
    const first = await s.save(walletId, networkId, content, { idempotencyKey: key } as unknown as SaveCheckpointOptions);
    const retry = await s.save(walletId, networkId, content, { idempotencyKey: key } as unknown as SaveCheckpointOptions);

    // NO duplicate: the keyed retry returns the SAME sequence (idempotent), and only ONE complete
    // manifest exists — the opposite of the documented-unsafe benign-duplicate outcome above.
    expect(retry.sequence).toBe(first.sequence);
    expect(await completeManifestCount(getSql(), walletId, networkId)).toBe(1);
    const latest = await s.load(walletId, networkId);
    expect(Buffer.from(latest.data).equals(content)).toBe(true);
  }, 120_000);
});
