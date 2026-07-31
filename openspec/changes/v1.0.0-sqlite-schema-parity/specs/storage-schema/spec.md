# storage-schema

The SQLite data model for UmbraDB: object naming, column types, constraints, indexes, and the
forward-only migration framework. Requirements follow EARS (Easy Approach to Requirements Syntax),
as in Sprint 2's, Sprint 4's and Sprint 7's spec files.

Scope boundary: the TemporalKV table shapes belong to `v1.0.0-sqlite-temporal-event-log`; the
driver, shim, pragma bootstrap and measurement gate belong to `v1.0.0-sqlite-engine-core`;
transactions and the lease belong to `v1.0.0-sqlite-concurrency-lease`; the error catalog and the
written contracts belong to `v1.0.0-sqlite-durability-contract`. The chain-archive lineage is a
non-goal; where its DDL appears below it is the known instance of a translation rule, not a lineage
this change ports.

## ADDED Requirements

### Requirement: every object name UmbraDB creates carries the schema prefix, including index and trigger names

A SQLite database file has three name spaces UmbraDB writes into — tables (including views and
virtual tables), **indexes**, and **triggers** — and all three are global per file. The system
SHALL derive every such name from a single `qualify(schema, name)` function producing
`<schema>_<name>`. No DDL statement SHALL contain a literal object name for an object it creates.
Column names and constraint names are not file-global and SHALL NOT be prefixed.

#### Scenario: The whole lineage applies twice under two schema values against one file
- **WHEN** the migration lineage is applied against one database file with `schema = "umbradb"` and
  then again with `schema = "tenant_a"`
- **THEN** both runs SHALL succeed
- **AND** the file SHALL contain two disjoint sets of tables, indexes and triggers
- **AND** a write through an adapter constructed with one schema SHALL NOT be readable through an
  adapter constructed with the other

#### Scenario: An unprefixed index name breaks the second schema (negative control)
- **GIVEN** a hypothetical port that prefixes table names but transliterates
  `002_checkpoint_store.ts:40-41`'s index name literally as `ckpt_manifests_lookup`
- **WHEN** the lineage is applied a second time with a different `schema` value
- **THEN** that hypothetical port SHALL fail with `index ckpt_manifests_lookup already exists`,
  because index names are global per database file and not scoped by the table they index
- **AND** the failure SHALL NOT appear in a single-tenant test suite, which is why the
  two-schema application above is the test that catches it

#### Scenario: An unprefixed trigger name breaks the second schema (negative control)
- **GIVEN** a hypothetical port that transliterates `001_temporal_kv.ts:135`'s trigger name
  literally as `kv_current_history_bu`
- **WHEN** the lineage is applied a second time with a different `schema` value
- **THEN** that hypothetical port SHALL fail with a `trigger … already exists` error, for the same
  reason as the index case

#### Scenario: Static inspection finds no literal created-object name
- **WHEN** the SQL text every migration emits is inspected
- **THEN** every `CREATE TABLE` / `CREATE INDEX` / `CREATE TRIGGER` / `CREATE VIEW` object name
  SHALL begin with the schema prefix passed to that migration
- **AND** no column name and no constraint name SHALL carry the prefix

### Requirement: the schema parameter and DEFAULT_SCHEMA survive the engine change byte-for-byte

The system SHALL preserve `DEFAULT_SCHEMA` (`src/postgres/client.ts:14`, re-exported at
`src/index.ts:40`) as an exported `string` with the value `"umbradb"`, and SHALL preserve every
adapter's `schema` constructor parameter and its default. Migrating to SQLite SHALL NOT remove,
rename or retype any of them, and SHALL NOT require a major version on their account.

#### Scenario: The frozen surface is unchanged
- **WHEN** the exported surface is compared before and after the migration
- **THEN** `DEFAULT_SCHEMA` SHALL still be exported, SHALL still be typed `string`, and SHALL still
  equal `"umbradb"`
- **AND** every adapter constructor that accepted a `schema` parameter SHALL still accept it with
  the same type and the same default

#### Scenario: An existing caller passing a non-default schema keeps working
- **WHEN** a caller constructs adapters with `schema: "tenant_a"`
- **THEN** the caller SHALL compile unchanged and SHALL get its own separate set of tables
- **AND** the documented meaning of the parameter SHALL be narrowed in `docs/` from *isolates* to
  *names*: one writer lock, one WAL, no schema-level teardown

#### Scenario: Dropping schema configurability is not the chosen option (negative control)
- **GIVEN** a hypothetical port that removes `DEFAULT_SCHEMA` and the `schema` constructor
  parameters on the grounds that SQLite has no schemas
- **THEN** that port SHALL be a G1 surface break requiring a major version if landed after the
  1.0.0 tag — and it SHALL be recorded that the break is entirely avoidable, because table-name
  prefixing delivers the same SQLite reality with the surface intact

### Requirement: schema emulation SHALL NOT be implemented as one database file per schema

The system SHALL NOT implement the `schema` parameter by mapping each schema to its own file
reached via `ATTACH`.

#### Scenario: A foreign key cannot reach an attached database
- **WHEN** a `REFERENCES` clause names a table in an `ATTACH`ed database
- **THEN** SQLite SHALL reject it as a syntax error at the qualifying dot
- **AND** because `002_checkpoint_store.ts:58,60` and this change's identifiers junction both
  declare intra-lineage foreign keys, a per-schema file cannot express UmbraDB's schema

#### Scenario: The attach limit caps the parameter at eleven
- **WHEN** the compile-time limit is read from `pragma compile_options`
- **THEN** `SQLITE_MAX_ATTACHED` SHALL be 10, i.e. at most ten attached databases plus `main`
- **AND** a `schema` parameter that silently caps tenants at eleven SHALL be rejected as an
  implementation of a parameter documented as free-form

### Requirement: every table is STRICT and a wrong-typed write is rejected, not coerced

Every table the system creates SHALL be declared `STRICT`. WHEN a value whose storage class does
not match a column's declared type is bound to that column, the system SHALL reject the write with
a datatype error and SHALL NOT coerce or silently store it.

#### Scenario: A string bound to an integer column is rejected
- **WHEN** the string `"notanint"` is bound to an `INTEGER` column of a `STRICT` table
- **THEN** the write SHALL fail with a datatype-mismatch error
- **AND** no row SHALL be stored

#### Scenario: An ISO-8601 timestamp bound to an epoch-ms column is rejected
- **WHEN** a `Date` normalized to ISO-8601 **text** is bound to an `INTEGER` timestamp column
- **THEN** the write SHALL fail with a message naming the column and both types
- **AND** this SHALL hold regardless of whether the normalization bug lives in the shim or in a
  call site

#### Scenario: Without STRICT the same write is silently accepted (negative control)
- **GIVEN** a hypothetical port that omits `STRICT` in order to keep Postgres-shaped declared type
  names (`JSONB`, `BYTEA`, `TIMESTAMPTZ`) readable to a declared-type-driven row decoder
- **WHEN** the two writes above are issued against that port
- **THEN** the string SHALL be stored in the `INTEGER` column with `typeof()` reporting `text`, and
  no error SHALL be raised
