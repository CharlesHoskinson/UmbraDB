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
  });

  /**
   * The version was previously pinned to the literal "0.1.0" (the pre-tag hold). That correctly
   * caught the 1.0.0 bump, but re-pinning it to "1.0.0" would just move the same tripwire one
   * release along and fail again at 1.0.1. What actually matters at publish time is that the
   * version is real semver AND agrees with what the release artifacts claim -- a package whose
   * version disagrees with its own CHANGELOG is the defect worth catching.
   */
  it("declares a semver version that matches the newest CHANGELOG entry", () => {
    const version = pkg.version as string;
    expect(version, "version must be plain semver (no pre-release/build metadata for a release)")
      .toMatch(/^\d+\.\d+\.\d+$/);

    const changelog = readFileSync(
      fileURLToPath(new URL("../../CHANGELOG.md", import.meta.url)),
      "utf8",
    );
    // Newest released heading, skipping [Unreleased].
    const headings = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
    expect(headings.length, "CHANGELOG must carry at least one released version heading")
      .toBeGreaterThan(0);
    expect(version, "package.json version must match the newest CHANGELOG release heading")
      .toBe(headings[0]);
  });

  /**
   * package-lock.json carries the version in two places; `npm version` updates both, but a
   * hand-edited package.json updates neither. A lockfile disagreeing with the manifest is what
   * `npm ci` installs, so the mismatch is real, not cosmetic.
   */
  it("package-lock.json agrees with package.json on the version", () => {
    const lock = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package-lock.json", import.meta.url)), "utf8"),
    ) as { version?: string; packages?: Record<string, { version?: string }> };
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages?.[""]?.version).toBe(pkg.version);
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
