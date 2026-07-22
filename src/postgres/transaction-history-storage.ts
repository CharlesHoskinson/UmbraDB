import type { ISql, JSONValue } from "postgres";
import { SerializationFailedError, StorageError, ValidationError } from "../interfaces/storage-errors.js";
import {
  THS_RESERVED_KEY_PREFIX,
  TransactionHistoryEntrySchema,
  type EntryContent,
  type EntryLifecycle,
  type MergeEntriesFn,
  type TransactionHistoryEntry,
  type TransactionHistoryStorage,
} from "../interfaces/transaction-history-storage.js";
import { hasPostgresUnsafeText } from "../interfaces/temporal-kv.js";
import type { TransactionHandle } from "../interfaces/transaction-lease.js";
import { withAbort } from "./abort.js";
import type { UmbraDBSql } from "./client.js";
import { translatePostgresError } from "./errors.js";
import { resolveTransaction } from "./transaction-lease.js";

/** Advisory-lock class `4` ("transaction-history merge lock"), distinct from the migration
 *  runner's class `1`, the writer-lease layer's class `2`
 *  (`src/postgres/transaction-lease.ts`), and the Sprint 1 `CREATE EXTENSION` serialization's
 *  class `3` (`src/postgres/migrations/001_temporal_kv.ts`). See {@link writeRows}'s own doc for
 *  why this lock exists in addition to the `SELECT ... FOR UPDATE` `design.md` §3 documents. */
const TX_HISTORY_ADVISORY_LOCK_CLASS = 4;

// ---------------------------------------------------------------------------
// bigint/Date-safe JSONB encoding for the opaque `sections` payload
// ---------------------------------------------------------------------------

/** Tag keys built from the SAME reserved prefix {@link THS_RESERVED_KEY_PREFIX} the boundary
 *  schema (`src/interfaces/transaction-history-storage.ts`) rejects any caller key under — one
 *  literal source of truth, not two independently-typed strings that could drift apart. **Fixed
 *  after a cross-vendor audit found this namespace was previously only a documented convention,
 *  never actually enforced**: decode below treats ANY single-key object with one of these tags as
 *  a tagged value, so a caller's own `sections`/content data literally containing such a key used
 *  to be silently mis-decoded (a plain object read back as a `bigint`/`Date`) or, for a
 *  non-numeric tagged value, crash with a raw, untranslated `SyntaxError`/`RangeError` — the row
 *  became permanently unreadable. The boundary schema now makes this namespace private to this
 *  storage layer at write time, so the collision can no longer originate from a caller; the
 *  defensive decode below (see {@link isTagObject}, {@link parseStoredBigint}, {@link
 *  parseStoredDate}) remains as belt-and-suspenders for stored data corrupted by other means
 *  (direct DB tampering, a future migration bug). */
const BIGINT_TAG = `${THS_RESERVED_KEY_PREFIX}bigint`;
const DATE_TAG = `${THS_RESERVED_KEY_PREFIX}date`;

type JsonEncoded = string | number | boolean | null | JsonEncoded[] | { [key: string]: JsonEncoded };

function encodeContent(v: EntryContent): JsonEncoded {
  if (typeof v === "bigint") return { [BIGINT_TAG]: v.toString() };
  if (v instanceof Date) return { [DATE_TAG]: v.toISOString() };
  if (Array.isArray(v)) return v.map(encodeContent);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, encodeContent(val)]));
  }
  return v;
}

/** Requires the tagged value itself be a `string` (not just that the single key matches) before
 *  treating an object as a tag — found necessary by the same audit: without this, a stored
 *  `{[BIGINT_TAG]: {}}` (an object, not a string) would still be classified as a tag object and
 *  reach `BigInt()`/`new Date()` with a non-string argument, a distinct crash this narrower guard
 *  rules out one step earlier. */
function isTagObject(v: unknown, tag: string): v is { [k: string]: string } {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    && Object.keys(v).length === 1 && tag in (v as object)
    && typeof (v as Record<string, unknown>)[tag] === "string";
}

