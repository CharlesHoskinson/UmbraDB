import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_REQUIRED_COUNT,
  EXPECTED_DEFERRED_COUNT,
  extractIds,
  fileMatches,
  loadManifest,
  passedFilesFromReport,
  reconcile,
  statusesFromReport,
  type JsonReport,
  type ManifestEntry,
  type RequiredTestsManifest,
} from "./check-required-tests.js";

/**
 * Unit coverage for the skip-enforcement reconciliation (Task 0.4, `design.md` §1.1). Exercises the
 * three acceptance cases deterministically against synthetic Vitest JSON reporter payloads — no
 * real vitest run needed — so the mechanism's teeth are proven in the required gate itself:
 *   (1) all required tests green  -> check passes;
 *   (2) one required test skipped  -> check fails AND names the id;
 *   (3) a deferred id skipped      -> check does NOT fail.
 */

const MANIFEST: RequiredTestsManifest = {
  required: [
    { id: "req.one" },
    { id: "req.two" },
  ],
  deferred: [
    { id: "def.optional", pendingFeature: "idempotency-key" },
  ],
};

function report(assertions: Array<{ status: string; title: string }>): JsonReport {
  return {
    testResults: [
      {
        name: "synthetic.test.ts",
        assertionResults: assertions.map((a) => ({
          status: a.status,
          title: a.title,
          fullName: `synthetic-suite ${a.title}`,
        })),
      },
    ],
  };
}

