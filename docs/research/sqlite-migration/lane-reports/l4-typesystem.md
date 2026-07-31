# L4 — Type system and query parity: UmbraDB → SQLite

Lane: `l4-typesystem` · worktree `/root/UDB-sqlite-l4-typesystem` @ `3c0c68b` (cut from `origin/main`)
All measurements: Node **v24.18.0**, built-in `node:sqlite`, **SQLite 3.53.1**, WSL Ubuntu 26.04.

---

## 1. Verdict

**My whole surface moves. There is exactly one hard blocker and one consequential API-semantics
change; everything else is cheaper in SQLite than it is in Postgres.**

- **`jsonb` is a non-issue and I want to say that plainly.** UmbraDB stores and retrieves whole
  documents; it queries *inside* one exactly once, in the deferred chain-archive track. Storing
  the same `JSON.stringify` output in a `TEXT` column round-trips **byte-identically** for every
  shape I tested — large integers, unicode, key order, duplicate keys, depth 64 — which is
  *higher* fidelity than Postgres `jsonb`, a lossy normalizing format. The depth concern in
  `test/postgres/json-depth.test.ts` is an application-level Zod bound (`MAX_JSON_DEPTH = 64`)
  that never touches the engine; SQLite's own limit is 1000, measured.
- **`text[]` + GIN + `<@` is fully reproducible and *faster*.** A junction table
  `(wallet_id, tx_hash, identifier)` with a reverse index runs the identifier-subset pending-clear
  in **0.02 ms** against 200 000 tx / 500 000 identifier rows, versus 93 ms for a naive scan and
  69 ms for a `json_each` column. I reproduced the exact `<@` semantics, verified both directions
  on a fixture, then ran the whole write path end-to-end.
- **The blocker is `ALTER TABLE ... ADD COLUMN ... GENERATED ALWAYS AS (...) STORED`, which SQLite
  refuses outright.** That is literally `migrations/006_ckpt_chunks_size_bytes.ts`. It touches the
  **G4 forward-only migration contract**: a forward-only lineage cannot add a stored generated
  column to an existing table at all. Closeable three ways (VIRTUAL column; plain column + trigger;
  table rebuild) — I recommend VIRTUAL, which is also indexable.
- **Schemas are the consequential finding.** SQLite has none. `DEFAULT_SCHEMA` and
  schema-configurability survive **G1/G2 intact** as a *table-name prefix*, but the word "schema"
  stops meaning namespace isolation and starts meaning naming convention. That is a documentation
  break, not an API break — provided you also prefix index and trigger names, which are global per
  database file (measured).
- **Two silent-behavior-change traps that would otherwise ship undetected:** SQLite's `LIKE` is
  **case-insensitive for ASCII by default**, so `listKeys(prefix)` would start matching keys it
  must not (and would *not* use the index); and `node:sqlite` silently replaces an unpaired UTF-16
  surrogate with U+FFFD instead of rejecting it.
- **On the pre-1.0.0 framing (L6 relay): this lane produces no permanent break.** I independently
  confirmed `docs/STABILITY.md:45` — *"Current version: `0.9.5` — the commitments above are NOT yet
  in force"* — and `package.json` `"version": "0.9.5"`. But the framing barely matters here,
  because **my recommended schema option breaks nothing at all**, pre- or post-tag: `DEFAULT_SCHEMA`,
  its type, and every `schema` constructor parameter survive byte-for-byte. See B2 for the
  per-option pre-tag/post-tag table.

---

## 2. Blockers

Ordered by severity. Each: what Postgres guarantees today, what SQLite offers, and closeability.

### B1. `ALTER TABLE ADD COLUMN ... GENERATED ALWAYS AS (...) STORED` — **not supported**

- **Today:** `migrations/006_ckpt_chunks_size_bytes.ts:16-19` adds
  `size_bytes integer GENERATED ALWAYS AS (octet_length(data)) STORED` to the existing
  `ckpt_chunks`. It backfills every existing row at migration time, and `history()` sums it without
  detoasting the `data` bytea (`checkpoint-store.ts:436-444`, HP-2/IS-2).
- **SQLite:** rejects it — `cannot add a STORED column`. `STORED` generated columns can only be
  declared at `CREATE TABLE`. `VIRTUAL` generated columns **can** be added by `ALTER TABLE`, and
  **can be indexed** (both measured).
- **Gap class:** *closeable with a schema redesign*, at a cost.
  - (a) `VIRTUAL` + an index on it — recommended. `octet_length(data)` is O(1) on a SQLite BLOB
    (the length lives in the record header), so "virtual" costs almost nothing, and an index on the
    virtual column gives a covering scan for `sum(size_bytes)`.
  - (b) plain `INTEGER` column + `BEFORE INSERT/UPDATE` trigger + a one-shot `UPDATE` backfill —
    faithful to `STORED` but reintroduces a trigger and a drift risk the generated column existed
    to eliminate.
  - (c) 12-step table rebuild (`CREATE new; INSERT SELECT; DROP; RENAME`) — copies the entire chunk
    store; unacceptable at chain-archive scale.
- **Frozen commitment touched:** **G4 contract section 2, forward-only migration**
  (`docs/CONTRACT.md:39-53`). The `Migration.up()`-only shape survives; what does not survive is the
  *assumption* that any column Postgres can add forward, SQLite can too. A greenfield SQLite lineage
  would just fold 006 into 002 — but that is only available for a fresh database, and the contract
  explicitly contemplates migrating an existing one.

### B2. `CREATE SCHEMA` + `search_path` become nothing. `DEFAULT_SCHEMA` changes meaning.

- **Today:** `000_schema.ts:13` does `CREATE SCHEMA IF NOT EXISTS <schema>`; every migration and
  query is schema-qualified via `sql(schema)`; `client.ts:14` exports `DEFAULT_SCHEMA = "umbradb"`;
  `createClient` sets `search_path` and attaches `umbradbSchema` to the returned `Sql`
  (`client.ts:172-192`); every adapter defaults its `schema` constructor parameter to
  `sql.umbradbSchema`. `index.ts:40` re-exports `DEFAULT_SCHEMA` — **frozen G1 surface**.
- **SQLite:** only `main`, `temp`, and `ATTACH`ed aliases, which are separate *files*. There is no
  `SET search_path` (measured: syntax error). `SQLITE_MAX_ATTACHED = 10`.
- **Options, costed:**

  | Option | G1 (surface) | Cost if landed **pre-1.0.0 tag** | Cost if landed **post-tag** | Isolation actually delivered |
  |---|---|---|---|---|
  | **(a) table-name prefix** `umbradb_watermarks` | **unchanged** — same symbol, same type, same ctor params | **nothing** (doc/CHANGELOG note only) | **nothing** — it is not a break at all | naming only: one file, one lock, one WAL, no `DROP SCHEMA` |
  | (b) one file per schema + `ATTACH` | unchanged | nothing | nothing to the *surface*; but the G4 backup/restore contract now covers N files, which is a doc break | real: separate files, separate index/trigger namespaces, atomic cross-file txns (measured) — **but foreign keys cannot cross files** (measured), and at most 10 attached databases plus `main` |
  | (c) drop schema configurability | **removes `DEFAULT_SCHEMA` + a ctor param** | CHANGELOG entry (commitments not yet in force) | **major version** | n/a |

- **Is any of this a *permanent* break, independent of tag timing?** No — and that is the key
  finding for the coordinator's question. Option (c) is the only true surface break, and it is
  **entirely avoidable**: option (a) delivers the same SQLite schema-less reality while keeping every
  exported symbol. So the honest answer is not "the parameter becomes meaningless and something has
  to give" — it is **"the parameter keeps working, and only its documented meaning narrows."** A
  caller in the wild already passing `schema: "tenant_a"` continues to compile, continues to run,
  and continues to get its own separate set of tables; what it stops getting is `DROP SCHEMA`-style
  teardown and per-schema locking. That is a capability change disclosed in the CHANGELOG, not a
  signature change. **I would push back on any lane concluding this forces a 2.0.0.**
