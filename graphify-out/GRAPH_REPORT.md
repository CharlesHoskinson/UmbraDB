# Graph Report - UmbraDB  (2026-10-03)

## Corpus Check
- 316 files · ~564,447 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 35 file(s) not represented in the graph (top: .lean 25, (none) 7, .toml 1)

## Summary
- 2705 nodes · 5886 edges · 213 communities (152 shown, 61 thin omitted)
- Extraction: 84% EXTRACTED · 16% INFERRED · 0% AMBIGUOUS · INFERRED: 952 edges (avg confidence: 0.94)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `3c0c68b3`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- ADDED Requirements
- postgres/transaction-lease.ts
- .put
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
- Transactions commit or roll back atomically
- midnight-pg-store new package
- Requirements
- diagnostics_channel/tracingChannel Instrumentation Design
- OpenSpec Store
- Postgres errors surface as StorageError hierarchy requirement
- Storage Algebra Lean M2 Retention Sprint
- Law T1: gapless monotonic versions requirement
- Law T3: temporal-projection equivalence (getAt)
- Law T4: dual addressing agreement
- Law T5: history intervals never overlap
- TemporalKV Algebra
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
- CheckpointStore
- Watermarks AbortSignal pre-check-only requirement
- .getAll
- Top-level null value application-level guard
- Proposal — Sprint 7: Transaction History Storage (Wallet Integration Surface)
- complete flag explicit-write requirement
- pg-tx-history-adapter.ts
- CheckpointStore cancellation scope decision (pre-check only)
- transaction-history-storage.test.ts
- ADDED Requirements
- pull_request_template.md
- AGENTS.md
- 0. Preconditions (blocking gate — verify before any freeze work)
- ADDED Requirements
- saveAndAdvance
- ValidationError
- transaction-history-storage.property.test.ts
- Change: `v1.0.0-recovery-testing` — G9/G10/G11 crash-injection + soak + differential (2026-07-24)
- .save
- compilerOptions
- ADDED Requirements
- postgres/transaction-history-storage.ts
- translatePostgresError
- TransactionHistoryEntry
- ADDED Requirements
- Storage Algebra Lean M3a Watermarks Sprint
- UmbraDB dev environment — master runbook
- Sprint 7 — Midnight preprod toolchain inventory & build checklist
- Design — Sprint 5: Lean M3a Watermarks W1
- PgTransactionHistoryStorage
- Midnight infra verification checklist
- What changes — the 1.0.0 gate items this change addresses
- Preprod connection — endpoints, wallet, faucet
- Environment changelog
- src/index.ts
- sync-service.ts
- UmbraDB third-party component inventory (SBOM)
- Proposal — Sprint 5: Lean M3a Watermarks W1
- Tasks — Sprint 5: Lean M3a Watermarks W1
- cursor-durability.crash.test.ts
- ADDED Requirements
- Full-Chain Storage — Design
- TransactionHandle
- Design — v1.0.0-durable-checkpoint-cursor
- resolveTransaction
- errors.ts
- VersionConflictError
- ADDED Requirements
- Design — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)
- NodeRpcClient
- postgres/chain-archive-store.ts
- Design — v1.0.0 API Surface & Release Contract
- chain-archive-store.test.ts
- postgres/checkpoint-store.ts
- ChainArchiveStore
- chain-archive-replay-decode.integration.test.ts
- registerSuiteLifecycle
- chain-archive-rollover.ts
- UmbraDB v1.0.0 — Resume-From-Home Checkpoint (2026-07-23)
- Tasks — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)
- UmbraDB
- 2.1 The boundary rule (the feature's key design decision)
- Storage Algebra Lean M3b CheckpointStore C1 Sprint
- Design — Sprint 6: Lean M3b CheckpointStore C1
- chain-archive-preprod-cloud-crossval.integration.test.ts
- Tasks — Sprint 6: Lean M3b CheckpointStore C1
- Scalability ceilings (v1.0.0)
- runMigrations
- midnight-env — reproducible PREPROD dev environment
- Tasks — v1.0.0 API Surface & Release Contract
- Design — v1.0.0-perf-baseline
- ChunkMissingError
- assertValidSchemaName
- UmbraDB 1.0.0 Release Contracts
- chain-archive-sync-retry.integration.test.ts
- Design — v1.0.0-infosec-signoff
- Roadmap
- Feasibility: TLS for the Cardano db-sync database (Midnight partner-chain follower)
- Tasks — v1.0.0: Formal completion (`formal-completion`)
- full-sync-soak.integration.test.ts
- StorageError
- UmbraDB v0.9.5 "Penumbra" — Release Record
- differential-equivalence.test.ts
- ROADMAP.md
- check-required-tests.ts
- stryker.conf.json
- setup.ts
- Acceptance criteria — v1.0.0-infosec-signoff
- Tasks — v1.0.0-infosec-signoff
- interfaces/temporal-kv.ts
- UmbraDB V1.0.0 Implementation Guideline — the release constitution
- UmbraDBConnectionOptions
- Design — v1.1.0: Quint model checking
- Proposal — v1.0.0-perf-baseline
- cold-boot-recovery.integration.test.ts
- pg-kill-save.crash.test.ts
- withSuiteWatchdog
- temporal-kv.test.ts
- crash-worker.ts
- mutation-per-adapter.mjs
- load-under-prune.integration.test.ts
- Proposal — v1.0.0 API Surface & Release Contract
- UmbraDB 0.9.5 "Penumbra"
- decode
- Tasks — v1.0.0-perf-baseline
- Spec — `model-checking` capability
- UmbraDB V1.0.0 — Lessons-Learned Living Log
- Proposal — v1.1.0: Quint model checking (`quint-model-checking`)
- lease-nonwedge.crash.test.ts
- scripts
- Tasks — v1.1.0: Quint model checking
- .save
- checkpoint-id-validation.test.ts
- G12 / R5 — manual pre-tag Preprod round-trip evidence
- README.md
- facade-merge-loader.ts
- start-stack.sh
- Roadmap for the missing formalization
- vitest
- CrashWorkerHandle
- watermarks.test.ts
- barrel-resolves.test.ts
- ASSESSMENT — `midnight-node-archive` Peer Flapping (Midnight Preprod, WSL2 Docker Host)
- package.json
- mutation-evidence.d.mts
- Research Assessment: Single-Statement Unbounded `bytea` Inserts via postgres.js
- [0.9.5] - 2026-07-25 — "Penumbra"
- backup-state.sh
- enable-db-sync-tls.sh
- restore-state.sh
- stop-stack.sh
- Test wallets
- dependencies
- PgTransactionLeaseLayer
- MPE recovery composition
- Acceptance — v1.0.0: Formal completion (`formal-completion`)
- migrate.ts
- Requirement: JsonValueSchema rejects values exceeding the maximum nesting depth
- Proposal — v1.0.0: Formal completion (`formal-completion`)
- 1. The twenty gate items
- Acceptance — v1.1.0: Quint model checking
- Audit record — `v1.1.0-formal-completion` roadmap (v1 → v2)
- client.ts
- Midnight Express recovery profile — future release
- 7. Testing strategy (post-implementation)
- Spec — capability `formal-completion`
- repository
- generate-test-wallet.sh
- bugs
- engines

## God Nodes (most connected - your core abstractions)
1. `PgTransactionLeaseLayer` - 83 edges
2. `runMigrations()` - 80 edges
3. `PgCheckpointStore` - 75 edges
4. `translatePostgresError()` - 71 edges
5. `UmbraDBSql` - 70 edges
6. `createClient()` - 70 edges
7. `PgTransactionHistoryStorage` - 70 edges
8. `vitest` - 67 edges
9. `ValidationError` - 61 edges
10. `1.1 The barrel: `src/index.ts`` - 60 edges

## Surprising Connections (you probably didn't know these)
- `Scenario: load before any save rejects with CheckpointNotFoundError` --references--> `CheckpointNotFoundError`  [INFERRED]
  openspec/changes/sprint-8-wallet-envelope-live-sync/specs/wallet-state-envelope/spec.md → src/interfaces/checkpoint-store.ts
- `The honest-test pattern (what makes each required test non-vacuous)` --references--> `ChunkMissingError`  [INFERRED]
  AUTONOMOUS_RUN_LOG.md → src/interfaces/checkpoint-store.ts
- `Audit resolution` --references--> `ChunkMissingError`  [INFERRED]
  openspec/changes/v1.0.0-recovery-testing/design.md → src/interfaces/checkpoint-store.ts
- `CheckpointStore: content-addressed snapshots` --references--> `ManifestCorruptError`  [INFERRED]
  README.md → src/interfaces/checkpoint-store.ts
- `4.1 `chain_blobs` / `chain_blob_roles` — content-addressed blob store (unchanged decision: new sibling table, NOT an in-place extension of `ckpt_chunks`)` --references--> `CheckpointStore`  [INFERRED]
  design/full-chain-storage-design.md → src/interfaces/checkpoint-store.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **The Nine Laws Forming UmbraDB's Storage Algebra** — formal_storage_algebra_law_t1, formal_storage_algebra_law_t2, formal_storage_algebra_law_t3, formal_storage_algebra_law_t4, formal_storage_algebra_law_t5, formal_storage_algebra_law_c1, formal_storage_algebra_law_c2, formal_storage_algebra_law_w1, formal_storage_algebra_law_l1 [EXTRACTED 1.00]
- **Four storage modules unified under StorageError hierarchy** — design_design_interfaces_storageerror, design_design_interfaces_temporalkv, design_design_interfaces_checkpointstore, design_design_interfaces_watermarks, design_design_interfaces_transactionleaselayer_stale [EXTRACTED 1.00]
- **Modules composing the Sprint 2 transaction-handle registry** — sprint2_design_transaction_handle_registry, sprint1_design_pgtemporalkv_put, sprint3_design_torn_read_fix, sprint4_design_composing_txlease [EXTRACTED 1.00]
- **Pre-check-only withAbort cancellation pattern across sprints** — sprint1_design_listkeys_cursor, sprint2_design_withtransaction, sprint3_design_cancellation_scope_decision, sprint4_design_cancellation [INFERRED 0.85]

## Communities (213 total, 61 thin omitted)

### Community 0 - "ADDED Requirements"
Cohesion: 0.06
Nodes (33): ADDED Requirements, release-contract, Requirement: A cancellation contract states the abort guarantee as public behavior, Requirement: A CHANGELOG records the 1.0.0 surface, Requirement: A durability contract states the ordering guarantee and its binding precondition, Requirement: A format-headroom note reserves keyed/encrypted chunk modes for 1.1, Requirement: A forward-only migration contract states there is no supported downgrade, Requirement: A lease-limitation contract states the single-process boundary (+25 more)

### Community 1 - "postgres/transaction-lease.ts"
Cohesion: 0.09
Nodes (33): 4.3 Stop `withLease` swallowing release failures, Requirement: withLease surfaces a lease-release failure instead of swallowing it, Scenario: a clean release is unaffected, Scenario: a release failure after a successful fn, with a callback, resolves and reports, Scenario: a release failure after a successful fn, with no callback, rejects, Scenario: fn's own error stays primary while a release failure is still surfaced, 3. G8 — Contract-integrity fixes, Lease (+25 more)

### Community 2 - ".put"
Cohesion: 0.21
Nodes (12): 1.1 The gap, confirmed in source, 1.4 The ordering contract (for callers composing manually), 1. G5 — Co-transactional watermark + checkpoint data, 6.1 — P3 is the differential gate's replay-equivalence / fold anchor (documentation, no new test code), Gate notes — Task 6: differential state-equivalence gate (G11), AsOf, Key, Namespace (+4 more)

### Community 3 - "ADDED Requirements"
Cohesion: 0.10
Nodes (19): ADDED Requirements, Requirement: concurrent writers merging the same tx hash never lose a section, Requirement: getAll returns live bigint/Date-typed values, not JSON-stringified primitives, Requirement: identifier-subset pending-clear rule survives repeated merges, Requirement: merge semantics are equivalent to mergeWalletEntries, not last-write-wins, Requirement: serialize() is a full synchronous-equivalent dump matching the fixed interface contract, Requirement: the merge function is caller-supplied and never a wallet-SDK runtime import, Scenario: A bare upsert without a row lock is insufficient (negative control, implementation note) (+11 more)

### Community 4 - "scoped-review-manifest"
Cohesion: 0.22
Nodes (8): Cleanup, scoped-review-manifest, Step 0 — Skip check, Step 1 — Freshness gate, Step 2 — Changed-file seed set, Step 3 — Blast-radius computation, Step 4 — Write the manifest, Step 5 — Hand off

### Community 5 - "Storage Algebra Lean Formalization — Approved Design and Status"
Cohesion: 0.04
Nodes (44): 10. Sprint 2 transaction/lease proposal, 11.1 Repository evidence, 11.2 External primary sources, 11. Evidence matrix, 12. Milestone status, 13. Approved implementation decisions, 1. Executive conclusion, 2.1 Historical implementation baseline (+36 more)

### Community 6 - "devDependencies"
Cohesion: 0.14
Nodes (14): devDependencies, effect, fast-check, @midnightntwrk/wallet-sdk-abstractions, @stryker-mutator/core, @stryker-mutator/vitest-runner, @testcontainers/postgresql, tinybench (+6 more)

### Community 8 - "openspec-explore/SKILL.md"
Cohesion: 0.12
Nodes (16): Check for context, Ending Discovery, Guardrails, Handling Different Entry Points, OpenSpec Awareness, The Stance, What You Don't Have To Do, What You Might Do (+8 more)

### Community 10 - "compilerOptions"
Cohesion: 0.17
Nodes (11): compilerOptions, declaration, esModuleInterop, module, moduleResolution, noEmit, noUncheckedIndexedAccess, skipLibCheck (+3 more)

### Community 11 - "kv_current/kv_history temporal-table design"
Cohesion: 0.05
Nodes (38): Content-addressed checkpoint chunker, ckpt_manifest_chunks junction table (original, later corrected), State-equivalence merge-blocker gate, kv_current/kv_history temporal-table design, TransactionKeyReuseError / txid_current() fix, watermarks table schema sketch, TemporalKV interface, VersionConflictError (+30 more)

### Community 20 - "Requirements"
Cohesion: 0.08
Nodes (24): Purpose, Requirement: A caller-supplied transaction handle is honored or rejected, never silently ignored, Requirement: Dual addressing agrees at recorded write timestamps (Law T4), Requirement: getAt satisfies temporal-projection equivalence (Law T3), within the store's retention window, Requirement: History intervals never overlap for a single key (Law T5), Requirement: listKeys streams without materializing the full result set first, and orders results correctly, Requirement: Migrations are idempotent and ordered, Requirement: Schema isolation is the default, not opt-in (+16 more)

### Community 27 - "Storage Algebra Lean M2 Retention Sprint"
Cohesion: 0.15
Nodes (12): Adversarial test matrix, Approved semantic decisions, Completed baseline, Executable pruning, Explicit non-goals, Extensional T5, Implemented source layout, Lookup classification (+4 more)

### Community 33 - "TemporalKV Algebra"
Cohesion: 0.10
Nodes (19): Superseded — see `Formal/STORAGE_ALGEBRA.md`, CheckpointStore Algebra, ckpt_manifest_chunks Junction Table, Law C1 — Join-Semilattice Chunk Writes, Law C2 — GC Reachability Closure, Law L1 — Lease Mutual Exclusion, Law T1 — Gapless Monotonicity, Law T2 — CAS Guarded Partial Action (+11 more)

### Community 35 - "Global Constraints"
Cohesion: 0.25
Nodes (7): Global Constraints, Plan Self-Review, Storage Algebra Lean M1 Implementation Plan, Task 1: Pin the project and prove the imported API smoke slice, Task 2: Implement the executable TemporalKV history kernel, Task 3: Prove the M1 TemporalKV theorem slice, Task 4: Add reproducible trust gates and close the M1 documentation loop

### Community 57 - "Tasks — Sprint 7: Transaction History Storage"
Cohesion: 0.20
Nodes (9): 0. Specification freeze, 1. Vendor/pin manifest, 2. Schema + interface, 3. PgTransactionHistoryStorage implementation, 4. WalletState envelope, 5. Storage-swappable conformance harness (Pg-only tier — required merge gate), 6. Live-sync tier (nightly/labeled — blocked on design.md §7's open question), 7. Close-out (+1 more)

### Community 63 - "CheckpointStore"
Cohesion: 0.10
Nodes (33): Added, 1. Decisive scope, 2. Live-sync conformance test plan, 3. Open questions for the design-drafting stage, 4. Prioritized artifacts (dependency order), Architectural boundary (explicit owner directive, confirmed post-consolidation), Build (one product module + one thin envelope — corrected from the original "exactly two things, zero new code" framing; see finding below), Do not build (obsoleted — confirmed against real source) (+25 more)

### Community 65 - ".getAll"
Cohesion: 0.15
Nodes (11): 2. Dependency direction: structural mirror, not a runtime import, 3. Atomic merge under concurrent writers, 4. Multi-wallet identity, 5. WalletState envelope, 6. Open questions carried into this sprint (unresolved, tracked here rather than silently defaulted), 7. What "live-sync" means for this sprint's non-required test tier, Design — Sprint 7: Transaction History Storage, Requirement: a cold boot resumes without a full resync and preserves tx-history continuity (+3 more)

### Community 66 - "Top-level null value application-level guard"
Cohesion: 0.67
Nodes (3): prune retainCount validation requirement, Top-level null value application-level guard, set rejects top-level null requirement

### Community 67 - "Proposal — Sprint 7: Transaction History Storage (Wallet Integration Surface)"
Cohesion: 0.29
Nodes (6): Impact, Non-goals, Proposal — Sprint 7: Transaction History Storage (Wallet Integration Surface), What changes, Why, Why this sprint is numbered 7, not 5

### Community 69 - "pg-tx-history-adapter.ts"
Cohesion: 0.09
Nodes (24): 3. Adapter seam (Pg-only for its own tier — required gate), @midnightntwrk/wallet-sdk-abstractions, assertNoReservedAdapterKeys(), COMMON_FIELD_NAMES, DANGEROUS_EXTENSION_KEYS, describeStatusValue(), LifecycleDetailStore, LifecycleDetailStoreSchema (+16 more)

### Community 70 - "CheckpointStore cancellation scope decision (pre-check only)"
Cohesion: 0.06
Nodes (30): Advisory-lock class registry (classes 1/2/3), Module → Postgres module mapping table, Postgres advisory-lock writer lease (corrected design), CheckpointNotFoundError, CheckpointStore interface, CheckpointWalletStateStore (production adapter), WalletStateStore (project abstraction), Watermarks interface (+22 more)

### Community 71 - "transaction-history-storage.test.ts"
Cohesion: 0.20
Nodes (7): THS_RESERVED_KEY_PREFIX, decodeSerializedContent(), decodeSerializedEntry(), FAKE_TX, { sql: getSql }, store(), txLayer()

### Community 72 - "ADDED Requirements"
Cohesion: 0.11
Nodes (18): ADDED Requirements, formal-watermarks, Requirement: Command traces compose in list order, Requirement: Lookup after a trace returns the last matching value, Requirement: Set is an unconditional overwrite at the exact address, Requirement: Set preserves distinct addresses, Requirement: The abstract Watermarks store has one absence representation, Requirement: The W1 proof claim remains abstract (+10 more)

### Community 73 - "pull_request_template.md"
Cohesion: 0.50
Nodes (3): Change summary, Mandatory Codex audit, Validation

### Community 75 - "0. Preconditions (blocking gate — verify before any freeze work)"
Cohesion: 0.27
Nodes (12): 3. `synchronous_commit` — probe-warned, never refused, 0. Preconditions (blocking gate — verify before any freeze work), assertNoTransactionPooler(), classifyFsync(), classifyFullPageWrites(), classifySynchronousCommit(), DurabilityProbeOptions, DurabilityViolation (+4 more)

### Community 76 - "ADDED Requirements"
Cohesion: 0.08
Nodes (23): 2. Module layout and dependency direction, ADDED Requirements, Requirement: a live-synced transaction materializes as a Postgres row observable via getAll, Requirement: each sub-wallet resumes from its own last-known point; the envelope bundles for atomicity only, Requirement: encode and decode are lossless inverses, Requirement: getAll returns live bigint/Date-typed common fields through the adapter, Requirement: load returns the persisted envelope, by latest or explicit sequence, Requirement: loading a never-saved wallet surfaces a typed not-found, not a silent empty result (+15 more)

### Community 77 - "saveAndAdvance"
Cohesion: 0.08
Nodes (29): Reconciliations recorded as consolidating-lead decisions (spec written pre-G6/G7), 1. The invariant: the cursor is never ahead of its data, 2.1 Atomic co-commit (preferred): `saveAndAdvance` or one shared `tx`, 2.2 Manual composition: advance the cursor **strictly after** the data commits, 2. The two conforming compositions, 4. Cross-reference, Checkpoint-store composition contract — cursor ordering and replay, 5.1 Archival reconciliation note (Opus N6) (+21 more)

### Community 78 - "ValidationError"
Cohesion: 0.11
Nodes (22): 1.1 Envelope shape, 7.1 Unit / property (Pg-only, required gate) — `test:conformance`, Requirement: a sub-wallet absent from the envelope is skipped on restore, Scenario: An unshielded-only envelope restores the unshielded sub-wallet and skips the others, 2. Envelope module (Pg-only — required gate), Requirement: PgCheckpointStore validates walletId and networkId at every entry point, Scenario: a NUL-containing walletId is rejected with ValidationError at each entry point, Scenario: a valid id continues to work unchanged (+14 more)

### Community 79 - "transaction-history-storage.property.test.ts"
Cohesion: 0.12
Nodes (15): EntryContent, applyCommand(), arbitraryCommand, badKeyValue, Command, GOOD_LEAF_KEYS, goodNestedObject, HASH_POOL (+7 more)

### Community 80 - "Change: `v1.0.0-recovery-testing` — G9/G10/G11 crash-injection + soak + differential (2026-07-24)"
Cohesion: 0.15
Nodes (12): Change: `v1.0.0-perf-baseline` — G13 / G14 (2026-07-24), Change: `v1.0.0-recovery-testing` — G9/G10/G11 crash-injection + soak + differential (2026-07-24), Rework (class 1 — infra), Rework (class 1 — infra flake, not a change defect), Rework (class 2 — Task 0 foundation: two audits DIVERGED on severity), Rework (class 2 — the machine oracle caught what BOTH diff-scoped audits could not), Rework (class 3 continued — cross-vendor cold audit, rounds 2-4), Rework (class 3 continued — the change-level cold audit rounds: the tests were honest, the ENFORCEMENT wasn't) (+4 more)

### Community 81 - ".save"
Cohesion: 0.13
Nodes (11): Impact, Non-goals, Proposal — Sprint 6: Lean M3b CheckpointStore C1, What changes, Why, 1. Envelope decision: (a) one versioned envelope — DECIDED, 4. Live preprod DB-sync verification (nightly/labeled), 5. Cold-boot recovery, and the cross-sub-wallet consistency contract (+3 more)

### Community 82 - "compilerOptions"
Cohesion: 0.17
Nodes (11): ./tsconfig.json, compilerOptions, declaration, declarationMap, noEmit, outDir, rootDir, sourceMap (+3 more)

### Community 83 - "ADDED Requirements"
Cohesion: 0.05
Nodes (43): ADDED Requirements, Requirement: A real VerifyFull/--ca path is provided, replacing the stub (G17), Requirement: A shipped threat-model document states the single-trusted-writer trust model (G15), Requirement: CI gates any change to flake.lock behind explicit review (G18), Requirement: CI installs dependencies with npm ci (G18), Requirement: CI runs a blocking npm audit on runtime dependencies (G18), Requirement: CI runs full-history gitleaks secret scanning with the wallet history and template allowlisted (G18), Requirement: CI scans both pinned Docker image digests for CVEs (G18) (+35 more)

### Community 84 - "postgres/transaction-history-storage.ts"
Cohesion: 0.18
Nodes (17): 3.2 Lifecycle-detail fidelity — the correctness-gate open question, SerializationFailedError, EntryLifecycle, assertStoredEntryShape(), capitalize(), decodeContent(), decodeRow(), decodeSections() (+9 more)

### Community 85 - "translatePostgresError"
Cohesion: 0.20
Nodes (13): Excluded: the deferred chain-archive codes, `chain_blobs` / `chain_blob_roles`, Scenario: Internal 23514 routing still resolves the right class without freezing it, BlockRecord, Hex32, TransactionMeta, assertHex32(), hexToBuf() (+5 more)

### Community 86 - "TransactionHistoryEntry"
Cohesion: 0.29
Nodes (6): Requirement: the Pg-backed and in-memory reference are sequentially equivalent for single-writer traces, Scenario: An identical sequential fixture produces identical getAll() output on both backends, TransactionHistoryEntry, abortErrorLike(), capitalize(), InMemoryTransactionHistoryStorage

### Community 87 - "ADDED Requirements"
Cohesion: 0.06
Nodes (35): ADDED Requirements, recovery-testing (crash-injection, soak, differential & live-evidence gate), Requirement: G10 — a full-sync soak runs at a declared envelope with GC passes and holds every invariant, Requirement: G11/T11 — a fault-schedule run is state-equivalent to a fault-free reference, Requirement: G11 — the differential gate is anchored on the P3 replay-equivalence property, Requirement: G12 — a manual pre-tag Preprod round-trip is run against the RC with recorded evidence, Requirement: G9 — a skip-enforcement check proves every required crash test executed, none silently skipped, Requirement: G9/T1 — process-kill mid-save leaves no partially-visible checkpoint (+27 more)

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

### Community 92 - "PgTransactionHistoryStorage"
Cohesion: 0.09
Nodes (26): `transaction_history`, 1. Schema, Requirement: one storage instance is bound to exactly one wallet at construction, Scenario: Two instances constructed for different wallets never see each other's rows, 3.1 Field mapping (write path), 3.3 No runtime SDK import in core, 3.4 serialize() is a diagnostic dump, not a migration path (F10), 3. The adapter (the seam) (+18 more)

### Community 93 - "Midnight infra verification checklist"
Cohesion: 0.29
Nodes (6): A. Toolchain & binaries (all self-serve from public source), B. Preprod connectivity (public endpoints, verified live), C. Our wallet, D. Operations to verify (the requested end-to-end), E. Our from-source node (prove the build works as a real node), Midnight infra verification checklist

### Community 94 - "What changes — the 1.0.0 gate items this change addresses"
Cohesion: 0.23
Nodes (12): 2.2 Storage layer (`src/interfaces/chain-archive-store.ts` + `src/postgres/chain-archive-store.ts`), 3.3 Strip / mark-experimental the chain-archive error classes (pre-freeze obligation), What changes — the 1.0.0 gate items this change addresses, Requirement: The chain-archive error classes are excluded from the frozen surface, Scenario: Chain-archive classes are not exported and their codes are not frozen, 2. Pre-freeze: strip / mark-experimental the chain-archive error classes (G3), BlobIntegrityError, BlobMissingError (+4 more)

### Community 95 - "Preprod connection — endpoints, wallet, faucet"
Cohesion: 0.33
Nodes (5): Faucet (get tNIGHT), Our preprod wallet, Preprod connection — endpoints, wallet, faucet, Public preprod endpoints (all verified live), Sync cost (CORRECTED — no block-height "birthday" for the unshielded wallet)

### Community 97 - "src/index.ts"
Cohesion: 0.27
Nodes (16): 1.1 The barrel: `src/index.ts`, Scenario: A deep subpath into an internal module is blocked by the exports map, CheckpointStoreErrorCode, SharedStorageErrorCode, TemporalKVErrorCode, EntryLifecycleStatus, FinalizedLifecycle, PendingLifecycle (+8 more)

### Community 98 - "sync-service.ts"
Cohesion: 0.19
Nodes (14): IndexerBlock, IndexerClientOptions, NodeRpcClientOptions, ChainArchiveSyncService, ChainArchiveSyncServiceOptions, extrinsicsBytes(), headerBytes(), hexNoPrefix() (+6 more)

### Community 99 - "UmbraDB third-party component inventory (SBOM)"
Cohesion: 0.06
Nodes (28): 1. npm — runtime dependencies, 2. npm — direct dev dependencies, 3. Nix — flake inputs (git-pinned), 4. Nix — pinned release binaries (`fetchurl` + sha256), 5. Docker images (digest-pinned), 6. Nix — nixpkgs packages (from the locked nixpkgs), 7. Lean / mathlib toolchain, 8. Host / toolchain dependencies (+20 more)

### Community 100 - "Proposal — Sprint 5: Lean M3a Watermarks W1"
Cohesion: 0.33
Nodes (5): Impact, Non-goals, Proposal — Sprint 5: Lean M3a Watermarks W1, What changes, Why

### Community 101 - "Tasks — Sprint 5: Lean M3a Watermarks W1"
Cohesion: 0.33
Nodes (5): 0. Specification freeze, 1. Executable Watermarks model, 2. W1 theorem tranche, 3. Close-out, Tasks — Sprint 5: Lean M3a Watermarks W1

### Community 102 - "cursor-durability.crash.test.ts"
Cohesion: 0.08
Nodes (32): JsonValue, KvRow, adaptersFor(), ALL_BATCH_SPECS, ALL_BATCHES, BatchSpec, completeManifestCount(), CurrentState (+24 more)

### Community 103 - "ADDED Requirements"
Cohesion: 0.07
Nodes (28): ADDED Requirements, performance-baseline (implementation), Requirement: a benchmark baseline is recorded as a committed artifact (the G14 gate), Requirement: a coarse smoke guard is wired now; the CV-aware regression gate is deferred, Requirement: ckpt_chunks carries a stored size_bytes column computed without detoasting (IS-2), Requirement: kv_current is fillfactor-tuned to preserve HOT-update eligibility (IS-1), Requirement: save() issues a bounded number of round-trips independent of chunk count (HP-1), Requirement: scalability ceilings are documented for 1.0.0 (+20 more)

### Community 104 - "Full-Chain Storage — Design"
Cohesion: 0.08
Nodes (25): 10. Residual limitations and open questions for the design council, 11. Phasing table, 1. Problem and core principle, 2. Source grounding, 3.1 Block header, 3.2 Raw transaction blob (opaque SCALE-wrapped ledger tx), 3.3 Transactions / regular_transactions (queryable metadata split), 3.4 Unshielded UTXOs (+17 more)

### Community 105 - "TransactionHandle"
Cohesion: 0.11
Nodes (6): TransactionHistoryReader, TransactionHistoryWriter, TransactionHandle, FAKE_TX, { sql: getSql, connectionUri }, txLayer()

### Community 106 - "Design — v1.0.0-durable-checkpoint-cursor"
Cohesion: 0.17
Nodes (11): 0. Package layout, 3.1 Connection defaults, 3.2 Bounded migration advisory-lock acquire, 3. G7 — Server-side timeouts, 4. G8 — Contract-integrity fixes, 6.1 The Fable-vs-Opus factual dispute (resolved by live test), 6.2 Blocking findings applied, 6.3 Non-blocking findings applied (+3 more)

### Community 107 - "resolveTransaction"
Cohesion: 0.18
Nodes (14): RFC-8259, Audit resolution, Requirement: A single public barrel exports exactly the frozen 1.0.0 surface, Scenario: Internal named symbols are not re-exported by the barrel, 8. Change close-out, WatermarkKey, WatermarkKind, WatermarkValue (+6 more)

### Community 108 - "errors.ts"
Cohesion: 0.15
Nodes (12): 4. Save-retry caveat, 2.2 Postgres-kill mid-save + retry-duplication contract (T2) — `02`-T2; `council/B` §3 item 2, TransactionFaultError, CHAIN_ARCHIVE_CHECK_TABLE_PREFIXES, CHAIN_ARCHIVE_INVARIANT_CONSTRAINT_NAMES, CONNECTION_FAILURE_CODES, isConnectionFailure(), isPgDriverError() (+4 more)

### Community 109 - "VersionConflictError"
Cohesion: 0.21
Nodes (11): CheckpointStore tables, `kv_current` / `kv_history` — TemporalKV, tier1_wallet lineage, `watermarks`, Requirement: put's CAS guard distinguishes conflict from absence, Scenario: CAS against a never-written key reports actual as undefined, Scenario: CAS conflict against an existing key reports the actual version, TemporalKV: versioned KV with history (+3 more)

### Community 110 - "ADDED Requirements"
Cohesion: 0.12
Nodes (16): ADDED Requirements, formal-checkpoint-c1, Requirement: C1 remains a save-only abstract projection, Requirement: Chunk identities form an unconditional finite join projection, Requirement: Chunk-map merge preserves existing bytes, Requirement: Collision freedom is an explicit local theorem premise, Requirement: Compatible chunk maps satisfy conditional C1 commutation, Requirement: Saving identity inputs is extensive, repeat-idempotent, and order-independent (+8 more)

### Community 111 - "Design — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)"
Cohesion: 0.17
Nodes (11): 0. Test-infrastructure layout, 1.1 Skip-enforcement mechanism — the anti-self-skip guarantee, made a named check, 3.1 Full-sync soak (`council/B` §3 item 5; `01` checklist item 3), 3. G10 — full-sync soak + load-under-concurrent-prune, 4. Boundary respected — no consumer-app import (G11/G12), 5. G11 — differential state-equivalence, rescoped in-repo (`01` item 4; `council/B` §1; `02`-T11), 6. G12 — Milestone-5 live round-trip, rescoped as manual pre-tag Preprod evidence (`01` §Cutover), 7. What this change deliberately does not verify (traceability of the non-goals) (+3 more)

### Community 112 - "NodeRpcClient"
Cohesion: 0.18
Nodes (6): NodeRpcClient, NodeRpcError, NodeRpcInvalidHeightError, NodeRpcParseError, SubstrateBlock, SubstrateHeader

### Community 113 - "postgres/chain-archive-store.ts"
Cohesion: 0.14
Nodes (15): BlobRole, BlockMeta, BlockStatus, BridgeObservationKind, ChainArchiveErrorCode, Hex32Schema, TransactionKind, TransactionResult (+7 more)

### Community 114 - "Design — v1.0.0 API Surface & Release Contract"
Cohesion: 0.20
Nodes (9): 0. Ordering constraint (why this change is Phase 2, not Phase 1), 1.2 `package.json` — make it publishable with a strict `exports`, 1.3 Packed-tarball install smoke test, 1. G1 — Public API surface, 2. G2 — SemVer stability policy + CHANGELOG, 4. G4 — The contract doc set (all *true*), 5. G20 — Freeze the Lean cut-line, 6. Non-goals / boundaries respected (restated for the implementer) (+1 more)

### Community 115 - "chain-archive-store.test.ts"
Cohesion: 0.19
Nodes (6): @testcontainers/postgresql, chainArchiveMigrations, BlockRow, bundleFixture(), makeBlock(), TxRow

### Community 116 - "postgres/checkpoint-store.ts"
Cohesion: 0.19
Nodes (15): assertValidCheckpointIds(), CheckpointRecord, CheckpointSequence, ContentHash, HistoryOptions, HistoryOptionsSchema, MAX_CHECKPOINT_ID_LENGTH, SaveCheckpointOptionsSchema (+7 more)

### Community 117 - "ChainArchiveStore"
Cohesion: 0.09
Nodes (11): `blocks`, Boundary enforcement, `bridge_observations`, chain_archive lineage, `chain_archive.watermarks`, How the two lineages coexist, Table of contents, `transactions` (chain_archive) (+3 more)

### Community 118 - "chain-archive-replay-decode.integration.test.ts"
Cohesion: 0.05
Nodes (44): decodeArchivedTransaction(), DecodedArchivedTransaction, DecodedDustRegistration, DecodedDustSpend, DecodedUnshieldedOutput, DecodedZswapInput, DecodedZswapOutput, isStandardTransaction() (+36 more)

### Community 119 - "registerSuiteLifecycle"
Cohesion: 0.13
Nodes (11): 1. Crash harness — deterministic faults, not timing races (`council/B` §3 tooling ruling), Impact, Non-goals (explicitly out of scope for this change), Proposal — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`), Why, { sql: getSql, connectionUri }, registerSuiteLifecycle(), startTestDatabase() (+3 more)

### Community 120 - "chain-archive-rollover.ts"
Cohesion: 0.23
Nodes (13): Partition rollover design, AnySql, assertDefaultSpanFitsOneBucket(), assertValidBucketBounds(), assertValidPartitionSuffix(), attachedPartitionBound(), getFkConstraintName(), quoteIdent() (+5 more)

### Community 121 - "UmbraDB v1.0.0 — Resume-From-Home Checkpoint (2026-07-23)"
Cohesion: 0.20
Nodes (9): 1. Current `main` state, 2. Preprod sync — PAUSED (safely), no progress lost, 2a. Resume on THIS machine, 2b. Resume on a FRESH machine, 3. Reproducible environment, 4. Roadmap status — G5 done, 19 to go, 5. Established implementation workflow (follow it for G6–G8), 6. Worktree cleanup (+1 more)

### Community 122 - "Tasks — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)"
Cohesion: 0.18
Nodes (10): 0. Crash harness (foundation), 1. Process-kill mid-save (G9 / 02-T1), 2. Postgres-kill mid-save + retry-duplication contract (G9 / 02-T2), 3. Crash between data and cursor — the keystone (G9 / 02-T5)  ⟵ depends on G5, 4. Lease non-wedge cold start (G9 / 02-T3), 6. Differential state-equivalence gate, rescoped in-repo (G11)  ⟵ fault-schedule half depends on G5, 7. CI gate wiring, 8. G12 — manual pre-tag Preprod evidence run  ⟵ release step 7, against the RC (+2 more)

### Community 123 - "UmbraDB"
Cohesion: 0.14
Nodes (14): CheckpointStore: content-addressed snapshots, Contents, License, Performance and ceilings, Schema and migrations, Security, Status, The five primitives (+6 more)

### Community 124 - "2.1 The boundary rule (the feature's key design decision)"
Cohesion: 0.33
Nodes (5): 1. Overview / purpose, 2.1 The boundary rule (the feature's key design decision), 2. Architecture, 5. Acceptance criteria status, Full-Chain Storage

### Community 125 - "Storage Algebra Lean M3b CheckpointStore C1 Sprint"
Cohesion: 0.22
Nodes (8): Adversarial examples, Audited semantic decisions, Compatible-map theorem gate, Explicit non-goals, Identity-projection theorem gate, Source layout, Storage Algebra Lean M3b CheckpointStore C1 Sprint, Verification matrix

### Community 126 - "Design — Sprint 6: Lean M3b CheckpointStore C1"
Cohesion: 0.29
Nodes (6): 1. Finite identity projection, 2. Finite byte-bearing maps, 3. Collision premise bridge, 4. Laws and trust boundary, 5. Refinement boundary, Design — Sprint 6: Lean M3b CheckpointStore C1

### Community 127 - "chain-archive-preprod-cloud-crossval.integration.test.ts"
Cohesion: 0.16
Nodes (5): IndexerClient, IndexerClientError, IndexerClientParseError, IndexerTransaction, MAX

### Community 128 - "Tasks — Sprint 6: Lean M3b CheckpointStore C1"
Cohesion: 0.33
Nodes (5): 0. Specification freeze, 1. Chunk-identity projection, 2. Compatible chunk maps, 3. Close-out, Tasks — Sprint 6: Lean M3b CheckpointStore C1

### Community 129 - "Scalability ceilings (v1.0.0)"
Cohesion: 0.20
Nodes (9): Environment pinning (for reproduction), Regression gating posture, SC-1 — `kv_history` unbounded growth, SC-2 — `ckpt_chunks` GC cost is O(live chunks), full anti-join per pass, SC-3 — `load()` single-buffer materialization, SC-4 — single global writer lease serializes writers, SC-5 — TransactionHistory GIN `fastupdate` p99 spikes, SC-6 — TOAST storage mode on `ckpt_chunks.data` (+1 more)

### Community 130 - "runMigrations"
Cohesion: 0.11
Nodes (32): Audit (round 1) — the confirmation-bias control paid off, Change: `v1.0.0-durable-checkpoint-cursor` — G6 / G7 / G8 (2026-07-24), Rework (class 4), Workflow friction (class 3), 1. Durability contract, 1. `fsync = on` — probe-enforced, 2. `full_page_writes = on` — probe-enforced (overridable), 4. Session-mode connection pooling only — probe-enforced (best-effort) (+24 more)

### Community 131 - "midnight-env — reproducible PREPROD dev environment"
Cohesion: 0.22
Nodes (8): 1. Reproducibility contract — what is pinned, and how, 2. Host-state assumptions the flake does NOT capture (the real impurities), 3. How to reproduce (exact steps), 4. Validation performed, 5. Impurity reduction vs. documented-as-known, midnight-env — reproducible PREPROD dev environment, Security — db-sync TLS posture (READ BEFORE ENABLING TLS), Why `nix develop -c bash scripts/start-stack.sh` and not `nix run .#start-stack`

### Community 132 - "Tasks — v1.0.0 API Surface & Release Contract"
Cohesion: 0.33
Nodes (5): 3. The freeze: build + package.json (G1), 5. Release contract docs (G2, G4), 6. Freeze the Lean cut-line (G20), 7. Packed-tarball install smoke test (G1), Tasks — v1.0.0 API Surface & Release Contract

### Community 133 - "Design — v1.0.0-perf-baseline"
Cohesion: 0.20
Nodes (10): 0. Package layout, 1. HP-1 — `save()` `UNNEST` batching (G13), 2. HP-2 + IS-2 — `history()` single `GROUP BY` over a stored `size_bytes` (G13), 3. IS-1 — `kv_current fillfactor=90` (G13), 5. G14 — the GC anti-join measurement + recorded baseline, 6. G14 — documented scalability ceilings (SC-1..SC-6), 7. Boundaries and non-goals respected, Audit resolution (+2 more)

### Community 134 - "ChunkMissingError"
Cohesion: 0.13
Nodes (18): Acceptance criteria — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`), Boundary / scope guardrails (council rulings honored), Crash between data and cursor — keystone (G9 / T5, depends on G5), Differential state-equivalence, in-repo (G11, fault-schedule half depends on G5), Full-sync soak + load-under-prune (G10), Lease non-wedge cold start (G9 / T3), Manual pre-tag Preprod evidence run (G12, release step 7, against the RC), Postgres-kill mid-save + retry contract (G9 / T2) (+10 more)

### Community 135 - "assertValidSchemaName"
Cohesion: 0.12
Nodes (19): 8. Migration, Revision history, v2 — 2026-07-22, revised in response to a 3-reviewer design-council audit (Fable 5 / Opus / GPT-5.6 Sol), v3 — 2026-07-22, revised in response to a round-2 3-reviewer design-council re-audit (Fable 5 / Opus / GPT-5.6 Sol), v4 — 2026-07-22, revised in response to a round-3 3-reviewer design-council re-audit (Opus / Fable 5 / GPT-5.6 Sol), 2.3 Partition rollover (`src/postgres/chain-archive-rollover.ts`), §2.0 — Orchestrator (the role that can break independence by mistake), §2.1 — Implementation agent (+11 more)

### Community 136 - "UmbraDB 1.0.0 Release Contracts"
Cohesion: 0.33
Nodes (6): 3. Cancellation semantics, 5. Lease limitation, 6. Backup/restore guidance, 7. Threat-model pointer, 8. Format headroom (reserved for 1.1), UmbraDB 1.0.0 Release Contracts

### Community 137 - "chain-archive-sync-retry.integration.test.ts"
Cohesion: 0.18
Nodes (11): bootstrapChainArchiveSchema(), MAX_BLOCKS, service, sql, BlockBundle, fakeChain(), FakeChainBlock, fakeIndexerFetch() (+3 more)

### Community 138 - "Design — v1.0.0-infosec-signoff"
Cohesion: 0.20
Nodes (9): 0. Scope boundary and what this change does NOT touch, 1. G15 — `SECURITY.md` / threat-model document, 2. G16 — CheckpointStore cross-wallet dedup interface-doc rewrite, 3. G17 — TLS caveat surfaced + VerifyFull/`--ca` de-stubbed, 4. G18 — Supply-chain CI gate, 5. G19 — Replace the committed Preview wallet secret, 6. Non-goals & boundaries respected (summary), Audit resolution (+1 more)

### Community 139 - "Roadmap"
Cohesion: 0.12
Nodes (16): 1.0.0 acceptance checklist, Beyond 1.0.0 — additional tracks in progress, Frozen 1.0.0 API surface, SemVer policy, error catalog & contracts (G1-G4 -- `openspec/changes/v1.0.0-api-surface`), Frozen 1.0.0 Lean cut-line (G20 — `openspec/changes/v1.0.0-api-surface`), Midnight Express recovery — proposed future-release track, Milestone 0 — Design (completed baseline), Milestone 1 — Formal (`Formal/`, in progress), Milestone 3 — Testing (complete for 1.0.0) (+8 more)

### Community 140 - "Feasibility: TLS for the Cardano db-sync database (Midnight partner-chain follower)"
Cohesion: 0.22
Nodes (8): 1. Driver — why this is now mandatory, 2. What the Cardano side does (and does not) provide, 3. Feasibility — demonstrated, 4. Security postures, 5. Folding into `nix/midnight-env`, 6. Risks / open items, 7. Verdict, Feasibility: TLS for the Cardano db-sync database (Midnight partner-chain follower)

### Community 141 - "Tasks — v1.0.0: Formal completion (`formal-completion`)"
Cohesion: 0.15
Nodes (12): 0. Scaffolding + Trust reach, 1. C2a — GC-safety (release-blocking; start now), 2. C2b — eventual collection (DEFERRED), 3. L1 — lease mutual exclusion (release-blocking; start now), 4. Multi-key TemporalKV lift — FRAMING ONLY (DEFERRED), 5. Ordered chunk reconstruction (DEFERRED), 6. C1 collision hygiene (release-blocking rider), 7. Transaction-envelope composition (DEFERRED) (+4 more)

### Community 142 - "full-sync-soak.integration.test.ts"
Cohesion: 0.09
Nodes (11): { connectionUri }, DECLARED_ENVELOPE, GcPass, HistGroup, kvMapKey(), LIVE_ENVELOPE, newPool(), openPools (+3 more)

### Community 143 - "StorageError"
Cohesion: 0.08
Nodes (32): Boundary held, Change: `v1.0.0-api-surface` — G1/G2/G3/G4/G20 the public-surface freeze (2026-07-24), The cross-vendor audit (two codex cold rounds, then bounded at convergence), The count is enforced, not asserted, Errors, Requirement: driver-level failures surface as the shared StorageError hierarchy, Scenario: A connection failure during any method surfaces as ConnectionError, Acceptance — v1.0.0 API Surface & Release Contract (+24 more)

### Community 144 - "UmbraDB v0.9.5 "Penumbra" — Release Record"
Cohesion: 0.17
Nodes (10): 2. Tag preconditions R1–R12, 3. Rulings recorded for this release, 4. Deferred to 1.1 / post-1.0.0, 5. R5 — live Preprod evidence against the RC, 6. R6 — independent cold release audit, 7. R9 — Go / No-Go, UmbraDB v0.9.5 "Penumbra" — Release Record, UmbraDB v1.0.0 — Release Record (PENDING) (+2 more)

### Community 145 - "differential-equivalence.test.ts"
Cohesion: 0.14
Nodes (24): adaptersFor(), applyBatchUnderFault(), buildSchedule(), completeManifestCount(), driveFullBatch(), Fault, injectT1(), injectT2() (+16 more)

### Community 146 - "ROADMAP.md"
Cohesion: 0.31
Nodes (4): Midnight Express backend recovery — future release, Proposed MPE recovery requirements, Future implementation tasks, Custom Node/TypeScript Benchmark Harness

### Community 147 - "check-required-tests.ts"
Cohesion: 0.13
Nodes (22): cli(), DEFAULT_MANIFEST, EXPECTED_DEFERRED_COUNT, EXPECTED_REQUIRED_COUNT, extractIds(), fileMatches(), filesFromReport(), JsonReport (+14 more)

### Community 148 - "stryker.conf.json"
Cohesion: 0.11
Nodes (17): cleanTempDir, _comment, concurrency, coverageAnalysis, mutate, reporters, $schema, tempDirName (+9 more)

### Community 149 - "setup.ts"
Cohesion: 0.09
Nodes (25): class2AdvisoryLockCountForHash(), liveWorkers, manifestCount(), openPools, pool(), { sql: getSql, connectionUri }, watermarkCount(), backendPid() (+17 more)

### Community 150 - "Acceptance criteria — v1.0.0-infosec-signoff"
Cohesion: 0.25
Nodes (7): Acceptance criteria — v1.0.0-infosec-signoff, Cross-cutting council-ruling gates (close-out — Task 5.1), G15 — Threat-model / `SECURITY.md`, G16 — CheckpointStore dedup interface-doc caveat, G17 — TLS caveat surfaced + VerifyFull de-stubbed, localhost default kept, G18 — Supply-chain CI gate, G19 — Committed-secret remediation

### Community 151 - "Tasks — v1.0.0-infosec-signoff"
Cohesion: 0.22
Nodes (8): 0. Threat-model documentation hub (G15), 1. CheckpointStore interface-doc rewrite (G16) — depends on 0.3, 2. TLS caveat + VerifyFull de-stub (G17) — independent, 3. Supply-chain CI gate (G18) — 3.5 depends on 4.1, 4. Committed-secret remediation (G19) — mutually dependent with 3.5, 4b. Release-publication artifact (R7) — found missing during the release run, 5. Change close-out, Tasks — v1.0.0-infosec-signoff

### Community 152 - "interfaces/temporal-kv.ts"
Cohesion: 0.08
Nodes (34): CheckpointIdSchema, AssertExact, exceedsMaxDepth(), ExpectedVersionSchema, hasPostgresUnsafeText(), jsonValueHasUnsafeText(), JsonValueInnerSchema, JsonValueSchema (+26 more)

### Community 153 - "UmbraDB V1.0.0 Implementation Guideline — the release constitution"
Cohesion: 0.20
Nodes (9): §0 — Purpose & authority, §1 — The high-assurance spec→code workflow, §3 — Cross-cutting gates (apply to every gate item and every agent), §4.1 — Closing one roadmap gate item (G-N), §4.2 — The 1.0.0 tag gate, §4 — Gate-item close criteria & the 1.0.0 tag gate, §5 — Post-release lessons-learned protocol, Audit resolution (+1 more)

### Community 154 - "UmbraDBConnectionOptions"
Cohesion: 0.13
Nodes (15): Acceptance — v1.0.0-durable-checkpoint-cursor, G5 — Co-transactional watermark + checkpoint data, G6 — Durability startup probe + binding contract, G7 — Server-side timeouts, Whole-change gates (non-goal compliance + sequencing), Requirement: the UmbraDB connection sets bounded server-side timeouts by default, Scenario: a caller can override each timeout default, Scenario: a raised idle-in-transaction default is honoured for a long in-transaction workload (+7 more)

### Community 155 - "Design — v1.1.0: Quint model checking"
Cohesion: 0.17
Nodes (11): 1. Module layout, 2. Backend routing (the one non-obvious constraint), 3. C2a model sketch, 4. C2b model sketch, 5. L1 model sketch, 6. Falsifiability controls, 6b. Witnesses — proving the interesting state is reachable, 7. Bounds (+3 more)

### Community 156 - "Proposal — v1.0.0-perf-baseline"
Cohesion: 0.29
Nodes (6): 1.0.0 gate items addressed, Impact, Non-goals (explicitly out of scope for this change), Proposal — v1.0.0-perf-baseline, What changes, Why

### Community 157 - "cold-boot-recovery.integration.test.ts"
Cohesion: 0.22
Nodes (16): effect, phaseA_syncAndPersistEnvelope(), deriveUnshieldedSeed(), buildUnshieldedConfig(), EXPECTED_NIGHT_VALUE, EXPECTED_UNSHIELDED_ADDRESS, FAUCET_IDENTIFIER_PREFIX, FAUCET_TX_HASH_PREFIX (+8 more)

### Community 158 - "pg-kill-save.crash.test.ts"
Cohesion: 0.12
Nodes (18): assertSaveNotAutoRetriedUnderRetriableFault(), assertSaveNotInAnyAutoRetryAllowlist(), C5AnyFn, completeManifestCount(), completeManifestCountAtSeq(), danglingChunkCount(), IDEMPOTENCY_KEY_FEATURE, listSrcTsFiles() (+10 more)

### Community 159 - "withSuiteWatchdog"
Cohesion: 0.14
Nodes (19): completeManifestCount(), completeManifestCountAtSeq(), danglingChunkCount(), junctionRowCount(), liveWorkers, manifestRowCountAtSeq(), openPools, orphanJunctionCount() (+11 more)

### Community 160 - "temporal-kv.test.ts"
Cohesion: 0.29
Nodes (4): FAKE_TX, kv(), { sql: getSql }, txLayer()

### Community 161 - "crash-worker.ts"
Cohesion: 0.20
Nodes (14): ALL_HOOKS, CoTxCallable, CoTxPauseInfo, CrashHook, describeCaughtError(), main(), observeClientPauseBeforeCursor(), pauseThenResume() (+6 more)

### Community 162 - "mutation-per-adapter.mjs"
Cohesion: 0.17
Nodes (11): gateAdapters(), tallyMutants(), adapters, conf, gate, JSON_REPORT, PER_ADAPTER_CONF, results (+3 more)

### Community 163 - "load-under-prune.integration.test.ts"
Cohesion: 0.15
Nodes (12): backdatePastGraceWindow(), Callable, { connectionUri }, Deferred, LoadInterleaveObserver, newClient(), openPools, runUnSnapshottedReadUnderPrune() (+4 more)

### Community 164 - "Proposal — v1.0.0 API Surface & Release Contract"
Cohesion: 0.40
Nodes (4): Impact, Non-goals (explicitly out of scope — honoring the council rulings verbatim), Proposal — v1.0.0 API Surface & Release Contract, Why

### Community 165 - "UmbraDB 0.9.5 "Penumbra""
Cohesion: 0.20
Nodes (9): Benchmarks, Compatibility, and what 1.0.0 needs, If you build from source, Installing, Security, The fix this release exists for, UmbraDB 0.9.5 "Penumbra", What is proved, and what that is worth (+1 more)

### Community 166 - "decode"
Cohesion: 0.21
Nodes (12): Requirement: a corrupt or non-JSON envelope payload is rejected with a typed error, Requirement: an unrecognized envelopeVersion is rejected, never best-effort restored, Scenario: A future-versioned envelope is rejected cleanly, Scenario: An unknown top-level field is rejected as a typed envelope error (F7), Scenario: Non-JSON bytes are rejected as a typed envelope error, Scenario: Structurally invalid JSON is rejected as a typed envelope error, Impact, Non-goals (explicitly out of scope — per the council rulings) (+4 more)

### Community 167 - "Tasks — v1.0.0-perf-baseline"
Cohesion: 0.29
Nodes (6): 1. G13 — perf-correctness fixes (LAND FIRST), 2. G14 — benchmark harness (may start in parallel; baseline recorded only after §1), 3. G14 — record the baseline + document ceilings, 4. Close-out, G14 build close-out (2026-07-23), Tasks — v1.0.0-perf-baseline

### Community 168 - "Spec — `model-checking` capability"
Cohesion: 0.20
Nodes (9): 1. Scope and honesty, 2. Faithfulness to the algebra, 3. C2a — GC reachability safety, 4. C2b — eventual collection (liveness), 5. L1 — lease mutual exclusion, 6. T1 cross-writer, 7. CI integration, 8. Documentation (+1 more)

### Community 169 - "UmbraDB V1.0.0 — Lessons-Learned Living Log"
Cohesion: 0.12
Nodes (16): A. Preventative actions to land or re-defer before iteration 2 begins, B. Named consumption targets (guideline §5.5) — record the actual edit made, C. Trend analysis (across events, not per-incident), Capture rules, D. Retro review sign-off, Entry template (copy per event), Event log (append-only; newest at bottom), Iteration-2 intake (+8 more)

### Community 170 - "Proposal — v1.1.0: Quint model checking (`quint-model-checking`)"
Cohesion: 0.22
Nodes (8): Binding constraints, Dependencies, Proposal — v1.1.0: Quint model checking (`quint-model-checking`), Tooling, What changes, What this does NOT claim, Why Quint specifically, Why: three laws are unproved, and it is not a coincidence which three

### Community 171 - "lease-nonwedge.crash.test.ts"
Cohesion: 0.18
Nodes (13): worker(), class2AdvisoryLockCountForHash(), liveWorkers, openPools, pollForLockGone(), pool(), sleep(), { sql: getSql, connectionUri } (+5 more)

### Community 172 - "scripts"
Cohesion: 0.13
Nodes (15): scripts, archive:sync, bench, bench:smoke, build, docs:storage, docs:storage:check, test (+7 more)

### Community 173 - "Tasks — v1.1.0: Quint model checking"
Cohesion: 0.22
Nodes (8): 0. Toolchain and scaffolding, 1. C2a — GC reachability safety, 2. C2b — eventual collection, 3. L1 — lease mutual exclusion, 4. T1 — cross-writer, 5. CI, 6. Documentation and close-out, Tasks — v1.1.0: Quint model checking

### Community 174 - ".save"
Cohesion: 0.10
Nodes (21): 4.1 Validate `walletId`/`networkId` at all four entry points, Requirement: save accepts and joins a caller-supplied transaction handle, Scenario: A checkpoint saved on a caller transaction commits with it, Scenario: A checkpoint saved on a caller transaction that rolls back leaves no trace, Scenario: A stale or fabricated transaction handle is rejected before any statement, Scenario: save on a caller transaction behaves identically to the internal-transaction path for a reader, 0. G5 — Co-transactional watermark + checkpoint data (do first; pre-freeze, signature-changing), Acceptance criteria — v1.0.0-perf-baseline (+13 more)

### Community 175 - "checkpoint-id-validation.test.ts"
Cohesion: 0.25
Nodes (6): PruneResult, invoke(), Method, METHODS, OVERLONG_ID, { sql: getSql }

### Community 176 - "G12 / R5 — manual pre-tag Preprod round-trip evidence"
Cohesion: 0.25
Nodes (7): Captured transcript, Chain / wallet state at run time, Cold-boot round-trip, G12 / R5 — manual pre-tag Preprod round-trip evidence, Pass/fail per M5 sub-criterion, Run identity, Verdict

### Community 177 - "README.md"
Cohesion: 0.30
Nodes (4): Scope and pre-1.0 note, The three commitments, UmbraDB Stability Policy (SemVer), OpenSpec Change

### Community 178 - "facade-merge-loader.ts"
Cohesion: 0.36
Nodes (8): facadeDistIndexPath(), facadeMergeAvailable(), loadFacadeMerge(), unshieldedWalletDistIndexPath(), ledgerV8NodeEntry(), loadMidnightWalletSdk(), midnightWalletRepoRoot(), packageDistFile()

### Community 180 - "Roadmap for the missing formalization"
Cohesion: 0.25
Nodes (7): Phase F1 — Close the absent *abstract* laws (tractable now; highest value), Phase F2 — Cross-module composition laws, Phase F3 — The refinement gap (strategic; the big decision), Priority call, Roadmap for the missing formalization, UmbraDB storage-algebra — formalization gap map & roadmap, What we have vs. the spec

### Community 181 - "vitest"
Cohesion: 0.07
Nodes (16): vitest, check, checker, env, forwarded, repoRoot, reportPath, vitest (+8 more)

### Community 183 - "watermarks.test.ts"
Cohesion: 0.25
Nodes (4): FAKE_TX, { sql: getSql, connectionUri }, store(), txLayer()

### Community 184 - "barrel-resolves.test.ts"
Cohesion: 0.08
Nodes (29): `CLOCK_REGRESSION` is conditional, not uniformly non-retryable, The catalog, The retryable set, UmbraDB Frozen Error-Code Catalog, G8 — Contract-integrity fixes, Requirement: A second write to the same key within one transaction is rejected at the trigger level, not silently absorbed, Scenario: A second UPDATE to the same key's row in one transaction is rejected at the trigger level, Scenario: Sequential puts to the same key in separate transactions succeed, outside the millisecond-collision caveat (+21 more)

### Community 185 - "ASSESSMENT — `midnight-node-archive` Peer Flapping (Midnight Preprod, WSL2 Docker Host)"
Cohesion: 0.29
Nodes (6): 1. Executive verdict, 2. Ranked root causes, evidence, and council challenges resolved, 3. THE recommended action, 4. Decisive validation experiment, 5. Residual risk and confidence, ASSESSMENT — `midnight-node-archive` Peer Flapping (Midnight Preprod, WSL2 Docker Host)

### Community 186 - "package.json"
Cohesion: 0.11
Nodes (18): description, exports, files, homepage, license, main, name, type (+10 more)

### Community 187 - "mutation-evidence.d.mts"
Cohesion: 0.29
Nodes (6): AdapterResult, GateResult, MutantTally, StrykerFile, StrykerMutant, StrykerReport

### Community 188 - "Research Assessment: Single-Statement Unbounded `bytea` Inserts via postgres.js"
Cohesion: 0.33
Nodes (5): 1. Is there a known resolution — bounded-constant statement count, unbounded rows, no bind-param cap, no V8 string limit?, 2. Best candidate — COPY-BINARY into temp + INSERT-SELECT-ON-CONFLICT, 3. Recommendation for UmbraDB, 4. Migration/rollout note (if/when adopted), Research Assessment: Single-Statement Unbounded `bytea` Inserts via postgres.js

### Community 189 - "[0.9.5] - 2026-07-25 — "Penumbra""
Cohesion: 0.33
Nodes (6): [0.9.5] - 2026-07-25 — "Penumbra", [1.0.0] - unreleased — "Totality", Changelog, Contract documents, Deferred to a 1.1 fast-follow (explicitly outside the frozen 1.0 surface), [Unreleased]

### Community 194 - "Test wallets"
Cohesion: 0.50
Nodes (3): Generate your local wallet, Test wallets, Why this is not just a committed key anymore

### Community 195 - "dependencies"
Cohesion: 0.67
Nodes (3): dependencies, postgres, zod

### Community 196 - "PgTransactionLeaseLayer"
Cohesion: 0.09
Nodes (40): loadBaseline(), main(), 1.2 Change `save` to accept a caller transaction, 4. G14 — benchmark harness, Requirement: an in-repo benchmark harness drives the real adapters against a pinned Postgres, Scenario: Each harness run reports warmup-aware statistics including CV, Scenario: The harness runs against real Postgres via the real adapters, 6.2 — fault-schedule differential (`test/postgres/differential-equivalence.test.ts`) (+32 more)

### Community 197 - "MPE recovery composition"
Cohesion: 0.29
Nodes (7): 1. Existing foundation and reconciliation, 2. Selected deployment and ownership, 3. Proposed atomic operation, 4. Strict durability and writer ownership, 5. Private state, restore and retention, 6. Validation and release boundary, MPE recovery composition

### Community 198 - "Acceptance — v1.0.0: Formal completion (`formal-completion`)"
Cohesion: 0.29
Nodes (6): Acceptance — v1.0.0: Formal completion (`formal-completion`), Change-level exit (Option B) / checklist-close (Option A), Definition-of-done for a gate to CLOSE, Non-goals, Normative release-law manifest (single source of truth), The forced decision (must be recorded before this change closes)

### Community 199 - "migrate.ts"
Cohesion: 0.08
Nodes (17): 5. Migration lineage, schema placement — Tier-1.5 (audit item 5), 2. Forward-only / no-downgrade migration contract, postgres, isLockTimeout(), DEFAULT_MIGRATION_LOCK_TIMEOUT_MS, Migration, MigrationLockTimeoutError, runMigrationsImpl() (+9 more)

### Community 200 - "Requirement: JsonValueSchema rejects values exceeding the maximum nesting depth"
Cohesion: 0.33
Nodes (5): 3. Replay convergence is judged on CURRENT state, Requirement: JsonValueSchema rejects values exceeding the maximum nesting depth, Scenario: a value at or under the bound is accepted, Scenario: an over-deep value passed to put is rejected before any statement, Scenario: an over-deep value passed to set is rejected identically

### Community 201 - "Proposal — v1.0.0: Formal completion (`formal-completion`)"
Cohesion: 0.29
Nodes (6): Binding constraints, Dependencies & critical path, Governance framing (read first), Proposal — v1.0.0: Formal completion (`formal-completion`), What changes, Why

### Community 202 - "1. The twenty gate items"
Cohesion: 0.33
Nodes (6): 1. The twenty gate items, Track A — Release contract (`openspec/changes/v1.0.0-api-surface`, merged `726f567`), Track B — Durable composition (`openspec/changes/v1.0.0-durable-checkpoint-cursor`, merged `e5fcdaa`, `2cb5d00`), Track C — Recovery testing (`openspec/changes/v1.0.0-recovery-testing`, merged `4e04926`), Track D — Performance baseline (`openspec/changes/v1.0.0-perf-baseline`, merged `855fb22`), Track E — Security posture (`openspec/changes/v1.0.0-infosec-signoff`, merged `7ee8a4b`)

### Community 203 - "Acceptance — v1.1.0: Quint model checking"
Cohesion: 0.33
Nodes (5): Acceptance — v1.1.0: Quint model checking, Definition of done, Explicit non-goals, Status manifest — what this change may and may not claim, The honesty bar

### Community 204 - "Audit record — `v1.1.0-formal-completion` roadmap (v1 → v2)"
Cohesion: 0.40
Nodes (4): Affirmed (audit found sound), Audit record — `v1.1.0-formal-completion` roadmap (v1 → v2), Convergent findings (≥2 lanes) and v2 resolution, Verdicts

### Community 205 - "client.ts"
Cohesion: 0.07
Nodes (52): BENCH_SCHEMA, BenchEnv, PG_SETTINGS, POSTGRES_IMAGE, startBenchEnv(), fmtRatio(), main(), parseNums() (+44 more)

### Community 206 - "Midnight Express recovery profile — future release"
Cohesion: 0.40
Nodes (5): Dependencies, Explicit non-goals, Midnight Express recovery profile — future release, Proposed change, Why

### Community 207 - "7. Testing strategy (post-implementation)"
Cohesion: 0.50
Nodes (4): 7.2 Live preprod DB-sync (nightly/labeled) — `test:live`, 7.3 Cold-boot recovery (nightly/labeled) — `test:live`, 7.4 Required-gate vs nightly split (binding), 7. Testing strategy (post-implementation)

### Community 208 - "Spec — capability `formal-completion`"
Cohesion: 0.50
Nodes (3): Governed by, Requirements (EARS), Spec — capability `formal-completion`

### Community 209 - "repository"
Cohesion: 0.67
Nodes (3): repository, type, url

## Knowledge Gaps
- **1030 isolated node(s):** `BaselineLoad`, `TinybenchOpts`, `ManualOpts`, `EnvironmentBlock`, `ENVELOPE_MIN_CHUNKS` (+1025 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 1287 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **61 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `runMigrations()` connect `runMigrations` to `ADDED Requirements`, `Tasks — v1.0.0 API Surface & Release Contract`, `assertValidSchemaName`, `chain-archive-sync-retry.integration.test.ts`, `StorageError`, `setup.ts`, `UmbraDB V1.0.0 Implementation Guideline — the release constitution`, `UmbraDBConnectionOptions`, `Tasks — v1.0.0-perf-baseline`, `.save`, `README.md`, `barrel-resolves.test.ts`, `CheckpointStore`, `migrate.ts`, `1. The twenty gate items`, `0. Preconditions (blocking gate — verify before any freeze work)`, `client.ts`, `saveAndAdvance`, `ValidationError`, `translatePostgresError`, `What changes — the 1.0.0 gate items this change addresses`, `src/index.ts`, `cursor-durability.crash.test.ts`, `Full-Chain Storage — Design`, `Design — v1.0.0-durable-checkpoint-cursor`, `resolveTransaction`, `VersionConflictError`, `chain-archive-store.test.ts`, `ChainArchiveStore`, `registerSuiteLifecycle`, `chain-archive-rollover.ts`, `UmbraDB`?**
  _High betweenness centrality (0.056) - this node is a cross-community bridge._
- **Why does `vitest` connect `vitest` to `postgres/transaction-lease.ts`, `chain-archive-sync-retry.integration.test.ts`, `full-sync-soak.integration.test.ts`, `differential-equivalence.test.ts`, `check-required-tests.ts`, `setup.ts`, `interfaces/temporal-kv.ts`, `cold-boot-recovery.integration.test.ts`, `pg-kill-save.crash.test.ts`, `withSuiteWatchdog`, `temporal-kv.test.ts`, `mutation-per-adapter.mjs`, `load-under-prune.integration.test.ts`, `lease-nonwedge.crash.test.ts`, `checkpoint-id-validation.test.ts`, `facade-merge-loader.ts`, `watermarks.test.ts`, `barrel-resolves.test.ts`, `package.json`, `PgTransactionLeaseLayer`, `pg-tx-history-adapter.ts`, `migrate.ts`, `transaction-history-storage.test.ts`, `0. Preconditions (blocking gate — verify before any freeze work)`, `client.ts`, `ValidationError`, `transaction-history-storage.property.test.ts`, `What changes — the 1.0.0 gate items this change addresses`, `src/index.ts`, `cursor-durability.crash.test.ts`, `TransactionHandle`, `resolveTransaction`, `NodeRpcClient`, `chain-archive-store.test.ts`, `chain-archive-replay-decode.integration.test.ts`, `registerSuiteLifecycle`, `chain-archive-preprod-cloud-crossval.integration.test.ts`?**
  _High betweenness centrality (0.052) - this node is a cross-community bridge._
- **Why does `CheckpointStore` connect `CheckpointStore` to `UmbraDB 1.0.0 Release Contracts`, `Design — v1.0.0-infosec-signoff`, `Roadmap`, `Tasks — v1.0.0-infosec-signoff`, `Proposal — v1.0.0-perf-baseline`, `UmbraDB 0.9.5 "Penumbra"`, `decode`, `.getAll`, `PgTransactionLeaseLayer`, `ADDED Requirements`, `ValidationError`, `.save`, `ADDED Requirements`, `PgTransactionHistoryStorage`, `src/index.ts`, `Full-Chain Storage — Design`, `resolveTransaction`, `Design — v1.0.0 API Surface & Release Contract`, `postgres/checkpoint-store.ts`?**
  _High betweenness centrality (0.049) - this node is a cross-community bridge._
- **Are the 11 inferred relationships involving `PgTransactionLeaseLayer` (e.g. with `Boundary held` and `Added`) actually correct?**
  _`PgTransactionLeaseLayer` has 11 INFERRED edges - model-reasoned connections that need verification._
- **Are the 59 inferred relationships involving `runMigrations()` (e.g. with `Audit (round 1) — the confirmation-bias control paid off` and `Reconciliations recorded as consolidating-lead decisions (spec written pre-G6/G7)`) actually correct?**
  _`runMigrations()` has 59 INFERRED edges - model-reasoned connections that need verification._
- **Are the 17 inferred relationships involving `PgCheckpointStore` (e.g. with `Added` and `0. Ordering constraint (why this change is Phase 2, not Phase 1)`) actually correct?**
  _`PgCheckpointStore` has 17 INFERRED edges - model-reasoned connections that need verification._
- **Are the 16 inferred relationships involving `translatePostgresError()` (e.g. with `Boundary held` and `Excluded: the deferred chain-archive codes`) actually correct?**
  _`translatePostgresError()` has 16 INFERRED edges - model-reasoned connections that need verification._