describe("check-required-tests — skip-enforcement reconciliation (Task 0.4)", () => {
  it("extractIds pulls every [[id]] token and ignores plain text", () => {
    expect(extractIds("foo [[a.b.c]] bar [[d.e]] baz")).toEqual(["a.b.c", "d.e"]);
    expect(extractIds("no tokens here")).toEqual([]);
  });

  it("statusesFromReport maps ids to their reported statuses", () => {
    const r = statusesFromReport(report([
      { status: "passed", title: "[[req.one]] ok" },
      { status: "skipped", title: "[[def.optional]] pending" },
    ]));
    expect(r.get("req.one")).toEqual(["passed"]);
    expect(r.get("def.optional")).toEqual(["skipped"]);
  });

  it("(1) with all required tests green the check passes", () => {
    const result = reconcile(
      report([
        { status: "passed", title: "[[req.one]] a" },
        { status: "passed", title: "[[req.two]] b" },
        { status: "skipped", title: "[[def.optional]] pending-feature" },
      ]),
      MANIFEST,
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    // the deferred id reconciles as skipped-pending-feature, not a violation
    expect(result.deferredReconciled).toContainEqual({
      id: "def.optional",
      statuses: ["skipped"],
      state: "skipped-pending-feature",
    });
  });

  it("(2) with one required test deliberately skipped the check FAILS and names the id", () => {
    const result = reconcile(
      report([
        { status: "passed", title: "[[req.one]] a" },
        { status: "skipped", title: "[[req.two]] b (describe.skipIf'd)" },
        { status: "skipped", title: "[[def.optional]] pending-feature" },
      ]),
      MANIFEST,
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([{ id: "req.two", reason: "skipped", statuses: ["skipped"] }]);
    expect(result.summary).toContain("req.two"); // the id is named in the failure summary
  });

  it("(2b) a required test entirely MISSING from the report is a named violation", () => {
    const result = reconcile(
      report([
        { status: "passed", title: "[[req.one]] a" },
        { status: "skipped", title: "[[def.optional]] pending-feature" },
      ]),
      MANIFEST,
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([{ id: "req.two", reason: "missing", statuses: [] }]);
    expect(result.summary).toContain("req.two");
  });

  it("(3) a deferred id being skipped does NOT fail the check", () => {
    const result = reconcile(
      report([
        { status: "passed", title: "[[req.one]] a" },
        { status: "passed", title: "[[req.two]] b" },
        { status: "skipped", title: "[[def.optional]] gated on idempotency key" },
      ]),
      MANIFEST,
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("(3b) a deferred id entirely ABSENT from the report FAILS the check (fail-closed existence — the scenario MUST EXIST as skipped-pending-feature; acceptance C6 / round-3 BLOCK 6)", () => {
    const result = reconcile(
      report([
        { status: "passed", title: "[[req.one]] a" },
        { status: "passed", title: "[[req.two]] b" },
      ]),
      MANIFEST,
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({ id: "def.optional", reason: "deferred-absent", statuses: [] });
    expect(result.summary).toContain("def.optional"); // the missing deferred scenario is NAMED
    expect(result.deferredReconciled).toContainEqual({ id: "def.optional", statuses: [], state: "missing" });
  });

  it("(3c) a deferred id present but in an unexpected (failed) state FAILS the check", () => {
    const result = reconcile(
      report([
        { status: "passed", title: "[[req.one]] a" },
        { status: "passed", title: "[[req.two]] b" },
        { status: "failed", title: "[[def.optional]] broke" },
      ]),
      MANIFEST,
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({ id: "def.optional", reason: "deferred-unexpected", statuses: ["failed"] });
  });

  it("(3d) a deferred id that PASSED (feature shipped early) does NOT fail the check", () => {
    const result = reconcile(
      report([
        { status: "passed", title: "[[req.one]] a" },
        { status: "passed", title: "[[req.two]] b" },
        { status: "passed", title: "[[def.optional]] feature shipped early" },
      ]),
      MANIFEST,
    );
    expect(result.ok).toBe(true);
    expect(result.deferredReconciled).toContainEqual({ id: "def.optional", statuses: ["passed"], state: "passed" });
  });

  it("a required id carried by MORE THAN ONE test (id collision) is a named 'ambiguous' violation", () => {
    // Two distinct tests both embed [[req.two]] — the id no longer identifies exactly one test, so
    // reconcile cannot trust its status. Even though both are 'passed', this is a violation.
    const result = reconcile(
      report([
        { status: "passed", title: "[[req.one]] a" },
        { status: "passed", title: "[[req.two]] b (first test with this id)" },
        { status: "passed", title: "[[req.two]] c (a SECOND, colliding test)" },
        { status: "skipped", title: "[[def.optional]] pending-feature" },
      ]),
      MANIFEST,
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      { id: "req.two", reason: "ambiguous", statuses: ["passed", "passed"] },
    ]);
    expect(result.summary).toContain("req.two");
  });

  it("a required test reported failed is a named violation", () => {
    const result = reconcile(
      report([
        { status: "passed", title: "[[req.one]] a" },
        { status: "failed", title: "[[req.two]] b" },
        { status: "skipped", title: "[[def.optional]] pending-feature" },
      ]),
      MANIFEST,
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([{ id: "req.two", reason: "failed", statuses: ["failed"] }]);
  });
});


/**
 * Change-level audit BLOCK 9 — the gate must FAIL CLOSED, be COUNT-PINNED, and be FILE-BOUND. These
 * cases prove the reconciliation cannot fail open (an empty/absent/drifted manifest, or an id whose
 * token was moved to a trivial passing test in another file, all turn the gate RED), and that the
 * REAL manifest is structurally valid.
 */
describe("check-required-tests — fail-closed + count-pin + file-binding (BLOCK 9)", () => {
  const MANIFEST_PATH = fileURLToPath(new URL("./required-tests.manifest.json", import.meta.url));
  const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

  function tmpManifest(obj: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "reqman-"));
    const p = join(dir, "required-tests.manifest.json");
    writeFileSync(p, JSON.stringify(obj), "utf8");
    return p;
  }

  // ---- (a) FAIL CLOSED ----
  it("loadManifest THROWS (fail-closed) on a missing or unparseable manifest", () => {
    expect(() => loadManifest(join(tmpdir(), `nope-${Date.now()}-${Math.random()}.json`))).toThrow(/FAIL-CLOSED/);
    const dir = mkdtempSync(join(tmpdir(), "reqman-"));
    const bad = join(dir, "m.json");
    writeFileSync(bad, "{ not valid json", "utf8");
    expect(() => loadManifest(bad)).toThrow(/FAIL-CLOSED/);
  });

  it("loadManifest THROWS (fail-closed) on an EMPTY or ABSENT required array — never 'all 0 passed'", () => {
    expect(() => loadManifest(tmpManifest({ required: [], deferred: [] }))).toThrow(/no non-empty "required"/);
    expect(() => loadManifest(tmpManifest({ deferred: [] }))).toThrow(/no non-empty "required"/);
  });

  // ---- (b) STRUCTURAL COUNT PIN ----
  it("loadManifest THROWS when required.length drifts from the pinned count", () => {
    const one = tmpManifest({ required: [{ id: "x", file: "a.test.ts" }], deferred: [] });
    expect(() => loadManifest(one)).toThrow(new RegExp(`!= pinned ${EXPECTED_REQUIRED_COUNT}`));
  });

  // ---- (c) FILE BINDING presence ----
  it("loadManifest THROWS when a required entry is missing its bound file", () => {
    expect(() => loadManifest(tmpManifest({ required: [{ id: "x" }], deferred: [] }))).toThrow(/missing its bound "file"/);
  });

  // ---- the REAL manifest is structurally valid ----
  it("the REAL manifest loads (count-pinned = " + String(EXPECTED_REQUIRED_COUNT) + ") and every bound file exists on disk", () => {
    const manifest = loadManifest(MANIFEST_PATH);
    expect(manifest.required.length).toBe(EXPECTED_REQUIRED_COUNT);
    for (const entry of manifest.required) {
      expect(typeof entry.file, `required ${entry.id} must bind a file`).toBe("string");
      expect(existsSync(join(REPO_ROOT, entry.file!)), `bound file for ${entry.id} must exist: ${entry.file}`).toBe(true);
    }
    // The co-transactional saveAndAdvance crash test (BLOCK 1) is a required entry.
    expect(manifest.required.some((e) => e.id === "crash.saveAndAdvance.co-tx-atomic")).toBe(true);
  });

  // ---- (c) FILE BINDING enforced by reconcile ----
  const FB_MANIFEST: RequiredTestsManifest = {
    required: [{ id: "req.bound", file: "test/integration/crash/pg-kill-save.crash.test.ts" }],
    deferred: [],
  };
  function reportInFile(fileName: string, assertions: Array<{ status: string; title: string }>): JsonReport {
    return {
      testResults: [{
        name: fileName,
        assertionResults: assertions.map((a) => ({ status: a.status, title: a.title, fullName: `suite ${a.title}` })),
      }],
    };
  }

  it("reconcile PASSES when a required id executed-and-passed in its BOUND file", () => {
    const r = reconcile(
      reportInFile("/abs/repo/test/integration/crash/pg-kill-save.crash.test.ts", [{ status: "passed", title: "[[req.bound]] ok" }]),
      FB_MANIFEST,
    );
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("reconcile FAILS (wrong-file) when a required id's token MOVED to a DIFFERENT (trivial) test file", () => {
    const movedToFile = "/abs/repo/test/integration/crash/trivial-passing.test.ts";
    const r = reconcile(
      reportInFile(movedToFile, [{ status: "passed", title: "[[req.bound]] moved to a trivial passing test" }]),
      FB_MANIFEST,
    );
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual([{ id: "req.bound", reason: "wrong-file", statuses: [movedToFile] }]);
    expect(r.summary).toContain("req.bound");
  });

  it("fileMatches respects a path-segment boundary (no suffix collision)", () => {
    expect(fileMatches("/root/UmbraDB-recovery/test/integration/crash/pg-kill-save.crash.test.ts", "test/integration/crash/pg-kill-save.crash.test.ts")).toBe(true);
    expect(fileMatches("/root/repo/xtest/integration/crash/pg-kill-save.crash.test.ts", "test/integration/crash/pg-kill-save.crash.test.ts")).toBe(false);
  });

  it("passedFilesFromReport records only PASSED assertions' files per id", () => {
    const m = passedFilesFromReport(reportInFile("/f/a.test.ts", [
      { status: "passed", title: "[[id.one]] a" },
      { status: "skipped", title: "[[id.two]] b" },
    ]));
    expect([...(m.get("id.one") ?? [])]).toEqual(["/f/a.test.ts"]);
    expect(m.get("id.two")).toBeUndefined();
  });
});


/**
 * Change-level round-4 (final hardening) — BLOCK 5 (manifest-ID uniqueness + a one-to-one id<->file
 * binding) and BLOCK 6 (deferred exemption structurally pinned + file-bound). These prove a deleted
 * required test cannot be masked by a duplicate id, the sole deferred exemption cannot be silently
 * deleted, and a deferred skipped token moved to a different file fails the gate.
 */
describe("check-required-tests — manifest-ID uniqueness + deferred pin/file-binding (BLOCK 5/6)", () => {
  function tmpManifest(obj: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "reqman-"));
    const p = join(dir, "required-tests.manifest.json");
    writeFileSync(p, JSON.stringify(obj), "utf8");
    return p;
  }
  /** A minimal VALID manifest: EXPECTED_REQUIRED_COUNT distinct file-bound required entries +
   *  EXPECTED_DEFERRED_COUNT distinct file-bound deferred entries. Callers mutate a copy to build a defect. */
  function validManifest(): { required: ManifestEntry[]; deferred: ManifestEntry[] } {
    const required: ManifestEntry[] = Array.from({ length: EXPECTED_REQUIRED_COUNT }, (_, i) => ({
      id: `req.${i}`, file: `test/req-${i}.test.ts`,
    }));
    const deferred: ManifestEntry[] = Array.from({ length: EXPECTED_DEFERRED_COUNT }, (_, i) => ({
      id: `def.${i}`, file: `test/def-${i}.test.ts`, pendingFeature: "x",
    }));
    return { required, deferred };
  }

  it("(BLOCK 5) loadManifest THROWS on a DUPLICATE required id (length stays pinned but an id repeats)", () => {
    const m = validManifest();
    // Delete a distinct id and replace it with a DUPLICATE of another passing entry — length stays 25.
    m.required[EXPECTED_REQUIRED_COUNT - 1] = { id: m.required[0]!.id, file: m.required[0]!.file };
    expect(() => loadManifest(tmpManifest(m))).toThrow(/duplicate manifest id/);
  });

  it("(BLOCK 5) loadManifest THROWS on an id shared between required and deferred", () => {
    const m = validManifest();
    m.deferred[0] = { id: m.required[0]!.id, file: "test/def-0.test.ts", pendingFeature: "x" };
    expect(() => loadManifest(tmpManifest(m))).toThrow(/duplicate manifest id/);
  });

  it("(BLOCK 6) loadManifest THROWS when the deferred count drifts (deleting the sole deferred entry)", () => {
    const m = validManifest();
    m.deferred = [];
    expect(() => loadManifest(tmpManifest(m))).toThrow(new RegExp(`"deferred" length 0 != pinned ${EXPECTED_DEFERRED_COUNT}`));
  });

  it("(BLOCK 6) loadManifest THROWS when a deferred entry is missing its bound file", () => {
    const m = validManifest();
    m.deferred[0] = { id: "def.nofile", pendingFeature: "x" } as ManifestEntry;
    expect(() => loadManifest(tmpManifest(m))).toThrow(/deferred entry "def.nofile" is missing its bound "file"/);
  });

  it("(BLOCK 6) reconcile FAILS (deferred-wrong-file) when a deferred skipped token is in a DIFFERENT file", () => {
    const manifest: RequiredTestsManifest = {
      required: [{ id: "req.bound", file: "test/integration/crash/pg-kill-save.crash.test.ts" }],
      deferred: [{ id: "def.bound", file: "test/integration/crash/pg-kill-save.crash.test.ts", pendingFeature: "x" }],
    };
    const report: JsonReport = {
      testResults: [
        { name: "/abs/test/integration/crash/pg-kill-save.crash.test.ts", assertionResults: [
          { status: "passed", title: "[[req.bound]] ok", fullName: "s [[req.bound]] ok" },
        ] },
        // the deferred scenario's skipped token was MOVED to an unrelated dummy file
        { name: "/abs/test/integration/crash/trivial-dummy.test.ts", assertionResults: [
          { status: "skipped", title: "[[def.bound]] moved away", fullName: "s [[def.bound]] moved away" },
        ] },
      ],
    };
    const r = reconcile(report, manifest);
    expect(r.ok).toBe(false);
    expect(r.violations).toContainEqual({ id: "def.bound", reason: "deferred-wrong-file", statuses: ["/abs/test/integration/crash/trivial-dummy.test.ts"] });
  });

  it("(BLOCK 6) reconcile PASSES when the deferred skipped token is in ITS BOUND file", () => {
    const manifest: RequiredTestsManifest = {
      required: [{ id: "req.bound", file: "test/integration/crash/pg-kill-save.crash.test.ts" }],
      deferred: [{ id: "def.bound", file: "test/integration/crash/pg-kill-save.crash.test.ts", pendingFeature: "x" }],
    };
    const report: JsonReport = {
      testResults: [
        { name: "/abs/test/integration/crash/pg-kill-save.crash.test.ts", assertionResults: [
          { status: "passed", title: "[[req.bound]] ok", fullName: "s [[req.bound]] ok" },
          { status: "skipped", title: "[[def.bound]] pending", fullName: "s [[def.bound]] pending" },
        ] },
      ],
    };
    const r = reconcile(report, manifest);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("the REAL manifest satisfies id-uniqueness + the deferred pin (loads clean)", () => {
    const MANIFEST_PATH = fileURLToPath(new URL("./required-tests.manifest.json", import.meta.url));
    const manifest = loadManifest(MANIFEST_PATH);
    expect(manifest.deferred.length).toBe(EXPECTED_DEFERRED_COUNT);
    const ids = [...manifest.required, ...manifest.deferred].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length); // all ids distinct
  });
});
