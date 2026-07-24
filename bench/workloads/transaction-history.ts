import type { UmbraDBSql } from "../../src/postgres/client.js";
import { PgTransactionHistoryStorage } from "../../src/postgres/transaction-history-storage.js";
import { BENCH_SCHEMA } from "../environment.js";
import { summarize, tinybenchSamples } from "../stats.js";
import { benchMerge } from "./tx-history-merge.js";
import type { LatencyStats } from "../types.js";

export interface TxHistoryResults {
  workloads: Record<string, LatencyStats>;
  ginWriteP99Ms: number;
}

/**
 * TransactionHistory workload (`design.md` §4): pending→finalized churn — two GIN-indexed writes
 * per transaction (each write updates the `identifiers` GIN, whose `fastupdate` pending-list flushes
 * spike p99 under sustained writes, SC-5 / HP-5 — measured, not optimized). The p99 of the
 * pending+finalized latency is recorded as `transactionHistoryGinWriteP99Ms`.
 */
export async function runTxHistoryWorkloads(sql: UmbraDBSql): Promise<TxHistoryResults> {
  const store = new PgTransactionHistoryStorage(sql, "bench-wallet", benchMerge, BENCH_SCHEMA);
  const workloads: Record<string, LatencyStats> = {};

  let n = 0;
  const samples = await tinybenchSamples(
    "txhist.churn",
    async () => {
      const hash = `hash-${n}-${Math.random().toString(16).slice(2)}`;
      const ids = [`id-${n}-a`, `id-${n}-b`, `id-${n}-c`];
      n += 1;
      await store.gotPending({ hash, identifiers: ids, sections: {} });
      await store.gotFinalized({ hash, identifiers: ids, sections: {} });
    },
    { time: 500 },
  );

  const stats = summarize(samples);
  workloads["transactionHistory.pendingToFinalized"] = stats;
  return { workloads, ginWriteP99Ms: stats.p99 };
}
