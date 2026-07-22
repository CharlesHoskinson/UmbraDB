import UmbraDBFormal.Checkpoint.Projection

open UmbraDBFormal.Checkpoint

private def duplicateHashes : List Nat := [1, 2, 1]
private def forwardHashes : List Nat := [1, 2]
private def reverseHashes : List Nat := [2, 1]

example : duplicateHashes.length = 3 := by
  decide

example : chunkIdsOfHashes duplicateHashes = {1, 2} := by
  decide

example : forwardHashes ≠ reverseHashes := by
  decide

example : chunkIdsOfHashes forwardHashes = chunkIdsOfHashes reverseHashes := by
  decide

example : mergeChunkIds ({1, 2} : ChunkIds Nat) {2, 3} = {1, 2, 3} := by
  decide

example : mergeChunkIds ({1, 2} : ChunkIds Nat) {2, 3} = mergeChunkIds {2, 3} {1, 2} := by
  apply mergeChunkIds_comm

example : saveChunkIds ({4} : ChunkIds Nat) [] = {4} := by
  apply saveChunkIds_empty

example :
    saveChunkIds (saveChunkIds ({4} : ChunkIds Nat) [1, 2, 1]) [1, 2, 1] =
      saveChunkIds {4} [1, 2, 1] := by
  apply saveChunkIds_repeat

example :
    saveChunkIds (saveChunkIds ({4} : ChunkIds Nat) [1, 2]) [2, 3] =
      saveChunkIds (saveChunkIds {4} [2, 3]) [1, 2] := by
  apply saveChunkIds_order_independent
