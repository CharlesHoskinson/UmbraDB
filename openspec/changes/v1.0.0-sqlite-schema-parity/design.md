# Design — SQLite schema parity

Change id `v1.0.0-sqlite-schema-parity`, capability `storage-schema`. This document states the data
model, the constraint set, the index set, and the forward-only migration framework for UmbraDB on
SQLite, and rules on the two contested items the research left open.

**Citation discipline.** `openspec/config.yaml`'s design rule is binding: every existing decision
this touches is cited by section number in `design/design.md`, `design/design-interfaces.md` or
`Formal/STORAGE_ALGEBRA.md`, and every code claim carries `file:line` against the worktree
(`/root/UDB-sqlite-sprint`, branch `sprint/sqlite-migration`).

**Measurement discipline.** Six of seven research lanes benchmarked against `/tmp`, a 32 GB tmpfs
RAM disk on the research host. Re-measured on ext4, WAL `synchronous=FULL` went from a published
88,485 commits/s to **379** — a 233× error. **No throughput or latency number appears in this
design as a fact.** Where a decision depends on a performance property, this document states the
*direction*, the corroboration for that direction, and the experiment that must establish the
number under change 1's ext4 gate. Structural claims — what SQLite accepts, what a query plan
resolves to, whether a constraint fires — are filesystem-independent and are carried as facts, with
the measuring lane named.

---

## 0. Dependencies, and where this change stops

