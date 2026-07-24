import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { runMigrations } from "../../src/postgres/migrate.js";

/**
 * One shared, session-scoped Postgres container for the whole test run
 * (`openspec/changes/sprint-1-setup-and-temporal-kv/design.md` §5) — container startup cost is
 * real and shouldn't be paid per-test. Each test file is responsible for cleaning up its own
 * data (`TRUNCATE` between tests), not relying on a fresh container per test.
 *
 * Uses `createClient` (not a raw `postgres()` call) specifically so the `types.bigint` mapping
 * is actually configured on this connection — that mapping is runtime behavior of the
 * connection object itself, not something a TypeScript type assertion at the call site can
 * substitute for. A test setup using a differently-configured connection would silently return
 * `version` as a string at runtime while the adapter's own types still claimed `bigint`.
 */
let container: StartedPostgreSqlContainer;
let adminSql: UmbraDBSql;

export const TEST_SCHEMA = "umbradb_test";

export async function startTestDatabase(): Promise<UmbraDBSql> {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  adminSql = createClient({ connectionString: container.getConnectionUri(), schema: TEST_SCHEMA, maxConnections: 5 });
  await runMigrations(adminSql, { schema: TEST_SCHEMA });
  return adminSql;
}

export async function stopTestDatabase(): Promise<void> {
  await adminSql?.end({ timeout: 5 });
  await container?.stop();
}

export function registerSuiteLifecycle(): { sql: () => UmbraDBSql; connectionUri: () => string } {
  let sql: UmbraDBSql;
  beforeAll(async () => {
    sql = await startTestDatabase();
  }, 120_000);
  afterAll(async () => {
    await stopTestDatabase();
  }, 60_000); // teardown can exceed the 10s default under heavy host load (container.stop)
  // Exposed so a test that needs its OWN dedicated, small (e.g. maxConnections: 1) pool against
  // the SAME database -- rather than the shared suite pool, whose physical connection a given
  // query lands on is not deterministic -- doesn't have to spin up a second container.
  return { sql: () => sql, connectionUri: () => container.getConnectionUri() };
}

// ===========================================================================================
// v1.0.0-recovery-testing — Task 0 crash-harness fault primitives (`design.md` §1)
//
// Three deterministic fault primitives, layered on the SAME shared session-scoped container the
// suite already runs (`registerSuiteLifecycle().connectionUri()` — its documented "own dedicated
// pool against the same database" hook), so NO second container is spun up:
//   1. child-process spawn + SIGKILL of the `crash-worker.ts` writer entrypoint;
//   2. `pg_terminate_backend(pid)` of a target backend, captured from a second connection;
//   3. Testcontainers `container.restart()` / `container.stop()` of the shared container.
// Plus the suite-level watchdog backstop (`design.md` §1, Task 0.3): `SUITE_WATCHDOG_MS` +
// `withSuiteWatchdog`, an independent bound so a half-dead Postgres fails the pending op with a
// typed error instead of hanging, even if G7's server-side timeouts are absent/misconfigured.
// ===========================================================================================

// ---- Primitive 3: shared-container lifecycle control (Testcontainers) ---------------------

/** The shared session-scoped container, for advanced control (e.g. an in-container `kill -9`
 *  of the postmaster on the T5 `synchronous_commit = off` leg). Throws if the suite lifecycle
 *  has not started it yet. */
export function getTestContainer(): StartedPostgreSqlContainer {
  if (container === undefined) {
    throw new Error("getTestContainer(): no shared container — call registerSuiteLifecycle()/startTestDatabase() first");
  }
  return container;
}

/** Testcontainers restart of the shared container (a CLEAN, WAL-flushing bounce — the T2
 *  "kill Postgres mid-op" primitive). Wrapped by the suite watchdog so a wedged restart fails
 *  typed rather than hanging the suite. */
export async function restartTestContainer(opts?: { timeoutMs?: number }): Promise<void> {
  await withSuiteWatchdog(getTestContainer().restart(), { label: "container.restart", timeoutMs: opts?.timeoutMs });
}

/** Testcontainers stop of the shared container. */
export async function stopTestContainer(opts?: { timeoutMs?: number }): Promise<void> {
  await withSuiteWatchdog(
    getTestContainer().stop().then(() => undefined),
    { label: "container.stop", timeoutMs: opts?.timeoutMs },
  );
}

