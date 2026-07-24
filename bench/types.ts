/**
 * G14 (`openspec/changes/v1.0.0-perf-baseline/design.md` §5) — the committed baseline artifact
 * schema and the harness version key.
 *
 * The G14 gate is EXISTENCE, not a number (`design.md` §5; council/B §3): re-running the harness
 * at {@link HARNESS_VERSION} against the same pinned image + server settings must complete and
 * emit an artifact conforming to THIS schema (same workload set, same declared envelope, same
 * statistic fields) — no latency/throughput number is ever compared. Bump {@link HARNESS_VERSION}
 * only when the workload set, the declared envelope, or the statistic fields change (a schema
 * change), never for a re-measurement.
 */
export const HARNESS_VERSION = "1.0.0-perf-baseline.1";

/** Per-workload latency distribution. `cv` (coefficient of variation = sd/mean) is what a future
 *  CV-aware regression gate keys off (`design.md` §5: a benchmark at CV≈2.66% gives ~45% false
 *  positives against a naive 2% gate — the calibrated gate is deferred post-1.0.0). */
export interface LatencyStats {
  unit: "ms";
  samples: number;
  min: number;
  max: number;
  mean: number;
  sd: number;
  /** Coefficient of variation, sd/mean (unitless). */
  cv: number;
  p50: number;
  p95: number;
  p99: number;
}

/** One point on the GC-pass-duration-vs-live-chunk-count curve (`design.md` §5, HP-6). */
export interface GcPoint {
  liveChunks: number;
  passMs: number;
}

/** The GC anti-join scale measurement + the operational cliff adjudication (`design.md` §5). */
export interface GcCurve {
  declaredEnvelope: {
    targetMinChunks: number;
    targetMaxChunks: number;
    actualMinChunks: number;
    actualMaxChunks: number;
    /** True when the actual run was capped below the declared upper target for runtime sanity —
     *  the un-run remainder is documented as the SC-2 ceiling, not measured. */
    cappedBelowTarget: boolean;
    note: string;
  };
  /** Declared super-linear growth factor: a cliff is met when pass-duration growth between two
   *  measured points exceeds `K` times the live-chunk-count growth between them. */
  K: number;
  /** Declared absolute per-pass duration bound (ms): a cliff is met when any single pass exceeds it. */
  D_ms: number;
  points: GcPoint[];
  /** The explicit, rule-based adjudication (met / not-met, first-met chunk count) — so a cliff,
   *  if present, is detectable by the declared rule, not by eyeball (`design.md` §5, Fable E3). */
  cliffDetermination: {
    met: boolean;
    reason: "none" | "K-superlinear" | "D-absolute";
    firstMetLiveChunks: number | null;
    note: string;
  };
}

/** A measured HOT-update ratio, recorded as an OBSERVATION (not a causal isolation of fillfactor —
 *  Sprint 4 task 0.2's precedent; `design.md` §3). */
export interface HotRatio {
  table: string;
  n_tup_upd: number;
  n_tup_hot_upd: number;
  hotRatio: number | null;
  note: string;
}

/** The pinned environment the baseline was recorded against (`design.md` §5). */
export interface EnvironmentBlock {
  postgresImage: string;
  /** The resolved local image id (best-effort via `docker inspect`), since the image is pinned by
   *  tag against a locally-cached layer set in this offline environment; null if unavailable. */
  postgresImageId: string | null;
  postgresServerVersion: string;
  settings: { shared_buffers: string; work_mem: string; max_wal_size: string };
  node: string;
  microbenchLib: string;
  harnessVersion: string;
  profile: string;
  declaredCaps: {
    checkpointSaveSizesMB: number[];
    checkpointSaveDeclaredCeilingMB: number;
    gcEnvelopeTargetChunks: [number, number];
    gcActualMaxChunks: number;
    note: string;
  };
}

/** The committed baseline artifact (`bench/baseline.<harness-version>.json`). */
export interface Baseline {
  schema: "umbradb-perf-baseline/v1";
  harnessVersion: string;
  generatedAt: string;
  environment: EnvironmentBlock;
  /** Per-workload latency stats, keyed `<module>.<operation>[.<param>]`. */
  workloads: Record<string, LatencyStats>;
  measurements: {
    checkpointDedupRatio: { referenced: number; written: number; ratio: number; note: string };
    kvCurrentHotRatio: HotRatio;
    watermarksHotRatio: HotRatio;
    transactionHistoryGinWriteP99Ms: number;
  };
  gcCurve: GcCurve;
}
