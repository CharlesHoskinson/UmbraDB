#!/usr/bin/env node
// Per-adapter StrykerJS runner + aggregate gate (v1.0.0-recovery-testing Task 7.3). Runs EACH
// durability adapter's mutation pass as its OWN `stryker run --mutate <file>` invocation, so every
// adapter reuses ONE Testcontainers Postgres -- the fast, MEASURED path -- instead of one interleaved
// `stryker run` that churns a container per file switch.
//
// EVIDENCE DISCIPLINE (change-level round-3 BLOCK 5). The old runner scored absence-of-evidence as a
// pass: it ignored a nonzero Stryker exit whenever any JSON report existed, and scored ZERO usable
// mutants as 100%. So an adapter with an empty report or only CompileError/RuntimeError mutants
// contributed NO evidence yet the run exited 0. This runner FAILS (nonzero exit) if ANY adapter
//   (a) makes Stryker exit nonzero, (b) produces a missing/empty report, or (c) yields ZERO valid
//   mutants (all compile/runtime errors => no evidence). It requires POSITIVE evidence per adapter
//   (validMutants > 0) AND gates the AGGREGATE killed/valid score (over VALID mutants only) against
//   `thresholds.break`. "No mutants" is NEVER 100%.
//
// PER-ADAPTER BREAK NEUTRALIZATION. An adapter run in isolation lacks the sibling-suite coverage the
// interleaved config gives it, so its isolated score is a conservative LOWER BOUND (transaction-lease
// alone 64.83% < break 65). We gate the AGGREGATE, not each adapter. To ALSO treat a nonzero Stryker
// exit as a genuine failure (BLOCK 5(a)), we run each adapter under a per-adapter config whose
// `thresholds.break = 0` -- so a low score never itself trips a nonzero exit, leaving a nonzero exit
// to mean a real Stryker error (config / dry-run / internal), which we then fail on.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tallyMutants, gateAdapters } from "./mutation-evidence.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const conf = JSON.parse(readFileSync(path.join(ROOT, "stryker.conf.json"), "utf8"));
const BREAK = conf.thresholds.break;
// Default: every adapter stryker.conf.json mutates. MUTATION_ADAPTERS (comma-separated) overrides for
// local/scoped validation only; CI runs the full set.
const adapters = (process.env.MUTATION_ADAPTERS ?? conf.mutate.join(","))
  .split(",").map((x) => x.trim()).filter(Boolean);
const STRYKER = path.join(ROOT, "node_modules", "@stryker-mutator", "core", "bin", "stryker.js");
const JSON_REPORT = path.join(ROOT, "reports", "mutation", "mutation.json");

// A per-adapter config that reuses the committed config but neutralizes the per-adapter break, so an
// isolated low score does NOT itself cause a nonzero exit (we gate on the aggregate). Written into ROOT
// so its relative paths (vitest.mutation.config.ts) resolve against the repo; removed on exit.
const PER_ADAPTER_CONF = path.join(ROOT, ".stryker-per-adapter.conf.json");
writeFileSync(
  PER_ADAPTER_CONF,
  JSON.stringify({ ...conf, thresholds: { ...conf.thresholds, break: 0 } }, null, 2),
  "utf8",
);

const rows = [];
const results = [];
try {
  for (const file of adapters) {
    if (existsSync(JSON_REPORT)) rmSync(JSON_REPORT);
    console.log(`\n=== mutation adapter: ${file} ===`);
    const t0 = Date.now();
    const res = spawnSync(
      process.execPath,
      [STRYKER, "run", PER_ADAPTER_CONF, "--mutate", file, "--reporters", "clear-text,json"],
      { cwd: ROOT, stdio: "inherit", env: process.env },
    );
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    const strykerExit = res.status == null ? 1 : res.status;
    const reportPresent = existsSync(JSON_REPORT);
    let tally = null;
    if (reportPresent) {
      try {
        tally = tallyMutants(JSON.parse(readFileSync(JSON_REPORT, "utf8")));
      } catch (err) {
        console.error(`  unparseable JSON report for ${file}: ${err.message}`);
        tally = null;
      }
    }
    results.push({ file, strykerExit, reportPresent: reportPresent && tally !== null, tally });
    const score = tally && tally.valid > 0 ? ((tally.killed + tally.timeout) / tally.valid) * 100 : null;
    rows.push({ file, tally, score, secs, strykerExit });
    if (tally) {
      console.log(`  -> killed=${tally.killed} timeout=${tally.timeout} survived=${tally.survived} ` +
        `noCoverage=${tally.noCoverage} excluded=${tally.excluded} valid=${tally.valid} ` +
        `score=${score === null ? "n/a" : score.toFixed(2) + "%"} exit=${strykerExit} (${secs}s)`);
    } else {
      console.log(`  -> NO/UNPARSEABLE REPORT exit=${strykerExit} (${secs}s)`);
    }
  }
} finally {
  if (existsSync(PER_ADAPTER_CONF)) rmSync(PER_ADAPTER_CONF);
}

const gate = gateAdapters(results, BREAK);

console.log("\n================ mutation aggregate ================");
for (const r of rows) {
  const s = r.score === null ? "  n/a " : `${r.score.toFixed(2).padStart(6)}%`;
  const v = r.tally ? r.tally.valid : 0;
  console.log(`  ${r.file.padEnd(38)} ${s}  valid=${String(v).padStart(4)}  exit=${r.strykerExit}  (${r.secs}s)`);
}
console.log(`  TOTALS: killed=${gate.killed} timeout=${gate.timeout} survived=${gate.survived} noCoverage=${gate.noCoverage} (valid=${gate.valid})`);

if (!gate.ok) {
  console.error(`\nMUTATION GATE FAILED (${gate.failures.length} reason(s)):`);
  for (const f of gate.failures) console.error(`  - ${f}`);
  // A per-adapter evidence failure (crash / missing / zero-valid) is exit 2; a pure aggregate-below-break
  // is exit 1 -- both nonzero, both fail the gate.
  const evidenceFailure = gate.aggregate === null;
  process.exit(evidenceFailure ? 2 : 1);
}
console.log(`  AGGREGATE mutation score = ${gate.aggregate.toFixed(2)}%   break = ${BREAK}%`);
console.log(`\nMUTATION GATE PASSED: aggregate ${gate.aggregate.toFixed(2)}% >= break ${BREAK}% over ${gate.valid} valid mutants across ${rows.length} adapter(s), every adapter contributing positive evidence.`);
process.exit(0);
