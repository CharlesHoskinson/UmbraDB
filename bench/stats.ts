import { Bench } from "tinybench";
import type { LatencyStats } from "./types.js";

/**
 * Summarise a sample array (per-iteration times in ms) into the {@link LatencyStats} block the
 * baseline records. Percentiles use the nearest-rank method on the sorted samples; `cv` is the
 * coefficient of variation (sd/mean), the statistic a future CV-aware regression gate keys off
 * (`design.md` §5). Standard deviation is the sample sd (n-1 denominator).
 */
export function summarize(samplesMs: number[]): LatencyStats {
  if (samplesMs.length === 0) throw new Error("summarize: no samples");
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, x) => s + x, 0) / n;
  const variance = n > 1 ? sorted.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  const pct = (p: number): number => {
    const idx = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
    return sorted[idx]!;
  };
  return {
    unit: "ms",
    samples: n,
    min: sorted[0]!,
    max: sorted[n - 1]!,
    mean,
    sd,
    cv: mean > 0 ? sd / mean : 0,
    p50: pct(50),
    p95: pct(95),
    p99: pct(99),
  };
}

export interface TinybenchOpts {
  time?: number;
  iterations?: number;
  warmupTime?: number;
  warmupIterations?: number;
}

/**
 * Warmup-aware microbench via `tinybench` (the explicit devDependency, NOT the transitive vitest
 * copy — `design.md` §4). Returns the raw per-iteration sample array (`task.result.samples`) so
 * {@link summarize} owns the p50/p95/p99/CV computation uniformly across tinybench-measured and
 * manually-measured workloads. `tinybench.run()` does not warm up on its own — {@link Bench.warmup}
 * is called first, so the returned samples are post-warmup.
 */
export async function tinybenchSamples(
  name: string,
  fn: () => Promise<unknown> | unknown,
  opts?: TinybenchOpts,
): Promise<number[]> {
  const bench = new Bench({
    time: opts?.time ?? 250,
    iterations: opts?.iterations ?? 10,
    warmupTime: opts?.warmupTime ?? 100,
    warmupIterations: opts?.warmupIterations ?? 5,
    throws: true,
  });
  bench.add(name, fn);
  await bench.warmup();
  await bench.run();
  const task = bench.getTask(name);
  const result = task?.result;
  if (!result || result.error) {
    throw new Error(`tinybench task ${name} failed: ${String(result?.error)}`);
  }
  return result.samples;
}

export interface ManualOpts {
  warmup: number;
  iterations: number;
  /** Untimed per-iteration setup (e.g. mutating a payload so each save writes genuinely new
   *  chunks); runs before each warmup and each measured iteration, outside the timed region. */
  prepare?: (i: number) => Promise<void> | void;
}

/**
 * Manual timing for heavy / structural workloads (large checkpoint saves, GC passes) where
 * tinybench's auto-iteration model does not fit — but the samples feed the SAME {@link summarize}
 * so the baseline schema stays uniform.
 */
export async function measureManual(
  fn: () => Promise<unknown> | unknown,
  opts: ManualOpts,
): Promise<number[]> {
  for (let i = 0; i < opts.warmup; i++) {
    if (opts.prepare) await opts.prepare(-1 - i);
    await fn();
  }
  const samples: number[] = [];
  for (let i = 0; i < opts.iterations; i++) {
    if (opts.prepare) await opts.prepare(i);
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return samples;
}