| Depends on | For | Stated, not specified here |
|---|---|---|
| **Change 1** `v1.0.0-sqlite-engine-core` | Driver selection; the `postgres.js`-shaped shim; pragma bootstrap incl. `PRAGMA foreign_keys=ON`; **the blocking ext4 measurement gate** | The shim MUST decode rows from `columns()` **origin** metadata (`{database, table, column, name, type}`), not declared type names — see §2.3. The `(table, column) → decoder` registry is derived mechanically from the DDL in §12 and handed to change 1. |
| **Change 2** `v1.0.0-sqlite-temporal-event-log` | The TemporalKV table shapes (`kv_current`/`kv_history` → an event log), `written_at`'s type and clock policy, T3/T5 enforcement | Change 2's DDL MUST be written through §1's naming layer, including its trigger names, and MUST be `STRICT` per §2. Nothing else about those tables is this change's. |
| **Change 3** `v1.0.0-sqlite-concurrency-lease` | `BEGIN IMMEDIATE`; the writer-exclusion mechanism replacing `pg_advisory_lock`; the writer-generation guard's **read/write protocol** and generation-bump semantics; contention error mapping | §9.2's migration-lock bullet and §4.4 (the write path's serialization, replacing `pg_advisory_xact_lock` + `SELECT ... FOR UPDATE`) both consume change 3's mechanism and neither specifies it. **Boundary split, per change 3's dependency row D-4** (`v1.0.0-sqlite-concurrency-lease` design, dependency table, row **D-4**): **this change owns the `writer_generation` table's DDL, its seed row and its lineage position** (§9.4, §12.1); change 3 owns everything the table *does*, under its design heading **"Cross-process: the writer-generation guard"** -> **"The protocol"**. |
| **Change 5** `v1.0.0-sqlite-durability-contract` | The error catalog; `docs/CONTRACT.md` rewrites; backup/restore; the page-checksum gap; observability | §3.4's requirement that every `CHECK` be **named** exists so change 5's translation has a `constraint_name` analogue. The catalog decision is change 5's. |

**Out of scope and named as such:** the chain-archive lineage (see `proposal.md` non-goals); any
PostgreSQL→SQLite data migration; encryption at rest; page checksums; `page_size`/`auto_vacuum`
selection (irreversible, change 1's).

---

## 1. Schema emulation — table-name prefixing, and the two names everyone forgets

### 1.1 What exists today

`000_schema.ts:13` issues `CREATE SCHEMA IF NOT EXISTS ${sql(schema)}` and `:15-19` creates
`${schema}._migrations`. Every subsequent migration qualifies every object through `sql(schema)`.
`client.ts:14` exports `DEFAULT_SCHEMA = "umbradb"`; `client.ts:148` reads
`opts.schema ?? DEFAULT_SCHEMA`; `src/index.ts:40` re-exports `DEFAULT_SCHEMA` as **frozen G1
surface**. `migrate.ts:236` widens `search_path` and `:273` resets it. `design/design.md` §2 is
where the schema-qualified-identifier decision was originally taken (after a 2026-07-20 audit found
the schema-configurability contradiction in the earlier static-`.sql`-file design — recorded in
`001_temporal_kv.ts:3-7`).

### 1.2 What SQLite offers

Only `main`, `temp`, and `ATTACH`ed aliases, which are separate **files**. L4 measured
`SET search_path = umbradb` as `near "SET": syntax error`.

### 1.3 The ruling — table-name prefixing, and it is not a G1 break

**Every object name in every UmbraDB lineage is `<schema>_<object>`.** `<schema>` is the same
string the `schema` constructor parameter carries today, defaulting to `DEFAULT_SCHEMA`.

This preserves, byte-for-byte: the exported symbol `DEFAULT_SCHEMA`, its type (`string`), its value
(`"umbradb"`), every adapter's `schema` constructor parameter and its default. A caller already
passing `schema: "tenant_a"` continues to compile, continues to run, and continues to get its own
separate set of tables. **This is a capability change disclosed in the CHANGELOG, not a signature
change, and it does not force a major version.** Lane L4 pushes back explicitly on any conclusion
that it does, and the commitments seat records the same finding (`council/commitments.md:101`:
*"survives byte-for-byte under L4's table-prefix option (a); only the documented meaning narrows"*).
What narrows is documented meaning: the parameter **names**, it no longer **isolates**. Two schemas
in one file share one writer lock and one WAL, and there is no `DROP SCHEMA`-style teardown.

### 1.4 The non-obvious catch — index and trigger names are global per database file

Measured by L4 (`reports/l4-typesystem.md` §3.5): creating an index named `dup_name` on two
different tables in one file fails with `index dup_name already exists`; the same holds for
triggers (`trigger tn already exists`). Under Postgres these are **schema-scoped** and two schemas
coexist. Under SQLite prefixing they collide, and the collision only appears when a second `schema`
value is used — i.e. never in a single-tenant test suite, and immediately in the multi-tenant case
the parameter exists to serve.

Today's unprefixed index names, which would collide: `kv_history_lookup`
(`001_temporal_kv.ts:104`), `kv_history_by_version` (`:110`), `ckpt_manifests_lookup`
(`002_checkpoint_store.ts:40-41`), `ckpt_manifest_chunks_by_hash` (`:66-67`),
`transaction_history_identifiers_gin` (`004_transaction_history.ts:40-41`). Today's unprefixed
trigger name: `kv_current_history_bu` (`001_temporal_kv.ts:135`).

**The rule, stated so a builder cannot get the trigger/index case wrong:**

> A SQLite database file has exactly **three** name spaces that UmbraDB writes into: tables (which
> includes views and virtual tables), indexes, and triggers. All three are **file-global**. Every
> name UmbraDB creates in any of the three SHALL be produced by one function,
> `qualify(schema, name) → \`${schema}_${name}\``, and no DDL statement SHALL contain a literal
> object name for an object it creates. Column names are **not** in a file-global namespace and
> SHALL NOT be prefixed.

The mechanical test that makes this falsifiable without enumerating names: run the whole lineage
twice against one file with two different `schema` values, and assert both succeed. A single
unprefixed index or trigger anywhere fails the second run. A second, static test asserts that every
`CREATE TABLE|INDEX|TRIGGER|VIEW` statement the lineage emits has its object name starting with the
schema prefix — this catches the case where a name happens not to collide today but would once a
sibling migration is added.

### 1.5 Why not one file per schema (`ATTACH`)

Rejected, on two measured grounds:

- **Foreign keys cannot cross attached files.** L4 measured `cross-ATTACH foreign key -> near ".":
  syntax error`. UmbraDB has intra-lineage foreign keys today — `ckpt_manifest_chunks.manifest_id →
  ckpt_manifests(id) ON DELETE CASCADE` and `chunk_hash → ckpt_chunks(hash)`
  (`002_checkpoint_store.ts:58,60`) — and this change adds a composite one (§4.2). A per-schema file
  therefore cannot be a general schema mechanism.
- **`SQLITE_MAX_ATTACHED = 10`** (L4, from `pragma compile_options`), so at most 10 attached
  databases plus `main`. A `schema` parameter that silently caps at 11 tenants is not the parameter
  UmbraDB exports.

Note a genuine seat disagreement here, ruled rather than hidden. The contradiction seat
(`council/contradiction.md`, C18) recommends **file-per-lineage, prefix-within-file for
multi-tenant `schema` values**, observing that L4's FK objection does not apply *across lineages*
because every FK in the repo is intra-lineage. That recommendation is compatible with this design
and is not overruled: it is a *file-layout* decision (how many database files the product opens),
which belongs to change 1's connection/handle lifecycle, not to the naming layer. This change
specifies the within-file mechanism, which is required under either layout, and states that the
naming layer SHALL NOT assume a single file.

### 1.6 What is deleted, and one bound that is kept

`assertNoConflictingSearchPath` (`client.ts:113-135`, an entire audit-driven DSN hazard) and the
`set search_path` / `reset search_path` pair (`migrate.ts:236,273`) have nothing left to guard and
are deleted. `assertValidSchemaName` (`client.ts:24-33`) is **kept in full**, including the
63-byte bound: the `^[a-z_][a-z0-9_]*$` pattern is now load-bearing in a new way (the schema string
is concatenated into DDL object names, so a malformed value produces malformed DDL rather than a
confusing Postgres error), and SQLite has no `NAMEDATALEN` analogue, which means the 63-byte bound
is no longer an engine limit but a **library-imposed conservative bound**. Keeping it is free, keeps
every Postgres-era configuration valid, and removing it would be a silent widening of accepted
input. `design.md` §2's safe-identifier-interpolation decision is preserved in substance; only its
mechanism (`sql(schema)` quoting) is replaced by string concatenation over a validated pattern.

---

## 2. `STRICT` tables — the enhancement mandate

### 2.1 Why this is a correctness requirement, not hygiene

Postgres enforced column types for free. SQLite does not: L4 measured a non-`STRICT` `INTEGER`
column accepting the string `"notanint"` and storing it with `typeof(a) = 'text'`
(`reports/l4-typesystem.md` §3.1). A naive port therefore **loses a guarantee the current design
depends on without ever naming it**.

The contradiction seat found the case that makes this decisive (`council/contradiction.md` §2.3(b),
measured): if a `Date` is normalized to ISO-8601 **text** and bound into an integer timestamp
column, then because *every* `INTEGER` sorts before *every* `TEXT` in SQLite's type ordering,
`WHERE written_at <= :T ORDER BY written_at DESC LIMIT 1` matches the wrong row and `getAt(at)`
returns the **latest** version for every `at`, always, with no error. That is **Law T3**
(`Formal/STORAGE_ALGEBRA.md` §1, temporal projection / observational equivalence) silently false —
a mechanized cut-line law, broken by a storage detail with no exception thrown anywhere. `STRICT`
converts it to `cannot store TEXT value in INTEGER column` at the binding site.

**Ruling: every table UmbraDB creates is `STRICT`.** This is a guarantee UmbraDB did not previously
have to state and now states.

### 2.2 The declared-type vocabulary and the resulting map

`STRICT` admits exactly `INT`, `INTEGER`, `REAL`, `TEXT`, `BLOB`, `ANY` (L4 measured
`unknown datatype for t9.a: "jsonb"`). The mapping, which is complete for the tier-1 lineage:

| Postgres | SQLite | Rationale |
|---|---|---|
| `text` | `TEXT` | — |
| `jsonb` | `TEXT` | Store the `JSON.stringify` output verbatim; **never** call `json()`/`jsonb()` on the write path. See §2.4. |
| `bytea` | `BLOB` | Bound as a native `Buffer`; no text serialization step. |
| `timestamptz` | `INTEGER` (epoch **milliseconds**) | Adopted per the contradiction seat's C3 ruling. Millisecond, not microsecond, granularity is already what the code assumes — `001_temporal_kv.ts:79` truncates `clock_timestamp()` to milliseconds precisely because a JS `Date` carries only milliseconds (`:60-71`). |
| `boolean` | `INTEGER` + `CHECK (x IN (0,1))` | `STRICT` has no boolean type; without the `CHECK` the column's domain is all integers. |
| `bigint` | `INTEGER` | 64-bit, matching. |
| `bigserial` / `GENERATED ALWAYS AS IDENTITY` | `INTEGER PRIMARY KEY AUTOINCREMENT` | See §7.3 — a bare rowid alias **reuses** the id of a deleted maximum row (L4 measured 1,2,3 → delete 3 → next insert is 3), and `prune()` deletes `ckpt_manifests` rows (`checkpoint-store.ts:511-522`), so reuse is reachable. |
| `text[]` | *(removed — junction table, §4)* | |
| `tstzrange` + `EXCLUDE USING gist` | *(change 2's — event-log encoding)* | |

### 2.3 The interaction with change 1 — state the dependency, do not specify it

`STRICT` and a decoder keyed on **declared type names** are mutually exclusive. L4 measured
(`reports/l4-typesystem.md` §B10) that a non-`STRICT` table returns
`[{"n":"a","t":"JSONB"},{"n":"b","t":"BYTEA"},{"n":"c","t":"TIMESTAMPTZ"}]` from
`StatementSync.columns()` — the mechanism a Postgres-shaped shim would naturally use — while a
`STRICT` table rejects those names outright and collapses `jsonb`/`text` into `TEXT` and
`timestamptz`/`bigint` into `INTEGER`, losing exactly the two distinctions a decoder needs.

**The resolution is change 1's to implement and this change's to depend on:** the shim keys its
decoder on `columns()`'s **origin** metadata (`{database, table, column, ...}`), which L4 measured
surviving aliasing and the contradiction seat re-measured surviving JOIN, `FROM (subquery)`, CTE,
`UNION ALL` and a VIEW. This change's deliverable to change 1 is the static
`(table, column) → decoder` registry derived from §12's DDL.

**One hole, recorded because it is silent if missed** (contradiction seat §2.3(a)): a column
produced by an expression — a window function, an aggregate — has `table: null` and `column: null`
and falls through the registry. That is harmless for aggregates over plain numbers, and **not**
harmless for a derived temporal column in a view: `valid_from` resolving to a real column decodes to
a `Date` while `valid_to` produced by `LEAD()` falls through as a `bigint`, in the same row. The
registry therefore needs explicit `(view, column)` entries, or derived temporal columns must be
aliased to their origin column. The view in question is change 2's; the **registry rule** is this
change's and is specified in §12.2.

### 2.4 JSON as `TEXT`, and the guard that must not be relaxed

Verified by grep against `src/`, not assumed: the only place UmbraDB reads *inside* a JSON document
is `chain-archive-store.ts:534-536` — the deferred archive. Everything else is whole-document:
`watermarks.ts` writes `sql.json(value)` and selects `value` entire;
`transaction-history-storage.ts:499` writes `sql.json(encodeStoredEntry(result))` and `decodeRow`
parses the whole thing back; `004_transaction_history.ts:8-15` says outright that
`identifiers`/`lifecycle` were denormalized **out** of the JSONB specifically to avoid a JSONB path
scan. So a plain `TEXT` column storing the `JSON.stringify` output is sufficient, and L4 measured it
round-tripping byte-identically for every shape it tested (large integers, unicode, key order,
duplicate keys, depth 64) — which is *higher* fidelity than `jsonb`, a normalizing format that
reorders keys and drops duplicates.

`hasPostgresUnsafeText` (`src/interfaces/temporal-kv.ts:35-37`) rejects NUL bytes and unpaired
UTF-16 surrogates because Postgres cannot store them. **It is kept, and its rationale is
strengthened, because SQLite's behaviour is worse:** L4 measured a NUL round-tripping intact through
the driver while `length(v)` returns **1** for a 3-character string (every SQL-side string function
truncates at the first NUL), and a lone surrogate coming back as U+FFFD (`equal_to_input: false`) —
silent corruption in place of Postgres's loud rejection. The function is not exported from
`src/index.ts`, so an internal rename plus a corrected doc string is free under G1.

---

## 3. `CHECK` constraints — recovering domains, and gaining two

`STRICT` gives *class* (is it an integer, a string, a blob). `CHECK` gives *domain* (which
integers, which strings, how many bytes). L4 measured every constraint form in the repo
transferring verbatim: `CHECK (octet_length(hash)=32)`, the enum-style `CHECK (x IN (...))`, the
multi-column biconditional `CHECK ((scope='contract') = (contract_address IS NOT NULL))`, and
`CHECK (NOT finalized OR is_canonical)`.

Three that this change **adds**, i.e. guarantees UmbraDB did not previously have:

1. `octet_length(hash) = 32` on `ckpt_chunks.hash` and `ckpt_manifests.manifest_hash`. Postgres
   `bytea` enforced no length; a truncated content address was storable.
2. `complete IN (0,1)` on `ckpt_manifests.complete`, recovering what `boolean` gave for free.
3. `lifecycle IN ('pending','finalized','rejected')` on `transaction_history.lifecycle`.
   `004_transaction_history.ts:30` declares it as bare `text`; the discriminant's domain lived only
   in the TypeScript type.

**`octet_length`, never `length`.** L4 measured and the contradiction seat's C15 confirms:
`length()` on a BLOB is bytes, on TEXT it is *characters* (`héllo` is 5 characters, 6 bytes).
`octet_length()` (SQLite 3.43+) is bytes for both, and is literally the same identifier as the
Postgres original, so the migration diff stays readable. L5's draft DDL shipped `length(data)`;
adopt `octet_length` everywhere.

**Every `CHECK` is named.** L4 measured that a named `CONSTRAINT <name> CHECK (...)` puts the name
into the error message (`CHECK constraint failed: kv_history_range`), which is the direct
replacement for the `constraint_name` field `src/postgres/errors.ts` keys on. Anonymous `CHECK`s
produce a message with an expression in it, which is not a stable translation key. Constraint names
live in the **table's** namespace, not a file-global one, so they are not prefixed — but they SHALL
be unique within the lineage anyway, so that a translated error identifies one constraint.

---

## 4. The identifiers junction table, and the containment direction

### 4.1 The semantics, stated so the wrong direction is visibly wrong

`transaction-history-storage.ts:518-523` is the rule, and `docs/SCHEMA.md:342-347,386-390` states
its intent. Written out:

> **Delete a pending row iff its identifier set is (a) non-empty and (b) a subset of the finalizing
> entry's identifier set.**
> Formally, for pending row `r` and finalizing set `S`: `r.identifiers ≠ ∅ ∧ r.identifiers ⊆ S`.
> Postgres spells `⊆` as `<@` ("contained by"), with **set** semantics: duplicates and order in the
> row's array are ignored.

The inverse, `@>` ("contains", `S ⊆ r.identifiers`), is a **different predicate returning a
different set of rows**, and swapping them deletes rows that must survive while sparing rows that
must go. L4 ran both directions over one fixture (`reports/l4-typesystem.md` §3.3) with
`S = {a, b}` and rows `empty:[]`, `subset:[a]`, `equal:[a,b]`, `superset:[a,b,c]`, `disjoint:[z]`,
`overlap:[b,z]`, `dup-in-row:[a,a]`:

| Direction | Rows selected |
|---|---|
| `r ⊆ S`, non-empty (**correct**) | `subset`, `equal`, `dup-in-row` |
| `S ⊆ r` (**wrong**) | `equal`, `superset` |

They agree on exactly one row out of seven. `superset` is the diagnostic case: it must **survive**
and the inverted predicate deletes it. `dup-in-row` is the set-semantics case: it must be
**cleared**, and any implementation that treats the row's identifiers as a multiset misses it. Both
appear as scenarios in the spec, and both directions are written out so that an implementation with
the comparison inverted fails a named scenario rather than passing a one-sided suite.

The non-empty guard is not decoration: an empty set is vacuously a subset of everything, so without
it the first finalize with zero identifiers clears every unrelated pending entry in the wallet.
`transaction-history-storage.ts:513-517` and `docs/SCHEMA.md:388-390` both record this.

### 4.2 The shape

```sql
CREATE TABLE <s>_transaction_history_identifiers (
  wallet_id  TEXT NOT NULL,
  tx_hash    TEXT NOT NULL,
  identifier TEXT NOT NULL,
  PRIMARY KEY (wallet_id, tx_hash, identifier),
  FOREIGN KEY (wallet_id, tx_hash)
    REFERENCES <s>_transaction_history(wallet_id, tx_hash) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX <s>_th_ident_reverse
  ON <s>_transaction_history_identifiers (wallet_id, identifier, tx_hash);
```

The `PRIMARY KEY` gives set semantics *structurally* — a duplicate identifier in the caller's array
cannot produce a duplicate row — which is what makes the `dup-in-row` case work without any
application-side dedup. `ON DELETE CASCADE` is what keeps the junction consistent when the
pending-clear `DELETE` removes a parent row, and it is **inert unless `PRAGMA foreign_keys=ON`** —
see §8.

### 4.3 The query, and why it is two-phase

A row can be a subset of `S` only if it shares **at least one** element with `S`. So generate
candidates from the reverse index via `identifier IN S`, then apply the universal filter to the
(small) candidate set — the same two-phase shape GIN uses internally:

```sql
DELETE FROM <s>_transaction_history
WHERE wallet_id = :w AND tx_hash <> :h AND lifecycle = 'pending'
  AND tx_hash IN (
      SELECT i.tx_hash FROM json_each(:ids) s
      JOIN <s>_transaction_history_identifiers i
        ON i.wallet_id = :w AND i.identifier = s.value)
  AND NOT EXISTS (
      SELECT 1 FROM <s>_transaction_history_identifiers i
      WHERE i.wallet_id = :w
        AND i.tx_hash = <s>_transaction_history.tx_hash
        AND i.identifier NOT IN (SELECT value FROM json_each(:ids)));
```

The `array_length(identifiers,1) > 0` non-empty guard is **subsumed**, not dropped: a row with zero
junction rows cannot appear in the candidate `IN` list. L4 verified this end-to-end (the `p4` row
with empty identifiers survives). The spec still states non-emptiness as a requirement, because the
subsumption is a property of *this* query shape and a future rewrite must preserve it.

### 4.4 The write path

`transaction-history-storage.ts:494-507`'s single
`INSERT ... ON CONFLICT ... DO UPDATE SET ... identifiers = EXCLUDED.identifiers` becomes **three
statements in one transaction**: upsert the entry; `DELETE` the junction rows for
`(wallet_id, tx_hash)`; re-insert them from `json_each`. Delete-then-reinsert (not merge) is what
makes a *shrinking* identifier set correct — L4 exercised exactly that case.

`pg_advisory_xact_lock(4, hashtext(walletId || ':' || hash))` (`:458`) and `SELECT ... FOR UPDATE`
(`:465`) both disappear. `FOR UPDATE` is a syntax error in SQLite (L4 measured), and the advisory
lock existed precisely because `FOR UPDATE` cannot lock a not-yet-existing row
(`transaction-history-storage.ts:440-452`). Both are subsumed by whole-database writer exclusion,
which is **change 3's mechanism** — this design consumes it and does not specify it. The property
that must survive is the one `design.md` §3 and `openspec/changes/sprint-7-transaction-history-storage/specs/.../spec.md`
state: two concurrent merges on the same `(walletId, txHash)` must not lose a section.

### 4.5 Performance — what is claimed and what is not

L4 measured the index-driven form at 0.02 ms against 200,000 tx / 500,000 identifier rows, versus
93 ms naive and 69 ms via a `json_each` column on a JSON array. **Those numbers were taken on
tmpfs and are not carried here.** What *is* carried:

- **The structural claim, filesystem-independent:** `EXPLAIN QUERY PLAN` for the candidate subquery
  resolves to `SEARCH i USING COVERING INDEX <s>_th_ident_reverse (wallet_id=? AND identifier=?)`,
  and the naive form resolves to `SEARCH t USING PRIMARY KEY (wallet_id=?)` — a whole-wallet scan.
  This is an assertable property of the plan and is specified as one.
- **FTS5 is rejected on semantics, not on speed.** `ENABLE_FTS5` is compiled in (L4, from
  `pragma compile_options`), but FTS5 is a token-match index: it answers "which rows contain this
  token", i.e. the `@>` direction. Subset is a *universal* over the row's own tokens, which no
  inverted index answers directly; using FTS5 would mean generate-candidates-then-verify — which is
  what the junction table already does, with a tokenizer's escaping hazards added.
- **The latency number is an obligation, not a claim.** It must be established on ext4 under change
  1's gate, at a stated dataset size relative to page cache, before any doc or contract quotes one.

### 4.6 Parameters — the junction does **not** multiply them

`INSERT INTO ... SELECT :w, :h, value FROM json_each(:ids)` binds **three** parameters regardless of
how many identifiers the entry carries (L4 measured 50,000 rows through one statement with one JSON
parameter). So `SQLITE_MAX_VARIABLE_NUMBER = 32766` does not constrain this design at all. It does
constrain two *existing* loops — see §6.

---

## 5. `UNIQUE NULLS NOT DISTINCT` — the silent regression a prior audit already caught

### 5.1 The bug, in the repo's own words

`chain_archive/001_chain_archive_core.ts:63-70` records the v4 audit finding verbatim:

> `verifier_key_observations`'s `UNIQUE NULLS NOT DISTINCT` key gained `tag` (closing a real
> data-loss bug: two legitimate different-entry-point observations of the same VK collided and one
> was lost) …

and `:516-529` records *why the `NULLS NOT DISTINCT` modifier itself is load-bearing*, empirically
confirmed against a real Postgres 17:

> two *different* protocol-scoped observations of the same key (different `net`, both
> `contract_address IS NULL`) are correctly accepted as distinct rows, while an exact duplicate
> context (same vk_hash/net/scope/contract_address/first_seen_height, both NULL `contract_address`)
> is correctly rejected — **ordinary `UNIQUE` treats every NULL as distinct from every other NULL
> and would NOT have caught that duplicate**.

The constraint is `UNIQUE NULLS NOT DISTINCT (vk_hash, net, scope, contract_address, tag)`
(`:570`), on a table where `contract_address` is legitimately NULL for protocol-scoped rows and
cannot be part of a `PRIMARY KEY` for that reason (`:516-519`).

### 5.2 SQLite has no equivalent, and the naive port is the bug

L4 measured both halves (`reports/l4-typesystem.md` §3.1): SQLite's `UNIQUE` matches Postgres's
**default** (NULLs distinct), and a unique index over a `coalesce`-of-the-nullable-column expression
correctly rejects the duplicate. So a transliteration that writes plain `UNIQUE (...)` compiles,
passes every non-NULL test, and **silently reintroduces the exact defect the v4 audit closed**.

### 5.3 The fix, and the hole in the naive form of the fix

```sql
CREATE UNIQUE INDEX <s>_verifier_key_observations_identity
  ON <s>_verifier_key_observations (
    vk_hash, net, scope, coalesce(contract_address, x''), tag
  );
```

`x''` (the zero-length BLOB) is the sentinel, chosen because `contract_address` is a `bytea`/`BLOB`
and a real Midnight contract address is never zero-length.

**"Never zero-length" is an assumption, and an assumption is exactly how a sentinel scheme fails.**
If a zero-length address were ever storable, it would collide with the NULL sentinel and the
constraint would reject a legitimate distinct row — a *new* bug traded for the old one. So the
sentinel must be excluded from the column's real domain **by construction**, not by belief:

```sql
CHECK (contract_address IS NULL OR octet_length(contract_address) > 0)
```

This `CHECK` is part of the fix, not an optional extra, and the spec states it as such. The general
rule it instantiates is in §5.4.

### 5.4 The general translation rule (binding now, applied when the lineage is ported)

The chain archive is **owned by `v1.0.0-sqlite-chain-archive` (change 6), not by this change**
(`proposal.md` non-goals), and **no archive DDL is ported here**. But the rule is recorded because
the instance that motivates it is the one the repo already paid for:

> **Any uniqueness constraint whose key includes a nullable column SHALL be emulated as a
> `CREATE UNIQUE INDEX` over `coalesce(col, <sentinel>)`, and the sentinel SHALL be excluded from
> that column's real domain by a `CHECK` in the same migration. A plain `UNIQUE (...)` over a
> nullable key column SHALL NOT appear in any UmbraDB lineage.**

The tier-1 lineage has no such constraint today, so this rule has no tier-1 instance to apply to —
which is precisely why it would be lost if it were not written down now. It is enforced by a static
check over the emitted DDL (§10, task 8.3), not only by a test of a table that does not yet exist.

---

## 6. Bulk inserts — delete the caps, do not retune them

### 6.1 The ceiling

`SQLITE_MAX_VARIABLE_NUMBER = 32766`, measured independently by L4 (from `pragma compile_options`,
confirmed by a 40,000-parameter statement failing with `too many SQL variables`) and L5 (16,383
two-parameter rows accepted, 16,384 rejected). `checkpoint-store.ts:62-63`'s
`CHUNK_INSERT_MAX_ROWS = 30_000` (2 params/row) and `JUNCTION_INSERT_MAX_ROWS = 20_000` (3
params/row) each bind **60,000** parameters. Both would fail as written.

### 6.2 The ruling — delete, per L5; do not retune, per the contradiction seat

Three options existed. **Retuning to 16,383 / 10,922 is rejected**: the contradiction seat (C13)
records it as *"the only one of the three answers that keeps the sub-batch machinery alive"*, and it
also breaks the "EXACTLY ONE statement per checkpoint" property the comment block at
`checkpoint-store.ts:36-61` defends. The adopted shapes:

| Insert | Shape | Bind parameters |
|---|---|---|
| `ckpt_chunks` (4 MiB BLOB payloads) | **prepared statement re-`run()` in a loop inside one explicit transaction** | 2 per `run()`, no cap on the loop |
| `ckpt_manifest_chunks` junction | `INSERT ... SELECT :mid, key, unhex(value) FROM json_each(:hashes)` | **2**, independent of chunk count |
| `transaction_history_identifiers` junction | `INSERT ... SELECT :w, :h, value FROM json_each(:ids)` | **3**, independent of identifier count |

The `ckpt_manifest_chunks` recipe is the contradiction seat's (§3.J, measured), not L4's: **L4
answered about the wrong junction.** L4's "3 parameters regardless" is about the
*transaction-history identifiers* junction; `JUNCTION_INSERT_MAX_ROWS` is
`ckpt_manifest_chunks (manifest_id, position, chunk_hash BLOB)`
(`checkpoint-store.ts:59-61`). The seat's form takes `position` from `json_each.key` (the array
index) and restores the 32-byte BLOB with `unhex()` — 2 parameters. This design adopts the seat's
form and records the correction so nobody re-derives L4's answer for a table it did not describe.

**Do not route 4 MiB blobs through JSON.** L5 measured the `json_each` hex round-trip materially
slower than prepared reuse for large payloads; the tmpfs caveat applies to the *magnitude*, but the
mechanism (hex-encode every byte into a JSON string, parse it back) is a real serialization step
that prepared binding does not have, so the direction stands independent of the filesystem.

### 6.3 What this deletes, and what it strengthens

Deleted: both constants, both sub-batch loops (`checkpoint-store.ts:229-235` and `:275-280`), and
the 27-line comment block at `:36-61` documenting postgres.js's V8 `MAX_STRING_LENGTH` hazard —
which disappears entirely, because a `Buffer` binds as a native BLOB with no text serialization
step.

**The "EXACTLY ONE statement" property is strengthened, not lost.** Today it holds "for every
in-model checkpoint" and degrades to >1 statement for a pathological sub-64-KiB `chunkSize`
(`checkpoint-store.ts:44-52`). Under the `json_each` junction form it is **exactly one statement for
every N**, unconditionally. The chunk-blob path becomes N `run()` calls on one prepared statement
inside one transaction — which is a different property (one *statement object*, one transaction,
N executions) and the spec states it that way rather than pretending it is the same one.

### 6.4 Two parser gotchas, recorded so they are not rediscovered

- `INSERT ... SELECT ... ON CONFLICT` requires a literal **`WHERE true`** before `ON CONFLICT`, else
  `near "DO": syntax error` (L5, measured). This bites the junction inserts if they ever gain an
  `ON CONFLICT` clause.
- **`DELETE ... LIMIT` is a syntax error** (L5, measured). Any chunked-delete remediation must be
  written `DELETE ... WHERE rowid IN (SELECT rowid ... LIMIT n)` — and note that shape is
  unavailable on a `WITHOUT ROWID` table, which §7 makes several of these.

`= ANY(sql.array(manifestIds))` (`checkpoint-store.ts:442`) becomes
`IN (SELECT value FROM json_each(:ids))` — one parameter, so the aggregate query in `history()` also
stops being parameter-bounded.

---

## 7. Contested ruling (a) — `WITHOUT ROWID` is **not** used for the content-addressed tables

### 7.1 The obvious answer, and why it is wrong

The research brief called the 32-byte-hash-primary-key content-addressed tables
(`ckpt_chunks`, and the archive's `chain_blobs`) "obvious candidates" for `WITHOUT ROWID`. They are
not.

**Two lanes measured a regression independently, in the same direction:**

- **L4** (`reports/l4-typesystem.md` §3.6), 20,000 rows per configuration with WAL and a
  `wal_checkpoint(TRUNCATE)` before sizing: `WITHOUT ROWID` was **2.0× slower on point reads at
  4 KiB** rows, **3.8× slower at 64 KiB**, and **2.0× slower at the 4 MiB production default**
  (`checkpoint-store.ts:33`), with no space saving. It won only at **64-byte** rows.
- **L5** (`reports/l5-archive.md` §3.3, run O), 200,000 rows at ~11 KB mean payload: a **3.3×
  regression** on ingest, plus worse write amplification (1.155 vs 1.078).

The mechanism explains the direction and is not a measurement: in a `WITHOUT ROWID` table the
primary-key b-tree **is** the table, so descending it means paging through records that carry the
whole payload. A rowid table's hash→rowid index is a narrow, dense b-tree. This is also SQLite's own
documented guidance — `WITHOUT ROWID` suits tables whose rows are small relative to a page.

Corroboration from a third direction: the contradiction seat (C6) measured `hash BLOB PRIMARY KEY`
and `id INTEGER PRIMARY KEY, hash BLOB UNIQUE` as **the same object** in SQLite (0.8% apart on time,
byte-identical on file size), because a non-`INTEGER` primary key on a rowid table is already
implemented as a separate `sqlite_autoindex_*` unique index. So today's `hash BLOB PRIMARY KEY`
shape is already correct and needs no re-keying.

### 7.2 The tmpfs caveat, and what would have to be true for the negative to be meaningless

Both measurements were taken on tmpfs. **The factors (2.0×, 3.3×, 3.8×) are not carried as facts.**
The *direction* is carried, for three reasons: two lanes reached it independently on different
workloads; the mechanism above is structural; and SQLite's own guidance predicts it. The red team
notes both lanes were "on RAM, both understated" — i.e. the tmpfs error, if it biases at all here,
biases *toward* understating a disk-bound penalty for the payload-heavy shape.

Stated explicitly, per the standard: **this negative would be meaningless if any of the following
were true.**

1. **Access is dominated by ordered full scans in hash order rather than point lookups.** Refuted
   against the code: `load()` (`checkpoint-store.ts:340-346`) is a point/predicate join by hash, and
   `prune()`'s reclaim (`:518-525`) is a `NOT EXISTS` predicate delete, not a hash-ordered scan.
   Nothing in the tier-1 module scans `ckpt_chunks` in primary-key order.
2. **The rows are small relative to a page.** True for the *narrow* tables, and the 64-byte row in
   L4's own matrix demonstrates the result flips there — which is why §7.3 assigns `WITHOUT ROWID`
   to exactly those tables and not to the payload tables. It is false for `ckpt_chunks`, whose
   default `chunkSize` is 4 MiB.
3. **The workload is cold-cache and I/O-bound rather than warm-cache and single-threaded.** L4's
   measurement was the latter. This is the one condition that is *not* refuted — but its expected
   effect is to **widen** the gap, not close it, since a cold cold-cache profile pays more for
   paging through payload-carrying interior nodes.

**Obligation:** the direction SHALL be re-confirmed on ext4 under change 1's measurement gate before
any contract or doc quotes a factor. If ext4 inverts the direction — not merely the magnitude — the
assignment in §7.3 is reopened.

### 7.3 The assignment

| Table | Rowid | Reason |
|---|---|---|
| `<s>_ckpt_chunks` | **rowid** | 4 MiB payloads; §7.1 |
| `<s>_ckpt_manifests` | **rowid** | `AUTOINCREMENT` is **incompatible** with `WITHOUT ROWID` (L4 measured `AUTOINCREMENT not allowed on WITHOUT ROWID tables`), and §2.2 requires `AUTOINCREMENT` |
| `<s>_ckpt_manifest_chunks` | `WITHOUT ROWID` | narrow junction |
| `<s>_ckpt_sequence_counters` | `WITHOUT ROWID` | 3 narrow columns |
| `<s>_watermarks` | `WITHOUT ROWID` | narrow; `value` is a small JSON cursor |
| `<s>_transaction_history` | `WITHOUT ROWID` | `entry` is a per-transaction JSON document, not a payload blob |
| `<s>_transaction_history_identifiers` | `WITHOUT ROWID` | narrow junction |
| `<s>_migrations` | `WITHOUT ROWID` | two columns |
| `<s>_writer_generation` | **rowid** | one row, and `id INTEGER PRIMARY KEY` *is* the rowid alias — `WITHOUT ROWID` would add a second b-tree for nothing (§9.4) |

Note the interaction with §6.4: `DELETE ... WHERE rowid IN (...)` is unavailable on the
`WITHOUT ROWID` tables. No current code path needs it; a future one must use the primary key.

---

## 8. Foreign keys must be enforced, or `prune()` leaks forever

Raw SQLite defaults `PRAGMA foreign_keys` **OFF**. L4 measured `node:sqlite` turning it **ON** by
default — a driver-specific behaviour, and the driver is change 1's decision, which the commitments
seat rules toward a pinnable third-party binding. So this cannot be assumed.

The failure if it is off is not a rejected write; it is **silent unbounded growth**. `ON DELETE
CASCADE` at `002_checkpoint_store.ts:58` is what removes `ckpt_manifest_chunks` rows in the same
statement as the manifest delete, and `checkpoint-store.ts:502-505` records that this is
*"also what makes them invisible to the chunk-reclaim query's `NOT EXISTS` check in the same GC
pass."* With foreign keys off, `prune()` step 1 deletes the manifest, the junction rows survive as
orphans, and step 2's `NOT EXISTS` sees a live reference for every chunk. **No chunk is ever
reclaimed again**, and nothing errors. That is the `PruneResult`/reachability-closure GC of
`Formal/STORAGE_ALGEBRA.md` §2 quietly ceasing to reclaim.

This change therefore requires the schema layer to **assert**, not assume: the migration runner
verifies `PRAGMA foreign_keys` reports 1 before applying any migration and refuses to proceed
otherwise. The pragma *bootstrap* is change 1's; the *assertion that the schema depends on it* is
this change's, and is written as a scenario with the leak as the negative control.

---

## 9. The forward-only migration framework

### 9.1 What is preserved

`docs/CONTRACT.md` §2's contract survives intact: `Migration` stays `up()`-only, there is no
`down()`, and there is no supported downgrade. The lineage is still an ordered array
(`tier1WalletMigrations`), still recorded name-by-name in a `_migrations` table, still applied one
migration per transaction. SQLite DDL **is** transactional (L6 measured `DDL inside BEGIN … ROLLBACK`
correctly rolled back), so the per-migration atomicity `migrate.ts:252-268` relies on is preserved
rather than approximated.

### 9.2 What changes

- `000_schema.ts:13`'s `CREATE SCHEMA IF NOT EXISTS` has no analogue and is **deleted**. Migration
  `000` becomes solely the `<s>_migrations` bootstrap. It keeps its name and its position, so the
  lineage's recorded identity is unchanged.
- Bootstrap detection: `migrate.ts:240-242`'s
  `select to_regclass(<schema>._migrations) is not null` becomes
  `SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?)`, which L4 measured
  returning 0 on a cold database rather than erroring — the property `migrate.ts:238-239` depends on.
- `applied_at timestamptz NOT NULL DEFAULT now()` (`000_schema.ts:17`) becomes
  `applied_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)` — epoch ms, per §2.2. Note
  that a non-constant `DEFAULT` must be parenthesized; L6 measured `ADD COLUMN … DEFAULT
  (datetime('now'))` failing as a *non-constant default* in `ALTER TABLE`, which is a different
  statement — in `CREATE TABLE` the parenthesized form is accepted.
- The `search_path` widen/reset pair (`:236`, `:273`) and the `pg_advisory_xact_lock(3, 0)` guarding
  `CREATE EXTENSION IF NOT EXISTS btree_gist` (`001_temporal_kv.ts:55-58`) both disappear with the
  features they guarded. The three-round audit history recorded at `001_temporal_kv.ts:21-54` is
  retired, not lost: it should be summarized in the new migration's header as *why* the extension
  step is gone.
- The migration lock `pg_advisory_lock(1, hashtext(schema))` (`migrate.ts:229,281`) has no analogue
  and its replacement is **change 3's** writer-exclusion mechanism. This design states the
  requirement — concurrent `runMigrations` against one file must not interleave — and does not
  specify the mechanism. `MigrationLockTimeoutError` (`migrate.ts:230`) is an existing frozen code
  and no new code is needed.

  **The qualifier this claim inherits (gate G-9).** Cross-process exclusion of two `runMigrations`
  runs does **not** rest on a process-local mutex, which is per-process by definition; it rests on
  SQLite's file-level write lock. Under WAL that lock lives in the **`-shm`** file, and change 3's
  reproduction shows it can be voided from inside the process — any `fs` read that opens and closes
  a descriptor on `-shm` drops the POSIX record locks, after which two writers may both commit and
  an acknowledged commit may be silently lost **with `integrity_check` reporting `ok`**. The
  migration lock is therefore sound **only under change 3's source guard plus the documented
  embedder precondition**, and this change asserts it only with that qualifier attached. Change 3
  carries the corresponding inheritance-table row (**E-7**, change 4 migration lock); the obligation
  is already recorded in that change's own tasks.md (its task 3.11), so it is not re-filed here.

### 9.3 Migration `005` stays, as a recorded no-op

`003_watermarks.ts:27` sets `fillfactor = 90` and `005_kv_current_fillfactor.ts:21` does the same
for `kv_current`, both for Postgres HOT (heap-only-tuple) updates. SQLite has no MVCC row
versioning, no HOT concept, and no index-bloat-from-non-HOT-update failure mode, so both are
meaningless.

**`005` is retained in the lineage with a no-op `up()` and a header explaining why**, rather than
removed. Removing it would change the lineage's recorded shape and the `_migrations` row set, for no
benefit; keeping it makes the two lineages comparable and keeps the numbering stable for
`006`. This is a deliberate departure from "delete dead code" and is called out so a reviewer does
not helpfully delete it.

**Two hard invariants are retired, and retirement is a gain.** `003_watermarks.ts:10-12` and
`005_kv_current_fillfactor.ts:15-17` both declare *"never add an index on this table's non-PK
columns"* — a binding constraint on all future work that existed only to protect HOT eligibility.
Under SQLite it is void, and `watermarks.updated_at` becomes indexable. The retirement is recorded
in the migration headers so that the constraint's disappearance is traceable to a reason rather than
to an omission. A consequence for change 1, flagged not solved: high-frequency small updates instead
pressure **WAL growth and checkpointing**.

### 9.4 Migration `007` — the `writer_generation` table, and how the guard bootstraps

**The gap this closes.** Change 3's cross-process writer guard (`v1.0.0-sqlite-concurrency-lease`,
design heading **"Cross-process: the writer-generation guard"** -> **"The protocol"**) depends on a
single-row registration table in the main database file, and its dependency row **D-4** defers
*"the writer-registration table's physical name"* to this change while keeping *"its columns and
protocol"* its own. This change's §0 table previously pushed the whole mechanism back to change
3, and §12.1's lineage contained no such table — so the table was described by two changes and
created by neither. It is created here.

That is also required for §1.3's rule to be **true**: "every object name in every UmbraDB lineage is
`<schema>_<object>`, produced by one `qualify()` function" is falsified by a table that exists
outside the lineage. As change 3 sketches it the table would violate three requirements of this
capability — it carries no prefix, it is not `STRICT`, and its `CHECK (id = 1)` is unnamed, which
change 5 separately relies on being named (§3). The DDL in §12.1 fixes all three.

**Lineage position: a new migration `007_writer_generation`.** Not folded into `000` or `002`: the
lineage is forward-only (`docs/CONTRACT.md` §2) and `000`–`006` are the transliterated identity of an
existing lineage (§9.3). A new table is a new migration.

**The seed row is this change's, and its absence would be silent.** Change 3's registration protocol
is an `UPDATE ... WHERE id = 1` followed by a read-back — **not** an upsert. Against an empty table
the `UPDATE` matches zero rows, the `SELECT` returns no row, and `myGeneration` is undefined while
every statement reports success. Migration `007` therefore **inserts the singleton row in the same
migration that creates the table**, with `generation = 0`, so the first process to register reads
back `1`. Stated explicitly because it is the kind of omission that produces a guard which silently
guards nothing.

**The ordering question — how a guard bootstraps when migrations are themselves writes.** The
sequence at open is:

1. `runMigrations` runs to completion. Migration `007` creates and seeds the table.
2. Change 3's registration transaction bumps `generation` and reads back `myGeneration`.
3. Adapter write transactions begin, each re-reading the generation inside its own
   `BEGIN IMMEDIATE` per change 3's protocol.

**Migrations are deliberately *not* covered by the generation guard, and do not need to be.** At
step 1 no process has a `myGeneration` yet, so the guard is not merely unavailable — it is undefined.
Concurrent migration runs are excluded by a *different* mechanism, already specified: the migration
lock (§9.2's last bullet, surfacing as the existing `MIGRATION_LOCK_TIMEOUT`), reinforced by
`BEGIN IMMEDIATE` making two migration transactions mutually exclusive across processes regardless.
So cross-process exclusion is continuous across the handover — the migration lock covers step 1, the
generation guard covers step 3 — with no window in which neither applies. A guard that read a table
its own migration had not yet created would be the ordering bug this sprint exists to catch before
implementation; the resolution is that the guard's first read happens at step 2, strictly after step
1 commits.

**What this change does not say.** When the generation is re-read, what a mismatch throws, whether
lease acquisition also checks it, and whether the bump is once-per-open — all change 3's
(`v1.0.0-sqlite-concurrency-lease/design.md` §2.2). This change asserts only that the table exists,
is correctly shaped, is seeded, and obeys every invariant §1–§3 impose on the rest of the schema.

---

## 10. Contested ruling (b) — migration `006` replays **unchanged**

### 10.1 The disagreement

L4's headline blocker (`reports/l4-typesystem.md` §B1) states that
`ALTER TABLE ... ADD COLUMN ... GENERATED ALWAYS AS (...) STORED` — literally
`006_ckpt_chunks_size_bytes.ts:16-19` — is *"refused outright"*, and recommends a `VIRTUAL` column
workaround. **L6 measured more precisely** (`reports/l6-contracts.md` §B3, and its raw output at
`:404-406`): the statement **succeeds on a 0-row table** and fails with `cannot add a STORED column`
only at **1 or more rows**. The contradiction seat independently reproduced L6's result (C8:
`0 rows -> OK`, `1 rows -> FAIL`).

### 10.2 The ruling

**L6's finding is more precise and it governs.** A fresh SQLite lineage runs `000` → `006` in order
against an empty database, so `ckpt_chunks` holds **zero rows** when `006` executes, and migration
`006` replays **verbatim, including `STORED`**. Therefore:

- L4's `VIRTUAL` workaround is **not adopted**.
- L6's option (b), folding `size_bytes` into `002`'s `CREATE TABLE`, is **not adopted** — it would
  change two migrations to solve a problem that does not exist, and `002`'s recorded shape is worth
  more than the saved statement.
- **L4's argument that the pre-1.0.0 tag window is "worth real engineering money, and that saving is
  in B1" collapses** (contradiction seat, C8, verbatim). B1 costs nothing at any tag time for a
  greenfield lineage. The window's real value for *this* change is the one-time `listKeys` collation
  reorder (§11.3) and the disclosure of the narrowed `schema` meaning — both cheap, both pre-tag.

`octet_length(data)`, not `length(data)`, per §3.

### 10.3 What genuinely remains

A **forward constraint on future migrations**, which is real and must not be lost with the blocker
that turned out not to be one:

> Once a SQLite database has data, no migration may add a `STORED` generated column to a populated
> table. `VIRTUAL` always works (L6 measured it at 0.1 ms even on 200,000 rows) and is indexable
> (L4 measured `SEARCH ck USING INDEX ck_by_size (size_bytes>?)`); a `STORED` column on populated
> data requires a full table rebuild, whose peak on-disk footprint L6 measured at **3.5×** the
> logical data, not the 2× everyone assumes, because the whole rebuild sits in one WAL that cannot
> be checkpointed until it commits.

This is falsifiable rather than advisory: a test applies `000`→`005`, inserts one `ckpt_chunks` row,
then applies `006` and asserts it fails with `cannot add a STORED column`. That test simultaneously
proves the constraint is real and documents it in executable form. It runs against a throwaway
database and does not affect the shipped lineage.

---

## 11. `listKeys` — a range scan, not `LIKE`

### 11.1 Two defects in one statement

`temporal-kv.ts:317-323` builds `escapeLikePrefix(prefix) + "%"` and runs
`key LIKE ${escaped} ESCAPE '\'`. Under SQLite, L4 measured (`reports/l4-typesystem.md` §3.7):

- `LIKE 'ab%'` returns `["Abc","aBc","ab","abc","abcd","abd"]` — **case-insensitive for ASCII**,
  matching keys it must not. Postgres `LIKE` is case-sensitive.
- `EXPLAIN QUERY PLAN` shows `SEARCH kv USING PRIMARY KEY (ns=? AND scope=?)` — **no key range**. It
  scans every key in the `(ns, scope)` group.

### 11.2 The replacement, already blessed by the frozen interface

```sql
SELECT key FROM <s>_kv_current
WHERE ns = :ns AND scope = :scope AND key >= :prefix AND key < :prefixUpper
ORDER BY key
```

L4 measured this correct, case-sensitive, and resolving to
`SEARCH kv USING PRIMARY KEY (ns=? AND scope=? AND key>? AND key<?)`. `escapeLikePrefix`
(`temporal-kv.ts:50`) is deleted entirely — there are no metacharacters and no `ESCAPE`.

**No G1/G2 issue arises**: `src/interfaces/temporal-kv.ts:314-321` already states that the prefix is
matched as a *literal* string prefix and explicitly offers *"a non-pattern-based range comparison
instead"* as an allowed implementation. `design/design-interfaces.md` §3.2 is the interface section
this lives under and is unchanged.

`PRAGMA case_sensitive_like=ON` also fixes both (L4 measured), and is **rejected**: it is
connection-global and would change `LIKE` semantics for every other consumer of the same handle.

### 11.3 `prefixUpper`, specified precisely, because the edge cases are where this breaks

`:prefixUpper` is the **successor** of `prefix` in code-point order:

1. If `prefix` is empty, **omit the upper bound entirely** (every key in the group matches). Do not
   attempt to synthesize one.
2. Otherwise let `c` be the last **code point** (not UTF-16 code unit) of `prefix`. `prefixUpper` is
   `prefix` with `c` replaced by the next **Unicode scalar value**: `c + 1`, except that
   **U+D7FF's successor is U+E000** — U+D800…U+DFFF are surrogates and are not scalar values, and
   binding one would be exactly the lone surrogate `hasPostgresUnsafeText`
   (`src/interfaces/temporal-kv.ts:35-37`) exists to reject and that L4 measured being silently
   replaced with U+FFFD.
3. If `c` is U+10FFFF, strip it and recurse on the shortened prefix; if that empties the prefix,
   omit the upper bound.

This is correct under SQLite's default `BINARY` collation because UTF-8 byte order **is** code-point
order: for any key `s` with prefix `p`, `p ≤ s < succ(p)`.

### 11.4 Collation and the resume cursor

SQLite's `BINARY` collation is UTF-8 byte order, i.e. **code-point** order. Postgres's `ORDER BY
key` follows the database's `lc_collate` — commonly `en_US.UTF-8`, which is *not* code-point order;
only `C`/`ucs_basic` matches.

`src/interfaces/temporal-kv.ts:314` promises only *"a stable order for resumable pagination"*, not a
named collation, so `BINARY` is compliant and there is **no contract break**. Two consequences that
are nonetheless real:

- **A one-time reorder hazard at the migration boundary.** A consumer that persisted a `listKeys`
  resume position under Postgres collation and resumed under SQLite collation could skip or repeat
  keys **once**. Because §15 Q1 closed **YES** — consumers exist on three install channels — this
  hazard will actually be crossed when their Postgres data is migrated, and change 7 owns handling
  it. Landing pre-tag makes it a one-time migration concern rather than a SemVer event; it does not
  make it free. Post-tag it is additionally a
  live-migration data hazard. This is the item for which the pre-tag window has genuine value in
  this change (§10.2).
- **Code-point order is not JS string order.** L4 reported SQLite `BINARY` and a JS code-unit sort
  as identical, but that fixture contained no supplementary-plane characters. JS `<` on strings
  compares **UTF-16 code units**, so a code point ≥ U+10000 (leading surrogate 0xD800–0xDBFF) sorts
  *before* U+E000–U+FFFF in JS and *after* them by code point. **This is an inference from the
  encodings, not a measurement**, and the spec states it as an obligation to test rather than a
  fact: any assertion about `listKeys` ordering must compare by code point
  (`[...s].map(c => c.codePointAt(0))`), never by a bare JS `sort()`.

---

## 12. The DDL

### 12.1 Tier-1 lineage (TemporalKV's tables are change 2's and are not shown)

`<s>` denotes the validated schema prefix from §1.3.

```sql
-- 000_schema (no CREATE SCHEMA exists)
CREATE TABLE <s>_migrations (
  name       TEXT    NOT NULL PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
) STRICT, WITHOUT ROWID;

-- 002_checkpoint_store
CREATE TABLE <s>_ckpt_chunks (                      -- rowid table, §7
  hash       BLOB    NOT NULL PRIMARY KEY
             CONSTRAINT <s>_ckpt_chunks_hash_len CHECK (octet_length(hash) = 32),
  data       BLOB    NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE <s>_ckpt_manifests (                   -- rowid table (AUTOINCREMENT), §7.3
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  w             TEXT    NOT NULL,
  net           TEXT    NOT NULL,
  seq           INTEGER NOT NULL,
  complete      INTEGER NOT NULL DEFAULT 0
                CONSTRAINT <s>_ckpt_manifests_complete_bool CHECK (complete IN (0,1)),
  manifest_hash BLOB    NOT NULL
                CONSTRAINT <s>_ckpt_manifests_hash_len CHECK (octet_length(manifest_hash) = 32),
  label         TEXT,
  created_at    INTEGER NOT NULL
) STRICT;
CREATE INDEX <s>_ckpt_manifests_lookup
  ON <s>_ckpt_manifests (w, net, complete, seq DESC);

CREATE TABLE <s>_ckpt_manifest_chunks (
  manifest_id INTEGER NOT NULL REFERENCES <s>_ckpt_manifests(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  chunk_hash  BLOB    NOT NULL REFERENCES <s>_ckpt_chunks(hash),
  PRIMARY KEY (manifest_id, position)
) STRICT, WITHOUT ROWID;
CREATE INDEX <s>_ckpt_manifest_chunks_by_hash
  ON <s>_ckpt_manifest_chunks (chunk_hash);

CREATE TABLE <s>_ckpt_sequence_counters (
  w TEXT NOT NULL, net TEXT NOT NULL, next_seq INTEGER NOT NULL DEFAULT 2,
  PRIMARY KEY (w, net)
) STRICT, WITHOUT ROWID;

-- 003_watermarks (no fillfactor; §9.3)
CREATE TABLE <s>_watermarks (
  kind       TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  value      TEXT    NOT NULL,                      -- JSON text, never json()'d
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, key)
) STRICT, WITHOUT ROWID;

-- 004_transaction_history (identifiers normalized out)
CREATE TABLE <s>_transaction_history (
  wallet_id  TEXT    NOT NULL,
  tx_hash    TEXT    NOT NULL,
  entry      TEXT    NOT NULL,                      -- JSON text
  lifecycle  TEXT    NOT NULL
             CONSTRAINT <s>_transaction_history_lifecycle_enum
             CHECK (lifecycle IN ('pending','finalized','rejected')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (wallet_id, tx_hash)
) STRICT, WITHOUT ROWID;

CREATE TABLE <s>_transaction_history_identifiers (
  wallet_id  TEXT NOT NULL,
  tx_hash    TEXT NOT NULL,
  identifier TEXT NOT NULL,
  PRIMARY KEY (wallet_id, tx_hash, identifier),
  FOREIGN KEY (wallet_id, tx_hash)
    REFERENCES <s>_transaction_history(wallet_id, tx_hash) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX <s>_th_ident_reverse
  ON <s>_transaction_history_identifiers (wallet_id, identifier, tx_hash);
CREATE INDEX <s>_th_pending
  ON <s>_transaction_history (wallet_id, tx_hash) WHERE lifecycle = 'pending';

-- 005_kv_current_fillfactor: recorded no-op (§9.3)

-- 006_ckpt_chunks_size_bytes: replays verbatim on the 0-row table (§10)
ALTER TABLE <s>_ckpt_chunks
  ADD COLUMN size_bytes INTEGER GENERATED ALWAYS AS (octet_length(data)) STORED;

-- 007_writer_generation (§9.4). Columns and protocol are change 3's
-- (`v1.0.0-sqlite-concurrency-lease/design.md` §2.2); DDL, seeding and lineage position are this
-- change's. Plain rowid table: `id` is the rowid alias, so `WITHOUT ROWID` would add a second
-- b-tree for a one-row table and buy nothing (§7.3).
--
-- 008_ckpt_manifests_seq_unique (§17) is declared after this block:
--   CREATE UNIQUE INDEX <s>_ckpt_manifests_seq_unique ON <s>_ckpt_manifests (w, net, seq);
-- FULL, not partial: a partial index would condition integrity on a corruptible predicate
-- (§17.3c). Its backing index is also what makes §17.3's mandatory runtime invariant cheap.
-- It is defence-in-depth ONLY -- it does not close the gap on its own (§17.3b).
CREATE TABLE <s>_writer_generation (
  id            INTEGER PRIMARY KEY
                CONSTRAINT <s>_writer_generation_singleton CHECK (id = 1),
  generation    INTEGER NOT NULL
                CONSTRAINT <s>_writer_generation_nonneg CHECK (generation >= 0),
  owner         TEXT    NOT NULL,   -- uuid, unique per open; authoritative
  pid           INTEGER,            -- diagnostic only, never authoritative
  host          TEXT,               -- diagnostic only, never authoritative
  registered_at INTEGER NOT NULL    -- epoch ms (§2.2)
) STRICT;

-- The seed row is part of this migration, NOT of change 3's registration: that protocol is an
-- UPDATE, which would match zero rows and leave myGeneration undefined with no error (§9.4).
INSERT INTO <s>_writer_generation (id, generation, owner, pid, host, registered_at)
VALUES (1, 0, '', NULL, NULL, 0);

-- 008_ckpt_manifests_seq_unique (§17). Defence-in-depth against a corrupted `next_seq`; the
-- mandatory fix is the runtime invariant in §17.3(a), not this index.
CREATE UNIQUE INDEX <s>_ckpt_manifests_seq_unique
  ON <s>_ckpt_manifests (w, net, seq);
```

This preserves the decisions in `design/design.md` §3 (content-addressed chunker, the
`(manifest_id, position)` junction key admitting a repeated chunk hash at two positions, the
`ON DELETE CASCADE` that makes GC possible) and §4 (Watermarks as trivial last-write-wins,
`design/design-interfaces.md` §3.4), and the sequence-allocator design at
`002_checkpoint_store.ts:70-83` (`DEFAULT 2` so the first claim returns `next_seq - 1 = 1`). It
changes none of them; it re-expresses them.

### 12.2 The decoder registry handed to change 1

A static `(table, column) → decoder` map derived mechanically from the above — roughly 40 lines of
data. Rules:

- Every `INTEGER` column whose Postgres origin was `timestamptz` (`*.created_at`, `*.updated_at`,
  `_migrations.applied_at`) decodes to `Date`.
- Every `TEXT` column whose Postgres origin was `jsonb` (`watermarks.value`,
  `transaction_history.entry`) decodes by `JSON.parse`.
- Every other column decodes as its native SQLite class.
- **Any view column, and any column with a `NULL` origin `table`, requires an explicit registry
  entry or an alias to its origin column** (§2.3). Absence of an entry for a view column is a
  registry defect, not a fall-through default.

---

## 13. Break classification — pre-tag vs post-tag

`docs/STABILITY.md:46`: *"**Current version: `0.9.5` — the commitments above are NOT yet in
force.**"*; `:60-61`: a breaking change between `0.9.5` and `1.0.0` is permitted.

| Item | Pre-tag cost | Post-tag cost | Permanent regardless of timing? |
|---|---|---|---|
| `DEFAULT_SCHEMA`'s **meaning** narrows (isolates → names) | CHANGELOG + `docs/SCHEMA.md` rewrite | same | **No, and it is not a surface break at all** — symbol, type, every ctor param survive |
| Dropping schema configurability (the option **not** taken) | CHANGELOG entry | **major version** | No — fully avoidable; never pay it |
| Forward `ADD COLUMN … STORED` capability narrows | **free** — `006` replays unchanged (§10) | permanent constraint on future migrations | Constraint yes; cost no |
| One-time `listKeys` collation reorder | **not free** — consumers exist on three channels (§15 Q1), so migrating their Postgres data crosses the collation boundary once; change 7 owns handling it | live-migration data hazard, plus a SemVer event | **Yes, in the sense that it must be handled** — tag timing changes who absorbs it, not whether it occurs |
| `text[]` leaves the on-disk shape | none — `TransactionHistoryEntry.identifiers` stays `readonly string[]` | none | No; invisible above the adapter |
| The two `fillfactor` hard invariants retire | none | none | No — a widening, not a break |
| Constraint-name-based error translation | change 5's call | change 5's call | Change 5's |

**The honest headline: nothing in this change is a permanent break to the exported surface, and the
pre-tag window's value here is smaller than an earlier reading claimed** (§10.2). The window matters
greatly for changes 1, 3 and 5; for this change it buys a documentation disclosure and softens — but
no longer eliminates — the collation reorder, since §15 Q1 closed **YES** and real consumers must be
migrated across it by change 7.

---

## 14. On the formal layer

`Formal/STORAGE_ALGEBRA.md`'s cut-line `{T3, T5, W1, C1}` is unaffected *as a proof* by this change,
because it models an abstract store and the abstract→concrete refinement was always an explicitly
trusted, unmechanized bridge. **That survival is not evidence this change is safe** — it is
`SYNTHESIS.md`'s trap 8, "a green gate certifies depth, never breadth". Two concrete consequences
for this change:

- The P1–P10 conformance suite carries the refinement claim, and it must be **re-executed, not
  amended**, against the shapes in §12.
- §2.1's `STRICT` argument is a case where a *storage-level* detail can falsify a cut-line law (T3)
  with the proof still green. That is the clearest available illustration of why the bridge is
  trusted rather than proved, and it is why `STRICT` is a requirement rather than a preference.

---

## 15. Open questions, each with the experiment that closes it

1. ~~**Is anyone installing UmbraDB from the git tag?**~~ — **CLOSED, answered YES.**
   `v1.0.0-sqlite-data-migration` (change 7) records the answer in its proposal: *"consumers install
   through three channels: the git tag, a repository clone, and docker images"*, and notes that a
   git-tag install and a clone install leave no observable trace. An earlier draft of this section
   left the question open and stated it "blocks nothing in this change"; **that is now false and is
   retracted.** The consequences, which are live rather than hypothetical:
   - A PostgreSQL→SQLite data-migration path **is** required, and change 7 is it.
   - §17.4's flag — existing deployments may already hold rows violating `UNIQUE (w, net, seq)` —
     is a **live obligation on change 7**, not a conditional one.
   - §11.4's one-time `listKeys` collation reorder is a **real migration-boundary hazard** for
     existing Postgres consumers, not a free pre-tag change. §13's break table is corrected to match.
   - What does *not* change: there are still no shipped **SQLite** databases, so §10's `STORED`
     replay and §5's `NULLS NOT DISTINCT` emulation remain free — those depend on SQLite lineage
     history, which is empty, not on Postgres consumers.
2. **Does the `WITHOUT ROWID` direction survive ext4?** *Closes by:* re-running L4's §3.6 matrix on
   `/root` (ext4) at 4 KiB / 64 KiB / 4 MiB rows under change 1's gate. If the direction inverts,
   §7.3 reopens.
3. **Is a `STORED` `size_bytes` measurably better than `sum(octet_length(data))` computed on the
   fly?** L6 suspects the column may be unnecessary entirely, since SQLite has no TOAST and blob
   length is O(1) from the record header. *Closes by:* benchmarking `history()`'s aggregate both
   ways on ext4. **Not blocking** — `006` replays either way; this only decides whether a future
   migration drops the column.
4. **Does SQLite `BINARY` ordering diverge from a JS `sort()` on supplementary-plane keys?**
   Inference, not measurement (§11.4). *Closes by:* a unit test over a key set containing
   U+FFFF and U+10000.
5. **Is `serialize()`'s output stable across the engine change?**
   `transaction-history-storage.ts:374-377` is `getAll()` + `JSON.stringify`, so it re-serializes
   from parsed objects and should be engine-independent — *unless* Postgres `jsonb`'s key reordering
   is currently observable in that output and something downstream depends on it (a hash, a golden
   file). Consumers were not audited. *Closes by:* a golden-file diff of `serialize()` output before
   and after. **Flagged to change 5**, which owns the contracts.
6. **Is `SaveCheckpointOptions.chunkSize`'s Zod bound below `SQLITE_MAX_LENGTH = 1000000000`?** The
   4 MiB default is comfortably inside it; the value is caller-supplied. *Closes by:* reading the
   schema. Cheap; not yet done.
7. **What replaces `query.cursor(256)` for `listKeys` streaming?** The merged
   `temporal-kv` spec requires the first key to be observable before every matching row has been
   fetched (`openspec/specs/temporal-kv/spec.md:213-226`), implemented today by a postgres.js server
   cursor at `src/postgres/temporal-kv.ts:324`. SQLite has no server cursor; `StatementSync` iterates
   in process. **Owned by changes 1 and 2, not this one** (§16.5). *Closes by:* change 1 specifying
   the shim's iteration model and change 2 deciding whether the merged requirement's streaming
   scenario is satisfied, reworded, or removed. This change's §11 constrains only the *predicate*
   that method issues, and is compatible with any of those outcomes.

---

## 16. The cross-change seam in the merged `temporal-kv` spec — ruling

### 16.1 The gap

`openspec/specs/temporal-kv/spec.md` is the **only merged spec in the repository**. Two of its
requirements are Postgres-worded but are conceptually **migration-framework and schema-namespacing**
requirements — this capability's territory, not TemporalKV's:

- `### Requirement: Migrations are idempotent and ordered` (`:6`) — describes
  `migrations/NNN_*.sql` files applied in ascending numeric order and recorded in
  `umbradb._migrations`.
- `### Requirement: Schema isolation is the default, not opt-in` (`:25`) — requires the connection
  factory to *"create and operate within a dedicated Postgres schema"* and to *"set `search_path` to
  that schema for every connection it creates"*.

Change 2 (`v1.0.0-sqlite-temporal-event-log`) deliberately did not delta them, correctly, because
they are not TemporalKV requirements. But a change's spec deltas resolve against the capability
directory they live in, so this change's `specs/storage-schema/` deltas cannot reach them. Left
alone by both, the merged spec would keep two requirements that are **false** after the migration:
there is no `search_path`, there is no `CREATE SCHEMA`, and the file-name-ordered `.sql` lineage was
already stale (`src/postgres/migrations/` holds `.ts` modules).

### 16.2 Ruling — take them, in a second delta directory

**Accepted.** This change carries `specs/temporal-kv/spec.md` alongside `specs/storage-schema/spec.md`,
containing exactly those two headers under `## MODIFIED Requirements`. An OpenSpec change may carry
deltas for more than one capability, and `v1.0.0-api-surface` and sprint-2 both do.

The alternatives were considered and rejected:

- **Defer to change 5's contract sweep.** Rejected: change 5 owns *written contracts* (`docs/`), not
  spec requirements about DDL and object naming, and deferring would leave the false requirements
  merged for the duration of the sprint.
- **Delete rather than modify.** Rejected: both properties remain true in substance — migrations are
  still idempotent and ordered, and a `schema` value still yields a disjoint object set. What
  changes is the mechanism and, for the second, the strength of the guarantee. `REMOVED` would
  discard a property UmbraDB still holds.

### 16.3 Header discipline

Both headers are reproduced **byte-for-byte** from the merged file, verified by grep against
`openspec/specs/temporal-kv/spec.md` rather than retyped. OpenSpec resolves a modification by header
text; a paraphrased header silently creates a *new* requirement and leaves the false one standing —
which is the same failure class this whole section exists to close. Change 2 applied the same
discipline to its own eight modified headers.

### 16.4 One thing this ruling knowingly leaves wrong, and owes

The header `Schema isolation is the default, not opt-in` names a property that, after this change,
**is not delivered**: the `schema` value namespaces, it does not isolate (§1.3). Retaining a header
whose noun the body then narrows is not ideal. It is done anyway, because the alternative — fixing
the name now — would break delta resolution against the merged spec and create a duplicate
requirement. **A rename is owed to a later change**, together with change 2's own deferred renames,
and the body carries an explicit header note so a reader is not misled by the name alone. Recorded
here as an open ruling rather than left as an inconsistency.

### 16.5 An adjacent requirement this change deliberately does **not** delta

`### Requirement: listKeys streams without materializing the full result set first, and orders
results correctly` (`openspec/specs/temporal-kv/spec.md:213`) is **not** deltaed here, and the
reason is recorded rather than left to inference. §11 changes that method's *predicate* (a range
scan instead of `LIKE`), which is this capability's business; the merged requirement is about its
*streaming* and *ordering* behaviour, which is the adapter's. Two of its three properties survive
verbatim — newest-version-only, and a stable order (§11.4 establishes that `BINARY` satisfies
"stable", so this is compliant without a delta).

