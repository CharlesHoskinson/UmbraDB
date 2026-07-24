import { createHash, randomBytes } from "node:crypto";
import type postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { ChunkIntegrityError, ChunkMissingError } from "../../../src/interfaces/checkpoint-store.js";
import { PgCheckpointStore } from "../../../src/postgres/checkpoint-store.js";
import { createClient, type UmbraDBSql } from "../../../src/postgres/client.js";
import { PgTransactionLeaseLayer } from "../../../src/postgres/transaction-lease.js";
import { registerSuiteLifecycle, TEST_SCHEMA, withSuiteWatchdog } from "../../postgres/setup.js";

/**
 * G10 — LOAD UNDER CONCURRENT PRUNE (`design.md` §3.2; `tasks.md` §5.2; `acceptance.md` F6–F8;
 * `council/B` §3 item 6; `02`-T9 first half). One required test:
 *   [[soak.load-under-prune.snapshot-isolation-safe]]
 *
 * WHAT THIS PROVES — `load` runs its two-statement read (manifest read at `checkpoint-store.ts:328`,
 * then the chunk-byte read at `:340`) inside ONE `{ isolation: "repeatable read" }` transaction
 * (`checkpoint-store.ts:392`). Postgres takes that transaction's snapshot at its FIRST statement
 * (the manifest read). So a `prune` that COMMITS its deletions AFTER that snapshot is taken but
 * BEFORE `load` finishes reading chunk bytes cannot remove those bytes out from under `load`
 * (`02`-F5 "Safety (C2a) within a single `load` holds"). This test forces exactly that interleave
 * and proves `load` returns the correct bytes anyway.
 *
 * WHY A FORCED INTERLEAVE, NOT A WALL-CLOCK RACE (`design.md` §3.2 / auditor BLOCKING-2) — left to
 * timing, `prune` might run entirely before or after `load`'s snapshot and the test would pass
 * VACUOUSLY (proving nothing about the snapshot). So the interleave is DETERMINISTIC: a test-only
 * query observer (a `Proxy` over `load`'s OWN transaction `sql`, à la the crash-worker — it touches
 * NO `src/` code) lets the manifest read run (taking the snapshot), then PAUSES the transaction
 * between the manifest read and the first chunk-byte read, signals readiness in-process, the parent
 * drives `prune` to COMMIT, and only then releases `load`. The ordering
 *   `load opens snapshot → prune deletes + COMMITs → load reads chunk bytes`
 * is thus FORCED, and PROVEN observably (not by timing) — see the three PROOF steps in the test.
 *
 * FORCING RECLAMATION PAST THE GRACE WINDOW — `prune` step 2 only reclaims chunks
 * `WHERE created_at < now() - interval '15 minutes'` (`checkpoint-store.ts:520`). So the target
 * checkpoint's chunk is BACKDATED an hour (exactly as the checkpoint-store grace-window tests / the
 * GC scale test do: `UPDATE ckpt_chunks SET created_at = now() - interval '1 hour'`) and the target
 * is placed OUTSIDE the retain window, so the concurrent `prune` genuinely DELETES the target
 * manifest (cascading its junction rows) AND reclaims its now-unreferenced chunk. Without this the
 * reclamation never fires and the whole test is vacuous.
 *
 * SURVIVE-SET (explicit) — with {@link CHECKPOINT_COUNT} checkpoints (seqs 1..N) and
 * `prune(retainCount = {@link RETAIN_COUNT})`:
 *   - PRUNE-SET (removed from the committed DB) = { seq 1 } — its manifest + its unique backdated
 *     chunk are deleted and reclaimed by the forced `prune`.
 *   - SURVIVE-SET (must remain intact + `load`able from a fresh client) = { seq 2 .. seq N }.
 *   - SNAPSHOT-PROTECTED READ = the interleaved `load(seq 1)`: although seq 1 is in the PRUNE-SET
 *     (deleted in the committed DB), the `load` that opened its snapshot BEFORE the `prune`
 *     committed MUST still return seq 1's exact bytes and MUST NOT raise `ChunkMissingError` /
 *     `ChunkIntegrityError`. That read is what "a checkpoint that should survive" means here: its
 *     snapshot protects the retrieval.
 *
 * NEGATIVE CONTROL (mandatory — `design.md` §3.2 / acceptance F8) — the SAME forced interleave
 * applied to an UN-snapshotted read (a READ COMMITTED transaction whose two sub-reads see different
 * snapshots) of a reclaimed chunk DOES raise `ChunkMissingError`. This proves the clean `load`
 * above is attributable to the REPEATABLE READ snapshot, not to a `prune` that never overlapped.
 * See {@link runUnSnapshottedReadUnderPrune}.
 *
 * DEFERRED (documented, NOT silently omitted) — the CLOCK-STEP half of `02`-T9 (a backward NTP /
 * wall-clock step vs. `prune`'s 15-minute grace window) is DEFERRED past 1.0.0 (`council/B` §3
 * item 6 "clock-step half deferrable"; §2 "Defer past 1.0.0"). The cross-transaction
 * `history()`-then-`load()` >15-min window is a DOCUMENTATION item (`02`-F5), not tested here.
 *
 * `src/` IS BYTE-UNCHANGED — this test drives only the public adapters + the shared-container
 * harness (`registerSuiteLifecycle` / `withSuiteWatchdog`); the pause point is a test-only `Proxy`
 * over `load`'s transaction handle, injected by wrapping the CLIENT passed to the store, never by
 * editing `load`. No second container is started (dedicated small pools against the SAME shared
 * container, per the harness's documented "own dedicated pool" hook).
 */

