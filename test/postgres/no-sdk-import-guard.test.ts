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
 */
describe("no wallet-SDK runtime import anywhere under src/ (design.md §2/§3.3)", () => {
  it("no .ts file under src/ imports a @midnightntwrk/* package", () => {
    const srcDir = fileURLToPath(new URL("../../src", import.meta.url));
    const relPaths = readdirSync(srcDir, { recursive: true }) as string[];
    const tsFiles = relPaths.filter((p) => p.endsWith(".ts"));
    expect(tsFiles.length).toBeGreaterThan(0); // sanity: the walk actually found source files

    for (const rel of tsFiles) {
      const full = path.join(srcDir, rel);
      const source = readFileSync(full, "utf8");
      const importLines = source.split("\n").filter((line) => /^\s*import\b/.test(line));
      for (const line of importLines) {
        expect(line, `${rel}: unexpected wallet-SDK import: ${line}`).not.toMatch(/@midnightntwrk/);
      }
    }
  });
});
