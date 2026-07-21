# Storage Algebra Lean M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved no-`sorry` M1 TemporalKV formalization: a pinned Lean project,
an executable history-first kernel, its first preservation/CAS/lookup/T4 theorems, and CI trust
checks.

**Architecture:** `TemporalKV.Model` owns executable definitions and contains no theorem-specific
machinery. `TemporalKV.Laws` derives the M1 laws from those definitions. Compiler-only smoke files
exercise the pinned mathlib APIs, while CI independently builds the project, rejects placeholders
and custom axioms, and runs an external no-`sorry` type check.

**Tech Stack:** Lean 4.32.0, mathlib v4.32.0, Lake 5, GitHub Actions,
`leanprover/lean-action@v1`, nanoda.

**Graphify policy:** Refresh the repository graph only after a major lifecycle event, such as a
declared sprint completion or a merge to `main`. Graphify is not a per-task implementation or
review gate.

## Global Constraints

- Preserve theorem statements, signatures, and docstrings once introduced; any semantic change
  requires architect approval.
- Versions are one-based positions in the accepted-event history; zero is never stored.
- `Expectation` has exactly `unconditional`, `absent`, and `at version` cases.
- `attempt` checks CAS first, then strict clock monotonicity, and appends exactly one event only on
  success.
- Failed CAS and failed clock checks return the unchanged history.
- `runAttempts` continues after failures; `runTransaction` stops on the first failure and exposes
  no partially updated history.
- Time is an abstract linear order and means recorded `writtenAt`, not transaction commit time.
- No `sorry`, `admit`, `axiom`, `unsafe`, hidden global assumption, retention model, SQL semantics,
  keyed transaction guard, or lease/GC claim enters M1.
- Only `propext`, `Classical.choice`, and `Quot.sound` are permitted transitive axioms.
- Lean source lines use mathlib's 100-character convention.
- Do not delete, rename, or rewrite unrelated TypeScript, SQL, design, or graph files.
- The existing approval edit in `Formal/STORAGE_ALGEBRA_LEAN_RESEARCH.md` is preserved.

---

### Task 1: Pin the project and prove the imported API smoke slice

**Files:**
- Create: `Formal/Lean/lean-toolchain`
- Create: `Formal/Lean/lakefile.lean`
- Create: `Formal/Lean/UmbraDBFormal.lean`
- Create: `Formal/Lean/UmbraDBFormal/APISmoke.lean`
- Create: `Formal/Lean/UmbraDBFormalTest/APISmoke.lean`
- Generate: `Formal/Lean/lake-manifest.json`

**Interfaces:**
- Consumes: the approved toolchain and API list in
  `Formal/STORAGE_ALGEBRA_LEAN_RESEARCH.md` §§6–6.1.
- Produces: Lake library `UmbraDBFormal`; declarations
  `watermark_overwrite`, `checkpoint_union_comm`, `checkpoint_union_assoc`,
  `checkpoint_union_idem`, and `adjacent_Ico_disjoint`.

- [ ] **Step 1: Add the pinned Lake scaffold and a smoke test that imports a missing module**

`Formal/Lean/lean-toolchain` contains exactly:

```text
leanprover/lean4:v4.32.0
```

`Formal/Lean/lakefile.lean` contains:

```lean
import Lake
open Lake DSL

package "umbradb-formal" where
  version := v!"0.1.0"

require mathlib from git
  "https://github.com/leanprover-community/mathlib4.git" @ "v4.32.0"

@[default_target]
lean_lib UmbraDBFormal
```

`Formal/Lean/UmbraDBFormalTest/APISmoke.lean` starts with:

```lean
import UmbraDBFormal.APISmoke
```

- [ ] **Step 2: Verify the smoke test is red for the intended reason**

Run from `Formal/Lean`:

```powershell
lake update
lake env lean UmbraDBFormalTest/APISmoke.lean
```

Expected: dependency resolution succeeds, then Lean fails because
`UmbraDBFormal.APISmoke` does not exist.

- [ ] **Step 3: Add the smallest API smoke module**

Implement `UmbraDBFormal/APISmoke.lean` with the following declarations, using the cited mathlib
lemmas directly rather than reproving library facts:

