# Graph Report - /root/umbradb-sqlite-research/corpus  (2026-07-31)

## Corpus Check
- 12 files · ~86,541 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 475 nodes · 687 edges · 34 communities (16 shown, 18 thin omitted)
- Extraction: 81% EXTRACTED · 14% INFERRED · 5% AMBIGUOUS · INFERRED: 94 edges (avg confidence: 0.84)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Cryptocurrency Storage Precedent
- Driver Shim, Types and Worker Boundary
- Lease, Cancellation and Release Gates
- Postgres Features and Formal Laws
- Frozen Surface, SemVer and Driver Pinning
- DDL and Forward-Only Migration Limits
- T5 Enforcement and Busy Semantics
- Type Parity and Query Constructs
- Measurement Validity and Tag Sequencing
- Error Catalog, Clock and Gates
- The Break Ledger and SemVer Ruling
- Driver Decoding and Collation Hazards
- Schema Emulation and File Layout
- Backup, Restore and Blob I/O
- Red Team: Broken Claims and Survivors
- postgres.js Idiom and Shim Port
- Chain Archive Struck From Scope
- JSONB Document Storage
- Sprint Trap: Dependency Install
- Sprint Trap: WSL Path Resolution
- Ruling: Additive-Only Union Widening
- Ruling: CONTRACT Retry Clause
- Ruling: EVIDENCE.md Is Sunk Cost
- Ruling: Required-Tests Manifest Interlock
- Ruling: locking_mode=EXCLUSIVE Closed
- Gap: Out-of-Cache Behaviour Unmeasured
- Loss: idle_in_transaction Backstop
- Loss: External Observability
- Regression: JSON Write-Time Validation
- Survived Attack: Key-Reuse Forgery
- Finding: Out-of-Cache Onset at 2.4 GB
- Finding: synchronous Dominates Throughput
- Gap: Windows Behaviour Unowned
- Cost: Worker Lengthens Write Lock

## God Nodes (most connected - your core abstractions)
1. `L7 Lane Report: SQLite Prior Art in Cryptocurrency Clients` - 15 edges
2. `kv_event event-log schema` - 14 edges
3. `Bitcoin Core descriptor wallets` - 14 edges
4. `LND` - 14 edges
5. `SQLite` - 13 edges
6. `Law T5 (interval non-overlap and gap-freedom)` - 11 edges
7. `Core Lightning` - 11 edges
8. `Random-hash-key B-tree write amplification` - 11 edges
9. `Per-key sidecar SQLite lock file lease` - 10 edges
10. `Dedicated writer worker thread topology` - 10 edges

## Surprising Connections (you probably didn't know these)
- `octet_length() Preferred Over length()` --semantically_similar_to--> `GENERATED ALWAYS AS (length(data)) STORED at CREATE TABLE`  [AMBIGUOUS] [semantically similar]
  l4-typesystem.md → l5-archive.md
- `json_each Single-Parameter Bulk Insert` --semantically_similar_to--> `json_each Bulk Insert Hex Round-Trip Penalty`  [AMBIGUOUS] [semantically similar]
  l4-typesystem.md → l5-archive.md
- `In-process write queue` --semantically_similar_to--> `Dedicated writer worker thread topology`  [INFERRED] [semantically similar]
  l2-concurrency.md → l3-driver.md
- `Throwing UDF as a cooperative interrupt` --semantically_similar_to--> `umbradb_guard() deadline/cancel UDF`  [INFERRED] [semantically similar]
  l2-concurrency.md → l3-driver.md
- `ALTER TABLE ADD COLUMN GENERATED STORED Blocker (B1)` --semantically_similar_to--> `ADD COLUMN GENERATED STORED Fails Only on Non-Empty Tables`  [AMBIGUOUS] [semantically similar]
  l4-typesystem.md → l6-contracts.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **The five UmbraDB storage primitives plus its two derived capabilities** — 00_brief_temporalkv, 00_brief_checkpointstore, 00_brief_watermarks, 00_brief_transaction_lease, 00_brief_transactionhistory, 00_brief_walletstateenvelope, 00_brief_save_and_advance [EXTRACTED 1.00]
