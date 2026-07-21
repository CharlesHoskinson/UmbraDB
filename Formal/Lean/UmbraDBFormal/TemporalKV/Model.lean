import Mathlib.Data.List.Basic
import Mathlib.Data.Nat.Basic
import Mathlib.Order.Interval.Set.Basic

namespace UmbraDBFormal.TemporalKV

abbrev Version := Nat

structure Event (Value Time : Type*) where
  value : Value
  writtenAt : Time
deriving DecidableEq, Repr

structure VersionedEntry (Value Time : Type*) where
  value : Value
  version : Version
  writtenAt : Time
deriving DecidableEq, Repr

inductive Expectation where
  | unconditional
  | absent
  | at (version : Version)
deriving DecidableEq, Repr

structure Write (Value Time : Type*) where
  value : Value
  writtenAt : Time
  expectation : Expectation
deriving DecidableEq, Repr

inductive Failure (Time : Type*) where
  | versionConflict (actual : Option Version)
  | clockNotIncreasing (previous candidate : Time)
deriving DecidableEq, Repr

inductive Outcome (Value Time : Type*) where
  | applied (entry : VersionedEntry Value Time)
  | failed (failure : Failure Time)
deriving DecidableEq, Repr

abbrev History (Value Time : Type*) := List (Event Value Time)

/-- The validity window owned by one event. `none` denotes the live, open-ended tail. -/
structure ValidityInterval (Time : Type*) where
  validFrom : Time
  validTo : Option Time
deriving DecidableEq, Repr

/-- Interpret a validity window using the store's half-open boundary convention. -/
def ValidityInterval.asSet [Preorder Time] (interval : ValidityInterval Time) : Set Time :=
  match interval.validTo with
  | some validTo => Set.Ico interval.validFrom validTo
  | none => Set.Ici interval.validFrom

/-- Project an event history to bounded historical windows followed by its live tail. -/
def validityIntervals : History Value Time → List (ValidityInterval Time)
  | [] => []
  | [last] => [{ validFrom := last.writtenAt, validTo := none }]
  | first :: second :: rest =>
      { validFrom := first.writtenAt, validTo := some second.writtenAt } ::
        validityIntervals (second :: rest)

@[reducible] private def adjacentTimestamps [LT Time] (previous : Event Value Time) :
    List (Event Value Time) → Prop
  | [] => True
  | next :: rest => previous.writtenAt < next.writtenAt ∧ adjacentTimestamps next rest

@[reducible] def WellFormed [LT Time] (history : History Value Time) : Prop :=
  match history with
  | [] => True
  | first :: rest => adjacentTimestamps first rest

def snapshotVersion (history : History Value Time) : Option Version :=
  match history with
  | [] => none
  | _ :: rest => some (rest.length + 1)

def expectationMatches (history : History Value Time) : Expectation → Bool
  | .unconditional => true
  | .absent => history.isEmpty
  | .at 0 => false
  | .at version => snapshotVersion history == some version

def current (history : History Value Time) : Option (VersionedEntry Value Time) :=
  history.getLast?.map fun event ↦
    { value := event.value, version := history.length, writtenAt := event.writtenAt }

def getAtVersion (history : History Value Time) : Version → Option (VersionedEntry Value Time)
  | 0 => none
  | version =>
      history[version - 1]?.map fun event ↦
        { value := event.value, version, writtenAt := event.writtenAt }

private def getAtTimeFrom [LinearOrder Time] (query : Time) :
    Version → Option (VersionedEntry Value Time) → History Value Time →
      Option (VersionedEntry Value Time)
  | _, candidate, [] => candidate
  | version, candidate, event :: rest =>
      let entry := { value := event.value, version, writtenAt := event.writtenAt }
      let nextCandidate := if event.writtenAt ≤ query then some entry else candidate
      getAtTimeFrom query (version + 1) nextCandidate rest

def getAtTime [LinearOrder Time] (history : History Value Time) (query : Time) :
    Option (VersionedEntry Value Time) :=
  getAtTimeFrom query 1 none history

private def appliedWrite (history : History Value Time) (write : Write Value Time) :
    Outcome Value Time × History Value Time :=
  let entry := { value := write.value, version := history.length + 1, writtenAt := write.writtenAt }
  let event := { value := write.value, writtenAt := write.writtenAt }
  (.applied entry, history ++ [event])

def attempt [LinearOrder Time] (history : History Value Time) (write : Write Value Time) :
    Outcome Value Time × History Value Time :=
  match expectationMatches history write.expectation with
  | false => (.failed (.versionConflict (snapshotVersion history)), history)
  | true =>
      match current history with
      | none => appliedWrite history write
      | some previous =>
          if write.writtenAt ≤ previous.writtenAt then
            (.failed (.clockNotIncreasing previous.writtenAt write.writtenAt), history)
          else
            appliedWrite history write

def runAttempts [LinearOrder Time] :
    History Value Time → List (Write Value Time) → List (Outcome Value Time) × History Value Time
  | history, [] => ([], history)
  | history, write :: writes =>
      let (outcome, nextHistory) := attempt history write
      let (outcomes, finalHistory) := runAttempts nextHistory writes
      (outcome :: outcomes, finalHistory)

private def runTransactionFrom [LinearOrder Time] :
    History Value Time → List (Write Value Time) → Except (Failure Time) (History Value Time)
  | history, [] => .ok history
  | history, write :: writes =>
      match attempt history write with
      | (.applied _, nextHistory) => runTransactionFrom nextHistory writes
      | (.failed failure, _) => .error failure

def runTransaction [LinearOrder Time] (history : History Value Time)
    (writes : List (Write Value Time)) : Except (Failure Time) (History Value Time) :=
  runTransactionFrom history writes

end UmbraDBFormal.TemporalKV
