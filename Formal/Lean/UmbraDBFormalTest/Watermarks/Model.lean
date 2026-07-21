import UmbraDBFormal.Watermarks.Model

open UmbraDBFormal.Watermarks

private def left : Address String Nat := { kind := "sync", key := 1 }
private def otherKind : Address String Nat := { kind := "wallet", key := 1 }
private def otherKey : Address String Nat := { kind := "sync", key := 2 }

example : get (empty : Store String Nat Nat) left = none := rfl

example : get (set (empty : Store String Nat Nat) left 10) left = some 10 := by
  decide

example : get (set (set (empty : Store String Nat Nat) left 10) left 20) left = some 20 := by
  decide

example : get (set (set (empty : Store String Nat Nat) left 10) left 10) left = some 10 := by
  decide

example : get (set (empty : Store String Nat Nat) left 10) otherKind = none := by
  decide

example : get (set (empty : Store String Nat Nat) left 10) otherKey = none := by
  decide

example :
    get
        (runSets (empty : Store String Nat Nat)
          [{ address := left, value := 10 },
            { address := otherKey, value := 30 },
            { address := left, value := 20 },
            { address := otherKind, value := 40 }])
        left =
      some 20 := by
  decide

example :
    lastMatching left
        ([{ address := left, value := 10 },
          { address := left, value := 20 },
          { address := otherKey, value := 30 }] : List (SetCommand String Nat Nat)) =
      some 20 := by
  decide

example :
    get
        (runSets (set (empty : Store String Nat Nat) left 10)
          [{ address := otherKey, value := 30 }])
        left =
      some 10 := by
  decide

example : get (empty : Store String Nat (Option Nat)) left = none := rfl

example :
    get (set (empty : Store String Nat (Option Nat)) left none) left = some none := by
  decide
