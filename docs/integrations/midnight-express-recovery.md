# Midnight Express backend recovery — future release

UmbraDB is the recommended future backend workflow recovery foundation for [Midnight Express](https://github.com/CharlesHoskinson/midnight-express). Its Midnight-aware checkpoint, cursor and temporal-store primitives fit institutional RFQ coordination, invoice reconciliation and human-approved agent workflows.

The proposed extension adds atomic local effect/dedup/checkpoint/cursor/outbox composition, strict commit durability, writer-ownership checks, authenticated encrypted restore and explicit retention/replay policies. It retains one trusted Node writer over PostgreSQL; Rust transport nodes and network storage remain outside the library.

**Status: design only.** Current package 0.9.5 does not implement this capability. Neither the 1.0 scope nor the current public API is changed by the proposal. Target version/schedule is unset; the work coordinates with post-1.0/1.1 cipher and scoped-addressing tracks.

- [Proposal and non-goals](../../openspec/changes/midnight-express-recovery/proposal.md)
- [Design, source reconciliation and trust boundaries](../../openspec/changes/midnight-express-recovery/design.md)
- [Fourteen proposed requirements](../../openspec/changes/midnight-express-recovery/specs/mpe-recovery/spec.md)
- [Implementation tasks and acceptance gates](../../openspec/changes/midnight-express-recovery/tasks.md)

The existing `saveAndAdvance(deps, walletId, networkId, data, cursor, opts)` remains a checkpoint-plus-cursor helper; it is not the future all-state-vector processing operation. Existing abstract Lean proofs and storage tests do not prove this new integration.
