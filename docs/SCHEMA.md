# UmbraDB Postgres Schema Reference

UmbraDB is a Postgres storage layer for the Midnight Network. Its core architectural rule is
that `src/postgres/*` (and `src/interfaces/*`) must never import the Midnight wallet SDK, and
must never depend on the indexer or any chain-sync/ingestion code — those are separate concerns
that live outside `src/` entirely. This is not just a convention: it is checked by automated
guard tests on every run (see [Boundary enforcement](#boundary-enforcement) below). Everything
described in this document is schema and storage-adapter code; no file discussed here talks to
a node, an indexer, or a wallet SDK type at runtime.

The database holds **two independent schema lineages**, each with its own migration history and
its own `<schema>._migrations` bookkeeping table:

| Lineage | Schema (conventional name) | Migrations | Status |
|---|---|---|---|
| **tier1_wallet** | `tier1_wallet` | `src/postgres/migrations/000_schema.ts` … `006_ckpt_chunks_size_bytes.ts` | `000`–`004` merged to `main`, in production use; `005_kv_current_fillfactor` + `006_ckpt_chunks_size_bytes` added by the `v1.0.0-perf-baseline` change |
| **chain_archive** ("Tier-1.5") | `chain_archive` | `src/postgres/migrations/chain_archive/001_chain_archive_core.ts` | **Not yet on `main`** — see note below |

> **Provenance note on `chain_archive`.** As of this writing, the `chain_archive` schema, its
> `ChainArchiveStore` interface, and its Postgres implementation exist only on the
> `feature/full-chain-storage-implementation` branch lineage (this document was written against
> its most-fixed descendant, `feature/full-chain-storage-implementation-fable-fix2`, commit
> `5bcbebe`) — they are not present on `origin/main` at the base commit this document was written
> against (`b1ecc53`). The design went through four rounds of adversarial, cross-vendor
> design-council audit (Fable 5 / Opus / GPT-5.6 Sol) before its current shape stabilized; this
> document describes only the **current, final state** of that design, not the audit history
> itself. Even once merged, the schema is a **design-stage artifact that nothing in this repo's
> application code wires up yet** — `chainArchiveMigrations` is exported but no call site invokes
> `runMigrations(sql, { schema: "chain_archive", migrations: chainArchiveMigrations })` today.

Both lineages are designed to live in **one Postgres instance, two (or more) schemas** — not a
merged schema, and specifically not merged into the official Midnight indexer's own forked
Postgres schema (which the project's design docs refer to as "Tier 2"). `chain_archive` is
"Tier-1.5": distinct from `tier1_wallet` (client wallet/checkpoint persistence) and distinct from
the Tier-2 indexer fork.

---

## Table of contents

- [tier1_wallet lineage](#tier1_wallet-lineage)
  - [`kv_current` / `kv_history` — TemporalKV](#kv_current--kv_history--temporalkv)
  - [`ckpt_chunks` / `ckpt_manifests` / `ckpt_manifest_chunks` / `ckpt_sequence_counters` — CheckpointStore](#checkpointstore-tables)
  - [`watermarks`](#watermarks)
  - [`transaction_history`](#transaction_history)
  - [Wallet State Envelope (no new table)](#wallet-state-envelope)
- [chain_archive lineage](#chain_archive-lineage)
  - [`chain_blobs` / `chain_blob_roles`](#chain_blobs--chain_blob_roles)
  - [`blocks`](#blocks)
  - [`transactions`](#transactions-chain_archive)
  - [`bridge_observations`](#bridge_observations)
  - [`verifier_key_observations`](#verifier_key_observations)
  - [`chain_archive.watermarks`](#chain_archivewatermarks)
  - [Partition rollover design](#partition-rollover-design)
- [How the two lineages coexist](#how-the-two-lineages-coexist)
- [Boundary enforcement](#boundary-enforcement)

---

## tier1_wallet lineage

Source: `src/postgres/migrations/000_schema.ts` – `006_ckpt_chunks_size_bytes.ts`, plus the runtime
adapters `src/postgres/temporal-kv.ts`, `src/postgres/checkpoint-store.ts`,
`src/postgres/watermarks.ts`, `src/postgres/transaction-history-storage.ts`,
`src/postgres/wallet-state-envelope.ts`.

Every migration in this lineage is schema-qualified via `sql(schema)` (identifier-escaped, never
a hardcoded literal), so the same DDL can be applied under any schema name the caller chooses —
`tier1_wallet` is the convention, not a hardcoded requirement. `000_schema.ts` creates the schema
itself plus a `_migrations(name text primary key, applied_at timestamptz)` bookkeeping table;
`runMigrations` (`src/postgres/migrate.ts`) only calls it when
`to_regclass('<schema>._migrations')` is `NULL`, and applies the rest of the lineage in numeric
order inside a schema-scoped Postgres advisory lock so two application instances starting
concurrently cannot double-apply a migration.

### `kv_current` / `kv_history` — TemporalKV

**Purpose.** A generic, namespaced, versioned JSONB key/value store with point-in-time history —
the general-purpose storage primitive most other wallet state is (or could be) built on. "Current"
values live in one table; every value a key has ever held lives in a second, append-only table.
This is what makes it *temporal*: a `getAt({at: someDate})` or `getAt({at: {kind:"version", ...}})`
call can reconstruct the value a key held at any past instant or version, not just its latest
value.

**`kv_current`** (migration `001_temporal_kv`):

```sql
CREATE TABLE kv_current (
  ns           text NOT NULL,
  scope        text NOT NULL,
  key          text NOT NULL,
  value        jsonb NOT NULL,
  version      bigint NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  updated_xact bigint NOT NULL DEFAULT txid_current(),
  PRIMARY KEY (ns, scope, key)
)
```

- `(ns, scope, key)` is the full addressing tuple — a namespace, a scope within it, and a key.
- `updated_at` is truncated to **millisecond** precision at write time (`date_trunc('milliseconds',
  clock_timestamp())`), not left at Postgres's native microsecond precision. Reasoning: JS `Date`
  only carries millisecond precision, so a `getAt({at})` call round-trips a `Date` the caller read
  back from a prior write; without truncation the reconstructed instant is silently *earlier* than
  the true microsecond-precision `valid_from`, causing point-in-time lookups to miss the row
  entirely. The one accepted cost: two writes to the *same* key in different transactions landing
  in the same millisecond now collide and raise a `ClockRegressionError` (SQLSTATE `23514`) rather
  than silently succeeding with an ambiguous timestamp — documented as a formal caveat on the
  temporal algebra's "Law T4" rather than silently accepted.
- `updated_xact` (via `txid_current()`) backs a hard invariant enforced by the history trigger
  below: **only one write per key per transaction is allowed.** Postgres's `now()` is fixed at
  transaction start (not per-statement or commit time), so a second same-transaction write to the
  same key would otherwise produce a `kv_history` row whose `valid_from = valid_to`, silently
  losing that intermediate version. Rather than redesign history retention to tolerate that, the
  trigger raises `ERRCODE = 'UB001'` if `OLD.updated_xact = txid_current()` — a deliberate
  "forbid, don't paper over" design choice.

**`kv_history`** (migration `001_temporal_kv`):

```sql
CREATE TABLE kv_history (
  id         bigserial PRIMARY KEY,
  ns         text NOT NULL,
  scope      text NOT NULL,
  key        text NOT NULL,
  value      jsonb NOT NULL,
  version    bigint NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to   timestamptz NOT NULL,
  validity   tstzrange GENERATED ALWAYS AS (tstzrange(valid_from, valid_to, '[)')) STORED,
  CONSTRAINT kv_history_range CHECK (valid_from < valid_to),
  CONSTRAINT kv_history_no_overlap EXCLUDE USING gist (
    ns WITH =, scope WITH =, key WITH =, validity WITH &&
  )
);
CREATE INDEX kv_history_lookup    ON kv_history (ns, scope, key, valid_from);
CREATE INDEX kv_history_by_version ON kv_history (ns, scope, key, version);
```

- `validity` is a **generated, stored** half-open range (`[valid_from, valid_to)`), which is what
  lets `getAt({at})` use a single `validity @> $timestamp` containment lookup instead of a
  two-sided comparison.
- `kv_history_no_overlap` is a Postgres `EXCLUDE USING gist` constraint (requires the `btree_gist`
  extension, installed by this migration under a dedicated `pg_advisory_xact_lock(3, 0)` to avoid
  a real, empirically-confirmed `CREATE EXTENSION IF NOT EXISTS` catalog race between concurrently
  migrating schemas): it makes it structurally impossible for two `kv_history` rows for the same
  `(ns, scope, key)` to have overlapping validity intervals. This is the database-level half of
  the "at most one row can ever match a given instant" invariant history retention depends on.
- The trigger `kv_current_history_trigger` (fired `BEFORE UPDATE` on `kv_current` as
  `kv_current_history_bu`) is what actually populates `kv_history`: on every update it inserts the
  *old* row into `kv_history` with `valid_to` set to the new write's timestamp, then lets the
  update to `kv_current` proceed with the new `updated_at`/`updated_xact`. History is never written
  directly by application code — it is entirely a side effect of updating `kv_current`.
- **Retention is unbounded** by this migration — Sprint 1 (the migration that introduced this
  table) deliberately performs no pruning; every version a key has ever held remains in
  `kv_history` forever, by design (the interface's `HistoryUnavailableError`/retention-floor
  machinery exists for a future sprint to wire in, but nothing in the current implementation can
  throw it).
- `getAt` unions `kv_history` and `kv_current` (tagged with a `priority` column, `kv_history`
  first) rather than assuming `kv_history` alone is sufficient — defense-in-depth against a
  scenario where a manual/backfilled `kv_history` row's interval improperly overlaps the live
  `kv_current` row's instant; without ordering, an unordered `LIMIT 1` over the union would return
  an implementation-defined row instead of a deterministic one.

**Write-path invariants (`src/postgres/temporal-kv.ts`, `PgTemporalKV.put`):**

- No `expectedVersion`: unconditional upsert via `INSERT ... ON CONFLICT (ns, scope, key) DO
  UPDATE SET value = EXCLUDED.value, version = kv_current.version + 1`.
- `expectedVersion === 0n`: "must not already exist" — `INSERT ... ON CONFLICT DO NOTHING`, and if
  zero rows come back, the key already existed, so the row is re-read and a `VersionConflictError`
  raised reporting the real current version. A plain guarded `UPDATE` cannot express "insert only
  if absent," which is why this is a distinct code path.
- A specific `expectedVersion`: a compare-and-swap `UPDATE ... WHERE ... AND version =
  expectedVersion`. Zero rows affected is ambiguous between "version conflict" and "key never
  written" — the implementation re-reads to distinguish the two and reports which one actually
  happened.

### CheckpointStore tables

**Purpose.** Content-addressed, chunked binary blob storage with manifests, used to persist
arbitrary wallet-state snapshots ("checkpoints") without storing a full copy of every checkpoint's
bytes — chunks are deduplicated globally by SHA-256 content hash, and a manifest is just an
ordered list of chunk references plus a hash over that ordered list.

**`ckpt_chunks`** (migration `002_checkpoint_store`):

```sql
-- 002_checkpoint_store creates the table; 006_ckpt_chunks_size_bytes later adds size_bytes.
CREATE TABLE ckpt_chunks (
  hash       bytea PRIMARY KEY,
  data       bytea NOT NULL,
  size_bytes integer GENERATED ALWAYS AS (octet_length(data)) STORED,  -- added by migration 006
  created_at timestamptz NOT NULL DEFAULT now()
)
```

- `hash` is the SHA-256 (32 bytes) of `data`, computed application-side (`checkpoint-store.ts`'s
  `sha256()`) rather than by a generated column — it is the content address `save()`'s chunker
  emits, and `load()` re-verifies it against the fetched bytes.
- `size_bytes integer GENERATED ALWAYS AS (octet_length(data)) STORED` is a stored generated column
  **added by migration `006_ckpt_chunks_size_bytes`** (IS-2, `v1.0.0-perf-baseline`), matching the
  `chain_archive.chain_blobs` pattern. `history()`'s aggregate sums this stored column so it never
  detoasts the `data` bytea just to length it (HP-2); the `GENERATED … STORED` expression backfills
  existing rows at migration time and is computed for all future inserts, so it never drifts from
  `data`.
- Content-addressed and globally deduplicated: `save()` splits the caller's payload into
  `DEFAULT_CHUNK_SIZE = 4 MiB` chunks (configurable per-save via `opts.chunkSize`), hashes each,
  and upserts every chunk with `INSERT ... ON CONFLICT (hash) DO UPDATE SET created_at = now()` — a
  chunk shared by two different checkpoints (or even reused twice within one checkpoint) is stored
  exactly once. The `created_at` refresh on conflict is **load-bearing**, not cosmetic: it is what
  keeps a still-referenced chunk outside `prune()`'s grace-window reclaim query (below).
- Chunk storage is a single **global, cross-wallet** pool — not scoped to `(walletId, networkId)`.

**`ckpt_manifests`** (migration `002_checkpoint_store`):

```sql
CREATE TABLE ckpt_manifests (
  id            bigserial PRIMARY KEY,
  w             text NOT NULL,
  net           text NOT NULL,
  seq           bigint NOT NULL,
  complete      boolean NOT NULL DEFAULT false,
  manifest_hash bytea NOT NULL,
  label         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ckpt_manifests_lookup ON ckpt_manifests (w, net, complete, seq DESC);
```

- One row per saved checkpoint, keyed logically by `(w, net, seq)` (wallet id, network id, and a
  per-`(w,net)` sequence number — see `ckpt_sequence_counters` below).
- `manifest_hash` is a SHA-256 over the **position-ordered** sequence of chunk hashes, computed
  once at `save()` time (`sha256(Buffer.concat(chunkHashes))`) so `load()`/`history()` never need
  to recompute it from the junction table just to report it — but `load()` *does* recompute it
  from the actually-fetched chunks and compares, as an integrity check (see below).
- `complete` is written explicitly as `true` on every real save — never left at its schema
  `DEFAULT false` — because every read path (`load`, `history`, `prune`) filters on `complete`; a
  caller that omitted it would see every subsequent read silently return nothing.
- The `ckpt_manifests_lookup` index is shaped for the actual access pattern: filter by
  `(w, net, complete)`, then walk `seq` in descending order (both `load()`'s "latest" case and
  `history()`'s paginated listing).

**`ckpt_manifest_chunks`** (migration `002_checkpoint_store`) — the manifest→chunk junction table:

```sql
CREATE TABLE ckpt_manifest_chunks (
  manifest_id bigint  NOT NULL REFERENCES ckpt_manifests(id) ON DELETE CASCADE,
  position    integer NOT NULL,
  chunk_hash  bytea   NOT NULL REFERENCES ckpt_chunks(hash),
  PRIMARY KEY (manifest_id, position)
);
CREATE INDEX ckpt_manifest_chunks_by_hash ON ckpt_manifest_chunks (chunk_hash);
```

- Keyed on `(manifest_id, position)`, **not** `(manifest_id, chunk_hash)` — a manifest referencing
  the same chunk hash at two different positions (a real repeated-content-run payload) would
  otherwise silently lose bytes on reconstruction, since `(manifest_id, chunk_hash)` alone cannot
  represent that. `chunk_hash` is a plain FK column here, not part of the primary key.
- `ON DELETE CASCADE` on `manifest_id`: without it, `prune()`'s manifest `DELETE` would raise a
  foreign-key violation for *every* manifest that still has junction rows referencing it — i.e.
  every manifest ever saved, since junction rows are never deleted independently — so garbage
  collection could never delete a single manifest. Cascading removes the junction rows in the same
  statement as the manifest delete, which is also what makes them invisible to the chunk-reclaim
  query's `NOT EXISTS` check in the same GC pass.

**`ckpt_sequence_counters`** (migration `002_checkpoint_store`) — the per-`(w, net)` sequence
allocator:

```sql
CREATE TABLE ckpt_sequence_counters (
  w        text   NOT NULL,
  net      text   NOT NULL,
  next_seq bigint NOT NULL DEFAULT 2,
  PRIMARY KEY (w, net)
)
```

- `save()` allocates a sequence number atomically via `INSERT ... ON CONFLICT (w, net) DO UPDATE
  SET next_seq = next_seq + 1 RETURNING next_seq - 1 AS claimed_seq`, inside the same transaction
  as the rest of the save — gapless and monotonic under concurrency purely because the row lock
  taken by the upsert is held for the whole transaction. `next_seq DEFAULT 2` exists so the very
  first claim for a fresh `(w, net)` pair (the `INSERT` branch of the upsert) reports `next_seq - 1
  = 1`, matching the documented "sequences start at 1" contract.

**Read-path integrity checks (`checkpoint-store.ts`, `load()`):** runs inside a `REPEATABLE READ`
transaction (both the manifest lookup and the chunk-join query observe one consistent snapshot,
immune to a concurrently-committing `prune()`'s cascade removing junction rows between the two
statements), then for every chunk: (1) asserts positions are dense `0..n-1` (structurally
impossible to violate on any `save()` path — a defense-in-depth assertion against out-of-band
corruption); (2) if the `LEFT JOIN` to `ckpt_chunks` found no row, raises `ChunkMissingError`; (3)
recomputes each chunk's SHA-256 and compares to `ckpt_manifest_chunks.chunk_hash`, raising
`ChunkIntegrityError` on mismatch; (4) after reassembly, recomputes the **manifest** hash over the
actually-fetched chunk sequence and compares it to `ckpt_manifests.manifest_hash`, raising
`ManifestCorruptError` on mismatch — this catches a junction-row substitution attack that the
per-chunk check alone cannot (every individual chunk valid, positions dense, but the overall
sequence no longer matches what `save()` actually wrote).

**Prune / GC (`prune()`):** runs at Postgres's default `READ COMMITTED` isolation (a stated
dependency, not an oversight — the grace-window race-safety argument below relies on
`READ COMMITTED`'s per-row re-evaluation). Two steps in one transaction: (1) delete manifests past
`retainCount`, cascading their junction rows; (2) reclaim chunks with `created_at < now() -
interval '15 minutes'` (a hardcoded, trusted literal — Postgres's interval-literal grammar wants a
literal here, not a bind parameter) that no surviving junction row references. The 15-minute grace
window plus the `created_at` refresh on every chunk write together close a TOCTOU race: a chunk
referenced by an in-flight `save()` that hasn't yet inserted its junction rows cannot be reclaimed
out from under it, because its `created_at` was just refreshed.

### `watermarks`

**Purpose.** A generic `(kind, key) -> jsonb value` cursor/progress table — e.g. "how far has sync
progressed" — with no history, no versioning, and no temporal semantics; the simplest table in the
lineage.

```sql
CREATE TABLE watermarks (
  kind       text NOT NULL,
  key        text NOT NULL,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, key)
) WITH (fillfactor = 90)
```

- `fillfactor = 90` is a deliberate physical-storage choice, not a default: this table is expected
  to be updated on every sync tick (few distinct rows, extremely high per-row update frequency) —
  exactly the workload Postgres's HOT (Heap-Only Tuple) update optimization exists for, and the
  default `fillfactor = 100` leaves no per-page slack for an updated row to be rewritten on the
  same page. **Hard invariant documented in the migration itself: never add an index on `value` or
  `updated_at`** — either would break HOT eligibility for every write to this table.
- `updated_at` uses `now()` (transaction-start time), not `clock_timestamp()` — unlike `kv_current`,
  nothing in this table's contract depends on `updated_at` for ordering; it is diagnostic only, so
  the two-same-transaction-writes-collapse-to-one-timestamp behavior of `now()` is harmless here.
- `PgWatermarks.set()` explicitly rejects a top-level JSON `null` value at the application layer
  (not via the Zod schema, which structurally permits it) — `value jsonb NOT NULL` only forbids a
  SQL `NULL` in the column, but the Postgres driver would otherwise write the wire-protocol NULL
  marker for a JS `null` parameter regardless of the column's declared type, hitting a raw
  `23502 not_null_violation` instead of a clean validation error.
- `get()` never throws for a missing key — it returns `undefined`. This is the one method in the
  whole tier1_wallet storage layer where absence needs no further distinction (no retention window,
  no reachability concern, unlike `kv_history`'s `HistoryUnavailableError` machinery).

### `transaction_history`

**Purpose.** Per-wallet transaction history with lifecycle tracking (`pending` → `finalized` /
`rejected`) and an identifier-subset "supersession" rule: finalizing/rejecting a transaction clears
any other still-pending entries whose identifiers are a subset of the finalized one's.

```sql
CREATE TABLE transaction_history (
  wallet_id   text        NOT NULL,
  tx_hash     text        NOT NULL,
  entry       jsonb       NOT NULL,
  identifiers text[]      NOT NULL DEFAULT '{}',
  lifecycle   text        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet_id, tx_hash)
);
CREATE INDEX transaction_history_identifiers_gin ON transaction_history USING gin (identifiers);
```

- `identifiers` and `lifecycle` are **denormalized out of `entry`** rather than living only inside
  the JSONB, specifically so the identifier-subset pending-clear rule can be checked with a
  GIN-indexed containment query (`identifiers <@ ...`) instead of a JSONB path scan on every
  finalize/reject write, and so a caller can filter by lifecycle without unpacking `entry`. Both
  columns are always written in the same statement as `entry`, so they can never drift out of sync
  with it. `lifecycle` stores only the discriminant (`entry.lifecycle.status`); the full lifecycle
  object (room for per-status detail) lives in `entry` itself.
- `entry` stores a full JSONB snapshot of the logical entry, with `bigint`/`Date` values
  (e.g. `fees`, `timestamp`) tagged through a reserved-key encoding (`__ths_bigint`/`__ths_date`
  style tags, built from the same `THS_RESERVED_KEY_PREFIX` the write-side Zod schema rejects any
  caller key under, so the tag namespace cannot collide with real caller data) rather than stored
  as native JSON numbers/strings, since JSON has no native bigint or Date type and a bare numeric
  `fees` value would lose precision or silently coerce.
- **Concurrency / merge invariant** (`transaction-history-storage.ts`, `writeRows`): every write
  acquires `pg_advisory_xact_lock(4, hashtext(walletId || ':' || txHash))` **before** the
  `SELECT ... FOR UPDATE` read of any existing row — necessary because a bare `SELECT ... FOR
  UPDATE` cannot lock a row that doesn't exist yet, so two concurrent first-ever writes to the same
  `(walletId, hash)` would both read "no existing row" and race an upsert without ever seeing each
  other's data, silently losing one write's `sections`. The advisory lock closes that gap by
  serializing every writer for a given hash regardless of whether a row already exists yet.
- The actual section-merge/identifier-union/lifecycle-resolution logic is **entirely delegated** to
  a caller-injected `MergeEntriesFn` — this table's own code only does locking, persisting the
  merge result, and the identifier-subset pending-clear `DELETE`. This keeps the storage layer free
  of any wallet-SDK-shaped merge semantics (the injected function is production-configured to
  mirror the real SDK's `mergeWalletEntries` behavior, but this class has no compile- or run-time
  dependency on the SDK itself).
- The pending-clear `DELETE` only runs when the write's own status is `finalized`/`rejected` *and*
  its identifier set is non-empty — an empty identifier set is vacuously "a subset of" anything,
  which would otherwise clear every unrelated pending entry the moment any hash finalizes with zero
  identifiers.

### Wallet State Envelope

`PgWalletStateEnvelopeStore` (`src/postgres/wallet-state-envelope.ts`) adds **no new table and no
new migration**. It is a thin wrapper over an injected `CheckpointStore` that encodes a
`WalletStateEnvelope` (a bundle of three opaque sub-wallet strings) to bytes and persists it via a
single `CheckpointStore.save(walletId, networkId, bytes)` call, so all three sub-wallets become
durable atomically as one checkpoint — reusing `ckpt_chunks`/`ckpt_manifests`/
`ckpt_manifest_chunks`/`ckpt_sequence_counters` entirely rather than duplicating storage. It
cross-checks the envelope's own echoed `(walletId, networkId)` against the requested key on both
`save` (rejecting a mismatch before any encode/persist work happens) and `load` (raising
`EnvelopeCorruptError` on mismatch), so a caller cannot silently persist an envelope under one key
while its embedded identity claims another.

---

## chain_archive lineage

Source (see the [provenance note](#chain_archive-lineage) above for which branch this reflects):
`src/postgres/migrations/chain_archive/001_chain_archive_core.ts` (core DDL),
`src/postgres/migrations/chain_archive/index.ts` (the `chainArchiveMigrations` lineage array),
`src/postgres/migrations/chain_archive/partition-config.ts` (partition sizing constants),
`src/interfaces/chain-archive-store.ts` (the storage contract),
`src/postgres/chain-archive-store.ts` (the Postgres implementation),
`src/postgres/chain-archive-rollover.ts` (the partition-rollover runbook implementation).

**Purpose of the lineage as a whole:** full-chain archival storage — blocks, transactions, bridge
observations, and verifier-key sightings — independent of and resilient to an indexer wipe/rebuild,
modeling the **full block tree** (not just the canonical chain) so competing forks at the same
height are both representable until one is orphaned.

### `chain_blobs` / `chain_blob_roles`

**`chain_blobs`** — the content-addressed blob pool, sibling in spirit to tier1_wallet's
`ckpt_chunks`:

```sql
CREATE TABLE chain_blobs (
  hash       bytea PRIMARY KEY CHECK (octet_length(hash) = 32),
  data       bytea NOT NULL,
  size_bytes integer GENERATED ALWAYS AS (octet_length(data)) STORED,
  created_at timestamptz NOT NULL DEFAULT now()
)
```

- `hash` is a SHA-256 (enforced to be exactly 32 bytes via `CHECK`), computed by the storage
  adapter itself (never trusted from a caller-supplied value) — `putBlobWithRole`/`insertBlockRow`/
  etc. always call `sha256Hex()` on the actual bytes before writing.
- `size_bytes` is a **generated column** (`octet_length(data)`), not a caller-supplied value that
  could silently disagree with the real byte length — a correction from an earlier design pass.
- Every blob write is `INSERT ... ON CONFLICT (hash) DO NOTHING` — a byte-identical blob reused
  across multiple logical roles (e.g. the same bytes serving as both a block header in one context
  and something else in another) is stored exactly once, matching `chain_blobs`'s single global
  content-addressed pool design.

**`chain_blob_roles`** — a many-to-many role-classification table, **not** a single-valued `kind`
column on `chain_blobs` itself:

```sql
CREATE TABLE chain_blob_roles (
  blob_hash bytea NOT NULL REFERENCES chain_blobs(hash),
  role      text  NOT NULL CHECK (role IN
    ('block_header', 'block_body', 'tx_raw', 'proof', 'verifier_key', 'bridge_observation')),
  PRIMARY KEY (blob_hash, role)
);
CREATE INDEX chain_blob_roles_by_role ON chain_blob_roles (role);
```

Why a junction table instead of a single `kind` enum column: identical bytes can legitimately serve
more than one logical role (deduplicating that collision is correct, not a bug), which contradicts
storing one required, single-valued classification per row.

**Blob-role completeness is DB-enforced, not just conventional.** Every table that references
`chain_blobs(hash)` — `blocks.header_blob_hash`/`body_blob_hash`, `transactions.raw_blob_hash`,
`bridge_observations.raw_blob_hash`, `verifier_key_observations.vk_hash` — has a
`BEFORE INSERT OR UPDATE` trigger calling a shared helper function,
`chain_archive_assert_blob_role(blob_hash, role, table, column)`, which raises
`ERRCODE = 23514` (tagged `CONSTRAINT = 'chain_blob_roles_completeness'` so the shared error
translator can distinguish it from unrelated `23514`s elsewhere in the schema) if no matching
`chain_blob_roles` row exists for that `(blob_hash, role)` pair. This closes the gap where a
consumer could reference an unclassified blob.

The **delete/update side is symmetrically guarded**: `chain_blob_roles_guard_removal_trigger`
(`BEFORE DELETE OR UPDATE OF blob_hash, role` on `chain_blob_roles` itself) rejects
removing/repointing a role row still relied on by a live row in whichever table consumes that
role, checked via `chain_archive_assert_role_removable`. Without this, a role row could be deleted
out from under an already-passing reference, silently leaving it pointing at an unclassified blob.
Concurrency between the insert-side check (`FOR SHARE` on the specific `(blob_hash, role)` row) and
the delete-side check (`FOR UPDATE` on the same row) is closed by ordinary Postgres row-lock
semantics: whichever side acquires the lock first forces the other to wait and then re-evaluate
against post-commit state, so it is structurally impossible to end up with a live reference to a
removed role. This was empirically verified against a real Postgres 17 instance with two genuinely
concurrent sessions, in both lock-acquisition orderings.

Both triggers are defined once on the table (a plain table for `chain_blob_roles`, or the
partitioned parent for `blocks`/`transactions`/`bridge_observations`) and are automatically cloned
onto every partition, present and future — standard PostgreSQL 11+ row-trigger propagation on
partitioned tables.

### `blocks`

The block **tree**, not just the canonical chain — competing blocks at the same height are both
legitimately storable, which is what makes the primary key shape below load-bearing.

```sql
CREATE TABLE blocks (
  net              text        NOT NULL,
  block_hash       bytea       NOT NULL CHECK (octet_length(block_hash) = 32),
  height           bigint      NOT NULL CHECK (height >= 0),
  parent_hash      bytea       NOT NULL CHECK (octet_length(parent_hash) = 32),
  state_root       bytea       NOT NULL CHECK (octet_length(state_root) = 32),
  extrinsics_root  bytea       NOT NULL CHECK (octet_length(extrinsics_root) = 32),
  author           bytea,
  header_blob_hash bytea       NOT NULL REFERENCES chain_blobs(hash),
  body_blob_hash   bytea       REFERENCES chain_blobs(hash),
  is_canonical     boolean     NOT NULL DEFAULT false,
  status           text        NOT NULL DEFAULT 'seen'
                     CHECK (status IN ('seen', 'canonical', 'orphaned', 'pruned')),
  finalized        boolean     NOT NULL DEFAULT false,
  synced_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'canonical') = is_canonical),
  CHECK (NOT finalized OR is_canonical),
  PRIMARY KEY (net, height, block_hash)
) PARTITION BY RANGE (height)
```

- **`net` in the primary key**: nothing before this design revision stopped two different
  networks' archive data from being silently comingled in one archive table; `net` was folded into
  the PK alongside `height` (the partition key) and `block_hash`.
- **`body_blob_hash` is nullable** — body/extrinsics sync is not assumed to exist yet; this table
  does not block on that dependency.
- **`parent_hash` deliberately has no foreign key** back to another `blocks` row: a
  self-referencing FK across range partitions complicates out-of-order reorg backfill;
  parent-link integrity is treated as an application-level invariant instead.
- **Canonical-uniqueness enforcement**, two parts working together:
  - `CHECK ((status = 'canonical') = is_canonical)` ties the two flags together at every write.
  - A **partial unique index**, `blocks_one_canonical_per_height ON blocks (net, height) WHERE
    is_canonical`, enforces at most one canonical block per `(net, height)` globally. This works
    on a `PARTITION BY RANGE (height)` table specifically *because* the index includes the
    partition key column (`height`): Postgres implements it as one native partitioned index with a
    matching valid child index on every partition, and since `height` is the partition key, two
    rows sharing the same `height` can only ever land in the same physical partition — so
    per-partition local enforcement genuinely is global enforcement for this key. (Empirically
    verified: Postgres unconditionally rejects a partial unique index on a partitioned table that
    *omits* the partition key column, confirming this isn't incidental.)
- **Finalized/canonical monotonicity**, also two parts:
  - `CHECK (NOT finalized OR is_canonical)` — a finalized block is always canonical (real
    Substrate/GRANDPA finality semantics); this ties the two flags together at each individual
    write.
  - `blocks_finalized_monotonic_trigger` (`BEFORE UPDATE OF finalized`) additionally rejects the
    transition `OLD.finalized = true AND NEW.finalized = false` — GRANDPA finality is monotonic by
    construction (a finalized block never becomes un-finalized), and the `CHECK` alone only
    constrains each write in isolation, not transitions across writes. Raises `23514` tagged
    `CONSTRAINT = 'blocks_finalized_monotonic'`.
- Supporting indexes: `blocks_by_hash (block_hash)`, `blocks_by_parent (parent_hash)`.
- Partitioned by `RANGE (height)` — see [Partition rollover design](#partition-rollover-design).

### `transactions` (chain_archive)

Metadata only — raw transaction bytes are stored via a blob reference, matching the
metadata/blob split used throughout this lineage.

```sql
CREATE TABLE transactions (
  net              text        NOT NULL,
  tx_hash          bytea       NOT NULL CHECK (octet_length(tx_hash) = 32),
  block_height     bigint      NOT NULL CHECK (block_height >= 0),
  block_hash       bytea       NOT NULL CHECK (octet_length(block_hash) = 32),
  position         integer     NOT NULL CHECK (position >= 0),
  kind             text        NOT NULL CHECK (kind IN ('regular', 'system')),
  protocol_version integer     NOT NULL CHECK (protocol_version >= 0),
  result           text        CHECK (result IN ('success', 'partial_success', 'failure')
                                       OR result IS NULL),
  raw_blob_hash    bytea       NOT NULL REFERENCES chain_blobs(hash),
  synced_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (net, block_height, block_hash, tx_hash),
  UNIQUE (net, block_height, block_hash, position),
  FOREIGN KEY (net, block_height, block_hash) REFERENCES blocks (net, height, block_hash)
) PARTITION BY RANGE (block_height)
```

- **Primary key includes `block_hash`.** An earlier design's primary key was
  `(block_height, tx_hash)`, which omitted `block_hash` entirely — since `blocks` correctly models
  the full block tree, two competing forks both containing the same transaction hash at the same
  height would collide on that narrower key, making it impossible to store both forks' inclusion
  records. The corrected PK, `(net, block_height, block_hash, tx_hash)`, includes every column a
  transaction-inclusion record actually needs to stay unique per (network, fork, transaction).
- `UNIQUE (net, block_height, block_hash, position)` separately prevents two transactions from
  occupying the same slot within one block.
- A real foreign key back to `blocks (net, height, block_hash)` rejects both a reference to a
  nonexistent block and a reference whose `block_height`/`block_hash` don't jointly match a real
  `blocks` row — this works across two independently range-partitioned tables because both are
  partitioned on columns in the same domain (`block_height` here, `height` on `blocks`).
- `transactions_by_hash (tx_hash)` is kept as a genuinely distinct index (not a left-prefix of the
  PK). A `(net, block_height, block_hash)` index was deliberately **not** created — it would be a
  strict left-prefix of the PK's own backing btree index, so it buys no distinct access pattern
  and only adds write amplification.
- Partitioned by `RANGE (block_height)`.

### `bridge_observations`

Metadata + blob-reference table for cross-chain bridge/governance observations (e.g. `cNight`
registrations, D-parameter/system-parameter updates). These are carried in Substrate **inherents**
(block body data), which is why this data cannot be reliably reconstructed from `transactions`
alone or deferred until full block-body sync exists — the table stands on its own, referencing its
own raw bytes independent of whether `blocks.body_blob_hash` is populated.

```sql
CREATE TABLE bridge_observations (
  net               text        NOT NULL,
  block_height      bigint      NOT NULL CHECK (block_height >= 0),
  block_hash        bytea       NOT NULL CHECK (octet_length(block_hash) = 32),
  observation_index integer     NOT NULL CHECK (observation_index >= 0),
  kind              text        NOT NULL CHECK (kind IN
    ('cnight_registration', 'system_parameters_d', 'spo_registration', 'other')),
  raw_blob_hash     bytea       NOT NULL REFERENCES chain_blobs(hash),
  synced_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (net, block_height, block_hash, observation_index),
  FOREIGN KEY (net, block_height, block_hash) REFERENCES blocks (net, height, block_hash)
) PARTITION BY RANGE (block_height)
```

Index: `bridge_observations_by_kind (kind)`. Partitioned by `RANGE (block_height)`, following the
same rollover shape as `blocks`/`transactions`.

### `verifier_key_observations`

Records **where and how** a verifier key (a content-addressed circuit artifact) has been observed,
as distinct from the key's own bytes (which live in `chain_blobs`, classified via the
`verifier_key` `chain_blob_roles` role — no separate content-keyed table is needed for that half).

```sql
CREATE TABLE verifier_key_observations (
  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vk_hash           bytea       NOT NULL REFERENCES chain_blobs(hash),
  net               text        NOT NULL,
  scope             text        NOT NULL CHECK (scope IN ('protocol', 'contract')),
  tag               text        NOT NULL,
  contract_address  bytea,
  first_seen_height bigint      NOT NULL CHECK (first_seen_height >= 0),
  synced_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'contract') = (contract_address IS NOT NULL)),
  UNIQUE NULLS NOT DISTINCT (vk_hash, net, scope, contract_address, tag)
);
CREATE INDEX verifier_key_observations_by_contract
  ON verifier_key_observations (contract_address) WHERE contract_address IS NOT NULL;
```

- **Why a separate observations table rather than one row per key hash**: reading the actual
  ledger/crypto source (`transient-crypto/src/proofs.rs`, `ledger/src/structure.rs`) confirmed a
  `VerifierKey`'s content-addressed bytes are a pure function of the compiled circuit, with no
  network/contract/address salt anywhere in serialization — so nothing stops two different contract
  addresses (the same circuit deployed twice) or two different networks from genuinely sharing
  byte-identical key content. A single-row-per-hash table cannot record more than one
  `(net, scope, contract_address)` context per key without either rejecting a real second sighting
  or overwriting the first one's context.
- `CHECK ((scope = 'contract') = (contract_address IS NOT NULL))` enforces the relationship in
  **both directions** — a protocol-scoped row with a non-null address, and a contract-scoped row
  with a null address, are both rejected.
- The uniqueness key is `UNIQUE NULLS NOT DISTINCT (vk_hash, net, scope, contract_address, tag)`
  (Postgres 15+ syntax): a surrogate `id` primary key is used instead of making that tuple the PK
  directly, because `contract_address` is legitimately `NULL` for protocol-scoped rows and
  Postgres requires every PK column to be `NOT NULL`. `NULLS NOT DISTINCT` (rather than ordinary
  `UNIQUE`, which treats every `NULL` as distinct from every other `NULL`) is what makes two
  *different* protocol-scoped observations of the same key (different `net`, both
  `contract_address IS NULL`) coexist as distinct rows while an exact duplicate context is
  correctly rejected.
- `tag` (naming the circuit/entry-point role a key was observed playing) **is part of the
  uniqueness key**; `first_seen_height` is **not** — it is a mutable "earliest known" fact about an
  observation context, maintained via `INSERT ... ON CONFLICT (vk_hash, net, scope,
  contract_address, tag) DO UPDATE SET first_seen_height = LEAST(...)`, never a plain `INSERT`.
  Including `tag` fixes a real data-loss bug where two legitimate different-entry-point
  observations of the same key collided and one silently overwrote the other; excluding
  `first_seen_height` prevents the same logical identity being re-inserted under contradictory
  "first-seen" claims.

### `chain_archive.watermarks`

A **separate, independent** `watermarks` table living inside the `chain_archive` schema — not a
reuse of `tier1_wallet.watermarks`. Same shape and rationale (`fillfactor = 90` for HOT-friendly
high-frequency cursor writes) as the tier1 table, deliberately duplicated rather than
cross-referenced: reaching across the schema boundary to write into `tier1_wallet`'s table from
`chain_archive`'s independent lineage would re-couple the two tiers this split exists to keep
apart — a `chain_archive`-only deployment/backup/restore could no longer be self-contained.

```sql
CREATE TABLE watermarks (
  kind       text NOT NULL,
  key        text NOT NULL,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, key)
) WITH (fillfactor = 90)
```

`ChainArchiveStore.setWatermark` additionally guards against **regression**: for the one real
convention this store's watermark values follow (`{ height: number }`, the sync cursor shape), the
upsert's `WHERE` clause only applies the update when the incoming `height` is strictly greater than
the stored one (or either side isn't shaped that way, in which case it falls back to unconditional
last-write-wins). This closes a race where two overlapping sync-service runs could otherwise let a
slower, stale call overwrite the cursor backward, which would make the next sync attempt re-process
already-ingested heights and hit a duplicate-key wedge.

### Partition rollover design

**Why partitioning exists:** block height grows without bound for the lifetime of the network, and
`blocks`/`transactions`/`bridge_observations` are all partitioned `RANGE` on a height column for
exactly that reason — an unpartitioned table accumulating years of chain history would eventually
degrade every index and vacuum operation against it.

**Pre-created partitions, not an unbounded `DEFAULT`.** The migration itself
(`createHeightPartitions` in `001_chain_archive_core.ts`) creates
`CHAIN_ARCHIVE_PRECREATED_PARTITIONS` (currently **5**) bounded partitions of
`CHAIN_ARCHIVE_HEIGHT_PARTITION_SIZE` (currently **1,000,000**) heights each, starting at height 0,
plus one `DEFAULT` catch-all partition for any height beyond the pre-created range. Both constants
live in one place, `partition-config.ts`, specifically so the schema DDL and any documentation of
it cannot silently diverge. Five buckets (5,000,000 blocks of headroom) is intended to be enough
runway that, combined with a rollover job run well before the top bucket fills, the `DEFAULT`
partition should never receive a row in practice on a healthy deployment — a single `DEFAULT`
partition silently accumulating unbounded overflow is a real operational hazard, since reorganizing
it later requires a heavyweight, locking procedure.

**The rollover runbook, as implemented (`src/postgres/chain-archive-rollover.ts`,
`rolloverDefaultPartition`)**, handles the common case where a table's overflowed `DEFAULT`
partition's rows fit entirely inside one new bounded bucket `[lo, hi)` (true whenever rollover is
triggered before monitoring lags by more than one bucket width). It refuses to proceed — rather
than silently mis-routing data — if any row in a table's `DEFAULT` partition falls outside the
target bucket; a `DEFAULT` spanning multiple buckets needs a documented multi-bucket split fallback
that is explicitly out of scope for this automated helper. The steps, all inside one transaction on
a single reserved connection:

1. **Detach children before the parent.** `transactions`/`bridge_observations`' `DEFAULT`
   partitions are detached first; only then is `blocks`' `DEFAULT` partition detached — detaching
   the parent first is rejected while the FK-bearing children are still attached.
2. **Drop the retained FK constraint** on each detached child (Postgres retains a detached
   partition's FK constraint; it must be dropped before the rename/reattach below). FK constraint
   names are looked up dynamically from `pg_constraint`/`pg_class` rather than hardcoded, so the
   function stays correct against whatever names the real migration actually generated.
3. **Rename** each detached table out of the way (`*_default` → `*_default_staging`) to free the
   `*_default` name for a fresh, empty `DEFAULT` partition later.
4. **Reattach the staging data** as a correctly-bounded partition (`ALTER TABLE ... ATTACH
   PARTITION ... FOR VALUES FROM (lo) TO (hi)`) — **before** recreating `DEFAULT` or resuming
   writers. This ordering (not "recreate `DEFAULT` immediately") is what closes a write-race window
   where a live write could otherwise land in the gap between detach and reattach.
5. **Recreate empty `DEFAULT` partitions** on all three tables, only after step 4 completes.
6. Resume writers — the caller's own responsibility; this function does not manage pausing/resuming
   writers itself (the design's documented guidance is to hold the same schema-scoped advisory lock
   `migrate.ts`'s `runMigrations` already uses, if a caller wants that coordination).

The function is idempotent for a *repeated* invocation with the same `(suffix, lo, hi)`: it checks
the catalog up front (`rolloverAlreadyApplied`) and short-circuits to a no-op if that exact rollover
already fully succeeded, and throws (refusing to guess) if a prior attempt left the suffix only
*partially* applied. Every query it issues — the idempotency check, pre-flight span checks, FK
lookups, and the DDL itself — runs on one reserved connection (not the general pool), both so the
FK lookups see this same transaction's own uncommitted `DETACH` and so the function cannot
self-deadlock waiting for a pool connection it is itself holding under a `maxConnections: 1`
configuration.

**`ChainArchiveStore` (`src/postgres/chain-archive-store.ts`) implementation notes:**

- Every write path (`putBlock`, `putTransactions`, `putBridgeObservations`,
  `putVerifierKeyObservation`) is idempotent against a byte-for-byte-identical re-ingest of the
  same key: every terminal `INSERT` uses `ON CONFLICT ... DO NOTHING` (or, for verifier-key
  observations, `DO UPDATE SET first_seen_height = LEAST(...)`) on the table's own primary/unique
  key, so retrying an ingest that already durably committed is a safe no-op, not a duplicate-key
  error. This does not replace the need for a watermark — callers driving an at-least-once sync
  loop still must track "last successfully ingested height" — but it removes the specific failure
  mode where retrying the same height after a partial or already-committed prior attempt would
  otherwise wedge permanently.
- `putBlockBundle` composes the block row plus all of its transactions and bridge observations into
  **one** transaction, so a partial block (e.g. the `blocks` row committed but its transactions
  not, because an interrupted write or an inconsistent upstream source) can never become durably
  visible. Insert order within that transaction (block row first) matters: it makes the block
  visible to the later FK-checked inserts via ordinary same-transaction MVCC visibility, even
  though the block row hasn't committed yet.
- `getBlob` always **rehashes on read** and rejects (`BlobIntegrityError`) if the recomputed SHA-256
  disagrees with the lookup key — it never returns bytes it cannot verify, mirroring
  `CheckpointStore.load`'s proven chunk-integrity pattern in the tier1_wallet lineage.
- `setCanonical` flips canonical status at `(net, height)` atomically: it un-marks whichever block
  currently holds the canonical slot (if any, and if different) and marks the target block
  canonical, both inside one transaction — so a concurrent reader can only ever observe
  zero-then-new-canonical or old-then-new-canonical, never two canonical rows at once. This ordering
  is required by `blocks_one_canonical_per_height`'s partial unique index, which permits at most one
  `is_canonical = true` row per `(net, height)` at every instant, not just at transaction end.

---

## How the two lineages coexist

Both lineages share the runner in `src/postgres/migrate.ts`, but each applies to its **own**
schema and its own `_migrations` bookkeeping table — never a merged schema. `runMigrations` was
extended (not rewritten) with one new option to support a second lineage:

```ts
export interface RunMigrationsOptions {
  schema: string;
  /** Which migration lineage to apply. Defaults to `tier1WalletMigrations` — every existing
   *  caller that doesn't pass this continues to get exactly the migrations it always did. */
  migrations?: Migration[];
}
```

- Every existing tier1_wallet caller that omits `migrations` is unaffected — `tier1WalletMigrations`
  (the array `[migration000, migration001, migration002, migration003, migration004, migration005, migration006]`, formerly the
  module's unexported default) remains the implicit default.
- A `chain_archive` caller passes `{ schema: "chain_archive", migrations: chainArchiveMigrations }`
  explicitly. `chainArchiveMigrations` (`migrations/chain_archive/index.ts`) is
  `[migration000, chainArchiveCore]` — it **reuses `000_schema.ts` unchanged**: that migration's
  `up(sql, schema)` was already fully schema-parameterized (`CREATE SCHEMA IF NOT EXISTS <schema>`
  plus a `<schema>._migrations` table scoped to whatever `schema` string is passed in), so running
  it a second time against a *different* schema name bootstraps a second, independent
  `_migrations` table with no collision — the same migration `name` ("000_schema") appearing in two
  different schemas' `_migrations` tables is not a collision, since each is a distinct,
  schema-qualified physical table.
- `runMigrationsImpl` reads its bootstrap migration off `lineage[0]` rather than a hardcoded
  `migration000` reference, so a future third lineage that didn't happen to start with a
  schema-bootstrap migration would surface as a real bug (a missing `_migrations` table) instead of
  a mismatched hardcoded reference silently running the wrong thing.
- **Nothing in this repo's application code calls `runMigrations` with the `chain_archive` lineage
  today.** `chainArchiveMigrations` is exported and fully functional, but it is an inert,
  unregistered, design-stage artifact — consistent with the [provenance note](#chain_archive-lineage)
  that the whole `chain_archive` schema has not been merged/wired into `main` yet.

Both schemas can coexist in one Postgres instance because the migration runner's advisory lock
(class `1`, keyed by `hashtext(schema)`) is per-schema — two different schemas' migrations run
under different lock keys and can proceed concurrently without interfering, while two concurrent
callers migrating the *same* schema are correctly serialized.

---

## Boundary enforcement

Two automated, repo-wide guard tests keep the architectural rule — `src/postgres/*` (and
`src/interfaces/*`) must stay free of the Midnight wallet SDK and free of any chain-sync/indexer
dependency — actually enforced rather than just documented:

- **`test/postgres/no-sdk-import-guard.test.ts`** (tier1_wallet's guard) walks every `.ts` file
  under `src/` recursively and asserts none of them contain the substring `@midnightntwrk` anywhere
  in their source text — not a per-line `/^\s*import\b/` filter (an earlier version of this guard
  used exactly that filter and was found, by audit, to miss a **re-export** shape:
  `export { x } from "@midnightntwrk/y"` references the SDK at runtime exactly as much as an
  `import` does, but its line starts with `export`, not `import`, so the old line-filtered check
  silently passed a file containing only re-exports). The current whole-file substring scan has no
  such blind spot; the test file includes a fixture proving the old filter would have missed the
  exact case the new check catches.
- **`test/postgres/no-chain-sync-import-guard.test.ts`** (chain_archive's guard, on the branch
  where that schema lives) similarly ensures the real ingestion/sync implementation — the node-RPC
  and indexer-GraphQL client code, `chain-archive-sync/*` — lives entirely **outside** `src/`
  altogether (the strongest form of the boundary rule: not just outside `src/postgres/`, outside
  `src/` in its entirety). It checks three independent things for every `.ts` file under `src/`:
  (a) string-literal `from`/`import(...)` specifiers referencing the `chain-archive-sync` path
  segment; (b) any string literal (single-, double-, or backtick-quoted) containing the substring
  `chain-archive-sync`, extracted by a real string-aware scanner that correctly skips `//` and
  block comments (so a doc comment that legitimately *names* the directory does not false-positive)
  — catching `require(...)`/computed-`import()` shapes a naive regex would miss; and (c) the
  ingestion layer's distinguishing exported class names (`NodeRpcClient`, `IndexerClient`,
  `ChainArchiveSyncService`) appearing anywhere in the file, catching a re-export or a copy under a
  different path. The test file documents its own residual, statically-undetectable gaps (a
  specifier assembled from split string literals, an import routed through an external barrel file
  outside `src/`, a fully runtime-constructed specifier) rather than claiming complete coverage.

Both guards run as ordinary Vitest tests — a violation fails the test suite, not just a lint pass
that could be silently skipped.
