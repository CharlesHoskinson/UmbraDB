import UmbraDBFormal.TemporalKV.Retention.Model

namespace UmbraDBFormalTest.TemporalKV.RetentionModel

open UmbraDBFormal.TemporalKV
open UmbraDBFormal.TemporalKV.Retention

private def fullHistory : History Nat Nat :=
  [{ value := 10, writtenAt := 10 },
    { value := 20, writtenAt := 20 },
    { value := 30, writtenAt := 30 },
    { value := 40, writtenAt := 40 }]

private def retainedTwo : RetainedSuffix Nat Nat :=
  { prunedCount := ⟨2, by decide⟩
    first := { value := 30, writtenAt := 30 }
    rest := [{ value := 40, writtenAt := 40 }] }

example : prunePrefix fullHistory 2 = some (.pruned retainedTwo) := rfl

example : prunePrefix fullHistory 0 = some (.complete fullHistory) := rfl

example : prunePrefix fullHistory 4 = none := rfl

example : lookupAtTime (.complete ([] : History Nat Nat)) 50 = .absent := rfl

example : lookupAtVersion (.complete ([] : History Nat Nat)) ⟨1, by decide⟩ = .absent := rfl

example : lookupAtTime (.complete fullHistory) 9 = .absent := rfl

example : lookupAtTime (.pruned retainedTwo) 19 =
    .unavailable { oldestAvailableAt := 30, oldestAvailableVersion := 3 } := rfl

example : lookupAtVersion (.pruned retainedTwo) ⟨2, by decide⟩ =
    .unavailable { oldestAvailableAt := 30, oldestAvailableVersion := 3 } := rfl

example : lookupAtTime (.pruned retainedTwo) 30 =
    .found { value := 30, version := 3, writtenAt := 30 } := rfl

example : lookupAtVersion (.pruned retainedTwo) ⟨3, by decide⟩ =
    .found { value := 30, version := 3, writtenAt := 30 } := rfl

example : lookupAtTime (.pruned retainedTwo) 35 =
    .found { value := 30, version := 3, writtenAt := 30 } := rfl

example : lookupAtTime (.pruned retainedTwo) 40 =
    .found { value := 40, version := 4, writtenAt := 40 } := rfl

example : lookupAtTime (.pruned retainedTwo) 50 =
    .found { value := 40, version := 4, writtenAt := 40 } := rfl

example : lookupAtVersion (.pruned retainedTwo) ⟨5, by decide⟩ = .absent := rfl

/-- The same available list has different pre-head semantics depending on whether completeness is
certified. -/
example :
    lookupAtTime (.complete retainedTwo.events) 19 = .absent ∧
      lookupAtTime (.pruned retainedTwo) 19 =
        .unavailable { oldestAvailableAt := 30, oldestAvailableVersion := 3 } := by
  decide

private def retainedForty : RetainedSuffix Nat Nat :=
  { prunedCount := ⟨40, by decide⟩
    first := { value := 41, writtenAt := 100 }
    rest := [{ value := 42, writtenAt := 110 }] }

example : lookupAtVersion (.pruned retainedForty) ⟨41, by decide⟩ =
    .found { value := 41, version := 41, writtenAt := 100 } := rfl

example : lookupAtVersion (.pruned retainedForty) ⟨40, by decide⟩ =
    .unavailable { oldestAvailableAt := 100, oldestAvailableVersion := 41 } := rfl

example : lookupAtVersion (.pruned retainedForty) ⟨43, by decide⟩ = .absent := rfl

/-- Retained lookup remains executable for malformed suffixes; ordering-dependent laws require a
separate `WellFormed` premise. -/
example :
    lookupAtTime
        (.pruned
          { prunedCount := ⟨2, by decide⟩
            first := { value := 30, writtenAt := 30 }
            rest := [{ value := 20, writtenAt := 20 }] } : RetainedHistory Nat Nat)
        30 =
      .found { value := 20, version := 4, writtenAt := 20 } := rfl

example : ¬∃ version : PositiveVersion, version.1 = 0 := by
  rintro ⟨version, hzero⟩
  exact (by simpa [hzero] using version.2)

/-- A stored null-like value remains a found entry rather than collapsing into absence. -/
example :
    lookupAtVersion
        (.complete ([{ value := none, writtenAt := 10 }] : History (Option Nat) Nat))
        ⟨1, by decide⟩ =
      .found { value := none, version := 1, writtenAt := 10 } := rfl

end UmbraDBFormalTest.TemporalKV.RetentionModel
