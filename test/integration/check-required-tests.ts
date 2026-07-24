/**
 * Skip-enforcement reconciliation (v1.0.0-recovery-testing, Task 0.4 — `design.md` §1.1).
 *
 * `vitest run` does NOT fail on a skipped / `skipIf` / `todo` test by default, so "the required
 * crash/soak suite does not self-skip" cannot be left to convention — this is the NAMED enforcement
 * mechanism (auditors' BLOCKING-3 / finding 2). It reads Vitest's JSON reporter output and asserts
 * every id in the manifest's `"required"` list was executed AND passed; if any is missing or
 * reported skipped/todo/failed it exits NON-ZERO and NAMES the id. Ids in `"deferred"` are the
 * `WHERE`-gated optional-feature scenarios (e.g. the no-duplicate-on-retry idempotency-key path):
 * they reconcile as `skipped-pending-feature` and are EXEMPT from the must-execute check while
 * their feature is unshipped.
 *
 * Test identity: each governed test embeds its stable id as a `[[id]]` token in its title (which
 * Vitest surfaces verbatim in `assertionResults[].title`/`fullName`). This module extracts those
 * tokens and reconciles them against the manifest. Ids are collision-free by the `[[ ]]` sentinel.
 *
 * Exposed as pure functions (`reconcile`, `extractIds`, `statusesFromReport`) so the behaviour is
 * unit-tested against synthetic reporter payloads (`check-required-tests.test.ts`), and as a CLI
 * (`node --import tsx check-required-tests.ts <report.json> [--manifest <path>]`) wired into
 * `test:conformance` by Task 7.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface ManifestEntry {
  /** Stable id, matched against the `[[id]]` token embedded in a test's title. */
  id: string;
  /** Informational: the file the test lives in. */
  file?: string;
  /** Informational: what the test proves. */
  description?: string;
  /** For `deferred` entries: the unshipped feature that gates this scenario. */
  pendingFeature?: string;
}

export interface RequiredTestsManifest {
  required: ManifestEntry[];
  deferred: ManifestEntry[];
}

/** The subset of Vitest's JSON reporter shape this checker reads (Jest-compatible). */
export interface JsonReportAssertion {
  status?: string; // "passed" | "failed" | "skipped" | "todo" | "pending"
  title?: string;
  fullName?: string;
}
export interface JsonReportFile {
  name?: string;
  assertionResults?: JsonReportAssertion[];
}
export interface JsonReport {
  testResults?: JsonReportFile[];
}

export type ViolationReason = "missing" | "skipped" | "todo" | "pending" | "failed" | "ambiguous" | "unknown-status";

export interface ReconcileResult {
  ok: boolean;
  /** required ids that did not execute-and-pass. */
  violations: Array<{ id: string; reason: ViolationReason; statuses: string[] }>;
  /** deferred ids and how they reconciled (informational; never fails the gate). */
  deferredReconciled: Array<{ id: string; statuses: string[]; state: "skipped-pending-feature" | "passed" | "missing" | "other" }>;
  summary: string;
}

const ID_TOKEN = /\[\[([^\]]+)\]\]/g;

/** Extracts every `[[id]]` token from a piece of text (a test title / fullName). */
export function extractIds(text: string): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(ID_TOKEN)) ids.push(m[1]!);
  return ids;
}

/** Builds a map of stable-id -> the list of statuses reported for tests carrying that id. */
export function statusesFromReport(report: JsonReport): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  for (const file of report.testResults ?? []) {
    for (const a of file.assertionResults ?? []) {
      const text = `${a.fullName ?? ""} ${a.title ?? ""}`;
      const status = (a.status ?? "unknown").toLowerCase();
      for (const id of new Set(extractIds(text))) {
        const list = byId.get(id) ?? [];
        list.push(status);
        byId.set(id, list);
      }
    }
  }
  return byId;
}

/** Reconciles a Vitest JSON report against a required/deferred manifest. */
export function reconcile(report: JsonReport, manifest: RequiredTestsManifest): ReconcileResult {
  const byId = statusesFromReport(report);
  const violations: ReconcileResult["violations"] = [];

  for (const entry of manifest.required) {
    const statuses = byId.get(entry.id);
    if (statuses === undefined || statuses.length === 0) {
      violations.push({ id: entry.id, reason: "missing", statuses: [] });
      continue;
    }
    if (statuses.length > 1) {
      // An id must identify exactly one test; more than one is an ambiguous/collided id.
      violations.push({ id: entry.id, reason: "ambiguous", statuses });
      continue;
    }
    const status = statuses[0]!;
    if (status === "passed") continue;
    const reason: ViolationReason =
      status === "skipped" || status === "todo" || status === "pending" || status === "failed"
        ? status
        : "unknown-status";
    violations.push({ id: entry.id, reason, statuses });
  }

  const deferredReconciled: ReconcileResult["deferredReconciled"] = manifest.deferred.map((entry) => {
    const statuses = byId.get(entry.id) ?? [];
    let state: "skipped-pending-feature" | "passed" | "missing" | "other";
    if (statuses.length === 0) state = "missing"; // pending-feature test not yet authored — OK
    else if (statuses.every((s) => s === "skipped" || s === "todo" || s === "pending")) state = "skipped-pending-feature";
    else if (statuses.every((s) => s === "passed")) state = "passed"; // feature shipped early — OK
    else state = "other";
    return { id: entry.id, statuses, state };
  });

  const ok = violations.length === 0;
  const summary = ok
    ? `check-required-tests: OK — all ${manifest.required.length} required test(s) executed and passed; ` +
      `${manifest.deferred.length} deferred reconciled.`
    : `check-required-tests: FAIL — ${violations.length} required test(s) did not execute-and-pass:\n` +
      violations.map((v) => `  - ${v.id}: ${v.reason}${v.statuses.length ? ` (status: ${v.statuses.join(", ")})` : ""}`).join("\n");

  return { ok, violations, deferredReconciled, summary };
}

export function loadManifest(path: string): RequiredTestsManifest {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RequiredTestsManifest>;
  return { required: raw.required ?? [], deferred: raw.deferred ?? [] };
}

export function loadReport(path: string): JsonReport {
  return JSON.parse(readFileSync(path, "utf8")) as JsonReport;
}

const DEFAULT_MANIFEST = fileURLToPath(new URL("./required-tests.manifest.json", import.meta.url));

function cli(argv: string[]): number {
  const args = argv.slice(2);
  let manifestPath = DEFAULT_MANIFEST;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--manifest") { manifestPath = args[++i] ?? manifestPath; }
    else positional.push(args[i]!);
  }
  const reportPath = positional[0] ?? process.env.UMBRADB_TEST_REPORT_JSON;
  if (reportPath === undefined) {
    process.stderr.write(
      "usage: check-required-tests.ts <vitest-report.json> [--manifest <path>]\n" +
      "       (or set UMBRADB_TEST_REPORT_JSON). Produce the report with `vitest run --reporter=json --outputFile=<path>`.\n",
    );
    return 2;
  }
  const result = reconcile(loadReport(reportPath), loadManifest(manifestPath));
  process.stdout.write(result.summary + "\n");
  for (const d of result.deferredReconciled) {
    process.stdout.write(`  deferred ${d.id}: ${d.state}${d.statuses.length ? ` (status: ${d.statuses.join(", ")})` : ""}\n`);
  }
  return result.ok ? 0 : 1;
}

// Run the CLI only when executed directly (not when imported by the unit test).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(cli(process.argv));
}
