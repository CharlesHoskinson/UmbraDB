import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "../src/postgres/client.js";
import { BENCH_SCHEMA, PG_SETTINGS, POSTGRES_IMAGE, startBenchEnv } from "./environment.js";
import { HARNESS_VERSION, type Baseline, type LatencyStats } from "./types.js";
import { runCheckpointWorkloads } from "./workloads/checkpoint-store.js";
import { GC_DECLARED_ENVELOPE, runGcScale } from "./workloads/gc.js";
import { runLeaseWorkloads } from "./workloads/lease.js";
import { runTemporalKvWorkloads } from "./workloads/temporal-kv.js";
import { runTxHistoryWorkloads } from "./workloads/transaction-history.js";
import { runWatermarkWorkloads } from "./workloads/watermarks.js";

/**
 * G14 benchmark harness entrypoint (`design.md` §4/§5). Drives UmbraDB's OWN adapters against a
 * pinned Testcontainers PG17 and emits the committed baseline artifact. Run via `npm run bench`.
 *
 * The gate is the ARTIFACT'S EXISTENCE + STRUCTURAL reproducibility, never a number: re-running at
 * {@link HARNESS_VERSION} against the same image + settings emits a schema-conforming artifact; no
 * latency/throughput value is compared (`design.md` §5; G14 hard rule).
 *
 * Env overrides (all optional; defaults produce the committed full-profile baseline):
 *   BENCH_PROFILE=quick   — a fast subset (used by the smoke guard).
 *   BENCH_CKPT_MB=1,16,64,256 — checkpoint save sizes (MB). Default 1,16,64,256 (256 MiB = 64
 *                           chunks at the 4 MiB default; design.md §4's full declared save-size set).
 *   BENCH_GC_POINTS=...   — live-chunk counts for the GC curve. Default 10000,50000,100000,300000,1000000.
 *   BENCH_GC_BUDGET_MS=.. — wall-clock budget for the GC curve. Default 240000.
 *   BENCH_OUT=/path.json  — override the artifact path.
 */
function parseNums(v: string | undefined): number[] | undefined {
  if (!v) return undefined;
  const nums = v.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  return nums.length > 0 ? nums : undefined;
}

async function main(): Promise<void> {
  const profile = process.env.BENCH_PROFILE ?? "full";
  const quick = profile === "quick";

  const ckptSizes = parseNums(process.env.BENCH_CKPT_MB) ?? (quick ? [1] : [1, 16, 64, 256]);
  const gcPoints = parseNums(process.env.BENCH_GC_POINTS) ?? (quick ? [1000, 5000] : [10_000, 50_000, 100_000, 300_000, 1_000_000]);
  const gcEnvelope: [number, number] = GC_DECLARED_ENVELOPE;
  const gcBudgetMs = Number(process.env.BENCH_GC_BUDGET_MS ?? (quick ? 20_000 : 240_000));
  const leaseContenders = quick ? [1, 4] : [1, 2, 4, 8, 16];

  console.log(`[bench] harness ${HARNESS_VERSION}, profile=${profile}`);
  console.log(`[bench] starting Testcontainers ${POSTGRES_IMAGE} ...`);
  const env = await startBenchEnv(24);
  console.log(`[bench] ${env.serverVersion.split(",")[0]}`);

  // The HOT-sensitive workloads (kv_current / watermarks n_tup_hot_upd observation) run on a
  // dedicated SINGLE-connection client so all churn lands on one backend and readHotRatio's
  // pg_stat_force_next_flush() deterministically makes the counters visible (see readHotRatio).
  const statSql = createClient({ connectionString: env.connectionUri, schema: BENCH_SCHEMA, maxConnections: 1 });

  try {
    console.log("[bench] CheckpointStore workloads ...");
    const ck = await runCheckpointWorkloads(env.sql, ckptSizes);
    console.log("[bench] TemporalKV workloads ...");
    const kv = await runTemporalKvWorkloads(statSql);
    console.log("[bench] Watermarks workloads ...");
    const wm = await runWatermarkWorkloads(statSql);
    console.log("[bench] TransactionHistory workloads ...");
    const th = await runTxHistoryWorkloads(env.sql);
    console.log("[bench] Lease/tx contention workloads ...");
    const lease = await runLeaseWorkloads(env.connectionUri, leaseContenders);
    console.log(`[bench] GC anti-join scale curve (points: ${gcPoints.join(", ")}) ...`);
    const gc = await runGcScale(env.sql, { points: gcPoints, targetEnvelope: gcEnvelope, budgetMs: gcBudgetMs });

    const workloads: Record<string, LatencyStats> = {
      ...ck.workloads,
      ...kv.workloads,
      ...wm.workloads,
      ...th.workloads,
      ...lease,
    };

    const baseline: Baseline = {
      schema: "umbradb-perf-baseline/v1",
      harnessVersion: HARNESS_VERSION,
      generatedAt: new Date().toISOString(),
      environment: {
        postgresImage: POSTGRES_IMAGE,
        postgresImageId: env.imageId,
        postgresServerVersion: env.serverVersion,
        settings: { ...PG_SETTINGS },
        node: process.version,
        microbenchLib: "tinybench@2.9.0",
        harnessVersion: HARNESS_VERSION,
        profile,
        declaredCaps: {
          checkpointSaveSizesMB: ckptSizes,
          checkpointSaveDeclaredCeilingMB: 256,
          gcEnvelopeTargetChunks: gcEnvelope,
          gcActualMaxChunks: gc.declaredEnvelope.actualMaxChunks,
          note: "checkpointSaveSizesMB now measures the full 1/16/64/256 MB set (256 MiB = 64 chunks at the 4 MiB default). The 10^6-chunk GC upper target remains the runtime-capped ceiling per design.md §4/§5; see Performance/CEILINGS.md.",
        },
      },
      workloads,
      measurements: {
        checkpointDedupRatio: ck.dedup,
        kvCurrentHotRatio: kv.hotRatio,
        watermarksHotRatio: wm.hotRatio,
        watermarksBloatStability: wm.bloatStability,
        transactionHistoryGinWriteP99Ms: th.ginWriteP99Ms,
      },
      gcCurve: gc,
    };

    const out = process.env.BENCH_OUT
      ?? fileURLToPath(new URL(`./baseline.${HARNESS_VERSION}.json`, import.meta.url));
    // Catch-all bigint safety: any int8 value that reached the artifact (e.g. a driver bigint) is
    // narrowed to a JS number so the artifact is plain JSON.
    const bigintSafe = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? Number(v) : v);
    writeFileSync(out, `${JSON.stringify(baseline, bigintSafe, 2)}\n`);
    printSummary(baseline);
    console.log(`\n[bench] baseline artifact written to ${out}`);
  } finally {
    await statSql.end({ timeout: 5 });
    await env.stop();
  }
}

