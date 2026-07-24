#!/usr/bin/env node
// Per-adapter StrykerJS runner + aggregate gate (v1.0.0-recovery-testing Task 7.3; conformance
// re-audit BLOCK 4). Runs EACH durability adapter's mutation pass as its OWN
// `stryker run --mutate <file>` invocation, so every adapter reuses ONE Testcontainers Postgres —
// the fast, MEASURED ~23 min path (17s/85s/348s/323s/611s on a 24-core host) — instead of the single
// interleaved `stryker run` that churns a container per file switch and is slower/unbounded (the
// reason CI's 20-min budget could kill the gate before it produced a verdict).
//
// Threshold semantics: an adapter run in ISOLATION lacks the sibling-suite coverage the interleaved
// config gives it (checkpoint-store.test.ts / save-and-advance.test.ts also drive transaction-lease.ts
// etc.), so per-adapter scores are a conservative LOWER BOUND — transaction-lease alone is 64.83%,
// below the committed break:65. We therefore DO NOT gate each adapter on its own break (Stryker may
// exit non-zero for such an adapter; that exit is ignored). Instead we sum every adapter's mutant
// outcomes and gate the AGGREGATE mutation score against `thresholds.break` from stryker.conf.json
// (the committed 65; measured aggregate 70.68%). The aggregate being a lower bound for the interleaved
// run, gating it is honest and strictly conservative.
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const conf = JSON.parse(readFileSync(path.join(ROOT, "stryker.conf.json"), "utf8"));
const BREAK = conf.thresholds.break;
// Default: every adapter stryker.conf.json mutates. MUTATION_ADAPTERS (comma-separated) overrides
// for local validation only; CI runs the full set.
const adapters = (process.env.MUTATION_ADAPTERS ?? conf.mutate.join(","))
  .split(",").map((x) => x.trim()).filter(Boolean);
const STRYKER = path.join(ROOT, "node_modules", "@stryker-mutator", "core", "bin", "stryker.js");
const JSON_REPORT = path.join(ROOT, "reports", "mutation", "mutation.json");

let killed = 0, timeout = 0, survived = 0, noCoverage = 0, excluded = 0;
const rows = [];

for (const file of adapters) {
  if (existsSync(JSON_REPORT)) rmSync(JSON_REPORT);
  console.log(`\n=== mutation adapter: ${file} ===`);
  const t0 = Date.now();
  const res = spawnSync(
    process.execPath,
    [STRYKER, "run", "--mutate", file, "--reporters", "clear-text,json"],
    { cwd: ROOT, stdio: "inherit", env: process.env },
  );
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  // Stryker's own exit may be non-zero when a per-adapter break fires; we gate on the AGGREGATE, so a
  // MISSING/unparseable report (a genuine crash) is the only hard failure at this stage.
  if (!existsSync(JSON_REPORT)) {
    console.error(`FATAL: no JSON report for ${file} (stryker exit ${res.status}); cannot gate.`);
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(JSON_REPORT, "utf8"));
  let k = 0, t = 0, sv = 0, nc = 0, ex = 0;
  for (const f of Object.values(report.files ?? {})) {
    for (const m of f.mutants ?? []) {
      switch (m.status) {
        case "Killed": k++; break;
        case "Timeout": t++; break;
        case "Survived": sv++; break;
        case "NoCoverage": nc++; break;
        default: ex++; // CompileError / RuntimeError / Ignored — excluded from the score denominator
      }
    }
  }
  killed += k; timeout += t; survived += sv; noCoverage += nc; excluded += ex;
  const valid = k + t + sv + nc;
  const score = valid === 0 ? 100 : ((k + t) / valid) * 100;
  rows.push({ file, k, t, sv, nc, ex, score, secs });
  console.log(`  -> killed=${k} timeout=${t} survived=${sv} noCoverage=${nc} excluded=${ex} score=${score.toFixed(2)}% (${secs}s)`);
}

const valid = killed + timeout + survived + noCoverage;
const aggregate = valid === 0 ? 100 : ((killed + timeout) / valid) * 100;

console.log("\n================ mutation aggregate ================");
for (const r of rows) console.log(`  ${r.file.padEnd(38)} ${r.score.toFixed(2).padStart(6)}%  (${r.secs}s)`);
console.log(`  TOTALS: killed=${killed} timeout=${timeout} survived=${survived} noCoverage=${noCoverage} excluded=${excluded} (valid=${valid})`);
console.log(`  AGGREGATE mutation score = ${aggregate.toFixed(2)}%   break = ${BREAK}%`);

if (aggregate < BREAK) {
  console.error(`\nMUTATION GATE FAILED: aggregate ${aggregate.toFixed(2)}% < break ${BREAK}%`);
  process.exit(1);
}
console.log(`\nMUTATION GATE PASSED: aggregate ${aggregate.toFixed(2)}% >= break ${BREAK}%`);
process.exit(0);