- **The frozen 1.0.0 commitment set (formal laws + release gates)** — 00_brief_t3, 00_brief_t5, 00_brief_w1, 00_brief_c1, 00_brief_c2a, 00_brief_l1, 00_brief_g1, 00_brief_g2, 00_brief_g3, 00_brief_g4, l2_concurrency_g5_co_transactionality, l2_concurrency_g7_timeouts [EXTRACTED 1.00]
- **The sidecar-lock-file lease mechanism (SQLite replacement for pg_advisory_lock)** — l2_concurrency_sidecar_lock_file_lease, l2_concurrency_begin_immediate, l2_concurrency_busy_timeout, l2_concurrency_poll_loop_lease_acquire, l2_concurrency_sigkill_crash_release, l2_concurrency_startup_advisory_lock_probe, 00_brief_pg_advisory_lock, 00_brief_l1 [EXTRACTED 1.00]
- **Emulating Postgres Schemas Without CREATE SCHEMA** — l4_typesystem_table_name_prefixing, l4_typesystem_default_schema, l4_typesystem_global_index_and_trigger_names, l4_typesystem_attach_per_schema_option, l4_typesystem_max_attached, l6_contracts_default_schema, l5_archive_one_database_file [EXTRACTED 1.00]
- **SQLite Backup/Restore Mechanism Trade-Off** — l5_archive_vacuum_into, l5_archive_backup_api, l6_contracts_vacuum_into, l6_contracts_backup_api, l6_contracts_wal_sidecar_hazard, l6_contracts_wal_checkpoint_blocked_by_snapshot, l5_archive_g4_backup_restore, l6_contracts_integrity_check [INFERRED 0.85]
- **The Pre-1.0.0 Tag Window as the Sprint's Sequencing Lever** — l4_typesystem_stability_md_semver_not_in_force, l6_contracts_stability_md_semver_not_in_force, l4_typesystem_alter_table_add_stored_generated_column, l6_contracts_error_catalog, l6_contracts_unrecognized_postgres_error, l6_contracts_engines_node_floor, l4_typesystem_listkeys_resume_cursor_hazard [EXTRACTED 1.00]
- **Enumerated T5 enforcement mechanisms on SQLite** — l1_temporal_law_t5, l1_temporal_exclude_using_gist, l1_temporal_trigger_overlap_check, l1_temporal_partial_unique_index, l1_temporal_event_log_schema [EXTRACTED 1.00]
- **LND's four-layer SQLite contention stack** — l7_precedent_txlock_immediate, l7_precedent_busy_timeout, l7_precedent_retry_classifier, l7_precedent_connection_pool_cap_two, l7_precedent_sqlite_busy_taxonomy_gap [EXTRACTED 1.00]
- **Independent corroborations of the random-key write ceiling** — l7_precedent_random_hash_key_write_amplification, l7_precedent_erigon, l7_precedent_jellyfish_merkle_tree, l7_precedent_sui, l7_precedent_solana, l7_precedent_midnight_indexer [EXTRACTED 1.00]
- **Findings Invalidated by the /tmp tmpfs RAM-Disk Measurement Error** — council_contradiction_tmpfs_ram_disk_ruling, council_redteam_tmpfs_blast_radius, l5_archive_page_size, l5_archive_cache_size_trap [EXTRACTED 1.00]
- **The Four Adjudicating Council Seats** — council_contradiction_seat, council_commitments_seat, council_feasibility_seat, council_redteam_seat [EXTRACTED 1.00]
- **Cross-Seat Consensus: The 0.9.5 Pre-Tag Window Makes the Surface Breaks Free** — council_commitments_stability_md_46_not_in_force, council_feasibility_go_ruling, council_redteam_local_sync_as_experiment, council_contradiction_register, l6_contracts_stability_md_semver_not_in_force [INFERRED 0.95]

## Communities (34 total, 18 thin omitted)

### Community 0 - "Cryptocurrency Storage Precedent"
Cohesion: 0.06
Nodes (55): P1-P10 conformance suite, STRICT, WITHOUT ROWID tables, Aptos, BDK (bdk_chain), bitcoin-abe, Bitcoin Verde, SQLITE_MAX_VARIABLE_NUMBER = 32766, BYTEA columns copy-pasted into the SQLite lineage (+47 more)

### Community 1 - "Driver Shim, Types and Worker Boundary"
Cohesion: 0.06
Nodes (46): The Lean Is Immune Because It Models a Derivation, The Origin-Keyed Decoder Hole on Derived View Columns, Ruling C10: The Adapter-Thrown Error Poisoning Gap, Ruling C3/C4: STRICT Plus Date-to-Epoch-ms normalize(), The Worker Converts TRANSACTION_KEY_REUSE Into a Process-Boundary Guard, The Lean Model Is Sound; With Respect to This Migration the Gate Is Theatre, Adapter-side per-transaction write-set guard, btree_gist extension (+38 more)

