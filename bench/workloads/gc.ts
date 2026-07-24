import type { UmbraDBSql } from "../../src/postgres/client.js";
import { PgCheckpointStore } from "../../src/postgres/checkpoint-store.js";
import { PgTransactionLeaseLayer } from "../../src/postgres/transaction-lease.js";
import { BENCH_SCHEMA } from "../environment.js";
import type { GcCurve, GcPoint } from "../types.js";

/**
 * The operational cliff parameters (`design.md` §5, HP-6). Declared here so the cliff is decided by
 * a rule, not an eyeball:
 *  - `K` — a pass-duration/chunk-count growth ratio above this between two measured points is
 *    "super-linear" (a cliff).
 *  - `D_MS` — any single pass exceeding this absolute per-pass bound is a cliff.
 */
const K = 2.0;
const D_MS = 5000;

// Fixture chunks are backdated 25 minutes (a trusted literal, > prune's 15-minute grace window) so
// prune's reclaim actually runs the NOT EXISTS ANTI-JOIN over every live chunk rather than
// short-circuiting on `created_at`, while the chunks still survive because each is referenced —
// that anti-join scan IS the O(live chunks) cost HP-6 measures.

export interface GcScaleOpts {
  points: number[];
  targetEnvelope: [number, number];
  /** Wall-clock budget (ms) for the whole GC measurement; once exceeded after a point, the run
   *  stops and the remaining upper envelope is declared as the SC-2 ceiling rather than measured. */
  budgetMs: number;
}

/**
 * GC anti-join scale measurement (`design.md` §5, HP-6): measure `prune` GC-pass duration vs
 * live-chunk count across the declared 10^5-10^6 envelope, then adjudicate the cliff by the declared
 * `K`/`D` rule. Chunks are populated server-side (`generate_series`) to avoid the 65 535-bind-param
 * limit a single giant `save` would hit, then referenced by one manifest so they are LIVE; the
 * MEASURED operation is UmbraDB's real `PgCheckpointStore.prune` (with a huge `retainCount` so step
 * 1 deletes no manifests and step 2's global anti-join scans every live chunk, deleting none).
 */
export async function runGcScale(sql: UmbraDBSql, opts: GcScaleOpts): Promise<GcCurve> {
  const store = new PgCheckpointStore(sql, new PgTransactionLeaseLayer(sql), BENCH_SCHEMA);

  // Isolate the fixture: the scale curve owns the whole global chunk pool for a clean measurement.
  await sql`TRUNCATE ${sql(BENCH_SCHEMA)}.ckpt_manifest_chunks, ${sql(BENCH_SCHEMA)}.ckpt_manifests, ${sql(BENCH_SCHEMA)}.ckpt_chunks, ${sql(BENCH_SCHEMA)}.ckpt_sequence_counters`;

  const manifestRows = await sql<{ id: bigint }[]>`
    INSERT INTO ${sql(BENCH_SCHEMA)}.ckpt_manifests (w, net, seq, complete, manifest_hash)
    VALUES ('gc', 'bench', 1, true, sha256('gc-manifest'::bytea))
    RETURNING id
  `;
  const manifestId = manifestRows[0]!.id;

  const sorted = [...opts.points].sort((a, b) => a - b);
  const points: GcPoint[] = [];
  let populated = 0;
  const start = performance.now();
  let stoppedForBudget = false;

  for (const target of sorted) {
    if (performance.now() - start > opts.budgetMs) {
      stoppedForBudget = true;
      break;
    }
    if (target > populated) {
      await populateChunks(sql, manifestId, populated, target);
      populated = target;
    }
    const passMs = await measureGcPass(store);
    points.push({ liveChunks: populated, passMs });
  }

  const determination = adjudicate(points, K, D_MS);
  const actualMax = points.length > 0 ? points[points.length - 1]!.liveChunks : 0;
  const cappedBelowTarget = actualMax < opts.targetEnvelope[1];

  return {
    declaredEnvelope: {
      targetMinChunks: opts.targetEnvelope[0],
      targetMaxChunks: opts.targetEnvelope[1],
      actualMinChunks: points.length > 0 ? points[0]!.liveChunks : 0,
      actualMaxChunks: actualMax,
      cappedBelowTarget,
      note: cappedBelowTarget
        ? `GC envelope run to ${actualMax} live chunks${stoppedForBudget ? " (stopped on the wall-clock budget)" : ""}; the ${opts.targetEnvelope[1]} upper target is documented as the SC-2 ceiling, not measured, per design.md §5's runtime-sanity allowance.`
        : `Full declared envelope measured to ${actualMax} live chunks.`,
    },
    K,
    D_ms: D_MS,
    points,
    cliffDetermination: determination,
  };
}

