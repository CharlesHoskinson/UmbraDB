# temporal-kv

Two requirements in the merged `openspec/specs/temporal-kv/spec.md` are Postgres-worded but are
**migration-framework and schema-namespacing** requirements — `storage-schema` territory, not
TemporalKV's. `v1.0.0-sqlite-temporal-event-log` (change 2) deliberately did not delta them for that
reason. Because a change's spec deltas resolve against the capability directory they live in, this
change carries a second delta directory so those two requirements are updated by their actual owner.
See this change's `design.md` §16 for the ruling and for the two adjacent requirements this change
deliberately does **not** touch.

**Header discipline.** Both headers below are reproduced byte-for-byte from the merged spec
(`openspec/specs/temporal-kv/spec.md:6` and `:25`), because OpenSpec resolves a modification by
header text and a paraphrase would silently create a new requirement instead. The second header
retains the word "isolation" even though the property it names **narrows** under this change; the
rename is owed to a later change and is recorded as an open ruling in `design.md` §16.4 rather than
taken here.

## MODIFIED Requirements

### Requirement: Migrations are idempotent and ordered

The migration runner SHALL apply each migration in a lineage at most once, in the lineage's declared
order, recording each successful application by name in the schema's prefixed `<schema>_migrations`
table, and SHALL be safe to invoke repeatedly against an already-migrated database. Migrations
remain forward-only: the `Migration` interface stays `up()`-only, with no `down()` and no supported
downgrade (`docs/CONTRACT.md` §2).

Bootstrap state SHALL be detected with
`SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?)`, which returns false
rather than raising on a database that has never been migrated — replacing the PostgreSQL
`to_regclass` probe at `src/postgres/migrate.ts:240-242`.

#### Scenario: Running migrations twice is a no-op the second time
- **WHEN** `runMigrations` is called against a fresh database file, then called again against the
  same now-migrated file with the same schema
- **THEN** the second call SHALL apply zero additional migrations
- **AND** SHALL NOT error
- **AND** the `<schema>_migrations` row set SHALL be unchanged

#### Scenario: A migration failure does not partially apply
- **WHEN** a migration's `up()` raises partway through, after issuing at least one DDL statement
- **THEN** none of that migration's DDL SHALL be visible afterward
- **AND** that migration SHALL NOT be recorded as applied
- **AND** this SHALL rely on SQLite's transactional DDL, not on a compensating cleanup path

#### Scenario: Bootstrap detection on a cold database returns false rather than erroring
- **WHEN** the bootstrap probe runs against a database file with no tables at all
- **THEN** it SHALL return false and SHALL NOT raise
- **AND** the runner SHALL then apply the lineage's first migration as the bootstrap step, reading
  that migration off the lineage array rather than from a hardcoded import
  (`src/postgres/migrate.ts:245-251`)

#### Scenario: Concurrent runs against one database file do not interleave
- **WHEN** two processes invoke `runMigrations` against the same file concurrently
- **THEN** exactly one SHALL apply the lineage and the other SHALL either wait or fail with the
  existing `MIGRATION_LOCK_TIMEOUT` code
- **AND** the exclusion mechanism SHALL be the one specified by `v1.0.0-sqlite-concurrency-lease`;
  no new error code SHALL be introduced for this case
- **AND** this exclusion SHALL carry its inherited qualifier: it rests on SQLite's file-level write
  lock, whose locks live in the `-shm` file under WAL, and therefore holds only under that change's
  source guard plus the documented embedder precondition

### Requirement: Schema isolation is the default, not opt-in

> **Header note.** The header is preserved verbatim so this modification resolves against the merged
> requirement. The property it names narrows: SQLite has no schemas, so the `schema` value
> **namespaces** rather than **isolates**. Renaming the requirement is owed to a later change
> (`design.md` §16.4).

The connection factory SHALL continue to accept a `schema` value defaulting to `DEFAULT_SCHEMA`
(`"umbradb"`, `src/postgres/client.ts:14`, re-exported at `src/index.ts:40`), and every object the
system creates SHALL carry that value as a `<schema>_` name prefix. Because SQLite's table, index
and trigger name spaces are all **global per database file**, the prefix SHALL be applied to index
and trigger names as well as table names. The system SHALL NOT rely on table-name distinctiveness
alone in the sense the PostgreSQL wording meant — the prefix *is* the distinctiveness, applied
uniformly by one function rather than by hand per statement.

The system SHALL NOT set `search_path` (no such statement exists in SQLite) and SHALL NOT create a
schema object (no `CREATE SCHEMA` exists). The narrowed guarantee SHALL be documented: two schema
values in one database file get disjoint object sets, but share one writer lock, one WAL, and one
file, and there is no schema-level teardown operation.

#### Scenario: Default schema is used when none is specified
- **WHEN** a client is created with no `schema` option
- **THEN** every object the migration lineage creates SHALL be named `umbradb_<object>`
- **AND** all subsequent DDL/DML from that client SHALL address only those objects

#### Scenario: A custom schema is honored end to end
- **WHEN** a client is created with `schema: "custom_name"`
- **THEN** migrations and all `TemporalKV` operations on that client SHALL address
  `custom_name_<object>`, not `umbradb_<object>`
- **AND** the `schema` parameter, its type and its default SHALL be unchanged from the PostgreSQL
  implementation — this is not a surface break

#### Scenario: Two schema values coexist in one database file
- **WHEN** the lineage is applied twice against one file under two different `schema` values
- **THEN** both runs SHALL succeed and the file SHALL hold two disjoint sets of tables, indexes and
  triggers
- **AND** a write through one schema's adapters SHALL NOT be visible through the other's

#### Scenario: Unprefixed index and trigger names break the second schema (negative control)
- **GIVEN** a hypothetical port that prefixes table names only, transliterating
  `src/postgres/migrations/002_checkpoint_store.ts:40-41`'s index name and
  `src/postgres/migrations/001_temporal_kv.ts:135`'s trigger name literally
- **WHEN** the lineage is applied a second time under a different `schema` value
- **THEN** that port SHALL fail with `index … already exists` / `trigger … already exists`, because
  those name spaces are file-global rather than table-scoped
- **AND** the failure SHALL be invisible to a single-tenant test suite, which is why the two-schema
  application above is the test that catches it

#### Scenario: The narrowed guarantee is documented rather than implied
- **WHEN** the schema documentation is read after this change
- **THEN** it SHALL state that the `schema` value names rather than isolates, that two values share
  one writer lock and one WAL, and that no schema-level teardown exists
- **AND** it SHALL state that this is a documented capability narrowing disclosed in the CHANGELOG,
  not a change to any exported symbol, type or constructor parameter
