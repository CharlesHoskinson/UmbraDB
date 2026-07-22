# performance-observability (implementation)

The Milestone 4 performance workstream (`ROADMAP.md:120-138`), built against the completed research
pass (`Performance/DESIGN.md`, `Performance/GC_AND_TRACING_RESEARCH.md`): an in-repo, versioned
benchmark harness that doubles as a regression gate, and structured DB-activity logging that
correlates an application-level call to the SQL and query plan it issued. Requirements below follow
EARS (Easy Approach to Requirements Syntax): each is one of Ubiquitous, Event-driven, Unwanted-
behavior, State-driven, or Optional-feature form — as in Sprint 2's, Sprint 4's, and Sprint 7's spec
files.

The tooling here is adopted from `Performance/DESIGN.md`, not chosen afresh; its honest caveats are
carried, not papered over (`tracingChannel` is Experimental and isolated behind one wrapper module;
the GC anti-join at scale has no published benchmark and the harness is what closes that gap).

## ADDED Requirements

### Requirement: the benchmark harness drives UmbraDB's own interfaces and emits a versioned result artifact

The benchmark harness SHALL drive UmbraDB's own module interfaces directly against a real Postgres
(Testcontainers, `design/design.md` §8) — not a generic tool (`pgbench` models TPC-B, not versioned-KV
/ chunk-dedup / reachability-scan GC; `Performance/DESIGN.md` §4) — and SHALL emit a structured,
versioned result artifact recording, per metric, its value, unit, the git SHA, the timestamp, and the
Postgres version, so results are comparable across runs.

#### Scenario: A benchmark run produces a schema-valid versioned artifact
- **WHEN** the harness is run
- **THEN** it SHALL execute each configured workload against a real Postgres and write a result
  artifact
- **AND** the artifact SHALL validate against the documented result schema (each entry carrying
  metric, value, unit, git SHA, timestamp, Postgres version)

### Requirement: the harness covers UmbraDB's real workloads including the Sprint 7/8 paths

The harness SHALL cover, at minimum: versioned-KV put/get/getAt throughput and latency at increasing
`kv_history` sizes; checkpoint save/load latency and measured dedup ratio; GC pass duration as the
chunk store grows; lease acquire/release latency under concurrent contention; **tx-history write/merge
throughput and tail latency under concurrent writers** on Sprint 7's row-lock path
(`transaction-history-storage.ts:452-513`); and **envelope save/load latency** (Sprint 8). This
extends `Performance/DESIGN.md` §4's minimum with the Sprint 7/8 workloads.

#### Scenario: Every listed workload produces at least one metric, with GC measured at growing sizes
- **WHEN** the harness runs to completion
- **THEN** each listed workload SHALL contribute at least one metric to the result artifact
- **AND** the GC-pass-duration workload SHALL report its duration at three or more growing chunk-store
  sizes (the empirical answer to `Performance/DESIGN.md` §3's explicitly-open question)

### Requirement: a regressed metric fails the benchmark gate against the recorded baseline

WHEN a benchmarked metric regresses beyond the configured threshold relative to the committed
baseline, the harness SHALL exit non-zero (fail the gate), satisfying `ROADMAP.md:155`'s "no
regression against the recorded baseline" 1.0.0 item. The gate SHALL NOT be vacuous: a deliberately
injected synthetic regression SHALL make it fail.

#### Scenario: A metric within threshold passes and a regressed metric fails
- **WHEN** the harness is run and every metric is within its threshold of the baseline
- **THEN** the gate SHALL pass (exit zero)

#### Scenario: An injected synthetic regression makes the gate fail
- **WHEN** a synthetic regression beyond the threshold is injected into one metric
- **THEN** the gate SHALL fail (exit non-zero), proving the gate is not vacuous

### Requirement: an application-level call is correlatable to the SQL, plan, and duration it produced

The activity-logging layer SHALL correlate an application-level storage call (e.g.
`CheckpointStore.save`, `TemporalKV.getAt`) to the exact SQL it issued, that SQL's query plan
(obtainable on demand), and the call's duration — so a slow call can be traced from "this call was
slow" to "this is why" without guessing (`ROADMAP.md:138`; `Performance/README.md`). SQL text and
parameters SHALL come from `postgres.js`'s native `debug` hook and duration/correlation from a
`tracingChannel` span wrapping it (`Performance/DESIGN.md` §2), isolated in one module
(`src/postgres/tracing.ts`).

#### Scenario: A slow call is traced to its SQL, plan, and duration
- **WHEN** an application-level call issues a SQL statement and a tracing subscriber is attached
- **THEN** the emitted span SHALL carry that statement's SQL text, its parameters, and the call's
  measured duration
- **AND** the corresponding query plan SHALL be obtainable on demand for that statement

### Requirement: instrumentation adds no per-query overhead while no subscriber is attached

WHILE no tracing subscriber is attached, the instrumentation SHALL add no per-query work — guarded by
`hasSubscribers` so the whole tracing path costs nothing when nothing is listening
(`Performance/DESIGN.md` §2).

#### Scenario: No span is emitted and no tracing work runs with no subscriber
- **WHEN** a storage call is issued with no tracing subscriber attached
- **THEN** no span SHALL be emitted
- **AND** the `hasSubscribers` guard SHALL short-circuit the tracing path before any per-query
  tracing work is done

### Requirement: cancellation and thrown-error paths emit a log event automatically

WHEN a storage call rejects with a `StorageError` or its `opts.signal` aborts, the logging layer SHALL
emit a log event automatically — hooked into the existing `signal`/`StorageError` conventions rather
than requiring separate instrumentation at every call site (`Performance/DESIGN.md` §5).

#### Scenario: A thrown StorageError and an aborted signal each emit a log event
- **WHEN** a call rejects with a `StorageError`, and separately when a call's `signal` is already
  aborted
- **THEN** each SHALL emit a log event without per-call-site instrumentation added by the caller

### Requirement: deep query-plan profiling is an on-demand runbook, never a standing production default

WHERE deep Postgres-side profiling is used (`auto_explain` with `log_nested_statements=on`,
`pg_stat_statements` with `track='all'`, `pg_stat_activity` for lease contention), it SHALL be a
documented on-demand runbook configuration, and `log_analyze` SHALL NOT be enabled as a standing
default, because it adds per-plan-node timing overhead to every statement executed
(`Performance/DESIGN.md` §1).

#### Scenario: The profiling runbook exists and forbids log_analyze as a default
- **WHEN** the profiling runbook is inspected
- **THEN** it SHALL document enabling `auto_explain`/`pg_stat_statements`/`pg_stat_activity` on demand
- **AND** it SHALL state explicitly that `log_analyze` is never enabled as a standing default
