# Tasks — Sprint 5: Lean M3a Watermarks W1

This file is the sprint's only checkbox/status authority. Every phase closes only after its
specified persona review passes or all findings are fixed and re-reviewed.

## 0. Specification freeze

- [x] 0.1 Draft proposal, design, requirements, and detailed theorem plan.
  - **Acceptance:** from the repository root, `test -f` succeeds for
    `openspec/changes/sprint-5-formal-watermarks/proposal.md`,
    `openspec/changes/sprint-5-formal-watermarks/design.md`,
    `openspec/changes/sprint-5-formal-watermarks/tasks.md`,
    `openspec/changes/sprint-5-formal-watermarks/specs/formal-watermarks/spec.md`, and
    `docs/superpowers/plans/2026-07-21-storage-algebra-lean-m3a-watermarks.md`.
- [x] 0.2 Validate this change and the full OpenSpec corpus with strict validation.
  - **Acceptance:** `openspec validate sprint-5-formal-watermarks --strict` and
    `openspec validate --all --strict` both exit 0.
- [x] 0.3 Regenerate Graphify for the frozen specification, exclude machine-local artifacts, and
  diagnose the generated multigraph.
  - **Acceptance:** `graphify update .` and
    `graphify diagnose multigraph --graph graphify-out/graph.json --json` both exit 0; only
    repository-owned Graphify outputs appear in `git status --short`.
- [x] 0.4 Run independent formal-soundness, semantic/refinement, and release/process planning
  reviews after Graphify regeneration; resolve every blocking finding before Lean proof edits.
  - **Acceptance:** three distinct read-only persona reports name the exact planning files and
    return `PASS`; `git diff --check` exits 0.
- [x] 0.5 Commit and push the audited planning tranche, then open a draft sprint PR.
  - **Acceptance:** `git status --short` is clean, `git rev-parse HEAD` equals
    `git rev-parse origin/formal/storage-algebra-lean-m3a-watermarks`, and the GitHub PR is draft.

## 1. Executable Watermarks model

- [ ] 1.1 Add `Address` with derived decidable equality, functional `Store`, `empty`, `get`, `set`,
  `SetCommand`, `runSets`, and the independent per-address `lastMatching` observer.
  - **Acceptance:** `lake env lean UmbraDBFormal/Watermarks/Model.lean` exits 0, and
    `rg 'APISmoke' UmbraDBFormal/Watermarks` returns no matches.
- [ ] 1.2 Add model contract examples for empty, overwrite, repeated values, distinct kinds/keys,
  ordered interleavings, and outer absence versus a stored null-like abstract value.
  - **Acceptance:** `lake env lean UmbraDBFormalTest/Watermarks/Model.lean` exits 0 and includes
    an elaborated `Value := Option Nat` witness distinguishing `none` from `some none`.
- [ ] 1.3 Compile each new model/test module incrementally with the pinned Lean toolchain.
  - **Acceptance:** `lean --version` reports 4.32.0 and each new model source/test command exits 0.

## 2. W1 theorem tranche

- [ ] 2.1 Prove empty, same-address, and distinct-address lookup laws.
  - **Acceptance:** the named declarations elaborate in `UmbraDBFormal/Watermarks/Laws.lean`, and
    `lake env lean UmbraDBFormal/Watermarks/Laws.lean` exits 0.
- [ ] 2.2 Prove same-address last-write-wins/idempotence and distinct-address commutation.
  - **Acceptance:** adversarial same-address and distinct-complete-address examples elaborate in
    `UmbraDBFormalTest/Watermarks/Laws.lean` with no `sorry`, `admit`, or custom axioms.
- [ ] 2.3 Prove trace append, expose the filtered-`getLast?` characterization of `lastMatching`,
  prove lookup with initial fallback, and prove trace framing.
  - **Acceptance:** `lake env lean UmbraDBFormal/Watermarks/Laws.lean` exits 0 and exports all four
    theorem families against the independent observer.
- [ ] 2.4 Add adversarial law examples and route source/tests through the production, test, and
  elaborated trust-audit roots.
  - **Acceptance:** `lake env lean UmbraDBFormalTest/Watermarks/Laws.lean` and `lake build --wfail`
    exit 0; umbrella imports reach every new production and test module.
- [ ] 2.5 Commit the executable model, laws, tests, and umbrella imports as a proof tranche.
  - **Acceptance:** `git status --short` is clean and the branch contains a commit whose diff
    includes every Watermarks Lean source/test file and required umbrella import.

## 3. Close-out

- [ ] 3.1 Integrate current `main` into the clean, committed proof branch before final artifacts.
  - **Acceptance:** `git merge-base --is-ancestor origin/main HEAD` exits 0 and
    `git status --short` is clean.
- [ ] 3.2 Update README, ROADMAP, OpenSpec, and formal research status without claiming SQL
  refinement or completion of CheckpointStore C1/C2.
  - **Acceptance:** targeted `rg` review finds one consistent W1 status, and the updated
    documentation contains the explicit abstract-only/refinement boundary.
- [ ] 3.3 Regenerate Graphify after all source/spec/status edits and run graph diagnostics.
  - **Acceptance:** `graphify update .` and
    `graphify diagnose multigraph --graph graphify-out/graph.json --json` both exit 0; machine-local
    Graphify labels are absent from the staged diff.
- [ ] 3.4 Run the complete release matrix from the integrated tree, including Node checks after a
  clean install in a fresh worktree.
  - **Acceptance:** Lean trust/build/leanchecker, strict OpenSpec validation, `npm ci`, TypeScript,
    TypeDoc, Vitest, actionlint, and `git diff --check` exit 0; `git diff origin/main --
    Formal/Lean/lean-toolchain Formal/Lean/lakefile.lean Formal/Lean/lake-manifest.json package.json
    package-lock.json` is empty and exits 0 with `--exit-code`.
- [ ] 3.5 Commit the final generated/status tranche, then obtain final PASS verdicts from the three
  independent read-only personas on that exact commit.
  - **Acceptance:** all three reports cite `git rev-parse HEAD`, inspect the committed diff, and
    return `PASS` with no unresolved blocker; `git status --short` is clean.
- [ ] 3.6 Push the exact audited head, require its green GitHub trust run, and record validation and
  audit evidence in the draft PR before requesting review.
  - **Acceptance:** local and remote branch SHAs are equal, the GitHub Actions run for that SHA is
    successful, and the PR body/comment records the validation matrix plus all persona verdicts.
