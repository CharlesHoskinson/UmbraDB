# Roadmap

Tracked in detail per-module as `openspec/changes/sprint-N-<module>/` changes (proposal/design/
tasks/spec, EARS-format requirements, each reviewed by an Opus panel + Fable 5 consolidation and
a Codex GPT-5.6 Sol audit before implementation) — Sprint 1 is archived under
`openspec/changes/archive/`, while the completed and merged Sprint 2 Transaction/Lease, Sprint 3
CheckpointStore, Sprint 4 Watermarks, Sprint 7 TransactionHistory, and Sprint 8 wallet-state
envelope persistence records remain under `openspec/changes/` pending archival. The next work is
the cross-cutting formal, testing, equivalence, and performance program.
[`design/tasks.md`](design/tasks.md) is the
ORIGINAL task breakdown from before this project split into its own repo and is now retired/superseded —
see that file's own supersession note; it is kept only as a historical phase-number map, not a
source of task detail. This page is the public-facing summary, and the target for everything
below is **1.0.0**.

## Milestone 0 — Design (completed baseline)

- [x] Proposal, schema design, and interface contract written and reviewed.
- [x] Interfaces implemented as real, typechecked TypeScript
  (`src/interfaces/`), not just prose.
- [x] Design cross-checked against production precedent from other
  blockchain-Postgres indexers (Sui, Aptos, Solana) and against Midnight's
  own real SDK interfaces and ledger primitives — several real gaps found
  and fixed before implementation started.
- [x] Schema/composition gaps found by that audit fixed and re-reviewed
  (schema isolation, temporal-coherence enforcement, private-state key
  structure, composition notes).

## Milestone 1 — Formal (`Formal/`, in progress)

- [x] Algebraic specification written: TemporalKV as an event-sourced
  monoid action, CheckpointStore as an idempotent join-semilattice with a
  GC reachability-closure invariant, Watermarks as deliberate
  last-write-wins, Transaction/Lease as a trace-based mutual-exclusion
  property — each law marked GUARANTEED (enforced today) or ASPIRATIONAL
  (intended, not yet enforced).
- [x] Lean 4 + mathlib mechanization research reviewed, toolchain pinned, and
  trust/no-placeholder gates integrated into the default build and CI.
- [x] Abstract per-key TemporalKV kernel mechanized: transition preservation,
  replay and addressing laws, extensional T5 validity coverage, executable
  prefix retention, unavailable-history classification, and retention-aware T3.
- [x] Abstract Watermarks W1 mechanized over complete `(kind, key)` addresses:
  overwrite/idempotence, distinct-address commutation and framing, trace
  composition, and final-matching-command lookup with initial fallback.
- [x] M3b CheckpointStore C1: complete (abstract save-side projection only).
  Finite chunk identities form an unconditional join; byte-bearing maps are
  existing-left-biased and commute only under explicit compatibility, with a
  local collision-free-on-bound-values bridge. The runtime position-key fix is
  implemented, while ordered reconstruction remains a future Lean theorem.
- [ ] Extend the mechanized model to Checkpoint C2a/GC, collision handling,
  ordered reconstruction, keyed transactions, lease traces, and concrete
  PostgreSQL/runtime refinement obligations.

## Milestone 2 — Core implementation (module implementations complete)

Per `design/tasks.md` §§0–8: environment setup, then each module
(TemporalKV, CheckpointStore, Watermarks, Transaction/Lease) implemented
against its interface and design, with a differential state-equivalence
gate before anything is considered done — not just "its own tests pass,"
but verified equivalent to the reference behavior it's replacing.

- [x] TemporalKV (`sprint-1-setup-and-temporal-kv`, archived) — Postgres
  adapter, migrations, and test suite; merged to `main` after a 5-round
  cross-vendor re-audit cycle.
- [x] Transaction/Lease (`sprint-2-transaction-lease`) — `PgTransactionLeaseLayer`
  (`withTransaction`, `acquireLease`/`tryAcquireLease`/`releaseLease`/`withLease`),
  the cross-module transaction-handle registry, and `PgTemporalKV`'s
  `opts.tx` wiring.
