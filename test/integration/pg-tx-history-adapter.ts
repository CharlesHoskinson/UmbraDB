import { TransactionHistoryStorage as Sdk } from "@midnightntwrk/wallet-sdk-abstractions";
import { z } from "zod";
import { SerializationFailedError, ValidationError } from "../../src/interfaces/storage-errors.js";
import type {
  EntryContent,
  MergeEntriesFn,
  TransactionHistoryEntry as UmbraTransactionHistoryEntry,
  TransactionHistoryStatus as UmbraTransactionHistoryStatus,
} from "../../src/interfaces/transaction-history-storage.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { PgTransactionHistoryStorage } from "../../src/postgres/transaction-history-storage.js";

/**
 * The adapter -- the seam (`openspec/changes/sprint-8-wallet-envelope-live-sync/design.md` §3):
 * implements the real Midnight wallet SDK's `TransactionHistoryStorage<T>` surface
 * (`TransactionHistoryStorage.ts:163-216`) and forwards every call to a
 * `PgTransactionHistoryStorage` instance (Sprint 7), constructed with a caller-supplied merge
 * function -- so the SDK's `configuration.txHistoryStorage` slot is backed by Postgres, replacing
 * `InMemoryTransactionHistoryStorage`
 * (`preprodUnshieldedSync.manual.integration.test.ts:94`).
 *
 * Lives under `test/` (integration tier), NOT `src/` -- this is the ONLY Sprint 8 component that
 * imports a wallet-SDK package at runtime (`design.md` §2/§3.3); `PgTransactionHistoryStorage` and
 * the WalletState envelope modules have no such import (enforced by
 * `test/postgres/no-sdk-import-guard.test.ts`).
 *
 * **Field mapping (write path, `design.md` §3.1).** The SDK writer input is the entry MINUS its
 * `lifecycle`, plus a per-status detail field (`submittedAt` / `finalizedBlock` /
 * `rejectedAt`+`reason`). The common fields (`hash`, `identifiers`, `protocolVersion`, `status`,
 * `timestamp`, `fees`) map onto UmbraDB's `TransactionHistoryEntry` one-to-one -- except `status`,
 * whose SDK-side enum (`'SUCCESS'|'FAILURE'|'PARTIAL_SUCCESS'`) differs textually from UmbraDB's
 * own (`"success"|"failure"|"partialSuccess"`) and is mapped by {@link mapSdkStatusToUmbra}/
 * {@link mapUmbraStatusToSdk} (L1 finding; round-trip tested in
 * `pg-tx-history-adapter.test.ts`). Every OTHER property on the SDK entry (its wallet-specific
 * "sections" -- `shielded`/`unshielded`/`dust`, produced by `extendEntrySchema`) is forwarded
 * opaquely into UmbraDB's own `sections: Record<string, EntryContent>`.
 *
 * **Lifecycle-detail round-trip (`design.md` §3.2, decision (i)).** The SDK's lifecycle carries
 * per-status detail (`submittedAt` / `finalizedBlock` / `rejectedAt`+`reason`) that UmbraDB's own
 * entry does not model (`lifecycle` there is a bare `{status}`). This adapter stashes that detail
 * under the reserved `sections` key {@link UMBRADB_ADAPTER_LIFECYCLE_DETAIL_KEY} (safe: does not
 * start with Sprint 7's own `THS_RESERVED_KEY_PREFIX`, so it is never rejected by
 * `TransactionHistoryEntrySchema`'s reserved-namespace guard) and reconstructs a schema-valid SDK
 * lifecycle object on `getAll()`/`get()`.
 *
 * **F2 fix (cross-vendor audit BLOCK finding).** The stash key was previously a bare
 * `"__lifecycleDetail"` string with no reserved-namespace enforcement of its own — an incoming SDK
 * entry whose wallet-specific extension ALSO happened to carry a section literally named
 * `"__lifecycleDetail"` would have been silently clobbered by the old `toUmbraWriteInput`'s spread
 * order (`{ ...extension, [LIFECYCLE_DETAIL_KEY]: detail }`), with no error at all. Fixed two ways:
 * (1) the key is renamed to {@link UMBRADB_ADAPTER_LIFECYCLE_DETAIL_KEY} under this adapter's own
 * reserved prefix ({@link UMBRADB_ADAPTER_RESERVED_KEY_PREFIX}); (2) the write path now THROWS a
 * typed {@link ValidationError} at write time if the incoming entry's extension carries any key
 * inside that reserved namespace, rather than silently overwriting it — see
 * {@link assertNoReservedAdapterKeys}. (3) `reconstructLifecycle`'s stashed detail is now
 * Zod-validated ({@link LifecycleDetailStoreSchema}) BEFORE use, so a malformed stash (e.g. a raw
 * row seeded directly into Postgres, bypassing this adapter's own write path) throws a typed,
 * per-hash {@link SerializationFailedError} rather than silently reconstructing a bad SDK lifecycle
 * object or throwing an untranslated error deep in field access.
 *
 * **M1 fix -- reconstruction is authoritative by CURRENT status, not accumulated detail.** A given
 * hash's `__lifecycleDetail` sections value can (harmlessly) accumulate more than one status's
 * detail across repeated merges -- e.g. `{pending: {...}, finalized: {...}}` after a `gotPending`
 * followed by a `gotFinalized` on the same hash, since the injected merge function shallow-merges
 * `sections`' own object-valued top-level keys. {@link reconstructLifecycle} below always selects
 * ONLY the sub-key matching the entry's CURRENT `lifecycle.status` (itself always incoming-wins
 * per the injected merge function's contract, `specs/transaction-history-storage/spec.md`), so a
 * stale sibling status's detail (e.g. an old `submittedAt` after the entry has since finalized)
 * never bleeds into the reconstructed lifecycle object. See the `gotPending -> gotFinalized ->
 * gotRejected` scenario in `pg-tx-history-adapter.test.ts`.
 */

