# Design — v1.0.0-perf-baseline

Implementation-level detail for the two 1.0.0 performance gate items **G13** (land the
perf-correctness fixes first) and **G14** (record a benchmark baseline), grounded in the actual
adapter SQL at `/root/UmbraDB/src/postgres/`. Every claim below is cited to a source file:line or
to a report/council adjudication (`ROADMAP-v1.0.0-CONSOLIDATED.md`, report `03`, `council/B`,
`council/A`). Correctness rule (`openspec/config.yaml`): external claims are verified against the
installed dependency / real upstream source, not assumed.

## 0. Package layout

```
src/
  postgres/
    checkpoint-store.ts                         (modified: save batching §1, history grouped §2)
    migrate.ts                                  (modified: two migrations added to the array)
    migrations/
      005_kv_current_fillfactor.ts              IS-1 (§3) — ALTER TABLE kv_current
      006_ckpt_chunks_size_bytes.ts             IS-2 (§2) — generated column
bench/                                          (new: G14 harness)
  harness.ts                                    driver over the real adapters (§4)
  workloads/                                    per-module workloads (§4)
  baseline.<harness-version>.json               committed baseline artifact (§5)
Performance/
  CEILINGS.md  (or a §ceilings block in README.md)  SC-1..SC-6 documented (§6)
```

