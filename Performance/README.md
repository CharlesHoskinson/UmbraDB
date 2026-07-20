# Performance

Profiling, benchmarking, and activity logging for UmbraDB's local Postgres
storage layer — the last major workstream before a 1.0.0 release (see
[`../ROADMAP.md`](../ROADMAP.md)).

Scope:

- **Profiling** — understanding where time and resources actually go inside
  a running UmbraDB instance: query-level (`pg_stat_statements`,
  `auto_explain`), and storage-module-level (how long a `TemporalKV.getAt`,
  a `CheckpointStore.save`/`prune` pass, or a lease acquisition actually
  takes under realistic load).
- **Benchmarking** — repeatable, versioned measurements of the workloads
  UmbraDB is designed for: versioned KV read/write throughput and latency,
  checkpoint save/load/dedup-ratio at realistic chunk-store sizes, GC pass
  duration as the chunk store grows, and lease contention behavior under
  concurrent writers.
- **DB activity logging** — structured, correlatable logs that tie an
  application-level storage operation to the SQL it issued and how long
  that SQL took, so a slowdown can be traced from "this call was slow" to
  "this is why" without guessing.

Nothing here yet — this directory is being seeded by a dedicated research
pass (see the project's research history) before any tooling choice is
locked in, matching how the rest of this project's design decisions have
been made.
