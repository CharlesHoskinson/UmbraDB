# UmbraDB

A local, persistent datastore for [Midnight](https://midnight.network) clients: wallets, dev
tooling, and anything else that needs durable, versioned, content-addressed storage without
running a heavyweight database service of its own.

UmbraDB is PostgreSQL-backed (JSONB + `bytea`, no ORM, driven directly through
[`postgres.js`](https://github.com/porsager/postgres)) and provides five focused primitives:

- **TemporalKV**: a versioned key-value store with point-in-time reads (`getAt`), for state
  that needs history.
- **Transaction/Lease**: real Postgres transactions and connection-pinned advisory locks. A
  `withTransaction` combinator for atomic multi-key writes, and `acquireLease`/`withLease` for
  single-writer coordination. The other modules compose on top of it.
- **CheckpointStore**: content-addressed, deduplicated, chunked storage for large periodic
  snapshots (e.g. wallet sync state), with integrity verification and reachability-based garbage
  collection.
- **Watermarks**: simple, unversioned sync-progress cursors with transactional composition.
- **TransactionHistory**: per-wallet transaction history (`transaction_history`, GIN-indexed on
  a denormalized `identifiers` array), mirroring the Midnight wallet SDK's
  `TransactionHistoryStorage` interface with lifecycle-aware upsert/merge and identifier-subset
  pending-clear.

On top of these, `PgWalletStateEnvelopeStore` persists shielded/unshielded/dust wallet-sync
snapshots as a single `CheckpointStore.save()` call. It's a capability, not a sixth primitive:
it adds no table or migration of its own, reusing `CheckpointStore`'s existing chunk/manifest
storage entirely.

## Why

Client-side blockchain tooling tends to reach for MongoDB by default, then discovers it doesn't
need most of what that buys: sharding, flexible schema evolution across a large team, an
aggregation pipeline. What it actually needs is versioned reads, content-addressed dedup, a
single writer lease, and a boring, well-understood storage engine everyone already has. Postgres
gives you all of that directly, with real ACID transactions instead of a replica-set-gated
approximation of them.

## Architecture

Every module is a thin Postgres adapter behind a narrow, hand-written TypeScript interface, no
ORM or generated client. `Transaction/Lease` is the one module the others depend on. It's how a
caller wires a `TemporalKV.put()` and a `Watermarks.set()` into the same atomic commit, and it's
what coordinates a single writer across multiple application instances (on top of, not instead
of, Postgres's own transactions, constraints, and locking).

```
                        +--------------------------------+
                        |          Application           |
                        |  (wallet-sync, dev tools, or   |
                        |  anything embedding UmbraDB)   |
                        +--------------------------------+
                                         |
                 +-----------------------+-----+-----------------------------+
                 v                             v                             v
    +------------------------+    +------------------------+    +------------------------+
    |       TemporalKV       |    |    CheckpointStore     |    |       Watermarks       |
    |                        |    |                        |    |                        |
    |       put / get        |    |   content-addressed,   |    | sync-progress cursors  |
    | getAt (point-in-time)  |    |  deduplicated chunks   |    |                        |
    |        listKeys        |    |   + reachability GC    |    |                        |
    |                        |    |                        |    |                        |
    |     (implemented)      |    |     (implemented)      |    |     (implemented)      |
    +------------------------+    +------------------------+    +------------------------+
                 |                             |                             |
                 | opts.tx / internal composition (Transaction/Lease)        |
                 +-----------------------+-----------------------------------+
                                         v
                    +----------------------------------------+
                    |           Transaction/Lease            |
                    |                                        |
                    |    withTransaction() -> sql.begin()    |
                    |   acquireLease() / tryAcquireLease()   |
                    |            / releaseLease()            |
                    |             -> sql.reserve()           |
                    |       -> pg_advisory_lock(2, key)      |
                    |                                        |
                    |     handle registry (module-level;     |
                    |    resolves opts.tx across modules)    |
                    +----------------------------------------+
                                         |
                                         v
                      +------------------------------------+
                      |         postgres.js driver         |
                      |   no ORM -- tagged-template SQL    |
                      +------------------------------------+
                                         |
                                         v
                   +------------------------------------------+
                   |                PostgreSQL                |
                   |                                          |
                   |                kv_current                |
                   |  kv_history (via BEFORE UPDATE trigger)  |
                   |                                          |
                   |             advisory locks:              |
                   |           class 1 = migrations           |
                   |          class 2 = writer lease          |
                   |       class 3 = DDL serialization        |
                   +------------------------------------------+
```

A caller reaching for `opts.tx` on `TemporalKV.put()` or `Watermarks.set()` resolves that handle
through `Transaction/Lease`'s own registry (a module-level map, not a shared instance), so two
independently constructed adapters agree on which live `postgres.js` transaction a handle
actually refers to, with no dependency-injection container required. `CheckpointStore` is
different: its own methods compose `Transaction/Lease` internally rather than accepting a
caller-supplied handle, since a checkpoint save or prune is meant to be one atomic unit of work
on its own. An application can also call `withTransaction()`/`withLease()` directly, as the usage
example below does, without going through a data module at all.

The diagram above predates two later additions, both composing on top of what it already shows
rather than adding new architectural layers: `TransactionHistory` (its own `transaction_history`
table) resolves `opts.tx` through the same `Transaction/Lease` registry as `TemporalKV` and
`Watermarks`; `PgWalletStateEnvelopeStore` sits entirely above `CheckpointStore`, calling its
`save()`/`load()` as a regular caller would rather than touching Postgres directly, which is why
it needs no table of its own and no new box in the picture.

## Status

All five modules are implemented and merged:

- **TemporalKV** (Sprint 1): `put`/`get`/`getAt`/`listKeys` against a `kv_current`/`kv_history`
  schema, with a `BEFORE UPDATE` trigger populating history and a same-transaction key-reuse
  guard.
- **Transaction/Lease** (Sprint 2): `withTransaction` (real Postgres transactions, isolation
  levels, statement timeouts) and `acquireLease`/`tryAcquireLease`/`releaseLease`/`withLease`
  (connection-pinned advisory locks), wired into `TemporalKV`'s `opts.tx` parameter.
- **CheckpointStore** (Sprint 3): `save`/`load`/`history`/`prune`, content-addressed chunking and
  global deduplication, integrity verification, snapshot-consistent reads, and two-step
  manifest/chunk garbage collection.
- **Watermarks** (Sprint 4): transactional `set`/`get` sync cursors, with HOT-update-oriented
  storage settings and runtime guards for the opaque JSON progress value.
- **TransactionHistory** (Sprint 7): `PgTransactionHistoryStorage`, a Postgres-backed
  implementation of the Midnight wallet SDK's `TransactionHistoryStorage` interface
  (structurally mirrored, never imported) against its own `transaction_history` table --
  `gotPending`/`gotFinalized`/`gotRejected` upsert/merge, a GIN-indexed identifier-subset
  pending-clear query, and `opts.tx` composition through the same `Transaction/Lease` registry
  as `TemporalKV`/`Watermarks`.

Also merged, on top of the five modules above rather than as a sixth: **wallet-state envelope
persistence** (Sprint 8), `PgWalletStateEnvelopeStore` -- persists shielded/unshielded/dust
wallet-sync snapshots as one atomic `CheckpointStore.save()` call per `(walletId, networkId)`.
It adds no table or migration of its own; it's a thin wrapper over `CheckpointStore`'s existing
`ckpt_*` storage.

Every implemented module went through the same cycle before merge: draft an
[OpenSpec](https://github.com/Fission-AI/OpenSpec) change in EARS format, put it through several
independent review passes, fix what they find, and re-review until nothing new turns up. Every
sprint went through multiple review rounds and turned up genuine bugs: a race
in `CREATE EXTENSION` DDL serialization, a cursor-cancellation gap in `postgres.js`, a
connection-reservation wait with no timeout or abort handling, among others. That's the whole
point of running it this way instead of shipping on the first green test run.

Beyond the merged modules above, further work is active but **not yet merged into `main`** — see
[`ROADMAP.md`](ROADMAP.md) for current status on each:

- **Full-chain archival storage** (a `chain_archive` schema/migration lineage, content-addressed
  raw block/tx/blob storage independent of the indexer, plus a chain-archive-sync ingestion
  service): implemented on `feature/full-chain-storage-implementation`, through several
  design-council and Codex GPT-5.6 Sol audit-fix rounds, but still unmerged and not yet
  through a final review round.
- **Verifiable wallet-state snapshot root-of-trust** (`design/verifiable-snapshot-design.md`):
  design-only, no implementation yet, at v9 after eight design-council review rounds, on
  `fix/verifiable-snapshot-v2`.
- **BitTorrent-based alternative retrieval / bootstrap trust**
  (`design/network-torrent-bootstrap-design.md`): design-only, no implementation yet, one
  design-council review round in, on `feature/network-torrent`.

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

Lean M3a now adds an executable abstract Watermarks store over the complete
`(kind, key)` address and proves W1: unconditional overwrite, same-address
last-write-wins and state idempotence, distinct-address framing and commutation,
trace composition, and lookup by the final matching command with initial-store
fallback. The generic value layer also distinguishes an untouched address from
a stored null-like abstract value (`none` versus `some none`).

M3b CheckpointStore C1: complete (abstract save-side projection only). The Lean
model proves unconditional finite chunk-identity joins, existing-left-biased
finite-map merge laws, commutation for compatible maps, and a local
collision-free-on-bound-values compatibility bridge. It also executes the
same-hash/different-bytes order-dependence counterexample rather than assuming
SHA-256 injectivity. The runtime's corrected `(manifest_id, position)` key
preserves repeated ordered chunk references, but ordered reconstruction is a
future Lean theorem.

Keyed-store lifting, SQL retention/refinement and retention-floor error wiring,
Checkpoint C2a/GC, ordered reconstruction, collision handling, leases, and
liveness remain deferred. The T3/T5, W1, and C1 results concern abstract stores;
SQL constraints, pruning atomicity, triggers, JSON validation, timestamps,
transactions, and runtime refinement remain external obligations.
The small API smoke module checks imports and selected library theorem
contracts; it does not prove those later store models.
The default Lake build compiles those contracts and an elaborated-environment
audit that rejects new axiom declarations or project declarations outside the
approved `propext`, `Classical.choice`, and `Quot.sound` dependency set.

```sh
cd Formal/Lean
lake build
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/check-trust.ps1
```

The committed manifest supplies the pinned dependency revisions. Run
`lake update` only when intentionally refreshing that manifest.

See [`ROADMAP.md`](ROADMAP.md) for the full milestone breakdown (formal verification, the
property-test suite, performance benchmarking, and the eventual cutover) and
[`openspec/changes/`](openspec/changes/) / [`openspec/specs/`](openspec/specs/) for the
in-progress and completed module specs.

## Getting started

Requires Node 24+ and a real Postgres instance (local, containerized, or managed): the migrations
create the `btree_gist` extension, exclusion constraints, and trigger functions, so the connecting
role needs privileges for those, not just network reachability.

```bash
npm install
npm run typecheck        # tsc --noEmit
npm test                 # vitest run — spins up Postgres via Testcontainers, needs Docker
npm run docs:storage     # generate API reference (TypeDoc) into docs/api/storage/
```

A Nix flake at `nix/midnight-env/` composes pinned upstream Midnight flakes (`midnight-ledger`,
`midnight-wallet`, `midnight-dapp-connector-api`) with pinned Cardano release binaries
(`cardano-node`, `cardano-db-sync`), a pinned `midnight-node` release binary, and PostgreSQL into
one reproducible `devShell`, plus `start-stack`/`stop-stack`/`backup-state`/`restore-state` apps
for standing up and snapshotting a full local Midnight+Cardano stack. It's intended to become the
recommended path for environment setup, but it is still in development on an unmerged feature
branch and not yet part of `main` — the steps above remain the supported path until it lands.

```typescript
import { createClient } from "./src/postgres/client.js";
import { runMigrations } from "./src/postgres/migrate.js";
import { PgTemporalKV } from "./src/postgres/temporal-kv.js";
import { PgTransactionLeaseLayer } from "./src/postgres/transaction-lease.js";

const sql = createClient({ connectionString: process.env.DATABASE_URL, schema: "my_app" });
await runMigrations(sql, { schema: "my_app" });

const kv = new PgTemporalKV(sql);
const leases = new PgTransactionLeaseLayer(sql);

// Simple read/write — each call is its own transaction.
const entry = await kv.put("wallet", "default", "balance", { amount: 100 });
await kv.get("wallet", "default", "balance");
await kv.getAt("wallet", "default", "balance", { kind: "version", version: entry.version });

// Atomic multi-key write: both puts commit together, or neither does.
await leases.withTransaction(async (tx) => {
  await kv.put("wallet", "default", "balance", { amount: 90 }, { tx });
  await kv.put("wallet", "default", "last-tx", { id: "abc123" }, { tx });
});

// Single-writer coordination — one process at a time runs the critical section.
await leases.withLease("wallet-sync:mainnet", async () => {
  // ...sync work only one writer should be doing at once...
});

await sql.end();
```

## Design

- [`design/proposal.md`](design/proposal.md): why this exists, what it replaces, and the scope
  of the initial build.
- [`design/design.md`](design/design.md): concrete schema (DDL) for every module.
- [`design/design-interfaces.md`](design/design-interfaces.md): the original consolidated
  TypeScript interface contract (shared conventions, then each module's interface). This predates
  the per-module OpenSpec changes under [`openspec/changes/`](openspec/changes/), which are
  authoritative for anything actually implemented. See that file's own staleness notes where the
  two disagree.
- [`design/design-algebra.md`](design/design-algebra.md): the algebraic structure each module is
  meant to satisfy (event-sourced monoid actions, idempotent join-semilattices, and which
  properties are currently guaranteed by a schema constraint versus merely intended), with a
  derived list of property-based tests.
- [`Formal/`](Formal/): formal specifications plus the Lean 4 TemporalKV kernel, including
  retention-aware T3 and validity-chain T5 proofs, the abstract Watermarks W1 model/laws, and the
  abstract save-side CheckpointStore C1 projection; C2a/GC, ordered reconstruction, collision
  handling, leases, keyed transactions, and SQL/runtime refinement remain future milestones.
- [`openspec/`](openspec/): the actual, current source of truth for anything implemented.
  `openspec/specs/` holds requirements for sprints that have been archived after merge (currently
  just TemporalKV); `openspec/changes/` holds work still in progress or completed changes awaiting
  archival, currently including Transaction/Lease, CheckpointStore, Watermarks, TransactionHistory,
  and wallet-state envelope persistence with their historical proposal → design → tasks →
  EARS-format spec records.

## Layout

```
src/
  interfaces/
    storage-errors.ts      shared error hierarchy every module builds on
    transaction-lease.ts   transactions + writer leases (implemented)
    temporal-kv.ts         versioned key-value store (implemented)
    checkpoint-store.ts    content-addressed checkpoint persistence (implemented)
    watermarks.ts          sync-progress cursors (implemented)
    transaction-history-storage.ts   per-wallet transaction history (implemented)
    wallet-state-envelope.ts         WalletStateEnvelope codec (implemented)
  postgres/
    client.ts              connection factory (schema isolation, bigint typing)
    migrate.ts             schema-versioned migration runner
    migrations/            one file per migration, in order
    errors.ts              raw postgres.js errors -> the shared StorageError hierarchy
    abort.ts               shared AbortSignal helpers
    temporal-kv.ts         PgTemporalKV
    transaction-lease.ts   PgTransactionLeaseLayer + the cross-module handle registry
    checkpoint-store.ts    PgCheckpointStore + chunk integrity and garbage collection
    watermarks.ts          PgWatermarks transactional cursor storage
    transaction-history-storage.ts   PgTransactionHistoryStorage
    wallet-state-envelope.ts         PgWalletStateEnvelopeStore (wraps CheckpointStore, no own table)
test/
  postgres/                unit + property-based tests, run against real Postgres
                           (Testcontainers), not mocked
```

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
