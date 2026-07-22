import { ValidationError } from "../../src/interfaces/storage-errors.js";
import {
  TransactionHistoryEntrySchema,
  type MergeEntriesFn,
  type TransactionHistoryEntry,
  type TransactionHistoryStorage,
} from "../../src/interfaces/transaction-history-storage.js";

function abortErrorLike(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof DOMException && reason.name === "AbortError") return reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  return new DOMException("The operation was aborted", "AbortError");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * A Map-based, single-threaded reference implementation of `TransactionHistoryStorage`
 * (`src/interfaces/transaction-history-storage.ts`), built fresh in-repo (this project never
 * imports wallet-SDK runtime code, `design.md` §2) — mirroring the shape the recommendation doc
 * describes for the real `InMemoryTransactionHistoryStorage.ts` (Map + pluggable merge + JSON
 * serialize/restore).
 *
 * Used ONLY as a sequential-equivalence oracle in this test suite
 * (`transaction-history-storage.property.test.ts`): its own atomicity relies on JS being
 * single-threaded (no external semaphore, no row lock), so it is NOT a valid oracle for the
 * concurrent-write scenario — only `PgTransactionHistoryStorage`'s row lock can exhibit that
 * correctly (`openspec/changes/sprint-7-transaction-history-storage/design.md` §3). `opts.tx` is
 * not supported (there is no notion of a Postgres transaction here); `opts.signal` is honored as
 * a pre-check-only abort, matching every other module's `withAbort` convention.
 */
export class InMemoryTransactionHistoryStorage implements TransactionHistoryStorage {
  private readonly entries = new Map<string, TransactionHistoryEntry>();

  constructor(private readonly mergeFn: MergeEntriesFn) {}

  async getAll(opts?: { signal?: AbortSignal }): Promise<readonly TransactionHistoryEntry[]> {
    if (opts?.signal?.aborted) throw abortErrorLike(opts.signal);
    return [...this.entries.values()];
  }

  async get(hash: string, opts?: { signal?: AbortSignal }): Promise<TransactionHistoryEntry | undefined> {
    if (opts?.signal?.aborted) throw abortErrorLike(opts.signal);
    return this.entries.get(hash);
  }

  async serialize(opts?: { signal?: AbortSignal }): Promise<string> {
    if (opts?.signal?.aborted) throw abortErrorLike(opts.signal);
    return JSON.stringify(
      [...this.entries.values()],
      (_key, value) => typeof value === "bigint" ? { __bigint: value.toString() } : value,
    );
  }

  async gotPending(
    entry: Omit<TransactionHistoryEntry, "lifecycle">, opts?: { signal?: AbortSignal },
  ): Promise<void> {
    return this.write({ ...entry, lifecycle: { status: "pending" } }, opts);
  }

  async gotFinalized(
    entry: Omit<TransactionHistoryEntry, "lifecycle">, opts?: { signal?: AbortSignal },
  ): Promise<void> {
    return this.write({ ...entry, lifecycle: { status: "finalized" } }, opts);
  }

  async gotRejected(
    entry: Omit<TransactionHistoryEntry, "lifecycle">, opts?: { signal?: AbortSignal },
  ): Promise<void> {
    return this.write({ ...entry, lifecycle: { status: "rejected" } }, opts);
  }

  private async write(entry: TransactionHistoryEntry, opts?: { signal?: AbortSignal }): Promise<void> {
    if (opts?.signal?.aborted) throw abortErrorLike(opts.signal);

    const parsed = TransactionHistoryEntrySchema.safeParse(entry);
    if (!parsed.success) {
      throw ValidationError.fromZod(
        `InMemoryTransactionHistoryStorage.got${capitalize(entry.lifecycle.status)}`, parsed.error,
      );
    }
    const incoming = parsed.data;

    const existing = this.entries.get(incoming.hash);
    // F1 fix (mirrors PgTransactionHistoryStorage.writeRows): never call the injected merge
    // function with existing===undefined -- a first write for a hash is persisted verbatim.
    let merged: TransactionHistoryEntry;
    if (existing === undefined) {
      merged = incoming;
    } else {
      merged = this.mergeFn(existing, incoming);
      if (merged.hash !== incoming.hash) {
        throw new ValidationError(
          "InMemoryTransactionHistoryStorage: merge function must not change the entry's hash",
          [{ path: "hash", message: `merge result hash "${merged.hash}" does not match incoming "${incoming.hash}"` }],
        );
      }
    }
    this.entries.set(merged.hash, merged);

    if (
      (merged.lifecycle.status === "finalized" || merged.lifecycle.status === "rejected")
      && merged.identifiers.length > 0
    ) {
      this.clearPendingByIdentifiers(merged.hash, merged.identifiers);
    }
  }

  /** Mirrors the upstream reference's own `#clearPendingByIdentifiers` (recommendation doc §1 /
   *  wallet-SDK reconciliation point 5): any OTHER entry still `pending`, with a non-empty
   *  identifier set that is a SUBSET of the just-merged entry's, is superseded and removed. */
  private clearPendingByIdentifiers(exceptHash: string, identifiers: readonly string[]): void {
    const superseding = new Set(identifiers);
    for (const [hash, e] of this.entries) {
      if (hash === exceptHash) continue;
      if (e.lifecycle.status !== "pending") continue;
      if (e.identifiers.length === 0) continue;
      if (e.identifiers.every((id) => superseding.has(id))) {
        this.entries.delete(hash);
      }
    }
  }
}
