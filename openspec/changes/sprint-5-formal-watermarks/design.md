# Design — Sprint 5: Lean M3a Watermarks W1

This design formalizes the deliberately non-event-sourced last-write-wins contract in
`Formal/STORAGE_ALGEBRA.md` §3 and the Watermarks carrier summary in
`Formal/STORAGE_TYPES.md` “Watermarks”. The exact `(kind, key)` address agrees with the runtime
table key in `design/design.md` §4 and the public interface in `design/design-interfaces.md` §3.4.
The milestone and proof ordering follow `Formal/STORAGE_ALGEBRA_LEAN_RESEARCH.md` §12 M3.

## 1. Executable carrier

```lean
structure Address (Kind Key : Type*) where
  kind : Kind
  key : Key
deriving DecidableEq, Repr

abbrev Store (Kind Key Value : Type*) := Address Kind Key → Option Value
```

`none` is the observable never-set state. The model is intentionally functional: it has no SQL
row identity, metadata, version, history, or transaction state.

## 2. Commands and interpretation

```lean
def empty : Store Kind Key Value
def get : Store Kind Key Value → Address Kind Key → Option Value
def set [DecidableEq Kind] [DecidableEq Key] :
  Store Kind Key Value → Address Kind Key → Value → Store Kind Key Value

structure SetCommand (Kind Key Value : Type*) where
  address : Address Kind Key
  value : Value

def lastMatching [DecidableEq Kind] [DecidableEq Key] :
  Address Kind Key → List (SetCommand Kind Key Value) → Option Value

def runSets [DecidableEq Kind] [DecidableEq Key] :
  Store Kind Key Value → List (SetCommand Kind Key Value) → Store Kind Key Value
```

`set store address value` is `Function.update store address (some value)`. `runSets` evaluates
commands from left to right. Executability requires decidable equality for both address
components; no global classical instance is introduced.

Define the store-independent `lastMatching` observer directly as the value projection of
`getLast?` on the commands filtered to the queried address. It returns the value from the final
matching command or `none`. The trace theorem relates `get (runSets store commands) address` to
`some` of `lastMatching` when present and to the initial `get` otherwise. Export a theorem stating
the literal filtered-`getLast?` characterization even if it unfolds definitionally, so callers do
not have to treat another execution fold as evidence for the final-command claim. This prevents
W1 from collapsing to only a pointwise `Function.update_idem` theorem.

## 3. Laws

Point laws establish empty lookup, same-address overwrite, distinct-address framing,
same-address last-write-wins/idempotence, and distinct-address commutation. Trace laws establish
append composition, the independent observer's final-matching-command characterization, lookup
with initial fallback, and an unchanged-address frame theorem.

The commutation law requires distinct complete addresses, not merely distinct keys. The trace
observer compares complete addresses for the same reason.

## 4. Trust and reachability

Production modules enter `UmbraDBFormal.lean`; contract tests enter `UmbraDBFormalTest.Trust`.
The default Lake build must therefore elaborate every new declaration before the trust audit.
No `sorry`, `admit`, custom axiom, or `unsafe` declaration is permitted.

`Watermarks.Model` imports only the necessary core/mathlib modules. `Watermarks.Laws` imports
`Watermarks.Model` directly. Neither module imports `UmbraDBFormal.APISmoke`, making the domain
proof mechanically independent of the earlier update smoke check.

## 5. Refinement boundary

The model proves abstract W1 only. Its intended future observation relation maps abstract
`Address kind key` to the runtime `(kind, key)`, abstract `none` to runtime `undefined`, and
abstract `some value` only to a successfully validated, losslessly representable runtime value.
Runtime top-level JSON `null` lies outside that refinement domain, and `updated_at` is erased.
PostgreSQL `ON CONFLICT`, transaction participation, JSONB round-tripping, HOT eligibility, error
translation, cancellation, and concurrency remain runtime evidence and future refinement
obligations. Monotonic progress is deliberately not a law: later sets may contain any value.

This boundary preserves the unconditional `set` operation in `design/design-interfaces.md` §3.4
without claiming that the abstract function implements the SQL upsert in `design/design.md` §4.
It also keeps W1 exactly at the algebraic level specified in `Formal/STORAGE_ALGEBRA.md` §3.
