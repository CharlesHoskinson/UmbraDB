import { randomBytes } from "node:crypto";
import { PgCheckpointStore } from "../../src/postgres/checkpoint-store.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { PgTransactionLeaseLayer } from "../../src/postgres/transaction-lease.js";
import { BENCH_SCHEMA } from "../environment.js";
import { measureManual, summarize } from "../stats.js";
import type { LatencyStats } from "../types.js";

const MB = 1024 * 1024;
const CHUNK = 4 * MB; // PgCheckpointStore's DEFAULT_CHUNK_SIZE

export interface CheckpointResults {
  workloads: Record<string, LatencyStats>;
  dedup: { referenced: number; written: number; ratio: number; note: string };
}

async function countChunks(sql: UmbraDBSql): Promise<number> {
  const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(BENCH_SCHEMA)}.ckpt_chunks`;
  return rows[0]!.n;
}

/**
 * CheckpointStore workloads (`design.md` §4): `save` at the full declared 1/16/64/256 MB sizes
 * (256 MiB = 64 chunks at the 4 MiB default; exercising the §1 batched insert path), `load`
 * round-trip, `history(limit=50)` (must be ~flat after §2), a `prune`/GC pass, and the dedup-ratio
 * measurement.
 *
 * Each measured `save` iteration mutates one byte per 4 MiB chunk so every chunk hashes differently
 * — the save writes GENUINELY NEW chunk rows each iteration, measuring the batched INSERT cost HP-1
 * targets rather than a run of `ON CONFLICT` dedup hits.
 */
export async function runCheckpointWorkloads(
  sql: UmbraDBSql,
  sizesMB: number[],
): Promise<CheckpointResults> {
  const store = new PgCheckpointStore(sql, new PgTransactionLeaseLayer(sql), BENCH_SCHEMA);
  const workloads: Record<string, LatencyStats> = {};

  for (const mb of sizesMB) {
    const data = randomBytes(mb * MB);
    let iter = 0;
    const iterations = mb <= 1 ? 10 : mb <= 16 ? 6 : 3;
    const warmup = mb <= 16 ? 2 : 1;
    const samples = await measureManual(
      async () => {
        await store.save(`w-save-${mb}`, "bench", data);
      },
      {
        warmup,
        iterations,
        prepare: () => {
          iter = (iter + 1) >>> 0;
          for (let off = 0; off + 4 <= data.length; off += CHUNK) data.writeUInt32LE(iter, off);
        },
      },
    );
    workloads[`checkpointStore.save.${mb}MB`] = summarize(samples);
  }

  // load round-trip on a mid-size checkpoint (verifies + rehashes every chunk, Buffer.concat)
  {
    const data = randomBytes(16 * MB);
    await store.save("w-load", "bench", data);
    const samples = await measureManual(
      async () => {
        await store.load("w-load", "bench");
      },
      { warmup: 2, iterations: 8 },
    );
    workloads["checkpointStore.load.16MB"] = summarize(samples);
  }

  // history(limit=50): populate 60 manifests, page 50 — must be ~flat (one grouped query, §2/HP-2)
  {
    const small = randomBytes(64 * 1024);
    for (let k = 0; k < 60; k++) await store.save("w-hist", "bench", small, { chunkSize: 16 * 1024 });
    const samples = await measureManual(
      async () => {
        await store.history("w-hist", "bench", { limit: 50 });
      },
      { warmup: 3, iterations: 20 },
    );
    workloads["checkpointStore.history.limit50"] = summarize(samples);
  }

  // prune / GC pass at a modest scale (the 10^5-10^6 SCALE curve is the separate gc workload).
  // Each iteration re-populates 5 manifests so every timed prune reclaims a consistent amount.
  {
    const samples = await measureManual(
      async () => {
        await store.prune("w-prune", "bench", 1);
      },
      {
        warmup: 1,
        iterations: 5,
        prepare: async () => {
          for (let k = 0; k < 5; k++) await store.save("w-prune", "bench", randomBytes(256 * 1024));
        },
      },
    );
    workloads["checkpointStore.prune"] = summarize(samples);
  }

  const dedup = await measureDedup(sql, store);
  return { workloads, dedup };
}

/**
 * Dedup ratio (`design.md` §4): save a payload, then save a NEAR-duplicate that differs in exactly
 * one of its N chunks. `referenced` = chunks the near-dup references (N); `written` = chunk rows
 * actually inserted (the `ON CONFLICT` hit count, observed as the ckpt_chunks row-count delta —
 * the shared chunks hit `ON CONFLICT DO UPDATE` and insert nothing). ratio = 1 − written/referenced.
 */
async function measureDedup(
  sql: UmbraDBSql,
  store: PgCheckpointStore,
): Promise<{ referenced: number; written: number; ratio: number; note: string }> {
  const chunkSize = 64 * 1024;
  const nChunks = 64;
  const base = randomBytes(nChunks * chunkSize);
  await store.save("w-dedup", "bench", base, { chunkSize });

  const near = Buffer.from(base);
  near[0] = near[0]! ^ 0xff; // flip one byte -> exactly the first chunk differs

  const before = await countChunks(sql);
  const summary = await store.save("w-dedup2", "bench", near, { chunkSize });
  const after = await countChunks(sql);

  const written = after - before;
  const referenced = summary.chunkCount;
  return {
    referenced,
    written,
    ratio: referenced > 0 ? 1 - written / referenced : 0,
    note: "near-duplicate save (1 of N chunks changed); ratio = 1 - newlyWritten/referenced, newlyWritten = ckpt_chunks row-count delta (ON CONFLICT hit count)",
  };
}