The third does **not** survive cleanly and is flagged, not claimed: the requirement's scenario
*"the first yielded key SHALL be observable before every matching row has been fetched from
Postgres"* is implemented by `query.cursor(256)` (`src/postgres/temporal-kv.ts:324`), a postgres.js
server-cursor mechanism with no SQLite analogue — SQLite's `StatementSync` iterates a result set in
process, and cancellation of an in-flight read is separately unavailable. **That seam spans changes
1 (driver/shim iteration model) and 2 (the adapter), not this one**, and this change does not grab
it. It is named here so it is not silent, and is listed as open question 7 in §15.

Similarly, `### Requirement: A caller-supplied transaction handle is honored or rejected, never
silently ignored` (`:104`) is untouched: change 2 examined it and left it deliberately, and the
transaction-handle mechanism is change 3's.

---

## 17. The sequence-allocator integrity gap — ruling

### 17.1 The gap is real, and it predates the migration

The R-3 corruption-modes seat found that a single corrupted byte in `ckpt_sequence_counters.next_seq`
makes `save()` allocate a sequence *below* the existing maximum, after which the wallet saves new
state, receives **no error**, and loads back a stale checkpoint with every digest passing. Every
later save repeats it, so the store is permanently frozen at a stale checkpoint while reporting
success on every write. This is "wrong row returned" — the stored bytes are intact and the
*reachability* is wrong, so no per-value digest can see it.

