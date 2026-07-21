import UmbraDBFormal.TemporalKV.Laws
import UmbraDBFormal.TemporalKV.Retention.Model

/-!
# Temporal key-value retention laws

Classification, preservation, and transparency theorems for prefix retention.
-/

namespace UmbraDBFormal.TemporalKV.Retention

@[simp] theorem prunePrefix_zero (history : History Value Time) :
    prunePrefix history 0 = some (.complete history) := rfl

/-- Every successful pruning result exposes exactly the requested list suffix. -/
theorem prunePrefix_success_events {history : History Value Time} {prunedCount : Nat}
    {retained : RetainedHistory Value Time}
    (hprune : prunePrefix history prunedCount = some retained) :
    retained.events = history.drop prunedCount := by
  cases prunedCount with
  | zero =>
      simp only [prunePrefix] at hprune
      cases hprune
      rfl
  | succ count =>
      simp only [prunePrefix] at hprune
      cases hdrop : history.drop (count + 1) with
      | nil => simp [hdrop] at hprune
      | cons first rest =>
          simp only [hdrop, Option.some.injEq] at hprune
          cases hprune
          simp [RetainedHistory.events, RetainedSuffix.events]

/-- A successful positive pruning request always produces a structurally nonempty pruned state. -/
theorem prunePrefix_positive_is_pruned {history : History Value Time} {prunedCount : Nat}
    {retained : RetainedHistory Value Time} (hpositive : 0 < prunedCount)
    (hprune : prunePrefix history prunedCount = some retained) :
    ∃ suffix, retained = .pruned suffix := by
  cases prunedCount with
  | zero => simp at hpositive
  | succ count =>
      simp only [prunePrefix] at hprune
      cases hdrop : history.drop (count + 1) with
      | nil => simp [hdrop] at hprune
      | cons first rest =>
          simp only [hdrop, Option.some.injEq] at hprune
          exact ⟨_, hprune.symm⟩

/-- Prefix pruning cannot delete the live final event. -/
theorem prunePrefix_rejects_all (history : History Value Time) (prunedCount : Nat)
    (hbound : history.length ≤ prunedCount) (hpositive : 0 < prunedCount) :
    prunePrefix history prunedCount = none := by
  cases prunedCount with
  | zero => simp at hpositive
  | succ count =>
      simp only [prunePrefix]
      rw [List.drop_eq_nil_of_le hbound]

/-- Prefix pruning fails exactly when a positive request would remove the live event. -/
theorem prunePrefix_eq_none_iff (history : History Value Time) (prunedCount : Nat) :
    prunePrefix history prunedCount = none ↔
      0 < prunedCount ∧ history.length ≤ prunedCount := by
  cases prunedCount with
  | zero => simp [prunePrefix]
  | succ count =>
      simp only [prunePrefix]
      constructor
      · intro hnone
        cases hdrop : history.drop (count + 1) with
        | nil => exact ⟨Nat.succ_pos count, List.drop_eq_nil_iff.mp hdrop⟩
        | cons first rest => simp [hdrop] at hnone
      · rintro ⟨_, hbound⟩
        rw [List.drop_eq_nil_of_le hbound]

/-- Every positive in-range pruning request succeeds with a retained suffix. -/
theorem prunePrefix_exists_of_positive_lt {history : History Value Time} {prunedCount : Nat}
    (hpositive : 0 < prunedCount) (hbound : prunedCount < history.length) :
    ∃ suffix, prunePrefix history prunedCount = some (.pruned suffix) := by
  cases hprune : prunePrefix history prunedCount with
  | none =>
      have hfailure := (prunePrefix_eq_none_iff history prunedCount).mp hprune
      exact (Nat.not_lt_of_ge hfailure.2 hbound).elim
  | some retained =>
      obtain ⟨suffix, hretained⟩ := prunePrefix_positive_is_pruned hpositive hprune
      exact ⟨suffix, congrArg some hretained⟩

/-- Successful prefix pruning preserves timestamp well-formedness. -/
theorem prunePrefix_preserves_wellFormed [LinearOrder Time]
    {history : History Value Time} {prunedCount : Nat}
    {retained : RetainedHistory Value Time} (hwf : WellFormed history)
    (hprune : prunePrefix history prunedCount = some retained) :
    retained.wellFormed := by
  rw [RetainedHistory.wellFormed, prunePrefix_success_events hprune]
  exact wellFormed_drop history prunedCount hwf