- **Where the pre-tag window *does* buy something real:** it is B1 (the forward-only migration
  capability) that benefits most. Pre-tag, migration 006 can simply be **folded into 002** and the
  whole `ALTER TABLE ADD STORED` problem evaporates, because no released database needs migrating
  forward. Post-tag, the VIRTUAL-column workaround becomes mandatory forever. **If the SQLite move
  is going to happen, doing it before the 1.0.0 tag is worth real engineering money — and that
  saving is in B1, not B2.**

- **Recommendation: (a).** It is the only option free under both G1 and G2. Option (b) is tempting
  and *does* give genuine isolation, but every UmbraDB lineage has internal foreign keys
  (`ckpt_manifest_chunks` to `ckpt_manifests`/`ckpt_chunks`, `chain_blob_roles` to `chain_blobs`),
  and SQLite rejects a `REFERENCES` naming another database (measured: syntax error at the dot). So
  (b) only works if each *lineage* is one file — coincidentally true today (tier-1 wallet and
  chain-archive are already separate lineages in separate schemas), worth revisiting as an L5 scale
  decision, but it is not a general schema mechanism.
- **Non-obvious consequence of (a), measured:** **index and trigger names are global per database
  file.** Creating `dup_name` on two different tables fails (`index dup_name already exists`); same
  for triggers. Every index and trigger name in every migration must be prefixed too. Today
  `002_checkpoint_store.ts:40` creates a bare `ckpt_manifests_lookup`, `004:40` a bare
  `transaction_history_identifiers_gin`, etc. Under Postgres those are schema-scoped and two schemas
  coexist; under SQLite prefixing they collide.
- **Gap class:** *closeable in application code* (prefix everything), with a **documentation-level
  semantic weakening** that must be named: the `schema` parameter no longer isolates, it only names.
  Two "schemas" in one SQLite file share a single writer lock and a single WAL — an L2/L3
  concurrency consequence, flagged not researched here.
- **Bonus: code deleted.** `search_path` disappearing removes `assertNoConflictingSearchPath`
  (`client.ts:113-135`, an entire audit-driven DSN hazard), the `set search_path` /
  `reset search_path` dance in `migrate.ts:236,273`, and the 63-byte `NAMEDATALEN` bound in
  `assertValidSchemaName` (`client.ts:31-41`) becomes vestigial. Net negative LOC.

### B3. `listKeys` — `LIKE` is case-insensitive by default in SQLite

- **Today:** `temporal-kv.ts:317-323` builds `escapeLikePrefix(prefix) + "%"` and runs
  `key LIKE <escaped> ESCAPE backslash`. Postgres `LIKE` is case-sensitive.
- **SQLite:** measured — `LIKE 'ab%'` returns `["Abc","aBc","ab","abc","abcd","abd"]`. It matches
  `Abc`. **And** `EXPLAIN QUERY PLAN` shows it does *not* use the key column for the index range
  (`SEARCH kv USING PRIMARY KEY (ns=? AND scope=?)`) — it scans every key in the `(ns, scope)`
  group. Both wrong and slow.
- **Gap class:** *closeable in application code*, cleanly. Replace the LIKE with a **range scan**
  `key >= :prefix AND key < :prefixUpper`. Measured: correct (`["ab","abc","abcd","abd"]`),
  case-sensitive, uses the index
  (`SEARCH kv USING PRIMARY KEY (ns=? AND scope=? AND key>? AND key<?)`). It also deletes
  `escapeLikePrefix` entirely — no metacharacters, no `ESCAPE`.
- **This is already sanctioned by the frozen interface.** `src/interfaces/temporal-kv.ts:314-321`
  says the prefix must be matched as a *literal* string prefix and explicitly offers "a
  non-pattern-based range comparison instead" as an allowed implementation. No G1/G2 issue.
- `PRAGMA case_sensitive_like=ON` also fixes both (measured), but it is connection-global and would
  change semantics for any other consumer of the same handle — the range form is strictly better.

### B4. NUL and lone surrogates: keep the guard, for a *different* reason

- **Today:** `hasPostgresUnsafeText` (`interfaces/temporal-kv.ts:35-37`) rejects NUL and unpaired
  UTF-16 surrogates because Postgres `text`/`jsonb` cannot store them — it fails loudly.
- **SQLite, measured:**
  - **NUL:** *accepted and stored*. A string `x<NUL>y` round-trips through `node:sqlite` intact
    (`hex(v) = 780079`, JS string length 3, `equal_to_input: true`) — but `length(v)` returns **1**.
    Every SQL-side string function silently truncates at the first NUL. (Accidentally corroborated:
    my own `e4_misc.mjs` collation fixture contained a real NUL byte, and SQLite stored, indexed
    and sorted it without complaint.)
  - **Lone surrogate:** *silently corrupted*. `x\uD800y` comes back as bytes `78 EF BF BD 79` —
    U+FFFD. `equal_to_input: false`.
- **Gap class:** *not a gap — the guard must be kept, and its rationale strengthened.* Postgres's
  loud rejection is the safe failure; SQLite's silent acceptance/replacement is the dangerous one.
  Rename `hasPostgresUnsafeText` internally (it is **not** exported from `index.ts`, so this is free
  under G1) and change its doc string. Do not relax it.

### B5. Bind-parameter ceiling is **half** what the code assumes

- **Today:** `checkpoint-store.ts:62-63` sets `CHUNK_INSERT_MAX_ROWS = 30_000` (2 params/row =
  60 000 params) and `JUNCTION_INSERT_MAX_ROWS = 20_000` (3 params/row = 60 000 params), derived
  from postgres.js's 65 534 limit.
- **SQLite:** `SQLITE_MAX_VARIABLE_NUMBER = 32766` (measured from `pragma compile_options`, and
  confirmed by a 40 000-parameter statement failing with `too many SQL variables`). Both current
  caps **exceed** it. Ceilings would become 16 383 and 10 922.
- **Gap class:** *closeable in application code, and the whole mechanism can be deleted.*
  - Junction rows: **`json_each`, one bind parameter** — measured 50 000 junction rows inserted by
    a single statement with a single parameter. This is the direct `unnest(...)` replacement.
  - Chunk `data` rows: **prepared-statement loop inside the transaction** — measured 50 000 rows in
    **22 ms**. Do *not* route 4 MiB blobs through JSON.
  - The entire V8 `MAX_STRING_LENGTH` hazard the 60-line comment at `checkpoint-store.ts:36-61`
    documents **disappears**: `node:sqlite` binds a `Buffer` as a native BLOB with no text
    serialization step.
- **Independently reached by L3; we agree on the number (32766) and on which two constants break.**
  One correction to the coordinator's framing, though: **the junction table does not multiply the
  parameter count.** The identifier insert is
  `INSERT ... SELECT :w, :h, value FROM json_each(:ids)` — **three bind parameters total,
  independent of how many identifiers the entry has** (measured: 50 000 rows through one statement
  with one JSON parameter). A junction table multiplies *rows*, not *parameters*, precisely because
  `json_each` replaces the per-row `VALUES` tuple. The parameter ceiling is therefore not a
  constraint on the B-block design at all; it is only a constraint on the two existing
  `checkpoint-store.ts` batch loops, which should be rewritten to the same `json_each` shape
  (junction) or a prepared loop (chunk blobs).

### B6. `FOR UPDATE` — does not exist

- `SELECT ... FOR UPDATE` is a syntax error (measured). Used at
  `transaction-history-storage.ts:465` and in the chain-archive plpgsql guards
  (`001_chain_archive_core.ts:191,667`).
