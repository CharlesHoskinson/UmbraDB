# Graph Report - UmbraDB-storage-algebra-lean  (2026-07-21)

## Corpus Check
- 93 files · ~136,026 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1078 nodes · 1464 edges · 129 communities (79 shown, 50 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 9 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `b47953a3`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- checkpoint-store.ts
- transaction-lease.ts
- temporal-kv.ts
- watermarks.ts
- scoped-review-manifest
- Storage Algebra Lean Formalization — Approved Design and Status
- package.json
- postgres.js driver choice
- SKILL.md
- Tier 1 / Tier 2 Postgres schema split
- compilerOptions
- kv_current/kv_history temporal-table design
- Throw-typed-error idiom unification across modules
- Transaction/Lease layer interface (STALE, superseded)
- Fixed-size chunk splitting requirement
- Testcontainers vs pg-mem test-infrastructure decision
- TypeDoc documentation tooling decision
- Transactions commit or roll back atomically
- midnight-pg-store new package
- Abstract-Model-First Scope Decision
- Requirements
- Nested withTransaction unsupported (disclosed limitation)
- Refuted Research Claims (GIN quote, Git grace period, correlated subquery)
- diagnostics_channel/tracingChannel Instrumentation Design
- Hand-rolled migration runner decision (no ORM)
- OpenSpec Store
- Postgres errors surface as StorageError hierarchy requirement
- Storage Algebra Lean M2 Retention Sprint
- Law T1: gapless monotonic versions requirement
- Keep-Knowledge-Graph-Current Policy
- Law T3: temporal-projection equivalence (getAt)
- Law T4: dual addressing agreement
- Law T5: history intervals never overlap
- Algebraic Specification of the midnight-pg-store Storage Layer
- listKeys streaming/order requirement
- Global Constraints
- Migrations idempotent and ordered requirement
- Schema isolation default requirement
- Lease timeout distinct for acquireLease vs tryAcquireLease
- Transaction timeout surfaces as TransactionFaultError
- withLease always releases its lease, even when fn throws
- history pagination query
- load full chunk-integrity + manifest verification
- manifest_hash tamper-detection verification
- prune two-step manifest-then-chunk GC pass
- Content-addressed global chunk dedup requirement
- history cursor paging no-gap/no-duplicate requirement
- load always fully verifies chunk integrity
- ManifestCorruptError position-gap requirement
- manifestHash computed once at write time
- ManifestCorruptError chunk-hash-sequence tamper requirement
- CheckpointNotFoundError vs empty-history distinction
- prune retains exactly N newest manifests requirement
- save ValidationError before any work requirement
- CheckpointSummary metadata/label round-trip requirement
- PgWatermarks.get implementation
- migrate.ts
- Watermarks Postgres errors surface as StorageError requirement
- get never throws for an unset cursor requirement
- get returns last value scoped per (kind,key) requirement
- private_state_salts table / per-scope salt derivation
- set ValidationError before statement requirement
- Design — Postgres+JSONB storage rebuild
- Watermarks AbortSignal pre-check-only requirement
- ADDED Requirements
- Top-level null value application-level guard
- ADDED Requirements
- complete flag explicit-write requirement
- ADDED Requirements
- CheckpointStore cancellation scope decision (pre-check only)
- transaction-lease.ts
- ADDED Requirements
- pull_request_template.md
- AGENTS.md
- watermarks.test.ts
- Design — Sprint 3: CheckpointStore
- errors.ts
- Design — Sprint 4: Watermarks
- Design — Sprint 2: Transaction/Lease
- ADDED Requirements
- explore.md
- Requirement: A caller-supplied transaction handle is honored or rejected, never silently ignored
- Design — Sprint 1: project setup + TemporalKV
- UmbraDB
- Roadmap
- README.md
- ROADMAP.md
- Storage Algebra Lean M3a Watermarks Sprint
- Tasks — Sprint 3: CheckpointStore
- Tasks — Sprint 4: Watermarks
- Design — Sprint 5: Lean M3a Watermarks W1
- Performance — design
- temporal-kv.test.ts
- 1. Shared Conventions
- Proposal — Sprint 1: project setup + TemporalKV
- Proposal — Sprint 2: Transaction/Lease
- Tasks — Sprint 2: Transaction/Lease
- Proposal — Sprint 3: CheckpointStore
- Proposal — Sprint 4: Watermarks
- Proposal — Sprint 5: Lean M3a Watermarks W1
- Tasks — Sprint 5: Lean M3a Watermarks W1
- Storage Layer Interface Specification
- 3. Module Interfaces
- Tasks — Sprint 1: project setup + TemporalKV
- Requirement: Checkpoint sequence numbers are gapless, monotonic, and scoped per wallet+network
- Requirement: load and history distinguish "no checkpoint" from "checkpoint exists elsewhere"
- GC architecture and query-tracing: research findings
- Requirement: load always fully verifies chunk integrity before returning
- Requirement: prune rejects a retainCount that is not a positive safe integer, before any deletion runs
- ADDED Requirements
- Requirement: A chunk still referenced by any surviving manifest is never reclaimed (Law C2a)
- Requirement: A manifest preserves the exact order and multiplicity of its chunks, including repeats
- Requirement: An already-aborted opts.signal rejects before any database work; a signal aborting after the call has begun has no effect
- Requirement: Checkpoint payloads are split into fixed-size chunks with a correctly-sized remainder
- Requirement: CheckpointSummary metadata is populated and label round-trips
- Requirement: Chunk reclamation respects the grace window, protecting against re-reference races
- Requirement: Chunk storage is content-addressed and globally deduplicated
- Requirement: history is newest-first, scoped per wallet+network, and supports cursor paging with no gap or duplicate
- Requirement: manifestHash is computed once at write time from the ordered chunk-hash sequence
- Requirement: prune retains exactly the N newest complete manifests per wallet+network
- Storage Algebra Lean M3b CheckpointStore C1 Sprint
- Design — Sprint 6: Lean M3b CheckpointStore C1
- Proposal — Sprint 6: Lean M3b CheckpointStore C1
- Tasks — Sprint 6: Lean M3b CheckpointStore C1

## God Nodes (most connected - your core abstractions)
1. `TransactionHandle` - 22 edges
2. `UmbraDBSql` - 21 edges
3. `translatePostgresError()` - 21 edges
4. `ADDED Requirements` - 19 edges
5. `resolveTransaction()` - 17 edges
6. `withAbort()` - 16 edges
7. `StorageError` - 15 edges
8. `ValidationError` - 15 edges
9. `PgTemporalKV` - 15 edges
10. `PgTransactionLeaseLayer` - 14 edges

## Surprising Connections (you probably didn't know these)
- `Correctness rule: verify external claims against real source` --rationale_for--> `kv_current/kv_history temporal-table design`  [INFERRED]
  openspec/config.yaml → design/design.md
- `startTestDatabase()` --calls--> `runMigrations()`  [EXTRACTED]
  test/postgres/setup.ts → src/postgres/migrate.ts
- `getAt single-statement UNION ALL race fix` --references--> `kv_current/kv_history temporal-table design`  [EXTRACTED]
  openspec/changes/archive/2026-07-21-sprint-1-setup-and-temporal-kv/design.md → design/design.md
- `Migrations as TypeScript functions (schema-configurability fix)` --references--> `kv_current/kv_history temporal-table design`  [EXTRACTED]
  openspec/changes/archive/2026-07-21-sprint-1-setup-and-temporal-kv/design.md → design/design.md
- `save() fixed-size chunking algorithm` --references--> `Content-addressed checkpoint chunker`  [EXTRACTED]
  openspec/changes/sprint-3-checkpoint-store/design.md → design/design.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **The Nine Laws Forming UmbraDB's Storage Algebra** — formal_storage_algebra_law_t1, formal_storage_algebra_law_t2, formal_storage_algebra_law_t3, formal_storage_algebra_law_t4, formal_storage_algebra_law_t5, formal_storage_algebra_law_c1, formal_storage_algebra_law_c2, formal_storage_algebra_law_w1, formal_storage_algebra_law_l1 [EXTRACTED 1.00]
- **Four storage modules unified under StorageError hierarchy** — design_design_interfaces_storageerror, design_design_interfaces_temporalkv, design_design_interfaces_checkpointstore, design_design_interfaces_watermarks, design_design_interfaces_transactionleaselayer_stale [EXTRACTED 1.00]
- **Modules composing the Sprint 2 transaction-handle registry** — sprint2_design_transaction_handle_registry, sprint1_design_pgtemporalkv_put, sprint3_design_torn_read_fix, sprint4_design_composing_txlease [EXTRACTED 1.00]
- **Pre-check-only withAbort cancellation pattern across sprints** — sprint1_design_listkeys_cursor, sprint2_design_withtransaction, sprint3_design_cancellation_scope_decision, sprint4_design_cancellation [INFERRED 0.85]

## Communities (129 total, 50 thin omitted)

### Community 0 - "checkpoint-store.ts"
Cohesion: 0.07
Nodes (29): CheckpointNotFoundError, CheckpointRecord, CheckpointSequence, CheckpointStore, CheckpointStoreError, CheckpointStoreErrorCode, CheckpointSummary, ChunkIntegrityError (+21 more)

### Community 1 - "transaction-lease.ts"
Cohesion: 0.11
Nodes (13): LeaseFaultError, LeaseNotHeldError, LeaseTimeoutError, Rollback, TransactionFaultError, TransactionHandleInvalidError, TransactionLeaseError, TransactionLeaseErrorCode (+5 more)

### Community 2 - "temporal-kv.ts"
Cohesion: 0.09
Nodes (37): RFC-8259, AsOf, AssertExact, ExpectedVersionSchema, hasPostgresUnsafeText(), HistoryUnavailableError, JsonValue, jsonValueHasUnsafeText() (+29 more)

### Community 3 - "watermarks.ts"
Cohesion: 0.25
Nodes (5): WatermarkValue, WatermarkValueSchema, WatermarkRow, arbitraryWatermarkValue, { sql: getSql }

### Community 4 - "scoped-review-manifest"
Cohesion: 0.22
Nodes (8): Cleanup, scoped-review-manifest, Step 0 — Skip check, Step 1 — Freshness gate, Step 2 — Changed-file seed set, Step 3 — Blast-radius computation, Step 4 — Write the manifest, Step 5 — Hand off

### Community 5 - "Storage Algebra Lean Formalization — Approved Design and Status"
Cohesion: 0.05
Nodes (44): 10. Sprint 2 transaction/lease proposal, 11.1 Repository evidence, 11.2 External primary sources, 11. Evidence matrix, 12. Milestone status, 13. Approved implementation decisions, 1. Executive conclusion, 2.1 Historical implementation baseline (+36 more)

### Community 6 - "package.json"
Cohesion: 0.07
Nodes (29): fast-check, dependencies, postgres, zod, devDependencies, fast-check, @testcontainers/postgresql, typedoc (+21 more)

### Community 8 - "SKILL.md"
Cohesion: 0.12
Nodes (16): Check for context, Ending Discovery, Guardrails, Handling Different Entry Points, OpenSpec Awareness, The Stance, What You Don't Have To Do, What You Might Do (+8 more)

### Community 10 - "compilerOptions"
Cohesion: 0.14
Nodes (13): src/**/*.ts, test/**/*.ts, compilerOptions, declaration, esModuleInterop, module, moduleResolution, noEmit (+5 more)

### Community 11 - "kv_current/kv_history temporal-table design"
Cohesion: 0.05
Nodes (43): Content-addressed checkpoint chunker, ckpt_manifest_chunks junction table (original, later corrected), FerretDB Mongo-compatibility shim evaluated and rejected, kv_history retention policy (pg_cron), State-equivalence merge-blocker gate, kv_current/kv_history temporal-table design, TransactionKeyReuseError / txid_current() fix, watermarks table schema sketch (+35 more)

### Community 20 - "Requirements"
Cohesion: 0.06
Nodes (34): Purpose, Requirement: A caller-supplied transaction handle is honored or rejected, never silently ignored, Requirement: A second write to the same key within one transaction is rejected at the trigger level, not silently absorbed, Requirement: Dual addressing agrees at recorded write timestamps (Law T4), Requirement: getAt satisfies temporal-projection equivalence (Law T3), within the store's retention window, Requirement: History intervals never overlap for a single key (Law T5), Requirement: listKeys streams without materializing the full result set first, and orders results correctly, Requirement: Migrations are idempotent and ordered (+26 more)

### Community 27 - "Storage Algebra Lean M2 Retention Sprint"
Cohesion: 0.15
Nodes (12): Adversarial test matrix, Approved semantic decisions, Completed baseline, Executable pruning, Explicit non-goals, Extensional T5, Implemented source layout, Lookup classification (+4 more)

### Community 33 - "Algebraic Specification of the midnight-pg-store Storage Layer"
Cohesion: 0.07
Nodes (30): Superseded — see `Formal/STORAGE_ALGEBRA.md`, crdt-lean Dependency Refutation, 1. TemporalKV — event-sourced right action with a CAS guard, 2. CheckpointStore — idempotent join-semilattice with a reachability closure, 3. Watermarks — trivial last-write-wins (deliberately *not* event-sourced), 4. Transaction / Lease — the control algebra the other three run inside, 5. Testable-law deliverable (fast-check + Vitest), 6. On not adding a Merkle/authenticated data structure (+22 more)

### Community 35 - "Global Constraints"
Cohesion: 0.25
Nodes (7): Global Constraints, Plan Self-Review, Storage Algebra Lean M1 Implementation Plan, Task 1: Pin the project and prove the imported API smoke slice, Task 2: Implement the executable TemporalKV history kernel, Task 3: Prove the M1 TemporalKV theorem slice, Task 4: Add reproducible trust gates and close the M1 documentation loop

### Community 57 - "migrate.ts"
Cohesion: 0.15
Nodes (7): assertValidSchemaName(), Migration, migrations, runMigrations(), runMigrationsImpl(), RunMigrationsOptions, withReservedTransaction()

### Community 63 - "Design — Postgres+JSONB storage rebuild"
Cohesion: 0.05
Nodes (32): Baseline (for measuring whether this actually helps), Graph-scoped review policy, Guardrails (this repo's own policy — `graphify` upstream provides none of these), Keep the knowledge graph current, sprint by sprint, The scoping mechanism (PUSH roles only), UmbraDB — project instructions, When not to bother, 0. How this reconciles with the Tier-2 (indexer) Postgres decision (+24 more)

### Community 65 - "ADDED Requirements"
Cohesion: 0.06
Nodes (33): ADDED Requirements, Requirement: A caller-supplied transaction handle is honored or rejected, never silently ignored, Requirement: A second write to the same key within one transaction is rejected at the trigger level, not silently absorbed, Requirement: Dual addressing agrees at recorded write timestamps (Law T4), Requirement: getAt satisfies temporal-projection equivalence (Law T3), within the store's retention window, Requirement: History intervals never overlap for a single key (Law T5), Requirement: listKeys streams without materializing the full result set first, and orders results correctly, Requirement: Migrations are idempotent and ordered (+25 more)

### Community 66 - "Top-level null value application-level guard"
Cohesion: 0.67
Nodes (3): prune retainCount validation requirement, Top-level null value application-level guard, set rejects top-level null requirement

### Community 67 - "ADDED Requirements"
Cohesion: 0.06
Nodes (33): ADDED Requirements, Requirement: A lease timeout surfaces distinctly for acquireLease vs. tryAcquireLease, Requirement: A resolved transaction handle always refers to its own live transaction, Requirement: A transaction timeout surfaces as TransactionFaultError, Requirement: Aborting opts.signal before withTransaction starts rejects with AbortError, Requirement: Aborting opts.signal during lease acquisition rejects with AbortError, Requirement: acquireLease waits indefinitely absent a timeout; tryAcquireLease never blocks unboundedly, Requirement: At most one holder per lease key at any instant (Law L1) (+25 more)

### Community 69 - "ADDED Requirements"
Cohesion: 0.06
Nodes (31): ADDED Requirements, Requirement: a caller-supplied transaction handle is honored, not silently ignored, Requirement: a non-object JSON value round-trips correctly, Requirement: an already-aborted opts.signal rejects before any statement; a later abort has no effect, Requirement: get never throws for an unset cursor, Requirement: get returns exactly the last value set, scoped per (kind, key), Requirement: Postgres errors surface as the shared StorageError hierarchy, Requirement: set is an idempotent, unconditional overwrite (Law W1) (+23 more)

### Community 70 - "CheckpointStore cancellation scope decision (pre-check only)"
Cohesion: 0.06
Nodes (32): Advisory-lock class registry (classes 1/2/3), Module → Postgres module mapping table, Postgres advisory-lock writer lease (corrected design), CheckpointNotFoundError, CheckpointStore interface, CheckpointWalletStateStore (production adapter), Global cross-wallet chunk GC reclamation fix, WalletStateStore (project abstraction) (+24 more)

### Community 71 - "transaction-lease.ts"
Cohesion: 0.19
Nodes (18): Lease, LeaseAcquireOptions, LeaseAcquireOptionsSchema, TransactionOptions, TransactionOptionsSchema, abortError(), isStatementTimeout(), activeTransactions (+10 more)

### Community 72 - "ADDED Requirements"
Cohesion: 0.11
Nodes (18): ADDED Requirements, formal-watermarks, Requirement: Command traces compose in list order, Requirement: Lookup after a trace returns the last matching value, Requirement: Set is an unconditional overwrite at the exact address, Requirement: Set preserves distinct addresses, Requirement: The abstract Watermarks store has one absence representation, Requirement: The W1 proof claim remains abstract (+10 more)

### Community 73 - "pull_request_template.md"
Cohesion: 0.50
Nodes (3): Change summary, Mandatory Codex audit, Validation

### Community 75 - "watermarks.test.ts"
Cohesion: 0.12
Nodes (11): assertNoConflictingSearchPath(), createClient(), UmbraDBConnectionOptions, UmbraDBSql, { sql: getSql }, registerSuiteLifecycle(), startTestDatabase(), stopTestDatabase() (+3 more)

### Community 76 - "Design — Sprint 3: CheckpointStore"
Cohesion: 0.13
Nodes (14): 0. Package layout, 1. Chunking, 2.1 `ckpt_manifest_chunks` needs an explicit position, 2.2 `seq` needs an explicit allocator, 2.3 `complete`: kept, and explicitly written `true` by every `save()`, 2. Schema — two corrections to `design/design.md` §3, 3. `prune` — two-step GC, `design/design.md` §3's pass plus §2.1's cascade, 4. `load` — full verification, no exceptions (+6 more)

### Community 77 - "errors.ts"
Cohesion: 0.16
Nodes (12): ConnectionError, SerializationFailedError, SharedStorageErrorCode, StorageError, ClockRegressionError, CONNECTION_FAILURE_CODES, ExclusionViolationError, isConnectionFailure() (+4 more)

### Community 78 - "Design — Sprint 4: Watermarks"
Cohesion: 0.15
Nodes (12): 0. Package layout, 10. Test infrastructure, 1. Schema — one physical-parameter correction to `design/design.md` §4, 2. `set`, 3. `get`, 4. Large-integer cursor values — a documented convention, not a schema change, 5. Accepted tradeoffs (explicit, not silently possible), 6. Composing Transaction/Lease (+4 more)

### Community 79 - "Design — Sprint 2: Transaction/Lease"
Cohesion: 0.18
Nodes (10): 0. Package layout, 1. `withTransaction`, 2. The transaction-handle registry (the one new design decision this sprint makes), 3. Lease acquisition, release, and timeout, 3a. `raceAgainstAbort` — the real mid-wait cancellation `acquireLease`/`tryAcquireLease` need, 4. Wiring `PgTemporalKV`'s `opts.tx`, 5. Error translation additions (`src/postgres/errors.ts`), 6. Test infrastructure (+2 more)

### Community 80 - "ADDED Requirements"
Cohesion: 0.18
Nodes (10): ADDED Requirements, checkpoint-store (implementation), Requirement: load and history read a consistent snapshot immune to a concurrently-committing prune, Requirement: load rejects a manifest whose recorded chunk-hash sequence was tampered with, even when every chunk individually verifies, Requirement: load rejects a structurally-corrupt manifest with ManifestCorruptError, Requirement: save rejects invalid options with ValidationError before any chunking or hashing work, Scenario: A chunkSize above the schema's 16 MiB bound is rejected with no work done, Scenario: A manifest whose chunk-hash sequence was substituted is rejected even though every referenced chunk verifies and positions are dense (+2 more)

### Community 81 - "explore.md"
Cohesion: 0.20
Nodes (9): Check for context, Ending Discovery, Guardrails, OpenSpec Awareness, The Stance, What You Don't Have To Do, What You Might Do, When a change exists (+1 more)

### Community 82 - "Requirement: A caller-supplied transaction handle is honored or rejected, never silently ignored"
Cohesion: 0.20
Nodes (9): ADDED Requirements, MODIFIED Requirements, Requirement: A caller-supplied transaction handle is honored or rejected, never silently ignored, Requirement: TransactionKeyReuseError is now reachable through the public put() API, Scenario: A stale transaction handle is rejected before any query runs, Scenario: Two puts inside one withTransaction both commit together, Scenario: Two puts inside one withTransaction either both commit or neither does, Scenario: Two puts to the same key inside one transaction reject and roll back together, through the public API (+1 more)

### Community 83 - "Design — Sprint 1: project setup + TemporalKV"
Cohesion: 0.22
Nodes (8): 0. Schema naming, now that UmbraDB is standalone, 1. Package layout, 2. Migration mechanism, 3. Connection factory (`src/postgres/client.ts`), 4. `PgTemporalKV` adapter (`src/postgres/temporal-kv.ts`), 4a. Error translation (`src/postgres/errors.ts`), 5. Test infrastructure, Design — Sprint 1: project setup + TemporalKV

### Community 84 - "UmbraDB"
Cohesion: 0.22
Nodes (9): Architecture, Design, Formal verification, Getting started, Layout, License, Status, UmbraDB (+1 more)

### Community 85 - "Roadmap"
Cohesion: 0.22
Nodes (9): 1.0.0 acceptance checklist, Milestone 0 — Design (completed baseline), Milestone 1 — Formal (`Formal/`, in progress), Milestone 2 — Core implementation (module implementations complete), Milestone 3 — Testing (current), Milestone 4 — Performance (`Performance/`), Milestone 5 — Cutover, Non-goals (+1 more)

### Community 86 - "README.md"
Cohesion: 0.25
Nodes (5): Impact, Proposal — Postgres+JSONB storage rebuild (remove the MongoDB dependency), What changes, Why, OpenSpec Change

### Community 87 - "ROADMAP.md"
Cohesion: 0.25
Nodes (5): For historical reference only, Phase → current status map, Tasks — superseded by per-sprint openspec changes, Custom Node/TypeScript Benchmark Harness, Performance

### Community 88 - "Storage Algebra Lean M3a Watermarks Sprint"
Cohesion: 0.25
Nodes (7): Adversarial examples, Audited semantic decisions, Explicit non-goals, Source layout, Storage Algebra Lean M3a Watermarks Sprint, Theorem gate, Verification matrix

### Community 89 - "Tasks — Sprint 3: CheckpointStore"
Cohesion: 0.25
Nodes (7): 0. Preconditions and schema, 1. Chunking and write path, 2. Read path, 3. GC (`prune`), 4. Property tests (`Formal/STORAGE_ALGEBRA.md` §5), 5. Sprint close-out, Tasks — Sprint 3: CheckpointStore

### Community 90 - "Tasks — Sprint 4: Watermarks"
Cohesion: 0.25
Nodes (7): 0. Schema, 1. `set`, 2. `get`, 3. Cancellation and errors, 4. Property test (`Formal/STORAGE_ALGEBRA.md` §5), 5. Sprint close-out, Tasks — Sprint 4: Watermarks

### Community 91 - "Design — Sprint 5: Lean M3a Watermarks W1"
Cohesion: 0.29
Nodes (6): 1. Executable carrier, 2. Commands and interpretation, 3. Laws, 4. Trust and reachability, 5. Refinement boundary, Design — Sprint 5: Lean M3a Watermarks W1

### Community 92 - "Performance — design"
Cohesion: 0.29
Nodes (6): 1. Postgres-side profiling, 2. Node-side query correlation, 3. GC architecture (the load-bearing decision), 4. Benchmark harness, 5. Activity logging, Performance — design

### Community 93 - "temporal-kv.test.ts"
Cohesion: 0.22
Nodes (3): ValidationError, FAKE_TX, { sql: getSql }

### Community 94 - "1. Shared Conventions"
Cohesion: 0.33
Nodes (6): 1.1 Error handling — one idiom: thrown, `code`-discriminated typed errors, 1.2 Async pattern, 1.3 Transaction participation, 1.4 Runtime validation, 1.5 Naming, 1. Shared Conventions

### Community 95 - "Proposal — Sprint 1: project setup + TemporalKV"
Cohesion: 0.33
Nodes (5): Impact, Non-goals (explicitly out of scope for this sprint), Proposal — Sprint 1: project setup + TemporalKV, What changes, Why

### Community 96 - "Proposal — Sprint 2: Transaction/Lease"
Cohesion: 0.33
Nodes (5): Impact, Non-goals (explicitly out of scope for this sprint), Proposal — Sprint 2: Transaction/Lease, What changes, Why

### Community 97 - "Tasks — Sprint 2: Transaction/Lease"
Cohesion: 0.33
Nodes (5): 0. `PgTransactionLeaseLayer` — transactions, 1. `PgTransactionLeaseLayer` — leases, 2. Wire `PgTemporalKV`'s `opts.tx`, 3. Sprint close-out, Tasks — Sprint 2: Transaction/Lease

### Community 98 - "Proposal — Sprint 3: CheckpointStore"
Cohesion: 0.33
Nodes (5): Impact, Non-goals (explicitly out of scope for this sprint), Proposal — Sprint 3: CheckpointStore, What changes, Why

### Community 99 - "Proposal — Sprint 4: Watermarks"
Cohesion: 0.33
Nodes (5): Impact, Non-goals (explicitly out of scope for this sprint), Proposal — Sprint 4: Watermarks, What changes, Why

### Community 100 - "Proposal — Sprint 5: Lean M3a Watermarks W1"
Cohesion: 0.33
Nodes (5): Impact, Non-goals, Proposal — Sprint 5: Lean M3a Watermarks W1, What changes, Why

### Community 101 - "Tasks — Sprint 5: Lean M3a Watermarks W1"
Cohesion: 0.33
Nodes (5): 0. Specification freeze, 1. Executable Watermarks model, 2. W1 theorem tranche, 3. Close-out, Tasks — Sprint 5: Lean M3a Watermarks W1

### Community 102 - "Storage Layer Interface Specification"
Cohesion: 0.40
Nodes (5): 2. `storage-errors.ts` — shared base (new file), 4. Composition with `WalletStateStore` / `PrivateStateProvider`, 5. Documentation-Generation Tooling, Review notes, Storage Layer Interface Specification

### Community 103 - "3. Module Interfaces"
Cohesion: 0.40
Nodes (5): 3.1 Transaction/Lease layer, 3.2 TemporalKV, 3.3 CheckpointStore, 3.4 Watermarks, 3. Module Interfaces

### Community 104 - "Tasks — Sprint 1: project setup + TemporalKV"
Cohesion: 0.40
Nodes (4): 0. Project setup, 1. TemporalKV, 2. Sprint close-out, Tasks — Sprint 1: project setup + TemporalKV

### Community 105 - "Requirement: Checkpoint sequence numbers are gapless, monotonic, and scoped per wallet+network"
Cohesion: 0.40
Nodes (5): Requirement: Checkpoint sequence numbers are gapless, monotonic, and scoped per wallet+network, Scenario: A rolled-back save consumes no sequence number, Scenario: Concurrent saves for one wallet+network still produce a gapless, non-repeating sequence, Scenario: Different wallet+network pairs have independent sequence counters, Scenario: Sequential saves for one wallet+network produce consecutive sequence numbers

### Community 106 - "Requirement: load and history distinguish "no checkpoint" from "checkpoint exists elsewhere""
Cohesion: 0.40
Nodes (5): Requirement: load and history distinguish "no checkpoint" from "checkpoint exists elsewhere", Scenario: history for a wallet+network with no checkpoints resolves empty, Scenario: No checkpoint exists for the wallet+network at all, Scenario: Omitting sequence loads the latest checkpoint, Scenario: The wallet+network has checkpoints but not at the requested sequence

### Community 107 - "GC architecture and query-tracing: research findings"
Cohesion: 0.40
Nodes (4): Decision: GC architecture, Decision: query tracing, GC architecture and query-tracing: research findings, What was checked and found NOT to hold up (excluded from the above)

### Community 108 - "Requirement: load always fully verifies chunk integrity before returning"
Cohesion: 0.50
Nodes (4): Requirement: load always fully verifies chunk integrity before returning, Scenario: A checkpoint whose stored chunk content matches its recorded hash loads successfully, Scenario: A chunk whose stored content no longer matches its recorded hash is rejected, Scenario: A manifest referencing a chunk absent from storage is rejected

### Community 109 - "Requirement: prune rejects a retainCount that is not a positive safe integer, before any deletion runs"
Cohesion: 0.50
Nodes (4): Requirement: prune rejects a retainCount that is not a positive safe integer, before any deletion runs, Scenario: A non-integer or non-finite retainCount is rejected with no effect, Scenario: An integer retainCount outside the safe integer range is rejected with no effect, Scenario: retainCount of zero is rejected with no effect

### Community 110 - "ADDED Requirements"
Cohesion: 0.12
Nodes (16): ADDED Requirements, formal-checkpoint-c1, Requirement: C1 remains a save-only abstract projection, Requirement: Chunk identities form an unconditional finite join projection, Requirement: Chunk-map merge preserves existing bytes, Requirement: Collision freedom is an explicit local theorem premise, Requirement: Compatible chunk maps satisfy conditional C1 commutation, Requirement: Saving identity inputs is extensive, repeat-idempotent, and order-independent (+8 more)

### Community 111 - "Requirement: A chunk still referenced by any surviving manifest is never reclaimed (Law C2a)"
Cohesion: 0.67
Nodes (3): Requirement: A chunk still referenced by any surviving manifest is never reclaimed (Law C2a), Scenario: A chunk shared across wallets survives one wallet's prune, Scenario: Interleaved save and prune never orphans a live manifest's chunk

### Community 112 - "Requirement: A manifest preserves the exact order and multiplicity of its chunks, including repeats"
Cohesion: 0.67
Nodes (3): Requirement: A manifest preserves the exact order and multiplicity of its chunks, including repeats, Scenario: A manifest's chunks are read back in position order regardless of storage order, Scenario: A payload containing a repeated chunk round-trips correctly

### Community 113 - "Requirement: An already-aborted opts.signal rejects before any database work; a signal aborting after the call has begun has no effect"
Cohesion: 0.67
Nodes (3): Requirement: An already-aborted opts.signal rejects before any database work; a signal aborting after the call has begun has no effect, Scenario: A call with an already-aborted signal is rejected before any database work, Scenario: A signal aborting after the call has begun does not interrupt it

### Community 114 - "Requirement: Checkpoint payloads are split into fixed-size chunks with a correctly-sized remainder"
Cohesion: 0.67
Nodes (3): Requirement: Checkpoint payloads are split into fixed-size chunks with a correctly-sized remainder, Scenario: A payload smaller than one chunk produces exactly one chunk, Scenario: A payload whose length is not a multiple of the chunk size produces a correctly-sized final chunk

### Community 115 - "Requirement: CheckpointSummary metadata is populated and label round-trips"
Cohesion: 0.67
Nodes (3): Requirement: CheckpointSummary metadata is populated and label round-trips, Scenario: A label given at save time is returned by history and load, Scenario: byteLength, chunkCount, and createdAt reflect the saved payload

### Community 116 - "Requirement: Chunk reclamation respects the grace window, protecting against re-reference races"
Cohesion: 0.67
Nodes (3): Requirement: Chunk reclamation respects the grace window, protecting against re-reference races, Scenario: A newly unreferenced chunk within the grace window is not reclaimed, Scenario: An unreferenced chunk past the grace window is eventually reclaimed

### Community 117 - "Requirement: Chunk storage is content-addressed and globally deduplicated"
Cohesion: 0.67
Nodes (3): Requirement: Chunk storage is content-addressed and globally deduplicated, Scenario: Identical chunk content across different checkpoints is stored once, Scenario: Re-referencing an existing chunk refreshes its GC clock

### Community 118 - "Requirement: history is newest-first, scoped per wallet+network, and supports cursor paging with no gap or duplicate"
Cohesion: 0.67
Nodes (3): Requirement: history is newest-first, scoped per wallet+network, and supports cursor paging with no gap or duplicate, Scenario: History for one wallet+network never includes another's checkpoints, Scenario: Paging with before continues without gap or duplicate

### Community 119 - "Requirement: manifestHash is computed once at write time from the ordered chunk-hash sequence"
Cohesion: 0.67
Nodes (3): Requirement: manifestHash is computed once at write time from the ordered chunk-hash sequence, Scenario: Identical payloads saved as separate checkpoints report the same manifestHash, Scenario: Payloads differing only in chunk order report different manifestHash

### Community 120 - "Requirement: prune retains exactly the N newest complete manifests per wallet+network"
Cohesion: 0.67
Nodes (3): Requirement: prune retains exactly the N newest complete manifests per wallet+network, Scenario: Pruning to retain k newest keeps exactly those k, Scenario: Pruning to retain the single newest manifest keeps only it

### Community 125 - "Storage Algebra Lean M3b CheckpointStore C1 Sprint"
Cohesion: 0.22
Nodes (8): Adversarial examples, Audited semantic decisions, Compatible-map theorem gate, Explicit non-goals, Identity-projection theorem gate, Source layout, Storage Algebra Lean M3b CheckpointStore C1 Sprint, Verification matrix

### Community 126 - "Design — Sprint 6: Lean M3b CheckpointStore C1"
Cohesion: 0.29
Nodes (6): 1. Finite identity projection, 2. Finite byte-bearing maps, 3. Collision premise bridge, 4. Laws and trust boundary, 5. Refinement boundary, Design — Sprint 6: Lean M3b CheckpointStore C1

### Community 127 - "Proposal — Sprint 6: Lean M3b CheckpointStore C1"
Cohesion: 0.33
Nodes (5): Impact, Non-goals, Proposal — Sprint 6: Lean M3b CheckpointStore C1, What changes, Why

### Community 128 - "Tasks — Sprint 6: Lean M3b CheckpointStore C1"
Cohesion: 0.33
Nodes (5): 0. Specification freeze, 1. Chunk-identity projection, 2. Compatible chunk maps, 3. Close-out, Tasks — Sprint 6: Lean M3b CheckpointStore C1

## Knowledge Gaps
- **551 isolated node(s):** `name`, `version`, `private`, `type`, `node` (+546 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **50 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Storage Algebra Lean Formalization — Approved Design and Status` connect `Storage Algebra Lean Formalization — Approved Design and Status` to `Design — Postgres+JSONB storage rebuild`?**
  _High betweenness centrality (0.008) - this node is a cross-community bridge._
- **Why does `TransactionHandle` connect `temporal-kv.ts` to `transaction-lease.ts`, `watermarks.ts`, `transaction-lease.ts`, `watermarks.test.ts`, `temporal-kv.test.ts`?**
  _High betweenness centrality (0.007) - this node is a cross-community bridge._
- **Why does `Storage Layer Interface Specification` connect `Storage Layer Interface Specification` to `1. Shared Conventions`, `README.md`, `3. Module Interfaces`?**
  _High betweenness centrality (0.006) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _551 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `checkpoint-store.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.07199032062915911 - nodes in this community are weakly interconnected._
- **Should `transaction-lease.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.11384615384615385 - nodes in this community are weakly interconnected._
- **Should `temporal-kv.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.08717948717948718 - nodes in this community are weakly interconnected._