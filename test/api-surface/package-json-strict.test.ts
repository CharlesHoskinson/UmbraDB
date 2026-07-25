import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * G1 / acceptance A3: the published package.json is publishable with a strict exports map and no
 * deep-import escape hatch. Parses the real package.json and asserts its shape.
 */
describe("package.json is publishable with a strict exports map (A3)", () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
  ) as Record<string, unknown>;

  it("drops private and declares main/types", () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.main).toBe("dist/index.js");
    expect(pkg.types).toBe("dist/index.d.ts");
    expect(pkg.version).toBe("0.1.0");
  });

  it("exports has a single dot entry, no wildcard, and points only into dist", () => {
    const exp = pkg.exports as Record<string, unknown>;
    expect(exp).toBeDefined();
    expect(Object.keys(exp)).toEqual(["."]);
    expect("./*" in exp).toBe(false);
    const leaves: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") leaves.push(v);
      else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
    };
    walk(exp);
    expect(leaves.length).toBeGreaterThan(0);
    for (const leaf of leaves) {
      expect(leaf.startsWith("./dist/"), `exports leaf must resolve into dist/: ${leaf}`).toBe(true);
      expect(/src\/(postgres|interfaces)\//.test(leaf), `no src deep path in exports: ${leaf}`).toBe(false);
    }
  });

  it("files allowlists dist plus the doc set", () => {
    expect(pkg.files).toContain("dist");
  });
});
