# Storage Algebra Lean M3b CheckpointStore C1 Sprint

**Goal:** Mechanize the save-only CheckpointStore chunk projection and prove C1 for finite chunk
identity sets and compatible finite hash-to-bytes maps.

**Architecture:** The unconditional layer projects ordered hash inputs to `Finset Hash` and joins
them by union. The data layer uses `Finmap (fun _ : Hash ↦ Bytes)` with mathlib's existing-left-
biased union, matching the runtime upsert that preserves stored bytes and refreshes only metadata.
Map commutativity is proved only when overlapping hashes bind equal bytes. A required theorem
derives compatibility from a named digest injectivity premise over the maps' actually bound
values; SHA-256 injectivity is never asserted.

**Toolchain:** Lean 4.32.0, mathlib v4.32.0, Lake 5, the installed `lean4` skill, existing source
and elaborated trust audits, and `leanchecker`.

## Audited semantic decisions

- Follow the roadmap: completed Watermarks W1 is followed by CheckpointStore C1; C2a is next.
- Prove C1 only for the save-side chunk projection, not the full store or public `save` operation.
- Keep ordered hash inputs as lists and make the conversion to a finite identity set explicit.
- Use finite chunk maps with existing-left-biased merge: a repeated hash preserves stored bytes.
- Require explicit compatibility for map commutativity and prove binary compatibility-closure
  lemmas as prerequisites for a future finite-family reorder theorem.
- Treat same-hash/different-bytes order dependence as an executable counterexample, not an
  impossible state hidden by a cryptographic assumption.
- Keep metadata refresh, manifests, sequences, pruning, and runtime refinement outside the model.
- Use no graph-scoped manifest for Lean review: the current Graphify extractor/import backstop does
  not cover Lean modules, so final Codex personas independently inspect the full diff/import roots.

## Source layout

- `Formal/Lean/UmbraDBFormal/Checkpoint/Projection.lean`
- `Formal/Lean/UmbraDBFormal/Checkpoint/ChunkMap.lean`
- `Formal/Lean/UmbraDBFormal/Checkpoint.lean`
- matching projection and chunk-map contract tests under `UmbraDBFormalTest/Checkpoint/`
- production, test, and elaborated trust umbrella imports

## Identity-projection theorem gate

The public projection contract is frozen at these declarations (with all variables explicit or
implicit exactly as Lean accepts them and no stronger typeclass assumptions):

```lean
theorem mem_mergeChunkIds [DecidableEq Hash] {hash : Hash} {left right : ChunkIds Hash} :
    hash ∈ mergeChunkIds left right ↔ hash ∈ left ∨ hash ∈ right
theorem mergeChunkIds_empty_left [DecidableEq Hash] (ids : ChunkIds Hash) :
    mergeChunkIds ∅ ids = ids
theorem mergeChunkIds_empty_right [DecidableEq Hash] (ids : ChunkIds Hash) :
    mergeChunkIds ids ∅ = ids
theorem mergeChunkIds_assoc [DecidableEq Hash] (left middle right : ChunkIds Hash) :
    mergeChunkIds (mergeChunkIds left middle) right =
      mergeChunkIds left (mergeChunkIds middle right)
theorem mergeChunkIds_comm [DecidableEq Hash] (left right : ChunkIds Hash) :
    mergeChunkIds left right = mergeChunkIds right left
theorem mergeChunkIds_idempotent [DecidableEq Hash] (ids : ChunkIds Hash) :
    mergeChunkIds ids ids = ids
theorem subset_mergeChunkIds_left [DecidableEq Hash] (left right : ChunkIds Hash) :
    left ⊆ mergeChunkIds left right
theorem subset_mergeChunkIds_right [DecidableEq Hash] (left right : ChunkIds Hash) :
    right ⊆ mergeChunkIds left right
theorem mergeChunkIds_least [DecidableEq Hash] {left right upper : ChunkIds Hash}
    (hleft : left ⊆ upper) (hright : right ⊆ upper) :
    mergeChunkIds left right ⊆ upper
theorem chunkIdsOfHashes_append [DecidableEq Hash] (left right : List Hash) :
    chunkIdsOfHashes (left ++ right) =
      mergeChunkIds (chunkIdsOfHashes left) (chunkIdsOfHashes right)
theorem saveChunkIds_extensive [DecidableEq Hash]
    (stored : ChunkIds Hash) (hashes : List Hash) :
    stored ⊆ saveChunkIds stored hashes
theorem saveChunkIds_empty [DecidableEq Hash] (stored : ChunkIds Hash) :
    saveChunkIds stored [] = stored
theorem saveChunkIds_repeat [DecidableEq Hash]
    (stored : ChunkIds Hash) (hashes : List Hash) :
    saveChunkIds (saveChunkIds stored hashes) hashes = saveChunkIds stored hashes
theorem saveChunkIds_order_independent [DecidableEq Hash]
    (stored : ChunkIds Hash) (first second : List Hash) :
    saveChunkIds (saveChunkIds stored first) second =
      saveChunkIds (saveChunkIds stored second) first
```

