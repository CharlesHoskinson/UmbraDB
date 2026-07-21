import Mathlib.Data.List.TakeWhile
import Mathlib.Tactic.DefEqTransformations
import UmbraDBFormal.TemporalKV.Model

/-!
# Temporal key-value laws

Transition preservation, lookup characterization, accepted replay, and address agreement for the
M1 temporal history model.
-/

namespace UmbraDBFormal.TemporalKV

/-- An applied attempt assigns the next one-based version and appends the write's event. -/
theorem attempt_applied_version [LinearOrder Time] {history : History Value Time}
    {write : Write Value Time} {entry : VersionedEntry Value Time}
    {nextHistory : History Value Time}
    (h : attempt history write = (.applied entry, nextHistory)) :
    entry.version = history.length + 1 ∧
      nextHistory = history ++ [{ value := write.value, writtenAt := write.writtenAt }] := by
  simp only [attempt] at h
  split at h
  · simp at h
  · split at h
    · change
        (Outcome.applied (VersionedEntry.mk write.value (history.length + 1) write.writtenAt),
          history ++ [Event.mk write.value write.writtenAt]) =
          (Outcome.applied entry, nextHistory) at h
      cases h
      exact ⟨rfl, rfl⟩
    · split at h
      · simp at h
      · change
          (Outcome.applied (VersionedEntry.mk write.value (history.length + 1) write.writtenAt),
            history ++ [Event.mk write.value write.writtenAt]) =
            (Outcome.applied entry, nextHistory) at h
        cases h
        exact ⟨rfl, rfl⟩

/-- A version conflict is exactly the executable expectation mismatch branch. -/
theorem attempt_conflict_iff_snapshot_mismatch [LinearOrder Time]
    (history : History Value Time) (write : Write Value Time) :
    (attempt history write).1 = .failed (.versionConflict (snapshotVersion history)) ↔
      expectationMatches history write.expectation = false := by
  simp only [attempt]
  split
  · simp_all
  · split
    · simp_all only [Bool.true_eq_false, iff_false]
      change
        ¬Outcome.applied
            (VersionedEntry.mk write.value (history.length + 1) write.writtenAt) =
          Outcome.failed (Failure.versionConflict (snapshotVersion history))
      simp
    · split
      · simp_all
      · simp_all only [Bool.true_eq_false, iff_false]
        change
          ¬Outcome.applied
              (VersionedEntry.mk write.value (history.length + 1) write.writtenAt) =
            Outcome.failed (Failure.versionConflict (snapshotVersion history))
        simp

private theorem attempt_failed_preserves_history [LinearOrder Time]
    {history : History Value Time} {write : Write Value Time} {failure : Failure Time}
    {nextHistory : History Value Time}
    (h : attempt history write = (.failed failure, nextHistory)) : nextHistory = history := by
  simp only [attempt] at h
  split at h
  · exact (congrArg Prod.snd h).symm
  · split at h
    · change
        (Outcome.applied (VersionedEntry.mk write.value (history.length + 1) write.writtenAt),
          history ++ [Event.mk write.value write.writtenAt]) =
          (Outcome.failed failure, nextHistory) at h
      simp at h
    · split at h
      · exact (congrArg Prod.snd h).symm
      · change
          (Outcome.applied (VersionedEntry.mk write.value (history.length + 1) write.writtenAt),
            history ++ [Event.mk write.value write.writtenAt]) =
            (Outcome.failed failure, nextHistory) at h
        simp at h

/-- A version-conflict result leaves the abstract history unchanged. -/
theorem conflict_preserves_history [LinearOrder Time] {history : History Value Time}
    {write : Write Value Time} {actual : Option Version} {nextHistory : History Value Time}
    (h : attempt history write = (.failed (.versionConflict actual), nextHistory)) :
    nextHistory = history :=
  attempt_failed_preserves_history h

