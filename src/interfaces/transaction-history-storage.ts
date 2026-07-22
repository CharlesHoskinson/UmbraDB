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

/**
 * Reserved key-prefix for `PgTransactionHistoryStorage`'s own internal bigint/Date JSONB tagging
 * scheme (`src/postgres/transaction-history-storage.ts`'s `encodeContent`/`decodeContent`, which
 * tags encoded values as single-key objects `{[THS_RESERVED_KEY_PREFIX + "bigint"]: "<decimal>"}`
 * / `{[THS_RESERVED_KEY_PREFIX + "date"]: "<iso>"}`). **Found by a cross-vendor audit (BLOCK
 * finding): this namespace was previously only a documented convention, not enforced** — a
 * caller's own `sections`/content data could contain a same-shaped key by coincidence (or by a
 * hostile/buggy peer), which decode would then silently misinterpret as a tagged bigint/Date
 * (wrong data, no error) or crash on a raw, untranslated `SyntaxError`/`RangeError` (permanently
 * un-readable row). Fix: reserve this prefix at the Zod boundary below (`EntryContentSchema`'s
 * object-key check) — an object key starting with it, at ANY nesting depth within `EntryContent`
 * or as a `sections` top-level key, is rejected with `ValidationError` before it can ever reach
 * storage, making the collision structurally impossible from a caller rather than merely unlikely.
 */
export const THS_RESERVED_KEY_PREFIX = "__umbradb_ths_";

/** Object-key schema shared by every `Record`-shaped position in {@link EntryContent}/`sections`
 *  (the recursive content record, and `sections`' own top-level key set). Rejects two distinct
 *  things a caller-supplied key must never be: (1) PostgreSQL-unsafe text — a NUL byte or an
 *  unpaired UTF-16 surrogate, which JSONB cannot store at all (mirrors `temporal-kv.ts`'s
 *  existing recursive NUL/surrogate check, extended here to KEYS, not just string leaves —
 *  the Codex MEDIUM finding paired with the BLOCK above); (2) anything starting with {@link
 *  THS_RESERVED_KEY_PREFIX}, this storage layer's own private tagging namespace. */
const SafeObjectKeySchema = z.string()
  .refine((k) => !hasPostgresUnsafeText(k), {
    message: `object key ${POSTGRES_SAFE_TEXT_MESSAGE}`,
  })
  .refine((k) => !k.startsWith(THS_RESERVED_KEY_PREFIX), {
    message: `object key must not start with the reserved prefix "${THS_RESERVED_KEY_PREFIX}" (reserved for PgTransactionHistoryStorage's own internal bigint/Date tagging scheme)`,
  });

/** This rejection is intentional, not a bug: `THS_RESERVED_KEY_PREFIX` ("__umbradb_ths_") is a
 *  namespace reserved for `PgTransactionHistoryStorage`'s own internal bigint/Date JSONB tagging
 *  scheme (see that constant's own doc). A caller key such as `__umbradb_ths_metadata` -- even
 *  one with no relation whatsoever to the actual `bigint`/`date` tags -- is rejected purely for
 *  starting with the reserved prefix, at ANY nesting depth in `EntryContent` and as a top-level
 *  `sections` key alike. This is deliberately broader than "reject only the two exact tag key
 *  strings" so the namespace stays reserved for this storage layer's future use too, not just its
 *  current one. */

/** A recursive, JSON-shaped value that ALSO admits `bigint`/`Date` leaves anywhere in the tree —
 *  the opaque per-caller payload each wallet section (shielded/unshielded/dust) carries. Callers
 *  agree on shape per section name; `PgTransactionHistoryStorage` never inspects it beyond
 *  validating this shape and (de)serializing it losslessly through Postgres JSONB (`design.md`
 *  §2 — the section-merge logic itself lives entirely in the caller-supplied {@link
 *  MergeEntriesFn}, never in this storage layer). **Object keys anywhere in this tree must not
 *  start with {@link THS_RESERVED_KEY_PREFIX}** — that namespace is reserved for this storage
 *  layer's own internal bigint/Date JSONB tagging scheme; a caller's key colliding with it is
 *  rejected by {@link EntryContentSchema} with `ValidationError`, not silently accepted. */
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
  z.record(SafeObjectKeySchema, EntryContentSchema),
]));

// ---------------------------------------------------------------------------
// Depth-bounding `sections` before Zod's own recursive (`z.lazy`) parse ever begins descending
// into it — found necessary by a cross-vendor re-audit: Zod's recursive descent through nested
// arrays/records adds JS call-stack frames per level with no depth limit of its own, so a
// caller-supplied object nested ~1000 levels deep reliably exhausts the stack and throws a raw,
// untranslated `RangeError: Maximum call stack size exceeded` out of any `got*` method instead of
// a clean `ValidationError`.
// ---------------------------------------------------------------------------

