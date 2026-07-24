import { describe, expect, it } from "vitest";
import { gateAdapters, tallyMutants } from "../../scripts/mutation-evidence.mjs";

/**
 * Unit coverage for the per-adapter mutation runner's EVIDENCE gate (change-level round-3 BLOCK 5).
 * Proves absence-of-evidence is NOT scored as a pass: a missing/empty report, a nonzero Stryker exit,
 * or an adapter whose mutants are ALL CompileError/RuntimeError (zero VALID mutants) each FAIL the gate
 * and are never coerced to 100%. Pure (no Docker), so the teeth run in the required gate itself.
 */
function mutants(statuses: string[]) {
  return { files: { "src/postgres/x.ts": { mutants: statuses.map((s) => ({ status: s })) } } };
}

describe("mutation-per-adapter evidence gate (round-3 BLOCK 5) — absence of evidence is NOT a pass", () => {
  it("tallyMutants counts VALID mutants and EXCLUDES compile/runtime/ignored", () => {
    const t = tallyMutants(mutants(["Killed", "Killed", "Survived", "NoCoverage", "Timeout", "CompileError", "RuntimeError", "Ignored"]));
    expect(t.valid).toBe(5); // 2 killed + 1 timeout + 1 survived + 1 noCoverage
    expect(t.excluded).toBe(3);
    expect(t.killed).toBe(2);
  });

  it("(c) an adapter with ONLY compile/runtime-error mutants => ZERO valid mutants => FAILS (never 100%)", () => {
    const t = tallyMutants(mutants(["CompileError", "RuntimeError", "CompileError"]));
    expect(t.valid).toBe(0);
    const g = gateAdapters([{ file: "a.ts", strykerExit: 0, reportPresent: true, tally: t }], 65);
    expect(g.ok).toBe(false);
    expect(g.aggregate).toBeNull(); // NOT scored as 100%
    expect(g.failures.join(" ")).toMatch(/ZERO valid mutants/);
  });

  it("(b) an adapter with a MISSING/empty report => FAILS (no evidence)", () => {
    const g = gateAdapters([{ file: "a.ts", strykerExit: 0, reportPresent: false, tally: null }], 65);
    expect(g.ok).toBe(false);
    expect(g.failures.join(" ")).toMatch(/missing\/empty/);
  });

  it("(a) an adapter with a NONZERO Stryker exit => FAILS (genuine error; break is neutralized so a low score is not the cause)", () => {
    const g = gateAdapters([{ file: "a.ts", strykerExit: 1, reportPresent: true, tally: tallyMutants(mutants(["Killed"])) }], 65);
    expect(g.ok).toBe(false);
    expect(g.failures.join(" ")).toMatch(/Stryker exited 1/);
  });

  it("real POSITIVE evidence with aggregate >= break => PASSES", () => {
    const strong = tallyMutants(mutants(["Killed", "Killed", "Killed", "Timeout", "Survived"])); // 4/5 = 80%
    const g = gateAdapters([{ file: "a.ts", strykerExit: 0, reportPresent: true, tally: strong }], 65);
    expect(g.ok).toBe(true);
    expect(g.aggregate).not.toBeNull();
    expect(g.aggregate as number).toBeGreaterThanOrEqual(65);
  });

  it("positive evidence but aggregate < break => FAILS", () => {
    const weak = tallyMutants(mutants(["Killed", "Survived", "Survived", "Survived"])); // 1/4 = 25%
    const g = gateAdapters([{ file: "a.ts", strykerExit: 0, reportPresent: true, tally: weak }], 65);
    expect(g.ok).toBe(false);
    expect(g.failures.join(" ")).toMatch(/< break/);
  });

  it("a zero-evidence adapter FAILS even beside a strong sibling (no evidence laundering / averaging away)", () => {
    const g = gateAdapters([
      { file: "good.ts", strykerExit: 0, reportPresent: true, tally: tallyMutants(mutants(["Killed", "Killed", "Killed"])) },
      { file: "empty.ts", strykerExit: 0, reportPresent: true, tally: tallyMutants(mutants(["CompileError"])) },
    ], 65);
    expect(g.ok).toBe(false);
    expect(g.failures.join(" ")).toMatch(/empty\.ts/);
  });
});
