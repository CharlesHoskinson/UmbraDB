#!/usr/bin/env node
/**
 * The required conformance gate (v1.0.0-recovery-testing, Task 7 — `design.md` §0/§1.1).
 *
 * One command, two guarantees:
 *   1. `vitest run` with the coverage gate (thresholds in `vitest.config.ts`) — the crash, soak
 *      and differential suites run with `UMBRADB_LIVE_PREPROD` UNSET, so they execute against
 *      Testcontainers and do NOT self-skip; a Jest-compatible JSON report is emitted.
 *   2. the `check-required-tests.ts` reconciliation over that report — fails the gate by id if any
 *      manifest `"required"` test did not execute-and-pass (a re-introduced `describe.skipIf`
 *      turns the gate red by id, not by luck); `"deferred"` optional-feature ids reconcile as
 *      `skipped-pending-feature` and never fail the gate.
 *
 * The gate exits non-zero if EITHER vitest (tests OR coverage threshold) OR the reconciliation
 * fails. vitest runs first and always to completion; the reconciliation runs even when vitest
 * failed so a skipped required id is still NAMED. Extra CLI args are forwarded to vitest
 * (e.g. a file filter for a scoped local run).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = resolve(repoRoot, ".conformance-report.json");
const checker = resolve(repoRoot, "test/integration/check-required-tests.ts");
const forwarded = process.argv.slice(2);

const env = { ...process.env };
// Belt-and-suspenders: the crash/soak/differential suites run on Testcontainers, not the live
// tier — make sure the live gate is unset so nothing self-skips behind it.
delete env.UMBRADB_LIVE_PREPROD;

const vitest = spawnSync(
  "npx",
  [
    "vitest",
    "run",
    "--coverage",
    "--reporter=default",
    "--reporter=json",
    `--outputFile=${reportPath}`,
    ...forwarded,
  ],
  { cwd: repoRoot, env, stdio: "inherit", shell: process.platform === "win32" },
);
const vitestExit = vitest.status ?? 1;

if (!existsSync(reportPath)) {
  console.error(
    `\nconformance-gate: FATAL — vitest produced no JSON report at ${reportPath}; cannot reconcile required tests.`,
  );
  process.exit(vitestExit || 1);
}

console.log("\nconformance-gate: reconciling the required-tests manifest against the run…");
const check = spawnSync(
  "node",
  ["--import", "tsx", checker, reportPath],
  { cwd: repoRoot, env, stdio: "inherit", shell: process.platform === "win32" },
);
const checkExit = check.status ?? 1;

if (vitestExit !== 0) console.error(`conformance-gate: vitest exited ${vitestExit} (tests or coverage threshold failed).`);
if (checkExit !== 0) console.error(`conformance-gate: check-required-tests exited ${checkExit} (a required test did not execute-and-pass).`);

process.exit(vitestExit || checkExit);
