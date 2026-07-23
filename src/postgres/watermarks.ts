import { ValidationError } from "../interfaces/storage-errors.js";
import type { TransactionHandle } from "../interfaces/transaction-lease.js";
import {
  WatermarkValueSchema,
  type Watermarks,
  type WatermarkKey,
  type WatermarkKind,
  type WatermarkValue,
} from "../interfaces/watermarks.js";
import { withAbort } from "./abort.js";
import type { UmbraDBSql } from "./client.js";
import { translatePostgresError } from "./errors.js";
import { resolveTransaction } from "./transaction-lease.js";

interface WatermarkRow {
  value: WatermarkValue;
}

/**
 * Postgres implementation of `Watermarks` (`src/interfaces/watermarks.ts`) against the
 * `watermarks` schema in `migrations/003_watermarks.ts`
 * (`openspec/changes/sprint-4-watermarks/design.md` §1/§9). Does not run migrations itself —
 * call `runMigrations` (`migrate.ts`) before constructing this against a fresh database.
 *
 * `set`/`get` accept a caller-supplied `TransactionHandle` directly — the same composition
 * pattern `PgTemporalKV.put`/`get` and (as of the durable-composition change) `CheckpointStore.save`
 * use; `CheckpointStore.prune` still composes `withTransaction` internally and accepts no `tx`
 * option (`design.md` §6):
 * `PgWatermarks` needs no `PgTransactionLeaseLayer` reference of its own, since it never opens a
 * transaction internally.
 *
 * The `schema` constructor parameter defaults to `sql.umbradbSchema`, matching `PgTemporalKV`'s
 * own established pattern — not an independent literal default.
 */
export class PgWatermarks implements Watermarks {
  constructor(
    private readonly sql: UmbraDBSql,
    private readonly schema: string = sql.umbradbSchema,
  ) {}

  async set<T extends WatermarkValue>(
    kind: WatermarkKind, key: WatermarkKey, value: T,
    opts?: { tx?: TransactionHandle; signal?: AbortSignal },
  ): Promise<void> {
    const sql = opts?.tx !== undefined ? resolveTransaction(opts.tx) : this.sql;

    // Top-level null guard (design.md §2) -- an application-level check, NOT a
    // WatermarkValueSchema change. WatermarkValueSchema = JsonValueSchema (z.json()) structurally
    // admits a top-level JSON null, but postgres.js's Bind() writes the wire-protocol NULL marker
    // for ANY parameter whose value is exactly null, regardless of its declared type -- against
    // this table's `value jsonb NOT NULL` column that would raise SQLSTATE 23502, mistranslated
    // to a generic UnrecognizedPostgresError instead of a clean boundary rejection. Checked
    // before the schema parse deliberately doesn't need to special-case it either.
    if (value === null) {
      throw new ValidationError(
        "PgWatermarks.set value must not be a top-level null",
        [{ path: "value", message: "top-level null is not representable in the value jsonb NOT NULL column" }],
      );
    }

    const parsed = WatermarkValueSchema.safeParse(value);
    if (!parsed.success) throw ValidationError.fromZod("PgWatermarks.set value", parsed.error);

    return withAbort(() => this.setImpl(sql, kind, key, parsed.data), opts?.signal);
  }

  private async setImpl(
    sql: ReturnType<typeof resolveTransaction> | UmbraDBSql,
    kind: WatermarkKind, key: WatermarkKey, value: WatermarkValue,
  ): Promise<void> {
    try {
      // Non-object JSON roots (a bare string/number/boolean WatermarkValue) must be passed
      // through sql.json(), not interpolated directly -- postgres.js's own type inference cannot
      // determine the intended cast for a bare scalar parameter against a jsonb column
      // (porsager/postgres#386). Already this project's established pattern (temporal-kv.ts's
      // putImpl), reused here unchanged.
      await sql`
        INSERT INTO ${sql(this.schema)}.watermarks (kind, key, value, updated_at)
        VALUES (${kind}, ${key}, ${sql.json(value)}, now())
        ON CONFLICT (kind, key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = now()
      `;
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  async get<T extends WatermarkValue = WatermarkValue>(
    kind: WatermarkKind, key: WatermarkKey,
    opts?: { tx?: TransactionHandle; signal?: AbortSignal },
  ): Promise<T | undefined> {
    const sql = opts?.tx !== undefined ? resolveTransaction(opts.tx) : this.sql;
    return withAbort(() => this.getImpl<T>(sql, kind, key), opts?.signal);
  }

  private async getImpl<T extends WatermarkValue>(
    sql: ReturnType<typeof resolveTransaction> | UmbraDBSql,
    kind: WatermarkKind, key: WatermarkKey,
  ): Promise<T | undefined> {
    try {
      // No read-side validation against WatermarkValueSchema, unlike PgTemporalKV.get (which
      // validates every row via toEntry/VersionedEntrySchema): the row's value is returned
      // exactly as the driver parsed it. Validation runs once, at the set() boundary, and
      // nowhere on this read path (design.md §3).
      const rows = await sql<WatermarkRow[]>`
        SELECT value FROM ${sql(this.schema)}.watermarks WHERE kind = ${kind} AND key = ${key}
      `;
      // Zero rows -> undefined, never a thrown error (the interface's own doc: "never throws for
      // a missing cursor") -- this is the one method in the whole storage layer where absence
      // needs no further distinction (no retention window, no reachability concern).
      return rows.length === 0 ? undefined : (rows[0]!.value as T);
    } catch (err) {
      throw translatePostgresError(err);
    }
  }
}
