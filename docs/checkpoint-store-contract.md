# Checkpoint-store composition contract — cursor ordering and replay

This document is the checkable contract for composing a **checkpoint write** with a **sync-cursor
advance** (a watermark). It is authoritative for callers of `PgCheckpointStore.save`,
`PgWatermarks.set`, and the `saveAndAdvance` combinator. It cites
`Formal/STORAGE_ALGEBRA.md` **Law W1** (watermarks are last-write-wins; monotonicity is explicitly
*not* a law there — ordering safety is a composition contract, stated here, not an algebraic
guarantee of `set`).

Requirement: `openspec/changes/v1.0.0-durable-checkpoint-cursor/specs/durable-composition/spec.md`
— "a conforming composition keeps the durable cursor from ever being ahead of durable checkpoint
data".

## 1. The invariant: the cursor is never ahead of its data

A sync cursor (watermark) names how far a checkpoint has progressed. The safety invariant is:

> The durable cursor MUST NOT reference checkpoint data that is not itself durable.

A cursor that is **ahead** of durable data is the silent-skip failure: on resume the sync believes
it has already persisted data that a crash actually lost, and never re-fetches it. A cursor that is
**behind** durable data is the safe, recoverable direction: on resume the sync re-applies a bounded
window of already-durable writes and converges.

## 2. The two conforming compositions

### 2.1 Atomic co-commit (preferred): `saveAndAdvance` or one shared `tx`

Persist the checkpoint and advance the cursor **in one transaction**, so both become durable at the
same commit or neither does:

- `saveAndAdvance(deps, walletId, networkId, data, cursor, opts?)` opens one
  `TransactionLeaseLayer.withTransaction`, calls `save(..., { tx })` then `set(..., { tx })` on the
  same handle, and commits both together.
- Equivalently, a caller may open its own `withTransaction`, thread the same `tx` into
  `save(..., { tx })` and `watermarks.set(..., { tx })`, and let that transaction commit.

On this path the cursor **cannot** be ahead of its data: a crash before the single commit leaves
neither durable.

### 2.2 Manual composition: advance the cursor **strictly after** the data commits

A caller who does not use `saveAndAdvance` and does not share one `tx` MUST advance the cursor
**strictly after** the checkpoint's data transaction has committed:

1. Commit the checkpoint's data transaction (`save` with no `tx`, or the caller's own tx).
2. **Only after step 1 has committed**, advance the cursor in a separate transaction
   (`watermarks.set`).

A crash anywhere in that sequence then yields, at worst, a **watermark-behind-data** state (the
cursor is the previous value while the newer checkpoint is already durable) — the recoverable
direction. It MUST NOT be the reverse (cursor-first) ordering, which is the silent-skip failure.
The durable cursor is therefore always either the previous value or the new value, and in neither
case references a checkpoint that was not persisted.

## 3. Replay convergence is judged on CURRENT state

Because `TemporalKV.put` upserts are **version-bumping** (each write appends a new version to that
key's history), while `watermarks.set` is **last-write-wins overwrite with no version and no
history** (Law W1 — `src/postgres/watermarks.ts` writes a single-row `ON CONFLICT … DO UPDATE`
upsert), a watermark-behind replay re-applies already-durable writes and so produces **spurious
`kv_history` rows and version gaps in TemporalKV** versus a fault-free run — the watermark row
itself carries no such lineage; it is simply overwritten again to the same value. Replay
convergence is therefore defined on **current state**, not on history chains:

> Two runs converge iff their **current** state matches — the `kv_current` values, the latest
> complete checkpoint payload, and the watermark values — explicitly excluding `kv_history` rows
> and `version` columns.

Resuming from the durable cursor reproduces the reference **current** state; it does not, and is not
required to, reproduce an identical history chain.

## 4. Cross-reference

- `Formal/STORAGE_ALGEBRA.md` **Law W1** — Watermarks are idempotent last-write-wins; monotonicity
  is deliberately not a law, so cursor-vs-data ordering safety is this composition contract's
  responsibility, not `set`'s.
- Crash-level verification of the manual-composition ordering (an unclean postmaster kill between
  the data commit and the cursor advance, under `synchronous_commit` on **and** off) is delivered by
  **T5** in the testing-gate change (G9–G12); this contract and the `saveAndAdvance` API are its
  precondition (acceptance A11).
