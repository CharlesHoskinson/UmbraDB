import UmbraDBFormal.TemporalKV.Laws

open UmbraDBFormal.TemporalKV

example :
    getAtVersion ([{ value := 3, writtenAt := 5 }, { value := 4, writtenAt := 8 }] :
      History Nat Nat) 2 = some { value := 4, version := 2, writtenAt := 8 } := by
  decide

example :
    getAtTime ([{ value := 3, writtenAt := 5 }, { value := 4, writtenAt := 8 }] :
      History Nat Nat) 8 = some { value := 4, version := 2, writtenAt := 8 } := by
  decide

example :
    ({ value := 4, version := 2, writtenAt := 8 } : VersionedEntry Nat Nat).version =
        ([{ value := 3, writtenAt := 5 }] : History Nat Nat).length + 1 ∧
      ([{ value := 3, writtenAt := 5 }, { value := 4, writtenAt := 8 }] :
        History Nat Nat) =
        [{ value := 3, writtenAt := 5 }] ++ [{ value := 4, writtenAt := 8 }] := by
  apply attempt_applied_version
    (write := { value := 4, writtenAt := 8, expectation := .unconditional })
  rfl

example :
    (attempt ([{ value := 3, writtenAt := 5 }] : History Nat Nat)
      { value := 4, writtenAt := 8, expectation := .absent }).1 =
        .failed (.versionConflict (some 1)) ↔
      expectationMatches ([{ value := 3, writtenAt := 5 }] : History Nat Nat) .absent = false := by
  exact attempt_conflict_iff_snapshot_mismatch (Value := Nat) (Time := Nat)
    [{ value := 3, writtenAt := 5 }]
    { value := 4, writtenAt := 8, expectation := .absent }

example :
    ([{ value := 3, writtenAt := 5 }] : History Nat Nat) =
      [{ value := 3, writtenAt := 5 }] := by
  apply conflict_preserves_history
    (write := { value := 4, writtenAt := 8, expectation := .absent })
    (actual := some 1)
  rfl

example :
    ([{ value := 3, writtenAt := 5 }] : History Nat Nat) =
      [{ value := 3, writtenAt := 5 }] := by
  apply clock_failure_preserves_history
    (write := { value := 4, writtenAt := 5, expectation := .unconditional })
    (previous := 5) (candidate := 5)
  rfl

example :
    WellFormed
      (attempt ([{ value := 3, writtenAt := 5 }] : History Nat Nat)
        { value := 4, writtenAt := 8, expectation := .unconditional }).2 := by
  apply attempt_preserves_wellFormed
  decide

example :
    getAtVersion ([{ value := 3, writtenAt := 5 }, { value := 4, writtenAt := 8 }] :
      History Nat Nat) 2 =
      ([{ value := 3, writtenAt := 5 }, { value := 4, writtenAt := 8 }] :
        History Nat Nat)[2 - 1]?.map fun event ↦
          { value := event.value, version := 2, writtenAt := event.writtenAt } := by
  apply getAtVersion_eq_index
  decide

example :
    getAtTime ([{ value := 3, writtenAt := 5 }, { value := 4, writtenAt := 8 }] :
      History Nat Nat) 8 =
      (([{ value := 3, writtenAt := 5 }, { value := 4, writtenAt := 8 }] :
          History Nat Nat).takeWhile fun event ↦ event.writtenAt ≤ 8).getLast?.map
        fun event ↦
          { value := event.value,
            version :=
              (([{ value := 3, writtenAt := 5 }, { value := 4, writtenAt := 8 }] :
                History Nat Nat).takeWhile fun event ↦ event.writtenAt ≤ 8).length,
            writtenAt := event.writtenAt } := by
  apply getAtTime_eq_last_prefix
  decide

example :
    (validityIntervals
      ([{ value := 3, writtenAt := 5 }, { value := 4, writtenAt := 8 },
        { value := 5, writtenAt := 13 }] : History Nat Nat)).IsChain
      (fun left right ↦ left.validTo = some right.validFrom) := by
  apply adjacent_intervals_gap_free

example :
    (validityIntervals
      ([{ value := 3, writtenAt := 5 }, { value := 4, writtenAt := 8 },
        { value := 5, writtenAt := 13 }] : History Nat Nat)).Pairwise
      (fun left right ↦ Disjoint left.asSet right.asSet) := by
  apply intervals_pairwise_disjoint
  decide

example :
    (8 : Nat) ∉
        ValidityInterval.asSet ({ validFrom := 5, validTo := some 8 } :
          ValidityInterval Nat) ∧
      (8 : Nat) ∈
        ValidityInterval.asSet ({ validFrom := 8, validTo := some 13 } :
          ValidityInterval Nat) := by
  simp [ValidityInterval.asSet]

example :
    (runAttempts ([] : History Nat Nat)
      [{ value := 3, writtenAt := 5, expectation := .unconditional },
        { value := 4, writtenAt := 8, expectation := .unconditional }]).2 =
      ([] : History Nat Nat) ++
        ([{ value := 3, writtenAt := 5, expectation := .unconditional },
          { value := 4, writtenAt := 8, expectation := .unconditional }] :
          List (Write Nat Nat)).map
          fun write ↦ { value := write.value, writtenAt := write.writtenAt } := by
  apply accepted_replay_eq_prefix
  change
    [Outcome.applied (VersionedEntry.mk 3 1 5),
      Outcome.applied (VersionedEntry.mk 4 2 8)].Forall
      (fun outcome ↦ ∃ entry, outcome = Outcome.applied entry)
  simp

example :
    (getAtVersion ([{ value := 3, writtenAt := 5 }, { value := 4, writtenAt := 8 }] :
      History Nat Nat) 2).bind (fun entry ↦
        getAtTime
          ([{ value := 3, writtenAt := 5 }, { value := 4, writtenAt := 8 }] :
            History Nat Nat)
          entry.writtenAt) =
      getAtVersion ([{ value := 3, writtenAt := 5 }, { value := 4, writtenAt := 8 }] :
        History Nat Nat) 2 := by
  apply dual_address_agrees
  · decide
  · decide
  · decide
