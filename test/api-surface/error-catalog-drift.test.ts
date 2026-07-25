import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as barrel from "../../src/index.js";
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
 * G3 / acceptance C1 + C4: the published `{code -> meaning -> retryable}` catalog
 * (`docs/ERROR-CATALOG.md`) is frozen and cannot drift from the actual surface.
 *
 * The AUTHORITY on the count is this drift test, NOT a hard-coded number (design §3.1). "Surface"
 * is defined operationally as *the concrete `StorageError` subclasses re-exported from the barrel*:
 * this test enumerates them from `src/index.ts`, instantiates each to read its stable `.code` and
 * machine-readable `.retryable`, and asserts the doc's code set, class set, and per-code retryable
 * markings all equal the surface (table ≡ surface). If a future minor adds an error class to the
 * barrel, `EXPORTED_CONCRETE` grows, the instance-list guard fails, and the doc must be updated to
 * match — the number self-corrects. It is 24 today (design §3.1's 21 + the already-shipped G6/G7
 * `MIGRATION_LOCK_TIMEOUT` / `DURABILITY_CONTRACT_VIOLATION` / `TRANSACTION_POOLER_DETECTED`), but
 * no assertion hard-codes 24.
 */

// One instance of every exported concrete StorageError subclass. `.code` and `.retryable` are class
// field initializers, readable only off an instance (not off the class), so the surface must be
// instantiated. Constructor arguments are arbitrary-but-valid; they do not affect `.code`/`.retryable`.
const AS_OF = { kind: "version", version: 1n } as const;
const ROLLBACK_CAUSE = { kind: "callback-requested" } as const;

const SURFACE_INSTANCES: StorageError[] = [
  new ValidationError("m", []),
  new SerializationFailedError("m"),
  new ConnectionError("m"),
  new VersionConflictError(1n, undefined),
  new HistoryUnavailableError(AS_OF, new Date(0), 1n),
  new TransactionKeyReuseError("ns", "sc", "k"),
  new CheckpointNotFoundError("w", "n"),
  new ChunkMissingError("h"),
  new ChunkIntegrityError("h", "e"),
  new ManifestCorruptError("h", "r"),
  new TransactionRolledBackError(ROLLBACK_CAUSE),
  new TransactionFaultError("m", "connection-lost"),
  new LeaseTimeoutError("k", 10),
  new LeaseNotHeldError("k"),
  new LeaseFaultError("m", "connection-lost"),
  new TransactionHandleInvalidError("id"),
  new EnvelopeVersionUnsupportedError(2),
  new EnvelopeCorruptError("m"),
  new ExclusionViolationError("m"),
  new ClockRegressionError("m"),
  new UnrecognizedPostgresError("m"),
  new MigrationLockTimeoutError("s", 10),
  new DurabilityContractError("m", []),
  new TransactionPoolerDetectedError("m"),
];

/** The concrete StorageError subclass NAMES re-exported from the barrel (the abstract base and the
 *  non-StorageError `Rollback` are excluded). Derived purely from `src/index.ts`. */
const EXPORTED_CONCRETE: string[] = Object.entries(barrel as Record<string, unknown>)
  .filter(([, v]) => typeof v === "function"
    && v !== (StorageError as unknown)
    && (v as { prototype?: unknown }).prototype instanceof StorageError)
  .map(([name]) => name)
  .sort();

interface CatalogRow { code: string; className: string; retryable: string; }

/** Parse the `{code | class | meaning | retryable}` table out of `docs/ERROR-CATALOG.md`. A data row
 *  is any pipe row whose first cell (backticks stripped) is an ALL-CAPS code token. */
