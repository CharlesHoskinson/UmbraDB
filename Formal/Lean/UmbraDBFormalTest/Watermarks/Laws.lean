import UmbraDBFormal.Watermarks.Laws

open UmbraDBFormal.Watermarks

private def left : Address String Nat := { kind := "sync", key := 1 }
private def otherKind : Address String Nat := { kind := "wallet", key := 1 }
private def otherKey : Address String Nat := { kind := "sync", key := 2 }

example : get (empty : Store String Nat Nat) left = none := by
  apply get_empty

example : get (set (empty : Store String Nat Nat) left 10) left = some 10 := by
  apply get_set_same

example : get (set (empty : Store String Nat Nat) left 10) otherKind = none := by
  apply get_set_of_ne
  decide

example : get (set (empty : Store String Nat Nat) left 10) otherKey = none := by
  apply get_set_of_ne
  decide

example :
    set (set (empty : Store String Nat Nat) left 10) left 20 =
      set (empty : Store String Nat Nat) left 20 := by
  apply set_set_same

example :
    set (set (empty : Store String Nat Nat) left 10) left 10 =
      set (empty : Store String Nat Nat) left 10 := by
  apply set_idempotent

example :
    set (set (empty : Store String Nat Nat) left 10) otherKind 20 =
      set (set (empty : Store String Nat Nat) otherKind 20) left 10 := by
  apply set_comm_of_ne
  decide

example :
    set (set (empty : Store String Nat Nat) left 10) otherKey 20 =
      set (set (empty : Store String Nat Nat) otherKey 20) left 10 := by
  apply set_comm_of_ne
  decide

example :
    runSets (empty : Store String Nat Nat)
        ([{ address := left, value := 10 }] ++
          [{ address := otherKey, value := 30 }, { address := left, value := 20 }]) =
      runSets
        (runSets (empty : Store String Nat Nat) [{ address := left, value := 10 }])
        [{ address := otherKey, value := 30 }, { address := left, value := 20 }] := by
  apply runSets_append

example :
    lastMatching left
        ([{ address := left, value := 10 },
          { address := left, value := 20 },
          { address := otherKey, value := 30 }] : List (SetCommand String Nat Nat)) =
      (([{ address := left, value := 10 },
          { address := left, value := 20 },
          { address := otherKey, value := 30 }] : List (SetCommand String Nat Nat)).filter
        fun command ↦ command.address = left).getLast?.map fun command ↦ command.value := by
  apply lastMatching_eq_filter_getLast?

example :
    get
        (runSets (empty : Store String Nat Nat)
          [{ address := left, value := 10 },
            { address := left, value := 20 },
            { address := otherKey, value := 30 }])
        left =
      some 20 := by
  rw [get_runSets_eq_lastMatching]
  decide

example :
    get
        (runSets (set (empty : Store String Nat Nat) left 10)
          [{ address := otherKey, value := 30 }])
        left =
      some 10 := by
  apply runSets_frame
  intro command hmem
  simp at hmem
  rcases hmem with rfl
  decide

example :
    get (set (empty : Store String Nat (Option Nat)) left none) left = some none := by
  apply get_set_same
