import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Repo-wide structural conformance guard (task 3.1's acceptance: "rg finds no @midnightntwrk/*
 * runtime import anywhere under src/"), broader than any single module's own guard test (e.g.
 * `transaction-history-storage.test.ts`'s file-specific check) -- this walks the ENTIRE `src/`
 * tree recursively, so it also protects every module Sprint 8 adds
 * (`wallet-state-envelope.ts`) and any future one, without needing a new per-file test each time.
 * UmbraDB's own module code (`src/postgres/*`, `src/interfaces/*`) must never import or reference
 * the Midnight wallet SDK at runtime -- the adapter (`test/integration/pg-tx-history-adapter.ts`)
 * is the one place SDK types appear, and it lives outside `src/` entirely
 * (`openspec/changes/sprint-8-wallet-envelope-live-sync/design.md` §2/§3.3).
 *
 * **F4 fix (audit finding).** The OLD guard filtered the source down to lines matching
 * `/^\s*import\b/` before checking each one for `@midnightntwrk` -- a per-LINE, keyword-anchored
 * filter that only ever looked at lines literally starting with the word `import`. A **re-export**
 * (`export { x } from "@midnightntwrk/y"` or `export * from "@midnightntwrk/y"`) references the
 * SDK at runtime exactly as much as an `import` does, but its line starts with `export`, not
 * `import` -- so the old filter would find NOTHING to check on a file containing only re-exports,
 * silently passing a file that actually references the wallet SDK at the module boundary. Fixed
 * by dropping the per-line filter entirely and checking the WHOLE FILE'S source text for the
 * `@midnightntwrk` substring -- this catches `import`, `export ... from`, dynamic `import(...)`,
 * and any other specifier form alike, with no keyword-anchored blind spot.
 */
describe("no wallet-SDK runtime import anywhere under src/ (design.md §2/§3.3)", () => {
  it("no .ts file under src/ references @midnightntwrk/* anywhere in its source (whole-file check, not just import-prefixed lines)", () => {
    const srcDir = fileURLToPath(new URL("../../src", import.meta.url));
    const relPaths = readdirSync(srcDir, { recursive: true }) as string[];
    const tsFiles = relPaths.filter((p) => p.endsWith(".ts"));
    expect(tsFiles.length).toBeGreaterThan(0); // sanity: the walk actually found source files

    for (const rel of tsFiles) {
      const full = path.join(srcDir, rel);
      const source = readFileSync(full, "utf8");
      expect(source, `${rel}: unexpected wallet-SDK reference`).not.toMatch(/@midnightntwrk/);
    }
  });

  // F4: this fixture proves the gap the whole-file check above closes -- a re-export shape the
  // OLD per-line `/^\s*import\b/` filter would have let slip through entirely undetected. It
  // never touches any real file under src/; it only demonstrates the two guards' behavior on a
  // synthetic source string.
  it("fixture: a re-export the OLD per-line import filter would have missed is caught by the NEW whole-file check", () => {
    const fixtureSource = [
      "export { something } from \"@midnightntwrk/wallet-sdk-abstractions\";",
      "export const x = 1;",
    ].join("\n");

    // The OLD (pre-F4) guard: filter to lines starting with the literal word "import", then check
    // only those. A re-export line never matches this filter at all.
    const oldGuardImportLines = fixtureSource.split("\n").filter((line) => /^\s*import\b/.test(line));
    expect(oldGuardImportLines).toHaveLength(0); // the old guard finds NOTHING to check here
    for (const line of oldGuardImportLines) {
      expect(line).not.toMatch(/@midnightntwrk/); // (vacuously true -- there are no lines to check)
    }

    // The NEW whole-file guard (mirrors the real test above) actually catches it.
    expect(fixtureSource).toMatch(/@midnightntwrk/);
  });
});
