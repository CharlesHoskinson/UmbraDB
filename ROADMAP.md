# Roadmap

Tracked in detail per-module as `openspec/changes/sprint-N-<module>/` changes (proposal/design/
tasks/spec, EARS-format requirements, each reviewed by an Opus panel + Fable 5 consolidation and
a Codex GPT-5.6 Sol audit before implementation) — see `openspec/changes/sprint-1-setup-and-temporal-kv/`
for the completed, implemented example and `openspec/changes/sprint-2-transaction-lease/` for the
next one, in review as of this writing. [`design/tasks.md`](design/tasks.md) is the ORIGINAL
task breakdown from before this project split into its own repo and is now retired/superseded —
see that file's own supersession note; it is kept only as a historical phase-number map, not a
source of task detail. This page is the public-facing summary, and the target for everything
below is **1.0.0**.

## Milestone 0 — Design (current)

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

## Milestone 1 — Formal (`Formal/`)

- [x] Algebraic specification written: TemporalKV as an event-sourced
  monoid action, CheckpointStore as an idempotent join-semilattice with a
  GC reachability-closure invariant, Watermarks as deliberate
  last-write-wins, Transaction/Lease as a trace-based mutual-exclusion
  property — each law marked GUARANTEED (enforced today) or ASPIRATIONAL
  (intended, not yet enforced).
- [ ] Research into mechanizing this in Lean 4 + mathlib, reviewed before
  any Lean code is written.
- [ ] Lean formal specification of the algebra, with the properties judged
  tractable actually proved (not just stated) — see `Formal/` once this
  lands.

## Milestone 2 — Core implementation

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

## Milestone 3 — Testing

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

## Non-goals

- Not a general-purpose ORM or query builder — the interfaces are
  intentionally narrow (four modules, not "do anything with Postgres").
- Not a distributed or multi-node store. UmbraDB is designed for a single
  writer against a single Postgres instance; see
  `Formal/STORAGE_ALGEBRA.md` §6 for why a distributed-trust/Merkle layer
  was considered and deliberately left out for now.
