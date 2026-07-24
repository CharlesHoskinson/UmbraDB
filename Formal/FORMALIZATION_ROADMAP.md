# UmbraDB storage-algebra — formalization gap map & roadmap

Analysis by two Opus 5 agents: spec = `Formal/STORAGE_ALGEBRA.md`; Lean = `formal/storage-algebra-lean-m3c-checkpoint-c2a` (`UmbraDBFormal/`, mathlib v4.32.0, **83+ theorems, 0 sorry / 0 axiom / 0 admit**, enforced by the `Trust` gate = source scanner + `#audit_umbradb_trust` env audit restricting axioms to `{propext, Quot.sound, Classical.choice}`).

**Headline:** everything mechanized is *fully proved* — but the mechanization is **abstract-kernel only**, single-key where it matters, and three laws (**C2a, C2b, L1**) plus the entire **abstract→PostgreSQL refinement** are absent. "0-sorry" means *fully proved but narrow*, not *broad*. The `Trust` gate cannot detect a missing law.

## What we have vs. the spec

| Law | Spec status label | Lean coverage | Gap |
|---|---|---|---|
| **T1** gapless monotonicity | MECHANISM SPECIFIED (per-key) / **OPEN** (cross-key/writer) | ✅ per-key abstract (`attempt_applied_version`, `accepted_replay_eq_prefix`) | multi-key store + cross-writer coordination absent |
| **T2** CAS guarded action | MECHANISM SPECIFIED | ✅ abstract (`attempt_versionConflict_iff`, `*_preserves_history`) | — (abstract complete) |
| **T3** temporal projection (retention) | MECHANISM SPECIFIED (in retention) / **OPEN** (beyond) | ✅ abstract transparency + floor classification (`prunePrefix_lookupAt*_agrees` +20) | PG floor metadata / pruning / error wiring unmodeled |
| **T4** dual-addressing agreement | MECHANISM SPECIFIED (conditional) | ✅ abstract (`dual_address_agrees`) | clock/ms-truncation/commit-visibility refinement absent |
| **T5(1)** interval non-overlap | MECHANISM SPECIFIED | ✅ abstract (`intervals_pairwise_disjoint`) | GiST EXCLUDE constraint unmodeled (RR) |
| **T5(2)** gap-freedom | **CALLER-ENFORCED** (trigger-only) | ◐ by-construction (`adjacent_intervals_gap_free`) | trigger-sole-writer discipline unmodeled |
| **C1** save-side join-semilattice | MECHANISM SPECIFIED | ✅ abstract set + byte-map (`Projection.lean`, `ChunkMap.lean`) | collision-safety only *conditional* on undischarged `CollisionFreeOn` |
| **C2a** GC safety (reachability closure) | MECHANISM SPECIFIED | ❌ **ABSENT** | no Live/refs/Deleted model at all |
| **C2b** eventual collection (grace window) | MECHANISM SPECIFIED (conditional) | ❌ **ABSENT** | no grace-window liveness |
| **W1** last-write-wins | MECHANISM SPECIFIED (conditional JSON) | ✅ abstract (`set_idempotent`, multi-address) | JSON-losslessness rider unmodeled |
| **L1** lease mutual exclusion | MECHANISM SPECIFIED | ❌ **ABSENT** (no Transaction/Lease module) | trace-based mutex + advisory-lock refinement |
| Merkle / ADS (§6) | out of scope (threat-model conditional) | — deliberately excluded | — |

**The single largest gap** is deliberate and documented (`LEAN_FORMALIZATION_PLAN.md`, invoking the AWS TLA+ precedent): the PostgreSQL/TypeScript adapter is a *trusted, unmechanized refinement* of the abstract model. No theorem relates any Lean definition to SQL DDL, a trigger, `clock_timestamp()`, `Finmap`→rows, or the TS adapter.

## Roadmap for the missing formalization

Mirrors the Milestone-1 open item: *"extend to Checkpoint C2a/GC, collision handling, ordered reconstruction, keyed transactions, lease traces, and concrete PostgreSQL/runtime refinement obligations."*