The DDL half is confirmed against `002_checkpoint_store.ts`: `ckpt_sequence_counters` is
`(w, net, next_seq bigint NOT NULL DEFAULT 2, PRIMARY KEY (w, net))` (`:77-83`); `ckpt_manifests`
has `seq bigint NOT NULL` with no uniqueness (`:26-36`); `ckpt_manifests_lookup` (`:40-41`) is a
plain `CREATE INDEX`. Nothing relates `next_seq` to `max(seq)`. **The gap exists in PostgreSQL today
exactly as it would in SQLite** — it is not introduced by this migration, and this change is simply
the first opportunity to close it.

The consequence is confirmed against `load()` (`checkpoint-store.ts:328-334`), which selects
`ORDER BY seq DESC LIMIT 1`: a manifest written at a low seq is invisible to `load()` forever, and
the previous maximum is returned instead.

### 17.2 The complication is not reachable — established by reading, not assumed

The coordinator asked whether a failed or retried save can leave an abandoned incomplete manifest at
the same `(w, net, seq)`, which would make a naive `UNIQUE (w, net, seq)` a liveness bug. **It
cannot.** Four findings, each from the code:

1. **There is exactly one `INSERT` into `ckpt_manifests`** (`checkpoint-store.ts:252`), and it writes
   `complete` **explicitly `true`** in its column list (`:248-256`). `grep` over `src/` finds **no
   `UPDATE` of `complete` anywhere** — no two-phase write exists.