- **Gap class:** *closeable*, and probably already closed by L2. UmbraDB is single-writer;
  `BEGIN IMMEDIATE` (measured to exist) takes the database write lock for the whole transaction,
  which is strictly *stronger* than a row lock. The `pg_advisory_xact_lock` at
  `transaction-history-storage.ts:458` — which exists precisely because `FOR UPDATE` cannot lock a
  not-yet-existing row — becomes unnecessary for the same reason. **Dependency on L2:** this
  assumes L2 confirms writers are serialized by `BEGIN IMMEDIATE`, not by an optimistic scheme.

### B7. `fillfactor` — no equivalent, and no longer needed

- `003_watermarks.ts:27` and `005_kv_current_fillfactor.ts:21` set `fillfactor = 90` for HOT
  updates, and both files declare a **hard invariant: never add an index on the non-PK columns**,
  because that would break HOT eligibility.
- SQLite has no MVCC row versioning and no HOT concept; an `UPDATE` rewrites the row in place where
  it fits, and there is no index-bloat-from-non-HOT-update failure mode.
- **Gap class:** *not a gap.* Migration 005 becomes a no-op and both hard invariants can be
  **retired**, which is a genuine freedom gain (e.g. `watermarks.updated_at` becomes indexable).
  Caveat for L3/L5: high-frequency small updates instead pressure **WAL growth and checkpointing** —
  a different problem, not mine.

### B8. `to_regclass` bootstrap detection maps to `sqlite_schema`

- `migrate.ts:240-242` uses `select to_regclass(<schema>._migrations) is not null`.
- Direct equivalent, measured working on a cold database (returns 0, never an error):
  `SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?)`. Qualified per
  attached alias as `other.sqlite_schema` if option (b) is ever chosen.
- **Gap class:** *closeable in application code*, one line.

### B9. Chain-archive watermark guard — the only real in-JSON query

- `chain-archive-store.ts:529-537` is the **single** place UmbraDB reads inside a JSON document: a
  conditional upsert guarding against watermark regression, using
  `jsonb_typeof(w.value -> 'height')` and `(EXCLUDED.value ->> 'height')::numeric`.
- Reproduced and **measured working** in SQLite with `json_type` / `json_extract` and
  `ON CONFLICT ... DO UPDATE ... WHERE` (advance 10 to 20 applied; regress to 5 dropped; equal 20
  dropped; non-`height` shape falls through to last-write-wins — all four match the PG intent).
- **One faithfulness trap I hit and must flag:** Postgres `jsonb_typeof` returns `'number'` for both
  integers and reals; SQLite `json_type` distinguishes `'integer'` from `'real'` (measured:
  `json_type` of `{"height":20.5}` at `$.height` is `'real'`). The predicate must be
  `json_type(...) IN ('integer','real')`, not `= 'integer'`, or a fractional height silently
  degrades to last-write-wins.

### B10. `STRICT` and L3's declared-type-name shim are **mutually exclusive as proposed** — resolved

This is a direct cross-lane conflict, so it gets its own entry. **L3 recommends a `postgres.js`-shaped
shim that reproduces type-driven row decoding by reading each column's declared type name verbatim
from `StatementSync.columns()` (`JSONB`, `BYTEA`, `TIMESTAMPTZ`).** I recommend `STRICT` on every
table. **These cannot both be done**, and I measured exactly why:

```
$ wsl -e bash -lc 'cd /tmp/l4 && node e10_columns.mjs'
non-STRICT columns(): [{"n":"a","t":"JSONB"},{"n":"b","t":"BYTEA"},{"n":"c","t":"TIMESTAMPTZ"},
                       {"n":"d","t":"BIGINT"},{"n":"e","t":"TEXT"}]      <- L3's mechanism works
FAIL  STRICT with declared type JSONB       -> unknown datatype for s1.a: "JSONB"
FAIL  STRICT with declared type BYTEA       -> unknown datatype for s2.a: "BYTEA"
FAIL  STRICT with declared type TIMESTAMPTZ -> unknown datatype for s3.a: "TIMESTAMPTZ"
FAIL  STRICT with declared type BIGINT      -> unknown datatype for s4.a: "BIGINT"
STRICT columns(): [{"n":"a","t":"TEXT"},{"n":"b","t":"BLOB"},{"n":"c","t":"INTEGER"},{"n":"d","t":"ANY"}]
```

`STRICT` admits only `INT`/`INTEGER`/`REAL`/`TEXT`/`BLOB`/`ANY`. So under `STRICT` the declared type
name collapses `jsonb` and `text` into one name (`TEXT`), and `timestamptz` and `bigint` into another
(`INTEGER`) — the two distinctions the decoder actually needs.

**Resolution, and it costs nothing: key the shim's type map on `columns()`'s *origin* metadata
instead.** `columns()` returns `{database, table, column, name, type}`, and I measured that the
origin `table`/`column` **survive aliasing**:

```
$ wsl -e bash -lc 'cd /tmp/l4 && node e11_origin.mjs'
select entry as e from t        [{"column":"entry","database":"main","name":"e","table":"t","type":"TEXT"}]
select t.entry from t           [{"column":"entry",...,"table":"t","type":"TEXT"}]
select sum(ts) from t           [{"column":null,"database":null,"name":"sum(ts)","table":null,"type":null}]
select octet_length(data) as size_bytes from t
                                [{"column":null,...,"name":"size_bytes","table":null,"type":null}]
```

So a static `(table, column) -> decoder` registry — derivable mechanically from the migration DDL,
roughly 40 lines of data — gives the shim everything the declared type name would have, **with no
call-site changes, which is L3's actual goal**. Computed expressions return `table: null`, but they
also return `type: null`, so L3's mechanism fails on them identically — no regression. And UmbraDB's
computed columns (`sum(size_bytes)`, `count(*)`, `octet_length(...)`, `next_seq - 1`) are all plain
numbers needing no decoding.

**Recommendation to the coordinator: keep `STRICT`, and have L3's shim key on origin metadata.**
Dropping `STRICT` to preserve cosmetic type names would trade real, measured type safety (§3.1: a
non-STRICT `INTEGER` column silently accepts the string `"notanint"`) for a mapping mechanism that
has an equally good alternative. If L3 disagrees, the fallback is non-STRICT tables with PG-shaped
type names — workable, but it forfeits the single best defense SQLite offers against its own dynamic
typing, on a datastore whose whole value proposition is durability.

---

## 3. Evidence

Scripts are in `/tmp/l4/` (WSL). Verbatim commands and output below.

### 3.1 `STRICT` + generated columns + `WITHOUT ROWID` + `CHECK` — all compatible

```
$ wsl -e bash -lc 'cd /tmp/l4 && node e1_strict.mjs'
sqlite_version: 3.53.1
node: v24.18.0
OK    STRICT table
FAIL  STRICT rejects text into INTEGER -> datatype mismatch                    <- desired rejection
OK    non-STRICT accepts text into INTEGER [{"t":"text","a":"notanint"}]       <- the affinity trap
OK    STRICT + GENERATED STORED
OK    STRICT + GENERATED STORED insert+read [{"size_bytes":5,"t":"integer"}]
OK    STRICT + WITHOUT ROWID
OK    STRICT + WITHOUT ROWID + GENERATED STORED (all three)
OK    all-three insert + read back [{"hl":32,"size_bytes":7,"t":"integer"}]
OK    CHECK length(blob)=32
FAIL  CHECK rejects short blob -> CHECK constraint failed: length(hash) = 32   <- desired
OK    CHECK accepts 32-byte blob "inserted"
--- length() semantics ---
  blob_4bytes: 4, text_hello_chars: 5, text_hello_bytes: 6,
  octet_len_text: 6, octet_len_blob: 4, blob_with_embedded_nul: 5
OK    multi-column CHECK (scope='contract')=(addr IS NOT NULL)
FAIL    reject protocol+address      -> CHECK constraint failed  <- desired, BOTH directions
FAIL    reject contract+null-address -> CHECK constraint failed
OK      accept protocol+null / accept contract+address
FAIL    reject finalized w/o canonical -> CHECK constraint failed: NOT finalized OR is_canonical
OK      accept finalized+canonical
FAIL    reject enum value 'bogus' -> CHECK constraint failed: scope IN ('protocol','contract')
OK    UNIQUE with NULL treated distinct (PG default)  <- SQLite matches PG default, NOT NULLS NOT DISTINCT
OK    UNIQUE on expression coalescing NULL -> second correctly rejected
FAIL  STRICT rejects unknown type name 'jsonb' -> unknown datatype for t9.a: "jsonb"
OK    STRICT allows ANY
```