/** Reserved key-PREFIX namespace for THIS adapter's own internal stashing keys under `sections`
 *  (F2 fix) -- distinct from Sprint 7's own `THS_RESERVED_KEY_PREFIX`
 *  ("__umbradb_ths_", `src/interfaces/transaction-history-storage.ts`), which
 *  `PgTransactionHistoryStorage` already enforces at its own Zod boundary and which this prefix
 *  deliberately does NOT start with (so a key inside THIS namespace is never itself rejected by
 *  that lower-level guard -- it has to be rejected here, at the adapter's own write path, instead).
 *  Any incoming SDK entry's extension ("wallet-specific section") carrying a key inside this
 *  namespace is rejected with a typed {@link ValidationError} at write time -- fail loud, never
 *  silently overwrite this adapter's own lifecycle-detail stash -- see
 *  {@link assertNoReservedAdapterKeys}. */
export const UMBRADB_ADAPTER_RESERVED_KEY_PREFIX = "__umbradb_adapter_";

/** Sections key the adapter stashes reconstructed SDK lifecycle detail under. Renamed (F2 fix)
 *  from the previous bare `"__lifecycleDetail"`, which shared no reserved-namespace enforcement
 *  with anything -- a caller section literally named `"__lifecycleDetail"` would have been
 *  silently clobbered by the old write path's spread order. Lives inside
 *  {@link UMBRADB_ADAPTER_RESERVED_KEY_PREFIX}'s namespace; a single exported const so both the
 *  write path (the reservation check) and the read path (the destructure in
 *  {@link reconstructSdkEntry}) share one literal source of truth. */
export const UMBRADB_ADAPTER_LIFECYCLE_DETAIL_KEY = `${UMBRADB_ADAPTER_RESERVED_KEY_PREFIX}lifecycle_detail`;

/** The fixed set of "common" field names every wallet-type's SDK entry shares
 *  (`TransactionHistoryStorage.ts:75-85`). Anything else on a caller-supplied SDK-shaped entry is
 *  a wallet-specific "section" (e.g. `shielded`/`unshielded`/`dust`) and is forwarded opaquely
 *  into UmbraDB's own `sections` record, exactly as UmbraDB's core storage never interprets it
 *  either (`design.md` §3.1). */
