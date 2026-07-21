import Mathlib.Data.List.Basic
import Mathlib.Logic.Function.Basic

/-!
# Executable Watermarks model

A Watermarks address is the complete `(kind, key)` pair. The pure store exposes only absence or
the last value written at that address; runtime metadata and PostgreSQL behavior are outside this
model.
-/

namespace UmbraDBFormal.Watermarks

structure Address (Kind Key : Type*) where
  kind : Kind
  key : Key
deriving DecidableEq, Repr

abbrev Store (Kind Key Value : Type*) := Address Kind Key → Option Value

def empty : Store Kind Key Value := fun _ ↦ none

def get (store : Store Kind Key Value) (address : Address Kind Key) : Option Value :=
  store address

def set [DecidableEq Kind] [DecidableEq Key] (store : Store Kind Key Value)
    (address : Address Kind Key) (value : Value) : Store Kind Key Value :=
  Function.update store address (some value)

structure SetCommand (Kind Key Value : Type*) where
  address : Address Kind Key
  value : Value
deriving DecidableEq, Repr

def runSets [DecidableEq Kind] [DecidableEq Key] (store : Store Kind Key Value)
    (commands : List (SetCommand Kind Key Value)) : Store Kind Key Value :=
  commands.foldl (fun state command ↦ set state command.address command.value) store

/-- The value from the final command targeting `address`, independent of any initial store. -/
def lastMatching [DecidableEq Kind] [DecidableEq Key] (address : Address Kind Key)
    (commands : List (SetCommand Kind Key Value)) : Option Value :=
  (commands.filter fun command ↦ command.address = address).getLast?.map
    fun command ↦ command.value

end UmbraDBFormal.Watermarks
