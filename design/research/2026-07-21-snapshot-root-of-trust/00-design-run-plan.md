# Verifiable wallet-state snapshot — design run

Feature: a **root of trust for the persisted wallet-state snapshot** so a wallet can restore from
UmbraDB (local or remote/untrusted) WITHOUT replaying the chain, by proving the snapshot is correct
for a declared **finalized-checkpoint horizon**. Branch: `feature/verifiable-snapshot` (worktree off
`main`, isolated from the Sprint 7 DB-core work).

## Core design principle (owner-set)
The proof certifies "snapshot S is the complete, correct wallet state as of FINALIZED block N" — not
as of the tip. Because the chain is append-only and finality precludes rollback of blocks ≤ N, the
certificate is **permanently valid** for horizon N. On restore: verify the proof, then catch up
`[N, tip]` LIVE (ADS-authenticated). Each proven finalized checkpoint is a cryptographically-certified
"birthday floor" the wallet never rescans below again — stronger than Zcash's *trusted* birthday.

## Emerging layered architecture (to be confirmed by the design council)
- **L0 Anchor** — snapshot carries `{finalized height N, blockHash, tree endIndex/frontier, R_N}`.
- **L1 Bounded-scan completeness (ADS)** — authenticated range/frontier proof over `[endIndex_N,
  endIndex_tip)` vs the on-chain root; shielded ADS largely already exists (collapsed-tree updates),
  unshielded needs a new authenticated by-address index. (Brief 06 found two residual holes —
  ciphertext-downgrade + spend-hiding — that reduce to a node/protocol change; council must decide
  ship-now-with-Zcash-parity-residual vs. block on a node feature.)
- **L2 Remote/untrusted-DB hardening** — client-side AES-GCM (seed-derived key) + monotonic
  anti-rollback/freshness.
- **L3 Self-certification** — offline lightweight ZK proof (frozen-checkpoint statement) and/or the
  on-chain Compact "Attested Manifest Root" contract; possibly recursive/IVC to ratchet checkpoints
  in O(1).
- **Delivery** — SDK PR (anchor field + `restoreVerified()` + `SnapshotStorage`) + indexer PR (anchor
  fields on ledger events + authenticated unshielded index).

## Research briefs
- 01 Midnight state commitments · 02 prior-art checkpoint sync · 03 authenticated-snapshot integrity ·
  04 SDK+indexer integration surface · 05 Compact-attestation brainstorm · 06 ADS bounded-scan
  (all first-sweep, done).
- 07 ZK self-certified proof (frozen-checkpoint statement) — in flight.
- **Second sweep (this run):** 08 recursive/incremental proofs (IVC/folding checkpoint ratchet) ·
  09 shielded-wallet-sync trust (Penumbra view service, Zcash, Aztec, Namada; OMR/detection keys) ·
  10 GRANDPA finality light-client (verify N's finality + R_N trustlessly) · 11 non-ZK alternatives
  (TEE, verifiable DBs, transparency-log checkpoints, DA/erasure coding).

## Pipeline (sprint methodology)
1. Deep research (01-11) — in progress. 2. **Design council** — distinct-angle design agents +
**Codex gpt-5.6-sol** + Opus + Fable, with a **correctness-audit spec gate** that must confirm the
design before any implementation. 3. openspec change (`proposal/design/tasks/spec`) **with an explicit
post-implementation testing strategy**. 4. Then implement → audit → verify. No implementation starts on
a design the correctness gate hasn't confirmed.
