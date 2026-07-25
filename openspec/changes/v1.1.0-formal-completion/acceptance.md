# Acceptance — v1.0.0: Formal completion (`formal-completion`)

## The forced decision (must be recorded before this change closes)

A council-style ruling MUST record either **Option A** or **Option B** (silence is an E4 overclaim risk):

- **Option A — CLOSE ON DEFERRAL (default, recommended, zero-amendment).** The checklist item is met by: (i) `{T3,T5,W1,C1}` remain proved + Trust-audited on the tag SHA; (ii) a **written deferral** in the release doc + `Formal/FORMALIZATION_ROADMAP.md` naming C2a, L1, C2b, multi-key, reconstruction, composition, and full refinement as *not proved*; (iii) `STORAGE_ALGEBRA.md` and the release-doc make **no** claim that C2a/L1 are proved. **This change's Lean proofs (GF1/GF3/GF6…) are then post-1.0.0.** No amendment to the guideline, gate set, or entry criterion.
- **Option B — PROVE INTO THE TAG.** Requires, ratified and recorded **first**, the amendment bundle: widen frozen set `{T3,T5,W1,C1}→{…,C2a,L1}` at G20/E3/§3.4/R8; extend G1–G20; edit the five-change entry criterion to six; update the api-surface release-contract spec + R1. Then GF1+GF3+GF6 become release-blocking (proposed G21/G22+rider).

## Normative release-law manifest (single source of truth)

| Law | Status | Theorem(s) / evidence |
|---|---|---|
| T2, T5(1), W1, C1-save | `ABSTRACT-PROVED` | existing (frozen set) |
| T1-per-key, T3-retention, T4-core, **T5(2)-abstract** | `ABSTRACT-PROVED` | existing (`adjacent_intervals_gap_free`, `validityIntervals_cover_iff`, `dual_address_agrees`) |
| **C2a GC-safety** | `ABSENT` → `ABSTRACT-PROVED` on GF1 close | `gcSafety_invariant` + `collectHashes_reachable_breaks_safe` |
| **L1 lease-mutex** | `ABSENT` → `ABSTRACT-PROVED` on GF3 close | `lease_mutex_all_prefixes` + `acquire_while_held_blocks` |
| C1 collision hygiene | conditional (named) → GF6 | `CollisionResistant := Set.InjOn …` hypothesis |
| T5(2)-refinement, C2a-visibility, L1-realizer | `REFINEMENT-UNPROVED` (register (b), post-1.0.0) | register rows + P5/P8/P10 |
| T3-beyond-retention, T4-commit-visibility, W1-JSON | `RUNTIME-TESTED` / deferred | P3/P4/P9 |
| C2b, multi-key(cross-writer), reconstruction, composition, full-PG-refinement, Merkle | `DEFERRED` / out-of-scope | written deferral; **not certified** |

C2b is **deferred, not front-loaded**: register row "conditional on a GC pass running — liveness not mechanized."

## Definition-of-done for a gate to CLOSE
1. Universal green (tasks.md) + the **six** anti-vacuity criteria (incl. the `_can_violate` witness and the pinned-signature manifest entry).
2. Both Opus auditors (spec-faithfulness + scope-honesty) approve.
3. The `law-manifest.json` entry + faithfulness-ledger row exist; negative CI control (weakening the theorem fails CI) is green.
4. No widening of `permittedProjectAxioms`; `#audit_umbradb_trust` allowlist unchanged.

## Change-level exit (Option B) / checklist-close (Option A)
- **Option A:** the written deferral is recorded and the release doc/`STORAGE_ALGEBRA.md` carry no C2a/L1 "proved" claim → checklist item **✅ closed honestly on `{T3,T5,W1,C1}`**.
- **Option B:** the amendment bundle is recorded; GF1+GF3+GF6 CLOSED; `lean.yml` green on the tag SHA proving the widened set; the overclaim-drift test green (release-doc "proved" list == `law-manifest.json`) → checklist item **✅ closed on `{…,C2a,L1}`**.

## Non-goals
No `src/` changes. No SQL/MVCC semantics mechanized (full refinement is F3, post-1.0.0). No Merkle/ADS (§6 threat-model decision). No cross-repo/indexer oracle for the conformance bridge (indexer-agnostic boundary).
