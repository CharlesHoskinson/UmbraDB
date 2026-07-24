# Graph Report - UmbraDB-g6-durability  (2026-07-23)

## Corpus Check
- 235 files · ~364,517 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1957 nodes · 3081 edges · 178 communities (113 shown, 65 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 19 edges (avg confidence: 0.69)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `5ce62640`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- ADDED Requirements
- interfaces/transaction-lease.ts
- interfaces/temporal-kv.ts
- ADDED Requirements
- scoped-review-manifest
- Storage Algebra Lean Formalization — Approved Design and Status
- devDependencies
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
- design-algebra.md
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
- migrate.ts
- ADDED Requirements
- ADDED Requirements
- storage-errors.ts
- transaction-history-storage.property.test.ts
- Change: `v1.0.0-durable-checkpoint-cursor` — G6 / G7 / G8 (2026-07-24)
- Design — Sprint 8: WalletState Envelope + Live Preprod DB-Sync + Cold-Boot Recovery
- interfaces/transaction-history-storage.ts
- ADDED Requirements
- postgres/transaction-history-storage.ts
- translatePostgresError
- InMemoryTransactionHistoryStorage
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
- UmbraDB third-party component inventory (SBOM)
- Proposal — Sprint 5: Lean M3a Watermarks W1
- Tasks — Sprint 5: Lean M3a Watermarks W1
- postgres/checkpoint-store.ts
- ADDED Requirements
- Full-Chain Storage — Design
- checkpoint-store.test.ts
- Design — v1.0.0-durable-checkpoint-cursor
- postgres/watermarks.ts
- errors.ts
- chain_archive lineage
- ADDED Requirements
- Design — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)
- NodeRpcClient
- interfaces/chain-archive-store.ts
- Design — v1.0.0 API Surface & Release Contract
- chain-archive-sync-retry.integration.test.ts
- PgCheckpointStore
- ChainArchiveStore
- chain-archive-replay-decode.integration.test.ts
- PgTransactionLeaseLayer
- chain-archive-rollover.ts
- UmbraDB v1.0.0 — Resume-From-Home Checkpoint (2026-07-23)
- Tasks — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)
- UmbraDB
- Full-Chain Storage
- Storage Algebra Lean M3b CheckpointStore C1 Sprint
- Design — Sprint 6: Lean M3b CheckpointStore C1
- Proposal — Sprint 6: Lean M3b CheckpointStore C1
- Tasks — Sprint 6: Lean M3b CheckpointStore C1
- postgres/transaction-lease.ts
- UmbraDB Durability Contract
- midnight-env — reproducible PREPROD dev environment
- Tasks — v1.0.0 API Surface & Release Contract
- Design — v1.0.0-perf-baseline
- Acceptance criteria — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)
- §2 — Role conditions
- CheckpointStore
- checkpoint-id-validation.test.ts
- Design — v1.0.0-infosec-signoff
- Roadmap
- Feasibility: TLS for the Cardano db-sync database (Midnight partner-chain follower)
- MAX_ENTRY_CONTENT_DEPTH
- Acceptance — v1.0.0 API Surface & Release Contract
- ROADMAP.md
- Acceptance criteria — v1.0.0-infosec-signoff
- Tasks — v1.0.0-infosec-signoff
- TransactionHandle
- UmbraDB V1.0.0 Implementation Guideline — the release constitution
- Acceptance — v1.0.0-durable-checkpoint-cursor
- Tasks — v1.0.0-durable-checkpoint-cursor
- Proposal — v1.0.0-perf-baseline
- Proposal — v1.0.0 API Surface & Release Contract
- Proposal — v1.0.0-durable-checkpoint-cursor
- Proposal — v1.0.0-infosec-signoff
- Tasks — v1.0.0-perf-baseline
- Proposal — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)
- UmbraDB V1.0.0 — Lessons-Learned Living Log
- no-chain-sync-import-guard.test.ts
- Acceptance criteria — v1.0.0-perf-baseline
- checkpoint-store-cotx.test.ts
- start-stack.sh
- backup-state.sh
- enable-db-sync-tls.sh
- restore-state.sh
- stop-stack.sh
- test-wallets/README.md
- chain-archive-store.test.ts
- Checkpoint-store composition contract — cursor ordering and replay
- TemporalKV Algebra
- watermarks.test.ts
- Transaction/Lease Algebra
- TransactionLeaseLayer
- TransactionHistoryReader
- TransactionHistoryWriter
- UmbraDBSql
- checkpoint-store-contract-doc.test.ts

