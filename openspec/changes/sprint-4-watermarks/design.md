# Design — Sprint 4: Watermarks

Implementation-level detail for `src/interfaces/watermarks.ts` against the schema
`design/design.md` §4 sketches, corrected for physical storage parameters (§1 below) and extended
with a documented large-integer convention (§4) — both grounded in the pre-draft research round
cited throughout, and against `Formal/STORAGE_ALGEBRA.md` §3's Law W1.

## 0. Package layout

```
src/
  postgres/
    watermarks.ts            PgWatermarks (this sprint)
    migrations/
      003_watermarks.ts
    migrate.ts                (existing, modified: migrations array gains 003)
test/
  postgres/
    watermarks.test.ts             unit tests
    watermarks.property.test.ts    P9 from Formal/STORAGE_ALGEBRA.md §5
```

No new top-level directory, matching every prior sprint's "no abstraction-for-its-own-sake
nesting" rationale (`sprint-1-setup-and-temporal-kv/design.md` §1).

## 1. Schema — one physical-parameter correction to `design/design.md` §4

`design/design.md` §4's schema is logically correct and needs no change to its columns:

```sql
CREATE TABLE watermarks (
  kind       text NOT NULL,
  key        text NOT NULL,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, key)
);
```

Cross-checked directly against the closest real production precedent found: Debezium's
`debezium_offset_storage` (`debezium-storage/debezium-storage-jdbc/.../JdbcOffsetBackingStoreConfig.java`)
is a namespaced key + opaque JSON value + insert timestamp — structurally the same shape as this
table generalized with a two-part `(kind, key)` key instead of Debezium's single connector-scoped
key. Sui's own `watermarks` table (`crates/sui-pg-db/migrations/.../watermarks/up.sql`) and
Aptos's `processor_status` are both dedicated, one-row-per-pipeline LWW cursor tables with the
same `PRIMARY KEY`-per-process shape. Real Midnight indexer schema
(`midnight-indexer/indexer-common/migrations/postgres/001_initial.sql`) has no generic watermark
table — sync progress there is folded into typed columns on `wallets`, plus one degenerate
single-row cursor table (`spo_stake_refresh_state`) — not directly reusable here since this
module's whole purpose is serving multiple heterogeneous `kind`s generically, but its shape
(implicit key + value + `updated_at`) is the same pattern in miniature.

**What the sketch didn't consider — physical storage parameters, added here.** This table is
updated on every sync tick: potentially many writes per second per `(kind, key)` for an actively
syncing wallet. That is exactly the workload shape (few rows, extremely high per-row `UPDATE`
frequency) HOT (Heap-Only Tuple) updates exist for — and exactly the shape that degrades badly
without them (PostgreSQL's own HOT documentation, `storage-hot.html`; Crunchy Data, Christensen &
Frost, "Postgres Performance Boost: HOT Updates and Fill Factor," Mar 2024).

```sql
CREATE TABLE watermarks (
  kind       text NOT NULL,
  key        text NOT NULL,
  value      jsonb NOT NULL,
  -- now() (transaction-start time), not clock_timestamp(): two writes to the same key in one
  -- transaction share this value, but nothing in this module's contract depends on updated_at
  -- for ordering (contrast TemporalKV's Law T4, which genuinely needed clock_timestamp() --
  -- Watermarks has no such invariant; this field is diagnostic only). Postgres docs §9.9.5.
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, key)
) WITH (fillfactor = 90);
```

**`fillfactor = 90`, not the default 100.** HOT requires (a) the update touch no indexed column
and (b) room on the same page for the new row version. Here, only `value`/`updated_at` change on
a `set()` call, and neither is indexed — the `(kind, key)` primary key does not block HOT by
itself. But the default `fillfactor` of 100 packs pages completely full at write time, leaving no
slack for an updated row (especially a larger `value`) to land on the same page — defeating HOT
even though nothing about the index shape required that. `fillfactor = 90` reserves 10% per-page
slack specifically for this, at negligible cost (a few percent more disk for a table this small).
Crunchy Data's own guidance places 70-90 as "reasonable... making better use of HOT updates,"
reserving more aggressive values (50 or below) for "unusually heavy" workloads this project has
no evidence of yet — 90 is the conservative end of that range, revisit toward 80 only if a `kind`
turns out to store noticeably larger `value`s than expected.