/-- Complete time lookup is exactly M1 lookup with the result classification made explicit. -/
theorem lookupAtTime_complete_found_iff [LinearOrder Time]
    (history : History Value Time) (query : Time) (entry : VersionedEntry Value Time) :
    lookupAtTime (.complete history) query = .found entry ↔
      TemporalKV.getAtTime history query = some entry := by
  simp only [lookupAtTime]
  cases hlookup : TemporalKV.getAtTime history query <;>
    simp [HistoricalResult.ofOption]

theorem lookupAtTime_complete_absent_iff [LinearOrder Time]
    (history : History Value Time) (query : Time) :
    lookupAtTime (.complete history) query = .absent ↔
      TemporalKV.getAtTime history query = none := by
  simp only [lookupAtTime]
  cases hlookup : TemporalKV.getAtTime history query <;>
    simp [HistoricalResult.ofOption]

/-- Complete version lookup is exactly M1 exact-version lookup. -/
theorem lookupAtVersion_complete_found_iff
    (history : History Value Time) (version : PositiveVersion)
    (entry : VersionedEntry Value Time) :
    lookupAtVersion (.complete history) version = .found entry ↔
      TemporalKV.getAtVersion history version.1 = some entry := by
  simp only [lookupAtVersion]
  cases hlookup : TemporalKV.getAtVersion history version.1 <;>
    simp [HistoricalResult.ofOption]

theorem lookupAtVersion_complete_absent_iff
    (history : History Value Time) (version : PositiveVersion) :
    lookupAtVersion (.complete history) version = .absent ↔
      TemporalKV.getAtVersion history version.1 = none := by
  simp only [lookupAtVersion]
  cases hlookup : TemporalKV.getAtVersion history version.1 <;>
    simp [HistoricalResult.ofOption]

/-- A pruned time lookup is unavailable exactly below its derived timestamp floor. -/
theorem lookupAtTime_unavailable_iff [LinearOrder Time]
    (suffix : RetainedSuffix Value Time) (query : Time) :
    lookupAtTime (.pruned suffix) query = .unavailable suffix.floor ↔
      query < suffix.oldestAvailableAt := by
  simp only [lookupAtTime]
  split
  · simp_all
  · rename_i hfloor
    constructor
    · intro heq
      cases hlookup : TemporalKV.getAtTime suffix.events query <;>
        simp [HistoricalResult.ofOption, hlookup] at heq
    · exact fun hlt => (hfloor hlt).elim

/-- A pruned exact-version lookup is unavailable exactly below its derived version floor. -/
theorem lookupAtVersion_unavailable_iff
    (suffix : RetainedSuffix Value Time) (version : PositiveVersion) :
    lookupAtVersion (.pruned suffix) version = .unavailable suffix.floor ↔
      version.1 < suffix.oldestAvailableVersion := by
  simp only [lookupAtVersion]
  split
  · simp_all
  · rename_i hfloor
    constructor
    · intro heq
      cases hlookup : TemporalKV.getAtVersion suffix.events
          (version.1 - suffix.prunedCount.1) <;>
        simp [HistoricalResult.ofOption, hlookup] at heq
    · exact fun hlt => (hfloor hlt).elim

/-- Lookup at the retained timestamp floor returns the first event with its original version. -/
theorem lookupAtTime_floor [LinearOrder Time]
    (suffix : RetainedSuffix Value Time) (hwf : WellFormed suffix.events) :
    lookupAtTime (.pruned suffix) suffix.oldestAvailableAt =
      .found
        { value := suffix.first.value
          version := suffix.oldestAvailableVersion
          writtenAt := suffix.first.writtenAt } := by
  have hdual := dual_address_agrees suffix.events 1 hwf (by decide)
    (by simp [RetainedSuffix.events])
  have htime : TemporalKV.getAtTime suffix.events suffix.first.writtenAt =
      some (VersionedEntry.mk suffix.first.value 1 suffix.first.writtenAt) := by
    simpa [RetainedSuffix.events, TemporalKV.getAtVersion] using hdual
  simp [lookupAtTime, RetainedSuffix.oldestAvailableAt, htime,
    HistoricalResult.ofOption, shiftVersion, RetainedSuffix.oldestAvailableVersion]

/-- Exact version lookup at the retained floor returns the first retained event. -/
theorem lookupAtVersion_floor (suffix : RetainedSuffix Value Time) :
    lookupAtVersion (.pruned suffix)
        ⟨suffix.oldestAvailableVersion, by
          simp [RetainedSuffix.oldestAvailableVersion]⟩ =
      .found
        { value := suffix.first.value
          version := suffix.oldestAvailableVersion
          writtenAt := suffix.first.writtenAt } := by
  rcases suffix with ⟨⟨prunedCount, hpositive⟩, first, rest⟩
  simp [lookupAtVersion, RetainedSuffix.oldestAvailableVersion, RetainedSuffix.events,
    TemporalKV.getAtVersion, HistoricalResult.ofOption, shiftVersion]

