# Design — PostgreSQL→SQLite data migration for the wallet tier

Every code claim below cites `file:line` against the worktree `/root/UDB-sqlite-sprint`
(branch `sprint/sqlite-migration`, cut from `origin/main` at `3c0c68b`). Every claim about a sibling
change cites that change's own file and line. Every number in §13 was produced by the command shown
above it, on this machine, against database files under `/root` (ext4) — never `/tmp`, which on this
host is a tmpfs RAM disk and is the reason six of seven research lanes' measurements are inadmissible.
Verbatim quotations from source are rendered *"in italics inside quotation marks"*.

**Documents this design amends or extends.** It touches, and therefore cites by section number:
`design/design.md` §2 (TemporalKV → Postgres), §3 (checkpoint chunker), §4 (Watermarks);
`design/design-interfaces.md` §1.1 (the one error idiom), §1.4 (runtime validation), §3.2–§3.4;
`Formal/STORAGE_ALGEBRA.md` §1 (Laws T1/T3/T4/T5), §2 (CheckpointStore closure), §3 (Watermarks),
§5 (P1–P10). It **supersedes nothing**: it adds a procedure that did not previously exist. Where it
appears to touch `docs/CONTRACT.md` §2 or §6, or `docs/STABILITY.md`, it states the consistency
obligation and hands the text to change 5 (§11.3).

---

## §0. Scope, dependencies, and what this change may not specify

### 0.1 The boundary table

| Consumed | Owner | Why this change cannot specify it |
|---|---|---|
| Driver (`better-sqlite3@13.0.2`, SQLite 3.53.4), tagged-template shim, bind normalisation, `columns()` origin-metadata decoding, parameter ceiling (32,766), worker topology, pragma bootstrap order and read-back, the blocking measurement gate | change 1 (`v1.0.0-sqlite-engine-core`) | Its `design.md` §1.2 rules the binding; its requirement *"the pragma bootstrap is an ordered, once-only sequence whose effect is verified by read-back"* fixes the bootstrap order and its irreversibility; its requirement *"every performance-dependent decision is blocked on measurements taken on a real filesystem under declared conditions"* is the gate. An importer writes *through* all of this. |
| `kv_event` DDL, its three triggers, the `kv_validity` view, the `LEAD()` derivation, the `written_at` clock policy, the `INSERT OR REPLACE` ban, T3/T5 restatement | change 2 (`v1.0.0-sqlite-temporal-event-log`) | Its `design.md` §2 and `:237-256` are the target encoding. Change 2 says nothing about pre-existing rows; that silence is this change's whole subject (§3). |
| Every other target table, the `<schema>_` prefixing, `STRICT`, the `CHECK` constraints, the junction table and its containment direction, `listKeys` range scan and `BINARY` ordering, the transaction-history read-path cross-checks (**I-7**), and the migration lineage `000`–`009` | change 4 (`v1.0.0-sqlite-schema-parity`) | Its `design.md` §12.1 is the lineage. Its requirement *"migration 006 replays verbatim, and no future migration adds a STORED generated column to a populated table"* fixes the ordering constraint this change obeys (§2.2). Its `design.md` §19.2 answers this change's Q-2 (§5.3). Its §17.4 **hands this change** the decision on rows that fail a newly added constraint (§4.5). |
| The per-value digest regime, `verifyIntegrity`, the durability probe and its hard refusals, backup/restore, the error catalog, observability | change 5 (`v1.0.0-sqlite-durability-contract`) | Its requirement *"integrity coverage follows the three-class corruption model with an explicit column-level coverage set"* is the digest; `:178-187` is the verification pass; `:42-46` and `:74-75` are the probe's refusals. Change 5 has since **settled the algorithm** — SHA-256, 32 raw bytes, in the `dg BLOB` column change 4's migration `009_value_digests` adds over `kv_event.value`, `watermarks.value` and `transaction_history.entry` (change 4 `design.md` §19.3). This change **reuses** it and adds no second mechanism (§8.3, §9.4). |
| The chain-archive lineage | change 6 (`v1.0.0-sqlite-chain-archive`) | It is greenfield and empty; there are no archive rows to import (`proposal.md` non-goals). |

**What this change decides, and nobody else does:** how existing PostgreSQL rows become target rows;
what a source state that the target cannot represent does; what "verified" means before a consumer
deletes a database; what an interrupted migration leaves behind; and what each of the three
distribution channels' consumers actually run.

### 0.2 What could not be measured, stated plainly

**There is no PostgreSQL server, and no PostgreSQL container, running or stopped, on this machine,
and none was started for this change.** Every statement in this document about PostgreSQL behaviour
is therefore one of exactly two things, and is labelled as such wherever it appears:

- **[code]** — read directly out of this repository's own migrations and adapters, at the cited
  `file:line`. These are facts about what UmbraDB *writes*, and they are as reliable as the code.
- **[inference]** — a consequence drawn from PostgreSQL's documented semantics applied to that code.
  These are the claims a builder must discharge against the fixture in §14 before relying on them.

Nothing about PostgreSQL in this document is **[measured]**. The `[measured]` label appears only in
§13, and only for SQLite-core semantics observed on this host. Those, too, carry a caveat: they were
observed through `node:sqlite` (SQLite 3.53.1), because `better-sqlite3` is not installed in this
worktree and `npm install` is forbidden by the authoring brief. Each is a property of the SQLite
core rather than of a binding, and §13 records the re-confirmation obligation on the ruled binding.

### 0.3 The one thing this change asserts about performance

Nothing. There is no import duration, no throughput, no row rate and no "this will take about"
anywhere in this change. Migration duration is a **decision input** in exactly one place — §10.3's
rule for whether resumability is required — and there it is written as an obligation to measure
under change 1's gate conditions (`v1.0.0-sqlite-engine-core` requirement *"every performance-dependent decision is blocked on measurements taken on a real filesystem under declared conditions"*: filesystem and mount
options, `journal_mode`, `synchronous`, `page_size`, `auto_vacuum`, dataset size and host RAM,
concurrent-writer presence, binding and `sqlite_version()`), never as a figure.

---

## §1. The source, as it actually is

This section is entirely **[code]**. It is here because every subsequent section depends on the
source's exact shape, and because two premises circulating in the sprint about the wallet tier are
wrong.

### 1.1 TemporalKV — two tables, one trigger, and where the live version lives

`src/postgres/migrations/001_temporal_kv.ts:72-83`:

```sql
CREATE TABLE <schema>.kv_current (
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

`:85-101`:

```sql
CREATE TABLE <schema>.kv_history (
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
)
```

and the `BEFORE UPDATE` trigger that populates history, `:113-139`, whose body is the load-bearing
part:

```sql
IF OLD.updated_xact = now_xact THEN RAISE EXCEPTION USING ERRCODE = 'UB001', … END IF;
INSERT INTO <schema>.kv_history (ns, scope, key, value, version, valid_from, valid_to)
VALUES (OLD.ns, OLD.scope, OLD.key, OLD.value, OLD.version, OLD.updated_at, now_ts);
NEW.updated_at   := now_ts;
NEW.updated_xact := now_xact;
```

Four facts follow directly, and §3 is built on them:

1. **The live version of a key is in `kv_current`, not in `kv_history`.** `kv_history` receives the
   *superseded* row (`OLD`), so it holds versions `1 … n-1` and `kv_current` holds `n`. An importer
   that reads only `kv_history` loses every key's current value; one that reads only `kv_current`
   loses every key's entire history.
2. **The interval boundary is written twice, to the same value.** The trigger sets the history row's
   `valid_to := now_ts` and the surviving current row's `updated_at := now_ts` in the same statement.
   So for a key written only through the adapter, `valid_to(v) = valid_from(v+1)` for every `v < n-1`,
   and `valid_to(n-1) = kv_current.updated_at`. **This is exactly the property the event log needs**
   and exactly the property the importer must not assume (§3.2, S3).
3. **Timestamps are already millisecond-quantised.** `date_trunc('milliseconds', clock_timestamp())`
   at `:79` and `:118`. The in-file comment at `:60-71` records why — a `Date` round trip through
   `getAt({at})` missed rows at microsecond precision — and records the residual: two writes to one
   key inside one millisecond collide, `valid_from = valid_to`, and the `CHECK` at `:96` raises
   SQLSTATE 23514.
4. **There is no delete path.** `src/interfaces/temporal-kv.ts` declares exactly four operations —
   `put` (`:284`), `get` (`:295`), `getAt` (`:309`), `listKeys` (`:331`). No adapter code removes a
   `kv_current` row. **[inference]** every key with history therefore has a live row; the importer
   verifies it anyway (§3.2, S1), because a consumer with `psql` access is not the adapter.

### 1.2 The correction: the wallet-state envelope has no table

The authoring brief lists "the wallet-state envelope" as a tier this change must move. It has no
storage of its own. `src/postgres/wallet-state-envelope.ts:7-12`, verbatim:

> *Thin wrapper over an injected `CheckpointStore` … that persists a {@link WalletStateEnvelope} as
> a SINGLE `CheckpointStore.save()` call per (walletId, networkId) … **Adds NO new table or
> migration -- it reuses `CheckpointStore`'s own chunk/manifest storage entirely.***

`save()` at `:52-53` reduces to `encode(envelope)` then `this.checkpointStore.save(walletId,
networkId, bytes, opts)`. **Consequence:** migrating the checkpoint tables migrates the envelope
tier in full, byte for byte, and there is no envelope-specific import step. The verification
obligation is not vacuous, though — §9.5 requires an envelope-level `load()` round trip precisely
because the envelope's own `EnvelopeCorruptError` path (`:65-66`) is a decoder that a byte-faithful
chunk copy satisfies and a subtly-wrong one does not.

This also resolves a gap the sibling recon surfaced: `v1.0.0-sqlite-schema-parity` contains no
envelope DDL (its `design.md` §12.1 scopes §12.1 to the tier-1 lineage) and change 2 owns no envelope
table either. Neither is an oversight — there is no table to own.

### 1.3 CheckpointStore

`src/postgres/migrations/002_checkpoint_store.ts:12-83`: `ckpt_chunks(hash bytea PK, data bytea NOT
NULL, created_at timestamptz)`; `ckpt_manifests(id bigserial PK, w text, net text, seq bigint,
complete boolean DEFAULT false, manifest_hash bytea, label text NULL, created_at timestamptz)` plus
index `ckpt_manifests_lookup (w, net, complete, seq DESC)`; `ckpt_manifest_chunks(manifest_id bigint
REFERENCES ckpt_manifests(id) ON DELETE CASCADE, position integer, chunk_hash bytea REFERENCES
ckpt_chunks(hash), PRIMARY KEY (manifest_id, position))` plus `ckpt_manifest_chunks_by_hash`;
`ckpt_sequence_counters(w text, net text, next_seq bigint DEFAULT 2, PRIMARY KEY (w, net))`.
`006_ckpt_chunks_size_bytes.ts:16-19` later adds `size_bytes integer GENERATED ALWAYS AS
(octet_length(data)) STORED`.

Three consequences for an import: `ckpt_manifests.id` is referenced by the junction table and must be
**preserved, not reallocated** (§5.1); `size_bytes` is generated on both sides and must **not** be
transported; and `ckpt_manifest_chunks.position` exists specifically so a manifest may reference one
chunk hash at two positions (`:44-49`), so the junction is not a set and its multiplicity is
load-bearing.

### 1.4 Watermarks and TransactionHistory

`003_watermarks.ts:16-28`: `watermarks(kind text, key text, value jsonb NOT NULL, updated_at
timestamptz DEFAULT now(), PRIMARY KEY (kind, key)) WITH (fillfactor = 90)`. Last-write-wins, no
history, no ordering invariant (the in-file comment at `:21-24` says so explicitly). This is the one
tier that is a straight copy.

`004_transaction_history.ts:24-42`: `transaction_history(wallet_id text, tx_hash text, entry jsonb,
identifiers text[] NOT NULL DEFAULT '{}', lifecycle text, updated_at timestamptz, PRIMARY KEY
(wallet_id, tx_hash))` plus a GIN index on `identifiers`.

The subtlety is in the read path, not the DDL, and reading it closely turns up a latent defect in
shipped code. `src/postgres/transaction-history-storage.ts:229-231` records that
*"`identifiers`/`lifecycle.status` are read from their own denormalized columns (always written in
the same statement as `entry`, so never out of sync"*. **That comment is true of one of the two
fields and false of the other**, which I verified by reading `decodeRow` in full:

- `:238` is `identifiers: row.identifiers` — the **column**, as the comment says.
- `:243` is `lifecycle: stored.lifecycle` — the **JSON**, not the column. The `lifecycle` column *is*
  selected, at `:329`, `:358` and `:462`, and `row.lifecycle` is then **never read anywhere in
  `decodeRow`**.

Two consequences, both **[code]**:

1. The `identifiers` array's **order and duplicate multiplicity are caller-observable today**, via
   the column, and change 4's junction has primary key `(wallet_id, tx_hash, identifier)` with no
   position column — it is a set. §5.3 carries the resolution.
2. The `lifecycle` column and `entry.lifecycle.status` are two representations of one fact that
   **nothing in the shipped code ever compares**, so they can already have drifted apart in a live
   database with no error raised, ever. Change 4's `design.md` §19.2 names this the
   lifecycle-agreement half of invariant **I-7**. It matters here because **this migration is the
   first mechanism in UmbraDB's history that looks at both at once** (§4.5, §5.3).

### 1.5 What is *not* source data

`<schema>._migrations` (`000_schema.ts:14-19`) records which **PostgreSQL** migrations ran. The
target's `<s>_migrations` records which **SQLite** migrations ran. They are different lineages with
different names. Importing the source's rows would produce a database claiming to have applied
migrations that do not exist in its own lineage, and change 4's bootstrap detection would then
mis-decide. `<s>_writer_generation`'s seed row is likewise produced by change 4's migration `007`
(its `design.md` §12.1), not imported. §5.4 makes both a positive requirement.

---

## §2. The target, and the two structural constraints it imposes on an import

### 2.1 It is a reconstruction

Change 2 replaces the pair of §1.1 with one table whose intervals are derived
(`v1.0.0-sqlite-temporal-event-log/design.md` §2):

```sql
CREATE TABLE kv_event (
  ns TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL,
  version INTEGER NOT NULL, value TEXT NOT NULL, written_at INTEGER NOT NULL,
  PRIMARY KEY (ns, scope, key, version)
);
CREATE UNIQUE INDEX kv_event_time ON kv_event (ns, scope, key, written_at);
CREATE VIEW kv_validity AS
SELECT ns, scope, key, version, value,
       written_at AS valid_from,
       LEAD(written_at) OVER (PARTITION BY ns, scope, key ORDER BY version) AS valid_to
FROM kv_event;
```

with `BEFORE INSERT` assertions (`:237-256`) that reject `version <> prev+1` (`UB_T1_VERSION`) and
`written_at <= prev.written_at` (`UB_T4_CLOCK`), and `BEFORE UPDATE`/`BEFORE DELETE` assertions that
make the table append-only (`UB_APPEND_ONLY`). The live version's derived `valid_to` is SQL `NULL`,
and change 2's requirement *"the event log is the only stored temporal representation and validity intervals are derived, never stored"* forbids substituting a far-future sentinel.

### 2.2 Constraint A — the lineage runs to completion on an empty file, before any row

Change 4's requirement *"migration 006 replays verbatim, and no future migration adds a STORED generated column to a populated table"* requires migration `006` to transliterate
`006_ckpt_chunks_size_bytes.ts:16-19` unchanged, retaining `GENERATED ALWAYS AS (octet_length(data))
STORED`. Its `design.md` §10 records the measured basis: the statement *"succeeds on a 0-row
table"* and fails with `cannot add a STORED column` at one or more rows. Therefore:

> **The full lineage `000` → `009` runs against the freshly created, empty target file. Only then
> does the first imported row land.** An import that creates tables itself, or that interleaves rows
> with lineage steps, fails at `006` — loudly, which is the good case — or diverges from a
> greenfield database's schema, which is the bad one.

The upper bound moved from `007` to `009` while this change was being written: change 4 added
`008_ckpt_manifests_seq_unique` (`CREATE UNIQUE INDEX <s>_ckpt_manifests_seq_unique ON
<s>_ckpt_manifests (w, net, seq)`, its `design.md` §17.4) and `009_value_digests` (the `dg BLOB`
column, its §19.3). Both are additions the source never had, and both are §4.5 Class 2 surfaces:
`008` because an existing deployment may already hold colliding rows, `009` because the digest is
computed at import rather than transported (§9.4). Running the lineage to `009` before the first row
is what makes `009`'s `ALTER TABLE … ADD COLUMN dg BLOB` trivial — the column is nullable with no
default, which is what SQLite requires and what change 4's §19.3 records.

This also settles where the pragma bootstrap happens: change 1's requirement *"the pragma bootstrap is an ordered, once-only sequence whose effect is verified by read-back"* requires
`page_size` and `auto_vacuum` to be set **before** `journal_mode` and before any write, and its
requirement *"the pragma bootstrap is an ordered, once-only sequence whose effect is verified by read-back"* records that the condition is permanent. The import creates its target through
change 1's normal connection factory, so the bootstrap and its read-back assertion happen once, on
an empty file, before the lineage. There is no import-specific pragma path and no opportunity to
"tune for bulk load" — see §10.4.

### 2.3 Constraint B — the event log accepts a per-key ascending stream and nothing else

**[measured]**, §13 E3. Change 2's `kv_event_bi` trigger evaluates on every insert. An import that
walks a key's versions newest-first is rejected on its second row; an import that inserts a key's
history and appends its live version later is rejected unless the live version is exactly `prev+1`.
Interleaving *different keys* is accepted, because the assertions are partitioned by
`(ns, scope, key)`. So the import may stream, but each key's chain must arrive in ascending `version`
order with strictly increasing `written_at`.

Two further prohibitions inherited rather than invented: change 2's requirement *"the adapter never issues INSERT OR REPLACE against the event log"* bans
`INSERT OR REPLACE`/`REPLACE INTO` against the event log and requires *"an automated guard over the
adapter's SQL, not … review alone"*. A bulk importer is precisely the code that reaches for it. §10.5
places the importer inside that guard's scope explicitly.

---

## §3. The reconstruction rule for TemporalKV

### 3.1 The rule

For each `(ns, scope, key)` present in the source, let `H` be its `kv_history` rows and `C` its
`kv_current` row. The event chain is:

```
E(K) = [ (v, value_v, written_at := valid_from_v)  for each row of H in ascending version ]
    ++ [ (C.version, C.value, written_at := C.updated_at) ]
