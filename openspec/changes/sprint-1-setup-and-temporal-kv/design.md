# Design — Sprint 1: project setup + TemporalKV

## 0. Schema naming, now that UmbraDB is standalone

`design/design.md` §0 mandated a dedicated `tier1_wallet` Postgres schema to
avoid a confirmed real collision with `midnight-dev-env`'s indexer, which
creates a `public.wallets` table. That collision risk is specific to being
embedded inside that environment; UmbraDB itself has no such neighbor. The
principle still holds (never assume `public` is safe for a library
component another application will also use), but the name should be
UmbraDB's own, not borrowed from its former host: **default schema name is
`umbradb`**, overridable via the connection configuration (§3 below) so a
consuming application can place it wherever fits their own schema
layout — `midnight-dev-env`'s eventual integration can set it back to
`tier1_wallet` if that still makes sense there when the time comes; that's
their call, not baked into UmbraDB itself.

## 1. Package layout

```
src/
  interfaces/          (existing, unchanged — the contract)
  postgres/
    client.ts           connection factory + schema/search_path setup
    migrate.ts           the migration runner (§2)
    errors.ts            Postgres error code -> StorageError translation
    temporal-kv.ts        TemporalKV Postgres adapter (implements src/interfaces/temporal-kv.ts)
migrations/
  001_temporal_kv.sql    the kv_current/kv_history DDL from design/design.md §2, as a real migration file
test/
  postgres/
    setup.ts              Testcontainers bootstrap, shared across all Postgres-backed tests
    temporal-kv.test.ts    unit tests (ported intent from the Mongo package's temporalKv.test.ts)
    temporal-kv.property.test.ts   P1-P5 from Formal/STORAGE_ALGEBRA.md §5, as real fast-check properties
```

Rationale: `src/postgres/` (not `src/adapters/postgres/` or similar) because
there is currently exactly one backend — no abstraction-for-its-own-sake
directory nesting until a second backend actually exists to justify it.

## 2. Migration mechanism

