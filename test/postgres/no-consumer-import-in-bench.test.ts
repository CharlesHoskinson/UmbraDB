import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * G14 indexer-agnostic boundary guard (`openspec/changes/v1.0.0-perf-baseline/acceptance.md` B2/C2;
 * `design.md` §4/§7; roadmap G11). The benchmark harness under `bench/` drives UmbraDB's OWN
 * adapters only — it must never import a consumer/indexer app or the wallet SDK to generate load.
 *
 * This is the static import-graph check B2 requires. It extracts the actual module SPECIFIERS from
 * every `bench/` file (`from "X"`, `import "X"`, dynamic `import("X")`, `require("X")`) and asserts
 * none is the wallet SDK or a known consumer/indexer package. Specifier extraction (not a whole-file
 * substring scan) is deliberate: the harness's own JSDoc legitimately NAMES those forbidden
 * packages when explaining the boundary, and a prose mention must not trip the guard — only a real
 * import must.
 */
function importSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const m of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) specifiers.add(m[1]!);
  for (const m of source.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.add(m[1]!);
  for (const m of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) specifiers.add(m[1]!);
  return [...specifiers];
}

describe("bench/ imports no consumer/indexer package (indexer-agnostic boundary, G11)", () => {
  it("no bench/ module imports the wallet SDK or a consumer/indexer package", () => {
    const benchDir = fileURLToPath(new URL("../../bench", import.meta.url));
    const relPaths = readdirSync(benchDir, { recursive: true }) as string[];
    const tsFiles = relPaths.filter((p) => p.endsWith(".ts"));
    expect(tsFiles.length).toBeGreaterThan(0); // sanity: the walk found the harness sources

    // A forbidden specifier is the wallet SDK, or any consumer/indexer/sync app package.
    const forbidden = [/^@midnightntwrk\//, /indexer/i, /chain-archive-sync/];
    for (const rel of tsFiles) {
      const source = readFileSync(path.join(benchDir, rel), "utf8");
      for (const spec of importSpecifiers(source)) {
        for (const pattern of forbidden) {
          expect(spec, `${rel}: bench/ must not import ${spec}`).not.toMatch(pattern);
        }
      }
    }
  });
});
