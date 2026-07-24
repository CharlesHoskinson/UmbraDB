/**
 * UmbraDB -- the frozen 1.0.0 public API surface.
 *
 * @remarks
 * This barrel is the single public entry point (compiled to `dist/index.js` + `dist/index.d.ts`).
 * A consumer imports everything from the package root; there is no supported deep import of an
 * internal module (the `package.json` `exports` map exposes only `"."`). The surface re-exported
 * here is frozen under the 1.0.0 SemVer contract: nothing is removed or changed incompatibly in a
 * minor/patch, and the error `code` set is likewise frozen (`docs`/`CHANGELOG`).
 *
 * What it exposes: the connection factory (`createClient`) and forward-only migration runner
 * (`runMigrations`) that provision the default `umbradb` schema ({@link DEFAULT_SCHEMA}) with the
 * Tier-1 `tier1_wallet` migration lineage; the five storage primitives -- {@link PgTemporalKV},
 * {@link PgCheckpointStore}, {@link PgWatermarks}, {@link PgTransactionLeaseLayer},
 * {@link PgTransactionHistoryStorage} -- plus the {@link PgWalletStateEnvelopeStore} wrapper and the
 * {@link saveAndAdvance} co-transactional composition primitive; every `interfaces/` contract and
 * value type; the {@link Rollback} control primitive; and the full {@link StorageError} hierarchy
 * (minus the chain-archive classes) with its machine-readable {@link Retryability} field.
 *
 * What it deliberately does NOT expose (smallest-surface default -- `council/A` §4(a)): the internal
 * Zod schema objects, the `translatePostgresError` family and other adapter plumbing, the
 * `AbortSignal` helpers, and the deferred full-chain-archival track (the `chain_archive` schema and
 * its error classes) -- that track is a 1.1 preview, outside the frozen 1.0.0 surface, and its
 * live-Preprod ingestion service lives entirely outside `src/`. Deep imports of any of these become
 * unresolvable for a consumer of the published package, which is the enforcement mechanism, not a
 * side effect.
 *
 * The `withTransaction`/`withLease` combinators are `async` METHODS of {@link PgTransactionLeaseLayer}
 * (and its {@link TransactionLeaseLayer} interface), reachable through that exported class -- there
 * are no standalone `withTransaction`/`withLease` module-level exports to re-export.
 *
 * @packageDocumentation
 */

// ===========================================================================================
// Runtime value exports (classes, functions, constants)
// ===========================================================================================

// --- Entry points ---
export { createClient, DEFAULT_SCHEMA } from "./postgres/client.js";
export { runMigrations, MigrationLockTimeoutError } from "./postgres/migrate.js";

// --- The five storage primitives + the wallet-state-envelope wrapper ---
export { PgTemporalKV } from "./postgres/temporal-kv.js";
export { PgCheckpointStore } from "./postgres/checkpoint-store.js";
export { PgWatermarks } from "./postgres/watermarks.js";
export { PgTransactionLeaseLayer } from "./postgres/transaction-lease.js";
export { PgTransactionHistoryStorage } from "./postgres/transaction-history-storage.js";
export { PgWalletStateEnvelopeStore } from "./postgres/wallet-state-envelope.js";

// --- Co-transactional composition primitive (G5) ---
export { saveAndAdvance } from "./postgres/save-and-advance.js";

// --- The Rollback control primitive (an Error subclass, deliberately NOT a StorageError and with
//     NO catalog code: a caller throws it inside a withTransaction callback to request a rollback). ---
export { Rollback } from "./interfaces/transaction-lease.js";

// --- The StorageError hierarchy (base + every concrete subclass EXCEPT the six chain-archive
//     classes, which are deferred to 1.1). Each concrete class carries a machine-readable
//     `retryable: Retryability` field; see the frozen catalog for the {code -> retryable} table. ---
export { StorageError, ValidationError, SerializationFailedError, ConnectionError } from "./interfaces/storage-errors.js";
export { VersionConflictError, HistoryUnavailableError, TransactionKeyReuseError } from "./interfaces/temporal-kv.js";
export {
  CheckpointNotFoundError, ChunkMissingError, ChunkIntegrityError, ManifestCorruptError,
} from "./interfaces/checkpoint-store.js";
export {
  TransactionRolledBackError, TransactionFaultError, LeaseTimeoutError, LeaseNotHeldError,
  LeaseFaultError, TransactionHandleInvalidError,
} from "./interfaces/transaction-lease.js";
export { EnvelopeVersionUnsupportedError, EnvelopeCorruptError } from "./interfaces/wallet-state-envelope.js";
export { ExclusionViolationError, ClockRegressionError, UnrecognizedPostgresError } from "./postgres/errors.js";
// Durability-contract error classes (G6): a consumer catches these from `runMigrations`, so they
// are part of the public durability surface even though they are thrown by the startup probe.
export { DurabilityContractError, TransactionPoolerDetectedError } from "./postgres/durability-probe.js";

// ===========================================================================================
// Type-only exports (interfaces, type aliases) -- erased at runtime
// ===========================================================================================

// --- Entry-point / client types ---
export type { UmbraDBSql, UmbraDBConnectionOptions } from "./postgres/client.js";
export type { Migration, RunMigrationsOptions } from "./postgres/migrate.js";
export type { SaveAndAdvanceDeps, SaveAndAdvanceCursor } from "./postgres/save-and-advance.js";

// --- Retryability classification (the type of every StorageError's `retryable` field) ---
export type { Retryability } from "./interfaces/storage-errors.js";

// --- TemporalKV contract + value types ---
export type { TemporalKV, VersionedEntry, AsOf, JsonValue, Namespace, Scope, Key, Version } from "./interfaces/temporal-kv.js";

// --- Watermarks contract + value types ---
export type { Watermarks, WatermarkKind, WatermarkKey, WatermarkValue } from "./interfaces/watermarks.js";

// --- CheckpointStore contract + value types ---
export type {
  CheckpointStore, CheckpointSummary, CheckpointRecord, PruneResult, SaveCheckpointOptions,
  HistoryOptions, CheckpointSequence, ContentHash,
} from "./interfaces/checkpoint-store.js";

// --- Transaction/Lease contract + value types (withTransaction/withLease are methods of the
//     TransactionLeaseLayer interface / PgTransactionLeaseLayer class, not standalone symbols). ---
export type {
  TransactionLeaseLayer, TransactionHandle, Lease, TransactionOptions, LeaseAcquireOptions,
  TransactionRollbackCause,
} from "./interfaces/transaction-lease.js";

// --- Transaction-history contract + value types ---
export type {
  TransactionHistoryStorage, TransactionHistoryReader, TransactionHistoryWriter,
  TransactionHistoryEntry, TransactionHistoryStatus, EntryContent, EntryLifecycle,
  EntryLifecycleStatus, PendingLifecycle, FinalizedLifecycle, RejectedLifecycle, MergeEntriesFn,
} from "./interfaces/transaction-history-storage.js";

// --- Wallet-state-envelope value type ---
export type { WalletStateEnvelope } from "./interfaces/wallet-state-envelope.js";