- **AND** because every `INTEGER` sorts before every `TEXT`, a
  `WHERE ts <= :t ORDER BY ts DESC LIMIT 1` lookup SHALL return the latest row for every `:t`,
  making `Formal/STORAGE_ALGEBRA.md` §1's Law T3 silently false with the mechanized proof still
  green — the failure mode `STRICT` exists to convert into an exception

#### Scenario: The declared-type vocabulary is restricted, and the decoder depends on origin metadata
- **WHEN** a table is declared `STRICT` with a column typed `JSONB`, `BYTEA`, `TIMESTAMPTZ` or
  `BIGINT`
- **THEN** SQLite SHALL reject the `CREATE TABLE` with `unknown datatype`
- **AND** the system SHALL therefore declare columns only as `INT`, `INTEGER`, `REAL`, `TEXT`,
  `BLOB` or `ANY`
- **AND** row decoding SHALL be keyed on `columns()` **origin** metadata (`{database, table,
  column}`), not on declared type names — a dependency on `v1.0.0-sqlite-engine-core`, which owns
  the shim

### Requirement: each PostgreSQL type class maps to exactly one SQLite declared type

The system SHALL map `text`→`TEXT`, `jsonb`→`TEXT` (the `JSON.stringify` output stored verbatim,
never passed through `json()`/`jsonb()`), `bytea`→`BLOB`, `timestamptz`→`INTEGER` holding epoch
milliseconds, `boolean`→`INTEGER` plus a domain `CHECK`, `bigint`→`INTEGER`, and
`bigserial`/`GENERATED ALWAYS AS IDENTITY`→`INTEGER PRIMARY KEY AUTOINCREMENT`. No column SHALL be
declared `ANY`.

#### Scenario: A stored JSON document round-trips byte-identically
- **WHEN** a JSON document containing large integers, unicode, a specific key order and duplicate
  keys is written to a `TEXT` column as the output of `JSON.stringify` and read back
- **THEN** the returned string SHALL be byte-identical to what was written
- **AND** no `json()` or `jsonb()` call SHALL appear on the write path, so no key reordering,
  duplicate-key collapse or whitespace stripping SHALL occur

#### Scenario: Surrogate-pair and NUL rejection is retained, not relaxed
- **WHEN** a string containing a NUL byte or an unpaired UTF-16 surrogate is submitted to any
  adapter
- **THEN** the system SHALL reject it before any statement is issued, retaining the guard at
  `src/interfaces/temporal-kv.ts:35-37`
- **AND** the guard's documented rationale SHALL be updated from "Postgres cannot store it" to
  "SQLite stores it silently wrong": a NUL round-trips through the driver intact while `length()`
  truncates at it, and a lone surrogate is silently replaced by U+FFFD

#### Scenario: A generated identity value is never reused after a delete
- **WHEN** rows with generated ids 1, 2 and 3 exist, row 3 is deleted, and a new row is inserted
- **THEN** the new row's id SHALL NOT be 3
- **AND** this SHALL hold because `AUTOINCREMENT` is used rather than a bare rowid alias, which
  reuses the deleted maximum — a case reachable in production because `prune()`
  (`src/postgres/checkpoint-store.ts:511-522`) deletes `ckpt_manifests` rows

### Requirement: domain constraints lost with the PostgreSQL type system are restored as named CHECK constraints

The system SHALL express every column domain that `STRICT` alone does not enforce as a `CHECK`
constraint, and every `CHECK` SHALL be given an explicit `CONSTRAINT <name>` so the name appears in
the failure message. Byte-length predicates SHALL use `octet_length()`, never `length()`.

#### Scenario: A content address of the wrong length is rejected
- **WHEN** a `ckpt_chunks` row is inserted whose `hash` is not exactly 32 bytes
- **THEN** the insert SHALL fail with a `CHECK constraint failed` message naming the constraint
- **AND** this SHALL be recorded as a guarantee UmbraDB gains, since PostgreSQL `bytea`
  (`002_checkpoint_store.ts:14`) enforced no length at all

#### Scenario: A non-boolean value in a boolean-derived column is rejected
- **WHEN** the value `2` is written to `ckpt_manifests.complete`
- **THEN** the insert SHALL fail the `complete IN (0,1)` constraint
- **AND** without that constraint the column's domain would be every 64-bit integer, because
  `STRICT` restores the class but not the domain of PostgreSQL's `boolean`

#### Scenario: An out-of-domain lifecycle discriminant is rejected
- **WHEN** a `transaction_history` row is written with `lifecycle = 'bogus'`
- **THEN** the insert SHALL fail the lifecycle enum constraint
- **AND** this SHALL be recorded as a guarantee UmbraDB gains, since
  `004_transaction_history.ts:30` declares the column as bare `text` and the domain lived only in
  the TypeScript type

#### Scenario: length() on a TEXT column would count characters, not bytes (negative control)
- **GIVEN** a hypothetical port that writes `length(data)` instead of `octet_length(data)`
- **WHEN** the predicate is applied to a column that holds text rather than a blob
- **THEN** that port SHALL count **characters**, so a 5-character 6-byte string reports 5
- **AND** the difference SHALL be invisible for as long as every value happens to be a BLOB, which
  is why `octet_length` is required rather than recommended

### Requirement: identifier containment is a junction table whose predicate is row-subset-of-the-finalizing-set

The system SHALL replace `transaction_history.identifiers text[]` and its GIN index
(`004_transaction_history.ts:29,39-42`) with a junction table keyed
`(wallet_id, tx_hash, identifier)` carrying a reverse index on `(wallet_id, identifier, tx_hash)`.