/** Canonical form of `BigInt.prototype.toString()`'s output -- what {@link encodeContent}/{@link
 *  encodeStoredEntry} ALWAYS emit for a bigint value: an optional leading `-`, then either a bare
 *  `0` or a nonzero digit followed by more digits (no leading zeros, no `+`, no `0x`/`0b`/`0o`
 *  prefix, no whitespace, never empty). **Found by a cross-vendor re-audit of the F1 fix**:
 *  `BigInt(...)` itself is far more permissive than its own `toString()` output --
 *  `BigInt("") === 0n`, `BigInt("0x10") === 16n`, `BigInt(" 5 ") === 5n` -- so accepting anything
 *  `BigInt(...)` merely tolerates (rather than requiring an exact match against this canonical
 *  form) let a tampered/legacy/collided stored value silently decode to a DIFFERENT,
 *  wrong-but-valid bigint instead of being rejected. {@link parseStoredBigint} requires an EXACT
 *  match against this regex before ever calling `BigInt(...)`. */
const CANONICAL_BIGINT_RE = /^-?(0|[1-9]\d*)$/;

/** Validates a stored bigint tag/field value STRICTLY against {@link CANONICAL_BIGINT_RE} --
 *  used both by the tag-decode below and by {@link rowToEntry}'s own field-specific `fees`
 *  decode, so corrupted stored data (from any source, including a value of the wrong JSON type
 *  entirely) is translated to `SerializationFailedError` rather than either escaping any of the
 *  six public methods as a raw, untranslated error OR silently normalizing to a different,
 *  wrong-but-valid bigint. */
function parseStoredBigint(raw: unknown, context: string): bigint {
  if (typeof raw !== "string" || !CANONICAL_BIGINT_RE.test(raw)) {
    throw new SerializationFailedError(
      `PgTransactionHistoryStorage: ${context} is not a canonical bigint literal (expected the `
      + `encoder's own decimal-string form, e.g. "-?\\d+" with no leading zeros/"0x"/whitespace/`
      + `empty string): ${JSON.stringify(raw)}`,
    );
  }
  try {
    return BigInt(raw);
  } catch (err) {
    // Unreachable given the regex above already guarantees a valid decimal-integer literal --
    // kept as belt-and-suspenders so a future change to the regex (or to this function's own
    // calling convention) still cannot let a raw SyntaxError escape.
    throw new SerializationFailedError(
      `PgTransactionHistoryStorage: ${context} is not a valid bigint literal: ${JSON.stringify(raw)}`, err,
    );
  }
}

/** As {@link parseStoredBigint}, for the `Date` tag/field. Requires BOTH a valid calendar date
 *  (`new Date(...)` never THROWS on a malformed string -- it silently produces an `Invalid Date`,
 *  so `getTime()` itself must be checked) AND an EXACT round-trip through `toISOString()` -- the
 *  same canonical form {@link encodeContent}/{@link encodeStoredEntry} always emit. **Found by
 *  the same re-audit**: native `Date` parsing is far more permissive than `toISOString()`'s own
 *  output -- it accepts partial dates and non-UTC offsets, and SILENTLY NORMALIZES an invalid
 *  calendar date (e.g. `"2024-02-30"`) to a different, valid one instead of rejecting it -- so
 *  requiring the exact round-trip is what actually rejects a tampered/legacy/collided stored
 *  value instead of accepting it as a different, wrong-but-valid `Date`. */
function parseStoredDate(raw: unknown, context: string): Date {
  if (typeof raw !== "string") {
    throw new SerializationFailedError(
      `PgTransactionHistoryStorage: ${context} is not a string (found ${raw === null ? "null" : typeof raw}): ${JSON.stringify(raw)}`,
    );
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new SerializationFailedError(`PgTransactionHistoryStorage: ${context} is not a valid ISO date string: ${JSON.stringify(raw)}`);
  }
  if (d.toISOString() !== raw) {
    throw new SerializationFailedError(
      `PgTransactionHistoryStorage: ${context} is not in the canonical ISO-8601 form `
      + `Date.prototype.toISOString() produces -- it parses but does not round-trip exactly `
      + `(e.g. a non-canonical calendar date, a non-UTC offset, or missing/imprecise `
      + `milliseconds): ${JSON.stringify(raw)}`,
    );
  }
  return d;
}

