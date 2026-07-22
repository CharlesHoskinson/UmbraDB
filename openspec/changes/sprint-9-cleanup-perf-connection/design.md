# Design — Sprint 9: Client cleanup, performance seeding, connection hardening

Grounded in the completed Milestone 4 research pass (`Performance/DESIGN.md`,
`Performance/GC_AND_TRACING_RESEARCH.md`), the accumulated audit findings (`AUTONOMOUS_RUN_LOG.md`),
the Sprint 7/8 modules, and `src/postgres/client.ts`. Per `openspec/config.yaml`'s design rule,
every decision that touches an existing one cites `design/design.md`, `design/design-interfaces.md`,
or `Formal/STORAGE_ALGEBRA.md` by section number rather than silently duplicating or contradicting
it.

This sprint consolidates deferred work into three capabilities: `storage-client-hygiene`,
`performance-observability`, `connection-robustness`. The three are independent enough to implement
in parallel but share one release gate (the verify gate, `AUTONOMOUS_RUN_LOG.md:104-108`).

---

## 1. Client cleanup / tech debt (`storage-client-hygiene`)

### 1.1 Sprint 7 merge-read paths need *direct* regression tests

Sprint 7's row-lock atomic merge (`src/postgres/transaction-history-storage.ts` `writeRows`,
lines 452-513) and defensive decode (`decodeRow`/`assertStoredEntryShape`/`parseStoredBigint`/
`parseStoredDate`/`rowToEntry`, lines 137-273) are covered mostly *transitively* — via the property
suite and the F1 read-path-corruption fixtures. Codex's two LOW findings
(`AUTONOMOUS_RUN_LOG.md:287-289`) named the gap precisely:

- The **empty-set vacuous-subset guard** — `writeRows`'s pending-clear only fires when
  `result.identifiers.length > 0` and `array_length(identifiers, 1) > 0` (lines 498-507), because an
  empty set is vacuously a subset of anything and would otherwise clear *every* unrelated pending
  entry on any zero-identifier finalize. There is no test that fails if that guard is removed.
- The **concurrent-first-write advisory lock** — `writeRows`'s `pg_advisory_xact_lock` (line 455)
  exists because a bare `SELECT ... FOR UPDATE` cannot lock a not-yet-existent row, so two racing
  first-ever writes to the same `(walletId, hash)` both compute a merge from `undefined` and lose a
  section (design.md §3 in `sprint-7-.../design.md`). The existing concurrent property test does not
  *force* the losing interleaving, so it can pass even with the lock removed.

**Decision:** add **mutation-style** direct tests — each asserts the failure mode returns *with the
guard in place* and is designed so that removing the guard/lock makes the test fail. For the lock,
force the interleaving deterministically (two writers, a barrier between the first writer's `SELECT`
and its `INSERT`) rather than relying on the scheduler. These are single-writer/two-writer
Pg-backed tests against a real Testcontainers Postgres (`design/design.md` §8's chosen fidelity
posture), never the in-memory reference (which cannot exhibit the race, `sprint-7-.../spec.md`'s own
equivalence caveat).

### 1.2 Sprint 8 L-findings folded into implementation