const COMMON_FIELD_NAMES: ReadonlySet<string> = new Set([
  "hash", "identifiers", "protocolVersion", "status", "timestamp", "fees",
]);

const SDK_TO_UMBRA_STATUS: Record<Sdk.TransactionHistoryStatus, UmbraTransactionHistoryStatus> = {
  SUCCESS: "success",
  FAILURE: "failure",
  PARTIAL_SUCCESS: "partialSuccess",
};
const UMBRA_TO_SDK_STATUS: Record<UmbraTransactionHistoryStatus, Sdk.TransactionHistoryStatus> = {
  success: "SUCCESS",
  failure: "FAILURE",
  partialSuccess: "PARTIAL_SUCCESS",
};

/** Safe stringify for an error message about an unexpected/unmapped value that may be a type-erased
 *  non-string. `JSON.stringify` THROWS a raw TypeError on a `bigint`, and `String` THROWS on a
 *  `symbol` -- either would mask the intended typed `SerializationFailedError` with a raw error.
 *  This never throws, so the fail-closed guard always surfaces its own typed error. (Codex re-audit.) */
function describeStatusValue(v: unknown): string {
  const t = typeof v;
  if (t === "string") return JSON.stringify(v);
  if (t === "bigint") return `${(v as bigint).toString()}n`;
  if (t === "symbol") return (v as symbol).toString();
  if (v === null) return "null";
  if (t === "object" || t === "function") return Object.prototype.toString.call(v);
  return String(v as number | boolean | undefined);
}

/** (L1, F6) Maps the SDK's execution-status enum onto UmbraDB's own. Exported so
 *  `pg-tx-history-adapter.test.ts` can exercise the mapping directly as a round-trip, without
 *  needing a whole entry.
 *
 *  **F6 fix (fail-closed):** an unmapped `status` value used to fall through `Record<...>`
 *  indexing and silently return `undefined` -- a value that does not satisfy this function's own
 *  declared return type, and would have propagated a `status: undefined` field deep into a
 *  reconstructed SDK entry instead of failing loudly at the boundary. Now THROWS a typed
 *  {@link SerializationFailedError} on an unmapped value in EITHER direction. */
export function mapSdkStatusToUmbra(status: Sdk.TransactionHistoryStatus): UmbraTransactionHistoryStatus {
  // Own-property check, NOT `mapped === undefined`: a status value like "constructor",
  // "toString", or "__proto__" resolves to an INHERITED Object.prototype member (a function,
  // not `undefined`), which would slip past a bare-index guard and be returned instead of
  // rejected. hasOwnProperty rejects any key this map does not literally own. (Codex re-audit.)
  if (!Object.prototype.hasOwnProperty.call(SDK_TO_UMBRA_STATUS, status)) {
    throw new SerializationFailedError(
      `PgWalletSdkTransactionHistoryAdapter: unmapped SDK TransactionHistoryStatus value `
      + `${describeStatusValue(status)} -- this adapter's status-enum map does not cover it`,
    );
  }
  return SDK_TO_UMBRA_STATUS[status];
}

/** Inverse of {@link mapSdkStatusToUmbra}. Same F6 fail-closed fix, mirrored, including the
 *  own-property (not bare-`undefined`) guard against inherited-prototype keys. */
export function mapUmbraStatusToSdk(status: UmbraTransactionHistoryStatus): Sdk.TransactionHistoryStatus {
  if (!Object.prototype.hasOwnProperty.call(UMBRA_TO_SDK_STATUS, status)) {
    throw new SerializationFailedError(
      `PgWalletSdkTransactionHistoryAdapter: unmapped UmbraDB TransactionHistoryStatus value `
      + `${describeStatusValue(status)} -- this adapter's status-enum map does not cover it`,
    );
  }
  return UMBRA_TO_SDK_STATUS[status];
}

/** The shape stashed under {@link UMBRADB_ADAPTER_LIFECYCLE_DETAIL_KEY} in UmbraDB's own
 *  `sections`. All three keys are optional because a hash's stored detail can (harmlessly)
 *  accumulate more than one status's worth after repeated merges -- see the class doc's M1 note. */
