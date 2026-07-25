import { describe, expect, it } from "vitest";
import {
  StorageError,
  ValidationError, SerializationFailedError, ConnectionError,
  VersionConflictError, HistoryUnavailableError, TransactionKeyReuseError,
  CheckpointNotFoundError, ChunkMissingError, ChunkIntegrityError, ManifestCorruptError,
  TransactionRolledBackError, TransactionFaultError, LeaseTimeoutError, LeaseNotHeldError,
  LeaseFaultError, TransactionHandleInvalidError,
  EnvelopeVersionUnsupportedError, EnvelopeCorruptError,
  ExclusionViolationError, ClockRegressionError, UnrecognizedPostgresError,
  DurabilityContractError, TransactionPoolerDetectedError, MigrationLockTimeoutError,
  type Retryability,
} from "../../src/index.js";

/**
 * G3 / acceptance C5 + C6: retryability is a machine-readable field on every StorageError. This
 * asserts each concrete class's `retryable` value matches the frozen catalog (design §3.1 plus the
 * G6/G7 reconciliation additions), that CLOCK_REGRESSION is "conditional" (not uniformly
 * non-retryable), and that CONNECTION_ERROR / TRANSACTION_FAULT / LEASE_TIMEOUT are retryable.
 *
 * The frozen 1.0.0 exported StorageError code set is 24 (design §3.1's 21 + the already-shipped
 * MIGRATION_LOCK_TIMEOUT, DURABILITY_CONTRACT_VIOLATION, TRANSACTION_POOLER_DETECTED from G6/G7).
 */

const AS_OF = { kind: "version", version: 1n } as const;
const ROLLBACK_CAUSE = { kind: "callback-requested" } as const;

interface Row {
  instance: StorageError;
  code: string;
  retryable: Retryability;
}

const TABLE: Row[] = [
  { instance: new ValidationError("m", []), code: "VALIDATION_FAILED", retryable: "non-retryable" },
  { instance: new SerializationFailedError("m"), code: "SERIALIZATION_FAILED", retryable: "non-retryable" },
  { instance: new ConnectionError("m"), code: "CONNECTION_ERROR", retryable: "retryable" },
  { instance: new VersionConflictError(1n, undefined), code: "VERSION_CONFLICT", retryable: "non-retryable" },
  { instance: new HistoryUnavailableError(AS_OF, new Date(0), 1n), code: "HISTORY_UNAVAILABLE", retryable: "non-retryable" },
  { instance: new TransactionKeyReuseError("ns", "sc", "k"), code: "TRANSACTION_KEY_REUSE", retryable: "non-retryable" },
  { instance: new CheckpointNotFoundError("w", "n"), code: "NOT_FOUND", retryable: "non-retryable" },
  { instance: new ChunkMissingError("h"), code: "CHUNK_MISSING", retryable: "non-retryable" },
  { instance: new ChunkIntegrityError("h", "e"), code: "CHUNK_INTEGRITY", retryable: "non-retryable" },
  { instance: new ManifestCorruptError("h", "r"), code: "MANIFEST_CORRUPT", retryable: "non-retryable" },
  { instance: new TransactionRolledBackError(ROLLBACK_CAUSE), code: "TRANSACTION_ROLLED_BACK", retryable: "non-retryable" },
  { instance: new TransactionFaultError("m", "connection-lost"), code: "TRANSACTION_FAULT", retryable: "retryable" },
  { instance: new LeaseTimeoutError("k", 10), code: "LEASE_TIMEOUT", retryable: "retryable" },
  { instance: new LeaseNotHeldError("k"), code: "LEASE_NOT_HELD", retryable: "non-retryable" },
  { instance: new LeaseFaultError("m", "connection-lost"), code: "LEASE_FAULT", retryable: "non-retryable" },
  { instance: new TransactionHandleInvalidError("id"), code: "TRANSACTION_HANDLE_INVALID", retryable: "non-retryable" },
  { instance: new EnvelopeVersionUnsupportedError(2), code: "VERSION_UNSUPPORTED", retryable: "non-retryable" },
  { instance: new EnvelopeCorruptError("m"), code: "CORRUPT", retryable: "non-retryable" },
  { instance: new ExclusionViolationError("m"), code: "EXCLUSION_VIOLATION", retryable: "non-retryable" },
  { instance: new ClockRegressionError("m"), code: "CLOCK_REGRESSION", retryable: "conditional" },
  { instance: new UnrecognizedPostgresError("m"), code: "UNRECOGNIZED_POSTGRES_ERROR", retryable: "non-retryable" },
  { instance: new MigrationLockTimeoutError("s", 10), code: "MIGRATION_LOCK_TIMEOUT", retryable: "retryable" },
  { instance: new DurabilityContractError("m", []), code: "DURABILITY_CONTRACT_VIOLATION", retryable: "non-retryable" },
  { instance: new TransactionPoolerDetectedError("m"), code: "TRANSACTION_POOLER_DETECTED", retryable: "non-retryable" },
];

describe("retryability is a machine-readable field on every StorageError (C5, C6)", () => {
  it("covers exactly the 24 frozen codes, each unique", () => {
    expect(TABLE).toHaveLength(24);
    expect(new Set(TABLE.map((r) => r.code)).size).toBe(24);
  });

  it("every concrete class exposes a machine-readable retryable value matching the frozen table (no message parsing)", () => {
    for (const row of TABLE) {
      expect(row.instance, `${row.code} must be a StorageError`).toBeInstanceOf(StorageError);
      expect(row.instance.code, "code must match the frozen table").toBe(row.code);
      expect(["retryable", "non-retryable", "conditional"]).toContain(row.instance.retryable);
      expect(row.instance.retryable, `${row.code} retryable mismatch`).toBe(row.retryable);
    }
  });

  it("CONNECTION_ERROR, TRANSACTION_FAULT, LEASE_TIMEOUT, MIGRATION_LOCK_TIMEOUT are the retryable set (C2)", () => {
    const retryable = TABLE.filter((r) => r.instance.retryable === "retryable").map((r) => r.code).sort();
    expect(retryable).toEqual(["CONNECTION_ERROR", "LEASE_TIMEOUT", "MIGRATION_LOCK_TIMEOUT", "TRANSACTION_FAULT"]);
  });

  it("CLOCK_REGRESSION is conditional, not uniformly non-retryable (C6)", () => {
    const clock = TABLE.find((r) => r.code === "CLOCK_REGRESSION");
    expect(clock?.instance.retryable).toBe("conditional");
    expect(clock?.instance.retryable).not.toBe("non-retryable");
  });

  it("an in-transaction connection loss surfaces a retryable TransactionFaultError(connection-lost) (recovery C1 reconciliation)", () => {
    const fault = new TransactionFaultError("connection lost mid-transaction", "connection-lost");
    expect(fault.code).toBe("TRANSACTION_FAULT");
    expect(fault.faultKind).toBe("connection-lost");
    expect(fault.retryable).toBe("retryable");
  });
});
