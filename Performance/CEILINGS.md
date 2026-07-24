# Scalability ceilings (v1.0.0)

These are the known scalability limits UmbraDB ships with at 1.0.0. Each is a **1.0.0 contract** —
stated here so operators discover it in docs, not in production
(`openspec/changes/v1.0.0-perf-baseline/design.md` §6; report `03` §"Scalability ceilings";
council/B §4). Every item on this list is **documented, not remediated** in 1.0.0; the remediation,
where one is named, is a post-1.0.0 item (IS-3 partitioning/retention, streaming `load`, IS-4 GIN
tuning, TOAST-mode choice).

The G14 gate is the **existence** of a recorded benchmark baseline, not any performance number
(`design.md` §5; G14 hard rule). The baseline artifact is
[`bench/baseline.1.0.0-perf-baseline.1.json`](../bench/baseline.1.0.0-perf-baseline.1.json); the
harness that reproduces it is `bench/` (run `npm run bench`). Reproduction is **structural** — a
re-run at the recorded harness version against the same pinned image + server settings emits a
schema-conforming artifact; no latency/throughput number is compared.

## Environment pinning (for reproduction)

- **Image**: pinned by **digest** —
  `postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193`, the exact
  17-alpine image that produced this baseline (resolved from the local image's RepoDigest). The
  harness container **starts from this digest** (`bench/environment.ts`), so the pin is enforced at
  run time rather than merely recorded after the fact; the resolved local image id is additionally
  recorded in the baseline's `environment.postgresImageId` as corroboration.
- **Server settings** (pinned for run-to-run comparability): `shared_buffers=256MB`,
  `work_mem=16MB`, `max_wal_size=2GB`, `max_parallel_workers_per_gather=0`.
- **Microbench library**: `tinybench` (an explicit UmbraDB `devDependency`, warmup-aware; NOT the
  transitive vitest copy — `design.md` §4).

---

## SC-1 — `kv_history` unbounded growth

`TemporalKV` retains every superseded version forever in 1.0.0: each update to `kv_current` fires
the `kv_current_history_bu` trigger, writing one `kv_history` row (guarded by a GiST-EXCLUDE
constraint + two btree indexes) per superseded version, with **no retention policy**
(`temporal-kv.ts`; `migrations/001_temporal_kv.ts`). History therefore grows without bound under
sustained key churn.

- **Disposition (1.0.0):** documented. History is retained forever; plan a retention policy before
  high-churn production use.
- **Remediation (deferred):** `kv_history` partitioning + retention = **IS-3**, post-1.0.0.

## SC-2 — `ckpt_chunks` GC cost is O(live chunks), full anti-join per pass

`prune`'s chunk reclaim is a single-statement full-scan anti-join of `ckpt_chunks` against
`ckpt_manifest_chunks` (`checkpoint-store.ts`), correctly shaped (a btree anti-join on
`ckpt_manifest_chunks_by_hash`, not a GIN/`ANY()` scan — `Performance/GC_AND_TRACING_RESEARCH.md`)
but **O(live chunks)** with a full scan per pass.

The G14 harness measures GC-pass duration vs live-chunk count across a **declared 10^5–10^6-chunk
envelope** (`bench/workloads/gc.ts`) and adjudicates a cliff by a declared rule (not by eyeball):

- **Cliff rule.** A cliff is met when, between two measured points, GC-pass-duration growth exceeds
  **K = 2.0×** the live-chunk-count growth (super-linear), OR when any single pass exceeds the
  absolute bound **D = 5000 ms**. `K`, `D`, the measured curve, and the resulting determination
  (met / not-met, first-met chunk count) are recorded as an explicit adjudication in the baseline
  artifact (`gcCurve` block) and echoed in the change's task 2.4 close-out.
- **Determination & the actual envelope run** are recorded in the baseline's
  `gcCurve.cliffDetermination` and `gcCurve.declaredEnvelope`. Where the run is capped below 10^6
  live chunks for runtime sanity (`design.md` §5's allowance), the un-run upper envelope is
  **this ceiling** — declared here, not measured.
- **Consequence.** If the curve does **not** meet the cliff condition across the envelope, the
  single-statement delete is retained (this SC-2 ceiling stands). If it **does** meet it inside the
  envelope, a bounded batched sweep (pg-boss-style ≤100-row chunked deletes) becomes an in-scope
  1.0.0 fix — the determination in the artifact decides which.

- **Disposition (1.0.0):** documented, with the measured curve + cliff adjudication published in the
  baseline. GC is O(live chunks); size the chunk pool / prune cadence accordingly.
- **Remediation (conditional / deferred):** batched GC sweep, only if the cliff is met in-envelope.

## SC-3 — `load()` single-buffer materialization

`load()` reconstructs a checkpoint by `Buffer.concat`-ing every chunk into a single Node heap buffer
(`checkpoint-store.ts`). Peak memory for a `load` is therefore the whole checkpoint size, bounded by
the single-buffer materialization, and a checkpoint's own chunks are capped by `save`'s chunk-size
option (≤16 MiB per chunk).

- **Disposition (1.0.0):** documented. Treat a single checkpoint's uncompressed size as bounded by
  available Node heap; do not store checkpoints approaching that bound.
- **Remediation (deferred):** streaming reconstruction, post-1.0.0.

## SC-4 — single global writer lease serializes writers

The write path is serialized by a single global writer lease (`transaction-lease.ts`,
`pg_advisory_lock`) — by design, to make crash-race windows tractable. The stated ceiling is the
**measured single-writer write throughput** (the lease acquire/release latency-vs-contenders curve
in the baseline, `lease.acquireRelease.contenders{1,2,4,8,16}`). Concurrent readers + lease
contenders are additionally bounded by the connection pool `max` (default **10**,
`client.ts:49-52`). The lease workload sizes its pool `max` **above** the contender count so the
measurement reflects the lock, not pool-queue latency (report `03` HP-7).

- **Disposition (1.0.0):** documented. Writer throughput is bounded by the single global lease; the
  baseline states the measured ceiling.
- **Remediation:** none in scope; this is an intentional design property, not a defect.

## SC-5 — TransactionHistory GIN `fastupdate` p99 spikes

`transaction_history.identifiers` is a GIN index (`migrations/004_transaction_history.ts`). Under
sustained writes, GIN `fastupdate` pending-list flushes spike write p99 periodically. The baseline
records the observed pending→finalized churn p99 (`transactionHistoryGinWriteP99Ms`).

- **Disposition (1.0.0):** documented, with the observed p99 recorded in the baseline. Expect
  periodic p99 spikes from pending-list flushes under sustained history writes.
- **Remediation (deferred):** the GIN `fastupdate` / `gin_pending_list_limit` knob = **IS-4**,
  post-1.0.0.

## SC-6 — TOAST storage mode on `ckpt_chunks.data`

`ckpt_chunks.data` (`bytea`) uses PostgreSQL's default TOAST mode `EXTENDED` (compress first, then
out-of-line). `EXTENDED` trades CPU (compression) for space; `EXTERNAL` (out-of-line, no
compression) trades space for lower CPU on read/detoast. IS-2's stored `size_bytes` generated column
already removes the detoast from `history()`'s aggregate, so the remaining tradeoff is on
`load`/`prune` payload access.

- **Disposition (1.0.0):** documented (measure-or-document, not changed). The storage-mode *choice*
  is deferred; 1.0.0 keeps the default `EXTENDED`.
- **Remediation (deferred):** the `EXTENDED`-vs-`EXTERNAL` storage-mode choice, post-1.0.0.

---

## Regression gating posture

- A **coarse, order-of-magnitude smoke guard** is wired now (`bench/smoke.ts`, CI job
  `bench-smoke`). It flags a p99 that has moved by more than 10× versus the committed baseline as a
  **non-gating warning**. It **never** fails the build on a calibrated performance number; it exits
  non-zero only on an infrastructure failure (Docker/Testcontainers unavailable), which is not a
  perf-number gate.
- The **calibrated, CV-aware regression gate is deferred** to the first post-1.0.0 obligation. A
  naive 2% gate against a benchmark whose CV is ≈2.66% yields ~45% false positives (`design.md` §5;
  council/B §3) — which is why the calibrated gate is not rushed pre-tag. The baseline records each
  workload's `cv` so that future gate can be calibrated against real dispersion.
- **No performance number gates the 1.0.0 tag.** The only performance release condition is that the
  baseline artifact exists and reproduces structurally (`design.md` §5; G14 hard rule).