/-- Rebasing an exact-version lookup on a dropped suffix preserves the original entry. -/
theorem getAtVersion_drop_shift (history : History Value Time) (prunedCount : Nat)
    (version : PositiveVersion) (havailable : prunedCount < version.1) :
    (TemporalKV.getAtVersion (history.drop prunedCount) (version.1 - prunedCount)).map
        (shiftVersion prunedCount) =
      TemporalKV.getAtVersion history version.1 := by
  have hlocal : version.1 - prunedCount ≠ 0 := Nat.sub_ne_zero_of_lt havailable
  rw [getAtVersion_eq_index _ _ hlocal]
  rw [getAtVersion_eq_index _ _ (Nat.ne_of_gt version.2)]
  rw [List.getElem?_drop]
  have hindex : prunedCount + (version.1 - prunedCount - 1) = version.1 - 1 := by
    omega
  rw [hindex]
  simp only [Option.map_map]
  cases history[version.1 - 1]? with
  | none => rfl
  | some event =>
      simp only [Option.map_some, Function.comp_apply, shiftVersion]
      congr
      exact Nat.add_sub_of_le (Nat.le_of_lt havailable)

/-- Successful pruning records exactly the requested positive pruned count. -/
theorem prunePrefix_success_prunedCount {history : History Value Time} {prunedCount : Nat}
    {suffix : RetainedSuffix Value Time}
    (hprune : prunePrefix history prunedCount = some (.pruned suffix)) :
    suffix.prunedCount.1 = prunedCount := by
  cases prunedCount with
  | zero => simp [prunePrefix] at hprune
  | succ count =>
      simp only [prunePrefix] at hprune
      cases hdrop : history.drop (count + 1) with
      | nil => simp [hdrop] at hprune
      | cons first rest =>
          simp only [hdrop, Option.some.injEq, RetainedHistory.pruned.injEq] at hprune
          cases hprune
          rfl

/-- Exact-version lookup after successful pruning agrees with M1 throughout the retained
version horizon, including versions beyond the live tail where both sides are absent. -/
theorem prunePrefix_lookupAtVersion_agrees
    {history : History Value Time} {prunedCount : Nat}
    {suffix : RetainedSuffix Value Time} (version : PositiveVersion)
    (hprune : prunePrefix history prunedCount = some (.pruned suffix))
    (havailable : suffix.oldestAvailableVersion ≤ version.1) :
    lookupAtVersion (.pruned suffix) version =
      .ofOption (TemporalKV.getAtVersion history version.1) := by
  have hcount := prunePrefix_success_prunedCount hprune
  have hevents : suffix.events = history.drop prunedCount :=
    prunePrefix_success_events hprune
  have hlt : prunedCount < version.1 := by
    have hfloor := havailable
    rw [RetainedSuffix.oldestAvailableVersion, hcount] at hfloor
    exact Nat.lt_of_succ_le (by simpa [Nat.succ_eq_add_one] using hfloor)
  simp only [lookupAtVersion, if_neg (not_lt_of_ge havailable)]
  rw [hcount, hevents, getAtVersion_drop_shift history prunedCount version hlt]

private theorem takeWhile_drop_eq_drop_takeWhile [LinearOrder Time]
    (history : History Value Time) (prunedCount : Nat)
    (first : Event Value Time) (rest : History Value Time)
    (hdrop : history.drop prunedCount = first :: rest)
    (hwf : WellFormed history) (havailable : first.writtenAt ≤ query) :
    (history.drop prunedCount).takeWhile (fun event ↦ event.writtenAt ≤ query) =
      (history.takeWhile fun event ↦ event.writtenAt ≤ query).drop prunedCount := by
  induction prunedCount generalizing history with
  | zero => simp
  | succ count ih =>
      cases history with
      | nil => simp at hdrop
      | cons head tail =>
          have htail : WellFormed tail := wellFormed_tail hwf
          have hdropTail : tail.drop count = first :: rest := by
            simpa using hdrop
          have hget : tail[count]? = some first := by
            rw [← List.head?_drop]
            simp [hdropTail]
          have hhead : head.writtenAt ≤ query :=
            (wellFormed_head_lt_getElem? hwf hget).le.trans havailable
          have hrec := ih tail hdropTail htail
          simpa [hhead] using hrec

