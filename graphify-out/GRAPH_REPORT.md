# Graph Report - UmbraDB-storage-algebra-lean  (2026-07-21)

## Corpus Check
- 72 files · ~111,216 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 952 nodes · 1473 edges · 77 communities (75 shown, 2 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 24 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `b18edb43`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- transaction-lease.ts
- temporal-kv.ts
- spec.md
- migrate.ts
- Performance — design
- spec.md
- ADDED Requirements
- checkpoint-store.ts
- package.json
- TemporalKV Partial Right Action
- Requirements
- compilerOptions
- Spec-Driven OpenSpec Configuration
- README.md
- spec.md
- OPSX Archive Workflow
- design.md
- design.md
- Postgres+JSONB Storage Rebuild Proposal
- Advisory-lock class registry (1=migrations, 2=writer lease, 3=DDL serialization)
- ADDED Requirements
- Knowledge Graph Freshness Policy
- Storage Layer Interface Specification
- WatermarkValueSchema
- Storage Algebra Lean Formalization — Approved M1 Design
- ROADMAP.md
- Design — Sprint 3: CheckpointStore
- Sprint 1 test infrastructure (Testcontainers + fast-check)
- Storage Algebra Lean M2 Retention Sprint
- Design — Postgres+JSONB storage rebuild
- StorageError (shared base error class)
- Algebraic Specification of the midnight-pg-store Storage Layer
- SKILL.md
- Custom TypeScript Benchmark Harness
- explore.md
- Requirement: A caller-supplied transaction handle is honored or rejected, never silently ignored
- Design — Sprint 2: Transaction/Lease
- ADDED Requirements
- UmbraDB
- Roadmap
- Global Constraints
- Shared Transactional Storage Algebra
- tasks.md
- Scan-Based Mark-and-Sweep GC
- Law C1 Save-Only Join Semilattice
- Watermarks interface
- Proposal — Postgres+JSONB storage rebuild (remove the MongoDB dependency)
- proposal.md
- Proposal — Sprint 2: Transaction/Lease
- PgTransactionLeaseLayer
- Requirement: Checkpoint sequence numbers are gapless, monotonic, and scoped per wallet+network
- Requirement: load and history distinguish "no checkpoint" from "checkpoint exists elsewhere"
- GC architecture and query-tracing: research findings
- Transaction-handle registry (registerTransaction/resolveTransaction)
- Requirement: load always fully verifies chunk integrity before returning
- Requirement: prune rejects a retainCount that is not a positive safe integer, before any deletion runs
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

## God Nodes (most connected - your core abstractions)
1. `ADDED Requirements` - 19 edges
2. `TransactionHandle` - 18 edges
3. `translatePostgresError()` - 18 edges
4. `UmbraDBSql` - 16 edges
5. `StorageError (shared base error class)` - 16 edges
6. `StorageError` - 15 edges
7. `PgTemporalKV` - 15 edges
8. `Storage Algebra Lean Formalization — Approved M1 Design` - 14 edges
9. `Performance — design` - 14 edges
10. `ValidationError` - 13 edges

## Surprising Connections (you probably didn't know these)
- `Scan-Based Mark-and-Sweep GC` --semantically_similar_to--> `Law C2a GC Safety`  [INFERRED] [semantically similar]
  Performance/DESIGN.md → Formal/STORAGE_ALGEBRA.md
- `Advisory-lock class registry (1=migrations, 2=writer lease, 3=DDL serialization)` --semantically_similar_to--> `Composing Transaction/Lease internally`  [INFERRED] [semantically similar]
  design/design.md → openspec/changes/sprint-3-checkpoint-store/design.md
- `ckpt_sequence_counters allocator` --semantically_similar_to--> `Law T1: gapless monotonic versioning`  [INFERRED] [semantically similar]
  openspec/changes/sprint-3-checkpoint-store/design.md → design/design.md
- `Requirement: Postgres errors surface as StorageError hierarchy` --implements--> `StorageError (shared base error class)`  [EXTRACTED]
  openspec/changes/archive/2026-07-21-sprint-1-setup-and-temporal-kv/specs/temporal-kv/spec.md → design/design-interfaces.md
- `TransactionHandleInvalidError` --implements--> `StorageError (shared base error class)`  [EXTRACTED]
  openspec/changes/sprint-2-transaction-lease/design.md → design/design-interfaces.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Cross-module transaction-handle resolution** — design_design_interfaces_transactionhandle, openspec_changes_sprint_2_transaction_lease_design_transaction_handle_registry, openspec_changes_archive_2026_07_21_sprint_1_setup_and_temporal_kv_design_pgtemporalkv_adapter, openspec_changes_sprint_3_checkpoint_store_design_pgcheckpointstore_adapter, openspec_changes_sprint_2_transaction_lease_design_pgtransactionleaselayer_adapter [INFERRED 0.85]
- **Checkpoint GC safety mechanism** — design_design_design_design_design_ckpt_chunker_schema, openspec_changes_sprint_3_checkpoint_store_design_ckpt_manifest_chunks_position_fix, openspec_changes_sprint_3_checkpoint_store_design_prune_twostep_gc, roadmap_law_c2a_chunk_gc_safety, openspec_changes_sprint_3_checkpoint_store_tasks_property_test_p8_law_c2a [INFERRED 0.85]
- **Cross-vendor review pipeline applied per sprint** — readme_review_cadence, roadmap_sprint1_setup_temporal_kv, roadmap_sprint2_transaction_lease, roadmap_sprint3_checkpoint_store [EXTRACTED 1.00]
- **OpenSpec Change Lifecycle** — _claude_commands_opsx_explore_opsx_explore_mode, _claude_commands_opsx_propose_opsx_propose_workflow, _claude_commands_opsx_update_bidirectional_artifact_coherence, _claude_commands_opsx_apply_opsx_apply_workflow, _claude_commands_opsx_sync_intelligent_delta_spec_merge, _claude_commands_opsx_archive_opsx_archive_workflow [INFERRED 0.85]
- **Four Storage Algebras on a Shared Transactional Substrate** — formal_storage_algebra_temporalkv_partial_right_action, formal_storage_algebra_law_c1, formal_storage_algebra_law_w1, formal_storage_algebra_law_l1, formal_storage_algebra_shared_transactional_storage_algebra [EXTRACTED 1.00]
- **Database and Node Observability Stack** — performance_design_auto_explain_profiling, performance_design_pg_stat_statements_profiling, performance_design_tracingchannel_wrapper, performance_design_activity_logging [EXTRACTED 1.00]

## Communities (77 total, 2 thin omitted)

### Community 0 - "transaction-lease.ts"
Cohesion: 0.08
Nodes (31): Lease, LeaseAcquireOptions, LeaseAcquireOptionsSchema, LeaseFaultError, LeaseNotHeldError, LeaseTimeoutError, Rollback, TransactionFaultError (+23 more)

### Community 1 - "temporal-kv.ts"
Cohesion: 0.06
Nodes (50): ConnectionError, SerializationFailedError, SharedStorageErrorCode, StorageError, ValidationError, AsOf, AssertExact, ExpectedVersionSchema (+42 more)

### Community 2 - "spec.md"
Cohesion: 0.13
Nodes (14): LeaseNotHeldError, TransactionFaultError, Sprint 2 error translation additions, Requirement: abort during lease acquisition rejects with AbortError, Requirement: abort before withTransaction starts rejects with AbortError, Requirement: acquireLease waits, tryAcquireLease never blocks, Requirement: connection loss surfaces as LeaseFaultError, Requirement: releaseLease rejects not-held lease (+6 more)

### Community 3 - "migrate.ts"
Cohesion: 0.11
Nodes (16): assertNoConflictingSearchPath(), assertValidSchemaName(), createClient(), UmbraDBConnectionOptions, UmbraDBSql, Migration, migrations, runMigrations() (+8 more)

### Community 4 - "Performance — design"
Cohesion: 0.15
Nodes (12): 1. Postgres-side profiling, 2. Node-side query correlation, 3. GC architecture (the load-bearing decision), 4. Benchmark harness, 5. Activity logging, Performance — design, pg_stat_statements Aggregate Profiling, TracingChannel Correlation Wrapper (+4 more)

### Community 5 - "spec.md"
Cohesion: 0.06
Nodes (47): Checkpoint chunker schema (ckpt_chunks/ckpt_manifests/ckpt_manifest_chunks), CheckpointStore interface, ChunkIntegrityError, ManifestCorruptError, save() chunking write path, ckpt_manifest_chunks position/cascade fix, ckpt_sequence_counters allocator, complete flag explicit-write requirement (+39 more)

### Community 6 - "ADDED Requirements"
Cohesion: 0.06
Nodes (33): ADDED Requirements, Requirement: A caller-supplied transaction handle is honored or rejected, never silently ignored, Requirement: A second write to the same key within one transaction is rejected at the trigger level, not silently absorbed, Requirement: Dual addressing agrees at commit instants (Law T4), Requirement: getAt satisfies temporal-projection equivalence (Law T3), within the store's retention window, Requirement: History intervals never overlap for a single key (Law T5), Requirement: listKeys streams without materializing the full result set first, and orders results correctly, Requirement: Migrations are idempotent and ordered (+25 more)

### Community 7 - "checkpoint-store.ts"
Cohesion: 0.07
Nodes (30): CheckpointNotFoundError, CheckpointRecord, CheckpointSequence, CheckpointStore, CheckpointStoreError, CheckpointStoreErrorCode, CheckpointSummary, ChunkIntegrityError (+22 more)

### Community 8 - "package.json"
Cohesion: 0.07
Nodes (29): fast-check, dependencies, postgres, zod, devDependencies, fast-check, @testcontainers/postgresql, typedoc (+21 more)

### Community 9 - "TemporalKV Partial Right Action"
Cohesion: 0.16
Nodes (15): Independent Citation Verification Discipline, T1 Serialized Hypothesis, T2 Partial-Action Wrapper, T3 Ordered Fold Strategy, T4 Strict Monotone Embedding, T5 Half-Open Interval Strategy, Law T1 Gapless Monotonicity, Law T2 CAS Guard (+7 more)

### Community 10 - "Requirements"
Cohesion: 0.06
Nodes (32): Requirement: A caller-supplied transaction handle is honored or rejected, never silently ignored, Requirement: A second write to the same key within one transaction is rejected at the trigger level, not silently absorbed, Requirement: Dual addressing agrees at commit instants (Law T4), Requirement: getAt satisfies temporal-projection equivalence (Law T3), within the store's retention window, Requirement: History intervals never overlap for a single key (Law T5), Requirement: listKeys streams without materializing the full result set first, and orders results correctly, Requirement: Migrations are idempotent and ordered, Requirement: Postgres errors surface as the shared StorageError hierarchy (+24 more)

### Community 11 - "compilerOptions"
Cohesion: 0.14
Nodes (13): src/**/*.ts, test/**/*.ts, compilerOptions, declaration, esModuleInterop, module, moduleResolution, noEmit (+5 more)

### Community 12 - "Spec-Driven OpenSpec Configuration"
Cohesion: 0.15
Nodes (13): Formal/STORAGE_ALGEBRA.md, Full VersionedEntry Property Comparison, Law T4 Same-Transaction Contradiction, Checkpoint Manifest-Chunks Junction Table, One Write per Key per Transaction, Superseded Algebraic Specification, TransactionKeyReuseError, Concrete Task Acceptance Criteria Rule (+5 more)

### Community 13 - "README.md"
Cohesion: 0.31
Nodes (9): CheckpointWalletStateStore (production adapter), TypeDoc (documentation generator), Zod v4 (runtime validation), PgTemporalKV, CheckpointStore module, TemporalKV module, OpenSpec (change proposal framework), Transaction/Lease layer (+1 more)

### Community 14 - "spec.md"
Cohesion: 0.14
Nodes (15): Law T1: gapless monotonic versioning, Property test P1 (Law T1), TransactionParticipationNotSupportedError, Requirement: Postgres errors surface as StorageError hierarchy, Requirement: Unconditional writes are gapless and monotonic (Law T1), Requirement: listKeys streams without materializing, Requirement: Migrations are idempotent and ordered, Requirement: put's CAS guard distinguishes conflict from absence (+7 more)

### Community 15 - "OPSX Archive Workflow"
Cohesion: 0.20
Nodes (12): OPSX Apply Workflow, OPSX Archive Workflow, OPSX Explore Mode, OPSX Propose Workflow, Intelligent Delta Spec Merge, Bidirectional Artifact Coherence Review, OpenSpec Apply Change Skill, OpenSpec Archive Change Skill (+4 more)

### Community 16 - "design.md"
Cohesion: 0.22
Nodes (10): FerretDB / Mongo-compat-shim evaluated and rejected, kv_history retention policy (pg_cron), Module → module mapping (Mongo → Postgres), postgres.js driver choice, private_state_salts/private_states/signing_keys schema, FerretDB, pg_cron, wallet_state table (conditional scope) (+2 more)

### Community 17 - "design.md"
Cohesion: 0.15
Nodes (12): Tier 1 / Tier 2 Postgres schema reconciliation, postgres.js driver, 0. Schema naming, now that UmbraDB is standalone, 1. Package layout, 2. Migration mechanism, 3. Connection factory (`src/postgres/client.ts`), 4. `PgTemporalKV` adapter (`src/postgres/temporal-kv.ts`), 4a. Error translation (`src/postgres/errors.ts`) (+4 more)

### Community 18 - "Postgres+JSONB Storage Rebuild Proposal"
Cohesion: 0.29
Nodes (7): FerretDB Compatibility-Shim Rejection, midnight-pg-store, MongoDB Dependency and Nix Build Problem, Postgres Private-State and Wallet-State Adapters, Postgres+JSONB Storage Rebuild Proposal, Mongo/Postgres State-Equivalence Gate, Tier-1-Only Scope

### Community 19 - "Advisory-lock class registry (1=migrations, 2=writer lease, 3=DDL serialization)"
Cohesion: 0.33
Nodes (6): Advisory-lock class registry (1=migrations, 2=writer lease, 3=DDL serialization), PgBouncer, Writer-lease via sql.reserve()-pinned advisory lock, Migration bootstrap advisory lock (class 1), Hand-rolled migration runner, 002_checkpoint_store migration

### Community 20 - "ADDED Requirements"
Cohesion: 0.07
Nodes (29): ADDED Requirements, Requirement: A lease timeout surfaces distinctly for acquireLease vs. tryAcquireLease, Requirement: A resolved transaction handle always refers to its own live transaction, Requirement: A transaction timeout surfaces as TransactionFaultError, Requirement: Aborting opts.signal before withTransaction starts rejects with AbortError, Requirement: Aborting opts.signal during lease acquisition rejects with AbortError, Requirement: acquireLease waits indefinitely absent a timeout; tryAcquireLease never blocks unboundedly, Requirement: At most one holder per lease key at any instant (Law L1) (+21 more)

### Community 22 - "Storage Layer Interface Specification"
Cohesion: 0.12
Nodes (16): 1.1 Error handling — one idiom: thrown, `code`-discriminated typed errors, 1.2 Async pattern, 1.3 Transaction participation, 1.4 Runtime validation, 1.5 Naming, 1. Shared Conventions, 2. `storage-errors.ts` — shared base (new file), 3.1 Transaction/Lease layer (+8 more)

### Community 24 - "Storage Algebra Lean Formalization — Approved M1 Design"
Cohesion: 0.05
Nodes (44): 10. Sprint 2 transaction/lease proposal, 11.1 Repository evidence, 11.2 External primary sources, 11. Evidence matrix, 12. Milestone status, 13. Approved implementation decisions, 1. Executive conclusion, 2.1 What is implemented at the baseline (+36 more)

### Community 25 - "ROADMAP.md"
Cohesion: 0.16
Nodes (10): For historical reference only, Phase → current status map, Tasks — superseded by per-sprint openspec changes, 0. Project setup, 1. TemporalKV, 2. Sprint close-out, Tasks — Sprint 1: project setup + TemporalKV, Performance (+2 more)

### Community 26 - "Design — Sprint 3: CheckpointStore"
Cohesion: 0.14
Nodes (14): 0. Package layout, 1. Chunking, 2.1 `ckpt_manifest_chunks` needs an explicit position, 2.2 `seq` needs an explicit allocator, 2.3 `complete`: kept, and explicitly written `true` by every `save()`, 2. Schema — two corrections to `design/design.md` §3, 3. `prune` — two-step GC, `design/design.md` §3's pass plus §2.1's cascade, 4. `load` — full verification, no exceptions (+6 more)

### Community 27 - "Sprint 1 test infrastructure (Testcontainers + fast-check)"
Cohesion: 0.20
Nodes (12): kv_current/kv_history temporal schema + trigger, Law T4: dual addressing agreement, Law T5: history non-overlap + gap-freedom, Testcontainers vs pg-mem test-infrastructure decision, Testcontainers (@testcontainers/postgresql), PgTemporalKV.getAt (single-statement UNION ALL), Property test P4 (Law T4), Property test P5 (Law T5) (+4 more)

### Community 28 - "Storage Algebra Lean M2 Retention Sprint"
Cohesion: 0.15
Nodes (12): Adversarial test matrix, Approved semantic decisions, Completed baseline, Executable pruning, Explicit non-goals, Extensional T5, Implemented source layout, Lookup classification (+4 more)

### Community 29 - "Design — Postgres+JSONB storage rebuild"
Cohesion: 0.17
Nodes (12): 0. How this reconciles with the Tier-2 (indexer) Postgres decision, 10. State-equivalence gate (merge blocker, mirrors the mongo-store Plan A/B gate), 1. Mongo-compatibility-shim tooling: evaluated and rejected, 2. TemporalKV → Postgres, 3. Checkpoint chunker (content-addressed, deduplicated), 4. Watermarks, 5. Commit/transaction layer, 6. Encrypted blob storage (`MongoPrivateStateProvider`/`MongoWalletStateStore`) (+4 more)

### Community 30 - "StorageError (shared base error class)"
Cohesion: 0.18
Nodes (13): CheckpointNotFoundError, Error-idiom unification (thrown, code-discriminated errors), Lease (opaque proof type), LeaseHeldByOtherError, LeaseTimeoutError, Rollback (deliberate rollback escape hatch), SerializationFailedError, StorageError (shared base error class) (+5 more)

### Community 31 - "Algebraic Specification of the midnight-pg-store Storage Layer"
Cohesion: 0.07
Nodes (23): Keep the knowledge graph current, sprint by sprint, UmbraDB — project instructions, Superseded — see `Formal/STORAGE_ALGEBRA.md`, Harder / genuinely novel — no existing precedent to lean on, Lean 4 Formalization Plan, Moderate effort, Near-term tractable — start here, Per-property guidance (+15 more)

### Community 32 - "SKILL.md"
Cohesion: 0.18
Nodes (10): Check for context, Ending Discovery, Guardrails, Handling Different Entry Points, OpenSpec Awareness, The Stance, What You Don't Have To Do, What You Might Do (+2 more)

### Community 33 - "Custom TypeScript Benchmark Harness"
Cohesion: 0.22
Nodes (9): Property Suite P1–P10, Structured Activity Logging, auto_explain Trigger Profiling, Custom TypeScript Benchmark Harness, Multi-GB Anti-Join Benchmark Gap, DB Activity Logging Scope, Benchmarking Scope, Performance Workstream (+1 more)

### Community 34 - "explore.md"
Cohesion: 0.20
Nodes (9): Check for context, Ending Discovery, Guardrails, OpenSpec Awareness, The Stance, What You Don't Have To Do, What You Might Do, When a change exists (+1 more)

### Community 35 - "Requirement: A caller-supplied transaction handle is honored or rejected, never silently ignored"
Cohesion: 0.22
Nodes (9): ADDED Requirements, MODIFIED Requirements, Requirement: A caller-supplied transaction handle is honored or rejected, never silently ignored, Requirement: TransactionKeyReuseError is now reachable through the public put() API, Scenario: A stale transaction handle is rejected before any query runs, Scenario: Two puts inside one withTransaction both commit together, Scenario: Two puts inside one withTransaction either both commit or neither does, Scenario: Two puts to the same key inside one transaction reject and roll back together, through the public API (+1 more)

### Community 36 - "Design — Sprint 2: Transaction/Lease"
Cohesion: 0.20
Nodes (10): 0. Package layout, 1. `withTransaction`, 2. The transaction-handle registry (the one new design decision this sprint makes), 3. Lease acquisition, release, and timeout, 3a. `raceAgainstAbort` — the real mid-wait cancellation `acquireLease`/`tryAcquireLease` need, 4. Wiring `PgTemporalKV`'s `opts.tx`, 5. Error translation additions (`src/postgres/errors.ts`), 6. Test infrastructure (+2 more)

### Community 37 - "ADDED Requirements"
Cohesion: 0.20
Nodes (10): ADDED Requirements, checkpoint-store (implementation), Requirement: load and history read a consistent snapshot immune to a concurrently-committing prune, Requirement: load rejects a manifest whose recorded chunk-hash sequence was tampered with, even when every chunk individually verifies, Requirement: load rejects a structurally-corrupt manifest with ManifestCorruptError, Requirement: save rejects invalid options with ValidationError before any chunking or hashing work, Scenario: A chunkSize above the schema's 16 MiB bound is rejected with no work done, Scenario: A manifest whose chunk-hash sequence was substituted is rejected even though every referenced chunk verifies and positions are dense (+2 more)

### Community 38 - "UmbraDB"
Cohesion: 0.22
Nodes (9): Architecture, Design, Formal verification, Getting started, Layout, License, Status, UmbraDB (+1 more)

### Community 39 - "Roadmap"
Cohesion: 0.22
Nodes (9): 1.0.0 acceptance checklist, Milestone 0 — Design (completed baseline), Milestone 1 — Formal (`Formal/`, in progress), Milestone 2 — Core implementation (current), Milestone 3 — Testing, Milestone 4 — Performance (`Performance/`), Milestone 5 — Cutover, Non-goals (+1 more)

### Community 40 - "Global Constraints"
Cohesion: 0.25
Nodes (7): Global Constraints, Plan Self-Review, Storage Algebra Lean M1 Implementation Plan, Task 1: Pin the project and prove the imported API smoke slice, Task 2: Implement the executable TemporalKV history kernel, Task 3: Prove the M1 TemporalKV theorem slice, Task 4: Add reproducible trust gates and close the M1 documentation loop

### Community 41 - "Shared Transactional Storage Algebra"
Cohesion: 0.25
Nodes (8): Abstract Model First Scope, L1 Transition-System Invariant, W1 Function.update Strategy, Law L1 Lease Mutual Exclusion, Law W1 Watermark Last-Write-Wins, Shared Transactional Storage Algebra, Lease Trace Type Model, Watermark Type Model

### Community 42 - "tasks.md"
Cohesion: 0.17
Nodes (11): PgTemporalKV.listKeys (cursor streaming), Property test P10 (Law L1), raceAgainstAbort (mid-wait cancellation), Law L1: mutual exclusion, Requirement: at most one holder per lease key (Law L1), 0. `PgTransactionLeaseLayer` — transactions, 1. `PgTransactionLeaseLayer` — leases, 2. Wire `PgTemporalKV`'s `opts.tx` (+3 more)

### Community 43 - "Scan-Based Mark-and-Sweep GC"
Cohesion: 0.25
Nodes (8): Timestamp GC Grace Window, Normalized Manifest–Chunk Junction, Scan-Based Mark-and-Sweep GC, GIN Scalar-Membership Mismatch, Git Grace-Window Precedent, Mark-and-Sweep over Reference Counting, Normalized Junction Table Decision, Reference-Counting Concurrency Race

### Community 44 - "Law C1 Save-Only Join Semilattice"
Cohesion: 0.38
Nodes (7): C1 SemilatticeSup Strategy, C2 Reachability Closure Strategy, Law C1 Save-Only Join Semilattice, Law C2a GC Safety, Law C2b Eventual Collection, No General Merkle Layer Decision, CheckpointStore Type Model

### Community 45 - "Watermarks interface"
Cohesion: 0.50
Nodes (4): ConnectionError, ValidationError, Watermarks interface, Sprint 1 error translation table (errors.ts)

### Community 46 - "Proposal — Postgres+JSONB storage rebuild (remove the MongoDB dependency)"
Cohesion: 0.40
Nodes (4): Impact, Proposal — Postgres+JSONB storage rebuild (remove the MongoDB dependency), What changes, Why

### Community 47 - "proposal.md"
Cohesion: 0.18
Nodes (10): Law T3: temporal-projection replay equivalence, State-equivalence gate (merge blocker), Property test P3 (Law T3 replay), Impact, Non-goals (explicitly out of scope for this sprint), Proposal — Sprint 1: project setup + TemporalKV, What changes, Why (+2 more)

### Community 48 - "Proposal — Sprint 2: Transaction/Lease"
Cohesion: 0.40
Nodes (5): Impact, Non-goals (explicitly out of scope for this sprint), Proposal — Sprint 2: Transaction/Lease, What changes, Why

### Community 49 - "PgTransactionLeaseLayer"
Cohesion: 0.33
Nodes (9): LeaseFaultError, acquireLease/tryAcquireLease implementation, Nested withTransaction limitation, PgTransactionLeaseLayer, releaseLease implementation, reserveBounded (bounded connection reservation), withTransaction implementation (sql.begin()), Composing Transaction/Lease internally (+1 more)

### Community 50 - "Requirement: Checkpoint sequence numbers are gapless, monotonic, and scoped per wallet+network"
Cohesion: 0.40
Nodes (5): Requirement: Checkpoint sequence numbers are gapless, monotonic, and scoped per wallet+network, Scenario: A rolled-back save consumes no sequence number, Scenario: Concurrent saves for one wallet+network still produce a gapless, non-repeating sequence, Scenario: Different wallet+network pairs have independent sequence counters, Scenario: Sequential saves for one wallet+network produce consecutive sequence numbers

### Community 51 - "Requirement: load and history distinguish "no checkpoint" from "checkpoint exists elsewhere""
Cohesion: 0.40
Nodes (5): Requirement: load and history distinguish "no checkpoint" from "checkpoint exists elsewhere", Scenario: history for a wallet+network with no checkpoints resolves empty, Scenario: No checkpoint exists for the wallet+network at all, Scenario: Omitting sequence loads the latest checkpoint, Scenario: The wallet+network has checkpoints but not at the requested sequence

### Community 52 - "GC architecture and query-tracing: research findings"
Cohesion: 0.40
Nodes (4): Decision: GC architecture, Decision: query tracing, GC architecture and query-tracing: research findings, What was checked and found NOT to hold up (excluded from the above)

### Community 53 - "Transaction-handle registry (registerTransaction/resolveTransaction)"
Cohesion: 0.40
Nodes (5): TransactionHandle (opaque handle type), opts.tx transaction-participation convention, Transaction-handle registry (registerTransaction/resolveTransaction), TransactionHandleInvalidError, Requirement: resolved handle always refers to its live transaction

### Community 54 - "Requirement: load always fully verifies chunk integrity before returning"
Cohesion: 0.50
Nodes (4): Requirement: load always fully verifies chunk integrity before returning, Scenario: A checkpoint whose stored chunk content matches its recorded hash loads successfully, Scenario: A chunk whose stored content no longer matches its recorded hash is rejected, Scenario: A manifest referencing a chunk absent from storage is rejected

### Community 55 - "Requirement: prune rejects a retainCount that is not a positive safe integer, before any deletion runs"
Cohesion: 0.50
Nodes (4): Requirement: prune rejects a retainCount that is not a positive safe integer, before any deletion runs, Scenario: A non-integer or non-finite retainCount is rejected with no effect, Scenario: An integer retainCount outside the safe integer range is rejected with no effect, Scenario: retainCount of zero is rejected with no effect

### Community 56 - "Requirement: A chunk still referenced by any surviving manifest is never reclaimed (Law C2a)"
Cohesion: 0.67
Nodes (3): Requirement: A chunk still referenced by any surviving manifest is never reclaimed (Law C2a), Scenario: A chunk shared across wallets survives one wallet's prune, Scenario: Interleaved save and prune never orphans a live manifest's chunk

### Community 57 - "Requirement: A manifest preserves the exact order and multiplicity of its chunks, including repeats"
Cohesion: 0.67
Nodes (3): Requirement: A manifest preserves the exact order and multiplicity of its chunks, including repeats, Scenario: A manifest's chunks are read back in position order regardless of storage order, Scenario: A payload containing a repeated chunk round-trips correctly

### Community 58 - "Requirement: An already-aborted opts.signal rejects before any database work; a signal aborting after the call has begun has no effect"
Cohesion: 0.67
Nodes (3): Requirement: An already-aborted opts.signal rejects before any database work; a signal aborting after the call has begun has no effect, Scenario: A call with an already-aborted signal is rejected before any database work, Scenario: A signal aborting after the call has begun does not interrupt it

### Community 59 - "Requirement: Checkpoint payloads are split into fixed-size chunks with a correctly-sized remainder"
Cohesion: 0.67
Nodes (3): Requirement: Checkpoint payloads are split into fixed-size chunks with a correctly-sized remainder, Scenario: A payload smaller than one chunk produces exactly one chunk, Scenario: A payload whose length is not a multiple of the chunk size produces a correctly-sized final chunk

### Community 60 - "Requirement: CheckpointSummary metadata is populated and label round-trips"
Cohesion: 0.67
Nodes (3): Requirement: CheckpointSummary metadata is populated and label round-trips, Scenario: A label given at save time is returned by history and load, Scenario: byteLength, chunkCount, and createdAt reflect the saved payload

### Community 61 - "Requirement: Chunk reclamation respects the grace window, protecting against re-reference races"
Cohesion: 0.67
Nodes (3): Requirement: Chunk reclamation respects the grace window, protecting against re-reference races, Scenario: A newly unreferenced chunk within the grace window is not reclaimed, Scenario: An unreferenced chunk past the grace window is eventually reclaimed

### Community 62 - "Requirement: Chunk storage is content-addressed and globally deduplicated"
Cohesion: 0.67
Nodes (3): Requirement: Chunk storage is content-addressed and globally deduplicated, Scenario: Identical chunk content across different checkpoints is stored once, Scenario: Re-referencing an existing chunk refreshes its GC clock

### Community 63 - "Requirement: history is newest-first, scoped per wallet+network, and supports cursor paging with no gap or duplicate"
Cohesion: 0.67
Nodes (3): Requirement: history is newest-first, scoped per wallet+network, and supports cursor paging with no gap or duplicate, Scenario: History for one wallet+network never includes another's checkpoints, Scenario: Paging with before continues without gap or duplicate

### Community 64 - "Requirement: manifestHash is computed once at write time from the ordered chunk-hash sequence"
Cohesion: 0.67
Nodes (3): Requirement: manifestHash is computed once at write time from the ordered chunk-hash sequence, Scenario: Identical payloads saved as separate checkpoints report the same manifestHash, Scenario: Payloads differing only in chunk order report different manifestHash

### Community 65 - "Requirement: prune retains exactly the N newest complete manifests per wallet+network"
Cohesion: 0.67
Nodes (3): Requirement: prune retains exactly the N newest complete manifests per wallet+network, Scenario: Pruning to retain k newest keeps exactly those k, Scenario: Pruning to retain the single newest manifest keeps only it

## Knowledge Gaps
- **411 isolated node(s):** `name`, `version`, `private`, `type`, `node` (+406 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `ADDED Requirements` connect `ADDED Requirements` to `Requirement: manifestHash is computed once at write time from the ordered chunk-hash sequence`, `Requirement: prune retains exactly the N newest complete manifests per wallet+network`, `Requirement: Checkpoint sequence numbers are gapless, monotonic, and scoped per wallet+network`, `Requirement: load and history distinguish "no checkpoint" from "checkpoint exists elsewhere"`, `Requirement: load always fully verifies chunk integrity before returning`, `Requirement: prune rejects a retainCount that is not a positive safe integer, before any deletion runs`, `Requirement: A chunk still referenced by any surviving manifest is never reclaimed (Law C2a)`, `Requirement: A manifest preserves the exact order and multiplicity of its chunks, including repeats`, `Requirement: An already-aborted opts.signal rejects before any database work; a signal aborting after the call has begun has no effect`, `Requirement: Checkpoint payloads are split into fixed-size chunks with a correctly-sized remainder`, `Requirement: CheckpointSummary metadata is populated and label round-trips`, `Requirement: Chunk reclamation respects the grace window, protecting against re-reference races`, `Requirement: Chunk storage is content-addressed and globally deduplicated`, `Requirement: history is newest-first, scoped per wallet+network, and supports cursor paging with no gap or duplicate`?**
  _High betweenness centrality (0.061) - this node is a cross-community bridge._
- **Why does `checkpoint-store (implementation)` connect `ADDED Requirements` to `spec.md`?**
  _High betweenness centrality (0.058) - this node is a cross-community bridge._
- **Why does `withTransaction implementation (sql.begin())` connect `PgTransactionLeaseLayer` to `spec.md`, `Transaction-handle registry (registerTransaction/resolveTransaction)`, `StorageError (shared base error class)`?**
  _High betweenness centrality (0.053) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _411 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `transaction-lease.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.08470588235294117 - nodes in this community are weakly interconnected._
- **Should `temporal-kv.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05720122574055159 - nodes in this community are weakly interconnected._
- **Should `spec.md` be split into smaller, more focused modules?**
  _Cohesion score 0.13333333333333333 - nodes in this community are weakly interconnected._