# Proposal — v1.0.0: Formal completion (`formal-completion`)

> **Status:** Proposed for the 1.0.0 program (optional hardening). Change id `v1.1.0-formal-completion`, capability `formal-completion`. Authored by an Opus 5 write-council (3 facets) → consolidation → an audit council (2 Opus 5 + GPT-5.6 Sol capstone) → this audit-reframed v2. Full analysis: `Formal/FORMAL-COMPLETION-ROADMAP.md`; audit trail: `Formal/FORMAL-COMPLETION-AUDIT.md`; gap map: `Formal/FORMALIZATION_ROADMAP.md`.

## Governance framing (read first)

This change is **voluntary hardening under `docs/v1-implementation-guideline.md` §0.2 ("may add conditions … MUST NOT weaken")** — it is **not** a prerequisite the guideline mandates, and it does **not** by itself require amending the frozen Lean cut-line. The audit council corrected an earlier draft that wrongly asserted a mandate. Two paths:

- **Option A (default, guideline-sanctioned, zero-amendment):** the 1.0.0 checklist item *"Formal spec's tractable properties proved in Lean, not just stated"* is closable **today** by keeping the frozen record `{T3,T5,W1,C1}` proved and recording **C2a, L1, and the rest as an explicit written deferral** (exactly the G20/E3/§3.4 mechanism). No new proofs gate the tag; this change's proofs land **post-1.0.0**.
- **Option B (proofs tag-blocking):** land the release-blocking subset (below) before the tag — permissible only after an **explicit, recorded amendment bundle** is ratified first: widen the G20/E3/§3.4/R8 frozen set `{T3,T5,W1,C1}→{…,C2a,L1}`; extend the closed G1–G20 gate set; edit the "all **five** `v1.0.0-*` changes" release entry criterion to six; update the api-surface release-contract spec + R1 register. (There is no false "same mechanism as G14" here — G14 edited `ROADMAP.md` prose and added no gate. The guideline defines no self-amendment procedure, so Option B is a governed re-issue of the constitution.)

**Recommendation:** Option A for the tag; ship this change's proofs as the immediate post-1.0.0 formal workstream — unless there is a specific reason C2a/L1 must be *proved* (not deferred) for 1.0.0.

## Why

The mechanization today (m3c branch, 83+ theorems, 0 sorry / 0 axiom, `Trust`-gate-green) proves the abstract cores of T1–T5, W1, C1 — but **C2a (GC reachability-safety) and L1 (lease mutual-exclusion) are labelled MECHANISM SPECIFIED in `Formal/STORAGE_ALGEBRA.md` and prove *nothing* in Lean**. Ticking the checklist item while those remain *stated-not-proved* **without a recorded deferral** would be the E4 overclaim the program forbids. This change closes that gap deductively — the complement of `recovery-testing`'s empirical layer. It adds **no `src/` behavior** (`Formal/Lean/**` + docs + CI-manifest only).

## What changes

- **Release-blocking subset (Option B only): {C2a GC-safety, L1 lease-mutex, C1 collision-hygiene}** — proposed gate items G21/G22(+rider), *contingent on the §Governance amendment bundle*.
- **Deferred tail (both options):** C2b eventual-collection, multi-key TemporalKV *framing*, ordered chunk reconstruction, transaction-envelope composition, watermark cursor-vs-data ordering, and the full abstract→PostgreSQL refinement — each named in a written deferral, **not** certified as proved.
- A **normative release-law manifest** (`acceptance.md`) as the single source of truth for which laws are `ABSTRACT-PROVED` / `RUNTIME-TESTED` / `REFINEMENT-UNPROVED` — replacing the retired "GUARANTEED" label.
- A **CI faithfulness manifest** (pinned-signature law-ID → theorem map + negative controls), because `#audit_umbradb_trust` enforces axiom-cleanliness, **not** law presence.

## Dependencies & critical path

The release-blocking subset depends only on **already-merged** artifacts (sprint-2 lease, sprint-3 checkpoint, m3c branch) — branch the proofs *from m3c*. It stays **off** the `G5→G6/7/8` critical chain; its sole join point is **G20** (Lean legibility). The deferred composition tail design-depends on G5 (merged) and the recovery-testing P1–P10 (the conformance bridge). Under Option A there is no tag-date coupling at all.

## Binding constraints

No AI attribution on any commit/PR/tag/CHANGELOG/release body (§0.2 pt 3, MEMORY `no-claude-coauthor`) — even though proofs are `lean4`-skill-assisted. Formalization stays indexer-agnostic (§0.3/§3.9, MEMORY `umbradb-sync-architecture-boundary`): pure abstract algebra, no consumer/indexer imports; the conformance bridge stays in-repo.