interface LifecycleDetailStore {
  pending?: { submittedAt: Date };
  finalized?: { finalizedBlock: Sdk.FinalizedBlock };
  rejected?: { rejectedAt: Date; reason?: string };
}

/** F2 fix: Zod schema for {@link LifecycleDetailStore}, validated BEFORE use in
 *  {@link reconstructLifecycle} -- see {@link parseLifecycleDetailStore}. `.strict()` at every
 *  level so an unexpected extra key (a sign of a different, unrelated corruption) is rejected
 *  too, not just a wrong-typed known key. Dates are validated with the same "must be a valid
 *  Date" check `src/interfaces/transaction-history-storage.ts`'s own `EntryContentSchema` uses --
 *  by the time this value reaches the adapter, `PgTransactionHistoryStorage`'s own decode has
 *  already reconstructed any genuine tagged Date/bigint leaves into real `Date`/`bigint`
 *  instances, so a legitimately-written stash always satisfies `z.date()` here; a value that does
 *  NOT (e.g. a plain string, because it was never encoded via the tagging scheme at all) is
 *  exactly the corruption shape this guard exists to catch. */
const LifecycleDetailStoreSchema = z.object({
  pending: z.object({
    submittedAt: z.date().refine((d) => !Number.isNaN(d.getTime()), { message: "must be a valid Date" }),
  }).strict().optional(),
  finalized: z.object({
    finalizedBlock: z.object({
      hash: z.string(),
      height: z.number(),
      timestamp: z.date().refine((d) => !Number.isNaN(d.getTime()), { message: "must be a valid Date" }),
    }).strict(),
  }).strict().optional(),
  rejected: z.object({
    rejectedAt: z.date().refine((d) => !Number.isNaN(d.getTime()), { message: "must be a valid Date" }),
    reason: z.string().optional(),
  }).strict().optional(),
}).strict();

/** F2 fix: validates a raw, not-yet-trusted stashed lifecycle-detail value (read straight off
 *  `entry.sections[UMBRADB_ADAPTER_LIFECYCLE_DETAIL_KEY]`, still `unknown` at this point) against
 *  {@link LifecycleDetailStoreSchema} BEFORE {@link reconstructLifecycle} ever touches it. Throws
 *  a typed, PER-HASH {@link SerializationFailedError} naming the offending hash on a malformed
 *  stash -- e.g. a raw row seeded directly into Postgres bypassing this adapter's own write path
 *  entirely. This adapter's own writes always produce a schema-valid stash -- ENFORCED (not merely
 *  assumed by construction) by {@link toUmbraWriteInput}, which validates the stash against THIS same
 *  schema at write time, so a runtime-invalid detail is rejected at write rather than bricking a later
 *  read (Codex re-audit). This read-side check is therefore pure defense-in-depth for stored-data
 *  corruption from OUTSIDE this adapter, mirroring `PgTransactionHistoryStorage`'s own
 *  validate-on-read pattern. `undefined` (no stash at all -- a row never written through this
 *  adapter's `got*` methods) is passed through unchanged; {@link reconstructLifecycle}'s own
 *  per-status checks already produce a typed, per-hash error for that case. */
function parseLifecycleDetailStore(rawDetail: unknown, hash: string): LifecycleDetailStore | undefined {
  if (rawDetail === undefined) return undefined;
  const parsed = LifecycleDetailStoreSchema.safeParse(rawDetail);
  if (!parsed.success) {
    throw new SerializationFailedError(
      `PgWalletSdkTransactionHistoryAdapter: entry ${JSON.stringify(hash)}'s stashed lifecycle `
      + `detail (sections.${UMBRADB_ADAPTER_LIFECYCLE_DETAIL_KEY}) is malformed and could not be `
      + `validated: ${parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")}`,
      parsed.error,
    );
  }
  return parsed.data;
}

