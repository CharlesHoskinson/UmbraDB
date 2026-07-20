# Design — Postgres+JSONB storage rebuild

Grounded in deep research (105-agent fan-out research + a targeted
Mongo→Postgres tooling pass, run 2026-07-20; full synthesis retained in this
session's task-notification records, not re-copied verbatim here — cite
`.d.ts`/docs as each task lands, per `openspec/project.md`'s correctness
rule). This draft was then reviewed by a 3-agent Opus panel (requirements
completeness / adversarial risk hunt / fidelity-to-research) with a Fable 5
consolidation pass; the panel found one blocker (§5's original advisory-lock
design was incompatible with the chosen pooled driver) and several majors,
all fixed in this version — see git history for the pre-review draft if the
before/after is useful.

## 0. How this reconciles with the Tier-2 (indexer) Postgres decision

The 2026-07-17 storage-architecture-reconciliation
(`docs/notes/2026-07-17-storage-architecture-reconciliation.md`) split
storage into Tier 1 (client wallet/checkpoint persistence, was Mongo) and
Tier 2 (chain-mirror/indexer/analytics, forks the official indexer's Postgres
schema, TimescaleDB for analytics). This change moves Tier 1 onto Postgres
too. Both tiers end up on **one Postgres instance, two schemas**
(`tier1_wallet` and whatever the Tier-2 fork uses, e.g. `indexer`) — not a
merged schema. Tier 1 tables are NOT part of the forked official indexer
schema and must not be added to it.

## 1. Mongo-compatibility-shim tooling: evaluated and rejected

FerretDB (MongoDB wire protocol → Postgres, now built on the `documentdb`
Postgres extension) was evaluated as an alternative to a rewrite. Rejected:
its transaction/change-stream semantics are still immature (FerretDB's own
v2.0 GA announcement says multi-document transaction/session support is
planned for *later* versions), and those gaps land exactly on the patterns
this project's checkpoint/blob store depends on (multi-doc atomicity,
GridFS-like large-blob handling, whose FerretDB support status is
inconsistent across its own docs). This is a from-scratch rebuild of a small,
fully custom Mongo surface with no production data — the case where a
compatibility shim's main selling point (keep driver code unchanged) is worth
the least. No other independently-viable Mongo-wire-protocol-over-Postgres
project was found (the space is FerretDB + the `documentdb` extension it
consumes — same stack, not real alternatives). ETL/migration tools
(pgloader, Airbyte, Debezium, MongoDB Relational Migrator) are not applicable
either — there is no legacy data to migrate.

## 2. TemporalKV → Postgres

No native system-versioned (transaction-time) temporal table exists in
Postgres, even at 18/19 (research established this gap; the PG19 docs
reference and "documented workaround" phrasing below need a real
doc-line citation when Task 1 lands, per `openspec/project.md`'s
correctness rule — not yet independently confirmed at that level of detail).
Design: a **current table** + a trigger-populated **history table**, using
closed-open validity intervals so a `getAt(ns, scope, key, asOf)` read is a
single indexed range query.

```sql
CREATE TABLE kv_current (
  ns         text NOT NULL,
  scope      text NOT NULL,
  key        text NOT NULL,
  value      jsonb NOT NULL,
  version    bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ns, scope, key)
);

CREATE TABLE kv_history (
  id         bigserial PRIMARY KEY,   -- surrogate PK: (ns,scope,key) is no
                                       -- longer unique once history is kept
  ns         text NOT NULL,
  scope      text NOT NULL,
  key        text NOT NULL,
  value      jsonb NOT NULL,
  version    bigint NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to   timestamptz NOT NULL,    -- exclusive upper bound
  CONSTRAINT kv_history_range CHECK (valid_from < valid_to)
);
CREATE INDEX kv_history_lookup ON kv_history (ns, scope, key, valid_from);

-- BEFORE UPDATE/DELETE trigger on kv_current:
--   1. sets NEW.updated_at = now() on every write (UPDATE's column default
--      only fires on INSERT — this must be explicit, or the current/history
--      boundary drifts and getAt's fall-through returns a stale value);
--   2. copies the OLD row into kv_history with
--      valid_from = OLD.updated_at, valid_to = now();
--   3. SKIPS the history insert when valid_from = valid_to (a same-transaction
--      double-write: now() is constant for the whole transaction, so a
--      second update in one sql.begin would otherwise produce a zero-width
--      interval and trip kv_history_range's CHECK) — the current row already
--      reflects the last write in that case, nothing is lost.
-- getAt() reads kv_history for valid_from <= asOf < valid_to, falling
-- through to kv_current when asOf >= kv_current.updated_at (still the live
-- value).
--
-- kv_current.value serialization: values are opaque to the KV layer (same
-- as the Mongo version) but must round-trip through JSONB, which — unlike
-- BSON — has no native Date/BigInt/undefined types. Callers MUST superjson
-- encode a value before it reaches this layer (matching §6's existing
-- serialize-then-store pattern) so JS-native types survive round-trip; the
-- KV layer itself does not add this encoding.
```

