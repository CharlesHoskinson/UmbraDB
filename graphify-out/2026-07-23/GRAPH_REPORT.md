# Graph Report - UmbraDB  (2026-07-23)

## Corpus Check
- 212 files · ~333,386 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2167 nodes · 3130 edges · 199 communities (141 shown, 58 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 19 edges (avg confidence: 0.69)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `626af171`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- ADDED Requirements
- transaction-lease.ts
- temporal-kv.ts
- ADDED Requirements
- scoped-review-manifest
- Storage Algebra Lean Formalization — Approved Design and Status
- devDependencies
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
- Tasks — Sprint 7: Transaction History Storage
- Watermarks Postgres errors surface as StorageError requirement
- get never throws for an unset cursor requirement
- get returns last value scoped per (kind,key) requirement
- private_state_salts table / per-scope salt derivation
- set ValidationError before statement requirement
- Sprint 5 Recommendation — Wallet Integration Surface (TransactionHistoryStorage + Live-Sync Conformance)
- Watermarks AbortSignal pre-check-only requirement
- Design — Sprint 7: Transaction History Storage
- Top-level null value application-level guard
- Proposal — Sprint 7: Transaction History Storage (Wallet Integration Surface)
- complete flag explicit-write requirement
- pg-tx-history-adapter.ts
- CheckpointStore cancellation scope decision (pre-check only)
- transaction-history-storage.test.ts
- ADDED Requirements
- pull_request_template.md
- AGENTS.md
- client.ts
- ADDED Requirements
- ADDED Requirements
- checkpoint-store.ts
- transaction-history-storage.property.test.ts
- Autonomous run log
- Design — Sprint 8: WalletState Envelope + Live Preprod DB-Sync + Cold-Boot Recovery
- transaction-history-storage.ts
- ADDED Requirements
- transaction-history-storage.ts
- UmbraDBSql
- TransactionHistoryEntry
- ADDED Requirements
- Storage Algebra Lean M3a Watermarks Sprint
- UmbraDB dev environment — master runbook
- Sprint 7 — Midnight preprod toolchain inventory & build checklist
- Design — Sprint 5: Lean M3a Watermarks W1
- Tasks — Sprint 8: WalletState Envelope + Live Preprod DB-Sync + Cold-Boot Recovery
- Midnight infra verification checklist
- Proposal — Sprint 8: WalletState Envelope + Live Preprod DB-Sync + Cold-Boot Recovery
- Preprod connection — endpoints, wallet, faucet
- Environment changelog
- sync-service.ts
- ADDED Requirements
- Proposal — Sprint 5: Lean M3a Watermarks W1
- Tasks — Sprint 5: Lean M3a Watermarks W1
- ADDED Requirements
- ADDED Requirements
- Full-Chain Storage — Design
- ADDED Requirements
- Design — v1.0.0-durable-checkpoint-cursor
- cold-boot-recovery.integration.test.ts
- errors.ts
- chain_archive lineage
- ADDED Requirements
- Design — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)
- NodeRpcClient
- chain-archive-store.ts
- Design — v1.0.0 API Surface & Release Contract
- chain-archive-sync-retry.integration.test.ts
- Design — Sprint 3: CheckpointStore
- ChainArchiveStore
- tx-replay-decoder.ts
- Design — Sprint 4: Watermarks
- chain-archive-rollover.ts
- Design — Postgres+JSONB storage rebuild
- Tasks — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)
- UmbraDB
- Full-Chain Storage
- Storage Algebra Lean M3b CheckpointStore C1 Sprint
- Design — Sprint 6: Lean M3b CheckpointStore C1
- Proposal — Sprint 6: Lean M3b CheckpointStore C1
- Tasks — Sprint 6: Lean M3b CheckpointStore C1
- 3. Proof-blocking findings
- Design — Sprint 2: Transaction/Lease
- ADDED Requirements
- Tasks — v1.0.0 API Surface & Release Contract
- Design — v1.0.0-perf-baseline
- Acceptance criteria — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)
- explore.md
- Storage Layer Interface Specification
- Requirement: A caller-supplied transaction handle is honored or rejected, never silently ignored
- Design — v1.0.0-infosec-signoff
- Roadmap
- Feasibility: TLS for the Cardano db-sync database (Midnight partner-chain follower)
- STORAGE_ALGEBRA_LEAN_RESEARCH.md
- Design — Sprint 1: project setup + TemporalKV
- Acceptance — v1.0.0 API Surface & Release Contract
- Graph-scoped review policy
- README.md
- ROADMAP.md
- Lean 4 Formalization Plan
- Tasks — Sprint 3: CheckpointStore
- Tasks — Sprint 4: Watermarks
- Acceptance criteria — v1.0.0-infosec-signoff
- Tasks — v1.0.0-infosec-signoff
- 12. Milestone status
- 5. Recommended candidate model
- Acceptance — v1.0.0-durable-checkpoint-cursor
- Tasks — v1.0.0-durable-checkpoint-cursor
- Proposal — v1.0.0-perf-baseline
- Performance — design
- 1. Shared Conventions
- Proposal — Sprint 1: project setup + TemporalKV
- Proposal — Sprint 2: Transaction/Lease
- Tasks — Sprint 2: Transaction/Lease
- Proposal — Sprint 3: CheckpointStore
- Proposal — Sprint 4: Watermarks
- Proposal — v1.0.0 API Surface & Release Contract
- Proposal — v1.0.0-durable-checkpoint-cursor
- Proposal — v1.0.0-infosec-signoff
- Tasks — v1.0.0-perf-baseline
- Proposal — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)
- chain-archive-replay-decode.integration.test.ts
- no-chain-sync-import-guard.test.ts
- Tasks — Sprint 1: project setup + TemporalKV
- Requirement: Checkpoint sequence numbers are gapless, monotonic, and scoped per wallet+network
- Requirement: load and history distinguish "no checkpoint" from "checkpoint exists elsewhere"
- Acceptance criteria — v1.0.0-perf-baseline
- GC architecture and query-tracing: research findings
- 9. Trust and refinement boundary
- Requirement: load always fully verifies chunk integrity before returning
- Requirement: prune rejects a retainCount that is not a positive safe integer, before any deletion runs
- start-stack.sh
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
- backup-state.sh
- enable-db-sync-tls.sh
- restore-state.sh
- stop-stack.sh
- README.md

## God Nodes (most connected - your core abstractions)
1. `UmbraDBSql` - 53 edges
2. `translatePostgresError()` - 47 edges
3. `TransactionHandle` - 38 edges
4. `ValidationError` - 25 edges
5. `TransactionHistoryEntry` - 25 edges
6. `PgChainArchiveStore` - 25 edges
7. `StorageError` - 22 edges
8. `createClient()` - 21 edges
9. `resolveTransaction()` - 21 edges
10. `withAbort()` - 20 edges

## Surprising Connections (you probably didn't know these)
- `FakeChainBlock` --references--> `Hex32`  [EXTRACTED]
  test/integration/chain-archive-sync-retry.integration.test.ts → src/interfaces/chain-archive-store.ts
- `insertRawRow()` --references--> `UmbraDBSql`  [EXTRACTED]
  test/postgres/transaction-history-storage.test.ts → src/postgres/client.ts
- `Correctness rule: verify external claims against real source` --rationale_for--> `kv_current/kv_history temporal-table design`  [INFERRED]
  openspec/config.yaml → design/design.md
- `bootstrapChainArchiveSchema()` --calls--> `runMigrations()`  [EXTRACTED]
  chain-archive-sync/bootstrap.ts → src/postgres/migrate.ts
