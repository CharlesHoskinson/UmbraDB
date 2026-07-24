import { createClient } from "../../src/postgres/client.js";
import { PgTransactionLeaseLayer } from "../../src/postgres/transaction-lease.js";
import type { TransactionLeaseLayer } from "../../src/interfaces/transaction-lease.js";
import { BENCH_SCHEMA } from "../environment.js";
import { summarize } from "../stats.js";
import type { LatencyStats } from "../types.js";

/**
 * Lease/tx-layer workload (`design.md` §4, HP-7): acquire/release latency under 1/2/4/8/16
 * contenders on a single advisory-lock key. The dedicated pool's `max` is sized ABOVE the largest
 * contender count so the measurement isolates the LOCK, not pool-queue latency (report `03` HP-7 —
 * the default `max=10` at `client.ts:49-52` would otherwise serialize 16 contenders on the pool,
 * not the lock). This also states the single-global-writer-lease throughput ceiling (SC-4).
 */
export async function runLeaseWorkloads(
  connectionUri: string,
  contenderCounts: number[],
): Promise<Record<string, LatencyStats>> {
  const maxPool = Math.max(...contenderCounts) + 4; // above the largest contender count
  const sql = createClient({ connectionString: connectionUri, schema: BENCH_SCHEMA, maxConnections: maxPool });
  const layer = new PgTransactionLeaseLayer(sql);
  const workloads: Record<string, LatencyStats> = {};
  try {
    for (const c of contenderCounts) {
      const samples: number[] = [];
      for (let w = 0; w < 3; w++) await contendOnce(layer, c, `lease-warm-${c}`, samples, false);
      for (let r = 0; r < 30; r++) await contendOnce(layer, c, `lease-key-${c}`, samples, true);
      workloads[`lease.acquireRelease.contenders${c}`] = summarize(samples);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  return workloads;
}

/** Launch `c` concurrent acquire→release cycles on one key; record each cycle's acquire+release
 *  latency (which includes the advisory-lock queue wait, since all `c` contend on the same key). */
async function contendOnce(
  layer: TransactionLeaseLayer,
  c: number,
  key: string,
  samples: number[],
  record: boolean,
): Promise<void> {
  await Promise.all(
    Array.from({ length: c }, async () => {
      const t0 = performance.now();
      const lease = await layer.acquireLease(key);
      await layer.releaseLease(lease);
      if (record) samples.push(performance.now() - t0);
    }),
  );
}