`listKeys`/prefix scans stay on `kv_current` (btree on `(ns, scope, key)`
already supports a prefix scan); no GIN index needed unless a future
requirement queries *inside* `value`, which nothing here does today (values
are opaque to the KV layer, matching the Mongo version). Point-in-time
`listKeys` (a historical prefix scan as-of a past timestamp) is NOT
supported by this design — confirm in Task 1 that the Mongo test suite never
exercises this; if it does, `kv_history` needs a prefix-scan-friendly index
added (`(ns, scope, valid_from)` covers it, but is not created above since
nothing currently requires it).

**`kv_history` retention (added after cross-checking against production
precedent).** External research into production blockchain-Postgres
indexers found no verified stack implementing this exact closed-open-interval
temporal design; the closest real precedent — Solana's
`accountsdb-plugin-postgres`, which uses an AFTER-UPDATE/DELETE trigger to
copy overwritten rows into a shadow `account_audit` table, structurally the
same shape as `kv_history` — has a documented, unresolved operational gap:
unbounded growth, no partitioning, no automatic retention, only manual ad
hoc cleanup scripts in production. `kv_history` as drafted above has the
identical gap: every write inserts a history row and nothing ever deletes
one. Unlike `ckpt_chunks`/`ckpt_manifests` (§3, grace-window GC) and
`wallet_state` (§6, TTL via `pg_cron`), this table had no retention story —
an oversight, not an intentional accepted-tradeoff, now closed:

- **Default: `pg_cron` retention**, reusing the same `pg_cron` dependency §6
  already requires (confirm availability in Task 1, same as §6): periodically
  run `DELETE FROM kv_history WHERE valid_to < now() - interval '<N> days'`.
  This bounds growth to a rolling window, at the cost of capping how far back
  `getAt(asOf)` can reach — Task 1 MUST confirm the Mongo test suite never
  exercises `getAt` beyond whatever retention window is chosen (same
  confirm-before-relying-on-it pattern already used above for point-in-time
  `listKeys`).
- **Scale-up option, not needed at this project's size:** range-partition
  `kv_history` by `valid_to` (e.g. monthly), making retention an O(1)
  `DROP`/`DETACH PARTITION` instead of a bulk `DELETE`, with `kv_history_lookup`
  extended to account for partition pruning on `valid_to` as well as
  `valid_from`. Record in Task 1 if adopted instead of plain `pg_cron` deletes.
- If unbounded retention turns out to be a genuine product requirement (full
  audit history, not just recent point-in-time reads), that must be stated
  here explicitly as an accepted tradeoff — mirroring how §5 documents the
  writer-lease's crash-implies-release semantics change — rather than left
  implicit.

## 3. Checkpoint chunker (content-addressed, deduplicated)

Maps cleanly — this part gets *simpler* than Mongo, not harder. Research
verified this pattern against a real content-addressable-storage-on-Postgres
writeup (adversarially checked, not taken on faith): `INSERT ... ON
CONFLICT (hash) DO UPDATE SET created_at = now()` gives atomic, race-free
dedup with **no read-before-write check needed** — concurrent writers of the
same content just no-op past each other on the row's `data`, while still
refreshing its GC clock (see the GC note below — plain `DO NOTHING` would
silently defeat the grace window on every re-reference).

```sql
CREATE TABLE ckpt_chunks (
  hash       bytea PRIMARY KEY,          -- content hash (unchanged from Mongo design)
  data       bytea NOT NULL,             -- TOASTed automatically past ~2KB;
                                          -- 1 GB/value ceiling, comfortably
                                          -- covers tens-of-KB-to-few-MB chunks
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ckpt_manifests (
  id           bigserial PRIMARY KEY,
  w            text NOT NULL,
  net          text NOT NULL,
  seq          bigint NOT NULL,
  chunk_hashes bytea[] NOT NULL,
  complete     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- carries forward the Mongo hardening fix: compound index for the
-- prune/list-descending access pattern
CREATE INDEX ckpt_manifests_lookup
  ON ckpt_manifests (w, net, complete, seq DESC);
-- GIN index so the GC chunk-reclaim query's `hash = ANY(chunk_hashes)`
-- check doesn't force a sequential scan of ckpt_manifests
CREATE INDEX ckpt_manifests_chunk_hashes_gin
  ON ckpt_manifests USING gin (chunk_hashes);
```