**Answers charter Q4/Q6.** All three features compose. Every constraint form in the repo transfers
identically: `CHECK (octet_length(hash)=32)`, the enum-style `CHECK (x IN (...))`, the multi-column
biconditional `CHECK ((scope='contract') = (contract_address IS NOT NULL))` from
`001_chain_archive_core.ts:546`, and `CHECK (NOT finalized OR is_canonical)` from `:273` — with
booleans stored as `INTEGER` + `CHECK (x IN (0,1))` under `STRICT`.

**`length()` on BLOB vs TEXT, confirmed:** `length(blob)` is **bytes**; `length(text)` is
**characters** (`héllo` is 5 chars but 6 bytes). `octet_length()` exists (3.43+) and returns bytes
for both. **Use `octet_length(data)`, not `length(data)`**, in the generated column — it is literally
the same function name as the Postgres original and is affinity-proof.

**`UNIQUE NULLS NOT DISTINCT`** (`001_chain_archive_core.ts:570`) has no direct equivalent — SQLite's
`UNIQUE` matches Postgres's *default* (NULLs distinct). Emulated with a unique index over
`coalesce(col, <sentinel>)`, measured rejecting the duplicate correctly.

### 3.2 JSON fidelity — the `jsonb` question

```
$ wsl -e bash -lc 'cd /tmp/l4 && node e2_json.mjs'
=== TEXT-column JSON round trip (store the string, no json() call) ===
  roundtrip[bigint-as-string]     byte-identical=true
  roundtrip[large-number]         byte-identical=true
  roundtrip[unicode]              byte-identical=true
  roundtrip[dupkeys...]           byte-identical=true
  roundtrip[key-order]            byte-identical=true
  roundtrip[empty]                byte-identical=true
  roundtrip[nested-64]            byte-identical=true

=== what json()/jsonb() normalization DOES change ===
 json('{"z":1,"a":2}')  = {"z":1,"a":2}     <- key ORDER PRESERVED (PG jsonb reorders)
 json('{"a":1,"a":2}')  = {"a":1,"a":2}     <- duplicates PRESERVED (PG jsonb keeps last only)
 json('  {"a" : 1 }  ') = {"a":1}           <- whitespace stripped
FAIL json_extract of >2^53 int -> Value is too large to be represented as a JavaScript number
OK   jsonb() -> json() round trip preserves text {"identical":true}
OK   jsonb column size {"text_bytes":82,"jsonb_bytes":73}

=== JSON depth limit ===
  {"n":64,  "json_valid":1,"json_ok":true,"jsonb_ok":true,"extract_ok":true}
  {"n":999, "json_valid":1,...}
  {"n":1000,"json_valid":1,...}
  {"n":1001,"json_valid":0,"json_err":"malformed JSON","jsonb_err":"malformed JSON",...}
  {"n":2000,"json_valid":0,...}

=== NUL byte + lone surrogate in TEXT ===
OK    store NUL in TEXT {"readback_len":1,"hex":"780079","js_len":3,"equal_to_input":true}
OK    store lone surrogate {"hex":"78EFBFBD79","equal_to_input":false,"codeunit":"fffd"}
```

**What UmbraDB actually does with `jsonb` — verified by grep, not assumed:**

```
$ grep -rnE 'entry ->|value ->|->>|jsonb_|json_path|@>|#>' src/
src/postgres/chain-archive-store.ts:534-536   <- the ONLY in-JSON query (see B9)
src/postgres/temporal-kv.ts:254               <- validity @> timestamptz, a RANGE op (L1's), not jsonb
```

Every other use is whole-document: `watermarks.ts:79` writes `sql.json(value)` and `:106` selects
`value` entire; `temporal-kv.ts:110,118-124` likewise; `transaction-history-storage.ts:499` writes
`sql.json(encodeStoredEntry(result))` and `decodeRow` (`:233-249`) parses the whole thing back.
`004_transaction_history.ts:11-15` states outright that `identifiers`/`lifecycle` were denormalized
**out** of the JSONB specifically to avoid a JSONB path scan.

**Therefore: store JSON in a plain `TEXT` column. Do not call `json()`/`jsonb()` on the write path.**
Round-trip is byte-identical for every real stored shape. This is *higher* fidelity than Postgres
`jsonb`, which reorders keys, discards duplicate keys and strips whitespace.

**Depth:** SQLite's limit is exactly **1000** (1000 parses; 1001 gives `malformed JSON`), versus
UmbraDB's application bound of 64 (`interfaces/temporal-kv.ts:59`). And because nothing calls a JSON
function on the store path, the engine limit is never even reached. `json-depth.test.ts` pins
`MAX_JSON_DEPTH === 64`, the Zod accept/reject boundary, and — its most interesting assertion — that
an over-deep value fails with `ValidationError` **against an unreachable server**, i.e. no statement
is issued (`json-depth.test.ts:54-66`). All of that is backend-independent and survives verbatim.
**This is a non-issue.** Note only that `nest(20_000)` (`:51`) overflows `JSON.stringify` itself in
Node before any driver is involved — the test passes because the iterative guard at
`interfaces/temporal-kv.ts:65-77` short-circuits first, which is exactly what it claims.

**Large integers:** safe *as stored*, because the bigint encoding at
`transaction-history-storage.ts:49,186` already tags them as decimal **strings**. But if anyone ever
reaches into JSON with `json_extract`, `node:sqlite` throws `Value is too large to be represented as
a JavaScript number` for an integer above 2^53 in default number mode (measured). A reason to keep
the string tagging, not to change it.

**Compile options** (measured, `pragma compile_options`): `MAX_VARIABLE_NUMBER=32766`,
`MAX_COMPOUND_SELECT=500`, `MAX_EXPR_DEPTH=1000`, `MAX_ATTACHED=10`, `MAX_LENGTH=1000000000`,
`ENABLE_FTS5`, `ENABLE_RTREE`, `THREADSAFE=1`, `TEMP_STORE=1`.

### 3.3 `text[]` + GIN + `<@` — semantics, then performance

**The semantics, stated precisely.** `identifiers <@ S` is **contained-by**: every element of the
row's `identifiers` is in `S`. Postgres array containment is *set* semantics — duplicates and order
are ignored (documented behavior; **citation, not a measurement** — no live Postgres was reachable
in this environment). Combined with `array_length(identifiers, 1) > 0`
(`transaction-history-storage.ts:521`), the DELETE predicate is:

> delete a pending row iff its identifier set is **non-empty** and is a **subset** of the finalizing
> entry's identifier set.

It is *not* `@>` (contains). I tested both directions on a fixture to prove they differ:

```
$ wsl -e bash -lc 'cd /tmp/l4 && node e3_containment.mjs'
populated 200000 tx rows, 500000 identifier rows in 2826ms
db size: 75808768 bytes

=== <@ semantics fixture (row subset-of S) ===   S = ["a","b"]
  row SUBSET-OF S (PG: identifiers <@ S, non-empty) -> ["dup-in-row","equal","subset"]
  row SUPERSET-OF S (PG: identifiers @> S)          -> ["equal","superset"]
```

