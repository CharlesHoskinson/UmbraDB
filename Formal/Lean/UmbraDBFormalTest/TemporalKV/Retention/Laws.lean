import UmbraDBFormal.TemporalKV.Retention.Laws

namespace UmbraDBFormalTest.TemporalKV.RetentionLaws

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

private theorem fullHistory_wellFormed : WellFormed fullHistory := by
  change WellFormed
    ([{ value := 10, writtenAt := 10 },
      { value := 20, writtenAt := 20 },
      { value := 30, writtenAt := 30 },
      { value := 40, writtenAt := 40 }] : History Nat Nat)
  decide

private theorem retainedTwo_wellFormed : WellFormed retainedTwo.events := by
  change WellFormed
    ([{ value := 30, writtenAt := 30 }, { value := 40, writtenAt := 40 }] :
      History Nat Nat)
  decide

example : (validityIntervals fullHistory).length = fullHistory.length := by
  apply validityIntervals_length

example (point : Nat) :
    (∃ interval ∈ validityIntervals fullHistory, point ∈ interval.asSet) ↔ 10 ≤ point := by
  apply validityIntervals_cover_iff
  decide

example : retainedTwo.events = fullHistory.drop 2 := by
  simpa [RetainedHistory.events] using
    (prunePrefix_success_events
      (retained := RetainedHistory.pruned retainedTwo) (history := fullHistory)
      (prunedCount := 2) (by rfl))

example : WellFormed retainedTwo.events := by
  have hretained := prunePrefix_preserves_wellFormed
    (history := fullHistory) (prunedCount := 2)
    (retained := RetainedHistory.pruned retainedTwo)
    fullHistory_wellFormed (by rfl)
  change WellFormed retainedTwo.events at hretained
  exact hretained

example : retainedTwo.events.getLast? = fullHistory.getLast? := by
  apply prunePrefix_preserves_live (history := fullHistory) (prunedCount := 2)
  rfl

example :
    lookupAtTime (.pruned retainedTwo) 29 = .unavailable retainedTwo.floor ↔
      29 < retainedTwo.oldestAvailableAt := by
  apply lookupAtTime_unavailable_iff

example :
    lookupAtVersion (.pruned retainedTwo) ⟨2, by decide⟩ =
        .unavailable retainedTwo.floor ↔
      2 < retainedTwo.oldestAvailableVersion := by
  apply lookupAtVersion_unavailable_iff

example : lookupAtTime (.pruned retainedTwo) retainedTwo.oldestAvailableAt =
    .found { value := 30, version := 3, writtenAt := 30 } := by
  apply lookupAtTime_floor
  exact retainedTwo_wellFormed

example : lookupAtVersion (.pruned retainedTwo)
      ⟨retainedTwo.oldestAvailableVersion, by decide⟩ =
    .found { value := 30, version := 3, writtenAt := 30 } := by
  apply lookupAtVersion_floor

/-- Retention-aware T3: lookup above the floor agrees with the original full history. -/
example : lookupAtTime (.pruned retainedTwo) 35 =
    .ofOption (getAtTime fullHistory 35) := by
  apply prunePrefix_lookupAtTime_agrees
      (history := fullHistory) (prunedCount := 2)
  · exact fullHistory_wellFormed
  · rfl
  · decide

example : lookupAtVersion (.pruned retainedTwo) ⟨4, by decide⟩ =
    .ofOption (getAtVersion fullHistory 4) := by
  apply prunePrefix_lookupAtVersion_agrees
      (history := fullHistory) (prunedCount := 2)
  · rfl
  · decide

example : lookupAtTime (.pruned retainedTwo) 50 ≠ .absent := by
  apply lookupAtTime_pruned_ne_absent
  · exact retainedTwo_wellFormed
  · decide

example {entry : VersionedEntry Nat Nat}
    (hfound : lookupAtVersion (.pruned retainedTwo) ⟨4, by decide⟩ = .found entry) :
    entry.version = 4 := by
  exact lookupAtVersion_pruned_found_version retainedTwo ⟨4, by decide⟩ entry hfound

example : lookupAtVersion (.pruned retainedTwo) ⟨5, by decide⟩ = .absent := by
  apply lookupAtVersion_pruned_above_absent
  decide

end UmbraDBFormalTest.TemporalKV.RetentionLaws
