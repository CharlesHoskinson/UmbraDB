import { describe, expect, it } from "vitest";
import * as umbra from "../../src/index.js";
import {
  createClient, runMigrations, DEFAULT_SCHEMA,
  PgTemporalKV, PgCheckpointStore, PgWatermarks, PgTransactionLeaseLayer,
  PgTransactionHistoryStorage, PgWalletStateEnvelopeStore,
  saveAndAdvance, Rollback,
  StorageError, ValidationError, SerializationFailedError, ConnectionError,
  VersionConflictError, HistoryUnavailableError, TransactionKeyReuseError,
  CheckpointNotFoundError, ChunkMissingError, ChunkIntegrityError, ManifestCorruptError,
  TransactionRolledBackError, TransactionFaultError, LeaseTimeoutError, LeaseNotHeldError,
  LeaseFaultError, TransactionHandleInvalidError,
  EnvelopeVersionUnsupportedError, EnvelopeCorruptError,
  ExclusionViolationError, ClockRegressionError, UnrecognizedPostgresError,
  DurabilityContractError, TransactionPoolerDetectedError, MigrationLockTimeoutError,
} from "../../src/index.js";

/**
 * G1 / acceptance A1: every frozen name resolves when imported from the public barrel
 * (src/index.ts; compiled 1:1 to dist/index.js by `npm run build`). The named imports above are the primary link-time proof (this file fails to
 * load if any is missing); the assertions below confirm each resolves to the expected runtime
 * shape, including Rollback and the durability-probe error classes the reconciliation folded in.
 */
describe("frozen barrel: every frozen value name resolves from the built package (A1)", () => {
  it("entry points, primitives, and the co-tx combinator resolve to functions/classes", () => {
    for (const fn of [createClient, runMigrations, saveAndAdvance]) {
      expect(typeof fn).toBe("function");
    }
    expect(DEFAULT_SCHEMA).toBe("umbradb");
    for (const cls of [
      PgTemporalKV, PgCheckpointStore, PgWatermarks, PgTransactionLeaseLayer,
      PgTransactionHistoryStorage, PgWalletStateEnvelopeStore,
    ]) {
      expect(typeof cls).toBe("function");
      expect(typeof cls.prototype).toBe("object");
    }
  });

  it("the full StorageError hierarchy (base + 24 concrete codes) resolves; each concrete is a StorageError subclass", () => {
    const concreteErrorClasses = [
      ValidationError, SerializationFailedError, ConnectionError,
      VersionConflictError, HistoryUnavailableError, TransactionKeyReuseError,
      CheckpointNotFoundError, ChunkMissingError, ChunkIntegrityError, ManifestCorruptError,
      TransactionRolledBackError, TransactionFaultError, LeaseTimeoutError, LeaseNotHeldError,
      LeaseFaultError, TransactionHandleInvalidError,
      EnvelopeVersionUnsupportedError, EnvelopeCorruptError,
      ExclusionViolationError, ClockRegressionError, UnrecognizedPostgresError,
      DurabilityContractError, TransactionPoolerDetectedError, MigrationLockTimeoutError,
    ];
    expect(concreteErrorClasses).toHaveLength(24);
    expect(typeof StorageError).toBe("function");
    for (const cls of concreteErrorClasses) {
      expect(cls.prototype).toBeInstanceOf(StorageError);
    }
  });

  it("the durability-contract error classes are catchable as StorageError (caught from runMigrations)", () => {
    const dce = new DurabilityContractError("x", []);
    const tpd = new TransactionPoolerDetectedError("y");
    expect(dce).toBeInstanceOf(StorageError);
    expect(tpd).toBeInstanceOf(StorageError);
    expect(dce.code).toBe("DURABILITY_CONTRACT_VIOLATION");
    expect(tpd.code).toBe("TRANSACTION_POOLER_DETECTED");
  });

  it("Rollback is an Error subclass, NOT a StorageError, and carries no code (control primitive)", () => {
    const rb = new Rollback({ kind: "callback-requested", reason: "test" });
    expect(rb).toBeInstanceOf(Error);
    expect(rb).not.toBeInstanceOf(StorageError);
    expect((rb as unknown as { code?: unknown }).code).toBeUndefined();
  });

  it("the runtime namespace exposes exactly the 36 frozen value names (type-only exports are erased)", () => {
    expect(Object.keys(umbra).sort()).toHaveLength(36);
  });
});