```lean
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

theorem adjacent_Ico_disjoint [Preorder Time] (start middle finish : Time)
    (h₁ : start ≤ middle) (h₂ : middle ≤ finish) :
    Disjoint (Set.Ico start middle) (Set.Ico middle finish) := by
  exact Set.Ico_disjoint_Ico_same

end UmbraDBFormal.APISmoke
```

The implementer SHALL search the pinned mathlib source before adjusting any signature whose cited
name differs at compile time. The implementer SHALL keep the semantic statement unchanged.

- [ ] **Step 4: Make the smoke file and root import green**

Add `import UmbraDBFormal.APISmoke` to `UmbraDBFormal.lean`, then run:

```powershell
lake env lean UmbraDBFormalTest/APISmoke.lean
lake build
```

Expected: both commands exit 0 with no warnings.

---

### Task 2: Implement the executable TemporalKV history kernel

**Files:**
- Create: `Formal/Lean/UmbraDBFormal/TemporalKV/Model.lean`
- Create: `Formal/Lean/UmbraDBFormalTest/TemporalKV/Model.lean`
- Modify: `Formal/Lean/UmbraDBFormal.lean`

**Interfaces:**
- Consumes: `Nat`-indexed one-based versions, an abstract linearly ordered `Time`, and arbitrary
  `Value`.
- Produces: `Event`, `VersionedEntry`, `Expectation`, `Write`, `Failure`, `Outcome`, `History`,
  `WellFormed`, `snapshotVersion`, `expectationMatches`, `current`, `getAtVersion`, `getAtTime`,
  `attempt`, `runAttempts`, and `runTransaction` in namespace `UmbraDBFormal.TemporalKV`.

- [ ] **Step 1: Write compiler tests against the intended public API**

Create `UmbraDBFormalTest/TemporalKV/Model.lean` importing the missing model and include examples
that normalize these cases with `rfl` or `decide`:

```lean
open UmbraDBFormal.TemporalKV

example : snapshotVersion ([] : History Nat Nat) = none := rfl

example : expectationMatches ([] : History Nat Nat) .absent = true := rfl

example : expectationMatches ([] : History Nat Nat) (.at 0) = false := rfl

example :
    attempt ([] : History Nat Nat) { value := 7, writtenAt := 10,
      expectation := .absent } =
      (.applied { value := 7, version := 1, writtenAt := 10 },
        [{ value := 7, writtenAt := 10 }]) := rfl

example :
    (attempt ([{ value := 7, writtenAt := 10 }] : History Nat Nat)
      { value := 8, writtenAt := 11, expectation := .absent }).2 =
      [{ value := 7, writtenAt := 10 }] := rfl

example :
    (attempt ([{ value := 7, writtenAt := 10 }] : History Nat Nat)
      { value := 8, writtenAt := 10, expectation := .unconditional }).2 =
      [{ value := 7, writtenAt := 10 }] := rfl
```

- [ ] **Step 2: Verify the model test is red for the missing module/API**

Run from `Formal/Lean`:

```powershell
lake env lean UmbraDBFormalTest/TemporalKV/Model.lean
```

Expected: Lean fails on the missing `UmbraDBFormal.TemporalKV.Model` import or declarations.

- [ ] **Step 3: Implement the data model and single-write transition**

Use these exact public shapes in `TemporalKV/Model.lean`:

```lean
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
```

`WellFormed` SHALL mean strict timestamp ordering between every adjacent pair. Define a small
project-local adjacent predicate rather than relying on a missing `List.Chain'` name.
`expectationMatches` SHALL be executable and SHALL reject `.at 0` even for empty history.
`attempt` SHALL return `Outcome × History` and SHALL implement the global precedence rules exactly.

- [ ] **Step 4: Implement projections and runners without retention semantics**

`getAtVersion` SHALL map one-based version `v` to list index `v - 1` and return `none` for `v = 0`.
`getAtTime` SHALL return the last versioned entry whose `writtenAt ≤ query`, using chronological
order rather than a commutative fold. `runAttempts` SHALL collect all outcomes in input order and
continue after failures. `runTransaction` SHALL return `Except (Failure Time) (History Value Time)`,
stop at the first failed attempt, and never expose an intermediate history on the error branch.

- [ ] **Step 5: Make the model tests green and import the module**

Add `import UmbraDBFormal.TemporalKV.Model` to `UmbraDBFormal.lean`, then run:

```powershell
lake env lean UmbraDBFormalTest/TemporalKV/Model.lean
lake env lean UmbraDBFormal/TemporalKV/Model.lean
```

Expected: both commands exit 0 with no warnings.

---

### Task 3: Prove the M1 TemporalKV theorem slice

**Files:**
- Create: `Formal/Lean/UmbraDBFormal/TemporalKV/Laws.lean`
- Create: `Formal/Lean/UmbraDBFormalTest/TemporalKV/Laws.lean`
- Modify: `Formal/Lean/UmbraDBFormal.lean`

**Interfaces:**
- Consumes: every public definition from Task 2.
- Produces the M1 tranche:
  `attempt_applied_version`, `attempt_conflict_iff_snapshot_mismatch`,
  `conflict_preserves_history`, `clock_failure_preserves_history`,
  `attempt_preserves_wellFormed`, `getAtVersion_eq_index`,
  `getAtTime_eq_last_prefix`, `accepted_replay_eq_prefix`, and `dual_address_agrees`.
- Leaves `intervals_pairwise_disjoint`, `adjacent_intervals_gap_free`, retention, keyed-store
  transaction reuse, and refinement theorems out of scope.

- [ ] **Step 1: Add theorem-contract tests before theorem implementations**

Create `UmbraDBFormalTest/TemporalKV/Laws.lean`, import the missing laws module, and instantiate
each theorem at `Value := Nat` and `Time := Nat` in at least one non-vacuous example. The examples
SHALL include:

```lean
example :
    getAtVersion ([{ value := 3, writtenAt := 5 }, { value := 4, writtenAt := 8 }] :
      History Nat Nat) 2 = some { value := 4, version := 2, writtenAt := 8 } := by
  decide

example :
    getAtTime ([{ value := 3, writtenAt := 5 }, { value := 4, writtenAt := 8 }] :
      History Nat Nat) 8 = some { value := 4, version := 2, writtenAt := 8 } := by
  decide
```

The remaining examples SHALL apply the named theorem rather than duplicate its proof.

- [ ] **Step 2: Verify the laws test is red for the missing module/theorems**

Run:

```powershell
lake env lean UmbraDBFormalTest/TemporalKV/Laws.lean
```

Expected: Lean fails because `TemporalKV.Laws` or the named theorem declarations are absent.

- [ ] **Step 3: Prove transition and failure preservation laws**

In `TemporalKV/Laws.lean`, prove the first five declarations by unfolding only the transition
functions necessary for each branch. The contract is:

- an `.applied entry` result has `entry.version = history.length + 1` and a history equal to one
  append;
- `.failed (.versionConflict (snapshotVersion history))` occurs exactly when the CAS expectation
  does not match;
- both failure constructors preserve history byte-for-byte at the abstract value level; and
- strict timestamp well-formedness is preserved by every `attempt` result history.

Search the pinned mathlib before writing custom list lemmas. Prefer `simp`, list append lemmas, and
small structural helper lemmas over `aesop` searches with unstable premise sets.

- [ ] **Step 4: Prove lookup, replay, and dual-address agreement laws**

Prove:

- `getAtVersion_eq_index`: the one-based lookup is the mapped `history[v - 1]?` entry;
- `getAtTime_eq_last_prefix`: for well-formed history, time lookup is the last element of the
  prefix whose times are at most the query;
- `accepted_replay_eq_prefix`: replaying accepted writes appends exactly the corresponding event
  prefix in order; and
- `dual_address_agrees`: for a well-formed history and an in-bounds one-based version `v`, looking
  up version `v` agrees with looking up the selected entry's own timestamp.

The hypotheses SHALL express only linear order, well-formedness, and index bounds. No theorem may
assume its conclusion, uniqueness of all values, SQL behavior, retention completeness, or an
unexplained oracle predicate.

- [ ] **Step 5: Make the theorem contracts and library build green**

Add `import UmbraDBFormal.TemporalKV.Laws` to `UmbraDBFormal.lean`, then run:

```powershell
lake env lean UmbraDBFormalTest/TemporalKV/Laws.lean
lake env lean UmbraDBFormal/TemporalKV/Laws.lean
lake build
```

Expected: all three commands exit 0 with no errors or warnings.

---

### Task 4: Add reproducible trust gates and close the M1 documentation loop