2. **Sequence allocation and manifest insert are in the same transaction.** Both run inside
   `runOnTx` (`:192`), which executes under one `withTransaction` or the caller's `tx`. A rollback
   undoes the counter increment *and* the manifest row together, so a failed save leaves neither.
3. **A retry after a committed save allocates a fresh seq**, because the counter increment committed
   with it. It cannot collide.
4. `openspec/changes/sprint-3-checkpoint-store/design.md` §2.3 states the intent verbatim:
   *"`complete` is always `true` for any manifest `save()` produces … there is additionally no code
   path that could leave a partially-written manifest visible at all"*, that the read-side filter is
   *"redundant-but-harmless defense-in-depth, not a load-bearing mechanism"*, and — binding —
   ***"No task in this change may add a code path that ever sets it `false`"***.

The `DEFAULT false` is therefore **not headroom for a two-phase save**. §2.3 says why it is kept: so
that *"a future write path that forgets the column fails visibly in tests rather than becoming
implicitly-complete by default"*. It is a **tripwire**, and reading it as headroom inverts its
purpose.

### 17.3 Ruling: the invariant is the fix; the constraint is defence-in-depth; the constraint is full, not partial

**(a) The runtime invariant `next_seq > max(seq)` is mandatory and primary.** Asserted inside
`save()`'s transaction, after allocation: the claimed `seq` SHALL exceed `coalesce(max(seq), 0)`
over existing manifests for that `(w, net)`.

