# Lean 4 Formalization Plan

Companion to `STORAGE_ALGEBRA.md` and `STORAGE_TYPES.md`. This is guidance
for actually writing the Lean formalization, produced by a dedicated
research pass and then corrected by an independent technical review before
being recorded here — several claims in the original research were wrong
or overstated and are fixed below, not silently carried forward.

## Scope decision: abstract model first, implementation trusted-but-unverified

Following the formal-methods field's own explicitly stated practice (AWS's
TLA+ team: "How do we know that the executable code correctly implements
the verified design? The answer is that we don't" — a deliberate,
openly-acknowledged scope limit of the whole discipline, not a shortcut),
this first formalization pass targets the **abstract algebra only**: pure
functional state machines for TemporalKV, CheckpointStore, Watermarks, and
Transaction/Lease, as described in `STORAGE_ALGEBRA.md`. The Postgres/SQL
implementation — including the `tstzrange` + `GiST EXCLUDE` constraint that
enforces T5 at the database level — is treated as a trusted, unverified
refinement of the proved abstract model, not itself mechanized. Closing
that gap (proving the SQL actually implements the abstract model) is
future work, not this pass's scope.

## Per-property guidance

### Near-term tractable — start here

- **T5 (temporal coherence / interval non-overlap).** Mathlib's
  `Set.Ico_disjoint_Ico` (and the `Ioc`/`Ioo` variants) give disjointness of
  two half-open intervals directly. **Correction to the original research:**
  the disjointness condition is
  `Disjoint (Ico a₁ a₂) (Ico b₁ b₂) ↔ min a₂ b₂ ≤ max a₁ b₁`
  — the original research stated this inequality **backwards**
  (`max a₁ b₁ ≤ min a₂ b₂`, which is actually the *overlap* condition). Use
  the corrected direction above. `kv_history`'s `[valid_from, valid_to)`
  maps directly onto `Set.Ico`, no bespoke typeclass needed. **GO — start
  now.**
- **W1 (Watermarks, trivial LWW).** No history, no version — `set` is
  `Function.update`-style idempotent overwrite. **GO — start now.**
