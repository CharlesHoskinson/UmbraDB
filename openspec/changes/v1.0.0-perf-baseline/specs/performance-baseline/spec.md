# performance-baseline (implementation)

The 1.0.0 performance gate: the perf-correctness fixes that must land *first* (**G13**) and the
recorded benchmark baseline that gates the tag (**G14**), grounded in the actual adapter SQL at
`src/postgres/`. Requirements below follow EARS (Easy Approach to Requirements Syntax): each is
one of Ubiquitous ("The system SHALL…"), Event-driven ("WHEN \<trigger>, the system SHALL…"),
Unwanted-behavior ("IF \<trigger>, THEN the system SHALL…"), State-driven ("WHILE \<state>, the
system SHALL…"), or Optional-feature ("WHERE \<feature>, the system SHALL…") form — as in Sprint
4's `specs/watermarks/spec.md`. **Binding rule carried through every requirement here:** no
performance *number* gates the 1.0.0 release; only the *existence* of a recorded baseline does
(`ROADMAP-v1.0.0-CONSOLIDATED.md` G14; `council/B` §3).

## ADDED Requirements

<!-- ============================ G13 — perf-correctness fixes (land FIRST) ============================ -->

### Requirement: save() issues a bounded number of round-trips independent of chunk count (HP-1)

`PgCheckpointStore.save` SHALL persist a checkpoint's chunk rows in a single multi-row
`INSERT … SELECT … FROM unnest(...)` statement and its junction rows in a single multi-row
statement, such that the number of database round-trips it issues is a constant independent of the
chunk count `N` — replacing the two per-chunk `for`-loops of single-row awaits at
`src/postgres/checkpoint-store.ts:156-162` and `:190-195` (which issue `2N` serialized
round-trips). This is an internal implementation change: `save`'s public signature SHALL NOT
change.

#### Scenario: A multi-chunk save issues a constant number of chunk/junction statements
- **WHEN** `save` is called with a payload that splits into `N` chunks (e.g. a 64 MB checkpoint at
  the 4 MiB default chunk size, `N = 16`)
- **THEN** exactly one statement SHALL insert all `N` chunk rows and exactly one statement SHALL
  insert all `N` junction rows — not one statement per chunk and one per position
- **AND** the count of chunk/junction insert statements SHALL be the same for `N = 1` and
  `N = 64`, growing not at all with `N`

#### Scenario: The batched chunk insert preserves the grace-window ON CONFLICT refresh
- **WHEN** `save` writes a chunk whose `hash` already exists in `ckpt_chunks`
- **THEN** the batched chunk statement SHALL still apply `ON CONFLICT (hash) DO UPDATE SET
  created_at = now()` for that row — preserving prune's grace-window TOCTOU safety
  (`checkpoint-store.ts:150-155`), not a `DO NOTHING`

### Requirement: history() computes per-manifest aggregates in a single grouped query (HP-2)

`PgCheckpointStore.history` SHALL compute the `chunk_count` and `byte_length` for every manifest
in the returned page using a single grouped query keyed by `mc.manifest_id = ANY($1) GROUP BY
mc.manifest_id`, replacing the per-manifest aggregate loop at
`src/postgres/checkpoint-store.ts:322-328`. The total number of queries `history` issues SHALL be
constant (the page query plus one aggregate query), not `1 + page-size`.

#### Scenario: A history page issues two queries regardless of page size
- **WHEN** `history` is called with `limit = 50` and 50 complete manifests exist
- **THEN** `history` SHALL issue exactly two queries total (the manifest page query and one grouped
  aggregate query), not 51
- **AND** each returned `CheckpointSummary` SHALL carry the same `chunkCount` and `byteLength` it
  carried before this change, re-associated to its manifest by `manifest_id`, in the existing
  `ORDER BY seq DESC` page order

### Requirement: ckpt_chunks carries a stored size_bytes column computed without detoasting (IS-2)

The `ckpt_chunks` table SHALL carry a `size_bytes integer GENERATED ALWAYS AS
(octet_length(data)) STORED` column, added by a forward-only migration, and `history()`'s
aggregate SHALL sum this stored column rather than `octet_length(c.data)` — so computing a page's
byte totals never detoasts the `bytea` `data` heap. The generated-column pattern matches the
in-repo precedent at
`src/postgres/migrations/chain_archive/001_chain_archive_core.ts:123`.

#### Scenario: The size_bytes column exists and equals the payload length
- **WHEN** the `tier1WalletMigrations` lineage has run and a chunk is inserted with a `data`
  payload of `L` bytes
- **THEN** `information_schema` SHALL show `ckpt_chunks.size_bytes` as an `integer` generated
  column
- **AND** that row's `size_bytes` SHALL equal `L`

#### Scenario: The history aggregate reads size_bytes, not octet_length(data)
- **WHEN** `history`'s grouped aggregate runs
- **THEN** its `sum(...)` SHALL reference `c.size_bytes`, not `octet_length(c.data)` (so it lengths
  each chunk from the stored generated column instead of detoasting the `bytea` `data` heap —
  the TOAST-avoidance being the rationale for the query-text requirement, not a separately
  asserted plan property)

### Requirement: kv_current is fillfactor-tuned to preserve HOT-update eligibility (IS-1)

The `kv_current` table SHALL be set to `fillfactor = 90` by a forward-only migration
(`ALTER TABLE … SET (fillfactor = 90)`), matching the value and rationale already established for
`watermarks` (`src/postgres/migrations/003_watermarks.ts:27`), so that updates to its non-indexed
columns (`value`/`version`/`updated_at`/`updated_xact`) retain same-page slack and stay
HOT-eligible on the hottest sync-write table. No index SHALL be added on any non-primary-key
column of `kv_current` (an index on a changing column would defeat HOT regardless of
`fillfactor`).

#### Scenario: The kv_current table reports fillfactor=90 after migration
- **WHEN** the migrations have run
- **THEN** `pg_class.reloptions` for `kv_current` SHALL include `fillfactor=90`
- **AND** no index SHALL exist on `kv_current` beyond the `(ns, scope, key)` primary key

#### Scenario: The kv_current HOT ratio is measured and recorded under the soak workload
- **WHEN** the benchmark soak workload issues sustained `put`s to existing `kv_current` keys
  against the fillfactor-tuned table
- **THEN** the measured `pg_stat_user_tables.n_tup_hot_upd / n_tup_upd` ratio for `kv_current`
  SHALL be recorded in the baseline as an observed value (the empirical HOT-eligibility check,
  measured — not assumed — per report 03's IS-1 caveat), rather than a differential proof of
  `fillfactor`'s isolated causal contribution

### Requirement: the batching fixes preserve save/history behavior exactly (equivalence)

The HP-1 and HP-2 changes SHALL be behavior-neutral: a checkpoint written by the batched `save`
SHALL be byte-for-byte reconstructable and hash-verifiable exactly as before, and a `history` page
SHALL contain the same summaries in the same order as before. IF the batched `save` produces, for
any payload, a different set of `ckpt_chunks` rows, a different set of `ckpt_manifest_chunks`
`(manifest_id, position, chunk_hash)` junction tuples, or a different `manifest_hash` than the
pre-change per-loop implementation produced for that same payload, THEN the implementation SHALL be
considered non-conforming to this spec. Behavior-neutrality here is exactly the checkpoint
join-semilattice / idempotence laws that a batching rewrite must preserve
(`Formal/STORAGE_ALGEBRA.md` §2 "CheckpointStore — idempotent join-semilattice with a reachability
closure") over the dedup/grace-window decision recorded at `design/design.md` §3 "Checkpoint
chunker (content-addressed, deduplicated)".

#### Scenario: A batched save round-trips identically to the pre-change save
- **WHEN** a payload (including one containing a repeated chunk hash at two distinct positions) is
  written via the batched `save` and then read via `load`
- **THEN** `load` SHALL return the original bytes, pass every integrity check
  (`checkpoint-store.ts` per-chunk hash, dense-position, and recomputed-manifest-hash assertions),
  and yield the same `manifest_hash` the pre-change `save` produced for that payload

#### Scenario: Dedup across saves is unchanged by batching
- **WHEN** a near-duplicate snapshot is saved after an initial snapshot with overlapping chunks
- **THEN** already-present chunk hashes SHALL be de-duplicated via `ON CONFLICT` exactly as the
  per-loop version did (the same chunks reused, no duplicate chunk rows written)

<!-- ============================ G14 — record the benchmark baseline ============================ -->

### Requirement: an in-repo benchmark harness drives the real adapters against a pinned Postgres

The system SHALL provide an in-repo TypeScript benchmark harness that exercises the real UmbraDB
adapter interfaces (`PgCheckpointStore`, `PgTemporalKV`, `PgWatermarks`,
`PgTransactionHistoryStorage`, and the lease/transaction layer) against a Testcontainers-pinned
PostgreSQL 17 with pinned server settings and a pinned image digest, using a JIT/warmup-aware
microbenchmark statistics library (`mitata` or `tinybench`) that SHALL be declared as an explicit
`devDependency` of UmbraDB — the harness SHALL NOT depend on a library resolved only transitively
(e.g. `tinybench` as it exists today solely under `vitest`), which a future upstream bump could
silently remove. The harness SHALL NOT import any external consumer or indexer application to
generate load — it drives
UmbraDB's own adapters directly, honoring the indexer-agnostic boundary
(`ROADMAP-v1.0.0-CONSOLIDATED.md` G11).

#### Scenario: The harness runs against real Postgres via the real adapters
- **WHEN** the benchmark harness is run
- **THEN** it SHALL execute its workloads through the actual `src/postgres/*` adapter methods
  against a Testcontainers PG17 instance with a pinned image digest and pinned
  `shared_buffers`/`work_mem`/`max_wal_size`
- **AND** it SHALL NOT import a consumer/indexer package to drive the workload

#### Scenario: Each harness run reports warmup-aware statistics including CV
- **WHEN** the harness is run against the pinned environment
- **THEN** each run SHALL report per-benchmark statistics including p50/p95/p99 latency and a
  coefficient of variation, computed by the warmup-aware statistics library

### Requirement: a benchmark baseline is recorded as a committed artifact (the G14 gate)

The system SHALL record a benchmark baseline as a committed artifact — JSON keyed by a harness
version, capturing per-workload statistics, the GC-scale curve, and the pinned environment
(image digest, server settings, harness version) — structurally reproducible by the harness. The
**existence** of this recorded baseline is the sole performance condition for tagging 1.0.0: no
performance *number* SHALL gate the release.

#### Scenario: The committed baseline exists and is structurally reproducible
- **WHEN** the 1.0.0 release candidate is assembled
- **THEN** a committed baseline artifact SHALL exist in the repository, keyed by the harness
  version that produced it
- **AND** re-running the harness at that recorded harness version against the same pinned image
  digest and server settings SHALL complete and emit an artifact conforming to the same schema as
  the committed baseline (the same workload set, the same declared envelope, and the same statistic
  fields) — a structural reproduction, with no numeric-threshold comparison implied

#### Scenario: No performance number is a release blocker
- **WHEN** the 1.0.0 acceptance checklist is evaluated for the performance gate
- **THEN** the only performance condition checked SHALL be that the baseline artifact exists and is
  reproducible — SHALL NOT be that any latency/throughput number meets a numeric threshold

### Requirement: the baseline reflects the batched (shipped) save shape

WHEN the benchmark baseline is recorded, the `save` and `history` code paths it measures SHALL be
the batched shapes (the single-`unnest` `save` of §HP-1 and the single grouped `history` of §HP-2)
and the IS-1/IS-2 migrations SHALL be in effect against the measured database, so the recorded
numbers reflect the shape 1.0.0 actually ships — never the pre-batching `2N`-round-trip shape.

#### Scenario: The batching fixes precede the recorded baseline
- **WHEN** the baseline artifact is produced
- **THEN** the `save` path it measures SHALL be the single-`unnest`-statement path (§HP-1), not the
  per-chunk loop
- **AND** the `history` path it measures SHALL be the single grouped query (§HP-2)

### Requirement: the GC reachability anti-join is measured across a declared scale envelope (HP-6)

The harness SHALL measure `prune`'s chunk-reclaim reachability anti-join
(`src/postgres/checkpoint-store.ts:397-404`) — GC pass duration versus live-chunk count — across a
**declared** scale envelope of 10^5 to 10^6 live chunks (deliberately not 10^7, which exceeds a
local wallet datastore's plausible envelope, `council/B` §1), and record the resulting curve in
the baseline. A *cliff* SHALL be defined operationally: the curve is judged to cliff at an envelope
point when the GC pass duration between that point and the previous measured point grows by more
than a declared factor `K` times the live-chunk-count growth factor between those two points
(super-linear degradation), or when a single measured pass exceeds a declared absolute duration
bound `D`. The parameters `K` and `D`, and the resulting cliff determination (cliff met or not
met, and the live-chunk count at which it is first met, if any), SHALL be recorded as an explicit
adjudication in the baseline artifact (and mirrored in task 2.4's close-out note). IF the recorded
curve meets that cliff condition at any point inside the declared envelope, THEN a bounded batched
GC sweep SHALL be implemented as an in-scope 1.0.0 fix; otherwise the single-statement delete SHALL
be kept and its ceiling documented (SC-2).

#### Scenario: The GC curve is measured and recorded to the declared envelope
- **WHEN** the harness runs the GC workload
- **THEN** it SHALL record GC pass duration at increasing live-chunk counts across the declared
  10^5–10^6 envelope
- **AND** the declared envelope, the cliff-threshold parameters `K` and `D`, and the recorded
  cliff determination SHALL be stated alongside the curve in the baseline

#### Scenario: A cliff inside the envelope triggers the batched-sweep fix
- **WHEN** the recorded GC curve meets the declared cliff condition (pass-duration growth between
  adjacent envelope points exceeds `K`× the live-chunk-count growth, or a pass exceeds the absolute
  bound `D`) at a live-chunk count within the declared envelope
- **THEN** `prune`'s chunk reclaim SHALL be changed to a bounded batched sweep and the fix SHALL
  ship in 1.0.0

#### Scenario: No cliff inside the envelope keeps the single-statement anti-join
- **WHEN** the recorded GC curve does not meet the declared cliff condition anywhere within the
  declared envelope
- **THEN** the single-statement anti-join SHALL be retained and its O(live-chunks) cost SHALL be
  documented as ceiling SC-2

### Requirement: scalability ceilings are documented for 1.0.0

The system SHALL document the scalability ceilings SC-1 through SC-6 as explicit 1.0.0 contract
statements (`Performance/` doc or README section): SC-1 `kv_history` unbounded growth /
retained-forever; SC-2 `ckpt_chunks` growth and O(live-chunks) GC cost with the measured curve;
SC-3 `load()` single-`Buffer.concat` materialization ceiling and a max supported single-checkpoint
size; SC-4 single global writer lease serialization with the measured single-writer write
throughput; SC-5 TransactionHistory GIN `fastupdate` p99 tail behavior; SC-6 TOAST
`EXTENDED`-vs-`EXTERNAL` tradeoff on chunk `data`. These ceilings are documented, not remediated,
in 1.0.0.

#### Scenario: Each ceiling is stated with its 1.0.0 disposition
- **WHEN** the scalability-ceilings document is reviewed
- **THEN** it SHALL name each of SC-1..SC-6, state the limit, and state that its remediation
  (partitioning/retention IS-3, streaming load, GIN tuning IS-4, TOAST-mode choice) is deferred
  past 1.0.0
- **AND** SC-2 SHALL cite the GC curve measured to the declared envelope

### Requirement: a coarse smoke guard is wired now; the CV-aware regression gate is deferred

The system SHALL wire, for 1.0.0, a coarse benchmark regression smoke guard — a CI check, present
now — that flags only gross, order-of-magnitude regressions, per the consolidated roadmap's "Coarse
gate now" ruling (`ROADMAP-v1.0.0-CONSOLIDATED.md` G14; `council/A` §Phase-3). That coarse guard
SHALL be explicitly non-release-gating: it SHALL NOT block the release on any calibrated numeric
threshold. The system SHALL NOT make a coefficient-of-variation-calibrated performance regression
gate a condition of the 1.0.0 tag — that calibrated gate is the first post-1.0.0 obligation
(`ROADMAP-v1.0.0-CONSOLIDATED.md` G14; `council/B` §3).

#### Scenario: A coarse, non-gating smoke guard is present in CI for 1.0.0
- **WHEN** the 1.0.0 CI configuration is inspected
- **THEN** a coarse, order-of-magnitude benchmark regression smoke guard SHALL be present as a CI
  check
- **AND** it SHALL be documented as non-release-gating — it SHALL NOT fail the build on any
  calibrated numeric threshold

#### Scenario: No CV-calibrated numeric gate blocks the 1.0.0 tag
- **WHEN** the 1.0.0 release is cut
- **THEN** no CV-calibrated regression threshold SHALL be a required gate for the tag, with the
  calibrated gate recorded as the first post-1.0.0 obligation