**Decision: a minimal, hand-rolled migration runner — not a new
dependency.** This project's stated style (`design/design.md` §7: no ORM,
hand-written SQL matching the driver's own idioms) argues against adopting
a migration framework (`node-pg-migrate`, `sqlx`-cli, `Atlas`) for what is,
at this stage, a small number of append-only `.sql` files. Reasons:
- `node-pg-migrate` is built against `pg` (node-postgres)'s connection
  model, not `postgres.js`'s — using it would mean depending on a second
  Postgres driver just for migrations, which is exactly the kind of
  incidental complexity this project has avoided elsewhere (`design/design.md`
  §7's driver-choice reasoning applies equally here).
- The actual mechanism needed is simple: a `_migrations` bookkeeping table
  (name, applied_at), a `migrations/NNN_name.sql` file convention, and a
  runner that applies any not-yet-recorded file in order inside a
  transaction, recording it on success. This is worth ~40 lines against
  `postgres.js`'s own `sql.file()`/`sql.begin()`, not a dependency.

`src/postgres/migrate.ts` exports a single `runMigrations(sql: Sql):
Promise<void>` — called once at application startup by whatever consumes
UmbraDB (this project does not run its own migrations automatically on
every `TemporalKV` call; that would be surprising and hard to reason about
in a multi-process scenario). Idempotent: re-running against an
already-migrated database is a no-op.

```sql
-- migrations/000_schema.sql — always first
CREATE SCHEMA IF NOT EXISTS umbradb;
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- needed by migration 001's EXCLUDE constraint

CREATE TABLE IF NOT EXISTS umbradb._migrations (
  name        text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
```

`migrations/001_temporal_kv.sql` adapts `design/design.md` §2's DDL — not
verbatim, because §2's DDL is entirely schema-unqualified
(`CREATE TABLE kv_current`, `INSERT INTO kv_history` inside the trigger
body, etc.), which is a real correctness risk once schema isolation (§0
above) is in play, not just cosmetic.

**Why unqualified names are unsafe here, specifically for the trigger.** A
PL/pgSQL trigger function resolves unqualified table names against its
*caller's* `search_path` at execution time, not against whatever
`search_path` was active when the function was created. `client.ts` (§3)
sets `search_path` on connections it creates, but the migration runner
receives an *injected* `Sql` — nothing guarantees that connection's
`search_path` is `umbradb` (or whatever schema was configured) at the
moment `put` actually runs and the trigger fires. If it isn't, the trigger
silently writes history rows into the wrong schema (or errors if no
matching table is visible at all) — exactly the kind of subtle,
works-in-dev-fails-in-production bug this project's review process exists
to catch before it ships, not after.

**Fix, mandatory for this migration file:** every table/function name
inside `migrations/001_temporal_kv.sql` MUST be schema-qualified
explicitly (`umbradb.kv_current`, `umbradb.kv_history`, and the trigger
function body's `INSERT INTO umbradb.kv_history ...`) — do not rely on
`search_path` for DDL name resolution inside this file, even though §3's
`client.ts` also sets `search_path` for the ordinary query convenience of
callers. Schema qualification in the DDL is the correctness mechanism;
`search_path` is a convenience layered on top for `PgTemporalKV`'s own
queries, not a substitute for it inside the trigger.

## 3. Connection factory (`src/postgres/client.ts`)

```typescript
import postgres, { type Sql } from "postgres";

export interface UmbraDBConnectionOptions {
  /** A postgres:// connection string, or omit to use PG* environment variables (postgres.js default). */
  connectionString?: string;
  /** Schema to operate in and to set as this connection's search_path. Default: "umbradb". */
  schema?: string;
  /** Max pool size for the general-purpose pool. Default: postgres.js's own default (10). */
  maxConnections?: number;
}

export function createClient(opts: UmbraDBConnectionOptions = {}): Sql {
  const schema = opts.schema ?? "umbradb";
  return postgres(opts.connectionString, {
    max: opts.maxConnections,
    connection: { search_path: schema },
    // onnotice/debug hooks: deliberately NOT wired here yet — this is
    // Performance's workstream (Performance/README.md), not Sprint 1's.
    // Note for that future work: postgres.js has NATIVE `debug`/`onnotice`
    // hooks (confirmed during this project's Performance research review)
    // — check those before reaching for anything heavier.
  });
}
```

Every `TemporalKV` (and later module) adapter takes a `Sql` instance via
constructor injection — this repo does not own a connection-pool
singleton; the consuming application decides connection lifecycle.

## 4. `PgTemporalKV` adapter (`src/postgres/temporal-kv.ts`)

Implements `TemporalKV` from `src/interfaces/temporal-kv.ts` exactly —
no additional public methods, no narrowed types. Key implementation notes,
each tied to a specific law from `Formal/STORAGE_ALGEBRA.md` §1:

- **`put`** — **corrected after an adversarial technical review found the
  originally-drafted single-statement design was actually wrong** (it would
  have silently inserted a bogus row for a stale-version `put` against a
  missing key, instead of throwing `VersionConflictError` as the interface
  requires). `put` is genuinely THREE distinct statement shapes, chosen by
  which `opts.expectedVersion` case applies — do not attempt to collapse
  these into one query:
  1. **No `expectedVersion` (unconditional write, Law T1's "total" case):**
     `INSERT ... ON CONFLICT (ns, scope, key) DO UPDATE SET value = ...,
     version = kv_current.version + 1, ...` — a plain upsert, always
     succeeds, version increments unconditionally.
  2. **`expectedVersion = 0n` ("must not already exist"):**
     `INSERT ... ON CONFLICT (ns, scope, key) DO NOTHING`, followed by
     checking the actual row count inserted. Zero rows inserted means the
     key already existed — that IS the conflict; re-read the existing row
     to populate `VersionConflictError.actual` with its real version.
  3. **`expectedVersion = N > 0` (CAS against a specific version):** a
     plain `UPDATE kv_current SET ... WHERE ns=$1 AND scope=$2 AND key=$3
     AND version = $N` — NOT an `INSERT ... ON CONFLICT`, because that
     statement shape has no way to express "fail if the row is *absent*";
     it would silently insert a fresh row instead of failing, which is
     exactly the bug the review caught. Zero rows affected here is
     ambiguous between "conflict" and "key never existed" — the adapter
     MUST re-read the row afterward to distinguish them:
     `actual = existing?.version` (a real conflicting version) vs.
     `actual = undefined` (key doesn't exist at all), per
     `src/interfaces/temporal-kv.ts`'s documented contract.

  All three read as an `UPDATE` (or an `INSERT ... ON CONFLICT DO UPDATE`
  taking its conflict branch) for the purposes of firing the
  `kv_history`-populating `BEFORE UPDATE` trigger where applicable — verify
  this holds for whichever exact statement shape 1/2/3 above compile to
  (confirmed sound for `INSERT ... ON CONFLICT DO UPDATE` and for a plain
  `UPDATE`; case 2's `DO NOTHING` branch does not update an existing row and
  correctly does not fire the trigger, since case 2 only succeeds when no
  conflicting row existed to update in the first place).
- **`get`/`getAt`** — the `{version}` branch is a direct `kv_history`/
  `kv_current` lookup by version; the `{at}` branch uses the
  `[valid_from, valid_to)` interval read design/design.md §2 already
  specifies. Both branches validate their result against
  `VersionedEntrySchema` (`src/interfaces/temporal-kv.ts`) before returning
  — this is where `ValidationError`/`SerializationFailedError` get thrown
  for a row whose `value` column somehow fails to parse as valid JSON
  (should be unreachable given `jsonb`'s own storage guarantee, but the
  interface's `@throws` contract promises it, so the adapter must actually
  check, not assume).
- **`listKeys`** — implemented as an `AsyncIterable` backed by
  `postgres.js`'s `sql.cursor()`, not a `SELECT` materialized into an array
  first, per `design-interfaces.md` §1.2's in-process-streaming
  requirement. **More adapter work than a one-line description implies**
  (caught by review): `sql.cursor()` yields *batches* (arrays of rows), not
  individual rows, so the adapter needs a wrapping generator that flattens
  each batch and maps each row to its `Key` (not just "yield the cursor
  directly"). It also must honor `opts.signal` per the interface's
  documented cancellation contract (`temporal-kv.ts`'s `listKeys` doc,
  `design-interfaces.md` §1.2): an abort listener must stop iteration
  (`break` the loop) so the underlying cursor is released rather than left
  open, matching every other module's cancellation convention. Also carry
  the interface's ordering guarantee — newest-version-only per key, in a
  stable order suitable for resumable pagination — the query, not just the
  streaming mechanism, must satisfy this.
- **Transactions (`opts.tx`)** — when a `TransactionHandle` is passed, every
  query in this adapter must run against *that* transaction's connection,
  not a fresh one from the pool. The exact mechanism (how a
  `TransactionHandle` opaque type actually carries a `postgres.js`
  transaction-scoped `sql` callback) is a Transaction/Lease-module design
  question, not TemporalKV's — **this sprint's `TemporalKV` adapter accepts
  `opts.tx` in its signature (matching the interface) but its wiring is
  deferred** until the Transaction/Lease module exists (later sprint).
  **Corrected after review:** deferred wiring does NOT mean silently
  ignoring a caller-supplied `opts.tx` and running outside their intended
  transaction — that is exactly the kind of silent atomicity loss this
  project's review discipline exists to catch. Until real wiring lands,
  `PgTemporalKV` MUST throw an explicit "transaction participation not yet
  supported" error (a clearly-named error, not a generic one, so it's
  unmistakable in a stack trace) whenever `opts.tx` is passed, rather than
  accepting and ignoring it. This makes the gap loud, not latent. Tracked
  as a durable follow-up in `tasks.md` task 1.6 (not just a code comment)
  and as its own Requirement in `specs/temporal-kv/spec.md`, so it cannot
  be forgotten once Transaction/Lease is built in a later sprint.

## 5. Test infrastructure

Per `design/design.md` §8's decision (Testcontainers) — one shared,
session-scoped Postgres container (`test/postgres/setup.ts`), with
migrations run once against it at suite start, and each test file
responsible for cleaning up its own data (`TRUNCATE` between tests, not a
fresh container per test — container startup cost is real and shouldn't be
paid per-test).

`temporal-kv.property.test.ts` implements the five property tests
`Formal/STORAGE_ALGEBRA.md` §5 derives (P1-P5), using `fast-check` (add as
a devDependency) with `fc.property`/`fc.asyncProperty` generating arbitrary
put sequences, versions, and timestamps. P4 and P5 are explicitly marked
ASPIRATIONAL→GUARANTEED in the algebra spec (P4 by the trigger's
`valid_from`-sourcing discipline; P5 by the `GiST EXCLUDE` constraint) —
these two tests are the actual verification that the aspirational parts of
the design hold in the real, running implementation, not just on paper.