/-- A clock-failure result leaves the abstract history unchanged. -/
theorem clock_failure_preserves_history [LinearOrder Time] {history : History Value Time}
    {write : Write Value Time} {previous candidate : Time}
    {nextHistory : History Value Time}
    (h : attempt history write =
      (.failed (.clockNotIncreasing previous candidate), nextHistory)) :
    nextHistory = history :=
  attempt_failed_preserves_history h

private theorem wellFormed_append_of_getLast?_lt [LinearOrder Time]
    {history : History Value Time} {event : Event Value Time} (hwf : WellFormed history)
    (hlast : ∀ last, history.getLast? = some last → last.writtenAt < event.writtenAt) :
    WellFormed (history ++ [event]) := by
  induction history with
  | nil =>
      change True
      trivial
  | cons first rest ih =>
      cases rest with
      | nil =>
          have hlt := hlast first rfl
          simpa [WellFormed] using hlt
      | cons second rest =>
          have hpair : first.writtenAt < second.writtenAt := by
            simpa only [WellFormed] using hwf.left
          have htail : WellFormed (second :: rest) := by
            simpa only [WellFormed] using hwf.right
          have hlastTail : ∀ last, (second :: rest).getLast? = some last →
              last.writtenAt < event.writtenAt := by
            intro last hget
            apply hlast last
            simpa using hget
          change first.writtenAt < second.writtenAt ∧
            WellFormed ((second :: rest) ++ [event])
          exact ⟨hpair, ih htail hlastTail⟩

/-- Every attempt result preserves strict timestamp well-formedness. -/
theorem attempt_preserves_wellFormed [LinearOrder Time] {history : History Value Time}
    {write : Write Value Time} (hwf : WellFormed history) :
    WellFormed (attempt history write).2 := by
  simp only [attempt]
  split
  · exact hwf
  · split
    · rename_i hcurrent
      have hnil : history = [] := by
        cases history with
        | nil => rfl
        | cons first rest => simp [current] at hcurrent
      subst history
      change True
      trivial
    · rename_i previous hcurrent
      split
      · exact hwf
      · rename_i hclock
        change WellFormed
          (history ++ [Event.mk write.value write.writtenAt])
        apply wellFormed_append_of_getLast?_lt hwf
        intro last hlast
        have hprevious : last.writtenAt = previous.writtenAt := by
          simp only [current, hlast, Option.map_some] at hcurrent
          exact congrArg VersionedEntry.writtenAt (Option.some.inj hcurrent)
        rw [hprevious]
        exact lt_of_not_ge hclock

/-- A positive version lookup is the mapped zero-based list position `version - 1`. -/
theorem getAtVersion_eq_index (history : History Value Time) (version : Version)
    (hversion : version ≠ 0) :
    getAtVersion history version =
      history[version - 1]?.map fun event ↦
        { value := event.value, version, writtenAt := event.writtenAt } := by
  cases version with
  | zero => exact (hversion rfl).elim
  | succ version => rfl

private theorem wellFormed_tail [LT Time] {first : Event Value Time}
    {rest : History Value Time} (hwf : WellFormed (first :: rest)) : WellFormed rest := by
  cases rest with
  | nil =>
      change True
      trivial
  | cons second rest => exact hwf.right

private def expectedAtTime [LinearOrder Time] (query : Time) (version : Version)
    (candidate : Option (VersionedEntry Value Time)) (history : History Value Time) :
    Option (VersionedEntry Value Time) :=
  let selected := history.takeWhile (fun event ↦ event.writtenAt ≤ query)
  match selected.getLast? with
  | none => candidate
  | some event =>
      some
        { value := event.value,
          version := (selected.length + version).pred,
          writtenAt := event.writtenAt }