- `ChainArchiveSyncServiceOptions` --references--> `UmbraDBSql`  [EXTRACTED]
  chain-archive-sync/sync-service.ts → src/postgres/client.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **The Nine Laws Forming UmbraDB's Storage Algebra** — formal_storage_algebra_law_t1, formal_storage_algebra_law_t2, formal_storage_algebra_law_t3, formal_storage_algebra_law_t4, formal_storage_algebra_law_t5, formal_storage_algebra_law_c1, formal_storage_algebra_law_c2, formal_storage_algebra_law_w1, formal_storage_algebra_law_l1 [EXTRACTED 1.00]
- **Four storage modules unified under StorageError hierarchy** — design_design_interfaces_storageerror, design_design_interfaces_temporalkv, design_design_interfaces_checkpointstore, design_design_interfaces_watermarks, design_design_interfaces_transactionleaselayer_stale [EXTRACTED 1.00]
- **Modules composing the Sprint 2 transaction-handle registry** — sprint2_design_transaction_handle_registry, sprint1_design_pgtemporalkv_put, sprint3_design_torn_read_fix, sprint4_design_composing_txlease [EXTRACTED 1.00]
- **Pre-check-only withAbort cancellation pattern across sprints** — sprint1_design_listkeys_cursor, sprint2_design_withtransaction, sprint3_design_cancellation_scope_decision, sprint4_design_cancellation [INFERRED 0.85]

## Communities (199 total, 58 thin omitted)

### Community 0 - "ADDED Requirements"
Cohesion: 0.04
Nodes (45): ADDED Requirements, release-contract, Requirement: A cancellation contract states the abort guarantee as public behavior, Requirement: A CHANGELOG records the 1.0.0 surface, Requirement: A durability contract states the ordering guarantee and its binding precondition, Requirement: A format-headroom note reserves keyed/encrypted chunk modes for 1.1, Requirement: A forward-only migration contract states there is no supported downgrade, Requirement: A lease-limitation contract states the single-process boundary (+37 more)

### Community 1 - "transaction-lease.ts"
Cohesion: 0.05
Nodes (36): Lease, LeaseAcquireOptions, LeaseAcquireOptionsSchema, LeaseFaultError, LeaseNotHeldError, LeaseTimeoutError, Rollback, TransactionFaultError (+28 more)

### Community 2 - "temporal-kv.ts"
Cohesion: 0.07
Nodes (42): RFC-8259, AsOf, AssertExact, ExpectedVersionSchema, hasPostgresUnsafeText(), HistoryUnavailableError, JsonValue, jsonValueHasUnsafeText() (+34 more)

### Community 3 - "ADDED Requirements"
Cohesion: 0.08
Nodes (25): ADDED Requirements, Requirement: concurrent writers merging the same tx hash never lose a section, Requirement: driver-level failures surface as the shared StorageError hierarchy, Requirement: getAll returns live bigint/Date-typed values, not JSON-stringified primitives, Requirement: identifier-subset pending-clear rule survives repeated merges, Requirement: merge semantics are equivalent to mergeWalletEntries, not last-write-wins, Requirement: one storage instance is bound to exactly one wallet at construction, Requirement: serialize() is a full synchronous-equivalent dump matching the fixed interface contract (+17 more)

### Community 4 - "scoped-review-manifest"
Cohesion: 0.22
Nodes (8): Cleanup, scoped-review-manifest, Step 0 — Skip check, Step 1 — Freshness gate, Step 2 — Changed-file seed set, Step 3 — Blast-radius computation, Step 4 — Write the manifest, Step 5 — Hand off

### Community 5 - "Storage Algebra Lean Formalization — Approved Design and Status"
Cohesion: 0.13
Nodes (15): 10. Sprint 2 transaction/lease proposal, 11.1 Repository evidence, 11.2 External primary sources, 11. Evidence matrix, 13. Approved implementation decisions, 1. Executive conclusion, 2.1 Historical implementation baseline, 2. Research protocol (+7 more)

### Community 6 - "devDependencies"
Cohesion: 0.05
Nodes (38): effect, fast-check, @midnightntwrk/wallet-sdk-abstractions, dependencies, postgres, zod, devDependencies, effect (+30 more)

### Community 8 - "SKILL.md"
Cohesion: 0.12
Nodes (16): Check for context, Ending Discovery, Guardrails, Handling Different Entry Points, OpenSpec Awareness, The Stance, What You Don't Have To Do, What You Might Do (+8 more)

### Community 10 - "compilerOptions"
Cohesion: 0.13
Nodes (14): chain-archive-sync/**/*.ts, src/**/*.ts, test/**/*.ts, compilerOptions, declaration, esModuleInterop, module, moduleResolution (+6 more)

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

