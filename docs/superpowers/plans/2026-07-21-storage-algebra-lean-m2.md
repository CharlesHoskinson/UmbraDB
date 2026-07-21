# Storage Algebra Lean M2 Planning Sprint

**Goal:** Extend the completed M1 TemporalKV kernel with a faithful T5 validity-chain projection,
then stage retention-aware T3 and executable oracle work behind explicit semantic gates.

**Architecture:** The existing history remains the source of truth. M2 first derives a list of
validity intervals from that history: every non-final event owns a bounded half-open interval and
the final event owns the live half-infinite interval. Laws prove coherence from `WellFormed`; they
do not assume PostgreSQL constraints or trigger behavior. Retention is added later in a separate
module so the total M1 lookup functions and their established theorem contracts remain unchanged.

**Toolchain:** Lean 4.32.0, mathlib v4.32.0, Lake 5, the existing source/axiom trust audits, and
the bundled `leanchecker` CI gate.

## Planning decisions

- Preserve every M1 definition and theorem signature.
- Model the live row explicitly. A nonempty history projects to bounded `[from, to)` intervals
  followed by one live `[from, ∞)` interval; an empty history projects to no intervals.
- Represent an open-ended interval with `validTo : Option Time`, not a synthetic maximum time.
- Define gap-freedom as adjacency of consecutive projected intervals. It is distinct from
  pairwise disjointness and receives a separate theorem.
- Derive both T5 properties only from the abstract history and `WellFormed`. PostgreSQL exclusion
  constraints and trigger discipline remain named refinement obligations, not proof premises.
- Do not add retention fields to `History`. A later `Retention` module will distinguish complete
  history, nonempty retained history with a positive version offset, and never-written state.
- Do not claim store-level T3 until keyed lookup and retention-floor outcomes are modeled.
- Keep all new source in the default build and under the existing no-placeholder and axiom audits.
- Defer Graphify until M2 is declared complete or merged, consistent with repository policy.

## Task 1: Add the executable T5 validity projection

**Files:**

- Modify: `Formal/Lean/UmbraDBFormal/TemporalKV/Model.lean`
- Modify: `Formal/Lean/UmbraDBFormalTest/TemporalKV/Model.lean`

Add the following public model surface:

```lean
structure ValidityInterval (Time : Type*) where
  validFrom : Time
  validTo : Option Time

def ValidityInterval.asSet [Preorder Time] (interval : ValidityInterval Time) : Set Time

def validityIntervals : History Value Time → List (ValidityInterval Time)
```

The projection equations are:

- `[]` maps to `[]`;
- `[last]` maps to `[{ validFrom := last.writtenAt, validTo := none }]`;
- `first :: second :: rest` emits
  `{ validFrom := first.writtenAt, validTo := some second.writtenAt }` and recurses from `second`.

Add executable contract examples for empty, singleton, and three-event histories. The three-event
case must demonstrate two bounded intervals and the live tail in order.

## Task 2: Prove the two deferred T5 laws

**Files:**

- Modify: `Formal/Lean/UmbraDBFormal/TemporalKV/Laws.lean`
- Modify: `Formal/Lean/UmbraDBFormalTest/TemporalKV/Laws.lean`

Prove these public theorems without placeholders:

```lean
theorem adjacent_intervals_gap_free (history : History Value Time) :
    (validityIntervals history).IsChain
      (fun left right ↦ left.validTo = some right.validFrom)

theorem intervals_pairwise_disjoint [LinearOrder Time]
    (history : History Value Time) (hwf : WellFormed history) :
    (validityIntervals history).Pairwise
      (fun left right ↦ Disjoint left.asSet right.asSet)
```

The gap-free theorem is structural and needs no ordering hypothesis. Pairwise disjointness uses
`WellFormed` to show that every later interval starts at or after the first interval's upper
boundary. Its proof must cover the live `Set.Ici` tail as well as bounded `Set.Ico` intervals.