Fixture rows were `empty:[]`, `subset:[a]`, `equal:[a,b]`, `superset:[a,b,c]`, `disjoint:[z]`,
`overlap:[b,z]`, `dup-in-row:[a,a]`. The subset result correctly **excludes** `empty` (the non-empty
guard), `disjoint`, `overlap` and `superset`, and correctly **includes** `dup-in-row` (set
semantics). The superset result is a different set entirely — the two directions are demonstrably
not interchangeable.

**Performance, 200 000 tx / 500 000 identifiers:**

```
=== junction-table pending-clear DELETE ===
  EXPLAIN QUERY PLAN (naive)
    SEARCH t USING PRIMARY KEY (wallet_id=?)          <- scans the whole wallet
    ...
  naive result: 2 rows in 106ms
  EXPLAIN QUERY PLAN (index-driven candidate generation)
    SEARCH t USING PRIMARY KEY (wallet_id=? AND tx_hash=?)
    LIST SUBQUERY 1
    SCAN s VIRTUAL TABLE INDEX 1:
    SEARCH i USING COVERING INDEX th_identifiers_by_identifier (wallet_id=? AND identifier=?)
    ...
  index-driven result: 2 rows in 0ms
  naive       : 93.25ms avg over 5 runs (2 rows)
  index-driven:  0.02ms avg over 20 runs (2 rows)

=== json_each on an identifiers TEXT column (no junction table) ===
    SEARCH t USING PRIMARY KEY (wallet_id=?)
    CORRELATED SCALAR SUBQUERY 2 / SCAN e VIRTUAL TABLE
  json_each   : 68.54ms avg over 3 runs (2 rows)
```

**The four options, compared:**

| Option | Correct? | Index-usable? | Measured | Verdict |
|---|---|---|---|---|
| **Junction table + reverse index** | yes | **yes** (covering) | **0.02 ms** | **recommended** |
| JSON array column + `json_each` | yes | no — `json_each` is a virtual table, unindexable | 68.5 ms | rejected |
| Serialized blob + app-side scan | yes | no | strictly worse than the above | rejected |
| FTS5 | available (`ENABLE_FTS5` measured) | yes, but it is a *token-match* index | not benchmarked | **rejected on semantics**: FTS5 answers "contains token", i.e. the `@>` direction. Subset is a *universal* over the row's tokens, which no inverted index answers directly. Using it would mean generate-candidates-then-verify — exactly what the junction table already does, with a tokenizer's escaping hazards added. |

**Key insight the index-driven form encodes:** a row can only be a subset of `S` if it shares at
*least one* element with `S`. So drive candidate generation off `identifier IN S` through the reverse
index, then apply the universal filter to the (tiny) candidate set. That is the same two-phase shape
GIN uses internally.

**The write path changes.** The single
`ON CONFLICT ... DO UPDATE SET ... identifiers = EXCLUDED.identifiers`
(`transaction-history-storage.ts:494-507`) becomes three statements in one transaction:
upsert-entry, delete-identifiers, insert-identifiers. Exercised end-to-end:

```
$ wsl -e bash -lc 'cd /tmp/l4 && node e7_writepath.mjs'
FTS5 available: true
=== full write path ===
 p1 pending [a] / p2 pending [a,b] / p3 pending [a,b,c] / p4 pending []
 p5 pending [z] / p6 pending [b,z] / other wallet w2:p1 pending [a]

 F1 finalized [a,b] -> should clear exactly p1,p2
   {"upserted":{"tx_hash":"F1","lifecycle":"finalized"},"cleared":["p1","p2"]}
  surviving w1 rows: [F1 finalized, p3 pending, p4 pending, p5 pending, p6 pending]
  surviving w2 rows: [p1]                                  <- other wallet untouched
  identifier rows for cleared p1/p2 (CASCADE): { c: 0 }    <- ON DELETE CASCADE fired

 empty-identifier finalize must clear NOTHING:
   {"cleared":[]}   surviving: ["F1","F2","p3","p4","p5","p6"]

=== re-write with a SHRUNK identifier set ===
  p3 identifiers now: ["c"]                                <- delete+reinsert is correct
```

Every rule holds: subsets cleared, superset/overlap/disjoint/empty spared, self excluded, other
wallets untouched, cascade fires, shrinking an identifier set does not leave orphans.

### 3.4 Upsert, `RETURNING`, identity, `sqlite_schema`, collation, batching

```
$ wsl -e bash -lc 'cd /tmp/l4 && node e4_misc.mjs'
=== 1. ON CONFLICT ... DO UPDATE + excluded. + RETURNING, composite key ===
OK  first claim (INSERT branch) returns 1   {"claimed_seq":1}
OK  second claim (UPDATE branch) returns 2  {"claimed_seq":2}
OK  third claim returns 3                   {"claimed_seq":3}
OK  different key restarts at 1             {"claimed_seq":1}
OK  excluded.<col> works / EXCLUDED uppercase also works
OK  DO NOTHING + RETURNING on conflict returns zero rows   <- matches PG
OK  DO NOTHING + RETURNING on insert returns the row
OK  qualified-table reference in DO UPDATE SET (PG's table.col form)

=== 2. RETURNING on DELETE / UPDATE ===
OK  DELETE ... RETURNING expr [{"id":4,"reclaimed_bytes":40},{"id":5,"reclaimed_bytes":50}]
OK  UPDATE ... RETURNING
OK  DELETE ... RETURNING with correlated NOT EXISTS (prune shape) [{"reclaimed_bytes":200}]
OK  RETURNING inside an UPSERT that fires a trigger {"returned":{"v":2},"log":[{"k":"a","v":1}]}

=== 3. Identity / AUTOINCREMENT ===
FAIL AUTOINCREMENT on WITHOUT ROWID -> AUTOINCREMENT not allowed on WITHOUT ROWID tables
OK   AUTOINCREMENT + STRICT      <- compatible
OK   rowid alias REUSES ids after delete-of-max [{"id":1},{"id":2},{"id":3,"x":"after"}]
OK   AUTOINCREMENT never reuses  [{"id":1},{"id":2},{"id":4,"x":"after"}]
OK   explicit id insert can go BACKWARDS: ai=[1,2,4,2000], ra=[-5,1,2,3]

=== 4. Bootstrap detection ===
OK  to_regclass equivalent {"ex":0}   (cold db: 0, never an error)
OK  ATTACH: cross-database transaction spans both {"other_rows":1,"probe":1}

=== 5. Collation ===
  SQLite BINARY ORDER BY : ["0","A","Ab","B","Z","_x","a",...,"b","z","~","e-acute"]
  JS codeunit sort       : ["0","A","Ab","B","Z","_x","a",...,"b","z","~","e-acute"]   <- identical
  LIKE case-insensitive by default: {"like_A_matches_a":1,"glob_A_matches_a":0,"after_pragma":0}

=== 6. FOR UPDATE ===
FAIL SELECT ... FOR UPDATE -> near "FOR": syntax error
OK   BEGIN IMMEDIATE exists

=== 7. batch insert forms ===
OK   multi-row VALUES 500 rows (1000 params)
FAIL multi-row VALUES 20000 rows (40000 params) -> too many SQL variables
OK   json_each-driven insert (unnest replacement, ONE bind param) {"c":50000}
OK   prepared-statement loop, 50000 rows, one tx {"ms":22,"c":50000}
```

**Everything charter Q7 asked about, answered:** `ON CONFLICT DO UPDATE` works with composite keys,
`excluded.` in either case, and a table-qualified reference in `SET`. `RETURNING` works on upsert
(both branches, including the `RETURNING next_seq - 1 AS claimed_seq` expression form used at
`checkpoint-store.ts:244`), on `DELETE` with an expression and a correlated `NOT EXISTS` (the exact
`prune` shape at `checkpoint-store.ts:518-525`), and on `UPDATE`. `DO NOTHING` + `RETURNING` returns
zero rows on conflict — precisely what `temporal-kv.ts:131-137`'s `expectedVersion === 0n` branch
depends on.

