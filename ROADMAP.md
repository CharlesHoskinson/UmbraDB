# Roadmap

Tracked in detail in [`design/tasks.md`](design/tasks.md) (34 tasks across
11 phases, each implemented and reviewed per-task before moving on — see
that file for the exact acceptance criteria per task). This page is the
public-facing summary, and the target for everything below is **1.0.0**.

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
