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
import { PgTransactionLeaseLayer, resolveTransaction } from "../../../src/postgres/transaction-lease.js";
import { PgWatermarks } from "../../../src/postgres/watermarks.js";
import type { WatermarkValue } from "../../../src/interfaces/watermarks.js";

/** Kept in sync with `test/postgres/setup.ts`'s `CRASH_WORKER_*_SENTINEL` — duplicated here
 *  deliberately so this process does not import `setup.ts` (which loads `vitest`/testcontainers). */
const READY_SENTINEL = "@@CRASH_WORKER_READY@@";
const ERROR_SENTINEL = "@@CRASH_WORKER_ERROR@@";

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

  const sql = createClient({ connectionString, schema, maxConnections: 5 });
  const txLayer = new PgTransactionLeaseLayer(sql);
  const checkpoints = new PgCheckpointStore(sql, txLayer, schema);
  const watermarks = new PgWatermarks(sql, schema);
  const data = randomBytes(payloadBytes);

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
      // Drive the co-transactional save path on THIS worker's own transaction and never let the
      // withTransaction callback return, so no COMMIT is issued.
      await txLayer.withTransaction(async (tx) => {
        await checkpoints.save(walletId, networkId, data, { tx });
        // Capture the backend pid of the very connection holding the uncommitted work (the target
        // for a Postgres-kill of the worker's own session in T2). Read-only; commits nothing.
        const txSql = resolveTransaction(tx);
        const pidRows = await txSql<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
        // ---- REAL BOUNDARY (before-commit — T1/T2) --------------------------------------------
        // DONE: every statement of `save` — the chunk upsert, the sequence allocation, the
        //       manifest INSERT with complete=true, and the junction inserts — has been ISSUED on
        //       this open transaction `tx`.
        // NOT DONE: the transaction's COMMIT (this withTransaction callback has not returned).
        // A SIGKILL now drops the connection; Postgres aborts the in-flight transaction, so
        // NOTHING becomes visible (no complete=true manifest at the interrupted seq, no orphan
        // junction rows).
        signalReady({ hook, pid: process.pid, backendPid: pidRows[0]!.pid, walletId, networkId });
        await pauseUntilKilled();
      });
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
      const summary = await checkpoints.save(walletId, networkId, data); // Op1: data COMMITTED & durable
      // ---- REAL BOUNDARY (after-data-commit-before-cursor — T5, safe ordering) ----------------
      // COMMITTED (durable) at this pause: the checkpoint DATA (seq = summary.sequence).
      //       checkpoints.save opened its OWN transaction, COMMITTED it, and RETURNED.
      // PENDING (not yet issued) at this pause: the watermark/cursor advance below (Op2, REAL code
      //       past the pause — no longer a comment).
      // A SIGKILL here leaves data durable and the cursor NOT advanced => the durable watermark is
      // BEHIND the durable data (the only acceptable direction). If NOT killed, `pauseThenResume`
      // resolves and Op2 runs, so the worker commits BOTH and exits 0.
      signalReady({
        hook, pid: process.pid, savedSequence: summary.sequence,
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
      // PENDING (not yet issued) at this pause: the later checkpoint DATA commit below (Op2, REAL
      //       code past the pause — no longer a comment).
      // A SIGKILL here leaves the cursor durable with its data ABSENT => the watermark is AHEAD of
      // durable data. Reachable ONLY under this unsafe ordering; it exists to construct the negative
      // case, not to assert the invariant. If NOT killed, `pauseThenResume` resolves and Op2 runs,
      // so the worker commits BOTH and exits 0.
      signalReady({ hook, pid: process.pid, cursorKind, cursorKey, walletId, networkId });
      await pauseThenResume();
      await checkpoints.save(walletId, networkId, data);                // Op2: data COMMITTED & durable
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