Migration numbers `005`/`006` follow the existing `000..004` lineage
(`src/postgres/migrate.ts`'s `tier1WalletMigrations`). Both are **forward-only** — this project's
migrations are append-only (`ROADMAP.md` "forward-only migration"), so IS-1/IS-2 are expressed as
`ALTER TABLE` / `ADD COLUMN`, not edits to `001`/`002`.

## 1. HP-1 — `save()` `UNNEST` batching (G13)

**Current code** (`checkpoint-store.ts:156-162`, `:190-195`): inside one
`this.txLayer.withTransaction`, `save()` runs a per-chunk loop of single-row upserts followed by a
second per-position loop of single-row junction inserts:

```typescript
// checkpoint-store.ts:156-162 — chunk upsert loop (2N round-trips, half 1)
for (let i = 0; i < chunks.length; i++) {
  await sql`INSERT INTO ${sql(this.schema)}.ckpt_chunks (hash, data)
            VALUES (${chunkHashes[i]!}, ${chunks[i]!})
            ON CONFLICT (hash) DO UPDATE SET created_at = now()`;
}
// checkpoint-store.ts:190-195 — junction insert loop (2N round-trips, half 2)
for (let i = 0; i < chunkHashes.length; i++) {
  await sql`INSERT INTO ${sql(this.schema)}.ckpt_manifest_chunks (manifest_id, position, chunk_hash)
            VALUES (${manifest.id}, ${i}, ${chunkHashes[i]!})`;
}
```

**Change** — two multi-row statements (report `03` HP-1's prescribed fix; council/B §1 confirmed
"two per-chunk `for` loops of single-row awaits inside the transaction"):

```sql
-- chunks: one statement, N rows
INSERT INTO <schema>.ckpt_chunks (hash, data)
SELECT h, d FROM unnest($1::bytea[], $2::bytea[]) AS t(h, d)
ON CONFLICT (hash) DO UPDATE SET created_at = now()

-- junction rows: one statement, N rows
INSERT INTO <schema>.ckpt_manifest_chunks (manifest_id, position, chunk_hash)
SELECT $1::bigint, p, h FROM unnest($2::int[], $3::bytea[]) AS t(p, h)
```

`postgres.js` supports array parameters / `unnest`-style bulk insert (`package.json` pins
`postgres ^3.4.9`). `2N` round-trips → `2`.

**Invariants preserved (must not regress — see spec equivalence requirement):** these are the
checkpoint-store dedup/grace-window decision of `design/design.md` §3 ("Checkpoint chunker
(content-addressed, deduplicated)") and the checkpoint join-semilattice / idempotence laws of
`Formal/STORAGE_ALGEBRA.md` §2 ("CheckpointStore — idempotent join-semilattice with a reachability
closure") — a behavior-neutral batching rewrite must preserve both, which is exactly what the
spec's equivalence requirement asserts (cited here per `openspec/config.yaml`'s design rule to
reference existing design/formal sections by number where a change touches them).
- The `ON CONFLICT (hash) DO UPDATE SET created_at = now()` refresh is **load-bearing** for
  prune's grace-window TOCTOU safety (`checkpoint-store.ts:150-155` comment; a plain
  `DO NOTHING` would defeat the grace window; `design/design.md` §3). It is carried verbatim onto
  the batched statement.
- Junction rows remain keyed by `(manifest_id, position)` so a repeated chunk hash at two
  positions stays representable (`002_checkpoint_store.ts` position-column correction). The
  batched `SELECT` preserves position order via the input array index.
- The sequence allocation (`checkpoint-store.ts:167-177`) and the explicit `complete = true`
  manifest insert (`:180-188`) are unchanged and remain between the two batched statements in the
  same transaction, in the same order.

**Why in 1.0.0 despite "no perf number gates":** council/B §4 — the fix "stretches the window
during which the writer transaction (and in production the writer lease) is held, which directly
widens every crash-race window T1/T2 probe. Cheap (`UNNEST` bulk insert), structural: do it in
1.0.0, *before* recording the baseline so the baseline reflects the shipped shape."

## 2. HP-2 + IS-2 — `history()` single `GROUP BY` over a stored `size_bytes` (G13)

**Current code** (`checkpoint-store.ts:314-333`): the page query fetches ≤`limit` manifests, then
a `for … of manifestRows` loop issues one aggregate per manifest
(`checkpoint-store.ts:322-328`), each `JOIN`ing `ckpt_chunks` and calling
`sum(octet_length(c.data))` — detoasting a `bytea` purely to length it.

**Change (HP-2):** collapse to one grouped query (report `03` HP-2):

```sql
SELECT mc.manifest_id,
       count(*)                        AS chunk_count,
       coalesce(sum(c.size_bytes), 0)  AS byte_length
FROM <schema>.ckpt_manifest_chunks mc
JOIN <schema>.ckpt_chunks c ON c.hash = mc.chunk_hash
WHERE mc.manifest_id = ANY($1)
GROUP BY mc.manifest_id
```

1+N queries → 2. The returned rows are re-associated to each manifest by `manifest_id` in JS,
preserving the existing `ORDER BY seq DESC` page order (the page query at
`checkpoint-store.ts:314-321` is unchanged). The existing `coerceToSafeNumber` boundary coercion
(defined at `checkpoint-store.ts:44`, applied to the aggregate at `:332-333`) still applies —
`sum(int) → int8` returns `bigint`.

**Change (IS-2):** add `ckpt_chunks.size_bytes integer GENERATED ALWAYS AS (octet_length(data))
STORED` via migration `006`, so the aggregate sums a stored column and **never touches the TOAST
heap** (report `03` IS-2). The pattern is already proven in-repo:
`chain_archive/001_chain_archive_core.ts:123` —
`size_bytes integer GENERATED ALWAYS AS (octet_length(data)) STORED`. Forward-only: `ADD COLUMN`
with a `GENERATED … STORED` expression backfills existing rows at migration time and is computed
for all future inserts.

Council/B §4: "HP-2 (history N+1) + IS-2 (`size_bytes` generated column) — S-effort, do with
HP-1." Council/A line 55/110 pairs IS-2 with HP-2 identically. (`prune`'s own
`octet_length(c.data)` in the `RETURNING` clause, `checkpoint-store.ts:397-404`, may also switch
to `size_bytes`; optional, called out in tasks, not required for the gate.)

## 3. IS-1 — `kv_current fillfactor=90` (G13)

**Current code** (`001_temporal_kv.ts:73-84`): `CREATE TABLE kv_current (…) ` with **no** storage
parameter → default `fillfactor=100`. Its updates change only non-indexed columns
(`value`/`version`/`updated_at`/`updated_xact`; the only indexed columns are the PK
`ns,scope,key`, unchanged by an update — `001_temporal_kv.ts:73-84`), so they are HOT-eligible
*by column* but miss HOT for lack of same-page slack, spilling to new pages and bloating the PK
index (report `03` IS-1/HP-3).

