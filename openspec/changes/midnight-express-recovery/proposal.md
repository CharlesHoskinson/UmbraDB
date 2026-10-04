# Midnight Express recovery profile — future release

## Why

Midnight Express needs crash-safe local processing, checkpoint/cursor recovery and durable inbox/outbox state for private workflows. UmbraDB already stores Midnight wallet state, temporal records and content-addressed checkpoints; extending that foundation avoids building a separate backend recovery engine for RFQ, invoice reconciliation and human-approved agent workflows.

## Proposed change

Add an opt-in MPE recovery composition over the existing primitives, strict durability enforcement, lease-bound transaction composition, protected recovery state and explicit replay/retention rules. Publish supported typed interfaces and reproducible crash/fault tests. Keep business authority, admission proofs and network delivery in Midnight Express.

Status: **design proposal, not implemented**. Target: a future additive release after the current 0.9.5 baseline, coordinated with existing post-1.0/1.1 tracks; exact version and schedule remain unset. This does not enlarge the frozen 1.0 scope or change package exports, migrations, current warnings, or release claims.

## Explicit non-goals

No distributed database, HA writer takeover, shared untrusted tenants, general SQL resolver export, chain indexer, GossipSub router, admission-proof verifier, arbitrary remote exactly-once execution, automatic contract authorization, or private mobile retrieval. No promise that historical backup restoration preserves erased ratchet keys. No completed MPE integration claim.

## Dependencies

- Existing checkpoint/cursor and transaction public surface.
- Post-1.0 cipher/key-custody and scoped chunk-addressing work, coordinated rather than duplicated.
- Midnight Express's application-owned authority, finality, expiry and privacy policy.
- Independent domain/adversarial/release audit before implementation and release.

See [design](design.md), [requirements](specs/mpe-recovery/spec.md) and [tasks](tasks.md).