function decodeContent(v: JsonEncoded): EntryContent {
  if (Array.isArray(v)) return v.map(decodeContent);
  if (v !== null && typeof v === "object") {
    if (isTagObject(v, BIGINT_TAG)) return parseStoredBigint(v[BIGINT_TAG]!, `stored ${BIGINT_TAG} value`);
    if (isTagObject(v, DATE_TAG)) return parseStoredDate(v[DATE_TAG]!, `stored ${DATE_TAG} value`);
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, decodeContent(val as JsonEncoded)]));
  }
  return v;
}

function encodeSections(sections: Readonly<Record<string, EntryContent>>): Record<string, JsonEncoded> {
  return Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, encodeContent(v)]));
}

function decodeSections(sections: Record<string, JsonEncoded>): Record<string, EntryContent> {
  return Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, decodeContent(v)]));
}

/** The shape actually stored in the `entry jsonb` column -- a full snapshot of the logical entry
 *  (including `identifiers`/`lifecycle`, denormalized ALSO onto their own columns; `design.md`
 *  §1). `timestamp`/`fees` use field-specific encodings (an ISO string; a decimal string tagged
 *  by omission from a bare JSON number, i.e. always textual, never a bare JSON number) rather
 *  than the generic `sections` tagging scheme, since their JS-level type is fixed by {@link
 *  TransactionHistoryEntry} itself, not caller-opaque. */
interface StoredEntryJson {
  hash: string;
  identifiers: string[];
  protocolVersion?: number;
  status?: string;
  timestamp?: string;
  fees?: string | null;
  lifecycle: EntryLifecycle;
  sections: Record<string, JsonEncoded>;
}

interface TxHistoryRow {
  tx_hash: string;
  entry: StoredEntryJson;
  identifiers: string[];
  lifecycle: string;
}

function encodeStoredEntry(entry: TransactionHistoryEntry): StoredEntryJson {
  return {
    hash: entry.hash,
    identifiers: [...entry.identifiers],
    ...(entry.protocolVersion !== undefined ? { protocolVersion: entry.protocolVersion } : {}),
    ...(entry.status !== undefined ? { status: entry.status } : {}),
    ...(entry.timestamp !== undefined ? { timestamp: entry.timestamp.toISOString() } : {}),
    ...(entry.fees !== undefined ? { fees: entry.fees === null ? null : entry.fees.toString() } : {}),
    lifecycle: entry.lifecycle,
    sections: encodeSections(entry.sections),
  };
}

/** Structural guard for the raw JSONB payload PostgreSQL handed back for the `entry` column, run
 *  BEFORE any property access on it. The column itself is `jsonb NOT NULL`
 *  (`migrations/004_transaction_history.ts`), but that constraint only forbids a SQL NULL in the
 *  COLUMN -- it does NOT forbid the JSON VALUE stored there from being the JSON literal `null`,
 *  or any other non-object shape (a bare string/number/array), if the row was ever written by
 *  anything other than this module's own `writeRows` (direct DB tampering, a future migration
 *  bug, a legacy schema version). **Every legitimate write can never produce either shape**:
 *  `sections` is a REQUIRED, non-optional field of {@link TransactionHistoryEntrySchema} (never
 *  spread in conditionally, unlike `protocolVersion`/`status`/`timestamp`/`fees`), and `writeRows`
 *  re-validates the merge result against that same schema immediately before persisting it -- so
 *  this guard rejecting a `null`/non-object `entry` or `entry.sections` never fires on the normal
 *  write path; it exists purely as defense-in-depth for stored-data corruption from OUTSIDE this
 *  module's own write path. **Found by a cross-vendor re-audit of the F1 fix**: without it,
 *  `stored.protocolVersion`/`Object.entries(stored.sections)` etc. throw a raw, untranslated
 *  `TypeError` out of every read method instead of a clean `SerializationFailedError`. */