function printSummary(b: Baseline): void {
  console.log("\n=== per-workload latency (ms): p50 / p95 / p99 / CV ===");
  for (const [name, s] of Object.entries(b.workloads)) {
    console.log(
      `  ${name.padEnd(42)} p50=${s.p50.toFixed(3)}  p95=${s.p95.toFixed(3)}  p99=${s.p99.toFixed(3)}  cv=${(s.cv * 100).toFixed(1)}%  (n=${s.samples})`,
    );
  }
  console.log("\n=== measurements ===");
  console.log(`  dedup ratio            : ${b.measurements.checkpointDedupRatio.ratio.toFixed(4)} (written ${b.measurements.checkpointDedupRatio.written}/${b.measurements.checkpointDedupRatio.referenced})`);
  console.log(`  kv_current HOT ratio   : ${fmtRatio(b.measurements.kvCurrentHotRatio.hotRatio)} (hot ${b.measurements.kvCurrentHotRatio.n_tup_hot_upd}/${b.measurements.kvCurrentHotRatio.n_tup_upd} upd)`);
  console.log(`  watermarks HOT ratio   : ${fmtRatio(b.measurements.watermarksHotRatio.hotRatio)} (hot ${b.measurements.watermarksHotRatio.n_tup_hot_upd}/${b.measurements.watermarksHotRatio.n_tup_upd} upd)`);
  console.log(`  watermarks bloat       : ${b.measurements.watermarksBloatStability.relationSizeBytes} bytes, ${b.measurements.watermarksBloatStability.deadTuples} dead tup after ${b.measurements.watermarksBloatStability.updates} updates`);
  console.log(`  tx-history GIN p99     : ${b.measurements.transactionHistoryGinWriteP99Ms.toFixed(3)} ms`);
  console.log("\n=== GC anti-join scale curve ===");
  for (const p of b.gcCurve.points) {
    console.log(`  ${String(p.liveChunks).padStart(9)} live chunks -> ${p.passMs.toFixed(1)} ms`);
  }
  console.log(`  envelope: ${b.gcCurve.declaredEnvelope.note}`);
  console.log(`  cliff (K=${b.gcCurve.K}, D=${b.gcCurve.D_ms}ms): ${b.gcCurve.cliffDetermination.met ? "MET" : "NOT MET"} — ${b.gcCurve.cliffDetermination.note}`);
}

function fmtRatio(r: number | null): string {
  return r === null ? "n/a" : `${(r * 100).toFixed(1)}%`;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