## God Nodes (most connected - your core abstractions)
1. `UmbraDBSql` - 58 edges
2. `translatePostgresError()` - 47 edges
3. `TransactionHandle` - 42 edges
4. `ValidationError` - 28 edges
5. `StorageError` - 27 edges
6. `createClient()` - 26 edges
7. `TransactionHistoryEntry` - 25 edges
8. `PgChainArchiveStore` - 25 edges
9. `PgTransactionLeaseLayer` - 24 edges
10. `resolveTransaction()` - 21 edges

## Surprising Connections (you probably didn't know these)
- `spyPool()` --references--> `UmbraDBSql`  [EXTRACTED]
  test/postgres/checkpoint-store-cotx.test.ts → src/postgres/client.ts
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

## Communities (178 total, 65 thin omitted)

### Community 0 - "ADDED Requirements"
Cohesion: 0.04
Nodes (45): ADDED Requirements, release-contract, Requirement: A cancellation contract states the abort guarantee as public behavior, Requirement: A CHANGELOG records the 1.0.0 surface, Requirement: A durability contract states the ordering guarantee and its binding precondition, Requirement: A format-headroom note reserves keyed/encrypted chunk modes for 1.1, Requirement: A forward-only migration contract states there is no supported downgrade, Requirement: A lease-limitation contract states the single-process boundary (+37 more)

### Community 1 - "interfaces/transaction-lease.ts"
Cohesion: 0.11
Nodes (13): LeaseFaultError, LeaseNotHeldError, LeaseTimeoutError, TransactionFaultError, TransactionHandleInvalidError, TransactionLeaseError, TransactionLeaseErrorCode, TransactionRollbackCause (+5 more)

### Community 2 - "interfaces/temporal-kv.ts"
Cohesion: 0.10
Nodes (30): AsOf, AssertExact, ExpectedVersionSchema, hasPostgresUnsafeText(), HistoryUnavailableError, JsonValue, jsonValueHasUnsafeText(), JsonValueInnerSchema (+22 more)

### Community 3 - "ADDED Requirements"
Cohesion: 0.08
Nodes (25): ADDED Requirements, Requirement: concurrent writers merging the same tx hash never lose a section, Requirement: driver-level failures surface as the shared StorageError hierarchy, Requirement: getAll returns live bigint/Date-typed values, not JSON-stringified primitives, Requirement: identifier-subset pending-clear rule survives repeated merges, Requirement: merge semantics are equivalent to mergeWalletEntries, not last-write-wins, Requirement: one storage instance is bound to exactly one wallet at construction, Requirement: serialize() is a full synchronous-equivalent dump matching the fixed interface contract (+17 more)

### Community 4 - "scoped-review-manifest"
Cohesion: 0.22
Nodes (8): Cleanup, scoped-review-manifest, Step 0 — Skip check, Step 1 — Freshness gate, Step 2 — Changed-file seed set, Step 3 — Blast-radius computation, Step 4 — Write the manifest, Step 5 — Hand off

### Community 5 - "Storage Algebra Lean Formalization — Approved Design and Status"
Cohesion: 0.04
Nodes (44): 10. Sprint 2 transaction/lease proposal, 11.1 Repository evidence, 11.2 External primary sources, 11. Evidence matrix, 12. Milestone status, 13. Approved implementation decisions, 1. Executive conclusion, 2.1 Historical implementation baseline (+36 more)

### Community 6 - "devDependencies"
Cohesion: 0.05
Nodes (38): effect, fast-check, @midnightntwrk/wallet-sdk-abstractions, dependencies, postgres, zod, devDependencies, effect (+30 more)

### Community 8 - "openspec-explore/SKILL.md"
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

### Community 33 - "design-algebra.md"
Cohesion: 0.24
Nodes (9): Superseded — see `Formal/STORAGE_ALGEBRA.md`, crdt-lean Dependency Refutation, CheckpointStore Algebra, ckpt_manifest_chunks Junction Table, Law C1 — Join-Semilattice Chunk Writes, Law C2 — GC Reachability Closure, Decision Against a Merkle/Authenticated Data Structure, CheckpointStore Type Signatures (+1 more)

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
Cohesion: 0.07
Nodes (41): TransactionHistoryStatus, phaseA_syncAndPersistEnvelope(), phaseB_freshProcessRestoreAndVerify(), facadeDistIndexPath(), facadeMergeAvailable(), loadFacadeMerge(), unshieldedWalletDistIndexPath(), deriveUnshieldedSeed() (+33 more)

