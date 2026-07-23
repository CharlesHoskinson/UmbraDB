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
});
