import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * AC-7's automated guard: the real ingestion/sync implementation (node-RPC + indexer-GraphQL
 * client code, `chain-archive-sync/*`, this repo's real full-chain-storage ingestion) lives
 * entirely outside `src/postgres/*` and `src/interfaces/*` -- in fact entirely outside `src/`
 * altogether, the strongest form of that requirement. Mirrors
 * `test/postgres/no-sdk-import-guard.test.ts`'s proven pattern: a WHOLE-FILE source-text scan
 * (not a per-line `/^\s*import\b/` filter, which the existing guard's own F4 fix already
 * demonstrated is bypassable by a re-export).
 *
 * **Sol-audit fix round (Findings 5 + 6) restructure**: the scanning logic is now a real,
 * exported-in-this-file function (`findChainSyncViolations`) that BOTH the production guard
 * tests and the fixture tests invoke -- previously the fixture test only matched a synthetic
 * string against ad-hoc regexes, so it would keep passing even if the actual guard logic broke.
 * The fixture tests now write real temporary `.ts` files containing genuine violating imports
 * and run the SAME walk + scan pipeline the production guard uses over them.
 *
 * **Coverage (Finding 6 strengthening)** -- three independent rules, all of which must stay
 * clean for every `.ts` file under `src/`:
 *   (a) string-literal `from`/`import(...)` specifiers referencing the `chain-archive-sync`
 *       path segment (the original rule -- catches static imports, re-exports, and literal
 *       dynamic `import("...")`);
 *   (b) ANY string literal (single-, double-, or backtick-quoted) containing
 *       `chain-archive-sync` -- catches `require("...")`, `createRequire(...)("...")`, and
 *       computed `import()` where the path sits in one literal (e.g. a template literal), the
 *       realistic computed-import shape this repo itself uses for its sibling-checkout loaders.
 *       Extracted by a real string-aware scanner (comments are NOT string literals, so doc
 *       comments legitimately naming the directory -- which exist under `src/` today -- do not
 *       false-positive, closing the apostrophe-spanning false positive the earlier bare-regex
 *       attempt hit);
 *   (c) the ingestion layer's distinguishing exported class names (`NodeRpcClient`,
 *       `IndexerClient`, `ChainArchiveSyncService`) anywhere in the file -- catches re-exports
 *       and copies under a different path.
 *
 * **Documented residual gaps (Finding 6, explicitly not closed -- statically undetectable
 * without a resolver/type-checker)**: a specifier assembled from SPLIT literals
 * (`"chain-archive-" + "sync"`), an import routed through an external barrel file that itself
 * lives outside `src/` (the barrel would violate nothing under `src/`; catching it needs
 * whole-program import-graph analysis), and fully runtime-constructed specifiers (env vars,
 * user input). Rule (c) still catches any of these the moment the imported class is referenced
 * by name. Note the legitimate computed import that DOES exist in this repo --
 * `chain-archive-sync/tx-replay-decoder.ts`'s sibling-checkout ledger loader -- lives outside
 * `src/` and imports the wallet checkout, not `chain-archive-sync`, so it is rightly out of
 * this guard's scope in both dimensions.
 */

interface GuardViolation {
  rule: "import-specifier" | "string-literal" | "class-name";
  detail: string;
}

/** Extracts every string literal (', ", `) from TypeScript source, skipping // and block
 *  comments. Escape sequences are kept opaque (a `\"` inside a literal does not terminate it).
 *  Deliberately does not attempt regex-literal parsing -- a `/` starts a comment here only when
 *  followed by `/` or `*`, which no regex literal under `src/` currently triggers; the
 *  class-name rule runs on the FULL source anyway, so even a misparse here cannot hide a
 *  violating class reference. */
export function extractStringLiterals(source: string): string[] {
  const literals: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let literal = "";
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === "\\") {
          literal += source[i]! + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        literal += source[i]!;
        i++;
      }
      i++; // closing quote
      literals.push(literal);
      continue;
    }
    i++;
  }
  return literals;
}

/** The real scanner -- invoked identically by the production guard (over `src/`) and the
 *  fixture tests (over a temporary directory of known-violating files). */