**(b) `UNIQUE (w, net, seq)` is added as defence-in-depth — and it does *not* close the hole on its
own.** This is the point the seat's framing blurs and it must not be lost: a uniqueness constraint
catches a corrupted `next_seq` only when the claimed seq *collides with a surviving row*. It does
nothing when the corrupted value lands in a gap. Worked example, using the module's own prune
semantics (`checkpoint-store.ts:495-501`, retaining at least one): with manifests 1–34 pruned down
to just seq 34 and `next_seq = 35`, corrupting `next_seq` to 5 claims seq 5, collides with nothing,
inserts cleanly, and `load()` still returns 34. **The constraint passes and the store is still
silently frozen.** The invariant catches it, because `5 > 34` is false. Anyone adopting only the
constraint would believe the hole closed when it is not.

**(c) The unique index is FULL, not partial (`WHERE complete`).** Today the two are exactly
equivalent, since every row has `complete = true` (§17.2). The tie-break is the threat model: we are
defending against **corruption of arbitrary bytes in an unchecksummed file**, and a partial index
conditions the integrity constraint on a *corruptible predicate*. If `complete` is flipped
true-to-false on a row by the same class of corruption, a partial index silently stops covering that
row — the constraint's strength would depend on a byte the design itself calls "not a load-bearing
mechanism". Conditioning integrity on non-integrity is backwards.

