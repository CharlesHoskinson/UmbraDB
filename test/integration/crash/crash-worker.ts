/**
 * Crash-worker entrypoint (v1.0.0-recovery-testing, Task 0.2 — `design.md` §1).
 *
 * A `tsx`-launched CHILD PROCESS that performs exactly one storage operation (a `save`, a
 * co-transactional/safe data→cursor sequence, or a held `withLease`) against the SHARED
 * Testcontainers Postgres, and — when a test-only `UMBRADB_CRASH_HOOK` env var is set — PAUSES at a
 * named program point and signals readiness to the parent, then blocks so the parent SIGKILLs it
 * deterministically.
 *
 * DETERMINISM & TEST-HONESTY (the dominant risk in this change):
 *  - The pause is ALWAYS at a NAMED PROGRAM POINT between two real storage operations, NEVER on a
 *    wall-clock timer. So the state the parent's SIGKILL freezes is reproducible.
 *  - The pause is achieved WITHOUT touching `src/`: this worker OWNS the transaction / lease
 *    orchestration. For `before-commit` it drives the co-transactional `save(opts.tx)` path and
 *    simply does not let its own `withTransaction` return (so no COMMIT is issued). For the T5
 *    hooks it splits the safe data→cursor sequence and pauses between the two real, separately
 *    committed operations. For T3 it pauses inside a real held `withLease`. Every pause therefore
 *    sits between real, unmodified `src/` operations — no fault code is injected into `src/`.
 *
 * The precise real-operation boundary of each hook (WHICH operation has completed and which has
 * NOT at the pause) is documented inline at each `case` below.
 *
 * This file is a TEST entrypoint only (never imported by `src/`); it reads env and imports the
 * public adapters. It does NOT run migrations — it connects to the parent's already-migrated
 * schema.
 */
import { randomBytes } from "node:crypto";
import { PgCheckpointStore } from "../../../src/postgres/checkpoint-store.js";
import { createClient } from "../../../src/postgres/client.js";
import { PgTemporalKV } from "../../../src/postgres/temporal-kv.js";
import { PgTransactionLeaseLayer, resolveTransaction } from "../../../src/postgres/transaction-lease.js";
import { TransactionFaultError } from "../../../src/interfaces/transaction-lease.js";
import type { JsonValue } from "../../../src/interfaces/temporal-kv.js";
import { PgWatermarks } from "../../../src/postgres/watermarks.js";
import type { WatermarkValue } from "../../../src/interfaces/watermarks.js";
import { ConnectionError, StorageError } from "../../../src/interfaces/storage-errors.js";

/** Kept in sync with `test/postgres/setup.ts`'s `CRASH_WORKER_*_SENTINEL` — duplicated here
 *  deliberately so this process does not import `setup.ts` (which loads `vitest`/testcontainers). */
const READY_SENTINEL = "@@CRASH_WORKER_READY@@";
const ERROR_SENTINEL = "@@CRASH_WORKER_ERROR@@";
/** Second, POST-readiness signal (Task 2.1 / T2, `design.md` §2.2): the worker reports the CLASS
 *  and stable `.code` of the error its post-kill in-flight `save` threw. An `Error` cannot cross a
 *  `spawn` boundary as a live instance, so the AUTHORITATIVE `instanceof ConnectionError` runs in
 *  the worker and the parent asserts on the reported discriminant — never a message substring. */
const RESULT_SENTINEL = "@@CRASH_WORKER_RESULT@@";
/** The token the parent writes to the worker's stdin to release the T2 pause (see
 *  {@link waitForProceed}). A DETERMINISTIC parent->worker handshake, NOT a wall-clock sleep: the
 *  parent kills this worker's backend FIRST, then sends this, so the failing in-flight `save` is
 *  guaranteed to run strictly AFTER the kill. */
const PROCEED_TOKEN = "proceed";

/** The four named pause points. Mirrors `CrashHook` in `setup.ts`. */
type CrashHook =
  | "before-commit"
  | "in-critical-section"
  | "after-data-commit-before-cursor"
  | "after-cursor-before-data";

const ALL_HOOKS: readonly CrashHook[] = [
  "before-commit",
  "in-critical-section",
  "after-data-commit-before-cursor",
  "after-cursor-before-data",
];

