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
 * ── Coverage floors (measure-first ratchet, at §2.3's BINDING 90/85) ─────────────────────────
 * §2.3 makes the durability-critical per-file floors **binding, not recommended**: "the initial
 * floors MUST be set at exactly these values or higher — 90% lines / 85% branches per-file on
 * critical globs; 80% lines / 70% branches repo-wide — and MUST NOT be lowered thereafter." So
 * every durability-critical `src/postgres/**` file below has a per-file floor of **>= 90 lines /
 * >= 85 branches**. §2.3 gates LINES and BRANCHES only, so only those two metrics are thresholded.
 * Measured (lines% / branch%) over the deterministic Testcontainers set (`test/postgres` +
 * `test/integration/crash` + `test/integration/soak`), 2026-07-24:
 *
 *   checkpoint-store.ts   96.58 / 96.07     save-and-advance.ts  100   / 100
 *   watermarks.ts        100    / 100       durability-probe.ts  100   / 95.83
 *   errors.ts             97.43 / 94.73     temporal-kv.ts        94.25 / 85.91
 *   migrate.ts            93.33 / 85.71     transaction-lease.ts  96.02 / 91.96
 *   repo-wide total       93.47 / 86.05 (lines / branches)
 *
 * All eight durability modules now clear §2.3's 90/85 target: `transaction-lease.ts` reached it via
 * the targeted `tryAcquireLease` reserve/timeout/abort/success branch tests added in this change
 * (its previous 89.20 / 81.25 was the one module still under it). Each per-file floor is pinned at
 * or a few points below the measured value, but NEVER below 90/85 — a floor that is green today and
 * ratchets up, never a target (§3.6). The repo-wide per-file floor (85 lines / 78 branches) is
 * STRONGER than §2.3's 80/70 repo-wide aggregate.
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

// Per-file durability floors (lines / branches) — BINDING §2.3 minimum is 90 / 85; each is pinned
// at or a few points below the measured value but NEVER under 90 / 85. `**​/postgres/<file>.ts`
// matches exactly the postgres adapter (not its `interfaces/` namesake).
const DURABILITY = {
  "**/postgres/checkpoint-store.ts": { lines: 94, branches: 93, perFile: true },
  "**/postgres/save-and-advance.ts": { lines: 97, branches: 95, perFile: true },
  "**/postgres/watermarks.ts": { lines: 97, branches: 95, perFile: true },
  "**/postgres/durability-probe.ts": { lines: 97, branches: 92, perFile: true },
  "**/postgres/errors.ts": { lines: 95, branches: 91, perFile: true },
  // temporal-kv / migrate clear the 90/85 target on lines; their branch floors sit at the binding
  // 85 minimum (measured 85.91 / 85.71 — deterministic over the Testcontainers set).
  "**/postgres/temporal-kv.ts": { lines: 91, branches: 85, perFile: true },
  "**/postgres/migrate.ts": { lines: 90, branches: 85, perFile: true },
  // transaction-lease reached §2.3's 90/85 target via the tryAcquireLease branch tests added in this
  // change (measured 96.02 / 91.96, up from 89.20 / 81.25). Floor set at the binding 90/85.
  "**/postgres/transaction-lease.ts": { lines: 90, branches: 85, perFile: true },
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
        // Stricter per-file floors on the durability-critical modules (BINDING 90/85, §2.3).
        ...DURABILITY,
      },
    },
  },
});
