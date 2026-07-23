# Acceptance criteria — v1.0.0-perf-baseline

Consolidated, testable acceptance criteria for the whole change. Each is objective (a test, CI
gate, doc artifact, or recorded measurement could prove it) and traces to a spec requirement and a
gate item. **Verification legend:** `unit` = unit/integration test (vitest + Testcontainers);
`prop` = property test (`fast-check`); `bench` = recorded benchmark measurement / artifact;
`ci` = CI gate; `doc` = doc artifact; `manual` = manual differential evidence.

## G13 — perf-correctness fixes (land first)

| # | Criterion (objective, checkable) | Requirement | Verify |
|---|---|---|---|
| A1 | A `save` of `N ≥ 2` chunks issues **exactly one** chunk-insert statement and **exactly one** junction-insert statement; the statement count does not grow with `N` (constant across `N ∈ {1,16,64}`), measured by a query-counting connection spy. If a query-counting spy is impractical against this project's `postgres.js` usage, the test MUST instead assert round-count constancy across `N` via the emitted SQL (postgres.js `debug` hook) and record, in a comment, which guarantee is actually verified — per Sprint 4 task 1.1's precedent. | save() bounded round-trips (HP-1) | unit |
| A2 | The batched chunk insert applies `ON CONFLICT (hash) DO UPDATE SET created_at = now()` (not `DO NOTHING`) — a re-referenced existing chunk has its `created_at` refreshed. | save() bounded round-trips (HP-1) | unit |
| A3 | A payload written by the batched `save` (including one with a repeated chunk hash at two distinct positions) `load`s back byte-identical, passes every `checkpoint-store.ts` integrity check, and yields the same `manifest_hash` the pre-change `save` produced. | batching preserves save/history semantics | unit |
| A4 | A near-duplicate save reuses existing chunk rows via `ON CONFLICT` with no duplicate chunk rows written (dedup behavior unchanged by batching). | batching preserves save/history semantics | unit |
| A5 | `history(limit=50)` over 50 manifests issues **exactly two** queries total (page query + one grouped aggregate), measured by the query spy (same spy-impracticality fallback as A1: fall back to emitted-SQL inspection and record which guarantee is verified). | history() single GROUP BY (HP-2) | unit |
| A6 | Each `history` `CheckpointSummary`'s `chunkCount`/`byteLength` equals the pre-change value, in the same `ORDER BY seq DESC` order. | history() single GROUP BY (HP-2) | unit |
| A7 | `information_schema` shows `ckpt_chunks.size_bytes` as an `integer` generated column, and a freshly inserted `L`-byte chunk has `size_bytes = L`. | size_bytes stored column (IS-2) | unit |
| A8 | `history`'s aggregate SQL references `c.size_bytes`, not `octet_length(c.data)` (asserted against the emitted query text; the intent — not detoasting the `data` heap to length it — is the rationale, not a separately asserted plan property). | size_bytes stored column (IS-2) | unit |
| A9 | `pg_class.reloptions` for `kv_current` includes `fillfactor=90` after migrations run. | kv_current fillfactor (IS-1) | unit |
| A10 | No index exists on `kv_current` beyond the `(ns,scope,key)` primary key (guard so a future migration can't defeat HOT by indexing a changing column). | kv_current fillfactor (IS-1) | unit |
| A11 | Both new migrations (`005_kv_current_fillfactor`, `006_ckpt_chunks_size_bytes`) are forward-only (`ALTER`/`ADD COLUMN`), registered in `tier1WalletMigrations`, and `runMigrations` applies them cleanly on top of `000..004`. | IS-1 + IS-2 | unit |
| A12 | `tsc --noEmit` passes with the batched `save`/`history` and the two migrations. | HP-1/HP-2 | ci |

## G14 — benchmark harness + recorded baseline

| # | Criterion (objective, checkable) | Requirement | Verify |
|---|---|---|---|
| B1 | `npm run bench` runs at least one workload through a real `src/postgres/*` adapter against Testcontainers PG17 (pinned image digest + pinned `shared_buffers`/`work_mem`/`max_wal_size`) and prints p50/p95/p99 + CV from the warmup-aware statistics library. | harness drives real adapters | bench |
| B2 | An import-graph/grep check confirms `bench/` imports **no** consumer or indexer package (indexer-agnostic boundary, G11). | harness drives real adapters | ci |
| B3 | All per-module workloads run (CheckpointStore save/load/history/prune + dedup ratio; TemporalKV put/get/getAt; Watermarks set; TransactionHistory churn + GIN p99; lease/tx contenders), and the lease workload sizes pool `max` above the contender count. | harness drives real adapters | bench |
| B4 | A committed `bench/baseline.<harness-version>.json` exists, keyed by harness version, capturing per-workload p50/p95/p99 + CV, GC curve (with `K`/`D` cliff params + determination), dedup ratio, HOT ratios, and the pinned environment. **Structural reproduction:** re-running the harness at the recorded version against the same pinned image digest + server settings completes and emits an artifact conforming to the same schema (same workload set, same declared envelope, same statistic fields) — no numeric-threshold comparison. | baseline recorded (G14 gate) | bench + manual |
| B5 | **The only performance condition on the 1.0.0 tag is that B4's baseline exists and reproduces — no latency/throughput number is a required gate.** CI has no failing-on-number performance step. | baseline recorded; CV-gate deferred | ci + manual |
| B6 | The `save`/`history` paths the baseline measures are the batched shapes (§HP-1/HP-2), not the pre-change loops — i.e. §1 merged before B4 was recorded. | baseline reflects shipped shape | manual |
| B7 | The GC anti-join is measured across the declared 10^5–10^6-chunk envelope (not 10^7); the curve, the declared envelope, the operational cliff parameters `K` and `D`, and the recorded cliff determination are all captured in the baseline. | GC anti-join declared envelope (HP-6) | bench |
| B8 | If (and only if) B7's curve meets the declared cliff condition (`K`×/`D` rule) inside the envelope, a bounded batched GC sweep ships in 1.0.0 with reclaim-equivalence tested; otherwise the single-statement delete is retained and SC-2 documents the cost. The cliff determination is recorded as an explicit adjudication in the baseline + task 2.4 close-out. | GC anti-join declared envelope (HP-6) | unit + doc |
| B9 | The observed `kv_current` `n_tup_hot_upd / n_tup_upd` ratio is recorded in the baseline under sustained puts, documented as a measured observation (not a causal isolation of `fillfactor`). | kv_current fillfactor (IS-1), soak | bench |
| B10 | `Performance/CEILINGS.md` (or README section) names SC-1..SC-6, states each limit and its post-1.0.0 deferral (IS-3, streaming load, IS-4, TOAST-mode), and SC-2 cites the declared-envelope GC curve. | scalability ceilings documented | doc |
| B11 | A coarse, order-of-magnitude regression **smoke guard is wired now** as a CI check (per roadmap G14 "coarse gate now"), documented as non-release-gating (does not fail the build on any calibrated number); the CV-aware calibrated gate is documented as deferred to the first post-1.0.0 obligation. | coarse guard wired; CV-aware gate deferred | doc + ci |

## Boundary / non-goal assertions (must remain true)

| # | Criterion | Source |
|---|---|---|
| C1 | No `idempotency_key`/UNIQUE is added to `save` in this change; HP-1 batching does not claim to make `save` retry-safe. | roadmap Deferred; council/B §5.3 |
| C2 | No consumer/indexer app is imported anywhere in this change (harness or tests). | roadmap G11; MEMORY.md |
| C3 | Chunk addressing / dedup semantics are unchanged (dedup is only *measured*, not re-keyed); keyed chunking remains a 1.1 item. | roadmap G13/G16; §Non-goals |
| C4 | HP-3, HP-5, IS-3, IS-4, SC-3, SC-6 are measured and/or documented, not optimized, in this change. | council/B §4; report 03 SC list |
| C5 | The whole-change differential review (task 4.1) confirms the two hard-rule invariants: baseline exists with no perf-number gate, and §1 batching merged before the baseline was recorded. | council/B §3; council/A §Phase-3 |
