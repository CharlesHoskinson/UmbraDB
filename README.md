# UmbraDB

A local, persistent datastore for [Midnight](https://midnight.network)
clients — wallets, dev tooling, and anything else that needs durable,
versioned, content-addressed storage without running a heavyweight database
service of its own.

UmbraDB is PostgreSQL-backed (JSONB + `bytea`, no ORM) and provides four
focused primitives:

- **TemporalKV** — a versioned key-value store with point-in-time reads
  (`getAt`), for state that needs history.
- **CheckpointStore** — content-addressed, deduplicated, chunked storage for
  large periodic snapshots (e.g. wallet sync state), with integrity
  verification and reachability-based garbage collection.
- **Watermarks** — simple, unversioned sync-progress cursors.
- **Transaction/Lease** — a shared transactional substrate (Postgres native
  transactions + connection-pinned advisory locks) the other three compose
  on top of.

## Why

Client-side blockchain tooling tends to reach for MongoDB by default and
then discover it doesn't need most of what that buys — no sharding, no
flexible schema evolution across a large team, no aggregation pipeline.
What it does need — versioned reads, content-addressed dedup, a single
writer-lease, and a boring, well-understood storage engine everyone already
has — Postgres gives you directly, with real ACID transactions instead of
a replica-set-gated approximation of them.

## Status

Early. The storage interfaces (`src/interfaces/`) are written, typecheck
clean, and have been through a structured design review — but the Postgres
implementation behind them does not exist yet. See [`design/`](design/) for
the full design history and [`ROADMAP.md`](ROADMAP.md) for what's next.

## Design

- [`design/proposal.md`](design/proposal.md) — why this exists, what it
  replaces, and the scope of the initial build.
- [`design/design.md`](design/design.md) — concrete schema (DDL) for every
  module.
- [`design/design-interfaces.md`](design/design-interfaces.md) — the
  TypeScript interface contract: shared conventions (error handling, async
  patterns, validation), then each module's interface with full API docs.
- [`design/design-algebra.md`](design/design-algebra.md) — the algebraic
  structure each module is meant to satisfy (event-sourced monoid actions,
  idempotent join-semilattices, and which properties are currently
  guaranteed by a schema constraint versus merely intended), with a derived
  list of property-based tests.
- [`Formal/`](Formal/) — formal specification work in progress: precise
  type signatures and algebraic laws intended for eventual mechanized proof.

## Formal verification

Lean M1 is complete for the abstract per-key TemporalKV history model. The
kernel-checked slice covers successful version assignment and append behavior,
failed-write preservation, strict timestamp-invariant preservation, basic
version/time lookup characterizations, accepted-write replay, and agreement
between version and timestamp addressing. M2 derives bounded half-open validity
intervals plus the live tail, proves pairwise disjointness and exact horizon
coverage, and adds executable prefix retention. Retention-aware time and exact
version lookup distinguish absence from unavailable history, preserve original
versions and the live event, and agree with the complete M1 history throughout
the certified retained horizon.

Keyed-store lifting, SQL retention/refinement, runtime selector validation,
leases, garbage collection, and liveness remain deferred to later work. The
T3/T5 results concern the abstract per-key history; SQL constraints, pruning
atomicity, and trigger discipline remain external refinement obligations.
The small API smoke module checks imports and selected library theorem
contracts; it does not prove those later store models.
The default Lake build compiles those contracts and an elaborated-environment
audit that rejects new axiom declarations or project declarations outside the
approved `propext`, `Classical.choice`, and `Quot.sound` dependency set.

```powershell
Set-Location Formal/Lean
lake build
powershell -ExecutionPolicy Bypass -File scripts/check-trust.ps1
```

The committed manifest supplies the pinned dependency revisions. Run
`lake update` only when intentionally refreshing that manifest.

## Interfaces

```
src/interfaces/
  storage-errors.ts     shared error hierarchy
  transaction-lease.ts  transactions + writer leases
  temporal-kv.ts         versioned key-value store
  checkpoint-store.ts    content-addressed checkpoint persistence
  watermarks.ts          sync-progress cursors
```

```bash
npm install
npm run typecheck       # tsc --noEmit
npm run docs:storage    # generate API reference docs (TypeDoc) into docs/api/storage/
```

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