### Community 70 - "CheckpointStore cancellation scope decision (pre-check only)"
Cohesion: 0.06
Nodes (32): Advisory-lock class registry (classes 1/2/3), Module → Postgres module mapping table, Postgres advisory-lock writer lease (corrected design), CheckpointNotFoundError, CheckpointStore interface, CheckpointWalletStateStore (production adapter), Global cross-wallet chunk GC reclamation fix, WalletStateStore (project abstraction) (+24 more)

### Community 71 - "transaction-history-storage.test.ts"
Cohesion: 0.20
Nodes (5): decodeSerializedContent(), decodeSerializedEntry(), FAKE_TX, insertRawRow(), { sql: getSql }

### Community 72 - "ADDED Requirements"
Cohesion: 0.11
Nodes (18): ADDED Requirements, formal-watermarks, Requirement: Command traces compose in list order, Requirement: Lookup after a trace returns the last matching value, Requirement: Set is an unconditional overwrite at the exact address, Requirement: Set preserves distinct addresses, Requirement: The abstract Watermarks store has one absence representation, Requirement: The W1 proof claim remains abstract (+10 more)

### Community 73 - "pull_request_template.md"
Cohesion: 0.50
Nodes (3): Change summary, Mandatory Codex audit, Validation

### Community 75 - "migrate.ts"
Cohesion: 0.11
Nodes (18): assertNoTransactionPooler(), classifyFsync(), classifyFullPageWrites(), classifySynchronousCommit(), DurabilityContractError, DurabilityProbeOptions, DurabilityViolation, DurabilityWarning (+10 more)

### Community 76 - "ADDED Requirements"
Cohesion: 0.05
Nodes (36): ADDED Requirements, Requirement: a cold boot resumes without a full resync and preserves tx-history continuity, Requirement: a corrupt or non-JSON envelope payload is rejected with a typed error, Requirement: a live-synced transaction materializes as a Postgres row observable via getAll, Requirement: a sub-wallet absent from the envelope is skipped on restore, Requirement: an unrecognized envelopeVersion is rejected, never best-effort restored, Requirement: each sub-wallet resumes from its own last-known point; the envelope bundles for atomicity only, Requirement: encode and decode are lossless inverses (+28 more)

### Community 77 - "ADDED Requirements"
Cohesion: 0.04
Nodes (45): ADDED Requirements, durable-composition (implementation), Requirement: a conforming composition keeps the durable cursor from ever being ahead of durable checkpoint data, Requirement: a durability probe asserts the server's crash-safety settings at client bootstrap, Requirement: a transaction-pooling proxy is detected and refused, Requirement: JsonValueSchema rejects values exceeding the maximum nesting depth, Requirement: migration advisory-lock acquisition is bounded and fails fast, Requirement: PgCheckpointStore validates walletId and networkId at every entry point (+37 more)

### Community 78 - "storage-errors.ts"
Cohesion: 0.10
Nodes (24): ConnectionError, SerializationFailedError, SharedStorageErrorCode, StorageError, ValidationError, decode(), encode(), ENVELOPE_VERSION (+16 more)

### Community 79 - "transaction-history-storage.property.test.ts"
Cohesion: 0.12
Nodes (16): EntryContent, applyCommand(), arbitraryCommand, badKeyValue, Command, GOOD_LEAF_KEYS, goodLeaf, goodNestedObject (+8 more)

### Community 80 - "Change: `v1.0.0-durable-checkpoint-cursor` — G6 / G7 / G8 (2026-07-24)"
Cohesion: 0.33
Nodes (5): Audit (round 1) — the confirmation-bias control paid off, Change: `v1.0.0-durable-checkpoint-cursor` — G6 / G7 / G8 (2026-07-24), Rework (class 4), UmbraDB v1.0.0 — Autonomous Run Log, Workflow friction (class 3)

### Community 81 - "Design — Sprint 8: WalletState Envelope + Live Preprod DB-Sync + Cold-Boot Recovery"
Cohesion: 0.11
Nodes (17): 1.1 Envelope shape, 1. Envelope decision: (a) one versioned envelope — DECIDED, 2. Module layout and dependency direction, 3.1 Field mapping (write path), 3.2 Lifecycle-detail fidelity — the correctness-gate open question, 3.3 No runtime SDK import in core, 3.4 serialize() is a diagnostic dump, not a migration path (F10), 3. The adapter (the seam) (+9 more)

### Community 82 - "interfaces/transaction-history-storage.ts"
Cohesion: 0.12
Nodes (16): exceedsMaxDepth(), EntryContentSchema, EntryLifecycleSchema, EntryLifecycleStatus, EntrySectionsSchema, FinalizedLifecycle, FinalizedLifecycleSchema, HashSchema (+8 more)