**Hard invariant, binding on all future changes to this table, not just this sprint's own
code**: no index may ever be added on `value` or `updated_at`. Any such index — a GIN on `value`
for querying inside the opaque JSON, or a plain index on `updated_at` for a "stalest cursor"
query — breaks HOT eligibility for every write to this table, silently reintroducing the bloat
risk `fillfactor` alone cannot fully prevent once an indexed column is actually changing on every
update. If a future requirement genuinely needs to query by `value`'s contents or by staleness,
that requirement must be weighed against this cost explicitly, not added as an apparently-free
convenience index.

**Monitoring, not `autovacuum` tuning, is the first lever.** Tomas Vondra's "Autovacuum Tuning
Basics" (EDB) documents the vacuum trigger formula (`threshold + relrows * scale_factor`, defaults
50 rows / 0.2) — at this table's tiny row count, the 50-row `autovacuum_vacuum_threshold` alone
is crossed within seconds under any real update rate, making `autovacuum_naptime` (default 1
minute) the actual cadence limiter, not `scale_factor`. HOT pruning (which runs opportunistically
during normal `SELECT`/`UPDATE` traffic, not only during vacuum) is what actually keeps a
well-configured table like this healthy between autovacuum runs. This sprint's operational
guidance (§7) is therefore a monitoring assertion (`pg_stat_user_tables.n_tup_hot_upd /
n_tup_upd` should stay near 1), not a per-table `autovacuum_vacuum_*` override — reach for that
override only if the ratio actually degrades in practice, per Vondra's own general-tuning-first
guidance. Separately, Brandur Leach's "Postgres Job Queues & Failure By MVCC" documents a
comparable hot table accumulating ~100k dead tuples in ~15 minutes because a long-running
transaction *elsewhere* pinned the xmin horizon — no per-table setting fixes that; it is an
application-level discipline (avoid long-running transactions anywhere in the same database),
recorded here as an operational fact, not something this sprint's schema can defend against.

## 2. `set`

```typescript
async set<T extends WatermarkValue>(
  kind: WatermarkKind, key: WatermarkKey, value: T,
  opts?: { tx?: TransactionHandle; signal?: AbortSignal },
): Promise<void>
```

