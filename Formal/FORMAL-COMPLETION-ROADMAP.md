# Roadmap — `v1.1.0-formal-completion`: storage-algebra Lean mechanization vs 1.0.0 (v2, audit-reframed)

*v1 authored by an Opus 5 write-council (3 facets); v2 reframed after a 3-lane audit council (2 Opus 5 + GPT-5.6 Sol capstone). The audit corrected v1's central error — v1 wrongly asserted the guideline **requires** widening the frozen Lean cut-line; it does not. Governed by `docs/v1-implementation-guideline.md`; this is **voluntary hardening under §0.2**, not a mandate.*

> **Front-page honesty statement.** Under the guideline's default path (G20/E3/§3.4), the 1.0.0 checklist item *"Formal spec's tractable properties proved in Lean, not just stated"* is **closable today** by keeping the frozen record `{T3,T5,W1,C1}` proved and recording **C2a, L1, and the rest as an explicit written deferral** — no new proofs required, no overclaim. Everything below is the **optional** extra: mechanizing the two absent MECHANISM-SPECIFIED laws (**C2a GC-safety, L1 lease-mutex**) so they can move from *deferred* to *proved* — which, if wanted tag-blocking, requires **explicit recorded amendments** (see §1). `0 sorry` certifies depth (what is stated is proved), never breadth: the `Trust` gate cannot detect a missing or too-weak law.

## 0. What v1 got wrong (audit corrections folded in)
1. **No mandated cut-line widening.** The guideline's default is *prove `{T3,T5,W1,C1}` + written deferral of the rest* (E3, §3.4, G20). C2a/L1 are legitimately "the rest." v1's "tractable-taxonomy forces widening" framing is dropped.
2. **Amendments are explicit prerequisites, not footnotes.** If C2a/L1 proofs are to be tag-blocking, each of these is a recorded amendment that MUST land *first*: widen the G20/E3/§3.4/R8 frozen set `{T3,T5,W1,C1}→{…,C2a,L1}`; extend the closed G1–G20 set (the new gates are **not** "routine"); edit the "all **five** `v1.0.0-*` changes" release entry criterion to six; update the API-surface release-contract spec + R1 register. The false "same mechanism as G14" analogy (G14 edits `ROADMAP.md` prose, adds no gate) is removed; the guideline defines **no** self-amendment/council-convening procedure, so this is a re-issue of a GOVERNING doc and must be named as such.
3. **One normative release-law manifest** (below) replaces v1's three inconsistent claims (front page certified multi-key/C2b; body deferred them).
4. **The two release-blocking gates get real anti-vacuity witnesses** (unguarded primitive + `_can_violate`), which v1 shipped for GF5/GF8/GF2 but *not* for GF1/GF3.

## 1. Decision the user/council must make (forced, per audit)
**Option A (default, zero-amendment, guideline-sanctioned):** close the checklist item now on `{T3,T5,W1,C1}` + a written deferral naming C2a/L1/C2b/multi-key/reconstruction/composition/refinement. Ship the Lean proofs below **post-1.0.0** as hardening. *No governance amendment; no tag-date risk.*
**Option B (hardening-into-the-tag):** land GF1 (C2a) + GF3 (L1) + GF6 (C1-hygiene) before the tag — but only after the **explicit amendment bundle** in §0.2 is ratified and recorded. Higher assurance; adds governance work + real Lean effort (§4) to the tag.
**Recommendation: Option A for the tag, Option B's proofs as the immediate post-1.0.0 formal workstream** — unless there's a specific reason C2a/L1 must be *proved* (not deferred) for 1.0.0, in which case do the amendment bundle first.

## 2. Normative release-law manifest (single source of truth)
| Law | Abstract status | If Option B, release-blocking? |
|---|---|---|
| T2, T5(1), W1, C1-save | **ABSTRACT-PROVED** (today) | already in the frozen `{…}` |
| T1-per-key, T3-retention, T4-core, **T5(2)-abstract** | **ABSTRACT-PROVED** (today) | in frozen set (T5(2): abstract only — see §5) |
| **C2a GC-safety** | **ABSENT** → GF1 | **yes** (the keystone) |
| **L1 lease-mutex** | **ABSENT** → GF3 | **yes** |
| C1 collision hygiene | conditional → GF6 | **yes** (rider) |
| C2b, multi-key(T1 cross-key framing), ordered-reconstruction, composition | tractable but **DEFERRED** (GF2/GF4/GF5/GF7/GF8) | **no** — documented deferral, NOT certified on the front page |
| T3-beyond-retention, T4-commit-visibility, full PG refinement, Merkle/§6 | **DEFERRED / out-of-scope** | no |