### Community 83 - "ADDED Requirements"
Cohesion: 0.05
Nodes (43): ADDED Requirements, Requirement: A real VerifyFull/--ca path is provided, replacing the stub (G17), Requirement: A shipped threat-model document states the single-trusted-writer trust model (G15), Requirement: CI gates any change to flake.lock behind explicit review (G18), Requirement: CI installs dependencies with npm ci (G18), Requirement: CI runs a blocking npm audit on runtime dependencies (G18), Requirement: CI runs full-history gitleaks secret scanning with the wallet history and template allowlisted (G18), Requirement: CI scans both pinned Docker image digests for CVEs (G18) (+35 more)

### Community 84 - "postgres/transaction-history-storage.ts"
Cohesion: 0.21
Nodes (16): EntryLifecycle, TransactionHistoryEntrySchema, assertStoredEntryShape(), capitalize(), decodeContent(), decodeRow(), decodeSections(), encodeContent() (+8 more)

### Community 85 - "translatePostgresError"
Cohesion: 0.13
Nodes (21): BlockBundle, BlockMeta, BlockRecord, BridgeObservationRecord, Hex32, Hex32Schema, TransactionMeta, TransactionRecord (+13 more)

### Community 86 - "InMemoryTransactionHistoryStorage"
Cohesion: 0.20
Nodes (5): MergeEntriesFn, TransactionHistoryStorage, abortErrorLike(), capitalize(), InMemoryTransactionHistoryStorage

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
Cohesion: 0.12
Nodes (14): IndexerBlock, IndexerClient, IndexerClientError, IndexerClientOptions, IndexerClientParseError, IndexerTransaction, NodeRpcClientOptions, ChainArchiveSyncService (+6 more)

### Community 99 - "UmbraDB third-party component inventory (SBOM)"
Cohesion: 0.06
Nodes (28): 1. npm — runtime dependencies, 2. npm — direct dev dependencies, 3. Nix — flake inputs (git-pinned), 4. Nix — pinned release binaries (`fetchurl` + sha256), 5. Docker images (digest-pinned), 6. Nix — nixpkgs packages (from the locked nixpkgs), 7. Lean / mathlib toolchain, 8. Host / toolchain dependencies (+20 more)

### Community 100 - "Proposal — Sprint 5: Lean M3a Watermarks W1"
Cohesion: 0.33
Nodes (5): Impact, Non-goals, Proposal — Sprint 5: Lean M3a Watermarks W1, What changes, Why

### Community 101 - "Tasks — Sprint 5: Lean M3a Watermarks W1"
Cohesion: 0.33
Nodes (5): 0. Specification freeze, 1. Executable Watermarks model, 2. W1 theorem tranche, 3. Close-out, Tasks — Sprint 5: Lean M3a Watermarks W1

### Community 102 - "postgres/checkpoint-store.ts"
Cohesion: 0.19
Nodes (18): assertValidCheckpointIds(), CheckpointIdSchema, CheckpointRecord, CheckpointSequence, CheckpointStoreErrorCode, CheckpointSummary, ContentHash, HistoryOptions (+10 more)

### Community 103 - "ADDED Requirements"
Cohesion: 0.06
Nodes (33): ADDED Requirements, performance-baseline (implementation), Requirement: a benchmark baseline is recorded as a committed artifact (the G14 gate), Requirement: a coarse smoke guard is wired now; the CV-aware regression gate is deferred, Requirement: an in-repo benchmark harness drives the real adapters against a pinned Postgres, Requirement: ckpt_chunks carries a stored size_bytes column computed without detoasting (IS-2), Requirement: history() computes per-manifest aggregates in a single grouped query (HP-2), Requirement: kv_current is fillfactor-tuned to preserve HOT-update eligibility (IS-1) (+25 more)

### Community 104 - "Full-Chain Storage — Design"
Cohesion: 0.06
Nodes (31): 10. Residual limitations and open questions for the design council, 11. Phasing table, 1. Problem and core principle, 2. Source grounding, 3.1 Block header, 3.2 Raw transaction blob (opaque SCALE-wrapped ledger tx), 3.3 Transactions / regular_transactions (queryable metadata split), 3.4 Unshielded UTXOs (+23 more)

### Community 105 - "checkpoint-store.test.ts"
Cohesion: 0.16
Nodes (6): CheckpointNotFoundError, CheckpointStoreError, ChunkIntegrityError, ChunkMissingError, ManifestCorruptError, { sql: getSql, connectionUri }

