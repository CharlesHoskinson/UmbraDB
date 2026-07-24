// Pure, unit-testable mutation-EVIDENCE tally + gate for the per-adapter runner (round-3 BLOCK 5).
//
// A durability adapter contributes mutation EVIDENCE only if it produced a valid report with a POSITIVE
// number of VALID mutants (Killed + Timeout + Survived + NoCoverage). CompileError / RuntimeError /
// Ignored are EXCLUDED from the denominator (they are not evidence). "No mutants" is NEVER scored as
// 100% (the exact fail-OPEN hole this closes): a zero-evidence adapter is a HARD failure.

/** Tally a StrykerJS JSON report's mutant statuses. */
export function tallyMutants(report) {
  let killed = 0, timeout = 0, survived = 0, noCoverage = 0, excluded = 0;
  for (const f of Object.values((report && report.files) || {})) {
    for (const m of (f && f.mutants) || []) {
      switch (m.status) {
        case "Killed": killed++; break;
        case "Timeout": timeout++; break;
        case "Survived": survived++; break;
        case "NoCoverage": noCoverage++; break;
        default: excluded++; // CompileError / RuntimeError / Ignored -- NOT evidence
      }
    }
  }
  return { killed, timeout, survived, noCoverage, excluded, valid: killed + timeout + survived + noCoverage };
}

/**
 * Gate per-adapter results. Each result: { file, strykerExit, reportPresent, tally }.
 * FAILS (ok:false) if ANY adapter (a) exited nonzero, (b) had a missing/empty report, or (c) yielded
 * ZERO valid mutants (all compile/runtime errors => no evidence). Requires POSITIVE evidence per
 * adapter, then gates the AGGREGATE killed/valid score (over VALID mutants only) against
 * `breakThreshold`. Never treats "no mutants" as 100%.
 */
export function gateAdapters(results, breakThreshold) {
  const failures = [];
  let killed = 0, timeout = 0, survived = 0, noCoverage = 0;
  for (const r of results) {
    if ((r.strykerExit == null ? 1 : r.strykerExit) !== 0) {
      failures.push(`${r.file}: Stryker exited ${r.strykerExit} (genuine error; per-adapter break is neutralized so a low score is NOT the cause)`);
    }
    if (!r.reportPresent) {
      failures.push(`${r.file}: missing/empty mutation report -- no evidence`);
      continue;
    }
    const t = r.tally;
    if (!t || t.valid === 0) {
      failures.push(`${r.file}: ZERO valid mutants (excluded=${t ? t.excluded : 0}) -- no mutation evidence; NOT scored as 100%`);
      continue;
    }
    killed += t.killed; timeout += t.timeout; survived += t.survived; noCoverage += t.noCoverage;
  }
  const valid = killed + timeout + survived + noCoverage;
  if (failures.length > 0) return { ok: false, failures, aggregate: null, valid, killed, timeout, survived, noCoverage };
  if (valid === 0) return { ok: false, failures: ["no valid mutants across ALL adapters -- no evidence"], aggregate: null, valid, killed, timeout, survived, noCoverage };
  const aggregate = ((killed + timeout) / valid) * 100;
  const ok = aggregate >= breakThreshold;
  return { ok, failures: ok ? [] : [`aggregate ${aggregate.toFixed(2)}% < break ${breakThreshold}%`], aggregate, valid, killed, timeout, survived, noCoverage };
}