function assertStoredEntryShape(entry: unknown, txHash: string): asserts entry is StoredEntryJson {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new SerializationFailedError(
      `PgTransactionHistoryStorage: stored entry for tx_hash ${JSON.stringify(txHash)} is not a JSON `
      + `object (found ${entry === null ? "null" : Array.isArray(entry) ? "an array" : typeof entry})`,
    );
  }
  const sections = (entry as Record<string, unknown>).sections;
  if (sections === null || sections === undefined || typeof sections !== "object" || Array.isArray(sections)) {
    throw new SerializationFailedError(
      `PgTransactionHistoryStorage: stored entry.sections for tx_hash ${JSON.stringify(txHash)} is not `
      + `a JSON object (found ${
        sections === null ? "null" : sections === undefined ? "undefined" : Array.isArray(sections) ? "an array" : typeof sections
      })`,
    );
  }
}

/** Reconstructs a {@link TransactionHistoryEntry} from a stored row, decoding `sections` (and the
 *  field-specific `timestamp`/`fees` encodings) back to real `Date`/`bigint` values, then
 *  re-validates the result against {@link TransactionHistoryEntrySchema} -- the same
 *  "validate-on-read" defense-in-depth `PgTemporalKV.toEntry` uses, in case of out-of-band
 *  corruption of the stored JSONB. `identifiers`/`lifecycle.status` are read from their own
 *  denormalized columns (always written in the same statement as `entry`, so never out of sync
 *  with it) rather than re-parsed out of the JSONB, matching `design.md` §1's own reasoning for
 *  why those columns exist. */
function decodeRow(row: TxHistoryRow): TransactionHistoryEntry {
  const stored = row.entry;
  assertStoredEntryShape(stored, row.tx_hash);
  const candidate = {
    hash: row.tx_hash,
    identifiers: row.identifiers,
    ...(stored.protocolVersion !== undefined ? { protocolVersion: stored.protocolVersion } : {}),
    ...(stored.status !== undefined ? { status: stored.status } : {}),
    ...(stored.timestamp !== undefined ? { timestamp: parseStoredDate(stored.timestamp, "stored entry.timestamp") } : {}),
    ...(stored.fees !== undefined ? { fees: stored.fees === null ? null : parseStoredBigint(stored.fees, "stored entry.fees") } : {}),
    lifecycle: stored.lifecycle,
    sections: decodeSections(stored.sections),
  };
  const parsed = TransactionHistoryEntrySchema.safeParse(candidate);
  if (!parsed.success) throw ValidationError.fromZod("PgTransactionHistoryStorage row", parsed.error);
  return parsed.data;
}

/** Thin wrapper around {@link decodeRow} that guarantees a {@link StorageError} (never a raw,
 *  untranslated error) escapes for ANY malformed/corrupted stored row -- **found necessary by a
 *  cross-vendor re-audit of the F1 fix**: {@link assertStoredEntryShape} and the strict
 *  {@link parseStoredBigint}/{@link parseStoredDate} decode already convert the specific
 *  corruption shapes they know about into `SerializationFailedError`, but this catch-all is the
 *  actual guarantee -- any OTHER not-yet-anticipated way a stored row could be malformed still
 *  surfaces as a `SerializationFailedError` here rather than a raw `TypeError`/`RangeError`/etc.
 *  escaping `get`/`getAll`/`serialize`/the `got*` merge-read path. An error that is already one of
 *  this project's own `StorageError` subclasses (a `ValidationError` from the final Zod
 *  re-validation, or a `SerializationFailedError` thrown by a helper above) passes through
 *  unchanged -- only a genuinely raw error gets wrapped. */
