import { z } from "zod";

/**
 * Common ancestor for every typed error thrown by the storage layer
 * (TemporalKV, CheckpointStore, Watermarks, Transaction/Lease).
 */
export abstract class StorageError extends Error {
  /** Discriminant for narrowing without `instanceof` — stable across serialization. */
  abstract readonly code: string;
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = new.target.name;
  }
}

/** Codes for infrastructure failures shared by every module (design doc §1.1). */
export type SharedStorageErrorCode =
  | "VALIDATION_FAILED"
  | "SERIALIZATION_FAILED"
  | "CONNECTION_ERROR";

/**
 * Thrown when an input fails its Zod boundary schema (§1.4). Rejects before any backend
 * work happens. `issues` is the flattened Zod issue list, safe to log and serialize.
 */
export class ValidationError extends StorageError {
  readonly code = "VALIDATION_FAILED" as const;
  constructor(
    message: string,
    readonly issues: ReadonlyArray<{ readonly path: string; readonly message: string }>,
    cause?: unknown,
  ) { super(message, cause); }

  /** Canonical constructor from a ZodError at a module boundary. */
  static fromZod(boundary: string, err: z.ZodError): ValidationError {
    return new ValidationError(
      `invalid input at ${boundary}`,
      err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      err,
    );
  }
}

/** Thrown when a value fails to round-trip through the backend's encoding (JSONB/BSON). */
export class SerializationFailedError extends StorageError {
  readonly code = "SERIALIZATION_FAILED" as const;
  constructor(message: string, cause?: unknown) { super(message, cause); }
}

/** Thrown on driver-level connection failure, by any module. */
export class ConnectionError extends StorageError {
  readonly code = "CONNECTION_ERROR" as const;
  constructor(message: string, cause?: unknown) { super(message, cause); }
}
