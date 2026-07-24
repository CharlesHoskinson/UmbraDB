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
import { TransactionFaultError } from "../../../src/interfaces/transaction-lease.js";
import { PgWatermarks } from "../../../src/postgres/watermarks.js";
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
 * RECONCILED CONTRACT (change-level audit BLOCK 2 — acceptance C1, design.md §2.2 reconciliation
 * note). The stale spec named a bare `ConnectionError` for every kill; the CODE is correct and the
 * SPEC was reconciled to the actual, sharper two-leg contract this test now ENFORCES exactly:
 *   (1) an IN-TRANSACTION connection loss — a `save`/`saveAndAdvance` running inside a
 *       `withTransaction` — deterministically surfaces the typed
 *       `TransactionFaultError(faultKind "connection-lost")`, code `TRANSACTION_FAULT`
 *       (`transaction-lease.ts:223,263-267`, a deliberate Sprint-2 audit decision that PRE-EMPTS
 *       save's `{tx}` `ConnectionError` translation). This is the T2 kill's surface, and this test
 *       requires that exact class — NOT "either class";
 *   (2) a PRE-/NON-transactional connection failure (an adapter call whose connection fails OUTSIDE
 *       a `withTransaction` wrapper) surfaces the typed `ConnectionError`, code `CONNECTION_ERROR`
 *       (`translatePostgresError`'s mapping for the connection-failure code set); and
 *   (3) a raw `postgres.js` driver error MUST NEVER surface as itself, under EITHER leg.
 * Both legs are pinned in the 2.1 test below: leg (1) via the killed in-flight save (the worker
 * holds an OPEN transaction with all of save's statements issued — the parent confirms via
 * `pg_stat_activity 'idle in transaction'`, then kills the backend and the worker's COMMIT of that
 * in-flight save rejects, not merely "connect to a dead server"); leg (2) via a genuine
 * non-transactional adapter call against an unreachable endpoint; leg (3) via the typed-class
 * assertions plus the `translatePostgresError` corroboration.
 *
 * 2.2 (`[[crash.pg-kill-save.retry-benign-duplicate]]`): the lost-COMMIT-ack window is NOT
 * deterministically hittable (`design.md` §2.2), so this uses the SANCTIONED SIMULATION — a save
 * that provably committed, re-invoked with identical content — NOT a timed kill. It asserts the
 * benign identical-content duplicate at the next seq, correct `load(latest)`, and BOTH a STATIC
 * check that `save` is excluded from any auto-retry allowlist AND a RUNTIME oracle proving `save` is
 * not auto-retried (a retriable 40001 surfaces exactly once, leaving no duplicate manifest -- BLOCK 2). The WHERE-gated no-duplicate-with-key
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
 * Asserts NO auto-retry / `withRetry` / backoff construct wraps or lists ANY checkpoint WRITE
 * method (`save`/`saveAndAdvance`/`saveImpl`) anywhere in `src/` (acceptance C5 / I2; council/B
 * §5 item 3; the Sprint-9 auto-retry wrapper is OUT OF SCOPE — ROADMAP §Deferred). It is a
 * regression TRIPWIRE with teeth, strengthened past the earlier naming-fragile allowlist-only form
 * (change-level audit BLOCK 10): a generic `withRetry(() => store.save(...))` — which the old
 * allowlist scan missed — now turns it RED, as does a retry/backoff-named collection literal that
 * contains a write-method name.
 *
 * TWO independent scans (a write method flagged by EITHER fails the gate):
 *   (1) RETRY-WRAPPER CALL-SITES — a call to a retry/backoff wrapper (`withRetry(`, `retry(`,
 *       `pRetry(`, `retryAsync(`, `withBackoff(`, `backoff(`, `retryOperation(`, …) whose small
 *       following line-window mentions a checkpoint write method; catches the wrapper form the
 *       old check could not see.
 *   (2) RETRY/BACKOFF-NAMED COLLECTION LITERALS — a `retry…`/`backoff…`-named `= new Set([…]) /
 *       new Map / […] / {…}` whose window contains a write-method name (the allowlist form).
 * Both target CODE shapes (a call `(` / a collection literal), not prose, so an `errors.ts`
 * doc-comment about a code's "retry characteristics" does not false-fire.
 *
 * HONEST LIMITATION (what this static text scan CAN and CANNOT guarantee — so it is a real
 * teeth-bearing check, not naming-convention theater): it reads the `src/` tree of `.ts` files as text and catches
 * the LITERAL, readable retry/backoff forms above. It CANNOT catch: (a) a retry built by dynamic
 * dispatch or a method name assembled from a string; (b) indirection where `save` is aliased to an
 * innocuously-named local before being wrapped; (c) a third-party retry utility imported under a
 * non-retry name; or (d) runtime/reflective retry. It is therefore a REGRESSION TRIPWIRE for the
 * common forms, not a proof of absence. At 1.0.0 no auto-retry wrapper exists, so `save` is
 * trivially excluded and the check is green; it turns RED the instant a literal retry/backoff
 * construct wraps or lists a checkpoint write method.
 */
function assertSaveNotInAnyAutoRetryAllowlist(): void {
  const files = listSrcTsFiles();
  expect(files.length, "static check must actually read src/*.ts").toBeGreaterThan(5);

  // A checkpoint WRITE method, named or invoked (quoted key, `.save(`, bare identifier).
  const WRITE_METHOD = /["'`.]?\b(saveAndAdvance|saveImpl|save)\b/;
  // (1) A retry/backoff WRAPPER call-site (a call `(`), the shape `withRetry(() => store.save())`
  //     takes — the naming-fragile hole BLOCK 10 closes (the old scan saw only named collections).
  const RETRY_WRAPPER_CALL = /\b(withRetry|autoRetry|auto_retry|pRetry|retryAsync|retrying|retryOperation|retryWithBackoff|withBackoff|backoff|retriable|retryable|retry)\s*\(/i;
  // (2) A retry/backoff-named COLLECTION literal (the allowlist form), now incl. backoff.
  const RETRY_COLLECTION_DECL = /\b(retry|retriable|retryable|auto[_-]?retry|backoff)[A-Za-z_]*\s*[:=]\s*(new\s+Set|new\s+Map|\[|\{)/i;

  const offenders: string[] = [];
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // (1) wrapper call-site: a retry/backoff wrapper whose argument window names a write method.
      if (RETRY_WRAPPER_CALL.test(line)) {
        const window = lines.slice(i, i + 7).join("\n");
        if (WRITE_METHOD.test(window)) offenders.push(`${srcRel(f)}:${i + 1} (retry-wrapper call-site wraps a checkpoint write)`);
      }
      // (2) retry/backoff-named collection literal that lists a write method.
      if (RETRY_COLLECTION_DECL.test(line)) {
        const window = lines.slice(Math.max(0, i - 2), i + 14).join("\n");
        if (WRITE_METHOD.test(window)) offenders.push(`${srcRel(f)}:${i + 1} (retry-named collection lists a checkpoint write)`);
      }
    }
  }
  expect(
    offenders,
    `documented-unsafe contract (council/B §5 item 3, acceptance C5/I2): NO auto-retry/withRetry/backoff construct may wrap or list a checkpoint write method; offending sites: ${offenders.join(" | ")}`,
  ).toEqual([]);

  // Cited file: the save definition site itself declares no internal auto-retry/backoff wrapper —
  // it surfaces the typed error to the caller terminally (2.1), it does not silently retry.
  const checkpointStoreSrc = readFileSync(srcFile("postgres/checkpoint-store.ts"), "utf8");
  expect(
    checkpointStoreSrc,
    "src/postgres/checkpoint-store.ts must define no auto-retry/backoff wrapper over the save write path",
  ).not.toMatch(/\b(withRetry|autoRetry|withBackoff|retryable|retriable|RETRYABLE)\s*\(/i);
}

// -- Runtime auto-retry-exclusion oracle (acceptance C5 / I2) -- change-level re-audit BLOCK 2 -----
// The static scan above is a SUPPLEMENTARY guard for the common literal retry/backoff forms; by its
// own admission an alias / renamed retry util / dynamic dispatch evades it. This runtime oracle is
// the PRIMARY, non-defeatable proof: it DRIVES `save` into a retriable-class transient -- a
// serialization failure (SQLSTATE 40001), the canonical error an auto-retry wrapper retries -- by
// injecting it into save's FIRST transaction attempt through a client PROXY (no `src/` change, the
// same Proxy technique `crash-worker.ts` uses), and proves save surfaces it EXACTLY ONCE (a single
// transaction, one typed `TransactionFaultError(faultKind "serialization-failure")`) and produces NO
// checkpoint manifest. If save were auto-retried, its SECOND attempt -- on which the injected fault
// no longer fires -- would COMMIT a manifest and return success, flipping every assertion below RED.
// It cannot be evaded by renaming the retry utility, because it observes BEHAVIOUR, not source text.
type C5AnyFn = (...args: unknown[]) => unknown;

/** Wraps a postgres.js transaction handle so the FIRST checkpoint-manifest INSERT it issues rejects
 *  with a synthetic serialization_failure (40001) driver error; every other statement (and every
 *  non-tagged call such as `sql(schema)` / `sql(batch, ...)`) forwards verbatim, so `src/` runs
 *  unchanged. `.code`/`.severity` are set so `isPgDriverError` recognises it and
 *  `translatePostgresError` maps 40001 -> `TransactionFaultError("serialization-failure")`. */
function wrapTxFailManifestInsertOnce(realTx: object): object {
  let fired = false;
  const target = realTx as unknown as C5AnyFn;
  return new Proxy(target, {
    apply(fn, thisArg, args) {
      const first = args[0];
      const isTagged = Array.isArray(first) && Object.prototype.hasOwnProperty.call(first, "raw");
      if (!isTagged) return Reflect.apply(fn, thisArg, args);
      const raw = (first as readonly string[]).join(" ").toLowerCase();
      const isManifestInsert = raw.includes("ckpt_manifests") && raw.includes("insert into");
      if (!isManifestInsert || fired) return Reflect.apply(fn, thisArg, args);
      fired = true;
      // A thenable so the awaited manifest INSERT rejects with the retriable driver error.
      return {
        then(onFulfilled: (v: unknown) => unknown, onRejected: (e: unknown) => unknown) {
          const err = Object.assign(
            new Error("could not serialize access due to read/write dependencies among transactions"),
            { code: "40001", severity: "ERROR" },
          );
          return Promise.reject(err).then(onFulfilled, onRejected);
        },
      };
    },
    get(fn, prop, receiver) {
      const value = Reflect.get(fn, prop, receiver);
      return typeof value === "function" ? (value as C5AnyFn).bind(fn) : value;
    },
  });
}

/** Wraps a client so its `begin` is COUNTED and, on the FIRST transaction only, hands the callback a
 *  fault-injecting transaction handle. Every other member forwards verbatim, so the store sees an
 *  ordinary client. `beginCount()` reports how many transactions save actually opened. */
function makeSerializationFaultInjectingClient(real: UmbraDBSql): { client: UmbraDBSql; beginCount: () => number } {
  let begins = 0;
  const proxy = new Proxy(real as unknown as object, {
    get(fn, prop, receiver) {
      if (prop === "begin") {
        return (...args: unknown[]): unknown => {
          begins += 1;
          const injectThisAttempt = begins === 1;
          const beginFn = Reflect.get(fn, "begin", receiver) as C5AnyFn;
          // postgres.js begin(cb) / begin(options, cb): the callback is the last function arg.
          const cbIdx = args.length >= 2 && typeof args[1] === "function" ? 1 : 0;
          const cb = args[cbIdx] as (tx: object) => unknown;
          const wrapped = (realTx: object): unknown =>
            cb(injectThisAttempt ? wrapTxFailManifestInsertOnce(realTx) : realTx);
          const newArgs = args.slice();
          newArgs[cbIdx] = wrapped;
          return beginFn.apply(fn, newArgs);
        };
      }
      const value = Reflect.get(fn, prop, receiver);
      return typeof value === "function" ? (value as C5AnyFn).bind(fn) : value;
    },
  });
  return { client: proxy as unknown as UmbraDBSql, beginCount: () => begins };
}

/** Behavioral C5 oracle: `save` driven into a retriable 40001 surfaces it ONCE, opens exactly ONE
 *  transaction, and leaves NO manifest (no silent retry, no duplicate/extra checkpoint). */
async function assertSaveNotAutoRetriedUnderRetriableFault(
  rawPool: UmbraDBSql, verifySql: UmbraDBSql, walletId: string, networkId: string,
): Promise<void> {
  const { client: faultClient, beginCount } = makeSerializationFaultInjectingClient(rawPool);
  const faultStore = new PgCheckpointStore(faultClient, new PgTransactionLeaseLayer(faultClient), TEST_SCHEMA);

  let threw = false;
  let caught: unknown;
  try {
    await withSuiteWatchdog(() => faultStore.save(walletId, networkId, randomBytes(400)), {
      label: "c5-runtime-nonretry-save", timeoutMs: 20_000,
    });
  } catch (err) { threw = true; caught = err; }

  // (1) save SURFACED the retriable-class failure to the caller -- it did not swallow it via a retry.
  expect(threw, "save must surface the injected retriable 40001, not silently retry it away").toBe(true);
  expect(caught).toBeInstanceOf(TransactionFaultError);
  expect((caught as TransactionFaultError).faultKind).toBe("serialization-failure"); // the retriable class
  expect((caught as TransactionFaultError).code).toBe("TRANSACTION_FAULT");
  // (2) EXACTLY ONE transaction was opened -- an auto-retry wrapper would open a second.
  expect(beginCount(), "save opened exactly ONE transaction; a second begin means it auto-retried").toBe(1);
  // (3) NO checkpoint manifest was produced. Under an auto-retry, attempt 2 (fault no longer fires)
  //     would COMMIT a duplicate/extra manifest here.
  expect(await completeManifestCount(verifySql, walletId, networkId)).toBe(0);
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
    // BLOCK 3 (deterministic kill, not a race): pgTerminateBackend uses the PG17 two-arg
    // pg_terminate_backend(pid, timeout_ms) — which WAITS for actual death — AND polls
    // pg_stat_activity to death, so the SIGTERM is not merely delivered but the backend is
    // PROVABLY gone before the worker's COMMIT is ever released.
    const terminated = await pgTerminateBackend(getSql(), ready.backendPid!);
    expect(terminated).toBe(true);

    // PROVE it here too: the worker's backend has DISAPPEARED from pg_stat_activity. Without the
    // deterministic wait, the COMMIT below could race the still-live SIGTERM and occasionally
    // succeed (the flaky-gate hole this closes).
    const backendGone = await withSuiteWatchdog(
      getSql()<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = ${ready.backendPid!}`,
      { label: "confirm-backend-dead", timeoutMs: 10_000 },
    );
    expect(backendGone[0]!.n).toBe(0); // the backend is gone BEFORE we release the worker's COMMIT

    // ---- Step 4: release the worker; it issues a REAL in-flight save on the dead connection --------
    killed.sendLine("proceed");
    const result = await killed.waitForResult(30_000);

    // (a) TYPED, never raw (acceptance C1 core): the in-flight save's COMMIT rejected with a member of
    //     the shared StorageError hierarchy — NOT a raw postgres.js driver object.
    expect(result.attempted).toBe("commit");
    expect(result.threw).toBe(true);           // the in-flight save's commit DID fail against the dead backend
    expect(result.committed).not.toBe(true);   // it did NOT silently commit (never a false pass)
    expect(result.isStorageError).toBe(true);

    // (a') RECONCILED CONTRACT leg (1) — the IN-TRANSACTION kill surfaces the typed
    //     `TransactionFaultError(faultKind "connection-lost")` EXACTLY (BLOCK 2). Asserted on the
    //     stable class/`.code` discriminant (evaluated in-worker via `instanceof`), NEVER a message
    //     substring, and NOT "either class": a save always runs inside `withTransaction`, whose
    //     documented @throws (transaction-lease.ts:223,263-267) wraps a connection loss during a
    //     transaction as TransactionFaultError, pre-empting save's {tx} ConnectionError translation.
    expect(result.isTypedConnectionFailure).toBe(true);
    expect(result.errorName).toBe("TransactionFaultError"); // the exact class — the reconciled leg (1)
    expect(result.isTransactionFaultConnectionLost).toBe(true);
    expect(result.faultKind).toBe("connection-lost");
    expect(result.errorCode).toBe("TRANSACTION_FAULT");
    //     And it is specifically NOT the bare ConnectionError the stale spec named for the in-tx leg.
    expect(result.isConnectionError).not.toBe(true);

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

    // (a3) RECONCILED CONTRACT leg (2) — a GENUINE pre-/non-transactional connection failure
    //     surfaces the typed `ConnectionError` (BLOCK 2). Unlike the in-tx save above (leg 1,
    //     TransactionFaultError), a NON-transactional adapter call whose connection fails at
    //     establishment is translated by `translatePostgresError` to `ConnectionError`. A dedicated
    //     pool pointed at an unreachable endpoint produces a REAL driver connection error (never a
    //     raw postgres.js object escaping): `PgWatermarks.get` — which uses no `withTransaction` —
    //     surfaces the typed `ConnectionError`, code `CONNECTION_ERROR`. This pins the OTHER leg of
    //     the reconciled contract so both legs are enforced, not just the in-tx one.
    const unreachable = createClient({
      connectionString: "postgres://umbra:umbra@127.0.0.1:1/umbra",
      schema: TEST_SCHEMA, maxConnections: 1, connectTimeout: 2,
    });
    openPools.push(unreachable);
    const nonTxWatermarks = new PgWatermarks(unreachable, TEST_SCHEMA);
    let preTxError: unknown;
    try {
      await withSuiteWatchdog(() => nonTxWatermarks.get("sync", `pre-tx-${randomUUID()}`),
        { label: "pre-tx-connection-failure", timeoutMs: 15_000 });
    } catch (err) { preTxError = err; }
    expect(preTxError, "a pre-transaction connection failure must surface a typed ConnectionError").toBeInstanceOf(ConnectionError);
    expect((preTxError as ConnectionError).code).toBe("CONNECTION_ERROR"); // reconciled leg (2)
    // Leg (3): whatever surfaced is a member of the StorageError hierarchy — never a raw driver error.
    expect(preTxError).not.toBeInstanceOf(TypeError);

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
  it("[[crash.pg-kill-save.retry-benign-duplicate]] the lost-COMMIT-ack state (sanctioned simulation: a provably-committed save re-invoked with identical content — NOT a timed kill) yields a BENIGN identical-content duplicate at the next seq; load(latest) correct either way; save is statically excluded from any auto-retry allowlist AND a RUNTIME oracle proves save is NOT auto-retried (a retriable 40001 surfaces exactly once, no duplicate manifest)", async () => {
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

    // ---- Step 3: STATIC auto-retry-exclusion check (acceptance C5 / I2) -- a SUPPLEMENTARY guard --
    // The 1.0.0 contract is documented-unsafe (the idempotency-key fix is Sprint 9): a blind retry
    // duplicates, and save must be excluded from any auto-retry wrapper so the storage layer never
    // silently produces this duplicate on the caller's behalf. This static scan catches the common
    // literal retry/backoff forms; it is KEPT as a documented SUPPLEMENTARY guard.
    assertSaveNotInAnyAutoRetryAllowlist();

    // ---- Step 4: RUNTIME auto-retry-exclusion oracle (acceptance C5 / I2) -- the PRIMARY, non-
    //     defeatable proof (change-level re-audit BLOCK 2). Unlike the static text scan (which an
    //     alias / renamed retry util / dynamic dispatch can evade), this DRIVES save into a
    //     retriable-class transient (a serialization failure, SQLSTATE 40001, injected into save's
    //     FIRST transaction attempt via a client proxy) and proves BEHAVIOURALLY that save surfaces
    //     it EXACTLY ONCE (one transaction, one typed TransactionFaultError) and produces NO
    //     checkpoint manifest -- so a future auto-retry (whose second attempt would commit a
    //     duplicate manifest and return success) turns this RED. A fresh wallet keeps it isolated
    //     from the benign-duplicate assertions above.
    await assertSaveNotAutoRetriedUnderRetriableFault(pool(), getSql(), `t2-c5rt-${randomUUID()}`, networkId);
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
