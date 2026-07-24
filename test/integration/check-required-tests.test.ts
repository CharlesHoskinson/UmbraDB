import { describe, expect, it } from "vitest";
import {
  extractIds,
  reconcile,
  statusesFromReport,
  type JsonReport,
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
      ]),
      MANIFEST,
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([{ id: "req.two", reason: "skipped", statuses: ["skipped"] }]);
    expect(result.summary).toContain("req.two"); // the id is named in the failure summary
  });

  it("(2b) a required test entirely MISSING from the report is a named violation", () => {
    const result = reconcile(
      report([{ status: "passed", title: "[[req.one]] a" }]),
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

  it("(3b) a deferred id entirely absent (feature not yet authored) does NOT fail the check", () => {
    const result = reconcile(
      report([
        { status: "passed", title: "[[req.one]] a" },
        { status: "passed", title: "[[req.two]] b" },
      ]),
      MANIFEST,
    );
    expect(result.ok).toBe(true);
    expect(result.deferredReconciled).toContainEqual({ id: "def.optional", statuses: [], state: "missing" });
  });

  it("a required id carried by MORE THAN ONE test (id collision) is a named 'ambiguous' violation", () => {
    // Two distinct tests both embed [[req.two]] — the id no longer identifies exactly one test, so
    // reconcile cannot trust its status. Even though both are 'passed', this is a violation.
    const result = reconcile(
      report([
        { status: "passed", title: "[[req.one]] a" },
        { status: "passed", title: "[[req.two]] b (first test with this id)" },
        { status: "passed", title: "[[req.two]] c (a SECOND, colliding test)" },
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
      ]),
      MANIFEST,
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([{ id: "req.two", reason: "failed", statuses: ["failed"] }]);
  });
});
