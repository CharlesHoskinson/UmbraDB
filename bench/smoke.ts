import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PgCheckpointStore } from "../src/postgres/checkpoint-store.js";
import { PgTemporalKV } from "../src/postgres/temporal-kv.js";
import { PgWatermarks } from "../src/postgres/watermarks.js";
import { PgTransactionLeaseLayer } from "../src/postgres/transaction-lease.js";
import { BENCH_SCHEMA, startBenchEnv } from "./environment.js";
import { summarize, tinybenchSamples } from "./stats.js";
import { HARNESS_VERSION, type Baseline, type LatencyStats } from "./types.js";

/**
 * COARSE, ORDER-OF-MAGNITUDE regression smoke guard (`design.md` §5; roadmap G14 "coarse gate
 * now"). Runs a fast subset of the workloads against a fresh pinned container and flags a p99 that
 * has moved by more than an ORDER OF MAGNITUDE (10x) versus the committed baseline.
 *
 * ==> EXPLICITLY NON-RELEASE-GATING. <==
 * This guard NEVER fails the build on a calibrated performance number. It exits 0 even when it
 * flags a suspected gross regression (a WARNING for a human to look at). It exits non-zero ONLY if
 * the harness itself cannot run (infrastructure failure — Docker/Testcontainers down), which is not
 * a perf-number gate. The calibrated, CV-aware regression gate is deferred to the first post-1.0.0
 * obligation (`design.md` §5; council/B §3). See Performance/CEILINGS.md.
 */
const REGRESSION_FACTOR = 10; // order of magnitude

async function main(): Promise<void> {
  const env = await startBenchEnv(8);
  const measured: Record<string, LatencyStats> = {};
  try {
    const kv = new PgTemporalKV(env.sql, BENCH_SCHEMA);
    const wm = new PgWatermarks(env.sql, BENCH_SCHEMA);
    const store = new PgCheckpointStore(env.sql, new PgTransactionLeaseLayer(env.sql), BENCH_SCHEMA);

    let n = 0;
    measured["temporalKV.put.existing"] = summarize(
      await tinybenchSamples("kv.put", async () => {
        n += 1;
        await kv.put("smoke", "scope", "k", { v: n });
      }, { time: 150 }),
    );
    measured["temporalKV.get"] = summarize(
      await tinybenchSamples("kv.get", async () => {
        await kv.get("smoke", "scope", "k");
      }, { time: 150 }),
    );
    let w = 0;
    measured["watermarks.set.highFrequency"] = summarize(
      await tinybenchSamples("wm.set", async () => {
        w += 1;
        await wm.set("cursor", "tip", { h: w });
      }, { time: 150 }),
    );
    const data = Buffer.alloc(1024 * 1024, 7);
    const saveSamples: number[] = [];
    for (let i = 0; i < 3; i++) {
      data.writeUInt32LE(i + 1, 0);
      const t0 = performance.now();
      await store.save("smoke-save", "bench", data);
      saveSamples.push(performance.now() - t0);
    }
    measured["checkpointStore.save.1MB"] = summarize(saveSamples);
  } finally {
    await env.stop();
  }

  const baseline = loadBaseline();
  console.log("=== bench smoke guard (COARSE, NON-RELEASE-GATING) ===");
  let flags = 0;
  for (const [name, m] of Object.entries(measured)) {
    const base = baseline?.workloads[name];
    if (!base) {
      console.log(`  ${name.padEnd(36)} p99=${m.p99.toFixed(3)}ms  (no baseline entry; skipped)`);
      continue;
    }
    const ratio = base.p99 > 0 ? m.p99 / base.p99 : 1;
    const suspect = ratio > REGRESSION_FACTOR;
    if (suspect) flags += 1;
    console.log(
      `  ${name.padEnd(36)} p99=${m.p99.toFixed(3)}ms  baseline=${base.p99.toFixed(3)}ms  x${ratio.toFixed(2)}  ${suspect ? "WARN: >10x — inspect" : "ok"}`,
    );
  }
  if (!baseline) {
    console.log(`  (no committed baseline.${HARNESS_VERSION}.json found — smoke ran, comparison skipped)`);
  }
  console.log(
    flags > 0
      ? `\n${flags} workload(s) exceeded ${REGRESSION_FACTOR}x — NON-GATING warning only; not a release blocker. The calibrated CV-aware gate is deferred post-1.0.0.`
      : "\nno gross (>10x) regression detected. NON-GATING guard; the calibrated CV-aware gate is deferred post-1.0.0.",
  );
  // Deliberately exit 0 regardless of `flags` — this guard never fails the build on a perf number.
  process.exit(0);
}

function loadBaseline(): Baseline | null {
  try {
    const path = fileURLToPath(new URL(`./baseline.${HARNESS_VERSION}.json`, import.meta.url));
    return JSON.parse(readFileSync(path, "utf8")) as Baseline;
  } catch {
    return null;
  }
}

main().catch((err: unknown) => {
  // Infrastructure failure (Docker/Testcontainers unavailable) — NOT a perf-number gate.
  console.error("[smoke] harness could not run (infrastructure failure, not a perf regression):", err);
  process.exit(1);
});