Contracts additionally demonstrate that duplicates, order, and multiplicity remain visible in
the input list but are deliberately erased by the C1 identity projection.

## Compatible-map theorem gate

The public map contract is frozen at these declarations. In particular, lookup orientation and
key projection are unconditional; only commutativity needs `Compatible`.

```lean
theorem compatible_refl [DecidableEq Hash] (store : ChunkMap Hash Bytes) :
    Compatible store store
theorem compatible_symm [DecidableEq Hash] {left right : ChunkMap Hash Bytes} :
    Compatible left right → Compatible right left
theorem lookup_mergeChunkMaps [DecidableEq Hash]
    (left right : ChunkMap Hash Bytes) (hash : Hash) :
    (mergeChunkMaps left right).lookup hash =
      match left.lookup hash with
      | some bytes => some bytes
      | none => right.lookup hash
theorem keys_mergeChunkMaps [DecidableEq Hash] (left right : ChunkMap Hash Bytes) :
    (mergeChunkMaps left right).keys = mergeChunkIds left.keys right.keys
theorem mergeChunkMaps_empty_left [DecidableEq Hash] (store : ChunkMap Hash Bytes) :
    mergeChunkMaps ∅ store = store
theorem mergeChunkMaps_empty_right [DecidableEq Hash] (store : ChunkMap Hash Bytes) :
    mergeChunkMaps store ∅ = store
theorem mergeChunkMaps_assoc [DecidableEq Hash]
    (left middle right : ChunkMap Hash Bytes) :
    mergeChunkMaps (mergeChunkMaps left middle) right =
      mergeChunkMaps left (mergeChunkMaps middle right)
theorem mergeChunkMaps_idempotent [DecidableEq Hash] (store : ChunkMap Hash Bytes) :
    mergeChunkMaps store store = store
theorem lookup_mergeChunkMaps_left [DecidableEq Hash]
    {left right : ChunkMap Hash Bytes} {hash : Hash} (hmem : hash ∈ left) :
    (mergeChunkMaps left right).lookup hash = left.lookup hash
theorem lookup_mergeChunkMaps_right [DecidableEq Hash]
    {left right : ChunkMap Hash Bytes} {hash : Hash} (hnotmem : hash ∉ left) :
    (mergeChunkMaps left right).lookup hash = right.lookup hash
theorem mergeChunkMaps_comm_of_compatible [DecidableEq Hash]
    {left right : ChunkMap Hash Bytes} (hcompat : Compatible left right) :
    mergeChunkMaps left right = mergeChunkMaps right left
theorem compatible_merge_left [DecidableEq Hash]
    {left middle right : ChunkMap Hash Bytes}
    (hleft : Compatible left right) (hmiddle : Compatible middle right) :
    Compatible (mergeChunkMaps left middle) right
theorem compatible_merge_right [DecidableEq Hash]
    {left middle right : ChunkMap Hash Bytes}
    (hmiddle : Compatible left middle) (hright : Compatible left right) :
    Compatible left (mergeChunkMaps middle right)
theorem compatible_of_collisionFreeOn [DecidableEq Hash] (digest : Bytes → Hash)
    {left right : ChunkMap Hash Bytes}
    (hleft : WellHashed digest left) (hright : WellHashed digest right)
    (hcollision : CollisionFreeOn digest (BoundValues left ∪ BoundValues right)) :
    Compatible left right
```