Sprint 8 (`~/repos/umbradb-sprint8`) is planned/implemented but its non-blocking (L) findings were
never folded back. This sprint owns them (its non-goal §"Any change to PgTransactionHistoryStorage's
own contract" kept them out of Sprint 8 itself, `sprint-8-.../proposal.md:118-121`):

- **status-enum mapping coverage.** The adapter maps the SDK's lifecycle *discriminated union*
  (`submittedAt` / `finalizedBlock{hash,height,timestamp}` / `rejectedAt`+`reason`) onto UmbraDB's
  bare `{status}` union (`src/interfaces/transaction-history-storage.ts:166-178`;
  `sprint-8-.../specs/wallet-state-envelope/spec.md` "adapter round-trips SDK lifecycle detail").
  **Decision:** a direct table-driven test asserts each of the three statuses round-trips through the
  adapter to a schema-valid SDK lifecycle, **and** that an unrecognized/unmapped status string is
  rejected with a typed error rather than silently coerced to a default — the same
  reject-don't-normalize posture Sprint 7's canonical decode already took
  (`CANONICAL_BIGINT_RE`, `transaction-history-storage.ts:79`).
- **`effect` / `@midnightntwrk/wallet-sdk-abstractions` pin manifest.** The adapter is test-tier and
  imports the Effect-Schema runtime (`effect`) and the SDK abstractions package from a **built
  on-disk `midnight-wallet` checkout**, not from `package.json` (verified: `package.json` declares
  only `postgres`/`zod` + test tooling — no `effect`, no `@midnightntwrk/*`). That implicit,
  un-versioned dependency makes the integration tier non-reproducible. **Decision:** record it in a
  versioned **pin manifest** (`test/integration/PINNED_DEPENDENCIES.md`) — the exact package names,
  the resolved versions actually used in the proven run (SDK build, `effect`, ledger-v8 bindings),
  and the checkout/build steps — mirroring how `design/environment/` already pins the preprod
  endpoint/seed facts. This is documentation-tier, not a `package.json` change (importing the SDK
  into the dependency graph of a `private` package that must stay SDK-free is itself a non-goal).
- **multi-sub-wallet envelope coverage.** Sprint 8's live/cold-boot tiers exercised only the
  unshielded sub-wallet (`AUTONOMOUS_RUN_LOG.md:236-243`), yet the envelope spec requires all three
  strings to round-trip and an absent slot to be skipped
  (`sprint-8-.../specs/wallet-state-envelope/spec.md` "wraps the three sub-wallet strings", "a
  sub-wallet absent … is skipped"). **Decision:** add Pg-only conformance for the **2-of-3 and
  3-of-3** cases — build envelopes with arbitrary opaque strings in shielded+unshielded+dust,
  `save`/`load` through `PgWalletStateEnvelopeStore`, assert byte-for-byte round-trip and correct
  skip of absent slots. No SDK sync needed (the strings are opaque, `sprint-8-.../spec.md`), so this
  belongs to the **required** Pg-only gate, not the nightly live tier.

### 1.3 Working-tree hygiene for stray research artifacts

`design/research/2026-07-21-snapshot-root-of-trust/` is the verifiable-snapshot deep-research set. It
is committed on `feature/verifiable-snapshot`, but present as **untracked** files in the `main`
worktree (`~/repos/UmbraDB`) and partially untracked in `~/repos/umbradb-snapshot-design` (verified
`git status --ignored`). Untracked cross-feature drafts in `main` are exactly the leak that later gets
half-committed by an unrelated `git add -A`. **Decision:** (a) relocate — those artifacts live only on
their feature branch; remove the untracked copy from any non-feature worktree; (b) add a guard — a
`.gitignore` entry scoping `design/research/**` off branches that don't own it is too blunt (the
feature branch *does* track them), so instead add a lightweight **working-tree-hygiene check** to the
verify gate that fails if `git status --porcelain` reports untracked files under `design/research/` on
a branch whose name is not `feature/verifiable-snapshot`. That is a check, not a policy embedded in
`.gitignore`, so it cannot silently hide a genuinely new tracked artifact on the owning branch.

### 1.4 `src/` debt survey (reported honestly)

A `TODO`/`FIXME`/`XXX`/`HACK` grep over `src/` returns **nothing** — the numerous "future" / "belt-
and-suspenders" comments are legitimate defense-in-depth (e.g. `transaction-history-storage.ts:97-104`
documents an intentionally-unreachable branch). The real, citeable consolidation targets the survey
*did* find:

- `src/postgres/transaction-history-storage.ts:12` imports `hasPostgresUnsafeText` **from an
  interface module** (`../interfaces/temporal-kv.js`) — a cross-module runtime coupling between two
  adapters via a helper that lives on TemporalKV's interface. Relocate the shared key-safety helper to
  a neutral shared location (e.g. `src/interfaces/storage-errors.ts`'s neighborhood, or a small
  `src/interfaces/json-safety.ts`) so neither adapter depends on the other's interface module.