/-- Time lookup on a dropped suffix, with versions rebased, agrees with M1 once the retained head
is within the query prefix. -/
theorem getAtTime_drop_shift [LinearOrder Time]
    (history : History Value Time) (prunedCount : Nat)
    (first : Event Value Time) (rest : History Value Time)
    (hdrop : history.drop prunedCount = first :: rest)
    (hwf : WellFormed history) (havailable : first.writtenAt ≤ query) :
    (TemporalKV.getAtTime (history.drop prunedCount) query).map
        (shiftVersion prunedCount) =
      TemporalKV.getAtTime history query := by
  rw [getAtTime_eq_last_prefix _ _ (wellFormed_drop history prunedCount hwf)]
  rw [getAtTime_eq_last_prefix _ _ hwf]
  let selected := history.takeWhile fun event ↦ event.writtenAt ≤ query
  have hselected :
      (history.drop prunedCount).takeWhile (fun event ↦ event.writtenAt ≤ query) =
        selected.drop prunedCount :=
    takeWhile_drop_eq_drop_takeWhile history prunedCount first rest hdrop hwf havailable
  have hnonempty : selected.drop prunedCount ≠ [] := by
    rw [← hselected, hdrop]
    simp [havailable]
  have hlength : prunedCount + (selected.drop prunedCount).length = selected.length := by
    rw [List.length_drop]
    have := List.length_lt_of_drop_ne_nil hnonempty
    omega
  have hlast : selected.getLast? = (selected.drop prunedCount).getLast? := by
    conv_lhs => rw [← selected.take_append_drop prunedCount]
    exact List.getLast?_append_of_ne_nil _ hnonempty
  rw [hselected, hlast]
  cases hlastOption : (selected.drop prunedCount).getLast? with
  | none => rfl
  | some event =>
      simp only [Option.map_some, shiftVersion]
      rw [hlength]

/-- The main retention-aware T3 theorem: above the certified timestamp floor, successful prefix
pruning is observationally transparent to M1 and preserves original versions. -/
theorem prunePrefix_lookupAtTime_agrees [LinearOrder Time]
    {history : History Value Time} {prunedCount : Nat}
    {suffix : RetainedSuffix Value Time} (query : Time)
    (hwf : WellFormed history)
    (hprune : prunePrefix history prunedCount = some (.pruned suffix))
    (havailable : suffix.oldestAvailableAt ≤ query) :
    lookupAtTime (.pruned suffix) query =
      .ofOption (TemporalKV.getAtTime history query) := by
  have hcount := prunePrefix_success_prunedCount hprune
  have hevents : suffix.events = history.drop prunedCount :=
    prunePrefix_success_events hprune
  have hdrop : history.drop prunedCount = suffix.first :: suffix.rest := by
    simpa [RetainedSuffix.events] using hevents.symm
  simp only [lookupAtTime, if_neg (not_lt_of_ge havailable)]
  rw [hcount, hevents]
  rw [getAtTime_drop_shift history prunedCount suffix.first suffix.rest hdrop hwf havailable]

/-- Successful positive pruning preserves the original live final event. -/
theorem prunePrefix_preserves_live
    {history : History Value Time} {prunedCount : Nat}
    {suffix : RetainedSuffix Value Time}
    (hprune : prunePrefix history prunedCount = some (.pruned suffix)) :
    suffix.events.getLast? = history.getLast? := by
  have hevents : suffix.events = history.drop prunedCount :=
    prunePrefix_success_events hprune
  rw [hevents, List.getLast?_drop]
  apply if_neg
  intro hbound
  have hempty : history.drop prunedCount = [] := List.drop_eq_nil_of_le hbound
  have hevents : suffix.events = history.drop prunedCount :=
    prunePrefix_success_events hprune
  rw [← hevents] at hempty
  simp [RetainedSuffix.events] at hempty

