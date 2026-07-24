import { defineConfig } from "vitest/config";

/**
 * UmbraDB test + coverage configuration.
 *
 * Behaviour of `vitest run` is unchanged from the pre-config defaults (default `forks` pool,
 * default `**​/*.{test,spec}.ts` include, no global setup) — this file exists to add the
 * **coverage gate** that `v1.0.0-recovery-testing` owns and must CI-wire before G9 is declared
 * CLOSED (`docs/v1-implementation-guideline.md` §1.0, §2.3, §3.6). `src/` behaviour is untouched;
 * coverage only READS `src`.
 *
 * ── Coverage floors (measure-first ratchet) ──────────────────────────────────────────────────
 * The floors were set by MEASURING current coverage (v8, over the deterministic Testcontainers
 * set `test/postgres` + `test/integration/crash` + `test/integration/soak`) and pinning each floor
 * a few points BELOW the measured value, so the gate is green today and ratchets up — a floor,
 * never a target (§3.6). §2.3 gates LINES and BRANCHES (90/85 per-file on the durability-critical
 * modules; 80/70 repo-wide), so only those two metrics are thresholded. Measured (lines% / branch%),
 * 2026-07-24:
 *
 *   checkpoint-store.ts   96.58 / 96.07     save-and-advance.ts  100   / 100
 *   watermarks.ts        100    / 100       durability-probe.ts  100   / 95.83
 *   errors.ts             97.43 / 94.73     temporal-kv.ts        94.25 / 85.91
 *   migrate.ts            93.33 / 85.71     transaction-lease.ts  89.20 / 81.25
 *   repo-wide total       93.47 / 86.05 (lines / branches)
 *
 * Seven of the eight durability modules ALREADY clear §2.3's 90/85 target today;
 * `transaction-lease.ts` (89.20 / 81.25) is the one still under it — its per-file floor here is
 * green-now (86 / 78) and the ratchet to 90/85 needs a small branch-coverage top-up on the lease
 * adapter (test work, tracked as a follow-up; out of this infra-only task's scope, which leaves
 * `src/` byte-unchanged). The global per-file floor (85 lines / 78 branches) is STRONGER than
 * §2.3's 80/70 repo-wide aggregate.
 *
 * vitest-4 semantics honoured: a file matched by a glob threshold is checked ONLY against that
 * glob (the global thresholds are NOT inherited), and glob keys must be real patterns — hence the
 * `**​/postgres/<file>.ts` form (a bare relative path does not match the provider's file paths) and
 * the explicit `perFile: true` on each glob (globs do not inherit the top-level `perFile`).
 *
 * The deferred full-chain-archival track (`chain-archive-*`, `migrations/chain_archive/**`;
 * acceptance-criteria I6 — out of 1.0.0 and untouched here) is excluded from the 1.0.0 coverage
 * gate; it is not durable-checkpoint-cursor code and its own suite still runs in the gate.
 */

// Per-file durability floors (lines / branches), pinned a few points below the measured value.
// `**​/postgres/<file>.ts` matches exactly the postgres adapter (not its `interfaces/` namesake).
const DURABILITY = {
  "**/postgres/checkpoint-store.ts": { lines: 94, branches: 93, perFile: true },
  "**/postgres/save-and-advance.ts": { lines: 97, branches: 95, perFile: true },
  "**/postgres/watermarks.ts": { lines: 97, branches: 95, perFile: true },
  "**/postgres/durability-probe.ts": { lines: 97, branches: 92, perFile: true },
  "**/postgres/errors.ts": { lines: 95, branches: 91, perFile: true },
  "**/postgres/temporal-kv.ts": { lines: 91, branches: 82, perFile: true },
  "**/postgres/migrate.ts": { lines: 90, branches: 82, perFile: true },
  // The one durability module still under §2.3's 90/85 target (89.20 lines / 81.25 branches).
  // Green-now floor; ratchets toward 90/85 once the lease adapter's error/timeout branches gain
  // coverage.
  "**/postgres/transaction-lease.ts": { lines: 86, branches: 78, perFile: true },
} as const;

export default defineConfig({
  test: {
    // Teardown budget. `registerSuiteLifecycle`'s afterAll already sets 60s explicitly because
    // `container.stop()` can exceed the 10s default under heavy host load; suites with a plain
    // inline afterAll (e.g. chain-archive-rollover) inherit this global so coverage-instrumented,
    // fully-parallel runs don't flake on teardown. Inline explicit timeouts still win.
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/index.ts",
        // Deferred full-chain-archival track — out of 1.0.0 (acceptance-criteria I6).
        "src/postgres/chain-archive-store.ts",
        "src/postgres/chain-archive-rollover.ts",
        "src/interfaces/chain-archive-store.ts",
        "src/postgres/migrations/chain_archive/**",
      ],
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "./coverage",
      thresholds: {
        // Repo-wide floor, checked PER FILE (§2.3 `perFile: true`) — stronger than §2.3's 80/70
        // repo-wide aggregate. Applies to every included file NOT matched by a durability glob.
        perFile: true,
        lines: 85,
        branches: 78,
        // Stricter per-file floors on the durability-critical modules.
        ...DURABILITY,
      },
    },
  },
});