function splitCommonAndExtension(rest: Record<string, unknown>): {
  common: Record<string, unknown>;
  extension: Record<string, EntryContent>;
} {
  // Null-prototype accumulators: on an ordinary `{}`, `extension[key] = value` with an untrusted
  // key `"__proto__"` invokes Object.prototype's `__proto__` SETTER -- silently dropping the section
  // (and mutating the object's prototype) instead of storing it. On a null-prototype object there is
  // no such setter, so `"__proto__"` becomes an ordinary own key that assertNoReservedAdapterKeys can
  // then see and reject at the boundary. (Codex re-audit -- same prototype-key class as F6.)
  const common: Record<string, unknown> = Object.create(null);
  const extension: Record<string, EntryContent> = Object.create(null);
  for (const [key, value] of Object.entries(rest)) {
    if (COMMON_FIELD_NAMES.has(key)) common[key] = value;
    else extension[key] = value as EntryContent;
  }
  return { common, extension };
}

/** F2 fix: throws a typed {@link ValidationError} -- fail loud, at write time, BEFORE anything is
 *  persisted -- if the incoming SDK entry's wallet-specific extension carries any section key
 *  inside this adapter's own reserved namespace ({@link UMBRADB_ADAPTER_RESERVED_KEY_PREFIX}).
 *  The old write path silently let such a key be clobbered by the later
 *  `[UMBRADB_ADAPTER_LIFECYCLE_DETAIL_KEY]: detail` spread; this makes the collision structurally
 *  impossible to reach storage at all, mirroring Sprint 7's own `THS_RESERVED_KEY_PREFIX`
 *  boundary-rejection pattern (`src/interfaces/transaction-history-storage.ts`). */
/** Prototype-manipulation keys that must never be accepted as a wallet section name -- never
 *  legitimate section names for the conformant SDK (its sections are shielded/unshielded/dust), and
 *  a vector for silent data loss / prototype pollution. Rejected fail-closed at the boundary, same as
 *  the reserved-prefix keys. (Codex re-audit.) */
const DANGEROUS_EXTENSION_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

function assertNoReservedAdapterKeys(extension: Readonly<Record<string, EntryContent>>, hash: unknown): void {
  const badKeys = Object.keys(extension).filter(
    (k) => k.startsWith(UMBRADB_ADAPTER_RESERVED_KEY_PREFIX) || DANGEROUS_EXTENSION_KEYS.has(k),
  );
  if (badKeys.length > 0) {
    throw new ValidationError(
      `PgWalletSdkTransactionHistoryAdapter: entry ${describeStatusValue(hash)} carries a wallet-specific `
      + `section key reserved for this adapter's own internal use or a prototype-manipulation key`,
      badKeys.map((k) => ({
        path: `sections.${k}`,
        message: DANGEROUS_EXTENSION_KEYS.has(k)
          ? `key "${k}" is a prototype-manipulation key and is rejected at the boundary`
          : `key starts with the reserved prefix "${UMBRADB_ADAPTER_RESERVED_KEY_PREFIX}" (reserved for this adapter's own lifecycle-detail stash, ${UMBRADB_ADAPTER_LIFECYCLE_DETAIL_KEY})`,
      })),
    );
  }
}

function toUmbraWriteInput(
  rest: Record<string, unknown>, detail: LifecycleDetailStore,
): Omit<UmbraTransactionHistoryEntry, "lifecycle"> {
  const { common, extension } = splitCommonAndExtension(rest);
  assertNoReservedAdapterKeys(extension, common.hash);
  // Validate the lifecycle-detail stash at WRITE time against the SAME strict schema the read path
  // uses, so write and read agree. Without this, a runtime-invalid detail (e.g. a `finalizedBlock`
  // with a string `height`/`timestamp` from a type-erased caller) passes the generic
  // `EntryContentSchema`, is written, and then bricks `get()`/`getAll()` -- a malformed stash
  // reachable via an adapter write, not only out-of-band corruption. Fail closed HERE instead, so the
  // "schema-valid stash by construction" invariant is enforced, not merely assumed. (Codex re-audit.)
  const validatedDetail = LifecycleDetailStoreSchema.safeParse(detail);
  if (!validatedDetail.success) {
    throw new ValidationError(
      `PgWalletSdkTransactionHistoryAdapter: entry ${describeStatusValue(common.hash)}'s lifecycle detail `
      + `is runtime-invalid and cannot be stashed (write-side validation, symmetric with the read path)`,
      validatedDetail.error.issues.map((i) => ({
        path: i.path.join(".") || "<root>",
        message: i.message,
      })),
    );
  }
  return {
    hash: common.hash as string,
    identifiers: [...(common.identifiers as readonly string[])],
    ...(common.protocolVersion !== undefined ? { protocolVersion: common.protocolVersion as number } : {}),
    ...(common.status !== undefined ? { status: mapSdkStatusToUmbra(common.status as Sdk.TransactionHistoryStatus) } : {}),
    ...(common.timestamp !== undefined ? { timestamp: common.timestamp as Date } : {}),
    ...(common.fees !== undefined ? { fees: common.fees as bigint | null } : {}),
    sections: { ...extension, [UMBRADB_ADAPTER_LIFECYCLE_DETAIL_KEY]: validatedDetail.data as unknown as EntryContent },
  };
}

