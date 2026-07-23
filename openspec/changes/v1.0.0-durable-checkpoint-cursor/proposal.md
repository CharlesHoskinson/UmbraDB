# Proposal — v1.0.0-durable-checkpoint-cursor

> **Status:** Proposed for the 1.0.0 program. Capability: `durable-composition`. This change is
> **API-affecting** and MUST land in the pre-freeze phase (`council/A-release-scope.md` §5 Phase 1,
> `ROADMAP-v1.0.0-CONSOLIDATED.md` critical-path step 1–2) — it changes
> `CheckpointStore.save`'s signature, so it cannot follow the API freeze (`G1`) without forcing a
> breaking change.

## Why

The five merged primitives (TemporalKV, Transaction/Lease, CheckpointStore, Watermarks,
TransactionHistory) plus the wallet-state envelope are individually crash-atomic, but the
**boundary between them is not durable**, and the durability of the whole rests on properties of
the Postgres server that UmbraDB neither states nor checks. The consolidated roadmap identifies
exactly one true correctness blocker for 1.0.0 — the cursor-durability gap — and three cheap
durability/contract fixes that must ride with it before the public surface is frozen
(`ROADMAP-v1.0.0-CONSOLIDATED.md` §"Headline verdict" 2, §B).

**The single blocking failure mode (`02-reliability-hardening.md` F1, `council/B-engineering-risk.md`
§5 ruling 1):** `PgWatermarks.set` and `PgTemporalKV.put` both accept a caller `tx` and can
co-commit a cursor with the data it describes, but `PgCheckpointStore.save` opens its *own* internal
`withTransaction` and **structurally refuses a `tx`** (`src/postgres/checkpoint-store.ts:114-124,149`;
the interface doc at `src/interfaces/checkpoint-store.ts:135` states "`save`/`prune` deliberately do
NOT accept a `tx` option"). A sync loop that does `save(...)` then `watermarks.set(cursor)` therefore
runs **two separate transactions**. A process or Postgres crash that commits the cursor but not the
checkpoint data leaves the durable watermark pointing past data that was never persisted; on resume
the sync skips the un-persisted range — silent, unbounded state divergence against the library's
single most important guarantee ("sync resumes from the last durable checkpoint/watermark"). Today
that guarantee is enforceable only by undocumented caller discipline, and the API forbids the safe
composition on the checkpoint path. **This must be fixed before the API freeze because it changes
`save`'s signature** (`council/A-release-scope.md` G5, `council/B-engineering-risk.md` P0-1).

**Three durability/contract fixes that must ride with it:** (1) UmbraDB makes no claim about the
Postgres it runs on — under `synchronous_commit=off`/`fsync=off` its "committed" checkpoints and
watermarks can vanish or corrupt on crash (`02` F9), and the advisory-lease scheme is silently
unsafe behind a transaction-pooling proxy (`02` F4); nothing in `src/postgres/client.ts:125-130`
inspects any of this. (2) No `statement_timeout`/`lock_timeout`/`idle_in_transaction_session_timeout`
is set on the connection, and the class-1 migration advisory lock (`src/postgres/migrate.ts:125`) has
no bounded wait — a half-dead server or a wedged concurrent starter hangs recovery indefinitely
instead of failing typed and bounded, which is a precondition for the crash-recovery tests to
terminate deterministically (`02` F10/F6-a, `council/B-engineering-risk.md` P0-4). (3) Three small
contract-integrity holes make the contracts the 1.0.0 error/durability docs are about *false*:
`PgCheckpointStore`'s four entry points never validate `walletId`/`networkId` (a NUL/lone-surrogate
id escapes as a raw driver error, breaching the "no raw driver errors" contract — `04` F3);
`JsonValueSchema` has no depth bound though the identical guard already exists one module over for
tx-history `sections` (`04` F4, the only finding with an off-host/chain-derived attacker input path);
and `withLease` swallows lease-release failures with `.catch(() => {})`
(`src/postgres/transaction-lease.ts:412`), hiding the one signal that mutual exclusion may have
lapsed.

## What changes

