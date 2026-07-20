# Roadmap

Tracked in detail in [`design/tasks.md`](design/tasks.md) (34 tasks across
11 phases, each implemented and reviewed per-task before moving on — see
that file for the exact acceptance criteria per task). This page is the
public-facing summary.

## Milestone 0 — Design (current)

- [x] Proposal, schema design, and interface contract written and reviewed.
- [x] Interfaces implemented as real, typechecked TypeScript
  (`src/interfaces/`), not just prose.
- [x] Design cross-checked against production precedent from other
  blockchain-Postgres indexers (Sui, Aptos, Solana) and against Midnight's
  own real SDK interfaces and ledger primitives — several real gaps found
  and fixed before implementation started.
- [ ] Formal algebraic specification (`Formal/`) reviewed and, where
  warranted, mechanized (Lean) with proofs of the properties in
  `Formal/STORAGE_ALGEBRA.md`.

## Milestone 1 — Core implementation

Per `design/tasks.md` §§0–8: environment setup, then each module
(TemporalKV, CheckpointStore, Watermarks, Transaction/Lease) implemented
against its interface and design, with a differential state-equivalence
gate before anything is considered done — not just "its own tests pass,"
but verified equivalent to the reference behavior it's replacing.

## Milestone 2 — Cutover

Per `design/tasks.md` §§9–10: rewire real call sites onto UmbraDB, run a
live round-trip against a real network, then remove the storage engine
UmbraDB replaces from the environment it originated in.

## Milestone 3 — Standalone hardening

Not yet scoped in detail. Candidates: a documented migration path for
projects adopting UmbraDB fresh (not migrating from anything), a
`pg_cron`-independent retention strategy for environments where that
extension isn't available, and benchmark numbers against the workloads
UmbraDB is designed for (versioned reads, checkpoint dedup ratio, lease
contention under concurrent writers).

## Non-goals

- Not a general-purpose ORM or query builder — the interfaces are
  intentionally narrow (four modules, not "do anything with Postgres").
- Not a distributed or multi-node store. UmbraDB is designed for a single
  writer against a single Postgres instance; see
  `Formal/STORAGE_ALGEBRA.md` §6 for why a distributed-trust/Merkle layer
  was considered and deliberately left out for now.
