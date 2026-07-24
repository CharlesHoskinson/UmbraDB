import type { UmbraDBSql } from "../../src/postgres/client.js";
import { PgWatermarks } from "../../src/postgres/watermarks.js";
import { BENCH_SCHEMA } from "../environment.js";
import { summarize, tinybenchSamples } from "../stats.js";
import { readHotRatio } from "./temporal-kv.js";
import type { BloatStability, HotRatio, LatencyStats } from "../types.js";

export interface WatermarkResults {
  workloads: Record<string, LatencyStats>;
  hotRatio: HotRatio;
  bloatStability: BloatStability;
}

/** How many repeated same-key updates the bloat-stability measurement drives against ONE key. */
const BLOAT_SAME_KEY_UPDATES = 5000;

/**
 * Watermarks workload (`design.md` §4; task 2.2): high-frequency `set` on a small key set (the
 * every-sync-tick pattern the `fillfactor = 90` table exists for), then the HOT-ratio AND
 * bloat-stability observations on `watermarks`. Reads the counters accumulated since TemporalKV's
 * `pg_stat_reset()` — TemporalKV never touches `watermarks`, so these counters reflect only this
 * workload's sets.
 */
export async function runWatermarkWorkloads(sql: UmbraDBSql): Promise<WatermarkResults> {
  const wm = new PgWatermarks(sql, BENCH_SCHEMA);
  const workloads: Record<string, LatencyStats> = {};

  const keys = ["sync-tip", "indexer-cursor", "dust-cursor", "block-height"];
  let n = 0;
  workloads["watermarks.set.highFrequency"] = summarize(
    await tinybenchSamples(
      "wm.set",
      async () => {
        const k = keys[n % keys.length]!;
        n += 1;
        await wm.set("cursor", k, { h: n });
      },
      { time: 500 },
    ),
  );

  // Bloat-stability (`design.md` §4; task 2.2 "Watermarks set HOT-ratio + bloat"): a dedicated
  // high-frequency burst against a SINGLE watermark key, then record the table's physical size and
  // dead-tuple count. `fillfactor = 90` leaves same-page slack so each same-key update is a HOT
  // update whose prior version is reclaimed by HOT pruning — so the heap does NOT grow and dead
  // tuples stay bounded no matter how many times the one key is rewritten. Recorded as an
  // OBSERVATION that the tuning keeps the table from bloating, not a causal isolation of fillfactor.
  for (let i = 0; i < BLOAT_SAME_KEY_UPDATES; i++) {
    await wm.set("cursor", "sync-tip", { h: i });
  }
  const totalUpdates = n + BLOAT_SAME_KEY_UPDATES;

  const hotRatio = await readHotRatio(sql, "watermarks");
  const bloatStability = await readBloatStability(sql, "watermarks", totalUpdates);
  return { workloads, hotRatio, bloatStability };
}

/**
 * Physical-size + dead-tuple observation on a high-churn same-key table (`design.md` §4; task 2.2).
 * `fillfactor = 90` + HOT keep repeated same-key updates on the same heap page with their prior
 * versions reclaimed by HOT pruning, so the relation does not bloat. Recorded as an OBSERVATION, not
 * a causal isolation of fillfactor (Sprint 4 task 0.2's precedent, mirroring {@link readHotRatio}).
 */
export async function readBloatStability(
  sql: UmbraDBSql,
  table: string,
  updates: number,
): Promise<BloatStability> {
  // Force this backend's pending table-access stats to shared memory so `n_dead_tup` is fresh —
  // same rationale as readHotRatio; the HOT-sensitive workloads run on a dedicated single-connection
  // client so the churn and this flush are the same backend, making the observation deterministic.
  await sql`SELECT pg_stat_force_next_flush()`;
  // Cast the size/counter to int4 so postgres.js's types.bigint mapping does not return BigInt
  // (JSON.stringify cannot serialize it); a handful-of-rows table is far within int4.
  const rows = await sql<{ relation_size_bytes: number; dead_tuples: number }[]>`
    SELECT pg_relation_size(relid)::int AS relation_size_bytes,
           coalesce(n_dead_tup, 0)::int AS dead_tuples
    FROM pg_stat_user_tables
    WHERE schemaname = ${BENCH_SCHEMA} AND relname = ${table}
  `;
  const r = rows[0] ?? { relation_size_bytes: 0, dead_tuples: 0 };
  return {
    table,
    relationSizeBytes: r.relation_size_bytes,
    deadTuples: r.dead_tuples,
    updates,
    note:
      "measured observation: fillfactor=90 + HOT keep the table from bloating under repeated " +
      "same-key updates (relation size + dead tuples stay bounded); NOT a causal isolation of " +
      "fillfactor (Sprint 4 task 0.2 precedent)",
  };
}
