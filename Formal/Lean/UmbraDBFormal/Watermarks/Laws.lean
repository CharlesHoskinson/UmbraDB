import UmbraDBFormal.Watermarks.Model

/-!
# Watermarks laws

Point and finite-trace laws for the abstract last-write-wins Watermarks store.
-/

namespace UmbraDBFormal.Watermarks

@[simp] theorem get_empty (address : Address Kind Key) :
    get (empty : Store Kind Key Value) address = none :=
  rfl

@[simp] theorem get_set_same [DecidableEq Kind] [DecidableEq Key]
    (store : Store Kind Key Value) (address : Address Kind Key) (value : Value) :
    get (set store address value) address = some value := by
  simp [get, set]

theorem get_set_of_ne [DecidableEq Kind] [DecidableEq Key]
    (store : Store Kind Key Value) (updated queried : Address Kind Key) (value : Value)
    (h : queried ≠ updated) :
    get (set store updated value) queried = get store queried := by
  simp [get, set, h]

/-- A second value at one address replaces the first value. -/
theorem set_set_same [DecidableEq Kind] [DecidableEq Key]
    (store : Store Kind Key Value) (address : Address Kind Key) (first second : Value) :
    set (set store address first) address second = set store address second := by
  exact Function.update_idem (a := address) (some first) (some second) store

/-- Repeating exactly the same set command is state-idempotent. -/
theorem set_idempotent [DecidableEq Kind] [DecidableEq Key]
    (store : Store Kind Key Value) (address : Address Kind Key) (value : Value) :
    set (set store address value) address value = set store address value :=
  set_set_same store address value value

/-- Updates at distinct complete `(kind, key)` addresses commute. -/
theorem set_comm_of_ne [DecidableEq Kind] [DecidableEq Key]
    (store : Store Kind Key Value) (left right : Address Kind Key)
    (leftValue rightValue : Value) (h : left ≠ right) :
    set (set store left leftValue) right rightValue =
      set (set store right rightValue) left leftValue := by
  exact Function.update_comm h (some leftValue) (some rightValue) store

/-- Concatenated command traces execute exactly as sequential traces. -/
theorem runSets_append [DecidableEq Kind] [DecidableEq Key]
    (store : Store Kind Key Value) (left right : List (SetCommand Kind Key Value)) :
    runSets store (left ++ right) = runSets (runSets store left) right := by
  simp [runSets, List.foldl_append]

/-- The exported literal characterization of the independent final-command observer. -/
theorem lastMatching_eq_filter_getLast? [DecidableEq Kind] [DecidableEq Key]
    (address : Address Kind Key) (commands : List (SetCommand Kind Key Value)) :
    lastMatching address commands =
      (commands.filter fun command ↦ command.address = address).getLast?.map
        fun command ↦ command.value :=
  rfl

private theorem lastMatching_cons [DecidableEq Kind] [DecidableEq Key]
    (address : Address Kind Key) (command : SetCommand Kind Key Value)
    (commands : List (SetCommand Kind Key Value)) :
    lastMatching address (command :: commands) =
      match lastMatching address commands with
      | some value => some value
      | none => if command.address = address then some command.value else none := by
  unfold lastMatching
  simp only [List.filter_cons]
  split
  · rename_i hmatch
    simp only [decide_eq_true_eq] at hmatch
    cases hfiltered : commands.filter (fun next ↦ next.address = address) with
    | nil => simp [hmatch]
    | cons next rest =>
        simp only [List.getLast?_cons, Option.map_some]
        simp
  · rename_i hmiss
    have hne : command.address ≠ address := by
      intro heq
      exact hmiss (by simp [heq])
    cases hlast :
        (commands.filter fun next ↦ next.address = address).getLast? with
    | none => simp [hne]
    | some next => simp

/-- Lookup after a trace returns its final matching value, or the initial lookup if untouched. -/
theorem get_runSets_eq_lastMatching [DecidableEq Kind] [DecidableEq Key]
    (store : Store Kind Key Value) (address : Address Kind Key)
    (commands : List (SetCommand Kind Key Value)) :
    get (runSets store commands) address =
      match lastMatching address commands with
      | some value => some value
      | none => get store address := by
  induction commands generalizing store with
  | nil => rfl
  | cons command commands ih =>
      change get (runSets (set store command.address command.value) commands) address = _
      rw [ih, lastMatching_cons]
      cases hlast : lastMatching address commands with
      | some value => rfl
      | none =>
          by_cases hmatch : command.address = address
          · simp [get, set, hmatch]
          · have hquery : address ≠ command.address := Ne.symm hmatch
            simp [get, set, hmatch, hquery]

private theorem lastMatching_eq_none_of_forall_ne [DecidableEq Kind] [DecidableEq Key]
    (address : Address Kind Key) (commands : List (SetCommand Kind Key Value))
    (h : ∀ command ∈ commands, command.address ≠ address) :
    lastMatching address commands = none := by
  induction commands with
  | nil => rfl
  | cons command commands ih =>
      rw [lastMatching_cons, ih]
      · simp [h command (by simp)]
      · intro next hmem
        exact h next (by simp [hmem])

/-- A trace that never targets an address preserves that address's initial lookup. -/
theorem runSets_frame [DecidableEq Kind] [DecidableEq Key]
    (store : Store Kind Key Value) (address : Address Kind Key)
    (commands : List (SetCommand Kind Key Value))
    (h : ∀ command ∈ commands, command.address ≠ address) :
    get (runSets store commands) address = get store address := by
  rw [get_runSets_eq_lastMatching, lastMatching_eq_none_of_forall_ne address commands h]

end UmbraDBFormal.Watermarks
