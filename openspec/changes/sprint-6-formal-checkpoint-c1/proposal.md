# Proposal — Sprint 6: Lean M3b CheckpointStore C1

> **Status:** Complete — abstract save-side projection only.

## Why

Abstract Watermarks W1 was merged and the detailed formal roadmap scheduled CheckpointStore C1
next. The repository had a completed PostgreSQL CheckpointStore and property tests but no Lean
save-side chunk projection or proof of its identity-set and compatible-map algebra. The older
claim that content addressing alone makes arbitrary hash-to-bytes union commutative needed to be
made precise without assuming cryptographic injectivity.

## What changes

1. Add an executable finite chunk-identity projection joined by union.
2. Add an executable finite hash-to-bytes map with existing-left-biased merge.
3. Prove unconditional identity-set C1 laws and compatible-map C1 laws.
4. Add a named collision-free-premise bridge and adversarial collision counterexamples.
5. Route source/tests through default Lean trust roots, update formal status, and regenerate
   Graphify after the theorem gate is complete.

## Non-goals

- Full `CheckpointStore.save` idempotence, manifests, sequences, metadata, or reconstruction.
- Prune, C2a/C2b, reachability, grace windows, garbage collection, or liveness.
- PostgreSQL, transactions, concurrency, SHA-256 security, collision rejection, or refinement.
- Runtime implementation/test changes, a cross-language oracle, or dependency/toolchain changes.

## Impact

The sprint adds Lean source/tests, planning/specification records, status updates, and regenerated
knowledge-graph artifacts. It preserves the runtime API and pinned toolchain. The completed claim
is C1 for the abstract save-only chunk projection, not verification of the PostgreSQL adapter or
complete checkpoint lifecycle.
