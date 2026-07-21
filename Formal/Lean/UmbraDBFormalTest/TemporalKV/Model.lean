import UmbraDBFormal.TemporalKV.Model

open UmbraDBFormal.TemporalKV

example : snapshotVersion ([] : History Nat Nat) = none := rfl

example : snapshotVersion ([{ value := 7, writtenAt := 10 }] : History Nat Nat) = some 1 := rfl

example : expectationMatches ([] : History Nat Nat) .absent = true := rfl

example : expectationMatches ([] : History Nat Nat) (.at 0) = false := rfl

example :
    expectationMatches ([{ value := 7, writtenAt := 10 }] : History Nat Nat) (.at 1) = true :=
  rfl

example :
    WellFormed ([{ value := 7, writtenAt := 10 }, { value := 8, writtenAt := 11 }] :
      History Nat Nat) := by
  decide

example :
    ¬WellFormed ([{ value := 7, writtenAt := 10 }, { value := 8, writtenAt := 10 }] :
      History Nat Nat) := by
  decide

example : current ([] : History Nat Nat) = none := rfl

example :
    current ([{ value := 7, writtenAt := 10 }, { value := 8, writtenAt := 11 }] :
      History Nat Nat) = some { value := 8, version := 2, writtenAt := 11 } := rfl

example :
    getAtVersion ([{ value := 7, writtenAt := 10 }] : History Nat Nat) 0 = none := rfl

example :
    getAtVersion
      ([{ value := 7, writtenAt := 10 }, { value := 8, writtenAt := 11 }] : History Nat Nat)
      2 = some { value := 8, version := 2, writtenAt := 11 } := rfl

example :
    getAtTime
      ([{ value := 7, writtenAt := 10 }, { value := 8, writtenAt := 12 }] : History Nat Nat)
      11 = some { value := 7, version := 1, writtenAt := 10 } := rfl

/-- The query scans in list order and has a deterministic result even for malformed histories. -/
example :
    getAtTime
      ([{ value := 7, writtenAt := 10 }, { value := 8, writtenAt := 5 },
        { value := 9, writtenAt := 12 }] : History Nat Nat)
      6 = some { value := 8, version := 2, writtenAt := 5 } := rfl

example :
    attempt ([] : History Nat Nat)
      ({ value := 7, writtenAt := 10, expectation := .absent } : Write Nat Nat) =
      (.applied { value := 7, version := 1, writtenAt := 10 },
        [{ value := 7, writtenAt := 10 }]) := rfl

example :
    (attempt ([{ value := 7, writtenAt := 10 }] : History Nat Nat)
      { value := 8, writtenAt := 11, expectation := .absent }).2 =
      [{ value := 7, writtenAt := 10 }] := rfl

example :
    attempt ([{ value := 7, writtenAt := 10 }] : History Nat Nat)
      { value := 8, writtenAt := 10, expectation := .absent } =
      (.failed (.versionConflict (some 1)), [{ value := 7, writtenAt := 10 }]) := rfl

example :
    attempt ([{ value := 7, writtenAt := 10 }] : History Nat Nat)
      { value := 8, writtenAt := 10, expectation := .unconditional } =
      (.failed (.clockNotIncreasing 10 10), [{ value := 7, writtenAt := 10 }]) := rfl

example :
    runAttempts ([] : History Nat Nat)
      [{ value := 7, writtenAt := 10, expectation := .absent },
        { value := 8, writtenAt := 11, expectation := .absent },
        { value := 9, writtenAt := 12, expectation := .unconditional }] =
      ([.applied { value := 7, version := 1, writtenAt := 10 },
        .failed (.versionConflict (some 1)),
        .applied { value := 9, version := 2, writtenAt := 12 }],
        [{ value := 7, writtenAt := 10 }, { value := 9, writtenAt := 12 }]) := rfl

example :
    runTransaction ([] : History Nat Nat)
      [{ value := 7, writtenAt := 10, expectation := .absent },
        { value := 8, writtenAt := 11, expectation := .at 1 }] =
      .ok [{ value := 7, writtenAt := 10 }, { value := 8, writtenAt := 11 }] := rfl

example :
    runTransaction ([] : History Nat Nat)
      [{ value := 7, writtenAt := 10, expectation := .absent },
        { value := 8, writtenAt := 10, expectation := .unconditional }] =
      .error (.clockNotIncreasing 10 10) := rfl
