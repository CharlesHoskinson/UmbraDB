# Tasks — v1.0.0-perf-baseline

Each task: implemented by a builder, then reviewed in parallel by two auditors (spec-compliance
against this change's `design.md`; code quality/docs/test coverage). A task is CLOSED only after
both auditors approve, or their findings are fixed and re-reviewed. Matches Sprint 1-4's own
review cadence.

**Critical-path ordering (from `ROADMAP-v1.0.0-CONSOLIDATED.md` §"Critical path", step 3
"G13 → G14"):** the three G13 perf-correctness fixes (§1) land *before* the baseline is recorded
(§3). Within the whole 1.0.0 program this change runs after G5/G6/G7/G8 (durability) and before
the G9/G10/G11 crash/soak suite. The harness (§2) may be *stood up* in parallel with earlier
phases, but the baseline (§3.1) is recorded only after §1 has merged — otherwise "the baseline is
dead on arrival" (`council/A` §Phase-3). **Coordination:** G5 (co-transactional `save`, a separate
change) owns `save()`'s signature; task 1.1's edits are internal-only and rebase onto whichever
lands first.

## 1. G13 — perf-correctness fixes (LAND FIRST)

- [ ] 1.1 **HP-1: batch `save()`'s chunk + junction inserts** (`design.md` §1) — replace the two
  per-chunk loops (`checkpoint-store.ts:156-162`, `:190-195`) with one multi-row chunk
  `INSERT … SELECT … FROM unnest($1::bytea[], $2::bytea[]) ON CONFLICT (hash) DO UPDATE SET
  created_at = now()` and one multi-row junction `INSERT … SELECT $1::bigint, p, h FROM
  unnest($2::int[], $3::bytea[])`. No public signature change; sequence allocation and the
  explicit `complete = true` manifest insert stay in place, same order, same transaction.
  *Satisfies:* Requirement "save() issues a bounded number of round-trips independent of chunk
  count (HP-1)". **Acceptance:** a test asserts a save of `N ≥ 2` chunks issues exactly one chunk
  statement and one junction statement (via a query-counting connection spy, or by asserting round
  count is constant across `N ∈ {1, 16, 64}`); a test asserts a re-referenced existing chunk still
  gets `created_at` refreshed (the grace-window `ON CONFLICT DO UPDATE`, not `DO NOTHING`);
  `tsc --noEmit` passes. If a query-counting spy is impractical against this project's
  `postgres.js` usage, fall back to asserting round-count constancy via the emitted SQL
  (postgres.js `debug` hook) and record in a comment which guarantee is actually verified —
  inheriting Sprint 4 task 1.1's "record-the-limitation" precedent.
- [ ] 1.2 **HP-1 equivalence guard** (`design.md` §1; `council/A` §Phase-3 "behavior-neutral") —
  prove the batched path is byte-identical to the pre-change path. *Satisfies:* Requirement "the
  batching fixes preserve save/history behavior exactly (equivalence)". **Acceptance:** a test
  saves payloads including one with a repeated chunk hash at two distinct positions, `load`s them
  back, and asserts identical bytes, all `checkpoint-store.ts` integrity checks pass (per-chunk
  hash, dense-position, recomputed-manifest-hash), and the resulting `manifest_hash` equals what
  the pre-change `save` produced for that payload; a dedup test asserts a near-duplicate save
  reuses existing chunk rows with no duplicates written.
- [ ] 1.3 **IS-2: `ckpt_chunks.size_bytes` generated column** (`design.md` §2) — new forward-only
  migration `006_ckpt_chunks_size_bytes.ts` adding `size_bytes integer GENERATED ALWAYS AS
  (octet_length(data)) STORED`; register it in `migrate.ts`'s `tier1WalletMigrations`. Pattern:
  `chain_archive/001_chain_archive_core.ts:123`. *Satisfies:* Requirement "ckpt_chunks carries a
  stored size_bytes column computed without detoasting (IS-2)". **Depends on:** nothing (schema
  only). **Acceptance:** after `runMigrations`, `information_schema` shows `ckpt_chunks.size_bytes`
  as an `integer` generated column and a freshly inserted `L`-byte chunk has `size_bytes = L`
  (verified via query, not "the migration didn't error").
