# Tasks — Sprint 6: Lean M3b CheckpointStore C1

This file is the sprint's only checkbox/status authority. Every phase closes only after its
specified persona review passes or all findings are fixed and re-reviewed.

## 0. Specification freeze

- [x] 0.1 Draft proposal, design, requirements, and detailed theorem plan.
  - **Acceptance:** from the repository root, `test -f` succeeds for
    `openspec/changes/sprint-6-formal-checkpoint-c1/proposal.md`,
    `openspec/changes/sprint-6-formal-checkpoint-c1/design.md`,
    `openspec/changes/sprint-6-formal-checkpoint-c1/tasks.md`,
    `openspec/changes/sprint-6-formal-checkpoint-c1/specs/formal-checkpoint-c1/spec.md`, and
    `docs/superpowers/plans/2026-07-21-storage-algebra-lean-m3b-checkpoint-c1.md`.
- [x] 0.2 Validate this change and the full OpenSpec corpus with strict validation.
  - **Acceptance:** `openspec validate sprint-6-formal-checkpoint-c1 --strict` and
    `openspec validate --all --strict` both exit 0.
- [x] 0.3 Regenerate/check Graphify for the frozen specification and diagnose the multigraph.
  - **Acceptance:** `graphify update .`, `graphify check-update .`, and
    `graphify diagnose multigraph --graph graphify-out/graph.json --json` exit 0; machine-local
    outputs satisfy `! git status --short | rg '\.graphify_labels\.json'`.
- [x] 0.4 Run independent formal-soundness, semantic/refinement, and release/process planning
  reviews after Graphify; resolve every blocker before Lean proof edits.
  - **Acceptance:** three read-only persona reports inspect the complete planning files without a
    Lean-blind PUSH manifest and return `PASS`; `git diff --check` exits 0.
- [x] 0.5 Commit/push the audited planning tranche and open a draft Sprint 6 PR.
  - **Acceptance:** `git status --short` is clean, local `HEAD` equals the SHA returned by
    `git ls-remote --heads origin refs/heads/formal/storage-algebra-lean-m3b-checkpoint-c1`, and
    `test "$(gh pr view --json isDraft --jq .isDraft)" = true` exits 0.

## 1. Chunk-identity projection

- [x] 1.1 Add `ChunkIds`, `chunkIdsOfHashes`, `mergeChunkIds`, and `saveChunkIds`.
  - **Acceptance:** `lake env lean UmbraDBFormal/Checkpoint/Projection.lean` exits 0 and
    `! rg -n 'APISmoke' UmbraDBFormal/Checkpoint` exits 0.
- [x] 1.2 Prove membership, identities, associativity, commutativity, idempotence, upper/least
  bounds, append projection, and save transition laws.
  - **Acceptance:** the exact projection declarations frozen in the detailed plan elaborate with
    only `[DecidableEq Hash]`, and
    `lake env lean UmbraDBFormal/Checkpoint/Projection.lean` exits 0.
- [x] 1.3 Add projection contracts for empty, overlap, list order, and duplicate erasure.
  - **Acceptance:** `lake env lean UmbraDBFormalTest/Checkpoint/Projection.lean` exits 0.

## 2. Compatible chunk maps

- [x] 2.1 Add finite `ChunkMap`, existing-left-biased `mergeChunkMaps`, key projection,
  `Compatible`, `BoundValues`, `WellHashed`, and `CollisionFreeOn`.
  - **Acceptance:** `lake env lean UmbraDBFormal/Checkpoint/ChunkMap.lean` and
    `! rg -n 'instance.*SemilatticeSup|SemilatticeSup.*ChunkMap' UmbraDBFormal/Checkpoint` exit 0.
- [x] 2.2 Prove lookup/key characterization, identities, associativity/idempotence, binding
  preservation, compatible commutation, and pairwise compatibility closure.
  - **Acceptance:** the exact map declarations frozen in the detailed plan through
    `compatible_merge_right` elaborate without `[DecidableEq Bytes]` or a SHA axiom, and
    `lake env lean UmbraDBFormal/Checkpoint/ChunkMap.lean` exits 0.
- [x] 2.3 Prove the explicit collision-free-on-bound-values compatibility bridge.
  - **Acceptance:** `compatible_of_collisionFreeOn` takes `CollisionFreeOn`, defined as
    `Set.InjOn`, as a premise; `lake env lean UmbraDBFormal/Checkpoint/ChunkMap.lean` and
    `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/check-trust.ps1` exit 0 from
    `Formal/Lean`.