```

`kv_history.id`, `kv_history.valid_to`, `kv_history.validity` and `kv_current.updated_xact` are
**not** transported. `valid_to` is not dropped for being redundant — it is dropped because in the
target it is *derived*, and §3.3 shows that transporting it would be the only way to smuggle in a
state the target cannot hold. `updated_xact` is a transaction-identity guard for the
one-put-per-key-per-transaction rule (`001_temporal_kv.ts:120-124`); change 2's requirement *"same-transaction key reuse is adapter-enforced, and the adapter states exactly what it guarantees"*
re-homes that guard in the adapter, so the column has no successor.

### 3.2 The six source preconditions, which the importer verifies rather than assumes

Per key:

| id | Precondition | Why it matters | Source of the guarantee |
|---|---|---|---|
| **S1** | If `H` is non-empty then `C` exists | a history-only key has no live version and its chain is truncated | **[code]** no delete path exists (§1.1 fact 4) — but `psql` does |
| **S2** | The versions in `H` are exactly `1 … C.version − 1`, each once | `kv_event`'s `PRIMARY KEY (ns,scope,key,version)` and `UB_T1_VERSION` both require a dense `1..n` chain | **[code]** `put` sets `version = 1` on insert and `version + 1` on update (`temporal-kv.ts:119-122,151`) |
| **S3** | `valid_to(v) = valid_from(v+1)` for `v < n−1`, and `valid_to(n−1) = C.updated_at` | this *is* T3 equivalence (§3.3) | **[code]** the trigger writes both from one `now_ts` (`001_temporal_kv.ts:126-127`) |
| **S4** | `valid_from` is strictly increasing over `v`, and `C.updated_at > valid_from(n−1)` | `UB_T4_CLOCK` and the `kv_event_time` unique index | **[code]** implied by S3 plus `CHECK (valid_from < valid_to)` (`:96`) |
| **S5** | No version appears in both `H` and `C` | the target has one row per `(key, version)`; the source resolves the collision with a `priority` tiebreak | **[code]** the collision is documented as reachable at `temporal-kv.ts:231-240` |
| **S6** | Every timestamp is an exact whole number of milliseconds | `Date` is ms-quantised and change 2's `written_at` is ms | **[code]** `date_trunc('milliseconds', …)` at `:79`, `:118` |

Every one of these is a property of what the *adapter* writes. None is enforced by the database
across both tables — the EXCLUDE constraint spans only `kv_history`, which
`src/postgres/temporal-kv.ts:233-237` states in terms. A consumer who ever ran `psql` against their
own database — to fix a stuck sync, to delete a key, to backfill — can hold a source that violates
S1, S2, S3 or S5 while every PostgreSQL constraint is satisfied. **The importer verifies all six per
key and refuses on any violation (§4).**

### 3.3 Why the rule is correct, in one paragraph

Source `getAt({at: T})` for key `K` is, by `temporal-kv.ts:252-259`, the `kv_history` row whose
`validity` (a `[)` range) contains `T`, else the `kv_current` row if `C.updated_at <= T`, else
`null`. Under S3 the history intervals are `[valid_from_v, valid_from_{v+1})` for `v < n`, and the
current row covers `[C.updated_at, ∞)` where `C.updated_at = valid_to(n−1) = valid_from(n)`. So the
source's answer is *"the greatest `v` whose `valid_from_v <= T`"*, which is exactly what the target
computes — change 2's `design.md` §7 gives the target's SQL as `WHERE … AND written_at <= :T ORDER
BY written_at DESC LIMIT 1`. Under S2 and S5, `getAt({version: v})` agrees for the same reason.
**T3 equivalence is therefore a corollary of S3, and nothing else.** That is why S3 is verified and
not assumed: it is the entire correctness argument, and it is not enforced by any constraint.

### 3.4 The clock policy does not apply to imported rows

Change 2 leaves the `written_at` expression undecided pending change 1's gate
(`v1.0.0-sqlite-temporal-event-log` requirement *"the write-timestamp clock policy is decided by the engine-core measurement gate, not assumed"*). That decision governs rows the *store*
generates. **Imported rows carry the source's historical `written_at` and the live clock is never
consulted during an import.** This is not a variation on change 2's rule; it is outside its scope,
and change 2 says nothing about it. Two consequences worth writing down: an imported database's
newest `written_at` is a past instant, so the first post-migration `put` will exceed it under either
branch of change 2's rule and `UB_T4_CLOCK` cannot fire spuriously; and if change 2's branch (a) is
taken — a per-key monotone logical clock with a drift threshold — the imported `written_at` values
are the `prev` that clock starts from, which is correct and needs no special case.

---

## §4. The refusal set

A source state that the target cannot represent is a **refusal**, not a repair and not a choice of
winner. Three are worth setting out because each has a distinct failure signature.

### 4.1 A gap manufactures data — measured

`kv_history_no_overlap` (`001_temporal_kv.ts:97-99`) is an `EXCLUDE … WITH &&` constraint. `&&` is
overlap. **It does not require contiguity.** A source holding `[1000, 2000)` and `[3000, ∞)` for one
key satisfies every constraint in the schema, and `getAt({at: 2500})` returns `null`.

Imported and derived through `LEAD()`, §13 E3 measured the result: intervals `[1000, 3000)` and
`[3000, NULL)`, and `getAt({at: 2500})` returns **version 1**. The migration invented a value at an
instant where the source had none. Nothing downstream detects it: row counts match, per-row digests
match, and every one of change 2's assertions passes, because the imported chain *is* well-formed —
it is simply not the same function of `T`.

This is the sharpest illustration of why change 2's structural gap-freedom is a strengthening with a
migration-boundary cost. **The importer detects gaps by checking S3 and refuses.**

### 4.2 A version collision is unrepresentable, not resolvable

`src/postgres/temporal-kv.ts:231-240` documents the state — a `kv_history` row whose interval covers
the live row's instant, or (S5) a `kv_history` row at the same `version` as `kv_current` — and
resolves reads deterministically: *"kv_history wins, since it's the actual historical record"*. But
`get()` reads `kv_current` directly (`:183-186`) and does not consult `kv_history` at all. **So in
such a source, `get()` and `getAt({version: n})` already return different values, and no single-row
encoding can reproduce both.** An importer that applies the `priority` tiebreak would pass a `getAt`
replay while changing what `get()` returns. Refusal is the only faithful answer, and the diagnostic
must name which of the two observations it could not preserve.

### 4.3 Non-monotone or non-dense chains

S2 and S4 violations are caught by change 2's own triggers if they reach the database — §13 E3
measured `UB_T1_VERSION` and `UB_T4_CLOCK` firing — but a trigger abort mid-import is a poor
diagnostic: it names a SQLite constraint, not the source row that caused it. The importer performs
the S1–S6 check as a **pre-flight pass over the bundle, before opening a write transaction**, so the
failure names `(ns, scope, key)`, the precondition, and the two source rows involved. The triggers
remain the backstop and are never disabled (§10.4).

### 4.4 What a refusal is, in error terms

A refusal aborts the migration with a non-zero exit and a report; it does **not** produce a target
database. It follows `design/design-interfaces.md` §1.1's one idiom — thrown, `code`-discriminated —
inside the tool. It does **not** add an error code to `docs/ERROR-CATALOG.md`: change 5's
requirement *"no frozen error code is repurposed and no contention code is added"* forbids repurposing and enumerates the four codes being added, and this change adds
none. The migration tool is outside the frozen surface (`v1.0.0-sqlite-durability-contract`'s data-migration non-goal),
so its diagnostics are tool diagnostics, not catalog entries. This is a deliberate restriction and
§15 Q-4 records the one place it chafes.

### 4.5 Two classes of bad source, and the ruling change 4 handed this change

`v1.0.0-sqlite-schema-parity/design.md` §17.4 states the obligation in terms and declines to
discharge it:

> *existing PostgreSQL deployments may already contain rows violating `UNIQUE (w, net, seq)`, if this
> corruption has ever occurred in the field. **Change 7 owns the PostgreSQL-to-SQLite data migration
> and must decide what happens to rows that fail the new constraint** — reject the migration, or
> quarantine and report. This change does not decide that; it states the obligation.*

The right answer is not one answer, because the offending states are not one kind. Separating them is
the whole of this ruling.

**Class 1 — unrepresentable.** The target cannot reproduce what the source *observably did*.
Importing at all changes an answer a caller receives. §4.1's gap, §4.2's version collision, and — new
here — an `entry`/column disagreement in transaction history, because today `getAll()` returns the
`identifiers` **column** (`transaction-history-storage.ts:238`) and after I-7 it returns what `entry`
says, so if the two disagree the migration cannot preserve the observation whichever side it picks.
Rewriting `entry.identifiers` to match the column would preserve the observation, and is forbidden:
it silently mutates a stored document, and that document is precisely the value change 5's `dg`
digest covers.

**Class 2 — newly constrained.** The source's observable behaviour *is* representable, but the target
adds a constraint PostgreSQL never had, so the rows will not load. Members: change 4's migration
`008`'s `UNIQUE (w, net, seq)` on `ckpt_manifests`; its §17.3(a) runtime invariant
`next_seq > max(seq)`, which an existing `ckpt_sequence_counters` row may already violate; the
`CHECK (octet_length(hash) = 32)` on chunk and manifest hashes; and the
`CHECK (lifecycle IN ('pending','finalized','rejected'))` enum.

**Ruling, three parts.**

1. **Both classes refuse by default. There is no automatic repair, for either.** A repair is a data
   decision — which of two colliding manifests survives, which of two identifier sets was intended —
   and the tool has no basis to make it. Silence here would be the worst outcome available: a
   migration that "succeeded" having quietly resolved a question nobody was asked.
2. **Class 2 additionally emits a remediation report**, and this is where the two classes diverge.
   The report names every offending row, the constraint it fails, and the exact **source-side**
   statements that would resolve it. The consumer applies them **to their own PostgreSQL database,
   with their own hands**, then re-exports. This is consistent with §11.2's read-only rule — the
   migration still writes nothing; the consumer does, knowingly, before the migration, having been
   told by `docs/CONTRACT.md:114-121` how to take a `pg_dump` first — and it is cheap because §10.3
   makes re-running unconditional. Class 1 gets no remediation script, because there is none that is
   not a data decision; it gets a report that says exactly what was inconsistent and stops.
3. **Quarantine is rejected, with reasons.** "Import the good rows and set the bad ones aside" fails
   three ways. It produces a target that is **not** observationally equivalent to the source while
   reporting success, which is the exact failure shape this whole change exists to prevent. There is
   nowhere to put the quarantined rows: the target schema has no such table, and adding one is change
   4's DDL and change 4 did not add one. And it would make the *migration* the thing that dropped a
   consumer's manifest, rather than the consumer — which is a liability inversion in a wallet store.

**Why this is not user-hostile.** Refusal without a path forward would strand a consumer whose
database is already damaged. The remediation report *is* the path forward, and it puts the
irreversible act in the hands of the person who owns the data and can still roll back, rather than in
a tool running unattended. Note also that neither Class 2 member is hypothetical: `008` exists
because change 4 found a real sequence-allocation gap, and I-7 exists because the lifecycle
representations have never been compared.

---

## §5. The other tiers

### 5.1 CheckpointStore — identifiers preserved, generated column not transported

`ckpt_chunks` and `ckpt_sequence_counters` are straight copies. `ckpt_manifests` is a copy **with its
`id` values preserved**, because `ckpt_manifest_chunks.manifest_id` references them
(`002_checkpoint_store.ts:58`) and change 4 keeps that foreign key with `ON DELETE CASCADE`
(`v1.0.0-sqlite-schema-parity/design.md` §12.1). Change 4 maps `bigserial` to `INTEGER PRIMARY KEY
AUTOINCREMENT` (its requirement *"each PostgreSQL type class maps to exactly one SQLite declared type"*).

**[measured]**, §13 E1: inserting explicit ids `7, 3, 91` into an `AUTOINCREMENT` table leaves
`sqlite_sequence.seq = 91`, and the next auto-assigned id is `92`. So preserving ids is safe and
needs no manual `sqlite_sequence` seeding — the high-water mark follows the largest explicit id. §13
E2 records the contrast that justifies change 4's `AUTOINCREMENT` choice: without it, deleting the
largest row causes the next insert to **reuse** id 8, which for a content-addressed manifest store
would silently rebind junction rows on restore.

`size_bytes` is `GENERATED … STORED` on both sides and is **never transported**; it is recomputed by
the target's own column definition. `manifest_hash` and `hash` acquire a `CHECK (octet_length(…) =
32)` in change 4 that the source did not have — a strengthening, and therefore a possible migration
failure on a source holding a malformed hash. That is a correct refusal and §9.2 counts it as a
verification finding rather than a bug.

Import order is forced by `PRAGMA foreign_keys = ON`, which change 5's probe **hard-refuses** to run
without (its requirement *"the durability probe verifies library-controlled pragmas instead of deployer-supplied server settings"*, which also states why: without it `ON DELETE CASCADE` turns GC into a
silent no-op): chunks, then manifests, then the junction. §13 E4 measures the alternative — with
`foreign_keys = OFF` a dangling junction row inserts happily, `PRAGMA integrity_check` reports `ok`,
and only `PRAGMA foreign_key_check` names it.

### 5.2 Watermarks

Straight copy of `(kind, key, value, updated_at)`. `WITH (fillfactor = 90)` has no target analogue
and needs none — change 4 records migration `005` as a no-op and retires the hard invariant with its
reason (its requirement *"migration 005 is retained as a recorded no-op and its hard invariants are retired with reason"*). No ordering invariant exists to preserve
(`003_watermarks.ts:21-24`; `Formal/STORAGE_ALGEBRA.md` §3 — last-write-wins, deliberately not
event-sourced).

### 5.3 TransactionHistory and the identifiers junction

`transaction_history`'s four data columns copy directly. `identifiers text[]` explodes into change
4's `<s>_transaction_history_identifiers(wallet_id, tx_hash, identifier)`, whose primary key
**deduplicates**, and which has no position column and therefore **does not preserve order**. Change
4's containment predicate is explicitly set-semantic — its requirement *"identifier containment is a junction table whose predicate is row-subset-of-the-finalizing-set"* requires the `<@`
("contained by") direction with *"duplicates and order in the row's identifiers … ignored"* — so the
*predicate* is unaffected.

**The read path — Q-2, now answered by change 4, and the answer lengthens the disclosure list.**
Change 4's `design.md` §19.2 rules invariant **I-7**: `getAll()`/`get()` SHALL derive `identifiers`
from `entry`, and SHALL cross-check the derived set against the junction rows **as a set, not as a
sequence**. Its reason is one this change should adopt rather than merely accept:

> *`entry` is the digested representation. Change 5's `dg` column covers `transaction_history.entry`
> … Deriving the returned value from `entry` means the answer the caller receives is covered by a
> value digest; deriving it from the junction means the answer is covered by nothing. The junction is
> a **derived index**, and an index should be **verified, not trusted**.*

Three consequences for this change, and only the first is the obvious one:

1. **The import's obligation is now precisely stated and mechanically checkable.** The junction must
   agree, as a set, with the imported `entry.identifiers`. That is a target-internal invariant, so
   the verifier can check it **without reference to the source at all** — and §9.5 is re-keyed to
   derive the expectation from the imported `entry`, so it exercises the same path the read does
   rather than a parallel one that could pass while the read fails.
2. **Order and multiplicity survive after all.** Because the returned array comes from `entry`, and
   `entry` is transported verbatim (§6.2), a caller's `getAll().identifiers` is byte-identical
   across the migration. What change 4's earlier junction-reading option would have cost —
   reordering to code-point order and collapsing duplicates — is not paid. §11.4's second disclosure
   item is therefore **not** about identifiers.
3. **It is instead about lifecycle**, which is the divergence change 4 found while it was in there
   (§1.4). Today `decodeRow` reads the lifecycle object from the JSON while the column is selected
   and never compared, so the two can already disagree; after I-7 the column SHALL equal
   `entry.lifecycle.status`, and a mismatch is a detected corruption. A source in which they already
   disagree is a **Class 1 refusal** under §4.5 — the source has two answers and the target keeps
   one — and that is a state a consumer can be sitting on right now with nothing having ever told
   them.

### 5.4 What is produced, not imported

`<s>_migrations` is written by change 4's lineage as it runs; the source's `_migrations` rows are
**never** imported (§1.5). `<s>_writer_generation`'s singleton seed row is written by change 4's
migration `007` (its `design.md` §12.1), which explicitly notes that change 3's registration is an
`UPDATE` and would match zero rows without it. `size_bytes` is generated. Any digest column change 5
introduces is computed by the importer at write time, not transported — §9.4.

---

## §6. Value fidelity: the rule, and the naive exporter that violates it

### 6.1 The rule

> **The migration SHALL NOT introduce a loss of fidelity that the source did not already have, and
> SHALL NOT claim to remove one it did.**

This is the honest bar. It is falsifiable, it does not require the migration to be better than the
system it replaces, and it forbids the specific class of bug that a "just read it in JavaScript and
write it out" exporter produces.

### 6.2 `jsonb` — transport the source's own canonical text, never a JavaScript round trip

**[measured]**, §13 E5. A `jsonb` value whose text is
`{"fees": 12345678901234567890123, "ratio": 0.1000000000000000055511151231257827}` becomes, after
`JSON.parse` then `JSON.stringify`, `{"fees":1.2345678901234568e+22,"ratio":0.1}`. Both numbers are
destroyed. `jsonb` stores numbers as `numeric` — arbitrary precision — and JavaScript's `number` is
an IEEE-754 double.

Therefore the exporter emits `value::text` — PostgreSQL's own canonical rendering of the stored
`jsonb` — and the importer binds that text verbatim into the target's `TEXT` column. Change 4 already
requires the target to store *"the `JSON.stringify` output stored verbatim, never passed through
`json()`/`jsonb()`"* (its requirement *"each PostgreSQL type class maps to exactly one SQLite declared type"*); an imported value is the analogous thing one layer up —
`jsonb`'s own text, stored verbatim, never passed through `JSON.parse`.

**The honest caveat, stated because it would otherwise look like a claim to have fixed something:**
a consumer reading such a value back through `TemporalKV.get()` *still* loses the precision, because
the adapter parses JSON on the read path on both engines. The migration preserves at rest exactly
what PostgreSQL preserved at rest. It does not make an unrepresentable number representable, and
§9.3's replay compares parsed values, so it cannot see this either. What the migration must not do —
and what a JavaScript exporter would do — is destroy the *stored* bytes, which is destruction of
data a future reader could recover.

**Textual note:** `jsonb`'s text rendering inserts a space after `:` and after `,`, where
`JSON.stringify` does not, and `jsonb` normalises key order and removes duplicate keys at *write*
time — which is already true of today's database and is therefore not a migration effect. An imported
value and a natively-written value can therefore differ byte-for-byte while being the same JSON.

**This is exactly where the two integrity artifacts must be kept apart, and an earlier draft of this
document conflated them** — it described a single object computed "over the bytes as stored, through
one canonicalisation", which cannot exist: canonicalising the input means the preimage is no longer
the stored bytes. Gate G-11 ruled the correction and §8.3 now states it. In short: the **stored-value
digest** (`dg`) is over the stored bytes with **no** canonicalisation, and is persisted; the
**transport-fidelity comparison** is over **canonically parsed values**, is not persisted, and is not
a digest. Neither is ever computed by comparing a `jsonb` rendering to a `JSON.stringify` rendering,
which would report a difference where there is none.

### 6.3 `bytea` → `BLOB`

`bytea` is an octet string with no encoding. The bundle transports it in PostgreSQL's `hex` output
form under a pinned `bytea_output` session setting (§8.2), and the importer binds a `Buffer`. Change
1's bind normalisation (requirement *"every bound parameter is normalised before it reaches the binding"*) passes `Buffer`/`Uint8Array` through as bytes. Chunk sizes
are bounded well below `SQLITE_MAX_LENGTH` (1 GB, recorded by change 1) by the checkpoint chunker
(`design/design.md` §3), and neither binding offers incremental BLOB I/O — a fact change 1 hands
over, and the reason §10.2 bounds a single import transaction by row count rather than by byte count.

### 6.4 `timestamptz` → epoch-millisecond `INTEGER`

Change 4 maps `timestamptz` to `INTEGER` holding epoch milliseconds (its requirement *"each PostgreSQL type class maps to exactly one SQLite declared type"*), and its
requirement *"every table is STRICT and a wrong-typed write is rejected, not coerced"* names the failure this prevents in the strongest available terms: an ISO-8601
string bound into an epoch-ms `INTEGER` column makes `WHERE ts <= :t ORDER BY ts DESC LIMIT 1` return
the latest row for *every* `:t`, so **Law T3 becomes silently false with the mechanised proof still
green**. An importer is exactly the code that would bind a string.

The exporter therefore renders the integer in SQL, not in JavaScript, and does so in a form
independent of `DateStyle`, `TimeZone` and `IntervalStyle` (§8.2 pins all three anyway, belt and
braces). §14 task 2.3 requires a fixture that round-trips a known instant and asserts exact equality
rather than approximate, because the expression's exactness is version-dependent: `EXTRACT(EPOCH FROM
timestamptz)` returns `numeric` from PostgreSQL 14 and `double precision` before it. **[inference]**
an epoch-microsecond magnitude near 1.7 × 10¹⁵ is below 2⁵³, so a double represents it exactly and
both forms agree; that inference is precisely what the fixture must discharge, and the bundle records
the source `server_version_num` so an importer can refuse a version the fixture never covered.

`kv_current.updated_at` and `kv_history.valid_from`/`valid_to` are already ms-quantised (§1.1 fact 3);
`ckpt_*.created_at` and `watermarks.updated_at` use `now()` and carry microseconds. Truncating those
to milliseconds loses sub-millisecond precision that **no caller can observe** — the driver returns
them as a JavaScript `Date`, which is ms-quantised, so the loss already happens at the driver boundary
today. This is a §6.1 "loss the source already had", and the importer records the truncation in the
bundle manifest rather than silently performing it.

### 6.5 Text hazards

Change 1's requirement *"text that SQLite stores incorrectly is rejected at the boundary"* requires text that SQLite stores incorrectly to be rejected at the
boundary: a NUL byte desynchronises `length()`, and a lone surrogate becomes U+FFFD. PostgreSQL
cannot store either — `src/postgres/temporal-kv.ts:308-313` rejects both on input, calling it *"the
same NUL/lone-surrogate check every other string input gets"*. **[inference]** a source produced only
through the adapter therefore contains neither. The importer applies change 1's boundary check to
every imported string anyway, for the same reason it verifies S1–S6: `psql` is not the adapter.

---

## §7. Topology: where the export runs, and why

### 7.1 The problem the ruling has to solve

Change 1's task 1.1 removes the `postgres` dependency **outright**, once the adapters and
change 6 have ported. A migration tool that reads PostgreSQL from JavaScript would put it straight
back — into `dependencies` or `devDependencies`, and either way into
`docs/supply-chain/inventory.md`, which pins `postgres@^3.4.9` with a hash at `:26` and gates it in
`supply-chain.yml`. Worse, it creates an ordering trap: a consumer at 1.0.0 who has *not yet
migrated* would need a tool that ships in 1.0.0 but links a driver 1.0.0 removed.

### 7.2 The ruling

> **The export side is SQL text, executed by the consumer's own `psql`. UmbraDB does not re-acquire
> a PostgreSQL client library. The import and verification sides are pure UmbraDB + SQLite and read
> only the bundle.**

Reasons, in descending weight:

1. **It dissolves the ordering trap.** Static `.sql` files ship in the 1.0.0 tree with no dependency
   at all, so a consumer sitting at 1.0.0 can still export from the PostgreSQL database they have
   not yet left. Any JavaScript exporter has to exist at a version that still links a driver, which
   is the version the consumer is trying to leave.
2. **The dependency stays removed.** Change 1's `design.md` §8 (correction R-1) is unambiguous that `postgres` is
   removed outright and *"is **not** retained scoped to `chain-archive-sync/`"*. Re-adding it here for
   a one-shot tool would reverse the sprint's single cleanest supply-chain result.
3. **The consumer demonstrably has the tooling.** `docs/CONTRACT.md:114-121` already instructs them to
   run `pg_dump`. A deployment running PostgreSQL has a PostgreSQL client.
4. **The moving part on the untestable side is as small as possible.** §0.2: this change cannot test
   against a live server. A declarative `SELECT` whose output format is pinned by `SET` statements is
   far easier for a builder to validate against a fixture — and far easier for a hostile auditor to
   read — than an exporter with connection handling, type decoding and error translation.
5. **It works against PostgreSQL versions UmbraDB never pinned.** Consumers on the git-tag channel
   chose their own server. A driver would have to tolerate that range; `psql` already does, and §8.2
   records the version in the bundle so the importer can refuse an untested one.

**Counter-considerations, recorded rather than hidden.** A `psql` script cannot run Zod validation
(`design/design-interfaces.md` §1.4), cannot raise a typed error, and reduces a failure to a shell
exit code and a partial file. The mitigation is structural, not rhetorical: the bundle is
self-describing and checksummed (§8.3), so a truncated or partially-written export is *detected by
the importer* rather than imported; and every validation the adapter would have run is run by the
importer on the way in (§6.5, §4.3). A second consideration: `psql` output is text, so the bundle is
larger than a binary dump would be. That is a size cost, not a correctness cost, and §15 Q-3 leaves
compression as an implementation choice rather than pretending to have measured it.

### 7.3 What the tool actually is

Three entry points, none exported from the barrel:

| Step | What runs it | What it touches |
|---|---|---|
| `export` | the consumer's `psql`, driven by a shipped shell script or run by hand from documented SQL | reads the source; writes the bundle |
| `import` | `npm run migrate:import -- --bundle <dir> --to <file>` | reads the bundle; creates and writes the target |
| `verify` | `npm run migrate:verify -- --bundle <dir> --db <file>` | reads both; writes nothing |

`import` runs `verify` before publishing the target (§10.1); `verify` is separately re-runnable
afterwards, which is what lets a consumer re-check before deleting the source.

---

## §8. The bundle

### 8.1 Shape

A directory containing `manifest.json` and one data file per source table, each a `COPY … TO STDOUT`
stream with an explicit column list. Not a single archive: the per-table split makes a truncated
export detectable per table, makes the import streamable without random access, and keeps the
`psql` invocation for each table independently re-runnable.

### 8.2 `manifest.json` — what makes the bundle self-describing

At minimum: bundle format version; the UmbraDB version that produced the export SQL; source
`server_version_num` and `sqlite_version()`-analogue metadata; the source `schema` name and the
target `schema` prefix it is destined for; the pinned session settings the export ran under
(`bytea_output`, `DateStyle`, `TimeZone`, `IntervalStyle`, `client_encoding`, `standard_conforming_strings`);
whether the export ran inside a single `REPEATABLE READ` transaction and that transaction's identity;
per-table row count; per-table content digest (§8.3); the timestamp-truncation record from §6.4; and
the set of table names present, so a bundle missing a table is a refusal rather than an empty import.

**Snapshot consistency is a requirement of the export, not an accident of it.** The whole export runs
inside one `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction. `docs/CONTRACT.md:122-133`
already states why for the checkpoint tier: manifests reference chunks by content hash *across
separate tables*, and *"never dump the chunk tables and manifest tables in separate,
independently-timed passes."* The same argument applies with more force to `kv_current` and
`kv_history`, whose S3 relationship spans two tables and is broken by any write landing between two
independently-timed reads.

