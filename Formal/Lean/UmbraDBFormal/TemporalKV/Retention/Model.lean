import UmbraDBFormal.TemporalKV.Model

/-!
# Temporal key-value retention model

Executable per-key semantics for complete histories and nonempty retained suffixes. A retained
suffix records only how many original events were removed; both availability-floor coordinates
are derived so they cannot disagree with the retained data.
-/

namespace UmbraDBFormal.TemporalKV.Retention

/-- Public version selectors are positive even though the underlying executable M1 version is a
natural number. -/
abbrev PositiveVersion := { version : Version // 0 < version }

/-- A nonempty available suffix together with the exact number of original events removed. -/
structure RetainedSuffix (Value Time : Type*) where
  prunedCount : { count : Nat // 0 < count }
  first : Event Value Time
  rest : History Value Time
deriving DecidableEq, Repr

def RetainedSuffix.events (suffix : RetainedSuffix Value Time) : History Value Time :=
  suffix.first :: suffix.rest

def RetainedSuffix.oldestAvailableAt (suffix : RetainedSuffix Value Time) : Time :=
  suffix.first.writtenAt

def RetainedSuffix.oldestAvailableVersion (suffix : RetainedSuffix Value Time) : Version :=
  suffix.prunedCount.1 + 1

/-- The two-dimensional availability floor exposed by `HistoryUnavailableError`. -/
structure AvailabilityFloor (Time : Type*) where
  oldestAvailableAt : Time
  oldestAvailableVersion : Version
deriving DecidableEq, Repr

def RetainedSuffix.floor (suffix : RetainedSuffix Value Time) : AvailabilityFloor Time :=
  { oldestAvailableAt := suffix.oldestAvailableAt
    oldestAvailableVersion := suffix.oldestAvailableVersion }

/-- `complete []` is the unique per-key never-written state. A pruned state is structurally
nonempty and certifies that a positive oldest prefix is unavailable. -/
inductive RetainedHistory (Value Time : Type*) where
  | complete (history : History Value Time)
  | pruned (suffix : RetainedSuffix Value Time)
deriving DecidableEq, Repr

def RetainedHistory.events : RetainedHistory Value Time → History Value Time
  | .complete history => history
  | .pruned suffix => suffix.events

def RetainedHistory.wellFormed [LT Time] (history : RetainedHistory Value Time) : Prop :=
  WellFormed history.events

/-- Historical lookup separates a known absence from data made unknowable by pruning. -/
inductive HistoricalResult (Value Time : Type*) where
  | found (entry : VersionedEntry Value Time)
  | absent
  | unavailable (floor : AvailabilityFloor Time)
deriving DecidableEq, Repr

inductive HistoricalQuery (Time : Type*) where
  | version (version : PositiveVersion)
  | at (time : Time)
deriving DecidableEq, Repr

def shiftVersion (prunedCount : Nat) (entry : VersionedEntry Value Time) :
    VersionedEntry Value Time :=
  { entry with version := prunedCount + entry.version }

def HistoricalResult.ofOption :
    Option (VersionedEntry Value Time) → HistoricalResult Value Time
  | none => .absent
  | some entry => .found entry

/-- Remove exactly an oldest prefix. Removing the live final event, or more, is rejected. -/
def prunePrefix (history : History Value Time) (prunedCount : Nat) :
    Option (RetainedHistory Value Time) :=
  match prunedCount with
  | 0 => some (.complete history)
  | count + 1 =>
      match history.drop (count + 1) with
      | [] => none
      | first :: rest =>
          some (.pruned
            { prunedCount := ⟨count + 1, Nat.succ_pos count⟩
              first
              rest })

def lookupAtTime [LinearOrder Time] :
    RetainedHistory Value Time → Time → HistoricalResult Value Time
  | .complete history, query => .ofOption (TemporalKV.getAtTime history query)
  | .pruned suffix, query =>
      if query < suffix.oldestAvailableAt then
        .unavailable suffix.floor
      else
        .ofOption <|
          (TemporalKV.getAtTime suffix.events query).map
            (shiftVersion suffix.prunedCount.1)

def lookupAtVersion :
    RetainedHistory Value Time → PositiveVersion → HistoricalResult Value Time
  | .complete history, version =>
      .ofOption (TemporalKV.getAtVersion history version.1)
  | .pruned suffix, version =>
      if version.1 < suffix.oldestAvailableVersion then
        .unavailable suffix.floor
      else
        .ofOption <|
          (TemporalKV.getAtVersion suffix.events (version.1 - suffix.prunedCount.1)).map
            (shiftVersion suffix.prunedCount.1)

def lookup [LinearOrder Time] (history : RetainedHistory Value Time) :
    HistoricalQuery Time → HistoricalResult Value Time
  | .version version => lookupAtVersion history version
  | .at query => lookupAtTime history query

end UmbraDBFormal.TemporalKV.Retention
