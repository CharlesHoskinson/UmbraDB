import { TransactionHistoryStorage as Sdk } from "@midnightntwrk/wallet-sdk-abstractions";
import { SerializationFailedError } from "../../src/interfaces/storage-errors.js";
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
 * under the `sections` key `__lifecycleDetail` (safe: does not start with
 * `THS_RESERVED_KEY_PREFIX`, so it is never rejected by `TransactionHistoryEntrySchema`'s reserved-
 * namespace guard) and reconstructs a schema-valid SDK lifecycle object on `getAll()`/`get()`.
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

/** Sections key the adapter stashes SDK lifecycle detail under. Deliberately does NOT start with
 *  `THS_RESERVED_KEY_PREFIX` ("__umbradb_ths_") -- that namespace is reserved for
 *  `PgTransactionHistoryStorage`'s own internal bigint/Date JSONB tagging scheme
 *  (`src/interfaces/transaction-history-storage.ts`) and would be rejected at the boundary if
 *  used here. */
const LIFECYCLE_DETAIL_KEY = "__lifecycleDetail";

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

/** (L1) Maps the SDK's execution-status enum onto UmbraDB's own. Exported so
 *  `pg-tx-history-adapter.test.ts` can exercise the mapping directly as a round-trip, without
 *  needing a whole entry. */
export function mapSdkStatusToUmbra(status: Sdk.TransactionHistoryStatus): UmbraTransactionHistoryStatus {
  return SDK_TO_UMBRA_STATUS[status];
}

/** Inverse of {@link mapSdkStatusToUmbra}. */
export function mapUmbraStatusToSdk(status: UmbraTransactionHistoryStatus): Sdk.TransactionHistoryStatus {
  return UMBRA_TO_SDK_STATUS[status];
}

/** The shape stashed under {@link LIFECYCLE_DETAIL_KEY} in UmbraDB's own `sections`. All three
 *  keys are optional because a hash's stored detail can (harmlessly) accumulate more than one
 *  status's worth after repeated merges -- see the class doc's M1 note. */
interface LifecycleDetailStore {
  pending?: { submittedAt: Date };
  finalized?: { finalizedBlock: Sdk.FinalizedBlock };
  rejected?: { rejectedAt: Date; reason?: string };
}

function splitCommonAndExtension(rest: Record<string, unknown>): {
  common: Record<string, unknown>;
  extension: Record<string, EntryContent>;
} {
  const common: Record<string, unknown> = {};
  const extension: Record<string, EntryContent> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (COMMON_FIELD_NAMES.has(key)) common[key] = value;
    else extension[key] = value as EntryContent;
  }
  return { common, extension };
}

function toUmbraWriteInput(
  rest: Record<string, unknown>, detail: LifecycleDetailStore,
): Omit<UmbraTransactionHistoryEntry, "lifecycle"> {
  const { common, extension } = splitCommonAndExtension(rest);
  return {
    hash: common.hash as string,
    identifiers: [...(common.identifiers as readonly string[])],
    ...(common.protocolVersion !== undefined ? { protocolVersion: common.protocolVersion as number } : {}),
    ...(common.status !== undefined ? { status: mapSdkStatusToUmbra(common.status as Sdk.TransactionHistoryStatus) } : {}),
    ...(common.timestamp !== undefined ? { timestamp: common.timestamp as Date } : {}),
    ...(common.fees !== undefined ? { fees: common.fees as bigint | null } : {}),
    sections: { ...extension, [LIFECYCLE_DETAIL_KEY]: detail as unknown as EntryContent },
  };
}

/** Reconstructs a schema-valid SDK `TransactionLifecycle` from the CURRENT authoritative
 *  `lifecycle.status` plus only the matching sub-key of the stashed detail store (the M1 fix --
 *  see the class doc). */
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
  const { [LIFECYCLE_DETAIL_KEY]: rawDetail, ...extensionSections } = entry.sections;
  const detail = rawDetail as unknown as LifecycleDetailStore | undefined;
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
 * `PgTransactionHistoryStorage` instance constructed with the caller-supplied `mergeFn` (the
 * Sprint 7 test double `referenceMergeEntries` for the Pg-only conformance tier; see
 * `openspec/changes/sprint-8-wallet-envelope-live-sync/design.md` §3 and the report accompanying
 * this sprint for why the live tier also uses `referenceMergeEntries` rather than the SDK's own
 * `mergeWalletEntries`).
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
