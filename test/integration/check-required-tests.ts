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
  /** REQUIRED for a `required` entry (change-level audit BLOCK 9(c)): the test FILE that MUST carry
   *  this id. The reconciliation FAILS if the id executed-and-passed from a DIFFERENT file — so
   *  moving an id's token to a trivial passing test elsewhere is caught, not silently counted.
   *  {@link loadManifest} rejects any `required` entry lacking it. Optional only for the synthetic
   *  inline manifests the unit tests use. */
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

export type ViolationReason = "missing" | "skipped" | "todo" | "pending" | "failed" | "ambiguous" | "wrong-file" | "unknown-status" | "deferred-absent" | "deferred-unexpected";

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

/** The pinned count of `required` tests (change-level audit BLOCK 9(b)). Structurally PINS the
 *  manifest so silently deleting (or adding) a required entry fails the gate: {@link loadManifest}
 *  rejects a manifest whose `required` length drifts from this constant. Bump it deliberately when
 *  a required test is genuinely added/removed. */
export const EXPECTED_REQUIRED_COUNT = 25;

/** Normalises a file path (backslashes -> forward slashes) for cross-platform comparison. */
function normPath(p: string): string { return p.replace(/\\/g, "/"); }

/** True when a Vitest report file name (typically an absolute path) refers to the manifest's
 *  repo-relative `file`. Requires a path-segment boundary so a suffix collision (`xtest/...`
 *  ending with `test/...`) cannot match. */
export function fileMatches(reportFileName: string, manifestFile: string): boolean {
  const rf = normPath(reportFileName);
  const mf = normPath(manifestFile);
  return rf === mf || rf.endsWith("/" + mf);
}

/** Per stable-id, the set of report FILE names in which a test carrying that id was reported
 *  PASSED. Drives {@link reconcile}'s id -> file binding enforcement (BLOCK 9(c)). */
export function passedFilesFromReport(report: JsonReport): Map<string, Set<string>> {
  const byId = new Map<string, Set<string>>();
  for (const file of report.testResults ?? []) {
    const fname = file.name ?? "";
    for (const a of file.assertionResults ?? []) {
      if ((a.status ?? "").toLowerCase() !== "passed") continue;
      const text = `${a.fullName ?? ""} ${a.title ?? ""}`;
      for (const id of new Set(extractIds(text))) {
        const set = byId.get(id) ?? new Set<string>();
        set.add(fname);
        byId.set(id, set);
      }
    }
  }
  return byId;
}

/** Reconciles a Vitest JSON report against a required/deferred manifest. */
export function reconcile(report: JsonReport, manifest: RequiredTestsManifest): ReconcileResult {
  const byId = statusesFromReport(report);
  const passedFilesById = passedFilesFromReport(report);
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
    if (status === "passed") {
      // FILE-BINDING (BLOCK 9(c)): a "passed" id must have executed-and-passed from the file the
      // manifest pins it to. If it passed from a DIFFERENT file (e.g. its token was moved to a
      // trivial passing test), that is a violation despite the "passed" status.
      if (entry.file !== undefined) {
        const passedFiles = passedFilesById.get(entry.id) ?? new Set<string>();
        const boundToExpected =
          passedFiles.size > 0 && [...passedFiles].every((rf) => fileMatches(rf, entry.file!));
        if (!boundToExpected) {
          violations.push({ id: entry.id, reason: "wrong-file", statuses: [...passedFiles] });
        }
      }
      continue;
    }
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

  // FAIL-CLOSED deferred EXISTENCE (change-level round-3 BLOCK 6 / acceptance C6): a deferred scenario
  // MUST EXIST as a present-but-skipped test (`skipped-pending-feature`), or `passed` if its feature
  // shipped early. A deferred id ENTIRELY ABSENT from the report means the scenario was deleted/retitled
  // (losing the feature-activation wiring), so it FAILS the gate, NAMED; an `other` state fails too.
  // Previously an absent deferred id was silently accepted — the exact fail-OPEN hole this closes.
  for (const d of deferredReconciled) {
    if (d.state === "missing") violations.push({ id: d.id, reason: "deferred-absent", statuses: [] });
    else if (d.state === "other") violations.push({ id: d.id, reason: "deferred-unexpected", statuses: d.statuses });
  }

  const ok = violations.length === 0;
  const summary = ok
    ? `check-required-tests: OK — all ${manifest.required.length} required test(s) executed and passed; ` +
      `${manifest.deferred.length} deferred present-and-reconciled.`
    : `check-required-tests: FAIL — ${violations.length} gate violation(s) (required not-run/failed OR deferred absent/unexpected):\n` +
      violations.map((v) => `  - ${v.id}: ${v.reason}${v.statuses.length ? ` (status: ${v.statuses.join(", ")})` : ""}`).join("\n");

  return { ok, violations, deferredReconciled, summary };
}

/**
 * Loads and STRUCTURALLY VALIDATES the manifest, FAIL-CLOSED (change-level audit BLOCK 9(a)/(b)/(c)):
 * a missing, unparseable, empty, or drifted manifest THROWS — it must NEVER be silently coerced to
 * an empty required set that reconciles as "all 0 required passed" (the exact fail-OPEN hole this
 * closes). Enforced, in order: the file parses; `required` is a NON-EMPTY array; every required
 * entry has a string `id` and a bound `file`; and `required.length` equals the pinned
 * {@link EXPECTED_REQUIRED_COUNT}. `deferred` may be empty/absent.
 */
export function loadManifest(path: string): RequiredTestsManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `check-required-tests: manifest at ${path} is missing or unparseable — FAIL-CLOSED (a missing/broken manifest must never pass the gate): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const required = (raw as { required?: unknown }).required;
  if (!Array.isArray(required) || required.length === 0) {
    throw new Error(
      `check-required-tests: manifest at ${path} has no non-empty "required" array — FAIL-CLOSED. An empty/absent required set must NOT reconcile as "all 0 required passed".`,
    );
  }
  for (const entry of required as ManifestEntry[]) {
    if (typeof entry?.id !== "string" || entry.id.length === 0) {
      throw new Error(`check-required-tests: a "required" entry is missing a string "id" — FAIL-CLOSED.`);
    }
    if (typeof entry?.file !== "string" || entry.file.length === 0) {
      throw new Error(
        `check-required-tests: required entry "${String(entry?.id)}" is missing its bound "file" — every required id MUST name the test file that carries it (BLOCK 9(c) file-binding).`,
      );
    }
  }
  if (required.length !== EXPECTED_REQUIRED_COUNT) {
    throw new Error(
      `check-required-tests: manifest "required" length ${required.length} != pinned ${EXPECTED_REQUIRED_COUNT} — a required entry was added or deleted without updating the pinned count (BLOCK 9(b) structural pin). If this change is intentional, update EXPECTED_REQUIRED_COUNT.`,
    );
  }
  const deferredRaw = (raw as { deferred?: unknown }).deferred;
  const deferred = Array.isArray(deferredRaw) ? (deferredRaw as ManifestEntry[]) : [];
  return { required: required as ManifestEntry[], deferred };
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
  let manifest: RequiredTestsManifest;
  try {
    manifest = loadManifest(manifestPath);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2; // FAIL-CLOSED: a missing/emptied/drifted manifest fails the gate, never passes it.
  }
  let report: JsonReport;
  try {
    report = loadReport(reportPath);
  } catch (err) {
    process.stderr.write(
      `check-required-tests: could not read the vitest report at ${reportPath} — FAIL-CLOSED: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }
  const result = reconcile(report, manifest);
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