// ---- Primitive 2: backend-pid capture + pg_terminate_backend ------------------------------

/**
 * Captures the backend pid serving `sql`. Only deterministic on a **dedicated single-connection
 * pool** (`createClient({ ..., maxConnections: 1 })` or a `reserve()`d connection) — on a
 * multi-connection pool the query can land on any physical backend, so the returned pid would not
 * reliably identify a subsequent statement's connection. The crash worker captures its own backend
 * pid this way at the fault point (`design.md` §1).
 */
export async function backendPid(sql: UmbraDBSql): Promise<number> {
  const rows = await sql<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
  return rows[0]!.pid;
}

/**
 * Terminates a target backend `pid` from a SECOND connection (`admin`, which must not itself be
 * that backend), returning `pg_terminate_backend`'s boolean. This is the "kill Postgres mid-op"
 * primitive that drops a specific in-flight connection without stopping the whole postmaster
 * (`design.md` §1, T2). Postgres sends the target backend a SIGTERM and closes its socket; a
 * dedicated pool observing the drop then reconnects on its next statement.
 */
export async function pgTerminateBackend(admin: UmbraDBSql, pid: number): Promise<boolean> {
  const rows = await admin<{ terminated: boolean }[]>`SELECT pg_terminate_backend(${pid}) AS terminated`;
  return rows[0]!.terminated;
}

// ---- Primitive 1: crash-worker spawn + SIGKILL --------------------------------------------

/** The four named program points the crash worker pauses at (`design.md` §1). Each pauses BETWEEN
 *  two real storage operations — never on a wall-clock timer — so the SIGKILL that follows lands
 *  at a reproducible point. See `crash-worker.ts` for the precise before/after boundary of each. */
export type CrashHook =
  | "before-commit"
  | "in-critical-section"
  | "after-data-commit-before-cursor"
  | "after-cursor-before-data";

/** The readiness payload the worker prints once it has paused at its named point. */
export interface CrashWorkerReady {
  /** The hook the worker paused at, or `null` when it ran an ordinary uninterrupted `save`. */
  hook: CrashHook | null;
  /** The worker OS process id. */
  pid: number;
  /** The backend pid of the connection holding the paused work (present for `before-commit`) —
   *  the target for a `pg_terminate_backend`/Postgres-kill of the worker's own session (T2). */
  backendPid?: number;
  /** The committed checkpoint sequence (present for `after-data-commit-before-cursor`). */
  savedSequence?: number;
  /** The advisory-lock key held (present for `in-critical-section`). */
  lockKey?: string;
  /** `hashtext(lockKey)` — the `objid` of the class-2 advisory lock in `pg_locks` (T3). */
  lockKeyHash?: number;
  [k: string]: unknown;
}

export interface SpawnCrashWorkerOptions {
  /** Connection URI of the shared container (`registerSuiteLifecycle().connectionUri()`). */
  connectionUri: string;
  /** Schema the worker operates in — reuse {@link TEST_SCHEMA}; the worker runs NO migrations. */
  schema: string;
  /** The named fault hook, or omit for an ordinary uninterrupted `save`. */
  hook?: CrashHook;
  walletId?: string;
  networkId?: string;
  /** Watermark cursor (kind, key, value) for the T5 hooks; `cursorValue` is JSON. */
  cursorKind?: string;
  cursorKey?: string;
  cursorValue?: unknown;
  /** Advisory-lock key for `in-critical-section`. */
  leaseKey?: string;
  /** Checkpoint payload size in bytes (default 256). */
  payloadBytes?: number;
  /** Extra environment overrides (e.g. a per-session `synchronous_commit`). */
  extraEnv?: Record<string, string>;
}

/** Sentinel prefixes the worker writes on stdout so the parent can find its lines amid tsx /
 *  driver noise. Kept in sync with `crash-worker.ts`. */
export const CRASH_WORKER_READY_SENTINEL = "@@CRASH_WORKER_READY@@";
export const CRASH_WORKER_ERROR_SENTINEL = "@@CRASH_WORKER_ERROR@@";

