import Mathlib.Data.Finmap
import Mathlib.Data.Set.Function
import UmbraDBFormal.Checkpoint.Projection

/-!
# Checkpoint byte-bearing chunk maps

The finite map merge is the existing-left-biased `Finmap.union`. It is associative and
idempotent for every map, but it commutes only when overlapping hashes bind equal bytes.
-/

namespace UmbraDBFormal.Checkpoint

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

def BoundValues [DecidableEq Hash] (store : ChunkMap Hash Bytes) : Set Bytes :=
  {bytes | ∃ hash, store.lookup hash = some bytes}

def WellHashed [DecidableEq Hash] (digest : Bytes → Hash)
    (store : ChunkMap Hash Bytes) : Prop :=
  ∀ hash bytes, store.lookup hash = some bytes → hash = digest bytes

def CollisionFreeOn (digest : Bytes → Hash) (values : Set Bytes) : Prop :=
  Set.InjOn digest values

theorem compatible_refl [DecidableEq Hash] (store : ChunkMap Hash Bytes) :
    Compatible store store := by
  intro hash leftBytes rightBytes hleft hright
  rw [hleft] at hright
  exact Option.some_inj.mp hright

theorem compatible_symm [DecidableEq Hash] {left right : ChunkMap Hash Bytes} :
    Compatible left right → Compatible right left := by
  intro hcompatible hash rightBytes leftBytes hright hleft
  exact (hcompatible hash leftBytes rightBytes hleft hright).symm

theorem lookup_mergeChunkMaps [DecidableEq Hash]
    (left right : ChunkMap Hash Bytes) (hash : Hash) :
    (mergeChunkMaps left right).lookup hash =
      match left.lookup hash with
      | some bytes => some bytes
      | none => right.lookup hash := by
  unfold mergeChunkMaps
  by_cases hmem : hash ∈ left
  · rw [Finmap.lookup_union_left hmem]
    cases hlookup : left.lookup hash with
    | none =>
        have : hash ∉ left := Finmap.lookup_eq_none.mp hlookup
        exact False.elim (this hmem)
    | some bytes => rfl
  · rw [Finmap.lookup_union_right hmem, Finmap.lookup_eq_none.mpr hmem]

theorem keys_mergeChunkMaps [DecidableEq Hash] (left right : ChunkMap Hash Bytes) :
    (mergeChunkMaps left right).keys = mergeChunkIds left.keys right.keys := by
  exact Finmap.keys_union

theorem mergeChunkMaps_empty_left [DecidableEq Hash] (store : ChunkMap Hash Bytes) :
    mergeChunkMaps ∅ store = store := by
  exact Finmap.empty_union

theorem mergeChunkMaps_empty_right [DecidableEq Hash] (store : ChunkMap Hash Bytes) :
    mergeChunkMaps store ∅ = store := by
  exact Finmap.union_empty

theorem mergeChunkMaps_assoc [DecidableEq Hash]
    (left middle right : ChunkMap Hash Bytes) :
    mergeChunkMaps (mergeChunkMaps left middle) right =
      mergeChunkMaps left (mergeChunkMaps middle right) := by
  exact Finmap.union_assoc

theorem mergeChunkMaps_idempotent [DecidableEq Hash] (store : ChunkMap Hash Bytes) :
    mergeChunkMaps store store = store := by
  apply Finmap.ext_lookup
  intro hash
  unfold mergeChunkMaps
  by_cases hmem : hash ∈ store
  · exact Finmap.lookup_union_left hmem
  · rw [Finmap.lookup_union_right hmem, Finmap.lookup_eq_none.mpr hmem]

theorem lookup_mergeChunkMaps_left [DecidableEq Hash]
    {left right : ChunkMap Hash Bytes} {hash : Hash} (hmem : hash ∈ left) :
    (mergeChunkMaps left right).lookup hash = left.lookup hash := by
  exact Finmap.lookup_union_left hmem

theorem lookup_mergeChunkMaps_right [DecidableEq Hash]
    {left right : ChunkMap Hash Bytes} {hash : Hash} (hnotmem : hash ∉ left) :
    (mergeChunkMaps left right).lookup hash = right.lookup hash := by
  exact Finmap.lookup_union_right hnotmem

theorem mergeChunkMaps_comm_of_compatible [DecidableEq Hash]
    {left right : ChunkMap Hash Bytes} (hcompat : Compatible left right) :
    mergeChunkMaps left right = mergeChunkMaps right left := by
  apply Finmap.ext_lookup
  intro hash
  unfold mergeChunkMaps
  by_cases hleft : hash ∈ left
  · obtain ⟨leftBytes, hleftLookup⟩ := Finmap.mem_iff.mp hleft
    by_cases hright : hash ∈ right
    · obtain ⟨rightBytes, hrightLookup⟩ := Finmap.mem_iff.mp hright
      rw [Finmap.lookup_union_left hleft, Finmap.lookup_union_left hright]
      rw [hleftLookup, hrightLookup, hcompat hash leftBytes rightBytes hleftLookup hrightLookup]
    · rw [Finmap.lookup_union_left hleft, Finmap.lookup_union_right hright]
  · by_cases hright : hash ∈ right
    · rw [Finmap.lookup_union_right hleft, Finmap.lookup_union_left hright]
    · rw [Finmap.lookup_union_right hleft, Finmap.lookup_union_right hright]
      rw [Finmap.lookup_eq_none.mpr hleft, Finmap.lookup_eq_none.mpr hright]

theorem compatible_merge_left [DecidableEq Hash]
    {left middle right : ChunkMap Hash Bytes}
    (hleft : Compatible left right) (hmiddle : Compatible middle right) :
    Compatible (mergeChunkMaps left middle) right := by
  intro hash mergedBytes rightBytes hmerged hright
  rw [lookup_mergeChunkMaps] at hmerged
  cases hlookup : left.lookup hash with
  | none =>
      rw [hlookup] at hmerged
      exact hmiddle hash mergedBytes rightBytes hmerged hright
  | some leftBytes =>
      rw [hlookup] at hmerged
      have hvalue : leftBytes = mergedBytes := Option.some_inj.mp hmerged
      subst mergedBytes
      exact hleft hash leftBytes rightBytes hlookup hright

theorem compatible_merge_right [DecidableEq Hash]
    {left middle right : ChunkMap Hash Bytes}
    (hmiddle : Compatible left middle) (hright : Compatible left right) :
    Compatible left (mergeChunkMaps middle right) := by
  apply compatible_symm
  exact compatible_merge_left (compatible_symm hmiddle) (compatible_symm hright)

theorem compatible_of_collisionFreeOn [DecidableEq Hash] (digest : Bytes → Hash)
    {left right : ChunkMap Hash Bytes}
    (hleft : WellHashed digest left) (hright : WellHashed digest right)
    (hcollision : CollisionFreeOn digest (BoundValues left ∪ BoundValues right)) :
    Compatible left right := by
  intro hash leftBytes rightBytes hleftLookup hrightLookup
  apply hcollision
  · exact Set.mem_union_left _ ⟨hash, hleftLookup⟩
  · exact Set.mem_union_right _ ⟨hash, hrightLookup⟩
  · exact (hleft hash leftBytes hleftLookup).symm.trans
      (hright hash rightBytes hrightLookup)

end UmbraDBFormal.Checkpoint