// ============================================================================================
// NAMED CONSTANTS
// ============================================================================================

const NET = "n";
/** Wallet for the main snapshot-safe interleave. */
const WALLET_MAIN = "lup-main";
/** Wallet for the negative control (independent retain-window math from the main wallet). */
const WALLET_NEG = "lup-neg";
/** Each save produces exactly one distinct chunk (payload < chunkSize), so a checkpoint == a chunk. */
const CHUNK_SIZE = 4096;
const PAYLOAD_BYTES = 512;
/** Number of checkpoints (seqs 1..N). Seq 1 is the prune target; seqs 2..N are the survive-set. */
const CHECKPOINT_COUNT = 4;
/** prune retainCount: keeps the newest RETAIN_COUNT, so seq 1 (the oldest) is pruned. */
const RETAIN_COUNT = 3;
/** Bound for the readiness wait / the released load — a wedged handshake fails typed, never hangs. */
const INTERLEAVE_WATCHDOG_MS = 30_000;
/** Whole-test wall-clock bound (CI-tractable: the live run is a handful of saves + one prune). */
const TEST_TIMEOUT_MS = 120_000;

// ============================================================================================
// HELPERS
// ============================================================================================

function sha256(data: Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

/** A distinct random payload of {@link PAYLOAD_BYTES} bytes → a unique chunk hash (no dedup). */
function uniquePayload(): Buffer {
  return randomBytes(PAYLOAD_BYTES);
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A tx/client `sql` value invoked in the tagged-template / helper positions the store uses. */
type Callable = (...args: unknown[]) => unknown;

/**
 * THE FORCED-INTERLEAVE PRIMITIVE (`design.md` §3.2).
 *
 * Observes `load`'s OWN transaction `sql` and inserts a deterministic pause between the manifest
 * read (which takes the REPEATABLE READ snapshot) and the first chunk-byte read. It is a `Proxy`
 * over the transaction handle — it forwards every call to the real handle verbatim, so `load`'s
 * `src/` code is unchanged; it only recognises the chunk-byte read (`load`'s
 * `SELECT ... FROM ckpt_manifest_chunks mc LEFT JOIN ckpt_chunks c ...` at `checkpoint-store.ts:340`)
 * and runs the readiness/release handshake before letting that query reach Postgres.
 */
class LoadInterleaveObserver {
  /** Resolves when `load` has taken its snapshot (manifest read done) and is paused before chunks. */
  readonly paused = deferred<void>();
  /** The parent resolves this (after `prune` COMMITs) to let `load`'s chunk-byte read proceed. */
  readonly release = deferred<void>();
  /** `load`'s backend pid, captured on `load`'s OWN transaction during the pause. */
  loadBackendPid?: number;
  /** Set true once the snapshot-taking manifest read has run — asserted at the pause. */
  private snapshotTaken = false;
  /** The pause fires exactly once (the first chunk-byte read). */
  private pausedOnce = false;

  /** Wrap a real postgres transaction handle in the observing proxy. */
  wrapTx(realTx: postgres.TransactionSql<{ bigint: bigint }>): postgres.TransactionSql<{ bigint: bigint }> {
    const self = this;
    const target = realTx as unknown as Callable;
    const proxy = new Proxy(target, {
      apply(fn, thisArg, args) {
        const first = args[0];
        const isTaggedTemplate = Array.isArray(first)
          && Object.prototype.hasOwnProperty.call(first, "raw");
        if (!isTaggedTemplate) {
          // Identifier/fragment helper (e.g. sql(schema)) or any non-query call — forward verbatim.
          return Reflect.apply(fn, thisArg, args);
        }
        const raw = (first as readonly string[]).join(" ").toLowerCase();
        const isChunkByteRead = raw.includes("ckpt_manifest_chunks") && raw.includes("left join");
        if (!isChunkByteRead) {
          // The manifest read (or any statement before the chunk read) — this takes the RR snapshot.
          self.snapshotTaken = true;
          return Reflect.apply(fn, thisArg, args);
        }
        if (self.pausedOnce) return Reflect.apply(fn, thisArg, args);
        self.pausedOnce = true;
        // Return a thenable so the store's `await sql`...`` first runs the handshake, then the query.
        return {
          then(onFulfilled: (v: unknown) => unknown, onRejected: (e: unknown) => unknown) {
            return (async () => {
              if (!self.snapshotTaken) {
                throw new Error("interleave invariant broken: paused before the manifest read took the snapshot");
              }
              // Capture load's backend pid on ITS OWN transaction: pg_backend_pid() takes no new
              // snapshot and assigns no xid, so the RR snapshot from the manifest read is untouched.
              const pidRows = await realTx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
              self.loadBackendPid = Number(pidRows[0]!.pid);
              self.paused.resolve();          // signal readiness to the parent
              await self.release.promise;     // block until the parent has COMMITted prune
              return Reflect.apply(fn, thisArg, args); // now issue the chunk-byte read
            })().then(onFulfilled, onRejected);
          },
        };
      },
      get(fn, prop, receiver) {
        const value = Reflect.get(fn, prop, receiver);
        return typeof value === "function" ? (value as Callable).bind(fn) : value;
      },
    });
    return proxy as unknown as postgres.TransactionSql<{ bigint: bigint }>;
  }
}

/**
 * Returns a proxy over a real client whose only altered behaviour is `begin`: the transaction
 * handle it hands the store's callback is wrapped in {@link LoadInterleaveObserver.wrapTx}. Every
 * other property/call forwards verbatim, so `PgTransactionLeaseLayer`/`PgCheckpointStore` see an
 * ordinary client. This is how the pause point is injected WITHOUT touching `src/`.
 */
function observeClient(real: UmbraDBSql, observer: LoadInterleaveObserver): UmbraDBSql {
  const proxy = new Proxy(real as unknown as object, {
    get(fn, prop, receiver) {
      if (prop === "begin") {
        return (...args: unknown[]): unknown => {
          const beginFn = Reflect.get(fn, "begin", receiver) as Callable;
          if (args.length >= 2 && typeof args[1] === "function") {
            const options = args[0];
            const cb = args[1] as (tx: postgres.TransactionSql<{ bigint: bigint }>) => unknown;
            return beginFn.call(fn, options, (realTx: postgres.TransactionSql<{ bigint: bigint }>) =>
              cb(observer.wrapTx(realTx)));
          }
          const cb = args[0] as (tx: postgres.TransactionSql<{ bigint: bigint }>) => unknown;
          return beginFn.call(fn, (realTx: postgres.TransactionSql<{ bigint: bigint }>) =>
            cb(observer.wrapTx(realTx)));
        };
      }
      const value = Reflect.get(fn, prop, receiver);
      return typeof value === "function" ? (value as Callable).bind(fn) : value;
    },
  });
  return proxy as unknown as UmbraDBSql;
}

function storeOf(sql: UmbraDBSql): PgCheckpointStore {
  return new PgCheckpointStore(sql, new PgTransactionLeaseLayer(sql), TEST_SCHEMA);
}

// ============================================================================================
// SUITE
// ============================================================================================

const { connectionUri } = registerSuiteLifecycle();

let openPools: UmbraDBSql[] = [];
function newClient(maxConnections: number): UmbraDBSql {
  const c = createClient({
    connectionString: connectionUri(), schema: TEST_SCHEMA, maxConnections, connectTimeout: 10,
  });
  openPools.push(c);
  return c;
}

afterEach(async () => {
  await Promise.all(openPools.map((p) => p.end({ timeout: 5 }).catch(() => {})));
  openPools = [];
});

interface SavedCheckpoint {
  sequence: number;
  payload: Buffer;
  chunkHash: Buffer;
}

/** Create N checkpoints with distinct payloads; return them ordered by sequence (oldest first). */
async function seedCheckpoints(
  store: PgCheckpointStore, wallet: string, count: number,
): Promise<SavedCheckpoint[]> {
  const saved: SavedCheckpoint[] = [];
  for (let i = 0; i < count; i++) {
    const payload = uniquePayload();
    const summary = await withSuiteWatchdog(
      () => store.save(wallet, NET, payload, { chunkSize: CHUNK_SIZE }),
      { label: `seed-save-${wallet}-${i}`, timeoutMs: INTERLEAVE_WATCHDOG_MS },
    );
    saved.push({ sequence: summary.sequence, payload, chunkHash: sha256(payload) });
  }
  return saved;
}

/**
 * Backdate a chunk past prune's 15-minute grace window (mirrors the checkpoint-store GC tests:
 * `UPDATE ckpt_chunks SET created_at = now() - interval '1 hour'`). The interval is a trusted
 * literal (never caller input), inlined exactly as the store's own `prune` inlines its window.
 */
async function backdatePastGraceWindow(admin: UmbraDBSql, chunkHash: Buffer): Promise<void> {
  await withSuiteWatchdog(
    () => admin`
      UPDATE ${admin(TEST_SCHEMA)}.ckpt_chunks
      SET created_at = now() - interval '1 hour'
      WHERE hash = ${chunkHash}`,
    { label: "backdate-grace", timeoutMs: INTERLEAVE_WATCHDOG_MS },
  );
}

/**
 * NEGATIVE CONTROL read path (`design.md` §3.2 / acceptance F8).
 *
 * Reproduces `load`'s "the manifest says chunk X must exist → fetch X → if X is gone, raise
 * `ChunkMissingError`" logic (`checkpoint-store.ts:363-365`) but WITHOUT `load`'s REPEATABLE READ
 * snapshot: the two sub-reads run in a plain READ COMMITTED transaction, so the second one sees a
 * FRESH snapshot. Sub-read 1 (before prune) captures the target's junction chunk-hashes; the forced
 * `prune` COMMITs its reclamation of those chunks INSIDE this open READ COMMITTED transaction;
 * sub-read 2 (after prune) fetches the chunk bytes and finds them gone → the real `ChunkMissingError`
 * fires under the real absent-chunk condition. Under RR (what `load` uses) sub-read 2 would still
 * see the chunk; under READ COMMITTED it does not — so this isolates the snapshot as the protector.
 */
async function runUnSnapshottedReadUnderPrune(
  readClient: UmbraDBSql,
  pruneStore: PgCheckpointStore,
  wallet: string,
  targetSeq: number,
): Promise<void> {
  await readClient.begin(async (tx) => {
    // Sub-read 1 (pre-prune): the junction chunk-hashes load would resolve for this manifest.
    const junction = await tx<{ chunk_hash: Buffer }[]>`
      SELECT mc.chunk_hash
      FROM ${tx(TEST_SCHEMA)}.ckpt_manifest_chunks mc
      JOIN ${tx(TEST_SCHEMA)}.ckpt_manifests m ON m.id = mc.manifest_id
      WHERE m.w = ${wallet} AND m.net = ${NET} AND m.seq = ${targetSeq}
      ORDER BY mc.position`;
    const expectedHashes = junction.map((r) => r.chunk_hash);
    expect(expectedHashes.length).toBeGreaterThan(0); // the manifest really references chunks

    // Forced interleave: prune COMMITs (reclaiming those chunks) INSIDE this open READ COMMITTED tx.
    const pruneResult = await pruneStore.prune(wallet, NET, RETAIN_COUNT);
    expect(pruneResult.prunedSequences).toContain(targetSeq);
    expect(pruneResult.reclaimedChunks).toBeGreaterThanOrEqual(expectedHashes.length);

    // Sub-read 2 (post-prune, fresh READ COMMITTED snapshot): fetch the chunk bytes by the captured
    // hashes and apply load's exact missing-chunk detection (checkpoint-store.ts:363-365).
    const present = await tx<{ hash: Buffer }[]>`
      SELECT c.hash FROM ${tx(TEST_SCHEMA)}.ckpt_chunks c
      WHERE c.hash = ANY(${tx.array(expectedHashes)})`;
    const presentSet = new Set(present.map((r) => r.hash.toString("hex")));
    for (const h of expectedHashes) {
      if (!presentSet.has(h.toString("hex"))) {
        // Same class, same condition as load's line 364 — only the RR snapshot is absent.
        throw new ChunkMissingError(h.toString("hex"));
      }
    }
  });
}

describe("G10 load under concurrent prune — REPEATABLE READ snapshot protects a live retrieval (design.md §3.2)", () => {
  it(
    "[[soak.load-under-prune.snapshot-isolation-safe]] a FORCED interleave lands the prune COMMIT " +
      "inside load's open REPEATABLE READ snapshot window (proven via backend state + committed " +
      "visibility, not timing); load returns the correct bytes and never raises ChunkMissingError/" +
      "ChunkIntegrityError for the snapshot-protected checkpoint; the survive-set stays loadable; " +
      "and the negative control (the same interleave on an un-snapshotted READ COMMITTED read of a " +
      "reclaimed chunk) DOES raise ChunkMissingError",
    async () => {
      const admin = newClient(6); // fresh monitor/prune/assertion client, separate from load's pool
      const adminStore = storeOf(admin);

      // ---------------------------------------------------------------------------------------
      // SETUP — CHECKPOINT_COUNT checkpoints with distinct payloads; seq 1 is the prune target.
      // ---------------------------------------------------------------------------------------
      const main = await seedCheckpoints(adminStore, WALLET_MAIN, CHECKPOINT_COUNT);
      const target = main[0]!;                       // seq 1 — the SNAPSHOT-PROTECTED read + PRUNE-SET
      const surviveSet = main.slice(1);              // seq 2..N — the SURVIVE-SET
      const surviveSeqs = surviveSet.map((c) => c.sequence);
      expect(target.sequence).toBe(1);
      expect(surviveSeqs.length).toBe(CHECKPOINT_COUNT - 1);

      // Force reclamation: backdate the target's unique chunk past the 15-minute grace window so the
      // concurrent prune actually DELETES + reclaims it (otherwise the test is vacuous).
      await backdatePastGraceWindow(admin, target.chunkHash);

      // ---------------------------------------------------------------------------------------
      // DRIVE load(seq 1) with the forced-interleave observer; it pauses AFTER the manifest read
      // (snapshot taken) and BEFORE the first chunk-byte read.
      // ---------------------------------------------------------------------------------------
      const observer = new LoadInterleaveObserver();
      const loadClient = observeClient(newClient(1), observer); // dedicated 1-conn pool for load
      const loadStore = storeOf(loadClient);
      const loadPromise = loadStore.load(WALLET_MAIN, NET, target.sequence);
      loadPromise.catch(() => { /* guarded: a failed handshake surfaces via the watchdog below */ });

      // Wait (bounded) until load is paused mid-snapshot.
      await withSuiteWatchdog(observer.paused.promise, {
        label: "await-load-paused", timeoutMs: INTERLEAVE_WATCHDOG_MS,
        onTimeout: () => observer.release.resolve(),
      });
      const loadPid = observer.loadBackendPid!;
      expect(loadPid).toBeGreaterThan(0);

      // ------- PROOF 1: load's transaction is OPEN and HOLDS a snapshot at this instant -------
      // Observable (pg_stat_activity), not timing: state = 'idle in transaction' (paused mid-tx)
      // and backend_xmin is set (the RR snapshot pins an xmin horizon).
      const before = await admin<{ state: string; backend_xmin: string | null; xact_start: Date | null }[]>`
        SELECT state, backend_xmin::text AS backend_xmin, xact_start
        FROM pg_stat_activity WHERE pid = ${loadPid}`;
      expect(before[0]!.state).toBe("idle in transaction");
      expect(before[0]!.xact_start).not.toBeNull();
      expect(before[0]!.backend_xmin).not.toBeNull();

      // ------- Drive the concurrent prune to COMMIT (inside load's open snapshot window) -------
      const pruneResult = await withSuiteWatchdog(
        () => adminStore.prune(WALLET_MAIN, NET, RETAIN_COUNT),
        { label: "concurrent-prune", timeoutMs: INTERLEAVE_WATCHDOG_MS },
      );
      expect(pruneResult.prunedSequences).toContain(target.sequence); // seq 1 manifest deleted
      expect(pruneResult.reclaimedChunks).toBeGreaterThanOrEqual(1);  // seq 1 chunk reclaimed

      // ------- PROOF 2: prune's COMMIT is globally durable NOW (fresh-snapshot connection) -------
      // The target manifest and its chunk are GONE in the committed DB — yet load has not resumed.
      const manifestGone = await admin<{ n: number }[]>`
        SELECT count(*)::int AS n FROM ${admin(TEST_SCHEMA)}.ckpt_manifests
        WHERE w = ${WALLET_MAIN} AND net = ${NET} AND seq = ${target.sequence}`;
      expect(manifestGone[0]!.n).toBe(0);
      const chunkGone = await admin<{ n: number }[]>`
        SELECT count(*)::int AS n FROM ${admin(TEST_SCHEMA)}.ckpt_chunks WHERE hash = ${target.chunkHash}`;
      expect(chunkGone[0]!.n).toBe(0);

      // ------- PROOF 3: load's snapshot is STILL open after prune committed -------
      const after = await admin<{ state: string }[]>`
        SELECT state FROM pg_stat_activity WHERE pid = ${loadPid}`;
      expect(after[0]!.state).toBe("idle in transaction");
      // Ordering established observably: snapshot taken (manifest read) < prune COMMIT (globally
      // visible above, load still open) < load's chunk read (released next). The prune COMMIT
      // provably landed INSIDE load's open REPEATABLE READ snapshot window.

      // ------- Release load; it reads chunk bytes within its ORIGINAL snapshot -------
      observer.release.resolve();
      const record = await withSuiteWatchdog(loadPromise, {
        label: "release-load", timeoutMs: INTERLEAVE_WATCHDOG_MS,
      });

      // CLEAN-LOAD ASSERTION: the snapshot-protected read returns the EXACT original bytes and never
      // raised ChunkMissingError/ChunkIntegrityError, even though its chunk is globally reclaimed.
      expect(Buffer.from(record.data).equals(target.payload)).toBe(true);
      expect(record.sequence).toBe(target.sequence);

      // ------- SURVIVE-SET: every seq 2..N still loads correctly from a FRESH client -------
      const freshStore = storeOf(newClient(2));
      for (const cp of surviveSet) {
        const rec = await withSuiteWatchdog(
          () => freshStore.load(WALLET_MAIN, NET, cp.sequence),
          { label: `survive-load-${cp.sequence}`, timeoutMs: INTERLEAVE_WATCHDOG_MS },
        );
        expect(Buffer.from(rec.data).equals(cp.payload)).toBe(true);
      }

      // ---------------------------------------------------------------------------------------
      // NEGATIVE CONTROL — the SAME forced interleave on an UN-snapshotted (READ COMMITTED) read of
      // a reclaimed chunk MUST raise ChunkMissingError. Independent wallet + fresh backdated target.
      // ---------------------------------------------------------------------------------------
      const neg = await seedCheckpoints(adminStore, WALLET_NEG, CHECKPOINT_COUNT);
      const negTarget = neg[0]!;
      expect(negTarget.sequence).toBe(1);
      await backdatePastGraceWindow(admin, negTarget.chunkHash);

      const negReadClient = newClient(1);
      let negError: unknown;
      try {
        await withSuiteWatchdog(
          () => runUnSnapshottedReadUnderPrune(negReadClient, adminStore, WALLET_NEG, negTarget.sequence),
          { label: "negative-control", timeoutMs: INTERLEAVE_WATCHDOG_MS },
        );
      } catch (err) {
        negError = err;
      }
      // FIRES: the reclaimed-chunk read without the snapshot raises ChunkMissingError for the exact
      // reclaimed chunk — attributing the clean load above to the RR snapshot, not to a non-overlap.
      expect(negError).toBeInstanceOf(ChunkMissingError);
      expect((negError as ChunkMissingError).chunkHash).toBe(negTarget.chunkHash.toString("hex"));

      // Guard against a mis-wired test that "passes" by ChunkIntegrityError instead of Missing.
      expect(negError).not.toBeInstanceOf(ChunkIntegrityError);
    },
    TEST_TIMEOUT_MS,
  );
});
