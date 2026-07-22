import { z } from "zod";
import { hasPostgresUnsafeText } from "./temporal-kv.js";
import type { TransactionHandle } from "./transaction-lease.js";

/**
 * Transaction History Storage — a Postgres-backed implementation of the Midnight wallet SDK's
 * `TransactionHistoryStorage` interface (`packages/abstractions/src/TransactionHistoryStorage.ts`
 * in `midnight-wallet`), structurally mirrored here (NOT imported — `openspec/changes/
 * sprint-7-transaction-history-storage/design.md` §2: this project never depends on wallet-SDK
 * runtime code). One instance is bound to exactly one `walletId` at construction; none of the six
 * methods below accept a wallet identifier (mirrors the real interface, which has no such
 * parameter either — `TransactionHistoryStorage.ts:163-195`).
 *
 * **Reader/writer split** (mirrors the real SDK's own two-interface shape): {@link
 * TransactionHistoryReader} is covariant in its entry type (`T` appears only in return
 * position — `getAll`/`get`/`serialize`); {@link TransactionHistoryWriter} is contravariant
 * (`T` appears only in parameter position — the three `got*` methods). {@link
 * TransactionHistoryStorage} is the combined surface a real implementation provides.
 *
 * **Lifecycle is a discriminated union, not a bare string.** The real entry's `lifecycle` field
 * is `{status: "pending" | "finalized" | "rejected", ...}` (room for per-status detail, even
 * though this project's own variants carry no extra fields yet) — modeled here as {@link
 * EntryLifecycle}. The Postgres adapter denormalizes just the `status` discriminant into its own
 * `lifecycle text` column (for the identifier-subset pending-clear query and cheap filtering),
 * while the full lifecycle object is preserved inside the `entry jsonb` column.
 *
 * **Write methods take the entry WITHOUT its lifecycle field** — `gotPending`/`gotFinalized`/
 * `gotRejected` each attach their own implied `status` internally before merging/persisting; a
 * caller cannot pass a mismatched lifecycle by construction (there is no field for it to set).
 */

// ---------------------------------------------------------------------------
// Opaque per-section payload (the shielded/unshielded/dust "extension" data), with room for
// bigint/Date-typed leaves — the whole point of the "getAll returns live bigint/Date" requirement.
// ---------------------------------------------------------------------------

const POSTGRES_SAFE_TEXT_MESSAGE = "must not contain a NUL byte or an unpaired UTF-16 surrogate (PostgreSQL cannot store either)";

const SafeStringSchema = z.string().refine((s) => !hasPostgresUnsafeText(s), {
  message: `string ${POSTGRES_SAFE_TEXT_MESSAGE}`,
});

/** A recursive, JSON-shaped value that ALSO admits `bigint`/`Date` leaves anywhere in the tree —
 *  the opaque per-caller payload each wallet section (shielded/unshielded/dust) carries. Callers
 *  agree on shape per section name; `PgTransactionHistoryStorage` never inspects it beyond
 *  validating this shape and (de)serializing it losslessly through Postgres JSONB (`design.md`
 *  §2 — the section-merge logic itself lives entirely in the caller-supplied {@link
 *  MergeEntriesFn}, never in this storage layer). */
export type EntryContent =
  | string | number | boolean | null | bigint | Date
  | EntryContent[]
  | { [key: string]: EntryContent };

export const EntryContentSchema: z.ZodType<EntryContent> = z.lazy(() => z.union([
  SafeStringSchema,
  z.number(),
  z.boolean(),
  z.null(),
  z.bigint(),
  z.date().refine((d) => !Number.isNaN(d.getTime()), { message: "must be a valid Date" }),
  z.array(EntryContentSchema),
  z.record(z.string(), EntryContentSchema),
]));

// ---------------------------------------------------------------------------
// Lifecycle — a discriminated union, not a bare enum (structural mirror of the real SDK).
// ---------------------------------------------------------------------------

export interface PendingLifecycle {
  readonly status: "pending";
}
export interface FinalizedLifecycle {
  readonly status: "finalized";
}
export interface RejectedLifecycle {
  readonly status: "rejected";
}
/** The full per-entry lifecycle. Only `status` is populated by this project's own write paths
 *  today — the union shape (rather than a bare string) exists so a caller/future sprint can add
 *  per-status detail (e.g. a rejection reason) without a breaking change to this type. */
export type EntryLifecycle = PendingLifecycle | FinalizedLifecycle | RejectedLifecycle;
export type EntryLifecycleStatus = EntryLifecycle["status"];

const PendingLifecycleSchema = z.object({ status: z.literal("pending") });
const FinalizedLifecycleSchema = z.object({ status: z.literal("finalized") });
const RejectedLifecycleSchema = z.object({ status: z.literal("rejected") });
export const EntryLifecycleSchema = z.discriminatedUnion("status", [
  PendingLifecycleSchema,
  FinalizedLifecycleSchema,
  RejectedLifecycleSchema,
]);

/** A general on-chain execution outcome, distinct from (and orthogonal to) {@link
 *  EntryLifecycle}'s `status` discriminant: `lifecycle.status` tracks THIS STORE's own
 *  pending/finalized/rejected bookkeeping, while `TransactionHistoryEntry.status` (if present)
 *  reports whatever the ledger itself said about the transaction's execution once known (e.g. a
 *  Compact contract call can partially fail even in an otherwise-finalized transaction). */
export type TransactionHistoryStatus = "success" | "partialSuccess" | "failure";
const TransactionHistoryStatusSchema = z.enum(["success", "partialSuccess", "failure"]);

// ---------------------------------------------------------------------------
// The entry itself
// ---------------------------------------------------------------------------