export interface CrashWorkerHandle {
  readonly child: ChildProcess;
  readonly pid: number | undefined;
  /** Resolves with the readiness payload once the worker has paused at its named point (or run
   *  an ordinary save). Rejects if the worker errors, exits before signalling, or `timeoutMs`
   *  elapses. */
  waitForReady(timeoutMs?: number): Promise<CrashWorkerReady>;
  /** Resolves once the child process has exited. */
  waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Deterministic hard kill (SIGKILL) — the "kill the app mid-op" primitive (T1/T3/T5). */
  sigkill(): void;
  /** Everything the worker has written to stdout / stderr so far (for diagnostics). */
  stdout(): string;
  stderr(): string;
}

const WORKER_ENTRYPOINT = fileURLToPath(new URL("../integration/crash/crash-worker.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const DEFAULT_READY_TIMEOUT_MS = 30_000;

/**
 * Spawns `crash-worker.ts` as a real, separate OS process via `node --import tsx` (tsx is already
 * a devDependency; no new pin), connected to the SHARED container. Because `--import tsx` runs
 * in-process (no wrapping shell), `child.pid` IS the worker's node process, so `sigkill()` is a
 * literal cross-process `SIGKILL` of the writer mid-operation — the deterministic fault the crash
 * tests need. The worker owns its own transaction/lease orchestration and pauses at a named
 * program point (`UMBRADB_CRASH_HOOK`); it touches NO `src/` code.
 */
export function spawnCrashWorker(opts: SpawnCrashWorkerOptions): CrashWorkerHandle {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    UMBRADB_TEST_CONNECTION_URI: opts.connectionUri,
    UMBRADB_TEST_SCHEMA: opts.schema,
    ...(opts.hook !== undefined ? { UMBRADB_CRASH_HOOK: opts.hook } : {}),
    ...(opts.walletId !== undefined ? { UMBRADB_CRASH_WALLET: opts.walletId } : {}),
    ...(opts.networkId !== undefined ? { UMBRADB_CRASH_NETWORK: opts.networkId } : {}),
    ...(opts.cursorKind !== undefined ? { UMBRADB_CRASH_CURSOR_KIND: opts.cursorKind } : {}),
    ...(opts.cursorKey !== undefined ? { UMBRADB_CRASH_CURSOR_KEY: opts.cursorKey } : {}),
    ...(opts.cursorValue !== undefined ? { UMBRADB_CRASH_CURSOR_VALUE: JSON.stringify(opts.cursorValue) } : {}),
    ...(opts.leaseKey !== undefined ? { UMBRADB_CRASH_LEASE_KEY: opts.leaseKey } : {}),
    ...(opts.payloadBytes !== undefined ? { UMBRADB_CRASH_PAYLOAD_BYTES: String(opts.payloadBytes) } : {}),
    ...(opts.extraEnv ?? {}),
  };

  const child = spawn(process.execPath, ["--import", "tsx", WORKER_ENTRYPOINT], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  let ready: CrashWorkerReady | undefined;
  let readyErr: Error | undefined;
  const readyWaiters: Array<() => void> = [];
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const exitWaiters: Array<() => void> = [];

  const settleReady = (): void => { while (readyWaiters.length) readyWaiters.shift()!(); };

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    if (ready === undefined && readyErr === undefined) {
      for (const line of stdoutBuf.split("\n")) {
        const r = line.indexOf(CRASH_WORKER_READY_SENTINEL);
        const e = line.indexOf(CRASH_WORKER_ERROR_SENTINEL);
        if (r >= 0) {
          try { ready = JSON.parse(line.slice(r + CRASH_WORKER_READY_SENTINEL.length)) as CrashWorkerReady; }
          catch (err) { readyErr = new Error(`crash worker readiness line was not valid JSON: ${String(err)}`); }
          settleReady();
          return;
        }
        if (e >= 0) {
          readyErr = new Error(`crash worker reported an error before readiness: ${line.slice(e + CRASH_WORKER_ERROR_SENTINEL.length).trim()}`);
          settleReady();
          return;
        }
      }
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderrBuf += chunk; });

  child.on("exit", (code, signal) => {
    exited = { code, signal };
    if (ready === undefined && readyErr === undefined) {
      readyErr = new Error(
        `crash worker exited (code=${String(code)}, signal=${String(signal)}) before signalling readiness.\nstderr:\n${stderrBuf}`,
      );
      settleReady();
    }
    while (exitWaiters.length) exitWaiters.shift()!();
  });
  child.on("error", (err) => {
    if (ready === undefined && readyErr === undefined) {
      readyErr = new Error(`failed to spawn crash worker: ${err.message}`);
      settleReady();
    }
  });

  return {
    child,
    get pid() { return child.pid; },
    stdout: () => stdoutBuf,
    stderr: () => stderrBuf,
    waitForReady(timeoutMs = DEFAULT_READY_TIMEOUT_MS): Promise<CrashWorkerReady> {
      return new Promise<CrashWorkerReady>((resolve, reject) => {
        const done = (): void => {
          if (ready !== undefined) resolve(ready);
          else reject(readyErr ?? new Error("crash worker readiness settled without a result"));
        };
        if (ready !== undefined || readyErr !== undefined) { done(); return; }
        const timer = setTimeout(() => {
          reject(new SuiteWatchdogTimeoutError("crash-worker readiness", timeoutMs));
        }, timeoutMs);
        readyWaiters.push(() => { clearTimeout(timer); done(); });
      });
    },
    waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
      return new Promise((resolve) => {
        if (exited !== undefined) { resolve(exited); return; }
        exitWaiters.push(() => resolve(exited!));
      });
    },
    sigkill(): void { child.kill("SIGKILL"); },
  };
}

