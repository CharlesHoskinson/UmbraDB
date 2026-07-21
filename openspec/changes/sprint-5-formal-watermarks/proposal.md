# Proposal — Sprint 5: Lean M3a Watermarks W1

> **Status:** Proof implementation complete; integrated close-out validation and the final
> exact-commit three-persona audit remain pending.

## Why

The abstract per-key TemporalKV M1/M2 tranche is complete. The detailed formal roadmap schedules
M3 simple stores next, beginning with Watermarks Law W1 before CheckpointStore C1/C2 and before
keyed transaction or PostgreSQL refinement work. Before this sprint, the Lean project had only a
generic `Function.update` API smoke theorem and no verified Watermarks domain model.

## What changes

1. Add an executable pure Watermarks store indexed by the exact `(kind, key)` address.
2. Define unconditional `set`, optional `get`, and ordered execution of finite set-command traces.
3. Prove same-address overwrite/idempotence, distinct-address isolation/commutation, trace
   composition, and last-matching-command lookup characterization.
4. Add adversarial contract examples and route all new modules through the default Lean trust
   roots.
5. Update formal status documentation and Graphify only after the theorem gate is complete.

## Non-goals

- CheckpointStore C1/C2, GC, keyed TemporalKV, transaction/lease models, or SQL refinement.
- Runtime Watermarks changes or duplicate Postgres property tests.
- JSON, bigint, top-level-null, `updated_at`, HOT, or transaction-handle semantics.
- A cross-language oracle or any claim that Lean proves the PostgreSQL adapter.

## Impact

The sprint adds only Lean source/tests, formal planning/specification records, status updates, and
regenerated knowledge-graph artifacts. It preserves the pinned toolchain and the existing runtime
API. The resulting theorem boundary is the pure W1 behavior that the adapter is expected—but not
mechanically proved—to refine.