Add concrete three-event contract examples for both theorems. Also include a boundary-membership
example showing that the shared endpoint belongs to the later interval and not the earlier one.

## Task 3: Close and document the T5 tranche

**Files:**

- Modify: `README.md`
- Modify: `Formal/STORAGE_ALGEBRA_LEAN_RESEARCH.md`

Update status prose narrowly:

- T5 interval projection, pairwise disjointness, and structural gap-freedom are kernel checked for
  the abstract per-key model.
- Database exclusion constraints, trigger-only writes, the current/history SQL split, and
  concurrent transaction behavior remain external refinement obligations.
- Retention-aware T3 remains deferred.

Run the full trust/build/test matrix before committing this tranche.

## Task 4: Specify retention before proving retention-aware T3

**Files:**

- Create: `Formal/Lean/UmbraDBFormal/TemporalKV/Retention.lean`
- Create: `Formal/Lean/UmbraDBFormalTest/TemporalKV/Retention.lean`
- Modify root imports only after the module compiles independently.

This task begins with a semantic review gate. The design must distinguish:

1. a never-written key, which may return `absent` for every query;
2. a complete, possibly empty history, whose first stored version is one;
3. a nonempty retained suffix with a positive original-version offset and an explicit oldest
   available timestamp;
4. a query older than the retained floor, which returns `unavailable floor` rather than `absent`.

Do not encode the floor as an arbitrary value alongside an empty retained list. Use an inductive
state or a nonempty subtype so invalid floor/history combinations are unrepresentable. Preserve
one-based original versions when looking up retained events.

Required theorem families after the representation is approved:

- unavailable-before-floor characterization;
- retained version-offset lookup characterization;
- found/absent agreement with M1 on complete histories;
- retention preserves strict timestamp ordering;
- lookup at the floor returns the first retained event.

## Task 5: Lift temporal selection to a keyed store

Introduce a pointwise store only after Task 4 is stable. A keyed theorem must reduce lookup for one
key to that key's retained history and prove the full T3 result:

- before a retained floor: `unavailable`;
- within the available window: the last retained event at or before the query;
- no selected event in a complete history: `absent`.

The theorem must not mention PostgreSQL rows, transaction visibility, or pruning schedules. Those
belong to a later refinement layer.

## Task 6: Produce an executable oracle boundary

Define a compact serializable vector format only after the retention outcomes are fixed. Generate
vectors covering empty histories, exact timestamps, between-event queries, the live tail,
retention-floor equality, unavailable-before-floor, and original version offsets. TypeScript tests
may consume generated vectors, but generated data must not become a new trusted proof input.

## Verification matrix

Run from the indicated project roots:

```text
cd Formal/Lean
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/check-trust.ps1
lake env lean UmbraDBFormalTest/TemporalKV/Model.lean
lake env lean UmbraDBFormalTest/TemporalKV/Laws.lean
lake env leanchecker

cd ../..
npm run typecheck
npm run docs:storage:check
npm test
actionlint .github/workflows/lean.yml
git diff --check
```

Expected: every command exits zero, no new warning is emitted, and Git status contains only the
intended M2 plan, Lean model/law/test changes, and narrow status documentation.

## Planning sprint self-review

- **Semantic fidelity:** The projection includes the live current interval and uses half-open
  boundaries, matching T5 rather than proving only an easier historical subset.
- **Law separation:** Non-overlap and gap-freedom remain independent claims with distinct proof
  dependencies.
- **Trust boundary:** Theorems concern the executable abstract history only; SQL enforcement is
  not smuggled in as an axiom.
- **Backward compatibility:** M1 carriers, transitions, lookups, and theorem statements remain
  unchanged.
- **Retention safety:** The plan prohibits an empty retained suffix with a fabricated floor and
  preserves original one-based versions through an explicit offset.
- **Scope control:** The first implementation tranche is Tasks 1–3. Retention, keyed T3, and test
  vector generation remain planned work with a representation review gate.