GC (prune old manifests, reclaim unreferenced chunks) keeps the Mongo
design's grace-window-for-TOCTOU-safety shape, expressed as a plain SQL
reference-count check instead of Mongo's app-level TOCTOU guard. Two steps,
run in this order (manifest prune first, so a chunk the pruned manifest
referenced becomes reclaimable in the same GC pass):

```sql
-- 1. prune old superseded manifests (mirrors the Mongo prune.ts policy —
--    e.g. keep only the newest N complete manifests per (w, net); exact
--    retention predicate ported from prune.ts in Task <n>, not re-derived
--    here)
DELETE FROM ckpt_manifests m
WHERE m.complete
  AND m.seq < (
    SELECT seq FROM ckpt_manifests
    WHERE w = m.w AND net = m.net AND complete
    ORDER BY seq DESC OFFSET <retain_count> LIMIT 1
  );

-- 2. reclaim chunks no longer referenced by any surviving manifest, past
--    the grace window. The insert-time `ON CONFLICT ... DO UPDATE SET
--    created_at = now()` above is load-bearing here: without it, a chunk
--    re-referenced by a brand-new manifest keeps its ORIGINAL created_at,
--    so this DELETE could reclaim it out from under a manifest whose INSERT
--    is still uncommitted (READ COMMITTED does not see the uncommitted
--    manifest row, so NOT EXISTS is satisfied) — the grace window alone
--    only protects newly-created chunks, not dedup-reused old ones.
DELETE FROM ckpt_chunks c
WHERE c.created_at < now() - interval '15 minutes'   -- grace window, unchanged value
  AND NOT EXISTS (
    SELECT 1 FROM ckpt_manifests m WHERE c.hash = ANY(m.chunk_hashes)
  );
```

## 4. Watermarks

Direct, no design change needed:

```sql
CREATE TABLE watermarks (
  kind       text NOT NULL,
  key        text NOT NULL,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, key)
);
```

## 5. Commit/transaction layer