**Files:**
- Create: `Formal/Lean/scripts/check-trust.ps1`
- Create: `.github/workflows/lean.yml`
- Modify: `README.md`
- Modify: `Formal/STORAGE_ALGEBRA_LEAN_RESEARCH.md`

**Interfaces:**
- Consumes: the complete M1 library and generated Lake manifest.
- Produces: local `check-trust.ps1`, GitHub Actions build/no-`sorry` gate, concise README commands,
  and accurate M1 status.

- [ ] **Step 1: Write a red trust-gate fixture outside the repository**

Copy one Lean source to a temporary directory under `$env:TEMP`, inject the token `sorry`, and run
the not-yet-created `Formal/Lean/scripts/check-trust.ps1` against that directory.

Expected: PowerShell fails because the trust script does not exist. Do not add a `sorry` fixture to
the repository.

- [ ] **Step 2: Implement the local trust gate**

`check-trust.ps1` SHALL accept `-Root` defaulting to its parent Lean project, recursively inspect
tracked `.lean` files, and fail on declaration tokens `sorry`, `admit`, `axiom`, or `unsafe` after
excluding comments and strings. It SHALL run `lake build` from the Lean project root and preserve
the command's exit code. It SHALL print the exact offending relative file and line without dumping
unrelated source.

- [ ] **Step 3: Verify red and green trust-gate behavior**

Run the temporary injected fixture and confirm nonzero exit, then run:

```powershell
powershell -ExecutionPolicy Bypass -File Formal/Lean/scripts/check-trust.ps1
```

Expected: the repository run exits 0 after `lake build` succeeds.

- [ ] **Step 4: Add GitHub Actions Lean verification**

Create `.github/workflows/lean.yml` using `actions/checkout@v4` and
`leanprover/lean-action@v1`, with `working-directory: Formal/Lean`, `build: true`,
`build-args: "--wfail"`, `nanoda: true`, and `nanoda-allow-sorry: false`. Add a separate portable
source scan for declaration tokens before the action build. Trigger on pull requests, pushes to
`main` and `formal/**`, and manual dispatch.

- [ ] **Step 5: Document exact local commands and M1 boundaries**

Add a short README Formal Verification section with:

```powershell
Set-Location Formal/Lean
lake update
lake build
powershell -ExecutionPolicy Bypass -File scripts/check-trust.ps1
```

Update the research status to distinguish completed M1 theorems from the deferred M2–M5
obligations. Do not label SQL, retention, lease callback exclusion, or liveness as proved.

- [ ] **Step 6: Defer Graphify to a lifecycle milestone**

Do not refresh Graphify during task implementation or review. Run a single update only after the
sprint is formally closed or the branch is merged to `main`, preserving all non-temporary user
artifacts.

- [ ] **Step 7: Run the final project gates**

Run:

```powershell
powershell -ExecutionPolicy Bypass -File Formal/Lean/scripts/check-trust.ps1
lake env lean Formal/Lean/UmbraDBFormalTest/APISmoke.lean
lake env lean Formal/Lean/UmbraDBFormalTest/TemporalKV/Model.lean
lake env lean Formal/Lean/UmbraDBFormalTest/TemporalKV/Laws.lean
npm test
git diff --check
git status --short
```

Run each `lake env lean` command from `Formal/Lean` with its path relative to that directory if the
absolute invocation does not inherit the Lake workspace. Expected: the Lean build/test commands
exit 0 and `git diff --check` reports no whitespace errors. If `npm test` cannot start because the
host has no supported container runtime, record that pre-existing environment limitation
separately. Status lists only intended M1, approval, and plan changes, plus any pre-existing
user-owned paths.

---

## Plan Self-Review

- Spec coverage: M1 scaffold, Layer A executable semantics, preservation/T1/T2/lookup/T4 theorem
  slice, CI, trust scan, reproducibility, and documentation are assigned. Graphify is explicitly
  reserved for lifecycle milestones.
- Scope: retention, T5 interval tranche, W1/C1 product modules, keyed transactions, leases, GC,
  and PostgreSQL refinement remain excluded; the API smoke theorems only verify imports.
- Type consistency: all model/law/test declarations use `History Value Time`, one-based `Nat`
  versions, `Outcome Value Time`, and `Failure Time` consistently.
- Trust consistency: the source scan, warning-free build, nanoda no-`sorry` check, and review
  council are independent gates; none substitutes for Lean's kernel.