- [x] CheckpointStore (`sprint-3-checkpoint-store`) — `PgCheckpointStore`
  (`save`/`load`/`history`/`prune`), content-addressed chunking with global
  cross-wallet dedup, the two-step manifest-prune-then-chunk-reclaim GC
  pass, `manifest_hash` write-time computation and load-time
  re-verification, and REPEATABLE READ-wrapped `load`/`history` reads for
  snapshot consistency against a concurrently-committing `prune`; 133/133
  tests passing (unit + P6-P8 property tests) after a 3-round Opus panel +
  Fable 5 consolidation + 4-round Codex GPT-5.6 Sol audit on the spec, then
  a 2-auditor (spec-compliance + code-quality) review of the implementation.
- [x] Watermarks (`sprint-4-watermarks`) — `PgWatermarks` (`set`/`get`), the
  single `fillfactor = 90` `watermarks` table with no secondary index (a
  hard HOT-eligibility invariant), the top-level-null application-level
  guard, the large-integer-as-decimal-string caller convention, and
  `resolveTransaction`-based `opts.tx` composition (no dedicated lease
  layer needed); 155/155 tests passing project-wide (23 new: 22 unit + P9
  property test) after a research-round-informed draft, 3-round Opus panel
  + Fable 5 consolidation + Codex GPT-5.6 Sol audit on the spec, then a
  2-auditor (spec-compliance + code-quality) review of the implementation
  plus a final whole-sprint differential-review gate. This completes all
  four modules in this milestone's checklist — see the note below on what
  that does and doesn't mean for Milestone 2 as a whole.

**Note:** all four modules above now have their own implementation done
and reviewed, but per this milestone's own opening framing ("not just
'its own tests pass,' but verified equivalent to the reference behavior
it's replacing"), the differential state-equivalence gate itself is a
separate, still-outstanding cross-cutting item — see Milestone 3 and the
1.0.0 checklist below, where it's tracked jointly with Milestone 3, not
resolved by this or any single sprint.

## Milestone 3 — Testing (current)

- [ ] The property-based test suite (P1–P10) derived directly from
  `Formal/STORAGE_ALGEBRA.md` §5 — implemented in TypeScript against real
  Postgres (via Testcontainers, `design/design.md` §8), not mocked.
- [ ] **Full sync test** — exercise the storage layer through an entire
  realistic sync run (not a unit-test-sized fixture): sustained writes,
  checkpoint cadence, GC passes, and lease contention at a scale that
  resembles real wallet-sync duration and data volume.
- [ ] **Retrieval correctness under load** — targeted tests that read back
  (`get`, `getAt`, `load`, `loadAt`) data written earlier in the same run
  and assert byte-for-byte/value-for-value correctness, including
  point-in-time reads that must reconstruct a past state exactly.
- [ ] **Cold-start survival** — kill the process (and, separately, kill
  Postgres) mid-operation and verify the next start recovers cleanly:
  leases don't wedge, in-flight transactions don't leave partial state
  visible, and sync resumes from the last durable checkpoint/watermark
  rather than corrupting or silently skipping data.
- [ ] Differential equivalence gate (`design/design.md` §10) as the
  release-blocking acceptance test for the underlying cutover this project
  originated from.

## Milestone 4 — Performance (`Performance/`)

The last major workstream before 1.0.0. Scope: profiling (where does time
actually go — query-level and storage-module-level), benchmarking
(repeatable, versioned measurements of UmbraDB's actual workloads —
versioned KV throughput/latency, checkpoint save/load/dedup ratio at
realistic scale, GC pass duration as the chunk store grows, lease
contention under concurrent writers), and DB activity logging (structured,
correlatable logs tying an application-level call to the SQL it issued and
how long that took). See `Performance/README.md`; being seeded by a
dedicated research pass before any tooling choice is locked in.

- [ ] Research pass on profiling/benchmarking/logging tooling for a local
  Postgres-backed storage layer, reviewed before adoption.
- [ ] Benchmark suite covering the workloads above, with baseline numbers
  recorded and re-run as a regression gate.
- [ ] Activity logging wired into all four modules, with a documented way
  to correlate a slow application-level call down to the SQL and query
  plan that caused it.