**Identity, Q5.** `AUTOINCREMENT` is **incompatible with `WITHOUT ROWID`** (measured) but
**compatible with `STRICT`**. A plain `INTEGER PRIMARY KEY` rowid alias **reuses** the id of a
deleted maximum row (measured: 1,2,3, delete 3, next insert is 3 again). `AUTOINCREMENT` does not
(gives 4). Since `prune()` deletes `ckpt_manifests` rows, that reuse is reachable, so
`bigserial`/`GENERATED ALWAYS AS IDENTITY` should map to `INTEGER PRIMARY KEY AUTOINCREMENT`.
**Is monotonicity relied upon?** Not on `ckpt_manifests.id` — the caller-visible monotonic value is
`seq`, and it is *application-managed* by the `ckpt_sequence_counters` upsert-increment
(`checkpoint-store.ts:239-246`), which I reproduced exactly (1, 2, 3, per-key restart at 1). Neither
PG nor SQLite enforces monotonicity against an explicit id insert — both accept a backwards jump
(measured for both SQLite forms).

**Collation.** SQLite's default `BINARY` is byte order, identical to a JS code-unit sort (measured).
Postgres's `ORDER BY key` uses the database's `lc_collate` (commonly `en_US.UTF-8`, which is *not*
codepoint order); only `C`/`ucs_basic` matches SQLite. **`listKeys`'s frozen contract only promises
"a stable order for resumable pagination"** (`interfaces/temporal-kv.ts:314`), not a named collation,
so BINARY is compliant. The residual risk is a *consumer* that persisted a resume cursor under
Postgres ordering and resumes under SQLite ordering — flagged as an open question.

### 3.5 Generated columns, partial indexes, foreign keys, namespacing

```
$ wsl -e bash -lc 'cd /tmp/l4 && node e5_migrate.mjs'
=== A. migration 006 shape ===
FAIL  ALTER TABLE ... ADD COLUMN ... GENERATED ALWAYS AS (...) STORED -> cannot add a STORED column
OK    ALTER TABLE ... ADD COLUMN ... GENERATED ALWAYS AS (...) VIRTUAL {"size_bytes":77,"t":"integer"}
OK    VIRTUAL generated column can be indexed
        [{"detail":"SEARCH ck USING INDEX ck_by_size (size_bytes>?)"}]
OK    octet_length() usable in a STORED generated column at CREATE time {"size_bytes":77}
FAIL  generated column may not contain a subquery -> subqueries prohibited in generated columns

=== B. sum() over a generated column ===
OK    sum(size_bytes) {"s":189077,"t":"integer","c":19}

=== C. Partial + expression indexes ===
OK    partial UNIQUE index WHERE is_canonical
OK      second canonical correctly rejected: UNIQUE constraint failed: blocks.net, blocks.height

=== D. Foreign keys ===
OK    composite FK + ON DELETE CASCADE {"junction_rows_after_cascade":0}
FAIL  FK to a non-existent chunk -> FOREIGN KEY constraint failed     <- desired

=== E. Table-prefix vs ATTACH namespacing ===
OK    prefixed table names ["umbradb_watermarks","tenant_a_watermarks"]
FAIL  SET search_path = umbradb -> near "SET": syntax error
FAIL  index names are GLOBAL per database file -> index dup_name already exists
FAIL  trigger names likewise global -> trigger tn already exists
OK    ...but index names ARE per-ATTACHed-database
FAIL  cross-ATTACH foreign key -> near ".": syntax error
```

```
$ wsl -e bash -lc 'cd /tmp/l4 && node e6_rowid.mjs'   (foreign-key default)
  default PRAGMA foreign_keys = { foreign_keys: 1 }
  with enableForeignKeyConstraints:false = { foreign_keys: 0 }
```

Note: raw SQLite defaults `foreign_keys` **off**; `node:sqlite` turns it **on** by default. Under a
different driver that is a silent-data-loss trap (`ON DELETE CASCADE` at `002_checkpoint_store.ts:58`
becomes inert). **Dependency on L3:** whichever driver is chosen must guarantee
`PRAGMA foreign_keys=ON` on every connection.

`blocks_one_canonical_per_height` (`001_chain_archive_core.ts:281-283`) — a partial unique index —
transfers verbatim and enforces correctly (measured). Notably, the Postgres version needed a long
empirical justification about partitioned-index rules; in SQLite it is just an index.

### 3.6 `WITHOUT ROWID` for the content-addressed tables — **the expectation is wrong**

The charter calls `ckpt_chunks`/`chain_blobs` (32-byte hash PK) "obvious candidates". Measured
against a real file with WAL, `page_size` 8192, `PRAGMA wal_checkpoint(TRUNCATE)` before sizing:

```
$ wsl -e bash -lc 'cd /tmp/l4 && node e6_rowid.mjs'
 kind  chunkSize      n   write_ms  pointread_ms  agg_ms   file_bytes  overhead%
 rowid        64  20000       94.5          98.8    1.58     3137536      145.1
 wr           64  20000       70.4         125.9    1.13     2437120       90.4
 rowid      4096  20000      505.8         223.0   16.64    93089792       13.6
 wr         4096  20000      739.1         440.5   26.82    93712384       14.4
 rowid     65536    800      124.6          28.1   13.01    52883456        0.9
 wr        65536    800      247.2         107.1   11.93    52920320        0.9
 rowid   4194304     40      778.1         143.3   28.91   167968768        0.1
 wr      4194304     40      914.6         293.6   27.15   167964672        0.1
```

**`WITHOUT ROWID` is worse for `ckpt_chunks` at every realistic chunk size.** At 4 KiB it is 1.5x
slower to write and **2.0x slower** on point reads; at 64 KiB **3.8x slower** on reads; at the 4 MiB
production default (`checkpoint-store.ts:33`) 1.2x slower writes and **2.0x slower** reads, with no
space saving. It only wins at 64-byte rows (90% vs 145% overhead, faster writes), which matches
SQLite's own documented guidance that `WITHOUT ROWID` suits tables whose rows are small relative to
a page. In a `WITHOUT ROWID` table the PK b-tree *is* the table, so descending it means paging
through records that carry the whole payload; a rowid table's hash-to-rowid index is a narrow, dense
b-tree.