### 8.3 The digest, and its relationship to change 5's

Two distinct things, and conflating them is the mistake to avoid.

- **Change 5's digest** is a *per-value* commitment stored **in the target database**, computed and
  written in the same statement as the value (its requirement *"the value digest is a versioned, length-prefixed, row-bound SHA-256 computed adapter-side"*), re-verified on every read, and
  raising `ValueIntegrityError`/`VALUE_INTEGRITY` on mismatch (`:145-147`). Since this change was
  drafted, change 5 has **settled it**: SHA-256, 32 raw bytes, with preimage binding and
  `NULL`-means-not-yet-computed semantics; the DDL is change 4's `dg BLOB` column, added by migration
  `009_value_digests` with `CONSTRAINT <s>_<table>_dg_len CHECK (dg IS NULL OR octet_length(dg) =
  32)`, over exactly three wallet-tier columns — `kv_event.value`, `watermarks.value` and
  `transaction_history.entry` (change 4 `design.md` §19.3). `ckpt_chunks`/`ckpt_manifests` remain
  deliberately outside it, covered by their existing content-addressed SHA-256 rather than a second,
  redundant digest (change 5 requirement *"integrity coverage follows the three-class corruption model with an explicit column-level coverage set"*).
- **This change's table-level commitment** lives **in the bundle manifest** and is compared
  source-to-target. It is a fold, in a defined row order (§8.3), over each row's `dg` where the row is
  covered. *"Canonical" here qualifies the **order rows are enumerated in**, never the bytes any
  digest is taken over* — that ambiguity is what G-11 caught, and the two senses must not be allowed
  back into one sentence.