/** Generic SIGKILL of any child process (the child-process kill primitive, exposed for callers
 *  that spawn their own helper processes). */
export function sigkillChild(child: ChildProcess): void {
  child.kill("SIGKILL");
}

// ---- Task 0.3: suite-level watchdog backstop (`design.md` §1) ------------------------------

/**
 * Independent, JS-level termination bound wrapping every crash/soak operation. G7's server-side
 * `statement_timeout`/`lock_timeout`/`idle_in_transaction_session_timeout` are the primary bound;
 * this backstop is a SPEC-level guarantee that the suites terminate within a bounded wall-clock
 * even if G7's timeouts are absent or misconfigured (a wedged required gate would itself ship the
 * durability guarantee unverified). It is deliberately larger than the slowest legitimate
 * primitive (a `container.restart()` under host load) and far smaller than "hangs forever".
 * Per-call `timeoutMs` overrides it (e.g. a fault-injection unit uses a small bound to prove the
 * mechanism fires fast).
 */
export const SUITE_WATCHDOG_MS = 60_000;

/** Typed timeout raised by {@link withSuiteWatchdog} — a wedged op fails with THIS, never a hang
 *  and never a raw driver error. */
export class SuiteWatchdogTimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`suite watchdog: "${label}" did not complete within ${timeoutMs}ms`);
    this.name = "SuiteWatchdogTimeoutError";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

type Cancellable = { cancel?: () => unknown };

/**
 * Races `work` against a `timeoutMs` timer (default {@link SUITE_WATCHDOG_MS}). If the timer wins,
 * best-effort cancels the underlying work (a `postgres.js` query exposes `.cancel()`), invokes
 * `onTimeout`, and rejects with a typed {@link SuiteWatchdogTimeoutError}. If `work` settles first,
 * the timer is cleared and its result/rejection is passed through unchanged.
 */
export async function withSuiteWatchdog<T>(
  work: (PromiseLike<T> & Cancellable) | (() => PromiseLike<T> & Cancellable) | (() => PromiseLike<T>),
  opts: { timeoutMs?: number; label?: string; onTimeout?: () => void } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? SUITE_WATCHDOG_MS;
  const label = opts.label ?? "operation";
  const promise = (typeof work === "function" ? work() : work) as PromiseLike<T> & Cancellable;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try { promise.cancel?.(); } catch { /* best effort */ }
      // Absorb the late rejection the cancel triggers so it never surfaces as unhandled.
      void Promise.resolve(promise).then(undefined, () => {});
      try { opts.onTimeout?.(); } catch { /* best effort */ }
      reject(new SuiteWatchdogTimeoutError(label, timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, watchdog]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
