# Spec — capability `formal-completion`

Requirements for the deductive completion of the storage-algebra mechanization. Authoritative on *what this gate item requires*; the guideline is authoritative on *how work is produced/verified/closed*.

## Requirements (EARS)

**FC-1 (deferral honesty).** The system SHALL, before the 1.0.0 tag, record a council-style ruling selecting Option A or Option B (`acceptance.md`); WHERE Option A is selected, the release doc and `STORAGE_ALGEBRA.md` SHALL contain a written deferral naming every unproved MECHANISM-SPECIFIED law (C2a, L1) and SHALL make no claim that any deferred law is proved.

**FC-2 (C2a faithfulness).** WHERE the C2a gate is implemented, the mechanization SHALL define `Safe := Disjoint deleted (live.biUnion manifests)`, SHALL prove it holds at every trace prefix from the empty state, and SHALL include an unguarded deletion primitive together with a `_can_violate` theorem proving that deleting a reachable chunk breaks `Safe`.

**FC-3 (L1 faithfulness).** WHERE the L1 gate is implemented, the mechanization SHALL model acquire as a blocking operation on a held key, SHALL prove `(holders (prefix) key).card ≤ 1` at every prefix, and SHALL include a well-formed trace exhibiting two distinct holders issuing overlapping acquires on one key where the second outcome is `blocked`. The system SHALL NOT define well-formedness as the ≤1-holder conclusion.

**FC-4 (no vacuity).** For every safety or mutual-exclusion theorem, the system SHALL satisfy all six anti-vacuity criteria (`tasks.md`), including the `_can_violate` witness and a hypothesis-non-triviality witness; a theorem satisfiable only over a model that cannot represent the unsafe operation SHALL be rejected.

**FC-5 (no axiom widening).** The system SHALL keep the `#audit_umbradb_trust` axiom allowlist `{propext, Quot.sound, Classical.choice}` unchanged; cryptographic collision-resistance SHALL be expressed as `Set.InjOn digest (realized values)` hypothesis, never as an `axiom` and never as global `Function.Injective`.

**FC-6 (faithfulness enforcement).** The system SHALL maintain a checked-in law-ID → theorem manifest with pinned type signatures, a drift test asserting the release-doc "proved" list equals that manifest, and negative CI controls under which deleting or weakening any required theorem turns CI red. The system SHALL NOT rely on `#audit_umbradb_trust` for law presence or signature faithfulness.

**FC-7 (three-status honesty).** The system SHALL classify every law as exactly one of `ABSTRACT-PROVED`, `RUNTIME-TESTED`, or `REFINEMENT-UNPROVED`, and SHALL NOT report a runtime-refinement obligation discharged by a Lean hypothesis as "proved of the running system."

**FC-8 (scope honesty).** The multi-key lift SHALL be reported as cross-key framing only; the T1 cross-writer OPEN SHALL remain deferred until the composition gate lands; C2b SHALL be reported as deferred with an explicit "conditional on a GC pass running" register row.

## Governed by
`docs/v1-implementation-guideline.md` §0.2 (this change is voluntary hardening; Option B requires the recorded amendment bundle); `AGENTS.md` (Lean workflow); MEMORY `no-claude-coauthor`, `umbradb-sync-architecture-boundary`.
