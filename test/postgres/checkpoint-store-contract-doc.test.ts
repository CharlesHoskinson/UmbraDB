import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * G5 (A10) — the checkpoint-store contract documentation states the ordering + replay contract.
 * Requirement `durable-composition` — scenario "The ordering and replay contract is a checkable
 * documentation artifact": it SHALL state the cursor-strictly-after-data ordering rule and the
 * current-state replay contract explicitly, cross-referenced from `Formal/STORAGE_ALGEBRA.md` W1.
 * Method is `doc` (reviewer-verified); this test makes the artifact's required content executable.
 */

const DOC_PATH = fileURLToPath(new URL("../../docs/checkpoint-store-contract.md", import.meta.url));
const ALGEBRA_PATH = fileURLToPath(new URL("../../Formal/STORAGE_ALGEBRA.md", import.meta.url));

/** Slice out the prose of Law W1 in STORAGE_ALGEBRA.md — from its `**Law W1.` header to the next
 *  section boundary (`---` rule or `## ` heading, whichever comes first). */
function lawW1Section(algebra: string): string {
  const start = algebra.indexOf("**Law W1.");
  expect(start).toBeGreaterThanOrEqual(0); // the law must exist to be cross-referenced at all
  const rest = algebra.slice(start);
  const endRel = rest.search(/\n---\n|\n## /);
  return endRel === -1 ? rest : rest.slice(0, endRel);
}

describe("checkpoint-store contract doc — ordering + replay (G5, A10)", () => {
  it("the contract doc exists", () => {
    expect(existsSync(DOC_PATH)).toBe(true);
  });

  it("states cursor-strictly-after-data ordering, current-state replay, and cross-refs STORAGE_ALGEBRA W1", () => {
    const doc = readFileSync(DOC_PATH, "utf8");
    // Cursor-strictly-after-data ordering rule (the safe, recoverable direction).
    expect(doc).toMatch(/strictly after/i);
    expect(doc).toMatch(/watermark[- ]behind/i);
    // Current-state replay contract (convergence judged on current state, not history chains).
    expect(doc).toMatch(/current[- ]state/i);
    expect(doc).toMatch(/replay/i);
    // Cross-reference to the formal watermark law.
    expect(doc).toMatch(/STORAGE_ALGEBRA\.md/);
    expect(doc).toMatch(/\bW1\b/);
  });

  // A10 requires the contract be "cross-referenced FROM STORAGE_ALGEBRA.md W1" (acceptance.md:29) —
  // the INBOUND direction. The assertion above only proves the reverse (the contract mentions W1),
  // so it passes vacuously with respect to A10's actual requirement. This test reads the FORMAL
  // document and asserts Law W1's own prose points back to the contract doc.
  //
  // TEETH: scoped to the Law W1 section only. If the inbound "see docs/checkpoint-store-contract.md"
  // reference is removed from Law W1 in STORAGE_ALGEBRA.md, this fails — a mention of the contract
  // anywhere else in the (large) formal document cannot satisfy it.
  it("Law W1 in STORAGE_ALGEBRA.md cross-references the contract doc (inbound A10 direction)", () => {
    const w1 = lawW1Section(readFileSync(ALGEBRA_PATH, "utf8"));
    expect(w1).toMatch(/checkpoint-store-contract\.md/);
  });
});