function parseCatalog(): CatalogRow[] {
  const md = readFileSync(
    fileURLToPath(new URL("../../docs/ERROR-CATALOG.md", import.meta.url)),
    "utf8",
  );
  const rows: CatalogRow[] = [];
  for (const line of md.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.replace(/`/g, "").trim());
    if (cells.length < 4) continue;
    const code = cells[0]!;
    if (!/^[A-Z][A-Z0-9_]+$/.test(code)) continue; // skips the header ("Code") and separator rows
    rows.push({ code, className: cells[1]!, retryable: cells[cells.length - 1]! });
  }
  return rows;
}

describe("frozen error-code catalog: table ≡ surface, no drift (C1, C4)", () => {
  const catalog = parseCatalog();
  const surfaceCodes = new Set(SURFACE_INSTANCES.map((e) => e.code));
  const surfaceRetryable = new Map<string, Retryability>(
    SURFACE_INSTANCES.map((e) => [e.code, e.retryable]),
  );

  it("the instantiated surface list is exactly the barrel's exported concrete StorageError subclasses", () => {
    const instanceClassNames = SURFACE_INSTANCES.map((e) => e.constructor.name).sort();
    // If this fails, an error class was added to / removed from the barrel: update SURFACE_INSTANCES
    // AND docs/ERROR-CATALOG.md to match. This is what makes the count self-correcting.
    expect(instanceClassNames).toEqual(EXPORTED_CONCRETE);
    expect(new Set(instanceClassNames).size).toBe(instanceClassNames.length); // no duplicates
  });

  it("the catalog doc's code set equals the exported surface's code set (table ≡ surface)", () => {
    const docCodes = new Set(catalog.map((r) => r.code));
    expect([...docCodes].sort()).toEqual([...surfaceCodes].sort());
    // Count is DERIVED from the surface, never hard-coded.
    expect(catalog.length).toBe(surfaceCodes.size);
    expect(docCodes.size).toBe(surfaceCodes.size);
  });

  it("the catalog doc's class set equals the exported concrete class set", () => {
    const docClasses = catalog.map((r) => r.className).sort();
    expect(docClasses).toEqual(EXPORTED_CONCRETE);
  });

  it("each catalog row's retryable marking matches the class's machine-readable field", () => {
    for (const row of catalog) {
      expect(["retryable", "non-retryable", "conditional"]).toContain(row.retryable);
      expect(row.retryable, `${row.code} retryable marking must match the surface`)
        .toBe(surfaceRetryable.get(row.code));
    }
  });

  it("the retryable set is exactly {CONNECTION_ERROR, TRANSACTION_FAULT, LEASE_TIMEOUT, MIGRATION_LOCK_TIMEOUT} (C2)", () => {
    const retryable = catalog.filter((r) => r.retryable === "retryable").map((r) => r.code).sort();
    expect(retryable).toEqual(["CONNECTION_ERROR", "LEASE_TIMEOUT", "MIGRATION_LOCK_TIMEOUT", "TRANSACTION_FAULT"]);
  });

  it("CLOCK_REGRESSION is conditional, not uniformly non-retryable (C6)", () => {
    const clock = catalog.find((r) => r.code === "CLOCK_REGRESSION");
    expect(clock?.retryable).toBe("conditional");
  });

  it("no chain-archive code appears in the frozen catalog (C3)", () => {
    for (const forbidden of [
      "CHAIN_ARCHIVE_INVARIANT_VIOLATION", "CHAIN_ARCHIVE_CHECK_VIOLATION",
      "BLOB_INTEGRITY", "BLOB_MISSING", "BLOCK_NOT_FOUND",
    ]) {
      expect(catalog.some((r) => r.code === forbidden), `${forbidden} must NOT be in the catalog`).toBe(false);
      expect(surfaceCodes.has(forbidden), `${forbidden} must NOT be on the exported surface`).toBe(false);
    }
  });

  it("the CHANGELOG and catalog prose counts equal the derived surface count (BLOCK 4: no release-facing count contradiction)", () => {
    const surfaceCount = surfaceCodes.size;
    const changelog = readFileSync(
      fileURLToPath(new URL("../../CHANGELOG.md", import.meta.url)), "utf8",
    );
    const changelogMatch = changelog.match(/catalog \((\d+) codes?\)/);
    expect(changelogMatch, "CHANGELOG must state the catalog code count as `catalog (N codes)`").not.toBeNull();
    expect(Number(changelogMatch![1]), "CHANGELOG catalog count must equal the exported surface count").toBe(surfaceCount);

    const catalogDoc = readFileSync(
      fileURLToPath(new URL("../../docs/ERROR-CATALOG.md", import.meta.url)), "utf8",
    );
    const catalogMatch = catalogDoc.match(/currently \*\*(\d+) codes\*\*/);
    expect(catalogMatch, "ERROR-CATALOG.md must state its count as `currently **N codes**`").not.toBeNull();
    expect(Number(catalogMatch![1]), "ERROR-CATALOG.md prose count must equal the exported surface count").toBe(surfaceCount);
  });
});
