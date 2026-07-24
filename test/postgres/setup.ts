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
  // Bounded by construction (`withSuiteWatchdog`), so every crash-suite caller — Tasks 1-6
  // included — inherits the JS-level termination backstop without having to remember to wrap it.
  const rows = await withSuiteWatchdog(
    sql<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`,
    { label: "backendPid" },
  );
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
  const rows = await withSuiteWatchdog(
    admin<{ terminated: boolean }[]>`SELECT pg_terminate_backend(${pid}) AS terminated`,
    { label: "pgTerminateBackend" },
  );
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
  /** The committed checkpoint sequence (present for `after-data-commit-before-cursor` and the
   *  `t5-full-flow` control). */
  savedSequence?: number;
  /** The advisory-lock key held (present for `in-critical-section`). */
  lockKey?: string;
  /** `hashtext(lockKey)` — the `objid` of the class-2 advisory lock in `pg_locks` (T3). */
  lockKeyHash?: number;
  /** The non-pause control mode the worker ran (present for `t5-full-flow`). */
  mode?: string;
  /** The watermark cursor coordinates (present for the T5 hooks and the `t5-full-flow` control). */
  cursorKind?: string;
  cursorKey?: string;
  [k: string]: unknown;
}

export interface SpawnCrashWorkerOptions {
  /** Connection URI of the shared container (`registerSuiteLifecycle().connectionUri()`). */
  connectionUri: string;
  /** Schema the worker operates in — reuse {@link TEST_SCHEMA}; the worker runs NO migrations. */
  schema: string;
  /** The named fault hook, or omit for an ordinary uninterrupted `save`. */
  hook?: CrashHook;
  /** A no-pause, no-kill control mode independent of {@link hook}. `t5-full-flow` runs the safe
   *  data->cursor sequence to completion (the T5 negative control) so a killed run's cursor/data
   *  absence is provably caused by the crash, not by a missing op. */
  mode?: "t5-full-flow";
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
/** The POST-readiness RESULT sentinel a T2 worker prints after its post-kill in-flight `save`
 *  (`design.md` §2.2). Kept in sync with `crash-worker.ts`. */
export const CRASH_WORKER_RESULT_SENTINEL = "@@CRASH_WORKER_RESULT@@";

/** The post-readiness RESULT payload a T2 worker prints after it has issued its post-kill in-flight
 *  `save` (`design.md` §2.2, Task 2.1). `isConnectionError`/`errorCode` are the worker's
 *  AUTHORITATIVE typed classification of the caught error (an `Error` cannot cross the `spawn`
 *  boundary as a live instance), so the parent asserts a typed `ConnectionError` on the stable
 *  discriminant, never a message substring. */
export interface CrashWorkerResult {
  /** True once the worker re-issued the save against the killed backend. */
  reissued?: boolean;
  /** Whether that in-flight save threw — it MUST (the backend is dead); `false` fails the parent. */
  threw?: boolean;
  /** `err.constructor.name` — expected `"ConnectionError"`. */
  errorName?: string;
  /** The `StorageError` `.code` discriminant — expected `"CONNECTION_ERROR"`. */
  errorCode?: unknown;
  /** `err instanceof ConnectionError`, evaluated in-worker against the imported class. */
  isConnectionError?: boolean;
  isStorageError?: boolean;
  message?: string;
  [k: string]: unknown;
}

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
  /** Writes `${line}\n` to the worker's stdin — the DETERMINISTIC parent->worker "proceed"
   *  handshake (T2, `design.md` §2.2): the parent sends this AFTER killing the worker's backend so
   *  the worker's subsequent in-flight save runs strictly post-kill. No-op if the child has exited. */
  sendLine(line: string): void;
  /** Resolves with the T2 RESULT payload once the worker has emitted it (after its post-kill
   *  in-flight save). Rejects if the worker exits before signalling a result or `timeoutMs` elapses. */
  waitForResult(timeoutMs?: number): Promise<CrashWorkerResult>;
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
  // Build the child env EXPLICITLY. Start from the parent env (node/tsx need PATH etc.), then SCRUB
  // the entire crash-worker control family so an AMBIENT variable never leaks into the child. This
  // matters most for UMBRADB_CRASH_HOOK: if the parent process happens to have it set, a "no-hook"
  // worker would inherit it, PAUSE at a named point, and hang the required no-hook smoke test. Only
  // the variables set from `opts` below take effect — no-hook ⇒ guaranteed uninterrupted save.
  const env: Record<string, string | undefined> = { ...(process.env as Record<string, string | undefined>) };
  for (const key of Object.keys(env)) {
    if (key.startsWith("UMBRADB_CRASH_") || key === "UMBRADB_TEST_CONNECTION_URI" || key === "UMBRADB_TEST_SCHEMA") {
      delete env[key];
    }
  }
  env.UMBRADB_TEST_CONNECTION_URI = opts.connectionUri;
  env.UMBRADB_TEST_SCHEMA = opts.schema;
  if (opts.hook !== undefined) env.UMBRADB_CRASH_HOOK = opts.hook;
  if (opts.mode !== undefined) env.UMBRADB_CRASH_MODE = opts.mode;
  if (opts.walletId !== undefined) env.UMBRADB_CRASH_WALLET = opts.walletId;
  if (opts.networkId !== undefined) env.UMBRADB_CRASH_NETWORK = opts.networkId;
  if (opts.cursorKind !== undefined) env.UMBRADB_CRASH_CURSOR_KIND = opts.cursorKind;
  if (opts.cursorKey !== undefined) env.UMBRADB_CRASH_CURSOR_KEY = opts.cursorKey;
  if (opts.cursorValue !== undefined) env.UMBRADB_CRASH_CURSOR_VALUE = JSON.stringify(opts.cursorValue);
  if (opts.leaseKey !== undefined) env.UMBRADB_CRASH_LEASE_KEY = opts.leaseKey;
  if (opts.payloadBytes !== undefined) env.UMBRADB_CRASH_PAYLOAD_BYTES = String(opts.payloadBytes);
  if (opts.extraEnv !== undefined) Object.assign(env, opts.extraEnv);

  const child = spawn(process.execPath, ["--import", "tsx", WORKER_ENTRYPOINT], {
    cwd: REPO_ROOT,
    env,
    // stdin is a PIPE (was "ignore") so the parent can send the T2 "proceed" line (`sendLine`).
    // Existing workers never read stdin, so this is transparent to them; an open, unread stdin pipe
    // does not keep the child's event loop alive.
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  let ready: CrashWorkerReady | undefined;
  let readyErr: Error | undefined;
  let result: CrashWorkerResult | undefined;
  let resultErr: Error | undefined;
  /** Index into `stdoutBuf` up to which COMPLETE (newline-terminated) lines have been scanned for a
   *  readiness/error/result record. The remainder past it is a possibly-partial final line, held
   *  until its own newline arrives. ONE cursor for both signals: the scanner keeps advancing PAST
   *  readiness so the later RESULT line (T2) is still found. */
  let scanPos = 0;
  const readyWaiters: Array<() => void> = [];
  const resultWaiters: Array<() => void> = [];
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const exitWaiters: Array<() => void> = [];

  const settleReady = (): void => { while (readyWaiters.length) readyWaiters.shift()!(); };
  const settleResult = (): void => { while (resultWaiters.length) resultWaiters.shift()!(); };

  /** Line-buffered readiness parser. The worker emits its readiness/error record as a SINGLE
   *  `\n`-terminated line; a Node stream can split a chunk mid-line, so we `JSON.parse` ONLY
   *  complete newline-terminated lines (never a partial record, which would raise a permanent
   *  readiness error while the worker stays paused). Non-sentinel lines (tsx/driver log noise) are
   *  ignored rather than treated as errors. `stdoutBuf` keeps the full stream for diagnostics. */
  const scanStdout = (): void => {
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n", scanPos)) >= 0) {
      const line = stdoutBuf.slice(scanPos, nl); // one COMPLETE line, no trailing "\n"
      scanPos = nl + 1;
      if (ready === undefined && readyErr === undefined) {
        const r = line.indexOf(CRASH_WORKER_READY_SENTINEL);
        if (r >= 0) {
          try { ready = JSON.parse(line.slice(r + CRASH_WORKER_READY_SENTINEL.length)) as CrashWorkerReady; }
          catch (err) { readyErr = new Error(`crash worker readiness line was not valid JSON: ${String(err)}`); }
          settleReady();
          continue;
        }
        const e = line.indexOf(CRASH_WORKER_ERROR_SENTINEL);
        if (e >= 0) {
          readyErr = new Error(`crash worker reported an error before readiness: ${line.slice(e + CRASH_WORKER_ERROR_SENTINEL.length).trim()}`);
          settleReady();
          continue;
        }
      }
      if (result === undefined && resultErr === undefined) {
        const x = line.indexOf(CRASH_WORKER_RESULT_SENTINEL);
        if (x >= 0) {
          try { result = JSON.parse(line.slice(x + CRASH_WORKER_RESULT_SENTINEL.length)) as CrashWorkerResult; }
          catch (err) { resultErr = new Error(`crash worker result line was not valid JSON: ${String(err)}`); }
          settleResult();
          continue;
        }
      }
      // else: a non-sentinel line — ignore and continue scanning subsequent complete lines.
    }
  };

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    scanStdout();
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderrBuf += chunk; });

  child.on("exit", (code, signal) => {
    exited = { code, signal };
    scanStdout(); // flush any complete lines buffered right up to exit (the RESULT line, T2)
    if (ready === undefined && readyErr === undefined) {
      readyErr = new Error(
        `crash worker exited (code=${String(code)}, signal=${String(signal)}) before signalling readiness.\nstderr:\n${stderrBuf}`,
      );
      settleReady();
    }
    if (result === undefined && resultErr === undefined) {
      resultErr = new Error(
        `crash worker exited (code=${String(code)}, signal=${String(signal)}) before signalling a result.\nstderr:\n${stderrBuf}`,
      );
      settleResult();
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
        let timer: ReturnType<typeof setTimeout>;
        const waiter = (): void => { clearTimeout(timer); done(); };
        timer = setTimeout(() => {
          // On a readiness timeout, REMOVE our waiter (so a late readiness line cannot re-settle
          // this promise) AND terminate the child (so a wedged worker is not left running past its
          // test — belt-and-suspenders vs. the worker's own orphan guard).
          const idx = readyWaiters.indexOf(waiter);
          if (idx >= 0) readyWaiters.splice(idx, 1);
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
          reject(new SuiteWatchdogTimeoutError("crash-worker readiness", timeoutMs));
        }, timeoutMs);
        readyWaiters.push(waiter);
      });
    },
    waitForResult(timeoutMs = DEFAULT_READY_TIMEOUT_MS): Promise<CrashWorkerResult> {
      return new Promise<CrashWorkerResult>((resolve, reject) => {
        const done = (): void => {
          if (result !== undefined) resolve(result);
          else reject(resultErr ?? new Error("crash worker result settled without a value"));
        };
        if (result !== undefined || resultErr !== undefined) { done(); return; }
        let timer: ReturnType<typeof setTimeout>;
        const waiter = (): void => { clearTimeout(timer); done(); };
        timer = setTimeout(() => {
          const idx = resultWaiters.indexOf(waiter);
          if (idx >= 0) resultWaiters.splice(idx, 1);
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
          reject(new SuiteWatchdogTimeoutError("crash-worker result", timeoutMs));
        }, timeoutMs);
        resultWaiters.push(waiter);
      });
    },
    waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
      return new Promise((resolve) => {
        if (exited !== undefined) { resolve(exited); return; }
        exitWaiters.push(() => resolve(exited!));
      });
    },
    sigkill(): void { child.kill("SIGKILL"); },
    sendLine(line: string): void {
      try { child.stdin?.write(`${line}\n`); } catch { /* child already gone */ }
    },
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