### Community 57 - "Tasks — Sprint 7: Transaction History Storage"
Cohesion: 0.20
Nodes (9): 0. Specification freeze, 1. Vendor/pin manifest, 2. Schema + interface, 3. PgTransactionHistoryStorage implementation, 4. WalletState envelope, 5. Storage-swappable conformance harness (Pg-only tier — required merge gate), 6. Live-sync tier (nightly/labeled — blocked on design.md §7's open question), 7. Close-out (+1 more)

### Community 63 - "Sprint 5 Recommendation — Wallet Integration Surface (TransactionHistoryStorage + Live-Sync Conformance)"
Cohesion: 0.22
Nodes (8): 1. Decisive scope, 2. Live-sync conformance test plan, 3. Open questions for the design-drafting stage, 4. Prioritized artifacts (dependency order), Architectural boundary (explicit owner directive, confirmed post-consolidation), Build (one product module + one thin envelope — corrected from the original "exactly two things, zero new code" framing; see finding below), Do not build (obsoleted — confirmed against real source), Sprint 5 Recommendation — Wallet Integration Surface (TransactionHistoryStorage + Live-Sync Conformance)

### Community 65 - "Design — Sprint 7: Transaction History Storage"
Cohesion: 0.22
Nodes (8): 1. Schema, 2. Dependency direction: structural mirror, not a runtime import, 3. Atomic merge under concurrent writers, 4. Multi-wallet identity, 5. WalletState envelope, 6. Open questions carried into this sprint (unresolved, tracked here rather than silently defaulted), 7. What "live-sync" means for this sprint's non-required test tier, Design — Sprint 7: Transaction History Storage

### Community 66 - "Top-level null value application-level guard"
Cohesion: 0.67
Nodes (3): prune retainCount validation requirement, Top-level null value application-level guard, set rejects top-level null requirement

### Community 67 - "Proposal — Sprint 7: Transaction History Storage (Wallet Integration Surface)"
Cohesion: 0.29
Nodes (6): Impact, Non-goals, Proposal — Sprint 7: Transaction History Storage (Wallet Integration Surface), What changes, Why, Why this sprint is numbered 7, not 5

### Community 69 - "pg-tx-history-adapter.ts"
Cohesion: 0.10
Nodes (22): SerializationFailedError, TransactionHistoryStatus, assertNoReservedAdapterKeys(), COMMON_FIELD_NAMES, DANGEROUS_EXTENSION_KEYS, describeStatusValue(), LifecycleDetailStore, LifecycleDetailStoreSchema (+14 more)

### Community 70 - "CheckpointStore cancellation scope decision (pre-check only)"
Cohesion: 0.06
Nodes (32): Advisory-lock class registry (classes 1/2/3), Module → Postgres module mapping table, Postgres advisory-lock writer lease (corrected design), CheckpointNotFoundError, CheckpointStore interface, CheckpointWalletStateStore (production adapter), Global cross-wallet chunk GC reclamation fix, WalletStateStore (project abstraction) (+24 more)

### Community 71 - "transaction-history-storage.test.ts"
Cohesion: 0.10
Nodes (11): { sql: getSql }, registerSuiteLifecycle(), stopTestDatabase(), decodeSerializedContent(), decodeSerializedEntry(), FAKE_TX, insertRawRow(), { sql: getSql } (+3 more)

### Community 72 - "ADDED Requirements"
Cohesion: 0.11
Nodes (18): ADDED Requirements, formal-watermarks, Requirement: Command traces compose in list order, Requirement: Lookup after a trace returns the last matching value, Requirement: Set is an unconditional overwrite at the exact address, Requirement: Set preserves distinct addresses, Requirement: The abstract Watermarks store has one absence representation, Requirement: The W1 proof claim remains abstract (+10 more)

### Community 73 - "pull_request_template.md"
Cohesion: 0.50
Nodes (3): Change summary, Mandatory Codex audit, Validation

### Community 75 - "client.ts"
Cohesion: 0.09
Nodes (17): assertNoConflictingSearchPath(), assertValidSchemaName(), createClient(), UmbraDBConnectionOptions, Migration, runMigrations(), runMigrationsImpl(), RunMigrationsOptions (+9 more)

### Community 76 - "ADDED Requirements"
Cohesion: 0.05
Nodes (36): ADDED Requirements, Requirement: a cold boot resumes without a full resync and preserves tx-history continuity, Requirement: a corrupt or non-JSON envelope payload is rejected with a typed error, Requirement: a live-synced transaction materializes as a Postgres row observable via getAll, Requirement: a sub-wallet absent from the envelope is skipped on restore, Requirement: an unrecognized envelopeVersion is rejected, never best-effort restored, Requirement: each sub-wallet resumes from its own last-known point; the envelope bundles for atomicity only, Requirement: encode and decode are lossless inverses (+28 more)

### Community 77 - "ADDED Requirements"
Cohesion: 0.04
Nodes (45): ADDED Requirements, durable-composition (implementation), Requirement: a conforming composition keeps the durable cursor from ever being ahead of durable checkpoint data, Requirement: a durability probe asserts the server's crash-safety settings at client bootstrap, Requirement: a transaction-pooling proxy is detected and refused, Requirement: JsonValueSchema rejects values exceeding the maximum nesting depth, Requirement: migration advisory-lock acquisition is bounded and fails fast, Requirement: PgCheckpointStore validates walletId and networkId at every entry point (+37 more)

### Community 78 - "checkpoint-store.ts"
Cohesion: 0.05
Nodes (49): CheckpointNotFoundError, CheckpointRecord, CheckpointSequence, CheckpointStore, CheckpointStoreError, CheckpointStoreErrorCode, CheckpointSummary, ChunkIntegrityError (+41 more)

### Community 79 - "transaction-history-storage.property.test.ts"
Cohesion: 0.12
Nodes (16): EntryContent, applyCommand(), arbitraryCommand, badKeyValue, Command, GOOD_LEAF_KEYS, goodLeaf, goodNestedObject (+8 more)

### Community 80 - "Autonomous run log"
Cohesion: 0.10
Nodes (20): 2026-07-22 — Sprint 8 COMPLETE and MERGED (autonomous AFK run), Also on GitHub, Architecture confirmation — the SDK is memory-only; UmbraDB is the persistence layer (owner-confirmed, doc-verified), Audit-check guardrails ("don't get this wrong" — owner directive), Autonomous run log, Design council convened (verifiable-snapshot feature, branch feature/verifiable-snapshot), Design council verdicts (verifiable-snapshot) + revision plan, Env test-failure fix (owner: "fix the env failures as well") — diagnosed, fix planned (+12 more)

### Community 81 - "Design — Sprint 8: WalletState Envelope + Live Preprod DB-Sync + Cold-Boot Recovery"
Cohesion: 0.11
Nodes (17): 1.1 Envelope shape, 1. Envelope decision: (a) one versioned envelope — DECIDED, 2. Module layout and dependency direction, 3.1 Field mapping (write path), 3.2 Lifecycle-detail fidelity — the correctness-gate open question, 3.3 No runtime SDK import in core, 3.4 serialize() is a diagnostic dump, not a migration path (F10), 3. The adapter (the seam) (+9 more)

### Community 82 - "transaction-history-storage.ts"
Cohesion: 0.10
Nodes (16): EntryContentSchema, EntryLifecycleSchema, EntryLifecycleStatus, EntrySectionsSchema, FinalizedLifecycle, FinalizedLifecycleSchema, HashSchema, IdentifierSchema (+8 more)

### Community 83 - "ADDED Requirements"
Cohesion: 0.05
Nodes (43): ADDED Requirements, Requirement: A real VerifyFull/--ca path is provided, replacing the stub (G17), Requirement: A shipped threat-model document states the single-trusted-writer trust model (G15), Requirement: CI gates any change to flake.lock behind explicit review (G18), Requirement: CI installs dependencies with npm ci (G18), Requirement: CI runs a blocking npm audit on runtime dependencies (G18), Requirement: CI runs full-history gitleaks secret scanning with the wallet history and template allowlisted (G18), Requirement: CI scans both pinned Docker image digests for CVEs (G18) (+35 more)

### Community 84 - "transaction-history-storage.ts"
Cohesion: 0.21
Nodes (16): EntryLifecycle, TransactionHistoryEntrySchema, assertStoredEntryShape(), capitalize(), decodeContent(), decodeRow(), decodeSections(), encodeContent() (+8 more)

### Community 85 - "UmbraDBSql"
Cohesion: 0.17
Nodes (16): BlockMeta, BlockRecord, Hex32, TransactionMeta, assertHex32(), BlockRow, bufToHex(), ChainArchiveTx (+8 more)

### Community 86 - "TransactionHistoryEntry"
Cohesion: 0.20
Nodes (7): TransactionHistoryEntry, TransactionHistoryStorage, PgTransactionHistoryStorage, rowToEntry(), abortErrorLike(), capitalize(), InMemoryTransactionHistoryStorage

### Community 87 - "ADDED Requirements"
Cohesion: 0.05
Nodes (40): ADDED Requirements, recovery-testing (crash-injection, soak, differential & live-evidence gate), Requirement: G10 — a full-sync soak runs at a declared envelope with GC passes and holds every invariant, Requirement: G10 — load during a concurrent prune never corrupts a live checkpoint's retrieval, Requirement: G11/T11 — a fault-schedule run is state-equivalent to a fault-free reference, Requirement: G11 — the differential gate is anchored on the P3 replay-equivalence property, Requirement: G12 — a manual pre-tag Preprod round-trip is run against the RC with recorded evidence, Requirement: G9 — a skip-enforcement check proves every required crash test executed, none silently skipped (+32 more)

### Community 88 - "Storage Algebra Lean M3a Watermarks Sprint"
Cohesion: 0.25
Nodes (7): Adversarial examples, Audited semantic decisions, Explicit non-goals, Source layout, Storage Algebra Lean M3a Watermarks Sprint, Theorem gate, Verification matrix

### Community 89 - "UmbraDB dev environment — master runbook"
Cohesion: 0.22
Nodes (8): Build / run (from source — all public, no ghcr auth), Credentials, Host, Midnight repos (cloned under ~/repos), Shell / PATH persistence, Tooling (all rootless / user-space), UmbraDB dev environment — master runbook, Wallet SDK install (public-npm workaround — IMPORTANT)

### Community 90 - "Sprint 7 — Midnight preprod toolchain inventory & build checklist"
Cohesion: 0.22
Nodes (8): A. System / host toolchain (shared), B. midnight-node (from source → preprod), C. midnight-indexer (GraphQL WS the wallet syncs against), Credentials summary, D. proof-server (from source — corrects earlier "ghcr-only" finding), E. midnight-wallet SDK, Key version decision (resolved), Sprint 7 — Midnight preprod toolchain inventory & build checklist

### Community 91 - "Design — Sprint 5: Lean M3a Watermarks W1"
Cohesion: 0.29
Nodes (6): 1. Executable carrier, 2. Commands and interpretation, 3. Laws, 4. Trust and reachability, 5. Refinement boundary, Design — Sprint 5: Lean M3a Watermarks W1

### Community 92 - "Tasks — Sprint 8: WalletState Envelope + Live Preprod DB-Sync + Cold-Boot Recovery"
Cohesion: 0.20
Nodes (9): 0. Specification freeze, 1. Vendor/pin manifest (for the nightly live tier), 2. Envelope module (Pg-only — required gate), 3. Adapter seam (Pg-only for its own tier — required gate), 4. Pg-only conformance suite (required merge gate) — `test:conformance`, 5. Live preprod DB-sync + cold-boot tiers (nightly/labeled — NOT a required gate), 6. Close-out, Deferred to Sprint 9 (Batch 3 — recorded as honest deferrals, NOT implemented here) (+1 more)

### Community 93 - "Midnight infra verification checklist"
Cohesion: 0.29
Nodes (6): A. Toolchain & binaries (all self-serve from public source), B. Preprod connectivity (public endpoints, verified live), C. Our wallet, D. Operations to verify (the requested end-to-end), E. Our from-source node (prove the build works as a real node), Midnight infra verification checklist

### Community 94 - "Proposal — Sprint 8: WalletState Envelope + Live Preprod DB-Sync + Cold-Boot Recovery"
Cohesion: 0.29
Nodes (6): Impact, Non-goals (explicitly out of scope), Proposal — Sprint 8: WalletState Envelope + Live Preprod DB-Sync + Cold-Boot Recovery, Scope of Sprint 8 (functional DB-backed persistence + recovery), What changes, Why this sprint exists, and why it unblocks Sprint 7

### Community 95 - "Preprod connection — endpoints, wallet, faucet"
Cohesion: 0.33
Nodes (5): Faucet (get tNIGHT), Our preprod wallet, Preprod connection — endpoints, wallet, faucet, Public preprod endpoints (all verified live), Sync cost (CORRECTED — no block-height "birthday" for the unshielded wallet)

### Community 98 - "sync-service.ts"
Cohesion: 0.10
Nodes (17): IndexerBlock, IndexerClient, IndexerClientError, IndexerClientOptions, IndexerClientParseError, IndexerTransaction, NodeRpcClientOptions, ChainArchiveSyncService (+9 more)

### Community 99 - "ADDED Requirements"
Cohesion: 0.06
Nodes (33): ADDED Requirements, Requirement: A caller-supplied transaction handle is honored or rejected, never silently ignored, Requirement: A second write to the same key within one transaction is rejected at the trigger level, not silently absorbed, Requirement: Dual addressing agrees at recorded write timestamps (Law T4), Requirement: getAt satisfies temporal-projection equivalence (Law T3), within the store's retention window, Requirement: History intervals never overlap for a single key (Law T5), Requirement: listKeys streams without materializing the full result set first, and orders results correctly, Requirement: Migrations are idempotent and ordered (+25 more)

### Community 100 - "Proposal — Sprint 5: Lean M3a Watermarks W1"
Cohesion: 0.33
Nodes (5): Impact, Non-goals, Proposal — Sprint 5: Lean M3a Watermarks W1, What changes, Why

### Community 101 - "Tasks — Sprint 5: Lean M3a Watermarks W1"
Cohesion: 0.33
Nodes (5): 0. Specification freeze, 1. Executable Watermarks model, 2. W1 theorem tranche, 3. Close-out, Tasks — Sprint 5: Lean M3a Watermarks W1

### Community 102 - "ADDED Requirements"
Cohesion: 0.06
Nodes (33): ADDED Requirements, Requirement: A lease timeout surfaces distinctly for acquireLease vs. tryAcquireLease, Requirement: A resolved transaction handle always refers to its own live transaction, Requirement: A transaction timeout surfaces as TransactionFaultError, Requirement: Aborting opts.signal before withTransaction starts rejects with AbortError, Requirement: Aborting opts.signal during lease acquisition rejects with AbortError, Requirement: acquireLease waits indefinitely absent a timeout; tryAcquireLease never blocks unboundedly, Requirement: At most one holder per lease key at any instant (Law L1) (+25 more)

### Community 103 - "ADDED Requirements"
Cohesion: 0.06
Nodes (33): ADDED Requirements, performance-baseline (implementation), Requirement: a benchmark baseline is recorded as a committed artifact (the G14 gate), Requirement: a coarse smoke guard is wired now; the CV-aware regression gate is deferred, Requirement: an in-repo benchmark harness drives the real adapters against a pinned Postgres, Requirement: ckpt_chunks carries a stored size_bytes column computed without detoasting (IS-2), Requirement: history() computes per-manifest aggregates in a single grouped query (HP-2), Requirement: kv_current is fillfactor-tuned to preserve HOT-update eligibility (IS-1) (+25 more)

### Community 104 - "Full-Chain Storage — Design"
Cohesion: 0.06
Nodes (31): 10. Residual limitations and open questions for the design council, 11. Phasing table, 1. Problem and core principle, 2. Source grounding, 3.1 Block header, 3.2 Raw transaction blob (opaque SCALE-wrapped ledger tx), 3.3 Transactions / regular_transactions (queryable metadata split), 3.4 Unshielded UTXOs (+23 more)

### Community 105 - "ADDED Requirements"
Cohesion: 0.06
Nodes (31): ADDED Requirements, Requirement: a caller-supplied transaction handle is honored, not silently ignored, Requirement: a non-object JSON value round-trips correctly, Requirement: an already-aborted opts.signal rejects before any statement; a later abort has no effect, Requirement: get never throws for an unset cursor, Requirement: get returns exactly the last value set, scoped per (kind, key), Requirement: Postgres errors surface as the shared StorageError hierarchy, Requirement: set is an idempotent, unconditional overwrite (Law W1) (+23 more)

### Community 106 - "Design — v1.0.0-durable-checkpoint-cursor"
Cohesion: 0.07
Nodes (26): 0. Package layout, 1.1 The gap, confirmed in source, 1.2 Change `save` to accept a caller transaction, 1.3 The `saveAndAdvance` combinator, 1.4 The ordering contract (for callers composing manually), 1. G5 — Co-transactional watermark + checkpoint data, 2.1 Where the probe runs (the one real design decision), 2.2 The three durability settings (+18 more)

### Community 107 - "cold-boot-recovery.integration.test.ts"
Cohesion: 0.20
Nodes (17): phaseA_syncAndPersistEnvelope(), phaseB_freshProcessRestoreAndVerify(), facadeDistIndexPath(), facadeMergeAvailable(), loadFacadeMerge(), unshieldedWalletDistIndexPath(), deriveUnshieldedSeed(), ledgerV8NodeEntry() (+9 more)

### Community 108 - "errors.ts"
Cohesion: 0.13
Nodes (14): ConnectionError, StorageError, CHAIN_ARCHIVE_CHECK_TABLE_PREFIXES, CHAIN_ARCHIVE_INVARIANT_CONSTRAINT_NAMES, ChainArchiveCheckViolationError, ChainArchiveInvariantError, ClockRegressionError, CONNECTION_FAILURE_CODES (+6 more)

### Community 109 - "chain_archive lineage"
Cohesion: 0.11
Nodes (18): `blocks`, Boundary enforcement, `bridge_observations`, chain_archive lineage, `chain_archive.watermarks`, `chain_blobs` / `chain_blob_roles`, CheckpointStore tables, How the two lineages coexist (+10 more)

### Community 110 - "ADDED Requirements"
Cohesion: 0.12
Nodes (16): ADDED Requirements, formal-checkpoint-c1, Requirement: C1 remains a save-only abstract projection, Requirement: Chunk identities form an unconditional finite join projection, Requirement: Chunk-map merge preserves existing bytes, Requirement: Collision freedom is an explicit local theorem premise, Requirement: Compatible chunk maps satisfy conditional C1 commutation, Requirement: Saving identity inputs is extensive, repeat-idempotent, and order-independent (+8 more)

### Community 111 - "Design — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)"
Cohesion: 0.11
Nodes (18): 0. Test-infrastructure layout, 1.1 Skip-enforcement mechanism — the anti-self-skip guarantee, made a named check, 1. Crash harness — deterministic faults, not timing races (`council/B` §3 tooling ruling), 2.1 Process-kill mid-save (T1) — `02` §"Fault-injection test plan" T1; `council/B` §3 item 1, 2.2 Postgres-kill mid-save + retry-duplication contract (T2) — `02`-T2; `council/B` §3 item 2, 2.3 Crash between data and cursor — the keystone (T5) — `02`-T5; `council/B` §3 item 3; §5 item 1, 2.4 Lease non-wedge cold start (T3) — `02`-T3; `council/B` §3 item 4, 2. G9 — the four crash tests (+10 more)

### Community 112 - "NodeRpcClient"
Cohesion: 0.16
Nodes (6): NodeRpcClient, NodeRpcError, NodeRpcInvalidHeightError, NodeRpcParseError, SubstrateBlock, SubstrateHeader

### Community 113 - "chain-archive-store.ts"
Cohesion: 0.14
Nodes (13): BlobIntegrityError, BlobMissingError, BlobRole, BlockNotFoundError, BlockStatus, BridgeObservationKind, ChainArchiveError, ChainArchiveErrorCode (+5 more)

### Community 114 - "Design — v1.0.0 API Surface & Release Contract"
Cohesion: 0.12
Nodes (15): 0. Ordering constraint (why this change is Phase 2, not Phase 1), 1.1 The barrel: `src/index.ts`, 1.2 `package.json` — make it publishable with a strict `exports`, 1.3 Packed-tarball install smoke test, 1. G1 — Public API surface, 2. G2 — SemVer stability policy + CHANGELOG, 3.1 The frozen catalog (the machine-facing API), 3.2 Promote retryability to a machine-readable field (+7 more)

### Community 115 - "chain-archive-sync-retry.integration.test.ts"
Cohesion: 0.18
Nodes (11): bootstrapChainArchiveSchema(), MAX_BLOCKS, service, sql, BlockBundle, fakeChain(), FakeChainBlock, fakeIndexerFetch() (+3 more)

### Community 116 - "Design — Sprint 3: CheckpointStore"
Cohesion: 0.13
Nodes (14): 0. Package layout, 1. Chunking, 2.1 `ckpt_manifest_chunks` needs an explicit position, 2.2 `seq` needs an explicit allocator, 2.3 `complete`: kept, and explicitly written `true` by every `save()`, 2. Schema — two corrections to `design/design.md` §3, 3. `prune` — two-step GC, `design/design.md` §3's pass plus §2.1's cascade, 4. `load` — full verification, no exceptions (+6 more)

### Community 118 - "tx-replay-decoder.ts"
Cohesion: 0.23
Nodes (13): decodeArchivedTransaction(), DecodedArchivedTransaction, DecodedDustRegistration, DecodedDustSpend, DecodedUnshieldedOutput, DecodedZswapInput, DecodedZswapOutput, isStandardTransaction() (+5 more)

### Community 119 - "Design — Sprint 4: Watermarks"
Cohesion: 0.15
Nodes (12): 0. Package layout, 10. Test infrastructure, 1. Schema — one physical-parameter correction to `design/design.md` §4, 2. `set`, 3. `get`, 4. Large-integer cursor values — a documented convention, not a schema change, 5. Accepted tradeoffs (explicit, not silently possible), 6. Composing Transaction/Lease (+4 more)

### Community 120 - "chain-archive-rollover.ts"
Cohesion: 0.24
Nodes (12): AnySql, assertDefaultSpanFitsOneBucket(), assertValidBucketBounds(), assertValidPartitionSuffix(), attachedPartitionBound(), getFkConstraintName(), quoteIdent(), ROLLOVER_TABLES (+4 more)

### Community 121 - "Design — Postgres+JSONB storage rebuild"
Cohesion: 0.17
Nodes (12): 0. How this reconciles with the Tier-2 (indexer) Postgres decision, 10. State-equivalence gate (merge blocker, mirrors the mongo-store Plan A/B gate), 1. Mongo-compatibility-shim tooling: evaluated and rejected, 2. TemporalKV → Postgres, 3. Checkpoint chunker (content-addressed, deduplicated), 4. Watermarks, 5. Commit/transaction layer, 6. Encrypted blob storage (`MongoPrivateStateProvider`/`MongoWalletStateStore`) (+4 more)

### Community 122 - "Tasks — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)"
Cohesion: 0.17
Nodes (11): 0. Crash harness (foundation), 1. Process-kill mid-save (G9 / 02-T1), 2. Postgres-kill mid-save + retry-duplication contract (G9 / 02-T2), 3. Crash between data and cursor — the keystone (G9 / 02-T5)  ⟵ depends on G5, 4. Lease non-wedge cold start (G9 / 02-T3), 5. Full-sync soak + load-under-concurrent-prune (G10), 6. Differential state-equivalence gate, rescoped in-repo (G11)  ⟵ fault-schedule half depends on G5, 7. CI gate wiring (+3 more)

### Community 123 - "UmbraDB"
Cohesion: 0.17
Nodes (12): Architecture, Data-flow visualizer, Design, Formal verification, Full-chain storage — validated live against public Preprod (AC-8), Getting started, Layout, License (+4 more)

### Community 124 - "Full-Chain Storage"
Cohesion: 0.18
Nodes (10): 1. Overview / purpose, 2.1 The boundary rule (the feature's key design decision), 2.2 Storage layer (`src/interfaces/chain-archive-store.ts` + `src/postgres/chain-archive-store.ts`), 2.3 Partition rollover (`src/postgres/chain-archive-rollover.ts`), 2. Architecture, 3. Semantic decode: `chain-archive-sync/tx-replay-decoder.ts`, 4. How to run it, 5. Acceptance criteria status (+2 more)

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

### Community 129 - "3. Proof-blocking findings"
Cohesion: 0.18
Nodes (11): 3.10 L1 has two non-equivalent meanings, 3.1 The TemporalKV carrier is too small, 3.2 The proposed action is not an ordinary monoid action, 3.3 T3 omits the current event and cannot replay a pruned suffix, 3.4 The time field is not a commit instant, 3.5 T2 overstates atomic conflict reporting, 3.6 T5 credits a constraint with more than it enforces, 3.7 C1 needs compatibility or a collision assumption (+3 more)

### Community 130 - "Design — Sprint 2: Transaction/Lease"
Cohesion: 0.18
Nodes (10): 0. Package layout, 1. `withTransaction`, 2. The transaction-handle registry (the one new design decision this sprint makes), 3. Lease acquisition, release, and timeout, 3a. `raceAgainstAbort` — the real mid-wait cancellation `acquireLease`/`tryAcquireLease` need, 4. Wiring `PgTemporalKV`'s `opts.tx`, 5. Error translation additions (`src/postgres/errors.ts`), 6. Test infrastructure (+2 more)

### Community 131 - "ADDED Requirements"
Cohesion: 0.18
Nodes (10): ADDED Requirements, checkpoint-store (implementation), Requirement: load and history read a consistent snapshot immune to a concurrently-committing prune, Requirement: load rejects a manifest whose recorded chunk-hash sequence was tampered with, even when every chunk individually verifies, Requirement: load rejects a structurally-corrupt manifest with ManifestCorruptError, Requirement: save rejects invalid options with ValidationError before any chunking or hashing work, Scenario: A chunkSize above the schema's 16 MiB bound is rejected with no work done, Scenario: A manifest whose chunk-hash sequence was substituted is rejected even though every referenced chunk verifies and positions are dense (+2 more)

### Community 132 - "Tasks — v1.0.0 API Surface & Release Contract"
Cohesion: 0.18
Nodes (10): 0. Preconditions (blocking gate — verify before any freeze work), 1. Pre-freeze: retryability field (G3), 2. Pre-freeze: strip / mark-experimental the chain-archive error classes (G3), 3. The freeze: build + package.json (G1), 4. The freeze: the public barrel (G1), 5. Release contract docs (G2, G4), 6. Freeze the Lean cut-line (G20), 7. Packed-tarball install smoke test (G1) (+2 more)

### Community 133 - "Design — v1.0.0-perf-baseline"
Cohesion: 0.18
Nodes (10): 0. Package layout, 1. HP-1 — `save()` `UNNEST` batching (G13), 2. HP-2 + IS-2 — `history()` single `GROUP BY` over a stored `size_bytes` (G13), 3. IS-1 — `kv_current fillfactor=90` (G13), 4. G14 — benchmark harness, 5. G14 — the GC anti-join measurement + recorded baseline, 6. G14 — documented scalability ceilings (SC-1..SC-6), 7. Boundaries and non-goals respected (+2 more)

### Community 134 - "Acceptance criteria — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)"
Cohesion: 0.18
Nodes (10): Acceptance criteria — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`), Boundary / scope guardrails (council rulings honored), Crash between data and cursor — keystone (G9 / T5, depends on G5), Differential state-equivalence, in-repo (G11, fault-schedule half depends on G5), Full-sync soak + load-under-prune (G10), Lease non-wedge cold start (G9 / T3), Manual pre-tag Preprod evidence run (G12, release step 7, against the RC), Postgres-kill mid-save + retry contract (G9 / T2) (+2 more)

### Community 135 - "explore.md"
Cohesion: 0.20
Nodes (9): Check for context, Ending Discovery, Guardrails, OpenSpec Awareness, The Stance, What You Don't Have To Do, What You Might Do, When a change exists (+1 more)

### Community 136 - "Storage Layer Interface Specification"
Cohesion: 0.20
Nodes (10): 2. `storage-errors.ts` — shared base (new file), 3.1 Transaction/Lease layer, 3.2 TemporalKV, 3.3 CheckpointStore, 3.4 Watermarks, 3. Module Interfaces, 4. Composition with `WalletStateStore` / `PrivateStateProvider`, 5. Documentation-Generation Tooling (+2 more)

### Community 137 - "Requirement: A caller-supplied transaction handle is honored or rejected, never silently ignored"
Cohesion: 0.20
Nodes (9): ADDED Requirements, MODIFIED Requirements, Requirement: A caller-supplied transaction handle is honored or rejected, never silently ignored, Requirement: TransactionKeyReuseError is now reachable through the public put() API, Scenario: A stale transaction handle is rejected before any query runs, Scenario: Two puts inside one withTransaction both commit together, Scenario: Two puts inside one withTransaction either both commit or neither does, Scenario: Two puts to the same key inside one transaction reject and roll back together, through the public API (+1 more)

### Community 138 - "Design — v1.0.0-infosec-signoff"
Cohesion: 0.20
Nodes (9): 0. Scope boundary and what this change does NOT touch, 1. G15 — `SECURITY.md` / threat-model document, 2. G16 — CheckpointStore cross-wallet dedup interface-doc rewrite, 3. G17 — TLS caveat surfaced + VerifyFull/`--ca` de-stubbed, 4. G18 — Supply-chain CI gate, 5. G19 — Replace the committed Preview wallet secret, 6. Non-goals & boundaries respected (summary), Audit resolution (+1 more)

### Community 139 - "Roadmap"
Cohesion: 0.20
Nodes (10): 1.0.0 acceptance checklist, Beyond 1.0.0 — additional tracks in progress, Milestone 0 — Design (completed baseline), Milestone 1 — Formal (`Formal/`, in progress), Milestone 2 — Core implementation (module implementations complete), Milestone 3 — Testing (current), Milestone 4 — Performance (`Performance/`), Milestone 5 — Cutover (+2 more)

### Community 140 - "Feasibility: TLS for the Cardano db-sync database (Midnight partner-chain follower)"
Cohesion: 0.22
Nodes (8): 1. Driver — why this is now mandatory, 2. What the Cardano side does (and does not) provide, 3. Feasibility — demonstrated, 4. Security postures, 5. Folding into `nix/midnight-env`, 6. Risks / open items, 7. Verdict, Feasibility: TLS for the Cardano db-sync database (Midnight partner-chain follower)

### Community 141 - "STORAGE_ALGEBRA_LEAN_RESEARCH.md"
Cohesion: 0.22
Nodes (6): CheckpointStore (`src/interfaces/checkpoint-store.ts`), Storage Types — reference for formalization, TemporalKV (`src/interfaces/temporal-kv.ts`), Transaction/Lease (`src/interfaces/transaction-lease.ts`), Watermarks (`src/interfaces/watermarks.ts`), What's NOT in scope for this formalization

### Community 142 - "Design — Sprint 1: project setup + TemporalKV"
Cohesion: 0.22
Nodes (8): 0. Schema naming, now that UmbraDB is standalone, 1. Package layout, 2. Migration mechanism, 3. Connection factory (`src/postgres/client.ts`), 4. `PgTemporalKV` adapter (`src/postgres/temporal-kv.ts`), 4a. Error translation (`src/postgres/errors.ts`), 5. Test infrastructure, Design — Sprint 1: project setup + TemporalKV

### Community 143 - "Acceptance — v1.0.0 API Surface & Release Contract"
Cohesion: 0.22
Nodes (8): Acceptance — v1.0.0 API Surface & Release Contract, G1 — Public API surface, G20 — Lean cut-line, G2 — SemVer stability policy + CHANGELOG, G3 — Frozen, cleaned error catalog, G4 — Contract doc set (all true), Negative / boundary criteria (nothing out-of-scope leaked in), Precondition (blocks the whole change)

### Community 144 - "Graph-scoped review policy"
Cohesion: 0.25
Nodes (7): Baseline (for measuring whether this actually helps), Graph-scoped review policy, Guardrails (this repo's own policy — `graphify` upstream provides none of these), Keep the knowledge graph current, sprint by sprint, The scoping mechanism (PUSH roles only), UmbraDB — project instructions, When not to bother

### Community 145 - "README.md"
Cohesion: 0.25
Nodes (5): Impact, Proposal — Postgres+JSONB storage rebuild (remove the MongoDB dependency), What changes, Why, OpenSpec Change

### Community 146 - "ROADMAP.md"
Cohesion: 0.25
Nodes (5): For historical reference only, Phase → current status map, Tasks — superseded by per-sprint openspec changes, Custom Node/TypeScript Benchmark Harness, Performance

### Community 147 - "Lean 4 Formalization Plan"
Cohesion: 0.25
Nodes (7): Harder / genuinely novel — no existing precedent to lean on, Lean 4 Formalization Plan, Moderate effort, Near-term tractable — start here, Per-property guidance, Process note, Scope decision: abstract model first, implementation trusted-but-unverified

### Community 148 - "Tasks — Sprint 3: CheckpointStore"
Cohesion: 0.25
Nodes (7): 0. Preconditions and schema, 1. Chunking and write path, 2. Read path, 3. GC (`prune`), 4. Property tests (`Formal/STORAGE_ALGEBRA.md` §5), 5. Sprint close-out, Tasks — Sprint 3: CheckpointStore

### Community 149 - "Tasks — Sprint 4: Watermarks"
Cohesion: 0.25
Nodes (7): 0. Schema, 1. `set`, 2. `get`, 3. Cancellation and errors, 4. Property test (`Formal/STORAGE_ALGEBRA.md` §5), 5. Sprint close-out, Tasks — Sprint 4: Watermarks

### Community 150 - "Acceptance criteria — v1.0.0-infosec-signoff"
Cohesion: 0.25
Nodes (7): Acceptance criteria — v1.0.0-infosec-signoff, Cross-cutting council-ruling gates (close-out — Task 5.1), G15 — Threat-model / `SECURITY.md`, G16 — CheckpointStore dedup interface-doc caveat, G17 — TLS caveat surfaced + VerifyFull de-stubbed, localhost default kept, G18 — Supply-chain CI gate, G19 — Committed-secret remediation

### Community 151 - "Tasks — v1.0.0-infosec-signoff"
Cohesion: 0.25
Nodes (7): 0. Threat-model documentation hub (G15), 1. CheckpointStore interface-doc rewrite (G16) — depends on 0.3, 2. TLS caveat + VerifyFull de-stub (G17) — independent, 3. Supply-chain CI gate (G18) — 3.5 depends on 4.1, 4. Committed-secret remediation (G19) — mutually dependent with 3.5, 5. Change close-out, Tasks — v1.0.0-infosec-signoff

### Community 152 - "12. Milestone status"
Cohesion: 0.29
Nodes (7): 12. Milestone status, M0 — freeze semantics, M1 — no-`sorry` TemporalKV vertical slice (completed), M2 — complete temporal laws (abstract per-key tranche completed), M3 — simple stores (in progress), M4 — leases and liveness (deferred), M5 — refinement evidence (deferred)

### Community 153 - "5. Recommended candidate model"
Cohesion: 0.29
Nodes (7): 5.1 Layer A: per-key temporal history, 5.2 Layer B: keyed store and transaction guard, 5.3 Layer C: retention, 5.4 Checkpoints, 5.5 Watermarks, 5.6 Lease state, 5. Recommended candidate model

### Community 154 - "Acceptance — v1.0.0-durable-checkpoint-cursor"
Cohesion: 0.29
Nodes (6): Acceptance — v1.0.0-durable-checkpoint-cursor, G5 — Co-transactional watermark + checkpoint data, G6 — Durability startup probe + binding contract, G7 — Server-side timeouts, G8 — Contract-integrity fixes, Whole-change gates (non-goal compliance + sequencing)

### Community 155 - "Tasks — v1.0.0-durable-checkpoint-cursor"
Cohesion: 0.29
Nodes (6): 0. G5 — Co-transactional watermark + checkpoint data (do first; pre-freeze, signature-changing), 1. G6 — Durability startup probe + binding contract, 2. G7 — Server-side timeouts, 3. G8 — Contract-integrity fixes, 4. Change close-out, Tasks — v1.0.0-durable-checkpoint-cursor

### Community 156 - "Proposal — v1.0.0-perf-baseline"
Cohesion: 0.29
Nodes (6): 1.0.0 gate items addressed, Impact, Non-goals (explicitly out of scope for this change), Proposal — v1.0.0-perf-baseline, What changes, Why

### Community 157 - "Performance — design"
Cohesion: 0.29
Nodes (6): 1. Postgres-side profiling, 2. Node-side query correlation, 3. GC architecture (the load-bearing decision), 4. Benchmark harness, 5. Activity logging, Performance — design

### Community 158 - "1. Shared Conventions"
Cohesion: 0.33
Nodes (6): 1.1 Error handling — one idiom: thrown, `code`-discriminated typed errors, 1.2 Async pattern, 1.3 Transaction participation, 1.4 Runtime validation, 1.5 Naming, 1. Shared Conventions

### Community 159 - "Proposal — Sprint 1: project setup + TemporalKV"
Cohesion: 0.33
Nodes (5): Impact, Non-goals (explicitly out of scope for this sprint), Proposal — Sprint 1: project setup + TemporalKV, What changes, Why

### Community 160 - "Proposal — Sprint 2: Transaction/Lease"
Cohesion: 0.33
Nodes (5): Impact, Non-goals (explicitly out of scope for this sprint), Proposal — Sprint 2: Transaction/Lease, What changes, Why

### Community 161 - "Tasks — Sprint 2: Transaction/Lease"
Cohesion: 0.33
Nodes (5): 0. `PgTransactionLeaseLayer` — transactions, 1. `PgTransactionLeaseLayer` — leases, 2. Wire `PgTemporalKV`'s `opts.tx`, 3. Sprint close-out, Tasks — Sprint 2: Transaction/Lease

### Community 162 - "Proposal — Sprint 3: CheckpointStore"
Cohesion: 0.33
Nodes (5): Impact, Non-goals (explicitly out of scope for this sprint), Proposal — Sprint 3: CheckpointStore, What changes, Why

### Community 163 - "Proposal — Sprint 4: Watermarks"
Cohesion: 0.33
Nodes (5): Impact, Non-goals (explicitly out of scope for this sprint), Proposal — Sprint 4: Watermarks, What changes, Why

### Community 164 - "Proposal — v1.0.0 API Surface & Release Contract"
Cohesion: 0.33
Nodes (5): Impact, Non-goals (explicitly out of scope — honoring the council rulings verbatim), Proposal — v1.0.0 API Surface & Release Contract, What changes — the 1.0.0 gate items this change addresses, Why

### Community 165 - "Proposal — v1.0.0-durable-checkpoint-cursor"
Cohesion: 0.33
Nodes (5): Impact, Non-goals (explicitly out of scope for this change), Proposal — v1.0.0-durable-checkpoint-cursor, What changes, Why

### Community 166 - "Proposal — v1.0.0-infosec-signoff"
Cohesion: 0.33
Nodes (5): Impact, Non-goals (explicitly out of scope — per the council rulings), Proposal — v1.0.0-infosec-signoff, What changes (the 1.0.0 gate items addressed), Why

### Community 167 - "Tasks — v1.0.0-perf-baseline"
Cohesion: 0.33
Nodes (5): 1. G13 — perf-correctness fixes (LAND FIRST), 2. G14 — benchmark harness (may start in parallel; baseline recorded only after §1), 3. G14 — record the baseline + document ceilings, 4. Close-out, Tasks — v1.0.0-perf-baseline

### Community 168 - "Proposal — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)"
Cohesion: 0.33
Nodes (5): Impact, Non-goals (explicitly out of scope for this change), Proposal — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`), What changes (the 1.0.0 gate items this change addresses), Why

### Community 169 - "chain-archive-replay-decode.integration.test.ts"
Cohesion: 0.40
Nodes (4): archivedRawBytes(), decodeFromArchive(), GROUND_TRUTH_AVAILABLE, SqliteTxRow

### Community 170 - "no-chain-sync-import-guard.test.ts"
Cohesion: 0.53
Nodes (5): extractStringLiterals(), findChainSyncViolations(), GuardViolation, scanDirectory(), walkTsFiles()

### Community 171 - "Tasks — Sprint 1: project setup + TemporalKV"
Cohesion: 0.40
Nodes (4): 0. Project setup, 1. TemporalKV, 2. Sprint close-out, Tasks — Sprint 1: project setup + TemporalKV

### Community 172 - "Requirement: Checkpoint sequence numbers are gapless, monotonic, and scoped per wallet+network"
Cohesion: 0.40
Nodes (5): Requirement: Checkpoint sequence numbers are gapless, monotonic, and scoped per wallet+network, Scenario: A rolled-back save consumes no sequence number, Scenario: Concurrent saves for one wallet+network still produce a gapless, non-repeating sequence, Scenario: Different wallet+network pairs have independent sequence counters, Scenario: Sequential saves for one wallet+network produce consecutive sequence numbers

### Community 173 - "Requirement: load and history distinguish "no checkpoint" from "checkpoint exists elsewhere""
Cohesion: 0.40
Nodes (5): Requirement: load and history distinguish "no checkpoint" from "checkpoint exists elsewhere", Scenario: history for a wallet+network with no checkpoints resolves empty, Scenario: No checkpoint exists for the wallet+network at all, Scenario: Omitting sequence loads the latest checkpoint, Scenario: The wallet+network has checkpoints but not at the requested sequence

### Community 174 - "Acceptance criteria — v1.0.0-perf-baseline"
Cohesion: 0.40
Nodes (4): Acceptance criteria — v1.0.0-perf-baseline, Boundary / non-goal assertions (must remain true), G13 — perf-correctness fixes (land first), G14 — benchmark harness + recorded baseline

### Community 175 - "GC architecture and query-tracing: research findings"
Cohesion: 0.40
Nodes (4): Decision: GC architecture, Decision: query tracing, GC architecture and query-tracing: research findings, What was checked and found NOT to hold up (excluded from the above)

### Community 176 - "9. Trust and refinement boundary"
Cohesion: 0.50
Nodes (4): 9. Trust and refinement boundary, Completed M1/M2/W1 claims, Deferred M2–M5 proof work, Named external obligations

### Community 177 - "Requirement: load always fully verifies chunk integrity before returning"
Cohesion: 0.50
Nodes (4): Requirement: load always fully verifies chunk integrity before returning, Scenario: A checkpoint whose stored chunk content matches its recorded hash loads successfully, Scenario: A chunk whose stored content no longer matches its recorded hash is rejected, Scenario: A manifest referencing a chunk absent from storage is rejected

### Community 178 - "Requirement: prune rejects a retainCount that is not a positive safe integer, before any deletion runs"
Cohesion: 0.50
Nodes (4): Requirement: prune rejects a retainCount that is not a positive safe integer, before any deletion runs, Scenario: A non-integer or non-finite retainCount is rejected with no effect, Scenario: An integer retainCount outside the safe integer range is rejected with no effect, Scenario: retainCount of zero is rejected with no effect

### Community 180 - "Requirement: A chunk still referenced by any surviving manifest is never reclaimed (Law C2a)"
Cohesion: 0.67
Nodes (3): Requirement: A chunk still referenced by any surviving manifest is never reclaimed (Law C2a), Scenario: A chunk shared across wallets survives one wallet's prune, Scenario: Interleaved save and prune never orphans a live manifest's chunk

### Community 181 - "Requirement: A manifest preserves the exact order and multiplicity of its chunks, including repeats"
Cohesion: 0.67
Nodes (3): Requirement: A manifest preserves the exact order and multiplicity of its chunks, including repeats, Scenario: A manifest's chunks are read back in position order regardless of storage order, Scenario: A payload containing a repeated chunk round-trips correctly

### Community 182 - "Requirement: An already-aborted opts.signal rejects before any database work; a signal aborting after the call has begun has no effect"
Cohesion: 0.67
Nodes (3): Requirement: An already-aborted opts.signal rejects before any database work; a signal aborting after the call has begun has no effect, Scenario: A call with an already-aborted signal is rejected before any database work, Scenario: A signal aborting after the call has begun does not interrupt it

### Community 183 - "Requirement: Checkpoint payloads are split into fixed-size chunks with a correctly-sized remainder"
Cohesion: 0.67
Nodes (3): Requirement: Checkpoint payloads are split into fixed-size chunks with a correctly-sized remainder, Scenario: A payload smaller than one chunk produces exactly one chunk, Scenario: A payload whose length is not a multiple of the chunk size produces a correctly-sized final chunk

### Community 184 - "Requirement: CheckpointSummary metadata is populated and label round-trips"
Cohesion: 0.67
Nodes (3): Requirement: CheckpointSummary metadata is populated and label round-trips, Scenario: A label given at save time is returned by history and load, Scenario: byteLength, chunkCount, and createdAt reflect the saved payload

### Community 185 - "Requirement: Chunk reclamation respects the grace window, protecting against re-reference races"
Cohesion: 0.67
Nodes (3): Requirement: Chunk reclamation respects the grace window, protecting against re-reference races, Scenario: A newly unreferenced chunk within the grace window is not reclaimed, Scenario: An unreferenced chunk past the grace window is eventually reclaimed

### Community 186 - "Requirement: Chunk storage is content-addressed and globally deduplicated"
Cohesion: 0.67
Nodes (3): Requirement: Chunk storage is content-addressed and globally deduplicated, Scenario: Identical chunk content across different checkpoints is stored once, Scenario: Re-referencing an existing chunk refreshes its GC clock

### Community 187 - "Requirement: history is newest-first, scoped per wallet+network, and supports cursor paging with no gap or duplicate"
Cohesion: 0.67
Nodes (3): Requirement: history is newest-first, scoped per wallet+network, and supports cursor paging with no gap or duplicate, Scenario: History for one wallet+network never includes another's checkpoints, Scenario: Paging with before continues without gap or duplicate

### Community 188 - "Requirement: manifestHash is computed once at write time from the ordered chunk-hash sequence"
Cohesion: 0.67
Nodes (3): Requirement: manifestHash is computed once at write time from the ordered chunk-hash sequence, Scenario: Identical payloads saved as separate checkpoints report the same manifestHash, Scenario: Payloads differing only in chunk order report different manifestHash

### Community 189 - "Requirement: prune retains exactly the N newest complete manifests per wallet+network"
Cohesion: 0.67
Nodes (3): Requirement: prune retains exactly the N newest complete manifests per wallet+network, Scenario: Pruning to retain k newest keeps exactly those k, Scenario: Pruning to retain the single newest manifest keeps only it

## Knowledge Gaps
- **1094 isolated node(s):** `IndexerTransaction`, `SubstrateBlock`, `MAX_BLOCKS`, `sql`, `service` (+1089 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **58 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `UmbraDBSql` connect `UmbraDBSql` to `transaction-lease.ts`, `sync-service.ts`, `temporal-kv.ts`, `pg-tx-history-adapter.ts`, `transaction-history-storage.test.ts`, `chain-archive-replay-decode.integration.test.ts`, `client.ts`, `cold-boot-recovery.integration.test.ts`, `checkpoint-store.ts`, `transaction-history-storage.ts`, `chain-archive-sync-retry.integration.test.ts`, `transaction-history-storage.ts`, `TransactionHistoryEntry`, `chain-archive-rollover.ts`?**
  _High betweenness centrality (0.014) - this node is a cross-community bridge._
- **Why does `translatePostgresError()` connect `UmbraDBSql` to `transaction-lease.ts`, `temporal-kv.ts`, `client.ts`, `errors.ts`, `checkpoint-store.ts`, `transaction-history-storage.ts`, `TransactionHistoryEntry`, `chain-archive-rollover.ts`?**
  _High betweenness centrality (0.010) - this node is a cross-community bridge._
- **Why does `ValidationError` connect `checkpoint-store.ts` to `transaction-lease.ts`, `temporal-kv.ts`, `pg-tx-history-adapter.ts`, `transaction-history-storage.test.ts`, `client.ts`, `errors.ts`, `transaction-history-storage.property.test.ts`, `transaction-history-storage.ts`, `UmbraDBSql`, `TransactionHistoryEntry`?**
  _High betweenness centrality (0.005) - this node is a cross-community bridge._
- **What connects `IndexerTransaction`, `SubstrateBlock`, `MAX_BLOCKS` to the rest of the system?**
  _1094 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `ADDED Requirements` be split into smaller, more focused modules?**
  _Cohesion score 0.043478260869565216 - nodes in this community are weakly interconnected._
- **Should `transaction-lease.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05289193302891933 - nodes in this community are weakly interconnected._
- **Should `temporal-kv.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06611813106082869 - nodes in this community are weakly interconnected._