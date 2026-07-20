# Proposal — Sprint 1: project setup + TemporalKV

## Why

This is the first implementation sprint of UmbraDB. Everything so far
(`design/`, `Formal/`) is design — reviewed, but unbuilt. Per project
direction, the first sprint is itself a comprehensive, Opus-reviewed
OpenSpec document (this change), not code — the actual implementation
(a Sonnet builder against this spec, with two parallel Opus auditors per
task) starts only after this proposal, design, and task breakdown are
written and pass review, matching the review discipline already applied to
every design document in this repository.

Scope: the two earliest task groups from `design/tasks.md`'s original
11-phase plan (§0 Environment setup, §1 TemporalKV), rewritten here with
implementation-level detail that plan never had (exact package structure,
exact migration mechanism, exact test harness wiring) — and updated for one
material fact that plan predates: **UmbraDB is now its own repository, not
a module inside `midnight-dev-env`.** Every reference in `design/tasks.md`
to "the environment," "counter-cli-additions," or a shared devcontainer
assumed implementation happened in-place inside `midnight-dev-env`. It
doesn't anymore. This sprint's environment-setup task is scoped to
UmbraDB's own repo and its own CI/dev-local Postgres, full stop — the
eventual consumption of UmbraDB *by* `midnight-dev-env` (rewiring
`counter-cli-additions/*.ts` onto it, per that project's own
`postgres-jsonb-storage` change, §9-§10) is a downstream integration
concern for `midnight-dev-env`'s own repo to handle when UmbraDB reaches a
version it can depend on, not something this sprint or this repository's
task list owns.

## What changes

1. **Project setup**: a real, provisioned local Postgres for development
   (native install, not a from-source Nix build — that specific mistake is
   already documented in the parent project's history and must not be
   repeated here); `postgres.js` added as a real dependency with its actual
   `.d.ts` surface verified against what `design/design-interfaces.md` §1.3
   and `design/design.md` §5/§7 assume (`sql.reserve()`, `sql.begin()`,
   tagged-template generics); a test-infrastructure decision recorded
   (Testcontainers, per `design/design.md` §8's recommendation); a schema/
   migration-application mechanism chosen and wired into
   `npm run`-invokable scripts.
2. **TemporalKV**: the Postgres implementation of the already-written,
   already-typechecked `TemporalKV` interface
   (`src/interfaces/temporal-kv.ts`) against the schema in
   `design/design.md` §2 (including its `tstzrange` + `GiST EXCLUDE`
   upgrade), satisfying the algebraic laws in `Formal/STORAGE_ALGEBRA.md`
   §1 (T1-T5) — with T2, T3, T5 covered by the property-based tests that
   spec already derives (P1-P5), not just unit tests of specific fixtures.

## Non-goals (explicitly out of scope for this sprint)

- CheckpointStore, Watermarks, and Transaction/Lease implementations —
  later sprints, each getting the same proposal→design→tasks→spec→review
  treatment before code, not bundled into this one.
- Any `midnight-dev-env` integration/cutover work — out of this repo's
  scope entirely, per "What changes" above.
- Lean formalization work (`Formal/LEAN_FORMALIZATION_PLAN.md`) — a
  parallel, independent workstream; TemporalKV's Postgres implementation
  does not block on or need to wait for Lean proofs to land, and vice
  versa.
- Performance/benchmarking instrumentation — `Performance/`'s own
  workstream (still gathering its second research round as of this
  writing); this sprint's TemporalKV implementation should be correct and
  tested, not yet benchmarked or instrumented.

## Impact

- **New in this repo**: `src/postgres/` (or similar — the design doc below
  proposes the exact layout) housing the Postgres adapter for
  `TemporalKV`, a `migrations/` directory with the versioned DDL, a
  `test/` suite (unit + the P1-P5 property tests), and the dev-setup
  scripts/docs needed to provision Postgres locally.
- **Risk**: `TemporalKV`'s `getAt({at: T})` correctness (Law T3,
  `Formal/STORAGE_ALGEBRA.md`) is the sprint's hardest acceptance bar — it
  requires an actual differential-against-replay test (P3), not just "the
  SQL looks right." Get this wrong now and it's the same class of bug the
  interface-design review already caught once (the cross-wallet chunk-GC
  bug) — subtle, plausible-looking, and only caught by an adversarial
  check, not code review alone.
- **Delivery**: Sonnet implementer against `design.md`/`tasks.md` below,
  two parallel Opus auditors per task (spec-compliance against this
  change's spec; code quality/docs/test coverage), matching the review
  cadence already used throughout this project's design phase.
