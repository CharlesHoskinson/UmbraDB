# Graph Report - UmbraDB-harness-graphify  (2026-07-21)

## Corpus Check
- 76 files · ~118,030 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 517 nodes · 1101 edges · 19 communities (18 shown, 1 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 17 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `418bc100`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- postgres/checkpoint-store.ts
- postgres/transaction-lease.ts
- postgres/temporal-kv.ts
- Lean 4 Formalization Plan
- temporal-kv.test.ts
- scoped-review-manifest
- package.json
- postgres/watermarks.ts
- OpenSpec CLI
- Storage Layer Interface Specification
- compilerOptions
- Design — Postgres+JSONB storage rebuild
- Design — Sprint 1: project setup + TemporalKV
- checkpoint-store (implementation) spec
- Design — Sprint 3: CheckpointStore
- transaction-lease (implementation) spec
- temporal-kv (implementation) — Sprint 1 spec
- Design — Sprint 2: Transaction/Lease
- OpenSpec Store

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
- `GC Architecture Decision (Junction Table over GIN Array)` --references--> `Design — Postgres+JSONB storage rebuild`  [EXTRACTED]
  Performance/DESIGN.md → design/design.md
- `Correctness rule: verify external claims against real source` --rationale_for--> `kv_current/kv_history temporal-table design`  [INFERRED]
  openspec/config.yaml → design/design.md
- `getAt single-statement UNION ALL race fix` --references--> `kv_current/kv_history temporal-table design`  [EXTRACTED]
  openspec/changes/archive/2026-07-21-sprint-1-setup-and-temporal-kv/design.md → design/design.md
- `Migrations as TypeScript functions (schema-configurability fix)` --references--> `kv_current/kv_history temporal-table design`  [EXTRACTED]
  openspec/changes/archive/2026-07-21-sprint-1-setup-and-temporal-kv/design.md → design/design.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Shared 'Store Selection' Convention Across All OpenSpec Commands/Skills** — claude_commands_opsx_apply, claude_commands_opsx_archive, claude_commands_opsx_explore, claude_commands_opsx_propose, claude_commands_opsx_sync, claude_commands_opsx_update, claude_skills_openspec_apply_change_skill, claude_skills_openspec_archive_change_skill, claude_skills_openspec_explore_skill, claude_skills_openspec_propose_skill, claude_skills_openspec_sync_specs_skill, claude_skills_openspec_update_change_skill, openspec_store_concept [EXTRACTED 1.00]
- **The Nine Laws Forming UmbraDB's Storage Algebra** — formal_storage_algebra_law_t1, formal_storage_algebra_law_t2, formal_storage_algebra_law_t3, formal_storage_algebra_law_t4, formal_storage_algebra_law_t5, formal_storage_algebra_law_c1, formal_storage_algebra_law_c2, formal_storage_algebra_law_w1, formal_storage_algebra_law_l1 [EXTRACTED 1.00]
- **Multi-Round Cross-Vendor Review Pipeline (Opus Panel + Fable 5 + Codex GPT-5.6 Sol Audit)** — roadmap, formal_storage_algebra, performance_gc_and_tracing_research, design_design_algebra [INFERRED 0.85]
- **Four storage modules unified under StorageError hierarchy** — design_design_interfaces_storageerror, design_design_interfaces_temporalkv, design_design_interfaces_checkpointstore, design_design_interfaces_watermarks, design_design_interfaces_transactionleaselayer_stale [EXTRACTED 1.00]
- **Modules composing the Sprint 2 transaction-handle registry** — sprint2_design_transaction_handle_registry, sprint1_design_pgtemporalkv_put, sprint3_design_torn_read_fix, sprint4_design_composing_txlease [EXTRACTED 1.00]
- **Pre-check-only withAbort cancellation pattern across sprints** — sprint1_design_listkeys_cursor, sprint2_design_withtransaction, sprint3_design_cancellation_scope_decision, sprint4_design_cancellation [INFERRED 0.85]

## Communities (19 total, 1 thin omitted)

### Community 0 - "postgres/checkpoint-store.ts"
Cohesion: 0.07
Nodes (30): STORAGE_TYPES.md — Type Reference for Formalization, CheckpointNotFoundError, CheckpointRecord, CheckpointSequence, CheckpointStore, CheckpointStoreError, CheckpointStoreErrorCode, CheckpointSummary (+22 more)

### Community 1 - "postgres/transaction-lease.ts"
Cohesion: 0.08
Nodes (32): Lease, LeaseAcquireOptions, LeaseAcquireOptionsSchema, LeaseFaultError, LeaseNotHeldError, LeaseTimeoutError, Rollback, TransactionFaultError (+24 more)

### Community 2 - "postgres/temporal-kv.ts"
Cohesion: 0.12
Nodes (28): AsOf, AssertExact, ExpectedVersionSchema, hasPostgresUnsafeText(), HistoryUnavailableError, JsonValue, jsonValueHasUnsafeText(), JsonValueSchema (+20 more)

### Community 3 - "Lean 4 Formalization Plan"
Cohesion: 0.08
Nodes (37): UmbraDB CLAUDE.md Project Instructions, Keep-Knowledge-Graph-Current Policy, design-algebra.md (Superseded), Lean 4 Formalization Plan, crdt-lean Dependency Refutation, Abstract-Model-First Scope Decision, STORAGE_ALGEBRA.md — Algebraic Specification, CheckpointStore Algebra (+29 more)

### Community 4 - "temporal-kv.test.ts"
Cohesion: 0.06
Nodes (32): ConnectionError, SerializationFailedError, SharedStorageErrorCode, StorageError, ValidationError, assertNoConflictingSearchPath(), assertValidSchemaName(), createClient() (+24 more)

### Community 5 - "scoped-review-manifest"
Cohesion: 0.22
Nodes (8): Cleanup, scoped-review-manifest, Step 0 — Skip check, Step 1 — Freshness gate, Step 2 — Changed-file seed set, Step 3 — Blast-radius computation, Step 4 — Write the manifest, Step 5 — Hand off

### Community 6 - "package.json"
Cohesion: 0.07
Nodes (29): fast-check, dependencies, postgres, zod, devDependencies, fast-check, @testcontainers/postgresql, typedoc (+21 more)

### Community 7 - "postgres/watermarks.ts"
Cohesion: 0.14
Nodes (14): RFC-8259, TemporalKV, TransactionHandle, WatermarkKey, WatermarkKind, Watermarks, WatermarkValue, WatermarkValueSchema (+6 more)

### Community 8 - "OpenSpec CLI"
Cohesion: 0.27
Nodes (18): OPSX Apply Command, OPSX Archive Command, OPSX Explore Command, OPSX Propose Command, OPSX Sync Command, OPSX Update Command, OpenSpec Apply-Change Skill, OpenSpec Archive-Change Skill (+10 more)

### Community 9 - "Storage Layer Interface Specification"
Cohesion: 0.06
Nodes (42): Storage Layer Interface Specification, CheckpointNotFoundError, CheckpointStore interface, CheckpointWalletStateStore (production adapter), Global cross-wallet chunk GC reclamation fix, Throw-typed-error idiom unification across modules, PrivateStateProvider (SDK-mandated interface), StorageError shared base class (+34 more)

### Community 10 - "compilerOptions"
Cohesion: 0.14
Nodes (13): src/**/*.ts, test/**/*.ts, compilerOptions, declaration, esModuleInterop, module, moduleResolution, noEmit (+5 more)

### Community 11 - "Design — Postgres+JSONB storage rebuild"
Cohesion: 0.17
Nodes (18): Design — Postgres+JSONB storage rebuild, Content-addressed checkpoint chunker, ckpt_manifest_chunks junction table (original, later corrected), FerretDB Mongo-compatibility shim evaluated and rejected, kv_history retention policy (pg_cron), State-equivalence merge-blocker gate, kv_current/kv_history temporal-table design, Testcontainers vs pg-mem test-infrastructure decision (+10 more)

### Community 12 - "Design — Sprint 1: project setup + TemporalKV"
Cohesion: 0.20
Nodes (10): postgres.js driver choice, Tier 1 / Tier 2 Postgres schema split, Design — Sprint 1: project setup + TemporalKV, createClient connection factory (bigint/max fixes), Postgres error → StorageError translation table, getAt single-statement UNION ALL race fix, Hand-rolled migration runner decision (no ORM), Migrations as TypeScript functions (schema-configurability fix) (+2 more)

### Community 14 - "checkpoint-store (implementation) spec"
Cohesion: 0.17
Nodes (12): checkpoint-store (implementation) spec, Fixed-size chunk splitting requirement, Content-addressed global chunk dedup requirement, history cursor paging no-gap/no-duplicate requirement, load always fully verifies chunk integrity, ManifestCorruptError position-gap requirement, manifestHash computed once at write time, ManifestCorruptError chunk-hash-sequence tamper requirement (+4 more)

### Community 15 - "Design — Sprint 3: CheckpointStore"
Cohesion: 0.18
Nodes (12): Design — Sprint 3: CheckpointStore, Proposal — Sprint 3: CheckpointStore, complete flag explicit-write requirement, history pagination query, load full chunk-integrity + manifest verification, manifest_hash tamper-detection verification, ckpt_manifest_chunks position + ON DELETE CASCADE fix, prune two-step manifest-then-chunk GC pass (+4 more)

### Community 17 - "transaction-lease (implementation) spec"
Cohesion: 0.14
Nodes (16): transaction-lease (implementation) spec, Tasks — Sprint 2: Transaction/Lease, listKeys cursor streaming + prefix escaping, raceAgainstAbort mid-wait cancellation, Aborting opts.signal pre-check-only contract (withTransaction), Transactions commit or roll back atomically, Connection loss surfaces as LeaseFaultError, Resolved transaction handle always refers to its own live transaction (+8 more)

### Community 18 - "temporal-kv (implementation) — Sprint 1 spec"
Cohesion: 0.11
Nodes (22): TemporalKV interface, VersionConflictError, Proposal — Sprint 1: project setup + TemporalKV, temporal-kv (implementation) — Sprint 1 spec, temporal-kv (transaction-participation wiring) spec, PgTemporalKV.put three-statement-shape design, Sprint 1 scope: project setup + TemporalKV, CAS guard distinguishes conflict from absence (+14 more)

### Community 21 - "Design — Sprint 2: Transaction/Lease"
Cohesion: 0.15
Nodes (17): Advisory-lock class registry (classes 1/2/3), Postgres advisory-lock writer lease (corrected design), Phase → sprint status map, Tasks — Sprint 1: project setup + TemporalKV, Design — Sprint 2: Transaction/Lease, Proposal — Sprint 2: Transaction/Lease, temporal-kv Specification (archived baseline), Migration runner advisory lock (class 1) (+9 more)

## Knowledge Gaps
- **115 isolated node(s):** `name`, `version`, `private`, `type`, `node` (+110 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `STORAGE_TYPES.md — Type Reference for Formalization` connect `postgres/checkpoint-store.ts` to `postgres/transaction-lease.ts`, `postgres/temporal-kv.ts`, `Lean 4 Formalization Plan`, `postgres/watermarks.ts`?**
  _High betweenness centrality (0.362) - this node is a cross-community bridge._
- **Why does `STORAGE_ALGEBRA.md — Algebraic Specification` connect `Lean 4 Formalization Plan` to `postgres/checkpoint-store.ts`?**
  _High betweenness centrality (0.317) - this node is a cross-community bridge._
- **Why does `Design — Postgres+JSONB storage rebuild` connect `Design — Postgres+JSONB storage rebuild` to `Storage Layer Interface Specification`, `Lean 4 Formalization Plan`, `Design — Sprint 1: project setup + TemporalKV`, `Design — Sprint 2: Transaction/Lease`?**
  _High betweenness centrality (0.229) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _115 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `postgres/checkpoint-store.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.0701344243132671 - nodes in this community are weakly interconnected._
- **Should `postgres/transaction-lease.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.07542087542087542 - nodes in this community are weakly interconnected._
- **Should `postgres/temporal-kv.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.12077294685990338 - nodes in this community are weakly interconnected._