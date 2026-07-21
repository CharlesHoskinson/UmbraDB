# Design — Sprint 3: CheckpointStore

Implementation-level detail for `src/interfaces/checkpoint-store.ts` against the schema
`design/design.md` §3 already specifies, with two corrections (§2 below) this change makes at a
level of detail that document never went to, and against `Formal/STORAGE_ALGEBRA.md` §2's Laws
C1/C2a/C2b.

## 0. Package layout

```
src/
  postgres/
    checkpoint-store.ts     PgCheckpointStore (this sprint)
    migrations/
      002_checkpoint_store.ts
    errors.ts                (existing, modified: this module's constraint-violation translations)
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
   number (§2's `ckpt_sequence_counters`), insert the manifest row, insert one
   `ckpt_manifest_chunks` row per chunk **at its position in the split** (§2's fix), and commit.

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
  manifest_id bigint  NOT NULL REFERENCES ckpt_manifests(id),
  position    integer NOT NULL,          -- 0-indexed order within this manifest's payload
  chunk_hash  bytea   NOT NULL REFERENCES ckpt_chunks(hash),
  PRIMARY KEY (manifest_id, position)
);
CREATE INDEX ckpt_manifest_chunks_by_hash ON ckpt_manifest_chunks (chunk_hash);
```

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
same per-row lock semantics as any other `UPDATE` (a second concurrent claim blocks until the
first's statement completes, exactly the same serialization argument Law T1 already relies on for
TemporalKV's `version` column) — so claims are gapless and monotonic under concurrent callers by
construction, not by an application-level retry loop. This table is genuinely new schema, not
present in `design/design.md` §3 at all; it exists solely to make `seq` allocation well-defined.

### 2.3 `complete`: kept, but currently always true

`design/design.md` §3's `ckpt_manifests.complete boolean NOT NULL DEFAULT false` and its prune
query's `WHERE m.complete` filter are both kept unchanged. **Noted here because this sprint's
`save()` is a single all-or-nothing transaction** (manifest insert + every junction row insert,
per §1 above) — there is no code path in this interface that could ever leave a manifest visible
with `complete = false`: either the whole transaction commits (manifest fully written, chunks and
all) or none of it does. `complete` is therefore always `true` for any manifest `save()` produces,
and the prune query's filter on it is currently redundant-but-harmless defense-in-depth, not a
load-bearing mechanism this module relies on. It is kept rather than dropped because (a) it is
part of the schema `design/design.md` §3 already specifies and this sprint implements that
document rather than redesigning it, and (b) it costs nothing to leave in place for a
hypothetical future incremental/streaming write path that this interface does not have today.
**No task in this change may add a code path that ever sets it `false`** — if one is ever needed,
that is new interface surface requiring its own design/spec update, not something to bolt on here.

## 3. `prune` — two-step GC, unchanged from `design/design.md` §3

```sql
-- Precondition, enforced in application code before this SQL runs (ValidationError, not a SQL
-- guard): retainCount >= 1. retainCount = 0 makes OFFSET evaluate to -1, which Postgres rejects
-- outright.
-- 1. prune old superseded manifests for this (w, net):
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
-- reclaimedBytes without a second query.
DELETE FROM ckpt_chunks c
WHERE c.created_at < now() - interval '15 minutes'
  AND NOT EXISTS (
    SELECT 1 FROM ckpt_manifest_chunks mc WHERE mc.chunk_hash = c.hash
  )
RETURNING octet_length(c.data) AS reclaimed_bytes;
```

Both statements run inside the same transaction (§8), manifest prune first — a chunk the pruned
manifest referenced becomes reclaimable to the *second* statement in the *same* pass, matching
`design/design.md` §3's stated ordering. `PruneResult.prunedSequences` is the first query's
`RETURNING seq` list; `reclaimedChunks`/`reclaimedBytes` are the second query's row count and
summed `reclaimed_bytes`. Per `src/interfaces/checkpoint-store.ts`'s own `PruneResult` doc: a
chunk that lost its last reference in this call but hasn't cleared the grace window yet is
correctly *not* reclaimed here and does not appear in this call's counts — that is the documented,
intentional behavior, not a bug to fix.

`retainCount < 1` is rejected with `ValidationError` in the adapter before either statement runs
(`src/interfaces/checkpoint-store.ts` doesn't declare a Zod schema for `prune`'s bare
`retainCount: number` parameter the way `save`/`history` get one for their options object, so this
adapter validates it directly rather than skipping validation because no schema object exists for
it).

## 4. `load` — full verification, no exceptions

Per the interface's own doc (`CheckpointRecord`, `src/interfaces/checkpoint-store.ts`): `load`
**always** fully rehashes and verifies every chunk, with no fast/unverified path and no
`integrityVerified` flag on the result (a `false` value there could never be observed, since the
method throws instead of returning one — a prior interface-design review already found and
removed that dead field, cited in that file's own doc comment).

```sql
-- 1. resolve the target manifest (walletId, networkId, sequence?) — latest if sequence omitted
SELECT id, seq, created_at FROM ckpt_manifests
WHERE w = $1 AND net = $2 AND complete
  AND ($3::bigint IS NULL OR seq = $3)
ORDER BY seq DESC LIMIT 1;
-- 0 rows => CheckpointNotFoundError(walletId, networkId, sequence)

-- 2. fetch this manifest's chunks in order
SELECT mc.position, c.hash, c.data
FROM ckpt_manifest_chunks mc
LEFT JOIN ckpt_chunks c ON c.hash = mc.chunk_hash
WHERE mc.manifest_id = $1
ORDER BY mc.position;
```

For each row: `c.hash IS NULL` (the `LEFT JOIN` found no matching `ckpt_chunks` row at all, since
a plain `JOIN` would just silently omit that position instead of surfacing it) → `ChunkMissingError
(chunkHash)`; else re-hash `c.data` and compare to `mc.chunk_hash` → mismatch is
`ChunkIntegrityError(chunkHash, expectedHash)`. Concatenate `data` across all positions in
ascending order into the returned `CheckpointRecord.data`. A gap in `position` (e.g. a manifest
with positions `0, 1, 3` and no `2`) is a `ManifestCorruptError` — this should be structurally
impossible given `save()` always inserts a dense `0..n-1` range in the same transaction as the
manifest row, so this check exists as a defense-in-depth integrity assertion, not an expected
runtime path (mirrors §2.3's stance on `complete`: kept because it's cheap and catches an
out-of-band corruption, not because normal operation is expected to hit it).

## 5. `history` — pagination

```sql
SELECT seq, id AS manifest_id, created_at
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
column; computed as `SHA-256(concat of chunk_hash bytes in position order)` at write time and
persisted as a new `ckpt_manifests.manifest_hash bytea NOT NULL` column (added in the migration,
§6) so `history()`/`load()` don't need to recompute it from the junction table on every read.

## 6. Migration (`002_checkpoint_store.ts`)

Schema-qualified via `sql(schema)`, matching `001_temporal_kv.ts`'s established pattern exactly —
`ckpt_chunks`, `ckpt_manifests` (now including `manifest_hash bytea NOT NULL`, §5), the corrected
`ckpt_manifest_chunks` (§2.1), `ckpt_sequence_counters` (§2.2), and both indexes
(`ckpt_manifests_lookup`, `ckpt_manifest_chunks_by_hash`). No trigger, no extension — this module
needs neither `btree_gist` nor any `plpgsql` function, unlike TemporalKV.

## 7. Error translation additions (`src/postgres/errors.ts`)

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
read-only and single-statement-equivalent (a manifest lookup + one ordered join, or one paginated
select) — per the interface's own silence on transactional participation for these two methods,
they run directly against the pooled `sql` with no `withTransaction` wrapper, matching
`PgTemporalKV.get`/`getAt`'s existing precedent of not wrapping single reads in a transaction
either.

**Reconciliation task, tracked explicitly (proposal.md's "accepted dependency" note):** if
Sprint 2's Codex-clearing pass changes `TransactionLeaseLayer`'s method signatures,
`TransactionHandle`'s shape, or `resolveTransaction`'s error behavior, task 0.0 (tasks.md) is
where this design's §8 gets re-verified against the merged contract before any other task in this
sprint starts implementation.

## 9. Test infrastructure

Reuses Sprint 1's `test/postgres/setup.ts` Testcontainers harness unchanged — no new
infrastructure decision needed for this sprint.
