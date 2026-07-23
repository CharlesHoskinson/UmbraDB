# Acceptance — v1.0.0-durable-checkpoint-cursor

Consolidated, testable acceptance criteria for the whole change. Every criterion is objective (a
test, a checkable artifact, or a reviewer-verifiable fact), traces to a requirement in
`specs/durable-composition/spec.md`, and names its verification method:

- **unit** — a Testcontainers-backed unit/integration test asserting a concrete outcome
- **property** — a `fast-check` property test
- **doc** — a checkable documentation artifact reviewed against the requirement wording
- **CI gate** — an assertion wired into required CI (typecheck / import-lint / test run)
- **manual** — reviewer-verified fact recorded at close-out (no automated proof practical)

Nothing here gates on a performance number (per `council/B-engineering-risk.md` §3/§6) or on any
consumer/indexer repository (per `council/A-release-scope.md` ruling b).

## G5 — Co-transactional watermark + checkpoint data

| # | Criterion | Requirement | Method |
|---|---|---|---|
| A1 | `PgCheckpointStore implements CheckpointStore` typechecks with `save`'s new `opts.tx` | save accepts a caller tx | CI gate (`tsc --noEmit`) |
| A2 | `save` with a caller `tx` that COMMITS → checkpoint is `load`able; rows written on the caller's transaction | save accepts a caller tx | unit |
| A3 | `save` with a caller `tx` that ROLLS BACK → no manifest/junction/`complete=true` row visible | save accepts a caller tx | unit |
| A4 | `save` with no `tx` returns the same `CheckpointSummary` shape and behaviour as before (regression) | save accepts a caller tx | unit |
| A5 | `save` with a stale/fabricated `tx` handle → `TransactionHandleInvalidError`, no statement issued | save accepts a caller tx | unit |
| A6 | `saveAndAdvance` success → `load` returns the checkpoint AND `watermarks.get` returns the cursor, committed together | saveAndAdvance co-commits | unit |
| A7 | `saveAndAdvance` rolled back before commit → neither checkpoint nor advanced cursor durable; prior cursor still points at prior durable data | saveAndAdvance co-commits | unit |
| A8 | `save-and-advance.ts` imports no consumer/indexer module | saveAndAdvance co-commits | CI gate (import-lint) |
| A9 | Property: over randomized interleavings of BOTH `saveAndAdvance` AND manual safe-ordering compositions (data tx committed, then cursor advanced), the durable cursor never references an absent checkpoint; resume reproduces reference CURRENT state | conforming composition keeps cursor from being ahead | property |
| A10 | Checkpoint-store contract doc states the cursor-strictly-after-data ordering rule + current-state replay contract, cross-referenced from `STORAGE_ALGEBRA.md` W1 | conforming composition keeps cursor from being ahead | doc |
| A11 | Handoff recorded: T5 (crash between data-commit and cursor-advance, `synchronous_commit` on AND off) is owned by the testing-gate change and now has the API it needs; the spec's manual-composition crash scenario is annotated in-spec as T5-verified | conforming composition keeps cursor from being ahead | manual |

## G6 — Durability startup probe + binding contract

| # | Criterion | Requirement | Method |
|---|---|---|---|
| B1 | Probe (via `runMigrations`) against `fsync=off` → `runMigrations` rejects with typed `DurabilityContractError`, having run no migration | durability probe asserts settings | unit |
| B2 | Probe against `synchronous_commit=off` → typed lost-tail warning, NOT a refusal | durability probe asserts settings | unit |
| B2b | Probe against `synchronous_commit` = `local`/`remote_write`/`remote_apply` on a primary → NO lost-tail warning, `runMigrations` proceeds (these flush WAL locally before ack; Opus B1) | durability probe asserts settings | unit |
| B3 | Probe against `full_page_writes=off` with no override → `runMigrations` rejects, typed error | durability probe asserts settings | unit |
| B4 | Probe against a healthy default server → no hard violation, `runMigrations` proceeds | durability probe asserts settings | unit |
| B5 | Direct/session-mode connection: follow-up query observes the session advisory lock → pooler check passes | transaction-pooling proxy detected | unit |
| B6 | Simulated/injected "lock not visible on follow-up" → `runMigrations` rejects with a typed error naming the pooler hazard, having run no migration | transaction-pooling proxy detected | unit |
| B7 | `docs/durability-contract.md` names `fsync`, `full_page_writes`, `synchronous_commit`, the transaction-pooler prohibition, and the three timeouts, labeling each probe-enforced vs. documented | Durability Contract published | doc |
| B8 | Every "probe-enforced" claim in the contract doc matches the actual probe code (no drift) | Durability Contract published | manual |