const HashSchema = z.string().min(1).refine((s) => !hasPostgresUnsafeText(s), {
  message: `hash ${POSTGRES_SAFE_TEXT_MESSAGE}`,
});
const IdentifierSchema = z.string().min(1).refine((s) => !hasPostgresUnsafeText(s), {
  message: `identifier ${POSTGRES_SAFE_TEXT_MESSAGE}`,
});

/**
 * One transaction-history record, keyed by `hash`. Structurally mirrors the real SDK's
 * `TransactionHistoryEntryCommon` (per the wallet-SDK reconciliation pass): `identifiers`,
 * `protocolVersion`, `status`, `timestamp`, and `fees` are the "common" fields every wallet type's
 * entry carries; `sections` is this project's own name for the opaque per-wallet-type
 * "extension" data (shielded/unshielded/dust), passed through unmodified. `timestamp` (a real
 * `Date`) and `fees` (a real `bigint | null`) are exactly the fields the "getAll returns live
 * bigint/Date" requirement is about.
 */
export interface TransactionHistoryEntry {
  readonly hash: string;
  readonly identifiers: readonly string[];
  readonly protocolVersion?: number;
  readonly status?: TransactionHistoryStatus;
  readonly timestamp?: Date;
  readonly fees?: bigint | null;
  readonly lifecycle: EntryLifecycle;
  readonly sections: Readonly<Record<string, EntryContent>>;
}

export const TransactionHistoryEntrySchema = z.object({
  hash: HashSchema,
  identifiers: z.array(IdentifierSchema),
  protocolVersion: z.number().int().nonnegative().optional(),
  status: TransactionHistoryStatusSchema.optional(),
  timestamp: z.date().refine((d) => !Number.isNaN(d.getTime()), { message: "must be a valid Date" }).optional(),
  fees: z.union([z.bigint(), z.null()]).optional(),
  lifecycle: EntryLifecycleSchema,
  sections: z.record(z.string(), EntryContentSchema),
});

/**
 * Merges an existing stored entry (`undefined` if none) with an incoming write into the entry
 * that should end up persisted. Injected at {@link TransactionHistoryStorage} construction time
 * — production code is expected to pass the wallet SDK's own `mergeWalletEntries`, but this
 * storage layer has no compile-time or run-time dependency on that symbol (`design.md` §2).
 * Applied entirely in-process, synchronously, while a row lock is held (`design.md` §3) — the
 * function itself must not perform I/O.
 *
 * Contract (`specs/transaction-history-storage/spec.md`): shared scalar facts are
 * first-writer-wins, `identifiers` are unioned, each `sections` entry is merged independently via
 * its own section-specific rule, and `lifecycle` is incoming-wins. `PgTransactionHistoryStorage`
 * itself implements NONE of this — only the row lock, the persist, and the separate
 * identifier-subset pending-clear step (which reads `merged.identifiers`, computed by this
 * function, but does not itself decide how they were unioned).
 */
export type MergeEntriesFn = (
  existing: TransactionHistoryEntry | undefined,
  incoming: TransactionHistoryEntry,
) => TransactionHistoryEntry;

// ---------------------------------------------------------------------------
// Reader / writer / combined interfaces
// ---------------------------------------------------------------------------

export interface TransactionHistoryReader<out T extends TransactionHistoryEntry = TransactionHistoryEntry> {
  /** Every entry currently stored for this instance's bound `walletId`. */
  getAll(opts?: { tx?: TransactionHandle; signal?: AbortSignal }): Promise<readonly T[]>;

  /** The entry for `hash`, or `undefined` if none has ever been written. Never throws for a
   *  missing hash (mirrors `Watermarks.get`'s "absence is not an error" convention). */
  get(hash: string, opts?: { tx?: TransactionHandle; signal?: AbortSignal }): Promise<T | undefined>;

  /** A full dump of every stored entry as a single string — the interface's fixed
   *  `Promise<string>` contract (no streaming/export-only variant is offered, matching the real
   *  SDK interface). */
  serialize(opts?: { tx?: TransactionHandle; signal?: AbortSignal }): Promise<string>;
}

export interface TransactionHistoryWriter<in T extends TransactionHistoryEntry = TransactionHistoryEntry> {
  /**
   * Records a pending observation of a transaction. The storage attaches `lifecycle: {status:
   * "pending"}` itself — `entry` carries no lifecycle field to set one.
   * @throws {ValidationError} if `entry` fails its boundary schema.
   * @throws {ConnectionError} on driver-level failure.
   */
  gotPending(entry: Omit<T, "lifecycle">, opts?: { tx?: TransactionHandle; signal?: AbortSignal }): Promise<void>;

  /** As {@link gotPending}, attaching `lifecycle: {status: "finalized"}`. May also clear other
   *  still-pending entries whose identifiers are a (non-empty) subset of this entry's merged
   *  identifiers (`specs/transaction-history-storage/spec.md`'s identifier-subset pending-clear
   *  rule). */
  gotFinalized(entry: Omit<T, "lifecycle">, opts?: { tx?: TransactionHandle; signal?: AbortSignal }): Promise<void>;

  /** As {@link gotFinalized}, attaching `lifecycle: {status: "rejected"}` — rejection clears
   *  pending entries under the same identifier-subset rule as finalization. */
  gotRejected(entry: Omit<T, "lifecycle">, opts?: { tx?: TransactionHandle; signal?: AbortSignal }): Promise<void>;
}

export interface TransactionHistoryStorage<T extends TransactionHistoryEntry = TransactionHistoryEntry>
  extends TransactionHistoryReader<T>, TransactionHistoryWriter<T> {}