- The recursive key-safety check and its depth bound (Sprint 7 fix pass 2,
  `AUTONOMOUS_RUN_LOG.md:338-339`) and TemporalKV's own key check are conceptually the same guard
  implemented in two places; consolidate to one, with one depth-bound constant.

**Decision:** these are behavior-preserving refactors guarded by the existing suites plus a pinned
regression test; no contract changes (non-goal). Kept deliberately small — the survey's headline
finding is that `src/` is *not* carrying marker debt, and the honest report of that is itself the
deliverable, not an invented cleanup.

---

## 2. Performance — Milestone 4 seeding (`performance-observability`)

The ROADMAP requires a research pass before any tooling is locked in (`ROADMAP.md:132`). **That pass
is complete** — `Performance/DESIGN.md` is the design a harness/profiling/logging layer should be
built against, grounded in two research rounds and citing what it *refuted* (GIN gives zero benefit
for the GC membership scan, §3; no `postgres.js` timing hook exists, §2). Sprint 9 builds against it;
it does not re-open the tooling choice, but it carries the design's own honest caveats forward (§2.4).

### 2.1 Benchmark harness as an in-repo, versioned regression gate

`Performance/DESIGN.md` §4 establishes that **no generic tool transfers** (`pgbench` models TPC-B,
not versioned-KV/chunk-dedup/reachability-scan GC; no content-addressed store's suite transfers). The
only viable structure is a **custom Node/TypeScript harness that drives UmbraDB's own interfaces
directly and lives in-repo as a regression gate** — a versioned artifact whose numbers are compared
against a recorded baseline, satisfying `ROADMAP.md:155`'s "no regression against the recorded
baseline" 1.0.0 item.

**Decision:** `Performance/bench/` — a harness that (a) runs each workload against a real
Testcontainers Postgres (`design/design.md` §8), (b) emits a structured result artifact
(JSON: metric, value, unit, git SHA, timestamp, Postgres version), (c) compares against a committed
baseline and **fails when a metric regresses beyond a documented threshold**. The threshold is
relative with an explicit noise floor, because the Docker/Testcontainers environment is not a
bare-metal bench (open question §6.3). `bench:baseline` records/blesses a new baseline; `bench` gates.

### 2.2 Metrics — UmbraDB's real workloads, including Sprint 7/8

Coverage extends `Performance/DESIGN.md` §4's minimum with the Sprint 7/8 workloads the task calls
out:

- **Versioned-KV** put/get/getAt throughput + latency at increasing `kv_history` sizes — where the
  `tstzrange` + `GiST EXCLUDE` write overhead becomes visible (`design/design.md` §2;
  `Performance/DESIGN.md` §4).
- **CheckpointStore** save/load latency and **measured dedup ratio** (chunks reused vs. newly
  written) at realistic checkpoint sizes (`design/design.md` §3).
- **GC pass duration** as `ckpt_chunks`/`ckpt_manifest_chunks` grow — the empirical answer to
  `Performance/DESIGN.md` §3's explicitly-open question (no published benchmark exists for the
  anti-join reachability scan at scale; the harness *is* the deliverable that closes it).
- **Lease contention** — acquire/release latency under concurrent writers, observed via
  `pg_stat_activity` (`wait_event_type='Lock'`, `wait_event='advisory'`, `Performance/DESIGN.md` §1).