The two closure lemmas are prerequisites for a future finite-family theorem; this sprint does not
define a list merge or claim permutation invariance for arbitrary finite families.

## Adversarial examples

- empty hash input;
- overlapping identity sets `{1, 2}` and `{2, 3}`;
- `[h1, h2, h1]` remains a three-position list but projects to `{h1, h2}`;
- `[h1, h2]` and `[h2, h1]` are unequal lists with equal identity projections;
- disjoint maps with distinct bytes;
- overlapping maps with the same hash and same bytes;
- the same abstract hash with different bytes is incompatible and order-dependent under merge;
- compatibility is not transitive in general;
- a concrete injective digest discharges the collision-free compatibility bridge;
- empty inputs add no identities, without claiming that a runtime public save creates no manifest.

## Explicit non-goals

- public-save idempotence, manifests, ordered reconstruction, manifest hashing, or chunking bytes;
- sequence allocation, labels, `complete`, row identity, timestamps, or `created_at` refresh;
- prune, C2a/C2b, reachability, grace windows, GC, or liveness;
- PostgreSQL upsert/locking/atomicity, SHA-256 security, collision rejection, or adapter refinement;
- runtime changes, new TypeScript property tests, oracle generation, or toolchain changes;
- a global semilattice instance for arbitrary chunk maps.

## Verification matrix

```text
git fetch origin refs/heads/main:refs/remotes/origin/main
test "$(git rev-parse origin/main)" = \
  "$(git ls-remote --heads origin refs/heads/main | cut -f1)"
git merge-base --is-ancestor origin/main HEAD

graphify update .
graphify check-update .
graphify diagnose multigraph --graph graphify-out/graph.json --json

cd Formal/Lean
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/check-trust.ps1
lake env lean UmbraDBFormal/Checkpoint/Projection.lean
lake env lean UmbraDBFormal/Checkpoint/ChunkMap.lean
lake env lean UmbraDBFormalTest/Checkpoint/Projection.lean
lake env lean UmbraDBFormalTest/Checkpoint/ChunkMap.lean
lake build --wfail
lake env leanchecker

cd ../..
openspec validate sprint-6-formal-checkpoint-c1 --strict
openspec validate --all --strict
npm ci                         # in a fresh detached worktree
npm run typecheck
npm run docs:storage:check
npm test
actionlint .github/workflows/lean.yml
git diff --exit-code origin/main -- Formal/Lean/lean-toolchain Formal/Lean/lakefile.lean \
  Formal/Lean/lake-manifest.json package.json package-lock.json
git diff --check
git status --short
test "$(git rev-parse HEAD)" = "$(git ls-remote --heads origin \
  refs/heads/formal/storage-algebra-lean-m3b-checkpoint-c1 | cut -f1)"
gh run list --commit "$(git rev-parse HEAD)" --workflow lean.yml
```

The planning tranche must be committed, pushed, and opened as a draft PR before proof edits. Proof
sources must be committed before integrating current `main`; final status and generated artifacts
are then produced from that integrated tree. The theorem/status head must receive three independent
persona PASS verdicts before publication. A final administrative completion commit records the
external audit/push/CI facts, receives exact-head CI plus a status-only three-persona audit, and is
followed only by external PR evidence updates.