- **The transport-fidelity comparison** is the third thing in this area and the one that legitimately
  *is* canonicalising: it compares a source value against its imported counterpart as parsed values,
  is never persisted, and is not a digest. It is specified as its own requirement so it cannot be
  mistaken for either of the above.

**The reuse rule:** where a row is in change 5's coverage set, the per-row input to this change's
fold **is change 5's per-value digest** — which the importer computes anyway, because change 5
requires it written in the same statement — concatenated with the row's non-value columns. This
change therefore introduces **no new hash function, no new coverage set, no new error code and no
second integrity mechanism**. It picks no algorithm; it inherits change 5's.

**One consequence of the coverage set being exactly three columns, worth stating because it is easy
to misread as a gap.** `ckpt_chunks.data` carries no `dg`, so this change's fold over the chunk table
uses the chunk's own content address — which is a SHA-256 over the same bytes, already stored as the
primary key, and already re-verified on load by `src/postgres/checkpoint-store.ts:65-66,366-368`. The
chunk tier is therefore the *best*-covered tier in the migration, not the worst: its digest is not
merely computed at import, it is the table's key.

**Canonical order, and why it is not the obvious one.** A sequential digest needs a defined row
order, and the obvious `ORDER BY` is wrong: PostgreSQL orders `text` by the database's `lc_collate`,
commonly not code-point order, while SQLite orders by `BINARY`, which is (change 4's
`design.md` §11.4). §13 E6 measures the target side — SQLite `BINARY` gives
`["A","B","a","z","é","Ａ","😀"]`, matching a code-point sort and **not** matching JavaScript's
default `Array.prototype.sort()`, which places `😀` before `Ａ`. The export therefore orders every
text-keyed table by `… COLLATE "C"`, which is PostgreSQL's byte-order collation and agrees with
SQLite `BINARY`; the target side orders by its default. The digest is then order-defined on both
sides and comparable. This also means the digest is *deliberately* blind to the collation reorder of
§11.4 — it commits to the multiset of rows, not to the order a consumer will observe from `listKeys`.

---

## §9. Verification

### 9.1 The ladder

Five rungs. **All are mandatory; a pass is the conjunction.** Change 5's requirement *"the verification pass runs the structural check, the digest sweep, the schema digest and the invariants together, and never refuses"* sets the
precedent for the shape — *"The operation SHALL NOT report an overall pass when either half fails"*.