### Community 2 - "Lease, Cancellation and Release Gates"
Cohesion: 0.06
Nodes (42): C2a — GC reachability-safety, G4 — eight written release contracts, L1 — lease mutual exclusion, node:sqlite built into Node v24.18.0, P1–P10 conformance suite, pg_advisory_lock session-scoped lease, Query.prototype.cancel() protocol-level cancellation, Full PostgreSQL to SQLite replacement question (+34 more)

### Community 3 - "Postgres Features and Formal Laws"
Cohesion: 0.07
Nodes (35): btree_gist EXCLUDE constraint on validity, C1 — CheckpointStore save-side chunk projection (join-semilattice), Chain archive, CheckpointStore primitive, clock_timestamp() temporal boundaries, Formal cut-line {T3, T5, W1, C1}, GIN index with <@ containment on text[], Trap: a green gate certifies depth, never breadth (+27 more)

### Community 4 - "Frozen Surface, SemVer and Driver Pinning"
Cohesion: 0.09
Nodes (31): Trap: beware the confident negative, CREATE SCHEMA + search_path isolation, G1 — frozen public API surface, G2 — SemVer + CHANGELOG, G3 — frozen error catalog, Ruling R5(a): Prefer a Pinnable Third-Party Binding Over node:sqlite, Ruling C9: Bootstrap Pragma Order Is Irreversible and Nobody Owns It, Ruling C7: busy_timeout = 0 Survives the Worker Thread (+23 more)

### Community 5 - "DDL and Forward-Only Migration Limits"
Cohesion: 0.07
Nodes (30): Ruling R3(b): Do Not Repurpose CONNECTION_ERROR, Ruling C8: ADD COLUMN STORED Is a Lint Rule, Not a Blocker, The Honest Not-Closeable List: Five Items, One With Product Consequence, ALTER TABLE ADD COLUMN GENERATED STORED Blocker (B1), G4 Forward-Only Migration Contract, to_regclass to sqlite_schema Bootstrap Detection (B8), VIRTUAL Generated Column Workaround, auto_vacuum=INCREMENTAL Cannot Be Retrofitted (+22 more)

### Community 6 - "T5 Enforcement and Busy Semantics"
Cohesion: 0.09
Nodes (30): PRAGMA ignore_check_constraints, Shared-cache / read_uncommitted hazard, SQLITE_BUSY_SNAPSHOT (517), Check-then-insert TOCTOU window, Trigger-based overlap check, WAL journal mode, application_id + user_version + integrity_check on open, BDK 'database is locked' production incident (+22 more)

### Community 7 - "Type Parity and Query Constructs"
Cohesion: 0.08
Nodes (28): Ruling R4(iv): Write the Refinement Register Before the Port, BEGIN IMMEDIATE Write Lock, Chain-Archive Watermark JSON Regression Guard (B9), fillfactor and HOT-Update Hard Invariants (B7), SELECT ... FOR UPDATE Does Not Exist (B6), FTS5 Rejected on Containment Semantics, SQLite JSON Depth Limit 1000 vs MAX_JSON_DEPTH 64, json_each Single-Parameter Bulk Insert (+20 more)

### Community 8 - "Measurement Validity and Tag Sequencing"
Cohesion: 0.10
Nodes (28): Ruling C6: L7's D5 Hash-Off-The-Primary-Key Is a No-Op in SQLite, Ruling C1: L5 Benchmarks Ran on a tmpfs RAM Disk, The One Number Nobody Has: Remaining Weeks of Local-Indexer Catch-Up, Ruling: Land It Before the Local-Sync Evidence Run, Not Merely Before the Tag, Ruling #1: The Mandatory 1.0.0 Local Sync IS the Out-of-Cache Experiment, INTEGER PRIMARY KEY AUTOINCREMENT Identity Mapping, CheckpointStore Primitive, PRAGMA foreign_keys Default Trap (+20 more)

### Community 9 - "Error Catalog, Clock and Gates"
Cohesion: 0.10
Nodes (26): Ruling R-relay: SQLITE_BUSY Already Has Three Homes in the Frozen Set, BEGIN IMMEDIATE, EXCLUSION_VIOLATION error code, Gate G2 (SemVer / no error-code removal), Gate G3 (frozen error catalog), Gate G4 (durability / cancellation contract), RAISE(ABORT), RAISE(FAIL) (+18 more)

