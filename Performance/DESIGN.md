# Performance — design

Grounded in two research passes (broad profiling/benchmarking/logging
survey, then a targeted follow-up on the two gaps the first pass's review
found unresolved: GC-at-scale architecture and `postgres.js`'s native
instrumentation hooks — see `GC_AND_TRACING_RESEARCH.md` for the full
recovered synthesis of the second pass, including what was checked and
refuted). This is the design a benchmark harness, profiling setup, and
activity-logging layer should actually be built against.

## 1. Postgres-side profiling

- **`auto_explain`**: enable via `session_preload_libraries` (a config
  reload is enough for a local instance), with `log_min_duration` set to a
  real threshold (default `-1` disables all logging — must be set
  explicitly) and **`log_nested_statements = on`**, specifically so slow
  queries *inside* `kv_history`'s `BEFORE UPDATE/DELETE` trigger are
  actually caught — the default (`off`) only logs top-level client queries
  and would miss exactly the query this project's own schema depends on
  most. Reserve `log_analyze`/`log_buffers` for on-demand deep-dives only —
  Postgres's own docs describe `log_analyze` as adding per-plan-node timing
  overhead to *every* statement executed, whether or not it gets logged;
  never enable it as a standing default.
- **`pg_stat_statements`**: run continuously as the standing low-overhead
  aggregate profiler (`shared_preload_libraries` + restart + `CREATE
  EXTENSION`), with **`track = 'all'`** (not the default `'top'`) so
  trigger-internal statements are counted too. Two caveats to design
  around, not just note: `queryid` is not guaranteed stable across major
  Postgres versions or `search_path` changes (relevant here, since schema
  isolation, `design/design.md` §0, means `search_path` is actively
  managed) — don't build long-term historical comparisons on raw `queryid`
  without accounting for this; raise `pg_stat_statements.max` above the
  5000 default if the benchmark harness generates many distinct ad hoc
  query shapes. Leave `track_planning` off by default (real concurrency
  overhead); enable only for targeted planning-time investigations.
- **`pg_stat_activity`**: the direct, zero-instrumentation way to observe
  writer-lease contention — a backend blocked acquiring the
  `sql.reserve()`-pinned advisory lock shows `wait_event_type = 'Lock'`,
  `wait_event = 'advisory'`. Requires `track_activities = on` (default);
  note `pg_stat_activity.query` truncates at 1024 bytes by default
  (`track_activity_query_size` to raise it) if relying on this view rather
  than logs to see a full slow query's text.

## 2. Node-side query correlation

