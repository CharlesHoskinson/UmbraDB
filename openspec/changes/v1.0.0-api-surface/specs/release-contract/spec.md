# release-contract

The 1.0.0 public API surface and release contract for UmbraDB: the frozen, importable,
semver-governed surface (the five merged primitives + `PgWalletStateEnvelopeStore`), the frozen
error-code catalog, the written contracts, and the frozen formal cut-line. Requirements below
follow EARS (Easy Approach to Requirements Syntax): each is one of Ubiquitous ("The system
SHALL..."), Event-driven ("WHEN \<trigger>, the system SHALL..."), Unwanted-behavior ("IF
\<trigger>, THEN the system SHALL..."), State-driven ("WHILE \<state>, the system SHALL..."), or
Optional-feature ("WHERE \<feature>, the system SHALL...") form — as in Sprint 4's
`specs/watermarks/spec.md`. This change covers gate items **G1-G4, G20**
(`ROADMAP-v1.0.0-CONSOLIDATED.md` §A, §F). Requirements are grounded in real code at
`/root/UmbraDB` and honor `council/A-release-scope.md` verbatim.

## ADDED Requirements

### Requirement: A single public barrel exports exactly the frozen 1.0.0 surface

The package SHALL provide a single public entry point (`src/index.ts`, compiled to
`dist/index.js`) that re-exports exactly, and only: `createClient`, `runMigrations`, the five
adapters (`PgTemporalKV`, `PgCheckpointStore`, `PgWatermarks`, `PgTransactionLeaseLayer`,
`PgTransactionHistoryStorage`), `PgWalletStateEnvelopeStore`, all `src/interfaces/` contract and
value types, the `Rollback` control primitive (an `Error` subclass with no catalog `code`, thrown
by callers to request a deliberate `withTransaction` rollback), and the `StorageError` hierarchy
except the chain-archive error classes (see the chain-archive requirement below). The
`withTransaction`/`withLease` combinators are frozen as **methods** of the exported
`PgTransactionLeaseLayer` class (and its `TransactionLeaseLayer` interface), not as standalone
module-level symbols — there are none to re-export (`src/postgres/transaction-lease.ts:207,403`;
`src/interfaces/transaction-lease.ts:189`). The barrel SHALL NOT re-export the internal Zod schema
objects, the `translatePostgresError` family, the internal helpers `resolveTransaction` /
`assertValidSchemaName` / `withAbort` / `abortError`, any `chain-archive`/`chain-archive-sync`
symbol, or the `nix/midnight-env` dev stack (`council/A` §4(a)). (G1)

#### Scenario: The barrel re-exports every frozen primitive and its interface type
- **WHEN** a consumer imports from the package root (`import { createClient, runMigrations,
  PgTemporalKV, PgCheckpointStore, PgWatermarks, PgTransactionLeaseLayer,
  PgTransactionHistoryStorage, PgWalletStateEnvelopeStore, Rollback, StorageError } from
  "umbradb"`)
- **THEN** every one of those names SHALL resolve to the corresponding implementation or type
- **AND** the corresponding interface types (`TemporalKV`, `CheckpointStore`, `Watermarks`,
  `TransactionLeaseLayer`, `TransactionHistoryStorage`, the wallet-envelope types, and
  `TransactionHandle`) SHALL be importable from the same root
- **AND** the `withTransaction`/`withLease` combinators SHALL be reachable as methods on a
  `PgTransactionLeaseLayer` instance (typed by the `TransactionLeaseLayer` interface), not as
  separate top-level imports

#### Scenario: Internal named symbols are not re-exported by the barrel
- **WHEN** a consumer attempts a named import of an internal symbol not on the frozen list (e.g. a
  Zod schema object, `translatePostgresError`, `resolveTransaction`, or any chain-archive class)
  from the package root
- **THEN** the import SHALL fail at link time with a "does not provide an export named …" error,
  because the barrel does not re-export that symbol

#### Scenario: A deep subpath into an internal module is blocked by the exports map
- **WHEN** a consumer attempts a deep import of an internal module path (e.g.
  `umbradb/src/postgres/temporal-kv.js`)
- **THEN** module resolution SHALL fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`, because the strict
  `exports` map exposes only the root subpath

### Requirement: package.json is publishable with a strict exports map and no deep-import escape hatch

The `package.json` SHALL drop `private: true`, and SHALL declare `main`, `types`, and an `exports`
map whose only public subpath is the root (`"."`), pointing at the built `dist/index.js` and
`dist/index.d.ts`. The `exports` map SHALL NOT contain a wildcard subpath (`"./*"`) or any mapping
that resolves an internal `src/postgres/*` module, so that deep imports of internal paths become
unresolvable for a consumer of the published package (`council/A` §4(a)-1). (G1)

#### Scenario: The package advertises a root import and no deep-import path
- **WHEN** the published package's `package.json` is inspected
- **THEN** `private: true` SHALL be absent
- **AND** `main`, `types`, and an `exports` map with a `"."` entry SHALL be present
- **AND** no `exports` entry SHALL resolve a `src/postgres/*` or `src/interfaces/*` deep path

#### Scenario: A deep import of an internal module is unresolvable from the installed package
- **WHEN** a consumer of the installed package attempts `import ... from
  "umbradb/src/postgres/temporal-kv.js"` (or any other deep internal path)
- **THEN** module resolution SHALL fail, because the strict `exports` map does not expose it

### Requirement: The published package ships type declarations

The build SHALL emit `.d.ts` declaration files for the public surface (today the only build-ish
script is `"typecheck": "tsc --noEmit"`, which emits nothing), and the packed tarball SHALL
include them so a TypeScript consumer resolves types from `umbradb` without a separate `@types`
package. (G1)

#### Scenario: The tarball contains a declaration for the public entry point
- **WHEN** the package is packed (`npm pack`) and the tarball contents are listed
- **THEN** a declaration file for the public entry point (`dist/index.d.ts`) SHALL be present in
  the tarball
- **AND** importing the package from a TypeScript project compiled under `noImplicitAny` SHALL
  surface the frozen surface's types with no "could not find a declaration file" diagnostic and
  with no implicit-`any` on any frozen name (proven by a compiled type-assertion file, e.g. `tsd`
  / `expectTypeOf` assertions over each frozen export)

### Requirement: A packed-tarball install smoke test proves the surface resolves for a real consumer

WHEN the packed tarball is installed into a throwaway scratch project, the smoke test SHALL import
the public surface from the package root, run `runMigrations` and at least one adapter round-trip
(e.g. `PgTemporalKV.put`/`get`) against a real (Testcontainers) Postgres, and assert the surface
resolves; it SHALL additionally assert that a deep internal import fails to resolve and that the
`.d.ts` is present. (G1)

#### Scenario: A fresh install imports and exercises the public surface
- **WHEN** the smoke test installs the packed tarball and imports `{ createClient, runMigrations,
  PgTemporalKV }` from `"umbradb"`, then runs migrations and a `put`/`get` round-trip against a
  real Postgres
- **THEN** the imports SHALL resolve and the round-trip SHALL return the written value

#### Scenario: The smoke test proves the strict boundary and the shipped types
- **WHEN** the same smoke test attempts a deep import `umbradb/src/postgres/temporal-kv.js` and
  inspects the installed package for `dist/index.d.ts`
- **THEN** the deep import SHALL fail to resolve
- **AND** the declaration file SHALL be present

### Requirement: A written SemVer stability policy governs the frozen surface

The release SHALL publish a written stability policy stating that the exported surface and the
error-`code` set SHALL NOT change incompatibly in a minor or patch release; that removals SHALL be
deprecated in a minor and removed only in a major; and that a major MAY require a documented
forward migration with no supported downgrade. (G2)

#### Scenario: The stability policy states the SemVer commitment concretely
- **WHEN** the stability policy is read
- **THEN** it SHALL state "no breaking changes to the exported surface or error `code` set in
  minor/patch"
- **AND** it SHALL state the deprecate-in-minor / remove-in-major rule
- **AND** it SHALL state that a major may require a forward migration and that downgrade is
  unsupported

### Requirement: A CHANGELOG records the 1.0.0 surface

The repository SHALL contain a `CHANGELOG.md` in Keep-a-Changelog format whose `1.0.0` entry
enumerates the initial public surface (the five primitives + `PgWalletStateEnvelopeStore`). (G2)

#### Scenario: The 1.0.0 CHANGELOG entry enumerates the frozen surface
- **WHEN** `CHANGELOG.md` is read
- **THEN** it SHALL contain a `1.0.0` entry
- **AND** that entry SHALL name the five primitives and the wallet-state-envelope capability as
  the initial public API

### Requirement: The error-code catalog is frozen and published with a retryable field

The release SHALL publish a `{code → meaning → retryable}` table covering exactly the 21 frozen
error codes enumerated in design §3.1 (the shared, TemporalKV, CheckpointStore, Transaction/Lease,
wallet-envelope, and postgres-adapter codes — the complete set of non-chain-archive
`StorageError.code` values on `main`) and SHALL NOT include any `CHAIN_ARCHIVE_*`, `BLOB_*`, or
`BLOCK_NOT_FOUND` code. Each code in the table SHALL be marked with its retryability. (G3)

#### Scenario: The published catalog lists every frozen code with a retryability marking
- **WHEN** the error-code catalog document is read
- **THEN** each of the 21 frozen codes SHALL appear with a one-line meaning and a retryable marking
- **AND** `CONNECTION_ERROR`, `TRANSACTION_FAULT`, and `LEASE_TIMEOUT` SHALL be marked retryable
- **AND** no `CHAIN_ARCHIVE_INVARIANT_VIOLATION`, `CHAIN_ARCHIVE_CHECK_VIOLATION`,
  `BLOB_INTEGRITY`, `BLOB_MISSING`, or `BLOCK_NOT_FOUND` code SHALL appear in the catalog

### Requirement: Retryability is a machine-readable field on every StorageError

The `StorageError` base (`src/interfaces/storage-errors.ts`) SHALL expose retryability as a
machine-readable field (not prose-only), and every concrete subclass SHALL set it. IF an error's
retryability is conditional, THEN the field SHALL express the condition rather than mislabel the
error as uniformly non-retryable. (G3)

#### Scenario: A caught error exposes retryability without parsing a message
- **WHEN** a consumer catches any `StorageError` subclass instance
- **THEN** the instance SHALL expose a machine-readable retryability value alongside its stable
  `code`, requiring no message-string parsing

#### Scenario: ClockRegressionError's two causes are not collapsed into a single wrong label
- **WHEN** the retryability of `CLOCK_REGRESSION` (`src/postgres/errors.ts`) is represented
- **THEN** it SHALL distinguish the retryable same-millisecond precision collision from the
  non-retryable backward wall-clock step (or mark the code "conditional" with that distinction
  documented), rather than labelling `CLOCK_REGRESSION` uniformly non-retryable

### Requirement: The chain-archive error classes are excluded from the frozen surface

Because full-chain archival is deferred to 1.1 (`council/A` ruling (e)), the chain-archive error
classes SHALL NOT be part of the frozen 1.0.0 surface: `ChainArchiveInvariantError`,
`ChainArchiveCheckViolationError` (`src/postgres/errors.ts`), `ChainArchiveError`,
`BlobIntegrityError`, `BlobMissingError`, and `BlockNotFoundError`
(`src/interfaces/chain-archive-store.ts`) SHALL NOT be re-exported from the barrel, and their codes
SHALL NOT appear in the frozen catalog. IF the chain-archive constraint-name routing is retained in
`translatePostgresError`, THEN those classes SHALL be marked experimental/internal so an unshipped
1.1 feature does not freeze 1.0 public API. (G3)

#### Scenario: Chain-archive classes are not exported and their codes are not frozen
- **WHEN** the public barrel and the frozen error catalog are inspected
- **THEN** none of the six chain-archive error classes SHALL be re-exported from the package root
- **AND** none of their codes SHALL appear in the frozen `{code → meaning → retryable}` table

#### Scenario: Internal 23514 routing still resolves the right class without freezing it
- **WHEN** `translatePostgresError` receives a SQLSTATE `23514` whose `constraint_name` matches a
  chain-archive constraint (with the archive schema present)
- **THEN** it SHALL still route to the correct chain-archive class internally
- **AND** that class SHALL be marked experimental/internal and remain absent from the public
  surface

### Requirement: A durability contract states the ordering guarantee and its binding precondition

The release SHALL document a durability contract stating that a watermark/cursor never commits
ahead of the checkpoint data it references (the guarantee the co-transactional `save` fix, G5,
establishes), and stating the binding Postgres precondition (`fsync`, `synchronous_commit`,
`full_page_writes` enabled; no transaction pooler) that the startup probe (G6) asserts. (G4)

#### Scenario: The durability contract names the ordering guarantee and the required Postgres config
- **WHEN** the durability contract is read
- **THEN** it SHALL state that the cursor never advances past durable checkpoint data
- **AND** it SHALL state the required `fsync`/`synchronous_commit`/`full_page_writes` settings and
  the no-transaction-pooler precondition as binding

### Requirement: A forward-only migration contract states there is no supported downgrade

The release SHALL document that migrations are forward-only (`src/postgres/migrate.ts`'s
`Migration` interface is `up()`-only, with no `down()`), that a UmbraDB major MAY require a
documented migration, that there is no supported downgrade, and how the schema-version row behaves
on an application rollback; the generated schema reference SHALL be published/referenced. (G4)

#### Scenario: The migration contract states forward-only and no-downgrade explicitly
- **WHEN** the migration contract is read
- **THEN** it SHALL state that migrations are forward-only with no rollback path
- **AND** it SHALL state that downgrade is unsupported and that a major may require a documented
  migration
- **AND** it SHALL link the generated schema reference (`docs/SCHEMA.md`)

### Requirement: A cancellation contract states the abort guarantee as public behavior

The release SHALL document the cancellation guarantee already implemented via `AbortSignal` /
`withAbort` (`src/postgres/abort.ts`) as public contract: abort before dispatch issues no query;
abort during a long read (`listKeys`, lease acquisition) frees the cursor/wait; abort during a
quick write may complete. (G4)

#### Scenario: The cancellation contract distinguishes the three abort timings
- **WHEN** the cancellation contract is read
- **THEN** it SHALL state that an already-aborted signal issues no query
- **AND** it SHALL state that a mid-long-read abort frees the cursor or lease wait
- **AND** it SHALL state that a mid-quick-write abort may still complete

### Requirement: A save-retry caveat documents the non-blind-retry rule

The release SHALL document that `CheckpointStore.save` is not blindly retryable — that on a
`ConnectionError` a caller SHALL re-check `history()` before retrying, because a lost-COMMIT-ack
retry produces a benign identical-content duplicate at the next sequence pruned by `retainCount` —
and SHALL state that the `idempotency_key` UNIQUE constraint is a deferred additive 1.1 migration,
not a 1.0 code change (`council/A` critique #1). (G4)

#### Scenario: The save-retry caveat states the re-check rule and the deferral
- **WHEN** the save-retry caveat is read
- **THEN** it SHALL instruct callers to re-check `history()` before retrying `save` after a
  `ConnectionError`
- **AND** it SHALL state that automatic idempotency (the `idempotency_key` UNIQUE migration) is a
  1.1 fast-follow, not part of 1.0

### Requirement: A lease-limitation contract states the single-process boundary

The release SHALL document that the lease guards concurrent acquirers only within the single-process
deployment model, that it does NOT fence writes against connection death, and that two writer
processes SHALL NOT be run (`council/A` critique #4). (G4)

#### Scenario: The lease contract states the fencing limitation
- **WHEN** the lease-limitation contract is read
- **THEN** it SHALL state that the lease does not fence writes against connection death
- **AND** it SHALL state that running two writer processes is unsupported in the 1.0 model

### Requirement: Backup/restore guidance covers dump consistency for content-addressed storage

The release SHALL document how a consumer backs up and restores an UmbraDB schema, including that
CheckpointStore's chunk tables and manifest must be dumped consistently and that a dump taken during
a GC pass must remain safe/restorable. (G4)

#### Scenario: The backup guidance addresses chunk/manifest consistency under GC
- **WHEN** the backup/restore guidance is read
- **THEN** it SHALL state how to take a consistent `pg_dump` of an UmbraDB schema
- **AND** it SHALL state that the chunk tables and manifest must be captured consistently and that a
  mid-GC dump is safe to restore

### Requirement: A threat-model pointer completes the contract set

The contract doc set SHALL include a pointer to the threat-model document (authored separately as
G15), so the contract set is complete; this change SHALL NOT author the threat-model document
itself. (G4)

#### Scenario: The contract set links the threat model
- **WHEN** the contract doc set is read
- **THEN** it SHALL contain a pointer/link to the threat-model document (single trusted writer;
  schema ≠ security boundary; dedup side channel; no at-rest encryption precondition)

### Requirement: A format-headroom note reserves keyed/encrypted chunk modes for 1.1

The release SHALL document that chunk addressing and the wallet-state envelope encoding are
versioned, such that a v2 keyed/encrypted chunk mode (and at-rest encryption) can be introduced
additively in 1.1 without a breaking migration (`council/A` critique #7). This is the documentation
half of the deferred dedup-oracle mitigation; no keyed-chunking or encryption code ships in 1.0. (G4)

#### Scenario: The format-headroom note reserves additive space for 1.1 chunk modes
- **WHEN** the format-headroom note is read
- **THEN** it SHALL state that chunk addressing and envelope encoding are versioned
- **AND** it SHALL state that a keyed/encrypted chunk mode can be added additively in 1.1 without a
  breaking migration

### Requirement: The 1.0.0 Lean cut-line is frozen with a written deferral

The release SHALL declare the 1.0.0 formal-proof cut-line as exactly `{T3, T5, W1, C1}` (already
mechanized and trust-gated in required CI, `.github/workflows/lean.yml`) and SHALL record a written
deferral of C2a/GC, ordered reconstruction, lease traces, keyed-store lifting, and SQL/runtime
refinement to post-1.0, converting the previously-unfalsifiable "tractable properties proved"
checklist item into a checkable box (report 01 gap row 1; `council/A` gate G11). (G20)

#### Scenario: The frozen cut-line and its deferral are recorded
- **WHEN** the frozen Lean cut-line record (in `ROADMAP.md` and/or the `Formal/` plan) is read
- **THEN** it SHALL name exactly `{T3, T5, W1, C1}` as the 1.0.0 proved set
- **AND** it SHALL list C2a/GC, ordered reconstruction, lease traces, keyed-store lifting, and
  SQL/runtime refinement as explicitly deferred past 1.0

#### Scenario: The frozen set is the set actually mechanized and covered by the trust gate
- **WHEN** each property in `{T3, T5, W1, C1}` is traced to its Lean declaration under `Formal/Lean`
  and that tree is confirmed to be scanned by the trust gate in `.github/workflows/lean.yml` (the
  gate rejects new `sorry`/`admit`/`axiom`/`unsafe`; it does not enumerate property names)
- **THEN** every one of the four properties SHALL be mechanized in `Formal/Lean` and covered by the
  trust gate, so the checklist box is objectively green
