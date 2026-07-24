# Audit record — `v1.0.0-formal-completion` roadmap (v1 → v2)

Pipeline (v1.0.0-style): Opus 5 write-council (3 facets) → consolidation → **audit council: 2 Opus 5 + GPT-5.6 Sol capstone**.

## Verdicts
- **Opus — governance:** *engineering intent honest, governance framing unsound as written; must not be executed as-is.*
- **Opus — Lean-faithfulness:** *structurally honest and largely faithful, but not yet sound as a release gate* (the two release-blocking gates are the least vacuity-protected).
- **GPT-5.6 Sol capstone:** *flawed.*

## Convergent findings (≥2 lanes) and v2 resolution
1. **[CRIT, gov+Sol] Invented cut-line-widening requirement.** Guideline's default = prove `{T3,T5,W1,C1}` + written deferral (G20/E3/§3.4); C2a/L1 are legitimately deferrable; ticking honestly needs no widening. → v2 §0/§1: reframed as **voluntary hardening under §0.2**; Option A (deferral, zero-amendment) is the default; Option B (proofs tag-blocking) requires an explicit amendment bundle.
2. **[CRIT, gov+Sol] G21/G22 / 5→6 changes / false G14 analogy / undefined council-ruling.** Program is a closed G1–G20 / five-change set; extending it is a GOVERNING-doc amendment, not routine; G14 edits ROADMAP prose only. → v2 §0.2: each amendment named as an explicit prerequisite; G14 analogy removed.
3. **[CRIT, Sol] Internal contradiction** — front page certified C2a/L1/multi-key/C2b; body deferred multi-key + ring-fenced C2b; GF9 expected all closed. → v2 §2: one normative release-law manifest; release-blocking = {C2a-safety, L1, C1-hygiene} only; C2b/multi-key **deferred, not certified**.
4. **[HIGH, Sol+Lean] GF1 C2a true-by-construction risk** (`collect := ∪(allChunks\reachable)` ⇒ tautological safety). → v2 §3: unguarded `collectHashes` primitive + `collectHashes_reachable_breaks_safe`; witness reclaims a once-registered-then-unlinked chunk.
5. **[HIGH, Sol+Lean] GF3 L1 circular/weak** (`WellFormedTrace` may encode ≤1-holder; `Finset holder` collapses same-holder; alternation witness = serial reuse, not simultaneity; `acquire` never blocks). → v2 §3: attempt-level model, `acquire_while_held_blocks`, `blocked` outcome, `contended_simultaneous_example`, unique tokens.
6. **[HIGH, Lean] Anti-vacuity criteria missing "violating state representable."** → v2 §4: added criterion (5) unguarded-primitive+`_can_violate`; tightened (3) satisfiable≠non-trivial.
7. **[HIGH, Sol+Lean] Trust gate ≠ law-faithfulness; "drift test" has no manifest.** → v2 §6: pinned-signature law-ID manifest + drift test vs *manifest* + negative CI controls + assert Test lib builds.
8. **[MED, Sol+Lean] Refinement over-claim** (front page "pinned mechanisms" vs GF-REF.2 deferred; hypothesis relocates≠proves). → v2 §5: three statuses ABSTRACT-PROVED / RUNTIME-TESTED / REFINEMENT-UNPROVED; C2a same-tx = modeling-choice not hypothesis; T5(2) split abstract/refinement.
9. **[MED, Lean] GF4 doesn't close T1 cross-writer OPEN** (only cross-key framing). → v2 §3: relabelled framing-only; cross-writer coordination deferred (GF7).
10. **[MED, Sol] Schedule/DAG inconsistent; 3–4 wk optimistic.** → v2 §7: GF0 upstream of the start-now set; subset ~1.5–3 wk estimated separately; full tail multi-month.

## Affirmed (audit found sound)
Statement *shapes* of C2a (`Disjoint deleted (live.biUnion manifests)`) and L1 (`.card ≤ 1` all-prefixes) faithful; union-over-`live`-only correct; every-instant via prefix-universality sound; `CollisionResistant` as `Set.InjOn`-hypothesis is axiom-clean and already realized in `ChunkMap.lean`; the "must import into Trust.lean to be audited" reasoning correct; precedence/binding citations accurate.
