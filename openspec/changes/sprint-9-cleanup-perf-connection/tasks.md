# Tasks — Sprint 9: Client cleanup, performance seeding, connection hardening

This file is the sprint's only checkbox/status authority. Every phase closes only after its
specified persona review passes or all findings are fixed and re-reviewed (`AGENTS.md`). All boxes
below are unchecked: this draft has not yet been through Phase 0. Each task states concrete
acceptance criteria (a passing test or a succeeding command), per `openspec/config.yaml`'s tasks
rule.

## 0. Specification freeze (the gate that unblocks Sprint 8's merge)

- [ ] 0.1 This proposal/design/tasks/spec authored, grounded in `Performance/DESIGN.md`,
  `AUTONOMOUS_RUN_LOG.md`, the Sprint 7/8 modules, and `src/postgres/client.ts`.
  - **Acceptance:** `test -f` succeeds for `openspec/changes/sprint-9-cleanup-perf-connection/`
    `{proposal.md,design.md,tasks.md,specs/storage-client-hygiene/spec.md,`
    `specs/performance-observability/spec.md,specs/connection-robustness/spec.md}`.
- [ ] 0.2 Strict-validate this change and the full corpus.
  - **Acceptance:** `npx openspec validate sprint-9-cleanup-perf-connection --strict` and
    `npx openspec validate --all --strict` both exit 0.
- [ ] 0.3 Deep-research + design-council pass (`AUTONOMOUS_RUN_LOG.md:32-56`) resolves §6's four
    open questions — especially §6.1 (retry/idempotency allow-list) and §6.2 (finality vs. the
    unshielded cursor model) — with the **correctness-audit spec gate** returning an explicit
    CONFIRM. **This CONFIRM is the event that satisfies the "N+1 planned" precondition and lets
    Sprint 8 merge to `main`** (`AUTONOMOUS_RUN_LOG.md:16-25`).
  - **Acceptance:** the correctness auditor's verdict is recorded as CONFIRM in the run log with each
    §6 question resolved to a decision; no open BLOCK.
- [ ] 0.4 Regenerate Graphify for the frozen spec.
  - **Acceptance:** `graphify update .` exits 0 and the new change's nodes appear in `graphify-out/`.

## 1. Client cleanup / tech debt (`storage-client-hygiene`)

- [ ] 1.1 Direct mutation-style test for the empty-set vacuous-subset guard
    (`transaction-history-storage.ts:498-507`).
  - **Acceptance:** a Pg-backed test that PASSES with the guard in place and FAILS if the
    `identifiers.length > 0` / `array_length(...) > 0` guard is removed (verified by temporarily
    removing it during review); asserts an unrelated pending entry is NOT cleared by a zero-identifier
    finalize.
- [ ] 1.2 Direct forced-interleaving test for the concurrent-first-write advisory lock
    (`transaction-history-storage.ts:455`).
  - **Acceptance:** two writers race a first-ever write to the same `(walletId, hash)` with a
    deterministic barrier forcing the losing interleaving; the test asserts both sections survive WITH
    the lock and can be shown to FAIL with the `pg_advisory_xact_lock` removed. Never uses the
    in-memory reference (`sprint-7-.../spec.md` equivalence caveat).
- [ ] 1.3 status-enum mapping coverage for the Sprint 8 adapter.
  - **Acceptance:** a table-driven test asserts each SDK lifecycle status (`pending`/`finalized`/
    `rejected`) round-trips adapter→Pg→adapter to a schema-valid SDK lifecycle, AND an
    unrecognized/unmapped status string rejects with a typed error (no silent default coercion).
- [ ] 1.4 Test-tier dependency pin manifest.
  - **Acceptance:** `test/integration/PINNED_DEPENDENCIES.md` exists and lists exact package names +
    resolved versions for the adapter's implicit deps (`effect`, `@midnightntwrk/wallet-sdk-abstractions`,
    the SDK build + ledger-v8 bindings) with checkout/build steps; a test asserts the file is present
    and parses to a non-empty version table. Does NOT add these to `package.json` (SDK-free-`src` non-goal).
- [ ] 1.5 Multi-sub-wallet envelope Pg-only conformance (2-of-3, 3-of-3).
  - **Acceptance:** a required-gate Pg-only test builds envelopes with shielded+unshielded+dust (and a
    2-of-3 subset), `save`/`load`s through `PgWalletStateEnvelopeStore`, and asserts byte-for-byte
    round-trip of every present string plus correct skip of absent slots. No SDK sync.
- [ ] 1.6 Working-tree-hygiene check + artifact relocation.
  - **Acceptance:** the untracked `design/research/2026-07-21-snapshot-root-of-trust/` copy is removed
    from any non-`feature/verifiable-snapshot` worktree; a verify-gate check fails when
    `git status --porcelain` reports untracked files under `design/research/` on a branch other than
    the owning one, and passes otherwise.