This is *not* a general argument against partial unique indexes, and it does not conflict with §12.1
elsewhere: the partial shape is right for `blocks.is_canonical`, where the predicate encodes a
genuine domain fact with several legitimate rows per height. It is wrong here, where the design says
every row is complete. Where the two shapes are equivalent, prefer the one that does not depend on a
mutable column.

**(d) The invariant's cost is one index-only seek**, and the constraint's own backing index is what
makes it cheap: `UNIQUE (w, net, seq)` serves `max(seq)` for a `(w, net)` directly. Note the assert
reads `max(seq)` **without** the `complete` filter, for the reason in (c).

**(e) The error is change 5's to name (gate G-14).** It must be non-retryable and loud; the code
choice belongs to `v1.0.0-sqlite-durability-contract`'s catalog, and no new code should be minted
without checking the existing catalog first — that caution is change 3's ruling and applies here
too. This change contributes **exactly two faults** to that routing, named so they are unambiguous:
**(F-a)** the `008` `UNIQUE (w, net, seq)` violation raised when a corrupted `next_seq` claims a
colliding sequence, and **(F-b)** the transaction-history read-path **lifecycle disagreement**
between the `lifecycle` column and `entry.lifecycle.status` (§19.2). The identifier
derive-and-compare mismatch is the same fault class as (F-b) and routes with it. Change 5's
tasks.md already carries the routing obligation (its task 1.10), so it is not re-filed here.

### 17.4 Lineage position, and the dependency this creates

A new migration **`008_ckpt_manifests_seq_unique`**, not folded into `002`, for the reason §10.2
gives for not folding `006`: `002`'s recorded shape is worth more than a saved statement. On a fresh
lineage `ckpt_manifests` is empty when `008` runs, so the index builds trivially.

**Pre-tag this is free; post-tag it is a compatibility event** — a constraint PostgreSQL never had.
And it creates a cross-change dependency that must be flagged rather than discovered: **existing
PostgreSQL deployments may already contain rows violating `UNIQUE (w, net, seq)`**, if this
corruption has ever occurred in the field. **Change 7 owns the PostgreSQL-to-SQLite data migration
and must decide what happens to rows that fail the new constraint** — reject the migration, or
quarantine and report. This change does not decide that; it states the obligation.

`blocks.is_canonical`'s partial unique index is **change 6's**, now that the archive is in scope.
Coordinated, not specified here.

---

## 18. Schema-text integrity — a digest over `sqlite_schema`

### 18.1 The exposure

The seat measured that corrupting a `CHECK` constraint's text in `sqlite_schema` yields
`integrity_check` reporting ok, and then admits a 7-byte value into a column declared
`octet_length(h) = 32`. That lands squarely on this change: **the entire `STRICT` / named-`CHECK`
regime of §2 and §3 is stored as ordinary text in an unchecksummed region of the same file it
protects.** A constraint regime that cannot detect its own silent weakening is worth less than it
appears, and §3 sells those constraints as guarantees.

### 18.2 Ruling — the artifact is mine, the verification is change 5's

Split on the same principle as §9.4's `writer_generation` table: **this change owns the artifact and
the point at which it is recorded; change 5 owns when it is checked and what it raises.**

This change specifies: at the end of every successful `runMigrations`, a digest is computed over the
`sql` text of every `sqlite_schema` row whose object name carries this schema's prefix, in a
deterministic order, and recorded in the lineage's bookkeeping. It is recomputed at the end of every
successful migration run, because the lineage mutates schema text after creation — `006`'s
`ALTER TABLE ... ADD COLUMN` rewrites `ckpt_chunks`'s stored `sql` (§10). It covers only the
prefixed subset, so two schemas in one file get independent digests (§1.3).