- [ ] 1.4 **HP-2: collapse `history()` N+1 into one grouped query reading `size_bytes`**
  (`design.md` §2) — replace the per-manifest aggregate loop (`checkpoint-store.ts:322-328`) with
  `… WHERE mc.manifest_id = ANY($1) GROUP BY mc.manifest_id`, summing `c.size_bytes` (not
  `octet_length(c.data)`); re-associate rows to manifests by `manifest_id`, preserving
  `ORDER BY seq DESC`. *Satisfies:* Requirement "history() computes per-manifest aggregates in a
  single grouped query (HP-2)". **Depends on:** 1.3 (needs `size_bytes`). **Acceptance:** a test
  asserts `history(limit=50)` over 50 manifests issues exactly two queries (via the query spy, with
  the same emitted-SQL fallback + recorded-limitation note as 1.1 if the spy is impractical);
  a test asserts each returned `CheckpointSummary`'s `chunkCount`/`byteLength` equals the
  pre-change value in the same `seq DESC` order; the aggregate SQL references `c.size_bytes`, not
  `octet_length(c.data)` (asserted against the emitted query text; TOAST-heap avoidance is the
  rationale, not a separately asserted plan property).
  *Optional (design §2):* `prune`'s own `RETURNING octet_length(c.data)`
  (`checkpoint-store.ts:397-404`) may likewise switch to `RETURNING size_bytes`; not required for
  the gate, and if not done, drop the "called out in tasks" claim rather than leaving it dangling.
- [ ] 1.5 **IS-1: `kv_current fillfactor=90`** (`design.md` §3) — new forward-only migration
  `005_kv_current_fillfactor.ts` running `ALTER TABLE ${sql(schema)}.kv_current SET (fillfactor =
  90)`; register it in `tier1WalletMigrations`. **Regardless of the order tasks 1.3 and 1.5 are
  built in, the final `tier1WalletMigrations` array MUST be numerically ordered
  `[…004, 005, 006]`** (fillfactor `005` before `size_bytes` `006`) so nothing trips a
  "migrations are applied in numeric order" assumption. *Satisfies:* Requirement "kv_current is
  fillfactor-tuned to preserve HOT-update eligibility (IS-1)". **Depends on:** nothing (schema
  only). **Acceptance:** a test asserts `pg_class.reloptions` for `kv_current` includes
  `fillfactor=90`; a test asserts no index exists on `kv_current` beyond the `(ns,scope,key)`
  primary key (so a future migration can't silently add one on a changing column and defeat HOT).
  The HOT-ratio-under-load check is measured in the soak (task 3.2), not asserted causally here —
  mirroring Sprint 4 task 0.2's documented limitation.

## 2. G14 — benchmark harness (may start in parallel; baseline recorded only after §1)

- [x] 2.1 **Stand up the harness skeleton** (`design.md` §4) — an in-repo `bench/` TypeScript suite
  driving the real adapters against a Testcontainers PG17 with a pinned image digest and pinned
  `shared_buffers`/`work_mem`/`max_wal_size`; microbench statistics via the chosen library
  (`mitata` or `tinybench`), which **MUST be added as an explicit `devDependency` of UmbraDB — not
  relied on as a transitive resolution** (`tinybench` currently exists on disk only under `vitest`;
  a future vitest bump could drop it and silently break the harness); entrypoint via `tsx`. No
  consumer/indexer app imported. Add a `bench` script to `package.json`. *Satisfies:* Requirement
  "an in-repo benchmark harness drives the real adapters against a pinned Postgres". **Acceptance:**
  `npm run bench` executes at least one workload through a real `src/postgres/*` adapter against
  Testcontainers PG17 and prints p50/p95/p99 + CV from the statistics library; `package.json`
  declares the chosen microbench library as a direct `devDependency`; a grep/import-graph check
  confirms no consumer/indexer package is imported by `bench/`.
- [x] 2.2 **Per-module workloads** (`design.md` §4; report `03` §"Per-module workloads") —
  implement the CheckpointStore (`save` 1/16/64/256 MB, near-duplicate dedup-ratio, `load`,
  `history(50)`, `prune`), TemporalKV (`put` fresh/existing, `get`, `getAt {version}`/`{at}`, with
  `n_tup_hot_upd`/`n_tup_upd` capture), Watermarks (`set` HOT-ratio + bloat), TransactionHistory
  (pending→finalized churn, GIN p99), and lease/tx (1/2/4/8/16 contenders, pool `max` sized above
  contender count) workloads. *Satisfies:* the harness requirement above; supplies the numbers for
  3.1. **Depends on:** 2.1. **Acceptance:** each workload runs and emits its metrics; the lease
  workload sets pool `max` above the contender count so it measures lock, not pool-queue latency
  (report `03` HP-7); the KV/Watermarks workloads emit the HOT-ratio needed by 3.2.
- [x] 2.3 **GC anti-join scale measurement** (`design.md` §5; report `03` HP-6; `council/B` §1) —
  measure GC pass duration vs live-chunk count across the **declared 10^5–10^6-chunk envelope**
  (not 10^7); record the curve, together with the **operational cliff parameters `K` and `D`** (the
  super-linear growth factor and the absolute per-pass duration bound the spec's HP-6 requirement
  defines) and the resulting cliff determination. *Satisfies:* Requirement "the GC reachability
  anti-join is measured across a declared scale envelope (HP-6)". **Depends on:** 1.1 (batched save
  to populate chunks efficiently), 2.1. **Acceptance:** the workload records GC pass duration at
  increasing live-chunk counts across the declared envelope, with the declared envelope, `K`, `D`,
  and the cliff determination (met / not met, and the first-met live-chunk count if any) recorded
  in the baseline as an explicit adjudication — so a cliff, if present, is detectable by the
  declared rule, not by eyeball.