### Community 106 - "Design — v1.0.0-durable-checkpoint-cursor"
Cohesion: 0.07
Nodes (26): 0. Package layout, 1.1 The gap, confirmed in source, 1.2 Change `save` to accept a caller transaction, 1.3 The `saveAndAdvance` combinator, 1.4 The ordering contract (for callers composing manually), 1. G5 — Co-transactional watermark + checkpoint data, 2.1 Where the probe runs (the one real design decision), 2.2 The three durability settings (+18 more)

### Community 107 - "postgres/watermarks.ts"
Cohesion: 0.11
Nodes (19): RFC-8259, JsonValueSchema, WatermarkKey, WatermarkKind, Watermarks, WatermarkValue, WatermarkValueSchema, NOTE: this primitive is intentionally not yet re-exported from any barrel/`expor (+11 more)

### Community 108 - "errors.ts"
Cohesion: 0.13
Nodes (13): CHAIN_ARCHIVE_CHECK_TABLE_PREFIXES, CHAIN_ARCHIVE_INVARIANT_CONSTRAINT_NAMES, ChainArchiveCheckViolationError, ChainArchiveInvariantError, ClockRegressionError, CONNECTION_FAILURE_CODES, ExclusionViolationError, isChainArchiveCheckConstraintName() (+5 more)

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

### Community 113 - "interfaces/chain-archive-store.ts"
Cohesion: 0.16
Nodes (11): BlobIntegrityError, BlobMissingError, BlobRole, BlockNotFoundError, BlockStatus, BridgeObservationKind, ChainArchiveError, ChainArchiveErrorCode (+3 more)

### Community 114 - "Design — v1.0.0 API Surface & Release Contract"
Cohesion: 0.12
Nodes (15): 0. Ordering constraint (why this change is Phase 2, not Phase 1), 1.1 The barrel: `src/index.ts`, 1.2 `package.json` — make it publishable with a strict `exports`, 1.3 Packed-tarball install smoke test, 1. G1 — Public API surface, 2. G2 — SemVer stability policy + CHANGELOG, 3.1 The frozen catalog (the machine-facing API), 3.2 Promote retryability to a machine-readable field (+7 more)

### Community 115 - "chain-archive-sync-retry.integration.test.ts"
Cohesion: 0.19
Nodes (9): bootstrapChainArchiveSchema(), MAX_BLOCKS, service, sql, fakeChain(), fakeIndexerFetch(), fakeNodeFetch(), hx() (+1 more)

### Community 116 - "PgCheckpointStore"
Cohesion: 0.29
Nodes (7): PruneResult, coerceToSafeNumber(), PgCheckpointStore, sha256(), splitChunks(), toHex(), toSummary()

### Community 118 - "chain-archive-replay-decode.integration.test.ts"
Cohesion: 0.18
Nodes (17): decodeArchivedTransaction(), DecodedArchivedTransaction, DecodedDustRegistration, DecodedDustSpend, DecodedUnshieldedOutput, DecodedZswapInput, DecodedZswapOutput, isStandardTransaction() (+9 more)

### Community 119 - "PgTransactionLeaseLayer"
Cohesion: 0.35
Nodes (8): Lease, LeaseAcquireOptions, abortError(), PgTransactionLeaseLayer, raceAgainstAbort(), reserveBounded(), resetStatementTimeout(), InjectedReleaseFaultLayer

### Community 120 - "chain-archive-rollover.ts"
Cohesion: 0.19
Nodes (12): AnySql, assertDefaultSpanFitsOneBucket(), assertValidBucketBounds(), assertValidPartitionSuffix(), attachedPartitionBound(), getFkConstraintName(), quoteIdent(), ROLLOVER_TABLES (+4 more)

### Community 121 - "UmbraDB v1.0.0 — Resume-From-Home Checkpoint (2026-07-23)"
Cohesion: 0.20
Nodes (9): 1. Current `main` state, 2. Preprod sync — PAUSED (safely), no progress lost, 2a. Resume on THIS machine, 2b. Resume on a FRESH machine, 3. Reproducible environment, 4. Roadmap status — G5 done, 19 to go, 5. Established implementation workflow (follow it for G6–G8), 6. Worktree cleanup (+1 more)

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

### Community 129 - "postgres/transaction-lease.ts"
Cohesion: 0.22
Nodes (10): LeaseAcquireOptionsSchema, TransactionOptions, TransactionOptionsSchema, activeTransactions, HeldLease, registerTransaction(), RESERVE_TIMED_OUT, unregisterTransaction() (+2 more)

### Community 130 - "UmbraDB Durability Contract"
Cohesion: 0.25
Nodes (7): 1. `fsync = on` — probe-enforced, 2. `full_page_writes = on` — probe-enforced (overridable), 3. `synchronous_commit` — probe-warned, never refused, 4. Session-mode connection pooling only — probe-enforced (best-effort), 5. Server-side timeouts — applied by `createClient` (documented), Summary, UmbraDB Durability Contract

### Community 131 - "midnight-env — reproducible PREPROD dev environment"
Cohesion: 0.25
Nodes (7): 1. Reproducibility contract — what is pinned, and how, 2. Host-state assumptions the flake does NOT capture (the real impurities), 3. How to reproduce (exact steps), 4. Validation performed, 5. Impurity reduction vs. documented-as-known, midnight-env — reproducible PREPROD dev environment, Why `nix develop -c bash scripts/start-stack.sh` and not `nix run .#start-stack`