export function findChainSyncViolations(source: string): GuardViolation[] {
  const violations: GuardViolation[] = [];
  const importSpecifier = source.match(/\b(?:from|import)\s*\(?\s*["'`][^"'`\n]*chain-archive-sync[^"'`\n]*["'`]/);
  if (importSpecifier !== null) {
    violations.push({ rule: "import-specifier", detail: importSpecifier[0] });
  }
  for (const literal of extractStringLiterals(source)) {
    if (literal.includes("chain-archive-sync")) {
      violations.push({ rule: "string-literal", detail: literal });
    }
  }
  const className = source.match(/\b(?:NodeRpcClient|IndexerClient|ChainArchiveSyncService)\b/);
  if (className !== null) {
    violations.push({ rule: "class-name", detail: className[0] });
  }
  return violations;
}

function walkTsFiles(dir: string): string[] {
  const relPaths = readdirSync(dir, { recursive: true }) as string[];
  return relPaths.filter((p) => p.endsWith(".ts")).map((rel) => path.join(dir, rel));
}

function scanDirectory(dir: string): Map<string, GuardViolation[]> {
  const result = new Map<string, GuardViolation[]>();
  for (const file of walkTsFiles(dir)) {
    const violations = findChainSyncViolations(readFileSync(file, "utf8"));
    if (violations.length > 0) result.set(file, violations);
  }
  return result;
}

describe("no module under src/ imports chain-archive-sync's node-RPC/indexer-GraphQL client code (AC-7)", () => {
  const srcDir = fileURLToPath(new URL("../../src", import.meta.url));

  it("src/ walk finds source files and every one is violation-free under all three rules", () => {
    const files = walkTsFiles(srcDir);
    expect(files.length).toBeGreaterThan(0); // sanity: the walk actually found source files
    const violations = scanDirectory(srcDir);
    expect(
      [...violations.entries()].map(([f, v]) => `${f}: ${v.map((x) => `${x.rule}(${x.detail})`).join(", ")}`),
    ).toEqual([]);
  });

  /**
   * Non-vacuousness proof (AC-7's own scenario: "the guard fails if ingestion code is added
   * directly under src/postgres/*"), Sol-audit fix round: REAL temporary fixture files, scanned
   * by the exact same `walkTsFiles` + `findChainSyncViolations` pipeline the production check
   * above uses -- if the scanner logic broke, these tests would fail. Each fixture is one
   * realistic bypass shape from Finding 6.
   */
  describe("fixture: the real scanner catches each violation shape against real files", () => {
    const fixtureDir = mkdtempSync(path.join(tmpdir(), "umbradb-guard-fixture-"));
    afterAll(() => {
      rmSync(fixtureDir, { recursive: true, force: true });
    });

    const FIXTURES: { name: string; source: string; expectedRules: GuardViolation["rule"][] }[] = [
      {
        name: "static-import.ts",
        source: 'import { NodeRpcClient } from "../../chain-archive-sync/node-rpc-client.js";\nexport const x = 1;\n',
        expectedRules: ["import-specifier", "string-literal", "class-name"],
      },
      {
        name: "re-export.ts",
        source: 'export { IndexerClient } from "../../chain-archive-sync/indexer-client.js";\n',
        expectedRules: ["import-specifier", "string-literal", "class-name"],
      },
      {
        name: "computed-dynamic-import.ts",
        source: "const dir = `../../chain-archive-sync`;\nexport const mod = await import(`${dir}/sync-service.js`);\n",
        expectedRules: ["string-literal"],
      },
      {
        name: "require-call.ts",
        source: 'const svc = require("../../chain-archive-sync/sync-service.js");\nexport default svc;\n',
        expectedRules: ["string-literal"],
      },
      {
        name: "create-require.ts",
        source: 'import { createRequire } from "node:module";\nconst req = createRequire(import.meta.url);\nexport const m = req("../../chain-archive-sync/index.js");\n',
        expectedRules: ["string-literal"],
      },
      {
        name: "class-name-only.ts",
        source: "// path hidden behind an external barrel, but the class is referenced by name\ndeclare const s: ChainArchiveSyncService;\nexport const svc = s;\n",
        expectedRules: ["class-name"],
      },
    ];

    for (const fixture of FIXTURES) {
      it(`flags ${fixture.name} via ${fixture.expectedRules.join("+")}`, () => {
        writeFileSync(path.join(fixtureDir, fixture.name), fixture.source);
        const flagged = scanDirectory(fixtureDir);
        const violations = flagged.get(path.join(fixtureDir, fixture.name));
        expect(violations, `${fixture.name} was not flagged at all`).toBeDefined();
        for (const rule of fixture.expectedRules) {
          expect(violations!.map((v) => v.rule), `${fixture.name} missing rule ${rule}`).toContain(rule);
        }
      });
    }

    it("does NOT flag a clean file (the guard is not vacuously flagging everything), including one whose COMMENTS mention chain-archive-sync", () => {
      writeFileSync(
        path.join(fixtureDir, "clean.ts"),
        "// the real ingestion lives in chain-archive-sync/ (see AC-7) -- this repo's own src/\n" +
        "/* doc comments legitimately name `chain-archive-sync` in prose, like src/interfaces/\n" +
        "   chain-archive-store.ts does today */\n" +
        'export const fine = "no violations here";\n',
      );
      const flagged = scanDirectory(fixtureDir);
      expect(flagged.has(path.join(fixtureDir, "clean.ts"))).toBe(false);
    });
  });
});