| Rung | What it checks | What it assumes |
|---|---|---|
| **V1 Lineage** | the target's `<s>_migrations` contains exactly change 4's lineage, applied in order, and nothing else | that change 4's lineage is the correct target schema |
| **V2 Structure** | `PRAGMA integrity_check` **and** `PRAGMA foreign_key_check` both clean; change 5's `verifyIntegrity` reports a pass on both halves | that SQLite's b-tree checks are sound; **not** that page contents are undamaged (§9.6) |
| **V3 Cardinality** | per-table row counts against the manifest, with the derived arithmetic of §9.2 | that the manifest's counts describe the source (V5b, or the builder's fixture) |
| **V4 Content** | per-table digests equal, computed as §8.3 | change 5's digest algorithm; that a digest agreement implies value agreement |
| **V5 Behaviour** | (a) exhaustive point-in-time replay against a bundle-derived oracle; (b) where a live source is reachable, the same probes against it | (a) assumes the bundle faithfully renders the source; (b) assumes nothing about the bundle |

**The checked/assumed column is the deliverable, not decoration.** A consumer who runs only V1–V5a —
the normal case, after the source has been quiesced but before it is deleted — has verified that the
*import* was faithful to the bundle and that the target's behaviour matches the bundle's semantics.
They have **not** independently verified that the *export* faithfully rendered the source; that
assumption is discharged by the builder's fixture (§14), not by the consumer's run. Say this in the
migration notes in those words. A consumer who can still reach the source runs V5b and closes it.

### 9.2 Cardinality, written out because the arithmetic is not one-to-one

- `count(kv_event) = count(kv_history) + count(kv_current)`, and per key
  `count(kv_event WHERE key=K) = kv_current.version` for that key. The second is the stronger check
  and catches a per-key truncation that the total would mask.
- `count(<s>_transaction_history_identifiers) = ` the number of **distinct** `(wallet_id, tx_hash,
  identifier)` triples in the source array column, which is not the sum of array lengths. The
  exporter emits the distinct count so the importer is not asked to re-derive it from data it may
  have mis-parsed.
- `count(<s>_migrations)` is **not** compared to the source's (§1.5). `<s>_writer_generation` is
  expected to hold exactly one row and is **not** compared to anything in the source.
- `ckpt_chunks.size_bytes` is generated; V4 excludes it from the digest input on both sides.
- A refusal caused by change 4's new `CHECK (octet_length(hash) = 32)` on a malformed source hash
  (§5.1) is reported as a **verification finding with the offending key**, not as an import crash.

### 9.3 Point-in-time replay is exhaustive, and this is provable

Fix a key `K`. The source's `getAt({at: T})` is piecewise constant in `T` with breakpoints only at
`{valid_from_v} ∪ {valid_to_v} ∪ {C.updated_at}`; the target's is piecewise constant with breakpoints
only at `{written_at_v}`. Let `B` be the union — a finite set, of size at most `2n+1` for a key with
`n` versions. Between two consecutive members of `B` both functions are constant, so **agreement on
`B`, plus agreement at one interior point of each gap between consecutive members, plus agreement at
one point below `min(B)`, is equivalent to agreement at every instant.** The domain is discrete —
`AsOf.at` is a `Date`, millisecond-quantised, and change 2's `written_at` is milliseconds — so
"interior point" is concrete: for consecutive `b_i < b_{i+1}`, probe `b_i` and, if
`b_{i+1} − b_i > 1`, probe `b_i + 1`. Probe `min(B) − 1` for the below-first-version case, which must
return `null` on both sides.

The probe count is therefore at most `2|B| + 1` per key, i.e. **linear in the number of stored
versions** — the same order as the import itself. Exhaustive replay over *all* keys is affordable by
construction, and this change requires it. Sampling is not a default; it becomes admissible only if
change 1's measurement gate establishes, under its declared conditions, that exhaustive replay on a
representative wallet database exceeds a stated wall-clock budget — and the fallback is then a
*stated* sampling rule with a recorded coverage fraction, never an unstated one.

The `{kind: "version"}` addressing path is finite by construction: probe every `v` in `1 … n`, plus
`0` and `n+1`, which must return `null`.

### 9.4 Content verification does not invent a second mechanism

Restating §8.3's rule because it is the brief's explicit coordination requirement: the migration's
content check folds change 5's per-value digests. It does not choose a hash, does not add a digest
column, does not extend change 5's coverage set, and does not add an error code — change 5's
`VALUE_INTEGRITY` is reserved for a *read-path* digest mismatch (its requirement *"every covered column is verified on every read, with no opt-out"*) and a
migration mismatch is a different situation, which its requirement *"no frozen error code is repurposed and no contention code is added"* forbids re-pointing an
existing code at. A migration mismatch is a tool diagnostic and a non-zero exit.

**The `dg` column is computed, never transported.** PostgreSQL has no `dg` column, so there is
nothing to import into it; the importer computes each value's digest as it writes, which is what
change 5 requires anyway. Two things follow. First, `dg` is excluded from V3's cardinality
comparison and from the *source* side of V4's fold, for the same reason `size_bytes` is (§9.2) — it
is a target-side derived value with no source counterpart. Second, and less obvious: a `dg` that is
`NULL` after import is not a benign not-yet-computed state, it is an **import defect**, because the
importer wrote the row and had the value in hand. V2 therefore asserts `dg IS NOT NULL` across all
three covered columns, which change 5's `NULL`-means-unverified semantics permit in general but which
this change's import path never legitimately produces.

### 9.5 The tier-specific replays

Beyond `getAt`, three probes that a digest cannot substitute for:

- **`get()` for every key**, which is what catches the §4.2 collision class and any confusion between
  the live row and the newest history row.
- **`listKeys` over the empty prefix per `(ns, scope)`**, compared as a *set* against the source's key
  set, plus a separate assertion that the target's order is code-point order. The set comparison is
  the correctness check; the order assertion is what makes the §11.4 disclosure falsifiable rather
  than promissory. Change 2's requirement *"listKeys streams without materializing the full result set first, and orders results correctly"* already requires an idle-deadline stream release to
  fault rather than end normally, *"which is why the release is specified as a fault, not as an
  ending"* — a truncated key list during verification must therefore surface as an error, not as a
  short set.
- **`WalletStateEnvelopeStore.load()` for every `(walletId, networkId)`**, comparing the decoded
  envelope. §1.2: a byte-faithful chunk copy satisfies the decoder, and a subtly-wrong one raises
  `EnvelopeCorruptError` (`src/postgres/wallet-state-envelope.ts:65-66`) — which makes this the
  cheapest available end-to-end check on the checkpoint tier.
- **`getAll()` per wallet**, compared field by field. Under I-7 the `identifiers` array is compared
  **exactly** — order and multiplicity included — because it now derives from `entry`, which is
  transported verbatim (§5.3 consequence 2). This is a stronger check than the set comparison the
  junction-reading alternative would have permitted, and it is available for free.
- **The two I-7 cross-checks, asserted against the target alone**, because both are target-internal
  invariants and neither needs the source:
  - the junction rows for each `(wallet_id, tx_hash)` equal, **as a set**, the identifiers derived
    from that row's imported `entry` — change 4's `design.md` §19.2 is explicit that this is a set
    comparison and that *"comparing as ordered lists would raise spurious faults on a re-ordered
    `entry` array"*;
  - the `lifecycle` column equals `entry.lifecycle.status`.

  Running these as part of migration verification matters beyond confirming the import: they are the
  **first time either has ever been evaluated** against a consumer's data (§1.4). A source that has
  been silently inconsistent for months surfaces here, and §4.5 classes it as a Class 1 refusal
  rather than letting the migration pick a side.

### 9.6 What verification cannot do

`v1.0.0-sqlite-durability-contract/design.md` §2 measured it: 64 corrupted bytes in a
checkpointed main database, `integrity_check → ok`, `quick_check → ok`, corrupted row returned as
data. §13 E4 adds the foreign-key analogue. So V2 is a *structural* check that is blind to content,
and V4 is a *content* check that is blind to structure, and neither is a substitute for the other —
which is precisely why change 5's `verifyIntegrity` reports both and refuses to pass on either half
alone. Verification detects; it does not repair. UmbraDB has no `pg_amcheck` analogue and the SQLite
CLI's `.recover` is not a dependency of this package (change 5's `design.md` §2.3). The consumer's
repair path is: keep the source, re-run the import.

---

## §10. Failure, idempotence, resumability, and publication

### 10.1 Atomic publication

The importer writes to a distinct in-progress path — `<target>.importing` and its `-wal`/`-shm`
sidecars — runs the full V1–V5 ladder against it, closes the handle after a checkpoint, and only then
renames it to `<target>`. **A file at the live path is therefore either absent or fully verified.**
There is no state in which a half-imported database presents itself as complete.