function rowToEntry(row: TxHistoryRow): TransactionHistoryEntry {
  try {
    return decodeRow(row);
  } catch (err) {
    if (err instanceof StorageError) throw err;
    throw new SerializationFailedError(
      `PgTransactionHistoryStorage: stored row for tx_hash ${JSON.stringify(row.tx_hash)} is corrupted `
      + `and could not be decoded`,
      err,
    );
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Postgres implementation of `TransactionHistoryStorage` (`src/interfaces/
 * transaction-history-storage.ts`) against the `transaction_history` schema in
 * `migrations/004_transaction_history.ts` (`openspec/changes/
 * sprint-7-transaction-history-storage/design.md` §1). Does not run migrations itself — call
 * `runMigrations` (`migrate.ts`) before constructing this against a fresh database.
 *
 * `walletId` and the entry-merge function are BOTH bound at construction, never a method
 * parameter (`design.md` §2/§4) — this instance never imports the Midnight wallet SDK (or any
 * wallet-SDK package) at runtime. Production injects an UmbraDB-shaped merge function that
 * mirrors the real SDK's `mergeWalletEntries` documented semantics — NOT the raw SDK function
 * itself, which operates on a different entry shape (the SDK's `WalletEntry`, not this project's
 * `sections`-container `TransactionHistoryEntry`) and assumes both operands are always defined
 * (see {@link MergeEntriesFn}'s own doc, F1 finding). This class has no compile-time or run-time
 * dependency on either symbol.
 *
 * The `schema` constructor parameter defaults to `sql.umbradbSchema`, matching every other
 * adapter's own established pattern (`PgTemporalKV`, `PgWatermarks`).
 *
 * **`walletId` is checked at construction, not just typed as `string`.** Every query keys off
 * `this.walletId`, including the advisory-lock hash key ({@link writeRows}'s
 * `pg_advisory_xact_lock`) — a `null`/`undefined`/empty value slipping through (e.g. a caller
 * bypassing TypeScript, or an accidentally-empty config value) would silently produce a
 * degenerate lock key and a degenerate `WHERE wallet_id = ...` filter instead of failing loudly,
 * voiding the concurrency guarantee {@link writeRows}'s own doc describes. Found by the audit
 * panel (F6): fail fast in the constructor instead.
 */
export class PgTransactionHistoryStorage implements TransactionHistoryStorage {
  constructor(
    private readonly sql: UmbraDBSql,
    private readonly walletId: string,
    private readonly mergeFn: MergeEntriesFn,
    private readonly schema: string = sql.umbradbSchema,
  ) {
    if (typeof walletId !== "string" || walletId.length === 0) {
      throw new ValidationError(
        "PgTransactionHistoryStorage: walletId must be a non-empty string",
        [{ path: "walletId", message: "missing/empty walletId would silently produce a NULL advisory-lock key and void the concurrency lock" }],
      );
    }
  }

  async getAll(opts?: { tx?: TransactionHandle; signal?: AbortSignal }): Promise<readonly TransactionHistoryEntry[]> {
    const sql = opts?.tx !== undefined ? resolveTransaction(opts.tx) : this.sql;
    return withAbort(() => this.getAllImpl(sql), opts?.signal);
  }

  private async getAllImpl(sql: ISql<{ bigint: bigint }>): Promise<TransactionHistoryEntry[]> {
    try {
      const rows = await sql<TxHistoryRow[]>`
        SELECT tx_hash, entry, identifiers, lifecycle
        FROM ${sql(this.schema)}.transaction_history
        WHERE wallet_id = ${this.walletId}
        ORDER BY tx_hash
      `;
      return rows.map(rowToEntry);
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  async get(
    hash: string, opts?: { tx?: TransactionHandle; signal?: AbortSignal },
  ): Promise<TransactionHistoryEntry | undefined> {
    const sql = opts?.tx !== undefined ? resolveTransaction(opts.tx) : this.sql;
    if (hasPostgresUnsafeText(hash)) {
      throw new ValidationError(
        "PgTransactionHistoryStorage.get hash must not contain a NUL byte or an unpaired UTF-16 surrogate",
        [{ path: "hash", message: "PostgreSQL cannot store either" }],
      );
    }
    return withAbort(() => this.getImpl(sql, hash), opts?.signal);
  }

  private async getImpl(
    sql: ISql<{ bigint: bigint }>, hash: string,
  ): Promise<TransactionHistoryEntry | undefined> {
    try {
      const rows = await sql<TxHistoryRow[]>`
        SELECT tx_hash, entry, identifiers, lifecycle
        FROM ${sql(this.schema)}.transaction_history
        WHERE wallet_id = ${this.walletId} AND tx_hash = ${hash}
      `;
      return rows.length > 0 ? rowToEntry(rows[0]!) : undefined;
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  /** A full dump of `getAll()`'s output, JSON.stringify'd after applying the same
   *  bigint/Date-safe tagging {@link encodeStoredEntry} uses for JSONB storage -- so `serialize()`
   *  output round-trips through `JSON.parse` + this module's own decode helpers back to data
   *  equivalent to what `getAll()` returned at that same point (`specs/
   *  transaction-history-storage/spec.md`'s serialize-round-trip scenario). Implemented as
   *  `getAll()` + `JSON.stringify`, not a stored representation (`design.md` §1). */
  async serialize(opts?: { tx?: TransactionHandle; signal?: AbortSignal }): Promise<string> {
    const all = await this.getAll(opts);
    return JSON.stringify(all.map(encodeStoredEntry));
  }

  async gotPending(
    entry: Omit<TransactionHistoryEntry, "lifecycle">, opts?: { tx?: TransactionHandle; signal?: AbortSignal },
  ): Promise<void> {
    return this.write({ ...entry, lifecycle: { status: "pending" } }, opts);
  }

  async gotFinalized(
    entry: Omit<TransactionHistoryEntry, "lifecycle">, opts?: { tx?: TransactionHandle; signal?: AbortSignal },
  ): Promise<void> {
    return this.write({ ...entry, lifecycle: { status: "finalized" } }, opts);
  }

  async gotRejected(
    entry: Omit<TransactionHistoryEntry, "lifecycle">, opts?: { tx?: TransactionHandle; signal?: AbortSignal },
  ): Promise<void> {
    return this.write({ ...entry, lifecycle: { status: "rejected" } }, opts);
  }

  private async write(
    entry: TransactionHistoryEntry, opts?: { tx?: TransactionHandle; signal?: AbortSignal },
  ): Promise<void> {
    const sql = opts?.tx !== undefined ? resolveTransaction(opts.tx) : undefined;

    const parsed = TransactionHistoryEntrySchema.safeParse(entry);
    if (!parsed.success) {
      throw ValidationError.fromZod(
        `PgTransactionHistoryStorage.got${capitalize(entry.lifecycle.status)}`, parsed.error,
      );
    }

    // A caller-supplied `opts.tx` is already inside a live transaction -- run the row-lock/merge
    // directly against it (nesting a SECOND transaction via `sql.begin()` is not supported by
    // this project's transaction layer, `transaction-lease.ts`'s own "not reentrant" doc). With no
    // `opts.tx`, this method owns the atomicity requirement itself and must open its own
    // transaction (`writeOwnTransaction`) -- unlike `PgWatermarks`/`PgTemporalKV`'s single-statement
    // writes, a multi-statement lock+merge+upsert(+conditional clear) sequence has no atomic
    // single-SQL-statement equivalent.
    if (sql !== undefined) {
      return withAbort(() => this.writeRows(sql, parsed.data), opts?.signal);
    }
    return withAbort(() => this.writeOwnTransaction(parsed.data), opts?.signal);
  }

  private async writeOwnTransaction(entry: TransactionHistoryEntry): Promise<void> {
    try {
      await this.sql.begin(async (tx) => {
        await this.writeRows(tx, entry);
      });
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  /**
   * The row-lock atomic-merge write path (`design.md` §3). Runs inside a transaction (either the
   * caller's own, via `opts.tx`, or one this method opened itself) and does exactly three things,
   * per this module's own division of responsibility with the caller-supplied {@link
   * MergeEntriesFn} (`design.md` §2): **lock**, **persist the merge result**, and **clear
   * superseded pending entries** — the section-merge/identifier-union/lifecycle-resolution logic
   * itself lives entirely in `this.mergeFn`, never here.
   *
   * **Beyond what `design.md` §3's pseudocode literally shows**: a bare `SELECT ... FOR UPDATE`
   * cannot lock a row that does not exist yet, so two concurrent FIRST-EVER writes to the same
   * `(walletId, hash)` would both read "no existing row," both compute their own merge from
   * `undefined`, and then race an `INSERT ... ON CONFLICT DO UPDATE` whose application-level merge
   * decision was made without seeing each other's data — precisely the "silently loses a section"
   * failure mode `design.md` §3 warns a bare upsert exhibits, just relocated to the phantom-row
   * case instead of the already-exists case. A `pg_advisory_xact_lock` keyed on `(walletId, hash)`
   * — acquired BEFORE the `SELECT`, released automatically at this transaction's commit/rollback —
   * closes that gap by serializing every writer for a given hash regardless of whether a row
   * already exists, mirroring this project's own established use of `pg_advisory_xact_lock` for
   * an identical class of problem (`migrations/001_temporal_kv.ts`'s `CREATE EXTENSION` race fix).
   * The `SELECT ... FOR UPDATE` is kept in addition, matching `design.md` §3's own text, as
   * defense-in-depth for any future code path that might touch this table without going through
   * this method.
   */
  private async writeRows(sql: ISql<{ bigint: bigint }>, entry: TransactionHistoryEntry): Promise<void> {
    try {
      await sql`
        SELECT pg_advisory_xact_lock(${TX_HISTORY_ADVISORY_LOCK_CLASS}, hashtext(${this.walletId} || ':' || ${entry.hash}))
      `;

      const existingRows = await sql<TxHistoryRow[]>`
        SELECT tx_hash, entry, identifiers, lifecycle
        FROM ${sql(this.schema)}.transaction_history
        WHERE wallet_id = ${this.walletId} AND tx_hash = ${entry.hash}
        FOR UPDATE
      `;
      const existing = existingRows.length > 0 ? rowToEntry(existingRows[0]!) : undefined;

      // F1 fix (cross-vendor audit BLOCK finding): NEVER call the injected merge function with
      // existing===undefined. The real SDK's mergeWalletEntries (and any production merge
      // mirroring it) assumes both operands are defined and does `[...existing.identifiers]` on
      // its very first line -- it would throw a TypeError immediately if ever invoked here on a
      // first write. `entry` has already passed `TransactionHistoryEntrySchema.safeParse` in
      // `write()`, so persisting it verbatim on a first write is already schema-valid; no need to
      // re-validate an unchanged value.
      let result: TransactionHistoryEntry;
      if (existing === undefined) {
        result = entry;
      } else {
        const merged = this.mergeFn(existing, entry);
        if (merged.hash !== entry.hash) {
          throw new ValidationError(
            "PgTransactionHistoryStorage: merge function must not change the entry's hash",
            [{ path: "hash", message: `merge result hash "${merged.hash}" does not match incoming "${entry.hash}"` }],
          );
        }
        const validated = TransactionHistoryEntrySchema.safeParse(merged);
        if (!validated.success) {
          throw ValidationError.fromZod("PgTransactionHistoryStorage merge function result", validated.error);
        }
        result = validated.data;
      }

      await sql`
        INSERT INTO ${sql(this.schema)}.transaction_history
          (wallet_id, tx_hash, entry, identifiers, lifecycle, updated_at)
        VALUES (
          ${this.walletId}, ${result.hash},
          ${sql.json(encodeStoredEntry(result) as unknown as JSONValue)},
          ${sql.array([...result.identifiers])},
          ${result.lifecycle.status},
          now()
        )
        ON CONFLICT (wallet_id, tx_hash) DO UPDATE
        SET entry = EXCLUDED.entry, identifiers = EXCLUDED.identifiers,
            lifecycle = EXCLUDED.lifecycle, updated_at = now()
      `;

      // Identifier-subset pending-clear (design.md §3 / specs/transaction-history-storage/
      // spec.md): only runs on finalize/reject, and only when BOTH sides' identifier sets are
      // non-empty -- an empty set is vacuously "a subset" of anything, which would otherwise
      // clear every unrelated pending entry the moment any hash finalizes with zero identifiers.
      if (
        (result.lifecycle.status === "finalized" || result.lifecycle.status === "rejected")
        && result.identifiers.length > 0
      ) {
        await sql`
          DELETE FROM ${sql(this.schema)}.transaction_history
          WHERE wallet_id = ${this.walletId} AND tx_hash <> ${result.hash}
            AND lifecycle = 'pending'
            AND array_length(identifiers, 1) > 0
            AND identifiers <@ ${sql.array([...result.identifiers])}
        `;
      }
    } catch (err) {
      throw translatePostgresError(err);
    }
  }
}
