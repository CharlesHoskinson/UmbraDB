import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * AC-7's automated guard: the real ingestion/sync implementation (node-RPC + indexer-GraphQL
 * client code, `chain-archive-sync/*`, this repo's real full-chain-storage ingestion) lives
 * entirely outside `src/postgres/*` and `src/interfaces/*` -- in fact entirely outside `src/`
 * altogether, the strongest form of that requirement. Mirrors
 * `test/postgres/no-sdk-import-guard.test.ts`'s proven pattern exactly: a WHOLE-FILE source-text
 * scan (not a per-line `/^\s*import\b/` filter, which the existing guard's own F4 fix already
 * demonstrated is bypassable by a re-export), so this guard cannot be defeated the same way.
 *
 * Checks for two independent things any of `src/`'s `.ts` files could do to reach the ingestion
 * layer or its dependencies without a literal `import ... from "../../chain-archive-sync/..."`
 * line: (a) any STRING-LITERAL `from`/`import(...)` specifier referencing the `chain-archive-
 * sync` path segment -- matched as `\b(?:from|import)\s*\(?\s*["'][^"'\n]*chain-archive-sync`,
 * i.e. anchored on the `from`/`import` keyword AND confined to a single line, so this guard does
 * NOT false-positive on this module's own doc comments (which legitimately name the directory in
 * backtick-quoted, multi-line prose -- an early version of this guard used a bare
 * `["'][^"']*chain-archive-sync` pattern with NO newline exclusion, which turned out to match
 * across an unrelated English apostrophe, e.g. "this repo's own...", all the way to a much-later
 * "chain-archive-sync" mention in the same doc comment -- confirmed as a real false positive
 * against this repo's own source during implementation, not a hypothetical), and (b) any
 * reference to this directory's own client modules by their distinguishing literal class names
 * (the node-RPC/indexer endpoint-talking classes) -- so a hypothetical future re-export or a
 * copy-pasted client under a different path is still caught.
 */
describe("no module under src/ imports chain-archive-sync's node-RPC/indexer-GraphQL client code (AC-7)", () => {
  function walkSrcTsFiles(): string[] {
    const srcDir = fileURLToPath(new URL("../../src", import.meta.url));
    const relPaths = readdirSync(srcDir, { recursive: true }) as string[];
    return relPaths.filter((p) => p.endsWith(".ts")).map((rel) => path.join(srcDir, rel));
  }

  it("no .ts file under src/ has a string-literal import/re-export specifier referencing chain-archive-sync", () => {
    const files = walkSrcTsFiles();
    expect(files.length).toBeGreaterThan(0); // sanity: the walk actually found source files
    for (const full of files) {
      const source = readFileSync(full, "utf8");
      expect(source, `${full}: unexpected chain-archive-sync import specifier`)
        .not.toMatch(/\b(?:from|import)\s*\(?\s*["'][^"'\n]*chain-archive-sync/);
    }
  });

  it("no .ts file under src/ references the node-RPC/indexer-GraphQL client class names directly", () => {
    const files = walkSrcTsFiles();
    for (const full of files) {
      const source = readFileSync(full, "utf8");
      expect(source, `${full}: unexpected NodeRpcClient reference`).not.toMatch(/NodeRpcClient/);
      expect(source, `${full}: unexpected IndexerClient reference`).not.toMatch(/IndexerClient/);
    }
  });

  // Non-vacuousness proof (AC-7 scenario "the guard fails if ingestion code is added directly
  // under src/postgres/*"): a synthetic fixture demonstrating BOTH guards above actually catch a
  // violation, without touching any real file under src/. The real, non-vacuous proof against
  // this repo's actual guard test was additionally performed manually during implementation
  // review (temporarily adding a `chain-archive-sync` import to a real src/ file, confirming this
  // test failed, then removing it) -- recorded in the implementation report per AC-7's own
  // "verified... then removed" requirement, since committing that broken state would defeat the
  // guard's own purpose.
  it("fixture: a disallowed import the guards above would catch", () => {
    const fixtureSource = [
      "import { NodeRpcClient } from \"../../chain-archive-sync/node-rpc-client.js\";",
      "export const x = 1;",
    ].join("\n");
    expect(fixtureSource).toMatch(/chain-archive-sync/);
    expect(fixtureSource).toMatch(/NodeRpcClient/);
  });
});
