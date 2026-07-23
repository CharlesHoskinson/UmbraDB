import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * G5 (A8) — `save-and-advance.ts` composes only in-repo primitives and imports no
 * consumer/indexer application. Requirement `durable-composition` — "saveAndAdvance co-commits ...
 * composing only in-repo primitives ... and importing no consumer or indexer application"; also
 * the guideline's indexer-agnostic boundary (§0.3) and DoD-5 static import-lint. This is a
 * file-focused check on top of the repo-wide `no-sdk-import-guard` walk.
 */

/** Every `from "…"` and dynamic `import("…")` specifier in the source text. */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const fromRe = /\bfrom\s+["']([^"']+)["']/g;
  const dynRe = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(source)) !== null) specs.push(m[1]!);
  while ((m = dynRe.exec(source)) !== null) specs.push(m[1]!);
  return specs;
}

describe("save-and-advance.ts imports no consumer/indexer module (G5, A8)", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../src/postgres/save-and-advance.ts", import.meta.url)),
    "utf8",
  );

  it("references the wallet SDK nowhere in its source (whole-file, matching the repo no-sdk guard)", () => {
    // The one substring that must not appear anywhere (mirrors `no-sdk-import-guard`). The
    // consumer/indexer prohibition itself is enforced structurally by the import-specifier check
    // below, not by prose-word scanning — the words "indexer"/"consumer" appear legitimately in
    // this module's own explanatory doc comments, so a whole-file word scan would be a false
    // positive rather than a real boundary check.
    expect(source).not.toMatch(/@midnightntwrk/);
  });

  it("every import resolves to an in-repo primitive under src/ (relative into ../interfaces or ../postgres, or an allowed runtime dep)", () => {
    const specs = importSpecifiers(source);
    expect(specs.length).toBeGreaterThan(0); // sanity: the extraction actually found imports

    const ALLOWED_BARE = new Set(["postgres", "zod"]);
    for (const spec of specs) {
      if (spec.startsWith("node:")) continue; // a Node built-in is not a consumer import
      if (ALLOWED_BARE.has(spec)) continue; // the two declared runtime deps
      // Otherwise it MUST be a relative path that stays inside this package's own src/ tree — any
      // consumer/indexer application import would necessarily be a bare specifier or an out-of-src
      // relative path, and would fail here.
      expect(spec, `unexpected import specifier: ${spec}`).toMatch(/^\.\.?\//);
      expect(spec, `import must stay within src/ (no parent-of-src traversal): ${spec}`)
        .toMatch(/^\.\.\/(interfaces|postgres)\//);
    }
  });
});
