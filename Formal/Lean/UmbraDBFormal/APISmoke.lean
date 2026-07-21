import Mathlib.Data.Finset.Lattice.Basic
import Mathlib.Order.Interval.Set.Disjoint

namespace UmbraDBFormal.APISmoke

theorem watermark_overwrite [DecidableEq Key] (store : Key → Value) (key : Key)
    (first second : Value) :
    Function.update (Function.update store key first) key second =
      Function.update store key second := by
  funext query
  by_cases h : query = key <;> simp [h]

theorem checkpoint_union_comm [DecidableEq Hash] (left right : Finset Hash) :
    left ∪ right = right ∪ left := Finset.union_comm left right

theorem checkpoint_union_assoc [DecidableEq Hash] (a b c : Finset Hash) :
    a ∪ b ∪ c = a ∪ (b ∪ c) := Finset.union_assoc a b c

theorem checkpoint_union_idem [DecidableEq Hash] (chunks : Finset Hash) :
    chunks ∪ chunks = chunks := Finset.union_idempotent chunks

theorem adjacent_Ico_disjoint [Preorder Time] (start middle finish : Time) :
    Disjoint (Set.Ico start middle) (Set.Ico middle finish) := by
  exact Set.Ico_disjoint_Ico_same

end UmbraDBFormal.APISmoke