1. **`CheckpointStore.save` accepts a caller transaction (G5).** `save` gains an optional
   `opts.tx?: TransactionHandle`; when supplied it issues every statement on that transaction-scoped
   connection (via the existing `resolveTransaction`, `src/postgres/transaction-lease.ts`) instead of
   composing its own internal `withTransaction`. This reverses the deliberate
   `src/interfaces/checkpoint-store.ts:135` "no `tx`" decision — a documented, intentional contract
   change made **before** the freeze precisely so it need never be a breaking one afterward.
2. **A `saveAndAdvance` combinator (G5).** A composition-layer function that opens one
   `withTransaction` and co-commits the checkpoint (`save` with `tx`) and its sync cursor
   (`watermarks.set` with the same `tx`) atomically, so the durable cursor can never be ahead of the
   durable checkpoint data. Plus a written **ordering contract** for callers composing manually:
   advance the cursor strictly *after* the data transaction commits (the safe watermark-behind-data
   direction), never before.
3. **Durability startup probe + binding Durability Contract (G6).** A probe run as a **mandatory step
   of `runMigrations`** (non-skippable — every consumer must call `runMigrations` before first use —
   and also directly callable as `probeDurability`) `SHOW`-verifies `fsync` (refuse on `off`),
   `synchronous_commit` (typed lost-tail warning on `off` **only**; `local`/`remote_write`/
   `remote_apply`/`on` are crash-durable on a primary and are not warned), and `full_page_writes`
   (warn/refuse on `off`), and detects a transaction-pooling proxy by asserting a session advisory
   lock is visible in `pg_locks` from a follow-up query on the same session. A hard violation makes
   `runMigrations` reject before any migration runs. The required configuration is published as a
   binding Durability Contract doc.
4. **Server-side timeouts (G7).** Conservative, caller-overridable `statement_timeout`,
   `lock_timeout`, and `idle_in_transaction_session_timeout` defaults on the UmbraDB connection
   (`client.ts`), plus a bounded wait on the class-1 migration advisory lock so a wedged concurrent
   starter fails fast with a typed timeout instead of hanging forever.
5. **Contract-integrity fixes (G8).** Validate `walletId`/`networkId` at all four
   `PgCheckpointStore` entry points (`save`/`load`/`history`/`prune`) reusing the wallet-state
   envelope's `z.string().min(1).refine(!hasPostgresUnsafeText)` pattern
   (`src/interfaces/wallet-state-envelope.ts:80-82`) **extended with a `.max()` length bound** (the
   envelope has none), the bound pinned at 512; add a depth bound to `JsonValueSchema`
   (`src/interfaces/temporal-kv.ts:62`) by reusing the existing iterative `exceedsMaxDepth` guard
   (`src/interfaces/transaction-history-storage.ts:131`); and make `withLease` surface — never
   swallow — a lease-release failure (default: reject with the `LeaseFaultError`; a supplied
   `onReleaseFault` callback receives it and lets `withLease` resolve).

## Non-goals (explicitly out of scope for this change)

- **`save()` idempotency (`idempotency_key` + UNIQUE constraint).** Explicitly OUT — P1, deferred to
  "with Sprint 9's retry wrapper" (`ROADMAP-v1.0.0-CONSOLIDATED.md` §Deferred,
  §"Council rulings", `council/B-engineering-risk.md` §5 ruling 3). A lost-COMMIT-ack retry produces
  a *benign, identical-content* duplicate manifest under load-latest-complete semantics, not
  corruption; grouping it with the genuinely silent-divergence G5 dilutes what P0 means. The 1.0.0
  obligation is the *documented* save-retry caveat (owned by the API/contract-docs change, `G4`), and
  the Sprint 9 retry wrapper MUST exclude `save` until the key ships.
- **The deep lease-fencing fix** — routing lease-protected writes through the lease's own reserved
  connection, and any monotonic fencing-token protocol. Deferred to 1.0.x / rejected for the
  single-writer model (`council/B-engineering-risk.md` §5 ruling 2, P1-1(b)). Only the S-effort
  "stop swallowing release failures" half is in scope here; the mutual-exclusion limitation ships as
  documentation (owned by `G4`).
- **Perf-correctness fixes** (`save` `UNNEST` batching HP-1, `history()` N+1 → `GROUP BY` HP-2,
  `kv_current fillfactor=90` IS-1) and any benchmark baseline. Out of this change — perf never gates
  1.0.0 except that a baseline must exist (`council/B-engineering-risk.md` §4, §6;
  `ROADMAP-v1.0.0-CONSOLIDATED.md` G13/G14). These belong to the perf-baseline change.