**Sprint 9** (`sprint-9-cleanup-perf-connection`) is this milestone's next planned change: retry/
idempotency semantics for transient connection errors, a finality-vs-per-address-cursor
correctness split, a noise-floor-aware benchmark gate, and storage-client hygiene, folding in
Sprint 8's D8-1..D8-4 audit deferrals. Its plan is written and gate-confirmed (Opus
correctness-audit CONFIRM verdict, 2026-07-21); implementation has not started.

## Milestone 5 — Cutover

Per `design/tasks.md` §§9–10: rewire real call sites onto UmbraDB, run a
live round-trip against a real network, then remove the storage engine
UmbraDB replaces from the environment it originated in.

## 1.0.0 acceptance checklist

A 1.0.0 tag requires all of:

- [ ] Formal spec's tractable properties proved in Lean, not just stated.
- [ ] P1–P10 property tests green against real Postgres.
- [ ] Full sync test, retrieval-correctness tests, and cold-start-survival
  tests all green.
- [ ] Differential state-equivalence gate green (Milestone 2/3).
- [ ] Performance benchmark baseline recorded, with no regression against
  it introduced by anything landed after the baseline was set.
- [ ] Live round-trip against a real network (Milestone 5) succeeds.

## Beyond 1.0.0 — additional tracks in progress

These sit outside the 1.0.0 checklist above (they extend scope rather than complete it) and are
**not yet merged into `main`**. Listed here for visibility; each has its own branch and review
history.

- **Full-chain archival storage** (`design/full-chain-storage-design.md` on
  `feature/full-chain-storage-implementation`, branched from `main` after Sprint 8). A
  content-addressed, indexer-independent archive for raw block/tx/blob payloads — a new
  `chain_archive` schema and migration lineage (`blocks`, `transactions`, `bridge_observations`,
  `chain_blobs`/`chain_blob_roles`, `verifier_key_observations`, height-range partitioning with a
  documented rollover procedure) plus a `chain-archive-sync` ingestion service (node-RPC and
  indexer-GraphQL sources, transaction replay decoding against the real ledger WASM package). The
  design went through four audited revisions (v1–v4) before implementation; the implementation
  itself has been through a 3-reviewer sprint-fix round and a Codex GPT-5.6 Sol audit-fix round
  (most recently closing findings 1–7, with the full test suite passing locally and two
  preprod-gated suites self-skipping outside that environment). Substantial and reviewed, but
  still unmerged, still on its own branch, and not confirmed to have cleared a final review round.
- **Verifiable wallet-state snapshot root-of-trust** (`design/verifiable-snapshot-design.md`, on
  `fix/verifiable-snapshot-v2`, previously `feature/verifiable-snapshot`). A design for
  authenticating wallet-state snapshots against on-chain data (liveness/anti-rollback beacons,
  manifest authentication, historical restore). **Design only — no implementation exists yet.**
  At v9 after eight rounds of adversarial design-council review; the document itself says it is
  "ready for a ninth review pass before implementation begins."
- **BitTorrent-based alternative retrieval / bootstrap trust**
  (`design/network-torrent-bootstrap-design.md`, on `feature/network-torrent`). A design for an
  `rqbit`-based BitTorrent retrieval path plus a PKI-rooted bootstrap-trust scheme, meant to
  compose with full-chain archival storage above rather than define its own blob schema.
  **Design only — no implementation exists yet.** One design-council review round complete (a v1
  draft sent back unanimously for rework, since revised); not yet re-reviewed.
- **Committee-certification research** (`research/mithril-committee-certification`). A research
  note (explicitly not a design-council-ready proposal) evaluating whether a Mithril-style
  threshold-signature committee certification, using Midnight's own consensus committee, could
  fill the cold-bootstrap trust gap between the two designs above. Informational only; identifies
  a real blocker (Midnight does not currently persist per-epoch committee stake weight) and does
  not recommend adoption.
- **Nix dev-environment flake** (`nix/midnight-env/`, on an unmerged, not-yet-pushed feature
  branch). See [Getting started](README.md#getting-started) in the README for what it provides.

## Non-goals

- Not a general-purpose ORM or query builder — the interfaces are
  intentionally narrow (five modules, not "do anything with Postgres").
- Not a distributed or multi-node store. UmbraDB is designed for a single
  writer against a single Postgres instance; see
  `Formal/STORAGE_ALGEBRA.md` §6 for why a distributed-trust/Merkle layer
  was considered and deliberately left out for now.
