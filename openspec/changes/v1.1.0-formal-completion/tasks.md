# Tasks — v1.0.0: Formal completion (`formal-completion`)

Each gate: **one builder → two Opus auditors** — *A: spec-faithfulness* (does the Lean theorem assert the spec law, right quantifiers, no trivializing premise?), *B: scope-honesty* (is the model rich enough to be non-vacuous — a mutex over a non-interleavable trace, a "safety" over unrepresentable-unsafe-op, an invariant whose transitions can't change state = a finding). CLOSED only when both approve or findings are fixed and re-reviewed.

**Universal green:** `lake build --wfail` clean; 0 sorry/axiom/admit; named theorem present with the stated signature; module imported into `UmbraDBFormalTest/Trust.lean`; `#audit_umbradb_trust` axiom allowlist `{propext, Quot.sound, Classical.choice}` unchanged.

**Anti-vacuity acceptance (ALL SIX per safety/mutex theorem — audit-mandated):** (1) executable smoke `example`; (2) negative check (guard fires); (3) hypothesis realizes the non-trivial regime (satisfiable ≠ enough); (4) human faithfulness sign-off in `Formal/faithfulness-ledger.md` recording the exact spec sentence transcribed; (5) **unguarded-primitive + `_can_violate` lemma** proving the negation is inhabited; (6) pinned signature in `law-manifest.json`.

**Sequencing note:** GF1/GF3/GF6 are the Option-B release-blocking subset (start-now after GF0; depend only on merged sprint-2/sprint-3/m3c). GF2/GF4/GF5/GF7/GF8 are the deferred tail. GF-REF is a decision gate. Under Option A the whole change is post-1.0.0.

## 0. Scaffolding + Trust reach
- [ ] **0.1** Create `Checkpoint/GC.lean` + `Transaction/Lease.lean` stubs; wire into `UmbraDBFormal.lean`, the `UmbraDBFormalTest.*` mirror, and `UmbraDBFormalTest/Trust.lean`'s imports. **Acceptance:** `lake build --wfail` clean; a temporary `sorry` in a stub turns `#audit_umbradb_trust` **red naming that module** (proves reach), then removed. **Satisfies:** every later theorem is in the audited set.

## 1. C2a — GC-safety (release-blocking; start now)
- [ ] **1.1** `GCState`/`reachable`/`Safe` + unguarded `collectHashes` + safe `collect`; prove `safe_empty`, `registerManifest_safe`, `unlink_safe`, `collect_safe`, `collect_only_unreachable`, `gcSafety_invariant (ops)`, **and `collectHashes_reachable_breaks_safe`** (the `_can_violate` witness). Witness reclaims a once-registered-then-unlinked chunk. Register-row: C2a same-tx visibility = sequential-trace modeling choice (not a Lean hypothesis). **Satisfies:** spec C2a `Deleted ∩ ⋃_{m∈Live} refs(m) = ∅`, every-instant.

## 2. C2b — eventual collection (DEFERRED)
- [ ] **2.1** Round/step model; `eventual_collection` under an **explicit `CollectsInfinitelyOften` fairness hypothesis**, grace bound in the conclusion, + `no_fairness_counterexample`. *Post-1.0.0.*

## 3. L1 — lease mutual exclusion (release-blocking; start now)
- [ ] **3.1** Attempt-level `LeaseSet`/`acquire`(blocking)/`holders`(unique tokens)/`WellFormedTrace`(admits overlapping acquires); prove `acquire_while_held_blocks` + `lease_mutex_all_prefixes`, + `contended_simultaneous_example`. **Satisfies:** spec L1 `|holders(key)| ≤ 1` at every instant; abstract counterpart of recovery-testing Task 4.

## 4. Multi-key TemporalKV lift — FRAMING ONLY (DEFERRED)
- [ ] **4.1** `KeyedStore`, `attemptKeyed_frame`, per-key T1/T2 re-derivation, global `WellFormed`. **Gap-table MUST read** "cross-key framing proved; cross-writer coordination deferred (GF7)" — never "T1 → closed". *Post-1.0.0.*

## 5. Ordered chunk reconstruction (DEFERRED)
- [ ] **5.1** `reconstruct` byte-exact from the ordered stream + `set_equal_order_distinct_example`. *Post-1.0.0.*

## 6. C1 collision hygiene (release-blocking rider)
- [ ] **6.1** Elevate `CollisionFreeOn` to a named, documented `CollisionResistant := Set.InjOn digest (realized values)` **Prop hypothesis** (never `axiom`, never global `Injective`); thread it explicitly through C1-bytes theorems; allowlist unchanged. **Satisfies:** honest conditionality of spec C1 collision-safety.

## 7. Transaction-envelope composition (DEFERRED)
- [ ] **7.1** `withTransaction` over `KeyedStore`; wrapped T1–T5/C1/W1 survive; atomicity with a real abort branch; cross-key gaplessness discharged by GF3's `lease_mutex` **via a shared writer-role lease key + acquisition discipline** (not framing alone). Closes T1 cross-writer OPEN. *Post-1.0.0; design-depends on G5 (merged).*

## 8. Watermark cursor-vs-data ordering (DEFERRED)
- [ ] **8.1** `DurablyOrdered`; `saveAndAdvance` preserves it + `advanceCursorAlone_can_violate`. *Post-1.0.0.*

## REF. Refinement decision + CI manifest
- [ ] **REF.1** Record adoption of (c) conformance-baseline + (b) mechanism-abstraction for the load-bearing RR laws; three-status register; document the 1.0.0 boundary. Doc-only.
- [ ] **REF.2** *(Post-1.0.0)* the actual (b) mechanism lemmas (T5(2)-refinement, C2a-visibility, L1-realizer).
- [ ] **CI.1** `law-manifest.json` (law-ID → theorem → pinned type) + drift test vs manifest + negative controls + Test-lib-build assertion.

## 9. Close-out
- [ ] **9.1** Whole-change differential review: one auditor confirms per gate that the theorem states the spec law, every non-vacuity witness (`collectHashes_reachable_breaks_safe`, `acquire_while_held`-overlap, GF5 order-distinct, GF8 unsafe-step) **fires**, and the axiom allowlist is unchanged. A green `lake build` alone is insufficient.
- [ ] **9.2** Update `Formal/FORMALIZATION_ROADMAP.md` gap table honestly: C2a/L1 → mechanized; T1 cross-key → *framing only*; C1-collision → conditional-and-named; C2b/composition/reconstruction/refinement → deferred with boundary.
