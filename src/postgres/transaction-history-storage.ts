import type { ISql, JSONValue } from "postgres";
import { ValidationError } from "../interfaces/storage-errors.js";
import {
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

/** Tag keys deliberately unusual (`__umbradb_*`) so a real caller's own JSON data is extremely
 *  unlikely to collide with them by accident — a documented convention, not a fully-closed
 *  schema (mirrors this project's other documented-not-enforced conventions, e.g.
 *  `temporal-kv.ts`'s large-integer decimal-string convention). */
const BIGINT_TAG = "__umbradb_ths_bigint";
const DATE_TAG = "__umbradb_ths_date";

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

function isTagObject(v: unknown, tag: string): v is { [k: string]: string } {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    && Object.keys(v).length === 1 && tag in (v as object);
}

function decodeContent(v: JsonEncoded): EntryContent {
  if (Array.isArray(v)) return v.map(decodeContent);
  if (v !== null && typeof v === "object") {
    if (isTagObject(v, BIGINT_TAG)) return BigInt(v[BIGINT_TAG]!);
    if (isTagObject(v, DATE_TAG)) return new Date(v[DATE_TAG]!);
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

/** Reconstructs a {@link TransactionHistoryEntry} from a stored row, decoding `sections` (and the
 *  field-specific `timestamp`/`fees` encodings) back to real `Date`/`bigint` values, then
 *  re-validates the result against {@link TransactionHistoryEntrySchema} -- the same
 *  "validate-on-read" defense-in-depth `PgTemporalKV.toEntry` uses, in case of out-of-band
 *  corruption of the stored JSONB. `identifiers`/`lifecycle.status` are read from their own
 *  denormalized columns (always written in the same statement as `entry`, so never out of sync
 *  with it) rather than re-parsed out of the JSONB, matching `design.md` §1's own reasoning for
 *  why those columns exist. */
function rowToEntry(row: TxHistoryRow): TransactionHistoryEntry {
  const stored = row.entry;
  const candidate = {
    hash: row.tx_hash,
    identifiers: row.identifiers,
    ...(stored.protocolVersion !== undefined ? { protocolVersion: stored.protocolVersion } : {}),
    ...(stored.status !== undefined ? { status: stored.status } : {}),
    ...(stored.timestamp !== undefined ? { timestamp: new Date(stored.timestamp) } : {}),
    ...(stored.fees !== undefined ? { fees: stored.fees === null ? null : BigInt(stored.fees) } : {}),
    lifecycle: stored.lifecycle,
    sections: decodeSections(stored.sections),
  };
  const parsed = TransactionHistoryEntrySchema.safeParse(candidate);
  if (!parsed.success) throw ValidationError.fromZod("PgTransactionHistoryStorage row", parsed.error);
  return parsed.data;
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
 * parameter (`design.md` §2/§4) — this instance never imports `@midnightntwrk/wallet-sdk` (or
 * any wallet-SDK package) at runtime; the merge function passed here is expected to be the real
 * SDK's `mergeWalletEntries` in production, but this class has no compile-time or run-time
 * dependency on that symbol.
 *
 * The `schema` constructor parameter defaults to `sql.umbradbSchema`, matching every other
 * adapter's own established pattern (`PgTemporalKV`, `PgWatermarks`).
 */
export class PgTransactionHistoryStorage implements TransactionHistoryStorage {
  constructor(
    private readonly sql: UmbraDBSql,
    private readonly walletId: string,
    private readonly mergeFn: MergeEntriesFn,
    private readonly schema: string = sql.umbradbSchema,
  ) {}

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
      const result = validated.data;

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