/** Reconstructs a schema-valid SDK `TransactionLifecycle` from the CURRENT authoritative
 *  `lifecycle.status` plus only the matching sub-key of the stashed detail store (the M1 fix --
 *  see the class doc). `detail` here has ALREADY been Zod-validated by
 *  {@link parseLifecycleDetailStore} -- this function only handles "which sub-key is missing for
 *  the current status," never raw shape corruption (F2 fix). */
function reconstructLifecycle(
  status: UmbraTransactionHistoryEntry["lifecycle"]["status"],
  detail: LifecycleDetailStore | undefined,
  hash: string,
): Sdk.TransactionLifecycle {
  switch (status) {
    case "pending": {
      if (detail?.pending === undefined) {
        throw new SerializationFailedError(
          `PgWalletSdkTransactionHistoryAdapter: entry ${JSON.stringify(hash)} is pending but its stashed `
          + `lifecycle detail (submittedAt) is missing -- the underlying row was not written through this `
          + `adapter's own gotPending`,
        );
      }
      return { status: "pending", submittedAt: detail.pending.submittedAt };
    }
    case "finalized": {
      if (detail?.finalized === undefined) {
        throw new SerializationFailedError(
          `PgWalletSdkTransactionHistoryAdapter: entry ${JSON.stringify(hash)} is finalized but its stashed `
          + `lifecycle detail (finalizedBlock) is missing`,
        );
      }
      return { status: "finalized", finalizedBlock: detail.finalized.finalizedBlock };
    }
    case "rejected": {
      if (detail?.rejected === undefined) {
        throw new SerializationFailedError(
          `PgWalletSdkTransactionHistoryAdapter: entry ${JSON.stringify(hash)} is rejected but its stashed `
          + `lifecycle detail (rejectedAt) is missing`,
        );
      }
      return detail.rejected.reason !== undefined
        ? { status: "rejected", rejectedAt: detail.rejected.rejectedAt, reason: detail.rejected.reason }
        : { status: "rejected", rejectedAt: detail.rejected.rejectedAt };
    }
    /* istanbul ignore next -- UmbraTransactionHistoryEntry["lifecycle"]["status"] is exhaustive */
    default: {
      const exhaustive: never = status;
      throw new SerializationFailedError(`PgWalletSdkTransactionHistoryAdapter: unknown lifecycle status ${JSON.stringify(exhaustive)}`);
    }
  }
}

function reconstructSdkEntry<T extends Sdk.TransactionHistoryEntryCommon>(entry: UmbraTransactionHistoryEntry): T {
  const { [UMBRADB_ADAPTER_LIFECYCLE_DETAIL_KEY]: rawDetail, ...extensionSections } = entry.sections;
  // F2 fix: validate the raw stash BEFORE use -- see parseLifecycleDetailStore's own doc. This
  // is what turns a malformed/tampered stash into a typed, per-hash SerializationFailedError
  // here, rather than a bad value silently flowing into reconstructLifecycle.
  const detail = parseLifecycleDetailStore(rawDetail, entry.hash);
  const lifecycle = reconstructLifecycle(entry.lifecycle.status, detail, entry.hash);

  const common: Record<string, unknown> = {
    hash: entry.hash,
    identifiers: [...entry.identifiers],
    ...(entry.protocolVersion !== undefined ? { protocolVersion: entry.protocolVersion } : {}),
    ...(entry.status !== undefined ? { status: mapUmbraStatusToSdk(entry.status) } : {}),
    ...(entry.timestamp !== undefined ? { timestamp: entry.timestamp } : {}),
    ...(entry.fees !== undefined ? { fees: entry.fees } : {}),
    lifecycle,
  };
  return { ...common, ...extensionSections } as unknown as T;
}