**What would have to be true for this negative to be wrong** (per the brief's trap 8): the reads
would have to be dominated by *ordered full scans* rather than point lookups by hash — `load()`
(`checkpoint-store.ts:340-346`) and `prune()`'s reclaim are both point/predicate access, not
hash-ordered scans — or the payload would have to be small enough to sit inline, which the 64-byte
row demonstrates does flip the result. The measurement is also single-threaded on a warm page cache;
a cold-cache, I/O-bound profile would likely widen the gap, not close it.

**So:** `WITHOUT ROWID` for the narrow key-heavy tables (`ckpt_manifest_chunks`,
`ckpt_sequence_counters`, `watermarks`, the identifiers junction, `transaction_history`), plain
rowid tables for `ckpt_chunks` and `chain_blobs`.

### 3.7 `listKeys` prefix scan

```
  LIKE 'ab%'  -> ["Abc","aBc","ab","abc","abcd","abd"]   <- case-INSENSITIVE, WRONG
  GLOB 'ab*'  -> ["ab","abc","abcd","abd"]               <- case-sensitive
  range scan  -> ["ab","abc","abcd","abd"]               <- case-sensitive, correct
  LIKE with escaped underscore -> ["a_c"]                 (escape does work)
  EQP LIKE : ["SEARCH kv USING PRIMARY KEY (ns=? AND scope=?)"]                       <- no key range
  EQP range: ["SEARCH kv USING PRIMARY KEY (ns=? AND scope=? AND key>? AND key<?)"]   <- key range
  after PRAGMA case_sensitive_like=ON, LIKE 'ab%' -> ["ab","abc","abcd","abd"]
  EQP LIKE after pragma: ["SEARCH kv USING PRIMARY KEY (ns=? AND scope=? AND key>? AND key<?)"]
```

### 3.8 Error shapes (a gift to L6/L3, not my lane's decision)

```
$ wsl -e bash -lc 'cd /tmp/l4 && node e8_err.mjs'
named CHECK      | errcode= 275  | msg= CHECK constraint failed: kv_history_range
named enum CHECK | errcode= 275  | msg= CHECK constraint failed: b_enum
NOT NULL         | errcode= 1299 | msg= NOT NULL constraint failed: t.b
UNIQUE index     | errcode= 2067 | msg= UNIQUE constraint failed: t.b
PK conflict      | errcode= 1555 | msg= UNIQUE constraint failed: t.a
STRICT type      | errcode= 20   | msg= datatype mismatch
```

`node:sqlite` exposes **extended** result codes on `err.errcode` (275 = SQLITE_CONSTRAINT_CHECK,
1299 = NOTNULL, 2067 = UNIQUE, 1555 = PRIMARYKEY, 20 = SQLITE_MISMATCH). **A named
`CONSTRAINT <name> CHECK (...)` puts the name in the message**, which is the direct replacement for
the `constraint_name` field `src/postgres/errors.ts` keys on — so the audit-driven
`USING ... CONSTRAINT = 'chain_blob_roles_completeness'` pattern (`001_chain_archive_core.ts:204`)
has an equivalent. Handing this to **L6** for the G3 frozen error catalog.

### 3.9 Chain-archive watermark JSON guard

```
$ wsl -e bash -lc 'cd /tmp/l4 && node e9_wm.mjs'
initial {height:10} -> {"height":10}
advance {height:20} -> {"height":20}
REGRESS {height:5}  -> {"height":20}   (must stay 20)   OK
equal   {height:20} -> {"height":20}   (strict >)       OK
json_type of a real -> { t: 'real' }                    <- see the B9 trap
non-height shape    -> {"cursor":"abc"}  (falls through to LWW)  OK
```

---

## 4. Design sketch

Prefix `umbradb_` everywhere (the configurable `schema` parameter, defaulting to `DEFAULT_SCHEMA`),
including index and trigger names. Every table `STRICT`. `WITHOUT ROWID` only where rows are narrow.

```sql
-- bookkeeping (000_schema equivalent; no CREATE SCHEMA exists)
CREATE TABLE umbradb_migrations (
  name       TEXT    NOT NULL PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)  -- epoch ms
) STRICT, WITHOUT ROWID;
-- bootstrap detection (was to_regclass):
--   SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?)

-- watermarks (003)
CREATE TABLE umbradb_watermarks (
  kind       TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  value      TEXT    NOT NULL,            -- was jsonb; plain JSON text, never json()'d
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, key)
) STRICT, WITHOUT ROWID;                  -- no fillfactor; 005 becomes a no-op
-- The "never index value/updated_at" hard invariant (003:10-12, 005:15-17) is RETIRED.

-- checkpoint store (002 + 006 folded in)
CREATE TABLE umbradb_ckpt_chunks (        -- rowid table: measured 2x faster than WITHOUT ROWID
  hash       BLOB    NOT NULL PRIMARY KEY CHECK (octet_length(hash) = 32),
  data       BLOB    NOT NULL,
  created_at INTEGER NOT NULL,
  size_bytes INTEGER GENERATED ALWAYS AS (octet_length(data)) STORED   -- greenfield: STORED ok
) STRICT;
CREATE INDEX umbradb_ckpt_chunks_created ON umbradb_ckpt_chunks (created_at);

CREATE TABLE umbradb_ckpt_manifests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,  -- = bigserial; AUTOINCREMENT means no id reuse
  w             TEXT    NOT NULL,
  net           TEXT    NOT NULL,
  seq           INTEGER NOT NULL,
  complete      INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0,1)),
  manifest_hash BLOB    NOT NULL CHECK (octet_length(manifest_hash) = 32),
  label         TEXT,
  created_at    INTEGER NOT NULL
) STRICT;                                 -- rowid table: AUTOINCREMENT forbids WITHOUT ROWID
CREATE INDEX umbradb_ckpt_manifests_lookup
  ON umbradb_ckpt_manifests (w, net, complete, seq DESC);

CREATE TABLE umbradb_ckpt_manifest_chunks (
  manifest_id INTEGER NOT NULL REFERENCES umbradb_ckpt_manifests(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  chunk_hash  BLOB    NOT NULL REFERENCES umbradb_ckpt_chunks(hash),
  PRIMARY KEY (manifest_id, position)
) STRICT, WITHOUT ROWID;
CREATE INDEX umbradb_ckpt_manifest_chunks_by_hash
  ON umbradb_ckpt_manifest_chunks (chunk_hash);

CREATE TABLE umbradb_ckpt_sequence_counters (
  w TEXT NOT NULL, net TEXT NOT NULL, next_seq INTEGER NOT NULL DEFAULT 2,
  PRIMARY KEY (w, net)
) STRICT, WITHOUT ROWID;

-- transaction history (004), with the array normalized out
CREATE TABLE umbradb_transaction_history (
  wallet_id  TEXT    NOT NULL,
  tx_hash    TEXT    NOT NULL,
  entry      TEXT    NOT NULL,            -- was jsonb
  lifecycle  TEXT    NOT NULL CHECK (lifecycle IN ('pending','finalized','rejected')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (wallet_id, tx_hash)
) STRICT, WITHOUT ROWID;

CREATE TABLE umbradb_transaction_history_identifiers (   -- replaces identifiers text[]
  wallet_id  TEXT NOT NULL,
  tx_hash    TEXT NOT NULL,
  identifier TEXT NOT NULL,
  PRIMARY KEY (wallet_id, tx_hash, identifier),
  FOREIGN KEY (wallet_id, tx_hash)
    REFERENCES umbradb_transaction_history(wallet_id, tx_hash) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX umbradb_th_ident_reverse                     -- replaces the GIN index
  ON umbradb_transaction_history_identifiers (wallet_id, identifier, tx_hash);
CREATE INDEX umbradb_th_pending
  ON umbradb_transaction_history (wallet_id, tx_hash) WHERE lifecycle = 'pending';
```

**If migration 006 must be applied forward to an existing database** (B1), the only shape SQLite
accepts is:

```sql
ALTER TABLE umbradb_ckpt_chunks
  ADD COLUMN size_bytes INTEGER GENERATED ALWAYS AS (octet_length(data)) VIRTUAL;
CREATE INDEX umbradb_ckpt_chunks_size ON umbradb_ckpt_chunks (size_bytes);
```

**Write path — `PgTransactionHistoryStorage.writeRows` (`transaction-history-storage.ts:455-528`):**

```sql
-- (0) BEGIN IMMEDIATE replaces pg_advisory_xact_lock + SELECT ... FOR UPDATE  [dep: L2]
INSERT INTO umbradb_transaction_history (wallet_id, tx_hash, entry, lifecycle, updated_at)
VALUES (:w, :h, :entry, :lifecycle, :now)
ON CONFLICT (wallet_id, tx_hash) DO UPDATE
  SET entry = excluded.entry, lifecycle = excluded.lifecycle, updated_at = excluded.updated_at;

DELETE FROM umbradb_transaction_history_identifiers WHERE wallet_id = :w AND tx_hash = :h;
INSERT INTO umbradb_transaction_history_identifiers (wallet_id, tx_hash, identifier)
  SELECT :w, :h, value FROM json_each(:ids);        -- :ids is a JSON array string, ONE parameter

-- pending-clear, iff lifecycle IN ('finalized','rejected') AND :ids is non-empty
DELETE FROM umbradb_transaction_history
WHERE wallet_id = :w AND tx_hash <> :h AND lifecycle = 'pending'
  AND tx_hash IN (                                   -- candidate generation via the reverse index
      SELECT i.tx_hash FROM json_each(:ids) s
      JOIN umbradb_transaction_history_identifiers i
        ON i.wallet_id = :w AND i.identifier = s.value)
  AND NOT EXISTS (                                   -- the universal: row is a subset of :ids
      SELECT 1 FROM umbradb_transaction_history_identifiers i
      WHERE i.wallet_id = :w
        AND i.tx_hash = umbradb_transaction_history.tx_hash
        AND i.identifier NOT IN (SELECT value FROM json_each(:ids)));
```

The `EXISTS(...)` non-empty guard the Postgres version needs (`array_length(identifiers,1) > 0`) is
subsumed: a row with zero identifier rows cannot appear in the candidate `IN` list. Verified in
section 3.3 — `p4` (empty identifiers) survives.

**`listKeys` (`temporal-kv.ts:317-323`):**

```sql
SELECT key FROM umbradb_kv_current
WHERE ns = :ns AND scope = :scope AND key >= :prefix AND key < :prefixUpper
ORDER BY key
```

`:prefixUpper` is the prefix with its last code point incremented (or omit the upper bound for an
empty prefix). `escapeLikePrefix` is deleted.

**Batch inserts (`checkpoint-store.ts:229-235, 275-280`):** delete `CHUNK_INSERT_MAX_ROWS` /
`JUNCTION_INSERT_MAX_ROWS` and the sub-batch loops. Junction rows go through one `json_each`
statement; chunk rows go through a prepared-statement loop inside the transaction (22 ms per 50 k
rows measured). `= ANY(sql.array(manifestIds))` at `checkpoint-store.ts:442` becomes
`IN (SELECT value FROM json_each(:ids))`.

---

## 5. Open questions / what I could not settle

1. **No live Postgres was reachable**, so every statement about *Postgres* behavior in this report
   is a **citation or an inference from the repo's own comments**, not a measurement. Specifically
   unverified by me: that `<@` ignores duplicates and order; that `jsonb` reorders object keys and
   drops duplicates; that `ORDER BY text` follows `lc_collate`. The SQLite side is all measured.
2. **`serialize()` output stability.** `transaction-history-storage.ts:374-377` is `getAll()` plus
   `JSON.stringify`, so it re-serializes from parsed objects and is engine-independent — *unless*
   Postgres `jsonb`'s key reordering is currently observable in that output and something downstream
   depends on it (a hash, a golden file). I did not audit consumers. **Flagged to L6.**
3. **`listKeys` resume-cursor portability.** A consumer that persisted a `listKeys` position under
   Postgres `en_US.UTF-8` ordering and resumes under SQLite BINARY ordering could skip or repeat
   keys *once*, at the migration boundary. The frozen contract only promises stability, so this is
   not a contract break, but it is a real one-time data-path hazard for a live migration.
4. **`ckpt_chunks` at 4 MiB and SQLite's 1 GB `MAX_LENGTH`.** The default chunk size is 4 MiB,
   comfortably inside `SQLITE_MAX_LENGTH = 1000000000`, but `SaveCheckpointOptions.chunkSize` is
   caller-supplied. I did not check whether the Zod bound on `chunkSize` is below 1 GB. Cheap to
   check; not checked.
5. **Whether the STORED-vs-VIRTUAL choice for `size_bytes` is measurable.** I confirmed VIRTUAL is
   indexable and returns correct values, but did not benchmark `sum(size_bytes)` over a VIRTUAL
   column with an index versus a STORED one at scale. My expectation (an index on a virtual column
   materializes the value in the index, so the aggregate is index-only either way) is an
   **inference**, not a measurement.
6. **Multi-tenant prefixing in one file.** Under option (a), two "schemas" share one writer lock and
   one WAL. Whether that is acceptable is an L2/L3 concurrency question I deliberately did not
   research.

---

## 6. Cost estimate

**Engineering size for L4's slice: roughly 2.5 to 4 developer-weeks**, assuming L3 has landed a
driver seam and L2 has settled transaction/locking.

| Work | Size | Notes |
|---|---|---|
| Rewrite 7 migrations (000, 002-006 + chain-archive core) as SQLite DDL | 3-4 d | mostly mechanical; the CHECK/partial-index/FK forms transfer verbatim |
| Prefix-based schema layer: replace `search_path`, prefix tables **and indexes and triggers**, rewrite `assertValidSchemaName`, delete `assertNoConflictingSearchPath` | 2-3 d | net LOC reduction |
| TransactionHistory junction table: schema, 3-statement write path, containment DELETE, `getAll`/`get` joins | 4-5 d | highest-risk item; needs its own semantics test matrix (the 3.3 fixture is a starting point) |
| `listKeys` range scan; delete `escapeLikePrefix` | 1 d | |
| Batch-insert rework (`json_each` + prepared loop); delete the two row caps and the 60-line V8-string-length comment | 1-2 d | net LOC reduction |
| jsonb to TEXT columns (mechanical; `sql.json()` to `JSON.stringify`) | 1 d | |
| `bigserial` to `AUTOINCREMENT`; `WITHOUT ROWID` decisions per table | 1 d | |
| Migration-006 VIRTUAL-column workaround + its own test | 1 d | |
| Chain-archive watermark JSON guard (`json_type IN ('integer','real')`) | 0.5 d | |
| Re-point the P1-P10 conformance suite at the new shapes | 3-5 d | **shared with L6** — the empirical bridge between the Lean abstract store and the concrete store is exactly what has to be re-run |

| Cross-lane: supply L3 the static `(table, column) -> decoder` registry for the shim (B10) | 0.5 d | mechanically derivable from the migration DDL |

**What it breaks — classified by whether tag timing changes the cost** (per the L6 relay confirming
`docs/STABILITY.md:45`, "Current version: `0.9.5` — the commitments above are NOT yet in force"):

| Break | Pre-1.0.0 tag | Post-tag | Permanent regardless of timing? |
|---|---|---|---|
| **`DEFAULT_SCHEMA` meaning narrows** (B2, option (a)) | doc/CHANGELOG note | doc/CHANGELOG note | **No — and it is not a surface break at all.** Symbol, type and every ctor param survive verbatim |
| Dropping schema configurability (B2, option (c)) | CHANGELOG entry | **major version** | No — and it is fully **avoidable**; never pay this |
| **Forward `ALTER TABLE ADD STORED`** (B1) | **free** — fold 006 into 002, problem gone | VIRTUAL workaround, permanently | **This is the one where the tag window has real value** |
| One-time `listKeys` collation reorder (open question 3) | free — no released SQLite data exists | a live-migration data hazard | No, but only if it lands pre-tag |
| G3 error-translation mechanism (SQLSTATE to errcode) | CHANGELOG entry if any `code` moves | major if any `code` moves | L6's call, not mine |

- **The headline:** *nothing in my lane is a permanent break.* The single most consequential item
  (B2) is not a break under the recommended option, and the item that genuinely benefits from
  landing pre-tag is **B1, not B2**. Two other lanes concluding "this must be a 2.0.0" are, on my
  evidence, over-reading the schema question.
- **G4 section 2 (forward-only migration)** — B1. Not the contract's *text*, but a real capability
  behind it. Pre-tag it costs nothing (fold 006 into 002); post-tag it is a permanent constraint on
  every future migration that would want a stored generated column.
- **Two hard invariants are retired, not broken**: "never index `watermarks.value`/`updated_at`"
  (`003_watermarks.ts:10-12`) and the identical one for `kv_current`
  (`005_kv_current_fillfactor.ts:15-17`). Both existed only to protect Postgres HOT updates.
- **Nothing in G3 (error catalog) from this lane directly** — but the translation *mechanism*
  changes from SQLSTATE + `constraint_name` to extended result code + a parsed message. Section 3.8
  shows it is expressible; the decision is L6's.
- **The `text[]` column disappears from the on-disk shape.** Not a public-surface break —
  `TransactionHistoryEntry.identifiers` stays `readonly string[]` in TypeScript. It is a storage
  redesign, invisible above the adapter.