Two details this rests on: the WAL sidecars follow the filename, so the checkpoint-and-close must
precede the rename or the renamed database silently reverts to an older state — change 5's
requirement *"the backup primitive is established by measurement on the ruled binding, not asserted"* names exactly this footgun (*"restoring without it silently reverts the database to
an arbitrarily older state while reporting a healthy integrity check"*), and it applies to a rename
just as it applies to a copy. And the rename is a filesystem operation, so it is atomic on the local
non-networked filesystem change 5's probe already requires (its requirement *"the durability probe verifies library-controlled pragmas instead of deployer-supplied server settings"*) and is
**not** guaranteed on the filesystems that probe refuses — which is one more reason those refusals are
hard and not warnings.

### 10.2 Failure inside the import

The import runs in bounded transactions rather than one whole-file transaction. Change 1's
`design.md` §3.4 records that `withTransaction` holds a *whole-database* write mutex, and change
5's requirement *"the unbounded transaction hold is documented as unbounded and instrumented rather than claimed to be bounded"* requires a transaction open past a configured threshold to raise a diagnostic.
A single import transaction would trip that by design. Batching is bounded by **row count**, not byte
count, because change 1's parameter ceiling is 32,766 and neither binding offers incremental BLOB I/O
(§6.3); the batch size is a §10.6 blocked decision, not a number chosen here.

A failure mid-import leaves the `.importing` file in an arbitrary state. That file is **deleted, not
resumed by default**, and the source is untouched, so the recovery is to re-run.

### 10.3 Idempotence is free; resumability is conditional

**Idempotence.** Re-running the import against the same bundle produces the same target, because the
target is created fresh, the lineage is deterministic, and every imported value comes from the bundle
rather than from the clock (§3.4) or from any other ambient state. The one ambient input is change 4's
`<s>_writer_generation` seed, which is a constant (`design.md` §12.1). This makes re-run the primary
recovery mechanism and it is unconditional.

**Resumability** — restarting a partial import in place rather than from the beginning — is *not*
promised unconditionally, and inventing a resume protocol on an unmeasured duration would be exactly
the kind of guess the brief forbids. The decision rule:

> Let **D** be the wall-clock duration of a complete import of a representative wallet database,
> measured under change 1's declared gate conditions (`v1.0.0-sqlite-engine-core` requirement *"every performance-dependent decision is blocked on measurements taken on a real filesystem under declared conditions"*) on
> a real non-memory-backed filesystem, at the shipped `journal_mode` and `synchronous`, with dataset
> size relative to host page cache recorded.
> **IF D is within the stated re-run budget recorded in the migration notes, THEN** re-run from a
> fresh target is the supported recovery and no resume protocol ships.
> **IF D exceeds it, THEN** a resume protocol ships, and it SHALL be per-table-and-position
> checkpointing over the bundle's canonical order (§8.3), never a "detect what is already there"
> heuristic against the target.
> **WHILE D is unmeasured**, neither branch is taken and no implementation task depending on the
> choice starts.

### 10.4 No bulk-load tuning

The import does **not** lower `synchronous`, does **not** disable `foreign_keys`, and does **not**
disable change 2's triggers. Each is a hard refusal or a correctness mechanism, not a knob:
`synchronous = OFF` and `foreign_keys` not `ON` are both hard refusals of change 5's durability probe
(its requirement *"the durability probe verifies library-controlled pragmas instead of deployer-supplied server settings"*), and §13 E4 shows what turning foreign keys off costs — a dangling reference
that `integrity_check` reports as `ok`. The triggers are the backstop behind the §4.3 pre-flight and
are the only database-level witness that the imported chain is well-formed. If import throughput ever
becomes a real constraint, it is resolved under §10.3's measurement, not by removing a check.

**Also not disabled:** `PRAGMA ignore_check_constraints`. Change 2's `design.md` §9 measured that
it disables `CHECK` but **not** triggers, so it would half-work — which is worse than not working.

### 10.5 The importer is inside the `INSERT OR REPLACE` guard

Change 2's requirement *"the adapter never issues INSERT OR REPLACE against the event log"* bans `INSERT OR REPLACE`/`REPLACE INTO` against the event log and
requires an automated guard over *"the adapter's SQL"*, enforced at build time. The importer's SQL is
in scope of that guard, stated here so it is not read out of scope by a builder who reasonably thinks
"adapter" means `src/sqlite/`. The importer's inserts are plain `INSERT`, and a rejection is a
refusal, never an overwrite.

### 10.6 Decisions blocked on change 1's gate

| id | Decision | Blocked on |
|---|---|---|
| **M-1** | Import batch size (rows per transaction) | change 1 B-8's stream batch policy and the gate's `synchronous` cell |
| **M-2** | Whether a resume protocol ships (§10.3) | the duration **D**, measured under gate conditions |
| **M-3** | Whether exhaustive replay (§9.3) is affordable or a stated sampling rule is needed | the same measurement |
| **M-4** | Whether the bundle is compressed (§15 Q-3) | nothing in this change; an implementation choice with no correctness content |

None is settled here, and no requirement in `spec.md` asserts a value for any of them.

---

## §11. Rollback, the transition window, and the written contracts

### 11.1 Is migration mandatory?

Yes, to run 1.0.0. The program's decision is full replacement and `src/postgres/` is deleted; there is
no PostgreSQL backend at 1.0.0 to stay on. The transition window is not a dual-backend period — it is
the continued availability of the `0.9.5` git tag, which is immutable and remains installable by the
exact command in `README.md:17`. A consumer who does not want to migrate stays at 0.9.5 and receives
no 1.0.0 fixes. That is the honest statement and it belongs in the migration notes.

### 11.2 The rollback is the source database, and it is stronger than the policy requires

Because the migration **never writes to PostgreSQL** — no marker table, no `_migrations` row, no
`ANALYZE`, no advisory lock held past the read transaction — the source is a complete, current,
untouched backup of the pre-migration state, at zero additional cost and with no restore step.
`docs/STABILITY.md:40-42` (commitment 3) says *"Downgrading a database that has been migrated to a
newer major back to an older UmbraDB major is **not supported**: take a backup before a major upgrade
… if you need a rollback option"*, and `docs/CONTRACT.md` §2 repeats it. This change is **consistent
with** that and delivers more than it asks: the backup is not something the consumer must remember to
take, it is the thing they already have.

The read-only property is therefore not a nicety; it is the rollback mechanism and it is a
requirement, verifiable by inspecting the export SQL for any statement that is not `SET`, `BEGIN`,
`SELECT`, `COPY … TO`, `COMMIT` or `ROLLBACK`.

### 11.3 Consistency with the written contracts

`docs/STABILITY.md:34-36` already contemplates this exact event: *"A new UmbraDB **major** MAY ship a
schema change that requires running a forward-only migration (`runMigrations`) against an existing
database before the new major will operate against it."* The 0.9.5 → 1.0.0 boundary is such a
boundary. Two clarifications the documents need, both of which are **change 5's text to write** and
are handed over here rather than drafted:

1. `docs/CONTRACT.md` §2's third bullet — the application-rollback paragraph — describes redeploying
   older application code against an already-migrated *PostgreSQL* schema. At 1.0.0 the analogue is
   redeploying 0.9.5 against the untouched PostgreSQL database, which is a different mechanism and a
   better outcome. §2 needs one sentence saying so.
2. The engine change is a *forward migration of the database file*, not a `runMigrations` call
   against an existing one. §2's wording assumes the latter. It needs a clause covering the case
   where the forward migration produces a new file rather than altering one.

Neither is drafted here: change 5 owns `docs/CONTRACT.md` and its own non-goals says so.

### 11.4 The differences that survive a faithful migration

A migration can be perfectly faithful and still change what a consumer observes, in two places. Both
are disclosed **before** the migration runs, in the migration notes, not discovered after.

1. **`listKeys` ordering.** Change 4's requirement *"listKeys ordering is code-point order and the one-time resume-cursor reorder is disclosed"* moves ordering to `BINARY`; its
   requirement *"listKeys ordering is code-point order and the one-time resume-cursor reorder is disclosed"* already records that a resume cursor persisted under a PostgreSQL locale
   collation *"MAY skip or repeat keys exactly once, at the migration boundary"* and that this
   *"SHALL be stated in the migration notes rather than discovered"*. **This change is the owner of
   those migration notes**, and §13 E6 measures the target ordering so the disclosure states a fact
   rather than an expectation. Change 4 records the hazard as *"free pre-tag … a live-migration data
   hazard post-tag"*; with the owner's answer, the live-migration case is the real one, and the
   mitigation is one sentence in the notes: discard persisted `listKeys` resume cursors across the
   migration.
2. **Not `identifiers` — `lifecycle`.** Change 4's I-7 ruling (§5.3) means the returned `identifiers`
   array derives from `entry` and is therefore byte-identical across the migration, so the
   reordering hazard is **not** incurred. What replaces it on the list is a consequence of the same
   invariant: post-migration, a `lifecycle` column that disagrees with `entry.lifecycle.status`
   becomes a **detected, non-retryable fault on read**, where today it is invisible because
   `decodeRow` never compares them (§1.4). A consumer whose database has drifted will see reads start
   failing that previously returned a value — and the value they previously returned was the JSON's,
   which is the one I-7 keeps, so nothing is *lost*; what changes is that the disagreement is now
   loud. Disclose it as a behaviour change with that framing, and note that the migration itself
   refuses such a source up front (§4.5), so the fault should never first appear in production.

Both items are consequences of invariants that make the store *stricter*. Neither is a regression,
and the notes should say so in those words rather than listing them as damage.

---

## §12. The three distribution channels

### 12.1 Git tag

`README.md:14-17`. The consumer changes `#v0.9.5` to `#v1.0.0` in their own dependency spec. Their
procedure: stop the writer; run the export SQL with `psql` against the still-running PostgreSQL;
upgrade the dependency; run `migrate:import`; run `migrate:verify`; point `createClient` at a file
path; restart. The dependency upgrade may happen before or after the export — §7.2 reason 1 is
precisely that this ordering does not matter.

### 12.2 Repository clone

`README.md:22-26`. Same procedure, with the whole tree already on disk, so the export SQL and both
tools are present without any packaging step. This is the channel a builder tests against.

### 12.3 Docker images — what UmbraDB has, and what it does not

**UmbraDB builds and publishes no container image.** A search of the repository for any `Dockerfile`,
compose file, or image build/publish step returns nothing outside `package-lock.json`'s transitive
`docker-compose` entry (Testcontainers) and design documents referencing *Midnight upstream* images.
The five CI workflows are `bench-smoke.yml`, `conformance.yml`, `lean.yml`, `pack-smoke.yml`,
`supply-chain.yml`.

So the image is the consumer's, built around UmbraDB. UmbraDB cannot change an artifact it does not
produce. What it *can* do, and what this change requires, is publish the procedure the image builder
follows and name the hazards that are specific to a container and are **not** specific to the other
two channels:

1. **The PostgreSQL service becomes the migration source, not something to remove first.** An
   upgrade that rebuilds the image without PostgreSQL, then starts it, destroys the source before the
   export runs. The procedure exports **first**, from the running old image or from its volume
   attached to a one-off container.
2. **The SQLite file must be on a volume, not the container's writable layer.** A writable-layer
   database is destroyed by the next image update — the container-native restatement of "this is your
   wallet's durable state".
3. **The volume's filesystem is a hard gate, not a preference.** Change 5's durability probe
   **refuses outright** on `tmpfs`, `ramfs`, `nfs`, `cifs`/`smb`, `v9fs` and un-allowlisted `fuse`
   (its requirement *"the durability probe verifies library-controlled pragmas instead of deployer-supplied server settings"*), *"based on the reported filesystem type, not on a timing measurement"*. A
   `tmpfs` mount, a bind mount from a network share, and several desktop container runtimes' default
   virtualised mounts all land in that set. This will be the most common container-channel failure and
   it fails at `runMigrations`, loudly — which is the correct behaviour and must be documented as
   expected rather than reported as a bug.
4. **The entrypoint must not run `runMigrations` against a fresh file before the import.** It would
   create a valid, empty, fully-migrated database, and the wallet would appear to have lost
   everything. The procedure runs `migrate:import` as a one-shot job whose success gates the
   application's first start.
5. **Where the PostgreSQL server lives changes the export step.** If it is a sidecar service, the
   export runs against it over the network as usual. If PostgreSQL is bundled *inside the same image*
   as the application, the export must run inside a container built from the **old** image, because
   the new one has no server. This is the case the sprint has no visibility into, and it is §15 Q-1.

---

## §13. Evidence measured for this change

Command, verbatim. The script is `/root/umbradb-c7-evidence/probe.mjs`; databases were created under
`/root` (ext4), confirmed by `df -hT /root` → `/dev/sdd ext4`.

```
$ wsl -e bash -lc 'cd /root/umbradb-c7-evidence && node probe.mjs'
runtime node v24.18.0 | sqlite 3.53.1
E1 sqlite_sequence after explicit-id import: {"seq":91}
E1 id assigned to the first post-import insert: {"id":92}
E1 collides with an imported id? false
E2 no-AUTOINCREMENT: first post-import id {"id":92} -> after deleting the max, next id {"id":8} (reused: true )
E3 in-order import of k1 v1,v2,v3: ACCEPTED
E3 descending (newest-first) import of k2: REJECTED {"code":"ERR_SQLITE_ERROR","errcode":1811,"message":"UB_T1_VERSION: version must be exactly prev+1"}
E3 history-only import of k3 (live version omitted, then appended later): REJECTED {"code":"ERR_SQLITE_ERROR","errcode":1811,"message":"UB_T1_VERSION: version must be exactly prev+1"}
E3 two versions of k4 sharing a millisecond: REJECTED {"code":"ERR_SQLITE_ERROR","errcode":1811,"message":"UB_T4_CLOCK: written_at must strictly exceed the previous version"}
E3 interleaved import: k5 v1, k6 v1, k5 v2 (different keys interleaved): ACCEPTED
E3 gap manufacture -- source intervals were [1000,2000) and [3000,inf); derived: [{"version":1,"valid_from":1000,"valid_to":3000},{"version":2,"valid_from":3000,"valid_to":null}]   <- THE FINDING
E3 gap manufacture -- getAt(at=2500) was NULL in PostgreSQL, is now: {"version":1}                                                                                                  <- THE FINDING
E4 dangling junction row inserted with foreign_keys=OFF: {"c":1}
E4 integrity_check: [{"integrity_check":"ok"}]
E4 foreign_key_check: [{"table":"ckpt_manifest_chunks","rowid":null,"parent":"ckpt_chunks","fkid":0}]
E5 jsonb::text from PostgreSQL : {"fees": 12345678901234567890123, "ratio": 0.1000000000000000055511151231257827}
E5 after JSON.parse->stringify  : {"fees":1.2345678901234568e+22,"ratio":0.1}
E5 byte-identical? false
E6 SQLite BINARY order : ["A","B","a","z","é","Ａ","😀"]
E6 JS default sort     : ["A","B","a","z","é","😀","Ａ"]
E6 JS codePoint sort   : ["A","B","a","z","é","Ａ","😀"]
```

**Reading, and the honest caveats.**

- **E1/E2** settle §5.1. `AUTOINCREMENT` follows the largest explicitly-inserted id, so preserving
  PostgreSQL `bigserial` values needs no `sqlite_sequence` fixup. Without `AUTOINCREMENT` the next id
  after deleting the maximum is a **reuse** — which is why change 4's choice is load-bearing for a
  store whose junction rows reference those ids.
- **E3** settles §2.3 and §4.1. Note specifically that *interleaving different keys is accepted*, so
  the import may stream in bundle order rather than being forced to group by key — and that the two
  rejection messages are change 2's own assertion text, so a mid-import trigger abort is diagnosable
  but names no source row, which is why §4.3 puts the check in a pre-flight pass.
- **E4** settles §5.1's ordering requirement and §9.6's blindness claim: `integrity_check` returns
  `ok` on a database with a dangling foreign key; only `foreign_key_check` names it. V2 needs both.
- **E5** settles §6.2. Note the second number: `0.1000000000000000055511151231257827` is the exact
  decimal value of the double nearest `0.1`, and PostgreSQL's `numeric` stores it exactly; JavaScript
  prints it back as `0.1`, which is a *different* stored value.
- **E6** settles §8.3's ordering rule and §11.4's disclosure. `BINARY` matches code-point order and
  does **not** match `Array.prototype.sort()`, which change 4's `design.md` §11.4 also warns about.

**The caveat that applies to all six.** These were run through `node:sqlite` (SQLite 3.53.1) because
`better-sqlite3` is not installed in this worktree and `npm install` is forbidden by the authoring
brief. Every one is a property of the SQLite core rather than of a binding — trigger firing,
`sqlite_sequence` maintenance, `foreign_key_check`, `BINARY` collation — and none touches an API
surface where the bindings differ. **They must nonetheless be re-confirmed on the ruled binding
(`better-sqlite3@13.0.2`, SQLite 3.53.4) as task 0.2 before any of them is relied on in
implementation.** E5 involves no SQLite at all. **Nothing here was measured against PostgreSQL**
(§0.2), and no number here is a performance figure.

---

## §14. The fixture a builder needs

Two fixtures, because they discharge different obligations. Both use
`@testcontainers/postgresql` with `postgres:17-alpine`, which the repository already depends on
(`test/postgres/setup.ts:3`, `test/smoke/pack-install.mjs:164-165`).

**Fixture A — faithful.** Seeded **only through the 0.9.5 public API** (`PgTemporalKV.put`,
`PgCheckpointStore.save`, `PgWatermarks.set`, `PgTransactionHistoryStorage`, `PgWalletStateEnvelopeStore.save`),
never by raw SQL, so the state is one a real consumer could have. It must contain: keys with 1, 2 and
many versions; a key whose value exercises the §6.2 numeric cases; a manifest referencing one chunk
hash at two positions (`002_checkpoint_store.ts:44-49`); a chunk shared by two manifests; a transaction
history row with duplicate identifiers and one with an empty array; a watermark; and an envelope.
Fixture A is what discharges V5b and, with it, the export's fidelity assumption in §9.1.

**Fixture B — adversarial.** Seeded by raw SQL to produce, one per case, each refusal state of §4: a
gap; a history/current version collision; a non-dense version chain; a history row whose key has no
`kv_current` row; a non-monotone `valid_from`; a `manifest_hash` that is not 32 bytes. Each must
produce a refusal naming the precondition and the key, and **must produce no target database**.
Fixture B is the negative control without which Fixture A's green means nothing —
`v1.0.0-sqlite-durability-contract` uses the same discipline and the commitments seat's R4(iv)(5)
demands it: *"a migration is precisely the situation in which a re-executed test goes green for the
wrong reason."*

---

## §15. Open questions with owners

| id | Question | Owner | Why it is cheap to close now |
|---|---|---|---|
| **Q-1** | For the docker-image channel: which images exist, and does any bundle PostgreSQL *in the same image* as the application rather than as a sidecar? §12.3 case 5 is unwritable without the answer, and §12.3 cases 1–4 are procedures UmbraDB can publish blind but cannot validate. **Still open.** *Corrected under gate G-17: an earlier draft of this row claimed "four independent readers … each searched and found no `Dockerfile`". That was **one search counted four times** — and change 4, named as one of the four, makes no such claim anywhere. It was the same over-claim shape the sprint corrected three times in code premises, applied here to evidence.* Stated once, from the one search that was actually run: **I searched this repository for any `Dockerfile`, compose file, or image build or publish step, and found none** (§12.3 records the command and its scope). Nothing in the plan asserts a docker artifact the project builds. This is an owner question, not a specification gap. | **owner** (inventory) + this change (procedure) | The image contract is covered by no freeze today. After the tag it becomes a published expectation on a channel with no chokepoint to reach it. |
| ~~**Q-2**~~ | ~~Does change 4's `getAll()` read `identifiers` from `entry` or from the junction?~~ **CLOSED** by change 4's `design.md` §19.2 (invariant I-7): derive from `entry`, cross-check the junction as a set. Consequences folded into §1.4, §4.5, §5.3, §9.5 and §11.4. The answer preserved the `identifiers` array exactly and put **lifecycle** on the disclosure list in its place. | change 4 — answered | — |
| **Q-3** | Is the bundle compressed, and if so how? §7.2's counter-consideration is a size cost with no correctness content. | this change, at implementation | No requirement depends on it; recorded so it is a choice rather than an omission. |
| **Q-4** | Should a migration refusal be observable to a consumer as a machine-readable code, given that §4.4 keeps it out of `docs/ERROR-CATALOG.md`? | **change 5** (catalog) + this change | A tool exit code plus a structured report file is sufficient and adds nothing to the frozen surface. Recorded because a consumer scripting the migration will want a discriminator, and the alternative — adding a code — is forbidden by change 5's requirement *"no frozen error code is repurposed and no contention code is added"*. |
| **Q-5** | Has any consumer already run `psql` against their own UmbraDB schema? §3.2 verifies S1–S6 *because* the answer is unknowable; if the owner can establish it is "no", the refusal paths remain but their expected frequency drops from "plausible" to "defect only". | **owner** | Changes nothing in the specification. It changes how loudly the migration notes need to talk about refusals. |
