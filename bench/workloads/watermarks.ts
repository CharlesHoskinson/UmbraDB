import type { UmbraDBSql } from "../../src/postgres/client.js";
import { PgWatermarks } from "../../src/postgres/watermarks.js";
import { BENCH_SCHEMA } from "../environment.js";
import { summarize, tinybenchSamples } from "../stats.js";
import { readHotRatio } from "./temporal-kv.js";
import type { HotRatio, LatencyStats } from "../types.js";

export interface WatermarkResults {
  workloads: Record<string, LatencyStats>;
  hotRatio: HotRatio;
}

/**
 * Watermarks workload (`design.md` §4): high-frequency `set` on a small key set (the every-sync-tick
 * pattern the `fillfactor = 90` table exists for), then the HOT-ratio / bloat-stability observation
 * on `watermarks`. Reads the counters accumulated since TemporalKV's `pg_stat_reset()` — TemporalKV
 * never touches `watermarks`, so these counters reflect only this workload's sets.
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

  const hotRatio = await readHotRatio(sql, "watermarks");
  return { workloads, hotRatio };
}