- **C1 (CheckpointStore, algebraic half — join-semilattice laws).**
  Mathlib's `SemilatticeSup`/`OrderBot` hierarchy fits the chunk-store's
  idempotent, commutative, associative join directly, via the
  `SemilatticeSup.mk'` constructor (confirmed real, builds the typeclass
  from commutativity + associativity + idempotence directly — this part of
  the research checked out). **Do NOT build on `crdt-lean`** (the repo the
  original research cited as already proving this pattern) — it is a
  0-star, single-maintainer repo created 2026-06-10, with no affiliation to
  mathlib/Lean core, and one of its specific claims (that `sup_idem` is
  *precisely* the lemma proving CheckpointStore's idempotence property) was
  independently checked and refuted. The structural fit (chunk store =
  `SemilatticeSup`) still holds — that survived verification — but the
  idempotence obligation is about the store's own `Put`/merge *operation*,
  not the raw lattice `⊔`, so it needs its own from-scratch proof against
  UmbraDB's actual state-transition definition, not a borrowed one-liner.
  **GO, with a gate:** write a minimal from-scratch `SemilatticeSup`
  instance for the chunk store as a first sanity check before committing
  further — this both validates the approach and makes the `crdt-lean`
  dependency unnecessary. Read `crdt-lean` once for orientation if useful,
  never as code to adapt or depend on.

### Moderate effort

- **T2 (CAS-guarded partial action).** **Reclassified up from the original
  research's "days" estimate** — an independent review correctly flagged
  this as underranked. Mathlib's `MulAction`/`AddAction` are *total,
  unconditional* actions only (confirmed: no partial/guarded variant, no
  `Option`/failure-valued codomain anywhere in the action hierarchy) — there
  is no existing typeclass to build on, so `apply : State × Put -> State ∪
  {conflict}` needs a genuinely new definition (an `Option`-valued or
  subtype-guarded wrapper). Designing that wrapper's exact semantics (what a
  failed CAS produces, how it composes with T1's monotonicity requirement)
  is a specification task with real risk of getting the shape wrong the
  first time — treat it as moderate effort, not a quick lemma lookup.
  **Draft and review the wrapper's specification before writing proofs
  against it.**
- **L1 (Transaction/Lease mutual exclusion).** Real, verified Lean 4
  precedent: the Veil framework (VERSE Lab, NUS — confirmed as a genuine,
  actively maintained project, not fabricated) includes a worked
  Suzuki-Kasami mutual-exclusion case study with a mechanically-checked
  `[mutex] (crit N ∧ crit M) → N = M` invariant over a transition system —
  a direct template for L1's "cardinality ≤ 1 concurrent holders" property.
  The research's proposed unification — reformulating each lease hold as an
  `[acquire, release)` interval and reducing L1 to the *same*
  interval-disjointness lemma used for T5 — is architecturally promising
  but explicitly unconfirmed (flagged by the original research itself as
  "an analogical suggestion, not a mathlib-content claim," not
  independently verified). Try it; if interleaved/open-ended intervals
  (a lease acquired but not yet released) break the clean reduction, fall
  back to Veil's transition-system + inductive-invariant style.
- **T1 (gapless monotonicity, conditional on serialization).** No
  mathlib-specific blocker, but needs an explicit `Serialized`/no-concurrent-
  write hypothesis stated as a precondition (matching how the design's own
  algebra spec already frames T1 as conditional, not unconditional) — follow
  the safety/liveness separation pattern of proving monotonicity
  unconditionally *given* that hypothesis, rather than trying to prove it
  holds universally.

### Harder / genuinely novel — no existing precedent to lean on

**M1 status update:** `getAtTime_eq_last_prefix` now proves the per-key ordered-prefix core of T3
directly over the executable history model. The discussion below remains relevant to the deferred
store-level/refinement generalization, not to the completed M1 theorem.

- **T3 (temporal-projection / fold-equivalence).** Mathlib's Bird-Wadler
  duality lemma (`Std.Associative`-based `foldl`/`foldr` equivalence) is a
  real building block, but **the exact lemma name cited by the original
  research (`List.foldl_eq_foldr_of_commute`) could not be confirmed and is
  likely garbled** — the closest real lemma requires the operation to be
  *both* `Std.Commutative` and `Std.Associative` (`List.foldl_eq_foldr`),
  not the "accumulator commutes with each element" framing originally
  stated. Verify the exact current lemma name/signature directly against
  mathlib source before relying on it. Either way, none of this supplies a
  notion of "time" or event ordering — defining "events at or before T"
  (the actual content of T3) is bespoke work with no existing abstraction to
  reuse.
- **T4 (dual version/timestamp addressing agreement).** No cited precedent
  at all, in Lean or elsewhere. Needs a from-scratch definition (plausibly
  a strict monotone embedding between the version order and the timestamp
  order) and its own proof that the two addressing schemes agree at commit
  instants.
- **C2 (GC reachability-closure, the graph-reachability half).** Mechanized
  GC-correctness precedent exists (McCreight's 2008 Yale thesis, verifying
  copying collectors via Hoare-style/separation logic) but **only in
  Coq/separation logic, not Lean/mathlib** — there is no reusable mathlib
  library for graph-reachability-based GC correctness. Needs a from-scratch
  Lean definition, likely built on `Relation.ReflTransGen` (reflexive-
  transitive closure) over a reference graph derived from live manifests'
  chunk-hash sets.

## Process note

This plan itself was corrected once already — the research that produced
it had a backwards inequality, a likely-garbled lemma citation, and an
underranked difficulty estimate, all caught by an independent review before
being recorded here. Apply the same discipline going forward: verify a
specific lemma name/signature against actual mathlib source immediately
before using it in a proof, don't carry a citation forward on trust alone
just because it came from a "research pass."