**Layer `diagnostics_channel`/`tracingChannel` on top of `postgres.js`'s
native `debug` hook — neither alone is suffient.** `debug` fires
synchronously at query-*build* time with `(connection_id, query_string,
parameters, types)` — real, driver-native, zero extra dependency, but
structurally incapable of reporting duration (confirmed directly against
`postgres.js` source, not just docs — no timing hook exists anywhere in
the codebase). `tracingChannel`'s five correlated lifecycle events
(`start`/`end`/`asyncStart`/`asyncEnd`/`error`) sharing one context object
is what actually gives duration + correlation. Recommendation: wrap
`debug`'s per-query payload in a `tracingChannel` span so the SQL
text/params come from the driver's own native hook and the timing comes
from `tracingChannel`, with `hasSubscribers` guarding the whole thing so it
costs nothing when no listener is attached. `tracingChannel` is
Experimental (Stability 1) and has been for several years without
promotion — a real, acknowledged risk, isolated behind a single small
wrapper module (`src/postgres/tracing.ts` or similar) so an eventual API
change has one place to land, not a project-wide search-and-replace. This
also keeps the instrumentation portable if this project ever falls back to
the `pg` driver (`design/design.md` §7's fallback clause) — no
`postgres.js`-specific OpenTelemetry instrumentation exists to lose either
way (OTel's `@opentelemetry/instrumentation-pg` targets `node-postgres`
specifically, confirmed, and does not apply here).

## 3. GC architecture (the load-bearing decision)

**Content-addressed chunk references live in a normalized junction table,
not an array-of-hashes column.**

```sql
CREATE TABLE ckpt_manifest_chunks (
  manifest_id bigint NOT NULL REFERENCES ckpt_manifests(id),
  chunk_hash  bytea  NOT NULL REFERENCES ckpt_chunks(hash),
  PRIMARY KEY (manifest_id, chunk_hash)
);
CREATE INDEX ckpt_manifest_chunks_by_hash ON ckpt_manifest_chunks (chunk_hash);
```

This replaces `ckpt_manifests.chunk_hashes bytea[]` + the GIN index
originally proposed in `design/design.md` §3 — **superseded by this
research**: GIN's `array_ops` operator class accelerates `&&`/`@>`/`<@`/`=`,
never the scalar `hash = ANY(chunk_hashes)` membership test GC's
reachability check needs, and a real benchmark found GIN gives zero benefit
for exactly this cross-row query shape. The GC query becomes a plain,
btree-indexed anti-join:

```sql
DELETE FROM ckpt_chunks c
WHERE c.created_at < now() - interval '15 minutes'
  AND NOT EXISTS (
    SELECT 1 FROM ckpt_manifest_chunks mc WHERE mc.chunk_hash = c.hash
  );
```

Keep the scan-based mark-and-sweep design as-is — do not switch to a
live `ref_count` column; incremental reference counting has a
well-documented concurrency race a batched scan avoids structurally, and
Git's own GC (the closest real precedent) uses mark-and-sweep, not
refcounting, for the same reason. Keep the existing grace window
unchanged — it already matches Git's own timestamp-based race-avoidance
mechanism (`gc.pruneExpire`, 2 weeks by default, protecting objects newer
than the cutoff regardless of computed reachability).

**Batching:** not decided by default — measured. `pg-boss`'s chunked,
lock-guarded sweep and `graphile-worker`'s unbatched single-statement
anti-join are both real, production-viable patterns; which one UmbraDB
needs depends on `ckpt_manifests`/`ckpt_manifest_chunks` size once the
benchmark harness has real numbers, not a decision to make speculatively
now.

**Explicitly open, not resolved by any research pass:** no published
benchmark exists anywhere for this exact query shape (anti-join
reachability scan) at multi-GB/many-millions-of-rows scale. The benchmark
harness (§4) closing this gap empirically is this project's actual
deliverable here — there is no shortcut available in the literature.

## 4. Benchmark harness

No generic tool transfers to this workload shape. `pgbench`'s built-in
script models generic TPC-B-style transactions, not versioned-KV CAS
writes, chunk dedup, or reachability-scan GC. No existing content-addressed
store's benchmark suite transfers either (SQLite's own historical
benchmark is disavowed as obsolete by SQLite's own team; Venti,
the archetypal content-addressed store, has no GC step at all to
benchmark against). **The only viable structure is a custom Node/TypeScript
harness that drives UmbraDB's own interfaces directly and lives in-repo as
a regression gate** — not a one-off profiling script, a versioned artifact
that runs the same way every time and whose numbers are compared against a
recorded baseline (per `ROADMAP.md`'s 1.0.0 acceptance checklist).

Minimum coverage for the first version:
- Versioned KV put/get/getAt throughput and latency, at increasing
  `kv_history` sizes (this is where the `tstzrange`+`GiST EXCLUDE`
  constraint's real write overhead, if any, becomes visible).
- Checkpoint save/load latency and measured dedup ratio (chunks reused vs.
  newly written) at realistic checkpoint sizes.
- GC pass duration as `ckpt_chunks`/`ckpt_manifest_chunks` grow — the
  actual empirical answer to §3's open question.
- Lease acquire/release latency under concurrent contention.

## 5. Activity logging

Per-call-site `tracingChannel` spans (§2) feed into `pino`, configured with
its own recommended worker-thread `transport` architecture so log
formatting/writing never blocks the event loop on the hot path. Treat
logging and tracing as related but distinct concerns, matching how Prisma
(a reference pattern only, not a dependency here) separates its own
per-query event logging from its OpenTelemetry-based tracing feature: a
human debugging locally wants readable log lines; a slow-call
investigation wants the span/duration data. Hook logging into the existing
`signal?: AbortSignal` and `StorageError` conventions so cancellation and
thrown-error paths emit a log event automatically on throw/rejection,
rather than requiring separate instrumentation at every call site.