Postgres's ACID transactions work identically on a lone standalone instance —
research indicates the current standalone-vs-replset detection branch can
likely be dropped rather than ported; this design makes that call and
deletes it entirely (a design decision, not a research-established fact —
flag it if implementation surfaces a reason it's still needed). A
transaction is `sql.begin(async sql => { ... })` (driver TBD, §7).

**Writer lease — corrected design.** The writer-lease pattern (currently a
Mongo app-level lease document) becomes a Postgres **session-level advisory
lock** (`pg_advisory_lock(hashtext(leaseKey))` / `pg_advisory_unlock`).
Session-scoped advisory locks live on the *specific connection* that
acquired them — but §7 picks `postgres.js`, whose default `postgres(url)`
factory is itself a connection pool (`max: 10` by default). Acquiring the
lock via one pooled call and releasing it via another can silently land on
different backends: the unlock no-ops, the acquiring connection returns to
the pool still holding the lock, and the lease is effectively leaked (a
future acquire attempt blocks forever on a "released" lease). This is not a
future-context caveat, it is a live bug in the design as first drafted.

**Fix:** the lease MUST be acquired and released on a single connection
pinned for the lease's full lifetime, via `postgres.js`'s `sql.reserve()`
(`const reserved = await sql.reserve(); await reserved\`select
pg_advisory_lock(...)\`; /* ... hold ... */ await reserved\`select
pg_advisory_unlock(...)\`; reserved.release()`). Rejected alternatives:
constraining the whole pool to `{max: 1}` (needlessly serializes all other
traffic through one connection, not just the lease holder); transaction-scoped
`pg_advisory_xact_lock` inside a single `sql.begin` (auto-releases at
transaction end, which cannot outlive one transaction — too short-lived for
a lease meant to span the multi-step checkpoint-write sequence the Mongo
lease document currently spans).

**Accepted semantics change (not a like-for-like port):** a Mongo lease
document is durable with a TTL — it survives the holder process crashing and
supports a takeover/fencing read by another process. A `sql.reserve()`-pinned
advisory lock instead releases automatically the instant its connection
closes (including on crash), with no queryable record and no fence token for
a would-be successor to check. For this project's single-process,
single-writer, dev-local deployment, crash-implies-release is arguably
*better* (no stale-lease cleanup step) — but it is a genuine behavior
change, accepted here explicitly rather than asserted as equivalent.

Same PgBouncer caveat as before, now stated precisely: advisory locks are
application-enforced, not database-guaranteed, and the `sql.reserve()`
pinning above only works because this deployment connects directly to
Postgres — putting a transaction-pooling proxy (PgBouncer in transaction
mode) between the app and Postgres would break connection pinning itself,
not just the lock. Not a concern for this direct-connection, dev-local
deployment; worth a code comment so `sql.reserve()`'s purpose here isn't
lost if this code is ever copy-pasted into a pooled-proxy context.

## 6. Encrypted blob storage (`MongoPrivateStateProvider`/`MongoWalletStateStore`)

Keep AES-256-GCM encryption at the app layer, unchanged (matches pgcrypto's
own documented guidance: application-layer envelope encryption over
pgcrypto's in-database primitives for this kind of secret material). Store
ciphertext as **plain `bytea`, not `jsonb`** — JSONB's indexing/queryability
advantage is moot for opaque ciphertext, and (a design-level rationale, not
independently research-verified) `bytea` avoids the base64/UTF-8 inflation
JSONB would impose on binary data.

`MongoPrivateStateProvider.ts` covers private contract state + signing keys;
`MongoWalletStateStore.ts` (verified directly against its source, not
inferred) is a **separate**, third document shape — not a variant of
`signing_keys` as an earlier draft of this design assumed. It stores the
serialized shielded/unshielded/dust sync state + chain genesis hash per
`(networkId, walletId)`, unencrypted (this is sync-progress state, not
secret material — the Mongo version never encrypts it), with a 7-day TTL
index that expires stale entries automatically.

```sql
CREATE TABLE private_states (
  contract_address text PRIMARY KEY,
  encrypted_value   bytea NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE signing_keys (
  address           text PRIMARY KEY,
  encrypted_value   bytea NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wallet_state (
  network_id         text NOT NULL,
  wallet_id          text NOT NULL,
  schema_version     integer NOT NULL DEFAULT 1,
  shielded_state     text NOT NULL,
  unshielded_state   text NOT NULL,
  dust_state         text NOT NULL,
  chain_genesis_hash text NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network_id, wallet_id)
);
```

**TTL gap — Postgres has no native expiring-document feature (unlike
Mongo's `expireAfterSeconds` TTL index).** `wallet_state` needs an explicit
expiry mechanism to reproduce the Mongo store's 7-day auto-cleanup:
`pg_cron`'s `SELECT cron.schedule(...)` running `DELETE FROM wallet_state
WHERE updated_at < now() - interval '7 days'` on a periodic schedule (needs
the `pg_cron` extension available in the target Postgres — confirm in Task
1) is the closest equivalent; a lazy check-on-read (reject/ignore a row
older than 7 days) is a fallback if `pg_cron` isn't available, but leaves
stale rows accumulating until read. Decide and record the choice in Task 1,
same as §8's test-infrastructure decision.

The existing `superjson.stringify` → encrypt → store / decrypt →
`superjson.parse` shape (for `private_states`/`signing_keys`) is unchanged;
only the sink column type changes (Mongo `Binary` → Postgres `bytea`).
`wallet_state` fields are stored as plain `text` (they are already
pre-serialized strings from the wallet SDK, per `MongoWalletStateStore.ts` —
no additional encoding needed).

## 7. Driver / toolkit choice

**`postgres.js`** (npm `postgres`). Tagged-template `sql` function gives
parameterized, injection-safe hand-written SQL, with TypeScript generics for
typed results (`sql<Row[]>\`...\``) — no ORM layer, matching this project's
existing hand-written-driver style (the Mongo code never used an ODM either).
This research round verified `postgres.js` itself works for this shape but
did not do a head-to-head bake-off against `node-postgres`/`pg` or Drizzle —
if `postgres.js`'s actual installed `.d.ts` surface (once added as a
dependency, per `openspec/project.md`'s correctness rule) doesn't cover a
need found during implementation (e.g. `LISTEN/NOTIFY`, which isn't needed
here), fall back to `pg` before reaching for an ORM.

## 8. Test infrastructure (open decision — resolve in Task 1)

Mongo tests used `mongodb-memory-server` (spins up a real, ephemeral
`mongod`). There is no exact Postgres equivalent with the same "real
database binary, ephemeral, no Docker" property. Two real options, decide in
Task 1 and record the choice here:
- **Testcontainers** (`@testcontainers/postgresql`) — real Postgres in
  Docker; this environment already has a working Docker daemon (verified,
  the local devnet stack runs on it) — likely the safer choice given JSONB /
  `bytea` / advisory-lock semantics need a real Postgres, not an emulator.
  Slower test startup than an in-process fake.
- **pg-mem** — in-process JS Postgres emulator, fast, but not
  guaranteed-faithful for advisory locks / TOAST / exact JSONB semantics —
  risk of tests passing against the emulator and failing against real
  Postgres.

Recommendation: Testcontainers, given fidelity matters more here than test
startup time (this is a from-scratch design being proven correct, not a
well-trodden path).

## 9. Module → module mapping (source of truth for `tasks.md`)

| `midnight-mongo-store` / `examples/storage` module | Postgres equivalent |
|---|---|
| `temporalKv.ts` | `kv_current` + `kv_history` + trigger (§2) |
| `checkpointStore.ts` / `chunker.ts` | `ckpt_chunks` + `ckpt_manifests` (§3) |
| `watermarks.ts` | `watermarks` (§4) |
| `commit.ts` (standalone/replset transaction layer) | `sql.begin()` + `sql.reserve()`-pinned advisory lock (§5) — **branch deleted, not ported; lease semantics changed, see §5** |
| `checkpointHistory.ts`, `prune.ts` | GC query against `ckpt_chunks`/`ckpt_manifests` (§3) |
| `MongoPrivateStateProvider.ts` → `PgPrivateStateProvider.ts` | `private_states` + `signing_keys` (§6) |
| `MongoWalletStateStore.ts` → `PgWalletStateStore.ts` | `wallet_state` (§6) — a distinct table, not a reuse of `signing_keys` |
| `mongoClient.ts` → `pgClient.ts` | `postgres.js` connection factory (§7) |

## 10. State-equivalence gate (merge blocker, mirrors the mongo-store Plan A/B gate)

Before `counter-cli-additions/*.ts` is rewired onto the new package, and
before the Mongo package is deleted:
1. All `midnight-pg-store` tests pass at the same count/shape as the Mongo
   package's 51/51 (temporalKv, chunker, watermarks, commit, prune,
   checkpointStore, checkpointHistory) — see `tasks.md` for the per-module
   test-porting task.
2. All `examples/storage` conformance tests pass against
   `Pg{PrivateStateProvider,WalletStateStore}` at the same count as today's
   27/27 (`WalletStateStore.conformance.test.ts`,
   `MongoPrivateStateProvider.test.ts` ported to a Pg-named equivalent).
3. A live round-trip against the running preprod wallet flow
   (`ballot-preprod.ts`) using the Postgres-backed provider reaches the same
   outcome (deploy + `castVote` + read-back `yesVotes`) it currently reaches
   on Mongo — this is the project's standing on-chain-code verification
   policy (frozen-artifact/Preview-testnet round-trip), applied here as a
   Postgres-cutover round-trip on preprod instead.
4. **Differential state check (equal test *counts* alone do not prove
   equivalence — a ported assertion can be silently weakened and still
   pass).** For the two paths this gate's other legs don't reach:
   - Run an identical sequence of `put`/`getAt` operations against both the
     Mongo `temporalKv` and the new Postgres `kv_current`/`kv_history`, at a
     shared set of `asOf` timestamps spanning multiple versions per key, and
     assert identical results at every timestamp — not just that both
     suites pass independently.
   - Run an identical sequence of checkpoint writes + GC passes against
     both, and assert the surviving chunk-hash sets are identical after
     each GC pass (this is what catches the §3 dedup/GC race if it
     resurfaces under a different access pattern than the unit tests cover).
   - The Opus spec-compliance auditor for the `midnight-pg-store` task(s)
     MUST diff each ported test's assertions against its original Mongo
     counterpart line-by-line and flag any assertion that was dropped,
     loosened, or changed in a way not explained by the schema's actual
     structural differences (e.g. `bytea` vs `Binary` comparison syntax is
     an expected diff; a removed edge-case assertion is not).
