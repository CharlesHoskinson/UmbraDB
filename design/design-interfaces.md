# Storage Layer Interface Specification

Consolidates four independently-designed modules — **TemporalKV**, **CheckpointStore**,
**Watermarks**, and the **Transaction/Lease layer** — into one interface family with a single
error-handling idiom, a single async/validation/naming convention, and explicit cross-references
between modules.

Each module below is unchanged in its *domain* design (what it stores, how it's keyed, its
concurrency semantics) from the original four documents. What changed is exclusively the
*shape* of the contract: error handling, the transaction-handle type, and validation wiring, so
that a caller composing several of these modules in one code path uses one mental model
throughout instead of several. (Note, per §4's composition audit: production `wallet-sync`
today actually composes three of the four — `CheckpointStore`, `Watermarks`, and
`Transaction/Lease` — not all four; `TemporalKV` is a general-purpose module in this family
without a named production consumer yet, see §4's closing note.)

---

## 1. Shared Conventions

### 1.1 Error handling — one idiom: thrown, `code`-discriminated typed errors

**Decision:** every module rejects its promises with a typed `Error` subclass carrying a
`readonly code: string` discriminant, rooted in one common base:

```typescript
// storage-errors.ts — shared by all four modules
export abstract class StorageError extends Error {
  /** Discriminant for narrowing without `instanceof` (useful across an RPC/IPC boundary
   *  where the concrete class doesn't survive serialization). */
  abstract readonly code: string;
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = new.target.name;
  }
}
```

The error family has two tiers, both rooted in `StorageError`:

- **Shared infrastructure errors**, defined once in `storage-errors.ts` (§2):
  `ConnectionError` (driver-level connection failure), `SerializationFailedError` (a value
  failed to round-trip through the backend encoding), and `ValidationError` (an input failed
  its Zod boundary schema, §1.4). Any module may throw these; they are *not* re-minted
  per-module, so there is exactly one class per infrastructure failure mode across the layer.
- **Module domain errors**: each module defines its own closed `code` union and an abstract
  `<Module>Error extends StorageError`, then one concrete subclass per *domain-specific*
  failure mode (Prisma's pattern — the same one `TemporalKV` and `CheckpointStore` already
  used). Module error hierarchies cover only failures that mean something in that module's
  domain (`VersionConflictError`, `ChunkIntegrityError`, `LeaseTimeoutError`); infrastructure
  faults always surface as the shared classes.

**What changed and why:** the original **Transaction/Lease layer** used a different idiom —
discriminated-union *return values* (`TransactionOutcome<T>`, `LeaseAcquireResult`) for
"expected, routine" outcomes (lock contention, timeout, rollback), reserving thrown errors only
for genuine infrastructure faults. That design is well-reasoned in isolation: it forces callers
to exhaustively handle contention at compile time. But it means a caller working across modules
needs two different failure-handling reflexes in the same function — `try/catch` for
`TemporalKV.put`'s version conflict, but `switch (result.status)` for `acquireLease`. That
seam is exactly the kind of cross-module inconsistency this consolidation exists to remove.

We collapsed the Transaction/Lease layer onto the throw-typed-error idiom used everywhere else:
`TransactionOutcome`'s `rolledBack` and `failed` variants became `TransactionRolledBackError`
and `TransactionFaultError`; `LeaseAcquireResult`'s `timeout` / `held-by-other` / `error`
variants became `LeaseTimeoutError`, `LeaseHeldByOtherError`, `LeaseFaultError`. The trade-off
is real — call sites lose the compiler-enforced exhaustiveness switch gave them for lock
contention. Two things keep that loss contained. First, every module now shares one catch
pattern:

```typescript
try {
  await store.put(ns, scope, key, value, { expectedVersion });
} catch (e) {
  if (e instanceof VersionConflictError) { /* retry */ }
  else if (e instanceof StorageError) { /* log e.code, one branch handles all four modules */ }
  else throw e; // programmer error, not a domain outcome
}
```

Second, because lease contention is a *routine* control-flow branch — the single hottest
"expected failure" in a multi-writer sync environment — the layer provides
`tryAcquireLease(key, opts): Promise<Lease | null>` (§3.1) as a non-throwing companion:
contention and timeout resolve `null`, exactly mirroring how `get` resolves `null` for a
missing key. The hot path never pays the `try/catch` tax; only genuine faults throw. This adds
no second idiom — it *is* the existing "absence is data" convention, applied to contention.

`Rollback` (thrown *inside* a `withTransaction` callback to request a deliberate rollback,
distinct from `TransactionRolledBackError` which the *caller* of `withTransaction` catches)
keeps its role as an intentional escape hatch rather than an accidental error.

**Absence is not an error — with one deliberate, named exception.** `TemporalKV.get`/`getAt` and
`Watermarks.get` return `null`/`undefined` for a missing key; they never throw for "not found."
`CheckpointStore.load` is the one method that throws `CheckpointNotFoundError` instead. This is
kept, not normalized away, because it tracks a real semantic difference: `get`/`getAt` are
*lookups* (the caller is often checking whether something exists), while `load` *materializes* a
specific, expected resource (you asked for checkpoint N because you know it should exist, or for
"the latest," which the interface promises always exists once `save` has been called once). The
convention going forward: **name a method `get*`/`list*` if absence is a normal outcome (return
`null`/`undefined`/empty); name it `try*` if a routine, contended outcome resolves `null`
(e.g. `tryAcquireLease`); name it `load`/`fetch` if absence means something is wrong (throw a
`*NotFoundError`).**

### 1.2 Async pattern

Every method is `Promise`-returning `async`; nothing in this storage layer uses callbacks or
observables. The one exception is `TemporalKV.listKeys`, which returns `AsyncIterable<Key>` —
kept as-is, because it's in-process streaming (feeding a sync loop) rather than a paginated
network response; `CheckpointStore.history` deliberately stays a plain `Promise<Array>` since
checkpoint counts per wallet are bounded (tens, not millions) and an iterator would add ceremony
with no benefit. This asymmetry is intentional, not an inconsistency to fix.

**Cancellation.** Every options bag accepts an optional `signal?: AbortSignal`. When the signal
aborts, the method rejects with the runtime's standard `AbortError` `DOMException`
(`e.name === "AbortError"`) — never with a `StorageError`, because cancellation is the caller's
own act, not a storage failure, and it must not be swallowed by a generic
`instanceof StorageError` branch. Implementations must release whatever was acquired before
rejecting: an in-flight transaction rolls back, a lease acquired before the abort is released,
a `listKeys` iteration stops and frees its cursor, and a mid-flight `CheckpointStore.load`
abandons chunk fetches. An abort observed *after* commit/acquisition completes is a no-op — the
method resolves normally rather than pretending the durable effect didn't happen.

### 1.3 Transaction participation

All four modules accept an optional `tx` handle so a caller can compose a multi-module write into
one atomic unit via the Transaction/Lease layer:

```typescript
opts?: { tx?: TransactionHandle }
```

**What changed:** `TemporalKV` originally defined its own opaque `TxContext` brand
(`{ readonly __txBrand: unique symbol }`); it now imports the canonical `TransactionHandle` from
the Transaction/Lease module instead of minting its own — there is exactly one transaction-handle
type in the storage layer. `Watermarks.set`/`get` did not originally accept a `tx` option at all;
it's added here so a caller can, for instance, update a sync-progress watermark in the same
transaction as the `CheckpointStore.save` it accompanies. `CheckpointStore.save`/`prune` remain
**without** a `tx` parameter — that asymmetry is preserved deliberately (see §3.3): each is
already a full, internally-atomic unit of work, and exposing a transaction handle there would let
a caller compose checkpoint writes into a larger transaction that spans the content-addressed
chunk GC, which the original design explicitly scoped as internal plumbing, not API surface.

### 1.4 Runtime validation

Zod v4 schemas are the single source of truth for the *data* fields of every module boundary:
the schema is defined once and the TypeScript type is `z.infer`'d from it, and
`z.toJSONSchema(...)` gives a portable contract doc for non-TS consumers. A failed boundary
validation rejects with the shared `ValidationError` (§2) *before* any backend work happens —
malformed input fails at the interface, not by corrupting a write three layers down.

Two precise rules keep the "schema is the source of truth" claim honest rather than aspirational:

1. **Live handles are not data.** `TransactionHandle`, `Lease`, and `AbortSignal` are
   compile-time-typed capability handles: they never cross a serialization boundary and cannot
   meaningfully appear in a JSON-schema export. Options bags therefore split into a Zod-defined
   data part and a handle part intersected onto the inferred type:

   ```typescript
   export const LeaseAcquireOptionsSchema = z.object({ timeoutMs: ..., ttlMs: ... });
   export type LeaseAcquireOptions = z.infer<typeof LeaseAcquireOptionsSchema> & {
     signal?: AbortSignal;
   };
   ```

   The schema validates the data fields; handles are type-checked only. This applies uniformly:
   `TransactionOptions`, `LeaseAcquireOptions`, `SaveCheckpointOptions`, `HistoryOptions`, and
   the Watermarks value schema are all Zod-first with types derived by `z.infer`.

2. **Generic interfaces are the one derivation exception, and it is guarded.**
   `TemporalKV.VersionedEntry<T>` is generic in its `value` type; a single runtime schema can
   only validate the erased shape (`value: JsonValue`), so the generic declaration is
   hand-written — but it is pinned to the schema by a compile-time assertion
   (`type _InSync = z.infer<typeof VersionedEntrySchema> extends VersionedEntry ? true : never`)
   so the two cannot drift silently. Every non-generic type in the layer (including `JsonValue`,
   via Zod v4's built-in `z.json()`, and `WatermarkValue`) is derived by `z.infer` with no
   hand-written duplicate.

### 1.5 Naming

- **Identifier vocabulary is domain-specific by design, not gratuitously inconsistent.**
  `namespace/scope/key` (TemporalKV), `kind/key` (Watermarks), `walletId/networkId` (CheckpointStore)
  and `key` (Lease) name genuinely different things — TemporalKV is a 3-level generic KV store,
  Watermarks is 2-level because it has no "scope" concept, CheckpointStore's identity is a wallet
  in a network, and a lease key is a free-form lock name. Forcing one shared vocabulary here would
  paper over real domain differences, so it is intentionally left alone.
- **Options bags always come last, always named `opts`**, always optional, always the only place a
  `tx` handle or an `AbortSignal` appears. No method takes a transaction handle as a positional
  argument.
- **Error classes**: shared infrastructure errors (`ConnectionError`,
  `SerializationFailedError`, `ValidationError`) are defined exactly once in
  `storage-errors.ts` and thrown by any module; module-specific errors extend a
  `<Module>Error` abstract base (itself extending `StorageError`) and are named
  `<Failure>Error`, each with a `readonly code: "SCREAMING_SNAKE_CASE"` literal matching its
  module's `<Module>ErrorCode` union. Concrete error-class names are **unique across the whole
  storage layer** (they share one barrel export) — which is precisely why common infrastructure
  failures are hoisted to the shared module instead of each module minting its own
  `<Module>ConnectionError` variant. Every field on every error class is `readonly`.

---

## 2. `storage-errors.ts` — shared base (new file)

```typescript
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

/** Codes for infrastructure failures shared by every module (§1.1). */
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
```

These three concrete classes are the *only* errors defined outside a module: they represent
failures every backend shares. Module hierarchies (§3) contain domain failures only, so no
failure mode is ever represented by two differently-named classes in two modules.

---

## 3. Module Interfaces

### 3.1 Transaction/Lease layer

**STALE, superseded by the shipped interface — found by a Sprint 2 cross-vendor audit.** This
section predates a later revision that REMOVED TTL/lease-stealing/fencing entirely (a
cross-vendor audit found the original design made the mutual-exclusion guarantee, Law L1,
impossible for arbitrary caller code — see `src/interfaces/transaction-lease.ts`'s own revision
note, the actual, authoritative source). Concretely stale below: `ttlMs`, `Lease.expiresAt`,
`LeaseHeldByOtherError` (replaced by `LeaseTimeoutError` for `acquireLease` / `null` for
`tryAcquireLease`), and "release failures are logged" (this project has no logging
infrastructure; they are swallowed instead — see the shipped interface's own JSDoc). Treat this
section as historical context for HOW the design evolved, not as the current contract; the
current contract lives in `src/interfaces/transaction-lease.ts` and
`openspec/changes/sprint-2-transaction-lease/`.

```typescript
import { z } from "zod";
import { StorageError } from "./storage-errors";

/**
 * Transaction/Lease layer — implementation-agnostic contract.
 * Backed by `sql.begin()` (transactions) and `sql.reserve()` + advisory locks (leases) in the
 * Postgres adapter; this file contains no `pg`-specific types.
 */

// ---------------------------------------------------------------------------
// Shared opaque handles
// ---------------------------------------------------------------------------

/** Opaque handle for an in-flight transaction. Pass to any storage-layer method that accepts
 *  `opts.tx` to participate in the same transaction. This is the ONE transaction-handle type
 *  in the storage layer — TemporalKV, CheckpointStore, and Watermarks all import it rather than
 *  defining their own. */
export interface TransactionHandle {
  readonly __brand: "TransactionHandle";
  readonly id: string;
}

/** Opaque proof of a held writer lease (advisory lock pinned to a reserved connection). */
export interface Lease {
  readonly __brand: "Lease";
  readonly key: string;
  /** Unique per acquisition; lets releaseLease reject a stale/duplicate release. */
  readonly token: string;
  readonly acquiredAt: Date;
  /** `null` = held until explicit release or connection death (no TTL). */
  readonly expiresAt: Date | null;
}

// ---------------------------------------------------------------------------
// Typed error hierarchy
// ---------------------------------------------------------------------------

export type TransactionLeaseErrorCode =
  | "TRANSACTION_ROLLED_BACK"
  | "TRANSACTION_FAULT"
  | "LEASE_TIMEOUT"
  | "LEASE_HELD_BY_OTHER"
  | "LEASE_NOT_HELD"
  | "LEASE_FAULT";

export abstract class TransactionLeaseError extends StorageError {
  abstract readonly code: TransactionLeaseErrorCode;
}

/** Thrown by {@link TransactionLeaseLayer.withTransaction} when the callback requested a
 *  rollback via {@link Rollback}. Distinct from a driver-level fault. */
export class TransactionRolledBackError extends TransactionLeaseError {
  readonly code = "TRANSACTION_ROLLED_BACK" as const;
  constructor(readonly rollbackCause: TransactionRollbackCause) {
    super(`transaction rolled back: ${rollbackCause.kind}`);
  }
}

/** Thrown when a transaction fails for infrastructure reasons — connection loss, a
 *  serialization failure under `serializable` isolation, deadlock, or a statement timeout. */
export class TransactionFaultError extends TransactionLeaseError {
  readonly code = "TRANSACTION_FAULT" as const;
  constructor(
    message: string,
    readonly faultKind: "connection-lost" | "serialization-failure" | "deadlock" | "timeout" | "unknown",
    cause?: unknown,
  ) { super(message, cause); }
}

/** Thrown by {@link TransactionLeaseLayer.acquireLease}/{@link TransactionLeaseLayer.withLease}
 *  when the lock could not be acquired within `opts.timeoutMs`. */
export class LeaseTimeoutError extends TransactionLeaseError {
  readonly code = "LEASE_TIMEOUT" as const;
  constructor(readonly key: string, readonly waitedMs: number) {
    super(`timed out after ${waitedMs}ms waiting for lease "${key}"`);
  }
}

/** Thrown when a lease is held by another writer and no (or an exhausted) timeout was given. */
export class LeaseHeldByOtherError extends TransactionLeaseError {
  readonly code = "LEASE_HELD_BY_OTHER" as const;
  constructor(readonly key: string, readonly ownerHint?: string) {
    super(`lease "${key}" is held by another writer${ownerHint ? ` (${ownerHint})` : ""}`);
  }
}

/** Thrown by {@link TransactionLeaseLayer.releaseLease} when the lease was already released,
 *  expired, or stolen — releasing twice is routine under contention, not a bug, but the caller
 *  is still told so via a distinct, catchable error rather than a silent no-op. */
export class LeaseNotHeldError extends TransactionLeaseError {
  readonly code = "LEASE_NOT_HELD" as const;
  constructor(readonly key: string) {
    super(`lease "${key}" was not held (expired, stolen, or already released)`);
  }
}

/** Thrown on connection loss / reservation failure while acquiring or releasing a lease. */
export class LeaseFaultError extends TransactionLeaseError {
  readonly code = "LEASE_FAULT" as const;
  constructor(
    message: string,
    readonly faultKind: "connection-lost" | "reserve-failed" | "unknown",
    cause?: unknown,
  ) { super(message, cause); }
}

/**
 * Thrown *inside* a `withTransaction` callback to request a deliberate rollback.
 * `withTransaction` catches this specifically and rejects with
 * {@link TransactionRolledBackError} — rollback is a controlled, named outcome, not an
 * escaped exception the caller must intuit from a generic `Error`.
 */
export class Rollback extends Error {
  constructor(readonly rollbackCause: TransactionRollbackCause) {
    super(`transaction rollback requested: ${rollbackCause.kind}`);
    this.name = "Rollback";
  }
}

export type TransactionRollbackCause =
  | { kind: "callback-requested"; reason?: string }
  | { kind: "constraint-violation"; code: string; detail?: string }
  | { kind: "lease-lost"; key: string };

// ---------------------------------------------------------------------------
// Options — Zod-first, per §1.4 (data fields in the schema; live handles intersected on)
// ---------------------------------------------------------------------------

export const TransactionOptionsSchema = z.object({
  isolation: z.enum(["read committed", "repeatable read", "serializable"]).optional(),
  /** Statement/transaction timeout; a timeout surfaces as {@link TransactionFaultError}. */
  timeoutMs: z.number().int().positive().optional(),
});
export type TransactionOptions = z.infer<typeof TransactionOptionsSchema> & {
  /** Cancellation, per §1.2: abort rolls back and rejects with `AbortError`. */
  signal?: AbortSignal;
};

export const LeaseAcquireOptionsSchema = z.object({
  /** Give up after this long waiting for the lock: {@link LeaseTimeoutError} from
   *  `acquireLease`/`withLease`, `null` from `tryAcquireLease`. */
  timeoutMs: z.number().int().positive().optional(),
  /** Optional self-expiry so a crashed holder doesn't wedge the lock forever. Requires the
   *  lease bookkeeping table (see implementation notes below) — advisory locks alone have
   *  no TTL concept. */
  ttlMs: z.number().int().positive().optional(),
});
export type LeaseAcquireOptions = z.infer<typeof LeaseAcquireOptionsSchema> & {
  /** Cancellation, per §1.2: abort while waiting rejects with `AbortError`; if the lock was
   *  already acquired when the abort lands, the lease is released before rejecting. */
  signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// The layer's public surface
// ---------------------------------------------------------------------------

export interface TransactionLeaseLayer {
  /**
   * Runs `fn` inside a database transaction and resolves with its return value on commit.
   * @throws {ValidationError} if `opts` fails {@link TransactionOptionsSchema}.
   * @throws {TransactionRolledBackError} if `fn` threw {@link Rollback}.
   * @throws {TransactionFaultError} on connection loss, serialization failure, deadlock, or
   *   statement timeout.
   * Any other error thrown by `fn` propagates unchanged — treat it as a programmer error, not
   * a domain outcome.
   */
  withTransaction<T>(
    fn: (tx: TransactionHandle) => Promise<T>,
    opts?: TransactionOptions,
  ): Promise<T>;

  /**
   * Acquires the writer lease identified by `key` (one advisory lock per logical writer role,
   * e.g. `wallet-sync:{networkId}`).
   * @throws {LeaseTimeoutError} if the lock could not be acquired within `opts.timeoutMs`.
   * @throws {LeaseHeldByOtherError} if another writer holds it and no timeout resolves that.
   * @throws {LeaseFaultError} on connection loss or reservation failure.
   */
  acquireLease(key: string, opts?: LeaseAcquireOptions): Promise<Lease>;

  /**
   * Non-throwing companion to {@link TransactionLeaseLayer.acquireLease} for the routine
   * contention hot path (§1.1): resolves `null` if the lease is held by another writer or if
   * `opts.timeoutMs` elapses — contention is data here, mirroring `get`'s `null` for a
   * missing key. Prefer this in retry/poll loops; reserve `acquireLease` for call sites where
   * failing to get the lock is genuinely exceptional.
   * @throws {LeaseFaultError} on connection loss or reservation failure — infrastructure
   *   faults still throw; only contention resolves `null`.
   */
  tryAcquireLease(key: string, opts?: LeaseAcquireOptions): Promise<Lease | null>;

  /**
   * Releases a previously acquired lease.
   * @throws {LeaseNotHeldError} if the lease was already released, expired, or stolen.
   * @throws {LeaseFaultError} on connection loss.
   */
  releaseLease(lease: Lease): Promise<void>;

  /**
   * Convenience combinator: acquire → run `fn` → always release, even on throw.
   * Prefer this over manual `acquireLease`/`releaseLease` pairs.
   * @throws Same as {@link TransactionLeaseLayer.acquireLease}; if `fn` throws, that error
   *   propagates after the lease is released (release failures are logged, not thrown, so they
   *   never mask the caller's real error).
   */
  withLease<T>(
    key: string,
    fn: (lease: Lease) => Promise<T>,
    opts?: LeaseAcquireOptions,
  ): Promise<T>;
}
```

**Design rationale (kept from the original, with the error-idiom change noted in §1.1).** A
writer-lease timeout and a transaction rollback are expected, routine outcomes in a multi-writer
sync environment (indexer restarts, contended advisory locks) — that observation still holds. What
changed is *how* the caller is told: a `code`-discriminated typed error instead of a `status`
field on a return value, so this module speaks the same idiom as the other three, with
`tryAcquireLease` preserving an allocation-free, non-throwing path for the contention case.
`Rollback` still makes rollback explicit and data-like rather than a driver-fault lookalike;
`TransactionHandle` and `Lease` remain opaque, branded, implementation-agnostic types so no `pg`
type ever crosses the boundary.

**Implementation notes (normative for the Postgres adapter).** Native advisory locks cover
mutual exclusion and release-on-connection-death, but *not* everything this interface promises,
and the gap must be closed explicitly rather than assumed:

- Advisory locks key on a `bigint`, not text: implementations derive the lock id from the lease
  `key` string deterministically (e.g. the first 8 bytes of `sha256(key)` as a signed 64-bit
  integer) and must document the hash so independent writers agree on it.
- `Lease.token`, `Lease.expiresAt`, `ttlMs`, and `LeaseNotHeldError`'s ability to distinguish
  "expired / stolen / already released" all exceed what the lock primitive carries. They
  require a **lease bookkeeping table** (`lease_key`, `token`, `acquired_at`, `expires_at`,
  `owner_hint`) maintained in the same transaction as lock acquisition/release: `releaseLease`
  validates the token against the row before unlocking, and TTL expiry is enforced by
  acquirers treating a row past `expires_at` as stealable. Without `ttlMs`, connection death
  remains the only implicit release.

---

### 3.2 TemporalKV

```typescript
import { z } from "zod";
import {
  ConnectionError, SerializationFailedError, StorageError, ValidationError,
} from "./storage-errors";
import type { TransactionHandle } from "./transaction-lease";

/**
 * A JSON-serializable value — the only value shape TemporalKV accepts, since both the
 * Postgres JSONB and Mongo BSON backends must round-trip it losslessly.
 * Schema-first per §1.4: `z.json()` is Zod v4's built-in recursive JSON-value schema, and the
 * type is derived from it — there is no hand-written duplicate.
 */
export const JsonValueSchema = z.json();
export type JsonValue = z.infer<typeof JsonValueSchema>;

export type Namespace = string;
export type Scope = string;
export type Key = string;

/** Monotonic logical version, scoped to a single (namespace, scope, key) triple. */
export type Version = bigint;

/** Runtime schema for the erased shape of {@link VersionedEntry} — validated on every read
 *  boundary. The generic interface below is the §1.4 "generic exception": hand-written because
 *  `z.infer` cannot express the type parameter, but pinned to this schema by the compile-time
 *  guard that follows it. */
export const VersionedEntrySchema = z.object({
  namespace: z.string().min(1).max(63),
  scope: z.string().min(1).max(63),
  key: z.string().min(1),
  value: JsonValueSchema,
  version: z.bigint().nonnegative(),
  writtenAt: z.date(),
});

/** A single versioned record as returned by reads. */
export interface VersionedEntry<T extends JsonValue = JsonValue> {
  readonly namespace: Namespace;
  readonly scope: Scope;
  readonly key: Key;
  readonly value: T;
  readonly version: Version;
  readonly writtenAt: Date;
}

// Compile-time sync guard (§1.4): fails to typecheck if schema and interface drift apart.
type _VersionedEntryInSync =
  z.infer<typeof VersionedEntrySchema> extends VersionedEntry ? true : never;

/**
 * Point-in-time selector for {@link TemporalKV.getAt}. `version` addresses the store's own
 * logical clock (cheap on both backends). `at` addresses wall-clock time — implementations
 * MUST maintain a per-record wall-clock validity interval with a supporting index (Postgres:
 * a `[valid_from, valid_to)` tstzrange column with a GiST index, distinct from the version
 * interval; Mongo: a revision-timestamp index) so that resolving `{ at }` is an index lookup,
 * never a sequential scan over history.
 */
export type AsOf = { readonly version: Version } | { readonly at: Date };

export type TemporalKVErrorCode = "VERSION_CONFLICT";

/** Base class for TemporalKV's domain failures. Infrastructure failures — connection loss,
 *  encoding round-trip failure, boundary validation — surface as the shared
 *  {@link ConnectionError} / {@link SerializationFailedError} / {@link ValidationError}
 *  (§1.1), not module-local copies. Note: absence of a key is NOT modeled here — `get`/`getAt`
 *  return `null`, per the storage-layer-wide "lookup vs. load" convention (§1.1). */
export abstract class TemporalKVError extends StorageError {
  abstract readonly code: TemporalKVErrorCode;
}

/** Thrown by {@link TemporalKV.put} when `expectedVersion` doesn't match the current version.
 *  `actual` is `undefined` when the key has never been written at all — i.e. the CAS failed
 *  because a nonzero `expectedVersion` was passed for a missing key. `actual === 0n` never
 *  occurs (versions start at 1); the two cases are not conflated. */
export class VersionConflictError extends TemporalKVError {
  readonly code = "VERSION_CONFLICT" as const;
  constructor(readonly expected: Version, readonly actual: Version | undefined) {
    super(`expected version ${expected}, found ${actual ?? "none (key never written)"}`);
  }
}

export interface TemporalKV {
  /**
   * Writes `value` for (namespace, scope, key), creating a new version.
   * @param expectedVersion - optimistic-concurrency guard; omit for unconditional write,
   *   pass the last-read version to CAS, or `0n` to require the key not already exist.
   * @throws {ValidationError} if inputs fail their boundary schemas.
   * @throws {VersionConflictError} if `expectedVersion` is stale.
   * @throws {SerializationFailedError} if `value` cannot be round-tripped.
   * @throws {ConnectionError} on driver-level failure.
   */
  put<T extends JsonValue>(
    namespace: Namespace, scope: Scope, key: Key, value: T,
    opts?: { expectedVersion?: Version; tx?: TransactionHandle; signal?: AbortSignal },
  ): Promise<VersionedEntry<T>>;

  /** Latest version of a key, or `null` if it has never been written. */
  get<T extends JsonValue = JsonValue>(
    namespace: Namespace, scope: Scope, key: Key,
    opts?: { tx?: TransactionHandle; signal?: AbortSignal },
  ): Promise<VersionedEntry<T> | null>;

  /** The version of a key as of `asOf`, or `null` if none existed yet at that point.
   *  See {@link AsOf} for the index the `{ at }` variant requires of implementations. */
  getAt<T extends JsonValue = JsonValue>(
    namespace: Namespace, scope: Scope, key: Key, asOf: AsOf,
    opts?: { tx?: TransactionHandle; signal?: AbortSignal },
  ): Promise<VersionedEntry<T> | null>;

  /** Streams keys under `prefix`, newest-version-only, in a stable order for resumable
   *  pagination. In-process iteration (§1.2) — not a network-paginated cursor. Aborting
   *  `opts.signal` stops iteration and frees the underlying cursor (§1.2). */
  listKeys(
    namespace: Namespace, scope: Scope, prefix: string,
    opts?: { tx?: TransactionHandle; signal?: AbortSignal },
  ): AsyncIterable<Key>;
}
```

**What changed from the original:** `TxContext` (a locally-defined opaque brand) is replaced by
the shared `TransactionHandle` from the Transaction/Lease module (§1.3); the reserved-but-unused
`NOT_FOUND` code was dropped from `TemporalKVErrorCode` since no method throws it and the
convention (§1.1) now makes that explicit instead of implicit; the module-local
`SerializationFailedError`/`ConnectionError` classes moved to the shared `storage-errors.ts`
(§2), leaving `VersionConflictError` as this module's only domain error; `JsonValue` and the
`VersionedEntry` schema are now schema-first per §1.4 instead of hand-duplicated. Everything
else — the `put`/`get`/`getAt`/`listKeys` surface, `AsOf`, optimistic concurrency via
`expectedVersion` — is unchanged.

**Runtime validation** (per §1.4): Zod v4 as source of truth, validated at the module boundary
only — inputs to `put` (against `JsonValueSchema` and the key-component constraints in
`VersionedEntrySchema`), outputs of `get*` (against `VersionedEntrySchema`). Failures reject
with the shared `ValidationError`.

---

### 3.3 CheckpointStore

```typescript
import { z } from "zod";
import { StorageError, ValidationError } from "./storage-errors";

/** Sequence numbers are monotonic per (walletId, networkId) and start at 1. */
export type CheckpointSequence = number;

/** SHA-256 hex digest of a chunk or manifest's canonical byte content. */
export type ContentHash = string;

export const SaveCheckpointOptionsSchema = z.object({
  /** Target chunk size in bytes; implementations may round up to their own boundary. */
  chunkSize: z.number().int().positive().max(16 * 1024 * 1024).optional(),
  /** Free-text label surfaced in history(), e.g. "pre-migration". */
  label: z.string().max(200).optional(),
});
export type SaveCheckpointOptions = z.infer<typeof SaveCheckpointOptionsSchema> & {
  signal?: AbortSignal;
};

export const HistoryOptionsSchema = z.object({
  limit: z.number().int().positive().max(1000).default(50),
  /** Return only checkpoints strictly older than this sequence (cursor paging). */
  before: z.number().int().positive().optional(),
});
export type HistoryOptions = z.infer<typeof HistoryOptionsSchema> & {
  signal?: AbortSignal;
};

/** Identity + integrity metadata for a saved checkpoint, without its payload. */
export interface CheckpointSummary {
  sequence: CheckpointSequence;
  manifestHash: ContentHash;
  byteLength: number;
  chunkCount: number;
  label?: string;
  createdAt: Date;
}

/** A summary plus the reconstructed payload. */
export interface CheckpointRecord extends CheckpointSummary {
  data: Uint8Array;
  /** True if every chunk's rehashed content matched its manifest entry. */
  integrityVerified: boolean;
}

export interface PruneResult {
  prunedSequences: CheckpointSequence[];
  /** Chunks physically deleted because this prune removed their last remaining reference
   *  anywhere in the store — across ALL wallets and networks, not just this one. Chunk
   *  storage is globally content-addressed and shared (see interface doc), so a chunk still
   *  referenced by another wallet's manifest is never reclaimed, and this count can be zero
   *  even when many checkpoints were pruned. */
  reclaimedChunks: number;
  reclaimedBytes: number;
}

export type CheckpointStoreErrorCode = "NOT_FOUND" | "CHUNK_INTEGRITY" | "MANIFEST_CORRUPT";

export abstract class CheckpointStoreError extends StorageError {
  abstract readonly code: CheckpointStoreErrorCode;
}

/** Thrown by {@link CheckpointStore.load} — the one method in this storage layer where
 *  absence is an error rather than a `null` return; see §1.1's "lookup vs. load" rule. */
export class CheckpointNotFoundError extends CheckpointStoreError {
  readonly code = "NOT_FOUND" as const;
  constructor(
    readonly walletId: string,
    readonly networkId: string,
    readonly sequence?: number,
  ) { super("checkpoint not found"); }
}

/** A chunk's rehashed content didn't match its manifest entry. */
export class ChunkIntegrityError extends CheckpointStoreError {
  readonly code = "CHUNK_INTEGRITY" as const;
  constructor(readonly chunkHash: ContentHash, readonly expectedHash: ContentHash) {
    super("chunk hash mismatch");
  }
}

/** The manifest itself failed its own shape/hash validation. */
export class ManifestCorruptError extends CheckpointStoreError {
  readonly code = "MANIFEST_CORRUPT" as const;
  constructor(readonly manifestHash: ContentHash, readonly reason: string) {
    super(`manifest corrupt: ${reason}`);
  }
}

/**
 * Content-addressed, chunked persistence for large periodic snapshots (e.g. wallet sync
 * state). `save()` splits `data` into fixed-size chunks, writes each chunk once keyed by its
 * own content hash — chunk storage is a single GLOBAL pool, deduplicating against every prior
 * checkpoint for the same wallet+network and across wallets — then writes an immutable
 * manifest (the ordered chunk-hash list) under the next sequence number.
 *
 * Because chunks are shared across wallets, chunk garbage collection is necessarily global:
 * implementations MUST maintain a per-chunk reference count (or perform a full cross-manifest
 * reference scan) and may physically delete a chunk only when no manifest anywhere in the
 * store references it. The refcount update/scan runs in the same internal transaction as the
 * manifest write or deletion, so a concurrent `save` in another wallet can never resurrect a
 * reference to a chunk mid-reclamation.
 *
 * Each method is an atomic unit of work; implementations compose the Transaction/Lease layer
 * internally to make manifest + chunk writes all-or-nothing. That plumbing never appears in
 * this interface — `save`/`prune` deliberately do NOT accept a `tx` option (§1.3).
 */
export interface CheckpointStore {
  /**
   * @throws {ValidationError} if `opts` fails {@link SaveCheckpointOptionsSchema} — rejects
   *   before any chunking/hashing work happens.
   */
  save(walletId: string, networkId: string, data: Uint8Array, opts?: SaveCheckpointOptions): Promise<CheckpointSummary>;

  /**
   * Omit `sequence` for the latest checkpoint.
   * @throws {CheckpointNotFoundError} if no checkpoint exists (or `sequence` doesn't).
   * @throws {ChunkIntegrityError} if a chunk's rehash doesn't match its manifest entry.
   * @throws {ManifestCorruptError} if the manifest itself fails validation.
   */
  load(
    walletId: string, networkId: string, sequence?: CheckpointSequence,
    opts?: { signal?: AbortSignal },
  ): Promise<CheckpointRecord>;

  /** Newest-first, bounded by `opts.limit`; use `opts.before` to page further back. */
  history(walletId: string, networkId: string, opts?: HistoryOptions): Promise<CheckpointSummary[]>;

  /**
   * Deletes all but the `retainCount` newest checkpoints (manifests) for this wallet+network,
   * then reclaims any chunk whose GLOBAL reference count dropped to zero as a result. The
   * checkpoint selection is wallet+network-scoped; the chunk reclamation decision never is —
   * see the interface doc above.
   */
  prune(
    walletId: string, networkId: string, retainCount: number,
    opts?: { signal?: AbortSignal },
  ): Promise<PruneResult>;
}
```

**What changed from the original:** `CheckpointStoreError` now extends the shared
`StorageError`, every concrete error class gained a `readonly code` discriminant (the original
relied on `instanceof` alone) and `readonly` fields per §1.5, `save`'s boundary-validation
failure is now the shared `ValidationError` (a class that actually exists in the hierarchy, so
the `@throws` `{@link}` resolves under §5's TypeDoc validation), and the chunk-GC contract was
made explicit and global: the original text defined dedup as cross-wallet but reclamation as
wallet+network-scoped, which — implemented literally — would delete chunks still referenced by
another wallet's manifest and corrupt that wallet's `load`. Reclamation is now defined as
global-refcount-driven, with `prune`'s wallet scoping applying only to which *checkpoints* are
deleted. The content-addressing design, the deliberate omission of a `tx` option on
`save`/`prune`, and the plain-array (not async-iterable) `history()` are all preserved as
originally argued.

**Runtime validation** (per §1.4): `SaveCheckpointOptions`/`HistoryOptions` are Zod schemas
first, data-field types derived via `z.infer` with `signal` intersected on as a live handle;
`CheckpointRecord.integrityVerified` is set by re-hashing loaded chunks against the manifest on
every `load()`, throwing `ChunkIntegrityError` by default rather than silently returning a flag
callers might not check.

---

### 3.4 Watermarks

```typescript
import { z } from "zod";
import type { TransactionHandle } from "./transaction-lease";

/**
 * Watermarks: durable sync-progress cursors. Tracks how far an external sync process
 * (indexer, wallet scan, chain follower) has progressed, keyed by an arbitrary (kind, key)
 * pair. Deliberately has no history/versioning (see TemporalKV) and no built-in concurrency
 * control (compose with the Lease layer if CAS semantics are needed) — it is a plain
 * last-write-wins cursor store.
 *
 * This module defines no error hierarchy of its own: its only failure modes are the shared
 * infrastructure errors (§2) — {@link ConnectionError} on driver failure,
 * {@link ValidationError} when a value fails {@link WatermarkValueSchema} at the boundary,
 * {@link SerializationFailedError} if a value fails the JSONB round-trip.
 */

/** Namespaces independent watermark cursors, e.g. one per sync-process type. */
export type WatermarkKind = string;

/** Identifies a specific cursor within a kind, e.g. a network id or wallet id. */
export type WatermarkKey = string;

/** Opaque progress value, stored as JSONB. Callers agree on shape per kind: a block height,
 *  byte offset, or composite cursor object. Schema-first per §1.4 — the type is derived,
 *  not hand-duplicated. */
export const WatermarkValueSchema = z.union([
  z.string(), z.number(), z.record(z.string(), z.unknown()),
]);
export type WatermarkValue = z.infer<typeof WatermarkValueSchema>;

export interface Watermarks {
  /**
   * Upserts the watermark for (kind, key) to `value`. Last write wins; callers needing
   * monotonicity or compare-and-set must guard the call (e.g. hold a writer lease) themselves.
   * `T` lets a caller pin the cursor shape they use for a given kind — it narrows within
   * {@link WatermarkValue}; runtime validation checks the erased shape only.
   * @throws {ValidationError} if `value` fails {@link WatermarkValueSchema}.
   * @throws {ConnectionError} on driver-level failure.
   */
  set<T extends WatermarkValue>(
    kind: WatermarkKind, key: WatermarkKey, value: T,
    opts?: { tx?: TransactionHandle; signal?: AbortSignal },
  ): Promise<void>;

  /**
   * Returns the current watermark for (kind, key), or `undefined` if none has ever been set.
   * Never throws for a missing cursor (§1.1). `T` is a caller assertion, exactly like
   * `TemporalKV.get<T>` — the runtime validates only the erased {@link WatermarkValue} shape,
   * so a caller who writes one shape and reads another gets a type lie, not a runtime error.
   */
  get<T extends WatermarkValue = WatermarkValue>(
    kind: WatermarkKind, key: WatermarkKey,
    opts?: { tx?: TransactionHandle; signal?: AbortSignal },
  ): Promise<T | undefined>;
}
```

**What changed from the original:** the original module documented no failure path at all —
`set`/`get` were described as returning cleanly, which was an omission rather than a design
choice, since the Postgres backend can still fail to connect. Rather than minting a
module-prefixed error hierarchy (which would have produced a second `CONNECTION_ERROR`-coded
class under a different naming scheme than TemporalKV's), Watermarks throws the shared
infrastructure errors from §2 — it has no domain-specific failures, so it defines no domain
error classes. Also added: `opts.tx` on both methods so a watermark update can join the same
transaction as, e.g., a `CheckpointStore.save` (originally absent); `WatermarkValueSchema` as
the Zod source of truth with `WatermarkValue` derived via `z.infer`; and method-level generics
so callers get compile-time safety on their own per-kind cursor shape. The 2-method surface,
the `undefined`-not-throw absence semantics, and the "no built-in concurrency control" design
are all unchanged — those were the load-bearing decisions in the original and remain correct.

---

## 4. Composition with `WalletStateStore` / `PrivateStateProvider`

The project already has two storage-facing interfaces that predate this consolidation:
**`WalletStateStore`** (the project's own abstraction over the *current, live* wallet state) and
**`PrivateStateProvider`** (the Midnight SDK-mandated interface for per-contract private-state
persistence — noted in the original TemporalKV rationale as "externally-mandated" and
exception-based, which is part of why the whole family standardized on thrown errors rather than
introducing a `Result` type at any layer).

This document doesn't restate their signatures (out of scope — they aren't being normalized
here), but the compositional boundaries are:

**Both notes below were corrected by a 2026-07-20 audit that read the real
`PrivateStateProvider` source (`midnight-js/packages/types/src/private-state-provider.ts`),
the real `MongoPrivateStateProvider.ts`, and real production call sites — the
original text below (kept struck through in git history) was written from
the interface names alone and did not hold up.**

- **`PrivateStateProvider`** is a fixed external contract (SDK-owned); nothing in this
  document changes it. It should be **implemented directly against the `private_states` /
  `signing_keys` / `private_state_salts` tables (design.md §6) — exactly as
  `MongoPrivateStateProvider` implements it directly against Mongo collections — NOT layered
  through `TemporalKV`.** The real interface's `setContractAddress` is a *stateful* scoping
  call (not a per-call positional argument the way `TemporalKV.get(ns,scope,key)` works), it
  carries its own password-strength/rotation locking (a 5-minute internal timeout on the read
  path), a documented lazy-migration-on-read side effect (a "read" can trigger a write), and a
  whole export/import subsystem with conflict strategies and its own error taxonomy
  (`PrivateStateExportError`, `ExportDecryptionError`, `InvalidExportFormatError`,
  `ImportConflictError`, `SigningKeyExportError`, defined in `midnight-js/packages/types/src/errors.ts`) —
  none of this is expressible through `TemporalKV`'s simple `put`/`get`/`getAt` contract, and
  routing through it would mean wrapping every one of these semantics above a KV store that was
  never designed to carry them, while also accruing unwanted `kv_history` version rows for
  ciphertext on every write. This matches what `design.md` §9's module-mapping table already
  said — the composition note above previously contradicted it.
- **`WalletStateStore`** owns the current/live mutable wallet state, but **the pure interface
  (`examples/storage/WalletStateStore.ts`) is not what production actually uses.**
  `ballot-preprod.ts` instantiates `CheckpointWalletStateStore`
  (`midnight-mongo-store/src/walletStateStoreAdapter.ts`), which implements the legacy
  `WalletStateStore` surface **on top of `CheckpointStore` + `Watermarks`** — the composition
  this section describes already exists in the Mongo codebase, it just isn't `TemporalKV`-based:
  - **`CheckpointStore` is the real backing store, not orthogonal to it.** The adapter maps
    `{networkId, walletId}` directly to `CheckpointStore`'s `WalletKey {w, net}` and stores the
    shielded/unshielded/dust blobs as content-addressed chunks; `load` uses `latestAnchor` +
    `loadLatest`, and point-in-time recovery uses `CheckpointStore.loadAt(seq)` — which already
    provides the point-in-time capability a `TemporalKV`-based design was originally considered
    for (that suggestion is withdrawn, kept struck through in git history; `loadAt` already
    covers it), without `kv_history`'s much heavier full-value-copy-per-write cost on multi-MB
    state blobs.
  - **`Watermarks` does not hold a sync-progress cursor in production.** The legacy
    `WalletStateRecord` has no separate block-height field at all — progress lives implicitly
    inside the three opaque SDK blobs. Where a real sync height exists, it rides on the
    *checkpoint manifest* (`syncHeight`), not `Watermarks`. `Watermarks` in production instead
    holds checkpoint bookkeeping: `latestComplete` sequence and a `prunedBelow` floor.
  - **`TemporalKV` is not recommended for `WalletStateStore`** — not because it's incapable, but
    because production already chose `CheckpointStore` for exactly this workload (large,
    mostly-unchanged blobs where chunk-level dedup beats copying the whole value into
    `kv_history` on every write) and already has point-in-time reads via `loadAt`.
  - **Transaction/Lease** is still the shared foundation for atomically composing a live-state
    update with a watermark bump and an occasional checkpoint trigger, unchanged from the
    original note.

**On `TemporalKV`'s standing in this document, now that it's ruled out as substrate for both
`PrivateStateProvider` and `WalletStateStore`:** it has no named production consumer as of this
audit. This is not evidence it shouldn't exist — it's `design.md` §2/§9's own module with its
own tests, general-purpose versioned-KV infrastructure that predates and is independent of this
composition question — but this document should say so plainly rather than imply (via §1's
original "wallet-sync touches all four modules" framing, now corrected above) a consumer that
isn't actually named anywhere. If a concrete consumer is identified during implementation
(Task 1+), record it here; until then, treat `TemporalKV` as available general infrastructure,
not as a module justified by a specific call site.

---

## 5. Documentation-Generation Tooling

**Recommendation: [TypeDoc](https://typedoc.org/).**

Every interface in this document is already annotated with TSDoc-flavored comments (`@throws`,
`@param`, `@link`, `{@link X}` cross-references) — that's the format TypeDoc consumes natively,
with zero markup translation needed. It resolves `{@link VersionConflictError}`-style
cross-references across files/modules automatically (load-bearing here, since every module's
`@throws` tags point at error classes defined in `storage-errors.ts` or `transaction-lease.ts`),
understands discriminated unions and branded opaque types cleanly in its output, and needs no
separate schema/config language beyond pointing it at the entry files — unlike API Extractor +
API Documenter (Microsoft's toolchain), which adds real value once this layer ships as a
versioned public package with a frozen `.d.ts` API-diff gate, but is unjustified overhead for an
internal storage layer at this stage.

**Wiring into this repo:**

`typedoc.json` at the repo root:

```json
{
  "entryPoints": [
    "src/storage/storage-errors.ts",
    "src/storage/transaction-lease.ts",
    "src/storage/temporal-kv.ts",
    "src/storage/checkpoint-store.ts",
    "src/storage/watermarks.ts"
  ],
  "out": "docs/api/storage",
  "excludePrivate": true,
  "excludeInternal": true,
  "readme": "none",
  "treatWarningsAsErrors": true,
  "validation": { "notExported": true, "invalidLink": true, "notDocumented": true }
}
```

`package.json` scripts:

```json
{
  "scripts": {
    "docs:storage": "typedoc",
    "docs:storage:check": "typedoc --emit none --treatWarningsAsErrors"
  },
  "devDependencies": {
    "typedoc": "^0.28.0"
  }
}
```

- `npm run docs:storage` regenerates static HTML docs under `docs/api/storage/` for local
  browsing or static hosting (e.g. GitHub Pages).
- `npm run docs:storage:check` runs the same pass with no output files, just validation —
  `treatWarningsAsErrors` plus the `validation` block turns a broken `{@link}`, an undocumented
  exported symbol, or a type that's referenced but not exported into a CI failure, so the
  `@throws`/cross-reference discipline this document introduced doesn't silently rot. Add it as
  a CI step (or a pre-commit/pre-push hook) alongside `tsc --noEmit` and the existing lint step.

---

## Review notes

This revision applies the findings of a three-lens review (consistency, implementability,
ergonomics) of the consolidated draft. **Consistency:** the draft's §1.4 validation claims were
made true rather than merely asserted — `TransactionOptions`/`LeaseAcquireOptions` gained real
Zod schemas with `z.infer`'d types, `JsonValue` and `WatermarkValue` are now schema-derived
(via Zod v4's `z.json()` and `z.infer`) instead of hand-duplicated, the one legitimate
exception (generic `VersionedEntry<T>`) is now named as a rule with a compile-time sync guard,
and live handles (`tx`, `signal`) were explicitly carved out of schema validation; the
Watermarks naming clash (a second, differently-named `CONNECTION_ERROR` class) and
CheckpointStore's `@throws` reference to a nonexistent error were both resolved by hoisting
`ConnectionError`/`SerializationFailedError`/`ValidationError` into the shared
`storage-errors.ts`, and all error fields are now uniformly `readonly`. **Implementability:**
the contradiction between cross-wallet chunk dedup and wallet-scoped reclamation — which would
have corrupted other wallets' checkpoints if implemented as written — was fixed by defining
chunk GC as globally reference-counted while keeping `prune`'s checkpoint selection
wallet-scoped; `getAt({ at })`'s timestamp-range index and the lease bookkeeping side table
(token/TTL semantics that advisory locks alone cannot provide) are now normative implementation
requirements instead of hand-waves. **Ergonomics:** `tryAcquireLease(): Promise<Lease | null>`
restores a non-throwing hot path for routine lock contention without reintroducing a second
error idiom, `AbortSignal` cancellation was added layer-wide with defined `AbortError`
semantics, `VersionConflictError.actual`'s `undefined` overload is now documented, and
`Watermarks` gained method-level generics mirroring `TemporalKV.get<T>`. Two reviewer
suggestions were deliberately not adopted: returning to result-union error handling for the
lease layer (the single-idiom decision is the consolidation's core purpose, and `try*` covers
the hot path), and unifying identifier vocabulary across modules (the differences are
domain-real, per §1.5).