/** Maximum nesting depth `sections` may contain before being rejected with a clean
 *  `ValidationError`. Chosen well above any realistic wallet section's actual nesting (a handful
 *  of levels at most, per {@link EntryContent}'s own doc) and far below where Zod's recursive
 *  descent risks the stack (empirically confirmed to survive several thousand levels in a bare
 *  script, and considerably fewer once real call-stack usage from the rest of the application is
 *  already on the stack) — a caller genuinely needing deeper nesting than this is almost
 *  certainly sending malformed/hostile data, not a legitimate wallet section. */
export const MAX_ENTRY_CONTENT_DEPTH = 64;

/** Iterative (NOT recursive) depth walk over a raw, not-yet-validated JS value — deliberately
 *  implemented with an explicit stack rather than recursive function calls, so the guard itself
 *  cannot exhibit the exact stack-overflow failure mode it exists to prevent. Returns `true` as
 *  soon as any branch's nesting exceeds `maxDepth`, short-circuiting before visiting the rest of
 *  the tree. */
function exceedsMaxDepth(value: unknown, maxDepth: number): boolean {
  const stack: Array<{ v: unknown; depth: number }> = [{ v: value, depth: 0 }];
  while (stack.length > 0) {
    const { v, depth } = stack.pop()!;
    if (depth > maxDepth) return true;
    if (Array.isArray(v)) {
      for (const item of v) stack.push({ v: item, depth: depth + 1 });
    } else if (v !== null && typeof v === "object") {
      for (const val of Object.values(v)) stack.push({ v: val, depth: depth + 1 });
    }
  }
  return false;
}

/** `sections`'s actual schema: the plain `z.record(SafeObjectKeySchema, EntryContentSchema)`
 *  wrapped in a `z.preprocess` depth guard. The depth check MUST run inside `preprocess`'s
 *  callback (which Zod runs BEFORE the wrapped schema parses at all) rather than as a `.refine`/
 *  `.superRefine` added after it — a refinement added after the record schema would only run
 *  once Zod's own recursive parse had already either succeeded or thrown, too late to prevent
 *  the stack overflow it exists to guard against. */
const EntrySectionsSchema = z.preprocess((value, ctx) => {
  if (exceedsMaxDepth(value, MAX_ENTRY_CONTENT_DEPTH)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `sections nesting exceeds the maximum supported depth of ${MAX_ENTRY_CONTENT_DEPTH} levels`,
    });
    return z.NEVER;
  }
  return value;
}, z.record(SafeObjectKeySchema, EntryContentSchema));

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
 * bigint/Date" requirement is about. No key anywhere in `sections` (including its own top-level
 * section names) may start with {@link THS_RESERVED_KEY_PREFIX} — see that constant's doc.
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
  sections: EntrySectionsSchema,
});

/**
 * Merges an EXISTING stored entry with an incoming write into the entry that should end up
 * persisted. Injected at {@link TransactionHistoryStorage} construction time.
 *
 * **This function is called ONLY when a stored entry already exists for the hash — both
 * `existing` and `incoming` are always defined** (F1 fix, cross-vendor audit BLOCK finding). On
 * the FIRST write of a hash (no existing row), the storage layer persists the incoming entry
 * VERBATIM and never calls this function at all — see `PgTransactionHistoryStorage.writeRows`.
 * This matters because the real wallet SDK's `mergeWalletEntries` (`~/repos/midnight-wallet/
 * packages/facade/src/index.ts`) does `[...existing.identifiers]` on its very first line: calling
 * it with `existing===undefined` throws a `TypeError` immediately. **Production therefore never
 * injects the raw SDK `mergeWalletEntries` function** — it injects an UmbraDB-shaped merge
 * function that mirrors that function's documented semantics (identifier union+dedupe,
 * first-writer-wins scalar facts, incoming-wins lifecycle, per-section merge-when-both-present) but
 * operates on UmbraDB's own `TransactionHistoryEntry` shape (a `sections` container) rather than
 * the SDK's `WalletEntry` shape (top-level `shielded`/`unshielded`/`dust`) — the two are distinct
 * types, so the raw SDK function could not be injected here even if the undefined-first-write
 * problem did not exist. This storage layer has no compile-time or run-time dependency on either
 * symbol either way (`design.md` §2).
 *
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
  existing: TransactionHistoryEntry,
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
