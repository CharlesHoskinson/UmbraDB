# Graph Report - UmbraDB-storage-algebra-lean  (2026-07-21)

## Corpus Check
- 87 files · ~125,816 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1019 nodes · 1599 edges · 69 communities (67 shown, 2 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 17 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `1f1675b3`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- checkpoint-store.ts
- transaction-lease.ts
- temporal-kv.ts
- TemporalKV Algebra
- ADDED Requirements
- Storage Algebra Lean Formalization — Approved Design and Status
- package.json
- ADDED Requirements
- OpenSpec CLI
- design-interfaces.md
- compilerOptions
- design.md
- Design — Sprint 4: Watermarks
- Proposal — Sprint 3: CheckpointStore
- spec.md
- design.md
- ADDED Requirements
- spec.md
- Requirement: A caller-supplied transaction handle is honored or rejected, never silently ignored
- tasks.md
- Requirements
- spec.md
- ADDED Requirements
- Performance — design
- Tasks — Sprint 3: CheckpointStore
- OpenSpec Store
- Design — Sprint 3: CheckpointStore
- Storage Algebra Lean M2 Retention Sprint
- Design — Postgres+JSONB storage rebuild
- LEAN_FORMALIZATION_PLAN.md
- design-algebra.md
- Design — Sprint 2: Transaction/Lease
- ADDED Requirements
- UmbraDB
- Roadmap
- Global Constraints
- Design — Sprint 1: project setup + TemporalKV
- Lean 4 Formalization Plan
- Algebraic Specification of the midnight-pg-store Storage Layer
- design.md
- Transaction/Lease Algebra
- Storage Types — reference for formalization
- Requirement: Checkpoint sequence numbers are gapless, monotonic, and scoped per wallet+network
- Requirement: load and history distinguish "no checkpoint" from "checkpoint exists elsewhere"
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
- temporal-kv.test.ts
- Storage Algebra Lean M3a Watermarks Sprint
- Design — Sprint 5: Lean M3a Watermarks W1
- Proposal — Sprint 5: Lean M3a Watermarks W1
- Tasks — Sprint 5: Lean M3a Watermarks W1
- Tasks — Sprint 1: project setup + TemporalKV
- Tasks — Sprint 2: Transaction/Lease
- design.md
- Transaction-handle registry (resolveTransaction)
- Proposal — Postgres+JSONB storage rebuild (remove the MongoDB dependency)
- pull_request_template.md
- AGENTS.md

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
- `PgTemporalKV.put three-statement-shape design` --implements--> `TemporalKV interface`  [EXTRACTED]
  openspec/changes/archive/2026-07-21-sprint-1-setup-and-temporal-kv/design.md → design/design-interfaces.md
- `PgTemporalKV.put three-statement-shape design` --references--> `VersionConflictError`  [EXTRACTED]
  openspec/changes/archive/2026-07-21-sprint-1-setup-and-temporal-kv/design.md → design/design-interfaces.md
- `REPEATABLE READ torn-read fix (load/history)` --conceptually_related_to--> `Global cross-wallet chunk GC reclamation fix`  [EXTRACTED]
  openspec/changes/sprint-3-checkpoint-store/design.md → design/design-interfaces.md
- `Large-integer decimal-string cursor convention` --references--> `Watermarks interface`  [EXTRACTED]
  openspec/changes/sprint-4-watermarks/design.md → design/design-interfaces.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Shared 'Store Selection' Convention Across All OpenSpec Commands/Skills** — claude_commands_opsx_apply, claude_commands_opsx_archive, claude_commands_opsx_explore, claude_commands_opsx_propose, claude_commands_opsx_sync, claude_commands_opsx_update, claude_skills_openspec_apply_change_skill, claude_skills_openspec_archive_change_skill, claude_skills_openspec_explore_skill, claude_skills_openspec_propose_skill, claude_skills_openspec_sync_specs_skill, claude_skills_openspec_update_change_skill, openspec_store_concept [EXTRACTED 1.00]
- **The Nine Laws Forming UmbraDB's Storage Algebra** — formal_storage_algebra_law_t1, formal_storage_algebra_law_t2, formal_storage_algebra_law_t3, formal_storage_algebra_law_t4, formal_storage_algebra_law_t5, formal_storage_algebra_law_c1, formal_storage_algebra_law_c2, formal_storage_algebra_law_w1, formal_storage_algebra_law_l1 [EXTRACTED 1.00]
- **Multi-Round Cross-Vendor Review Pipeline (Opus Panel + Fable 5 + Codex GPT-5.6 Sol Audit)** — roadmap, formal_storage_algebra, performance_gc_and_tracing_research, design_design_algebra [INFERRED 0.85]
- **Four storage modules unified under StorageError hierarchy** — design_design_interfaces_storageerror, design_design_interfaces_temporalkv, design_design_interfaces_checkpointstore, design_design_interfaces_watermarks, design_design_interfaces_transactionleaselayer_stale [EXTRACTED 1.00]
- **Modules composing the Sprint 2 transaction-handle registry** — sprint2_design_transaction_handle_registry, sprint1_design_pgtemporalkv_put, sprint3_design_torn_read_fix, sprint4_design_composing_txlease [EXTRACTED 1.00]
- **Pre-check-only withAbort cancellation pattern across sprints** — sprint1_design_listkeys_cursor, sprint2_design_withtransaction, sprint3_design_cancellation_scope_decision, sprint4_design_cancellation [INFERRED 0.85]

## Communities (69 total, 2 thin omitted)

### Community 0 - "checkpoint-store.ts"
Cohesion: 0.07
Nodes (35): CheckpointNotFoundError, CheckpointRecord, CheckpointSequence, CheckpointStore, CheckpointStoreError, CheckpointStoreErrorCode, CheckpointSummary, ChunkIntegrityError (+27 more)

### Community 1 - "transaction-lease.ts"
Cohesion: 0.07
Nodes (37): Lease, LeaseAcquireOptions, LeaseAcquireOptionsSchema, LeaseFaultError, LeaseNotHeldError, LeaseTimeoutError, Rollback, TransactionFaultError (+29 more)

### Community 2 - "temporal-kv.ts"
Cohesion: 0.08
Nodes (40): RFC-8259, AsOf, AssertExact, ExpectedVersionSchema, hasPostgresUnsafeText(), HistoryUnavailableError, JsonValue, jsonValueHasUnsafeText() (+32 more)

### Community 3 - "TemporalKV Algebra"
Cohesion: 0.32
Nodes (8): Law T1 — Gapless Monotonicity, Law T2 — CAS Guarded Partial Action, Law T3 — Temporal Projection, Law T4 — Dual-Addressing Agreement, Law T5 — Temporal Coherence, One-Write-Per-Key-Per-Transaction Rule, TemporalKV Algebra, TemporalKV Type Signatures

### Community 4 - "ADDED Requirements"
Cohesion: 0.11
Nodes (18): ADDED Requirements, formal-watermarks, Requirement: Command traces compose in list order, Requirement: Lookup after a trace returns the last matching value, Requirement: Set is an unconditional overwrite at the exact address, Requirement: Set preserves distinct addresses, Requirement: The abstract Watermarks store has one absence representation, Requirement: The W1 proof claim remains abstract (+10 more)

### Community 5 - "Storage Algebra Lean Formalization — Approved Design and Status"
Cohesion: 0.05
Nodes (44): 10. Sprint 2 transaction/lease proposal, 11.1 Repository evidence, 11.2 External primary sources, 11. Evidence matrix, 12. Milestone status, 13. Approved implementation decisions, 1. Executive conclusion, 2.1 Historical implementation baseline (+36 more)

### Community 6 - "package.json"
Cohesion: 0.07
Nodes (29): fast-check, dependencies, postgres, zod, devDependencies, fast-check, @testcontainers/postgresql, typedoc (+21 more)

### Community 7 - "ADDED Requirements"
Cohesion: 0.06
Nodes (33): ADDED Requirements, Requirement: A caller-supplied transaction handle is honored or rejected, never silently ignored, Requirement: A second write to the same key within one transaction is rejected at the trigger level, not silently absorbed, Requirement: Dual addressing agrees at recorded write timestamps (Law T4), Requirement: getAt satisfies temporal-projection equivalence (Law T3), within the store's retention window, Requirement: History intervals never overlap for a single key (Law T5), Requirement: listKeys streams without materializing the full result set first, and orders results correctly, Requirement: Migrations are idempotent and ordered (+25 more)

### Community 8 - "OpenSpec CLI"
Cohesion: 0.09
Nodes (25): Check for context, Ending Discovery, Guardrails, OpenSpec Awareness, The Stance, What You Don't Have To Do, What You Might Do, When a change exists (+17 more)

### Community 9 - "design-interfaces.md"
Cohesion: 0.06
Nodes (41): Module → Postgres module mapping table, private_state_salts table / per-scope salt derivation, 1.1 Error handling — one idiom: thrown, `code`-discriminated typed errors, 1.2 Async pattern, 1.3 Transaction participation, 1.4 Runtime validation, 1.5 Naming, 1. Shared Conventions (+33 more)

### Community 10 - "compilerOptions"
Cohesion: 0.14
Nodes (13): src/**/*.ts, test/**/*.ts, compilerOptions, declaration, esModuleInterop, module, moduleResolution, noEmit (+5 more)

### Community 11 - "design.md"
Cohesion: 0.14
Nodes (14): kv_history retention policy (pg_cron), postgres.js driver choice, kv_current/kv_history temporal-table design, Tier 1 / Tier 2 Postgres schema split, TransactionKeyReuseError / txid_current() fix, createClient connection factory (bigint/max fixes), Postgres error → StorageError translation table, getAt single-statement UNION ALL race fix (+6 more)

### Community 12 - "Design — Sprint 4: Watermarks"
Cohesion: 0.06
Nodes (35): watermarks table schema sketch, 0. Package layout, 10. Test infrastructure, 1. Schema — one physical-parameter correction to `design/design.md` §4, 2. `set`, 3. `get`, 4. Large-integer cursor values — a documented convention, not a schema change, 5. Accepted tradeoffs (explicit, not silently possible) (+27 more)

### Community 13 - "Proposal — Sprint 3: CheckpointStore"
Cohesion: 0.22
Nodes (8): Impact, Non-goals (explicitly out of scope for this sprint), Proposal — Sprint 3: CheckpointStore, What changes, Why, ckpt_manifest_chunks position + ON DELETE CASCADE fix, Sprint 3 schema changes (position/cascade, seq, metadata cols), Manifest preserves order/multiplicity of chunks requirement

### Community 14 - "spec.md"
Cohesion: 0.17
Nodes (11): Fixed-size chunk splitting requirement, Content-addressed global chunk dedup requirement, history cursor paging no-gap/no-duplicate requirement, load always fully verifies chunk integrity, ManifestCorruptError position-gap requirement, manifestHash computed once at write time, ManifestCorruptError chunk-hash-sequence tamper requirement, CheckpointNotFoundError vs empty-history distinction (+3 more)

### Community 15 - "design.md"
Cohesion: 0.23
Nodes (10): Content-addressed checkpoint chunker, ckpt_manifest_chunks junction table (original, later corrected), FerretDB Mongo-compatibility shim evaluated and rejected, State-equivalence merge-blocker gate, Testcontainers vs pg-mem test-infrastructure decision, midnight-pg-store new package, Remove MongoDB dependency rationale, Retired 11-phase task plan (+2 more)

### Community 16 - "ADDED Requirements"
Cohesion: 0.06
Nodes (33): ADDED Requirements, Requirement: A lease timeout surfaces distinctly for acquireLease vs. tryAcquireLease, Requirement: A resolved transaction handle always refers to its own live transaction, Requirement: A transaction timeout surfaces as TransactionFaultError, Requirement: Aborting opts.signal before withTransaction starts rejects with AbortError, Requirement: Aborting opts.signal during lease acquisition rejects with AbortError, Requirement: acquireLease waits indefinitely absent a timeout; tryAcquireLease never blocks unboundedly, Requirement: At most one holder per lease key at any instant (Law L1) (+25 more)

### Community 17 - "spec.md"
Cohesion: 0.29
Nodes (7): Transactions commit or roll back atomically, Connection loss surfaces as LeaseFaultError, Resolved transaction handle always refers to its own live transaction, Lease timeout distinct for acquireLease vs tryAcquireLease, releaseLease rejects a lease that is not currently held, Transaction timeout surfaces as TransactionFaultError, withLease always releases its lease, even when fn throws

### Community 18 - "Requirement: A caller-supplied transaction handle is honored or rejected, never silently ignored"
Cohesion: 0.22
Nodes (9): ADDED Requirements, MODIFIED Requirements, Requirement: A caller-supplied transaction handle is honored or rejected, never silently ignored, Requirement: TransactionKeyReuseError is now reachable through the public put() API, Scenario: A stale transaction handle is rejected before any query runs, Scenario: Two puts inside one withTransaction both commit together, Scenario: Two puts inside one withTransaction either both commit or neither does, Scenario: Two puts to the same key inside one transaction reject and roll back together, through the public API (+1 more)

### Community 19 - "tasks.md"
Cohesion: 0.33
Nodes (5): For historical reference only, Phase → current status map, Tasks — superseded by per-sprint openspec changes, OpenSpec project config (spec-driven schema), Correctness rule: verify external claims against real source

### Community 20 - "Requirements"
Cohesion: 0.06
Nodes (32): Requirement: A caller-supplied transaction handle is honored or rejected, never silently ignored, Requirement: A second write to the same key within one transaction is rejected at the trigger level, not silently absorbed, Requirement: Dual addressing agrees at recorded write timestamps (Law T4), Requirement: getAt satisfies temporal-projection equivalence (Law T3), within the store's retention window, Requirement: History intervals never overlap for a single key (Law T5), Requirement: listKeys streams without materializing the full result set first, and orders results correctly, Requirement: Migrations are idempotent and ordered, Requirement: Postgres errors surface as the shared StorageError hierarchy (+24 more)

### Community 21 - "spec.md"
Cohesion: 0.17
Nodes (10): Purpose, temporal-kv Specification, Postgres errors surface as StorageError hierarchy requirement, Law T1: gapless monotonic versions requirement, Law T3: temporal-projection equivalence (getAt), Law T4: dual addressing agreement, Law T5: history intervals never overlap, listKeys streaming/order requirement (+2 more)

### Community 22 - "ADDED Requirements"
Cohesion: 0.06
Nodes (31): ADDED Requirements, Requirement: a caller-supplied transaction handle is honored, not silently ignored, Requirement: a non-object JSON value round-trips correctly, Requirement: an already-aborted opts.signal rejects before any statement; a later abort has no effect, Requirement: get never throws for an unset cursor, Requirement: get returns exactly the last value set, scoped per (kind, key), Requirement: Postgres errors surface as the shared StorageError hierarchy, Requirement: set is an idempotent, unconditional overwrite (Law W1) (+23 more)

### Community 23 - "Performance — design"
Cohesion: 0.12
Nodes (13): 1. Postgres-side profiling, 2. Node-side query correlation, 3. GC architecture (the load-bearing decision), 4. Benchmark harness, 5. Activity logging, Performance — design, diagnostics_channel/tracingChannel Instrumentation Design, Decision: GC architecture (+5 more)

### Community 24 - "Tasks — Sprint 3: CheckpointStore"
Cohesion: 0.11
Nodes (16): 0. Preconditions and schema, 1. Chunking and write path, 2. Read path, 3. GC (`prune`), 4. Property tests (`Formal/STORAGE_ALGEBRA.md` §5), 5. Sprint close-out, Tasks — Sprint 3: CheckpointStore, 0. Schema (+8 more)

### Community 26 - "Design — Sprint 3: CheckpointStore"
Cohesion: 0.14
Nodes (14): 0. Package layout, 1. Chunking, 2.1 `ckpt_manifest_chunks` needs an explicit position, 2.2 `seq` needs an explicit allocator, 2.3 `complete`: kept, and explicitly written `true` by every `save()`, 2. Schema — two corrections to `design/design.md` §3, 3. `prune` — two-step GC, `design/design.md` §3's pass plus §2.1's cascade, 4. `load` — full verification, no exceptions (+6 more)

### Community 27 - "Storage Algebra Lean M2 Retention Sprint"
Cohesion: 0.15
Nodes (12): Adversarial test matrix, Approved semantic decisions, Completed baseline, Executable pruning, Explicit non-goals, Extensional T5, Implemented source layout, Lookup classification (+4 more)

### Community 28 - "Design — Postgres+JSONB storage rebuild"
Cohesion: 0.17
Nodes (12): 0. How this reconciles with the Tier-2 (indexer) Postgres decision, 10. State-equivalence gate (merge blocker, mirrors the mongo-store Plan A/B gate), 1. Mongo-compatibility-shim tooling: evaluated and rejected, 2. TemporalKV → Postgres, 3. Checkpoint chunker (content-addressed, deduplicated), 4. Watermarks, 5. Commit/transaction layer, 6. Encrypted blob storage (`MongoPrivateStateProvider`/`MongoWalletStateStore`) (+4 more)

### Community 29 - "LEAN_FORMALIZATION_PLAN.md"
Cohesion: 0.23
Nodes (6): Keep-Knowledge-Graph-Current Policy, Keep the knowledge graph current, sprint by sprint, UmbraDB — project instructions, Abstract-Model-First Scope Decision, OpenSpec Change, Custom Node/TypeScript Benchmark Harness

### Community 30 - "design-algebra.md"
Cohesion: 0.24
Nodes (9): Superseded — see `Formal/STORAGE_ALGEBRA.md`, crdt-lean Dependency Refutation, CheckpointStore Algebra, ckpt_manifest_chunks Junction Table, Law C1 — Join-Semilattice Chunk Writes, Law C2 — GC Reachability Closure, Decision Against a Merkle/Authenticated Data Structure, CheckpointStore Type Signatures (+1 more)

### Community 31 - "Design — Sprint 2: Transaction/Lease"
Cohesion: 0.20
Nodes (10): 0. Package layout, 1. `withTransaction`, 2. The transaction-handle registry (the one new design decision this sprint makes), 3. Lease acquisition, release, and timeout, 3a. `raceAgainstAbort` — the real mid-wait cancellation `acquireLease`/`tryAcquireLease` need, 4. Wiring `PgTemporalKV`'s `opts.tx`, 5. Error translation additions (`src/postgres/errors.ts`), 6. Test infrastructure (+2 more)

### Community 32 - "ADDED Requirements"
Cohesion: 0.20
Nodes (10): ADDED Requirements, checkpoint-store (implementation), Requirement: load and history read a consistent snapshot immune to a concurrently-committing prune, Requirement: load rejects a manifest whose recorded chunk-hash sequence was tampered with, even when every chunk individually verifies, Requirement: load rejects a structurally-corrupt manifest with ManifestCorruptError, Requirement: save rejects invalid options with ValidationError before any chunking or hashing work, Scenario: A chunkSize above the schema's 16 MiB bound is rejected with no work done, Scenario: A manifest whose chunk-hash sequence was substituted is rejected even though every referenced chunk verifies and positions are dense (+2 more)

### Community 33 - "UmbraDB"
Cohesion: 0.22
Nodes (9): Architecture, Design, Formal verification, Getting started, Layout, License, Status, UmbraDB (+1 more)

### Community 34 - "Roadmap"
Cohesion: 0.22
Nodes (9): 1.0.0 acceptance checklist, Milestone 0 — Design (completed baseline), Milestone 1 — Formal (`Formal/`, in progress), Milestone 2 — Core implementation (module implementations complete), Milestone 3 — Testing (current), Milestone 4 — Performance (`Performance/`), Milestone 5 — Cutover, Non-goals (+1 more)

### Community 35 - "Global Constraints"
Cohesion: 0.25
Nodes (7): Global Constraints, Plan Self-Review, Storage Algebra Lean M1 Implementation Plan, Task 1: Pin the project and prove the imported API smoke slice, Task 2: Implement the executable TemporalKV history kernel, Task 3: Prove the M1 TemporalKV theorem slice, Task 4: Add reproducible trust gates and close the M1 documentation loop

### Community 36 - "Design — Sprint 1: project setup + TemporalKV"
Cohesion: 0.25
Nodes (8): 0. Schema naming, now that UmbraDB is standalone, 1. Package layout, 2. Migration mechanism, 3. Connection factory (`src/postgres/client.ts`), 4. `PgTemporalKV` adapter (`src/postgres/temporal-kv.ts`), 4a. Error translation (`src/postgres/errors.ts`), 5. Test infrastructure, Design — Sprint 1: project setup + TemporalKV

### Community 37 - "Lean 4 Formalization Plan"
Cohesion: 0.29
Nodes (7): Harder / genuinely novel — no existing precedent to lean on, Lean 4 Formalization Plan, Moderate effort, Near-term tractable — start here, Per-property guidance, Process note, Scope decision: abstract model first, implementation trusted-but-unverified

### Community 38 - "Algebraic Specification of the midnight-pg-store Storage Layer"
Cohesion: 0.29
Nodes (7): 1. TemporalKV — event-sourced right action with a CAS guard, 2. CheckpointStore — idempotent join-semilattice with a reachability closure, 3. Watermarks — trivial last-write-wins (deliberately *not* event-sourced), 4. Transaction / Lease — the control algebra the other three run inside, 5. Testable-law deliverable (fast-check + Vitest), 6. On not adding a Merkle/authenticated data structure, Algebraic Specification of the midnight-pg-store Storage Layer

### Community 39 - "design.md"
Cohesion: 0.13
Nodes (15): Advisory-lock class registry (classes 1/2/3), Postgres advisory-lock writer lease (corrected design), Phase → sprint status map, Impact, Non-goals (explicitly out of scope for this sprint), Proposal — Sprint 2: Transaction/Lease, What changes, Why (+7 more)

### Community 40 - "Transaction/Lease Algebra"
Cohesion: 0.33
Nodes (6): Law L1 — Lease Mutual Exclusion, Law W1 — Last-Write-Wins, Transaction/Lease Algebra, Watermarks Algebra, Transaction/Lease Type Signatures, Watermarks Type Signatures

### Community 41 - "Storage Types — reference for formalization"
Cohesion: 0.33
Nodes (6): CheckpointStore (`src/interfaces/checkpoint-store.ts`), Storage Types — reference for formalization, TemporalKV (`src/interfaces/temporal-kv.ts`), Transaction/Lease (`src/interfaces/transaction-lease.ts`), Watermarks (`src/interfaces/watermarks.ts`), What's NOT in scope for this formalization

### Community 42 - "Requirement: Checkpoint sequence numbers are gapless, monotonic, and scoped per wallet+network"
Cohesion: 0.40
Nodes (5): Requirement: Checkpoint sequence numbers are gapless, monotonic, and scoped per wallet+network, Scenario: A rolled-back save consumes no sequence number, Scenario: Concurrent saves for one wallet+network still produce a gapless, non-repeating sequence, Scenario: Different wallet+network pairs have independent sequence counters, Scenario: Sequential saves for one wallet+network produce consecutive sequence numbers

### Community 43 - "Requirement: load and history distinguish "no checkpoint" from "checkpoint exists elsewhere""
Cohesion: 0.40
Nodes (5): Requirement: load and history distinguish "no checkpoint" from "checkpoint exists elsewhere", Scenario: history for a wallet+network with no checkpoints resolves empty, Scenario: No checkpoint exists for the wallet+network at all, Scenario: Omitting sequence loads the latest checkpoint, Scenario: The wallet+network has checkpoints but not at the requested sequence

### Community 44 - "Requirement: load always fully verifies chunk integrity before returning"
Cohesion: 0.50
Nodes (4): Requirement: load always fully verifies chunk integrity before returning, Scenario: A checkpoint whose stored chunk content matches its recorded hash loads successfully, Scenario: A chunk whose stored content no longer matches its recorded hash is rejected, Scenario: A manifest referencing a chunk absent from storage is rejected

### Community 45 - "Requirement: prune rejects a retainCount that is not a positive safe integer, before any deletion runs"
Cohesion: 0.50
Nodes (4): Requirement: prune rejects a retainCount that is not a positive safe integer, before any deletion runs, Scenario: A non-integer or non-finite retainCount is rejected with no effect, Scenario: An integer retainCount outside the safe integer range is rejected with no effect, Scenario: retainCount of zero is rejected with no effect

### Community 46 - "Requirement: A chunk still referenced by any surviving manifest is never reclaimed (Law C2a)"
Cohesion: 0.67
Nodes (3): Requirement: A chunk still referenced by any surviving manifest is never reclaimed (Law C2a), Scenario: A chunk shared across wallets survives one wallet's prune, Scenario: Interleaved save and prune never orphans a live manifest's chunk

### Community 47 - "Requirement: A manifest preserves the exact order and multiplicity of its chunks, including repeats"
Cohesion: 0.67
Nodes (3): Requirement: A manifest preserves the exact order and multiplicity of its chunks, including repeats, Scenario: A manifest's chunks are read back in position order regardless of storage order, Scenario: A payload containing a repeated chunk round-trips correctly

### Community 48 - "Requirement: An already-aborted opts.signal rejects before any database work; a signal aborting after the call has begun has no effect"
Cohesion: 0.67
Nodes (3): Requirement: An already-aborted opts.signal rejects before any database work; a signal aborting after the call has begun has no effect, Scenario: A call with an already-aborted signal is rejected before any database work, Scenario: A signal aborting after the call has begun does not interrupt it

### Community 49 - "Requirement: Checkpoint payloads are split into fixed-size chunks with a correctly-sized remainder"
Cohesion: 0.67
Nodes (3): Requirement: Checkpoint payloads are split into fixed-size chunks with a correctly-sized remainder, Scenario: A payload smaller than one chunk produces exactly one chunk, Scenario: A payload whose length is not a multiple of the chunk size produces a correctly-sized final chunk

### Community 50 - "Requirement: CheckpointSummary metadata is populated and label round-trips"
Cohesion: 0.67
Nodes (3): Requirement: CheckpointSummary metadata is populated and label round-trips, Scenario: A label given at save time is returned by history and load, Scenario: byteLength, chunkCount, and createdAt reflect the saved payload

### Community 51 - "Requirement: Chunk reclamation respects the grace window, protecting against re-reference races"
Cohesion: 0.67
Nodes (3): Requirement: Chunk reclamation respects the grace window, protecting against re-reference races, Scenario: A newly unreferenced chunk within the grace window is not reclaimed, Scenario: An unreferenced chunk past the grace window is eventually reclaimed

### Community 52 - "Requirement: Chunk storage is content-addressed and globally deduplicated"
Cohesion: 0.67
Nodes (3): Requirement: Chunk storage is content-addressed and globally deduplicated, Scenario: Identical chunk content across different checkpoints is stored once, Scenario: Re-referencing an existing chunk refreshes its GC clock

### Community 53 - "Requirement: history is newest-first, scoped per wallet+network, and supports cursor paging with no gap or duplicate"
Cohesion: 0.67
Nodes (3): Requirement: history is newest-first, scoped per wallet+network, and supports cursor paging with no gap or duplicate, Scenario: History for one wallet+network never includes another's checkpoints, Scenario: Paging with before continues without gap or duplicate

### Community 54 - "Requirement: manifestHash is computed once at write time from the ordered chunk-hash sequence"
Cohesion: 0.67
Nodes (3): Requirement: manifestHash is computed once at write time from the ordered chunk-hash sequence, Scenario: Identical payloads saved as separate checkpoints report the same manifestHash, Scenario: Payloads differing only in chunk order report different manifestHash

### Community 55 - "Requirement: prune retains exactly the N newest complete manifests per wallet+network"
Cohesion: 0.67
Nodes (3): Requirement: prune retains exactly the N newest complete manifests per wallet+network, Scenario: Pruning to retain k newest keeps exactly those k, Scenario: Pruning to retain the single newest manifest keeps only it

### Community 57 - "temporal-kv.test.ts"
Cohesion: 0.06
Nodes (23): assertNoConflictingSearchPath(), assertValidSchemaName(), createClient(), UmbraDBConnectionOptions, UmbraDBSql, ExclusionViolationError, Migration, migrations (+15 more)

### Community 58 - "Storage Algebra Lean M3a Watermarks Sprint"
Cohesion: 0.25
Nodes (7): Adversarial examples, Audited semantic decisions, Explicit non-goals, Source layout, Storage Algebra Lean M3a Watermarks Sprint, Theorem gate, Verification matrix

### Community 59 - "Design — Sprint 5: Lean M3a Watermarks W1"
Cohesion: 0.29
Nodes (6): 1. Executable carrier, 2. Commands and interpretation, 3. Laws, 4. Trust and reachability, 5. Refinement boundary, Design — Sprint 5: Lean M3a Watermarks W1

### Community 60 - "Proposal — Sprint 5: Lean M3a Watermarks W1"
Cohesion: 0.33
Nodes (5): Impact, Non-goals, Proposal — Sprint 5: Lean M3a Watermarks W1, What changes, Why

### Community 61 - "Tasks — Sprint 5: Lean M3a Watermarks W1"
Cohesion: 0.33
Nodes (5): 0. Specification freeze, 1. Executable Watermarks model, 2. W1 theorem tranche, 3. Close-out, Tasks — Sprint 5: Lean M3a Watermarks W1

### Community 62 - "Tasks — Sprint 1: project setup + TemporalKV"
Cohesion: 0.50
Nodes (4): 0. Project setup, 1. TemporalKV, 2. Sprint close-out, Tasks — Sprint 1: project setup + TemporalKV

### Community 65 - "Tasks — Sprint 2: Transaction/Lease"
Cohesion: 0.22
Nodes (8): 0. `PgTransactionLeaseLayer` — transactions, 1. `PgTransactionLeaseLayer` — leases, 2. Wire `PgTemporalKV`'s `opts.tx`, 3. Sprint close-out, Tasks — Sprint 2: Transaction/Lease, listKeys cursor streaming + prefix escaping, raceAgainstAbort mid-wait cancellation, Sprint 2 close-out / two-round audit findings

### Community 68 - "design.md"
Cohesion: 0.17
Nodes (12): withTransaction (sql.begin) implementation, Aborting opts.signal pre-check-only contract (withTransaction), CheckpointStore cancellation scope decision (pre-check only), complete flag explicit-write requirement, history pagination query, load full chunk-integrity + manifest verification, manifest_hash tamper-detection verification, prune two-step manifest-then-chunk GC pass (+4 more)

### Community 71 - "Transaction-handle registry (resolveTransaction)"
Cohesion: 0.38
Nodes (7): PgTemporalKV.put three-statement-shape design, Transaction handle rejected (Sprint 1, later superseded), Transaction-handle registry (resolveTransaction), Transaction handle honored (MODIFIED, supersedes Sprint 1), ckpt_sequence_counters atomic upsert-increment allocator, Gapless monotonic sequence numbers requirement, PgWatermarks.set upsert implementation

### Community 72 - "Proposal — Postgres+JSONB storage rebuild (remove the MongoDB dependency)"
Cohesion: 0.50
Nodes (4): Impact, Proposal — Postgres+JSONB storage rebuild (remove the MongoDB dependency), What changes, Why

### Community 73 - "pull_request_template.md"
Cohesion: 0.50
Nodes (3): Change summary, Mandatory Codex audit, Validation

## Knowledge Gaps
- **469 isolated node(s):** `name`, `version`, `private`, `type`, `node` (+464 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Storage Algebra Lean Formalization — Approved Design and Status` connect `Storage Algebra Lean Formalization — Approved Design and Status` to `LEAN_FORMALIZATION_PLAN.md`?**
  _High betweenness centrality (0.094) - this node is a cross-community bridge._
- **Why does `ADDED Requirements` connect `ADDED Requirements` to `Requirement: Checkpoint sequence numbers are gapless, monotonic, and scoped per wallet+network`, `Requirement: load and history distinguish "no checkpoint" from "checkpoint exists elsewhere"`, `Requirement: load always fully verifies chunk integrity before returning`, `Requirement: prune rejects a retainCount that is not a positive safe integer, before any deletion runs`, `Requirement: A chunk still referenced by any surviving manifest is never reclaimed (Law C2a)`, `Requirement: A manifest preserves the exact order and multiplicity of its chunks, including repeats`, `Requirement: An already-aborted opts.signal rejects before any database work; a signal aborting after the call has begun has no effect`, `Requirement: Checkpoint payloads are split into fixed-size chunks with a correctly-sized remainder`, `Requirement: CheckpointSummary metadata is populated and label round-trips`, `Requirement: Chunk reclamation respects the grace window, protecting against re-reference races`, `Requirement: Chunk storage is content-addressed and globally deduplicated`, `Requirement: history is newest-first, scoped per wallet+network, and supports cursor paging with no gap or duplicate`, `Requirement: manifestHash is computed once at write time from the ordered chunk-hash sequence`, `Requirement: prune retains exactly the N newest complete manifests per wallet+network`?**
  _High betweenness centrality (0.082) - this node is a cross-community bridge._
- **Why does `checkpoint-store (implementation)` connect `ADDED Requirements` to `spec.md`?**
  _High betweenness centrality (0.080) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _469 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `checkpoint-store.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06634615384615385 - nodes in this community are weakly interconnected._
- **Should `transaction-lease.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06547619047619048 - nodes in this community are weakly interconnected._
- **Should `temporal-kv.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.08209255533199195 - nodes in this community are weakly interconnected._