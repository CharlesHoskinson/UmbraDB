# Graph Report - UmbraDB-harness-merge  (2026-07-21)

## Corpus Check
- 83 files · ~128,903 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 623 nodes · 1041 edges · 69 communities (19 shown, 50 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 9 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `c4989615`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- postgres/checkpoint-store.ts
- postgres/transaction-lease.ts
- postgres/temporal-kv.ts
- postgres/watermarks.ts
- scoped-review-manifest
- Storage Algebra Lean Formalization — Approved Design and Status
- package.json
- postgres.js driver choice
- openspec-explore/SKILL.md
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
- UmbraDB
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
- temporal-kv.test.ts
- Watermarks Postgres errors surface as StorageError requirement
- get never throws for an unset cursor requirement
- get returns last value scoped per (kind,key) requirement
- private_state_salts table / per-scope salt derivation
- set ValidationError before statement requirement
- Watermarks AbortSignal pre-check-only requirement
- Top-level null value application-level guard
- complete flag explicit-write requirement
- CheckpointStore cancellation scope decision (pre-check only)
- pull_request_template.md
- AGENTS.md

## God Nodes (most connected - your core abstractions)
1. `TransactionHandle` - 22 edges
2. `UmbraDBSql` - 21 edges
3. `translatePostgresError()` - 21 edges
4. `resolveTransaction()` - 17 edges
5. `withAbort()` - 16 edges
6. `StorageError` - 15 edges
7. `ValidationError` - 15 edges
8. `PgTemporalKV` - 15 edges
9. `PgTransactionLeaseLayer` - 14 edges
10. `Storage Algebra Lean Formalization — Approved Design and Status` - 14 edges

## Surprising Connections (you probably didn't know these)
- `Correctness rule: verify external claims against real source` --rationale_for--> `kv_current/kv_history temporal-table design`  [INFERRED]
  openspec/config.yaml → design/design.md
- `getAt single-statement UNION ALL race fix` --references--> `kv_current/kv_history temporal-table design`  [EXTRACTED]
  openspec/changes/archive/2026-07-21-sprint-1-setup-and-temporal-kv/design.md → design/design.md
- `Migrations as TypeScript functions (schema-configurability fix)` --references--> `kv_current/kv_history temporal-table design`  [EXTRACTED]
  openspec/changes/archive/2026-07-21-sprint-1-setup-and-temporal-kv/design.md → design/design.md
- `save() fixed-size chunking algorithm` --references--> `Content-addressed checkpoint chunker`  [EXTRACTED]
  openspec/changes/sprint-3-checkpoint-store/design.md → design/design.md
- `Chunk reclamation grace-window requirement` --references--> `Content-addressed checkpoint chunker`  [EXTRACTED]
  openspec/changes/sprint-3-checkpoint-store/specs/checkpoint-store/spec.md → design/design.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **The Nine Laws Forming UmbraDB's Storage Algebra** — formal_storage_algebra_law_t1, formal_storage_algebra_law_t2, formal_storage_algebra_law_t3, formal_storage_algebra_law_t4, formal_storage_algebra_law_t5, formal_storage_algebra_law_c1, formal_storage_algebra_law_c2, formal_storage_algebra_law_w1, formal_storage_algebra_law_l1 [EXTRACTED 1.00]
- **Four storage modules unified under StorageError hierarchy** — design_design_interfaces_storageerror, design_design_interfaces_temporalkv, design_design_interfaces_checkpointstore, design_design_interfaces_watermarks, design_design_interfaces_transactionleaselayer_stale [EXTRACTED 1.00]
- **Modules composing the Sprint 2 transaction-handle registry** — sprint2_design_transaction_handle_registry, sprint1_design_pgtemporalkv_put, sprint3_design_torn_read_fix, sprint4_design_composing_txlease [EXTRACTED 1.00]
- **Pre-check-only withAbort cancellation pattern across sprints** — sprint1_design_listkeys_cursor, sprint2_design_withtransaction, sprint3_design_cancellation_scope_decision, sprint4_design_cancellation [INFERRED 0.85]

## Communities (69 total, 50 thin omitted)

### Community 0 - "postgres/checkpoint-store.ts"
Cohesion: 0.06
Nodes (41): CheckpointNotFoundError, CheckpointRecord, CheckpointSequence, CheckpointStore, CheckpointStoreError, CheckpointStoreErrorCode, CheckpointSummary, ChunkIntegrityError (+33 more)

### Community 1 - "postgres/transaction-lease.ts"
Cohesion: 0.07
Nodes (32): Lease, LeaseAcquireOptions, LeaseAcquireOptionsSchema, LeaseFaultError, LeaseNotHeldError, LeaseTimeoutError, Rollback, TransactionFaultError (+24 more)

### Community 2 - "postgres/temporal-kv.ts"
Cohesion: 0.12
Nodes (28): AsOf, AssertExact, ExpectedVersionSchema, hasPostgresUnsafeText(), HistoryUnavailableError, JsonValue, jsonValueHasUnsafeText(), JsonValueSchema (+20 more)

### Community 3 - "postgres/watermarks.ts"
Cohesion: 0.14
Nodes (14): RFC-8259, TemporalKV, TransactionHandle, WatermarkKey, WatermarkKind, Watermarks, WatermarkValue, WatermarkValueSchema (+6 more)

### Community 4 - "scoped-review-manifest"
Cohesion: 0.22
Nodes (8): Cleanup, scoped-review-manifest, Step 0 — Skip check, Step 1 — Freshness gate, Step 2 — Changed-file seed set, Step 3 — Blast-radius computation, Step 4 — Write the manifest, Step 5 — Hand off

### Community 5 - "Storage Algebra Lean Formalization — Approved Design and Status"
Cohesion: 0.04
Nodes (44): 10. Sprint 2 transaction/lease proposal, 11.1 Repository evidence, 11.2 External primary sources, 11. Evidence matrix, 12. Milestone status, 13. Approved implementation decisions, 1. Executive conclusion, 2.1 Historical implementation baseline (+36 more)

### Community 6 - "package.json"
Cohesion: 0.07
Nodes (29): fast-check, dependencies, postgres, zod, devDependencies, fast-check, @testcontainers/postgresql, typedoc (+21 more)

### Community 8 - "openspec-explore/SKILL.md"
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

### Community 33 - "UmbraDB"
Cohesion: 0.05
Nodes (44): Superseded — see `Formal/STORAGE_ALGEBRA.md`, crdt-lean Dependency Refutation, CheckpointStore Algebra, ckpt_manifest_chunks Junction Table, Law C1 — Join-Semilattice Chunk Writes, Law C2 — GC Reachability Closure, Law L1 — Lease Mutual Exclusion, Law T1 — Gapless Monotonicity (+36 more)

### Community 35 - "Global Constraints"
Cohesion: 0.25
Nodes (7): Global Constraints, Plan Self-Review, Storage Algebra Lean M1 Implementation Plan, Task 1: Pin the project and prove the imported API smoke slice, Task 2: Implement the executable TemporalKV history kernel, Task 3: Prove the M1 TemporalKV theorem slice, Task 4: Add reproducible trust gates and close the M1 documentation loop

### Community 57 - "temporal-kv.test.ts"
Cohesion: 0.07
Nodes (20): assertNoConflictingSearchPath(), assertValidSchemaName(), createClient(), UmbraDBConnectionOptions, UmbraDBSql, Migration, migrations, runMigrations() (+12 more)

### Community 66 - "Top-level null value application-level guard"
Cohesion: 0.67
Nodes (3): prune retainCount validation requirement, Top-level null value application-level guard, set rejects top-level null requirement

### Community 70 - "CheckpointStore cancellation scope decision (pre-check only)"
Cohesion: 0.06
Nodes (32): Advisory-lock class registry (classes 1/2/3), Module → Postgres module mapping table, Postgres advisory-lock writer lease (corrected design), CheckpointNotFoundError, CheckpointStore interface, CheckpointWalletStateStore (production adapter), Global cross-wallet chunk GC reclamation fix, WalletStateStore (project abstraction) (+24 more)

### Community 73 - "pull_request_template.md"
Cohesion: 0.50
Nodes (3): Change summary, Mandatory Codex audit, Validation

## Knowledge Gaps
- **254 isolated node(s):** `name`, `version`, `private`, `type`, `node` (+249 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **50 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `translatePostgresError()` connect `postgres/checkpoint-store.ts` to `temporal-kv.test.ts`, `postgres/temporal-kv.ts`, `postgres/watermarks.ts`, `postgres/transaction-lease.ts`?**
  _High betweenness centrality (0.011) - this node is a cross-community bridge._
- **Why does `TransactionHandle` connect `postgres/watermarks.ts` to `postgres/transaction-lease.ts`, `postgres/temporal-kv.ts`, `temporal-kv.test.ts`?**
  _High betweenness centrality (0.010) - this node is a cross-community bridge._
- **Why does `ValidationError` connect `postgres/checkpoint-store.ts` to `temporal-kv.test.ts`, `postgres/temporal-kv.ts`, `postgres/watermarks.ts`, `postgres/transaction-lease.ts`?**
  _High betweenness centrality (0.009) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _254 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `postgres/checkpoint-store.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05886708626434654 - nodes in this community are weakly interconnected._
- **Should `postgres/transaction-lease.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.07402597402597402 - nodes in this community are weakly interconnected._
- **Should `postgres/temporal-kv.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.12077294685990338 - nodes in this community are weakly interconnected._