/-- A time lookup is the last entry of the maximal prefix at or before the query time. -/
theorem getAtTime_eq_last_prefix [LinearOrder Time] (history : History Value Time)
    (query : Time) (hwf : WellFormed history) :
    getAtTime history query =
      (history.takeWhile fun event ↦ event.writtenAt ≤ query).getLast?.map fun event ↦
        { value := event.value,
          version := (history.takeWhile fun event ↦ event.writtenAt ≤ query).length,
          writtenAt := event.writtenAt } := by
  have hrhs :
      (history.takeWhile fun event ↦ event.writtenAt ≤ query).getLast?.map (fun event ↦
          { value := event.value,
            version := (history.takeWhile fun event ↦ event.writtenAt ≤ query).length,
            writtenAt := event.writtenAt }) =
        expectedAtTime query 1 none history := by
    simp only [expectedAtTime]
    split <;> simp_all
  rw [hrhs]
  clear hrhs
  unfold getAtTime
  generalize hver : (1 : Version) = version
  generalize hcand : (none : Option (VersionedEntry Value Time)) = candidate
  clear hver hcand
  induction history generalizing version candidate with
  | nil =>
      change candidate = candidate
      rfl
  | cons first rest ih =>
      have htail := wellFormed_tail hwf
      by_cases hquery : first.writtenAt ≤ query
      · let firstEntry : VersionedEntry Value Time :=
          { value := first.value, version, writtenAt := first.writtenAt }
        have hrec := ih (version := version + 1) (candidate := some firstEntry) htail
        cases hprefix : rest.takeWhile fun event ↦ event.writtenAt ≤ query with
        | nil =>
            conv_lhs =>
              whnf
              simp [hquery]
            simpa [expectedAtTime, hquery, hprefix, firstEntry] using hrec
        | cons event events =>
            conv_lhs =>
              whnf
              simp [hquery]
            simp [expectedAtTime, hquery, hprefix, firstEntry, Nat.add_assoc,
              Nat.add_comm, Nat.add_left_comm] at hrec ⊢
            rw [List.getLast?_eq_getLast_of_ne_nil (by simp)] at hrec ⊢
            exact hrec
      · cases rest with
        | nil =>
            conv_lhs =>
              whnf
            rw [show LinearOrder.toDecidableLE first.writtenAt query = isFalse hquery
              from Subsingleton.elim _ _]
            simp [expectedAtTime, hquery]
        | cons second rest =>
            have hpair : first.writtenAt < second.writtenAt := by
              simpa only [WellFormed] using hwf.left
            have hsecond : ¬second.writtenAt ≤ query :=
              not_le_of_gt (lt_trans (lt_of_not_ge hquery) hpair)
            have hrec := ih (version := version + 1) (candidate := candidate) htail
            conv_lhs =>
              whnf
            simp only [if_neg hquery, if_neg hsecond]
            simp [expectedAtTime, hquery]
            conv at hrec =>
              lhs
              whnf
            simpa [expectedAtTime, hsecond] using hrec

/-- An all-applied attempt trace appends the writes' events in their original order. -/
theorem accepted_replay_eq_prefix [LinearOrder Time] (history : History Value Time)
    (writes : List (Write Value Time))
    (haccepted : (runAttempts history writes).1.Forall fun outcome ↦
      ∃ entry, outcome = .applied entry) :
    (runAttempts history writes).2 =
      history ++ writes.map fun write ↦
        { value := write.value, writtenAt := write.writtenAt } := by
  induction writes generalizing history with
  | nil =>
      conv_lhs => whnf
      simp
  | cons write writes ih =>
      cases hattempt : attempt history write with
      | mk outcome nextHistory =>
          cases outcome with
          | applied entry =>
              have htrace :
                  (Outcome.applied entry :: (runAttempts nextHistory writes).1).Forall
                    (fun outcome ↦ ∃ entry, outcome = .applied entry) := by
                simpa only [runAttempts, hattempt] using haccepted
              simp only [List.forall_cons] at htrace
              have happended := attempt_applied_version hattempt
              have hfinal := ih nextHistory htrace.2
              simp only [runAttempts, hattempt, List.map_cons]
              rw [hfinal, happended.2, List.append_assoc]
              simp
          | failed failure =>
              have htrace :
                  (Outcome.failed failure :: (runAttempts nextHistory writes).1).Forall
                    (fun outcome ↦ ∃ entry, outcome = .applied entry) := by
                simpa only [runAttempts, hattempt] using haccepted
              simp only [List.forall_cons] at htrace
              obtain ⟨entry, hentry⟩ := htrace.1
              cases hentry