### Community 132 - "Tasks — v1.0.0 API Surface & Release Contract"
Cohesion: 0.18
Nodes (10): 0. Preconditions (blocking gate — verify before any freeze work), 1. Pre-freeze: retryability field (G3), 2. Pre-freeze: strip / mark-experimental the chain-archive error classes (G3), 3. The freeze: build + package.json (G1), 4. The freeze: the public barrel (G1), 5. Release contract docs (G2, G4), 6. Freeze the Lean cut-line (G20), 7. Packed-tarball install smoke test (G1) (+2 more)

### Community 133 - "Design — v1.0.0-perf-baseline"
Cohesion: 0.18
Nodes (10): 0. Package layout, 1. HP-1 — `save()` `UNNEST` batching (G13), 2. HP-2 + IS-2 — `history()` single `GROUP BY` over a stored `size_bytes` (G13), 3. IS-1 — `kv_current fillfactor=90` (G13), 4. G14 — benchmark harness, 5. G14 — the GC anti-join measurement + recorded baseline, 6. G14 — documented scalability ceilings (SC-1..SC-6), 7. Boundaries and non-goals respected (+2 more)

### Community 134 - "Acceptance criteria — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)"
Cohesion: 0.18
Nodes (10): Acceptance criteria — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`), Boundary / scope guardrails (council rulings honored), Crash between data and cursor — keystone (G9 / T5, depends on G5), Differential state-equivalence, in-repo (G11, fault-schedule half depends on G5), Full-sync soak + load-under-prune (G10), Lease non-wedge cold start (G9 / T3), Manual pre-tag Preprod evidence run (G12, release step 7, against the RC), Postgres-kill mid-save + retry contract (G9 / T2) (+2 more)

### Community 135 - "§2 — Role conditions"
Cohesion: 0.29
Nodes (7): §2.0 — Orchestrator (the role that can break independence by mistake), §2.1 — Implementation agent, §2.2 — Audit agent(s), §2.3 — QA agent, §2.4 — Usability / DX agent, §2.5 — Security agent, §2 — Role conditions

### Community 137 - "checkpoint-id-validation.test.ts"
Cohesion: 0.33
Nodes (4): Method, METHODS, OVERLONG_ID, { sql: getSql }

### Community 138 - "Design — v1.0.0-infosec-signoff"
Cohesion: 0.20
Nodes (9): 0. Scope boundary and what this change does NOT touch, 1. G15 — `SECURITY.md` / threat-model document, 2. G16 — CheckpointStore cross-wallet dedup interface-doc rewrite, 3. G17 — TLS caveat surfaced + VerifyFull/`--ca` de-stubbed, 4. G18 — Supply-chain CI gate, 5. G19 — Replace the committed Preview wallet secret, 6. Non-goals & boundaries respected (summary), Audit resolution (+1 more)

### Community 139 - "Roadmap"
Cohesion: 0.18
Nodes (11): 1.0.0 acceptance checklist, Beyond 1.0.0 — additional tracks in progress, Milestone 0 — Design (completed baseline), Milestone 1 — Formal (`Formal/`, in progress), Milestone 2 — Core implementation (module implementations complete), Milestone 3 — Testing (current), Milestone 4 — Performance (`Performance/`), Milestone 5 — Cutover (+3 more)

### Community 140 - "Feasibility: TLS for the Cardano db-sync database (Midnight partner-chain follower)"
Cohesion: 0.22
Nodes (8): 1. Driver — why this is now mandatory, 2. What the Cardano side does (and does not) provide, 3. Feasibility — demonstrated, 4. Security postures, 5. Folding into `nix/midnight-env`, 6. Risks / open items, 7. Verdict, Feasibility: TLS for the Cardano db-sync database (Midnight partner-chain follower)

### Community 143 - "Acceptance — v1.0.0 API Surface & Release Contract"
Cohesion: 0.22
Nodes (8): Acceptance — v1.0.0 API Surface & Release Contract, G1 — Public API surface, G20 — Lean cut-line, G2 — SemVer stability policy + CHANGELOG, G3 — Frozen, cleaned error catalog, G4 — Contract doc set (all true), Negative / boundary criteria (nothing out-of-scope leaked in), Precondition (blocks the whole change)

### Community 146 - "ROADMAP.md"
Cohesion: 0.29
Nodes (3): OpenSpec Change, Custom Node/TypeScript Benchmark Harness, Performance

### Community 150 - "Acceptance criteria — v1.0.0-infosec-signoff"
Cohesion: 0.25
Nodes (7): Acceptance criteria — v1.0.0-infosec-signoff, Cross-cutting council-ruling gates (close-out — Task 5.1), G15 — Threat-model / `SECURITY.md`, G16 — CheckpointStore dedup interface-doc caveat, G17 — TLS caveat surfaced + VerifyFull de-stubbed, localhost default kept, G18 — Supply-chain CI gate, G19 — Committed-secret remediation

### Community 151 - "Tasks — v1.0.0-infosec-signoff"
Cohesion: 0.25
Nodes (7): 0. Threat-model documentation hub (G15), 1. CheckpointStore interface-doc rewrite (G16) — depends on 0.3, 2. TLS caveat + VerifyFull de-stub (G17) — independent, 3. Supply-chain CI gate (G18) — 3.5 depends on 4.1, 4. Committed-secret remediation (G19) — mutually dependent with 3.5, 5. Change close-out, Tasks — v1.0.0-infosec-signoff

### Community 152 - "TransactionHandle"
Cohesion: 0.22
Nodes (5): TemporalKV, TransactionHistoryEntry, TransactionHandle, PgTransactionHistoryStorage, rowToEntry()

### Community 153 - "UmbraDB V1.0.0 Implementation Guideline — the release constitution"
Cohesion: 0.22
Nodes (9): §0 — Purpose & authority, §1 — The high-assurance spec→code workflow, §3 — Cross-cutting gates (apply to every gate item and every agent), §4.1 — Closing one roadmap gate item (G-N), §4.2 — The 1.0.0 tag gate, §4 — Gate-item close criteria & the 1.0.0 tag gate, §5 — Post-release lessons-learned protocol, Audit resolution (+1 more)

### Community 154 - "Acceptance — v1.0.0-durable-checkpoint-cursor"
Cohesion: 0.29
Nodes (6): Acceptance — v1.0.0-durable-checkpoint-cursor, G5 — Co-transactional watermark + checkpoint data, G6 — Durability startup probe + binding contract, G7 — Server-side timeouts, G8 — Contract-integrity fixes, Whole-change gates (non-goal compliance + sequencing)

### Community 155 - "Tasks — v1.0.0-durable-checkpoint-cursor"
Cohesion: 0.29
Nodes (6): 0. G5 — Co-transactional watermark + checkpoint data (do first; pre-freeze, signature-changing), 1. G6 — Durability startup probe + binding contract, 2. G7 — Server-side timeouts, 3. G8 — Contract-integrity fixes, 4. Change close-out, Tasks — v1.0.0-durable-checkpoint-cursor

### Community 156 - "Proposal — v1.0.0-perf-baseline"
Cohesion: 0.29
Nodes (6): 1.0.0 gate items addressed, Impact, Non-goals (explicitly out of scope for this change), Proposal — v1.0.0-perf-baseline, What changes, Why

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

### Community 169 - "UmbraDB V1.0.0 — Lessons-Learned Living Log"
Cohesion: 0.12
Nodes (16): A. Preventative actions to land or re-defer before iteration 2 begins, B. Named consumption targets (guideline §5.5) — record the actual edit made, C. Trend analysis (across events, not per-incident), Capture rules, D. Retro review sign-off, Entry template (copy per event), Event log (append-only; newest at bottom), Iteration-2 intake (+8 more)

### Community 170 - "no-chain-sync-import-guard.test.ts"
Cohesion: 0.53
Nodes (5): extractStringLiterals(), findChainSyncViolations(), GuardViolation, scanDirectory(), walkTsFiles()

### Community 174 - "Acceptance criteria — v1.0.0-perf-baseline"
Cohesion: 0.40
Nodes (4): Acceptance criteria — v1.0.0-perf-baseline, Boundary / non-goal assertions (must remain true), G13 — perf-correctness fixes (land first), G14 — benchmark harness + recorded baseline

### Community 176 - "checkpoint-store-cotx.test.ts"
Cohesion: 0.20
Nodes (4): Rollback, FAKE_TX, spyPool(), { sql: getSql, connectionUri }

### Community 199 - "chain-archive-store.test.ts"
Cohesion: 0.23
Nodes (5): chainArchiveMigrations, BlockRow, bundleFixture(), makeBlock(), TxRow

### Community 200 - "Checkpoint-store composition contract — cursor ordering and replay"
Cohesion: 0.25
Nodes (7): 1. The invariant: the cursor is never ahead of its data, 2.1 Atomic co-commit (preferred): `saveAndAdvance` or one shared `tx`, 2.2 Manual composition: advance the cursor **strictly after** the data commits, 2. The two conforming compositions, 3. Replay convergence is judged on CURRENT state, 4. Cross-reference, Checkpoint-store composition contract — cursor ordering and replay

### Community 201 - "TemporalKV Algebra"
Cohesion: 0.32
Nodes (8): Law T1 — Gapless Monotonicity, Law T2 — CAS Guarded Partial Action, Law T3 — Temporal Projection, Law T4 — Dual-Addressing Agreement, Law T5 — Temporal Coherence, One-Write-Per-Key-Per-Transaction Rule, TemporalKV Algebra, TemporalKV Type Signatures

### Community 204 - "Transaction/Lease Algebra"
Cohesion: 0.33
Nodes (6): Law L1 — Lease Mutual Exclusion, Law W1 — Last-Write-Wins, Transaction/Lease Algebra, Watermarks Algebra, Transaction/Lease Type Signatures, Watermarks Type Signatures

### Community 209 - "UmbraDBSql"
Cohesion: 0.14
Nodes (10): assertNoConflictingSearchPath(), assertValidSchemaName(), createClient(), UmbraDBConnectionOptions, UmbraDBSql, MigrationLockTimeoutError, createHeightPartitions(), up() (+2 more)

## Knowledge Gaps
- **927 isolated node(s):** `IndexerTransaction`, `SubstrateBlock`, `MAX_BLOCKS`, `sql`, `service` (+922 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **65 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `UmbraDBSql` connect `UmbraDBSql` to `postgres/transaction-lease.ts`, `interfaces/temporal-kv.ts`, `interfaces/transaction-lease.ts`, `TransactionHandle`, `checkpoint-store-cotx.test.ts`, `pg-tx-history-adapter.ts`, `chain-archive-store.test.ts`, `transaction-history-storage.test.ts`, `watermarks.test.ts`, `migrate.ts`, `TransactionLeaseLayer`, `storage-errors.ts`, `postgres/transaction-history-storage.ts`, `translatePostgresError`, `InMemoryTransactionHistoryStorage`, `sync-service.ts`, `postgres/checkpoint-store.ts`, `checkpoint-store.test.ts`, `postgres/watermarks.ts`, `chain-archive-sync-retry.integration.test.ts`, `chain-archive-replay-decode.integration.test.ts`, `PgTransactionLeaseLayer`, `chain-archive-rollover.ts`?**
  _High betweenness centrality (0.026) - this node is a cross-community bridge._
- **Why does `TransactionHandle` connect `TransactionHandle` to `interfaces/transaction-lease.ts`, `interfaces/temporal-kv.ts`, `postgres/transaction-lease.ts`, `postgres/checkpoint-store.ts`, `transaction-history-storage.test.ts`, `watermarks.test.ts`, `postgres/watermarks.ts`, `TransactionHistoryReader`, `TransactionHistoryWriter`, `checkpoint-store-cotx.test.ts`, `interfaces/transaction-history-storage.ts`, `PgCheckpointStore`, `postgres/transaction-history-storage.ts`?**
  _High betweenness centrality (0.013) - this node is a cross-community bridge._
- **Why does `StorageError` connect `storage-errors.ts` to `interfaces/transaction-lease.ts`, `interfaces/temporal-kv.ts`, `postgres/checkpoint-store.ts`, `checkpoint-store.test.ts`, `migrate.ts`, `errors.ts`, `interfaces/chain-archive-store.ts`, `UmbraDBSql`, `postgres/transaction-history-storage.ts`?**
  _High betweenness centrality (0.011) - this node is a cross-community bridge._
- **What connects `IndexerTransaction`, `SubstrateBlock`, `MAX_BLOCKS` to the rest of the system?**
  _927 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `ADDED Requirements` be split into smaller, more focused modules?**
  _Cohesion score 0.043478260869565216 - nodes in this community are weakly interconnected._
- **Should `interfaces/transaction-lease.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.11384615384615385 - nodes in this community are weakly interconnected._
- **Should `interfaces/temporal-kv.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.09724238026124818 - nodes in this community are weakly interconnected._