**Change:** migration `005` — `ALTER TABLE <schema>.kv_current SET (fillfactor = 90)`. Same value
and rationale as `watermarks` (`003_watermarks.ts:27` `WITH (fillfactor = 90)`, the project's
established template — report `03`'s index table calls `watermarks` "the template for IS-1").
`fillfactor` affects **new** pages only (council/B §4: "fillfactor affects new pages only — fine
pre-GA"); an existing packed table reclaims slack as rows turn over / on `VACUUM FULL`. The
migration is forward-only (`ALTER`, not an edit to `001`).

**Verification is empirical, not assumed** (report `03` IS-1 caveat, and mirroring Sprint 4 task
0.2's own correction): measure `pg_stat_user_tables.n_tup_hot_upd` / `n_tup_upd` on `kv_current`
before/after under the soak workload rather than asserting the fix works. Sprint 4's watermarks
HOT-ratio test (`sprint-4-watermarks/tasks.md` 0.2) is the precedent for how this is checked and
for its documented limitation (a short single-connection benchmark cannot isolate `fillfactor`'s
own causal contribution because HOT pruning reclaims a row's prior version efficiently regardless
of insert-time slack) — so the acceptance target here is that the **observed HOT ratio is measured
and recorded** in the baseline under the soak workload (an observation, *not* a numeric floor —
recording a floor would be exactly the perf-number-as-gate shape the G14 hard rule forbids), plus
the structural guard that no index was added on a non-PK column. This is a recorded measurement,
not a differential proof of `fillfactor`'s isolated contribution.

## 4. G14 — benchmark harness

**Structure (report `03` §"Benchmark suite design", council/B §3, council/A §Phase-3):** a custom
in-repo TypeScript suite driving the **real adapter interfaces** (`PgCheckpointStore`,
`PgTemporalKV`, `PgWatermarks`, `PgTransactionHistoryStorage`, the lease layer) — **not** a
generic tool (`pgbench` models TPC-B, not versioned-KV CAS / chunk dedup / reachability-scan GC)
and **not** a foreign consumer app (roadmap G11 boundary; `MEMORY.md` indexer-agnostic rule).

- **Environment: Testcontainers PG17**, pinned image digest, with `shared_buffers` / `work_mem` /
  `max_wal_size` pinned so numbers are comparable run-to-run. The project already depends on
  `@testcontainers/postgresql ^12.0.4` (`package.json`) for property tests — the baseline runs
  against the same real Postgres the code targets.
- **Microbench statistics: `mitata`** (report `03`'s recommendation: JIT/warmup-aware, reports
  histograms + stddev + outliers — what a noise-floor gate needs). Acceptable alternative:
  `tinybench`, lighter, explicit warmup/measurement separation. **Whichever is chosen MUST be
  declared as a direct `devDependency` of UmbraDB.** `tinybench` is present on disk today
  (`node_modules/tinybench`, v2.9.0) **only as a transitive dependency of `vitest`** — importing it
  from `bench/` while relying on that transitive resolution is a phantom-dependency footgun (a
  future `vitest` major could drop or bump it and silently break the harness), so per
  `openspec/config.yaml`'s correctness rule it is added as an explicit `devDependency` rather than
  imported transitively. Either library is fine; the harness entrypoint runs via `tsx`
  (`package.json` devDependency) or vitest. Avoid the unmaintained `benchmark.js`.
- **Workloads (report `03` §"Per-module workloads"), at a declared envelope:**
  - CheckpointStore: `save` at 1/16/64/256 MB (chunk counts 1→64 at 4 MiB) — exercises the §1
    batched path; `save` of a near-duplicate snapshot to measure **dedup ratio**
    (`= 1 − chunks-written/chunks-referenced`, via `ON CONFLICT` hit count); `load` round-trip;
    `history(limit=50)` — exercises §2 (must be ~flat after the fix); `prune`/GC pass duration.
  - TemporalKV: `put` on fresh vs existing key (the trigger/GiST path, HP-3 — *measured, not
    optimized*); `get`; `getAt {version}`/`{at}`. Records `n_tup_hot_upd`/`n_tup_upd` on
    `kv_current` to validate §3 (IS-1).
  - Watermarks: high-frequency `set` on a small key set; HOT-ratio + bloat stability.
  - TransactionHistory: pending→finalized churn; GIN p99 (HP-5 — *measured, not optimized*).
  - Lease/tx layer: acquire/release latency under 1/2/4/8/16 contenders; **pool `max` sized above
    the contender count** so the test measures the lock, not pool-queue latency (report `03` HP-7
    caveat: default `max=10` at `client.ts:49-52`).

## 5. G14 — the GC anti-join measurement + recorded baseline

**GC anti-join (HP-6), the one measurement with correctness-adjacent stakes** (council/B §4 —
"the only perf item that can make a core operation *unusable*"). Current code
(`checkpoint-store.ts:397-404`): a single-statement full-scan anti-join of `ckpt_chunks`:

```sql
DELETE FROM <schema>.ckpt_chunks c
WHERE c.created_at < now() - interval '15 minutes'
  AND NOT EXISTS (SELECT 1 FROM <schema>.ckpt_manifest_chunks mc WHERE mc.chunk_hash = c.hash)
```

Correctly shaped (a btree anti-join on `ckpt_manifest_chunks_by_hash`, not a GIN/`ANY()` scan —
`GC_AND_TRACING_RESEARCH.md`'s decision) but O(live chunks) with a full scan per pass, and
**no published benchmark exists at scale** (report `03` HP-6). The harness measures **GC pass
duration vs live-chunk count** across a **declared scale envelope of 10^5–10^6 chunks** —
deliberately *not* 10^7, which "exceeds the plausible envelope of a *local wallet datastore*"
and would "eat the schedule" (council/B §1). The measured curve decides single-statement vs
batched sweep, under an **operational cliff rule** (so the decision is not an eyeball call): the
curve *cliffs* at an envelope point when GC pass duration between it and the previous measured
point grows by more than a declared factor `K` times the live-chunk-count growth between them
(super-linear), or when a single pass exceeds a declared absolute duration bound `D`. `K`, `D`, and
the resulting determination (met / not met, first-met live-chunk count if any) are recorded as an
explicit adjudication in the baseline artifact and echoed in task 2.4's close-out note:
- If the curve does **not** meet the cliff condition across the envelope → **document the ceiling**
  (SC-2), keep the single-statement delete.
- If the curve **meets the cliff condition inside the envelope** → batching the GC sweep
  (pg-boss-style ≤100-row chunked deletes) becomes an **in-scope 1.0.0 fix** (council/B §4: "If the
  curve cliffs inside the envelope, batching becomes a 1.0.0 fix; otherwise document").

**Recorded baseline (the actual G14 gate):** the harness emits a **committed baseline artifact**
— JSON keyed by a harness version — capturing, per workload, the measured latency/throughput
statistics (p50/p95/p99, CV) and the GC curve (with `K`/`D` and the cliff determination), together
with the pinned environment (image digest, PG settings, harness version). **The gate is existence,
not a number:** council/B §3 — "Baseline = committed JSON + the harness that reproduces it"; G14
hard rule — "no perf NUMBER gates the release; only the existence of a recorded baseline does."
Reproduction is **structural**, not numeric: re-running the harness at the recorded harness version
against the same pinned image digest + server settings must complete and emit an artifact
conforming to the same schema (same workload set, same declared envelope, same statistic fields) —
no latency/throughput number is compared. The **CV-aware, calibrated regression gate is deferred
post-1.0.0** (council/B §3: "the regression gate is the *first post-1.0.0* obligation"; the CV math
— a benchmark at CV≈2.66% gives ~45% false positives against a naive 2% gate — is why a calibrated
gate is not rushed pre-tag). Per the roadmap's "Coarse gate now" ruling (G14; council/A §Phase-3),
a **coarse, order-of-magnitude smoke guard IS wired now** as a CI check, explicitly
**non-release-gating** — it flags gross regressions but never fails the build on a calibrated
number, and it is documented as *not* a perf-number release blocker.

## 6. G14 — documented scalability ceilings (SC-1..SC-6)

Report `03` §"Scalability ceilings" and council/B §4 ("document the ceiling now, per 03's
SC-1..6, which I endorse") — a `Performance/CEILINGS.md` (or README block) states each limit as a
1.0.0 contract, so operators discover them in docs, not production:

- **SC-1** — `kv_history` unbounded growth (one row + GiST-EXCLUDE + 2 btrees per superseded
  version, no retention — `temporal-kv.ts:224-230`). "History is retained forever in 1.0.0; plan
  retention before high-churn production." (Partitioning = IS-3, deferred.)
- **SC-2** — `ckpt_chunks` growth + GC cost O(live chunks), full scan per pass. Publish the
  measured GC curve (§5) and the batching threshold if one is found.
- **SC-3** — `load()` single-buffer materialization (`checkpoint-store.ts:280` `Buffer.concat`s
  the whole checkpoint into Node heap). Document a max supported single-checkpoint size;
  streaming reconstruction is post-1.0.0.
- **SC-4** — single global writer lease (`transaction-lease.ts:287`) serializes writers by design;
  state the measured single-writer write throughput as the stated ceiling. Pool `max=10`
  (`client.ts:49-52`) bounds concurrent readers + lease contenders.
- **SC-5** — TransactionHistory GIN `fastupdate` pending-list flushes spike p99 under sustained
  writes. Document expected p99 and the `fastupdate` knob (IS-4, deferred).
- **SC-6** — TOAST on `ckpt_chunks.data`: `EXTENDED` (default, compresses first) vs `EXTERNAL`.
  Document the tradeoff; the storage-mode *choice* is deferred (measure-or-document, not changed).

## 7. Boundaries and non-goals respected

- **Indexer-agnostic boundary** (roadmap G11; `MEMORY.md`): the harness drives UmbraDB's own
  adapters only; no consumer/indexer app is imported to generate load.
- **`save()` idempotency stays out** (roadmap Deferred; council/B §5.3): §1's batching narrows the
  crash window but does **not** make `save` retry-safe; no `idempotency_key`/UNIQUE is added here.
  That is P1 "with Sprint 9."
- **No perf number gates the release** (§5; council/B §3; G14): existence of the baseline is the
  only performance release condition.
- **Dedup-oracle / at-rest-encryption / keyed chunking are not touched** — those are documentation
  items for 1.0.0 owned by the InfoSec change (roadmap G15/G16; keyed chunking is 1.1). This
  change only *measures* the dedup ratio; it does not change chunk addressing.
- **HP-3/HP-5/IS-3/IS-4/SC-3/SC-6 are measured/documented, not optimized** (§4/§6; council/B §4).
- **Forward-only migrations** (`ROADMAP.md`): IS-1/IS-2 are `ALTER`/`ADD COLUMN` migrations
  `005`/`006`, not edits to `001`/`002`.
- **Coordinate with G5** (co-transactional `save`, a separate change): G5 owns `save()`'s
  *signature*; §1's batching is internal-only and composes with it. Whichever lands first, the
  other rebases onto the same method body; the baseline (§5) is recorded only after *both* the
  batching (§1) and the shipped `save` shape are final.

## Audit resolution

Two audits were applied: **Fable** (verdict REVISE — 5 blocking, 6 non-blocking) and **Opus**
(verdict APPROVE — 0 blocking, several concrete non-blocking). **All 5 Fable blocking findings were
resolved; 0 were rejected.** Non-blocking findings from both auditors were applied where they
clearly improve the change.

**Blocking findings resolved (Fable):**
1. *Coarse-gate demoted from "now" to optional* → the roadmap G14 "Coarse gate now" ruling is
   restored: the coarse, order-of-magnitude smoke guard is now **wired now** as a CI check
   (spec Requirement "a coarse smoke guard is wired now; the CV-aware regression gate is deferred"
   + its new "coarse guard present in CI" scenario; task 3.4 rewritten from "if any check ships" to
   "wire the coarse guard now"; AC B11; proposal Non-goals; design §5), while the *calibrated*
   CV-aware gate stays deferred and the guard stays explicitly non-release-gating.
2. *Equivalence requirement misused `WHERE` and bound a review process* → rewritten as an
   `IF … THEN` over observable behavior (a different set of `ckpt_chunks` rows / junction tuples /
   `manifest_hash` than the pre-change path ⇒ non-conforming), with the checkpoint join-semilattice
   laws cited (`Formal/STORAGE_ALGEBRA.md` §2; `design/design.md` §3).
3. *Undefined "cliff" predicate gated an in-scope code fix* → the HP-6 requirement now defines a
   *cliff* operationally (declared factor `K` on pass-duration-vs-chunk-count growth, or an absolute
   bound `D`), records `K`/`D` and the determination as an explicit adjudication in the baseline,
   and the single cliff scenario was **split** into distinct cliff / no-cliff scenarios (Fable E3).
   Tasks 2.3/2.4 and ACs B7/B8 updated to match.
4. *"Reproduces a comparable run" unmeasurable* → replaced everywhere with **structural
   reproduction** (same harness version + pinned digest + settings ⇒ completes and emits a
   schema-conforming artifact; no numeric comparison): spec baseline scenario, AC B4, task 3.1,
   design §5.
5. *design §3 "HOT-ratio floor under the soak" contradicted the record-only stance* → design §3 now
   states the observed HOT ratio is **measured and recorded** (an observation, not a numeric floor),
   matching the spec scenario / task 3.2 / AC B9.

**EARS/style fixes (Fable E4, E5):** the "baseline reflects batched shape" requirement was rephrased
from a git-ordering `SHALL already be merged` to an observable "the measured `save`/`history` code
paths SHALL be the batched shapes"; two over-promising scenario titles were retitled to match their
number-free bodies ("… stay predominantly HOT" → "… HOT ratio is measured and recorded"; "harness
is reproducible run-to-run" → "each run reports warmup-aware statistics including CV").

**Non-blocking findings applied (both auditors):**
- *tinybench is a transitive (phantom) dependency* (Fable NB3 + Opus's concrete pre-build finding) →
  the chosen microbench library (`mitata` or `tinybench`) must be a **direct `devDependency`**;
  updated in the spec harness requirement, design §4, proposal Impact, and task 2.1's acceptance.
- *config.yaml-mandated §-numbered citations* (Fable NB4) → design §1 and the spec equivalence
  requirement now cite `design/design.md` §3 and `Formal/STORAGE_ALGEBRA.md` §2 by number.
- *A8 over-asserted a TOAST-heap plan property* (Fable NB2) → demoted to rationale; the assertion is
  now query-text-references-`size_bytes` only (spec scenario + AC A8).
- *Citation nits* (Fable NB5) → `coerceToSafeNumber` cited at its definition `checkpoint-store.ts:44`
  (usage `:332-333`). Fable's separate `watermarks`-fillfactor "±1" nit (`:27` → `:28`) was
  **checked against live source and not applied**: the `WITH (fillfactor = 90)` DDL is on line 27
  (Opus confirmed `:27` exact); the citation stays `003_watermarks.ts:27`.
- *Migration-array ordering* (Opus) → task 1.5 and proposal Impact now require the final
  `tier1WalletMigrations` order be `[…004, 005, 006]` regardless of build order.
- *Query-spy feasibility caveat* (Opus) → ACs A1/A5 and tasks 1.1/1.4 inherit Sprint 4 task 1.1's
  "record-which-guarantee-is-verified" fallback (emitted-SQL via postgres.js `debug`) when a spy is
  impractical.
- *Optional `prune` `size_bytes` switch "called out in tasks"* (Opus) → task 1.4 now carries the
  optional bullet, so the design §2 claim is no longer dangling.
- *Task 4.3 graphify waiver* (Fable NB6) → the explicit skip/waiver clause is retained prominently.

**Rejected findings:** none. Two items were noted by Opus as *acceptable-as-is* rather than defects
(the HP-6 requirement being mildly compound — measurement + conditional remediation — which is
faithful to council/B §4's own conditional framing; and the equivalence requirement's earlier
`WHERE`, which Fable independently escalated to blocking and is now fixed). Neither required a
rejection rationale because neither was retained against an auditor's objection.