## G7 — Server-side timeouts

| # | Criterion | Requirement | Method |
|---|---|---|---|
| C1 | Default client: `SHOW statement_timeout`, `SHOW lock_timeout`, `SHOW idle_in_transaction_session_timeout` each report a non-zero configured default | connection sets bounded timeouts | unit |
| C2 | Explicit overrides via `UmbraDBConnectionOptions` → each `SHOW` reports the override | connection sets bounded timeouts | unit |
| C3 | After a lease that set its own `statement_timeout` is released, the reserved connection's `statement_timeout` is the connection default — not `0`, not the lease TTL | connection sets bounded timeouts | unit |
| C3b | A client created with `idle_in_transaction_session_timeout` raised via `UmbraDBConnectionOptions` → `SHOW` reports the raised value, so a legitimate long in-transaction workload (lease/`withTransaction`) is not bounded by the shorter default (Opus N3) | connection sets bounded timeouts | unit |
| C4 | Held class-1 migration lock (first session) → second `runMigrations` fails fast with a typed timeout within the bound, never hangs (roadmap T8) | migration advisory-lock bounded | unit |
| C5 | A successful advisory-lock acquire restores the prior session-level timeout so migration DDL is not subject to the short acquire bound | migration advisory-lock bounded | unit |
| C6 | No code or test comment asserts the (false) claim that `lock_timeout` cannot abort an advisory-lock acquisition; the bound's mechanism (`lock_timeout` / scoped `statement_timeout` / try-poll) is an implementation choice proven by C4, not a fixed knob (Fable F1, reproduced on PG 16.14) | migration advisory-lock bounded | manual |

## G8 — Contract-integrity fixes

| # | Criterion | Requirement | Method |
|---|---|---|---|
| D1 | Each of `save`/`load`/`history`/`prune` with a NUL or lone-surrogate `walletId`/`networkId` → `ValidationError` (NOT `UnrecognizedPostgresError`/raw driver error), no statement issued | checkpoint id validation | unit |
| D2 | Each of the four methods with an over-length id → `ValidationError` before any statement | checkpoint id validation | unit |
| D3 | Each of the four methods with a well-formed id → unchanged behaviour (regression) | checkpoint id validation | unit |
| D4 | `PgTemporalKV.put` with an over-deep value → `ValidationError` before any statement, no stack overflow | JsonValueSchema depth bound | unit |
| D5 | `PgWatermarks.set` with an over-deep value → `ValidationError` before any statement (shared bound) | JsonValueSchema depth bound | unit |
| D6 | A value at exactly the maximum depth → passes validation | JsonValueSchema depth bound | unit |
| D7 | Existing `transaction-history-storage` `sections` depth tests still pass after `exceedsMaxDepth` is hoisted (no behaviour change there; no import cycle) | JsonValueSchema depth bound | unit / CI gate |
| D8 | `withLease`: `fn` succeeds + **no** `onReleaseFault` + release fails → `withLease` **rejects** with the `LeaseFaultError` (the pinned default), not swallowed, not resolved | withLease surfaces release failure | unit |
| D8b | `withLease`: `fn` succeeds + `onReleaseFault` supplied + release fails → `onReleaseFault` is invoked with the fault AND `withLease` resolves with `fn`'s return value | withLease surfaces release failure | unit |
| D9 | `withLease`: `fn` throws + release fails → `fn`'s error is the primary rejection AND the release fault is still surfaced (`onReleaseFault` if supplied, else attached `cause`/aggregated) | withLease surfaces release failure | unit |
| D10 | `withLease`: clean release → resolves with `fn`'s return value, no fault surfaced | withLease surfaces release failure | unit |

## Whole-change gates (non-goal compliance + sequencing)

| # | Criterion | Method |
|---|---|---|
| E1 | No `idempotency_key` column, no UNIQUE on `(w,net,seq)`, no `manifest_hash` dedup added to `save` (deferred to Sprint 9) | manual |
| E2 | No lease write-routing / fencing-token change — only the release-fault swallow is fixed (deep fix deferred to 1.0.x) | manual |
| E3 | No perf-correctness fix (HP-1/HP-2/IS-1) and no benchmark baseline introduced by this change | manual |
| E4 | No consumer/indexer app imported anywhere in the change | CI gate (import-lint) + manual |
| E5 | No chunk-addressing or envelope-encoding change (keyed/encrypted chunk modes remain 1.1) | manual |
| E6 | `save`'s final signature and the `withLease` option shape are settled and recorded, so the `G1` API freeze can export them without a later breaking change | manual |
| E7 | Whole-change differential review confirms every Acceptance row above was actually checked, not merely that CI is green | manual |
