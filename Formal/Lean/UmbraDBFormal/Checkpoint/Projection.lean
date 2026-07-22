import Mathlib.Data.Finset.Lattice.Lemmas

/-!
# Checkpoint chunk-identity projection

The save-side C1 projection retains only the finite set of chunk hashes addressed by a save.
Ordered inputs remain lists until `chunkIdsOfHashes` explicitly erases order and multiplicity.
-/

namespace UmbraDBFormal.Checkpoint

abbrev ChunkIds (Hash : Type*) := Finset Hash

def chunkIdsOfHashes [DecidableEq Hash] (hashes : List Hash) : ChunkIds Hash :=
  hashes.toFinset

def mergeChunkIds [DecidableEq Hash]
    (left right : ChunkIds Hash) : ChunkIds Hash :=
  left ∪ right

def saveChunkIds [DecidableEq Hash]
    (stored : ChunkIds Hash) (hashes : List Hash) : ChunkIds Hash :=
  mergeChunkIds stored (chunkIdsOfHashes hashes)

theorem mem_mergeChunkIds [DecidableEq Hash]
    {hash : Hash} {left right : ChunkIds Hash} :
    hash ∈ mergeChunkIds left right ↔ hash ∈ left ∨ hash ∈ right := by
  simp [mergeChunkIds]

theorem mergeChunkIds_empty_left [DecidableEq Hash] (ids : ChunkIds Hash) :
    mergeChunkIds ∅ ids = ids := by
  simp [mergeChunkIds]

theorem mergeChunkIds_empty_right [DecidableEq Hash] (ids : ChunkIds Hash) :
    mergeChunkIds ids ∅ = ids := by
  simp [mergeChunkIds]

theorem mergeChunkIds_assoc [DecidableEq Hash] (left middle right : ChunkIds Hash) :
    mergeChunkIds (mergeChunkIds left middle) right =
      mergeChunkIds left (mergeChunkIds middle right) := by
  exact Finset.union_assoc left middle right

theorem mergeChunkIds_comm [DecidableEq Hash] (left right : ChunkIds Hash) :
    mergeChunkIds left right = mergeChunkIds right left := by
  exact Finset.union_comm left right

theorem mergeChunkIds_idempotent [DecidableEq Hash] (ids : ChunkIds Hash) :
    mergeChunkIds ids ids = ids := by
  exact Finset.union_idempotent ids

theorem subset_mergeChunkIds_left [DecidableEq Hash] (left right : ChunkIds Hash) :
    left ⊆ mergeChunkIds left right := by
  exact Finset.subset_union_left

theorem subset_mergeChunkIds_right [DecidableEq Hash] (left right : ChunkIds Hash) :
    right ⊆ mergeChunkIds left right := by
  exact Finset.subset_union_right

theorem mergeChunkIds_least [DecidableEq Hash] {left right upper : ChunkIds Hash}
    (hleft : left ⊆ upper) (hright : right ⊆ upper) :
    mergeChunkIds left right ⊆ upper := by
  exact Finset.union_subset hleft hright

theorem chunkIdsOfHashes_append [DecidableEq Hash] (left right : List Hash) :
    chunkIdsOfHashes (left ++ right) =
      mergeChunkIds (chunkIdsOfHashes left) (chunkIdsOfHashes right) := by
  exact List.toFinset_append

theorem saveChunkIds_extensive [DecidableEq Hash]
    (stored : ChunkIds Hash) (hashes : List Hash) :
    stored ⊆ saveChunkIds stored hashes := by
  exact subset_mergeChunkIds_left stored (chunkIdsOfHashes hashes)

theorem saveChunkIds_empty [DecidableEq Hash] (stored : ChunkIds Hash) :
    saveChunkIds stored [] = stored := by
  simp [saveChunkIds, chunkIdsOfHashes, mergeChunkIds]

theorem saveChunkIds_repeat [DecidableEq Hash]
    (stored : ChunkIds Hash) (hashes : List Hash) :
    saveChunkIds (saveChunkIds stored hashes) hashes = saveChunkIds stored hashes := by
  simp [saveChunkIds, mergeChunkIds, Finset.union_assoc]

theorem saveChunkIds_order_independent [DecidableEq Hash]
    (stored : ChunkIds Hash) (first second : List Hash) :
    saveChunkIds (saveChunkIds stored first) second =
      saveChunkIds (saveChunkIds stored second) first := by
  simp only [saveChunkIds, mergeChunkIds]
  rw [Finset.union_assoc, Finset.union_assoc]
  rw [Finset.union_comm (chunkIdsOfHashes first) (chunkIdsOfHashes second)]

end UmbraDBFormal.Checkpoint
