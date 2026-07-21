# Repository agent policy

For every Lean 4 edit, use the `lean4` skill (`$lean4`) and keep its no-`sorry`,
incremental-compilation, axiom-boundary, and final-project-gate workflow.

Every nontrivial code, specification, proof, CI, or status-document tranche
must pass a multi-persona Codex audit after its final changes and after the
branch is integrated with current `main`:

1. a domain-correctness persona reviews semantics and implementation behavior;
2. an adversarial persona searches for counterexamples, unsound assumptions,
   security failures, and vacuous claims;
3. a release persona checks tests, trust gates, reproducibility, documentation,
   generated artifacts, and GitHub readiness.

Auditors must be independent and read-only. Each reports exact file references,
severity, and a `PASS` or `BLOCK` verdict. All blocking findings must be fixed
and sent through targeted re-audit. Record the final persona verdicts and
validation evidence in the pull request before merge. Regenerate Graphify after
the audited tranche changes specifications, code, or project guidance.
