# Proposal — Full-Chain Storage: Test Plan & Acceptance Criteria

> **Status:** Draft. This change does **not** implement, review, or fix the full-chain-storage
> schema or its ingestion/sync code. It is the merge gate those things must clear. The v1 schema
> (`design/full-chain-storage-design.md`, `src/postgres/migrations/005_chain_archive.ts`,
> `feature/full-chain-storage` @ `cb80f96`) went through a three-reviewer design-council audit
> (Fable 5, Opus, GPT-5.6 Sol) that found real issues; a schema revision (v2) is being drafted
> concurrently on `fix/full-chain-storage-schema-v2`. This spec is deliberately written against
> **observable properties and behaviors**, not v1's exact table/column names, so it remains the
> valid acceptance gate for whichever schema (v1, v2, or later) is eventually proposed for merge.

## Why this change exists

`design/full-chain-storage-design.md` is explicit that it is "decisive" about a v1 schema but
flags open questions for the design council (§9) — including one architectural tension with
`design/design.md` §0 it does not resolve. The council audit that followed found further,
concrete problems the design's own honest self-assessment did not surface:

1. A **fork-breaking primary-key bug**: `transactions`' PK is `(block_height, tx_hash)`
   (`design.md` §4.3) — it has no `block_hash` component. Two competing blocks at the same
   height that each carry a transaction with the same hash (a real possibility across a fork
   point, not a hypothetical) collide on insert. `blocks` itself got this right —
   `PRIMARY KEY (height, block_hash)` (§4.2) — `transactions` did not carry the same discipline
   through.
2. **Unenforced canonical-chain uniqueness**: `is_canonical boolean` (§4.2) is a bare column with
   no constraint stopping two rows at the same height both being `true`. The design states the
   invariant in prose ("§5: `is_canonical`/`status` on `blocks` is the only thing that changes on
   a reorg") but never shows a mechanism that rejects a violation at the database boundary.
3. **An untested replay-recoverability assumption.** §6's phasing table defers zswap,
   unshielded-UTXO, dust, bridge, and governance events entirely on the claim that each is
   "replay-recoverable from raw transaction bytes" once `chain_blobs`/`transactions` exist. No
   pass of this design — including its own live-devnet confirmation session (§3) — actually
   replayed a raw transaction into a reconstructed event and compared it against the indexer's
   independently-reported value. The claim is plausible; it is not demonstrated.
4. **`block_undo`** (§4.4) is built with an explicitly unspecified payload format, reserved for a
   projection table that does not exist yet — premature relative to anything that consumes it.
5. **Schema placement**: §9.1 flags, and does not resolve, whether this schema belongs alongside
   Tier 1's `tier1_wallet`-scoped migrations (000–004) at all, versus its own dedicated schema/
   migration lineage ("Tier 1.5") separate from both Tier 1 (wallet) and the already-planned
   Tier 2 (indexer-schema fork, `design/design.md` §0).

The v2 revision addresses these at the schema level, in a separate worktree/branch, concurrently
with this change. **This change's job is orthogonal**: define, in the repo's own EARS/openspec
convention, the falsifiable acceptance criteria and concrete test scenarios that the eventual
*implementation* (the real node-RPC/indexer-GraphQL ingestion and sync code that populates
whatever the final schema turns out to be) must satisfy before it merges to `main` — regardless
of which schema revision ships. Where a criterion below depends on a mechanism the schema
revision is itself still verifying empirically (e.g. exactly how canonical-chain uniqueness will
be enforced), the criterion states the required *observable behavior* (a conflicting insert is
rejected) rather than assuming a specific SQL construct.

## What this change is

- A new openspec change directory containing this proposal, a full EARS-format capability spec
  (`specs/full-chain-archive-verification/spec.md`) with ten numbered, falsifiable acceptance
  criteria (AC-1 through AC-10) and one or more concrete test scenarios per criterion, and a
  `tasks.md` breaking the eventual implementation into checkable steps that each cite the AC(s)
  they close.
- A `GATE.md` template for the eventual correctness-audit verdict, left genuinely unrun (no
  fabricated PASS/CONFIRM).

## What this change is NOT

- **Not a schema design or schema fix.** It does not touch `005_chain_archive.ts`,
  `full-chain-storage-design.md`, or any DDL. That is v2's job, on its own branch.
  Non-goal: adjudicating the v1 vs. v2 schema debate, the PK fix's exact shape, or the Tier-1.5
  placement question — this spec's criteria must hold against whichever answer the schema
  revision lands on.
- **Not an implementation.** No ingestion, sync, or replay code is written here. `tasks.md`
  describes the work; it does not do it.
- **Not a merge to `feature/full-chain-storage` or `main`.** This lands only on
  `spec/full-chain-storage-acceptance-criteria`.
- **Not a resolution of `design.md` §9's open questions** (Tier-1/Tier-2 placement, partition
  bucket sizing, `chain_blobs` partitioning, contract-state validation). Those stay the schema
  revision's and the design council's to answer; AC-6 and AC-9 below test whatever answer they
  land on rather than assuming one.
- **Not a live cross-validation run.** AC-8 defines what that run must prove once the from-source
  node/indexer/proof-server stack is operational against a public testnet; it does not perform
  that run (there is no such stack available to this change).

## Impact

- **New**: `openspec/changes/full-chain-storage-acceptance-criteria/{proposal.md,tasks.md,GATE.md,
  specs/full-chain-archive-verification/spec.md}`.
- **Modified**: nothing under `src/`, `design/`, or any other openspec change directory.
- **Consumed by**: whichever branch eventually carries the real full-chain-storage
  implementation — its `tasks.md` phase 0 should point at this change's spec as its acceptance
  gate, the same way Sprint 9's plan-confirmation gated Sprint 8's merge (`AGENTS.md`; this
  repo's rolling design-council-gate convention).