### Community 10 - "The Break Ledger and SemVer Ruling"
Cohesion: 0.10
Nodes (24): The 24-Row Break Ledger, Ruling: CLOCK_REGRESSION Narrowing to non-retryable Is a Forbidden Weakening, The Real Sequencing Price: A Second Pre-1.0 RC (0.10.0) With a Soak, Council Seat: Frozen Commitments and Versioning, The Catalog Freezes code-to-meaning but Never situation-to-code, Ruling R1: docs/STABILITY.md:46 — SemVer Commitments NOT Yet in Force, Ruling: This Is a 1.0.0, Not a 2.0.0, UmbraDBSql Is the Only Permanent Unavoidable Surface Break (+16 more)

### Community 11 - "Driver Decoding and Collation Hazards"
Cohesion: 0.11
Nodes (24): Ruling R5(b): Do Not Raise the engines Floor to >=25.7, Ruling R3(c): Rename UNRECOGNIZED_POSTGRES_ERROR Pre-Tag, BINARY Collation vs Postgres lc_collate Ordering, (table, column) Decoder Registry from columns() Origin Metadata, Extended errcode Error Shapes (Gift to L6), listKeys Resume-Cursor Collation Portability Hazard, node:sqlite Built-In Driver, NUL and Lone-Surrogate Text Guard (B4) (+16 more)

### Community 12 - "Schema Emulation and File Layout"
Cohesion: 0.13
Nodes (22): Ruling C5: Two Database Files, One Per Lineage, Ruling D2: Two Database Files, Established From the Code, A Direct Lane Contradiction on File Layout That No Adjudication Covered, One File Per Schema via ATTACH (Option B2b), Cross-ATTACH Foreign Keys Rejected at Parse Time, DEFAULT_SCHEMA Exported Symbol, G1 Frozen Public API Surface, Index and Trigger Names Are Global Per Database File (+14 more)

### Community 13 - "Backup, Restore and Blob I/O"
Cohesion: 0.17
Nodes (16): Ruling C2: backup() Is the Backup Mechanism, VACUUM INTO Is Compaction, Ruling C11: better-sqlite3 Incremental BLOB I/O Claim Refuted, node:sqlite backup() Non-Blocking but Ignores AbortSignal, G4 §6 Backup/Restore Contract, G4 §3 Cancellation Contract, No sqlite3_blob_open Binding in node:sqlite, node:sqlite Built-In Driver, CEILINGS.md SC-3 Single-Buffer Materialisation (+8 more)

### Community 14 - "Red Team: Broken Claims and Survivors"
Cohesion: 0.20
Nodes (10): The 88 GB Claim Is Load-Bearing Twice and Unreproduced Twice, Nobody Owns Corruption Detection or Field Repair, Process Fix: Every Sprint Brief Needs an Environment Assertion, Failed Attack: L1's Trigger-Based T5 Enforcement Survives and Is Stronger, Ruling: Redesign the Lease — In-Process Mutex Plus BEGIN IMMEDIATE Guard, SQLite Has No Main-Database Page Checksums — a Durability Regression, P10 Must Gain a Negative Control or a Green Re-Run Certifies Nothing, Council Seat: Red Team (+2 more)

### Community 15 - "postgres.js Idiom and Shim Port"
Cohesion: 0.25
Nodes (9): postgres.js driver, Cost Double-Counting: 123-176 Naive Down to 100-150 Engineer-Days, L3-B10 — readBigInts is per-statement/per-database, never per-column, columns() declared-type-name row decoding, db.createTagStore(), postgres.js-shaped tagged-template shim, setReadBigInts, Open question: node:sqlite's documented stability index (+1 more)

## Ambiguous Edges - Review These
- `Per-key sidecar SQLite lock file lease` → `The Sidecar Lease Is Silently Voided by a Single readFileSync`  [AMBIGUOUS]
  council-redteam.md · relation: references
- `L2-B7 — filesystem advisory-lock precondition replaces the pooler precondition` → `Open question: node:sqlite's documented stability index`  [AMBIGUOUS]
  l3-driver.md · relation: conceptually_related_to
- `node:sqlite (recommended driver)` → `Ruling R5(a): Prefer a Pinnable Third-Party Binding Over node:sqlite`  [AMBIGUOUS]
  council-commitments.md · relation: references
