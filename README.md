# UmbraDB

A local, persistent datastore for [Midnight](https://midnight.network) clients: wallets, dev tooling,
and anything else that needs durable, versioned, content-addressed storage without running a
heavyweight database service of its own.

UmbraDB is PostgreSQL-backed (JSONB + `bytea`, no ORM, driven directly through
[`postgres.js`](https://github.com/porsager/postgres)). It is a **single-writer, local** store — not a
distributed database, not an ORM, and not a service you operate for other tenants.

```bash
npm install umbradb
```

```ts
import { createClient, runMigrations, PgTemporalKV } from "umbradb";

const sql = createClient({ connectionString: process.env.DATABASE_URL });
await runMigrations(sql);                       // forward-only; also runs the durability probe

const kv = new PgTemporalKV(sql);
await kv.put("wallet:balance", { night: "2000" });
const now  = await kv.get("wallet:balance");    // latest
const then = await kv.getAt("wallet:balance", { version: 3n });  // point-in-time
```

Everything is imported from the package root. There is no supported deep import — the `exports` map
exposes a single `"."`, and reaching into internals fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

> **Version 0.9.5.** Under SemVer, `0.y.z` carries **no compatibility guarantee yet**. The surface is
> already enumerated and drift-tested, but the *promise* not to break it lands at 1.0.0. See
> [Status](#status).

---

## Contents

- [What it does](#what-it-does) · [Why Postgres](#why-postgres) · [The five primitives](#the-five-primitives)
- [Durability and crash semantics](#durability-and-crash-semantics) · [Errors](#errors-and-retryability)
- [Verification: what is proved, checked, and tested](#verification-what-is-proved-checked-and-tested)
- [Schema and migrations](#schema-and-migrations) · [Performance](#performance-and-ceilings)
- [Security](#security) · [What UmbraDB is not](#what-umbradb-is-not) · [Status](#status)

---

## What it does

Five focused primitives, plus two capabilities built on them.

| Primitive | Purpose |
|---|---|
| **TemporalKV** | Versioned key-value store with point-in-time reads |
| **CheckpointStore** | Content-addressed, deduplicated, chunked snapshot storage with GC |
| **Watermarks** | Unversioned sync-progress cursors |
| **Transaction/Lease** | Real Postgres transactions + connection-pinned advisory locks |
| **TransactionHistory** | Per-wallet transaction history, GIN-indexed on identifiers |

| Capability | Built from |
|---|---|
| **WalletStateEnvelope** | `CheckpointStore` — persists a whole wallet-sync snapshot in one `save()` |
| **`saveAndAdvance`** | `CheckpointStore` + `Watermarks` — the co-transactional cursor primitive |

## Why Postgres

Client-side blockchain tooling tends to reach for MongoDB by default, then discovers it doesn't need
most of what that buys: sharding, flexible schema evolution across a large team, an aggregation
pipeline. What it actually needs is versioned reads, content-addressed dedup, a single-writer lease,
and a boring, well-understood storage engine everyone already has. Postgres gives you all of that
directly, with real ACID transactions instead of a replica-set-gated approximation.

---

## The five primitives

### TemporalKV — versioned KV with history

```ts
const kv = new PgTemporalKV(sql);

await kv.put("key", value);                          // append a new version
await kv.put("key", value, { expectedVersion: 4n }); // compare-and-swap
await kv.get("key");                                 // latest
await kv.getAt("key", { version: 3n });              // by version
await kv.getAt("key", { asOf: someDate });           // by timestamp
```

Every `put` appends a version; nothing is overwritten in place. `expectedVersion` makes the write a
CAS — a mismatch raises `VersionConflictError` rather than clobbering. Point-in-time reads are
addressable two ways (by version, or by wall-clock `asOf`), and the two agree for any successfully
persisted write.

**Retention.** History is prunable. Reads inside the retention window are exact; reads for a version
that has been pruned raise `HistoryUnavailableError` rather than silently returning a neighbour — an
unavailable answer is distinguishable from a wrong one.

### CheckpointStore — content-addressed snapshots

```ts
const store = new PgCheckpointStore(sql);

await store.save({ walletId, networkId, data });   // chunks, dedups, writes a manifest
await store.load({ walletId, networkId });         // newest
await store.history({ walletId, networkId });      // manifest list with sizes
await store.prune({ walletId, networkId, keep: 5 });
```

Large snapshots are split into fixed-size 4 MiB chunks, addressed by content hash, and shared through
a **global chunk pool** — identical chunks are stored once across all wallets. Each save writes a
manifest with a `manifest_hash` computed at write time and re-verified on load, so a corrupted or
partially-written manifest raises `ManifestCorruptError` instead of loading as truncated state.

**GC is two-step.** `prune` first removes manifests, then reclaims chunks no live manifest references,
subject to a 15-minute grace window. The window is deliberate: it guards against reclaiming a chunk
that an in-flight, not-yet-committed `save` is about to re-reference. Reads (`load`, `history`) run in
REPEATABLE READ so they stay consistent against a concurrently committing `prune`.

### Watermarks — sync cursors

```ts
const wm = new PgWatermarks(sql);
await wm.set("sync", "preprod", { height: "1807503" });
await wm.get("sync", "preprod");
```

Deliberately last-write-wins and unversioned — a cursor has no history worth keeping. Stored in a
single table at `fillfactor = 90` with **no secondary index**, which is a hard invariant: adding one
would break HOT update eligibility and turn the hottest write path in the system into a bloat source.

Large integers cross the boundary as decimal **strings**, not JS numbers, so a block height cannot
silently lose precision.

### Transaction/Lease — the control algebra

```ts
const tx = new PgTransactionLeaseLayer(sql);

await tx.withTransaction(async (handle) => {
  await kv.put("a", v1, { tx: handle });
  await kv.put("b", v2, { tx: handle });          // both, or neither
});

await tx.withLease("sync-writer", async () => {   // single-writer coordination
  // ...
});
```

This is the algebra the other modules run inside. `withTransaction` gives real atomicity across
primitives; `acquireLease` / `tryAcquireLease` / `releaseLease` / `withLease` give single-writer
coordination via **connection-pinned** advisory locks — the lease is held for the life of the
connection, with no TTL and no stealing.

`withLease` surfaces release faults rather than swallowing them: if the body succeeds but the release
fails, you get an `AggregateError`, not a silent success.

### TransactionHistory + WalletStateEnvelope

`PgTransactionHistoryStorage` mirrors the Midnight wallet SDK's `TransactionHistoryStorage`
interface — lifecycle-aware upsert/merge, identifier-subset pending-clear, GIN-indexed on a
denormalized `identifiers` array.

`PgWalletStateEnvelopeStore` persists a shielded/unshielded/dust wallet-sync snapshot as one
`CheckpointStore.save()`. It's a capability, not a sixth primitive: no table, no migration of its own.

---

## Durability and crash semantics

This is the part most storage layers get quietly wrong, so it's stated explicitly.

**The cursor never outruns the data.** `saveAndAdvance` writes a checkpoint and advances its watermark
**in one transaction**. Without that, a cursor can commit ahead of the checkpoint it points at, and a
crash leaves you resuming from a position whose data was never durable — a silent gap. This was the
single correctness blocker of the 1.0 program, and it is closed:

```ts
import { saveAndAdvance } from "umbradb";
await saveAndAdvance(sql, { checkpoint, watermark });   // atomic
```

**Startup asserts its own preconditions.** `runMigrations` runs a durability probe: it checks `fsync`,
`synchronous_commit` and `full_page_writes`, and makes a best-effort detection of a transaction
pooler sitting in front of Postgres — because a pooler silently breaks the session-scoped advisory
locks the lease depends on. A violation raises `DurabilityContractError` or
`TransactionPoolerDetectedError` at startup, not at 3 a.m.

**Failure is bounded.** Server-side `statement_timeout`, `lock_timeout` and
`idle_in_transaction_session_timeout` are set, and the migration lock acquire is bounded via a
transaction-scoped `SET LOCAL`, raising `MigrationLockTimeoutError` rather than hanging forever.

**Verified by killing it.** The crash suite kills the process *and*, separately, Postgres, mid-save —
including an **unclean** postmaster kill (SIGQUIT) followed by crash recovery, under both
`synchronous_commit = on` and `off`. Under `off`, losing a tail of acked commits is acceptable;
an inverted durability order is a failure. These run in required CI, enforced by test id, so a
re-introduced skip turns the build red by name rather than passing silently.

---

## Errors and retryability

Every error is a `StorageError` subclass with a stable `code` and a machine-readable `retryable`
field. **24 codes**, of which exactly four are retryable:

```
CONNECTION_ERROR · TRANSACTION_FAULT · LEASE_TIMEOUT · MIGRATION_LOCK_TIMEOUT
```

```ts
try { await kv.put(k, v); }
catch (e) {
  if (e instanceof StorageError && e.retryable) { /* safe to retry */ }
}
```

The catalog in [`docs/ERROR-CATALOG.md`](docs/ERROR-CATALOG.md) is not maintained by hand — a drift
test derives it from the exported classes with no hard-coded count, and fails CI if the table, the
CHANGELOG and the exported surface disagree.

**Known limitation:** Postgres `28xxx` authentication failures currently surface as a retryable
`ConnectionError`. Bound your retries accordingly. A distinct `AuthenticationError` is an additive
1.1 candidate — it was deliberately *not* added during the surface freeze, because a freeze freezes
the existing surface rather than adding behaviour to it.

---

## Verification: what is proved, checked, and tested

UmbraDB has a formal storage algebra ([`Formal/STORAGE_ALGEBRA.md`](Formal/STORAGE_ALGEBRA.md)) of
eleven laws. Three verification methods apply to it, and they are **not interchangeable**:

| Status | Method | Strength |
|---|---|---|
| `PROVED` | Lean 4 + mathlib, CI-gated | unbounded, for the abstract model |
| `MODEL-CHECKED` | Quint (planned — `v1.1.0-quint-model-checking`) | bounded — no counterexample up to N |
| `RUNTIME-TESTED` | P1–P10 property tests vs real Postgres | sampled, on the real adapter |

| Law | Status |
|---|---|
| T3 temporal projection, T5 coherence, W1 last-write-wins, C1 chunk semilattice | **`PROVED`** (the frozen 1.0 cut-line) |
| T1 per-key, T2 CAS, T4 dual-addressing | `PROVED` (in-tree) |
| C2a GC safety, L1 lease mutex | `RUNTIME-TESTED` only (P8, P10) — model checking planned |
| C2b eventual collection | mechanism tested; **liveness not verified** |
| T1 cross-writer | **OPEN** |
| abstract → PostgreSQL refinement | **unmechanized**, trusted |

Two things this table is careful about:

**`0 sorry` certifies depth, not breadth.** The Lean trust gate scans the whole tree for
`sorry`/`admit`/`axiom`/`unsafe`, then builds and independently re-checks every declaration. That
proves *what is stated* is proved. It cannot detect a law that was never stated.

**The refinement gap is real and deliberate.** No theorem relates any Lean definition to SQL DDL, a
trigger, `clock_timestamp()`, or the TypeScript adapter. Following the AWS TLA+ precedent, the
adapter is a trusted, unmechanized refinement, bridged empirically by the P1–P10 property tests
running against real Postgres via Testcontainers.

---

## Schema and migrations

Forward-only, lineage `000` → `006`, applied by `runMigrations` under a bounded advisory lock. There
is no down-migration: rolling back means restoring a backup. `schema` is a **namespace, not a
security boundary** — see [Security](#security).

Full reference: [`docs/SCHEMA.md`](docs/SCHEMA.md), contracts in [`docs/CONTRACT.md`](docs/CONTRACT.md).

## Performance and ceilings

A committed benchmark baseline (`bench/baseline.1.0.0-perf-baseline.1.json`) covers versioned KV
throughput/latency, checkpoint save/load/dedup ratio, GC pass duration as the chunk store grows, and
lease contention. Hot paths are batched: chunk and junction inserts are multi-row, and `history()`
is a single grouped query rather than N+1.

**No performance number gates a release** — only that a reproducible baseline exists. Documented
scalability ceilings (SC-1…SC-6) are in [`Performance/CEILINGS.md`](Performance/CEILINGS.md); the GC
anti-join curve is measured to 10⁶ chunks in the baseline artifact.

## Security

Read [`SECURITY.md`](SECURITY.md) before deploying. The load-bearing points:

- **Single trusted writer.** The threat model assumes one writer that is trusted.
- **`schema` is namespacing, not a tenant boundary.** Do not use it to isolate mutually distrusting
  parties.
- **No at-rest encryption.** This is a *binding deployer precondition*: anyone who can read the
  Postgres data files, a backup, or a replica reads your data in the clear. Encrypt the substrate.
- **Cross-wallet dedup is a side channel.** The global chunk pool means storing a chunk reveals
  whether an identical chunk already exists. Under the single-writer model both channels require
  already being the writer; per-wallet keyed chunking is a 1.1 item.

## What UmbraDB is not

- **Not an ORM or query builder.** Five narrow interfaces, not "do anything with Postgres".
- **Not distributed or multi-node.** Single writer, single Postgres instance.
- **Not multi-tenant.** See the schema/dedup caveats above.
- **Not a chain indexer.** It stores what a client gives it; it is deliberately indexer-agnostic.
- **Not encrypted at rest.**

---

## Status

**Current release: `0.9.5` — "Penumbra".**

All twenty gate items of the 1.0.0 program (G1–G20) are merged, across five OpenSpec changes covering
the public-surface freeze, durable checkpoint cursor, recovery testing, performance baseline and
security sign-off. `0.9.5` ships that code.

*An umbra is the total shadow; a penumbra is the partial shadow you pass through immediately before
totality. 0.9.5 is that phase — the surface is real, the SemVer promise is not yet binding. 1.0.0 is
"Totality".*

**What 1.0.0 additionally requires:** a full local sync of UmbraDB against Midnight — archive node →
local indexer → UmbraDB, end to end — demonstrated on infrastructure we run rather than a hosted
indexer we call. Progress and rationale: [`ROADMAP.md`](ROADMAP.md) § "What blocks 1.0.0".

**Next:** [Quint model checking](openspec/changes/v1.1.0-quint-model-checking/) for C2a, C2b, L1 and
cross-writer T1 — the concurrency and liveness laws a sequential proof model handles badly.

- Roadmap: [`ROADMAP.md`](ROADMAP.md) · Stability policy: [`docs/STABILITY.md`](docs/STABILITY.md)
- Changelog: [`CHANGELOG.md`](CHANGELOG.md) · Release records: [`docs/releases/`](docs/releases/)

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
