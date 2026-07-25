import { describe, expectTypeOf, it } from "vitest";
import {
  createClient, runMigrations, saveAndAdvance, Rollback, DEFAULT_SCHEMA,
  PgTemporalKV, PgCheckpointStore, PgWatermarks, PgTransactionLeaseLayer,
  PgTransactionHistoryStorage, PgWalletStateEnvelopeStore, StorageError,
  type UmbraDBSql, type UmbraDBConnectionOptions, type Migration, type RunMigrationsOptions,
  type Retryability,
  type SharedStorageErrorCode, type TemporalKVErrorCode, type CheckpointStoreErrorCode,
  type TransactionLeaseErrorCode, type WalletStateEnvelopeErrorCode,
  type TemporalKV, type VersionedEntry, type AsOf, type JsonValue, type Namespace, type Scope,
  type Key, type Version,
  type Watermarks, type WatermarkKind, type WatermarkKey, type WatermarkValue,
  type CheckpointStore, type CheckpointSummary, type CheckpointRecord, type PruneResult,
  type SaveCheckpointOptions, type HistoryOptions, type CheckpointSequence, type ContentHash,
  type TransactionLeaseLayer, type TransactionHandle, type Lease, type TransactionOptions,
  type LeaseAcquireOptions, type TransactionRollbackCause,
  type TransactionHistoryStorage, type TransactionHistoryReader, type TransactionHistoryWriter,
  type TransactionHistoryEntry, type TransactionHistoryStatus, type EntryContent,
  type EntryLifecycle, type EntryLifecycleStatus, type PendingLifecycle, type FinalizedLifecycle,
  type RejectedLifecycle, type MergeEntriesFn,
  type WalletStateEnvelope, type SaveAndAdvanceDeps, type SaveAndAdvanceCursor,
} from "../../src/index.js";

/**
 * G1 / acceptance A5: a compiled type-assertion file (vitest expectTypeOf) proves each frozen
 * export resolves to a concrete type from the public barrel (src/index.ts; its declarations are emitted 1:1 to dist/index.d.ts by `npm run build`) with no
 * implicit-any fallback and no missing-declaration diagnostic. The assertions are checked by
 * npm run typecheck (tsc, under strict/noImplicitAny); at vitest runtime they are no-ops. If any
 * frozen export were any, not.toBeAny() would fail to compile.
 */