private theorem wellFormed_head_lt_getElem? [LinearOrder Time]
    {first : Event Value Time} {rest : History Value Time} {index : Nat}
    {event : Event Value Time} (hwf : WellFormed (first :: rest))
    (hget : rest[index]? = some event) : first.writtenAt < event.writtenAt := by
  induction rest generalizing first index with
  | nil => simp at hget
  | cons second rest ih =>
      have hpair : first.writtenAt < second.writtenAt := by
        simpa only [WellFormed] using hwf.left
      cases index with
      | zero =>
          simp at hget
          subst second
          exact hpair
      | succ index =>
          have htail := wellFormed_tail hwf
          have hnext : second.writtenAt < event.writtenAt := by
            apply ih htail
            simpa using hget
          exact lt_trans hpair hnext

private theorem takeWhile_writtenAt_getElem?_spec [LinearOrder Time]
    {history : History Value Time} {index : Nat} {event : Event Value Time}
    (hwf : WellFormed history) (hget : history[index]? = some event) :
    let selected := history.takeWhile fun item ↦ item.writtenAt ≤ event.writtenAt
    selected.getLast? = some event ∧ selected.length = index + 1 := by
  induction index generalizing history with
  | zero =>
      cases history with
      | nil => simp at hget
      | cons first rest =>
          simp at hget
          subst first
          cases rest with
          | nil => simp
          | cons second rest =>
              have hpair : event.writtenAt < second.writtenAt := by
                simpa only [WellFormed] using hwf.left
              simp [not_le_of_gt hpair]
  | succ index ih =>
      cases history with
      | nil => simp at hget
      | cons first rest =>
          have htail := wellFormed_tail hwf
          have hgetTail : rest[index]? = some event := by
            simpa using hget
          have hfirst : first.writtenAt ≤ event.writtenAt :=
            (wellFormed_head_lt_getElem? hwf hgetTail).le
          have hspec := ih htail hgetTail
          cases hselected : rest.takeWhile (fun item ↦ item.writtenAt ≤ event.writtenAt) with
          | nil => simp [hselected] at hspec
          | cons selected selections =>
              simp [hfirst, hselected] at hspec ⊢
              exact hspec

/-- An in-bounds one-based version and its selected timestamp address the same entry. -/
theorem dual_address_agrees [LinearOrder Time] (history : History Value Time)
    (version : Version) (hwf : WellFormed history) (hpositive : 0 < version)
    (hbound : version ≤ history.length) :
    (getAtVersion history version).bind (fun entry ↦ getAtTime history entry.writtenAt) =
      getAtVersion history version := by
  have hindex : version - 1 < history.length :=
    lt_of_lt_of_le (Nat.sub_lt hpositive (by decide)) hbound
  rw [getAtVersion_eq_index history version (Nat.ne_of_gt hpositive)]
  rw [List.getElem?_eq_getElem hindex]
  simp only [Option.map_some, Option.bind_some]
  let event := history[version - 1]'hindex
  have hget : history[version - 1]? = some event := by
    exact List.getElem?_eq_getElem hindex
  have hspec := takeWhile_writtenAt_getElem?_spec hwf hget
  have hlength :
      (history.takeWhile fun item ↦ item.writtenAt ≤ event.writtenAt).length = version := by
    rw [hspec.2]
    exact Nat.sub_add_cancel (Nat.one_le_iff_ne_zero.mpr (Nat.ne_of_gt hpositive))
  rw [getAtTime_eq_last_prefix history event.writtenAt hwf]
  rw [hspec.1, hlength]
  rfl

end UmbraDBFormal.TemporalKV