WHEN an entry is finalized or rejected, the system SHALL delete a *different* pending row for the
same wallet **iff** that row's identifier set is **non-empty** AND is a **subset of** the finalizing
entry's identifier set — the `<@` ("contained by") direction of
`src/postgres/transaction-history-storage.ts:518-523`, with set semantics (duplicates and order in
the row's identifiers are ignored). The system SHALL NOT use the `@>` ("contains") direction.

#### Scenario: A strict subset is cleared
- **WHEN** a pending row has identifiers `{a}` and an entry finalizes with identifiers `{a, b}`
- **THEN** the pending row SHALL be deleted

#### Scenario: An equal set is cleared
- **WHEN** a pending row has identifiers `{a, b}` and an entry finalizes with identifiers `{a, b}`
- **THEN** the pending row SHALL be deleted

#### Scenario: A superset survives — the case an inverted predicate deletes
- **WHEN** a pending row has identifiers `{a, b, c}` and an entry finalizes with identifiers
  `{a, b}`
- **THEN** the pending row SHALL survive
- **AND** this is the diagnostic case: it is exactly the row an implementation using the `@>`
  direction would delete

#### Scenario: An overlapping but non-contained set survives
- **WHEN** a pending row has identifiers `{b, z}` and an entry finalizes with identifiers `{a, b}`
- **THEN** the pending row SHALL survive

#### Scenario: A disjoint set survives
- **WHEN** a pending row has identifiers `{z}` and an entry finalizes with identifiers `{a, b}`
- **THEN** the pending row SHALL survive

#### Scenario: An empty identifier set never clears and is never cleared
- **WHEN** a pending row has zero identifiers and an entry finalizes with identifiers `{a, b}`
- **THEN** the pending row SHALL survive, because the predicate requires a non-empty row set
- **AND WHEN** an entry finalizes with zero identifiers
- **THEN** no pending row SHALL be cleared, because an empty set is vacuously a subset of every set
  and the clear would otherwise delete every unrelated pending entry in the wallet

#### Scenario: A duplicated identifier in the row is treated as a set
- **WHEN** a pending row is written with identifiers `[a, a]` and an entry finalizes with
  identifiers `{a, b}`
- **THEN** the pending row SHALL be deleted
- **AND** the junction table's `PRIMARY KEY (wallet_id, tx_hash, identifier)` SHALL make this
  structural rather than dependent on application-side deduplication

#### Scenario: Another wallet's rows are untouched
- **WHEN** two wallets each hold a pending row with identifiers `{a}` and one wallet finalizes an
  entry with identifiers `{a, b}`
- **THEN** only the finalizing wallet's pending row SHALL be deleted

#### Scenario: The inverted direction is a wrong-rows-deleted bug (negative control)
- **GIVEN** a hypothetical port that implements the containment as `@>` (the finalizing set is a
  subset of the row's set)
- **WHEN** it is run against the fixture rows `{}`, `{a}`, `{a,b}`, `{a,b,c}`, `{z}`, `{b,z}`,
  `[a,a]` with a finalizing set `{a, b}`
- **THEN** that port SHALL select `{a,b}` and `{a,b,c}`, whereas the correct predicate selects
  `{a}`, `{a,b}` and `[a,a]` — the two answers agree on exactly one row out of seven
- **AND** a test suite that exercises only the equal-set case SHALL pass against both, which is why
  the superset and duplicate cases above are required scenarios rather than optional ones

#### Scenario: FTS5 is rejected because it answers the other direction
- **GIVEN** that `ENABLE_FTS5` is present in `pragma compile_options`
- **WHEN** FTS5 is considered as the containment index
- **THEN** it SHALL be rejected on semantics: an inverted token index answers "which rows contain
  this token", i.e. the `@>` direction, whereas subset is a universal quantification over the row's
  own tokens that no inverted index answers directly

#### Scenario: The containment query is index-driven, not a wallet scan
- **WHEN** `EXPLAIN QUERY PLAN` is taken for the pending-clear `DELETE`
- **THEN** the candidate-generation subquery SHALL resolve to a search of the reverse index on
  `(wallet_id, identifier)`
- **AND** the plan SHALL NOT resolve to a bare `SEARCH … USING PRIMARY KEY (wallet_id=?)` over the
  whole wallet
- **AND** any latency figure quoted for this query SHALL be established on ext4 under
  `v1.0.0-sqlite-engine-core`'s measurement gate, never carried from a tmpfs benchmark

### Requirement: an identifier set is replaced wholesale on every write, never merged in place

WHEN an entry is written, the system SHALL upsert the entry row, delete every junction row for
`(wallet_id, tx_hash)`, and insert the incoming identifier set — all within one transaction.

#### Scenario: A shrinking identifier set leaves no orphan rows
- **WHEN** an entry previously written with identifiers `{a, b, c}` is rewritten with identifiers
  `{c}`
- **THEN** the junction table SHALL hold exactly one row for that `(wallet_id, tx_hash)`
- **AND** a subsequent containment evaluation SHALL see `{c}`, not `{a, b, c}`

#### Scenario: Deleting a parent row removes its junction rows
- **WHEN** a pending row is cleared by the containment `DELETE`
- **THEN** its junction rows SHALL be removed by `ON DELETE CASCADE` in the same statement

#### Scenario: The identifier insert binds a fixed number of parameters
- **WHEN** an entry carrying an arbitrary number of identifiers is written
- **THEN** the identifier insert SHALL bind exactly three parameters, taking the values from
  `json_each` over a single JSON-array parameter
- **AND** `SQLITE_MAX_VARIABLE_NUMBER` SHALL therefore place no bound on the number of identifiers
  an entry may carry

### Requirement: uniqueness over a nullable key column is emulated by a coalesce expression index with a domain-excluded sentinel

PostgreSQL's `UNIQUE NULLS NOT DISTINCT` has no SQLite equivalent; SQLite's `UNIQUE` matches
PostgreSQL's *default*, under which every NULL is distinct from every other NULL. The system SHALL
therefore express any uniqueness constraint whose key includes a nullable column as a
`CREATE UNIQUE INDEX` over `coalesce(<column>, <sentinel>)`, and SHALL in the same migration add a
`CHECK` excluding that sentinel from the column's real domain. A plain `UNIQUE (…)` over a nullable
key column SHALL NOT appear in any UmbraDB lineage.

#### Scenario: Two legitimately distinct NULL-address observations are both accepted
- **WHEN** two protocol-scoped observations of the same key differing only in `net` are inserted,
  both with `contract_address IS NULL`
- **THEN** both SHALL persist as distinct rows

#### Scenario: An exact duplicate NULL-address context is rejected
- **WHEN** a second row is inserted with the same `(vk_hash, net, scope, tag)` and
  `contract_address IS NULL`
- **THEN** the insert SHALL be rejected by the unique expression index

#### Scenario: A plain UNIQUE silently reintroduces the bug the v4 audit closed (negative control)
- **GIVEN** a hypothetical port that transliterates
  `src/postgres/migrations/chain_archive/001_chain_archive_core.ts:570`'s
  `UNIQUE NULLS NOT DISTINCT (vk_hash, net, scope, contract_address, tag)` as a plain
  `UNIQUE (vk_hash, net, scope, contract_address, tag)`
- **WHEN** the exact-duplicate NULL-address insert above is issued
- **THEN** that port SHALL **accept** it, because SQLite treats every NULL as distinct
- **AND** the duplicate SHALL be exactly the data-loss defect recorded at
  `001_chain_archive_core.ts:63-70` ("two legitimate different-entry-point observations of the same
  VK collided and one was lost") and at `:522-529` ("ordinary `UNIQUE` … would NOT have caught that
  duplicate")
- **AND** the port SHALL pass every test whose rows have a non-NULL address, which is why the
  NULL-address scenarios above are required

#### Scenario: The sentinel is excluded from the column's real domain
- **WHEN** a zero-length value is written to a nullable column whose uniqueness is emulated with an
  `x''` sentinel
- **THEN** the write SHALL be rejected by the accompanying
  `CHECK (<column> IS NULL OR octet_length(<column>) > 0)`
- **AND** without that `CHECK`, a genuine zero-length value would collide with the NULL sentinel and
  a legitimately distinct row would be wrongly rejected — a new bug traded for the old one

#### Scenario: The rule is enforced statically, not only by tables that exist today
- **WHEN** the SQL text of every migration in every lineage is inspected
- **THEN** no `UNIQUE` constraint or unique index SHALL name a nullable column directly
- **AND** this check SHALL run even though the tier-1 lineage has no such constraint today, because
  the only in-repo instance lives in the deferred chain-archive lineage and the rule would otherwise
  be lost with it

### Requirement: listKeys matches a literal prefix with a half-open range scan, not LIKE

The system SHALL implement `listKeys(namespace, scope, prefix)` as
`key >= :prefix AND key < :prefixUpper`, SHALL NOT use `LIKE`, and SHALL delete `escapeLikePrefix`
(`src/postgres/temporal-kv.ts:50`). `PRAGMA case_sensitive_like` SHALL NOT be used.

#### Scenario: A case-differing key does not match
- **WHEN** the keys `ab`, `abc`, `abcd`, `abd`, `Abc` and `aBc` exist and `listKeys` is called with
  prefix `ab`
- **THEN** the result SHALL be exactly `ab`, `abc`, `abcd`, `abd`

#### Scenario: LIKE would match case-insensitively and would not use the index (negative control)
- **GIVEN** a hypothetical port that transliterates `src/postgres/temporal-kv.ts:317-323` as
  `key LIKE :escaped ESCAPE '\'`
- **WHEN** it is run against the same key set
- **THEN** it SHALL also return `Abc` and `aBc`, because SQLite's `LIKE` is case-insensitive for
  ASCII by default
- **AND** `EXPLAIN QUERY PLAN` SHALL show `SEARCH … USING PRIMARY KEY (ns=? AND scope=?)` with no
  key range, i.e. a scan of every key in the `(ns, scope)` group
- **AND** both defects SHALL be invisible to a test suite whose keys are all lowercase and small

#### Scenario: The range scan uses the primary-key range
- **WHEN** `EXPLAIN QUERY PLAN` is taken for the range form
- **THEN** it SHALL show a key range on the `key` column in addition to `ns` and `scope`

#### Scenario: The prefix upper bound is a Unicode scalar successor
- **WHEN** the prefix's last code point is `c`
- **THEN** `:prefixUpper` SHALL be the prefix with `c` replaced by the next **Unicode scalar
  value** — `c + 1`, except that the successor of U+D7FF SHALL be U+E000, since U+D800–U+DFFF are
  surrogates and binding one would be the lone surrogate the input guard rejects and the driver
  would silently replace with U+FFFD
- **AND WHEN** the prefix is empty
- **THEN** the upper bound SHALL be omitted entirely rather than synthesized
- **AND WHEN** the last code point is U+10FFFF
- **THEN** it SHALL be stripped and the successor recomputed on the shortened prefix, omitting the
  bound if that empties it

#### Scenario: A prefix containing LIKE metacharacters is matched literally
- **WHEN** `listKeys` is called with a prefix containing `%`, `_` or `\`
- **THEN** those characters SHALL be matched literally, satisfying
  `src/interfaces/temporal-kv.ts:314-321`'s requirement that implementations must not interpret
  pattern-matching metacharacters
- **AND** no escaping step SHALL exist to get wrong

### Requirement: listKeys ordering is code-point order and the one-time resume-cursor reorder is disclosed

The system SHALL order `listKeys` results by SQLite's default `BINARY` collation, which is UTF-8
byte order and therefore Unicode code-point order. This satisfies
`src/interfaces/temporal-kv.ts:314`'s promise of "a stable order for resumable pagination", which
names no collation, so it is NOT a contract break. The system SHALL document the one-time reorder a
migrating consumer would observe.

#### Scenario: Ordering is asserted by code point, not by a JavaScript sort
- **WHEN** a test asserts `listKeys` ordering over a key set containing a supplementary-plane code
  point (≥ U+10000) and a key in U+E000–U+FFFF
- **THEN** the expected order SHALL be computed by code point
- **AND** a bare JavaScript `Array.prototype.sort()` SHALL NOT be used as the oracle, because JS
  string comparison is over UTF-16 code units and orders a leading surrogate before U+E000–U+FFFF
- **AND** this divergence is an inference from the two encodings, not a measured result, so the test
  is what establishes it

#### Scenario: A resume cursor persisted under PostgreSQL ordering may skip or repeat once
- **WHEN** a consumer persisted a `listKeys` resume position under a PostgreSQL locale collation and
  resumes under SQLite `BINARY`
- **THEN** it MAY skip or repeat keys exactly once, at the migration boundary
- **AND** this SHALL be stated in the migration notes rather than discovered
- **AND** it SHALL be recorded as free pre-tag (there are no shipped SQLite databases) and a
  live-migration data hazard post-tag

### Requirement: WITHOUT ROWID is used only for narrow tables and never for payload-bearing tables

The system SHALL declare `WITHOUT ROWID` only on tables whose rows are small relative to a page, and
SHALL NOT declare it on `ckpt_chunks` or any other table whose rows carry a multi-kilobyte payload.

#### Scenario: The content-addressed chunk table is a plain rowid table
- **WHEN** `ckpt_chunks` is created
- **THEN** it SHALL be a plain rowid table with `hash BLOB NOT NULL PRIMARY KEY`
- **AND** re-keying it to `id INTEGER PRIMARY KEY` with `hash BLOB UNIQUE` SHALL NOT be adopted,
  because in SQLite a non-`INTEGER` primary key on a rowid table is already implemented as a
  separate unique index and the two shapes were measured as the same object

#### Scenario: The obvious answer is ruled against, with the evidence and its limits
- **WHEN** `WITHOUT ROWID` is proposed for the 32-byte-hash-primary-key content-addressed tables on
  the grounds that a hash primary key is an obvious candidate
- **THEN** it SHALL be rejected, on two independent measurements in the same direction — a
  2.0×–3.8× point-read regression across 4 KiB / 64 KiB / 4 MiB rows, and an independent 3.3×
  ingest regression at ~11 KB mean payload — and on the structural reason that in a `WITHOUT ROWID`
  table the primary-key b-tree *is* the table, so descending it pages through payload-carrying
  records
- **AND** the *factors* SHALL NOT be carried as fact, because both measurements were taken against a
  tmpfs RAM disk; only the direction is carried, and it SHALL be re-confirmed on ext4 under
  `v1.0.0-sqlite-engine-core`'s measurement gate

#### Scenario: The conditions under which the negative would be meaningless are stated
- **WHEN** the ruling above is reviewed
- **THEN** it SHALL record that the negative would not hold if (a) access were dominated by ordered
  full scans in primary-key order rather than point lookups — refuted, since `load()`
  (`src/postgres/checkpoint-store.ts:340-346`) is a point join by hash and `prune()`'s reclaim
  (`:518-525`) is a `NOT EXISTS` predicate delete; (b) the rows were small relative to a page —
  true only for the narrow tables, which is why those *do* get `WITHOUT ROWID`; or (c) the profile
  were cold-cache and I/O-bound rather than warm-cache and single-threaded — not refuted, but
  expected to *widen* the gap rather than close it
- **AND** if the ext4 re-measurement inverts the *direction*, the assignment SHALL be reopened

#### Scenario: AUTOINCREMENT forces a rowid table regardless
- **WHEN** a table requires `INTEGER PRIMARY KEY AUTOINCREMENT`
- **THEN** it SHALL be a rowid table, because `AUTOINCREMENT` is rejected on a `WITHOUT ROWID` table

#### Scenario: Rowid-based chunked deletes are unavailable on the narrow tables
- **WHEN** a future remediation needs a bounded delete on a `WITHOUT ROWID` table
- **THEN** it SHALL NOT use `DELETE … WHERE rowid IN (SELECT rowid … LIMIT n)`, and SHALL bound the
  subquery by the table's primary key instead
- **AND** `DELETE … LIMIT` SHALL NOT be used at all, being a syntax error in SQLite

### Requirement: migration 006 replays verbatim, and no future migration adds a STORED generated column to a populated table

The system SHALL transliterate `src/postgres/migrations/006_ckpt_chunks_size_bytes.ts:16-19`
unchanged, retaining `GENERATED ALWAYS AS (octet_length(data)) STORED`. It SHALL NOT substitute a
`VIRTUAL` column and SHALL NOT fold the column into migration `002`.

#### Scenario: A fresh lineage applies 006 successfully
- **WHEN** the lineage is applied in order `000` → `006` against an empty database
- **THEN** `006` SHALL succeed, because `ckpt_chunks` holds zero rows at that point and SQLite
  accepts `ADD COLUMN … GENERATED … STORED` on a 0-row table
- **AND** `history()`'s aggregate SHALL be able to `sum(size_bytes)` exactly as it does today
  (`src/postgres/checkpoint-store.ts:439`)

#### Scenario: The same statement on a populated table fails, and that failure is pinned by a test
- **WHEN** `000` → `005` is applied, one `ckpt_chunks` row is inserted, and `006` is then applied
- **THEN** it SHALL fail with `cannot add a STORED column`
- **AND** this test SHALL exist in order to make the forward constraint executable rather than
  advisory, and SHALL run against a throwaway database that is not the shipped lineage

#### Scenario: "SQLite refuses it outright" is the imprecise reading (negative control)
- **GIVEN** the earlier conclusion that `ADD COLUMN … GENERATED … STORED` is refused outright, and
  the `VIRTUAL`-column workaround derived from it
- **WHEN** the statement is measured against both a 0-row and a ≥1-row table
- **THEN** the 0-row case SHALL succeed and only the ≥1-row case SHALL fail
- **AND** the workaround SHALL therefore be unnecessary, and the argument that the pre-1.0.0 tag
  window is chiefly valuable for this item SHALL be recorded as void

#### Scenario: The forward constraint is documented for future migrations
- **WHEN** any future migration is proposed that adds a `STORED` generated column
- **THEN** it SHALL be rejected unless the target table is provably empty at that point in the
  lineage
- **AND** the alternatives SHALL be recorded as: a `VIRTUAL` generated column, which always
  succeeds and is indexable; or a full table rebuild, whose peak on-disk footprint was measured at
  **3.5×** the logical data — not the 2× commonly assumed — because the rebuild sits in one WAL
  that cannot be checkpointed until it commits

### Requirement: the writer-generation table is created and seeded by the migration lineage

The cross-process writer guard specified by `v1.0.0-sqlite-concurrency-lease` requires a single-row
registration table in the main database file, and that change's D-4 defers the table's physical name
and prefixing to this capability. The system SHALL create it as a first-class table in the migration
lineage, in a new migration `007_writer_generation`, and SHALL apply to it every invariant this
capability imposes on every other table: the `<schema>_` prefix produced by `qualify()`, `STRICT`,
and named `CHECK` constraints.

The system SHALL insert the singleton row in the same migration that creates the table, with
`generation = 0`.

The read/write protocol, the generation bump, the displacement error, and the points at which the
generation is re-read are **NOT** specified here — they belong to `v1.0.0-sqlite-concurrency-lease`
§2.2. This requirement covers the table's existence, shape and seeding only.

#### Scenario: The table is created by the lineage and obeys the schema's own invariants
- **WHEN** the migration lineage is applied against a fresh database file
- **THEN** a table named `<schema>_writer_generation` SHALL exist
- **AND** it SHALL be declared `STRICT`
- **AND** its `id = 1` singleton constraint SHALL be a **named** `CONSTRAINT`, so the name reaches
  the failure message and `v1.0.0-sqlite-durability-contract`'s error translation has a stable key
- **AND** it SHALL be covered by the two-schema application test, i.e. two `schema` values SHALL
  yield two independent writer-generation tables in one file

#### Scenario: The singleton row exists before any writer registers
- **WHEN** the lineage has been applied and no process has yet registered
- **THEN** exactly one row SHALL exist, with `id = 1` and `generation = 0`
- **AND** the first process to register SHALL therefore read back `generation = 1`

#### Scenario: An unseeded table makes the guard silently guard nothing (negative control)
- **GIVEN** a hypothetical port that creates the table but leaves seeding to the registration step,
  whose protocol is `UPDATE … WHERE id = 1` followed by a read-back rather than an upsert
- **WHEN** the first process registers
- **THEN** the `UPDATE` SHALL match zero rows, the read-back SHALL return no row, and that process's
  generation SHALL be undefined — while every statement reports success and nothing raises
- **AND** the guard SHALL therefore admit the second writer it exists to refuse, which is why the
  seed row belongs to the migration and not to the registration

#### Scenario: A second row cannot be inserted
- **WHEN** a row with `id = 2` is inserted into `<schema>_writer_generation`
- **THEN** the insert SHALL be rejected by the named singleton constraint

#### Scenario: The guard's first read happens strictly after its own migration commits
- **WHEN** a process opens the database
- **THEN** the order SHALL be: `runMigrations` completes, creating and seeding the table; then the
  writer registers and reads back its generation; then adapter write transactions begin
- **AND** migration transactions SHALL NOT be covered by the generation guard, because no process
  holds a generation before registration — they SHALL instead be excluded across processes by the
  migration lock, surfacing as the existing `MIGRATION_LOCK_TIMEOUT` code
- **AND** cross-process exclusion SHALL therefore be continuous across the handover, with no window
  in which neither mechanism applies

### Requirement: sequence allocation is guarded by a runtime invariant, with uniqueness as defence-in-depth

A corrupted `ckpt_sequence_counters.next_seq` causes `save()` to allocate a sequence below the
existing maximum, after which `load()` — which selects `ORDER BY seq DESC LIMIT 1`
(`src/postgres/checkpoint-store.ts:328-334`) — returns a stale checkpoint forever while every save
reports success. The stored bytes are intact and the *reachability* is wrong, so no per-value digest
detects it.

WHEN `save()` allocates a sequence, the system SHALL assert within the same transaction that the
claimed `seq` is strictly greater than `coalesce(max(seq), 0)` over existing manifests for that
`(w, net)`, and SHALL abort the save with a non-retryable error if it is not. The assert SHALL read
`max(seq)` **without** filtering on `complete`.

The system SHALL additionally declare `UNIQUE (w, net, seq)` on `ckpt_manifests` as a **full**
unique index, not a partial one. The system SHALL NOT treat that index as closing the gap: it is
defence-in-depth, and the runtime invariant is the fix.

The error code belongs to `v1.0.0-sqlite-durability-contract`'s catalog and is not chosen here; it
SHALL be non-retryable, and a new code SHALL NOT be minted without first checking the existing
catalog.

#### Scenario: A downward-corrupted counter is refused at the next save
- **WHEN** `next_seq` is corrupted to a value at or below the current `max(seq)` for a `(w, net)`
  and `save()` is then called
- **THEN** the save SHALL fail with a non-retryable error
- **AND** it SHALL NOT commit a manifest row
- **AND** the failure SHALL occur before the caller is told the save succeeded

#### Scenario: The uniqueness constraint alone would not catch it (negative control)
- **GIVEN** a hypothetical port that adds `UNIQUE (w, net, seq)` but omits the runtime invariant
- **AND** a store pruned down to a single manifest at `seq = 34` with `next_seq = 35`
- **WHEN** `next_seq` is corrupted to `5` and `save()` is called
- **THEN** the claimed `seq = 5` SHALL collide with no surviving row, the insert SHALL succeed, and
  the unique index SHALL raise nothing
- **AND** `load()` SHALL still return `seq = 34` — the store silently frozen at a stale checkpoint
  with the constraint reporting no fault
- **AND** this is why the runtime invariant is mandatory rather than optional

#### Scenario: A partial index would condition integrity on a corruptible predicate (negative control)
- **GIVEN** a hypothetical port that declares the index as partial, `WHERE complete`
- **WHEN** the same corruption that damaged `next_seq` also flips a row's `complete` from true to
  false
- **THEN** that row SHALL silently fall outside the index's coverage
- **AND** the constraint's strength SHALL therefore depend on a byte that
  `openspec/changes/sprint-3-checkpoint-store/design.md` §2.3 itself calls
  "redundant-but-harmless defense-in-depth, not a load-bearing mechanism"
- **AND** the full index SHALL be preferred because the two forms are otherwise exactly equivalent
  today, every manifest row being written with `complete = true`

#### Scenario: The retry path is not broken by the full unique index
- **WHEN** a `save()` fails and is retried
- **THEN** the first attempt SHALL have left neither a manifest row nor a counter increment, both
  being in one transaction, so the retry SHALL NOT collide
- **AND WHEN** a caller retries a `save()` that had actually committed
- **THEN** the retry SHALL allocate a fresh sequence and SHALL NOT collide
- **AND** no abandoned incomplete manifest SHALL exist at a duplicate `(w, net, seq)`, there being
  exactly one `INSERT` into `ckpt_manifests` and no `UPDATE` of `complete` anywhere in `src/`

#### Scenario: The constraint's backing index makes the invariant cheap
- **WHEN** the invariant's `max(seq)` lookup is planned
- **THEN** it SHALL be served by the `(w, net, seq)` unique index as an index-only lookup

### Requirement: the schema text is covered by a digest recorded at migration time

The `STRICT` declarations and named `CHECK` constraints this capability relies on are stored as
ordinary text in `sqlite_schema`, in an unchecksummed region of the same file they protect;
corrupting a `CHECK`'s text leaves `integrity_check` reporting no fault while the weakened
constraint admits values it should reject.

At the end of every successful `runMigrations`, the system SHALL compute a digest over the `sql`
text of every `sqlite_schema` row whose object name carries this schema's prefix, in a deterministic
order, and SHALL record it in the lineage's bookkeeping. The digest SHALL be recomputed at the end
of every successful migration run.

When the digest is verified, what a mismatch raises, and how it relates to application-level value
checksums belong to `v1.0.0-sqlite-durability-contract` and are NOT specified here.

#### Scenario: The digest is recorded and covers only this schema's objects
- **WHEN** the lineage is applied
- **THEN** a digest over the prefixed subset of `sqlite_schema` SHALL be recorded
- **AND** two schema values in one database file SHALL yield two independent digests

#### Scenario: The digest is recomputed when the lineage mutates schema text
- **WHEN** migration `006` runs `ALTER TABLE … ADD COLUMN`, rewriting the stored `sql` of
  `ckpt_chunks`
- **THEN** the recorded digest SHALL reflect the post-migration schema text
- **AND** a digest computed once at table-creation time and never updated SHALL NOT satisfy this
  requirement

#### Scenario: The digest is documented as corruption detection, not tamper protection
- **WHEN** the mechanism is described in any document
- **THEN** it SHALL be stated that the digest lives in the same unprotected file as the schema text
  it covers, so anything able to rewrite a `CHECK` can rewrite the digest
- **AND** it SHALL NOT be described as a security control

#### Scenario: quick_check is never offered as an alternative to integrity_check
- **WHEN** any integrity verification is specified by this capability
- **THEN** `quick_check` SHALL NOT be offered as an alternative to `integrity_check`, since it skips
  the index cross-check and was measured returning no fault across six independent
  index-versus-table divergences that `integrity_check` reported
- **AND** this capability currently specifies no such verification, the obligation resting with
  `v1.0.0-sqlite-durability-contract`

### Requirement: every migration begins with non-idempotent DDL and runs in one transaction

Every migration that issues DDL SHALL begin with a non-idempotent DDL statement — no
`IF NOT EXISTS` on the object it creates — and SHALL run inside exactly one transaction. A
migration that issues no DDL SHALL be explicitly listed in a no-op registry; a migration that
issues nothing and is not in that registry SHALL fail the check.

The purpose is Class C detection: if the `_migrations` bookkeeping is damaged so that an
already-applied migration is re-entered, the first statement SHALL fail loudly rather than silently
re-running.

#### Scenario: Re-entering an applied migration fails loudly
- **WHEN** a migration's `_migrations` row is removed and `runMigrations` is invoked again
- **THEN** that migration SHALL fail on its first statement with an "already exists" error
- **AND** it SHALL NOT silently succeed, and SHALL NOT partially re-apply

#### Scenario: An idempotent first statement would hide the damage (negative control)
- **GIVEN** a hypothetical port that writes `CREATE TABLE IF NOT EXISTS` as a migration's first
  statement
- **WHEN** that migration is re-entered after its bookkeeping row is lost
- **THEN** it SHALL silently succeed, the runner SHALL record it as freshly applied, and the
  database SHALL be indistinguishable from a correctly migrated one
- **AND** any later statement in that migration that is *not* idempotent SHALL then run a second
  time against an already-migrated schema
- **AND** this is the failure mode the law exists to prevent, and is why
  `src/postgres/migrations/000_schema.ts:6-9` already reasons that a redundant `IF NOT EXISTS`
  "would mask a bug in the check rather than defend against anything real"

#### Scenario: A statement-issuing migration is checked, and the single no-op is registered
- **WHEN** the lineage is inspected by the check
- **THEN** every migration issuing DDL SHALL be found to begin with non-idempotent DDL
- **AND** `005_kv_current_fillfactor` SHALL pass only by being present in the no-op registry, its
  exemption being safe because a migration issuing zero statements cannot be partially applied
- **AND** a newly added migration that issues nothing and is absent from that registry SHALL fail

#### Scenario: Each migration is atomic
- **WHEN** a migration issuing several DDL statements fails on a later one
- **THEN** none of that migration's DDL SHALL remain, and its `_migrations` row SHALL be absent
- **AND** the lineage SHALL resume from that migration on the next run

#### Scenario: A partially applied lineage is distinguishable from a complete one
- **WHEN** a migration run fails partway through the lineage
- **THEN** `_migrations` SHALL record exactly the migrations that committed, identifying where the
  lineage stopped
- **AND** the `sqlite_schema` digest SHALL still describe the last successful run, so digest
  mismatch and `_migrations` content SHALL be read together
- **AND** neither signal alone SHALL be treated as identifying which migration is missing

### Requirement: transaction-history reads derive identifiers from entry and cross-check the junction

`entry` and the identifiers junction are two representations of one fact. A digest over `entry`
verifies the document while saying nothing about whether the junction still agrees with it, so
divergence yields a silently wrong answer that no per-value digest detects.

The system SHALL derive the `identifiers` returned by `get()`/`getAll()` from `entry`, NOT from the
junction. On every such read the system SHALL cross-check two things, and SHALL fail with a
non-retryable error on either mismatch:

1. **Lifecycle agreement** — the `lifecycle` column SHALL equal `entry.lifecycle.status`.
2. **Identifier derive-and-compare** — the set derived from `entry.identifiers` SHALL equal, **as a
   set**, the junction rows for that `(wallet_id, tx_hash)`.

The error code belongs to `v1.0.0-sqlite-durability-contract`'s catalog; a new code SHALL NOT be
minted without first checking the existing one.

#### Scenario: A junction row deleted out of band is detected on read
- **WHEN** a junction row is removed without a corresponding change to `entry`
- **AND** `get()` or `getAll()` is called for that entry
- **THEN** the read SHALL fail with a non-retryable error
- **AND** it SHALL NOT return the smaller identifier set as if it were correct

#### Scenario: A junction row added out of band is detected on read
- **WHEN** an extra junction row is inserted that `entry.identifiers` does not contain
- **THEN** the read SHALL fail with a non-retryable error

#### Scenario: A lifecycle column diverging from the entry document is detected
- **WHEN** the `lifecycle` column is changed so it no longer equals `entry.lifecycle.status`
- **THEN** the read SHALL fail with a non-retryable error
- **AND** this SHALL hold even though today's implementation selects the column and takes the
  lifecycle object from the JSON without ever comparing them
  (`src/postgres/transaction-history-storage.ts:244`), so the two can already diverge undetected

#### Scenario: Dropping the cross-check returns a silently wrong answer (negative control)
- **GIVEN** a hypothetical port that reads `identifiers` straight from the junction with no
  comparison against `entry` — the literal port of
  `src/postgres/transaction-history-storage.ts:238`
- **WHEN** the junction is damaged
- **THEN** that port SHALL return the wrong identifier set with no error, and every value digest
  SHALL still pass, because the stored bytes are intact and only the derived index is wrong
- **AND** the wrong set SHALL additionally feed the identifier-subset pending-clear predicate,
  so the damage SHALL propagate into which rows get deleted

#### Scenario: Comparison is by set, not by sequence
- **WHEN** `entry.identifiers` lists the same identifiers in a different order from the junction's
  natural order, or repeats one
- **THEN** the cross-check SHALL pass
- **AND** it SHALL NOT raise on ordering or on a duplicate in `entry`, the junction's primary key
  making duplicates unrepresentable and the semantics being set semantics

### Requirement: wallet-tier digest columns are declared under this capability's conventions

`v1.0.0-sqlite-durability-contract` specifies the digest itself. This capability SHALL add the
storage for it to the wallet-tier tables — `kv_event.value`, `watermarks.value`,
`transaction_history.entry` — in a migration `009_value_digests`. The two archive tables belong to
the chain-archive change.

The column SHALL be `dg BLOB`, **nullable and without a default**, preserving the
"`NULL` means not yet computed" semantics its owner defines. Every object the migration creates
SHALL obey this capability's conventions: the `qualify()` prefix on trigger names, `STRICT`
compatibility, and a named `CHECK`.

#### Scenario: The digest column is added under the schema's own rules
- **WHEN** migration `009_value_digests` is applied
- **THEN** each covered table SHALL gain a nullable `dg BLOB` column with no default
- **AND** each SHALL carry a named constraint of the form
  `CHECK (dg IS NULL OR octet_length(dg) = 32)`, using `octet_length` rather than `length`
- **AND** a wrong-length non-NULL digest SHALL be rejected with the constraint name in the message
- **AND** a `NULL` digest SHALL be accepted

#### Scenario: Drift-guard trigger names carry the schema prefix
- **WHEN** the drift-guard triggers are created
- **THEN** their names SHALL be produced by `qualify()`
- **AND** applying the lineage twice under two `schema` values SHALL succeed, which an unprefixed
  trigger name SHALL NOT, triggers being global per database file

#### Scenario: An update setting dg to NULL on a digested row is aborted
- **WHEN** `UPDATE <table> SET dg = NULL` is issued against a row whose `dg` is currently non-NULL
- **THEN** the anti-downgrade trigger SHALL abort the statement
- **AND** the trigger SHALL use no user-defined function, so it holds on a connection that has
  registered none

#### Scenario: The anti-downgrade trigger does not obstruct recompute or backfill
- **WHEN** a non-NULL digest replaces another non-NULL digest on the same row
- **THEN** the update SHALL succeed
- **AND WHEN** a NULL digest is replaced by a computed value
- **THEN** the update SHALL succeed, backfill only ever writing NULL-to-value

#### Scenario: Without the anti-downgrade trigger one statement silently downgrades a row (negative control)
- **GIVEN** a hypothetical port carrying only the drift-guard trigger, which fires on an update of
  the covered *column* that leaves `dg` unchanged and does not fire on an update of `dg` alone
- **WHEN** `UPDATE <table> SET dg = NULL` is issued
- **THEN** that port SHALL accept it, touching no covered value
- **AND** the row SHALL be permanently downgraded to unverified, defeating the coverage guarantee
  one row at a time

#### Scenario: The column is addable by ALTER TABLE at all
- **WHEN** the column is added to an existing table
- **THEN** it SHALL be nullable with no default, because SQLite rejects
  `ADD COLUMN … NOT NULL` without a default and rejects a non-constant default
- **AND** the migration's first statement SHALL be this `ALTER TABLE`, satisfying the
  migration-lineage law

### Requirement: the forward-only migration framework is preserved with SQLite-native bootstrap detection

The system SHALL keep `docs/CONTRACT.md` §2's forward-only contract intact: `Migration` stays
`up()`-only, there is no `down()`, there is no supported downgrade, and each migration is applied
inside its own transaction. The system SHALL detect bootstrap state with
`SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?)` in place of
`to_regclass` (`src/postgres/migrate.ts:240-242`), and SHALL drop `CREATE SCHEMA`
(`000_schema.ts:13`) and the `search_path` widen/reset pair (`migrate.ts:236,273`), which have no
analogue.

#### Scenario: Bootstrap detection on a cold database returns false rather than erroring
- **WHEN** the bootstrap probe runs against a database file that has never been migrated
- **THEN** it SHALL return false
- **AND** it SHALL NOT raise, preserving the property `migrate.ts:238-239` depends on

#### Scenario: Re-running the lineage applies nothing
- **WHEN** `runMigrations` is invoked twice in succession against the same file and schema
- **THEN** the second invocation SHALL apply no migration and SHALL leave the `_migrations` row set
  unchanged

#### Scenario: A migration that throws leaves no partial DDL
- **WHEN** a migration's `up()` raises after issuing one of several DDL statements
- **THEN** none of that migration's DDL SHALL be present afterwards, and its `_migrations` row SHALL
  be absent
- **AND** this SHALL rely on SQLite's transactional DDL rather than on a compensating cleanup path

#### Scenario: Concurrent migration runs against one file do not interleave
- **WHEN** two processes invoke `runMigrations` against the same database file concurrently
- **THEN** exactly one SHALL apply the lineage and the other SHALL either wait or fail with the
  existing `MIGRATION_LOCK_TIMEOUT` code
- **AND** the exclusion mechanism SHALL be the one specified by
  `v1.0.0-sqlite-concurrency-lease`; no new error code SHALL be introduced for this case
- **AND** this exclusion SHALL be asserted only with its inherited qualifier: cross-process
  exclusion rests on SQLite's file-level write lock, whose locks live in the `-shm` file under WAL,
  so it holds only under that change's source guard plus the documented embedder precondition — an
  in-process descriptor opened and closed on `-shm` drops the POSIX record locks, after which two
  writers may both commit and an acknowledged commit may be silently lost with `integrity_check`
  reporting `ok`

### Requirement: migration 005 is retained as a recorded no-op and its hard invariants are retired with reason

`fillfactor` has no SQLite analogue and no failure mode to prevent: SQLite has no MVCC row
versioning, no heap-only-tuple concept, and no index-bloat-from-non-HOT-update behaviour. The system
SHALL retain migration `005` in the lineage with a no-op `up()` and a header stating why, rather
than removing it, so the lineage's recorded shape and numbering are unchanged.

#### Scenario: The lineage's recorded shape is unchanged
- **WHEN** the lineage is applied
- **THEN** `_migrations` SHALL contain a row named `005_kv_current_fillfactor`
- **AND** that migration SHALL have issued no DDL

#### Scenario: The two never-index invariants are retired, not silently dropped
- **WHEN** the migration headers are read
- **THEN** the hard invariants declared at `003_watermarks.ts:10-12` and
  `005_kv_current_fillfactor.ts:15-17` — "never add an index on this table's non-PK columns" —
  SHALL be recorded as retired, with the reason
- **AND** an index on `watermarks.updated_at` SHALL become permissible
- **AND** the replacement pressure SHALL be named: high-frequency small updates now stress WAL
  growth and checkpointing, which is `v1.0.0-sqlite-engine-core`'s concern

### Requirement: bulk inserts have no row cap derived from the bind-parameter ceiling

`SQLITE_MAX_VARIABLE_NUMBER` is 32,766, and both shipped caps —
`CHUNK_INSERT_MAX_ROWS = 30_000` at 2 parameters per row and `JUNCTION_INSERT_MAX_ROWS = 20_000` at
3 (`src/postgres/checkpoint-store.ts:62-63`) — bind 60,000 parameters and would fail. The system
SHALL **delete** both constants and their sub-batch loops rather than retune them, using
prepared-statement reuse for payload rows and a `json_each`-driven single statement for junction
rows.

#### Scenario: Chunk rows are written by one prepared statement reused inside one transaction
- **WHEN** a checkpoint's chunk rows are written
- **THEN** the system SHALL prepare one `INSERT` and re-execute it per row inside one explicit
  transaction
- **AND** there SHALL be no row-count bound on the loop
- **AND** payload bytes SHALL NOT be routed through JSON or hex encoding

#### Scenario: The manifest-chunk junction is one statement regardless of chunk count
- **WHEN** a manifest's junction rows are written
- **THEN** the system SHALL issue exactly one statement of the form
  `INSERT … SELECT :manifest_id, key, unhex(value) FROM json_each(:hashes)`, binding **two**
  parameters, taking `position` from `json_each.key`
- **AND** this SHALL hold for every chunk count, strengthening the "exactly one statement per
  checkpoint" property that today degrades to more than one for a pathological small `chunkSize`
  (`src/postgres/checkpoint-store.ts:44-52`)

#### Scenario: Retuning the caps to the SQLite ceiling is rejected (negative control)
- **GIVEN** a hypothetical port that retunes the two constants to 16,383 and 10,922 to fit
  `SQLITE_MAX_VARIABLE_NUMBER`
- **THEN** it SHALL be rejected as the only one of the available options that keeps the sub-batch
  machinery alive
- **AND** it SHALL be recorded that it also breaks the "exactly one statement" property that
  `checkpoint-store.ts:36-61`'s comment block exists to defend

#### Scenario: A parameter-bounded multi-row VALUES form fails loudly
- **WHEN** a multi-row `VALUES` statement binding more than 32,766 parameters is executed
- **THEN** SQLite SHALL reject it with `too many SQL variables`
- **AND** this SHALL be the observation that proves the shipped caps could not have been ported
  unchanged

#### Scenario: Array-valued predicates become json_each subqueries
- **WHEN** `= ANY(sql.array(manifestIds))` (`src/postgres/checkpoint-store.ts:442`) is ported
- **THEN** it SHALL become `IN (SELECT value FROM json_each(:ids))`, binding one parameter
- **AND** the aggregate query in `history()` SHALL therefore have no parameter-derived bound on the
  number of manifests it may summarize

#### Scenario: The two parser gotchas are recorded
- **WHEN** an `INSERT … SELECT` gains an `ON CONFLICT` clause
- **THEN** a literal `WHERE true` SHALL precede `ON CONFLICT`, else SQLite raises
  `near "DO": syntax error`
- **AND** `DELETE … LIMIT` SHALL NOT be used, being a syntax error

### Requirement: foreign-key enforcement is a schema precondition that is asserted, not assumed

`ON DELETE CASCADE` (`src/postgres/migrations/002_checkpoint_store.ts:58`) is load-bearing for
garbage collection, and SQLite's `PRAGMA foreign_keys` defaults **off**. The system SHALL verify
that `PRAGMA foreign_keys` reports 1 before applying any migration and SHALL refuse to proceed
otherwise.

#### Scenario: Migration refuses to run without foreign-key enforcement
- **WHEN** `runMigrations` is invoked on a connection where `PRAGMA foreign_keys` reports 0
- **THEN** it SHALL fail before issuing any DDL, with a message naming the pragma

#### Scenario: Cascade removes junction rows in the same statement as the manifest delete
- **WHEN** a `ckpt_manifests` row is deleted
- **THEN** its `ckpt_manifest_chunks` rows SHALL be gone in the same statement, making them
  invisible to the chunk-reclaim `NOT EXISTS` check in the same GC pass

#### Scenario: With foreign keys off, prune leaks silently and forever (negative control)
- **GIVEN** a hypothetical deployment where `PRAGMA foreign_keys` is 0 because a different driver
  was selected and the pragma was assumed rather than asserted
- **WHEN** `prune()` runs
- **THEN** step 1's manifest delete SHALL leave orphan junction rows, step 2's `NOT EXISTS` SHALL
  see a live reference for every chunk, and **no chunk SHALL ever be reclaimed again**
- **AND** no error SHALL be raised, so the failure presents as unbounded disk growth rather than as
  a fault — which is why the assertion above is required rather than the pragma being trusted

### Requirement: every performance-dependent property is stated as an obligation to measure, not as a number

WHERE a requirement in this capability depends on a performance property, the system SHALL state
the measurement conditions — filesystem, `journal_mode`, `synchronous`, dataset size relative to
page cache — and SHALL reference `v1.0.0-sqlite-engine-core`'s blocking ext4 measurement gate. No
throughput or latency figure from the research corpus SHALL be published as fact.

#### Scenario: A research number is not carried into a document
- **WHEN** any document produced by this change quotes a throughput or latency figure
- **THEN** that figure SHALL be traceable to a measurement taken on ext4 under the stated
  conditions
- **AND** figures taken on the research host's `/tmp` — a 32 GB tmpfs RAM disk — SHALL NOT appear,
  the calibrating example being WAL `synchronous=FULL` at a published 88,485 commits/s versus 379
  re-measured on ext4, a 233× error

#### Scenario: Structural claims are separated from timing claims
- **WHEN** a claim about SQLite's behaviour is made
- **THEN** claims about what SQLite accepts or rejects, what a query plan resolves to, and whether a
  constraint fires SHALL be carried as facts with the measuring source named
- **AND** claims about how fast an operation is SHALL be carried as obligations
