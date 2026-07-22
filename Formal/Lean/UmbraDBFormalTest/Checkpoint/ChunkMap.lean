import UmbraDBFormal.Checkpoint.ChunkMap

open UmbraDBFormal.Checkpoint

private def disjointLeft : ChunkMap Nat Nat :=
  Finmap.singleton 1 10

private def disjointRight : ChunkMap Nat Nat :=
  Finmap.singleton 2 20

private def conflictLeft : ChunkMap Nat Nat :=
  Finmap.singleton 7 10

private def conflictRight : ChunkMap Nat Nat :=
  Finmap.singleton 7 20

private theorem singletonWellHashed (value : Nat) :
    WellHashed id (Finmap.singleton value value : ChunkMap Nat Nat) := by
  intro hash bytes hlookup
  have hkey : hash = value := by
    rw [← Finmap.mem_singleton (β := fun _ : Nat ↦ Nat) hash value value]
    exact Finmap.mem_of_lookup_eq_some hlookup
  subst hash
  rw [Finmap.lookup_singleton_eq] at hlookup
  simpa using Option.some_inj.mp hlookup

private theorem mergeWellHashed [DecidableEq Hash] (digest : Bytes → Hash)
    {left right : ChunkMap Hash Bytes}
    (hleft : WellHashed digest left) (hright : WellHashed digest right) :
    WellHashed digest (mergeChunkMaps left right) := by
  intro hash bytes hlookup
  rw [lookup_mergeChunkMaps] at hlookup
  cases hleftLookup : left.lookup hash with
  | none =>
      rw [hleftLookup] at hlookup
      exact hright hash bytes hlookup
  | some leftBytes =>
      rw [hleftLookup] at hlookup
      have hvalue : leftBytes = bytes := Option.some_inj.mp hlookup
      subst bytes
      exact hleft hash leftBytes hleftLookup

private def overlapLeft : ChunkMap Nat Nat :=
  mergeChunkMaps (Finmap.singleton 1 1) (Finmap.singleton 2 2)

private def overlapRight : ChunkMap Nat Nat :=
  mergeChunkMaps (Finmap.singleton 2 2) (Finmap.singleton 3 3)

private theorem overlapLeftWellHashed : WellHashed id overlapLeft := by
  exact mergeWellHashed id (singletonWellHashed 1) (singletonWellHashed 2)

private theorem overlapRightWellHashed : WellHashed id overlapRight := by
  exact mergeWellHashed id (singletonWellHashed 2) (singletonWellHashed 3)

private theorem overlapCompatible : Compatible overlapLeft overlapRight := by
  apply compatible_of_collisionFreeOn id overlapLeftWellHashed overlapRightWellHashed
  exact Set.injOn_id _

example : Compatible disjointLeft disjointRight := by
  intro hash leftBytes rightBytes hleft hright
  have hleftKey : hash = 1 := by
    rw [← Finmap.mem_singleton (β := fun _ : Nat ↦ Nat) hash 1 10]
    exact Finmap.mem_of_lookup_eq_some hleft
  have hrightKey : hash = 2 := by
    rw [← Finmap.mem_singleton (β := fun _ : Nat ↦ Nat) hash 2 20]
    exact Finmap.mem_of_lookup_eq_some hright
  have himpossible : (1 : Nat) = 2 := hleftKey.symm.trans hrightKey
  have hne : (1 : Nat) ≠ 2 := by decide
  exact False.elim (hne himpossible)

example : overlapLeft ≠ overlapRight := by
  decide

example :
    mergeChunkMaps overlapLeft overlapRight = mergeChunkMaps overlapRight overlapLeft := by
  apply mergeChunkMaps_comm_of_compatible
  exact overlapCompatible

example : (mergeChunkMaps conflictLeft conflictRight).lookup 7 = some 10 := by
  rw [lookup_mergeChunkMaps]
  simp [conflictLeft]

example : (mergeChunkMaps conflictRight conflictLeft).lookup 7 = some 20 := by
  rw [lookup_mergeChunkMaps]
  simp [conflictRight]

example :
    mergeChunkMaps conflictLeft conflictRight ≠
      mergeChunkMaps conflictRight conflictLeft := by
  intro hequal
  have hlookup := congrArg (fun store : ChunkMap Nat Nat ↦ store.lookup 7) hequal
  rw [lookup_mergeChunkMaps, lookup_mergeChunkMaps] at hlookup
  simp [conflictLeft, conflictRight] at hlookup

example :
    (mergeChunkMaps conflictLeft conflictRight).keys =
      mergeChunkIds conflictLeft.keys conflictRight.keys := by
  apply keys_mergeChunkMaps

example : (mergeChunkMaps conflictLeft conflictRight).keys = ({7} : ChunkIds Nat) := by
  rw [keys_mergeChunkMaps]
  decide

example : Compatible conflictLeft (∅ : ChunkMap Nat Nat) := by
  intro hash leftBytes rightBytes hleft hright
  rw [Finmap.lookup_empty] at hright
  contradiction

example : Compatible (∅ : ChunkMap Nat Nat) conflictRight := by
  intro hash leftBytes rightBytes hleft hright
  rw [Finmap.lookup_empty] at hleft
  contradiction

example : ¬Compatible conflictLeft conflictRight := by
  intro hcompatible
  have hvalue := hcompatible 7 10 20 (by simp [conflictLeft]) (by simp [conflictRight])
  have hne : (10 : Nat) ≠ 20 := by decide
  exact hne hvalue

example :
    Compatible overlapLeft overlapRight := by
  exact overlapCompatible