describe("frozen surface: every export is a concrete, non-any type from the built declarations (A5)", () => {
  it("entry-point values are concrete functions/constructors", () => {
    expectTypeOf(createClient).toBeFunction();
    expectTypeOf(runMigrations).toBeFunction();
    expectTypeOf(saveAndAdvance).toBeFunction();
    expectTypeOf(DEFAULT_SCHEMA).not.toBeAny();
    expectTypeOf(PgTemporalKV).toBeConstructibleWith({} as unknown as UmbraDBSql);
    expectTypeOf(PgTransactionLeaseLayer).not.toBeAny();
    expectTypeOf(PgCheckpointStore).not.toBeAny();
    expectTypeOf(PgWatermarks).not.toBeAny();
    expectTypeOf(PgTransactionHistoryStorage).not.toBeAny();
    expectTypeOf(PgWalletStateEnvelopeStore).not.toBeAny();
    expectTypeOf(Rollback).not.toBeAny();
    expectTypeOf(StorageError).not.toBeAny();
  });

  it("each concrete adapter instance implements its frozen interface", () => {
    expectTypeOf<InstanceType<typeof PgTemporalKV>>().toMatchTypeOf<TemporalKV>();
    expectTypeOf<InstanceType<typeof PgWatermarks>>().toMatchTypeOf<Watermarks>();
    expectTypeOf<InstanceType<typeof PgCheckpointStore>>().toMatchTypeOf<CheckpointStore>();
    expectTypeOf<InstanceType<typeof PgTransactionLeaseLayer>>().toMatchTypeOf<TransactionLeaseLayer>();
    expectTypeOf<InstanceType<typeof PgTransactionHistoryStorage>>().toMatchTypeOf<TransactionHistoryStorage>();
  });

  it("Retryability is the frozen tri-state union", () => {
    expectTypeOf<Retryability>().toEqualTypeOf<"retryable" | "non-retryable" | "conditional">();
  });

  it("every frozen type alias / interface resolves to a concrete (non-any) type", () => {
    expectTypeOf<UmbraDBSql>().not.toBeAny();
    expectTypeOf<UmbraDBConnectionOptions>().not.toBeAny();
    expectTypeOf<Migration>().not.toBeAny();
    expectTypeOf<RunMigrationsOptions>().not.toBeAny();
    expectTypeOf<Retryability>().not.toBeAny();
    expectTypeOf<TemporalKV>().not.toBeAny();
    expectTypeOf<VersionedEntry>().not.toBeAny();
    expectTypeOf<AsOf>().not.toBeAny();
    expectTypeOf<JsonValue>().not.toBeAny();
    expectTypeOf<Namespace>().not.toBeAny();
    expectTypeOf<Scope>().not.toBeAny();
    expectTypeOf<Key>().not.toBeAny();
    expectTypeOf<Version>().not.toBeAny();
    expectTypeOf<Watermarks>().not.toBeAny();
    expectTypeOf<WatermarkKind>().not.toBeAny();
    expectTypeOf<WatermarkKey>().not.toBeAny();
    expectTypeOf<WatermarkValue>().not.toBeAny();
    expectTypeOf<CheckpointStore>().not.toBeAny();
    expectTypeOf<CheckpointSummary>().not.toBeAny();
    expectTypeOf<CheckpointRecord>().not.toBeAny();
    expectTypeOf<PruneResult>().not.toBeAny();
    expectTypeOf<SaveCheckpointOptions>().not.toBeAny();
    expectTypeOf<HistoryOptions>().not.toBeAny();
    expectTypeOf<CheckpointSequence>().not.toBeAny();
    expectTypeOf<ContentHash>().not.toBeAny();
    expectTypeOf<TransactionLeaseLayer>().not.toBeAny();
    expectTypeOf<TransactionHandle>().not.toBeAny();
    expectTypeOf<Lease>().not.toBeAny();
    expectTypeOf<TransactionOptions>().not.toBeAny();
    expectTypeOf<LeaseAcquireOptions>().not.toBeAny();
    expectTypeOf<TransactionRollbackCause>().not.toBeAny();
    expectTypeOf<TransactionHistoryStorage>().not.toBeAny();
    expectTypeOf<TransactionHistoryReader>().not.toBeAny();
    expectTypeOf<TransactionHistoryWriter>().not.toBeAny();
    expectTypeOf<TransactionHistoryEntry>().not.toBeAny();
    expectTypeOf<TransactionHistoryStatus>().not.toBeAny();
    expectTypeOf<EntryContent>().not.toBeAny();
    expectTypeOf<EntryLifecycle>().not.toBeAny();
    expectTypeOf<EntryLifecycleStatus>().not.toBeAny();
    expectTypeOf<PendingLifecycle>().not.toBeAny();
    expectTypeOf<FinalizedLifecycle>().not.toBeAny();
    expectTypeOf<RejectedLifecycle>().not.toBeAny();
    expectTypeOf<MergeEntriesFn>().not.toBeAny();
    expectTypeOf<WalletStateEnvelope>().not.toBeAny();
    expectTypeOf<SaveAndAdvanceDeps>().not.toBeAny();
    expectTypeOf<SaveAndAdvanceCursor>().not.toBeAny();
    expectTypeOf<SharedStorageErrorCode>().not.toBeAny();
    expectTypeOf<TemporalKVErrorCode>().not.toBeAny();
    expectTypeOf<CheckpointStoreErrorCode>().not.toBeAny();
    expectTypeOf<TransactionLeaseErrorCode>().not.toBeAny();
    expectTypeOf<WalletStateEnvelopeErrorCode>().not.toBeAny();
  });
});