C2b is **not** front-loaded (v1 wrongly declared it MUST-mechanize while deferring it): it is deferred, register-recorded as "conditional on a GC pass running — liveness not mechanized," matching the spec's own conditionality.

## 3. Corrected Lean gates (the ones that change)

**GF1 — C2a GC-safety (must not be true-by-construction).** `GCState{manifests, live, deleted}`, `reachable := live.biUnion manifests`, `Safe := Disjoint deleted reachable` — faithful (union over `live` only is correct; `∀ ops, Safe (empty.run ops)` gives every-instant via prefix-universality, *provided* `run` is a plain foldl with no end-only finalization — record in the faithfulness ledger). **The fix:** model an **unguarded** primitive `collectHashes : Finset Hash → GCState → GCState`, define the safe `collect := collectHashes (allChunks \ reachable)`, and prove **both** `collect_safe` **and** `collectHashes_reachable_breaks_safe` (feeding a live-referenced hash *breaks* `Safe` — the unsafe op is representable and excluded, not unrepresentable). Witness must reclaim a chunk **once registered then unlinked** (so `unlink` genuinely shrinks `live`).

**GF3 — L1 lease-mutex (must not be circular).** Faithful *shape*: `lease_mutex_all_prefixes : (holders (take n) key).card ≤ 1`. **The fix:** model at the level of **attempts**, not a global "≤1 holder" predicate: `acquire` on a held key must *fail/block* (`outcome = blocked`, not added to `holders`); `WellFormedTrace` must **admit two distinct holders issuing overlapping acquires** on one key. Prove `acquire_while_held_blocks`, derive `holders` by folding acquire/release/connection-close *outcomes*, and ship `contended_simultaneous_example` (overlapping requests, one blocked) — the alternation witness (serial reuse) is *insufficient* and is replaced. Use unique acquisition tokens so `Finset holder` can't collapse two same-holder acquisitions.

**GF4 — multi-key lift = FRAMING ONLY (relabel).** `attemptKeyed_frame` + per-key T1/T2 re-derivation genuinely prove cross-**key** independence — but the spec's T1 `OPEN` is cross-**writer/role** coordination, which this does **not** close. GF9's gap table MUST read "T1 cross-key *framing* proved; cross-writer coordination **deferred** (GF7, post-release)" — not "T1 → closed" (that would be an E4 overclaim). Non-release-blocking.

**GF6 — C1 collision hygiene.** Keep `CollisionFreeOn` as `Set.InjOn digest (realized values)` (already correctly scoped in `ChunkMap.lean`) — **never** global `Function.Injective digest` (provably false by pigeonhole on finite `Hash` → unsatisfiable hypothesis → every C1-bytes theorem vacuous). Stays an explicit hypothesis; no axiom; allowlist untouched.

GF2 (C2b), GF5 (reconstruction), GF7 (composition — needs a *shared writer-role lease key + acquisition discipline*, not framing alone), GF8 (cursor-vs-data): unchanged in shape, all **deferred**.

## 4. Anti-vacuity acceptance criteria (corrected — was the hole)
Every **safety/mutex** theorem requires all six:
1. executable smoke `example` on real values; 2. negative check (guard *fires*); 3. **hypothesis realizes the non-trivial regime** (satisfiable ≠ enough — the inhabitant must exhibit contention/a reclaim/a conflict); 4. human faithfulness sign-off in a checked-in ledger recording the exact spec sentence transcribed; **5. (NEW) unguarded-primitive + `_can_violate` lemma** proving the negation is inhabited in the model (`collectHashes_reachable_breaks_safe`, `acquire_while_held_would_overlap`); 6. pinned signature in the law manifest (§6).