- [x] 2.4 Add adversarial compatible/conflicting-map contracts and a concrete collision-free digest
  witness; route all modules through production/test/trust umbrellas.
  - **Acceptance:** `lake env lean UmbraDBFormalTest/Checkpoint/ChunkMap.lean` and
    `lake build --wfail` exit 0; conflicting same-hash values exhibit order dependence.
- [x] 2.5 Obtain preliminary pre-integration verdicts from all three proof personas and commit the
  proof tranche; these reports do not satisfy the policy-mandated post-integration audit in 3.5.
  - **Acceptance:** three read-only preliminary reports return `PASS`; `git status --short` is
    clean after a commit containing every Checkpoint source/test file and umbrella import.

## 3. Close-out

- [ ] 3.1 Fetch/verify current remote `main` and integrate it into the clean proof branch.
  - **Acceptance:** `git fetch origin refs/heads/main:refs/remotes/origin/main`;
    `test "$(git rev-parse origin/main)" = "$(git ls-remote --heads origin refs/heads/main | cut -f1)"`;
    `git merge --no-edit origin/main`; `git merge-base --is-ancestor origin/main HEAD`; and
    `test -z "$(git status --short)"` all exit 0.
- [ ] 3.2 Update README, ROADMAP, OpenSpec, and formal research status with an abstract-C1-only
  claim, including the resolved historical position-column defect.
  - **Acceptance:**
    `test "$(rg -l 'M3b CheckpointStore C1: complete \(abstract save-side projection only\)' README.md ROADMAP.md Formal/STORAGE_ALGEBRA_LEAN_RESEARCH.md | wc -l)" -eq 3`;
    `rg -n '^> \*\*Status:\*\* Complete — abstract save-side projection only\.$' openspec/changes/sprint-6-formal-checkpoint-c1/proposal.md`; and
    `rg -n 'C2a|ordered reconstruction|collision handling|runtime refinement' README.md ROADMAP.md Formal/STORAGE_ALGEBRA_LEAN_RESEARCH.md openspec/changes/sprint-6-formal-checkpoint-c1/proposal.md`
    all exit 0.
- [ ] 3.3 Regenerate/check Graphify after all source/spec/status edits and diagnose the graph.
  - **Acceptance:** `graphify update .`, `graphify check-update .`, and
    `graphify diagnose multigraph --graph graphify-out/graph.json --json` exit 0;
    `! git status --short | rg '\.graphify_labels\.json'` exits 0.
- [ ] 3.4 Run the complete integrated release matrix, including Node checks after `npm ci` in a
  fresh detached worktree.
  - **Acceptance:** execute without abbreviation every literal command in the `Verification
    matrix` code block of
    `docs/superpowers/plans/2026-07-21-storage-algebra-lean-m3b-checkpoint-c1.md`; every command
    exits 0, including `npm ci` and all Node commands in a fresh detached worktree.
- [ ] 3.5 Commit the final generated/status tranche and obtain exact-commit PASS verdicts from all
  three independent personas.
  - **Acceptance:** all reports cite one exact `HEAD`, inspect the full diff/import roots, and return
    `PASS`; `test -z "$(git status --short)"` exits 0.
- [ ] 3.6 Push the exact audited theorem/status head, require green exact-head CI, and record
  complete evidence while keeping the PR draft.
  - **Acceptance:** `test "$(git rev-parse HEAD)" = "$(git ls-remote --heads origin refs/heads/formal/storage-algebra-lean-m3b-checkpoint-c1 | cut -f1)"`;
    `test "$(git rev-parse HEAD)" = "$(gh pr view --json headRefOid --jq .headRefOid)"`;
    `test "$(gh pr view --json isDraft --jq .isDraft)" = true`; and exact-head `lean.yml` CI
    succeed; the current PR body/comment records the matrix plus all persona verdicts.
- [ ] 3.7 Record completion in one administrative status/Graphify-manifest commit, then require its
  exact-head CI, three-persona status audit, superseding PR evidence, and only then mark the PR
  ready for review without further repo edits.
  - **Acceptance:** every checkbox/status claim is true; local/remote/PR SHAs match the final
    administrative head; exact-head CI succeeds; all personas return `PASS`; PR evidence is
    superseded; and `test "$(gh pr view --json isDraft --jq .isDraft)" = false` exits 0.