- **tx-history write/merge under concurrent writers** (Sprint 7's row-lock path) — throughput and
  tail latency as `pg_advisory_xact_lock` serializes writers on a hot `(walletId, hash)`
  (`transaction-history-storage.ts:452-513`). New in this sprint's coverage.
- **Envelope save/load** (Sprint 8) — which is a `CheckpointStore.save`/`load` of the bundled blob
  (`sprint-8-.../spec.md`); measured end-to-end so the recovery-path cost has a baseline.

### 2.3 Structured DB-activity logging + call→SQL→plan correlation

Per `Performance/DESIGN.md` §2/§5: neither `postgres.js`'s native `debug` hook (fires at query-build
time with SQL text/params/types but **structurally cannot report duration**) nor `tracingChannel`
alone suffices. **Decision:** one wrapper module (`src/postgres/tracing.ts`) wraps `debug`'s per-query
payload in a `tracingChannel` span so SQL text/params come from the driver's own hook and
duration+correlation come from the span, guarded by `hasSubscribers` so it costs nothing when no
listener is attached. Spans feed `pino` with its worker-thread `transport` so formatting never blocks
the event loop (`Performance/DESIGN.md` §5). Logging hooks the existing `signal?: AbortSignal` /
`StorageError` conventions so cancel/throw paths emit automatically (§5). Postgres-side profiling is
config, not code: `auto_explain` with `log_nested_statements=on` (to catch the `kv_history`
`BEFORE UPDATE/DELETE` trigger's internal queries, `Performance/DESIGN.md` §1), `pg_stat_statements`
with `track='all'`, and `pg_stat_activity` for lease contention — all documented as a profiling
runbook, not a standing production default (`log_analyze` is never enabled by default, §1).

**Correlation requirement (the load-bearing one):** an application-level call
(`CheckpointStore.save`, `TemporalKV.getAt`, …) must be traceable to the exact SQL it issued, that
SQL's `EXPLAIN` plan, and its duration — so "this call was slow" becomes "this is why" without
guessing (`ROADMAP.md:138`; `Performance/README.md`).

### 2.4 Honest tooling caveats (carried from the research, not papered over)

- `tracingChannel` is **Experimental (Stability 1)** and has been for years — isolated behind the one
  `src/postgres/tracing.ts` module so an API change lands in one place (`Performance/DESIGN.md` §2).
- No OTel `postgres.js` instrumentation exists (`@opentelemetry/instrumentation-pg` targets
  `node-postgres`) — the wrapper keeps instrumentation portable to the `pg` fallback
  (`design/design.md` §7) either way (§2).
- The GC anti-join at multi-GB / many-million-row scale has **no published benchmark anywhere** — the
  harness closing it empirically is this project's own contribution, not a literature lookup (§3).

---

## 3. Connection robustness — DB layer (`connection-robustness`, part a)

`src/postgres/client.ts` today exposes `connectionString`/`schema`/`maxConnections`/`connectTimeout`
(lines 44-65). Audit finding F2 (`client.ts:58-63`) already reverted the `connectTimeout` default so
omitting an option means *postgres.js's* default, not a silently different one — **this sprint keeps
that invariant**: every addition is opt-in and, when omitted, changes nothing.

- **Pooling config generalized.** Expose `idleTimeout` / `maxLifetime` (postgres.js `idle_timeout` /
  `max_lifetime`) alongside `maxConnections`, each with the same "omit ⇒ don't pass the key" discipline
  the `max` fix already documents (the `k in o` presence-check footgun, `client.ts:49-51`,
  `design/design.md` §3). Never pass `undefined` through positionally (the existing branch at
  `client.ts:135-137` is the pattern).
- **Retry/backoff on transient failures.** Today there is none — `translatePostgresError`
  (`errors.ts`) classifies a failure as `ConnectionError` but nothing retries. Add bounded exponential
  backoff with jitter for **transient** classes only (connection refused/reset/timeout), distinguished
  from **permanent** ones (auth, invalid schema, constraint violation) which fail fast. **Critical
  boundary (see §6.1):** auto-retry applies to reads and to writes that are provably idempotent and
  **not** inside a caller-supplied `opts.tx`; it never re-drives an operation inside a caller
  transaction (that breaks atomicity) and never retries a lease acquire
  (`src/postgres/transaction-lease.ts`, non-idempotent by design).
- **`connectTimeout` generalized into a health policy.** Fold the single connect-timeout knob into an
  explicit, opt-in connection-health policy: `connect_timeout` plus optional `statement_timeout` /
  `idle_in_transaction_session_timeout`, all defaulting to postgres.js defaults (F2 discipline).
- **Liveness/health check.** Add `checkLiveness()` — a bounded `SELECT 1` translating failure to
  `ConnectionError` via the existing `translatePostgresError` path, so a caller/orchestrator can
  probe readiness without issuing a real query.

## 4. Connection robustness — wallet-sync layer (part b), and the C1 tie

This run surfaced a real defect: the wallet SDK judges "synced" against a **single indexer's
self-reported tip with no finality reconciliation** — filed upstream as **`midnight-wallet#584`**. A
single indexer can be behind, forked, or lying, and the SDK trusts its self-reported best block. A
UmbraDB checkpoint saved against an unverified tip persists a snapshot with no independent basis for
"as of block N."

UmbraDB cannot fix the SDK's internal judgment (non-goal), but its **sync-integration/adapter tier**
(Sprint 8's seam, `sprint-8-.../design.md` §3 — test/integration tier, never a `src/` runtime import)
must defend before it trusts "synced" enough to persist a checkpoint:

- **Multi-endpoint cross-check.** Query ≥2 independently-operated indexer endpoints for the tip
  `(blockHash, height)` and require agreement before treating the wallet as synced — the Tier-0 k-of-n
  cross-check of `design/verifiable-snapshot-design.md:108` ("query ≥2–3 independently operated
  endpoints … and require exact agreement"). Closes "one indexer lies alone."
- **Finality-verified-tip check.** Where a finalized-head source is available (Substrate GRANDPA
  `chain_getFinalizedHead`, `verifiable-snapshot-design.md:275`), verify the tip the wallet synced to
  is at/below a finalized head, rather than trusting a self-reported *best* block — don't persist a
  checkpoint anchored above finality. (Its applicability to the unshielded cursor model is §6.2.)
- **Reconnection/failover.** On an endpoint dropping, timing out, or disagreeing, fail over to another
  configured endpoint with bounded backoff (the same backoff discipline as §3), and **refuse to mark
  synced / persist** while endpoints disagree — surface a typed error, never silently accept one
  unverified tip.

**Tie to `verifiable-snapshot-recovery` C1.** C1 is "offline recompute = on-chain root"
(`design/verifiable-snapshot-design.md:321`) — the correctness guarantee that a restored snapshot's
offline-recomputed state root equals the on-chain root. That feature's own ship-now Increment-0 pairs
the offline root-compare with a **k≥2-indexer cross-check** of that root
(`verifiable-snapshot-design.md:90,108`; `AUTONOMOUS_RUN_LOG.md:360`). Sprint 9's multi-endpoint
cross-check is **the same availability/freshness layer, arriving first**: it is the operational
precursor C1's correctness envelope later sits on top of. Building it now, in the adapter tier, means
`verifiable-snapshot-recovery` inherits a defended sync integration rather than having to add one.

---

## 5. Flagged decision (not silently made): the GC junction-table migration

`Performance/DESIGN.md` §3 recommends replacing `ckpt_manifests.chunk_hashes bytea[]` + its GIN index
with a normalized `ckpt_manifest_chunks(manifest_id, chunk_hash)` junction table, because GIN's
`array_ops` never accelerates the scalar `hash = ANY(...)` membership test GC's reachability check
needs (a real benchmark found zero benefit). This is a **schema change to Sprint 3's already-audited
CheckpointStore** (`design/design.md` §3). The performance-observability capability's job is to
*measure* GC pass duration (§2.2) and thereby produce the evidence for this decision — **not** to make
the migration silently under the banner of "perf work." Whether the migration lands in Sprint 9
(behind the benchmark evidence, with its own migration + audit) or is deferred to a dedicated change
is an explicit correctness-gate question (§6.4). Stated here so it is a decision, not an omission.

---

## 6. Open questions carried into this sprint (for the correctness-audit gate)

1. **Retry/idempotency boundary (biggest).** Exactly which operations may auto-retry on a transient
   failure without reintroducing a correctness hazard? Reads are safe. Watermarks `set` is an
   idempotent LWW upsert (`sprint-4-.../spec.md` Law W1) — safe. tx-history merge is idempotent by
   construction (row-lock + re-merge) — safe *outside* a caller tx. But a **lease acquire is not
   idempotent** (`transaction-lease.ts`), a retry inside a caller `opts.tx` breaks atomicity, and a
   retry of a checkpoint `prune`/GC mid-pass could double-act. The gate must confirm the exact
   allow-list and that the implementation refuses to retry everything else — getting this wrong
   silently reintroduces the concurrency hazards Sprints 2/7 closed. This is the sprint's top risk.

2. **Finality reconciliation vs. the proven unshielded sync model (second biggest).** The *proven*
   preprod sync uses the unshielded wallet's **per-address transaction-id cursor, not a block scan**,
   and the run log's own CORRECTION records there is **no block-height "birthday" for it**
   (`AUTONOMOUS_RUN_LOG.md:245-252`). So "verify the tip against a finalized head" may not map cleanly:
   the indexer's chain tip and the wallet's per-address "synced" are different notions. The gate must
   decide whether the right unshielded-model defense is a finality-verified *tip* check at all, or a
   **multi-endpoint cross-check of the per-address tx set** (does endpoint B report the same txs for
   the address as endpoint A?), and how each reconciles with C1's finalized-block anchor. Choosing the
   wrong defense yields a check that is either vacuous or inapplicable to the one path we can actually
   run.

3. **Benchmark regression threshold + noise floor.** What counts as a "regression" on a
   Docker/Testcontainers host that is not bare metal — absolute, relative, or relative-with-noise-floor;
   how many warm-up/measured iterations; median vs p95? The gate must set this so the regression gate
   is neither flaky-red nor blind to real regressions (§2.1).

4. **GC junction-table migration in-scope?** Does §5's migration land in Sprint 9 (behind the harness
   evidence) or defer to its own audited change? Touches an audited module's schema; the gate decides.

---

## 7. Post-implementation testing strategy (EARS requirement → test)

Every requirement in the three `specs/*/spec.md` files maps to at least one test; the Fable
aggregator cross-checks this (`AUTONOMOUS_RUN_LOG.md:106-107`). Full mapping in `tasks.md`; summary:

- **`storage-client-hygiene`** — *cleanup regression tests*: mutation-style direct tests for the
  empty-set vacuous-subset guard and the concurrent-first-write lock (§1.1, forced interleaving);
  table-driven status-enum round-trip + unmapped-status-rejection tests (§1.2); a
  manifest-presence/parse test asserting the pin manifest lists the exact packages+versions (§1.2); a
  2-of-3 / 3-of-3 envelope round-trip + absent-slot-skip conformance test (§1.2); a working-tree-
  hygiene check that fails on untracked `design/research/**` off the owning branch (§1.3); a pinned
  behavior-regression test guarding the §1.4 refactors.
- **`performance-observability`** — *benchmarks-as-regression-gate*: the harness itself is the test —
  each workload metric (§2.2) has a baseline and a gate assertion; a self-test that a deliberately
  injected regression makes the gate fail (proving it is not vacuous); a correlation test asserting an
  app-level call emits a span carrying its SQL text + duration + retrievable plan; a `hasSubscribers`
  test asserting zero overhead when no listener is attached.
- **`connection-robustness`** — *connection-failure/retry tests*: transient-vs-permanent
  classification (a transient error retries within the bound and eventually succeeds/gives up; a
  permanent one fails fast, no retry); a **negative** test that a retry is NOT attempted inside a
  caller `opts.tx` and NOT for a lease acquire (§6.1); `checkLiveness()` against a live and a dead
  endpoint; pooling-option pass-through (omit ⇒ postgres.js default, F2 discipline); and, in the
  integration tier, a multi-endpoint cross-check test (agreeing endpoints ⇒ synced; disagreeing ⇒
  typed error, no checkpoint persisted) and a failover test (endpoint drop ⇒ fail over with backoff).