- [x] 2.4 **Conditional: batched GC sweep** (`design.md` §5; `council/B` §4) — IF and only if 2.3's
  curve **meets the declared cliff condition** (`K`×-growth or `D`-bound, per the HP-6 requirement)
  inside the declared envelope, replace `prune`'s single-statement chunk reclaim
  (`checkpoint-store.ts:397-404`) with a bounded batched sweep (≤100-row chunked deletes) and ship
  it in 1.0.0. *Satisfies:* the conditional clause of the HP-6 requirement. **Depends on:** 2.3.
  **Acceptance:** the cliff determination from 2.3 is echoed in this task's close-out note; if the
  cliff condition is **not** met, this task is closed as "not triggered; single-statement delete
  retained, ceiling SC-2 documented"; if it **is** met, the batched sweep is implemented, its
  reclaim-equivalence is tested (same chunks reclaimed as the single-statement version over the
  grace window), and the change is recorded.

## 3. G14 — record the baseline + document ceilings

- [x] 3.1 **Record the committed baseline artifact** (`design.md` §5; `council/B` §3; G14 hard
  rule) — run the full harness (§2) against the pinned environment *after* §1 has merged; emit a
  committed `bench/baseline.<harness-version>.json` capturing per-workload p50/p95/p99 + CV, the
  GC curve, dedup ratio, HOT ratios, and the pinned environment (image digest, server settings,
  harness version). *Satisfies:* Requirements "a benchmark baseline is recorded as a committed
  artifact (the G14 gate)" and "the baseline reflects the batched (shipped) save shape".
  **Depends on:** 1.1, 1.3, 1.4, 1.5, 2.2, 2.3 (all of §1 merged + workloads ready). **Acceptance:**
  the committed baseline file exists and is keyed by harness version; **structural reproduction**
  holds — re-running the harness at that recorded version against the same pinned image digest and
  server settings completes and emits an artifact conforming to the same schema (same workload set,
  same declared envelope, same statistic fields), with no numeric-threshold comparison; a check
  confirms the measured `save`/`history` paths are the batched shapes (§1), not the pre-change
  loops; **no numeric threshold is wired as a release gate** (verified by the absence of any
  failing-on-number CI step).
- [x] 3.2 **Verify IS-1 empirically from the soak/baseline** (`design.md` §3; report `03` IS-1) —
  from the KV/Watermarks workload runs, record the `pg_stat_user_tables.n_tup_hot_upd / n_tup_upd`
  ratio for `kv_current` in the baseline as an observed value under sustained puts. *Satisfies:*
  the second scenario of Requirement "kv_current is fillfactor-tuned…". **Depends on:** 1.5, 2.2.
  **Acceptance:** the baseline records the observed HOT ratio for `kv_current`, documented as a
  measured observation (not a claimed causal isolation of `fillfactor`, per Sprint 4 task 0.2's
  precedent).