- `node:sqlite (recommended driver)` → `Contradiction Register C1-C18`  [AMBIGUOUS]
  council-contradiction.md · relation: references
- `Dedicated writer worker thread topology` → `Ruling: CONTRACT §3's Middle Timing Must Be Deleted, Not Reworded`  [AMBIGUOUS]
  council-commitments.md · relation: references
- `normalize() bind normalisation` → `Ruling C3/C4: STRICT Plus Date-to-Epoch-ms normalize()`  [AMBIGUOUS]
  council-contradiction.md · relation: references
- `ALTER TABLE ADD COLUMN GENERATED STORED Blocker (B1)` → `Ruling C8: ADD COLUMN STORED Is a Lint Rule, Not a Blocker`  [AMBIGUOUS]
  council-contradiction.md · relation: references
- `ALTER TABLE ADD COLUMN GENERATED STORED Blocker (B1)` → `ADD COLUMN GENERATED STORED Fails Only on Non-Empty Tables`  [AMBIGUOUS]
  l6-contracts.md · relation: semantically_similar_to
- `Table-Name Prefixing as Schema Emulation` → `DEFAULT_SCHEMA / Schema-Configurability (B9)`  [AMBIGUOUS]
  l4-typesystem.md · relation: semantically_similar_to
- `json_each Single-Parameter Bulk Insert` → `json_each Bulk Insert Hex Round-Trip Penalty`  [AMBIGUOUS]
  l5-archive.md · relation: semantically_similar_to
- `octet_length() Preferred Over length()` → `GENERATED ALWAYS AS (length(data)) STORED at CREATE TABLE`  [AMBIGUOUS]
  l4-typesystem.md · relation: semantically_similar_to
- `VACUUM INTO Blocks the JS Thread` → `VACUUM INTO as a Faithful pg_dump --single-snapshot`  [AMBIGUOUS]
  l5-archive.md · relation: semantically_similar_to
- `node:sqlite backup() Non-Blocking but Ignores AbortSignal` → `node:sqlite backup() Restarts Under Writer Interference`  [AMBIGUOUS]
  l5-archive.md · relation: semantically_similar_to
- `page_size = 16384 Recommendation (Irreversible)` → `Rewritten SQLite Durability Probe`  [AMBIGUOUS]
  l5-archive.md · relation: conceptually_related_to
- `No sqlite3_blob_open Binding in node:sqlite` → `Ruling C11: better-sqlite3 Incremental BLOB I/O Claim Refuted`  [AMBIGUOUS]
  council-contradiction.md · relation: references
- `One Database File Design Decision` → `Ruling C5: Two Database Files, One Per Lineage`  [AMBIGUOUS]
  council-contradiction.md · relation: references
- `One Database File Design Decision` → `Ruling D2: Two Database Files, Established From the Code`  [AMBIGUOUS]
  council-feasibility.md · relation: references
- `One Database File Design Decision` → `A Direct Lane Contradiction on File Layout That No Adjudication Covered`  [AMBIGUOUS]
  council-redteam.md · relation: references
- `PRAGMA busy_timeout as the lock_timeout Analogue` → `Ruling C7: busy_timeout = 0 Survives the Worker Thread`  [AMBIGUOUS]
  council-contradiction.md · relation: references
- `PRAGMA busy_timeout as the lock_timeout Analogue` → `Phase 0: Six Decisions Before Any Code`  [AMBIGUOUS]
  council-feasibility.md · relation: references
- `WAL Per-Frame Checksums Make Torn Pages Structurally Absent` → `SQLite Has No Main-Database Page Checksums — a Durability Regression`  [AMBIGUOUS]
  council-redteam.md · relation: references
- `VACUUM INTO as a Faithful pg_dump --single-snapshot` → `Ruling C2: backup() Is the Backup Mechanism, VACUUM INTO Is Compaction`  [AMBIGUOUS]
  council-contradiction.md · relation: references
- `kv_event event-log schema` → `Two databases, two durability policies`  [AMBIGUOUS]
  l7-precedent.md · relation: conceptually_related_to
- `Trigger-based overlap check` → `SQLITE_BUSY has no home in the frozen G3 retryable set`  [AMBIGUOUS]
  l7-precedent.md · relation: conceptually_related_to
- `Trigger-based overlap check` → `No SQLite wallet enforces temporal coherence in the engine`  [AMBIGUOUS]
  l7-precedent.md · relation: conceptually_related_to
