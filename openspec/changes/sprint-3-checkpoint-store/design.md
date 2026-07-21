# Design — Sprint 3: CheckpointStore

Implementation-level detail for `src/interfaces/checkpoint-store.ts` against the schema
`design/design.md` §3 already specifies, with two corrections (§2 below) and one addition (the
persisted manifest-metadata columns `manifest_hash`/`label`, §5) this change makes at a
level of detail that document never went to, and against `Formal/STORAGE_ALGEBRA.md` §2's Laws
C1/C2a/C2b.

## 0. Package layout

```
src/
  postgres/
    checkpoint-store.ts     PgCheckpointStore (this sprint)
    migrations/
      002_checkpoint_store.ts
    migrate.ts                (existing, modified: migrations array gains 002)
test/
  postgres/
    checkpoint-store.test.ts             unit tests
    checkpoint-store.property.test.ts    P6-P8 from Formal/STORAGE_ALGEBRA.md §5
```

No new top-level directory, matching Sprint 1/2's own "no abstraction-for-its-own-sake nesting"
rationale (`sprint-1-setup-and-temporal-kv/design.md` §1).

## 1. Chunking

`save(walletId, networkId, data, opts)`:

1. Validate `opts` against `SaveCheckpointOptionsSchema` (`ValidationError` before any chunking
   or backend work, per `src/interfaces/checkpoint-store.ts`'s own `@throws` doc).
2. Split `data` into fixed-size windows of `opts.chunkSize ?? DEFAULT_CHUNK_SIZE` bytes, last
   window shorter if `data.byteLength` isn't an exact multiple. **`DEFAULT_CHUNK_SIZE = 4 * 1024 *
   1024` (4 MiB) — a Sprint-3 implementation decision, not derived from any prior document**:
   nothing in `design/design.md`, `design/design-interfaces.md`, or `Performance/` states a
   default (the schema only bounds it at 16 MiB, `design-interfaces.md` line 667). 4 MiB is
   chosen as a conservative middle point — large enough to keep the chunk count (and thus
   `ckpt_manifest_chunks` row count) manageable for a multi-MB wallet-state blob, small enough
   that a single-byte change in a large payload doesn't force re-hashing/re-storing the whole
   blob as one chunk. **Revisit under Milestone 4** once real checkpoint-size measurements exist
   (`Performance/README.md`) — this is an placeholder-with-rationale, not a benchmarked choice,
   and must not be read as one.
3. SHA-256-hash each chunk (`node:crypto`'s `createHash("sha256")` — already the hash function
   `design/design.md` §3's `hash bytea PRIMARY KEY` column assumes; no new dependency).
4. Within one transaction (§8 below): upsert every chunk (`INSERT ... ON CONFLICT (hash) DO
   UPDATE SET created_at = now()`, `design/design.md` §3, unchanged), claim the next sequence
   number (§2's `ckpt_sequence_counters`), insert the manifest row — **with `complete = true`,
   `manifest_hash` (§5), and `label` (§5) written explicitly in the INSERT's column list;
   `complete` must never be left to the schema's `DEFAULT false`, see §2.3 for why that would be
   a total silent failure, not a cosmetic one** — insert one `ckpt_manifest_chunks` row per chunk
   **at its position in the split** (§2's fix), and commit.

## 2. Schema — two corrections to `design/design.md` §3

### 2.1 `ckpt_manifest_chunks` needs an explicit position

**The bug in the existing design.** `design/design.md` §3's junction table is:

```sql
CREATE TABLE ckpt_manifest_chunks (
  manifest_id bigint NOT NULL REFERENCES ckpt_manifests(id),
  chunk_hash  bytea  NOT NULL REFERENCES ckpt_chunks(hash),
  PRIMARY KEY (manifest_id, chunk_hash)
);
```

`load()` must reconstruct `data` by concatenating chunks **in the order `save()` split them** —
the manifest is, per the interface doc, "the ordered chunk-hash list." A `PRIMARY KEY
(manifest_id, chunk_hash)` cannot represent a manifest that references the same chunk hash more
than once at two different positions. This is not a hypothetical: any payload with a repeated
fixed-size run (padding, zero-fill, a repeated sub-structure landing exactly on a chunk boundary)
produces exactly this shape. Two ways this fails depending on how task 1.1's insert is written:
an unguarded multi-row `INSERT` raises a primary-key violation and `save()` fails outright on
otherwise-valid input; an `INSERT ... ON CONFLICT (manifest_id, chunk_hash) DO NOTHING` "fixes"
that by silently dropping the second occurrence — `load()` then reconstructs a payload **missing
a chunk-length's worth of bytes at the wrong position**, with no error, no integrity failure
(the surviving chunks each still hash-verify individually), and a `byteLength` that would only be
caught if a caller happens to check it against an independently-known expected length.

**Fix**, applied here (not yet in `design/design.md` — this change is the first to specify it):

```sql
CREATE TABLE ckpt_manifest_chunks (
  manifest_id bigint  NOT NULL REFERENCES ckpt_manifests(id) ON DELETE CASCADE,
  position    integer NOT NULL,          -- 0-indexed order within this manifest's payload
  chunk_hash  bytea   NOT NULL REFERENCES ckpt_chunks(hash),
  PRIMARY KEY (manifest_id, position)
);
CREATE INDEX ckpt_manifest_chunks_by_hash ON ckpt_manifest_chunks (chunk_hash);
```

The same fix declares `manifest_id`'s FK `ON DELETE CASCADE` — also a correction, not a
convenience: `design/design.md` §3's original declaration has no delete action (Postgres's
default, `NO ACTION`), so `prune`'s step-1 `DELETE FROM ckpt_manifests` (§3 below) would raise
SQLSTATE 23503 (`foreign_key_violation`) for any manifest that still has junction rows — which
is *every* manifest `save()` ever produced. As originally written, GC could never delete a
single manifest; the two-step pass was dead on arrival. `CASCADE` is chosen over the alternative
(an explicit `DELETE FROM ckpt_manifest_chunks WHERE manifest_id IN (...)` prepended inside the
same transaction) because it is one less statement to keep in lockstep with step 1's retention
predicate, and because the cascade removes the junction rows *in the same statement* as the
manifest delete — atomically producing exactly the "no junction row references this hash" state
step 2's `NOT EXISTS` reclaim check needs to see within the same pass.

`chunk_hash` is no longer part of the primary key, so the same hash can legally occupy two
different positions in one manifest. The GC reclaim query (§3 below) is unaffected — it only
needs "does any live manifest reference this hash at all," which `ckpt_manifest_chunks_by_hash`
still answers directly, duplicates included (`NOT EXISTS (SELECT 1 FROM ckpt_manifest_chunks mc
WHERE mc.chunk_hash = c.hash)` is correct regardless of how many positions reference a hash).
`load()`'s reconstruction query becomes `... ORDER BY position` instead of relying on insertion
order (which `bytea` primary-key btree order never guaranteed anyway — the old schema's
correctness for single-occurrence manifests was already accidental, not by any stated ordering
contract).

### 2.2 `seq` needs an explicit allocator

`design/design.md` §3 declares `ckpt_manifests.seq bigint NOT NULL` but specifies no mechanism
for assigning it — `CheckpointSequence`'s own doc (`src/interfaces/checkpoint-store.ts` line 5)
only states "monotonic per (walletId, networkId) and start at 1," a caller-facing contract with
no backing allocator. TemporalKV's `version` doesn't transfer as a pattern here: that column is
assigned per-row via a plain `UPDATE ... SET version = version + 1 WHERE key = ...`, relying on
Postgres's own row lock for serialization (`Formal/STORAGE_ALGEBRA.md` Law T1) — but
`ckpt_manifests` has no single row per `(w, net)` to lock against; each `save()` call *inserts a
new row*, so there is no existing row an `UPDATE` could serialize on.

**Fix**: a small counter table, claimed via the same atomic upsert-increment `design/design.md`
§3's chunk dedup already uses the shape of (an `INSERT ... ON CONFLICT ... DO UPDATE` that both
creates the row on first use and atomically advances it thereafter, with `RETURNING` handing the
claimed value back in the same statement — no separate read-then-write):

```sql
CREATE TABLE ckpt_sequence_counters (
  w        text   NOT NULL,
  net      text   NOT NULL,
  next_seq bigint NOT NULL DEFAULT 2,   -- next call to claim gets 1; see the RETURNING math below
  PRIMARY KEY (w, net)
);
```

```sql
INSERT INTO ckpt_sequence_counters (w, net) VALUES ($1, $2)
ON CONFLICT (w, net) DO UPDATE SET next_seq = ckpt_sequence_counters.next_seq + 1
RETURNING next_seq - 1 AS claimed_seq;
```

First call for a given `(w, net)`: the `INSERT` branch fires, `next_seq` takes its `DEFAULT 2`,
`RETURNING next_seq - 1` yields `1` — matching the interface's documented "start at 1." Every
subsequent call for the same key hits the `DO UPDATE` branch, which Postgres executes under the
same per-row lock semantics as any other `UPDATE` — and, because this claim runs mid-transaction
(before the manifest and junction inserts, §1 step 4), the row lock is held **until the claiming
save's whole transaction commits or rolls back**, not merely until the claiming statement
completes: a second concurrent claim for the same `(w, net)` blocks behind the first save's
*entire write phase* (the same serialization argument Law T1 already relies on for TemporalKV's
`version` column, just held for a longer span). So claims are gapless and monotonic under
concurrent callers by construction, not by an application-level retry loop; the cost, stated
plainly, is that concurrent `save` calls to the same `(walletId, networkId)` fully serialize —
acceptable for this project's stated single-process, single-writer deployment
(`src/interfaces/transaction-lease.ts`'s own revision note), and different `(w, net)` pairs are
unaffected (distinct counter rows, distinct locks). A rolled-back `save` releases the lock and
undoes its increment along with the rest of its transaction, so a failed save consumes no
sequence number. This table is genuinely new schema, not present in `design/design.md` §3 at
all; it exists solely to make `seq` allocation well-defined.

One boundary detail, easy to miss because it is invisible in the SQL: `next_seq`/`seq` are
`bigint` columns, and Sprint 1's `createClient` configures the driver's bigint mapping globally
(`types: { bigint: postgres.BigInt }`, `src/postgres/client.ts`) — so every `seq` value the
driver hands back is a JS `bigint`, while `CheckpointSequence` is `number`
(`src/interfaces/checkpoint-store.ts` line 5). The adapter coerces the driver's `bigint` to a JS
`number` at this boundary — asserting it is within `Number.MAX_SAFE_INTEGER` first — before the
value reaches *any* interface-typed return (`CheckpointSummary.sequence` from `save`/`load`/
`history`, `PruneResult.prunedSequences`); nothing downstream of that coercion handles `bigint`.

### 2.3 `complete`: kept, and explicitly written `true` by every `save()`

`design/design.md` §3's `ckpt_manifests.complete boolean NOT NULL DEFAULT false` and its prune
query's `WHERE m.complete` filter are both kept unchanged — and **`save()`'s manifest `INSERT`
sets `complete = true` explicitly in its column list (§1 step 4), never relying on the schema
default**. That explicit write is load-bearing, not style: transaction atomicity governs whether
the manifest row *exists*, not what its columns *contain*. An `INSERT` that omitted the column
would commit — atomically, durably — a row with `complete = false` via the `DEFAULT`, and since
`load` (§4), `history` (§5), and `prune` (§3) all filter on `complete`, every subsequent read
for every wallet would find zero rows: the store would be totally, silently non-functional while
every `save` call appears to succeed. (Flipping the schema default to `true` instead is
deliberately *not* the fix — the default stays `false` and the INSERT stays explicit, so a
future write path that forgets the column fails visibly in tests rather than becoming
implicitly-complete by default.)

With that explicit write in place, `complete` is always `true` for any manifest `save()`
produces — because `save()` *writes* `true`, and because `save()` is a single all-or-nothing
transaction (manifest insert + every junction row insert, per §1 above) there is additionally no
code path that could leave a partially-written manifest visible at all. The read-side filter is
therefore redundant-but-harmless defense-in-depth, not a load-bearing mechanism this module
relies on. It is kept rather than dropped because (a) it is part of the schema
`design/design.md` §3 already specifies and this sprint implements that document rather than
redesigning it, and (b) it costs nothing to leave in place for a hypothetical future
incremental/streaming write path that this interface does not have today.
**No task in this change may add a code path that ever sets it `false`** — if one is ever needed,
that is new interface surface requiring its own design/spec update, not something to bolt on here.

## 3. `prune` — two-step GC, `design/design.md` §3's pass plus §2.1's cascade

```sql
-- Precondition, enforced in application code before this SQL runs (ValidationError, not a SQL
-- guard): retainCount >= 1. retainCount = 0 makes OFFSET evaluate to -1, which Postgres rejects
-- outright.
-- 1. prune old superseded manifests for this (w, net). Deleting a manifest CASCADEs its
--    ckpt_manifest_chunks rows in the same statement (ON DELETE CASCADE, §2.1) — load-bearing
--    twice over: without it this DELETE raises SQLSTATE 23503 on every manifest that has
--    junction rows (i.e. always), and with it the junction rows are already gone when step 2's
--    NOT EXISTS runs, in the same pass.
DELETE FROM ckpt_manifests m
WHERE m.w = $1 AND m.net = $2 AND m.complete
  AND m.seq < (
    SELECT seq FROM ckpt_manifests
    WHERE w = $1 AND net = $2 AND complete
    ORDER BY seq DESC OFFSET ($3 - 1) LIMIT 1
  )
RETURNING seq;

-- 2. reclaim chunks no longer referenced by any surviving manifest, past the grace window
-- (unchanged 15-minute constant, design/design.md §3). RETURNING lets the adapter sum
-- reclaimedBytes without a second query. Grace-window rationale (design/design.md §3, stated
-- there in full): save's `ON CONFLICT ... DO UPDATE SET created_at = now()` refresh is
-- load-bearing for this DELETE's safety — without it, a chunk being re-referenced by a
-- not-yet-committed save (whose manifest row READ COMMITTED cannot yet see, so NOT EXISTS is
-- satisfied) would keep its ORIGINAL created_at and be reclaimed out from under that save.
DELETE FROM ckpt_chunks c
WHERE c.created_at < now() - interval '15 minutes'
  AND NOT EXISTS (
    SELECT 1 FROM ckpt_manifest_chunks mc WHERE mc.chunk_hash = c.hash
  )
RETURNING octet_length(c.data) AS reclaimed_bytes;
```

Both statements run inside the same transaction (§8), manifest prune first — step 1's cascade
removes the pruned manifests' junction rows in the same statement, so a chunk a pruned manifest
referenced becomes reclaimable to the *second* statement in the *same* pass, matching
`design/design.md` §3's stated ordering. This transaction runs at **READ COMMITTED** — Postgres's
default, and what `withTransaction` uses when no `isolation` option is passed (§8) — and that is
a stated dependency, not an incidental default: the grace-window TOCTOU argument above relies on
READ COMMITTED's per-row re-evaluation semantics, under which the reclaim `DELETE` rechecks each
candidate row against the latest committed state and simply skips rows a concurrent transaction
changed. Under `repeatable read` or `serializable`, the same race would instead surface as
SQLSTATE 40001 (a Sprint 2 `TransactionFaultError`, `faultKind: "serialization-failure"`) rather
than a correct skip. `PgCheckpointStore` must not pass an `isolation` override for this internal
transaction — and no caller can, since the interface deliberately exposes no `tx`/isolation
option (§8). `PruneResult.prunedSequences` is the first query's
`RETURNING seq` list; `reclaimedChunks`/`reclaimedBytes` are the second query's row count and
summed `reclaimed_bytes`. Per `src/interfaces/checkpoint-store.ts`'s own `PruneResult` doc: a
chunk that lost its last reference in this call but hasn't cleared the grace window yet is
correctly *not* reclaimed here and does not appear in this call's counts — that is the documented,
intentional behavior, not a bug to fix.

`retainCount` is rejected with `ValidationError`, before either statement runs, unless it is a
safe integer `>= 1` — **tightened per Codex GPT-5.6 Sol's audit, twice over**: a bare
`retainCount < 1` check alone lets `NaN`, `Infinity`, and fractional values (e.g. `1.5`) through
unrejected (`NaN < 1` evaluates `false` in JS), each of which would reach the SQL `OFFSET` clause
and fail as a raw driver/Postgres conversion error instead of the documented `ValidationError`;
the first fix's `Number.isInteger(retainCount)` closes that but not magnitude
(`Number.isInteger(1e20)` is also `true`, and an `OFFSET` that large is meaningless and still not
a `ValidationError`). The adapter's actual guard is
`Number.isSafeInteger(retainCount) && retainCount >= 1`. (`src/interfaces/checkpoint-store.ts`
doesn't declare a Zod schema for `prune`'s bare `retainCount: number` parameter the way
`save`/`history` get one for their options object, so this adapter validates it directly rather
than skipping validation because no schema object exists for it.)

## 4. `load` — full verification, no exceptions

Per the interface's own doc (`CheckpointRecord`, `src/interfaces/checkpoint-store.ts`): `load`
**always** fully rehashes and verifies every chunk, with no fast/unverified path and no
`integrityVerified` flag on the result (a `false` value there could never be observed, since the
method throws instead of returning one — a prior interface-design review already found and
removed that dead field, cited in that file's own doc comment).

**Both queries below run inside one `withTransaction(fn, { isolation: "repeatable read" })` call
(§8) — not against the pooled `sql` directly.** Found by Codex GPT-5.6 Sol's audit: `load` is
read-only but not single-statement (a manifest lookup, then a separate ordered chunk-fetch), and
running the two as independent pooled statements can race a concurrent `prune`. If a `prune`
commits between them, its `ON DELETE CASCADE` (§2.1) can remove exactly the junction rows the
second statement is about to fetch, so `load` would silently reconstruct an empty or truncated
payload instead of raising `CheckpointNotFoundError` or a corruption error — contradicting the
interface's own "each method is an atomic unit of work" doc. REPEATABLE READ takes its snapshot at
the transaction's first statement, so both statements see one consistent instant regardless of
what a concurrent `prune` commits in between: either the manifest and all its chunks are visible
together (the pre-prune state), or the manifest itself is already gone
(`CheckpointNotFoundError`) — never a torn view where the manifest exists but its chunks don't.
This is a separate transaction from, and independent of, `save`/`prune`'s own READ COMMITTED
(§3) — isolation is a per-call `TransactionOptions.isolation` choice (Sprint 2), not a
connection-wide setting.

```sql
-- 1. resolve the target manifest (walletId, networkId, sequence?) — latest if sequence omitted.
--    manifest_hash and label MUST be projected here (fixed after Codex's audit found this
--    query, as originally drafted, selected only id/seq/created_at — leaving nothing for the
--    manifest_hash verification below to compare against, and no label for the returned
--    CheckpointRecord/CheckpointSummary): this row is the ONLY place either value lives, and
--    both are needed downstream in this same call, not just for history's summaries.
SELECT id, seq, created_at, manifest_hash, label FROM ckpt_manifests
WHERE w = $1 AND net = $2 AND complete
  AND ($3::bigint IS NULL OR seq = $3)
ORDER BY seq DESC LIMIT 1;
-- 0 rows => CheckpointNotFoundError(walletId, networkId, sequence)

-- 2. fetch this manifest's chunks in order. mc.chunk_hash MUST be projected alongside c.hash:
--    in the missing-chunk case c.hash is NULL by construction, so the manifest's own recorded
--    hash is the only place the missing chunk's identity exists.
SELECT mc.position, mc.chunk_hash, c.hash, c.data
FROM ckpt_manifest_chunks mc
LEFT JOIN ckpt_chunks c ON c.hash = mc.chunk_hash
WHERE mc.manifest_id = $1
ORDER BY mc.position;
```

For each row: `c.hash IS NULL` (the `LEFT JOIN` found no matching `ckpt_chunks` row at all, since
a plain `JOIN` would just silently omit that position instead of surfacing it) →
`ChunkMissingError(mc.chunk_hash.toString("hex"))` — the error's hash comes from the manifest's
recorded `mc.chunk_hash`, necessarily, since `c.hash` is `NULL` exactly when this error fires,
hex-encoded before it reaches the `ContentHash`-typed field (the same rule §5 states, restated
here at its actual construction site per Codex's audit — the earlier draft stated this rule only
in §5 and left it to be inferred here); else
re-hash `c.data` and compare to `mc.chunk_hash` → mismatch is
`ChunkIntegrityError(actualRehash.toString("hex"), mc.chunk_hash.toString("hex"))`, with the
manifest-recorded `mc.chunk_hash` (not `c.hash`) as the `expectedHash`, both hex-encoded — both
error paths source their "expected" identity from the same authoritative column, the manifest
entry the interface doc defines them against. Concatenate `data` across all positions in
ascending order into the returned `CheckpointRecord.data`. A gap in `position` (e.g. a manifest
with positions `0, 1, 3` and no `2`) is a `ManifestCorruptError` — this should be structurally
impossible given `save()` always inserts a dense `0..n-1` range in the same transaction as the
manifest row, so this check exists as a defense-in-depth integrity assertion, not an expected
runtime path (mirrors §2.3's stance on `complete`: kept because it's cheap and catches an
out-of-band corruption, not because normal operation is expected to hit it).

**`manifest_hash` verification (added per Codex GPT-5.6 Sol's audit — closes a real gap:
`ManifestCorruptError`'s own interface doc scopes it to "the manifest itself failed its own
shape/hash validation," but nothing described here actually performed that hash validation).**
After every chunk is rehashed and confirmed present (above) and the dense-position check passes,
`load` recomputes SHA-256 over the concatenated, position-ordered `mc.chunk_hash` bytes — the
identical computation `save()` performs at write time (§5) — and compares it to the resolved
manifest's stored `manifest_hash`. A mismatch is `ManifestCorruptError`, and it catches something
the per-chunk integrity check and the position-density check cannot catch between them: a
junction-row *substitution* where every referenced chunk individually exists and hash-verifies,
and the position range is still dense, but the *set* of chunk hashes the junction rows reference
no longer matches what `save()` actually wrote (e.g. an out-of-band edit swapping one valid
chunk reference for a different, equal-length, also-valid one). Neither prior check inspects the
chunk-hash *sequence as a whole* the way this one does.

## 5. `history` — pagination

```sql
-- manifest_hash and label projected here too, same fix and same reason as §4's manifest-resolve
-- query — every returned CheckpointSummary needs both, and this table row is their only source.
SELECT seq, id AS manifest_id, created_at, manifest_hash, label
FROM ckpt_manifests
WHERE w = $1 AND net = $2 AND complete
  AND ($3::bigint IS NULL OR seq < $3)   -- opts.before cursor
ORDER BY seq DESC
LIMIT $4;                                 -- opts.limit, default 50 per HistoryOptionsSchema
```

Reuses the existing `ckpt_manifests_lookup` index (`design/design.md` §3:
`ON ckpt_manifests (w, net, complete, seq DESC)`) — already shaped for exactly this
access pattern, no new index needed. `byteLength`/`chunkCount` per `CheckpointSummary` come from
`SELECT count(*), coalesce(sum(octet_length(c.data)), 0) FROM ckpt_manifest_chunks mc JOIN
ckpt_chunks c ON c.hash = mc.chunk_hash WHERE mc.manifest_id = $1` per returned manifest (or a
single query joining and aggregating across the page — an implementation choice for task 2.1,
not a correctness question either way). `manifestHash` — `CheckpointSummary.manifestHash` per the
interface — is a content hash **of the manifest's own ordered chunk-hash list**, not stored as a
column in `design/design.md` §3's schema; computed as `SHA-256(concat of chunk_hash bytes in
position order)` at write time and persisted as a new `ckpt_manifests.manifest_hash bytea NOT
NULL` column (added in the migration, §6) so `history()`/`load()` don't need to recompute it from
the junction table on every read. `label` — `CheckpointSummary.label`, the optional free-text
label the interface documents as "surfaced in history()" (`SaveCheckpointOptionsSchema`) —
likewise has no home anywhere in `design/design.md` §3's schema: persisted as a new
`ckpt_manifests.label text` (nullable) column, written from `opts.label` at `save()` time and
returned verbatim by `history()`/`load()` (`NULL` maps to an absent `label` field, never coerced
to an empty string). These two columns are the one *addition* this change makes to
`design/design.md` §3's tables (scoped explicitly in proposal.md's "What changes" §1, alongside
the two corrections) — both exist because the interface's `CheckpointSummary` requires data that
schema simply never stored.

**Same torn-read fix as `load` (§4), same reason.** The page query and each returned manifest's
aggregate query both run inside one `withTransaction(fn, { isolation: "repeatable read" })` call
(§8) — a `prune` committing between the page query and a page entry's aggregate query must not be
allowed to produce a `byteLength`/`chunkCount` for a manifest that reflects a different instant
than the manifest list itself did.

**Two driver-level coercions, both found missing by Codex GPT-5.6 Sol's audit, both mirroring
§2.2's `seq` coercion:**
- `count(*)` and `sum(octet_length(...))` return `bigint` under Sprint 1's global
  `types: { bigint: postgres.BigInt }` mapping (`src/postgres/client.ts`) — the adapter coerces
  both to JS `number` (asserting `Number.MAX_SAFE_INTEGER`, exactly as §2.2 does for `seq`)
  before populating `CheckpointSummary.byteLength`/`chunkCount`.
- `manifest_hash`/`chunk_hash` are `bytea`, but `ContentHash` (`src/interfaces/checkpoint-store.ts`)
  is a hex string — every `bytea` value crossing into a `ContentHash`-typed field is hex-encoded
  (`Buffer.from(value).toString("hex")`) at this boundary before it reaches an interface-typed
  value, never left as a raw `Buffer`. This applies here (`CheckpointSummary.manifestHash`) and in
  §4 (`ChunkMissingError`/`ChunkIntegrityError`'s hash fields, both sourced from `mc.chunk_hash`).

## 6. Migration (`002_checkpoint_store.ts`)

Schema-qualified via `sql(schema)`, matching `001_temporal_kv.ts`'s established pattern exactly —
`ckpt_chunks`, `ckpt_manifests` (now including `manifest_hash bytea NOT NULL` and `label text`,
§5), the corrected `ckpt_manifest_chunks` (`(manifest_id, position)` PK and the `ON DELETE
CASCADE` manifest FK, §2.1), `ckpt_sequence_counters` (§2.2), and both indexes
(`ckpt_manifests_lookup`, `ckpt_manifest_chunks_by_hash`). No trigger, no extension — this module
needs neither `btree_gist` nor any `plpgsql` function, unlike TemporalKV.

## 7. Error translation — no additions to `src/postgres/errors.ts`

`ckpt_manifests_lookup`/PK/FK violations are not expected on any normal path (dedup and sequence
allocation are both upsert-based, never raw `INSERT` that could collide) — no new SQLSTATE
mapping is needed beyond what `translatePostgresError` already handles (`ConnectionError` for
driver-level failures). `CheckpointNotFoundError`/`ChunkMissingError`/`ChunkIntegrityError`/
`ManifestCorruptError` are all raised directly by `PgCheckpointStore`'s own application-level
checks (§3-§4 above), not translated from a SQLSTATE — they have no database-level enforcement
mechanism the way TemporalKV's exclusion constraint does, matching
`Formal/STORAGE_ALGEBRA.md` §2's own characterization of this module (application-verified
integrity via SHA-256, not a database constraint).

## 8. Composing Transaction/Lease (Sprint 2 dependency)

Per `src/interfaces/checkpoint-store.ts`'s interface doc: "`save`/`prune` deliberately do NOT
accept a `tx` option" — `PgCheckpointStore` is constructed with a `PgTransactionLeaseLayer`
instance (Sprint 2, `origin/sprint-2-transaction-lease`) and calls its own `withTransaction`
internally for every `save`/`prune` call, using that sprint's `resolveTransaction(handle): ISql`
registry export to get the real `postgres.js` transaction-scoped `sql` for its own queries — the
same composition pattern Sprint 2's own design.md §2 describes for any future adapter, now
exercised for the first time by a real consumer other than `PgTemporalKV`. `load`/`history` are
read-only but each is two round-trips, not one (§4/§5) — **revised per Codex GPT-5.6 Sol's
audit**, which found that running those two statements independently against the pooled `sql`
(the original design here, matching `PgTemporalKV.get`/`getAt`'s single-statement precedent,
which doesn't actually apply to a *multi*-statement read) lets a concurrent `prune` produce a torn
result. Both methods instead wrap their own multi-statement read in
`withTransaction(fn, { isolation: "repeatable read" })` — see §4/§5 for the exact race this closes
and why REPEATABLE READ specifically (not just any transaction) is what's needed.

**Sprint 2 has since merged to `main`** (`3db3c8d`, "Merge sprint-2-transaction-lease:
Transaction/Lease implementation, 2-round audit cycle") — the dependency this section originally
described as "unmerged, accepted explicitly" (proposal.md) is now real, released code, not a
draft interface. `resolveTransaction` is confirmed present exactly as assumed, as an
adapter-internal export of `src/postgres/transaction-lease.ts` (now on `main`), **not** part of
the public `src/interfaces/transaction-lease.ts` file — by design, per that interface's own "that
plumbing never appears in this interface" rule.

**Cancellation (`opts.signal`) — corrected against the real, merged `withTransaction`, which does
NOT provide what an earlier draft of this section claimed.** Every `CheckpointStore` method
accepts an optional `AbortSignal`, and all four methods reject with `AbortError` up front, before
issuing any statement, when the signal is already aborted at call time — this part holds. **What
does not hold, found by reading the actual merged `src/postgres/abort.ts`/`transaction-lease.ts`
rather than assuming Sprint 2's interface doc described the implementation completely:**
`withTransaction` forwards `opts.signal` through `withAbort`, and `withAbort`'s own doc comment is
explicit that it is "a pre-check-only contract: an abort that fires AFTER `fn()` has been
dispatched has no effect on that in-flight call" — unlike `acquireLease`/`withLease`, which build
genuine mid-wait cancellation via a dedicated `raceAgainstAbort` helper (real `Query.cancel()`,
because a lock wait can block indefinitely), `withTransaction` has no equivalent. There is no
`Query` handle `PgCheckpointStore` could call `.cancel()` on either way — `withTransaction`'s
callback boundary only exposes the transaction-scoped `sql`/`TransactionHandle`, never the
individual in-flight `Query` objects `raceAgainstAbort` needs.

**Consequently, this design makes no claim beyond what `withTransaction` actually delivers**: for
`save`, `load`, `history`, and `prune` alike, `opts.signal` is checked once, before the call's
`withTransaction` invocation begins — an already-aborted signal rejects with `AbortError` and
issues no statement, exactly as stated above — but a signal that aborts *after* the call has
begun has **no defined effect**: the call proceeds to its natural completion (success, or its own
unrelated failure) regardless of the later abort, and does not itself reject with `AbortError`
just because the signal fired. This is an accepted limitation inherited directly from Sprint 2's
real, already-audit-cleared `withTransaction` contract, not a Sprint 3 design choice — closing it
would mean either Sprint 2 growing its own mid-flight transaction cancellation (a Sprint 2 API
change, out of this sprint's scope) or `PgCheckpointStore` building a `raceAgainstAbort`-equivalent
of its own, which the callback-boundary limitation above rules out without a materially different
composition than "call `withTransaction`."

**Reconciliation, resolved:** Sprint 2 merged to `main` at `3db3c8d` with a 2-round audit cycle
already complete. `TransactionLeaseLayer`'s method signatures, `TransactionHandle`'s shape, and
`resolveTransaction`'s error behavior (`TransactionHandleInvalidError`) all match what this design
assumed throughout §2.2/§8 — the one real discrepancy found by reconciling against the merged
code is the cancellation gap just described above, now corrected in this section rather than left
as the false claim an earlier draft made. Task 0.0 (tasks.md) records this resolution.

## 9. Test infrastructure

Reuses Sprint 1's `test/postgres/setup.ts` Testcontainers harness unchanged — no new
infrastructure decision needed for this sprint.