- [ ] 1.7 §1.4 shared-helper consolidation (behavior-preserving).
  - **Acceptance:** `hasPostgresUnsafeText` and the recursive key-safety/depth-bound check live in one
    neutral module imported by both adapters (no adapter imports another adapter's interface module);
    `tsc --noEmit` clean; full suite still green; a pinned regression test asserts unchanged
    key-rejection behavior.

## 2. Performance — Milestone 4 seeding (`performance-observability`)

- [ ] 2.1 Benchmark harness skeleton (`Performance/bench/`) driving UmbraDB interfaces against
    Testcontainers Postgres, emitting a structured JSON result artifact (metric/value/unit/git SHA/PG
    version).
  - **Acceptance:** `npm run bench` runs all workloads and writes a result artifact; a unit test
    validates the artifact schema.
- [ ] 2.2 Workload coverage: versioned-KV put/get/getAt at increasing sizes; checkpoint save/load +
    dedup ratio; GC pass duration as the chunk store grows; lease contention; tx-history write/merge
    under concurrent writers; envelope save/load (`Performance/DESIGN.md` §4, extended).
  - **Acceptance:** each listed workload produces at least one metric in the artifact; the GC workload
    reports pass duration at ≥3 growing chunk-store sizes.
- [ ] 2.3 Regression gate + baseline.
  - **Acceptance:** `npm run bench:baseline` records/blesses a committed baseline; `npm run bench`
    fails when a metric regresses beyond the §6.3-decided threshold; a self-test injecting a synthetic
    regression proves the gate fails (not vacuous).
- [ ] 2.4 Tracing wrapper (`src/postgres/tracing.ts`) wrapping `postgres.js` `debug` in a
    `tracingChannel` span, `hasSubscribers`-guarded (`Performance/DESIGN.md` §2).
  - **Acceptance:** a test asserts an app-level call emits a span carrying SQL text + params +
    duration; a second asserts zero span emission (no overhead path) when no subscriber is attached.
- [ ] 2.5 Activity logging via `pino` worker-thread transport, hooked into `signal`/`StorageError`
    so cancel/throw paths emit automatically (`Performance/DESIGN.md` §5).
  - **Acceptance:** a test asserts a thrown `StorageError` and an aborted `signal` each emit a log
    event without per-call-site instrumentation.
- [ ] 2.6 Call→SQL→plan correlation + Postgres-side profiling runbook (`auto_explain`
    `log_nested_statements=on`, `pg_stat_statements` `track='all'`, `pg_stat_activity`).
  - **Acceptance:** a documented runbook exists; a test asserts a slow app-level call can be traced to
    its SQL text and an on-demand `EXPLAIN` plan for that statement; the runbook states `log_analyze`
    is never a standing default (`Performance/DESIGN.md` §1).

## 3. Connection robustness — DB layer (`connection-robustness`, part a)

- [ ] 3.1 Generalized pooling config (`idleTimeout`/`maxLifetime`) with omit⇒default discipline
    (`client.ts:49-51`, F2).
  - **Acceptance:** a test asserts each option, when omitted, does not pass its key to `postgres()`
    (the `k in o` footgun stays closed); when supplied, it maps to the right postgres.js key.
- [ ] 3.2 Bounded retry/backoff (exponential + jitter) for transient failures only, with the §6.1
    idempotency allow-list.
  - **Acceptance:** a transient error retries within the bound and eventually succeeds or gives up
    with `ConnectionError`; a permanent error (auth/schema) fails fast with no retry; a **negative**
    test proves no retry inside a caller `opts.tx` and no retry of a lease acquire.
- [ ] 3.3 `connectTimeout` generalized into an opt-in health policy (`connect_timeout` +
    optional `statement_timeout`/`idle_in_transaction_session_timeout`), all default-preserving.
  - **Acceptance:** omitting every knob reproduces today's behavior exactly (F2 regression guard);
    each supplied knob maps to the right postgres.js/session setting.
- [ ] 3.4 `checkLiveness()` bounded `SELECT 1`.
  - **Acceptance:** resolves against a live DB; rejects with `ConnectionError` (not a raw driver
    error, not a hang) against a dead endpoint within the bound.

## 4. Connection robustness — wallet-sync layer (part b)

- [ ] 4.1 Multi-endpoint cross-check in the sync-integration/adapter tier (no `src/` SDK import).
  - **Acceptance:** with ≥2 agreeing indexer endpoints the wallet is treated as synced; with
    disagreeing endpoints a typed error is raised and NO checkpoint is persisted; a grep confirms no
    `@midnightntwrk/*` runtime import under `src/`.
- [ ] 4.2 Finality-verified-tip check (or the §6.2-decided per-address equivalent) before persisting a
    checkpoint.
  - **Acceptance:** per the §6.2 verdict — either a tip at/above finalized head is refused for
    persistence, or the decided per-address cross-check is enforced; the test matches whichever the
    correctness gate chose, and cross-references C1 (`verifiable-snapshot-design.md:321`).
- [ ] 4.3 Reconnection/failover with bounded backoff.
  - **Acceptance:** on an endpoint drop/timeout the tier fails over to another configured endpoint
    with backoff; while endpoints disagree it refuses to mark synced; a test drives an endpoint-drop
    fixture and asserts failover + no-persist-while-disagreeing.

## 5. Audit chain + verify gate (`AGENTS.md`, `AUTONOMOUS_RUN_LOG.md:98-116`)

- [ ] 5.1 Three-persona Opus panel (domain-correctness, adversarial, release/coverage) + Codex
    gpt-5.6-sol cold audit + Fable aggregation on the implementation.
  - **Acceptance:** every `specs/*/spec.md` requirement maps to a passing test (Fable cross-check); no
    open BLOCK.
- [ ] 5.2 Full verify gate.
  - **Acceptance:** `npm test` all green (incl. new tests, existing 206 baseline as regression guard),
    `tsc --noEmit` clean, `npx openspec validate --all --strict` clean, `graphify update .` clean,
    `npm run bench` passes against baseline, the §1.6 working-tree-hygiene check passes.
- [ ] 5.3 Commit on `sprint-9-cleanup-perf-connection`, push the feature branch. Do NOT merge Sprint 9
    itself (its own successor is not yet planned); its CONFIRMED plan is what merges Sprint 8.
  - **Acceptance:** branch pushed; no force-push, no `--no-verify`; Sprint 8 merge to `main` recorded
    as unblocked by 0.3's CONFIRM.
