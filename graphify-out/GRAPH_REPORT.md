# Graph Report - C:/Users/charl/UmbraDB-sprint3  (2026-07-21)

## Corpus Check
- 39 files · ~100,678 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 530 nodes · 988 edges · 24 communities (22 shown, 2 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 24 edges (avg confidence: 0.86)
- Token cost: 300,000 input · 20,000 output

## Community Hubs (Navigation)
- Transaction/Lease Interface
- TemporalKV Interface Types
- CheckpointStore/Lease Error Design
- Postgres Client & Errors
- Lean Formalization Plan (C/L/W)
- Sprint 3 CheckpointStore Design
- CheckpointStore Interface
- Transaction/Lease Composition
- Package Dependencies
- Lean Formalization Plan (T Laws)
- TemporalKV Schema Design
- TypeScript Config
- Storage Algebra Formal Spec
- TemporalKV Adapter Design
- Sprint 1 Spec Requirements
- OpenSpec Workflow Commands
- Mongo/FerretDB Rejection Rationale
- Shared Error Hierarchy Design
- Postgres Rebuild Proposal
- Advisory Lock Registry
- State-Equivalence Gate
- Graphify Close-out Policy
- Watermarks Value Schema

## God Nodes (most connected - your core abstractions)
1. `TransactionHandle` - 18 edges
2. `translatePostgresError()` - 18 edges
3. `checkpoint-store spec (Sprint 3)` - 18 edges
4. `UmbraDBSql` - 16 edges
5. `StorageError (shared base error class)` - 16 edges
6. `PgTemporalKV` - 15 edges
7. `UmbraDB Roadmap` - 15 edges
8. `withAbort()` - 13 edges
9. `PgTransactionLeaseLayer` - 13 edges
10. `Design — Postgres+JSONB storage rebuild` - 13 edges

## Surprising Connections (you probably didn't know these)
- `Advisory-lock class registry (1=migrations, 2=writer lease, 3=DDL serialization)` --semantically_similar_to--> `Composing Transaction/Lease internally`  [INFERRED] [semantically similar]
  design/design.md → openspec/changes/sprint-3-checkpoint-store/design.md
- `ckpt_sequence_counters allocator` --semantically_similar_to--> `Law T1: gapless monotonic versioning`  [INFERRED] [semantically similar]
  openspec/changes/sprint-3-checkpoint-store/design.md → design/design.md
- `Scan-Based Mark-and-Sweep GC` --semantically_similar_to--> `Law C2a GC Safety`  [INFERRED] [semantically similar]
  Performance/DESIGN.md → Formal/STORAGE_ALGEBRA.md
- `Requirement: Postgres errors surface as StorageError hierarchy` --implements--> `StorageError (shared base error class)`  [EXTRACTED]
  openspec/changes/archive/2026-07-21-sprint-1-setup-and-temporal-kv/specs/temporal-kv/spec.md → design/design-interfaces.md
- `OPSX Archive Workflow` --semantically_similar_to--> `OpenSpec Archive Change Skill`  [INFERRED] [semantically similar]
  .claude/commands/opsx/archive.md → .claude/skills/openspec-archive-change/SKILL.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Cross-module transaction-handle resolution** — design_design_interfaces_transactionhandle, openspec_changes_sprint_2_transaction_lease_design_transaction_handle_registry, openspec_changes_archive_2026_07_21_sprint_1_setup_and_temporal_kv_design_pgtemporalkv_adapter, openspec_changes_sprint_3_checkpoint_store_design_pgcheckpointstore_adapter, openspec_changes_sprint_2_transaction_lease_design_pgtransactionleaselayer_adapter [INFERRED 0.85]
- **Checkpoint GC safety mechanism** — design_design_ckpt_chunker_schema, openspec_changes_sprint_3_checkpoint_store_design_ckpt_manifest_chunks_position_fix, openspec_changes_sprint_3_checkpoint_store_design_prune_twostep_gc, roadmap_law_c2a_chunk_gc_safety, openspec_changes_sprint_3_checkpoint_store_tasks_property_test_p8_law_c2a [INFERRED 0.85]
- **Cross-vendor review pipeline applied per sprint** — readme_review_cadence, roadmap_sprint1_setup_temporal_kv, roadmap_sprint2_transaction_lease, roadmap_sprint3_checkpoint_store [EXTRACTED 1.00]
- **OpenSpec Change Lifecycle** — _claude_commands_opsx_explore_opsx_explore_mode, _claude_commands_opsx_propose_opsx_propose_workflow, _claude_commands_opsx_update_bidirectional_artifact_coherence, _claude_commands_opsx_apply_opsx_apply_workflow, _claude_commands_opsx_sync_intelligent_delta_spec_merge, _claude_commands_opsx_archive_opsx_archive_workflow [INFERRED 0.85]
- **Four Storage Algebras on a Shared Transactional Substrate** — formal_storage_algebra_temporalkv_partial_right_action, formal_storage_algebra_law_c1, formal_storage_algebra_law_w1, formal_storage_algebra_law_l1, formal_storage_algebra_shared_transactional_storage_algebra [EXTRACTED 1.00]
- **Database and Node Observability Stack** — performance_design_auto_explain_profiling, performance_design_pg_stat_statements_profiling, performance_design_tracingchannel_wrapper, performance_design_activity_logging [EXTRACTED 1.00]

## Communities (24 total, 2 thin omitted)

### Community 0 - "Transaction/Lease Interface"
Cohesion: 0.07
Nodes (37): Lease, LeaseAcquireOptions, LeaseAcquireOptionsSchema, LeaseFaultError, LeaseNotHeldError, LeaseTimeoutError, Rollback, TransactionFaultError (+29 more)

### Community 1 - "TemporalKV Interface Types"
Cohesion: 0.09
Nodes (34): AsOf, AssertExact, ExpectedVersionSchema, hasPostgresUnsafeText(), HistoryUnavailableError, JsonValue, jsonValueHasUnsafeText(), JsonValueSchema (+26 more)

### Community 2 - "CheckpointStore/Lease Error Design"
Cohesion: 0.06
Nodes (53): CheckpointNotFoundError, CheckpointStore interface, ChunkIntegrityError, Error-idiom unification (thrown, code-discriminated errors), Lease (opaque proof type), LeaseFaultError, LeaseHeldByOtherError, LeaseNotHeldError (+45 more)

### Community 3 - "Postgres Client & Errors"
Cohesion: 0.08
Nodes (19): assertNoConflictingSearchPath(), assertValidSchemaName(), createClient(), UmbraDBConnectionOptions, UmbraDBSql, ExclusionViolationError, Migration, migrations (+11 more)

### Community 4 - "Lean Formalization Plan (C/L/W)"
Cohesion: 0.06
Nodes (39): Abstract Model First Scope, C1 SemilatticeSup Strategy, C2 Reachability Closure Strategy, L1 Transition-System Invariant, W1 Function.update Strategy, Law C1 Save-Only Join Semilattice, Law C2a GC Safety, Law C2b Eventual Collection (+31 more)

### Community 5 - "Sprint 3 CheckpointStore Design"
Cohesion: 0.09
Nodes (37): Checkpoint chunker schema (ckpt_chunks/ckpt_manifests/ckpt_manifest_chunks), Design — Sprint 3: CheckpointStore, save() chunking write path, ckpt_manifest_chunks position/cascade fix, ckpt_sequence_counters allocator, complete flag explicit-write requirement, history() pagination, load() full verification (REPEATABLE READ) (+29 more)

### Community 6 - "CheckpointStore Interface"
Cohesion: 0.07
Nodes (21): CheckpointNotFoundError, CheckpointRecord, CheckpointSequence, CheckpointStore, CheckpointStoreError, CheckpointStoreErrorCode, CheckpointSummary, ChunkIntegrityError (+13 more)

### Community 7 - "Transaction/Lease Composition"
Cohesion: 0.12
Nodes (16): TransactionLeaseLayer, withAbort(), AggregateRow, ChunkJoinRow, coerceToSafeNumber(), ManifestRow, PgCheckpointStore, sha256() (+8 more)

### Community 8 - "Package Dependencies"
Cohesion: 0.07
Nodes (29): fast-check, dependencies, postgres, zod, devDependencies, fast-check, @testcontainers/postgresql, typedoc (+21 more)

### Community 9 - "Lean Formalization Plan (T Laws)"
Cohesion: 0.16
Nodes (15): Independent Citation Verification Discipline, T1 Serialized Hypothesis, T2 Partial-Action Wrapper, T3 Ordered Fold Strategy, T4 Strict Monotone Embedding, T5 Half-Open Interval Strategy, Law T1 Gapless Monotonicity, Law T2 CAS Guard (+7 more)

### Community 10 - "TemporalKV Schema Design"
Cohesion: 0.16
Nodes (14): kv_current/kv_history temporal schema + trigger, Law T1: gapless monotonic versioning, Law T4: dual addressing agreement, Law T5: history non-overlap + gap-freedom, Testcontainers vs pg-mem test-infrastructure decision, Testcontainers (@testcontainers/postgresql), PgTemporalKV.getAt (single-statement UNION ALL), Property test P1 (Law T1) (+6 more)

### Community 11 - "TypeScript Config"
Cohesion: 0.14
Nodes (13): src/**/*.ts, test/**/*.ts, compilerOptions, declaration, esModuleInterop, module, moduleResolution, noEmit (+5 more)

### Community 12 - "Storage Algebra Formal Spec"
Cohesion: 0.15
Nodes (13): Formal/STORAGE_ALGEBRA.md, Full VersionedEntry Property Comparison, Law T4 Same-Transaction Contradiction, Checkpoint Manifest-Chunks Junction Table, One Write per Key per Transaction, Superseded Algebraic Specification, TransactionKeyReuseError, Concrete Task Acceptance Criteria Rule (+5 more)

### Community 13 - "TemporalKV Adapter Design"
Cohesion: 0.24
Nodes (13): Storage Layer Interface Specification, CheckpointWalletStateStore (production adapter), TypeDoc (documentation generator), Zod v4 (runtime validation), VersionConflictError, PgTemporalKV, PgTemporalKV.put (3-shape CAS implementation), UmbraDB README (+5 more)

### Community 14 - "Sprint 1 Spec Requirements"
Cohesion: 0.21
Nodes (13): temporal-kv spec (Sprint 1 change), Requirement: Postgres errors surface as StorageError hierarchy, Requirement: Unconditional writes are gapless and monotonic (Law T1), Requirement: listKeys streams without materializing, Requirement: Migrations are idempotent and ordered, Requirement: put's CAS guard distinguishes conflict from absence, Requirement: Schema isolation is the default, Requirement: same-transaction reuse rejected at trigger level (+5 more)

### Community 15 - "OpenSpec Workflow Commands"
Cohesion: 0.20
Nodes (12): OPSX Apply Workflow, OPSX Archive Workflow, OPSX Explore Mode, OPSX Propose Workflow, Intelligent Delta Spec Merge, Bidirectional Artifact Coherence Review, OpenSpec Apply Change Skill, OpenSpec Archive Change Skill (+4 more)

### Community 16 - "Mongo/FerretDB Rejection Rationale"
Cohesion: 0.20
Nodes (12): Design — Postgres+JSONB storage rebuild, FerretDB / Mongo-compat-shim evaluated and rejected, PrivateStateProvider composition note, kv_history retention policy (pg_cron), Module → module mapping (Mongo → Postgres), postgres.js driver choice, private_state_salts/private_states/signing_keys schema, FerretDB (+4 more)

### Community 17 - "Shared Error Hierarchy Design"
Cohesion: 0.20
Nodes (10): ConnectionError, ValidationError, WalletStateStore composition note, Watermarks interface, Tier 1 / Tier 2 Postgres schema reconciliation, Design — Sprint 1: project setup + TemporalKV, Sprint 1 error translation table (errors.ts), umbradb default schema naming decision (+2 more)

### Community 18 - "Postgres Rebuild Proposal"
Cohesion: 0.29
Nodes (7): FerretDB Compatibility-Shim Rejection, midnight-pg-store, MongoDB Dependency and Nix Build Problem, Postgres Private-State and Wallet-State Adapters, Postgres+JSONB Storage Rebuild Proposal, Mongo/Postgres State-Equivalence Gate, Tier-1-Only Scope

### Community 19 - "Advisory Lock Registry"
Cohesion: 0.33
Nodes (6): Advisory-lock class registry (1=migrations, 2=writer lease, 3=DDL serialization), PgBouncer, Writer-lease via sql.reserve()-pinned advisory lock, Migration bootstrap advisory lock (class 1), Hand-rolled migration runner, 002_checkpoint_store migration

### Community 20 - "State-Equivalence Gate"
Cohesion: 0.33
Nodes (6): Law T3: temporal-projection replay equivalence, State-equivalence gate (merge blocker), Property test P3 (Law T3 replay), Proposal — Sprint 1: project setup + TemporalKV, Requirement: getAt satisfies Law T3, OpenSpec review cadence (Opus panel + Fable 5 + Codex audit)

## Knowledge Gaps
- **124 isolated node(s):** `name`, `version`, `private`, `type`, `node` (+119 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Design — Postgres+JSONB storage rebuild` connect `Mongo/FerretDB Rejection Rationale` to `Sprint 3 CheckpointStore Design`, `TemporalKV Schema Design`, `TemporalKV Adapter Design`, `Shared Error Hierarchy Design`, `Advisory Lock Registry`, `State-Equivalence Gate`?**
  _High betweenness centrality (0.017) - this node is a cross-community bridge._
- **Why does `UmbraDB Roadmap` connect `CheckpointStore/Lease Error Design` to `Sprint 3 CheckpointStore Design`, `TemporalKV Schema Design`, `TemporalKV Adapter Design`, `Shared Error Hierarchy Design`, `State-Equivalence Gate`?**
  _High betweenness centrality (0.015) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _124 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Transaction/Lease Interface` be split into smaller, more focused modules?**
  _Cohesion score 0.0711864406779661 - nodes in this community are weakly interconnected._
- **Should `TemporalKV Interface Types` be split into smaller, more focused modules?**
  _Cohesion score 0.09013914095583787 - nodes in this community are weakly interconnected._
- **Should `CheckpointStore/Lease Error Design` be split into smaller, more focused modules?**
  _Cohesion score 0.06386066763425254 - nodes in this community are weakly interconnected._
- **Should `Postgres Client & Errors` be split into smaller, more focused modules?**
  _Cohesion score 0.08084163898117387 - nodes in this community are weakly interconnected._