Change 5 owns: when it is verified (open, probe, or both), what error a mismatch raises, and how it
relates to the application-level checksum work it already owns for the page-checksum gap.

### 18.3 The honest limit, stated rather than discovered

**The digest detects corruption, not tampering.** It lives in the same unprotected file as the
schema text it covers, so anything that can rewrite a `CHECK` can rewrite the digest. Against random
corruption — the actual threat model, and the one the seat measured — it is worth having, because
uncorrelated corruption of both regions is vanishingly unlikely. Against an adversary with write
access to the file it is worth nothing, and it must not be described as a security control. Recorded
here so no later document promotes it into one.

### 18.4 `quick_check` is not an alternative to `integrity_check`

The seat measured six independent index-vs-table divergences in which `quick_check` returned ok
every time while `integrity_check` reported the fault, because `quick_check` skips the index
cross-check. **Verified for this change:** a `grep` for `quick_check` and `integrity_check` across
this change's five files, run *before* this section was written, returned **no hits at all** — so no
requirement here ever offered them as alternatives and there was nothing to remove. The only
occurrences today are this section, the scenario in `specs/storage-schema/spec.md` that forbids the
substitution, and its acceptance row SD5; each states the prohibition rather than offering a choice.
Recorded so the check is not repeated, and flagged to change 5, which owns the durability probe and
is where such an alternative could plausibly appear.

---

## 19. The R-3 Class B/C invariants this change owns

Change 5's R-3 ruling distributes eight mandatory invariants. **I-1** (`next_seq > max(seq)` plus
`UNIQUE (w, net, seq)`) is already closed by §17 and migration `008`. **I-5** and **I-7** are
specified here. I-2/I-8 are change 6's, I-3 change 2's, I-4 change 3's, I-6 change 5's.

### 19.1 I-5 — the migration-lineage law

**The property.** Every migration's *first* statement is non-idempotent DDL, and each migration runs
in exactly one transaction. The purpose is Class C detection: a lineage that can be partially
applied and then silently re-entered leaves a schema nobody can distinguish from a correct one.

**Why "first statement" and why "non-idempotent."** The `_migrations` bookkeeping table is the only
record of what has been applied. If a `_migrations` row is lost — corruption, or an interrupted
write — the runner will re-enter an already-applied migration. A non-idempotent first statement
makes that re-entry **fail loudly** (`table … already exists`) instead of silently re-running or
half-applying. The repo already reasons this way: `000_schema.ts:6-9` explains that its
`CREATE TABLE` deliberately omits `IF NOT EXISTS` because the runner's existence check *"is the
actual guard; adding a redundant one here would mask a bug in the check rather than defend against
anything real."* I-5 generalises that one comment into a law over the lineage.

**Second half already holds.** `migrate.ts:252-268` wraps each migration in
`withReservedTransaction`, and SQLite DDL is transactional (L6 measured `DDL inside BEGIN … ROLLBACK`
correctly rolled back), so "exactly one transaction per migration" is preserved rather than
approximated — see §9.1.

**Compliance of the lineage as it now stands:**

| Migration | First statement | Non-idempotent? |
|---|---|---|
| `000_schema` | `CREATE TABLE <s>_migrations` | yes |
| `001` (change 2's) | `CREATE TABLE` — change 2 must comply | yes, by this law |
| `002_checkpoint_store` | `CREATE TABLE <s>_ckpt_chunks` | yes |
| `003_watermarks` | `CREATE TABLE <s>_watermarks` | yes |
| `004_transaction_history` | `CREATE TABLE <s>_transaction_history` | yes |
| `005_kv_current_fillfactor` | **none — recorded no-op (§9.3)** | **exemption, see below** |
| `006_ckpt_chunks_size_bytes` | `ALTER TABLE … ADD COLUMN … STORED` | yes |
| `007_writer_generation` | `CREATE TABLE <s>_writer_generation` | yes (the seed `INSERT` follows, correctly second) |
| `008_ckpt_manifests_seq_unique` | `CREATE UNIQUE INDEX` | yes |
| `009_value_digests` | `ALTER TABLE … ADD COLUMN dg BLOB` | yes |

**The one exemption, and why it does not hole the law.** `005` issues no DDL at all (§9.3), so it
has no first statement to constrain. It is exempt, and the exemption is *safe for a reason specific
to it*: a migration that issues zero statements **cannot be partially applied**, so the failure mode
I-5 defends against is vacuous for it. Re-entering `005` is a no-op by construction.

The exemption must not become a loophole, so the law is enforced in the precise form:

> Every migration that issues DDL SHALL begin with non-idempotent DDL. A migration that issues no
> DDL SHALL be explicitly listed in a no-op registry that the check consults; a migration that
> issues nothing and is **not** in that registry SHALL fail the check.

That way an *accidentally* empty migration — a builder who deletes a statement, or writes a
migration whose body never runs — fails, while the single deliberate no-op passes with its
justification recorded next to it.

**Interaction with the `sqlite_schema` digest (§18).** The digest is recomputed only at the end of a
**successful** `runMigrations`, so a run that fails midway leaves the digest describing the
*previous* schema while the file holds a partially-advanced one. That is the intended detection
signal, but it must be read correctly, and the distinction matters:

- A **partially-applied lineage is detectably partial** by `_migrations` — the applied rows stop
  where the failure did, and the runner resumes from there. That is the designed resume path, not
  corruption.
- A **digest mismatch alone** does not identify *which* migration is missing. The digest says "the
  schema text is not what the last successful run produced"; `_migrations` says which migrations ran.
  Both are needed, and neither substitutes for the other.
- I-5 is what makes the dangerous case loud: if `_migrations` itself is damaged so the two records
  disagree, re-entry hits a non-idempotent first statement and **fails** rather than producing a
  schema that merely digests differently.

### 19.2 I-7 — transaction-history read-path cross-checks, and the answer to change 7's Q-2

**Answering Q-2 first, because the rest depends on it.** Change 7 asks whether `getAll()` reads
`identifiers` from `entry` or from the denormalised representation. **Today it reads the denormalised
column**, verified at `transaction-history-storage.ts:238` (`identifiers: row.identifiers`) with the
rationale stated at `:229-232`: *"`identifiers`/`lifecycle.status` are read from their own
denormalized columns … rather than re-parsed out of the JSONB."* Post-migration that column is gone
and the junction table replaces it (§4), so a literal port would read the **junction**.

Both representations do carry the fact — `StoredEntryJson` (`:160-169`) declares
`identifiers: string[]` and `lifecycle: EntryLifecycle`, so `entry` retains both — which is what
makes derive-and-compare possible at all.

**Ruling: `getAll()`/`get()` SHALL derive `identifiers` from `entry`, and SHALL cross-check the
derived set against the junction rows.** Reasons, in order of weight:

1. **`entry` is the digested representation.** Change 5's `dg` column covers
   `transaction_history.entry` (§19.3). Deriving the returned value from `entry` means the answer
   the caller receives is covered by a value digest; deriving it from the junction means the answer
   is covered by nothing. The junction is a *derived index*, and an index should be **verified, not
   trusted**.
2. **It converts a silent wrong answer into a detected fault.** If the junction is damaged, a
   junction-reading implementation returns wrong identifiers with every digest passing — precisely
   Class B, "wrong row returned", which no per-value digest sees.
3. **It costs nothing extra.** The cross-check must read the junction anyway, so deriving from
   `entry` does not add a query; it only changes which of the two already-fetched representations is
   authoritative.

Note this does **not** make half of I-7 free, contrary to the optimistic reading — because today's
code reads the column, not `entry`. The cross-check is load-bearing under either choice; the ruling
only decides which side is authoritative when they disagree.

**The two cross-checks.**

- **Lifecycle agreement.** The `lifecycle` column stores only the discriminant; `entry.lifecycle` is
  the full object (`004_transaction_history.ts:11-15`). Today `decodeRow` takes the object from the
  JSON (`:244`, `lifecycle: stored.lifecycle`) while the column is selected but never compared —
  so the two can already diverge undetected. On read, the column SHALL equal
  `entry.lifecycle.status`.
- **Identifier derive-and-compare.** The set derived from `entry.identifiers` SHALL equal, as a set,
  the junction rows for that `(wallet_id, tx_hash)`.

A mismatch is a detected corruption, not a validation error: it SHALL surface as a non-retryable
error via the existing catch-all at `:250-260`, which already guarantees a `StorageError` — never a
raw `TypeError` — escapes `get`/`getAll`/`serialize`. The specific code is change 5's catalog
decision, and no new code should be minted without checking the existing one first.

**Set comparison, not sequence comparison**, for the same reason §4.1 gives: identifier semantics
are set semantics, and the junction's `PRIMARY KEY (wallet_id, tx_hash, identifier)` cannot represent
a duplicate. Comparing as ordered lists would raise spurious faults on a re-ordered `entry` array.

### 19.3 The `dg BLOB` digest column — DDL only

Change 5 owns the digest specification (SHA-256, 32 raw bytes, preimage binding, when it is
computed and verified, the `NULL`-means-unverified semantics, and the no-UDF drift-guard trigger's
predicate). **This change owns the DDL and the migration that adds it**, for the wallet-tier tables
only: `kv_event.value`, `watermarks.value`, `transaction_history.entry`. The two archive tables are
change 6's.

Added by a new migration **`009_value_digests`**, whose first statement is
`ALTER TABLE … ADD COLUMN dg BLOB` — non-idempotent, satisfying §19.1. The column is **nullable and
has no default**, which is also what SQLite requires: L6 measured `ADD COLUMN … NOT NULL` with no
default failing outright, and a non-constant default rejected.

**The anti-downgrade trigger (gate G-6) — DDL half.** Change 5's drift-guard trigger is
one-directional: it fires on an update of the covered *column* that leaves `dg` unchanged and does
**not** fire on an update of `dg` alone, so `UPDATE t SET dg = NULL` slips it entirely and
permanently downgrades a row to unverified while touching no covered value. Change 5 owns the
requirement; migration `009` carries the DDL, one trigger per covered table:

```sql
CREATE TRIGGER <s>_<table>_dg_no_downgrade
BEFORE UPDATE OF dg ON <s>_<table>
WHEN NEW.dg IS NULL AND OLD.dg IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'dg downgrade to NULL is not permitted');
END;
```

It uses **no user-defined function**, so it survives a third-party connection that has registered
none. It does not obstruct a legitimate recompute (non-NULL replacing non-NULL), and it cannot
obstruct a backfill, which only ever writes NULL-to-value. The trigger name goes through
`qualify()` for the usual reason — triggers are file-global (§1.4). Whether a NULL `dg` on a
covered row raises `ValueIntegrityError` rather than warning is change 5's ruling, consumed here
and not restated.

Every column and trigger this migration adds obeys this capability's conventions:

- **`qualify()` prefix on the trigger names.** Triggers are file-global (§1.4), so a drift-guard
  trigger named for its table would collide the moment a second `schema` value is used. This is the
  third time that rule has caught a cross-change artifact, after `007` and `008`.
- **`STRICT`** — `BLOB` is one of the six admitted declared types (§2.2), so the column is
  `STRICT`-legal as written.
- **A named `CHECK`** constraining the digest's length:
  `CONSTRAINT <s>_<table>_dg_len CHECK (dg IS NULL OR octet_length(dg) = 32)`. `octet_length`, not
  `length` (§3). The `dg IS NULL OR …` disjunction is what preserves change 5's
  "`NULL` means not-yet-computed" semantics while still constraining every non-NULL value.

`kv_event` is change 2's table; `009` only adds a column to it, and runs after change 2's `001`
creates it. Coordinated, not redefined.