### Phase F1 — Close the absent *abstract* laws (tractable now; highest value)
| # | Task | Spec law | Tractability / notes | Depends |
|---|---|---|---|---|
| F1.1 | **CheckpointStore GC safety** — model `Live` manifest set + `refs(m)` + `Deleted`; prove `Deleted ∩ ⋃_{m∈Live} refs(m) = ∅` as an every-instant invariant | **C2a** | Abstract, tractable; the missing CheckpointStore keystone | C1 (have) |
| F1.2 | **Eventual collection** — grace-window model; prove unreachable-beyond-grace ⇒ eventually deleted | **C2b** | Abstract liveness; needs a step/round model | F1.1 |
| F1.3 | **Transaction/Lease module** — trace/interleaving model; prove `|holders(key)| ≤ 1` over any trace (trace-based mutual exclusion) | **L1** | New module; abstract trace mutex is standard | — |
| F1.4 | **Multi-key TemporalKV store** — add a `Key` type; lift T1–T5 to a keyed store; prove cross-key framing/independence | T1 (cross-key), all T | Straightforward lift; unblocks cross-writer coordination | T-laws (have) |
| F1.5 | **Ordered chunk reconstruction** — the `toFinset` projection erases order; prove reconstruction from the ordered chunk stream = original manifest | C1 dual | Needs an ordered-list carrier alongside the set | C1 (have) |
| F1.6 | **Discharge / pin C1 collision hypothesis** — make `CollisionFreeOn` an explicit stated assumption tied to hash-injectivity (SHA-256 collision-resistance is a cryptographic assumption, not a theorem — state it, don't fake it) | C1 (bytes) | Documentation + hypothesis hygiene, small | ChunkMap (have) |

### Phase F2 — Cross-module composition laws
| # | Task | Notes | Depends |
|---|---|---|---|
| F2.1 | **Transaction-envelope composition** — formalize the §4 atomicity-envelope table: prove the data laws (T1–T5, C1, W1) hold when wrapped in `withTransaction`; resolve the OPEN cross-key T1 via L1 | The "control algebra the other three run inside" | F1.3, F1.4 |
| F2.2 | **Watermark cursor-vs-data ordering** — the composition contract (`docs/checkpoint-store-contract.md`): cursor must not advance past durable data | W1 gives no ordering by design | F2.1 |

### Phase F3 — The refinement gap (strategic; the big decision)
Pick the refinement strategy before spending here — this is a *decision*, not just work:
- **(a) Full PG/SQL-semantics refinement** — mechanize a Postgres semantics (MVCC, EXCLUDE, triggers, advisory locks) and prove the adapter refines the abstract model. Gold standard, very high effort, likely disproportionate for a single-writer local cache.
- **(b) Mechanism-level abstraction** — model the *enforcement devices* abstractly (EXCLUDE constraint as an invariant, trigger as the sole `valid_from` writer, advisory lock as the mutex realizer) and prove they discharge the RR obligations (T5(2), T4 clock, C2a same-tx visibility, L1 pinning, W1 JSON). Middle path; closes the "CALLER-ENFORCED/conditional" laws without a full SQL model.
- **(c) Conformance-as-refinement (AWS TLA+ stance)** — keep the abstract model proved; treat the **P1–P10 property tests** (already the recovery-testing suite's backbone) as the *empirical* refinement bridge, and document the boundary. Lowest effort; honest; what the plan currently assumes.

Recommended: **(c) as the baseline** (already true), **(b) for the specific RR laws that are load-bearing for correctness** (T5(2) trigger discipline, C2a same-tx visibility, L1) — these are where an unmodeled mechanism could silently break a proved abstract law.

## Priority call
1. **F1.1 (C2a) + F1.3 (L1)** first — the two *absent* MECHANISM-SPECIFIED laws are the biggest honesty gaps (the spec claims a mechanism; Lean proves nothing). 
2. **F1.4 (multi-key)** next — it unblocks the cross-key T1 `OPEN` and F2 composition.
3. **F1.2, F1.5, F1.6** — complete CheckpointStore + hygiene.
4. **F2** — composition, once L1 + multi-key exist.
5. **F3** — decide the refinement strategy explicitly; adopt (c)+(b-selective). This is what the roadmap's "concrete PostgreSQL/runtime refinement obligations" line actually requires a decision on.

**1.0.0-checklist relevance:** the acceptance item *"Formal spec's tractable properties proved in Lean"* is satisfiable by **F1 + F2** (the tractable abstract laws) — F3's full refinement is beyond "tractable" and can stay post-1.0.0, provided the boundary is documented (option c).