/-- Once a time query reaches the retained floor, a nonempty well-formed suffix always has a
selected event; ordinary absence is impossible. -/
theorem lookupAtTime_pruned_ne_absent [LinearOrder Time]
    (suffix : RetainedSuffix Value Time) (query : Time)
    (hwf : WellFormed suffix.events)
    (havailable : suffix.oldestAvailableAt ≤ query) :
    lookupAtTime (.pruned suffix) query ≠ .absent := by
  simp only [lookupAtTime, if_neg (not_lt_of_ge havailable)]
  have hfirst : suffix.first.writtenAt ≤ query := by
    simpa [RetainedSuffix.oldestAvailableAt] using havailable
  have hprefix :
      (suffix.events.takeWhile fun event ↦ event.writtenAt ≤ query) ≠ [] := by
    simp [RetainedSuffix.events, hfirst]
  have hnotnone : TemporalKV.getAtTime suffix.events query ≠ none := by
    rw [getAtTime_eq_last_prefix suffix.events query hwf]
    simpa using hprefix
  cases hlookup : TemporalKV.getAtTime suffix.events query with
  | none => exact (hnotnone hlookup).elim
  | some entry => simp [HistoricalResult.ofOption]

private theorem getAtVersion_some_version {history : History Value Time}
    {version : Version} {entry : VersionedEntry Value Time}
    (hlookup : TemporalKV.getAtVersion history version = some entry) :
    entry.version = version := by
  have hpositive : version ≠ 0 := by
    intro hzero
    subst version
    simp [TemporalKV.getAtVersion] at hlookup
  rw [getAtVersion_eq_index history version hpositive] at hlookup
  cases hget : history[version - 1]? with
  | none => simp [hget] at hlookup
  | some event =>
      simp [hget] at hlookup
      cases hlookup
      rfl

/-- Every successful exact-version result reports the original queried version, never a local
suffix index. -/
theorem lookupAtVersion_pruned_found_version
    (suffix : RetainedSuffix Value Time) (version : PositiveVersion)
    (entry : VersionedEntry Value Time)
    (hfound : lookupAtVersion (.pruned suffix) version = .found entry) :
    entry.version = version.1 := by
  have havailable : suffix.oldestAvailableVersion ≤ version.1 := by
    by_contra hfloor
    have hlt : version.1 < suffix.oldestAvailableVersion := lt_of_not_ge hfloor
    rw [(lookupAtVersion_unavailable_iff suffix version).2 hlt] at hfound
    simp at hfound
  simp only [lookupAtVersion, if_neg (not_lt_of_ge havailable)] at hfound
  cases hlookup : TemporalKV.getAtVersion suffix.events
      (version.1 - suffix.prunedCount.1) with
  | none => simp [hlookup, HistoricalResult.ofOption] at hfound
  | some localEntry =>
      simp [hlookup, HistoricalResult.ofOption] at hfound
      subst entry
      change suffix.prunedCount.1 + localEntry.version = version.1
      rw [getAtVersion_some_version hlookup]
      have hlt : suffix.prunedCount.1 < version.1 := by
        apply Nat.lt_of_succ_le
        simpa [RetainedSuffix.oldestAvailableVersion, Nat.succ_eq_add_one] using havailable
      exact Nat.add_sub_of_le (Nat.le_of_lt hlt)

private theorem getAtVersion_none_of_length_lt (history : History Value Time)
    (version : Version) (hpositive : 0 < version) (hbound : history.length < version) :
    TemporalKV.getAtVersion history version = none := by
  rw [getAtVersion_eq_index history version (Nat.ne_of_gt hpositive)]
  rw [List.getElem?_eq_none (Nat.le_sub_one_of_lt hbound)]
  rfl

/-- An exact version beyond the retained live version is absent, not unavailable. -/
theorem lookupAtVersion_pruned_above_absent
    (suffix : RetainedSuffix Value Time) (version : PositiveVersion)
    (hbound : suffix.prunedCount.1 + suffix.events.length < version.1) :
    lookupAtVersion (.pruned suffix) version = .absent := by
  have hpv : suffix.prunedCount.1 < version.1 :=
    (Nat.le_add_right suffix.prunedCount.1 suffix.events.length).trans_lt hbound
  have havailable : suffix.oldestAvailableVersion ≤ version.1 := by
    simpa [RetainedSuffix.oldestAvailableVersion, Nat.succ_eq_add_one] using
      Nat.succ_le_of_lt hpv
  have hlocalPositive : 0 < version.1 - suffix.prunedCount.1 :=
    Nat.sub_pos_of_lt hpv
  have hlocalBound : suffix.events.length < version.1 - suffix.prunedCount.1 :=
    Nat.lt_sub_of_add_lt (by simpa [Nat.add_comm] using hbound)
  simp only [lookupAtVersion, if_neg (not_lt_of_ge havailable)]
  rw [getAtVersion_none_of_length_lt suffix.events
    (version.1 - suffix.prunedCount.1) hlocalPositive hlocalBound]
  rfl

end UmbraDBFormal.TemporalKV.Retention