/** Orphan guard: if the parent never SIGKILLs (a buggy test), do not leak this process forever.
 *  This is NOT the pause mechanism (the pause is the named program point in `main`); it only
 *  bounds an orphaned worker and keeps the event loop alive until the parent's kill lands. The
 *  parent always kills within a second or two, long before this fires. */
const ORPHAN_GUARD_MS = 120_000;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`crash-worker: required env ${name} is not set`);
  return v;
}

function signalReady(payload: Record<string, unknown>): void {
  process.stdout.write(`${READY_SENTINEL} ${JSON.stringify(payload)}\n`);
}

/** Blocks forever at the current (already-paused) program point. Never resolves normally: the
 *  parent SIGKILLs the process here, or the orphan guard force-exits after `ORPHAN_GUARD_MS`.
 *  Used by the single-operation hooks (`before-commit`, `in-critical-section`) where there is no
 *  legitimate "not killed" continuation — an orphan there is a parent bug and exits non-zero. */
function pauseUntilKilled(): Promise<never> {
  return new Promise<never>(() => {
    // Ref'd on purpose: guarantees the event loop stays alive until the SIGKILL, independent of
    // any driver socket ref behaviour, and force-exits an orphan rather than leaking it.
    setTimeout(() => {
      process.stderr.write(`${ERROR_SENTINEL} orphan-guard: parent never SIGKILLed within ${ORPHAN_GUARD_MS}ms\n`);
      process.exit(75);
    }, ORPHAN_GUARD_MS);
  });
}

/** Pause point for the T5 TWO-transaction hooks (`after-data-commit-before-cursor`,
 *  `after-cursor-before-data`): holds at the named boundary BETWEEN the two real, separately-
 *  committed operations so the parent can SIGKILL here deterministically. Unlike
 *  {@link pauseUntilKilled} it RESOLVES after `ORPHAN_GUARD_MS` instead of exiting, so a NOT-killed
 *  control run PROCEEDS to its second real operation and exits 0 — the second op is real code
 *  reachable past the pause, not a comment. In a killed run the SIGKILL lands within a second or
 *  two, far below this bound, so the second op never runs. */
function pauseThenResume(): Promise<void> {
  return new Promise<void>((resolve) => {
    // Ref'd timer: keeps the event loop alive across the pause (the SIGKILL normally lands first).
    setTimeout(resolve, ORPHAN_GUARD_MS);
  });
}

/** T2 (`design.md` §2.2): blocks until the parent writes a "proceed" line to this worker's stdin —
 *  the release the parent sends AFTER it has killed this backend, so the worker's subsequent
 *  in-flight `save` runs strictly post-kill. Bounded by the orphan guard so a buggy parent cannot
 *  hang the worker forever. This is an explicit SIGNAL wait, never a timed sleep. */
function waitForProceed(): Promise<void> {
  return new Promise<void>((resolve) => {
    let buf = "";
    const cleanup = (): void => {
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.pause();
    };
    const onData = (chunk: Buffer | string): void => {
      buf += chunk.toString();
      if (buf.includes(PROCEED_TOKEN)) { cleanup(); resolve(); }
    };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ORPHAN_GUARD_MS);
    process.stdin.on("data", onData);
    process.stdin.resume();
  });
}

/** Emits the POST-readiness RESULT record the T2 parent reads via `waitForResult`. When
 *  `exitAfter` is set it flushes the line and exits 0 IN the write callback — deterministic even
 *  though a killed backend / resumed stdin would otherwise keep the worker's event loop alive. */
function signalResult(payload: Record<string, unknown>, exitAfter = false): void {
  const line = `${RESULT_SENTINEL} ${JSON.stringify(payload)}\n`;
  if (exitAfter) process.stdout.write(line, () => process.exit(0));
  else process.stdout.write(line);
}

/** Serialisable description of a caught error for the RESULT signal. The AUTHORITATIVE typed check
 *  (`instanceof ConnectionError`) and the stable `.code` discriminant are both computed HERE, in
 *  the worker, against the imported classes — so the parent asserts a typed error, not a message. */