/**
 * Implements the SDK's `TransactionHistoryStorage<T>` and forwards every call to a
 * `PgTransactionHistoryStorage` instance constructed with the caller-supplied `mergeFn`. Both the
 * Pg-only conformance tier AND the live preprod tier inject `referenceMergeEntries`
 * (`test/postgres/reference-merge.ts`) here, NOT the real SDK's `mergeWalletEntries` -- the real
 * function operates on the SDK's own `WalletEntry` shape (top-level `shielded`/`unshielded`/
 * `dust`), not this adapter's UmbraDB-shaped `TransactionHistoryEntry` (a `sections` container),
 * and its first line (`[...existing.identifiers]`) throws a `TypeError` if ever called with
 * `existing===undefined` (the first write of a hash) -- see `MergeEntriesFn`'s own doc (F1
 * finding) and `openspec/changes/sprint-8-wallet-envelope-live-sync/design.md` §3 for the full
 * account of why production injects an UmbraDB-shaped merge function mirroring the SDK's
 * documented semantics, never the raw SDK function itself.
 */
export class PgWalletSdkTransactionHistoryAdapter<
  T extends Sdk.TransactionHistoryEntryCommon = Sdk.TransactionHistoryEntryWithHash,
> implements Sdk.TransactionHistoryStorage<T> {
  private readonly pg: PgTransactionHistoryStorage;

  constructor(sql: UmbraDBSql, walletId: string, mergeFn: MergeEntriesFn, schema?: string) {
    this.pg = schema !== undefined
      ? new PgTransactionHistoryStorage(sql, walletId, mergeFn, schema)
      : new PgTransactionHistoryStorage(sql, walletId, mergeFn);
  }

  async getAll(): Promise<readonly T[]> {
    const all = await this.pg.getAll();
    return all.map((e) => reconstructSdkEntry<T>(e));
  }

  async get(hash: Sdk.TransactionHash): Promise<T | undefined> {
    const found = await this.pg.get(hash);
    return found === undefined ? undefined : reconstructSdkEntry<T>(found);
  }

  /** Forwards `PgTransactionHistoryStorage.serialize()` verbatim -- a dump of UmbraDB-shaped
   *  entries (its own documented bigint/Date tagging scheme), NOT re-encoded into SDK shape. The
   *  SDK's `serialize(): Promise<string>` contract is satisfied structurally; no Sprint 8
   *  requirement asserts on this method's specific content (only `getAll`/`get` are asserted
   *  against the SDK's own schema, `design.md` §3.2/§7.1). */
  async serialize(): Promise<Sdk.SerializedTransactionHistory> {
    return this.pg.serialize();
  }

  async gotPending(entry: Sdk.PendingEntryInput<T>): Promise<void> {
    const { submittedAt, ...rest } = entry;
    await this.pg.gotPending(toUmbraWriteInput(rest as unknown as Record<string, unknown>, { pending: { submittedAt } }));
  }

  async gotFinalized(entry: Sdk.FinalizedEntryInput<T>): Promise<void> {
    const { finalizedBlock, ...rest } = entry;
    await this.pg.gotFinalized(toUmbraWriteInput(rest as unknown as Record<string, unknown>, { finalized: { finalizedBlock } }));
  }

  async gotRejected(entry: Sdk.RejectedEntryInput<T>): Promise<void> {
    const { rejectedAt, reason, ...rest } = entry;
    const detail: LifecycleDetailStore = reason !== undefined
      ? { rejected: { rejectedAt, reason } }
      : { rejected: { rejectedAt } };
    await this.pg.gotRejected(toUmbraWriteInput(rest as unknown as Record<string, unknown>, detail));
  }
}
