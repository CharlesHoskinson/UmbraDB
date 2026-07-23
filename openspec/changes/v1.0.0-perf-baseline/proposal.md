# Proposal — v1.0.0-perf-baseline

> **Status:** Proposed. Part of the UmbraDB 1.0.0 program (`ROADMAP-v1.0.0-CONSOLIDATED.md`,
> gate section **D. Performance**). Change id: `v1.0.0-perf-baseline`; capability:
> `performance-baseline`.

## Why

The 1.0.0 gate has exactly one performance obligation and it is deliberately narrow: **a
benchmark baseline must exist and be recorded** (`ROADMAP-v1.0.0-CONSOLIDATED.md` G14 — "it is
an explicit acceptance-checklist item"). No performance *number* gates the release
(council/B §3's ruling: "it must **exist and be recorded** to tag 1.0.0 … but **no performance
number gates the release**"; council/A §Phase-3). But a baseline is only worth recording if it
reflects the shape the library will actually ship, so two of the four adapters must first have
their purely-structural round-trip amplification removed — otherwise the baseline is "dead on
arrival" (council/A §Phase-3, "Dependency: baseline after batching fixes").

Report 03 (Performance & Scalability) found the two most acute, code-real bottlenecks are not in
the exotic GiST/GIN paths but in `CheckpointStore`, and both are pure round-trip amplification
fixable with batched SQL independent of any Postgres tuning:

- **HP-1** — `save()` issues `2N` sequential per-chunk round-trips inside one transaction
  (`src/postgres/checkpoint-store.ts:156-162` chunk-upsert loop + `:190-195` junction-insert
  loop). A 64 MB checkpoint at the 4 MiB default chunk size = 16 chunks = **32 serialized await
  round-trips per save**, all holding the writer's transaction (and, in production, the global
  writer lease) open. Beyond latency, this **widens every crash-race window** the Milestone-3
  crash-injection probes target (council/B §4: "it stretches the window during which the writer
  transaction … is held, which directly widens every crash-race window T1/T2 probe").
- **HP-2** — `history()` is a textbook N+1: one aggregate query per manifest in the page
  (`src/postgres/checkpoint-store.ts:322-328`), each of which touches `ckpt_chunks.data`
  (a TOAST-able `bytea`) purely to `octet_length()` it. `history(limit=50)` = 1 + 50 queries.

Plus one one-line schema fix on the hottest sync-write table:

- **IS-1** — `kv_current` (`src/postgres/migrations/001_temporal_kv.ts:73-84`) takes no storage
  parameter, so it defaults to `fillfactor=100` and its updates likely miss HOT (Heap-Only
  Tuple), spilling to new pages and bloating the PK index under exactly the soak test's workload
  (council/B §4). The `watermarks` table (Sprint 4) already established `fillfactor=90` as this
  project's template for a hot-update table.

Once those land, the benchmark harness records the baseline — with the **GC reachability
anti-join** (`src/postgres/checkpoint-store.ts:397-404`, HP-6) measured to a **declared scale
envelope**, because it is "the only perf item that can make a core operation *unusable*"
(council/B §4) and its behavior at scale is empirically unknown
(`Performance/GC_AND_TRACING_RESEARCH.md`).

## 1.0.0 gate items addressed

- **G13** — Land the perf-correctness fixes *first*: `save` `UNNEST` batching (HP-1), `history()`
  N+1 → single `GROUP BY` (HP-2, paired with the IS-2 `size_bytes` generated column so the
  aggregate never detoasts `data`), and `kv_current fillfactor=90` (IS-1). These precede the
  baseline.
- **G14** — Record a benchmark baseline as an explicit acceptance-checklist item: an in-repo
  harness driving the real adapters against a pinned Postgres, a committed baseline artifact, the
  GC anti-join measured to a declared scale envelope, and the scalability ceilings (SC-1..SC-6)
  documented. **Coarse now; the CV-aware regression *gate* is the first post-1.0.0 obligation.**

## What changes

1. **`PgCheckpointStore.save`** — the two per-chunk `for`-loops of single-row awaits
   (`checkpoint-store.ts:156-162`, `:190-195`) become **two multi-row statements** via
   `unnest($1::bytea[], $2::bytea[])` (chunks) and `unnest($1::bigint[], $2::int[], $3::bytea[])`
   (junction rows). `2N` round-trips → `2`. **No public signature change** — an internal
   implementation change only; the `ON CONFLICT (hash) DO UPDATE SET created_at = now()` dedup
   semantics (load-bearing for prune's grace window) and the position-keyed junction shape are
   preserved exactly.
2. **`PgCheckpointStore.history`** — the per-manifest aggregate loop
   (`checkpoint-store.ts:322-328`) becomes a **single grouped query**
   (`WHERE mc.manifest_id = ANY($1) GROUP BY mc.manifest_id`). 1+N queries → 2.
3. **`ckpt_chunks.size_bytes`** — a new `integer GENERATED ALWAYS AS (octet_length(data)) STORED`
   column (a forward-only migration), so `history()`'s aggregate sums a stored `size_bytes`
   instead of detoasting `data`. The pattern is already proven in-repo
   (`src/postgres/migrations/chain_archive/001_chain_archive_core.ts:123`).
4. **`kv_current` `fillfactor=90`** — a new forward-only migration
   (`ALTER TABLE … SET (fillfactor = 90)`), restoring HOT eligibility on the hottest sync-write
   table. Verified via `pg_stat_user_tables.n_tup_hot_upd`.
5. **A benchmark harness** — a new in-repo TypeScript suite driving the real adapter interfaces
   against a Testcontainers-pinned PG17, producing a **committed baseline artifact** keyed by a
   harness version; the GC anti-join measured across a declared scale envelope; scalability
   ceilings documented.

## Non-goals (explicitly out of scope for this change)

- **No performance number gates the release.** Only the *existence* of a recorded baseline gates
  1.0.0 (council/B §3; council/A §Phase-3; G14's hard rule). This change wires no
  numeric-threshold release blocker.
- **CV-aware *calibrated* regression gate is deferred post-1.0.0.** A
  coefficient-of-variation-calibrated regression gate is "the first post-1.0.0 obligation" (G14;
  council/B §3: "the regression gate is the *first post-1.0.0* obligation"), not built here. Note
  this is a scoping line, not a total deferral of *all* regression checking: per the roadmap's
  "Coarse gate now" ruling (G14; council/A §Phase-3), a coarse, order-of-magnitude, **non-release-
  gating** smoke guard **is** wired now as a CI check — it flags gross regressions but never fails
  the build on a calibrated number, and is explicitly not a perf-number release blocker. It is the
  *calibrated* gate, not the coarse guard, that is deferred.
- **HP-3 / HP-5 / HP-6-remediation / IS-3 / IS-4 / SC-3 / SC-6 are measure-or-document only.**
  The `kv_history` trigger path (HP-3), TransactionHistory round-trip reduction (HP-5),
  `kv_history` partitioning/retention (IS-3), GIN `fastupdate` tuning (IS-4), streaming `load`
  (SC-3), and TOAST storage-mode choice (SC-6) are benchmarked and/or documented as ceilings, but
  **not optimized** in 1.0.0 (council/B §4, "Optimization — post-1.0"; roadmap "Deferred" table).
  The one conditional exception: if the GC curve *cliffs inside the declared envelope*, batching
  the GC sweep becomes an in-scope 1.0.0 fix (council/B §4); otherwise the ceiling is documented.
- **The activity-logging / tracing wrapper (LOG in report 03) is not part of this change.** It is
  Milestone-4's third deliverable but not a 1.0.0 perf-baseline gate item.
- **No consumer/indexer app is imported to drive the benchmark.** The harness drives the real
  UmbraDB adapters directly; importing a foreign consumer would breach UmbraDB's indexer-agnostic
  boundary (roadmap G11; `MEMORY.md` "UmbraDB sync architecture boundary").
- **`save()` idempotency** (`idempotency_key` + UNIQUE) is P1 "with Sprint 9", **not** in this
  change (roadmap Deferred table; council/B §5.3). The HP-1 batching here does not make `save`
  retry-safe and does not claim to.
- **`kv_history` time-partitioning (IS-3), streaming reconstruction (SC-3), GIN tuning (IS-4),
  TOAST-mode selection (SC-6)** — documented ceilings only, per report 03's SC list, which
  council/B §4 endorses as written.

## Impact

- **New in this repo**: a benchmark harness directory (e.g. `bench/` with `mitata` or `tinybench`
  for microbench statistics — whichever is chosen added as a **direct `devDependency`**, not relied
  on transitively via `vitest`, Testcontainers PG17), a committed baseline artifact (JSON keyed by
  harness version), a scalability-ceilings doc section (`Performance/` or `docs/`); two new
  forward-only migrations —
  `src/postgres/migrations/005_kv_current_fillfactor.ts` (IS-1) and a `ckpt_chunks.size_bytes`
  migration (IS-2) — added to `src/postgres/migrate.ts`'s `tier1WalletMigrations` array.
- **Modified**: `src/postgres/checkpoint-store.ts` (`save` batching, `history` grouped query
  reading `size_bytes`); `src/postgres/migrate.ts` (migrations array, final order
  `[…004, 005, 006]`); `package.json` (bench script + the chosen microbench library — `mitata` or
  `tinybench` — as a direct `devDependency`).
- **Risk**: HP-1/HP-2 are behavior-neutral structural rewrites (council/A §Phase-3: "behavior-
  neutral, but they must precede measurement"); the primary risk is a batching rewrite that
  silently changes dedup, ordering, or manifest-hash semantics — covered by an equivalence
  requirement (spec §"batching preserves existing save/history semantics") asserting the batched
  path is byte-identical to the pre-change path. The `size_bytes` generated column and the
  `fillfactor` change affect new rows/pages only (forward-only, GA-safe). The GC-envelope
  measurement is the schedule risk: bounded by declaring the envelope (10^5–10^6 chunks, not
  10^7 — council/B §1: "'multi-GB / 10^7 chunks' exceeds the plausible envelope of a *local
  wallet datastore*").
- **Sequencing**: this change owns roadmap critical-path step 3 (**G13 → G14**), which runs after
  G5/G6/G7/G8 (durability) and *before* the long-pole crash/soak suite (G9/G10/G11). Internally,
  the three G13 fixes land first, then the harness, then the baseline is recorded. The harness
  can be *stood up* in parallel with earlier phases, but the baseline is **recorded only after
  G13 has merged** (council/A §Phase-3). This change coordinates with G5 (co-transactional
  `save`, a separate change) which owns `save()`'s *signature* change; G13's `save` edits are
  internal-only and compose with it.