function describeCaughtError(err: unknown): Record<string, unknown> {
  const isConnErr = err instanceof ConnectionError;
  const isTxFaultConnLost = err instanceof TransactionFaultError && err.faultKind === "connection-lost";
  return {
    threw: true,
    errorName: err instanceof Error ? err.constructor.name : typeof err,
    errorCode: err instanceof StorageError ? err.code : ((err as { code?: unknown } | null)?.code ?? null),
    isConnectionError: isConnErr,
    // withTransaction's DOCUMENTED @throws maps a connection loss DURING a transaction to
    // TransactionFaultError(faultKind "connection-lost") (transaction-lease.ts:223,263-267), which
    // pre-empts save's {tx} ConnectionError translation. Report BOTH so the parent can assert the
    // typed connection-failure surface (the design/acceptance name ConnectionError; the code
    // produces the TransactionFault form for a save — see the test's SPEC NOTE).
    isTransactionFaultConnectionLost: isTxFaultConnLost,
    isTypedConnectionFailure: isConnErr || isTxFaultConnLost,
    faultKind: err instanceof TransactionFaultError ? err.faultKind : null,
    isStorageError: err instanceof StorageError,
    message: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
  };
}

/**
 * T5 deterministic checkpoint payload for a batch — kept BYTE-IDENTICAL with the keystone test's
 * `payload(salt, batch)` (`cursor-durability.crash.test.ts`). In the T5 KEYSTONE deterministic-data
 * mode the crash batch writes THIS content (not random opaque bytes), so it is a genuine
 * same-sequence step whose durable content is compared against the fault-free reference batch —
 * rather than arbitrary content the replay silently overwrites. The keystone asserts, from a fresh
 * client BEFORE replay, that the crash batch's durable payload equals `payload(salt, index)`, which
 * also catches any drift between this formula and the test's.
 */
function t5DeterministicPayload(salt: string, batch: number): Buffer {
  return Buffer.from(`t5-checkpoint|salt=${salt}|batch=${batch}|` + "x".repeat(64), "utf8");
}