- `SQLITE_BUSY_SNAPSHOT (517)` → `5 s busy_timeout is a bug, not a default`  [AMBIGUOUS]
  l7-precedent.md · relation: conceptually_related_to
- `WAL journal mode` → `WAL versus exclusive locking, unresolved`  [AMBIGUOUS]
  l7-precedent.md · relation: conceptually_related_to
- `Per-key monotone logical clock` → `Ruling #6 Inverts: Do Not Adopt the Logical Clock`  [AMBIGUOUS]
  council-redteam.md · relation: references
- `Abstract-to-concrete refinement bridge` → `No SQLite wallet enforces temporal coherence in the engine`  [AMBIGUOUS]
  l7-precedent.md · relation: conceptually_related_to
- `STRICT, WITHOUT ROWID tables` → `Rowid-keyed chunks with content hash as secondary index`  [AMBIGUOUS]
  l7-precedent.md · relation: conceptually_related_to
- `SQLITE_BUSY` → `Ruling R-relay: SQLITE_BUSY Already Has Three Homes in the Frozen Set`  [AMBIGUOUS]
  council-commitments.md · relation: references
- `busy_timeout pragma` → `Ruling C7: busy_timeout = 0 Survives the Worker Thread`  [AMBIGUOUS]
  council-contradiction.md · relation: references
- `Ruling R5(a): Prefer a Pinnable Third-Party Binding Over node:sqlite` → `Phase 0: Six Decisions Before Any Code`  [AMBIGUOUS]
  council-commitments.md · relation: conceptually_related_to
- `Ruling R6: Keep writtenAt: Date, Bound and Observe the Drift` → `Ruling #6 Inverts: Do Not Adopt the Logical Clock`  [AMBIGUOUS]
  council-redteam.md · relation: conceptually_related_to
- `Ruling: Build the Worker With a Transaction-Granular RPC (3.4x, Not 32x)` → `The Worker Round-Trip Cost Is Not Fixed and Is Unreachable for withTransaction`  [AMBIGUOUS]
  council-redteam.md · relation: conceptually_related_to
- `No npm Publication, No Installed Consumer, No Postgres Container` → `Zero Consumers Is Unobservable, Not Proven — Ask the Owner`  [AMBIGUOUS]
  council-redteam.md · relation: conceptually_related_to
- `Cost View: Take the Monotone Clock and Ship a Drift Diagnostic` → `Ruling #6 Inverts: Do Not Adopt the Logical Clock`  [AMBIGUOUS]
  council-redteam.md · relation: conceptually_related_to

## Knowledge Gaps
- **83 isolated node(s):** `WalletStateEnvelope capability`, `tstzrange validity column`, `kv_current_history_trigger plpgsql trigger`, `clock_timestamp() temporal boundaries`, `jsonb columns` (+78 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **18 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Per-key sidecar SQLite lock file lease` and `The Sidecar Lease Is Silently Voided by a Single readFileSync`?**
  _Edge tagged AMBIGUOUS (relation: references) - confidence is low._
- **What is the exact relationship between `L2-B7 — filesystem advisory-lock precondition replaces the pooler precondition` and `Open question: node:sqlite's documented stability index`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `node:sqlite (recommended driver)` and `Ruling R5(a): Prefer a Pinnable Third-Party Binding Over node:sqlite`?**
  _Edge tagged AMBIGUOUS (relation: references) - confidence is low._
- **What is the exact relationship between `node:sqlite (recommended driver)` and `Contradiction Register C1-C18`?**
  _Edge tagged AMBIGUOUS (relation: references) - confidence is low._
- **What is the exact relationship between `Dedicated writer worker thread topology` and `Ruling: CONTRACT §3's Middle Timing Must Be Deleted, Not Reworded`?**
  _Edge tagged AMBIGUOUS (relation: references) - confidence is low._
- **What is the exact relationship between `normalize() bind normalisation` and `Ruling C3/C4: STRICT Plus Date-to-Epoch-ms normalize()`?**
  _Edge tagged AMBIGUOUS (relation: references) - confidence is low._
- **What is the exact relationship between `ALTER TABLE ADD COLUMN GENERATED STORED Blocker (B1)` and `Ruling C8: ADD COLUMN STORED Is a Lint Rule, Not a Blocker`?**
  _Edge tagged AMBIGUOUS (relation: references) - confidence is low._