- **The crash-injection / cold-start test suite** (T1/T2/T3/T5/T11 in required CI). Out — owned by
  the testing-gate change (`G9`–`G12`). This change is the *precondition* for T5 (the cursor-durability
  crash test) and the durability-probe test T12; it delivers the API and the non-crash unit/property
  coverage, and records the dependency, but does not itself add the Testcontainers chaos harness.
- **The Sprint 9 auto-retry wrapper.** Out (`ROADMAP` §Deferred).
- **Cross-wallet dedup-oracle / keyed chunk addressing / at-rest encryption.** Out — 1.0.0 handles
  these as documentation only; keyed chunking is 1.1 code (`ROADMAP` §"Council rulings",
  `council/A-release-scope.md` §3, §4e). This change touches neither the chunk-addressing scheme nor
  the envelope encoding.
- **Importing any consumer/indexer app.** Prohibited — it would breach UmbraDB's indexer-agnostic
  boundary (`council/A-release-scope.md` ruling b). `saveAndAdvance` composes only in-repo primitives
  (CheckpointStore + Watermarks + the transaction layer); it takes no dependency on any consumer.

## Impact

- **Modified — API surface (must precede `G1` freeze):**
  - `src/interfaces/checkpoint-store.ts` — `save`'s signature gains `opts.tx?: TransactionHandle`;
    the "deliberately do NOT accept a `tx`" doc (`:135`) is rewritten to the new contract, plus the
    `walletId`/`networkId` validation contract and the ordering contract for the cursor.
  - `src/interfaces/temporal-kv.ts` — `JsonValueSchema` (`:62`) gains a depth bound; the iterative
    `exceedsMaxDepth` guard + its depth constant are hoisted here (or into a shared json-util module)
    from `transaction-history-storage.ts` so both call sites share one definition without an import
    cycle.
  - `src/interfaces/transaction-lease.ts` — `withLease`'s combinator doc gains the release-fault
    surfacing contract; `LeaseAcquireOptions` gains a new `onReleaseFault?` field (default behaviour
    without it: reject with the `LeaseFaultError`).
- **Modified — implementation:**
  - `src/postgres/checkpoint-store.ts` — `save` threads `opts.tx` through `resolveTransaction`;
    `save`/`load`/`history`/`prune` validate ids at their boundary.
  - `src/postgres/client.ts` (`:119-131`) — connection options gain the three server-side timeouts;
    a new durability-probe function (`src/postgres/durability-probe.ts`) is invoked as a mandatory
    step of `runMigrations`.
  - `src/postgres/migrate.ts` (`:125`) — the class-1 advisory-lock acquire is bounded with a
    timeout and a typed error.
  - `src/postgres/transaction-lease.ts` (`:412`) — `withLease` stops swallowing release failures.
  - `src/interfaces/transaction-history-storage.ts` — imports the hoisted `exceedsMaxDepth`.
  - A new composition module (e.g. `src/postgres/save-and-advance.ts`) for the `saveAndAdvance`
    combinator.
- **New tests:** co-transactional composition + rollback tests; durability-probe unit tests against
  `fsync=off` / `synchronous_commit=off` (warn) / `synchronous_commit=local`-`remote_write`-
  `remote_apply` (no warn) / `full_page_writes=off` / simulated-pooler configs, asserting
  `runMigrations` rejects on a hard violation; timeout-default (including a raised idle-in-tx
  override) and migration-lock-timeout tests; id-validation, JSON-depth, and
  `withLease`-release-fault tests (no-callback reject AND callback resolve); a property test for the
  cursor-never-ahead invariant over both `saveAndAdvance` and manual safe-ordering compositions under
  the ordering contract (fault-free).
- **Risk:** the highest-risk item is the `save` signature change — it is deliberately scheduled
  pre-freeze so the risk is confined to this window. The durability probe's placement (a `SHOW` probe
  is async; `createClient` today is synchronous, `client.ts:119`, so the probe is wired into the async
  `runMigrations` path rather than into `createClient`) is the main design decision (see
  `design.md` §2). Everything else is small, localized, and mirrors an established in-repo pattern.
- **Delivery:** matches the project cadence — this proposal/design/tasks/spec reviewed first, then a
  builder implements against it with two parallel Opus auditors per task (see `tasks.md`).