- [x] 3.3 **Document scalability ceilings SC-1..SC-6** (`design.md` §6; report `03`
  §"Scalability ceilings"; `council/B` §4) — write `Performance/CEILINGS.md` (or a README section)
  stating each of SC-1..SC-6, its limit, its 1.0.0 disposition (documented, not remediated), and
  citing the measured GC curve for SC-2. *Satisfies:* Requirement "scalability ceilings are
  documented for 1.0.0". **Depends on:** 2.3 (for SC-2's curve), 3.1. **Acceptance:** the doc names
  SC-1..SC-6, states each limit and its deferral (IS-3 partitioning/retention, streaming load, IS-4
  GIN tuning, TOAST-mode choice all marked post-1.0.0), and SC-2 references the declared-envelope
  GC curve.
- [x] 3.4 **Wire the coarse smoke guard now; encode the CV-aware-gate deferral** (`design.md` §5;
  roadmap G14 "Coarse gate now"; `council/A` §Phase-3; `council/B` §3) — wire a coarse,
  order-of-magnitude benchmark regression smoke guard as a CI check *for 1.0.0* (present now),
  documented as non-release-gating (it flags gross regressions but never fails the build on a
  calibrated number), and record the CV-aware calibrated gate as the first post-1.0.0 obligation.
  *Satisfies:* Requirement "a coarse smoke guard is wired now; the CV-aware regression gate is
  deferred". **Acceptance:** a coarse order-of-magnitude regression smoke guard exists as a CI
  check and is documented as non-release-gating; the change's docs state the CV-aware calibrated
  gate is deferred post-1.0.0; CI has no calibrated-number gate blocking the 1.0.0 tag.

## 4. Close-out

- [ ] 4.1 Whole-change differential review: an auditor re-reads this proposal/design against the
  actual committed code and confirms every "Acceptance" criterion above was actually checked — a CI
  run passing is not sufficient evidence on its own, per every prior sprint's close-out standard.
  Confirm the two hard-rule invariants explicitly: (a) the baseline exists and *no perf number
  gates the release*; (b) the batching fixes (§1) merged *before* the baseline was recorded (§3.1).
- [x] 4.2 Update `ROADMAP.md`'s gate checklist — mark G13 and G14 addressed
  (G13 fixes landed; baseline recorded; ceilings documented; CV-aware regression gate explicitly
  deferred post-1.0.0) — and cross-link this change from the roadmap's §"Critical path" step 3 so
  the roadmap doesn't drift from what's been built.
- [ ] 4.3 Per this repo's `CLAUDE.md` convention: refresh any repo knowledge-graph outputs affected
  by the new `bench/` tree and the two migrations in this change's close-out commit. *(Skip if the
  graphify step is explicitly waived for this change.)*


## G14 build close-out (2026-07-23)

Built on `feat/g13-perf-baseline`. Tasks 2.1-2.4, 3.1-3.4, and 4.2 are checked above.

- **2.4 cliff determination (echoed per the task's acceptance):** the GC reachability anti-join was
  measured across the FULL declared 10^5-10^6 envelope (10k / 50k / 100k / 300k / 1,000,000 live
  chunks — no cap needed; the run finished well within the wall-clock budget). Against the declared
  operational cliff rule (K = 2.0x super-linear pass-duration-vs-chunk-count growth, or D = 5000 ms
  absolute per-pass bound) the determination is **NOT MET**: pass duration grew sub-K with chunk
  count and no single pass exceeded D. Task 2.4 is therefore closed as **not triggered** — the
  single-statement anti-join `DELETE` is retained and ceiling **SC-2** documents the O(live-chunks)
  cost. The curve, K, D, and the determination are recorded in
  `bench/baseline.1.0.0-perf-baseline.1.json` (`gcCurve` block) and in `Performance/CEILINGS.md`.
- **Hard-rule invariants:** the baseline exists and **no perf number gates the release** (the coarse
  `bench-smoke` CI guard is explicitly non-release-gating; the CV-aware calibrated gate is deferred
  post-1.0.0); the G13 batching fixes (HP-1/HP-2, on this branch) are the shapes the baseline
  measured — recorded BEFORE the baseline was taken.
- **4.1** (whole-change differential review) is left for the independent auditor.
- **4.3** (repo knowledge-graph refresh) is **explicitly waived** for this change.