async function main(): Promise<void> {
  const connectionString = requireEnv("UMBRADB_TEST_CONNECTION_URI");
  const schema = requireEnv("UMBRADB_TEST_SCHEMA");

  const hookRaw = process.env.UMBRADB_CRASH_HOOK;
  if (hookRaw !== undefined && !ALL_HOOKS.includes(hookRaw as CrashHook)) {
    throw new Error(`crash-worker: unknown UMBRADB_CRASH_HOOK ${JSON.stringify(hookRaw)} (expected one of ${ALL_HOOKS.join(", ")})`);
  }
  const hook = hookRaw as CrashHook | undefined;

  // A dedicated NO-PAUSE, NO-KILL control mode (independent of the pause hooks). `t5-full-flow`
  // runs the SAME safe data->cursor flow to completion so the smoke suite's negative control can
  // prove BOTH ops land when uninterrupted.
  const mode = process.env.UMBRADB_CRASH_MODE;

  const walletId = process.env.UMBRADB_CRASH_WALLET ?? "crash-w";
  const networkId = process.env.UMBRADB_CRASH_NETWORK ?? "crash-n";
  const cursorKind = process.env.UMBRADB_CRASH_CURSOR_KIND ?? "sync";
  const cursorKey = process.env.UMBRADB_CRASH_CURSOR_KEY ?? networkId;
  const cursorValue: WatermarkValue =
    (process.env.UMBRADB_CRASH_CURSOR_VALUE !== undefined
      ? JSON.parse(process.env.UMBRADB_CRASH_CURSOR_VALUE)
      : 1) as WatermarkValue;
  const leaseKey = process.env.UMBRADB_CRASH_LEASE_KEY ?? "crash-lease";
  const payloadBytes = Number(process.env.UMBRADB_CRASH_PAYLOAD_BYTES ?? "256");

  // T5 KEYSTONE deterministic-data mode (`design.md` §2.3). When UMBRADB_CRASH_SALT is set, the two
  // T5 hooks write the batch's REAL, deterministic content — a KV `put(item:index)` AND a checkpoint
  // `save(payload(salt,index))` — byte-identical to the fault-free reference batch, instead of a
  // random opaque payload with no KV. This makes the crash batch a genuine same-sequence step whose
  // durable content the keystone can compare against the reference (not arbitrary content masked by
  // replay). Absent the salt, the hooks keep their legacy random-payload behaviour (the smoke suite).
  const t5Salt = process.env.UMBRADB_CRASH_SALT;
  const t5Index = process.env.UMBRADB_CRASH_INDEX !== undefined ? Number(process.env.UMBRADB_CRASH_INDEX) : undefined;
  const kvNamespace = process.env.UMBRADB_CRASH_KV_NS;
  const kvScope = process.env.UMBRADB_CRASH_KV_SCOPE ?? walletId;
  const kvKey = process.env.UMBRADB_CRASH_KV_KEY;
  const kvValue: JsonValue | undefined =
    process.env.UMBRADB_CRASH_KV_VALUE !== undefined ? (JSON.parse(process.env.UMBRADB_CRASH_KV_VALUE) as JsonValue) : undefined;

  const sql = createClient({ connectionString, schema, maxConnections: 5 });
  const txLayer = new PgTransactionLeaseLayer(sql);
  const checkpoints = new PgCheckpointStore(sql, txLayer, schema);
  const watermarks = new PgWatermarks(sql, schema);
  const kv = new PgTemporalKV(sql, schema);
  const data = randomBytes(payloadBytes);

  /** The T5 crash batch's REAL data ops, in the same order as the reference batch (KV put, then the
   *  checkpoint save). Used by BOTH T5 hooks; only WHERE it sits relative to the cursor advance and
   *  the pause differs (safe = data before the pause, unsafe = data after it). Returns the committed
   *  checkpoint sequence so the safe hook can report it in readiness. */
  const writeT5DeterministicData = async (): Promise<number> => {
    if (t5Salt === undefined || t5Index === undefined || kvNamespace === undefined || kvKey === undefined || kvValue === undefined) {
      throw new Error("crash-worker: T5 deterministic-data mode requires UMBRADB_CRASH_{SALT,INDEX,KV_NS,KV_KEY,KV_VALUE}");
    }
    await kv.put(kvNamespace, kvScope, kvKey, kvValue); // KV datum (item:index) COMMITTED & durable
    const summary = await checkpoints.save(walletId, networkId, t5DeterministicPayload(t5Salt, t5Index)); // checkpoint COMMITTED
    return summary.sequence;
  };

  switch (hook) {
    case undefined: {
      if (mode === "t5-full-flow") {
        // T5 NEGATIVE CONTROL (no hook, no pause, no kill): the SAME safe two-transaction
        // data->cursor flow as `after-data-commit-before-cursor`, but run to COMPLETION. Both real
        // ops commit; the parent asserts BOTH data AND cursor present. This is what makes the kill
        // causal: in the killed `after-data-commit-before-cursor` run the cursor is absent BECAUSE
        // of the crash-between-the-two-ops, not because the cursor op never existed (it plainly
        // lands here).
        const summary = await checkpoints.save(walletId, networkId, data); // Op1: data (committed)
        await watermarks.set(cursorKind, cursorKey, cursorValue);          // Op2: cursor (committed)
        signalReady({
          hook: null, mode, pid: process.pid, savedSequence: summary.sequence,
          walletId, networkId, cursorKind, cursorKey,
        });
        await sql.end({ timeout: 5 });
        return;
      }
      // NO HOOK: an ordinary, uninterrupted `save` on its own internal transaction (commits and
      // returns), then a clean shutdown. Proves the worker is a normal writer when no fault is
      // requested. Natural return (no process.exit) so stdout flushes before exit.
      const summary = await checkpoints.save(walletId, networkId, data);
      signalReady({ hook: null, pid: process.pid, savedSequence: summary.sequence, walletId, networkId });
      await sql.end({ timeout: 5 });
      return;
    }

    case "before-commit": {
      // ONE hook, TWO modes (`design.md` §1 lists before-commit for BOTH T1 and T2):
      //  - T1 (default): pause pre-COMMIT and wait for the parent's SIGKILL of THIS process.
      //  - T2 (UMBRADB_CRASH_T2_COMMIT_AFTER_KILL=1, `design.md` §2.2): after readiness — with the in-flight
      //    save's statements ALREADY ISSUED on this open transaction — the parent kills THIS worker's
      //    Postgres BACKEND (pg_terminate_backend of the reported backendPid), THEN sends a "proceed"
      //    line. The worker then RETURNS from the callback, which makes withTransaction attempt the
      //    COMMIT of the in-flight save on the now-dead connection. The commit rejects; withTransaction
      //    surfaces its DOCUMENTED typed connection-loss error (TransactionFaultError, faultKind
      //    "connection-lost" — transaction-lease.ts:223,263-267), never a raw driver error. The worker
      //    reports the caught error's typed classification for the parent's assertion. (`design.md`
      //    §2.2(a)/acceptance C1 name "ConnectionError"; the transaction layer wraps a connection loss
      //    DURING a transaction as TransactionFaultError instead — see the test's SPEC NOTE.)
      const t2Commit = process.env.UMBRADB_CRASH_T2_COMMIT_AFTER_KILL === "1";
      let t2Error: unknown;
      let t2Threw = false;
      let t2Committed = false;
      try {
        await txLayer.withTransaction(async (tx) => {
          await checkpoints.save(walletId, networkId, data, { tx });
          // Capture the backend pid of the very connection holding the uncommitted work (the target
          // for a Postgres-kill of the worker's own session in T2). Read-only; commits nothing.
          const txSql = resolveTransaction(tx);
          const pidRows = await txSql<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
          // ---- REAL BOUNDARY (before-commit — T1/T2) --------------------------------------------
          // DONE: every statement of `save` — the chunk upsert, the sequence allocation, the
          //       manifest INSERT with complete=true, and the junction inserts — has been ISSUED on
          //       this open transaction `tx` (a genuine in-flight save; the parent independently
          //       confirms this via pg_stat_activity 'idle in transaction').
          // NOT DONE: the transaction's COMMIT (this withTransaction callback has not returned).
          // A SIGKILL now (T1) drops the connection; Postgres aborts the in-flight transaction, so
          // NOTHING becomes visible (no complete=true manifest at the interrupted seq).
          signalReady({ hook, pid: process.pid, backendPid: pidRows[0]!.pid, walletId, networkId });
          if (!t2Commit) {
            // T1: block here until the parent SIGKILLs this process at the pre-commit boundary.
            await pauseUntilKilled();
            return;
          }
          // T2: DETERMINISTIC — wait for the parent to (1) kill this backend, then (2) send proceed,
          // BEFORE the COMMIT is attempted. The kill therefore lands strictly BEFORE the failing
          // operation (no wall-clock race). Returning here makes withTransaction attempt the COMMIT.
          await waitForProceed();
        });
        // withTransaction resolved => the in-flight save's COMMIT succeeded. In T2 the backend was
        // killed, so this MUST NOT happen; report it so the parent FAILS LOUDLY (never a false pass).
        t2Committed = true;
      } catch (outer) {
        if (!t2Commit) throw outer; // T1: preserve original throwing behaviour (unreachable — SIGKILLed)
        t2Threw = true;
        t2Error = outer;
      }
      if (t2Commit) {
        // The pool/stdin are disposable and a killed backend can make a graceful sql.end() slow, so
        // flush the RESULT line and exit DETERMINISTICALLY (in the write callback) — Postgres reaps
        // the abandoned backends, exactly as after the T1 SIGKILL.
        signalResult(t2Threw
          ? { attempted: "commit", ...describeCaughtError(t2Error) }
          : { attempted: "commit", threw: false, committed: t2Committed }, true);
        return;
      }
      return;
    }

    case "in-critical-section": {
      // Precompute the advisory lock's objid (hashtext(key)) on a normal pooled connection so the
      // parent can target the exact class-2 lock in pg_locks.
      const hashRows = await sql<{ h: number }[]>`SELECT hashtext(${leaseKey})::int AS h`;
      await txLayer.withLease(leaseKey, async () => {
        // ---- REAL BOUNDARY (in-critical-section — T3) -----------------------------------------
        // DONE: acquireLease returned — a class-2 advisory lock
        //       pg_advisory_lock(2, hashtext(leaseKey)) is HELD on a reserved (pinned) connection
        //       and recorded in the layer's in-memory heldLeases map. We are executing INSIDE the
        //       withLease critical section.
        // NOT DONE: the withLease callback has not returned, so the lock has NOT been released.
        // A SIGKILL now drops all TCP connections; Postgres auto-releases the session-level
        // advisory lock and the in-memory map dies with the process — so a fresh withLease on the
        // same key must re-acquire immediately (no wedge).
        signalReady({ hook, pid: process.pid, lockKey: leaseKey, lockKeyHash: hashRows[0]!.h });
        await pauseUntilKilled();
      });
      return;
    }

    case "after-data-commit-before-cursor": {
      // SAFE two-transaction ordering, driven as TWO REAL, separately-committed operations with the
      // pause BETWEEN them: data FIRST (its own committed transaction) -> pause -> THEN cursor.
      // In T5 KEYSTONE deterministic-data mode the "data" is the batch's REAL content — a KV
      // put(item:index) AND a checkpoint save(payload(salt,index)), byte-identical to the reference
      // batch; otherwise (smoke suite) it is a single random-payload save.
      const savedSequence = t5Salt !== undefined
        ? await writeT5DeterministicData()                                 // Op1: KV datum + checkpoint DATA COMMITTED
        : (await checkpoints.save(walletId, networkId, data)).sequence;    // Op1: (legacy) random data COMMITTED
      // ---- REAL BOUNDARY (after-data-commit-before-cursor — T5, safe ordering) ----------------
      // COMMITTED (durable) at this pause: the batch's DATA (checkpoint seq = savedSequence and, in
      //       deterministic mode, its KV datum item:index). Each op opened its OWN transaction,
      //       COMMITTED it, and RETURNED.
      // PENDING (not yet issued) at this pause: the watermark/cursor advance below (Op2, REAL code
      //       past the pause — no longer a comment).
      // A SIGKILL here leaves data durable and the cursor NOT advanced => the durable watermark is
      // BEHIND the durable data (the only acceptable direction). If NOT killed, `pauseThenResume`
      // resolves and Op2 runs, so the worker commits BOTH and exits 0.
      signalReady({
        hook, pid: process.pid, savedSequence,
        walletId, networkId, cursorKind, cursorKey,
      });
      await pauseThenResume();
      await watermarks.set(cursorKind, cursorKey, cursorValue);          // Op2: cursor COMMITTED & durable
      await sql.end({ timeout: 5 });
      return;
    }

    case "after-cursor-before-data": {
      // Deliberately-UNSAFE caller ordering (cursor before data) — the T5 negative/reference case
      // ONLY (a caller error the storage layer cannot prevent, out of the T5 invariant's scope).
      // Still driven as TWO REAL, separately-committed operations with the pause BETWEEN them:
      // cursor FIRST -> pause -> THEN data.
      await watermarks.set(cursorKind, cursorKey, cursorValue);          // Op1: cursor COMMITTED & durable
      // ---- REAL BOUNDARY (after-cursor-before-data — T5, unsafe reference case) ----------------
      // COMMITTED (durable) at this pause: the watermark/cursor advance for (cursorKind, cursorKey).
      // PENDING (not yet issued) at this pause: the later batch DATA commit below (Op2, REAL code
      //       past the pause — no longer a comment).
      // A SIGKILL here leaves the cursor durable with its data ABSENT => the watermark is AHEAD of
      // durable data. Reachable ONLY under this unsafe ordering; it exists to construct the negative
      // case, not to assert the invariant. If NOT killed, `pauseThenResume` resolves and Op2 runs,
      // so the worker commits BOTH and exits 0.
      signalReady({ hook, pid: process.pid, cursorKind, cursorKey, walletId, networkId });
      await pauseThenResume();
      // Op2: the SAME deterministic data as the reference batch (KV put(item:index) + checkpoint
      // save(payload(salt,index))) in T5 mode, else a legacy random-payload save. When killed at the
      // pause this never runs, so BOTH the KV datum AND the checkpoint are absent while the cursor is
      // durable — the KV-inclusive negative case (either missing falsifies the invariant).
      if (t5Salt !== undefined) await writeT5DeterministicData();
      else await checkpoints.save(walletId, networkId, data);           // Op2: data COMMITTED & durable
      await sql.end({ timeout: 5 });
      return;
    }
  }
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  const line = `${ERROR_SENTINEL} ${detail}\n`;
  process.stderr.write(line);
  // Flush the error sentinel to stdout (the channel the parent scans) BEFORE exiting non-zero.
  process.stdout.write(line, () => process.exit(1));
});
