# Graph Report - UmbraDB  (2026-07-20)

## Corpus Check
- 50 files · ~58,386 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 526 nodes · 767 edges · 36 communities (32 shown, 4 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 42 edges (avg confidence: 0.91)
- Token cost: unavailable from the collaboration runtime (numeric placeholders: 0 input · 0 output)

## Graph Health

- The final graph built successfully with no missing semantic endpoints or self-loops.
- Pre-build diagnostics found 20 dangling AST import edges. They point to external
  packages (`zod`, `postgres`, `vitest`, `fast-check`, and Testcontainers) or
  imported constants for which the structural extractor emitted no node; the
  builder pruned them from the final graph.
- One same-endpoint pair (`src_interfaces_watermarks` →
  `src_interfaces_temporal_kv`) carries both `imports_from` and `re_exports`.
  Because this graph is undirected and non-multigraph, one edge representation
  is collapsed. Query those source files directly when that distinction matters.

## Community Hubs (Navigation)
- Temporal KV Adapter
- Project Roadmap and Specs
- Postgres Errors and Tests
- Storage Architecture Design
- Node Toolchain Dependencies
- Original Storage Algebra
- Formalization Repair Model
- Transaction Lease Interface
- Checkpoint Store Interface
- Performance and GC
- TypeScript Compiler Config
- OpenSpec Workflows
- Lean Toolchain Research
- Temporal SQL Schema
- CAS and Checkpoint Gaps
- Migration Design
- Sprint Roadmap
- GC Refinement Obligations
- History First Research
- Temporal Interface Semantics
- Sprint Acceptance Process
- Attempt and Transaction Semantics
- Formalization Milestones Tests
- Temporal Replay Retention
- CAS Property Testing
- Lease Safety Blockers
- Transaction Participation
- Schema Isolation
- Replay Cutover Properties
- Transaction Guard Model
- Documentation Status Drift
- Semilattice Strategy
- Graph Freshness Policy
- Function Update Lemmas
- Veil Invariant Method
- Watermark Schema

## God Nodes (most connected - your core abstractions)
1. `StorageError` - 16 edges
2. `TransactionHandle` - 15 edges
3. `PgTemporalKV` - 14 edges
4. `Postgres+JSONB Storage Rebuild Design` - 11 edges
5. `TemporalKV Implementation Specification` - 11 edges
6. `compilerOptions` - 10 edges
7. `UmbraDB` - 10 edges
8. `Law-by-Law Repair Map` - 10 edges
9. `ValidationError` - 9 edges
10. `Namespace` - 9 edges

## Surprising Connections (you probably didn't know these)
- `Scan-Based Mark-and-Sweep GC` --semantically_similar_to--> `Law C2a GC Safety`  [INFERRED] [semantically similar]
  Performance/DESIGN.md → Formal/STORAGE_ALGEBRA.md
- `Postgres+JSONB Storage Rebuild Proposal` --semantically_similar_to--> `PostgreSQL JSONB Backend`  [INFERRED] [semantically similar]
  design/proposal.md → README.md
- `Formal/STORAGE_ALGEBRA.md` --semantically_similar_to--> `Formal Algebraic Specification`  [INFERRED] [semantically similar]
  design/design-algebra.md → ROADMAP.md
- `Mongo/Postgres State-Equivalence Gate` --semantically_similar_to--> `Differential State-Equivalence Gate`  [INFERRED] [semantically similar]
  design/proposal.md → ROADMAP.md
- `Trace-Based Lease Mutual Exclusion` --conceptually_related_to--> `Transaction/Lease`  [INFERRED]
  ROADMAP.md → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **OpenSpec Change Lifecycle** — _claude_commands_opsx_explore_opsx_explore_mode, _claude_commands_opsx_propose_opsx_propose_workflow, _claude_commands_opsx_update_bidirectional_artifact_coherence, _claude_commands_opsx_apply_opsx_apply_workflow, _claude_commands_opsx_sync_intelligent_delta_spec_merge, _claude_commands_opsx_archive_opsx_archive_workflow [INFERRED 0.85]
- **Four Storage Algebras on a Shared Transactional Substrate** — formal_storage_algebra_temporalkv_partial_right_action, formal_storage_algebra_law_c1, formal_storage_algebra_law_w1, formal_storage_algebra_law_l1, formal_storage_algebra_shared_transactional_storage_algebra [EXTRACTED 1.00]
- **Database and Node Observability Stack** — performance_design_auto_explain_profiling, performance_design_pg_stat_statements_profiling, performance_design_tracingchannel_wrapper, performance_design_activity_logging [EXTRACTED 1.00]
- **UmbraDB Four Storage Primitives** — readme_temporalkv, readme_checkpointstore, readme_watermarks, readme_transaction_lease [EXTRACTED 1.00]
- **TemporalKV Correctness Chain** — design_design_temporal_current_history_model, design_design_transaction_reuse_guard, design_design_history_interval_integrity, design_design_replay_equivalence_p3, openspec_changes_sprint_1_setup_and_temporal_kv_specs_temporal_kv_spec_law_t4_dual_addressing [INFERRED 0.95]
- **Sprint 1 Implementation Acceptance Flow** — openspec_changes_sprint_1_setup_and_temporal_kv_design_typescript_migrations, openspec_changes_sprint_1_setup_and_temporal_kv_design_pgtemporalkv_adapter, openspec_changes_sprint_1_setup_and_temporal_kv_specs_temporal_kv_spec_temporal_kv_implementation_spec, openspec_changes_sprint_1_setup_and_temporal_kv_tasks_p1_p5_real_postgres [INFERRED 0.95]
- **Temporal Model Layers A–C** — formal_storage_algebra_lean_research_history_first_abstract_state_machine, formal_storage_algebra_lean_research_temporal_layer_a, formal_storage_algebra_lean_research_temporal_layer_b, formal_storage_algebra_lean_research_retention_layer_c [EXTRACTED 1.00]
- **Storage Law Repair Program** — formal_storage_algebra_lean_research_law_t1_repair, formal_storage_algebra_lean_research_law_t2_repair, formal_storage_algebra_lean_research_law_t3_repair, formal_storage_algebra_lean_research_law_t4_repair, formal_storage_algebra_lean_research_law_t5_repair, formal_storage_algebra_lean_research_law_c1_repair, formal_storage_algebra_lean_research_law_c2a_repair, formal_storage_algebra_lean_research_law_c2b_repair, formal_storage_algebra_lean_research_law_w1_repair, formal_storage_algebra_lean_research_law_l1_repair [EXTRACTED 1.00]
- **Formalization Strategy Comparison** — formal_storage_algebra_lean_research_strategy_a_history_first, formal_storage_algebra_lean_research_strategy_b_law_first, formal_storage_algebra_lean_research_strategy_c_postgresql_first [EXTRACTED 1.00]

## Communities (36 total, 4 thin omitted)

### Community 0 - "Temporal KV Adapter"
Cohesion: 0.09
Nodes (35): AsOf, AssertExact, ExpectedVersionSchema, HistoryUnavailableError, JsonValue, JsonValueSchema, Key, KeySchema (+27 more)

### Community 1 - "Project Roadmap and Specs"
Cohesion: 0.05
Nodes (48): Formal/STORAGE_ALGEBRA.md, Full VersionedEntry Property Comparison, Law T4 Same-Transaction Contradiction, Checkpoint Manifest-Chunks Junction Table, One Write per Key per Transaction, Superseded Algebraic Specification, TransactionKeyReuseError, AsOf Selector (+40 more)

### Community 2 - "Postgres Errors and Tests"
Cohesion: 0.08
Nodes (26): ConnectionError, SerializationFailedError, SharedStorageErrorCode, StorageError, ValidationError, assertValidSchemaName(), createClient(), UmbraDBConnectionOptions (+18 more)

### Community 3 - "Storage Architecture Design"
Cohesion: 0.06
Nodes (38): Advisory-Lock Class Namespaces, Atomic Deduplication with GC-Clock Refresh, CheckpointWalletStateStore Composition, Conditional Legacy wallet_state Table, Connection-Pinned Advisory Writer Lease, Content-Addressed Checkpoint Chunks, Crash-Implies-Release Lease Semantics, Application-Encrypted bytea Storage (+30 more)

### Community 4 - "Node Toolchain Dependencies"
Cohesion: 0.07
Nodes (29): fast-check, dependencies, postgres, zod, devDependencies, fast-check, @testcontainers/postgresql, typedoc (+21 more)

### Community 5 - "Original Storage Algebra"
Cohesion: 0.08
Nodes (30): Abstract Model First Scope, C1 SemilatticeSup Strategy, C2 Reachability Closure Strategy, Independent Citation Verification Discipline, L1 Transition-System Invariant, T1 Serialized Hypothesis, T2 Partial-Action Wrapper, T3 Ordered Fold Strategy (+22 more)

### Community 6 - "Formalization Repair Model"
Cohesion: 0.08
Nodes (28): Per-Chunk Selection Fairness for Batched GC, Callback Safety Cancellation/Fencing Extension, Checkpoint Identity-Set and Compatible-Map Model, ChunkIds Finset Join-Semilattice, Compatible Chunk-Map Requirement, Compatible Hash-to-Bytes Finite Map, Conflict-free Replicated Data Types, Derived Adjacent-Interval Coverage Model (+20 more)

### Community 7 - "Transaction Lease Interface"
Cohesion: 0.09
Nodes (15): Lease, LeaseAcquireOptions, LeaseAcquireOptionsSchema, LeaseFaultError, LeaseNotHeldError, LeaseTimeoutError, Rollback, TransactionFaultError (+7 more)

### Community 8 - "Checkpoint Store Interface"
Cohesion: 0.10
Nodes (16): CheckpointNotFoundError, CheckpointRecord, CheckpointSequence, CheckpointStore, CheckpointStoreError, CheckpointStoreErrorCode, CheckpointSummary, ChunkIntegrityError (+8 more)

### Community 9 - "Performance and GC"
Cohesion: 0.09
Nodes (24): Property Suite P1–P10, Structured Activity Logging, auto_explain Trigger Profiling, Custom TypeScript Benchmark Harness, Timestamp GC Grace Window, Normalized Manifest–Chunk Junction, Performance Architecture Design, pg_stat_statements Aggregate Profiling (+16 more)

### Community 10 - "TypeScript Compiler Config"
Cohesion: 0.14
Nodes (13): src/**/*.ts, test/**/*.ts, compilerOptions, declaration, esModuleInterop, module, moduleResolution, noEmit (+5 more)

### Community 11 - "OpenSpec Workflows"
Cohesion: 0.20
Nodes (12): OPSX Apply Workflow, OPSX Archive Workflow, OPSX Explore Mode, OPSX Propose Workflow, Intelligent Delta Spec Merge, Bidirectional Artifact Coherence Review, OpenSpec Apply Change Skill, OpenSpec Archive Change Skill (+4 more)

### Community 12 - "Lean Toolchain Research"
Cohesion: 0.17
Nodes (12): CLAUDE.md Graph Freshness Policy, Import/API Smoke Slice, Set Interval-Disjointness APIs, Lean 4 Feasibility Assessment, Lean/mathlib v4.32.0 Toolchain, mathlib Interval Disjointness Source, mathlib v4.32.0 Release, Missing Lean API Workarounds (+4 more)

### Community 13 - "Temporal SQL Schema"
Cohesion: 0.20
Nodes (10): History Non-Overlap and Gap-Freedom, Millisecond Timestamp Alignment, SuperJSON Serialization Boundary, Temporal Current/History Table Model, Temporal History Retention, Transaction-ID Reuse Guard, Single-Snapshot getAt Query, Law T5 History Non-Overlap (+2 more)

### Community 14 - "CAS and Checkpoint Gaps"
Cohesion: 0.22
Nodes (9): Atomic CAS Conflict-Snapshot Gap, Baseline Implementation Matrix, Checkpoint Schema Design, CheckpointStore Interface, Expectation Sum Type, T2 Explicit-Expectation CAS Repair, Ordered Manifest Schema Gap, PgTemporalKV Adapter (+1 more)

### Community 15 - "Migration Design"
Cohesion: 0.22
Nodes (9): Postgres BigInt Decoder, btree_gist Migration Search Path, createClient Configuration, Schema-Scoped Migration Advisory Lock, Sprint 1 Retention Deferral, postgres.js Safe Identifier Substitution, Sprint 1 Setup and TemporalKV Design, TypeScript Migration Functions (+1 more)

### Community 16 - "Sprint Roadmap"
Cohesion: 0.25
Nodes (8): CheckpointStore Future Sprint, Downstream Cutover Ownership, Legacy Wallet-State Scope Question, Per-Sprint OpenSpec Process, PrivateStateProvider Scope Question, Sprint 1 Setup and TemporalKV Completion, Superseded 11-Phase Task Breakdown, Transaction/Lease Sprint 2

### Community 17 - "GC Refinement Obligations"
Cohesion: 0.25
Nodes (8): Abstract Model / PostgreSQL Refinement Boundary, Dijkstra EWD630, GC Safety and Liveness Split, Lamport PlusCal Tutorial Session 9, A Framework for Verified Garbage Collection, Named External Refinement Obligations, Strategy C PostgreSQL-Refinement-First, Lean Nat / PostgreSQL bigint Range Obligation

### Community 18 - "History First Research"
Cohesion: 0.29
Nodes (8): Use of Formal Methods at Amazon Web Services, Current-Only Temporal Carrier Defect, History-First Executable Abstract State Machine, LEAN_FORMALIZATION_PLAN.md, Storage Algebra Lean Formalization Research Draft, Research Complete but Specification Unapproved, STORAGE_TYPES.md, Strategy A Executable History-First Model

### Community 19 - "Temporal Interface Semantics"
Cohesion: 0.25
Nodes (8): AbortError and Cursor Release, Cursor-Streaming listKeys, Literal Prefix Matching, Postgres SQLSTATE Translation, Law T1 Gapless Monotonic Versions, StorageError Translation Requirement, Streaming and Ordered listKeys, TemporalKV Implementation Specification

### Community 20 - "Sprint Acceptance Process"
Cohesion: 0.29
Nodes (8): Concurrent Migration Verification, postgres.js Driver Surface Verification, Sprint 1 Task Plan, Concrete Task Acceptance Criteria Rule, Design Cross-Reference Rule, Explicit Proposal Non-Goals Rule, External Claim Verification Rule, Spec-Driven OpenSpec Configuration

### Community 21 - "Attempt and Transaction Semantics"
Cohesion: 0.43
Nodes (7): Total Temporal Attempt Transition, Total Attempts versus Aborting Transaction Semantics, List.foldl_append and foldlM_append APIs, Lean List.foldlM_append Source, mathlib Kleisli Fold Construction, runAttempts Observational Trace, runTransaction Rollback Semantics

### Community 22 - "Formalization Milestones Tests"
Cohesion: 0.33
Nodes (7): First Thirteen-Theorem Tranche, Formalization Milestones M0–M5, History-Overlap Migration Test, No-sorry and No-Hidden-Axiom Boundary, P1–P10 Test and Implementation Gap Matrix, Proposed Formal/Lean Module Layout, TemporalKV Property Tests

### Community 23 - "Temporal Replay Retention"
Cohesion: 0.29
Nodes (7): Reject Fold Duality for Order-Sensitive T3, T3 Accepted-Prefix Lookup Repair, Retained-History Offset and Availability Certificate, Layer C Retention Extension, STORAGE_ALGEBRA.md, T3 Current-Event and Retention Defect, Layer A Per-Key Temporal History

### Community 24 - "CAS Property Testing"
Cohesion: 0.29
Nodes (7): expectedVersion Boundary Validation, PgTemporalKV Adapter, Real-Postgres Property Testing, Three expectedVersion Put Paths, CAS Conflict-versus-Absence Distinction, Seven-Case CAS Conformance Matrix, Testcontainers Setup

### Community 25 - "Lease Safety Blockers"
Cohesion: 0.50
Nodes (5): Database Holder versus Callback Exclusion Gap, Ten-Point Formalization Decision Package, PostgreSQL 18 Advisory Locks, Sprint 2 Formalization Blockers, Unaudited Sprint 2 Transaction/Lease Proposal

### Community 26 - "Transaction Participation"
Cohesion: 0.50
Nodes (4): Canonical TransactionHandle, Fail-Loud Transaction Participation Deferral, Transaction Handle Honored or Rejected, Transaction Participation Rejection Tests

### Community 27 - "Schema Isolation"
Cohesion: 0.50
Nodes (4): One Postgres Instance, Two Schemas, Tier-1 Schema Isolation, Configurable umbradb Schema, Default Schema Isolation

### Community 28 - "Replay Cutover Properties"
Cohesion: 0.50
Nodes (4): Replay-Equivalence Property P3, State-Equivalence Cutover Gate, Law T3 Temporal-Projection Equivalence, P1-P5 Against Real Postgres

### Community 29 - "Transaction Guard Model"
Cohesion: 0.50
Nodes (4): DecidableEq Computational Requirement, CAS / Reuse / Clock Error Precedence, Layer B Keyed Store and Transaction Guard, Transaction Status and Written-Key State

### Community 30 - "Documentation Status Drift"
Cohesion: 0.67
Nodes (3): README and ROADMAP Status Drift, Top-Level README Status, ROADMAP Status

### Community 31 - "Semilattice Strategy"
Cohesion: 0.67
Nodes (3): mathlib SemilatticeSup.mk' Source, SemilatticeSup and Finset Union APIs, Strategy B Law/Typeclass-First Algebra

## Knowledge Gaps
- **148 isolated node(s):** `name`, `version`, `private`, `type`, `node` (+143 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Postgres+JSONB Storage Rebuild Design` connect `Storage Architecture Design` to `Project Roadmap and Specs`, `Schema Isolation`, `Temporal SQL Schema`?**
  _High betweenness centrality (0.025) - this node is a cross-community bridge._
- **Why does `UmbraDB` connect `Project Roadmap and Specs` to `Storage Architecture Design`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **Why does `Storage Layer Interface Specification` connect `Storage Architecture Design` to `Project Roadmap and Specs`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _148 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Temporal KV Adapter` be split into smaller, more focused modules?**
  _Cohesion score 0.08926553672316384 - nodes in this community are weakly interconnected._
- **Should `Project Roadmap and Specs` be split into smaller, more focused modules?**
  _Cohesion score 0.04964539007092199 - nodes in this community are weakly interconnected._
- **Should `Postgres Errors and Tests` be split into smaller, more focused modules?**
  _Cohesion score 0.07535460992907801 - nodes in this community are weakly interconnected._
