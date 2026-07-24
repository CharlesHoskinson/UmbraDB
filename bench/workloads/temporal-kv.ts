import type { UmbraDBSql } from "../../src/postgres/client.js";
import { PgTemporalKV } from "../../src/postgres/temporal-kv.js";
import { BENCH_SCHEMA } from "../environment.js";
import { summarize, tinybenchSamples } from "../stats.js";
import type { HotRatio, LatencyStats } from "../types.js";

export interface KvResults {
  workloads: Record<string, LatencyStats>;
  hotRatio: HotRatio;
}

/**
 * Read `pg_stat_user_tables.n_tup_hot_upd / n_tup_upd` for a table since the last `pg_stat_reset()`
 * — recorded as an OBSERVATION (IS-1 empirical verification, `design.md` §3), never a causal
 * isolation of `fillfactor`'s own contribution (Sprint 4 task 0.2's documented limitation). PG17's
 * shared-memory stats make these readable immediately after the churn commits.
 */
export async function readHotRatio(sql: UmbraDBSql, table: string): Promise<HotRatio> {
  // Force this backend's pending table-access stats to shared memory before reading. A backend
  // rate-limits its own stats flushes to once per PGSTAT_MIN_INTERVAL (~1s), so a read taken
  // immediately after a sub-second churn would otherwise see stale (0) counters. This is why the
  // HOT-sensitive workloads run on a DEDICATED single-connection client: the churn and this flush
  // are the same backend, making the observation deterministic (PG15+; PG17 confirmed).
  await sql`SELECT pg_stat_force_next_flush()`;
  // Cast the int8 stat counters to int4 so postgres.js's types.bigint mapping does not return
  // BigInt (which JSON.stringify cannot serialize); bench-scale counts are far within int4.
  const rows = await sql<{ n_tup_upd: number; n_tup_hot_upd: number }[]>`
    SELECT n_tup_upd::int AS n_tup_upd, n_tup_hot_upd::int AS n_tup_hot_upd
    FROM pg_stat_user_tables
    WHERE schemaname = ${BENCH_SCHEMA} AND relname = ${table}
  `;
  const r = rows[0] ?? { n_tup_upd: 0, n_tup_hot_upd: 0 };
  return {
    table,
    n_tup_upd: r.n_tup_upd,
    n_tup_hot_upd: r.n_tup_hot_upd,
    hotRatio: r.n_tup_upd > 0 ? r.n_tup_hot_upd / r.n_tup_upd : null,
    note: "measured observation under sustained puts (IS-1); NOT a causal isolation of fillfactor (Sprint 4 task 0.2 precedent)",
  };
}

/**
 * TemporalKV workloads (`design.md` §4): `put` on a fresh key vs an existing key (the HOT-update
 * path — measured, not optimized), `get`, and `getAt` by `{version}` and `{at}`. Resets the stats
 * counters first, then records the `kv_current` HOT ratio after the sustained `put`-existing churn
 * to validate IS-1 (`design.md` §3).
 */
export async function runTemporalKvWorkloads(sql: UmbraDBSql): Promise<KvResults> {
  const kv = new PgTemporalKV(sql, BENCH_SCHEMA);
  const workloads: Record<string, LatencyStats> = {};

  // Reset stats so the HOT-ratio observation reflects only this workload's kv_current churn.
  await sql`SELECT pg_stat_reset()`;

  let freshN = 0;
  workloads["temporalKV.put.fresh"] = summarize(
    await tinybenchSamples(
      "kv.put.fresh",
      async () => {
        freshN += 1;
        await kv.put("bench", "scope", `fresh-${freshN}`, { v: freshN });
      },
      { time: 300 },
    ),
  );

  await kv.put("bench", "scope", "hot-key", { v: 0 });
  let exN = 0;
  workloads["temporalKV.put.existing"] = summarize(
    await tinybenchSamples(
      "kv.put.existing",
      async () => {
        exN += 1;
        await kv.put("bench", "scope", "hot-key", { v: exN });
      },
      { time: 500 }, // longer -> more HOT updates to observe on kv_current
    ),
  );

  workloads["temporalKV.get"] = summarize(
    await tinybenchSamples("kv.get", async () => {
      await kv.get("bench", "scope", "hot-key");
    }, { time: 300 }),
  );

  workloads["temporalKV.getAt.version"] = summarize(
    await tinybenchSamples("kv.getAt.version", async () => {
      await kv.getAt("bench", "scope", "hot-key", { kind: "version", version: 1n });
    }, { time: 300 }),
  );

  const at = new Date();
  workloads["temporalKV.getAt.at"] = summarize(
    await tinybenchSamples("kv.getAt.at", async () => {
      await kv.getAt("bench", "scope", "hot-key", { kind: "at", at });
    }, { time: 300 }),
  );

  const hotRatio = await readHotRatio(sql, "kv_current");
  return { workloads, hotRatio };
}