/** Populate `[from+1 .. to]` as live chunks (backdated past the grace window) + one junction row
 *  each referencing the fixture manifest, server-side in bounded batches. */
async function populateChunks(
  sql: UmbraDBSql,
  manifestId: bigint,
  from: number,
  to: number,
): Promise<void> {
  const BATCH = 50_000;
  for (let s = from; s < to; s += BATCH) {
    const e = Math.min(s + BATCH, to);
    await sql`
      INSERT INTO ${sql(BENCH_SCHEMA)}.ckpt_chunks (hash, data, created_at)
      SELECT sha256(g::text::bytea), decode(lpad(to_hex(g), 8, '0'), 'hex'), now() - interval '25 minutes'
      FROM generate_series(${s + 1}::int, ${e}::int) AS g
      ON CONFLICT (hash) DO NOTHING
    `;
    await sql`
      INSERT INTO ${sql(BENCH_SCHEMA)}.ckpt_manifest_chunks (manifest_id, position, chunk_hash)
      SELECT ${manifestId}, g, sha256(g::text::bytea)
      FROM generate_series(${s + 1}::int, ${e}::int) AS g
      ON CONFLICT (manifest_id, position) DO NOTHING
    `;
  }
}

/** One GC pass = a real `prune` whose step-1 manifest delete is a no-op (huge retainCount) so the
 *  timing reflects step-2's anti-join scan over every live chunk. */
async function measureGcPass(store: PgCheckpointStore): Promise<number> {
  const t0 = performance.now();
  await store.prune("gc", "bench", 1_000_000);
  return performance.now() - t0;
}

function adjudicate(points: GcPoint[], k: number, d: number): GcCurve["cliffDetermination"] {
  if (points.length > 0 && points[0]!.passMs > d) {
    return {
      met: true,
      reason: "D-absolute",
      firstMetLiveChunks: points[0]!.liveChunks,
      note: `first measured pass (${points[0]!.passMs.toFixed(1)}ms at ${points[0]!.liveChunks} chunks) exceeded the absolute bound D=${d}ms`,
    };
  }
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    if (cur.passMs > d) {
      return {
        met: true,
        reason: "D-absolute",
        firstMetLiveChunks: cur.liveChunks,
        note: `pass duration ${cur.passMs.toFixed(1)}ms at ${cur.liveChunks} chunks exceeded the absolute bound D=${d}ms`,
      };
    }
    const chunkGrowth = cur.liveChunks / Math.max(prev.liveChunks, 1);
    const durGrowth = cur.passMs / Math.max(prev.passMs, 0.001);
    if (chunkGrowth > 1 && durGrowth > k * chunkGrowth) {
      return {
        met: true,
        reason: "K-superlinear",
        firstMetLiveChunks: cur.liveChunks,
        note: `pass-duration grew ${durGrowth.toFixed(2)}x vs chunk-count ${chunkGrowth.toFixed(2)}x (> K=${k}x, super-linear) between ${prev.liveChunks} and ${cur.liveChunks} chunks`,
      };
    }
  }
  const maxChunks = points.length > 0 ? points[points.length - 1]!.liveChunks : 0;
  return {
    met: false,
    reason: "none",
    firstMetLiveChunks: null,
    note: `no cliff across ${points.length} points up to ${maxChunks} live chunks: no pass exceeded D=${d}ms and pass-duration growth stayed within K=${k}x of chunk-count growth. The single-statement anti-join delete is retained; SC-2 documents the O(live-chunks) cost.`,
  };
}
