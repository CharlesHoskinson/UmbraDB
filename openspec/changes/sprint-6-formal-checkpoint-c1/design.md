# Design — Sprint 6: Lean M3b CheckpointStore C1

This design formalizes the save-only projection in `Formal/STORAGE_ALGEBRA.md` §2 and the
CheckpointStore carrier guidance in `Formal/STORAGE_TYPES.md` “CheckpointStore”. The runtime
context comes from `design/design.md` §3 and `design/design-interfaces.md` §3.3, corrected by the
authoritative implemented behavior in `openspec/changes/sprint-3-checkpoint-store/design.md`
§§2.1, 4, and 8. The proof split follows
`Formal/STORAGE_ALGEBRA_LEAN_RESEARCH.md` §§3.7, 3.9, 5.4, and 12 M3.

## 1. Finite identity projection

```lean
abbrev ChunkIds (Hash : Type*) := Finset Hash

def chunkIdsOfHashes [DecidableEq Hash] (hashes : List Hash) : ChunkIds Hash :=
  hashes.toFinset

def mergeChunkIds [DecidableEq Hash]
    (left right : ChunkIds Hash) : ChunkIds Hash :=
  left ∪ right

def saveChunkIds [DecidableEq Hash]
    (stored : ChunkIds Hash) (hashes : List Hash) : ChunkIds Hash :=
  mergeChunkIds stored (chunkIdsOfHashes hashes)
```

The ordered input list is not called a persisted manifest and no reconstruction theorem is
claimed. Its order and multiplicity are deliberately erased only by `chunkIdsOfHashes`. The join
laws prove the C1 identity projection even if one abstract hash corresponds to distinct bytes.

## 2. Finite byte-bearing maps

```lean
abbrev ChunkMap (Hash Bytes : Type*) := Finmap (fun _ : Hash ↦ Bytes)

def Compatible [DecidableEq Hash]
    (left right : ChunkMap Hash Bytes) : Prop :=
  ∀ hash leftBytes rightBytes,
    left.lookup hash = some leftBytes →
    right.lookup hash = some rightBytes →
    leftBytes = rightBytes

def mergeChunkMaps [DecidableEq Hash]
    (left right : ChunkMap Hash Bytes) : ChunkMap Hash Bytes :=
  left ∪ right
```

Pinned mathlib v4.32.0 defines `Finmap.union` as existing-left-biased and supplies its key and
lookup laws in `Formal/Lean/.lake/packages/mathlib/Mathlib/Data/Finmap.lean:492-518`. That matches
the observable byte projection of the implemented upsert at
`src/postgres/checkpoint-store.ts:152-161`: on hash conflict the stored bytes remain and only
`created_at` changes. Associativity/idempotence are unconditional; commutativity requires
`Compatible`. No semilattice instance is installed for arbitrary chunk maps.

Binary compatibility-closure lemmas are exported as prerequisites for a future finite-family
theorem without smuggling in transitivity. This sprint defines no list merge and claims no general
finite-family permutation theorem. A concrete same-hash/different-bytes example proves that
unrestricted map commutativity is false and that merge order exposes which value arrived first.

## 3. Collision premise bridge

`BoundValues store` is the set of bytes appearing in a finite map. `WellHashed digest store` says
each binding's hash equals `digest bytes`. `CollisionFreeOn digest values` is `Set.InjOn digest
values`. A theorem derives `Compatible left right` when both maps are well-hashed and the digest is
injective only over `BoundValues left ∪ BoundValues right`.

This is a theorem premise, not an axiom and not a claim about SHA-256. Computational collision
resistance and the adapter's lack of a collision-rejection path remain external obligations.

## 4. Laws and trust boundary

The exact public declaration names and signatures are frozen in the detailed sprint plan. The
identity gate names `mem_mergeChunkIds`, both `mergeChunkIds_empty_*` laws,
`mergeChunkIds_assoc`, `mergeChunkIds_comm`, `mergeChunkIds_idempotent`, both
`subset_mergeChunkIds_*` inclusions, `mergeChunkIds_least`, `chunkIdsOfHashes_append`, and the
four `saveChunkIds_*` transition laws. The map gate names `compatible_refl`, `compatible_symm`,
`lookup_mergeChunkMaps`, `keys_mergeChunkMaps`, both `mergeChunkMaps_empty_*` laws,
`mergeChunkMaps_assoc`, `mergeChunkMaps_idempotent`, both lookup-preservation laws,
`mergeChunkMaps_comm_of_compatible`, both `compatible_merge_*` closure laws, and
`compatible_of_collisionFreeOn`. `keys_mergeChunkMaps` is unconditional.

Production modules enter `UmbraDBFormal.lean`; tests enter `UmbraDBFormalTest.Trust`. The default
Lake build elaborates every declaration before the trust audit. No `sorry`, `admit`, custom axiom,
`unsafe`, global classical instance, or API-smoke dependency is permitted.

## 5. Refinement boundary

The identity projection corresponds only to the set of rows addressed by chunk hash after save-
side writes. The map projection erases `created_at`, row identity, manifests, sequence counters,
transactions, and all pruning state. Repeated public `save` calls are not idempotent: they create
new sequence/manifest rows even when the chunk projection is unchanged. The ordered/repeated
position fix in Sprint 3 resolves the historical schema defect, but ordered manifest
reconstruction remains a separate future Lean theorem rather than part of C1.