Unlike `CheckpointStore.save`/`prune` (which compose `withTransaction` internally and accept no
`tx` option, per that interface's own doc), `Watermarks.set`/`get` accept a caller-supplied
`TransactionHandle` directly — the same composition pattern `PgTemporalKV.put`/`get` already use.
`sql = opts?.tx !== undefined ? resolveTransaction(opts.tx) : this.sql` (mirroring
`temporal-kv.ts`'s own `putImpl` exactly). Validate `value` against `WatermarkValueSchema`
(`ValidationError` before any statement, per the interface's own `@throws` doc), then:

```sql
INSERT INTO ${sql(schema)}.watermarks (kind, key, value, updated_at)
VALUES (${kind}, ${key}, ${sql.json(value)}, now())
ON CONFLICT (kind, key) DO UPDATE
SET value = EXCLUDED.value, updated_at = now()
```

Non-object JSON roots (a bare string or number `WatermarkValue`) must be passed through
`sql.json(value)`, not interpolated directly — `postgres.js`'s own type inference cannot
determine the intended cast for a bare string/number/boolean parameter against a `jsonb` column
(confirmed against a real, filed driver issue: `porsager/postgres#386`, `sql\`SELECT
${true}::jsonb\`` fails type inference without this). `sql.json()` is already this project's own
established pattern for exactly this case (`temporal-kv.ts`'s `putImpl`, `const jsonValue =
sql.json(value as JsonValue)`) — reused here unchanged, not a new decision.

No CAS, no version, no history: `set` unconditionally overwrites, matching Law W1 exactly
(`set(set(x, v), v) = set(x, v)`, `Formal/STORAGE_ALGEBRA.md` §3). Cancellation is pre-check-only
`withAbort` (§6 below) — no transaction to roll back on a late abort, no lock wait, no cursor;
the call either hasn't started (abort honored) or has already committed (abort has no effect),
with nothing in between worth building dedicated cancellation for.

## 3. `get`

```typescript
async get<T extends WatermarkValue = WatermarkValue>(
  kind: WatermarkKind, key: WatermarkKey,
  opts?: { tx?: TransactionHandle; signal?: AbortSignal },
): Promise<T | undefined>
```

```sql
SELECT value FROM ${sql(schema)}.watermarks WHERE kind = ${kind} AND key = ${key}
```

Zero rows → `undefined`, per the interface's own doc ("never throws for a missing cursor") — this
is the one place in the whole storage layer where `get` never needs to distinguish "never set"
from anything else, since there is no retention window (contrast `TemporalKV.getAt`'s
`HistoryUnavailableError`) and no reachability concern (contrast `CheckpointStore.load`'s several
corruption errors) to distinguish it from. `T` narrows the erased `WatermarkValue` at the type
level only — the runtime check is against `WatermarkValueSchema`'s already-erased shape, exactly
like `TemporalKV.get<T>`'s own documented caller-assertion contract; a caller that writes one
shape under a `kind` and reads a different `T` gets a type lie, not a runtime error, by design.

## 4. Large-integer cursor values — a documented convention, not a schema change

**A real gap found by this sprint's research round, closed here as documentation, not code.**
`postgres.js`'s `jsonb` type is a bare `JSON.stringify`/`JSON.parse` passthrough
(`porsager/postgres`'s own `src/types.js`) — Postgres itself stores a JSON number inside `jsonb`
as an arbitrary-precision `numeric` (`datatype-json.html` §8.14), so it round-trips exactly at the
database layer. The corruption happens entirely on the JS side, invisibly, before any validation
ever runs: RFC 8259 §6 states IEEE-754-binary64 JSON numbers only interoperate exactly within
`[-(2^53)-1, (2^53)-1]`, and `JSON.parse('9007199254740993')` silently returns `9007199254740992`
— no error, no warning, and the driver's `postgres.BigInt` custom type mapping does **not** help
here (confirmed against real, filed driver issues `porsager/postgres#1106`/`#1182`: it only remaps
bare `int8` columns, not values nested inside a `json`/`jsonb` payload). A block-height or
byte-offset cursor for a sufficiently long-running sync could silently exceed this range with no
error anywhere in the stack — the database looks correct, the value returned to the caller is
already wrong.

**Convention, per `Ethereum`'s own JSON-RPC precedent** (`ethereum.org`'s JSON-RPC spec,
"Quantities" convention — every quantity, block numbers included, is hex-string-encoded
specifically to dodge this exact class of bug): a `kind` whose cursor value could ever exceed
`Number.MAX_SAFE_INTEGER` MUST encode that value as a decimal **string** inside its
`WatermarkValue`, not a bare JSON number. `WatermarkValue`'s TSDoc (`src/interfaces/watermarks.ts`)
gains a note documenting this explicitly, cross-referencing this design section.

**Why this is a convention, not a `WatermarkValueSchema` refinement — a deliberate scope
decision, not an oversight.** `WatermarkValueSchema = JsonValueSchema` is *shared* with
`TemporalKV` (`src/interfaces/watermarks.ts`'s own doc: reusing the already-audited schema is
what fixed the original unsound `z.record(z.string(), z.unknown())` draft). Narrowing that shared
schema to reject out-of-safe-range numbers would change `TemporalKV`'s own already-implemented,
already-audited contract too — genuinely out of scope for a Watermarks-only sprint, and not
something to bolt on as a side effect here. A caller-facing documentation convention closes the
practical risk (any `kind` whose values could plausibly grow that large should simply be defined,
by its own owner, to use string encoding) without touching shared, already-shipped code.

No `jsonb_typeof` CHECK constraint is added either, for a related but distinct reason: such a
constraint (a real, cheap, commonly-recommended pattern — Andrew Dunstan, Postgres core jsonb
author, "The database is the one place everything has to pass through") would necessarily
restrict `value` to a specific shape (object, or object-or-scalar), which contradicts this
module's deliberate "opaque, caller-defined per `kind`" contract (`src/interfaces/watermarks.ts`'s
own doc). Validation stays exactly where it already is: the `WatermarkValueSchema` boundary check
in `set`.

## 5. Accepted tradeoffs (explicit, not silently possible)

- **Opaque `jsonb value` over typed columns.** Sui's `watermarks` and Aptos's `processor_status`
  both use typed `BIGINT` columns for their cursor values, gaining SQL-queryable lag observability
  a `jsonb` blob obscures. Declined here: this module serves *heterogeneous* `kind`s with no
  common shape (a block height, a byte offset, a composite object) — Debezium's own
  `debezium_offset_storage` makes the identical choice for the identical reason (a generic offset
  store serving arbitrary connectors). Lag observability, where needed, comes from external
  metrics — the same answer every system this sprint's research surveyed gives.
- **No version history.** Re-confirmed, not merely re-asserted: zero systems found in this
  sprint's research keep watermark/cursor history in the database — Debezium deletes-and-rewrites
  on every flush, Sui/Aptos/Midnight are strict one-row upserts. `Formal/STORAGE_ALGEBRA.md` §3's
  "deliberate algebraic choice" framing for Law W1 is the industry norm, not a shortcut peculiar
  to this project.
- **`updated_at DEFAULT now()`, not `clock_timestamp()`.** Two same-key writes inside one
  transaction share `updated_at` under `now()` — accepted because nothing in this module's
  contract depends on that field for ordering or addressing (contrast `TemporalKV`'s Law T4, which
  is exactly why that module needed `clock_timestamp()`). Diagnostic field only.

## 6. Composing Transaction/Lease

`PgWatermarks` is constructed with a `UmbraDBSql` (like `PgTemporalKV`) — it does **not** need a
`PgTransactionLeaseLayer` reference the way `PgCheckpointStore` does, since it never opens its own
internal transaction; every method either runs directly against the pooled `sql` or, when
`opts.tx` is supplied, against `resolveTransaction(opts.tx)`
(`src/postgres/transaction-lease.ts`) — identical to `PgTemporalKV`'s existing composition, not a
new pattern this sprint invents.

## 7. Cancellation (`opts.signal`)

Both methods forward `opts.signal` through `withAbort` (`src/postgres/abort.ts`) — pre-check-only,
matching `PgTemporalKV.get`/`put`'s own established use of the same helper, not
`acquireLease`/`listKeys`'s dedicated `raceAgainstAbort`. Neither `set` nor `get` ever blocks on a
lock or holds an open cursor — the two conditions that justify `raceAgainstAbort`'s extra
machinery elsewhere in this codebase — so an already-aborted signal rejects before any statement,
and a signal that aborts after the call has begun has no effect, exactly Sprint 3's own corrected
understanding of `withAbort`'s real contract (`sprint-3-checkpoint-store/design.md` §8).

## 8. Error translation — no additions to `src/postgres/errors.ts`

Per the interface's own doc: "this module defines no error hierarchy of its own; its only failure
modes are the shared infrastructure errors" — `ValidationError` (boundary check, raised directly,
never a SQLSTATE translation), `ConnectionError` (driver-level failure, already handled generically
by `translatePostgresError`), `SerializationFailedError` (a JSONB round-trip failure — not
expected to fire in the currently-used `sql.json()` path, but already a generic, existing
translation, not something this module adds). No new SQLSTATE mapping, matching
`sprint-3-checkpoint-store/design.md` §7's identical conclusion for the same underlying reason:
this module has no database-level constraint whose violation needs a bespoke translated error
type.

## 9. Migration (`003_watermarks.ts`)

Schema-qualified via `sql(schema)`, matching `001_temporal_kv.ts`/`002_checkpoint_store.ts`'s
established pattern — the single `watermarks` table with `fillfactor = 90` (§1), no index beyond
the primary key, no trigger, no extension.

## 10. Test infrastructure

Reuses Sprint 1's `test/postgres/setup.ts` Testcontainers harness unchanged — no new
infrastructure decision needed for this sprint.
