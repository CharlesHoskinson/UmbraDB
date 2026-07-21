# Graph Report - .  (2026-07-21)

## Corpus Check
- 76 files · ~112,004 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 508 nodes · 1093 edges · 26 communities (25 shown, 1 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 17 edges (avg confidence: 0.85)
- Token cost: 0 input · 440,350 output

## Community Hubs (Navigation)
- CheckpointStore Module
- Transaction & Lease Layer
- TemporalKV Module
- Project Design & Formal Spec Overview
- Storage Errors & Migrations
- Postgres Client & Test Infrastructure
- Project Dependencies & Tooling
- Watermarks Module
- OpenSpec/opsx Workflow Commands
- Storage Layer Interface Design Rationale
- TypeScript Compiler Config
- Sprint 1 (TemporalKV) Design Rationale
- Sprint 4 (Watermarks) Design Rationale
- Sprint 2-3 Cross-Cutting Design Fixes
- Sprint 3 (CheckpointStore) Spec Requirements
- Sprint 3 (CheckpointStore) Design Rationale
- Sprint 4 (Watermarks) Spec Requirements
- Sprint 2 (Transaction/Lease) Spec Requirements
- Sprint 1 (TemporalKV) Spec Requirements
- Retired Task Map & OpenSpec Config
- Transaction Handle Reuse Across Sprints
- Migration Concurrency & Advisory Locks
- TemporalKV put()/CAS Design Thread
- Sprint 2 Close-out & Cursor Design
- Sprint 3 & 4 Close-out
- OpenSpec Store Concept

## God Nodes (most connected - your core abstractions)
1. `TransactionHandle` - 22 edges
2. `UmbraDBSql` - 21 edges
3. `translatePostgresError()` - 21 edges
4. `Design — Postgres+JSONB storage rebuild` - 21 edges
5. `checkpoint-store (implementation) spec` - 18 edges
6. `resolveTransaction()` - 17 edges
7. `withAbort()` - 16 edges
8. `Storage Layer Interface Specification` - 16 edges
9. `StorageError` - 15 edges
10. `ValidationError` - 15 edges

## Surprising Connections (you probably didn't know these)
- `UmbraDB ROADMAP` --semantically_similar_to--> `Lean 4 Formalization Plan`  [INFERRED] [semantically similar]
  ROADMAP.md → Formal/LEAN_FORMALIZATION_PLAN.md
- `Correctness rule: verify external claims against real source` --rationale_for--> `kv_current/kv_history temporal-table design`  [INFERRED]
  openspec/config.yaml → design/design.md
- `startTestDatabase()` --calls--> `runMigrations()`  [EXTRACTED]
  test/postgres/setup.ts → src/postgres/migrate.ts
- `UmbraDB CLAUDE.md Project Instructions` --references--> `UmbraDB ROADMAP`  [EXTRACTED]
  CLAUDE.md → ROADMAP.md
- `UmbraDB README` --references--> `STORAGE_ALGEBRA.md — Algebraic Specification`  [INFERRED]
  README.md → Formal/STORAGE_ALGEBRA.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Shared 'Store Selection' Convention Across All OpenSpec Commands/Skills** — claude_commands_opsx_apply, claude_commands_opsx_archive, claude_commands_opsx_explore, claude_commands_opsx_propose, claude_commands_opsx_sync, claude_commands_opsx_update, claude_skills_openspec_apply_change_skill, claude_skills_openspec_archive_change_skill, claude_skills_openspec_explore_skill, claude_skills_openspec_propose_skill, claude_skills_openspec_sync_specs_skill, claude_skills_openspec_update_change_skill, openspec_store_concept [EXTRACTED 1.00]
- **The Nine Laws Forming UmbraDB's Storage Algebra** — formal_storage_algebra_law_t1, formal_storage_algebra_law_t2, formal_storage_algebra_law_t3, formal_storage_algebra_law_t4, formal_storage_algebra_law_t5, formal_storage_algebra_law_c1, formal_storage_algebra_law_c2, formal_storage_algebra_law_w1, formal_storage_algebra_law_l1 [EXTRACTED 1.00]
- **Multi-Round Cross-Vendor Review Pipeline (Opus Panel + Fable 5 + Codex GPT-5.6 Sol Audit)** — roadmap, formal_storage_algebra, performance_gc_and_tracing_research, design_design_algebra [INFERRED 0.85]
- **Four storage modules unified under StorageError hierarchy** — design_design_interfaces_storageerror, design_design_interfaces_temporalkv, design_design_interfaces_checkpointstore, design_design_interfaces_watermarks, design_design_interfaces_transactionleaselayer_stale [EXTRACTED 1.00]
- **Modules composing the Sprint 2 transaction-handle registry** — sprint2_design_transaction_handle_registry, sprint1_design_pgtemporalkv_put, sprint3_design_torn_read_fix, sprint4_design_composing_txlease [EXTRACTED 1.00]
- **Pre-check-only withAbort cancellation pattern across sprints** — sprint1_design_listkeys_cursor, sprint2_design_withtransaction, sprint3_design_cancellation_scope_decision, sprint4_design_cancellation [INFERRED 0.85]

## Communities (26 total, 1 thin omitted)

### Community 0 - "CheckpointStore Module"
Cohesion: 0.07
Nodes (30): STORAGE_TYPES.md — Type Reference for Formalization, CheckpointNotFoundError, CheckpointRecord, CheckpointSequence, CheckpointStore, CheckpointStoreError, CheckpointStoreErrorCode, CheckpointSummary (+22 more)

### Community 1 - "Transaction & Lease Layer"
Cohesion: 0.08
Nodes (32): Lease, LeaseAcquireOptions, LeaseAcquireOptionsSchema, LeaseFaultError, LeaseNotHeldError, LeaseTimeoutError, Rollback, TransactionFaultError (+24 more)

### Community 2 - "TemporalKV Module"
Cohesion: 0.11
Nodes (29): AsOf, AssertExact, ExpectedVersionSchema, hasPostgresUnsafeText(), HistoryUnavailableError, JsonValue, jsonValueHasUnsafeText(), Key (+21 more)

### Community 3 - "Project Design & Formal Spec Overview"
Cohesion: 0.07
Nodes (44): UmbraDB CLAUDE.md Project Instructions, Keep-Knowledge-Graph-Current Policy, Design — Postgres+JSONB storage rebuild, design-algebra.md (Superseded), FerretDB Mongo-compatibility shim evaluated and rejected, State-equivalence merge-blocker gate, Testcontainers vs pg-mem test-infrastructure decision, Proposal — Postgres+JSONB storage rebuild (+36 more)

### Community 4 - "Storage Errors & Migrations"
Cohesion: 0.09
Nodes (20): ConnectionError, SerializationFailedError, SharedStorageErrorCode, StorageError, ValidationError, assertValidSchemaName(), ClockRegressionError, CONNECTION_FAILURE_CODES (+12 more)

### Community 5 - "Postgres Client & Test Infrastructure"
Cohesion: 0.09
Nodes (13): assertNoConflictingSearchPath(), createClient(), UmbraDBConnectionOptions, UmbraDBSql, { sql: getSql }, registerSuiteLifecycle(), startTestDatabase(), stopTestDatabase() (+5 more)

### Community 6 - "Project Dependencies & Tooling"
Cohesion: 0.07
Nodes (29): fast-check, dependencies, postgres, zod, devDependencies, fast-check, @testcontainers/postgresql, typedoc (+21 more)

### Community 7 - "Watermarks Module"
Cohesion: 0.18
Nodes (12): RFC-8259, JsonValueSchema, WatermarkKey, WatermarkKind, Watermarks, WatermarkValue, WatermarkValueSchema, resolveTransaction() (+4 more)

### Community 8 - "OpenSpec/opsx Workflow Commands"
Cohesion: 0.27
Nodes (18): OPSX Apply Command, OPSX Archive Command, OPSX Explore Command, OPSX Propose Command, OPSX Sync Command, OPSX Update Command, OpenSpec Apply-Change Skill, OpenSpec Archive-Change Skill (+10 more)

### Community 9 - "Storage Layer Interface Design Rationale"
Cohesion: 0.19
Nodes (15): Storage Layer Interface Specification, CheckpointNotFoundError, CheckpointStore interface, CheckpointWalletStateStore (production adapter), Global cross-wallet chunk GC reclamation fix, Throw-typed-error idiom unification across modules, PrivateStateProvider (SDK-mandated interface), StorageError shared base class (+7 more)

### Community 10 - "TypeScript Compiler Config"
Cohesion: 0.14
Nodes (13): src/**/*.ts, test/**/*.ts, compilerOptions, declaration, esModuleInterop, module, moduleResolution, noEmit (+5 more)

### Community 11 - "Sprint 1 (TemporalKV) Design Rationale"
Cohesion: 0.18
Nodes (13): kv_history retention policy (pg_cron), postgres.js driver choice, kv_current/kv_history temporal-table design, Tier 1 / Tier 2 Postgres schema split, TransactionKeyReuseError / txid_current() fix, Design — Sprint 1: project setup + TemporalKV, createClient connection factory (bigint/max fixes), Postgres error → StorageError translation table (+5 more)

### Community 12 - "Sprint 4 (Watermarks) Design Rationale"
Cohesion: 0.20
Nodes (12): watermarks table schema sketch, Design — Sprint 4: Watermarks, Proposal — Sprint 4: Watermarks, prune retainCount validation requirement, Watermarks accepted tradeoffs (opaque jsonb, no history), Watermarks pre-check-only cancellation, watermarks table fillfactor=90 HOT-update tuning, PgWatermarks.get implementation (+4 more)

### Community 13 - "Sprint 2-3 Cross-Cutting Design Fixes"
Cohesion: 0.18
Nodes (12): Design — Sprint 3: CheckpointStore, withTransaction (sql.begin) implementation, Aborting opts.signal pre-check-only contract (withTransaction), CheckpointStore cancellation scope decision (pre-check only), complete flag explicit-write requirement, history pagination query, load full chunk-integrity + manifest verification, manifest_hash tamper-detection verification (+4 more)

### Community 14 - "Sprint 3 (CheckpointStore) Spec Requirements"
Cohesion: 0.17
Nodes (12): checkpoint-store (implementation) spec, Fixed-size chunk splitting requirement, Content-addressed global chunk dedup requirement, history cursor paging no-gap/no-duplicate requirement, load always fully verifies chunk integrity, ManifestCorruptError position-gap requirement, manifestHash computed once at write time, ManifestCorruptError chunk-hash-sequence tamper requirement (+4 more)

### Community 15 - "Sprint 3 (CheckpointStore) Design Rationale"
Cohesion: 0.20
Nodes (11): Content-addressed checkpoint chunker, ckpt_manifest_chunks junction table (original, later corrected), Retired 11-phase task plan, Proposal — Sprint 3: CheckpointStore, save() fixed-size chunking algorithm, ckpt_manifest_chunks position + ON DELETE CASCADE fix, ckpt_sequence_counters atomic upsert-increment allocator, Sprint 3 schema changes (position/cascade, seq, metadata cols) (+3 more)

### Community 16 - "Sprint 4 (Watermarks) Spec Requirements"
Cohesion: 0.22
Nodes (10): Watermarks interface, watermarks (implementation) spec, Large-integer decimal-string cursor convention, Watermarks AbortSignal pre-check-only requirement, Watermarks Postgres errors surface as StorageError requirement, get never throws for an unset cursor requirement, get returns last value scoped per (kind,key) requirement, Non-object JSON value round-trip requirement (+2 more)

### Community 17 - "Sprint 2 (Transaction/Lease) Spec Requirements"
Cohesion: 0.22
Nodes (10): Postgres advisory-lock writer lease (corrected design), transaction-lease (implementation) spec, Transactions commit or roll back atomically, Connection loss surfaces as LeaseFaultError, Resolved transaction handle always refers to its own live transaction, Law L1: at most one holder per lease key, Lease timeout distinct for acquireLease vs tryAcquireLease, releaseLease rejects a lease that is not currently held (+2 more)

### Community 18 - "Sprint 1 (TemporalKV) Spec Requirements"
Cohesion: 0.22
Nodes (9): temporal-kv (implementation) — Sprint 1 spec, Postgres errors surface as StorageError hierarchy requirement, Law T1: gapless monotonic versions requirement, Law T3: temporal-projection equivalence (getAt), Law T4: dual addressing agreement, Law T5: history intervals never overlap, listKeys streaming/order requirement, Migrations idempotent and ordered requirement (+1 more)

### Community 19 - "Retired Task Map & OpenSpec Config"
Cohesion: 0.25
Nodes (8): Tasks — superseded by per-sprint openspec changes, Phase → sprint status map, Tasks — Sprint 1: project setup + TemporalKV, Proposal — Sprint 2: Transaction/Lease, OpenSpec project config (spec-driven schema), Correctness rule: verify external claims against real source, Sprint 1 close-out / differential review, Sprint 2 scope: Transaction/Lease implementation

### Community 20 - "Transaction Handle Reuse Across Sprints"
Cohesion: 0.29
Nodes (8): temporal-kv (transaction-participation wiring) spec, Transaction-key-reuse rejected at trigger level, Transaction handle rejected (Sprint 1, later superseded), Transaction-handle registry (resolveTransaction), TransactionKeyReuseError reachable via public put() API, Transaction handle honored (MODIFIED, supersedes Sprint 1), Watermarks composing Transaction/Lease via opts.tx, Watermarks transaction handle honored requirement

### Community 21 - "Migration Concurrency & Advisory Locks"
Cohesion: 0.38
Nodes (7): Advisory-lock class registry (classes 1/2/3), Design — Sprint 2: Transaction/Lease, temporal-kv Specification (archived baseline), Migration runner advisory lock (class 1), acquireLease/tryAcquireLease timeout mechanism, Nested withTransaction unsupported (disclosed limitation), reserveBounded connection-reservation cancellation

### Community 22 - "TemporalKV put()/CAS Design Thread"
Cohesion: 0.33
Nodes (7): TemporalKV interface, VersionConflictError, Proposal — Sprint 1: project setup + TemporalKV, PgTemporalKV.put three-statement-shape design, Sprint 1 scope: project setup + TemporalKV, CAS guard distinguishes conflict from absence, PgWatermarks.set upsert implementation

### Community 23 - "Sprint 2 Close-out & Cursor Design"
Cohesion: 0.50
Nodes (4): Tasks — Sprint 2: Transaction/Lease, listKeys cursor streaming + prefix escaping, raceAgainstAbort mid-wait cancellation, Sprint 2 close-out / two-round audit findings

### Community 24 - "Sprint 3 & 4 Close-out"
Cohesion: 0.50
Nodes (4): Tasks — Sprint 3: CheckpointStore, Tasks — Sprint 4: Watermarks, Sprint 3 close-out / graphify update task, Sprint 4 close-out / Milestone 2 completion

## Knowledge Gaps
- **108 isolated node(s):** `name`, `version`, `private`, `type`, `node` (+103 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `STORAGE_TYPES.md — Type Reference for Formalization` connect `CheckpointStore Module` to `Transaction & Lease Layer`, `TemporalKV Module`, `Project Design & Formal Spec Overview`, `Watermarks Module`?**
  _High betweenness centrality (0.375) - this node is a cross-community bridge._
- **Why does `STORAGE_ALGEBRA.md — Algebraic Specification` connect `Project Design & Formal Spec Overview` to `CheckpointStore Module`?**
  _High betweenness centrality (0.328) - this node is a cross-community bridge._
- **Why does `Design — Postgres+JSONB storage rebuild` connect `Project Design & Formal Spec Overview` to `Storage Layer Interface Design Rationale`, `Sprint 1 (TemporalKV) Design Rationale`, `Sprint 4 (Watermarks) Design Rationale`, `Sprint 3 (CheckpointStore) Design Rationale`, `Sprint 2 (Transaction/Lease) Spec Requirements`, `Retired Task Map & OpenSpec Config`, `Migration Concurrency & Advisory Locks`?**
  _High betweenness centrality (0.237) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _108 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `CheckpointStore Module` be split into smaller, more focused modules?**
  _Cohesion score 0.0701344243132671 - nodes in this community are weakly interconnected._
- **Should `Transaction & Lease Layer` be split into smaller, more focused modules?**
  _Cohesion score 0.08446455505279035 - nodes in this community are weakly interconnected._
- **Should `TemporalKV Module` be split into smaller, more focused modules?**
  _Cohesion score 0.10901960784313726 - nodes in this community are weakly interconnected._