## 5. Refinement strategy — three honest statuses (was overstated)
Report every law as exactly one of: **`ABSTRACT-PROVED`** (Lean theorem, Trust-audited), **`RUNTIME-TESTED`** (P1–P10 sampled conformance — *not* a proof), **`REFINEMENT-UNPROVED`** (trusted, itemized in the register). Corrections:
- A "printed Lean hypothesis" for a load-bearing RR obligation **relocates, does not prove**, the Postgres correspondence — say so. GF-REF.2 (the actual mechanism lemmas) is deferred, so the front page must **not** claim those mechanisms are "pinned/proved" for 1.0.0.
- **C2a same-tx visibility is a *modeling choice*, not a dischargeable Lean hypothesis** in a sequential-trace model (atomicity is baked into the fold). Either model interleaved two-writer ops (heavier) or record it honestly as a register row "sequential-trace assumption," and drop the "explicit hypothesis" claim.
- **T5(2) split everywhere:** `T5(2)-abstract` (proved: `adjacent_intervals_gap_free` + `validityIntervals_cover_iff`) vs `T5(2)-refinement` (register (b): trigger sole-writer of boundary columns). Remove "T5(2) gap-freedom" from any wholesale *deferred* list.
- **Refinement-obligation register** (mandatory): row per obligation with abstract-theorem / trusted-mechanism / (b)-hypothesis-or-(c)-property-test / voiding-precondition. Replaces the retired "GUARANTEED" label.

## 6. CI / faithfulness enforcement (corrected — Trust ≠ law-presence)
`#audit_umbradb_trust` enforces **axiom-cleanliness only**; it exposes no law→theorem registry, so v1's "drift test diffs against the set Trust audits" has nothing to diff. Replace with:
1. a **checked-in machine-readable law-ID manifest** mapping each claimed law to its theorem with a **pinned signature guard** (`#check @gcSafety_invariant : <exact type>`) that fails to elaborate if the signature drifts/weakens;
2. an **overclaim drift test** diffing the release-doc "proved" list against *that manifest* (not against Trust);
3. **negative CI controls** — deleting or weakening any required theorem MUST turn CI red;
4. assert `lake build --wfail` **includes the Test library** (else `Trust.lean`'s command elaborator never runs and the whole gate is silently absent);
5. keep GF0's "temporary `sorry` in a stub turns the gate red" as a standing reach-probe.
Existing verified-real wiring: `lean.yml` forbidden-token scan `{sorry,admit,axiom,unsafe}` + `lake build --wfail` + `leanchecker`; R2 (both CI gates green on tag SHA); R8 (no tag with red/placeholder trust gate). `permittedProjectAxioms` MUST NOT widen (adversarial diff BLOCKs it).

## 7. Effort & sequencing (consistent DAG)
- **Release-blocking subset (Option B): GF1 + GF3 + GF6** — depends only on already-merged artifacts (sprint-2 lease, sprint-3 checkpoint, m3c). GF0 scaffolding is upstream of *these* (not "no upstream"; the "start-now" set is GF1/GF3/GF6 *after* GF0). Estimate this subset **separately**: ~1.5–3 weeks incl. the two-auditor cadence and the corrected anti-vacuity witnesses (GC + lease models with real unsafe-op representability are the cost).
- **Full GF1–GF9 tail** (C2b liveness round-model, composition, reconstruction, GF-REF.2): **likely multi-month**, post-1.0.0. v1's blanket "3–4 weeks" was optimistic and is withdrawn.
- **Critical path:** the subset branches from m3c and joins only at G20 — but note a release-blocker joining at G20 is still on the *tag's* parallel critical path if it exceeds slack; under Option A there is no such risk (deferred).

## 8. Binding constraints (verified accurate)
No AI attribution on any commit/PR/tag/CHANGELOG/release body (§0.2 pt 3, MEMORY `no-claude-coauthor`). Indexer-agnostic (§0.3/§3.9, MEMORY `umbradb-sync-architecture-boundary`): pure abstract algebra, no consumer/indexer imports; the (c) conformance bridge stays in-repo. Lean workflow per `AGENTS.md` + the `lean4` skill.
